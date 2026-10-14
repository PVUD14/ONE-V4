/**
 * Database tests for item calibrations (ENG-13, migration 0062): the de-identified, consented
 * export the Python job reads; the strict import of its results; the online reader; and the
 * data-layer guards (too few responses can never be CALIBRATED, rows are append-only, parameters
 * stay in range).
 *
 * Why: the Python job never touches the database, so everything that decides what it may see and
 * what may be stored is here. Every person and item is synthetic, and every case runs inside a
 * transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema.js';
import type { PersistenceDb } from '../src/repositories.js';
import {
  CALIBRATION_ALGORITHM_ID,
  CALIBRATION_EXPORT_FORMAT,
  CALIBRATION_RESULTS_FORMAT,
  CalibrationResultsError,
  exportCalibrationAttempts,
  importCalibrationResults,
  latestItemCalibrations,
  type CalibrationItemKey,
} from '../src/item-calibrations.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
const migrationDir = new URL('../drizzle/', import.meta.url);
const CONSENT_VERSION = 'eng13-synthetic-test';

class Rollback extends Error {}

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});
afterAll(async () => { await pool.end(); });

async function inRollback(body: (tx: PersistenceDb) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await body(tx as unknown as PersistenceDb);
    throw new Rollback();
  })).rejects.toBeInstanceOf(Rollback);
}

/** Makes model-improvement live at a test-only version, inside the rolled-back transaction. */
async function liveModelImprovement(tx: PersistenceDb): Promise<void> {
  await tx.execute(sql`UPDATE consent_definitions SET retired_at = greatest(now(), effective_from)
    WHERE consent_key = 'model-improvement' AND retired_at IS NULL`);
  await tx.execute(sql`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('model-improvement', ${CONSENT_VERSION}, 'Test purpose', 'OPTIONAL', true, now() - interval '1 minute')`);
}

async function learner(tx: PersistenceDb, consent: 'GRANTED' | 'WITHDRAWN' | 'NONE' = 'GRANTED'): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO users (id, email, state) VALUES (${id}::uuid, ${`${id}@example.test`}, 'ACTIVE')`);
  if (consent !== 'NONE') {
    await tx.execute(sql`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
      VALUES (${randomUUID()}::uuid, ${id}::uuid, 'model-improvement', ${CONSENT_VERSION}, 'GRANTED', now() - interval '20 seconds')`);
    if (consent === 'WITHDRAWN') {
      await tx.execute(sql`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
        VALUES (${randomUUID()}::uuid, ${id}::uuid, 'model-improvement', ${CONSENT_VERSION}, 'WITHDRAWN', now() - interval '10 seconds')`);
    }
  }
  return id;
}

async function attempt(tx: PersistenceDb, subject: string, item: string, correct: boolean, options: { minutesAgo?: number; assisted?: boolean; answered?: boolean } = {}): Promise<void> {
  const session = randomUUID();
  const minutesAgo = options.minutesAgo ?? 10;
  const assisted = options.assisted ?? false;
  const answered = options.answered ?? true;
  await tx.execute(sql`INSERT INTO learning_sessions (id, subject_user_id, mode, started_at)
    VALUES (${session}::uuid, ${subject}::uuid, 'PRACTICE', now() - make_interval(mins => ${minutesAgo}))`);
  await tx.execute(sql`INSERT INTO learning_attempt_events
      (id, subject_user_id, session_id, item_source, item_id, item_version, context, answered, correct, score,
       highest_hint_level, assisted, content_version, source_attempt_type, source_attempt_id, occurred_at)
    VALUES (${randomUUID()}::uuid, ${subject}::uuid, ${session}::uuid, 'CAREER_READINESS_QUESTION', ${item}::uuid, 1, 'PRACTICE',
      ${answered}, ${correct}, ${correct ? 1 : 0}, ${assisted ? 3 : 0}, ${assisted}, 'practice-test', 'assessment_attempt', ${randomUUID()}::uuid,
      now() - make_interval(mins => ${minutesAgo}))`);
}

const key = (itemId: string): string => `CAREER_READINESS_QUESTION:${itemId}:1`;
const itemKey = (itemId: string): CalibrationItemKey => ({ itemSource: 'CAREER_READINESS_QUESTION', itemId, itemVersion: 1 });

function resultsFor(runId: string, items: { itemId: string; responsesUsed: number; status: 'CALIBRATED' | 'PROVISIONAL'; difficulty?: number; discrimination?: number; statusReason?: string | null }[], minResponses = 2): Record<string, unknown> {
  return {
    format: CALIBRATION_RESULTS_FORMAT,
    runId,
    algorithmId: CALIBRATION_ALGORITHM_ID,
    library: 'girth==0.8.0 numpy==2.4.6 scipy==1.17.1',
    minResponses,
    exportedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    learnersRead: 3,
    responsesRead: items.reduce((sum, item) => sum + item.responsesUsed, 0),
    itemsRead: items.length,
    items: items.map((item) => ({
      itemSource: 'CAREER_READINESS_QUESTION', itemId: item.itemId, itemVersion: 1, model: '2PL',
      difficulty: item.difficulty ?? 0.25, discrimination: item.discrimination ?? 1.1, responsesUsed: item.responsesUsed,
      status: item.status, statusReason: item.statusReason ?? (item.status === 'CALIBRATED' ? null : 'TOO_FEW_RESPONSES'),
    })),
  };
}

describe('calibration export', () => {
  it('is empty while model-improvement has no live definition, even with recorded grants', async () => {
    await inRollback(async (tx) => {
      await liveModelImprovement(tx);
      const student = await learner(tx);
      await attempt(tx, student, randomUUID(), true);
      await tx.execute(sql`UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'model-improvement' AND version = ${CONSENT_VERSION}`);
      const exported = await exportCalibrationAttempts(tx);
      expect(exported.format).toBe(CALIBRATION_EXPORT_FORMAT);
      expect(exported.responses).toEqual([]);
    });
  });

  it('reads only students holding the live purpose, and carries nothing but pseudonym, item and correctness', async () => {
    await inRollback(async (tx) => {
      await liveModelImprovement(tx);
      const item = randomUUID();
      const granted = await learner(tx, 'GRANTED');
      const withdrawn = await learner(tx, 'WITHDRAWN');
      const never = await learner(tx, 'NONE');
      await attempt(tx, granted, item, true);
      await attempt(tx, withdrawn, item, false);
      await attempt(tx, never, item, false);

      const exported = await exportCalibrationAttempts(tx);
      expect(exported.responses).toEqual([['L1', key(item), 1]]);
      const serialized = JSON.stringify(exported);
      for (const id of [granted, withdrawn, never]) expect(serialized).not.toContain(id);
      expect(serialized).not.toContain('@example.test');
      expect(Object.keys(exported).sort()).toEqual(['exportedAt', 'format', 'responses', 'runId']);
    });
  });

  it('keeps only each learner\'s first response to an item, drops it when it was assisted, and counts a blank as wrong', async () => {
    await inRollback(async (tx) => {
      await liveModelImprovement(tx);
      const firstWrong = randomUUID();
      const firstAssisted = randomUUID();
      const blank = randomUUID();
      const student = await learner(tx);
      await attempt(tx, student, firstWrong, false, { minutesAgo: 30 });
      await attempt(tx, student, firstWrong, true, { minutesAgo: 5 });
      await attempt(tx, student, firstAssisted, true, { minutesAgo: 30, assisted: true });
      await attempt(tx, student, firstAssisted, true, { minutesAgo: 5 });
      await attempt(tx, student, blank, false, { answered: false });

      const exported = await exportCalibrationAttempts(tx);
      const byItem = new Map(exported.responses.map(([, item, correct]) => [item, correct]));
      expect(byItem.get(key(firstWrong))).toBe(0);
      expect(byItem.has(key(firstAssisted))).toBe(false);
      expect(byItem.get(key(blank))).toBe(0);
      expect(exported.responses).toHaveLength(2);
    });
  });

  it('gives each run its own id and unrelated pseudonyms, so runs cannot be joined', async () => {
    await inRollback(async (tx) => {
      await liveModelImprovement(tx);
      // Learner i answers i distinct items, so the number of responses identifies the person in the test.
      const items = Array.from({ length: 12 }, () => randomUUID());
      for (let i = 1; i <= 12; i += 1) {
        const student = await learner(tx);
        for (const item of items.slice(0, i)) await attempt(tx, student, item, i % 2 === 0);
      }
      const mapping = (responses: [string, string, 0 | 1][]): string => {
        const counts = new Map<string, number>();
        for (const [pseudonym] of responses) counts.set(pseudonym, (counts.get(pseudonym) ?? 0) + 1);
        return Array.from({ length: 12 }, (_, index) => [...counts].find(([, n]) => n === index + 1)?.[0]).join(',');
      };
      const first = await exportCalibrationAttempts(tx);
      const second = await exportCalibrationAttempts(tx);
      expect(first.runId).not.toBe(second.runId);
      expect(first.responses).toHaveLength(78);
      expect(new Set(first.responses.map(([pseudonym]) => pseudonym))).toEqual(new Set(Array.from({ length: 12 }, (_, i) => `L${i + 1}`)));
      // 1 in 12! of this failing by chance.
      expect(mapping(second.responses)).not.toBe(mapping(first.responses));
    });
  });
});

describe('calibration import and the online reader', () => {
  it('writes a run and its rows once; a replay of the same run is a no-op', async () => {
    await inRollback(async (tx) => {
      const [a, b] = [randomUUID(), randomUUID()];
      const student = await learner(tx, 'NONE');
      await attempt(tx, student, a, true);
      await attempt(tx, student, b, false);
      const runId = randomUUID();
      const payload = resultsFor(runId, [
        { itemId: a, responsesUsed: 3, status: 'CALIBRATED', difficulty: -0.75, discrimination: 1.4 },
        { itemId: b, responsesUsed: 1, status: 'PROVISIONAL' },
      ]);
      expect(await importCalibrationResults(tx, payload)).toEqual({ runId, imported: true, calibrated: 1, provisional: 1 });
      expect(await importCalibrationResults(tx, payload)).toEqual({ runId, imported: false, calibrated: 0, provisional: 0 });

      const rows = await tx.execute(sql`SELECT count(*)::int AS n FROM item_calibrations WHERE run_id = ${runId}::uuid`) as unknown as { rows: { n: number }[] };
      expect(rows.rows[0]!.n).toBe(2);
      const run = await tx.execute(sql`SELECT source, algorithm_id, library, min_responses FROM item_calibration_runs WHERE id = ${runId}::uuid`) as unknown as { rows: Record<string, unknown>[] };
      expect(run.rows[0]).toEqual({ source: 'jobs/calibration', algorithm_id: CALIBRATION_ALGORITHM_ID, library: 'girth==0.8.0 numpy==2.4.6 scipy==1.17.1', min_responses: 2 });

      const latest = await latestItemCalibrations(tx, [itemKey(a), itemKey(b), itemKey(randomUUID())]);
      expect(latest.size).toBe(2);
      expect(latest.get(key(a))).toMatchObject({ status: 'CALIBRATED', difficulty: -0.75, discrimination: 1.4, responsesUsed: 3, runId, algorithmId: CALIBRATION_ALGORITHM_ID });
      expect(latest.get(key(b))).toMatchObject({ status: 'PROVISIONAL', statusReason: 'TOO_FEW_RESPONSES' });
    });
  });

  it('prefers the latest CALIBRATED row over a newer PROVISIONAL one, and the latest CALIBRATED over an older one', async () => {
    await inRollback(async (tx) => {
      const [a, b] = [randomUUID(), randomUUID()];
      const student = await learner(tx, 'NONE');
      await attempt(tx, student, a, true);
      await attempt(tx, student, b, true);
      const older = resultsFor(randomUUID(), [
        { itemId: a, responsesUsed: 3, status: 'CALIBRATED', difficulty: 1 },
        { itemId: b, responsesUsed: 3, status: 'CALIBRATED', difficulty: 1 },
      ]);
      older.exportedAt = new Date(Date.now() - 86_400_000).toISOString();
      await importCalibrationResults(tx, older);
      const newer = resultsFor(randomUUID(), [
        { itemId: a, responsesUsed: 1, status: 'PROVISIONAL', difficulty: 0 },
        { itemId: b, responsesUsed: 4, status: 'CALIBRATED', difficulty: 2 },
      ]);
      await importCalibrationResults(tx, newer);

      const latest = await latestItemCalibrations(tx, [itemKey(a), itemKey(b)]);
      expect(latest.get(key(a))).toMatchObject({ status: 'CALIBRATED', difficulty: 1, runId: older.runId });
      expect(latest.get(key(b))).toMatchObject({ status: 'CALIBRATED', difficulty: 2, runId: newer.runId });
      expect((await latestItemCalibrations(tx, [])).size).toBe(0);
    });
  });

  it('refuses an item that is not in the attempt log, and writes nothing for that run', async () => {
    await inRollback(async (tx) => {
      const known = randomUUID();
      const student = await learner(tx, 'NONE');
      await attempt(tx, student, known, true);
      const runId = randomUUID();
      await expect(importCalibrationResults(tx, resultsFor(runId, [
        { itemId: known, responsesUsed: 2, status: 'CALIBRATED' },
        { itemId: randomUUID(), responsesUsed: 2, status: 'CALIBRATED' },
      ]))).rejects.toBeInstanceOf(CalibrationResultsError);
      const runs = await tx.execute(sql`SELECT count(*)::int AS n FROM item_calibration_runs WHERE id = ${runId}::uuid`) as unknown as { rows: { n: number }[] };
      expect(runs.rows[0]!.n).toBe(0);
    });
  });

  it('refuses a CALIBRATED item below the threshold before touching the database', async () => {
    await inRollback(async (tx) => {
      await expect(importCalibrationResults(tx, resultsFor(randomUUID(), [
        { itemId: randomUUID(), responsesUsed: 1, status: 'CALIBRATED' },
      ], 2))).rejects.toThrow(/at least 2 responses/);
    });
  });
});

describe('0062 guards', () => {
  async function run(tx: PersistenceDb, minResponses: number): Promise<string> {
    const id = randomUUID();
    await tx.execute(sql`INSERT INTO item_calibration_runs
        (id, source, algorithm_id, library, min_responses, learners_read, responses_read, items_read, exported_at, generated_at)
      VALUES (${id}::uuid, 'jobs/calibration', ${CALIBRATION_ALGORITHM_ID}, 'girth==0.8.0', ${minResponses}, 0, 0, 0, now(), now())`);
    return id;
  }
  async function row(tx: PersistenceDb, runId: string, values: { responses: number; status: string; reason: string | null; difficulty?: number; discrimination?: number }): Promise<void> {
    await tx.execute(sql`INSERT INTO item_calibrations
        (id, run_id, item_source, item_id, item_version, model, difficulty, discrimination, responses_used, status, status_reason)
      VALUES (${randomUUID()}::uuid, ${runId}::uuid, 'CAREER_READINESS_QUESTION', ${randomUUID()}::uuid, 1, '2PL',
        ${values.difficulty ?? 0}, ${values.discrimination ?? 1}, ${values.responses}, ${values.status}, ${values.reason})`);
  }
  async function refused(tx: PersistenceDb, statement: () => Promise<unknown>, message: RegExp): Promise<void> {
    // A savepoint, so the refusal does not abort the surrounding test transaction.
    let failure: unknown;
    try {
      await tx.transaction(async () => { await statement(); });
    } catch (error) {
      failure = error;
    }
    expect(failure, 'the statement should have been refused').toBeInstanceOf(Error);
    const cause = (failure as { cause?: { message?: string } }).cause?.message ?? '';
    expect(`${(failure as Error).message} ${cause}`).toMatch(message);
  }

  it('never stores a CALIBRATED row with fewer responses than its run requires', async () => {
    await inRollback(async (tx) => {
      const runId = await run(tx, 200);
      await refused(tx, () => row(tx, runId, { responses: 199, status: 'CALIBRATED', reason: null }), /min_responses/);
      await row(tx, runId, { responses: 199, status: 'PROVISIONAL', reason: 'TOO_FEW_RESPONSES' });
      await row(tx, runId, { responses: 200, status: 'CALIBRATED', reason: null });
    });
  });

  it('keeps status and reason consistent and parameters in the usable range', async () => {
    await inRollback(async (tx) => {
      const runId = await run(tx, 1);
      await refused(tx, () => row(tx, runId, { responses: 5, status: 'PROVISIONAL', reason: null }), /status_reason/);
      await refused(tx, () => row(tx, runId, { responses: 5, status: 'CALIBRATED', reason: 'NO_VARIANCE' }), /status_reason/);
      await refused(tx, () => row(tx, runId, { responses: 5, status: 'CALIBRATED', reason: null, difficulty: 4.5 }), /difficulty/);
      await refused(tx, () => row(tx, runId, { responses: 5, status: 'CALIBRATED', reason: null, discrimination: -0.5 }), /discrimination/);
    });
  });

  it('is append-only: runs and calibrations can be neither updated nor deleted', async () => {
    await inRollback(async (tx) => {
      const runId = await run(tx, 1);
      await row(tx, runId, { responses: 5, status: 'CALIBRATED', reason: null });
      await refused(tx, () => tx.execute(sql`UPDATE item_calibrations SET difficulty = 1 WHERE run_id = ${runId}::uuid`), /append-only/);
      await refused(tx, () => tx.execute(sql`DELETE FROM item_calibrations WHERE run_id = ${runId}::uuid`), /append-only/);
      await refused(tx, () => tx.execute(sql`UPDATE item_calibration_runs SET min_responses = 2 WHERE id = ${runId}::uuid`), /append-only/);
      await refused(tx, () => tx.execute(sql`DELETE FROM item_calibration_runs WHERE id = ${runId}::uuid`), /append-only/);
    });
  });
});
