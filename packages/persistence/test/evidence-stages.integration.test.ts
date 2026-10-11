/**
 * Database acceptance tests for ENG-04: the evidence_records and career_role_requirements columns
 * added by 0050, the stage and assisted flag every evidence writer stamps at insert, the C3 fix to
 * the readiness-check `outcomeBand`, the reconciled readiness model ID, and — deliberately — that
 * the live career-readiness-mastery-v1 band is unchanged.
 * Design: docs/architecture/evidence-stages-table-design.md.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CAREER_READINESS_MODEL, projectTopicMastery, type EvidenceInput, type ImportPackageManifest } from '@planthepath/career-readiness/src/index.js';
import {
  completeLesson,
  publishCareerReadinessPilot,
  stageImportManifest,
  startAssessmentAttempt,
  submitAssessmentAttempt,
  type PilotFixture,
} from '../src/career-readiness.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const actors = {
  authorUserId: '31500000-0000-4000-8000-000000000001',
  reviewerUserId: '31500000-0000-4000-8000-000000000002',
  publisherUserId: '31500000-0000-4000-8000-000000000003',
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
      [userId, `evidence-stages-actor:${index}`, `evidence-stages-actor-${index}@example.test`]);
  }
  const pilotBytes = await readFile(new URL('../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const manifest = JSON.parse(await readFile(new URL('../../../data/career-readiness/v4-staging-manifest.json', import.meta.url), 'utf8')) as ImportPackageManifest;
  await stageImportManifest(pool, manifest, actors.authorUserId);
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
});

afterAll(async () => pool.end());

async function newLearner(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
    [id, `evidence-stages:${id}`, `${id}@example.test`]);
  // Quiet hours off, so the due-notification path behaves the same on every run.
  await pool.query(`INSERT INTO notification_preferences (user_id, quiet_hours_start_minute, quiet_hours_end_minute) VALUES ($1,0,0)`, [id]);
  return id;
}

/** Sit the readiness check; `correct` decides whether every answer is right or every answer wrong. */
async function sitCheck(learner: string, round: number, correct: boolean): Promise<Record<string, unknown> & { topics: string[] }> {
  const started = await startAssessmentAttempt(pool, { subjectUserId: learner, assessmentDefinitionId: fixture.assessment.id,
    correlationId: `stages-start-${round}`, selectionSeed: `stages-seed-${learner}-${round}` });
  const questions = (started.questions as { id: string }[]).map((q) => fixture.assessment.questions.find((f) => f.id === q.id)!);
  const selectedOptions = Object.fromEntries(questions.map((q) => [q.id,
    correct ? q.correctOptionId : q.options.find((option) => option.id !== q.correctOptionId)!.id]));
  const submitted = await submitAssessmentAttempt(pool, { subjectUserId: learner, attemptId: started.attemptId as string,
    idempotencyKey: `stages-submit-${round}-${learner.slice(0, 8)}`, selectedOptions, correlationId: `stages-submit-${round}` });
  return { ...submitted, topics: [...new Set(questions.map((q) => q.topicId))] };
}

/** A graded practice attempt in the past, as a later graded-practice path would write it. */
async function pastAttempt(learner: string, topicId: string, input: { daysAgo: number; correct: boolean; hint?: number }): Promise<void> {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO learning_sessions (id, subject_user_id, mode, started_at, ended_at)
     VALUES ($1,$2,'PRACTICE', now() - make_interval(days => $3), now() - make_interval(days => $3))`,
    [sessionId, learner, input.daysAgo],
  );
  const hint = input.hint ?? 0;
  await pool.query(
    `INSERT INTO learning_attempt_events
       (id, subject_user_id, session_id, item_source, item_id, item_version, skill_id, context, answered, correct, score,
        highest_hint_level, assisted, content_version, source_attempt_type, source_attempt_id, occurred_at)
     VALUES ($1,$2,$3,'CAREER_READINESS_QUESTION',$4,1,$5,'PRACTICE',true,$6,$7,$8,$9,'practice-test','assessment_attempt',$10,
             now() - make_interval(days => $11))`,
    [randomUUID(), learner, sessionId, randomUUID(), topicId, input.correct, input.correct ? 1 : 0, hint, hint >= 3,
      randomUUID(), input.daysAgo],
  );
}

async function evidenceFor(learner: string, type = 'ASSESSMENT_OUTCOME'): Promise<{ topic_id: string; assisted: boolean; stage_at_capture: string }[]> {
  const rows = await pool.query<{ topic_id: string; assisted: boolean; stage_at_capture: string }>(
    'SELECT topic_id, assisted, stage_at_capture FROM evidence_records WHERE subject_user_id=$1 AND evidence_type=$2 ORDER BY occurred_at, topic_id',
    [learner, type]);
  return rows.rows;
}

describe('0050 columns', () => {
  it('adds assisted and stage_at_capture to evidence with conservative defaults', async () => {
    const columns = await pool.query<{ column_name: string; column_default: string; is_nullable: string }>(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name='evidence_records' AND column_name IN ('assisted','stage_at_capture') ORDER BY column_name`);
    expect(columns.rows).toEqual([
      { column_name: 'assisted', column_default: 'false', is_nullable: 'NO' },
      { column_name: 'stage_at_capture', column_default: "'ESTIMATED'::text", is_nullable: 'NO' },
    ]);
  });

  it('refuses a stage outside the four, and keeps evidence immutable including the new columns', async () => {
    const learner = await newLearner();
    await completeLesson(pool, { subjectUserId: learner, lessonVersionId: fixture.lessons[0]!.id, correlationId: 'stages-immutable' });
    const row = await pool.query<{ id: string }>('SELECT id FROM evidence_records WHERE subject_user_id=$1', [learner]);
    await expect(pool.query("UPDATE evidence_records SET stage_at_capture='DEMONSTRATED' WHERE id=$1", [row.rows[0]!.id]))
      .rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE evidence_records SET assisted=true WHERE id=$1", [row.rows[0]!.id])).rejects.toThrow(/immutable/);
    await expect(pool.query(
      `INSERT INTO evidence_records (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type,
         source_aggregate_id, content_version, provenance, occurred_at, stage_at_capture)
       VALUES ($1,$2,'TOPIC_DEMONSTRATION',$3,1,1,'test',$4,'test-v1','{}'::jsonb,now(),'MASTERED')`,
      [randomUUID(), learner, fixture.lessons[0]!.topicId, randomUUID()],
    )).rejects.toThrow(/evidence_stage_at_capture_ck/);
  });

  it('adds required_evidence_types to career requirements, empty by default and limited to recordable types', async () => {
    const roleId = randomUUID();
    await pool.query(`INSERT INTO career_roles (id, code, title, family) VALUES ($1,$2,'Stage test role','Test')`,
      [roleId, `STAGE_TEST_${roleId.slice(0, 8).toUpperCase()}`]);
    const topicId = fixture.lessons[0]!.topicId;
    const requirementId = randomUUID();
    await pool.query(`INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery)
      VALUES ($1,$2,$3,'ESSENTIAL',0.8)`, [requirementId, roleId, topicId]);
    const stored = await pool.query<{ required_evidence_types: string[] }>(
      'SELECT required_evidence_types FROM career_role_requirements WHERE id=$1', [requirementId]);
    expect(stored.rows[0]?.required_evidence_types).toEqual([]);

    await pool.query(`UPDATE career_role_requirements SET required_evidence_types=ARRAY['ASSESSMENT_OUTCOME'] WHERE id=$1`, [requirementId]);
    await expect(pool.query(`UPDATE career_role_requirements SET required_evidence_types=ARRAY['CERTIFICATE'] WHERE id=$1`, [requirementId]))
      .rejects.toThrow(/career_requirement_evidence_types_ck/);
    await expect(pool.query(`UPDATE career_role_requirements SET required_evidence_types=ARRAY[NULL]::text[] WHERE id=$1`, [requirementId]))
      .rejects.toThrow(/career_requirement_evidence_types_ck/);
  });
});

describe('C3 in the readiness-check outcome', () => {
  it('labels a first check NOT_ENOUGH_EVIDENCE, never DEVELOPING, even when every answer is wrong', async () => {
    const learner = await newLearner();
    const first = await sitCheck(learner, 1, false);
    expect(first.outcomeBand).toBe('NOT_ENOUGH_EVIDENCE');
    const event = await pool.query<{ payload: { outcomeBand: string } }>(
      "SELECT payload FROM outbox_events WHERE event_type='assessment.attempt.submitted' AND aggregate_id=$1", [first.attemptId]);
    expect(event.rows[0]?.payload.outcomeBand).toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('still says NOT_ENOUGH_EVIDENCE for a second check on the same day', async () => {
    const learner = await newLearner();
    await sitCheck(learner, 1, true);
    const second = await sitCheck(learner, 2, true);
    expect(second.outcomeBand).toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('gives the ratio band once the checks span two calendar days', async () => {
    const learner = await newLearner();
    // A check submitted two days ago. Submitted attempts are immutable, so it is written as
    // submitted in the past while still in progress, before the trigger would protect it.
    const earlier = await startAssessmentAttempt(pool, { subjectUserId: learner, assessmentDefinitionId: fixture.assessment.id,
      correlationId: 'stages-earlier', selectionSeed: `stages-earlier-${learner}` });
    await pool.query(`UPDATE assessment_attempts SET state='SUBMITTED', started_at=now() - interval '2 days 10 minutes',
      expires_at=now() - interval '2 days' + interval '20 minutes', submitted_at=now() - interval '2 days',
      submission_idempotency_key=$2, score_correct=4, score_possible=4 WHERE id=$1`,
      [earlier.attemptId, `stages-earlier-${learner.slice(0, 8)}`]);
    const second = await sitCheck(learner, 2, true);
    expect(second.outcomeBand).toBe('DEMONSTRATED');
  });
});

describe('stage and assisted flag stamped at capture', () => {
  it('a first all-correct check captures RETAINED, unaided, for every topic on the paper', async () => {
    const learner = await newLearner();
    const sat = await sitCheck(learner, 1, true);
    const rows = await evidenceFor(learner);
    expect(rows.map((row) => row.topic_id).sort()).toEqual([...sat.topics].sort());
    expect(rows.every((row) => row.stage_at_capture === 'RETAINED' && row.assisted === false)).toBe(true);
  });

  it('a first all-wrong check captures ESTIMATED', async () => {
    const learner = await newLearner();
    await sitCheck(learner, 1, false);
    expect((await evidenceFor(learner)).every((row) => row.stage_at_capture === 'ESTIMATED')).toBe(true);
  });

  it('an unaided success on an earlier day makes a correct check capture DEMONSTRATED', async () => {
    const learner = await newLearner();
    for (const topic of fixture.topics) await pastAttempt(learner, topic.id, { daysAgo: 2, correct: true });
    await sitCheck(learner, 1, true);
    expect((await evidenceFor(learner)).every((row) => row.stage_at_capture === 'DEMONSTRATED')).toBe(true);
  });

  it('C5: a hint-3 success on an earlier day does not count — the check captures RETAINED, not DEMONSTRATED', async () => {
    const learner = await newLearner();
    for (const topic of fixture.topics) await pastAttempt(learner, topic.id, { daysAgo: 2, correct: true, hint: 3 });
    const assisted = await pool.query<{ assisted: boolean }>('SELECT assisted FROM learning_attempt_events WHERE subject_user_id=$1', [learner]);
    expect(assisted.rows.every((row) => row.assisted)).toBe(true);
    await sitCheck(learner, 1, true);
    expect((await evidenceFor(learner)).every((row) => row.stage_at_capture === 'RETAINED')).toBe(true);
  });

  it('a lesson completion captures the stage its attempts support and adds nothing itself', async () => {
    const learner = await newLearner();
    const topicId = fixture.lessons[0]!.topicId;
    await completeLesson(pool, { subjectUserId: learner, lessonVersionId: fixture.lessons[0]!.id, correlationId: 'stages-lesson-1' });
    expect(await evidenceFor(learner, 'LESSON_COMPLETION')).toEqual([{ topic_id: topicId, assisted: false, stage_at_capture: 'ESTIMATED' }]);

    const other = await newLearner();
    await pastAttempt(other, topicId, { daysAgo: 1, correct: true });
    await completeLesson(pool, { subjectUserId: other, lessonVersionId: fixture.lessons[0]!.id, correlationId: 'stages-lesson-2' });
    expect((await evidenceFor(other, 'LESSON_COMPLETION'))[0]?.stage_at_capture).toBe('RETAINED');
  });
});

describe('the live readiness path is unchanged by decision', () => {
  it('still bands topics with career-readiness-mastery-v1, lesson completions included', async () => {
    const learner = await newLearner();
    await completeLesson(pool, { subjectUserId: learner, lessonVersionId: fixture.lessons[0]!.id, correlationId: 'stages-live-lesson' });
    await sitCheck(learner, 1, false);

    const evidence = await pool.query<{
      id: string; evidence_type: EvidenceInput['evidenceType']; topic_id: string; demonstrated: number; possible: number;
      source_aggregate_type: string; source_aggregate_id: string; content_version: string; occurred_at: Date;
    }>(`SELECT id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id, content_version, occurred_at
        FROM evidence_records WHERE subject_user_id=$1`, [learner]);
    const expected = projectTopicMastery(evidence.rows.map((row) => ({ id: row.id, subjectUserId: learner, evidenceType: row.evidence_type,
      topicId: row.topic_id, demonstrated: row.demonstrated, possible: row.possible, sourceAggregateType: row.source_aggregate_type,
      sourceAggregateId: row.source_aggregate_id, contentVersion: row.content_version, occurredAt: new Date(row.occurred_at).toISOString() })));
    const live = await pool.query<{ topic_id: string; band: string; algorithm_version: string }>(
      `SELECT DISTINCT ON (topic_id) topic_id, band, algorithm_version FROM mastery_projections
       WHERE subject_user_id=$1 ORDER BY topic_id, generated_at DESC`, [learner]);
    expect(live.rows.map((row) => ({ topicId: row.topic_id, band: row.band, algorithm: row.algorithm_version })))
      .toEqual(expected.map((projection) => ({ topicId: projection.topicId, band: projection.band, algorithm: 'career-readiness-mastery-v1' })));
    // The lesson topic has a completion plus one wrong check: v1 still bands it, which C3 would not.
    // Recorded as a decision for Divakar in the design note; this test fails if it changes silently.
    // Every paper draws from both pilot topics, so the lesson topic is always on it.
    expect(live.rows.find((row) => row.topic_id === fixture.lessons[0]!.topicId)?.band).toBe('DEVELOPING');
  });

  it('stamps snapshots with the active model version the code names', async () => {
    const active = await pool.query<{ stable_key: string; version: number; algorithm: string }>(
      `SELECT stable_key, version, policy->>'algorithm' AS algorithm FROM readiness_model_versions
       WHERE stable_key='career-readiness-fundamentals' AND active`);
    expect(active.rows).toEqual([{ stable_key: CAREER_READINESS_MODEL.stableKey, version: CAREER_READINESS_MODEL.version,
      algorithm: CAREER_READINESS_MODEL.masteryAlgorithm }]);
  });
});
