/**
 * Offline command for the BKT shadow report (ENG-06):
 *   corepack pnpm --filter @planthepath/persistence engine:bkt-shadow-report
 *
 * Why this exists: the comparison of live bands with C3 adoption and BKT is an input to Divakar's
 * HG-5 decision, and the design keeps it off every route and screen. The command only reads, and
 * prints one JSON document of suppressed counts — no learner, topic or institution identifier.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { PersistenceDb } from './repositories.js';
import { buildBktShadowReport } from './bkt-shadow-report.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
  console.log(JSON.stringify(await buildBktShadowReport(db), null, 2));
} finally {
  await pool.end();
}
