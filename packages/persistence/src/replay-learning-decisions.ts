/**
 * The planner replay command (ENG-08, C4): recompute stored learning decisions from their stored
 * inputs and compare with what was recorded.
 *
 * Why this exists: "replaying the same inputs from learning_decisions gives the same decision" is
 * the planner's audit promise. This command checks it for every stored decision, or one
 * (`engine:replay-decisions <decision-id>`), and exits non-zero on any mismatch, altered input,
 * invalid input or unsupported policy. It prints counts and decision ids only, never learner data.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { PersistenceDb } from './repositories.js';
import { replayLearningDecisions } from './learning-decisions.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const decisionId = process.argv[2]?.trim();
const pool = new Pool({ connectionString: databaseUrl });
try {
  const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
  const result = await replayLearningDecisions(db, decisionId ? { decisionId } : {});
  console.log(JSON.stringify({ event: 'learning_decisions.replayed', ...result }));
  if (result.matched !== result.checked) process.exitCode = 1;
} finally {
  await pool.end();
}
