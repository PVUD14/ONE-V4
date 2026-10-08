/**
 * Database tests for recalibration runs (ENG-26, migration 0115): the exports and baselines the
 * Python job reads, the strict recording of its proposals, and the only way a proposal is adopted —
 * an explicit accept, which refuses a stale proposal — plus reject, revert, ENG-27's BKT reader, the
 * markdown report, and the data-layer guards.
 *
 * Why: a refit must never change live parameters by being computed. Every person, item and skill
 * here is synthetic, and every case runs inside a transaction that is rolled back, so no other
 * suite ever sees these rows (and these cases never see another suite's).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema.js';
import type { PersistenceDb } from '../src/repositories.js';
import {
  CALIBRATION_ALGORITHM_ID,
  CALIBRATION_RESULTS_FORMAT,
  importCalibrationResults,
  latestItemCalibrations,
} from '../src/item-calibrations.js';
import {
  BKT_FIT_ALGORITHM_ID,
  BKT_RESULTS_FORMAT,
  RECALIBRATION_CHANGES,
  RECALIBRATION_PROPOSAL_FORMAT,
  RECALIBRATION_REPORT_FORMAT,
  RecalibrationError,
  acceptedBktParameters,
  bktBaselineDigest,
  decideRecalibration,
  exportBktRefit,
  exportItemRecalibration,
  itemBaselineDigest,
  liveItemCalibrationRows,
  listRecalibrationRuns,
  loadRecalibrationRun,
  parseRecalibrationProposal,
  recordRecalibrationProposal,
  renderRecalibrationMarkdown,
  revertRecalibration,
  type RecalibrationChange,
} from '../src/recalibration.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
const migrationDir = new URL('../drizzle/', import.meta.url);
const CONSENT_VERSION = 'eng26-synthetic-test';

class Rollback extends Error {}

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});
afterAll(async () => { await pool.end(); });

async function inRollback(body: (tx: PersistenceDb) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx as unknown as PersistenceDb);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return; // rolled back, as every case must be
    throw error; // the case's own failure, unwrapped
  }
  throw new Error('the case was not rolled back');
}

async function liveModelImprovement(tx: PersistenceDb): Promise<void> {
  await tx.execute(sql`UPDATE consent_definitions SET retired_at = greatest(now(), effective_from)
    WHERE consent_key = 'model-improvement' AND retired_at IS NULL`);
  await tx.execute(sql`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('model-improvement', ${CONSENT_VERSION}, 'Test purpose', 'OPTIONAL', true, now() - interval '1 minute')`);
}

async function learner(tx: PersistenceDb, consent: 'GRANTED' | 'NONE' = 'GRANTED'): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO users (id, email, state) VALUES (${id}::uuid, ${`${id}@example.test`}, 'ACTIVE')`);
  if (consent === 'GRANTED') {
    await tx.execute(sql`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
      VALUES (${randomUUID()}::uuid, ${id}::uuid, 'model-improvement', ${CONSENT_VERSION}, 'GRANTED', now() - interval '20 seconds')`);
  }
  return id;
}

async function topic(tx: PersistenceDb): Promise<string> {
  const author = await learner(tx, 'NONE');
  const id = randomUUID();
  const revision = randomUUID();
  await tx.execute(sql`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES (${revision}::uuid, 'TOPIC', ${id}::uuid, 1, ${author}::uuid, 'DRAFT', ${createHash('sha256').update(id).digest('hex')}, '{}')`);
  await tx.execute(sql`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES (${id}::uuid, 'TOPIC', ${`eng26-${id}`}, 1, 'Synthetic ENG-26 topic', 'Synthetic topic for ENG-26 tests', ${revision}::uuid)`);
  return id;
}

async function attempt(tx: PersistenceDb, subject: string, item: string, correct: boolean,
  options: { minutesAgo?: number; skillId?: string; assisted?: boolean } = {}): Promise<void> {
  const session = randomUUID();
  const minutesAgo = options.minutesAgo ?? 10;
  const assisted = options.assisted ?? false;
  await tx.execute(sql`INSERT INTO learning_sessions (id, subject_user_id, mode, started_at)
    VALUES (${session}::uuid, ${subject}::uuid, 'PRACTICE', now() - make_interval(mins => ${minutesAgo}))`);
  await tx.execute(sql`INSERT INTO learning_attempt_events
      (id, subject_user_id, session_id, item_source, item_id, item_version, skill_id, context, answered, correct, score,
       highest_hint_level, assisted, content_version, source_attempt_type, source_attempt_id, occurred_at)
    VALUES (${randomUUID()}::uuid, ${subject}::uuid, ${session}::uuid, 'CAREER_READINESS_QUESTION', ${item}::uuid, 1,
      ${options.skillId ?? null}::uuid, 'PRACTICE', true, ${correct}, ${correct ? 1 : 0}, ${assisted ? 3 : 0}, ${assisted},
      'practice-test', 'assessment_attempt', ${randomUUID()}::uuid, now() - make_interval(mins => ${minutesAgo}))`);
}

const key = (itemId: string): string => `CAREER_READINESS_QUESTION:${itemId}:1`;
type ItemFit = { itemId: string; difficulty: number; discrimination?: number; status?: 'CALIBRATED' | 'PROVISIONAL'; responsesUsed?: number };

function itemResults(runId: string, items: ItemFit[], exportedAt = new Date().toISOString()): Record<string, unknown> {
  return {
    format: CALIBRATION_RESULTS_FORMAT, runId, algorithmId: CALIBRATION_ALGORITHM_ID,
    library: 'girth==0.8.0 numpy==2.4.6 scipy==1.17.1', minResponses: 2, exportedAt, generatedAt: exportedAt,
    learnersRead: 6, responsesRead: items.reduce((sum, item) => sum + (item.responsesUsed ?? 6), 0), itemsRead: items.length,
    items: items.map((item) => ({
      itemSource: 'CAREER_READINESS_QUESTION', itemId: item.itemId, itemVersion: 1, model: '2PL',
      difficulty: item.difficulty, discrimination: item.discrimination ?? 1.1, responsesUsed: item.responsesUsed ?? 6,
      status: item.status ?? 'CALIBRATED', statusReason: (item.status ?? 'CALIBRATED') === 'CALIBRATED' ? null : 'TOO_FEW_RESPONSES',
    })),
  };
}

function counts(units: { change: RecalibrationChange }[]): Record<RecalibrationChange, number> {
  const tally = Object.fromEntries(RECALIBRATION_CHANGES.map((change) => [change, 0])) as Record<RecalibrationChange, number>;
  for (const unit of units) tally[unit.change] += 1;
  return tally;
}

/** What the Python job writes for an item run: here built directly, with a chosen comparison per item. */
function itemProposal(runId: string, digest: string, items: ItemFit[], changes: Record<string, RecalibrationChange>, previousRunId: string | null = null): Record<string, unknown> {
  const units = items.map((item) => {
    const change = changes[item.itemId] ?? 'NEW';
    const compared = change === 'STABLE' || change === 'DRIFTED';
    return {
      key: key(item.itemId), previousStatus: compared ? 'CALIBRATED' : null, proposedStatus: item.status ?? 'CALIBRATED', change,
      parameters: compared ? [
        { name: 'difficulty', scale: 'absolute', previous: 0.1, proposed: item.difficulty, change: item.difficulty - 0.1, seDifference: 0.1,
          tolerance: 0.35, drifted: change === 'DRIFTED' },
        { name: 'discrimination', scale: 'log-ratio', previous: 1.1, proposed: item.discrimination ?? 1.1, change: 0, seDifference: 0.1, tolerance: 0.35, drifted: false },
      ] : [],
    };
  });
  const tally = counts(units);
  return {
    format: RECALIBRATION_PROPOSAL_FORMAT, kind: 'ITEM_2PL', runId, baselineDigest: digest, previousRunId,
    results: itemResults(runId, items),
    report: {
      format: RECALIBRATION_REPORT_FORMAT, kind: 'ITEM_2PL', runId, algorithmId: CALIBRATION_ALGORITHM_ID, baselineDigest: digest,
      bounds: { z: 3.5, difficultyFloor: 0.3, discriminationLogRatioFloor: 0.2231 },
      verdict: tally.DRIFTED > 0 ? 'DRIFTED' : tally.STABLE > 0 ? 'STABLE' : 'NO_COMPARISON', counts: tally, units,
    },
  };
}

const FIT = { pInit: 0.4, pLearn: 0.12, pGuess: 0.22, pSlip: 0.08 };
const SE = { pInit: 0.03, pLearn: 0.01, pGuess: 0.02, pSlip: 0.01 };

function bktProposal(runId: string, digest: string, skills: { skillId: string; fitted: boolean; parameters?: typeof FIT }[], previousRunId: string | null = null): Record<string, unknown> {
  const units = skills.map((skill) => ({
    key: skill.skillId, previousStatus: null, proposedStatus: skill.fitted ? 'FITTED' : 'DEFAULT', learners: skill.fitted ? 150 : '<5',
    change: (skill.fitted ? 'NEW' : 'NOT_CALIBRATED') as RecalibrationChange, parameters: [],
  }));
  return {
    format: RECALIBRATION_PROPOSAL_FORMAT, kind: 'BKT', runId, baselineDigest: digest, previousRunId,
    results: {
      format: BKT_RESULTS_FORMAT, runId, algorithmId: BKT_FIT_ALGORITHM_ID, library: 'numpy==2.4.6 scipy==1.17.1', minLearners: 100,
      exportedAt: new Date().toISOString(), generatedAt: new Date().toISOString(), sequencesRead: 153, observationsRead: 1500,
      skillsRead: skills.length,
      skills: skills.map((skill) => skill.fitted
        ? { skillId: skill.skillId, learners: 150, observations: 1480, status: 'FITTED', statusReason: null, parameters: skill.parameters ?? FIT, standardErrors: SE }
        : { skillId: skill.skillId, learners: 3, observations: 20, status: 'DEFAULT', statusReason: 'TOO_FEW_LEARNERS', parameters: null, standardErrors: null }),
    },
    report: {
      format: RECALIBRATION_REPORT_FORMAT, kind: 'BKT', runId, algorithmId: BKT_FIT_ALGORITHM_ID, baselineDigest: digest,
      bounds: { z: 3, probabilityFloor: 0.05 }, verdict: 'NO_COMPARISON', counts: counts(units), units,
    },
  };
}

async function refused(promise: Promise<unknown>, code: RecalibrationError['code']): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'RecalibrationError', code });
}

/** Two items in the attempt log with an imported ENG-13 calibration; returns their ids and that run. */
async function calibratedBank(tx: PersistenceDb): Promise<{ a: string; b: string; fresh: string; firstRun: string }> {
  const [a, b, fresh] = [randomUUID(), randomUUID(), randomUUID()];
  const student = await learner(tx, 'NONE');
  for (const item of [a, b, fresh]) await attempt(tx, student, item, true);
  const firstRun = randomUUID();
  await importCalibrationResults(tx, itemResults(firstRun, [{ itemId: a, difficulty: 0.1 }, { itemId: b, difficulty: -0.5 }],
    new Date(Date.now() - 3_600_000).toISOString()));
  return { a, b, fresh, firstRun };
}

describe('0115 guards', () => {
  it('refuses a verdict that disagrees with its counts, a mismatched algorithm, and any rewrite', async () => {
    await inRollback(async (tx) => {
      const insert = (runner: PersistenceDb, id: string, kind: string, algorithm: string, verdict: string, compared: number, drifted: number) => runner.execute(sql`
        INSERT INTO recalibration_runs (id, kind, source, algorithm_id, library, threshold, units_read, observations_read,
          units_compared, units_drifted, verdict, baseline_digest, results, report, exported_at, generated_at)
        VALUES (${id}::uuid, ${kind}, 'jobs/calibration', ${algorithm}, 'lib', 1, 0, 0, ${compared}, ${drifted}, ${verdict},
          ${'a'.repeat(64)}, '{}'::jsonb, '{}'::jsonb, now(), now())`);
      // A savepoint, so a refusal does not abort the case's transaction; the database's message is the cause.
      const refusedBy = async (body: (runner: PersistenceDb) => Promise<unknown>, message?: RegExp): Promise<void> => {
        let failure: unknown;
        try {
          await tx.transaction(async (inner) => { await body(inner as unknown as PersistenceDb); });
        } catch (error) {
          failure = error;
        }
        expect(failure, 'the statement should have been refused').toBeInstanceOf(Error);
        const cause = (failure as { cause?: { message?: string } }).cause?.message ?? '';
        if (message) expect(`${(failure as Error).message} ${cause}`).toMatch(message);
      };
      await refusedBy((r) => insert(r, randomUUID(), 'BKT', BKT_FIT_ALGORITHM_ID, 'STABLE', 0, 0));
      await refusedBy((r) => insert(r, randomUUID(), 'BKT', CALIBRATION_ALGORITHM_ID, 'NO_COMPARISON', 0, 0));
      await refusedBy((r) => insert(r, randomUUID(), 'ITEM_2PL', CALIBRATION_ALGORITHM_ID, 'STABLE', 2, 1));
      const id = randomUUID();
      await insert(tx, id, 'BKT', BKT_FIT_ALGORITHM_ID, 'DRIFTED', 3, 1);
      await refusedBy((r) => r.execute(sql`UPDATE recalibration_runs SET verdict = 'STABLE' WHERE id = ${id}::uuid`), /append-only/);
      await refusedBy((r) => r.execute(sql`DELETE FROM recalibration_runs WHERE id = ${id}::uuid`), /append-only/);
      const decide = (runner: PersistenceDb, decision: string) => runner.execute(sql`INSERT INTO recalibration_decisions (id, run_id, decision, reason)
        VALUES (${randomUUID()}::uuid, ${id}::uuid, ${decision}, 'test')`);
      await refusedBy((r) => decide(r, 'REVERTED'), /only an accepted run/);
      await decide(tx, 'ACCEPTED');
      await refusedBy((r) => decide(r, 'REJECTED'), /accepted or rejected once/);
      await decide(tx, 'REVERTED');
      await refusedBy((r) => r.execute(sql`DELETE FROM recalibration_decisions WHERE run_id = ${id}::uuid`), /append-only/);
    });
  });
});

describe('proposal validation', () => {
  it('refuses anything per-learner riding along, inconsistent counts, and an inadmissible BKT fit', async () => {
    const runId = randomUUID();
    const item = randomUUID();
    const good = itemProposal(runId, 'a'.repeat(64), [{ itemId: item, difficulty: 0.9 }], { [item]: 'DRIFTED' });
    expect(parseRecalibrationProposal(good).report.verdict).toBe('DRIFTED');

    const withLearner = structuredClone(good) as { report: { units: Record<string, unknown>[] } };
    withLearner.report.units[0]!.learner = 'L1';
    expect(() => parseRecalibrationProposal(withLearner)).toThrow(/unexpected field "learner"/);

    const wrongCount = structuredClone(good) as { report: { counts: Record<string, number> } };
    wrongCount.report.counts.DRIFTED = 0;
    expect(() => parseRecalibrationProposal(wrongCount)).toThrow(/must match the units/);

    const wrongVerdict = structuredClone(good) as { report: { verdict: string } };
    wrongVerdict.report.verdict = 'STABLE';
    expect(() => parseRecalibrationProposal(wrongVerdict)).toThrow(/verdict/);

    const extra = { ...good, readiness: 'x' };
    expect(() => parseRecalibrationProposal(extra)).toThrow(/unexpected field "readiness"/);

    const skill = randomUUID();
    const inadmissible = bktProposal(randomUUID(), 'b'.repeat(64), [{ skillId: skill, fitted: true, parameters: { ...FIT, pInit: 0.05 } }]);
    expect(() => parseRecalibrationProposal(inadmissible)).toThrow(/fixed point/);
    const smallCount = structuredClone(bktProposal(randomUUID(), 'b'.repeat(64), [{ skillId: skill, fitted: true }])) as { report: { units: Record<string, unknown>[] } };
    smallCount.report.units[0]!.learners = 3;
    expect(() => parseRecalibrationProposal(smallCount)).toThrow(/learners/);
  });
});

describe('item recalibration', () => {
  it('exports the live calibrations as the baseline, exactly as the placement reader chooses them', async () => {
    await inRollback(async (tx) => {
      await liveModelImprovement(tx);
      const { a, b, fresh, firstRun } = await calibratedBank(tx);
      const { export: exported, baseline } = await exportItemRecalibration(tx);
      expect(baseline.runId).toBe(exported.runId);
      expect(baseline.previousRunId).toBe(firstRun);
      const mine = baseline.items!.filter((row) => [a, b, fresh].includes(row.itemId));
      expect(mine.map((row) => row.itemId).sort()).toEqual([a, b].sort());
      const live = await latestItemCalibrations(tx, mine.map((row) => ({ itemSource: row.itemSource, itemId: row.itemId, itemVersion: row.itemVersion })));
      for (const row of mine) {
        const reader = live.get(key(row.itemId))!;
        expect([row.runId, row.status, row.difficulty, row.discrimination]).toEqual([reader.runId, reader.status, reader.difficulty, reader.discrimination]);
      }
      expect(baseline.baselineDigest).toBe(itemBaselineDigest(await liveItemCalibrationRows(tx)));
      expect(JSON.stringify(baseline)).not.toMatch(/@example\.test|"L[1-9]/);
    });
  });

  it('records a proposal without changing live parameters, and imports it only on accept', async () => {
    await inRollback(async (tx) => {
      const { a, b, fresh, firstRun } = await calibratedBank(tx);
      const digest = itemBaselineDigest(await liveItemCalibrationRows(tx));
      const runId = randomUUID();
      const proposal = itemProposal(runId, digest, [{ itemId: a, difficulty: 0.9 }, { itemId: b, difficulty: -0.45 }, { itemId: fresh, difficulty: 1.5 }],
        { [a]: 'DRIFTED', [b]: 'STABLE' }, firstRun);
      const recorded = await recordRecalibrationProposal(tx, proposal);
      expect(recorded).toMatchObject({ runId, kind: 'ITEM_2PL', recorded: true, verdict: 'DRIFTED' });
      expect((await recordRecalibrationProposal(tx, proposal)).recorded).toBe(false);

      const keys = [a, b, fresh].map((itemId) => ({ itemSource: 'CAREER_READINESS_QUESTION' as const, itemId, itemVersion: 1 }));
      const before = await latestItemCalibrations(tx, keys);
      expect(before.get(key(a))!.runId).toBe(firstRun);
      expect(before.has(key(fresh))).toBe(false);
      expect((await listRecalibrationRuns(tx, 5)).find((run) => run.id === runId)).toMatchObject({ state: 'PENDING', unitsCompared: 2, unitsDrifted: 1 });

      const outcome = await decideRecalibration(tx, { runId, decision: 'ACCEPTED', reason: 'Item a was reworded; drift expected.' });
      expect(outcome).toMatchObject({ decision: 'ACCEPTED', itemRunId: runId, imported: { calibrated: 3, provisional: 0 } });
      const after = await latestItemCalibrations(tx, keys);
      expect(after.get(key(a))).toMatchObject({ runId, difficulty: 0.9 });
      expect(after.get(key(fresh))).toMatchObject({ runId, difficulty: 1.5 });
      await refused(decideRecalibration(tx, { runId, decision: 'REJECTED', reason: 'again' }), 'ALREADY_DECIDED');
    });
  });

  it('refuses to accept a proposal compared against a live state that has since changed', async () => {
    await inRollback(async (tx) => {
      const { a, b } = await calibratedBank(tx);
      const digest = itemBaselineDigest(await liveItemCalibrationRows(tx));
      const first = randomUUID();
      const second = randomUUID();
      await recordRecalibrationProposal(tx, itemProposal(first, digest, [{ itemId: a, difficulty: 0.2 }], { [a]: 'STABLE' }));
      await recordRecalibrationProposal(tx, itemProposal(second, digest, [{ itemId: b, difficulty: -0.4 }], { [b]: 'STABLE' }));
      await decideRecalibration(tx, { runId: first, decision: 'ACCEPTED', reason: 'stable' });
      await refused(decideRecalibration(tx, { runId: second, decision: 'ACCEPTED', reason: 'stable' }), 'STALE');
      await decideRecalibration(tx, { runId: second, decision: 'REJECTED', reason: 'superseded by an accepted run' });
      const run = await loadRecalibrationRun(tx, second);
      expect(run!.decisions.map((d) => d.decision)).toEqual(['REJECTED']);
      await refused(decideRecalibration(tx, { runId: randomUUID(), decision: 'ACCEPTED', reason: 'x' }), 'NOT_FOUND');
      await refused(decideRecalibration(tx, { runId: first, decision: 'ACCEPTED', reason: '   ' }), 'INVALID');
    });
  });

  it('reverts an accepted run by restoring the parameters live before it', async () => {
    await inRollback(async (tx) => {
      const { a, b, fresh, firstRun } = await calibratedBank(tx);
      // `fresh` had only a provisional row before: a revert cannot take its calibration away.
      await importCalibrationResults(tx, itemResults(randomUUID(), [{ itemId: fresh, difficulty: 0.0, status: 'PROVISIONAL', responsesUsed: 1 }],
        new Date(Date.now() - 1_800_000).toISOString()));
      const runId = randomUUID();
      await recordRecalibrationProposal(tx, itemProposal(runId, itemBaselineDigest(await liveItemCalibrationRows(tx)),
        [{ itemId: a, difficulty: 0.9 }, { itemId: fresh, difficulty: 1.5 }], { [a]: 'DRIFTED' }));
      await refused(revertRecalibration(tx, { runId, reason: 'not accepted yet' }), 'NOT_ACCEPTED');
      await decideRecalibration(tx, { runId, decision: 'ACCEPTED', reason: 'reviewed' });

      const outcome = await revertRecalibration(tx, { runId, reason: 'placement looked wrong after the import' });
      expect(outcome).toMatchObject({ decision: 'REVERTED', restored: 1, notRestorable: 1 });
      const keys = [a, b, fresh].map((itemId) => ({ itemSource: 'CAREER_READINESS_QUESTION' as const, itemId, itemVersion: 1 }));
      const live = await latestItemCalibrations(tx, keys);
      expect(live.get(key(a))).toMatchObject({ runId: outcome.itemRunId, difficulty: 0.1, status: 'CALIBRATED' });
      expect(live.get(key(b))).toMatchObject({ runId: firstRun, difficulty: -0.5 });
      expect(live.get(key(fresh))!.runId).toBe(runId); // first calibrated by the reverted run: stays (see design)
      await refused(revertRecalibration(tx, { runId, reason: 'twice' }), 'ALREADY_DECIDED');
    });
  });
});

describe('BKT refit', () => {
  it('exports consenting learners\' observation sequences with no learner key, and the defaults as the baseline', async () => {
    await inRollback(async (tx) => {
      await liveModelImprovement(tx);
      const skill = await topic(tx);
      const granted = await learner(tx);
      const never = await learner(tx, 'NONE');
      await attempt(tx, granted, randomUUID(), false, { skillId: skill, minutesAgo: 30 });
      await attempt(tx, granted, randomUUID(), true, { skillId: skill, minutesAgo: 20 });
      await attempt(tx, granted, randomUUID(), true, { skillId: skill, minutesAgo: 15, assisted: true });
      await attempt(tx, granted, randomUUID(), true, { skillId: skill, minutesAgo: 10 });
      await attempt(tx, never, randomUUID(), true, { skillId: skill, minutesAgo: 10 });

      const { export: exported, baseline } = await exportBktRefit(tx);
      expect(exported.sequences.filter(([id]) => id === skill)).toEqual([[skill, '011']]);
      const text = JSON.stringify(exported);
      for (const id of [granted, never]) expect(text).not.toContain(id);
      expect(text).not.toContain('@');
      expect(baseline).toMatchObject({ kind: 'BKT', runId: exported.runId, previousRunId: null, skills: [], baselineDigest: bktBaselineDigest(null) });
    });
  });

  it('records the accepted fit for ENG-27 without touching anything live, and reverts to the previous fit', async () => {
    await inRollback(async (tx) => {
      const [first, second] = [randomUUID(), randomUUID()];
      const [skillA, skillB] = [randomUUID(), randomUUID()];
      const before = await acceptedBktParameters(tx);
      const digest0 = bktBaselineDigest(null);
      // Only meaningful when no other accepted BKT run exists in this database, which the rollback guarantees.
      expect(before.size).toBe(0);
      const skillStateBefore = await tx.execute(sql`SELECT count(*)::int AS n FROM learner_skill_state`) as unknown as { rows: { n: number }[] };

      await recordRecalibrationProposal(tx, bktProposal(first, digest0, [{ skillId: skillA, fitted: true }, { skillId: skillB, fitted: false }]));
      expect((await acceptedBktParameters(tx)).size).toBe(0);
      await decideRecalibration(tx, { runId: first, decision: 'ACCEPTED', reason: 'first fit' });
      const accepted = await acceptedBktParameters(tx);
      expect([...accepted.keys()]).toEqual([skillA]);
      expect(accepted.get(skillA)).toEqual({ ...FIT, source: 'FITTED', fitRunId: first });

      await recordRecalibrationProposal(tx, bktProposal(second, bktBaselineDigest(first), [{ skillId: skillA, fitted: true, parameters: { ...FIT, pGuess: 0.25 } }], first));
      await decideRecalibration(tx, { runId: second, decision: 'ACCEPTED', reason: 'second fit' });
      expect(accepted.get(skillA)!.pGuess).toBe(0.22);
      expect((await acceptedBktParameters(tx)).get(skillA)!.pGuess).toBe(0.25);

      await revertRecalibration(tx, { runId: second, reason: 'prefer the first fit' });
      expect((await acceptedBktParameters(tx)).get(skillA)).toEqual({ ...FIT, source: 'FITTED', fitRunId: first });
      const skillStateAfter = await tx.execute(sql`SELECT count(*)::int AS n FROM learner_skill_state`) as unknown as { rows: { n: number }[] };
      expect(skillStateAfter.rows[0]!.n).toBe(skillStateBefore.rows[0]!.n);
      const decisions = await tx.execute(sql`SELECT item_run_id FROM recalibration_decisions WHERE run_id IN (${first}::uuid, ${second}::uuid)`) as unknown as { rows: { item_run_id: string | null }[] };
      expect(decisions.rows.every((row) => row.item_run_id === null)).toBe(true);
    });
  });
});

describe('the markdown report', () => {
  it('says what drifted and what a decision does, with no person and no readiness value', async () => {
    await inRollback(async (tx) => {
      const { a, b } = await calibratedBank(tx);
      const runId = randomUUID();
      await recordRecalibrationProposal(tx, itemProposal(runId, itemBaselineDigest(await liveItemCalibrationRows(tx)),
        [{ itemId: a, difficulty: 0.9 }, { itemId: b, difficulty: -0.45 }], { [a]: 'DRIFTED', [b]: 'STABLE' }));
      const markdown = renderRecalibrationMarkdown((await loadRecalibrationRun(tx, runId))!);
      expect(markdown).toContain(`# Item recalibration (2PL) — run ${runId}`);
      expect(markdown).toContain('- **State:** PENDING');
      expect(markdown).toContain('- **Verdict:** DRIFTED');
      expect(markdown).toContain(`| ${key(a)} | difficulty | 0.1000 | 0.9000 | 0.8000 | 0.3500 | absolute |`);
      expect(markdown).not.toContain(`| ${key(b)} | difficulty`);
      expect(markdown).toContain('**Accept** imports');
      expect(markdown).not.toMatch(/@|\bL[1-9][0-9]*\b/);
      // "readiness" appears only as the question bank's name, never beside a number.
      expect(markdown.replaceAll('CAREER_READINESS_QUESTION', '')).not.toMatch(/readiness[^.\n]*\d/i);
    });
  });
});
