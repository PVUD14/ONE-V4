/**
 * Applies SQL migrations once each, in lexical order, recording what ran (ADR-035).
 *
 * The runner used to replay every file on every run. That made each migration an idempotent
 * "desired state" script, and it broke as soon as two migrations described the same CHECK:
 * 0043 re-adds the deletion-category CHECK without LEARNING_ACTIVITY, so on any database that
 * already holds such a row, replaying 0043 before 0047 fails and the deploy stops. Recording
 * applied files removes the replay, so a widening can never be undone by an earlier file.
 *
 * Bootstrap: a database with no ledger yet (every database migrated before this change) is
 * brought forward exactly as before — every file runs once more, in order — and then recorded.
 * Every migration was written to be idempotent for that replay model, so this is the same
 * operation deploys have always performed; after it, nothing is replayed again.
 *
 * Each pending file runs in its own transaction together with its ledger row, so a failure
 * leaves neither half behind. A recorded file whose contents changed is refused: existing
 * migrations must never be edited (AGENTS.md), and a silent mismatch would hide exactly that.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

export const MIGRATION_LEDGER_TABLE = 'schema_migrations';

export interface MigrationRunResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly bootstrapped: boolean;
}

export class MigrationChecksumMismatch extends Error {
  constructor(readonly filename: string) {
    super(`migration ${filename} changed after it was applied; existing migrations must not be edited`);
    this.name = 'MigrationChecksumMismatch';
  }
}

export function migrationChecksum(contents: string): string {
  // Line endings are normalised so a checkout on Windows and one on Linux agree.
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function runMigrations(pool: Pool, migrationDir: URL, log: (line: string) => void = () => undefined): Promise<MigrationRunResult> {
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  const ledgerExists = (await pool.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.${MIGRATION_LEDGER_TABLE}') IS NOT NULL AS exists`,
  )).rows[0]?.exists === true;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
    filename text PRIMARY KEY,
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const recorded = new Map((await pool.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM ${MIGRATION_LEDGER_TABLE}`,
  )).rows.map((row) => [row.filename, row.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const filename of files) {
    const contents = await readFile(new URL(filename, migrationDir), 'utf8');
    const checksum = migrationChecksum(contents);
    const previous = recorded.get(filename);
    if (previous !== undefined) {
      if (previous !== checksum) throw new MigrationChecksumMismatch(filename);
      skipped.push(filename);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(contents);
      await client.query(`INSERT INTO ${MIGRATION_LEDGER_TABLE} (filename, checksum) VALUES ($1, $2)`, [filename, checksum]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    applied.push(filename);
    log(`applied ${filename}`);
  }
  return { applied, skipped, bootstrapped: !ledgerExists };
}
