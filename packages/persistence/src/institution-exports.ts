/**
 * Institution analytics access and CSV export data (INST-08).
 *
 * Design: docs/architecture/institution-exports-design.md. Two halves:
 *
 *  - The INSTITUTION_ANALYTICS grant as the college manages it: who is eligible, grant and
 *    revoke with a reason code, each with its audit row in the same transaction. The role rule
 *    (admin or department head only) stays where 0031 put it, in the database trigger.
 *  - The rows each export writes, for students inside a scope the caller has already resolved
 *    (packages/authorization `institutionExportScope`), and the audit/rate step that must
 *    commit before any file is sent.
 *
 * Nothing here returns an internal identifier to the caller's file: rows carry the college's
 * roll number and unit names. Aggregates go through the shared suppression helper only.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  institutionExportDailyLimit,
  institutionUnitDescendants,
  suppressSmallCount,
  type InstitutionStudentScope,
  type SuppressedCount,
} from '@planthepath/authorization/src/index.js';
import * as schema from './schema.js';
import { institutionStudentScopeClause, loadInstitutionUnitTree } from './institution-scope.js';
import { loadStudentActivations } from './student-invitations.js';

type Queryable = Pool | PoolClient;

export class InstitutionExportError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const analyticsEligibleRoles = ['INSTITUTION_ADMIN', 'DEPARTMENT_HEAD'];

// ---------------------------------------------------------------------------
// The grant, as the college manages it
// ---------------------------------------------------------------------------

export interface InstitutionAnalyticsAccessRow {
  readonly membershipId: string;
  readonly email: string;
  readonly role: string;
  readonly department: string | null;
  readonly grant: { readonly capabilityId: string; readonly grantedAt: string; readonly reasonCode: string } | null;
}

/**
 * Every membership that may hold the capability (ACTIVE institution admins and department
 * heads of this institution), with its live grant or null. Keyed by the membership id the
 * grant call needs; no other identifier is returned.
 */
export async function listInstitutionAnalyticsAccess(client: Queryable, institutionId: string): Promise<readonly InstitutionAnalyticsAccessRow[]> {
  const result = await client.query<{
    membership_id: string; email: string; role: string; department: string | null;
    capability_id: string | null; granted_at: Date | null; reason_code: string | null;
  }>(`
    SELECT m.id AS membership_id, u.email, m.role, d.name AS department,
           c.id AS capability_id, c.granted_at, c.reason_code
    FROM organization_memberships m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN institution_units d ON d.id = m.scope_department_unit_id AND d.institution_id = m.organization_id
    LEFT JOIN membership_capabilities c ON c.membership_id = m.id AND c.capability = 'INSTITUTION_ANALYTICS' AND c.revoked_at IS NULL
    WHERE m.organization_id = $1 AND m.scope_institution_id = $1 AND m.state = 'ACTIVE' AND m.role = ANY($2::text[])
    ORDER BY m.role, u.email
    LIMIT 200`, [institutionId, analyticsEligibleRoles]);
  return result.rows.map((row) => ({
    membershipId: row.membership_id,
    email: row.email,
    role: row.role,
    department: row.department,
    grant: row.capability_id && row.granted_at && row.reason_code
      ? { capabilityId: row.capability_id, grantedAt: new Date(row.granted_at).toISOString(), reasonCode: row.reason_code }
      : null,
  }));
}

interface CapabilityChange {
  readonly institutionId: string;
  readonly actorUserId: string;
  readonly reasonCode: string;
  readonly correlationId: string;
}

/**
 * Grant INSTITUTION_ANALYTICS to a membership of this institution, audited in the same
 * transaction. Self-grant is refused; the 0031 trigger refuses any role but admin or head.
 */
export async function grantInstitutionAnalytics(pool: Pool, input: CapabilityChange & { readonly membershipId: string }): Promise<void> {
  await inTransaction(pool, async (client) => {
    const membership = await client.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM organization_memberships WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [input.membershipId, input.institutionId],
    );
    const target = membership.rows[0];
    if (!target) throw new InstitutionExportError('MEMBERSHIP_NOT_FOUND');
    if (target.user_id === input.actorUserId) throw new InstitutionExportError('CAPABILITY_SELF_GRANT_REFUSED');
    const capabilityId = randomUUID();
    await client.query('SAVEPOINT analytics_grant');
    try {
      await client.query(
        `INSERT INTO membership_capabilities (id, membership_id, capability, granted_by_user_id, reason_code)
         VALUES ($1, $2, 'INSTITUTION_ANALYTICS', $3, $4)`,
        [capabilityId, input.membershipId, input.actorUserId, input.reasonCode],
      );
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT analytics_grant');
      const message = error instanceof Error ? error.message : '';
      if (/may be granted only to/.test(message)) throw new InstitutionExportError('CAPABILITY_ROLE_NOT_ELIGIBLE');
      if (/membership_capability_live_uq|duplicate key/.test(message)) throw new InstitutionExportError('CAPABILITY_ALREADY_HELD');
      throw new InstitutionExportError('CAPABILITY_GRANT_REJECTED');
    }
    await writeAudit(client, {
      actorUserId: input.actorUserId, action: 'institution.analytics_capability.granted', resourceType: 'organization_membership',
      resourceId: input.membershipId, organizationId: input.institutionId, correlationId: input.correlationId, outcome: 'SUCCESS',
      context: { capability: 'INSTITUTION_ANALYTICS', reasonCode: input.reasonCode, targetRole: target.role },
    });
  });
}

/**
 * Revoke a live INSTITUTION_ANALYTICS grant of this institution, recording why, audited in the
 * same transaction. Any other capability on an institution membership (an operations grant
 * such as CONTENT_REVIEW_EXTERNAL) is not the college's to remove and reads as not found.
 */
export async function revokeInstitutionAnalytics(pool: Pool, input: CapabilityChange & { readonly capabilityId: string }): Promise<void> {
  await inTransaction(pool, async (client) => {
    const found = await client.query<{ membership_id: string; role: string }>(
      `SELECT c.membership_id, m.role FROM membership_capabilities c
       JOIN organization_memberships m ON m.id = c.membership_id
       WHERE c.id = $1 AND m.organization_id = $2 AND c.capability = 'INSTITUTION_ANALYTICS' AND c.revoked_at IS NULL
       FOR UPDATE OF c`,
      [input.capabilityId, input.institutionId],
    );
    const grant = found.rows[0];
    if (!grant) throw new InstitutionExportError('CAPABILITY_NOT_FOUND');
    await client.query(
      `UPDATE membership_capabilities SET revoked_by_user_id = $2, revoked_at = now(), revoked_reason_code = $3
       WHERE id = $1 AND revoked_at IS NULL`,
      [input.capabilityId, input.actorUserId, input.reasonCode],
    );
    await writeAudit(client, {
      actorUserId: input.actorUserId, action: 'institution.analytics_capability.revoked', resourceType: 'organization_membership',
      resourceId: grant.membership_id, organizationId: input.institutionId, correlationId: input.correlationId, outcome: 'SUCCESS',
      context: { capability: 'INSTITUTION_ANALYTICS', reasonCode: input.reasonCode, targetRole: grant.role },
    });
  });
}

/** The live INSTITUTION_ANALYTICS grant id for each of these memberships that holds one. */
export async function loadInstitutionAnalyticsGrants(client: Queryable, membershipIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const grants = new Map<string, string>();
  if (membershipIds.length === 0) return grants;
  const result = await client.query<{ id: string; membership_id: string }>(
    `SELECT id, membership_id FROM membership_capabilities
     WHERE membership_id = ANY($1::uuid[]) AND capability = 'INSTITUTION_ANALYTICS' AND revoked_at IS NULL`,
    [[...membershipIds]],
  );
  for (const row of result.rows) grants.set(row.membership_id, row.id);
  return grants;
}

// ---------------------------------------------------------------------------
// Export rows
// ---------------------------------------------------------------------------

/**
 * True when `unitId` is a unit of this institution. The caller checks separately that the
 * unit is inside their own scope.
 */
export async function institutionUnitName(client: Queryable, institutionId: string, unitId: string): Promise<string | null> {
  const result = await client.query<{ name: string }>('SELECT name FROM institution_units WHERE id = $1 AND institution_id = $2', [unitId, institutionId]);
  return result.rows[0]?.name ?? null;
}

/** A student-profile predicate restricting to one unit and everything below it. */
async function unitFilterClause(client: Queryable, institutionId: string, unitId: string | null, alias: string, values: unknown[]): Promise<string> {
  if (!unitId) return 'TRUE';
  const covered = institutionUnitDescendants(unitId, await loadInstitutionUnitTree(client, institutionId));
  return institutionStudentScopeClause({ kind: 'UNITS', clauses: [[covered]] }, alias, values);
}

export interface RosterExportRow {
  readonly institutionStudentId: string;
  readonly fullName: string;
  readonly email: string;
  readonly department: string | null;
  readonly programme: string | null;
  readonly batch: string | null;
  readonly section: string | null;
  readonly relationshipState: string;
  readonly activationState: string;
  readonly invitedAt: string | null;
  readonly lastSentAt: string | null;
}

/**
 * The roster inside the scope, current relationships only (VERIFIED or ACTIVE and not ended):
 * the college's access to anyone else is historical or gone. Returns at most `limit` rows.
 */
export async function exportRosterRows(client: PoolClient, input: {
  readonly institutionId: string; readonly scope: InstitutionStudentScope; readonly unitId: string | null; readonly limit: number;
}): Promise<readonly RosterExportRow[]> {
  const values: unknown[] = [input.institutionId];
  const scopeClause = institutionStudentScopeClause(input.scope, 'sp', values);
  const unitClause = await unitFilterClause(client, input.institutionId, input.unitId, 'sp', values);
  values.push(input.limit);
  const result = await client.query<{
    student_user_id: string; institution_student_id: string; full_name: string; email: string;
    department: string | null; programme: string | null; batch: string | null; section: string | null; relationship_state: string;
  }>(`
    SELECT sp.student_user_id, sp.institution_student_id, sp.full_name, u.email,
           dep.name AS department, prog.name AS programme, bat.name AS batch, sec.name AS section, ir.state AS relationship_state
    FROM institution_student_profiles sp
    JOIN users u ON u.id = sp.student_user_id
    JOIN LATERAL (
      SELECT state, effective_to FROM institution_relationships
      WHERE institution_id = sp.institution_id AND student_user_id = sp.student_user_id
      ORDER BY effective_from DESC LIMIT 1
    ) ir ON true
    LEFT JOIN institution_units dep ON dep.id = sp.department_unit_id AND dep.institution_id = sp.institution_id
    LEFT JOIN institution_units prog ON prog.id = sp.program_unit_id AND prog.institution_id = sp.institution_id
    LEFT JOIN institution_units bat ON bat.id = sp.batch_unit_id AND bat.institution_id = sp.institution_id
    LEFT JOIN institution_units sec ON sec.id = sp.section_unit_id AND sec.institution_id = sp.institution_id
    WHERE sp.institution_id = $1
      AND ir.state IN ('VERIFIED', 'ACTIVE') AND (ir.effective_to IS NULL OR ir.effective_to > now())
      AND ${scopeClause}
      AND ${unitClause}
    ORDER BY sp.institution_student_id, sp.full_name, sp.id
    LIMIT $${values.length}`, values);
  const activations = await loadStudentActivations(drizzle(client, { schema }), input.institutionId, result.rows.map((row) => row.student_user_id));
  return result.rows.map((row) => {
    const activation = activations.get(row.student_user_id);
    return {
      institutionStudentId: row.institution_student_id,
      fullName: row.full_name,
      email: row.email,
      department: row.department,
      programme: row.programme,
      batch: row.batch,
      section: row.section,
      relationshipState: row.relationship_state,
      activationState: activation?.state ?? 'NOT_INVITED',
      invitedAt: activation?.invitedAt ?? null,
      lastSentAt: activation?.lastSentAt ?? null,
    };
  });
}

export interface AssessmentResultExportRow {
  readonly institutionStudentId: string;
  readonly fullName: string;
  readonly attemptNumber: number | null;
  readonly status: string;
  readonly autoSubmitted: boolean | null;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly percentage: number | null;
  readonly correct: number | null;
  readonly wrong: number | null;
  readonly notAttempted: number | null;
  readonly timeTakenSeconds: number | null;
  readonly completedAt: string | null;
}

/** The assessment's title when it belongs to this institution, else null. */
export async function institutionAssessmentTitle(client: Queryable, institutionId: string, definitionId: string): Promise<string | null> {
  const result = await client.query<{ title: string }>('SELECT title FROM exam_definitions WHERE id = $1 AND institution_id = $2', [definitionId, institutionId]);
  return result.rows[0]?.title ?? null;
}

/** A relationship with this institution that authorises activity at `at` (canonicalInstitutionRelationshipPolicy). */
function relationshipAuthorises(studentExpr: string, at: string): string {
  return `EXISTS (SELECT 1 FROM institution_relationships ir
    WHERE ir.institution_id = $1 AND ir.student_user_id = ${studentExpr}
      AND (ir.state IN ('VERIFIED', 'ACTIVE') OR (ir.state IN ('TRANSFERRED', 'GRADUATED') AND ir.effective_to IS NOT NULL))
      AND ir.effective_from <= ${at} AND (ir.effective_to IS NULL OR ir.effective_to > ${at}))`;
}

/**
 * One assessment's grade sheet inside the scope: every completed attempt the relationship
 * authorised when it was taken, then one row per assigned student with a current relationship
 * and no completed attempt. Returns at most `limit` rows in total.
 */
export async function exportAssessmentResultRows(client: PoolClient, input: {
  readonly institutionId: string; readonly definitionId: string; readonly scope: InstitutionStudentScope; readonly unitId: string | null; readonly limit: number;
}): Promise<readonly AssessmentResultExportRow[]> {
  const values: unknown[] = [input.institutionId, input.definitionId];
  const scopeClause = institutionStudentScopeClause(input.scope, 'p', values);
  const unitClause = await unitFilterClause(client, input.institutionId, input.unitId, 'p', values);
  values.push(input.limit);
  const completed = await client.query<{
    institution_student_id: string; full_name: string; attempt_number: number; status: string; auto_submitted: boolean;
    score: string; max_score: string; percentage: string; correct_count: number; wrong_count: number; not_attempted_count: number;
    time_taken_seconds: number; created_at: Date;
  }>(`
    SELECT p.institution_student_id, p.full_name, t.attempt_number, t.status, t.auto_submitted,
           r.score, r.max_score, r.percentage, r.correct_count, r.wrong_count, r.not_attempted_count, r.time_taken_seconds, r.created_at
    FROM exam_results r
    JOIN exam_attempts t ON t.id = r.attempt_id
    JOIN institution_student_profiles p ON p.student_user_id = t.student_user_id AND p.institution_id = t.institution_id
    WHERE t.institution_id = $1 AND t.definition_id = $2
      AND ${relationshipAuthorises('t.student_user_id', 'r.created_at')}
      AND ${scopeClause}
      AND ${unitClause}
    ORDER BY p.institution_student_id, t.attempt_number, r.created_at
    LIMIT $${values.length}`, values);
  const pending = await client.query<{ institution_student_id: string; full_name: string; in_progress: boolean }>(`
    SELECT p.institution_student_id, p.full_name,
           EXISTS (SELECT 1 FROM exam_attempts t WHERE t.definition_id = $2 AND t.student_user_id = a.student_user_id AND t.status = 'IN_PROGRESS') AS in_progress
    FROM exam_assignments a
    JOIN institution_student_profiles p ON p.student_user_id = a.student_user_id AND p.institution_id = a.institution_id
    WHERE a.institution_id = $1 AND a.definition_id = $2
      AND NOT EXISTS (SELECT 1 FROM exam_attempts t WHERE t.definition_id = $2 AND t.student_user_id = a.student_user_id AND t.status <> 'IN_PROGRESS')
      AND EXISTS (SELECT 1 FROM institution_relationships ir
        WHERE ir.institution_id = $1 AND ir.student_user_id = a.student_user_id AND ir.state IN ('VERIFIED', 'ACTIVE')
          AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))
      AND ${scopeClause}
      AND ${unitClause}
    ORDER BY p.institution_student_id
    LIMIT $${values.length}`, values);
  const number = (value: string | number): number => Number(value);
  return [
    ...completed.rows.map((row) => ({
      institutionStudentId: row.institution_student_id, fullName: row.full_name, attemptNumber: row.attempt_number, status: row.status,
      autoSubmitted: row.auto_submitted, score: number(row.score), maxScore: number(row.max_score), percentage: number(row.percentage),
      correct: row.correct_count, wrong: row.wrong_count, notAttempted: row.not_attempted_count, timeTakenSeconds: row.time_taken_seconds,
      completedAt: new Date(row.created_at).toISOString(),
    })),
    ...pending.rows.map((row) => ({
      institutionStudentId: row.institution_student_id, fullName: row.full_name, attemptNumber: null,
      status: row.in_progress ? 'IN_PROGRESS' : 'NOT_ATTEMPTED', autoSubmitted: null, score: null, maxScore: null, percentage: null,
      correct: null, wrong: null, notAttempted: null, timeTakenSeconds: null, completedAt: null,
    })),
  ];
}

export const staffActionSummaryTypes = ['INTERVENTION', 'ASSIGNED_TASK', 'FACULTY_NOTE', 'ACADEMIC_VERIFICATION', 'MEETING'] as const;

export interface StaffActionSummaryRow {
  readonly actionType: (typeof staffActionSummaryTypes)[number];
  /** Students with at least one action of this type opened in the month. */
  readonly students: SuppressedCount;
  /** Actions of this type opened in the month. */
  readonly actions: SuppressedCount;
}

/**
 * Staff actions about students in the scope, opened in one whole month: counts only, each
 * through the shared suppression rule, zero included. No text, no totals. Only the suppressed
 * form leaves this function.
 */
export async function exportStaffActionSummary(client: Queryable, input: {
  readonly institutionId: string; readonly scope: InstitutionStudentScope; readonly periodStart: string; readonly periodEnd: string;
}): Promise<readonly StaffActionSummaryRow[]> {
  const values: unknown[] = [input.institutionId, input.periodStart, input.periodEnd];
  const scopeClause = institutionStudentScopeClause(input.scope, 'p', values);
  const result = await client.query<{ action_type: string; students: number; actions: number }>(`
    SELECT a.action_type, count(DISTINCT a.subject_student_user_id)::int AS students, count(*)::int AS actions
    FROM staff_actions a
    JOIN institution_student_profiles p ON p.institution_id = a.institution_id AND p.student_user_id = a.subject_student_user_id
    WHERE a.institution_id = $1 AND a.subject_student_user_id IS NOT NULL
      AND a.created_at >= $2::date AND a.created_at < ($3::date + interval '1 day')
      AND ${relationshipAuthorises('a.subject_student_user_id', 'a.created_at')}
      AND ${scopeClause}
    GROUP BY a.action_type`, values);
  const counts = new Map(result.rows.map((row) => [row.action_type, row]));
  return staffActionSummaryTypes.map((actionType) => ({
    actionType,
    students: suppressSmallCount(counts.get(actionType)?.students ?? 0),
    actions: suppressSmallCount(counts.get(actionType)?.actions ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Rate and audit
// ---------------------------------------------------------------------------

/**
 * Run an export inside one transaction: take the caller's export lock, refuse when they have
 * used their daily allowance, let `produce` build the file, and write the audit row. The file
 * is returned only after the audit row commits, so no export leaves unrecorded.
 */
export async function recordInstitutionExport<T>(pool: Pool, input: {
  readonly institutionId: string; readonly actorUserId: string; readonly correlationId: string;
  readonly action: string; readonly exportId: string;
  readonly produce: (client: PoolClient) => Promise<{ readonly result: T; readonly context: Record<string, unknown> }>;
}): Promise<T> {
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['institution-export:' + input.actorUserId + ':' + input.institutionId]);
    const used = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE actor_user_id = $1 AND organization_id = $2 AND outcome = 'SUCCESS'
         AND action LIKE 'institution.%.exported' AND occurred_at > now() - interval '24 hours'`,
      [input.actorUserId, input.institutionId],
    );
    if ((used.rows[0]?.n ?? 0) >= institutionExportDailyLimit) throw new InstitutionExportError('EXPORT_RATE_LIMITED');
    const { result, context } = await input.produce(client);
    await writeAudit(client, {
      actorUserId: input.actorUserId, action: input.action, resourceType: 'institution_export', resourceId: input.exportId,
      organizationId: input.institutionId, correlationId: input.correlationId, outcome: 'SUCCESS', context,
    });
    return result;
  });
}

/** An export refused because the caller holds no authorising grant. */
export async function recordDeniedInstitutionExport(pool: Pool, input: {
  readonly institutionId: string; readonly actorUserId: string; readonly correlationId: string; readonly kind: string; readonly reason: string;
}): Promise<void> {
  await writeAudit(pool, {
    actorUserId: input.actorUserId, action: 'institution.export.denied', resourceType: 'institution_export', resourceId: randomUUID(),
    organizationId: input.institutionId, correlationId: input.correlationId, outcome: 'DENIED', context: { kind: input.kind, reason: input.reason },
  });
}

async function writeAudit(client: Queryable, input: {
  readonly actorUserId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly organizationId: string; readonly correlationId: string; readonly outcome: 'SUCCESS' | 'DENIED'; readonly context: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [randomUUID(), input.actorUserId, input.action, input.resourceType, input.resourceId, input.organizationId, input.outcome, input.correlationId, JSON.stringify(input.context)],
  );
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
