/**
 * Loads the sandbox's fictional sample data into an already-migrated sandbox database
 * (ADR-046). Safe to run again: every row has a fixed id, so a re-run changes nothing
 * except binding demo accounts to any Cognito subjects added since.
 *
 *   ONE_SANDBOX=true DATABASE_URL=postgresql://.../one_sandbox pnpm db:seed:sandbox
 *
 * Refuses to run unless the sandbox guard passes (sandbox-guard.ts) and every account
 * already in the database is a sample account (sandbox-seed.ts). It can never seed
 * production.
 */
import { Pool } from 'pg';
import { assertSandboxTarget } from './sandbox-guard.js';
import { parseDemoAccountSubjects, seedSandbox } from './sandbox-seed.js';

const target = assertSandboxTarget(process.env);
const subjects = parseDemoAccountSubjects(process.env.DEMO_ACCOUNT_SUBJECTS);
const pool = new Pool({ connectionString: target.databaseUrl });
try {
  console.log(`sandbox seed: ${await seedSandbox(pool, { subjects })}`);
} finally {
  await pool.end();
}
