/**
 * The institution export CSV writer (INST-08, INST-SR-13): formulas are neutralised on output,
 * quoting keeps every value in its column, and a compensation header cannot be written.
 */
import { describe, expect, it } from 'vitest';
import { csvCell, isForbiddenExportHeader, toCsv } from './institution-export-csv.js';

describe('csvCell', () => {
  it.each(['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tTab', '\rReturn'])('neutralises a formula-leading cell: %j', (value) => {
    expect(csvCell(value).startsWith(`"'`)).toBe(true);
  });

  it('quotes every text cell and doubles embedded quotes, so commas and line breaks stay inside the cell', () => {
    expect(csvCell('Rao, "Asha"\nCSE')).toBe('"Rao, ""Asha""\nCSE"');
    expect(csvCell('Plain')).toBe('"Plain"');
  });

  it('writes numbers as numbers, including negatives the server produced, and empties for missing values', () => {
    expect(csvCell(7)).toBe('7');
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(70.5)).toBe('70.5');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(Number.NaN)).toBe('""');
    expect(csvCell(true)).toBe('"Yes"');
  });
});

describe('toCsv', () => {
  it('writes a byte-order mark, a header and CRLF rows', () => {
    expect(toCsv(['A', 'B'], [['x', 1], ['=y', null]])).toBe('\uFEFF"A","B"\r\n"x",1\r\n"\'=y",""\r\n');
  });

  it('refuses a row that does not match the header', () => {
    expect(() => toCsv(['A', 'B'], [['x']])).toThrow();
  });

  it('refuses any compensation header, in any spelling', () => {
    for (const header of ['compensation_amount', 'Compensation amount', 'COMPENSATION_CURRENCY', 'compensation period', 'Compensation']) {
      expect(isForbiddenExportHeader(header)).toBe(true);
      expect(() => toCsv(['Student ID', header], [])).toThrow();
    }
    expect(isForbiddenExportHeader('Score')).toBe(false);
  });
});
