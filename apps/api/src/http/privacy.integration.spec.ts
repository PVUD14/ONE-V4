import 'reflect-metadata';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTrustedJwtVerifier, type TrustedJwk } from '@planthepath/identity/src/jwt.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';
import { createLocalDiskStorage } from '../storage/file-storage.js';
import { executeDueDeletions } from './privacy-deletion.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for privacy integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-privacy-test-client';
const keyId = 'privacy-test-key';
const schemaName = `privacy_${process.pid}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});

let adminPool: Pool; let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;
let storageRoot: string;
let storage: ReturnType<typeof createLocalDiskStorage>;
let subjectId: string; let subjectToken: string;
let opsId: string;
let employerId: string;
// EMP-12 screening attempts: the subject's (one submitted, one still in progress) and another candidate's.
let subjectSubmittedAttemptId: string; let subjectOpenAttemptId: string; let subjectOpenInvitationId: string;
let otherCandidateId: string; let otherAttemptId: string;
// The records every later goal added (docs/architecture/privacy-export-coverage.md), seeded for the
// subject and for the other candidate so the export and deletion can be shown to reach only the subject's.
let fixtures: Fixtures;
let subjectRecords: PersonalRecords; let otherRecords: PersonalRecords;

const ids = { uuid: () => randomUUID() };

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
  db = drizzle(pool, { schema });
  await applyMigrations(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'one-privacy-'));
  storage = createLocalDiskStorage(storageRoot);

  const identityStore = {
    findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
    loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({ verifier, identityStore, db, fileStorage: storage, fileScanner: { engine: 'test', async scan() { return { state: 'CLEAN' as const }; } } })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  const sub = `sub:${randomUUID()}`;
  subjectId = randomUUID();
  await db.insert(schema.users).values({ id: subjectId, externalSubject: sub, email: 'subject@uat.test', state: 'ACTIVE' });
  subjectToken = signAccessToken(privateKey, { sub, email: 'subject@uat.test' });

  opsId = randomUUID();
  await db.insert(schema.users).values({ id: opsId, externalSubject: `sub:${randomUUID()}`, email: 'ops@uat.test', state: 'ACTIVE' });

  employerId = randomUUID();
  await db.insert(schema.organizations).values({ id: employerId, kind: 'EMPLOYER', legalName: 'Aster Mobility', verificationState: 'VERIFIED' });

  // Data the subject owns, and an application the employer lawfully holds.
  await pool.query(`INSERT INTO student_profiles (user_id, target_career) VALUES ($1, 'SOC Analyst')`, [subjectId]);
  const subjectDocumentId = randomUUID();
  await pool.query(`INSERT INTO student_document_metadata (id, student_user_id, title, document_type) VALUES ($1, $2, 'My CV', 'RESUME')`, [subjectDocumentId, subjectId]);
  const subjectApplicationId = await seedApplication(subjectId);
  otherCandidateId = randomUUID();
  await db.insert(schema.users).values({ id: otherCandidateId, externalSubject: `sub:${randomUUID()}`, email: 'candidate@uat.test', state: 'ACTIVE' });
  const otherApplicationId = await seedApplication(otherCandidateId);
  // Employer screening tests (EMP-12) on both applications, so export and deletion can be shown
  // to reach exactly the subject's attempts.
  ({ attemptId: subjectSubmittedAttemptId } = await seedScreening(subjectApplicationId, subjectId, 'SUBMITTED'));
  ({ attemptId: subjectOpenAttemptId, invitationId: subjectOpenInvitationId } = await seedScreening(subjectApplicationId, subjectId, 'IN_PROGRESS'));
  ({ attemptId: otherAttemptId } = await seedScreening(otherApplicationId, otherCandidateId, 'SUBMITTED'));
  // Engine behavioural data (ENG-03) for the subject and for someone else, so erasure can
  // be shown to remove exactly the subject's rows.
  await seedLearningActivity(subjectId);
  await seedLearningActivity(opsId);
  // A learner skill state row (ENG-05) for each, written as the projector writes it.
  const topicId = await seedTopic(opsId);
  await seedSkillState(subjectId, topicId);
  await seedSkillState(opsId, topicId);
  await seedDecision(subjectId);
  await seedDecision(opsId);
  fixtures = await seedFixtures(topicId);
  subjectRecords = await seedPersonalRecords(subjectId, subjectApplicationId, 'Subjectmark', subjectDocumentId);
  otherRecords = await seedPersonalRecords(otherCandidateId, otherApplicationId, 'Othermark', null);
});

async function seedTopic(authorId: string): Promise<string> {
  const topicId = randomUUID();
  const revisionId = randomUUID();
  await pool.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
     VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revisionId, topicId, authorId, 'e'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
     VALUES ($1,'TOPIC',$2,1,'Synthetic topic','Synthetic topic for the privacy test',$3)`, [topicId, `privacy-topic-${topicId}`, revisionId],
  );
  return topicId;
}

/** Only the projector may write learner_skill_state; the test takes its role for one row. */
async function seedSkillState(userId: string, topicId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('one.learner_skill_state_writer', 'learner-skill-state-projector', true)");
    await client.query(
      `INSERT INTO learner_skill_state (subject_user_id, skill_id, attempt_count, attempt_day_count, unaided_success_count,
         unaided_success_day_count, assisted_success_count, last_attempt_at, evidence_stage, evidence_band, algorithm_version)
       VALUES ($1,$2,1,1,1,1,0,now(),'RETAINED','NOT_ENOUGH_EVIDENCE','learner-skill-state-v1')`, [userId, topicId],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

/** One planner decision (ENG-08): nothing to plan, recorded with its inputs as the planner does. */
async function seedDecision(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO learning_decisions (id, subject_user_id, policy_version, adaptive, inputs, inputs_hash, action, reason_codes, correlation_id)
     VALUES ($1,$2,'learning-orchestrator-v1',false,'{"adaptive":false}'::jsonb,$3,'NONE','{NO_CAREER_TARGET,NON_ADAPTIVE_NO_CONSENT}','privacy-test')`,
    [randomUUID(), userId, 'f'.repeat(64)],
  );
}

/** One session, one attempt and one activity event, as the assessment paths write them. */
async function seedLearningActivity(userId: string): Promise<void> {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO learning_sessions (id, subject_user_id, mode, source_type, source_id, started_at, ended_at)
     VALUES ($1,$2,'ASSESSMENT','exam_attempt',$3, now() - interval '10 minutes', now())`,
    [sessionId, userId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO learning_attempt_events
       (id, subject_user_id, session_id, item_source, item_id, item_version, context, answered, correct, score,
        content_version, source_attempt_type, source_attempt_id, occurred_at)
     VALUES ($1,$2,$3,'INSTITUTION_EXAM_QUESTION',$4,1,'ASSESSMENT',true,true,1,'institution-exam-v1','exam_attempt',$5,now())`,
    [randomUUID(), userId, sessionId, randomUUID(), randomUUID()],
  );
  await pool.query(`INSERT INTO learner_activity_events (id, user_id, event_type) VALUES ($1,$2,'EXAM_ATTEMPT_SUBMITTED')`, [randomUUID(), userId]);
}

let opportunitySeq = 0;
async function seedApplication(studentUserId: string): Promise<string> {
  const opportunityId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  opportunitySeq += 1;
  await pool.query(`INSERT INTO opportunities (id, employer_id, created_by_user_id, reference_code, lifecycle_state) VALUES ($1,$2,$3,$4,'DRAFT')`, [opportunityId, employerId, opsId, `REF-${opportunitySeq}`]);
  await pool.query(
    `INSERT INTO opportunity_versions (id, opportunity_id, version_number, title, employment_type, work_mode, location_city, material_terms_hash, created_by_user_id)
     VALUES ($1,$2,1,'SOC Analyst Intern','INTERNSHIP','ONSITE','Bengaluru',$3,$4)`,
    [versionId, opportunityId, 'a'.repeat(64), opsId],
  );
  await pool.query(`UPDATE opportunities SET current_version_id = $1, lifecycle_state='PUBLISHED', published_at=now() WHERE id = $2`, [versionId, opportunityId]);
  await pool.query(
    `INSERT INTO applications (id, opportunity_id, employer_id, applied_version_id, student_user_id, state, consent_granted_at, submitted_at)
     VALUES ($1,$2,$3,$4,$5,'APPLIED',now(),now())`,
    [applicationId, opportunityId, employerId, versionId, studentUserId],
  );
  return applicationId;
}

/**
 * One published two-question screening test, an invitation on the application, and an attempt with
 * both questions answered, as the EMP-12 routes write them. The option shuffle swaps A and B, so the
 * export can be shown to report the keys the candidate saw rather than the stored ones. A submitted
 * attempt is graded (first answer right, second wrong: 1 of 2, 50%).
 */
async function seedScreening(applicationId: string, candidateUserId: string, state: 'SUBMITTED' | 'IN_PROGRESS'): Promise<{ attemptId: string; invitationId: string }> {
  const assessmentId = randomUUID();
  const invitationId = randomUUID();
  const attemptId = randomUUID();
  const submitted = state === 'SUBMITTED';
  await pool.query(
    `INSERT INTO employer_assessments (id, employer_id, title, duration_seconds, total_marks, lifecycle_state, created_by_user_id, published_at)
     VALUES ($1,$2,$3,1800,2,'PUBLISHED',$4,now())`, [assessmentId, employerId, `Screening ${state}`, opsId],
  );
  const questionIds: string[] = [];
  for (const [index, text] of ['Which port does HTTPS use by default?', 'Which log shows failed SSH logins?'].entries()) {
    const questionId = randomUUID();
    questionIds.push(questionId);
    await pool.query(
      `INSERT INTO employer_assessment_questions (id, employer_id, question_text, question_type, question_hash, approval_status, created_by_user_id)
       VALUES ($1,$2,$3,'SINGLE_CHOICE_MCQ',$4,'APPROVED',$5)`, [questionId, employerId, `${text} (${assessmentId.slice(0, 8)})`, `hash-${questionId}`, opsId],
    );
    // Stored key A is correct on both questions.
    await pool.query(
      `INSERT INTO employer_assessment_question_options (id, question_id, option_key, option_text, is_correct)
       VALUES ($1,$2,'A','First choice',true), ($3,$2,'B','Second choice',false)`, [randomUUID(), questionId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO employer_assessment_items (id, assessment_id, employer_id, question_id, sequence, marks) VALUES ($1,$2,$3,$4,$5,1)`,
      [randomUUID(), assessmentId, employerId, questionId, index + 1],
    );
  }
  await pool.query(
    `INSERT INTO employer_assessment_invitations (id, assessment_id, employer_id, application_id, state, invited_by_user_id, closes_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days')`, [invitationId, assessmentId, employerId, applicationId, submitted ? 'SUBMITTED' : 'STARTED', opsId],
  );
  await pool.query(
    `INSERT INTO employer_assessment_attempts (id, invitation_id, candidate_user_id, seed, state, submitted_at, score, max_score, percentage)
     VALUES ($1,$2,$3,'seed-privacy-test',$4, ${submitted ? 'now(), 1, 2, 50' : 'NULL, NULL, NULL, NULL'})`,
    [attemptId, invitationId, candidateUserId, state],
  );
  for (const [index, questionId] of questionIds.entries()) {
    await pool.query(
      `INSERT INTO employer_assessment_attempt_questions (id, attempt_id, question_id, display_order, question_version, marks, option_map)
       VALUES ($1,$2,$3,$4,1,1,'{"A":"B","B":"A"}'::jsonb)`, [randomUUID(), attemptId, questionId, index + 1],
    );
    // Stored A (shown as B) on the first question, stored B (shown as A) on the second.
    await pool.query(
      `INSERT INTO employer_assessment_answers (id, attempt_id, question_id, selected_option_keys, is_correct, marks_awarded)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), attemptId, questionId, [index === 0 ? 'A' : 'B'], submitted ? index === 0 : null, submitted ? (index === 0 ? 1 : 0) : null],
    );
  }
  return { attemptId, invitationId };
}

// --- Every personal record the export now covers (docs/architecture/privacy-export-coverage.md) ---------

const SHA = 'e'.repeat(64);

interface Fixtures {
  institutionId: string; lecturerId: string; lecturerMembershipId: string;
  topicId: string; questionId: string; lessonId: string; roleId: string;
  readinessModelId: string; roadmapPolicyId: string; assessmentDefinitionId: string; blueprintId: string;
  examDefinitionId: string;
}

/** What each person's seed leaves behind that the export must never carry, and what deletion must remove. */
interface PersonalRecords {
  deviceToken: string; tokenDigest: string; photoKey: string; documentVersionId: string; verificationActionId: string;
}

/** A college with a lecturer, published content on the topic, and the shared definitions the records point at. */
async function seedFixtures(topicId: string): Promise<Fixtures> {
  const institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id, kind, legal_name, verification_state, active) VALUES ($1,'INSTITUTION','Privacy Test College','VERIFIED',true)", [institutionId]);
  const lecturerId = randomUUID();
  const lecturerMembershipId = randomUUID();
  await db.insert(schema.users).values({ id: lecturerId, externalSubject: `sub:${randomUUID()}`, email: 'lecturer@uat.test', state: 'ACTIVE' });
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
    VALUES ($1,$2,$3,'FACULTY_LECTURER','ACTIVE',$2,$2)`, [lecturerMembershipId, institutionId, lecturerId]);

  // One published release carrying an answer-keyed question, a lesson and a readiness check on the topic.
  const [runId, packageId, sourceRecordId] = [randomUUID(), randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES ($1, $2, 'synthetic/privacy', $3, $4, 'privacy-test', 'STAGED', $5, now())`, [runId, `privacy-${runId}`, 'c'.repeat(40), SHA, opsId]);
  await pool.query(`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES ($1, $2, $3, 'synthetic/privacy', $4, $5, 'privacy-test', '[]', '{}', '{}')`, [packageId, runId, `privacy-${packageId}`, 'c'.repeat(40), SHA]);
  await pool.query(`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES ($1, $2, 'ENGINE_CONTENT', 'privacy', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
  [sourceRecordId, packageId, SHA]);
  const manifestId = randomUUID();
  await pool.query(`INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1, $2, 1, $3, 'DRAFT')`,
    [manifestId, `privacy-${manifestId}`, manifestId.replace(/-/g, '').repeat(2)]);
  const [questionId, moduleId, lessonId, blueprintId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const revisionOf = new Map<string, string>();
  for (const [entityType, entityId] of [['QUESTION', questionId], ['MODULE', moduleId], ['LESSON', lessonId], ['ASSESSMENT_BLUEPRINT', blueprintId]] as const) {
    const revisionId = randomUUID();
    revisionOf.set(entityId, revisionId);
    await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1, $2, $3, 1, $4, 'DRAFT', $5, '{}')`, [revisionId, entityType, entityId, opsId, SHA]);
    await pool.query('INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1, $2, $3, $4)',
      [manifestId, revisionId, sourceRecordId, SHA]);
  }
  await pool.query("UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = $2, approved_at = now() WHERE id = $1", [manifestId, opsId]);
  await pool.query("UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = $2, published_at = now() WHERE id = $1", [manifestId, opsId]);
  await pool.query(`INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
    VALUES ($1, $2, 1, $3, 'Which port does SSH use?', $4::jsonb, $5, $6, now())`,
  [questionId, `privacy-q-${questionId}`, topicId, JSON.stringify([{ id: 'a', text: '22' }, { id: 'b', text: '80' }]), revisionOf.get(questionId), manifestId]);
  await pool.query(`INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash) VALUES ($1, 'a', 'Synthetic explanation.', $2)`, [questionId, SHA]);
  await pool.query(`INSERT INTO learning_modules (id, stable_key, version, title, description, content_revision_id, release_manifest_id, published_at)
    VALUES ($1, $2, 1, 'Synthetic module', 'Synthetic', $3, $4, now())`, [moduleId, `privacy-m-${moduleId}`, revisionOf.get(moduleId), manifestId]);
  await pool.query(`INSERT INTO lesson_versions (id, module_id, stable_key, version, title, body, topic_id, content_revision_id, published_at)
    VALUES ($1, $2, $3, 1, 'Reading auth logs', '{}', $4, $5, now())`, [lessonId, moduleId, `privacy-l-${lessonId}`, topicId, revisionOf.get(lessonId)]);
  const assessmentDefinitionId = randomUUID();
  await pool.query(`INSERT INTO assessment_definitions (id, stable_key, version, title, content_revision_id, release_manifest_id, attempt_limit, time_limit_seconds, published_at)
    VALUES ($1, $2, 1, 'Networking readiness check', $3, $4, 3, 900, now())`, [assessmentDefinitionId, `privacy-a-${assessmentDefinitionId}`, revisionOf.get(blueprintId), manifestId]);
  await pool.query(`INSERT INTO assessment_blueprints (id, assessment_definition_id, version, selection_count, algorithm_version, constraints)
    VALUES ($1, $2, 1, 1, 'sha256-ranked-v1', '{}'::jsonb)`, [blueprintId, assessmentDefinitionId]);

  const roleId = randomUUID();
  await pool.query(`INSERT INTO career_roles (id, code, title, family) VALUES ($1, $2, 'Privacy check analyst', 'TEST')`, [roleId, 'PRIV_' + roleId.slice(0, 8).toUpperCase()]);
  const readinessModelId = randomUUID();
  await pool.query(`INSERT INTO readiness_model_versions (id, stable_key, version, policy, published_by_user_id, published_at)
    VALUES ($1, $2, 1, '{}'::jsonb, $3, now())`, [readinessModelId, `privacy-model-${readinessModelId}`, opsId]);
  const roadmapPolicyId = randomUUID();
  await pool.query(`INSERT INTO roadmap_policy_versions (id, stable_key, version, policy, published_by_user_id, published_at)
    VALUES ($1, $2, 1, '{}'::jsonb, $3, now())`, [roadmapPolicyId, `privacy-roadmap-${roadmapPolicyId}`, opsId]);
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement) VALUES ('privacy-notice', 'privacy-test-v1', 'Privacy notice', 'BLOCKING')
    ON CONFLICT (consent_key, version) DO NOTHING`);

  const examSubjectId = randomUUID();
  await pool.query("INSERT INTO exam_subjects (id, institution_id, name) VALUES ($1, $2, 'Computer networks')", [examSubjectId, institutionId]);
  const examDefinitionId = randomUUID();
  await pool.query(`INSERT INTO exam_definitions (id, institution_id, subject_id, title, exam_kind, lifecycle_state, total_marks, duration_seconds, starts_at, ends_at, created_by_user_id, published_at)
    VALUES ($1, $2, $3, 'Networks unit test', 'UNIT_TEST', 'PUBLISHED', 10, 600, now() - interval '2 days', now() + interval '2 days', $4, now())`,
  [examDefinitionId, institutionId, examSubjectId, lecturerId]);

  return { institutionId, lecturerId, lecturerMembershipId, topicId, questionId, lessonId, roleId, readinessModelId, roadmapPolicyId, assessmentDefinitionId, blueprintId, examDefinitionId };
}

/**
 * One of every record the export now covers, for one person. Every text the person or their college
 * wrote carries `tag`, so a bundle can be searched for the other person's tag and shown not to hold it.
 */
async function seedPersonalRecords(userId: string, applicationId: string, tag: string, documentId: string | null): Promise<PersonalRecords> {
  const f = fixtures;
  const q = (text: string, values: unknown[]) => pool.query(text, values);
  const relationshipId = randomUUID();
  await q(`INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from) VALUES ($1,$2,$3,'ACTIVE','2024-06-01T00:00:00Z')`, [relationshipId, f.institutionId, userId]);
  await q(`INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE')`, [randomUUID(), f.institutionId, userId, `R-${userId.slice(0, 8)}`, `${tag} Person`]);

  // Account: consent, notifications, a device, the college's invitation and a support case.
  await q(`INSERT INTO user_consents (id, user_id, consent_key, version, action) VALUES ($1,$2,'privacy-notice','privacy-test-v1','GRANTED')`, [randomUUID(), userId]);
  await q(`INSERT INTO notification_preferences (user_id, email_enabled, timezone) VALUES ($1, false, 'Asia/Kolkata')`, [userId]);
  await q(`INSERT INTO user_notifications (id, user_id, kind, title, body, data) VALUES ($1,$2,'SYSTEM',$3,'Your interview moved to Friday.', $4::jsonb)`,
    [randomUUID(), userId, `${tag} notice`, JSON.stringify({ internalRef: 'internal-reference-marker' })]);
  const deviceToken = `device-token-${randomUUID()}`;
  await q(`INSERT INTO device_push_tokens (id, user_id, platform, token) VALUES ($1,$2,'ANDROID',$3)`, [randomUUID(), userId, deviceToken]);
  await q(`INSERT INTO invitations (id, email, token_hash, invited_by_user_id, organization_id, expires_at, kind, student_user_id)
    VALUES ($1,$2,$3,$4,$5, now() + interval '7 days', 'STUDENT', $6)`,
  [randomUUID(), `${tag.toLowerCase()}.invite@uat.test`, randomUUID().replace(/-/g, '').repeat(2), f.lecturerId, f.institutionId, userId]);
  await q(`INSERT INTO support_cases (id, subject_user_id, channel, category, severity, summary, opened_by_user_id, opening_reason_code, sla_due_at)
    VALUES ($1,$2,'EMAIL','HOW_TO','LOW',$3,$4,'USER_REQUEST', now() + interval '2 days')`, [randomUUID(), userId, `${tag} asked how to share a CV`, opsId]);

  // Profile and records.
  // SECONDARY: the deletion test later gives the subject a PRIMARY target of its own.
  await q(`INSERT INTO student_career_targets (id, student_user_id, career_role_id, priority) VALUES ($1,$2,$3,'SECONDARY')`, [randomUUID(), userId, f.roleId]);
  const gapId = randomUUID();
  await q(`INSERT INTO career_gap_snapshots (id, student_user_id, career_role_id, model_version, requirements_total, requirements_met, requirements_unknown)
    VALUES ($1,$2,$3,'career-gap-v1',7,3,2)`, [gapId, userId, f.roleId]);
  await q(`INSERT INTO career_gap_items (id, snapshot_id, topic_id, requirement_level, target_mastery, observed_mastery, status, priority_rank)
    VALUES ($1,$2,$3,'ESSENTIAL',0.8,0.5173,'PARTIAL',1)`, [randomUUID(), gapId, f.topicId]);
  await q(`INSERT INTO learner_goals (id, student_user_id, institution_id, goal_type, topic_id, origin) VALUES ($1,$2,$3,'TOPIC',$4,'GOALS')`,
    [randomUUID(), userId, f.institutionId, f.topicId]);
  await q(`INSERT INTO student_outcome_declarations (id, student_user_id, institution_id, outcome) VALUES ($1,$2,$3,'HIGHER_STUDIES')`, [randomUUID(), userId, f.institutionId]);
  await q(`INSERT INTO external_applications (id, student_user_id, company_name, role_title, source_kind, applied_on)
    VALUES ($1,$2,$3,'Security intern','JOB_BOARD','2026-08-01')`, [randomUUID(), userId, `${tag} Robotics`]);

  // A document version: evidence for an academic term and for a college verification action.
  let ownDocumentId = documentId;
  if (!ownDocumentId) {
    ownDocumentId = randomUUID();
    await q(`INSERT INTO student_document_metadata (id, student_user_id, title, document_type) VALUES ($1,$2,'Marksheet','TRANSCRIPT')`, [ownDocumentId, userId]);
  }
  const fileId = randomUUID();
  const documentVersionId = randomUUID();
  await q(`INSERT INTO stored_files (id, storage_key, original_filename, content_type, uploaded_by_user_id) VALUES ($1,$2,'marksheet.pdf','application/pdf',$3)`,
    [fileId, `documents/${fileId}`, userId]);
  await q(`INSERT INTO student_document_versions (id, document_id, version_number, file_id, created_by_user_id) VALUES ($1,$2,1,$3,$4)`,
    [documentVersionId, ownDocumentId, fileId, userId]);
  const qualificationId = randomUUID();
  const termId = randomUUID();
  await q(`INSERT INTO student_qualifications (id, student_user_id, institution_id, qualification_type, programme_name, started_on)
    VALUES ($1,$2,$3,'BTECH',$4,'2023-08-01')`, [qualificationId, userId, f.institutionId, `${tag} Computer Science`]);
  await q(`INSERT INTO student_academic_terms (id, qualification_id, sequence, label, result_value, result_scale, source, evidence_document_version_id)
    VALUES ($1,$2,1,'Semester 1',8.2,'CGPA_10','DOCUMENT_BACKED',$3)`, [termId, qualificationId, documentVersionId]);
  await q(`INSERT INTO student_academic_subjects (id, term_id, subject_code, subject_name, grade_letter, grade_scale)
    VALUES ($1,$2,'CS101','Programming basics','A','LETTER')`, [randomUUID(), termId]);
  const tokenDigest = randomUUID().replace(/-/g, '').repeat(2);
  await q(`INSERT INTO public_profile_links (id, student_user_id, token_digest, show_photo, expires_at) VALUES ($1,$2,$3,true, now() + interval '30 days')`,
    [randomUUID(), userId, tokenDigest]);
  const photoKey = `profile-photos/${userId}/${randomUUID()}`;
  await storage.put(photoKey, Buffer.from(`${tag} photo bytes`));
  await q(`INSERT INTO student_profile_photos (student_user_id, storage_key, content_type, byte_size) VALUES ($1,$2,'image/png',17)`, [userId, photoKey]);

  // Hiring: what was shared, how it moved, an interview, released feedback, who had access, and a nomination.
  await q(`INSERT INTO application_profile_snapshots (id, application_id, opportunity_version_id, schema_version, snapshot, snapshot_hash)
    VALUES ($1,$2,(SELECT applied_version_id FROM applications WHERE id = $2),1,$3::jsonb,$4)`,
    [randomUUID(), applicationId, JSON.stringify({ schemaVersion: 1, candidate: { fullName: `${tag} Person`, phone: '+91 90000 00000' } }), SHA]);
  await q(`INSERT INTO application_state_history (id, application_id, from_state, to_state, actor_role, note) VALUES ($1,$2,'APPLIED','SCREENING','RECRUITER',$3)`,
    [randomUUID(), applicationId, `${tag} internal recruiter note`]);
  // The employer changed the job's material terms after they applied, and they acknowledged it.
  const revisedVersionId = randomUUID();
  await q(`INSERT INTO opportunity_versions (id, opportunity_id, version_number, title, employment_type, work_mode, location_city, material_terms_hash, created_by_user_id)
    SELECT $1, opportunity_id, 2, 'SOC Analyst Intern (revised)', 'INTERNSHIP', 'ONSITE', 'Bengaluru', $2, $3 FROM applications WHERE id = $4`,
  [revisedVersionId, 'b'.repeat(64), opsId, applicationId]);
  await q(`INSERT INTO opportunity_term_change_acknowledgements (id, application_id, from_version_id, to_version_id, notified_at, acknowledged_at)
    SELECT $1, id, applied_version_id, $2, now(), now() FROM applications WHERE id = $3`, [randomUUID(), revisedVersionId, applicationId]);
  await q(`INSERT INTO interviews (id, application_id, employer_id, round_number, mode, state, scheduled_start, scheduled_end, joining_link, preparation_note, created_by_user_id)
    VALUES ($1,$2,$3,1,'VIDEO','SCHEDULED', now() + interval '3 days', now() + interval '3 days 1 hour', 'https://meet.example.test/room', $4, $5)`,
  [randomUUID(), applicationId, employerId, `${tag} bring your portfolio`, opsId]);
  const releaseId = randomUUID();
  await q(`INSERT INTO application_feedback_releases (id, application_id, employer_id, released_by_user_id, note) VALUES ($1,$2,$3,$4,$5)`,
    [releaseId, applicationId, employerId, opsId, `${tag} feedback note`]);
  await q(`INSERT INTO application_feedback_release_reasons (release_id, reason_code) VALUES ($1,'CORE_SKILL_GAP')`, [releaseId]);
  const opportunityId = (await q('SELECT opportunity_id FROM applications WHERE id = $1', [applicationId])).rows[0].opportunity_id as string;
  await q(`INSERT INTO employer_applicant_access_grants (id, employer_id, student_user_id, opportunity_id, granted_at) VALUES ($1,$2,$3,$4, now())`,
    [randomUUID(), employerId, userId, opportunityId]);
  const driveId = randomUUID();
  await q(`INSERT INTO campus_drives (id, employer_id, opportunity_id, institution_id, requested_by_user_id, state, decided_by_user_id, decided_at)
    VALUES ($1,$2,$3,$4,$5,'APPROVED',$6, now())`, [driveId, employerId, opportunityId, f.institutionId, opsId, f.lecturerId]);
  await q(`INSERT INTO campus_drive_nominations (id, campus_drive_id, opportunity_id, institution_id, student_user_id, nominated_by_user_id, nominated_by_role, reason_code, note)
    VALUES ($1,$2,$3,$4,$5,$6,'PLACEMENT_ADMIN','MEETS_ELIGIBILITY',$7)`, [randomUUID(), driveId, opportunityId, f.institutionId, userId, f.lecturerId, `${tag} strong fit`]);

  // The college: a shared task, a staff-only note, a verification action on the document, a group
  // session, a lecturer's assignment and next step, and a published exam result.
  const staffAction = async (type: string, visibility: string, title: string, extra: { evidence?: string; meeting?: boolean } = {}): Promise<string> => {
    const id = randomUUID();
    const aboutStudent = !extra.meeting;
    await q(`INSERT INTO staff_actions (id, institution_id, subject_student_user_id, institution_relationship_id, actor_user_id, actor_membership_id,
        action_type, state, title, note, visibility, evidence_document_version_id, scheduled_start_at, scheduled_end_at, updated_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8,$9,$10,$11,$12,$13,$5)`,
    [id, f.institutionId, aboutStudent ? userId : null, aboutStudent ? relationshipId : null, f.lecturerId, f.lecturerMembershipId,
      type, title, `${title} details`, visibility, extra.evidence ?? null,
      extra.meeting ? new Date(Date.now() + 86_400_000).toISOString() : null, extra.meeting ? new Date(Date.now() + 90_000_000).toISOString() : null]);
    return id;
  };
  await staffAction('ASSIGNED_TASK', 'SUBJECT_VISIBLE', `${tag} finish the lab report`);
  await staffAction('FACULTY_NOTE', 'STAFF_ONLY', `${tag} staff-only observation`);
  const verificationActionId = await staffAction('ACADEMIC_VERIFICATION', 'STAFF_ONLY', `${tag} verify semester 1`, { evidence: documentVersionId });
  const meetingId = await staffAction('MEETING', 'STAFF_ONLY', `${tag} revision session`, { meeting: true });
  await q(`INSERT INTO staff_action_attendees (staff_action_id, student_user_id, institution_id) VALUES ($1,$2,$3)`, [meetingId, userId, f.institutionId]);
  const assignmentId = randomUUID();
  await q(`INSERT INTO learning_assignments (id, institution_id, assigned_by_user_id, assigned_by_membership_id, content_kind, skill_id, target_kind, note)
    VALUES ($1,$2,$3,$4,'PRACTICE',$5,'STUDENTS',$6)`, [assignmentId, f.institutionId, f.lecturerId, f.lecturerMembershipId, f.topicId, `${tag} practise before Monday`]);
  await q(`INSERT INTO learning_assignment_students (assignment_id, student_user_id, institution_id) VALUES ($1,$2,$3)`, [assignmentId, userId, f.institutionId]);
  await q(`INSERT INTO learning_plan_overrides (id, institution_id, student_user_id, created_by_user_id, created_by_membership_id, action, content_kind, skill_id, lesson_version_id, reason_code, note)
    VALUES ($1,$2,$3,$4,$5,'LEARN','LESSON',$6,$7,'CATCH_UP',$8)`,
  [randomUUID(), f.institutionId, userId, f.lecturerId, f.lecturerMembershipId, f.topicId, f.lessonId, `${tag} start with the lesson`]);
  const examAttemptId = randomUUID();
  await q(`INSERT INTO exam_assignments (id, institution_id, definition_id, student_user_id, assigned_by_user_id) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), f.institutionId, f.examDefinitionId, userId, f.lecturerId]);
  await q(`INSERT INTO exam_attempts (id, institution_id, definition_id, student_user_id, attempt_number, status, paper_seed, submitted_at, screen_shift_count)
    VALUES ($1,$2,$3,$4,1,'SUBMITTED','paper-seed-secret',now(),2)`, [examAttemptId, f.institutionId, f.examDefinitionId, userId]);
  await q(`INSERT INTO exam_results (id, attempt_id, score, max_score, percentage, correct_count, wrong_count, not_attempted_count, time_taken_seconds, published)
    VALUES ($1,$2,7,10,70,7,2,1,420,true)`, [randomUUID(), examAttemptId]);

  // The learning engine: a practice step with its served question, a placement sitting, a lesson,
  // evidence, bands, the roadmap and a readiness check.
  const decisionId = randomUUID();
  await q(`INSERT INTO learning_decisions (id, subject_user_id, policy_version, adaptive, inputs, inputs_hash, action, skill_id, reason_codes, correlation_id)
    VALUES ($1,$2,'learning-orchestrator-v1',true,$3::jsonb,$4,'PRACTICE',$5,'{WEAKEST_SKILL}','privacy-test')`,
  [decisionId, userId, JSON.stringify({ plannerSecretEstimate: 0.4137 }), SHA, f.topicId]);
  const stepSessionId = randomUUID();
  await q(`INSERT INTO learning_sessions (id, subject_user_id, mode, source_type, source_id, started_at) VALUES ($1,$2,'PRACTICE','learning_step',$3, now())`,
    [stepSessionId, userId, decisionId]);
  await q(`INSERT INTO learning_step_items (id, decision_id, subject_user_id, session_id, position, item_source, item_id, item_version, skill_id)
    VALUES ($1,$2,$3,$4,1,'CAREER_READINESS_QUESTION',$5,1,$6)`, [randomUUID(), decisionId, userId, stepSessionId, f.questionId, f.topicId]);
  const placementSessionId = randomUUID();
  const placementId = randomUUID();
  await q(`INSERT INTO learning_sessions (id, subject_user_id, mode, source_type, source_id, started_at) VALUES ($1,$2,'DIAGNOSTIC','placement_test',$3, now())`,
    [placementSessionId, userId, placementId]);
  await q(`INSERT INTO placement_tests (id, subject_user_id, session_id, scope, algorithm_id, state, started_at, deadline_at)
    VALUES ($1,$2,$3,'APTITUDE_V1','placement-2pl-eap-v1','IN_PROGRESS', now(), now() + interval '20 minutes')`, [placementId, userId, placementSessionId]);
  await q(`UPDATE placement_tests SET state = 'COMPLETED', completed_at = now(), stop_reason = 'MAX_ITEMS', placement_level = 'GUIDED', items_answered = 12 WHERE id = $1`, [placementId]);
  await q(`INSERT INTO learner_progress (id, subject_user_id, lesson_version_id, state, started_at, completed_at, last_correlation_id)
    VALUES ($1,$2,$3,'COMPLETED', now(), now(), 'privacy-test-progress')`, [randomUUID(), userId, f.lessonId]);
  const evidenceId = randomUUID();
  await q(`INSERT INTO evidence_records (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id, content_version, provenance, occurred_at)
    VALUES ($1,$2,'TOPIC_DEMONSTRATION',$3,3,4,'privacy_test',$4,'privacy-v1','{}'::jsonb, now())`, [evidenceId, userId, f.topicId, randomUUID()]);
  await q(`INSERT INTO mastery_projections (id, subject_user_id, topic_id, algorithm_version, evidence_ids, evidence_set_hash, band)
    VALUES ($1,$2,$3,'mastery-v1',$4::uuid[],$5,'PROGRESSING')`, [randomUUID(), userId, f.topicId, [evidenceId], SHA]);
  await q(`INSERT INTO readiness_snapshots (id, subject_user_id, model_version_id, evidence_ids, evidence_set_hash, band, explanation)
    VALUES ($1,$2,$3,$4::uuid[],$5,'DEVELOPING', $6::jsonb)`, [randomUUID(), userId, f.readinessModelId, [evidenceId], SHA, JSON.stringify({ modelWeight: 0.731 })]);
  await q(`INSERT INTO roadmap_actions (id, subject_user_id, policy_version_id, topic_id, action_code, reason_code, evidence_ids, state)
    VALUES ($1,$2,$3,$4,'RETRY_PRACTICE','LOW_EVIDENCE',$5::uuid[],'RECOMMENDED')`, [randomUUID(), userId, f.roadmapPolicyId, f.topicId, [evidenceId]]);
  const checkAssignmentId = randomUUID();
  await q(`INSERT INTO assessment_assignments (id, assessment_definition_id, subject_user_id, assigned_by_user_id, available_at, due_at, state)
    VALUES ($1,$2,$3,$3, now() - interval '1 hour', now() + interval '1 hour', 'COMPLETED')`, [checkAssignmentId, f.assessmentDefinitionId, userId]);
  await q(`INSERT INTO assessment_attempts (id, assignment_id, subject_user_id, blueprint_id, selection_seed, state, started_at, expires_at, submitted_at,
      submission_idempotency_key, score_correct, score_possible, correlation_id)
    VALUES ($1,$2,$3,$4,'selection-seed-secret-0001', 'SUBMITTED', now() - interval '30 minutes', now() + interval '30 minutes', now(), $5, 4, 5, 'privacy-test-check')`,
  [randomUUID(), checkAssignmentId, userId, f.blueprintId, `submit-${randomUUID()}`]);

  return { deviceToken, tokenDigest, photoKey, documentVersionId, verificationActionId };
}

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

const api = () => request(app.getHttpServer());
const auth = () => ({ authorization: `Bearer ${subjectToken}`, 'x-correlation-id': `privacy-test-${randomUUID()}` });

describe('data export', () => {
  let exportRequestId: string;

  it('produces a bundle containing only the subject data', async () => {
    const response = await api().post('/api/v1/students/me/privacy/exports').set(auth()).expect(201);
    exportRequestId = response.body.request.id;
    expect(response.body.request.state).toBe('READY');

    const download = await api().get(`/api/v1/students/me/privacy/exports/${exportRequestId}/download`).set(auth()).expect(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    // Served as application/json, so supertest has already parsed it.
    const bundle = download.body as {
      subjectUserId: string;
      studentProfile: { target_career: string };
      applications: unknown[];
      documents: unknown[];
      notIncluded: string[];
    };
    expect(bundle.subjectUserId).toBe(subjectId);
    expect(bundle.studentProfile.target_career).toBe('SOC Analyst');
    expect(bundle.applications).toHaveLength(1);
    expect(bundle.documents).toHaveLength(1);
    // The bundle says what it does not contain, so silence is not mistaken for absence.
    expect(bundle.notIncluded.join(' ')).toMatch(/scorecards/i);
  });

  it('includes the subject\'s own screening attempts and answers, never the answer key or another candidate', async () => {
    const download = await api().get(`/api/v1/students/me/privacy/exports/${exportRequestId}/download`).set(auth()).expect(200);
    const bundle = download.body as { screeningAssessments: Record<string, any>[]; notIncluded: string[] };
    expect(bundle.screeningAssessments).toHaveLength(2);
    const submitted = bundle.screeningAssessments.find((entry) => entry.title === 'Screening SUBMITTED');
    const open = bundle.screeningAssessments.find((entry) => entry.title === 'Screening IN_PROGRESS');
    expect(submitted).toMatchObject({ employerName: 'Aster Mobility', roleTitle: 'SOC Analyst Intern', state: 'SUBMITTED' });
    // The score as the student already sees it: the percentage.
    expect(submitted?.attempt).toMatchObject({ state: 'SUBMITTED', percentage: 50 });
    expect(submitted?.attempt.submittedAt).toBeTruthy();
    expect(open?.attempt).toMatchObject({ state: 'IN_PROGRESS', percentage: null, submittedAt: null });
    // Their answers, under the keys they saw: stored A is shown as B, and stored B as A.
    const questions = submitted?.attempt.questions as Record<string, any>[];
    expect(questions.map((question) => question.displayOrder)).toEqual([1, 2]);
    expect(questions[0]?.questionText).toMatch(/^Which port does HTTPS use by default\?/);
    expect(questions[0]?.options).toEqual([{ key: 'A', text: 'Second choice' }, { key: 'B', text: 'First choice' }]);
    expect(questions[0]?.yourAnswer).toEqual({ selectedOptionKeys: ['B'], numericResponse: null });
    expect(questions[1]?.yourAnswer).toEqual({ selectedOptionKeys: ['A'], numericResponse: null });

    // Never the answer key, how an answer was marked, the raw score, or the stored shuffle.
    const text = JSON.stringify(bundle.screeningAssessments);
    for (const forbidden of ['is_correct', 'isCorrect', 'correct', 'marks_awarded', 'marksAwarded', 'score', 'maxScore', 'max_score', 'seed', 'option_map', 'optionMap']) {
      expect(text, `export must not carry ${forbidden}`).not.toContain(`"${forbidden}"`);
    }
    // Nothing about another candidate: their attempt is absent.
    expect(text).not.toContain(otherAttemptId);
    expect(text).not.toContain(otherCandidateId);
    expect(bundle.notIncluded.join(' ')).toMatch(/answer key to employer screening tests/i);
  });

  it('includes every personal record added since the export was written, and only the subject\'s', async () => {
    const download = await api().get(`/api/v1/students/me/privacy/exports/${exportRequestId}/download`).set(auth()).expect(200);
    const bundle = download.body as Record<string, any>;

    // Account.
    expect(bundle.consents).toEqual([expect.objectContaining({ consentKey: 'privacy-notice', title: 'Privacy notice', version: 'privacy-test-v1', action: 'GRANTED' })]);
    expect(bundle.notificationPreferences).toMatchObject({ emailEnabled: false, timezone: 'Asia/Kolkata' });
    expect(bundle.notifications).toEqual([expect.objectContaining({ kind: 'SYSTEM', title: 'Subjectmark notice', body: 'Your interview moved to Friday.', readAt: null })]);
    expect(bundle.devices).toEqual([expect.objectContaining({ platform: 'ANDROID', revokedAt: null })]);
    expect(bundle.invitations).toEqual([expect.objectContaining({ organizationName: 'Privacy Test College', kind: 'STUDENT', sentTo: 'subjectmark.invite@uat.test' })]);
    expect(bundle.supportCases).toEqual([expect.objectContaining({ channel: 'EMAIL', category: 'HOW_TO', state: 'OPEN' })]);

    // Profile and records.
    expect(bundle.careerTargets).toEqual([expect.objectContaining({ roleTitle: 'Privacy check analyst', priority: 'SECONDARY', clearedAt: null })]);
    expect(bundle.careerGaps).toEqual([expect.objectContaining({ roleTitle: 'Privacy check analyst', requirementsTotal: 7, requirementsMet: 3, requirementsUnknown: 2,
      requirements: [{ topicName: 'Synthetic topic', level: 'ESSENTIAL', status: 'PARTIAL', priorityRank: 1 }] })]);
    expect(bundle.goals).toEqual(expect.arrayContaining([
      expect.objectContaining({ goalType: 'ROLE', roleTitle: 'Privacy check analyst', origin: 'CAREER_TARGET', status: 'ACTIVE' }),
      expect.objectContaining({ goalType: 'TOPIC', topicName: 'Synthetic topic', origin: 'GOALS', institutionName: 'Privacy Test College' }),
    ]));
    expect(bundle.goals).toHaveLength(2);
    expect(bundle.outcomeDeclarations).toEqual([expect.objectContaining({ institutionName: 'Privacy Test College', outcome: 'HIGHER_STUDIES', withdrawnAt: null })]);
    expect(bundle.externalApplications).toEqual([expect.objectContaining({
      companyName: 'Subjectmark Robotics', roleTitle: 'Security intern', sourceKind: 'JOB_BOARD', appliedOn: '2026-08-01', stage: 'APPLIED', source: 'STUDENT_DECLARED' })]);
    expect(bundle.academicRecords).toEqual([expect.objectContaining({
      institutionName: 'Privacy Test College', qualificationType: 'BTECH', programmeName: 'Subjectmark Computer Science', startedOn: '2023-08-01', verificationState: 'SELF_REPORTED',
      terms: [expect.objectContaining({ sequence: 1, label: 'Semester 1', resultValue: 8.2, resultScale: 'CGPA_10', source: 'DOCUMENT_BACKED',
        subjects: [expect.objectContaining({ subjectCode: 'CS101', subjectName: 'Programming basics', gradeLetter: 'A', gradeScale: 'LETTER' })] })],
    })]);
    expect(bundle.publicProfile.photo).toMatchObject({ contentType: 'image/png', byteSize: 17 });
    expect(bundle.publicProfile.links).toEqual([expect.objectContaining({ cover: 'MIDNIGHT', revokedAt: null, shows: expect.objectContaining({ photo: true, assessments: false }) })]);

    // Hiring.
    expect(bundle.applicationSnapshots).toEqual([expect.objectContaining({ employerName: 'Aster Mobility', title: 'SOC Analyst Intern', erasedAt: null,
      snapshot: { schemaVersion: 1, candidate: { fullName: 'Subjectmark Person', phone: '+91 90000 00000' } } })]);
    expect(bundle.applicationHistory).toEqual([expect.objectContaining({ employerName: 'Aster Mobility', fromState: 'APPLIED', toState: 'SCREENING' })]);
    expect(bundle.jobTermChanges).toEqual([expect.objectContaining({ employerName: 'Aster Mobility', title: 'SOC Analyst Intern',
      newTitle: 'SOC Analyst Intern (revised)', declinedAt: null })]);
    expect(bundle.jobTermChanges[0].acknowledgedAt).toBeTruthy();
    expect(bundle.interviews).toEqual([expect.objectContaining({ employerName: 'Aster Mobility', roundNumber: 1, mode: 'VIDEO', state: 'SCHEDULED',
      joiningLink: 'https://meet.example.test/room', preparationNote: 'Subjectmark bring your portfolio' })]);
    expect(bundle.feedbackReleased).toEqual([expect.objectContaining({ employerName: 'Aster Mobility', note: 'Subjectmark feedback note',
      reasons: ['A core skill for this role was not yet demonstrated'] })]);
    expect(bundle.employerAccess).toEqual([expect.objectContaining({ employerName: 'Aster Mobility', revokedAt: null })]);
    expect(bundle.campusDriveNominations).toEqual([expect.objectContaining({ institutionName: 'Privacy Test College', employerName: 'Aster Mobility',
      nominatedByRole: 'PLACEMENT_ADMIN', reasonCode: 'MEETS_ELIGIBILITY', note: 'Subjectmark strong fit', state: 'INVITED' })]);

    // The college: what it shared in full, what it keeps to itself as a count.
    expect(bundle.collegeActions.shared).toEqual([expect.objectContaining({ institutionName: 'Privacy Test College', actionType: 'ASSIGNED_TASK',
      title: 'Subjectmark finish the lab report', note: 'Subjectmark finish the lab report details', state: 'OPEN' })]);
    expect(bundle.collegeActions.heldByCollege).toEqual([
      { institutionName: 'Privacy Test College', actionType: 'ACADEMIC_VERIFICATION', staffOnlyActions: 1 },
      { institutionName: 'Privacy Test College', actionType: 'FACULTY_NOTE', staffOnlyActions: 1 },
    ]);
    expect(bundle.fromYourLecturers.assignments).toEqual([expect.objectContaining({ institutionName: 'Privacy Test College', kind: 'PRACTICE',
      skillName: 'Synthetic topic', note: 'Subjectmark practise before Monday', withdrawnAt: null })]);
    expect(bundle.fromYourLecturers.nextSteps).toEqual([expect.objectContaining({ institutionName: 'Privacy Test College', action: 'LEARN', kind: 'LESSON',
      title: 'Reading auth logs', skillName: 'Synthetic topic', reasonCode: 'CATCH_UP', note: 'Subjectmark start with the lesson', state: 'PENDING' })]);
    expect(bundle.fromYourLecturers.sessions).toEqual([expect.objectContaining({ institutionName: 'Privacy Test College', title: 'Subjectmark revision session', state: 'OPEN' })]);
    expect(bundle.collegeExams).toEqual([expect.objectContaining({ institutionName: 'Privacy Test College', examTitle: 'Networks unit test', subjectName: 'Computer networks',
      attempts: [expect.objectContaining({ attemptNumber: 1, status: 'SUBMITTED', autoSubmitted: false, focusLossCount: 2,
        result: { score: 7, maxScore: 10, percentage: 70, correct: 7, wrong: 2, notAttempted: 1, timeTakenSeconds: 420 } })] })]);

    // The learning engine: what happened and the bands the student sees, not the engine's estimates.
    const learning = bundle.learning as Record<string, any>;
    expect(learning.sessions.map((session: Record<string, unknown>) => session.mode).sort()).toEqual(['ASSESSMENT', 'DIAGNOSTIC', 'PRACTICE']);
    expect(learning.attempts).toEqual([expect.objectContaining({ context: 'ASSESSMENT', answered: true, correct: true, assisted: false, highestHintLevel: 0 })]);
    expect(learning.activity).toEqual([expect.objectContaining({ eventType: 'EXAM_ATTEMPT_SUBMITTED' })]);
    expect(learning.lessons).toEqual([expect.objectContaining({ lessonTitle: 'Reading auth logs', state: 'COMPLETED' })]);
    expect(learning.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'PRACTICE', skillName: 'Synthetic topic', reasonCodes: ['WEAKEST_SKILL'], adaptive: true,
        items: [expect.objectContaining({ position: 1, skillName: 'Synthetic topic', highestHintShown: 0 })] }),
      expect.objectContaining({ action: 'NONE', skillName: null, items: [] }),
    ]));
    expect(learning.placementTests).toEqual([expect.objectContaining({ scope: 'APTITUDE_V1', state: 'COMPLETED', placementLevel: 'GUIDED', itemsAnswered: 12, stopReason: 'MAX_ITEMS' })]);
    expect(learning.skills).toEqual([expect.objectContaining({ skillName: 'Synthetic topic', attemptCount: 1, evidenceStage: 'RETAINED', evidenceBand: 'NOT_ENOUGH_EVIDENCE' })]);
    expect(learning.evidence).toEqual([expect.objectContaining({ evidenceType: 'TOPIC_DEMONSTRATION', topicName: 'Synthetic topic', demonstrated: 3, possible: 4 })]);
    expect(learning.topicBands).toEqual([expect.objectContaining({ topicName: 'Synthetic topic', band: 'PROGRESSING' })]);
    expect(learning.readiness).toEqual([expect.objectContaining({ band: 'DEVELOPING' })]);
    expect(learning.roadmap).toEqual([expect.objectContaining({ actionCode: 'RETRY_PRACTICE', topicName: 'Synthetic topic', state: 'RECOMMENDED' })]);
    expect(learning.readinessChecks).toEqual([expect.objectContaining({ title: 'Networking readiness check', state: 'SUBMITTED', scoreCorrect: 4, scorePossible: 5 })]);

    // Nothing of the other student, and nothing the rules keep out.
    const text = JSON.stringify(bundle);
    for (const forbidden of [
      'Othermark', otherCandidateId, otherRecords.deviceToken, otherRecords.tokenDigest,
      // Credentials and storage internals.
      subjectRecords.deviceToken, subjectRecords.tokenDigest, subjectRecords.photoKey, 'token_digest', 'tokenDigest', 'storage_key', 'storageKey',
      // Staff-only text, operators' notes and employers' own notes, and who wrote any of it.
      'staff-only observation', 'verify semester 1', 'asked how to share a CV', 'internal recruiter note', fixtures.lecturerId, opsId,
      // Engine estimates, planner inputs, seeds and internal references.
      'plannerSecretEstimate', '0.4137', '0.5173', 'modelWeight', 'mastery_likelihood', 'masteryLikelihood', 'reviewStability', 'difficulty', 'discrimination',
      'paper-seed-secret', 'selection-seed-secret', 'internal-reference-marker', fixtures.questionId,
    ]) {
      expect(text, `export must not carry ${forbidden}`).not.toContain(forbidden);
    }
    const notIncluded = bundle.notIncluded.join(' ');
    expect(notIncluded).toMatch(/estimates/i);
    expect(notIncluded).toMatch(/retention hold/i);
    expect(notIncluded).toMatch(/staff-only/i);
  });

  it('refuses a second open export rather than duplicating work', async () => {
    const response = await api().post('/api/v1/students/me/privacy/exports').set(auth()).expect(400);
    expect(response.body.error.code).toBe('EXPORT_ALREADY_REQUESTED');
  });

  it('does not serve another subject export', async () => {
    const otherSub = `sub:${randomUUID()}`;
    const otherId = randomUUID();
    await db.insert(schema.users).values({ id: otherId, externalSubject: otherSub, email: 'other@uat.test', state: 'ACTIVE' });
    const otherToken = signAccessToken(privateKey, { sub: otherSub, email: 'other@uat.test' });
    await api().get(`/api/v1/students/me/privacy/exports/${exportRequestId}/download`)
      .set({ authorization: `Bearer ${otherToken}`, 'x-correlation-id': `p-${randomUUID()}` }).expect(403);
  });
});

describe('deletion request', () => {
  let deletionId: string;

  it('schedules deletion 30 days out and says so', async () => {
    const response = await api().post('/api/v1/students/me/privacy/deletions').set(auth()).send({ reason: 'No longer job hunting' }).expect(201);
    deletionId = response.body.request.id;
    expect(response.body.gracePeriodDays).toBe(30);
    const scheduled = new Date(response.body.request.scheduledFor).getTime() - Date.now();
    expect(Math.round(scheduled / 86_400_000)).toBe(30);
  });

  it('does nothing while the grace period is running', async () => {
    const summaries = await executeDueDeletions({ db, ids, storage });
    expect(summaries).toHaveLength(0);
    const user = await pool.query('SELECT anonymised_at FROM users WHERE id = $1', [subjectId]);
    expect(user.rows[0].anonymised_at).toBeNull();
  });

  it('lets the subject cancel inside the grace period', async () => {
    await api().post(`/api/v1/students/me/privacy/requests/${deletionId}/cancel`).set(auth()).expect(201);
    const row = await pool.query('SELECT state FROM privacy_requests WHERE id = $1', [deletionId]);
    expect(row.rows[0].state).toBe('CANCELLED');
    const response = await api().post(`/api/v1/students/me/privacy/requests/${deletionId}/cancel`).set(auth()).expect(400);
    expect(response.body.error.code).toBe('REQUEST_CLOSED');
  });
});

describe('learning activity is append-only outside deletion', () => {
  it('refuses to update or delete an attempt or session outside the deletion transaction', async () => {
    await expect(pool.query('UPDATE learning_attempt_events SET correct = false WHERE subject_user_id = $1', [subjectId]))
      .rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM learning_attempt_events WHERE subject_user_id = $1', [subjectId]))
      .rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM learning_sessions WHERE subject_user_id = $1', [subjectId]))
      .rejects.toThrow(/append-only/);
    // The erase setting names one person; it does not open the table for anyone else.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('one.privacy_erase_subject', $1, true)", [opsId]);
      await expect(client.query('DELETE FROM learning_attempt_events WHERE subject_user_id = $1', [subjectId]))
        .rejects.toThrow(/append-only/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const kept = await pool.query('SELECT count(*)::int AS count FROM learning_attempt_events WHERE subject_user_id = $1', [subjectId]);
    expect(kept.rows[0].count).toBe(1);
  });

  it('refuses to change or delete a planner decision outside the deletion transaction for that person', async () => {
    await expect(pool.query("UPDATE learning_decisions SET action = 'LEARN' WHERE subject_user_id = $1", [subjectId]))
      .rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM learning_decisions WHERE subject_user_id = $1', [subjectId]))
      .rejects.toThrow(/append-only/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('one.privacy_erase_subject', $1, true)", [opsId]);
      await expect(client.query('DELETE FROM learning_decisions WHERE subject_user_id = $1', [subjectId]))
        .rejects.toThrow(/append-only/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const kept = await pool.query('SELECT count(*)::int AS count FROM learning_decisions WHERE subject_user_id = $1', [subjectId]);
    // The first seed's decision and the coverage seed's practice step.
    expect(kept.rows[0].count).toBe(2);
  });

  it('refuses to delete the skill state projection outside the projector or the deletion transaction for that person', async () => {
    await expect(pool.query('DELETE FROM learner_skill_state WHERE subject_user_id = $1', [subjectId]))
      .rejects.toThrow(/only the projector writes it/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('one.privacy_erase_subject', $1, true)", [opsId]);
      await expect(client.query('DELETE FROM learner_skill_state WHERE subject_user_id = $1', [subjectId]))
        .rejects.toThrow(/only the projector writes it/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const kept = await pool.query('SELECT count(*)::int AS count FROM learner_skill_state WHERE subject_user_id = $1', [subjectId]);
    expect(kept.rows[0].count).toBe(1);
  });
});

describe('deletion execution', () => {
  let dueId: string;

  it('waits while a retention hold is active', async () => {
    dueId = randomUUID();
    // A genuinely due request: asked for 31 days ago, scheduled for yesterday. The
    // schema refuses a schedule earlier than the request, so both move together.
    await pool.query(
      `INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
       VALUES ($1,$2,$2,'DELETION', now() - interval '31 days', now() - interval '1 day')`, [dueId, subjectId],
    );
    await pool.query(
      `INSERT INTO data_retention_holds (id, subject_user_id, reason_code, placed_by_user_id) VALUES ($1,$2,'SAFETY_INVESTIGATION',$3)`,
      [randomUUID(), subjectId, opsId],
    );
    const summaries = await executeDueDeletions({ db, ids, storage });
    expect(summaries).toEqual([expect.objectContaining({ outcome: 'HELD' })]);
    const user = await pool.query('SELECT anonymised_at FROM users WHERE id = $1', [subjectId]);
    expect(user.rows[0].anonymised_at).toBeNull();
  });

  it('erases the person and keeps the employer record once the hold is released', async () => {
    await pool.query(`UPDATE data_retention_holds SET released_at = now(), released_by_user_id = $1 WHERE subject_user_id = $2`, [opsId, subjectId]);
    // A career role the person chose, and one someone else chose, so the erasure can be told apart.
    const roleId = randomUUID();
    await pool.query(`INSERT INTO career_roles (id, code, title, family) VALUES ($1, $2, 'Erasure check role', 'TEST')`, [roleId, 'ERASE_' + roleId.slice(0, 8).toUpperCase().replace(/-/g, '_')]);
    await pool.query(`INSERT INTO student_career_targets (id, student_user_id, career_role_id) VALUES ($1, $2, $3)`, [randomUUID(), subjectId, roleId]);
    await pool.query(`INSERT INTO student_career_targets (id, student_user_id, career_role_id) VALUES ($1, $2, $3)`, [randomUUID(), opsId, roleId]);

    const summaries = await executeDueDeletions({ db, ids, storage });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.outcome).toBe('COMPLETED');

    // The person is gone.
    const user = await pool.query('SELECT email, external_subject, state, anonymised_at FROM users WHERE id = $1', [subjectId]);
    expect(user.rows[0].email).toMatch(/@deleted\.invalid$/);
    expect(user.rows[0].external_subject).toBeNull();
    expect(user.rows[0].state).toBe('DELETED');
    expect(user.rows[0].anonymised_at).not.toBeNull();

    // What was only about them is gone.
    expect((await pool.query('SELECT 1 FROM student_profiles WHERE user_id = $1', [subjectId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM student_document_metadata WHERE student_user_id = $1', [subjectId])).rows).toHaveLength(0);
    // The career role they chose is erased with them; another person's choice is untouched.
    expect((await pool.query('SELECT 1 FROM student_career_targets WHERE student_user_id = $1', [subjectId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT 1 FROM student_career_targets WHERE student_user_id = $1', [opsId])).rows).toHaveLength(1);

    // What the export gap audit found left behind (privacy-export-coverage.md), each the subject's only;
    // the other candidate's copy of every one is untouched.
    const rowsOf = async (query: string, userId: string): Promise<number> => (await pool.query(query, [userId])).rows.length;
    for (const query of [
      'SELECT 1 FROM user_notifications WHERE user_id = $1',
      'SELECT 1 FROM device_push_tokens WHERE user_id = $1',
      'SELECT 1 FROM external_applications WHERE student_user_id = $1',
      'SELECT 1 FROM career_gap_snapshots WHERE student_user_id = $1',
      'SELECT 1 FROM career_gap_items i JOIN career_gap_snapshots g ON g.id = i.snapshot_id WHERE g.student_user_id = $1',
      'SELECT 1 FROM student_qualifications WHERE student_user_id = $1',
      'SELECT 1 FROM student_academic_terms t JOIN student_qualifications q ON q.id = t.qualification_id WHERE q.student_user_id = $1',
      'SELECT 1 FROM public_profile_links WHERE student_user_id = $1',
      'SELECT 1 FROM student_profile_photos WHERE student_user_id = $1',
    ]) {
      expect(await rowsOf(query, subjectId), query).toBe(0);
      expect(await rowsOf(query, otherCandidateId), query).toBe(1);
    }
    expect(await rowsOf('SELECT 1 FROM student_academic_subjects s JOIN student_academic_terms t ON t.id = s.term_id JOIN student_qualifications q ON q.id = t.qualification_id WHERE q.student_user_id = $1', otherCandidateId)).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM student_academic_subjects')).rows[0].count).toBe(1);
    // The photo's bytes go with its row; the other person's stay.
    await expect(storage.get(subjectRecords.photoKey)).rejects.toThrow();
    expect((await storage.get(otherRecords.photoKey)).toString()).toBe('Othermark photo bytes');
    // The college's invitation no longer carries the person's address.
    expect((await pool.query('SELECT email FROM invitations WHERE student_user_id = $1', [subjectId])).rows).toEqual([{ email: expect.stringMatching(/@deleted\.invalid$/) }]);
    expect((await pool.query('SELECT email FROM invitations WHERE student_user_id = $1', [otherCandidateId])).rows).toEqual([{ email: 'othermark.invite@uat.test' }]);
    // The verification action survives (decision 3 in the design) without its link to the erased document,
    // which is what made this deletion end FAILED before.
    expect((await pool.query('SELECT evidence_document_version_id FROM staff_actions WHERE id = $1', [subjectRecords.verificationActionId])).rows[0].evidence_document_version_id).toBeNull();
    expect((await pool.query('SELECT evidence_document_version_id FROM staff_actions WHERE id = $1', [otherRecords.verificationActionId])).rows[0].evidence_document_version_id).toBe(otherRecords.documentVersionId);

    // Engine behavioural data is erased (ENG-03) -- the subject's only; the other
    // person's attempt log is untouched.
    const learning = async (table: string, column: string, userId: string): Promise<number> =>
      (await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`, [userId])).rows[0].count;
    expect(await learning('learning_attempt_events', 'subject_user_id', subjectId)).toBe(0);
    expect(await learning('learning_sessions', 'subject_user_id', subjectId)).toBe(0);
    expect(await learning('learner_activity_events', 'user_id', subjectId)).toBe(0);
    expect(await learning('learning_attempt_events', 'subject_user_id', opsId)).toBe(1);
    expect(await learning('learning_sessions', 'subject_user_id', opsId)).toBe(1);
    expect(await learning('learner_activity_events', 'user_id', opsId)).toBe(1);
    // The skill state projection (ENG-05) is rebuilt from no facts, which erases it.
    expect(await learning('learner_skill_state', 'subject_user_id', subjectId)).toBe(0);
    expect(await learning('learner_skill_state', 'subject_user_id', opsId)).toBe(1);
    // The planner's decisions (ENG-08) are engine behavioural data too.
    expect(await learning('learning_decisions', 'subject_user_id', subjectId)).toBe(0);
    expect(await learning('learning_decisions', 'subject_user_id', opsId)).toBe(1);

    // What the employer lawfully holds survives, detached from the person.
    const applications = await pool.query('SELECT state FROM applications WHERE student_user_id = $1', [subjectId]);
    expect(applications.rows).toHaveLength(1);
    expect(applications.rows[0].state).toBe('APPLIED');

    // Employer screening (EMP-12): the attempt and its score survive with the anonymised person;
    // what they chose is erased, and the employer's per-question marking stays consistent with the score.
    const attempt = await pool.query('SELECT candidate_user_id, state, score, max_score, percentage, submitted_at FROM employer_assessment_attempts WHERE id = $1', [subjectSubmittedAttemptId]);
    expect(attempt.rows[0]).toMatchObject({ candidate_user_id: subjectId, state: 'SUBMITTED', score: '1.00', max_score: '2.00', percentage: '50.00' });
    expect(attempt.rows[0].submitted_at).not.toBeNull();
    const answers = await pool.query(
      `SELECT selected_option_keys, numeric_response, is_correct, marks_awarded FROM employer_assessment_answers
       WHERE attempt_id = $1 ORDER BY marks_awarded DESC`, [subjectSubmittedAttemptId]);
    expect(answers.rows).toEqual([
      { selected_option_keys: [], numeric_response: null, is_correct: true, marks_awarded: '1.00' },
      { selected_option_keys: [], numeric_response: null, is_correct: false, marks_awarded: '0.00' },
    ]);
    expect((await pool.query('SELECT count(*)::int AS count FROM employer_assessment_attempt_questions WHERE attempt_id = $1', [subjectSubmittedAttemptId])).rows[0].count).toBe(2);
    // A sitting still open at deletion ends unscored, rather than being graded later from erased answers.
    const open = await pool.query('SELECT state, score, submitted_at FROM employer_assessment_attempts WHERE id = $1', [subjectOpenAttemptId]);
    expect(open.rows[0]).toEqual({ state: 'EXPIRED', score: null, submitted_at: null });
    expect((await pool.query('SELECT state FROM employer_assessment_invitations WHERE id = $1', [subjectOpenInvitationId])).rows[0].state).toBe('EXPIRED');
    expect((await pool.query('SELECT count(*)::int AS count FROM employer_assessment_answers WHERE attempt_id = $1 AND cardinality(selected_option_keys) > 0', [subjectOpenAttemptId])).rows[0].count).toBe(0);
    // Another candidate's attempt is untouched.
    const other = await pool.query('SELECT selected_option_keys FROM employer_assessment_answers WHERE attempt_id = $1 ORDER BY marks_awarded DESC', [otherAttemptId]);
    expect(other.rows.map((row) => row.selected_option_keys)).toEqual([['A'], ['B']]);
    expect((await pool.query('SELECT state, percentage FROM employer_assessment_attempts WHERE id = $1', [otherAttemptId])).rows[0]).toEqual({ state: 'SUBMITTED', percentage: '50.00' });
  });

  it('records what it erased, anonymised and retained', async () => {
    const records = await pool.query(
      `SELECT category, disposition, basis, record_count FROM privacy_deletion_records
       WHERE request_id = $1 ORDER BY category`, [dueId],
    );
    // EMP-10 added APPLICATION_MESSAGES and the EMP-12 privacy fix EMPLOYER_SCREENING: one record per
    // declared category, 14 in all.
    expect(records.rows).toHaveLength(14);
    const byCategory = Object.fromEntries(records.rows.map((r) => [r.category, r]));
    // The subject's two screening attempts: kept for the employer, detached, answers erased.
    expect(byCategory.EMPLOYER_SCREENING.disposition).toBe('ANONYMISED');
    expect(byCategory.EMPLOYER_SCREENING.record_count).toBe(2);
    expect(byCategory.EMPLOYER_SCREENING.basis).toMatch(/answers are erased/i);
    expect(byCategory.APPLICATION_MESSAGES.disposition).toBe('ERASED');
    // INST-11: counselling notes about the person are erased with them.
    expect(byCategory.COUNSELLING_NOTES.disposition).toBe('ERASED');
    expect(byCategory.SUPPORT_CASES.disposition).toBe('ANONYMISED');
    expect(byCategory.LEARNING_ACTIVITY.disposition).toBe('ERASED');
    // The first seed: one attempt, one session, one activity event, one skill state row and one planner
    // decision. The coverage seed adds a practice step (decision, session, served item), a placement
    // sitting (test, session) and three lecturer actions (assignment, next step, session invitation): 13.
    expect(byCategory.LEARNING_ACTIVITY.record_count).toBe(13);
    expect(byCategory.AUDIT.disposition).toBe('RETAINED');
    expect(byCategory.AUDIT.basis).toBeTruthy();
    expect(byCategory.APPLICATIONS.disposition).toBe('ANONYMISED');
    expect(byCategory.STUDENT_PROFILE.disposition).toBe('ERASED');
    // Everything kept must say why.
    for (const row of records.rows) {
      if (row.disposition !== 'ERASED') expect(row.basis, `${row.category} must state a basis`).toBeTruthy();
    }
  });

  it('is safe to run again', async () => {
    const summaries = await executeDueDeletions({ db, ids, storage });
    expect(summaries).toHaveLength(0);
    const user = await pool.query('SELECT email FROM users WHERE id = $1', [subjectId]);
    expect(user.rows[0].email).toMatch(/@deleted\.invalid$/);
  });
});

async function applyMigrations(targetPool: Pool): Promise<void> {
  const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const migrationName of migrations) {
    const migration = (await readFile(new URL(migrationName, migrationDir), 'utf8'))
      .replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
    await targetPool.query(migration);
  }
}

function signAccessToken(signingKey: KeyObject, input: { readonly sub: string; readonly email: string }): string {
  const header = base64UrlJson({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const payload = base64UrlJson({
    iss: issuer, sub: input.sub, client_id: clientId, token_use: 'access',
    exp: Math.floor(new Date('2026-08-16T13:00:00Z').getTime() / 1000),
    iat: Math.floor(new Date('2026-08-16T11:00:00Z').getTime() / 1000),
    email: input.email, email_verified: true,
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(signingKey).toString('base64url')}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function publicKeyToTrustedJwk(key: KeyObject, kid: string): TrustedJwk {
  const jwk = key.export({ format: 'jwk' }) as JsonWebKey;
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new Error('invalid test key');
  return { kty: 'RSA', kid, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' };
}
