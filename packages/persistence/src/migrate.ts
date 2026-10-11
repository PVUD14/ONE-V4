import { Pool } from 'pg';
import { runMigrations } from './migration-runner.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const parsed = new URL(databaseUrl);
if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
  throw new Error('DATABASE_URL must use the postgres or postgresql protocol');
}
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_MIGRATIONS !== 'true') {
  throw new Error('Refusing to run migrations in production without ALLOW_PRODUCTION_MIGRATIONS=true');
}

const pool = new Pool({ connectionString: databaseUrl });

try {
  // Each migration runs once and is recorded (ADR-035); see migration-runner.ts.
  const result = await runMigrations(pool, new URL('../drizzle/', import.meta.url), (line) => console.log(line));
  console.log(`migrations: ${result.applied.length} applied, ${result.skipped.length} already applied${result.bootstrapped ? ' (ledger created)' : ''}`);
} finally {
  await pool.end();
}
