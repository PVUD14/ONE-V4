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
  // OPS-12: while the global kill switch (flag ai.global-kill-switch, 0089) is engaged every
  // feature reads as disabled, in every process, on the next call. Read directly, never through
  // overrides: the kill switch is global by definition. An absent flag row means not engaged.
  const result = await client.query<{
    feature_key: string; description: string; enabled: boolean; model: string;
    cap: number; cap_window: 'DAY' | 'MONTH'; max_input_chars: number;
  }>(
    `SELECT feature_key, description,
            enabled AND NOT COALESCE((SELECT f.enabled FROM feature_flags f WHERE f.key = 'ai.global-kill-switch'), false) AS enabled,
            model, cap, cap_window, max_input_chars
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
    /** ENG-20 (0105): provider wall time and HTTP attempts; absent when no call was made. */
    readonly latencyMs?: number | undefined;
    readonly attempts?: number | undefined;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO ai_generations
      (id, feature_key, subject_user_id, prompt_key, prompt_version, provider_key, model,
       input_tokens, output_tokens, outcome, failure_class, correlation_id, latency_ms, provider_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [randomUUID(), input.featureKey, input.subjectUserId ?? null, input.promptKey, input.promptVersion,
      input.providerKey, input.model, input.usage.inputTokens, input.usage.outputTokens,
      input.outcome, input.failureClass ?? null, input.correlationId,
      input.outcome === 'REFUSED' ? null : boundedOrNull(input.latencyMs, 86_400_000),
      input.outcome === 'REFUSED' ? null : boundedOrNull(input.attempts, 10, 1)],
  );
}

function boundedOrNull(value: number | undefined, max: number, min = 0): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Whether the global AI kill switch (flag ai.global-kill-switch, 0089) is engaged. Read directly,
 * never through overrides: the kill switch is global by definition. Absent row means not engaged.
 */
export async function loadAiKillSwitchEngaged(client: Queryable): Promise<boolean> {
  const result = await client.query<{ engaged: boolean }>(
    `SELECT COALESCE((SELECT f.enabled FROM feature_flags f WHERE f.key = 'ai.global-kill-switch'), false) AS engaged`,
  );
  return result.rows[0]?.engaged ?? false;
}

export interface AiProviderProbeRow {
  readonly providerKey: string;
  readonly endpointHost: string | null;
  readonly configured: boolean;
  readonly configuredModel: string | null;
  readonly reachable: boolean;
  readonly modelServed: boolean | null;
  readonly failureClass: string | null;
  readonly latencyMs: number | null;
  readonly probedAt: string;
}

/** ENG-20 (0105): one probe of the inference endpoint. The trigger stamps probed_at. */
export async function recordAiProviderProbe(
  client: Queryable,
  input: Omit<AiProviderProbeRow, 'probedAt'>,
): Promise<void> {
  await client.query(
    `INSERT INTO ai_provider_probes
      (id, provider_key, endpoint_host, configured, configured_model, reachable, model_served, failure_class, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), input.providerKey, input.configured ? input.endpointHost : null, input.configured,
      input.configuredModel, input.configured && input.reachable, input.configured ? input.modelServed : null,
      input.failureClass, boundedOrNull(input.latencyMs ?? undefined, 600_000)],
  );
}

/** The newest probe, or null when none has ever run. */
export async function loadLatestAiProviderProbe(client: Queryable): Promise<AiProviderProbeRow | null> {
  const result = await client.query<{
    provider_key: string; endpoint_host: string | null; configured: boolean; configured_model: string | null;
    reachable: boolean; model_served: boolean | null; failure_class: string | null; latency_ms: number | null; probed_at: Date;
  }>(
    `SELECT provider_key, endpoint_host, configured, configured_model, reachable, model_served, failure_class, latency_ms, probed_at
     FROM ai_provider_probes ORDER BY probed_at DESC, id DESC LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    providerKey: row.provider_key,
    endpointHost: row.endpoint_host,
    configured: row.configured,
    configuredModel: row.configured_model,
    reachable: row.reachable,
    modelServed: row.model_served,
    failureClass: row.failure_class,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    probedAt: new Date(row.probed_at).toISOString(),
  };
}

/** Retention: probes older than 90 days go (the 0105 trigger refuses anything younger). */
export async function pruneAiProviderProbes(client: Queryable): Promise<number> {
  const result = await client.query(`DELETE FROM ai_provider_probes WHERE probed_at < now() - interval '90 days'`);
  return result.rowCount ?? 0;
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
    /**
     * OPS-12: the prompt version the feature runs, so the console can require a passing
     * evaluation for exactly this model and prompt. Changing either on an enabled feature
     * without a passing evaluation switches it off (0089 trigger).
     */
    readonly prompt?: { readonly key: string; readonly version: number };
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, max_input_chars, prompt_key, prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (feature_key) DO UPDATE
       SET description = EXCLUDED.description, model = EXCLUDED.model, cap = EXCLUDED.cap,
           cap_window = EXCLUDED.cap_window, max_input_chars = EXCLUDED.max_input_chars,
           prompt_key = EXCLUDED.prompt_key, prompt_version = EXCLUDED.prompt_version,
           updated_at = now()`,
    [input.featureKey, input.description, input.model, input.cap, input.window, input.maxInputChars ?? 16000,
      input.prompt?.key ?? null, input.prompt?.version ?? null],
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
