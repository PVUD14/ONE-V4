/**
 * `corepack pnpm --filter @planthepath/persistence ai:content-factory [--once]` — the content
 * factory's worker (ENG-23).
 *
 * Runs queued `ai_content_drafts` jobs one at a time through ONE AI Orchestration, using the
 * inference endpoint named by ONE_AI_BASE_URL / ONE_AI_API_KEY / ONE_AI_MODEL in this process's
 * environment (blank = AI unavailable: each job ends FAILED / PROVIDER_UNCONFIGURED, nothing
 * crashes). Every call is still subject to the feature's switch, its cap and the global kill
 * switch, read from the database on each call. `--once` drains the queue and exits (for a timer
 * or a manual run); without it the worker polls, idling two seconds when there is nothing to do.
 *
 * Logs counts and codes only — never a prompt, a reply or the key.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createWorkerAiOrchestrator } from './ai-workers.js';
import { ContentDraftLeaseLostError, runContentFactoryOnce } from './content-factory-worker.js';
import type { TransactionalRunner } from './content-factory.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const once = process.argv.includes('--once');
  const pool = new Pool({ connectionString });
  const db = drizzle(pool) as unknown as TransactionalRunner;
  const { orchestrator, configuration } = createWorkerAiOrchestrator({ db: pool });
  console.log(JSON.stringify({ event: 'content-factory.worker.started', once, inferenceConfigured: configuration.state === 'CONFIGURED' }));
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      let outcome;
      try {
        outcome = await runContentFactoryOnce({ db, generator: orchestrator });
      } catch (error) {
        if (!(error instanceof ContentDraftLeaseLostError)) throw error;
        console.log(JSON.stringify({ event: 'content-factory.job.lease_lost' }));
        continue;
      }
      if (outcome) {
        console.log(JSON.stringify({
          event: 'content-factory.job.finished', jobId: outcome.jobId, kind: outcome.kind, state: outcome.state,
          outcomeCode: outcome.outcomeCode, findings: outcome.findings,
        }));
        continue;
      }
      if (once) break;
      await delay(2_000);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'content-factory.worker.failed', failureClass: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
