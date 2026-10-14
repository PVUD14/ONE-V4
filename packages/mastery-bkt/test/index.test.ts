/**
 * Unit tests for mastery-bkt-v1 (ENG-06): the update rule against hand-computed values, the cited
 * defaults and their admissibility, the stored form (rounding, uncertainty, version) and the
 * report-only shadow band.
 */
import { describe, expect, it } from 'vitest';
import {
  BKT_SHADOW_BAND_THRESHOLDS,
  DEFAULT_BKT_PARAMETERS,
  MASTERY_BKT_ALGORITHM_ID,
  MasteryBktError,
  binaryEntropy,
  estimateMastery,
  masteryAlgorithmVersion,
  posteriorKnown,
  predictCorrect,
  resolveParameters,
  roundToStored,
  shadowBand,
  traceMastery,
  updateKnown,
  validateParameters,
  wrongAnswerFixedPoint,
  type BktParameters,
} from '../src/index.js';

const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 12);

describe('mastery-bkt-v1 defaults', () => {
  it('uses the cited Van de Sande (2013) parameter set, marked provisional', () => {
    expect(MASTERY_BKT_ALGORITHM_ID).toBe('mastery-bkt-v1');
    expect(DEFAULT_BKT_PARAMETERS).toEqual({ pInit: 0.36, pLearn: 0.1, pGuess: 0.3, pSlip: 0.05, source: 'DEFAULT_PROVISIONAL' });
    expect(Object.isFrozen(DEFAULT_BKT_PARAMETERS)).toBe(true);
    expect(() => validateParameters(DEFAULT_BKT_PARAMETERS)).not.toThrow();
  });

  it('keeps the prior above the wrong-answer fixed point (eq. 14), so a first wrong answer lowers mastery', () => {
    close(wrongAnswerFixedPoint(DEFAULT_BKT_PARAMETERS), (0.7 * 0.1) / 0.65);
    expect(DEFAULT_BKT_PARAMETERS.pInit).toBeGreaterThan(wrongAnswerFixedPoint(DEFAULT_BKT_PARAMETERS));
    expect(traceMastery([false]).path[0]).toBeLessThan(DEFAULT_BKT_PARAMETERS.pInit);
  });

  it('rejects the hmm-scalable starting values, under which a first wrong answer would raise mastery', () => {
    const hmmScalable: BktParameters = { pInit: 0.5, pLearn: 0.4, pGuess: 0.2, pSlip: 0.2, source: 'DEFAULT_PROVISIONAL' };
    expect(updateKnown(0.5, false, hmmScalable)).toBeGreaterThan(0.5);
    expect(() => validateParameters(hmmScalable)).toThrow(MasteryBktError);
  });
});

describe('the knowledge-tracing step', () => {
  const p = DEFAULT_BKT_PARAMETERS;

  it('matches the hand-computed recursion (Baker et al. 2008; Van de Sande 2013 eqs. 8–10)', () => {
    // Correct from the prior: 0.36*0.95 / (0.36*0.95 + 0.64*0.3) = 0.342 / 0.534
    close(posteriorKnown(0.36, true, p), 0.342 / 0.534);
    // Wrong from the prior: 0.36*0.05 / (0.36*0.05 + 0.64*0.7) = 0.018 / 0.466
    close(posteriorKnown(0.36, false, p), 0.018 / 0.466);
    const afterCorrect = 0.342 / 0.534;
    close(updateKnown(0.36, true, p), afterCorrect + (1 - afterCorrect) * 0.1);
    close(predictCorrect(0.36, p), 0.36 * 0.95 + 0.64 * 0.3);
  });

  it('records a prediction before every observation after the first', () => {
    const trace = traceMastery([true, false, true]);
    expect(trace.observations).toBe(3);
    expect(trace.path).toHaveLength(3);
    expect(trace.predictions.map((prediction) => prediction.correct)).toEqual([false, true]);
    close(trace.predictions[0]!.predicted, predictCorrect(trace.path[0]!, p));
    close(trace.predictions[1]!.predicted, predictCorrect(trace.path[1]!, p));
  });

  it('refuses a probability outside [0, 1]', () => {
    expect(() => predictCorrect(1.2, p)).toThrow(MasteryBktError);
    expect(() => posteriorKnown(Number.NaN, true, p)).toThrow(MasteryBktError);
  });
});

describe('the stored estimate', () => {
  it('is null when nothing has been observed — a prior is not a measurement of the student', () => {
    expect(estimateMastery([])).toBeNull();
  });

  it('rounds to four decimals, stamps the algorithm, and reports entropy as uncertainty', () => {
    const estimate = estimateMastery([true, true]);
    const exact = traceMastery([true, true]).path[1]!;
    expect(estimate).toEqual({
      likelihood: roundToStored(exact),
      uncertainty: roundToStored(binaryEntropy(exact)),
      algorithmVersion: 'mastery-bkt-v1',
    });
    expect(roundToStored(estimate!.likelihood)).toBe(estimate!.likelihood);
  });

  it('measures uncertainty as binary entropy: 1 at one half, 0 at certainty', () => {
    expect(binaryEntropy(0.5)).toBe(1);
    expect(binaryEntropy(0)).toBe(0);
    expect(binaryEntropy(1)).toBe(0);
    close(binaryEntropy(0.25), binaryEntropy(0.75));
  });

  it('rounds half away from zero', () => {
    expect(roundToStored(0.12345)).toBe(0.1235);
    expect(roundToStored(0.99996)).toBe(1);
    expect(roundToStored(0)).toBe(0);
  });
});

describe('per-skill parameters', () => {
  const fitted: BktParameters = { pInit: 0.3, pLearn: 0.15, pGuess: 0.25, pSlip: 0.08, source: 'FITTED', fitRunId: 'fit-2026-10-01' };

  it('uses the defaults for every skill when no fit is supplied', () => {
    expect(resolveParameters('skill-a')).toBe(DEFAULT_BKT_PARAMETERS);
    expect(resolveParameters('skill-a', new Map())).toBe(DEFAULT_BKT_PARAMETERS);
  });

  it('accepts an override only from a fit, and stamps the fit run on the version', () => {
    expect(resolveParameters('skill-a', new Map([['skill-a', fitted]]))).toBe(fitted);
    expect(masteryAlgorithmVersion(fitted)).toBe('mastery-bkt-v1+fit:fit-2026-10-01');
    expect(masteryAlgorithmVersion(fitted).length).toBeLessThanOrEqual(64);
    const handTuned: BktParameters = { ...fitted, source: 'DEFAULT_PROVISIONAL' };
    expect(() => resolveParameters('skill-a', new Map([['skill-a', handTuned]]))).toThrow(MasteryBktError);
    const { fitRunId: _omitted, ...unnamed } = fitted;
    expect(() => validateParameters(unnamed)).toThrow(MasteryBktError);
  });

  it('rejects degenerate or out-of-bounds parameter sets', () => {
    const base = DEFAULT_BKT_PARAMETERS;
    expect(() => validateParameters({ ...base, pGuess: 0 })).toThrow(MasteryBktError);
    expect(() => validateParameters({ ...base, pSlip: 1 })).toThrow(MasteryBktError);
    expect(() => validateParameters({ ...base, pGuess: 0.55 })).toThrow(MasteryBktError);
    // Eq. 16: T < 1 − S/(1 − G) = 1 − 0.05/0.7 ≈ 0.9286
    expect(() => validateParameters({ ...base, pLearn: 0.95 })).toThrow(MasteryBktError);
    expect(() => validateParameters({ ...base, pInit: 0.1 })).toThrow(MasteryBktError);
  });
});

describe('the shadow band (report only)', () => {
  it('is NOT_ENOUGH_EVIDENCE without an estimate or with fewer than two attempt days (C3)', () => {
    expect(shadowBand(null, 5)).toBe('NOT_ENOUGH_EVIDENCE');
    expect(shadowBand(0.99, 1)).toBe('NOT_ENOUGH_EVIDENCE');
    expect(shadowBand(0.99, 0)).toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('bands at the 0.95 mastery criterion and at one half', () => {
    expect(BKT_SHADOW_BAND_THRESHOLDS).toEqual({ demonstrated: 0.95, progressing: 0.5 });
    expect(shadowBand(0.95, 2)).toBe('DEMONSTRATED');
    expect(shadowBand(0.9499, 2)).toBe('PROGRESSING');
    expect(shadowBand(0.5, 2)).toBe('PROGRESSING');
    expect(shadowBand(0.4999, 2)).toBe('DEVELOPING');
  });
});
