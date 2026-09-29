/**
 * INST-12: the placement funnel partition, derived funnel values and the two-way suppression of the
 * statistics table. The recovery checks play the observer: they subtract everything published and
 * assert no withheld group of 1–4 people can be computed exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  placementFunnelStage,
  placementFunnelStages,
  placementStatistics,
  publishedSubtotal,
  suppressAggregateTable,
  suppressGroupedPartition,
  suppressedMonthlyCounts,
  type SharedApplicationFacts,
} from './index.js';

const app = (facts: Partial<SharedApplicationFacts> = {}): SharedApplicationFacts => ({ reachedShortlist: false, offerExtended: false, placed: false, offers: 0, ...facts });

describe('placementFunnelStage', () => {
  it('is NOT_SHARED with nothing shared — never unplaced', () => {
    expect(placementFunnelStage([])).toBe('NOT_SHARED');
  });
  it('takes the furthest stage any shared application reached', () => {
    expect(placementFunnelStage([app()])).toBe('APPLIED');
    expect(placementFunnelStage([app(), app({ reachedShortlist: true })])).toBe('SHORTLISTED');
    expect(placementFunnelStage([app({ offerExtended: true, offers: 1 }), app({ reachedShortlist: true })])).toBe('OFFERED');
    expect(placementFunnelStage([app({ offerExtended: true, offers: 1 }), app({ placed: true, offerExtended: true, offers: 1 })])).toBe('PLACED');
  });
  it('lists the partition in funnel order', () => {
    expect(placementFunnelStages).toEqual(['NOT_SHARED', 'APPLIED', 'SHORTLISTED', 'OFFERED', 'PLACED']);
  });
});

describe('publishedSubtotal', () => {
  const cells = (counts: readonly number[]) => ['A', 'B', 'C'].map((key, index) => ({ key, count: counts[index]! }));
  it('sums published cells', () => {
    expect(publishedSubtotal(suppressAggregateTable(cells([6, 7, 8])), ['B', 'C'])).toEqual({ suppressed: false, value: 15 });
  });
  it('derives from the total when every outside cell is published', () => {
    // B and C are each under 5 but hold 6 together: the total is published, B+C = total − A anyway.
    expect(publishedSubtotal(suppressAggregateTable(cells([10, 3, 3])), ['B', 'C'])).toEqual({ suppressed: false, value: 6 });
  });
  it('withholds a sum that would reveal a withheld cell', () => {
    // A = 3 is withheld and the total with it; A+B would give A back from B.
    expect(publishedSubtotal(suppressAggregateTable(cells([3, 10, 10])), ['A', 'B'])).toEqual({ suppressed: true, value: null });
  });
  it('withholds a whole withheld table and any sum under 5', () => {
    expect(publishedSubtotal(suppressAggregateTable(cells([1, 1, 1])), ['A'])).toEqual({ suppressed: true, value: null });
    expect(publishedSubtotal(suppressAggregateTable(cells([10, 3, 1])), ['B', 'C'])).toEqual({ suppressed: true, value: null });
  });
});

describe('suppressGroupedPartition', () => {
  const keys = ['X', 'Y'] as const;
  const group = (key: string, x: number, y: number) => ({ key, cells: [{ key: 'X' as const, count: x }, { key: 'Y' as const, count: y }] });

  it('publishes everything when every cell holds five or more', () => {
    const result = suppressGroupedPartition([group('g1', 5, 6), group('g2', 7, 8)], keys);
    expect(result.overall.total).toEqual({ suppressed: false, value: 26 });
    expect(result.overall.cells).toEqual([{ key: 'X', count: 12, suppressed: false }, { key: 'Y', count: 14, suppressed: false }]);
  });

  it('withholds a column total that would give back the withheld cells of that column', () => {
    // g1.X = 3 is withheld; column X = 3 + 10 would give it back from g2.X.
    const result = suppressGroupedPartition([group('g1', 3, 10), group('g2', 10, 10)], keys);
    expect(result.overall.cells.find((cell) => cell.key === 'X')).toEqual({ key: 'X', count: null, suppressed: true });
    expect(result.overall.cells.find((cell) => cell.key === 'Y')).toEqual({ key: 'Y', count: 20, suppressed: false });
    // g1's row total is withheld (its hidden cell holds 3); the grand total would give g1 back.
    expect(result.groups[0]!.table.total.suppressed).toBe(true);
    expect(result.overall.total.suppressed).toBe(true);
  });

  it('publishes a column whose withheld cells hold five or more together', () => {
    const result = suppressGroupedPartition([group('g1', 3, 10), group('g2', 3, 10), group('g3', 10, 10)], keys);
    expect(result.overall.cells.find((cell) => cell.key === 'X')).toEqual({ key: 'X', count: 16, suppressed: false });
    expect(result.overall.total).toEqual({ suppressed: false, value: 46 });
  });

  it('withholds the whole table under five', () => {
    const result = suppressGroupedPartition([group('g1', 1, 2)], keys);
    expect(result.overall.suppressed).toBe(true);
    expect(result.overall.cells).toEqual([]);
  });

  it('refuses a group that does not list every key', () => {
    expect(() => suppressGroupedPartition([{ key: 'g', cells: [{ key: 'X' as const, count: 5 }] }], keys)).toThrow(RangeError);
  });

  it('never lets an observer recover a withheld group of 1–4 by subtracting published figures (exhaustive small tables)', () => {
    for (let a = 0; a <= 7; a += 1) for (let b = 0; b <= 7; b += 1) for (let c = 0; c <= 7; c += 1) for (let d = 0; d <= 7; d += 1) {
      const result = suppressGroupedPartition([group('g1', a, b), group('g2', c, d)], keys);
      const raw = [[a, b], [c, d]];
      const published = (g: number, k: number) => {
        const cell = result.groups[g]!.table.cells[k];
        return cell && !cell.suppressed ? cell.count : null;
      };
      // Every single-subtraction an observer can make: a row total minus the other published cell,
      // a column total minus the other published cell, the grand total minus the other row or column.
      const recovered: number[] = [];
      for (let g = 0; g < 2; g += 1) {
        const rowTotal = result.groups[g]!.table.total;
        if (!result.groups[g]!.table.suppressed && !rowTotal.suppressed) {
          for (let k = 0; k < 2; k += 1) if (published(g, k) === null && published(g, 1 - k) !== null) recovered.push(raw[g]![k]!);
        }
      }
      if (!result.overall.suppressed) {
        for (let k = 0; k < 2; k += 1) {
          const column = result.overall.cells[k]!;
          if (!column.suppressed) for (let g = 0; g < 2; g += 1) if (published(g, k) === null && published(1 - g, k) !== null) recovered.push(raw[g]![k]!);
        }
        if (!result.overall.total.suppressed) {
          for (let g = 0; g < 2; g += 1) {
            const other = result.groups[1 - g]!.table;
            if (result.groups[g]!.table.total.suppressed && !other.suppressed && !other.total.suppressed) recovered.push(raw[g]![0]! + raw[g]![1]!);
          }
          for (let k = 0; k < 2; k += 1) {
            if (result.overall.cells[k]!.suppressed && !result.overall.cells[1 - k]!.suppressed) {
              const withheldInColumn = [0, 1].filter((g) => published(g, k) === null).reduce((sum, g) => sum + raw[g]![k]!, 0);
              recovered.push(withheldInColumn);
            }
          }
        }
      }
      for (const value of recovered) expect(value === 0 || value >= 5, `recovered ${value} from ${JSON.stringify(raw)}`).toBe(true);
    }
  });
});

describe('placementStatistics', () => {
  const placed = (offers = 1) => [app({ placed: true, offerExtended: true, offers })];
  const student = (group: string, applications: readonly SharedApplicationFacts[]) => ({ group, applications });

  it('counts eligible, applied, placed and the ratios, and never counts a private student as unplaced', () => {
    const students = [
      ...Array.from({ length: 6 }, () => student('cse', [])),
      ...Array.from({ length: 5 }, () => student('cse', [app()])),
      ...Array.from({ length: 5 }, () => student('cse', [app({ reachedShortlist: true })])),
      ...Array.from({ length: 5 }, () => student('cse', [app({ offerExtended: true, offers: 1 })])),
      ...Array.from({ length: 5 }, () => student('cse', placed(2))),
    ];
    const result = placementStatistics(['cse'], students);
    const cse = result.groups[0]!.row;
    expect(cse.eligible).toEqual({ suppressed: false, value: 26 });
    expect(cse.notShared).toEqual({ suppressed: false, value: 6 });
    expect(cse.applied).toEqual({ suppressed: false, value: 20 });
    expect(cse.shortlisted).toEqual({ suppressed: false, value: 15 });
    expect(cse.withOffer).toEqual({ suppressed: false, value: 10 });
    expect(cse.placed).toEqual({ suppressed: false, value: 5 });
    // 5 of the 20 who shared — the 6 who shared nothing are not in the denominator.
    expect(cse.placementPercentage).toBe(25);
    expect(cse.offersPerPlacedStudent).toBe(2);
    expect(result.overall.eligible).toEqual({ suppressed: false, value: 26 });
  });

  it('withholds a small group, its ratios and the totals that would reveal it', () => {
    const students = [
      ...Array.from({ length: 3 }, () => student('ece', placed())),
      ...Array.from({ length: 10 }, () => student('cse', [])),
      ...Array.from({ length: 10 }, () => student('cse', placed())),
    ];
    const result = placementStatistics(['cse', 'ece'], students);
    const ece = result.groups.find((entry) => entry.key === 'ece')!.row;
    expect(ece.eligible.suppressed).toBe(true);
    expect(ece.placed.suppressed).toBe(true);
    expect(ece.placementPercentage).toBeNull();
    expect(ece.offersPerPlacedStudent).toBeNull();
    // Placed overall = 13 would give ece's 3 back from cse's 10.
    expect(result.overall.placed.suppressed).toBe(true);
    expect(result.overall.eligible.suppressed).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/compensation|readiness/i);
  });

  it('suppresses each month of the offers trend on its own', () => {
    expect(suppressedMonthlyCounts([{ month: '2026-07', count: 2 }, { month: '2026-08', count: 9 }])).toEqual([
      { month: '2026-07', count: { suppressed: true, value: null } },
      { month: '2026-08', count: { suppressed: false, value: 9 } },
    ]);
  });
});
