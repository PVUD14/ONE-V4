/**
 * `corepack pnpm --filter @planthepath/placement simulate [learners] [seed]` — prints the C2
 * simulation report (ENG-14) for each calibration scenario as JSON, and exits non-zero if any
 * scenario misses C2. Synthetic learners and items only; needs no database.
 */
import { PLACEMENT_RULES } from './index.js';
import { runPlacementSimulation, type CalibrationScenario } from './simulation.js';

const learners = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 20260928);
if (!Number.isInteger(learners) || learners < 1 || !Number.isInteger(seed)) {
  console.error('usage: simulate [learners] [seed]');
  process.exit(2);
}
// The three calibration scenarios at a typical pace, and noisy calibrations with slow students
// (median 75 s a question), where the 25-minute limit is what ends many tests.
const runs: { scenario: CalibrationScenario; medianResponseMs: number }[] = [
  { scenario: 'TRUE_PARAMETERS', medianResponseMs: 40_000 },
  { scenario: 'NOISY_CALIBRATION', medianResponseMs: 40_000 },
  { scenario: 'PROVISIONAL_ONLY', medianResponseMs: 40_000 },
  { scenario: 'NOISY_CALIBRATION', medianResponseMs: 75_000 },
];
let failed = false;
for (const { scenario, medianResponseMs } of runs) {
  const report = runPlacementSimulation({ learners, poolSize: 300, seed, scenario, medianResponseMs });
  const passes = report.maxItems <= PLACEMENT_RULES.maxItems
    && report.maxDurationMinutes <= PLACEMENT_RULES.timeLimitMs / 60_000
    && report.withinOneAgreement >= 0.8;
  if (!passes) failed = true;
  console.log(JSON.stringify({ ...report, c2: passes ? 'PASS' : 'FAIL' }));
}
process.exit(failed ? 1 : 0);
