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
if (!connectionString) throw new Error('DATABASE_URL is required for hiring integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-hiring-test-client';
const keyId = 'hiring-test-key';
const schemaName = `hiring_${process.pid}`;
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

// Seeded identities
let employerId: string;
let rivalEmployerId: string;
let institutionId: string;
let recruiterToken: string;
let rivalRecruiterToken: string;
let studentToken: string;
let studentUserId: string;
let outsiderToken: string;

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

  employerId = await seedOrg('EMPLOYER', 'Aster Mobility');
  rivalEmployerId = await seedOrg('EMPLOYER', 'Rival Robotics');
  institutionId = await seedOrg('INSTITUTION', 'ABC Engineering College');

  const recruiterSub = `sub:${randomUUID()}`;
  const recruiterId = await seedUser('recruiter@hiring.test', recruiterSub);
  await seedMembership(recruiterId, employerId, 'RECRUITER');
  recruiterToken = signAccessToken(privateKey, { sub: recruiterSub, email: 'recruiter@hiring.test' });

  const rivalSub = `sub:${randomUUID()}`;
  const rivalId = await seedUser('rival@hiring.test', rivalSub);
  await seedMembership(rivalId, rivalEmployerId, 'RECRUITER');
  rivalRecruiterToken = signAccessToken(privateKey, { sub: rivalSub, email: 'rival@hiring.test' });

  const studentSub = `sub:${randomUUID()}`;
  studentUserId = await seedUser('aanya@hiring.test', studentSub);
  await seedRelationship(studentUserId, institutionId);
  studentToken = signAccessToken(privateKey, { sub: studentSub, email: 'aanya@hiring.test' });

  const outsiderSub = `sub:${randomUUID()}`;
  await seedUser('outsider@hiring.test', outsiderSub);
  outsiderToken = signAccessToken(privateKey, { sub: outsiderSub, email: 'outsider@hiring.test' });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
});

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'x-correlation-id': `hiring-test-${randomUUID()}` });

describe('hiring lifecycle', () => {
  let opportunityId: string;
  let applicationId: string;
  let interviewId: string;
  let offerId: string;

  it('lets a recruiter create a draft opportunity', async () => {
    const response = await api().post(`/api/v1/employers/${employerId}/opportunities`).set(auth(recruiterToken)).send({
      referenceCode: 'SOC-2026-01',
      title: 'SOC Analyst Intern',
      employmentType: 'INTERNSHIP',
      workMode: 'ONSITE',
      locationCity: 'Bengaluru',
      durationMonths: 6,
      compensationDisclosed: true,
      compensationCurrency: 'INR',
      compensationMin: 25000,
      compensationPeriod: 'MONTH',
    }).expect(201);
    opportunityId = response.body.opportunity.id;
    expect(response.body.opportunity.lifecycleState).toBe('DRAFT');
  });

  it('refuses to publish an opportunity that would reach nobody', async () => {
    const response = await api().post(`/api/v1/employers/${employerId}/opportunities/${opportunityId}/publish`).set(auth(recruiterToken)).expect(400);
    expect(response.body.error.code).toBe('AUDIENCE_REQUIRED');
  });

  it('publishes once an audience exists', async () => {
    await api().post(`/api/v1/employers/${employerId}/opportunities/${opportunityId}/audiences`).set(auth(recruiterToken)).send({ audienceKind: 'PUBLIC' }).expect(201);
    const response = await api().post(`/api/v1/employers/${employerId}/opportunities/${opportunityId}/publish`).set(auth(recruiterToken)).expect(201);
    expect(response.body.opportunity.lifecycleState).toBe('PUBLISHED');
  });

  it('does not let a rival employer touch the opportunity', async () => {
    await api().post(`/api/v1/employers/${employerId}/opportunities/${opportunityId}/publish`).set(auth(rivalRecruiterToken)).expect(403);
    await api().get(`/api/v1/employers/${employerId}/opportunities`).set(auth(rivalRecruiterToken)).expect(403);
  });

  it('shows the published opportunity to a student', async () => {
    const response = await api().get('/api/v1/opportunities').set(auth(studentToken)).expect(200);
    const found = response.body.opportunities.find((o: { id: string }) => o.id === opportunityId);
    expect(found).toBeDefined();
    expect(found.employerName).toBe('Aster Mobility');
    expect(found.compensation.currency).toBe('INR');
  });

  it('refuses to apply without explicit consent', async () => {
    const response = await api().post('/api/v1/students/me/applications').set(auth(studentToken))
      .send({ opportunityId, consentGranted: false }).expect(400);
    expect(response.body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('accepts an application with consent and grants scoped employer access', async () => {
    const response = await api().post('/api/v1/students/me/applications').set(auth(studentToken))
      .send({ opportunityId, consentGranted: true }).expect(201);
    applicationId = response.body.application.id;
    expect(response.body.application.state).toBe('APPLIED');

    const grants = await pool.query('SELECT employer_id, revoked_at FROM employer_applicant_access_grants WHERE student_user_id = $1', [studentUserId]);
    expect(grants.rows).toHaveLength(1);
    expect(grants.rows[0].employer_id).toBe(employerId);
    expect(grants.rows[0].revoked_at).toBeNull();
  });

  it('refuses a duplicate application', async () => {
    const response = await api().post('/api/v1/students/me/applications').set(auth(studentToken))
      .send({ opportunityId, consentGranted: true }).expect(400);
    expect(response.body.error.code).toBe('ALREADY_APPLIED');
  });

  it('shows the applicant to the owning employer only', async () => {
    const mine = await api().get(`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications`).set(auth(recruiterToken)).expect(200);
    expect(mine.body.applications).toHaveLength(1);
    expect(mine.body.applications[0].candidateEmail).toBe('aanya@hiring.test');

    await api().get(`/api/v1/employers/${rivalEmployerId}/opportunities/${opportunityId}/applications`).set(auth(rivalRecruiterToken)).expect(403);
  });

  it('refuses a backward pipeline move', async () => {
    await api().post(`/api/v1/employers/${employerId}/applications/${applicationId}/transition`).set(auth(recruiterToken)).send({ toState: 'SHORTLISTED' }).expect(201);
    const response = await api().post(`/api/v1/employers/${employerId}/applications/${applicationId}/transition`).set(auth(recruiterToken)).send({ toState: 'SCREENING' }).expect(400);
    expect(response.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('schedules an interview and records a scorecard', async () => {
    await api().post(`/api/v1/employers/${employerId}/applications/${applicationId}/transition`).set(auth(recruiterToken)).send({ toState: 'INTERVIEW' }).expect(201);

    const scheduled = await api().post(`/api/v1/employers/${employerId}/applications/${applicationId}/interviews`).set(auth(recruiterToken)).send({
      mode: 'VIDEO',
      scheduledStart: '2026-09-01T09:00:00.000Z',
      scheduledEnd: '2026-09-01T10:00:00.000Z',
      joiningLink: 'https://meet.example.test/abc',
    }).expect(201);
    interviewId = scheduled.body.interview.id;
    expect(scheduled.body.interview.roundNumber).toBe(1);

    await api().post(`/api/v1/employers/${employerId}/interviews/${interviewId}/outcome`).set(auth(recruiterToken))
      .send({ recommendation: 'YES', overallRating: 4, strengths: 'Strong fundamentals' }).expect(201);

    const outcomes = await pool.query('SELECT recommendation, overall_rating FROM interview_outcomes WHERE interview_id = $1', [interviewId]);
    expect(outcomes.rows).toHaveLength(1);
    expect(outcomes.rows[0].recommendation).toBe('YES');

    const listed = await api().get(`/api/v1/employers/${employerId}/interviews`).set(auth(recruiterToken)).expect(200);
    expect(listed.body.interviews).toHaveLength(1);
    expect(listed.body.interviews[0]).toMatchObject({
      id: interviewId,
      applicationId,
      applicationState: 'INTERVIEW',
      opportunityId,
      referenceCode: 'SOC-2026-01',
      title: 'SOC Analyst Intern',
      consentRevoked: false,
      candidateEmail: 'aanya@hiring.test',
      roundNumber: 1,
      mode: 'VIDEO',
      state: 'SCHEDULED',
      outcomeCount: 1,
    });
  });

  it('refuses to mark hired before an offer is accepted', async () => {
    await api().post(`/api/v1/employers/${employerId}/applications/${applicationId}/transition`).set(auth(recruiterToken)).send({ toState: 'OFFER' }).expect(201);
    const response = await api().post(`/api/v1/employers/${employerId}/applications/${applicationId}/transition`).set(auth(recruiterToken)).send({ toState: 'HIRED' }).expect(400);
    expect(response.body.error.code).toBe('OFFER_NOT_ACCEPTED');
  });

  it('extends an offer that only the candidate can accept', async () => {
    const extended = await api().post(`/api/v1/employers/${employerId}/applications/${applicationId}/offers`).set(auth(recruiterToken)).send({
      compensationCurrency: 'INR',
      compensationAmount: 28000,
      compensationPeriod: 'MONTH',
      offerExpiresAt: '2026-10-01T00:00:00.000Z',
    }).expect(201);
    offerId = extended.body.offer.id;
    expect(extended.body.offer.state).toBe('EXTENDED');

    const listed = await api().get('/api/v1/students/me/offers').set(auth(studentToken)).expect(200);
    expect(listed.body.offers).toHaveLength(1);
    expect(listed.body.offers[0].compensation.amount).toBe('28000.00');

    const employerOffers = await api().get(`/api/v1/employers/${employerId}/offers`).set(auth(recruiterToken)).expect(200);
    expect(employerOffers.body.offers).toHaveLength(1);
    expect(employerOffers.body.offers[0]).toMatchObject({
      id: offerId,
      applicationId,
      applicationState: 'OFFER',
      opportunityId,
      referenceCode: 'SOC-2026-01',
      title: 'SOC Analyst Intern',
      consentRevoked: false,
      candidateEmail: 'aanya@hiring.test',
      state: 'EXTENDED',
      compensation: { currency: 'INR', amount: '28000.00', period: 'MONTH' },
    });
  });

  it('does not let a rival employer list employer interview or offer records', async () => {
    await api().get(`/api/v1/employers/${employerId}/interviews`).set(auth(rivalRecruiterToken)).expect(403);
    await api().get(`/api/v1/employers/${employerId}/offers`).set(auth(rivalRecruiterToken)).expect(403);
  });

  it('lets the candidate accept, then the employer records the hire', async () => {
    const accepted = await api().post(`/api/v1/students/me/offers/${offerId}/respond`).set(auth(studentToken)).send({ decision: 'ACCEPT' }).expect(201);
    expect(accepted.body.offer.state).toBe('ACCEPTED');

    const hired = await api().post(`/api/v1/employers/${employerId}/applications/${applicationId}/transition`).set(auth(recruiterToken)).send({ toState: 'HIRED' }).expect(201);
    expect(hired.body.application.state).toBe('HIRED');
  });

  it('closes employer access once the application is closed', async () => {
    const grants = await pool.query('SELECT revoked_at FROM employer_applicant_access_grants WHERE student_user_id = $1', [studentUserId]);
    expect(grants.rows[0].revoked_at).not.toBeNull();
  });

  it('records the full transition trail', async () => {
    const history = await pool.query('SELECT from_state, to_state FROM application_state_history WHERE application_id = $1 ORDER BY occurred_at', [applicationId]);
    expect(history.rows.map((r) => r.to_state)).toEqual(['APPLIED', 'SHORTLISTED', 'INTERVIEW', 'OFFER', 'HIRED']);
    expect(history.rows[0].from_state).toBe('DRAFT');
  });

  it('treats a closed application as immutable', async () => {
    const response = await api().post(`/api/v1/students/me/applications/${applicationId}/withdraw`).set(auth(studentToken)).expect(400);
    expect(response.body.error.code).toBe('APPLICATION_CLOSED');
  });

  it('writes audit and outbox entries for the lifecycle', async () => {
    const audit = await pool.query("SELECT action FROM audit_events WHERE action LIKE 'application.%' OR action LIKE 'offer.%'");
    expect(audit.rows.map((r) => r.action)).toContain('application.submitted');
    expect(audit.rows.map((r) => r.action)).toContain('offer.accepted');
    const outbox = await pool.query("SELECT event_type FROM outbox_events WHERE aggregate_type IN ('application','offer','opportunity')");
    expect(outbox.rows.map((r) => r.event_type)).toContain('opportunity.published');
    expect(outbox.rows.map((r) => r.event_type)).toContain('application.submitted');
  });
});

describe('audience scoping', () => {
  it('hides an institution-scoped opportunity from a student with no relationship', async () => {
    const created = await api().post(`/api/v1/employers/${employerId}/opportunities`).set(auth(recruiterToken)).send({
      referenceCode: 'CAMPUS-2026-01',
      title: 'Campus Only Role',
      employmentType: 'FULL_TIME',
      workMode: 'REMOTE',
      compensationDisclosed: false,
    }).expect(201);
    const id = created.body.opportunity.id;
    await api().post(`/api/v1/employers/${employerId}/opportunities/${id}/audiences`).set(auth(recruiterToken))
      .send({ audienceKind: 'INSTITUTION', institutionId }).expect(201);
    await api().post(`/api/v1/employers/${employerId}/opportunities/${id}/publish`).set(auth(recruiterToken)).expect(201);

    const enrolled = await api().get('/api/v1/opportunities').set(auth(studentToken)).expect(200);
    expect(enrolled.body.opportunities.map((o: { id: string }) => o.id)).toContain(id);

    const outsider = await api().get('/api/v1/opportunities').set(auth(outsiderToken)).expect(200);
    expect(outsider.body.opportunities.map((o: { id: string }) => o.id)).not.toContain(id);
    await api().get(`/api/v1/opportunities/${id}`).set(auth(outsiderToken)).expect(403);
  });

  it('never surfaces an invite-only opportunity through discovery', async () => {
    const created = await api().post(`/api/v1/employers/${employerId}/opportunities`).set(auth(recruiterToken)).send({
      referenceCode: 'INVITE-2026-01',
      title: 'Invite Only Role',
      employmentType: 'FULL_TIME',
      workMode: 'REMOTE',
      compensationDisclosed: false,
    }).expect(201);
    const id = created.body.opportunity.id;
    await api().post(`/api/v1/employers/${employerId}/opportunities/${id}/audiences`).set(auth(recruiterToken))
      .send({ audienceKind: 'INVITE_ONLY' }).expect(201);
    await api().post(`/api/v1/employers/${employerId}/opportunities/${id}/publish`).set(auth(recruiterToken)).expect(201);

    const listed = await api().get('/api/v1/opportunities').set(auth(studentToken)).expect(200);
    expect(listed.body.opportunities.map((o: { id: string }) => o.id)).not.toContain(id);
  });
});

describe('withdrawal', () => {
  it('revokes employer access when a student withdraws', async () => {
    const created = await api().post(`/api/v1/employers/${employerId}/opportunities`).set(auth(recruiterToken)).send({
      referenceCode: 'WD-2026-01',
      title: 'Withdrawable Role',
      employmentType: 'FULL_TIME',
      workMode: 'REMOTE',
      compensationDisclosed: false,
    }).expect(201);
    const id = created.body.opportunity.id;
    await api().post(`/api/v1/employers/${employerId}/opportunities/${id}/audiences`).set(auth(recruiterToken)).send({ audienceKind: 'PUBLIC' }).expect(201);
    await api().post(`/api/v1/employers/${employerId}/opportunities/${id}/publish`).set(auth(recruiterToken)).expect(201);

    const applied = await api().post('/api/v1/students/me/applications').set(auth(studentToken)).send({ opportunityId: id, consentGranted: true }).expect(201);
    const withdrawnId = applied.body.application.id;
    await api().post(`/api/v1/employers/${employerId}/applications/${withdrawnId}/transition`).set(auth(recruiterToken)).send({ toState: 'INTERVIEW' }).expect(201);
    const interview = await api().post(`/api/v1/employers/${employerId}/applications/${withdrawnId}/interviews`).set(auth(recruiterToken)).send({
      mode: 'VIDEO',
      scheduledStart: '2026-09-08T09:00:00.000Z',
      scheduledEnd: '2026-09-08T10:00:00.000Z',
    }).expect(201);
    await api().post(`/api/v1/employers/${employerId}/applications/${withdrawnId}/transition`).set(auth(recruiterToken)).send({ toState: 'OFFER' }).expect(201);
    const offer = await api().post(`/api/v1/employers/${employerId}/applications/${withdrawnId}/offers`).set(auth(recruiterToken)).send({
      compensationCurrency: 'INR',
      compensationAmount: 30000,
      compensationPeriod: 'MONTH',
      offerExpiresAt: '2026-10-15T00:00:00.000Z',
    }).expect(201);

    const before = await pool.query('SELECT revoked_at FROM employer_applicant_access_grants WHERE student_user_id = $1 AND opportunity_id = $2', [studentUserId, id]);
    expect(before.rows[0].revoked_at).toBeNull();

    await api().post(`/api/v1/students/me/applications/${withdrawnId}/withdraw`).set(auth(studentToken)).send({ reason: 'Accepted another role' }).expect(201);

    const after = await pool.query('SELECT revoked_at FROM employer_applicant_access_grants WHERE student_user_id = $1 AND opportunity_id = $2', [studentUserId, id]);
    expect(after.rows[0].revoked_at).not.toBeNull();

    // The employer keeps the row so they stop scheduling, but loses the person.
    const applicants = await api().get(`/api/v1/employers/${employerId}/opportunities/${id}/applications`).set(auth(recruiterToken)).expect(200);
    const withdrawn = applicants.body.applications.find((a: { id: string }) => a.id === withdrawnId);
    expect(withdrawn.state).toBe('WITHDRAWN');
    expect(withdrawn.consentRevoked).toBe(true);
    expect(withdrawn.candidateEmail).toBeNull();
    expect(withdrawn.candidateName).toBeNull();

    const interviews = await api().get(`/api/v1/employers/${employerId}/interviews`).set(auth(recruiterToken)).expect(200);
    const withdrawnInterview = interviews.body.interviews.find((item: { id: string }) => item.id === interview.body.interview.id);
    expect(withdrawnInterview.applicationState).toBe('WITHDRAWN');
    expect(withdrawnInterview.consentRevoked).toBe(true);
    expect(withdrawnInterview.candidateEmail).toBeNull();
    expect(withdrawnInterview.candidateName).toBeNull();

    const offers = await api().get(`/api/v1/employers/${employerId}/offers`).set(auth(recruiterToken)).expect(200);
    const withdrawnOffer = offers.body.offers.find((item: { id: string }) => item.id === offer.body.offer.id);
    expect(withdrawnOffer.applicationState).toBe('WITHDRAWN');
    expect(withdrawnOffer.consentRevoked).toBe(true);
    expect(withdrawnOffer.candidateEmail).toBeNull();
    expect(withdrawnOffer.candidateName).toBeNull();
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

async function seedMembership(userId: string, organizationId: string, role: 'RECRUITER'): Promise<void> {
  await db.insert(schema.organizationMemberships).values({
    id: randomUUID(), organizationId, userId, role, state: 'ACTIVE',
    scopeOrganizationId: organizationId, scopeEmployerId: organizationId,
  });
}

async function seedRelationship(userId: string, institution: string): Promise<void> {
  await pool.query(
    `INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from)
     VALUES ($1, $2, $3, 'ACTIVE', now() - interval '30 days')`,
    [randomUUID(), institution, userId],
  );
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
