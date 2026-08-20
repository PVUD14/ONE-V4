import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { ImportPackageManifest } from '@planthepath/career-readiness/src/index.js';
import {
  completeLesson,
  generateInstitutionAggregateReport,
  getLearnerCareerReadinessState,
  getPublishedCareerReadinessCatalog,
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
  authorUserId: '31000000-0000-4000-8000-000000000001',
  reviewerUserId: '31000000-0000-4000-8000-000000000002',
  publisherUserId: '31000000-0000-4000-8000-000000000003',
};
const studentUserId = '31000000-0000-4000-8000-000000000004';
let fixture: PilotFixture;
let stagingManifest: ImportPackageManifest;

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
  await pool.query(`TRUNCATE users CASCADE`);
  for (const [index, userId] of [...Object.values(actors), studentUserId].entries()) {
    await pool.query(
      `INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [userId, `career-readiness-test:${index}`, `career-readiness-${index}@example.test`],
    );
  }
  const pilotBytes = await readFile(new URL('../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  stagingManifest = JSON.parse(await readFile(new URL('../../../data/career-readiness/v4-staging-manifest.json', import.meta.url), 'utf8')) as ImportPackageManifest;
  await stageImportManifest(pool, stagingManifest, actors.authorUserId);
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
});

afterAll(async () => pool.end());

describe('Career Readiness Fundamentals production path', () => {
  it('stages the frozen V4 candidates as quarantined and is idempotent', async () => {
    const replay = await stageImportManifest(pool, stagingManifest, actors.authorUserId);
    expect(replay).toMatchObject({ recordCount: 11, idempotentReplay: true });
    const blocked = await pool.query(
      `SELECT count(*)::int AS count FROM source_records sr JOIN source_packages sp ON sp.id=sr.package_id
       WHERE sp.source_repository='https://github.com/PVUD14/V4--Database' AND (sr.release_eligible OR sr.release_state <> 'QUARANTINED')`,
    );
    expect(blocked.rows[0]?.count).toBe(0);
  });

  it('publishes only governed PlanThePath-owned content and omits answer keys', async () => {
    const catalog = await getPublishedCareerReadinessCatalog(pool);
    expect(catalog).toMatchObject({ pilot: 'Career Readiness Fundamentals' });
    expect(JSON.stringify(catalog)).not.toContain('correctOptionId');
    expect(JSON.stringify(catalog)).not.toContain('answer_hash');
  });

  it('rejects bypasses around the content review and finalized manifest boundaries', async () => {
    await expect(pool.query(
      `INSERT INTO release_manifests
       (id, name, version, manifest_hash, status, approved_by_user_id, published_by_user_id, approved_at, published_at)
       VALUES ($1,'Direct Published Bypass',1,$2,'PUBLISHED',$3,$4,now(),now())`,
      [randomUUID(), 'c'.repeat(64), actors.reviewerUserId, actors.publisherUserId],
    )).rejects.toThrow(/must contain items/);
    await expect(pool.query(
      `INSERT INTO content_revisions
       (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body, release_manifest_id, published_at)
       VALUES ($1,'LESSON',$2,1,$3,'PUBLISHED',$4,'{}'::jsonb,$5,now())`,
      [randomUUID(), randomUUID(), actors.authorUserId, 'a'.repeat(64), '25000000-0000-4000-8000-000000000001'],
    )).rejects.toThrow(/review lifecycle/);

    const item = await pool.query<{ manifest_id: string; content_revision_id: string }>(
      `SELECT manifest_id, content_revision_id FROM release_manifest_items LIMIT 1`,
    );
    await expect(pool.query(
      `UPDATE release_manifest_items SET item_hash=$3 WHERE manifest_id=$1 AND content_revision_id=$2`,
      [item.rows[0]?.manifest_id, item.rows[0]?.content_revision_id, 'b'.repeat(64)],
    )).rejects.toThrow(/finalized release manifest items are immutable/);
  });

  it('enforces prerequisites, completes lessons, and emits immutable evidence atomically', async () => {
    await expect(completeLesson(pool, { subjectUserId: studentUserId, lessonVersionId: fixture.lessons[1]!.id, correlationId: 'lesson-order-check' }))
      .rejects.toThrow('prerequisites');
    for (const lesson of fixture.lessons) {
      await completeLesson(pool, { subjectUserId: studentUserId, lessonVersionId: lesson.id, correlationId: `lesson-${lesson.stableKey}` });
    }
    const evidence = await pool.query('SELECT id FROM evidence_records WHERE subject_user_id=$1 ORDER BY occurred_at LIMIT 1', [studentUserId]);
    await expect(pool.query('UPDATE evidence_records SET demonstrated=0 WHERE id=$1', [evidence.rows[0]?.id])).rejects.toThrow(/immutable/);
    const events = await pool.query("SELECT count(*)::int AS count FROM outbox_events WHERE event_type='learning.lesson.completed'");
    expect(events.rows[0]?.count).toBe(3);
  });

  it('freezes question selection, submits once, and derives transparent advisory state', async () => {
    await pool.query(
      `INSERT INTO notification_preferences (user_id, quiet_hours_start_minute, quiet_hours_end_minute)
       VALUES ($1,0,0) ON CONFLICT (user_id) DO UPDATE SET quiet_hours_start_minute=0, quiet_hours_end_minute=0`, [studentUserId],
    );
    const started = await startAssessmentAttempt(pool, { subjectUserId: studentUserId, assessmentDefinitionId: fixture.assessment.id,
      correlationId: 'assessment-start-1', selectionSeed: 'student-assessment-seed-v1' });
    expect(JSON.stringify(started)).not.toContain('correctOptionId');
    const questionIds = (started.questions as { id: string }[]).map((question) => question.id);
    const selectedOptions = Object.fromEntries(questionIds.map((id) => [id, fixture.assessment.questions.find((q) => q.id === id)!.correctOptionId]));
    const submitted = await submitAssessmentAttempt(pool, { subjectUserId: studentUserId, attemptId: started.attemptId as string,
      idempotencyKey: 'assessment-submit-1', selectedOptions, correlationId: 'assessment-submit-1' });
    expect(submitted).toMatchObject({ scoreCorrect: 4, scorePossible: 4, idempotentReplay: false,
      readiness: { advisory: true, employerVisible: false } });
    await expect(submitAssessmentAttempt(pool, { subjectUserId: studentUserId, attemptId: started.attemptId as string,
      idempotencyKey: 'assessment-submit-2', selectedOptions, correlationId: 'assessment-submit-2' })).rejects.toThrow('already submitted');
    const replay = await submitAssessmentAttempt(pool, { subjectUserId: studentUserId, attemptId: started.attemptId as string,
      idempotencyKey: 'assessment-submit-1', selectedOptions, correlationId: 'assessment-submit-1' });
    expect(replay).toMatchObject({ idempotentReplay: true, scoreCorrect: 4 });
    const state = await getLearnerCareerReadinessState(pool, studentUserId);
    expect(state).toMatchObject({ readiness: { advisory: true, employerVisible: false } });
    expect(JSON.stringify(state)).not.toContain('selected_option_id');
  });

  it('suppresses institution aggregates below the privacy threshold', async () => {
    const institutionId = randomUUID();
    await pool.query(`INSERT INTO organizations (id, kind, legal_name, verification_state) VALUES ($1,'INSTITUTION','Aggregate Test','VERIFIED')`, [institutionId]);
    const report = await generateInstitutionAggregateReport(pool, { institutionId, periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    expect(report).toMatchObject({ aggregate: { suppressed: true, minimumCohortSize: 5, cohortSize: 0, bands: [] } });
    expect(JSON.stringify(report)).not.toContain(studentUserId);
  });

  it('aggregates only snapshots created while the institution relationship authorized access', async () => {
    const institutionId = randomUUID();
    await pool.query(
      `INSERT INTO organizations (id, kind, legal_name, verification_state)
       VALUES ($1,'INSTITUTION','Temporal Aggregate Test','VERIFIED')`,
      [institutionId],
    );
    const model = await pool.query<{ id: string }>(
      `SELECT id FROM readiness_model_versions WHERE active ORDER BY published_at DESC LIMIT 1`,
    );
    const modelVersionId = model.rows[0]?.id;
    expect(modelVersionId).toBeTruthy();

    for (let index = 0; index < 10; index += 1) {
      const userId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
        [userId, `institution-temporal:${index}`, `institution-temporal-${index}@example.test`],
      );
      await pool.query(
        `INSERT INTO institution_relationships
         (id, institution_id, student_user_id, state, effective_from, effective_to)
         VALUES ($1,$2,$3,$4,'2026-05-01T00:00:00Z',$5)`,
        [randomUUID(), institutionId, userId, index < 5 ? 'TRANSFERRED' : 'ENDED', index < 5 ? '2026-06-01T00:00:00Z' : null],
      );
      await pool.query(
        `INSERT INTO readiness_snapshots
         (id, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, explanation, generated_at)
         VALUES ($1,$2,$3,'{}'::uuid[],$4,'DEVELOPING','{}'::jsonb,'2026-05-15T00:00:00Z')`,
        [randomUUID(), userId, modelVersionId, createHash('sha256').update(`authorized:${index}`).digest('hex')],
      );
      await pool.query(
        `INSERT INTO readiness_snapshots
         (id, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, explanation, generated_at)
         VALUES ($1,$2,$3,'{}'::uuid[],$4,'READY_FOR_NEXT_STEP','{}'::jsonb,'2026-06-01T00:00:00Z')`,
        [randomUUID(), userId, modelVersionId, createHash('sha256').update(`unauthorized:${index}`).digest('hex')],
      );
    }

    const report = await generateInstitutionAggregateReport(pool, {
      institutionId,
      periodStart: '2026-05-01',
      periodEnd: '2026-06-30',
    });
    expect(report).toMatchObject({
      aggregate: {
        suppressed: false,
        minimumCohortSize: 5,
        cohortSize: 5,
        bands: [{ band: 'DEVELOPING', count: 5 }],
      },
    });
  });
});
