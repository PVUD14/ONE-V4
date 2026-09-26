/**
 * Academic verification screen API and bulk results upload (INST-04).
 *
 * The queue a verifier works from, the decision with its reason code and audit row, the
 * dashboard summary, and the results upload: a validated preview, a commit that writes
 * all or nothing and records institution-verified results against the uploader, and
 * conflicts with what a student reported shown rather than overwritten
 * (docs/architecture/academic-results-import-design.md, decision 10.2 #9).
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
if (!connectionString) throw new Error('DATABASE_URL is required for academic verification tests');
const schemaName = 'academic_verification_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string;
let otherInstitutionId: string;
let departmentA: string;
let departmentB: string;
let programmeA: string;
let studentA: Student;   // department A, roll A-001
let studentA2: Student;  // department A, roll A-002
let studentB: Student;   // department B, roll B-001
let admin: Staff;

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
  departmentA = randomUUID(); departmentB = randomUUID(); programmeA = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution'), ($2,'INSTITUTION','Other institution')",
    [institutionId, otherInstitutionId]);
  await pool.query(`INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES
    ($1,$3,'DEPARTMENT','Department A',NULL), ($2,$3,'DEPARTMENT','Department B',NULL)`, [departmentA, departmentB, institutionId]);
  await pool.query(`INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES
    ($1,$2,'PROGRAM','Computer Science and Engineering',$3)`, [programmeA, institutionId, departmentA]);
  studentA = await student('A-001', 'Student A One', departmentA, programmeA);
  studentA2 = await student('A-002', 'Student A Two', departmentA, programmeA);
  studentB = await student('B-001', 'Student B One', departmentB, null);
  admin = await staff('INSTITUTION_ADMIN');
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function student(rollNumber: string, fullName: string, department: string | null, programme: string | null): Promise<Student> {
  const userId = randomUUID(); const profileId = randomUUID();
  await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,program_unit_id,academic_start_date)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,'2022-08-01')`, [profileId, institutionId, userId, rollNumber, fullName, department, programme]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE',now()-interval '2 days')`, [randomUUID(), institutionId, userId]);
  return { userId, profileId };
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
/** A student's own declared programme at this institution, with one term in the given state. */
async function declaredTerm(subject: string, values: { sequence?: number; value?: number; backlogs?: number | null; state?: string; evidence?: string | null } = {}): Promise<string> {
  const qualification = randomUUID(); const term = randomUUID();
  await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name)
    VALUES ($1,$2,$3,'BTECH','Computer Science and Engineering')`, [qualification, subject, institutionId]);
  await pool.query(`INSERT INTO student_academic_terms
    (id,qualification_id,sequence,label,result_value,result_scale,backlog_count,source,evidence_document_version_id,verification_state)
    VALUES ($1,$2,$3,'Semester 4',$4,'CGPA_10',$5,$6,$7,$8)`,
  [term, qualification, values.sequence ?? 4, values.value ?? 8.1, values.backlogs === undefined ? 0 : values.backlogs,
    values.evidence ? 'DOCUMENT_BACKED' : 'STUDENT_DECLARED', values.evidence ?? null, values.state ?? 'PENDING_VERIFICATION']);
  return term;
}
async function evidenceVersion(subject: string): Promise<string> {
  const file = randomUUID(); const document = randomUUID(); const version = randomUUID();
  await pool.query(`INSERT INTO stored_files (id,storage_key,original_filename,content_type,uploaded_by_user_id)
    VALUES ($1,$2,'priya-private-marksheet-sem4.pdf','application/pdf',$3)`, [file, 'documents/' + file, subject]);
  await pool.query(`INSERT INTO student_document_metadata (id,student_user_id,title,document_type) VALUES ($1,$2,'Semester 4 marksheet','TRANSCRIPT')`, [document, subject]);
  await pool.query(`INSERT INTO student_document_versions (id,document_id,version_number,file_id,created_by_user_id) VALUES ($1,$2,2,$3,$4)`, [version, document, file, subject]);
  return version;
}

const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const header = 'institution_student_id,term_sequence,term_label,scale,result,backlogs,qualification_type,programme';
const csvOf = (...rows: string[]) => [header, ...rows].join('\n');
const preview = (actor: Staff, csv: string) => api().post(base() + '/academic-results-imports/preview').set(auth(actor.id)).send({ filename: 'sem4.csv', csv });
const commit = (actor: Staff, csv: string, previewDigest: string, reasonCode = 'RESULTS_DECLARED') =>
  api().post(base() + '/academic-results-imports/commit').set(auth(actor.id)).send({ filename: 'sem4.csv', csv, previewDigest, reasonCode });
const count = async (table: string) => Number((await pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n);
const auditActions = async () => (await pool.query('SELECT action, context FROM audit_events ORDER BY occurred_at, action')).rows as { action: string; context: Record<string, unknown> }[];

describe('verification queue and decisions', () => {
  it('requires a token, an institution staff role and the right institution', async () => {
    await api().get(base() + '/academic-verification-queue').expect(401);
    await api().get(base() + '/academic-verification-summary').expect(401);
    const stranger = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
    await api().get(base() + '/academic-verification-queue').set(auth(stranger.id)).expect(403);
    await api().get(base() + '/academic-verification-summary').set(auth(stranger.id)).expect(403);
    const outsider = randomUUID();
    tokens.add(outsider);
    await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [outsider, outsider + '@example.test']);
    await api().get(base() + '/academic-verification-queue').set(auth(outsider)).expect(403);
  });

  it('shows evidence as title, type and version only — never the filename, the file or a link', async () => {
    await declaredTerm(studentA.userId, { evidence: await evidenceVersion(studentA.userId) });
    const response = await api().get(base() + '/academic-verification-queue').set(auth(admin.id)).expect(200);
    expect(response.body.queue[0].evidence).toEqual({ title: 'Semester 4 marksheet', documentType: 'TRANSCRIPT', versionNumber: 2, shared: false });
    const body = JSON.stringify(response.body);
    expect(body).not.toContain('priya-private-marksheet');
    expect(body).not.toContain('documents/');
    expect(body).not.toMatch(/url|download|storageKey|fileId/i);
    // There is no staff route that opens a student's evidence: ADR-027's per-version
    // consent does not exist yet, and the read path must not ship before it.
    const termId = response.body.queue[0].termId as string;
    const open = await api().get(base() + '/academic-verification/' + termId + '/evidence').set(auth(admin.id));
    expect(open.status).toBe(404);
  });

  it('requires a reason code and writes the decision and its audit row together', async () => {
    const term = await declaredTerm(studentA.userId);
    await api().post(base() + '/academic-verification/' + term + '/decide').set(auth(admin.id)).send({ decision: 'VERIFIED' }).expect(400);
    await api().post(base() + '/academic-verification/' + term + '/decide').set(auth(admin.id))
      .send({ decision: 'VERIFIED', reasonCode: 'lower case' }).expect(400);
    await api().post(base() + '/academic-verification/' + term + '/decide').set(auth(admin.id))
      .send({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD', extra: true }).expect(400);
    expect((await pool.query('SELECT verification_state FROM student_academic_terms WHERE id=$1', [term])).rows[0].verification_state).toBe('PENDING_VERIFICATION');
    const decided = await api().post(base() + '/academic-verification/' + term + '/decide').set(auth(admin.id))
      .send({ decision: 'REJECTED', reasonCode: 'DOES_NOT_MATCH_RECORD' }).expect(201);
    expect(decided.body.queue).toEqual([]);
    const row = (await pool.query('SELECT verification_state, verified_by_user_id FROM student_academic_terms WHERE id=$1', [term])).rows[0];
    expect(row).toEqual({ verification_state: 'REJECTED', verified_by_user_id: admin.id });
    const audit = (await auditActions()).filter((entry) => entry.action === 'academic_term.verification_decided');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.context).toEqual({ decision: 'REJECTED', reasonCode: 'DOES_NOT_MATCH_RECORD' });
  });

  it('lets a department head decide inside the department and refuses outside it', async () => {
    const inside = await declaredTerm(studentA.userId);
    const outside = await declaredTerm(studentB.userId);
    const head = await staff('DEPARTMENT_HEAD', departmentA);
    await api().post(base() + '/academic-verification/' + outside + '/decide').set(auth(head.id))
      .send({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD' }).expect(403);
    await api().post(base() + '/academic-verification/' + inside + '/decide').set(auth(head.id))
      .send({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD' }).expect(201);
    expect((await pool.query('SELECT verification_state FROM student_academic_terms WHERE id=$1', [outside])).rows[0].verification_state).toBe('PENDING_VERIFICATION');
  });

  // INST-SR-02: a decision is permanent, so it needs a department (heads) or an active
  // teaching assignment (faculty). Reading the queue is unchanged.
  it('refuses a decision from a department head with no department, with SCOPE_REQUIRED, while the queue stays readable', async () => {
    const term = await declaredTerm(studentA.userId);
    const head = await staff('DEPARTMENT_HEAD');
    const queue = await api().get(base() + '/academic-verification-queue').set(auth(head.id)).expect(200);
    expect(queue.body.queue.map((entry: { termId: string }) => entry.termId)).toEqual([term]);
    const refused = await api().post(base() + '/academic-verification/' + term + '/decide').set(auth(head.id))
      .send({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD' }).expect(403);
    expect(refused.body.error.code).toBe('SCOPE_REQUIRED');
    expect((await pool.query('SELECT verification_state FROM student_academic_terms WHERE id=$1', [term])).rows[0].verification_state).toBe('PENDING_VERIFICATION');
    expect((await auditActions()).filter((entry) => entry.action === 'academic_term.verification_decided')).toEqual([]);
  });

  it('refuses a decision from faculty without an active teaching assignment, and allows one inside an assignment', async () => {
    const batch = randomUUID();
    await pool.query("INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,'BATCH','Batch A1',$3)", [batch, institutionId, programmeA]);
    await pool.query('UPDATE institution_student_profiles SET batch_unit_id=$1 WHERE id=$2', [batch, studentA.profileId]);
    const inside = await declaredTerm(studentA.userId);
    const outside = await declaredTerm(studentA2.userId);
    const faculty = await staff('FACULTY_LECTURER', departmentA);
    // Before the college records any teaching assignment, reads fall back to the department; writes do not.
    const blocked = await api().post(base() + '/academic-verification/' + inside + '/decide').set(auth(faculty.id))
      .send({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD' }).expect(403);
    expect(blocked.body.error.code).toBe('SCOPE_REQUIRED');
    await pool.query(`INSERT INTO faculty_teaching_assignments (id,institution_id,faculty_membership_id,unit_id,subject_code,academic_term,assigned_by_user_id,reason_code)
      VALUES ($1,$2,$3,$4,'CS101','2026-ODD',$5,'TEACHING_ASSIGNED')`, [randomUUID(), institutionId, faculty.membershipId, batch, admin.id]);
    const other = await api().post(base() + '/academic-verification/' + outside + '/decide').set(auth(faculty.id))
      .send({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD' }).expect(403);
    expect(other.body.error.code).toBe('FORBIDDEN');
    await api().post(base() + '/academic-verification/' + inside + '/decide').set(auth(faculty.id))
      .send({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD' }).expect(201);
    const states = await pool.query('SELECT id, verification_state FROM student_academic_terms WHERE id = ANY($1::uuid[]) ORDER BY id', [[inside, outside]]);
    expect(Object.fromEntries(states.rows.map((row) => [row.id, row.verification_state]))).toEqual({ [inside]: 'VERIFIED', [outside]: 'PENDING_VERIFICATION' });
  });

  it('counts the backlog in SQL over the reader scope', async () => {
    await declaredTerm(studentA.userId);
    await declaredTerm(studentB.userId);
    await pool.query("UPDATE institution_relationships SET state='GRADUATED', effective_to=now() WHERE student_user_id=$1", [studentB.userId]);
    expect((await api().get(base() + '/academic-verification-summary').set(auth(admin.id)).expect(200)).body.summary).toEqual({ pending: 2, notCurrent: 1 });
    const faculty = await staff('FACULTY_LECTURER', departmentA);
    expect((await api().get(base() + '/academic-verification-summary').set(auth(faculty.id)).expect(200)).body.summary).toEqual({ pending: 1, notCurrent: 0 });
  });

  it('pages the queue with a keyset cursor and bounds the page size', async () => {
    const first = await declaredTerm(studentA.userId);
    const second = await declaredTerm(studentA2.userId);
    await api().get(base() + '/academic-verification-queue?limit=0').set(auth(admin.id)).expect(400);
    await api().get(base() + '/academic-verification-queue?limit=201').set(auth(admin.id)).expect(400);
    await api().get(base() + '/academic-verification-queue?after=not-a-cursor').set(auth(admin.id)).expect(400);
    const page1 = (await api().get(base() + '/academic-verification-queue?limit=1').set(auth(admin.id)).expect(200)).body;
    expect(page1.queue.map((entry: { termId: string }) => entry.termId)).toEqual([first]);
    expect(page1.nextCursor).toBe(first);
    const page2 = (await api().get(base() + '/academic-verification-queue?limit=1&after=' + page1.nextCursor).set(auth(admin.id)).expect(200)).body;
    expect(page2.queue.map((entry: { termId: string }) => entry.termId)).toEqual([second]);
  });
});

describe('bulk results upload', () => {
  it('requires a token and an uploader role in this institution', async () => {
    await api().post(base() + '/academic-results-imports/preview').send({ csv: csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,') }).expect(401);
    for (const role of ['FACULTY_LECTURER', 'PLACEMENT_ADMIN']) {
      const actor = await staff(role);
      await preview(actor, csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,')).expect(403);
    }
    const stranger = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
    await preview(stranger, csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,')).expect(403);
  });

  it('refuses a file with a missing, unknown or duplicated column, or unknown body fields', async () => {
    await api().post(base() + '/academic-results-imports/preview').set(auth(admin.id))
      .send({ csv: 'institution_student_id,term_sequence\nA-001,4' }).expect(400);
    await api().post(base() + '/academic-results-imports/preview').set(auth(admin.id))
      .send({ csv: header + ',cgpa_converted\nA-001,4,Semester 4,CGPA_10,8.4,0,BTECH,,8.4' }).expect(400);
    await api().post(base() + '/academic-results-imports/preview').set(auth(admin.id))
      .send({ csv: csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,'), previewDigest: 'x' }).expect(400);
  });

  it('previews row by row, writes nothing, and a commit with any invalid row writes nothing either', async () => {
    const csv = csvOf(
      'A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,',
      'A-002,4,Semester 4,CGPA_10,11.2,0,BTECH,',
      'Z-999,4,Semester 4,CGPA_10,7.0,0,BTECH,',
      'A-002,5,=HYPERLINK("http://example.test"),PERCENTAGE,71,1,BTECH,',
      'A-001,4,Semester 4 again,CGPA_10,8.4,0,BTECH,',
      'A-002,6,Semester 6,CGPA_10,8.0,,BTECH,',
    );
    const response = await preview(admin, csv).expect(201);
    const rows = response.body.preview.rows as { rowNumber: number; outcome: string; issues: string[] }[];
    expect(rows.map((row) => [row.rowNumber, row.outcome, row.issues])).toEqual([
      [2, 'CREATE', []],
      [3, 'INVALID', ['result_invalid']],
      [4, 'INVALID', ['student_not_found']],
      [5, 'INVALID', ['term_label_invalid']],
      [6, 'INVALID', ['duplicate_row']],
      [7, 'INVALID', ['backlogs_invalid']],
    ]);
    expect(response.body.preview.counts).toMatchObject({ create: 1, invalid: 5 });
    expect(JSON.stringify(response.body)).not.toContain(studentA.userId);
    expect(await count('student_academic_terms')).toBe(0);
    expect((await auditActions()).map((entry) => entry.action)).toEqual(['institution.academic_results.previewed']);

    const refused = await commit(admin, csv, response.body.preview.digest).expect(400);
    expect(refused.body.error.code).toBe('RESULTS_IMPORT_HAS_INVALID_ROWS');
    expect(refused.body.preview.rows).toHaveLength(6);
    expect(await count('student_academic_terms')).toBe(0);
    expect(await count('student_qualifications')).toBe(0);
  });

  it('commits institution-verified records attributed to the uploader, each audited', async () => {
    const csv = csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,', 'A-001,5,Semester 5,PERCENTAGE,71.5,1,BTECH,', 'A-002,4,Semester 4,PASS_FAIL,pass,0,BTECH,Data Science');
    const digest = (await preview(admin, csv).expect(201)).body.preview.digest as string;
    await commit(admin, csv, digest, 'not a code').expect(400);
    const committed = await commit(admin, csv, digest).expect(201);
    expect(committed.body.import).toMatchObject({ created: 3, confirmed: 0 });

    const qualifications = (await pool.query(`SELECT student_user_id, programme_name, qualification_type, started_on::text, verification_state, verified_by_user_id
      FROM student_qualifications ORDER BY programme_name`)).rows;
    expect(qualifications).toEqual([
      { student_user_id: studentA.userId, programme_name: 'Computer Science and Engineering', qualification_type: 'BTECH', started_on: '2022-08-01', verification_state: 'VERIFIED', verified_by_user_id: admin.id },
      { student_user_id: studentA2.userId, programme_name: 'Data Science', qualification_type: 'BTECH', started_on: '2022-08-01', verification_state: 'VERIFIED', verified_by_user_id: admin.id },
    ]);
    const terms = (await pool.query(`SELECT sequence, label, result_value::text, result_scale, result_letter, backlog_count, source, verification_state, verified_by_user_id
      FROM student_academic_terms ORDER BY label, result_scale`)).rows;
    // Stored as issued, on the scale it was issued on: 71.5 stays a percentage.
    expect(terms).toEqual([
      { sequence: 4, label: 'Semester 4', result_value: '8.400', result_scale: 'CGPA_10', result_letter: null, backlog_count: 0, source: 'INSTITUTION_IMPORTED', verification_state: 'VERIFIED', verified_by_user_id: admin.id },
      { sequence: 4, label: 'Semester 4', result_value: null, result_scale: 'PASS_FAIL', result_letter: 'PASS', backlog_count: 0, source: 'INSTITUTION_IMPORTED', verification_state: 'VERIFIED', verified_by_user_id: admin.id },
      { sequence: 5, label: 'Semester 5', result_value: '71.500', result_scale: 'PERCENTAGE', result_letter: null, backlog_count: 1, source: 'INSTITUTION_IMPORTED', verification_state: 'VERIFIED', verified_by_user_id: admin.id },
    ]);
    const actions = (await auditActions()).map((entry) => entry.action);
    expect(actions.filter((action) => action === 'academic_term.verified_by_import')).toHaveLength(3);
    const summary = (await auditActions()).find((entry) => entry.action === 'institution.academic_results.imported');
    expect(summary?.context).toMatchObject({ reasonCode: 'RESULTS_DECLARED', created: 3, confirmed: 0, filename: 'sem4.csv', digest });

    // Uploading the same sheet again changes nothing.
    const again = (await preview(admin, csv).expect(201)).body.preview;
    expect(again.rows.map((row: { outcome: string }) => row.outcome)).toEqual(['UNCHANGED', 'UNCHANGED', 'UNCHANGED']);
  });

  it('shows a differing student declaration beside the verified record and never overwrites it', async () => {
    const declared = await declaredTerm(studentA.userId, { value: 9.1 });
    const csv = csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,');
    const shown = (await preview(admin, csv).expect(201)).body.preview;
    expect(shown.rows[0]).toMatchObject({ outcome: 'CREATE', studentReported: { resultValue: '9.100', resultScale: 'CGPA_10', verificationState: 'PENDING_VERIFICATION' } });
    expect(shown.counts.differsFromStudent).toBe(1);
    await commit(admin, csv, shown.digest).expect(201);
    const student = (await pool.query('SELECT result_value::text, verification_state, verified_by_user_id FROM student_academic_terms WHERE id=$1', [declared])).rows[0];
    expect(student).toEqual({ result_value: '9.100', verification_state: 'PENDING_VERIFICATION', verified_by_user_id: null });
    // The person deciding the student's claim sees the college's verified value beside it.
    const queue = (await api().get(base() + '/academic-verification-queue').set(auth(admin.id)).expect(200)).body.queue;
    expect(queue[0]).toMatchObject({ termId: declared, institutionRecord: { resultValue: 8.4, resultScale: 'CGPA_10', backlogCount: 0 } });
  });

  it('confirms a matching student declaration instead of duplicating it', async () => {
    const declared = await declaredTerm(studentA.userId, { value: 8.4, state: 'SELF_REPORTED' });
    const csv = csvOf('A-001,4,Semester 4,CGPA_10,8.40,0,,');
    const shown = (await preview(admin, csv).expect(201)).body.preview;
    expect(shown.rows[0].outcome).toBe('CONFIRM');
    expect((await commit(admin, csv, shown.digest).expect(201)).body.import).toMatchObject({ created: 0, confirmed: 1 });
    const row = (await pool.query('SELECT source, verification_state, verified_by_user_id FROM student_academic_terms WHERE id=$1', [declared])).rows[0];
    expect(row).toEqual({ source: 'STUDENT_DECLARED', verification_state: 'VERIFIED', verified_by_user_id: admin.id });
    expect(await count('student_academic_terms')).toBe(1);
  });

  it('reports a conflict with an already verified record and writes nothing for it', async () => {
    const verified = await declaredTerm(studentA.userId, { value: 7.9 });
    await api().post(base() + '/academic-verification/' + verified + '/decide').set(auth(admin.id))
      .send({ decision: 'VERIFIED', reasonCode: 'MATCHES_INSTITUTION_RECORD' }).expect(201);
    const csv = csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,', 'A-002,4,Semester 4,CGPA_10,6.5,2,BTECH,');
    const shown = (await preview(admin, csv).expect(201)).body.preview;
    expect(shown.rows[0]).toMatchObject({ outcome: 'CONFLICT', verifiedRecord: { resultValue: '7.900', verificationState: 'VERIFIED' } });
    const committed = (await commit(admin, csv, shown.digest).expect(201)).body.import;
    expect(committed).toMatchObject({ created: 1, counts: { conflict: 1 } });
    expect((await pool.query('SELECT result_value::text FROM student_academic_terms WHERE id=$1', [verified])).rows[0].result_value).toBe('7.900');
  });

  it('refuses a commit whose records changed since the preview', async () => {
    const csv = csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,');
    const digest = (await preview(admin, csv).expect(201)).body.preview.digest as string;
    await declaredTerm(studentA.userId, { value: 8.4 });
    const stale = await commit(admin, csv, digest).expect(409);
    expect(stale.body.error.code).toBe('RESULTS_IMPORT_STALE');
    expect(await count('student_academic_terms')).toBe(1);
    await commit(admin, csv, 'f'.repeat(64)).expect(409);
  });

  it('limits a department head to their own department', async () => {
    const head = await staff('DEPARTMENT_HEAD', departmentB);
    const csv = csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,', 'B-001,4,Semester 4,CGPA_10,7.2,0,BTECH,Mechanical Engineering');
    const shown = (await preview(head, csv).expect(201)).body.preview;
    // The same answer as a roll number that does not exist: scope is not disclosed.
    expect(shown.rows.map((row: { outcome: string; issues: string[]; studentName: string | null }) => [row.outcome, row.issues, row.studentName]))
      .toEqual([['INVALID', ['student_not_found'], null], ['CREATE', [], 'Student B One']]);
    const adminView = (await preview(admin, csv).expect(201)).body.preview;
    expect(adminView.counts).toMatchObject({ create: 2, invalid: 0 });
  });

  it('refuses a results upload from a department head with no department, at preview and at commit, with SCOPE_REQUIRED', async () => {
    const head = await staff('DEPARTMENT_HEAD');
    const csv = csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,', 'B-001,4,Semester 4,CGPA_10,7.2,0,BTECH,Mechanical Engineering');
    const previewRefused = await preview(head, csv).expect(403);
    expect(previewRefused.body.error.code).toBe('SCOPE_REQUIRED');
    const digest = (await preview(admin, csv).expect(201)).body.preview.digest as string;
    const commitRefused = await commit(head, csv, digest).expect(403);
    expect(commitRefused.body.error.code).toBe('SCOPE_REQUIRED');
    expect(await count('student_academic_terms')).toBe(0);
  });

  it('asks for the programme type when the student has no institution record yet', async () => {
    const shown = (await preview(admin, csvOf('B-001,4,Semester 4,CGPA_10,7.2,0,,')).expect(201)).body.preview;
    expect(shown.rows[0]).toMatchObject({ outcome: 'INVALID', issues: ['qualification_type_required', 'programme_required'] });
  });

  it('never returns a numeric readiness value or compensation', async () => {
    const shown = await preview(admin, csvOf('A-001,4,Semester 4,CGPA_10,8.4,0,BTECH,')).expect(201);
    const queue = await api().get(base() + '/academic-verification-queue').set(auth(admin.id)).expect(200);
    for (const body of [shown.body, queue.body]) expect(JSON.stringify(body)).not.toMatch(/readiness|compensation|salary/i);
  });
});
