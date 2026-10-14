/**
 * The placement test's online path (ENG-14): start or resume a sitting, serve one question at a
 * time, grade the answer, record it as a DIAGNOSTIC attempt, and stop by the rules of
 * `placement-2pl-eap-v1` (packages/placement).
 *
 * Why it exists: the pure package decides; this module holds the sitting in the database so the
 * server — not the client — decides which question is asked, and so the result can be replayed
 * from what was served. Design: docs/architecture/placement-tests-table-design.md.
 *
 * It fails closed. Without the live `adaptive-learning` purpose (ENG-01) — the state of every
 * student until HG-6 publishes it — nothing is served. Only published, current aptitude items with
 * a calibration (ENG-13) are served, and with fewer than 25 of them the test is not available; today
 * ENG-10's bank is entirely DRAFT, so it is never available. Views returned from here never carry an
 * answer key, whether an answer was right, an item parameter or the ability estimate; nothing here
 * reads or writes readiness, and no model is called. Times come from the database clock.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  PLACEMENT_ALGORITHM_ID,
  PLACEMENT_RULES,
  nextPlacementStep,
  placementGroupOfSkillKey,
  retestPool,
  type PlacementAnswer,
  type PlacementGroup,
  type PlacementItem,
  type PlacementResultLevel,
  type PlacementStep,
  type PlacementStopReason,
} from '@planthepath/placement/src/index.js';
import { hasConsentPurpose } from './consent-purposes.js';
import { currentInstitutionOf, drizzleAsPgClient, recordGradedAttemptSession } from './learning-attempts.js';
import { resolveResponseMisconceptionsWith } from './misconceptions.js';
import { calibrationItemKey, latestItemCalibrations, type CalibrationStatus } from './item-calibrations.js';
import type { PersistenceDb } from './repositories.js';

export const PLACEMENT_SCOPE = 'APTITUDE_V1' as const;
/** The content version stamped on placement attempts, as `assessment-v1` is on the readiness check's. */
export const PLACEMENT_CONTENT_VERSION = 'placement-v1' as const;

export type PlacementUnavailableReason = 'CONSENT_REQUIRED' | 'NOT_ENOUGH_ITEMS';

export interface PlacementQuestionView {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly position: number;
}

/** Everything a student may see about a placement. No key, correctness, parameter or estimate. */
export type PlacementTestView =
  | { readonly status: 'NOT_AVAILABLE'; readonly reason: PlacementUnavailableReason }
  | { readonly status: 'NOT_STARTED' }
  | {
      readonly status: 'IN_PROGRESS';
      readonly placementTestId: string;
      readonly question: PlacementQuestionView;
      readonly questionsAnswered: number;
      readonly maxQuestions: number;
      readonly deadlineAt: string;
    }
  | {
      readonly status: 'COMPLETED';
      readonly placementTestId: string;
      readonly placementLevel: PlacementResultLevel;
      readonly stopReason: PlacementStopReason;
      readonly questionsAnswered: number;
      readonly completedAt: string;
    };

export type PlacementTestErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'NOT_SERVED_QUESTION' | 'INVALID_OPTION' | 'ALREADY_COMPLETED';

export class PlacementTestError extends Error {
  constructor(readonly code: PlacementTestErrorCode) {
    super(`placement test: ${code}`);
    this.name = 'PlacementTestError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type QueryResult<T> = { rows: T[] };

interface EligibleItem extends PlacementItem {
  readonly itemVersion: number;
  readonly skillId: string;
  readonly calibrationStatus: CalibrationStatus;
  readonly calibrationRunId: string;
}

interface Sitting {
  readonly id: string;
  readonly subjectUserId: string;
  readonly institutionId: string | null;
  readonly sessionId: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED';
  readonly startedAt: Date;
  readonly deadlineAt: Date;
  readonly completedAt: Date | null;
  readonly stopReason: PlacementStopReason | null;
  readonly placementLevel: PlacementResultLevel | null;
  readonly itemsAnswered: number | null;
  readonly elapsedMs: number;
  readonly expired: boolean;
}

interface ServedItem {
  readonly position: number;
  readonly itemId: string;
  readonly itemVersion: number;
  readonly skillId: string;
  readonly item: PlacementItem;
  readonly correct: boolean | null;
}

/**
 * The items a placement may serve: published, current, answer-keyed questions on an active
 * aptitude topic, each with a calibration row (latest CALIBRATED, else latest PROVISIONAL). An item
 * with no calibration row is left out rather than given invented parameters.
 */
export async function loadEligiblePlacementItems(db: PersistenceDb): Promise<EligibleItem[]> {
  const found = await db.execute(sql`
    SELECT q.id::text AS id, q.version, q.topic_id::text AS topic_id, n.stable_key
    FROM question_versions q
    JOIN question_answer_keys k ON k.question_version_id = q.id
    JOIN release_manifests rm ON rm.id = q.release_manifest_id AND rm.status = 'PUBLISHED'
    JOIN taxonomy_nodes n ON n.id = q.topic_id AND n.active AND n.stable_key ~ '^apt-[qlv]-'
    WHERE q.superseded_at IS NULL
    ORDER BY q.id
  `) as QueryResult<{ id: string; version: number; topic_id: string; stable_key: string }>;
  if (found.rows.length === 0) return [];
  const calibrations = await latestItemCalibrations(db, found.rows.map((row) => ({
    itemSource: 'CAREER_READINESS_QUESTION' as const, itemId: row.id, itemVersion: Number(row.version),
  })));
  const items: EligibleItem[] = [];
  for (const row of found.rows) {
    const group = placementGroupOfSkillKey(row.stable_key);
    const calibration = calibrations.get(calibrationItemKey({ itemSource: 'CAREER_READINESS_QUESTION', itemId: row.id, itemVersion: Number(row.version) }));
    if (!group || !calibration) continue;
    items.push({
      key: row.id.toLowerCase(), group, difficulty: calibration.difficulty, discrimination: calibration.discrimination,
      itemVersion: Number(row.version), skillId: row.topic_id, calibrationStatus: calibration.status, calibrationRunId: calibration.runId,
    });
  }
  return items;
}

/** The student's placement state; completes an in-progress sitting whose 25 minutes have passed. */
export async function readPlacementTest(db: PersistenceDb, subjectUserId: string): Promise<PlacementTestView> {
  assertUuid(subjectUserId);
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    if (!(await hasConsentPurpose(runner, subjectUserId, 'adaptive-learning'))) return { status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' };
    await lockStudent(runner, subjectUserId);
    const open = await loadOpenSitting(runner, subjectUserId);
    if (open) return settle(runner, open);
    const latest = await loadLatestCompleted(runner, subjectUserId);
    if (latest) return completedView(latest);
    const pool = await loadEligiblePlacementItems(runner);
    if (pool.length < PLACEMENT_RULES.minPoolSize) return { status: 'NOT_AVAILABLE', reason: 'NOT_ENOUGH_ITEMS' };
    return { status: 'NOT_STARTED' };
  });
}

/** Resumes the in-progress sitting, or starts a new one and serves its first question. */
export async function startPlacementTest(db: PersistenceDb, input: { readonly subjectUserId: string }): Promise<PlacementTestView> {
  assertUuid(input.subjectUserId);
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    if (!(await hasConsentPurpose(runner, input.subjectUserId, 'adaptive-learning'))) return { status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' };
    await lockStudent(runner, input.subjectUserId);
    const open = await loadOpenSitting(runner, input.subjectUserId);
    if (open) {
      const view = await settle(runner, open);
      if (view.status === 'IN_PROGRESS') return view;
    }
    const pool = await loadEligiblePlacementItems(runner);
    if (pool.length < PLACEMENT_RULES.minPoolSize) return { status: 'NOT_AVAILABLE', reason: 'NOT_ENOUGH_ITEMS' };

    const pg = drizzleAsPgClient(runner);
    const institutionId = await currentInstitutionOf(pg, input.subjectUserId);
    const testId = randomUUID();
    const sessionId = randomUUID();
    await runner.execute(sql`
      INSERT INTO learning_sessions (id, subject_user_id, institution_id, mode, source_type, source_id, started_at)
      VALUES (${sessionId}::uuid, ${input.subjectUserId}::uuid, ${institutionId}::uuid, 'DIAGNOSTIC', 'placement_test', ${testId}::uuid, now())
    `);
    await runner.execute(sql`
      INSERT INTO placement_tests (id, subject_user_id, institution_id, session_id, scope, algorithm_id, state, started_at, deadline_at)
      VALUES (${testId}::uuid, ${input.subjectUserId}::uuid, ${institutionId}::uuid, ${sessionId}::uuid, ${PLACEMENT_SCOPE},
        ${PLACEMENT_ALGORITHM_ID}, 'IN_PROGRESS', now(), now() + make_interval(secs => ${PLACEMENT_RULES.timeLimitMs / 1000}))
    `);
    const sitting = await loadSitting(runner, testId, input.subjectUserId);
    return settle(runner, sitting!);
  });
}

/**
 * Grades the answer to the served question, records it as a DIAGNOSTIC attempt (which requests the
 * skill-state projection), then serves the next question or completes the sitting. Answering an
 * already-answered question again is a replay and returns the current state.
 */
export async function answerPlacementQuestion(db: PersistenceDb, input: {
  readonly subjectUserId: string;
  readonly placementTestId: string;
  readonly questionId: string;
  readonly selectedOptionId: string;
}): Promise<PlacementTestView> {
  assertUuid(input.subjectUserId);
  if (!UUID.test(input.placementTestId) || !UUID.test(input.questionId)) throw new PlacementTestError('INVALID_INPUT');
  if (typeof input.selectedOptionId !== 'string' || input.selectedOptionId.length < 1 || input.selectedOptionId.length > 64) {
    throw new PlacementTestError('INVALID_INPUT');
  }
  const questionId = input.questionId.toLowerCase();
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    if (!(await hasConsentPurpose(runner, input.subjectUserId, 'adaptive-learning'))) return { status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' };
    const sitting = await loadSitting(runner, input.placementTestId, input.subjectUserId, true);
    if (!sitting) throw new PlacementTestError('NOT_FOUND');
    const served = await loadServedItems(runner, sitting.id);
    const earlier = served.find((item) => item.itemId === questionId);
    if (earlier && earlier.correct !== null) return sitting.state === 'COMPLETED' ? completedView(sitting) : settle(runner, sitting);
    if (sitting.state === 'COMPLETED') throw new PlacementTestError('ALREADY_COMPLETED');
    // After the deadline nothing is graded: the sitting ends at its deadline with what it has.
    if (sitting.expired) return settle(runner, sitting);
    const current = served.find((item) => item.correct === null);
    if (!current || current.itemId !== questionId) throw new PlacementTestError('NOT_SERVED_QUESTION');

    const keyed = await runner.execute(sql`
      SELECT q.options, k.correct_option_id FROM question_versions q
      JOIN question_answer_keys k ON k.question_version_id = q.id WHERE q.id = ${current.itemId}::uuid
    `) as QueryResult<{ options: unknown; correct_option_id: string }>;
    const question = keyed.rows[0];
    if (!question) throw new PlacementTestError('NOT_SERVED_QUESTION');
    if (!optionsOf(question.options).some((option) => option.id === input.selectedOptionId)) throw new PlacementTestError('INVALID_OPTION');
    const correct = input.selectedOptionId === question.correct_option_id;

    const pg = drizzleAsPgClient(runner);
    const [signalled] = await resolveResponseMisconceptionsWith(pg, [{ questionVersionId: current.itemId, selectedOptionId: input.selectedOptionId }]);
    await recordGradedAttemptSession(pg, {
      subjectUserId: input.subjectUserId, institutionId: sitting.institutionId, mode: 'DIAGNOSTIC', context: 'DIAGNOSTIC',
      sourceAttemptType: 'placement_test', sourceAttemptId: sitting.id, startedAt: sitting.startedAt,
      contentVersion: PLACEMENT_CONTENT_VERSION,
      responses: [{
        itemSource: 'CAREER_READINESS_QUESTION', itemId: current.itemId, itemVersion: current.itemVersion, skillId: current.skillId,
        answered: true, correct, marksAwarded: correct ? 1 : 0, marksPossible: 1, selectedOptionId: input.selectedOptionId,
        misconceptionCodeIds: (signalled?.misconceptions ?? []).map((item) => item.misconceptionCodeId),
      }],
    });
    return settle(runner, sitting);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Brings an in-progress sitting up to date: completes it at its deadline, keeps serving the
 * unanswered question, or asks the pure rule for the next step and applies it.
 */
async function settle(db: PersistenceDb, sitting: Sitting): Promise<PlacementTestView> {
  if (sitting.state === 'COMPLETED') return completedView(sitting);
  const served = await loadServedItems(db, sitting.id);
  const answers: PlacementAnswer[] = served
    .filter((item) => item.correct !== null)
    .map((item) => ({ item: item.item, correct: item.correct === true }));
  const unanswered = served.find((item) => item.correct === null);
  if (!sitting.expired && unanswered) return inProgressView(db, sitting, unanswered, answers.length);

  const eligible = sitting.expired ? [] : await loadEligiblePlacementItems(db);
  const before = await answeredInEarlierSittings(db, sitting.subjectUserId, sitting.id);
  const pool = retestPool(eligible, before);
  const elapsedMs = sitting.expired ? Math.max(sitting.elapsedMs, PLACEMENT_RULES.timeLimitMs) : sitting.elapsedMs;
  const step = nextPlacementStep({ pool, answers, elapsedMs });
  if (step.kind === 'STOP') return complete(db, sitting, step);

  const chosen = eligible.find((item) => item.key === step.item.key)!;
  const position = served.length + 1;
  await db.execute(sql`
    INSERT INTO placement_test_items
      (id, placement_test_id, subject_user_id, institution_id, position, item_source, item_id, item_version, skill_id, item_group,
       difficulty, discrimination, calibration_status, calibration_run_id)
    VALUES (${randomUUID()}::uuid, ${sitting.id}::uuid, ${sitting.subjectUserId}::uuid, ${sitting.institutionId}::uuid, ${position},
      'CAREER_READINESS_QUESTION', ${chosen.key}::uuid, ${chosen.itemVersion}, ${chosen.skillId}::uuid, ${chosen.group},
      ${chosen.difficulty}, ${chosen.discrimination}, ${chosen.calibrationStatus}, ${chosen.calibrationRunId}::uuid)
  `);
  return inProgressView(db, sitting, {
    position, itemId: chosen.key, itemVersion: chosen.itemVersion, skillId: chosen.skillId, item: chosen, correct: null,
  }, answers.length);
}

async function complete(db: PersistenceDb, sitting: Sitting, step: Extract<PlacementStep, { kind: 'STOP' }>): Promise<PlacementTestView> {
  const updated = await db.execute(sql`
    UPDATE placement_tests
    SET state = 'COMPLETED', completed_at = LEAST(now(), deadline_at), stop_reason = ${step.reason},
        placement_level = ${step.level}, items_answered = ${step.itemsAnswered}
    WHERE id = ${sitting.id}::uuid AND state = 'IN_PROGRESS'
    RETURNING completed_at
  `) as QueryResult<{ completed_at: Date | string }>;
  const completedAt = new Date(updated.rows[0]!.completed_at);
  // Copied in SQL, not through a JavaScript Date, which would drop the microseconds.
  await db.execute(sql`
    UPDATE learning_sessions s SET ended_at = t.completed_at
    FROM placement_tests t
    WHERE t.id = ${sitting.id}::uuid AND s.id = t.session_id AND s.ended_at IS NULL
  `);
  return {
    status: 'COMPLETED', placementTestId: sitting.id, placementLevel: step.level, stopReason: step.reason,
    questionsAnswered: step.itemsAnswered, completedAt: completedAt.toISOString(),
  };
}

async function inProgressView(db: PersistenceDb, sitting: Sitting, item: ServedItem, answered: number): Promise<PlacementTestView> {
  const found = await db.execute(sql`SELECT prompt, options FROM question_versions WHERE id = ${item.itemId}::uuid`) as QueryResult<{ prompt: string; options: unknown }>;
  const row = found.rows[0]!;
  return {
    status: 'IN_PROGRESS', placementTestId: sitting.id,
    question: { id: item.itemId, prompt: row.prompt, options: optionsOf(row.options), position: item.position },
    questionsAnswered: answered, maxQuestions: PLACEMENT_RULES.maxItems, deadlineAt: sitting.deadlineAt.toISOString(),
  };
}

function completedView(sitting: Sitting): PlacementTestView {
  return {
    status: 'COMPLETED', placementTestId: sitting.id, placementLevel: sitting.placementLevel!, stopReason: sitting.stopReason!,
    questionsAnswered: sitting.itemsAnswered!, completedAt: sitting.completedAt!.toISOString(),
  };
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

async function lockStudent(db: PersistenceDb, subjectUserId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('placement-test'), hashtext(${subjectUserId}))`);
}

const SITTING_COLUMNS = sql`
  id::text AS id, subject_user_id::text AS subject_user_id, institution_id::text AS institution_id, session_id::text AS session_id,
  state, started_at, deadline_at, completed_at, stop_reason, placement_level, items_answered,
  (extract(epoch FROM (now() - started_at)) * 1000)::float8 AS elapsed_ms, now() >= deadline_at AS expired`;

type SittingRow = {
  id: string; subject_user_id: string; institution_id: string | null; session_id: string; state: Sitting['state'];
  started_at: Date | string; deadline_at: Date | string; completed_at: Date | string | null; stop_reason: PlacementStopReason | null;
  placement_level: PlacementResultLevel | null; items_answered: number | null; elapsed_ms: number; expired: boolean;
};

function toSitting(row: SittingRow): Sitting {
  return {
    id: row.id, subjectUserId: row.subject_user_id, institutionId: row.institution_id, sessionId: row.session_id, state: row.state,
    startedAt: new Date(row.started_at), deadlineAt: new Date(row.deadline_at),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at), stopReason: row.stop_reason,
    placementLevel: row.placement_level, itemsAnswered: row.items_answered === null ? null : Number(row.items_answered),
    elapsedMs: Math.max(0, Number(row.elapsed_ms)), expired: row.expired === true,
  };
}

async function loadSitting(db: PersistenceDb, testId: string, subjectUserId: string, forUpdate = false): Promise<Sitting | null> {
  const found = await db.execute(forUpdate
    ? sql`SELECT ${SITTING_COLUMNS} FROM placement_tests WHERE id = ${testId}::uuid AND subject_user_id = ${subjectUserId}::uuid FOR UPDATE`
    : sql`SELECT ${SITTING_COLUMNS} FROM placement_tests WHERE id = ${testId}::uuid AND subject_user_id = ${subjectUserId}::uuid`) as QueryResult<SittingRow>;
  return found.rows[0] ? toSitting(found.rows[0]) : null;
}

async function loadOpenSitting(db: PersistenceDb, subjectUserId: string): Promise<Sitting | null> {
  const found = await db.execute(sql`
    SELECT ${SITTING_COLUMNS} FROM placement_tests
    WHERE subject_user_id = ${subjectUserId}::uuid AND state = 'IN_PROGRESS' FOR UPDATE
  `) as QueryResult<SittingRow>;
  return found.rows[0] ? toSitting(found.rows[0]) : null;
}

async function loadLatestCompleted(db: PersistenceDb, subjectUserId: string): Promise<Sitting | null> {
  const found = await db.execute(sql`
    SELECT ${SITTING_COLUMNS} FROM placement_tests
    WHERE subject_user_id = ${subjectUserId}::uuid AND state = 'COMPLETED'
    ORDER BY completed_at DESC, id DESC LIMIT 1
  `) as QueryResult<SittingRow>;
  return found.rows[0] ? toSitting(found.rows[0]) : null;
}

/** The sitting's served items in order, each with its answer's correctness (null while unanswered). */
async function loadServedItems(db: PersistenceDb, testId: string): Promise<ServedItem[]> {
  const found = await db.execute(sql`
    SELECT i.position, i.item_id::text AS item_id, i.item_version, i.skill_id::text AS skill_id, i.item_group,
           i.difficulty::float8 AS difficulty, i.discrimination::float8 AS discrimination, e.correct
    FROM placement_test_items i
    LEFT JOIN learning_attempt_events e
      ON e.source_attempt_type = 'placement_test' AND e.source_attempt_id = i.placement_test_id
     AND e.item_source = i.item_source AND e.item_id = i.item_id
    WHERE i.placement_test_id = ${testId}::uuid
    ORDER BY i.position
  `) as QueryResult<{
    position: number; item_id: string; item_version: number; skill_id: string; item_group: PlacementGroup;
    difficulty: number; discrimination: number; correct: boolean | null;
  }>;
  return found.rows.map((row) => ({
    position: Number(row.position), itemId: row.item_id.toLowerCase(), itemVersion: Number(row.item_version), skillId: row.skill_id,
    item: { key: row.item_id.toLowerCase(), group: row.item_group, difficulty: Number(row.difficulty), discrimination: Number(row.discrimination) },
    correct: row.correct === null ? null : row.correct === true,
  }));
}

/** Questions the student answered in their other placement sittings. */
async function answeredInEarlierSittings(db: PersistenceDb, subjectUserId: string, testId: string): Promise<ReadonlySet<string>> {
  const found = await db.execute(sql`
    SELECT DISTINCT item_id::text AS item_id FROM learning_attempt_events
    WHERE subject_user_id = ${subjectUserId}::uuid AND source_attempt_type = 'placement_test' AND source_attempt_id <> ${testId}::uuid
  `) as QueryResult<{ item_id: string }>;
  return new Set(found.rows.map((row) => row.item_id.toLowerCase()));
}

function assertUuid(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new PlacementTestError('INVALID_INPUT');
}
