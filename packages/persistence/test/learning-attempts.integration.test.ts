/**
 * Database tests for the learning attempt log (ENG-03) and the exam bridge's readiness path (C9).
 *
 * Why: the acceptance for ENG-03 is "every graded response produces exactly one attempt row,
 * in the same transaction, and existing evidence behaviour is unchanged", and ADR-034 gave this
 * goal the fix for C9 (a mapped exam result must move the band). These run against a real
 * database because the guarantees live in constraints, triggers and transactions.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
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
import { linkExamSubjectToTopic, recordExamResultEvidence } from '../src/exam-evidence-bridge.js';
import { drizzleAsPgClient, recordGradedAttemptSession } from '../src/learning-attempts.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const actors = {
  authorUserId: '47000000-0000-4000-8000-000000000001',
  reviewerUserId: '47000000-0000-4000-8000-000000000002',
  publisherUserId: '47000000-0000-4000-8000-000000000003',
};
let fixture: PilotFixture;

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
  // The same fresh start the career-readiness suite uses: a published pilot on model v2.
  await pool.query('TRUNCATE users CASCADE');
  for (const [index, userId] of Object.values(actors).entries()) {
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [userId, `learning-attempts-test:${index}`, `learning-attempts-${index}@example.test`]);
  }
  const pilotBytes = await readFile(new URL('../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const staging = JSON.parse(await readFile(new URL('../../../data/career-readiness/v4-staging-manifest.json', import.meta.url), 'utf8')) as ImportPackageManifest;
  await stageImportManifest(pool, staging, actors.authorUserId);
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
});

afterAll(async () => pool.end());

async function newUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`, [id, `sub-${id}`, `${id}@example.test`]);
  return id;
}

async function newInstitution(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', $2)", [id, `${name} ${id.slice(0, 8)}`]);
  return id;
}

/** Sit and submit the readiness check, answering the first item right and the rest wrong. */
async function sitReadinessCheck(studentId: string): Promise<{ attemptId: string; questions: { id: string; topicId: string }[]; submitted: Record<string, unknown> }> {
  const started = await startAssessmentAttempt(pool, {
    subjectUserId: studentId, assessmentDefinitionId: fixture.assessment.id,
    correlationId: `start-${randomUUID()}`, selectionSeed: `seed-${randomUUID()}`,
  }) as { attemptId: string; questions: { id: string; topicId: string }[] };
  const selectedOptions: Record<string, string> = {};
  for (const [index, question] of started.questions.entries()) {
    const source = fixture.assessment.questions.find((item) => item.id === question.id)!;
    const wrong = source.options.find((option) => option.id !== source.correctOptionId)!.id;
    selectedOptions[question.id] = index === 0 ? source.correctOptionId : wrong;
  }
  const submitted = await submitAssessmentAttempt(pool, {
    subjectUserId: studentId, attemptId: started.attemptId, idempotencyKey: `submit-${started.attemptId}`,
    selectedOptions, correlationId: `submit-${randomUUID()}`,
  });
  return { attemptId: started.attemptId, questions: started.questions, submitted };
}

describe('readiness check writes the attempt log', () => {
  it('writes exactly one attempt row per graded item, with its session, in the submit transaction', async () => {
    const studentId = await newUser();
    const { attemptId, questions } = await sitReadinessCheck(studentId);

    const rows = await pool.query<{
      item_id: string; item_version: number; skill_id: string; context: string; answered: boolean; correct: boolean;
      score: string; highest_hint_level: number; assisted: boolean; response_time_ms: number | null;
      content_version: string; institution_id: string | null; session_id: string;
    }>(
      `SELECT item_id, item_version, skill_id, context, answered, correct, score, highest_hint_level, assisted,
              response_time_ms, content_version, institution_id, session_id
       FROM learning_attempt_events WHERE source_attempt_type='assessment_attempt' AND source_attempt_id=$1`, [attemptId],
    );
    expect(rows.rows).toHaveLength(questions.length);
    expect(new Set(rows.rows.map((row) => row.item_id))).toEqual(new Set(questions.map((question) => question.id)));
    for (const row of rows.rows) {
      const question = questions.find((item) => item.id === row.item_id)!;
      expect(row.skill_id).toBe(question.topicId);
      expect(row).toMatchObject({ context: 'ASSESSMENT', answered: true, highest_hint_level: 0, assisted: false,
        response_time_ms: null, content_version: 'assessment-v1', institution_id: null });
      expect(row.item_version).toBeGreaterThan(0);
      expect(Number(row.score)).toBe(row.correct ? 1 : 0);
    }
    // First item right, the rest wrong -- exactly as the responses were graded.
    const graded = await pool.query<{ question_version_id: string; is_correct: boolean }>(
      `SELECT i.question_version_id, r.is_correct FROM assessment_attempt_items i
       JOIN assessment_responses r ON r.attempt_item_id = i.id WHERE i.attempt_id=$1`, [attemptId],
    );
    for (const response of graded.rows) {
      expect(rows.rows.find((row) => row.item_id === response.question_version_id)?.correct).toBe(response.is_correct);
    }

    const sessions = await pool.query<{ id: string; mode: string; started_at: Date; ended_at: Date; model_version: string | null }>(
      "SELECT id, mode, started_at, ended_at, model_version FROM learning_sessions WHERE source_type='assessment_attempt' AND source_id=$1", [attemptId],
    );
    expect(sessions.rows).toHaveLength(1);
    expect(sessions.rows[0]).toMatchObject({ mode: 'ASSESSMENT', model_version: null });
    expect(sessions.rows[0]!.ended_at.getTime()).toBeGreaterThanOrEqual(sessions.rows[0]!.started_at.getTime());
    expect(new Set(rows.rows.map((row) => row.session_id))).toEqual(new Set([sessions.rows[0]!.id]));
  });

  it('adds nothing on an idempotent re-submit', async () => {
    const studentId = await newUser();
    const { attemptId, questions } = await sitReadinessCheck(studentId);
    const selectedOptions = Object.fromEntries(questions.map((question) => {
      const source = fixture.assessment.questions.find((item) => item.id === question.id)!;
      return [question.id, source.correctOptionId];
    }));
    const replay = await submitAssessmentAttempt(pool, {
      subjectUserId: studentId, attemptId, idempotencyKey: `submit-${attemptId}`, selectedOptions, correlationId: `replay-${randomUUID()}`,
    });
    expect(replay.idempotentReplay).toBe(true);
    const count = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM learning_attempt_events WHERE source_attempt_id=$1", [attemptId],
    );
    expect(count.rows[0]?.count).toBe(questions.length);
  });

  it('leaves evidence exactly as before: one ASSESSMENT_OUTCOME row per topic', async () => {
    const studentId = await newUser();
    const { attemptId, questions } = await sitReadinessCheck(studentId);
    const evidence = await pool.query<{ topic_id: string; possible: number }>(
      "SELECT topic_id, possible FROM evidence_records WHERE source_aggregate_type='assessment_attempt' AND source_aggregate_id=$1", [attemptId],
    );
    const topics = new Set(questions.map((question) => question.topicId));
    expect(evidence.rows).toHaveLength(topics.size);
    expect(evidence.rows.reduce((sum, row) => sum + row.possible, 0)).toBe(questions.length);
  });

  it('stamps the institution the student currently belongs to', async () => {
    const studentId = await newUser();
    const institutionId = await newInstitution('Attempt log college');
    await pool.query(
      `INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from)
       VALUES ($1,$2,$3,'ACTIVE', now() - interval '1 day')`, [randomUUID(), institutionId, studentId],
    );
    const { attemptId } = await sitReadinessCheck(studentId);
    const stamped = await pool.query<{ institution_id: string }>(
      'SELECT DISTINCT institution_id FROM learning_attempt_events WHERE source_attempt_id=$1', [attemptId],
    );
    expect(stamped.rows).toEqual([{ institution_id: institutionId }]);
    const session = await pool.query<{ institution_id: string }>('SELECT institution_id FROM learning_sessions WHERE source_id=$1', [attemptId]);
    expect(session.rows[0]?.institution_id).toBe(institutionId);
  });
});

describe('the attempt log table', () => {
  it('rolls back with the transaction that wrote it', async () => {
    const studentId = await newUser();
    const sourceId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordGradedAttemptSession(client, {
        subjectUserId: studentId, mode: 'ASSESSMENT', context: 'ASSESSMENT', sourceAttemptType: 'exam_attempt',
        sourceAttemptId: sourceId, startedAt: new Date(), contentVersion: 'institution-exam-v1',
        responses: [{ itemSource: 'INSTITUTION_EXAM_QUESTION', itemId: randomUUID(), itemVersion: 1, skillId: null,
          answered: true, correct: true, marksAwarded: 1, marksPossible: 1 }],
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const left = await pool.query('SELECT 1 FROM learning_attempt_events WHERE source_attempt_id=$1', [sourceId]);
    expect(left.rowCount).toBe(0);
  });

  it('refuses an unaided success after hint 3 at the data layer (C5)', async () => {
    const studentId = await newUser();
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO learning_sessions (id, subject_user_id, mode, started_at, ended_at) VALUES ($1,$2,'PRACTICE',now(),now())`,
      [sessionId, studentId],
    );
    await expect(pool.query(
      `INSERT INTO learning_attempt_events
         (id, subject_user_id, session_id, item_source, item_id, item_version, context, answered, correct, score,
          highest_hint_level, assisted, content_version, source_attempt_type, source_attempt_id, occurred_at)
       VALUES ($1,$2,$3,'CAREER_READINESS_QUESTION',$4,1,'PRACTICE',true,true,1,3,false,'assessment-v1','assessment_attempt',$5,now())`,
      [randomUUID(), studentId, sessionId, randomUUID(), randomUUID()],
    )).rejects.toThrow(/learning_attempt_assisted_ck/);
  });

  it('lets an open session close exactly once, and freezes it after', async () => {
    const studentId = await newUser();
    const sessionId = randomUUID();
    await pool.query(`INSERT INTO learning_sessions (id, subject_user_id, mode, started_at) VALUES ($1,$2,'LEARN',now())`, [sessionId, studentId]);
    await expect(pool.query("UPDATE learning_sessions SET mode='PRACTICE' WHERE id=$1", [sessionId])).rejects.toThrow(/append-only/);
    await pool.query('UPDATE learning_sessions SET ended_at = now() WHERE id=$1', [sessionId]);
    await expect(pool.query("UPDATE learning_sessions SET ended_at = now() + interval '1 hour' WHERE id=$1", [sessionId])).rejects.toThrow(/append-only/);
  });

  it('binds every value as a parameter when running pg-style SQL through drizzle', async () => {
    const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
    const hostile = "x'); DROP TABLE learning_attempt_events; --";
    const ids = [randomUUID(), randomUUID()];
    const result = await drizzleAsPgClient(db).query<{ ids: string[]; text: string; n: number }>(
      'SELECT $1::uuid[] AS ids, $2::text AS text, $3::int + $3::int AS n', [ids, hostile, 21],
    );
    expect(result.rows[0]).toEqual({ ids, text: hostile, n: 42 });
    await expect(pool.query('SELECT 1 FROM learning_attempt_events LIMIT 1')).resolves.toBeTruthy();
  });
});

describe('institution exam evidence moves the band (C9)', () => {
  async function seedPublishedExam(studentId: string, institutionId: string, subjectId: string, correct: number): Promise<string> {
    const staffId = await newUser();
    const definitionId = randomUUID();
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO exam_definitions
         (id, institution_id, subject_id, title, exam_kind, lifecycle_state, total_marks, duration_seconds,
          starts_at, ends_at, publish_results_immediately, created_by_user_id, published_at)
       VALUES ($1,$2,$3,'C9 paper','UNIT_TEST','PUBLISHED',10,1800, now() - interval '1 hour', now() + interval '1 hour', true, $4, now())`,
      [definitionId, institutionId, subjectId, staffId],
    );
    await pool.query(
      `INSERT INTO exam_attempts (id, institution_id, definition_id, student_user_id, attempt_number, status, paper_seed, submitted_at)
       VALUES ($1,$2,$3,$4,1,'SUBMITTED',$5, now())`, [attemptId, institutionId, definitionId, studentId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO exam_results (id, attempt_id, score, max_score, percentage, correct_count, wrong_count, not_attempted_count, time_taken_seconds, published)
       VALUES ($1,$2,$3,10,$4,$5,$6,0,600,true)`, [randomUUID(), attemptId, correct, correct * 10, correct, 10 - correct],
    );
    return attemptId;
  }

  async function inTransaction<T>(work: (db: PersistenceDb) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(drizzle(client as never, { schema }) as unknown as PersistenceDb);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('recomputes readiness through the readiness path when a mapped result becomes evidence', async () => {
    const studentId = await newUser();
    const institutionId = await newInstitution('C9 college');
    const subjectId = randomUUID();
    await pool.query('INSERT INTO exam_subjects (id, institution_id, name) VALUES ($1,$2,$3)', [subjectId, institutionId, `Networks ${subjectId.slice(0, 8)}`]);
    const topicId = fixture.topics[0]!.id;
    const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
    await linkExamSubjectToTopic(db, { institutionId, examSubjectId: subjectId, topicId, weight: 1, createdByUserId: actors.authorUserId });
    const attemptId = await seedPublishedExam(studentId, institutionId, subjectId, 9);

    const outcome = await inTransaction((tx) => recordExamResultEvidence(tx, { attemptId }));
    expect(outcome.written).toBe(1);
    expect(outcome.readiness).toBeTruthy();

    const snapshot = await pool.query<{ id: string; evidence_ids: string[]; advisory: boolean; employer_visible: boolean; band: string }>(
      'SELECT id, evidence_ids, advisory, employer_visible, band FROM readiness_snapshots WHERE subject_user_id=$1 ORDER BY generated_at DESC LIMIT 1',
      [studentId],
    );
    const evidence = await pool.query<{ id: string }>(
      "SELECT id FROM evidence_records WHERE source_aggregate_type='exam_attempt' AND source_aggregate_id=$1", [attemptId],
    );
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]!.id).toBe(outcome.readiness!.snapshotId);
    expect(snapshot.rows[0]!.band).toBe(outcome.readiness!.band);
    expect(snapshot.rows[0]!.evidence_ids).toContain(evidence.rows[0]!.id);
    expect(snapshot.rows[0]).toMatchObject({ advisory: true, employer_visible: false });
    // The topic projection now reflects the exam evidence.
    const projection = await pool.query<{ evidence_ids: string[] }>(
      'SELECT evidence_ids FROM mastery_projections WHERE subject_user_id=$1 AND topic_id=$2 ORDER BY generated_at DESC LIMIT 1',
      [studentId, topicId],
    );
    expect(projection.rows[0]?.evidence_ids).toContain(evidence.rows[0]!.id);
  });

  it('writes nothing, recomputes nothing and says so for an unmapped subject', async () => {
    const studentId = await newUser();
    const institutionId = await newInstitution('C9 unmapped college');
    const subjectId = randomUUID();
    await pool.query('INSERT INTO exam_subjects (id, institution_id, name) VALUES ($1,$2,$3)', [subjectId, institutionId, `History ${subjectId.slice(0, 8)}`]);
    const attemptId = await seedPublishedExam(studentId, institutionId, subjectId, 10);

    const outcome = await inTransaction((tx) => recordExamResultEvidence(tx, { attemptId }));
    expect(outcome).toMatchObject({ written: 0, unmappedSubject: true });
    const snapshots = await pool.query('SELECT 1 FROM readiness_snapshots WHERE subject_user_id=$1', [studentId]);
    expect(snapshots.rowCount).toBe(0);
  });
});
