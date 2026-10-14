/**
 * The one shared suppression rule (INST-SR-01, OPS-SR-24): primary suppression of any cell
 * under 5, complementary suppression of a total that would let a suppressed cell be
 * recalculated, and the reporting-period rule that stops two reports being differenced.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateSuppressionThreshold,
  institutionReportingMonth,
  latestReportingMonth,
  suppressAggregateTable,
  suppressPeopleCount,
  suppressSmallCount,
} from './index.js';
import * as privacyConsole from './privacy-console.js';

const bands = (counts: readonly number[]) =>
  ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP'].map((key, index) => ({ key, count: counts[index]! }));

/** What an observer can compute from a published table: every cell they can recover exactly. */
function recoverableCells(table: ReturnType<typeof suppressAggregateTable<string>>): string[] {
  if (table.suppressed || table.total.suppressed) return [];
  const hidden = table.cells.filter((cell) => cell.suppressed);
  return hidden.length === 1 ? [hidden[0]!.key] : [];
}

describe('one shared helper', () => {
  it('is the helper the privacy console and the Overview use, with one threshold of 5', () => {
    expect(aggregateSuppressionThreshold).toBe(5);
    expect(privacyConsole.suppressSmallCount).toBe(suppressSmallCount);
    expect(privacyConsole.aggregateSuppressionThreshold).toBe(aggregateSuppressionThreshold);
    for (const count of [0, 4, 5, 9]) {
      const small = suppressSmallCount(count);
      expect(suppressPeopleCount(count)).toEqual({ ...small, capped: false });
    }
  });
});

describe('primary suppression', () => {
  it('withholds every band cell under 5, zero included, and drops the value', () => {
    const table = suppressAggregateTable(bands([0, 12, 3, 9]));
    expect(table.cells).toEqual([
      { key: 'NOT_ENOUGH_EVIDENCE', count: null, suppressed: true },
      { key: 'DEVELOPING', count: 12, suppressed: false },
      { key: 'PROGRESSING', count: null, suppressed: true },
      { key: 'READY_FOR_NEXT_STEP', count: 9, suppressed: false },
    ]);
  });

  it('withholds the whole table when fewer than 5 people are in it', () => {
    expect(suppressAggregateTable(bands([1, 1, 1, 1]))).toEqual({ suppressed: true, total: { suppressed: true, value: null }, cells: [] });
    expect(suppressAggregateTable(bands([0, 0, 0, 0]))).toEqual({ suppressed: true, total: { suppressed: true, value: null }, cells: [] });
  });

  it('publishes a table with no small cell in full', () => {
    expect(suppressAggregateTable(bands([5, 6, 7, 8]))).toEqual({
      suppressed: false,
      total: { suppressed: false, value: 26 },
      cells: bands([5, 6, 7, 8]).map((cell) => ({ ...cell, suppressed: false })),
    });
  });
});

describe('complementary suppression', () => {
  it('withholds the total when one hidden cell could be recovered as total minus the others', () => {
    // 10 + 7 + 6 published beside a total of 24 would give READY_FOR_NEXT_STEP = 1.
    const table = suppressAggregateTable(bands([10, 7, 6, 1]));
    expect(table.total).toEqual({ suppressed: true, value: null });
    expect(recoverableCells(table)).toEqual([]);
  });

  it('withholds the total when several hidden cells together hold fewer than 5', () => {
    // Total 14 beside 6 + 6 would say the two hidden bands hold 2 students between them.
    const table = suppressAggregateTable(bands([1, 6, 6, 1]));
    expect(table.total.suppressed).toBe(true);
    // Zeros count as hidden too: publishing 12 beside 12 would say every other band is empty.
    expect(suppressAggregateTable(bands([0, 12, 0, 0])).total.suppressed).toBe(true);
  });

  it('keeps the total when the hidden cells together hold 5 or more, since the difference is itself a group of 5', () => {
    const table = suppressAggregateTable(bands([3, 10, 2, 8]));
    expect(table.total).toEqual({ suppressed: false, value: 23 });
    expect(table.cells.filter((cell) => cell.suppressed).map((cell) => cell.key)).toEqual(['NOT_ENOUGH_EVIDENCE', 'PROGRESSING']);
  });

  it('never leaves a hidden cell recoverable, over every small table', () => {
    for (let a = 0; a <= 7; a += 1) for (let b = 0; b <= 7; b += 1) for (let c = 0; c <= 7; c += 1) for (let d = 0; d <= 7; d += 1) {
      const table = suppressAggregateTable(bands([a, b, c, d]));
      expect(recoverableCells(table), [a, b, c, d].join(',')).toEqual([]);
      if (!table.suppressed && !table.total.suppressed) {
        const hiddenSum = [a, b, c, d].filter((count) => count < 5).reduce((sum, count) => sum + count, 0);
        // A published total leaves the hidden cells, together, as a group of 5 or more.
        expect([a, b, c, d].some((count) => count < 5) ? hiddenSum >= 5 : true, [a, b, c, d].join(',')).toBe(true);
      }
      for (const cell of table.cells) if (!cell.suppressed) expect(cell.count).toBeGreaterThanOrEqual(5);
    }
  });

  it('refuses counts that are not counts and duplicated cells', () => {
    expect(() => suppressAggregateTable(bands([-1, 5, 5, 5]))).toThrow(RangeError);
    expect(() => suppressAggregateTable(bands([2.5, 5, 5, 5]))).toThrow(RangeError);
    expect(() => suppressAggregateTable([{ key: 'A', count: 5 }, { key: 'A', count: 5 }])).toThrow(RangeError);
    expect(() => suppressAggregateTable(bands([5, 5, 5, 5]), 0)).toThrow(RangeError);
  });
});

describe('reporting period', () => {
  const today = '2026-09-26';

  it('accepts exactly one whole calendar month that has ended', () => {
    expect(institutionReportingMonth('2026-08-01', '2026-08-31', today)).toEqual({ month: '2026-08', periodStart: '2026-08-01', periodEnd: '2026-08-31' });
    expect(institutionReportingMonth('2024-02-01', '2024-02-29', today)?.month).toBe('2024-02');
    expect(institutionReportingMonth('2025-12-01', '2025-12-31', '2026-01-01')?.month).toBe('2025-12');
  });

  it('refuses the month still in progress and any future month, which could be regenerated and differenced over time', () => {
    expect(institutionReportingMonth('2026-09-01', '2026-09-30', today)).toBeNull();
    expect(institutionReportingMonth('2026-10-01', '2026-10-31', today)).toBeNull();
  });

  it('refuses partial months and multi-month windows, which could overlap another report', () => {
    expect(institutionReportingMonth('2026-08-02', '2026-08-31', today)).toBeNull();
    expect(institutionReportingMonth('2026-08-01', '2026-08-30', today)).toBeNull();
    expect(institutionReportingMonth('2026-07-01', '2026-08-31', today)).toBeNull();
    expect(institutionReportingMonth('2025-08-01', '2026-08-31', today)).toBeNull();
    expect(institutionReportingMonth('2023-02-01', '2023-02-29', today)).toBeNull();
  });

  it('refuses anything that is not an ISO date', () => {
    expect(institutionReportingMonth('2026-8-01', '2026-08-31', today)).toBeNull();
    expect(institutionReportingMonth('2026-08-01', 'yesterday', today)).toBeNull();
    expect(institutionReportingMonth('2026-13-01', '2026-13-31', today)).toBeNull();
  });

  it('names the latest month a report may cover', () => {
    expect(latestReportingMonth(today)).toBe('2026-08');
    expect(latestReportingMonth('2026-01-05')).toBe('2025-12');
    expect(latestReportingMonth('not a date')).toBeNull();
  });
});
