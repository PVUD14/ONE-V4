/**
 * "Ask ONE to explain" end to end (ADR-052), on synthetic data and ENG-20's local fake endpoint (no pod, no
 * network). Pinned — Divakar's scoped waiver and every safeguard that came with it:
 *  - off by default: the screen is told OFF, every other route answers 404 with a plain sentence, nothing is
 *    recorded and no model is called; switching on needs a passing evaluation (0089), not bypassed;
 *  - a request is a job: POST answers 202 "preparing" with no model call; the outbox worker writes the lesson
 *    through ONE AI Orchestration (metered, against no student) with full provenance; the model receives only
 *    the normalised topic;
 *  - the cache: the next student asking the same topic gets the same lesson at once, with no model call;
 *  - the guard: unsafe, truncated or malformed output is never shown; a refusal is REFUSED, and cached;
 *  - limits: one lesson preparing per student, ten requests a day, the global cap, the kill switch;
 *  - report a mistake (PII-checked) flags the lesson; operations withdraw it (hidden at once) or promote it to
 *    a DRAFT official lesson with AI provenance; capabilities and audit rows;
 *  - it never writes attempts, evidence, mastery, skill state or readiness; employers and institutions see none
 *    of it; privacy export lists it and deletion removes the person's rows; the 0117 guards hold.
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
import { explainTopicPromptV1, lessonDraftHeadings, renderPrompt, servedModelAtRegistration } from '@planthepath/ai-orchestration/src/index.js';
import { completion, startFakeOpenAiServer, type FakeOpenAiServer } from '@planthepath/ai-orchestration/src/testing/fake-openai-server.js';
import { registerOneAiFeatures } from '@planthepath/persistence/src/ai-bake-off.js';
import { createLocalIntegrationEventPublisher, publishOutboxOnce } from '@planthepath/persistence/src/automation-workers.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { assembleSubjectExport } from './privacy-export.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for explain topic integration tests');

const schemaName = 'explain_topic_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const MODEL = servedModelAtRegistration;
// Test-only sentinel; not a credential.
const TEST_KEY = 'test-only-bearer-value-adr052';
const ENV_KEYS = ['ONE_AI_BASE_URL', 'ONE_AI_API_KEY', 'ONE_AI_MODEL'] as const;
const LABEL = 'AI-generated — not checked by a person';

const sentence = 'Nuclear fission splits a heavy nucleus into two lighter nuclei and releases energy, because the products are bound more tightly.';
const goodLesson = (extra = ''): string => [
  lessonDraftHeadings[0], 'How fission releases energy, in plain words.',
  lessonDraftHeadings[1], Array.from({ length: 6 }, () => sentence).join(' ') + (extra ? ` ${extra}` : ''),
  lessonDraftHeadings[2], Array.from({ length: 3 }, () => sentence).join(' '),
  lessonDraftHeadings[3], Array.from({ length: 2 }, () => sentence).join(' '),
  lessonDraftHeadings[4], 'Why does splitting a heavy nucleus release energy?',
].join('\n');

let app: INestApplication;
let server: FakeOpenAiServer;
let platformId: string;
let script: () => { text: string; finish?: string };
const savedEnv: Record<string, string | undefined> = {};
let editor: string;
let reviewer: string;
let plainOps: string;
let employer: string;
let institutionAdmin: string;

async function user(email?: string): Promise<string> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email ?? `${userId}@explain.test`]);
  return userId;
}

async function member(organizationId: string, role: string, grants: readonly string[] = [], grantor?: string): Promise<string> {
  const userId = await user();
  const membershipId = randomUUID();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,'ACTIVE',$2)`,
    [membershipId, organizationId, userId, role]);
  for (const capability of grants) {
    await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
      [randomUUID(), membershipId, capability, grantor ?? userId]);
  }
  return userId;
}

const api = () => request(app.getHttpServer());
const as = (userId: string) => ({ authorization: `Bearer ${userId}`, 'x-correlation-id': `explain-${randomUUID()}` });
const posts = () => server.requests.filter((entry) => entry.method === 'POST');
const ask = (userId: string, topic: unknown) => api().post('/api/v1/learning/explain').set(as(userId)).send({ topic });
const read = (userId: string, id: string) => api().get(`/api/v1/learning/explain/requests/${id}`).set(as(userId));

/** Drains the outbox through the real local dispatcher, as the worker does (ADR-028). */
async function drain(): Promise<void> {
  const local = createLocalIntegrationEventPublisher({ pool, db: db as unknown as PersistenceDb });
  for (let round = 0; round < 5; round += 1) {
    const clock = (await pool.query<{ at: Date }>("SELECT clock_timestamp() + interval '1 second' AS at")).rows[0]!.at;
    const result = await publishOutboxOnce({ db: db as unknown as PersistenceDb, publisher: local.publisher, leaseOwner: 'adr052-test', now: new Date(clock) });
    if (result.claimed === 0) return;
  }
}

async function switchOn(): Promise<void> {
  const passing = await pool.query("SELECT count(*)::int AS n FROM ai_evaluations WHERE feature_key = 'learning.explain-topic' AND decision = 'PASS'");
  if (passing.rows[0].n === 0) {
    await pool.query(`INSERT INTO ai_evaluations (id, feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version, metrics, decision, reason_code, decided_by_user_id, correlation_id)
      VALUES ($1,'learning.explain-topic','openai-compatible',$2,'explain-topic',1,'one-ai-explain',1,$3::jsonb,'PASS','INITIAL_BENCHMARK',$4,'adr052-test')`,
    [randomUUID(), MODEL, JSON.stringify([{ name: 'abuse_refusal_rate', value: 1, threshold: 1, comparator: 'AT_LEAST' }]), reviewer]);
  }
  await pool.query("UPDATE ai_feature_policies SET enabled = true, cap = 200 WHERE feature_key = 'learning.explain-topic'");
  await pool.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
}

async function lessonOf(requestId: string): Promise<Record<string, any>> {
  return (await pool.query('SELECT l.* FROM explain_lessons l JOIN explain_topic_requests r ON r.lesson_id = l.id WHERE r.id = $1', [requestId])).rows[0];
}

async function learningCounts(subjectUserId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ['evidence_records', 'mastery_projections', 'learning_attempt_events', 'learner_skill_state', 'readiness_snapshots', 'learner_progress', 'placement_tests', 'roadmap_actions']) {
    out[table] = (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE subject_user_id = $1`, [subjectUserId])).rows[0].n;
  }
  return out;
}

/** A unique topic per test, so tests sharing the schema never share a cache slot. */
const topic = (name: string) => `${name} ${randomUUID().slice(0, 8).replace(/\d/gu, 'x')}`;

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
  server = await startFakeOpenAiServer((recorded) => {
    if (recorded.authorization !== `Bearer ${TEST_KEY}`) return { status: 401, json: { error: 'unauthorised' } };
    const next = script();
    return { status: 200, json: completion(next.text, { prompt_tokens: 400, completion_tokens: 600 }, next.finish ?? 'stop', MODEL) };
  });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.ONE_AI_BASE_URL = server.baseUrl;
  process.env.ONE_AI_API_KEY = TEST_KEY;
  process.env.ONE_AI_MODEL = MODEL;

  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform (explain test)')", [platformId]);
  const superAdmin = await member(platformId, 'PLATFORM_SUPER_ADMIN');
  editor = await member(platformId, 'OPERATIONS_ADMIN', ['CONTENT_EDIT'], superAdmin);
  reviewer = await member(platformId, 'OPERATIONS_ADMIN', ['CONTENT_REVIEW'], superAdmin);
  plainOps = await member(platformId, 'OPERATIONS_ADMIN', [], superAdmin);
  const employerOrg = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Synthetic employer (explain test)')", [employerOrg]);
  employer = await member(employerOrg, 'EMPLOYER_ADMIN');
  const college = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Synthetic college (explain test)')", [college]);
  institutionAdmin = await member(college, 'INSTITUTION_ADMIN');
  // Registered as ENG-21 registers every feature: switched off.
  await registerOneAiFeatures(db);
}, 240_000);

afterAll(async () => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await server?.close();
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

beforeEach(() => {
  script = () => ({ text: goodLesson() });
  server.requests.length = 0;
});

describe('ADR-052: off by default, and on only through the evaluation gate', () => {
  it('requires a signed-in user and well-formed requests', async () => {
    expect((await api().get('/api/v1/learning/explain/status')).status).toBe(401);
    expect((await api().post('/api/v1/learning/explain').send({ topic: 'data science' })).status).toBe(401);
    expect((await api().get('/api/v1/operations/explain-lessons')).status).toBe(401);
    const student = await user();
    expect((await api().post('/api/v1/learning/explain').set(as(student)).send({ topic: 'x', extra: 1 })).status).toBe(400);
  });

  it('with the feature off the screen is told OFF and every other route answers 404 plainly; nothing is recorded', async () => {
    const student = await user();
    const status = await api().get('/api/v1/learning/explain/status').set(as(student));
    expect(status.status).toBe(200);
    expect(status.body.availability).toMatchObject({ available: false, reason: 'OFF', remainingToday: null });
    const refused = await ask(student, 'data science');
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ code: 'EXPLAIN_NOT_AVAILABLE', message: 'Ask ONE to explain is not available yet.' });
    expect((await api().get('/api/v1/learning/explain/requests').set(as(student))).status).toBe(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM explain_topic_requests WHERE subject_user_id = $1', [student])).rows[0].n).toBe(0);
    expect(posts()).toHaveLength(0);
  });

  it('switching on needs a passing evaluation for its model and prompt (0089)', async () => {
    await expect(pool.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'learning.explain-topic'")).rejects.toThrow(/evaluation/u);
    await switchOn();
    expect((await pool.query("SELECT enabled, prompt_key, prompt_version FROM ai_feature_policies WHERE feature_key = 'learning.explain-topic'")).rows[0])
      .toEqual({ enabled: true, prompt_key: 'explain-topic', prompt_version: 1 });
  });
});

describe('ADR-052: a lesson is a job, guarded, cached and labelled', () => {
  beforeEach(async () => { await switchOn(); });

  it('POST answers 202 preparing with no model call; the worker writes the lesson with provenance; the student reads it labelled', async () => {
    const student = await user();
    const name = topic('Nuclear  Physics');
    const asked = await ask(student, `  ${name} `);
    expect(asked.status).toBe(202);
    expect(asked.body.request).toMatchObject({ state: 'PREPARING', lesson: null, servedFromCache: false, reported: false });
    expect(posts()).toHaveLength(0);
    const pending = await lessonOf(asked.body.request.id);
    expect(pending).toMatchObject({ status: 'PENDING', review_state: 'AI_UNREVIEWED', source: 'AI_GENERATED', prompt_version: 'explain-topic@1', model: MODEL, generated_text: null });
    expect(pending.topic_key).toBe(name.toLowerCase().replace(/\s+/gu, ' '));
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'explain.lesson.requested' AND aggregate_id = $1", [pending.id])).rows[0].n).toBe(1);

    await drain();
    expect(posts()).toHaveLength(1);
    const sent = JSON.parse(posts()[0]!.body) as { model: string; messages: { role: string; content: string }[] };
    const expected = renderPrompt(explainTopicPromptV1, { topic: pending.topic_key });
    expect(sent.messages).toEqual([{ role: 'system', content: expected.system }, { role: 'user', content: expected.user }]);
    expect(posts()[0]!.body).not.toContain(student);
    expect(posts()[0]!.body).not.toContain('explain.test');

    const shown = await read(student, asked.body.request.id);
    expect(shown.status).toBe(200);
    expect(shown.body.request.state).toBe('READY');
    expect(shown.body.request.lesson.label).toBe(LABEL);
    expect(shown.body.request.lesson.sections.map((section: { heading: string }) => section.heading))
      .toEqual(['What you will learn', 'Explanation', 'Worked example', 'Common mistakes', 'Check yourself']);
    const done = await lessonOf(asked.body.request.id);
    expect(done).toMatchObject({ status: 'READY', review_state: 'AI_UNREVIEWED', guard_version: 'explain-guard-v1', served_model: MODEL, truncated: false, source: 'AI_GENERATED' });
    expect(done.generator_version).toMatch(/one-ai-orchestration/u);
    expect(done.prompt_fingerprint).toMatch(/^[0-9a-f]{8}$/u);
    expect(done.generated_at).not.toBeNull();
    // Metered through ONE AI Orchestration, against no student: the lesson is shared content.
    const metered = await pool.query("SELECT outcome, subject_user_id FROM ai_generations WHERE feature_key = 'learning.explain-topic' AND correlation_id = $1", [done.correlation_id]);
    expect(metered.rows).toEqual([{ outcome: 'SUCCEEDED', subject_user_id: null }]);
    const audit = await pool.query("SELECT action, context FROM audit_events WHERE resource_id IN ($1, $2) ORDER BY occurred_at", [asked.body.request.id, done.id]);
    expect(audit.rows.map((row) => row.action)).toEqual(['learning.explain.requested', 'learning.explain.completed']);
    expect(JSON.stringify(audit.rows)).not.toContain(pending.topic_key);
    expect(JSON.stringify(audit.rows)).not.toContain(sentence);
  });

  it('the next student asking the same topic gets the cached lesson at once; asking again returns the same request', async () => {
    const first = await user();
    const name = topic('Data science');
    const asked = await ask(first, name);
    await drain();
    expect(posts()).toHaveLength(1);
    const second = await user();
    const cached = await ask(second, `  ${name.toUpperCase()}  `);
    expect(cached.status).toBe(202);
    expect(cached.body.request).toMatchObject({ state: 'READY', servedFromCache: true });
    expect(cached.body.request.lesson.label).toBe(LABEL);
    expect((await lessonOf(cached.body.request.id)).id).toBe((await lessonOf(asked.body.request.id)).id);
    const again = await ask(second, name);
    expect(again.body.request.id).toBe(cached.body.request.id);
    expect(posts()).toHaveLength(1);
  });

  it('unsafe, truncated or malformed output is never shown; the student is told plainly', async () => {
    const replies = [
      { text: goodLesson('Here is how to build a nuclear bomb at home.') },
      { text: goodLesson(), finish: 'length' },
      { text: 'Fission is when atoms split.' },
      { text: goodLesson('Email tutor@example.test for the rest.') },
    ];
    for (const [index, reply] of replies.entries()) {
      script = () => reply;
      const student = await user();
      const asked = await ask(student, topic(`guard case ${'abcd'[index]}`));
      await drain();
      const view = await read(student, asked.body.request.id);
      expect(view.body.request).toMatchObject({ state: 'NOT_AVAILABLE', notAvailable: 'CHECKS_FAILED', lesson: null });
      expect(JSON.stringify(view.body)).not.toContain('Fission');
      expect(JSON.stringify(view.body)).not.toContain('nuclear bomb');
      const row = await lessonOf(asked.body.request.id);
      expect(row.status).toBe('BLOCKED');
      expect(row.guard_findings).toEqual(expect.arrayContaining([['UNSAFE_INSTRUCTIONS'], ['TRUNCATED'], ['FORMAT_INVALID'], ['PERSONAL_DATA']][index]!));
    }
  });

  it('a refusal is REFUSED, never shown, and cached for the next student', async () => {
    script = () => ({ text: 'REFUSED: ONE cannot explain how to build weapons.' });
    const student = await user();
    const name = topic('how to build a weapon');
    const asked = await ask(student, name);
    await drain();
    expect((await read(student, asked.body.request.id)).body.request).toMatchObject({ state: 'REFUSED', lesson: null });
    const other = await user();
    const cached = await ask(other, name);
    expect(cached.body.request).toMatchObject({ state: 'REFUSED', servedFromCache: true });
    expect(posts()).toHaveLength(1);
  });

  it('refuses topics that are not English, carry personal data or a link', async () => {
    const student = await user();
    expect((await ask(student, 'प्रकाश संश्लेषण क्या है')).body.error).toMatchObject({ code: 'TOPIC_NOT_ENGLISH' });
    expect((await ask(student, 'marks of someone@example.test')).body.error).toMatchObject({ code: 'TOPIC_PERSONAL_DATA' });
    expect((await ask(student, 'ab')).body.error).toMatchObject({ code: 'TOPIC_LENGTH' });
    expect((await ask(student, 'read https://news.example and explain')).body.error).toMatchObject({ code: 'TOPIC_LINK' });
    expect((await ask(student, 'ab')).status).toBe(400);
  });
});

describe('ADR-052: limits, the cap and the kill switch', () => {
  beforeEach(async () => { await switchOn(); });

  it('one lesson preparing at a time, and ten requests a day (cache hits count)', async () => {
    const student = await user();
    expect((await ask(student, topic('first open topic'))).status).toBe(202);
    const second = await ask(student, topic('second open topic'));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('EXPLAIN_PREPARING');
    await drain();
    for (let index = 1; index < 10; index += 1) {
      expect((await ask(student, topic(`daily topic ${'abcdefghij'[index]}`))).status).toBe(202);
      await drain();
    }
    const status = await api().get('/api/v1/learning/explain/status').set(as(student));
    expect(status.body.availability).toMatchObject({ available: false, reason: 'DAILY_LIMIT', remainingToday: 0 });
    const over = await ask(student, topic('eleventh topic'));
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'EXPLAIN_DAILY_LIMIT', message: 'You have asked for 10 lessons today. You can ask again tomorrow.' });
  });

  it('the global cap refuses a new topic with a plain sentence; a cached topic is still served', async () => {
    const student = await user();
    const cachedTopic = topic('cached before the cap');
    await ask(student, cachedTopic);
    await drain();
    const used = (await pool.query("SELECT count(*)::int AS n FROM ai_generations WHERE feature_key = 'learning.explain-topic' AND outcome = 'SUCCEEDED' AND occurred_at >= date_trunc('day', now())")).rows[0].n;
    await pool.query("UPDATE ai_feature_policies SET cap = $1 WHERE feature_key = 'learning.explain-topic'", [used]);
    try {
      const other = await user();
      const busy = await ask(other, topic('a brand new topic'));
      expect(busy.status).toBe(429);
      expect(busy.body.error.code).toBe('EXPLAIN_BUSY');
      expect((await ask(other, cachedTopic)).body.request).toMatchObject({ state: 'READY', servedFromCache: true });
    } finally {
      await pool.query("UPDATE ai_feature_policies SET cap = 200 WHERE feature_key = 'learning.explain-topic'");
    }
  });

  it('the kill switch stops the very next generation and reads as off everywhere', async () => {
    const student = await user();
    const asked = await ask(student, topic('kill switch topic'));
    await pool.query("UPDATE feature_flags SET enabled = true WHERE key = 'ai.global-kill-switch'");
    try {
      await drain();
      expect(posts()).toHaveLength(0);
      expect(await lessonOf(asked.body.request.id)).toMatchObject({ status: 'FAILED', failure_code: 'AI_UNAVAILABLE' });
      expect((await api().get('/api/v1/learning/explain/status').set(as(student))).body.availability.reason).toBe('OFF');
      expect((await read(student, asked.body.request.id)).status).toBe(404);
      const metered = await pool.query("SELECT outcome, failure_class FROM ai_generations WHERE feature_key = 'learning.explain-topic' AND correlation_id = $1", [(await lessonOf(asked.body.request.id)).correlation_id]);
      expect(metered.rows).toEqual([{ outcome: 'REFUSED', failure_class: 'KILL_SWITCH_ENGAGED' }]);
    } finally {
      await pool.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
    }
    // A failed attempt frees the topic: asking again prepares a new lesson.
    expect((await ask(student, (await lessonOf(asked.body.request.id)).topic_key)).body.request.state).toBe('PREPARING');
  });
});

describe('ADR-052: report a mistake, withdraw and promote', () => {
  beforeEach(async () => { await switchOn(); });

  async function readyLesson(): Promise<{ student: string; requestId: string; lessonId: string; topicKey: string }> {
    const student = await user();
    const asked = await ask(student, topic('reported topic'));
    await drain();
    const lesson = await lessonOf(asked.body.request.id);
    return { student, requestId: asked.body.request.id, lessonId: lesson.id, topicKey: lesson.topic_key };
  }

  it('a student reports a lesson once, with a reason and a note without personal data; the lesson is flagged', async () => {
    const { student, requestId, lessonId } = await readyLesson();
    const path = `/api/v1/learning/explain/requests/${requestId}/report`;
    expect((await api().post(path).set(as(student)).send({ reasonCode: 'NOPE' })).body.error.code).toBe('REPORT_REASON_INVALID');
    expect((await api().post(path).set(as(student)).send({ reasonCode: 'WRONG_FACT', note: 'call me on 98765 43210' })).body.error.code).toBe('NOTE_PERSONAL_DATA');
    const stranger = await user();
    expect((await api().post(path).set(as(stranger)).send({ reasonCode: 'WRONG_FACT' })).status).toBe(404);
    const reported = await api().post(path).set(as(student)).send({ reasonCode: 'WRONG_FACT', note: 'The second paragraph repeats itself.' });
    expect(reported.status).toBe(201);
    expect(reported.body.request).toMatchObject({ state: 'READY', reported: true });
    expect((await api().post(path).set(as(student)).send({ reasonCode: 'CONFUSING' })).status).toBe(409);
    expect((await pool.query('SELECT review_state FROM explain_lessons WHERE id = $1', [lessonId])).rows[0].review_state).toBe('FLAGGED');
  });

  it('operations see the flagged queue without any student identity; withdraw needs CONTENT_REVIEW and hides the lesson at once', async () => {
    const { student, requestId, lessonId, topicKey } = await readyLesson();
    await api().post(`/api/v1/learning/explain/requests/${requestId}/report`).set(as(student)).send({ reasonCode: 'UNSAFE', note: 'This looks wrong.' });
    for (const outsider of [plainOps, employer, institutionAdmin, student]) {
      expect((await api().get('/api/v1/operations/explain-lessons').set(as(outsider))).status, outsider).toBe(403);
    }
    const queue = await api().get('/api/v1/operations/explain-lessons?view=flagged').set(as(reviewer));
    expect(queue.status).toBe(200);
    const row = queue.body.lessons.find((entry: { id: string }) => entry.id === lessonId);
    expect(row).toMatchObject({ topic: topicKey, reviewState: 'FLAGGED', reports: 1, reportReasons: { UNSAFE: 1 }, reportNotes: ['This looks wrong.'], requests: 1 });
    expect(JSON.stringify(queue.body)).not.toContain(student);
    expect(queue.body.viewer).toEqual({ canWithdraw: true, canPromote: false });
    expect((await api().get('/api/v1/operations/explain-lessons?view=most-viewed').set(as(editor))).body.lessons.some((entry: { id: string }) => entry.id === lessonId)).toBe(true);

    expect((await api().post(`/api/v1/operations/explain-lessons/${lessonId}/withdraw`).set(as(editor)).send({ reasonCode: 'UNSAFE' })).status).toBe(403);
    expect((await api().post(`/api/v1/operations/explain-lessons/${lessonId}/withdraw`).set(as(reviewer)).send({ reasonCode: 'BECAUSE' })).status).toBe(400);
    const withdrawn = await api().post(`/api/v1/operations/explain-lessons/${lessonId}/withdraw`).set(as(reviewer)).send({ reasonCode: 'UNSAFE' });
    expect(withdrawn.status).toBe(201);
    expect(withdrawn.body.lesson).toEqual({ id: lessonId, reviewState: 'WITHDRAWN' });
    const view = await read(student, requestId);
    expect(view.body.request).toMatchObject({ state: 'NOT_AVAILABLE', notAvailable: 'WITHDRAWN', lesson: null });
    expect(JSON.stringify(view.body)).not.toContain(sentence);
    // The cache slot is kept: the same text is not generated again.
    const other = await user();
    expect((await ask(other, topicKey)).body.request).toMatchObject({ state: 'NOT_AVAILABLE', notAvailable: 'WITHDRAWN' });
    expect(posts()).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'operations.content.explain_lesson_withdrawn' AND resource_id = $1 AND actor_user_id = $2", [lessonId, reviewer])).rows[0].n).toBe(1);
    expect((await api().post(`/api/v1/operations/explain-lessons/${lessonId}/withdraw`).set(as(reviewer)).send({ reasonCode: 'UNSAFE' })).status).toBe(409);
  });

  it('promote needs CONTENT_EDIT and creates a DRAFT official lesson with AI provenance, authored by the promoter', async () => {
    const { student, requestId, lessonId } = await readyLesson();
    const body = { reasonCode: 'WORTH_OFFICIAL_LESSON', stableKey: `ai-explain-${randomUUID().slice(0, 8)}`, title: 'How fission releases energy', level: 'FOUNDATION', style: 'EXPLANATION' };
    expect((await api().post(`/api/v1/operations/explain-lessons/${lessonId}/promote`).set(as(reviewer)).send(body)).status).toBe(403);
    expect((await api().post(`/api/v1/operations/explain-lessons/${lessonId}/promote`).set(as(editor)).send({ ...body, level: 'EXPERT' })).status).toBe(400);
    const promoted = await api().post(`/api/v1/operations/explain-lessons/${lessonId}/promote`).set(as(editor)).send(body);
    expect(promoted.status).toBe(201);
    expect(promoted.body.lesson).toMatchObject({ id: lessonId, reviewState: 'PROMOTED' });
    const revision = (await pool.query('SELECT state, author_user_id, body FROM content_revisions WHERE id = $1', [promoted.body.lesson.revisionId])).rows[0];
    expect(revision).toMatchObject({ state: 'DRAFT', author_user_id: editor });
    expect(revision.body.provenance).toMatchObject({ source: 'AI_GENERATED', promptVersion: 'explain-topic@1', model: MODEL, jobId: lessonId });
    expect(revision.body.expertCheck).toMatch(/Ask ONE to explain/u);
    expect(revision.body.aiDraft.guard).toBe('explain-guard-v1');
    // Nothing is published by the promotion: no review action, no lesson version.
    expect((await pool.query('SELECT count(*)::int AS n FROM content_review_actions WHERE content_revision_id = $1', [promoted.body.lesson.revisionId])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM lesson_versions WHERE stable_key = $1', [body.stableKey])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT promoted_lesson_id::text AS id FROM explain_lessons WHERE id = $1', [lessonId])).rows[0].id).toBe(promoted.body.lesson.lessonId);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'operations.content.explain_lesson_promoted' AND resource_id = $1", [lessonId])).rows[0].n).toBe(1);
    // The student still reads it in Ask ONE to explain, still labelled as not checked by a person.
    expect((await read(student, requestId)).body.request.lesson.label).toBe(LABEL);
    expect((await api().post(`/api/v1/operations/explain-lessons/${lessonId}/promote`).set(as(editor)).send({ ...body, stableKey: `${body.stableKey}-b` })).status).toBe(409);
  });
});

describe('ADR-052: never counts, never seen by employers or colleges, and the person\'s own data', () => {
  beforeEach(async () => { await switchOn(); });

  it('asking, generating and reporting write no attempts, evidence, mastery, skill state or readiness', async () => {
    const student = await user();
    const before = await learningCounts(student);
    const asked = await ask(student, topic('boundary topic'));
    await drain();
    await api().post(`/api/v1/learning/explain/requests/${asked.body.request.id}/report`).set(as(student)).send({ reasonCode: 'CONFUSING' });
    expect(await learningCounts(student)).toEqual(before);
  });

  it('another person\'s request is not found; employers and institutions have no route to it', async () => {
    const student = await user();
    const asked = await ask(student, topic('private topic'));
    for (const other of [employer, institutionAdmin, await user()]) {
      expect((await read(other, asked.body.request.id)).status).toBe(404);
      const list = await api().get('/api/v1/learning/explain/requests').set(as(other));
      expect(JSON.stringify(list.body)).not.toContain(asked.body.request.id);
    }
  });

  it('the export lists the person\'s requests, shown lessons and reports; deletion removes their rows and keeps the shared lesson', async () => {
    const student = await user();
    const asked = await ask(student, topic('export topic'));
    await drain();
    await api().post(`/api/v1/learning/explain/requests/${asked.body.request.id}/report`).set(as(student)).send({ reasonCode: 'WRONG_FACT', note: 'One date is wrong.' });
    script = () => ({ text: goodLesson('Here is how to build a nuclear bomb at home.') });
    await ask(student, topic('blocked export topic'));
    await drain();
    const bundle = await assembleSubjectExport(db as unknown as PersistenceDb, student) as Record<string, any>;
    const section = bundle.learning.askOneToExplain;
    expect(section.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'LESSON_SHOWN', label: LABEL, promptVersion: 'explain-topic@1', reviewState: 'FLAGGED' }),
      expect.objectContaining({ outcome: 'NOT_AVAILABLE', lessonShown: null }),
    ]));
    expect(section.reports).toEqual([expect.objectContaining({ reasonCode: 'WRONG_FACT', note: 'One date is wrong.' })]);
    expect(JSON.stringify(bundle)).not.toContain('nuclear bomb');
    expect((bundle.notIncluded as string[]).join(' ')).toMatch(/Ask ONE to explain/u);

    const lessonId = (await lessonOf(asked.body.request.id)).id;
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
      VALUES ($1, $2, $2, 'DELETION', now() - interval '31 days', now() - interval '1 day')`, [randomUUID(), student]);
    const summaries = await executeDueDeletions({ db: db as unknown as PersistenceDb, ids: { uuid: () => randomUUID() } });
    expect(summaries.find((summary) => summary.subjectUserId === student)?.outcome).toBe('COMPLETED');
    expect((await pool.query('SELECT count(*)::int AS n FROM explain_topic_requests WHERE subject_user_id = $1', [student])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM explain_lesson_reports WHERE subject_user_id = $1', [student])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM explain_lessons WHERE id = $1', [lessonId])).rows[0].n).toBe(1);
  });

  it('the 0117 guards: a changed request, a rewritten generation, an illegal move or a deletion are refused', async () => {
    const student = await user();
    const asked = await ask(student, topic('guarded rows'));
    await drain();
    const lesson = await lessonOf(asked.body.request.id);
    await expect(pool.query("UPDATE explain_lessons SET topic_key = 'something else' WHERE id = $1", [lesson.id])).rejects.toThrow(/never changed/u);
    await expect(pool.query("UPDATE explain_lessons SET generated_text = 'rewritten' WHERE id = $1", [lesson.id])).rejects.toThrow(/written once/u);
    await expect(pool.query("UPDATE explain_lessons SET status = 'PENDING' WHERE id = $1", [lesson.id])).rejects.toThrow(/forward/u);
    await expect(pool.query('DELETE FROM explain_lessons WHERE id = $1', [lesson.id])).rejects.toThrow(/never deleted/u);
    await expect(pool.query('DELETE FROM explain_topic_requests WHERE id = $1', [asked.body.request.id])).rejects.toThrow(/privacy deletion/u);
    await expect(pool.query("UPDATE explain_topic_requests SET topic_text = 'other' WHERE id = $1", [asked.body.request.id])).rejects.toThrow(/never change/u);
    await expect(pool.query(`INSERT INTO explain_lessons (id, topic_key, feature_key, prompt_version, model, correlation_id, status)
      VALUES ($1, 'x topic', 'learning.explain-topic', 'explain-topic@1', $2, 'c', 'READY')`, [randomUUID(), MODEL])).rejects.toThrow();
    await pool.query("UPDATE explain_lessons SET review_state = 'WITHDRAWN', reviewed_by_user_id = $2, review_reason_code = 'UNSAFE' WHERE id = $1", [lesson.id, reviewer]);
    await expect(pool.query("UPDATE explain_lessons SET review_state = 'AI_UNREVIEWED', reviewed_by_user_id = NULL, reviewed_at = NULL, review_reason_code = NULL WHERE id = $1", [lesson.id])).rejects.toThrow(/never back/u);
  });
});
