/**
 * Property tests for mastery-bkt-v1 (ENG-06 acceptance: mastery rises on correct, falls on wrong,
 * stays within bounds), over random histories and random admissible parameter sets. Histories
 * come from a seeded generator, so a failure reproduces exactly; no new dependency is needed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BKT_PARAMETERS,
  estimateMastery,
  posteriorKnown,
  traceMastery,
  updateKnown,
  validateParameters,
  wrongAnswerFixedPoint,
  type BktParameters,
} from '../src/index.js';

const RUNS = 500;

/** Mulberry32: small, seeded, deterministic. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomHistory(next: () => number, maxLength = 40): boolean[] {
  const length = Math.floor(next() * maxLength);
  const skill = next();
  return Array.from({ length }, () => next() < skill);
}

/** A random parameter set that passes validation (rejection sampling). */
function randomAdmissible(next: () => number): BktParameters {
  for (;;) {
    const candidate: BktParameters = {
      pInit: 0.01 + next() * 0.98,
      pLearn: 0.01 + next() * 0.5,
      pGuess: 0.01 + next() * 0.45,
      pSlip: 0.01 + next() * 0.45,
      source: 'DEFAULT_PROVISIONAL',
    };
    try {
      validateParameters(candidate);
      return candidate;
    } catch {
      // try again
    }
  }
}

function withParameters(next: () => number): BktParameters[] {
  return [DEFAULT_BKT_PARAMETERS, randomAdmissible(next)];
}

describe('mastery-bkt-v1 properties', () => {
  it('rises on every correct answer and falls on every wrong answer, on every reachable history', () => {
    const next = generator(11);
    for (let run = 0; run < RUNS; run += 1) {
      for (const parameters of withParameters(next)) {
        const history = randomHistory(next);
        const floor = wrongAnswerFixedPoint(parameters);
        let previous = parameters.pInit;
        const { path } = traceMastery(history, parameters);
        history.forEach((correct, index) => {
          const current = path[index]!;
          // Strict in exact arithmetic; in floating point a value can saturate at 1 after a long
          // run of correct answers, or settle onto the fixed point after a long run of wrong ones.
          const representable = previous < 1 && previous - floor > 1e-9;
          if (correct) {
            expect(current).toBeGreaterThanOrEqual(previous);
            if (previous < 1) expect(current).toBeGreaterThan(previous);
          } else {
            expect(current).toBeLessThanOrEqual(previous);
            if (representable) expect(current).toBeLessThan(previous);
          }
          previous = current;
        });
      }
    }
  });

  it('moves the evidence step toward the observation from any state strictly inside (0, 1)', () => {
    const next = generator(17);
    for (let run = 0; run < RUNS; run += 1) {
      for (const parameters of withParameters(next)) {
        const pKnown = 0.0001 + next() * 0.9998;
        expect(posteriorKnown(pKnown, true, parameters)).toBeGreaterThan(pKnown);
        expect(posteriorKnown(pKnown, false, parameters)).toBeLessThan(pKnown);
        expect(updateKnown(pKnown, false, parameters)).toBeLessThan(updateKnown(pKnown, true, parameters));
      }
    }
  });

  it('stays within bounds: never below the wrong-answer fixed point (eq. 14), never above 1, stored within [0, 1]', () => {
    const next = generator(23);
    for (let run = 0; run < RUNS; run += 1) {
      for (const parameters of withParameters(next)) {
        const history = randomHistory(next, 80);
        const floor = wrongAnswerFixedPoint(parameters);
        for (const value of traceMastery(history, parameters).path) {
          expect(value).toBeGreaterThanOrEqual(floor - 1e-12);
          expect(value).toBeLessThanOrEqual(1);
          expect(Number.isFinite(value)).toBe(true);
        }
        const estimate = estimateMastery(history, parameters);
        if (history.length === 0) expect(estimate).toBeNull();
        else {
          expect(estimate!.likelihood).toBeGreaterThanOrEqual(0);
          expect(estimate!.likelihood).toBeLessThanOrEqual(1);
          expect(estimate!.uncertainty).toBeGreaterThanOrEqual(0);
          expect(estimate!.uncertainty).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('never rewards a wrong answer: turning any correct into wrong never raises the final estimate', () => {
    const next = generator(29);
    for (let run = 0; run < RUNS; run += 1) {
      for (const parameters of withParameters(next)) {
        const history = randomHistory(next);
        if (!history.includes(true)) continue;
        const flip = history.indexOf(true);
        const worse = history.map((value, index) => (index === flip ? false : value));
        const best = traceMastery(history, parameters).path.at(-1)!;
        const flipped = traceMastery(worse, parameters).path.at(-1)!;
        expect(flipped).toBeLessThanOrEqual(best);
      }
    }
  });

  it('is deterministic: identical inputs give identical outputs', () => {
    const next = generator(31);
    for (let run = 0; run < RUNS; run += 1) {
      const history = randomHistory(next);
      expect(traceMastery(history)).toEqual(traceMastery([...history]));
      expect(estimateMastery(history)).toEqual(estimateMastery([...history]));
    }
  });

  it('predicts a probability for every observation after the first', () => {
    const next = generator(37);
    for (let run = 0; run < RUNS; run += 1) {
      const history = randomHistory(next);
      const { predictions } = traceMastery(history);
      expect(predictions).toHaveLength(Math.max(history.length - 1, 0));
      for (const prediction of predictions) {
        expect(prediction.predicted).toBeGreaterThanOrEqual(DEFAULT_BKT_PARAMETERS.pGuess);
        expect(prediction.predicted).toBeLessThanOrEqual(1 - DEFAULT_BKT_PARAMETERS.pSlip);
      }
    }
  });
});
