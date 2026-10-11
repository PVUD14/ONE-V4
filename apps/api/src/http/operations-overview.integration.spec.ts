/**
 * The Operations Overview summary over HTTP (OPS-03).
 *
 * One request returns every Overview count, computed server-side in bounded SQL. The
 * route opens for the three platform roles and no one else; each section is present only
 * for a caller holding that module's capability and is null otherwise; counts of people
 * below 5 are suppressed; and nothing personal (emails, subjects) is returned.
 *
 * Real Postgres in a throwaway schema, seeded with a known mix of every queue.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { readOperationsOverview } from '@planthepath/persistence/src/operations-overview.js';
import { openSupportCase } from '@planthepath/persistence/src/support-cases.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for operations overview tests');

const schemaName = 'ops_overview_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let institutionId: string;
let verifiedInstitutionId: string;
let reviewEmployerId: string;
let suspendedEmployerId: string;
let seeder: Member;

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];
/** Strings seeded into personal fields; none may appear in any response. */
const privateMarkers = ['invitee-private', 'student-private', 'requester-private', 'privacy-subject'];

async function member(role: string, state = 'ACTIVE'): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : institutionId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId };
}

async function plainUser(marker: string, state = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,$3)', [id, `${marker}-${id}@college.test`, state]);
  return id;
}

async function organization(kind: 'INSTITUTION' | 'EMPLOYER', legalName: string, verification: string, active = true): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,$2,$3,$4,$5)', [id, kind, legalName, verification, active]);
  return id;
}

const tokenHash = () => (randomUUID() + randomUUID()).replaceAll('-', '');

async function staffInvitation(input: { organizationId: string; kind: 'INSTITUTION' | 'EMPLOYER'; createdDaysAgo: number; expiresInDays: number; accepted?: boolean }): Promise<void> {
  const role = input.kind === 'INSTITUTION' ? 'INSTITUTION_ADMIN' : 'EMPLOYER_ADMIN';
  const acceptedBy = input.accepted ? await plainUser('invitee-private') : null;
  await pool.query(
    `INSERT INTO invitations (id, email, token_hash, invited_by_user_id, organization_id, role, scope_organization_id, scope_institution_id, scope_employer_id,
                              expires_at, created_at, state, accepted_by_user_id, accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $5, $7, $8, now() + ($9 || ' days')::interval, now() - ($10 || ' days')::interval, $11, $12, $13)`,
    [randomUUID(), `invitee-private-${randomUUID()}@college.test`, tokenHash(), seeder.userId, input.organizationId, role,
      input.kind === 'INSTITUTION' ? input.organizationId : null, input.kind === 'EMPLOYER' ? input.organizationId : null,
      String(input.expiresInDays), String(input.createdDaysAgo), input.accepted ? 'ACCEPTED' : 'PENDING', acceptedBy, input.accepted ? new Date() : null],
  );
}

async function studentInvitation(delivery: string, createdDaysAgo: number): Promise<void> {
  const studentId = await plainUser('student-private', 'INVITED');
  await pool.query(
    `INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status)
     VALUES ($1, $2, $3, $4, 'student-private name', 'INVITED')`,
    [randomUUID(), institutionId, studentId, 'ROLL-' + studentId.slice(0, 8)],
  );
  await pool.query(
    `INSERT INTO invitations (id, kind, email, token_hash, invited_by_user_id, organization_id, student_user_id, expires_at, created_at, delivery_state)
     VALUES ($1, 'STUDENT', $2, $3, $4, $5, $6, now() + interval '14 days', now() - ($7 || ' days')::interval, $8)`,
    [randomUUID(), `student-private-${studentId}@college.test`, tokenHash(), seeder.userId, institutionId, studentId, String(createdDaysAgo), delivery],
  );
}

async function accessRequest(state: 'PENDING' | 'SPAM'): Promise<void> {
  const decided = state !== 'PENDING';
  await pool.query(
    `INSERT INTO employer_access_requests (id, requester_name, company_name, work_email, email_domain, website_url, email_matches_website, free_mail,
                                           state, decided_by_user_id, decided_at, decision_reason_code)
     VALUES ($1, 'requester-private', 'Requesting company', $2, 'company.test', 'https://company.test', true, false, $3, $4, $5, $6)`,
    [randomUUID(), `requester-private-${randomUUID()}@company.test`, state, decided ? seeder.userId : null, decided ? new Date() : null, decided ? 'NOT_AN_EMPLOYER' : null],
  );
}

async function trustCase(severity: string, state: string, assigned: boolean): Promise<void> {
  const closed = ['CLOSED', 'DISMISSED'].includes(state);
  await pool.query(
    `INSERT INTO trust_cases (id, case_type, subject_kind, subject_organization_id, state, severity, assigned_to_user_id, closed_at)
     VALUES ($1, 'EMPLOYER_ACCOUNTABILITY', 'ORGANIZATION', $2, $3, $4, $5, $6)`,
    [randomUUID(), reviewEmployerId, state, severity, assigned ? seeder.userId : null, closed ? new Date() : null],
  );
}

async function privacyRequest(type: 'EXPORT' | 'DELETION', state: string, scheduledInDays?: number): Promise<void> {
  const subject = await plainUser('privacy-subject');
  await pool.query(
    `INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for)
     VALUES ($1, $2, $2, $3, $4, CASE WHEN $5::text IS NULL THEN NULL ELSE now() + ($5::text || ' days')::interval END)`,
    [randomUUID(), subject, type, state, scheduledInDays === undefined ? null : String(scheduledInDays)],
  );
}

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db,
      ids: { uuid: () => randomUUID() },
      verifier: {
        async verifyAccessToken(token: string) {
          if (!tokens.has(token)) throw new Error('Invalid local test identity');
          return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
        },
      },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();

  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  institutionId = await organization('INSTITUTION', 'Pending college', 'PENDING');
  verifiedInstitutionId = await organization('INSTITUTION', 'Verified college', 'VERIFIED');
  reviewEmployerId = await organization('EMPLOYER', 'Reviewed employer', 'UNDER_REVIEW');
  suspendedEmployerId = await organization('EMPLOYER', 'Suspended employer', 'SUSPENDED', false);
  seeder = await member('PLATFORM_SUPER_ADMIN');

  // Staff invitations: one stale pending, one fresh pending, one expired unaccepted, one accepted.
  await staffInvitation({ organizationId: institutionId, kind: 'INSTITUTION', createdDaysAgo: 4, expiresInDays: 10 });
  await staffInvitation({ organizationId: verifiedInstitutionId, kind: 'INSTITUTION', createdDaysAgo: 0, expiresInDays: 14 });
  await staffInvitation({ organizationId: reviewEmployerId, kind: 'EMPLOYER', createdDaysAgo: 20, expiresInDays: -1 });
  await staffInvitation({ organizationId: verifiedInstitutionId, kind: 'INSTITUTION', createdDaysAgo: 2, expiresInDays: 12, accepted: true });
  // Student invitations: one stale and undelivered, one delivered.
  await studentInvitation('FAILED', 5);
  await studentInvitation('SENT', 0);
  // One student relationship: a count of one person, which must be suppressed.
  const student = await plainUser('student-private');
  await pool.query("INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE',now())", [randomUUID(), verifiedInstitutionId, student]);

  await accessRequest('PENDING');
  await accessRequest('PENDING');
  await accessRequest('SPAM');

  await trustCase('CRITICAL', 'REPORTED', false);
  await trustCase('LOW', 'TRIAGED', true);
  await trustCase('HIGH', 'CLOSED', false);

  for (const id of [randomUUID(), randomUUID()]) {
    await pool.query(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, delivery_state, attempts, last_failure_class, correlation_id)
       VALUES ($1,'test_aggregate',$2,'overview.test','{}'::jsonb,'FAILED',5,'TERMINAL_PUBLISH_FAILURE','overview-test-correlation')`,
      [id, randomUUID()],
    );
  }
  await pool.query(
    `INSERT INTO jobs_health_alerts (id, condition_key, state, observed_value, threshold, notice, correlation_id)
     VALUES ($1,'FAILED_EVENTS_THRESHOLD','OPEN',12,10,'NOT_DELIVERED','overview-test-correlation')`,
    [randomUUID()],
  );

  await privacyRequest('EXPORT', 'RECEIVED');
  await privacyRequest('DELETION', 'RECEIVED', 3);
  await privacyRequest('DELETION', 'RECEIVED', 20);
  await privacyRequest('EXPORT', 'FAILED');
  const holdSubject = await plainUser('privacy-subject');
  await pool.query("INSERT INTO data_retention_holds (id,subject_user_id,reason_code,placed_by_user_id) VALUES ($1,$2,'LEGAL_OBLIGATION',$3)", [randomUUID(), holdSubject, seeder.userId]);
  await pool.query(
    "INSERT INTO data_retention_holds (id,subject_user_id,reason_code,placed_by_user_id,released_by_user_id,released_at) VALUES ($1,$2,'DISPUTE',$3,$3,now())",
    [randomUUID(), holdSubject, seeder.userId],
  );

  await openSupportCase(db, { channel: 'PHONE', category: 'ACCOUNT_ACCESS', severity: 'MEDIUM', summary: 'Cannot sign in', reasonCode: 'CUSTOMER_CONTACT', actorUserId: seeder.userId, correlationId: 'overview-support-1' });
  await openSupportCase(db, { channel: 'EMAIL', category: 'ACCOUNT_ACCESS', severity: 'HIGH', summary: 'Locked out', reasonCode: 'CUSTOMER_CONTACT', actorUserId: seeder.userId, assignToUserId: seeder.userId, correlationId: 'overview-support-2' });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-overview-' + randomUUID() });
const overview = (userId: string) => api().get('/api/v1/operations/overview').set(auth(userId));
const count = (value: number) => ({ value, capped: false });

describe('who may open the Overview', () => {
  it('401 without a token, 403 for an institution admin and a suspended operator, 200 for the three platform roles', async () => {
    expect((await api().get('/api/v1/operations/overview')).status).toBe(401);
    const institutionAdmin = await member('INSTITUTION_ADMIN');
    const denied = await overview(institutionAdmin.userId);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect(denied.body.overview).toBeUndefined();
    const suspended = await member('OPERATIONS_ADMIN', 'SUSPENDED');
    expect([401, 403]).toContain((await overview(suspended.userId)).status);
    for (const role of platformRoles) {
      const response = await overview((await member(role)).userId);
      expect(response.status, role).toBe(200);
      expect(typeof response.body.correlationId).toBe('string');
    }
  });

  it('rejects any query parameter with 400, and only after authorising the caller', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const response = await api().get('/api/v1/operations/overview?limit=500').set(auth(operator.userId));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    const institutionAdmin = await member('INSTITUTION_ADMIN');
    expect((await api().get('/api/v1/operations/overview?limit=500').set(auth(institutionAdmin.userId))).status).toBe(403);
  });
});

describe('sections follow the caller\'s capabilities', () => {
  it('gives the security admin trust, jobs and privacy, and null for every other section', async () => {
    const response = await overview((await member('SECURITY_ADMIN')).userId);
    const body = response.body.overview;
    for (const section of ['organizations', 'verification', 'employerAccessRequests', 'invitations', 'accounts', 'approvals', 'support']) {
      expect(body[section], section).toBeNull();
    }
    for (const section of ['trustSafety', 'jobs', 'privacyRequests', 'privacyHolds']) expect(body[section], section).not.toBeNull();
    expect(response.body.viewer.sections).toEqual(['trustSafety', 'jobs', 'privacyRequests', 'privacyHolds']);
  });

  it('gives the operations admin everything but the approvals queue, and the super admin everything', async () => {
    const operations = (await overview((await member('OPERATIONS_ADMIN')).userId)).body.overview;
    expect(operations.approvals).toBeNull();
    for (const section of ['organizations', 'verification', 'employerAccessRequests', 'invitations', 'accounts', 'trustSafety', 'jobs', 'privacyRequests', 'privacyHolds', 'support']) {
      expect(operations[section], section).not.toBeNull();
    }
    const everything = (await overview((await member('PLATFORM_SUPER_ADMIN')).userId)).body.overview;
    for (const [section, value] of Object.entries(everything)) if (section !== 'generatedAt') expect(value, section).not.toBeNull();
  });

  it('adds the support section when SUPPORT_CASES is granted, and drops it again when revoked', async () => {
    const security = await member('SECURITY_ADMIN');
    const grantId = randomUUID();
    await pool.query(
      "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'SUPPORT_CASES',$3,'NEW_RESPONSIBILITY')",
      [grantId, security.membershipId, seeder.userId],
    );
    expect((await overview(security.userId)).body.overview.support).toEqual({ open: count(2), overdue: count(0), unassigned: count(1) });
    await pool.query("UPDATE membership_capabilities SET revoked_at = now(), revoked_by_user_id = $2, revoked_reason_code = 'RESPONSIBILITY_ENDED' WHERE id = $1", [grantId, seeder.userId]);
    expect((await overview(security.userId)).body.overview.support).toBeNull();
  });
});

describe('the counts', () => {
  it('counts every queue in SQL, exactly', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    const filed = await api().post('/api/v1/operations/approvals').set(auth(operations.userId))
      .send({ actionKey: 'ORGANIZATION_SUSPEND', payload: { organizationId: verifiedInstitutionId, reasonCode: 'POLICY_VIOLATION' } });
    expect(filed.status).toBe(201);

    const body = (await overview(approver.userId)).body.overview;
    expect(body.organizations.total).toEqual(count(4));
    expect(body.organizations.active).toEqual(count(3));
    expect(body.organizations.institutions.total).toEqual(count(2));
    expect(body.organizations.institutions.byVerification).toEqual({ PENDING: count(1), UNDER_REVIEW: count(0), VERIFIED: count(1), REJECTED: count(0), SUSPENDED: count(0) });
    expect(body.organizations.employers.byVerification).toEqual({ PENDING: count(0), UNDER_REVIEW: count(1), VERIFIED: count(0), REJECTED: count(0), SUSPENDED: count(1) });
    expect(body.organizations.recent.length).toBe(4);
    expect(body.organizations.recent.map((row: { kind: string }) => row.kind)).not.toContain('PLATFORM');
    expect(body.organizations.recent.find((row: { id: string }) => row.id === suspendedEmployerId)).toMatchObject({ name: 'Suspended employer', verificationState: 'SUSPENDED', active: false });
    expect(body.verification).toEqual({ awaitingDecision: count(2), underReview: count(1) });
    expect(body.employerAccessRequests.pending).toEqual(count(2));
    expect(typeof body.employerAccessRequests.oldestPendingAt).toBe('string');

    expect(body.invitations.staff).toEqual({ total: count(4), accepted: count(1), pending: count(2), pendingOver72Hours: count(1), expiredUnaccepted: count(1) });
    expect(body.invitations.expiringSoon.map((row: { organizationName: string }) => row.organizationName)).toEqual(['Pending college', 'Verified college']);
    expect(body.invitations.recent.length).toBe(4);
    expect(body.invitations.student.pending).toEqual(count(2));
    expect(body.invitations.student.pendingOver72Hours).toEqual(count(1));
    expect(body.invitations.student.notDelivered).toEqual(count(1));
    expect(body.invitations.student.byDelivery).toEqual({ NOT_SENT: count(0), SENT: count(1), FAILED: count(1), BOUNCED: count(0), NOT_CONFIGURED: count(0) });

    expect(body.trustSafety).toEqual({ open: count(2), unassigned: count(1), bySeverity: { CRITICAL: count(1), HIGH: count(0), MEDIUM: count(0), LOW: count(1) } });
    expect(body.jobs).toEqual({ failedEvents: count(2), openAlerts: count(1) });
    expect(body.privacyRequests).toEqual({ open: count(3), openExports: count(1), openDeletions: count(2), deletionsDueWithin7Days: count(1), failed: count(1) });
    expect(body.privacyHolds).toEqual({ active: count(1) });
    expect(body.approvals).toEqual({ pending: count(1), awaitingExecution: count(0) });
    expect(body.support).toEqual({ open: count(2), overdue: count(0), unassigned: count(1) });
  });

  it('suppresses counts of people below 5 and returns the value from 5 up', async () => {
    const body = (await overview((await member('OPERATIONS_ADMIN')).userId)).body.overview;
    // One seeded student relationship: suppressed, and its value never leaves the server.
    expect(body.accounts.students).toEqual({ suppressed: true, value: null, capped: false });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
    const total = Number(rows[0].n);
    expect(total).toBeGreaterThanOrEqual(5);
    expect(body.accounts.total).toEqual({ suppressed: false, value: total, capped: false });
    const { rows: members } = await pool.query("SELECT count(DISTINCT user_id)::int AS n FROM organization_memberships WHERE state = 'ACTIVE'");
    expect(body.accounts.withOrganizationRoles).toEqual({ suppressed: false, value: Number(members[0].n), capped: false });
  });

  it('stops each count at the cap and says so', async () => {
    const capped = await readOperationsOverview(db, ['organizations', 'invitations', 'accounts'], 1);
    expect(capped.organizations!.total).toEqual({ value: 1, capped: true });
    expect(capped.invitations!.staff.total).toEqual({ value: 1, capped: true });
    expect(capped.invitations!.staff.accepted).toEqual({ value: 1, capped: false });
    expect(capped.trustSafety).toBeNull();
  });

  it('returns no personal data: no emails, names or subject identifiers', async () => {
    const response = await overview((await member('PLATFORM_SUPER_ADMIN')).userId);
    const text = JSON.stringify(response.body);
    for (const marker of privateMarkers) expect(text).not.toContain(marker);
    expect(text).not.toMatch(/@college\.test|@company\.test|@example\.test/);
    const { rows } = await pool.query('SELECT subject_user_id FROM privacy_requests UNION SELECT student_user_id FROM invitations WHERE student_user_id IS NOT NULL');
    for (const row of rows) expect(text).not.toContain(row.subject_user_id);
  });
});
