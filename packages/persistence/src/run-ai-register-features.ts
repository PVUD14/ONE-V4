/**
 * `ai:register-features` — register ONE's first AI features (ENG-21: tutor.hint,
 * content.lesson-draft, content.answer-check; ENG-23: content.item-draft; ENG-24: content.embeddings,
 * tutor.retrieval) as policy rows, switched off, so evaluations can be
 * recorded against them. Inserts only missing rows; never changes an existing one and never
 * switches anything on (that stays in AI Operations, with a passing evaluation and an approval).
 *
 * Usage: DATABASE_URL=… corepack pnpm --filter @planthepath/persistence ai:register-features
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { registerOneAiFeatures } from './ai-bake-off.js';
import { registerOneEmbeddingFeatures } from './content-embeddings.js';
import type { SqlRunner } from './ai-operations.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const result = await registerOneAiFeatures(drizzle(pool) as unknown as SqlRunner);
  const embeddings = await registerOneEmbeddingFeatures(pool);
  console.log(JSON.stringify({ event: 'ai.features.registered', enabled: false, ...result, registered: [...result.registered, ...embeddings.registered] }));
} finally {
  await pool.end();
}
