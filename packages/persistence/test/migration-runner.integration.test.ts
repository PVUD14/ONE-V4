/**
 * The migration runner applies each file once and records it (ADR-035).
 *
 * The regression case is the reason for the change: under the old replay-every-run model, a
 * migration that re-declares a CHECK with a fixed list undoes a later widening on every run,
 * and fails outright once a row uses the widened value. 0043 and 0047 are a live example.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { MigrationChecksumMismatch, runMigrations } from '../src/migration-runner.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const admin = new Pool({ connectionString });
let schema: string;
let pool: Pool;
let dir: string;

beforeEach(async () => {
  schema = 'migration_runner_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  pool = new Pool({ connectionString, options: '-c search_path=' + schema });
  dir = await mkdtemp(join(tmpdir(), 'one-migrations-'));
});
afterEach(async () => {
  await pool.end();
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await rm(dir, { recursive: true, force: true });
});
afterAll(async () => { await admin.end(); });

const dirUrl = () => pathToFileURL(dir + '/');
const write = (name: string, sql: string) => writeFile(join(dir, name), sql, 'utf8');

// The shape that broke: the first file re-declares its CHECK every time it runs.
const narrow = `CREATE TABLE IF NOT EXISTS records (id int PRIMARY KEY, category text NOT NULL);
ALTER TABLE records DROP CONSTRAINT IF EXISTS records_category_ck;
ALTER TABLE records ADD CONSTRAINT records_category_ck CHECK (category IN ('A'));`;
const widen = `ALTER TABLE records DROP CONSTRAINT IF EXISTS records_category_ck;
ALTER TABLE records ADD CONSTRAINT records_category_ck CHECK (category IN ('A','B'));`;

describe('migration runner', () => {
  it('applies each file once, in order, and nothing on the next run', async () => {
    await write('0001_first.sql', narrow);
    await write('0002_second.sql', widen);
    expect(await runMigrations(pool, dirUrl())).toEqual({ applied: ['0001_first.sql', '0002_second.sql'], skipped: [], bootstrapped: true });
    expect(await runMigrations(pool, dirUrl())).toEqual({ applied: [], skipped: ['0001_first.sql', '0002_second.sql'], bootstrapped: false });
  });

  it('keeps a later widening once a row uses it — the case replaying every file broke', async () => {
    await write('0001_first.sql', narrow);
    await write('0002_second.sql', widen);
    await runMigrations(pool, dirUrl());
    await pool.query("INSERT INTO records (id, category) VALUES (1, 'B')");
    // What the old runner did on the next deploy: replay 0001, which cannot re-add its CHECK.
    await expect(pool.query(narrow)).rejects.toThrow(/violated by some row/);
    await expect(runMigrations(pool, dirUrl())).resolves.toMatchObject({ applied: [] });
    await write('0003_third.sql', 'CREATE TABLE IF NOT EXISTS later (id int PRIMARY KEY);');
    expect((await runMigrations(pool, dirUrl())).applied).toEqual(['0003_third.sql']);
  });

  it('refuses a migration that changed after it was applied', async () => {
    await write('0001_first.sql', narrow);
    await runMigrations(pool, dirUrl());
    await write('0001_first.sql', narrow + '\n-- edited later');
    await expect(runMigrations(pool, dirUrl())).rejects.toBeInstanceOf(MigrationChecksumMismatch);
  });

  it('treats CRLF and LF checkouts of the same file as the same migration', async () => {
    await write('0001_first.sql', narrow);
    await runMigrations(pool, dirUrl());
    await write('0001_first.sql', narrow.replace(/\n/g, '\r\n'));
    await expect(runMigrations(pool, dirUrl())).resolves.toMatchObject({ applied: [], skipped: ['0001_first.sql'] });
  });

  it('leaves neither the change nor its ledger row behind when a migration fails', async () => {
    await write('0001_first.sql', narrow);
    await write('0002_broken.sql', 'CREATE TABLE half_done (id int); SELECT no_such_function();');
    await expect(runMigrations(pool, dirUrl())).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass(current_schema() || '.half_done') AS t")).rows[0].t).toBeNull();
    expect((await pool.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows).toEqual([{ filename: '0001_first.sql' }]);
  });

  it('brings a database migrated before the ledger existed forward by replaying once, then records it', async () => {
    await pool.query(narrow);
    await pool.query(widen);
    await write('0001_first.sql', narrow);
    await write('0002_second.sql', widen);
    expect(await runMigrations(pool, dirUrl())).toMatchObject({ applied: ['0001_first.sql', '0002_second.sql'], bootstrapped: true });
    expect(await runMigrations(pool, dirUrl())).toMatchObject({ applied: [], bootstrapped: false });
  });

  it('applies the repository migrations to an empty schema, then none on a second run', async () => {
    const repository = new URL('../drizzle/', import.meta.url);
    const first = await runMigrations(pool, repository);
    expect(first.applied.length).toBeGreaterThan(40);
    const second = await runMigrations(pool, repository);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);
  }, 120_000);
});
