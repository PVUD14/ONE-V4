/**
 * ONE AI Orchestration, wired for worker processes — the only place the inference adapter meets
 * the database (ENG-20).
 *
 * CLAUDE.md: generation is a job on the outbox/event pipeline, never a call from a controller,
 * and no request handler calls an inference endpoint. So this module is for workers and jobs
 * only; a contract test (apps/api/src/inference-boundary.spec.ts) fails if anything under apps/
 * imports it. It joins three things that must never be wired separately:
 *  - the adapter from the server environment (ONE_AI_BASE_URL / ONE_AI_API_KEY / ONE_AI_MODEL;
 *    blank = unavailable, never a crash);
 *  - the database policy, the global kill switch and the cap, consulted before every call;
 *  - metering into ai_generations, with tokens, latency and attempts.
 *
 * Design: docs/architecture/inference-adapter-design.md.
 */
import type { Pool, PoolClient } from 'pg';
import {
  AiOrchestrator,
  describeInferenceConfiguration,
  inferenceProviderFromEnvironment,
  onePromptRegistry,
  type InferenceAdapterTuning,
  type InferenceConfiguration,
  type PromptRegistry,
} from '@planthepath/ai-orchestration/src/index.js';
import {
  countAiGenerations,
  loadAiFeaturePolicy,
  loadAiKillSwitchEngaged,
  pruneAiProviderProbes,
  recordAiGeneration,
  recordAiProviderProbe,
  type AiProviderProbeRow,
} from './ai-orchestration.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;
type Environment = Readonly<Record<string, string | undefined>>;

/** Stamped on every generation row so a change of serving stack is visible in the data. */
export const workerGeneratorVersion = 'one-ai-orchestration-v1+openai-compatible-v1';

export interface WorkerAiOrchestratorOptions {
  /** A pool, or a client inside the job's transaction. */
  readonly db: Queryable;
  readonly env?: Environment;
  readonly prompts?: PromptRegistry;
  readonly tuning?: InferenceAdapterTuning;
  readonly generatorVersion?: string;
}

/**
 * The orchestrator a job uses. Policy, kill switch and cap are read on every call (no cache), so
 * switching a feature off or engaging the kill switch stops the next call in every process.
 */
export function createWorkerAiOrchestrator(options: WorkerAiOrchestratorOptions): {
  readonly orchestrator: AiOrchestrator;
  readonly configuration: InferenceConfiguration;
} {
  const { provider, configuration } = inferenceProviderFromEnvironment(options.env ?? process.env, options.tuning ?? {});
  const db = options.db;
  return {
    configuration,
    orchestrator: new AiOrchestrator({
      provider,
      prompts: options.prompts ?? onePromptRegistry(),
      usage: {
        count: (input) => countAiGenerations(db, input),
        record: (input) => recordAiGeneration(db, input),
      },
      policy: async (featureKey) => {
        const row = await loadAiFeaturePolicy(db, featureKey);
        return row ? { featureKey: row.featureKey, enabled: row.enabled, cap: row.cap, window: row.window, model: row.model, maxInputChars: row.maxInputChars } : undefined;
      },
      killSwitchEngaged: () => loadAiKillSwitchEngaged(db),
      generatorVersion: options.generatorVersion ?? workerGeneratorVersion,
    }),
  };
}

/**
 * Probe the configured endpoint once and record what was found, for AI Operations. Never throws
 * for an endpoint problem — an unreachable pod is a row, not a crash. Prunes probes older than
 * the 90-day retention window.
 */
export async function runAiProviderProbe(input: {
  readonly db: Queryable;
  readonly env?: Environment;
  readonly tuning?: InferenceAdapterTuning;
}): Promise<Omit<AiProviderProbeRow, 'probedAt'> & { readonly pruned: number }> {
  const env = input.env ?? process.env;
  const view = describeInferenceConfiguration(env);
  const { provider } = inferenceProviderFromEnvironment(env, input.tuning ?? {});
  const probe = provider.probe
    ? await provider.probe()
    : { reachable: false, modelServed: null, failureClass: 'PROVIDER_UNCONFIGURED' as const, latencyMs: null };
  const row = {
    providerKey: view.providerKey,
    endpointHost: view.configured ? view.endpointHost : null,
    configured: view.configured,
    configuredModel: view.model,
    reachable: view.configured && probe.reachable,
    modelServed: view.configured ? probe.modelServed : null,
    failureClass: view.configured ? probe.failureClass : 'PROVIDER_UNCONFIGURED',
    latencyMs: view.configured ? probe.latencyMs : null,
  };
  await recordAiProviderProbe(input.db, row);
  const pruned = await pruneAiProviderProbes(input.db);
  return { ...row, pruned };
}
