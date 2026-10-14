/**
 * Institution student reads honour the reader's unit scope (INST-02).
 *
 * One scope definition (packages/authorization) now filters every institution read that
 * returns student-level data: the roster list and detail, consented applications and
 * external applications, the academic verification queue, readiness reports and
 * assessment results, and staff actions. Each is checked for department A against
 * department B, for a faculty member outside their scope, and for administrators, whose
 * view must not change.
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
import { CareerReadinessController } from './career-readiness.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for student scope tests');
const schemaName = 'student_scope_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string;
let departmentA: string;
let departmentB: string;
let batchA1: string;
let batchA2: string;
let inScope: Student;       // department A, batch A1
let otherBatch: Student;    // department A, batch A2
let outOfScope: Student;    // department B
let batchOnly: Student;     // no department recorded, batch A1 (a child of department A)
let admin: { id: string; membershipId: string };

interface Student { userId: string; profileId: string }

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
    controllers: [AcademicRecordsController, CareerReadinessController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
});
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  tokens.clear();
  institutionId = randomUUID();
  departmentA = randomUUID(); departmentB = randomUUID(); batchA1 = randomUUID(); batchA2 = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution')", [institutionId]);
  await pool.query(`INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES
    ($1,$3,'DEPARTMENT','Department A',NULL), ($2,$3,'DEPARTMENT','Department B',NULL)`,
  [departmentA, departmentB, institutionId]);
  await pool.query(`INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES
    ($1,$3,'BATCH','Batch A1',$4), ($2,$3,'BATCH','Batch A2',$4)`, [batchA1, batchA2, institutionId, departmentA]);
  inScope = await student('S-001', 'In Scope Student', departmentA, batchA1);
  otherBatch = await student('S-002', 'Other Batch Student', departmentA, batchA2);
  outOfScope = await student('S-003', 'Other Department Student', departmentB, null);
  batchOnly = await student('S-004', 'Batch Only Student', null, batchA1);
  admin = await staff('INSTITUTION_ADMIN');
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function student(rollNumber: string, fullName: string, department: string | null, batch: string | null): Promise<Student> {
  const userId = randomUUID(); const profileId = randomUUID();
  await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id,updated_at)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,now()-interval '1 day')`, [profileId, institutionId, userId, rollNumber, fullName, department, batch]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE',now()-interval '2 days')`, [randomUUID(), institutionId, userId]);
  return { userId, profileId };
}
async function staff(role: string, department: string | null = null, batch: string | null = null) {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id,scope_batch_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5,$6)`, [membershipId, institutionId, id, role, department, batch]);
  return { id, membershipId };
}
const api = () => request(app.getHttpServer());
const base = () => '/api/v1/institutions/' + institutionId;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const sorted = (values: string[]) => [...values].sort();
const profileIds = (body: { students: { id: string }[] }) => sorted(body.students.map((entry) => entry.id));
const everyone = () => sorted([inScope.profileId, otherBatch.profileId, outOfScope.profileId, batchOnly.profileId]);

describe('student roster list and detail', () => {
  it.each(['FACULTY_LECTURER', 'DEPARTMENT_HEAD', 'PLACEMENT_ADMIN'])('lists only department B for a %s scoped to it', async (role) => {
    const actor = await staff(role, departmentB);
    const list = await api().get(base() + '/students').set(auth(actor.id)).expect(200);
    expect(profileIds(list.body)).toEqual([outOfScope.profileId]);
    expect(list.body.scope).toEqual({ kind: 'UNITS', units: [{ id: departmentB, kind: 'DEPARTMENT', name: 'Department B' }] });
  });

  it('includes students recorded only against a unit below the department', async () => {
    const head = await staff('DEPARTMENT_HEAD', departmentA);
    const list = await api().get(base() + '/students').set(auth(head.id)).expect(200);
    expect(profileIds(list.body)).toEqual(sorted([inScope.profileId, otherBatch.profileId, batchOnly.profileId]));
  });

  it('narrows a batch-scoped faculty member to their batch', async () => {
    const faculty = await staff('FACULTY_LECTURER', departmentA, batchA1);
    const list = await api().get(base() + '/students').set(auth(faculty.id)).expect(200);
    expect(profileIds(list.body)).toEqual(sorted([inScope.profileId, batchOnly.profileId]));
  });

  it('refuses a single-student read outside the caller scope and allows one inside it', async () => {
    const faculty = await staff('FACULTY_LECTURER', departmentB);
    const denied = await api().get(base() + '/students/' + inScope.profileId).set(auth(faculty.id));
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain(inScope.userId);
    await api().get(base() + '/students/' + outOfScope.profileId).set(auth(faculty.id)).expect(200);
  });

  it('leaves the administrator view unchanged', async () => {
    const list = await api().get(base() + '/students').set(auth(admin.id)).expect(200);
    expect(profileIds(list.body)).toEqual(everyone());
    expect(list.body.scope).toEqual({ kind: 'INSTITUTION', units: [] });
    await api().get(base() + '/students/' + outOfScope.profileId).set(auth(admin.id)).expect(200);
  });

  it('keeps a department head without a unit scope institution-wide until one is assigned', async () => {
    const head = await staff('DEPARTMENT_HEAD');
    expect(profileIds((await api().get(base() + '/students').set(auth(head.id)).expect(200)).body)).toEqual(everyone());
  });
});

describe('consented applications and external applications', () => {
  async function application(subject: string) {
    const employer = randomUUID(); const opportunity = randomUUID(); const version = randomUUID(); const id = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Local test employer')", [employer]);
    await pool.query("INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)", [opportunity, employer, admin.id, 'LOCAL-' + id.slice(0, 8)]);
    await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,'Local applied role','FULL_TIME','REMOTE',$3,$4)", [version, opportunity, '0'.repeat(64), admin.id]);
    await pool.query("INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,institution_visibility_granted_at) VALUES ($1,$2,$3,$4,$5,'APPLIED',now(),now(),now())", [id, opportunity, employer, version, subject]);
    return id;
  }
  async function declaration(subject: string) {
    const id = randomUUID();
    await pool.query("INSERT INTO external_applications (id,student_user_id,company_name,role_title,source_kind,applied_on,stage,institution_visibility_granted_at) VALUES ($1,$2,'Declared company','Declared role','REFERRAL',current_date,'APPLIED',now())", [id, subject]);
    return id;
  }
  const applicationsPath = (subject: string) => base() + '/students/' + subject + '/applications';
  const externalPath = (subject: string) => base() + '/students/' + subject + '/external-applications';

  it('shows department B faculty their own student only, and the administrator both', async () => {
    const inside = await application(outOfScope.userId);
    await application(inScope.userId);
    const faculty = await staff('FACULTY_LECTURER', departmentB);
    expect((await api().get(applicationsPath(inScope.userId)).set(auth(faculty.id)).expect(200)).body.applications).toEqual([]);
    const own = (await api().get(applicationsPath(outOfScope.userId)).set(auth(faculty.id)).expect(200)).body.applications;
    expect(own.map((entry: { id: string }) => entry.id)).toEqual([inside]);
    expect((await api().get(applicationsPath(inScope.userId)).set(auth(admin.id)).expect(200)).body.applications).toHaveLength(1);
  });

  it('applies the same scope to external applications', async () => {
    const inside = await declaration(outOfScope.userId);
    await declaration(inScope.userId);
    const head = await staff('DEPARTMENT_HEAD', departmentB);
    expect((await api().get(externalPath(inScope.userId)).set(auth(head.id)).expect(200)).body.externalApplications).toEqual([]);
    const own = (await api().get(externalPath(outOfScope.userId)).set(auth(head.id)).expect(200)).body.externalApplications;
    expect(own.map((entry: { id: string }) => entry.id)).toEqual([inside]);
    expect((await api().get(externalPath(inScope.userId)).set(auth(admin.id)).expect(200)).body.externalApplications).toHaveLength(1);
  });
});

describe('academic verification queue', () => {
  async function pendingTerm(subject: string): Promise<string> {
    const qualification = randomUUID(); const term = randomUUID();
    await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,verification_state)
      VALUES ($1,$2,$3,'BTECH','Computer Science and Engineering','PENDING_VERIFICATION')`, [qualification, subject, institutionId]);
    await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,source,verification_state)
      VALUES ($1,$2,1,'Semester 1',8.1,'CGPA_10','STUDENT_DECLARED','PENDING_VERIFICATION')`, [term, qualification]);
    return term;
  }
  const queuePath = () => base() + '/academic-verification-queue';
  const termIds = (body: { queue: { termId: string }[] }) => sorted(body.queue.map((entry) => entry.termId));

  it('lists only in-scope terms and refuses a decision on an out-of-scope one', async () => {
    const outside = await pendingTerm(inScope.userId);
    const inside = await pendingTerm(outOfScope.userId);
    const faculty = await staff('FACULTY_LECTURER', departmentB);
    expect(termIds((await api().get(queuePath()).set(auth(faculty.id)).expect(200)).body)).toEqual([inside]);
    await api().post(base() + '/academic-verification/' + outside + '/decide').set(auth(faculty.id))
      .send({ decision: 'VERIFIED' }).expect(403);
    const state = await pool.query('SELECT verification_state FROM student_academic_terms WHERE id=$1', [outside]);
    expect(state.rows[0].verification_state).toBe('PENDING_VERIFICATION');
    expect(termIds((await api().get(queuePath()).set(auth(admin.id)).expect(200)).body)).toEqual(sorted([inside, outside]));
  });
});

describe('institution readiness report', () => {
  async function snapshots(subjects: readonly string[], modelVersionId: string) {
    for (const subject of subjects) {
      await pool.query(`INSERT INTO readiness_snapshots (id,subject_user_id,model_version_id,evidence_ids,evidence_set_hash,band,explanation,generated_at)
        VALUES ($1,$2,$3,'{}'::uuid[],$4,'DEVELOPING','{}'::jsonb,$5)`, [randomUUID(), subject, modelVersionId, randomUUID().replaceAll('-', '').padEnd(64, '0'), lastMonth().periodStart.slice(0, 7) + '-10T00:00:00Z']);
    }
    // The relationships in this file start two days ago; the snapshots are last month's.
    await pool.query("UPDATE institution_relationships SET effective_from='2020-01-01T00:00:00Z' WHERE institution_id=$1", [institutionId]);
  }
  /** INST-SR-01: a report covers one whole calendar month that has ended. */
  function lastMonth(): { periodStart: string; periodEnd: string } {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10) };
  }
  it('counts only the department head department, and the whole college for the administrator', async () => {
    const modelVersionId = randomUUID();
    await pool.query(`INSERT INTO readiness_model_versions (id,stable_key,version,policy,published_by_user_id,published_at,active)
      VALUES ($1,'career-readiness-fundamentals',1,'{}'::jsonb,$2,now(),true)`, [modelVersionId, admin.id]);
    await pool.query(`INSERT INTO release_manifests (id,name,version,manifest_hash,status)
      VALUES ('25000000-0000-4000-8000-000000000001','Local pilot release',1,$1,'DRAFT')`, ['a'.repeat(64)]);
    const departmentAStudents = [inScope.userId, otherBatch.userId, batchOnly.userId];
    const departmentBStudents = [outOfScope.userId];
    for (let index = 0; index < 4; index += 1) {
      departmentAStudents.push((await student('A-' + index, 'Department A cohort ' + index, departmentA, null)).userId);
      departmentBStudents.push((await student('B-' + index, 'Department B cohort ' + index, departmentB, null)).userId);
    }
    await snapshots([...departmentAStudents, ...departmentBStudents], modelVersionId);
    const period = '?periodStart=' + lastMonth().periodStart + '&periodEnd=' + lastMonth().periodEnd;
    const developing = (body: { aggregate: { bands: { band: string; count: number | null }[] } }) =>
      body.aggregate.bands.find((entry) => entry.band === 'DEVELOPING')?.count;
    const head = await staff('DEPARTMENT_HEAD', departmentB);
    const scoped = await api().post(base() + '/career-readiness/reports' + period).set(auth(head.id)).expect(201);
    // Every student is DEVELOPING, so the other bands are empty cells (<5) and the total is
    // withheld: publishing it would say those bands are empty (INST-SR-01).
    expect(scoped.body.aggregate).toMatchObject({ suppressed: false, cohortSize: null, cohortSizeSuppressed: true, scope: 'UNITS' });
    expect(developing(scoped.body)).toBe(5);
    const whole = await api().post(base() + '/career-readiness/reports' + period).set(auth(admin.id)).expect(201);
    expect(whole.body.aggregate).toMatchObject({ suppressed: false, cohortSize: null, cohortSizeSuppressed: true, scope: 'INSTITUTION' });
    expect(developing(whole.body)).toBe(12);
    for (const body of [scoped.body, whole.body]) {
      expect(body.aggregate.bands.map((entry: { band: string }) => entry.band)).toEqual(['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP']);
      for (const entry of body.aggregate.bands as { count: number | null; suppressed: boolean }[]) {
        if (entry.suppressed) expect(entry.count).toBeNull();
        else expect(entry.count).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('refuses any period but one whole calendar month that has ended, and stores nothing', async () => {
    const now = new Date();
    const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const thisMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const twoMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)).toISOString().slice(0, 10);
    const { periodStart, periodEnd } = lastMonth();
    const secondDay = periodStart.slice(0, 8) + '02';
    for (const [start, end] of [
      [thisMonthStart, thisMonthEnd],          // still filling: could be regenerated and compared day by day
      [secondDay, periodEnd],                  // overlaps the whole month by all but one day
      [periodStart, secondDay],                // part of a month
      [twoMonthsAgo, periodEnd],               // two months, overlapping last month's report
    ]) {
      const refused = await api().post(base() + '/career-readiness/reports?periodStart=' + start + '&periodEnd=' + end).set(auth(admin.id)).expect(400);
      expect(refused.body.error.code).toBe('REPORT_PERIOD_INVALID');
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_aggregate_reports WHERE institution_id=$1', [institutionId])).rows[0].n).toBe(0);
  });
});

describe('assessment results', () => {
  it('shows results, pending students and the assigned count for in-scope students only', async () => {
    const subject = randomUUID(); const definition = randomUUID();
    await pool.query("INSERT INTO exam_subjects (id,institution_id,name) VALUES ($1,$2,'Aptitude')", [subject, institutionId]);
    await pool.query(`INSERT INTO exam_definitions (id,institution_id,subject_id,title,exam_kind,lifecycle_state,total_marks,duration_seconds,
        starts_at,ends_at,publish_results_immediately,created_by_user_id,published_at)
      VALUES ($1,$2,$3,'Scope paper','UNIT_TEST','PUBLISHED',10,1800,now()-interval '1 hour',now()+interval '1 hour',true,$4,now())`,
    [definition, institutionId, subject, admin.id]);
    for (const learner of [inScope, outOfScope, otherBatch]) {
      await pool.query('INSERT INTO exam_assignments (id,institution_id,definition_id,student_user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), institutionId, definition, learner.userId, admin.id]);
    }
    for (const learner of [inScope, outOfScope]) {
      const attempt = randomUUID();
      await pool.query(`INSERT INTO exam_attempts (id,institution_id,definition_id,student_user_id,attempt_number,status,paper_seed,submitted_at)
        VALUES ($1,$2,$3,$4,1,'SUBMITTED',$5,now())`, [attempt, institutionId, definition, learner.userId, randomUUID()]);
      await pool.query(`INSERT INTO exam_results (id,attempt_id,score,max_score,percentage,correct_count,wrong_count,not_attempted_count,time_taken_seconds,published)
        VALUES ($1,$2,7,10,70,7,0,3,600,true)`, [randomUUID(), attempt]);
    }
    const resultsPath = base() + '/assessments/' + definition + '/results';
    const faculty = await staff('FACULTY_LECTURER', departmentB);
    const scoped = (await api().get(resultsPath).set(auth(faculty.id)).expect(200)).body;
    expect(scoped.results.map((entry: { studentName: string }) => entry.studentName)).toEqual(['Other Department Student']);
    expect(scoped.notAttempted).toEqual([]);
    expect(scoped.summary).toMatchObject({ attempts: 1, assigned: 1, notAttemptedCount: 0 });
    const whole = (await api().get(resultsPath).set(auth(admin.id)).expect(200)).body;
    expect(whole.summary).toMatchObject({ attempts: 2, assigned: 3, notAttemptedCount: 1 });
  });
});

describe('staff actions after the predicate move', () => {
  it('lists the same in-scope students through the shared definition', async () => {
    const faculty = await staff('FACULTY_LECTURER', departmentA, batchA1);
    const list = await api().get(base() + '/staff-actions').set(auth(faculty.id)).expect(200);
    expect(sorted(list.body.students.map((entry: { id: string }) => entry.id))).toEqual(sorted([inScope.userId, batchOnly.userId]));
    const everyStudent = await api().get(base() + '/staff-actions').set(auth(admin.id)).expect(200);
    expect(everyStudent.body.students).toHaveLength(4);
  });
});
