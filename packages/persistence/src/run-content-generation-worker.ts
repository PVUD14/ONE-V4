import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { createContentGenerationEventConsumer } from './automation-workers.js';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireValue('DATABASE_URL') });
  const consumer = createContentGenerationEventConsumer({
    db: drizzle(pool, { schema }),
    queueUrl: requireValue('PTP_CONTENT_GENERATION_QUEUE_URL'),
  });
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) await consumer.pollOnce();
  } finally {
    await pool.end();
  }
}

function requireValue(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    event: 'content-generation.worker.failed',
    failureClass: error instanceof Error ? error.name : 'UnknownError',
  }));
  process.exitCode = 1;
});
