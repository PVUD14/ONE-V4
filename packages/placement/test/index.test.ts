/**
 * Unit tests for placement-2pl-eap-v1 (ENG-14): the 2PL model, the EAP estimate, the placement
 * levels, content-balanced maximum-information selection, the stop rules in their order, and the
 * refusals. Every item is synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_ALGORITHM_ID,
  PLACEMENT_RULES,
  PlacementError,
  estimateAbility,
  itemInformation,
  nextPlacementStep,
  placementGroupOfSkillKey,
  placementLevelFor,
  placementLevelRank,
  probabilityCorrect,
  retestPool,
  selectNextItem,
  type PlacementAnswer,
  type PlacementGroup,
  type PlacementItem,
} from '../src/index.js';

const item = (key: string, difficulty = 0, discrimination = 1, group: PlacementGroup = 'QUANTITATIVE'): PlacementItem =>
  ({ key, group, difficulty, discrimination });

/** A spread pool of `perGroup` items in each area. */
function pool(perGroup = 12): PlacementItem[] {
  const items: PlacementItem[] = [];
  for (const group of ['QUANTITATIVE', 'LOGICAL', 'VERBAL'] as const) {
    for (let index = 0; index < perGroup; index += 1) {
      items.push(item(`${group[0]}-${String(index).padStart(2, '0')}`, -2.5 + (5 * index) / (perGroup - 1), 1 + (index % 3) * 0.4, group));
    }
  }
  return items;
}

describe('the 2PL model', () => {
  it('gives one half at the item difficulty and the most information there', () => {
    const q = item('q', 0.7, 1.6);
    expect(probabilityCorrect(0.7, q)).toBeCloseTo(0.5, 12);
    expect(itemInformation(0.7, q)).toBeCloseTo((1.6 * 1.6) / 4, 12);
    expect(itemInformation(0.2, q)).toBeLessThan(itemInformation(0.7, q));
    expect(probabilityCorrect(2, q)).toBeGreaterThan(probabilityCorrect(0, q));
  });
});

describe('estimateAbility (EAP, standard-normal prior)', () => {
  it('with no answers is the prior: centre 0, spread about 1', () => {
    const estimate = estimateAbility([]);
    expect(estimate.theta).toBeCloseTo(0, 6);
    expect(estimate.standardError).toBeCloseTo(1, 2);
  });

  it('stays finite when every answer is right, or every answer is wrong', () => {
    const items = [item('a', -1), item('b', 0), item('c', 1)];
    const right = estimateAbility(items.map((entry) => ({ item: entry, correct: true })));
    const wrong = estimateAbility(items.map((entry) => ({ item: entry, correct: false })));
    expect(Number.isFinite(right.theta) && right.theta > 0).toBe(true);
    expect(Number.isFinite(wrong.theta) && wrong.theta < 0).toBe(true);
    expect(right.theta).toBeCloseTo(-wrong.theta, 6);
  });

  it('narrows as informative answers accumulate', () => {
    const answers: PlacementAnswer[] = [];
    let previous = estimateAbility(answers).standardError;
    for (let index = 0; index < 10; index += 1) {
      answers.push({ item: item(`k${index}`, 0, 2), correct: index % 2 === 0 });
      const next = estimateAbility(answers).standardError;
      expect(next).toBeLessThan(previous);
      previous = next;
    }
  });
});

describe('placementLevelFor', () => {
  it('bands θ at −1, 0 and 1 into the skill map levels', () => {
    expect(placementLevelFor({ theta: -1.01, standardError: 0.2 })).toBe('AWARE');
    expect(placementLevelFor({ theta: -1, standardError: 0.2 })).toBe('GUIDED');
    expect(placementLevelFor({ theta: -0.01, standardError: 0.2 })).toBe('GUIDED');
    expect(placementLevelFor({ theta: 0, standardError: 0.2 })).toBe('INDEPENDENT');
    expect(placementLevelFor({ theta: 0.99, standardError: 0.2 })).toBe('INDEPENDENT');
    expect(placementLevelFor({ theta: 1, standardError: 0.2 })).toBe('TROUBLESHOOT');
  });

  it('says NOT_ENOUGH_EVIDENCE while the estimate is too uncertain', () => {
    expect(placementLevelFor({ theta: 2, standardError: 0.51 })).toBe('NOT_ENOUGH_EVIDENCE');
    expect(placementLevelFor({ theta: 2, standardError: 0.5 })).toBe('TROUBLESHOOT');
    expect(placementLevelRank('NOT_ENOUGH_EVIDENCE')).toBeNull();
    expect(placementLevelRank('AWARE')).toBe(0);
    expect(placementLevelRank('TROUBLESHOOT')).toBe(3);
  });
});

describe('selectNextItem', () => {
  it('starts in the first area and takes the most informative item there', () => {
    const chosen = selectNextItem(pool(), [], 0);
    expect(chosen?.group).toBe('QUANTITATIVE');
    const quantitative = pool().filter((entry) => entry.group === 'QUANTITATIVE');
    const best = Math.max(...quantitative.map((entry) => itemInformation(0, entry)));
    expect(itemInformation(0, chosen!)).toBe(best);
  });

  it('balances areas: the area with the fewest questions so far goes next', () => {
    const items = pool();
    const answers: PlacementAnswer[] = [
      { item: items.find((entry) => entry.group === 'QUANTITATIVE')!, correct: true },
      { item: items.find((entry) => entry.group === 'LOGICAL')!, correct: false },
    ];
    expect(selectNextItem(items, answers, 0)?.group).toBe('VERBAL');
  });

  it('breaks an exact tie by key and never repeats an answered item', () => {
    const twins = [item('b-item', 0, 1), item('a-item', 0, 1)];
    expect(selectNextItem(twins, [], 0)?.key).toBe('a-item');
    expect(selectNextItem(twins, [{ item: twins[1]!, correct: true }], 0)?.key).toBe('b-item');
    expect(selectNextItem(twins, twins.map((entry) => ({ item: entry, correct: true })), 0)).toBeNull();
  });

  it('moves to another area when one runs out', () => {
    const items = [item('q1', 0, 1, 'QUANTITATIVE'), item('v1', 0, 1, 'VERBAL'), item('v2', 1, 1, 'VERBAL')];
    const answers: PlacementAnswer[] = [{ item: items[0]!, correct: true }, { item: items[1]!, correct: true }];
    expect(selectNextItem(items, answers, 0)?.key).toBe('v2');
  });
});

describe('nextPlacementStep: stop rules in order', () => {
  it('stops at 25 minutes before anything else, with too little evidence for a level after no answers', () => {
    const step = nextPlacementStep({ pool: pool(), answers: [], elapsedMs: PLACEMENT_RULES.timeLimitMs });
    expect(step).toMatchObject({ kind: 'STOP', reason: 'TIME_LIMIT', level: 'NOT_ENOUGH_EVIDENCE', itemsAnswered: 0 });
  });

  it('stops after 25 answers', () => {
    const items = pool(10);
    const answers = items.slice(0, 25).map((entry, index) => ({ item: { ...entry, discrimination: 0.3 }, correct: index % 2 === 0 }));
    const step = nextPlacementStep({ pool: items, answers, elapsedMs: 60_000 });
    expect(step).toMatchObject({ kind: 'STOP', reason: 'MAX_ITEMS', itemsAnswered: 25 });
  });

  it('stops as CONFIDENT only from 8 answers, even when fewer are already precise', () => {
    const sharp = Array.from({ length: 9 }, (_, index) => item(`s${index}`, index % 2 === 0 ? -0.1 : 0.1, 4));
    const seven = sharp.slice(0, 7).map((entry, index) => ({ item: entry, correct: index % 2 === 0 }));
    expect(estimateAbility(seven).standardError).toBeLessThanOrEqual(PLACEMENT_RULES.targetStandardError);
    expect(nextPlacementStep({ pool: sharp, answers: seven, elapsedMs: 0 }).kind).toBe('ASK');
    const eight = sharp.slice(0, 8).map((entry, index) => ({ item: entry, correct: index % 2 === 0 }));
    expect(nextPlacementStep({ pool: sharp, answers: eight, elapsedMs: 0 })).toMatchObject({ kind: 'STOP', reason: 'CONFIDENT' });
  });

  it('stops when nothing is left to ask', () => {
    const items = [item('only', 0, 1)];
    const step = nextPlacementStep({ pool: items, answers: [{ item: items[0]!, correct: true }], elapsedMs: 0 });
    expect(step).toMatchObject({ kind: 'STOP', reason: 'POOL_EXHAUSTED', itemsAnswered: 1 });
  });

  it('asks otherwise, and carries no readiness and no answer key', () => {
    const step = nextPlacementStep({ pool: pool(), answers: [], elapsedMs: 0 });
    expect(step.kind).toBe('ASK');
    expect(Object.keys(step).sort()).toEqual(['estimate', 'item', 'kind']);
    expect(PLACEMENT_ALGORITHM_ID).toBe('placement-2pl-eap-v1');
  });
});

describe('refusals', () => {
  it('refuses parameters outside the calibration bounds instead of clamping them', () => {
    expect(() => nextPlacementStep({ pool: [item('x', 4.5)], answers: [], elapsedMs: 0 })).toThrow(PlacementError);
    expect(() => nextPlacementStep({ pool: [item('x', 0, 0.1)], answers: [], elapsedMs: 0 })).toThrow(PlacementError);
    expect(() => nextPlacementStep({ pool: [item('x', Number.NaN)], answers: [], elapsedMs: 0 })).toThrow(PlacementError);
  });

  it('refuses a repeated pool item, a repeated answer, a negative time and more than 25 answers', () => {
    expect(() => nextPlacementStep({ pool: [item('x'), item('x')], answers: [], elapsedMs: 0 })).toThrow('twice in the pool');
    expect(() => estimateAbility([{ item: item('x'), correct: true }, { item: item('x'), correct: false }])).toThrow('answered twice');
    expect(() => nextPlacementStep({ pool: [], answers: [], elapsedMs: -1 })).toThrow(PlacementError);
    const many = Array.from({ length: 26 }, (_, index) => ({ item: item(`m${index}`), correct: true }));
    expect(() => nextPlacementStep({ pool: [], answers: many, elapsedMs: 0 })).toThrow('at most 25');
  });
});

describe('helpers', () => {
  it('reads the area from an aptitude skill key and nothing else', () => {
    expect(placementGroupOfSkillKey('apt-q-percentages')).toBe('QUANTITATIVE');
    expect(placementGroupOfSkillKey('apt-l-syllogisms')).toBe('LOGICAL');
    expect(placementGroupOfSkillKey('apt-v-reading')).toBe('VERBAL');
    expect(placementGroupOfSkillKey('soc-networking')).toBeNull();
    expect(placementGroupOfSkillKey('apt-x-other')).toBeNull();
  });

  it('leaves earlier items out of a retest only while 25 unseen items remain', () => {
    const items = pool(10);
    const seenFew = new Set(items.slice(0, 5).map((entry) => entry.key));
    expect(retestPool(items, seenFew)).toHaveLength(25);
    const seenMany = new Set(items.slice(0, 6).map((entry) => entry.key));
    expect(retestPool(items, seenMany)).toHaveLength(30);
  });
});
