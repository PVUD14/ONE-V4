/**
 * Institution announcements (INST-06): sending a scheduled announcement once, and its email.
 *
 * The API writes an announcement as SCHEDULED together with an outbox event whose
 * `available_at` is the scheduled time; the ADR-028 local dispatcher hands that event here when
 * it is due. Under a consumer receipt and a row lock, a SCHEDULED announcement resolves its
 * recipients from the sender's scope at send time, writes every in-app notification and recipient
 * row in one statement, and becomes SENT. A sent or cancelled one does nothing, so a replay, a
 * second worker or a racing cancel cannot deliver twice or after a cancel. Email leaves after
 * that commit and never undoes the in-app delivery. With no mail sink (HG-7) the email is recorded
 * NOT_CONFIGURED, never faked. Design: docs/architecture/institution-announcements-table-design.md.
 */
import { sql } from 'drizzle-orm';
import {
  canAddressInstitutionAudience,
  institutionAnnouncementScope,
  institutionUnitDescendants,
  type InstitutionStudentScope,
} from '@planthepath/authorization/src/index.js';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { institutionStudentScopeSql, loadInstitutionUnitTree, withTeachingAssignments } from './institution-scope.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import { PermanentMailRejection, type InvitationMailSink } from './invitation-mail.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

export const ANNOUNCEMENT_DISPATCH_REQUESTED = 'institution.announcement.dispatch.requested';
export const ANNOUNCEMENT_DISPATCH_CONSUMER = 'institution-announcement-dispatch';
export const ANNOUNCEMENT_TEMPLATE_ID = '26000000-0000-4000-8000-000000000046';
export const ANNOUNCEMENT_TEMPLATE_KEY = 'institution-announcement';
export const ANNOUNCEMENT_TEMPLATE_VERSION = 1;

/** The roles as the student sees them on an announcement ("From your department"). */
export const announcementSenderLabels: Readonly<Record<string, string>> = {
  INSTITUTION_OWNER: 'your college',
  INSTITUTION_ADMIN: 'your college',
  PLACEMENT_ADMIN: 'your placement office',
  DEPARTMENT_HEAD: 'your department',
  FACULTY_LECTURER: 'your faculty',
};

export type AnnouncementDispatchOutcome = 'SENT' | 'ALREADY_SENT' | 'CANCELLED' | 'SENDER_ACCESS_ENDED' | 'NOT_FOUND';

/** Make sure the versioned email template row exists; the body is rendered by {@link renderAnnouncementEmail}. */
export async function ensureAnnouncementTemplate(tx: PersistenceDb, actorUserId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
    VALUES (${ANNOUNCEMENT_TEMPLATE_ID}::uuid, ${ANNOUNCEMENT_TEMPLATE_KEY}, ${ANNOUNCEMENT_TEMPLATE_VERSION}, 'en-IN',
            'Announcement from {institutionName}: {title}',
            'Rendered by the announcement sender from the announcement title and body; version 1 adds the college name and a footer.',
            ${actorUserId}::uuid, now())
    ON CONFLICT (stable_key, version, locale) DO NOTHING
  `);
}

/** Version 1 of the announcement email. */
export function renderAnnouncementEmail(input: { readonly institutionName: string; readonly title: string; readonly body: string }): { readonly subject: string; readonly textBody: string } {
  return {
    subject: `Announcement from ${input.institutionName}: ${input.title}`.slice(0, 200),
    textBody: [
      input.title,
      input.body,
      `Sent to you by ${input.institutionName} through ONE. You can read it any time in your ONE notifications.`,
    ].join('\n\n'),
  };
}

/** Queue the dispatch of an announcement for its scheduled time, inside the caller's transaction. */
export async function writeAnnouncementDispatchRequested(tx: PersistenceDb, input: {
  readonly eventId: string; readonly announcementId: string; readonly actorUserId: string; readonly institutionId: string; readonly correlationId: string;
}): Promise<void> {
  const payload = { announcementId: input.announcementId };
  validateOutboxWriteInput({ id: input.eventId, aggregateType: 'institution_announcement', aggregateId: input.announcementId,
    eventType: ANNOUNCEMENT_DISPATCH_REQUESTED, eventVersion: 1, payload, actorUserId: input.actorUserId,
    organizationId: input.institutionId, correlationId: input.correlationId });
  // available_at is the announcement's own scheduled_for, read in SQL so both use the database clock.
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id, available_at)
    SELECT ${input.eventId}::uuid, 'institution_announcement', ${input.announcementId}, ${ANNOUNCEMENT_DISPATCH_REQUESTED}, 1,
           ${JSON.stringify(payload)}::jsonb, ${input.actorUserId}::uuid, ${input.institutionId}::uuid, ${input.correlationId}, a.scheduled_for
    FROM institution_announcements a WHERE a.id = ${input.announcementId}::uuid
  `);
}

/**
 * Outbox consumer for ANNOUNCEMENT_DISPATCH_REQUESTED. Sends the announcement at most once; then
 * delivers any email it queued. Not due yet (an early replay) throws, so the outbox retries later
 * rather than recording the event as handled.
 */
export async function dispatchInstitutionAnnouncement(
  db: PersistenceDb,
  event: IntegrationEventEnvelope,
  deps: { readonly mailSink?: InvitationMailSink },
): Promise<{ readonly executed: boolean; readonly outcome?: AnnouncementDispatchOutcome; readonly emails?: EmailDeliveryCounts }> {
  if (event.eventType !== ANNOUNCEMENT_DISPATCH_REQUESTED || event.eventVersion !== 1) {
    throw new Error('event is outside the announcement consumer contract');
  }
  const announcementId = typeof event.payload.announcementId === 'string' ? event.payload.announcementId : '';
  if (!/^[0-9a-f-]{36}$/i.test(announcementId) || event.aggregateId !== announcementId) throw new Error('invalid announcement event');
  const result = await handleEventIdempotently(db, {
    consumerName: ANNOUNCEMENT_DISPATCH_CONSUMER,
    eventId: event.eventId,
    failureClass: 'ANNOUNCEMENT_DISPATCH_FAILED',
    effect: (tx) => sendAnnouncement(tx, announcementId, Boolean(deps.mailSink), event.correlationId),
  });
  if (!result.executed || !result.result) return { executed: false };
  const emails = result.result === 'SENT' && deps.mailSink ? await deliverAnnouncementEmails(db, announcementId, deps.mailSink, event.correlationId) : undefined;
  return { executed: true, outcome: result.result, ...(emails ? { emails } : {}) };
}

async function sendAnnouncement(tx: PersistenceDb, announcementId: string, sinkConfigured: boolean, correlationId: string): Promise<AnnouncementDispatchOutcome> {
  const found = await tx.execute(sql`
    SELECT a.id, a.institution_id, a.sender_user_id, a.sender_membership_id, a.sender_role, a.audience_unit_id, a.title, a.body,
           a.channels, a.state, (a.scheduled_for <= now()) AS due, o.legal_name, unit.name AS audience_name
    FROM institution_announcements a
    JOIN organizations o ON o.id = a.institution_id
    LEFT JOIN institution_units unit ON unit.id = a.audience_unit_id
    WHERE a.id = ${announcementId}::uuid
    FOR UPDATE OF a
  `) as QueryResult<{
    id: string; institution_id: string; sender_user_id: string; sender_membership_id: string; sender_role: string; audience_unit_id: string | null;
    title: string; body: string; channels: string[]; state: string; due: boolean; legal_name: string; audience_name: string | null;
  }>;
  const announcement = found.rows[0];
  if (!announcement) return 'NOT_FOUND';
  if (announcement.state === 'SENT') return 'ALREADY_SENT';
  if (announcement.state === 'CANCELLED') return 'CANCELLED';
  if (!announcement.due) throw new Error('announcement is not due yet');

  // The sender's scope at send time: an ended membership or teaching assignment stops the send.
  const membership = await tx.execute(sql`
    SELECT id, role, scope_department_unit_id, scope_batch_unit_id FROM organization_memberships
    WHERE id = ${announcement.sender_membership_id}::uuid AND user_id = ${announcement.sender_user_id}::uuid
      AND organization_id = ${announcement.institution_id}::uuid AND scope_institution_id = ${announcement.institution_id}::uuid
      AND role = ${announcement.sender_role} AND state = 'ACTIVE'
  `) as QueryResult<{ id: string; role: string; scope_department_unit_id: string | null; scope_batch_unit_id: string | null }>;
  const senderRow = membership.rows[0];
  const tree = await loadInstitutionUnitTree(tx, announcement.institution_id);
  const senderScope: InstitutionStudentScope = senderRow
    ? institutionAnnouncementScope(await withTeachingAssignments(tx, announcement.institution_id, [{
        role: senderRow.role, membershipId: senderRow.id, departmentUnitId: senderRow.scope_department_unit_id, batchUnitId: senderRow.scope_batch_unit_id,
      }]), tree)
    : { kind: 'NONE' };
  if (!canAddressInstitutionAudience(senderScope, announcement.audience_unit_id)) {
    await tx.execute(sql`
      UPDATE institution_announcements
      SET state = 'CANCELLED', cancelled_at = now(), cancel_reason_code = 'SENDER_ACCESS_ENDED', updated_at = now()
      WHERE id = ${announcement.id}::uuid
    `);
    await writeAnnouncementAudit(tx, announcement, 'institution.announcement.cancelled', correlationId, { reasonCode: 'SENDER_ACCESS_ENDED' });
    return 'SENDER_ACCESS_ENDED';
  }

  const audienceScope: InstitutionStudentScope = announcement.audience_unit_id === null
    ? { kind: 'INSTITUTION' }
    : { kind: 'UNITS', clauses: [[institutionUnitDescendants(announcement.audience_unit_id, tree)]] };
  const emailRequested = announcement.channels.includes('EMAIL');
  const data = {
    announcementId: announcement.id,
    institutionName: announcement.legal_name,
    from: announcementSenderLabels[announcement.sender_role] ?? 'your college',
    audience: announcement.audience_name ?? announcement.legal_name,
  };
  const inserted = await tx.execute(sql`
    WITH recipients AS (
      SELECT DISTINCT sp.student_user_id
      FROM institution_student_profiles sp
      JOIN institution_relationships ir ON ir.institution_id = sp.institution_id AND ir.student_user_id = sp.student_user_id
        AND ir.state IN ('ACTIVE', 'VERIFIED') AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now())
      WHERE sp.institution_id = ${announcement.institution_id}::uuid
        AND ${institutionStudentScopeSql(senderScope, 'sp')}
        AND ${institutionStudentScopeSql(audienceScope, 'sp')}
    ), notes AS (
      INSERT INTO user_notifications (id, user_id, kind, title, body, data)
      SELECT gen_random_uuid(), r.student_user_id, 'ANNOUNCEMENT', ${announcement.title}, ${announcement.body}, ${JSON.stringify(data)}::jsonb
      FROM recipients r
      RETURNING id, user_id
    )
    INSERT INTO institution_announcement_recipients (announcement_id, student_user_id, notification_id, email_state)
    SELECT ${announcement.id}::uuid, n.user_id, n.id,
           CASE WHEN NOT ${emailRequested}::boolean THEN 'NOT_REQUESTED'
                WHEN u.state <> 'ACTIVE' OR coalesce(np.email_enabled, true) = false THEN 'SKIPPED'
                WHEN NOT ${sinkConfigured}::boolean THEN 'NOT_CONFIGURED'
                ELSE 'PENDING' END
    FROM notes n
    JOIN users u ON u.id = n.user_id
    LEFT JOIN notification_preferences np ON np.user_id = n.user_id
    RETURNING student_user_id
  `) as QueryResult<{ student_user_id: string }>;
  const recipientCount = inserted.rows.length;
  await tx.execute(sql`
    UPDATE institution_announcements
    SET state = 'SENT', sent_at = now(), recipient_count = ${recipientCount}, updated_at = now()
    WHERE id = ${announcement.id}::uuid AND state = 'SCHEDULED'
  `);
  await writeAnnouncementAudit(tx, announcement, 'institution.announcement.sent', correlationId, { recipientCount });
  return 'SENT';
}

async function writeAnnouncementAudit(
  tx: PersistenceDb,
  announcement: { id: string; institution_id: string; sender_user_id: string },
  action: string,
  correlationId: string,
  context: Record<string, unknown>,
): Promise<void> {
  // The send is the sender's act, carried out at the time they chose.
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (gen_random_uuid(), ${announcement.sender_user_id}::uuid, ${action}, 'institution_announcement', ${announcement.id},
            ${announcement.institution_id}::uuid, 'SUCCESS', ${correlationId}, ${JSON.stringify(context)}::jsonb)
  `);
}

export interface EmailDeliveryCounts { readonly sent: number; readonly failed: number; readonly bounced: number }

/**
 * Send every PENDING email of a sent announcement, one recipient at a time. Each is claimed
 * PENDING → SENDING by a conditional update, so two workers never send the same one; the outcome
 * is recorded per recipient. A failure is recorded and never undoes anything else.
 */
export async function deliverAnnouncementEmails(db: PersistenceDb, announcementId: string, mailSink: InvitationMailSink, correlationId: string): Promise<EmailDeliveryCounts> {
  const header = await db.execute(sql`
    SELECT a.title, a.body, o.legal_name FROM institution_announcements a JOIN organizations o ON o.id = a.institution_id
    WHERE a.id = ${announcementId}::uuid AND a.state = 'SENT'
  `) as QueryResult<{ title: string; body: string; legal_name: string }>;
  const announcement = header.rows[0];
  const counts = { sent: 0, failed: 0, bounced: 0 };
  if (!announcement) return counts;
  const email = renderAnnouncementEmail({ institutionName: announcement.legal_name, title: announcement.title, body: announcement.body });
  for (;;) {
    const claimed = await db.execute(sql`
      UPDATE institution_announcement_recipients r SET email_state = 'SENDING', email_attempted_at = now()
      FROM users u
      WHERE r.announcement_id = ${announcementId}::uuid AND u.id = r.student_user_id
        AND r.student_user_id = (
          SELECT student_user_id FROM institution_announcement_recipients
          WHERE announcement_id = ${announcementId}::uuid AND email_state = 'PENDING'
          ORDER BY student_user_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND r.email_state = 'PENDING'
      RETURNING r.student_user_id, u.email
    `) as QueryResult<{ student_user_id: string; email: string }>;
    const recipient = claimed.rows[0];
    if (!recipient) break;
    let outcome: 'SENT' | 'FAILED' | 'BOUNCED' = 'SENT';
    try {
      await mailSink.send({ toEmail: recipient.email, subject: email.subject, textBody: email.textBody, invitationId: announcementId, correlationId });
    } catch (error) {
      outcome = error instanceof PermanentMailRejection ? 'BOUNCED' : 'FAILED';
    }
    await db.execute(sql`
      UPDATE institution_announcement_recipients SET email_state = ${outcome}
      WHERE announcement_id = ${announcementId}::uuid AND student_user_id = ${recipient.student_user_id}::uuid AND email_state = 'SENDING'
    `);
    if (outcome === 'SENT') counts.sent += 1; else if (outcome === 'BOUNCED') counts.bounced += 1; else counts.failed += 1;
  }
  return counts;
}
