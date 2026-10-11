/**
 * Migration 0089 against the real orchestrator (OPS-12).
 *
 * The console is one writer; these are the guarantees that hold for any writer: the global kill
 * switch stops the orchestrator on the next call with no restart, a feature switches on only with a
 * passing evaluation for its current model and prompt, an unevaluated model change switches an
 * enabled feature off, and evaluation records are append-only with PASS meaning every threshold met.
 *
 * Each test runs in a transaction that is rolled back, so the shared kill switch row is never left
 * engaged for another suite.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { AiFeatureDisabledError, AiOrchestrator, PromptRegistry, type InferenceProvider } from '@planthepath/ai-orchestration/src/index.js';
import { countAiGenerations, loadAiFeaturePolicy, recordAiGeneration } from '../src/ai-orchestration.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

let client: PoolClient;
let featureKey: string;
let userId: string;
const providerCalls: string[] = [];

const prompt = { key: 'ops12.summary', version: 1, purpose: 'Integration fixture.', system: 'Summarise.', parameters: [], user: 'Go.', maxOutputTokens: 50, temperature: 0 };
const stub: InferenceProvider = {
  providerKey: 'stub',
  async complete(input) {
    providerCalls.push(input.model);
    return { text: 'A draft.', usage: { inputTokens: 3, outputTokens: 2 }, model: input.model, stopReason: 'END' as const };
  },
};

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  featureKey = `ops12.${randomUUID().slice(0, 8)}`;
  userId = randomUUID();
  providerCalls.length = 0;
  await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [userId, userId + '@example.test']);
  await client.query(
    `INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, prompt_key, prompt_version)
     VALUES ($1,'OPS-12 fixture','local/model-a',5,'DAY','ops12.summary',1)`, [featureKey],
  );
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => { await pool.end(); });

async function evaluate(decision: 'PASS' | 'FAIL', model = 'local/model-a', metrics = [{ name: 'accuracy', value: 0.9, threshold: 0.8, comparator: 'AT_LEAST' }]): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO ai_evaluations (id, feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version, metrics, decision, reason_code, decided_by_user_id, correlation_id)
     VALUES ($1,$2,'stub',$3,'ops12.summary',1,'ops12.set',1,$4::jsonb,$5,'INITIAL_BENCHMARK',$6,'ops12-persistence')`,
    [id, featureKey, model, JSON.stringify(metrics), decision, userId],
  );
  return id;
}

async function setKillSwitch(engaged: boolean): Promise<void> {
  await client.query("UPDATE feature_flags SET enabled=$1 WHERE key='ai.global-kill-switch'", [engaged]);
}

function orchestrator(): AiOrchestrator {
  return new AiOrchestrator({
    provider: stub,
    prompts: new PromptRegistry([prompt]),
    usage: { count: (input) => countAiGenerations(client, input), record: (input) => recordAiGeneration(client, input) },
    policy: async (key) => {
      const row = await loadAiFeaturePolicy(client, key);
      return row ? { ...row } : undefined;
    },
    generatorVersion: 'orchestration-v1',
  });
}
const request = () => ({ featureKey, promptKey: 'ops12.summary', promptVersion: 1, parameters: {}, subjectUserId: userId, correlationId: 'ops12-corr-0001' });

describe('the global kill switch', () => {
  it('exists, is not engaged by default, and is high-risk to release', async () => {
    const flags = await client.query("SELECT key, enabled, high_risk_direction FROM feature_flags WHERE key LIKE 'ai.%' ORDER BY key");
    expect(flags.rows).toEqual([
      { key: 'ai.assistant', enabled: false, high_risk_direction: 'ENABLE' },
      { key: 'ai.global-kill-switch', enabled: false, high_risk_direction: 'DISABLE' },
    ]);
  });

  it('stops the orchestrator on the next call, with no restart, and the refusal is metered', async () => {
    await evaluate('PASS');
    await client.query('UPDATE ai_feature_policies SET enabled=true WHERE feature_key=$1', [featureKey]);
    const engine = orchestrator();
    await engine.generate(request());
    expect(providerCalls).toHaveLength(1);

    await setKillSwitch(true);
    await expect(engine.generate(request())).rejects.toBeInstanceOf(AiFeatureDisabledError);
    expect(providerCalls).toHaveLength(1);
    const refused = await client.query("SELECT outcome, failure_class FROM ai_generations WHERE feature_key=$1 AND outcome='REFUSED'", [featureKey]);
    expect(refused.rows).toEqual([{ outcome: 'REFUSED', failure_class: 'FEATURE_DISABLED' }]);
    // The stored switch is untouched by the flag alone; the effective answer is off.
    expect((await loadAiFeaturePolicy(client, featureKey))?.enabled).toBe(false);

    await setKillSwitch(false);
    await engine.generate(request());
    expect(providerCalls).toHaveLength(2);
  });

  it('refuses switching any feature on, or inserting one enabled, while engaged', async () => {
    await evaluate('PASS');
    await setKillSwitch(true);
    await client.query('SAVEPOINT s');
    await expect(client.query('UPDATE ai_feature_policies SET enabled=true WHERE feature_key=$1', [featureKey])).rejects.toThrow(/kill switch/);
    await client.query('ROLLBACK TO SAVEPOINT s');
    await expect(client.query(
      "INSERT INTO ai_feature_policies (feature_key, description, model, cap, enabled) VALUES ($1,'x','m',1,true)", [featureKey + '-b'],
    )).rejects.toThrow(/kill switch/);
  });
});

describe('switching on needs a passing evaluation for the current model and prompt', () => {
  it('refuses with no evaluation, with only a FAIL, and when a later FAIL overturns a PASS', async () => {
    const attempt = async (): Promise<void> => {
      await client.query('SAVEPOINT s');
      await expect(client.query('UPDATE ai_feature_policies SET enabled=true WHERE feature_key=$1', [featureKey])).rejects.toThrow(/passing evaluation/);
      await client.query('ROLLBACK TO SAVEPOINT s');
    };
    await attempt();
    await evaluate('FAIL');
    await attempt();
    await evaluate('PASS', 'local/model-b');
    await attempt();
    await evaluate('PASS');
    const passes = await client.query("SELECT ai_evaluation_passes($1,'local/model-a','ops12.summary',1) AS passes", [featureKey]);
    // Same transaction, same now(): a tie between the earlier FAIL and this PASS resolves to FAIL.
    expect(passes.rows[0].passes).toBe(false);
  });

  it('allows it with a passing evaluation, and switches the feature off if its model changes unevaluated', async () => {
    await evaluate('PASS');
    await client.query('UPDATE ai_feature_policies SET enabled=true WHERE feature_key=$1', [featureKey]);
    expect((await client.query('SELECT enabled FROM ai_feature_policies WHERE feature_key=$1', [featureKey])).rows[0].enabled).toBe(true);
    await client.query("UPDATE ai_feature_policies SET model='local/model-z' WHERE feature_key=$1", [featureKey]);
    expect((await client.query('SELECT enabled FROM ai_feature_policies WHERE feature_key=$1', [featureKey])).rows[0].enabled).toBe(false);
  });

  it('refuses a feature with no declared prompt', async () => {
    await client.query('UPDATE ai_feature_policies SET prompt_key=NULL, prompt_version=NULL WHERE feature_key=$1', [featureKey]);
    await expect(client.query('UPDATE ai_feature_policies SET enabled=true WHERE feature_key=$1', [featureKey])).rejects.toThrow(/passing evaluation/);
  });
});

describe('evaluation records', () => {
  it('are append-only, stamped by the database, and a PASS must meet every threshold', async () => {
    const id = await evaluate('PASS');
    const stamped = await client.query('SELECT decided_at = now() AS stamped FROM ai_evaluations WHERE id=$1', [id]);
    expect(stamped.rows[0].stamped).toBe(true);
    await client.query('SAVEPOINT s');
    await expect(client.query("UPDATE ai_evaluations SET note='edited' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await client.query('ROLLBACK TO SAVEPOINT s');
    await expect(client.query('DELETE FROM ai_evaluations WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
  });

  it('refuses a PASS below a threshold and malformed metrics', async () => {
    for (const metrics of [
      [{ name: 'accuracy', value: 0.1, threshold: 0.8, comparator: 'AT_LEAST' }],
      [{ name: 'unsafe_rate', value: 0.5, threshold: 0.01, comparator: 'AT_MOST' }],
    ]) {
      await client.query('SAVEPOINT s');
      await expect(evaluate('PASS', 'local/model-a', metrics)).rejects.toThrow(/every threshold/);
      await client.query('ROLLBACK TO SAVEPOINT s');
    }
    for (const metrics of [[], [{ name: 'accuracy', value: '0.9', threshold: 0.8, comparator: 'AT_LEAST' }], [{ name: 'accuracy', value: 0.9 }]]) {
      await client.query('SAVEPOINT s');
      await expect(evaluate('FAIL', 'local/model-a', metrics as never)).rejects.toThrow();
      await client.query('ROLLBACK TO SAVEPOINT s');
    }
    await expect(evaluate('FAIL', 'local/model-a', [{ name: 'accuracy', value: 0.1, threshold: 0.8, comparator: 'AT_LEAST' }])).resolves.toBeTypeOf('string');
  });
});
