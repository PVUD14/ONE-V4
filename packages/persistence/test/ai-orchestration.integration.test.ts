/**
 * The database half of AI Orchestration, wired to the real orchestrator.
 *
 * The interesting assertions are the ones about what cannot happen: a generation for a
 * feature nobody configured, a cap that an outage can exhaust, and generated text
 * finding its way into the metering table.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  AiCapExceededError,
  AiFeatureDisabledError,
  AiOrchestrator,
  PromptRegistry,
  UnconfiguredInferenceProvider,
  InferenceUnconfiguredError,
  type InferenceProvider,
} from '@planthepath/ai-orchestration/src/index.js';
import {
  countAiGenerations,
  loadAiFeaturePolicy,
  recordAiGeneration,
} from '../src/ai-orchestration.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

let client: PoolClient;
let featureKey: string;
let subjectUserId: string;

const prompt = {
  key: 'demo.summary',
  version: 1,
  purpose: 'Integration fixture.',
  system: 'You summarise. {{tone}}',
  parameters: ['tone'],
  user: 'Summarise.',
  maxOutputTokens: 200,
  temperature: 0,
};
const prompts = new PromptRegistry([prompt]);

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  featureKey = `demo.${randomUUID().slice(0, 8)}`;
  subjectUserId = randomUUID();
  await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [subjectUserId, subjectUserId + '@example.test']);
  await client.query(
    `INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, enabled)
     VALUES ($1,'Integration fixture','local/qwen2.5-14b-instruct',2,'DAY',true)`, [featureKey],
  );
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => { await pool.end(); });

function orchestrator(provider: InferenceProvider): AiOrchestrator {
  return new AiOrchestrator({
    provider,
    prompts,
    usage: {
      count: (input) => countAiGenerations(client, input),
      record: (input) => recordAiGeneration(client, input),
    },
    policy: async (key) => {
      const row = await loadAiFeaturePolicy(client, key);
      return row ? { ...row } : undefined;
    },
    generatorVersion: 'orchestration-v1',
  });
}

const stub: InferenceProvider = {
  providerKey: 'stub',
  async complete() {
    return { text: 'A draft.', usage: { inputTokens: 11, outputTokens: 7 }, model: 'local/qwen2.5-14b-instruct', stopReason: 'END' as const };
  },
};

const request = (key: string): Parameters<AiOrchestrator['generate']>[0] => ({
  featureKey: key,
  promptKey: 'demo.summary',
  promptVersion: 1,
  parameters: { tone: 'Be brief.' },
  subjectUserId,
  correlationId: 'corr-000001',
});

describe('policy', () => {
  it('a feature nobody configured cannot generate, and leaves no metering row', async () => {
    await expect(orchestrator(stub).generate(request('never.configured'))).rejects.toBeInstanceOf(AiFeatureDisabledError);
    // Deliberately unmetered: there is no feature to write the row against, and the
    // foreign key below is the reason. A metering row for a key that was never
    // configured would record usage of something with no cap.
    const rows = await client.query('SELECT 1 FROM ai_generations WHERE feature_key = $1', ['never.configured']);
    expect(rows.rowCount).toBe(0);
  });

  it('refuses a direct insert for a feature that was never configured', async () => {
    await expect(client.query(
      `INSERT INTO ai_generations (id, feature_key, prompt_key, prompt_version, provider_key, model, outcome, correlation_id)
       VALUES ($1,'never.configured','demo.summary',1,'stub','m','SUCCEEDED','c')`,
      [randomUUID()],
    )).rejects.toThrow(/ai_generation_feature_fk/);
  });

  it('meters a configured feature that is switched off', async () => {
    await client.query('UPDATE ai_feature_policies SET enabled = false WHERE feature_key = $1', [featureKey]);
    await expect(orchestrator(stub).generate(request(featureKey))).rejects.toBeInstanceOf(AiFeatureDisabledError);
    // Somebody turned this off on purpose and calls are still arriving, which is worth
    // knowing — unlike a typo, which is a code bug.
    const rows = await client.query<{ failure_class: string }>(
      'SELECT failure_class FROM ai_generations WHERE feature_key = $1', [featureKey],
    );
    expect(rows.rows[0]?.failure_class).toBe('FEATURE_DISABLED');
  });

  it('a disabled feature cannot generate', async () => {
    await client.query('UPDATE ai_feature_policies SET enabled = false WHERE feature_key = $1', [featureKey]);
    await expect(orchestrator(stub).generate(request(featureKey))).rejects.toBeInstanceOf(AiFeatureDisabledError);
  });

  it('features are created disabled', async () => {
    const fresh = `demo.${randomUUID().slice(0, 8)}`;
    await client.query(
      `INSERT INTO ai_feature_policies (feature_key, description, model, cap) VALUES ($1,'x','m',5)`, [fresh],
    );
    expect((await loadAiFeaturePolicy(client, fresh))?.enabled).toBe(false);
  });

  it('refuses a feature with no positive cap', async () => {
    await expect(client.query(
      `INSERT INTO ai_feature_policies (feature_key, description, model, cap) VALUES ($1,'x','m',0)`,
      [`demo.${randomUUID().slice(0, 8)}`],
    )).rejects.toThrow(/ai_feature_cap_ck/);
  });
});

describe('metering', () => {
  it('records a success with its tokens and stops at the cap', async () => {
    const subject = orchestrator(stub);
    await subject.generate(request(featureKey));
    await subject.generate(request(featureKey));
    await expect(subject.generate(request(featureKey))).rejects.toBeInstanceOf(AiCapExceededError);

    const rows = await client.query<{ outcome: string; input_tokens: number; failure_class: string | null }>(
      'SELECT outcome, input_tokens, failure_class FROM ai_generations WHERE feature_key = $1 ORDER BY occurred_at',
      [featureKey],
    );
    expect(rows.rows.map((row) => row.outcome)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'REFUSED']);
    expect(rows.rows[0]?.input_tokens).toBe(11);
    expect(rows.rows[2]?.failure_class).toBe('CAP_EXCEEDED');
  });

  it('does not let failures consume the cap', async () => {
    // An outage must not exhaust a feature's budget for the day.
    const failing = orchestrator(new UnconfiguredInferenceProvider());
    await expect(failing.generate(request(featureKey))).rejects.toBeInstanceOf(InferenceUnconfiguredError);
    await expect(failing.generate(request(featureKey))).rejects.toBeInstanceOf(InferenceUnconfiguredError);
    await expect(failing.generate(request(featureKey))).rejects.toBeInstanceOf(InferenceUnconfiguredError);

    expect(await countAiGenerations(client, { featureKey, window: 'DAY' })).toBe(0);
    // And once inference works, the full cap is still available.
    await expect(orchestrator(stub).generate(request(featureKey))).resolves.toMatchObject({ reviewState: 'DRAFT' });
  });

  it('requires a reason on anything that is not a success', async () => {
    await expect(client.query(
      `INSERT INTO ai_generations (id, feature_key, prompt_key, prompt_version, provider_key, model, outcome, correlation_id)
       VALUES ($1,$2,'demo.summary',1,'stub','m','FAILED','c')`,
      [randomUUID(), featureKey],
    )).rejects.toThrow(/ai_generation_failure_ck/);
  });

  it('never stores the generated text', async () => {
    await orchestrator(stub).generate(request(featureKey));
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_generations'",
    );
    const names = columns.rows.map((row) => row.column_name);
    // Generated text belongs in the feature's own table as a DRAFT a human publishes.
    // A second copy here would be a student's data under a different retention story.
    for (const forbidden of ['text', 'content', 'output', 'completion', 'prompt_text']) {
      expect(names).not.toContain(forbidden);
    }
  });
});
