/**
 * Support desk persistence (OPS-05, migration 0043): support cases, their history, and
 * the minimised account view operators use while a person is on the phone.
 *
 * Every write puts its history row, its audit row and (where another system may care)
 * its outbox event in one transaction. Reads that show personal data are audited by the
 * caller through `recordSupportRead`. Contacts leave this module masked, except through
 * `revealSupportAccountContact`, which audits the reveal in the same transaction.
 *
 * Design: docs/architecture/support-cases-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  maskEmail,
  maskPhone,
  type SupportCaseCategory,
  type SupportCaseChannel,
  type SupportCaseSeverity,
  type SupportCaseState,
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

async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

export class SupportDeskError extends Error {
  constructor(readonly code:
    | 'SUPPORT_CASE_NOT_FOUND'
    | 'SUPPORT_CASE_TRANSITION_NOT_ALLOWED'
    | 'SUPPORT_CASE_CLOSED'
    | 'SUPPORT_SUBJECT_NOT_FOUND'
    | 'SUPPORT_ORGANIZATION_NOT_FOUND'
    | 'SUPPORT_ACCOUNT_NOT_FOUND'
    | 'SUPPORT_ACCOUNT_DELETED'
    | 'SUPPORT_CASE_REJECTED') {
    super(code);
    this.name = 'SupportDeskError';
  }
}

/** The text a privacy deletion puts in place of a case summary; the 0043 CHECK names it. */
export const redactedSupportSummary = 'Summary removed on privacy deletion.';

// ---------------------------------------------------------------------------
// Audit and outbox
// ---------------------------------------------------------------------------

async function audit(runner: SqlRunner, input: {
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

async function outbox(runner: SqlRunner, input: {
  readonly caseId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, aggregateType: 'support_case', aggregateId: input.caseId, eventType: input.eventType, payload: input.payload, actorUserId: input.actorUserId, correlationId: input.correlationId, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, 'support_case', ${input.caseId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actorUserId}::uuid, ${input.correlationId})
  `);
}

/**
 * Audit a read of personal data (§5.2: `*.viewed`). Written on its own: a read has no
 * transaction to join, and a failure to audit fails the read.
 */
export async function recordSupportRead(runner: SqlRunner, input: {
  readonly actorUserId: string; readonly action: 'operations.support_account.viewed' | 'operations.support_account.searched' | 'operations.support_case.viewed';
  readonly resourceType: 'support_account' | 'support_case'; readonly resourceId: string; readonly correlationId: string;
  readonly context?: Record<string, unknown>;
}): Promise<void> {
  await audit(runner, { ...input, context: input.context ?? {} });
}

// ---------------------------------------------------------------------------
// Cases: writing
// ---------------------------------------------------------------------------

export interface OpenSupportCaseInput {
  readonly channel: SupportCaseChannel;
  readonly category: SupportCaseCategory;
  readonly severity: SupportCaseSeverity;
  readonly summary: string;
  readonly reasonCode: string;
  readonly subjectUserId?: string | null;
  readonly organizationId?: string | null;
  readonly assignToUserId?: string | null;
  readonly actorUserId: string;
  readonly correlationId: string;
}

/** Log a case, its OPENED event (and ASSIGNED, when assigned at once), audit and outbox. */
export async function openSupportCase(db: TransactionalRunner, input: OpenSupportCaseInput): Promise<{ readonly id: string }> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    if (input.subjectUserId) {
      const subject = await rows(tx, sql`SELECT 1 FROM users WHERE id = ${input.subjectUserId}::uuid`);
      if (!subject.length) throw new SupportDeskError('SUPPORT_SUBJECT_NOT_FOUND');
    }
    if (input.organizationId) {
      const organization = await rows(tx, sql`SELECT 1 FROM organizations WHERE id = ${input.organizationId}::uuid`);
      if (!organization.length) throw new SupportDeskError('SUPPORT_ORGANIZATION_NOT_FOUND');
    }
    // opened_at, sla_due_at and version are stamped by the 0043 trigger.
    await tx.execute(sql`
      INSERT INTO support_cases (id, organization_id, subject_user_id, channel, category, severity, summary,
                                 assigned_to_user_id, opened_by_user_id, opening_reason_code)
      VALUES (${id}::uuid, ${input.organizationId ?? null}::uuid, ${input.subjectUserId ?? null}::uuid, ${input.channel},
              ${input.category}, ${input.severity}, ${input.summary}, ${input.assignToUserId ?? null}::uuid,
              ${input.actorUserId}::uuid, ${input.reasonCode})
    `);
    await tx.execute(sql`
      INSERT INTO support_case_events (id, case_id, event_kind, to_state, reason_code, actor_user_id, correlation_id)
      VALUES (${randomUUID()}::uuid, ${id}::uuid, 'OPENED', 'OPEN', ${input.reasonCode}, ${input.actorUserId}::uuid, ${input.correlationId})
    `);
    if (input.assignToUserId) {
      await tx.execute(sql`
        INSERT INTO support_case_events (id, case_id, event_kind, assignee_user_id, reason_code, actor_user_id, correlation_id)
        VALUES (${randomUUID()}::uuid, ${id}::uuid, 'ASSIGNED', ${input.assignToUserId}::uuid, 'TAKE_OWNERSHIP', ${input.actorUserId}::uuid, ${input.correlationId})
      `);
    }
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.support_case.opened', resourceType: 'support_case', resourceId: id,
      organizationId: input.organizationId ?? null, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, channel: input.channel, category: input.category, severity: input.severity, hasSubject: Boolean(input.subjectUserId), assigned: Boolean(input.assignToUserId) },
    });
    await outbox(tx, {
      caseId: id, eventType: 'support_case.opened', actorUserId: input.actorUserId, correlationId: input.correlationId,
      payload: { caseId: id, category: input.category, severity: input.severity, channel: input.channel },
    });
  });
  return { id };
}

async function lockCase(tx: SqlRunner, caseId: string): Promise<{ state: SupportCaseState; organization_id: string | null }> {
  const found = await rows<{ state: SupportCaseState; organization_id: string | null }>(tx, sql`
    SELECT state, organization_id FROM support_cases WHERE id = ${caseId}::uuid FOR UPDATE
  `);
  if (!found[0]) throw new SupportDeskError('SUPPORT_CASE_NOT_FOUND');
  return found[0];
}

/**
 * Move a case to another state. The caller has already checked the transition and the
 * reason against the table in packages/authorization; the row is re-checked here under
 * lock, and the 0043 trigger checks it a third time and stamps the resolution times.
 */
export async function transitionSupportCase(db: TransactionalRunner, input: {
  readonly caseId: string; readonly toState: SupportCaseState; readonly reasonCode: string;
  readonly note?: string | null; readonly actorUserId: string; readonly correlationId: string;
  readonly allowed: (from: SupportCaseState) => boolean;
}): Promise<{ readonly fromState: SupportCaseState }> {
  return db.transaction(async (tx) => {
    const current = await lockCase(tx, input.caseId);
    if (!input.allowed(current.state)) throw new SupportDeskError('SUPPORT_CASE_TRANSITION_NOT_ALLOWED');
    await tx.execute(sql`UPDATE support_cases SET state = ${input.toState} WHERE id = ${input.caseId}::uuid`);
    await tx.execute(sql`
      INSERT INTO support_case_events (id, case_id, event_kind, from_state, to_state, note, reason_code, actor_user_id, correlation_id)
      VALUES (${randomUUID()}::uuid, ${input.caseId}::uuid, 'STATE_CHANGED', ${current.state}, ${input.toState}, ${input.note ?? null},
              ${input.reasonCode}, ${input.actorUserId}::uuid, ${input.correlationId})
    `);
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.support_case.transitioned', resourceType: 'support_case', resourceId: input.caseId,
      organizationId: current.organization_id, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, fromState: current.state, toState: input.toState },
    });
    await outbox(tx, {
      caseId: input.caseId, eventType: 'support_case.state_changed', actorUserId: input.actorUserId, correlationId: input.correlationId,
      payload: { caseId: input.caseId, fromState: current.state, toState: input.toState },
    });
    return { fromState: current.state };
  });
}

export async function addSupportCaseNote(db: TransactionalRunner, input: {
  readonly caseId: string; readonly note: string; readonly reasonCode: string; readonly linkedCorrelationId?: string | null;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockCase(tx, input.caseId);
    if (current.state === 'CLOSED') throw new SupportDeskError('SUPPORT_CASE_CLOSED');
    await tx.execute(sql`
      INSERT INTO support_case_events (id, case_id, event_kind, note, linked_correlation_id, reason_code, actor_user_id, correlation_id)
      VALUES (${randomUUID()}::uuid, ${input.caseId}::uuid, 'NOTE', ${input.note}, ${input.linkedCorrelationId ?? null},
              ${input.reasonCode}, ${input.actorUserId}::uuid, ${input.correlationId})
    `);
    // The note itself stays in the case history, where a deletion can redact it; the
    // audit row records that a note was added, never its text.
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.support_case.note_added', resourceType: 'support_case', resourceId: input.caseId,
      organizationId: current.organization_id, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, linkedCorrelation: Boolean(input.linkedCorrelationId) },
    });
  });
}

export async function assignSupportCase(db: TransactionalRunner, input: {
  readonly caseId: string; readonly assigneeUserId: string | null; readonly reasonCode: string;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockCase(tx, input.caseId);
    if (current.state === 'CLOSED') throw new SupportDeskError('SUPPORT_CASE_CLOSED');
    await tx.execute(sql`UPDATE support_cases SET assigned_to_user_id = ${input.assigneeUserId}::uuid WHERE id = ${input.caseId}::uuid`);
    await tx.execute(sql`
      INSERT INTO support_case_events (id, case_id, event_kind, assignee_user_id, reason_code, actor_user_id, correlation_id)
      VALUES (${randomUUID()}::uuid, ${input.caseId}::uuid, 'ASSIGNED', ${input.assigneeUserId}::uuid, ${input.reasonCode},
              ${input.actorUserId}::uuid, ${input.correlationId})
    `);
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.support_case.assigned', resourceType: 'support_case', resourceId: input.caseId,
      organizationId: current.organization_id, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, unassigned: input.assigneeUserId === null },
    });
    await outbox(tx, {
      caseId: input.caseId, eventType: 'support_case.assigned', actorUserId: input.actorUserId, correlationId: input.correlationId,
      payload: input.assigneeUserId ? { caseId: input.caseId, assigneeUserId: input.assigneeUserId } : { caseId: input.caseId },
    });
  });
}

// ---------------------------------------------------------------------------
// Cases: reading
// ---------------------------------------------------------------------------

export type SupportCaseView = 'ACTIVE' | 'ALL' | SupportCaseState;

export interface SupportCaseListFilters {
  readonly view: SupportCaseView;
  readonly severity?: SupportCaseSeverity;
  readonly category?: SupportCaseCategory;
  readonly assignee?: 'ME' | 'UNASSIGNED';
  readonly subjectUserId?: string;
  readonly overdueOnly?: boolean;
}

export interface SupportCaseCursor { readonly openedAt: string; readonly id: string }

export interface SupportCaseRow {
  readonly id: string;
  readonly reference: string;
  readonly channel: SupportCaseChannel;
  readonly category: SupportCaseCategory;
  readonly severity: SupportCaseSeverity;
  readonly state: SupportCaseState;
  readonly summary: string;
  readonly summaryRedacted: boolean;
  readonly organization: { readonly id: string; readonly name: string } | null;
  readonly subject: { readonly userId: string; readonly maskedEmail: string | null } | null;
  readonly subjectDetached: boolean;
  readonly assignee: { readonly userId: string; readonly email: string } | null;
  readonly openedBy: { readonly email: string };
  readonly openedAt: string;
  readonly slaDueAt: string;
  readonly overdue: boolean;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
}

interface CaseDbRow {
  id: string; channel: SupportCaseChannel; category: SupportCaseCategory; severity: SupportCaseSeverity; state: SupportCaseState;
  summary: string; summary_redacted_at: Date | null; organization_id: string | null; organization_name: string | null;
  subject_user_id: string | null; subject_email: string | null; subject_detached_at: Date | null;
  assigned_to_user_id: string | null; assignee_email: string | null; opener_email: string;
  opened_at: string; sla_due_at: string; overdue: boolean; resolved_at: Date | null; closed_at: Date | null;
}

// Microsecond text timestamps for the keyset cursor: a millisecond cursor repeats rows
// opened in the same millisecond (the OPS-01 staff paging bug).
const caseSelect = sql`
  SELECT c.id, c.channel, c.category, c.severity, c.state, c.summary, c.summary_redacted_at,
         c.organization_id, o.legal_name AS organization_name,
         c.subject_user_id, su.email AS subject_email, c.subject_detached_at,
         c.assigned_to_user_id, au.email AS assignee_email, ou.email AS opener_email,
         to_char(c.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opened_at,
         to_char(c.sla_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sla_due_at,
         (c.state NOT IN ('RESOLVED', 'CLOSED') AND now() > c.sla_due_at) AS overdue,
         c.resolved_at, c.closed_at
  FROM support_cases c
  LEFT JOIN organizations o ON o.id = c.organization_id
  LEFT JOIN users su ON su.id = c.subject_user_id
  LEFT JOIN users au ON au.id = c.assigned_to_user_id
  JOIN users ou ON ou.id = c.opened_by_user_id`;

/** A case reference an operator can read out: derived from the id, never a second identifier. */
export function supportCaseReference(id: string): string {
  return `SC-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function mapCase(row: CaseDbRow): SupportCaseRow {
  return {
    id: row.id,
    reference: supportCaseReference(row.id),
    channel: row.channel,
    category: row.category,
    severity: row.severity,
    state: row.state,
    summary: row.summary,
    summaryRedacted: row.summary_redacted_at !== null,
    organization: row.organization_id ? { id: row.organization_id, name: row.organization_name ?? 'NA' } : null,
    subject: row.subject_user_id ? { userId: row.subject_user_id, maskedEmail: maskEmail(row.subject_email) } : null,
    subjectDetached: row.subject_detached_at !== null,
    assignee: row.assigned_to_user_id ? { userId: row.assigned_to_user_id, email: row.assignee_email ?? 'NA' } : null,
    openedBy: { email: row.opener_email },
    openedAt: row.opened_at,
    slaDueAt: row.sla_due_at,
    overdue: row.overdue,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
  };
}

function viewFilter(view: SupportCaseView): SQL {
  switch (view) {
    case 'ALL': return sql`TRUE`;
    case 'ACTIVE': return sql`c.state IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER')`;
    default: return sql`c.state = ${view}`;
  }
}

/** The queue, newest first, keyset paginated on (opened_at, id). */
export async function listSupportCases(runner: SqlRunner, input: {
  readonly filters: SupportCaseListFilters; readonly viewerUserId: string; readonly limit: number; readonly cursor?: SupportCaseCursor;
}): Promise<{ readonly cases: readonly SupportCaseRow[]; readonly nextCursor: SupportCaseCursor | null }> {
  const f = input.filters;
  const result = await rows<CaseDbRow>(runner, sql`
    ${caseSelect}
    WHERE ${viewFilter(f.view)}
      AND (${f.severity ?? null}::text IS NULL OR c.severity = ${f.severity ?? null})
      AND (${f.category ?? null}::text IS NULL OR c.category = ${f.category ?? null})
      AND (${f.assignee ?? null}::text IS NULL
           OR (${f.assignee ?? null} = 'ME' AND c.assigned_to_user_id = ${input.viewerUserId}::uuid)
           OR (${f.assignee ?? null} = 'UNASSIGNED' AND c.assigned_to_user_id IS NULL))
      AND (${f.subjectUserId ?? null}::uuid IS NULL OR c.subject_user_id = ${f.subjectUserId ?? null}::uuid)
      AND (NOT ${f.overdueOnly ?? false}::boolean OR (c.state NOT IN ('RESOLVED', 'CLOSED') AND now() > c.sla_due_at))
      AND (${input.cursor?.openedAt ?? null}::timestamptz IS NULL
           OR (c.opened_at, c.id) < (${input.cursor?.openedAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
    ORDER BY c.opened_at DESC, c.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = result.slice(0, input.limit).map(mapCase);
  const last = page[page.length - 1];
  return { cases: page, nextCursor: result.length > input.limit && last ? { openedAt: last.openedAt, id: last.id } : null };
}

/** Queue counts computed in SQL (bounded: one grouped scan of the unfinished cases). */
export async function summariseSupportCases(runner: SqlRunner, viewerUserId: string): Promise<{
  readonly open: number; readonly inProgress: number; readonly waitingOnCustomer: number;
  readonly overdue: number; readonly unassigned: number; readonly mine: number;
}> {
  const [row] = await rows<Record<string, number>>(runner, sql`
    SELECT count(*) FILTER (WHERE state = 'OPEN')::int AS open,
           count(*) FILTER (WHERE state = 'IN_PROGRESS')::int AS in_progress,
           count(*) FILTER (WHERE state = 'WAITING_ON_CUSTOMER')::int AS waiting,
           count(*) FILTER (WHERE now() > sla_due_at)::int AS overdue,
           count(*) FILTER (WHERE assigned_to_user_id IS NULL)::int AS unassigned,
           count(*) FILTER (WHERE assigned_to_user_id = ${viewerUserId}::uuid)::int AS mine
    FROM support_cases WHERE state IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER')
  `);
  return {
    open: Number(row?.open ?? 0), inProgress: Number(row?.in_progress ?? 0), waitingOnCustomer: Number(row?.waiting ?? 0),
    overdue: Number(row?.overdue ?? 0), unassigned: Number(row?.unassigned ?? 0), mine: Number(row?.mine ?? 0),
  };
}

export interface SupportCaseEventRow {
  readonly id: string;
  readonly kind: 'OPENED' | 'STATE_CHANGED' | 'NOTE' | 'ASSIGNED';
  readonly fromState: SupportCaseState | null;
  readonly toState: SupportCaseState | null;
  readonly assignee: { readonly email: string } | null;
  readonly note: string | null;
  readonly noteRedacted: boolean;
  readonly linkedCorrelationId: string | null;
  readonly reasonCode: string;
  readonly actor: { readonly email: string };
  readonly correlationId: string;
  readonly occurredAt: string;
}

export async function loadSupportCase(runner: SqlRunner, caseId: string): Promise<(SupportCaseRow & { readonly events: readonly SupportCaseEventRow[] }) | null> {
  const [header] = await rows<CaseDbRow>(runner, sql`${caseSelect} WHERE c.id = ${caseId}::uuid`);
  if (!header) return null;
  const events = await rows<{
    id: string; event_kind: SupportCaseEventRow['kind']; from_state: SupportCaseState | null; to_state: SupportCaseState | null;
    assignee_email: string | null; assignee_user_id: string | null; note: string | null; redacted_at: Date | null;
    linked_correlation_id: string | null; reason_code: string; actor_email: string; correlation_id: string; occurred_at: string;
  }>(runner, sql`
    SELECT e.id, e.event_kind, e.from_state, e.to_state, e.assignee_user_id, au.email AS assignee_email, e.note, e.redacted_at,
           e.linked_correlation_id, e.reason_code, ac.email AS actor_email, e.correlation_id,
           to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
    FROM support_case_events e
    JOIN users ac ON ac.id = e.actor_user_id
    LEFT JOIN users au ON au.id = e.assignee_user_id
    WHERE e.case_id = ${caseId}::uuid
    ORDER BY e.occurred_at, e.id
  `);
  return {
    ...mapCase(header),
    events: events.map((event) => ({
      id: event.id,
      kind: event.event_kind,
      fromState: event.from_state,
      toState: event.to_state,
      assignee: event.assignee_user_id ? { email: event.assignee_email ?? 'NA' } : null,
      note: event.note,
      noteRedacted: event.redacted_at !== null,
      linkedCorrelationId: event.linked_correlation_id,
      reasonCode: event.reason_code,
      actor: { email: event.actor_email },
      correlationId: event.correlation_id,
      occurredAt: event.occurred_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Account lookup (minimised)
// ---------------------------------------------------------------------------

export interface SupportAccountCursor { readonly createdAt: string; readonly id: string }

export interface SupportAccountSummaryRow {
  readonly userId: string;
  readonly maskedEmail: string | null;
  readonly state: string;
  readonly identityLinked: boolean;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly membershipCount: number;
}

/**
 * Find accounts by an address the caller reads out (exact, case-insensitive), by part of
 * one (three characters or more), or by the account's id. Results are masked.
 */
export async function searchSupportAccounts(runner: SqlRunner, input: {
  readonly query: { readonly kind: 'EMAIL' | 'PARTIAL' | 'ID'; readonly value: string };
  readonly limit: number; readonly cursor?: SupportAccountCursor;
}): Promise<{ readonly accounts: readonly SupportAccountSummaryRow[]; readonly nextCursor: SupportAccountCursor | null }> {
  const { kind, value } = input.query;
  const match = kind === 'EMAIL' ? sql`lower(u.email) = lower(${value})`
    : kind === 'ID' ? sql`u.id = ${value}::uuid`
      : sql`strpos(lower(u.email), lower(${value})) > 0`;
  const result = await rows<{
    id: string; email: string; state: string; identity_linked: boolean; anonymised: boolean; created_at: string; membership_count: number;
  }>(runner, sql`
    SELECT u.id, u.email, u.state::text AS state, u.external_subject IS NOT NULL AS identity_linked,
           u.anonymised_at IS NOT NULL AS anonymised,
           to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           (SELECT count(*)::int FROM organization_memberships m WHERE m.user_id = u.id) AS membership_count
    FROM users u
    WHERE ${match}
      AND (${input.cursor?.createdAt ?? null}::timestamptz IS NULL
           OR (u.created_at, u.id) < (${input.cursor?.createdAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = result.slice(0, input.limit).map((row) => ({
    userId: row.id,
    maskedEmail: maskEmail(row.email),
    state: row.state,
    identityLinked: row.identity_linked,
    deleted: row.anonymised,
    createdAt: row.created_at,
    membershipCount: Number(row.membership_count),
  }));
  const last = page[page.length - 1];
  return { accounts: page, nextCursor: result.length > input.limit && last ? { createdAt: last.createdAt, id: last.userId } : null };
}

export interface SupportAccountView {
  readonly account: SupportAccountSummaryRow & { readonly maskedPhone: string | null };
  readonly memberships: readonly { readonly organizationId: string; readonly organizationName: string; readonly organizationKind: string; readonly role: string; readonly state: string }[];
  readonly studentRelationships: readonly { readonly institutionName: string; readonly state: string; readonly effectiveFrom: string | null; readonly effectiveTo: string | null }[];
  readonly invitations: readonly { readonly organizationName: string | null; readonly role: string | null; readonly kind: string; readonly state: string; readonly deliveryState: string | null; readonly createdAt: string; readonly expiresAt: string }[];
  readonly cases: readonly { readonly id: string; readonly reference: string; readonly state: SupportCaseState; readonly category: SupportCaseCategory; readonly openedAt: string }[];
  readonly timeline: readonly { readonly action: string; readonly outcome: string; readonly resourceType: string; readonly occurredAt: string; readonly correlationId: string; readonly byThisUser: boolean }[];
}

/**
 * The account view: identity summary with masked contacts, memberships, student
 * relationships, invitations, support cases and the last 20 audit events by or about
 * the person. Nothing academic, no documents, no assistant conversations, and never an
 * audit event's context payload.
 */
export async function loadSupportAccount(runner: SqlRunner, userId: string): Promise<SupportAccountView | null> {
  const [user] = await rows<{
    id: string; email: string; state: string; identity_linked: boolean; anonymised: boolean; created_at: string;
  }>(runner, sql`
    SELECT u.id, u.email, u.state::text AS state, u.external_subject IS NOT NULL AS identity_linked,
           u.anonymised_at IS NOT NULL AS anonymised,
           to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM users u WHERE u.id = ${userId}::uuid
  `);
  if (!user) return null;

  const [memberships, relationships, invitations, cases, timeline] = await Promise.all([
    rows<{ organization_id: string; legal_name: string; kind: string; role: string; state: string }>(runner, sql`
      SELECT m.organization_id, o.legal_name, o.kind::text AS kind, m.role, m.state::text AS state
      FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ${userId}::uuid
      ORDER BY m.created_at, m.id
    `),
    rows<{ legal_name: string; state: string; effective_from: Date | null; effective_to: Date | null }>(runner, sql`
      SELECT o.legal_name, r.state::text AS state, r.effective_from, r.effective_to
      FROM institution_relationships r JOIN organizations o ON o.id = r.institution_id
      WHERE r.student_user_id = ${userId}::uuid
      ORDER BY r.effective_from, r.id
    `),
    rows<{ legal_name: string | null; role: string | null; kind: string; state: string; delivery_state: string | null; created_at: Date; expires_at: Date }>(runner, sql`
      SELECT o.legal_name, i.role, i.kind, i.state::text AS state, i.delivery_state, i.created_at, i.expires_at
      FROM invitations i LEFT JOIN organizations o ON o.id = i.organization_id
      WHERE i.student_user_id = ${userId}::uuid OR lower(i.email) = lower(${user.email})
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 20
    `),
    rows<{ id: string; state: SupportCaseState; category: SupportCaseCategory; opened_at: Date }>(runner, sql`
      SELECT id, state, category, opened_at FROM support_cases
      WHERE subject_user_id = ${userId}::uuid
      ORDER BY opened_at DESC, id DESC
      LIMIT 20
    `),
    // Support's own reads of this account are left out so the timeline shows what the
    // person did and what was done to their account, not who looked at it.
    rows<{ action: string; outcome: string; resource_type: string; occurred_at: Date; correlation_id: string; actor_user_id: string }>(runner, sql`
      SELECT action, outcome, resource_type, occurred_at, correlation_id, actor_user_id FROM (
        (SELECT id, action, outcome, resource_type, occurred_at, correlation_id, actor_user_id FROM audit_events
          WHERE actor_user_id = ${userId}::uuid ORDER BY occurred_at DESC LIMIT 20)
        UNION
        (SELECT id, action, outcome, resource_type, occurred_at, correlation_id, actor_user_id FROM audit_events
          WHERE resource_id = ${userId} AND resource_type <> 'support_account' ORDER BY occurred_at DESC LIMIT 20)
      ) recent
      ORDER BY occurred_at DESC, id DESC
      LIMIT 20
    `),
  ]);

  return {
    account: {
      userId: user.id,
      maskedEmail: maskEmail(user.email),
      // ONE records no phone number for any account today; the slot shows NA.
      maskedPhone: maskPhone(null),
      state: user.state,
      identityLinked: user.identity_linked,
      deleted: user.anonymised,
      createdAt: user.created_at,
      membershipCount: memberships.length,
    },
    memberships: memberships.map((row) => ({ organizationId: row.organization_id, organizationName: row.legal_name, organizationKind: row.kind, role: row.role, state: row.state })),
    studentRelationships: relationships.map((row) => ({
      institutionName: row.legal_name, state: row.state,
      effectiveFrom: row.effective_from ? new Date(row.effective_from).toISOString() : null,
      effectiveTo: row.effective_to ? new Date(row.effective_to).toISOString() : null,
    })),
    invitations: invitations.map((row) => ({
      organizationName: row.legal_name, role: row.role, kind: row.kind, state: row.state, deliveryState: row.delivery_state,
      createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
    })),
    cases: cases.map((row) => ({ id: row.id, reference: supportCaseReference(row.id), state: row.state, category: row.category, openedAt: new Date(row.opened_at).toISOString() })),
    timeline: timeline.map((row) => ({
      action: row.action, outcome: row.outcome, resourceType: row.resource_type,
      occurredAt: new Date(row.occurred_at).toISOString(), correlationId: row.correlation_id, byThisUser: row.actor_user_id === userId,
    })),
  };
}

/**
 * The full contact, for an operator who has said why they need it. The audit row is
 * written in the same transaction as the read, so a reveal cannot happen unrecorded.
 */
export async function revealSupportAccountContact(db: TransactionalRunner, input: {
  readonly userId: string; readonly reasonCode: string; readonly caseId?: string | null;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<{ readonly email: string; readonly phone: string | null }> {
  return db.transaction(async (tx) => {
    const [user] = await rows<{ email: string; anonymised: boolean }>(tx, sql`
      SELECT email, anonymised_at IS NOT NULL AS anonymised FROM users WHERE id = ${input.userId}::uuid
    `);
    if (!user) throw new SupportDeskError('SUPPORT_ACCOUNT_NOT_FOUND');
    if (user.anonymised) throw new SupportDeskError('SUPPORT_ACCOUNT_DELETED');
    if (input.caseId) {
      const found = await rows(tx, sql`SELECT 1 FROM support_cases WHERE id = ${input.caseId}::uuid`);
      if (!found.length) throw new SupportDeskError('SUPPORT_CASE_NOT_FOUND');
    }
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.support_account.contact_revealed', resourceType: 'support_account',
      resourceId: input.userId, correlationId: input.correlationId,
      context: { reasonCode: input.reasonCode, fields: ['email', 'phone'], ...(input.caseId ? { caseId: input.caseId } : {}) },
    });
    return { email: user.email, phone: null };
  });
}

// ---------------------------------------------------------------------------
// Privacy deletion
// ---------------------------------------------------------------------------

/**
 * Remove a deleted person from every support case about them (§5.5): the subject link
 * goes, the typed summary is replaced, and every note on those cases is redacted. The
 * rest of each case — organisation, channel, category, severity, states, times, reason
 * codes, references — stays, because it identifies nobody. Returns the number of cases.
 * Safe to run again: a case already detached is no longer linked to the person.
 */
export async function detachSupportCasesForDeletedUser(runner: SqlRunner, subjectUserId: string): Promise<number> {
  const detached = await rows<{ id: string }>(runner, sql`
    UPDATE support_cases
    SET subject_user_id = NULL, subject_detached_at = now(),
        summary = ${redactedSupportSummary}, summary_redacted_at = now()
    WHERE subject_user_id = ${subjectUserId}::uuid
    RETURNING id
  `);
  if (detached.length) {
    await runner.execute(sql`
      UPDATE support_case_events SET note = NULL, redacted_at = now()
      WHERE case_id IN (${sql.join(detached.map((row) => sql`${row.id}::uuid`), sql`, `)})
        AND note IS NOT NULL
    `);
  }
  return detached.length;
}
