/**
 * `corepack pnpm --filter @planthepath/persistence ai:content-embeddings [--rebuild] [--max-revisions N]`
 * — one run of the content embedding job (ENG-24), for the nightly timer or by hand.
 *
 * Embeds approved, current lesson text through ONE AI Orchestration using the embedding endpoint named by
 * ONE_AI_EMBEDDING_BASE_URL / ONE_AI_EMBEDDING_API_KEY / ONE_AI_EMBEDDING_MODEL. Blank endpoint, the
 * `content.embeddings` feature off, or the kill switch engaged: it does nothing and logs why. `--rebuild`
 * empties the index first and re-embeds approved content only.
 *
 * Logs counts and codes only — never content text, a vector or the key. Exits 0 when it did nothing or
 * completed; 2 when it stopped early (cap, switch, endpoint), so a timer's failure shows in systemd.
 */
import { Pool } from 'pg';
import { createWorkerAiOrchestrator } from './ai-workers.js';
import { runContentEmbeddings } from './content-embeddings.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const rebuild = process.argv.includes('--rebuild');
  const maxIndex = process.argv.indexOf('--max-revisions');
  const maxRevisions = maxIndex >= 0 ? Number(process.argv[maxIndex + 1]) : undefined;
  if (maxRevisions !== undefined && !(Number.isInteger(maxRevisions) && maxRevisions > 0)) throw new Error('--max-revisions takes a positive whole number');
  const pool = new Pool({ connectionString });
  try {
    const { orchestrator, embeddingConfiguration } = createWorkerAiOrchestrator({ db: pool });
    const run = await runContentEmbeddings({
      db: pool,
      embed: (request) => orchestrator.embed(request),
      endpointConfigured: embeddingConfiguration.state === 'CONFIGURED',
      mode: rebuild ? 'REBUILD' : 'INCREMENTAL',
      ...(maxRevisions === undefined ? {} : { maxRevisions }),
    });
    console.log(JSON.stringify({ event: run.state === 'UNAVAILABLE' ? 'content-embeddings.unavailable' : 'content-embeddings.finished', ...run }));
    if (run.state === 'STOPPED') process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'content-embeddings.failed', failureClass: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
});
