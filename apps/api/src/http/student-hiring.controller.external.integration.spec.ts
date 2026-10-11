/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@planthepath/persistence/src/schema.js';
import { StudentHiringController } from './student-hiring.controller.js';
import { EmployerHiringController } from './employer-hiring.controller.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) throw new Error('External application tests require local Postgres');
const schemaName = `external_hiring_${process.pid}`;
const migrations = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
let admin: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let controller: StudentHiringController;

beforeAll(async () => {
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) await migrate(name);
  db = drizzle(pool, { schema }); controller = new StudentHiringController(db, { uuid: randomUUID });
}, 60_000);
afterAll(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`); await admin?.end(); });
async function migrate(name = '0019_external_applications.sql') {
  await pool.query((await readFile(new URL(name, migrations), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
}
async function student() {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject: `test:${id}`, email: `${id}@example.test`, state: 'ACTIVE' });
  const request = { headers: {}, planThePath: { correlationId: randomUUID(), verifiedIdentity: {}, authorization: {
    principal: { userId: id }, memberships: [],
  } } } as unknown as ProtectedHttpRequest;
  return { id, request };
}
async function insertDeclaration(studentId: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO external_applications (id, student_user_id, company_name, role_title, source_kind, applied_on) VALUES ($1, $2, 'Test Company', 'Test Role', 'REFERRAL', '2026-01-01')", [id, studentId]);
  return id;
}

describe('external application migration', () => {
  it('replays without resetting existing declarations, stage, consent or revision', async () => {
    const owner = await student(); const id = await insertDeclaration(owner.id);
    await pool.query("UPDATE external_applications SET stage = 'HIRED', revision = 3, institution_visibility_granted_at = now() WHERE id = $1", [id]);
    const before = (await pool.query('SELECT * FROM external_applications WHERE id = $1', [id])).rows;
    await migrate(); await migrate();
    expect((await pool.query('SELECT * FROM external_applications WHERE id = $1', [id])).rows).toEqual(before);
    expect(before[0]).toMatchObject({ source: 'STUDENT_DECLARED', verification_state: 'UNVERIFIED', stage: 'HIRED' });
  });
  it('enforces provenance, stage, revision, consent order, required labels and owner foreign key', async () => {
    const owner = await student(); const id = await insertDeclaration(owner.id);
    for (const fragment of ["source = 'NATIVE'", "verification_state = 'VERIFIED'", "stage = 'PLACED'", 'revision = 0', "company_name = ''", "role_title = '=formula'", 'institution_visibility_revoked_at = now()']) {
      await expect(pool.query(`UPDATE external_applications SET ${fragment} WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(pool.query('UPDATE external_applications SET student_user_id = $1 WHERE id = $2', [randomUUID(), id])).rejects.toMatchObject({ code: '23503' });
    await pool.query('UPDATE external_applications SET institution_visibility_granted_at = now() WHERE id = $1', [id]);
    await expect(pool.query("UPDATE external_applications SET institution_visibility_revoked_at = institution_visibility_granted_at - interval '1 second' WHERE id = $1", [id])).rejects.toMatchObject({ code: '23514' });
    const credentialed = new URL('https://example.test/application'); credentialed.username = randomUUID();
    for (const url of ['http://example.test', 'https://', 'https://example.test/a b', credentialed.href]) {
      await expect(pool.query('UPDATE external_applications SET application_url = $1 WHERE id = $2', [url, id])).rejects.toMatchObject({ code: '23514' });
    }
    await pool.query('UPDATE external_applications SET application_url = $1 WHERE id = $2', ['https://example.test?ref=contact@example.test', id]);
  });
});

const input = { companyName: 'Test Company', roleTitle: 'Test Role', sourceKind: 'JOB_BOARD', appliedOn: '2026-01-01' };
type Declaration = { id: string; revision: number; stage: string; institutionVisibilityGrantedAt: unknown; institutionVisibilityRevokedAt: unknown };
async function create(request: ProtectedHttpRequest, overrides: Record<string, unknown> = {}) {
  return (await controller.createExternalApplication(request, { ...input, ...overrides })).externalApplication as Declaration;
}

describe('student-owned external application routes', () => {
  it.each(['listExternalApplications', 'getExternalApplication', 'createExternalApplication', 'updateExternalApplication', 'deleteExternalApplication', 'grantExternalVisibility', 'revokeExternalVisibility'] as const)('retains authentication on %s', (method) => {
    expect(Reflect.getMetadata('__guards__', StudentHiringController.prototype[method])).toContain(ProtectedApiAuthenticationGuard);
  });

  it('creates, paginates and edits declarations with fixed provenance and no native application', async () => {
    const owner = await student();
    const first = await create(owner.request, { companyName: '  Test Company  ', stage: 'HIRED' });
    const second = await create(owner.request, { appliedOn: '2025-12-31' });
    expect(first).toMatchObject({ companyName: 'Test Company', appliedOn: '2026-01-01', stage: 'HIRED', source: 'STUDENT_DECLARED', verificationState: 'UNVERIFIED', institutionVisibilityGrantedAt: null, revision: 1 });
    expect(await controller.listExternalApplications(owner.request, '0', '1')).toMatchObject({ externalApplications: [{ id: first.id }], total: 2 });
    expect(await controller.listExternalApplications(owner.request, '1', '1')).toMatchObject({ externalApplications: [{ id: second.id }], total: 2 });
    expect(await controller.listExternalApplications(owner.request, '2', '1')).toMatchObject({ externalApplications: [], total: 2 });
    expect(await controller.updateExternalApplication(owner.request, first.id, { revision: 1, stage: 'APPLIED', applicationUrl: 'https://example.test/job' })).toMatchObject({ externalApplication: { revision: 2, stage: 'APPLIED', source: 'STUDENT_DECLARED', verificationState: 'UNVERIFIED' } });
    expect(await controller.updateExternalApplication(owner.request, first.id, { revision: 2, applicationUrl: null })).toMatchObject({ externalApplication: { revision: 3, applicationUrl: null } });
    expect(await controller.listApplications(owner.request)).toMatchObject({ applications: [] });
    expect(JSON.stringify(await controller.getExternalApplication(owner.request, first.id))).not.toContain(owner.id);
  });

  it('denies other students and employer members across every read and mutation', async () => {
    const owner = await student(); const other = await student(); const row = await create(owner.request);
    expect(await controller.listExternalApplications(other.request)).toMatchObject({ externalApplications: [], total: 0 });
    for (const id of [row.id, randomUUID()]) {
      await expect(controller.getExternalApplication(other.request, id)).rejects.toMatchObject({ status: 403 });
      await expect(controller.updateExternalApplication(other.request, id, { revision: 1, stage: 'HIRED' })).rejects.toMatchObject({ status: 403 });
      await expect(controller.deleteExternalApplication(other.request, id, { revision: 1 })).rejects.toMatchObject({ status: 403 });
      await expect(controller.grantExternalVisibility(other.request, id, { revision: 1 })).rejects.toMatchObject({ status: 403 });
      await expect(controller.revokeExternalVisibility(other.request, id, { revision: 1 })).rejects.toMatchObject({ status: 403 });
    }
    const employerId = randomUUID();
    await db.insert(schema.organizations).values({ id: employerId, kind: 'EMPLOYER', legalName: 'Test Employer', verificationState: 'VERIFIED' });
    await pool.query("INSERT INTO organization_memberships (id, organization_id, user_id, role, scope_organization_id, scope_employer_id) VALUES ($1, $2, $3, 'RECRUITER', $2, $2)", [randomUUID(), employerId, other.id]);
    const employerRequest = { ...other.request, planThePath: { ...other.request.planThePath, authorization: { principal: { userId: other.id }, memberships: [{ organizationId: employerId, role: 'RECRUITER', state: 'ACTIVE', scope: { organizationId: employerId, employerId } }] } } } as unknown as ProtectedHttpRequest;
    await expect(controller.getExternalApplication(employerRequest, row.id)).rejects.toMatchObject({ status: 403 });
    const employer = new EmployerHiringController(db, { uuid: randomUUID });
    const before = (await employer.hiringAnalytics(employerRequest, employerId)).analytics;
    await controller.grantExternalVisibility(owner.request, row.id, { revision: 1 });
    await controller.updateExternalApplication(owner.request, row.id, { revision: 2, stage: 'HIRED' });
    expect((await employer.hiringAnalytics(employerRequest, employerId)).analytics).toEqual(before);
    expect(await employer.listOffers(employerRequest, employerId)).toMatchObject({ offers: [] });
    expect(await employer.listInterviews(employerRequest, employerId)).toMatchObject({ interviews: [] });
  });

  it('rejects forged ownership, provenance, consent timestamps, invalid dates/URLs and paging', async () => {
    const owner = await student(); const row = await create(owner.request);
    for (const extra of [{ studentUserId: randomUUID() }, { source: 'NATIVE' }, { verificationState: 'VERIFIED' }, { institutionVisibilityGrantedAt: new Date().toISOString() }, { appliedOn: '2026-02-30' }, { appliedOn: '2099-01-01' }, { companyName: ' =formula' }, { applicationUrl: 'javascript:alert(1)' }, { institutionVisibilityGranted: 'true' }]) {
      await expect(create(owner.request, extra)).rejects.toMatchObject({ status: 400 });
    }
    await expect(controller.updateExternalApplication(owner.request, row.id, { revision: 1, source: 'NATIVE' })).rejects.toMatchObject({ status: 400 });
    await expect(controller.updateExternalApplication(owner.request, row.id, { revision: 1, institutionVisibilityGranted: true })).rejects.toMatchObject({ status: 400 });
    for (const [offset, limit] of [['-1', '1'], ['0', '101'], ['garbage', '1']]) await expect(controller.listExternalApplications(owner.request, offset, limit)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects concurrent stale edits and stale deletes without changing the winning version', async () => {
    const owner = await student(); const row = await create(owner.request);
    const results = await Promise.allSettled(['HIRED', 'REJECTED'].map((stage) => controller.updateExternalApplication(owner.request, row.id, { revision: 1, stage })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    await expect(controller.deleteExternalApplication(owner.request, row.id, { revision: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await controller.getExternalApplication(owner.request, row.id)).toMatchObject({ externalApplication: { revision: 2 } });
  });

  it.each(['APPLIED', 'SCREENING', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'])('keeps consent separate and revocable at %s, including stale revoke retries', async (stage) => {
    const owner = await student(); const row = await create(owner.request, { stage, institutionVisibilityGranted: true });
    const revoked = await controller.revokeExternalVisibility(owner.request, row.id, { revision: 1 });
    expect(revoked).toMatchObject({ externalApplication: { stage, revision: 2, institutionVisibilityRevokedAt: expect.anything() } });
    expect(await controller.revokeExternalVisibility(owner.request, row.id, { revision: 1 })).toEqual(revoked);
    const granted = await controller.grantExternalVisibility(owner.request, row.id, { revision: 2 });
    expect(granted).toMatchObject({ externalApplication: { revision: 3, institutionVisibilityRevokedAt: null } });
    await expect(controller.revokeExternalVisibility(owner.request, row.id, { revision: 1 })).rejects.toMatchObject({ status: 409 });
    await controller.updateExternalApplication(owner.request, row.id, { revision: 3, roleTitle: 'Corrected Role' });
    expect(await controller.getExternalApplication(owner.request, row.id)).toMatchObject({ externalApplication: { institutionVisibilityGrantedAt: (granted.externalApplication as Declaration).institutionVisibilityGrantedAt, institutionVisibilityRevokedAt: null } });
  });

  it('enforces the 500-row cap under concurrent creates, counts terminal records, and frees slots only on permanent deletion', async () => {
    const owner = await student();
    await pool.query("INSERT INTO external_applications (id, student_user_id, company_name, role_title, source_kind, applied_on, stage) SELECT gen_random_uuid(), $1, 'Test Company', 'Test Role', 'REFERRAL', '2026-01-01', 'HIRED' FROM generate_series(1,499)", [owner.id]);
    const results = await Promise.allSettled([create(owner.request), create(owner.request)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 400 } });
    expect(await controller.listExternalApplications(owner.request)).toMatchObject({ total: 500 });
    const row = (results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<Declaration>).value;
    await controller.updateExternalApplication(owner.request, row.id, { revision: 1, stage: 'WITHDRAWN' });
    await controller.grantExternalVisibility(owner.request, row.id, { revision: 2 });
    await controller.revokeExternalVisibility(owner.request, row.id, { revision: 3 });
    await expect(create(owner.request)).rejects.toMatchObject({ status: 400 });
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE actor_user_id = $1 AND action = 'external_application.created'", [owner.id])).rows[0].count).toBe(1);
    await controller.deleteExternalApplication(owner.request, row.id, { revision: 4 });
    await expect(controller.getExternalApplication(owner.request, row.id)).rejects.toMatchObject({ status: 403 });
    expect((await pool.query('SELECT * FROM external_applications WHERE id = $1', [row.id])).rows).toHaveLength(0);
    await create(owner.request);
    expect(await controller.listExternalApplications(owner.request)).toMatchObject({ total: 500 });
  });

  it('removes a previously consented declaration permanently and retains only minimal nonreportable audit metadata', async () => {
    const owner = await student(); const row = await create(owner.request, { institutionVisibilityGranted: true, applicationUrl: 'https://example.test/private-link', stage: 'HIRED' });
    expect((await pool.query('SELECT id FROM external_applications WHERE student_user_id = $1 AND institution_visibility_granted_at IS NOT NULL AND institution_visibility_revoked_at IS NULL', [owner.id])).rows).toHaveLength(1);
    await controller.deleteExternalApplication(owner.request, row.id, { revision: 1 });
    expect((await pool.query('SELECT count(*)::int AS count FROM external_applications WHERE student_user_id = $1', [owner.id])).rows[0].count).toBe(0);
    expect(await controller.listExternalApplications(owner.request)).toMatchObject({ externalApplications: [], total: 0 });
    const audits = (await pool.query('SELECT action, context FROM audit_events WHERE resource_id = $1', [row.id])).rows;
    expect(audits).toContainEqual({ action: 'external_application.deleted', context: { revision: 1, changedFields: [] } });
    expect(JSON.stringify(audits)).not.toMatch(/Test Company|Test Role|private-link|HIRED/);
  });

  it('rolls back creation, updates, consent and deletion if an audit fails', async () => {
    const owner = await student(); const row = await create(owner.request);
    const auditId = (await pool.query('SELECT id FROM audit_events WHERE resource_id = $1', [row.id])).rows[0].id as string;
    let calls = 0;
    const failingCreate = new StudentHiringController(db, { uuid: () => ++calls === 2 ? auditId : randomUUID() });
    await expect(failingCreate.createExternalApplication(owner.request, input)).rejects.toThrow();
    const failing = new StudentHiringController(db, { uuid: () => auditId });
    await expect(failing.updateExternalApplication(owner.request, row.id, { revision: 1, stage: 'HIRED' })).rejects.toThrow();
    await expect(failing.grantExternalVisibility(owner.request, row.id, { revision: 1 })).rejects.toThrow();
    await expect(failing.deleteExternalApplication(owner.request, row.id, { revision: 1 })).rejects.toThrow();
    expect(await controller.listExternalApplications(owner.request)).toMatchObject({ total: 1, externalApplications: [{ id: row.id, revision: 1, stage: 'APPLIED', institutionVisibilityGrantedAt: null }] });
    await controller.grantExternalVisibility(owner.request, row.id, { revision: 1 });
    await expect(failing.revokeExternalVisibility(owner.request, row.id, { revision: 2 })).rejects.toThrow();
    expect(await controller.getExternalApplication(owner.request, row.id)).toMatchObject({ externalApplication: { revision: 2, institutionVisibilityRevokedAt: null } });
  });
});
