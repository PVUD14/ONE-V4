/**
 * INST-13: the one-stage-per-graduate rule and the suppressed outcome table. The recovery check plays
 * the observer: it subtracts everything published and asserts no withheld group of 1–4 graduates can
 * be computed exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  accreditationOutcomeStage,
  accreditationOutcomeStages,
  accreditationOutcomes,
  isSelfReportedOutcome,
  type AccreditationGraduate,
  type AccreditationOutcomeRow,
} from './index.js';

const many = <G extends string>(count: number, graduate: AccreditationGraduate<G>): AccreditationGraduate<G>[] => Array.from({ length: count }, () => graduate);
const shown = (value: number) => ({ suppressed: false as const, value });
const withheld = { suppressed: true as const, value: null };

describe('accreditationOutcomeStage', () => {
  it('counts a graduate once, placed first, then their own self-report', () => {
    expect(accreditationOutcomeStage(true, 'HIGHER_STUDIES')).toBe('PLACED');
    expect(accreditationOutcomeStage(true, null)).toBe('PLACED');
    expect(accreditationOutcomeStage(false, 'HIGHER_STUDIES')).toBe('HIGHER_STUDIES');
    expect(accreditationOutcomeStage(false, 'ENTREPRENEURSHIP')).toBe('ENTREPRENEURSHIP');
  });
  it('calls a graduate with nothing shared "none shared", never unplaced', () => {
    expect(accreditationOutcomeStage(false, null)).toBe('NONE_SHARED');
    expect(accreditationOutcomeStages).toEqual(['PLACED', 'HIGHER_STUDIES', 'ENTREPRENEURSHIP', 'NONE_SHARED']);
  });
  it('accepts only the two self-reported outcomes', () => {
    expect(isSelfReportedOutcome('HIGHER_STUDIES')).toBe(true);
    expect(isSelfReportedOutcome('ENTREPRENEURSHIP')).toBe(true);
    for (const value of ['PLACED', 'EMPLOYED', 'higher_studies', '', null, 3]) expect(isSelfReportedOutcome(value)).toBe(false);
  });
});

describe('accreditationOutcomes', () => {
  it('publishes groups of five or more and the totals they partition', () => {
    const graduates = [
      ...many(6, { group: 'cs-2025', placed: true, declared: null }),
      ...many(5, { group: 'cs-2025', placed: false, declared: 'HIGHER_STUDIES' }),
      ...many(5, { group: 'cs-2025', placed: false, declared: 'ENTREPRENEURSHIP' }),
      ...many(7, { group: 'cs-2025', placed: false, declared: null }),
    ];
    const result = accreditationOutcomes(['cs-2025'], graduates);
    const expected: AccreditationOutcomeRow = { graduated: shown(23), placed: shown(6), higherStudies: shown(5), entrepreneurship: shown(5), noneShared: shown(7) };
    expect(result.groups[0]!.row).toEqual(expected);
    expect(result.overall).toEqual(expected);
  });

  it('counts a placed graduate who also reported higher studies once, as placed', () => {
    const result = accreditationOutcomes(['g'], [
      ...many(5, { group: 'g', placed: true, declared: 'HIGHER_STUDIES' }),
      ...many(5, { group: 'g', placed: false, declared: null }),
    ]);
    expect(result.overall).toMatchObject({ graduated: shown(10), placed: shown(5), noneShared: shown(5) });
    expect(result.overall.higherStudies).toEqual(withheld);
  });

  it('withholds a small cell and the row total that would give it back', () => {
    const result = accreditationOutcomes(['g'], [
      ...many(8, { group: 'g', placed: true, declared: null }),
      ...many(2, { group: 'g', placed: false, declared: 'ENTREPRENEURSHIP' }),
      ...many(9, { group: 'g', placed: false, declared: null }),
    ]);
    const { row } = result.groups[0]!;
    expect(row.placed).toEqual(shown(8));
    expect(row.entrepreneurship).toEqual(withheld);
    expect(row.higherStudies).toEqual(withheld);
    expect(row.graduated).toEqual(withheld);
  });

  it('withholds everything for a group under five, and an empty listed group', () => {
    const result = accreditationOutcomes(['tiny', 'empty'], many(3, { group: 'tiny', placed: true, declared: null }));
    for (const entry of result.groups) {
      expect(Object.values(entry.row).every((count) => count.suppressed && count.value === null)).toBe(true);
    }
  });

  it('ignores graduates whose group is not listed', () => {
    const result = accreditationOutcomes(['g'], [...many(5, { group: 'g', placed: true, declared: null }), ...many(9, { group: 'other' as 'g', placed: true, declared: null })]);
    expect(result.overall.graduated).toEqual(shown(5));
  });

  it('never lets subtraction recover a withheld group of 1–4 across small tables', () => {
    type G = 'a' | 'b' | 'c';
    const groups: G[] = ['a', 'b', 'c'];
    const stageOf = (index: number): Pick<AccreditationGraduate<G>, 'placed' | 'declared'> => (
      [{ placed: true, declared: null }, { placed: false, declared: 'HIGHER_STUDIES' }, { placed: false, declared: 'ENTREPRENEURSHIP' }, { placed: false, declared: null }] as const
    )[index]!;
    const fields = ['placed', 'higherStudies', 'entrepreneurship', 'noneShared'] as const;
    let checked = 0;
    // Every table of three groups where each cell is 0, 2, 5 or 7 on a rotating pattern.
    const values = [0, 2, 5, 7];
    for (let seed = 0; seed < 256; seed += 1) {
      const raw = groups.map((_, groupIndex) => fields.map((__, stageIndex) => values[(seed >> ((groupIndex * 4 + stageIndex) % 8)) & 3]!));
      const graduates = groups.flatMap((group, groupIndex) => fields.flatMap((_, stageIndex) => many(raw[groupIndex]![stageIndex]!, { group, ...stageOf(stageIndex) })));
      const result = accreditationOutcomes(groups, graduates);
      // Row recovery: a published row total minus its published cells.
      result.groups.forEach((entry, groupIndex) => {
        if (entry.row.graduated.suppressed) return;
        const hiddenCells = fields.filter((field) => entry.row[field].suppressed);
        const hidden = entry.row.graduated.value! - fields.filter((field) => !entry.row[field].suppressed).reduce((sum, field) => sum + entry.row[field].value!, 0);
        if (hiddenCells.length > 0) expect(hidden === 0 || hidden >= 5, `row ${groupIndex} seed ${seed}`).toBe(true);
      });
      // Column recovery: a published column total minus the published cells of that column.
      fields.forEach((field) => {
        const total = result.overall[field];
        if (total.suppressed) return;
        const hidden = total.value! - result.groups.filter((entry) => !entry.row[field].suppressed).reduce((sum, entry) => sum + entry.row[field].value!, 0);
        expect(hidden === 0 || hidden >= 5, `column ${field} seed ${seed}`).toBe(true);
      });
      checked += 1;
    }
    expect(checked).toBe(256);
  });
});
