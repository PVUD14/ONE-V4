/**
 * Employer terms, grant expiry and trust-case participation (EMP-16).
 *
 * Pins the goal's acceptance — an employer that has not accepted current terms cannot publish;
 * expired grants remove candidate access; employer responses and appeals appear on the operator case
 * timeline — plus the rules around them: terms are versioned, immutable, labelled with their legal
 * review state and accepted only by an owner; a material change is never retroactive; the expiry job
 * runs on the database clock outside any request; purges skip what a retention hold keeps; and an
 * employer sees a case about itself only once operations disclose it, never the reporter.
 *
 * Runs over real HTTP with a stub verifier in a throwaway schema of the local Postgres in DATABASE_URL.
 * The tests in this file share one schema and run in order: the first runs before any terms exist.
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
import { eraseExpiredApplicationMessages } from '@planthepath/persistence/src/application-messages.js';
import { revokeExpiredApplicantGrants } from '@planthepath/persistence/src/employer-terms.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { TrustSafetyController } from './trust-safety.controller.js';
import { EmployerTrustCasesController } from './employer-trust-cases.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for employer terms and trust tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Employer terms and trust tests require local Postgres');
const schemaName = 'employer_terms_trust_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let operatorId: string;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      verifier: { async verifyAccessToken(token: string) {
        if (!tokens.has(token)) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access',
          issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
      } },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    controllers: [TrustSafetyController, EmployerTrustCasesController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  operatorId = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id)
    VALUES ($1,$2,$3,'OPERATIONS_ADMIN','ACTIVE',$2)`, [randomUUID(), platformId, operatorId]);
}, 180_000);
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function membership(userId: string, orgId: string, role: string): Promise<void> {
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2)`, [randomUUID(), orgId, userId, role]);
}
async function employer(verification = 'VERIFIED') {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Acme Robotics',$2,true)", [employerId, verification]);
  const recruiterId = await user(); await membership(recruiterId, employerId, 'RECRUITER');
  const adminId = await user(); await membership(adminId, employerId, 'EMPLOYER_ADMIN');
  const ownerId = await user(); await membership(ownerId, employerId, 'EMPLOYER_OWNER');
  return { employerId, recruiterId, adminId, ownerId };
}
type Employer = Awaited<ReturnType<typeof employer>>;

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': 'emp16-' + randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId;
const noReadiness = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/readiness|mastery|gapStatus|fitScore|"score"|"band"/i);

async function draftJob(e: Employer, title = 'Robotics engineer'): Promise<string> {
  const created = await api().post(base(e.employerId) + '/opportunities').set(auth(e.recruiterId)).send({
    referenceCode: 'T-' + randomUUID().slice(0, 8), title, summary: 'Build robots.', employmentType: 'FULL_TIME',
    workMode: 'ONSITE', locationCity: 'Pune', compensationDisclosed: false,
  }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(base(e.employerId) + '/opportunities/' + id + '/audiences').set(auth(e.recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  return id;
}
const publish = (e: Employer, jobId: string) => api().post(base(e.employerId) + '/opportunities/' + jobId + '/publish').set(auth(e.recruiterId));
const lifecycle = async (jobId: string) => (await pool.query('SELECT lifecycle_state FROM opportunities WHERE id=$1', [jobId])).rows[0].lifecycle_state as string;
const settings = (e: Employer, actor = e.ownerId) => api().get(base(e.employerId) + '/settings').set(auth(actor));
const accept = (e: Employer, version: string, actor = e.ownerId) => api().post(base(e.employerId) + '/terms/accept').set(auth(actor)).send({ version });
const publishTerms = (body: Record<string, unknown>, actor = operatorId) => api().post('/api/v1/operations/employer-terms').set(auth(actor)).send(body);
const termsBody = (version: string, extra: Record<string, unknown> = {}) => ({
  version, title: 'ONE employer terms', body: 'Draft terms for legal review. Candidate data is for this hiring process only.',
  legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', requiresReacceptance: true, reasonCode: 'TERMS_PUBLISHED', ...extra,
});

async function applicant(e: Employer, jobId: string) {
  const studentId = await user();
  const response = await api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ opportunityId: jobId, consentGranted: true }).expect(201);
  return { studentId, applicationId: response.body.application.id as string };
}

describe('EMP-16: employer terms gate the next publish, never what is already live', () => {
  it('publishes exactly as before while no terms have been published', async () => {
    const e = await employer();
    const job = await draftJob(e);
    await publish(e, job).expect(201);
    const read = await settings(e).expect(200);
    expect(read.body.settings.terms).toMatchObject({ status: 'NO_TERMS_PUBLISHED', current: null, required: null, canAccept: false });
  });

  it('lets operations publish an immutable, clearly-draft version, and nobody else', async () => {
    const e = await employer();
    await publishTerms(termsBody('2026-10-draft-1'), e.ownerId).expect(403);
    await api().post('/api/v1/operations/employer-terms').send(termsBody('x1')).expect(401);
    // The first version must ask for acceptance, so "what an employer must accept" always has an answer.
    expect((await publishTerms(termsBody('first-soft', { requiresReacceptance: false })).expect(400)).body.error.code)
      .toBe('EMPLOYER_TERMS_FIRST_VERSION_MUST_REQUIRE_ACCEPTANCE');
    // An approval must say whose; a draft claims none.
    expect((await publishTerms(termsBody('approved-1', { legalReviewState: 'LEGAL_APPROVED' })).expect(400)).body.error.code).toBe('EMPLOYER_TERMS_LEGAL_REFERENCE_REQUIRED');
    expect((await publishTerms(termsBody('draft-ref', { legalReviewReference: 'Counsel memo' })).expect(400)).body.error.code).toBe('EMPLOYER_TERMS_LEGAL_REFERENCE_NOT_ALLOWED');
    expect((await publishTerms(termsBody('bad version!')).expect(400)).body.error.code).toBe('EMPLOYER_TERMS_VERSION_INVALID');
    expect((await publishTerms({ ...termsBody('x2'), effectiveFrom: '2027-01-01' }).expect(400)).body.error.code).toBe('INVALID_REQUEST');
    expect((await publishTerms({ ...termsBody('x3'), reasonCode: 'because' }).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    expect((await pool.query('SELECT count(*)::int AS n FROM employer_terms_versions')).rows[0].n).toBe(0);

    const published = await publishTerms(termsBody('2026-10-draft-1')).expect(201);
    expect(published.body.version).toMatchObject({ version: '2026-10-draft-1', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: null,
      requiresReacceptance: true, bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await publishTerms(termsBody('2026-10-draft-1')).expect(409)).body.error.code).toBe('EMPLOYER_TERMS_VERSION_EXISTS');
    const audit = await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action = 'employer.terms.published' AND resource_id = '2026-10-draft-1'");
    expect(audit.rows).toEqual([expect.objectContaining({ actor_user_id: operatorId, context: expect.objectContaining({ reasonCode: 'TERMS_PUBLISHED', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW' }) })]);
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'employer.terms.published'")).rows[0].n).toBe(1);
    // Immutable: the text an employer accepted can never be edited under them.
    await expect(pool.query("UPDATE employer_terms_versions SET body = 'changed' WHERE version = '2026-10-draft-1'")).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM employer_terms_versions WHERE version = '2026-10-draft-1'")).rejects.toThrow(/append-only/);

    const listed = await api().get('/api/v1/operations/employer-terms').set(auth(operatorId)).expect(200);
    expect(listed.body.versions).toEqual([expect.objectContaining({ version: '2026-10-draft-1', acceptedBy: 0 })]);
    await api().get('/api/v1/operations/employer-terms').set(auth(e.ownerId)).expect(403);
  });

  it('refuses to publish, reopen or request a drive until an owner accepts the current terms', async () => {
    const e = await employer();
    const job = await draftJob(e);
    const refused = await publish(e, job).expect(403);
    expect(refused.body.error.code).toBe('EMPLOYER_TERMS_NOT_ACCEPTED');
    expect(await lifecycle(job)).toBe('DRAFT');

    const collegeId = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute','VERIFIED',true)", [collegeId]);
    const drive = await api().post(base(e.employerId) + '/opportunities/' + job + '/campus-drives').set(auth(e.recruiterId))
      .send({ institutionId: collegeId, proposedStartAt: '2027-01-10T04:30:00.000Z', proposedEndAt: '2027-01-10T11:30:00.000Z', venueMode: 'ON_CAMPUS' }).expect(403);
    expect(drive.body.error.code).toBe('EMPLOYER_TERMS_NOT_ACCEPTED');
    expect((await pool.query('SELECT count(*)::int AS n FROM campus_drives WHERE opportunity_id = $1', [job])).rows[0].n).toBe(0);

    const before = await settings(e, e.adminId).expect(200);
    expect(before.body.settings.terms).toMatchObject({ status: 'ACCEPTANCE_REQUIRED', canAccept: false, latestAcceptance: null,
      current: expect.objectContaining({ version: '2026-10-draft-1', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', body: expect.stringContaining('Draft terms') }) });
    expect((await settings(e).expect(200)).body.settings.terms.canAccept).toBe(true);
    // Only an owner accepts for the organisation.
    await accept(e, '2026-10-draft-1', e.adminId).expect(403);
    await accept(e, '2026-10-draft-1', e.recruiterId).expect(403);
    expect((await accept(e, 'no-such-version').expect(409)).body.error.code).toBe('EMPLOYER_TERMS_VERSION_NOT_CURRENT');
    expect((await api().post(base(e.employerId) + '/terms/accept').set(auth(e.ownerId)).send({ version: '2026-10-draft-1', onBehalfOf: 'x' }).expect(400)).body.error.code).toBe('INVALID_REQUEST');

    const accepted = await accept(e, '2026-10-draft-1').expect(201);
    expect(accepted.body.settings.terms).toMatchObject({ status: 'ACCEPTED', canAccept: false, currentVersionAccepted: true,
      latestAcceptance: { version: '2026-10-draft-1', acceptedAt: expect.any(String), acceptedBy: e.ownerId + '@example.test' } });
    await accept(e, '2026-10-draft-1').expect(201);
    expect((await pool.query('SELECT accepted_by_user_id, accepted_role FROM employer_terms_acceptances WHERE employer_id = $1', [e.employerId])).rows)
      .toEqual([{ accepted_by_user_id: e.ownerId, accepted_role: 'EMPLOYER_OWNER' }]);
    expect((await pool.query("SELECT organization_id, context FROM audit_events WHERE action = 'employer.terms.accepted' AND actor_user_id = $1", [e.ownerId])).rows)
      .toEqual([{ organization_id: e.employerId, context: { termsVersion: '2026-10-draft-1', reasonCode: 'EMPLOYER_TERMS_ACCEPTED' } }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'employer.terms.accepted' AND organization_id = $1", [e.employerId])).rows[0].n).toBe(1);

    await publish(e, job).expect(201);
    // Reopening after a close is a publish too; with the terms accepted it goes through.
    await api().post(base(e.employerId) + '/opportunities/' + job + '/close').set(auth(e.recruiterId)).send({ reasonCode: 'ENOUGH_APPLICANTS' }).expect(201);
    await api().post(base(e.employerId) + '/opportunities/' + job + '/reopen').set(auth(e.recruiterId)).send({}).expect(201);
    expect(await lifecycle(job)).toBe('PUBLISHED');
  });

  it('never acts retroactively: a material change pulls nothing, and only the next publish waits', async () => {
    const e = await employer();
    await accept(e, '2026-10-draft-1').expect(201);
    const live = await draftJob(e, 'Live role');
    await publish(e, live).expect(201);
    const { studentId, applicationId } = await applicant(e, live);
    const closedJob = await draftJob(e, 'Closed role');
    await publish(e, closedJob).expect(201);
    await api().post(base(e.employerId) + '/opportunities/' + closedJob + '/close').set(auth(e.recruiterId)).send({ reasonCode: 'POSITION_FILLED' }).expect(201);

    await publishTerms(termsBody('2026-11-draft-2', { changeSummary: 'Adds the grievance contact.' })).expect(201);

    // What is live stays live, and the process carries on.
    expect(await lifecycle(live)).toBe('PUBLISHED');
    const seen = await api().get('/api/v1/opportunities').set(auth(studentId)).expect(200);
    expect(JSON.stringify(seen.body)).toContain(live);
    await api().post(base(e.employerId) + '/applications/' + applicationId + '/transition').set(auth(e.recruiterId)).send({ toState: 'SHORTLISTED' }).expect(201);
    const applicants = await api().get(base(e.employerId) + '/opportunities/' + live + '/applications').set(auth(e.recruiterId)).expect(200);
    expect(applicants.body.applications[0]).toMatchObject({ id: applicationId, candidateAccess: true });

    // Only putting a job in front of students anew waits for the owner.
    const next = await draftJob(e, 'Next role');
    expect((await publish(e, next).expect(403)).body.error.code).toBe('EMPLOYER_TERMS_NOT_ACCEPTED');
    expect((await api().post(base(e.employerId) + '/opportunities/' + closedJob + '/reopen').set(auth(e.recruiterId)).send({}).expect(403)).body.error.code)
      .toBe('EMPLOYER_TERMS_NOT_ACCEPTED');
    expect(await lifecycle(closedJob)).toBe('CLOSED');
    const status = await settings(e).expect(200);
    expect(status.body.settings.terms).toMatchObject({ status: 'ACCEPTANCE_REQUIRED', required: { version: '2026-11-draft-2', publishedAt: expect.any(String) },
      latestAcceptance: expect.objectContaining({ version: '2026-10-draft-1' }), current: expect.objectContaining({ changeSummary: 'Adds the grievance contact.' }) });
    // An owner cannot accept a version that is no longer current.
    expect((await accept(e, '2026-10-draft-1').expect(409)).body.error.code).toBe('EMPLOYER_TERMS_VERSION_NOT_CURRENT');
    await accept(e, '2026-11-draft-2').expect(201);
    await publish(e, next).expect(201);

    // A non-material version (a typo fix) asks nobody to accept again.
    await publishTerms(termsBody('2026-11-draft-2a', { requiresReacceptance: false, changeSummary: 'Typo.' })).expect(201);
    const later = await draftJob(e, 'Later role');
    await publish(e, later).expect(201);
    expect((await settings(e).expect(200)).body.settings.terms).toMatchObject({ status: 'ACCEPTED', currentVersionAccepted: false, canAccept: true,
      current: expect.objectContaining({ version: '2026-11-draft-2a', requiresReacceptance: false }) });
  });

  it('meets the §6.3 minimums on Settings', async () => {
    const e = await employer();
    const other = await employer();
    await api().get(base(e.employerId) + '/settings').expect(401);
    await settings(e, other.ownerId).expect(403);
    await accept(e, '2026-11-draft-2a', other.ownerId).expect(403);
    // Every employer role reads the terms; the retention facts are the enforced values.
    const read = await settings(e, e.recruiterId).expect(200);
    expect(read.body.settings.retention).toEqual({
      accessEndsWhen: ['APPLICATION_CLOSED', 'CANDIDATE_WITHDREW', 'CANDIDATE_DECLINED_NEW_TERMS', 'CANDIDATE_DELETED_ACCOUNT', 'ACCESS_PERIOD_EXPIRED'],
      resumeLinkSeconds: 60, messageRetentionDaysAfterAccessEnds: 180, candidateDeletionGraceDays: 30, heldForOpenTrustCasesAndLegalHolds: true,
    });
    expect(read.body.settings.notificationPreferences).toBeNull();
    noReadiness(read.body);

    // Notification preferences are the caller's own row, audited.
    await api().post(base(e.employerId) + '/settings/notification-preferences').set(auth(e.recruiterId)).send({ emailEnabled: 'no' }).expect(400);
    await api().post(base(e.employerId) + '/settings/notification-preferences').set(auth(e.recruiterId)).send({ dailyCap: 21 }).expect(400);
    await api().post(base(e.employerId) + '/settings/notification-preferences').set(auth(e.recruiterId)).send({ digest: true }).expect(400);
    const saved = await api().post(base(e.employerId) + '/settings/notification-preferences').set(auth(e.recruiterId)).send({ emailEnabled: false, dailyCap: 5 }).expect(201);
    expect(saved.body.settings.notificationPreferences).toEqual({ emailEnabled: false, quietHoursStartMinute: 1320, quietHoursEndMinute: 420, dailyCap: 5 });
    expect((await pool.query("SELECT organization_id FROM audit_events WHERE action = 'user.notification_preferences.updated' AND actor_user_id = $1", [e.recruiterId])).rows)
      .toEqual([{ organization_id: e.employerId }]);

    // A PENDING employer can accept before verification; a SUSPENDED or REJECTED one cannot even read.
    const pending = await employer('PENDING');
    await settings(pending).expect(200);
    await accept(pending, '2026-11-draft-2a').expect(201);
    await pool.query("UPDATE organizations SET verification_state = 'SUSPENDED', active = false WHERE id = $1", [e.employerId]);
    expect((await settings(e).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    expect((await accept(e, '2026-11-draft-2a').expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    expect((await pool.query('SELECT count(*)::int AS n FROM employer_terms_acceptances WHERE employer_id = $1', [e.employerId])).rows[0].n).toBe(0);
  });
});

describe('EMP-16: grant expiry and retention run outside any request, on the database clock', () => {
  it('removes candidate access the moment a grant expires, and the daily job makes it durable', async () => {
    const e = await employer();
    await accept(e, '2026-11-draft-2a').expect(201);
    const job = await draftJob(e);
    await publish(e, job).expect(201);
    const expired = await applicant(e, job);
    const later = await applicant(e, job);
    const open = await applicant(e, job);
    await pool.query("UPDATE employer_applicant_access_grants SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE student_user_id = $1", [expired.studentId]);
    await pool.query("UPDATE employer_applicant_access_grants SET expires_at = now() + interval '30 days' WHERE student_user_id = $1", [later.studentId]);

    // Access is gone on the next request, before any job runs: the person, the brief and the résumé.
    const list = await api().get(base(e.employerId) + '/opportunities/' + job + '/applications').set(auth(e.recruiterId)).expect(200);
    const rows = list.body.applications as { id: string; candidateAccess: boolean; candidateName: string | null }[];
    expect(rows.find((row) => row.id === expired.applicationId)).toMatchObject({ candidateAccess: false, candidateName: null });
    expect(rows.find((row) => row.id === later.applicationId)).toMatchObject({ candidateAccess: true });
    await api().get(base(e.employerId) + '/applications/' + expired.applicationId).set(auth(e.recruiterId)).expect(403);
    await api().get(base(e.employerId) + '/applications/' + expired.applicationId + '/resume').set(auth(e.recruiterId)).expect(403);
    await api().post(base(e.employerId) + '/applications/' + expired.applicationId + '/transition').set(auth(e.recruiterId)).send({ toState: 'SHORTLISTED' }).expect(403);

    // The job revokes only what has expired, once, with an actor-less outbox record.
    expect(await revokeExpiredApplicantGrants(db)).toBe(1);
    expect(await revokeExpiredApplicantGrants(db)).toBe(0);
    const grants = await pool.query('SELECT student_user_id, revoked_at IS NOT NULL AS revoked FROM employer_applicant_access_grants WHERE opportunity_id = $1 ORDER BY student_user_id', [job]);
    expect(Object.fromEntries(grants.rows.map((row) => [row.student_user_id, row.revoked]))).toEqual({
      [expired.studentId]: true, [later.studentId]: false, [open.studentId]: false,
    });
    const events = await pool.query("SELECT actor_user_id, organization_id, payload FROM outbox_events WHERE event_type = 'employer_applicant_access.expired'");
    expect(events.rows).toEqual([expect.objectContaining({ actor_user_id: null, organization_id: e.employerId,
      payload: expect.objectContaining({ employerId: e.employerId, opportunityId: job, reasonCode: 'GRANT_EXPIRED' }) })]);
    expect(JSON.stringify(events.rows)).not.toContain(expired.studentId);
    // Still refused after the job, and the student's application is untouched.
    await api().get(base(e.employerId) + '/applications/' + expired.applicationId).set(auth(e.recruiterId)).expect(403);
    expect((await pool.query('SELECT state FROM applications WHERE id = $1', [expired.applicationId])).rows[0].state).toBe('APPLIED');
  });

  it('never erases message text a retention hold still needs', async () => {
    const e = await employer();
    await accept(e, '2026-11-draft-2a').expect(201);
    const job = await draftJob(e);
    await publish(e, job).expect(201);
    const p = await applicant(e, job);
    await api().post(base(e.employerId) + '/applications/' + p.applicationId + '/transition').set(auth(e.recruiterId)).send({ toState: 'SHORTLISTED' }).expect(201);
    await api().post(base(e.employerId) + '/applications/' + p.applicationId + '/messages').set(auth(e.recruiterId)).send({ body: 'Are you free on Friday?' }).expect(201);
    // The employer's access ended long ago.
    await pool.query(`UPDATE employer_applicant_access_grants SET granted_at = now() - interval '400 days', revoked_at = now() - interval '200 days'
      WHERE student_user_id = $1`, [p.studentId]);
    const holdId = randomUUID();
    await pool.query("INSERT INTO data_retention_holds (id, subject_user_id, reason_code, placed_by_user_id) VALUES ($1,$2,'DISPUTE',$3)", [holdId, p.studentId, operatorId]);
    const text = async () => (await pool.query(
      'SELECT m.body FROM application_messages m JOIN application_message_threads t ON t.id = m.thread_id WHERE t.application_id = $1', [p.applicationId])).rows[0].body as string | null;

    await eraseExpiredApplicationMessages(db);
    expect(await text()).toBe('Are you free on Friday?');
    await pool.query('UPDATE data_retention_holds SET released_at = now(), released_by_user_id = $2 WHERE id = $1', [holdId, operatorId]);
    await eraseExpiredApplicationMessages(db);
    expect(await text()).toBeNull();
  });
});

describe('EMP-16: an employer answers a case about it, and operations decide', () => {
  async function reportedCase() {
    const e = await employer();
    await accept(e, '2026-11-draft-2a').expect(201);
    const job = await draftJob(e);
    await publish(e, job).expect(201);
    const p = await applicant(e, job);
    await api().post(base(e.employerId) + '/applications/' + p.applicationId + '/transition').set(auth(e.recruiterId)).send({ toState: 'SHORTLISTED' }).expect(201);
    const sent = await api().post(base(e.employerId) + '/applications/' + p.applicationId + '/messages').set(auth(e.recruiterId))
      .send({ body: 'Send Rs 5000 as a security deposit to proceed.' }).expect(201);
    await api().post('/api/v1/students/me/applications/' + p.applicationId + '/messages/' + sent.body.message.id + '/report').set(auth(p.studentId))
      .send({ reasonCode: 'SCAM_OR_PAYMENT_REQUEST', statement: 'They asked me for a deposit. My roll number is 21CS042.' }).expect(201);
    const caseId = (await pool.query('SELECT id FROM trust_cases WHERE reported_by_user_id = $1', [p.studentId])).rows[0].id as string;
    return { e, p, caseId, messageId: sent.body.message.id as string };
  }
  const operatorMove = (caseId: string, toState: string, reasonCode = 'OPERATIONS_REVIEW') =>
    api().post('/api/v1/operations/trust-safety/cases/' + caseId + '/transition').set(auth(operatorId)).send({ toState, reasonCode });
  const cases = (e: Employer, actor = e.ownerId) => api().get(base(e.employerId) + '/trust-cases').set(auth(actor));
  const detail = (e: Employer, caseId: string, actor = e.ownerId) => api().get(base(e.employerId) + '/trust-cases/' + caseId).set(auth(actor));

  it('puts the employer response and appeal on the operator case timeline, and never names the reporter', async () => {
    const { e, p, caseId } = await reportedCase();
    // Not disclosed yet: the employer cannot learn a report exists.
    expect((await cases(e).expect(200)).body.cases).toEqual([]);
    expect((await detail(e, caseId).expect(404)).body.error.code).toBe('TRUST_CASE_NOT_FOUND');
    expect((await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/response').set(auth(e.ownerId)).send({ statement: 'Hello' }).expect(404)).body.error.code)
      .toBe('TRUST_CASE_NOT_FOUND');

    await operatorMove(caseId, 'TRIAGED').expect(201);
    // An employer is never asked to answer nothing.
    expect((await operatorMove(caseId, 'AWAITING_RESPONSE').expect(400)).body.error.code).toBe('TRUST_CASE_SUMMARY_REQUIRED');
    await api().post('/api/v1/operations/trust-safety/cases/' + caseId + '/request-response').set(auth(operatorId)).send({ summary: '', reasonCode: 'RIGHT_OF_REPLY' }).expect(400);
    await api().post('/api/v1/operations/trust-safety/cases/' + caseId + '/request-response').set(auth(e.ownerId))
      .send({ summary: 'x', reasonCode: 'RIGHT_OF_REPLY' }).expect(403);
    await api().post('/api/v1/operations/trust-safety/cases/' + caseId + '/request-response').set(auth(operatorId))
      .send({ summary: 'A candidate reports that a member of your team asked for a payment to proceed with an application.', reasonCode: 'RIGHT_OF_REPLY' }).expect(201);

    const listed = await cases(e).expect(200);
    expect(listed.body.cases).toEqual([expect.objectContaining({ id: caseId, caseType: 'EMPLOYER_ACCOUNTABILITY', status: 'RESPONSE_REQUESTED',
      subject: { kind: 'ORGANIZATION' }, canRespond: true, canAppeal: false, responseRequestedAt: expect.any(String), decidedAt: null })]);
    const view = await detail(e, caseId).expect(200);
    expect(view.body.case.statements).toEqual([{ kind: 'ALLEGATION_SUMMARY', body: expect.stringContaining('asked for a payment'), createdAt: expect.any(String) }]);
    // The message thread, the reported message and the reporter's statement are counted, never described.
    expect(view.body.case.evidence).toEqual({ shared: [], withheldCount: 3 });
    const serialized = JSON.stringify(view.body) + JSON.stringify(listed.body);
    expect(serialized).not.toContain(p.studentId);
    expect(serialized).not.toContain(p.applicationId);
    expect(serialized).not.toMatch(/21CS042|deposit|security|severity|HIGH|reportedBy|reporter|openedAt|assigned|note/i);
    noReadiness(view.body);

    // Owners and admins answer for the organisation; recruiters do not.
    await cases(e, e.recruiterId).expect(403);
    await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/response').set(auth(e.recruiterId)).send({ statement: 'Not us.' }).expect(403);
    await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/response').set(auth(e.adminId)).send({ statement: '' }).expect(400);
    await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/response').set(auth(e.adminId)).send({ statement: 'x', attachment: 'y' }).expect(400);
    const responded = await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/response').set(auth(e.adminId))
      .send({ statement: 'We never ask for payment. The recruiter has been removed from the account.' }).expect(201);
    expect(responded.body.case).toMatchObject({ status: 'UNDER_REVIEW', canRespond: false });
    expect((await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/response').set(auth(e.adminId)).send({ statement: 'Again.' }).expect(409)).body.error.code)
      .toBe('TRUST_CASE_RESPONSE_NOT_REQUESTED');

    // Operations decide, share the decision, and act on it.
    await operatorMove(caseId, 'DECIDED', 'POLICY_BREACH_FOUND').expect(201);
    await api().post('/api/v1/operations/trust-safety/cases/' + caseId + '/employer-statements').set(auth(operatorId))
      .send({ kind: 'DECISION_SUMMARY', body: 'A payment request was made through ONE. A warning is recorded.' }).expect(201);
    await api().post('/api/v1/operations/trust-safety/cases/' + caseId + '/employer-statements').set(auth(operatorId))
      .send({ kind: 'EMPLOYER_RESPONSE', body: 'Spoofed.' }).expect(400);
    await api().post('/api/v1/operations/trust-safety/cases/' + caseId + '/actions').set(auth(operatorId)).send({ action: 'WARNING' }).expect(201);
    await operatorMove(caseId, 'ACTIONED', 'WARNING_ISSUED').expect(201);
    const decided = await detail(e, caseId).expect(200);
    expect(decided.body.case).toMatchObject({ status: 'DECIDED', canAppeal: true, decidedAt: expect.any(String),
      actions: [{ action: 'WARNING', effectiveFrom: expect.any(String), effectiveTo: null, reversed: false }] });
    expect(decided.body.case.statements.map((s: { kind: string }) => s.kind)).toEqual(['ALLEGATION_SUMMARY', 'EMPLOYER_RESPONSE', 'DECISION_SUMMARY']);

    const appealed = await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/appeal').set(auth(e.ownerId))
      .send({ statement: 'The recruiter acted alone and was removed the same day. We ask that the warning be withdrawn.' }).expect(201);
    expect(appealed.body.case).toMatchObject({ status: 'APPEAL_UNDER_REVIEW', canAppeal: false });
    expect((await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/appeal').set(auth(e.adminId)).send({ statement: 'Twice.' }).expect(409)).body.error.code)
      .toBe('TRUST_CASE_ALREADY_APPEALED');

    // The operator's case timeline carries both, as statements and as the state moves they caused.
    const operatorView = await api().get('/api/v1/operations/trust-safety/cases/' + caseId).set(auth(operatorId)).expect(200);
    const timeline = operatorView.body.case;
    expect(timeline.subjectEmployerId).toBe(e.employerId);
    expect(timeline.employerStatements.map((s: { kind: string; authorSide: string }) => [s.kind, s.authorSide])).toEqual([
      ['ALLEGATION_SUMMARY', 'OPERATIONS'], ['EMPLOYER_RESPONSE', 'EMPLOYER'], ['DECISION_SUMMARY', 'OPERATIONS'], ['EMPLOYER_APPEAL', 'EMPLOYER'],
    ]);
    expect(timeline.employerStatements[1]).toMatchObject({ body: expect.stringContaining('never ask for payment'), authorUserId: e.adminId });
    expect(timeline.events.map((event: { from_state: string; to_state: string; reason_code: string; actor_user_id: string }) =>
      [event.from_state, event.to_state, event.reason_code, event.actor_user_id === operatorId ? 'OPS' : event.actor_user_id === e.adminId ? 'ADMIN' : event.actor_user_id === e.ownerId ? 'OWNER' : 'OTHER'])).toEqual([
      ['REPORTED', 'TRIAGED', 'OPERATIONS_REVIEW', 'OPS'],
      ['TRIAGED', 'AWAITING_RESPONSE', 'RIGHT_OF_REPLY', 'OPS'],
      ['AWAITING_RESPONSE', 'UNDER_INVESTIGATION', 'EMPLOYER_RESPONDED', 'ADMIN'],
      ['UNDER_INVESTIGATION', 'DECIDED', 'POLICY_BREACH_FOUND', 'OPS'],
      ['DECIDED', 'ACTIONED', 'WARNING_ISSUED', 'OPS'],
      ['ACTIONED', 'APPEALED', 'EMPLOYER_APPEAL', 'OWNER'],
    ]);
    const audits = await pool.query("SELECT action, actor_user_id, organization_id FROM audit_events WHERE resource_id = $1 AND action LIKE 'trust.case.%' ORDER BY occurred_at", [caseId]);
    expect(audits.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['trust.case.response_requested', 'trust.case.employer_responded', 'trust.case.statement_shared', 'trust.case.employer_appealed']));
    expect(audits.rows.filter((row) => row.action.startsWith('trust.case.employer')).every((row) => row.organization_id === e.employerId)).toBe(true);
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type = 'trust.case.employer_statement.recorded' AND aggregate_id = $1 ORDER BY occurred_at", [caseId]);
    expect(outbox.rows.map((row) => row.payload.kind)).toEqual(['ALLEGATION_SUMMARY', 'EMPLOYER_RESPONSE', 'DECISION_SUMMARY', 'EMPLOYER_APPEAL']);
    expect(JSON.stringify(outbox.rows)).not.toMatch(/never ask|withdrawn/);

    // Operations decide the appeal. A suspended employer can still read its cases.
    await operatorMove(caseId, 'CLOSED', 'APPEAL_REJECTED').expect(201);
    await pool.query("UPDATE organizations SET verification_state = 'SUSPENDED', active = false WHERE id = $1", [e.employerId]);
    const closed = await detail(e, caseId).expect(200);
    expect(closed.body.case).toMatchObject({ status: 'CLOSED', canAppeal: false, canRespond: false });
    await api().post(base(e.employerId) + '/trust-cases/' + caseId + '/appeal').set(auth(e.ownerId)).send({ statement: 'Again.' }).expect(409);
    // Nothing an employer wrote can be rewritten afterwards.
    await expect(pool.query("UPDATE trust_case_employer_statements SET body = 'edited' WHERE case_id = $1", [caseId])).rejects.toThrow(/append-only/);
  });

  it('shows an employer only the cases about itself, with its own job evidence', async () => {
    const { e, caseId } = await reportedCase();
    const other = await employer();
    await operatorMove(caseId, 'TRIAGED').expect(201);
    await api().post('/api/v1/operations/trust-safety/cases/' + caseId + '/request-response').set(auth(operatorId))
      .send({ summary: 'A concern about a message.', reasonCode: 'RIGHT_OF_REPLY' }).expect(201);
    expect((await cases(other).expect(200)).body.cases).toEqual([]);
    await detail(other, caseId).expect(404);
    await api().post(base(other.employerId) + '/trust-cases/' + caseId + '/response').set(auth(other.ownerId)).send({ statement: 'Not ours.' }).expect(404);
    await api().get(base(e.employerId) + '/trust-cases').set(auth(other.ownerId)).expect(403);
    await api().get(base(e.employerId) + '/trust-cases').expect(401);

    // A case about one of the employer's job versions, opened from a detector signal.
    const job = await draftJob(e, 'Signal role');
    const version = (await pool.query('SELECT current_version_id FROM opportunities WHERE id = $1', [job])).rows[0].current_version_id as string;
    const signalId = randomUUID();
    await pool.query(`INSERT INTO opportunity_review_signals (id, opportunity_id, employer_id, opportunity_version_id, signal_code, detector_version)
      VALUES ($1,$2,$3,$4,'MISSING_COMPENSATION','test-1')`, [signalId, job, e.employerId, version]);
    const opened = await api().post('/api/v1/operations/trust-safety/cases').set(auth(operatorId))
      .send({ caseType: 'OPPORTUNITY_MODERATION', subjectKind: 'OPPORTUNITY_VERSION', subjectId: version, signalIds: [signalId] }).expect(201);
    const jobCase = opened.body.id as string;
    await operatorMove(jobCase, 'TRIAGED').expect(201);
    await api().post('/api/v1/operations/trust-safety/cases/' + jobCase + '/request-response').set(auth(operatorId))
      .send({ summary: 'The job does not state its pay.', reasonCode: 'RIGHT_OF_REPLY' }).expect(201);
    const view = await detail(e, jobCase).expect(200);
    expect(view.body.case).toMatchObject({ caseType: 'OPPORTUNITY_MODERATION', subject: { kind: 'JOB', jobTitle: 'Signal role', jobVersion: 1 },
      evidence: { shared: [{ kind: 'DETECTOR_SIGNAL', signalCode: 'MISSING_COMPENSATION', jobTitle: 'Signal role', jobVersion: 1 }], withheldCount: 0 } });
    expect((await cases(e).expect(200)).body.cases.map((c: { id: string }) => c.id).sort()).toEqual([caseId, jobCase].sort());
    await detail(other, jobCase).expect(404);

    // A case that is not about an employer cannot be given an employer summary.
    const userCase = await api().post('/api/v1/operations/trust-safety/cases').set(auth(operatorId))
      .send({ caseType: 'USER_SAFETY', subjectKind: 'USER', subjectId: e.recruiterId }).expect(201);
    expect((await api().post('/api/v1/operations/trust-safety/cases/' + userCase.body.id + '/employer-statements').set(auth(operatorId))
      .send({ kind: 'ALLEGATION_SUMMARY', body: 'x' }).expect(400)).body.error.code).toBe('TRUST_CASE_SUBJECT_NOT_EMPLOYER');
    // And moving it to AWAITING_RESPONSE needs no summary, as before.
    await operatorMove(userCase.body.id, 'TRIAGED').expect(201);
    await operatorMove(userCase.body.id, 'AWAITING_RESPONSE').expect(201);
  });
});
