/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * The bridge from an institution exam result to readiness evidence.
 *
 * Two of these tests exist to stop a future change being "helpful": an unmapped
 * subject must stay silent rather than guess a topic, and a penalty must not travel
 * into evidence as negative demonstration. Both are the kind of thing that looks like
 * an improvement when you are trying to make a band move.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../src/schema.js';
import type { PersistenceDb } from '../src/repositories.js';
import { linkExamSubjectToTopic, recordExamResultEvidence } from '../src/exam-evidence-bridge.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

let client: PoolClient;
/** drizzle over the same client, so the bridge runs inside this test's transaction. */
let db: PersistenceDb;
let institutionId: string;
let studentId: string;
let staffId: string;
let subjectId: string;
let definitionId: string;
let attemptId: string;
let topicId: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  db = drizzle(client as never, { schema }) as unknown as PersistenceDb;
  institutionId = randomUUID();
  studentId = randomUUID();
  staffId = randomUUID();
  subjectId = randomUUID();
  definitionId = randomUUID();
  attemptId = randomUUID();

  for (const id of [studentId, staffId]) {
    await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, id + '@example.test']);
  }
  await client.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', 'E bridge test')", [institutionId]);
  await client.query('INSERT INTO exam_subjects (id, institution_id, name) VALUES ($1,$2,$3)', [subjectId, institutionId, 'Aptitude ' + subjectId.slice(0, 8)]);

  // A TOPIC node the readiness model already understands.
  const topic = await client.query<{ id: string }>(
    "SELECT id FROM taxonomy_nodes WHERE kind='TOPIC' AND active ORDER BY name LIMIT 1",
  );
  topicId = topic.rows[0]?.id ?? '';
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => { await pool.end(); });

async function seedAttempt(counts: { correct: number; wrong: number; notAttempted: number }, published: boolean): Promise<void> {
  await client.query(
    `INSERT INTO exam_definitions
       (id, institution_id, subject_id, title, exam_kind, lifecycle_state, total_marks, duration_seconds,
        starts_at, ends_at, publish_results_immediately, created_by_user_id, published_at)
     VALUES ($1,$2,$3,'Bridge paper','UNIT_TEST','PUBLISHED',10,1800,
             now() - interval '1 hour', now() + interval '1 hour', $5, $4, now())`,
    [definitionId, institutionId, subjectId, staffId, published],
  );
  await client.query(
    `INSERT INTO exam_attempts (id, institution_id, definition_id, student_user_id, attempt_number, status, paper_seed, submitted_at)
     VALUES ($1,$2,$3,$4,1,'SUBMITTED',$5, now())`,
    [attemptId, institutionId, definitionId, studentId, randomUUID()],
  );
  const answered = counts.correct + counts.wrong + counts.notAttempted;
  await client.query(
    `INSERT INTO exam_results
       (id, attempt_id, score, max_score, percentage, correct_count, wrong_count, not_attempted_count, time_taken_seconds, published)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,600,$9)`,
    [randomUUID(), attemptId, counts.correct - counts.wrong, answered,
      answered ? Math.round((counts.correct / answered) * 100) : 0,
      counts.correct, counts.wrong, counts.notAttempted, published],
  );
}

async function map(weight = 1): Promise<void> {
  await linkExamSubjectToTopic(db, {
    institutionId, examSubjectId: subjectId, topicId, weight, createdByUserId: staffId,
  });
}

describe('exam result to readiness evidence', () => {
  it('writes one evidence row per mapped topic', async () => {
    if (!topicId) return;
    await seedAttempt({ correct: 7, wrong: 2, notAttempted: 1 }, true);
    await map();

    const outcome = await recordExamResultEvidence(db, { attemptId });
    expect(outcome.written).toBe(1);
    expect(outcome.unmappedSubject).toBe(false);

    const evidence = await client.query<{ demonstrated: number; possible: number; evidence_type: string }>(
      "SELECT demonstrated, possible, evidence_type FROM evidence_records WHERE source_aggregate_id=$1", [attemptId],
    );
    expect(evidence.rows[0]?.evidence_type).toBe('ASSESSMENT_OUTCOME');
    expect(evidence.rows[0]?.demonstrated).toBe(7);
    expect(evidence.rows[0]?.possible).toBe(10);
  });

  it('stays silent on an unmapped subject rather than guessing a topic', async () => {
    await seedAttempt({ correct: 9, wrong: 1, notAttempted: 0 }, true);
    const outcome = await recordExamResultEvidence(db, { attemptId });
    expect(outcome.unmappedSubject).toBe(true);
    expect(outcome.written).toBe(0);
    const evidence = await client.query('SELECT 1 FROM evidence_records WHERE source_aggregate_id=$1', [attemptId]);
    expect(evidence.rowCount).toBe(0);
  });

  it('writes nothing for an unpublished result', async () => {
    if (!topicId) return;
    await seedAttempt({ correct: 8, wrong: 2, notAttempted: 0 }, false);
    await map();
    const outcome = await recordExamResultEvidence(db, { attemptId });
    expect(outcome.written).toBe(0);
    const evidence = await client.query('SELECT 1 FROM evidence_records WHERE source_aggregate_id=$1', [attemptId]);
    expect(evidence.rowCount).toBe(0);
  });

  it('does not double-count a re-publication', async () => {
    if (!topicId) return;
    await seedAttempt({ correct: 5, wrong: 5, notAttempted: 0 }, true);
    await map();
    await recordExamResultEvidence(db, { attemptId });
    const second = await recordExamResultEvidence(db, { attemptId });
    expect(second.written).toBe(0);
    const evidence = await client.query('SELECT 1 FROM evidence_records WHERE source_aggregate_id=$1', [attemptId]);
    expect(evidence.rowCount).toBe(1);
  });

  it('never carries negative marking into evidence', async () => {
    if (!topicId) return;
    // A paper where the penalty exceeds the marks earned: score is negative by design.
    await seedAttempt({ correct: 1, wrong: 9, notAttempted: 0 }, true);
    await map();
    await recordExamResultEvidence(db, { attemptId });
    const evidence = await client.query<{ demonstrated: number; possible: number }>(
      'SELECT demonstrated, possible FROM evidence_records WHERE source_aggregate_id=$1', [attemptId],
    );
    // Counts, not score. A penalty is an assessment policy, not a claim about what the
    // student demonstrated, and the evidence invariant forbids a negative anyway.
    expect(evidence.rows[0]?.demonstrated).toBe(1);
    expect(evidence.rows[0]?.possible).toBe(10);
  });

  it('refuses a mapping onto a node that is not a topic', async () => {
    const nonTopic = await client.query<{ id: string }>(
      "SELECT id FROM taxonomy_nodes WHERE kind <> 'TOPIC' LIMIT 1",
    );
    const target = nonTopic.rows[0]?.id;
    if (!target) return;
    await expect(linkExamSubjectToTopic(db, {
      institutionId, examSubjectId: subjectId, topicId: target, weight: 1, createdByUserId: staffId,
    })).rejects.toThrow(/only be mapped to a TOPIC/);
  });
});

describe('readiness model version', () => {
  it('publishes version 2 as the active model and retires version 1', async () => {
    const versions = await db.execute(sql`
      SELECT version, active FROM readiness_model_versions
      WHERE stable_key = 'career-readiness-fundamentals' ORDER BY version
    `) as { rows: { version: number; active: boolean }[] };
    // ADR-020: a changed model is a new published version, not an edit to the old one.
    const active = versions.rows.filter((row) => row.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(2);
  });
});
