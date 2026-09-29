/**
 * Incident register persistence (OPS-16, migration 0081): incidents, their append-only timeline,
 * the organisations they affect, and the Board / affected-users notification records.
 *
 * Every write takes the incident row FOR UPDATE, then writes its timeline row, its audit row and —
 * for a declaration or a state change — its outbox event in one transaction. Every lifecycle time
 * and the breach clock come from the database clock; the 0081 trigger repeats the rules for any
 * other writer. Nothing here contacts the Data Protection Board or anyone outside ONE: the Board
 * record says that a person did.
 *
 * Design: docs/architecture/incident-register-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  breachClockBasis,
  classifyBreachClock,
  type BreachClockStatus,
  type IncidentCategory,
  type IncidentSeverity,
  type IncidentState,
} from '@planthepath/authorization/src/index.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

/** A drizzle database or transaction. */
export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

export interface TransactionalRunner extends SqlRunner {
  transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

type Rows<T> = { rows: T[] };

export async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

export type IncidentErrorCode =
  | 'INCIDENT_NOT_FOUND'
  | 'INCIDENT_CLOSED'
  | 'INCIDENT_DETECTED_AT_INVALID'
  | 'INCIDENT_NOTIFIED_AT_INVALID'
  | 'INCIDENT_NOT_A_BREACH'
  | 'INCIDENT_BOARD_ALREADY_NOTIFIED'
  | 'INCIDENT_USERS_ALREADY_NOTIFIED'
  | 'INCIDENT_SEVERITY_UNCHANGED'
  | 'INCIDENT_ORGANIZATION_NOT_FOUND'
  | 'INCIDENT_ORGANIZATION_ALREADY_ADDED'
  | 'INCIDENT_ORGANIZATION_NOT_AFFECTED'
  | 'INCIDENT_REJECTED';

export class IncidentError extends Error {
  constructor(readonly code: IncidentErrorCode | string) {
    super(code);
    this.name = 'IncidentError';
  }
}

// ---------------------------------------------------------------------------
// Audit, outbox and timeline
// ---------------------------------------------------------------------------

export async function writeIncidentAudit(runner: SqlRunner, input: {
  readonly actorUserId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly organizationId?: string | null; readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actorUserId, action: input.action, resourceType: input.resourceType, resourceId: input.resourceId, correlationId: input.correlationId });
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId},
            ${input.organizationId ?? null}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

export async function writeIncidentOutbox(runner: SqlRunner, input: {
  readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, ...input, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actorUserId}::uuid, ${input.correlationId})
  `);
}

export type IncidentEventKind =
  | 'DECLARED' | 'STATE_CHANGED' | 'SEVERITY_CHANGED' | 'CATEGORY_CHANGED' | 'NOTE' | 'ORGANIZATION_ADDED' | 'ORGANIZATION_REMOVED'
  | 'BOARD_NOTIFIED' | 'USERS_NOTIFIED' | 'NOTICE_DRAFTED' | 'NOTICE_QUEUED' | 'NOTICE_SENT' | 'NOTICE_WITHDRAWN';

/** One timeline row; `occurred_at` is stamped by the 0081 trigger. */
export async function writeIncidentEvent(runner: SqlRunner, input: {
  readonly incidentId: string; readonly kind: IncidentEventKind; readonly fromValue?: string | null; readonly toValue?: string | null;
  readonly organizationId?: string | null; readonly noticeId?: string | null; readonly note?: string | null;
  readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await runner.execute(sql`
    INSERT INTO incident_events (id, incident_id, event_kind, from_value, to_value, organization_id, notice_id, note, reason_code, actor_user_id, correlation_id)
    VALUES (${randomUUID()}::uuid, ${input.incidentId}::uuid, ${input.kind}, ${input.fromValue ?? null}, ${input.toValue ?? null},
            ${input.organizationId ?? null}::uuid, ${input.noticeId ?? null}::uuid, ${input.note ?? null}, ${input.reasonCode},
            ${input.actorUserId}::uuid, ${input.correlationId})
  `);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface LockedIncident {
  state: IncidentState; category: IncidentCategory; severity: IncidentSeverity;
  board_notified: boolean; users_notified: boolean;
}

export async function lockIncident(tx: SqlRunner, incidentId: string): Promise<LockedIncident> {
  const found = await rows<LockedIncident>(tx, sql`
    SELECT state, category, severity, board_notified_at IS NOT NULL AS board_notified, users_notified_at IS NOT NULL AS users_notified
    FROM incidents WHERE id = ${incidentId}::uuid FOR UPDATE
  `);
  if (!found[0]) throw new IncidentError('INCIDENT_NOT_FOUND');
  return found[0];
}

/** A reference an operator can read out: derived from the id, never a second identifier. */
export function incidentReference(id: string): string {
  return `INC-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export interface DeclareIncidentInput {
  readonly title: string;
  readonly summary: string;
  readonly category: IncidentCategory;
  readonly severity: IncidentSeverity;
  readonly detectedAt: string;
  readonly reasonCode: string;
  readonly actorUserId: string;
  readonly correlationId: string;
}

/** Declare an incident: the row, its DECLARED event, audit and outbox. */
export async function declareIncident(db: TransactionalRunner, input: DeclareIncidentInput): Promise<{ readonly id: string }> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    // detected_at is an operator fact, bounded by the database clock: not in the future, and not
    // more than a year back (a typo guard). The trigger repeats the upper bound.
    const [bounds] = await rows<{ ok: boolean }>(tx, sql`
      SELECT (${input.detectedAt}::timestamptz <= now() AND ${input.detectedAt}::timestamptz >= now() - interval '365 days') AS ok
    `);
    if (!bounds?.ok) throw new IncidentError('INCIDENT_DETECTED_AT_INVALID');
    await tx.execute(sql`
      INSERT INTO incidents (id, title, summary, category, severity, detected_at, declared_by_user_id, declare_reason_code)
      VALUES (${id}::uuid, ${input.title}, ${input.summary}, ${input.category}, ${input.severity}, ${input.detectedAt}::timestamptz,
              ${input.actorUserId}::uuid, ${input.reasonCode})
    `);
    await writeIncidentEvent(tx, { incidentId: id, kind: 'DECLARED', toValue: 'OPEN', reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.incident.declared', resourceType: 'incident', resourceId: id, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, category: input.category, severity: input.severity },
    });
    await writeIncidentOutbox(tx, {
      aggregateType: 'incident', aggregateId: id, eventType: 'incident.declared', actorUserId: input.actorUserId, correlationId: input.correlationId,
      payload: { incidentId: id, category: input.category, severity: input.severity },
    });
  });
  return { id };
}

/**
 * Move an incident to another state. `refuse` is the pure rule from packages/authorization,
 * evaluated against the row locked here; the 0081 trigger checks the edge again and stamps times.
 */
export async function transitionIncident(db: TransactionalRunner, input: {
  readonly incidentId: string; readonly toState: IncidentState; readonly reasonCode: string; readonly note?: string | null;
  readonly actorUserId: string; readonly correlationId: string;
  readonly refuse: (current: { readonly state: IncidentState; readonly category: IncidentCategory; readonly boardNotified: boolean; readonly usersNotified: boolean }) => string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, input.incidentId);
    const refusal = input.refuse({ state: current.state, category: current.category, boardNotified: current.board_notified, usersNotified: current.users_notified });
    if (refusal) throw new IncidentError(refusal);
    await tx.execute(sql`UPDATE incidents SET state = ${input.toState} WHERE id = ${input.incidentId}::uuid`);
    await writeIncidentEvent(tx, { incidentId: input.incidentId, kind: 'STATE_CHANGED', fromValue: current.state, toValue: input.toState, note: input.note ?? null,
      reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.incident.transitioned', resourceType: 'incident', resourceId: input.incidentId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, fromState: current.state, toState: input.toState },
    });
    await writeIncidentOutbox(tx, {
      aggregateType: 'incident', aggregateId: input.incidentId, eventType: 'incident.state_changed', actorUserId: input.actorUserId, correlationId: input.correlationId,
      payload: { incidentId: input.incidentId, fromState: current.state, toState: input.toState },
    });
  });
}

export async function changeIncidentSeverity(db: TransactionalRunner, input: {
  readonly incidentId: string; readonly severity: IncidentSeverity; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, input.incidentId);
    if (current.state === 'CLOSED') throw new IncidentError('INCIDENT_CLOSED');
    if (current.severity === input.severity) throw new IncidentError('INCIDENT_SEVERITY_UNCHANGED');
    await tx.execute(sql`UPDATE incidents SET severity = ${input.severity} WHERE id = ${input.incidentId}::uuid`);
    await writeIncidentEvent(tx, { incidentId: input.incidentId, kind: 'SEVERITY_CHANGED', fromValue: current.severity, toValue: input.severity,
      reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.incident.severity_changed', resourceType: 'incident', resourceId: input.incidentId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, fromSeverity: current.severity, toSeverity: input.severity },
    });
  });
}

export async function changeIncidentCategory(db: TransactionalRunner, input: {
  readonly incidentId: string; readonly category: IncidentCategory; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
  readonly refuse: (current: { readonly state: IncidentState; readonly category: IncidentCategory; readonly boardNotified: boolean; readonly usersNotified: boolean }) => string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, input.incidentId);
    const refusal = input.refuse({ state: current.state, category: current.category, boardNotified: current.board_notified, usersNotified: current.users_notified });
    if (refusal) throw new IncidentError(refusal);
    // The trigger stamps (or removes) the breach clock period with the category.
    await tx.execute(sql`UPDATE incidents SET category = ${input.category} WHERE id = ${input.incidentId}::uuid`);
    await writeIncidentEvent(tx, { incidentId: input.incidentId, kind: 'CATEGORY_CHANGED', fromValue: current.category, toValue: input.category,
      reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.incident.category_changed', resourceType: 'incident', resourceId: input.incidentId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, fromCategory: current.category, toCategory: input.category },
    });
  });
}

export async function addIncidentNote(db: TransactionalRunner, input: {
  readonly incidentId: string; readonly note: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, input.incidentId);
    if (current.state === 'CLOSED') throw new IncidentError('INCIDENT_CLOSED');
    await writeIncidentEvent(tx, { incidentId: input.incidentId, kind: 'NOTE', note: input.note, reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    // The note stays in the timeline; audit records that one was added, never its text.
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.incident.note_added', resourceType: 'incident', resourceId: input.incidentId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode },
    });
  });
}

export async function addIncidentOrganization(db: TransactionalRunner, input: {
  readonly incidentId: string; readonly organizationId: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, input.incidentId);
    if (current.state === 'CLOSED') throw new IncidentError('INCIDENT_CLOSED');
    const organization = await rows(tx, sql`SELECT 1 FROM organizations WHERE id = ${input.organizationId}::uuid AND kind::text IN ('INSTITUTION', 'EMPLOYER')`);
    if (!organization.length) throw new IncidentError('INCIDENT_ORGANIZATION_NOT_FOUND');
    const live = await rows(tx, sql`
      SELECT 1 FROM incident_affected_organizations WHERE incident_id = ${input.incidentId}::uuid AND organization_id = ${input.organizationId}::uuid AND removed_at IS NULL
    `);
    if (live.length) throw new IncidentError('INCIDENT_ORGANIZATION_ALREADY_ADDED');
    await tx.execute(sql`
      INSERT INTO incident_affected_organizations (id, incident_id, organization_id, added_by_user_id)
      VALUES (${randomUUID()}::uuid, ${input.incidentId}::uuid, ${input.organizationId}::uuid, ${input.actorUserId}::uuid)
    `);
    await writeIncidentEvent(tx, { incidentId: input.incidentId, kind: 'ORGANIZATION_ADDED', organizationId: input.organizationId,
      reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.incident.organization_added', resourceType: 'incident', resourceId: input.incidentId,
      organizationId: input.organizationId, correlationId: input.correlationId, context: { reasonCode: input.reasonCode },
    });
  });
}

export async function removeIncidentOrganization(db: TransactionalRunner, input: {
  readonly incidentId: string; readonly organizationId: string; readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, input.incidentId);
    if (current.state === 'CLOSED') throw new IncidentError('INCIDENT_CLOSED');
    const removed = await rows(tx, sql`
      UPDATE incident_affected_organizations SET removed_by_user_id = ${input.actorUserId}::uuid
      WHERE incident_id = ${input.incidentId}::uuid AND organization_id = ${input.organizationId}::uuid AND removed_at IS NULL
      RETURNING id
    `);
    if (!removed.length) throw new IncidentError('INCIDENT_ORGANIZATION_NOT_AFFECTED');
    await writeIncidentEvent(tx, { incidentId: input.incidentId, kind: 'ORGANIZATION_REMOVED', organizationId: input.organizationId,
      reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: 'operations.incident.organization_removed', resourceType: 'incident', resourceId: input.incidentId,
      organizationId: input.organizationId, correlationId: input.correlationId, context: { reasonCode: input.reasonCode },
    });
  });
}

/**
 * Record that a person notified the Data Protection Board (`BOARD`) or the affected people
 * (`USERS`) of a breach, and when. Set once; the time is an operator fact between `detected_at`
 * and the database clock. ONE sends nothing to the Board.
 */
export async function recordIncidentNotification(db: TransactionalRunner, input: {
  readonly incidentId: string; readonly audience: 'BOARD' | 'USERS'; readonly notifiedAt: string; readonly reference?: string | null;
  readonly reasonCode: string; readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockIncident(tx, input.incidentId);
    if (current.state === 'CLOSED') throw new IncidentError('INCIDENT_CLOSED');
    if (current.category !== 'PERSONAL_DATA_BREACH') throw new IncidentError('INCIDENT_NOT_A_BREACH');
    if (input.audience === 'BOARD' && current.board_notified) throw new IncidentError('INCIDENT_BOARD_ALREADY_NOTIFIED');
    if (input.audience === 'USERS' && current.users_notified) throw new IncidentError('INCIDENT_USERS_ALREADY_NOTIFIED');
    const [bounds] = await rows<{ ok: boolean }>(tx, sql`
      SELECT (${input.notifiedAt}::timestamptz <= now() AND ${input.notifiedAt}::timestamptz >= i.detected_at) AS ok
      FROM incidents i WHERE i.id = ${input.incidentId}::uuid
    `);
    if (!bounds?.ok) throw new IncidentError('INCIDENT_NOTIFIED_AT_INVALID');
    if (input.audience === 'BOARD') {
      await tx.execute(sql`
        UPDATE incidents SET board_notified_at = ${input.notifiedAt}::timestamptz, board_notified_by_user_id = ${input.actorUserId}::uuid,
               board_reference = ${input.reference ?? null}
        WHERE id = ${input.incidentId}::uuid
      `);
    } else {
      await tx.execute(sql`
        UPDATE incidents SET users_notified_at = ${input.notifiedAt}::timestamptz, users_notified_by_user_id = ${input.actorUserId}::uuid
        WHERE id = ${input.incidentId}::uuid
      `);
    }
    await writeIncidentEvent(tx, { incidentId: input.incidentId, kind: input.audience === 'BOARD' ? 'BOARD_NOTIFIED' : 'USERS_NOTIFIED',
      reasonCode: input.reasonCode, actorUserId: input.actorUserId, correlationId: input.correlationId });
    await writeIncidentAudit(tx, {
      actorUserId: input.actorUserId, action: input.audience === 'BOARD' ? 'operations.incident.board_notified_recorded' : 'operations.incident.users_notified_recorded',
      resourceType: 'incident', resourceId: input.incidentId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, hasReference: Boolean(input.reference) },
    });
  });
}

/** Audit a read of an incident's detail (§5.2). */
export async function recordIncidentRead(runner: SqlRunner, input: { readonly actorUserId: string; readonly incidentId: string; readonly correlationId: string }): Promise<void> {
  await writeIncidentAudit(runner, { actorUserId: input.actorUserId, action: 'operations.incident.viewed', resourceType: 'incident', resourceId: input.incidentId, correlationId: input.correlationId, context: {} });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface BreachClock {
  readonly hours: number;
  readonly basis: typeof breachClockBasis;
  readonly deadlineAt: string;
  readonly status: BreachClockStatus;
  /** Seconds left on the database clock; 0 once passed, null once the Board was notified. */
  readonly remainingSeconds: number | null;
  readonly boardNotifiedAt: string | null;
  readonly boardNotifiedBy: string | null;
  readonly boardReference: string | null;
  readonly usersNotifiedAt: string | null;
  readonly usersNotifiedBy: string | null;
}

export interface IncidentRow {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly summary: string;
  readonly category: IncidentCategory;
  readonly severity: IncidentSeverity;
  readonly state: IncidentState;
  readonly detectedAt: string;
  readonly declaredAt: string;
  readonly declaredBy: string;
  readonly containedAt: string | null;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly affectedOrganizationsCount: number;
  readonly breachClock: BreachClock | null;
  readonly updatedAt: string;
}

interface IncidentDbRow {
  id: string; title: string; summary: string; category: IncidentCategory; severity: IncidentSeverity; state: IncidentState;
  detected_at: string; declared_at: string; declarer_email: string; contained_at: string | null; resolved_at: string | null;
  closed_at: string | null; affected_count: number; board_clock_hours: number | null; deadline_at: string | null;
  deadline_passed: boolean | null; within_period: boolean | null; remaining_seconds: string | number | null;
  board_notified_at: string | null; board_notifier_email: string | null; board_reference: string | null;
  users_notified_at: string | null; users_notifier_email: string | null; updated_at: string;
}

const ts = (column: SQL): SQL => sql`to_char((${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Microsecond text timestamps: the keyset cursor must not repeat rows declared in one millisecond.
const incidentSelect = sql`
  SELECT i.id, i.title, i.summary, i.category, i.severity, i.state,
         ${ts(sql`i.detected_at`)} AS detected_at, ${ts(sql`i.declared_at`)} AS declared_at, du.email AS declarer_email,
         ${ts(sql`i.contained_at`)} AS contained_at, ${ts(sql`i.resolved_at`)} AS resolved_at, ${ts(sql`i.closed_at`)} AS closed_at,
         (SELECT count(*)::int FROM incident_affected_organizations a WHERE a.incident_id = i.id AND a.removed_at IS NULL) AS affected_count,
         i.board_clock_hours,
         ${ts(sql`i.detected_at + make_interval(hours => i.board_clock_hours)`)} AS deadline_at,
         CASE WHEN i.board_clock_hours IS NULL THEN NULL ELSE now() >= i.detected_at + make_interval(hours => i.board_clock_hours) END AS deadline_passed,
         CASE WHEN i.board_notified_at IS NULL THEN NULL ELSE i.board_notified_at <= i.detected_at + make_interval(hours => i.board_clock_hours) END AS within_period,
         CASE WHEN i.board_clock_hours IS NULL OR i.board_notified_at IS NOT NULL THEN NULL
              ELSE GREATEST(0, floor(extract(epoch FROM (i.detected_at + make_interval(hours => i.board_clock_hours)) - now())))::bigint END AS remaining_seconds,
         ${ts(sql`i.board_notified_at`)} AS board_notified_at, bu.email AS board_notifier_email, i.board_reference,
         ${ts(sql`i.users_notified_at`)} AS users_notified_at, uu.email AS users_notifier_email,
         ${ts(sql`i.updated_at`)} AS updated_at
  FROM incidents i
  JOIN users du ON du.id = i.declared_by_user_id
  LEFT JOIN users bu ON bu.id = i.board_notified_by_user_id
  LEFT JOIN users uu ON uu.id = i.users_notified_by_user_id`;

function mapIncident(row: IncidentDbRow): IncidentRow {
  return {
    id: row.id,
    reference: incidentReference(row.id),
    title: row.title,
    summary: row.summary,
    category: row.category,
    severity: row.severity,
    state: row.state,
    detectedAt: row.detected_at,
    declaredAt: row.declared_at,
    declaredBy: row.declarer_email,
    containedAt: row.contained_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    affectedOrganizationsCount: Number(row.affected_count),
    breachClock: row.board_clock_hours === null || row.deadline_at === null ? null : {
      hours: Number(row.board_clock_hours),
      basis: breachClockBasis,
      deadlineAt: row.deadline_at,
      status: classifyBreachClock({ boardNotified: row.board_notified_at !== null, notifiedWithinPeriod: row.within_period === true, deadlinePassed: row.deadline_passed === true }),
      remainingSeconds: row.remaining_seconds === null ? null : Number(row.remaining_seconds),
      boardNotifiedAt: row.board_notified_at,
      boardNotifiedBy: row.board_notifier_email,
      boardReference: row.board_reference,
      usersNotifiedAt: row.users_notified_at,
      usersNotifiedBy: row.users_notifier_email,
    },
    updatedAt: row.updated_at,
  };
}

export type IncidentView = 'ACTIVE' | 'ALL' | IncidentState;
export interface IncidentCursor { readonly declaredAt: string; readonly id: string }

function viewFilter(view: IncidentView): SQL {
  switch (view) {
    case 'ACTIVE': return sql`i.state <> 'CLOSED'`;
    case 'ALL': return sql`TRUE`;
    default: return sql`i.state = ${view}`;
  }
}

/** The register, newest first, keyset paginated on (declared_at, id). */
export async function listIncidents(runner: SqlRunner, input: {
  readonly view: IncidentView; readonly category?: IncidentCategory; readonly limit: number; readonly cursor?: IncidentCursor;
}): Promise<{ readonly incidents: readonly IncidentRow[]; readonly nextCursor: IncidentCursor | null }> {
  const result = await rows<IncidentDbRow>(runner, sql`
    ${incidentSelect}
    WHERE ${viewFilter(input.view)}
      AND (${input.category ?? null}::text IS NULL OR i.category = ${input.category ?? null}::text)
      AND (${input.cursor?.declaredAt ?? null}::timestamptz IS NULL
           OR (i.declared_at, i.id) < (${input.cursor?.declaredAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
    ORDER BY i.declared_at DESC, i.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = result.slice(0, input.limit).map(mapIncident);
  const last = page[page.length - 1];
  return { incidents: page, nextCursor: result.length > input.limit && last ? { declaredAt: last.declaredAt, id: last.id } : null };
}

export interface IncidentSummary {
  readonly open: number;
  readonly openBreaches: number;
  readonly breachClocksRunning: number;
  readonly breachClocksOverdue: number;
}

/** Counts for the register's header, in one bounded query on the database clock. */
export async function summariseIncidents(runner: SqlRunner): Promise<IncidentSummary> {
  const [row] = await rows<{ open: number; open_breaches: number; running: number; overdue: number }>(runner, sql`
    SELECT count(*) FILTER (WHERE state <> 'CLOSED')::int AS open,
           count(*) FILTER (WHERE state <> 'CLOSED' AND category = 'PERSONAL_DATA_BREACH')::int AS open_breaches,
           count(*) FILTER (WHERE board_clock_hours IS NOT NULL AND board_notified_at IS NULL
                              AND now() < detected_at + make_interval(hours => board_clock_hours))::int AS running,
           count(*) FILTER (WHERE board_clock_hours IS NOT NULL AND board_notified_at IS NULL
                              AND now() >= detected_at + make_interval(hours => board_clock_hours))::int AS overdue
    FROM incidents
  `);
  return { open: Number(row?.open ?? 0), openBreaches: Number(row?.open_breaches ?? 0), breachClocksRunning: Number(row?.running ?? 0), breachClocksOverdue: Number(row?.overdue ?? 0) };
}

export async function loadIncident(runner: SqlRunner, incidentId: string): Promise<IncidentRow | null> {
  const result = await rows<IncidentDbRow>(runner, sql`${incidentSelect} WHERE i.id = ${incidentId}::uuid`);
  return result[0] ? mapIncident(result[0]) : null;
}

export interface IncidentTimelineEntry {
  readonly kind: IncidentEventKind;
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly organizationName: string | null;
  readonly noticeId: string | null;
  readonly note: string | null;
  readonly reasonCode: string;
  readonly actor: string;
  readonly occurredAt: string;
}

/** The timeline, oldest first; bounded (an incident with more than 500 events shows the first 500). */
export async function loadIncidentTimeline(runner: SqlRunner, incidentId: string): Promise<readonly IncidentTimelineEntry[]> {
  const result = await rows<{ event_kind: IncidentEventKind; from_value: string | null; to_value: string | null; organization_name: string | null;
    notice_id: string | null; note: string | null; reason_code: string; actor_email: string; occurred_at: string }>(runner, sql`
    SELECT e.event_kind, e.from_value, e.to_value, o.legal_name AS organization_name, e.notice_id, e.note, e.reason_code,
           u.email AS actor_email, ${ts(sql`e.occurred_at`)} AS occurred_at
    FROM incident_events e
    JOIN users u ON u.id = e.actor_user_id
    LEFT JOIN organizations o ON o.id = e.organization_id
    WHERE e.incident_id = ${incidentId}::uuid
    ORDER BY e.occurred_at, e.id
    LIMIT 500
  `);
  return result.map((row) => ({
    kind: row.event_kind, fromValue: row.from_value, toValue: row.to_value, organizationName: row.organization_name, noticeId: row.notice_id,
    note: row.note, reasonCode: row.reason_code, actor: row.actor_email, occurredAt: row.occurred_at,
  }));
}

export interface IncidentOrganizationEntry {
  readonly organizationId: string;
  readonly name: string;
  readonly kind: 'INSTITUTION' | 'EMPLOYER';
  readonly addedAt: string;
  readonly removedAt: string | null;
}

export async function loadIncidentOrganizations(runner: SqlRunner, incidentId: string): Promise<readonly IncidentOrganizationEntry[]> {
  const result = await rows<{ organization_id: string; legal_name: string; kind: 'INSTITUTION' | 'EMPLOYER'; added_at: string; removed_at: string | null }>(runner, sql`
    SELECT a.organization_id, o.legal_name, o.kind::text AS kind, ${ts(sql`a.added_at`)} AS added_at, ${ts(sql`a.removed_at`)} AS removed_at
    FROM incident_affected_organizations a JOIN organizations o ON o.id = a.organization_id
    WHERE a.incident_id = ${incidentId}::uuid
    ORDER BY (a.removed_at IS NULL) DESC, o.legal_name, a.added_at
    LIMIT 500
  `);
  return result.map((row) => ({ organizationId: row.organization_id, name: row.legal_name, kind: row.kind, addedAt: row.added_at, removedAt: row.removed_at }));
}

/** Colleges and employers an operator can add to an incident, by name; bounded, never a full list. */
export async function searchIncidentOrganizations(runner: SqlRunner, query: string): Promise<readonly { readonly id: string; readonly name: string; readonly kind: string }[]> {
  const pattern = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return (await rows<{ id: string; legal_name: string; kind: string }>(runner, sql`
    SELECT id, legal_name, kind::text AS kind FROM organizations
    WHERE kind::text IN ('INSTITUTION', 'EMPLOYER') AND legal_name ILIKE ${pattern}
    ORDER BY legal_name, id LIMIT 20
  `)).map((row) => ({ id: row.id, name: row.legal_name, kind: row.kind }));
}

