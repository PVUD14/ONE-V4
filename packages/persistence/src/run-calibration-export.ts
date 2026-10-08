/**
 * Offline command, step 1 of the calibration run (ENG-13):
 *   corepack pnpm --filter @planthepath/persistence engine:calibration-export --out <file>
 *
 * Why this exists: the Python calibration job must only ever see de-identified, consented
 * responses. This writes that export (mode 0600) for one new run and prints counts only —
 * never a pseudonym, user or item. On no route. Since ENG-26 the monthly run uses
 * `engine:recalibration export --kind items`, which writes this same export plus a baseline.
 */
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { PersistenceDb } from './repositories.js';
import { exportCalibrationAttempts } from './item-calibrations.js';

const outIndex = process.argv.indexOf('--out');
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
if (!outPath) throw new Error('usage: engine:calibration-export --out <file>');
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
  const exported = await exportCalibrationAttempts(db);
  await writeFile(outPath, JSON.stringify(exported), { encoding: 'utf8', mode: 0o600 });
  const learners = new Set(exported.responses.map(([learner]) => learner)).size;
  const items = new Set(exported.responses.map(([, item]) => item)).size;
  console.log(JSON.stringify({ event: 'engine.calibration.exported', runId: exported.runId, learners, items, responses: exported.responses.length }));
} finally {
  await pool.end();
}
