/**
 * Student invitations: create, deliver, resend, revoke, and the activation state a college sees.
 *
 * A rostered student is a pre-created INVITED user that nobody used to invite, so they could never
 * sign in. Creating a student now writes a STUDENT invitation and an outbox event in the same
 * transaction; the outbox worker delivers it under a consumer receipt, minting the token at send
 * time because only its hash is ever stored. Design and rejected options:
 * docs/architecture/student-invitations-table-design.md.
 */
import { sql } from 'drizzle-orm';
import { digestInvitationToken, generateInvitationToken } from '@planthepath/identity/src/invitation-token.js';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import { buildInvitationUrl, PermanentMailRejection, type InvitationMailSink } from './invitation-mail.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

export const STUDENT_INVITATION_REQUESTED = 'institution.student.invitation.requested';
export const STUDENT_INVITATION_CONSUMER = 'student-invitation-delivery';
export const STUDENT_INVITATION_TEMPLATE_ID = '26000000-0000-4000-8000-000000000006';
const STUDENT_INVITATION_TEMPLATE_KEY = 'institution-student-invitation';
const STUDENT_INVITATION_SUBJECT = 'Your college has invited you to ONE';
const invitationLifetimeMs = 14 * 24 * 60 * 60 * 1_000;
const reasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;

export type StudentActivationState = 'ACTIVATED' | 'INVITED' | 'EXPIRED' | 'BOUNCED' | 'NOT_INVITED';

export interface StudentActivation {
  readonly state: StudentActivationState;
  readonly deliveryState: string | null;
  readonly invitedAt: string | null;
  readonly expiresAt: string | null;
  readonly lastSentAt: string | null;
}

export interface CreateStudentInvitationInput {
  readonly invitationId: string;
  readonly institutionId: string;
  readonly studentUserId: string;
  readonly email: string;
  readonly invitedByUserId: string;
  readonly outboxEventId: string;
  readonly auditId: string;
  readonly correlationId: string;
  readonly reasonCode?: string;
  readonly now?: Date;
}

/**
 * Write a STUDENT invitation and its delivery request inside the caller's transaction. The stored
 * hash belongs to a token nobody holds; delivery replaces it with the hash of the token it emails.
 */
export async function createStudentInvitation(tx: PersistenceDb, input: CreateStudentInvitationInput): Promise<void> {
  if (input.reasonCode !== undefined && !reasonCodePattern.test(input.reasonCode)) throw new Error('invalid reason code');
  const expiresAt = new Date((input.now ?? new Date()).getTime() + invitationLifetimeMs);
  await ensureStudentInvitationTemplate(tx, input.invitedByUserId);
  await tx.execute(sql`
    INSERT INTO invitations (id, kind, email, token_hash, invited_by_user_id, organization_id, student_user_id, expires_at, reason_code)
    VALUES (${input.invitationId}::uuid, 'STUDENT', ${input.email}, ${digestInvitationToken(generateInvitationToken())},
            ${input.invitedByUserId}::uuid, ${input.institutionId}::uuid, ${input.studentUserId}::uuid, ${expiresAt}, ${input.reasonCode ?? null})
  `);
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${input.auditId}::uuid, ${input.invitedByUserId}::uuid, 'identity.student_invitation.created', 'invitation', ${input.invitationId},
            ${input.institutionId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.reasonCode ? { reasonCode: input.reasonCode } : {})}::jsonb)
  `);
  await writeInvitationRequested(tx, input.outboxEventId, input.invitationId, input.invitedByUserId, input.institutionId, input.correlationId);
}

async function writeInvitationRequested(tx: PersistenceDb, eventId: string, invitationId: string, actorUserId: string, institutionId: string, correlationId: string): Promise<void> {
  const outbox = { id: eventId, aggregateType: 'invitation', aggregateId: invitationId, eventType: STUDENT_INVITATION_REQUESTED,
    eventVersion: 1, payload: { invitationId }, actorUserId, organizationId: institutionId, correlationId };
  validateOutboxWriteInput(outbox);
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${eventId}::uuid, 'invitation', ${invitationId}, ${STUDENT_INVITATION_REQUESTED}, 1, ${JSON.stringify({ invitationId })}::jsonb,
            ${actorUserId}::uuid, ${institutionId}::uuid, ${correlationId})
  `);
}

async function ensureStudentInvitationTemplate(tx: PersistenceDb, actorUserId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
    VALUES (${STUDENT_INVITATION_TEMPLATE_ID}::uuid, ${STUDENT_INVITATION_TEMPLATE_KEY}, 1, 'en-IN', ${STUDENT_INVITATION_SUBJECT},
            'Rendered by the student invitation sender with a single-use link; the link is never stored.', ${actorUserId}::uuid, now())
    ON CONFLICT (stable_key, version, locale) DO NOTHING
  `);
}

/** Version 1 of the student invitation email. The link carries the only copy of the token. */
export function renderStudentInvitationEmail(input: { readonly institutionName: string; readonly email: string; readonly invitationUrl: string }): { readonly subject: string; readonly textBody: string } {
  return {
    subject: STUDENT_INVITATION_SUBJECT,
    textBody: [
      `${input.institutionName} has added you to ONE, where you will see your learning, readiness and placement opportunities.`,
      `Open this link and sign in or create your account with ${input.email}:`,
      input.invitationUrl,
      'The link works once and expires in 14 days. If you were not expecting this, you can ignore it.',
    ].join('\n\n'),
  };
}

/**
 * Outbox consumer for STUDENT_INVITATION_REQUESTED. Idempotent through event_consumer_receipts: a
 * replayed event sends nothing. The token hash is stored before sending, inside the receipt's
 * transaction, so a failed send rolls it back and the retry mints a fresh one.
 */
export async function deliverStudentInvitation(
  db: PersistenceDb,
  event: IntegrationEventEnvelope,
  deps: { readonly mailSink?: InvitationMailSink; readonly now?: Date },
): Promise<{ readonly executed: boolean; readonly outcome?: 'SENT' | 'BOUNCED' | 'NOT_CONFIGURED' | 'NOT_USABLE' }> {
  if (event.eventType !== STUDENT_INVITATION_REQUESTED || event.eventVersion !== 1) {
    throw new Error('event is outside the student invitation consumer contract');
  }
  const invitationId = typeof event.payload.invitationId === 'string' ? event.payload.invitationId : '';
  if (!/^[0-9a-f-]{36}$/i.test(invitationId) || event.aggregateId !== invitationId) throw new Error('invalid student invitation event');
  const result = await handleEventIdempotently(db, {
    consumerName: STUDENT_INVITATION_CONSUMER,
    eventId: event.eventId,
    failureClass: 'STUDENT_INVITATION_DELIVERY_FAILED',
    effect: async (tx) => {
      const now = deps.now ?? new Date();
      const found = await tx.execute(sql`
        SELECT i.id, i.email, o.legal_name
        FROM invitations i JOIN organizations o ON o.id = i.organization_id
        WHERE i.id = ${invitationId}::uuid AND i.kind = 'STUDENT' AND i.state = 'PENDING'
          AND i.revoked_at IS NULL AND i.expires_at > ${now}
        FOR UPDATE OF i
      `) as QueryResult<{ id: string; email: string; legal_name: string }>;
      const invitation = found.rows[0];
      if (!invitation) return 'NOT_USABLE' as const;
      if (!deps.mailSink) {
        await tx.execute(sql`UPDATE invitations SET delivery_state = 'NOT_CONFIGURED', updated_at = now() WHERE id = ${invitation.id}::uuid`);
        return 'NOT_CONFIGURED' as const;
      }
      const token = generateInvitationToken();
      await tx.execute(sql`
        UPDATE invitations
        SET token_hash = ${digestInvitationToken(token)}, delivery_state = 'SENT', send_count = send_count + 1,
            last_sent_at = ${now}, updated_at = now()
        WHERE id = ${invitation.id}::uuid
      `);
      const email = renderStudentInvitationEmail({ institutionName: invitation.legal_name, email: invitation.email, invitationUrl: buildInvitationUrl(token) });
      try {
        await deps.mailSink.send({ toEmail: invitation.email, subject: email.subject, textBody: email.textBody, invitationId: invitation.id, correlationId: event.correlationId });
      } catch (error) {
        if (!(error instanceof PermanentMailRejection)) throw error;
        await tx.execute(sql`
          UPDATE invitations SET delivery_state = 'BOUNCED', bounced_at = ${now}, updated_at = now() WHERE id = ${invitation.id}::uuid
        `);
        return 'BOUNCED' as const;
      }
      return 'SENT' as const;
    },
  });
  return result.executed && result.result ? { executed: true, outcome: result.result } : { executed: false };
}

/**
 * Resend the invitation for each listed student. A pending, unexpired invitation is re-queued (a
 * new token is minted when it is sent); otherwise the old one is closed and a new one created.
 * Students already activated are skipped. Returns how many invitations were queued.
 */
export async function resendStudentInvitations(tx: PersistenceDb, input: {
  readonly institutionId: string;
  readonly studentUserIds: readonly string[];
  readonly actorUserId: string;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly newId: () => string;
  readonly now?: Date;
}): Promise<{ readonly queued: number; readonly skipped: number }> {
  if (!reasonCodePattern.test(input.reasonCode)) throw new Error('invalid reason code');
  const now = input.now ?? new Date();
  let queued = 0;
  let skipped = 0;
  for (const studentUserId of input.studentUserIds) {
    const student = await tx.execute(sql`
      SELECT u.id, u.email, u.state
      FROM institution_student_profiles p JOIN users u ON u.id = p.student_user_id
      WHERE p.institution_id = ${input.institutionId}::uuid AND p.student_user_id = ${studentUserId}::uuid
        AND EXISTS (SELECT 1 FROM institution_relationships r WHERE r.institution_id = p.institution_id
          AND r.student_user_id = p.student_user_id AND r.state IN ('VERIFIED', 'ACTIVE')
          AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now()))
      FOR UPDATE OF u
    `) as QueryResult<{ id: string; email: string; state: string }>;
    const row = student.rows[0];
    if (!row || row.state !== 'INVITED') { skipped += 1; continue; }
    const latest = await tx.execute(sql`
      SELECT id, state, expires_at, delivery_state FROM invitations
      WHERE kind = 'STUDENT' AND organization_id = ${input.institutionId}::uuid AND student_user_id = ${studentUserId}::uuid
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE
    `) as QueryResult<{ id: string; state: string; expires_at: Date | string; delivery_state: string }>;
    const current = latest.rows[0];
    const reusable = current && current.state === 'PENDING' && new Date(current.expires_at) > now && current.delivery_state !== 'BOUNCED';
    if (reusable) {
      await tx.execute(sql`UPDATE invitations SET reason_code = ${input.reasonCode}, updated_at = now() WHERE id = ${current.id}::uuid`);
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${input.newId()}::uuid, ${input.actorUserId}::uuid, 'identity.student_invitation.resent', 'invitation', ${current.id},
                ${input.institutionId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify({ reasonCode: input.reasonCode })}::jsonb)
      `);
      await writeInvitationRequested(tx, input.newId(), current.id, input.actorUserId, input.institutionId, input.correlationId);
    } else {
      if (current && current.state === 'PENDING') {
        await tx.execute(sql`UPDATE invitations SET state = 'EXPIRED', updated_at = now() WHERE id = ${current.id}::uuid AND state = 'PENDING'`);
      }
      await createStudentInvitation(tx, {
        invitationId: input.newId(), institutionId: input.institutionId, studentUserId, email: row.email,
        invitedByUserId: input.actorUserId, outboxEventId: input.newId(), auditId: input.newId(),
        correlationId: input.correlationId, reasonCode: input.reasonCode, now,
      });
    }
    queued += 1;
  }
  return { queued, skipped };
}

/** Revoke a student's pending invitation, e.g. when their relationship with the college ends. */
export async function revokePendingStudentInvitations(tx: PersistenceDb, input: {
  readonly institutionId: string; readonly studentUserId: string; readonly reasonCode: string;
}): Promise<void> {
  await tx.execute(sql`
    UPDATE invitations SET state = 'REVOKED', revoked_at = now(), reason_code = ${input.reasonCode}, updated_at = now()
    WHERE kind = 'STUDENT' AND organization_id = ${input.institutionId}::uuid
      AND student_user_id = ${input.studentUserId}::uuid AND state = 'PENDING'
  `);
}

/** Activation state per student, from their user row and latest student invitation. */
export async function loadStudentActivations(
  db: PersistenceDb,
  institutionId: string,
  studentUserIds: readonly string[],
  now: Date = new Date(),
): Promise<ReadonlyMap<string, StudentActivation>> {
  const activations = new Map<string, StudentActivation>();
  if (studentUserIds.length === 0) return activations;
  const rows = await db.execute(sql`
    SELECT u.id AS student_user_id, u.state AS user_state, i.state AS invitation_state, i.delivery_state,
           i.created_at, i.expires_at, i.last_sent_at
    FROM users u
    LEFT JOIN LATERAL (
      SELECT state, delivery_state, created_at, expires_at, last_sent_at FROM invitations
      WHERE kind = 'STUDENT' AND organization_id = ${institutionId}::uuid AND student_user_id = u.id
      ORDER BY created_at DESC LIMIT 1
    ) i ON true
    WHERE u.id = ANY(${`{${studentUserIds.join(',')}}`}::uuid[])
  `) as QueryResult<{
    student_user_id: string; user_state: string; invitation_state: string | null; delivery_state: string | null;
    created_at: Date | string | null; expires_at: Date | string | null; last_sent_at: Date | string | null;
  }>;
  for (const row of rows.rows) {
    activations.set(row.student_user_id, {
      state: activationState(row, now),
      deliveryState: row.delivery_state,
      invitedAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      lastSentAt: iso(row.last_sent_at),
    });
  }
  return activations;
}

export function summariseActivations(activations: Iterable<StudentActivation>): Readonly<Record<StudentActivationState, number>> {
  const summary: Record<StudentActivationState, number> = { ACTIVATED: 0, INVITED: 0, EXPIRED: 0, BOUNCED: 0, NOT_INVITED: 0 };
  for (const activation of activations) summary[activation.state] += 1;
  return summary;
}

function activationState(row: { user_state: string; invitation_state: string | null; delivery_state: string | null; expires_at: Date | string | null }, now: Date): StudentActivationState {
  if (row.user_state === 'ACTIVE') return 'ACTIVATED';
  if (!row.invitation_state) return 'NOT_INVITED';
  if (row.delivery_state === 'BOUNCED') return 'BOUNCED';
  if (row.invitation_state === 'EXPIRED' || (row.invitation_state === 'PENDING' && row.expires_at && new Date(row.expires_at) <= now)) return 'EXPIRED';
  if (row.invitation_state === 'PENDING') return 'INVITED';
  return 'NOT_INVITED';
}

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}
