/**
 * The worker-side orchestrator (ENG-20) against the real database and a local fake
 * OpenAI-compatible server — no real network, no pod.
 *
 * Pinned: a success is metered with tokens, latency and attempts; the kill switch and a switched-off
 * feature stop the call before any request reaches the endpoint; blank configuration is a metered
 * failure, not a crash; a failure stores its class and never the upstream text; and the probe
 * records reachability without the key.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  AiFeatureDisabledError,
  AiKillSwitchEngagedError,
  InferenceUnconfiguredError,
  InferenceUpstreamError,
  PromptRegistry,
} from '@planthepath/ai-orchestration/src/index.js';
import { completion, startFakeOpenAiServer, type FakeAnswer, type FakeOpenAiServer } from '@planthepath/ai-orchestration/src/testing/fake-openai-server.js';
import { loadLatestAiProviderProbe } from '../src/ai-orchestration.js';
import { createWorkerAiOrchestrator, runAiProviderProbe } from '../src/ai-workers.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

// Test-only sentinels; neither is a credential.
const testKey = 'test-only-bearer-value-0105';
const upstreamText = 'UPSTREAM-DETAIL-must-not-leak';
const model = 'fake/served-model';

const prompt = {
  key: 'eng20.fixture',
  version: 1,
  purpose: 'Integration fixture.',
  system: 'You draft.',
  parameters: ['topic'],
  user: 'Draft about {{topic}}.',
  maxOutputTokens: 64,
  temperature: 0,
};

let client: PoolClient;
let featureKey: string;
let server: FakeOpenAiServer;
let script: (index: number) => FakeAnswer;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
  server = await startFakeOpenAiServer((_request, index) => script(index));
});

beforeEach(async () => {
  script = () => ({ status: 200, json: completion('A draft.', { prompt_tokens: 77, completion_tokens: 12 }, 'stop', model) });
  server.requests.length = 0;
  client = await pool.connect();
  await client.query('BEGIN');
  featureKey = `eng20.${randomUUID().slice(0, 8)}`;
  await client.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
  await client.query(
    `INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, enabled)
     VALUES ($1, 'ENG-20 integration fixture', $2, 5, 'DAY', true)`, [featureKey, model],
  );
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => {
  await server.close();
  await pool.end();
});

const configured = (): Record<string, string> => ({ ONE_AI_BASE_URL: server.baseUrl, ONE_AI_API_KEY: testKey, ONE_AI_MODEL: model });

function generate(env: Record<string, string> = configured()) {
  const { orchestrator } = createWorkerAiOrchestrator({
    db: client, env, prompts: new PromptRegistry([prompt]),
    tuning: { sleep: async () => undefined, timeoutMs: 2_000 },
  });
  return orchestrator.generate({ featureKey, promptKey: prompt.key, promptVersion: 1, parameters: { topic: 'loops' }, correlationId: 'corr-eng20-int' });
}

async function generationRows(): Promise<Record<string, unknown>[]> {
  return (await client.query(
    `SELECT outcome, failure_class, provider_key, model, input_tokens, output_tokens, latency_ms, provider_attempts
     FROM ai_generations WHERE feature_key = $1 ORDER BY occurred_at`, [featureKey],
  )).rows;
}

describe('generation through the worker orchestrator', () => {
  it('meters a success with tokens, latency and attempts, and returns a DRAFT', async () => {
    const record = await generate();
    expect(record.reviewState).toBe('DRAFT');
    expect(server.requests).toHaveLength(1);
    const [row] = await generationRows();
    expect(row).toMatchObject({ outcome: 'SUCCEEDED', failure_class: null, provider_key: 'openai-compatible', model, input_tokens: 77, output_tokens: 12, provider_attempts: 1 });
    expect(Number(row!.latency_ms)).toBeGreaterThanOrEqual(0);
  });

  it('with the kill switch engaged, no request reaches the endpoint', async () => {
    await client.query("UPDATE feature_flags SET enabled = true WHERE key = 'ai.global-kill-switch'");
    await expect(generate()).rejects.toBeInstanceOf(AiKillSwitchEngagedError);
    expect(server.requests).toHaveLength(0);
    expect(await generationRows()).toEqual([expect.objectContaining({ outcome: 'REFUSED', failure_class: 'KILL_SWITCH_ENGAGED', latency_ms: null, provider_attempts: null })]);
  });

  it('with the feature switched off, no request reaches the endpoint', async () => {
    await client.query('UPDATE ai_feature_policies SET enabled = false WHERE feature_key = $1', [featureKey]);
    await expect(generate()).rejects.toBeInstanceOf(AiFeatureDisabledError);
    expect(server.requests).toHaveLength(0);
    expect(await generationRows()).toEqual([expect.objectContaining({ outcome: 'REFUSED', failure_class: 'FEATURE_DISABLED' })]);
  });

  it('with blank configuration, fails as unconfigured without a crash or a request', async () => {
    await expect(generate({ ONE_AI_BASE_URL: '', ONE_AI_API_KEY: '', ONE_AI_MODEL: '' })).rejects.toBeInstanceOf(InferenceUnconfiguredError);
    expect(server.requests).toHaveLength(0);
    expect(await generationRows()).toEqual([expect.objectContaining({ outcome: 'FAILED', failure_class: 'PROVIDER_UNCONFIGURED', provider_key: 'unconfigured' })]);
  });

  it('records a failure by class and attempts, with no upstream text anywhere in the row', async () => {
    script = () => ({ status: 503, raw: upstreamText });
    await expect(generate()).rejects.toBeInstanceOf(InferenceUpstreamError);
    expect(server.requests).toHaveLength(3);
    const rows = await generationRows();
    expect(rows).toEqual([expect.objectContaining({ outcome: 'FAILED', failure_class: 'PROVIDER_SERVER_ERROR', provider_attempts: 3 })]);
    expect(JSON.stringify(rows)).not.toContain('UPSTREAM-DETAIL');
  });

  it('refuses a refusal row that claims a latency (0105)', async () => {
    await expect(client.query(
      `INSERT INTO ai_generations (id, feature_key, prompt_key, prompt_version, provider_key, model, outcome, failure_class, correlation_id, latency_ms)
       VALUES ($1, $2, 'eng20.fixture', 1, 'openai-compatible', $3, 'REFUSED', 'FEATURE_DISABLED', 'corr-eng20-int', 5)`,
      [randomUUID(), featureKey, model],
    )).rejects.toThrow(/ai_generation_latency_ck/);
  });
});

describe('the endpoint probe', () => {
  it('records a reachable endpoint serving the configured model, without the key', async () => {
    script = () => ({ status: 200, json: { object: 'list', data: [{ id: model }] } });
    const result = await runAiProviderProbe({ db: client, env: configured() });
    expect(result).toMatchObject({ configured: true, reachable: true, modelServed: true, failureClass: null, endpointHost: new URL(server.baseUrl).host });
    const latest = await loadLatestAiProviderProbe(client);
    expect(latest).toMatchObject({ providerKey: 'openai-compatible', configured: true, configuredModel: model, reachable: true, modelServed: true });
    const stored = await client.query('SELECT row_to_json(p)::text AS json FROM ai_provider_probes p');
    expect(stored.rows.map((row: { json: string }) => row.json).join('\n')).not.toContain(testKey);
  });

  it('records a refused key as unreachable with its class', async () => {
    script = () => ({ status: 401, raw: upstreamText });
    await runAiProviderProbe({ db: client, env: configured() });
    expect(await loadLatestAiProviderProbe(client)).toMatchObject({ reachable: false, failureClass: 'PROVIDER_AUTH_FAILED', modelServed: null });
  });

  it('records blank configuration as unconfigured, with no request made', async () => {
    await runAiProviderProbe({ db: client, env: {} });
    expect(server.requests).toHaveLength(0);
    expect(await loadLatestAiProviderProbe(client)).toMatchObject({ providerKey: 'unconfigured', configured: false, reachable: false, endpointHost: null, failureClass: 'PROVIDER_UNCONFIGURED' });
  });

  it('keeps probes immutable and inside their retention window', async () => {
    await runAiProviderProbe({ db: client, env: {} });
    await client.query('SAVEPOINT probe_update');
    await expect(client.query('UPDATE ai_provider_probes SET reachable = true')).rejects.toThrow(/immutable/);
    await client.query('ROLLBACK TO SAVEPOINT probe_update');
    await expect(client.query('DELETE FROM ai_provider_probes')).rejects.toThrow(/kept for 90 days/);
  });
});
