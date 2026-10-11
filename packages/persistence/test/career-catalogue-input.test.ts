/**
 * The job-role catalogue input (OPS-08, program rule B.3): the transcription of Appendix 4
 * must hold exactly 108 roles (S 25, D 9, C 9, E 13, L 7, M 14, P 6, V 11, B 14), 13 goals
 * and the planned-release split §H states, and the seed file must be exactly what the
 * input generates — so a lost table cell or a hand edit fails here, not in a student's list.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildCareerCatalogueFile, parseJobRoleCatalogue, starterCatalogueMappings } from '../src/career-catalogue-input.js';

const inputUrl = new URL('../../../docs/ops/inputs/job-role-catalogue.md', import.meta.url);
const seedUrl = new URL('../../../data/careers/catalogue-v1.json', import.meta.url);

describe('job-role catalogue input', () => {
  it('holds 108 roles in the counts program rule B.3 names, and G01–G13', async () => {
    const { roles, goals } = parseJobRoleCatalogue(await readFile(inputUrl, 'utf8'));
    expect(roles).toHaveLength(108);
    const byPrefix = Object.fromEntries(['S', 'D', 'C', 'E', 'L', 'M', 'P', 'V', 'B'].map((prefix) => [prefix, roles.filter((role) => role.code.startsWith(prefix)).length]));
    expect(byPrefix).toEqual({ S: 25, D: 9, C: 9, E: 13, L: 7, M: 14, P: 6, V: 11, B: 14 });
    expect(goals.map((goal) => goal.code)).toEqual(Array.from({ length: 13 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`));
    expect(goals.every((goal) => goal.stored === false)).toBe(true);
  });

  it('keeps the plan (1 V1, 13 V2, 38 V3, 56 selectable) separate from any label', async () => {
    const { roles } = parseJobRoleCatalogue(await readFile(inputUrl, 'utf8'));
    const count = (release: string | null) => roles.filter((role) => role.plannedRelease === release).length;
    expect([count('V1'), count('V2'), count('V3'), count(null)]).toEqual([1, 13, 38, 56]);
    expect(roles.find((role) => role.plannedRelease === 'V1')?.code).toBe('C01');
    // The V2 list in §H, exactly.
    expect(roles.filter((role) => role.plannedRelease === 'V2').map((role) => role.code).sort())
      .toEqual(['B02', 'B05', 'C02', 'D01', 'E01', 'L01', 'M01', 'M02', 'S01', 'S02', 'S06', 'S13', 'V01']);
  });

  it('puts each role in its Appendix 4 family and keeps branch wording as written', async () => {
    const { roles } = parseJobRoleCatalogue(await readFile(inputUrl, 'utf8'));
    const role = (code: string) => roles.find((entry) => entry.code === code)!;
    expect(role('C01')).toMatchObject({ title: 'SOC Analyst L1', family: { code: 'B' }, typicalBranches: ['CSE', 'IT', 'ECE'] });
    expect(role('D05').typicalBranches).toEqual(['CSE', 'IT', 'ECE', 'maths-strong branches']);
    expect(role('E12').typicalBranches).toEqual(['EEE', 'Instrumentation', 'ECE', 'Mechanical']);
    expect(role('L01').family.code).toBe('C');
    expect(role('P06').family.code).toBe('D');
    expect(role('V11').family.code).toBe('E');
    expect(role('B14')).toMatchObject({ title: 'Procurement Analyst', family: { code: 'F' }, typicalBranches: ['All branches'] });
  });

  it('refuses a transcription with a lost row', async () => {
    const markdown = (await readFile(inputUrl, 'utf8')).split('\n').filter((line) => !line.startsWith('| M07 ')).join('\n');
    expect(() => parseJobRoleCatalogue(markdown)).toThrow(/missing M07/);
  });

  it('maps every starter role onto a catalogue row that exists', async () => {
    const { roles } = parseJobRoleCatalogue(await readFile(inputUrl, 'utf8'));
    expect(starterCatalogueMappings).toEqual({ SOC_ANALYST: 'C01', SOFTWARE_ENGINEER: 'S01', DATA_ANALYST: 'D01', BUSINESS_ANALYST: 'S21', CUSTOMER_SUCCESS: 'B11' });
    for (const code of Object.values(starterCatalogueMappings)) expect(roles.some((role) => role.code === code)).toBe(true);
  });

  it('has a seed file that is exactly what the input generates', async () => {
    const expected = buildCareerCatalogueFile(await readFile(inputUrl, 'utf8'));
    expect(JSON.parse(await readFile(seedUrl, 'utf8'))).toEqual(JSON.parse(JSON.stringify(expected)));
  });
});
