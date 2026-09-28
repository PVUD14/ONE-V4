/**
 * Offline command, step 3 of the calibration run (ENG-13):
 *   corepack pnpm --filter @planthepath/persistence engine:calibration-import --in <file>
 *
 * Why this exists: the Python job has no database access; this validates its results file
 * strictly and writes the run and its item calibrations in one transaction. Replaying the same
 * run is a no-op. Prints counts only. Started by deploy/scripts/run-calibration.sh; on no route.
 */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { PersistenceDb } from './repositories.js';
import { importCalibrationResults } from './item-calibrations.js';

const inIndex = process.argv.indexOf('--in');
const inPath = inIndex >= 0 ? process.argv[inIndex + 1] : undefined;
if (!inPath) throw new Error('usage: engine:calibration-import --in <file>');
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: databaseUrl });
try {
  const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
  const outcome = await importCalibrationResults(db, JSON.parse(await readFile(inPath, 'utf8')) as unknown);
  console.log(JSON.stringify({ event: 'engine.calibration.imported', ...outcome }));
} finally {
  await pool.end();
}
