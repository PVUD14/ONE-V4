/**
 * Imports the aptitude bank pack (ENG-10; default data/engine/aptitude-bank-v1.draft.json) as
 * DRAFT skills, misconception codes and items, attributed to a named importing user, through the
 * skill map and question bank editors.
 *
 * Why this exists: model-produced content must enter ONE through the authoring path an operator
 * uses, as drafts other people review (program B.8), never by migration or hand-written rows.
 * This command only creates drafts; it never submits, reviews, approves or publishes.
 *
 * Usage: DATABASE_URL=… ENGINE_CONTENT_IMPORTER_USER_ID=<uuid> corepack pnpm --filter
 * @planthepath/persistence db:import:aptitude-bank-draft [path/to/pack.json]
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { importAptitudeBankPack, type AptitudeBankPack } from './aptitude-bank.js';
import type { TransactionalRunner } from './skill-map.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const importerUserId = process.env.ENGINE_CONTENT_IMPORTER_USER_ID?.trim() ?? '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importerUserId)) {
  throw new Error('ENGINE_CONTENT_IMPORTER_USER_ID must be an existing internal user UUID');
}

const packPath = process.argv[2]
  ? resolve(process.argv[2])
  : new URL('../../../data/engine/aptitude-bank-v1.draft.json', import.meta.url);
const pack = JSON.parse(await readFile(packPath, 'utf8')) as AptitudeBankPack;
const pool = new Pool({ connectionString: databaseUrl });
try {
  const db = drizzle(pool, { schema }) as unknown as TransactionalRunner;
  const result = await importAptitudeBankPack(db, pack, {
    userId: importerUserId, breakGlass: false, correlationId: `eng10-import-${randomUUID()}`,
  });
  console.log(JSON.stringify({
    state: 'DRAFT', skillsCreated: result.skillsCreated.length, skillsReused: result.skillsReused.length,
    codesCreated: result.codesCreated.length, codesReused: result.codesReused.length,
    itemsCreated: result.itemsCreated, itemsSkipped: result.itemsSkipped.length,
  }));
} finally {
  await pool.end();
}
