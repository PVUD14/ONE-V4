/**
 * Unit tests for the BKT shadow report's aggregation (ENG-06): counts only, small cells suppressed,
 * rates only over five or more students, and no identifier anywhere in the output.
 */
import { describe, expect, it } from 'vitest';
import { buildShadowReport, suppressCount, type ShadowPair, type ShadowPrediction, type ShadowReportInput } from '../src/index.js';

const algorithms = {
  liveAlgorithm: 'career-readiness-mastery-v1',
  engineBandAlgorithm: 'learning-model-v1',
  projectorAlgorithm: 'learner-skill-state-v2',
};

function pair(index: number, overrides: Partial<ShadowPair> = {}): ShadowPair {
  return {
    subjectKey: `subject-${index}`,
    liveBand: 'PROGRESSING',
    engineBand: 'PROGRESSING',
    bktBand: 'PROGRESSING',
    staleProjector: false,
    ...overrides,
  };
}

function input(overrides: Partial<ShadowReportInput> = {}): ShadowReportInput {
  return { studentsInScope: 10, pairs: [], predictions: [], ...algorithms, ...overrides };
}

describe('suppression', () => {
  it('prints 0 and 5 or more exactly, and 1 to 4 as "<5"', () => {
    expect([0, 1, 2, 3, 4, 5, 17].map(suppressCount)).toEqual([0, '<5', '<5', '<5', '<5', 5, 17]);
  });

  it('suppresses everything but the header when fewer than five students are in scope', () => {
    const report = buildShadowReport(input({ studentsInScope: 4, pairs: [pair(1)] }));
    expect(report.suppressed).toBe(true);
    expect(report.coverage).toBeUndefined();
    expect(report.bkt).toBeUndefined();
    expect(report.c3Adoption).toBeUndefined();
    expect(report.nextAttemptPrediction).toBeUndefined();
    expect(report.algorithms.shadow).toBe('mastery-bkt-v1');
    expect(report.parameters.source).toBe('DEFAULT_PROVISIONAL');
  });
});

describe('band comparison', () => {
  // Six students: DEVELOPING live → DEMONSTRATED under BKT; two students unchanged; one live
  // band with no engine row; one engine row on the older projector.
  const pairs: ShadowPair[] = [
    ...[1, 2, 3, 4, 5, 6].map((index) => pair(index, { liveBand: 'DEVELOPING', engineBand: 'NOT_ENOUGH_EVIDENCE', bktBand: 'DEMONSTRATED' })),
    pair(7),
    pair(8),
    pair(9, { engineBand: null, bktBand: null }),
    pair(10, { bktBand: null, staleProjector: true }),
  ];
  const report = buildShadowReport(input({ pairs }));

  it('counts how many pairs and students would change under BKT, with the from→to matrix', () => {
    expect(report.bkt).toMatchObject({
      pairsCompared: 8, unchanged: '<5', changed: 6, movedUp: 6, movedDown: 0,
      becameNotEnoughEvidence: 0, leftNotEnoughEvidence: 0, studentsWithAnyChange: 6,
    });
    expect(report.bkt!.matrix['DEVELOPING->DEMONSTRATED']).toBe(6);
    expect(report.bkt!.matrix['PROGRESSING->PROGRESSING']).toBe('<5');
    expect(Object.keys(report.bkt!.matrix)).toHaveLength(16);
  });

  it('counts C3 adoption separately, from the engine band', () => {
    expect(report.c3Adoption).toMatchObject({
      pairsCompared: 9, changed: 6, becameNotEnoughEvidence: 6, movedUp: 0, studentsWithAnyChange: 6,
    });
    expect(report.c3Adoption!.matrix['DEVELOPING->NOT_ENOUGH_EVIDENCE']).toBe(6);
  });

  it('reports coverage, including rows that need a rebuild', () => {
    expect(report.coverage).toEqual({
      studentsInScope: 10, pairsWithBothBands: 9, livePairsWithoutEngineRow: '<5',
      engineRowsWithoutLiveBand: 0, engineRowsOnOlderProjector: '<5',
    });
  });

  it('never prints a subject key or any identifier', () => {
    expect(JSON.stringify(report)).not.toMatch(/subject-/);
  });
});

describe('next-attempt prediction', () => {
  function predictions(students: number, perStudent: number): ShadowPrediction[] {
    return Array.from({ length: students * perStudent }, (_, index) => ({
      subjectKey: `subject-${index % students}`,
      predicted: 0.9,
      correct: index % 10 !== 0,
    }));
  }

  it('gives Brier score, accuracy and calibration over five or more students', () => {
    const summary = buildShadowReport(input({ predictions: predictions(5, 2) })).nextAttemptPrediction!;
    expect(summary.predictions).toBe(10);
    expect(summary.students).toBe(5);
    // 9 correct at 0.9 → 0.01 each; 1 wrong at 0.9 → 0.81. Mean 0.09.
    expect(summary.brierScore).toBeCloseTo(0.09, 10);
    expect(summary.accuracyAtHalf).toBe(0.9);
    expect(summary.calibration.find((bin) => bin.range === '0.8-1.0')).toEqual({
      range: '0.8-1.0', predictions: 10, observedCorrect: 9, observedRate: 0.9,
    });
  });

  it('suppresses the rates when fewer than five students produced the predictions', () => {
    const summary = buildShadowReport(input({ predictions: predictions(4, 5) })).nextAttemptPrediction!;
    expect(summary.predictions).toBe(20);
    expect(summary.students).toBe('<5');
    expect(summary.brierScore).toBe('suppressed');
    expect(summary.accuracyAtHalf).toBe('suppressed');
    expect(summary.calibration.every((bin) => bin.observedRate === 'suppressed')).toBe(true);
  });
});
