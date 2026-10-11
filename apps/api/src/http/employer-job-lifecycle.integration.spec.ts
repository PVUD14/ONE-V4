/**
 * Job lifecycle after creation (EMP-05, defect D-8): edit as a new version, pause, close,
 * reopen, withdraw, the deadline job, and the applicant's acknowledgement of changed terms.
 *
 * Before EMP-05 a job could only be created and published; nothing edited, paused or closed
 * it, and a material change had no way to reach the people who applied under the old terms.
 * Runs over real HTTP with a stub verifier and the real identity store, like the EMP-03 spec,
 * in a throwaway schema of the local Postgres in DATABASE_URL.
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
import { closeOpportunityAtDeadline } from '@planthepath/persistence/src/opportunity-deadlines.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for job lifecycle tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Job lifecycle tests require local Postgres');
const schemaName = 'employer_job_lifecycle_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;

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
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
}, 60_000);
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
async function employer(verification: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED' = 'VERIFIED', active = true) {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Lifecycle employer',$2,$3)", [employerId, verification, active]);
  const recruiterId = await user();
  await membership(recruiterId, employerId, 'RECRUITER');
  return { employerId, recruiterId };
}
async function membership(userId: string, orgId: string, role: string, state = 'ACTIVE'): Promise<void> {
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,$5,$2,$2)`, [randomUUID(), orgId, userId, role, state]);
}
const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId + '/opportunities';

const baseTerms = {
  title: 'Platform engineer', summary: 'Build and run the platform.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Bengaluru',
  compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: 1200000, compensationPeriod: 'YEAR',
};

async function createJob(employerId: string, recruiterId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; versionId: string }> {
  const created = await api().post(base(employerId)).set(auth(recruiterId))
    .send({ referenceCode: 'LC-' + randomUUID().slice(0, 8), ...baseTerms, ...extra }).expect(201);
  await api().post(base(employerId) + '/' + created.body.opportunity.id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  return { id: created.body.opportunity.id, versionId: created.body.opportunity.versionId };
}
async function publishedJob(employerId: string, recruiterId: string, extra: Record<string, unknown> = {}) {
  const job = await createJob(employerId, recruiterId, extra);
  await api().post(base(employerId) + '/' + job.id + '/publish').set(auth(recruiterId)).expect(201);
  return job;
}
async function apply(opportunityId: string, studentId?: string): Promise<{ studentId: string; applicationId: string }> {
  const student = studentId ?? await user();
  const response = await api().post('/api/v1/students/me/applications').set(auth(student)).send({ opportunityId, consentGranted: true }).expect(201);
  return { studentId: student, applicationId: response.body.application.id };
}
async function lifecycle(opportunityId: string) {
  return (await pool.query('SELECT lifecycle_state, closed_at, current_version_id FROM opportunities WHERE id=$1', [opportunityId])).rows[0] as
    { lifecycle_state: string; closed_at: Date | null; current_version_id: string };
}
/** Save a new version against the job's current version (or `expected`), asserting the status. */
async function edit(employerId: string, recruiterId: string, opportunityId: string, changes: Record<string, unknown>, status: number, expected?: string) {
  const current = expected ?? (await lifecycle(opportunityId)).current_version_id;
  return api().post(base(employerId) + '/' + opportunityId + '/versions').set(auth(recruiterId))
    .send({ ...baseTerms, ...changes, expectedCurrentVersionId: current }).expect(status);
}
async function listedToStudent(opportunityId: string): Promise<boolean> {
  const response = await api().get('/api/v1/opportunities').set(auth(await user())).expect(200);
  return response.body.opportunities.some((item: { id: string }) => item.id === opportunityId);
}
function transition(employerId: string, recruiterId: string, applicationId: string, toState: string) {
  return api().post('/api/v1/employers/' + employerId + '/applications/' + applicationId + '/transition').set(auth(recruiterId)).send({ toState });
}
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
const inADay = () => new Date(Date.now() + 86_400_000).toISOString();

describe('EMP-05: editing creates a new version and leaves old versions intact', () => {
  it('inserts version 2, keeps version 1 byte-for-byte, and keeps applicants bound to the version they applied to', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const { applicationId } = await apply(job.id);
    const before = (await pool.query('SELECT * FROM opportunity_versions WHERE id=$1', [job.versionId])).rows[0];

    const response = await edit(employerId, recruiterId, job.id, { summary: 'Build, run and document the platform.' }, 201);
    expect(response.body.version).toMatchObject({ versionNumber: 2, change: 'EDITORIAL', changedTerms: [] });
    expect(response.body.applicants).toEqual({ termChangesRecorded: 0, acknowledgementsRequired: 0 });

    expect((await pool.query('SELECT * FROM opportunity_versions WHERE id=$1', [job.versionId])).rows[0]).toEqual(before);
    expect((await lifecycle(job.id)).current_version_id).toBe(response.body.version.id);
    expect((await pool.query('SELECT applied_version_id FROM applications WHERE id=$1', [applicationId])).rows[0].applied_version_id).toBe(job.versionId);
    // The student's application still describes the job they applied to.
    expect((await pool.query('SELECT count(*)::int AS count FROM opportunity_term_change_acknowledgements WHERE application_id=$1', [applicationId])).rows[0].count).toBe(0);
    await transition(employerId, recruiterId, applicationId, 'SHORTLISTED').expect(201);

    const detail = await api().get(base(employerId) + '/' + job.id).set(auth(recruiterId)).expect(200);
    expect(detail.body.versions.map((item: { versionNumber: number; change: string; isCurrent: boolean }) => [item.versionNumber, item.change, item.isCurrent]))
      .toEqual([[2, 'EDITORIAL', true], [1, 'INITIAL', false]]);
    expect(detail.body.currentVersion).toMatchObject({ versionNumber: 2, summary: 'Build, run and document the platform.' });
    expect(detail.body.opportunity).toMatchObject({ lifecycleState: 'PUBLISHED', canEdit: true, availableActions: ['PAUSE', 'CLOSE', 'WITHDRAW'], openApplicationCount: 1 });

    const audit = await pool.query("SELECT organization_id, context FROM audit_events WHERE action='opportunity.version_created' AND resource_id=$1", [job.id]);
    expect(audit.rows).toEqual([{ organization_id: employerId, context: expect.objectContaining({ versionNumber: 2, change: 'EDITORIAL', applicantsAffected: 0 }) }]);
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='opportunity.version.created' AND aggregate_id=$1", [job.id]);
    expect(outbox.rows).toEqual([{ payload: { opportunityId: job.id, employerId, versionId: response.body.version.id, change: 'EDITORIAL' } }]);
  });

  it('carries skills, stages and eligibility forward to the new version', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await createJob(employerId, recruiterId);
    await pool.query("INSERT INTO opportunity_skill_requirements (id,opportunity_version_id,skill_name,requirement_level) VALUES ($1,$2,'SQL','REQUIRED')", [randomUUID(), job.versionId]);
    await pool.query("INSERT INTO opportunity_selection_stages (id,opportunity_version_id,stage_order,stage_kind,label) VALUES ($1,$2,1,'INTERVIEW','Technical')", [randomUUID(), job.versionId]);
    await pool.query("INSERT INTO opportunity_eligibility_rules (id,opportunity_version_id,rule_type,comparator,value_numeric,is_blocking) VALUES ($1,$2,'MIN_CGPA','GTE',7,true)", [randomUUID(), job.versionId]);
    const response = await edit(employerId, recruiterId, job.id, { title: 'Platform engineer (backend)' }, 201);
    const next = response.body.version.id as string;
    for (const table of ['opportunity_skill_requirements', 'opportunity_selection_stages', 'opportunity_eligibility_rules']) {
      const counts = await pool.query(`SELECT opportunity_version_id, count(*)::int AS count FROM ${table} WHERE opportunity_version_id IN ($1,$2) GROUP BY 1`, [job.versionId, next]);
      expect(counts.rows).toHaveLength(2);
    }
    expect(response.body.version.change).toBe('EDITORIAL');
  });
});

describe('EMP-05: applicants acknowledge material changes before they progress', () => {
  it('asks each open applicant to accept a pay change, blocks progress and offers, and lets them through once they accept', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const first = await apply(job.id);
    const second = await apply(job.id);
    const withdrawn = await apply(job.id);
    await api().post('/api/v1/students/me/applications/' + withdrawn.applicationId + '/withdraw').set(auth(withdrawn.studentId)).send({}).expect(201);
    await transition(employerId, recruiterId, second.applicationId, 'SHORTLISTED').expect(201);

    const response = await edit(employerId, recruiterId, job.id, { compensationMin: 1000000 }, 201);
    const toVersionId = response.body.version.id as string;
    expect(response.body.version).toMatchObject({ change: 'MATERIAL', changedTerms: ['compensationMin'] });
    expect(response.body.applicants).toEqual({ termChangesRecorded: 2, acknowledgementsRequired: 2 });

    const rows = await pool.query('SELECT application_id, from_version_id, to_version_id, acknowledgement_required FROM opportunity_term_change_acknowledgements WHERE to_version_id=$1 ORDER BY application_id', [toVersionId]);
    expect(rows.rows).toEqual([first.applicationId, second.applicationId].sort().map((applicationId) => ({
      application_id: applicationId, from_version_id: job.versionId, to_version_id: toVersionId, acknowledgement_required: true })));
    const events = await pool.query("SELECT payload FROM outbox_events WHERE event_type='application.terms_change.recorded' AND payload->>'toVersionId'=$1", [toVersionId]);
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0].payload).toMatchObject({ opportunityId: job.id, toVersionId, acknowledgement: 'REQUIRED' });

    // Employer side: cannot advance or offer; the applicant list says why. Rejection stays possible.
    const blocked = await transition(employerId, recruiterId, first.applicationId, 'SHORTLISTED').expect(400);
    expect(blocked.body.error.code).toBe('TERMS_ACKNOWLEDGEMENT_REQUIRED');
    const applicants = await api().get(base(employerId) + '/' + job.id + '/applications').set(auth(recruiterId)).expect(200);
    expect(applicants.body.applications.filter((item: { termsAcknowledgementPending: boolean }) => item.termsAcknowledgementPending)).toHaveLength(2);
    const detail = await api().get(base(employerId) + '/' + job.id).set(auth(recruiterId)).expect(200);
    expect(detail.body.opportunity.awaitingAcknowledgementCount).toBe(2);
    expect(detail.body.versions[0]).toMatchObject({ versionNumber: 2, change: 'MATERIAL', changedTerms: ['compensationMin'] });

    // Student side: sees what moved, from their own application only.
    const listed = await api().get('/api/v1/students/me/applications').set(auth(first.studentId)).expect(200);
    expect(listed.body.applications[0]).toMatchObject({ id: first.applicationId, termsAcknowledgementPending: true });
    const change = await api().get('/api/v1/students/me/applications/' + first.applicationId + '/terms-change').set(auth(first.studentId)).expect(200);
    expect(change.body.termsChange).toMatchObject({ toVersionId, changedTerms: ['compensationMin'],
      appliedTerms: { compensation: { min: '1200000.00' } }, newTerms: { compensation: { min: '1000000.00' } } });
    await api().get('/api/v1/students/me/applications/' + first.applicationId + '/terms-change').set(auth(second.studentId)).expect(403);
    await api().post('/api/v1/students/me/applications/' + first.applicationId + '/terms-change/acknowledge').set(auth(second.studentId)).send({ toVersionId }).expect(403);

    // A stale acknowledgement (the employer changed the job again) is refused, not applied.
    const again = await edit(employerId, recruiterId, job.id, { compensationMin: 1100000 }, 201);
    const stale = await api().post('/api/v1/students/me/applications/' + first.applicationId + '/terms-change/acknowledge').set(auth(first.studentId)).send({ toVersionId }).expect(409);
    expect(stale.body.error.code).toBe('TERMS_CHANGED_AGAIN');
    await api().post('/api/v1/students/me/applications/' + first.applicationId + '/terms-change/acknowledge').set(auth(first.studentId))
      .send({ toVersionId: again.body.version.id, extra: true }).expect(400);
    await api().post('/api/v1/students/me/applications/' + first.applicationId + '/terms-change/acknowledge').set(auth(first.studentId))
      .send({ toVersionId: again.body.version.id }).expect(201);
    expect((await pool.query('SELECT count(*)::int AS count FROM opportunity_term_change_acknowledgements WHERE application_id=$1 AND acknowledged_at IS NULL', [first.applicationId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE action='application.terms_change.acknowledged' AND resource_id=$1", [first.applicationId])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='application.terms_change.acknowledged' AND aggregate_id=$1", [first.applicationId])).rows)
      .toEqual([{ payload: { applicationId: first.applicationId, toVersionId: again.body.version.id } }]);
    await transition(employerId, recruiterId, first.applicationId, 'SHORTLISTED').expect(201);
    expect((await api().get('/api/v1/students/me/applications/' + first.applicationId + '/terms-change').set(auth(first.studentId)).expect(200)).body.termsChange).toBeNull();

    // The one who has not accepted is still held at shortlisted, including for an offer.
    await transition(employerId, recruiterId, second.applicationId, 'INTERVIEW').expect(400);
    await transition(employerId, recruiterId, second.applicationId, 'REJECTED').expect(201);
  });

  it('withdraws the application when the applicant declines the new terms', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const applicant = await apply(job.id);
    const response = await edit(employerId, recruiterId, job.id, { workMode: 'REMOTE', locationCity: null }, 201);
    expect(response.body.version.changedTerms).toEqual(['workMode', 'locationCity']);
    await api().post('/api/v1/students/me/applications/' + applicant.applicationId + '/terms-change/decline').set(auth(applicant.studentId))
      .send({ toVersionId: response.body.version.id }).expect(201);
    const application = (await pool.query('SELECT state, closed_at, consent_revoked_at FROM applications WHERE id=$1', [applicant.applicationId])).rows[0];
    expect(application).toMatchObject({ state: 'WITHDRAWN', closed_at: expect.any(Date), consent_revoked_at: expect.any(Date) });
    expect((await pool.query('SELECT count(*)::int AS count FROM employer_applicant_access_grants WHERE student_user_id=$1 AND revoked_at IS NULL', [applicant.studentId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT reason_code FROM application_state_history WHERE application_id=$1 AND to_state='WITHDRAWN'", [applicant.applicationId])).rows).toEqual([{ reason_code: 'TERMS_DECLINED' }]);
    await transition(employerId, recruiterId, applicant.applicationId, 'SHORTLISTED').expect(400);
  });

  it('records a deadline-only change without blocking anyone', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId, { applicationDeadline: inADay() });
    const applicant = await apply(job.id);
    const response = await edit(employerId, recruiterId, job.id, { applicationDeadline: new Date(Date.now() + 2 * 86_400_000).toISOString() }, 201);
    expect(response.body.version).toMatchObject({ change: 'MATERIAL', changedTerms: ['applicationDeadline'] });
    expect(response.body.applicants).toEqual({ termChangesRecorded: 1, acknowledgementsRequired: 0 });
    expect((await pool.query('SELECT acknowledgement_required FROM opportunity_term_change_acknowledgements WHERE application_id=$1', [applicant.applicationId])).rows)
      .toEqual([{ acknowledgement_required: false }]);
    expect((await api().get('/api/v1/students/me/applications/' + applicant.applicationId + '/terms-change').set(auth(applicant.studentId)).expect(200)).body.termsChange).toBeNull();
    await transition(employerId, recruiterId, applicant.applicationId, 'SHORTLISTED').expect(201);
  });

  it('refuses stale, malformed, past-dated and payment-demanding edits, and edits to a withdrawn job', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const stale = await edit(employerId, recruiterId, job.id, { title: 'Renamed' }, 409, randomUUID());
    expect(stale.body.error.code).toBe('OPPORTUNITY_VERSION_CONFLICT');
    expect((await edit(employerId, recruiterId, job.id, { referenceCode: 'CHANGED' }, 400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await edit(employerId, recruiterId, job.id, { applicationDeadline: new Date(Date.now() - 60_000).toISOString() }, 400)).body.error.code).toBe('INVALID_APPLICATIONDEADLINE');
    await api().post(base(employerId) + '/' + job.id + '/versions').set(auth(recruiterId)).send({ ...baseTerms }).expect(400);
    const fee = await edit(employerId, recruiterId, job.id, { summary: 'Candidates must pay a registration fee of INR 2000 before the interview.' }, 400);
    expect(fee.body.error.code).toBe('OPPORTUNITY_PAYMENT_DEMAND');
    expect((await pool.query('SELECT count(*)::int AS count FROM opportunity_versions WHERE opportunity_id=$1', [job.id])).rows[0].count).toBe(1);

    const draft = await createJob(employerId, recruiterId);
    await api().post(base(employerId) + '/' + draft.id + '/withdraw').set(auth(recruiterId)).send({ reasonCode: 'POSTED_IN_ERROR' }).expect(201);
    expect((await edit(employerId, recruiterId, draft.id, { title: 'Too late' }, 400)).body.error.code).toBe('OPPORTUNITY_NOT_EDITABLE');
  });
});

describe('EMP-05: pause, close, reopen and withdraw', () => {
  it('pauses: students stop seeing and applying; reopening brings it back', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    expect(await listedToStudent(job.id)).toBe(true);
    const paused = await api().post(base(employerId) + '/' + job.id + '/pause').set(auth(recruiterId)).send({ reasonCode: 'REVIEWING_APPLICANTS' }).expect(201);
    expect(paused.body.opportunity).toEqual({ id: job.id, lifecycleState: 'PAUSED', reasonCode: 'REVIEWING_APPLICANTS' });
    expect(await listedToStudent(job.id)).toBe(false);
    await api().get('/api/v1/opportunities/' + job.id).set(auth(await user())).expect(403);
    const refused = await api().post('/api/v1/students/me/applications').set(auth(await user())).send({ opportunityId: job.id, consentGranted: true }).expect(400);
    expect(refused.body.error.code).toBe('OPPORTUNITY_NOT_OPEN');
    const audit = await pool.query("SELECT organization_id, context FROM audit_events WHERE action='opportunity.paused' AND resource_id=$1", [job.id]);
    expect(audit.rows).toEqual([{ organization_id: employerId, context: { fromState: 'PUBLISHED', toState: 'PAUSED', trigger: 'EMPLOYER', reasonCode: 'REVIEWING_APPLICANTS' } }]);
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='opportunity.lifecycle.changed' AND aggregate_id=$1", [job.id]);
    expect(outbox.rows).toEqual([{ payload: { opportunityId: job.id, employerId, fromState: 'PUBLISHED', toState: 'PAUSED', trigger: 'EMPLOYER', reasonCode: 'REVIEWING_APPLICANTS' } }]);

    await api().post(base(employerId) + '/' + job.id + '/pause').set(auth(recruiterId)).send({}).expect(400);
    await api().post(base(employerId) + '/' + job.id + '/reopen').set(auth(recruiterId)).send({}).expect(201);
    expect(await listedToStudent(job.id)).toBe(true);
    await apply(job.id);
  });

  it('closes with a reason code: no new applications, the existing applicants carry on, and reopening clears the close', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const applicant = await apply(job.id);
    expect((await api().post(base(employerId) + '/' + job.id + '/close').set(auth(recruiterId)).send({}).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    expect((await api().post(base(employerId) + '/' + job.id + '/close').set(auth(recruiterId)).send({ reasonCode: 'BECAUSE' }).expect(400)).body.error.code).toBe('INVALID_REASONCODE');
    expect((await api().post(base(employerId) + '/' + job.id + '/close').set(auth(recruiterId)).send({ reasonCode: 'POSITION_FILLED', note: 'x' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    await api().post(base(employerId) + '/' + job.id + '/close').set(auth(recruiterId)).send({ reasonCode: 'POSITION_FILLED' }).expect(201);
    expect(await lifecycle(job.id)).toMatchObject({ lifecycle_state: 'CLOSED', closed_at: expect.any(Date) });
    expect(await listedToStudent(job.id)).toBe(false);
    await api().post('/api/v1/students/me/applications').set(auth(await user())).send({ opportunityId: job.id, consentGranted: true }).expect(400);
    await transition(employerId, recruiterId, applicant.applicationId, 'SHORTLISTED').expect(201);
    const listed = await api().get(base(employerId)).set(auth(recruiterId)).expect(200);
    expect(listed.body.opportunities.find((item: { id: string }) => item.id === job.id)).toMatchObject({ lifecycleState: 'CLOSED', closedAt: expect.any(String), versionNumber: 1 });

    await api().post(base(employerId) + '/' + job.id + '/reopen').set(auth(recruiterId)).send({ reasonCode: 'POSITION_FILLED' }).expect(400);
    await api().post(base(employerId) + '/' + job.id + '/reopen').set(auth(recruiterId)).send({}).expect(201);
    expect(await lifecycle(job.id)).toMatchObject({ lifecycle_state: 'PUBLISHED', closed_at: null });
    const detail = await api().get(base(employerId) + '/' + job.id).set(auth(recruiterId)).expect(200);
    expect(detail.body.opportunity.lastLifecycleChange).toMatchObject({ action: 'opportunity.reopened', reasonCode: null });
  });

  it('withdraws only once every applicant is decided, and then never comes back', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const applicant = await apply(job.id);
    expect((await api().post(base(employerId) + '/' + job.id + '/withdraw').set(auth(recruiterId)).send({}).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    expect((await api().post(base(employerId) + '/' + job.id + '/withdraw').set(auth(recruiterId)).send({ reasonCode: 'ROLE_CANCELLED' }).expect(400)).body.error.code).toBe('OPPORTUNITY_HAS_OPEN_APPLICATIONS');
    await transition(employerId, recruiterId, applicant.applicationId, 'REJECTED').expect(201);
    await api().post(base(employerId) + '/' + job.id + '/withdraw').set(auth(recruiterId)).send({ reasonCode: 'ROLE_CANCELLED' }).expect(201);
    expect((await lifecycle(job.id)).lifecycle_state).toBe('WITHDRAWN');
    for (const action of ['reopen', 'pause'] as const) {
      const response = await api().post(base(employerId) + '/' + job.id + '/' + action).set(auth(recruiterId)).send({}).expect(400);
      expect(response.body.error.code).toBe('OPPORTUNITY_TRANSITION_NOT_ALLOWED');
    }
    await api().post(base(employerId) + '/' + job.id + '/publish').set(auth(recruiterId)).expect(400);
  });

  it('refuses transitions the lifecycle does not allow', async () => {
    const { employerId, recruiterId } = await employer();
    const draft = await createJob(employerId, recruiterId);
    for (const [action, body] of [['pause', {}], ['close', { reasonCode: 'POSITION_FILLED' }], ['reopen', {}]] as const) {
      const response = await api().post(base(employerId) + '/' + draft.id + '/' + action).set(auth(recruiterId)).send(body).expect(400);
      expect(response.body.error.code).toBe('OPPORTUNITY_TRANSITION_NOT_ALLOWED');
    }
    expect((await lifecycle(draft.id)).lifecycle_state).toBe('DRAFT');
  });
});

describe('EMP-05: jobs close when their deadline passes', () => {
  it('refuses to publish or reopen a job whose deadline has passed', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await createJob(employerId, recruiterId, { applicationDeadline: inAnHour() });
    await pool.query("UPDATE opportunity_versions SET application_deadline = now() - interval '1 minute' WHERE id=$1", [job.versionId]);
    expect((await api().post(base(employerId) + '/' + job.id + '/publish').set(auth(recruiterId)).expect(400)).body.error.code).toBe('OPPORTUNITY_DEADLINE_PASSED');
    expect((await lifecycle(job.id)).lifecycle_state).toBe('DRAFT');
  });

  it('queues the close at the deadline and closes once, idempotently; a moved deadline supersedes it', async () => {
    const { employerId, recruiterId } = await employer();
    const deadline = inAnHour();
    const job = await publishedJob(employerId, recruiterId, { applicationDeadline: deadline });
    const queued = await pool.query("SELECT id, payload, occurred_at, available_at, actor_user_id, organization_id, correlation_id FROM outbox_events WHERE event_type='opportunity.deadline_close.requested' AND aggregate_id=$1", [job.id]);
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]).toMatchObject({ payload: { opportunityId: job.id, versionId: job.versionId }, organization_id: employerId });
    expect((queued.rows[0].available_at as Date).toISOString()).toBe(deadline);
    // What the local dispatcher hands the consumer for this outbox row (ADR-028).
    const envelope = (row: Record<string, unknown>) => ({
      eventId: String(row.id), eventType: 'opportunity.deadline_close.requested', eventVersion: 1,
      occurredAt: new Date().toISOString(), producer: 'hiring', aggregateType: 'opportunity', aggregateId: job.id,
      actorId: String(row.actor_user_id), organizationId: employerId, correlationId: String(row.correlation_id),
      purpose: 'opportunity-deadline-close', dataClassification: 'internal' as const,
      schemaRef: 'registry://opportunity.deadline_close.requested/1', payload: row.payload as Record<string, unknown>,
    });

    // Delivered early (clock skew): it throws, so the outbox retries later.
    await expect(closeOpportunityAtDeadline(db, envelope(queued.rows[0]))).rejects.toThrow();
    expect((await lifecycle(job.id)).lifecycle_state).toBe('PUBLISHED');

    await pool.query("UPDATE opportunity_versions SET application_deadline = now() - interval '1 second' WHERE id=$1", [job.versionId]);
    expect(await closeOpportunityAtDeadline(db, envelope(queued.rows[0]))).toEqual({ executed: true, outcome: 'CLOSED' });
    expect(await lifecycle(job.id)).toMatchObject({ lifecycle_state: 'CLOSED', closed_at: expect.any(Date) });
    expect((await pool.query("SELECT organization_id, context FROM audit_events WHERE action='opportunity.closed' AND resource_id=$1", [job.id])).rows)
      .toEqual([{ organization_id: employerId, context: expect.objectContaining({ reasonCode: 'DEADLINE_PASSED', trigger: 'DEADLINE' }) }]);
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='opportunity.lifecycle.changed' AND aggregate_id=$1", [job.id])).rows)
      .toEqual([{ payload: { opportunityId: job.id, employerId, fromState: 'PUBLISHED', toState: 'CLOSED', trigger: 'DEADLINE', reasonCode: 'DEADLINE_PASSED' } }]);
    // A replay does nothing.
    expect(await closeOpportunityAtDeadline(db, envelope(queued.rows[0]))).toEqual({ executed: false });

    // Moving the deadline and reopening queues a new close; the old event is superseded.
    const moved = await edit(employerId, recruiterId, job.id, { applicationDeadline: inADay() }, 201);
    await api().post(base(employerId) + '/' + job.id + '/reopen').set(auth(recruiterId)).send({}).expect(201);
    const second = await pool.query("SELECT id, payload, actor_user_id, correlation_id FROM outbox_events WHERE event_type='opportunity.deadline_close.requested' AND aggregate_id=$1 AND payload->>'versionId'=$2", [job.id, moved.body.version.id]);
    expect(second.rows.length).toBeGreaterThanOrEqual(1);
    const stale = await pool.query("SELECT id, payload, actor_user_id, correlation_id FROM outbox_events WHERE event_type='opportunity.deadline_close.requested' AND aggregate_id=$1 AND payload->>'versionId'=$2", [job.id, job.versionId]);
    await pool.query('DELETE FROM event_consumer_receipts WHERE event_id=$1', [stale.rows[0].id]);
    expect(await closeOpportunityAtDeadline(db, envelope(stale.rows[0]))).toEqual({ executed: true, outcome: 'SUPERSEDED' });
    expect((await lifecycle(job.id)).lifecycle_state).toBe('PUBLISHED');
  });
});

describe('EMP-05: §6.3 authorisation on every lifecycle route', () => {
  function routes(employerId: string, opportunityId: string) {
    const path = base(employerId) + '/' + opportunityId;
    return [
      { method: 'get', path, body: undefined, group: 'draft' },
      { method: 'post', path: path + '/versions', body: { ...baseTerms, expectedCurrentVersionId: randomUUID() }, group: 'draft' },
      { method: 'post', path: path + '/pause', body: {}, group: 'publish' },
      { method: 'post', path: path + '/close', body: { reasonCode: 'POSITION_FILLED' }, group: 'publish' },
      { method: 'post', path: path + '/reopen', body: {}, group: 'publish' },
      { method: 'post', path: path + '/withdraw', body: { reasonCode: 'POSTED_IN_ERROR' }, group: 'draft' },
    ] as const;
  }
  const call = (route: ReturnType<typeof routes>[number], userId?: string) => {
    const pending = route.method === 'get' ? api().get(route.path) : api().post(route.path).send(route.body);
    return userId ? pending.set(auth(userId)) : pending;
  };

  it('401 without a token, 403 for another employer, an ended membership and a non-employer role', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const other = await employer();
    const ended = await user(); await membership(ended, employerId, 'RECRUITER', 'ENDED');
    for (const route of routes(employerId, job.id)) {
      await call(route).expect(401);
      await call(route, other.recruiterId).expect(403);
      await call(route, ended).expect(403);
    }
    // Another employer's job through the caller's own employer path: not found is forbidden.
    for (const route of routes(other.employerId, job.id)) await call(route, other.recruiterId).expect(403);
    expect((await lifecycle(job.id)).lifecycle_state).toBe('PUBLISHED');
  });

  it.each([['SUSPENDED', false], ['REJECTED', true]] as const)('refuses every lifecycle route to a %s organisation', async (verification, active) => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    await pool.query('UPDATE organizations SET verification_state=$2::verification_state, active=$3 WHERE id=$1', [employerId, verification, active]);
    for (const route of routes(employerId, job.id)) {
      const response = await call(route, recruiterId);
      expect({ path: route.path, status: response.status, code: response.body?.error?.code }).toEqual({ path: route.path, status: 403, code: 'EMPLOYER_ORGANISATION_INACTIVE' });
    }
  });

  it('lets a PENDING organisation edit and withdraw its drafts, but not pause, close or reopen', async () => {
    const { employerId, recruiterId } = await employer('PENDING');
    const draft = await createJob(employerId, recruiterId);
    await api().get(base(employerId) + '/' + draft.id).set(auth(recruiterId)).expect(200);
    await edit(employerId, recruiterId, draft.id, { title: 'Draft, renamed' }, 201);
    for (const [action, body] of [['pause', {}], ['close', { reasonCode: 'POSITION_FILLED' }], ['reopen', {}]] as const) {
      expect((await api().post(base(employerId) + '/' + draft.id + '/' + action).set(auth(recruiterId)).send(body).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
    }
    await api().post(base(employerId) + '/' + draft.id + '/withdraw').set(auth(recruiterId)).send({ reasonCode: 'POSTED_IN_ERROR' }).expect(201);
  });

  it('returns no readiness, score or gap field in the detail response', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    await apply(job.id);
    const detail = await api().get(base(employerId) + '/' + job.id).set(auth(recruiterId)).expect(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/readiness|score|mastery|gapStatus|"band"/i);
  });
});

describe('EMP-05: no lifecycle write races a suspension, and no apply races a close (EMP-SR-15)', () => {
  it('refuses a reopen that was waiting on a suspension that then committed', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    await api().post(base(employerId) + '/' + job.id + '/pause').set(auth(recruiterId)).send({}).expect(201);
    const suspension = await pool.connect();
    try {
      await suspension.query('BEGIN');
      await suspension.query("UPDATE organizations SET verification_state='SUSPENDED', active=false WHERE id=$1", [employerId]);
      // The route's own guard reads the committed state (still VERIFIED) and passes; its
      // locked re-read then waits for this transaction.
      const pending = api().post(base(employerId) + '/' + job.id + '/reopen').set(auth(recruiterId)).send({}).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await suspension.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    } finally { suspension.release(); }
    expect((await lifecycle(job.id)).lifecycle_state).toBe('PAUSED');
  });

  it('refuses an application that was waiting on a close that then committed', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const student = await user();
    const closing = await pool.connect();
    try {
      await closing.query('BEGIN');
      await closing.query("UPDATE opportunities SET lifecycle_state='CLOSED', closed_at=now() WHERE id=$1", [job.id]);
      const pending = api().post('/api/v1/students/me/applications').set(auth(student)).send({ opportunityId: job.id, consentGranted: true }).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await closing.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('OPPORTUNITY_NOT_OPEN');
    } finally { closing.release(); }
    expect((await pool.query('SELECT count(*)::int AS count FROM applications WHERE opportunity_id=$1', [job.id])).rows[0].count).toBe(0);
  });

  it('binds an application that waited on an edit to the new version, with no term change owed', async () => {
    const { employerId, recruiterId } = await employer();
    const job = await publishedJob(employerId, recruiterId);
    const student = await user();
    const editing = await pool.connect();
    const newVersionId = randomUUID();
    try {
      await editing.query('BEGIN');
      await editing.query(`INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,location_city,compensation_disclosed,material_terms_hash,created_by_user_id)
        VALUES ($1,$2,2,'Platform engineer','FULL_TIME','ONSITE','Bengaluru',false,repeat('1',64),$3)`, [newVersionId, job.id, recruiterId]);
      await editing.query('UPDATE opportunities SET current_version_id=$1 WHERE id=$2', [newVersionId, job.id]);
      const pending = api().post('/api/v1/students/me/applications').set(auth(student)).send({ opportunityId: job.id, consentGranted: true }).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await editing.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(201);
      expect((await pool.query('SELECT applied_version_id FROM applications WHERE id=$1', [response.body.application.id])).rows[0].applied_version_id).toBe(newVersionId);
    } finally { editing.release(); }
  });
});
