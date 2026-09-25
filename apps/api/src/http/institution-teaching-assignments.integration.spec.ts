/**
 * Faculty teaching assignments, faculty scope and "My Students" (INST-03), and the staff
 * unit scope an institution admin can now set (the INST-02 follow-up).
 *
 * Once an institution records teaching assignments, a faculty member sees exactly the
 * students in the sections and batches of their active assignments, through the same
 * scope definition every institution read already uses; ending an assignment removes
 * access on the next request; department heads assign only within their department.
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
import { AcademicRecordsController } from './academic-records.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for teaching assignment tests');
const schemaName = 'teaching_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string;
let otherInstitutionId: string;
let departmentA: string; let departmentB: string;
let batchA1: string; let sectionA1x: string; let sectionA1y: string; let batchB1: string; let otherInstitutionSection: string;
let studentX: Student;   // department A, batch A1, section x
let studentY: Student;   // department A, batch A1, section y
let studentB: Student;   // department B, batch B1
let admin: Staff; let faculty: Staff; let otherFaculty: Staff; let headA: Staff;
let subjectId: string;

interface Student { userId: string; profileId: string }
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
    controllers: [AcademicRecordsController],
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
  departmentA = randomUUID(); departmentB = randomUUID();
  batchA1 = randomUUID(); sectionA1x = randomUUID(); sectionA1y = randomUUID(); batchB1 = randomUUID(); otherInstitutionSection = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution'), ($2,'INSTITUTION','Other institution')", [institutionId, otherInstitutionId]);
  await unit(departmentA, 'DEPARTMENT', 'Department A', null);
  await unit(departmentB, 'DEPARTMENT', 'Department B', null);
  await unit(batchA1, 'BATCH', 'Batch A1', departmentA);
  await unit(sectionA1x, 'SECTION', 'Section A1-X', batchA1);
  await unit(sectionA1y, 'SECTION', 'Section A1-Y', batchA1);
  await unit(batchB1, 'BATCH', 'Batch B1', departmentB);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'SECTION','Elsewhere')", [otherInstitutionSection, otherInstitutionId]);
  studentX = await student('S-X', 'Section X Student', departmentA, batchA1, sectionA1x);
  studentY = await student('S-Y', 'Section Y Student', departmentA, batchA1, sectionA1y);
  studentB = await student('S-B', 'Department B Student', departmentB, batchB1, null);
  admin = await staff('INSTITUTION_ADMIN');
  faculty = await staff('FACULTY_LECTURER');
  otherFaculty = await staff('FACULTY_LECTURER');
  headA = await staff('DEPARTMENT_HEAD', departmentA);
  subjectId = randomUUID();
  await pool.query("INSERT INTO exam_subjects (id,institution_id,name,code) VALUES ($1,$2,'Data Structures','CS201')", [subjectId, institutionId]);
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
async function student(rollNumber: string, fullName: string, department: string | null, batch: string | null, section: string | null): Promise<Student> {
  const userId = randomUUID(); const profileId = randomUUID();
  await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id,section_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8)`, [profileId, institutionId, userId, rollNumber, fullName, department, batch, section]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE',now()-interval '2 days')`, [randomUUID(), institutionId, userId]);
  return { userId, profileId };
}
async function staff(role: string, department: string | null = null, batch: string | null = null, organization = institutionId): Promise<Staff> {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id,scope_batch_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5,$6)`, [membershipId, organization, id, role, department, batch]);
  return { id, membershipId };
}
const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const sorted = (values: string[]) => [...values].sort();
const rosterIds = async (actor: Staff) => sorted((await api().get(base() + '/students').set(auth(actor.id)).expect(200)).body.students.map((entry: { id: string }) => entry.id));
const myStudentIds = async (actor: Staff) => sorted((await api().get(base() + '/my-students').set(auth(actor.id)).expect(200)).body.students.map((entry: { profileId: string }) => entry.profileId));
const everyone = () => sorted([studentX.profileId, studentY.profileId, studentB.profileId]);

function assignment(overrides: Record<string, unknown> = {}) {
  return { facultyMembershipId: faculty.membershipId, unitId: sectionA1x, subjectId, academicTerm: '2026-27 Odd semester', reasonCode: 'NEW_TERM', ...overrides };
}
async function assign(actor: Staff, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await api().post(base() + '/teaching-assignments').set(auth(actor.id)).send(assignment(overrides)).expect(201);
  return created.body.assignment.id as string;
}

describe('faculty scope follows teaching assignments', () => {
  it('keeps the INST-02 fallback until the institution records its first assignment', async () => {
    expect(await rosterIds(faculty)).toEqual(everyone());
    const mine = (await api().get(base() + '/my-students').set(auth(faculty.id)).expect(200)).body;
    expect(mine.mode).toBe('MEMBERSHIP');
  });

  it('shows a faculty member exactly the students of their assigned section', async () => {
    await assign(admin);
    expect(await rosterIds(faculty)).toEqual([studentX.profileId]);
    expect(await myStudentIds(faculty)).toEqual([studentX.profileId]);
    await api().get(base() + '/students/' + studentY.profileId).set(auth(faculty.id)).expect(403);
    await api().get(base() + '/students/' + studentX.profileId).set(auth(faculty.id)).expect(200);
    const staffActions = await api().get(base() + '/staff-actions').set(auth(faculty.id)).expect(200);
    expect(staffActions.body.students.map((entry: { id: string }) => entry.id)).toEqual([studentX.userId]);
  });

  it('covers every section of an assigned batch', async () => {
    await assign(admin, { unitId: batchA1 });
    expect(await myStudentIds(faculty)).toEqual(sorted([studentX.profileId, studentY.profileId]));
  });

  it('leaves an unassigned faculty member with nobody once the institution uses assignments', async () => {
    await assign(admin);
    expect(await rosterIds(otherFaculty)).toEqual([]);
    const mine = (await api().get(base() + '/my-students').set(auth(otherFaculty.id)).expect(200)).body;
    expect(mine).toMatchObject({ mode: 'ASSIGNMENTS', students: [], assignments: [] });
  });

  it('removes access on the next request when an assignment ends', async () => {
    const id = await assign(admin);
    expect(await myStudentIds(faculty)).toEqual([studentX.profileId]);
    await api().post(base() + '/teaching-assignments/' + id + '/end').set(auth(admin.id)).send({ reasonCode: 'TERM_ENDED' }).expect(201);
    expect(await myStudentIds(faculty)).toEqual([]);
    expect(await rosterIds(faculty)).toEqual([]);
    await api().get(base() + '/students/' + studentX.profileId).set(auth(faculty.id)).expect(403);
    const row = await pool.query('SELECT state, end_reason_code, ended_by_user_id FROM faculty_teaching_assignments WHERE id=$1', [id]);
    expect(row.rows[0]).toMatchObject({ state: 'ENDED', end_reason_code: 'TERM_ENDED', ended_by_user_id: admin.id });
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='institution.teaching_assignment.ended' AND resource_id=$1", [id]);
    expect(audit.rows[0].context).toMatchObject({ reasonCode: 'TERM_ENDED' });
  });

  it('grants nothing before an assignment starts or after its planned end', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await assign(admin, { startsOn: tomorrow });
    expect(await myStudentIds(faculty)).toEqual([]);
    await pool.query("UPDATE faculty_teaching_assignments SET starts_on = current_date - 10, ends_on = current_date - 1");
    expect(await myStudentIds(faculty)).toEqual([]);
  });

  it('leaves the administrator view unchanged', async () => {
    await assign(admin);
    expect(await rosterIds(admin)).toEqual(everyone());
  });

  it('applies the assignment scope to the academic verification queue', async () => {
    await assign(admin);
    const terms: Record<string, string> = {};
    for (const learner of [studentX, studentB]) {
      const qualification = randomUUID(); const term = randomUUID();
      await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,verification_state)
        VALUES ($1,$2,$3,'BTECH','Computer Science and Engineering','PENDING_VERIFICATION')`, [qualification, learner.userId, institutionId]);
      await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,source,verification_state)
        VALUES ($1,$2,1,'Semester 1',8.1,'CGPA_10','STUDENT_DECLARED','PENDING_VERIFICATION')`, [term, qualification]);
      terms[learner.userId] = term;
    }
    const queue = (await api().get(base() + '/academic-verification-queue').set(auth(faculty.id)).expect(200)).body.queue;
    expect(queue.map((entry: { termId: string }) => entry.termId)).toEqual([terms[studentX.userId]]);
  });
});

describe('My Students', () => {
  it('lists assigned students with activation, recent assessments and open tasks, and no compensation or readiness number', async () => {
    await assign(admin);
    const mine = (await api().get(base() + '/my-students').set(auth(faculty.id)).expect(200)).body;
    expect(mine.mode).toBe('ASSIGNMENTS');
    expect(mine.assignments).toHaveLength(1);
    expect(mine.assignments[0]).toMatchObject({ unit: { id: sectionA1x, kind: 'SECTION', name: 'Section A1-X' }, subject: { id: subjectId, name: 'Data Structures' }, academicTerm: '2026-27 Odd semester' });
    expect(mine.students[0]).toMatchObject({ profileId: studentX.profileId, fullName: 'Section X Student', openTasks: 0, recentAssessments: { submitted: 0, latestTitle: null } });
    expect(mine.students[0]).toHaveProperty('activation');
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/compensation/i);
    expect(text).not.toMatch(/readinessScore|readiness_score/i);
  });

  it('leaves out a student whose relationship has ended', async () => {
    await assign(admin, { unitId: batchA1 });
    await pool.query("UPDATE institution_relationships SET state='ENDED', effective_to=now()-interval '1 hour' WHERE student_user_id=$1", [studentY.userId]);
    expect(await myStudentIds(faculty)).toEqual([studentX.profileId]);
  });

  it('refuses callers without a faculty membership in the institution', async () => {
    await api().get(base() + '/my-students').expect(401);
    await api().get(base() + '/my-students').set(auth(headA.id)).expect(403);
    const elsewhere = await staff('FACULTY_LECTURER', null, null, otherInstitutionId);
    await api().get(base() + '/my-students').set(auth(elsewhere.id)).expect(403);
  });

  it('bounds its page size', async () => {
    await api().get(base() + '/my-students?limit=0').set(auth(faculty.id)).expect(400);
    await api().get(base() + '/my-students?limit=201').set(auth(faculty.id)).expect(400);
    await assign(admin, { unitId: batchA1 });
    const first = (await api().get(base() + '/my-students?limit=1').set(auth(faculty.id)).expect(200)).body;
    expect(first.students).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await api().get(base() + '/my-students?limit=1&cursor=' + encodeURIComponent(first.nextCursor)).set(auth(faculty.id)).expect(200)).body;
    expect(second.students).toHaveLength(1);
    expect(second.students[0].profileId).not.toBe(first.students[0].profileId);
  });
});

describe('creating and ending teaching assignments', () => {
  it('audits a creation with its reason code', async () => {
    const id = await assign(admin);
    const audit = await pool.query("SELECT actor_user_id, organization_id, context FROM audit_events WHERE action='institution.teaching_assignment.created' AND resource_id=$1", [id]);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: admin.id, organization_id: institutionId });
    expect(audit.rows[0].context).toMatchObject({ reasonCode: 'NEW_TERM', unitId: sectionA1x, facultyMembershipId: faculty.membershipId });
  });

  it('requires authentication and an admin or department head of this institution', async () => {
    await api().post(base() + '/teaching-assignments').send(assignment()).expect(401);
    await api().get(base() + '/teaching-assignments').expect(401);
    await api().post(base() + '/teaching-assignments').set(auth(faculty.id)).send(assignment()).expect(403);
    const otherAdmin = await staff('INSTITUTION_ADMIN', null, null, otherInstitutionId);
    await api().post(base() + '/teaching-assignments').set(auth(otherAdmin.id)).send(assignment()).expect(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM faculty_teaching_assignments')).rows[0].n).toBe(0);
  });

  // Values are built lazily: the units are created per test in beforeEach.
  it.each([
    ['an unknown field', () => ({ extra: true })],
    ['a department instead of a section or batch', () => ({ unitId: departmentA })],
    ['a section of another institution', () => ({ unitId: otherInstitutionSection })],
    ['a membership that is not faculty', () => ({ facultyMembershipId: headA.membershipId })],
    ['no subject', () => ({ subjectId: undefined })],
    ['a malformed reason code', () => ({ reasonCode: 'no' })],
    ['a missing term', () => ({ academicTerm: '' })],
    ['an end before the start', () => ({ startsOn: '2026-10-10', endsOn: '2026-10-01' })],
    ['a formula in the subject code', () => ({ subjectId: undefined, subjectCode: '=HYPERLINK()' })],
  ] as const)('rejects %s', async (_label, overrides) => {
    const body = assignment(overrides());
    const refused = await api().post(base() + '/teaching-assignments').set(auth(admin.id)).send(body).expect(400);
    expect(JSON.stringify(refused.body)).not.toContain(institutionId);
    expect((await pool.query('SELECT count(*)::int AS n FROM faculty_teaching_assignments')).rows[0].n).toBe(0);
  });

  it('accepts a subject code where the college has no subject record', async () => {
    await assign(admin, { subjectId: undefined, subjectCode: 'MA101' });
  });

  it('refuses a duplicate active assignment', async () => {
    await assign(admin);
    await api().post(base() + '/teaching-assignments').set(auth(admin.id)).send(assignment()).expect(409);
  });

  it('lets a department head assign within their department only', async () => {
    await assign(headA);
    await api().post(base() + '/teaching-assignments').set(auth(headA.id)).send(assignment({ unitId: batchB1 })).expect(403);
    const unscopedHead = await staff('DEPARTMENT_HEAD');
    await api().post(base() + '/teaching-assignments').set(auth(unscopedHead.id)).send(assignment({ unitId: sectionA1y })).expect(403);
  });

  it('lets a department head end only assignments in their department', async () => {
    const outside = await assign(admin, { unitId: batchB1 });
    await api().post(base() + '/teaching-assignments/' + outside + '/end').set(auth(headA.id)).send({ reasonCode: 'TERM_ENDED' }).expect(403);
    const inside = await assign(admin);
    await api().post(base() + '/teaching-assignments/' + inside + '/end').set(auth(headA.id)).send({ reasonCode: 'TERM_ENDED' }).expect(201);
    await api().post(base() + '/teaching-assignments/' + inside + '/end').set(auth(admin.id)).send({ reasonCode: 'TERM_ENDED' }).expect(409);
  });

  it('lists assignments by who is asking', async () => {
    await assign(admin);
    await assign(admin, { unitId: batchB1, facultyMembershipId: otherFaculty.membershipId });
    const all = (await api().get(base() + '/teaching-assignments').set(auth(admin.id)).expect(200)).body;
    expect(all.assignments).toHaveLength(2);
    expect(all.canAssign).toBe(true);
    expect(all.faculty.map((entry: { membershipId: string }) => entry.membershipId)).toEqual(expect.arrayContaining([faculty.membershipId, otherFaculty.membershipId]));
    const head = (await api().get(base() + '/teaching-assignments').set(auth(headA.id)).expect(200)).body;
    expect(head.assignments.map((entry: { unit: { id: string } }) => entry.unit.id)).toEqual([sectionA1x]);
    expect(head.units.map((entry: { id: string }) => entry.id)).not.toContain(batchB1);
    const own = (await api().get(base() + '/teaching-assignments').set(auth(otherFaculty.id)).expect(200)).body;
    expect(own.assignments.map((entry: { unit: { id: string } }) => entry.unit.id)).toEqual([batchB1]);
    expect(own).toMatchObject({ canAssign: false, faculty: [], units: [] });
    await api().get(base() + '/teaching-assignments?limit=201').set(auth(admin.id)).expect(400);
  });
});

describe('staff unit scope', () => {
  it('stores a department scope on a staff invitation and lists it', async () => {
    const invited = await api().post(base() + '/staff-role-assignments').set(auth(admin.id))
      .send({ email: 'new-head@example.test', role: 'DEPARTMENT_HEAD', departmentUnitId: departmentA }).expect(201);
    const row = await pool.query('SELECT scope_department_unit_id, scope_batch_unit_id FROM invitations WHERE id=$1', [invited.body.invitation.id]);
    expect(row.rows[0]).toEqual({ scope_department_unit_id: departmentA, scope_batch_unit_id: null });
    const listed = (await api().get(base() + '/staff-role-assignments').set(auth(admin.id)).expect(200)).body.staff.invitations;
    expect(listed[0]).toMatchObject({ scope: { departmentUnitId: departmentA, batchUnitId: null } });
  });

  it.each([
    ['a unit of another institution', () => ({ departmentUnitId: otherInstitutionSection })],
    ['a batch in the department slot', () => ({ departmentUnitId: batchA1 })],
    ['a batch outside the department', () => ({ departmentUnitId: departmentA, batchUnitId: batchB1 })],
  ] as const)('refuses an invitation scoped to %s', async (_label, scope) => {
    await api().post(base() + '/staff-role-assignments').set(auth(admin.id))
      .send({ email: 'scoped@example.test', role: 'FACULTY_LECTURER', ...scope() }).expect(400);
    expect((await pool.query("SELECT count(*)::int AS n FROM invitations WHERE email='scoped@example.test'")).rows[0].n).toBe(0);
  });

  it('keeps an unscoped invitation working as before', async () => {
    const invited = await api().post(base() + '/staff-role-assignments').set(auth(admin.id))
      .send({ email: 'plain@example.test', role: 'FACULTY_LECTURER' }).expect(201);
    const row = await pool.query('SELECT scope_department_unit_id FROM invitations WHERE id=$1', [invited.body.invitation.id]);
    expect(row.rows[0].scope_department_unit_id).toBeNull();
  });

  it('sets and clears an existing membership scope, audited with before and after', async () => {
    const head = await staff('DEPARTMENT_HEAD');
    expect(await rosterIds(head)).toEqual(everyone());
    await api().post(base() + '/staff-memberships/' + head.membershipId + '/scope').set(auth(admin.id))
      .send({ departmentUnitId: departmentB, batchUnitId: null, reasonCode: 'SCOPE_REVIEW' }).expect(201);
    expect(await rosterIds(head)).toEqual([studentB.profileId]);
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='institution.staff_membership.scope_changed' AND resource_id=$1", [head.membershipId]);
    expect(audit.rows[0].context).toMatchObject({ reasonCode: 'SCOPE_REVIEW', before: { departmentUnitId: null, batchUnitId: null }, after: { departmentUnitId: departmentB, batchUnitId: null } });
    const listed = (await api().get(base() + '/staff-role-assignments').set(auth(admin.id)).expect(200)).body.staff.memberships;
    expect(listed.find((entry: { id: string }) => entry.id === head.membershipId)).toMatchObject({ scope: { departmentUnitId: departmentB, batchUnitId: null } });
    await api().post(base() + '/staff-memberships/' + head.membershipId + '/scope').set(auth(admin.id))
      .send({ departmentUnitId: null, batchUnitId: null, reasonCode: 'SCOPE_REVIEW' }).expect(201);
    expect(await rosterIds(head)).toEqual(everyone());
  });

  it('refuses a scope change from anyone but an admin of this institution, or on the wrong membership', async () => {
    const path = base() + '/staff-memberships/' + faculty.membershipId + '/scope';
    const body = { departmentUnitId: departmentA, reasonCode: 'SCOPE_REVIEW' };
    await api().post(path).send(body).expect(401);
    await api().post(path).set(auth(headA.id)).send(body).expect(403);
    await api().post(path).set(auth(admin.id)).send({ departmentUnitId: departmentA }).expect(400);
    await api().post(path).set(auth(admin.id)).send({ ...body, departmentUnitId: otherInstitutionSection }).expect(400);
    await api().post(base() + '/staff-memberships/' + admin.membershipId + '/scope').set(auth(admin.id)).send(body).expect(403);
    const elsewhere = await staff('FACULTY_LECTURER', null, null, otherInstitutionId);
    await api().post(base() + '/staff-memberships/' + elsewhere.membershipId + '/scope').set(auth(admin.id)).send(body).expect(403);
    const scope = await pool.query('SELECT scope_department_unit_id FROM organization_memberships WHERE id=$1', [faculty.membershipId]);
    expect(scope.rows[0].scope_department_unit_id).toBeNull();
  });
});
