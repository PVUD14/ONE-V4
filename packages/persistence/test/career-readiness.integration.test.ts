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
let pilotHash: string;

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
  pilotHash = createHash('sha256').update(pilotBytes).digest('hex');
  stagingManifest = JSON.parse(await readFile(new URL('../../../data/career-readiness/v4-staging-manifest.json', import.meta.url), 'utf8')) as ImportPackageManifest;
  await stageImportManifest(pool, stagingManifest, actors.authorUserId);
  await publishCareerReadinessPilot(pool, fixture, pilotHash, actors);
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
    expect(catalog).toMatchObject({ pilot: 'Career Readiness Fundamentals', topics: expect.arrayContaining(
      fixture.topics.map(({ id, stableKey, name, description }) => ({ id, stableKey, name, description })),
    ) });
    expect(JSON.stringify(catalog)).not.toContain('correctOptionId');
    expect(JSON.stringify(catalog)).not.toContain('answer_hash');
  });

  it('records authored pilot provenance against the commit that introduced the source fixture', async () => {
    const provenance = await pool.query<{
      source_repository: string;
      source_commit: string;
      source_paths: string[];
      checksums: Record<string, string>;
    }>(
      `SELECT source_repository, source_commit, source_paths, checksums
       FROM source_packages
       WHERE deterministic_key LIKE 'career-readiness-pilot-v1-%'`,
    );
    expect(provenance.rows).toHaveLength(1);
    expect(provenance.rows[0]).toMatchObject({
      source_repository: 'https://github.com/PVUD14/planthepath-next',
      source_commit: '3d1a754b6d1eccb9a44249b0caed521a7df9ffd8',
      source_paths: ['data/career-readiness/pilot-v1.json'],
      checksums: { 'data/career-readiness/pilot-v1.json': pilotHash },
    });
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

  it('recomputes readiness when a lesson is completed, not only when an assessment is submitted', async () => {
    // A learner who has done nothing yet, so the first completion is the only cause of
    // any snapshot that appears.
    const learner = randomUUID();
    await pool.query(
      `INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [learner, `sub-${learner}`, `${learner}@example.test`],
    );
    const before = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM readiness_snapshots WHERE subject_user_id=$1', [learner],
    );
    expect(before.rows[0]?.count).toBe(0);

    const result = await completeLesson(pool, {
      subjectUserId: learner, lessonVersionId: fixture.lessons[0]!.id, correlationId: 'lesson-recompute-check',
    }) as Record<string, unknown>;
    // The completion now reports the band it produced, rather than writing evidence and
    // leaving the figure older than the record it summarises.
    expect(result.readiness).toBeTruthy();

    const snapshot = await pool.query<{ advisory: boolean; employer_visible: boolean; model_version_id: string }>(
      'SELECT advisory, employer_visible, model_version_id FROM readiness_snapshots WHERE subject_user_id=$1 ORDER BY generated_at DESC LIMIT 1',
      [learner],
    );
    expect(snapshot.rows).toHaveLength(1);
    // Advisory and never employer-visible, whichever path produced it.
    expect(snapshot.rows[0]?.advisory).toBe(true);
    expect(snapshot.rows[0]?.employer_visible).toBe(false);

    // Stamped with the active model version, so a band is only ever comparable with one
    // computed under the same model (ADR-020).
    const active = await pool.query<{ id: string }>(
      "SELECT id FROM readiness_model_versions WHERE stable_key='career-readiness-fundamentals' AND active ORDER BY version DESC LIMIT 1",
    );
    expect(snapshot.rows[0]?.model_version_id).toBe(active.rows[0]?.id);
  });

  it('leaves a first import on readiness model version 2, the state a migration run produces', async () => {
    // beforeAll truncates users, which cascades to model versions, and then imports: the
    // same order as an environment migrated before its first import. 0030 could not
    // publish version 2 then, because version 1 did not exist yet.
    const versions = await pool.query<{ version: number; active: boolean }>(
      `SELECT version, active FROM readiness_model_versions
       WHERE stable_key='career-readiness-fundamentals' ORDER BY version`,
    );
    expect(versions.rows).toEqual([{ version: 1, active: false }, { version: 2, active: true }]);
  });

  it('leaves an already-completed lesson alone rather than resnapshotting on replay', async () => {
    const learner = randomUUID();
    await pool.query(
      `INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [learner, `sub-${learner}`, `${learner}@example.test`],
    );
    await completeLesson(pool, { subjectUserId: learner, lessonVersionId: fixture.lessons[0]!.id, correlationId: 'replay-first' });
    const afterFirst = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM readiness_snapshots WHERE subject_user_id=$1', [learner],
    );
    const replay = await completeLesson(pool, { subjectUserId: learner, lessonVersionId: fixture.lessons[0]!.id, correlationId: 'replay-second' });
    expect(replay.idempotentReplay).toBe(true);
    const afterReplay = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM readiness_snapshots WHERE subject_user_id=$1', [learner],
    );
    // A replay is not new evidence, so it is not a new band.
    expect(afterReplay.rows[0]?.count).toBe(afterFirst.rows[0]?.count);
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

  it('resumes an attempt still inside its window instead of refusing a new one', async () => {
    const learnerId = randomUUID();
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [learnerId, `resume-test:${learnerId}`, `resume-${learnerId}@example.test`]);
    const first = await startAssessmentAttempt(pool, { subjectUserId: learnerId,
      assessmentDefinitionId: fixture.assessment.id, correlationId: 'resume-start-1', selectionSeed: 'resume-seed-one-0000000000' });
    const again = await startAssessmentAttempt(pool, { subjectUserId: learnerId,
      assessmentDefinitionId: fixture.assessment.id, correlationId: 'resume-start-2', selectionSeed: 'resume-seed-two-0000000000' });

    // The same attempt, the same questions, the same deadline. A different seed must not
    // reshuffle a paper the learner has already seen.
    expect(again.attemptId).toBe(first.attemptId);
    expect(again.resumed).toBe(true);
    expect(again.expiresAt).toBe(first.expiresAt);
    expect((again.questions as { id: string }[]).map((q) => q.id))
      .toEqual((first.questions as { id: string }[]).map((q) => q.id));
    expect(JSON.stringify(again)).not.toContain('correctOptionId');
  });

  it('honours the definition attempt limit and counts an abandoned attempt against it', async () => {
    const learnerId = randomUUID();
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [learnerId, `limit-test:${learnerId}`, `limit-${learnerId}@example.test`]);
    const limit = await pool.query<{ attempt_limit: number }>(
      'SELECT attempt_limit FROM assessment_definitions WHERE id=$1', [fixture.assessment.id]);
    // The point of the fix: the column decides, and it is no longer one.
    expect(limit.rows[0]?.attempt_limit).toBe(3);

    const answerFor = (started: Record<string, unknown>) => Object.fromEntries(
      (started.questions as { id: string }[]).map((q) => [q.id, fixture.assessment.questions.find((f) => f.id === q.id)!.correctOptionId]),
    );
    for (const round of [1, 2]) {
      const started = await startAssessmentAttempt(pool, { subjectUserId: learnerId,
        assessmentDefinitionId: fixture.assessment.id, correlationId: `limit-start-${round}`, selectionSeed: `limit-seed-${round}-0000000000` });
      await submitAssessmentAttempt(pool, { subjectUserId: learnerId, attemptId: started.attemptId as string,
        idempotencyKey: `limit-submit-${round}`, selectedOptions: answerFor(started), correlationId: `limit-submit-${round}` });
    }

    // Start a third and abandon it. An expired attempt is retired rather than left to
    // block the learner forever, but it still consumes an attempt: the questions were
    // seen, so abandoning must not be a free re-draw from the bank.
    const abandoned = await startAssessmentAttempt(pool, { subjectUserId: learnerId,
      assessmentDefinitionId: fixture.assessment.id, correlationId: 'limit-start-3', selectionSeed: 'limit-seed-3-0000000000' });
    // Both ends move: assessment_attempt_window_ck insists expires_at > started_at.
    await pool.query(
      `UPDATE assessment_attempts SET started_at=now() - interval '2 hours', expires_at=now() - interval '1 hour' WHERE id=$1`,
      [abandoned.attemptId]);

    await expect(startAssessmentAttempt(pool, { subjectUserId: learnerId,
      assessmentDefinitionId: fixture.assessment.id, correlationId: 'limit-start-4', selectionSeed: 'limit-seed-4-0000000000' }))
      .rejects.toThrow('attempt limit reached');
    const states = await pool.query<{ state: string }>(
      'SELECT state FROM assessment_attempts WHERE id=$1', [abandoned.attemptId]);
    expect(states.rows[0]?.state).toBe('EXPIRED');
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
    // Five authorized DEVELOPING snapshots, none of the unauthorized READY ones. Every other
    // band is an empty cell, so it shows as suppressed, and the total is withheld because it
    // would say those bands are empty (INST-SR-01).
    expect(report).toMatchObject({
      aggregate: {
        suppressed: false,
        minimumCohortSize: 5,
        cohortSize: null,
        cohortSizeSuppressed: true,
        bands: [
          { band: 'NOT_ENOUGH_EVIDENCE', count: null, suppressed: true },
          { band: 'DEVELOPING', count: 5, suppressed: false },
          { band: 'PROGRESSING', count: null, suppressed: true },
          { band: 'READY_FOR_NEXT_STEP', count: null, suppressed: true },
        ],
      },
    });
  });

  it('suppresses every band under 5 and any total that would recover one, in the response and the stored report', async () => {
    const institutionId = randomUUID();
    await pool.query(`INSERT INTO organizations (id, kind, legal_name, verification_state) VALUES ($1,'INSTITUTION','Band Suppression Test','VERIFIED')`, [institutionId]);
    const model = await pool.query<{ id: string }>(`SELECT id FROM readiness_model_versions WHERE active ORDER BY published_at DESC LIMIT 1`);
    const modelVersionId = model.rows[0]!.id;
    async function cohort(bandCounts: Readonly<Record<string, number>>, month: string): Promise<void> {
      for (const [band, count] of Object.entries(bandCounts)) {
        for (let index = 0; index < count; index += 1) {
          const userId = randomUUID();
          await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
            [userId, `band-suppression:${userId}`, `band-suppression-${userId}@example.test`]);
          await pool.query(`INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from)
            VALUES ($1,$2,$3,'ACTIVE','2026-01-01T00:00:00Z')`, [randomUUID(), institutionId, userId]);
          await pool.query(`INSERT INTO readiness_snapshots (id, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, explanation, generated_at)
            VALUES ($1,$2,$3,'{}'::uuid[],$4,$5,'{}'::jsonb,$6)`,
          [randomUUID(), userId, modelVersionId, createHash('sha256').update(`band-suppression:${userId}`).digest('hex'), band, `${month}-10T00:00:00Z`]);
        }
      }
    }
    // One student alone in READY_FOR_NEXT_STEP: 7 + 6 + 1 published beside 14 would name them.
    await cohort({ DEVELOPING: 7, PROGRESSING: 6, READY_FOR_NEXT_STEP: 1 }, '2026-03');
    const lonely = await generateInstitutionAggregateReport(pool, { institutionId, periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(lonely.aggregate).toEqual({
      suppressed: false, minimumCohortSize: 5, cohortSize: null, cohortSizeSuppressed: true, scope: 'INSTITUTION',
      bands: [
        { band: 'NOT_ENOUGH_EVIDENCE', count: null, suppressed: true },
        { band: 'DEVELOPING', count: 7, suppressed: false },
        { band: 'PROGRESSING', count: 6, suppressed: false },
        { band: 'READY_FOR_NEXT_STEP', count: null, suppressed: true },
      ],
    });
    const stored = await pool.query<{ aggregate: unknown }>('SELECT aggregate FROM institution_aggregate_reports WHERE id=$1', [lonely['reportId']]);
    expect(stored.rows[0]!.aggregate).toEqual(lonely.aggregate);
    expect(JSON.stringify(stored.rows[0]!.aggregate)).not.toMatch(/"count":[0-4][,}]|"cohortSize":14/);

    // Hidden bands holding 5 between them (3 + 2) leave the total safe to publish.
    await cohort({ NOT_ENOUGH_EVIDENCE: 3, DEVELOPING: 8, PROGRESSING: 2, READY_FOR_NEXT_STEP: 6 }, '2026-04');
    const grouped = await generateInstitutionAggregateReport(pool, { institutionId, periodStart: '2026-04-01', periodEnd: '2026-04-30' });
    expect(grouped.aggregate).toMatchObject({
      suppressed: false, cohortSize: 19, cohortSizeSuppressed: false,
      bands: [
        { band: 'NOT_ENOUGH_EVIDENCE', count: null, suppressed: true },
        { band: 'DEVELOPING', count: 8, suppressed: false },
        { band: 'PROGRESSING', count: null, suppressed: true },
        { band: 'READY_FOR_NEXT_STEP', count: 6, suppressed: false },
      ],
    });
  });

  it('returns the band over time newest first, agreeing with the current snapshot', async () => {
    const model = await pool.query<{ id: string }>(
      `SELECT id FROM readiness_model_versions WHERE active ORDER BY published_at DESC LIMIT 1`,
    );
    const modelVersionId = model.rows[0]!.id;
    const learner = randomUUID();
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [learner, `band-history:${learner}`, `band-history-${learner}@example.test`]);

    // Inserted out of chronological order, so a pass cannot be explained by insertion
    // order standing in for the ORDER BY.
    const points: readonly (readonly [string, string])[] = [
      ['PROGRESSING', '2026-07-01T00:00:00Z'],
      ['NOT_ENOUGH_EVIDENCE', '2026-05-01T00:00:00Z'],
      ['READY_FOR_NEXT_STEP', '2026-08-01T00:00:00Z'],
      ['DEVELOPING', '2026-06-01T00:00:00Z'],
    ];
    for (const [band, generatedAt] of points) {
      await pool.query(
        `INSERT INTO readiness_snapshots
         (id, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, explanation, generated_at)
         VALUES ($1,$2,$3,'{}'::uuid[],$4,$5,'{}'::jsonb,$6)`,
        [randomUUID(), learner, modelVersionId, createHash('sha256').update(`${learner}:${generatedAt}`).digest('hex'), band, generatedAt],
      );
    }

    const state = await getLearnerCareerReadinessState(pool, learner);
    const history = state.readinessHistory as readonly { band: string; modelVersionId: string; generatedAt: Date; id: string }[];

    expect(history.map((entry) => entry.band)).toStrictEqual([
      'READY_FOR_NEXT_STEP', 'PROGRESSING', 'DEVELOPING', 'NOT_ENOUGH_EVIDENCE',
    ]);
    expect(history.every((entry) => entry.modelVersionId === modelVersionId)).toBe(true);
    expect(history.every((entry) => entry.generatedAt instanceof Date)).toBe(true);

    // The invariant a client can rely on: the newest history entry is the snapshot
    // already served as `readiness`, so the two can never disagree.
    const current = state.readiness as { id: string; band: string };
    expect(history[0]!.id).toBe(current.id);
    expect(history[0]!.band).toBe(current.band);
  });

  it("never returns another learner's snapshots", async () => {
    const model = await pool.query<{ id: string }>(
      `SELECT id FROM readiness_model_versions WHERE active ORDER BY published_at DESC LIMIT 1`,
    );
    const modelVersionId = model.rows[0]!.id;
    const mine = randomUUID();
    const theirs = randomUUID();
    for (const [id, label] of [[mine, 'mine'], [theirs, 'theirs']] as const) {
      await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
        [id, `isolation-${label}:${id}`, `isolation-${label}-${id}@example.test`]);
      await pool.query(
        `INSERT INTO readiness_snapshots
         (id, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, explanation, generated_at)
         VALUES ($1,$2,$3,'{}'::uuid[],$4,$5,'{}'::jsonb,'2026-06-15T00:00:00Z')`,
        [randomUUID(), id, modelVersionId, createHash('sha256').update(`isolation:${id}`).digest('hex'),
          label === 'mine' ? 'DEVELOPING' : 'READY_FOR_NEXT_STEP'],
      );
    }

    const state = await getLearnerCareerReadinessState(pool, mine);
    const history = state.readinessHistory as readonly { band: string }[];
    expect(history).toHaveLength(1);
    expect(history[0]!.band).toBe('DEVELOPING');
  });

  it('reports an empty history rather than failing when a learner has no snapshot', async () => {
    const learner = randomUUID();
    await pool.query(`INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
      [learner, `no-history:${learner}`, `no-history-${learner}@example.test`]);
    const state = await getLearnerCareerReadinessState(pool, learner);
    expect(state.readinessHistory).toStrictEqual([]);
    expect(state.readiness).toBeNull();
  });
});
