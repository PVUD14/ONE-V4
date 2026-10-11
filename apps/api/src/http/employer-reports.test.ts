/**
 * Unit tests for the employer report model (EMP-15): the partition every application falls into,
 * the suppression of each table, the "named college only from 5" rule, and the guards on the
 * offer acceptance rate and the time-to-stage medians. The rule itself is the shared helper's;
 * these pin how the reports use it.
 */
import { describe, expect, it } from 'vitest';
import { collegeGroups, durationFigure, offerOutcomes, reportCellFor, reportCells, stageTable } from './employer-reports.js';

describe('EMP-15 report partition', () => {
  it('puts every application in exactly one cell', () => {
    expect(reportCellFor('SCREENING', null)).toBe('SCREENING');
    expect(reportCellFor('HIRED', 'OFFER')).toBe('HIRED');
    expect(reportCellFor('REJECTED', 'INTERVIEW')).toBe('LEFT_AT_INTERVIEW');
    expect(reportCellFor('WITHDRAWN', 'SHORTLISTED')).toBe('LEFT_AT_SHORTLISTED');
    // No usable "from" stage: still counted, as leaving at the first stage.
    expect(reportCellFor('REJECTED', null)).toBe('LEFT_AT_APPLIED');
    expect(reportCellFor('WITHDRAWN', 'REJECTED')).toBe('LEFT_AT_APPLIED');
    expect(new Set(reportCells).size).toBe(13);
  });

  it('fills missing cells with zero and suppresses every cell under 5, zero included', () => {
    const table = stageTable([{ cell: 'APPLIED', count: '7' }, { cell: 'SCREENING', count: 6 }, { cell: 'LEFT_AT_APPLIED', count: 5 }]);
    expect(table.suppressed).toBe(false);
    expect(table.cells).toHaveLength(13);
    expect(table.cells.find((cell) => cell.key === 'APPLIED')).toEqual({ key: 'APPLIED', count: 7, suppressed: false });
    expect(table.cells.find((cell) => cell.key === 'HIRED')).toEqual({ key: 'HIRED', count: null, suppressed: true });
    // Withheld cells hold 0 in total, which is under 5, so the total is withheld too.
    expect(table.total).toEqual({ suppressed: true, value: null });
  });

  it('withholds a whole group under 5 and never returns a raw small count', () => {
    const table = stageTable([{ cell: 'APPLIED', count: 3 }, { cell: 'HIRED', count: 1 }]);
    expect(table).toEqual({ suppressed: true, total: { suppressed: true, value: null }, cells: [] });
    expect(JSON.stringify(table)).not.toMatch(/"count":[1-4][,}]/);
  });

  it('refuses a cell it does not know', () => {
    expect(() => stageTable([{ cell: 'DRAFT', count: 5 }])).toThrow(RangeError);
  });
});

describe('EMP-15 funnel by college', () => {
  const rows = (key: string | null, name: string | null, count: number, cell = 'APPLIED') => ({ collegeKey: key, collegeName: name, cell, count });

  it('names a college only from 5 applications and folds the rest into one other row', () => {
    const groups = collegeGroups([rows('zeta', 'Zeta College', 6), rows('alpha', 'Alpha College', 5), rows('tiny', 'Tiny College', 2), rows(null, null, 3)]);
    expect(groups.map((group) => group.collegeName)).toEqual(['Alpha College', 'Zeta College', null]);
    expect(groups[2]!.table.cells.find((cell) => cell.key === 'APPLIED')).toEqual({ key: 'APPLIED', count: 5, suppressed: false });
    expect(JSON.stringify(groups)).not.toContain('Tiny College');
  });

  it('moves the smallest named college into the other row rather than publish an other row of 1–4', () => {
    const groups = collegeGroups([rows('big', 'Big College', 9), rows('mid', 'Mid College', 6), rows(null, null, 2)]);
    expect(groups.map((group) => group.collegeName)).toEqual(['Big College', null]);
    expect(groups[1]!.table.cells.find((cell) => cell.key === 'APPLIED')!.count).toBe(8);
  });

  it('leaves the other row out when it is empty, and keeps a lone small college unnamed', () => {
    expect(collegeGroups([rows('a', 'A College', 5)]).map((group) => group.collegeName)).toEqual(['A College']);
    const lone = collegeGroups([rows('a', 'A College', 3)]);
    expect(lone).toHaveLength(1);
    expect(lone[0]!.collegeName).toBeNull();
    expect(lone[0]!.table.suppressed).toBe(true);
  });
});

describe('EMP-15 offer acceptance and time to stage', () => {
  it('gives an acceptance rate only when accepted and not accepted each hold 5 or more', () => {
    expect(offerOutcomes([{ cell: 'ACCEPTED', count: 6 }, { cell: 'DECLINED', count: 3 }, { cell: 'EXPIRED', count: 2 }]).acceptanceRate).toBeCloseTo(0.545, 3);
    expect(offerOutcomes([{ cell: 'ACCEPTED', count: 9 }, { cell: 'DECLINED', count: 4 }]).acceptanceRate).toBeNull();
    expect(offerOutcomes([{ cell: 'ACCEPTED', count: 4 }, { cell: 'DECLINED', count: 9 }]).acceptanceRate).toBeNull();
    const outcomes = offerOutcomes([{ cell: 'ACCEPTED', count: 6 }, { cell: 'EXTENDED', count: 1 }]);
    expect(outcomes.table.cells.find((cell) => cell.key === 'EXTENDED')).toEqual({ key: 'EXTENDED', count: null, suppressed: true });
    expect(() => offerOutcomes([{ cell: 'DRAFT', count: 1 }])).toThrow(RangeError);
  });

  it('shows a median only over 5 or more applications', () => {
    expect(durationFigure('OFFER', 5, '12.345')).toEqual({ metric: 'OFFER', applications: { suppressed: false, value: 5 }, medianDays: 12.3 });
    expect(durationFigure('HIRE', 4, 3)).toEqual({ metric: 'HIRE', applications: { suppressed: true, value: null }, medianDays: null });
    expect(durationFigure('SHORTLIST', 0, null)).toEqual({ metric: 'SHORTLIST', applications: { suppressed: true, value: null }, medianDays: null });
  });
});
