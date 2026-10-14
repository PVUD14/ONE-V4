/**
 * `ai:probe` — check the inference endpoint once and record the result for AI Operations (ENG-20).
 *
 * A command rather than a request: CLAUDE.md forbids a request handler calling the inference
 * endpoint, so the console shows the latest probe this writes. Run it after pointing ONE at the
 * pod and on a timer (docs/ops/runbook-inference-endpoint.md). Reads DATABASE_URL and the three
 * ONE_AI_* variables; prints only the outcome — never the key or the URL.
 */
import { Pool } from 'pg';
import { runAiProviderProbe } from './ai-workers.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString });
  try {
    const result = await runAiProviderProbe({ db: pool });
    console.log(JSON.stringify({
      event: 'ai.provider.probe',
      configured: result.configured,
      endpointHost: result.endpointHost,
      model: result.configuredModel,
      reachable: result.reachable,
      modelServed: result.modelServed,
      failureClass: result.failureClass,
      latencyMs: result.latencyMs,
      pruned: result.pruned,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // The class only: a driver message can carry a connection string.
  console.error(JSON.stringify({ event: 'ai.provider.probe.failed', failureClass: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
