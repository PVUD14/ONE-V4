import 'reflect-metadata';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
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

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for assessment engine integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-exam-test-client';
const keyId = 'exam-test-key';
const schemaName = `exams_${process.pid}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});

let adminPool: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;

let institutionId: string;
let rivalInstitutionId: string;
let staffToken: string;
let rivalStaffToken: string;
let studentToken: string;
let studentUserId: string;
let studentProfileId: string;

// Built up across the ordered flow below.
let subjectId = '';
const questionIds: string[] = [];
const correctTextByQuestion = new Map<string, string>();
let examId = '';
let attemptId = '';

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
  db = drizzle(pool, { schema });
  await applyMigrations(pool);

  const identityStore = {
    findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
    loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({ verifier, identityStore, db })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  institutionId = await seedOrg('INSTITUTION', 'ABC Engineering College');
  rivalInstitutionId = await seedOrg('INSTITUTION', 'Rival College');

  const staffSub = `sub:${randomUUID()}`;
  const staffId = await seedUser('placement@exam.test', staffSub);
  await seedInstitutionMembership(staffId, institutionId, 'PLACEMENT_ADMIN');
  staffToken = signAccessToken(privateKey, { sub: staffSub, email: 'placement@exam.test' });

  const rivalSub = `sub:${randomUUID()}`;
  const rivalId = await seedUser('rival@exam.test', rivalSub);
  await seedInstitutionMembership(rivalId, rivalInstitutionId, 'PLACEMENT_ADMIN');
  rivalStaffToken = signAccessToken(privateKey, { sub: rivalSub, email: 'rival@exam.test' });

  const studentSub = `sub:${randomUUID()}`;
  studentUserId = await seedUser('aanya@exam.test', studentSub);
  studentProfileId = randomUUID();
  await pool.query(
    `INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status)
     VALUES ($1, $2, $3, 'EXM-001', 'Aanya Student', 'ACTIVE')`,
    [studentProfileId, institutionId, studentUserId],
  );
  studentToken = signAccessToken(privateKey, { sub: studentSub, email: 'aanya@exam.test' });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
});

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'x-correlation-id': `exam-test-${randomUUID()}` });

describe('assessment engine end to end', () => {
  it('lets institution staff create a subject, and refuses rival-institution staff', async () => {
    const created = await api().post(`/api/v1/institutions/${institutionId}/assessment-subjects`)
      .set(auth(staffToken)).send({ name: 'Data Structures' });
    expect(created.status).toBe(201);
    subjectId = created.body.subject.id;

    const rival = await api().get(`/api/v1/institutions/${institutionId}/assessment-subjects`).set(auth(rivalStaffToken));
    expect(rival.status).toBe(403);
  });

  it('drafts questions and governs their lifecycle to approval', async () => {
    for (let index = 0; index < 5; index += 1) {
      const correctText = `Correct answer ${index}`;
      const created = await api().post(`/api/v1/institutions/${institutionId}/assessment-questions`)
        .set(auth(staffToken))
        .send({
          subjectId,
          questionType: 'SINGLE_CHOICE_MCQ',
          questionText: `Question number ${index}: which option is right?`,
          difficulty: 'MEDIUM',
          marks: 1,
          options: [
            { key: 'A', text: correctText, isCorrect: true },
            { key: 'B', text: `Wrong ${index}-1`, isCorrect: false },
            { key: 'C', text: `Wrong ${index}-2`, isCorrect: false },
            { key: 'D', text: `Wrong ${index}-3`, isCorrect: false },
          ],
        });
      expect(created.status).toBe(201);
      const questionId = created.body.question.id as string;
      questionIds.push(questionId);
      correctTextByQuestion.set(questionId, correctText);

      // Illegal jump straight to APPROVED is refused; the governed path works.
      const jump = await api().post(`/api/v1/institutions/${institutionId}/assessment-questions/${questionId}/transition`)
        .set(auth(staffToken)).send({ toStatus: 'APPROVED' });
      expect(jump.status).toBe(400);
      for (const toStatus of ['UNDER_REVIEW', 'APPROVED']) {
        const moved = await api().post(`/api/v1/institutions/${institutionId}/assessment-questions/${questionId}/transition`)
          .set(auth(staffToken)).send({ toStatus });
        expect(moved.status).toBe(201);
      }
    }
  });

  it('creates, publishes and assigns a blueprint assessment', async () => {
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const created = await api().post(`/api/v1/institutions/${institutionId}/assessments`)
      .set(auth(staffToken))
      .send({
        subjectId,
        title: 'Unit Test 1 - Arrays',
        assessmentKind: 'UNIT_TEST',
        startsAt, endsAt,
        durationSeconds: 600,
        attemptsAllowed: 1,
        totalMarks: 3,
        sections: [{ title: 'Section A', poolSize: 5, displayCount: 3, marksPerQuestion: 1, negativeMarks: 0, questionIds }],
      });
    expect(created.status).toBe(201);
    examId = created.body.assessment.id;

    const published = await api().post(`/api/v1/institutions/${institutionId}/assessments/${examId}/publish`).set(auth(staffToken));
    expect(published.status).toBe(201);
    expect(published.body.assessment.lifecycleState).toBe('PUBLISHED');

    const assigned = await api().post(`/api/v1/institutions/${institutionId}/assessments/${examId}/assignments`)
      .set(auth(staffToken)).send({ studentProfileIds: [studentProfileId] });
    expect(assigned.status).toBe(201);
    expect(assigned.body.assignment.newlyAssigned).toBe(1);
  });

  it('shows the assigned assessment to the student and starts a leak-free paper', async () => {
    const listed = await api().get('/api/v1/student/assessments').set(auth(studentToken));
    expect(listed.status).toBe(200);
    expect(listed.body.assessments).toHaveLength(1);
    expect(listed.body.assessments[0].title).toBe('Unit Test 1 - Arrays');

    const started = await api().post(`/api/v1/student/assessments/${examId}/attempts`).set(auth(studentToken));
    expect(started.status).toBe(201);
    attemptId = started.body.attempt.id;
    expect(started.body.attempt.questions).toHaveLength(3);
    expect(started.body.attempt.remainingSeconds).toBeGreaterThan(500);
    // The paper must never carry the answer key.
    expect(JSON.stringify(started.body)).not.toContain('isCorrect');
    expect(JSON.stringify(started.body)).not.toContain('acceptedAnswers');

    // Starting again resumes the same attempt with the same paper.
    const resumed = await api().post(`/api/v1/student/assessments/${examId}/attempts`).set(auth(studentToken));
    expect(resumed.body.attempt.id).toBe(attemptId);
    expect(resumed.body.attempt.questions.map((question: { questionId: string }) => question.questionId))
      .toEqual(started.body.attempt.questions.map((question: { questionId: string }) => question.questionId));
  });

  it('grades a submitted attempt on the server against original keys', async () => {
    const paper = await api().get(`/api/v1/student/assessment-attempts/${attemptId}`).set(auth(studentToken));
    const questions = paper.body.attempt.questions as {
      questionId: string; options: { key: string; text: string }[];
    }[];

    // Answer the first two correctly (by matching the known correct text through
    // the shuffled display options) and the third deliberately wrong.
    for (const [index, question] of questions.entries()) {
      const correctText = correctTextByQuestion.get(question.questionId);
      const correctDisplayKey = question.options.find((option) => option.text === correctText)?.key;
      const wrongDisplayKey = question.options.find((option) => option.text !== correctText)?.key;
      const chosen = index < 2 ? correctDisplayKey : wrongDisplayKey;
      const saved = await api().post(`/api/v1/student/assessment-attempts/${attemptId}/answers`)
        .set(auth(studentToken)).send({ questionId: question.questionId, response: { selectedOptionKeys: [chosen] } });
      expect(saved.status).toBe(201);
    }

    const submitted = await api().post(`/api/v1/student/assessment-attempts/${attemptId}/submit`).set(auth(studentToken));
    expect(submitted.status).toBe(201);
    expect(submitted.body.result).toEqual({ score: 2, maxScore: 3, percentage: 66.67, correct: 2, wrong: 1, notAttempted: 0 });

    // A second submit of the same attempt is refused, and the attempt limit blocks a new one.
    const again = await api().post(`/api/v1/student/assessment-attempts/${attemptId}/submit`).set(auth(studentToken));
    expect(again.status).toBe(400);
    const newAttempt = await api().post(`/api/v1/student/assessments/${examId}/attempts`).set(auth(studentToken));
    expect(newAttempt.status).toBe(400);
  });

  it('reports results to institution staff with integrity signals', async () => {
    const results = await api().get(`/api/v1/institutions/${institutionId}/assessments/${examId}/results`).set(auth(staffToken));
    expect(results.status).toBe(200);
    expect(results.body.summary.attempts).toBe(1);
    expect(results.body.results[0].studentName).toBe('Aanya Student');
    expect(results.body.results[0].percentage).toBe(66.67);
    expect(results.body.results[0].autoSubmitted).toBe(false);
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

async function seedUser(email: string, externalSubject: string): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject, email, state: 'ACTIVE' });
  return id;
}

async function seedOrg(kind: 'PLATFORM' | 'INSTITUTION' | 'EMPLOYER', legalName: string): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.organizations).values({ id, kind, legalName, verificationState: 'VERIFIED' });
  return id;
}

async function seedInstitutionMembership(userId: string, organizationId: string, role: 'PLACEMENT_ADMIN'): Promise<void> {
  await db.insert(schema.organizationMemberships).values({
    id: randomUUID(), organizationId, userId, role, state: 'ACTIVE',
    scopeOrganizationId: organizationId, scopeInstitutionId: organizationId,
  });
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

describe('not-attempted visibility and reopening', () => {
  it('lists assigned students who have not attempted', async () => {
    const lateSub = `sub:${randomUUID()}`;
    const lateUserId = await seedUser('bala@exam.test', lateSub);
    const lateProfileId = randomUUID();
    await pool.query(
      `INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status)
       VALUES ($1, $2, $3, 'EXM-002', 'Bala Student', 'ACTIVE')`,
      [lateProfileId, institutionId, lateUserId],
    );
    const assigned = await api().post(`/api/v1/institutions/${institutionId}/assessments/${examId}/assignments`)
      .set(auth(staffToken)).send({ studentProfileIds: [lateProfileId] });
    expect(assigned.body.assignment.newlyAssigned).toBe(1);

    const results = await api().get(`/api/v1/institutions/${institutionId}/assessments/${examId}/results`).set(auth(staffToken));
    expect(results.body.summary.assigned).toBe(2);
    expect(results.body.summary.notAttemptedCount).toBe(1);
    expect(results.body.notAttempted[0]).toMatchObject({ studentName: 'Bala Student', institutionStudentId: 'EXM-002', inProgress: false });
  });

  it('reopening grants extra attempts so a finished student can retake', async () => {
    const blocked = await api().post(`/api/v1/student/assessments/${examId}/attempts`).set(auth(studentToken));
    expect(blocked.status).toBe(400);

    const reopened = await api().post(`/api/v1/institutions/${institutionId}/assessments/${examId}/reopen`)
      .set(auth(staffToken)).send({ extendMinutes: 30, extraAttempts: 1 });
    expect(reopened.status).toBe(201);
    expect(reopened.body.assessment.attemptsAllowed).toBe(2);

    const retake = await api().post(`/api/v1/student/assessments/${examId}/attempts`).set(auth(studentToken));
    expect(retake.status).toBe(201);
    expect(retake.body.attempt.attemptNumber).toBe(2);
  });
});

describe('stale attempts and duration changes', () => {
  it('expires a timed-out open attempt and starts a fresh full-length one', async () => {
    // Attempt 2 from the reopen test is open. Age it beyond its duration.
    await pool.query(
      `UPDATE exam_attempts SET started_at = now() - interval '2 hours'
       WHERE definition_id = $1 AND student_user_id = $2 AND status = 'IN_PROGRESS'`,
      [examId, studentUserId],
    );
    // One more allowance so a fresh attempt is possible after the stale one expires.
    await api().post(`/api/v1/institutions/${institutionId}/assessments/${examId}/reopen`)
      .set(auth(staffToken)).send({ extendMinutes: 30, extraAttempts: 1, durationMinutes: 45 });

    const started = await api().post(`/api/v1/student/assessments/${examId}/attempts`).set(auth(studentToken));
    expect(started.status).toBe(201);
    // Not the stale attempt: a brand-new paper with the new 45-minute clock.
    expect(started.body.attempt.attemptNumber).toBe(3);
    expect(started.body.attempt.durationSeconds).toBe(45 * 60);
    expect(started.body.attempt.remainingSeconds).toBeGreaterThan(29 * 60);

    // The stale attempt was auto-finalized with its own result row.
    const results = await api().get(`/api/v1/institutions/${institutionId}/assessments/${examId}/results`).set(auth(staffToken));
    const autoSubmitted = (results.body.results as { attemptNumber: number; autoSubmitted: boolean }[])
      .find((row) => row.attemptNumber === 2);
    expect(autoSubmitted?.autoSubmitted).toBe(true);
  });
});

describe('notifications backbone (mobile foundation)', () => {
  it('recorded exam-assigned, result and reopened notifications for the student', async () => {
    const inbox = await api().get('/api/v1/me/notifications').set(auth(studentToken));
    expect(inbox.status).toBe(200);
    const kinds = (inbox.body.notifications as { kind: string; title: string }[]).map((n) => n.kind);
    expect(kinds).toContain('EXAM_ASSIGNED');
    expect(kinds).toContain('RESULT_PUBLISHED');
    expect(kinds).toContain('EXAM_REOPENED');
    const assigned = (inbox.body.notifications as { kind: string; title: string }[]).find((n) => n.kind === 'EXAM_ASSIGNED');
    expect(assigned?.title).toContain('Unit Test 1 - Arrays');
    expect(inbox.body.unreadCount).toBeGreaterThan(0);
  });

  it('marks all notifications read, and keeps feeds tenant-private', async () => {
    const marked = await api().post('/api/v1/me/notifications/read-all').set(auth(studentToken));
    expect(marked.status).toBe(201);
    expect(marked.body.marked).toBeGreaterThan(0);
    const after = await api().get('/api/v1/me/notifications').set(auth(studentToken));
    expect(after.body.unreadCount).toBe(0);

    // Another user's feed does not leak this student's notifications.
    const rivalInbox = await api().get('/api/v1/me/notifications').set(auth(rivalStaffToken));
    const rivalKinds = (rivalInbox.body.notifications as { kind: string }[]).map((n) => n.kind);
    expect(rivalKinds).not.toContain('EXAM_ASSIGNED');
  });

  it('registers, refreshes and revokes a device push token', async () => {
    const token = `fcm-token-${randomUUID()}`;
    const registered = await api().post('/api/v1/me/devices').set(auth(studentToken))
      .send({ platform: 'ANDROID', token });
    expect(registered.status).toBe(201);
    expect(registered.body.registered).toBe(true);

    // Same token again is an idempotent refresh, not an error.
    const refreshed = await api().post('/api/v1/me/devices').set(auth(studentToken))
      .send({ platform: 'ANDROID', token });
    expect(refreshed.status).toBe(201);

    const revoked = await api().post('/api/v1/me/devices/revoke').set(auth(studentToken)).send({ token });
    expect(revoked.status).toBe(201);
    expect(revoked.body.revoked).toBe(1);

    const bad = await api().post('/api/v1/me/devices').set(auth(studentToken)).send({ platform: 'TV', token });
    expect(bad.status).toBe(400);
  });
});

describe('DPDP consent capture', () => {
  it('is dormant until a notice version is configured', async () => {
    delete process.env.CONSENT_PRIVACY_NOTICE_VERSION;
    const status = await api().get('/api/v1/me/consents/privacy-notice').set(auth(studentToken));
    expect(status.status).toBe(200);
    expect(status.body.required).toBe(false);
    expect(status.body.requiredVersion).toBeNull();
  });

  it('requires, records and clears consent for the configured version only', async () => {
    process.env.CONSENT_PRIVACY_NOTICE_VERSION = '2026-09-v1';
    try {
      const before = await api().get('/api/v1/me/consents/privacy-notice').set(auth(studentToken));
      expect(before.body.required).toBe(true);
      expect(before.body.requiredVersion).toBe('2026-09-v1');

      // Consent to a version the user was not shown is refused.
      const stale = await api().post('/api/v1/me/consents/privacy-notice').set(auth(studentToken))
        .send({ version: 'draft-0' });
      expect(stale.status).toBe(400);

      const granted = await api().post('/api/v1/me/consents/privacy-notice').set(auth(studentToken))
        .send({ version: '2026-09-v1' });
      expect(granted.status).toBe(201);
      expect(granted.body.granted).toBe(true);

      const after = await api().get('/api/v1/me/consents/privacy-notice').set(auth(studentToken));
      expect(after.body.required).toBe(false);
      expect(after.body.grantedVersion).toBe('2026-09-v1');

      // A new notice version re-arms the gate: consent is per version.
      process.env.CONSENT_PRIVACY_NOTICE_VERSION = '2026-12-v2';
      const rearmed = await api().get('/api/v1/me/consents/privacy-notice').set(auth(studentToken));
      expect(rearmed.body.required).toBe(true);
    } finally {
      delete process.env.CONSENT_PRIVACY_NOTICE_VERSION;
    }
  });
});
