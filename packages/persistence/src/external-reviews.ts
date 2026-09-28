/**
 * External faculty review persistence (OPS-10, ADR-037, migration 0066).
 *
 * Why this exists: college faculty review ONE's content drafts, but only what they are assigned,
 * only for a while, and only while they hold the grant and their college membership. This module
 * writes and reads the CONTENT_REVIEW_EXTERNAL grant (on `membership_capabilities`, as 0039
 * allows) and `external_review_assignments`: an internal reviewer assigns an IN_REVIEW skill,
 * question or lesson revision to a granted faculty membership; the faculty member sees a
 * whitelisted view of that revision while the assignment is open and records an advisory
 * decision. Nothing here moves a revision along the content lifecycle or publishes anything.
 *
 * Every write puts its audit row and outbox event in its own transaction. The pure rules live in
 * packages/authorization (who, reasons, conflicts) and packages/career-readiness (what the
 * faculty member is shown); the 0066 trigger repeats the access rules so a second writer cannot
 * skip them.
 *
 * Design: docs/architecture/external-review-assignments-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { externalReviewContent, externalReviewTitle, type ExternalReviewContent } from '@planthepath/career-readiness';
import {
  externalReviewGrantRevokedReason,
  externalReviewStatus,
  type ExternalReviewDecision,
  type ExternalReviewEntityType,
  type ExternalReviewerTarget,
  type ExternalReviewRefusal,
  type ExternalReviewStatus,
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

export type ExternalReviewErrorCode =
  | 'EXTERNAL_REVIEW_NOT_FOUND'
  | 'EXTERNAL_REVIEWER_NOT_FOUND'
  | 'EXTERNAL_REVIEWER_ALREADY_GRANTED'
  | 'EXTERNAL_REVIEWER_NOT_GRANTED'
  | 'EXTERNAL_REVIEW_REVISION_NOT_FOUND'
  | 'EXTERNAL_REVIEW_ALREADY_ASSIGNED'
  | 'EXTERNAL_REVIEW_NOT_OPEN'
  | 'EXTERNAL_REVIEW_EXPIRED'
  | 'EXTERNAL_REVIEW_REJECTED';

export class ExternalReviewError extends Error {
  constructor(readonly code: ExternalReviewErrorCode) {
    super(code);
    this.name = 'ExternalReviewError';
  }
}

/** A refusal from a pure rule, carried out of the transaction as is. */
export class ExternalReviewRefused extends Error {
  constructor(readonly code: ExternalReviewRefusal) {
    super(code);
    this.name = 'ExternalReviewRefused';
  }
}

/** Who acted, and whether through the super admin's break-glass (§5.1: audited as such). */
export interface ExternalReviewActor {
  readonly userId: string;
  readonly breakGlass: boolean;
  readonly correlationId: string;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code
    ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505';
}

function rethrow(error: unknown): never {
  if (error instanceof ExternalReviewError || error instanceof ExternalReviewRefused) throw error;
  if (isUniqueViolation(error)) throw new ExternalReviewError('EXTERNAL_REVIEW_ALREADY_ASSIGNED');
  // Never forward database text; the trigger's refusals all mean "not allowed as asked".
  throw new ExternalReviewError('EXTERNAL_REVIEW_REJECTED');
}

async function audit(runner: SqlRunner, input: {
  readonly actor: ExternalReviewActor; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly organizationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actor.userId, action: input.action, resourceType: input.resourceType, resourceId: input.resourceId, organizationId: input.organizationId, correlationId: input.actor.correlationId });
  const context = { ...input.context, ...(input.actor.breakGlass ? { break_glass: true } : {}) };
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actor.userId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId}, ${input.organizationId}::uuid, 'SUCCESS',
            ${input.actor.correlationId}, ${JSON.stringify(context)}::jsonb)
  `);
}

async function outbox(runner: SqlRunner, input: {
  readonly actor: ExternalReviewActor; readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string;
  readonly organizationId: string; readonly payload: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, aggregateType: input.aggregateType, aggregateId: input.aggregateId, eventType: input.eventType, payload: input.payload, actorUserId: input.actor.userId, organizationId: input.organizationId, correlationId: input.actor.correlationId, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actor.userId}::uuid, ${input.organizationId}::uuid, ${input.actor.correlationId})
  `);
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/**
 * The audit actions that make someone a contributor to a skill, question or lesson revision: every
 * draft save in any of the three editors, and every submission. The same rule the editors apply.
 */
const draftSavedActions = ['operations.content.skill_draft_saved', 'operations.content.question_draft_saved', 'operations.content.lesson_draft_saved'];
const transitionedActions = ['operations.content.skill_transitioned', 'operations.content.question_transitioned', 'operations.content.lesson_transitioned'];

export async function contributorsOfRevision(runner: SqlRunner, revisionId: string, authorUserId: string): Promise<readonly string[]> {
  const found = await rows<{ actor_user_id: string }>(runner, sql`
    SELECT DISTINCT actor_user_id FROM audit_events
    WHERE resource_type = 'content_revision' AND resource_id = ${revisionId} AND actor_user_id IS NOT NULL
      AND (action IN (${sql.join(draftSavedActions.map((action) => sql`${action}`), sql`, `)})
        OR (action IN (${sql.join(transitionedActions.map((action) => sql`${action}`), sql`, `)}) AND context ->> 'toState' = 'IN_REVIEW'))
  `);
  return [...new Set([authorUserId, ...found.map((row) => row.actor_user_id)])];
}

// ---------------------------------------------------------------------------
// Reviewers: the CONTENT_REVIEW_EXTERNAL grant
// ---------------------------------------------------------------------------

export interface ExternalReviewerView {
  readonly membershipId: string;
  readonly email: string;
  readonly institutionId: string;
  readonly institutionName: string;
  readonly role: string;
  readonly state: string;
  readonly grant: { readonly grantedAt: string; readonly reasonCode: string } | null;
  readonly openAssignments: number;
}

interface ReviewerRow {
  membership_id: string; email: string; institution_id: string; institution_name: string; role: string; state: string;
  granted_at: Date | null; reason_code: string | null; open_assignments: number | string;
}

const reviewerSelect = sql`
  SELECT m.id AS membership_id, u.email, o.id AS institution_id, o.legal_name AS institution_name,
         m.role, m.state::text AS state, g.granted_at, g.reason_code,
         (SELECT count(*) FROM external_review_assignments a WHERE a.reviewer_membership_id = m.id AND a.state = 'ASSIGNED') AS open_assignments
  FROM organization_memberships m
  JOIN users u ON u.id = m.user_id
  JOIN organizations o ON o.id = m.organization_id
  LEFT JOIN membership_capabilities g ON g.membership_id = m.id AND g.capability = 'CONTENT_REVIEW_EXTERNAL' AND g.revoked_at IS NULL
  WHERE o.kind = 'INSTITUTION' AND m.role IN ('FACULTY_LECTURER', 'DEPARTMENT_HEAD')
`;

function mapReviewer(row: ReviewerRow): ExternalReviewerView {
  return {
    membershipId: row.membership_id, email: row.email, institutionId: row.institution_id, institutionName: row.institution_name,
    role: row.role, state: row.state,
    grant: row.granted_at ? { grantedAt: iso(row.granted_at)!, reasonCode: row.reason_code ?? 'NA' } : null,
    openAssignments: Number(row.open_assignments),
  };
}

/**
 * Faculty and department-head memberships of one exact email address (case-insensitive), so an
 * operator can find the person a college has agreed to lend. An exact match, never a search.
 */
export async function findExternalReviewerCandidates(runner: SqlRunner, email: string): Promise<readonly ExternalReviewerView[]> {
  const found = await rows<ReviewerRow>(runner, sql`
    SELECT * FROM (${reviewerSelect}) r WHERE lower(r.email) = lower(${email}) ORDER BY r.institution_name, r.membership_id LIMIT 20
  `);
  return found.map(mapReviewer);
}

/** Every membership holding a live grant, newest grant first, keyset-paginated on the membership. */
export async function listExternalReviewers(runner: SqlRunner, input: { readonly limit: number; readonly after?: string }): Promise<{
  readonly reviewers: readonly ExternalReviewerView[]; readonly nextCursor: string | null;
}> {
  const found = await rows<ReviewerRow>(runner, sql`
    SELECT * FROM (${reviewerSelect}) r
    WHERE r.granted_at IS NOT NULL
      ${input.after ? sql`AND (r.granted_at, r.membership_id) < (
        SELECT g.granted_at, g.membership_id FROM membership_capabilities g
        WHERE g.membership_id = ${input.after}::uuid AND g.capability = 'CONTENT_REVIEW_EXTERNAL' AND g.revoked_at IS NULL)` : sql``}
    ORDER BY r.granted_at DESC, r.membership_id DESC LIMIT ${input.limit + 1}
  `);
  const page = found.slice(0, input.limit).map(mapReviewer);
  return { reviewers: page, nextCursor: found.length > input.limit ? page[page.length - 1]!.membershipId : null };
}

async function lockReviewerTarget(tx: SqlRunner, membershipId: string): Promise<ExternalReviewerTarget & { readonly organizationId: string }> {
  const [row] = await rows<{ user_id: string; role: string; state: string; kind: string; organization_id: string }>(tx, sql`
    SELECT m.user_id, m.role, m.state::text AS state, o.kind::text AS kind, m.organization_id
    FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.id = ${membershipId}::uuid FOR UPDATE OF m
  `);
  if (!row) throw new ExternalReviewError('EXTERNAL_REVIEWER_NOT_FOUND');
  return { userId: row.user_id, role: row.role, state: row.state, organizationKind: row.kind, organizationId: row.organization_id };
}

async function reviewerView(runner: SqlRunner, membershipId: string): Promise<ExternalReviewerView> {
  const [row] = await rows<ReviewerRow>(runner, sql`SELECT * FROM (${reviewerSelect}) r WHERE r.membership_id = ${membershipId}::uuid`);
  if (!row) throw new ExternalReviewError('EXTERNAL_REVIEWER_NOT_FOUND');
  return mapReviewer(row);
}

/** Grant CONTENT_REVIEW_EXTERNAL; `decide` is the pure rule, evaluated against the locked membership. */
export async function grantExternalReviewer(db: TransactionalRunner, input: {
  readonly membershipId: string; readonly reasonCode: string; readonly note: string | null; readonly actor: ExternalReviewActor;
  readonly decide: (target: ExternalReviewerTarget) => ExternalReviewRefusal | null;
}): Promise<ExternalReviewerView> {
  try {
    return await db.transaction(async (tx) => {
      const target = await lockReviewerTarget(tx, input.membershipId);
      const refusal = input.decide(target);
      if (refusal) throw new ExternalReviewRefused(refusal);
      const [held] = await rows<{ id: string }>(tx, sql`
        SELECT id FROM membership_capabilities WHERE membership_id = ${input.membershipId}::uuid AND capability = 'CONTENT_REVIEW_EXTERNAL' AND revoked_at IS NULL
      `);
      if (held) throw new ExternalReviewError('EXTERNAL_REVIEWER_ALREADY_GRANTED');
      await tx.execute(sql`
        INSERT INTO membership_capabilities (id, membership_id, capability, granted_by_user_id, reason_code)
        VALUES (${randomUUID()}::uuid, ${input.membershipId}::uuid, 'CONTENT_REVIEW_EXTERNAL', ${input.actor.userId}::uuid, ${input.reasonCode})
      `);
      await audit(tx, {
        actor: input.actor, action: 'operations.external_reviewer.granted', resourceType: 'organization_membership', resourceId: input.membershipId,
        organizationId: target.organizationId,
        context: { capability: 'CONTENT_REVIEW_EXTERNAL', reasonCode: input.reasonCode, targetUserId: target.userId, targetRole: target.role, ...(input.note ? { note: input.note } : {}) },
      });
      await outbox(tx, {
        actor: input.actor, aggregateType: 'organization_membership', aggregateId: input.membershipId, eventType: 'organization_membership.capability_granted',
        organizationId: target.organizationId, payload: { membershipId: input.membershipId, capability: 'CONTENT_REVIEW_EXTERNAL' },
      });
      return reviewerView(tx, input.membershipId);
    });
  } catch (error) {
    rethrow(error);
  }
}

/** Revoke it, and close the membership's open assignments in the same transaction. */
export async function revokeExternalReviewer(db: TransactionalRunner, input: {
  readonly membershipId: string; readonly reasonCode: string; readonly note: string | null; readonly actor: ExternalReviewActor;
  readonly decide: (target: ExternalReviewerTarget) => ExternalReviewRefusal | null;
}): Promise<ExternalReviewerView & { readonly closedAssignments: number }> {
  try {
    return await db.transaction(async (tx) => {
      const target = await lockReviewerTarget(tx, input.membershipId);
      const refusal = input.decide(target);
      if (refusal) throw new ExternalReviewRefused(refusal);
      const revoked = await rows<{ id: string }>(tx, sql`
        UPDATE membership_capabilities SET revoked_by_user_id = ${input.actor.userId}::uuid, revoked_at = now(), revoked_reason_code = ${input.reasonCode}
        WHERE membership_id = ${input.membershipId}::uuid AND capability = 'CONTENT_REVIEW_EXTERNAL' AND revoked_at IS NULL
        RETURNING id
      `);
      if (!revoked.length) throw new ExternalReviewError('EXTERNAL_REVIEWER_NOT_GRANTED');
      const closed = await rows<{ id: string; content_revision_id: string }>(tx, sql`
        UPDATE external_review_assignments
        SET state = 'REVOKED', revoked_by_user_id = ${input.actor.userId}::uuid, revoked_at = now(), revoked_reason_code = ${externalReviewGrantRevokedReason}
        WHERE reviewer_membership_id = ${input.membershipId}::uuid AND state = 'ASSIGNED'
        RETURNING id, content_revision_id
      `);
      for (const assignment of closed) {
        await audit(tx, {
          actor: input.actor, action: 'operations.external_review.revoked', resourceType: 'external_review_assignment', resourceId: assignment.id,
          organizationId: target.organizationId, context: { revisionId: assignment.content_revision_id, reasonCode: externalReviewGrantRevokedReason },
        });
        await outbox(tx, {
          actor: input.actor, aggregateType: 'external_review_assignment', aggregateId: assignment.id, eventType: 'external_review.revoked',
          organizationId: target.organizationId, payload: { assignmentId: assignment.id, revisionId: assignment.content_revision_id },
        });
      }
      await audit(tx, {
        actor: input.actor, action: 'operations.external_reviewer.revoked', resourceType: 'organization_membership', resourceId: input.membershipId,
        organizationId: target.organizationId,
        context: {
          capability: 'CONTENT_REVIEW_EXTERNAL', reasonCode: input.reasonCode, targetUserId: target.userId, targetRole: target.role,
          closedAssignments: closed.length, ...(input.note ? { note: input.note } : {}),
        },
      });
      await outbox(tx, {
        actor: input.actor, aggregateType: 'organization_membership', aggregateId: input.membershipId, eventType: 'organization_membership.capability_revoked',
        organizationId: target.organizationId, payload: { membershipId: input.membershipId, capability: 'CONTENT_REVIEW_EXTERNAL' },
      });
      return { ...await reviewerView(tx, input.membershipId), closedAssignments: closed.length };
    });
  } catch (error) {
    rethrow(error);
  }
}

// ---------------------------------------------------------------------------
// Revisions that may be assigned
// ---------------------------------------------------------------------------

export interface ReviewableRevisionView {
  readonly revisionId: string;
  readonly entityType: ExternalReviewEntityType;
  readonly stableKey: string;
  readonly title: string;
  readonly revision: number;
  readonly openAssignments: number;
  readonly decisions: { readonly approve: number; readonly requestChanges: number };
}

/** Skill, question and lesson revisions now IN_REVIEW, newest first; `q` matches key or title. */
export async function listReviewableRevisions(runner: SqlRunner, input: { readonly q?: string; readonly limit: number }): Promise<readonly ReviewableRevisionView[]> {
  const pattern = input.q ? `%${input.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
  const found = await rows<{
    id: string; entity_type: ExternalReviewEntityType; revision: number; body: unknown; node_name: string | null;
    open_assignments: number | string; approvals: number | string; changes: number | string;
  }>(runner, sql`
    SELECT c.id, c.entity_type, c.revision, c.body,
           (SELECT n.name FROM taxonomy_nodes n WHERE c.entity_type = 'TOPIC' AND n.id = c.entity_id) AS node_name,
           (SELECT count(*) FROM external_review_assignments a WHERE a.content_revision_id = c.id AND a.state = 'ASSIGNED') AS open_assignments,
           (SELECT count(*) FROM external_review_assignments a WHERE a.content_revision_id = c.id AND a.decision = 'APPROVE') AS approvals,
           (SELECT count(*) FROM external_review_assignments a WHERE a.content_revision_id = c.id AND a.decision = 'REQUEST_CHANGES') AS changes
    FROM content_revisions c
    WHERE c.state = 'IN_REVIEW' AND c.entity_type IN ('TOPIC', 'QUESTION', 'LESSON')
      ${pattern ? sql`AND (c.body ->> 'stableKey' ILIKE ${pattern} OR c.body ->> 'title' ILIKE ${pattern} OR c.body ->> 'name' ILIKE ${pattern} OR c.body ->> 'prompt' ILIKE ${pattern})` : sql``}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ${input.limit}
  `);
  return found.map((row) => ({
    revisionId: row.id, entityType: row.entity_type,
    stableKey: typeof (row.body as Record<string, unknown> | null)?.stableKey === 'string' ? String((row.body as Record<string, unknown>).stableKey) : 'NA',
    title: externalReviewTitle(row.entity_type, row.body, row.node_name ?? ''),
    revision: Number(row.revision), openAssignments: Number(row.open_assignments),
    decisions: { approve: Number(row.approvals), requestChanges: Number(row.changes) },
  }));
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export type ExternalReviewStatusFilter = ExternalReviewStatus;

/** SQL for the derived status, alias `a` = the assignment and `c` = its revision. */
const statusSql = sql`
  CASE WHEN a.state = 'DECIDED' THEN 'DECIDED'
       WHEN a.state = 'REVOKED' THEN 'REVOKED'
       WHEN a.expires_at <= now() THEN 'EXPIRED'
       WHEN c.state <> 'IN_REVIEW' OR c.content_hash <> a.content_hash THEN 'CLOSED'
       ELSE 'OPEN' END
`;

export interface ExternalReviewAssignmentView {
  readonly id: string;
  readonly status: ExternalReviewStatus;
  readonly revision: { readonly id: string; readonly entityType: ExternalReviewEntityType; readonly stableKey: string; readonly title: string; readonly revision: number; readonly state: string };
  readonly reviewer: { readonly membershipId: string; readonly email: string; readonly institutionName: string; readonly role: string; readonly eligible: boolean };
  readonly assignedBy: string;
  readonly assignedAt: string;
  readonly expiresAt: string;
  readonly reasonCode: string;
  readonly decision: { readonly decision: ExternalReviewDecision; readonly reasonCode: string; readonly comment: string | null; readonly decidedAt: string } | null;
  readonly revoked: { readonly reasonCode: string; readonly revokedAt: string } | null;
}

interface AssignmentRow {
  id: string; status: ExternalReviewStatus; revision_id: string; entity_type: ExternalReviewEntityType; body: unknown; node_name: string | null; revision: number;
  revision_state: string; reviewer_membership_id: string; reviewer_email: string; institution_name: string; reviewer_role: string; eligible: boolean;
  assigned_by_email: string; assigned_at: Date; expires_at: Date; reason_code: string; decision: ExternalReviewDecision | null;
  decision_reason_code: string | null; decision_comment: string | null; decided_at: Date | null; revoked_reason_code: string | null; revoked_at: Date | null;
}

const assignmentSelect = sql`
  SELECT a.id, ${statusSql} AS status, c.id AS revision_id, c.entity_type, c.body, c.revision, c.state AS revision_state,
         (SELECT n.name FROM taxonomy_nodes n WHERE c.entity_type = 'TOPIC' AND n.id = c.entity_id) AS node_name,
         a.reviewer_membership_id, ru.email AS reviewer_email, o.legal_name AS institution_name, m.role AS reviewer_role,
         external_review_membership_eligible(a.reviewer_membership_id, a.reviewer_user_id, a.institution_id) AS eligible,
         au.email AS assigned_by_email, a.assigned_at, a.expires_at, a.reason_code, a.decision, a.decision_reason_code, a.decision_comment,
         a.decided_at, a.revoked_reason_code, a.revoked_at
  FROM external_review_assignments a
  JOIN content_revisions c ON c.id = a.content_revision_id
  JOIN organization_memberships m ON m.id = a.reviewer_membership_id
  JOIN users ru ON ru.id = a.reviewer_user_id
  JOIN users au ON au.id = a.assigned_by_user_id
  JOIN organizations o ON o.id = a.institution_id
`;

function mapAssignment(row: AssignmentRow): ExternalReviewAssignmentView {
  const body = row.body as Record<string, unknown> | null;
  return {
    id: row.id, status: row.status,
    revision: {
      id: row.revision_id, entityType: row.entity_type, stableKey: typeof body?.stableKey === 'string' ? body.stableKey : 'NA',
      title: externalReviewTitle(row.entity_type, row.body, row.node_name ?? ''), revision: Number(row.revision), state: row.revision_state,
    },
    reviewer: { membershipId: row.reviewer_membership_id, email: row.reviewer_email, institutionName: row.institution_name, role: row.reviewer_role, eligible: Boolean(row.eligible) },
    assignedBy: row.assigned_by_email, assignedAt: iso(row.assigned_at)!, expiresAt: iso(row.expires_at)!, reasonCode: row.reason_code,
    decision: row.decision ? { decision: row.decision, reasonCode: row.decision_reason_code ?? 'NA', comment: row.decision_comment, decidedAt: iso(row.decided_at)! } : null,
    revoked: row.revoked_at ? { reasonCode: row.revoked_reason_code ?? 'NA', revokedAt: iso(row.revoked_at)! } : null,
  };
}

/** The operator list: newest first, keyset-paginated on (assigned_at, id) through the last id. */
export async function listExternalReviewAssignments(runner: SqlRunner, input: {
  readonly revisionId?: string; readonly status?: ExternalReviewStatusFilter; readonly limit: number; readonly after?: string;
}): Promise<{ readonly assignments: readonly ExternalReviewAssignmentView[]; readonly nextCursor: string | null }> {
  const found = await rows<AssignmentRow>(runner, sql`
    SELECT * FROM (${assignmentSelect}) x
    WHERE TRUE
      ${input.revisionId ? sql`AND x.revision_id = ${input.revisionId}::uuid` : sql``}
      ${input.status ? sql`AND x.status = ${input.status}` : sql``}
      ${input.after ? sql`AND (x.assigned_at, x.id) < (SELECT assigned_at, id FROM external_review_assignments WHERE id = ${input.after}::uuid)` : sql``}
    ORDER BY x.assigned_at DESC, x.id DESC LIMIT ${input.limit + 1}
  `);
  const page = found.slice(0, input.limit).map(mapAssignment);
  return { assignments: page, nextCursor: found.length > input.limit ? page[page.length - 1]!.id : null };
}

export interface ExternalReviewSummary {
  readonly reviewers: number;
  readonly open: number;
  readonly approved: number;
  readonly changesRequested: number;
  readonly expired: number;
}

/** Bounded counts for the operator panel (Appendix 1 §5.7). */
export async function summariseExternalReviews(runner: SqlRunner): Promise<ExternalReviewSummary> {
  const [row] = await rows<Record<string, number | string>>(runner, sql`
    SELECT
      (SELECT count(*) FROM membership_capabilities WHERE capability = 'CONTENT_REVIEW_EXTERNAL' AND revoked_at IS NULL) AS reviewers,
      count(*) FILTER (WHERE x.status = 'OPEN') AS open,
      count(*) FILTER (WHERE x.decision = 'APPROVE') AS approved,
      count(*) FILTER (WHERE x.decision = 'REQUEST_CHANGES') AS changes_requested,
      count(*) FILTER (WHERE x.status = 'EXPIRED') AS expired
    FROM (SELECT ${statusSql} AS status, a.decision FROM external_review_assignments a JOIN content_revisions c ON c.id = a.content_revision_id) x
  `);
  const value = (key: string): number => Number(row?.[key] ?? 0);
  return { reviewers: value('reviewers'), open: value('open'), approved: value('approved'), changesRequested: value('changes_requested'), expired: value('expired') };
}

async function loadAssignmentView(runner: SqlRunner, id: string): Promise<ExternalReviewAssignmentView> {
  const [row] = await rows<AssignmentRow>(runner, sql`SELECT * FROM (${assignmentSelect}) x WHERE x.id = ${id}::uuid`);
  if (!row) throw new ExternalReviewError('EXTERNAL_REVIEW_NOT_FOUND');
  return mapAssignment(row);
}

/**
 * Assign revisions (one, or an item set) to one faculty reviewer, all or none. `refuse` is the pure
 * rule, evaluated per revision against the locked revision, its contributors and the reviewer's
 * eligibility now. The 0066 trigger re-checks state, hash, grant and author.
 */
export async function assignExternalReviews(db: TransactionalRunner, input: {
  readonly revisionIds: readonly string[]; readonly reviewerMembershipId: string; readonly days: number; readonly reasonCode: string;
  readonly actor: ExternalReviewActor;
  readonly refuse: (current: { readonly reviewerUserId: string; readonly reviewerEligible: boolean; readonly revisionState: string; readonly contributorUserIds: readonly string[] }) => ExternalReviewRefusal | null;
}): Promise<readonly ExternalReviewAssignmentView[]> {
  try {
    return await db.transaction(async (tx) => {
      const [reviewer] = await rows<{ user_id: string; organization_id: string; eligible: boolean }>(tx, sql`
        SELECT m.user_id, m.organization_id, external_review_membership_eligible(m.id, m.user_id, m.organization_id) AS eligible
        FROM organization_memberships m WHERE m.id = ${input.reviewerMembershipId}::uuid FOR SHARE
      `);
      if (!reviewer) throw new ExternalReviewError('EXTERNAL_REVIEWER_NOT_FOUND');
      const created: string[] = [];
      for (const revisionId of input.revisionIds) {
        const [revision] = await rows<{ id: string; entity_type: string; state: string; content_hash: string; author_user_id: string }>(tx, sql`
          SELECT id, entity_type, state, content_hash, author_user_id FROM content_revisions
          WHERE id = ${revisionId}::uuid AND entity_type IN ('TOPIC', 'QUESTION', 'LESSON') FOR SHARE
        `);
        if (!revision) throw new ExternalReviewError('EXTERNAL_REVIEW_REVISION_NOT_FOUND');
        const refusal = input.refuse({
          reviewerUserId: reviewer.user_id, reviewerEligible: Boolean(reviewer.eligible), revisionState: revision.state,
          contributorUserIds: await contributorsOfRevision(tx, revision.id, revision.author_user_id),
        });
        if (refusal) throw new ExternalReviewRefused(refusal);
        const [open] = await rows<{ id: string }>(tx, sql`
          SELECT id FROM external_review_assignments WHERE content_revision_id = ${revision.id}::uuid AND reviewer_user_id = ${reviewer.user_id}::uuid AND state = 'ASSIGNED'
        `);
        if (open) throw new ExternalReviewError('EXTERNAL_REVIEW_ALREADY_ASSIGNED');
        const id = randomUUID();
        await tx.execute(sql`
          INSERT INTO external_review_assignments (id, content_revision_id, content_hash, reviewer_membership_id, reviewer_user_id, institution_id,
                                                   assigned_by_user_id, expires_at, reason_code)
          VALUES (${id}::uuid, ${revision.id}::uuid, ${revision.content_hash}, ${input.reviewerMembershipId}::uuid, ${reviewer.user_id}::uuid,
                  ${reviewer.organization_id}::uuid, ${input.actor.userId}::uuid, now() + make_interval(days => ${input.days}), ${input.reasonCode})
        `);
        await audit(tx, {
          actor: input.actor, action: 'operations.external_review.assigned', resourceType: 'external_review_assignment', resourceId: id,
          organizationId: reviewer.organization_id,
          context: { revisionId: revision.id, entityType: revision.entity_type, reviewerMembershipId: input.reviewerMembershipId, days: input.days, reasonCode: input.reasonCode },
        });
        await outbox(tx, {
          actor: input.actor, aggregateType: 'external_review_assignment', aggregateId: id, eventType: 'external_review.assigned',
          organizationId: reviewer.organization_id, payload: { assignmentId: id, revisionId: revision.id, entityType: revision.entity_type },
        });
        created.push(id);
      }
      const views: ExternalReviewAssignmentView[] = [];
      for (const id of created) views.push(await loadAssignmentView(tx, id));
      return views;
    });
  } catch (error) {
    rethrow(error);
  }
}

/** Withdraw one open assignment. */
export async function revokeExternalReviewAssignment(db: TransactionalRunner, input: {
  readonly assignmentId: string; readonly reasonCode: string; readonly actor: ExternalReviewActor;
}): Promise<ExternalReviewAssignmentView> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await rows<{ state: string; content_revision_id: string; institution_id: string }>(tx, sql`
        SELECT state, content_revision_id, institution_id FROM external_review_assignments WHERE id = ${input.assignmentId}::uuid FOR UPDATE
      `);
      if (!row) throw new ExternalReviewError('EXTERNAL_REVIEW_NOT_FOUND');
      if (row.state !== 'ASSIGNED') throw new ExternalReviewError('EXTERNAL_REVIEW_NOT_OPEN');
      await tx.execute(sql`
        UPDATE external_review_assignments
        SET state = 'REVOKED', revoked_by_user_id = ${input.actor.userId}::uuid, revoked_at = now(), revoked_reason_code = ${input.reasonCode}
        WHERE id = ${input.assignmentId}::uuid
      `);
      await audit(tx, {
        actor: input.actor, action: 'operations.external_review.revoked', resourceType: 'external_review_assignment', resourceId: input.assignmentId,
        organizationId: row.institution_id, context: { revisionId: row.content_revision_id, reasonCode: input.reasonCode },
      });
      await outbox(tx, {
        actor: input.actor, aggregateType: 'external_review_assignment', aggregateId: input.assignmentId, eventType: 'external_review.revoked',
        organizationId: row.institution_id, payload: { assignmentId: input.assignmentId, revisionId: row.content_revision_id },
      });
      return loadAssignmentView(tx, input.assignmentId);
    });
  } catch (error) {
    rethrow(error);
  }
}

// ---------------------------------------------------------------------------
// The faculty side: only the caller's own assignments, through their memberships in this college
// ---------------------------------------------------------------------------

/** A faculty queue row. No operator, author or other reviewer appears. */
export interface FacultyReviewSummary {
  readonly id: string;
  readonly status: ExternalReviewStatus;
  readonly kind: 'SKILL' | 'QUESTION' | 'LESSON';
  readonly stableKey: string;
  /** Shown only while the assignment is open or after the reviewer decided it; else null. */
  readonly title: string | null;
  readonly assignedAt: string;
  readonly expiresAt: string;
  readonly decision: { readonly decision: ExternalReviewDecision; readonly reasonCode: string; readonly comment: string | null; readonly decidedAt: string } | null;
}

export interface FacultyReviewDetail extends FacultyReviewSummary {
  /** The whitelisted draft, only while the assignment is OPEN. */
  readonly content: ExternalReviewContent | null;
}

const kindOf = (entityType: ExternalReviewEntityType): FacultyReviewSummary['kind'] => (entityType === 'TOPIC' ? 'SKILL' : entityType);

interface FacultyRow {
  id: string; status: ExternalReviewStatus; entity_type: ExternalReviewEntityType; entity_id: string; body: unknown; assigned_at: Date; expires_at: Date;
  decision: ExternalReviewDecision | null; decision_reason_code: string | null; decision_comment: string | null; decided_at: Date | null;
  state: string; revision_hash: string; assignment_hash: string; expired: boolean;
}

function facultyScope(input: { readonly userId: string; readonly membershipIds: readonly string[]; readonly institutionId: string }): SQL {
  if (!input.membershipIds.length) return sql`FALSE`;
  return sql`a.reviewer_user_id = ${input.userId}::uuid AND a.institution_id = ${input.institutionId}::uuid
    AND a.reviewer_membership_id IN (${sql.join(input.membershipIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
}

const facultySelect = sql`
  SELECT a.id, ${statusSql} AS status, c.entity_type, c.entity_id, c.body, a.assigned_at, a.expires_at, a.decision, a.decision_reason_code,
         a.decision_comment, a.decided_at, a.state, c.content_hash AS revision_hash, a.content_hash AS assignment_hash, (a.expires_at <= now()) AS expired
  FROM external_review_assignments a JOIN content_revisions c ON c.id = a.content_revision_id
`;

async function nodeName(runner: SqlRunner, id: string | null): Promise<{ readonly name: string; readonly description: string } | null> {
  if (!id) return null;
  const [row] = await rows<{ name: string; description: string | null }>(runner, sql`SELECT name, description FROM taxonomy_nodes WHERE id = ${id}::uuid AND kind = 'TOPIC'`);
  return row ? { name: row.name, description: row.description ?? '' } : null;
}

async function facultySummary(runner: SqlRunner, row: FacultyRow): Promise<FacultyReviewSummary> {
  const visible = row.status === 'OPEN' || row.status === 'DECIDED';
  const node = row.entity_type === 'TOPIC' && visible ? await nodeName(runner, row.entity_id) : null;
  const body = row.body as Record<string, unknown> | null;
  return {
    id: row.id, status: row.status, kind: kindOf(row.entity_type),
    stableKey: typeof body?.stableKey === 'string' ? body.stableKey : 'NA',
    title: visible ? externalReviewTitle(row.entity_type, row.body, node?.name ?? '') : null,
    assignedAt: iso(row.assigned_at)!, expiresAt: iso(row.expires_at)!,
    decision: row.decision ? { decision: row.decision, reasonCode: row.decision_reason_code ?? 'NA', comment: row.decision_comment, decidedAt: iso(row.decided_at)! } : null,
  };
}

/** The caller's assignments in this college, newest first (at most `limit`). */
export async function listFacultyReviews(runner: SqlRunner, input: {
  readonly userId: string; readonly membershipIds: readonly string[]; readonly institutionId: string; readonly limit: number;
}): Promise<readonly FacultyReviewSummary[]> {
  const found = await rows<FacultyRow>(runner, sql`
    SELECT * FROM (${facultySelect} WHERE ${facultyScope(input)}) x ORDER BY x.assigned_at DESC, x.id DESC LIMIT ${input.limit}
  `);
  const out: FacultyReviewSummary[] = [];
  for (const row of found) out.push(await facultySummary(runner, row));
  return out;
}

/** One of the caller's assignments, with the draft while it is open; null when it is not theirs. */
export async function loadFacultyReview(runner: SqlRunner, input: {
  readonly assignmentId: string; readonly userId: string; readonly membershipIds: readonly string[]; readonly institutionId: string;
}): Promise<FacultyReviewDetail | null> {
  const [row] = await rows<FacultyRow>(runner, sql`${facultySelect} WHERE a.id = ${input.assignmentId}::uuid AND ${facultyScope(input)}`);
  if (!row) return null;
  const summary = await facultySummary(runner, row);
  if (row.status !== 'OPEN') return { ...summary, content: null };
  const fields = row.body as Record<string, unknown> | null;
  const node = row.entity_type === 'TOPIC' ? await nodeName(runner, row.entity_id) : null;
  const skill = row.entity_type === 'QUESTION' && typeof fields?.topicId === 'string' && /^[0-9a-f-]{36}$/i.test(fields.topicId) ? await nodeName(runner, fields.topicId) : null;
  return {
    ...summary,
    content: externalReviewContent(row.entity_type, row.body, {
      ...(node ? { nodeName: node.name, nodeDescription: node.description } : {}),
      skillName: skill ? skill.name : null,
    }),
  };
}

/**
 * Record the faculty decision on one of the caller's open assignments. The 0066 trigger re-checks
 * expiry, the revision and the grant on the locked row.
 */
export async function decideFacultyReview(db: TransactionalRunner, input: {
  readonly assignmentId: string; readonly userId: string; readonly membershipIds: readonly string[]; readonly institutionId: string;
  readonly decision: ExternalReviewDecision; readonly reasonCode: string; readonly comment: string | null; readonly correlationId: string;
  readonly refuse: (current: { readonly contributorUserIds: readonly string[] }) => ExternalReviewRefusal | null;
}): Promise<FacultyReviewSummary> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await rows<{
        content_revision_id: string; author_user_id: string; state: string; expired: boolean; revision_state: string; revision_hash: string; assignment_hash: string;
      }>(tx, sql`
        SELECT a.content_revision_id, c.author_user_id, a.state, (a.expires_at <= now()) AS expired, c.state AS revision_state,
               c.content_hash AS revision_hash, a.content_hash AS assignment_hash
        FROM external_review_assignments a JOIN content_revisions c ON c.id = a.content_revision_id
        WHERE a.id = ${input.assignmentId}::uuid AND ${facultyScope(input)}
        FOR UPDATE OF a
      `);
      if (!row) throw new ExternalReviewError('EXTERNAL_REVIEW_NOT_FOUND');
      const status = externalReviewStatus({
        state: row.state, expired: Boolean(row.expired),
        revisionInReviewAsAssigned: row.revision_state === 'IN_REVIEW' && row.revision_hash === row.assignment_hash,
      });
      if (status === 'EXPIRED') throw new ExternalReviewError('EXTERNAL_REVIEW_EXPIRED');
      if (status !== 'OPEN') throw new ExternalReviewError('EXTERNAL_REVIEW_NOT_OPEN');
      const refusal = input.refuse({ contributorUserIds: await contributorsOfRevision(tx, row.content_revision_id, row.author_user_id) });
      if (refusal) throw new ExternalReviewRefused(refusal);
      await tx.execute(sql`
        UPDATE external_review_assignments
        SET state = 'DECIDED', decision = ${input.decision}, decision_reason_code = ${input.reasonCode}, decision_comment = ${input.comment}, decided_at = now()
        WHERE id = ${input.assignmentId}::uuid
      `);
      const actor: ExternalReviewActor = { userId: input.userId, breakGlass: false, correlationId: input.correlationId };
      await audit(tx, {
        actor, action: 'institution.content_review.decided', resourceType: 'external_review_assignment', resourceId: input.assignmentId,
        organizationId: input.institutionId,
        context: { revisionId: row.content_revision_id, decision: input.decision, reasonCode: input.reasonCode, commentLength: input.comment ? input.comment.length : 0 },
      });
      await outbox(tx, {
        actor, aggregateType: 'external_review_assignment', aggregateId: input.assignmentId, eventType: 'external_review.decided',
        organizationId: input.institutionId, payload: { assignmentId: input.assignmentId, revisionId: row.content_revision_id, decision: input.decision },
      });
      const [after] = await rows<FacultyRow>(tx, sql`${facultySelect} WHERE a.id = ${input.assignmentId}::uuid`);
      return facultySummary(tx, after!);
    });
  } catch (error) {
    rethrow(error);
  }
}
