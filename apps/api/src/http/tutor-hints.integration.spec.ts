/**
 * ENG-22 end to end, on seeded synthetic data and ENG-20's local fake endpoint (no pod, no network):
 * - off by default: no audience, no switch, no consent → no AI, and the switch-on path needs a passing
 *   `ai_evaluations` record (0089) — not bypassed;
 * - the request is a job: POST answers 202 with the level pending and makes no model call; the outbox
 *   worker writes the hint through ONE AI Orchestration; the step shows it labelled as the tutor's;
 * - the brief sent to the model carries content only (no student data, no readiness);
 * - the guard: a leaking reply is never shown, the human hint for that level is;
 * - an AI hint is a ladder level: an answer after level 3 is assisted, exactly like "Show hint";
 * - the tutor cannot write evidence: the job leaves evidence, mastery and attempts untouched;
 * - per-student daily cap, re-checks in the worker (answered, consent withdrawn, kill switch),
 *   provenance on every row, audit rows, staff review, privacy export and deletion.
 */
import 'reflect-metadata';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { renderPrompt, tutorHintPromptV2 } from '@planthepath/ai-orchestration/src/index.js';
import { completion, startFakeOpenAiServer, type FakeAnswer, type FakeOpenAiServer } from '@planthepath/ai-orchestration/src/testing/fake-openai-server.js';
import { createTrustedJwtVerifier, type TrustedJwk } from '@planthepath/identity/src/jwt.js';
import { createLocalIntegrationEventPublisher, publishOutboxOnce } from '@planthepath/persistence/src/automation-workers.js';
import { setStudentCareerTarget } from '@planthepath/persistence/src/career-targets.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { listTutorHintsForReview, reviewTutorHint } from '@planthepath/persistence/src/tutor-hints.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { buildTutorBrief, tutorPromptParameters } from '@planthepath/tutoring/src/index.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { assembleSubjectExport } from './privacy-export.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for tutor hint integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-tutor-hints-client';
const keyId = 'tutor-hints-key';
const schemaName = `tutor_hints_${process.pid}`;
const CONSENT_VERSION = 'eng22-api-synthetic';
const SHA = 'e'.repeat(64);
const MODEL = 'fake/served-model';
// Test-only sentinel; not a credential.
const TEST_KEY = 'test-only-bearer-value-eng22';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});

const OPTIONS = [{ id: 'a', text: '36' }, { id: 'b', text: '42' }, { id: 'c', text: '48' }, { id: 'd', text: '54' }];
const LADDER = ['Synthetic nudge: think in groups of six.', 'Synthetic strategy: multiply the two numbers.', 'Synthetic worked step: start from five groups.', 'Synthetic near solution: add one more group.'];
const SAFE_HINT = 'Think of the product as equal groups. How many groups of six are there?';
const ENV_KEYS = ['ONE_AI_TUTOR_AUDIENCE', 'ONE_SANDBOX', 'ONE_AI_BASE_URL', 'ONE_AI_API_KEY', 'ONE_AI_MODEL'] as const;

let adminPool: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;
let server: FakeOpenAiServer;
let script: (index: number) => FakeAnswer;
let author: string;
let reviewer: string;
let sourceRecordId: string;
let topicId: string;
let roleId: string;
let questions: string[];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
  db = drizzle(pool, { schema });
  await applyMigrations(pool);
  const identityStore = {
    findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
    loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({ verifier, identityStore, db })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = await startFakeOpenAiServer((_request, index) => script(index));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

  // ai-tutoring, live for this suite only (publishing the real definition is HG-6).
  await pool.query("UPDATE consent_definitions SET retired_at = greatest(now(), effective_from) WHERE consent_key = 'ai-tutoring' AND retired_at IS NULL");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('ai-tutoring', $1, 'Synthetic AI tutoring purpose', 'OPTIONAL', true, now() - interval '1 minute')`, [CONSENT_VERSION]);

  author = (await student({ consent: false })).id;
  reviewer = (await student({ consent: false })).id;
  await seedSourceRecord();
  topicId = await topic('Synthetic multiplication skill');
  questions = await publishQuestions(topicId, 5);
  roleId = randomUUID();
  await pool.query(`INSERT INTO career_roles (id, code, title, family) VALUES ($1, $2, 'Synthetic tutor role', 'Test')`, [roleId, `ENG22_${roleId.slice(0, 8).toUpperCase()}`]);
  await pool.query(`INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.8)`,
    [randomUUID(), roleId, topicId]);

  // The feature as ENG-21 registers it, on the model the fake serves. Off (0033 default).
  await pool.query(`INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, max_input_chars, prompt_key, prompt_version)
    VALUES ('tutor.hint', 'Practice tutor (ENG-22 test)', $1, 500, 'DAY', 12000, 'tutor-hint', 2) ON CONFLICT (feature_key) DO NOTHING`, [MODEL]);
});

afterAll(async () => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await server?.close();
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
});

beforeEach(() => {
  script = () => ({ status: 200, json: completion(JSON.stringify({ type: 'HINT', text: SAFE_HINT }), { prompt_tokens: 300, completion_tokens: 30 }, 'stop', MODEL) });
  server.requests.length = 0;
});

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'x-correlation-id': `tutor-${randomUUID()}` });

/** The sandbox deployment: the API's and the worker's environment (same process here). */
function sandbox(on: boolean): void {
  const values: Record<(typeof ENV_KEYS)[number], string> = {
    ONE_AI_TUTOR_AUDIENCE: 'sandbox', ONE_SANDBOX: 'true', ONE_AI_BASE_URL: server.baseUrl, ONE_AI_API_KEY: TEST_KEY, ONE_AI_MODEL: MODEL,
  };
  for (const key of ENV_KEYS) { if (on) process.env[key] = values[key]; else delete process.env[key]; }
}

async function switchOn(): Promise<void> {
  const passing = await pool.query("SELECT count(*)::int AS n FROM ai_evaluations WHERE feature_key = 'tutor.hint' AND decision = 'PASS'");
  if (passing.rows[0].n === 0) {
    await pool.query(`INSERT INTO ai_evaluations (id, feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version, metrics, decision, reason_code, decided_by_user_id, correlation_id)
      VALUES ($1,'tutor.hint','openai-compatible',$2,'tutor-hint',2,'one-ai-bakeoff',1,$3::jsonb,'PASS','INITIAL_BENCHMARK',$4,'eng22-test')`,
    [randomUUID(), MODEL, JSON.stringify([{ name: 'answer_leak_rate', value: 0, threshold: 0.0099, comparator: 'AT_MOST' }]), reviewer]);
  }
  await pool.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'tutor.hint'");
  await pool.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
}

/** Drains the outbox through the real local dispatcher, as the worker does (ADR-028). */
async function drain(): Promise<void> {
  const local = createLocalIntegrationEventPublisher({ pool, db: db as unknown as PersistenceDb });
  for (let round = 0; round < 5; round += 1) {
    // The database stamps available_at with its own clock, which runs ahead of Node's here: dispatch at its time.
    const clock = (await pool.query<{ at: Date }>("SELECT clock_timestamp() + interval '1 second' AS at")).rows[0]!.at;
    const result = await publishOutboxOnce({ db: db as unknown as PersistenceDb, publisher: local.publisher, leaseOwner: 'eng22-test', now: new Date(clock) });
    if (result.claimed === 0) return;
  }
}

async function student(options: { consent: boolean }): Promise<{ id: string; token: string; email: string }> {
  const sub = `sub:${randomUUID()}`;
  const email = `${randomUUID()}@tutor.test`;
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject: sub, email, state: 'ACTIVE' });
  if (options.consent) await grant(id);
  return { id, token: signAccessToken(privateKey, { sub, email }), email };
}

async function grant(userId: string, action: 'GRANTED' | 'WITHDRAWN' = 'GRANTED'): Promise<void> {
  await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
    VALUES ($1, $2, 'ai-tutoring', $3, $4, now())`, [randomUUID(), userId, CONSENT_VERSION, action]);
}

async function seedSourceRecord(): Promise<void> {
  const [runId, packageId] = [randomUUID(), randomUUID()];
  sourceRecordId = randomUUID();
  await pool.query(`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES ($1, $2, 'synthetic/eng-22', $3, $4, 'eng22-test', 'STAGED', $5, now())`, [runId, `eng22-${runId}`, 'c'.repeat(40), SHA, author]);
  await pool.query(`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES ($1, $2, $3, 'synthetic/eng-22', $4, $5, 'eng22-test', '[]', '{}', '{}')`, [packageId, runId, `eng22-${packageId}`, 'c'.repeat(40), SHA]);
  await pool.query(`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES ($1, $2, 'ENGINE_CONTENT', 'eng22', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
  [sourceRecordId, packageId, SHA]);
}

async function topic(name: string): Promise<string> {
  const [id, revision] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, id, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'Synthetic topic for ENG-22 API tests', $4)`, [id, `eng22-${id}`, name, revision]);
  return id;
}

/** Publishes `count` synthetic "6 × 7" questions, each with a published hint ladder; the key is always b (42). */
async function publishQuestions(topicIdValue: string, count: number): Promise<string[]> {
  const manifestId = randomUUID();
  await pool.query(`INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1, $2, 1, $3, 'DRAFT')`,
    [manifestId, `eng22-${manifestId}`, manifestId.replace(/-/g, '').repeat(2)]);
  const made: { id: string; revision: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const [id, revision] = [randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1, 'QUESTION', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, id, author, SHA]);
    await pool.query(`INSERT INTO question_hint_ladders (id, question_revision_id, hint_1, hint_2, hint_3, hint_4, source, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'AUTHORED', $7)`, [randomUUID(), revision, ...LADDER, author]);
    await pool.query("UPDATE content_revisions SET state = 'IN_REVIEW' WHERE id = $1", [revision]);
    await pool.query(`INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
      VALUES ($1, $2, $3, 'APPROVE', 'IN_REVIEW', 'APPROVED', 'SYNTHETIC_OK', 'eng22-approve')`, [randomUUID(), revision, reviewer]);
    await pool.query("UPDATE content_revisions SET state = 'APPROVED' WHERE id = $1", [revision]);
    await pool.query('INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1, $2, $3, $4)',
      [manifestId, revision, sourceRecordId, SHA]);
    made.push({ id, revision });
  }
  await pool.query("UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = $2, approved_at = now() WHERE id = $1", [manifestId, reviewer]);
  await pool.query("UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = $2, published_at = now() WHERE id = $1", [manifestId, reviewer]);
  // The hint ladders publish with their questions (0061 mirrors the revision state).
  for (const [index, question] of made.entries()) {
    await pool.query("UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = $2, published_at = now() WHERE id = $1", [question.revision, manifestId]);
    await pool.query(`INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
      VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, now())`,
    [question.id, `eng22-q-${index}-${question.id}`, topicIdValue, `Synthetic practice question ${index + 1}: what is 6 × 7?`, JSON.stringify(OPTIONS), question.revision, manifestId]);
    await pool.query(`INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash) VALUES ($1, 'b', 'Synthetic explanation.', $2)`,
      [question.id, SHA]);
  }
  return made.map((question) => question.id);
}

/** A student with the synthetic role as primary target and a current gap on the one skill. */
async function learnerWithStep(options: { consent: boolean }): Promise<{ id: string; token: string; email: string; decisionId: string; questionId: string; base: string }> {
  const learner = await student(options);
  await setStudentCareerTarget(pool, { subjectUserId: learner.id, careerRoleId: roleId, priority: 'PRIMARY' });
  await pool.query('UPDATE career_gap_snapshots SET superseded_at = now() WHERE student_user_id = $1 AND superseded_at IS NULL', [learner.id]);
  const snapshotId = randomUUID();
  await pool.query(`INSERT INTO career_gap_snapshots (id, student_user_id, career_role_id, model_version, requirements_total, requirements_met, requirements_unknown)
    VALUES ($1, $2, $3, 'career-gap-v1', 1, 0, 0)`, [snapshotId, learner.id, roleId]);
  await pool.query(`INSERT INTO career_gap_items (id, snapshot_id, topic_id, requirement_level, target_mastery, observed_mastery, status, priority_rank)
    VALUES ($1, $2, $3, 'ESSENTIAL', 0.8, 0.5, 'PARTIAL', 1)`, [randomUUID(), snapshotId, topicId]);
  const started = await api().post('/api/v1/learning/next-step').set(auth(learner.token)).send({});
  expect(started.status).toBe(201);
  const step = started.body.step;
  expect(step.practice.status).toBe('IN_PROGRESS');
  return { ...learner, decisionId: step.decisionId, questionId: step.practice.question.id, base: `/api/v1/learning/steps/${step.decisionId}` };
}

async function readStep(learner: { token: string; base: string }): Promise<Record<string, any>> {
  const response = await api().get(learner.base).set(auth(learner.token));
  expect(response.status).toBe(200);
  return response.body.step;
}

async function counts(subjectUserId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ['evidence_records', 'mastery_projections', 'learning_attempt_events', 'learner_skill_state', 'readiness_snapshots']) {
    out[table] = (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE subject_user_id = $1`, [subjectUserId])).rows[0].n;
  }
  return out;
}

async function hintRow(decisionId: string, questionId: string, level: number): Promise<Record<string, any>> {
  return (await pool.query('SELECT * FROM tutor_hints WHERE decision_id = $1 AND item_id = $2 AND hint_level = $3', [decisionId, questionId, level])).rows[0];
}

describe('ENG-22: off by default, and switched on only through the evaluation gate', () => {
  it('requires a signed-in user, a well-formed request, and staff capability for review', async () => {
    const id = randomUUID();
    expect((await api().post(`/api/v1/learning/steps/${id}/tutor-hints`)).status).toBe(401);
    expect((await api().get('/api/v1/operations/ai/tutor-hints')).status).toBe(401);
    expect((await api().post(`/api/v1/operations/ai/tutor-hints/${id}/review`)).status).toBe(401);
    const learner = await learnerWithStep({ consent: true });
    expect((await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: 'nope' })).status).toBe(400);
    expect((await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId, message: 'hi' })).status).toBe(400);
    expect((await api().get('/api/v1/operations/ai/tutor-hints').set(auth(learner.token))).status).toBe(403);
    expect((await api().post(`/api/v1/operations/ai/tutor-hints/${id}/review`).set(auth(learner.token)).send({ verdict: 'APPROVE', reasonCode: 'ACCURATE_AND_SAFE' })).status).toBe(403);
  });

  it('with the feature off (the default) there is no AI: the question says OFF and a request is refused', async () => {
    sandbox(true);
    const learner = await learnerWithStep({ consent: true });
    const step = await readStep(learner);
    expect(step.practice.question.tutor).toEqual({ available: false, reason: 'OFF', remainingToday: null });
    const refused = await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'TUTOR_OFF', message: 'The AI tutor is not switched on.' });
    // Nothing recorded: no level, no request, no job, no call.
    expect((await readStep(learner)).practice.question.hints).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM tutor_hints WHERE subject_user_id = $1', [learner.id])).rows[0].n).toBe(0);
    expect(server.requests).toHaveLength(0);
  });

  it('switching the feature on needs a passing evaluation for its model and prompt (0089), which is not bypassed', async () => {
    await expect(pool.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'tutor.hint'")).rejects.toThrow(/evaluation/u);
    await switchOn();
    expect((await pool.query("SELECT enabled FROM ai_feature_policies WHERE feature_key = 'tutor.hint'")).rows[0].enabled).toBe(true);
  });

  it('outside the sandbox the tutor stays off even with the feature on: no AI reaches a real student before HG-6', async () => {
    await switchOn();
    sandbox(false);
    const learner = await learnerWithStep({ consent: true });
    expect((await readStep(learner)).practice.question.tutor.reason).toBe('OFF');
    process.env.ONE_AI_TUTOR_AUDIENCE = 'sandbox';
    expect((await readStep(learner)).practice.question.tutor.reason).toBe('OFF');
    sandbox(true);
    expect((await readStep(learner)).practice.question.tutor).toEqual({ available: true, reason: null, remainingToday: 20 });
  });

  it('needs the ai-tutoring consent, read on every request', async () => {
    await switchOn();
    sandbox(true);
    const learner = await learnerWithStep({ consent: false });
    expect((await readStep(learner)).practice.question.tutor).toEqual({ available: false, reason: 'NO_CONSENT', remainingToday: null });
    const refused = await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    expect(refused.body.error.code).toBe('TUTOR_NO_CONSENT');
    await grant(learner.id);
    expect((await readStep(learner)).practice.question.tutor.available).toBe(true);
  });
});

describe('ENG-22: a hint is a job, guarded, labelled and counted like the ladder', () => {
  beforeEach(async () => { await switchOn(); sandbox(true); });

  it('the request enqueues (202, pending, no model call); the worker writes the hint with provenance; the step shows it as AI', async () => {
    const learner = await learnerWithStep({ consent: true });
    const asked = await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    expect(asked.status).toBe(202);
    const pending = asked.body.step.practice.question;
    expect(pending.hintDetails).toEqual([{ level: 1, source: 'AI_TUTOR', state: 'PENDING', text: null, fallback: null }]);
    expect(pending.tutor).toEqual({ available: false, reason: 'PENDING', remainingToday: 19 });
    // No model call in the request handler: the fake endpoint has seen nothing; the job is on the outbox.
    expect(server.requests).toHaveLength(0);
    const row = await hintRow(learner.decisionId, learner.questionId, 1);
    expect(row).toMatchObject({ status: 'PENDING', source: 'AI_GENERATED', prompt_version: 'tutor-hint@2', review_state: 'DRAFT', language: 'en', policy_version: 'tutor-hint-policy-v1' });
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'tutor.hint.requested' AND aggregate_id = $1", [row.id])).rows[0].n).toBe(1);
    expect((await pool.query('SELECT hint_level FROM learning_step_items WHERE decision_id = $1 AND item_id = $2', [learner.decisionId, learner.questionId])).rows[0].hint_level).toBe(1);

    await drain();
    expect(server.requests).toHaveLength(1);
    const shown = (await readStep(learner)).practice.question;
    expect(shown.hintDetails).toEqual([{ level: 1, source: 'AI_TUTOR', state: 'SHOWN', text: SAFE_HINT, fallback: null }]);
    expect(shown.hints).toEqual([SAFE_HINT]);
    expect(shown.tutor).toEqual({ available: true, reason: null, remainingToday: 19 });
    const done = await hintRow(learner.decisionId, learner.questionId, 1);
    expect(done).toMatchObject({ status: 'SHOWN', fallback_reason: null, generated_text: SAFE_HINT, model: MODEL, review_state: 'DRAFT',
      guard_version: 'tutor-guard-v1', source: 'AI_GENERATED', prompt_version: 'tutor-hint@2' });
    expect(done.generator_version).toMatch(/one-ai-orchestration/u);
    expect(done.generated_at).not.toBeNull();
    expect(done.prompt_fingerprint).toMatch(/^[0-9a-f]{8}$/u);
    // Metered through ONE AI Orchestration, against the student.
    const metered = await pool.query("SELECT outcome, subject_user_id::text AS subject FROM ai_generations WHERE feature_key = 'tutor.hint' AND correlation_id = $1", [done.correlation_id]);
    expect(metered.rows).toEqual([{ outcome: 'SUCCEEDED', subject: learner.id }]);
    // Audited: the request and the completion.
    const audit = await pool.query("SELECT action, context FROM audit_events WHERE resource_id = $1 ORDER BY occurred_at", [done.id]);
    expect(audit.rows.map((entry) => entry.action)).toEqual(['tutor.hint.requested', 'tutor.hint.completed']);
    expect(audit.rows[1].context).toMatchObject({ outcome: 'SHOWN', findings: [], by: 'tutor-hint-generator' });
    expect(JSON.stringify(audit.rows)).not.toContain(SAFE_HINT);
  });

  it('the model receives the structured brief only — content, never the student or readiness — exactly as evaluated', async () => {
    const learner = await learnerWithStep({ consent: true });
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    await drain();
    const sent = JSON.parse(server.requests[0]!.body) as { model: string; messages: { role: string; content: string }[] };
    expect(sent.model).toBe(MODEL);
    const question = (await pool.query('SELECT prompt FROM question_versions WHERE id = $1', [learner.questionId])).rows[0].prompt as string;
    const expected = renderPrompt(tutorHintPromptV2, tutorPromptParameters(buildTutorBrief({
      questionPrompt: question, options: OPTIONS, correctOptionId: 'b', publishedLadder: LADDER, level: 1, language: 'en',
    })));
    expect(sent.messages).toEqual([{ role: 'system', content: expected.system }, { role: 'user', content: expected.user }]);
    const text = server.requests[0]!.body;
    // The prompt's own rules mention readiness (never comment on it); no readiness value or student data is in it.
    for (const forbidden of [learner.id, learner.email, learner.decisionId, 'NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'DEMONSTRATED', 'tutor.test']) {
      expect(text).not.toContain(forbidden);
    }
    expect(server.requests[0]!.authorization).toBe(`Bearer ${TEST_KEY}`);
  });

  it('a reply that leaks the answer is never shown: the human hint for that level is, and the row records why', async () => {
    script = () => ({ status: 200, json: completion(JSON.stringify({ type: 'HINT', text: 'Multiply them: the answer is 42.' }), undefined, 'stop', MODEL) });
    const learner = await learnerWithStep({ consent: true });
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    await drain();
    const response = await api().get(learner.base).set(auth(learner.token));
    const question = response.body.step.practice.question;
    expect(question.hintDetails).toEqual([{ level: 1, source: 'AI_TUTOR', state: 'FALLBACK', text: LADDER[0], fallback: 'CHECKS_FAILED' }]);
    expect(JSON.stringify(response.body)).not.toContain('the answer is 42');
    const row = await hintRow(learner.decisionId, learner.questionId, 1);
    expect(row).toMatchObject({ status: 'FALLBACK', fallback_reason: 'GUARD_REFUSED', guard_findings: ['ANSWER_LEAK'], review_state: 'DRAFT' });
    expect(row.generated_text).toBe('Multiply them: the answer is 42.');
  });

  it('readiness talk, a wrong language and a broken shape fall back too', async () => {
    const replies = [
      JSON.stringify({ type: 'HINT', text: 'Getting this right will raise your readiness band.' }),
      JSON.stringify({ type: 'HINT', text: 'छह के समूह के बारे में सोचिए।' }),
      'Just multiply.',
    ];
    const learner = await learnerWithStep({ consent: true });
    for (const [index, reply] of replies.entries()) {
      script = () => ({ status: 200, json: completion(reply, undefined, 'stop', MODEL) });
      expect((await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId })).status).toBe(202);
      await drain();
      expect((await hintRow(learner.decisionId, learner.questionId, index + 1)).guard_findings).toEqual([['READINESS_OR_PLACEMENT'], ['WRONG_LANGUAGE'], ['FORMAT']][index]);
    }
    const shown = (await readStep(learner)).practice.question.hintDetails.map((entry: { text: string }) => entry.text);
    expect(shown).toEqual(LADDER.slice(0, 3));
  });

  it('an AI hint is a ladder level: after AI level 3 a right answer is assisted, after level 2 it is not', async () => {
    for (const levels of [2, 3]) {
      const learner = await learnerWithStep({ consent: true });
      for (let level = 1; level <= levels; level += 1) {
        expect((await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId })).status).toBe(202);
        await drain();
      }
      const answered = await api().post(`${learner.base}/answers`).set(auth(learner.token)).send({ questionId: learner.questionId, selectedOptionId: 'b' });
      expect(answered.status).toBe(201);
      expect(answered.body.feedback).toEqual({ questionId: learner.questionId, correct: true, assisted: levels >= 3 });
      const attempt = (await pool.query(`SELECT highest_hint_level, assisted FROM learning_attempt_events WHERE source_attempt_type = 'learning_step'
        AND source_attempt_id = $1 AND item_id = $2`, [learner.decisionId, learner.questionId])).rows[0];
      expect(attempt).toEqual({ highest_hint_level: levels, assisted: levels >= 3 });
    }
  });

  it('the tutor cannot write evidence: the job leaves evidence, mastery, attempts and readiness untouched', async () => {
    const learner = await learnerWithStep({ consent: true });
    const before = await counts(learner.id);
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    await drain();
    expect((await hintRow(learner.decisionId, learner.questionId, 1)).status).toBe('SHOWN');
    expect(await counts(learner.id)).toEqual(before);
  });

  it('the worker re-checks: an answered question or a withdrawn consent closes the request without a model call', async () => {
    const answeredFirst = await learnerWithStep({ consent: true });
    await api().post(`${answeredFirst.base}/tutor-hints`).set(auth(answeredFirst.token)).send({ questionId: answeredFirst.questionId });
    await api().post(`${answeredFirst.base}/answers`).set(auth(answeredFirst.token)).send({ questionId: answeredFirst.questionId, selectedOptionId: 'a' });
    const withdrawn = await learnerWithStep({ consent: true });
    await api().post(`${withdrawn.base}/tutor-hints`).set(auth(withdrawn.token)).send({ questionId: withdrawn.questionId });
    await grant(withdrawn.id, 'WITHDRAWN');
    await drain();
    expect(server.requests).toHaveLength(0);
    expect((await hintRow(answeredFirst.decisionId, answeredFirst.questionId, 1))).toMatchObject({ status: 'FALLBACK', fallback_reason: 'WITHDRAWN', generated_text: null });
    expect((await hintRow(withdrawn.decisionId, withdrawn.questionId, 1))).toMatchObject({ status: 'FALLBACK', fallback_reason: 'AI_UNAVAILABLE' });
  });

  it('the kill switch stops the very next generation; the student gets the human hint', async () => {
    const learner = await learnerWithStep({ consent: true });
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    await pool.query("UPDATE feature_flags SET enabled = true WHERE key = 'ai.global-kill-switch'");
    try {
      await drain();
      expect(server.requests).toHaveLength(0);
      expect(await hintRow(learner.decisionId, learner.questionId, 1)).toMatchObject({ status: 'FALLBACK', fallback_reason: 'AI_UNAVAILABLE' });
      expect((await readStep(learner)).practice.question.hintDetails[0]).toMatchObject({ state: 'FALLBACK', text: LADDER[0] });
      expect((await readStep(learner)).practice.question.tutor.reason).toBe('OFF');
    } finally {
      await pool.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
    }
  });

  it('one pending hint at a time, four levels per question, and a cap of 20 AI hints per student per day', async () => {
    const learner = await learnerWithStep({ consent: true });
    expect((await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId })).status).toBe(202);
    const second = await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    expect(second.body.error.code).toBe('TUTOR_PENDING');
    await drain();
    let questionId = learner.questionId;
    let requested = 1;
    while (requested < 20) {
      const step = await readStep(learner);
      questionId = step.practice.question.id;
      if (step.practice.question.hints.length === 4) {
        expect(step.practice.question.tutor.reason).toBe('HINTS_USED');
        await api().post(`${learner.base}/answers`).set(auth(learner.token)).send({ questionId, selectedOptionId: 'a' });
        continue;
      }
      expect((await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId })).status).toBe(202);
      await drain();
      requested += 1;
    }
    const step = await readStep(learner);
    const current = step.practice.question;
    expect(current.tutor).toEqual({ available: false, reason: current.hints.length === 4 ? 'HINTS_USED' : 'DAILY_LIMIT', remainingToday: 0 });
    if (current.hints.length === 4) await api().post(`${learner.base}/answers`).set(auth(learner.token)).send({ questionId: current.id, selectedOptionId: 'a' });
    const after = await readStep(learner);
    if (after.practice.status === 'IN_PROGRESS') {
      const refused = await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: after.practice.question.id });
      expect(refused.body.error).toMatchObject({ code: 'TUTOR_DAILY_LIMIT' });
      // The written hints still work.
      expect((await api().post(`${learner.base}/hints`).set(auth(learner.token)).send({ questionId: after.practice.question.id })).status).toBe(201);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM tutor_hints WHERE subject_user_id = $1', [learner.id])).rows[0].n).toBe(20);
  });

  it('the 0108 guards: a request at a level the step does not record, a changed request, or a deletion are refused', async () => {
    const learner = await learnerWithStep({ consent: true });
    await expect(pool.query(`INSERT INTO tutor_hints (id, subject_user_id, decision_id, item_id, hint_level, language, prompt_version, policy_version, correlation_id)
      VALUES ($1,$2,$3,$4,2,'en','tutor-hint@2','tutor-hint-policy-v1','x')`, [randomUUID(), learner.id, learner.decisionId, learner.questionId])).rejects.toThrow(/level the item records/u);
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    const row = await hintRow(learner.decisionId, learner.questionId, 1);
    await expect(pool.query("UPDATE tutor_hints SET hint_level = 2 WHERE id = $1", [row.id])).rejects.toThrow(/never changed/u);
    await expect(pool.query("UPDATE tutor_hints SET status = 'SHOWN' WHERE id = $1", [row.id])).rejects.toThrow();
    await expect(pool.query("UPDATE tutor_hints SET review_state = 'PUBLISHED' WHERE id = $1", [row.id])).rejects.toThrow();
    await expect(pool.query('DELETE FROM tutor_hints WHERE id = $1', [row.id])).rejects.toThrow(/privacy deletion/u);
  });
});

describe('ENG-22: staff review, privacy export and deletion', () => {
  beforeEach(async () => { await switchOn(); sandbox(true); });

  it('staff see a sample and the refused hints with findings, never the student, and record a verdict once', async () => {
    const learner = await learnerWithStep({ consent: true });
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    await drain();
    script = () => ({ status: 200, json: completion(JSON.stringify({ type: 'HINT', text: 'Pick option (b).' }), undefined, 'stop', MODEL) });
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    await drain();
    const sample = await listTutorHintsForReview(db as unknown as PersistenceDb, { view: 'sample', limit: 200 });
    const refused = await listTutorHintsForReview(db as unknown as PersistenceDb, { view: 'refused', limit: 200 });
    expect(sample.hints.length).toBeGreaterThan(0);
    expect(sample.hints.length).toBeLessThanOrEqual(20);
    expect(refused.hints.find((hint) => hint.generatedText === 'Pick option (b).')).toMatchObject({ status: 'FALLBACK', fallbackReason: 'GUARD_REFUSED', guardFindings: ['ANSWER_LEAK'] });
    const text = JSON.stringify([sample, refused]);
    expect(text).not.toContain(learner.id);
    expect(text).not.toContain(learner.email);
    const shownRow = await hintRow(learner.decisionId, learner.questionId, 1);
    const actor = { userId: reviewer, correlationId: 'eng22-review', breakGlass: false };
    await expect(reviewTutorHint(db as unknown as PersistenceDb, actor, { tutorHintId: shownRow.id, verdict: 'APPROVE', reasonCode: 'LEAKS_ANSWER' })).rejects.toThrow(/INVALID_REASON/u);
    expect(await reviewTutorHint(db as unknown as PersistenceDb, actor, { tutorHintId: shownRow.id, verdict: 'APPROVE', reasonCode: 'ACCURATE_AND_SAFE' }))
      .toEqual({ id: shownRow.id, reviewState: 'PUBLISHED' });
    await expect(reviewTutorHint(db as unknown as PersistenceDb, actor, { tutorHintId: shownRow.id, verdict: 'REJECT', reasonCode: 'UNSAFE' })).rejects.toThrow(/ALREADY_REVIEWED/u);
    expect(await hintRow(learner.decisionId, learner.questionId, 1)).toMatchObject({ review_state: 'PUBLISHED', reviewed_by_user_id: reviewer, review_reason_code: 'ACCURATE_AND_SAFE' });
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'tutor.hint.reviewed' AND resource_id = $1", [shownRow.id])).rows[0].n).toBe(1);
  });

  it('the student\'s export lists the AI hints they were shown, not the refused text; deletion removes every row', async () => {
    const learner = await learnerWithStep({ consent: true });
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    await drain();
    script = () => ({ status: 200, json: completion(JSON.stringify({ type: 'HINT', text: 'It is 42, trust me.' }), undefined, 'stop', MODEL) });
    await api().post(`${learner.base}/tutor-hints`).set(auth(learner.token)).send({ questionId: learner.questionId });
    await drain();
    const bundle = await assembleSubjectExport(db as unknown as PersistenceDb, learner.id) as Record<string, any>;
    const step = (bundle.learning.steps as Record<string, any>[]).find((entry) => entry.aiTutorHints?.length);
    expect(step?.aiTutorHints).toEqual([
      expect.objectContaining({ level: 1, outcome: 'AI_HINT_SHOWN', aiHintShown: SAFE_HINT, model: MODEL, promptVersion: 'tutor-hint@2', reviewState: 'DRAFT' }),
      expect.objectContaining({ level: 2, outcome: 'WRITTEN_HINT_SHOWN', aiHintShown: null }),
    ]);
    expect(JSON.stringify(bundle)).not.toContain('It is 42, trust me.');
    expect((bundle.notIncluded as string[]).join(' ')).toMatch(/AI tutor/u);

    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
      VALUES ($1, $2, $2, 'DELETION', now() - interval '31 days', now() - interval '1 day')`, [randomUUID(), learner.id]);
    const summaries = await executeDueDeletions({ db: db as unknown as PersistenceDb, ids: { uuid: () => randomUUID() } });
    expect(summaries.find((summary) => summary.subjectUserId === learner.id)?.outcome).toBe('COMPLETED');
    expect((await pool.query('SELECT count(*)::int AS n FROM tutor_hints WHERE subject_user_id = $1', [learner.id])).rows[0].n).toBe(0);
  });
});

async function applyMigrations(targetPool: Pool): Promise<void> {
  const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const migrationName of migrations) {
    const migration = (await readFile(new URL(migrationName, migrationDir), 'utf8'))
      .replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
    await targetPool.query(migration);
  }
}

function signAccessToken(signingKey: KeyObject, input: { readonly sub: string; readonly email: string }): string {
  const header = base64UrlJson({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const payload = base64UrlJson({
    iss: issuer, sub: input.sub, client_id: clientId, token_use: 'access',
    exp: Math.floor(new Date('2026-08-16T13:00:00Z').getTime() / 1000),
    iat: Math.floor(new Date('2026-08-16T11:00:00Z').getTime() / 1000),
    email: input.email, email_verified: true,
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(signingKey).toString('base64url')}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function publicKeyToTrustedJwk(key: KeyObject, kid: string): TrustedJwk {
  const jwk = key.export({ format: 'jwk' }) as JsonWebKey;
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new Error('invalid test key');
  return { kty: 'RSA', kid, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' };
}
