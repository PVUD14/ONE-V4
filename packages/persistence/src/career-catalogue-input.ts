/**
 * Reads the job-role catalogue input (OPS-08) and builds the seed file from it.
 *
 * `docs/ops/inputs/job-role-catalogue.md` is the transcription of Appendix 4 and the one
 * source; `data/careers/catalogue-v1.json` is generated from it by
 * `generate-career-catalogue.ts`, and a test re-parses the markdown on every run so the two
 * cannot drift. Counts are checked here, not trusted: a table cell lost in transcription
 * fails loudly instead of seeding a thinner catalogue.
 *
 * Design: docs/architecture/career-catalogue-table-design.md
 */

export type CatalogueFamilyCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface CatalogueRoleInput {
  readonly code: string;
  readonly title: string;
  readonly family: { readonly code: CatalogueFamilyCode; readonly label: string };
  readonly typicalBranches: readonly string[];
  readonly coreSkillAreas: string;
  readonly mainEvidence: string;
  /** The planned release of a full track; null for "Selectable". Planning data, not a label. */
  readonly plannedRelease: 'V1' | 'V2' | 'V3' | null;
}

export interface CatalogueGoalInput {
  readonly code: string;
  readonly title: string;
  readonly goalType: string;
  readonly linksToRoles: string;
  readonly mainEvidence: string;
  readonly release: string;
  /** No goal model exists yet (design doc): goals are recorded, not stored. */
  readonly stored: false;
}

export interface CareerCatalogueFile {
  readonly catalogue: string;
  readonly version: string;
  readonly source: string;
  readonly note: string;
  /** Starter role code (data/careers/starter-v1.json) → the catalogue row it is. */
  readonly starterMappings: Readonly<Record<string, string>>;
  readonly roles: readonly CatalogueRoleInput[];
  readonly goals: readonly CatalogueGoalInput[];
}

export const catalogueFamilies: Readonly<Record<CatalogueFamilyCode, string>> = {
  A: 'Software, IT and product',
  B: 'Data, AI and cybersecurity',
  C: 'Electronics, electrical and instrumentation',
  D: 'Mechanical, manufacturing, chemical and process',
  E: 'Civil and construction',
  F: 'Business, finance, sales and operations',
};

const familyByPrefix: Readonly<Record<string, CatalogueFamilyCode>> = {
  S: 'A', D: 'B', C: 'B', E: 'C', L: 'C', M: 'D', P: 'D', V: 'E', B: 'F',
};

/** Program rule B.3: the counts the transcription must reproduce. */
export const expectedCatalogueCounts = {
  roles: 108,
  byPrefix: { S: 25, D: 9, C: 9, E: 13, L: 7, M: 14, P: 6, V: 11, B: 14 } as Readonly<Record<string, number>>,
  goals: 13,
  // Appendix 4 §H: 1 in V1, 13 in V2, 38 in V3; the other 56 stay selectable.
  byPlannedRelease: { V1: 1, V2: 13, V3: 38, SELECTABLE: 56 } as Readonly<Record<string, number>>,
};

/** Decided in the design doc: each starter role is the catalogue row named here. */
export const starterCatalogueMappings: Readonly<Record<string, string>> = {
  SOC_ANALYST: 'C01',
  SOFTWARE_ENGINEER: 'S01',
  DATA_ANALYST: 'D01',
  BUSINESS_ANALYST: 'S21',
  CUSTOMER_SUCCESS: 'B11',
};

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function plannedRelease(value: string, code: string): CatalogueRoleInput['plannedRelease'] {
  switch (value) {
    case 'V1 verified': return 'V1';
    case 'V2 verified': return 'V2';
    case 'V3 verified': return 'V3';
    case 'Selectable': return null;
    default: throw new Error(`catalogue row ${code} has an unrecognised release "${value}"`);
  }
}

/** Parse the input markdown into roles and goals, and verify every count. */
export function parseJobRoleCatalogue(markdown: string): { readonly roles: readonly CatalogueRoleInput[]; readonly goals: readonly CatalogueGoalInput[] } {
  const roles: CatalogueRoleInput[] = [];
  const goals: CatalogueGoalInput[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const role = /^\|\s*([SDCELMPVB]\d{2})\s*\|/.exec(line);
    if (role) {
      const [code, title, branches, skills, evidence, release] = cells(line);
      if (!code || !title || !branches || !skills || !evidence || !release || cells(line).length !== 6) {
        throw new Error(`catalogue row ${role[1]} does not have six cells`);
      }
      const familyCode = familyByPrefix[code[0]!]!;
      roles.push({
        code,
        title,
        family: { code: familyCode, label: catalogueFamilies[familyCode] },
        typicalBranches: branches.split(',').map((branch) => branch.trim()).filter(Boolean),
        coreSkillAreas: skills,
        mainEvidence: evidence,
        plannedRelease: plannedRelease(release, code),
      });
      continue;
    }
    const goal = /^\|\s*(G\d{2})\s*\|/.exec(line);
    if (goal) {
      const [code, title, goalType, links, evidence, release] = cells(line);
      if (!code || !title || !goalType || !links || !evidence || !release || cells(line).length !== 6) {
        throw new Error(`catalogue goal ${goal[1]} does not have six cells`);
      }
      goals.push({ code, title, goalType, linksToRoles: links, mainEvidence: evidence, release, stored: false });
    }
  }
  verifyCatalogueCounts(roles, goals);
  return { roles, goals };
}

export function verifyCatalogueCounts(roles: readonly CatalogueRoleInput[], goals: readonly CatalogueGoalInput[]): void {
  const problems: string[] = [];
  if (roles.length !== expectedCatalogueCounts.roles) problems.push(`${roles.length} roles, expected ${expectedCatalogueCounts.roles}`);
  const codes = new Set(roles.map((role) => role.code));
  if (codes.size !== roles.length) problems.push('duplicate role codes');
  for (const [prefix, expected] of Object.entries(expectedCatalogueCounts.byPrefix)) {
    const found = roles.filter((role) => role.code.startsWith(prefix)).length;
    if (found !== expected) problems.push(`${found} ${prefix} roles, expected ${expected}`);
    // Codes run 01..N with no gap, so a lost row cannot hide behind a duplicated one.
    for (let index = 1; index <= expected; index += 1) {
      const code = `${prefix}${String(index).padStart(2, '0')}`;
      if (!codes.has(code)) problems.push(`missing ${code}`);
    }
  }
  for (const [release, expected] of Object.entries(expectedCatalogueCounts.byPlannedRelease)) {
    const found = roles.filter((role) => (role.plannedRelease ?? 'SELECTABLE') === release).length;
    if (found !== expected) problems.push(`${found} ${release} roles, expected ${expected}`);
  }
  const goalCodes = goals.map((goal) => goal.code);
  const expectedGoals = Array.from({ length: expectedCatalogueCounts.goals }, (_, index) => `G${String(index + 1).padStart(2, '0')}`);
  if (goalCodes.join(',') !== expectedGoals.join(',')) problems.push(`goals ${goalCodes.join(',')}, expected G01–G13`);
  for (const code of Object.values(starterCatalogueMappings)) if (!codes.has(code)) problems.push(`starter mapping to missing ${code}`);
  if (problems.length) throw new Error(`job-role catalogue failed verification: ${problems.join('; ')}`);
}

/** The seed file, exactly as `data/careers/catalogue-v1.json` must contain it. */
export function buildCareerCatalogueFile(markdown: string): CareerCatalogueFile {
  const { roles, goals } = parseJobRoleCatalogue(markdown);
  return {
    catalogue: 'ONE job-role catalogue',
    version: 'catalogue-v1',
    source: 'docs/ops/inputs/job-role-catalogue.md (Appendix 4, revision 11)',
    note: 'Generated from the source file by packages/persistence/src/generate-career-catalogue.ts; do not edit by hand. '
      + 'plannedRelease is the plan, not a label: every role seeds as SELECTABLE. Core skill areas are drafts. '
      + 'Goals are recorded but not stored until the engine plan\'s goal model exists.',
    starterMappings: starterCatalogueMappings,
    roles,
    goals,
  };
}
