/**
 * `bake-off:report --results <file> [--review <sheet>] [--out <report.md>] [cost options]` — score a
 * results file from the pod and write the per-model bake-off report (ENG-21). Touches no database
 * and records nothing; `ai:bake-off-import` records. Prints each feature's decision and failing
 * metrics, never reply text.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderReport } from '../report.js';
import { evaluateResultsText } from '../repository.js';
import { costAssumptionsFromArgv, optionValue } from './options.js';

const argv = process.argv.slice(2);
const resultsPath = optionValue(argv, '--results');
if (!resultsPath) throw new Error('usage: bake-off:report --results <file> [--review <sheet>] [--out <report.md>] [cost options]');
const reviewPath = optionValue(argv, '--review');
const outPath = optionValue(argv, '--out');
const run = evaluateResultsText({
  resultsText: readFileSync(resultsPath, 'utf8'),
  reviewText: reviewPath ? readFileSync(reviewPath, 'utf8') : undefined,
  cost: costAssumptionsFromArgv(argv),
});
const report = renderReport(run.scorecard, { resultsSha256: run.resultsSha256, startedAt: run.results.startedAt, reviewed: run.reviewed });
if (outPath) {
  writeFileSync(outPath, report, 'utf8');
  writeFileSync(outPath.replace(/\.md$/u, '') + '.json', `${JSON.stringify(run.scorecard, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({
  event: 'ai.bake_off.report',
  model: run.scorecard.model,
  costPerStudentInr: run.scorecard.cost.inrPerStudentMonth,
  features: run.scorecard.features.map((feature) => ({ featureKey: feature.featureKey, decision: feature.decision, failed: feature.failedMetrics, missingHuman: feature.missingHumanMetrics })),
}));
