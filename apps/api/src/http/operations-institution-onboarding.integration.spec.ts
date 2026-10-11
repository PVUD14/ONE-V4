/**
 * ONE · Stream C — Institution
 * Owner: Navya · Created: 2026-09-08
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

describe('Placement Officer institution reads', () => {
  it('allows Placement Officers to read only their institution units and roster', async () => {
    const officer = await staff('PLACEMENT_ADMIN');
    const unitPath = '/api/v1/institutions/' + institutionId + '/units';
    const result = await api().get(unitPath).set(auth(officer.id)).expect(200);
    expect(result.body.units.map((unit: { id: string }) => unit.id)).toEqual([departmentId]);
    await api().get('/api/v1/institutions/' + institutionId + '/students').set(auth(officer.id)).expect(200);
    const otherOrg = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Other local institution')", [otherOrg]);
    const outsider = await staff('PLACEMENT_ADMIN', otherOrg);
    await api().get(unitPath).set(auth(outsider.id)).expect(403);
    await api().get('/api/v1/institutions/' + otherOrg + '/units').set(auth(officer.id)).expect(403);
    await api().get(unitPath).expect(401);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [officer.membershipId]);
    await api().get(unitPath).set(auth(officer.id)).expect(403);
  });
  it('keeps unit writes admin-only', async () => {
    const officer = await staff('PLACEMENT_ADMIN');
    const unitPath = '/api/v1/institutions/' + institutionId + '/units';
    await api().post(unitPath).set(auth(officer.id)).send({ kind: 'DEPARTMENT', name: 'Not permitted' }).expect(403);
    await api().patch(unitPath + '/' + departmentId).set(auth(officer.id)).send({ name: 'Not permitted' }).expect(403);
    expect((await pool.query('SELECT name FROM institution_units WHERE id=$1', [departmentId])).rows[0].name).toBe('Local department');
  });
});
