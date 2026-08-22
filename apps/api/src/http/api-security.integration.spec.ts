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
import { CareerReadinessController } from './career-readiness.controller.js';
import { PG_POOL } from '../persistence.provider.js';

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
const deliveredInvitations: { toEmail: string; textBody: string; invitationId: string }[] = [];

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
    imports: [Phase1ApiSecurityModule.register({ verifier, identityStore, db, invitationMailSink: {
      async send(input: { toEmail: string; textBody: string; invitationId: string }) {
        deliveredInvitations.push({ toEmail: input.toEmail, textBody: input.textBody, invitationId: input.invitationId });
        return { providerReference: `mailpit:${input.invitationId}` };
      },
    } })],
    controllers: [CareerReadinessController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

beforeEach(async () => {
  deliveredInvitations.length = 0;
  await pool.query(`
    TRUNCATE
      idempotency_records,
      notification_delivery_attempts,
      notification_commands,
      notification_templates,
      student_saved_opportunities,
      student_document_metadata,
      student_profiles,
      student_roster_import_rows,
      student_roster_imports,
      institution_student_profiles,
      organization_verification_events,
      organization_profiles,
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
    await request(app.getHttpServer()).get('/api/v1/career-readiness/me').expect(401);
    await request(app.getHttpServer()).post(`/api/v1/career-readiness/lessons/${studentUserId}/complete`).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/career-readiness/assessments/${opportunityId}/attempts`).expect(401);
    await request(app.getHttpServer()).post(`/api/v1/career-readiness/attempts/${opportunityId}/submit`).expect(401);
    await request(app.getHttpServer()).get('/api/v1/operations/career-readiness/imports').expect(401);
    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/career-readiness/reports?periodStart=2026-08-01&periodEnd=2026-08-31`)
      .expect(401);
  });

  it('serves only published public catalog fields without requiring identity', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/career-readiness/catalog').expect(200);
    expect(response.body).toMatchObject({ pilot: 'Career Readiness Fundamentals', modules: [], assessments: [] });
    expect(JSON.stringify(response.body)).not.toContain('correctOptionId');
    expect(JSON.stringify(response.body)).not.toContain('answer_hash');
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
    const studentUserId = await seedUser('student-context@example.test', 'sub:student-context');
    const institutionId = await seedOrg('INSTITUTION', 'College A');
    await seedMembership(userId, institutionId, 'INSTITUTION_ADMIN');
    await db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId,
      studentUserId,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/security/context?organizationId=${institutionId}`)
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:member', email: 'member@example.test' })}`)
      .expect(200);

    expect(response.body).toMatchObject({
      userId,
      selectedOrganizationId: institutionId,
      memberships: [expect.objectContaining({ organizationId: institutionId, role: 'INSTITUTION_ADMIN' })],
      studentRelationships: [],
    });

    const studentResponse = await request(app.getHttpServer())
      .get('/api/v1/security/context')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:student-context', email: 'student-context@example.test' })}`)
      .expect(200);

    expect(studentResponse.body).toMatchObject({
      userId: studentUserId,
      memberships: [],
      studentRelationships: [expect.objectContaining({ institutionId, state: 'ACTIVE' })],
    });
  });

  it('returns the current authenticated student profile from the verified principal only', async () => {
    const studentUserId = await seedUser('aanya.student@example.test', 'sub:aanya-student');
    const otherStudentUserId = await seedUser('other.student@example.test', 'sub:other-student');
    const institutionId = await seedOrg('INSTITUTION', 'Student College');
    const profileId = randomUUID();
    await db.insert(schema.institutionStudentProfiles).values({
      id: profileId,
      institutionId,
      studentUserId,
      institutionStudentId: 'UAT-S-001',
      fullName: 'Aanya Rao',
      status: 'ACTIVE',
    });
    await db.insert(schema.institutionStudentProfiles).values({
      id: randomUUID(),
      institutionId,
      studentUserId: otherStudentUserId,
      institutionStudentId: 'UAT-S-002',
      fullName: 'Other Student',
      status: 'ACTIVE',
    });
    await db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId,
      studentUserId,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    await db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId,
      studentUserId: otherStudentUserId,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/students/me?studentUserId=${otherStudentUserId}`)
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:aanya-student', email: 'aanya.student@example.test' })}`)
      .expect(200);

    expect(response.body.student).toMatchObject({
      userId: studentUserId,
      verifiedEmail: 'aanya.student@example.test',
      fullName: 'Aanya Rao',
      institutionStudentId: 'UAT-S-001',
      institutionId,
      academicStatus: 'ACTIVE',
    });
    expect(JSON.stringify(response.body)).not.toContain(otherStudentUserId);
    expect(JSON.stringify(response.body)).not.toContain('Other Student');
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

  it('allows Operations to create and verify organizations while denying institution admins', async () => {
    const platformId = await seedOrg('PLATFORM', 'PlanThePath Platform');
    const opsUserId = await seedUser('ops@example.test', 'sub:ops');
    await seedMembership(opsUserId, platformId, 'OPERATIONS_ADMIN');
    const institutionAdminId = await seedUser('inst-admin@example.test', 'sub:inst-admin');
    const existingInstitutionId = await seedOrg('INSTITUTION', 'Existing College');
    await seedMembership(institutionAdminId, existingInstitutionId, 'INSTITUTION_ADMIN');

    const opsToken = signAccessToken(privateKey, { sub: 'sub:ops', email: 'ops@example.test' });
    const response = await request(app.getHttpServer())
      .post('/api/v1/operations/organizations')
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ kind: 'INSTITUTION', legalName: 'API College', profile: { countryCode: 'IN', city: 'Pune', primaryContactEmail: 'admin@api-college.example' } })
      .expect(201);

    expect(response.body.organization).toMatchObject({ kind: 'INSTITUTION', legalName: 'API College', verificationState: 'PENDING' });
    const organizationId = response.body.organization.id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/operations/organizations/${organizationId}/verification`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ toState: 'UNDER_REVIEW', reasonCode: 'DOCS_READY' })
      .expect(201);

    const deniedToken = signAccessToken(privateKey, { sub: 'sub:inst-admin', email: 'inst-admin@example.test' });
    await request(app.getHttpServer())
      .post('/api/v1/operations/organizations')
      .set('Authorization', `Bearer ${deniedToken}`)
      .send({ kind: 'EMPLOYER', legalName: 'Denied Employer', profile: { countryCode: 'IN' } })
      .expect(403);
  });

  it('delivers initial administrator invitations without persisting or returning the raw token', async () => {
    const platformId = await seedOrg('PLATFORM', 'PlanThePath Platform');
    const opsUserId = await seedUser('ops-invite@example.test', 'sub:ops-invite');
    await seedMembership(opsUserId, platformId, 'OPERATIONS_ADMIN');
    const institutionId = await seedOrg('INSTITUTION', 'Invitation College');
    const institutionAdminId = await seedUser('not-ops@example.test', 'sub:not-ops');
    await seedMembership(institutionAdminId, institutionId, 'INSTITUTION_ADMIN');
    const opsToken = signAccessToken(privateKey, { sub: 'sub:ops-invite', email: 'ops-invite@example.test' });

    const inviteResponse = await request(app.getHttpServer())
      .post(`/api/v1/operations/organizations/${institutionId}/initial-admin-invitations`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ email: 'Initial.Admin@Example.Test' })
      .expect(201);

    expect(inviteResponse.body.invitation).toMatchObject({ email: 'initial.admin@example.test', role: 'INSTITUTION_ADMIN', tokenPreviewAvailable: false });
    expect(JSON.stringify(inviteResponse.body)).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    expect(deliveredInvitations).toHaveLength(1);
    expect(deliveredInvitations[0]).toMatchObject({ toEmail: 'initial.admin@example.test', invitationId: inviteResponse.body.invitation.id });
    const rawToken = new URL(deliveredInvitations[0]!.textBody.match(/https?:\/\/\S+/)?.[0] ?? '').searchParams.get('token');
    expect(rawToken).toBeTruthy();
    const rawNeedle = rawToken!;

    const persisted = await pool.query(`
      SELECT
        (SELECT jsonb_agg(to_jsonb(i)) FROM invitations i) AS invitations,
        (SELECT jsonb_agg(to_jsonb(a)) FROM audit_events a) AS audit,
        (SELECT jsonb_agg(to_jsonb(o)) FROM outbox_events o) AS outbox,
        (SELECT jsonb_agg(to_jsonb(n)) FROM notification_commands n) AS commands
    `);
    expect(JSON.stringify(persisted.rows[0])).not.toContain(rawNeedle);
    const invitation = await pool.query('SELECT token_hash FROM invitations WHERE id=$1', [inviteResponse.body.invitation.id]);
    expect(invitation.rows[0].token_hash).toBe(digestInvitationToken(rawNeedle));

    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:wrong-recipient', email: 'wrong@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'wrong-recipient-accept')
      .send({ token: rawNeedle })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:initial-admin', email: 'initial.admin@example.test', emailVerified: false })}`)
      .set('Idempotency-Key', 'unverified-recipient')
      .send({ token: rawNeedle })
      .expect(403);

    const accepted = await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:initial-admin', email: 'initial.admin@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'correct-recipient')
      .send({ token: rawNeedle })
      .expect(201);
    expect(accepted.body).toMatchObject({ accepted: true, idempotentReplay: false });

    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:initial-admin', email: 'initial.admin@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'correct-recipient')
      .send({ token: rawNeedle })
      .expect(201)
      .expect((response) => expect(response.body.idempotentReplay).toBe(true));

    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:initial-admin', email: 'initial.admin@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'replay-new-key')
      .send({ token: rawNeedle })
      .expect(403);

    const expiredToken = 'ExpiredInvitationToken_abcdefghijklmnopqrstuvwxyz012345';
    await db.insert(schema.invitations).values({
      id: randomUUID(),
      email: 'expired-admin@example.test',
      tokenHash: digestInvitationToken(expiredToken),
      state: 'PENDING',
      invitedByUserId: opsUserId,
      organizationId: institutionId,
      role: 'INSTITUTION_ADMIN',
      scopeOrganizationId: institutionId,
      scopeInstitutionId: institutionId,
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:expired-admin', email: 'expired-admin@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'expired-admin')
      .send({ token: expiredToken })
      .expect(403);

    const revokedToken = 'RevokedInvitationToken_abcdefghijklmnopqrstuvwxyz012345';
    await db.insert(schema.invitations).values({
      id: randomUUID(),
      email: 'revoked-admin@example.test',
      tokenHash: digestInvitationToken(revokedToken),
      state: 'REVOKED',
      invitedByUserId: opsUserId,
      organizationId: institutionId,
      role: 'INSTITUTION_ADMIN',
      scopeOrganizationId: institutionId,
      scopeInstitutionId: institutionId,
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      revokedAt: new Date('2026-08-16T00:00:00Z'),
    });
    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:revoked-admin', email: 'revoked-admin@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'revoked-admin')
      .send({ token: revokedToken })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/operations/organizations/${platformId}/initial-admin-invitations`)
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:not-ops', email: 'not-ops@example.test' })}`)
      .send({ email: 'other-admin@example.test' })
      .expect(403);
  });

  it('keeps student lifecycle under Institution Admin instead of Operations', async () => {
    const platformId = await seedOrg('PLATFORM', 'PlanThePath Platform');
    const opsUserId = await seedUser('ops-students@example.test', 'sub:ops-students');
    await seedMembership(opsUserId, platformId, 'OPERATIONS_ADMIN');
    const institutionId = await seedOrg('INSTITUTION', 'Student College');
    const adminUserId = await seedUser('student-admin@example.test', 'sub:student-admin');
    await seedMembership(adminUserId, institutionId, 'INSTITUTION_ADMIN');

    const opsToken = signAccessToken(privateKey, { sub: 'sub:ops-students', email: 'ops-students@example.test' });
    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ fullName: 'Denied Student', institutionStudentId: 'DENIED1', email: 'denied@student.example' })
      .expect(403);

    const adminToken = signAccessToken(privateKey, { sub: 'sub:student-admin', email: 'student-admin@example.test' });
    const addResponse = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Aanya Teststudent', institutionStudentId: 'S1001', email: 'aanya.student@example.test' })
      .expect(201);

    const profileId = addResponse.body.student.id as string;
    const initialRelationship = await pool.query<{ effective_from: Date }>(
      `SELECT ir.effective_from
       FROM institution_relationships ir
       JOIN institution_student_profiles sp ON sp.student_user_id=ir.student_user_id
       WHERE ir.institution_id=$1 AND sp.id=$2 AND ir.effective_to IS NULL`,
      [institutionId, profileId],
    );
    expect(initialRelationship.rows).toHaveLength(1);
    const effectiveFrom = initialRelationship.rows[0]!.effective_from;
    const invalidEffectiveTo = new Date(effectiveFrom);
    const effectiveTo = new Date(effectiveFrom.getTime() + 60 * 60 * 1000);

    await expect(
      pool.query(`UPDATE institution_relationships
                  SET effective_to=$1
                  WHERE institution_id=$2
                    AND student_user_id=(SELECT student_user_id FROM institution_student_profiles WHERE id=$3)`, [
        invalidEffectiveTo,
        institutionId,
        profileId,
      ]),
    ).rejects.toThrow(/institution_relationship_window_ck/);

    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students/${profileId}/relationship`)
      .set('Authorization', `Bearer ${opsToken}`)
      .send({ state: 'GRADUATED', effectiveTo: effectiveTo.toISOString() })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students/${profileId}/relationship`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ state: 'GRADUATED', effectiveTo: effectiveTo.toISOString() })
      .expect(201);

    const current = await pool.query<{ state: string; effective_from: Date; effective_to: Date }>(
      'SELECT state, effective_from, effective_to FROM institution_relationships WHERE institution_id=$1',
      [institutionId],
    );
    const currentRelationship = current.rows[0]!;
    expect(currentRelationship).toMatchObject({ state: 'GRADUATED' });
    expect(currentRelationship.effective_to.toISOString()).toBe(effectiveTo.toISOString());
    expect(currentRelationship.effective_to.getTime()).toBeGreaterThan(currentRelationship.effective_from.getTime());
    await expect(db.select().from(schema.users).where(eq(schema.users.email, 'aanya.student@example.test'))).resolves.toHaveLength(1);

    const duplicateStudentEmail = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Duplicate Email', institutionStudentId: 'S1002', email: 'aanya.student@example.test' })
      .expect(409);
    expect(duplicateStudentEmail.body.error).toMatchObject({ code: 'STUDENT_EMAIL_ALREADY_EXISTS', field: 'email' });
  });

  it('uses invitation consent instead of direct arbitrary-user staff role attachment', async () => {
    const institutionId = await seedOrg('INSTITUTION', 'Role College');
    const adminUserId = await seedUser('role-admin@example.test', 'sub:role-admin');
    const targetUserId = await seedUser('faculty@example.test', 'sub:faculty');
    await seedMembership(adminUserId, institutionId, 'INSTITUTION_ADMIN');
    const token = signAccessToken(privateKey, { sub: 'sub:role-admin', email: 'role-admin@example.test' });

    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'role-admin@example.test', role: 'DEPARTMENT_HEAD' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: targetUserId, email: 'faculty@example.test', role: 'FACULTY_LECTURER' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'faculty@example.test', role: 'OPERATIONS_ADMIN' })
      .expect(403);

    const invite = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'faculty@example.test', role: 'FACULTY_LECTURER' })
      .expect(201);
    expect(invite.body.invitation).toMatchObject({ email: 'faculty@example.test', role: 'FACULTY_LECTURER', tokenPreviewAvailable: false });
    const staffInventory = await request(app.getHttpServer())
      .get(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(staffInventory.body.staff.invitations).toHaveLength(1);
    expect(staffInventory.body.staff.invitations[0]).toMatchObject({ email: 'faculty@example.test', role: 'FACULTY_LECTURER', state: 'PENDING' });
    expect(JSON.stringify(staffInventory.body)).not.toContain('token');
    expect(JSON.stringify(staffInventory.body)).not.toContain('token_hash');
    await expect(db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, targetUserId))).resolves.toHaveLength(0);
    const rawToken = new URL(deliveredInvitations[0]!.textBody.match(/https?:\/\/\S+/)?.[0] ?? '').searchParams.get('token')!;
    await request(app.getHttpServer())
      .post('/api/v1/invitations/accept')
      .set('Authorization', `Bearer ${signAccessToken(privateKey, { sub: 'sub:faculty', email: 'faculty@example.test', emailVerified: true })}`)
      .set('Idempotency-Key', 'faculty-accept')
      .send({ token: rawToken })
      .expect(201);
    await expect(db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, targetUserId))).resolves.toHaveLength(1);

    const platformId = await seedOrg('PLATFORM', 'ONE Platform');
    const opsUserId = await seedUser('ops-governance@example.test', 'sub:ops-governance');
    await seedMembership(opsUserId, platformId, 'OPERATIONS_ADMIN');
    const opsToken = signAccessToken(privateKey, { sub: 'sub:ops-governance', email: 'ops-governance@example.test' });
    const usersAccess = await request(app.getHttpServer())
      .get('/api/v1/operations/users-access?q=faculty@example.test')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(usersAccess.body.users[0]).toMatchObject({ email: 'faculty@example.test', identityLinkStatus: 'LINKED' });
    expect(usersAccess.body.users[0].memberships[0]).toMatchObject({ role: 'FACULTY_LECTURER', state: 'ACTIVE', organizationId: institutionId });
    const invitations = await request(app.getHttpServer())
      .get('/api/v1/operations/invitations?q=faculty@example.test')
      .set('Authorization', `Bearer ${opsToken}`)
      .expect(200);
    expect(invitations.body.invitations[0]).toMatchObject({ recipientEmail: 'faculty@example.test', role: 'FACULTY_LECTURER' });
    const governanceJson = JSON.stringify({ usersAccess: usersAccess.body, invitations: invitations.body });
    expect(governanceJson).not.toContain(rawToken);
    expect(governanceJson).not.toContain('token_hash');
  });

  it('persists Student-owned profile, document metadata and saved opportunities only for the verified principal', async () => {
    const institutionId = await seedOrg('INSTITUTION', 'Student Ops College');
    const studentUserId = await seedUser('student.ops@example.test', 'sub:student-ops');
    const otherStudentUserId = await seedUser('other.student.ops@example.test', 'sub:other-student-ops');
    await db.insert(schema.institutionStudentProfiles).values({
      id: randomUUID(),
      institutionId,
      studentUserId,
      institutionStudentId: 'OPS-S-001',
      fullName: 'Student Ops',
      status: 'ACTIVE',
    });
    await db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId,
      studentUserId,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    });
    await db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId,
      studentUserId: otherStudentUserId,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    });
    const token = signAccessToken(privateKey, { sub: 'sub:student-ops', email: 'student.ops@example.test' });
    const otherToken = signAccessToken(privateKey, { sub: 'sub:other-student-ops', email: 'other.student.ops@example.test' });

    const profile = await request(app.getHttpServer())
      .patch('/api/v1/students/me/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        targetCareer: 'Security Analyst',
        careerInterests: ['SOC', 'Cloud Security'],
        profileHeadline: 'Entry-level security analyst',
        profileSummary: 'Interested in monitored, evidence-backed security work.',
        portfolioUrl: 'https://portfolio.example.test/student-ops',
        visibilityState: 'INSTITUTION_VISIBLE',
        employerDiscoveryEnabled: false,
        studentUserId: otherStudentUserId,
      })
      .expect(200);
    expect(profile.body.profile).toMatchObject({ userId: studentUserId, targetCareer: 'Security Analyst', verifiedEmail: 'student.ops@example.test' });

    const document = await request(app.getHttpServer())
      .post('/api/v1/students/me/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Resume v1', documentType: 'RESUME', description: 'Metadata only' })
      .expect(201);
    expect(document.body.document).toMatchObject({ title: 'Resume v1', documentType: 'RESUME', verificationState: 'SELF_REPORTED' });

    const saved = await request(app.getHttpServer())
      .post('/api/v1/students/me/saved-opportunities')
      .set('Authorization', `Bearer ${token}`)
      .send({ opportunityRef: 'uat-soc-intern', title: 'SOC Analyst Intern', organizationName: 'Secure Labs' })
      .expect(201);
    expect(saved.body.savedOpportunities).toHaveLength(1);
    expect(saved.body.savedOpportunities[0]).toMatchObject({ opportunityRef: 'uat-soc-intern', title: 'SOC Analyst Intern' });

    await request(app.getHttpServer())
      .patch(`/api/v1/students/me/documents/${document.body.document.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ title: 'Hijack', documentType: 'RESUME' })
      .expect(403);
    const otherList = await request(app.getHttpServer())
      .get('/api/v1/students/me/saved-opportunities')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    expect(otherList.body.savedOpportunities).toEqual([]);

    await request(app.getHttpServer())
      .delete(`/api/v1/students/me/documents/${document.body.document.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/api/v1/students/me/saved-opportunities/${saved.body.savedOpportunities[0].id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const audits = await pool.query("SELECT action FROM audit_events WHERE actor_user_id=$1 ORDER BY occurred_at", [studentUserId]);
    expect(audits.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      'student.profile.updated',
      'student.document_metadata.created',
      'student.document_metadata.archived',
      'student.saved_opportunity.saved',
      'student.saved_opportunity.archived',
    ]));
  });

  it('validates and commits roster CSV without raw preview mutation', async () => {
    const institutionId = await seedOrg('INSTITUTION', 'Import College');
    const otherInstitutionId = await seedOrg('INSTITUTION', 'Other Import College');
    const adminUserId = await seedUser('import-admin@example.test', 'sub:import-admin');
    await seedMembership(adminUserId, institutionId, 'INSTITUTION_ADMIN');
    const departmentId = randomUUID();
    const programId = randomUUID();
    const batchId = randomUUID();
    const sectionId = randomUUID();
    await db.insert(schema.institutionUnits).values([
      { id: departmentId, institutionId, kind: 'DEPARTMENT', name: 'CSE' },
      { id: programId, institutionId, kind: 'PROGRAM', name: 'BTech' },
      { id: batchId, institutionId, kind: 'BATCH', name: '2026' },
      { id: sectionId, institutionId, kind: 'SECTION', name: 'A' },
      { id: randomUUID(), institutionId: otherInstitutionId, kind: 'DEPARTMENT', name: 'ECE' },
    ]);
    const token = signAccessToken(privateKey, { sub: 'sub:import-admin', email: 'import-admin@example.test' });
    await seedUser('existing-import@example.test', 'sub:existing-import');
    await db.insert(schema.institutionStudentProfiles).values({
      id: randomUUID(),
      institutionId,
      studentUserId: await seedUser('existing-id@example.test', 'sub:existing-id'),
      institutionStudentId: 'S-EXISTS',
      fullName: 'Existing Id',
      status: 'ACTIVE',
    });

    const preview = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/student-imports`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'students.csv',
        csv: [
          'institution_student_id,full_name,email,department,program,batch,section',
          'S2001,Rohan Teststudent,rohan.student@example.test,CSE,BTech,2026,A',
          'S2002,Formula Guard,formula@example.test,=CMD,BTech,2026,A',
          'S2003,Existing Email,existing-import@example.test,CSE,BTech,2026,A',
          'S2004,Bad Email,not-an-email,CSE,BTech,2026,A',
          'S2004,Duplicate In File,duplicate-file@example.test,CSE,BTech,2026,A',
          'S-EXISTS,Duplicate Existing,dup-existing@example.test,CSE,BTech,2026,A',
          'S2005,Cross Institution,cross-unit@example.test,ECE,BTech,2026,A',
        ].join('\n'),
      })
      .expect(201);

    expect(preview.body.import.acceptedCount).toBe(1);
    expect(preview.body.import.rejectedCount).toBe(6);
    expect(preview.body.import.rows[0]).toMatchObject({ departmentUnitId: departmentId, programUnitId: programId, batchUnitId: batchId, sectionUnitId: sectionId });
    expect(preview.body.import.rows[1].issues).toContain('unknown_department');
    expect(preview.body.import.rows[2].issues).toContain('email_already_exists');
    expect(preview.body.import.rows[3].issues).toContain('malformed_email');
    expect(preview.body.import.rows[4].issues).toContain('duplicate_student_id_in_file');
    expect(preview.body.import.rows[5].issues).toContain('student_id_already_exists');
    expect(preview.body.import.rows[6].issues).toContain('unknown_department');
    const importId = preview.body.import.id as string;
    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/student-imports/${importId}/commit`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const profiles = await pool.query('SELECT institution_student_id, department_unit_id, program_unit_id, batch_unit_id, section_unit_id FROM institution_student_profiles WHERE institution_id=$1 ORDER BY institution_student_id', [institutionId]);
    expect(profiles.rows).toHaveLength(2);
    expect(profiles.rows.find((row) => row.institution_student_id === 'S-EXISTS')).toBeTruthy();
    expect(profiles.rows.find((row) => row.institution_student_id === 'S2001')).toMatchObject({
      department_unit_id: departmentId,
      program_unit_id: programId,
      batch_unit_id: batchId,
      section_unit_id: sectionId,
    });
  });

  it('creates direct institution students with flat contracts and defined validation errors', async () => {
    const institutionId = await seedOrg('INSTITUTION', 'Direct Student College');
    const otherInstitutionId = await seedOrg('INSTITUTION', 'Other Direct Student College');
    const adminUserId = await seedUser('direct-admin@example.test', 'sub:direct-admin');
    await seedMembership(adminUserId, institutionId, 'INSTITUTION_ADMIN');
    const departmentId = randomUUID();
    const programId = randomUUID();
    const otherDepartmentId = randomUUID();
    await db.insert(schema.institutionUnits).values([
      { id: departmentId, institutionId, kind: 'DEPARTMENT', name: 'Computer Science' },
      { id: programId, institutionId, kind: 'PROGRAM', name: 'BTech' },
      { id: otherDepartmentId, institutionId: otherInstitutionId, kind: 'DEPARTMENT', name: 'Other CSE' },
    ]);
    const token = signAccessToken(privateKey, { sub: 'sub:direct-admin', email: 'direct-admin@example.test' });

    const created = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        institutionStudentId: 'UAT-P2A-DIRECT-002',
        fullName: 'Phase2A Direct Student',
        email: 'phase2a.direct.002@uat.example.test',
        departmentUnitId: departmentId,
        programUnitId: programId,
        academicStartDate: '2026-08-22',
        expectedGraduationDate: '2028-08-22',
      })
      .expect(201);
    expect(created.body.student).toMatchObject({ institutionStudentId: 'UAT-P2A-DIRECT-002', fullName: 'Phase2A Direct Student' });

    const persisted = await pool.query(`
      SELECT u.state, sp.department_unit_id, sp.program_unit_id, ir.state AS relationship_state
      FROM institution_student_profiles sp
      JOIN users u ON u.id=sp.student_user_id
      JOIN institution_relationships ir ON ir.student_user_id=sp.student_user_id AND ir.institution_id=sp.institution_id
      WHERE sp.institution_id=$1 AND sp.institution_student_id=$2
    `, [institutionId, 'UAT-P2A-DIRECT-002']);
    expect(persisted.rows[0]).toMatchObject({ state: 'INVITED', department_unit_id: departmentId, program_unit_id: programId, relationship_state: 'ACTIVE' });

    const duplicateId = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${token}`)
      .send({ institutionStudentId: 'UAT-P2A-DIRECT-002', fullName: 'Duplicate Id', email: 'duplicate-id@example.test' })
      .expect(409);
    expect(duplicateId.body.error).toMatchObject({ code: 'INSTITUTION_STUDENT_ID_ALREADY_EXISTS', field: 'institutionStudentId' });

    const duplicateEmail = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${token}`)
      .send({ institutionStudentId: 'UAT-P2A-DIRECT-003', fullName: 'Duplicate Email', email: 'phase2a.direct.002@uat.example.test' })
      .expect(409);
    expect(duplicateEmail.body.error).toMatchObject({ code: 'STUDENT_EMAIL_ALREADY_EXISTS', field: 'email' });

    const wrongKind = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${token}`)
      .send({ institutionStudentId: 'UAT-P2A-DIRECT-004', fullName: 'Wrong Kind', email: 'wrong-kind@example.test', departmentUnitId: programId })
      .expect(400);
    expect(wrongKind.body.error).toMatchObject({ code: 'INVALID_ACADEMIC_UNIT_SCOPE', field: 'departmentUnitId' });

    const crossInstitution = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${token}`)
      .send({ institutionStudentId: 'UAT-P2A-DIRECT-005', fullName: 'Cross Unit', email: 'cross-unit-direct@example.test', departmentUnitId: otherDepartmentId })
      .expect(400);
    expect(crossInstitution.body.error).toMatchObject({ code: 'INVALID_ACADEMIC_UNIT_SCOPE', field: 'departmentUnitId' });

    const invalidDate = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/students`)
      .set('Authorization', `Bearer ${token}`)
      .send({ institutionStudentId: 'UAT-P2A-DIRECT-006', fullName: 'Bad Dates', email: 'bad-dates@example.test', academicStartDate: '2028-08-22', expectedGraduationDate: '2026-08-22' })
      .expect(400);
    expect(invalidDate.body.error).toMatchObject({ code: 'INVALID_ACADEMIC_DATE_WINDOW', field: 'expectedGraduationDate' });

    await request(app.getHttpServer())
      .patch(`/api/v1/institutions/${institutionId}/students/${created.body.student.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Phase2A Direct Student Edited', departmentUnitId: null })
      .expect(200);
    const edited = await pool.query('SELECT full_name, department_unit_id FROM institution_student_profiles WHERE id=$1', [created.body.student.id]);
    expect(edited.rows[0]).toMatchObject({ full_name: 'Phase2A Direct Student Edited', department_unit_id: null });
  });

  it('persists staff invitations without raw token exposure and handles pending duplicates explicitly', async () => {
    const institutionId = await seedOrg('INSTITUTION', 'Staff Invite College');
    const adminUserId = await seedUser('staff-invite-admin@example.test', 'sub:staff-invite-admin');
    await seedMembership(adminUserId, institutionId, 'INSTITUTION_ADMIN');
    const token = signAccessToken(privateKey, { sub: 'sub:staff-invite-admin', email: 'staff-invite-admin@example.test' });

    const fresh = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'phase2a.faculty.001@uat.example.test', role: 'FACULTY_LECTURER' })
      .expect(201);
    expect(fresh.body.invitation).toMatchObject({ email: 'phase2a.faculty.001@uat.example.test', role: 'FACULTY_LECTURER', state: 'PENDING', tokenPreviewAvailable: false });
    expect(JSON.stringify(fresh.body)).not.toMatch(/tokenHash|token_hash|[A-Za-z0-9_-]{80,}/);

    const invitationRows = await pool.query('SELECT token_hash, state FROM invitations WHERE id=$1', [fresh.body.invitation.id]);
    expect(invitationRows.rows[0]).toMatchObject({ state: 'PENDING' });
    const commandRows = await pool.query('SELECT state, dedupe_key FROM notification_commands WHERE destination_ref=$1', [`invitation:${fresh.body.invitation.id}`]);
    expect(['PENDING', 'DISPATCHED', 'DELIVERED']).toContain(commandRows.rows[0].state);
    const membershipRows = await pool.query('SELECT id FROM organization_memberships WHERE organization_id=$1 AND role=$2', [institutionId, 'FACULTY_LECTURER']);
    expect(membershipRows.rows).toEqual([]);

    const duplicate = await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'phase2a.faculty.001@uat.example.test', role: 'FACULTY_LECTURER' })
      .expect(201);
    expect(duplicate.body).toMatchObject({ code: 'STAFF_INVITATION_ALREADY_PENDING', invitation: { id: fresh.body.invitation.id, state: 'PENDING' } });

    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'staff-invite-admin@example.test', role: 'FACULTY_LECTURER' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/institutions/${institutionId}/staff-role-assignments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'platform-role@example.test', role: 'OPERATIONS_ADMIN' })
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
  role: 'PLATFORM_SUPER_ADMIN' | 'OPERATIONS_ADMIN' | 'INSTITUTION_ADMIN' | 'PLACEMENT_ADMIN' | 'DEPARTMENT_HEAD' | 'FACULTY_LECTURER' | 'RECRUITER',
  state: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
): Promise<void> {
  await db.insert(schema.organizationMemberships).values({
    id: randomUUID(),
    organizationId,
    userId,
    role,
    state,
    scopeOrganizationId: organizationId,
    ...(['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN'].includes(role) ? {} : role === 'RECRUITER' ? { scopeEmployerId: organizationId } : { scopeInstitutionId: organizationId }),
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
