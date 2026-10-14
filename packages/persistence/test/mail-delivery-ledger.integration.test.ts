/**
 * The delivery ledger can name the real SMTP sender (migration 0094, ADR-042).
 *
 * `notification_delivery_attempts.provider_kind` allowed only MAILPIT, SES and N8N, so a GoDaddy
 * delivery would have been recorded as MAILPIT. 0094 widens the CHECK by exactly one value. These
 * tests pin that it allows SMTP, still allows every earlier value, still refuses anything else, and
 * survives being replayed (the migrator replays every file on every run).
 *
 * Runs against the migrated DATABASE_URL; every change is made inside a transaction that is rolled back.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migration = new URL('../drizzle/0094_smtp_delivery_provider_kind.sql', import.meta.url);

afterAll(async () => {
  await pool.end();
});

async function providerKindChecks(client: { query: Pool['query'] }): Promise<string[]> {
  const result = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'notification_delivery_attempts' AND n.nspname = current_schema()
        AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%provider_kind%'`,
  );
  return result.rows.map((row) => row.definition);
}

describe('notification_delivery_attempts.provider_kind after 0094', () => {
  it('has exactly one provider_kind CHECK, allowing SMTP and every value allowed before', async () => {
    const checks = await providerKindChecks(pool);
    expect(checks).toHaveLength(1);
    for (const kind of ['MAILPIT', 'SES', 'N8N', 'SMTP']) expect(checks[0]).toContain(`'${kind}'`);
  });

  it('survives being replayed twice and still refuses an unknown provider kind', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sql = await readFile(migration, 'utf8');
      await client.query(sql);
      await client.query(sql);
      expect(await providerKindChecks(client)).toHaveLength(1);
      await client.query('SAVEPOINT before_bad_kind');
      await expect(client.query(
        `INSERT INTO notification_delivery_attempts (id, command_id, attempt, provider_kind, outcome)
         VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'SENDGRID', 'SUCCEEDED')`,
      )).rejects.toThrow(/check constraint/);
      await client.query('ROLLBACK TO SAVEPOINT before_bad_kind');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
