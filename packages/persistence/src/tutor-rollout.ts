/**
 * Tutor rollout (ENG-25, migration 0116): the AI tutor per college, the tutor / no-tutor groups, and the
 * pilot counters.
 *
 * Why this exists: for real students the tutor is a pilot. A college is switched on only by dual control and
 * through OPS-12's evaluation gate; within a switched-on college, each consenting student is assigned once, by
 * a keyed hash over the experiment's recorded seed (ADR-051), to the tutor or the no-tutor group; and every
 * practice act of an assigned student adds one to a per-group, per-day counter with no student in it.
 *
 * Plain database work only: nothing here calls a model, and nothing reads or writes readiness, evidence or
 * mastery. The 0116 triggers repeat every rule (switch-on needs an executed approval and a passing evaluation;
 * a group is the one the seed gives; only consenting current students are assigned; counters only grow).
 *
 * Design: docs/architecture/tutor-rollout-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { aiKillSwitchFlagKey, refuseAiFeatureEnable, suppressSmallCount, type SuppressedCount } from '@planthepath/authorization/src/index.js';
import {
  TUTOR_ASSIGNMENT_METHOD,
  TUTOR_HINT_FEATURE_KEY,
  TUTOR_PILOT_METRICS,
  TUTOR_SHARE_BASIS_POINTS,
  assignTutorGroup,
  newTutorAssignmentSeed,
  tutorAudienceFromEnvironment,
  type TutorGroup,
  type TutorPilotMetric,
} from '@planthepath/tutoring/src/index.js';
import { AiOperationsError, loadAiPolicyFacts, type AiActor, type AiPolicyFacts } from './ai-operations.js';
import { consumeOperationApproval, type ConsumedApproval } from './operation-approvals.js';
import { validateAuditWriteInput } from './repositories.js';

export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}
type Db = SqlRunner & { transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> };
type Environment = Readonly<Record<string, string | undefined>>;

async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as { rows: T[] }).rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// The student side: is the college on, and which group is the student in
// ---------------------------------------------------------------------------

export interface TutorCollegeRollout {
  readonly id: string;
  readonly institutionId: string;
  readonly enabled: boolean;
  readonly assignmentMethod: string;
  readonly assignmentSeed: string;
  readonly tutorShareBasisPoints: number;
}

export async function loadTutorCollegeRollout(runner: SqlRunner, institutionId: string): Promise<TutorCollegeRollout | null> {
  if (!UUID.test(institutionId)) return null;
  const [row] = await rows<{ id: string; institution_id: string; enabled: boolean; assignment_method: string; assignment_seed: string; tutor_share_basis_points: number }>(runner, sql`
    SELECT id::text AS id, institution_id::text AS institution_id, enabled, assignment_method, assignment_seed, tutor_share_basis_points
    FROM tutor_college_rollouts WHERE institution_id = ${institutionId}::uuid
  `);
  return row ? {
    id: row.id, institutionId: row.institution_id, enabled: row.enabled === true, assignmentMethod: row.assignment_method,
    assignmentSeed: row.assignment_seed, tutorShareBasisPoints: Number(row.tutor_share_basis_points),
  } : null;
}

/**
 * The student's group in the college's experiment, recording it the first time they are eligible: the college
 * switched on, and the student holds `ai-tutoring` (the caller has read it on this request) and is a current
 * student of the college. Returns null when they are not eligible. The insert names the same conditions the
 * 0116 trigger enforces, so an ineligible student is simply not assigned rather than an error on a read.
 */
export async function ensureTutorGroupAssignment(runner: SqlRunner, input: {
  readonly rollout: TutorCollegeRollout; readonly subjectUserId: string; readonly correlationId: string;
}): Promise<TutorGroup | null> {
  const existing = await loadTutorGroup(runner, input.rollout.id, input.subjectUserId);
  if (existing) return existing;
  if (!input.rollout.enabled) return null;
  const { bucket, group } = assignTutorGroup({
    seed: input.rollout.assignmentSeed, experimentId: input.rollout.id, subjectUserId: input.subjectUserId,
    tutorShareBasisPoints: input.rollout.tutorShareBasisPoints,
  });
  await runner.execute(sql`
    INSERT INTO tutor_group_assignments (id, rollout_id, institution_id, subject_user_id, assignment_method, bucket, group_name, consent_version, correlation_id)
    SELECT ${randomUUID()}::uuid, ${input.rollout.id}::uuid, ${input.rollout.institutionId}::uuid, ${input.subjectUserId}::uuid,
           ${TUTOR_ASSIGNMENT_METHOD}, ${bucket}, ${group}, latest.version, ${input.correlationId.slice(0, 200)}
    FROM (
      SELECT c.version, c.action FROM user_consents c
      WHERE c.user_id = ${input.subjectUserId}::uuid AND c.consent_key = 'ai-tutoring'
      ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1
    ) latest
    WHERE latest.action = 'GRANTED'
      AND EXISTS (SELECT 1 FROM consent_definitions d WHERE d.consent_key = 'ai-tutoring' AND d.version = latest.version
                    AND d.retired_at IS NULL AND d.effective_from <= now())
      AND EXISTS (SELECT 1 FROM institution_relationships r
                    WHERE r.student_user_id = ${input.subjectUserId}::uuid AND r.institution_id = ${input.rollout.institutionId}::uuid
                      AND r.state::text IN ('ACTIVE','VERIFIED') AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now()))
    ON CONFLICT (rollout_id, subject_user_id) DO NOTHING
  `);
  return loadTutorGroup(runner, input.rollout.id, input.subjectUserId);
}

async function loadTutorGroup(runner: SqlRunner, rolloutId: string, subjectUserId: string): Promise<TutorGroup | null> {
  const [row] = await rows<{ group_name: TutorGroup }>(runner, sql`
    SELECT group_name FROM tutor_group_assignments WHERE rollout_id = ${rolloutId}::uuid AND subject_user_id = ${subjectUserId}::uuid
  `);
  return row?.group_name ?? null;
}

/**
 * What the pilot audience adds to the tutor policy for one student on one step: whether the step's college has
 * the tutor switched on, and (for a consenting student there) their recorded group. Outside the pilot audience
 * nothing is read or written.
 */
export async function tutorPilotGate(runner: SqlRunner, input: {
  readonly subjectUserId: string; readonly institutionId: string | null; readonly consented: boolean; readonly correlationId: string;
  readonly env?: Environment;
}): Promise<{ readonly collegeEnabled: boolean; readonly group: TutorGroup | null }> {
  if (tutorAudienceFromEnvironment(input.env ?? process.env) !== 'PILOT' || !input.institutionId) return { collegeEnabled: false, group: null };
  const rollout = await loadTutorCollegeRollout(runner, input.institutionId);
  if (!rollout?.enabled) return { collegeEnabled: false, group: null };
  if (!input.consented) return { collegeEnabled: true, group: null };
  return { collegeEnabled: true, group: await ensureTutorGroupAssignment(runner, { rollout, subjectUserId: input.subjectUserId, correlationId: input.correlationId }) };
}

/**
 * Adds `count` to today's counter for the student's group, in the caller's transaction — only in the pilot
 * audience, only for a student assigned in a switched-on experiment of the step's college who holds
 * `ai-tutoring` now. The row carries the experiment, the group, the day and the metric: no student.
 */
export async function recordTutorPilotMetric(runner: SqlRunner, input: {
  readonly subjectUserId: string; readonly institutionId: string | null; readonly metric: TutorPilotMetric; readonly count?: number;
  readonly env?: Environment;
}): Promise<void> {
  const count = input.count ?? 1;
  if (!input.institutionId || count < 1 || !(TUTOR_PILOT_METRICS as readonly string[]).includes(input.metric)) return;
  if (tutorAudienceFromEnvironment(input.env ?? process.env) !== 'PILOT') return;
  await runner.execute(sql`
    INSERT INTO tutor_pilot_daily_metrics (rollout_id, group_name, metric_date, metric_key, count, updated_at)
    SELECT a.rollout_id, a.group_name, current_date, ${input.metric}, ${count}, now()
    FROM tutor_group_assignments a
    JOIN tutor_college_rollouts r ON r.id = a.rollout_id AND r.enabled
    WHERE a.subject_user_id = ${input.subjectUserId}::uuid AND a.institution_id = ${input.institutionId}::uuid
      AND EXISTS (
        SELECT 1 FROM consent_definitions d
        JOIN LATERAL (
          SELECT c.version, c.action FROM user_consents c
          WHERE c.user_id = a.subject_user_id AND c.consent_key = d.consent_key
          ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1
        ) latest ON latest.version = d.version AND latest.action = 'GRANTED'
        WHERE d.consent_key = 'ai-tutoring' AND d.retired_at IS NULL AND d.effective_from <= now())
    ON CONFLICT (rollout_id, group_name, metric_date, metric_key)
    DO UPDATE SET count = tutor_pilot_daily_metrics.count + EXCLUDED.count, updated_at = now()
  `);
}

// ---------------------------------------------------------------------------
// The operations side (OPS-12 console)
// ---------------------------------------------------------------------------

export interface TutorCollegeFacts {
  readonly institutionId: string;
  readonly institutionName: string;
  readonly enabled: boolean;
  readonly policy: AiPolicyFacts | null;
}

/** What a request or a switch-on for one college is checked against. Null when it is not a college. */
export async function loadTutorCollegeFacts(runner: SqlRunner, institutionId: string, lock: 'NONE' | 'UPDATE' = 'NONE'): Promise<TutorCollegeFacts | null> {
  if (!UUID.test(institutionId)) return null;
  const [college] = await rows<{ id: string; legal_name: string }>(runner, sql`
    SELECT id::text AS id, legal_name FROM organizations WHERE id = ${institutionId}::uuid AND kind::text = 'INSTITUTION'
  `);
  if (!college) return null;
  const [rollout] = await rows<{ enabled: boolean }>(runner, lock === 'UPDATE'
    ? sql`SELECT enabled FROM tutor_college_rollouts WHERE institution_id = ${institutionId}::uuid FOR UPDATE`
    : sql`SELECT enabled FROM tutor_college_rollouts WHERE institution_id = ${institutionId}::uuid`);
  return {
    institutionId: college.id.toLowerCase(), institutionName: college.legal_name, enabled: rollout?.enabled === true,
    policy: await loadAiPolicyFacts(runner, TUTOR_HINT_FEATURE_KEY),
  };
}

/** Why a college cannot be put to an approver or switched on now; null when it can. */
export function refuseTutorCollegeEnable(facts: TutorCollegeFacts): AiOperationsError['code'] | null {
  if (facts.enabled) return 'TUTOR_COLLEGE_ALREADY_ENABLED';
  if (!facts.policy) return 'AI_FEATURE_NOT_FOUND';
  return refuseAiFeatureEnable({
    enabled: false, killSwitchEngaged: facts.policy.killSwitchEngaged,
    promptDeclared: facts.policy.promptKey !== null && facts.policy.promptVersion !== null,
    evaluationPasses: facts.policy.passingEvaluationId !== null,
  });
}

export interface TutorCollegeBinding {
  readonly institutionId: string;
  readonly featureKey: string;
  readonly model: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly evaluationId: string;
}

/** The facts an AI_TUTOR_COLLEGE_ENABLE approval is bound to, read from the database (never the request). */
export function tutorCollegeBinding(facts: TutorCollegeFacts): TutorCollegeBinding {
  const policy = facts.policy!;
  return {
    institutionId: facts.institutionId, featureKey: policy.featureKey, model: policy.model,
    promptKey: policy.promptKey!, promptVersion: policy.promptVersion!, evaluationId: policy.passingEvaluationId!,
  };
}

async function audit(runner: SqlRunner, actor: AiActor, input: { readonly action: string; readonly institutionId: string; readonly context: Record<string, unknown> }): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: actor.userId, action: input.action, resourceType: 'tutor_college_rollout', resourceId: input.institutionId, correlationId: actor.correlationId });
  const context = { ...input.context, ...(actor.breakGlass ? { break_glass: true } : {}) };
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${actor.userId}::uuid, ${input.action}, 'tutor_college_rollout', ${input.institutionId}, ${input.institutionId}::uuid, 'SUCCESS',
            ${actor.correlationId}, ${JSON.stringify(context)}::jsonb)
  `);
}

/**
 * Switch the tutor on for one college: the college exists, the kill switch is released, the tutor's prompt is
 * declared and has a passing evaluation for its current model, and an AI_TUTOR_COLLEGE_ENABLE approval bound
 * to exactly that is consumed in this transaction. The first switch-on records the experiment (a fresh seed).
 */
export async function enableTutorForCollege(db: Db, actor: AiActor, input: {
  readonly institutionId: string;
  readonly reasonCode: string;
  readonly approvalId: string | undefined;
  readonly approvalPayload: (binding: TutorCollegeBinding) => Record<string, unknown>;
}): Promise<{ readonly rolloutId: string; readonly approval: ConsumedApproval; readonly created: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM feature_flags WHERE key = ${aiKillSwitchFlagKey} FOR SHARE`);
    const facts = await loadTutorCollegeFacts(tx, input.institutionId, 'UPDATE');
    if (!facts) throw new AiOperationsError('TUTOR_COLLEGE_NOT_FOUND');
    const refusal = refuseTutorCollegeEnable(facts);
    if (refusal) throw new AiOperationsError(refusal);
    if (!input.approvalId) throw new AiOperationsError('APPROVAL_REQUIRED');
    const binding = tutorCollegeBinding(facts);
    const approval = await consumeOperationApproval(tx, {
      approvalId: input.approvalId, actionKey: 'AI_TUTOR_COLLEGE_ENABLE', payload: input.approvalPayload(binding),
      executorUserId: actor.userId, correlationId: actor.correlationId,
    });
    const [existing] = await rows<{ id: string }>(tx, sql`SELECT id::text AS id FROM tutor_college_rollouts WHERE institution_id = ${facts.institutionId}::uuid`);
    const rolloutId = existing?.id ?? randomUUID();
    try {
      if (existing) {
        await tx.execute(sql`
          UPDATE tutor_college_rollouts SET enabled = true, enabled_model = ${binding.model}, enabled_prompt_key = ${binding.promptKey},
            enabled_prompt_version = ${binding.promptVersion}, enabled_evaluation_id = ${binding.evaluationId}::uuid,
            enabled_approval_id = ${approval.approvalId}::uuid, enabled_by_user_id = ${actor.userId}::uuid, enabled_at = now(),
            changed_by_user_id = ${actor.userId}::uuid, change_reason_code = ${input.reasonCode}, correlation_id = ${actor.correlationId}
          WHERE id = ${rolloutId}::uuid
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO tutor_college_rollouts (id, institution_id, feature_key, enabled, assignment_method, assignment_seed, tutor_share_basis_points,
            created_by_user_id, enabled_model, enabled_prompt_key, enabled_prompt_version, enabled_evaluation_id, enabled_approval_id, enabled_at,
            enabled_by_user_id, changed_by_user_id, change_reason_code, correlation_id)
          VALUES (${rolloutId}::uuid, ${facts.institutionId}::uuid, ${binding.featureKey}, true, ${TUTOR_ASSIGNMENT_METHOD}, ${newTutorAssignmentSeed()},
            ${TUTOR_SHARE_BASIS_POINTS}, ${actor.userId}::uuid, ${binding.model}, ${binding.promptKey}, ${binding.promptVersion}, ${binding.evaluationId}::uuid,
            ${approval.approvalId}::uuid, now(), ${actor.userId}::uuid, ${actor.userId}::uuid, ${input.reasonCode}, ${actor.correlationId})
        `);
      }
    } catch {
      // The 0116 trigger refused; never forward database text.
      throw new AiOperationsError('AI_CHANGE_REJECTED');
    }
    await audit(tx, actor, {
      action: 'operations.ai.tutor_college.enabled', institutionId: facts.institutionId,
      context: {
        institutionId: facts.institutionId, featureKey: binding.featureKey, reasonCode: input.reasonCode, from: { enabled: false }, to: { enabled: true },
        model: binding.model, promptKey: binding.promptKey, promptVersion: binding.promptVersion, evaluationId: binding.evaluationId,
        approvalId: approval.approvalId, requestedByUserId: approval.requestedByUserId, approvedByUserId: approval.approvedByUserId, mode: approval.mode,
        experimentCreated: !existing,
      },
    });
    return { rolloutId, approval, created: !existing };
  });
}

/** Switch the tutor off for one college. Immediate, no approval; the experiment and its assignments stay. */
export async function disableTutorForCollege(db: Db, actor: AiActor, input: { readonly institutionId: string; readonly reasonCode: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const facts = await loadTutorCollegeFacts(tx, input.institutionId, 'UPDATE');
    if (!facts) throw new AiOperationsError('TUTOR_COLLEGE_NOT_FOUND');
    if (!facts.enabled) throw new AiOperationsError('TUTOR_COLLEGE_ALREADY_DISABLED');
    await tx.execute(sql`
      UPDATE tutor_college_rollouts SET enabled = false, changed_by_user_id = ${actor.userId}::uuid, change_reason_code = ${input.reasonCode},
        correlation_id = ${actor.correlationId}
      WHERE institution_id = ${facts.institutionId}::uuid
    `);
    await audit(tx, actor, {
      action: 'operations.ai.tutor_college.disabled', institutionId: facts.institutionId,
      context: { institutionId: facts.institutionId, featureKey: TUTOR_HINT_FEATURE_KEY, reasonCode: input.reasonCode, from: { enabled: true }, to: { enabled: false } },
    });
  });
}

export interface TutorGroupSummary {
  /** Students assigned to the group (all time); under five is suppressed. */
  readonly assigned: SuppressedCount;
  /** The group's counters over the window; null when the group is suppressed. */
  readonly metrics: Readonly<Record<TutorPilotMetric, number>> | null;
}

export interface TutorCollegeRolloutView {
  readonly institutionId: string;
  readonly institutionName: string;
  /** null: the tutor has never been switched on for this college. */
  readonly rollout: {
    readonly enabled: boolean;
    readonly assignmentMethod: string;
    readonly tutorSharePercent: number;
    readonly createdAt: string;
    readonly enabledAt: string | null;
    readonly changedAt: string;
    readonly lastReasonCode: string;
    readonly enabledModel: string | null;
    readonly enabledPrompt: string | null;
    readonly groups: { readonly TUTOR: TutorGroupSummary; readonly NO_TUTOR: TutorGroupSummary };
  } | null;
}

export const TUTOR_ROLLOUT_LIST_LIMIT = 200;

/**
 * Every college with its tutor state, and for colleges with an experiment, the two groups' sizes and their
 * counters over the last `days` days (database days, today included). A group of fewer than five students
 * shows `<5` and no counters. No student is named or identified.
 */
export async function listTutorCollegeRollouts(runner: SqlRunner, input: { readonly days: number }): Promise<readonly TutorCollegeRolloutView[]> {
  const days = Math.min(Math.max(1, Math.trunc(input.days)), 366);
  const colleges = await rows<{
    institution_id: string; legal_name: string; rollout_id: string | null; enabled: boolean | null; assignment_method: string | null;
    tutor_share_basis_points: number | null; created_at: Date | string | null; enabled_at: Date | string | null; changed_at: Date | string | null;
    change_reason_code: string | null; enabled_model: string | null; enabled_prompt_key: string | null; enabled_prompt_version: number | null;
  }>(runner, sql`
    SELECT o.id::text AS institution_id, o.legal_name, r.id::text AS rollout_id, r.enabled, r.assignment_method, r.tutor_share_basis_points,
           r.created_at, r.enabled_at, r.changed_at, r.change_reason_code, r.enabled_model, r.enabled_prompt_key, r.enabled_prompt_version
    FROM organizations o
    LEFT JOIN tutor_college_rollouts r ON r.institution_id = o.id
    WHERE o.kind::text = 'INSTITUTION'
    ORDER BY (r.id IS NULL), r.enabled DESC NULLS LAST, o.legal_name, o.id
    LIMIT ${TUTOR_ROLLOUT_LIST_LIMIT}
  `);
  const rolloutIds = colleges.flatMap((row) => (row.rollout_id ? [row.rollout_id] : []));
  const assigned = new Map<string, number>();
  const metrics = new Map<string, number>();
  if (rolloutIds.length) {
    const idList = sql.join(rolloutIds.map((id) => sql`${id}::uuid`), sql`, `);
    for (const row of await rows<{ rollout_id: string; group_name: string; n: number }>(runner, sql`
      SELECT rollout_id::text AS rollout_id, group_name, count(*)::int AS n FROM tutor_group_assignments
      WHERE rollout_id IN (${idList}) GROUP BY rollout_id, group_name
    `)) assigned.set(`${row.rollout_id}|${row.group_name}`, Number(row.n));
    for (const row of await rows<{ rollout_id: string; group_name: string; metric_key: string; total: number }>(runner, sql`
      SELECT rollout_id::text AS rollout_id, group_name, metric_key, sum(count)::int AS total FROM tutor_pilot_daily_metrics
      WHERE rollout_id IN (${idList}) AND metric_date > current_date - ${days}::int
      GROUP BY rollout_id, group_name, metric_key
    `)) metrics.set(`${row.rollout_id}|${row.group_name}|${row.metric_key}`, Number(row.total));
  }
  const group = (rolloutId: string, name: TutorGroup): TutorGroupSummary => {
    const count = suppressSmallCount(assigned.get(`${rolloutId}|${name}`) ?? 0);
    if (count.suppressed) return { assigned: count, metrics: null };
    const values = Object.fromEntries(TUTOR_PILOT_METRICS.map((key) => [key, metrics.get(`${rolloutId}|${name}|${key}`) ?? 0])) as Record<TutorPilotMetric, number>;
    return { assigned: count, metrics: values };
  };
  const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);
  return colleges.map((row) => ({
    institutionId: row.institution_id,
    institutionName: row.legal_name,
    rollout: row.rollout_id ? {
      enabled: row.enabled === true,
      assignmentMethod: row.assignment_method ?? TUTOR_ASSIGNMENT_METHOD,
      tutorSharePercent: Number(row.tutor_share_basis_points ?? TUTOR_SHARE_BASIS_POINTS) / 100,
      createdAt: iso(row.created_at)!,
      enabledAt: iso(row.enabled_at),
      changedAt: iso(row.changed_at)!,
      lastReasonCode: row.change_reason_code ?? '',
      enabledModel: row.enabled_model,
      enabledPrompt: row.enabled_prompt_key ? `${row.enabled_prompt_key}@${row.enabled_prompt_version}` : null,
      groups: { TUTOR: group(row.rollout_id, 'TUTOR'), NO_TUTOR: group(row.rollout_id, 'NO_TUTOR') },
    } : null,
  }));
}

/** What the console says about the tutor as a whole, beside the colleges. Only whether, never a value. */
export async function loadTutorRolloutStatus(runner: SqlRunner, env: Environment = process.env): Promise<{
  readonly pilotAudience: boolean;
  readonly featureRegistered: boolean;
  readonly featureEnabled: boolean;
  readonly killSwitchEngaged: boolean;
  readonly evaluationPasses: boolean;
}> {
  const policy = await loadAiPolicyFacts(runner, TUTOR_HINT_FEATURE_KEY);
  const kill = await rows<{ engaged: boolean }>(runner, sql`SELECT ai_kill_switch_engaged() AS engaged`);
  return {
    pilotAudience: tutorAudienceFromEnvironment(env) === 'PILOT',
    featureRegistered: policy !== null,
    featureEnabled: policy?.enabled === true,
    killSwitchEngaged: kill[0]?.engaged === true,
    evaluationPasses: policy?.passingEvaluationId != null,
  };
}
