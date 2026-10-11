/**
 * `ai:bake-off-import` — record a bake-off results file from the pod as `ai_evaluations` rows
 * (ENG-21), one per feature, as the operator named by AI_EVALUATION_RECORDER_USER_ID (who must hold
 * AI_OPS_CONFIGURE). Re-scores the raw replies with the repository's code; refuses results that do
 * not match this repository's evaluation set; a PASS on tutor.hint or content.lesson-draft needs a
 * filled review sheet. Never switches a feature on. Prints decisions and failing metric names only.
 *
 * Usage:
 *   DATABASE_URL=… AI_EVALUATION_RECORDER_USER_ID=<uuid> corepack pnpm --filter @planthepath/persistence \
 *     ai:bake-off-import --results <file> [--review <sheet>] [--reason INITIAL_BENCHMARK] [--decision FAIL]
 *     [--feature tutor.hint ...] [--dry-run] [cost options: --hints-per-student, --utilisation, --inr-per-usd, …]
 *
 * Design: docs/architecture/ai-bake-off-design.md
 */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { costAssumptionsFromArgv, optionValue } from '@planthepath/ai-evaluation/src/index.js';
import { BakeOffImportError, importBakeOffResults } from './ai-bake-off.js';
import type { SqlRunner } from './ai-operations.js';

const argv = process.argv.slice(2);
const resultsPath = optionValue(argv, '--results');
if (!resultsPath) throw new Error('usage: ai:bake-off-import --results <file> [--review <sheet>] [--reason <code>] [--decision FAIL] [--feature <key> ...] [--dry-run]');
const reviewPath = optionValue(argv, '--review');
const decision = optionValue(argv, '--decision');
if (decision !== undefined && decision !== 'FAIL') throw new Error('--decision accepts only FAIL; a PASS comes from the thresholds');
const onlyFeatures = argv.flatMap((value, index) => (value === '--feature' && argv[index + 1] ? [argv[index + 1]!] : []));
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const recorderUserId = process.env.AI_EVALUATION_RECORDER_USER_ID?.trim() ?? '';

const pool = new Pool({ connectionString: databaseUrl });
try {
  const db = drizzle(pool) as unknown as SqlRunner & { transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> };
  const outcome = await importBakeOffResults(db, {
    resultsText: await readFile(resultsPath, 'utf8'),
    reviewText: reviewPath ? await readFile(reviewPath, 'utf8') : undefined,
    recorderUserId,
    reasonCode: optionValue(argv, '--reason'),
    decision: decision === 'FAIL' ? 'FAIL' : 'AUTO',
    onlyFeatures,
    cost: costAssumptionsFromArgv(argv),
    dryRun: argv.includes('--dry-run'),
  });
  console.log(JSON.stringify({
    event: outcome.dryRun ? 'ai.bake_off.import.planned' : 'ai.bake_off.imported',
    resultsSha256: outcome.resultsSha256,
    costPerStudentInr: outcome.scorecard.cost.inrPerStudentMonth,
    evaluations: outcome.evaluations,
  }));
} catch (error) {
  if (error instanceof BakeOffImportError) {
    console.error(JSON.stringify({ event: 'ai.bake_off.import.refused', code: error.code, detail: error.detail }));
    process.exitCode = 1;
  } else {
    // The class only: a driver message can carry a connection string.
    console.error(JSON.stringify({ event: 'ai.bake_off.import.failed', failureClass: error instanceof Error ? error.name : 'UnknownError' }));
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
