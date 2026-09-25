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
import type { PersistenceDb } from './repositories.js';

export type PgClient = Pick<PoolClient, 'query'>;

export const learningAttemptContexts = ['PRACTICE', 'DIAGNOSTIC', 'ASSESSMENT', 'REVIEW'] as const;
export type LearningAttemptContext = (typeof learningAttemptContexts)[number];
export const learningSessionModes = ['LEARN', 'PRACTICE', 'REVIEW', 'ASSESSMENT', 'EXPLORE'] as const;
export type LearningSessionMode = (typeof learningSessionModes)[number];
export type LearningItemSource = 'CAREER_READINESS_QUESTION' | 'INSTITUTION_EXAM_QUESTION';
export type LearningSourceAttemptType = 'assessment_attempt' | 'exam_attempt';

/** The hint level from which a success is assisted (C5; ENG-04 moves the rule into learning-model). */
export const ASSISTED_HINT_LEVEL = 3;
export const MAX_HINT_LEVEL = 4;

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
}

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
 * - a hint level of 3 or more, or a tutor reply, makes the attempt assisted.
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
    assisted: hint >= ASSISTED_HINT_LEVEL || Boolean(input.tutorReplied),
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
          source_attempt_type, source_attempt_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,now())
       ON CONFLICT (source_attempt_type, source_attempt_id, item_source, item_id) DO NOTHING`,
      [randomUUID(), input.subjectUserId, institution, sessionId, attempt.itemSource, attempt.itemId, attempt.itemVersion,
        attempt.skillId, input.context, attempt.answered, attempt.correct, attempt.score, attempt.responseTimeMs,
        attempt.highestHintLevel, attempt.assisted, input.contentVersion, input.sourceAttemptType, input.sourceAttemptId],
    );
    written += inserted.rowCount ?? 0;
  }
  return { sessionId, written };
}

/** The institution a student currently belongs to — the same rule `currentContext` uses. */
async function currentInstitutionOf(client: PgClient, subjectUserId: string): Promise<string | null> {
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
