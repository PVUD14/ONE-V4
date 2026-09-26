/**
 * Database tests for the learner skill state projection (ENG-05, migration 0052) and ENG-07's
 * link from a tagged wrong option to the attempt log and the projection.
 *
 * Why: the acceptance is "rebuilding from attempts reproduces the table exactly; the projector
 * is idempotent", plus ENG-07's deferred "a wrong option tagged with a code records that code
 * on the attempt and in learner_skill_state". Those guarantees live in the outbox consumer,
 * transactions, triggers and constraints, so they are tested against a real database. Every
 * person, topic link and misconception here is synthetic.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { createIntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { estimateMastery } from '@planthepath/mastery-bkt/src/index.js';
import type { ImportPackageManifest } from '@planthepath/career-readiness/src/index.js';
import * as schema from '../src/schema.js';
import type { PersistenceDb } from '../src/repositories.js';
import {
  publishCareerReadinessPilot,
  stageImportManifest,
  startAssessmentAttempt,
  submitAssessmentAttempt,
  type PilotFixture,
} from '../src/career-readiness.js';
import {
  createMisconceptionCodeDraft,
  createQuestionOptionMisconceptionDraft,
  publishEngineContentRelease,
  transitionEngineContent,
} from '../src/misconceptions.js';
import {
  LEARNER_SKILL_STATE_PROJECTION_REQUESTED,
  clearLearnerSkillStateForWithdrawal,
  consumeSkillStateProjectionRequested,
  listDueReviews,
  projectSubjectSkillState,
  rebuildLearnerSkillState,
  requestSkillStateProjection,
} from '../src/learner-skill-state.js';
import { createLocalIntegrationEventPublisher } from '../src/automation-workers.js';
import { scheduleReviewDays } from '@planthepath/review-scheduler/src/index.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
const SHA = 'c'.repeat(64);
const CONSENT_VERSION = 'eng05-synthetic-test';
const actors = {
  authorUserId: '52000000-0000-4000-8000-000000000001',
  reviewerUserId: '52000000-0000-4000-8000-000000000002',
  publisherUserId: '52000000-0000-4000-8000-000000000003',
};
let fixture: PilotFixture;
let topicA: string;
let topicB: string;
let sourceRecordId: string;

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
  await pool.query('TRUNCATE users CASCADE');
  for (const [index, userId] of Object.values(actors).entries()) {
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [userId, `skill-state-test:${index}`, `skill-state-${index}@example.test`]);
  }
  const pilotBytes = await readFile(new URL('../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const staging = JSON.parse(await readFile(new URL('../../../data/career-readiness/v4-staging-manifest.json', import.meta.url), 'utf8')) as ImportPackageManifest;
  await stageImportManifest(pool, staging, actors.authorUserId);
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
  [topicA, topicB] = fixture.topics.map((topic) => topic.id) as [string, string];

  // The adaptive-learning purpose, live for this suite only. Publishing the real definition is
  // HG-6; this synthetic one is retired in afterAll.
  await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', $1, 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')
    ON CONFLICT (consent_key, version) DO UPDATE SET retired_at = NULL`, [CONSENT_VERSION]);

  // A release-eligible synthetic source record for publishing engine content.
  const runId = randomUUID();
  const packageId = randomUUID();
  sourceRecordId = randomUUID();
  await pool.query(
    `INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
     VALUES ($1,$2,'synthetic/eng-05',$3,$4,'eng05-test','STAGED',$5,now())`,
    [runId, `eng05-${runId}`, 'd'.repeat(40), SHA, actors.authorUserId],
  );
  await pool.query(
    `INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
     VALUES ($1,$2,$3,'synthetic/eng-05',$4,$5,'eng05-test','[]','{}','{}')`,
    [packageId, runId, `eng05-${packageId}`, 'd'.repeat(40), SHA],
  );
  await pool.query(
    `INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
       rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
     VALUES ($1,$2,'ENGINE_CONTENT','eng05','synthetic.json',$3,'Synthetic','APPROVED','APPROVED','APPROVED','MAPPED','UNIQUE','ELIGIBLE',true)`,
    [sourceRecordId, packageId, SHA],
  );
});

afterAll(async () => {
  await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning' AND version = $1", [CONSENT_VERSION]);
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function newUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`, [id, `sub-${id}`, `${id}@example.test`]);
  return id;
}

async function newInstitution(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', $2)", [id, `Skill state college ${id.slice(0, 8)}`]);
  return id;
}

async function consent(userId: string, action: 'GRANTED' | 'WITHDRAWN'): Promise<void> {
  await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
    VALUES ($1,$2,'adaptive-learning',$3,$4, clock_timestamp())`, [randomUUID(), userId, CONSENT_VERSION, action]);
}

/** Run every pending projection request through the consumer, as the local dispatcher would. */
async function drain(): Promise<number> {
  const pending = await pool.query<{ id: string; aggregate_id: string; payload: Record<string, unknown>; correlation_id: string; occurred_at: Date }>(
    `SELECT o.id, o.aggregate_id, o.payload, o.correlation_id, o.occurred_at FROM outbox_events o
     WHERE o.event_type = $1 AND NOT EXISTS (
       SELECT 1 FROM event_consumer_receipts r WHERE r.event_id = o.id AND r.status = 'SUCCEEDED')
     ORDER BY o.occurred_at, o.id`, [LEARNER_SKILL_STATE_PROJECTION_REQUESTED],
  );
  for (const row of pending.rows) {
    await consumeSkillStateProjectionRequested(db, envelopeOf(row));
  }
  return pending.rows.length;
}

function envelopeOf(row: { id: string; aggregate_id: string; payload: Record<string, unknown>; correlation_id: string; occurred_at: Date }) {
  return createIntegrationEventEnvelope({
    eventId: row.id, eventType: LEARNER_SKILL_STATE_PROJECTION_REQUESTED, eventVersion: 1,
    occurredAt: new Date(row.occurred_at).toISOString(), aggregateId: row.aggregate_id,
    correlationId: row.correlation_id, payload: row.payload,
  });
}

async function snapshot(subjectUserIds?: readonly string[]): Promise<Record<string, unknown>[]> {
  const result = subjectUserIds
    ? await pool.query('SELECT * FROM learner_skill_state WHERE subject_user_id = ANY($1::uuid[]) ORDER BY subject_user_id, skill_id', [subjectUserIds])
    : await pool.query('SELECT * FROM learner_skill_state ORDER BY subject_user_id, skill_id');
  return result.rows;
}

/** Throw the table away as the projector would (the only writer allowed), to prove a rebuild restores it. */
async function loseProjection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('one.learner_skill_state_writer', 'learner-skill-state-projector', true)");
    await client.query('DELETE FROM learner_skill_state');
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

interface AttemptFact {
  readonly skillId?: string | null;
  readonly itemId?: string;
  readonly correct?: boolean;
  readonly answered?: boolean;
  readonly hint?: number;
  readonly occurredAt: string;
  readonly institutionId?: string | null;
  readonly examAttemptId?: string;
}

/** Append one attempt fact (with its session) and request a projection, as a grading path does. */
async function recordFact(studentId: string, fact: AttemptFact): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sessionId = randomUUID();
    const sourceId = fact.examAttemptId ?? randomUUID();
    const exam = fact.examAttemptId !== undefined;
    await client.query(
      `INSERT INTO learning_sessions (id, subject_user_id, institution_id, mode, source_type, source_id, started_at, ended_at)
       VALUES ($1,$2,$3,'ASSESSMENT',$4,$5,$6::timestamptz - interval '5 minutes',$6::timestamptz)
       ON CONFLICT (source_type, source_id) WHERE source_type IS NOT NULL DO NOTHING`,
      [sessionId, studentId, fact.institutionId ?? null, exam ? 'exam_attempt' : 'assessment_attempt', sourceId, fact.occurredAt],
    );
    const session = await client.query<{ id: string }>('SELECT id FROM learning_sessions WHERE source_type=$1 AND source_id=$2',
      [exam ? 'exam_attempt' : 'assessment_attempt', sourceId]);
    const hint = fact.hint ?? 0;
    const answered = fact.answered ?? true;
    const correct = answered && (fact.correct ?? true);
    await client.query(
      `INSERT INTO learning_attempt_events
         (id, subject_user_id, institution_id, session_id, item_source, item_id, item_version, skill_id, context, answered, correct,
          score, highest_hint_level, assisted, content_version, source_attempt_type, source_attempt_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,'ASSESSMENT',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [randomUUID(), studentId, fact.institutionId ?? null, session.rows[0]!.id,
        exam ? 'INSTITUTION_EXAM_QUESTION' : 'CAREER_READINESS_QUESTION', fact.itemId ?? randomUUID(),
        exam ? null : (fact.skillId ?? topicA), answered, correct, correct ? 1 : 0, hint, hint >= 3,
        exam ? 'institution-exam-v1' : 'assessment-v1', exam ? 'exam_attempt' : 'assessment_attempt', sourceId, fact.occurredAt],
    );
    await requestSkillStateProjection(client, { subjectUserId: studentId, reason: 'ATTEMPTS_RECORDED', correlationId: `skill-state-test-${randomUUID()}` });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** An institution exam paper on a subject, sat by the student, with its result row. */
async function examPaper(studentId: string, institutionId: string, subjectId: string, published: boolean): Promise<string> {
  const definitionId = randomUUID();
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO exam_definitions
       (id, institution_id, subject_id, title, exam_kind, lifecycle_state, total_marks, duration_seconds,
        starts_at, ends_at, publish_results_immediately, created_by_user_id, published_at)
     VALUES ($1,$2,$3,'Synthetic paper','UNIT_TEST','PUBLISHED',10,1800, now() - interval '30 days', now() + interval '1 day', $5, $4, now())`,
    [definitionId, institutionId, subjectId, actors.authorUserId, published],
  );
  await pool.query(
    `INSERT INTO exam_attempts (id, institution_id, definition_id, student_user_id, attempt_number, status, paper_seed, submitted_at)
     VALUES ($1,$2,$3,$4,1,'SUBMITTED',$5, now())`, [attemptId, institutionId, definitionId, studentId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO exam_results (id, attempt_id, score, max_score, percentage, correct_count, wrong_count, not_attempted_count, time_taken_seconds, published)
     VALUES ($1,$2,1,1,100,1,0,0,60,$3)`, [randomUUID(), attemptId, published],
  );
  return attemptId;
}

async function examSubject(institutionId: string): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO exam_subjects (id, institution_id, name) VALUES ($1,$2,$3)', [id, institutionId, `Synthetic subject ${id.slice(0, 8)}`]);
  return id;
}

async function link(institutionId: string, subjectId: string, topicId: string, createdAt: string, retiredAt: string | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO exam_subject_topic_links (id, exam_subject_id, institution_id, topic_id, weight, created_by_user_id, created_at, retired_at)
     VALUES ($1,$2,$3,$4,0.5,$5,$6,$7)`, [randomUUID(), subjectId, institutionId, topicId, actors.authorUserId, createdAt, retiredAt],
  );
}

const day = (n: number, hour = 5): string => new Date(Date.UTC(2026, 7, n, hour)).toISOString();

// ---------------------------------------------------------------------------
// ENG-07's deferred acceptance, end to end through the readiness check
// ---------------------------------------------------------------------------

describe('a wrong option tagged with a code (ENG-07 acceptance, completed by ENG-05)', () => {
  it('records the code on the attempt at grading time and makes it active in learner_skill_state', async () => {
    const studentId = await newUser();
    await consent(studentId, 'GRANTED');
    const started = await startAssessmentAttempt(pool, {
      subjectUserId: studentId, assessmentDefinitionId: fixture.assessment.id,
      correlationId: `start-${randomUUID()}`, selectionSeed: `seed-${randomUUID()}`,
    }) as { attemptId: string; questions: { id: string; topicId: string }[] };
    const tagged = fixture.assessment.questions.find((item) => item.id === started.questions[0]!.id)!;
    const trap = tagged.options.find((option) => option.id !== tagged.correctOptionId)!.id;

    // A reviewed, published misconception on the question's topic, tagged on one wrong option.
    const codeName = `SYN_ENG05_${randomUUID().slice(0, 8).toUpperCase()}`;
    const revision = await pool.query<{ content_revision_id: string }>('SELECT content_revision_id FROM question_versions WHERE id=$1', [tagged.id]);
    const provenance = {
      source: 'AGENT_DRAFTED' as const, generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-05-test',
      generatedAt: new Date('2026-09-26T00:00:00Z'), basis: 'Synthetic basis for a test.', expertCheckNotes: 'Synthetic: not a real claim.',
    };
    await db.transaction(async (tx) => {
      const code = await createMisconceptionCodeDraft(tx, { ...provenance, code: codeName, skillId: tagged.topicId,
        title: 'Synthetic misconception', description: 'Synthetic: chosen to test the attempt link.', authorUserId: actors.authorUserId });
      const tag = await createQuestionOptionMisconceptionDraft(tx, { ...provenance, questionRevisionId: revision.rows[0]!.content_revision_id,
        optionId: trap, misconceptionCodeId: code.id, rationale: 'Synthetic rationale.', authorUserId: actors.authorUserId });
      for (const revisionId of [code.revisionId, tag.revisionId]) {
        await transitionEngineContent(tx, { revisionId, to: 'IN_REVIEW', actorUserId: actors.authorUserId, reasonCode: 'SYNTHETIC', correlationId: `eng05-${randomUUID()}` });
        await transitionEngineContent(tx, { revisionId, to: 'APPROVED', actorUserId: actors.reviewerUserId, reasonCode: 'SYNTHETIC', correlationId: `eng05-${randomUUID()}` });
      }
      await publishEngineContentRelease(tx, { revisionIds: [code.revisionId, tag.revisionId], releaseName: `eng05-${randomUUID()}`,
        releaseVersion: 1, sourceRecordId, approverUserId: actors.reviewerUserId, publisherUserId: actors.publisherUserId,
        correlationId: `eng05-${randomUUID()}` });
    });
    const codeRow = await pool.query<{ id: string }>('SELECT id FROM misconception_codes WHERE code=$1', [codeName]);

    const selectedOptions: Record<string, string> = {};
    for (const question of started.questions) {
      const source = fixture.assessment.questions.find((item) => item.id === question.id)!;
      selectedOptions[question.id] = question.id === tagged.id ? trap : source.correctOptionId;
    }
    await submitAssessmentAttempt(pool, { subjectUserId: studentId, attemptId: started.attemptId,
      idempotencyKey: `submit-${started.attemptId}`, selectedOptions, correlationId: `submit-${randomUUID()}` });

    const attempts = await pool.query<{ item_id: string; correct: boolean; selected_option_id: string | null; misconception_code_ids: string[] }>(
      `SELECT item_id, correct, selected_option_id, misconception_code_ids FROM learning_attempt_events
       WHERE source_attempt_type='assessment_attempt' AND source_attempt_id=$1`, [started.attemptId],
    );
    for (const row of attempts.rows) {
      expect(row.selected_option_id).toBe(selectedOptions[row.item_id]);
      expect(row.misconception_code_ids).toEqual(row.item_id === tagged.id ? [codeRow.rows[0]!.id] : []);
      expect(row.correct).toBe(row.item_id !== tagged.id);
    }

    // Grading only asked for a projection; the worker writes it.
    expect(await snapshot([studentId])).toEqual([]);
    expect(await drain()).toBeGreaterThanOrEqual(1);
    const state = await pool.query<{ skill_id: string; active_misconception_codes: string[]; attempt_count: number; evidence_band: string }>(
      'SELECT skill_id, active_misconception_codes, attempt_count, evidence_band FROM learner_skill_state WHERE subject_user_id=$1', [studentId],
    );
    const topicRow = state.rows.find((row) => row.skill_id === tagged.topicId)!;
    expect(topicRow.active_misconception_codes).toEqual([codeName]);
    // One sitting on one day is never a band (C3).
    for (const row of state.rows) expect(row.evidence_band).toBe('NOT_ENOUGH_EVIDENCE');
    expect(state.rows.reduce((sum, row) => sum + row.attempt_count, 0)).toBe(started.questions.length);

    // A rebuild reproduces it exactly.
    const before = await snapshot([studentId]);
    await rebuildLearnerSkillState(db);
    expect(await snapshot([studentId])).toEqual(before);
  });

  it('refuses, at the database, a correct attempt that carries a misconception code', async () => {
    const studentId = await newUser();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sessionId = randomUUID();
      await client.query(`INSERT INTO learning_sessions (id, subject_user_id, mode, started_at) VALUES ($1,$2,'ASSESSMENT',now())`, [sessionId, studentId]);
      await expect(client.query(
        `INSERT INTO learning_attempt_events (id, subject_user_id, session_id, item_source, item_id, item_version, skill_id, context,
           answered, correct, score, content_version, source_attempt_type, source_attempt_id, occurred_at, misconception_code_ids)
         VALUES ($1,$2,$3,'CAREER_READINESS_QUESTION',$4,1,$5,'ASSESSMENT',true,true,1,'assessment-v1','assessment_attempt',$6,now(),ARRAY[$7::uuid])`,
        [randomUUID(), studentId, sessionId, randomUUID(), topicA, randomUUID(), randomUUID()],
      )).rejects.toThrow(/learning_attempt_correct_signals_nothing_ck/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Rebuild = incremental, idempotence
// ---------------------------------------------------------------------------

describe('rebuilding from attempts reproduces the table exactly', () => {
  it('matches the incremental projection row for row, and a second rebuild changes nothing', async () => {
    const institutionId = await newInstitution();
    const subjectId = await examSubject(institutionId);
    await link(institutionId, subjectId, topicB, day(1, 0));
    const students = [await newUser(), await newUser()];
    for (const studentId of students) await consent(studentId, 'GRANTED');
    const [first, second] = students as [string, string];

    const itemX = randomUUID();
    const facts: [string, AttemptFact][] = [
      [first, { skillId: topicA, itemId: itemX, correct: false, occurredAt: day(2) }],
      [first, { skillId: topicA, itemId: itemX, correct: true, occurredAt: day(3), institutionId }],
      [first, { skillId: topicA, correct: true, occurredAt: day(5), hint: 3 }],
      [first, { skillId: topicA, correct: true, occurredAt: day(6) }],
      [first, { examAttemptId: await examPaper(first, institutionId, subjectId, true), occurredAt: day(7), institutionId }],
      [first, { skillId: topicA, answered: false, occurredAt: day(8) }],
      [second, { skillId: topicB, correct: true, occurredAt: day(2) }],
      [second, { skillId: topicB, correct: true, occurredAt: day(4) }],
    ];
    // Incremental: the projector runs after every fact, as the worker would.
    for (const [studentId, fact] of facts) {
      await recordFact(studentId, fact);
      await drain();
    }
    const incremental = await snapshot(students);
    expect(incremental.map((row) => [row.subject_user_id, row.skill_id])).toEqual(
      [[first, topicA], [first, topicB], [second, topicB]].sort((left, right) => `${left[0]}${left[1]}`.localeCompare(`${right[0]}${right[1]}`)),
    );
    const firstA = incremental.find((row) => row.subject_user_id === first && row.skill_id === topicA)!;
    expect(firstA).toMatchObject({ attempt_count: 4, attempt_day_count: 4, unaided_success_count: 2, unaided_success_day_count: 2,
      assisted_success_count: 1, evidence_stage: 'DEMONSTRATED', evidence_band: 'DEMONSTRATED', institution_id: null,
      algorithm_version: 'learner-skill-state-v2',
      // BKT in shadow over the unaided answered attempts, in time order: wrong, correct, correct
      // (the assisted success on day 5 and the blank on day 8 are not observations).
      mastery_likelihood: estimateMastery([false, true, true])!.likelihood.toFixed(4),
      mastery_uncertainty: estimateMastery([false, true, true])!.uncertainty.toFixed(4),
      mastery_algorithm_version: 'mastery-bkt-v1' });
    // ENG-09: the review columns hold review-scheduler-fsrs-v1 over the same attempts — one review per
    // Kolkata day: wrong (AGAIN), right (GOOD), right only after hint 3 (AGAIN: assisted is not a
    // successful review), right (GOOD); the blank on day 8 is not a review.
    const expectedReview = scheduleReviewDays([
      { day: '2026-08-02', rating: 'AGAIN' }, { day: '2026-08-03', rating: 'GOOD' },
      { day: '2026-08-05', rating: 'AGAIN' }, { day: '2026-08-06', rating: 'GOOD' },
    ])!;
    expect(firstA).toMatchObject({
      review_algorithm_version: 'review-scheduler-fsrs-v1',
      review_stability: expectedReview.stability.toFixed(4),
      review_difficulty: expectedReview.difficulty.toFixed(4),
    });
    expect(new Date(firstA.review_due_at as string).toISOString()).toBe(expectedReview.dueAt);
    // The exam item counts on the topic its subject was mapped to when it was sat.
    const firstB = incremental.find((row) => row.subject_user_id === first && row.skill_id === topicB)!;
    expect(firstB).toMatchObject({ attempt_count: 1, unaided_success_count: 1, evidence_stage: 'RETAINED', institution_id: institutionId });

    // Lose the table; a full rebuild brings back exactly the same rows.
    await loseProjection();
    expect(await snapshot(students)).toEqual([]);
    await rebuildLearnerSkillState(db);
    expect(await snapshot(students)).toEqual(incremental);
    await rebuildLearnerSkillState(db);
    expect(await snapshot(students)).toEqual(incremental);
  });

  it('is idempotent: a replayed event is not re-run, and re-running the projection changes nothing', async () => {
    const studentId = await newUser();
    await consent(studentId, 'GRANTED');
    await recordFact(studentId, { skillId: topicA, occurredAt: day(10) });
    const event = await pool.query('SELECT id, aggregate_id, payload, correlation_id, occurred_at FROM outbox_events WHERE event_type=$1 AND aggregate_id=$2',
      [LEARNER_SKILL_STATE_PROJECTION_REQUESTED, studentId]);
    const envelope = envelopeOf(event.rows[0]);
    expect(await consumeSkillStateProjectionRequested(db, envelope)).toMatchObject({ executed: true });
    const once = await snapshot([studentId]);
    expect(once).toHaveLength(1);
    expect(await consumeSkillStateProjectionRequested(db, envelope)).toEqual({ executed: false });
    expect(await projectSubjectSkillState(db, studentId)).toMatchObject({ consented: true, written: 1, deleted: 0 });
    expect(await snapshot([studentId])).toEqual(once);
  });

  it('is routed by the local dispatcher, so the worker runs it without new configuration', async () => {
    const studentId = await newUser();
    await consent(studentId, 'GRANTED');
    await recordFact(studentId, { skillId: topicB, occurredAt: day(11) });
    const event = await pool.query('SELECT id, aggregate_id, payload, correlation_id, occurred_at FROM outbox_events WHERE event_type=$1 AND aggregate_id=$2',
      [LEARNER_SKILL_STATE_PROJECTION_REQUESTED, studentId]);
    const local = createLocalIntegrationEventPublisher({ pool, db });
    await local.publisher.publish(envelopeOf(event.rows[0]));
    expect(local.counts()).toEqual({ handled: 1, unrouted: 0 });
    expect(await snapshot([studentId])).toHaveLength(1);
  });

  it('never writes readiness', async () => {
    const studentId = await newUser();
    await consent(studentId, 'GRANTED');
    const before = await pool.query('SELECT (SELECT count(*) FROM readiness_snapshots)::int AS snapshots, (SELECT count(*) FROM mastery_projections)::int AS mastery');
    await recordFact(studentId, { skillId: topicA, occurredAt: day(12) });
    await recordFact(studentId, { skillId: topicA, occurredAt: day(13) });
    await drain();
    await rebuildLearnerSkillState(db);
    const after = await pool.query('SELECT (SELECT count(*) FROM readiness_snapshots)::int AS snapshots, (SELECT count(*) FROM mastery_projections)::int AS mastery');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

// ---------------------------------------------------------------------------
// Exam items: the mapping in force at the time, published results only
// ---------------------------------------------------------------------------

describe('exam items resolve through the subject mapping in force when they were sat', () => {
  it('ignores unpublished results, unmapped subjects, links made later and links retired earlier', async () => {
    const institutionId = await newInstitution();
    const studentId = await newUser();
    await consent(studentId, 'GRANTED');
    const mappedLate = await examSubject(institutionId);
    await link(institutionId, mappedLate, topicA, day(20));
    const retiredEarly = await examSubject(institutionId);
    await link(institutionId, retiredEarly, topicA, day(1, 0), day(3));
    const unmapped = await examSubject(institutionId);
    const mapped = await examSubject(institutionId);
    await link(institutionId, mapped, topicB, day(1, 0));

    await recordFact(studentId, { examAttemptId: await examPaper(studentId, institutionId, mappedLate, true), occurredAt: day(10), institutionId });
    await recordFact(studentId, { examAttemptId: await examPaper(studentId, institutionId, retiredEarly, true), occurredAt: day(10), institutionId });
    await recordFact(studentId, { examAttemptId: await examPaper(studentId, institutionId, unmapped, true), occurredAt: day(10), institutionId });
    await recordFact(studentId, { examAttemptId: await examPaper(studentId, institutionId, mapped, false), occurredAt: day(10), institutionId });
    await drain();
    expect(await snapshot([studentId])).toEqual([]);

    await recordFact(studentId, { examAttemptId: await examPaper(studentId, institutionId, mapped, true), occurredAt: day(11), institutionId });
    await drain();
    const rows = await snapshot([studentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ skill_id: topicB, attempt_count: 1, institution_id: institutionId });
  });
});

// ---------------------------------------------------------------------------
// Consent (ENG-01) and the "never edited by hand" guard
// ---------------------------------------------------------------------------

describe('adaptive-learning consent gates the projection', () => {
  it('writes nothing without consent, deletes on withdrawal, and rebuilds the same rows on a later grant', async () => {
    const studentId = await newUser();
    await recordFact(studentId, { skillId: topicA, occurredAt: day(14) });
    await recordFact(studentId, { skillId: topicA, occurredAt: day(15) });
    await drain();
    expect(await snapshot([studentId])).toEqual([]);

    await consent(studentId, 'GRANTED');
    const client = await pool.connect();
    try {
      await requestSkillStateProjection(client, { subjectUserId: studentId, reason: 'CONSENT_GRANTED', correlationId: `grant-${randomUUID()}` });
    } finally {
      client.release();
    }
    await drain();
    const granted = await snapshot([studentId]);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ attempt_count: 2, evidence_stage: 'DEMONSTRATED' });

    await consent(studentId, 'WITHDRAWN');
    expect(await db.transaction((tx) => clearLearnerSkillStateForWithdrawal(tx, studentId))).toBe(1);
    expect(await snapshot([studentId])).toEqual([]);
    // Attempts are the record, not the profile: they stay.
    expect((await pool.query('SELECT count(*)::int AS n FROM learning_attempt_events WHERE subject_user_id=$1', [studentId])).rows[0].n).toBe(2);
    // New work after withdrawal is recorded but not projected.
    await recordFact(studentId, { skillId: topicB, occurredAt: day(16) });
    await drain();
    expect(await snapshot([studentId])).toEqual([]);

    await consent(studentId, 'GRANTED');
    expect(await projectSubjectSkillState(db, studentId)).toMatchObject({ consented: true, written: 2 });
    const regranted = await snapshot([studentId]);
    expect(regranted.find((row) => row.skill_id === topicA)).toEqual(granted[0]);
  });

  it('removes existing rows when the projector runs for a student who no longer consents', async () => {
    const studentId = await newUser();
    await consent(studentId, 'GRANTED');
    await recordFact(studentId, { skillId: topicA, occurredAt: day(17) });
    await drain();
    expect(await snapshot([studentId])).toHaveLength(1);
    await consent(studentId, 'WITHDRAWN');
    expect(await projectSubjectSkillState(db, studentId)).toEqual({ consented: false, written: 0, deleted: 1 });
    expect(await snapshot([studentId])).toEqual([]);
  });

  it('refuses any insert, update or delete that does not come from the projector', async () => {
    const studentId = await newUser();
    await consent(studentId, 'GRANTED');
    await recordFact(studentId, { skillId: topicA, occurredAt: day(18) });
    await drain();
    await expect(pool.query("UPDATE learner_skill_state SET evidence_stage='TRANSFERRED' WHERE subject_user_id=$1", [studentId]))
      .rejects.toThrow(/only the projector writes it/);
    await expect(pool.query('DELETE FROM learner_skill_state WHERE subject_user_id=$1', [studentId])).rejects.toThrow(/only the projector writes it/);
    await expect(pool.query(
      `INSERT INTO learner_skill_state (subject_user_id, skill_id, attempt_count, attempt_day_count, unaided_success_count,
         unaided_success_day_count, assisted_success_count, evidence_stage, evidence_band, algorithm_version)
       VALUES ($1,$2,0,0,0,0,0,'ESTIMATED','NOT_ENOUGH_EVIDENCE','learner-skill-state-v1')`, [studentId, topicB],
    )).rejects.toThrow(/only the projector writes it/);
  });
});

describe('privacy deletion', () => {
  it('erases the projection by rebuilding the subject from no facts, inside the erase transaction', async () => {
    const studentId = await newUser();
    const other = await newUser();
    for (const id of [studentId, other]) {
      await consent(id, 'GRANTED');
      await recordFact(id, { skillId: topicA, occurredAt: day(19) });
    }
    await drain();
    const erased = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('one.privacy_erase_subject', ${studentId}, true)`);
      await tx.execute(sql`DELETE FROM learning_attempt_events WHERE subject_user_id = ${studentId}::uuid`);
      return projectSubjectSkillState(tx, studentId);
    });
    expect(erased).toMatchObject({ written: 0, deleted: 1 });
    expect(await snapshot([studentId])).toEqual([]);
    expect(await snapshot([other])).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// ENG-09: the review scheduler's state and the due reviews the planner reads
// ---------------------------------------------------------------------------

describe('due reviews (ENG-09, C7)', () => {
  const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

  it('puts a skill not practised for its due interval first, and drops a skill once it is practised again', async () => {
    const studentId = await newUser();
    await consent(studentId, 'GRANTED');
    // topicA: two good days two months ago. topicB: two good days a month ago. Both are past due.
    await recordFact(studentId, { skillId: topicA, occurredAt: daysAgo(61) });
    await recordFact(studentId, { skillId: topicA, occurredAt: daysAgo(60) });
    await recordFact(studentId, { skillId: topicB, occurredAt: daysAgo(31) });
    await recordFact(studentId, { skillId: topicB, occurredAt: daysAgo(30) });
    await drain();
    const due = await listDueReviews(db, studentId);
    expect(due.map((item) => item.skillId)).toEqual([topicA, topicB]);
    expect(due[0]!.dueAt < due[1]!.dueAt).toBe(true);

    // Practising topicB today reschedules it into the future; topicA is still due, and first.
    await recordFact(studentId, { skillId: topicB, occurredAt: daysAgo(0.01) });
    await drain();
    expect((await listDueReviews(db, studentId)).map((item) => item.skillId)).toEqual([topicA]);
    const rows = await pool.query<{ skill_id: string; review_due_at: Date }>(
      'SELECT skill_id, review_due_at FROM learner_skill_state WHERE subject_user_id=$1', [studentId]);
    expect(rows.rows.find((row) => row.skill_id === topicB)!.review_due_at.getTime()).toBeGreaterThan(Date.now());

    // The schedule is projection state: a rebuild reproduces it, and nobody edits it by hand.
    const before = await snapshot([studentId]);
    await rebuildLearnerSkillState(db);
    expect(await snapshot([studentId])).toEqual(before);
    await expect(pool.query("UPDATE learner_skill_state SET review_due_at = now() + interval '1 year' WHERE subject_user_id=$1", [studentId]))
      .rejects.toThrow(/only the projector writes it/);
  });

  it('treats a success after hint 3 as a lapse, so the skill comes due sooner than an unaided success', async () => {
    const unaided = await newUser();
    const assisted = await newUser();
    for (const id of [unaided, assisted]) {
      await consent(id, 'GRANTED');
      await recordFact(id, { skillId: topicA, occurredAt: daysAgo(20) });
    }
    await recordFact(unaided, { skillId: topicA, occurredAt: daysAgo(10) });
    await recordFact(assisted, { skillId: topicA, occurredAt: daysAgo(10), hint: 3 });
    await drain();
    const dueAt = async (id: string): Promise<number> => (await pool.query<{ review_due_at: Date }>(
      'SELECT review_due_at FROM learner_skill_state WHERE subject_user_id=$1 AND skill_id=$2', [id, topicA])).rows[0]!.review_due_at.getTime();
    expect(await dueAt(assisted)).toBeLessThan(await dueAt(unaided));
  });

  it('has no due reviews for a student without adaptive-learning consent, however old their attempts', async () => {
    const studentId = await newUser();
    await recordFact(studentId, { skillId: topicA, occurredAt: daysAgo(90) });
    await drain();
    expect(await snapshot([studentId])).toEqual([]);
    expect(await listDueReviews(db, studentId)).toEqual([]);
  });
});
