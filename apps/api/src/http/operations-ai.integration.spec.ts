/**
 * The AI Operations console over HTTP (OPS-12).
 *
 * Every figure comes from ai_generations or ai_feature_policies (or ai_evaluations and the AI
 * flags), or shows NA — cost is always NA. Switching off, the global kill switch and switching the
 * assistant off are immediate and need no approval; switching a feature on needs a passing
 * evaluation for its current model and prompt version and an OPS-02 approval bound to exactly that;
 * widening a limit needs an approval; releasing the kill switch is a high-risk flag change. The
 * kill switch stops every AI feature and the assistant in one action. Every write is audited.
 *
 * No model is ever called: the assistant's provider fetch is stubbed to fail loudly, and every
 * chat request here is made with at least one switch off.
 *
 * Real Postgres in a throwaway schema.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { loadAiFeaturePolicy } from '@planthepath/persistence/src/ai-orchestration.js';
import { createWorkerAiOrchestrator, runAiProviderProbe } from '@planthepath/persistence/src/ai-workers.js';
import { PromptRegistry } from '@planthepath/ai-orchestration/src/index.js';
import { startFakeOpenAiServer } from '@planthepath/ai-orchestration/src/testing/fake-openai-server.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PlatformControlsController } from './platform-controls.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for AI operations tests');

const schemaName = 'ops_ai_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let collegeId: string;
let smallCollegeId: string;
let security: Member;
let operations: Member;
let configurer: Member;
let superAdmin: Member;
let secondSuperAdmin: Member;
let suspendedConfigurer: Member;
let collegeAdmin: Member;
const providerCalls: unknown[] = [];
// Captured before the stub below, for ENG-20's local fake endpoint only (127.0.0.1, never the network).
const loopbackFetch = globalThis.fetch;
const savedEnv = { enabled: process.env.ASSISTANT_ENABLED, key: process.env.ANTHROPIC_API_KEY };

interface Member { readonly userId: string; readonly membershipId: string; readonly email: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

beforeAll(async () => {
  // The assistant's server switch and a key are set, so only the console switches stand between a
  // chat request and the provider — and the provider is a stub that records and refuses.
  process.env.ASSISTANT_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'not-a-real-key-ops12';
  vi.stubGlobal('fetch', async (...args: unknown[]) => { providerCalls.push(args[0]); throw new Error('no model may be called in this test'); });
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
    // The existing feature-flag endpoint, for releasing the kill switch and switching the assistant on.
    controllers: [PlatformControlsController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  collegeId = randomUUID();
  smallCollegeId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Large AI test college')", [collegeId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Small AI test college')", [smallCollegeId]);
  security = await member('SECURITY_ADMIN');
  operations = await member('OPERATIONS_ADMIN');
  configurer = await member('OPERATIONS_ADMIN');
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  secondSuperAdmin = await member('PLATFORM_SUPER_ADMIN');
  suspendedConfigurer = await member('OPERATIONS_ADMIN');
  collegeAdmin = await member('INSTITUTION_ADMIN', 'ACTIVE', collegeId);
  await grant(configurer, 'AI_OPS_CONFIGURE');
  await grant(suspendedConfigurer, 'AI_OPS_CONFIGURE');
  await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [suspendedConfigurer.membershipId]);
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  if (savedEnv.enabled === undefined) delete process.env.ASSISTANT_ENABLED; else process.env.ASSISTANT_ENABLED = savedEnv.enabled;
  if (savedEnv.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedEnv.key;
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

async function member(role: string, state = 'ACTIVE', organizationId?: string): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  const email = 'staff-' + userId.slice(0, 8) + '@example.test';
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : organizationId ?? collegeId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId, email };
}

async function grant(target: Member, capability: string): Promise<void> {
  await pool.query(
    'INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), target.membershipId, capability, superAdmin?.userId ?? target.userId, 'NEW_RESPONSIBILITY'],
  );
}

async function student(institutionId: string): Promise<string> {
  const userId = randomUUID();
  await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, 'learner-' + userId.slice(0, 8) + '@college.example.test']);
  await pool.query(
    "INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE',now() - interval '30 days')",
    [randomUUID(), institutionId, userId],
  );
  return userId;
}

/** A feature as registration code would create it: off, with a model, a cap and (optionally) a prompt. */
async function feature(options: { readonly prompt?: boolean; readonly cap?: number; readonly window?: 'DAY' | 'MONTH' } = {}): Promise<string> {
  const key = 'ops12.f-' + randomUUID().slice(0, 8);
  await pool.query(
    `INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, max_input_chars, prompt_key, prompt_version)
     VALUES ($1,'An OPS-12 test feature','local/test-model-a',$2,$3,4000,$4,$5)`,
    [key, options.cap ?? 100, options.window ?? 'DAY', options.prompt === false ? null : 'ops12.prompt', options.prompt === false ? null : 1],
  );
  return key;
}

async function generation(featureKey: string, input: { readonly subject?: string | null; readonly outcome?: 'SUCCEEDED' | 'REFUSED' | 'FAILED'; readonly failureClass?: string; readonly tokens?: [number, number]; readonly ago?: string; readonly prompt?: [string, number] } = {}): Promise<void> {
  const outcome = input.outcome ?? 'SUCCEEDED';
  await pool.query(
    `INSERT INTO ai_generations (id, feature_key, subject_user_id, prompt_key, prompt_version, provider_key, model, input_tokens, output_tokens, outcome, failure_class, correlation_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,'stub','local/test-model-a',$6,$7,$8,$9,'ops12-gen-corr', now() - $10::interval)`,
    [randomUUID(), featureKey, input.subject ?? null, input.prompt?.[0] ?? 'ops12.prompt', input.prompt?.[1] ?? 1, input.tokens?.[0] ?? 10, input.tokens?.[1] ?? 5,
      outcome, outcome === 'SUCCEEDED' ? null : input.failureClass ?? 'FEATURE_DISABLED', input.ago ?? '0 seconds'],
  );
}

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-ai-' + randomUUID() });
const base = '/api/v1/operations/ai';
const passingMetrics = [{ name: 'task_accuracy', value: 0.92, threshold: 0.85, comparator: 'AT_LEAST' }, { name: 'unsafe_rate', value: 0, threshold: 0.01, comparator: 'AT_MOST' }];
const evaluation = (featureKey: string, over: Record<string, unknown> = {}) => ({
  featureKey, providerKey: 'bedrock', model: 'local/test-model-a', promptKey: 'ops12.prompt', promptVersion: 1,
  evaluationSetKey: 'ops12.benchmark', evaluationSetVersion: 1, metrics: passingMetrics, decision: 'PASS', reasonCode: 'INITIAL_BENCHMARK', ...over,
});

async function recordPass(featureKey: string, over: Record<string, unknown> = {}): Promise<string> {
  const response = await api().post(base + '/evaluations').set(auth(configurer.userId)).send(evaluation(featureKey, over));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.evaluation.id as string;
}
function requestApproval(actor: Member, actionKey: string, payload: Record<string, unknown>) {
  return api().post('/api/v1/operations/approvals').set(auth(actor.userId)).send({ actionKey, payload });
}
function decide(actor: Member, approvalId: string, decision: 'APPROVE' | 'REJECT' = 'APPROVE') {
  return api().post(`/api/v1/operations/approvals/${approvalId}/decision`).set(auth(actor.userId))
    .send({ decision, reasonCode: decision === 'APPROVE' ? 'VERIFIED_NEED' : 'NOT_NEEDED' });
}
async function approved(requester: Member, actionKey: string, payload: Record<string, unknown>, approver: Member = superAdmin): Promise<string> {
  const filed = await requestApproval(requester, actionKey, payload);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const decided = await decide(approver, filed.body.approval.id);
  expect(decided.status, JSON.stringify(decided.body)).toBe(201);
  return filed.body.approval.id as string;
}
function enable(actor: Member, featureKey: string, body: Record<string, unknown>) {
  return api().post(`${base}/features/${featureKey}/enable`).set(auth(actor.userId)).send(body);
}
async function enabledNow(featureKey: string): Promise<boolean> {
  return (await pool.query('SELECT enabled FROM ai_feature_policies WHERE feature_key=$1', [featureKey])).rows[0].enabled as boolean;
}
async function auditRows(action: string, resourceId: string): Promise<{ context: Record<string, unknown>; actor_user_id: string; correlation_id: string }[]> {
  return (await pool.query('SELECT context, actor_user_id, correlation_id FROM audit_events WHERE action=$1 AND resource_id=$2 ORDER BY occurred_at', [action, resourceId])).rows;
}
/** Switch a feature on through the whole governed path: evaluation, approval, execution. */
async function switchedOn(featureKey: string): Promise<void> {
  await recordPass(featureKey);
  const approvalId = await approved(configurer, 'AI_FEATURE_ENABLE', { featureKey, reasonCode: 'EVALUATION_COMPLETE' });
  const done = await enable(configurer, featureKey, { reasonCode: 'EVALUATION_COMPLETE', approvalId });
  expect(done.status, JSON.stringify(done.body)).toBe(201);
}
async function killSwitchOff(): Promise<void> {
  const engaged = (await pool.query("SELECT enabled FROM feature_flags WHERE key='ai.global-kill-switch'")).rows[0].enabled as boolean;
  if (!engaged) return;
  const approvalId = await approved(operations, 'FEATURE_FLAG_HIGH_RISK_CHANGE', { key: 'ai.global-kill-switch', enabled: false, reasonCode: 'ROLLBACK' });
  await api().post('/api/v1/operations/feature-flags/ai.global-kill-switch/state').set(auth(operations.userId))
    .send({ enabled: false, reasonCode: 'ROLLBACK', approvalId }).expect(201);
}
const chat = () => api().post('/api/v1/assistant/chat').set(auth(operations.userId)).send({ persona: 'student', messages: [{ role: 'user', content: 'How do I apply?' }] });

describe('authorisation', () => {
  it('returns 401 without a token on every route', async () => {
    await api().get(base + '/policy').expect(401);
    await api().get(base + '/summary').expect(401);
    await api().get(base + '/usage').expect(401);
    await api().get(base + '/usage/organizations').expect(401);
    await api().get(base + '/evaluations').expect(401);
    await api().post(base + '/evaluations').send({}).expect(401);
    await api().post(base + '/features/ops12.none/disable').send({}).expect(401);
    await api().post(base + '/features/ops12.none/enable').send({}).expect(401);
    await api().post(base + '/features/ops12.none/limits').send({}).expect(401);
    await api().post(base + '/kill-switch/engage').send({}).expect(401);
    await api().post(base + '/assistant/disable').send({}).expect(401);
  });

  it('returns 403 to an ACTIVE institution admin on every route, and changes nothing', async () => {
    const key = await feature();
    const as = auth(collegeAdmin.userId);
    const calls = [
      () => api().get(base + '/policy').set(as), () => api().get(base + '/summary').set(as), () => api().get(base + '/usage').set(as),
      () => api().get(base + '/usage/organizations').set(as), () => api().get(base + '/evaluations').set(as),
      () => api().post(base + '/evaluations').set(as).send(evaluation(key)),
      () => api().post(`${base}/features/${key}/disable`).set(as).send({ reasonCode: 'ROLLBACK' }),
      () => api().post(`${base}/features/${key}/enable`).set(as).send({ reasonCode: 'EVALUATION_COMPLETE' }),
      () => api().post(`${base}/features/${key}/limits`).set(as).send({ cap: 50, capWindow: 'DAY', maxInputChars: 4000, reasonCode: 'COST_CONTROL' }),
      () => api().post(base + '/kill-switch/engage').set(as).send({ reasonCode: 'PRECAUTION' }),
      () => api().post(base + '/assistant/disable').set(as).send({ reasonCode: 'PRECAUTION' }),
    ];
    for (const call of calls) {
      const response = await call();
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
    expect((await pool.query("SELECT enabled FROM feature_flags WHERE key='ai.global-kill-switch'")).rows[0].enabled).toBe(false);
    expect((await pool.query('SELECT 1 FROM ai_evaluations WHERE feature_key=$1', [key])).rowCount).toBe(0);
  });

  it('lets AI_OPS_VIEW read, keeps configuring to AI_OPS_CONFIGURE, and denies a suspended membership', async () => {
    const key = await feature();
    await api().get(base + '/summary').set(auth(security.userId)).expect(200);
    await api().get(base + '/summary').set(auth(operations.userId)).expect(200);
    // Security and Operations admins hold AI_OPS_VIEW and OPS_FLAGS_MANAGE, not AI_OPS_CONFIGURE.
    for (const actor of [security, operations]) {
      expect((await api().post(base + '/evaluations').set(auth(actor.userId)).send(evaluation(key))).status).toBe(403);
      expect((await api().post(`${base}/features/${key}/limits`).set(auth(actor.userId)).send({ cap: 50, capWindow: 'DAY', maxInputChars: 4000, reasonCode: 'COST_CONTROL' })).status).toBe(403);
      expect((await enable(actor, key, { reasonCode: 'EVALUATION_COMPLETE' })).status).toBe(403);
    }
    const policy = await api().get(base + '/policy').set(auth(operations.userId)).expect(200);
    expect(policy.body.viewer).toEqual({ canStop: true, canConfigure: false });
    expect((await api().get(base + '/policy').set(auth(configurer.userId)).expect(200)).body.viewer).toEqual({ canStop: true, canConfigure: true });
    // A suspended membership holds nothing, its grant included.
    expect((await api().get(base + '/summary').set(auth(suspendedConfigurer.userId))).status).toBe(403);
    expect((await api().post(base + '/evaluations').set(auth(suspendedConfigurer.userId)).send(evaluation(key))).status).toBe(403);
  });

  it('audits the super admin configuring AI as break-glass, and an ordinary grant holder as not', async () => {
    const key = await feature();
    const bySuper = await api().post(base + '/evaluations').set(auth(superAdmin.userId)).send(evaluation(key));
    expect(bySuper.status, JSON.stringify(bySuper.body)).toBe(201);
    expect((await auditRows('operations.ai.evaluation.recorded', bySuper.body.evaluation.id))[0]!.context.break_glass).toBe(true);
    const byGrant = await recordPass(key);
    expect((await auditRows('operations.ai.evaluation.recorded', byGrant))[0]!.context.break_glass).toBeUndefined();
  });
});

describe('reading: every figure has a source, or NA', () => {
  it('summarises features, outcomes, failure classes, tokens and prompts from the orchestration tables; cost is NA', async () => {
    const key = await feature({ cap: 7 });
    const subject = await student(collegeId);
    await generation(key, { subject, tokens: [120, 30] });
    await generation(key, { subject, tokens: [80, 20] });
    await generation(key, { outcome: 'REFUSED', failureClass: 'CAP_EXCEEDED', tokens: [0, 0] });
    await generation(key, { outcome: 'FAILED', failureClass: 'PROVIDER_FAILED', tokens: [0, 0], prompt: ['ops12.other', 3] });
    // Last month: outside today's window and today's cap.
    await generation(key, { subject, tokens: [999, 999], ago: '40 days' });

    const response = await api().get(base + '/summary').set(auth(security.userId)).expect(200);
    const row = response.body.features.find((entry: { featureKey: string }) => entry.featureKey === key);
    expect(row).toMatchObject({
      enabled: false, effectiveEnabled: false, model: 'local/test-model-a', cap: 7, capWindow: 'DAY', maxInputChars: 4000,
      prompt: { key: 'ops12.prompt', version: 1 }, usedInWindow: 2,
      evaluation: { state: 'NONE', evaluationId: null, decidedAt: null },
      outcomes: { succeeded: 2, refused: 1, failed: 1 }, tokens: { input: 200, output: 50 },
    });
    expect(response.body.failureClasses).toEqual(expect.arrayContaining([
      { featureKey: key, outcome: 'REFUSED', failureClass: 'CAP_EXCEEDED', count: 1 },
      { featureKey: key, outcome: 'FAILED', failureClass: 'PROVIDER_FAILED', count: 1 },
    ]));
    expect(response.body.cost).toMatchObject({ value: null, basis: 'NO_PRICE_TABLE' });
    // The code registry lists the prompts ONE's features run (ENG-21 registered the first three), with
    // their purpose and never their text; prompts in use come from ai_generations.
    expect(response.body.prompts.registered).toEqual([
      { key: 'tutor-hint', version: 1, purpose: expect.any(String) },
      { key: 'content-lesson-draft', version: 1, purpose: expect.any(String) },
      { key: 'content-answer-check', version: 1, purpose: expect.any(String) },
    ]);
    expect(JSON.stringify(response.body.prompts.registered)).not.toContain('never reveal');
    expect(response.body.prompts.inUse).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'ops12.other', version: 3, generations: 1, registered: false }),
    ]));
    expect(response.body.prompts.declared).toEqual(expect.arrayContaining([{ featureKey: key, key: 'ops12.prompt', version: 1, registered: false }]));
    expect(response.body.assistant).toMatchObject({ serverSwitch: true, providerKeyConfigured: true, consoleSwitch: false, answering: false });
    // Nothing identifying a person, and no key value, ever leaves.
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(subject);
    expect(text).not.toContain('not-a-real-key-ops12');

    const month = await api().get(base + '/summary?period=MONTH').set(auth(security.userId)).expect(200);
    expect(month.body.period).toBe('MONTH');
    await api().get(base + '/summary?period=YEAR').set(auth(security.userId)).expect(400);
    await api().get(base + '/summary?unknown=1').set(auth(security.userId)).expect(400);
  });

  it('reports usage by day and by month from ai_generations, optionally for one feature', async () => {
    const key = await feature();
    await generation(key, { tokens: [5, 5] });
    await generation(key, { outcome: 'REFUSED', failureClass: 'FEATURE_DISABLED', ago: '1 day' });
    const daily = await api().get(`${base}/usage?granularity=DAY&featureKey=${key}`).set(auth(security.userId)).expect(200);
    expect(daily.body.points).toHaveLength(2);
    expect(daily.body.points[0]).toMatchObject({ featureKey: key, succeeded: 1, refused: 0, failed: 0, inputTokens: 5, outputTokens: 5 });
    expect(daily.body.points[0].period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const monthly = await api().get(`${base}/usage?granularity=MONTH&featureKey=${key}`).set(auth(security.userId)).expect(200);
    expect(monthly.body.points[0].period).toMatch(/^\d{4}-\d{2}$/);
    await api().get(`${base}/usage?granularity=WEEK`).set(auth(security.userId)).expect(400);
    await api().get(`${base}/usage?featureKey=NOT A KEY`).set(auth(security.userId)).expect(400);
  });

  it('reports usage by organisation and withholds every figure for a group under 5 people', async () => {
    const key = await feature();
    // A college of its own, so no other test's generations are attributed to it.
    const largeId = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Large AI usage college')", [largeId]);
    for (let index = 0; index < 5; index += 1) await generation(key, { subject: await student(largeId), tokens: [7, 3] });
    for (let index = 0; index < 2; index += 1) await generation(key, { subject: await student(smallCollegeId) });
    await generation(key, { subject: null });
    const response = await api().get(base + '/usage/organizations?period=DAY').set(auth(security.userId)).expect(200);
    const rows = response.body.organizations as { organizationName: string | null; noSubject: boolean; suppressed: boolean; people: number | null; succeeded: number | null; inputTokens: number | null }[];
    expect(rows.find((row) => row.organizationName === 'Large AI usage college')).toMatchObject({ suppressed: false, people: 5, succeeded: 5, inputTokens: 35 });
    expect(rows.find((row) => row.organizationName === 'Small AI test college')).toMatchObject({ suppressed: true, people: null, succeeded: null, inputTokens: null });
    expect(rows.find((row) => row.noSubject)).toMatchObject({ suppressed: false, people: null });
    expect(response.body.suppressionThreshold).toBe(5);
  });

  it('pages evaluations by keyset within bounds, newest first, with no repeats', async () => {
    const key = await feature();
    const ids = [await recordPass(key), await recordPass(key), await recordPass(key)];
    const first = await api().get(`${base}/evaluations?featureKey=${key}&limit=2`).set(auth(security.userId)).expect(200);
    expect(first.body.evaluations).toHaveLength(2);
    const second = await api().get(`${base}/evaluations?featureKey=${key}&limit=2&cursor=${first.body.nextCursor}`).set(auth(security.userId)).expect(200);
    const seen = [...first.body.evaluations, ...second.body.evaluations].map((row: { id: string }) => row.id);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(second.body.nextCursor).toBeNull();
    // Only the newest is the current verdict for the combination.
    expect(first.body.evaluations[0].current).toBe(true);
    expect(first.body.evaluations[1].current).toBe(false);
    await api().get(`${base}/evaluations?limit=0`).set(auth(security.userId)).expect(400);
    await api().get(`${base}/evaluations?limit=201`).set(auth(security.userId)).expect(400);
    await api().get(`${base}/evaluations?cursor=not-a-cursor`).set(auth(security.userId)).expect(400);
  });
});

describe('evaluations', () => {
  it('records a PASS only when every metric meets its threshold, validates input, and never edits a record', async () => {
    const key = await feature();
    const below = await api().post(base + '/evaluations').set(auth(configurer.userId))
      .send(evaluation(key, { metrics: [{ name: 'task_accuracy', value: 0.5, threshold: 0.85, comparator: 'AT_LEAST' }] }));
    expect(below.status).toBe(400);
    expect(below.body.error.code).toBe('AI_EVALUATION_PASS_BELOW_THRESHOLD');
    const failed = await api().post(base + '/evaluations').set(auth(configurer.userId))
      .send(evaluation(key, { decision: 'FAIL', metrics: [{ name: 'task_accuracy', value: 0.5, threshold: 0.85, comparator: 'AT_LEAST' }] }));
    expect(failed.status).toBe(201);
    for (const bad of [
      evaluation(key, { metrics: [] }),
      evaluation(key, { metrics: [{ name: 'Bad Name', value: 1, threshold: 1, comparator: 'AT_LEAST' }] }),
      evaluation(key, { metrics: [{ name: 'x_rate', value: '1', threshold: 1, comparator: 'AT_LEAST' }] }),
      evaluation(key, { decision: 'MAYBE' }),
      evaluation(key, { reasonCode: 'BECAUSE' }),
      evaluation(key, { promptVersion: 0 }),
      evaluation(key, { providerKey: 'Not A Provider' }),
      { ...evaluation(key), transcript: 'a model answer' },
    ]) {
      expect((await api().post(base + '/evaluations').set(auth(configurer.userId)).send(bad)).status).toBe(400);
    }
    const missing = await api().post(base + '/evaluations').set(auth(configurer.userId)).send(evaluation('ops12.never-registered'));
    expect(missing.status).toBe(404);
    // The trigger repeats the rules for any other writer.
    await expect(pool.query('UPDATE ai_evaluations SET decision=$2 WHERE id=$1', [failed.body.evaluation.id, 'PASS'])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM ai_evaluations WHERE id=$1', [failed.body.evaluation.id])).rejects.toThrow(/never deleted/);
    await expect(pool.query(
      `INSERT INTO ai_evaluations (id, feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version, metrics, decision, reason_code, decided_by_user_id, correlation_id)
       VALUES ($1,$2,'bedrock','local/test-model-a','ops12.prompt',1,'ops12.benchmark',1,$3::jsonb,'PASS','INITIAL_BENCHMARK',$4,'ops12-direct-insert')`,
      [randomUUID(), key, JSON.stringify([{ name: 'task_accuracy', value: 0.1, threshold: 0.9, comparator: 'AT_LEAST' }]), configurer.userId],
    )).rejects.toThrow(/every threshold/);
    const audit = await auditRows('operations.ai.evaluation.recorded', failed.body.evaluation.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.context).toMatchObject({ featureKey: key, decision: 'FAIL', reasonCode: 'INITIAL_BENCHMARK', model: 'local/test-model-a' });
    expect((await pool.query("SELECT 1 FROM outbox_events WHERE event_type='ai_evaluation.recorded' AND aggregate_id=$1", [failed.body.evaluation.id])).rowCount).toBe(1);
  });
});

describe('switching a feature on', () => {
  it('is blocked without a passing evaluation for the current model and prompt, and without a declared prompt', async () => {
    const key = await feature();
    const noEvaluation = await requestApproval(configurer, 'AI_FEATURE_ENABLE', { featureKey: key, reasonCode: 'EVALUATION_COMPLETE' });
    expect(noEvaluation.status).toBe(409);
    expect(noEvaluation.body.error.code).toBe('AI_EVALUATION_REQUIRED');
    const direct = await enable(configurer, key, { reasonCode: 'EVALUATION_COMPLETE' });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('AI_EVALUATION_REQUIRED');
    // A pass for another model or another prompt version does not count.
    await recordPass(key, { model: 'local/test-model-b' });
    await recordPass(key, { promptVersion: 2 });
    expect((await enable(configurer, key, { reasonCode: 'EVALUATION_COMPLETE' })).body.error.code).toBe('AI_EVALUATION_REQUIRED');
    // A later FAIL overturns an earlier PASS.
    await recordPass(key);
    await api().post(base + '/evaluations').set(auth(configurer.userId)).send(evaluation(key, { decision: 'FAIL', reasonCode: 'INCIDENT_REVIEW' })).expect(201);
    expect((await enable(configurer, key, { reasonCode: 'EVALUATION_COMPLETE' })).body.error.code).toBe('AI_EVALUATION_REQUIRED');
    // The database refuses it too, for any writer.
    await expect(pool.query('UPDATE ai_feature_policies SET enabled=true WHERE feature_key=$1', [key])).rejects.toThrow(/passing evaluation/);

    const undeclared = await feature({ prompt: false });
    const refused = await requestApproval(configurer, 'AI_FEATURE_ENABLE', { featureKey: undeclared, reasonCode: 'EVALUATION_COMPLETE' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('AI_PROMPT_UNDECLARED');
    expect(await enabledNow(key)).toBe(false);
    expect(await enabledNow(undeclared)).toBe(false);
  });

  it('needs an approval bound to the model, prompt and evaluation, from someone other than the requester, used once', async () => {
    const key = await feature();
    const evaluationId = await recordPass(key);
    const withoutApproval = await enable(configurer, key, { reasonCode: 'EVALUATION_COMPLETE' });
    expect(withoutApproval.status).toBe(403);
    expect(withoutApproval.body.error.code).toBe('APPROVAL_REQUIRED');

    const filed = await requestApproval(configurer, 'AI_FEATURE_ENABLE', { featureKey: key, reasonCode: 'EVALUATION_COMPLETE' });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect(filed.body.approval.payload).toEqual({ featureKey: key, model: 'local/test-model-a', promptKey: 'ops12.prompt', promptVersion: 1, evaluationId, reasonCode: 'EVALUATION_COMPLETE' });
    expect(filed.body.approval.summary).toMatchObject({ aiFeatureKey: key, aiModel: 'local/test-model-a', aiPromptKey: 'ops12.prompt', aiPromptVersion: 1 });
    // The requester cannot approve: this one holds no APPROVE_HIGH_RISK at all.
    expect((await decide(configurer, filed.body.approval.id)).status).toBe(403);
    // Unapproved: still refused.
    expect((await enable(configurer, key, { reasonCode: 'EVALUATION_COMPLETE', approvalId: filed.body.approval.id })).body.error.code).toBe('APPROVAL_NOT_APPROVED');
    await decide(superAdmin, filed.body.approval.id).expect(201);
    // Only the requester executes, and the reason is part of the payload.
    expect((await enable(superAdmin, key, { reasonCode: 'EVALUATION_COMPLETE', approvalId: filed.body.approval.id })).body.error.code).toBe('APPROVAL_NOT_REQUESTER');
    expect((await enable(configurer, key, { reasonCode: 'PILOT_ROLLOUT', approvalId: filed.body.approval.id })).body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    const done = await enable(configurer, key, { reasonCode: 'EVALUATION_COMPLETE', approvalId: filed.body.approval.id });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.features.find((row: { featureKey: string }) => row.featureKey === key)).toMatchObject({ enabled: true, effectiveEnabled: true, evaluation: { state: 'PASS', evaluationId } });
    const audit = await auditRows('operations.ai.feature.enabled', key);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_user_id).toBe(configurer.userId);
    expect(audit[0]!.context).toMatchObject({
      reasonCode: 'EVALUATION_COMPLETE', evaluationId, model: 'local/test-model-a', promptVersion: 1, mode: 'DUAL',
      requestedByUserId: configurer.userId, approvedByUserId: superAdmin.userId,
    });
    expect((await pool.query("SELECT 1 FROM outbox_events WHERE event_type='ai_feature_policy.changed' AND payload->>'change'='ENABLED' AND correlation_id=$1", [audit[0]!.correlation_id])).rowCount).toBe(1);
    // Used once.
    await api().post(`${base}/features/${key}/disable`).set(auth(operations.userId)).send({ reasonCode: 'ROLLBACK' }).expect(201);
    expect((await enable(configurer, key, { reasonCode: 'EVALUATION_COMPLETE', approvalId: filed.body.approval.id })).body.error.code).toBe('APPROVAL_NOT_APPROVED');
  });

  it('refuses a super admin approving their own request while a second approver exists', async () => {
    const key = await feature();
    await recordPass(key);
    const filed = await requestApproval(superAdmin, 'AI_FEATURE_ENABLE', { featureKey: key, reasonCode: 'PILOT_ROLLOUT' });
    expect(filed.status).toBe(201);
    const self = await decide(superAdmin, filed.body.approval.id);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('APPROVAL_SELF_DECISION_REFUSED');
    await decide(secondSuperAdmin, filed.body.approval.id).expect(201);
    await enable(superAdmin, key, { reasonCode: 'PILOT_ROLLOUT', approvalId: filed.body.approval.id }).expect(201);
    expect((await auditRows('operations.ai.feature.enabled', key))[0]!.context).toMatchObject({ break_glass: true, mode: 'DUAL' });
  });

  it('rejects an approval whose binding changed: a later FAIL, a model change, or expiry', async () => {
    const failedLater = await feature();
    await recordPass(failedLater);
    const firstApproval = await approved(configurer, 'AI_FEATURE_ENABLE', { featureKey: failedLater, reasonCode: 'EVALUATION_COMPLETE' });
    await api().post(base + '/evaluations').set(auth(configurer.userId)).send(evaluation(failedLater, { decision: 'FAIL', reasonCode: 'INCIDENT_REVIEW' })).expect(201);
    const blocked = await enable(configurer, failedLater, { reasonCode: 'EVALUATION_COMPLETE', approvalId: firstApproval });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('AI_EVALUATION_REQUIRED');

    const modelChanged = await feature();
    await recordPass(modelChanged);
    const secondApproval = await approved(configurer, 'AI_FEATURE_ENABLE', { featureKey: modelChanged, reasonCode: 'EVALUATION_COMPLETE' });
    await pool.query("UPDATE ai_feature_policies SET model='local/test-model-b' WHERE feature_key=$1", [modelChanged]);
    await recordPass(modelChanged, { model: 'local/test-model-b' });
    const mismatch = await enable(configurer, modelChanged, { reasonCode: 'EVALUATION_COMPLETE', approvalId: secondApproval });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    expect(await enabledNow(modelChanged)).toBe(false);

    const expired = await feature();
    await recordPass(expired);
    const thirdApproval = await approved(configurer, 'AI_FEATURE_ENABLE', { featureKey: expired, reasonCode: 'EVALUATION_COMPLETE' });
    await backdate(thirdApproval, '25 hours');
    expect((await enable(configurer, expired, { reasonCode: 'EVALUATION_COMPLETE', approvalId: thirdApproval })).body.error.code).toBe('APPROVAL_EXPIRED');
    expect(await enabledNow(expired)).toBe(false);
  });

  it('switches an enabled feature off when its model changes without a passing evaluation (0089 trigger)', async () => {
    const key = await feature();
    await switchedOn(key);
    await pool.query("UPDATE ai_feature_policies SET model='local/unevaluated' WHERE feature_key=$1", [key]);
    expect(await enabledNow(key)).toBe(false);
  });
});

describe('switching off and changing limits', () => {
  it('switches a feature off at once with no approval, audited, and says when it is already off', async () => {
    const key = await feature();
    await switchedOn(key);
    const off = await api().post(`${base}/features/${key}/disable`).set(auth(security.userId)).send({ reasonCode: 'INCIDENT_MITIGATION' });
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect(await enabledNow(key)).toBe(false);
    const audit = await auditRows('operations.ai.feature.disabled', key);
    expect(audit[0]!.context).toMatchObject({ reasonCode: 'INCIDENT_MITIGATION', from: { enabled: true }, to: { enabled: false } });
    expect(audit[0]!.actor_user_id).toBe(security.userId);
    const again = await api().post(`${base}/features/${key}/disable`).set(auth(security.userId)).send({ reasonCode: 'INCIDENT_MITIGATION' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AI_FEATURE_ALREADY_DISABLED');
    expect((await api().post(`${base}/features/${key}/disable`).set(auth(security.userId)).send({ reasonCode: 'WHY_NOT' })).status).toBe(400);
    expect((await api().post(`${base}/features/${key}/disable`).set(auth(security.userId)).send({ reasonCode: 'ROLLBACK', extra: 1 })).status).toBe(400);
    expect((await api().post(`${base}/features/ops12.nowhere/disable`).set(auth(security.userId)).send({ reasonCode: 'ROLLBACK' })).status).toBe(404);
  });

  it('lowers limits without approval and needs one to raise a cap, change the window or raise the input limit', async () => {
    const key = await feature({ cap: 100 });
    const lowered = await api().post(`${base}/features/${key}/limits`).set(auth(configurer.userId)).send({ cap: 50, capWindow: 'DAY', maxInputChars: 2000, reasonCode: 'COST_CONTROL' });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(201);
    expect(lowered.body.change).toBe('LOWER');
    expect((await auditRows('operations.ai.feature.limits_changed', key))[0]!.context).toMatchObject({
      change: 'LOWER', reasonCode: 'COST_CONTROL', from: { cap: 100, capWindow: 'DAY', maxInputChars: 4000 }, to: { cap: 50, capWindow: 'DAY', maxInputChars: 2000 },
    });
    // A raise reason for a lowering, an unchanged request, and an approval where none is needed are refused.
    expect((await api().post(`${base}/features/${key}/limits`).set(auth(configurer.userId)).send({ cap: 40, capWindow: 'DAY', maxInputChars: 2000, reasonCode: 'DEMAND_GROWTH' })).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await api().post(`${base}/features/${key}/limits`).set(auth(configurer.userId)).send({ cap: 50, capWindow: 'DAY', maxInputChars: 2000, reasonCode: 'COST_CONTROL' })).body.error.code).toBe('AI_LIMITS_UNCHANGED');
    for (const bad of [{ cap: 0 }, { cap: 1.5 }, { capWindow: 'YEAR' }, { maxInputChars: 99 }, { maxInputChars: 500_001 }]) {
      expect((await api().post(`${base}/features/${key}/limits`).set(auth(configurer.userId)).send({ cap: 50, capWindow: 'DAY', maxInputChars: 2000, reasonCode: 'COST_CONTROL', ...bad })).status).toBe(400);
    }

    for (const widened of [{ cap: 80, capWindow: 'DAY', maxInputChars: 2000 }, { cap: 50, capWindow: 'MONTH', maxInputChars: 2000 }, { cap: 50, capWindow: 'DAY', maxInputChars: 3000 }]) {
      const refused = await api().post(`${base}/features/${key}/limits`).set(auth(configurer.userId)).send({ ...widened, reasonCode: 'DEMAND_GROWTH' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('APPROVAL_REQUIRED');
    }
    const notNeeded = await requestApproval(configurer, 'AI_FEATURE_LIMITS_RAISE', { featureKey: key, cap: 10, capWindow: 'DAY', maxInputChars: 2000, reasonCode: 'CORRECTION' });
    expect(notNeeded.status).toBe(400);
    expect(notNeeded.body.error.code).toBe('APPROVAL_NOT_REQUIRED');
    const approvalId = await approved(configurer, 'AI_FEATURE_LIMITS_RAISE', { featureKey: key, cap: 80, capWindow: 'DAY', maxInputChars: 2000, reasonCode: 'DEMAND_GROWTH' });
    // Bound to the exact limits.
    expect((await api().post(`${base}/features/${key}/limits`).set(auth(configurer.userId)).send({ cap: 90, capWindow: 'DAY', maxInputChars: 2000, reasonCode: 'DEMAND_GROWTH', approvalId })).body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH');
    const raised = await api().post(`${base}/features/${key}/limits`).set(auth(configurer.userId)).send({ cap: 80, capWindow: 'DAY', maxInputChars: 2000, reasonCode: 'DEMAND_GROWTH', approvalId });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    expect(raised.body.change).toBe('RAISE');
    const rows = await auditRows('operations.ai.feature.limits_changed', key);
    expect(rows[rows.length - 1]!.context).toMatchObject({ change: 'RAISE', approvalId, mode: 'DUAL', approvedByUserId: superAdmin.userId });
    expect((await pool.query('SELECT cap FROM ai_feature_policies WHERE feature_key=$1', [key])).rows[0].cap).toBe(80);
  });
});

describe('the global kill switch', () => {
  it('stops every AI feature and the assistant in one action with no approval, and releasing it needs one', async () => {
    const first = await feature();
    const second = await feature();
    await switchedOn(first);
    await switchedOn(second);
    // The assistant switched on the governed way: a high-risk flag change, approved.
    const assistantApproval = await approved(operations, 'FEATURE_FLAG_HIGH_RISK_CHANGE', { key: 'ai.assistant', enabled: true, reasonCode: 'PILOT_ROLLOUT' });
    await api().post('/api/v1/operations/feature-flags/ai.assistant/state').set(auth(operations.userId)).send({ enabled: true, reasonCode: 'PILOT_ROLLOUT', approvalId: assistantApproval }).expect(201);
    // Engage at once: nothing is allowed to reach the provider stub below.
    const engaged = await api().post(base + '/kill-switch/engage').set(auth(operations.userId)).send({ reasonCode: 'INCIDENT_MITIGATION' });
    expect(engaged.status, JSON.stringify(engaged.body)).toBe(201);
    expect(engaged.body.assistantSwitchedOff).toBe(true);
    expect(engaged.body.featuresSwitchedOff).toBeGreaterThanOrEqual(2);
    expect(engaged.body.killSwitch).toMatchObject({ enabled: true, lastReasonCode: 'INCIDENT_MITIGATION' });

    const summary = await api().get(base + '/summary').set(auth(security.userId)).expect(200);
    expect(summary.body.features.every((row: { enabled: boolean; effectiveEnabled: boolean }) => !row.enabled && !row.effectiveEnabled)).toBe(true);
    expect(summary.body.assistant).toMatchObject({ consoleSwitch: false, killSwitchEngaged: true, answering: false });
    expect((await loadAiFeaturePolicy(pool, first))?.enabled).toBe(false);

    const audit = await auditRows('operations.ai.kill_switch.engaged', 'ai.global-kill-switch');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.context).toMatchObject({ reasonCode: 'INCIDENT_MITIGATION', assistantSwitchedOff: true });
    expect(audit[0]!.context.featuresSwitchedOff).toEqual(expect.arrayContaining([first, second]));
    expect((await auditRows('operations.ai.feature.disabled', first))[0]!.context).toMatchObject({ via: 'KILL_SWITCH', reasonCode: 'INCIDENT_MITIGATION' });
    const flagEvents = await pool.query("SELECT flag_key, change_kind, reason_code FROM feature_flag_events WHERE correlation_id=$1 ORDER BY flag_key", [audit[0]!.correlation_id]);
    expect(flagEvents.rows).toEqual([
      { flag_key: 'ai.assistant', change_kind: 'DISABLED', reason_code: 'INCIDENT_MITIGATION' },
      { flag_key: 'ai.global-kill-switch', change_kind: 'ENABLED', reason_code: 'INCIDENT_MITIGATION' },
    ]);
    expect((await pool.query("SELECT 1 FROM outbox_events WHERE event_type='ai_kill_switch.engaged' AND correlation_id=$1", [audit[0]!.correlation_id])).rowCount).toBe(1);

    // While engaged nothing switches on: not by approval request, not by the API, not by the database.
    expect((await api().post(base + '/kill-switch/engage').set(auth(operations.userId)).send({ reasonCode: 'PRECAUTION' })).body.error.code).toBe('AI_KILL_SWITCH_ALREADY_ENGAGED');
    const refusedRequest = await requestApproval(configurer, 'AI_FEATURE_ENABLE', { featureKey: first, reasonCode: 'INCIDENT_RESOLVED' });
    expect(refusedRequest.status).toBe(409);
    expect(refusedRequest.body.error.code).toBe('AI_KILL_SWITCH_ENGAGED');
    await expect(pool.query('UPDATE ai_feature_policies SET enabled=true WHERE feature_key=$1', [first])).rejects.toThrow(/kill switch/);
    // The assistant refuses even with its flag forced on at the database: the kill switch wins.
    await pool.query("UPDATE feature_flags SET enabled=true WHERE key='ai.assistant'");
    const refusedChat = await chat();
    expect(refusedChat.status).toBe(503);
    expect(refusedChat.body.error.code).toBe('ASSISTANT_UNCONFIGURED');
    await pool.query("UPDATE feature_flags SET enabled=false WHERE key='ai.assistant'");

    // Releasing is a high-risk flag change: refused without an approval.
    const release = await api().post('/api/v1/operations/feature-flags/ai.global-kill-switch/state').set(auth(operations.userId)).send({ enabled: false, reasonCode: 'ROLLBACK' });
    expect(release.status).toBe(403);
    expect(release.body.error.code).toBe('APPROVAL_REQUIRED');
    await killSwitchOff();
    // Releasing switches nothing back on.
    expect(await enabledNow(first)).toBe(false);
    expect(await enabledNow(second)).toBe(false);
    expect(providerCalls).toEqual([]);
  });
});

describe('the in-app assistant', () => {
  it('stays off by default even with ASSISTANT_ENABLED and a key set, and the console switches it off without a restart', async () => {
    await killSwitchOff();
    expect((await pool.query("SELECT enabled, high_risk_direction FROM feature_flags WHERE key='ai.assistant'")).rows[0]).toEqual({ enabled: false, high_risk_direction: 'ENABLE' });
    const offByDefault = await chat();
    expect(offByDefault.status).toBe(503);
    expect(offByDefault.body.error.code).toBe('ASSISTANT_UNCONFIGURED');
    // Switching it on is a high-risk flag change: no approval, no change.
    const unapproved = await api().post('/api/v1/operations/feature-flags/ai.assistant/state').set(auth(operations.userId)).send({ enabled: true, reasonCode: 'PILOT_ROLLOUT' });
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.error.code).toBe('APPROVAL_REQUIRED');

    // Switching it off from the console: set the flag on at the database, then switch it off.
    await pool.query("UPDATE feature_flags SET enabled=true WHERE key='ai.assistant'");
    const off = await api().post(base + '/assistant/disable').set(auth(security.userId)).send({ reasonCode: 'SUSPECTED_KEY_COMPROMISE' });
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    expect(off.body.assistantFlag).toMatchObject({ enabled: false, lastReasonCode: 'SUSPECTED_KEY_COMPROMISE' });
    const audit = await auditRows('operations.ai.assistant.disabled', 'ai.assistant');
    expect(audit[audit.length - 1]!.context).toMatchObject({ reasonCode: 'SUSPECTED_KEY_COMPROMISE' });
    expect(audit[audit.length - 1]!.actor_user_id).toBe(security.userId);
    const refused = await chat();
    expect(refused.status).toBe(503);
    const again = await api().post(base + '/assistant/disable').set(auth(security.userId)).send({ reasonCode: 'PRECAUTION' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('AI_ASSISTANT_ALREADY_OFF');
    expect(providerCalls).toEqual([]);
  });
});

describe('the approval vocabulary', () => {
  it('keeps every earlier extended approval key, and knows the two new ones', async () => {
    const keys = await pool.query(`
      SELECT k, operation_approval_extended_target_type(k) AS target FROM unnest(ARRAY[
        'CAREER_REQUIREMENT_SET_PUBLISH','CONTENT_SKILL_PUBLISH','CONTENT_QUESTION_PUBLISH','CONTENT_LESSON_PUBLISH','COMMS_TEMPLATE_PUBLISH',
        'INSTITUTION_DATA_PURGE','AI_FEATURE_ENABLE','AI_FEATURE_LIMITS_RAISE','NOT_A_KEY']) AS k`);
    expect(Object.fromEntries(keys.rows.map((row: { k: string; target: string | null }) => [row.k, row.target]))).toEqual({
      CAREER_REQUIREMENT_SET_PUBLISH: 'career_requirement_set', CONTENT_SKILL_PUBLISH: 'content_revision', CONTENT_QUESTION_PUBLISH: 'content_revision',
      CONTENT_LESSON_PUBLISH: 'content_revision', COMMS_TEMPLATE_PUBLISH: 'status_notice_template', INSTITUTION_DATA_PURGE: 'institution_offboarding',
      AI_FEATURE_ENABLE: 'ai_feature_policy', AI_FEATURE_LIMITS_RAISE: 'ai_feature_policy', NOT_A_KEY: null,
    });
  });
});

// Last, because it suspends every other platform membership in this schema to leave exactly one approver.
describe('the solo-operator safeguard', () => {
  it('lets the sole approver raise a limit on their own request only after the cooling-off, marked SOLO', async () => {
    const key = await feature({ cap: 10 });
    const suspended = await pool.query(
      "UPDATE organization_memberships SET state='SUSPENDED' WHERE organization_id=$1 AND user_id<>$2 AND state='ACTIVE' RETURNING id",
      [platformId, superAdmin.userId],
    );
    try {
      const filed = await requestApproval(superAdmin, 'AI_FEATURE_LIMITS_RAISE', { featureKey: key, cap: 20, capWindow: 'DAY', maxInputChars: 4000, reasonCode: 'PILOT_EXPANSION' });
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);
      const tooSoon = await decide(superAdmin, filed.body.approval.id);
      expect(tooSoon.status).toBe(403);
      expect(tooSoon.body.error.code).toBe('APPROVAL_SOLO_COOLING_OFF');
      await backdate(filed.body.approval.id, '16 minutes');
      const solo = await decide(superAdmin, filed.body.approval.id);
      expect(solo.status).toBe(201);
      expect(solo.body.approval).toMatchObject({ state: 'APPROVED', mode: 'SOLO' });
      await api().post(`${base}/features/${key}/limits`).set(auth(superAdmin.userId))
        .send({ cap: 20, capWindow: 'DAY', maxInputChars: 4000, reasonCode: 'PILOT_EXPANSION', approvalId: filed.body.approval.id }).expect(201);
      const rows = await auditRows('operations.ai.feature.limits_changed', key);
      expect(rows[0]!.context).toMatchObject({ mode: 'SOLO', break_glass: true });
    } finally {
      await pool.query("UPDATE organization_memberships SET state='ACTIVE' WHERE id = ANY($1::uuid[])", [suspended.rows.map((row: { id: string }) => row.id)]);
    }
  });
});

/** Move a request back in time. The trigger forbids this, so it is bypassed by the owner. */
async function backdate(approvalId: string, interval: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE operation_approvals DISABLE TRIGGER operation_approval_guard');
    await client.query('UPDATE operation_approvals SET requested_at = requested_at - $2::interval, expires_at = expires_at - $2::interval WHERE id=$1', [approvalId, interval]);
    await client.query('ALTER TABLE operation_approvals ENABLE TRIGGER operation_approval_guard');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('the inference endpoint (ENG-20)', () => {
  // Test-only sentinels; neither is a credential.
  const testKey = 'test-only-bearer-value-eng20-api';
  const upstreamText = 'UPSTREAM-DETAIL-must-not-reach-a-browser';
  const inferenceVariables = ['ONE_AI_BASE_URL', 'ONE_AI_API_KEY', 'ONE_AI_MODEL'] as const;

  async function withInferenceEnv<T>(values: Partial<Record<(typeof inferenceVariables)[number], string>>, work: () => Promise<T>): Promise<T> {
    const saved = inferenceVariables.map((name) => [name, process.env[name]] as const);
    for (const name of inferenceVariables) {
      if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
    }
    try {
      return await work();
    } finally {
      for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }

  it('reads as unconfigured, with its reason, when the variables are blank', async () => {
    await withInferenceEnv({}, async () => {
      const response = await api().get(base + '/summary').set(auth(security.userId)).expect(200);
      expect(response.body.inference).toMatchObject({ configured: false, reason: 'BASE_URL_MISSING', providerKey: 'unconfigured', endpointHost: null, keyConfigured: false });
    });
  });

  it('shows configured, host, model and the latest probe; no response carries the key, the URL or upstream text', async () => {
    await killSwitchOff();
    const model = 'local/test-model-a';
    const server = await startFakeOpenAiServer((sent) => (sent.path.endsWith('/models')
      ? { status: 200, json: { object: 'list', data: [{ id: model }] } }
      : { status: 500, raw: `${upstreamText} ${testKey}` }));
    try {
      const env = { ONE_AI_BASE_URL: server.baseUrl, ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model };
      await withInferenceEnv(env, async () => {
        const before = await api().get(base + '/summary').set(auth(security.userId)).expect(200);
        expect(before.body.inference).toMatchObject({ configured: true, reason: null, providerKey: 'openai-compatible', endpointHost: new URL(server.baseUrl).host, model, keyConfigured: true, lastProbe: null });

        // The probe and the failing generation run as a worker would — never through a route.
        const requestsBefore = server.requests.length;
        await runAiProviderProbe({ db: pool, env, tuning: { fetchImpl: loopbackFetch } });
        const featureKey = 'eng20.f-' + randomUUID().slice(0, 8);
        await pool.query(
          `INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, enabled)
           VALUES ($1, 'An ENG-20 test feature', $2, 5, 'DAY', true)`, [featureKey, model],
        );
        const prompt = { key: 'eng20.prompt', version: 1, purpose: 'Test fixture.', system: 'You draft.', parameters: [], user: 'Draft.', maxOutputTokens: 32, temperature: 0 };
        const { orchestrator } = createWorkerAiOrchestrator({
          db: pool, env, prompts: new PromptRegistry([prompt]),
          tuning: { fetchImpl: loopbackFetch, sleep: async () => undefined, timeoutMs: 2_000 },
        });
        await expect(orchestrator.generate({ featureKey, promptKey: 'eng20.prompt', promptVersion: 1, parameters: {}, correlationId: 'eng20-api-corr' })).rejects.toThrow();
        expect(server.requests.length - requestsBefore).toBe(4); // one probe, three attempts

        const summary = await api().get(base + '/summary').set(auth(security.userId)).expect(200);
        expect(summary.body.inference.lastProbe).toMatchObject({ configured: true, reachable: true, modelServed: true, failureClass: null, matchesConfiguration: true, model });
        expect(summary.body.failureClasses).toEqual(expect.arrayContaining([{ featureKey, outcome: 'FAILED', failureClass: 'PROVIDER_SERVER_ERROR', count: 1 }]));
        const row = summary.body.features.find((entry: { featureKey: string }) => entry.featureKey === featureKey);
        expect(row).toMatchObject({ outcomes: { succeeded: 0, refused: 0, failed: 1 }, averageLatencyMs: null });

        const surfaced = [
          summary,
          await api().get(base + '/summary?period=MONTH').set(auth(security.userId)).expect(200),
          await api().get(base + '/usage').set(auth(security.userId)).expect(200),
          await api().get(base + '/usage/organizations').set(auth(security.userId)).expect(200),
          await api().get(base + '/evaluations').set(auth(security.userId)).expect(200),
          await api().get(base + '/policy').set(auth(security.userId)).expect(200),
        ].map((response) => response.text).join(' | ');
        expect(surfaced).not.toContain(testKey);
        expect(surfaced).not.toContain('UPSTREAM-DETAIL');
        expect(surfaced).not.toContain(server.baseUrl);
      });

      // A probe taken for this endpoint does not vouch for a different one configured later.
      await withInferenceEnv({ ONE_AI_BASE_URL: 'https://another-pod.example.test/v1', ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model }, async () => {
        const later = await api().get(base + '/summary').set(auth(security.userId)).expect(200);
        expect(later.body.inference.lastProbe).toMatchObject({ reachable: true, matchesConfiguration: false });
        expect(later.text).not.toContain(testKey);
      });
    } finally {
      await server.close();
    }
  });
});
