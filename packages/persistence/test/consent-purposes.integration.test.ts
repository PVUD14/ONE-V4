/**
 * Engine consent purposes fail closed and take effect on the next request (ENG-01).
 * Definitions are inserted per test inside a rolled-back transaction: publishing the real
 * definitions is hard gate HG-6, so these rows exist only for the test.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema.js';
import type { PersistenceDb } from '../src/repositories.js';
import { hasConsentPurpose, studentsConsentingToModelImprovement } from '../src/consent-purposes.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);
let client: PoolClient;
let db: PersistenceDb;
let student: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});
beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  db = drizzle(client as never, { schema }) as unknown as PersistenceDb;
  student = randomUUID();
  await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [student, student + '@example.test']);
  // Remove any live engine definitions so each case starts from a known state.
  await client.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key IN ('adaptive-learning','ai-tutoring','model-improvement') AND retired_at IS NULL");
});
afterEach(async () => { await client.query('ROLLBACK'); client.release(); });
afterAll(async () => { await pool.end(); });

async function define(key: string, version: string): Promise<void> {
  await client.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ($1, $2, 'Test purpose', 'OPTIONAL', true, now() - interval '1 minute')`, [key, version]);
}
async function act(key: string, version: string, action: 'GRANTED' | 'WITHDRAWN', secondsAgo: number): Promise<void> {
  await client.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
    VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))`, [randomUUID(), student, key, version, action, secondsAgo]);
}

describe('engine consent purposes', () => {
  it('is absent when no definition is live, even with a recorded grant', async () => {
    expect(await hasConsentPurpose(db, student, 'adaptive-learning')).toBe(false);
  });

  it('is present after a grant of the live version, and gates only its own purpose', async () => {
    await define('adaptive-learning', 'v1');
    await define('ai-tutoring', 'v1');
    await act('adaptive-learning', 'v1', 'GRANTED', 10);
    expect(await hasConsentPurpose(db, student, 'adaptive-learning')).toBe(true);
    expect(await hasConsentPurpose(db, student, 'ai-tutoring')).toBe(false);
    expect(await hasConsentPurpose(db, student, 'model-improvement')).toBe(false);
  });

  it('takes a withdrawal into effect on the next check', async () => {
    await define('ai-tutoring', 'v1');
    await act('ai-tutoring', 'v1', 'GRANTED', 10);
    expect(await hasConsentPurpose(db, student, 'ai-tutoring')).toBe(true);
    await act('ai-tutoring', 'v1', 'WITHDRAWN', 1);
    expect(await hasConsentPurpose(db, student, 'ai-tutoring')).toBe(false);
  });

  it('does not carry a grant of an older version onto a new one', async () => {
    await define('adaptive-learning', 'v1');
    await act('adaptive-learning', 'v1', 'GRANTED', 10);
    await client.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning' AND version = 'v1'");
    await define('adaptive-learning', 'v2');
    expect(await hasConsentPurpose(db, student, 'adaptive-learning')).toBe(false);
  });

  it('keeps students without model-improvement consent out of exports', async () => {
    const other = randomUUID();
    await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [other, other + '@example.test']);
    await define('model-improvement', 'v1');
    await act('model-improvement', 'v1', 'GRANTED', 10);
    expect(await studentsConsentingToModelImprovement(db, [student, other])).toEqual([student]);
  });
});
