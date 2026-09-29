/**
 * The student learning experience (ENG-18): the path in skip / review / learn groups, the one next step with
 * its reasons, due reviews, and practice with the hint ladder on the step.
 *
 * Why it exists: the engine goals built the planner (ENG-08), the review schedule (ENG-09), the placement test
 * (ENG-14) and goals (ENG-19) with no student surface; this module is the one read and the few writes the
 * student's screens need, on web and Android alike. The next step is ENG-08's `planNextLearningStep` (so every
 * step is recorded and replayable, C4); attempts go through ENG-03's writer; each attempt made on a step is
 * linked to its decision with `linkDecisionOutcomeAttempts`. The hint level on an attempt is the server's record
 * of the hints it released (learning_step_items, 0072), never the client's claim, so a success after hint 3 is
 * assisted (C5). Design: docs/architecture/learning-step-items-table-design.md.
 *
 * Consent (ENG-01) is read on every call: without adaptive-learning (every real student until HG-6) no skill
 * state or due review is read, and the planner takes its non-adaptive path. Only published, current,
 * answer-keyed questions are served; with none, the step says so and records nothing. Views never carry an
 * answer key, the correct option, an explanation, a model number (BKT, FSRS, ability) or a readiness value; a
 * due review is due or not, with no date. No model is called anywhere. Times come from the database clock.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  groupLearningPath,
  type LearningPathGroups,
  type PathEntry,
  type PlannerAction,
  type PlannerGapItem,
  type SkillBand,
} from '@planthepath/learning-orchestrator/src/index.js';
import { hasConsentPurpose } from './consent-purposes.js';
import { currentInstitutionOf, drizzleAsPgClient, recordGradedAttemptSession, type LearningAttemptContext, type LearningSessionMode } from './learning-attempts.js';
import { linkDecisionOutcomeAttempts, planNextLearningStep } from './learning-decisions.js';
import { listDueReviews } from './learner-skill-state.js';
import { resolveResponseMisconceptionsWith } from './misconceptions.js';
import type { PersistenceDb } from './repositories.js';

/** Questions served per step (`learning-step-items-v1`); the 0072 CHECK allows positions 1–5. */
export const STEP_ITEM_LIMIT = 5;
export const STEP_ITEMS_POLICY_VERSION = 'learning-step-items-v1' as const;
/** The content version stamped on step attempts, as `placement-v1` is on the placement test's. */
export const STEP_CONTENT_VERSION = 'learning-step-v1' as const;
export const MAX_HINT_LEVEL = 4;

type QueryResult<T> = { rows: T[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as QueryResult<T>).rows;
}

export type LearningStepErrorCode =
  | 'INVALID_INPUT' | 'NOT_FOUND' | 'SUPERSEDED' | 'NOT_CURRENT_QUESTION' | 'INVALID_OPTION' | 'NO_HINTS' | 'HINTS_EXHAUSTED';

export class LearningStepError extends Error {
  constructor(readonly code: LearningStepErrorCode) {
    super(`learning step: ${code}`);
    this.name = 'LearningStepError';
  }
}

// ---------------------------------------------------------------------------
// Views (everything a student may see)
// ---------------------------------------------------------------------------

export interface StepQuestionView {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly position: number;
  /** Whether this question has a published hint ladder. */
  readonly hintsAvailable: boolean;
  /** Hints shown so far, in ladder order (level 1 first). Their count is the level shown. */
  readonly hints: readonly string[];
}

export type StepPracticeView =
  | { readonly status: 'NO_SKILL' }
  | { readonly status: 'NO_PRACTICE' }
  | { readonly status: 'IN_PROGRESS'; readonly question: StepQuestionView; readonly questionsAnswered: number }
  | { readonly status: 'COMPLETED'; readonly questionsAnswered: number };

export interface LearningStepView {
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly action: PlannerAction;
  readonly skill: { readonly id: string; readonly name: string } | null;
  readonly strategyKind: string | null;
  readonly reasonCodes: readonly string[];
  readonly adaptive: boolean;
  readonly lessons: readonly { readonly id: string; readonly title: string }[];
  readonly practice: StepPracticeView;
}

export interface PathEntryView extends PathEntry {
  readonly skillName: string;
}

export interface LearningPathView {
  readonly adaptive: boolean;
  readonly target: { readonly careerRoleId: string; readonly title: string } | null;
  /** Counts of the target's requirements. Facts, not a score; no percentage is ever returned. */
  readonly requirements: { readonly total: number; readonly met: number; readonly notMeasured: number } | null;
  readonly groups: { readonly policyVersion: LearningPathGroups['policyVersion']; readonly skip: readonly PathEntryView[]; readonly review: readonly PathEntryView[]; readonly learn: readonly PathEntryView[] };
  /** Adaptive only: skills whose review is due now, earliest first. Due or not; no date. */
  readonly dueReviews: readonly { readonly skillId: string; readonly skillName: string }[];
  readonly latestStep: LearningStepView | null;
}

export interface StepAnswerView {
  readonly feedback: { readonly questionId: string; readonly correct: boolean; readonly assisted: boolean };
  readonly step: LearningStepView;
}

// ---------------------------------------------------------------------------
// The path
// ---------------------------------------------------------------------------

async function skillNames(db: PersistenceDb, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unique.length === 0) return new Map();
  const found = await rows<{ id: string; name: string }>(db, sql`
    SELECT id::text AS id, name FROM taxonomy_nodes WHERE id = ANY(${`{${unique.join(',')}}`}::uuid[])
  `);
  return new Map(found.map((row) => [row.id.toLowerCase(), row.name]));
}

/** The student's learning path: groups, due reviews and the latest step. Reads only. */
export async function readLearningPath(db: PersistenceDb, subjectUserId: string): Promise<LearningPathView> {
  assertUuid(subjectUserId);
  const adaptive = await hasConsentPurpose(db, subjectUserId, 'adaptive-learning');
  const [target] = await rows<{ career_role_id: string; title: string; snapshot_id: string | null; total: number | null; met: number | null; unknown: number | null }>(db, sql`
    SELECT t.career_role_id::text AS career_role_id, r.title, s.id::text AS snapshot_id,
           s.requirements_total AS total, s.requirements_met AS met, s.requirements_unknown AS unknown
    FROM student_career_targets t
    JOIN career_roles r ON r.id = t.career_role_id
    LEFT JOIN career_gap_snapshots s ON s.student_user_id = t.student_user_id AND s.career_role_id = t.career_role_id
      AND s.superseded_at IS NULL AND s.model_version = 'career-gap-v1'
    WHERE t.student_user_id = ${subjectUserId}::uuid AND t.cleared_at IS NULL AND t.priority = 'PRIMARY'
    ORDER BY t.selected_at DESC LIMIT 1
  `);
  const gapItems: PlannerGapItem[] = target?.snapshot_id ? (await rows<{ topic_id: string; requirement_level: PlannerGapItem['requirementLevel']; status: PlannerGapItem['status']; priority_rank: number }>(db, sql`
    SELECT topic_id::text AS topic_id, requirement_level, status, priority_rank FROM career_gap_items
    WHERE snapshot_id = ${target.snapshot_id}::uuid ORDER BY priority_rank
  `)).map((item) => ({ topicId: item.topic_id.toLowerCase(), requirementLevel: item.requirement_level, status: item.status, priorityRank: Number(item.priority_rank) })) : [];
  const topicList = `{${gapItems.map((item) => item.topicId).join(',')}}`;

  // Without consent nothing derived from the attempt history is read (ENG-01).
  const due = adaptive ? await listDueReviews(db, subjectUserId) : [];
  const states = adaptive && gapItems.length > 0 ? await rows<{ skill_id: string; attempt_count: number; evidence_band: SkillBand }>(db, sql`
    SELECT skill_id::text AS skill_id, attempt_count, evidence_band FROM learner_skill_state
    WHERE subject_user_id = ${subjectUserId}::uuid AND skill_id = ANY(${topicList}::uuid[])
  `) : [];
  // The existing evidence path's band per topic (latest projection), used when not adaptive.
  const bands = !adaptive && gapItems.length > 0 ? await rows<{ topic_id: string; band: SkillBand }>(db, sql`
    SELECT DISTINCT ON (topic_id) topic_id::text AS topic_id, band FROM mastery_projections
    WHERE subject_user_id = ${subjectUserId}::uuid AND topic_id = ANY(${topicList}::uuid[])
    ORDER BY topic_id, generated_at DESC, id DESC
  `) : [];

  const groups = groupLearningPath({
    adaptive,
    gapItems,
    skillStates: states.map((state) => ({ skillId: state.skill_id.toLowerCase(), attemptCount: Number(state.attempt_count), evidenceBand: state.evidence_band })),
    dueSkillIds: due.map((review) => review.skillId.toLowerCase()),
    evidenceBands: new Map(bands.map((row) => [row.topic_id.toLowerCase(), row.band])),
  });
  const names = await skillNames(db, [...gapItems.map((item) => item.topicId), ...due.map((review) => review.skillId)]);
  const named = (entries: readonly PathEntry[]): PathEntryView[] =>
    entries.map((entry) => ({ ...entry, skillName: names.get(entry.skillId.toLowerCase()) ?? 'Unnamed skill' }));

  const [latest] = await rows<{ id: string }>(db, sql`
    SELECT id::text AS id FROM learning_decisions WHERE subject_user_id = ${subjectUserId}::uuid
    ORDER BY decided_at DESC, id DESC LIMIT 1
  `);
  return {
    adaptive,
    target: target ? { careerRoleId: target.career_role_id, title: target.title } : null,
    requirements: target?.snapshot_id
      ? { total: Number(target.total), met: Number(target.met), notMeasured: Number(target.unknown) }
      : null,
    groups: { policyVersion: groups.policyVersion, skip: named(groups.skip), review: named(groups.review), learn: named(groups.learn) },
    dueReviews: due.map((review) => ({ skillId: review.skillId, skillName: names.get(review.skillId.toLowerCase()) ?? 'Unnamed skill' })),
    latestStep: latest ? await stepView(db, subjectUserId, latest.id) : null,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface DecisionRow {
  id: string; subject_user_id: string; institution_id: string | null; decided_at: Date | string; adaptive: boolean;
  action: PlannerAction; skill_id: string | null; strategy_kind: string | null; reason_codes: string[];
}

async function loadDecision(db: PersistenceDb, subjectUserId: string, decisionId: string): Promise<DecisionRow | null> {
  const [row] = await rows<DecisionRow>(db, sql`
    SELECT d.id::text AS id, d.subject_user_id::text AS subject_user_id, d.institution_id::text AS institution_id, d.decided_at,
           d.adaptive, d.action, d.skill_id::text AS skill_id, s.strategy_kind, d.reason_codes
    FROM learning_decisions d
    LEFT JOIN teaching_strategies s ON s.code = d.strategy_code AND s.version = d.strategy_version
    WHERE d.id = ${decisionId}::uuid AND d.subject_user_id = ${subjectUserId}::uuid
  `);
  return row ?? null;
}

interface ServedRow { position: number; item_id: string; item_version: number; skill_id: string; hint_level: number; answered: boolean }

async function servedItems(db: PersistenceDb, decisionId: string): Promise<ServedRow[]> {
  return (await rows<ServedRow>(db, sql`
    SELECT i.position, i.item_id::text AS item_id, i.item_version, i.skill_id::text AS skill_id, i.hint_level,
           (e.id IS NOT NULL) AS answered
    FROM learning_step_items i
    LEFT JOIN learning_attempt_events e
      ON e.source_attempt_type = 'learning_step' AND e.source_attempt_id = i.decision_id
     AND e.item_source = i.item_source AND e.item_id = i.item_id
    WHERE i.decision_id = ${decisionId}::uuid
    ORDER BY i.position
  `)).map((row) => ({ ...row, item_id: row.item_id.toLowerCase(), position: Number(row.position), hint_level: Number(row.hint_level), answered: row.answered === true }));
}

/** Only `id` and `text` of each option ever leave this module. */
function optionsOf(value: unknown): { id: string; text: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (!option || typeof option !== 'object') return [];
    const { id, text } = option as { id?: unknown; text?: unknown };
    return typeof id === 'string' && typeof text === 'string' ? [{ id, text }] : [];
  });
}

/** The published hint ladder of a question, or null. Reads the ladder table only — never the key or the body. */
async function publishedLadder(db: PersistenceDb, questionId: string): Promise<readonly string[] | null> {
  const [ladder] = await rows<{ hint_1: string; hint_2: string; hint_3: string; hint_4: string }>(db, sql`
    SELECT h.hint_1, h.hint_2, h.hint_3, h.hint_4
    FROM question_versions q
    JOIN question_hint_ladders h ON h.question_revision_id = q.content_revision_id AND h.review_state = 'PUBLISHED'
    WHERE q.id = ${questionId}::uuid
  `);
  return ladder ? [ladder.hint_1, ladder.hint_2, ladder.hint_3, ladder.hint_4] : null;
}

async function questionView(db: PersistenceDb, item: ServedRow): Promise<StepQuestionView> {
  const [question] = await rows<{ prompt: string; options: unknown }>(db, sql`SELECT prompt, options FROM question_versions WHERE id = ${item.item_id}::uuid`);
  const ladder = await publishedLadder(db, item.item_id);
  return {
    id: item.item_id,
    prompt: question?.prompt ?? '',
    options: optionsOf(question?.options),
    position: item.position,
    hintsAvailable: ladder !== null,
    hints: ladder ? ladder.slice(0, item.hint_level) : [],
  };
}

async function lessonsFor(db: PersistenceDb, skillId: string): Promise<{ id: string; title: string }[]> {
  return rows<{ id: string; title: string }>(db, sql`
    SELECT l.id::text AS id, l.title
    FROM lesson_versions l
    JOIN learning_modules m ON m.id = l.module_id
    JOIN release_manifests rm ON rm.id = m.release_manifest_id AND rm.status = 'PUBLISHED'
    WHERE l.topic_id = ${skillId}::uuid AND l.superseded_at IS NULL
    ORDER BY l.stable_key LIMIT 10
  `);
}

async function stepView(db: PersistenceDb, subjectUserId: string, decisionId: string): Promise<LearningStepView | null> {
  const decision = await loadDecision(db, subjectUserId, decisionId);
  if (!decision) return null;
  const names = decision.skill_id ? await skillNames(db, [decision.skill_id]) : new Map<string, string>();
  const served = await servedItems(db, decisionId);
  const answered = served.filter((item) => item.answered).length;
  const current = served.find((item) => !item.answered);
  const practice: StepPracticeView = decision.skill_id === null
    ? { status: 'NO_SKILL' }
    : current
      ? { status: 'IN_PROGRESS', question: await questionView(db, current), questionsAnswered: answered }
      : served.length > 0 ? { status: 'COMPLETED', questionsAnswered: answered } : { status: 'NO_PRACTICE' };
  return {
    decisionId: decision.id,
    decidedAt: new Date(decision.decided_at).toISOString(),
    action: decision.action,
    skill: decision.skill_id ? { id: decision.skill_id, name: names.get(decision.skill_id.toLowerCase()) ?? 'Unnamed skill' } : null,
    strategyKind: decision.strategy_kind,
    reasonCodes: decision.reason_codes,
    adaptive: decision.adaptive === true,
    lessons: decision.skill_id ? await lessonsFor(db, decision.skill_id) : [],
    practice,
  };
}

const SESSION_FOR_ACTION: Readonly<Record<Exclude<PlannerAction, 'NONE'>, { mode: LearningSessionMode; context: LearningAttemptContext }>> = {
  REVIEW: { mode: 'REVIEW', context: 'REVIEW' },
  LEARN: { mode: 'LEARN', context: 'PRACTICE' },
  PRACTICE: { mode: 'PRACTICE', context: 'PRACTICE' },
  REMEDIATE: { mode: 'PRACTICE', context: 'PRACTICE' },
  FOLLOW_ASSIGNMENT: { mode: 'PRACTICE', context: 'PRACTICE' },
};

/**
 * The next question for a step (`learning-step-items-v1`): published, current and answer-keyed, on the step's
 * skill, not already served in this step, not in the student's own in-progress readiness check; fresh first,
 * then least recently answered in a step, then by stable key and id.
 */
async function nextEligibleItem(db: PersistenceDb, decision: DecisionRow): Promise<{ id: string; version: number } | null> {
  const [item] = await rows<{ id: string; version: number }>(db, sql`
    SELECT q.id::text AS id, q.version
    FROM question_versions q
    JOIN question_answer_keys k ON k.question_version_id = q.id
    JOIN release_manifests rm ON rm.id = q.release_manifest_id AND rm.status = 'PUBLISHED'
    WHERE q.topic_id = ${decision.skill_id}::uuid AND q.superseded_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM learning_step_items s WHERE s.decision_id = ${decision.id}::uuid AND s.item_id = q.id)
      AND NOT EXISTS (
        SELECT 1 FROM assessment_attempt_items ai JOIN assessment_attempts a ON a.id = ai.attempt_id
        WHERE a.subject_user_id = ${decision.subject_user_id}::uuid AND a.state = 'IN_PROGRESS' AND ai.question_version_id = q.id
      )
    ORDER BY (
      SELECT max(e.occurred_at) FROM learning_attempt_events e
      WHERE e.subject_user_id = ${decision.subject_user_id}::uuid AND e.source_attempt_type = 'learning_step'
        AND e.item_source = 'CAREER_READINESS_QUESTION' AND e.item_id = q.id
    ) ASC NULLS FIRST, q.stable_key, q.id
    LIMIT 1
  `);
  return item ? { id: item.id.toLowerCase(), version: Number(item.version) } : null;
}

async function stepSessionId(db: PersistenceDb, decisionId: string): Promise<string | null> {
  const [session] = await rows<{ id: string }>(db, sql`
    SELECT id::text AS id FROM learning_sessions WHERE source_type = 'learning_step' AND source_id = ${decisionId}::uuid
  `);
  return session?.id ?? null;
}

/** Serves the next question of a step, or closes the step's session when there is none. */
async function serveNext(db: PersistenceDb, decision: DecisionRow): Promise<void> {
  if (decision.action === 'NONE' || decision.skill_id === null) return;
  const served = await servedItems(db, decision.id);
  if (served.some((item) => !item.answered)) return;
  let sessionId = await stepSessionId(db, decision.id);
  const next = served.length < STEP_ITEM_LIMIT ? await nextEligibleItem(db, decision) : null;
  if (!next) {
    if (sessionId) {
      await db.execute(sql`UPDATE learning_sessions SET ended_at = now() WHERE id = ${sessionId}::uuid AND ended_at IS NULL`);
    }
    return;
  }
  if (!sessionId) {
    sessionId = randomUUID();
    const institutionId = await currentInstitutionOf(drizzleAsPgClient(db), decision.subject_user_id);
    await db.execute(sql`
      INSERT INTO learning_sessions (id, subject_user_id, institution_id, mode, source_type, source_id, started_at)
      VALUES (${sessionId}::uuid, ${decision.subject_user_id}::uuid, ${institutionId}::uuid, ${SESSION_FOR_ACTION[decision.action].mode},
        'learning_step', ${decision.id}::uuid, now())
    `);
  }
  await db.execute(sql`
    INSERT INTO learning_step_items (id, decision_id, subject_user_id, institution_id, session_id, position, item_source, item_id, item_version, skill_id)
    VALUES (${randomUUID()}::uuid, ${decision.id}::uuid, ${decision.subject_user_id}::uuid, ${decision.institution_id}::uuid, ${sessionId}::uuid,
      ${served.length + 1}, 'CAREER_READINESS_QUESTION', ${next.id}::uuid, ${next.version}, ${decision.skill_id}::uuid)
  `);
}

async function lockStudent(db: PersistenceDb, subjectUserId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('learning-step'), hashtext(${subjectUserId}))`);
}

/** Loads a decision the student may act on: their own, and their latest (an older step is superseded). */
async function actionableDecision(db: PersistenceDb, subjectUserId: string, decisionId: string): Promise<DecisionRow> {
  const decision = await loadDecision(db, subjectUserId, decisionId);
  if (!decision) throw new LearningStepError('NOT_FOUND');
  const [latest] = await rows<{ id: string }>(db, sql`
    SELECT id::text AS id FROM learning_decisions WHERE subject_user_id = ${subjectUserId}::uuid
    ORDER BY decided_at DESC, id DESC LIMIT 1
  `);
  if (latest?.id.toLowerCase() !== decision.id.toLowerCase()) throw new LearningStepError('SUPERSEDED');
  return decision;
}

/**
 * Plans the student's next step with ENG-08's planner (recording the decision with its inputs, C4), opens it
 * and serves its first practice question when one is published. Rules over data — no model call.
 */
export async function startNextLearningStep(db: PersistenceDb, input: {
  readonly subjectUserId: string; readonly sessionMinutes?: number | null; readonly correlationId: string;
}): Promise<LearningStepView> {
  assertUuid(input.subjectUserId);
  const minutes = input.sessionMinutes ?? null;
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 600)) throw new LearningStepError('INVALID_INPUT');
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    await lockStudent(runner, input.subjectUserId);
    const recorded = await planNextLearningStep(runner, { subjectUserId: input.subjectUserId, sessionMinutes: minutes, correlationId: input.correlationId });
    const decision = await loadDecision(runner, input.subjectUserId, recorded.decisionId);
    await serveNext(runner, decision!);
    return (await stepView(runner, input.subjectUserId, recorded.decisionId))!;
  });
}

/** The current state of one of the student's steps (any of theirs, read only). */
export async function readLearningStep(db: PersistenceDb, input: { readonly subjectUserId: string; readonly decisionId: string }): Promise<LearningStepView> {
  assertUuid(input.subjectUserId);
  if (!UUID.test(input.decisionId)) throw new LearningStepError('INVALID_INPUT');
  const view = await stepView(db, input.subjectUserId, input.decisionId);
  if (!view) throw new LearningStepError('NOT_FOUND');
  return view;
}

/** Releases the next hint level of the question being answered and records it (0072). */
export async function revealStepHint(db: PersistenceDb, input: {
  readonly subjectUserId: string; readonly decisionId: string; readonly questionId: string;
}): Promise<LearningStepView> {
  assertUuid(input.subjectUserId);
  if (!UUID.test(input.decisionId) || !UUID.test(input.questionId)) throw new LearningStepError('INVALID_INPUT');
  const questionId = input.questionId.toLowerCase();
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    await lockStudent(runner, input.subjectUserId);
    const decision = await actionableDecision(runner, input.subjectUserId, input.decisionId);
    const current = (await servedItems(runner, decision.id)).find((item) => !item.answered);
    if (!current || current.item_id !== questionId) throw new LearningStepError('NOT_CURRENT_QUESTION');
    if (!(await publishedLadder(runner, questionId))) throw new LearningStepError('NO_HINTS');
    if (current.hint_level >= MAX_HINT_LEVEL) throw new LearningStepError('HINTS_EXHAUSTED');
    await runner.execute(sql`
      UPDATE learning_step_items SET hint_level = hint_level + 1
      WHERE decision_id = ${decision.id}::uuid AND item_id = ${questionId}::uuid
    `);
    return (await stepView(runner, input.subjectUserId, decision.id))!;
  });
}

/**
 * Grades the answer to the question being answered, records the attempt through ENG-03's writer with the
 * server-recorded hint level, links it to the decision, then serves the next question or finishes the step.
 * Answering an already-answered question of the step returns what was recorded (a replay).
 */
export async function answerStepQuestion(db: PersistenceDb, input: {
  readonly subjectUserId: string; readonly decisionId: string; readonly questionId: string; readonly selectedOptionId: string;
}): Promise<StepAnswerView> {
  assertUuid(input.subjectUserId);
  if (!UUID.test(input.decisionId) || !UUID.test(input.questionId)) throw new LearningStepError('INVALID_INPUT');
  if (typeof input.selectedOptionId !== 'string' || input.selectedOptionId.length < 1 || input.selectedOptionId.length > 64) {
    throw new LearningStepError('INVALID_INPUT');
  }
  const questionId = input.questionId.toLowerCase();
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    await lockStudent(runner, input.subjectUserId);
    const decision = await actionableDecision(runner, input.subjectUserId, input.decisionId);
    const served = await servedItems(runner, decision.id);
    const item = served.find((row) => row.item_id === questionId);
    if (item?.answered) {
      const [recorded] = await rows<{ correct: boolean; assisted: boolean }>(runner, sql`
        SELECT correct, assisted FROM learning_attempt_events
        WHERE source_attempt_type = 'learning_step' AND source_attempt_id = ${decision.id}::uuid
          AND item_source = 'CAREER_READINESS_QUESTION' AND item_id = ${questionId}::uuid
      `);
      return { feedback: { questionId, correct: recorded!.correct, assisted: recorded!.assisted }, step: (await stepView(runner, input.subjectUserId, decision.id))! };
    }
    const current = served.find((row) => !row.answered);
    if (!current || current.item_id !== questionId || decision.action === 'NONE') throw new LearningStepError('NOT_CURRENT_QUESTION');

    const [keyed] = await rows<{ options: unknown; correct_option_id: string }>(runner, sql`
      SELECT q.options, k.correct_option_id FROM question_versions q
      JOIN question_answer_keys k ON k.question_version_id = q.id WHERE q.id = ${questionId}::uuid
    `);
    if (!keyed) throw new LearningStepError('NOT_CURRENT_QUESTION');
    if (!optionsOf(keyed.options).some((option) => option.id === input.selectedOptionId)) throw new LearningStepError('INVALID_OPTION');
    const correct = input.selectedOptionId === keyed.correct_option_id;

    const pg = drizzleAsPgClient(runner);
    const [signalled] = await resolveResponseMisconceptionsWith(pg, [{ questionVersionId: questionId, selectedOptionId: input.selectedOptionId }]);
    const [session] = await rows<{ started_at: Date | string; institution_id: string | null }>(runner, sql`
      SELECT started_at, institution_id::text AS institution_id FROM learning_sessions
      WHERE source_type = 'learning_step' AND source_id = ${decision.id}::uuid
    `);
    const { mode, context } = SESSION_FOR_ACTION[decision.action as Exclude<PlannerAction, 'NONE'>];
    await recordGradedAttemptSession(pg, {
      subjectUserId: input.subjectUserId, institutionId: session!.institution_id, mode, context,
      sourceAttemptType: 'learning_step', sourceAttemptId: decision.id, startedAt: session!.started_at,
      contentVersion: STEP_CONTENT_VERSION,
      responses: [{
        itemSource: 'CAREER_READINESS_QUESTION', itemId: questionId, itemVersion: current.item_version, skillId: current.skill_id,
        answered: true, correct, marksAwarded: correct ? 1 : 0, marksPossible: 1, selectedOptionId: input.selectedOptionId,
        highestHintLevel: current.hint_level,
        misconceptionCodeIds: correct ? [] : (signalled?.misconceptions ?? []).map((entry) => entry.misconceptionCodeId),
      }],
    });
    const [attempt] = await rows<{ id: string; assisted: boolean }>(runner, sql`
      SELECT id::text AS id, assisted FROM learning_attempt_events
      WHERE source_attempt_type = 'learning_step' AND source_attempt_id = ${decision.id}::uuid
        AND item_source = 'CAREER_READINESS_QUESTION' AND item_id = ${questionId}::uuid
    `);
    // "Linked outcome attempts" (ENG-08): what the student did acting on this decision.
    await linkDecisionOutcomeAttempts(runner, { decisionId: decision.id, attemptIds: [attempt!.id] });
    await serveNext(runner, decision);
    return { feedback: { questionId, correct, assisted: attempt!.assisted === true }, step: (await stepView(runner, input.subjectUserId, decision.id))! };
  });
}

function assertUuid(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new LearningStepError('INVALID_INPUT');
}
