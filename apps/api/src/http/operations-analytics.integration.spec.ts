/**
 * The role demand dashboard over HTTP (OPS-11).
 *
 * Who may read it (ANALYTICS_VIEW), that every count of people below 5 is suppressed —
 * directly, by subtraction (complementary suppression) and by row order — that the
 * promotion indicator matches the documented rule, that deleted accounts and cleared
 * targets do not count, and that no student name, email or identifier leaves the server.
 *
 * Real Postgres in a throwaway schema, seeded with a known demand pattern.
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
if (!connectionString) throw new Error('DATABASE_URL is required for operations analytics tests');

const schemaName = 'ops_analytics_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
const colleges: Record<'A' | 'B' | 'C' | 'D', string> = { A: '', B: '', C: '', D: '' };
const roles: Record<'big' | 'twoColleges' | 'mid' | 'small' | 'starter', string> = { big: '', twoColleges: '', mid: '', small: '', starter: '' };
/** Every student id seeded; none may appear in any response. */
const studentIds: string[] = [];

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function member(role: string, state = 'ACTIVE'): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : colleges.A;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId };
}

async function college(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION',$2,'VERIFIED',true)", [id, name]);
  return id;
}

async function department(institutionId: string, name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT',$3)", [id, institutionId, name]);
  return id;
}

async function role(code: string, catalogueCode: string | null, title: string): Promise<string> {
  const id = randomUUID();
  if (catalogueCode) {
    await pool.query(
      `INSERT INTO career_roles (id, code, title, family, active, catalogue_code, catalogue_family, catalogue_title, release_label, planned_release, origin, catalogue_version)
       VALUES ($1,$2,$3,'Software',true,$4,'A',$3,'SELECTABLE','V3','CATALOGUE','catalogue-v1')`,
      [id, code, title, catalogueCode],
    );
  } else {
    await pool.query("INSERT INTO career_roles (id, code, title, family, active) VALUES ($1,$2,$3,'Software',true)", [id, code, title]);
  }
  return id;
}

/** `count` students targeting `roleId`, related to `institutionId` (or none), in `departmentId` (or none). */
async function students(count: number, roleId: string, institutionId: string | null, departmentId: string | null = null, options: { state?: string; cleared?: boolean; relationship?: string } = {}): Promise<void> {
  const ids = Array.from({ length: count }, () => randomUUID());
  studentIds.push(...ids);
  await pool.query(
    "INSERT INTO users (id,email,external_subject,state) SELECT id, 'student-private-' || id || '@college.test', id::text, $2::account_state FROM unnest($1::uuid[]) AS id",
    [ids, options.state ?? 'ACTIVE'],
  );
  if (institutionId) {
    await pool.query(
      `INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to)
       SELECT gen_random_uuid(), $2, id, $3::relationship_state, now() - interval '30 days',
              CASE WHEN $3 = 'GRADUATED' THEN now() - interval '1 day' END
       FROM unnest($1::uuid[]) AS id`,
      [ids, institutionId, options.relationship ?? 'ACTIVE'],
    );
    await pool.query(
      `INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,department_unit_id,status)
       SELECT gen_random_uuid(), $2, id, 'ROLL-' || id, 'student-private name', $3, 'ACTIVE' FROM unnest($1::uuid[]) AS id`,
      [ids, institutionId, departmentId],
    );
  }
  await pool.query(
    `INSERT INTO student_career_targets (id,student_user_id,career_role_id,priority,selected_at,cleared_at)
     SELECT gen_random_uuid(), id, $2, 'PRIMARY', now() - interval '1 day', CASE WHEN $3 THEN now() ELSE NULL END FROM unnest($1::uuid[]) AS id`,
    [ids, roleId, options.cleared === true],
  );
}

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db,
      ids: { uuid: () => randomUUID() },
      verifier: {
        async verifyAccessToken(token: string) {
          if (!tokens.has(token)) throw new Error('Invalid local test identity');
          return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
        },
      },
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
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  colleges.A = await college('Alpha Engineering College');
  colleges.B = await college('Beta Institute');
  colleges.C = await college('Gamma University');
  colleges.D = await college('Delta College');
  const cse = await department(colleges.A, 'Computer Science');
  const eee = await department(colleges.A, 'Electrical');
  const mech = await department(colleges.A, 'Mechanical');

  roles.big = await role('ROLE_BIG', 'S01', 'Software Developer');
  roles.twoColleges = await role('ROLE_TWO', 'S02', 'Web Developer');
  roles.mid = await role('ROLE_MID', 'D01', 'Data Analyst');
  roles.small = await role('ROLE_SMALL', 'C01', 'SOC Analyst L1');
  roles.starter = await role('ROLE_STARTER', null, 'Starter role');

  // 200 students across 3 colleges: meets the rule. College A splits 90 / 7 / 3 by department.
  await students(90, roles.big, colleges.A, cse);
  await students(7, roles.big, colleges.A, eee);
  await students(3, roles.big, colleges.A, mech);
  await students(60, roles.big, colleges.B);
  await students(40, roles.big, colleges.C);
  // 200 students in only 2 colleges: not met.
  await students(195, roles.twoColleges, colleges.A, cse);
  await students(5, roles.twoColleges, colleges.B);
  // 8 students: 5 at A, 2 at D, 1 with no college. A would reveal D + none by subtraction.
  await students(5, roles.mid, colleges.A, cse);
  await students(2, roles.mid, colleges.D);
  await students(1, roles.mid, null);
  // Never counted: a deleted account, a pending deletion, a cleared target.
  await students(3, roles.mid, colleges.D, null, { state: 'DELETED' });
  await students(2, roles.mid, colleges.D, null, { state: 'DELETION_PENDING' });
  await students(4, roles.mid, colleges.D, null, { cleared: true });
  // 3 students: suppressed, and its 3 colleges must not reveal it.
  await students(1, roles.small, colleges.A, cse);
  await students(1, roles.small, colleges.B);
  await students(1, roles.small, colleges.C, null, { relationship: 'GRADUATED' });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-analytics-' + randomUUID() });
const summaryPath = '/api/v1/operations/analytics/role-demand';
const detailPath = (id: string) => `${summaryPath}/roles/${id}`;
const suppressed = { suppressed: true, value: null };
const shown = (value: number) => ({ suppressed: false, value });

function expectNothingPersonal(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).not.toContain('student-private');
  expect(text).not.toContain('ROLL-');
  for (const id of studentIds) expect(text).not.toContain(id);
}

describe('who may read role demand', () => {
  it('401 without a token', async () => {
    expect((await api().get(summaryPath)).status).toBe(401);
    expect((await api().get(detailPath(roles.big))).status).toBe(401);
  });

  it('403 for SECURITY_ADMIN without the capability, an institution admin and a suspended operator', async () => {
    for (const caller of [await member('SECURITY_ADMIN'), await member('INSTITUTION_ADMIN'), await member('OPERATIONS_ADMIN', 'SUSPENDED')]) {
      const summary = await api().get(summaryPath).set(auth(caller.userId));
      expect(summary.status).toBe(403);
      expect(JSON.stringify(summary.body)).not.toContain('Software Developer');
      expect((await api().get(detailPath(roles.big)).set(auth(caller.userId))).status).toBe(403);
    }
  });

  it('200 for OPERATIONS_ADMIN and the super admin by baseline, and for SECURITY_ADMIN once granted ANALYTICS_VIEW', async () => {
    const granter = await member('PLATFORM_SUPER_ADMIN');
    const security = await member('SECURITY_ADMIN');
    await pool.query(
      "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'ANALYTICS_VIEW',$3,'NEW_RESPONSIBILITY')",
      [randomUUID(), security.membershipId, granter.userId],
    );
    for (const caller of [await member('OPERATIONS_ADMIN'), granter, security]) {
      expect((await api().get(summaryPath).set(auth(caller.userId))).status).toBe(200);
    }
  });
});

describe('input validation', () => {
  it('rejects any query parameter on the summary, a malformed role id and an unknown role', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const withParam = await api().get(summaryPath + '?limit=5').set(auth(operator.userId));
    expect(withParam.status).toBe(400);
    expect(withParam.body.error.code).toBe('INVALID_REQUEST');
    const badId = await api().get(detailPath('not-a-uuid')).set(auth(operator.userId));
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('CAREER_ROLE_ID_INVALID');
    const unknown = await api().get(detailPath(randomUUID())).set(auth(operator.userId));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('CAREER_ROLE_NOT_FOUND');
    expect(unknown.body.error.correlationId).toBeTruthy();
    expect((await api().get(detailPath(roles.big) + '?x=1').set(auth(operator.userId))).status).toBe(400);
  });
});

describe('the summary', () => {
  it('counts demand per role, ranks shown roles by demand and suppressed roles by code, and evaluates the promotion rule', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const response = await api().get(summaryPath).set(auth(operator.userId));
    expect(response.status).toBe(200);
    const demand = response.body.demand;
    expect(response.body.promotionRule).toEqual({ minimumStudents: 200, minimumColleges: 3, employerArm: 'NOT_RECORDED' });

    const byId = (id: string) => demand.roles.find((row: { id: string }) => row.id === id);
    expect(byId(roles.big)).toMatchObject({ catalogueCode: 'S01', students: shown(200), colleges: 3, releaseLabel: 'SELECTABLE', promotion: { status: 'MEETS', studentArmMet: true, employerArm: 'NOT_RECORDED' } });
    expect(byId(roles.twoColleges)).toMatchObject({ students: shown(200), colleges: 2, promotion: { status: 'NOT_MET', studentArmMet: false } });
    // Deleted, pending-deletion and cleared targets are not counted: 8, not 17.
    expect(byId(roles.mid)).toMatchObject({ students: shown(8), colleges: 2, promotion: { status: 'NOT_MET' } });
    // 3 students at 3 colleges: both withheld.
    expect(byId(roles.small)).toMatchObject({ students: suppressed, colleges: null, promotion: { status: 'NOT_MET' } });
    expect(byId(roles.starter)).toMatchObject({ catalogueCode: null, students: suppressed, colleges: null, promotion: { status: 'NOT_APPLICABLE', studentArmMet: null } });

    // Ranked: shown by count (ties by code), then suppressed by code — never by their true size.
    expect(demand.roles.map((row: { code: string }) => row.code)).toEqual(['ROLE_BIG', 'ROLE_TWO', 'ROLE_MID', 'ROLE_SMALL', 'ROLE_STARTER']);

    expect(demand.totals).toEqual({ studentsWithTarget: shown(411), roles: 5, catalogueRoles: 4, rolesMeetingPromotionRule: 1 });
    expect(demand.rolesCapped).toBe(false);
    expect(demand.byReleaseLabel).toEqual([
      { releaseLabel: 'SELECTABLE', label: 'SELECTABLE', roles: 4, students: shown(411), complementary: false },
      { releaseLabel: 'NONE', label: 'NONE', roles: 1, students: suppressed, complementary: false },
    ]);
    expect(demand.trend).toHaveLength(12);
    expect(demand.trend.every((month: { month: string }) => /^\d{4}-\d{2}$/.test(month.month))).toBe(true);
    expect(demand.employerDemand).toEqual({ available: false, reason: 'NO_ROLE_MAPPING' });
    expectNothingPersonal(response.body);
  });

  it('never returns a raw count below 5 anywhere in the summary', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const response = await api().get(summaryPath).set(auth(operator.userId));
    const values: number[] = [];
    JSON.stringify(response.body, (key, value) => {
      if (key === 'students' && value && typeof value === 'object' && value.value !== null) values.push(value.value);
      return value;
    });
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value >= 5)).toBe(true);
  });
});

describe('the drill-down', () => {
  it('breaks a role down by college and department, withholding what subtraction would reveal', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const response = await api().get(detailPath(roles.big)).set(auth(operator.userId));
    expect(response.status).toBe(200);
    const { detail } = response.body;
    expect(detail.role).toMatchObject({ students: shown(200), colleges: 3, promotion: { status: 'MEETS' } });
    expect(detail.colleges.map((row: { label: string; students: unknown }) => [row.label, row.students])).toEqual([
      ['Alpha Engineering College', shown(100)], ['Beta Institute', shown(60)], ['Gamma University', shown(40)],
    ]);
    const alpha = detail.colleges[0];
    // 3 in Mechanical is suppressed; Electrical (7) is withheld so 100 - 90 does not reveal it.
    expect(alpha.departments).toEqual([
      { label: 'Computer Science', students: shown(90), complementary: false },
      { label: 'Electrical', students: suppressed, complementary: true },
      { label: 'Mechanical', students: suppressed, complementary: false },
    ]);
    // Students without a department are one honest bucket, not dropped.
    expect(detail.colleges[1].departments).toEqual([{ label: 'Department not recorded', students: shown(60), complementary: false }]);
    expectNothingPersonal(response.body);
  });

  it('withholds a college cell that would reveal suppressed colleges and the no-college bucket, with no departments behind it', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const { detail } = (await api().get(detailPath(roles.mid)).set(auth(operator.userId))).body;
    expect(detail.colleges).toEqual([
      { label: 'Alpha Engineering College', students: suppressed, complementary: true, departments: null, departmentsCapped: false },
      { label: 'Delta College', students: suppressed, complementary: false, departments: null, departmentsCapped: false },
      { label: 'No college recorded', students: suppressed, complementary: false, departments: null, departmentsCapped: false },
    ]);
  });

  it('returns no breakdown at all for a role whose total is suppressed', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const { detail } = (await api().get(detailPath(roles.small)).set(auth(operator.userId))).body;
    expect(detail).toMatchObject({ role: { students: suppressed, colleges: null }, colleges: null, collegesCapped: false });
    expect(JSON.stringify(detail)).not.toContain('Gamma University');
  });

  it('writes no audit row for these aggregate reads', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    await api().get(summaryPath).set(auth(operator.userId));
    await api().get(detailPath(roles.big)).set(auth(operator.userId));
    const audit = await pool.query('SELECT count(*)::int AS count FROM audit_events WHERE actor_user_id = $1', [operator.userId]);
    expect(audit.rows[0].count).toBe(0);
  });
});
