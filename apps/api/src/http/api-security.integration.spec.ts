import 'reflect-metadata';
import { createHash, createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { createTrustedJwtVerifier, type TrustedJwk } from '@planthepath/identity/src/jwt.js';
import { digestInvitationToken } from '@planthepath/identity/src/invitation-token.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for API security integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-api-test-client';
const keyId = 'api-security-test-key';
const schemaName = `api_security_${process.pid}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const trustedJwk = publicKeyToTrustedJwk(publicKey, keyId);
const verifier = createTrustedJwtVerifier({ issuer, clientId, tokenUse: 'access', jwks: [trustedJwk], now: () => new Date('2026-08-16T12:00:00Z') });

let adminPool: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;

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
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE
      idempotency_records,
      outbox_events,
      audit_events,
      employer_applicant_access_grants,
      institution_relationships,
      invitations,
      organization_memberships,
      institution_units,
      organizations,
      users
    CASCADE
  `);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
});

describe('Phase 1 API protected request path', () => {
  it('denies missing and malformed bearer credentials without leaking internals', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/security/context').expect(401);

    expect(response.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Access denied', correlationId: expect.any(String) } });
    expect(JSON.stringify(response.body)).not.toContain('JWT');
  });

  it('requires authentication guards on every representative protected route', async () => {
    const institutionId = randomUUID();
    const employerId = randomUUID();
    const opportunityId = randomUUID();
    const studentUserId = randomUUID();

    await request(app.getHttpServer()).get('/api/v1/security/context').expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/institutions/${institutionId}/student-activity-access/${studentUserId}?activityAt=2026-08-16T00:00:00Z`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Idempotency-Key', 'guard-check-1')
      .send({ token: 'ValidInvitationToken_abcdefghijklmnopqrstuvwxyz012345' })
      .expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/employers/${employerId}/applicant-access/${opportunityId}/${studentUserId}`)
      .expect(401);
  });

  it('denies invalid signatures after parsing otherwise valid claims', async () => {
    const userId = await seedUser('active@example.test', 'sub:active');
    await seedMembership(userId, await seedOrg('INSTITUTION', 'College A'), 'INSTITUTION_ADMIN');
    const attackerKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const invalidToken = signAccessToken(attackerKey, { sub: 'sub:active', email: 'active@example.test' });

    await request(app.getHttpServer())
      .get('/api/v1/security/context')
      .set('Authorization', `Bearer ${invalidToken}`)
      .expect(401);
  });

  it('resolves current active internal identity and selected membership from persistence', async () => {
    const userId = await seedUser('member@example.test', 'sub:member');
    const institutionId = await seedOrg('INSTITUTION', 'College A');
    await seedMembership(userId, institutionId, 'INSTITUTION_ADMIN');

    const response = await request(app.getHttpServer())
      .get(`/api/v1/security/context?organizationId=${institutionId}`)
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:member', email: 'member@example.test' })}`)
      .expect(200);

    expect(response.body).toMatchObject({
      userId,
      selectedOrganizationId: institutionId,
      memberships: [expect.objectContaining({ organizationId: institutionId, role: 'INSTITUTION_ADMIN' })],
    });
  });

  it('denies valid provider tokens for suspended accounts and suspended memberships', async () => {
    await seedUser('suspended@example.test', 'sub:suspended', 'SUSPENDED');

    await request(app.getHttpServer())
      .get('/api/v1/security/context')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:suspended', email: 'suspended@example.test' })}`)
      .expect(403);

    const userId = await seedUser('member2@example.test', 'sub:member2');
    const institutionId = await seedOrg('INSTITUTION', 'College B');
    await seedMembership(userId, institutionId, 'INSTITUTION_ADMIN', 'SUSPENDED');

    await request(app.getHttpServer())
      .get(`/api/v1/security/context?organizationId=${institutionId}`)
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:member2', email: 'member2@example.test' })}`)
      .expect(403);
  });

  it('prevents institution tenant substitution on the request path', async () => {
    const staffUserId = await seedUser('staff@example.test', 'sub:staff');
    const studentUserId = await seedUser('student@example.test', 'sub:student');
    const institutionA = await seedOrg('INSTITUTION', 'College A');
    const institutionB = await seedOrg('INSTITUTION', 'College B');
    await seedMembership(staffUserId, institutionA, 'INSTITUTION_ADMIN');
    await db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId: institutionA,
      studentUserId,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const token = signAccessToken(privateKey, { sub: 'sub:staff', email: 'staff@example.test' });
    await request(app.getHttpServer())
      .get(`/api/v1/institutions/${institutionA}/student-activity-access/${studentUserId}?activityAt=2026-08-16T00:00:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/institutions/${institutionB}/student-activity-access/${studentUserId}?activityAt=2026-08-16T00:00:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('denies institution activity access for pending or ended relationships', async () => {
    const staffUserId = await seedUser('state-staff@example.test', 'sub:state-staff');
    const pendingStudentId = await seedUser('pending-student@example.test', 'sub:pending-student');
    const endedStudentId = await seedUser('ended-student@example.test', 'sub:ended-student');
    const institutionId = await seedOrg('INSTITUTION', 'College State');
    await seedMembership(staffUserId, institutionId, 'INSTITUTION_ADMIN');
    await db.insert(schema.institutionRelationships).values([
      {
        id: randomUUID(),
        institutionId,
        studentUserId: pendingStudentId,
        state: 'PENDING',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: randomUUID(),
        institutionId,
        studentUserId: endedStudentId,
        state: 'ENDED',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const token = signAccessToken(privateKey, { sub: 'sub:state-staff', email: 'state-staff@example.test' });
    await request(app.getHttpServer())
      .get(`/api/v1/institutions/${institutionId}/student-activity-access/${pendingStudentId}?activityAt=2026-08-16T00:00:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/api/v1/institutions/${institutionId}/student-activity-access/${endedStudentId}?activityAt=2026-08-16T00:00:00Z`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('accepts invitations only for the verified recipient and keeps raw tokens out of audit/outbox', async () => {
    const inviterId = await seedUser('inviter@example.test', 'sub:inviter');
    const institutionId = await seedOrg('INSTITUTION', 'College Invite');
    const rawToken = 'ValidInvitationToken_abcdefghijklmnopqrstuvwxyz012345';
    await db.insert(schema.invitations).values({
      id: randomUUID(),
      email: 'Student@Example.Test',
      tokenHash: digestInvitationToken(rawToken),
      state: 'PENDING',
      invitedByUserId: inviterId,
      organizationId: institutionId,
      role: 'INSTITUTION_ADMIN',
      scopeOrganizationId: institutionId,
      scopeInstitutionId: institutionId,
      expiresAt: new Date('2026-12-31T00:00:00Z'),
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:invitee', email: 'student@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'invite-accept-1')
      .send({ token: rawToken })
      .expect(201);

    expect(response.body).toMatchObject({ accepted: true, idempotentReplay: false, userId: expect.any(String) });

    const replay = await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:invitee', email: 'student@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'invite-accept-1')
      .send({ token: rawToken })
      .expect(201);
    expect(replay.body).toMatchObject({ accepted: true, idempotentReplay: true, userId: response.body.userId });

    const audit = await db.select().from(schema.auditEvents);
    const outbox = await db.select().from(schema.outboxEvents);
    const serializedSecurityRecords = JSON.stringify({ audit, outbox });
    expect(serializedSecurityRecords).not.toContain(rawToken);
    expect(serializedSecurityRecords).not.toContain(digestInvitationToken(rawToken));
  });

  it('denies wrong and unverified invitation recipients with generic authorization errors', async () => {
    const inviterId = await seedUser('inviter2@example.test', 'sub:inviter2');
    const rawToken = 'AnotherInvitationToken_abcdefghijklmnopqrstuvwxyz012345';
    await db.insert(schema.invitations).values({
      id: randomUUID(),
      email: 'victim@example.test',
      tokenHash: digestInvitationToken(rawToken),
      state: 'PENDING',
      invitedByUserId: inviterId,
      expiresAt: new Date('2026-12-31T00:00:00Z'),
    });

    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:attacker', email: 'attacker@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'wrong-recipient')
      .send({ token: rawToken })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:victim', email: 'victim@example.test', emailVerified: false })}`)
      .set('Idempotency-Key', 'unverified-recipient')
      .send({ token: rawToken })
      .expect(403);
  });

  it('enforces employer membership and active applicant grant on the request path', async () => {
    const recruiterUserId = await seedUser('recruiter@example.test', 'sub:recruiter');
    const studentUserId = await seedUser('applicant@example.test', 'sub:applicant');
    const employerId = await seedOrg('EMPLOYER', 'Employer A');
    const otherEmployerId = await seedOrg('EMPLOYER', 'Employer B');
    const opportunityId = randomUUID();
    await seedMembership(recruiterUserId, employerId, 'RECRUITER');
    await db.insert(schema.employerApplicantAccessGrants).values({
      id: randomUUID(),
      employerId,
      studentUserId,
      opportunityId,
      grantedAt: new Date('2026-08-01T00:00:00Z'),
      expiresAt: new Date('2026-12-31T00:00:00Z'),
    });

    const token = signAccessToken(privateKey, { sub: 'sub:recruiter', email: 'recruiter@example.test' });
    await request(app.getHttpServer())
      .get(`/api/v1/employers/${employerId}/applicant-access/${opportunityId}/${studentUserId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/employers/${otherEmployerId}/applicant-access/${opportunityId}/${studentUserId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    await db.update(schema.employerApplicantAccessGrants)
      .set({ revokedAt: new Date('2026-08-16T00:00:00Z') })
      .where(eq(schema.employerApplicantAccessGrants.employerId, employerId));

    await request(app.getHttpServer())
      .get(`/api/v1/employers/${employerId}/applicant-access/${opportunityId}/${studentUserId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
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

async function seedUser(email: string, externalSubject: string | null = `sub:${randomUUID()}`, state: 'INVITED' | 'ACTIVE' | 'SUSPENDED' = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject, email, state });
  return id;
}

async function seedOrg(kind: 'PLATFORM' | 'INSTITUTION' | 'EMPLOYER', legalName: string): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.organizations).values({ id, kind, legalName, verificationState: 'VERIFIED' });
  return id;
}

async function seedMembership(
  userId: string,
  organizationId: string,
  role: 'INSTITUTION_ADMIN' | 'RECRUITER',
  state: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
): Promise<void> {
  await db.insert(schema.organizationMemberships).values({
    id: randomUUID(),
    organizationId,
    userId,
    role,
    state,
    scopeOrganizationId: organizationId,
    ...(role === 'INSTITUTION_ADMIN' ? { scopeInstitutionId: organizationId } : { scopeEmployerId: organizationId }),
  });
}

function signAccessToken(signingKey: KeyObject, input: { readonly sub: string; readonly email: string; readonly emailVerified?: boolean }): string {
  const header = base64UrlJson({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const payload = base64UrlJson({
    iss: issuer,
    sub: input.sub,
    client_id: clientId,
    token_use: 'access',
    exp: Math.floor(new Date('2026-08-16T13:00:00Z').getTime() / 1000),
    iat: Math.floor(new Date('2026-08-16T11:00:00Z').getTime() / 1000),
    email: input.email,
    email_verified: input.emailVerified ?? true,
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
