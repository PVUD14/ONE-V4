/**
 * Department head and faculty workspaces (INST-07), and scoped assessment assignment
 * (INST-SR-03).
 *
 * The department views are the admin modules narrowed to the reader's scope, so every
 * number here must reconcile with the administrator's view filtered to the same
 * department; aggregates over readiness and applications go through the one suppression
 * helper; application stages come only from applications the student has shared with the
 * college (ADR-019) and never carry pay (ADR-024).
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
if (!connectionString) throw new Error('DATABASE_URL is required for department workspace tests');
const schemaName = 'deptws_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string;
let otherInstitutionId: string;
let departmentA: string; let departmentB: string;
let batchA1: string; let sectionA1x: string; let sectionA1y: string; let batchB1: string;
let studentsA: Student[];  // six in department A: four in section x, two in section y
let studentsB: Student[];  // two in department B
let admin: Staff; let headA: Staff; let headB: Staff; let unscopedHead: Staff; let faculty: Staff; let otherAdmin: Staff;
let subjectId: string;

interface Student { userId: string; profileId: string; relationshipId: string }
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
  departmentA = randomUUID(); departmentB = randomUUID();
  batchA1 = randomUUID(); sectionA1x = randomUUID(); sectionA1y = randomUUID(); batchB1 = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution'), ($2,'INSTITUTION','Other institution')", [institutionId, otherInstitutionId]);
  await unit(departmentA, 'DEPARTMENT', 'Department A', null);
  await unit(departmentB, 'DEPARTMENT', 'Department B', null);
  await unit(batchA1, 'BATCH', 'Batch A1', departmentA);
  await unit(sectionA1x, 'SECTION', 'Section A1-X', batchA1);
  await unit(sectionA1y, 'SECTION', 'Section A1-Y', batchA1);
  await unit(batchB1, 'BATCH', 'Batch B1', departmentB);
  studentsA = [];
  for (let index = 0; index < 6; index += 1) {
    studentsA.push(await student('A-' + index, 'Department A student ' + index, departmentA, batchA1, index < 4 ? sectionA1x : sectionA1y));
  }
  studentsB = [await student('B-0', 'Department B student 0', departmentB, batchB1, null), await student('B-1', 'Department B student 1', departmentB, batchB1, null)];
  admin = await staff('INSTITUTION_ADMIN');
  headA = await staff('DEPARTMENT_HEAD', departmentA);
  headB = await staff('DEPARTMENT_HEAD', departmentB);
  unscopedHead = await staff('DEPARTMENT_HEAD');
  faculty = await staff('FACULTY_LECTURER');
  otherAdmin = await staff('INSTITUTION_ADMIN', null, null, otherInstitutionId);
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
  const userId = randomUUID(); const profileId = randomUUID(); const relationshipId = randomUUID();
  await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id,section_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8)`, [profileId, institutionId, userId, rollNumber, fullName, department, batch, section]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE','2020-01-01T00:00:00Z')`, [relationshipId, institutionId, userId]);
  return { userId, profileId, relationshipId };
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
async function assignFaculty(unitId: string) {
  await api().post(base() + '/teaching-assignments').set(auth(admin.id))
    .send({ facultyMembershipId: faculty.membershipId, unitId, subjectId, academicTerm: '2026-27 Odd semester', reasonCode: 'NEW_TERM' }).expect(201);
}
async function staffAction(subject: Student, type: string, state: string) {
  await pool.query(`INSERT INTO staff_actions (id,institution_id,subject_student_user_id,institution_relationship_id,actor_user_id,actor_membership_id,
      assigned_to_membership_id,action_type,state,title,updated_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,'Follow up',$5)`, [randomUUID(), institutionId, subject.userId, subject.relationshipId, admin.id, admin.membershipId, type, state]);
}
async function assessment(options: { open?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const window = options.open === false ? ["now() - interval '10 days'", "now() - interval '5 days'"] : ["now() - interval '1 day'", "now() + interval '5 days'"];
  await pool.query(`INSERT INTO exam_definitions (id,institution_id,subject_id,title,exam_kind,lifecycle_state,total_marks,duration_seconds,starts_at,ends_at,created_by_user_id,published_at)
    VALUES ($1,$2,$3,'Unit test 1','UNIT_TEST','PUBLISHED',10,600,${window[0]},${window[1]},$4,now())`, [id, institutionId, subjectId, admin.id]);
  return id;
}
async function assignExam(definitionId: string, subject: Student) {
  await pool.query('INSERT INTO exam_assignments (id,institution_id,definition_id,student_user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), institutionId, definitionId, subject.userId, admin.id]);
}
async function result(definitionId: string, subject: Student, percentage: number) {
  const attempt = randomUUID();
  await pool.query(`INSERT INTO exam_attempts (id,institution_id,definition_id,student_user_id,attempt_number,status,paper_seed,submitted_at)
    VALUES ($1,$2,$3,$4,1,'SUBMITTED','seed',now())`, [attempt, institutionId, definitionId, subject.userId]);
  await pool.query(`INSERT INTO exam_results (id,attempt_id,score,max_score,percentage,correct_count,wrong_count,not_attempted_count,time_taken_seconds)
    VALUES ($1,$2,$3,10,$4,1,1,1,300)`, [randomUUID(), attempt, percentage / 10, percentage]);
}
/** A native application the student has shared with the college (ADR-019), in `state`, with an optional offer. */
async function application(subject: Student, state: string, options: { shared?: boolean; offer?: string } = {}): Promise<string> {
  const employer = randomUUID(); const opportunity = randomUUID(); const version = randomUUID(); const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Employer ' || $2)", [employer, id.slice(0, 6)]);
  await pool.query("INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)", [opportunity, employer, admin.id, 'LOCAL-' + id.slice(0, 8)]);
  await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,'Graduate engineer','FULL_TIME','REMOTE',$3,$4)", [version, opportunity, '0'.repeat(64), admin.id]);
  const closed = ['HIRED', 'REJECTED', 'WITHDRAWN'].includes(state) ? 'now()' : 'NULL';
  await pool.query(`INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,closed_at,institution_visibility_granted_at)
    VALUES ($1,$2,$3,$4,$5,$6,now(),now(),${closed},${options.shared === false ? 'NULL' : 'now()'})`, [id, opportunity, employer, version, subject.userId, state]);
  if (options.offer) {
    const extended = options.offer !== 'DRAFT';
    await pool.query(`INSERT INTO offers (id,application_id,employer_id,state,compensation_currency,compensation_amount,compensation_period,offer_expires_at,extended_at,responded_at,withdrawn_at,created_by_user_id)
      VALUES ($1,$2,$3,$4,'INR',900000,'YEAR',now() + interval '10 days',${extended ? 'now()' : 'NULL'},${['ACCEPTED', 'DECLINED'].includes(options.offer) ? 'now()' : 'NULL'},${options.offer === 'WITHDRAWN' ? 'now()' : 'NULL'},$5)`,
    [randomUUID(), id, employer, options.offer, admin.id]);
  }
  return id;
}
async function lastMonthSnapshots(subjects: readonly Student[], band: string) {
  const [model] = (await pool.query("SELECT id FROM readiness_model_versions WHERE stable_key='career-readiness-fundamentals' AND version=1")).rows as { id: string }[];
  let modelVersionId = model?.id;
  if (!modelVersionId) {
    modelVersionId = randomUUID();
    await pool.query(`INSERT INTO readiness_model_versions (id,stable_key,version,policy,published_by_user_id,published_at,active)
      VALUES ($1,'career-readiness-fundamentals',1,'{}'::jsonb,$2,now(),true)`, [modelVersionId, admin.id]);
  }
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10)).toISOString();
  for (const subject of subjects) {
    await pool.query(`INSERT INTO readiness_snapshots (id,subject_user_id,model_version_id,evidence_ids,evidence_set_hash,band,explanation,generated_at)
      VALUES ($1,$2,$3,'{}'::uuid[],$4,$5,'{}'::jsonb,$6)`, [randomUUID(), subject.userId, modelVersionId, randomUUID().replaceAll('-', '').padEnd(64, '0'), band, lastMonth]);
  }
}

const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const overview = async (actor: Staff, unitId?: string) =>
  (await api().get(base() + '/department-overview' + (unitId ? '?unitId=' + unitId : '')).set(auth(actor.id)).expect(200)).body;
const pipeline = async (actor: Staff, unitId?: string) =>
  (await api().get(base() + '/placement-pipeline' + (unitId ? '?unitId=' + unitId : '')).set(auth(actor.id)).expect(200)).body;
const cell = (table: { cells: { key: string; count: number | null; suppressed: boolean }[] }, key: string) => table.cells.find((entry) => entry.key === key);
/** Numeric readiness and pay must never reach an institution response (ADR-020, ADR-024). */
function expectNoPayOrNumericReadiness(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/compensation|salary|stipend|ctc|900000/i);
  expect(text).not.toMatch(/readiness_?score|readinessValue|readinessPercent|"score"/i);
}

describe('department overview', () => {
  it('refuses callers without a token, other institutions and roles without a department workspace', async () => {
    await api().get(base() + '/department-overview').expect(401);
    await api().get(base() + '/department-overview').set(auth(otherAdmin.id)).expect(403);
    await api().get(base() + '/department-overview').set(auth(faculty.id)).expect(403);
    await api().get(base() + '/department-overview?unitId=not-a-uuid').set(auth(admin.id)).expect(400);
    const foreign = await api().get(base() + '/department-overview?unitId=' + randomUUID()).set(auth(admin.id)).expect(400);
    expect(foreign.body.error.code).toBe('UNIT_INVALID');
  });

  it('counts only the head\'s department, and reconciles with the administrator filtered to it', async () => {
    const exam = await assessment();
    for (const learner of [...studentsA.slice(0, 3), studentsB[0]!]) await assignExam(exam, learner);
    await result(exam, studentsA[0]!, 80);
    await assessment({ open: false });
    await staffAction(studentsA[0]!, 'INTERVENTION', 'OPEN');
    await staffAction(studentsA[1]!, 'INTERVENTION', 'COMPLETED');
    await staffAction(studentsB[0]!, 'INTERVENTION', 'OPEN');
    await staffAction(studentsA[2]!, 'ASSIGNED_TASK', 'IN_PROGRESS');

    const head = await overview(headA);
    expect(head.students).toEqual({ onRoster: 6, current: 6 });
    expect(head.activation.ACTIVATED).toBe(6);
    expect(head.assessments).toEqual({ inProgress: 1, assignedStudents: 3, completedStudents: 1 });
    expect(head.staffActions).toEqual({ openInterventions: 1, openTasks: 1 });
    expect(head.scope.units.map((entry: { name: string }) => entry.name)).toEqual(['Department A']);
    expect(head.batches.map((entry: { name: string }) => entry.name)).toEqual(['Batch A1']);
    expect(head.batches[0]).toMatchObject({ parentName: 'Department A', students: 6, current: 6, activated: 6 });

    const filtered = await overview(admin, departmentA);
    for (const key of ['students', 'activation', 'assessments', 'staffActions', 'batches', 'readiness'] as const) expect(filtered[key]).toEqual(head[key]);
    expect(filtered.unit).toEqual({ id: departmentA, kind: 'DEPARTMENT', name: 'Department A' });

    const whole = await overview(admin);
    expect(whole.students).toEqual({ onRoster: 8, current: 8 });
    expect(whole.assessments.assignedStudents).toBe(4);
    expect(whole.staffActions.openInterventions).toBe(2);
    expect(whole.batches.map((entry: { name: string }) => entry.name)).toEqual(['Batch A1', 'Batch B1']);
    expectNoPayOrNumericReadiness(head);
  });

  it('never widens a head beyond their department when a unit is asked for', async () => {
    const elsewhere = await overview(headA, departmentB);
    expect(elsewhere.students).toEqual({ onRoster: 0, current: 0 });
    expect(elsewhere.batches).toEqual([]);
    const ownSection = await overview(headA, sectionA1y);
    expect(ownSection.students).toEqual({ onRoster: 2, current: 2 });
  });

  it('counts a student whose relationship ended on the roster but not as current', async () => {
    await pool.query("UPDATE institution_relationships SET state='ENDED', effective_to=now() - interval '1 hour' WHERE id=$1", [studentsA[5]!.relationshipId]);
    expect((await overview(headA)).students).toEqual({ onRoster: 6, current: 5 });
  });

  it('shows last month\'s readiness bands through the suppression helper: small bands and a recoverable total withheld', async () => {
    await lastMonthSnapshots(studentsA.slice(0, 5), 'DEVELOPING');
    await lastMonthSnapshots([studentsA[5]!], 'PROGRESSING');
    await lastMonthSnapshots(studentsB, 'READY_FOR_NEXT_STEP');
    const head = await overview(headA);
    const now = new Date();
    expect(head.readiness.month).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7));
    const bands = head.readiness.aggregate.bands as { band: string; count: number | null; suppressed: boolean }[];
    expect(bands.find((entry) => entry.band === 'DEVELOPING')).toEqual({ band: 'DEVELOPING', count: 5, suppressed: false });
    for (const band of ['NOT_ENOUGH_EVIDENCE', 'PROGRESSING', 'READY_FOR_NEXT_STEP']) {
      expect(bands.find((entry) => entry.band === band)).toEqual({ band, count: null, suppressed: true });
    }
    expect(head.readiness.aggregate).toMatchObject({ suppressed: false, cohortSize: null, cohortSizeSuppressed: true });
    // Department B has two students: the whole table is withheld.
    expect((await overview(headB)).readiness.aggregate).toMatchObject({ suppressed: true, bands: [] });
    // The reconciliation holds for the bands too.
    expect((await overview(admin, departmentA)).readiness).toEqual(head.readiness);
    expectNoPayOrNumericReadiness(head);
  });

  it('keeps an unscoped department head institution-wide for reads, as every other read does', async () => {
    expect((await overview(unscopedHead)).students.onRoster).toBe(8);
  });
});

describe('placement pipeline', () => {
  it('counts shared applications of the head\'s department only, suppressing stages under five', async () => {
    for (const learner of studentsA.slice(0, 5)) await application(learner, 'APPLIED');
    await application(studentsA[5]!, 'OFFER', { offer: 'EXTENDED' });
    await application(studentsB[0]!, 'APPLIED');
    await application(studentsA[0]!, 'SHORTLISTED', { shared: false });
    const head = await pipeline(headA);
    expect(cell(head.stages, 'APPLIED')).toEqual({ key: 'APPLIED', count: 5, suppressed: false });
    expect(cell(head.stages, 'OFFER')).toEqual({ key: 'OFFER', count: null, suppressed: true });
    expect(cell(head.stages, 'SHORTLISTED')).toEqual({ key: 'SHORTLISTED', count: null, suppressed: true });
    expect(head.stages.total).toEqual({ suppressed: true, value: null });
    expect(head.studentsSharing).toEqual({ suppressed: false, value: 6 });
    expect(head.offers.suppressed).toBe(true);
    expect(await pipeline(admin, departmentA)).toMatchObject({ stages: head.stages, offers: head.offers, studentsSharing: head.studentsSharing });
    expect((await pipeline(headB)).stages.suppressed).toBe(true);
    expectNoPayOrNumericReadiness(head);
  });

  it('stops counting an application on the next request once the student withdraws consent or leaves', async () => {
    const ids: string[] = [];
    for (const learner of studentsA.slice(0, 5)) ids.push(await application(learner, 'APPLIED'));
    expect(cell((await pipeline(headA)).stages, 'APPLIED')?.count).toBe(5);
    await pool.query('UPDATE applications SET institution_visibility_revoked_at = now() WHERE id=$1', [ids[0]]);
    // Four left: under five in total, so the whole table is withheld.
    expect((await pipeline(headA)).stages).toEqual({ suppressed: true, total: { suppressed: true, value: null }, cells: [] });
    await pool.query('UPDATE applications SET institution_visibility_revoked_at = NULL WHERE id=$1', [ids[0]]);
    expect(cell((await pipeline(headA)).stages, 'APPLIED')?.count).toBe(5);
    await pool.query("UPDATE institution_relationships SET state='ENDED', effective_to=now() - interval '1 hour' WHERE id=$1", [studentsA[1]!.relationshipId]);
    expect((await pipeline(headA)).stages.suppressed).toBe(true);
  });

  it('refuses faculty and other institutions', async () => {
    await api().get(base() + '/placement-pipeline').set(auth(faculty.id)).expect(403);
    await api().get(base() + '/placement-pipeline').set(auth(otherAdmin.id)).expect(403);
    await api().get(base() + '/placement-pipeline').expect(401);
  });
});

describe('opportunities and offers (shared application records)', () => {
  const list = (actor: Staff, query = '') => api().get(base() + '/placement-applications' + query).set(auth(actor.id));

  it('lists the department\'s shared applications with offer existence and response, never pay, and audits the read', async () => {
    const extended = await application(studentsA[0]!, 'OFFER', { offer: 'ACCEPTED' });
    const draftOffer = await application(studentsA[1]!, 'INTERVIEW', { offer: 'DRAFT' });
    await application(studentsA[2]!, 'APPLIED', { shared: false });
    await application(studentsB[0]!, 'APPLIED');
    const response = await list(headA).expect(200);
    const rows = response.body.applications as { id: string; student: { fullName: string }; state: string; offer: { exists: boolean; responseState: string | null } }[];
    expect(rows.map((row) => row.id).sort()).toEqual([extended, draftOffer].sort());
    expect(rows.find((row) => row.id === extended)?.offer).toEqual({ exists: true, responseState: 'ACCEPTED' });
    // An employer's unsent draft offer is not an offer the college may learn about.
    expect(rows.find((row) => row.id === draftOffer)?.offer).toEqual({ exists: false, responseState: null });
    expectNoPayOrNumericReadiness(response.body);
    const audit = await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='institution.placement_applications.listed' AND organization_id=$1", [institutionId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: headA.id, context: { returned: 2 } });
    expect((await list(admin, '?unitId=' + departmentA).expect(200)).body.applications.map((row: { id: string }) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it('pages with a keyset cursor and bounds the page size', async () => {
    for (const learner of studentsA.slice(0, 3)) await application(learner, 'APPLIED');
    const first = await list(headA, '?limit=2').expect(200);
    expect(first.body.applications).toHaveLength(2);
    const second = await list(headA, '?limit=2&cursor=' + encodeURIComponent(first.body.nextCursor)).expect(200);
    expect(second.body.applications).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    await list(headA, '?limit=0').expect(400);
    await list(headA, '?limit=201').expect(400);
    await list(headA, '?cursor=garbage').expect(400);
  });
});

describe('department staff', () => {
  it('shows a head the staff of their department and whoever teaches in it, and refuses faculty', async () => {
    await assignFaculty(sectionA1x);
    const response = await api().get(base() + '/department-staff').set(auth(headA.id)).expect(200);
    const emails = (response.body.staff as { email: string }[]).map((entry) => entry.email).sort();
    expect(emails).toEqual([faculty.id + '@example.test', headA.id + '@example.test'].sort());
    const teacher = response.body.staff.find((entry: { email: string }) => entry.email === faculty.id + '@example.test');
    expect(teacher.assignments).toEqual([{ unitName: 'Section A1-X', subject: 'Data Structures', academicTerm: '2026-27 Odd semester' }]);
    const all = await api().get(base() + '/department-staff').set(auth(admin.id)).expect(200);
    expect(all.body.staff.length).toBeGreaterThanOrEqual(5);
    await api().get(base() + '/department-staff').set(auth(faculty.id)).expect(403);
    expect(JSON.stringify(response.body)).not.toMatch(/membershipId|external_subject/);
  });
});

describe('faculty class reports', () => {
  it('summarises each assigned section, with an average only once five students have results', async () => {
    await assignFaculty(sectionA1x);
    const exam = await assessment();
    for (const learner of studentsA) await assignExam(exam, learner);
    for (const [index, learner] of studentsA.slice(0, 4).entries()) await result(exam, learner, 50 + index * 10);
    await staffAction(studentsA[0]!, 'ASSIGNED_TASK', 'OPEN');
    const response = await api().get(base() + '/class-reports').set(auth(faculty.id)).expect(200);
    expect(response.body.mode).toBe('ASSIGNMENTS');
    expect(response.body.classes).toHaveLength(1);
    const section = response.body.classes[0];
    expect(section).toMatchObject({ unit: { id: sectionA1x, kind: 'SECTION', name: 'Section A1-X' }, subjects: ['Data Structures'], students: 4, activated: 4, openTasks: 1 });
    expect(section.assessments).toEqual([expect.objectContaining({ id: exam, title: 'Unit test 1', assigned: 4, completed: 4, averagePercentage: null, averageSuppressed: true })]);

    await assignFaculty(batchA1);
    await result(exam, studentsA[4]!, 90);
    const batch = (await api().get(base() + '/class-reports').set(auth(faculty.id)).expect(200)).body.classes
      .find((entry: { unit: { id: string } }) => entry.unit.id === batchA1);
    expect(batch.assessments[0]).toMatchObject({ assigned: 6, completed: 5, averagePercentage: 70, averageSuppressed: false });
  });

  it('gives a faculty member with no assignment nothing once the college assigns, and refuses heads', async () => {
    await assignFaculty(sectionA1x);
    const other = await staff('FACULTY_LECTURER');
    expect((await api().get(base() + '/class-reports').set(auth(other.id)).expect(200)).body).toMatchObject({ mode: 'ASSIGNMENTS', classes: [] });
    await api().get(base() + '/class-reports').set(auth(headA.id)).expect(403);
    await api().get(base() + '/class-reports').expect(401);
  });
});

describe('assessment assignment is scoped and audited (INST-SR-03)', () => {
  const assignPath = (definitionId: string) => base() + '/assessments/' + definitionId + '/assignments';

  it('assigns only students inside the caller\'s write scope, and records who assigned whom', async () => {
    await assignFaculty(sectionA1x);
    const exam = await assessment();
    const response = await api().post(assignPath(exam)).set(auth(faculty.id))
      .send({ studentProfileIds: [studentsA[0]!.profileId, studentsA[5]!.profileId, studentsB[0]!.profileId] }).expect(201);
    expect(response.body.assignment).toMatchObject({ requested: 3, eligible: 1, newlyAssigned: 1 });
    const assigned = await pool.query('SELECT student_user_id FROM exam_assignments WHERE definition_id=$1', [exam]);
    expect(assigned.rows.map((row: { student_user_id: string }) => row.student_user_id)).toEqual([studentsA[0]!.userId]);
    const notified = await pool.query("SELECT user_id FROM user_notifications WHERE kind='EXAM_ASSIGNED'");
    expect(notified.rows.map((row: { user_id: string }) => row.user_id)).toEqual([studentsA[0]!.userId]);
    const audit = await pool.query("SELECT actor_user_id, resource_id, context FROM audit_events WHERE action='institution.assessment.assigned'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: faculty.id, resource_id: exam, context: { requested: 3, eligible: 1, newlyAssigned: 1 } });
  });

  it('limits a head to their department and leaves the administrator institution-wide', async () => {
    const exam = await assessment();
    const head = await api().post(assignPath(exam)).set(auth(headA.id)).send({ studentProfileIds: [studentsA[0]!.profileId, studentsB[0]!.profileId] }).expect(201);
    expect(head.body.assignment).toMatchObject({ eligible: 1, newlyAssigned: 1 });
    const adminCall = await api().post(assignPath(exam)).set(auth(admin.id)).send({ studentProfileIds: [studentsB[0]!.profileId] }).expect(201);
    expect(adminCall.body.assignment).toMatchObject({ eligible: 1, newlyAssigned: 1 });
  });

  it('refuses a head with no department and faculty with no assignment, with SCOPE_REQUIRED, and writes nothing', async () => {
    const exam = await assessment();
    await assignFaculty(sectionA1y);
    const other = await staff('FACULTY_LECTURER');
    for (const actor of [unscopedHead, other]) {
      const refused = await api().post(assignPath(exam)).set(auth(actor.id)).send({ studentProfileIds: [studentsA[0]!.profileId] }).expect(403);
      expect(refused.body.error.code).toBe('SCOPE_REQUIRED');
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM exam_assignments WHERE definition_id=$1', [exam])).rows[0].n).toBe(0);
  });
});
