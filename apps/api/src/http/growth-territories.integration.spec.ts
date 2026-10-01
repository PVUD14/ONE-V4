/**
 * Growth territories and regions (GROWTH-02, design §4; growth-territories-table-design.md).
 *
 * The acceptance criteria this file carries:
 *  - one area lives in at most one region (unique indexes, API and database);
 *  - a whole-state area and a district area of the same state cannot be live in different
 *    regions (trigger, API and database, either way round, and under a concurrent race);
 *  - visibility follows today's assignment (the Growth territory read, and the SQL scope
 *    predicate checked row for row against the pure function);
 *  - every assignment change is audited with its reason.
 * Also: the 36 seeded states, the LGD district import (dry run writes nothing; commit writes
 * exactly what was previewed; renames audited; a district never changes state), and 403 for
 * every caller without GROWTH_ADMIN.
 *
 * Real Postgres in a private schema. No fixed calendar dates.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { growthScopePredicate, loadGrowthScope } from '@planthepath/persistence/src/growth-territories.js';
import { isVisibleInGrowthScope, regionsCoveringArea, type GrowthRegionArea } from '@planthepath/authorization/src/index.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for growth territory tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Growth territory tests require local Postgres');
const schemaName = 'growth_terr_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

const identities = new Map<string, { readonly email: string }>();
let app: INestApplication;
let platformId: string;
let superAdmin: Person;
let growthAdmin: Person;

interface Person { readonly userId: string; readonly membershipId: string; readonly email: string }

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
        const identity = identities.get(token);
        if (!identity) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access',
          issuedAt: 0, expiresAt: 4_000_000_000, scopes: [], email: identity.email, emailVerified: true };
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

  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state) VALUES ($1,'PLATFORM','ONE platform','VERIFIED')", [platformId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  growthAdmin = await member('OPERATIONS_ADMIN');
  await grant(growthAdmin, 'GROWTH_ADMIN');
  await importDistricts([
    ['IN-KA', 555, 'Bengaluru Urban'], ['IN-KA', 556, 'Mysuru'],
    ['IN-TN', 603, 'Chennai'], ['IN-TN', 610, 'Madurai'], ['IN-TN', 611, 'Theni'],
    ['IN-MH', 700, 'Pune'],
  ]);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

async function member(role: string, state = 'ACTIVE', userId = randomUUID()): Promise<Person> {
  const membershipId = randomUUID();
  const email = 'person-' + userId.slice(0, 8) + '@example.test';
  if (!identities.has(userId)) {
    identities.set(userId, { email });
    await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  }
  await pool.query(
    "INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,$5,$2)",
    [membershipId, platformId, userId, role, state],
  );
  return { userId, membershipId, email: identities.get(userId)!.email };
}

async function grant(person: Person, capability: string): Promise<void> {
  await pool.query(
    "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
    [randomUUID(), person.membershipId, capability, superAdmin.userId],
  );
}

const api = () => request(app.getHttpServer());
const auth = (subject: string) => ({ Authorization: 'Bearer ' + subject, 'X-Correlation-Id': 'growth-terr-' + randomUUID() });
const base = '/api/v1/operations/growth-territories';

function csv(rows: readonly (readonly [string, number, string])[], header = 'State Name (In English),District Code,District Name (In English)'): string {
  const names: Record<string, string> = { 'IN-KA': 'Karnataka', 'IN-TN': 'Tamil Nadu', 'IN-MH': 'Maharashtra' };
  return [header, ...rows.map(([state, code, name]) => `${names[state] ?? state},${code},"${name}"`)].join('\n');
}

async function importDistricts(rows: readonly (readonly [string, number, string])[]): Promise<void> {
  const content = csv(rows);
  const preview = await api().post(`${base}/district-imports/preview`).set(auth(growthAdmin.userId)).send({ filename: 'lgd.csv', content }).expect(201);
  expect(preview.body.preview.committable).toBe(true);
  await api().post(`${base}/district-imports/commit`).set(auth(growthAdmin.userId))
    .send({ filename: 'lgd.csv', content, previewDigest: preview.body.preview.digest, reasonCode: 'INITIAL_IMPORT' }).expect(201);
}

async function region(name = 'Region ' + randomUUID().slice(0, 8)): Promise<string> {
  const response = await api().post(`${base}/regions`).set(auth(growthAdmin.userId)).send({ name, reasonCode: 'NEW_REGION' }).expect(201);
  return response.body.region.id as string;
}

function addArea(regionId: string, stateCode: string, districtCode: number | null) {
  return api().post(`${base}/regions/${regionId}/areas`).set(auth(growthAdmin.userId)).send({ stateCode, districtCode, reasonCode: 'NEW_COVERAGE' });
}

function assign(regionId: string, person: Person, role: 'EXECUTIVE' | 'MANAGER', by = growthAdmin) {
  return api().post(`${base}/regions/${regionId}/assignments`).set(auth(by.userId)).send({ membershipId: person.membershipId, role, reasonCode: 'NEW_ASSIGNMENT' });
}

/** Removes every live area of a state so a test starts from a clean state. */
async function clearState(stateCode: string): Promise<void> {
  await pool.query(
    "UPDATE growth_region_areas SET removed_at=now(), removed_by_user_id=$2, removed_reason_code='CORRECTION' WHERE state_code=$1 AND removed_at IS NULL",
    [stateCode, growthAdmin.userId],
  );
}

describe('who may set up territory', () => {
  it('answers 403 to a growth person, an operations admin without GROWTH_ADMIN and a security admin', async () => {
    const callers = [await member('GROWTH_EXECUTIVE'), await member('GROWTH_MANAGER'), await member('OPERATIONS_ADMIN'), await member('SECURITY_ADMIN')];
    for (const caller of callers) {
      await api().get(base).set(auth(caller.userId)).expect(403);
      await api().post(`${base}/regions`).set(auth(caller.userId)).send({ name: 'Nope', reasonCode: 'NEW_REGION' }).expect(403);
      await api().post(`${base}/district-imports/preview`).set(auth(caller.userId)).send({ content: 'x' }).expect(403);
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM growth_regions WHERE name='Nope'")).rows[0].n).toBe(0);
  });

  it('admits the super admin by baseline and a GROWTH_ADMIN holder', async () => {
    await api().get(base).set(auth(superAdmin.userId)).expect(200);
    const overview = await api().get(base).set(auth(growthAdmin.userId)).expect(200);
    expect(overview.body.states).toHaveLength(36);
    expect(overview.body.states.find((state: { code: string }) => state.code === 'IN-TN')).toMatchObject({ name: 'Tamil Nadu', kind: 'STATE', districtCount: 3 });
    expect(overview.body.states.find((state: { code: string }) => state.code === 'IN-LA')).toMatchObject({ kind: 'UNION_TERRITORY', districtCount: 0 });
    expect(JSON.stringify(overview.body)).not.toMatch(/paise|amount|student/i);
  });
});

describe('the seeded states', () => {
  it('holds exactly the 36 ISO 3166-2:IN subdivisions, which nobody can delete', async () => {
    const states = (await pool.query('SELECT kind, count(*)::int AS n FROM growth_states GROUP BY kind ORDER BY kind')).rows;
    expect(states).toEqual([{ kind: 'STATE', n: 28 }, { kind: 'UNION_TERRITORY', n: 8 }]);
    await expect(pool.query("DELETE FROM growth_states WHERE code='IN-LD'")).rejects.toThrow(/never deleted/);
  });
});

describe('the LGD district import', () => {
  it('previews without writing, and reports each row', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM growth_districts')).rows[0].n;
    const content = csv([['IN-KA', 557, 'Mandya'], ['IN-KA', 556, 'Mysore'], ['IN-TN', 603, 'Chennai'], ['Atlantis', 900, 'Nowhere'], ['IN-MH', 555, 'Moved']]);
    const preview = await api().post(`${base}/district-imports/preview`).set(auth(growthAdmin.userId)).send({ content }).expect(201);
    expect(preview.body.preview.rows.map((row: { status: string; issues: string[] }) => [row.status, row.issues])).toEqual([
      ['NEW', []], ['RENAMED', []], ['UNCHANGED', []], ['ERROR', ['STATE_UNKNOWN']], ['ERROR', ['DISTRICT_STATE_MISMATCH']],
    ]);
    expect(preview.body.preview.committable).toBe(false);
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_districts')).rows[0].n).toBe(before);
    // A file with an error row is refused whole.
    await api().post(`${base}/district-imports/commit`).set(auth(growthAdmin.userId))
      .send({ content, previewDigest: preview.body.preview.digest, reasonCode: 'LGD_UPDATE' }).expect(400)
      .expect((response) => expect(response.body.error.code).toBe('IMPORT_INVALID'));
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_districts')).rows[0].n).toBe(before);
  });

  it('commits exactly what was previewed, records renames in the audit, and refuses a stale digest', async () => {
    const content = csv([['IN-KA', 557, 'Mandya'], ['IN-KA', 556, 'Mysore']]);
    const preview = await api().post(`${base}/district-imports/preview`).set(auth(growthAdmin.userId)).send({ filename: 'lgd-update.csv', content }).expect(201);
    await api().post(`${base}/district-imports/commit`).set(auth(growthAdmin.userId))
      .send({ filename: 'lgd-update.csv', content, previewDigest: 'f'.repeat(64), reasonCode: 'LGD_UPDATE' }).expect(409)
      .expect((response) => expect(response.body.error.code).toBe('IMPORT_STALE'));
    const committed = await api().post(`${base}/district-imports/commit`).set(auth(growthAdmin.userId))
      .send({ filename: 'lgd-update.csv', content, previewDigest: preview.body.preview.digest, reasonCode: 'LGD_UPDATE' }).expect(201);
    expect(committed.body.import.counts).toEqual({ new: 1, unchanged: 0, renamed: 1, errors: 0 });
    expect((await pool.query('SELECT name, renamed_import_id FROM growth_districts WHERE lgd_code=556')).rows[0])
      .toEqual({ name: 'Mysore', renamed_import_id: committed.body.import.id });
    const audit = (await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='operations.growth_districts.imported' AND resource_id=$1", [committed.body.import.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(growthAdmin.userId);
    expect(audit[0].context).toMatchObject({ reasonCode: 'LGD_UPDATE', renamed: [{ code: 556, from: 'Mysuru', to: 'Mysore' }] });
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='growth.districts.imported' AND aggregate_id=$1", [committed.body.import.id])).rows[0].n).toBe(1);
    // The same file again is all UNCHANGED: a new digest, nothing to change.
    const again = await api().post(`${base}/district-imports/preview`).set(auth(growthAdmin.userId)).send({ content }).expect(201);
    expect(again.body.preview.counts).toEqual({ new: 0, unchanged: 2, renamed: 0, errors: 0 });
  });

  it('matches LGD headers and state names loosely but never guesses an unknown state', async () => {
    const content = 'state code,district lgd code,district name\nIN-DL,800,New Delhi\n"",801,Nowhere\n';
    const preview = await api().post(`${base}/district-imports/preview`).set(auth(growthAdmin.userId)).send({ content }).expect(201);
    expect(preview.body.preview.rows.map((row: { stateCode: string | null; status: string }) => [row.stateCode, row.status])).toEqual([['IN-DL', 'NEW'], [null, 'ERROR']]);
    const missing = await api().post(`${base}/district-imports/preview`).set(auth(growthAdmin.userId)).send({ content: 'name,code\nx,1' }).expect(201);
    expect(missing.body.preview.fileProblems).toEqual(expect.arrayContaining(['IMPORT_COLUMN_MISSING:district_code']));
  });

  it('never lets a district be deleted or change state', async () => {
    await expect(pool.query('DELETE FROM growth_districts WHERE lgd_code=555')).rejects.toThrow(/never deleted/);
    await expect(pool.query("UPDATE growth_districts SET state_code='IN-MH' WHERE lgd_code=555")).rejects.toThrow(/only be renamed/);
    await expect(pool.query("UPDATE growth_district_imports SET reason_code='CORRECTION'")).rejects.toThrow(/append-only/);
  });
});

describe('regions', () => {
  it('refuses a duplicate live name, retires only an unused region, and takes nothing once retired', async () => {
    const name = 'North-' + randomUUID().slice(0, 6);
    const id = await region(name);
    await api().post(`${base}/regions`).set(auth(growthAdmin.userId)).send({ name: name.toLowerCase(), reasonCode: 'NEW_REGION' }).expect(409)
      .expect((response) => expect(response.body.error.code).toBe('GROWTH_REGION_NAME_TAKEN'));
    await api().post(`${base}/regions`).set(auth(growthAdmin.userId)).send({ name: '<script>', reasonCode: 'NEW_REGION' }).expect(400);
    await clearState('IN-MH');
    await addArea(id, 'IN-MH', null).expect(201);
    await api().post(`${base}/regions/${id}/retire`).set(auth(growthAdmin.userId)).send({ reasonCode: 'NO_LONGER_WORKED' }).expect(409)
      .expect((response) => expect(response.body.error.code).toBe('GROWTH_REGION_IN_USE'));
    await clearState('IN-MH');
    await api().post(`${base}/regions/${id}/retire`).set(auth(growthAdmin.userId)).send({ reasonCode: 'NO_LONGER_WORKED' }).expect(201);
    await addArea(id, 'IN-MH', null).expect(409).expect((response) => expect(response.body.error.code).toBe('GROWTH_REGION_RETIRED'));
    // The name is free again once the region is retired.
    await region(name);
    await expect(pool.query("UPDATE growth_regions SET name='Renamed' WHERE id=$1", [id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM growth_regions WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
  });
});

describe('areas: one live region per area, and no whole state split from its districts', () => {
  it('refuses the same state or district in a second live region, by API and by database', async () => {
    await clearState('IN-KA');
    const south = await region();
    const other = await region();
    await addArea(south, 'IN-KA', null).expect(201);
    await addArea(other, 'IN-KA', null).expect(409).expect((response) => expect(response.body.error.code).toBe('GROWTH_AREA_TAKEN'));
    await expect(pool.query(
      "INSERT INTO growth_region_areas (id,region_id,state_code,added_by_user_id,reason_code) VALUES ($1,$2,'IN-KA',$3,'NEW_COVERAGE')",
      [randomUUID(), other, growthAdmin.userId],
    )).rejects.toThrow(/growth_region_areas_live_state_uq/);

    await clearState('IN-TN');
    await addArea(south, 'IN-TN', 603).expect(201);
    await addArea(other, 'IN-TN', 603).expect(409).expect((response) => expect(response.body.error.code).toBe('GROWTH_AREA_TAKEN'));
    await expect(pool.query(
      "INSERT INTO growth_region_areas (id,region_id,state_code,district_code,added_by_user_id,reason_code) VALUES ($1,$2,'IN-TN',603,$3,'NEW_COVERAGE')",
      [randomUUID(), other, growthAdmin.userId],
    )).rejects.toThrow(/growth_region_areas_live_district_uq/);
    // Another district of the same state can go to another region.
    await addArea(other, 'IN-TN', 610).expect(201);
  });

  it('refuses a whole state and a district of it in different regions, either way round, by API and by database', async () => {
    await clearState('IN-KA');
    await clearState('IN-TN');
    const a = await region();
    const b = await region();
    await addArea(a, 'IN-KA', null).expect(201);
    await addArea(b, 'IN-KA', 556).expect(409).expect((response) => expect(response.body.error.code).toBe('GROWTH_AREA_CONFLICT'));
    await expect(pool.query(
      "INSERT INTO growth_region_areas (id,region_id,state_code,district_code,added_by_user_id,reason_code) VALUES ($1,$2,'IN-KA',556,$3,'NEW_COVERAGE')",
      [randomUUID(), b, growthAdmin.userId],
    )).rejects.toThrow(/growth area conflict: the whole state is live in another region/);

    await addArea(a, 'IN-TN', 610).expect(201);
    await addArea(b, 'IN-TN', null).expect(409).expect((response) => expect(response.body.error.code).toBe('GROWTH_AREA_CONFLICT'));
    await expect(pool.query(
      "INSERT INTO growth_region_areas (id,region_id,state_code,added_by_user_id,reason_code) VALUES ($1,$2,'IN-TN',$3,'NEW_COVERAGE')",
      [randomUUID(), b, growthAdmin.userId],
    )).rejects.toThrow(/growth area conflict: a district of this state is live in another region/);
  });

  it('refuses the same combination inside one region as redundant', async () => {
    await clearState('IN-KA');
    const a = await region();
    await addArea(a, 'IN-KA', null).expect(201);
    await addArea(a, 'IN-KA', 555).expect(409).expect((response) => expect(response.body.error.code).toBe('GROWTH_AREA_REDUNDANT'));
    await expect(pool.query(
      "INSERT INTO growth_region_areas (id,region_id,state_code,district_code,added_by_user_id,reason_code) VALUES ($1,$2,'IN-KA',555,$3,'NEW_COVERAGE')",
      [randomUUID(), a, growthAdmin.userId],
    )).rejects.toThrow(/growth area redundant/);
  });

  it('lets only one of a concurrent whole-state and district insert into different regions succeed', async () => {
    await clearState('IN-TN');
    const a = await region();
    const b = await region();
    const insert = async (regionId: string, district: number | null) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO growth_region_areas (id,region_id,state_code,district_code,added_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,$6)',
          [randomUUID(), regionId, 'IN-TN', district, growthAdmin.userId, 'NEW_COVERAGE'],
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await client.query('COMMIT');
        return 'ok';
      } catch {
        await client.query('ROLLBACK');
        return 'refused';
      } finally {
        client.release();
      }
    };
    const results = await Promise.all([insert(a, null), insert(b, 611)]);
    expect(results.sort()).toEqual(['ok', 'refused']);
    const live = (await pool.query("SELECT count(DISTINCT region_id)::int AS n FROM growth_region_areas WHERE state_code='IN-TN' AND removed_at IS NULL")).rows[0].n;
    expect(live).toBe(1);
  });

  it('frees an area once it is removed, keeps the removed row, and refuses any other change', async () => {
    await clearState('IN-MH');
    const a = await region();
    const b = await region();
    const added = await addArea(a, 'IN-MH', 700).expect(201);
    const areaId = added.body.area.id as string;
    await api().post(`${base}/regions/${a}/areas/${areaId}/remove`).set(auth(growthAdmin.userId)).send({ reasonCode: 'TERRITORY_CHANGE' }).expect(201);
    await api().post(`${base}/regions/${a}/areas/${areaId}/remove`).set(auth(growthAdmin.userId)).send({ reasonCode: 'TERRITORY_CHANGE' }).expect(409);
    await addArea(b, 'IN-MH', 700).expect(201);
    const history = (await pool.query("SELECT region_id, removed_reason_code FROM growth_region_areas WHERE district_code=700 ORDER BY added_at")).rows;
    expect(history).toEqual([{ region_id: a, removed_reason_code: 'TERRITORY_CHANGE' }, { region_id: b, removed_reason_code: null }]);
    await expect(pool.query('UPDATE growth_region_areas SET region_id=$2 WHERE id=$1', [areaId, b])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM growth_region_areas WHERE id=$1', [areaId])).rejects.toThrow(/never deleted/);
    await addArea(b, 'IN-KA', 999).expect(404);
    await addArea(b, 'IN-MH', 555).expect(400).expect((response) => expect(response.body.error.code).toBe('GROWTH_DISTRICT_STATE_MISMATCH'));
  });
});

describe('territory assignments', () => {
  it('audits every assignment change with its reason, and refuses mismatched roles, self-assignment and inactive people', async () => {
    const r = await region();
    const executive = await member('GROWTH_EXECUTIVE');
    const manager = await member('GROWTH_MANAGER');
    await assign(r, executive, 'MANAGER').expect(400).expect((response) => expect(response.body.error.code).toBe('GROWTH_ASSIGNMENT_ROLE_MISMATCH'));
    const started = await assign(r, executive, 'EXECUTIVE').expect(201);
    await assign(r, executive, 'EXECUTIVE').expect(409);
    await assign(r, manager, 'MANAGER').expect(201);
    const assignmentId = started.body.assignment.id as string;
    const startAudit = (await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='growth.territory_assignment.started' AND resource_id=$1", [assignmentId])).rows;
    expect(startAudit).toEqual([{ actor_user_id: growthAdmin.userId, context: expect.objectContaining({ regionId: r, role: 'EXECUTIVE', reasonCode: 'NEW_ASSIGNMENT' }) }]);
    await api().post(`${base}/regions/${r}/assignments/${assignmentId}/end`).set(auth(growthAdmin.userId)).send({ reasonCode: 'NOPE' }).expect(400);
    await api().post(`${base}/regions/${r}/assignments/${assignmentId}/end`).set(auth(growthAdmin.userId)).send({ reasonCode: 'WORKLOAD' }).expect(201);
    const endAudit = (await pool.query("SELECT context FROM audit_events WHERE action='growth.territory_assignment.ended' AND resource_id=$1", [assignmentId])).rows;
    expect(endAudit).toEqual([{ context: expect.objectContaining({ reasonCode: 'WORKLOAD', membershipId: executive.membershipId }) }]);
    expect((await pool.query('SELECT ended_reason_code, ended_by_user_id FROM growth_territory_assignments WHERE id=$1', [assignmentId])).rows[0])
      .toEqual({ ended_reason_code: 'WORKLOAD', ended_by_user_id: growthAdmin.userId });
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1 AND event_type LIKE 'growth.territory_assignment.%'", [assignmentId])).rows[0].n).toBe(2);

    // An operator who also holds a growth membership cannot assign their own territory.
    const dual = await member('GROWTH_EXECUTIVE', 'ACTIVE', growthAdmin.userId);
    await assign(r, dual, 'EXECUTIVE').expect(403);
    await expect(pool.query(
      "INSERT INTO growth_territory_assignments (id,region_id,membership_id,assignment_role,assigned_by_user_id,reason_code) VALUES ($1,$2,$3,'EXECUTIVE',$4,'NEW_ASSIGNMENT')",
      [randomUUID(), r, dual.membershipId, growthAdmin.userId],
    )).rejects.toThrow(/may not assign their own territory/);
    const suspended = await member('GROWTH_EXECUTIVE', 'SUSPENDED');
    await assign(r, suspended, 'EXECUTIVE').expect(409);
    const operator = await member('OPERATIONS_ADMIN');
    await api().post(`${base}/regions/${r}/assignments`).set(auth(growthAdmin.userId)).send({ membershipId: operator.membershipId, role: 'EXECUTIVE', reasonCode: 'NEW_ASSIGNMENT' }).expect(400);
  });

  it('ends a membership\'s assignments when it ends, keeps them through a suspension, and blocks a role change', async () => {
    const r = await region();
    const executive = await member('GROWTH_EXECUTIVE');
    await assign(r, executive, 'EXECUTIVE').expect(201);
    await expect(pool.query("UPDATE organization_memberships SET role='GROWTH_MANAGER' WHERE id=$1", [executive.membershipId])).rejects.toThrow(/before changing the membership role/);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [executive.membershipId]);
    expect((await pool.query('SELECT ended_reason_code FROM growth_territory_assignments WHERE membership_id=$1', [executive.membershipId])).rows).toEqual([{ ended_reason_code: null }]);
    await pool.query("UPDATE organization_memberships SET state='ENDED' WHERE id=$1", [executive.membershipId]);
    expect((await pool.query('SELECT ended_reason_code, ended_by_user_id FROM growth_territory_assignments WHERE membership_id=$1', [executive.membershipId])).rows)
      .toEqual([{ ended_reason_code: 'MEMBERSHIP_ENDED', ended_by_user_id: null }]);
    await expect(pool.query('DELETE FROM growth_territory_assignments WHERE membership_id=$1', [executive.membershipId])).rejects.toThrow(/never deleted/);
  });
});

describe('visibility follows today\'s assignment', () => {
  it('shows an executive only the regions they work today, and their managers; a manager sees everyone assigned', async () => {
    await clearState('IN-KA');
    const r = await region('Karnataka-' + randomUUID().slice(0, 6));
    await addArea(r, 'IN-KA', null).expect(201);
    const executive = await member('GROWTH_EXECUTIVE');
    const peer = await member('GROWTH_EXECUTIVE');
    const manager = await member('GROWTH_MANAGER');
    await api().get('/api/v1/growth/territory').set(auth(executive.userId)).expect(200).expect((response) => expect(response.body.regions).toEqual([]));
    const started = await assign(r, executive, 'EXECUTIVE').expect(201);
    await assign(r, peer, 'EXECUTIVE').expect(201);
    await assign(r, manager, 'MANAGER').expect(201);

    const mine = await api().get('/api/v1/growth/territory').set(auth(executive.userId)).expect(200);
    expect(mine.body.regions).toHaveLength(1);
    expect(mine.body.regions[0]).toMatchObject({ id: r, myRole: 'EXECUTIVE', areas: [{ stateCode: 'IN-KA', stateName: 'Karnataka', districtCode: null, districtName: null }] });
    expect(mine.body.regions[0].people).toEqual([{ email: manager.email, role: 'MANAGER', since: expect.any(String) }]);
    const managed = await api().get('/api/v1/growth/territory').set(auth(manager.userId)).expect(200);
    expect(managed.body.regions[0].myRole).toBe('MANAGER');
    expect(managed.body.regions[0].people.map((person: { email: string }) => person.email).sort()).toEqual([executive.email, peer.email].sort());

    await api().post(`${base}/regions/${r}/assignments/${started.body.assignment.id}/end`).set(auth(growthAdmin.userId)).send({ reasonCode: 'TERRITORY_CHANGE' }).expect(201);
    await api().get('/api/v1/growth/territory').set(auth(executive.userId)).expect(200).expect((response) => expect(response.body.regions).toEqual([]));
    // A suspended growth person reaches nothing.
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [peer.membershipId]);
    await api().get('/api/v1/growth/territory').set(auth(peer.userId)).expect(403);
    // An operator is not a growth person here, even with GROWTH_ADMIN.
    const operator = await member('OPERATIONS_ADMIN');
    await grant(operator, 'GROWTH_ADMIN');
    await api().get('/api/v1/growth/territory').set(auth(operator.userId)).expect(403);
  });

  it('builds a SQL predicate that agrees row for row with the pure scope rule', async () => {
    await clearState('IN-TN');
    const north = await region();
    const south = await region();
    await addArea(north, 'IN-TN', 603).expect(201);
    await addArea(south, 'IN-TN', 610).expect(201);
    const executive = await member('GROWTH_EXECUTIVE');
    const report = await member('GROWTH_EXECUTIVE');
    const peer = await member('GROWTH_EXECUTIVE');
    const manager = await member('GROWTH_MANAGER');
    await assign(north, executive, 'EXECUTIVE').expect(201);
    await assign(south, manager, 'MANAGER').expect(201);
    await pool.query(
      "INSERT INTO growth_team_members (id,membership_id,team,manager_membership_id,joined_by_user_id,reason_code) VALUES ($1,$2,'COLLEGE_PARTNERSHIPS',$3,$4,'NEW_MEMBER')",
      [randomUUID(), report.membershipId, manager.membershipId, growthAdmin.userId],
    );

    const table = 'scope_probe_' + randomUUID().replaceAll('-', '').slice(0, 8);
    await pool.query(`CREATE TABLE ${table} (id int PRIMARY KEY, owner_membership_id uuid, state_code text, district_code int)`);
    const records = [
      [1, executive.membershipId, 'IN-TN', 610], [2, null, 'IN-TN', 603], [3, null, 'IN-TN', 610], [4, peer.membershipId, 'IN-TN', 603],
      [5, peer.membershipId, 'IN-TN', 610], [6, report.membershipId, 'IN-KA', 555], [7, null, 'IN-TN', null], [8, null, null, null],
      [9, executive.membershipId, null, null], [10, null, 'IN-TN', 611],
    ] as const;
    for (const record of records) await pool.query(`INSERT INTO ${table} VALUES ($1,$2,$3,$4)`, record);
    const areas = (await pool.query('SELECT region_id, state_code, district_code FROM growth_region_areas WHERE removed_at IS NULL')).rows
      .map((row): GrowthRegionArea => ({ regionId: row.region_id, stateCode: row.state_code, districtCode: row.district_code }));

    for (const person of [executive, manager, peer]) {
      const scope = await loadGrowthScope(db, { userId: person.userId, growthAdmin: false });
      const visible = await db.execute(sql`SELECT id FROM ${sql.raw(table)} p WHERE ${growthScopePredicate(scope, 'p')} ORDER BY id`) as unknown as { rows: { id: number }[] };
      const expected = records.filter(([, owner, state, district]) => isVisibleInGrowthScope(scope, {
        ownerMembershipId: owner, regionIds: regionsCoveringArea({ stateCode: state, districtCode: district }, areas),
      })).map(([id]) => id);
      expect(visible.rows.map((row) => row.id), person.email).toEqual(expected);
    }
    // The cases spelled out for the executive (north: district 603) and the manager (south: 610, plus their report).
    const executiveScope = await loadGrowthScope(db, { userId: executive.userId, growthAdmin: false });
    const seen = await db.execute(sql`SELECT id FROM ${sql.raw(table)} p WHERE ${growthScopePredicate(executiveScope, 'p')} ORDER BY id`) as unknown as { rows: { id: number }[] };
    expect(seen.rows.map((row) => row.id)).toEqual([1, 2, 9]);
    const managerScope = await loadGrowthScope(db, { userId: manager.userId, growthAdmin: false });
    const managerSeen = await db.execute(sql`SELECT id FROM ${sql.raw(table)} p WHERE ${growthScopePredicate(managerScope, 'p')} ORDER BY id`) as unknown as { rows: { id: number }[] };
    expect(managerSeen.rows.map((row) => row.id)).toEqual([1, 3, 5, 6]);
    expect(await loadGrowthScope(db, { userId: superAdmin.userId, growthAdmin: true })).toEqual({ kind: 'ALL' });
    expect(await loadGrowthScope(db, { userId: superAdmin.userId, growthAdmin: false })).toEqual({ kind: 'NONE' });
  });
});
