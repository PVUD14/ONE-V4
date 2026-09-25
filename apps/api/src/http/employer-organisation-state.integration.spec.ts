/**
 * Employer organisation state is enforced on every employer action (EMP-03, defect D-3).
 *
 * Operations can suspend or reject an employer, and an employer can sit unverified, but
 * before EMP-03 every employer route authorised on membership state alone: a recruiter
 * of a SUSPENDED, REJECTED or PENDING organisation could still publish, create jobs and
 * read applicants, and students still saw a suspended employer's jobs.
 *
 * Runs over real HTTP with a stub verifier and the real identity store
 * (loadActiveMembershipsForUser), so the membership list is exactly what production would
 * build, and the suspension goes through the real operations route. Needs a local
 * Postgres in DATABASE_URL; runs in a throwaway schema.
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
if (!connectionString) throw new Error('DATABASE_URL is required for employer organisation-state tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Employer organisation-state tests require local Postgres');
const schemaName = 'employer_org_state_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let opsUserId: string;
let studentUserId: string;

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

  const platformId = await organization('PLATFORM', 'VERIFIED');
  opsUserId = await user();
  await membership(opsUserId, platformId, 'OPERATIONS_ADMIN');
  studentUserId = await user();
}, 60_000);
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function organization(kind: 'PLATFORM' | 'EMPLOYER', verification: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED', active = true): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,$2,$3,$4,$5)',
    [id, kind, 'Repro ' + kind.toLowerCase(), verification, active]);
  return id;
}
async function membership(userId: string, orgId: string, role: string, state = 'ACTIVE'): Promise<void> {
  const employerScope = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(role) ? orgId : null;
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,$5,$2,$6)`, [randomUUID(), orgId, userId, role, state, employerScope]);
}
const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const opportunitiesPath = (employerId: string) => '/api/v1/employers/' + employerId + '/opportunities';

async function employerWithRecruiter(verification: Parameters<typeof organization>[1] = 'VERIFIED', active = true) {
  const employerId = await organization('EMPLOYER', verification, active);
  const recruiterId = await user();
  await membership(recruiterId, employerId, 'RECRUITER');
  return { employerId, recruiterId };
}
/** Seeds the draft directly so the state under test is the only variable. */
async function draftWithAudience(employerId: string, createdBy: string): Promise<string> {
  const opportunityId = randomUUID(); const versionId = randomUUID();
  await pool.query(`INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code,lifecycle_state)
    VALUES ($1,$2,$3,$4,'DRAFT')`, [opportunityId, employerId, createdBy, 'REPRO-' + opportunityId.slice(0, 8)]);
  await pool.query(`INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,summary,employment_type,work_mode,compensation_disclosed,material_terms_hash,created_by_user_id)
    VALUES ($1,$2,1,'Repro role','Build reliable software.','FULL_TIME','REMOTE',false,repeat('0',64),$3)`, [versionId, opportunityId, createdBy]);
  await pool.query('UPDATE opportunities SET current_version_id=$1 WHERE id=$2', [versionId, opportunityId]);
  await pool.query("INSERT INTO opportunity_audiences (id,opportunity_id,audience_kind) VALUES ($1,$2,'PUBLIC')", [randomUUID(), opportunityId]);
  return opportunityId;
}
async function lifecycle(opportunityId: string): Promise<string> {
  return (await pool.query('SELECT lifecycle_state FROM opportunities WHERE id=$1', [opportunityId])).rows[0].lifecycle_state as string;
}
async function suspendThroughOperations(employerId: string): Promise<void> {
  await api().post('/api/v1/operations/organizations/' + employerId + '/verification')
    .set(auth(opsUserId)).send({ toState: 'SUSPENDED', reasonCode: 'REPRO_D3' }).expect(201);
  expect((await pool.query('SELECT verification_state, active FROM organizations WHERE id=$1', [employerId])).rows[0])
    .toEqual({ verification_state: 'SUSPENDED', active: false });
}

describe('D-3: a suspended organisation cannot act as an employer', () => {
  it('refuses to publish for a recruiter whose organisation operations suspended', async () => {
    const { employerId, recruiterId } = await employerWithRecruiter();
    const opportunityId = await draftWithAudience(employerId, recruiterId);
    await suspendThroughOperations(employerId);

    await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(403);
    expect(await lifecycle(opportunityId)).toBe('DRAFT');
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE action='opportunity.published' AND resource_id=$1", [opportunityId])).rows[0].count).toBe(0);
  });

  it('refuses new jobs and applicant reads for a suspended organisation', async () => {
    const { employerId, recruiterId } = await employerWithRecruiter();
    const opportunityId = await draftWithAudience(employerId, recruiterId);
    await suspendThroughOperations(employerId);

    await api().post(opportunitiesPath(employerId)).set(auth(recruiterId))
      .send({ referenceCode: randomUUID(), title: 'After suspension', summary: 'Should not exist.', employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false })
      .expect(403);
    await api().get(opportunitiesPath(employerId) + '/' + opportunityId + '/applications').set(auth(recruiterId)).expect(403);
  });

  it('stops showing a suspended employer\'s published job to students', async () => {
    const { employerId, recruiterId } = await employerWithRecruiter();
    const opportunityId = await draftWithAudience(employerId, recruiterId);
    await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);
    await suspendThroughOperations(employerId);

    const listed = await api().get('/api/v1/opportunities').set(auth(studentUserId)).expect(200);
    expect(listed.body.opportunities.map((item: { id: string }) => item.id)).not.toContain(opportunityId);
    await api().get('/api/v1/opportunities/' + opportunityId).set(auth(studentUserId)).expect(403);
  });

  it.each([['PENDING', true], ['REJECTED', true]] as const)('refuses to publish for a %s organisation', async (verification, active) => {
    const { employerId, recruiterId } = await employerWithRecruiter(verification, active);
    const opportunityId = await draftWithAudience(employerId, recruiterId);
    await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(403);
    expect(await lifecycle(opportunityId)).toBe('DRAFT');
  });

  // Controls: these pass today and must keep passing after EMP-03.
  it('still publishes for a VERIFIED, active organisation', async () => {
    const { employerId, recruiterId } = await employerWithRecruiter();
    const opportunityId = await draftWithAudience(employerId, recruiterId);
    await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);
    expect(await lifecycle(opportunityId)).toBe('PUBLISHED');
  });

  it('already refuses a recruiter whose own membership is suspended', async () => {
    const { employerId, recruiterId } = await employerWithRecruiter();
    const opportunityId = await draftWithAudience(employerId, recruiterId);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE user_id=$1", [recruiterId]);
    await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(403);
    await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').expect(401);
    expect(await lifecycle(opportunityId)).toBe('DRAFT');
  });
});
