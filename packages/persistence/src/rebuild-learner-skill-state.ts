/**
 * Full rebuild of the learner skill state projection (ENG-05).
 *
 * Why this exists: learner_skill_state is a projection that must always be reproducible from
 * facts (ADR-034). This command recomputes every student from the attempt log — after a rule
 * change (a new algorithm ID), after a suspected defect, or to prove the table matches its facts.
 * It is idempotent and safe to run beside the worker: each student is recomputed under the same
 * per-student lock the projector uses. It prints counts only, never learner data.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { PersistenceDb } from './repositories.js';
import { rebuildLearnerSkillState } from './learner-skill-state.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
  const result = await rebuildLearnerSkillState(db);
  console.log(JSON.stringify({ event: 'learner_skill_state.rebuilt', ...result }));
} finally {
  await pool.end();
}
