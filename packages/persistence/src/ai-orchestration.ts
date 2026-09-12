/**
 * The database behind AI Orchestration: policy lookup and usage metering.
 *
 * The orchestrator is deliberately storage-agnostic — it takes a `UsageCounter` and a
 * policy resolver. This is the real implementation of both, over migration 0033.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface AiFeaturePolicyRow {
  readonly featureKey: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly model: string;
  readonly cap: number;
  readonly window: 'DAY' | 'MONTH';
  readonly maxInputChars: number;
}

/**
 * Resolve one feature's policy.
 *
 * Returns undefined for an unknown key, which the orchestrator treats as disabled. That
 * asymmetry is the point: absence means off, never on.
 */
export async function loadAiFeaturePolicy(
  client: Queryable,
  featureKey: string,
): Promise<AiFeaturePolicyRow | undefined> {
  const result = await client.query<{
    feature_key: string; description: string; enabled: boolean; model: string;
    cap: number; cap_window: 'DAY' | 'MONTH'; max_input_chars: number;
  }>(
    `SELECT feature_key, description, enabled, model, cap, cap_window, max_input_chars
     FROM ai_feature_policies WHERE feature_key = $1`, [featureKey],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    featureKey: row.feature_key,
    description: row.description,
    enabled: row.enabled,
    model: row.model,
    cap: row.cap,
    window: row.cap_window,
    maxInputChars: row.max_input_chars,
  };
}

export async function listAiFeaturePolicies(pool: Pool): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT p.feature_key AS "featureKey", p.description, p.enabled, p.model, p.cap,
            p.cap_window AS "capWindow", p.max_input_chars AS "maxInputChars",
            (SELECT count(*)::int FROM ai_generations g
              WHERE g.feature_key = p.feature_key AND g.outcome = 'SUCCEEDED'
                AND g.occurred_at >= date_trunc(CASE p.cap_window WHEN 'DAY' THEN 'day' ELSE 'month' END, now())
            ) AS "usedInWindow",
            (SELECT count(*)::int FROM ai_generations g
              WHERE g.feature_key = p.feature_key AND g.outcome <> 'SUCCEEDED'
                AND g.occurred_at >= now() - interval '7 days'
            ) AS "refusedLastWeek"
     FROM ai_feature_policies p ORDER BY p.feature_key`,
  );
  return result.rows;
}

/**
 * Successes in the current window.
 *
 * Only successes count against a ceiling — a refused call cost nothing and a failed one
 * produced nothing, so charging either against the cap would let an outage exhaust a
 * feature's budget.
 */
export async function countAiGenerations(
  client: Queryable,
  input: { readonly featureKey: string; readonly window: 'DAY' | 'MONTH' },
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ai_generations
     WHERE feature_key = $1 AND outcome = 'SUCCEEDED'
       AND occurred_at >= date_trunc($2, now())`,
    [input.featureKey, input.window === 'DAY' ? 'day' : 'month'],
  );
  return result.rows[0]?.count ?? 0;
}

export async function recordAiGeneration(
  client: Queryable,
  input: {
    readonly featureKey: string;
    readonly subjectUserId?: string | undefined;
    readonly promptKey: string;
    readonly promptVersion: number;
    readonly providerKey: string;
    readonly model: string;
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
    readonly correlationId: string;
    readonly outcome: 'SUCCEEDED' | 'REFUSED' | 'FAILED';
    readonly failureClass?: string | undefined;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO ai_generations
      (id, feature_key, subject_user_id, prompt_key, prompt_version, provider_key, model,
       input_tokens, output_tokens, outcome, failure_class, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), input.featureKey, input.subjectUserId ?? null, input.promptKey, input.promptVersion,
      input.providerKey, input.model, input.usage.inputTokens, input.usage.outputTokens,
      input.outcome, input.failureClass ?? null, input.correlationId],
  );
}

/**
 * Register a feature, or update its model and limits.
 *
 * `enabled` is intentionally absent: creating a feature never switches it on. Turning
 * one on is its own act, through `setAiFeatureEnabled`, so it is visible as a decision
 * rather than a side effect of a deployment that added a row.
 */
export async function upsertAiFeaturePolicy(
  pool: Pool,
  input: {
    readonly featureKey: string; readonly description: string; readonly model: string;
    readonly cap: number; readonly window: 'DAY' | 'MONTH'; readonly maxInputChars?: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, max_input_chars)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (feature_key) DO UPDATE
       SET description = EXCLUDED.description, model = EXCLUDED.model, cap = EXCLUDED.cap,
           cap_window = EXCLUDED.cap_window, max_input_chars = EXCLUDED.max_input_chars,
           updated_at = now()`,
    [input.featureKey, input.description, input.model, input.cap, input.window, input.maxInputChars ?? 16000],
  );
}

export async function setAiFeatureEnabled(
  pool: Pool,
  input: { readonly featureKey: string; readonly enabled: boolean },
): Promise<boolean> {
  const result = await pool.query(
    'UPDATE ai_feature_policies SET enabled = $2, updated_at = now() WHERE feature_key = $1',
    [input.featureKey, input.enabled],
  );
  return (result.rowCount ?? 0) > 0;
}
