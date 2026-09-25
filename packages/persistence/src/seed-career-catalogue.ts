/**
 * Seeds the job-role catalogue (OPS-08) from data/careers/catalogue-v1.json.
 *
 * Reference content, deployed on purpose like `db:seed:careers`. Run the starter seed
 * first so the five starter roles are mapped onto their catalogue rows rather than
 * duplicated. Idempotent; writes no requirement set, publishes nothing, marks nothing
 * verified, and stores no goal (no goal model exists yet).
 *
 * Design: docs/architecture/career-catalogue-table-design.md
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { verifyCatalogueCounts, type CareerCatalogueFile } from './career-catalogue-input.js';
import { seedCareerCatalogue } from './career-catalogue.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const cataloguePath = process.env.CAREER_CATALOGUE_FILE ?? fileURLToPath(new URL('../../../data/careers/catalogue-v1.json', import.meta.url));
  const file = JSON.parse(await readFile(cataloguePath, 'utf8')) as CareerCatalogueFile;
  // The file is checked again here, not trusted: a hand-edited file with a lost row fails.
  verifyCatalogueCounts(file.roles, file.goals);
  const pool = new Pool({ connectionString });
  try {
    const result = await seedCareerCatalogue(pool, file);
    console.log(JSON.stringify({ event: 'career.catalogue.seeded', version: file.version, roles: file.roles.length, ...result }));
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
