/**
 * The learner skill state projector (ENG-05): loads one student's facts, runs the pure rule
 * `learner-skill-state-v1` (packages/learning-model) and makes `learner_skill_state` equal to it.
 *
 * Why it exists: the planner, BKT shadow, review scheduler and faculty views all need "where does
 * this student stand on this skill", and ADR-034 requires that answer to be a projection rebuilt
 * from facts, never hand-edited. Grading only *requests* a projection (an outbox event written in
 * the grading transaction); the worker recomputes the whole student here, so a replayed or
 * duplicated event converges to the same rows and a full rebuild equals the incremental result.
 * Design: docs/architecture/learner-skill-state-table-design.md.
 *
 * Consent (ENG-01): nothing is written without the adaptive-learning purpose; a student without
 * it has their rows removed. Privacy deletion runs the projector after erasing the attempts, and
 * the rebuild of a student with no facts is the empty set. Nothing here touches readiness.
 */
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  LEARNER_SKILL_STATE_ALGORITHM_ID,
  projectLearnerSkillStates,
  type AttemptContext,
  type LearnerSkillStateRow,
  type ProjectionAttempt,
} from '@planthepath/learning-model/src/index.js';
import { createIntegrationEventEnvelope, type IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { hasConsentPurpose } from './consent-purposes.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import type { PersistenceDb } from './repositories.js';

type PgClient = Pick<PoolClient, 'query'>;
type QueryResult<T> = { rows: T[] };

export const LEARNER_SKILL_STATE_PROJECTION_REQUESTED = 'learning.skill_state.projection_requested';
export const LEARNER_SKILL_STATE_CONSUMER = 'learner-skill-state-projector';
/** The value of one.learner_skill_state_writer that the 0052 trigger accepts. */
const WRITER = 'learner-skill-state-projector';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SkillStateProjectionReason = 'ATTEMPTS_RECORDED' | 'CONSENT_GRANTED';

export interface ProjectionOutcome {
  /** Whether the student held adaptive-learning when the projector ran. */
  readonly consented: boolean;
  readonly written: number;
  readonly deleted: number;
}

/**
 * Ask the worker to project one student. Call inside the transaction that recorded the facts
 * (or the consent grant), so the request exists exactly when they do.
 */
export async function requestSkillStateProjection(
  client: PgClient,
  input: { readonly subjectUserId: string; readonly reason: SkillStateProjectionReason; readonly correlationId: string },
): Promise<string> {
  const id = randomUUID();
  const payload = { subjectUserId: input.subjectUserId, reason: input.reason };
  // Validates the payload against the registered schema before anything is written.
  createIntegrationEventEnvelope({
    eventId: id, eventType: LEARNER_SKILL_STATE_PROJECTION_REQUESTED, eventVersion: 1,
    occurredAt: new Date().toISOString(), aggregateId: input.subjectUserId, correlationId: input.correlationId, payload,
  });
  await client.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
     VALUES ($1::uuid,'user',$2::uuid,$3,1,$4::jsonb,$5::uuid,$6)`,
    [id, input.subjectUserId, LEARNER_SKILL_STATE_PROJECTION_REQUESTED, JSON.stringify(payload), input.subjectUserId, input.correlationId],
  );
  return id;
}

/** Outbox consumer: recompute the student named in the event, at most once per event. */
export async function consumeSkillStateProjectionRequested(
  db: PersistenceDb,
  event: IntegrationEventEnvelope,
): Promise<{ readonly executed: boolean; readonly result?: ProjectionOutcome }> {
  if (event.eventType !== LEARNER_SKILL_STATE_PROJECTION_REQUESTED || event.eventVersion !== 1) {
    throw new Error('event is outside the skill state projector contract');
  }
  const subjectUserId = typeof event.payload.subjectUserId === 'string' ? event.payload.subjectUserId : '';
  if (!UUID.test(subjectUserId) || event.aggregateId !== subjectUserId) throw new Error('invalid skill state projection event');
  return handleEventIdempotently(db, {
    consumerName: LEARNER_SKILL_STATE_CONSUMER,
    eventId: event.eventId,
    failureClass: 'SKILL_STATE_PROJECTION_FAILED',
    effect: (tx) => projectSubjectSkillState(tx, subjectUserId),
  });
}

/**
 * Make one student's rows equal to learner-skill-state-v1 over their facts. Without the
 * adaptive-learning purpose the answer is "no rows". Runs in its own transaction (a savepoint
 * when the caller already has one), under a per-student lock so two workers cannot interleave.
 */
export async function projectSubjectSkillState(db: PersistenceDb, subjectUserId: string): Promise<ProjectionOutcome> {
  if (!UUID.test(subjectUserId)) throw new Error('subjectUserId must be a UUID');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('learner_skill_state'), hashtext(${subjectUserId}))`);
    await tx.execute(sql`SELECT set_config('one.learner_skill_state_writer', ${WRITER}, true)`);
    const consented = await hasConsentPurpose(tx, subjectUserId, 'adaptive-learning');
    const desired = consented ? projectLearnerSkillStates(await loadProjectionAttempts(tx, subjectUserId)) : [];
    const keep = desired.map((row) => row.skillId);
    const deleted = await tx.execute(sql`
      WITH gone AS (
        DELETE FROM learner_skill_state
        WHERE subject_user_id = ${subjectUserId}::uuid AND NOT (skill_id = ANY(${`{${keep.join(',')}}`}::uuid[]))
        RETURNING 1
      ) SELECT count(*)::int AS count FROM gone
    `) as QueryResult<{ count: number }>;
    for (const row of desired) await upsertRow(tx, subjectUserId, row);
    return { consented, written: desired.length, deleted: Number(deleted.rows[0]?.count ?? 0) };
  });
}

/**
 * Remove a student's projection when they withdraw adaptive-learning. Call in the transaction
 * that records the withdrawal. Their attempts stay; a later grant rebuilds the same rows.
 */
export async function clearLearnerSkillStateForWithdrawal(db: PersistenceDb, subjectUserId: string): Promise<number> {
  if (!UUID.test(subjectUserId)) throw new Error('subjectUserId must be a UUID');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('learner_skill_state'), hashtext(${subjectUserId}))`);
    await tx.execute(sql`SELECT set_config('one.learner_skill_state_writer', ${WRITER}, true)`);
    const deleted = await tx.execute(sql`
      WITH gone AS (DELETE FROM learner_skill_state WHERE subject_user_id = ${subjectUserId}::uuid RETURNING 1)
      SELECT count(*)::int AS count FROM gone
    `) as QueryResult<{ count: number }>;
    return Number(deleted.rows[0]?.count ?? 0);
  });
}

/**
 * Full rebuild: every student with attempts or existing rows, one transaction each. Idempotent
 * and safe beside the worker. The recovery path after a rule change, and the test oracle.
 */
export async function rebuildLearnerSkillState(
  db: PersistenceDb,
): Promise<{ readonly subjects: number; readonly written: number; readonly deleted: number }> {
  const subjects = await db.execute(sql`
    SELECT subject_user_id FROM learning_attempt_events
    UNION
    SELECT subject_user_id FROM learner_skill_state
    ORDER BY 1
  `) as QueryResult<{ subject_user_id: string }>;
  let written = 0;
  let deleted = 0;
  for (const { subject_user_id: subjectUserId } of subjects.rows) {
    const outcome = await projectSubjectSkillState(db, subjectUserId);
    written += outcome.written;
    deleted += outcome.deleted;
  }
  return { subjects: subjects.rows.length, written, deleted };
}

/**
 * One student's attempts, each resolved to the skills it bears on:
 *  - an item with a skill: that skill;
 *  - an institution exam item (skill NULL): the topics its paper's subject was mapped to at the
 *    moment of the attempt, and only once the result is published (0030's rules).
 * Misconception ids recorded on the attempt become codes filed under each code's own skill.
 */
async function loadProjectionAttempts(db: PersistenceDb, subjectUserId: string): Promise<ProjectionAttempt[]> {
  const found = await db.execute(sql`
    SELECT e.id, e.item_id, e.context, e.answered, e.correct, e.highest_hint_level, e.assisted, e.occurred_at,
           e.institution_id, e.misconception_code_ids,
           CASE
             WHEN e.skill_id IS NOT NULL THEN ARRAY[e.skill_id]
             WHEN e.source_attempt_type = 'exam_attempt' THEN COALESCE((
               SELECT array_agg(DISTINCT l.topic_id)
               FROM exam_attempts a
               JOIN exam_results r ON r.attempt_id = a.id AND r.published
               JOIN exam_definitions d ON d.id = a.definition_id
               JOIN exam_subject_topic_links l ON l.exam_subject_id = d.subject_id
                 AND l.created_at <= e.occurred_at AND (l.retired_at IS NULL OR l.retired_at > e.occurred_at)
               WHERE a.id = e.source_attempt_id AND a.student_user_id = e.subject_user_id
             ), '{}'::uuid[])
             ELSE '{}'::uuid[]
           END AS skill_ids
    FROM learning_attempt_events e
    WHERE e.subject_user_id = ${subjectUserId}::uuid
  `) as QueryResult<{
    id: string; item_id: string; context: AttemptContext; answered: boolean; correct: boolean; highest_hint_level: number;
    assisted: boolean; occurred_at: Date | string; institution_id: string | null; misconception_code_ids: string[]; skill_ids: string[];
  }>;
  const codeIds = [...new Set(found.rows.flatMap((row) => row.misconception_code_ids ?? []))];
  const codes = new Map<string, { code: string; skillId: string }>();
  if (codeIds.length > 0) {
    const catalogue = await db.execute(sql`
      SELECT id, code, skill_id FROM misconception_codes WHERE id = ANY(${`{${codeIds.join(',')}}`}::uuid[])
    `) as QueryResult<{ id: string; code: string; skill_id: string }>;
    for (const row of catalogue.rows) codes.set(row.id, { code: row.code, skillId: row.skill_id });
  }
  return found.rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    context: row.context,
    answered: row.answered,
    correct: row.correct,
    highestHintLevel: Number(row.highest_hint_level),
    assisted: row.assisted,
    occurredAt: new Date(row.occurred_at).toISOString(),
    institutionId: row.institution_id,
    skillIds: row.skill_ids ?? [],
    misconceptions: (row.misconception_code_ids ?? []).flatMap((id) => {
      const code = codes.get(id);
      return code ? [code] : [];
    }),
  }));
}

async function upsertRow(tx: PersistenceDb, subjectUserId: string, row: LearnerSkillStateRow): Promise<void> {
  if (row.algorithmVersion !== LEARNER_SKILL_STATE_ALGORITHM_ID) throw new Error('unexpected skill state algorithm');
  await tx.execute(sql`
    INSERT INTO learner_skill_state
      (subject_user_id, skill_id, institution_id, attempt_count, attempt_day_count, unaided_success_count,
       unaided_success_day_count, assisted_success_count, last_attempt_at, evidence_stage, evidence_band,
       active_misconception_codes, mastery_likelihood, mastery_uncertainty, mastery_algorithm_version,
       review_stability, review_difficulty, review_due_at, review_algorithm_version, algorithm_version)
    VALUES (${subjectUserId}::uuid, ${row.skillId}::uuid, ${row.institutionId}::uuid, ${row.attemptCount}, ${row.attemptDayCount},
            ${row.unaidedSuccessCount}, ${row.unaidedSuccessDayCount}, ${row.assistedSuccessCount},
            ${row.lastAttemptAt}::timestamptz, ${row.evidenceStage}, ${row.evidenceBand},
            ${textArrayLiteral(row.activeMisconceptionCodes)}::text[], NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${row.algorithmVersion})
    ON CONFLICT (subject_user_id, skill_id) DO UPDATE SET
      institution_id = EXCLUDED.institution_id,
      attempt_count = EXCLUDED.attempt_count,
      attempt_day_count = EXCLUDED.attempt_day_count,
      unaided_success_count = EXCLUDED.unaided_success_count,
      unaided_success_day_count = EXCLUDED.unaided_success_day_count,
      assisted_success_count = EXCLUDED.assisted_success_count,
      last_attempt_at = EXCLUDED.last_attempt_at,
      evidence_stage = EXCLUDED.evidence_stage,
      evidence_band = EXCLUDED.evidence_band,
      active_misconception_codes = EXCLUDED.active_misconception_codes,
      mastery_likelihood = EXCLUDED.mastery_likelihood,
      mastery_uncertainty = EXCLUDED.mastery_uncertainty,
      mastery_algorithm_version = EXCLUDED.mastery_algorithm_version,
      review_stability = EXCLUDED.review_stability,
      review_difficulty = EXCLUDED.review_difficulty,
      review_due_at = EXCLUDED.review_due_at,
      review_algorithm_version = EXCLUDED.review_algorithm_version,
      algorithm_version = EXCLUDED.algorithm_version
  `);
}

/** Codes match ^[A-Z][A-Z0-9_]{2,63}$ (0049), so they need no quoting inside an array literal. */
function textArrayLiteral(values: readonly string[]): string {
  for (const value of values) if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) throw new Error('a misconception code has an unexpected form');
  return `{${values.join(',')}}`;
}
