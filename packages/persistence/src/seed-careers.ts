import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { seedStarterCareerRoles, type CareerRoleInput } from './career-starter-roles.js';

/**
 * Seeds the career catalogue.
 *
 * Reference content, deployed on purpose rather than smuggled in by a migration.
 * Idempotent: rerunning updates titles and requirements in place rather than
 * duplicating them, so the catalogue can be corrected and reapplied.
 *
 * Requirements reference taxonomy topics by stable key. A topic that does not exist
 * in the published taxonomy is reported and skipped rather than failing the seed, so
 * the catalogue can be written ahead of the content and fills in as topics land.
 */

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  // fileURLToPath, not .pathname: on Windows the latter yields a leading-slash drive
  // path that resolves incorrectly.
  const cataloguePath = process.env.CAREER_CATALOGUE ?? fileURLToPath(new URL('../../../data/careers/starter-v1.json', import.meta.url));

  const raw = JSON.parse(await readFile(cataloguePath, 'utf8')) as { readonly roles: readonly CareerRoleInput[] };
  const pool = new Pool({ connectionString });

  try {
    const result = await seedStarterCareerRoles(pool, raw.roles);
    console.log(JSON.stringify({ event: 'career.catalogue.seeded', ...result }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    event: 'career.catalogue.seed.failed',
    message: error instanceof Error ? error.message.slice(0, 300) : 'unknown failure',
  }));
  process.exitCode = 1;
});
