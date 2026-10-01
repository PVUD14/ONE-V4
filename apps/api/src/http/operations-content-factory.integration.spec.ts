/**
 * The content factory end to end (ENG-23): "Draft with AI" over HTTP, the worker through ONE AI
 * Orchestration against ENG-20's local fake endpoint (no pod, no network), and the editors' own
 * review and publish path.
 *
 * Pinned — C13 and the product rules:
 *  - a request only queues a job (no call to the endpoint from the API); the worker runs it;
 *  - a draft lands as DRAFT with full provenance (source AI_GENERATED, generator and prompt version,
 *    model, generated time), labelled AI draft, authored by the requester;
 *  - nothing an AI wrote is published by the system: it stays DRAFT with no review action until
 *    people act; the requester cannot approve it or publish it; it publishes only through the
 *    second-person approval like any lesson, and students then get only the learner text;
 *  - the cap stops calls with a typed error: AI_CAP_REACHED at request, CAP_EXCEEDED on the job,
 *    with no request reaching the endpoint; the kill switch and a switched-off feature likewise;
 *  - the guard keeps a reply with personal data out, and a model refusal lands nothing;
 *  - a Telugu variant is marked for native-speaker review; an item and its hint ladder keep AI
 *    provenance at submission; an answer check is shown only to answer-key holders;
 *  - §6.6 minimums: 401, 403, input 400s, 404, audit rows.
 * Real Postgres in a throwaway schema; synthetic data only.
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { getPublishedCareerReadinessCatalog, publishCareerReadinessPilot, type PilotFixture } from '@planthepath/persistence/src/career-readiness.js';
import { registerOneAiFeatures } from '@planthepath/persistence/src/ai-bake-off.js';
import { createWorkerAiOrchestrator } from '@planthepath/persistence/src/ai-workers.js';
import { runContentFactoryOnce } from '@planthepath/persistence/src/content-factory-worker.js';
import type { TransactionalRunner } from '@planthepath/persistence/src/content-factory.js';
import { completion, startFakeOpenAiServer, type FakeOpenAiServer, type RecordedRequest } from '@planthepath/ai-orchestration/src/testing/fake-openai-server.js';
import { oneAiFeatures, servedModelAtRegistration } from '@planthepath/ai-orchestration/src/index.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for content factory tests');

const schemaName = 'content_factory_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
// Test-only sentinel; not a credential.
const testKey = 'test-only-bearer-value-eng23';
let app: INestApplication;
let server: FakeOpenAiServer;
let platformId: string;
let fixture: PilotFixture;
let topicKey: string;
let baseLessonId: string;

interface Member { readonly userId: string; readonly membershipId: string }
let approver: Member;
let editor: Member;
let secondEditor: Member;
let thirdEditor: Member;
let reviewer: Member;
let publisher: Member;
let plainOperations: Member;
let superAdmin: Member | undefined;

async function user(): Promise<string> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  return userId;
}

async function member(role: string, grants: readonly string[] = []): Promise<Member> {
  const userId = await user();
  const membershipId = randomUUID();
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,'ACTIVE',$2)`,
    [membershipId, platformId, userId, role],
  );
  for (const capability of grants) {
    await pool.query(
      "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
      [randomUUID(), membershipId, capability, superAdmin?.userId ?? userId],
    );
  }
  return { userId, membershipId };
}

// ---------------------------------------------------------------------------
// The fake endpoint's replies, chosen by which prompt arrived
// ---------------------------------------------------------------------------

const sentence = 'A subnet groups addresses that share a network prefix, and the mask says how many bits that prefix uses.';
const paragraph = (count: number): string => Array.from({ length: count }, () => sentence).join(' ');
const englishLesson = (check = 'How many usable hosts does a /26 network have? Work it out before reading on.'): string => [
  '## What you will learn', 'How to read a subnet mask and count the hosts it allows.',
  '## Explanation', paragraph(6), '## Worked example', paragraph(4), '## Common mistakes', paragraph(2), '## Check yourself', check,
].join('\n');
const teluguSentence = 'సబ్‌నెట్ అనేది ఒకే నెట్‌వర్క్ ప్రిఫిక్స్‌ను పంచుకునే చిరునామాల సమూహం, మాస్క్ ఆ ప్రిఫిక్స్ ఎన్ని బిట్‌లను వాడుతుందో చెబుతుంది.';
const telugu = (count: number): string => Array.from({ length: count }, () => teluguSentence).join(' ');
const teluguLesson = (): string => [
  '## What you will learn', telugu(1), '## Explanation', telugu(6), '## Worked example', telugu(4), '## Common mistakes', telugu(2), '## Check yourself', telugu(1),
].join('\n');
const itemReply = (): string => JSON.stringify({
  prompt: 'A network uses the mask 255.255.255.224. How many usable host addresses does each subnet have?',
  options: ['30', '32', '14', '62'], correct: 'a',
  explanation: 'The mask leaves 5 host bits: 2^5 = 32 addresses, minus the network and broadcast addresses, gives 30.',
  hints: [
    'Think about how many bits the mask leaves for hosts.',
    'Count the host bits, raise 2 to that power, then remove the addresses a subnet cannot give to a host.',
    'The last octet 224 is 11100000 in binary, so 5 bits are left for hosts.',
    'Two to the fifth power is 32; two of those addresses are reserved.',
  ],
});

let lessonReply: (request: RecordedRequest) => string = () => englishLesson();
let checkReply = '{"option": "a", "working": "Five host bits give 32 addresses, less two reserved."}';

function reply(recorded: RecordedRequest): string {
  const body = JSON.parse(recorded.body) as { messages: { content: string }[] };
  const system = body.messages[0]!.content;
  if (system.startsWith('You draft short lessons')) return lessonReply(recorded);
  if (system.startsWith('You draft practice questions')) return itemReply();
  return checkReply;
}

const environment = () => ({ ONE_AI_BASE_URL: server.baseUrl, ONE_AI_API_KEY: testKey, ONE_AI_MODEL: servedModelAtRegistration });
const workerDb = drizzle(pool) as unknown as TransactionalRunner;
function runWorker(env: Record<string, string> = environment()) {
  const { orchestrator } = createWorkerAiOrchestrator({ db: pool, env, tuning: { sleep: async () => undefined, timeoutMs: 2_000 } });
  return runContentFactoryOnce({ db: workerDb, generator: orchestrator });
}
async function drainWorker(): Promise<number> {
  let ran = 0;
  while (await runWorker()) ran += 1;
  return ran;
}
const posts = (): RecordedRequest[] => server.requests.filter((entry) => entry.method === 'POST');

async function setFeature(featureKey: string, change: { enabled?: boolean; cap?: number }): Promise<void> {
  if (change.cap !== undefined) await pool.query('UPDATE ai_feature_policies SET cap = $2 WHERE feature_key = $1', [featureKey, change.cap]);
  if (change.enabled !== undefined) await pool.query('UPDATE ai_feature_policies SET enabled = $2 WHERE feature_key = $1', [featureKey, change.enabled]);
}
async function setKillSwitch(engaged: boolean): Promise<void> {
  await pool.query("UPDATE feature_flags SET enabled = $1 WHERE key = 'ai.global-kill-switch'", [engaged]);
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
  server = await startFakeOpenAiServer((recorded) => {
    if (recorded.authorization !== `Bearer ${testKey}`) return { status: 401, json: { error: 'unauthorised' } };
    return { status: 200, json: completion(reply(recorded), { prompt_tokens: 300, completion_tokens: 500 }, 'stop', servedModelAtRegistration) };
  });

  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  approver = await member('SECURITY_ADMIN', ['APPROVE_HIGH_RISK']);
  await member('SECURITY_ADMIN', ['APPROVE_HIGH_RISK']);
  editor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH']);
  secondEditor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT']);
  thirdEditor = await member('OPERATIONS_ADMIN', ['CONTENT_EDIT']);
  reviewer = await member('OPERATIONS_ADMIN', ['CONTENT_REVIEW']);
  publisher = await member('OPERATIONS_ADMIN', ['CONTENT_PUBLISH']);
  plainOperations = await member('OPERATIONS_ADMIN');

  const pilotBytes = await readFile(new URL('../../../../data/career-readiness/pilot-v1.json', import.meta.url));
  fixture = JSON.parse(pilotBytes.toString('utf8')) as PilotFixture;
  const actors = { authorUserId: await user(), reviewerUserId: await user(), publisherUserId: await user() };
  await publishCareerReadinessPilot(pool, fixture, createHash('sha256').update(pilotBytes).digest('hex'), actors);
  topicKey = fixture.topics[0]!.stableKey;
  baseLessonId = fixture.lessons[0]!.id;

  // The three content features, registered switched off (ENG-21), then a passing evaluation of the
  // exact model and prompt each runs — the 0089 gate — and switched on.
  await registerOneAiFeatures(db);
  const recorder = await user();
  for (const feature of oneAiFeatures.filter((entry) => entry.featureKey.startsWith('content.'))) {
    await pool.query(
      `INSERT INTO ai_evaluations (id, feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version, metrics, decision, reason_code, decided_by_user_id, correlation_id)
       VALUES ($1,$2,'openai-compatible',$3,$4,$5,'eng23-fixture',1,$6::jsonb,'PASS','INITIAL_BENCHMARK',$7,'eng23-evaluation')`,
      [randomUUID(), feature.featureKey, feature.defaultModel, feature.prompt.key, feature.prompt.version,
        JSON.stringify([{ name: 'format_pass_rate', value: 1, threshold: 0.9, comparator: 'AT_LEAST' }]), recorder],
    );
    await setFeature(feature.featureKey, { enabled: true });
  }
}, 240_000);

afterAll(async () => {
  await server?.close();
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

beforeEach(async () => {
  server.requests.length = 0;
  lessonReply = () => englishLesson();
  checkReply = '{"option": "a", "working": "Five host bits give 32 addresses, less two reserved."}';
  await setKillSwitch(false);
  for (const featureKey of ['content.lesson-draft', 'content.item-draft', 'content.answer-check']) await setFeature(featureKey, { cap: 50 });
  // No job from an earlier test is left waiting for the worker.
  await drainWorker();
  server.requests.length = 0;
});

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'eng23-' + randomUUID() });
const base = '/api/v1/operations/content-factory';
const lessons = '/api/v1/operations/lessons';
const questions = '/api/v1/operations/question-bank';

function requestDraft(actor: Member, body: Record<string, unknown>) {
  return api().post(`${base}/drafts`).set(auth(actor.userId)).send(body);
}
const lessonRequest = (stableKey: string, over: Record<string, unknown> = {}) => ({
  kind: 'LESSON', topicKey, stableKey, title: 'Reading a subnet mask', level: 'STANDARD', style: 'EXPLANATION', reasonCode: 'NEW_LESSON', ...over,
});

async function auditActions(resourceId: string): Promise<string[]> {
  return (await pool.query('SELECT action FROM audit_events WHERE resource_id = $1 ORDER BY occurred_at, action', [resourceId])).rows.map((row) => row.action as string);
}

describe('access (§6.6 minimums)', () => {
  it('401 without a token, 403 without a content capability or for the wrong kind', async () => {
    await api().get(`${base}/status`).expect(401);
    await api().post(`${base}/drafts`).send(lessonRequest('eng23-no-token')).expect(401);
    expect((await api().get(`${base}/status`).set(auth(plainOperations.userId))).status).toBe(403);
    expect((await requestDraft(plainOperations, lessonRequest('eng23-plain'))).status).toBe(403);
    expect((await requestDraft(reviewer, lessonRequest('eng23-reviewer'))).status).toBe(403);
    expect((await requestDraft(secondEditor, { kind: 'ANSWER_CHECK', questionRevisionId: randomUUID(), reasonCode: 'ANSWER_KEY_CHECK' })).status).toBe(403);
  });

  it('400 on bad input, 404 on an unknown job or target', async () => {
    expect((await requestDraft(editor, { ...lessonRequest('eng23-extra'), extra: 1 })).status).toBe(400);
    expect((await requestDraft(editor, { ...lessonRequest('eng23-kind'), kind: 'ESSAY' })).body.error.code).toBe('AI_DRAFT_KIND_INVALID');
    expect((await requestDraft(editor, lessonRequest('eng23-reason', { reasonCode: 'NEW_LANGUAGE' }))).body.error.code).toBe('REASON_CODE_INVALID');
    expect((await requestDraft(editor, lessonRequest('Bad Key'))).body.error).toMatchObject({ code: 'AI_DRAFT_INVALID', problems: ['AI_DRAFT_KEY_INVALID'] });
    expect((await requestDraft(editor, lessonRequest('eng23-topic', { topicKey: 'no-such-skill' }))).body.error.code).toBe('AI_DRAFT_TOPIC_UNKNOWN');
    const note = await requestDraft(editor, lessonRequest('eng23-note', { authorNote: 'Mention that students can call 98765 43210.' }));
    expect(note.status).toBe(400);
    expect(note.body.error.code).toBe('AI_NOTE_PERSONAL_DATA');
    expect((await requestDraft(editor, { kind: 'LESSON_VARIANT', baseLessonId: randomUUID(), language: 'te', level: 'STANDARD', style: 'EXPLANATION', title: 'X', reasonCode: 'NEW_LANGUAGE' })).status).toBe(404);
    expect((await api().get(`${base}/drafts/${randomUUID()}`).set(auth(editor.userId))).status).toBe(404);
    expect((await api().get(`${base}/drafts?limit=0`).set(auth(editor.userId))).status).toBe(400);
    expect((await api().get(`${base}/drafts?kinds=ESSAY`).set(auth(editor.userId))).status).toBe(400);
    expect(posts()).toHaveLength(0);
  });
});

describe('a lesson drafted with AI', () => {
  it('is only queued by the request; the worker drafts it as an AI DRAFT the requester wrote, with full provenance', async () => {
    const status = await api().get(`${base}/status`).set(auth(secondEditor.userId)).expect(200);
    expect(status.body.features.find((entry: { featureKey: string }) => entry.featureKey === 'content.lesson-draft')).toMatchObject({ available: true, cap: 50, window: 'DAY' });
    expect(status.body.viewer.mayRequest).toMatchObject({ LESSON: true, ANSWER_CHECK: false });

    const queued = await requestDraft(secondEditor, lessonRequest('eng23-subnet-lesson', { authorNote: 'Use a home router as the example.' }));
    expect(queued.status, JSON.stringify(queued.body)).toBe(201);
    expect(queued.body.draft).toMatchObject({ kind: 'LESSON', state: 'QUEUED', produced: null, generation: null });
    // The API made no call: generation is the worker's job.
    expect(posts()).toHaveLength(0);
    const jobId = queued.body.draft.id as string;

    const outcome = await runWorker();
    expect(outcome).toMatchObject({ jobId, state: 'SUCCEEDED', outcomeCode: null });
    expect(posts()).toHaveLength(1);
    const sent = JSON.parse(posts()[0]!.body) as { model: string; messages: { content: string }[] };
    expect(sent.model).toBe(servedModelAtRegistration);
    expect(sent.messages[1]!.content).toContain('Use a home router as the example.');

    const job = (await api().get(`${base}/drafts/${jobId}`).set(auth(secondEditor.userId)).expect(200)).body.draft;
    expect(job).toMatchObject({
      state: 'SUCCEEDED', requestedBy: { userId: secondEditor.userId },
      generation: { source: 'AI_GENERATED', generatorVersion: 'one-ai-orchestration-v1+openai-compatible-v1', model: servedModelAtRegistration, truncated: false, fitted: false },
      prompt: { key: 'content-lesson-draft', version: 1 },
    });
    const lessonId = job.produced.lessonId as string;
    const detail = (await api().get(`${lessons}/lessons/${lessonId}`).set(auth(reviewer.userId)).expect(200)).body.lesson;
    expect(detail).toMatchObject({ stableKey: 'eng23-subnet-lesson', status: 'PENDING', aiDrafted: true, topic: { stableKey: topicKey } });
    expect(detail.open).toMatchObject({
      id: job.produced.revisionId, state: 'DRAFT', author: { userId: secondEditor.userId },
      aiDraft: { jobId, promptVersion: 'content-lesson-draft@1', model: servedModelAtRegistration, fitted: false },
    });
    expect(detail.open.aiDraft.sections.Explanation).toBe(paragraph(6));
    expect(detail.open.fields.summary.startsWith('What you will learn\nHow to read a subnet mask')).toBe(true);
    expect(detail.open.fields.licenceLabel).toBeNull();
    expect(detail.open.expertCheck).toContain('A reviewer checks every fact');
    // Nothing moved it along: no review action, no publish.
    expect((await pool.query('SELECT count(*)::int AS n FROM content_review_actions WHERE content_revision_id = $1', [job.produced.revisionId])).rows[0].n).toBe(0);
    expect(await auditActions(jobId)).toEqual(['operations.content.ai_draft_requested', 'operations.content.ai_draft_finished']);
    const events = (await pool.query("SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at", [jobId])).rows;
    expect(events.map((row) => row.event_type)).toEqual(['content_factory.draft_requested', 'content_factory.draft_finished']);
    expect(JSON.stringify(events)).not.toContain('home router');
  });

  it('cannot be approved or published by its requester, and publishes only through the second-person path (C13)', async () => {
    // The requester here also holds review and publish: the rules, not the capabilities, stop them.
    const queued = await requestDraft(editor, lessonRequest('eng23-c13-lesson'));
    expect(queued.status).toBe(201);
    const outcome = await runWorker();
    expect(outcome?.state).toBe('SUCCEEDED');
    const job = (await api().get(`${base}/drafts/${queued.body.draft.id}`).set(auth(editor.userId))).body.draft;
    const revisionId = job.produced.revisionId as string;
    const lessonId = job.produced.lessonId as string;

    // A DRAFT cannot be published at all.
    expect((await api().post(`${lessons}/revisions/${revisionId}/publish`).set(auth(publisher.userId)).send({ reasonCode: 'NEW_LESSON' })).status).not.toBe(201);
    // A person completes the draft (module and licence) and submits it.
    const drafted = (await api().get(`${lessons}/lessons/${lessonId}`).set(auth(editor.userId))).body.lesson.open;
    const saved = await api().post(`${lessons}/revisions/${revisionId}/draft`).set(auth(editor.userId)).send({
      title: 'Reading a subnet mask', summary: drafted.fields.summary,
      practice: 'Count the hosts in a /27.', moduleKey: fixture.module.stableKey, topicKey, prerequisites: [], licenceLabel: 'AI8HT-Owned', basis: 'Checked against the RFC.', reasonCode: 'DRAFT_EDIT',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.lesson.open.aiDraft.jobId).toBe(job.id);
    expect((await api().post(`${lessons}/revisions/${revisionId}/transition`).set(auth(editor.userId)).send({ toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW' })).status).toBe(201);
    // The requester cannot approve it, even holding CONTENT_REVIEW.
    const selfApproval = await api().post(`${lessons}/revisions/${revisionId}/transition`).set(auth(editor.userId))
      .send({ toState: 'APPROVED', reasonCode: 'REVIEW_PASSED', rightsReasonCode: 'OWNERSHIP_VERIFIED' });
    expect(selfApproval.status).toBe(403);
    expect(selfApproval.body.error.code).toBe('LESSON_SELF_REVIEW_REFUSED');
    // And the database refuses it too, whatever the writer (0004).
    await expect(pool.query(
      `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
       VALUES ($1,$2,$3,'APPROVE','IN_REVIEW','APPROVED','REVIEW_PASSED','eng23-direct-approve')`, [randomUUID(), revisionId, editor.userId],
    )).rejects.toThrow();
    expect((await api().post(`${lessons}/revisions/${revisionId}/transition`).set(auth(reviewer.userId))
      .send({ toState: 'APPROVED', reasonCode: 'REVIEW_PASSED', rightsReasonCode: 'OWNERSHIP_VERIFIED' })).status).toBe(201);
    // The requester cannot publish it either, and a first publish needs a second person's approval.
    expect((await api().post(`${lessons}/revisions/${revisionId}/publish`).set(auth(editor.userId)).send({ reasonCode: 'NEW_LESSON' })).status).toBe(403);
    const unapproved = await api().post(`${lessons}/revisions/${revisionId}/publish`).set(auth(publisher.userId)).send({ reasonCode: 'NEW_LESSON' });
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.error.code).toBe('APPROVAL_REQUIRED');
    const filed = await api().post('/api/v1/operations/approvals').set(auth(publisher.userId)).send({ actionKey: 'CONTENT_LESSON_PUBLISH', payload: { revisionId, reasonCode: 'NEW_LESSON' } });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect((await api().post(`/api/v1/operations/approvals/${filed.body.approval.id}/decision`).set(auth(approver.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' })).status).toBe(201);
    const published = await api().post(`${lessons}/revisions/${revisionId}/publish`).set(auth(publisher.userId)).send({ reasonCode: 'NEW_LESSON', approvalId: filed.body.approval.id });
    expect(published.status, JSON.stringify(published.body)).toBe(201);

    // Students get the learner text only: no provenance, no AI label.
    const catalog = await getPublishedCareerReadinessCatalog(pool) as { modules: { lessons: { stableKey: string; body: unknown }[] }[] };
    const live = catalog.modules.flatMap((entry) => entry.lessons).find((entry) => entry.stableKey === 'eng23-c13-lesson');
    expect(live).toBeDefined();
    expect(JSON.stringify(live)).not.toMatch(/AI_GENERATED|aiDraft|provenance|content-lesson-draft/);
  });
});

describe('the cap, the kill switch and the feature switch', () => {
  it('the cap stops calls with a typed error: refused at request, and a queued job meeting it is refused without a call', async () => {
    await setFeature('content.lesson-draft', { cap: 3 });
    const used = Number((await pool.query("SELECT count(*)::int AS n FROM ai_generations WHERE feature_key = 'content.lesson-draft' AND outcome = 'SUCCEEDED' AND occurred_at >= date_trunc('day', now())")).rows[0].n);
    await setFeature('content.lesson-draft', { cap: used + 2 });
    const first = await requestDraft(thirdEditor, lessonRequest('eng23-cap-one'));
    const second = await requestDraft(thirdEditor, lessonRequest('eng23-cap-two'));
    expect([first.status, second.status]).toEqual([201, 201]);
    // Successes plus queued work reach the cap: the next request is refused, typed.
    const third = await requestDraft(thirdEditor, lessonRequest('eng23-cap-three'));
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('AI_CAP_REACHED');
    // The cap is lowered while both wait: the orchestrator refuses the second at call time.
    await setFeature('content.lesson-draft', { cap: used + 1 });
    expect(await runWorker()).toMatchObject({ state: 'SUCCEEDED' });
    expect(await runWorker()).toMatchObject({ state: 'REFUSED', outcomeCode: 'CAP_EXCEEDED' });
    expect(posts()).toHaveLength(1);
    const refused = (await pool.query("SELECT outcome, failure_class FROM ai_generations WHERE feature_key = 'content.lesson-draft' AND outcome = 'REFUSED' ORDER BY occurred_at DESC LIMIT 1")).rows[0];
    expect(refused).toEqual({ outcome: 'REFUSED', failure_class: 'CAP_EXCEEDED' });
    const job = (await api().get(`${base}/drafts/${second.body.draft.id}`).set(auth(thirdEditor.userId))).body.draft;
    expect(job).toMatchObject({ state: 'REFUSED', outcomeCode: 'CAP_EXCEEDED', produced: null, generation: null });
  });

  it('the kill switch refuses requests and stops a queued job before any call', async () => {
    const queued = await requestDraft(thirdEditor, lessonRequest('eng23-kill-switch'));
    expect(queued.status).toBe(201);
    await setKillSwitch(true);
    const refused = await requestDraft(thirdEditor, lessonRequest('eng23-kill-switch-two'));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('AI_KILL_SWITCH_ENGAGED');
    expect(await runWorker()).toMatchObject({ jobId: queued.body.draft.id, state: 'REFUSED', outcomeCode: 'KILL_SWITCH_ENGAGED' });
    expect(posts()).toHaveLength(0);
    const status = await api().get(`${base}/status`).set(auth(thirdEditor.userId)).expect(200);
    expect(status.body.killSwitchEngaged).toBe(true);
    expect(status.body.features.every((entry: { available: boolean }) => !entry.available)).toBe(true);
  });

  it('a switched-off feature refuses requests', async () => {
    await setFeature('content.lesson-draft', { enabled: false });
    try {
      const refused = await requestDraft(thirdEditor, lessonRequest('eng23-switched-off'));
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('AI_FEATURE_DISABLED');
    } finally {
      await setFeature('content.lesson-draft', { enabled: true });
    }
  });

  it('three jobs in flight per person, then a typed refusal', async () => {
    for (const key of ['eng23-flight-a', 'eng23-flight-b', 'eng23-flight-c']) expect((await requestDraft(secondEditor, lessonRequest(key))).status).toBe(201);
    const fourth = await requestDraft(secondEditor, lessonRequest('eng23-flight-d'));
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('AI_DRAFTS_IN_FLIGHT');
    // A key already queued is taken.
    expect((await requestDraft(thirdEditor, lessonRequest('eng23-flight-a'))).body.error.code).toBe('AI_DRAFT_KEY_EXISTS');
  });

  it('with no endpoint configured the job fails plainly and nothing crashes', async () => {
    const queued = await requestDraft(thirdEditor, lessonRequest('eng23-unconfigured'));
    expect(await runWorker({ ONE_AI_BASE_URL: '', ONE_AI_API_KEY: '', ONE_AI_MODEL: '' })).toMatchObject({ jobId: queued.body.draft.id, state: 'FAILED', outcomeCode: 'PROVIDER_UNCONFIGURED' });
  });
});

describe('the guard', () => {
  it('a reply carrying personal data lands nothing and says why', async () => {
    lessonReply = () => englishLesson('Stuck? Write to helper.name@example.org for the answers.');
    const queued = await requestDraft(thirdEditor, lessonRequest('eng23-guarded'));
    expect(await runWorker()).toMatchObject({ state: 'REJECTED', outcomeCode: 'GUARD_REJECTED', findings: ['PERSONAL_DATA'], producedRevisionId: null });
    const job = (await api().get(`${base}/drafts/${queued.body.draft.id}`).set(auth(thirdEditor.userId))).body.draft;
    expect(job).toMatchObject({ state: 'REJECTED', findings: ['PERSONAL_DATA'], produced: null, generation: { source: 'AI_GENERATED' } });
    expect((await pool.query("SELECT count(*)::int AS n FROM content_revisions WHERE entity_type = 'LESSON' AND body ->> 'stableKey' = 'eng23-guarded'")).rows[0].n).toBe(0);
    // A rejected reply is not kept anywhere a screen could show it.
    expect(JSON.stringify(job)).not.toContain('helper.name');
  });

  it('a model refusal lands nothing', async () => {
    lessonReply = () => 'REFUSED: the note asks for something the rules forbid.';
    await requestDraft(thirdEditor, lessonRequest('eng23-model-refused'));
    expect(await runWorker()).toMatchObject({ state: 'REFUSED', outcomeCode: 'MODEL_REFUSED' });
  });
});

describe('variants, questions and answer checks', () => {
  it('a Telugu variant of a live lesson lands marked for native-speaker review', async () => {
    lessonReply = () => teluguLesson();
    const queued = await requestDraft(thirdEditor, {
      kind: 'LESSON_VARIANT', baseLessonId, language: 'te', level: 'STANDARD', style: 'EXPLANATION', title: 'సబ్‌నెట్ మాస్క్', reasonCode: 'NEW_LANGUAGE',
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(201);
    expect(await runWorker()).toMatchObject({ state: 'SUCCEEDED' });
    const sent = JSON.parse(posts()[0]!.body) as { messages: { content: string }[] };
    expect(sent.messages[0]!.content).toContain('Write the lesson in Telugu.');
    expect(sent.messages[1]!.content).toContain('Telugu rendering of the published lesson');
    const job = (await api().get(`${base}/drafts/${queued.body.draft.id}`).set(auth(thirdEditor.userId))).body.draft;
    const variant = (await api().get(`${lessons}/lessons/${job.produced.lessonId}`).set(auth(reviewer.userId))).body.lesson;
    expect(variant).toMatchObject({ kind: 'VARIANT', variant: { language: 'te' }, variantOf: baseLessonId, aiDrafted: true });
    expect(variant.open).toMatchObject({ state: 'DRAFT', author: { userId: thirdEditor.userId }, aiDraft: { jobId: job.id } });
    // The same variant cannot be asked for twice.
    expect((await requestDraft(thirdEditor, { kind: 'LESSON_VARIANT', baseLessonId, language: 'te', level: 'STANDARD', style: 'EXPLANATION', title: 'X', reasonCode: 'NEW_LANGUAGE' })).body.error.code)
      .toBe('AI_DRAFT_VARIANT_EXISTS');
  });

  it('a practice question lands with its ladder; submitted, the ladder keeps AI provenance; an answer check is for key holders only', async () => {
    const queued = await requestDraft(thirdEditor, { kind: 'QUESTION', topicKey, stableKey: 'eng23-subnet-item', level: 'INTERMEDIATE', reasonCode: 'NEW_QUESTION' });
    expect(queued.status, JSON.stringify(queued.body)).toBe(201);
    expect(await runWorker()).toMatchObject({ state: 'SUCCEEDED' });
    const job = (await api().get(`${base}/drafts/${queued.body.draft.id}`).set(auth(thirdEditor.userId))).body.draft;
    const questionId = job.produced.questionId as string;
    const revisionId = job.produced.revisionId as string;
    const question = (await api().get(`${questions}/questions/${questionId}`).set(auth(reviewer.userId)).expect(200)).body.question;
    expect(question).toMatchObject({ stableKey: 'eng23-subnet-item', aiDrafted: true, hintsComplete: true, difficulty: 'INTERMEDIATE' });
    expect(question.open).toMatchObject({ state: 'DRAFT', author: { userId: thirdEditor.userId }, aiDraft: { jobId: job.id, promptVersion: 'content-item-draft@1' } });
    expect(question.open.fields).toMatchObject({ correctOptionId: 'a', options: [{ id: 'a', text: '30' }, { id: 'b', text: '32' }, { id: 'c', text: '14' }, { id: 'd', text: '62' }] });

    // A person adds the licence and submits; the ladder is written AI_GENERATED (0106).
    const fields = question.open.fields;
    const saved = await api().post(`${questions}/revisions/${revisionId}/draft`).set(auth(thirdEditor.userId)).send({
      topicKey, prompt: fields.prompt, options: fields.options.map((option: { id: string; text: string }) => ({ id: option.id, text: option.text })),
      correctOptionId: fields.correctOptionId, explanation: fields.explanation, difficulty: fields.difficulty, hints: fields.hints,
      licenceLabel: 'AI8HT-Owned', basis: 'Checked by a person.', reasonCode: 'DRAFT_EDIT',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect((await api().post(`${questions}/revisions/${revisionId}/transition`).set(auth(thirdEditor.userId)).send({ toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW' })).status).toBe(201);
    const ladder = (await pool.query('SELECT source, prompt_version, generator_version, expert_check_notes FROM question_hint_ladders WHERE question_revision_id = $1', [revisionId])).rows[0];
    expect(ladder).toMatchObject({ source: 'AI_GENERATED', prompt_version: 'content-item-draft@1', generator_version: 'one-ai-orchestration-v1+openai-compatible-v1' });
    expect(ladder.expert_check_notes).toContain('every hint');

    // The reviewer asks for an answer check; the model agrees with the key.
    const check = await requestDraft(reviewer, { kind: 'ANSWER_CHECK', questionRevisionId: revisionId, reasonCode: 'ANSWER_KEY_CHECK' });
    expect(check.status, JSON.stringify(check.body)).toBe(201);
    expect(await runWorker()).toMatchObject({ state: 'SUCCEEDED' });
    const seen = (await api().get(`${base}/drafts?questionRevisionId=${revisionId}&kinds=ANSWER_CHECK`).set(auth(reviewer.userId)).expect(200)).body.drafts;
    expect(seen[0]).toMatchObject({ state: 'SUCCEEDED', check: { option: 'a', agreesWithKey: true, stale: false, reviewState: 'DRAFT' } });
    // A publisher without answer keys sees the job, not the result.
    const withheld = (await api().get(`${base}/drafts?questionRevisionId=${revisionId}`).set(auth(publisher.userId)).expect(200)).body.drafts;
    expect(withheld[0].check).toBeNull();
    // The check is advice: the question did not move.
    expect((await api().get(`${questions}/questions/${questionId}`).set(auth(reviewer.userId))).body.question.open.state).toBe('IN_REVIEW');

    // A disagreeing check says so.
    checkReply = '{"option": "b", "working": "Thirty-two addresses in the block."}';
    await requestDraft(reviewer, { kind: 'ANSWER_CHECK', questionRevisionId: revisionId, reasonCode: 'REVIEW_SUPPORT' });
    expect(await runWorker()).toMatchObject({ state: 'SUCCEEDED' });
    const latest = (await api().get(`${base}/drafts?questionRevisionId=${revisionId}`).set(auth(reviewer.userId))).body.drafts[0];
    expect(latest.check).toMatchObject({ option: 'b', agreesWithKey: false });
  });
});
