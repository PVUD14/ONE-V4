/**
 * Year-end batch actions and alumni (INST-10).
 *
 * A college graduates, transfers or ends a batch or a list of roll numbers: preview first, then
 * commit exactly what was previewed, all or nothing, with a reason code and one audit row per
 * student. Afterwards the college sees only what happened before the effective date, and the
 * student keeps ONE — their workspace, profile, documents, verified records and every consent —
 * and can still ask the college to verify a past result. The student is told, once.
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
import { createLocalIntegrationEventPublisher, publishOutboxOnce } from '@planthepath/persistence/src/automation-workers.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { AcademicRecordsController } from './academic-records.controller.js';
import { PG_POOL } from '../persistence.provider.js';

type IntegrationEventEnvelope = Parameters<ReturnType<typeof createLocalIntegrationEventPublisher>['publisher']['publish']>[0];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for batch lifecycle tests');
const schemaName = 'batchlife_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string; let otherInstitutionId: string;
let departmentA: string; let departmentB: string; let batchA1: string; let batchA2: string; let batchB1: string;
let batchA1Students: Student[];  // four current students in batch A1
let alumnus: Student;            // batch A1, graduated last year
let otherBatch: Student;         // batch A2
let departmentBStudent: Student; // department B
let admin: Staff; let owner: Staff; let officer: Staff; let head: Staff; let faculty: Staff; let otherAdmin: Staff;

interface Student { userId: string; profileId: string; relationshipId: string; roll: string }
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
  departmentA = randomUUID(); departmentB = randomUUID(); batchA1 = randomUUID(); batchA2 = randomUUID(); batchB1 = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local College'), ($2,'INSTITUTION','Other College')", [institutionId, otherInstitutionId]);
  await unit(departmentA, 'DEPARTMENT', 'Department A', null);
  await unit(departmentB, 'DEPARTMENT', 'Department B', null);
  await unit(batchA1, 'BATCH', 'Batch A1 2022', departmentA);
  await unit(batchA2, 'BATCH', 'Batch A2 2023', departmentA);
  await unit(batchB1, 'BATCH', 'Batch B1 2022', departmentB);
  batchA1Students = [];
  for (let index = 1; index <= 4; index += 1) batchA1Students.push(await student('A1-00' + index, departmentA, batchA1));
  alumnus = await student('A1-900', departmentA, batchA1, { state: 'GRADUATED', effectiveTo: '2025-06-01T00:00:00Z' });
  otherBatch = await student('A2-001', departmentA, batchA2);
  departmentBStudent = await student('B1-001', departmentB, batchB1);
  admin = await staff('INSTITUTION_ADMIN');
  owner = await staff('INSTITUTION_OWNER');
  officer = await staff('PLACEMENT_ADMIN');
  head = await staff('DEPARTMENT_HEAD', departmentA);
  faculty = await staff('FACULTY_LECTURER', departmentA);
  otherAdmin = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 120_000);

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
async function student(roll: string, department: string, batch: string, ended?: { state: string; effectiveTo: string }): Promise<Student> {
  const userId = randomUUID(); const profileId = randomUUID(); const relationshipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [profileId, institutionId, userId, roll, 'Student ' + roll, ended?.state ?? 'ACTIVE', department, batch]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to)
    VALUES ($1,$2,$3,$4,'2022-07-01T00:00:00Z',$5)`, [relationshipId, institutionId, userId, ended?.state ?? 'ACTIVE', ended?.effectiveTo ?? null]);
  return { userId, profileId, relationshipId, roll };
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
/** A shared native application dated `at`. */
async function sharedApplication(subject: Student, at: string): Promise<string> {
  const employer = randomUUID(); const opportunity = randomUUID(); const version = randomUUID(); const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Employer ' || $2)", [employer, id.slice(0, 6)]);
  await pool.query("INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)", [opportunity, employer, admin.id, 'LOCAL-' + id.slice(0, 8)]);
  await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,'Graduate engineer','FULL_TIME','REMOTE',$3,$4)", [version, opportunity, '0'.repeat(64), admin.id]);
  await pool.query(`INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,created_at,updated_at,institution_visibility_granted_at)
    VALUES ($1,$2,$3,$4,$5,'INTERVIEW',$6,$6,$6,$6,$6)`, [id, opportunity, employer, version, subject.userId, at]);
  return id;
}

const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const preview = (actor: Staff, body: Record<string, unknown>) => api().post(base() + '/relationship-batches/preview').set(auth(actor.id)).send(body);
const commit = (actor: Staff, body: Record<string, unknown>) => api().post(base() + '/relationship-batches/commit').set(auth(actor.id)).send(body);
const graduation = '2026-05-31T00:00:00+05:30';
const states = async () => new Map((await pool.query('SELECT student_user_id, state::text AS state, effective_to FROM institution_relationships WHERE institution_id=$1', [institutionId])).rows
  .map((row) => [row.student_user_id as string, { state: row.state as string, effectiveTo: row.effective_to as Date | null }]));
const audits = async (action: string) => (await pool.query('SELECT actor_user_id, resource_id, organization_id, outcome, context FROM audit_events WHERE action=$1 ORDER BY occurred_at', [action])).rows;
const endedEvents = async () => (await pool.query("SELECT aggregate_id, payload FROM outbox_events WHERE event_type='institution.relationship.ended' ORDER BY occurred_at")).rows;
/** Preview then commit with the digest the preview returned. */
async function previewAndCommit(actor: Staff, body: Record<string, unknown>, reasonCode = 'YEAR_END_GRADUATION') {
  const shown = await preview(actor, body).expect(201);
  return commit(actor, { ...body, previewDigest: shown.body.batch.digest, reasonCode }).expect(201);
}
/** Run the deployed worker mode (ADR-028 local dispatcher) until the outbox is drained. */
async function drain(): Promise<IntegrationEventEnvelope[]> {
  const local = createLocalIntegrationEventPublisher({ pool, db });
  const published: IntegrationEventEnvelope[] = [];
  const publisher = { async publish(event: IntegrationEventEnvelope) { published.push(event); await local.publisher.publish(event); } };
  for (let round = 0; round < 20; round += 1) {
    const result = await publishOutboxOnce({ db, publisher, leaseOwner: 'batch-lifecycle-test', now: new Date(Date.now() + 5_000) });
    if (result.claimed === 0) break;
  }
  return published;
}
const systemNotices = async (person: Student) =>
  ((await api().get('/api/v1/me/notifications').set(auth(person.userId)).expect(200)).body.notifications as { kind: string; title: string; body: string; data: Record<string, string> }[])
    .filter((note) => note.kind === 'SYSTEM');
function expectNoPayOrNumericReadiness(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/compensation|salary|stipend|ctc/i);
  expect(text).not.toMatch(/readiness_?score|readinessValue|readinessPercent|"score"/i);
}

describe('who may run a batch action', () => {
  it('requires a token, an owner or admin of this institution, and a valid request', async () => {
    const body = { state: 'GRADUATED', unitId: batchA1 };
    await api().post(base() + '/relationship-batches/preview').send(body).expect(401);
    await api().post(base() + '/relationship-batches/commit').send(body).expect(401);
    for (const actor of [officer, head, faculty, otherAdmin]) {
      const refused = await preview(actor, body).expect(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
      await commit(actor, { ...body, previewDigest: 'a'.repeat(64), reasonCode: 'YEAR_END' }).expect(403);
    }
    await preview(admin, body).expect(201);
    await preview(owner, body).expect(201);
    expect((await states()).get(batchA1Students[0]!.userId)?.state).toBe('ACTIVE');
    expect(await audits('institution.relationship.ended')).toEqual([]);
  });

  it('refuses unknown fields, REVOKED, missing or double targets, bad ids and dates, and a future date', async () => {
    const code = async (body: Record<string, unknown>) => (await preview(admin, body).expect(400)).body.error.code as string;
    expect(await code({ state: 'GRADUATED', unitId: batchA1, extra: true })).toBe('UNKNOWN_FIELD');
    expect(await code({ state: 'REVOKED', unitId: batchA1 })).toBe('INVALID_STATE');
    expect(await code({ state: 'GRADUATED' })).toBe('INVALID_TARGET');
    expect(await code({ state: 'GRADUATED', unitId: batchA1, institutionStudentIds: ['A1-001'] })).toBe('INVALID_TARGET');
    expect(await code({ state: 'GRADUATED', unitId: 'not-a-unit' })).toBe('UNIT_ID_INVALID');
    expect(await code({ state: 'GRADUATED', unitId: randomUUID() })).toBe('UNIT_ID_INVALID');
    expect(await code({ state: 'GRADUATED', institutionStudentIds: [] })).toBe('INVALID_TARGET');
    expect(await code({ state: 'GRADUATED', institutionStudentIds: Array.from({ length: 1001 }, (_, index) => 'R' + index) })).toBe('INVALID_TARGET');
    expect(await code({ state: 'GRADUATED', unitId: batchA1, effectiveTo: '31/05/2026' })).toBe('INVALID_EFFECTIVE_DATE');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(await code({ state: 'GRADUATED', unitId: batchA1, effectiveTo: future })).toBe('EFFECTIVE_DATE_IN_FUTURE');
    const shown = await preview(admin, { state: 'GRADUATED', unitId: batchA1 }).expect(201);
    expect((await commit(admin, { state: 'GRADUATED', unitId: batchA1, previewDigest: shown.body.batch.digest }).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    expect((await commit(admin, { state: 'GRADUATED', unitId: batchA1, previewDigest: shown.body.batch.digest, reasonCode: 'year end' }).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    expect((await commit(admin, { state: 'GRADUATED', unitId: batchA1, reasonCode: 'YEAR_END' }).expect(400)).body.error.code).toBe('PREVIEW_DIGEST_REQUIRED');
    expect(await audits('institution.relationship.ended')).toEqual([]);
  });
});

describe('preview then commit', () => {
  it('previews a batch without writing anything but an audit row', async () => {
    const shown = await preview(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: graduation }).expect(201);
    const batch = shown.body.batch;
    expect(batch.counts).toEqual({ change: 4, unchanged: 1, invalid: 0 });
    expect(batch.rows.map((row: { institutionStudentId: string }) => row.institutionStudentId)).toEqual(['A1-001', 'A1-002', 'A1-003', 'A1-004', 'A1-900']);
    expect(batch.rows.find((row: { institutionStudentId: string }) => row.institutionStudentId === 'A1-900')).toMatchObject({ outcome: 'UNCHANGED', currentState: 'GRADUATED' });
    expect(batch.rows[0]).toMatchObject({ fullName: 'Student A1-001', currentState: 'ACTIVE', outcome: 'CHANGE', issues: [] });
    expect(batch.digest).toMatch(/^[0-9a-f]{64}$/);
    // The same selection previews to the same digest; a different date does not.
    expect((await preview(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: graduation }).expect(201)).body.batch.digest).toBe(batch.digest);
    expect((await preview(admin, { state: 'GRADUATED', unitId: batchA1 }).expect(201)).body.batch.digest).not.toBe(batch.digest);
    expect([...(await states()).values()].filter((row) => row.state === 'ACTIVE')).toHaveLength(6);
    expect(await endedEvents()).toEqual([]);
    const previewed = await audits('institution.relationship_batch.previewed');
    expect(previewed).toHaveLength(3);
    expect(previewed[0]).toMatchObject({ actor_user_id: admin.id, organization_id: institutionId, context: { state: 'GRADUATED', digest: batch.digest } });
    expectNoPayOrNumericReadiness(shown.body);
  });

  it('graduates the whole batch in one transaction, audited per student, and leaves every other student alone', async () => {
    const done = await previewAndCommit(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: graduation });
    expect(done.body.batch).toMatchObject({ changed: 4, counts: { change: 4, unchanged: 1, invalid: 0 } });
    const after = await states();
    for (const subject of batchA1Students) {
      expect(after.get(subject.userId)?.state).toBe('GRADUATED');
      expect(after.get(subject.userId)?.effectiveTo?.toISOString()).toBe('2026-05-30T18:30:00.000Z');
    }
    expect(after.get(alumnus.userId)).toEqual({ state: 'GRADUATED', effectiveTo: new Date('2025-06-01T00:00:00Z') });
    expect(after.get(otherBatch.userId)?.state).toBe('ACTIVE');
    expect(after.get(departmentBStudent.userId)?.state).toBe('ACTIVE');
    const roster = await pool.query('SELECT student_user_id, status::text AS status FROM institution_student_profiles WHERE institution_id=$1', [institutionId]);
    expect(roster.rows.filter((row) => row.status === 'GRADUATED').map((row) => row.student_user_id).sort()).toEqual([...batchA1Students.map((s) => s.userId), alumnus.userId].sort());
    const perStudent = await audits('institution.relationship.ended');
    expect(perStudent.map((row) => row.resource_id).sort()).toEqual(batchA1Students.map((s) => s.relationshipId).sort());
    for (const row of perStudent) {
      expect(row).toMatchObject({ actor_user_id: admin.id, organization_id: institutionId, outcome: 'SUCCESS',
        context: { state: 'GRADUATED', reasonCode: 'YEAR_END_GRADUATION', batchReference: done.body.batch.reference, bulk: true, effectiveTo: '2026-05-30T18:30:00.000Z' } });
    }
    const summary = await audits('institution.relationship_batch.committed');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ resource_id: done.body.batch.reference, context: { reasonCode: 'YEAR_END_GRADUATION', changed: 4, state: 'GRADUATED' } });
    expect((await endedEvents()).map((row) => row.aggregate_id).sort()).toEqual(batchA1Students.map((s) => s.relationshipId).sort());
    // A second run finds nothing current to change.
    const again = await preview(admin, { state: 'GRADUATED', unitId: batchA1 }).expect(201);
    expect(again.body.batch.counts).toEqual({ change: 0, unchanged: 5, invalid: 0 });
    expect((await commit(admin, { state: 'GRADUATED', unitId: batchA1, previewDigest: again.body.batch.digest, reasonCode: 'YEAR_END' }).expect(400)).body.error.code).toBe('NOTHING_TO_CHANGE');
  });

  it('covers a department, its batches and their sections when the unit is a department', async () => {
    const shown = await preview(admin, { state: 'TRANSFERRED', unitId: departmentA }).expect(201);
    expect(shown.body.batch.counts).toEqual({ change: 5, unchanged: 1, invalid: 0 });
    expect(shown.body.batch.rows.map((row: { institutionStudentId: string }) => row.institutionStudentId)).not.toContain('B1-001');
  });

  it('changes a selection by roll number, case-insensitively and once each', async () => {
    const body = { state: 'ENDED', institutionStudentIds: ['a1-002', 'A1-002 ', 'B1-001'] };
    const done = await previewAndCommit(admin, body, 'LEFT_PROGRAMME');
    expect(done.body.batch.changed).toBe(2);
    const after = await states();
    expect(after.get(batchA1Students[1]!.userId)?.state).toBe('ENDED');
    expect(after.get(departmentBStudent.userId)?.state).toBe('ENDED');
    expect(after.get(batchA1Students[0]!.userId)?.state).toBe('ACTIVE');
  });

  it('writes nothing when any row is invalid, and lists the rows', async () => {
    const body = { state: 'GRADUATED', institutionStudentIds: ['A1-001', 'NOT-ON-ROSTER'] };
    const shown = await preview(admin, body).expect(201);
    expect(shown.body.batch.counts).toEqual({ change: 1, unchanged: 0, invalid: 1 });
    expect(shown.body.batch.rows.find((row: { institutionStudentId: string }) => row.institutionStudentId === 'NOT-ON-ROSTER'))
      .toMatchObject({ outcome: 'INVALID', issues: ['STUDENT_NOT_FOUND'], fullName: null, studentProfileId: null });
    const refused = await commit(admin, { ...body, previewDigest: shown.body.batch.digest, reasonCode: 'YEAR_END' }).expect(400);
    expect(refused.body.error.code).toBe('BATCH_HAS_INVALID_ROWS');
    expect(refused.body.batch.rows).toHaveLength(2);
    expect((await states()).get(batchA1Students[0]!.userId)?.state).toBe('ACTIVE');
    expect(await audits('institution.relationship.ended')).toEqual([]);
    expect(await audits('institution.relationship_batch.committed')).toEqual([]);
    expect(await endedEvents()).toEqual([]);
  });

  it('refuses an end date on or before a relationship began, as the window CHECK would', async () => {
    const shown = await preview(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: '2022-07-01T00:00:00Z' }).expect(201);
    expect(shown.body.batch.counts.invalid).toBe(4);
    expect(shown.body.batch.rows[0]).toMatchObject({ outcome: 'INVALID', issues: ['EFFECTIVE_BEFORE_START'] });
    await commit(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: '2022-07-01T00:00:00Z', previewDigest: shown.body.batch.digest, reasonCode: 'YEAR_END' }).expect(400);
    expect([...(await states()).values()].filter((row) => row.state === 'ACTIVE')).toHaveLength(6);
  });

  it('refuses a commit whose roster changed after the preview, writing nothing', async () => {
    const shown = await preview(admin, { state: 'GRADUATED', unitId: batchA1 }).expect(201);
    // One student is ended individually in between.
    await api().post(base() + '/students/' + batchA1Students[2]!.profileId + '/relationship').set(auth(admin.id)).send({ state: 'ENDED' }).expect(201);
    const stale = await commit(admin, { state: 'GRADUATED', unitId: batchA1, previewDigest: shown.body.batch.digest, reasonCode: 'YEAR_END' }).expect(409);
    expect(stale.body.error.code).toBe('BATCH_PREVIEW_STALE');
    const after = await states();
    expect(after.get(batchA1Students[0]!.userId)?.state).toBe('ACTIVE');
    expect(after.get(batchA1Students[2]!.userId)?.state).toBe('ENDED');
    expect(await audits('institution.relationship_batch.committed')).toEqual([]);
    // A student added to the batch after the preview also makes it stale.
    const fresh = await preview(admin, { state: 'GRADUATED', unitId: batchA1 }).expect(201);
    await student('A1-005', departmentA, batchA1);
    await commit(admin, { state: 'GRADUATED', unitId: batchA1, previewDigest: fresh.body.batch.digest, reasonCode: 'YEAR_END' }).expect(409);
    expect((await states()).get(batchA1Students[0]!.userId)?.state).toBe('ACTIVE');
  });

  it('rolls the whole batch back when one write is refused by the database', async () => {
    const shown = await preview(admin, { state: 'GRADUATED', unitId: batchA1 }).expect(201);
    // A trigger standing in for any constraint that refuses one student's row mid-batch.
    await pool.query(`CREATE FUNCTION refuse_one() RETURNS trigger AS $$ BEGIN
      IF NEW.student_user_id = '${batchA1Students[3]!.userId}'::uuid THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query('CREATE TRIGGER refuse_one BEFORE UPDATE ON institution_student_profiles FOR EACH ROW EXECUTE FUNCTION refuse_one()');
    try {
      const failed = await commit(admin, { state: 'GRADUATED', unitId: batchA1, previewDigest: shown.body.batch.digest, reasonCode: 'YEAR_END' });
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain('refused');
    } finally {
      await pool.query('DROP TRIGGER refuse_one ON institution_student_profiles');
      await pool.query('DROP FUNCTION refuse_one()');
    }
    expect([...(await states()).values()].filter((row) => row.state === 'ACTIVE')).toHaveLength(6);
    expect(await audits('institution.relationship.ended')).toEqual([]);
    expect(await endedEvents()).toEqual([]);
  });

  it('revokes a pending invitation so a graduated student cannot activate into the relationship', async () => {
    await api().post(base() + '/students').set(auth(admin.id)).send({ fullName: 'Invited Student', institutionStudentId: 'A1-777', email: 'invited.a1@example.test', departmentUnitId: departmentA, batchUnitId: batchA1 }).expect(201);
    await previewAndCommit(admin, { state: 'GRADUATED', unitId: batchA1 });
    const invitation = await pool.query("SELECT state, reason_code FROM invitations WHERE kind='STUDENT' AND lower(email)='invited.a1@example.test'");
    expect(invitation.rows[0]).toEqual({ state: 'REVOKED', reason_code: 'RELATIONSHIP_GRADUATED' });
  });
});

describe('after graduation', () => {
  it('lets the college see only activity dated before the effective date', async () => {
    const graduate = batchA1Students[0]!;
    const before = '2026-04-15T00:00:00Z'; const afterwards = '2026-06-15T00:00:00Z';
    const access = (at: string) => api().get(base() + '/student-activity-access/' + graduate.userId + '?activityAt=' + at).set(auth(admin.id));
    await access(afterwards).expect(200);
    await previewAndCommit(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: graduation });
    await access(before).expect(200);
    await access(afterwards).expect(403);
    await access('2026-05-31T00:00:00+05:30').expect(403);   // effective_to is exclusive
    // Current views drop the graduate on the next request; the roster keeps the college's own record.
    const status = await api().get(base() + '/placement-status').set(auth(admin.id)).expect(200);
    expect(status.body.students.map((row: { studentUserId: string }) => row.studentUserId)).not.toContain(graduate.userId);
    const roster = await api().get(base() + '/students').set(auth(admin.id)).expect(200);
    const row = roster.body.students.find((entry: { studentUserId: string }) => entry.studentUserId === graduate.userId);
    expect(row.relationship).toMatchObject({ state: 'GRADUATED' });
    expect(new Date(row.relationship.effectiveTo).toISOString()).toBe('2026-05-30T18:30:00.000Z');
    expectNoPayOrNumericReadiness(roster.body);
  });

  it('never touches the student account, profile choices, consents, applications or records', async () => {
    const graduate = batchA1Students[0]!;
    await pool.query("INSERT INTO student_profiles (user_id, visibility_state, employer_discovery_enabled, profile_headline) VALUES ($1,'INSTITUTION_VISIBLE',true,'Graduate engineer')", [graduate.userId]);
    await pool.query("INSERT INTO consent_definitions (consent_key,version,title,enforcement) VALUES ('batch-test-notice','v1','Test notice','OPTIONAL') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO user_consents (id,user_id,consent_key,version) VALUES ($1,$2,'batch-test-notice','v1')", [randomUUID(), graduate.userId]);
    await sharedApplication(graduate, '2026-04-01T00:00:00Z');
    const qualification = randomUUID();
    await pool.query("INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name) VALUES ($1,$2,$3,'BTECH','Computer Science')", [qualification, graduate.userId, institutionId]);
    await pool.query("INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,backlog_count,source,verification_state) VALUES ($1,$2,1,'Semester 1',8.2,'CGPA_10',0,'STUDENT_DECLARED','SELF_REPORTED')", [randomUUID(), qualification]);
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT row_to_json(u) FROM users u WHERE u.id=$1) AS account,
      (SELECT row_to_json(p) FROM student_profiles p WHERE p.user_id=$1) AS profile,
      (SELECT json_agg(c ORDER BY c.id) FROM user_consents c WHERE c.user_id=$1) AS consents,
      (SELECT json_agg(a ORDER BY a.id) FROM applications a WHERE a.student_user_id=$1) AS applications,
      (SELECT json_agg(q ORDER BY q.id) FROM student_qualifications q WHERE q.student_user_id=$1) AS qualifications,
      (SELECT json_agg(t ORDER BY t.id) FROM student_academic_terms t JOIN student_qualifications q ON q.id=t.qualification_id WHERE q.student_user_id=$1) AS terms`,
    [graduate.userId])).rows[0];
    const beforeRows = await snapshot();
    await previewAndCommit(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: graduation });
    expect(await snapshot()).toEqual(beforeRows);
    expect(beforeRows.account.state).toBe('ACTIVE');
  });

  it('keeps the student workspace, profile and documents for a former student', async () => {
    const graduate = batchA1Students[0]!;
    await api().patch('/api/v1/students/me/profile').set(auth(graduate.userId))
      .send({ targetCareer: 'Data Analyst', careerInterests: [], profileHeadline: null, profileSummary: null, portfolioUrl: null, visibilityState: 'PRIVATE', employerDiscoveryEnabled: false }).expect(200);
    await previewAndCommit(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: graduation });
    const context = await api().get('/api/v1/security/context').set(auth(graduate.userId)).expect(200);
    expect(context.body.studentRelationships).toEqual([]);
    expect(context.body.formerStudentRelationships).toEqual([expect.objectContaining({ institutionId, state: 'GRADUATED' })]);
    const me = await api().get('/api/v1/students/me').set(auth(graduate.userId)).expect(200);
    expect(me.body.student).toMatchObject({ userId: graduate.userId, formerStudent: true, institutionName: 'Local College', academicStatus: 'GRADUATED',
      institutionStudentId: 'A1-001', relationship: { state: 'GRADUATED' } });
    expect(new Date(me.body.student.relationship.effectiveTo).toISOString()).toBe('2026-05-30T18:30:00.000Z');
    const profile = await api().get('/api/v1/students/me/profile').set(auth(graduate.userId)).expect(200);
    expect(profile.body.profile).toMatchObject({ targetCareer: 'Data Analyst' });
    await api().patch('/api/v1/students/me/profile').set(auth(graduate.userId))
      .send({ targetCareer: 'Data Engineer', careerInterests: [], profileHeadline: null, profileSummary: null, portfolioUrl: null, visibilityState: 'PRIVATE', employerDiscoveryEnabled: false }).expect(200);
    await api().post('/api/v1/students/me/documents').set(auth(graduate.userId)).send({ title: 'Degree certificate', documentType: 'CERTIFICATE' }).expect(201);
    await api().get('/api/v1/students/me/documents').set(auth(graduate.userId)).expect(200);
    await api().get('/api/v1/students/me/saved-opportunities').set(auth(graduate.userId)).expect(200);
    // A current student is unchanged, and still reads as current.
    const current = await api().get('/api/v1/students/me').set(auth(otherBatch.userId)).expect(200);
    expect(current.body.student).toMatchObject({ formerStudent: false, relationship: { state: 'ACTIVE' } });
    const currentContext = await api().get('/api/v1/security/context').set(auth(otherBatch.userId)).expect(200);
    expect(currentContext.body.studentRelationships).toEqual([expect.objectContaining({ institutionId, state: 'ACTIVE' })]);
    expect(currentContext.body.formerStudentRelationships).toEqual([]);
  });

  it('still refuses someone whose roster link the college revoked, and someone never rostered', async () => {
    await api().post(base() + '/students/' + otherBatch.profileId + '/relationship').set(auth(admin.id)).send({ state: 'REVOKED' }).expect(201);
    await api().get('/api/v1/students/me').set(auth(otherBatch.userId)).expect(403);
    await api().get('/api/v1/students/me/profile').set(auth(otherBatch.userId)).expect(403);
    const context = await api().get('/api/v1/security/context').set(auth(otherBatch.userId)).expect(200);
    expect(context.body.formerStudentRelationships).toEqual([]);
    await api().get('/api/v1/students/me/profile').set(auth(admin.id)).expect(403);
  });

  it('keeps verified records and lets a graduate ask for a past result to be verified', async () => {
    const graduate = batchA1Students[0]!;
    const qualification = randomUUID(); const verified = randomUUID(); const later = randomUUID();
    await pool.query("INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name) VALUES ($1,$2,$3,'BTECH','Computer Science')", [qualification, graduate.userId, institutionId]);
    await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,backlog_count,source,verification_state,verified_by_user_id,verified_at)
      VALUES ($1,$2,1,'Semester 1',8.2,'CGPA_10',0,'INSTITUTION_IMPORTED','VERIFIED',$3,now())`, [verified, qualification, admin.id]);
    await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,backlog_count,source,verification_state)
      VALUES ($1,$2,8,'Semester 8',8.6,'CGPA_10',0,'STUDENT_DECLARED','SELF_REPORTED')`, [later, qualification]);
    await previewAndCommit(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: graduation });
    const records = await api().get('/api/v1/students/me/academic-records').set(auth(graduate.userId)).expect(200);
    expect(JSON.stringify(records.body)).toContain('Semester 1');
    await api().post('/api/v1/students/me/academic-records/terms/' + later + '/submit').set(auth(graduate.userId)).expect(201);
    const queue = await api().get(base() + '/academic-verification-queue').set(auth(admin.id)).expect(200);
    const request_ = queue.body.queue.find((entry: { termId: string }) => entry.termId === later);
    expect(request_).toMatchObject({ relationship: 'FORMER' });
    await api().post(base() + '/academic-verification/' + later + '/decide').set(auth(admin.id)).send({ decision: 'VERIFIED', reasonCode: 'MATCHES_ARCHIVE' }).expect(201);
    expect((await pool.query('SELECT verification_state FROM student_academic_terms WHERE id=$1', [later])).rows[0].verification_state).toBe('VERIFIED');
  });
});

describe('telling the student', () => {
  it('notifies each graduate once, in plain words, and never a student who never activated', async () => {
    const invitedProfile = await api().post(base() + '/students').set(auth(admin.id)).send({ fullName: 'Invited Student', institutionStudentId: 'A2-777', email: 'invited.a1@example.test', departmentUnitId: departmentA, batchUnitId: batchA2 }).expect(201);
    await previewAndCommit(admin, { state: 'GRADUATED', unitId: batchA1, effectiveTo: graduation });
    // A rostered student who never activated is ended too; there is nobody to tell.
    await api().post(base() + '/students/' + invitedProfile.body.student.id + '/relationship').set(auth(admin.id)).send({ state: 'ENDED' }).expect(201);
    const published = (await drain()).filter((event) => event.eventType === 'institution.relationship.ended');
    expect(published).toHaveLength(5);
    const notices = await systemNotices(batchA1Students[0]!);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Local College recorded you as graduated');
    expect(notices[0]!.body).toContain('31 May 2026');
    expect(notices[0]!.body).toContain('stay yours');
    expect(notices[0]!.data).toMatchObject({ kind: 'INSTITUTION_RELATIONSHIP', state: 'GRADUATED' });
    expect(JSON.stringify(notices)).not.toMatch(/relationshipId|profileId/);
    // A replay of every event, through a fresh consumer instance, adds nothing.
    const local = createLocalIntegrationEventPublisher({ pool, db });
    for (const event of published) await local.publisher.publish(event);
    expect(await systemNotices(batchA1Students[0]!)).toHaveLength(1);
    const invited = await pool.query("SELECT u.id FROM users u WHERE lower(u.email)='invited.a1@example.test'");
    expect((await pool.query("SELECT count(*)::int AS n FROM user_notifications WHERE user_id=$1", [invited.rows[0].id])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM user_notifications WHERE kind='SYSTEM'")).rows[0].n).toBe(4);
    // A student outside the batch hears nothing.
    expect(await systemNotices(otherBatch)).toEqual([]);
  });

  it('notifies a student ended one at a time as well', async () => {
    await api().post(base() + '/students/' + otherBatch.profileId + '/relationship').set(auth(admin.id)).send({ state: 'TRANSFERRED' }).expect(201);
    await drain();
    const notices = await systemNotices(otherBatch);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Local College recorded you as transferred');
  });
});
