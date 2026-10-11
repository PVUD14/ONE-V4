/**
 * Imports the agent-drafted teaching-strategy pack (data/engine/teaching-strategies-v1.draft.json)
 * as DRAFT content attributed to a named importing user (ENG-07).
 *
 * Why this exists: model-produced content must enter ONE through the content lifecycle as a
 * draft a person reviews (program B.8), never by migration or by hand-inserted published rows.
 * This command only creates drafts; it never submits, approves or publishes.
 */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { PersistenceDb } from './repositories.js';
import { importTeachingStrategyDraftPack, type TeachingStrategyDraftPack } from './misconceptions.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const importerUserId = process.env.ENGINE_CONTENT_IMPORTER_USER_ID?.trim() ?? '';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importerUserId)) {
  throw new Error('ENGINE_CONTENT_IMPORTER_USER_ID must be an existing internal user UUID');
}

const packUrl = new URL('../../../data/engine/teaching-strategies-v1.draft.json', import.meta.url);
const pack = JSON.parse(await readFile(packUrl, 'utf8')) as TeachingStrategyDraftPack;
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const db = drizzle(client as never, { schema }) as unknown as PersistenceDb;
  const result = await importTeachingStrategyDraftPack(db, pack, importerUserId);
  await client.query('COMMIT');
  console.log(JSON.stringify({ state: 'DRAFT', ...result }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
