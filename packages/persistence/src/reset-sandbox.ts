/**
 * The sandbox's nightly reset (ADR-046): drop the sandbox database, create it again, run
 * every migration and load the sample data, so each morning demo.oneby8.com starts from
 * the same clean story whatever visitors did the day before.
 *
 *   ONE_SANDBOX=true DATABASE_URL=postgresql://.../one_sandbox pnpm db:reset:sandbox
 *
 * It drops a database, so it runs only behind the sandbox guard (sandbox-guard.ts): the
 * name must end in "_sandbox", the host must be the sandbox's own database container or
 * this machine, and ONE_SANDBOX=true must be set. On the server it is run by
 * `docker compose run --rm sandbox-reset` from a systemd timer
 * (deploy/vps/demo-sandbox/, docs/ops/runbook-demo-site.md).
 */
import { Pool } from 'pg';
import { runMigrations } from './migration-runner.js';
import { assertSandboxTarget } from './sandbox-guard.js';
import { parseDemoAccountSubjects, seedSandbox } from './sandbox-seed.js';

const target = assertSandboxTarget(process.env);
const subjects = parseDemoAccountSubjects(process.env.DEMO_ACCOUNT_SUBJECTS);

// The maintenance database on the same server: a database cannot drop itself.
const maintenanceUrl = new URL(target.databaseUrl);
maintenanceUrl.pathname = '/postgres';
const maintenance = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 });
try {
  // The name passed the guard's [a-z0-9_]+ check, so quoting it is safe. FORCE ends the
  // sandbox API's open connections; its pool reconnects to the new database on its own.
  await maintenance.query(`DROP DATABASE IF EXISTS "${target.databaseName}" WITH (FORCE)`);
  await maintenance.query(`CREATE DATABASE "${target.databaseName}"`);
  console.log(`sandbox reset: dropped and recreated ${target.databaseName}`);
} finally {
  await maintenance.end();
}

const pool = new Pool({ connectionString: target.databaseUrl });
try {
  const result = await runMigrations(pool, new URL('../drizzle/', import.meta.url));
  console.log(`sandbox reset: ${result.applied.length} migrations applied`);
  const summary = await seedSandbox(pool, { subjects });
  console.log(`sandbox reset: ${summary}`);
} finally {
  await pool.end();
}
