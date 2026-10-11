/**
 * The bake-off end to end (ENG-21), against the real database and no real network: the Python
 * harness (deploy/ai-pod/bake-off/run_bakeoff.py) runs the committed evaluation set against a local
 * fake of the vLLM endpoint, and the importer turns its results file into `ai_evaluations` rows.
 *
 * Pinned: the harness's results are accepted by the importer; a PASS needs a review sheet; records
 * carry the metrics, thresholds, set and prompt the feature runs; the importer refuses malformed,
 * mismatched, partial, already-recorded or unauthorised imports and writes nothing when it refuses;
 * nothing is switched on; a recorded PASS is what 0089 accepts for switching on, and a FAIL is not.
 *
 * Each test runs in a transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { oneAiFeatures } from '@planthepath/ai-orchestration/src/index.js';
import { startFakeOpenAiServer, type FakeOpenAiServer } from '@planthepath/ai-orchestration/src/testing/fake-openai-server.js';
import {
  buildReviewSheet, committedSetPath, contentSha256, readBakeOffResults, repositoryEvaluationSet, repositoryExplainEvaluationSet, type EvaluationCase, type EvaluationSet,
} from '@planthepath/ai-evaluation/src/index.js';
import { completionBody, goodReply, leakyReply } from '@planthepath/ai-evaluation/src/testing/simulated-replies.js';
import { BakeOffImportError, importBakeOffResults, registerOneAiFeatures } from '../src/ai-bake-off.js';
import type { SqlRunner } from '../src/ai-operations.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);
const harness = fileURLToPath(new URL('../../../deploy/ai-pod/bake-off/run_bakeoff.py', import.meta.url));
const python = process.env.BAKEOFF_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

// A test-only sentinel; not a credential.
const testKey = 'test-only-bakeoff-bearer-0021';
const model = 'qwen2.5-14b-instruct';

type Db = SqlRunner & { transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> };

const { set } = repositoryEvaluationSet();
// ADR-052: the explain set's cases too, so the harness can run either set against the fake endpoint.
const explainSet = repositoryExplainEvaluationSet().set;
const caseByRequest = new Map<string, EvaluationCase>([...set.cases, ...explainSet.cases].map((entry) => [JSON.stringify(entry.request.messages), entry]));

let server: FakeOpenAiServer;
let reply: (entry: EvaluationCase) => string = goodReply;
let workDir: string;
let goodResultsText: string;
let leakyResultsText: string;
let explainResultsText: string;

/**
 * Run the real harness against the fake endpoint; returns the results file's text. Asynchronous on
 * purpose: the fake server lives in this process, so blocking on the child would deadlock it.
 */
async function runHarness(extra: readonly string[] = ['--set', committedSetPath]): Promise<string> {
  const out = mkdtempSync(join(workDir, 'out-'));
  const child = spawn(python, [harness, '--model', model, '--base-url', server.baseUrl, '--key-file', join(workDir, 'api-key'), '--out', out, '--concurrency', '8', ...extra]);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  expect(status, `harness failed (${python}): ${output}`).toBe(0);
  expect(output).not.toContain(testKey);
  const files = readdirSync(out).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  return readFileSync(join(out, files[0]!), 'utf8');
}

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
  workDir = mkdtempSync(join(tmpdir(), 'one-bakeoff-'));
  writeFileSync(join(workDir, 'api-key'), `${testKey}\n`);
  server = await startFakeOpenAiServer((request) => {
    if (request.authorization !== `Bearer ${testKey}`) return { status: 401, json: { error: 'unauthorised' } };
    if (request.method === 'GET') return { status: 200, json: { object: 'list', data: [{ id: model, object: 'model' }] } };
    const body = JSON.parse(request.body) as { messages: unknown };
    const entry = caseByRequest.get(JSON.stringify(body.messages));
    if (!entry) return { status: 400, json: { error: 'unknown case' } };
    return { status: 200, json: completionBody(reply(entry)) };
  });
  reply = goodReply;
  goodResultsText = await runHarness();
  reply = leakyReply;
  leakyResultsText = await runHarness();
  reply = goodReply;
  explainResultsText = await runHarness(['--only', 'explain-topic']);
}, 300_000);

afterAll(async () => {
  await server?.close();
  rmSync(workDir, { recursive: true, force: true });
  await pool.end();
});

let client: PoolClient;
let db: Db;
let recorder: string;

/** A Db over the test's transaction: nested transactions run inline and roll back with the test. */
function transactionDb(connection: PoolClient): Db {
  const inner = drizzle(connection) as unknown as SqlRunner;
  const self: Db = { execute: (query) => inner.execute(query), transaction: (work) => work(self) };
  return self;
}

async function member(role: string, capability?: string): Promise<string> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  const platformId = randomUUID();
  await client.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform (bake-off test)')", [platformId]);
  await client.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, `staff-${userId.slice(0, 8)}@example.test`]);
  await client.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,'ACTIVE',$2)`,
    [membershipId, platformId, userId, role],
  );
  if (capability) {
    // Capabilities are never self-granted (0031); a second person grants it.
    const grantor = randomUUID();
    await client.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [grantor, `grantor-${grantor.slice(0, 8)}@example.test`]);
    await client.query(
      'INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), membershipId, capability, grantor, 'NEW_RESPONSIBILITY'],
    );
  }
  return userId;
}

function filledReview(resultsText: string, forSet: EvaluationSet = set): string {
  const results = readBakeOffResults(JSON.parse(resultsText));
  const sheet = buildReviewSheet(forSet, results, contentSha256(resultsText));
  return JSON.stringify({ ...sheet, items: sheet.items.map((item) => ({ ...item, scores: { teaching: 4, language: item.language === 'en' ? 'NA' : 4, factualError: false } })) });
}

async function evaluationRows() {
  return (await client.query(
    `SELECT feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version, metrics, decision, reason_code, note, decided_by_user_id
     FROM ai_evaluations WHERE feature_key = ANY($1) ORDER BY feature_key`, [oneAiFeatures.map((feature) => feature.featureKey)],
  )).rows;
}

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  db = transactionDb(client);
  await client.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
  recorder = await member('OPERATIONS_ADMIN', 'AI_OPS_CONFIGURE');
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

describe('the harness', () => {
  it('writes results the importer accepts: every case once, the committed set\'s hash, the adapter\'s provider key', () => {
    const results = readBakeOffResults(JSON.parse(goodResultsText));
    expect(results.cases).toHaveLength(200);
    expect(results.set).toEqual({ key: 'one-ai-bakeoff', version: 1, sha256: contentSha256(readFileSync(committedSetPath, 'utf8')) });
    expect(results.providerKey).toBe('openai-compatible');
    expect(results.cases.every((entry) => entry.error === null && entry.attempts === 1)).toBe(true);
    expect(server.requests.filter((request) => request.method === 'POST').every((request) => {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      return Object.keys(body).sort().join(',') === 'max_tokens,messages,model,stream,temperature' && body.stream === false;
    })).toBe(true);
  });
});

describe('registering the features', () => {
  it('inserts the declared features switched off, and leaves an existing row alone', async () => {
    const before = (await client.query('SELECT feature_key FROM ai_feature_policies WHERE feature_key = ANY($1)', [oneAiFeatures.map((feature) => feature.featureKey)])).rows;
    const first = await registerOneAiFeatures(db);
    // ENG-23 added content.item-draft, declared off like the rest (no evaluation covers it yet); ADR-052 added
    // learning.explain-topic, off until its own set (one-ai-explain) passes.
    expect([...first.registered, ...first.existing.map((entry) => entry.featureKey)].sort())
      .toEqual(['content.answer-check', 'content.item-draft', 'content.lesson-draft', 'learning.explain-topic', 'tutor.hint']);
    const rows = (await client.query('SELECT feature_key, enabled, model, prompt_key, prompt_version FROM ai_feature_policies WHERE feature_key = ANY($1) ORDER BY feature_key', [oneAiFeatures.map((feature) => feature.featureKey)])).rows;
    if (!before.length) {
      expect(rows).toEqual([
        { feature_key: 'content.answer-check', enabled: false, model, prompt_key: 'content-answer-check', prompt_version: 1 },
        { feature_key: 'content.item-draft', enabled: false, model, prompt_key: 'content-item-draft', prompt_version: 1 },
        { feature_key: 'content.lesson-draft', enabled: false, model, prompt_key: 'content-lesson-draft', prompt_version: 2 },
        { feature_key: 'learning.explain-topic', enabled: false, model, prompt_key: 'explain-topic', prompt_version: 1 },
        { feature_key: 'tutor.hint', enabled: false, model, prompt_key: 'tutor-hint', prompt_version: 2 },
      ]);
    }
    await client.query("UPDATE ai_feature_policies SET model = 'operator/choice', cap = 7 WHERE feature_key = 'tutor.hint'");
    const second = await registerOneAiFeatures(db);
    expect(second.registered).toEqual([]);
    expect(second.existing).toEqual(expect.arrayContaining([{ featureKey: 'tutor.hint', promptMatches: true }]));
    expect((await client.query("SELECT model, cap FROM ai_feature_policies WHERE feature_key = 'tutor.hint'")).rows[0]).toEqual({ model: 'operator/choice', cap: 7 });
  });
});

describe('importing a run', () => {
  beforeEach(async () => { await registerOneAiFeatures(db); });

  it('records one PASS per feature, with metrics, thresholds, the set and the prompt, audited, and switches nothing on', async () => {
    const outcome = await importBakeOffResults(db, { resultsText: goodResultsText, reviewText: filledReview(goodResultsText), recorderUserId: recorder });
    expect(outcome.evaluations.map((entry) => [entry.featureKey, entry.decision])).toEqual([
      ['tutor.hint', 'PASS'], ['content.lesson-draft', 'PASS'], ['content.answer-check', 'PASS'],
    ]);
    const rows = await evaluationRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const feature = oneAiFeatures.find((entry) => entry.featureKey === row.feature_key)!;
      expect(row).toMatchObject({
        provider_key: 'openai-compatible', model, prompt_key: feature.prompt.key, prompt_version: feature.prompt.version,
        evaluation_set_key: 'one-ai-bakeoff', evaluation_set_version: 1, decision: 'PASS', reason_code: 'INITIAL_BENCHMARK', decided_by_user_id: recorder,
      });
      expect(row.note).toContain(outcome.resultsSha256);
      expect(row.note.length).toBeLessThanOrEqual(500);
      expect(row.metrics.every((metric: Record<string, unknown>) => Object.keys(metric).sort().join(',') === 'comparator,name,threshold,value')).toBe(true);
    }
    const tutor = rows.find((row) => row.feature_key === 'tutor.hint')!;
    expect(tutor.metrics.find((metric: { name: string }) => metric.name === 'answer_leak_rate')).toEqual({ name: 'answer_leak_rate', value: 0, threshold: 0.0099, comparator: 'AT_MOST' });
    const audits = (await client.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'operations.ai.evaluation.recorded' AND actor_user_id = $1", [recorder])).rows[0];
    expect(audits.n).toBe(3);
    const events = (await client.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'ai_evaluation.recorded' AND actor_user_id = $1", [recorder])).rows[0];
    expect(events.n).toBe(3);
    expect((await client.query('SELECT bool_or(enabled) AS any FROM ai_feature_policies WHERE feature_key = ANY($1)', [oneAiFeatures.map((feature) => feature.featureKey)])).rows[0].any).toBe(false);
    expect((await client.query("SELECT ai_evaluation_passes('tutor.hint', $1, 'tutor-hint', 2) AS passes", [model])).rows[0].passes).toBe(true);
  });

  it('gives 0089 what it needs: a recorded PASS lets the feature switch on; a leaky run FAIL does not', async () => {
    await client.query("UPDATE ai_feature_policies SET model = $1, prompt_key = 'tutor-hint', prompt_version = 2 WHERE feature_key = 'tutor.hint'", [model]);
    await importBakeOffResults(db, { resultsText: leakyResultsText, recorderUserId: recorder, onlyFeatures: ['tutor.hint'] });
    expect(await evaluationRows()).toEqual([expect.objectContaining({ feature_key: 'tutor.hint', decision: 'FAIL' })]);
    await client.query('SAVEPOINT before_enable');
    await expect(client.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'tutor.hint'")).rejects.toThrow(/passing evaluation/u);
    await client.query('ROLLBACK TO SAVEPOINT before_enable');
    await client.query("UPDATE ai_feature_policies SET model = $1, prompt_key = 'content-answer-check', prompt_version = 1 WHERE feature_key = 'content.answer-check'", [model]);
    await importBakeOffResults(db, { resultsText: goodResultsText, recorderUserId: recorder, onlyFeatures: ['content.answer-check'] });
    await client.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'content.answer-check'");
    expect((await client.query("SELECT enabled FROM ai_feature_policies WHERE feature_key = 'content.answer-check'")).rows[0].enabled).toBe(true);
  });

  it('ADR-052: the harness runs one-ai-explain on its own; the import records learning.explain-topic, and 0089 then (and only then) lets it switch on', async () => {
    const results = readBakeOffResults(JSON.parse(explainResultsText));
    expect(results.set.key).toBe('one-ai-explain');
    expect(results.cases).toHaveLength(55);
    expect(results.batches.map((batch) => batch.task)).toEqual(['explain-topic']);
    await client.query("UPDATE ai_feature_policies SET model = $1 WHERE feature_key = 'learning.explain-topic'", [model]);
    await client.query('SAVEPOINT explain_off');
    await expect(client.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'learning.explain-topic'")).rejects.toThrow(/passing evaluation/u);
    await client.query('ROLLBACK TO SAVEPOINT explain_off');
    await expect(importBakeOffResults(db, { resultsText: explainResultsText, recorderUserId: recorder })).rejects.toMatchObject({ code: 'HUMAN_REVIEW_REQUIRED' });
    const outcome = await importBakeOffResults(db, { resultsText: explainResultsText, reviewText: filledReview(explainResultsText, explainSet), recorderUserId: recorder });
    expect(outcome.evaluations.map((entry) => [entry.featureKey, entry.promptKey, entry.promptVersion, entry.decision])).toEqual([['learning.explain-topic', 'explain-topic', 1, 'PASS']]);
    const [row] = (await evaluationRows()).filter((entry) => entry.feature_key === 'learning.explain-topic');
    expect(row).toMatchObject({ evaluation_set_key: 'one-ai-explain', evaluation_set_version: 1, decision: 'PASS' });
    expect(row!.note).toContain('explanations per student-month');
    await client.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'learning.explain-topic'");
    expect((await client.query("SELECT enabled FROM ai_feature_policies WHERE feature_key = 'learning.explain-topic'")).rows[0].enabled).toBe(true);
  });

  it('refuses a PASS without a review sheet, but records a FAIL the operator asks for', async () => {
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, recorderUserId: recorder })).rejects.toMatchObject({ code: 'HUMAN_REVIEW_REQUIRED' });
    expect(await evaluationRows()).toEqual([]);
    const outcome = await importBakeOffResults(db, { resultsText: goodResultsText, recorderUserId: recorder, decision: 'FAIL', reasonCode: 'INCIDENT_REVIEW' });
    expect(outcome.evaluations.every((entry) => entry.decision === 'FAIL')).toBe(true);
    expect((await evaluationRows()).map((row) => row.note)).toEqual(expect.arrayContaining([expect.stringContaining('FAIL recorded by the operator')]));
  });

  it('records a feature that auto-fails without needing a review, and the answer check (no human metrics) can PASS alone', async () => {
    const outcome = await importBakeOffResults(db, { resultsText: leakyResultsText, recorderUserId: recorder, onlyFeatures: ['tutor.hint', 'content.answer-check'] });
    expect(outcome.evaluations.map((entry) => [entry.featureKey, entry.decision])).toEqual([['tutor.hint', 'FAIL'], ['content.answer-check', 'PASS']]);
    expect(outcome.evaluations[0]!.failedMetrics).toContain('answer_leak_rate');
  });

  it('refuses malformed, mismatched, partial and duplicated results, and writes nothing', async () => {
    const results = JSON.parse(goodResultsText) as Record<string, unknown> & { cases: unknown[]; set: Record<string, unknown> };
    const attempts: [string, string][] = [
      ['{', 'RESULTS_MALFORMED'],
      [JSON.stringify({ ...results, format: 'promptfoo' }), 'RESULTS_MALFORMED'],
      [JSON.stringify({ ...results, set: { ...results.set, sha256: '0'.repeat(64) } }), 'RESULTS_SET_MISMATCH'],
      [JSON.stringify({ ...results, set: { ...results.set, version: 2 } }), 'RESULTS_SET_MISMATCH'],
      [JSON.stringify({ ...results, cases: results.cases.slice(1) }), 'RESULTS_CASES_MISMATCH'],
      [JSON.stringify({ ...results, partial: true }), 'RESULTS_PARTIAL'],
    ];
    for (const [text, code] of attempts) {
      await expect(importBakeOffResults(db, { resultsText: text, recorderUserId: recorder, decision: 'FAIL' }), code).rejects.toMatchObject({ code });
    }
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, reviewText: '{"format":"one-bakeoff-review"}', recorderUserId: recorder })).rejects.toMatchObject({ code: 'REVIEW_MALFORMED' });
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, reviewText: filledReview(leakyResultsText), recorderUserId: recorder })).rejects.toMatchObject({ code: 'REVIEW_RESULTS_MISMATCH' });
    expect(await evaluationRows()).toEqual([]);
    await importBakeOffResults(db, { resultsText: goodResultsText, reviewText: filledReview(goodResultsText), recorderUserId: recorder });
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, reviewText: filledReview(goodResultsText), recorderUserId: recorder })).rejects.toMatchObject({ code: 'RESULTS_ALREADY_RECORDED' });
    expect(await evaluationRows()).toHaveLength(3);
  });

  it('refuses a smoke run made with --limit', async () => {
    const partial = await runHarness(['--set', committedSetPath, '--limit', '2']);
    expect(readBakeOffResults(JSON.parse(partial)).partial).toBe(true);
    await expect(importBakeOffResults(db, { resultsText: partial, recorderUserId: recorder, decision: 'FAIL' })).rejects.toMatchObject({ code: 'RESULTS_PARTIAL' });
  }, 60_000);

  it('refuses a recorder without AI_OPS_CONFIGURE, an unregistered feature and an unknown reason', async () => {
    const operations = await member('OPERATIONS_ADMIN');
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, recorderUserId: operations, decision: 'FAIL' })).rejects.toMatchObject({ code: 'RECORDER_NOT_AUTHORISED' });
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, recorderUserId: 'not-a-uuid', decision: 'FAIL' })).rejects.toMatchObject({ code: 'RECORDER_NOT_AUTHORISED' });
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, recorderUserId: recorder, decision: 'FAIL', reasonCode: 'BECAUSE' })).rejects.toMatchObject({ code: 'REASON_CODE_INVALID' });
    const featureKeys = { 'tutor-hint': `eng21.${randomUUID().slice(0, 8)}` };
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, recorderUserId: recorder, decision: 'FAIL', featureKeys })).rejects.toMatchObject({ code: 'FEATURE_NOT_REGISTERED' });
    await expect(importBakeOffResults(db, { resultsText: goodResultsText, recorderUserId: recorder, decision: 'FAIL', onlyFeatures: ['tutor.other'] })).rejects.toMatchObject({ code: 'FEATURE_UNKNOWN' });
    expect(await evaluationRows()).toEqual([]);
  });

  it('plans without writing on a dry run', async () => {
    const outcome = await importBakeOffResults(db, { resultsText: goodResultsText, reviewText: filledReview(goodResultsText), recorderUserId: recorder, dryRun: true });
    expect(outcome.dryRun).toBe(true);
    expect(outcome.evaluations.every((entry) => entry.evaluationId === null && entry.decision === 'PASS')).toBe(true);
    expect(await evaluationRows()).toEqual([]);
  });

  it('is typed: every refusal is a BakeOffImportError with a code', async () => {
    await expect(importBakeOffResults(db, { resultsText: 'nope', recorderUserId: recorder })).rejects.toBeInstanceOf(BakeOffImportError);
  });
});
