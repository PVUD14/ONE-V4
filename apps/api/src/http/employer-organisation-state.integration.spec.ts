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

const refusedStates = [['SUSPENDED', false], ['REJECTED', true]] as const;
const unverifiedStates = [['PENDING', true], ['UNDER_REVIEW', true]] as const;

/**
 * Every employer route, with the §5.1 action group it belongs to. The ids are
 * placeholders: the organisation-state check runs before any resource lookup.
 */
function employerRoutes(employerId: string) {
  const base = '/api/v1/employers/' + employerId;
  const any = randomUUID();
  return [
    { group: 'draft', method: 'post', path: base + '/opportunities', body: { referenceCode: 'R-' + any.slice(0, 8), title: 'Role', summary: 'Build things.', employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false } },
    { group: 'draft', method: 'get', path: base + '/opportunities' },
    { group: 'draft', method: 'post', path: base + '/opportunities/' + any + '/audiences', body: { audienceKind: 'PUBLIC' } },
    { group: 'draft', method: 'get', path: base + '/assessment-questions' },
    { group: 'draft', method: 'get', path: base + '/assessments' },
    { group: 'publish', method: 'post', path: base + '/opportunities/' + any + '/publish' },
    { group: 'publish', method: 'post', path: base + '/assessments/' + any + '/publish' },
    { group: 'candidates', method: 'get', path: base + '/opportunities/' + any + '/applications' },
    { group: 'candidates', method: 'post', path: base + '/applications/' + any + '/transition', body: { toState: 'SHORTLISTED' } },
    { group: 'candidates', method: 'get', path: base + '/candidate-feedback-reasons' },
    { group: 'candidates', method: 'post', path: base + '/applications/' + any + '/feedback', body: {} },
    { group: 'candidates', method: 'get', path: base + '/interviews' },
    { group: 'candidates', method: 'get', path: base + '/interview-participant-options' },
    { group: 'candidates', method: 'post', path: base + '/applications/' + any + '/interviews', body: {} },
    { group: 'candidates', method: 'post', path: base + '/interviews/' + any + '/state', body: { toState: 'CANCELLED' } },
    { group: 'candidates', method: 'post', path: base + '/interviews/' + any + '/outcome', body: {} },
    { group: 'candidates', method: 'get', path: base + '/my-interviews' },
    { group: 'candidates', method: 'get', path: base + '/my-interviews/' + any },
    { group: 'candidates', method: 'post', path: base + '/my-interviews/' + any + '/outcome', body: { recommendation: 'YES' } },
    { group: 'candidates', method: 'get', path: base + '/offers' },
    { group: 'candidates', method: 'post', path: base + '/applications/' + any + '/offers', body: {} },
    { group: 'candidates', method: 'post', path: base + '/offers/' + any + '/withdraw' },
    { group: 'candidates', method: 'get', path: base + '/hiring-analytics' },
    { group: 'candidates', method: 'post', path: base + '/assessments/' + any + '/invitations', body: {} },
    { group: 'candidates', method: 'get', path: base + '/assessments/' + any + '/results' },
  ] as const;
}
type EmployerRoute = ReturnType<typeof employerRoutes>[number];
async function call(route: EmployerRoute, userId: string) {
  const pending = route.method === 'get' ? api().get(route.path) : api().post(route.path).send('body' in route ? route.body : {});
  return pending.set(auth(userId));
}
const ids = (response: { body: { opportunities: { id: string }[] } }) => response.body.opportunities.map((item) => item.id);

describe('EMP-03: organisation state x action group', () => {
  it.each(refusedStates)('refuses every employer route to a %s organisation, and says why', async (verification, active) => {
    const { employerId, recruiterId } = await employerWithRecruiter(verification, active);
    for (const route of employerRoutes(employerId)) {
      const response = await call(route, recruiterId);
      expect({ route: route.path, status: response.status, code: response.body?.error?.code })
        .toEqual({ route: route.path, status: 403, code: 'EMPLOYER_ORGANISATION_INACTIVE' });
    }
  });

  it.each(unverifiedStates)('lets a %s organisation draft but not publish or reach candidates', async (verification, active) => {
    const { employerId, recruiterId } = await employerWithRecruiter(verification, active);
    for (const route of employerRoutes(employerId)) {
      const response = await call(route, recruiterId);
      if (route.group === 'draft') {
        expect({ route: route.path, code: response.body?.error?.code ?? null }).not.toMatchObject({ code: expect.stringMatching(/^EMPLOYER_ORGANISATION_/) });
      } else {
        expect({ route: route.path, status: response.status, code: response.body?.error?.code })
          .toEqual({ route: route.path, status: 403, code: 'EMPLOYER_ORGANISATION_UNVERIFIED' });
      }
    }
    const created = await api().post(opportunitiesPath(employerId)).set(auth(recruiterId))
      .send({ referenceCode: 'DRAFT-' + randomUUID().slice(0, 8), title: 'Draft role', summary: 'Drafted before verification.', employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false })
      .expect(201);
    const draftId = created.body.opportunity.id as string;
    await api().post(opportunitiesPath(employerId) + '/' + draftId + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
    expect(ids(await api().get(opportunitiesPath(employerId)).set(auth(recruiterId)).expect(200))).toContain(draftId);
    await api().post(opportunitiesPath(employerId) + '/' + draftId + '/publish').set(auth(recruiterId)).expect(403);
    expect(await lifecycle(draftId)).toBe('DRAFT');
  });

  it('lets every member read their own organisation status in every state', async () => {
    for (const [verification, active] of [...refusedStates, ...unverifiedStates, ['VERIFIED', true] as const]) {
      const { employerId, recruiterId } = await employerWithRecruiter(verification, active);
      const response = await api().get('/api/v1/employers/' + employerId + '/organisation-status').set(auth(recruiterId)).expect(200);
      const verified = verification === 'VERIFIED';
      expect(response.body.organisation).toEqual({
        verificationState: verification, active,
        canDraft: verified || verification === 'PENDING' || verification === 'UNDER_REVIEW',
        canPublish: verified, canReachCandidates: verified,
      });
    }
    const { employerId } = await employerWithRecruiter();
    await api().get('/api/v1/employers/' + employerId + '/organisation-status').set(auth(await user())).expect(403);
    await api().get('/api/v1/employers/' + employerId + '/organisation-status').expect(401);
  });
});

describe('EMP-03: suspension pauses published jobs (decision 10.2 #3)', () => {
  it('pauses on suspension, hides the job and its applicants, and keeps it paused on reinstatement', async () => {
    const { employerId, recruiterId } = await employerWithRecruiter();
    const opportunityId = await draftWithAudience(employerId, recruiterId);
    const untouchedDraftId = await draftWithAudience(employerId, recruiterId);
    await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);
    const applied = await api().post('/api/v1/students/me/applications').set(auth(studentUserId)).send({ opportunityId, consentGranted: true }).expect(201);
    const applicants = await api().get(opportunitiesPath(employerId) + '/' + opportunityId + '/applications').set(auth(recruiterId)).expect(200);
    expect(applicants.body.applications).toHaveLength(1);

    await suspendThroughOperations(employerId);
    expect(await lifecycle(opportunityId)).toBe('PAUSED');
    expect(await lifecycle(untouchedDraftId)).toBe('DRAFT');
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='opportunity.paused' AND resource_id=$1", [opportunityId]);
    expect(audit.rows).toEqual([{ context: { reasonCode: 'REPRO_D3', cause: 'ORGANIZATION_SUSPENDED' } }]);
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='opportunity.paused' AND aggregate_id=$1", [opportunityId]);
    expect(outbox.rows).toEqual([{ payload: { opportunityId, employerId, cause: 'ORGANIZATION_SUSPENDED' } }]);

    await api().get(opportunitiesPath(employerId) + '/' + opportunityId + '/applications').set(auth(recruiterId)).expect(403);
    await api().post('/api/v1/employers/' + employerId + '/applications/' + applied.body.application.id + '/transition')
      .set(auth(recruiterId)).send({ toState: 'SHORTLISTED' }).expect(403);
    expect(ids(await api().get('/api/v1/opportunities').set(auth(studentUserId)).expect(200))).not.toContain(opportunityId);
    await api().post('/api/v1/students/me/applications').set(auth(await user())).send({ opportunityId, consentGranted: true }).expect(403);

    await api().post('/api/v1/operations/organizations/' + employerId + '/verification')
      .set(auth(opsUserId)).send({ toState: 'VERIFIED', reasonCode: 'REINSTATED' }).expect(201);
    expect((await pool.query('SELECT verification_state, active FROM organizations WHERE id=$1', [employerId])).rows[0])
      .toEqual({ verification_state: 'VERIFIED', active: true });
    expect(await lifecycle(opportunityId)).toBe('PAUSED');
    expect(ids(await api().get('/api/v1/opportunities').set(auth(studentUserId)).expect(200))).not.toContain(opportunityId);

    await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);
    expect(ids(await api().get('/api/v1/opportunities').set(auth(studentUserId)).expect(200))).toContain(opportunityId);
  });

  it('hides and refuses a published job whose employer is rejected, unverified or inactive, even without a pause', async () => {
    for (const [verification, active] of [['REJECTED', true], ['PENDING', true], ['VERIFIED', false]] as const) {
      const { employerId, recruiterId } = await employerWithRecruiter();
      const opportunityId = await draftWithAudience(employerId, recruiterId);
      await api().post(opportunitiesPath(employerId) + '/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);
      // Set directly: operations cannot reach these combinations from VERIFIED, but the data can hold them.
      await pool.query('UPDATE organizations SET verification_state=$2::verification_state, active=$3 WHERE id=$1', [employerId, verification, active]);
      expect(ids(await api().get('/api/v1/opportunities').set(auth(studentUserId)).expect(200))).not.toContain(opportunityId);
      await api().get('/api/v1/opportunities/' + opportunityId).set(auth(studentUserId)).expect(403);
      await api().post('/api/v1/students/me/applications').set(auth(await user())).send({ opportunityId, consentGranted: true }).expect(403);
    }
  });
});
