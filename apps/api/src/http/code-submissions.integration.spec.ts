/**
 * ENG-12 end to end, on synthetic data: the code sandbox's request, job and evidence path.
 *
 * Part 1 runs against a fake Piston HTTP server (no Docker, no network):
 * - off by default; on, POST answers 202 with a QUEUED submission and calls nothing (the job runs it);
 * - the outbox worker sends the program with ONE's limits and token, grades each case, and records
 *   COMPLETED with provenance and a graded PRACTICE attempt (the evidence, ADR-049) — never
 *   evidence_records or readiness;
 * - a blank sandbox URL, an unreachable sandbox or a sandbox error ends FAILED with a stable code and
 *   a plain sentence — no upstream text, no stack, no crash; a redelivered event never runs twice;
 * - one open submission, per-student and global daily caps, the switch re-checked in the worker;
 * - the student sees only their own submission; the tables' guards; privacy export and deletion.
 *
 * Part 2 is scenario C8 against a REAL local Piston. It runs only when PISTON_URL is set (start one with
 * `bash deploy/sandbox/attack-suite/run.sh`, then PISTON_URL=... PISTON_TOKEN=...); otherwise it is
 * reported as skipped. A Python submission runs in the sandbox, its result becomes evidence (an attempt
 * that moves the skill's stage), and a network call from the code is blocked.
 */
import 'reflect-metadata';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTrustedJwtVerifier, type TrustedJwk } from '@planthepath/identity/src/jwt.js';
import { createLocalIntegrationEventPublisher, publishOutboxOnce } from '@planthepath/persistence/src/automation-workers.js';
import { consumeCodeSubmissionRequested } from '@planthepath/persistence/src/code-submission-worker.js';
import { CODE_SUBMISSIONS_PER_STUDENT_PER_DAY } from '@planthepath/persistence/src/code-submissions.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { assembleSubjectExport } from './privacy-export.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for code sandbox integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-code-sandbox-client';
const keyId = 'code-sandbox-key';
const schemaName = `code_sandbox_${process.pid}`;
const SHA = 'f'.repeat(64);
// Test-only sentinel; not a credential.
const FAKE_TOKEN = 'test-only-sandbox-token-eng12';
const ENV_KEYS = ['ONE_CODE_SANDBOX_URL', 'ONE_CODE_SANDBOX_TOKEN'] as const;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});

const SUM_CASES = [{ stdin: '2 3', expectedStdout: '5' }, { stdin: '40 2', expectedStdout: '42' }];
const SUM_PROGRAM = 'a, b = map(int, input().split())\nprint(a + b)\n';

interface FakeCall { readonly headers: IncomingHttpHeaders; readonly body: Record<string, unknown> }
type FakeReply = { readonly status: number; readonly body: unknown };

let adminPool: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;
let fake: Server;
let fakeUrl: string;
let fakeCalls: FakeCall[];
let fakeScript: (body: Record<string, unknown>) => FakeReply;
let author: string;
let skillId: string;
let sumTask: string;
const savedEnv: Record<string, string | undefined> = {};

/** A Piston answer for a program that printed `stdout` and exited 0. */
function pistonOk(stdout: string): FakeReply {
  return { status: 200, body: { language: 'python', version: '3.12.0', run: { stdout, stderr: '', code: 0, signal: null, output: stdout, memory: 5_000_000, message: null, status: null, cpu_time: 40, wall_time: 60 } } };
}

/** The fake "runs" the sum program by adding the two numbers on stdin. */
const sumScript = (body: Record<string, unknown>): FakeReply => {
  const [a, b] = String(body.stdin).split(' ').map(Number);
  return pistonOk(`${(a ?? 0) + (b ?? 0)}\n`);
};

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
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

  fake = createServer((incoming, outgoing) => {
    let raw = '';
    incoming.on('data', (chunk) => { raw += chunk; });
    incoming.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      fakeCalls.push({ headers: incoming.headers, body });
      const reply = incoming.url === '/api/v2/execute' ? fakeScript(body) : { status: 404, body: { message: 'not found' } };
      outgoing.writeHead(reply.status, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  author = (await student()).id;
  skillId = await topic('Synthetic Python basics skill');
  sumTask = await codeTask({ key: `eng12-sum-${randomUUID().slice(0, 8)}`, testCases: SUM_CASES });
});

afterAll(async () => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()));
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
});

beforeEach(async () => {
  fakeCalls = [];
  fakeScript = sumScript;
  sandboxAt(fakeUrl, FAKE_TOKEN);
  await switchSandbox(true);
});

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'x-correlation-id': `code-${randomUUID()}` });

/** The worker's environment (same process here). */
function sandboxAt(url: string | null, token: string | null): void {
  if (url === null) delete process.env.ONE_CODE_SANDBOX_URL; else process.env.ONE_CODE_SANDBOX_URL = url;
  if (token === null) delete process.env.ONE_CODE_SANDBOX_TOKEN; else process.env.ONE_CODE_SANDBOX_TOKEN = token;
}

async function switchSandbox(on: boolean): Promise<void> {
  await pool.query("UPDATE feature_flags SET enabled = $1 WHERE key = 'learning.code-sandbox'", [on]);
}

/** Drains the outbox through the real local dispatcher, as the worker does (ADR-028). */
async function drain(): Promise<void> {
  const local = createLocalIntegrationEventPublisher({ pool, db: db as unknown as PersistenceDb });
  for (let round = 0; round < 5; round += 1) {
    const clock = (await pool.query<{ at: Date }>("SELECT clock_timestamp() + interval '1 second' AS at")).rows[0]!.at;
    const result = await publishOutboxOnce({ db: db as unknown as PersistenceDb, publisher: local.publisher, leaseOwner: 'eng12-test', now: new Date(clock) });
    if (result.claimed === 0) return;
  }
}

async function student(): Promise<{ id: string; token: string; email: string }> {
  const sub = `sub:${randomUUID()}`;
  const email = `${randomUUID()}@code-sandbox.test`;
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject: sub, email, state: 'ACTIVE' });
  return { id, token: signAccessToken(privateKey, { sub, email }), email };
}

async function topic(name: string): Promise<string> {
  const [id, revision] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, id, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'Synthetic topic for ENG-12 tests', $4)`, [id, `eng12-${id}`, name, revision]);
  return id;
}

async function codeTask(input: { key: string; testCases: readonly { stdin: string; expectedStdout: string }[]; state?: 'PUBLISHED' | 'DRAFT' }): Promise<string> {
  const id = randomUUID();
  const published = (input.state ?? 'PUBLISHED') === 'PUBLISHED';
  await pool.query(`INSERT INTO code_tasks (id, stable_key, version, skill_id, language, language_version, title, statement, test_cases, state, created_by_user_id, published_at)
    VALUES ($1, $2, 1, $3, 'python', '3.12.0', 'Synthetic: add two numbers', 'Read two integers and print their sum.', $4::jsonb, $5, $6, $7)`,
  [id, input.key, skillId, JSON.stringify(input.testCases), input.state ?? 'PUBLISHED', author, published ? new Date() : null]);
  return id;
}

async function submit(token: string, taskId: string, source: string): Promise<request.Response> {
  return api().post('/api/v1/learning/code-submissions').set(auth(token)).send({ taskId, source });
}

async function submissionRow(id: string): Promise<Record<string, any>> {
  return (await pool.query('SELECT * FROM code_submissions WHERE id = $1', [id])).rows[0];
}

async function attemptsFor(submissionId: string): Promise<Record<string, any>[]> {
  return (await pool.query(`SELECT e.*, s.mode AS session_mode, s.source_type AS session_source FROM learning_attempt_events e
    JOIN learning_sessions s ON s.id = e.session_id WHERE e.source_attempt_type = 'code_submission' AND e.source_attempt_id = $1`, [submissionId])).rows;
}

async function grantAdaptiveLearning(userId: string): Promise<void> {
  const live = await pool.query("SELECT version FROM consent_definitions WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL AND effective_from <= now()");
  let version = live.rows[0]?.version as string | undefined;
  if (!version) {
    version = 'eng12-api-synthetic';
    await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
      VALUES ('adaptive-learning', $1, 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')`, [version]);
  }
  await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at) VALUES ($1, $2, 'adaptive-learning', $3, 'GRANTED', now())`,
    [randomUUID(), userId, version]);
}

describe('ENG-12 code submissions (fake sandbox)', () => {
  it('requires an authenticated caller on both routes', async () => {
    expect((await api().post('/api/v1/learning/code-submissions').send({ taskId: sumTask, source: SUM_PROGRAM })).status).toBe(401);
    expect((await api().get(`/api/v1/learning/code-submissions/${randomUUID()}`)).status).toBe(401);
  });

  it('is off by default: the switch ships off with its own daily cap, and nothing is queued while off', async () => {
    const flag = (await pool.query("SELECT cap_kind, cap_value, cap_window, high_risk_direction FROM feature_flags WHERE key = 'learning.code-sandbox'")).rows[0];
    expect(flag).toEqual({ cap_kind: 'INVOCATIONS', cap_value: '2000', cap_window: 'DAY', high_risk_direction: 'ENABLE' });
    await switchSandbox(false);
    const learner = await student();
    const response = await submit(learner.token, sumTask, SUM_PROGRAM);
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'CODE_SANDBOX_OFF', message: 'The code runner is not switched on.' });
    expect((await pool.query('SELECT count(*)::int AS n FROM code_submissions WHERE subject_user_id = $1', [learner.id])).rows[0].n).toBe(0);
  });

  it('queues (202) without running anything, then the worker grades it and records a PRACTICE attempt — not readiness evidence', async () => {
    const learner = await student();
    const response = await submit(learner.token, sumTask, SUM_PROGRAM);
    expect(response.status).toBe(202);
    expect(response.body.submission).toEqual({ id: expect.any(String), status: 'QUEUED' });
    const id = response.body.submission.id as string;
    // Nothing ran in the request.
    expect(fakeCalls).toHaveLength(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'code.submission.requested' AND aggregate_id = $1", [id])).rows[0].n).toBe(1);
    expect((await api().get(`/api/v1/learning/code-submissions/${id}`).set(auth(learner.token))).body.submission).toMatchObject({ status: 'QUEUED', verdict: null });

    await drain();

    // The sandbox got the program, each case's input, the v1 limits and the token.
    expect(fakeCalls.map((call) => call.body.stdin)).toEqual(['2 3', '40 2']);
    expect(fakeCalls[0]!.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(fakeCalls[0]!.body).toMatchObject({ language: 'python', version: '3.12.0', files: [{ name: 'main.py', content: SUM_PROGRAM }],
      run_timeout: 5000, run_cpu_time: 3000, run_memory_limit: 134217728 });

    const row = await submissionRow(id);
    expect(row).toMatchObject({ status: 'COMPLETED', verdict: 'PASSED', tests_passed: 2, tests_total: 2, failure_code: null, runner: 'piston',
      runner_version: 'python 3.12.0', limits_version: 'code-sandbox-limits-v1', grader_version: 'code-grader-v1', purpose: 'PRACTICE' });
    expect((await pool.query('SELECT case_index, outcome FROM code_submission_cases WHERE submission_id = $1 ORDER BY case_index', [id])).rows)
      .toEqual([{ case_index: 1, outcome: 'PASSED' }, { case_index: 2, outcome: 'PASSED' }]);

    // The evidence: one graded, unaided PRACTICE attempt on the task's skill (ADR-049).
    const attempts = await attemptsFor(id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ item_source: 'CODE_TASK', item_id: sumTask, item_version: 1, skill_id: skillId, context: 'PRACTICE',
      answered: true, correct: true, score: '1.0000', highest_hint_level: 0, assisted: false, content_version: 'code-task-v1',
      session_mode: 'PRACTICE', session_source: 'code_submission' });
    // Never readiness evidence.
    expect((await pool.query('SELECT count(*)::int AS n FROM evidence_records WHERE subject_user_id = $1', [learner.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM readiness_snapshots WHERE subject_user_id = $1', [learner.id])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT action FROM audit_events WHERE resource_id = $1", [id])).rows.map((r) => r.action).sort())
      .toEqual(['code.submission.completed', 'code.submission.requested']);

    const view = await api().get(`/api/v1/learning/code-submissions/${id}`).set(auth(learner.token));
    expect(view.status).toBe(200);
    expect(view.body.submission).toMatchObject({ id, taskId: sumTask, status: 'COMPLETED', verdict: 'PASSED', testsPassed: 2, testsTotal: 2, failureCode: null,
      message: null, cases: [{ index: 1, outcome: 'PASSED' }, { index: 2, outcome: 'PASSED' }] });
    // Neither the hidden test cases nor the program come back.
    expect(JSON.stringify(view.body)).not.toContain('40 2');
    expect(JSON.stringify(view.body)).not.toContain('print(a + b)');
  });

  it('a wrong answer completes FAILED with partial credit and an incorrect attempt', async () => {
    fakeScript = (body) => (body.stdin === '2 3' ? pistonOk('5\n') : pistonOk('41\n'));
    const learner = await student();
    const id = (await submit(learner.token, sumTask, 'print(5)\n')).body.submission.id as string;
    await drain();
    expect(await submissionRow(id)).toMatchObject({ status: 'COMPLETED', verdict: 'FAILED', tests_passed: 1, tests_total: 2 });
    expect((await attemptsFor(id))[0]).toMatchObject({ correct: false, score: '0.5000', answered: true });
  });

  it('classifies limits: a time limit stops the remaining cases', async () => {
    fakeScript = () => ({ status: 200, body: { language: 'python', version: '3.12.0', run: { stdout: '', stderr: '', code: null, signal: 'SIGKILL', status: 'TO', message: 'Time limit exceeded', wall_time: 5100, cpu_time: 3000, memory: 3_000_000 } } });
    const learner = await student();
    const id = (await submit(learner.token, sumTask, 'while True:\n    pass\n')).body.submission.id as string;
    await drain();
    expect(fakeCalls).toHaveLength(1);
    expect((await pool.query('SELECT case_index, outcome, signal FROM code_submission_cases WHERE submission_id = $1 ORDER BY case_index', [id])).rows)
      .toEqual([{ case_index: 1, outcome: 'TIME_LIMIT', signal: 'SIGKILL' }, { case_index: 2, outcome: 'NOT_RUN', signal: null }]);
    expect(await submissionRow(id)).toMatchObject({ status: 'COMPLETED', verdict: 'FAILED', tests_passed: 0 });
  });

  it('with no sandbox configured the job ends FAILED/SANDBOX_UNAVAILABLE, writes no attempt, and nothing crashes', async () => {
    sandboxAt(null, null);
    const learner = await student();
    const id = (await submit(learner.token, sumTask, SUM_PROGRAM)).body.submission.id as string;
    await drain();
    expect(fakeCalls).toHaveLength(0);
    expect(await submissionRow(id)).toMatchObject({ status: 'FAILED', failure_code: 'SANDBOX_UNAVAILABLE', started_at: null, verdict: null });
    expect(await attemptsFor(id)).toHaveLength(0);
    const view = await api().get(`/api/v1/learning/code-submissions/${id}`).set(auth(learner.token));
    expect(view.body.submission).toMatchObject({ status: 'FAILED', failureCode: 'SANDBOX_UNAVAILABLE',
      message: 'The code runner is not available right now. Your program was not run; you can send it again later.' });
    expect((await pool.query("SELECT delivery_state FROM outbox_events WHERE aggregate_id = $1", [id])).rows[0].delivery_state).toBe('PUBLISHED');
  });

  it('a sandbox failure ends FAILED with a stable code; its text never reaches the student', async () => {
    const leak = 'Error: isolate --init failed at /piston_api/src/job.js:71 cgroup /sys/fs/cgroup/isolate';
    const cases: [FakeReply, string][] = [
      [{ status: 500, body: { message: leak } }, 'SANDBOX_UNAVAILABLE'],
      [{ status: 400, body: { message: `run_timeout cannot exceed the configured limit; ${leak}` } }, 'SANDBOX_REJECTED'],
      [{ status: 200, body: { language: 'python', version: '3.12.0', run: { status: 'XX', message: leak, stdout: '', code: null, signal: null } } }, 'SANDBOX_ERROR'],
    ];
    for (const [reply, code] of cases) {
      fakeScript = () => reply;
      const learner = await student();
      const id = (await submit(learner.token, sumTask, SUM_PROGRAM)).body.submission.id as string;
      await drain();
      expect(await submissionRow(id)).toMatchObject({ status: 'FAILED', failure_code: code });
      expect(await attemptsFor(id)).toHaveLength(0);
      const view = await api().get(`/api/v1/learning/code-submissions/${id}`).set(auth(learner.token));
      expect(view.body.submission.failureCode).toBe(code);
      expect(JSON.stringify(view.body)).not.toMatch(/isolate|piston_api|cgroup|configured limit|stack/i);
      const audit = (await pool.query("SELECT context FROM audit_events WHERE resource_id = $1 AND action = 'code.submission.completed'", [id])).rows[0].context;
      expect(JSON.stringify(audit)).not.toMatch(/isolate|piston_api/);
    }
    // An unreachable sandbox too.
    sandboxAt('http://127.0.0.1:1', FAKE_TOKEN);
    const learner = await student();
    const id = (await submit(learner.token, sumTask, SUM_PROGRAM)).body.submission.id as string;
    await drain();
    expect(await submissionRow(id)).toMatchObject({ status: 'FAILED', failure_code: 'SANDBOX_UNAVAILABLE' });
  });

  it('a redelivered event never runs the program twice or writes a second attempt', async () => {
    const learner = await student();
    const id = (await submit(learner.token, sumTask, SUM_PROGRAM)).body.submission.id as string;
    const event = (await pool.query("SELECT id, correlation_id FROM outbox_events WHERE aggregate_id = $1", [id])).rows[0];
    // The envelope the dispatcher would hand the consumer for this outbox row.
    const envelope = { eventId: event.id, eventType: 'code.submission.requested', eventVersion: 1, occurredAt: new Date().toISOString(),
      aggregateId: id, correlationId: event.correlation_id, payload: { codeSubmissionId: id } } as unknown as Parameters<typeof consumeCodeSubmissionRequested>[1];
    const env = { ONE_CODE_SANDBOX_URL: fakeUrl, ONE_CODE_SANDBOX_TOKEN: FAKE_TOKEN };
    const first = await consumeCodeSubmissionRequested({ db: db as unknown as PersistenceDb, env }, envelope);
    const second = await consumeCodeSubmissionRequested({ db: db as unknown as PersistenceDb, env }, envelope);
    expect(first).toEqual({ executed: true, outcome: 'PASSED' });
    expect(second).toEqual({ executed: false, outcome: 'NOTHING_TO_DO' });
    expect(fakeCalls).toHaveLength(2);
    expect(await attemptsFor(id)).toHaveLength(1);
  });

  it('allows one open submission at a time, and closes one left open past its window', async () => {
    const learner = await student();
    const first = await submit(learner.token, sumTask, SUM_PROGRAM);
    expect(first.status).toBe(202);
    const second = await submit(learner.token, sumTask, SUM_PROGRAM);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'SUBMISSION_PENDING' });
    // A lost job: back-date the open row past the 10-minute window. requested_at is part of the request the
    // change guard freezes, so the guard is lifted for this one fixture write only and restored at once.
    await pool.query("ALTER TABLE code_submissions DISABLE TRIGGER code_submissions_change_guard");
    await pool.query("UPDATE code_submissions SET requested_at = now() - interval '11 minutes' WHERE id = $1", [first.body.submission.id]);
    await pool.query("ALTER TABLE code_submissions ENABLE TRIGGER code_submissions_change_guard");
    const third = await submit(learner.token, sumTask, SUM_PROGRAM);
    expect(third.status).toBe(202);
    expect(await submissionRow(first.body.submission.id)).toMatchObject({ status: 'FAILED', failure_code: 'EXPIRED' });
    await drain();
  });

  it('enforces the per-student daily limit and the global daily cap (429), and refuses bad input (400/404)', async () => {
    const learner = await student();
    for (let index = 0; index < CODE_SUBMISSIONS_PER_STUDENT_PER_DAY; index += 1) {
      const id = randomUUID();
      await pool.query(`INSERT INTO code_submissions (id, subject_user_id, task_id, language, language_version, source_code, source_sha256, correlation_id)
        VALUES ($1, $2, $3, 'python', '3.12.0', 'print(1)', encode(sha256(convert_to('print(1)', 'UTF8')), 'hex'), 'eng12-cap')`, [id, learner.id, sumTask]);
      await pool.query("UPDATE code_submissions SET status = 'FAILED', failure_code = 'SANDBOX_UNAVAILABLE', completed_at = now() WHERE id = $1", [id]);
    }
    const limited = await submit(learner.token, sumTask, SUM_PROGRAM);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: 'DAILY_LIMIT' });

    const other = await student();
    const today = (await pool.query("SELECT count(*)::int AS n FROM code_submissions WHERE requested_at >= date_trunc('day', now())")).rows[0].n as number;
    await pool.query("UPDATE feature_flags SET cap_value = $1 WHERE key = 'learning.code-sandbox'", [today]);
    try {
      const capped = await submit(other.token, sumTask, SUM_PROGRAM);
      expect(capped.status).toBe(429);
      expect(capped.body.error).toMatchObject({ code: 'CAPACITY_REACHED' });
    } finally {
      await pool.query("UPDATE feature_flags SET cap_value = 2000 WHERE key = 'learning.code-sandbox'");
    }

    expect((await submit(other.token, sumTask, '')).status).toBe(400);
    expect((await submit(other.token, sumTask, 'x'.repeat(20_001))).status).toBe(400);
    expect((await api().post('/api/v1/learning/code-submissions').set(auth(other.token)).send({ taskId: sumTask, source: 'print(1)', extra: true })).status).toBe(400);
    expect((await submit(other.token, randomUUID(), SUM_PROGRAM)).status).toBe(404);
    const draft = await codeTask({ key: `eng12-draft-${randomUUID().slice(0, 8)}`, testCases: SUM_CASES, state: 'DRAFT' });
    expect((await submit(other.token, draft, SUM_PROGRAM)).status).toBe(404);
  });

  it('re-checks the switch in the worker: switched off after the request, the job ends SWITCHED_OFF without running', async () => {
    const learner = await student();
    const id = (await submit(learner.token, sumTask, SUM_PROGRAM)).body.submission.id as string;
    await switchSandbox(false);
    await drain();
    expect(fakeCalls).toHaveLength(0);
    expect(await submissionRow(id)).toMatchObject({ status: 'FAILED', failure_code: 'SWITCHED_OFF' });
  });

  it('shows a student only their own submissions', async () => {
    const owner = await student();
    const stranger = await student();
    const id = (await submit(owner.token, sumTask, SUM_PROGRAM)).body.submission.id as string;
    const response = await api().get(`/api/v1/learning/code-submissions/${id}`).set(auth(stranger.token));
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect((await api().get('/api/v1/learning/code-submissions/not-a-uuid').set(auth(owner.token))).status).toBe(400);
    await drain();
  });

  it('the tables refuse what the design forbids', async () => {
    const learner = await student();
    const id = (await submit(learner.token, sumTask, SUM_PROGRAM)).body.submission.id as string;
    await expect(pool.query("UPDATE code_submissions SET source_code = 'print(2)' WHERE id = $1", [id])).rejects.toThrow(/never changed|hash/);
    await expect(pool.query("UPDATE code_submissions SET status = 'COMPLETED' WHERE id = $1", [id])).rejects.toThrow();
    await expect(pool.query('DELETE FROM code_submissions WHERE id = $1', [id])).rejects.toThrow(/privacy deletion/);
    await expect(pool.query(`INSERT INTO code_submission_cases (id, submission_id, subject_user_id, case_index, outcome) VALUES ($1, $2, $3, 1, 'PASSED')`,
      [randomUUID(), id, learner.id])).rejects.toThrow(/running submission/);
    await expect(pool.query(`INSERT INTO code_submissions (id, subject_user_id, task_id, language, language_version, source_code, source_sha256, correlation_id)
      VALUES ($1, $2, $3, 'python', '3.12.0', 'print(1)', $4, 'x')`, [randomUUID(), learner.id, sumTask, 'a'.repeat(64)])).rejects.toThrow();
    await expect(pool.query(`INSERT INTO code_tasks (id, stable_key, version, skill_id, language, language_version, title, statement, test_cases)
      VALUES ($1, 'eng12-bad-cases', 1, $2, 'python', '3.12.0', 't', 's', '[{"stdin": 1, "expectedStdout": "x"}]'::jsonb)`, [randomUUID(), skillId])).rejects.toThrow(/test case/);
    await expect(pool.query("UPDATE code_tasks SET statement = 'changed' WHERE id = $1", [sumTask])).rejects.toThrow(/never edited/);
    await expect(pool.query('DELETE FROM code_tasks WHERE id = $1', [sumTask])).rejects.toThrow(/retired, never deleted/);
    await drain();
  });

  it('the student\'s export lists their programs and outcomes; deletion removes every row', async () => {
    const learner = await student();
    const id = (await submit(learner.token, sumTask, SUM_PROGRAM)).body.submission.id as string;
    await drain();
    const bundle = await assembleSubjectExport(db as unknown as PersistenceDb, learner.id) as Record<string, any>;
    expect(bundle.learning.codeSubmissions).toEqual([expect.objectContaining({
      taskTitle: 'Synthetic: add two numbers', program: SUM_PROGRAM, status: 'COMPLETED', verdict: 'PASSED', testsPassed: 2, testsTotal: 2,
      caseOutcomes: ['PASSED', 'PASSED'],
    })]);
    expect(JSON.stringify(bundle.learning.codeSubmissions)).not.toContain('40 2');

    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
      VALUES ($1, $2, $2, 'DELETION', now() - interval '31 days', now() - interval '1 day')`, [randomUUID(), learner.id]);
    const summaries = await executeDueDeletions({ db: db as unknown as PersistenceDb, ids: { uuid: () => randomUUID() } });
    expect(summaries.find((summary) => summary.subjectUserId === learner.id)?.outcome).toBe('COMPLETED');
    expect((await pool.query('SELECT count(*)::int AS n FROM code_submissions WHERE subject_user_id = $1', [learner.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM code_submission_cases WHERE subject_user_id = $1', [learner.id])).rows[0].n).toBe(0);
    expect(await attemptsFor(id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Scenario C8 against a real Piston. Skipped unless PISTON_URL is set.
// ---------------------------------------------------------------------------------------------------
const PISTON_URL = process.env.PISTON_URL?.trim() ?? '';
const PISTON_TOKEN = process.env.PISTON_TOKEN?.trim() ?? '';

describe.skipIf(!PISTON_URL)('C8 against a REAL local Piston (needs PISTON_URL; see deploy/sandbox/attack-suite/run.sh)', () => {
  // The student's program adds two numbers — and first tries to reach the internet three ways. If any
  // call got out it would print NETWORK_OPEN and every case would fail; it passes only if all are blocked.
  const C8_PROGRAM = [
    'import socket, urllib.request',
    'a, b = map(int, input().split())',
    'for name, call in [',
    '    ("dns", lambda: socket.gethostbyname("example.com")),',
    '    ("tcp", lambda: socket.create_connection(("1.1.1.1", 443), timeout=2).close()),',
    '    ("http", lambda: urllib.request.urlopen("http://example.com", timeout=2).read()),',
    ']:',
    '    try:',
    '        call()',
    '        print("NETWORK_OPEN", name)',
    '    except Exception:',
    '        pass',
    'print(a + b)',
    '',
  ].join('\n');

  beforeEach(() => {
    sandboxAt(PISTON_URL, PISTON_TOKEN || null);
  });

  it('C8: a Python submission runs in the sandbox, its result becomes evidence, and a network call from the code is blocked', async () => {
    const learner = await student();
    await grantAdaptiveLearning(learner.id);
    const response = await submit(learner.token, sumTask, C8_PROGRAM);
    expect(response.status).toBe(202);
    const id = response.body.submission.id as string;
    await drain();

    const row = await submissionRow(id);
    // Ran in the real sandbox, and passed — so every network call failed inside it.
    expect(row).toMatchObject({ status: 'COMPLETED', verdict: 'PASSED', tests_passed: 2, tests_total: 2, runner: 'piston', runner_version: 'python 3.12.0' });
    expect((await pool.query('SELECT outcome, exit_code FROM code_submission_cases WHERE submission_id = $1 ORDER BY case_index', [id])).rows)
      .toEqual([{ outcome: 'PASSED', exit_code: 0 }, { outcome: 'PASSED', exit_code: 0 }]);
    // Its result became evidence: a graded unaided attempt on the skill, and the projector moved the stage.
    expect(await attemptsFor(id)).toEqual([expect.objectContaining({ item_source: 'CODE_TASK', skill_id: skillId, correct: true, assisted: false, context: 'PRACTICE' })]);
    const state = (await pool.query('SELECT evidence_stage, attempt_count FROM learner_skill_state WHERE subject_user_id = $1 AND skill_id = $2', [learner.id, skillId])).rows[0];
    expect(state).toMatchObject({ evidence_stage: 'RETAINED', attempt_count: 1 });
  });

  it('C8 (control): the same program on a task that expects the network to be open fails, so the block is real', async () => {
    const openTask = await codeTask({ key: `eng12-open-${randomUUID().slice(0, 8)}`, testCases: [{ stdin: '1 1', expectedStdout: 'NETWORK_OPEN dns\nNETWORK_OPEN tcp\nNETWORK_OPEN http\n2' }] });
    const learner = await student();
    const id = (await submit(learner.token, openTask, C8_PROGRAM)).body.submission.id as string;
    await drain();
    expect(await submissionRow(id)).toMatchObject({ status: 'COMPLETED', verdict: 'FAILED' });
    expect((await pool.query('SELECT outcome FROM code_submission_cases WHERE submission_id = $1', [id])).rows).toEqual([{ outcome: 'WRONG_OUTPUT' }]);
  });

  it('real limits are graded: an infinite loop is TIME_LIMIT (rest NOT_RUN) and a memory bomb is MEMORY_LIMIT', async () => {
    const looping = await student();
    const loopId = (await submit(looping.token, sumTask, 'while True:\n    pass\n')).body.submission.id as string;
    await drain();
    expect((await pool.query('SELECT outcome FROM code_submission_cases WHERE submission_id = $1 ORDER BY case_index', [loopId])).rows.map((r) => r.outcome))
      .toEqual(['TIME_LIMIT', 'NOT_RUN']);

    const hungry = await student();
    const memoryId = (await submit(hungry.token, sumTask, 'chunks = []\nwhile True:\n    chunks.append(bytearray(16 * 1024 * 1024))\n')).body.submission.id as string;
    await drain();
    expect((await pool.query('SELECT outcome FROM code_submission_cases WHERE submission_id = $1 ORDER BY case_index', [memoryId])).rows.map((r) => r.outcome))
      .toEqual(['MEMORY_LIMIT', 'MEMORY_LIMIT']);
    expect(await submissionRow(memoryId)).toMatchObject({ status: 'COMPLETED', verdict: 'FAILED', tests_passed: 0 });
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
