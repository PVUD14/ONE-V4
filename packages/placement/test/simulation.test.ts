/**
 * Acceptance C2 for ENG-14, in simulation: every sitting ends within 25 items and 25 minutes, and a
 * retest (on different items) agrees within one level for at least 80% of synthetic learners — with
 * true item parameters, with noisy calibrations, with provisional-only calibrations, and with slow
 * students for whom the time limit is what ends the test. Synthetic learners and items only.
 */
import { describe, expect, it } from 'vitest';
import { PLACEMENT_RULES } from '../src/index.js';
import { calibratedView, runPlacementSimulation, syntheticPool, type CalibrationScenario } from '../src/simulation.js';

const LEARNERS = 400;
const SEED = 20260928;

describe('C2 in simulation', () => {
  const runs: { scenario: CalibrationScenario; medianResponseMs: number }[] = [
    { scenario: 'TRUE_PARAMETERS', medianResponseMs: 40_000 },
    { scenario: 'NOISY_CALIBRATION', medianResponseMs: 40_000 },
    { scenario: 'PROVISIONAL_ONLY', medianResponseMs: 40_000 },
    { scenario: 'NOISY_CALIBRATION', medianResponseMs: 75_000 },
  ];

  for (const { scenario, medianResponseMs } of runs) {
    it(`${scenario} at a median of ${medianResponseMs / 1000} s a question`, () => {
      const report = runPlacementSimulation({ learners: LEARNERS, poolSize: 300, seed: SEED, scenario, medianResponseMs });
      expect(report.maxItems).toBeLessThanOrEqual(PLACEMENT_RULES.maxItems);
      expect(report.maxDurationMinutes).toBeLessThanOrEqual(25);
      expect(report.withinOneAgreement).toBeGreaterThanOrEqual(0.8);
      expect(report.retestWithoutRepeats).toBe(1);
      if (medianResponseMs > 60_000) expect(report.stopReasons.TIME_LIMIT).toBeGreaterThan(0);
    }, 120_000);
  }

  it('a seed always gives the same report', () => {
    const a = runPlacementSimulation({ learners: 40, poolSize: 120, seed: 7, scenario: 'NOISY_CALIBRATION' });
    const b = runPlacementSimulation({ learners: 40, poolSize: 120, seed: 7, scenario: 'NOISY_CALIBRATION' });
    expect(b).toEqual(a);
  });

  it('keeps every synthetic parameter inside the calibration bounds', () => {
    const truth = syntheticPool(300, SEED);
    for (const scenario of ['TRUE_PARAMETERS', 'NOISY_CALIBRATION', 'PROVISIONAL_ONLY'] as const) {
      for (const item of calibratedView(truth, scenario, SEED + 1)) {
        expect(item.difficulty).toBeGreaterThanOrEqual(-4);
        expect(item.difficulty).toBeLessThanOrEqual(4);
        expect(item.discrimination).toBeGreaterThanOrEqual(0.2);
        expect(item.discrimination).toBeLessThanOrEqual(4);
      }
    }
  });
});
