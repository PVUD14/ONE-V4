import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  calculateAdvisoryReadiness,
  deterministicPackageIdentity,
  isSourceRecordReleaseEligible,
  mayCreateNotificationCommand,
  projectTopicMastery,
  recommendRoadmapActions,
  selectQuestionsDeterministically,
  sha256Hex,
  stableStringify,
  type EvidenceInput,
  type ImportPackageManifest,
  type ProtectedQuestionVersion,
} from '@planthepath/career-readiness/src/index.js';
import { createIntegrationEventEnvelope } from '@planthepath/events/src/index.js';

type QueryResult<T> = { rows: T[]; rowCount: number | null };
type DbClient = Pick<PoolClient, 'query'>;

export interface PilotFixture {
  readonly pilot: string;
  readonly version: number;
  readonly ownership: 'PlanThePath-Owned';
  readonly locale: string;
  readonly topics: readonly { readonly id: string; readonly stableKey: string; readonly name: string; readonly description: string }[];
  readonly module: { readonly id: string; readonly stableKey: string; readonly title: string; readonly description: string };
  readonly lessons: readonly {
    readonly id: string; readonly stableKey: string; readonly title: string; readonly topicId: string;
    readonly body: Readonly<Record<string, string>>; readonly prerequisiteLessonIds: readonly string[];
  }[];
  readonly assessment: {
    readonly id: string; readonly blueprintId: string; readonly stableKey: string; readonly title: string;
    readonly selectionCount: number; readonly timeLimitSeconds: number;
    readonly questions: readonly {
      readonly id: string; readonly stableKey: string; readonly topicId: string; readonly prompt: string;
      readonly options: ProtectedQuestionVersion['options']; readonly correctOptionId: string; readonly explanation: string;
    }[];
  };
}

export interface PilotPublicationActors {
  readonly authorUserId: string;
  readonly reviewerUserId: string;
  readonly publisherUserId: string;
}

const PILOT_SOURCE_REPOSITORY = 'https://github.com/PVUD14/planthepath-next';
const PILOT_SOURCE_COMMIT = '3d1a754b6d1eccb9a44249b0caed521a7df9ffd8';
const PILOT_TRANSFORM_VERSION = 'career-readiness-pilot-v1';
const PILOT_SOURCE_PATH = 'data/career-readiness/pilot-v1.json';
const PILOT_RELEASE_ID = '25000000-0000-4000-8000-000000000001';
const PILOT_SOURCE_RECORD_ID = '25000000-0000-4000-8000-000000000002';
const READINESS_MODEL_ID = '26000000-0000-4000-8000-000000000001';
const ROADMAP_POLICY_ID = '26000000-0000-4000-8000-000000000002';
const NOTIFICATION_TEMPLATE_ID = '26000000-0000-4000-8000-000000000003';

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function stageImportManifest(pool: Pool, manifest: ImportPackageManifest, actorUserId: string): Promise<{
  readonly packageIdentity: string; readonly manifestHash: string; readonly recordCount: number; readonly idempotentReplay: boolean;
}> {
  const packageIdentity = deterministicPackageIdentity(manifest);
  const manifestHash = sha256Hex(stableStringify(manifest));
  return transaction(pool, async (client) => {
    const existing = await client.query<{ manifest_hash: string }>(
      'SELECT manifest_hash FROM migration_runs WHERE package_identity = $1', [packageIdentity],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].manifest_hash !== manifestHash) throw new Error('import package identity conflicts with a different manifest hash');
      return { packageIdentity, manifestHash, recordCount: manifest.records.length, idempotentReplay: true };
    }

    const migrationRunId = randomUUID();
    const sourcePackageId = randomUUID();
    await client.query(
      `INSERT INTO migration_runs
       (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, record_counts, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'STAGED',$7,$8::jsonb,now())`,
      [migrationRunId, packageIdentity, manifest.sourceRepository, manifest.sourceCommit, manifestHash, manifest.transformVersion, actorUserId, JSON.stringify(manifest.recordCounts)],
    );
    await client.query(
      `INSERT INTO source_packages
       (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`,
      [sourcePackageId, migrationRunId, packageIdentity, manifest.sourceRepository, manifest.sourceCommit, manifestHash, manifest.transformVersion,
        JSON.stringify(manifest.sourcePaths), JSON.stringify(manifest.checksums), JSON.stringify(manifest)],
    );

    for (const record of manifest.records) {
      await client.query(
        `INSERT INTO source_records
         (id, package_id, source_entity_type, source_record_id, source_path, source_hash, source_metadata, license_label,
          attribution_required, rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state,
          rejection_reason_codes, release_eligible)
         VALUES ($1,$2,'QUESTION',$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16)`,
        [randomUUID(), sourcePackageId, record.sourceRecordId, record.sourcePath, record.sourceHash,
          JSON.stringify({ sourceCommit: record.sourceCommit, transformVersion: record.transformVersion }), record.licenseLabel,
          record.attributionRequired, record.rightsState, record.smeState, record.qualityState, record.mappingState,
          record.duplicateState, record.releaseState, [...record.rejectionReasonCodes], isSourceRecordReleaseEligible(record)],
      );
    }
    return { packageIdentity, manifestHash, recordCount: manifest.records.length, idempotentReplay: false };
  });
}

export async function publishCareerReadinessPilot(
  pool: Pool,
  fixture: PilotFixture,
  fixtureHash: string,
  actors: PilotPublicationActors,
): Promise<{ readonly releaseManifestId: string; readonly idempotentReplay: boolean }> {
  if (actors.authorUserId === actors.reviewerUserId) throw new Error('pilot author and reviewer must be different users');
  if (!/^[0-9a-f]{64}$/i.test(fixtureHash)) throw new Error('fixtureHash must be SHA-256');
  return transaction(pool, async (client) => {
    const existing = await client.query('SELECT id FROM release_manifests WHERE id = $1', [PILOT_RELEASE_ID]);
    if (existing.rows[0]) return { releaseManifestId: PILOT_RELEASE_ID, idempotentReplay: true };
    await requireExistingUsers(client, Object.values(actors));

    const migrationRunId = randomUUID();
    const sourcePackageId = randomUUID();
    const packageIdentity = `career-readiness-pilot-v1-${fixtureHash.slice(0, 24)}`;
    await client.query(
      `INSERT INTO migration_runs
       (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, record_counts, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'STAGED',$7,$8::jsonb,now())`,
      [migrationRunId, packageIdentity, PILOT_SOURCE_REPOSITORY, PILOT_SOURCE_COMMIT, fixtureHash, PILOT_TRANSFORM_VERSION,
        actors.authorUserId, JSON.stringify({ topics: fixture.topics.length, lessons: fixture.lessons.length, questions: fixture.assessment.questions.length })],
    );
    await client.query(
      `INSERT INTO source_packages
       (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`,
      [sourcePackageId, migrationRunId, packageIdentity, PILOT_SOURCE_REPOSITORY, PILOT_SOURCE_COMMIT, fixtureHash,
        PILOT_TRANSFORM_VERSION, JSON.stringify([PILOT_SOURCE_PATH]), JSON.stringify({ [PILOT_SOURCE_PATH]: fixtureHash }),
        JSON.stringify({ pilot: fixture.pilot, version: fixture.version, ownership: fixture.ownership })],
    );
    await client.query(
      `INSERT INTO source_records
       (id, package_id, source_entity_type, source_record_id, source_path, source_hash, source_metadata, license_label,
        attribution_required, rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state,
        rejection_reason_codes, release_eligible)
       VALUES ($1,$2,'PILOT_PACKAGE','career-readiness-fundamentals-v1',$3,$4,$5::jsonb,'PlanThePath-Owned',false,
         'APPROVED','APPROVED','APPROVED','MAPPED','UNIQUE','RELEASED','{}'::text[],true)`,
      [PILOT_SOURCE_RECORD_ID, sourcePackageId, PILOT_SOURCE_PATH, fixtureHash, JSON.stringify({ locale: fixture.locale })],
    );
    await client.query(
      `INSERT INTO rights_reviews (id, source_record_id, reviewer_user_id, state, license_label, reason_code)
       VALUES ($1,$2,$3,'APPROVED','PlanThePath-Owned','OWNERSHIP_VERIFIED')`,
      [randomUUID(), PILOT_SOURCE_RECORD_ID, actors.reviewerUserId],
    );
    for (const reviewKind of ['SME', 'QUALITY', 'ACCESSIBILITY', 'DUPLICATE']) {
      await client.query(
        `INSERT INTO quality_reviews (id, source_record_id, reviewer_user_id, review_kind, state, reason_code)
         VALUES ($1,$2,$3,$4,'APPROVED',$5)`,
        [randomUUID(), PILOT_SOURCE_RECORD_ID, actors.reviewerUserId, reviewKind, `${reviewKind}_APPROVED`],
      );
    }
    await client.query(
      `INSERT INTO release_manifests (id, name, version, manifest_hash, status)
       VALUES ($1,'Career Readiness Fundamentals',1,$2,'DRAFT')`, [PILOT_RELEASE_ID, fixtureHash],
    );

    const revisions = [
      ...fixture.topics.map((item) => ({ entityType: 'TOPIC', entityId: item.id, body: item })),
      { entityType: 'MODULE', entityId: fixture.module.id, body: fixture.module },
      ...fixture.lessons.map((item) => ({ entityType: 'LESSON', entityId: item.id, body: item })),
      ...fixture.assessment.questions.map((item) => ({ entityType: 'QUESTION', entityId: item.id, body: item })),
      { entityType: 'ASSESSMENT_BLUEPRINT', entityId: fixture.assessment.blueprintId, body: {
        stableKey: fixture.assessment.stableKey, selectionCount: fixture.assessment.selectionCount, timeLimitSeconds: fixture.assessment.timeLimitSeconds,
      } },
    ] as const;
    const revisionByEntityId = new Map<string, string>();
    for (const revision of revisions) {
      const revisionId = randomUUID();
      const contentHash = sha256Hex(stableStringify(revision.body));
      revisionByEntityId.set(revision.entityId, revisionId);
      await client.query(
        `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
         VALUES ($1,$2,$3,1,$4,'DRAFT',$5,$6::jsonb)`,
        [revisionId, revision.entityType, revision.entityId, actors.authorUserId, contentHash, JSON.stringify(revision.body)],
      );
      await client.query(
        `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
         VALUES ($1,$2,$3,'SUBMIT','DRAFT','IN_REVIEW','READY_FOR_REVIEW',$4)`,
        [randomUUID(), revisionId, actors.authorUserId, `pilot-submit-${revisionId}`],
      );
      await client.query("UPDATE content_revisions SET state = 'IN_REVIEW' WHERE id = $1", [revisionId]);
      await client.query(
        `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
         VALUES ($1,$2,$3,'APPROVE','IN_REVIEW','APPROVED','PILOT_REVIEW_APPROVED',$4)`,
        [randomUUID(), revisionId, actors.reviewerUserId, `pilot-approve-${revisionId}`],
      );
      await client.query("UPDATE content_revisions SET state = 'APPROVED' WHERE id = $1", [revisionId]);
      await client.query(
        `INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash)
         VALUES ($1,$2,$3,$4)`, [PILOT_RELEASE_ID, revisionId, PILOT_SOURCE_RECORD_ID, contentHash],
      );
      await client.query(
        `INSERT INTO content_provenance
         (id, source_record_id, canonical_entity_type, canonical_entity_id, canonical_version, provenance_hash, transform_version)
         VALUES ($1,$2,$3,$4,1,$5,$6)`,
        [randomUUID(), PILOT_SOURCE_RECORD_ID, revision.entityType, revision.entityId, contentHash, PILOT_TRANSFORM_VERSION],
      );
    }
    await client.query(
      `UPDATE release_manifests SET status='APPROVED', approved_by_user_id=$2, approved_at=now() WHERE id=$1`,
      [PILOT_RELEASE_ID, actors.reviewerUserId],
    );
    await client.query(
      `UPDATE release_manifests SET status='PUBLISHED', published_by_user_id=$2, published_at=now() WHERE id=$1`,
      [PILOT_RELEASE_ID, actors.publisherUserId],
    );
    for (const revisionId of revisionByEntityId.values()) {
      await client.query(
        `UPDATE content_revisions SET state='PUBLISHED', release_manifest_id=$2, published_at=now() WHERE id=$1`,
        [revisionId, PILOT_RELEASE_ID],
      );
      await client.query(
        `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
         VALUES ($1,$2,$3,'PUBLISH','APPROVED','PUBLISHED','PILOT_RELEASE_PUBLISHED',$4)`,
        [randomUUID(), revisionId, actors.publisherUserId, `pilot-publish-${revisionId}`],
      );
    }

    for (const topic of fixture.topics) {
      await client.query(
        `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
         VALUES ($1,'TOPIC',$2,1,$3,$4,$5)`,
        [topic.id, topic.stableKey, topic.name, topic.description, revisionByEntityId.get(topic.id)],
      );
    }
    await client.query(
      `INSERT INTO learning_modules (id, stable_key, version, title, description, content_revision_id, release_manifest_id, published_at)
       VALUES ($1,$2,1,$3,$4,$5,$6,now())`,
      [fixture.module.id, fixture.module.stableKey, fixture.module.title, fixture.module.description,
        revisionByEntityId.get(fixture.module.id), PILOT_RELEASE_ID],
    );
    for (const lesson of fixture.lessons) {
      await client.query(
        `INSERT INTO lesson_versions (id, module_id, stable_key, version, title, body, topic_id, content_revision_id, published_at)
         VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$7,now())`,
        [lesson.id, fixture.module.id, lesson.stableKey, lesson.title, JSON.stringify(lesson.body), lesson.topicId, revisionByEntityId.get(lesson.id)],
      );
      for (const prerequisiteId of lesson.prerequisiteLessonIds) {
        await client.query(
          'INSERT INTO lesson_prerequisites (lesson_version_id, prerequisite_lesson_version_id) VALUES ($1,$2)',
          [lesson.id, prerequisiteId],
        );
      }
    }
    await client.query(
      `INSERT INTO assessment_definitions
       (id, stable_key, version, title, content_revision_id, release_manifest_id, attempt_limit, time_limit_seconds, published_at)
       VALUES ($1,$2,1,$3,$4,$5,1,$6,now())`,
      [fixture.assessment.id, fixture.assessment.stableKey, fixture.assessment.title,
        revisionByEntityId.get(fixture.assessment.blueprintId), PILOT_RELEASE_ID, fixture.assessment.timeLimitSeconds],
    );
    await client.query(
      `INSERT INTO assessment_blueprints (id, assessment_definition_id, version, selection_count, algorithm_version, constraints)
       VALUES ($1,$2,1,$3,'sha256-ranked-v1',$4::jsonb)`,
      [fixture.assessment.blueprintId, fixture.assessment.id, fixture.assessment.selectionCount,
        JSON.stringify({ topics: fixture.topics.map((topic) => topic.id), source: 'published-only' })],
    );
    await client.query(
      `INSERT INTO assessment_sections (id, blueprint_id, position, title, topic_id, question_count)
       VALUES ($1,$2,1,'Career Readiness Fundamentals',$3,$4)`,
      [randomUUID(), fixture.assessment.blueprintId, fixture.topics[0]?.id, fixture.assessment.selectionCount],
    );
    for (const question of fixture.assessment.questions) {
      await client.query(
        `INSERT INTO question_versions
         (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
         VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7,now())`,
        [question.id, question.stableKey, question.topicId, question.prompt, JSON.stringify(question.options),
          revisionByEntityId.get(question.id), PILOT_RELEASE_ID],
      );
      await client.query(
        `INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash)
         VALUES ($1,$2,$3,$4)`,
        [question.id, question.correctOptionId, question.explanation, sha256Hex(`${question.id}:${question.correctOptionId}`)],
      );
    }
    await client.query(
      `INSERT INTO readiness_model_versions (id, stable_key, version, policy, published_by_user_id, published_at, active)
       VALUES ($1,'career-readiness-fundamentals',1,$2::jsonb,$3,now(),true)`,
      [READINESS_MODEL_ID, JSON.stringify({ algorithm: 'career-readiness-mastery-v1', advisory: true, employerVisible: false }), actors.publisherUserId],
    );
    await client.query(
      `INSERT INTO roadmap_policy_versions (id, stable_key, version, policy, published_by_user_id, published_at, active)
       VALUES ($1,'career-readiness-roadmap',1,$2::jsonb,$3,now(),true)`,
      [ROADMAP_POLICY_ID, JSON.stringify({ algorithm: 'career-readiness-roadmap-v1', advisory: true }), actors.publisherUserId],
    );
    await client.query(
      `INSERT INTO notification_templates
       (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
       VALUES ($1,'assessment-due',1,$2,'Your Career Readiness assessment is due',
         'Open ONE to complete your assigned Career Readiness assessment before it expires. No score or personal data is included in this email.', $3, now())`,
      [NOTIFICATION_TEMPLATE_ID, fixture.locale, actors.reviewerUserId],
    );
    return { releaseManifestId: PILOT_RELEASE_ID, idempotentReplay: false };
  });
}

export async function getPublishedCareerReadinessCatalog(pool: Pool): Promise<Record<string, unknown>> {
  const topics = await pool.query(
    `SELECT DISTINCT t.id, t.stable_key AS "stableKey", t.name, t.description
     FROM taxonomy_nodes t
     JOIN content_revisions cr ON cr.id=t.content_revision_id AND cr.state='PUBLISHED'
     JOIN release_manifests rm ON rm.id=cr.release_manifest_id AND rm.status='PUBLISHED'
     WHERE t.kind='TOPIC' AND t.active
     ORDER BY t.stable_key`,
  );
  const modules = await pool.query(
    `SELECT m.id, m.stable_key AS "stableKey", m.version, m.title, m.description,
       COALESCE(jsonb_agg(jsonb_build_object(
         'id', l.id, 'stableKey', l.stable_key, 'version', l.version, 'title', l.title, 'body', l.body,
         'topicId', l.topic_id, 'prerequisiteLessonIds', COALESCE((SELECT jsonb_agg(p.prerequisite_lesson_version_id)
           FROM lesson_prerequisites p WHERE p.lesson_version_id=l.id), '[]'::jsonb)
       ) ORDER BY l.stable_key) FILTER (WHERE l.id IS NOT NULL), '[]'::jsonb) AS lessons
     FROM learning_modules m
     JOIN release_manifests rm ON rm.id=m.release_manifest_id AND rm.status='PUBLISHED'
     LEFT JOIN lesson_versions l ON l.module_id=m.id
     GROUP BY m.id ORDER BY m.stable_key`,
  );
  const assessments = await pool.query(
    `SELECT a.id, a.stable_key AS "stableKey", a.title, b.id AS "blueprintId", b.selection_count AS "selectionCount",
       a.time_limit_seconds AS "timeLimitSeconds"
     FROM assessment_definitions a JOIN release_manifests rm ON rm.id=a.release_manifest_id AND rm.status='PUBLISHED'
     JOIN assessment_blueprints b ON b.assessment_definition_id=a.id ORDER BY a.stable_key`,
  );
  return { pilot: 'Career Readiness Fundamentals', releaseManifestId: PILOT_RELEASE_ID,
    topics: topics.rows, modules: modules.rows, assessments: assessments.rows };
}

export async function completeLesson(pool: Pool, input: {
  readonly subjectUserId: string; readonly lessonVersionId: string; readonly correlationId: string;
}): Promise<{ readonly progressId: string; readonly evidenceId: string; readonly idempotentReplay: boolean }> {
  return transaction(pool, async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM learner_progress WHERE subject_user_id=$1 AND lesson_version_id=$2 AND state='COMPLETED'`,
      [input.subjectUserId, input.lessonVersionId],
    );
    if (existing.rows[0]) {
      const evidence = await client.query<{ id: string }>(
        `SELECT id FROM evidence_records WHERE subject_user_id=$1 AND evidence_type='LESSON_COMPLETION' AND source_aggregate_id=$2 LIMIT 1`,
        [input.subjectUserId, existing.rows[0].id],
      );
      return { progressId: existing.rows[0].id, evidenceId: evidence.rows[0]?.id ?? '', idempotentReplay: true };
    }
    const lesson = await client.query<{ topic_id: string; version: number }>(
      `SELECT l.topic_id, l.version FROM lesson_versions l JOIN learning_modules m ON m.id=l.module_id
       JOIN release_manifests rm ON rm.id=m.release_manifest_id AND rm.status='PUBLISHED' WHERE l.id=$1`,
      [input.lessonVersionId],
    );
    if (!lesson.rows[0]) throw new Error('published lesson was not found');
    const unmet = await client.query<{ title: string }>(
      `SELECT lv.title FROM lesson_prerequisites p
       JOIN lesson_versions lv ON lv.id = p.prerequisite_lesson_version_id
       WHERE p.lesson_version_id=$2 AND p.required AND NOT EXISTS (
         SELECT 1 FROM learner_progress lp WHERE lp.subject_user_id=$1
           AND lp.lesson_version_id=p.prerequisite_lesson_version_id AND lp.state='COMPLETED')
       ORDER BY lv.title`,
      [input.subjectUserId, input.lessonVersionId],
    );
    if (unmet.rows.length > 0) {
      // Named so the learner is told WHICH lessons unlock this one (UAT #17),
      // instead of a generic refusal.
      const titles = unmet.rows.map((row) => `"${row.title}"`).join(', ');
      throw new Error(`lesson prerequisites are not complete: finish ${titles} first`);
    }
    const progressId = randomUUID();
    const evidenceId = randomUUID();
    await client.query(
      `INSERT INTO learner_progress
       (id, subject_user_id, lesson_version_id, state, started_at, completed_at, last_correlation_id)
       VALUES ($1,$2,$3,'COMPLETED',now(),now(),$4)`,
      [progressId, input.subjectUserId, input.lessonVersionId, input.correlationId],
    );
    await client.query(
      `INSERT INTO evidence_records
       (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id,
        content_version, provenance, occurred_at)
       VALUES ($1,$2,'LESSON_COMPLETION',$3,1,1,'learner_progress',$4,$5,$6::jsonb,now())`,
      [evidenceId, input.subjectUserId, lesson.rows[0].topic_id, progressId, `lesson-v${lesson.rows[0].version}`,
        JSON.stringify({ lessonVersionId: input.lessonVersionId, releaseManifestId: PILOT_RELEASE_ID })],
    );
    await insertOutbox(client, { aggregateType: 'learner_progress', aggregateId: progressId, eventType: 'learning.lesson.completed',
      actorUserId: input.subjectUserId, correlationId: input.correlationId,
      payload: { progressId, lessonVersionId: input.lessonVersionId, evidenceId } });
    return { progressId, evidenceId, idempotentReplay: false };
  });
}

export async function startAssessmentAttempt(pool: Pool, input: {
  readonly subjectUserId: string; readonly assessmentDefinitionId: string; readonly correlationId: string; readonly selectionSeed: string;
}): Promise<Record<string, unknown>> {
  return transaction(pool, async (client) => {
    const assessment = await client.query<{
      blueprint_id: string; selection_count: number; time_limit_seconds: number;
    }>(
      `SELECT b.id AS blueprint_id, b.selection_count, a.time_limit_seconds
       FROM assessment_definitions a JOIN release_manifests rm ON rm.id=a.release_manifest_id AND rm.status='PUBLISHED'
       JOIN assessment_blueprints b ON b.assessment_definition_id=a.id WHERE a.id=$1`, [input.assessmentDefinitionId],
    );
    if (!assessment.rows[0]) throw new Error('published assessment was not found');
    const prior = await client.query(
      `SELECT id FROM assessment_attempts WHERE subject_user_id=$1 AND state IN ('IN_PROGRESS','SUBMITTED')
       AND blueprint_id=$2 LIMIT 1`, [input.subjectUserId, assessment.rows[0].blueprint_id],
    );
    if (prior.rows[0]) throw new Error('assessment attempt limit reached');
    const questionRows = await client.query<{
      id: string; topic_id: string; prompt: string; options: ProtectedQuestionVersion['options']; version: number; correct_option_id: string;
    }>(
      `SELECT q.id, q.topic_id, q.prompt, q.options, q.version, k.correct_option_id
       FROM question_versions q JOIN question_answer_keys k ON k.question_version_id=q.id
       JOIN release_manifests rm ON rm.id=q.release_manifest_id AND rm.status='PUBLISHED' ORDER BY q.id`,
    );
    const protectedQuestions = questionRows.rows.map((question) => ({
      id: question.id, topicId: question.topic_id, prompt: question.prompt, options: question.options,
      correctOptionId: question.correct_option_id, publishedRevision: question.version,
    }));
    const selected = selectQuestionsDeterministically(protectedQuestions, assessment.rows[0].selection_count, input.selectionSeed);
    const assignmentId = randomUUID();
    const attemptId = randomUUID();
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + assessment.rows[0].time_limit_seconds * 1_000);
    await client.query(
      `INSERT INTO assessment_assignments
       (id, assessment_definition_id, subject_user_id, assigned_by_user_id, available_at, due_at, state)
       VALUES ($1,$2,$3,$3,$4,$5,'AVAILABLE')`,
      [assignmentId, input.assessmentDefinitionId, input.subjectUserId, startedAt, expiresAt],
    );
    await client.query(
      `INSERT INTO assessment_attempts
       (id, assignment_id, subject_user_id, blueprint_id, selection_seed, state, started_at, expires_at, correlation_id)
       VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',$6,$7,$8)`,
      [attemptId, assignmentId, input.subjectUserId, assessment.rows[0].blueprint_id, input.selectionSeed, startedAt, expiresAt, input.correlationId],
    );
    for (const [position, question] of selected.entries()) {
      await client.query(
        `INSERT INTO assessment_attempt_items (id, attempt_id, question_version_id, position) VALUES ($1,$2,$3,$4)`,
        [randomUUID(), attemptId, question.id, position + 1],
      );
    }
    await insertOutbox(client, { aggregateType: 'assessment_attempt', aggregateId: attemptId,
      eventType: 'assessment.attempt.started', actorUserId: input.subjectUserId, correlationId: input.correlationId,
      payload: { attemptId, assignmentId, blueprintId: assessment.rows[0].blueprint_id } });
    const notificationCommandId = await maybeCreateAssessmentDueNotification(client, input.subjectUserId, assignmentId, input.correlationId);
    return { attemptId, assignmentId, startedAt: startedAt.toISOString(), expiresAt: expiresAt.toISOString(),
      notificationCommandId, questions: selected.map(({ correctOptionId: _answer, ...question }) => question) };
  });
}

export async function submitAssessmentAttempt(pool: Pool, input: {
  readonly subjectUserId: string; readonly attemptId: string; readonly idempotencyKey: string;
  readonly selectedOptions: Readonly<Record<string, string>>; readonly correlationId: string;
}): Promise<Record<string, unknown>> {
  return transaction(pool, async (client) => {
    const attemptResult = await client.query<{
      state: 'IN_PROGRESS' | 'SUBMITTED'; submission_idempotency_key: string | null; expires_at: Date; score_correct: number | null; score_possible: number | null;
    }>('SELECT state, submission_idempotency_key, expires_at, score_correct, score_possible FROM assessment_attempts WHERE id=$1 AND subject_user_id=$2 FOR UPDATE',
    [input.attemptId, input.subjectUserId]);
    const attempt = attemptResult.rows[0];
    if (!attempt) throw new Error('assessment attempt was not found');
    if (attempt.state === 'SUBMITTED') {
      if (attempt.submission_idempotency_key !== input.idempotencyKey) throw new Error('assessment attempt was already submitted');
      return { attemptId: input.attemptId, scoreCorrect: attempt.score_correct, scorePossible: attempt.score_possible, idempotentReplay: true };
    }
    if (new Date(attempt.expires_at).getTime() <= Date.now()) throw new Error('assessment attempt has expired');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) throw new Error('invalid submission idempotency key');
    const items = await client.query<{
      item_id: string; question_id: string; topic_id: string; options: ProtectedQuestionVersion['options']; correct_option_id: string; version: number;
    }>(
      `SELECT i.id AS item_id, q.id AS question_id, q.topic_id, q.options, k.correct_option_id, q.version
       FROM assessment_attempt_items i JOIN question_versions q ON q.id=i.question_version_id
       JOIN question_answer_keys k ON k.question_version_id=q.id WHERE i.attempt_id=$1 ORDER BY i.position`, [input.attemptId],
    );
    if (Object.keys(input.selectedOptions).some((questionId) => !items.rows.some((item) => item.question_id === questionId))) {
      throw new Error('response references an unknown question');
    }
    let scoreCorrect = 0;
    const topicScores = new Map<string, { demonstrated: number; possible: number }>();
    for (const item of items.rows) {
      const selected = input.selectedOptions[item.question_id];
      if (!selected || !item.options.some((option) => option.id === selected)) throw new Error('every item requires a valid selected option');
      const isCorrect = selected === item.correct_option_id;
      if (isCorrect) scoreCorrect += 1;
      const topic = topicScores.get(item.topic_id) ?? { demonstrated: 0, possible: 0 };
      topicScores.set(item.topic_id, { demonstrated: topic.demonstrated + (isCorrect ? 1 : 0), possible: topic.possible + 1 });
      await client.query(
        `INSERT INTO assessment_responses (id, attempt_item_id, selected_option_id, responded_at, is_correct)
         VALUES ($1,$2,$3,now(),$4)`, [randomUUID(), item.item_id, selected, isCorrect],
      );
    }
    const evidenceIds: string[] = [];
    for (const [topicId, score] of topicScores) {
      const evidenceId = randomUUID();
      evidenceIds.push(evidenceId);
      await client.query(
        `INSERT INTO evidence_records
         (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id,
          content_version, provenance, occurred_at)
         VALUES ($1,$2,'ASSESSMENT_OUTCOME',$3,$4,$5,'assessment_attempt',$6,'assessment-v1',$7::jsonb,now())`,
        [evidenceId, input.subjectUserId, topicId, score.demonstrated, score.possible, input.attemptId,
          JSON.stringify({ attemptId: input.attemptId, itemCount: score.possible, releaseManifestId: PILOT_RELEASE_ID })],
      );
    }
    await client.query(
      `UPDATE assessment_attempts SET state='SUBMITTED', submitted_at=now(), submission_idempotency_key=$2,
       score_correct=$3, score_possible=$4 WHERE id=$1`,
      [input.attemptId, input.idempotencyKey, scoreCorrect, items.rows.length],
    );
    await client.query("UPDATE assessment_assignments SET state='COMPLETED' WHERE id=(SELECT assignment_id FROM assessment_attempts WHERE id=$1)", [input.attemptId]);

    const allEvidence = await loadEvidence(client, input.subjectUserId);
    const projections = projectTopicMastery(allEvidence);
    const projectionIds = new Map<string, string>();
    for (const projection of projections) {
      const prior = await client.query<{ id: string }>(
        'SELECT id FROM mastery_projections WHERE subject_user_id=$1 AND topic_id=$2 ORDER BY generated_at DESC LIMIT 1',
        [input.subjectUserId, projection.topicId],
      );
      const projectionId = randomUUID();
      projectionIds.set(projection.topicId, projectionId);
      await client.query(
        `INSERT INTO mastery_projections
         (id, subject_user_id, topic_id, algorithm_version, evidence_ids, evidence_set_hash, band, supersedes_projection_id)
         VALUES ($1,$2,$3,$4,$5::uuid[],$6,$7,$8)`,
        [projectionId, input.subjectUserId, projection.topicId, projection.algorithmVersion, [...projection.evidenceIds],
          sha256Hex([...projection.evidenceIds].sort().join(':')), projection.band, prior.rows[0]?.id ?? null],
      );
    }
    const readiness = calculateAdvisoryReadiness(projections);
    const priorSnapshot = await client.query<{ id: string }>(
      'SELECT id FROM readiness_snapshots WHERE subject_user_id=$1 ORDER BY generated_at DESC LIMIT 1', [input.subjectUserId],
    );
    const snapshotId = randomUUID();
    await client.query(
      `INSERT INTO readiness_snapshots
       (id, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, advisory, employer_visible, explanation, supersedes_snapshot_id)
       VALUES ($1,$2,$3,$4::uuid[],$5,$6,true,false,$7::jsonb,$8)`,
      [snapshotId, input.subjectUserId, READINESS_MODEL_ID, [...readiness.evidenceIds],
        sha256Hex([...readiness.evidenceIds].sort().join(':')), readiness.band, JSON.stringify({ factors: readiness.factors }), priorSnapshot.rows[0]?.id ?? null],
    );
    for (const factor of readiness.factors) {
      const projectionId = projectionIds.get(factor.topicId);
      if (!projectionId) continue;
      await client.query(
        `INSERT INTO readiness_factors (id, snapshot_id, topic_id, mastery_projection_id, reason_code, explanation)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), snapshotId, factor.topicId, projectionId, `MASTERY_${factor.masteryBand}`, factor.explanation],
      );
    }
    const roadmapActions = recommendRoadmapActions(projections);
    const roadmapActionIds: string[] = [];
    for (const action of roadmapActions) {
      const actionId = randomUUID();
      roadmapActionIds.push(actionId);
      await client.query(
        `INSERT INTO roadmap_actions
         (id, subject_user_id, policy_version_id, topic_id, action_code, reason_code, evidence_ids, state, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],'RECOMMENDED',now()+interval '7 days')`,
        [actionId, input.subjectUserId, ROADMAP_POLICY_ID, action.topicId, action.actionCode, action.reasonCode, [...action.evidenceIds]],
      );
      await insertOutbox(client, { aggregateType: 'roadmap_action', aggregateId: actionId, eventType: 'roadmap.action.created',
        actorUserId: input.subjectUserId, correlationId: input.correlationId,
        payload: { roadmapActionId: actionId, policyVersionId: ROADMAP_POLICY_ID, actionCode: action.actionCode } });
    }
    const ratio = scoreCorrect / Math.max(1, items.rows.length);
    const outcomeBand = ratio >= 0.8 ? 'DEMONSTRATED' : ratio >= 0.6 ? 'PROGRESSING' : 'DEVELOPING';
    await insertOutbox(client, { aggregateType: 'assessment_attempt', aggregateId: input.attemptId,
      eventType: 'assessment.attempt.submitted', actorUserId: input.subjectUserId, correlationId: input.correlationId,
      payload: { attemptId: input.attemptId, evidenceId: evidenceIds[0], outcomeBand } });
    await insertOutbox(client, { aggregateType: 'readiness_snapshot', aggregateId: snapshotId,
      eventType: 'readiness.snapshot.created', actorUserId: input.subjectUserId, correlationId: input.correlationId,
      payload: { readinessSnapshotId: snapshotId, modelVersionId: READINESS_MODEL_ID, band: readiness.band } });
    return { attemptId: input.attemptId, scoreCorrect, scorePossible: items.rows.length, outcomeBand,
      readiness: { band: readiness.band, advisory: true, employerVisible: false, snapshotId },
      evidenceIds, roadmapActionIds, idempotentReplay: false };
  });
}

export async function getLearnerCareerReadinessState(pool: Pool, subjectUserId: string): Promise<Record<string, unknown>> {
  const [catalog, progress, attempts, evidence, projections, readiness, readinessHistory, roadmap, notificationPreferences, notifications] = await Promise.all([
    getPublishedCareerReadinessCatalog(pool),
    pool.query(`SELECT lesson_version_id AS "lessonVersionId", state, started_at AS "startedAt", completed_at AS "completedAt"
      FROM learner_progress WHERE subject_user_id=$1 ORDER BY updated_at`, [subjectUserId]),
    pool.query(`SELECT id, state, started_at AS "startedAt", expires_at AS "expiresAt", submitted_at AS "submittedAt",
      score_correct AS "scoreCorrect", score_possible AS "scorePossible" FROM assessment_attempts WHERE subject_user_id=$1 ORDER BY started_at DESC`, [subjectUserId]),
    pool.query(`SELECT id, evidence_type AS "evidenceType", topic_id AS "topicId", demonstrated, possible,
      content_version AS "contentVersion", occurred_at AS "occurredAt" FROM evidence_records WHERE subject_user_id=$1 ORDER BY occurred_at`, [subjectUserId]),
    pool.query(`SELECT DISTINCT ON (topic_id) id, topic_id AS "topicId", band, evidence_ids AS "evidenceIds", algorithm_version AS "algorithmVersion", generated_at AS "generatedAt"
      FROM mastery_projections WHERE subject_user_id=$1 ORDER BY topic_id, generated_at DESC`, [subjectUserId]),
    pool.query(`SELECT id, band, advisory, employer_visible AS "employerVisible", explanation, generated_at AS "generatedAt"
      FROM readiness_snapshots WHERE subject_user_id=$1 ORDER BY generated_at DESC LIMIT 1`, [subjectUserId]),
    // The band over time, newest first, so history[0] is always the same snapshot as
    // `readiness`. Bands and their model version only: a snapshot's band is comparable
    // with an earlier one only if the model version matches, and ADR-020 forbids any
    // numeric readiness value, so there is nothing here to plot as a score.
    // Tie-broken on id so the order is deterministic when two snapshots share a
    // timestamp, and bounded so a long-lived learner cannot make this unbounded.
    pool.query(`SELECT id, band, model_version_id AS "modelVersionId", generated_at AS "generatedAt"
      FROM readiness_snapshots WHERE subject_user_id=$1 ORDER BY generated_at DESC, id DESC LIMIT 100`, [subjectUserId]),
    pool.query(`SELECT id, topic_id AS "topicId", action_code AS "actionCode", reason_code AS "reasonCode", state, due_at AS "dueAt"
      FROM roadmap_actions WHERE subject_user_id=$1 AND state NOT IN ('SUPERSEDED','DISMISSED') ORDER BY created_at DESC`, [subjectUserId]),
    pool.query(`SELECT email_enabled AS "emailEnabled", quiet_hours_start_minute AS "quietHoursStartMinute",
      quiet_hours_end_minute AS "quietHoursEndMinute", daily_cap AS "dailyCap" FROM notification_preferences WHERE user_id=$1`, [subjectUserId]),
    pool.query(`SELECT n.id,t.stable_key AS "templateKey",n.channel,n.legal_purpose AS "legalPurpose",n.state,
      n.created_at AS "createdAt",n.expires_at AS "expiresAt" FROM notification_commands n
      JOIN notification_templates t ON t.id=n.template_id WHERE n.subject_user_id=$1 ORDER BY n.created_at DESC LIMIT 25`, [subjectUserId]),
  ]);
  return { catalog, progress: progress.rows, attempts: attempts.rows, evidence: evidence.rows,
    mastery: projections.rows, readiness: readiness.rows[0] ?? null, readinessHistory: readinessHistory.rows, roadmap: roadmap.rows,
    notificationPreferences: notificationPreferences.rows[0] ?? null, notifications: notifications.rows };
}

export async function listImportOperations(pool: Pool): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT m.id, m.package_identity AS "packageIdentity", m.source_repository AS "sourceRepository", m.source_commit AS "sourceCommit",
      m.manifest_hash AS "manifestHash", m.transform_version AS "transformVersion", m.status, m.record_counts AS "recordCounts",
      m.started_at AS "startedAt", m.completed_at AS "completedAt",
      (SELECT count(*)::int FROM source_records sr JOIN source_packages sp ON sp.id=sr.package_id WHERE sp.migration_run_id=m.id AND NOT sr.release_eligible) AS "blockedRecords"
     FROM migration_runs m ORDER BY m.started_at DESC`,
  );
  return result.rows;
}

export async function listImportSourceRecords(pool: Pool, migrationRunId: string): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT sr.id,sr.source_entity_type AS "sourceEntityType",sr.source_record_id AS "sourceRecordId",sr.source_path AS "sourcePath",
      sr.source_hash AS "sourceHash",sr.license_label AS "licenseLabel",sr.attribution_required AS "attributionRequired",
      sr.rights_state AS "rightsState",sr.sme_state AS "smeState",sr.quality_state AS "qualityState",
      sr.mapping_state AS "mappingState",sr.duplicate_state AS "duplicateState",sr.release_state AS "releaseState",
      sr.rejection_reason_codes AS "rejectionReasonCodes",sr.release_eligible AS "releaseEligible",
      cm.canonical_entity_type AS "canonicalEntityType",cm.canonical_entity_id AS "canonicalEntityId",cm.disposition AS "canonicalDisposition"
     FROM source_records sr JOIN source_packages sp ON sp.id=sr.package_id
     LEFT JOIN canonical_id_mappings cm ON cm.source_record_id=sr.id
     WHERE sp.migration_run_id=$1 ORDER BY sr.source_path,sr.source_record_id`, [migrationRunId],
  );
  return result.rows;
}

export async function getCareerReadinessOperationalStatus(pool: Pool): Promise<Record<string, unknown>> {
  const [releases, sourceGovernance, reviews, outboxFailures, workflows, commands] = await Promise.all([
    pool.query(`SELECT id,name,version,manifest_hash AS "manifestHash",status,published_at AS "publishedAt"
      FROM release_manifests ORDER BY created_at DESC LIMIT 25`),
    pool.query(`SELECT rights_state AS "rightsState",sme_state AS "smeState",quality_state AS "qualityState",
      release_state AS "releaseState",release_eligible AS "releaseEligible",count(*)::int AS count
      FROM source_records GROUP BY rights_state,sme_state,quality_state,release_state,release_eligible ORDER BY rights_state,release_state`),
    pool.query(`SELECT cr.id,cr.entity_type AS "entityType",cr.entity_id AS "entityId",cr.revision,cr.state,
      cr.created_at AS "createdAt" FROM content_revisions cr WHERE cr.state IN ('IN_REVIEW','CHANGES_REQUESTED','APPROVED')
      ORDER BY cr.created_at LIMIT 50`),
    pool.query(`SELECT id,event_type AS "eventType",aggregate_type AS "aggregateType",attempts,
      last_failure_class AS "failureClass",correlation_id AS "correlationId",occurred_at AS "occurredAt"
      FROM outbox_events WHERE delivery_state='FAILED' ORDER BY occurred_at DESC LIMIT 50`),
    pool.query(`SELECT id,allowlist_id AS "allowlistId",version,workflow_hash AS "workflowHash",operation,
      destination_class AS "destinationClass",active,kill_switch AS "killSwitch" FROM automation_workflow_registry
      ORDER BY allowlist_id,version DESC`),
    pool.query(`SELECT ac.id,w.allowlist_id AS "allowlistId",ac.state,ac.attempts,ac.last_failure_class AS "failureClass",
      ac.correlation_id AS "correlationId",ac.created_at AS "createdAt" FROM automation_commands ac
      JOIN automation_workflow_registry w ON w.id=ac.workflow_registry_id ORDER BY ac.created_at DESC LIMIT 50`),
  ]);
  return { releases: releases.rows, sourceGovernance: sourceGovernance.rows, reviewQueue: reviews.rows,
    outboxFailures: outboxFailures.rows, workflows: workflows.rows, automationCommands: commands.rows };
}

export async function generateInstitutionAggregateReport(pool: Pool, input: {
  readonly institutionId: string; readonly periodStart: string; readonly periodEnd: string; readonly minimumCohortSize?: number;
}): Promise<Record<string, unknown>> {
  const minimumCohortSize = input.minimumCohortSize ?? 5;
  if (!Number.isInteger(minimumCohortSize) || minimumCohortSize < 5) throw new Error('minimum cohort size must be at least 5');
  return transaction(pool, async (client) => {
    const result = await client.query<{ cohort_size: number; band: string; count: number }>(
      `WITH latest AS (
         SELECT DISTINCT ON (rs.subject_user_id) rs.subject_user_id, rs.band
         FROM readiness_snapshots rs
         JOIN institution_relationships ir ON ir.student_user_id=rs.subject_user_id
           AND ir.institution_id=$1
           AND (
             ir.state IN ('VERIFIED','ACTIVE')
             OR (ir.state IN ('TRANSFERRED','GRADUATED') AND ir.effective_to IS NOT NULL)
           )
           AND ir.effective_from <= rs.generated_at
           AND (ir.effective_to IS NULL OR ir.effective_to > rs.generated_at)
         WHERE rs.generated_at >= $2::date AND rs.generated_at < ($3::date + interval '1 day')
         ORDER BY rs.subject_user_id, rs.generated_at DESC
       )
       SELECT count(*) OVER ()::int AS cohort_size, band, count(*)::int AS count FROM latest GROUP BY band`,
      [input.institutionId, input.periodStart, input.periodEnd],
    );
    const cohortSize = result.rows.reduce((sum, row) => sum + row.count, 0);
    const aggregate = cohortSize < minimumCohortSize
      ? { suppressed: true, minimumCohortSize, cohortSize: 0, bands: [] }
      : { suppressed: false, minimumCohortSize, cohortSize, bands: result.rows.map(({ band, count }) => ({ band, count })) };
    const reportId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
    await client.query(
      `INSERT INTO institution_aggregate_reports
       (id, institution_id, release_manifest_id, report_period_start, report_period_end, aggregate, artifact_ref, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [reportId, input.institutionId, PILOT_RELEASE_ID, input.periodStart, input.periodEnd, JSON.stringify(aggregate), `report:${reportId}`, expiresAt],
    );
    return { reportId, periodStart: input.periodStart, periodEnd: input.periodEnd, aggregate, artifactRef: `report:${reportId}`, expiresAt: expiresAt.toISOString() };
  });
}

async function requireExistingUsers(client: DbClient, userIds: readonly string[]): Promise<void> {
  const unique = [...new Set(userIds)];
  const result = await client.query('SELECT id FROM users WHERE id = ANY($1::uuid[])', [unique]);
  if (result.rows.length !== unique.length) throw new Error('pilot publication actors must be existing users');
}

async function loadEvidence(client: DbClient, subjectUserId: string): Promise<EvidenceInput[]> {
  const result = await client.query<{
    id: string; subject_user_id: string; evidence_type: EvidenceInput['evidenceType']; topic_id: string; demonstrated: number;
    possible: number; source_aggregate_type: string; source_aggregate_id: string; content_version: string; occurred_at: Date;
    supersedes_evidence_id: string | null;
  }>(
    `SELECT id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id,
      content_version, occurred_at, supersedes_evidence_id FROM evidence_records WHERE subject_user_id=$1 ORDER BY occurred_at,id`, [subjectUserId],
  );
  return result.rows.map((row) => ({ id: row.id, subjectUserId: row.subject_user_id, evidenceType: row.evidence_type,
    topicId: row.topic_id, demonstrated: row.demonstrated, possible: row.possible, sourceAggregateType: row.source_aggregate_type,
    sourceAggregateId: row.source_aggregate_id, contentVersion: row.content_version, occurredAt: new Date(row.occurred_at).toISOString(),
    ...(row.supersedes_evidence_id ? { supersedesEvidenceId: row.supersedes_evidence_id } : {}) }));
}

async function maybeCreateAssessmentDueNotification(client: DbClient, subjectUserId: string, assignmentId: string, correlationId: string): Promise<string | null> {
  const preferenceResult = await client.query<{
    email_enabled: boolean; quiet_hours_start_minute: number; quiet_hours_end_minute: number; daily_cap: number;
  }>(
    `INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at=notification_preferences.updated_at
     RETURNING email_enabled, quiet_hours_start_minute, quiet_hours_end_minute, daily_cap`, [subjectUserId],
  );
  const preference = preferenceResult.rows[0];
  if (!preference) return null;
  const sent = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM notification_commands WHERE subject_user_id=$1 AND created_at >= current_date`, [subjectUserId],
  );
  const now = new Date();
  const localMinuteOfDay = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  const allowed = mayCreateNotificationCommand({ preference: {
    emailEnabled: preference.email_enabled, quietHoursStartMinute: preference.quiet_hours_start_minute,
    quietHoursEndMinute: preference.quiet_hours_end_minute, dailyCap: preference.daily_cap,
  }, localMinuteOfDay, sentToday: sent.rows[0]?.count ?? 0, legalPurpose: 'transactional assessment due reminder' });
  if (!allowed.allowed) return null;
  const commandId = randomUUID();
  await client.query(
    `INSERT INTO notification_commands
     (id, subject_user_id, template_id, channel, legal_purpose, destination_ref, render_parameters, dedupe_key, state, expires_at, correlation_id)
     VALUES ($1,$2,$3,'EMAIL','transactional assessment due reminder',$4,$5::jsonb,$6,'PENDING',now()+interval '24 hours',$7)`,
    [commandId, subjectUserId, NOTIFICATION_TEMPLATE_ID, `user:${subjectUserId}`, JSON.stringify({ assignmentId }),
      `assessment-due:${assignmentId}`, correlationId],
  );
  await insertOutbox(client, { aggregateType: 'notification_command', aggregateId: commandId,
    eventType: 'notification.delivery.requested', actorUserId: subjectUserId, correlationId,
    payload: { commandId, templateId: NOTIFICATION_TEMPLATE_ID, channel: 'EMAIL' } });
  return commandId;
}

async function insertOutbox(client: DbClient, input: {
  readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string;
  readonly actorUserId?: string; readonly correlationId: string; readonly payload: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  createIntegrationEventEnvelope({ eventId: id, eventType: input.eventType, eventVersion: 1,
    occurredAt: new Date().toISOString(), aggregateId: input.aggregateId,
    ...(input.actorUserId ? { actorId: input.actorUserId } : {}), correlationId: input.correlationId, payload: input.payload });
  await client.query(
    `INSERT INTO outbox_events
     (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
     VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$7)`,
    [id, input.aggregateType, input.aggregateId, input.eventType, JSON.stringify(input.payload), input.actorUserId ?? null, input.correlationId],
  );
  return id;
}
