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
import { EmployerHiringController } from './employer-hiring.controller.js';
import { StudentHiringController } from './student-hiring.controller.js';
import type { ProtectedHttpRequest } from './api-security.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for hiring controller integration tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) throw new Error('Hiring controller integration tests require local Postgres');
const schemaName = `hiring_workflow_${process.pid}`;
const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
let admin: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let employer: EmployerHiringController;
let student: StudentHiringController;
let userId: string;
let outsiderId: string;

beforeAll(async () => {
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) await migrate(name);
  db = drizzle(pool, { schema });
  employer = new EmployerHiringController(db, { uuid: randomUUID });
  student = new StudentHiringController(db, { uuid: randomUUID });
  userId = await seedUser(); outsiderId = await seedUser();
}, 60_000);
afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await admin?.end();
});

async function migrate(name: string): Promise<void> {
  const sql = (await readFile(new URL(name, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
  await pool.query(sql);
}
async function seedUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject: `test:${id}`, email: `${id}@example.test`, state: 'ACTIVE' });
  return id;
}
function trusted(actorId: string, employerId?: string): ProtectedHttpRequest {
  return { headers: {}, planThePath: { correlationId: `test-${randomUUID()}`, verifiedIdentity: {}, authorization: {
    principal: { userId: actorId }, memberships: employerId ? [{ organizationId: employerId, role: 'RECRUITER', state: 'ACTIVE', scope: { organizationId: employerId, employerId } }] : [],
  } } } as unknown as ProtectedHttpRequest;
}
async function createRole(text = 'Build reliable software.', title = `Role ${randomUUID()}`) {
  const employerId = randomUUID();
  await db.insert(schema.organizations).values({ id: employerId, kind: 'EMPLOYER', legalName: 'Test Employer', verificationState: 'VERIFIED' });
  const request = trusted(userId, employerId);
  const created = await employer.createOpportunity(request, employerId, { referenceCode: randomUUID(), title, summary: text, employmentType: 'FULL_TIME', workMode: 'REMOTE', compensationDisclosed: false });
  const opportunityId = (created.opportunity as { id: string }).id;
  await employer.addAudience(request, employerId, opportunityId, { audienceKind: 'PUBLIC' });
  await employer.publishOpportunity(request, employerId, opportunityId);
  return { employerId, request, opportunityId };
}
async function apply(opportunityId: string, grant = false, actorId = userId): Promise<string> {
  const result = await student.apply(trusted(actorId), { opportunityId, consentGranted: true, institutionVisibilityGranted: grant });
  return (result.application as { id: string }).id;
}

describe('hiring workflow persistence', () => {
  it('replays both migrations without changing existing consent or duplicating signals', async () => {
    const role = await createRole();
    const id = await apply(role.opportunityId, true);
    const before = (await pool.query('SELECT institution_visibility_granted_at FROM applications WHERE id = $1', [id])).rows[0];
    await migrate('0017_application_institution_visibility.sql');
    await migrate('0017_application_institution_visibility.sql');
    await migrate('0018_opportunity_review_signals.sql');
    await migrate('0018_opportunity_review_signals.sql');
    expect((await pool.query('SELECT institution_visibility_granted_at FROM applications WHERE id = $1', [id])).rows[0]).toEqual(before);
    expect((await pool.query('SELECT count(*)::int AS count FROM opportunity_review_signals WHERE opportunity_id = $1', [role.opportunityId])).rows[0].count).toBe(1);
  });
  it('allows optional consent, rejects impossible timestamp order, and revokes independently even after closure', async () => {
    const role = await createRole();
    const unshared = await apply(role.opportunityId);
    const shared = await apply(role.opportunityId, true, outsiderId);
    expect((await pool.query('SELECT institution_visibility_granted_at FROM applications WHERE id = $1', [unshared])).rows[0].institution_visibility_granted_at).toBeNull();
    await expect(pool.query('UPDATE applications SET institution_visibility_revoked_at = now() WHERE id = $1', [unshared])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE applications SET institution_visibility_revoked_at = institution_visibility_granted_at - interval '1 second' WHERE id = $1", [shared])).rejects.toMatchObject({ code: '23514' });
    await employer.transitionApplication(role.request, role.employerId, shared, { toState: 'REJECTED' });
    await student.revokeInstitutionVisibility(trusted(outsiderId), shared);
    const before = (await pool.query('SELECT state, consent_revoked_at, institution_visibility_revoked_at FROM applications WHERE id = $1', [shared])).rows[0];
    expect(before.state).toBe('REJECTED'); expect(before.consent_revoked_at).toBeNull(); expect(before.institution_visibility_revoked_at).not.toBeNull();
    await student.revokeInstitutionVisibility(trusted(outsiderId), shared);
    expect((await pool.query('SELECT state, consent_revoked_at, institution_visibility_revoked_at FROM applications WHERE id = $1', [shared])).rows[0]).toEqual(before);
    await expect(student.revokeInstitutionVisibility(trusted(userId), shared)).rejects.toThrow();
    const listed = await student.listApplications(trusted(outsiderId));
    expect((listed.applications as { id: string; institutionVisibilityRevokedAt: unknown }[]).find((item) => item.id === shared)?.institutionVisibilityRevokedAt).not.toBeNull();
  });
  it('rolls back a consent grant when its audit fails', async () => {
    const role = await createRole();
    // Force an audit failure only for this call using a duplicate audit ID.
    const auditId = randomUUID();
    await pool.query("INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id) VALUES ($1, $2, 'test', 'application', $3, 'SUCCESS', 'test-audit')", [auditId, userId, randomUUID()]);
    let calls = 0;
    const failing = new StudentHiringController(db, { uuid: () => ++calls === 4 ? auditId : randomUUID() });
    await expect(failing.apply(trusted(userId), { opportunityId: role.opportunityId, consentGranted: true, institutionVisibilityGranted: true })).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS count FROM applications WHERE opportunity_id = $1', [role.opportunityId])).rows[0].count).toBe(0);
  });
  it('records payment and cross-employer duplicate signals before publishing, with no penalty', async () => {
    const title = `Duplicate ${randomUUID()}`;
    await createRole('Candidates must pay a registration fee.', title);
    const role = await createRole('Candidates must pay a registration fee.', title);
    const signals = await pool.query('SELECT signal_code, review_state FROM opportunity_review_signals WHERE opportunity_id = $1', [role.opportunityId]);
    expect(signals.rows.map((row) => row.signal_code).sort()).toEqual(['APPLICANT_PAYMENT_DEMAND', 'CROSS_EMPLOYER_DUPLICATE', 'MISSING_COMPENSATION']);
    expect(signals.rows.every((row) => row.review_state === 'PENDING')).toBe(true);
    expect((await pool.query('SELECT lifecycle_state FROM opportunities WHERE id = $1', [role.opportunityId])).rows[0].lifecycle_state).toBe('PUBLISHED');
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE resource_id = $1 AND action = 'opportunity.review_requested'", [role.opportunityId])).rows[0].count).toBe(2);
  });
  it('computes real employer aggregates, avoids skipped-stage inflation and excludes rival applications', async () => {
    const role = await createRole();
    const rival = await createRole();
    const id = await apply(role.opportunityId);
    await apply(rival.opportunityId);
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'INTERVIEW' });
    await employer.transitionApplication(role.request, role.employerId, id, { toState: 'OFFER' });
    await employer.extendOffer(role.request, role.employerId, id, { compensationCurrency: 'INR', compensationAmount: 30000, compensationPeriod: 'MONTH', offerExpiresAt: '2099-10-01T00:00Z' });
    await pool.query("UPDATE applications SET submitted_at = now() - interval '5 days' WHERE id = $1", [id]);
    const result = await employer.hiringAnalytics(role.request, role.employerId);
    const report = result.analytics as { applicationCount: number; meanTimeToOfferDays: number; stages: { stage: string; reached: number }[] };
    expect(report.applicationCount).toBe(1);
    expect(report.meanTimeToOfferDays).toBeCloseTo(5, 2);
    expect(report.stages.find((stage) => stage.stage === 'SCREENING')?.reached).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/student_user_id|candidate|compensation|@example.test/);
    await expect(employer.hiringAnalytics(role.request, rival.employerId)).rejects.toThrow();
  });
});
