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
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for staff-action tests');
const schemaName = 'staff_actions_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
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
  tokens.clear(); nextIds = [];
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
