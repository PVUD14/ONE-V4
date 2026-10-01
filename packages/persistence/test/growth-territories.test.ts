/**
 * The LGD district file parser (GROWTH-02, growth-territories-table-design.md §3.1), without a
 * database: header matching, state matching that never guesses, and the file-level refusals.
 */
import { describe, expect, it } from 'vitest';
import { GROWTH_DISTRICT_IMPORT_MAX_ROWS, normaliseGrowthStateName, parseGrowthDistrictCsv } from '../src/growth-territories.js';

const states = [
  { code: 'IN-DH', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: 'IN-AN', name: 'Andaman and Nicobar Islands' },
  { code: 'IN-JK', name: 'Jammu and Kashmir' },
  { code: 'IN-OD', name: 'Odisha' },
  { code: 'IN-DL', name: 'Delhi' },
];

describe('normaliseGrowthStateName', () => {
  it('ignores case, punctuation, "&" and a leading "the"', () => {
    expect(normaliseGrowthStateName('THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU')).toBe(normaliseGrowthStateName('Dadra and Nagar Haveli and Daman and Diu'));
    expect(normaliseGrowthStateName('Andaman & Nicobar Islands')).toBe('andamanandnicobarislands');
    expect(normaliseGrowthStateName(' Jammu And Kashmir ')).toBe('jammuandkashmir');
  });
});

describe('parseGrowthDistrictCsv', () => {
  it('reads the LGD download as it is, with a byte-order mark and quoted names', () => {
    const content = '﻿S.No.,State Code,State Name (In English),District Code,District Name (In English),Census 2011 Code\n'
      + '1,26,THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU,"648","Dadra, Nagar Haveli",\n'
      + '2,21,Orissa,350,Khordha,\n'
      + '3,7,NCT of Delhi,77,New  Delhi,\n';
    const parsed = parseGrowthDistrictCsv(content, states);
    expect(parsed.fileProblems).toEqual([]);
    expect(parsed.rows.map((row) => [row.districtCode, row.districtName, row.stateCode, row.issues])).toEqual([
      [648, 'Dadra, Nagar Haveli', 'IN-DH', []],
      [350, 'Khordha', 'IN-OD', []],
      [77, 'New Delhi', 'IN-DL', []],
    ]);
  });

  it('reports bad rows one by one and never guesses a state', () => {
    const content = 'state_code,district_code,district_name\nIN-ZZ,1,Somewhere\nIN-OD,abc,Bad code\nIN-OD,2,\nIN-OD,3,Fine\nIN-OD,3,Again\nIN-OD,4,<b>x</b>\n';
    const parsed = parseGrowthDistrictCsv(content, states);
    expect(parsed.rows.map((row) => row.issues)).toEqual([
      ['STATE_UNKNOWN'], ['DISTRICT_CODE_INVALID'], ['DISTRICT_NAME_INVALID'], [], ['DISTRICT_CODE_DUPLICATE'], ['DISTRICT_NAME_INVALID'],
    ]);
  });

  it('stops the whole file for a missing column, an open quote, an empty file or too many rows', () => {
    expect(parseGrowthDistrictCsv('district_code,district_name\n1,x', states).fileProblems).toEqual(['IMPORT_COLUMN_MISSING:state']);
    expect(parseGrowthDistrictCsv('state,district_code,district_name\n"Odisha,1,x', states).fileProblems).toEqual(['IMPORT_CSV_UNTERMINATED_QUOTE']);
    expect(parseGrowthDistrictCsv('\n\n', states).fileProblems).toEqual(['IMPORT_FILE_EMPTY']);
    const many = ['state,district_code,district_name', ...Array.from({ length: GROWTH_DISTRICT_IMPORT_MAX_ROWS + 1 }, (_, index) => `Odisha,${index + 1},D${index}`)].join('\n');
    expect(parseGrowthDistrictCsv(many, states).fileProblems).toEqual(['IMPORT_TOO_MANY_ROWS']);
  });
});
