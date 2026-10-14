/**
 * The learning attempt log (ENG-03): one append-only row per graded response, written in the
 * same transaction as the grading it records, plus the session it belongs to.
 *
 * Why it exists: every later engine goal (stages, skill state, BKT, planner, FSRS, calibration)
 * reads "who answered which item version, how, with how much help". Before this, that fact was
 * scattered across mutable exam answers, boolean responses and best-effort telemetry written
 * outside the transaction. Design: docs/architecture/learning-attempt-events-table-design.md
 * and learning-sessions-table-design.md.
 *
 * `normaliseLearningAttempt` is pure and deterministic (unit and property tested); the writers
 * take a pg-style client so both the pg transactions in career-readiness.ts and the drizzle
 * transactions in the exam controller can use them (see `drizzleAsPgClient`).
 *
 * Recording needs no consent purpose: the row is the record of work the student submitted for
 * grading. `adaptive-learning` gates what is derived from it (ENG-05), not the record.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import {
  ASSISTED_HINT_LEVEL,
  MAX_HINT_LEVEL,
  isAssistedAttempt,
  summariseSkillEvidence,
  type AttemptContext,
  type EvidenceStage,
} from '@planthepath/learning-model/src/index.js';
import type { PersistenceDb } from './repositories.js';
import { requestSkillStateProjection } from './learner-skill-state.js';

export type PgClient = Pick<PoolClient, 'query'>;

export const learningAttemptContexts = ['PRACTICE', 'DIAGNOSTIC', 'ASSESSMENT', 'REVIEW'] as const;
export type LearningAttemptContext = (typeof learningAttemptContexts)[number];
/** DIAGNOSTIC (0064) is the placement test's sitting (ENG-14). */
export const learningSessionModes = ['LEARN', 'PRACTICE', 'REVIEW', 'ASSESSMENT', 'EXPLORE', 'DIAGNOSTIC'] as const;
export type LearningSessionMode = (typeof learningSessionModes)[number];
/** CODE_TASK (0113): a program graded in the code sandbox (ENG-12, ADR-049). */
export type LearningItemSource = 'CAREER_READINESS_QUESTION' | 'INSTITUTION_EXAM_QUESTION' | 'CODE_TASK';
/**
 * placement_test (0064): the source of the placement test's DIAGNOSTIC attempts (ENG-14).
 * learning_step (0072): a practice or review step the student takes on a planner decision (ENG-18).
 * code_submission (0113): a program run in the code sandbox (ENG-12).
 */
export type LearningSourceAttemptType = 'assessment_attempt' | 'exam_attempt' | 'placement_test' | 'learning_step' | 'code_submission';

/** The assisted rule lives in learning-model (ENG-04); re-exported so existing imports keep working. */
export { ASSISTED_HINT_LEVEL, MAX_HINT_LEVEL };

export interface GradedResponseInput {
  readonly itemSource: LearningItemSource;
  readonly itemId: string;
  readonly itemVersion: number;
  readonly skillId: string | null;
  readonly answered: boolean;
  readonly correct: boolean;
  /** Credit earned for the item. Negative marking is not carried: anything below 0 records 0. */
  readonly marksAwarded: number;
  readonly marksPossible: number;
  readonly responseTimeMs?: number | null;
  readonly highestHintLevel?: number;
  /** Any AI tutor reply on the item (ADR-033's recommended rule). */
  readonly tutorReplied?: boolean;
  /** The option chosen on a choice item from the readiness bank (ENG-07 link, 0052). */
  readonly selectedOptionId?: string | null;
  /** Published misconception_codes.id values the chosen option signalled, from resolveResponseMisconceptions. */
  readonly misconceptionCodeIds?: readonly string[];
}

export interface NormalisedLearningAttempt {
  readonly itemSource: LearningItemSource;
  readonly itemId: string;
  readonly itemVersion: number;
  readonly skillId: string | null;
  readonly answered: boolean;
  readonly correct: boolean;
  readonly score: number;
  readonly responseTimeMs: number | null;
  readonly highestHintLevel: number;
  readonly assisted: boolean;
  readonly selectedOptionId: string | null;
  readonly misconceptionCodeIds: readonly string[];
}

/** The 0052 CHECK allows at most this many codes on one attempt. */
export const MAX_MISCONCEPTIONS_PER_ATTEMPT = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LearningAttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningAttemptError';
  }
}

/**
 * Turn one graded response into the row the log stores. Pure: identical input, identical output.
 *
 * - an unanswered item is never correct;
 * - score is the fraction of credit earned, clamped to [0, 1] and rounded to the column's 4 places;
 * - a hint level of 3 or more, or a tutor reply, makes the attempt assisted;
 * - misconception codes are recorded only on a wrong answer (sorted, unique); a blank records
 *   neither an option nor a code.
 */
export function normaliseLearningAttempt(input: GradedResponseInput): NormalisedLearningAttempt {
  if (!Number.isInteger(input.itemVersion) || input.itemVersion < 1) throw new LearningAttemptError('item version must be a positive integer');
  const hint = input.highestHintLevel ?? 0;
  if (!Number.isInteger(hint) || hint < 0 || hint > MAX_HINT_LEVEL) throw new LearningAttemptError('hint level must be an integer from 0 to 4');
  const time = input.responseTimeMs ?? null;
  if (time !== null && (!Number.isFinite(time) || time < 0)) throw new LearningAttemptError('response time must be a non-negative number of milliseconds');
  if (!Number.isFinite(input.marksPossible) || input.marksPossible <= 0) throw new LearningAttemptError('an item must be worth more than zero');
  if (!Number.isFinite(input.marksAwarded)) throw new LearningAttemptError('marks awarded must be a number');

  const answered = input.answered;
  const correct = answered && input.correct;
  const selectedOptionId = input.selectedOptionId ?? null;
  if (selectedOptionId !== null && (!answered || selectedOptionId.length < 1 || selectedOptionId.length > 64)) {
    throw new LearningAttemptError('a selected option must be 1 to 64 characters on an answered item');
  }
  const misconceptionCodeIds = [...new Set(input.misconceptionCodeIds ?? [])].sort();
  if (misconceptionCodeIds.some((id) => !UUID.test(id))) throw new LearningAttemptError('a misconception code id must be a UUID');
  if (misconceptionCodeIds.length > MAX_MISCONCEPTIONS_PER_ATTEMPT) throw new LearningAttemptError('too many misconception codes on one attempt');
  if (misconceptionCodeIds.length > 0 && (!answered || correct)) throw new LearningAttemptError('only a wrong answer can signal a misconception');
  const fraction = Math.min(1, Math.max(0, input.marksAwarded / input.marksPossible));
  const score = answered ? Math.round(fraction * 10_000) / 10_000 : 0;
  return {
    itemSource: input.itemSource,
    itemId: input.itemId,
    itemVersion: input.itemVersion,
    skillId: input.skillId,
    answered,
    correct,
    score,
    responseTimeMs: time === null ? null : Math.round(time),
    highestHintLevel: hint,
    assisted: isAssistedAttempt({ highestHintLevel: hint, tutorReplied: input.tutorReplied === true }),
    selectedOptionId,
    misconceptionCodeIds,
  };
}

export interface RecordAttemptSessionInput {
  readonly subjectUserId: string;
  /** Pass the institution when the source knows it (an exam); otherwise it is resolved from the student's current relationship. */
  readonly institutionId?: string | null;
  readonly mode: LearningSessionMode;
  readonly context: LearningAttemptContext;
  readonly sourceAttemptType: LearningSourceAttemptType;
  readonly sourceAttemptId: string;
  readonly startedAt: Date | string;
  readonly contentVersion: string;
  readonly responses: readonly GradedResponseInput[];
}

/**
 * Write the session and one attempt row per graded response, inside the caller's transaction.
 * Replay-safe: a second call for the same source attempt writes nothing (unique indexes).
 * Times come from the database clock, never Node's.
 */
export async function recordGradedAttemptSession(
  client: PgClient,
  input: RecordAttemptSessionInput,
): Promise<{ readonly sessionId: string; readonly written: number }> {
  const attempts = input.responses.map(normaliseLearningAttempt);
  const institution = input.institutionId !== undefined && input.institutionId !== null
    ? input.institutionId
    : await currentInstitutionOf(client, input.subjectUserId);

  const candidateId = randomUUID();
  await client.query(
    `INSERT INTO learning_sessions (id, subject_user_id, institution_id, mode, source_type, source_id, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,LEAST($7::timestamptz, now()),now())
     ON CONFLICT (source_type, source_id) WHERE source_type IS NOT NULL DO NOTHING`,
    [candidateId, input.subjectUserId, institution, input.mode, input.sourceAttemptType, input.sourceAttemptId,
      input.startedAt instanceof Date ? input.startedAt.toISOString() : input.startedAt],
  );
  const session = await client.query<{ id: string }>(
    'SELECT id FROM learning_sessions WHERE source_type=$1 AND source_id=$2',
    [input.sourceAttemptType, input.sourceAttemptId],
  );
  const sessionId = session.rows[0]?.id ?? candidateId;

  let written = 0;
  for (const attempt of attempts) {
    const inserted = await client.query(
      `INSERT INTO learning_attempt_events
         (id, subject_user_id, institution_id, session_id, item_source, item_id, item_version, skill_id, context,
          answered, correct, score, response_time_ms, highest_hint_level, assisted, content_version,
          source_attempt_type, source_attempt_id, occurred_at, selected_option_id, misconception_code_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now(),$19,$20::uuid[])
       ON CONFLICT (source_attempt_type, source_attempt_id, item_source, item_id) DO NOTHING`,
      [randomUUID(), input.subjectUserId, institution, sessionId, attempt.itemSource, attempt.itemId, attempt.itemVersion,
        attempt.skillId, input.context, attempt.answered, attempt.correct, attempt.score, attempt.responseTimeMs,
        attempt.highestHintLevel, attempt.assisted, input.contentVersion, input.sourceAttemptType, input.sourceAttemptId,
        attempt.selectedOptionId, `{${attempt.misconceptionCodeIds.join(',')}}`],
    );
    written += inserted.rowCount ?? 0;
  }
  // ENG-05: ask the worker to project this student's skill state from the new facts. Same
  // transaction, so the request exists exactly when the attempts do. Consent is checked when the
  // projector runs, not here: recording is not profiling.
  if (written > 0) {
    await requestSkillStateProjection(client, {
      subjectUserId: input.subjectUserId, reason: 'ATTEMPTS_RECORDED',
      correlationId: `skill-state:${input.sourceAttemptType}:${input.sourceAttemptId}`,
    });
  }
  return { sessionId, written };
}

/**
 * The stage (learning-model-v1) a student's skill has reached from the attempt log, read inside
 * the caller's transaction so it includes attempts that transaction has just written. Evidence
 * writers stamp it on evidence_records.stage_at_capture at insert (ENG-04). Attempts without a
 * known skill — institution exam rows, whose subject→topic mapping ENG-05 resolves — do not
 * count here, which can only understate the stage.
 */
export async function skillStageAtCapture(client: PgClient, subjectUserId: string, skillId: string): Promise<EvidenceStage> {
  const result = await client.query<{
    id: string; item_id: string; context: AttemptContext; correct: boolean; highest_hint_level: number; assisted: boolean; occurred_at: Date;
  }>(
    `SELECT id, item_id, context, correct, highest_hint_level, assisted, occurred_at
     FROM learning_attempt_events WHERE subject_user_id=$1 AND skill_id=$2`,
    [subjectUserId, skillId],
  );
  return summariseSkillEvidence(result.rows.map((row) => ({
    id: row.id, itemId: row.item_id, context: row.context, correct: row.correct,
    highestHintLevel: row.highest_hint_level, assisted: row.assisted, occurredAt: new Date(row.occurred_at).toISOString(),
  }))).stage;
}

/** The institution a student currently belongs to — the same rule `currentContext` uses. */
export async function currentInstitutionOf(client: PgClient, subjectUserId: string): Promise<string | null> {
  const result = await client.query<{ institution_id: string }>(
    `SELECT institution_id FROM institution_relationships
     WHERE student_user_id=$1 AND state IN ('ACTIVE','VERIFIED')
       AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
     ORDER BY effective_from DESC LIMIT 1`,
    [subjectUserId],
  );
  return result.rows[0]?.institution_id ?? null;
}

/**
 * A pg-style `query(text, params)` over a drizzle database or transaction, so code written
 * against pg clients (the readiness path, the attempt log) runs inside a drizzle transaction.
 * `$n` placeholders become bound parameters; nothing is interpolated into the SQL text.
 * Each value is bound as a single parameter (arrays included), exactly as pg would bind it.
 */
export function drizzleAsPgClient(db: PersistenceDb): PgClient {
  const query = async (text: string, params: readonly unknown[] = []): Promise<{ rows: unknown[]; rowCount: number | null }> => {
    const parts = text.split(/\$(\d+)/);
    const chunks: SQL[] = [sql.raw(parts[0] ?? '')];
    for (let index = 1; index < parts.length; index += 2) {
      const position = Number(parts[index]);
      if (!Number.isInteger(position) || position < 1 || position > params.length) throw new Error(`missing parameter $${parts[index]}`);
      chunks.push(sql`${sql.param(params[position - 1])}`);
      chunks.push(sql.raw(parts[index + 1] ?? ''));
    }
    const result = await db.execute(sql.join(chunks, sql.raw(''))) as unknown as { rows: unknown[]; rowCount?: number | null };
    return { rows: result.rows, rowCount: result.rowCount ?? null };
  };
  return { query } as unknown as PgClient;
}
