/**
 * Database tests for BKT in shadow (ENG-06): the projector fills the mastery columns, BKT touches
 * nothing readiness reads, and the offline shadow report runs on seeded data with counts only.
 *
 * Why: the acceptance is "shadow report runs on seeded data", and the hard rule is that BKT output
 * never changes what anyone sees or influences readiness. Both live in real queries, consent checks
 * and triggers, so they are tested against a real database. Students take the published pilot
 * readiness check through the real grading path; every person here is synthetic.
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
import { rebuildLearnerSkillState } from '../src/learner-skill-state.js';
import { buildBktShadowReport } from '../src/bkt-shadow-report.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
const CONSENT_VERSION = 'eng06-synthetic-test';
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const actors = {
  authorUserId: '53000000-0000-4000-8000-000000000001',
  reviewerUserId: '53000000-0000-4000-8000-000000000002',
  publisherUserId: '53000000-0000-4000-8000-000000000003',
};
let fixture: PilotFixture;

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
  await pool.query('TRUNCATE users CASCADE');
  for (const [index, userId] of Object.values(actors).entries()) {
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [userId, `bkt-shadow-test:${index}`, `bkt-shadow-${index}@example.test`]);
  }
  const pilotBytes = await readFile(new URL('../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const staging = JSON.parse(await readFile(new URL('../../../data/career-readiness/v4-staging-manifest.json', import.meta.url), 'utf8')) as ImportPackageManifest;
  await stageImportManifest(pool, staging, actors.authorUserId);
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);

  // The adaptive-learning purpose, live for this suite only (publishing the real one is HG-6).
  await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', $1, 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')
    ON CONFLICT (consent_key, version) DO UPDATE SET retired_at = NULL`, [CONSENT_VERSION]);
});

afterAll(async () => {
  await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning' AND version = $1", [CONSENT_VERSION]);
  await pool.end();
});

async function newUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`, [id, `sub-${id}`, `${id}@example.test`]);
  return id;
}

async function consent(userId: string, action: 'GRANTED' | 'WITHDRAWN'): Promise<void> {
  await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
    VALUES ($1,$2,'adaptive-learning',$3,$4, clock_timestamp())`, [randomUUID(), userId, CONSENT_VERSION, action]);
}

/** Take the pilot readiness check through the real grading path, getting the first `wrong` questions wrong. */
async function takeCheck(studentId: string, wrong: number): Promise<void> {
  const started = await startAssessmentAttempt(pool, {
    subjectUserId: studentId, assessmentDefinitionId: fixture.assessment.id,
    correlationId: `start-${randomUUID()}`, selectionSeed: `seed-${randomUUID()}`,
  }) as { attemptId: string; questions: { id: string }[] };
  const selectedOptions: Record<string, string> = {};
  started.questions.forEach((question, index) => {
    const source = fixture.assessment.questions.find((item) => item.id === question.id)!;
    selectedOptions[question.id] = index < wrong
      ? source.options.find((option) => option.id !== source.correctOptionId)!.id
      : source.correctOptionId;
  });
  await submitAssessmentAttempt(pool, { subjectUserId: studentId, attemptId: started.attemptId,
    idempotencyKey: `submit-${started.attemptId}`, selectedOptions, correlationId: `submit-${randomUUID()}` });
}

async function readinessCounts(): Promise<Record<string, number>> {
  const result = await pool.query<{ snapshots: number; factors: number; projections: number; evidence: number }>(`
    SELECT (SELECT count(*)::int FROM readiness_snapshots) AS snapshots,
           (SELECT count(*)::int FROM readiness_factors) AS factors,
           (SELECT count(*)::int FROM mastery_projections) AS projections,
           (SELECT count(*)::int FROM evidence_records) AS evidence`);
  return result.rows[0]!;
}

describe('BKT in shadow', () => {
  const consenting: string[] = [];

  it('suppresses the whole report while fewer than five consenting students are in scope', async () => {
    for (let index = 0; index < 4; index += 1) {
      const studentId = await newUser();
      await consent(studentId, 'GRANTED');
      await takeCheck(studentId, index % 3);
      consenting.push(studentId);
    }
    await rebuildLearnerSkillState(db);
    const report = await buildBktShadowReport(db);
    expect(report.suppressed).toBe(true);
    expect(report.coverage).toBeUndefined();
    expect(report.bkt).toBeUndefined();
  });

  it('fills the mastery columns with mastery-bkt-v1 and changes nothing readiness reads', async () => {
    for (let index = 4; index < 7; index += 1) {
      const studentId = await newUser();
      await consent(studentId, 'GRANTED');
      await takeCheck(studentId, index % 3);
      consenting.push(studentId);
    }
    // A student without the purpose: graded as usual, never projected, never read by the report.
    await takeCheck(await newUser(), 0);

    const before = await readinessCounts();
    await rebuildLearnerSkillState(db);
    const report = await buildBktShadowReport(db);
    expect(await readinessCounts()).toEqual(before);

    const rows = await pool.query<{ subject_user_id: string; attempt_count: number; mastery_likelihood: string | null;
      mastery_uncertainty: string | null; mastery_algorithm_version: string | null; algorithm_version: string }>(
      'SELECT subject_user_id, attempt_count, mastery_likelihood, mastery_uncertainty, mastery_algorithm_version, algorithm_version FROM learner_skill_state',
    );
    expect(new Set(rows.rows.map((row) => row.subject_user_id))).toEqual(new Set(consenting));
    for (const row of rows.rows) {
      expect(row.algorithm_version).toBe('learner-skill-state-v2');
      expect(row.mastery_algorithm_version).toBe('mastery-bkt-v1');
      expect(Number(row.mastery_likelihood)).toBeGreaterThan(0);
      expect(Number(row.mastery_likelihood)).toBeLessThanOrEqual(1);
      expect(Number(row.mastery_uncertainty)).toBeGreaterThanOrEqual(0);
    }
    expect(report.suppressed).toBe(false);
  });

  it('runs on seeded data: counts how many topic bands would change, with no identifier in the output', async () => {
    const report = await buildBktShadowReport(db);
    const livePairs = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM (
        SELECT DISTINCT subject_user_id, topic_id FROM mastery_projections WHERE subject_user_id = ANY($1::uuid[])) pairs`, [consenting]);
    const answered = await pool.query<{ observations: number; skills: number }>(`
      SELECT count(*)::int AS observations, count(DISTINCT (subject_user_id, skill_id))::int AS skills
      FROM learning_attempt_events WHERE subject_user_id = ANY($1::uuid[]) AND answered AND NOT assisted`, [consenting]);

    expect(report.algorithms).toEqual({ live: 'career-readiness-mastery-v1', engineBand: 'learning-model-v1',
      projector: 'learner-skill-state-v2', shadow: 'mastery-bkt-v1' });
    expect(report.parameters).toEqual({ pInit: 0.36, pLearn: 0.1, pGuess: 0.3, pSlip: 0.05, source: 'DEFAULT_PROVISIONAL' });
    expect(report.coverage).toMatchObject({ studentsInScope: 7, engineRowsOnOlderProjector: 0 });
    expect(livePairs.rows[0]!.count).toBeGreaterThanOrEqual(5);
    expect(report.coverage!.pairsWithBothBands).toBe(livePairs.rows[0]!.count);
    expect(report.c3Adoption!.pairsCompared).toBe(livePairs.rows[0]!.count);
    expect(report.bkt!.pairsCompared).toBe(livePairs.rows[0]!.count);
    // One sitting on one day: C3 and BKT both say not enough evidence for every pair.
    const notEnough = Object.entries(report.bkt!.matrix)
      .filter(([cell, count]) => !cell.endsWith('->NOT_ENOUGH_EVIDENCE') && count !== 0);
    expect(notEnough).toEqual([]);
    // Every observation after a skill's first is predicted before it is seen.
    expect(report.nextAttemptPrediction!.predictions).toBe(answered.rows[0]!.observations - answered.rows[0]!.skills);
    expect(report.nextAttemptPrediction!.students).toBe(7);
    expect(typeof report.nextAttemptPrediction!.brierScore).toBe('number');

    const printed = JSON.stringify(report);
    expect(printed).not.toMatch(UUID_PATTERN);
    expect(printed).not.toMatch(/example\.test/);
  });

  it('fails closed: rows left behind for a student who no longer holds the purpose are not read', async () => {
    const before = await buildBktShadowReport(db);
    // Record a withdrawal without the projector clearing the rows, as a crash between the two might.
    await consent(consenting[0]!, 'WITHDRAWN');
    const after = await buildBktShadowReport(db);
    expect(before.coverage!.studentsInScope).toBe(7);
    expect(after.coverage!.studentsInScope).toBe(6);
  });
});
