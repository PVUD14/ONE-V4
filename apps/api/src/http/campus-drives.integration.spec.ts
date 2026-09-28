/**
 * Campus drives with placement-office approval (EMP-11, ADR-038).
 *
 * An employer asks to run one of its jobs at a college; the job reaches that college's students
 * only while the college has approved the drive. The college's one-offer policy is enforced at
 * apply for every application linked to its drive, and the student is told why. When a drive
 * completes, the college sees suppressed counts and named results only for students who shared
 * that application with it. These specs pin both sides, the §6.3 minimums and the contract (no
 * readiness, no compensation to the college).
 *
 * Runs over real HTTP with a stub verifier in a throwaway schema of the local Postgres in DATABASE_URL.
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
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for campus drive tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Campus drive tests require local Postgres');
const schemaName = 'campus_drives_' + randomUUID().replaceAll('-', '');
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
}, 120_000);

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function employer(verification = 'VERIFIED', active = true) {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Synthetic Drive Employer',$2,$3)", [employerId, verification, active]);
  const recruiterId = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,'RECRUITER','ACTIVE',$2,$2)`, [randomUUID(), employerId, recruiterId]);
  return { employerId, recruiterId };
}
interface College { institutionId: string; departmentId: string; admin: string; officer: string; campusOfficer: string; head: string; faculty: string }
async function staff(institutionId: string, role: string, department: string | null = null): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [randomUUID(), institutionId, id, role, department]);
  return id;
}
async function college(verification = 'VERIFIED'): Promise<College> {
  const institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute of Technology',$2,true)", [institutionId, verification]);
  const departmentId = randomUUID();
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Computer Science')", [departmentId, institutionId]);
  return {
    institutionId, departmentId,
    admin: await staff(institutionId, 'INSTITUTION_ADMIN'),
    officer: await staff(institutionId, 'PLACEMENT_ADMIN'),
    campusOfficer: await staff(institutionId, 'PLACEMENT_ADMIN', departmentId),
    head: await staff(institutionId, 'DEPARTMENT_HEAD', departmentId),
    faculty: await staff(institutionId, 'FACULTY_LECTURER'),
  };
}
async function student(of: College, name = 'Synthetic Student'): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)`, [randomUUID(), of.institutionId, id, 'R-' + id.slice(0, 8), name, of.departmentId]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE','2020-01-01T00:00:00Z')`, [randomUUID(), of.institutionId, id]);
  return id;
}
/** An accepted offer (or a hire) for `studentId` from some other employer's job. */
async function acceptedOffer(studentId: string, applicationState = 'OFFER'): Promise<void> {
  const other = await employer();
  const opportunity = randomUUID(); const version = randomUUID(); const application = randomUUID();
  await pool.query("INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)", [opportunity, other.employerId, other.recruiterId, 'OFF-' + opportunity.slice(0, 8)]);
  await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,'Earlier role','FULL_TIME','REMOTE',$3,$4)", [version, opportunity, '0'.repeat(64), other.recruiterId]);
  const closed = ['HIRED', 'REJECTED', 'WITHDRAWN'].includes(applicationState) ? 'now()' : 'NULL';
  await pool.query(`INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,closed_at)
    VALUES ($1,$2,$3,$4,$5,$6,now(),now(),${closed})`, [application, opportunity, other.employerId, version, studentId, applicationState]);
  await pool.query(`INSERT INTO offers (id,application_id,employer_id,state,compensation_currency,compensation_amount,compensation_period,offer_expires_at,extended_at,responded_at,created_by_user_id)
    VALUES ($1,$2,$3,'ACCEPTED','INR',900000,'YEAR',now() + interval '10 days',now(),now(),$4)`, [randomUUID(), application, other.employerId, other.recruiterId]);
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const jobs = (employerId: string) => '/api/v1/employers/' + employerId + '/opportunities';
const employerDrives = (employerId: string) => '/api/v1/employers/' + employerId + '/campus-drives';
const collegeDrives = (institutionId: string) => '/api/v1/institutions/' + institutionId + '/campus-drives';
const policies = (institutionId: string) => '/api/v1/institutions/' + institutionId + '/placement-policies';
const terms = {
  title: 'Graduate engineer', summary: 'Build things.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai',
  compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: 800000, compensationPeriod: 'YEAR',
};
const noReadiness = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/readiness|mastery|gapStatus|fitScore|"score"/i);
const noCompensation = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/compensation|salary|stipend|900000|800000/i);

/** A job with no audience of its own (drive-only unless `publicAudience`). */
async function job(employerId: string, recruiterId: string, publicAudience = false): Promise<string> {
  const created = await api().post(jobs(employerId)).set(auth(recruiterId)).send({ referenceCode: 'CD-' + randomUUID().slice(0, 8), ...terms }).expect(201);
  const id = created.body.opportunity.id as string;
  if (publicAudience) await api().post(jobs(employerId) + '/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  return id;
}
function requestDrive(employerId: string, recruiterId: string, opportunityId: string, body: Record<string, unknown>) {
  return api().post(jobs(employerId) + '/' + opportunityId + '/campus-drives').set(auth(recruiterId)).send(body);
}
async function driveRow(id: string): Promise<{ state: string; revision: number }> {
  return (await pool.query('SELECT state, revision FROM campus_drives WHERE id=$1', [id])).rows[0];
}
function decide(institutionId: string, actor: string, driveId: string, action: string, body: Record<string, unknown>) {
  return api().post(collegeDrives(institutionId) + '/' + driveId + '/' + action).set(auth(actor)).send(body);
}
function applyAs(studentId: string, opportunityId: string, shareWithCollege = false) {
  return api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ opportunityId, consentGranted: true, institutionVisibilityGranted: shareWithCollege });
}
async function listed(studentId: string, opportunityId: string): Promise<Record<string, unknown> | undefined> {
  const response = await api().get('/api/v1/opportunities').set(auth(studentId)).expect(200);
  return (response.body.opportunities as Record<string, unknown>[]).find((row) => row.id === opportunityId);
}
/** A drive-only job, published, with a drive the college has approved. */
async function approvedDrive(of: College, options: { publicAudience?: boolean; offerHoldersEligible?: boolean } = {}) {
  const { employerId, recruiterId } = await employer();
  const opportunityId = await job(employerId, recruiterId, options.publicAudience ?? false);
  const requested = await requestDrive(employerId, recruiterId, opportunityId, { institutionId: of.institutionId }).expect(201);
  const driveId = requested.body.drive.id as string;
  await api().post(jobs(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);
  await decide(of.institutionId, of.officer, driveId, 'approve', { revision: 1, ...(options.offerHoldersEligible ? { offerHoldersEligible: true } : {}) }).expect(201);
  return { employerId, recruiterId, opportunityId, driveId };
}

describe('EMP-11: a drive goes live only with the placement office\'s approval', () => {
  it('keeps a published drive-only job from the college\'s students until the college approves, and from everyone else after', async () => {
    const campus = await college();
    const elsewhere = await college();
    const { employerId, recruiterId } = await employer();
    const opportunityId = await job(employerId, recruiterId);
    const mine = await student(campus);
    const outsider = await student(elsewhere);

    // No audience and no drive: nothing to publish to (unchanged rule).
    const refused = await api().post(jobs(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(400);
    expect(refused.body.error.code).toBe('AUDIENCE_REQUIRED');

    const requested = await requestDrive(employerId, recruiterId, opportunityId, {
      institutionId: campus.institutionId, proposedStartAt: '2027-01-10T04:30:00.000Z', proposedEndAt: '2027-01-10T11:30:00.000Z',
      venueMode: 'ON_CAMPUS', note: 'Two rounds on the day.',
    }).expect(201);
    const driveId = requested.body.drive.id as string;
    expect(requested.body.drive).toMatchObject({ state: 'REQUESTED', revision: 1, institutionName: 'Synthetic Institute of Technology', venueMode: 'ON_CAMPUS' });

    // A pending drive counts as the job's audience, so the employer may publish — and still nobody sees it.
    await api().post(jobs(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);
    expect(await listed(mine, opportunityId)).toBeUndefined();
    await api().get('/api/v1/opportunities/' + opportunityId).set(auth(mine)).expect(403);
    await applyAs(mine, opportunityId).expect(403);

    // The college's queue shows it; the placement officer approves with a schedule.
    const queue = await api().get(collegeDrives(campus.institutionId)).set(auth(campus.officer)).expect(200);
    expect(queue.body.drives.map((drive: { id: string }) => drive.id)).toContain(driveId);
    expect(queue.body.drives[0]).toMatchObject({ employerName: 'Synthetic Drive Employer', opportunityTitle: 'Graduate engineer', state: 'REQUESTED' });
    noReadiness(queue.body); noCompensation(queue.body);
    const approved = await decide(campus.institutionId, campus.officer, driveId, 'approve', {
      revision: 1, scheduledStartAt: '2027-01-12T04:30:00.000Z', scheduledEndAt: '2027-01-12T11:30:00.000Z', note: 'Seminar hall booked.',
    }).expect(201);
    expect(approved.body.drive).toMatchObject({ state: 'SCHEDULED', revision: 2 });

    const seen = await listed(mine, opportunityId);
    expect(seen?.campusDrives).toEqual([expect.objectContaining({ institutionName: 'Synthetic Institute of Technology', state: 'SCHEDULED' })]);
    const detail = await api().get('/api/v1/opportunities/' + opportunityId).set(auth(mine)).expect(200);
    expect(detail.body.campusDrives[0]).toMatchObject({ institutionName: 'Synthetic Institute of Technology', scheduledStartAt: '2027-01-12T04:30:00.000Z', placementPolicy: null, blocksYou: false });
    expect(await listed(outsider, opportunityId)).toBeUndefined();
    await applyAs(outsider, opportunityId).expect(403);

    const applied = await applyAs(mine, opportunityId).expect(201);
    const link = await pool.query('SELECT campus_drive_id FROM campus_drive_applications WHERE application_id=$1', [applied.body.application.id]);
    expect(link.rows).toEqual([{ campus_drive_id: driveId }]);
    const applications = await api().get('/api/v1/students/me/applications').set(auth(mine)).expect(200);
    expect(applications.body.applications[0].campusDrive).toMatchObject({ institutionName: 'Synthetic Institute of Technology' });

    // The employer sees the decision and the schedule.
    const employerView = await api().get(employerDrives(employerId)).query({ opportunityId }).set(auth(recruiterId)).expect(200);
    expect(employerView.body.drives[0]).toMatchObject({ state: 'SCHEDULED', scheduledStartAt: '2027-01-12T04:30:00.000Z', decision: expect.objectContaining({ note: 'Seminar hall booked.' }), applicationCount: 1 });
    noReadiness(employerView.body);

    // The college withdraws its approval: the route closes on the next request; the application stands.
    await decide(campus.institutionId, campus.officer, driveId, 'cancel', { revision: 2, reasonCode: 'SCHEDULE_UNWORKABLE' }).expect(201);
    const another = await student(campus);
    expect(await listed(another, opportunityId)).toBeUndefined();
    expect((await pool.query('SELECT state FROM applications WHERE id=$1', [applied.body.application.id])).rows[0].state).toBe('APPLIED');
  });

  it('gives the employer no way to make a drive live, and lets the college reject or ask for changes with a reason', async () => {
    const campus = await college();
    const { employerId, recruiterId } = await employer();
    const opportunityId = await job(employerId, recruiterId);
    const driveId = (await requestDrive(employerId, recruiterId, opportunityId, { institutionId: campus.institutionId }).expect(201)).body.drive.id as string;
    // Employer routes that do not exist or do not apply here.
    await api().post(employerDrives(employerId) + '/' + driveId + '/approve').set(auth(recruiterId)).send({ revision: 1 }).expect(404);
    const early = await api().post(employerDrives(employerId) + '/' + driveId + '/complete').set(auth(recruiterId)).send({ revision: 1 }).expect(400);
    expect(early.body.error.code).toBe('CAMPUS_DRIVE_TRANSITION_NOT_ALLOWED');
    // The employer cannot decide on the college's side either.
    await decide(campus.institutionId, recruiterId, driveId, 'approve', { revision: 1 }).expect(403);

    const noReason = await decide(campus.institutionId, campus.officer, driveId, 'request-changes', { revision: 1 }).expect(400);
    expect(noReason.body.error.code).toBe('INVALID_REASON_CODE');
    await decide(campus.institutionId, campus.officer, driveId, 'request-changes', { revision: 1, reasonCode: 'NOT_A_REASON' }).expect(400);
    await decide(campus.institutionId, campus.officer, driveId, 'request-changes', { revision: 1, reasonCode: 'SCHEDULE_CHANGE_NEEDED', note: 'Exams that week.' }).expect(201);
    const view = await api().get(employerDrives(employerId)).set(auth(recruiterId)).expect(200);
    expect(view.body.drives[0]).toMatchObject({ state: 'CHANGES_REQUESTED', decision: { reasonCode: 'SCHEDULE_CHANGE_NEEDED', note: 'Exams that week.' }, availableActions: ['RESUBMIT', 'CANCEL'] });
    await api().post(employerDrives(employerId) + '/' + driveId + '/resubmit').set(auth(recruiterId))
      .send({ revision: 2, proposedStartAt: '2027-02-01T04:30:00.000Z', note: 'Moved to February.' }).expect(201);
    await decide(campus.institutionId, campus.officer, driveId, 'reject', { revision: 3, reasonCode: 'SEASON_CLOSED' }).expect(201);
    expect((await driveRow(driveId)).state).toBe('REJECTED');

    const history = await api().get(collegeDrives(campus.institutionId) + '/' + driveId + '/history').set(auth(campus.officer)).expect(200);
    expect(history.body.history.map((row: { toState: string; actorSide: string; reasonCode: string | null }) => [row.toState, row.actorSide, row.reasonCode])).toEqual([
      ['REQUESTED', 'EMPLOYER', null], ['CHANGES_REQUESTED', 'INSTITUTION', 'SCHEDULE_CHANGE_NEEDED'], ['REQUESTED', 'EMPLOYER', null], ['REJECTED', 'INSTITUTION', 'SEASON_CLOSED'],
    ]);
    await expect(pool.query('UPDATE campus_drive_state_history SET note = NULL WHERE campus_drive_id=$1', [driveId])).rejects.toThrow(/append-only/);
    const audit = await pool.query("SELECT action, organization_id, context FROM audit_events WHERE resource_type='campus_drive' AND resource_id=$1 ORDER BY occurred_at", [driveId]);
    expect(audit.rows.map((row) => row.action)).toEqual(['campus_drive.requested', 'campus_drive.changes_requested', 'campus_drive.resubmitted', 'campus_drive.rejected']);
    expect(audit.rows[1].organization_id).toBe(campus.institutionId);
    expect(audit.rows[1].context.reasonCode).toBe('SCHEDULE_CHANGE_NEEDED');
    expect(audit.rows[0].organization_id).toBe(employerId);
    const outbox = await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='campus_drive.state_changed' AND aggregate_id=$1", [driveId]);
    expect(outbox.rows[0].n).toBe(4);

    // A new request is possible once the old one has ended; two live ones for the same college are not.
    await requestDrive(employerId, recruiterId, opportunityId, { institutionId: campus.institutionId }).expect(201);
    const duplicate = await requestDrive(employerId, recruiterId, opportunityId, { institutionId: campus.institutionId }).expect(409);
    expect(duplicate.body.error.code).toBe('CAMPUS_DRIVE_ALREADY_OPEN');
  });
});

describe('EMP-11: the college\'s one-offer policy at apply', () => {
  it('blocks a student with an accepted offer from further drive applications and says why; others apply', async () => {
    const campus = await college();
    await api().post(policies(campus.institutionId)).set(auth(campus.admin)).send({ policyType: 'ONE_OFFER_PER_STUDENT', note: 'One offer per student this season.' }).expect(201);
    const { opportunityId, driveId } = await approvedDrive(campus);
    const placed = await student(campus);
    const hired = await student(campus);
    const free = await student(campus);
    await acceptedOffer(placed);
    await acceptedOffer(hired, 'HIRED');

    const detail = await api().get('/api/v1/opportunities/' + opportunityId).set(auth(placed)).expect(200);
    expect(detail.body.campusDrives[0]).toMatchObject({ placementPolicy: { policyType: 'ONE_OFFER_PER_STUDENT', note: 'One offer per student this season.' }, blocksYou: true });
    const refused = await applyAs(placed, opportunityId).expect(400);
    expect(refused.body.error).toMatchObject({ code: 'PLACEMENT_POLICY_ONE_OFFER', institutionName: 'Synthetic Institute of Technology' });
    expect((await pool.query('SELECT count(*)::int AS n FROM applications WHERE student_user_id=$1 AND opportunity_id=$2', [placed, opportunityId])).rows[0].n).toBe(0);
    expect((await applyAs(hired, opportunityId).expect(400)).body.error.code).toBe('PLACEMENT_POLICY_ONE_OFFER');

    const ok = await applyAs(free, opportunityId).expect(201);
    const link = await pool.query('SELECT campus_drive_id, placement_policy_id FROM campus_drive_applications WHERE application_id=$1', [ok.body.application.id]);
    expect(link.rows[0].campus_drive_id).toBe(driveId);
    expect(link.rows[0].placement_policy_id).not.toBeNull();

    // Decision 10.2 #11: the college's rule governs its drives only, not a public job elsewhere.
    const { employerId: publicEmployer, recruiterId: publicRecruiter } = await employer();
    const publicJob = await job(publicEmployer, publicRecruiter, true);
    await api().post(jobs(publicEmployer) + '/' + publicJob + '/publish').set(auth(publicRecruiter)).expect(201);
    await applyAs(placed, publicJob).expect(201);
  });

  it('applies the policy to a public job that also runs as a drive at the college, and honours a drive exception', async () => {
    const campus = await college();
    await api().post(policies(campus.institutionId)).set(auth(campus.officer)).send({ policyType: 'ONE_OFFER_PER_STUDENT', allowDriveExceptions: true }).expect(201);
    const both = await approvedDrive(campus, { publicAudience: true });
    const placed = await student(campus);
    await acceptedOffer(placed);
    // Through the public listing or not, a live drive at the student's college governs the application.
    expect((await applyAs(placed, both.opportunityId).expect(400)).body.error.code).toBe('PLACEMENT_POLICY_ONE_OFFER');

    const dream = await approvedDrive(campus, { offerHoldersEligible: true });
    const detail = await api().get('/api/v1/opportunities/' + dream.opportunityId).set(auth(placed)).expect(200);
    expect(detail.body.campusDrives[0]).toMatchObject({ offerHoldersEligible: true, blocksYou: false });
    await applyAs(placed, dream.opportunityId).expect(201);

    // Retiring the policy (with a reason) lifts it; a policy row can only be retired.
    const list = await api().get(policies(campus.institutionId)).set(auth(campus.officer)).expect(200);
    const policyId = list.body.policies[0].id as string;
    await api().post(policies(campus.institutionId) + '/' + policyId + '/retire').set(auth(campus.officer)).send({ reasonCode: 'NOPE' }).expect(400);
    await api().post(policies(campus.institutionId) + '/' + policyId + '/retire').set(auth(campus.officer)).send({ reasonCode: 'SEASON_ENDED' }).expect(201);
    await expect(pool.query("UPDATE institution_placement_policies SET note='x' WHERE id=$1", [policyId])).rejects.toThrow(/only be retired/);
    await applyAs(placed, both.opportunityId).expect(201);
  });
});

describe('EMP-11: results come back to the college, named only where the student shared', () => {
  it('shows suppressed counts after completion and named results only for shared applications in scope, audited', async () => {
    const campus = await college();
    const { employerId, recruiterId, opportunityId, driveId } = await approvedDrive(campus);
    const names = ['Asha Synthetic', 'Bala Synthetic', 'Chitra Synthetic', 'Devi Synthetic', 'Ezhil Synthetic', 'Farah Synthetic'];
    const applicants: { id: string; application: string }[] = [];
    for (const [index, name] of names.entries()) {
      const id = await student(campus, name);
      const applied = await applyAs(id, opportunityId, index < 2).expect(201);
      applicants.push({ id, application: applied.body.application.id });
    }
    // The employer moves one shared and one unshared applicant to an extended offer.
    for (const target of [applicants[0]!, applicants[3]!]) {
      await pool.query("UPDATE applications SET state='OFFER' WHERE id=$1", [target.application]);
      await pool.query(`INSERT INTO offers (id,application_id,employer_id,state,compensation_currency,compensation_amount,compensation_period,offer_expires_at,extended_at,created_by_user_id)
        VALUES ($1,$2,$3,'EXTENDED','INR',900000,'YEAR',now() + interval '10 days',now(),$4)`, [randomUUID(), target.application, employerId, recruiterId]);
    }

    const live = await api().get(collegeDrives(campus.institutionId) + '/' + driveId + '/results').set(auth(campus.officer)).expect(200);
    expect(live.body.results.counts).toBeNull();
    expect(live.body.results.named.map((row: { fullName: string }) => row.fullName).sort()).toEqual(['Asha Synthetic', 'Bala Synthetic']);

    await api().post(employerDrives(employerId) + '/' + driveId + '/complete').set(auth(recruiterId)).send({ revision: 2 }).expect(201);
    const done = await api().get(collegeDrives(campus.institutionId) + '/' + driveId + '/results').set(auth(campus.officer)).expect(200);
    expect(done.body.results.counts).toEqual({
      applied: { suppressed: false, value: 6 },
      offered: { suppressed: true, value: null },
      selected: { suppressed: true, value: null },
    });
    const named = done.body.results.named as { fullName: string; applicationState: string; offerState: string | null }[];
    expect(named.map((row) => [row.fullName, row.applicationState, row.offerState]).sort()).toEqual([
      ['Asha Synthetic', 'OFFER', 'EXTENDED'], ['Bala Synthetic', 'APPLIED', null],
    ]);
    noReadiness(done.body); noCompensation(done.body);

    // Revoking visibility removes the name on the next request.
    await api().post('/api/v1/students/me/applications/' + applicants[1]!.application + '/institution-visibility/revoke').set(auth(applicants[1]!.id)).expect(201);
    const after = await api().get(collegeDrives(campus.institutionId) + '/' + driveId + '/results').set(auth(campus.officer)).expect(200);
    expect(after.body.results.named.map((row: { fullName: string }) => row.fullName)).toEqual(['Asha Synthetic']);

    const audit = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='institution.campus_drive_results.read' AND resource_id=$1 AND organization_id=$2", [driveId, campus.institutionId]);
    expect(audit.rows[0].n).toBe(3);
    // Faculty cannot read drives at all.
    await api().get(collegeDrives(campus.institutionId) + '/' + driveId + '/results').set(auth(campus.faculty)).expect(403);
  });
});

describe('EMP-11: §6.3 minimums on both sides', () => {
  it('refuses callers without a token, from another organisation, and employers not in good standing', async () => {
    const campus = await college();
    const { employerId, recruiterId } = await employer();
    const opportunityId = await job(employerId, recruiterId);
    await api().get(employerDrives(employerId)).expect(401);
    await api().get(collegeDrives(campus.institutionId)).expect(401);
    const stranger = await employer();
    await requestDrive(employerId, stranger.recruiterId, opportunityId, { institutionId: campus.institutionId }).expect(403);
    await api().get(employerDrives(employerId)).set(auth(stranger.recruiterId)).expect(403);

    const pending = await employer('PENDING');
    const pendingJob = await job(pending.employerId, pending.recruiterId);
    const unverified = await requestDrive(pending.employerId, pending.recruiterId, pendingJob, { institutionId: campus.institutionId }).expect(403);
    expect(unverified.body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
    const driveId = (await requestDrive(employerId, recruiterId, opportunityId, { institutionId: campus.institutionId }).expect(201)).body.drive.id as string;
    await pool.query("UPDATE organizations SET verification_state='SUSPENDED', active=false WHERE id=$1", [employerId]);
    const inactive = await api().post(employerDrives(employerId) + '/' + driveId + '/cancel').set(auth(recruiterId)).send({ revision: 1, reasonCode: 'HIRING_ON_HOLD' }).expect(403);
    expect(inactive.body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    // The college may not approve a drive for an employer that is no longer in good standing.
    const blocked = await decide(campus.institutionId, campus.officer, driveId, 'approve', { revision: 1 }).expect(409);
    expect(blocked.body.error.code).toBe('CAMPUS_DRIVE_EMPLOYER_NOT_IN_GOOD_STANDING');
  });

  it('lets only institution-wide placement staff decide, and validates every write', async () => {
    const campus = await college();
    const other = await college();
    const { employerId, recruiterId } = await employer();
    const opportunityId = await job(employerId, recruiterId);

    // The college must be a verified, active institution; unknown fields are refused.
    const unverifiedCollege = await college('PENDING');
    expect((await requestDrive(employerId, recruiterId, opportunityId, { institutionId: unverifiedCollege.institutionId }).expect(400)).body.error.code).toBe('CAMPUS_DRIVE_INSTITUTION_UNAVAILABLE');
    expect((await requestDrive(employerId, recruiterId, opportunityId, { institutionId: employerId }).expect(400)).body.error.code).toBe('CAMPUS_DRIVE_INSTITUTION_UNAVAILABLE');
    expect((await requestDrive(employerId, recruiterId, opportunityId, { institutionId: campus.institutionId, surprise: true }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    await requestDrive(employerId, recruiterId, opportunityId, { institutionId: campus.institutionId, proposedStartAt: '2027-01-10T10:00:00.000Z', proposedEndAt: '2027-01-10T09:00:00.000Z' }).expect(400);
    await requestDrive(employerId, recruiterId, opportunityId, { institutionId: campus.institutionId, venueMode: 'MOON' }).expect(400);
    const directory = await api().get(employerDrives(employerId).replace('campus-drives', 'campus-drive-institutions')).query({ q: 'Synthetic' }).set(auth(recruiterId)).expect(200);
    expect(directory.body.institutions.map((row: { id: string }) => row.id)).toContain(campus.institutionId);
    expect(directory.body.institutions.map((row: { id: string }) => row.id)).not.toContain(unverifiedCollege.institutionId);

    const driveId = (await requestDrive(employerId, recruiterId, opportunityId, { institutionId: campus.institutionId }).expect(201)).body.drive.id as string;
    // Read: owners, admins, placement admins and department heads; never faculty or another college.
    await api().get(collegeDrives(campus.institutionId)).set(auth(campus.head)).expect(200);
    await api().get(collegeDrives(campus.institutionId)).set(auth(campus.faculty)).expect(403);
    const otherList = await api().get(collegeDrives(other.institutionId)).set(auth(other.officer)).expect(200);
    expect(otherList.body.drives).toEqual([]);
    await decide(other.institutionId, other.officer, driveId, 'approve', { revision: 1 }).expect(403);
    await decide(campus.institutionId, other.admin, driveId, 'approve', { revision: 1 }).expect(403);
    // Decide: never a department head or faculty; a placement admin narrowed to one department reads but does not decide.
    await decide(campus.institutionId, campus.head, driveId, 'approve', { revision: 1 }).expect(403);
    await decide(campus.institutionId, campus.faculty, driveId, 'approve', { revision: 1 }).expect(403);
    await api().get(collegeDrives(campus.institutionId)).set(auth(campus.campusOfficer)).expect(200);
    const narrowed = await decide(campus.institutionId, campus.campusOfficer, driveId, 'approve', { revision: 1 }).expect(403);
    expect(narrowed.body.error.code).toBe('INSTITUTION_WIDE_SCOPE_REQUIRED');
    await api().post(policies(campus.institutionId)).set(auth(campus.campusOfficer)).send({ policyType: 'ONE_OFFER_PER_STUDENT' }).expect(403);
    await api().post(policies(campus.institutionId)).set(auth(campus.head)).send({ policyType: 'ONE_OFFER_PER_STUDENT' }).expect(403);

    // Validation, then a stale revision, then the approval by an admin.
    expect((await decide(campus.institutionId, campus.admin, driveId, 'approve', { revision: 1, surprise: 1 }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    await decide(campus.institutionId, campus.admin, driveId, 'approve', {}).expect(400);
    await decide(campus.institutionId, campus.admin, driveId, 'approve', { revision: 1, scheduledStartAt: 'soon' }).expect(400);
    expect((await decide(campus.institutionId, campus.admin, driveId, 'approve', { revision: 7 }).expect(409)).body.error.code).toBe('CAMPUS_DRIVE_CHANGED');
    await decide(campus.institutionId, campus.admin, driveId, 'approve', { revision: 1 }).expect(201);
    expect((await decide(campus.institutionId, campus.admin, driveId, 'approve', { revision: 2 }).expect(400)).body.error.code).toBe('CAMPUS_DRIVE_TRANSITION_NOT_ALLOWED');
    await decide(campus.institutionId, campus.admin, driveId, 'schedule', { revision: 2, scheduledStartAt: '2027-03-01T04:30:00.000Z' }).expect(201);

    // Policies: one active per type; bad input refused.
    await api().post(policies(campus.institutionId)).set(auth(campus.admin)).send({ policyType: 'TWO_OFFERS' }).expect(400);
    await api().post(policies(campus.institutionId)).set(auth(campus.admin)).send({ policyType: 'ONE_OFFER_PER_STUDENT', surprise: true }).expect(400);
    await api().post(policies(campus.institutionId)).set(auth(campus.admin)).send({ policyType: 'ONE_OFFER_PER_STUDENT' }).expect(201);
    expect((await api().post(policies(campus.institutionId)).set(auth(campus.admin)).send({ policyType: 'ONE_OFFER_PER_STUDENT' }).expect(409)).body.error.code).toBe('PLACEMENT_POLICY_ALREADY_ACTIVE');
    const policyAudit = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='institution.placement_policy.set' AND organization_id=$1", [campus.institutionId]);
    expect(policyAudit.rows[0].n).toBe(1);
    await api().get(policies(campus.institutionId)).set(auth(campus.faculty)).expect(403);

    // Keyset paging bounds on the college list.
    await api().get(collegeDrives(campus.institutionId)).query({ limit: 0 }).set(auth(campus.officer)).expect(400);
    await api().get(collegeDrives(campus.institutionId)).query({ limit: 201 }).set(auth(campus.officer)).expect(400);
    await api().get(collegeDrives(campus.institutionId)).query({ state: 'SIDEWAYS' }).set(auth(campus.officer)).expect(400);
    const page = await api().get(collegeDrives(campus.institutionId)).query({ limit: 1, state: 'SCHEDULED' }).set(auth(campus.officer)).expect(200);
    expect(page.body.drives).toHaveLength(1);
  });
});
