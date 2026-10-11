/**
 * Placement-office nominations with student consent (INST-14, decision 10.2 #7).
 *
 * A college may put a student forward for one of its live campus drives only with that student's
 * explicit, informed, revocable opt-in. These specs pin the goal's acceptance — nothing about a
 * student reaches the employer before they opt in; declining is recorded and never shown to the
 * employer — plus what each side sees (the college cannot tell a decline from no answer; the
 * student sees who nominated them, to whom, and reviews what is shared), the §6.3 minimums, and the
 * table's own guards.
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
if (!connectionString) throw new Error('DATABASE_URL is required for nomination tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Nomination tests require local Postgres');
const schemaName = 'nominations_' + randomUUID().replaceAll('-', '');
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
async function employer() {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Synthetic Analytics Employer','VERIFIED',true)", [employerId]);
  const recruiterId = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,'RECRUITER','ACTIVE',$2,$2)`, [randomUUID(), employerId, recruiterId]);
  return { employerId, recruiterId };
}
interface College { institutionId: string; departmentId: string; otherDepartmentId: string; admin: string; officer: string; campusOfficer: string; head: string; faculty: string }
async function staff(institutionId: string, role: string, department: string | null = null): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [randomUUID(), institutionId, id, role, department]);
  return id;
}
async function college(): Promise<College> {
  const institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Placement College','VERIFIED',true)", [institutionId]);
  const departmentId = randomUUID();
  const otherDepartmentId = randomUUID();
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Computer Science'), ($3,$2,'DEPARTMENT','Mechanical')", [departmentId, institutionId, otherDepartmentId]);
  return {
    institutionId, departmentId, otherDepartmentId,
    admin: await staff(institutionId, 'INSTITUTION_ADMIN'),
    officer: await staff(institutionId, 'PLACEMENT_ADMIN'),
    campusOfficer: await staff(institutionId, 'PLACEMENT_ADMIN', departmentId),
    head: await staff(institutionId, 'DEPARTMENT_HEAD', departmentId),
    faculty: await staff(institutionId, 'FACULTY_LECTURER'),
  };
}
async function student(of: College, name: string, department = of.departmentId): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)`, [randomUUID(), of.institutionId, id, 'R-' + id.slice(0, 8), name, department]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE','2020-01-01T00:00:00Z')`, [randomUUID(), of.institutionId, id]);
  return id;
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const jobs = (employerId: string) => '/api/v1/employers/' + employerId + '/opportunities';
const collegeDrives = (institutionId: string) => '/api/v1/institutions/' + institutionId + '/campus-drives';
const nominations = (of: College, driveId: string) => collegeDrives(of.institutionId) + '/' + driveId + '/nominations';
const candidates = (of: College, driveId: string) => collegeDrives(of.institutionId) + '/' + driveId + '/nomination-candidates';
const terms = {
  title: 'Graduate analyst', summary: 'Analyse things.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Pune',
  compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: 700000, compensationPeriod: 'YEAR',
};
const noReadiness = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/readiness|mastery|gapStatus|fitScore|"score"/i);
const noCompensation = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/compensation|salary|stipend|700000/i);

/** A drive-only job, published, with a drive the college has approved. */
async function approvedDrive(of: College) {
  const { employerId, recruiterId } = await employer();
  const created = await api().post(jobs(employerId)).set(auth(recruiterId)).send({ referenceCode: 'NM-' + randomUUID().slice(0, 8), ...terms }).expect(201);
  const opportunityId = created.body.opportunity.id as string;
  const requested = await api().post(jobs(employerId) + '/' + opportunityId + '/campus-drives').set(auth(recruiterId)).send({ institutionId: of.institutionId }).expect(201);
  const driveId = requested.body.drive.id as string;
  await api().post(jobs(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);
  await api().post(collegeDrives(of.institutionId) + '/' + driveId + '/approve').set(auth(of.officer)).send({ revision: 1 }).expect(201);
  return { employerId, recruiterId, opportunityId, driveId };
}
function nominate(of: College, actor: string, driveId: string, studentUserIds: string[], extra: Record<string, unknown> = {}) {
  return api().post(nominations(of, driveId)).set(auth(actor)).send({ studentUserIds, reasonCode: 'MEETS_ELIGIBILITY', ...extra });
}
async function myNominations(studentId: string): Promise<Record<string, unknown>[]> {
  const response = await api().get('/api/v1/students/me/nominations').set(auth(studentId)).expect(200);
  noReadiness(response.body);
  return response.body.nominations as Record<string, unknown>[];
}
async function reviewedHash(studentId: string, opportunityId: string): Promise<string> {
  const reviewed = await api().post('/api/v1/students/me/application-previews').set(auth(studentId)).send({ opportunityId }).expect(201);
  return reviewed.body.preview.snapshotHash as string;
}
function accept(studentId: string, nominationId: string, body: Record<string, unknown>) {
  return api().post('/api/v1/students/me/nominations/' + nominationId + '/accept').set(auth(studentId)).send({ consentGranted: true, ...body });
}
async function applicants(employerId: string, recruiterId: string, opportunityId: string): Promise<Record<string, unknown>[]> {
  const response = await api().get(jobs(employerId) + '/' + opportunityId + '/applications').set(auth(recruiterId)).expect(200);
  return response.body.applications as Record<string, unknown>[];
}
async function collegeView(of: College, actor: string, driveId: string) {
  const response = await api().get(nominations(of, driveId)).set(auth(actor)).expect(200);
  noReadiness(response.body); noCompensation(response.body);
  return response.body as { canNominate: boolean; summary: Record<string, { suppressed: boolean; value: number | null }>; nominations: Record<string, unknown>[] };
}

describe('INST-14: nothing about a nominated student reaches the employer before they opt in', () => {
  it('nominates eligible students, shows each who nominated them and what would be shared, and gives the employer only those who opt in', async () => {
    const campus = await college();
    const drive = await approvedDrive(campus);
    const asha = await student(campus, 'Asha Synthetic');
    const bala = await student(campus, 'Bala Synthetic');
    const chitra = await student(campus, 'Chitra Synthetic');

    // The eligible list: every current student in scope, the evaluator's outcome only.
    const list = await api().get(candidates(campus, drive.driveId)).set(auth(campus.officer)).expect(200);
    noReadiness(list.body); noCompensation(list.body);
    const listed = list.body.candidates as { studentUserId: string; eligibility: string; nomination: unknown }[];
    expect(listed.map((row) => row.studentUserId)).toEqual(expect.arrayContaining([asha, bala, chitra]));
    expect(listed.every((row) => row.eligibility === 'ELIGIBLE' && row.nomination === null)).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/alreadyApplied|offer|application/i);

    const created = await nominate(campus, campus.officer, drive.driveId, [asha, bala, chitra], { note: 'Strong fit for the analytics team.' }).expect(201);
    expect(created.body.created).toHaveLength(3);
    expect(created.body.skipped).toEqual([]);
    const audits = await pool.query("SELECT organization_id, context FROM audit_events WHERE action = 'campus_drive_nomination.created' AND actor_user_id = $1", [campus.officer]);
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows.every((row) => row.organization_id === campus.institutionId && row.context.reasonCode === 'MEETS_ELIGIBILITY')).toBe(true);

    // Nothing has reached the employer: no applicant, no count, no grant, no snapshot.
    expect(await applicants(drive.employerId, drive.recruiterId, drive.opportunityId)).toEqual([]);
    const employerDrives = await api().get('/api/v1/employers/' + drive.employerId + '/campus-drives').set(auth(drive.recruiterId)).expect(200);
    expect(employerDrives.body.drives[0].applicationCount).toBe(0);
    expect(JSON.stringify(employerDrives.body)).not.toMatch(/nomination|Asha|Bala|Chitra|INVITED/i);
    for (const id of [asha, bala, chitra]) expect(JSON.stringify(employerDrives.body)).not.toContain(id);
    const leaked = await pool.query('SELECT count(*)::int AS n FROM employer_applicant_access_grants WHERE student_user_id = ANY($1::uuid[])', [[asha, bala, chitra]]);
    expect(leaked.rows[0].n).toBe(0);

    // The student sees who nominated them, to whom, why, and the note.
    const [mine] = await myNominations(asha);
    expect(mine).toMatchObject({
      state: 'INVITED', canRespond: true, blocksYou: false, alreadyApplied: false, institutionName: 'Synthetic Placement College',
      nominatedBy: { role: 'PLACEMENT_ADMIN', label: 'Placement officer' }, reasonCode: 'MEETS_ELIGIBILITY', note: 'Strong fit for the analytics team.',
      opportunity: { id: drive.opportunityId, title: 'Graduate analyst', employerName: 'Synthetic Analytics Employer' }, applicationId: null,
    });

    // Informed: opting in without reviewing what is shared is refused, and still nothing reaches the employer.
    const unreviewed = await accept(asha, String(mine!.id), {}).expect(400);
    expect(unreviewed.body.error.code).toBe('NOMINATION_REVIEW_REQUIRED');
    await accept(asha, String(mine!.id), { opportunityId: drive.opportunityId }).expect(400);
    expect(await applicants(drive.employerId, drive.recruiterId, drive.opportunityId)).toEqual([]);

    // Opting in runs apply: the employer now sees Asha, sourced from the nomination.
    const hash = await reviewedHash(asha, drive.opportunityId);
    const opted = await accept(asha, String(mine!.id), { reviewedSnapshotHash: hash }).expect(201);
    expect(opted.body).toMatchObject({ application: { state: 'APPLIED' }, nomination: { id: mine!.id, state: 'ACCEPTED' } });
    const afterOptIn = await applicants(drive.employerId, drive.recruiterId, drive.opportunityId);
    expect(afterOptIn).toHaveLength(1);
    expect(afterOptIn[0]).toMatchObject({ id: opted.body.application.id, source: 'PLACEMENT_OFFICE_NOMINATION', candidateAccess: true });
    const snapshot = await pool.query('SELECT count(*)::int AS n FROM application_profile_snapshots WHERE application_id = $1', [opted.body.application.id]);
    expect(snapshot.rows[0].n).toBe(1);
    const linked = await pool.query('SELECT count(*)::int AS n FROM campus_drive_applications WHERE application_id = $1 AND campus_drive_id = $2', [opted.body.application.id, drive.driveId]);
    expect(linked.rows[0].n).toBe(1);
    const [ashaAfter] = await myNominations(asha);
    expect(ashaAfter).toMatchObject({ state: 'ACCEPTED', applicationId: opted.body.application.id, canRespond: false });
    const studentApps = await api().get('/api/v1/students/me/applications').set(auth(asha)).expect(200);
    expect(studentApps.body.applications[0].nominatedBy).toEqual({ institutionName: 'Synthetic Placement College' });

    // Opting in shares nothing further with the college: the application is not shared with it.
    const shared = await pool.query('SELECT institution_visibility_granted_at FROM applications WHERE id = $1', [opted.body.application.id]);
    expect(shared.rows[0].institution_visibility_granted_at).toBeNull();
  });

  it('records a decline, never shows it to the employer, and shows the college a decline exactly as it shows no answer', async () => {
    const campus = await college();
    const drive = await approvedDrive(campus);
    const bala = await student(campus, 'Bala Decliner');
    const chitra = await student(campus, 'Chitra Silent');
    await nominate(campus, campus.officer, drive.driveId, [bala, chitra]).expect(201);
    const [balaNomination] = await myNominations(bala);

    const declined = await api().post('/api/v1/students/me/nominations/' + balaNomination!.id + '/decline').set(auth(bala)).send({}).expect(201);
    expect(declined.body.nomination).toEqual({ id: balaNomination!.id, state: 'DECLINED' });
    // Idempotent, and it rejects unknown fields.
    await api().post('/api/v1/students/me/nominations/' + balaNomination!.id + '/decline').set(auth(bala)).send({}).expect(201);
    await api().post('/api/v1/students/me/nominations/' + balaNomination!.id + '/decline').set(auth(bala)).send({ reason: 'x' }).expect(400);
    const recorded = await pool.query('SELECT state, responded_at FROM campus_drive_nominations WHERE id = $1', [balaNomination!.id]);
    expect(recorded.rows[0].state).toBe('DECLINED');
    expect(recorded.rows[0].responded_at).not.toBeNull();
    // The student's answer is their own act: audited without the college as the organisation.
    const audit = await pool.query("SELECT organization_id FROM audit_events WHERE action = 'campus_drive_nomination.declined' AND resource_id = $1", [balaNomination!.id]);
    expect(audit.rows).toEqual([{ organization_id: null }]);
    expect((await myNominations(bala))[0]).toMatchObject({ state: 'DECLINED', canRespond: true });

    // The employer: nothing at all.
    expect(await applicants(drive.employerId, drive.recruiterId, drive.opportunityId)).toEqual([]);
    const employerDrives = await api().get('/api/v1/employers/' + drive.employerId + '/campus-drives').set(auth(drive.recruiterId)).expect(200);
    expect(JSON.stringify(employerDrives.body)).not.toMatch(/declin|nomination|Bala|Chitra/i);
    for (const id of [bala, chitra]) expect(JSON.stringify(employerDrives.body)).not.toContain(id);

    // The college: the decliner and the silent student read the same.
    const view = await collegeView(campus, campus.officer, drive.driveId);
    expect(JSON.stringify(view)).not.toMatch(/DECLINED|respondedAt|INVITED/);
    const strip = (row: Record<string, unknown>) => { const { id: _id, studentName: _name, institutionStudentId: _roll, nominatedAt: _at, ...rest } = row; return rest; };
    const [first, second] = view.nominations;
    expect(first!.response).toBe('NOT_OPTED_IN');
    expect(strip(first!)).toEqual(strip(second!));

    // Declining is revocable: the student can still opt in while the drive is live.
    const hash = await reviewedHash(bala, drive.opportunityId);
    await accept(bala, String(balaNomination!.id), { reviewedSnapshotHash: hash }).expect(201);
    expect((await applicants(drive.employerId, drive.recruiterId, drive.opportunityId))[0]).toMatchObject({ source: 'PLACEMENT_OFFICE_NOMINATION' });
    expect((await collegeView(campus, campus.officer, drive.driveId)).nominations.map((row) => row.response).sort()).toEqual(['NOT_OPTED_IN', 'OPTED_IN']);
  });

  it('withdrawing the application withdraws the consent and ends the employer\'s access', async () => {
    const campus = await college();
    const drive = await approvedDrive(campus);
    const asha = await student(campus, 'Asha Withdrawer');
    await nominate(campus, campus.officer, drive.driveId, [asha]).expect(201);
    const [nomination] = await myNominations(asha);
    const opted = await accept(asha, String(nomination!.id), { reviewedSnapshotHash: await reviewedHash(asha, drive.opportunityId) }).expect(201);
    await api().post('/api/v1/students/me/applications/' + opted.body.application.id + '/withdraw').set(auth(asha)).send({}).expect(201);
    expect((await myNominations(asha))[0]).toMatchObject({ state: 'WITHDRAWN', canRespond: false });
    const [row] = await applicants(drive.employerId, drive.recruiterId, drive.opportunityId);
    expect(row).toMatchObject({ state: 'WITHDRAWN', candidateAccess: false, candidateName: null });
    expect((await collegeView(campus, campus.officer, drive.driveId)).nominations[0]!.response).toBe('NOT_OPTED_IN');
    // Withdrawn is final for the nomination; the student can still apply directly.
    expect((await accept(asha, String(nomination!.id), { reviewedSnapshotHash: await reviewedHash(asha, drive.opportunityId) }).expect(400)).body.error.code).toBe('NOMINATION_NOT_OPEN');
  });
});

describe('INST-14: the eligible list and nominating', () => {
  it('nominates only students the evaluator finds eligible, and says why the others were skipped', async () => {
    const campus = await college();
    const elsewhere = await college();
    const drive = await approvedDrive(campus);
    const version = await pool.query('SELECT current_version_id FROM opportunities WHERE id = $1', [drive.opportunityId]);
    await pool.query("INSERT INTO opportunity_eligibility_rules (id,opportunity_version_id,rule_type,comparator,value_numeric,is_blocking) VALUES ($1,$2,'MIN_CGPA','GTE',7.5,true)",
      [randomUUID(), version.rows[0].current_version_id]);
    const unknown = await student(campus, 'Devi No Records');
    const outsider = await student(elsewhere, 'Esha Elsewhere');

    const list = await api().get(candidates(campus, drive.driveId)).set(auth(campus.officer)).expect(200);
    const devi = (list.body.candidates as { studentUserId: string; eligibility: string }[]).find((row) => row.studentUserId === unknown);
    expect(devi?.eligibility).toBe('UNKNOWN');
    expect(JSON.stringify(list.body)).not.toMatch(/7\.5|cgpa|basis|studentValue/i);

    const result = await nominate(campus, campus.officer, drive.driveId, [unknown, outsider, randomUUID()]).expect(201);
    expect(result.body.created).toEqual([]);
    expect(result.body.skipped).toEqual([
      { studentUserId: unknown, code: 'NOT_ELIGIBLE' },
      { studentUserId: outsider, code: 'NOT_IN_SCOPE' },
      expect.objectContaining({ code: 'NOT_IN_SCOPE' }),
    ]);
    const rows = await pool.query('SELECT count(*)::int AS n FROM campus_drive_nominations WHERE campus_drive_id = $1', [drive.driveId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('skips a second nomination, lets the college cancel an unanswered one with a reason, and refuses a stale or answered one', async () => {
    const campus = await college();
    const drive = await approvedDrive(campus);
    const one = await student(campus, 'Farah One');
    const two = await student(campus, 'Gopal Two');
    await nominate(campus, campus.officer, drive.driveId, [one, two]).expect(201);
    const again = await nominate(campus, campus.admin, drive.driveId, [one]).expect(201);
    expect(again.body.skipped).toEqual([{ studentUserId: one, code: 'ALREADY_NOMINATED' }]);

    const view = await collegeView(campus, campus.officer, drive.driveId);
    const farah = view.nominations.find((row) => row.studentName === 'Farah One')!;
    expect(farah.canCancel).toBe(true);
    const cancelUrl = nominations(campus, drive.driveId) + '/' + farah.id + '/cancel';
    expect((await api().post(cancelUrl).set(auth(campus.officer)).send({ revision: 1 }).expect(400)).body.error.code).toBe('INVALID_REASON_CODE');
    expect((await api().post(cancelUrl).set(auth(campus.officer)).send({ revision: 7, reasonCode: 'NOMINATED_IN_ERROR' }).expect(409)).body.error.code).toBe('NOMINATION_CHANGED');
    await api().post(cancelUrl).set(auth(campus.officer)).send({ revision: 1, reasonCode: 'NOMINATED_IN_ERROR', extra: true }).expect(400);
    await api().post(cancelUrl).set(auth(campus.officer)).send({ revision: 1, reasonCode: 'NOMINATED_IN_ERROR' }).expect(201);
    const [cancelled] = await myNominations(one);
    expect(cancelled).toMatchObject({ state: 'CANCELLED', canRespond: false });
    expect((await accept(one, String(cancelled!.id), { reviewedSnapshotHash: await reviewedHash(one, drive.opportunityId) }).expect(400)).body.error.code).toBe('NOMINATION_NOT_OPEN');
    // A cancelled nomination can be re-issued.
    expect((await nominate(campus, campus.officer, drive.driveId, [one]).expect(201)).body.created).toHaveLength(1);

    // Once the student has opted in the application is theirs: the college cannot cancel it.
    const [gopal] = await myNominations(two);
    await accept(two, String(gopal!.id), { reviewedSnapshotHash: await reviewedHash(two, drive.opportunityId) }).expect(201);
    const gopalRow = (await collegeView(campus, campus.officer, drive.driveId)).nominations.find((row) => row.studentName === 'Gopal Two')!;
    expect(gopalRow).toMatchObject({ response: 'OPTED_IN', canCancel: false });
    const refused = await api().post(nominations(campus, drive.driveId) + '/' + gopalRow.id + '/cancel').set(auth(campus.officer))
      .send({ revision: gopalRow.revision, reasonCode: 'NOMINATED_IN_ERROR' }).expect(400);
    expect(refused.body.error.code).toBe('NOMINATION_NOT_CANCELLABLE');
  });

  it('closes open nominations when the drive stops being live, and refuses to nominate for a drive that is not live', async () => {
    const campus = await college();
    const drive = await approvedDrive(campus);
    const hema = await student(campus, 'Hema Closed');
    await nominate(campus, campus.officer, drive.driveId, [hema]).expect(201);
    const hash = await reviewedHash(hema, drive.opportunityId);
    await api().post(collegeDrives(campus.institutionId) + '/' + drive.driveId + '/cancel').set(auth(campus.officer)).send({ revision: 2, reasonCode: 'SEASON_CLOSED' }).expect(201);
    const [closed] = await myNominations(hema);
    expect(closed).toMatchObject({ state: 'CLOSED', canRespond: false });
    expect((await accept(hema, String(closed!.id), { reviewedSnapshotHash: hash }).expect(400)).body.error.code).toBe('NOMINATION_CLOSED');
    const view = await collegeView(campus, campus.officer, drive.driveId);
    expect(view).toMatchObject({ canNominate: false });
    expect(view.nominations[0]).toMatchObject({ response: 'CLOSED', canCancel: false });
    expect((await nominate(campus, campus.officer, drive.driveId, [hema]).expect(400)).body.error.code).toBe('NOMINATION_DRIVE_NOT_LIVE');
  });
});

describe('INST-14: §6.3 minimums', () => {
  it('guards every route: token, role, college, write scope, validation and paging bounds', async () => {
    const campus = await college();
    const other = await college();
    const drive = await approvedDrive(campus);
    const ira = await student(campus, 'Ira Scoped');
    const mech = await student(campus, 'Jai Mechanical', campus.otherDepartmentId);

    await api().get(nominations(campus, drive.driveId)).expect(401);
    await api().get(candidates(campus, drive.driveId)).expect(401);
    await api().post(nominations(campus, drive.driveId)).send({ studentUserIds: [ira], reasonCode: 'MEETS_ELIGIBILITY' }).expect(401);
    await api().get('/api/v1/students/me/nominations').expect(401);

    // Faculty have no placement role; another college's staff see nothing of this drive.
    await api().get(nominations(campus, drive.driveId)).set(auth(campus.faculty)).expect(403);
    await api().get(candidates(campus, drive.driveId)).set(auth(campus.faculty)).expect(403);
    await api().get(nominations(other, drive.driveId)).set(auth(other.officer)).expect(403);
    await api().get(nominations(campus, drive.driveId)).set(auth(other.officer)).expect(403);
    await nominate(campus, other.officer, drive.driveId, [ira]).expect(403);
    // A department head reads but cannot nominate; a placement admin narrowed to a department cannot either.
    await api().get(candidates(campus, drive.driveId)).set(auth(campus.head)).expect(403);
    await nominate(campus, campus.head, drive.driveId, [ira]).expect(403);
    expect((await nominate(campus, campus.campusOfficer, drive.driveId, [ira]).expect(403)).body.error.code).toBe('INSTITUTION_WIDE_SCOPE_REQUIRED');

    // Validation: unknown fields, reason codes, sizes, duplicates, notes; paging bounds and cursors.
    await nominate(campus, campus.officer, drive.driveId, [ira], { extra: 1 }).expect(400);
    await nominate(campus, campus.officer, drive.driveId, [ira], { reasonCode: 'BECAUSE' }).expect(400);
    await nominate(campus, campus.officer, drive.driveId, []).expect(400);
    await nominate(campus, campus.officer, drive.driveId, [ira, ira]).expect(400);
    await nominate(campus, campus.officer, drive.driveId, Array.from({ length: 201 }, () => randomUUID())).expect(400);
    await nominate(campus, campus.officer, drive.driveId, ['not-a-uuid']).expect(400);
    await nominate(campus, campus.officer, drive.driveId, [ira], { note: '=HYPERLINK("x")' }).expect(400);
    await nominate(campus, campus.officer, drive.driveId, [ira], { note: 'x'.repeat(501) }).expect(400);
    for (const bad of ['0', '201', 'x']) {
      await api().get(candidates(campus, drive.driveId) + '?limit=' + bad).set(auth(campus.officer)).expect(400);
      await api().get(nominations(campus, drive.driveId) + '?limit=' + bad).set(auth(campus.officer)).expect(400);
    }
    await api().get(nominations(campus, drive.driveId) + '?cursor=nonsense').set(auth(campus.officer)).expect(400);

    // Keyset paging over the eligible list.
    const firstPage = await api().get(candidates(campus, drive.driveId) + '?limit=1').set(auth(campus.officer)).expect(200);
    expect(firstPage.body.candidates).toHaveLength(1);
    const secondPage = await api().get(candidates(campus, drive.driveId) + '?limit=1&cursor=' + firstPage.body.nextCursor).set(auth(campus.officer)).expect(200);
    expect(secondPage.body.candidates[0].studentUserId).not.toBe(firstPage.body.candidates[0].studentUserId);

    // Scope: the Computer Science head sees only their department's nominated students.
    await nominate(campus, campus.officer, drive.driveId, [ira, mech]).expect(201);
    const headView = await collegeView(campus, campus.head, drive.driveId);
    expect(headView.canNominate).toBe(false);
    expect(headView.nominations.map((row) => row.studentName)).toEqual(['Ira Scoped']);
    expect((await collegeView(campus, campus.admin, drive.driveId)).nominations.map((row) => row.studentName)).toEqual(['Ira Scoped', 'Jai Mechanical']);

    // Relationship: a student who has left the college drops out of the college's view.
    await pool.query("UPDATE institution_relationships SET effective_to = now() - interval '1 minute', state = 'ENDED' WHERE student_user_id = $1", [mech]);
    expect((await collegeView(campus, campus.admin, drive.driveId)).nominations.map((row) => row.studentName)).toEqual(['Ira Scoped']);

    // A student cannot answer another student's nomination.
    const [iraNomination] = await myNominations(ira);
    await api().post('/api/v1/students/me/nominations/' + iraNomination!.id + '/decline').set(auth(mech)).send({}).expect(403);
    await accept(mech, String(iraNomination!.id), { reviewedSnapshotHash: 'a'.repeat(64) }).expect(403);
  });

  it('suppresses the summary: any cell under five reads <5, with the total that would give it back', async () => {
    const campus = await college();
    const drive = await approvedDrive(campus);
    const few = [await student(campus, 'Kiran A'), await student(campus, 'Kiran B'), await student(campus, 'Kiran C')];
    await nominate(campus, campus.officer, drive.driveId, few).expect(201);
    const small = await collegeView(campus, campus.officer, drive.driveId);
    expect(small.summary).toEqual({ nominated: { suppressed: true, value: null }, optedIn: { suppressed: true, value: null }, notOptedIn: { suppressed: true, value: null } });

    const more = [await student(campus, 'Kiran D'), await student(campus, 'Kiran E'), await student(campus, 'Kiran F')];
    await nominate(campus, campus.officer, drive.driveId, more).expect(201);
    const [one] = await myNominations(more[0]!);
    await accept(more[0]!, String(one!.id), { reviewedSnapshotHash: await reviewedHash(more[0]!, drive.opportunityId) }).expect(201);
    const larger = await collegeView(campus, campus.officer, drive.driveId);
    expect(larger.summary.notOptedIn).toEqual({ suppressed: false, value: 5 });
    expect(larger.summary.optedIn).toEqual({ suppressed: true, value: null });
    expect(larger.summary.nominated).toEqual({ suppressed: true, value: null });
  });

  it('the table refuses to be rewritten, to skip the consent edges, or to be deleted outside a privacy erase', async () => {
    const campus = await college();
    const drive = await approvedDrive(campus);
    const lina = await student(campus, 'Lina Guarded');
    const created = await nominate(campus, campus.officer, drive.driveId, [lina]).expect(201);
    const id = created.body.created[0].nominationId as string;
    await expect(pool.query("UPDATE campus_drive_nominations SET note = 'changed' WHERE id = $1", [id])).rejects.toThrow(/never change/);
    await expect(pool.query("UPDATE campus_drive_nominations SET state = 'WITHDRAWN', responded_at = now(), application_id = NULL WHERE id = $1", [id])).rejects.toThrow();
    await expect(pool.query('DELETE FROM campus_drive_nominations WHERE id = $1', [id])).rejects.toThrow(/never deleted/);
    await expect(pool.query(`INSERT INTO campus_drive_nominations (id,campus_drive_id,opportunity_id,institution_id,student_user_id,nominated_by_user_id,nominated_by_role,reason_code,state,responded_at)
      SELECT $1, campus_drive_id, opportunity_id, institution_id, student_user_id, nominated_by_user_id, nominated_by_role, reason_code, 'DECLINED', now()
      FROM campus_drive_nominations WHERE id = $2`, [randomUUID(), id])).rejects.toThrow(/starts as INVITED/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('one.privacy_erase_subject', $1, true)", [lina]);
      const gone = await client.query('DELETE FROM campus_drive_nominations WHERE id = $1', [id]);
      expect(gone.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
});
