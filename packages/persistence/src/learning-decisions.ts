/**
 * The session planner's persistence side (ENG-08): gathers one student's planner inputs, runs
 * `learning-orchestrator-v1` (packages/learning-orchestrator) and records the decision in the
 * append-only learning_decisions audit (0053); replays stored decisions (C4); links the attempts
 * a student made acting on a decision.
 *
 * Why it exists: a next step shown to a student must be explainable and replayable, so every
 * decision is stored with the exact inputs it was computed from. The rules live in the pure
 * package; this module only loads facts and writes the row. Design:
 * docs/architecture/learning-decisions-table-design.md.
 *
 * Consent (ENG-01): the adaptive-learning purpose is read on every call. Without it the loader
 * reads no skill state, no due reviews and no attempts, and the planner takes the non-adaptive
 * path. The shadow BKT likelihood and the FSRS numbers are never read (HG-5). No model is called
 * anywhere, and nothing here produces a numeric readiness value. No route calls this yet: the
 * student screens are ENG-18's.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  PLANNER_POLICY_VERSION,
  normalisePlannerInput,
  planNextStep,
  plannerInputsHash,
  replayDecision,
  type PlannerCareerGap,
  type PlannerDecision,
  type PlannerInput,
  type PlannerSkillState,
  type PlannerStrategy,
  type ReplayStatus,
} from '@planthepath/learning-orchestrator/src/index.js';
import { unclearedMisconceptionSignals, type EvidenceStage, type ProjectionAttempt } from '@planthepath/learning-model/src/index.js';
import { hasConsentPurpose } from './consent-purposes.js';
import { listDueReviews, loadProjectionAttempts } from './learner-skill-state.js';
import { listPublishedTeachingStrategies } from './misconceptions.js';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as QueryResult<T>).rows;
}

export interface RecordedDecision {
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly decision: PlannerDecision;
}

/** The student's PRIMARY live target and its current career-gap-v1 snapshot, or null. */
async function loadPrimaryGap(db: PersistenceDb, subjectUserId: string): Promise<PlannerCareerGap | null> {
  const [target] = await rows<{ career_role_id: string; snapshot_id: string }>(db, sql`
    SELECT t.career_role_id, s.id AS snapshot_id
    FROM student_career_targets t
    JOIN career_gap_snapshots s ON s.student_user_id = t.student_user_id AND s.career_role_id = t.career_role_id
      AND s.superseded_at IS NULL AND s.model_version = 'career-gap-v1'
    WHERE t.student_user_id = ${subjectUserId}::uuid AND t.cleared_at IS NULL AND t.priority = 'PRIMARY'
    ORDER BY t.selected_at DESC LIMIT 1
  `);
  if (!target) return null;
  const items = await rows<{ topic_id: string; requirement_level: string; status: string; priority_rank: number }>(db, sql`
    SELECT topic_id, requirement_level, status, priority_rank FROM career_gap_items
    WHERE snapshot_id = ${target.snapshot_id}::uuid ORDER BY priority_rank
  `);
  return {
    careerRoleId: target.career_role_id,
    snapshotId: target.snapshot_id,
    modelVersion: 'career-gap-v1',
    items: items.map((item) => ({
      topicId: item.topic_id,
      requirementLevel: item.requirement_level as PlannerCareerGap['items'][number]['requirementLevel'],
      status: item.status as PlannerCareerGap['items'][number]['status'],
      priorityRank: Number(item.priority_rank),
    })),
  };
}

/** Highest hint level on the latest answered attempt on each skill (projection order: time, then id). */
function latestHintLevels(attempts: readonly ProjectionAttempt[]): ReadonlyMap<string, number> {
  const ordered = [...attempts].sort((left, right) =>
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const latest = new Map<string, number>();
  for (const attempt of ordered) {
    if (!attempt.answered) continue;
    for (const skillId of attempt.skillIds) latest.set(skillId, Math.min(4, Math.max(0, attempt.highestHintLevel ?? 0)));
  }
  return latest;
}

/**
 * Everything planner v1 decides from, for one student, read now. Faculty constraints have no
 * source until INST-16 and are passed as none.
 */
export async function loadPlannerInput(
  db: PersistenceDb,
  input: { readonly subjectUserId: string; readonly sessionMinutes: number | null },
): Promise<PlannerInput> {
  if (!UUID.test(input.subjectUserId)) throw new Error('subjectUserId must be a UUID');
  const adaptive = await hasConsentPurpose(db, input.subjectUserId, 'adaptive-learning');
  const careerGap = await loadPrimaryGap(db, input.subjectUserId);
  const strategies: PlannerStrategy[] = (await listPublishedTeachingStrategies(db)).map((strategy) => ({
    code: strategy.code,
    version: strategy.version,
    kind: strategy.strategyKind,
    applicability: strategy.applicability,
    requiresModel: strategy.requiresModel,
  }));
  const constraints = { override: null, assignments: [] };
  if (!adaptive) {
    // The non-adaptive path reads nothing built from the attempt history.
    return { adaptive, sessionMinutes: input.sessionMinutes, careerGap, skillStates: [], dueReviews: [], strategies, constraints };
  }

  const dueReviews = (await listDueReviews(db, input.subjectUserId))
    .map((review) => ({ skillId: review.skillId, reviewDueAt: review.dueAt }));
  const relevant = [...new Set([...(careerGap?.items ?? []).map((item) => item.topicId), ...dueReviews.map((review) => review.skillId)])];
  const stateRows = relevant.length === 0 ? [] : await rows<{
    skill_id: string; evidence_stage: EvidenceStage; evidence_band: PlannerSkillState['evidenceBand'];
    attempt_count: number; attempt_day_count: number; unaided_success_count: number; active_misconception_codes: string[];
  }>(db, sql`
    SELECT skill_id, evidence_stage, evidence_band, attempt_count, attempt_day_count, unaided_success_count,
           active_misconception_codes
    FROM learner_skill_state
    WHERE subject_user_id = ${input.subjectUserId}::uuid AND skill_id = ANY(${`{${relevant.join(',')}}`}::uuid[])
  `);
  const attempts = stateRows.length === 0 ? [] : await loadProjectionAttempts(db, input.subjectUserId);
  const signals = unclearedMisconceptionSignals(attempts);
  const hints = latestHintLevels(attempts);
  const skillStates: PlannerSkillState[] = stateRows.map((row) => ({
    skillId: row.skill_id,
    evidenceStage: row.evidence_stage,
    evidenceBand: row.evidence_band,
    attemptCount: Number(row.attempt_count),
    attemptDayCount: Number(row.attempt_day_count),
    unaidedSuccessCount: Number(row.unaided_success_count),
    latestHintLevel: hints.get(row.skill_id) ?? 0,
    // The projection decides which codes are active; the attempt log says how often each was
    // signalled. A code the projection lists but the log cannot yet count is one signal.
    misconceptions: (row.active_misconception_codes ?? []).map((code) => ({
      code, unclearedSignals: Math.max(1, signals.get(row.skill_id)?.get(code) ?? 0),
    })),
  }));
  return { adaptive, sessionMinutes: input.sessionMinutes, careerGap, skillStates, dueReviews, strategies, constraints };
}

/**
 * Plan the student's next step and record it: inputs loaded, planner run and the row inserted in
 * one transaction. Rules over data already in the database — no model call, no network.
 */
export async function planNextLearningStep(
  db: PersistenceDb,
  input: { readonly subjectUserId: string; readonly sessionMinutes?: number | null; readonly correlationId: string },
): Promise<RecordedDecision> {
  if (!UUID.test(input.subjectUserId)) throw new Error('subjectUserId must be a UUID');
  if (input.correlationId.length < 1 || input.correlationId.length > 128) throw new Error('correlationId must be 1 to 128 characters');
  return db.transaction(async (tx) => {
    const raw = await loadPlannerInput(tx, { subjectUserId: input.subjectUserId, sessionMinutes: input.sessionMinutes ?? null });
    const inputs = normalisePlannerInput(raw);
    const decision = planNextStep(inputs);
    return insertDecision(tx, {
      subjectUserId: input.subjectUserId, inputs, inputsHash: plannerInputsHash(inputs), decision, correlationId: input.correlationId,
    });
  });
}

async function insertDecision(
  db: PersistenceDb,
  input: { subjectUserId: string; inputs: PlannerInput; inputsHash: string; decision: PlannerDecision; correlationId: string },
): Promise<RecordedDecision> {
  const id = randomUUID();
  const { decision } = input;
  const [inserted] = await rows<{ decided_at: Date | string }>(db, sql`
    INSERT INTO learning_decisions
      (id, subject_user_id, institution_id, policy_version, adaptive, inputs, inputs_hash, action, skill_id,
       focus_misconception_code, strategy_code, strategy_version, reason_codes, override_by_user_id,
       override_reason_code, correlation_id)
    VALUES (
      ${id}::uuid, ${input.subjectUserId}::uuid,
      (SELECT institution_id FROM institution_student_profiles
       WHERE student_user_id = ${input.subjectUserId}::uuid AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1),
      ${decision.policyVersion}, ${input.inputs.adaptive}, ${JSON.stringify(input.inputs)}::jsonb, ${input.inputsHash},
      ${decision.action}, ${decision.skillId}::uuid, ${decision.focusMisconceptionCode},
      ${decision.strategy?.code ?? null}, ${decision.strategy?.version ?? null}::integer,
      ${`{${decision.reasonCodes.join(',')}}`}::text[],
      ${decision.override?.byUserId ?? null}::uuid, ${decision.override?.reasonCode ?? null}, ${input.correlationId}
    )
    RETURNING decided_at
  `);
  return { decisionId: id, decidedAt: new Date(inserted!.decided_at).toISOString(), decision };
}

export interface DecisionReplay {
  readonly decisionId: string;
  readonly status: ReplayStatus;
}

interface StoredRow {
  id: string; policy_version: string; inputs: unknown; inputs_hash: string; action: PlannerDecision['action'];
  skill_id: string | null; focus_misconception_code: string | null; strategy_code: string | null;
  strategy_version: number | null; strategy_kind: NonNullable<PlannerDecision['strategy']>['kind'] | null;
  reason_codes: PlannerDecision['reasonCodes']; override_by_user_id: string | null; override_reason_code: string | null;
}

function replayRow(row: StoredRow): DecisionReplay {
  const result = replayDecision({
    policyVersion: row.policy_version,
    inputs: row.inputs,
    inputsHash: row.inputs_hash,
    decision: {
      action: row.action,
      skillId: row.skill_id,
      focusMisconceptionCode: row.focus_misconception_code,
      strategy: row.strategy_code === null || row.strategy_version === null || row.strategy_kind === null
        ? null : { code: row.strategy_code, version: Number(row.strategy_version), kind: row.strategy_kind },
      reasonCodes: row.reason_codes,
      override: row.override_by_user_id === null || row.override_reason_code === null
        ? null : { byUserId: row.override_by_user_id, reasonCode: row.override_reason_code },
    },
  });
  return { decisionId: row.id, status: result.status };
}

async function storedRows(db: PersistenceDb, decisionId: string | null): Promise<StoredRow[]> {
  return rows<StoredRow>(db, sql`
    SELECT d.id, d.policy_version, d.inputs, d.inputs_hash, d.action, d.skill_id, d.focus_misconception_code,
           d.strategy_code, d.strategy_version, s.strategy_kind, d.reason_codes, d.override_by_user_id,
           d.override_reason_code
    FROM learning_decisions d
    LEFT JOIN teaching_strategies s ON s.code = d.strategy_code AND s.version = d.strategy_version
    WHERE (${decisionId}::uuid IS NULL OR d.id = ${decisionId}::uuid)
    ORDER BY d.decided_at, d.id
  `);
}

/** Recompute one stored decision from its stored inputs and compare (C4). Null when absent. */
export async function replayLearningDecision(db: PersistenceDb, decisionId: string): Promise<DecisionReplay | null> {
  if (!UUID.test(decisionId)) throw new Error('decisionId must be a UUID');
  const [row] = await storedRows(db, decisionId);
  return row ? replayRow(row) : null;
}

export interface ReplaySummary {
  readonly checked: number;
  readonly matched: number;
  readonly mismatched: readonly string[];
  readonly hashMismatch: readonly string[];
  readonly invalidInputs: readonly string[];
  readonly unsupportedPolicy: readonly string[];
}

/** Replay every stored decision (or one). The replay command's body. */
export async function replayLearningDecisions(db: PersistenceDb, options: { readonly decisionId?: string } = {}): Promise<ReplaySummary> {
  if (options.decisionId !== undefined && !UUID.test(options.decisionId)) throw new Error('decisionId must be a UUID');
  const results = (await storedRows(db, options.decisionId ?? null)).map(replayRow);
  const having = (status: ReplayStatus): string[] => results.filter((r) => r.status === status).map((r) => r.decisionId);
  return {
    checked: results.length,
    matched: having('MATCHED').length,
    mismatched: having('MISMATCHED'),
    hashMismatch: having('HASH_MISMATCH'),
    invalidInputs: having('INVALID_INPUTS'),
    unsupportedPolicy: having('UNSUPPORTED_POLICY'),
  };
}

/**
 * Link attempts the student made acting on a decision ("linked outcome attempts"). Only the
 * decision's own subject's attempts, made at or after the decision, are accepted; the list only
 * grows (the 0053 trigger enforces it). Returns the number of linked attempts, or null when the
 * decision does not exist or an attempt does not qualify.
 */
export async function linkDecisionOutcomeAttempts(
  db: PersistenceDb,
  input: { readonly decisionId: string; readonly attemptIds: readonly string[] },
): Promise<number | null> {
  if (!UUID.test(input.decisionId)) throw new Error('decisionId must be a UUID');
  if (input.attemptIds.length === 0 || input.attemptIds.length > 256) throw new Error('attemptIds must hold 1 to 256 attempts');
  for (const attemptId of input.attemptIds) if (!UUID.test(attemptId)) throw new Error('attemptIds must be UUIDs');
  const linked = `{${[...new Set(input.attemptIds.map((value) => value.toLowerCase()))].join(',')}}`;
  const [updated] = await rows<{ count: number }>(db, sql`
    UPDATE learning_decisions d
    SET outcome_attempt_ids = (
      SELECT array_agg(DISTINCT a ORDER BY a) FROM unnest(d.outcome_attempt_ids || ${linked}::uuid[]) AS a
    )
    WHERE d.id = ${input.decisionId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM unnest(${linked}::uuid[]) AS wanted(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM learning_attempt_events e
          WHERE e.id = wanted.id AND e.subject_user_id = d.subject_user_id AND e.occurred_at >= d.decided_at
        )
      )
    RETURNING cardinality(outcome_attempt_ids)::int AS count
  `);
  return updated ? Number(updated.count) : null;
}

export { PLANNER_POLICY_VERSION };
