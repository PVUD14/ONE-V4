/**
 * College health and college account fields over HTTP (OPS-14).
 *
 * Who may read health (ANALYTICS_VIEW) and manage account fields (ACCOUNT_MANAGE); that every
 * health figure comes from its real source and every count of people below 5 is suppressed,
 * directly and by subtraction; that account writes reject unknown fields, carry a reason code
 * and leave an audit row; that contacts are masked, revealed only with an audited reason, and
 * erased on removal; and that no student is named anywhere.
 *
 * Real Postgres in a throwaway schema, seeded with a known pattern.
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
if (!connectionString) throw new Error('DATABASE_URL is required for college health tests');

const schemaName = 'ops_college_health_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let employerId: string;
const colleges: Record<'A' | 'B' | 'D', string> = { A: '', B: '', D: '' };
/** Every student id seeded; none may appear in any response. */
const studentIds: string[] = [];
let superAdmin: Member;
let opsAdmin: Member;

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function member(role: string, options: { state?: string; organizationId?: string } = {}): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, 'staff-' + userId + '@example.test']);
  const isPlatform = platformRoles.includes(role);
  const org = options.organizationId ?? (isPlatform ? platformId : colleges.A);
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, options.state ?? 'ACTIVE', isPlatform ? null : org],
  );
  return { userId, membershipId };
}

async function grant(target: Member, capability: string): Promise<void> {
  await pool.query(
    "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
    [randomUUID(), target.membershipId, capability, superAdmin.userId],
  );
}

async function college(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION',$2,'VERIFIED',true)", [id, name]);
  return id;
}

/** `count` rostered students at a college with the given account state. */
async function students(institutionId: string, count: number, state = 'ACTIVE'): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  studentIds.push(...ids);
  await pool.query(
    "INSERT INTO users (id,email,external_subject,state) SELECT id, 'student-private-' || id || '@college.test', id::text, $2::account_state FROM unnest($1::uuid[]) AS id",
    [ids, state],
  );
  await pool.query(
    `INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
     SELECT gen_random_uuid(), $2, id, 'ACTIVE', '2020-01-01T00:00:00Z' FROM unnest($1::uuid[]) AS id`,
    [ids, institutionId],
  );
  await pool.query(
    `INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status)
     SELECT gen_random_uuid(), $2, id, 'ROLL-' || id, 'student-private name', 'ACTIVE' FROM unnest($1::uuid[]) AS id`,
    [ids, institutionId],
  );
  return ids;
}

/** A learning event at `when`, an SQL expression over the database clock. */
async function activity(userIds: readonly string[], when: string): Promise<void> {
  await pool.query(
    `INSERT INTO learner_activity_events (id,user_id,event_type,occurred_on,occurred_at)
     SELECT gen_random_uuid(), id, 'LESSON_COMPLETED', (${when})::date, ${when} FROM unnest($1::uuid[]) AS id`,
    [userIds],
  );
}

/** Wednesday of the last complete ISO week, and of the one before it, in UTC. */
const lastWeek = "((date_trunc('week', now() AT TIME ZONE 'UTC') - interval '5 days') AT TIME ZONE 'UTC')";
const twoWeeksAgo = "((date_trunc('week', now() AT TIME ZONE 'UTC') - interval '12 days') AT TIME ZONE 'UTC')";
const thisWeek = "((date_trunc('week', now() AT TIME ZONE 'UTC') + interval '1 minute') AT TIME ZONE 'UTC')";
/** The 10th of the last ended month, in UTC. */
const lastMonth = "((date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month' + interval '9 days') AT TIME ZONE 'UTC')";

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
  employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Employer Ltd','VERIFIED',true)", [employerId]);
  colleges.A = await college('Alpha College');
  colleges.B = await college('Beta College');
  colleges.D = await college('Delta College');
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  opsAdmin = await member('OPERATIONS_ADMIN');

  // Alpha: 10 activated + 2 not yet. 6 learned last week, 3 the week before, 1 only this week.
  const alpha = await students(colleges.A, 10);
  await students(colleges.A, 2, 'INVITED');
  await activity(alpha.slice(0, 6), lastWeek);
  await activity(alpha.slice(0, 6), lastWeek); // a second event does not count twice
  await activity(alpha.slice(6, 9), twoWeeksAgo);
  await activity(alpha.slice(9, 10), thisWeek);
  // 7 attempts by 6 students last month, plus one in progress (not counted).
  const subjectId = randomUUID();
  const definitionId = randomUUID();
  await pool.query("INSERT INTO exam_subjects (id,institution_id,name,code) VALUES ($1,$2,'Data Structures','CS201')", [subjectId, colleges.A]);
  await pool.query(`INSERT INTO exam_definitions (id,institution_id,subject_id,title,exam_kind,lifecycle_state,total_marks,duration_seconds,starts_at,ends_at,created_by_user_id,published_at)
    VALUES ($1,$2,$3,'Unit test 1','UNIT_TEST','PUBLISHED',10,600,now() - interval '90 days',now() + interval '5 days',$4,now())`, [definitionId, colleges.A, subjectId, opsAdmin.userId]);
  for (const [index, userId] of [...alpha.slice(0, 6), alpha[0]!].entries()) {
    await pool.query(`INSERT INTO exam_attempts (id,institution_id,definition_id,student_user_id,attempt_number,status,paper_seed,started_at,submitted_at)
      VALUES ($1,$2,$3,$4,$5,'SUBMITTED','seed',${lastMonth},${lastMonth})`, [randomUUID(), colleges.A, definitionId, userId, index === 6 ? 2 : 1]);
  }
  await pool.query(`INSERT INTO exam_attempts (id,institution_id,definition_id,student_user_id,attempt_number,status,paper_seed)
    VALUES ($1,$2,$3,$4,1,'IN_PROGRESS','seed')`, [randomUUID(), colleges.A, definitionId, alpha[7]]);
  // Readiness last month: 5 DEVELOPING, 1 PROGRESSING.
  const model = randomUUID();
  await pool.query(`INSERT INTO readiness_model_versions (id,stable_key,version,policy,published_by_user_id,published_at,active)
    VALUES ($1,'ops14-health-model',1,'{}'::jsonb,$2,now(),true)`, [model, opsAdmin.userId]);
  for (const [index, userId] of alpha.slice(0, 6).entries()) {
    await pool.query(`INSERT INTO readiness_snapshots (id,subject_user_id,model_version_id,evidence_ids,evidence_set_hash,band,explanation,generated_at)
      VALUES ($1,$2,$3,'{}'::uuid[],$4,$5,'{}'::jsonb,${lastMonth})`, [randomUUID(), userId, model, '0'.repeat(64), index < 5 ? 'DEVELOPING' : 'PROGRESSING']);
  }
  // Staff at Alpha: 5 wrote an audit event for Alpha last week, 1 did not.
  const alphaStaff: Member[] = [];
  for (let i = 0; i < 6; i += 1) alphaStaff.push(await member(i === 0 ? 'INSTITUTION_ADMIN' : 'FACULTY_LECTURER', { organizationId: colleges.A }));
  for (const staff of alphaStaff.slice(0, 5)) {
    await pool.query(`INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,organization_id,outcome,correlation_id,context,occurred_at)
      VALUES ($1,$2,'institution.test.acted','test',$3,$4,'SUCCESS','ops14-seed','{}'::jsonb,${lastWeek})`, [randomUUID(), staff.userId, randomUUID(), colleges.A]);
  }
  // 5 staff actions opened last week, and a counselling note that must never count.
  const relationships = (await pool.query('SELECT id, student_user_id FROM institution_relationships WHERE institution_id = $1 LIMIT 6', [colleges.A])).rows as { id: string; student_user_id: string }[];
  for (const [index, relationship] of relationships.entries()) {
    await pool.query(`INSERT INTO staff_actions (id,institution_id,subject_student_user_id,institution_relationship_id,actor_user_id,actor_membership_id,assigned_to_membership_id,action_type,state,title,note,updated_by_user_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'OPEN','Follow up','Private staff note',$5,${lastWeek})`,
    [randomUUID(), colleges.A, relationship.student_user_id, relationship.id, alphaStaff[0]!.userId, alphaStaff[0]!.membershipId, index < 5 ? 'INTERVENTION' : 'COUNSELLING_NOTE']);
  }
  // Support: 2 open for Alpha (one past its SLA), 1 closed. Cases start OPEN and move by update.
  const caseIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of caseIds) {
    await pool.query(`INSERT INTO support_cases (id,organization_id,channel,category,severity,summary,opened_by_user_id,opening_reason_code,sla_due_at)
      VALUES ($1,$2,'EMAIL','HOW_TO','LOW','College asked a question',$3,'CUSTOMER_CONTACT',now() + interval '1 day')`, [id, colleges.A, opsAdmin.userId]);
  }
  await pool.query("UPDATE support_cases SET state = 'IN_PROGRESS' WHERE id = $1", [caseIds[1]]);
  await pool.query("UPDATE support_cases SET state = 'CLOSED' WHERE id = $1", [caseIds[2]]);
  // The SLA is stamped by the 0043 trigger and immutable; age one case past it in this throwaway schema only.
  await pool.query('ALTER TABLE support_cases DISABLE TRIGGER USER');
  await pool.query("UPDATE support_cases SET opened_at = now() - interval '10 days', sla_due_at = now() - interval '1 hour' WHERE id = $1", [caseIds[1]]);
  await pool.query('ALTER TABLE support_cases ENABLE TRIGGER USER');

  // Beta: 3 students, 2 active last week — everything under 5.
  const beta = await students(colleges.B, 3);
  await activity(beta.slice(0, 2), lastWeek);

  // Delta: 8 activated + 7 not yet, and deleted accounts that never count.
  await students(colleges.D, 8);
  await students(colleges.D, 7, 'INVITED');
  await students(colleges.D, 3, 'DELETED');
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops14-' + randomUUID() });
const healthPath = '/api/v1/operations/analytics/colleges';
const accountPath = (id: string) => '/api/v1/operations/college-accounts/' + id;
const suppressed = { suppressed: true, value: null };
const shown = (value: number) => ({ suppressed: false, value });

function expectNoStudent(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).not.toContain('student-private');
  expect(text).not.toContain('ROLL-');
  for (const id of studentIds) expect(text).not.toContain(id);
}

async function lastAudit(action: string): Promise<{ actor_user_id: string; organization_id: string; resource_id: string; correlation_id: string; context: Record<string, unknown> }> {
  const found = await pool.query('SELECT actor_user_id, organization_id, resource_id, correlation_id, context FROM audit_events WHERE action = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1', [action]);
  return found.rows[0];
}

describe('who may read college health and manage account fields', () => {
  it('401 without a token', async () => {
    expect((await api().get(healthPath)).status).toBe(401);
    expect((await api().get(healthPath + '/' + colleges.A)).status).toBe(401);
    expect((await api().get(accountPath(colleges.A))).status).toBe(401);
    expect((await api().patch(accountPath(colleges.A)).send({ reasonCode: 'CORRECTION', renewalDate: '2027-01-01' })).status).toBe(401);
  });

  it('403 for SECURITY_ADMIN without a grant, an institution admin and a suspended operator', async () => {
    for (const caller of [await member('SECURITY_ADMIN'), await member('INSTITUTION_ADMIN'), await member('OPERATIONS_ADMIN', { state: 'SUSPENDED' })]) {
      const list = await api().get(healthPath).set(auth(caller.userId));
      expect(list.status).toBe(403);
      expect(JSON.stringify(list.body)).not.toContain('Alpha College');
      expect((await api().get(healthPath + '/' + colleges.A).set(auth(caller.userId))).status).toBe(403);
      expect((await api().get(accountPath(colleges.A)).set(auth(caller.userId))).status).toBe(403);
      expect((await api().post(accountPath(colleges.A) + '/contacts').set(auth(caller.userId))
        .send({ reasonCode: 'NEW_CONTACT', role: 'PRINCIPAL', name: 'Dr Rao', email: 'rao@alpha.edu' })).status).toBe(403);
    }
  });

  it('each capability opens only its own module when granted', async () => {
    const analyst = await member('SECURITY_ADMIN');
    await grant(analyst, 'ANALYTICS_VIEW');
    expect((await api().get(healthPath).set(auth(analyst.userId))).status).toBe(200);
    expect((await api().get(accountPath(colleges.A)).set(auth(analyst.userId))).status).toBe(403);
    const accountManager = await member('SECURITY_ADMIN');
    await grant(accountManager, 'ACCOUNT_MANAGE');
    expect((await api().get(accountPath(colleges.A)).set(auth(accountManager.userId))).status).toBe(200);
    expect((await api().get(healthPath).set(auth(accountManager.userId))).status).toBe(403);
  });

  it('200 for OPERATIONS_ADMIN and the super admin by baseline', async () => {
    for (const caller of [opsAdmin, superAdmin]) {
      expect((await api().get(healthPath).set(auth(caller.userId))).status).toBe(200);
      expect((await api().get(accountPath(colleges.A)).set(auth(caller.userId))).status).toBe(200);
    }
  });
});

describe('college health figures', () => {
  it('400 for any query parameter and a malformed id; 404 for an employer or unknown id', async () => {
    expect((await api().get(healthPath + '?limit=5').set(auth(opsAdmin.userId))).status).toBe(400);
    expect((await api().get(healthPath + '/not-a-uuid').set(auth(opsAdmin.userId))).status).toBe(400);
    expect((await api().get(healthPath + '/' + colleges.A + '?x=1').set(auth(opsAdmin.userId))).status).toBe(400);
    expect((await api().get(healthPath + '/' + employerId).set(auth(opsAdmin.userId))).status).toBe(404);
    expect((await api().get(healthPath + '/' + randomUUID()).set(auth(opsAdmin.userId))).status).toBe(404);
  });

  it('counts every figure from its source and suppresses every count of people under 5', async () => {
    const response = await api().get(healthPath).set(auth(opsAdmin.userId)).expect(200);
    const { health } = response.body;
    expectNoStudent(response.body);
    const byName = new Map((health.colleges as { name: string }[]).map((row) => [row.name, row as Record<string, unknown>]));
    expect([...byName.keys()]).not.toContain('Employer Ltd');
    const alpha = byName.get('Alpha College')!;
    // 10 signed in, 2 not: the 2 is withheld and so is the total, which would give it back.
    expect(alpha.students).toEqual({ total: suppressed, yes: shown(10), no: suppressed });
    expect(alpha.weeklyActiveLearners).toEqual(shown(6));
    // 5 staff active, 1 not.
    expect(alpha.staff).toEqual({ total: suppressed, yes: shown(5), no: suppressed });
    expect(alpha.openSupportCases).toBe(2);
    expect(alpha.overdueSupportCases).toBe(1);
    expect(alpha.verificationState).toBe('VERIFIED');
    const beta = byName.get('Beta College')!;
    expect(beta.students).toEqual({ total: suppressed, yes: suppressed, no: suppressed });
    expect(beta.weeklyActiveLearners).toEqual(suppressed);
    expect(beta.openSupportCases).toBe(0);
    // Delta: 8 and 7 both shown, so the total is too; the 3 deleted accounts are nowhere.
    expect(byName.get('Delta College')!.students).toEqual({ total: shown(15), yes: shown(8), no: shown(7) });
    // Totals count colleges and cases only, never people across colleges.
    expect(Object.keys(health.totals).sort()).toEqual(['colleges', 'openSupportCases', 'renewingWithin90Days', 'withoutRenewalDate']);
    expect(health.windows.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(health.windows.weekStart + 'T00:00:00Z').getUTCDay()).toBe(1);
    expect(new Date(health.windows.weekEnd + 'T00:00:00Z').getUTCDay()).toBe(0);
    expect(health.collegesCapped).toBe(false);
  });

  it('a college view adds the four-week trend, assessments, staff actions and readiness bands — bands only', async () => {
    const response = await api().get(healthPath + '/' + colleges.A).set(auth(opsAdmin.userId)).expect(200);
    const { detail } = response.body;
    expectNoStudent(response.body);
    expect(detail.weeklyActiveTrend.map((week: { learners: unknown }) => week.learners)).toEqual([suppressed, suppressed, suppressed, shown(6)]);
    expect(detail.weeklyActiveTrend[3].weekStart).toBe(detail.windows.weekStart);
    expect(detail.assessments).toEqual({ attempts: shown(7), students: shown(6) });
    expect(detail.staffActionsOpened).toEqual(shown(5));
    // 5 DEVELOPING and 1 PROGRESSING: the 1 and both zeros are <5, and the total is withheld.
    expect(detail.readinessBands.suppressed).toBe(false);
    expect(detail.readinessBands.cohortSizeSuppressed).toBe(true);
    const bands = Object.fromEntries(detail.readinessBands.bands.map((band: { band: string; count: number | null; suppressed: boolean }) => [band.band, band.suppressed ? '<5' : band.count]));
    expect(bands).toEqual({ NOT_ENOUGH_EVIDENCE: '<5', DEVELOPING: 5, PROGRESSING: '<5', READY_FOR_NEXT_STEP: '<5' });
    expect(detail.readinessMovement).toEqual({ available: false, reason: 'NOT_COMPUTED' });
    // No numeric readiness anywhere.
    expect(JSON.stringify(detail)).not.toMatch(/score|percentage|readinessValue/i);

    const beta = (await api().get(healthPath + '/' + colleges.B).set(auth(opsAdmin.userId)).expect(200)).body.detail;
    expect(beta.readinessBands.suppressed).toBe(true);
    expect(beta.assessments).toEqual({ attempts: suppressed, students: suppressed });
    expect(beta.weeklyActiveTrend.every((week: { learners: unknown }) => JSON.stringify(week.learners) === JSON.stringify(suppressed))).toBe(true);
  });

  it('writes no audit row for the aggregate reads', async () => {
    const before = (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'operations.%'")).rows[0].n;
    await api().get(healthPath).set(auth(opsAdmin.userId)).expect(200);
    await api().get(healthPath + '/' + colleges.A).set(auth(opsAdmin.userId)).expect(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'operations.%'")).rows[0].n).toBe(before);
  });
});

describe('college account fields', () => {
  it('reads an empty account for a college with none yet, and 404 for an employer', async () => {
    const response = await api().get(accountPath(colleges.D)).set(auth(opsAdmin.userId)).expect(200);
    expect(response.body.account.account).toBeNull();
    expect(response.body.account.contacts).toEqual([]);
    expect(response.body.account.institution.name).toBe('Delta College');
    expect((await api().get(accountPath(employerId)).set(auth(opsAdmin.userId))).status).toBe(404);
    expect((await api().get(accountPath('nope')).set(auth(opsAdmin.userId))).status).toBe(400);
    expect((await api().patch(accountPath(employerId)).set(auth(opsAdmin.userId)).send({ reasonCode: 'CORRECTION', renewalDate: '2027-01-01' })).status).toBe(404);
  });

  it('rejects unknown fields, missing or unlisted reason codes, bad values and empty changes, writing nothing', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM institution_accounts')).rows[0].n;
    for (const body of [
      { reasonCode: 'NEW_CONTRACT', renewalDate: '2027-03-31', contractValue: 500000 },
      { renewalDate: '2027-03-31' },
      { reasonCode: 'BECAUSE', renewalDate: '2027-03-31' },
      { reasonCode: 'NEW_CONTRACT', renewalDate: '2027-02-30' },
      { reasonCode: 'NEW_CONTRACT', contractReference: 'Rs 5,00,000' },
      { reasonCode: 'NEW_CONTRACT', accountOwnerMembershipId: 'someone' },
      { reasonCode: 'NEW_CONTRACT', note: 'x'.repeat(501), renewalDate: '2027-03-31' },
      { reasonCode: 'NEW_CONTRACT' },
      [],
    ]) {
      expect((await api().patch(accountPath(colleges.A)).set(auth(opsAdmin.userId)).send(body)).status).toBe(400);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_accounts')).rows[0].n).toBe(before);
  });

  it('saves renewal date, contract reference and owner with a reason code and an audit row, then refuses a stale version', async () => {
    const headers = auth(opsAdmin.userId);
    const saved = await api().patch(accountPath(colleges.A)).set(headers)
      .send({ reasonCode: 'NEW_CONTRACT', renewalDate: '2026-11-30', contractReference: 'AI8HT-2026-014', accountOwnerMembershipId: opsAdmin.membershipId, expectedVersion: null })
      .expect(200);
    const account = saved.body.account.account;
    expect(account).toMatchObject({ renewalDate: '2026-11-30', contractReference: 'AI8HT-2026-014', version: 2 });
    expect(account.accountOwner).toMatchObject({ membershipId: opsAdmin.membershipId, role: 'OPERATIONS_ADMIN', active: true });
    const row = await lastAudit('operations.institution_account.updated');
    expect(row).toMatchObject({ actor_user_id: opsAdmin.userId, organization_id: colleges.A, resource_id: colleges.A, correlation_id: headers['X-Correlation-Id'] });
    expect(row.context).toMatchObject({
      reasonCode: 'NEW_CONTRACT',
      changes: { renewalDate: { from: null, to: '2026-11-30' }, contractReference: { from: null, to: 'AI8HT-2026-014' }, accountOwnerMembershipId: { from: null, to: opsAdmin.membershipId } },
    });
    // Someone else's view from before the save is stale.
    const stale = await api().patch(accountPath(colleges.A)).set(auth(opsAdmin.userId)).send({ reasonCode: 'CORRECTION', renewalDate: '2027-01-31', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('COLLEGE_ACCOUNT_VERSION_CONFLICT');
    // The same values again change nothing.
    expect((await api().patch(accountPath(colleges.A)).set(auth(opsAdmin.userId)).send({ reasonCode: 'CORRECTION', renewalDate: '2026-11-30', expectedVersion: 2 })).status).toBe(400);
    // The list now sorts Alpha first by renewal date and shows it.
    const list = (await api().get(healthPath).set(auth(opsAdmin.userId)).expect(200)).body.health;
    expect(list.colleges[0]).toMatchObject({ name: 'Alpha College', renewalDate: '2026-11-30' });
    expect(list.totals.withoutRenewalDate).toBe(list.totals.colleges - 1);
  });

  it('refuses an owner who is not an active AI8HT operator, in the API and in the database', async () => {
    const collegeAdmin = await member('INSTITUTION_ADMIN');
    const refused = await api().patch(accountPath(colleges.B)).set(auth(opsAdmin.userId)).send({ reasonCode: 'OWNER_HANDOVER', accountOwnerMembershipId: collegeAdmin.membershipId });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('COLLEGE_ACCOUNT_OWNER_INVALID');
    expect(JSON.stringify(refused.body)).not.toMatch(/operations|trigger|exception/i);
    const suspended = await member('OPERATIONS_ADMIN', { state: 'SUSPENDED' });
    expect((await api().patch(accountPath(colleges.B)).set(auth(opsAdmin.userId)).send({ reasonCode: 'OWNER_HANDOVER', accountOwnerMembershipId: suspended.membershipId })).status).toBe(400);
    await expect(pool.query('UPDATE institution_accounts SET account_owner_membership_id = $1 WHERE institution_id = $2', [collegeAdmin.membershipId, colleges.A])).rejects.toThrow(/account owner/);
    await expect(pool.query('DELETE FROM institution_accounts WHERE institution_id = $1', [colleges.A])).rejects.toThrow(/never deleted/);
    await expect(pool.query("INSERT INTO institution_accounts (institution_id, updated_by_user_id) VALUES ($1, $2)", [employerId, opsAdmin.userId])).rejects.toThrow(/only for an institution/);
  });

  it('keeps contacts masked, reveals them only with an audited reason, and erases them on removal', async () => {
    const added = await api().post(accountPath(colleges.A) + '/contacts').set(auth(opsAdmin.userId))
      .send({ reasonCode: 'NEW_CONTACT', role: 'PLACEMENT_OFFICER', name: 'Meera Iyer', email: 'Meera.Iyer@Alpha.edu', phone: '+91 98450 12345' })
      .expect(201);
    const contactId = added.body.contactId as string;
    const contact = added.body.account.contacts.find((entry: { id: string }) => entry.id === contactId);
    expect(contact).toMatchObject({ role: 'PLACEMENT_OFFICER', name: 'Meera Iyer', email: 'm***@alpha.edu', phone: '***2345' });
    expect(JSON.stringify(added.body)).not.toContain('meera.iyer@alpha.edu');
    expect(JSON.stringify(added.body)).not.toContain('98450');
    const addAudit = await lastAudit('operations.institution_account.contact_added');
    expect(addAudit.context).toEqual({ reasonCode: 'NEW_CONTACT', role: 'PLACEMENT_OFFICER', fields: ['email', 'phone'] });
    expect(JSON.stringify(addAudit)).not.toMatch(/meera|98450/i);

    // Validation.
    for (const body of [
      { reasonCode: 'NEW_CONTACT', role: 'PRINCIPAL', name: 'No Channel' },
      { reasonCode: 'NEW_CONTACT', role: 'CHANCELLOR', name: 'X', email: 'x@alpha.edu' },
      { reasonCode: 'NEW_CONTACT', role: 'PRINCIPAL', name: 'X', email: 'not-an-address' },
      { reasonCode: 'NEW_CONTACT', role: 'PRINCIPAL', name: 'X', email: 'x@alpha.edu', salary: 1 },
      { role: 'PRINCIPAL', name: 'X', email: 'x@alpha.edu' },
    ]) expect((await api().post(accountPath(colleges.A) + '/contacts').set(auth(opsAdmin.userId)).send(body)).status).toBe(400);

    // Reveal needs a listed reason.
    expect((await api().post(`${accountPath(colleges.A)}/contacts/${contactId}/reveal`).set(auth(opsAdmin.userId)).send({})).status).toBe(400);
    expect((await api().post(`${accountPath(colleges.A)}/contacts/${contactId}/reveal`).set(auth(opsAdmin.userId)).send({ reasonCode: 'CURIOSITY' })).status).toBe(400);
    // A contact of another college is not found through this college.
    expect((await api().post(`${accountPath(colleges.B)}/contacts/${contactId}/reveal`).set(auth(opsAdmin.userId)).send({ reasonCode: 'RENEWAL_OUTREACH' })).status).toBe(404);
    const revealed = await api().post(`${accountPath(colleges.A)}/contacts/${contactId}/reveal`).set(auth(opsAdmin.userId)).send({ reasonCode: 'RENEWAL_OUTREACH' }).expect(201);
    expect(revealed.body.contact).toEqual({ email: 'meera.iyer@alpha.edu', phone: '+91 98450 12345' });
    const revealAudit = await lastAudit('operations.institution_account.contact_revealed');
    expect(revealAudit).toMatchObject({ actor_user_id: opsAdmin.userId, resource_id: contactId, organization_id: colleges.A });
    expect(revealAudit.context).toEqual({ reasonCode: 'RENEWAL_OUTREACH', role: 'PLACEMENT_OFFICER', fields: ['email', 'phone'] });

    // A contact cannot be edited in place.
    await expect(pool.query("UPDATE institution_account_contacts SET email = 'other@alpha.edu' WHERE id = $1", [contactId])).rejects.toThrow(/only be removed/);
    await expect(pool.query('DELETE FROM institution_account_contacts WHERE id = $1', [contactId])).rejects.toThrow(/never deleted/);

    const removed = await api().post(`${accountPath(colleges.A)}/contacts/${contactId}/remove`).set(auth(opsAdmin.userId)).send({ reasonCode: 'PRIVACY_REQUEST' }).expect(201);
    expect(removed.body.account.contacts.find((entry: { id: string }) => entry.id === contactId)).toBeUndefined();
    const stored = (await pool.query('SELECT full_name, email, phone, removed_reason_code FROM institution_account_contacts WHERE id = $1', [contactId])).rows[0];
    expect(stored).toEqual({ full_name: null, email: null, phone: null, removed_reason_code: 'PRIVACY_REQUEST' });
    expect((await lastAudit('operations.institution_account.contact_removed')).context).toEqual({ reasonCode: 'PRIVACY_REQUEST', role: 'PLACEMENT_OFFICER' });
    expect((await api().post(`${accountPath(colleges.A)}/contacts/${contactId}/remove`).set(auth(opsAdmin.userId)).send({ reasonCode: 'CORRECTION' })).status).toBe(404);
    expect((await api().post(`${accountPath(colleges.A)}/contacts/${contactId}/reveal`).set(auth(opsAdmin.userId)).send({ reasonCode: 'ESCALATION' })).status).toBe(404);
  });

  it('holds at most 10 live contacts per college', async () => {
    for (let i = 0; i < 10; i += 1) {
      await api().post(accountPath(colleges.D) + '/contacts').set(auth(opsAdmin.userId))
        .send({ reasonCode: 'NEW_CONTACT', role: 'OTHER', name: 'Contact ' + i, phone: '+91 90000 0000' + i }).expect(201);
    }
    const full = await api().post(accountPath(colleges.D) + '/contacts').set(auth(opsAdmin.userId)).send({ reasonCode: 'NEW_CONTACT', role: 'OTHER', name: 'Eleventh', phone: '+91 90000 00099' });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('COLLEGE_CONTACT_LIMIT_REACHED');
  });

  it('policy lists reason codes, contact roles and only active AI8HT operators as owners', async () => {
    const policy = (await api().get('/api/v1/operations/college-accounts/policy').set(auth(opsAdmin.userId)).expect(200)).body;
    expect(policy.reasons.update).toContain('RENEWAL_AGREED');
    expect(policy.contactRoles).toContain('PRINCIPAL');
    const roles = new Set(policy.owners.map((owner: { role: string }) => owner.role));
    for (const role of roles) expect(platformRoles).toContain(role);
    expect(policy.owners.some((owner: { membershipId: string }) => owner.membershipId === opsAdmin.membershipId)).toBe(true);
    expectNoStudent(policy);
  });
});
