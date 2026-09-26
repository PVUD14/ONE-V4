/**
 * The institution analytics capability and CSV exports (INST-08, defect I-9).
 *
 * Without a live INSTITUTION_ANALYTICS grant every export is 403, for every role; with one,
 * an export covers the grant holder's write scope, is audited before the file is sent,
 * suppresses every aggregate cell under 5 over one ended month, neutralises formulas on
 * output, and never carries an internal identifier, numeric readiness or compensation.
 * Grants and revocations are reason-coded and audited.
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
import { institutionForbiddenDisclosureFields } from '@planthepath/authorization/src/index.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { CareerReadinessController } from './career-readiness.controller.js';
import { InstitutionExportsController } from './institution-exports.controller.js';
import { PlatformControlsController } from './platform-controls.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for institution export tests');
const schemaName = 'inst_exports_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let app: INestApplication;
let institutionId: string; let otherInstitutionId: string;
let departmentA: string; let departmentB: string; let batchA1: string;
let owner: Staff; let admin: Staff; let secondAdmin: Staff; let placement: Staff; let headA: Staff; let unscopedHead: Staff; let faculty: Staff; let otherAdmin: Staff;

interface Staff { id: string; membershipId: string }
interface Student { userId: string; profileId: string; relationshipId: string }

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
    controllers: [InstitutionExportsController, PlatformControlsController, CareerReadinessController],
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
  departmentA = randomUUID(); departmentB = randomUUID(); batchA1 = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Local institution'), ($2,'INSTITUTION','Other institution')", [institutionId, otherInstitutionId]);
  await pool.query(`INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES
    ($1,$3,'DEPARTMENT','Mechanical',NULL), ($2,$3,'DEPARTMENT','Civil',NULL)`, [departmentA, departmentB, institutionId]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,'BATCH','Mechanical 2027',$3)", [batchA1, institutionId, departmentA]);
  owner = await staff('INSTITUTION_OWNER');
  admin = await staff('INSTITUTION_ADMIN');
  secondAdmin = await staff('INSTITUTION_ADMIN');
  placement = await staff('PLACEMENT_ADMIN');
  headA = await staff('DEPARTMENT_HEAD', departmentA);
  unscopedHead = await staff('DEPARTMENT_HEAD');
  faculty = await staff('FACULTY_LECTURER', departmentA);
  otherAdmin = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function staff(role: string, department: string | null = null, organization: string = institutionId): Promise<Staff> {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, role.toLowerCase() + '-' + id.slice(0, 8) + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, organization, id, role, department]);
  return { id, membershipId };
}
async function student(roll: string, fullName: string, department: string | null, batch: string | null = null, state = 'ACTIVE', userState = 'ACTIVE'): Promise<Student> {
  const userId = randomUUID(); const profileId = randomUUID(); const relationshipId = randomUUID();
  await pool.query('INSERT INTO users (id,email,state) VALUES ($1,$2,$3)', [userId, roll.toLowerCase() + '@student.example.test', userState]);
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7)`, [profileId, institutionId, userId, roll, fullName, department, batch]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to)
    VALUES ($1,$2,$3,$4,'2020-01-01T00:00:00Z',$5)`, [relationshipId, institutionId, userId, state, state === 'ACTIVE' ? null : new Date(Date.now() - 86_400_000).toISOString()]);
  return { userId, profileId, relationshipId };
}
async function grant(member: Staff, grantor: Staff = owner): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'INSTITUTION_ANALYTICS',$3,'ANALYTICS_RESPONSIBILITY')", [id, member.membershipId, grantor.id]);
  return id;
}
const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const audits = async (action: string) => (await pool.query('SELECT actor_user_id, organization_id, outcome, context FROM audit_events WHERE action=$1 ORDER BY occurred_at', [action])).rows;
/** Parse the writer's own output: quoted cells, CRLF rows, a leading byte-order mark. */
function parseCsv(text: string): string[][] {
  expect(text.startsWith('﻿')).toBe(true);
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  const body = text.slice(1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; } else if (char === '\r' && body[index + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; index += 1; } else cell += char;
  }
  return rows;
}
function lastMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}
function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
const exportPaths = ['roster', 'readiness-bands', 'assessment-results', 'staff-action-summary'] as const;
const validBody = (path: string) => ({ reasonCode: 'MANAGEMENT_REPORTING', ...(path === 'readiness-bands' || path === 'staff-action-summary' ? { month: lastMonth() } : {}), ...(path === 'assessment-results' ? { assessmentId: randomUUID() } : {}) });

describe('the analytics capability on the Staff screen', () => {
  it('lets an owner or admin grant and revoke it with a reason code, each audited', async () => {
    await api().post(base() + '/capabilities').set(auth(owner.id)).send({ membershipId: admin.membershipId, capability: 'INSTITUTION_ANALYTICS' }).expect(400);
    const granted = await api().post(base() + '/capabilities').set(auth(owner.id))
      .send({ membershipId: headA.membershipId, capability: 'INSTITUTION_ANALYTICS', reasonCode: 'DEPARTMENT_REPORTING' }).expect(201);
    const head = granted.body.eligible.find((entry: { membershipId: string }) => entry.membershipId === headA.membershipId);
    expect(head).toMatchObject({ role: 'DEPARTMENT_HEAD', department: 'Mechanical', grant: { reasonCode: 'DEPARTMENT_REPORTING' } });
    expect(granted.body.eligible.map((entry: { role: string }) => entry.role).sort()).toEqual(['DEPARTMENT_HEAD', 'DEPARTMENT_HEAD', 'INSTITUTION_ADMIN', 'INSTITUTION_ADMIN']);
    expect((await audits('institution.analytics_capability.granted')).map((row) => [row.actor_user_id, row.organization_id, row.context.reasonCode]))
      .toEqual([[owner.id, institutionId, 'DEPARTMENT_REPORTING']]);

    const path = base() + '/capabilities/' + head.grant.capabilityId + '/revoke';
    await api().post(path).set(auth(admin.id)).send({}).expect(400);
    await api().post(path).set(auth(admin.id)).send({ reasonCode: 'RESPONSIBILITY_ENDED' }).expect(201);
    const row = await pool.query('SELECT revoked_by_user_id, revoked_reason_code FROM membership_capabilities WHERE id=$1', [head.grant.capabilityId]);
    expect(row.rows[0]).toEqual({ revoked_by_user_id: admin.id, revoked_reason_code: 'RESPONSIBILITY_ENDED' });
    expect((await audits('institution.analytics_capability.revoked')).map((entry) => [entry.actor_user_id, entry.context.reasonCode])).toEqual([[admin.id, 'RESPONSIBILITY_ENDED']]);
    await api().post(path).set(auth(admin.id)).send({ reasonCode: 'RESPONSIBILITY_ENDED' }).expect(404);
  });

  it('refuses a self-grant, an ineligible role, another institution and a non-admin granter, writing nothing', async () => {
    const send = (actor: Staff, target: Staff, institution = institutionId) => api().post(base(institution) + '/capabilities').set(auth(actor.id))
      .send({ membershipId: target.membershipId, capability: 'INSTITUTION_ANALYTICS', reasonCode: 'ANALYTICS_RESPONSIBILITY' });
    expect((await send(admin, admin).expect(400)).body.error.code).toBe('CAPABILITY_SELF_GRANT_REFUSED');
    for (const target of [faculty, placement, owner]) expect((await send(admin, target).expect(400)).body.error.code).toBe('CAPABILITY_ROLE_NOT_ELIGIBLE');
    await send(admin, otherAdmin).expect(404);
    await send(otherAdmin, headA).expect(403);
    for (const actor of [headA, placement, faculty]) await send(actor, secondAdmin).expect(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM membership_capabilities')).rows[0].n).toBe(0);
    expect(await audits('institution.analytics_capability.granted')).toEqual([]);
  });

  it('does not let the college revoke a capability operations granted', async () => {
    const reviewer = randomUUID();
    await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'CONTENT_REVIEW_EXTERNAL',$3,'CONTENT_REVIEW')", [reviewer, headA.membershipId, owner.id]);
    await api().post(base() + '/capabilities/' + reviewer + '/revoke').set(auth(admin.id)).send({ reasonCode: 'ACCESS_REVIEW' }).expect(404);
    expect((await pool.query('SELECT revoked_at FROM membership_capabilities WHERE id=$1', [reviewer])).rows[0].revoked_at).toBeNull();
  });
});

describe('export authorisation', () => {
  it('refuses without a token', async () => {
    for (const path of exportPaths) await api().post(base() + '/exports/' + path).send(validBody(path)).expect(401);
  });

  it('returns 403 on every export for every role without the capability, and audits the refusal', async () => {
    for (const actor of [owner, admin, secondAdmin, placement, headA, unscopedHead, faculty]) {
      for (const path of exportPaths) {
        const refused = await api().post(base() + '/exports/' + path).set(auth(actor.id)).send(validBody(path)).expect(403);
        expect(refused.body.error.code).toBe('ANALYTICS_CAPABILITY_REQUIRED');
        expect(refused.body.error.correlationId).toBeTruthy();
      }
    }
    const denied = await audits('institution.export.denied');
    expect(denied).toHaveLength(7 * exportPaths.length);
    expect(denied.every((row) => row.outcome === 'DENIED' && row.organization_id === institutionId)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'institution.%.exported'")).rows[0].n).toBe(0);
  });

  it('refuses a grant held in another institution, and a caller from another institution', async () => {
    await grant(otherAdmin, await staff('INSTITUTION_OWNER', null, otherInstitutionId));
    for (const path of exportPaths) await api().post(base() + '/exports/' + path).set(auth(otherAdmin.id)).send(validBody(path)).expect(403);
  });

  it('stops admitting on the next request once the grant is revoked, or the role changes under it', async () => {
    const capabilityId = await grant(admin);
    await grant(headA);
    await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING' }).expect(200);
    await api().post(base() + '/capabilities/' + capabilityId + '/revoke').set(auth(owner.id)).send({ reasonCode: 'ACCESS_REVIEW' }).expect(201);
    await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING' }).expect(403);
    // 0031's trigger checks the role only when a grant is written; the predicate re-checks it on every export.
    await pool.query("UPDATE organization_memberships SET role='FACULTY_LECTURER' WHERE id=$1", [headA.membershipId]);
    await api().post(base() + '/exports/roster').set(auth(headA.id)).send({ reasonCode: 'MANAGEMENT_REPORTING' }).expect(403);
  });

  it('refuses a department head with no department even holding the grant (export uses the write scope)', async () => {
    await grant(unscopedHead);
    for (const path of exportPaths) {
      const refused = await api().post(base() + '/exports/' + path).set(auth(unscopedHead.id)).send(validBody(path)).expect(403);
      expect(refused.body.error.code).toBe('SCOPE_REQUIRED');
    }
  });

  it('validates the request: reason code, unknown fields, month and unit, and audits nothing refused', async () => {
    await grant(admin);
    await api().post(base() + '/exports/roster').set(auth(admin.id)).send({}).expect(400);
    await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'bad reason' }).expect(400);
    expect((await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', includeEmail: true }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', unitId: 'x' }).expect(400)).body.error.code).toBe('UNIT_ID_INVALID');
    expect((await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', unitId: randomUUID() }).expect(400)).body.error.code).toBe('UNIT_ID_INVALID');
    expect((await api().post(base() + '/exports/assessment-results').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', assessmentId: randomUUID() }).expect(404)).body.error.code).toBe('ASSESSMENT_NOT_FOUND');
    const malformed = await api().post(base('not-a-uuid') + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING' });
    expect([400, 403]).toContain(malformed.status);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'institution.%.exported'")).rows[0].n).toBe(0);
  });
});

describe('roster export', () => {
  it('exports current, in-scope students with activation state, unit names, and no internal identifier', async () => {
    await grant(admin); await grant(headA);
    await student('ME-001', 'Asha Rao', departmentA, batchA1);
    await student('ME-002', '=HYPERLINK("http://evil.example")', departmentA, null, 'ACTIVE', 'INVITED');
    await student('CE-001', 'Civil Student', departmentB);
    await student('ME-900', 'Ended Student', departmentA, null, 'ENDED');
    const response = await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING' }).expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="one-roster-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers['cache-control']).toBe('no-store');
    const rows = parseCsv(response.text);
    expect(rows[0]).toEqual(['Student ID', 'Full name', 'Email', 'Department', 'Programme', 'Batch', 'Section', 'Relationship', 'Activation', 'Invited on', 'Last invitation sent']);
    expect(rows.slice(1).map((row) => row.slice(0, 9))).toEqual([
      ['CE-001', 'Civil Student', 'ce-001@student.example.test', 'Civil', '', '', '', 'Active', 'Activated'],
      ['ME-001', 'Asha Rao', 'me-001@student.example.test', 'Mechanical', '', 'Mechanical 2027', '', 'Active', 'Activated'],
      ['ME-002', `'=HYPERLINK("http://evil.example")`, 'me-002@student.example.test', 'Mechanical', '', '', '', 'Active', 'Not invited'],
    ]);
    expect(response.text).not.toMatch(uuidText);
    expect(response.text).not.toContain('Ended Student');

    const scoped = parseCsv((await api().post(base() + '/exports/roster').set(auth(headA.id)).send({ reasonCode: 'DEPARTMENT_REVIEW' }).expect(200)).text);
    expect(scoped.slice(1).map((row) => row[0])).toEqual(['ME-001', 'ME-002']);

    const trail = await audits('institution.roster.exported');
    expect(trail.map((row) => [row.actor_user_id, row.organization_id, row.outcome, row.context.reasonCode, row.context.rowCount, row.context.scope]))
      .toEqual([[admin.id, institutionId, 'SUCCESS', 'MANAGEMENT_REPORTING', 3, 'INSTITUTION'], [headA.id, institutionId, 'SUCCESS', 'DEPARTMENT_REVIEW', 2, 'UNITS']]);
    expect(trail[1]!.context.anchorUnitIds).toEqual([departmentA]);
  });

  it('narrows to one unit inside the scope, and refuses a unit outside it', async () => {
    await grant(admin); await grant(headA);
    await student('ME-001', 'Asha Rao', departmentA, batchA1);
    await student('ME-002', 'Ravi Kumar', departmentA);
    await student('CE-001', 'Civil Student', departmentB);
    const batch = parseCsv((await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', unitId: batchA1 }).expect(200)).text);
    expect(batch.slice(1).map((row) => row[0])).toEqual(['ME-001']);
    expect((await api().post(base() + '/exports/roster').set(auth(headA.id)).send({ reasonCode: 'DEPARTMENT_REVIEW', unitId: departmentB }).expect(403)).body.error.code).toBe('UNIT_OUT_OF_SCOPE');
  });

  it('refuses an export over the row cap and records no export', async () => {
    await grant(admin);
    await pool.query(`WITH people AS (
        INSERT INTO users (id,email,state) SELECT gen_random_uuid(), 'bulk' || n || '@student.example.test', 'ACTIVE' FROM generate_series(1, 10001) AS n RETURNING id, email)
      , profiles AS (
        INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status)
        SELECT gen_random_uuid(), $1, id, 'B-' || email, 'Bulk student', 'ACTIVE' FROM people RETURNING student_user_id)
      INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
      SELECT gen_random_uuid(), $1, student_user_id, 'ACTIVE', '2020-01-01T00:00:00Z' FROM profiles`, [institutionId]);
    expect((await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING' }).expect(422)).body.error.code).toBe('EXPORT_TOO_LARGE');
    expect(await audits('institution.roster.exported')).toEqual([]);
  });

  it('limits exports per person per day', async () => {
    await grant(admin);
    await pool.query(`INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,organization_id,outcome,correlation_id)
      SELECT gen_random_uuid(), $1, 'institution.roster.exported', 'institution_export', gen_random_uuid()::text, $2, 'SUCCESS', 'seed' FROM generate_series(1, 30)`, [admin.id, institutionId]);
    expect((await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING' }).expect(429)).body.error.code).toBe('EXPORT_RATE_LIMITED');
    await pool.query("UPDATE audit_events SET occurred_at = now() - interval '25 hours' WHERE actor_user_id=$1", [admin.id]);
    await api().post(base() + '/exports/roster').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING' }).expect(200);
  });
});

describe('readiness band export', () => {
  async function readiness(students: readonly Student[], band: string) {
    for (const learner of students) {
      await pool.query(`INSERT INTO readiness_snapshots (id,subject_user_id,model_version_id,evidence_ids,evidence_set_hash,band,explanation,generated_at)
        VALUES ($1,$2,$3,'{}'::uuid[],$4,$5,'{}'::jsonb,$6)`, [randomUUID(), learner.userId, modelVersionId, randomUUID().replaceAll('-', '').padEnd(64, '0'), band, lastMonth() + '-10T00:00:00Z']);
    }
  }
  let modelVersionId: string;
  beforeEach(async () => {
    modelVersionId = randomUUID();
    await pool.query(`INSERT INTO readiness_model_versions (id,stable_key,version,policy,published_by_user_id,published_at,active)
      VALUES ($1,'career-readiness-fundamentals',1,'{}'::jsonb,$2,now(),true)`, [modelVersionId, admin.id]);
    await pool.query(`INSERT INTO release_manifests (id,name,version,manifest_hash,status)
      VALUES ('25000000-0000-4000-8000-000000000001','Local pilot release',1,$1,'DRAFT') ON CONFLICT DO NOTHING`, ['a'.repeat(64)]);
  });

  it('is the institution report as a file: bands only, cells under 5 as <5, the total withheld when it would reveal one', async () => {
    await grant(admin); await grant(headA);
    const developing: Student[] = [];
    for (let index = 0; index < 6; index += 1) developing.push(await student('ME-' + index, 'Mechanical ' + index, departmentA));
    const progressing = [await student('CE-1', 'Civil 1', departmentB), await student('CE-2', 'Civil 2', departmentB)];
    await readiness(developing, 'DEVELOPING');
    await readiness(progressing, 'PROGRESSING');
    const response = await api().post(base() + '/exports/readiness-bands').set(auth(admin.id)).send({ reasonCode: 'ACCREDITATION_PREPARATION', month: lastMonth() }).expect(200);
    expect(response.headers['content-disposition']).toBe(`attachment; filename="one-readiness-bands-${lastMonth()}.csv"`);
    expect(parseCsv(response.text)).toEqual([
      ['Month', 'Readiness band', 'Students'],
      [lastMonth(), 'Not enough evidence', '<5'],
      [lastMonth(), 'Developing', '6'],
      [lastMonth(), 'Progressing', '<5'],
      [lastMonth(), 'Ready for next step', '<5'],
      [lastMonth(), 'All students with readiness records', 'Withheld'],
    ]);
    const screen = await api().post(base() + '/career-readiness/reports?periodStart=' + lastMonth() + '-01&periodEnd=' + new Date(Date.UTC(Number(lastMonth().slice(0, 4)), Number(lastMonth().slice(5, 7)), 0)).toISOString().slice(0, 10)).set(auth(admin.id)).expect(201);
    expect(screen.body.aggregate.bands.find((entry: { band: string }) => entry.band === 'DEVELOPING').count).toBe(6);

    // A department head's file is their department's table only — never a breakdown beside the college's.
    const scoped = parseCsv((await api().post(base() + '/exports/readiness-bands').set(auth(headA.id)).send({ reasonCode: 'DEPARTMENT_REVIEW', month: lastMonth() }).expect(200)).text);
    expect(scoped.map((row) => row[2])).toEqual(['Students', '<5', '6', '<5', '<5', 'Withheld']);
    const trail = await audits('institution.readiness_bands.exported');
    expect(trail.map((row) => [row.actor_user_id, row.context.month, row.context.reasonCode])).toEqual([[admin.id, lastMonth(), 'ACCREDITATION_PREPARATION'], [headA.id, lastMonth(), 'DEPARTMENT_REVIEW']]);
    expect(trail[0]!.context.reportId).toMatch(uuidText);
  });

  it('withholds everything for a cohort under 5', async () => {
    await grant(admin);
    await readiness([await student('ME-1', 'One', departmentA), await student('ME-2', 'Two', departmentA)], 'DEVELOPING');
    const rows = parseCsv((await api().post(base() + '/exports/readiness-bands').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', month: lastMonth() }).expect(200)).text);
    expect(rows.slice(1).map((row) => row[2])).toEqual(['<5', '<5', '<5', '<5', '<5']);
  });

  it('covers only one whole calendar month that has ended, and records nothing otherwise', async () => {
    await grant(admin);
    for (const month of [thisMonth(), '2999-01', '2026-13', 'last month', undefined]) {
      const refused = await api().post(base() + '/exports/readiness-bands').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', ...(month ? { month } : {}) }).expect(400);
      expect(refused.body.error.code).toBe('REPORT_PERIOD_INVALID');
    }
    expect(await audits('institution.readiness_bands.exported')).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_aggregate_reports')).rows[0].n).toBe(0);
  });
});

describe('assessment results export', () => {
  it('writes one grade sheet for in-scope students, with not-attempted rows and no identifiers', async () => {
    await grant(admin); await grant(headA);
    const inA = await student('ME-001', 'Asha Rao', departmentA);
    const pendingA = await student('ME-002', 'Ravi Kumar', departmentA);
    const inB = await student('CE-001', 'Civil Student', departmentB);
    const subject = randomUUID(); const definition = randomUUID();
    await pool.query("INSERT INTO exam_subjects (id,institution_id,name) VALUES ($1,$2,'Aptitude')", [subject, institutionId]);
    await pool.query(`INSERT INTO exam_definitions (id,institution_id,subject_id,title,exam_kind,lifecycle_state,total_marks,duration_seconds,
        starts_at,ends_at,publish_results_immediately,created_by_user_id,published_at)
      VALUES ($1,$2,$3,'Unit test 1','UNIT_TEST','PUBLISHED',10,1800,now()-interval '1 hour',now()+interval '1 hour',true,$4,now())`, [definition, institutionId, subject, admin.id]);
    for (const learner of [inA, pendingA, inB]) {
      await pool.query('INSERT INTO exam_assignments (id,institution_id,definition_id,student_user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), institutionId, definition, learner.userId, admin.id]);
    }
    for (const [learner, score] of [[inA, 7], [inB, 9]] as const) {
      const attempt = randomUUID();
      await pool.query(`INSERT INTO exam_attempts (id,institution_id,definition_id,student_user_id,attempt_number,status,paper_seed,submitted_at)
        VALUES ($1,$2,$3,$4,1,'SUBMITTED',$5,now())`, [attempt, institutionId, definition, learner.userId, randomUUID()]);
      await pool.query(`INSERT INTO exam_results (id,attempt_id,score,max_score,percentage,correct_count,wrong_count,not_attempted_count,time_taken_seconds,published)
        VALUES ($1,$2,$3,10,$4,$5,0,$6,600,true)`, [randomUUID(), attempt, score, score * 10, score, 10 - score]);
    }
    const response = await api().post(base() + '/exports/assessment-results').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', assessmentId: definition }).expect(200);
    const rows = parseCsv(response.text);
    expect(rows[0]).toEqual(['Assessment', 'Student ID', 'Full name', 'Attempt', 'Status', 'Auto-submitted', 'Score', 'Maximum score', 'Percentage', 'Correct', 'Wrong', 'Not attempted', 'Time taken (seconds)', 'Completed at']);
    expect(rows.slice(1).map((row) => row.slice(0, 9))).toEqual([
      ['Unit test 1', 'CE-001', 'Civil Student', '1', 'SUBMITTED', 'No', '9', '10', '90'],
      ['Unit test 1', 'ME-001', 'Asha Rao', '1', 'SUBMITTED', 'No', '7', '10', '70'],
      ['Unit test 1', 'ME-002', 'Ravi Kumar', '', 'NOT_ATTEMPTED', '', '', '', ''],
    ]);
    expect(response.text).not.toMatch(uuidText);
    const scoped = parseCsv((await api().post(base() + '/exports/assessment-results').set(auth(headA.id)).send({ reasonCode: 'DEPARTMENT_REVIEW', assessmentId: definition }).expect(200)).text);
    expect(scoped.slice(1).map((row) => row[1])).toEqual(['ME-001', 'ME-002']);
    const trail = await audits('institution.assessment_results.exported');
    expect(trail.map((row) => [row.actor_user_id, row.context.assessmentId, row.context.rowCount])).toEqual([[admin.id, definition, 3], [headA.id, definition, 2]]);
  });

  it('refuses another institution\'s assessment', async () => {
    await grant(admin);
    const subject = randomUUID(); const definition = randomUUID();
    await pool.query("INSERT INTO exam_subjects (id,institution_id,name) VALUES ($1,$2,'Aptitude')", [subject, otherInstitutionId]);
    await pool.query(`INSERT INTO exam_definitions (id,institution_id,subject_id,title,exam_kind,lifecycle_state,total_marks,duration_seconds,
        starts_at,ends_at,publish_results_immediately,created_by_user_id,published_at)
      VALUES ($1,$2,$3,'Elsewhere','UNIT_TEST','PUBLISHED',10,1800,now()-interval '1 hour',now()+interval '1 hour',true,$4,now())`, [definition, otherInstitutionId, subject, otherAdmin.id]);
    await api().post(base() + '/exports/assessment-results').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', assessmentId: definition }).expect(404);
  });
});

describe('staff-action summary export', () => {
  async function action(learner: Student, type: string, actor: Staff, createdAt: string) {
    await pool.query(`INSERT INTO staff_actions (id,institution_id,subject_student_user_id,institution_relationship_id,actor_user_id,actor_membership_id,assigned_to_membership_id,
        action_type,state,title,note,created_at,updated_at,updated_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'OPEN','Private title about the student','Private note about the student',$8,$8,$5)`,
    [randomUUID(), institutionId, learner.userId, learner.relationshipId, actor.id, actor.membershipId, type, createdAt]);
  }

  it('counts students and actions opened in the month, each cell under 5 as <5, with no text and no totals', async () => {
    await grant(admin);
    const inMonth = lastMonth() + '-15T09:00:00Z';
    const learners: Student[] = [];
    for (let index = 0; index < 6; index += 1) learners.push(await student('ME-' + index, 'Mechanical ' + index, departmentA));
    for (const learner of learners) await action(learner, 'INTERVENTION', faculty, inMonth);
    await action(learners[0]!, 'INTERVENTION', faculty, inMonth);
    await action(learners[0]!, 'ASSIGNED_TASK', faculty, inMonth);
    await action(learners[1]!, 'INTERVENTION', faculty, new Date().toISOString()); // this month: not in the file
    const response = await api().post(base() + '/exports/staff-action-summary').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', month: lastMonth() }).expect(200);
    expect(parseCsv(response.text)).toEqual([
      ['Month', 'Action type', 'Students with at least one', 'Actions opened'],
      [lastMonth(), 'Intervention', '6', '7'],
      [lastMonth(), 'Assigned task', '<5', '<5'],
      [lastMonth(), 'Faculty note', '<5', '<5'],
      [lastMonth(), 'Academic verification', '<5', '<5'],
      [lastMonth(), 'Meeting', '<5', '<5'],
    ]);
    expect(response.text).not.toContain('Private');
    expect(response.text).not.toMatch(uuidText);
    await api().post(base() + '/exports/staff-action-summary').set(auth(admin.id)).send({ reasonCode: 'MANAGEMENT_REPORTING', month: thisMonth() }).expect(400);
  });

  it('counts only the department head\'s department', async () => {
    await grant(headA);
    const inMonth = lastMonth() + '-15T09:00:00Z';
    for (let index = 0; index < 5; index += 1) await action(await student('CE-' + index, 'Civil ' + index, departmentB), 'INTERVENTION', faculty, inMonth);
    const rows = parseCsv((await api().post(base() + '/exports/staff-action-summary').set(auth(headA.id)).send({ reasonCode: 'DEPARTMENT_REVIEW', month: lastMonth() }).expect(200)).text);
    expect(rows[1]).toEqual([lastMonth(), 'Intervention', '<5', '<5']);
  });
});

describe('export contract', () => {
  it('no export carries a compensation field or an internal identifier', async () => {
    await grant(admin);
    await student('ME-001', 'Asha Rao', departmentA);
    for (const path of ['roster', 'staff-action-summary']) {
      const text = (await api().post(base() + '/exports/' + path).set(auth(admin.id)).send(validBody(path)).expect(200)).text;
      const header = parseCsv(text)[0]!.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
      for (const field of institutionForbiddenDisclosureFields) expect(header).not.toContain(field);
      expect(header.some((cell) => cell.includes('compensation') || cell.includes('salary') || cell.includes('readiness_score'))).toBe(false);
      expect(text).not.toMatch(uuidText);
    }
  });
});
