/**
 * Consented application visibility for the placement office (INST-09).
 *
 * The placement office sees where each student is in their placement journey, derived
 * only from applications the student chose to share with the college (ADR-019): a
 * student who shared nothing reads "not shared", never "not applied"; a revoked consent
 * or an ended relationship drops the record on the next request; an employer's unsent
 * DRAFT offer is not an offer; pay never appears (ADR-024); every per-student list read is
 * audited. The student can share an application after applying, and stop again.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for placement visibility tests');
const schemaName = 'placevis_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string;
let otherInstitutionId: string;
let departmentA: string; let departmentB: string; let batchA1: string; let batchB1: string;
let studentsA: Student[];  // six in department A
let studentsB: Student[];  // two in department B
let admin: Staff; let officer: Staff; let officerB: Staff; let headA: Staff; let faculty: Staff; let otherAdmin: Staff;

interface Student { userId: string; profileId: string; relationshipId: string; name: string }
interface Staff { id: string; membershipId: string }

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
});
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  tokens.clear();
  institutionId = randomUUID(); otherInstitutionId = randomUUID();
  departmentA = randomUUID(); departmentB = randomUUID(); batchA1 = randomUUID(); batchB1 = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution'), ($2,'INSTITUTION','Other institution')", [institutionId, otherInstitutionId]);
  await unit(departmentA, 'DEPARTMENT', 'Department A', null);
  await unit(departmentB, 'DEPARTMENT', 'Department B', null);
  await unit(batchA1, 'BATCH', 'Batch A1', departmentA);
  await unit(batchB1, 'BATCH', 'Batch B1', departmentB);
  studentsA = [];
  for (let index = 0; index < 6; index += 1) studentsA.push(await student('A-' + index, 'Student A' + index, departmentA, batchA1));
  studentsB = [await student('B-0', 'Student B0', departmentB, batchB1), await student('B-1', 'Student B1', departmentB, batchB1)];
  admin = await staff('INSTITUTION_ADMIN');
  officer = await staff('PLACEMENT_ADMIN');
  officerB = await staff('PLACEMENT_ADMIN', departmentB);
  headA = await staff('DEPARTMENT_HEAD', departmentA);
  faculty = await staff('FACULTY_LECTURER');
  otherAdmin = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
  // Dropping a full migrated schema under load can outlast the default hook timeout; a schema
  // left behind makes unqualified information_schema checks in other suites see two copies.
}, 120_000);

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
async function student(rollNumber: string, fullName: string, department: string | null, batch: string | null): Promise<Student> {
  const userId = randomUUID(); const profileId = randomUUID(); const relationshipId = randomUUID();
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7)`, [profileId, institutionId, userId, rollNumber, fullName, department, batch]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE','2020-01-01T00:00:00Z')`, [relationshipId, institutionId, userId]);
  return { userId, profileId, relationshipId, name: fullName };
}
async function staff(role: string, department: string | null = null, organization = institutionId): Promise<Staff> {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, organization, id, role, department]);
  return { id, membershipId };
}
/** A native application, shared with the college unless told otherwise, in `state`, with an optional offer. */
async function application(subject: Student, state: string, options: { shared?: boolean; offer?: string } = {}): Promise<string> {
  const employer = randomUUID(); const opportunity = randomUUID(); const version = randomUUID(); const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Employer ' || $2)", [employer, id.slice(0, 6)]);
  await pool.query("INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)", [opportunity, employer, admin.id, 'LOCAL-' + id.slice(0, 8)]);
  await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,'Graduate engineer','FULL_TIME','REMOTE',$3,$4)", [version, opportunity, '0'.repeat(64), admin.id]);
  const closed = ['HIRED', 'REJECTED', 'WITHDRAWN'].includes(state) ? 'now()' : 'NULL';
  const submitted = state === 'DRAFT' ? 'NULL' : 'now()';
  await pool.query(`INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,closed_at,institution_visibility_granted_at)
    VALUES ($1,$2,$3,$4,$5,$6,${submitted},${submitted},${closed},${options.shared === false ? 'NULL' : 'now()'})`, [id, opportunity, employer, version, subject.userId, state]);
  if (options.offer) {
    const extended = options.offer !== 'DRAFT';
    await pool.query(`INSERT INTO offers (id,application_id,employer_id,state,compensation_currency,compensation_amount,compensation_period,offer_expires_at,extended_at,responded_at,withdrawn_at,created_by_user_id)
      VALUES ($1,$2,$3,$4,'INR',900000,'YEAR',now() + interval '10 days',${extended ? 'now()' : 'NULL'},${['ACCEPTED', 'DECLINED'].includes(options.offer) ? 'now()' : 'NULL'},${options.offer === 'WITHDRAWN' ? 'now()' : 'NULL'},$5)`,
    [randomUUID(), id, employer, options.offer, admin.id]);
  }
  return id;
}
async function declaration(subject: Student, stage: string, shared = true): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO external_applications (id,student_user_id,company_name,role_title,source_kind,applied_on,stage,institution_visibility_granted_at)
    VALUES ($1,$2,'Declared company','Declared role','REFERRAL',current_date,$3,${shared ? 'now()' : 'NULL'})`, [id, subject.userId, stage]);
  return id;
}

const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
interface StatusRow { studentUserId: string; fullName: string; status: string; sharedApplications: number; sharedExternalDeclarations: number; department: string | null; batch: string | null }
const statusList = async (actor: Staff, query = '') =>
  (await api().get(base() + '/placement-status' + query).set(auth(actor.id)).expect(200)).body as { students: StatusRow[]; nextCursor: string | null };
const statusOf = async (actor: Staff, subject: Student) => (await statusList(actor)).students.find((row) => row.studentUserId === subject.userId)?.status;
const pipeline = async (actor: Staff, unitId?: string) =>
  (await api().get(base() + '/placement-pipeline' + (unitId ? '?unitId=' + unitId : '')).set(auth(actor.id)).expect(200)).body;
const cell = (table: { cells: { key: string; count: number | null; suppressed: boolean }[] }, key: string) => table.cells.find((entry) => entry.key === key);
function expectNoPayOrNumericReadiness(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/compensation|salary|stipend|ctc|900000/i);
  expect(text).not.toMatch(/readiness_?score|readinessValue|readinessPercent|"score"/i);
}
const audits = async (action: string) => (await pool.query('SELECT actor_user_id, outcome, resource_id, organization_id, context FROM audit_events WHERE action=$1 ORDER BY occurred_at', [action])).rows;

describe('placement status per student', () => {
  it('derives each status only from shared applications, and reads nothing shared as NOT_SHARED', async () => {
    await application(studentsA[0]!, 'APPLIED');
    await application(studentsA[1]!, 'INTERVIEW');
    await application(studentsA[2]!, 'OFFER', { offer: 'EXTENDED' });
    await application(studentsA[3]!, 'HIRED', { offer: 'ACCEPTED' });
    await application(studentsA[4]!, 'OFFER', { shared: false, offer: 'ACCEPTED' });   // not shared: stays private
    const body = await statusList(officer);
    const byName = new Map(body.students.map((row) => [row.fullName, row]));
    expect(byName.get('Student A0')?.status).toBe('APPLIED');
    expect(byName.get('Student A1')?.status).toBe('IN_PROCESS');
    expect(byName.get('Student A2')?.status).toBe('OFFER');
    expect(byName.get('Student A3')?.status).toBe('ACCEPTED');
    expect(byName.get('Student A4')).toMatchObject({ status: 'NOT_SHARED', sharedApplications: 0 });
    expect(byName.get('Student A5')?.status).toBe('NOT_SHARED');
    expect(byName.get('Student A0')).toMatchObject({ department: 'Department A', batch: 'Batch A1', sharedApplications: 1 });
    expect(body.students.map((row) => row.status)).not.toContain('NOT_APPLIED');
    expectNoPayOrNumericReadiness(body);
  });

  it('never treats an unsent DRAFT offer as an offer, or a DRAFT application as shared', async () => {
    await application(studentsA[0]!, 'INTERVIEW', { offer: 'DRAFT' });
    await application(studentsA[1]!, 'DRAFT');
    expect(await statusOf(officer, studentsA[0]!)).toBe('IN_PROCESS');
    expect(await statusOf(officer, studentsA[1]!)).toBe('NOT_SHARED');
  });

  it('counts shared external declarations beside the status without moving it', async () => {
    await declaration(studentsA[0]!, 'HIRED');
    await declaration(studentsA[0]!, 'OFFER', false);
    const row = (await statusList(officer)).students.find((entry) => entry.studentUserId === studentsA[0]!.userId)!;
    expect(row).toMatchObject({ status: 'NOT_SHARED', sharedApplications: 0, sharedExternalDeclarations: 1 });
  });

  it('drops a record on the next request after consent is revoked, and a student after the relationship ends', async () => {
    const id = await application(studentsA[0]!, 'INTERVIEW');
    await declaration(studentsA[0]!, 'INTERVIEW');
    expect(await statusOf(officer, studentsA[0]!)).toBe('IN_PROCESS');
    await pool.query('UPDATE applications SET institution_visibility_revoked_at=now() WHERE id=$1', [id]);
    await pool.query('UPDATE external_applications SET institution_visibility_revoked_at=now() WHERE student_user_id=$1', [studentsA[0]!.userId]);
    const row = (await statusList(officer)).students.find((entry) => entry.studentUserId === studentsA[0]!.userId)!;
    expect(row).toMatchObject({ status: 'NOT_SHARED', sharedApplications: 0, sharedExternalDeclarations: 0 });
    await application(studentsA[1]!, 'INTERVIEW');
    await pool.query("UPDATE institution_relationships SET state='ENDED', effective_to=now() WHERE id=$1", [studentsA[1]!.relationshipId]);
    expect(await statusOf(officer, studentsA[1]!)).toBeUndefined();
  });

  it('withholds an application whose activity falls outside the relationship window', async () => {
    const id = await application(studentsA[0]!, 'INTERVIEW');
    await pool.query("UPDATE institution_relationships SET effective_from=now()-interval '1 day' WHERE id=$1", [studentsA[0]!.relationshipId]);
    await pool.query("UPDATE applications SET created_at=now()-interval '3 days', submitted_at=now()-interval '3 days' WHERE id=$1", [id]);
    expect(await statusOf(officer, studentsA[0]!)).toBe('NOT_SHARED');
  });

  it('keeps each reader to their scope: a department-scoped officer and a head see only their department; admins see all', async () => {
    await application(studentsA[0]!, 'APPLIED');
    await application(studentsB[0]!, 'APPLIED');
    const everyone = [...studentsA, ...studentsB].map((entry) => entry.userId).sort();
    expect((await statusList(admin)).students.map((row) => row.studentUserId).sort()).toEqual(everyone);
    expect((await statusList(officer)).students.map((row) => row.studentUserId).sort()).toEqual(everyone);
    expect((await statusList(officerB)).students.map((row) => row.studentUserId).sort()).toEqual(studentsB.map((entry) => entry.userId).sort());
    expect((await statusList(headA)).students.map((row) => row.studentUserId).sort()).toEqual(studentsA.map((entry) => entry.userId).sort());
    // Narrowing never widens: a head asking for another department gets nobody.
    expect((await statusList(headA, '?unitId=' + departmentB)).students).toEqual([]);
    expect((await statusList(admin, '?unitId=' + departmentB)).students.map((row) => row.studentUserId).sort()).toEqual(studentsB.map((entry) => entry.userId).sort());
  });

  it('refuses without a token, for faculty, and across institutions', async () => {
    await api().get(base() + '/placement-status').expect(401);
    await api().get(base() + '/placement-status').set(auth(faculty.id)).expect(403);
    await api().get(base() + '/placement-status').set(auth(otherAdmin.id)).expect(403);
    await api().get(base(otherInstitutionId) + '/placement-status').set(auth(admin.id)).expect(403);
  });

  it('validates the query and pages by keyset', async () => {
    for (const bad of ['?limit=0', '?limit=201', '?limit=abc', '?cursor=nope', '?unitId=nope', '?unitId=' + randomUUID()]) {
      await api().get(base() + '/placement-status' + bad).set(auth(admin.id)).expect(400);
    }
    const first = await statusList(admin, '?limit=3');
    expect(first.students).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = await statusList(admin, '?limit=3&cursor=' + first.nextCursor);
    const third = await statusList(admin, '?limit=3&cursor=' + second.nextCursor);
    expect(third.nextCursor).toBeNull();
    const names = [...first.students, ...second.students, ...third.students].map((row) => row.fullName);
    expect(names).toEqual(['Student A0', 'Student A1', 'Student A2', 'Student A3', 'Student A4', 'Student A5', 'Student B0', 'Student B1']);
  });

  it('audits every list read with the reader, count and unit', async () => {
    await statusList(officer, '?unitId=' + departmentA);
    const [row] = await audits('institution.placement_status.listed');
    expect(row).toMatchObject({ actor_user_id: officer.id, outcome: 'SUCCESS', organization_id: institutionId });
    expect(row.context).toMatchObject({ returned: 6, unitId: departmentA, page: 'FIRST' });
  });
});

describe('placement status summary on the pipeline', () => {
  it('counts statuses with small groups suppressed, reconciling with the per-student list', async () => {
    for (const subject of studentsA.slice(0, 5)) await application(subject, 'INTERVIEW');
    const body = await pipeline(admin, departmentA);
    expect(cell(body.placementStatus, 'IN_PROCESS')).toMatchObject({ count: 5, suppressed: false });
    expect(cell(body.placementStatus, 'NOT_SHARED')).toMatchObject({ count: null, suppressed: true });
    expect(cell(body.placementStatus, 'ACCEPTED')).toMatchObject({ suppressed: true });
    const list = await statusList(admin, '?unitId=' + departmentA);
    expect(list.students.filter((row) => row.status === 'IN_PROCESS')).toHaveLength(5);
    expectNoPayOrNumericReadiness(body);
  });
});

describe('per-student applications, aligned with the placement views', () => {
  const nativePath = (subject: Student) => base() + '/students/' + subject.userId + '/applications';
  const externalPath = (subject: Student) => base() + '/students/' + subject.userId + '/external-applications';

  it('does not disclose that an unsent DRAFT offer exists, and hides DRAFT applications', async () => {
    const draftOffer = await application(studentsA[0]!, 'INTERVIEW', { offer: 'DRAFT' });
    await application(studentsA[0]!, 'DRAFT');
    const body = (await api().get(nativePath(studentsA[0]!)).set(auth(officer.id)).expect(200)).body;
    expect(body.applications.map((row: { id: string }) => row.id)).toEqual([draftOffer]);
    expect(body.applications[0].offer).toEqual({ exists: false, responseState: null });
    await pool.query("UPDATE offers SET state='EXTENDED', extended_at=now() WHERE application_id=$1", [draftOffer]);
    const sent = (await api().get(nativePath(studentsA[0]!)).set(auth(officer.id)).expect(200)).body;
    expect(sent.applications[0].offer).toEqual({ exists: true, responseState: 'EXTENDED' });
    expectNoPayOrNumericReadiness(sent);
  });

  it('audits each read, and a read outside scope as denied', async () => {
    await application(studentsA[0]!, 'APPLIED');
    await declaration(studentsA[0]!, 'APPLIED');
    await api().get(nativePath(studentsA[0]!)).set(auth(officer.id)).expect(200);
    await api().get(externalPath(studentsA[0]!)).set(auth(officer.id)).expect(200);
    expect((await api().get(nativePath(studentsA[0]!)).set(auth(officerB.id)).expect(200)).body.applications).toEqual([]);
    const native = await audits('institution.student_applications.read');
    expect(native).toHaveLength(2);
    expect(native[0]).toMatchObject({ actor_user_id: officer.id, outcome: 'SUCCESS', resource_id: studentsA[0]!.userId, organization_id: institutionId });
    expect(native[0].context).toMatchObject({ returned: 1 });
    expect(native[1]).toMatchObject({ actor_user_id: officerB.id, outcome: 'DENIED', resource_id: studentsA[0]!.userId });
    expect(native[1].context).toMatchObject({ returned: 0 });
    const external = await audits('institution.student_external_applications.read');
    expect(external).toHaveLength(1);
    expect(external[0].context).toMatchObject({ returned: 1 });
  });
});

describe('student sharing an application after applying', () => {
  const grant = (subject: Student, id: string) => api().post('/api/v1/students/me/applications/' + id + '/institution-visibility/grant').set(auth(subject.userId));
  const revoke = (subject: Student, id: string) => api().post('/api/v1/students/me/applications/' + id + '/institution-visibility/revoke').set(auth(subject.userId));
  beforeEach(() => { for (const subject of [...studentsA, ...studentsB]) tokens.add(subject.userId); });

  it('shares an unshared application, idempotently, and the college sees it on the next request', async () => {
    const id = await application(studentsA[0]!, 'INTERVIEW', { shared: false });
    expect(await statusOf(officer, studentsA[0]!)).toBe('NOT_SHARED');
    await grant(studentsA[0]!, id).expect(201);
    expect(await statusOf(officer, studentsA[0]!)).toBe('IN_PROCESS');
    await grant(studentsA[0]!, id).expect(201);
    expect((await audits('application.institution_visibility_granted'))).toHaveLength(1);
    const mine = (await api().get('/api/v1/students/me/applications').set(auth(studentsA[0]!.userId)).expect(200)).body.applications;
    expect(mine[0].institutionVisibilityGrantedAt).toBeTruthy();
    expect(mine[0].institutionVisibilityRevokedAt).toBeNull();
  });

  it('can share again after stopping, and stopping takes effect immediately', async () => {
    const id = await application(studentsA[0]!, 'APPLIED');
    await revoke(studentsA[0]!, id).expect(201);
    expect(await statusOf(officer, studentsA[0]!)).toBe('NOT_SHARED');
    await grant(studentsA[0]!, id).expect(201);
    expect(await statusOf(officer, studentsA[0]!)).toBe('APPLIED');
    const [row] = (await pool.query('SELECT institution_visibility_granted_at, institution_visibility_revoked_at FROM applications WHERE id=$1', [id])).rows;
    expect(row.institution_visibility_revoked_at).toBeNull();
  });

  it("refuses another student's application, a DRAFT, a malformed id and no token", async () => {
    const theirs = await application(studentsA[1]!, 'APPLIED', { shared: false });
    await grant(studentsA[0]!, theirs).expect(403);
    const draft = await application(studentsA[0]!, 'DRAFT', { shared: false });
    await grant(studentsA[0]!, draft).expect(403);
    await api().post('/api/v1/students/me/applications/not-a-uuid/institution-visibility/grant').set(auth(studentsA[0]!.userId)).expect((response) => {
      expect([400, 403]).toContain(response.status);
    });
    await api().post('/api/v1/students/me/applications/' + theirs + '/institution-visibility/grant').expect(401);
    const [row] = (await pool.query('SELECT institution_visibility_granted_at FROM applications WHERE id=$1', [theirs])).rows;
    expect(row.institution_visibility_granted_at).toBeNull();
  });
});
