/**
 * The adaptive engine health panels over HTTP (OPS-13).
 *
 * AI Operations reads planner decisions per day and the override rate (learning_decisions) and the
 * mastery shadow comparison (learner_skill_state against mastery_projections, adaptive-learning
 * holders only); System Health reads the last calibration run and its status (item_calibration_runs,
 * item_calibrations) and the sandbox, which has no source and shows NA. Every figure comes from those
 * tables or is NA; no student-level detail leaves the server and groups under five are withheld,
 * including by subtraction. Each route is authorised by its screen's existing capability.
 *
 * Real Postgres in a throwaway schema; every person here is synthetic.
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
import { buildBktShadowReport } from '@planthepath/persistence/src/bkt-shadow-report.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for engine health tests');

const schemaName = 'ops_engine_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'a'.repeat(64);
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let app: INestApplication;
let platformId: string;
let collegeId: string;
let operations: Member;
let security: Member;
let suspended: Member;
let collegeAdmin: Member;
let faculty: string;
let topics: string[] = [];

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

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
  collegeId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Engine health test college')", [collegeId]);
  operations = await member('OPERATIONS_ADMIN');
  security = await member('SECURITY_ADMIN');
  suspended = await member('OPERATIONS_ADMIN', 'SUSPENDED');
  collegeAdmin = await member('INSTITUTION_ADMIN', 'ACTIVE', collegeId);
  faculty = await learner();
  topics = [await topic('Synthetic topic one'), await topic('Synthetic topic two')];
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', 'ops13-synthetic', 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')`);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

async function member(role: string, state = 'ACTIVE', organizationId?: string): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, 'staff-' + userId.slice(0, 8) + '@example.test']);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : organizationId ?? collegeId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId };
}

async function learner(): Promise<string> {
  const userId = randomUUID();
  await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, 'learner-' + userId.slice(0, 8) + '@college.example.test']);
  return userId;
}

async function topic(name: string): Promise<string> {
  const topicId = randomUUID();
  const revision = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, topicId, operations.userId, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1,'TOPIC',$2,1,$3,'Synthetic topic for OPS-13 tests',$4)`, [topicId, 'ops13-' + topicId, name, revision]);
  return topicId;
}

/** A planner decision as the planner writes it; `overridden` records a faculty override (INST-16). */
async function decision(subject: string, ago: string, overridden = false): Promise<void> {
  await pool.query(
    `INSERT INTO learning_decisions (id, subject_user_id, institution_id, policy_version, adaptive, inputs, inputs_hash, action, reason_codes,
       override_by_user_id, override_reason_code, correlation_id, decided_at)
     VALUES ($1,$2,$3,'learning-orchestrator-v1',true,'{}'::jsonb,$4,'NONE',$5,$6,$7,'ops13-decision', now() - $8::interval)`,
    [randomUUID(), subject, collegeId, SHA, overridden ? ['FACULTY_OVERRIDE'] : ['NOTHING_TO_DO'], overridden ? faculty : null, overridden ? 'FACULTY_JUDGEMENT' : null, ago],
  );
}

/** A consenting student's engine rows and live bands on both topics. */
async function shadowStudent(consents: boolean): Promise<string> {
  const subject = await learner();
  if (consents) {
    await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
      VALUES ($1,$2,'adaptive-learning','ops13-synthetic','GRANTED', now() - interval '10 seconds')`, [randomUUID(), subject]);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('one.learner_skill_state_writer', 'learner-skill-state-projector', true)");
    for (const topicId of topics) {
      // Engine band DEVELOPING; BKT likelihood 0.96 (would be DEMONSTRATED); live band PROGRESSING.
      await client.query(
        `INSERT INTO learner_skill_state (subject_user_id, skill_id, institution_id, attempt_count, attempt_day_count, unaided_success_count,
           unaided_success_day_count, assisted_success_count, last_attempt_at, evidence_stage, evidence_band, active_misconception_codes,
           mastery_likelihood, mastery_uncertainty, mastery_algorithm_version, algorithm_version)
         VALUES ($1,$2,$3,3,2,2,1,0,now(),'ESTIMATED','DEVELOPING','{}',0.9600,0.2423,'mastery-bkt-v1','learner-skill-state-v2')`,
        [subject, topicId, collegeId]);
    }
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  for (const topicId of topics) {
    await pool.query(`INSERT INTO mastery_projections (id, subject_user_id, topic_id, algorithm_version, evidence_ids, evidence_set_hash, band)
      VALUES ($1,$2,$3,'career-readiness-mastery-v1','{}',$4,'PROGRESSING')`, [randomUUID(), subject, topicId, SHA]);
  }
  return subject;
}

async function calibrationRun(input: { readonly ago: string; readonly learners: number; readonly calibrated: number; readonly provisional: number }): Promise<void> {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO item_calibration_runs (id, source, algorithm_id, library, min_responses, learners_read, responses_read, items_read, exported_at, generated_at, recorded_at)
     VALUES ($1,'jobs/calibration','item-calibration-2pl-v1','girth 0.8.0',30,$2,$3,$4, now() - $5::interval - interval '2 hours', now() - $5::interval - interval '1 hour', now() - $5::interval)`,
    [runId, input.learners, input.learners * 12, input.calibrated + input.provisional, input.ago],
  );
  for (let index = 0; index < input.calibrated; index += 1) {
    await pool.query(`INSERT INTO item_calibrations (id, run_id, item_source, item_id, item_version, model, difficulty, discrimination, responses_used, status)
      VALUES ($1,$2,'CAREER_READINESS_QUESTION',$3,1,'2PL',0.5,1.2,40,'CALIBRATED')`, [randomUUID(), runId, randomUUID()]);
  }
  for (let index = 0; index < input.provisional; index += 1) {
    await pool.query(`INSERT INTO item_calibrations (id, run_id, item_source, item_id, item_version, model, difficulty, discrimination, responses_used, status, status_reason)
      VALUES ($1,$2,'CAREER_READINESS_QUESTION',$3,1,'2PL',0,1,3,'PROVISIONAL','TOO_FEW_RESPONSES')`, [randomUUID(), runId, randomUUID()]);
  }
}

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-engine-' + randomUUID() });
const aiRoute = '/api/v1/operations/ai/engine-health';
const jobsRoute = '/api/v1/operations/jobs/engine-health';
const withheld = { suppressed: true, value: null };
const shown = (value: number) => ({ suppressed: false, value });

describe('who may read the engine health panels', () => {
  it('401 without a token on both routes', async () => {
    await api().get(aiRoute).expect(401);
    await api().get(jobsRoute).expect(401);
  });

  it('403 for an institution admin and for a suspended operations membership', async () => {
    for (const caller of [collegeAdmin, suspended]) {
      const ai = await api().get(aiRoute).set(auth(caller.userId));
      expect(ai.status).toBe(403);
      expect(ai.body.error?.correlationId ?? ai.body.message?.correlationId).toBeTruthy();
      expect((await api().get(jobsRoute).set(auth(caller.userId))).status).toBe(403);
    }
  });

  it('200 with the screen capability: AI_OPS_VIEW and OPS_JOBS_REPLAY, held by operations and security by baseline', async () => {
    for (const caller of [operations, security]) {
      expect((await api().get(aiRoute).set(auth(caller.userId))).status).toBe(200);
      expect((await api().get(jobsRoute).set(auth(caller.userId))).status).toBe(200);
    }
  });

  it('400 on a window other than 7, 14 or 30 days, and on unknown query parameters', async () => {
    for (const days of ['0', '15', '365', 'abc', '-7']) {
      const response = await api().get(aiRoute).query({ days }).set(auth(operations.userId));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('ENGINE_HEALTH_DAYS_INVALID');
    }
    expect((await api().get(aiRoute).query({ days: '14', institutionId: collegeId }).set(auth(operations.userId))).status).toBe(400);
    expect((await api().get(jobsRoute).query({ limit: '5' }).set(auth(operations.userId))).status).toBe(400);
  });
});

describe('with no engine data yet', () => {
  it('shows every planner and shadow figure as withheld, calibration as never run, and the sandbox as NA', async () => {
    const ai = (await api().get(aiRoute).set(auth(operations.userId)).expect(200)).body;
    expect(ai.suppressionThreshold).toBe(5);
    expect(ai.planner.windowDays).toBe(14);
    expect(ai.planner.days).toHaveLength(14);
    expect(ai.planner.days.every((day: { decisions: unknown }) => JSON.stringify(day.decisions) === JSON.stringify(withheld))).toBe(true);
    expect(ai.planner).toMatchObject({ decisions: withheld, overridden: withheld, overrideRate: null, active: false, policyVersions: [] });
    expect(ai.masteryShadow).toMatchObject({ consentOffered: true, suppressed: true, studentsInScope: withheld, coverage: null, c3Adoption: null, bkt: null });
    expect((await api().get(aiRoute).query({ days: '7' }).set(auth(operations.userId)).expect(200)).body.planner.days).toHaveLength(7);
    expect((await api().get(aiRoute).query({ days: '30' }).set(auth(operations.userId)).expect(200)).body.planner.days).toHaveLength(30);

    const jobs = (await api().get(jobsRoute).set(auth(security.userId)).expect(200)).body;
    expect(jobs.calibration).toEqual({ status: 'NO_RUN', expectedIntervalDays: 7, overdueAfterDays: 8, runsRecorded: 0, lastRun: null });
    expect(jobs.sandbox).toEqual({ state: 'NOT_BUILT', available: null, rejectedExecutions: null });
  });
});

describe('planner decisions per day and override rate (learning_decisions)', () => {
  it('publishes a day only over five students, and withholds the total while a small day could be recovered', async () => {
    const today = await Promise.all(Array.from({ length: 6 }, () => learner()));
    for (const [index, subject] of today.entries()) {
      await decision(subject, '0 seconds', index < 5);
      await decision(subject, '0 seconds');
    }
    const smallDay = [await learner(), await learner()];
    for (const subject of smallDay) await decision(subject, '3 days');
    // Outside every window: never counted.
    await decision(await learner(), '40 days');

    const planner = (await api().get(aiRoute).set(auth(operations.userId)).expect(200)).body.planner;
    expect(planner.days.at(-1).decisions).toEqual(shown(12));
    expect(planner.days.at(-4).decisions).toEqual(withheld);
    // Two students behind the suppressed day: total − today would reveal them.
    expect(planner.decisions).toEqual(withheld);
    expect(planner.overridden).toEqual(shown(5));
    expect(planner.overrideRate).toBeNull();
    expect(planner.active).toBe(true);
    expect(planner.policyVersions).toEqual(['learning-orchestrator-v1']);
  });

  it('publishes the total and the override rate once the suppressed days stand for five students together', async () => {
    for (let index = 0; index < 3; index += 1) await decision(await learner(), '5 days');
    const planner = (await api().get(aiRoute).set(auth(operations.userId)).expect(200)).body.planner;
    expect(planner.days.at(-6).decisions).toEqual(withheld);
    expect(planner.decisions).toEqual(shown(17));
    expect(planner.overridden).toEqual(shown(5));
    expect(planner.overrideRate).toBe(0.2941);
    // The 7-day window holds the same decisions; the 40-day-old one is in no window.
    expect((await api().get(aiRoute).query({ days: '30' }).set(auth(operations.userId)).expect(200)).body.planner.decisions).toEqual(shown(17));
  });
});

describe('mastery shadow comparison (learner_skill_state, mastery_projections, adaptive-learning holders)', () => {
  it('withholds the whole panel while fewer than five consenting students are in scope', async () => {
    for (let index = 0; index < 4; index += 1) await shadowStudent(true);
    // Rows without the purpose are never read (fail closed).
    await shadowStudent(false);
    await shadowStudent(false);
    const shadow = (await api().get(aiRoute).set(auth(operations.userId)).expect(200)).body.masteryShadow;
    expect(shadow).toMatchObject({ consentOffered: true, suppressed: true, studentsInScope: withheld, coverage: null, c3Adoption: null, bkt: null });
  });

  it('shows the same counts as the offline shadow report, with no identifier, once five or more are in scope', async () => {
    await shadowStudent(true);
    await shadowStudent(true);
    const body = (await api().get(aiRoute).set(auth(operations.userId)).expect(200)).body;
    const shadow = body.masteryShadow;
    expect(shadow.suppressed).toBe(false);
    expect(shadow.studentsInScope).toEqual(shown(6));
    expect(shadow.algorithms).toEqual({ live: 'career-readiness-mastery-v1', engineBand: 'learning-model-v1', projector: 'learner-skill-state-v2', shadow: 'mastery-bkt-v1' });
    // 6 students × 2 topics: the engine's C3 band is below the live band, BKT's above it.
    expect(shadow.c3Adoption).toEqual({
      pairsCompared: shown(12), unchanged: withheld, movedUp: withheld, movedDown: shown(12),
      becameNotEnoughEvidence: withheld, leftNotEnoughEvidence: withheld, studentsWithAnyChange: shown(6),
    });
    expect(shadow.bkt).toMatchObject({ pairsCompared: shown(12), movedUp: shown(12), movedDown: withheld, studentsWithAnyChange: shown(6) });
    expect(shadow.coverage).toEqual({ pairsWithBothBands: shown(12), livePairsWithoutEngineRow: withheld, engineRowsWithoutLiveBand: withheld, engineRowsOnOlderProjector: withheld });

    const report = await buildBktShadowReport(db as unknown as PersistenceDb);
    expect(report.coverage!.studentsInScope).toBe(6);
    expect(report.bkt!.pairsCompared).toBe(12);
    expect(report.bkt!.movedUp).toBe(12);
    expect(report.c3Adoption!.movedDown).toBe(12);

    // Everything but the caller's own correlation reference.
    const printed = JSON.stringify({ ...body, correlationId: undefined });
    expect(printed).not.toMatch(UUID_PATTERN);
    expect(printed).not.toMatch(/example\.test/);
    expect(printed).not.toMatch(/0\.96/);
  });
});

describe('last calibration run and status (item_calibration_runs, item_calibrations)', () => {
  it('reports an old run as overdue and withholds a small run\'s learners and responses', async () => {
    await calibrationRun({ ago: '10 days', learners: 3, calibrated: 2, provisional: 1 });
    const calibration = (await api().get(jobsRoute).set(auth(operations.userId)).expect(200)).body.calibration;
    expect(calibration.status).toBe('OVERDUE');
    expect(calibration.runsRecorded).toBe(1);
    expect(calibration.lastRun).toMatchObject({
      algorithmId: 'item-calibration-2pl-v1', library: 'girth 0.8.0', minResponses: 30, ageDays: 10,
      learnersRead: withheld, responsesRead: null, itemsRead: 3,
      items: { calibrated: 2, provisional: 1, provisionalByReason: { TOO_FEW_RESPONSES: 1 } },
    });
  });

  it('reports the newest run as current, with its figures, and never an identifier', async () => {
    await calibrationRun({ ago: '1 hour', learners: 40, calibrated: 5, provisional: 2 });
    const body = (await api().get(jobsRoute).set(auth(security.userId)).expect(200)).body;
    expect(body.calibration.status).toBe('CURRENT');
    expect(body.calibration.runsRecorded).toBe(2);
    expect(body.calibration.lastRun).toMatchObject({ ageDays: 0, learnersRead: shown(40), responsesRead: 480, itemsRead: 7,
      items: { calibrated: 5, provisional: 2, provisionalByReason: { TOO_FEW_RESPONSES: 2 } } });
    expect(Date.parse(body.calibration.lastRun.recordedAt)).toBeGreaterThan(Date.parse(body.calibration.lastRun.generatedAt));
    expect(body.sandbox).toEqual({ state: 'NOT_BUILT', available: null, rejectedExecutions: null });
    expect(JSON.stringify(body.calibration)).not.toMatch(UUID_PATTERN);
  });
});
