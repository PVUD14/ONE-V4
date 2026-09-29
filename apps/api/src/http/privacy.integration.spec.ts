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
  await pool.query(`INSERT INTO student_document_metadata (id, student_user_id, title, document_type) VALUES ($1, $2, 'My CV', 'RESUME')`, [randomUUID(), subjectId]);
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
    expect(kept.rows[0].count).toBe(1);
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
    // One attempt, one session, one activity event, one skill state row and one planner decision were erased.
    expect(byCategory.LEARNING_ACTIVITY.record_count).toBe(5);
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
