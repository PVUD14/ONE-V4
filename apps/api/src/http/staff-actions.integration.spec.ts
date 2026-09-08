/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-05
 * Agent-assisted: yes (Codex) · Reviewed: pending
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
import { institutionForbiddenDisclosureFields, isInstitutionForbiddenDisclosureField } from '@planthepath/authorization/src/index.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for staff-action tests');
const schemaName = 'staff_actions_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const executedQueries: string[] = [];
const db = drizzle(pool, { schema, logger: { logQuery(query) { executedQueries.push(query); } } });
const tokens = new Set<string>();
let nextIds: string[] = [];
let app: INestApplication;
let institutionId: string;
let studentId: string;
let relationshipId: string;
let departmentId: string;
let admin: { id: string; membershipId: string };

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => nextIds.shift() ?? randomUUID() },
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
  tokens.clear(); nextIds = []; executedQueries.length = 0;
  institutionId = randomUUID(); studentId = randomUUID(); relationshipId = randomUUID(); departmentId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution')", [institutionId]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Local department')", [departmentId, institutionId]);
  await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [studentId, studentId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,updated_at)
    VALUES ($1,$2,$3,'C4-001','Local student','ACTIVE',$4,now()-interval '1 day')`, [randomUUID(), institutionId, studentId, departmentId]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE',now()-interval '2 days')`, [relationshipId, institutionId, studentId]);
  admin = await staff('INSTITUTION_ADMIN');
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});
async function staff(role: string, org = institutionId, department: string | null = null) {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, org, id, role, department]);
  return { id, membershipId };
}
const api = () => request(app.getHttpServer());
const path = () => '/api/v1/institutions/' + institutionId + '/staff-actions';
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const draft = (id = admin.id, body: Record<string, unknown> = {}) => api().post(path()).set(auth(id))
  .send({ studentUserId: studentId, title: 'Local intervention', note: 'Follow-up required', ...body });
async function transition(id: string, version: number, toState: string, actor = admin.id) {
  return api().post(path() + '/' + id + '/transition').set(auth(actor)).send({ version, toState, note: 'Recorded test outcome' });
}

describe('C4 protected staff-action workflow', () => {
  it.each(['INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'])('allows scoped %s to create a draft and records trusted actor identity', async (role) => {
    const actor = await staff(role, institutionId, departmentId);
    const created = await draft(actor.id, { actorUserId: randomUUID(), actionType: 'MEETING', visibility: 'SUBJECT_VISIBLE' });
    expect(created.status).toBe(201);
    const row = (await pool.query('SELECT * FROM staff_actions WHERE id=$1', [created.body.id])).rows[0];
    expect(row.actor_user_id).toBe(actor.id);
    expect(row.actor_membership_id).toBe(actor.membershipId);
    expect(row.assigned_to_membership_id).toBe(actor.membershipId);
    expect(row.action_type).toBe('INTERVENTION');
    expect(row.visibility).toBe('STAFF_ONLY');
    const audit = (await pool.query("SELECT * FROM audit_events WHERE resource_id=$1", [created.body.id])).rows[0];
    expect(audit.actor_user_id).toBe(actor.id);
    expect(audit.context).toMatchObject({ toState: 'DRAFT', version: 1 });
    const list = await api().get(path()).set(auth(actor.id));
    expect(list.status).toBe(200);
    expect(list.body.actions[0]).toMatchObject({ studentName: 'Local student', allowedTransitions: ['UNDER_REVIEW', 'CANCELLED'] });
  });

  it('requires authentication and denies tenant substitution', async () => {
    expect((await api().get(path())).status).toBe(401);
    const otherOrg = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Other institution')", [otherOrg]);
    const other = await staff('INSTITUTION_ADMIN', otherOrg);
    expect((await draft(other.id)).status).toBe(403);
    expect((await api().get(path()).set(auth(other.id))).status).toBe(403);
  });

  it('enforces department scope for both writes and reads', async () => {
    const otherDepartment = randomUUID();
    await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Other department')", [otherDepartment, institutionId]);
    const actor = await staff('FACULTY_LECTURER', institutionId, otherDepartment);
    await draft();
    expect((await draft(actor.id)).status).toBe(403);
    const list = await api().get(path()).set(auth(actor.id));
    expect(list.body).toMatchObject({ actions: [], students: [] });
  });

  it('rechecks ended memberships before a mutation', async () => {
    const created = await draft();
    await pool.query("UPDATE organization_memberships SET state='ENDED' WHERE id=$1", [admin.membershipId]);
    expect((await transition(created.body.id, 1, 'UNDER_REVIEW')).status).toBe(403);
  });

  it('uses question-bank review edges, senior review roles, optimistic versioning and audit history', async () => {
    const faculty = await staff('FACULTY_LECTURER');
    const created = await draft(faculty.id);
    const id = created.body.id;
    expect((await transition(id, 1, 'APPROVED')).status).toBe(403);
    expect((await transition(id, 1, 'UNDER_REVIEW', faculty.id)).status).toBe(201);
    expect((await transition(id, 2, 'APPROVED', faculty.id)).status).toBe(403);
    expect((await transition(id, 2, 'APPROVED')).status).toBe(201);
    expect((await transition(id, 2, 'IN_PROGRESS', faculty.id)).status).toBe(409);
    expect((await transition(id, 3, 'IN_PROGRESS', faculty.id)).status).toBe(201);
    expect((await transition(id, 4, 'COMPLETED', faculty.id)).status).toBe(201);
    const audits = (await pool.query("SELECT context FROM audit_events WHERE resource_id=$1 ORDER BY (context->>'version')::integer", [id])).rows;
    expect(audits.map((entry) => entry.context.toState)).toEqual(['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'IN_PROGRESS', 'COMPLETED']);
    const row = (await pool.query('SELECT * FROM staff_actions WHERE id=$1', [id])).rows[0];
    expect(row.last_reviewed_by_user_id).toBe(admin.id);
    expect(row.resolved_at).toBeInstanceOf(Date);
    expect(row.version).toBe(5);
  });

  it('does not allow concurrent stale transitions to create duplicate audit events', async () => {
    const created = await draft();
    const results = await Promise.all([transition(created.body.id, 1, 'UNDER_REVIEW'), transition(created.body.id, 1, 'UNDER_REVIEW')]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect((await pool.query('SELECT count(*)::integer AS n FROM audit_events WHERE resource_id=$1', [created.body.id])).rows[0].n).toBe(2);
  });

  it('allows historical activity but denies later edits and new writes after transfer', async () => {
    const created = await draft();
    await pool.query("UPDATE staff_actions SET created_at=now()-interval '1 day',updated_at=now()-interval '1 day' WHERE id=$1", [created.body.id]);
    await pool.query("UPDATE institution_relationships SET state='TRANSFERRED',effective_to=now()-interval '1 hour' WHERE id=$1", [relationshipId]);
    let list = await api().get(path()).set(auth(admin.id));
    expect(list.body.actions).toHaveLength(1);
    expect(list.body.actions[0].allowedTransitions).toEqual([]);
    expect((await draft()).status).toBe(403);
    expect((await transition(created.body.id, 1, 'UNDER_REVIEW')).status).toBe(403);
    await pool.query('UPDATE staff_actions SET updated_at=now() WHERE id=$1', [created.body.id]);
    list = await api().get(path()).set(auth(admin.id));
    expect(list.body.actions).toEqual([]);
  });

  it('denies a record from a revoked relationship and ignores a later re-enrollment for that record', async () => {
    const created = await draft();
    await pool.query("UPDATE institution_relationships SET state='REVOKED',effective_to=now() WHERE id=$1", [relationshipId]);
    await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
      VALUES ($1,$2,$3,'ACTIVE',now())`, [randomUUID(), institutionId, studentId]);
    expect((await api().get(path()).set(auth(admin.id))).body.actions).toEqual([]);
    expect((await transition(created.body.id, 1, 'UNDER_REVIEW')).status).toBe(403);
  });

  it('rolls back the action when its audit insert fails', async () => {
    const collisionId = randomUUID();
    await pool.query(`INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,outcome,correlation_id)
      VALUES ($1,$2,'local.test','test','test','SUCCESS',$3)`, [collisionId, admin.id, randomUUID()]);
    nextIds = [randomUUID(), collisionId];
    expect((await draft()).status).toBe(500);
    expect((await pool.query('SELECT count(*)::integer AS n FROM staff_actions')).rows[0].n).toBe(0);
  });
});

const c5Types = ['ASSIGNED_TASK', 'FACULTY_NOTE', 'ACADEMIC_VERIFICATION', 'MEETING'];
const typedPath = (type: string, suffix = '') => path() + suffix + '?actionType=' + type;
function createC5(type: string, actor = admin.id, overrides: Record<string, unknown> = {}) {
  return api().post(typedPath(type)).set(auth(actor)).send({
    studentUserId: studentId, title: 'Local ' + type, note: 'Local staff note',
    ...(type === 'MEETING' ? { scheduledStartAt: '2030-01-01T10:00:00Z', scheduledEndAt: '2030-01-01T11:00:00Z' } : {}),
    ...overrides,
  });
}
function moveC5(type: string, id: string, version: number, toState: string, actor = admin.id, note: string | null = 'Recorded outcome') {
  return api().post(typedPath(type, '/' + id + '/transition')).set(auth(actor)).send({ version, toState, note });
}
describe('C5 staff-action workflows', () => {
  it.each(c5Types)('creates and lists only %s records, with trusted identity and staff-only visibility', async (type) => {
    await draft();
    const faculty = await staff('FACULTY_LECTURER', institutionId, departmentId);
    const created = await createC5(type, faculty.id, { actorUserId: admin.id });
    expect(created.status).toBe(201);
    const response = await api().get(typedPath(type)).set(auth(faculty.id));
    expect(response.status).toBe(200);
    expect(response.body.actions).toHaveLength(1);
    expect(response.body.actions[0]).toMatchObject({
      id: created.body.id, actionType: type, visibility: 'STAFF_ONLY', authorName: faculty.id + '@example.test',
      assignedToMembershipId: faculty.membershipId, studentUserId: studentId, state: 'DRAFT',
    });
    expect((await api().get(path()).set(auth(faculty.id))).body.actions).toHaveLength(1);
    const wrongType = type === 'ASSIGNED_TASK' ? 'FACULTY_NOTE' : 'ASSIGNED_TASK';
    expect((await moveC5(wrongType, created.body.id, 1, 'UNDER_REVIEW')).status).toBe(403);
    expect((await transition(created.body.id, 1, 'UNDER_REVIEW')).status).toBe(403);
    const row = (await pool.query('SELECT actor_user_id,actor_membership_id FROM staff_actions WHERE id=$1', [created.body.id])).rows[0];
    expect(row).toEqual({ actor_user_id: faculty.id, actor_membership_id: faculty.membershipId });
  });

  it.each(c5Types)('denies unauthenticated and other-institution access for %s', async (type) => {
    const otherOrg = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Other local institution')", [otherOrg]);
    const other = await staff('INSTITUTION_ADMIN', otherOrg);
    const created = await createC5(type);
    expect((await api().get(typedPath(type))).status).toBe(401);
    expect((await api().get(typedPath(type)).set(auth(other.id))).status).toBe(403);
    expect((await createC5(type, other.id)).status).toBe(403);
    expect((await moveC5(type, created.body.id, 1, 'UNDER_REVIEW', other.id)).status).toBe(403);
  });

  it.each(c5Types)('preserves student and department isolation for %s including updates', async (type) => {
    const department = randomUUID();
    await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Other department')", [department, institutionId]);
    const other = await staff('FACULTY_LECTURER', institutionId, department);
    const created = await createC5(type);
    expect((await createC5(type, other.id)).status).toBe(403);
    expect((await api().get(typedPath(type)).set(auth(other.id))).body.actions).toEqual([]);
    expect((await moveC5(type, created.body.id, 1, 'UNDER_REVIEW', other.id)).status).toBe(403);
    expect((await api().post(typedPath(type, '/' + created.body.id + '/update')).set(auth(other.id)).send({ version: 1, title: 'Changed' })).status).toBe(403);
    expect((await api().get(typedPath(type)).query({ studentUserId: randomUUID() }).set(auth(admin.id))).body.actions).toEqual([]);
    expect((await api().get(typedPath(type)).query({ studentUserId: studentId }).set(auth(admin.id))).body.actions).toHaveLength(1);
  });

  it('updates task drafts with audit, expected version and immutable author/student/type', async () => {
    const faculty = await staff('FACULTY_LECTURER');
    const created = await createC5('ASSIGNED_TASK', faculty.id, { assignedToMembershipId: faculty.membershipId });
    const url = typedPath('ASSIGNED_TASK', '/' + created.body.id + '/update');
    const updated = await api().post(url).set(auth(faculty.id)).send({ version: 1, title: 'Revised task', note: 'Revised note', dueAt: '2030-02-01T10:00:00Z' });
    expect(updated.status).toBe(201);
    expect(updated.body.version).toBe(2);
    expect((await api().post(url).set(auth(faculty.id)).send({ version: 1, title: 'Stale' })).status).toBe(409);
    expect((await api().post(url).set(auth(faculty.id)).send({ version: 2, studentUserId: randomUUID() })).status).toBe(400);
    const list = await api().get(typedPath('ASSIGNED_TASK')).query({ state: 'DRAFT', assigneeMembershipId: faculty.membershipId }).set(auth(admin.id));
    expect(list.body.actions[0]).toMatchObject({ title: 'Revised task', note: 'Revised note', authorName: faculty.id + '@example.test', version: 2 });
    expect((await api().get(typedPath('ASSIGNED_TASK')).query({ state: 'APPROVED' }).set(auth(admin.id))).body.actions).toEqual([]);
    expect((await api().get(typedPath('ASSIGNED_TASK')).query({ assigneeMembershipId: admin.membershipId }).set(auth(admin.id))).body.actions).toEqual([]);
    const audits = (await pool.query("SELECT context FROM audit_events WHERE resource_id=$1 AND action='staff_action.updated'", [created.body.id])).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].context).toMatchObject({ before: { title: 'Local ASSIGNED_TASK' }, after: { title: 'Revised task' }, version: 2 });
    expect((await moveC5('ASSIGNED_TASK', created.body.id, 2, 'UNDER_REVIEW', faculty.id)).status).toBe(201);
    expect((await api().post(url).set(auth(faculty.id)).send({ version: 3, title: 'Edit reviewed content' })).status).toBe(403);
  });

  it('does not infer delegation, public notes, evidence access or a new action vocabulary', async () => {
    const other = await staff('FACULTY_LECTURER');
    expect((await createC5('ASSIGNED_TASK', admin.id, { assignedToMembershipId: other.membershipId })).status).toBe(403);
    expect((await createC5('FACULTY_NOTE', admin.id, { visibility: 'SUBJECT_VISIBLE' })).status).toBe(403);
    expect((await createC5('ACADEMIC_VERIFICATION', admin.id, { evidenceDocumentVersionId: randomUUID() })).status).toBe(403);
    expect((await createC5('UNKNOWN')).status).toBe(400);
    expect((await createC5('FACULTY_NOTE', admin.id, { note: '' })).status).toBe(400);
    tokens.add(studentId);
    await pool.query('UPDATE users SET external_subject=$1::text WHERE id=$1::uuid', [studentId]);
    expect((await api().get(typedPath('FACULTY_NOTE')).set(auth(studentId))).status).toBe(403);
  });

  it('reviews generic verification with outcome and existing senior roles, without academic mutations', async () => {
    const faculty = await staff('FACULTY_LECTURER');
    const created = await createC5('ACADEMIC_VERIFICATION', faculty.id);
    const id = created.body.id;
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 1, 'APPROVED')).status).toBe(403);
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 1, 'UNDER_REVIEW', faculty.id)).status).toBe(201);
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 2, 'APPROVED', faculty.id)).status).toBe(403);
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 2, 'CHANGES_REQUESTED')).status).toBe(403);
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 2, 'REJECTED')).status).toBe(201);
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 3, 'DRAFT', faculty.id)).status).toBe(201);
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 4, 'UNDER_REVIEW', faculty.id)).status).toBe(201);
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 5, 'APPROVED', admin.id, null)).status).toBe(400);
    expect((await moveC5('ACADEMIC_VERIFICATION', id, 5, 'APPROVED')).status).toBe(201);
    const row = (await api().get(typedPath('ACADEMIC_VERIFICATION')).set(auth(admin.id))).body.actions[0];
    expect(row).toMatchObject({ reviewerName: admin.id + '@example.test', outcomeNote: 'Recorded outcome', state: 'APPROVED' });
    expect(row.lastReviewedAt).toBeTruthy();
    expect((await pool.query('SELECT status FROM institution_student_profiles WHERE student_user_id=$1', [studentId])).rows[0].status).toBe('ACTIVE');
  });

  it.each([
    { scheduledStartAt: null, scheduledEndAt: null },
    { scheduledEndAt: null },
    { scheduledStartAt: 'invalid' },
    { scheduledEndAt: '2030-01-01T10:00:00Z' },
    { scheduledEndAt: '2030-01-01T09:00:00Z' },
    { scheduledStartAt: '2030-01-01T10:00:00' },
  ])('rejects invalid meeting timestamps %j', async (overrides) => {
    expect((await createC5('MEETING', admin.id, overrides)).status).toBe(400);
    expect((await pool.query('SELECT count(*)::integer AS n FROM staff_actions')).rows[0].n).toBe(0);
  });

  it('scopes studentless meetings to the creator membership and supports past/upcoming, completion and cancellation', async () => {
    const faculty = await staff('FACULTY_LECTURER', institutionId, departmentId);
    const future = await createC5('MEETING', faculty.id, { studentUserId: null });
    expect(future.status).toBe(201);
    const past = await createC5('MEETING', faculty.id, { studentUserId: null, scheduledStartAt: '2020-01-01T10:00:00Z', scheduledEndAt: '2020-01-01T11:00:00Z' });
    expect(past.status).toBe(201);
    expect((await api().get(typedPath('MEETING')).query({ period: 'upcoming' }).set(auth(faculty.id))).body.actions.map((a: { id: string }) => a.id)).toEqual([future.body.id]);
    expect((await api().get(typedPath('MEETING')).query({ period: 'past' }).set(auth(faculty.id))).body.actions.map((a: { id: string }) => a.id)).toEqual([past.body.id]);
    expect((await api().get(typedPath('MEETING')).query({ studentUserId: studentId }).set(auth(faculty.id))).body.actions).toEqual([]);
    const otherDepartment = randomUUID();
    await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Other local department')", [otherDepartment, institutionId]);
    const other = await staff('FACULTY_LECTURER', institutionId, otherDepartment);
    expect((await api().get(typedPath('MEETING')).set(auth(other.id))).body.actions).toEqual([]);
    expect((await moveC5('MEETING', future.body.id, 1, 'UNDER_REVIEW', faculty.id)).status).toBe(201);
    expect((await moveC5('MEETING', future.body.id, 2, 'APPROVED')).status).toBe(201);
    expect((await moveC5('MEETING', future.body.id, 3, 'IN_PROGRESS', faculty.id)).status).toBe(201);
    expect((await moveC5('MEETING', future.body.id, 4, 'COMPLETED', faculty.id)).status).toBe(201);
    expect((await moveC5('MEETING', past.body.id, 1, 'CANCELLED', faculty.id)).status).toBe(201);
  });

  it.each(c5Types)('blocks post-relationship writes and disclosure for %s', async (type) => {
    const created = await createC5(type);
    await pool.query("UPDATE institution_relationships SET state='REVOKED',effective_to=now() WHERE id=$1", [relationshipId]);
    expect((await api().get(typedPath(type)).set(auth(admin.id))).body.actions).toEqual([]);
    expect((await moveC5(type, created.body.id, 1, 'UNDER_REVIEW')).status).toBe(403);
    expect((await createC5(type)).status).toBe(403);
  });
});

describe('Student-visible staff actions', () => {
  const studentPath = (institution = institutionId) => '/api/v1/students/me/staff-actions?institutionId=' + institution;
  async function signInStudent(id = studentId) {
    tokens.add(id);
    await pool.query('UPDATE users SET external_subject=$1::text WHERE id=$1::uuid', [id]);
    return id;
  }
  async function visible(type = 'ASSIGNED_TASK') {
    const created = type === 'INTERVENTION' ? await draft() : await createC5(type);
    expect(created.status).toBe(201);
    await pool.query("UPDATE staff_actions SET visibility='SUBJECT_VISIBLE' WHERE id=$1", [created.body.id]);
    return created.body.id as string;
  }
  it('returns only the authenticated subject and permitted types/visibility, with a limited response', async () => {
    const student = await signInStudent();
    const taskId = await visible();
    const interventionId = await visible('INTERVENTION');
    await createC5('ASSIGNED_TASK');
    await visible('FACULTY_NOTE');
    const otherStudentId = randomUUID();
    await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [otherStudentId, otherStudentId + '@example.test']);
    await pool.query(`INSERT INTO institution_student_profiles
      (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id)
      VALUES ($1,$2,$3,'LOCAL-OTHER','Other local student','ACTIVE',$4)`, [randomUUID(), institutionId, otherStudentId, departmentId]);
    const otherRelationship = randomUUID();
    await pool.query("INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE',now()-interval '1 day')", [otherRelationship, institutionId, otherStudentId]);
    const other = await createC5('ASSIGNED_TASK', admin.id, { studentUserId: otherStudentId });
    expect(other.status).toBe(201);
    await pool.query("UPDATE staff_actions SET visibility='SUBJECT_VISIBLE' WHERE id=$1", [other.body.id]);
    const result = await api().get(studentPath()).query({ studentUserId: otherStudentId }).set(auth(student));
    expect(result.status).toBe(200);
    expect(result.body.actions.map((row: { id: string }) => row.id).sort()).toEqual([taskId, interventionId].sort());
    for (const row of result.body.actions) {
      expect(Object.keys(row).sort()).toEqual(['id', 'actionType', 'title', 'note', 'state', 'dueAt', 'createdAt', 'updatedAt'].sort());
    }
    expect((await api().get(studentPath())).status).toBe(401);
    expect((await api().get(studentPath()).set(auth(admin.id))).body.actions).toEqual([]);
    expect((await api().get(studentPath(randomUUID())).set(auth(student))).body.actions).toEqual([]);
  });
  it.each(['ENDED', 'REVOKED', 'PENDING'])('hides student actions when the pinned relationship is %s', async (state) => {
    const student = await signInStudent();
    await visible();
    await pool.query('UPDATE institution_relationships SET state=$1,effective_to=now() WHERE id=$2', [state, relationshipId]);
    expect((await api().get(studentPath()).set(auth(student))).body.actions).toEqual([]);
  });
  it.each(['TRANSFERRED', 'GRADUATED'])('applies canonical historical time limits for %s', async (state) => {
    const student = await signInStudent();
    const id = await visible();
    await pool.query("UPDATE staff_actions SET created_at=now()-interval '1 day',updated_at=now()-interval '1 day' WHERE id=$1", [id]);
    await pool.query("UPDATE institution_relationships SET state=$1,effective_to=now()-interval '1 hour' WHERE id=$2", [state, relationshipId]);
    expect((await api().get(studentPath()).set(auth(student))).body.actions).toHaveLength(1);
    await pool.query('UPDATE staff_actions SET updated_at=now() WHERE id=$1', [id]);
    expect((await api().get(studentPath()).set(auth(student))).body.actions).toEqual([]);
  });
  it('honors visibility revocation, future activity boundaries and suspended identities', async () => {
    const student = await signInStudent();
    const id = await visible();
    await pool.query("UPDATE staff_actions SET visibility='STAFF_ONLY' WHERE id=$1", [id]);
    expect((await api().get(studentPath()).set(auth(student))).body.actions).toEqual([]);
    await pool.query("UPDATE staff_actions SET visibility='SUBJECT_VISIBLE',created_at=now()-interval '3 days',updated_at=now()-interval '3 days' WHERE id=$1", [id]);
    expect((await api().get(studentPath()).set(auth(student))).body.actions).toEqual([]);
    await pool.query("UPDATE users SET state='SUSPENDED' WHERE id=$1", [student]);
    expect([401,403]).toContain((await api().get(studentPath()).set(auth(student))).status);
  });
});

describe('C6 institution application visibility', () => {
  const readPath = (institution = institutionId, student = studentId) =>
    '/api/v1/institutions/' + institution + '/students/' + student + '/applications';
  async function application(granted = true, subject = studentId) {
    const employer = randomUUID(); const opportunity = randomUUID(); const version = randomUUID(); const id = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Local test employer')", [employer]);
    await pool.query("INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,'LOCAL-C6')", [opportunity, employer, admin.id]);
    await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,'Local applied role','FULL_TIME','REMOTE',$3,$4)", [version, opportunity, '0'.repeat(64), admin.id]);
    await pool.query("INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,institution_visibility_granted_at) VALUES ($1,$2,$3,$4,$5,'APPLIED',now(),now(),CASE WHEN $6 THEN now() ELSE NULL END)", [id, opportunity, employer, version, subject, granted]);
    return { id, employer };
  }
  async function offer(id: string, employer: string) {
    // Non-null synthetic terms prove SQL/response exclusions, using the shared column vocabulary.
    await pool.query("INSERT INTO offers (id,application_id,employer_id,state,created_by_user_id," + institutionForbiddenDisclosureFields.join(',') + ",extended_at,responded_at,offer_expires_at) VALUES ($1,$2,$3,'ACCEPTED',$4,'INR',123456.78,'YEAR',now(),now(),now()+interval '7 days')", [randomUUID(), id, employer, admin.id]);
  }
  it('returns only the granted student application and allowed fields, without selecting forbidden columns', async () => {
    const shared = await application(); await offer(shared.id, shared.employer);
    await application(false);
    const officer = await staff('PLACEMENT_ADMIN');
    executedQueries.length = 0;
    const result = await api().get(readPath()).set(auth(officer.id)).expect(200);
    expect(result.body.applications).toHaveLength(1);
    expect(result.body.applications[0]).toMatchObject({
      id: shared.id, employer: { id: shared.employer, name: 'Local test employer' },
      opportunityTitle: 'Local applied role', state: 'APPLIED', offer: { exists: true, responseState: 'ACCEPTED' },
    });
    expect(Object.keys(result.body.applications[0]).sort()).toEqual([
      'id', 'employer', 'opportunityTitle', 'state', 'createdAt', 'submittedAt', 'updatedAt', 'closedAt', 'offer',
    ].sort());
    expect(Object.keys(result.body.applications[0].offer).sort()).toEqual(['exists', 'responseState']);
    expect(Object.keys(result.body.applications[0].employer).sort()).toEqual(['id', 'name']);
    const selects = executedQueries.filter((query) => /^\s*select\b/i.test(query));
    expect(selects.some((query) => /FROM applications a/i.test(query))).toBe(true);
    expect(selects.some((query) => /FROM offers/i.test(query))).toBe(true);
    for (const query of selects) {
      const identifiers = query.toLowerCase().match(/[a-z_][a-z_0-9]*/g) ?? [];
      for (const field of institutionForbiddenDisclosureFields) expect(identifiers).not.toContain(field);
      expect(identifiers.some(isInstitutionForbiddenDisclosureField)).toBe(false);
      expect(query).not.toMatch(/select\s+(?:\w+\.)?\*/i);
    }
    const keys = JSON.stringify(result.body).match(/"([^"]+)":/g) ?? [];
    expect(keys.some((key) => isInstitutionForbiddenDisclosureField(key.slice(1, -2).replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())))).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain('123456.78');
  });
  it('does not substitute employer consent for absent institution consent', async () => {
    await application(false);
    expect((await api().get(readPath()).set(auth(admin.id)).expect(200)).body.applications).toEqual([]);
  });
  it('removes a row immediately after institution consent is revoked', async () => {
    const shared = await application();
    expect((await api().get(readPath()).set(auth(admin.id)).expect(200)).body.applications).toHaveLength(1);
    await pool.query('UPDATE applications SET institution_visibility_revoked_at=now(),updated_at=now() WHERE id=$1', [shared.id]);
    expect((await api().get(readPath()).set(auth(admin.id)).expect(200)).body.applications).toEqual([]);
  });
  it.each(['ENDED', 'REVOKED', 'TRANSFERRED', 'GRADUATED', 'PENDING'])('denies current disclosure after the relationship becomes %s', async (state) => {
    await application();
    await pool.query('UPDATE institution_relationships SET state=$1,effective_to=now() WHERE id=$2', [state, relationshipId]);
    expect((await api().get(readPath()).set(auth(admin.id)).expect(200)).body.applications).toEqual([]);
  });
  it('uses application dates as well as the currently active relationship', async () => {
    const shared = await application();
    await pool.query("UPDATE applications SET created_at=now()-interval '3 days',submitted_at=now()-interval '3 days',updated_at=now()-interval '3 days' WHERE id=$1", [shared.id]);
    expect((await api().get(readPath()).set(auth(admin.id)).expect(200)).body.applications).toEqual([]);
    await pool.query('UPDATE applications SET created_at=now(),submitted_at=now(),updated_at=now() WHERE id=$1', [shared.id]);
    expect((await api().get(readPath()).set(auth(admin.id)).expect(200)).body.applications[0].offer).toEqual({ exists: false, responseState: null });
  });
  it('withholds application and offer revisions outside the relationship window', async () => {
    const shared = await application();
    await pool.query("UPDATE institution_relationships SET effective_to=now()+interval '1 hour' WHERE id=$1", [relationshipId]);
    await pool.query("UPDATE applications SET updated_at=now()+interval '2 hours' WHERE id=$1", [shared.id]);
    expect((await api().get(readPath()).set(auth(admin.id)).expect(200)).body.applications).toEqual([]);
    await pool.query('UPDATE applications SET updated_at=now() WHERE id=$1', [shared.id]);
    await offer(shared.id, shared.employer);
    await pool.query("UPDATE offers SET updated_at=now()+interval '2 hours' WHERE application_id=$1", [shared.id]);
    expect((await api().get(readPath()).set(auth(admin.id)).expect(200)).body.applications).toEqual([]);
  });
  it('isolates institutions and requested students', async () => {
    const shared = await application();
    const otherStudent = randomUUID();
    await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [otherStudent, otherStudent + '@example.test']);
    await pool.query("INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id) VALUES ($1,$2,$3,'LOCAL-C6-OTHER','Other local student','ACTIVE',$4)", [randomUUID(), institutionId, otherStudent, departmentId]);
    await pool.query("INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE',now()-interval '1 day')", [randomUUID(), institutionId, otherStudent]);
    const otherApplication = await application(true, otherStudent);
    expect((await api().get(readPath()).query({ studentUserId: otherStudent }).set(auth(admin.id)).expect(200)).body.applications.map((row: { id: string }) => row.id)).toEqual([shared.id]);
    expect((await api().get(readPath(institutionId, otherStudent)).set(auth(admin.id)).expect(200)).body.applications.map((row: { id: string }) => row.id)).toEqual([otherApplication.id]);

    const otherInstitution = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Other local institution')", [otherInstitution]);
    const outsider = await staff('PLACEMENT_ADMIN', otherInstitution);
    await api().get(readPath()).set(auth(outsider.id)).expect(403);
    expect((await api().get(readPath(otherInstitution)).set(auth(outsider.id)).expect(200)).body.applications).toEqual([]);
    expect((await api().get(readPath(institutionId, randomUUID())).set(auth(admin.id)).expect(200)).body.applications).toEqual([]);
  });
  it('retains department and batch scope and denies inactive or unauthenticated staff', async () => {
    await application();
    const department = randomUUID(); const batch = randomUUID();
    await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Other department'),($3,$2,'BATCH','Other batch')", [department, institutionId, batch]);
    const faculty = await staff('FACULTY_LECTURER', institutionId, department);
    expect((await api().get(readPath()).set(auth(faculty.id)).expect(200)).body.applications).toEqual([]);
    await pool.query('UPDATE organization_memberships SET scope_department_unit_id=NULL,scope_batch_unit_id=$1 WHERE id=$2', [batch, faculty.membershipId]);
    expect((await api().get(readPath()).set(auth(faculty.id)).expect(200)).body.applications).toEqual([]);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [admin.membershipId]);
    await api().get(readPath()).set(auth(admin.id)).expect(403);
    await api().get(readPath()).expect(401);
  });
});
