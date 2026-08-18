import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';

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
  const migrationDir = new URL('../drizzle/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();

  for (const migrationName of migrations) {
    const migration = await readFile(new URL(migrationName, migrationDir), 'utf8');
    await pool.query(migration);
    console.log(`applied ${migrationName}`);
  }
} finally {
  await pool.end();
}
