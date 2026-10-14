/**
 * Dual-control approvals for high-risk operator actions (OPS-02, migration 0038).
 *
 * A request records the exact action and a hash of it; a second person approves or
 * rejects it; the action's own endpoint consumes the approval inside the action's
 * transaction. The rules are the pure functions in packages/authorization, evaluated
 * here against rows read under lock and the database clock; the 0038 trigger repeats
 * them for any other writer.
 *
 * Design: docs/architecture/high-risk-approvals-table-design.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  highRiskActions,
  isLegacyHighRiskActionKey,
  platformInternalRoles,
  refuseApprovalExecution,
  type ApprovalDecision,
  type ApprovalRefusal,
  type HighRiskActionKey,
} from '@planthepath/authorization/src/index.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

/** A drizzle database or transaction; for a pg client, wrap it with drizzle(client). */
export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

type Rows<T> = { rows: T[] };

async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

export class OperationApprovalError extends Error {
  constructor(readonly code: ApprovalRefusal | 'APPROVAL_NOT_REQUIRED' | 'APPROVAL_TARGET_NOT_FOUND' | 'APPROVAL_DECISION_REJECTED') {
    super(code);
    this.name = 'OperationApprovalError';
  }
}

// ---------------------------------------------------------------------------
// Payload binding
// ---------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/**
 * SHA-256 of the canonical JSON (sorted keys, undefined dropped) of the action key and
 * its payload. Execution recomputes this from the request it actually received.
 */
export function approvalPayloadHash(actionKey: HighRiskActionKey, payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonical({ actionKey, payload })), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Audit and outbox
// ---------------------------------------------------------------------------

async function audit(runner: SqlRunner, input: {
  readonly actorUserId: string; readonly action: string; readonly approvalId: string;
  readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actorUserId, action: input.action, resourceType: 'operation_approval', resourceId: input.approvalId, correlationId: input.correlationId });
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actorUserId}::uuid, ${input.action}, 'operation_approval', ${input.approvalId}, NULL, 'SUCCESS',
            ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

async function outbox(runner: SqlRunner, input: {
  readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string;
  readonly payload: Record<string, unknown>; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, ...input, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actorUserId}::uuid, ${input.correlationId})
  `);
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface OperationApprovalRequestInput {
  readonly actionKey: HighRiskActionKey;
  readonly targetId: string;
  readonly payload: Record<string, unknown> & { readonly reasonCode: string };
  readonly requestedByUserId: string;
  readonly note?: string;
  readonly correlationId: string;
}

/** File a request, with its audit row and outbox event, in one transaction. */
export async function createOperationApproval(
  db: SqlRunner & { transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> },
  input: OperationApprovalRequestInput,
): Promise<{ readonly id: string }> {
  const id = randomUUID();
  const payloadHash = approvalPayloadHash(input.actionKey, input.payload);
  await db.transaction(async (tx) => {
    // requested_at and expires_at are set by the 0038 trigger from the database clock.
    // A key 0038's CHECK does not list goes in the extension columns (0051), so a replay
    // of 0038 never meets a row its CHECK rejects.
    const legacy = isLegacyHighRiskActionKey(input.actionKey);
    const targetType = highRiskActions[input.actionKey].targetType;
    await tx.execute(sql`
      INSERT INTO operation_approvals
        (id, action_key, target_type, extended_action_key, extended_target_type, target_id, payload, payload_hash,
         requested_by_user_id, reason_code, note, correlation_id, expires_at)
      VALUES (${id}::uuid, ${legacy ? input.actionKey : null}, ${legacy ? targetType : null},
              ${legacy ? null : input.actionKey}, ${legacy ? null : targetType}, ${input.targetId},
              ${JSON.stringify(canonical(input.payload))}::jsonb, ${payloadHash}, ${input.requestedByUserId}::uuid,
              ${input.payload.reasonCode}, ${input.note ?? null}, ${input.correlationId}, now() + interval '24 hours')
    `);
    await audit(tx, {
      actorUserId: input.requestedByUserId, action: 'operations.approval.requested', approvalId: id, correlationId: input.correlationId,
      context: { actionKey: input.actionKey, targetType: highRiskActions[input.actionKey].targetType, targetId: input.targetId, reasonCode: input.payload.reasonCode, ...(input.note ? { note: input.note } : {}) },
    });
    await outbox(tx, {
      aggregateType: 'operation_approval', aggregateId: id, eventType: 'operation_approval.requested',
      payload: { approvalId: id, actionKey: input.actionKey }, actorUserId: input.requestedByUserId, correlationId: input.correlationId,
    });
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ApprovalListState = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'EXPIRED';

export interface OperationApprovalRow {
  readonly id: string;
  readonly actionKey: HighRiskActionKey;
  readonly targetType: string;
  readonly targetId: string;
  readonly payload: Record<string, unknown>;
  readonly reasonCode: string;
  readonly note: string | null;
  /** Stored state, except PENDING or APPROVED past expiry reads EXPIRED. */
  readonly state: ApprovalListState;
  /** The stored lifecycle state, before expiry is applied. */
  readonly storedState: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED';
  readonly requestedByUserId: string;
  readonly requesterEmail: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly coolingOffEndsAt: string;
  readonly coolingOffElapsed: boolean;
  readonly expired: boolean;
  readonly decidedByUserId: string | null;
  readonly deciderEmail: string | null;
  readonly decidedAt: string | null;
  readonly decisionReasonCode: string | null;
  readonly solo: boolean;
  readonly soloNoticeState: string | null;
  readonly executedAt: string | null;
  /** Resolved server-side for the summary; never the subject of a hold. */
  readonly organizationName: string | null;
  readonly memberEmail: string | null;
  readonly memberUserId: string | null;
  readonly holdReason: string | null;
  /** For a requirement-set publish: the role and set version, for the summary. */
  readonly careerRoleTitle: string | null;
  readonly careerRoleCatalogueCode: string | null;
  readonly careerSetVersion: number | null;
  /** For a skill publish (OPS-09a): the skill's name and key and the revision number. */
  readonly skillName: string | null;
  readonly skillKey: string | null;
  readonly skillRevision: number | null;
  /** For a question publish (OPS-09b): the question's key and the revision number — never its answer. */
  readonly questionKey: string | null;
  readonly questionRevision: number | null;
  /** For a lesson publish (OPS-09c): the lesson's key, the variant it is (language/level/style) and the revision. */
  readonly lessonKey: string | null;
  readonly lessonVariant: string | null;
  readonly lessonRevision: number | null;
  /** For a status notice template publish (OPS-16): the template key and version. */
  readonly commsTemplateKey: string | null;
  readonly commsTemplateVersion: number | null;
}

interface ApprovalDbRow {
  id: string; action_key: HighRiskActionKey; target_type: string; target_id: string; payload: Record<string, unknown>;
  reason_code: string; note: string | null; state: string; requested_by_user_id: string; requester_email: string;
  requested_at: string; expires_at: string; cooling_off_ends_at: string; cooling_off_elapsed: boolean; expired: boolean;
  decided_by_user_id: string | null; decider_email: string | null; decided_at: Date | null; decision_reason_code: string | null;
  solo: boolean; solo_notice_state: string | null; executed_at: Date | null;
  organization_name: string | null; member_email: string | null; member_user_id: string | null; hold_reason: string | null;
  career_role_title: string | null; career_role_catalogue_code: string | null; career_set_version: number | null;
  skill_name: string | null; skill_key: string | null; skill_revision: number | null;
  question_key: string | null; question_revision: number | null;
  lesson_key: string | null; lesson_variant: string | null; lesson_revision: number | null;
  comms_template_key: string | null; comms_template_version: number | null;
}

// Microsecond text timestamps for the keyset cursor: a millisecond cursor would repeat
// rows requested in the same millisecond.
const approvalSelect = sql`
  SELECT a.id, COALESCE(a.action_key, a.extended_action_key) AS action_key,
         COALESCE(a.target_type, a.extended_target_type) AS target_type, a.target_id, a.payload, a.reason_code, a.note, a.state,
         a.requested_by_user_id, ru.email AS requester_email,
         to_char(a.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS requested_at,
         to_char(a.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at,
         to_char((a.requested_at + interval '15 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cooling_off_ends_at,
         now() >= a.requested_at + interval '15 minutes' AS cooling_off_elapsed,
         now() >= a.expires_at AS expired,
         a.decided_by_user_id, du.email AS decider_email, a.decided_at, a.decision_reason_code,
         a.solo, a.solo_notice_state, a.executed_at,
         COALESCE(o.legal_name, offboarded.legal_name, tutor_college.legal_name) AS organization_name, mu.email AS member_email, mu.id AS member_user_id, h.reason_code AS hold_reason,
         cr.title AS career_role_title, cr.catalogue_code AS career_role_catalogue_code, crs.version AS career_set_version,
         CASE WHEN skr.entity_type = 'TOPIC' THEN COALESCE(skr.body->>'name', skn.name) END AS skill_name, skn.stable_key AS skill_key,
         CASE WHEN skr.entity_type = 'TOPIC' THEN skr.revision END AS skill_revision,
         CASE WHEN skr.entity_type = 'QUESTION' THEN skr.body->>'stableKey' END AS question_key,
         CASE WHEN skr.entity_type = 'QUESTION' THEN skr.revision END AS question_revision,
         CASE WHEN skr.entity_type = 'LESSON' THEN skr.body->>'stableKey' END AS lesson_key,
         CASE WHEN skr.entity_type = 'LESSON' THEN concat_ws('/', COALESCE(skr.body #>> '{variant,language}', 'en'),
           COALESCE(skr.body #>> '{variant,level}', 'STANDARD'), COALESCE(skr.body #>> '{variant,style}', 'EXPLANATION')) END AS lesson_variant,
         CASE WHEN skr.entity_type = 'LESSON' THEN skr.revision END AS lesson_revision,
         snt.template_key AS comms_template_key, snt.version AS comms_template_version
  FROM operation_approvals a
  JOIN users ru ON ru.id = a.requested_by_user_id
  LEFT JOIN users du ON du.id = a.decided_by_user_id
  LEFT JOIN organizations o ON a.target_type = 'organization' AND o.id::text = a.target_id
  LEFT JOIN organization_memberships mm ON a.target_type = 'organization_membership' AND mm.id::text = a.target_id
  LEFT JOIN users mu ON mu.id = mm.user_id
  LEFT JOIN data_retention_holds h ON a.target_type = 'data_retention_hold' AND h.id::text = a.target_id
  LEFT JOIN career_requirement_sets crs ON a.extended_target_type = 'career_requirement_set' AND crs.id::text = a.target_id
  LEFT JOIN career_roles cr ON cr.id = crs.career_role_id
  LEFT JOIN content_revisions skr ON a.extended_target_type = 'content_revision' AND skr.id::text = a.target_id
  LEFT JOIN taxonomy_nodes skn ON skn.id = skr.entity_id
  LEFT JOIN status_notice_templates snt ON a.extended_target_type = 'status_notice_template' AND snt.id::text = a.target_id
  -- INST-18: a purge names the college whose records it deletes.
  LEFT JOIN institution_offboardings iob ON a.extended_target_type = 'institution_offboarding' AND iob.id::text = a.target_id
  LEFT JOIN organizations offboarded ON offboarded.id = iob.institution_id
  -- ENG-25: switching the tutor on names the college it is for.
  LEFT JOIN organizations tutor_college ON a.extended_target_type = 'tutor_college' AND tutor_college.id::text = a.target_id`;

function mapApproval(row: ApprovalDbRow): OperationApprovalRow {
  const live = row.state === 'PENDING' || row.state === 'APPROVED';
  return {
    id: row.id,
    actionKey: row.action_key,
    targetType: row.target_type,
    targetId: row.target_id,
    payload: row.payload,
    reasonCode: row.reason_code,
    note: row.note,
    state: live && row.expired ? 'EXPIRED' : row.state as ApprovalListState,
    storedState: row.state as OperationApprovalRow['storedState'],
    requestedByUserId: row.requested_by_user_id,
    requesterEmail: row.requester_email,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    coolingOffEndsAt: row.cooling_off_ends_at,
    coolingOffElapsed: row.cooling_off_elapsed,
    expired: row.expired,
    decidedByUserId: row.decided_by_user_id,
    deciderEmail: row.decider_email,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    decisionReasonCode: row.decision_reason_code,
    solo: row.solo,
    soloNoticeState: row.solo_notice_state,
    executedAt: row.executed_at ? new Date(row.executed_at).toISOString() : null,
    organizationName: row.organization_name,
    memberEmail: row.member_email,
    memberUserId: row.member_user_id,
    holdReason: row.hold_reason,
    careerRoleTitle: row.career_role_title,
    careerRoleCatalogueCode: row.career_role_catalogue_code,
    careerSetVersion: row.career_set_version === null ? null : Number(row.career_set_version),
    skillName: row.skill_name,
    skillKey: row.skill_key,
    skillRevision: row.skill_revision === null ? null : Number(row.skill_revision),
    questionKey: row.question_key,
    questionRevision: row.question_revision === null ? null : Number(row.question_revision),
    lessonKey: row.lesson_key,
    lessonVariant: row.lesson_variant,
    lessonRevision: row.lesson_revision === null ? null : Number(row.lesson_revision),
    commsTemplateKey: row.comms_template_key,
    commsTemplateVersion: row.comms_template_version === null ? null : Number(row.comms_template_version),
  };
}

function stateFilter(state: ApprovalListState | undefined): SQL {
  switch (state) {
    case undefined: return sql`TRUE`;
    case 'PENDING': return sql`a.state = 'PENDING' AND now() < a.expires_at`;
    case 'APPROVED': return sql`a.state = 'APPROVED' AND now() < a.expires_at`;
    case 'EXPIRED': return sql`a.state IN ('PENDING', 'APPROVED') AND now() >= a.expires_at`;
    default: return sql`a.state = ${state}`;
  }
}

/** The queue, keyset paginated on (requested_at, id), oldest first. */
export async function listOperationApprovals(runner: SqlRunner, input: {
  readonly state?: ApprovalListState;
  /** Restrict to one requester (a caller who cannot approve sees only their own). */
  readonly requestedByUserId?: string;
  readonly limit: number;
  readonly cursor?: { readonly requestedAt: string; readonly id: string };
}): Promise<{ readonly approvals: readonly OperationApprovalRow[]; readonly nextCursor: { readonly requestedAt: string; readonly id: string } | null }> {
  const result = await rows<ApprovalDbRow>(runner, sql`
    ${approvalSelect}
    WHERE ${stateFilter(input.state)}
      AND (${input.requestedByUserId ?? null}::uuid IS NULL OR a.requested_by_user_id = ${input.requestedByUserId ?? null}::uuid)
      AND (${input.cursor?.requestedAt ?? null}::timestamptz IS NULL
           OR (a.requested_at, a.id) > (${input.cursor?.requestedAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
    ORDER BY a.requested_at, a.id
    LIMIT ${input.limit + 1}
  `);
  const page = result.slice(0, input.limit).map(mapApproval);
  const last = page[page.length - 1];
  return { approvals: page, nextCursor: result.length > input.limit && last ? { requestedAt: last.requestedAt, id: last.id } : null };
}

export async function loadOperationApproval(runner: SqlRunner, id: string, lock = false): Promise<OperationApprovalRow | null> {
  const result = await rows<ApprovalDbRow>(runner, lock
    ? sql`${approvalSelect} WHERE a.id = ${id}::uuid FOR UPDATE OF a`
    : sql`${approvalSelect} WHERE a.id = ${id}::uuid`);
  return result[0] ? mapApproval(result[0]) : null;
}

/** How many people hold APPROVE_HIGH_RISK right now (0038's function, one definition). */
export async function countHighRiskApprovers(runner: SqlRunner): Promise<number> {
  const result = await rows<{ count: number }>(runner, sql`SELECT operation_approval_approver_count() AS count`);
  return Number(result[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface ApprovalDecisionFacts {
  readonly state: string;
  readonly requestedByUserId: string;
  readonly expired: boolean;
  readonly coolingOffElapsed: boolean;
  readonly subjectUserId: string | null;
  readonly approverCount: number;
}

const soloNoticeTemplateId = '38000000-0000-4000-8000-000000000001';

/**
 * GROWTH-01 (ADR-040): operator notices go to the internal platform roles only. Growth field
 * staff are ACTIVE memberships of the same platform organisation, and must never receive them.
 */
function operatorRoleList(): SQL {
  return sql.join(platformInternalRoles.map((role) => sql`${role}`), sql`, `);
}

/**
 * The solo-approval notice, through the existing notification pipeline (ADR-021) and
 * only when a sender exists: the allow-listed security-notification workflow must be
 * registered active and outside its kill switch. Otherwise nothing is queued — a queued
 * command with no workflow would only fail into the dead letter — and the notice is
 * recorded as NOT_DELIVERED. Nothing here claims an email was sent.
 */
async function raiseSoloNotice(runner: SqlRunner, input: {
  readonly approvalId: string; readonly actionKey: HighRiskActionKey; readonly actorUserId: string; readonly correlationId: string;
}): Promise<'QUEUED' | 'NOT_DELIVERED'> {
  const sender = await rows(runner, sql`
    SELECT 1 FROM automation_workflow_registry WHERE allowlist_id = 'security-notification' AND active AND NOT kill_switch LIMIT 1
  `);
  if (!sender.length) return 'NOT_DELIVERED';
  await runner.execute(sql`
    INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
    VALUES (${soloNoticeTemplateId}::uuid, 'security-notification', 1, 'en-IN', 'ONE: a high-risk action was self-approved',
            'A high-risk operator action was approved by its own requester under the solo-operator safeguard. Review it in Operations, Settings, Approvals.',
            ${input.actorUserId}::uuid, now())
    ON CONFLICT (stable_key, version, locale) DO NOTHING
  `);
  const template = await rows<{ id: string }>(runner, sql`
    SELECT id FROM notification_templates WHERE stable_key = 'security-notification' AND version = 1 AND locale = 'en-IN'
  `);
  const templateId = template[0]!.id;
  const recipients = await rows<{ id: string }>(runner, sql`
    SELECT DISTINCT u.id FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.state = 'ACTIVE' AND m.role IN (${operatorRoleList()})
  `);
  for (const recipient of recipients) {
    const commandId = randomUUID();
    await runner.execute(sql`
      INSERT INTO notification_commands
        (id, subject_user_id, template_id, channel, legal_purpose, destination_ref, render_parameters, dedupe_key, state, expires_at, correlation_id)
      VALUES (${commandId}::uuid, ${recipient.id}::uuid, ${templateId}::uuid, 'EMAIL', 'security notice: solo approval of a high-risk action',
              ${'user:' + recipient.id}, ${JSON.stringify({ approvalId: input.approvalId, actionKey: input.actionKey })}::jsonb,
              ${'approval-solo:' + input.approvalId + ':' + recipient.id}, 'PENDING', now() + interval '24 hours', ${input.correlationId})
    `);
    await outbox(runner, {
      aggregateType: 'notification_command', aggregateId: commandId, eventType: 'notification.delivery.requested',
      payload: { commandId, templateId, channel: 'EMAIL' }, actorUserId: input.actorUserId, correlationId: input.correlationId,
    });
  }
  return 'QUEUED';
}

/**
 * Record an approve or reject decision. `decide` is the pure rule from
 * packages/authorization, evaluated here against the row locked FOR UPDATE and the
 * database clock, with the live approver count.
 */
export async function decideOperationApproval(
  db: { transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> },
  input: {
    readonly approvalId: string;
    readonly actorUserId: string;
    readonly decision: ApprovalDecision;
    readonly reasonCode: string;
    readonly note?: string;
    readonly correlationId: string;
    readonly decide: (facts: ApprovalDecisionFacts) => { readonly refusal: ApprovalRefusal } | { readonly solo: boolean };
  },
): Promise<OperationApprovalRow> {
  return db.transaction(async (tx) => {
    const current = await loadOperationApproval(tx, input.approvalId, true);
    if (!current) throw new OperationApprovalError('APPROVAL_NOT_FOUND');
    const verdict = input.decide({
      state: current.storedState,
      requestedByUserId: current.requestedByUserId,
      expired: current.expired,
      coolingOffElapsed: current.coolingOffElapsed,
      subjectUserId: current.actionKey === 'CAPABILITY_GRANT_HIGH_RISK' ? current.memberUserId : null,
      approverCount: await countHighRiskApprovers(tx),
    });
    if ('refusal' in verdict) throw new OperationApprovalError(verdict.refusal);
    const state = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const noticeState = verdict.solo
      ? await raiseSoloNotice(tx, { approvalId: current.id, actionKey: current.actionKey, actorUserId: input.actorUserId, correlationId: input.correlationId })
      : null;
    try {
      await tx.execute(sql`SAVEPOINT approval_decision`);
      await tx.execute(sql`
        UPDATE operation_approvals
        SET state = ${state}, decided_by_user_id = ${input.actorUserId}::uuid, decided_at = now(),
            decision_reason_code = ${input.reasonCode}, decision_note = ${input.note ?? null},
            solo = ${verdict.solo}, solo_notice_state = ${noticeState}
        WHERE id = ${input.approvalId}::uuid
      `);
      await tx.execute(sql`RELEASE SAVEPOINT approval_decision`);
    } catch {
      // The trigger re-checks every rule; if it disagrees with the pure rule, refuse
      // without forwarding database text.
      await tx.execute(sql`ROLLBACK TO SAVEPOINT approval_decision`);
      throw new OperationApprovalError('APPROVAL_DECISION_REJECTED');
    }
    const mode = verdict.solo ? 'SOLO' : 'DUAL';
    await audit(tx, {
      actorUserId: input.actorUserId,
      action: input.decision === 'APPROVE' ? 'operations.approval.approved' : 'operations.approval.rejected',
      approvalId: current.id, correlationId: input.correlationId,
      context: {
        actionKey: current.actionKey, requestedByUserId: current.requestedByUserId, decidedByUserId: input.actorUserId,
        reasonCode: input.reasonCode, mode, ...(noticeState ? { soloNotice: noticeState } : {}), ...(input.note ? { note: input.note } : {}),
      },
    });
    await outbox(tx, {
      aggregateType: 'operation_approval', aggregateId: current.id, eventType: 'operation_approval.decided',
      payload: { approvalId: current.id, actionKey: current.actionKey, decision: state, mode },
      actorUserId: input.actorUserId, correlationId: input.correlationId,
    });
    return (await loadOperationApproval(tx, current.id))!;
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ConsumedApproval {
  readonly approvalId: string;
  readonly requestedByUserId: string;
  readonly approvedByUserId: string;
  readonly mode: 'DUAL' | 'SOLO';
}

/**
 * Consume an approval inside the caller's transaction, which must be the one that
 * performs the action: the row is locked, checked against the action and the exact
 * payload the endpoint received, and moved to EXECUTED. If the action then fails, the
 * transaction rolls back and the approval stays usable.
 */
export async function consumeOperationApproval(runner: SqlRunner, input: {
  readonly approvalId: string;
  readonly actionKey: HighRiskActionKey;
  readonly payload: Record<string, unknown>;
  readonly executorUserId: string;
  readonly correlationId: string;
}): Promise<ConsumedApproval> {
  const locked = await rows<{
    state: string; action_key: string; payload_hash: string; requested_by_user_id: string; decided_by_user_id: string | null;
    solo: boolean; expired: boolean;
  }>(runner, sql`
    SELECT state, COALESCE(action_key, extended_action_key) AS action_key, payload_hash, requested_by_user_id,
           decided_by_user_id, solo, now() >= expires_at AS expired
    FROM operation_approvals WHERE id = ${input.approvalId}::uuid FOR UPDATE
  `);
  const row = locked[0];
  const refusal = refuseApprovalExecution({
    executorUserId: input.executorUserId,
    actionKey: input.actionKey,
    payloadHash: approvalPayloadHash(input.actionKey, input.payload),
    approval: row ? { state: row.state, actionKey: row.action_key, payloadHash: row.payload_hash, requestedByUserId: row.requested_by_user_id, expired: row.expired } : null,
  });
  if (refusal) throw new OperationApprovalError(refusal);
  await runner.execute(sql`
    UPDATE operation_approvals
    SET state = 'EXECUTED', executed_at = now(), executed_by_user_id = ${input.executorUserId}::uuid,
        execution_correlation_id = ${input.correlationId}
    WHERE id = ${input.approvalId}::uuid
  `);
  const consumed: ConsumedApproval = {
    approvalId: input.approvalId, requestedByUserId: row!.requested_by_user_id, approvedByUserId: row!.decided_by_user_id!,
    mode: row!.solo ? 'SOLO' : 'DUAL',
  };
  await audit(runner, {
    actorUserId: input.executorUserId, action: 'operations.approval.executed', approvalId: input.approvalId, correlationId: input.correlationId,
    context: { actionKey: input.actionKey, requestedByUserId: consumed.requestedByUserId, approvedByUserId: consumed.approvedByUserId, mode: consumed.mode },
  });
  await outbox(runner, {
    aggregateType: 'operation_approval', aggregateId: input.approvalId, eventType: 'operation_approval.executed',
    payload: { approvalId: input.approvalId, actionKey: input.actionKey }, actorUserId: input.executorUserId, correlationId: input.correlationId,
  });
  return consumed;
}
