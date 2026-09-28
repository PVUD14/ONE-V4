/**
 * Property tests for placement-2pl-eap-v1 (ENG-14): determinism, order independence, monotonicity
 * of the estimate and the level, bounds, and that every sitting ends within 25 answers without ever
 * repeating an item. Random pools and answers come from a seeded generator, so a failure
 * reproduces exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_RULES,
  estimateAbility,
  nextPlacementStep,
  placementGroups,
  placementLevelFor,
  placementLevelRank,
  type PlacementAnswer,
  type PlacementItem,
} from '../src/index.js';
import { seededRandom } from '../src/simulation.js';

const RUNS = 200;

function randomPool(next: () => number, size: number): PlacementItem[] {
  return Array.from({ length: size }, (_, index) => ({
    key: `p${index}`,
    group: placementGroups[Math.floor(next() * 3)]!,
    difficulty: Number((-4 + 8 * next()).toFixed(4)),
    discrimination: Number((0.2 + 3.8 * next()).toFixed(4)),
  }));
}

function randomAnswers(next: () => number, items: readonly PlacementItem[], count: number): PlacementAnswer[] {
  return items.slice(0, count).map((item) => ({ item, correct: next() < 0.5 }));
}

function shuffled<T>(next: () => number, values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

describe('placement-2pl-eap-v1 properties', () => {
  it('identical inputs give identical steps', () => {
    const next = seededRandom(1401);
    for (let run = 0; run < RUNS; run += 1) {
      const pool = randomPool(next, 40);
      const answers = randomAnswers(next, pool, Math.floor(next() * 20));
      const elapsedMs = Math.floor(next() * 30 * 60_000);
      expect(nextPlacementStep({ pool, answers, elapsedMs })).toEqual(nextPlacementStep({ pool: [...pool], answers: [...answers], elapsedMs }));
    }
  });

  it('the order of answers does not change the estimate', () => {
    const next = seededRandom(1402);
    for (let run = 0; run < RUNS; run += 1) {
      const answers = randomAnswers(next, randomPool(next, 25), 1 + Math.floor(next() * 25));
      const a = estimateAbility(answers);
      const b = estimateAbility(shuffled(next, answers));
      expect(b.theta).toBeCloseTo(a.theta, 9);
      expect(b.standardError).toBeCloseTo(a.standardError, 9);
    }
  });

  it('turning a wrong answer into a right one never lowers the estimate', () => {
    const next = seededRandom(1403);
    for (let run = 0; run < RUNS; run += 1) {
      const answers = randomAnswers(next, randomPool(next, 25), 1 + Math.floor(next() * 25));
      const wrongAt = answers.findIndex((answer) => !answer.correct);
      if (wrongAt < 0) continue;
      const improved = answers.map((answer, index) => (index === wrongAt ? { ...answer, correct: true } : answer));
      expect(estimateAbility(improved).theta).toBeGreaterThanOrEqual(estimateAbility(answers).theta - 1e-12);
    }
  });

  it('the estimate stays inside the grid and never less certain than the prior', () => {
    const next = seededRandom(1404);
    for (let run = 0; run < RUNS; run += 1) {
      const estimate = estimateAbility(randomAnswers(next, randomPool(next, 25), Math.floor(next() * 26)));
      expect(estimate.theta).toBeGreaterThanOrEqual(PLACEMENT_RULES.gridMin);
      expect(estimate.theta).toBeLessThanOrEqual(PLACEMENT_RULES.gridMax);
      expect(estimate.standardError).toBeGreaterThan(0);
      expect(estimate.standardError).toBeLessThanOrEqual(estimateAbility([]).standardError + 1e-9);
    }
  });

  it('a higher estimate never gives a lower level', () => {
    const next = seededRandom(1405);
    for (let run = 0; run < RUNS; run += 1) {
      const low = -4 + 8 * next();
      const high = low + 4 * next();
      const standardError = 0.5 * next();
      const lowRank = placementLevelRank(placementLevelFor({ theta: low, standardError }))!;
      const highRank = placementLevelRank(placementLevelFor({ theta: high, standardError }))!;
      expect(highRank).toBeGreaterThanOrEqual(lowRank);
    }
  });

  it('every sitting ends within 25 answers, asks only pool items, and never repeats one', () => {
    const next = seededRandom(1406);
    for (let run = 0; run < RUNS; run += 1) {
      const pool = randomPool(next, 1 + Math.floor(next() * 60));
      const keys = new Set(pool.map((item) => item.key));
      const answers: PlacementAnswer[] = [];
      let elapsedMs = 0;
      for (;;) {
        const step = nextPlacementStep({ pool, answers, elapsedMs });
        if (step.kind === 'STOP') {
          expect(step.itemsAnswered).toBe(answers.length);
          if (step.reason === 'POOL_EXHAUSTED') expect(answers.length).toBe(pool.length);
          break;
        }
        expect(keys.has(step.item.key)).toBe(true);
        expect(answers.some((answer) => answer.item.key === step.item.key)).toBe(false);
        answers.push({ item: step.item, correct: next() < 0.5 });
        elapsedMs += Math.floor(next() * 120_000);
      }
      expect(answers.length).toBeLessThanOrEqual(PLACEMENT_RULES.maxItems);
    }
  });
});
