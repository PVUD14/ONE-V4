/**
 * Status communications persistence (OPS-16, migration 0081): status-notice template versions that
 * a second person approves before they reach notification_templates, and status notices to the
 * administrators of the organisations an incident affects.
 *
 * A template version is drafted, put to an approver through OPS-02 dual control
 * (COMMS_TEMPLATE_PUBLISH) by its author, and published by that author with the executed approval,
 * which copies it into notification_templates with the approver as `approved_by_user_id`. A notice
 * is a DRAFT until a person approves it for sending; approving it writes an outbox event, and the
 * ADR-028 local dispatcher hands that event to `dispatchIncidentStatusNotice`, which resolves the
 * administrators at send time, writes each in-app notification and delivery row in one statement,
 * and marks the notice SENT. Email leaves after that commit through the configured mail sink
 * (sender `mailSender()`); with none (HG-7) it is recorded NOT_CONFIGURED, never faked. A notice
 * is never free text and never reaches a student, a regulator or anyone outside ONE.
 *
 * Design: docs/architecture/incident-register-table-design.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  refuseStatusNoticeApproval,
  statusNoticeAudienceRoles,
  statusNoticeMinimumSpacingMinutes,
  statusNoticeStableKey,
  type IncidentState,
} from '@planthepath/authorization/src/index.js';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import { PermanentMailRejection, type InvitationMailSink } from './invitation-mail.js';
import { consumeOperationApproval } from './operation-approvals.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';
import {
  incidentReference,
  rows,
  writeIncidentAudit,
  writeIncidentEvent,
  writeIncidentOutbox,
  type SqlRunner,
  type TransactionalRunner,
} from './incidents.js';

export const STATUS_NOTICE_DISPATCH_REQUESTED = 'incident.status_notice.dispatch.requested';
export const STATUS_NOTICE_DISPATCH_CONSUMER = 'incident-status-notice-dispatch';

export class StatusNoticeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'StatusNoticeError';
  }
}

const ts = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/** SHA-256 of the exact wording and its place in the version history; bound into the approval. */
export function statusNoticeTemplateHash(input: { readonly templateKey: string; readonly version: number; readonly subject: string; readonly body: string }): string {
  return createHash('sha256').update(JSON.stringify([input.templateKey, input.version, input.subject, input.body]), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface StatusNoticeTemplateRow {
  readonly id: string;
  readonly templateKey: string;
  readonly version: number;
  readonly subject: string;
  readonly body: string;
  readonly contentHash: string;
  readonly state: 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';
  readonly draftedBy: { readonly userId: string; readonly email: string };
  readonly draftedAt: string;
  readonly publishedAt: string | null;
  readonly approvedBy: string | null;
  readonly publishMode: 'DUAL' | 'SOLO' | null;
  readonly withdrawnAt: string | null;
  /** The approval request for publishing this version, when one is live or used. */
  readonly pendingApproval: { readonly id: string; readonly state: string } | null;
}

interface TemplateDbRow {
  id: string; template_key: string; version: number; subject: string; body: string; content_hash: string; state: StatusNoticeTemplateRow['state'];
  drafted_by_user_id: string; drafter_email: string; drafted_at: string; published_at: string | null; approver_email: string | null;
  solo: boolean | null; withdrawn_at: string | null; approval_id: string | null; approval_state: string | null;
}

const templateSelect = sql`
  SELECT t.id, t.template_key, t.version, t.subject, t.body, t.content_hash, t.state, t.drafted_by_user_id, du.email AS drafter_email,
         ${ts('t.drafted_at')} AS drafted_at, ${ts('t.published_at')} AS published_at, au.email AS approver_email, pa.solo,
         ${ts('t.withdrawn_at')} AS withdrawn_at, la.id AS approval_id,
         CASE WHEN la.id IS NULL THEN NULL WHEN la.state IN ('PENDING', 'APPROVED') AND now() >= la.expires_at THEN 'EXPIRED' ELSE la.state END AS approval_state
  FROM status_notice_templates t
  JOIN users du ON du.id = t.drafted_by_user_id
  LEFT JOIN operation_approvals pa ON pa.id = t.publish_approval_id
  LEFT JOIN users au ON au.id = pa.decided_by_user_id
  LEFT JOIN LATERAL (
    SELECT a.id, a.state, a.expires_at FROM operation_approvals a
    WHERE a.extended_action_key = 'COMMS_TEMPLATE_PUBLISH' AND a.target_id = t.id::text
    ORDER BY a.requested_at DESC, a.id DESC LIMIT 1
  ) la ON TRUE`;

function mapTemplate(row: TemplateDbRow): StatusNoticeTemplateRow {
  return {
    id: row.id, templateKey: row.template_key, version: Number(row.version), subject: row.subject, body: row.body, contentHash: row.content_hash,
    state: row.state, draftedBy: { userId: row.drafted_by_user_id, email: row.drafter_email }, draftedAt: row.drafted_at,
    publishedAt: row.published_at, approvedBy: row.approver_email, publishMode: row.solo === null ? null : row.solo ? 'SOLO' : 'DUAL',
    withdrawnAt: row.withdrawn_at, pendingApproval: row.approval_id ? { id: row.approval_id, state: row.approval_state ?? 'PENDING' } : null,
  };
}

export interface TemplateCursor { readonly draftedAt: string; readonly id: string }

/** Template versions, newest first, keyset paginated on (drafted_at, id). */
export async function listStatusNoticeTemplates(runner: SqlRunner, input: {
  readonly state?: StatusNoticeTemplateRow['state']; readonly limit: number; readonly cursor?: TemplateCursor;
}): Promise<{ readonly templates: readonly StatusNoticeTemplateRow[]; readonly nextCursor: TemplateCursor | null }> {
  const result = await rows<TemplateDbRow>(runner, sql`
    ${templateSelect}
    WHERE (${input.state ?? null}::text IS NULL OR t.state = ${input.state ?? null}::text)
      AND (${input.cursor?.draftedAt ?? null}::timestamptz IS NULL
           OR (t.drafted_at, t.id) < (${input.cursor?.draftedAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
    ORDER BY t.drafted_at DESC, t.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = result.slice(0, input.limit).map(mapTemplate);
  const last = page[page.length - 1];
  return { templates: page, nextCursor: result.length > input.limit && last ? { draftedAt: last.draftedAt, id: last.id } : null };
}

export async function loadStatusNoticeTemplate(runner: SqlRunner, templateId: string): Promise<StatusNoticeTemplateRow | null> {
  const result = await rows<TemplateDbRow>(runner, sql`${templateSelect} WHERE t.id = ${templateId}::uuid`);
  return result[0] ? mapTemplate(result[0]) : null;
}

/** Draft the next version of a template key. Versions are numbered under an advisory lock on the key. */
export async function draftStatusNoticeTemplate(db: TransactionalRunner, input: {
  readonly templateKey: string; readonly subject: string; readonly body: string; readonly reasonCode: string;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<{ readonly id: string }> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'status-notice-template:' + input.templateKey}))`);
    const [next] = await rows<{ version: number }>(tx, sql`
      SELECT COALESCE(max(version), 0)::int + 1 AS version FROM status_notice_templates WHERE template_key = ${input.templateKey}
    `);
    const version = Number(next?.version ?? 1);
    const contentHash = statusNoticeTemplateHash({ templateKey: input.templateKey, version, subject: input.subject, body: input.body });
    await tx.execute(sql`
      INSERT INTO status_notice_templates (id, template_key, version, subject, body, content_hash, drafted_by_user_id, draft_reason_code)
      VALUES (${id}::uuid, ${input.templateKey}, ${version}, ${input.subject}, ${input.body}, ${contentHash}, ${input.actorUserId}::uuid, ${input.reasonCode})
    `);
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.comms_template.drafted', resourceType: 'status_notice_template', resourceId: id,
      correlationId: input.correlationId, context: { reasonCode: input.reasonCode, templateKey: input.templateKey, version },
    });
  });
  return { id };
}

/**
 * Publish an approved template version: consume the COMMS_TEMPLATE_PUBLISH approval (bound to the
 * version's content hash), copy the wording into notification_templates with the approver as
 * `approved_by_user_id`, and mark the version PUBLISHED — one transaction.
 */
export async function publishStatusNoticeTemplate(db: TransactionalRunner, input: {
  readonly templateId: string; readonly reasonCode: string; readonly approvalId: string | null;
  readonly approvalPayload: (contentHash: string) => Record<string, unknown>;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<{ readonly notificationTemplateId: string; readonly mode: 'DUAL' | 'SOLO'; readonly approvalId: string }> {
  return db.transaction(async (tx) => {
    const [template] = await rows<{ template_key: string; version: number; subject: string; body: string; content_hash: string; state: string }>(tx, sql`
      SELECT template_key, version, subject, body, content_hash, state FROM status_notice_templates WHERE id = ${input.templateId}::uuid FOR UPDATE
    `);
    if (!template) throw new StatusNoticeError('COMMS_TEMPLATE_NOT_FOUND');
    if (template.state !== 'DRAFT') throw new StatusNoticeError('COMMS_TEMPLATE_NOT_DRAFT');
    if (!input.approvalId) throw new StatusNoticeError('APPROVAL_REQUIRED');
    const consumed = await consumeOperationApproval(tx, {
      approvalId: input.approvalId, actionKey: 'COMMS_TEMPLATE_PUBLISH', payload: input.approvalPayload(template.content_hash),
      executorUserId: input.actorUserId, correlationId: input.correlationId,
    });
    const notificationTemplateId = randomUUID();
    await tx.execute(sql`
      INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
      VALUES (${notificationTemplateId}::uuid, ${statusNoticeStableKey(template.template_key)}, ${Number(template.version)}, 'en-IN',
              ${template.subject}, ${template.body}, ${consumed.approvedByUserId}::uuid, now())
    `);
    await tx.execute(sql`
      UPDATE status_notice_templates SET state = 'PUBLISHED', published_template_id = ${notificationTemplateId}::uuid,
             publish_approval_id = ${input.approvalId}::uuid
      WHERE id = ${input.templateId}::uuid
    `);
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.comms_template.published', resourceType: 'status_notice_template', resourceId: input.templateId,
      correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, approvalId: input.approvalId, approvedByUserId: consumed.approvedByUserId, mode: consumed.mode, templateKey: template.template_key, version: Number(template.version) },
    });
    await writeIncidentOutbox(tx, {
      aggregateType: 'status_notice_template', aggregateId: input.templateId, eventType: 'status_notice_template.published',
      actorUserId: input.actorUserId, correlationId: input.correlationId, payload: { templateId: input.templateId, notificationTemplateId },
    });
    return { notificationTemplateId, mode: consumed.mode, approvalId: input.approvalId };
  });
}

export async function withdrawStatusNoticeTemplate(db: TransactionalRunner, input: {
  readonly templateId: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [template] = await rows<{ state: string }>(tx, sql`SELECT state FROM status_notice_templates WHERE id = ${input.templateId}::uuid FOR UPDATE`);
    if (!template) throw new StatusNoticeError('COMMS_TEMPLATE_NOT_FOUND');
    if (template.state !== 'DRAFT') throw new StatusNoticeError('COMMS_TEMPLATE_NOT_DRAFT');
    await tx.execute(sql`
      UPDATE status_notice_templates SET state = 'WITHDRAWN', withdrawn_by_user_id = ${input.actorUserId}::uuid, withdraw_reason_code = ${input.reasonCode}
      WHERE id = ${input.templateId}::uuid
    `);
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.comms_template.withdrawn', resourceType: 'status_notice_template', resourceId: input.templateId,
      correlationId: input.correlationId, context: { reasonCode: input.reasonCode },
    });
  });
}

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export interface StatusNoticeRow {
  readonly id: string;
  readonly incident: { readonly id: string; readonly reference: string; readonly title: string; readonly state: IncidentState };
  readonly template: { readonly id: string; readonly templateKey: string; readonly version: number; readonly subject: string; readonly body: string };
  readonly state: 'DRAFT' | 'QUEUED' | 'SENT' | 'WITHDRAWN';
  readonly draftedBy: string;
  readonly draftedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly sentAt: string | null;
  readonly recipientCount: number | null;
  readonly organizationCount: number | null;
  readonly email: { readonly sent: number; readonly pending: number; readonly notConfigured: number; readonly failed: number; readonly bounced: number; readonly skipped: number };
  readonly withdrawnAt: string | null;
}

interface NoticeDbRow {
  id: string; incident_id: string; incident_title: string; incident_state: IncidentState; template_row_id: string; template_key: string; version: number;
  subject: string; body: string; state: StatusNoticeRow['state']; drafter_email: string; drafted_at: string; approver_email: string | null;
  approved_at: string | null; sent_at: string | null; recipient_count: number | null; organization_count: number | null; withdrawn_at: string | null;
  email_sent: number; email_pending: number; email_not_configured: number; email_failed: number; email_bounced: number; email_skipped: number;
}

const noticeSelect = sql`
  SELECT n.id, n.incident_id, i.title AS incident_title, i.state AS incident_state, t.id AS template_row_id, t.template_key, t.version, t.subject, t.body,
         n.state, du.email AS drafter_email, ${ts('n.drafted_at')} AS drafted_at, au.email AS approver_email, ${ts('n.approved_at')} AS approved_at,
         ${ts('n.sent_at')} AS sent_at, n.recipient_count, n.organization_count, ${ts('n.withdrawn_at')} AS withdrawn_at,
         COALESCE(r.sent, 0) AS email_sent, COALESCE(r.pending, 0) AS email_pending, COALESCE(r.not_configured, 0) AS email_not_configured,
         COALESCE(r.failed, 0) AS email_failed, COALESCE(r.bounced, 0) AS email_bounced, COALESCE(r.skipped, 0) AS email_skipped
  FROM incident_status_notices n
  JOIN incidents i ON i.id = n.incident_id
  JOIN status_notice_templates t ON t.published_template_id = n.template_id
  JOIN users du ON du.id = n.drafted_by_user_id
  LEFT JOIN users au ON au.id = n.approved_by_user_id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE email_state = 'SENT')::int AS sent,
           count(*) FILTER (WHERE email_state IN ('PENDING', 'SENDING'))::int AS pending,
           count(*) FILTER (WHERE email_state = 'NOT_CONFIGURED')::int AS not_configured,
           count(*) FILTER (WHERE email_state = 'FAILED')::int AS failed,
           count(*) FILTER (WHERE email_state = 'BOUNCED')::int AS bounced,
           count(*) FILTER (WHERE email_state = 'SKIPPED')::int AS skipped
    FROM incident_status_notice_recipients WHERE notice_id = n.id
  ) r ON TRUE`;

function mapNotice(row: NoticeDbRow): StatusNoticeRow {
  return {
    id: row.id,
    incident: { id: row.incident_id, reference: incidentReference(row.incident_id), title: row.incident_title, state: row.incident_state },
    template: { id: row.template_row_id, templateKey: row.template_key, version: Number(row.version), subject: row.subject, body: row.body },
    state: row.state, draftedBy: row.drafter_email, draftedAt: row.drafted_at, approvedBy: row.approver_email, approvedAt: row.approved_at,
    sentAt: row.sent_at, recipientCount: row.recipient_count === null ? null : Number(row.recipient_count),
    organizationCount: row.organization_count === null ? null : Number(row.organization_count),
    email: {
      sent: Number(row.email_sent), pending: Number(row.email_pending), notConfigured: Number(row.email_not_configured),
      failed: Number(row.email_failed), bounced: Number(row.email_bounced), skipped: Number(row.email_skipped),
    },
    withdrawnAt: row.withdrawn_at,
  };
}

export interface NoticeCursor { readonly draftedAt: string; readonly id: string }

/** Notices, newest first, optionally for one incident; keyset paginated on (drafted_at, id). */
export async function listStatusNotices(runner: SqlRunner, input: {
  readonly incidentId?: string; readonly limit: number; readonly cursor?: NoticeCursor;
}): Promise<{ readonly notices: readonly StatusNoticeRow[]; readonly nextCursor: NoticeCursor | null }> {
  const result = await rows<NoticeDbRow>(runner, sql`
    ${noticeSelect}
    WHERE (${input.incidentId ?? null}::uuid IS NULL OR n.incident_id = ${input.incidentId ?? null}::uuid)
      AND (${input.cursor?.draftedAt ?? null}::timestamptz IS NULL
           OR (n.drafted_at, n.id) < (${input.cursor?.draftedAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
    ORDER BY n.drafted_at DESC, n.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = result.slice(0, input.limit).map(mapNotice);
  const last = page[page.length - 1];
  return { notices: page, nextCursor: result.length > input.limit && last ? { draftedAt: last.draftedAt, id: last.id } : null };
}

export async function loadStatusNotice(runner: SqlRunner, noticeId: string): Promise<StatusNoticeRow | null> {
  const result = await rows<NoticeDbRow>(runner, sql`${noticeSelect} WHERE n.id = ${noticeId}::uuid`);
  return result[0] ? mapNotice(result[0]) : null;
}

/** Draft a notice for an incident from a published template version. */
export async function draftStatusNotice(db: TransactionalRunner, input: {
  readonly incidentId: string; readonly templateId: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<{ readonly id: string }> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const [incident] = await rows<{ state: IncidentState }>(tx, sql`SELECT state FROM incidents WHERE id = ${input.incidentId}::uuid FOR UPDATE`);
    if (!incident) throw new StatusNoticeError('INCIDENT_NOT_FOUND');
    if (incident.state === 'CLOSED') throw new StatusNoticeError('STATUS_NOTICE_INCIDENT_CLOSED');
    const [template] = await rows<{ state: string; published_template_id: string | null }>(tx, sql`
      SELECT state, published_template_id FROM status_notice_templates WHERE id = ${input.templateId}::uuid
    `);
    if (!template) throw new StatusNoticeError('COMMS_TEMPLATE_NOT_FOUND');
    // The acceptance rule: an unapproved version cannot carry a notice. The FK to
    // notification_templates and the 0081 trigger refuse it again.
    if (template.state !== 'PUBLISHED' || !template.published_template_id) throw new StatusNoticeError('STATUS_NOTICE_TEMPLATE_NOT_APPROVED');
    await tx.execute(sql`
      INSERT INTO incident_status_notices (id, incident_id, template_id, drafted_by_user_id, draft_reason_code)
      VALUES (${id}::uuid, ${input.incidentId}::uuid, ${template.published_template_id}::uuid, ${input.actorUserId}::uuid, ${input.reasonCode})
    `);
    await writeIncidentEvent(tx, { incidentId: input.incidentId, kind: 'NOTICE_DRAFTED', noticeId: id, reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.status_notice.drafted', resourceType: 'incident_status_notice', resourceId: id,
      correlationId: input.correlationId, context: { reasonCode: input.reasonCode, incidentId: input.incidentId, templateId: input.templateId },
    });
  });
  return { id };
}

/**
 * A person approves a drafted notice for sending. Under the incident's lock the rate limit and the
 * audience are checked on the database clock (the 0081 trigger checks them again); the notice
 * becomes QUEUED and the dispatch event is written in the same transaction.
 */
export async function approveStatusNotice(db: TransactionalRunner, input: {
  readonly noticeId: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [notice] = await rows<{ incident_id: string; state: string }>(tx, sql`
      SELECT incident_id, state FROM incident_status_notices WHERE id = ${input.noticeId}::uuid
    `);
    if (!notice) throw new StatusNoticeError('STATUS_NOTICE_NOT_FOUND');
    // Serialise approvals for one incident (the 0081 trigger takes the same lock), then read the
    // notice under its own lock and count on the database clock.
    const [incident] = await rows<{ state: IncidentState }>(tx, sql`SELECT state FROM incidents WHERE id = ${notice.incident_id}::uuid FOR UPDATE`);
    const [locked] = await rows<{ state: string }>(tx, sql`SELECT state FROM incident_status_notices WHERE id = ${input.noticeId}::uuid FOR UPDATE`);
    const [facts] = await rows<{ live_orgs: number; recent: number; daily: number }>(tx, sql`
      SELECT (SELECT count(*)::int FROM incident_affected_organizations WHERE incident_id = ${notice.incident_id}::uuid AND removed_at IS NULL) AS live_orgs,
             (SELECT count(*)::int FROM incident_status_notices WHERE incident_id = ${notice.incident_id}::uuid AND id <> ${input.noticeId}::uuid
                AND approved_at > now() - make_interval(mins => ${statusNoticeMinimumSpacingMinutes}::int)) AS recent,
             (SELECT count(*)::int FROM incident_status_notices WHERE incident_id = ${notice.incident_id}::uuid AND id <> ${input.noticeId}::uuid
                AND approved_at > now() - interval '24 hours') AS daily
    `);
    const refusal = refuseStatusNoticeApproval({
      noticeState: locked!.state, incidentState: incident!.state, liveAffectedOrganizations: Number(facts!.live_orgs),
      approvedInSpacingWindow: Number(facts!.recent), approvedInLastDay: Number(facts!.daily),
    });
    if (refusal) throw new StatusNoticeError(refusal);
    await tx.execute(sql`
      UPDATE incident_status_notices SET state = 'QUEUED', approved_by_user_id = ${input.actorUserId}::uuid, approve_reason_code = ${input.reasonCode}
      WHERE id = ${input.noticeId}::uuid AND state = 'DRAFT'
    `);
    await writeIncidentEvent(tx, { incidentId: notice.incident_id, kind: 'NOTICE_QUEUED', noticeId: input.noticeId, reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.status_notice.approved', resourceType: 'incident_status_notice', resourceId: input.noticeId,
      correlationId: input.correlationId, context: { reasonCode: input.reasonCode, incidentId: notice.incident_id },
    });
    const eventId = randomUUID();
    const payload = { noticeId: input.noticeId, incidentId: notice.incident_id };
    validateOutboxWriteInput({ id: eventId, aggregateType: 'incident_status_notice', aggregateId: input.noticeId, eventType: STATUS_NOTICE_DISPATCH_REQUESTED,
      eventVersion: 1, payload, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await tx.execute(sql`
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
      VALUES (${eventId}::uuid, 'incident_status_notice', ${input.noticeId}, ${STATUS_NOTICE_DISPATCH_REQUESTED}, 1, ${JSON.stringify(payload)}::jsonb,
              ${input.actorUserId}::uuid, ${input.correlationId})
    `);
  });
}

export async function withdrawStatusNotice(db: TransactionalRunner, input: {
  readonly noticeId: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [notice] = await rows<{ incident_id: string; state: string }>(tx, sql`
      SELECT incident_id, state FROM incident_status_notices WHERE id = ${input.noticeId}::uuid FOR UPDATE
    `);
    if (!notice) throw new StatusNoticeError('STATUS_NOTICE_NOT_FOUND');
    if (notice.state !== 'DRAFT') throw new StatusNoticeError('STATUS_NOTICE_NOT_DRAFT');
    await tx.execute(sql`
      UPDATE incident_status_notices SET state = 'WITHDRAWN', withdrawn_by_user_id = ${input.actorUserId}::uuid, withdraw_reason_code = ${input.reasonCode}
      WHERE id = ${input.noticeId}::uuid
    `);
    await writeIncidentEvent(tx, { incidentId: notice.incident_id, kind: 'NOTICE_WITHDRAWN', noticeId: input.noticeId, reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.status_notice.withdrawn', resourceType: 'incident_status_notice', resourceId: input.noticeId,
      correlationId: input.correlationId, context: { reasonCode: input.reasonCode, incidentId: notice.incident_id },
    });
  });
}

// ---------------------------------------------------------------------------
// Dispatch (outbox consumer)
// ---------------------------------------------------------------------------

export type StatusNoticeDispatchOutcome = 'SENT' | 'ALREADY_SENT' | 'NOT_QUEUED' | 'NOT_FOUND';
export interface StatusNoticeEmailCounts { readonly sent: number; readonly failed: number; readonly bounced: number }

/** The email a recipient receives: the approved wording and a plain footer. Never free text. */
export function renderStatusNoticeEmail(input: { readonly subject: string; readonly body: string }): { readonly subject: string; readonly textBody: string } {
  return {
    subject: input.subject,
    textBody: [input.body, 'This is a service status notice from AI8HT ONE to the administrators of your organisation. You can read it any time in your ONE notifications.'].join('\n\n'),
  };
}

/**
 * Outbox consumer for STATUS_NOTICE_DISPATCH_REQUESTED. Sends a QUEUED notice at most once, to the
 * administrators of the incident's live affected organisations resolved now; then delivers any
 * email it queued.
 */
export async function dispatchIncidentStatusNotice(
  db: PersistenceDb,
  event: IntegrationEventEnvelope,
  deps: { readonly mailSink?: InvitationMailSink },
): Promise<{ readonly executed: boolean; readonly outcome?: StatusNoticeDispatchOutcome; readonly emails?: StatusNoticeEmailCounts }> {
  if (event.eventType !== STATUS_NOTICE_DISPATCH_REQUESTED || event.eventVersion !== 1) throw new Error('event is outside the status notice consumer contract');
  const noticeId = typeof event.payload.noticeId === 'string' ? event.payload.noticeId : '';
  if (!/^[0-9a-f-]{36}$/i.test(noticeId) || event.aggregateId !== noticeId) throw new Error('invalid status notice event');
  const result = await handleEventIdempotently(db, {
    consumerName: STATUS_NOTICE_DISPATCH_CONSUMER,
    eventId: event.eventId,
    failureClass: 'STATUS_NOTICE_DISPATCH_FAILED',
    effect: (tx) => sendStatusNotice(tx, noticeId, Boolean(deps.mailSink), event.correlationId),
  });
  if (!result.executed || !result.result) return { executed: false };
  const emails = result.result === 'SENT' && deps.mailSink ? await deliverStatusNoticeEmails(db, noticeId, deps.mailSink, event.correlationId) : undefined;
  return { executed: true, outcome: result.result, ...(emails ? { emails } : {}) };
}

async function sendStatusNotice(tx: PersistenceDb, noticeId: string, sinkConfigured: boolean, correlationId: string): Promise<StatusNoticeDispatchOutcome> {
  const found = await rows<{ incident_id: string; state: string; approved_by_user_id: string | null; subject: string; body: string }>(tx, sql`
    SELECT n.incident_id, n.state, n.approved_by_user_id, t.subject_template AS subject, t.body_template AS body
    FROM incident_status_notices n JOIN notification_templates t ON t.id = n.template_id
    WHERE n.id = ${noticeId}::uuid
    FOR UPDATE OF n
  `);
  const notice = found[0];
  if (!notice) return 'NOT_FOUND';
  if (notice.state === 'SENT') return 'ALREADY_SENT';
  if (notice.state !== 'QUEUED' || !notice.approved_by_user_id) return 'NOT_QUEUED';
  const roles = sql.join(statusNoticeAudienceRoles.map((role) => sql`${role}`), sql`, `);
  const inserted = await rows<{ recipient_user_id: string; organization_id: string }>(tx, sql`
    WITH orgs AS (
      SELECT a.organization_id, o.legal_name FROM incident_affected_organizations a JOIN organizations o ON o.id = a.organization_id
      WHERE a.incident_id = ${notice.incident_id}::uuid AND a.removed_at IS NULL
    ), admins AS (
      SELECT DISTINCT ON (m.user_id) m.user_id, m.organization_id, orgs.legal_name
      FROM organization_memberships m
      JOIN orgs ON orgs.organization_id = m.organization_id
      JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
      WHERE m.state = 'ACTIVE' AND m.role::text IN (${roles})
      ORDER BY m.user_id, orgs.legal_name, m.organization_id
    ), notes AS (
      INSERT INTO user_notifications (id, user_id, kind, title, body, data)
      SELECT gen_random_uuid(), a.user_id, 'STATUS_NOTICE', ${notice.subject}, ${notice.body},
             jsonb_build_object('from', 'AI8HT ONE', 'organizationName', a.legal_name)
      FROM admins a
      RETURNING id, user_id
    )
    INSERT INTO incident_status_notice_recipients (notice_id, recipient_user_id, organization_id, notification_id, email_state)
    SELECT ${noticeId}::uuid, n.user_id, a.organization_id, n.id,
           CASE WHEN coalesce(np.email_enabled, true) = false THEN 'SKIPPED'
                WHEN NOT ${sinkConfigured}::boolean THEN 'NOT_CONFIGURED'
                ELSE 'PENDING' END
    FROM notes n
    JOIN admins a ON a.user_id = n.user_id
    LEFT JOIN notification_preferences np ON np.user_id = n.user_id
    RETURNING recipient_user_id, organization_id
  `);
  const [orgCount] = await rows<{ count: number }>(tx, sql`
    SELECT count(*)::int AS count FROM incident_affected_organizations WHERE incident_id = ${notice.incident_id}::uuid AND removed_at IS NULL
  `);
  await tx.execute(sql`
    UPDATE incident_status_notices SET state = 'SENT', recipient_count = ${inserted.length}, organization_count = ${Number(orgCount?.count ?? 0)}
    WHERE id = ${noticeId}::uuid AND state = 'QUEUED'
  `);
  // The send is the approver's act, carried out by the worker.
  await writeIncidentEvent(tx, { incidentId: notice.incident_id, kind: 'NOTICE_SENT', noticeId, reasonCode: 'APPROVED_FOR_SEND', actorUserId: notice.approved_by_user_id, correlationId });
  await writeIncidentAudit(tx, {
    actorUserId: notice.approved_by_user_id, action: 'operations.status_notice.sent', resourceType: 'incident_status_notice', resourceId: noticeId,
    correlationId, context: { recipientCount: inserted.length, organizationCount: Number(orgCount?.count ?? 0), emailConfigured: sinkConfigured },
  });
  return 'SENT';
}

/**
 * Send every PENDING email of a sent notice, one recipient at a time: each is claimed PENDING →
 * SENDING by a conditional update, so two workers never send the same one. A failure is recorded
 * and never undoes the in-app notice.
 */
export async function deliverStatusNoticeEmails(db: PersistenceDb, noticeId: string, mailSink: InvitationMailSink, correlationId: string): Promise<StatusNoticeEmailCounts> {
  const counts = { sent: 0, failed: 0, bounced: 0 };
  const [header] = await rows<{ subject: string; body: string }>(db, sql`
    SELECT t.subject_template AS subject, t.body_template AS body
    FROM incident_status_notices n JOIN notification_templates t ON t.id = n.template_id
    WHERE n.id = ${noticeId}::uuid AND n.state = 'SENT'
  `);
  if (!header) return counts;
  const email = renderStatusNoticeEmail(header);
  for (;;) {
    const claimed = await rows<{ recipient_user_id: string; email: string }>(db, sql`
      UPDATE incident_status_notice_recipients r SET email_state = 'SENDING', email_attempted_at = now()
      FROM users u
      WHERE r.notice_id = ${noticeId}::uuid AND u.id = r.recipient_user_id
        AND r.recipient_user_id = (
          SELECT recipient_user_id FROM incident_status_notice_recipients
          WHERE notice_id = ${noticeId}::uuid AND email_state = 'PENDING'
          ORDER BY recipient_user_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        AND r.email_state = 'PENDING'
      RETURNING r.recipient_user_id, u.email
    `);
    const recipient = claimed[0];
    if (!recipient) break;
    let outcome: 'SENT' | 'FAILED' | 'BOUNCED' = 'SENT';
    try {
      await mailSink.send({ toEmail: recipient.email, subject: email.subject, textBody: email.textBody, invitationId: noticeId, correlationId });
    } catch (error) {
      outcome = error instanceof PermanentMailRejection ? 'BOUNCED' : 'FAILED';
    }
    await db.execute(sql`
      UPDATE incident_status_notice_recipients SET email_state = ${outcome}
      WHERE notice_id = ${noticeId}::uuid AND recipient_user_id = ${recipient.recipient_user_id}::uuid AND email_state = 'SENDING'
    `);
    if (outcome === 'SENT') counts.sent += 1; else if (outcome === 'BOUNCED') counts.bounced += 1; else counts.failed += 1;
  }
  return counts;
}

/** Incidents a communications operator can address a notice to: not closed, newest first, bounded. */
export async function listNoticeableIncidents(runner: SqlRunner): Promise<readonly { readonly id: string; readonly reference: string; readonly title: string; readonly state: IncidentState; readonly category: string; readonly affectedOrganizationsCount: number }[]> {
  return (await rows<{ id: string; title: string; state: IncidentState; category: string; affected: number }>(runner, sql`
    SELECT i.id, i.title, i.state, i.category,
           (SELECT count(*)::int FROM incident_affected_organizations a WHERE a.incident_id = i.id AND a.removed_at IS NULL) AS affected
    FROM incidents i WHERE i.state <> 'CLOSED' ORDER BY i.declared_at DESC, i.id DESC LIMIT 100
  `)).map((row) => ({ id: row.id, reference: incidentReference(row.id), title: row.title, state: row.state, category: row.category, affectedOrganizationsCount: Number(row.affected) }));
}
