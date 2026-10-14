/**
 * Validates an aptitude bank pack (ENG-10) and prints its tagging and coverage report. No
 * database: this is the check a reviewer or CI runs on the data file itself.
 *
 * Why this exists: ENG-10 requires a validation script that checks tagging completeness — every
 * item has an answer key and at least one misconception-tagged distractor, tags only on wrong
 * options and only with codes of the item's own skill, every code used — plus the editors' own
 * rules, so an imported draft can be submitted without edits.
 *
 * Usage: corepack pnpm --filter @planthepath/persistence aptitude:validate [path/to/pack.json]
 * Exits 1 when the pack has any problem.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summariseAptitudeBankPack, validateAptitudeBankPack, type AptitudeBankPack } from './aptitude-bank.js';

const packPath = process.argv[2]
  ? resolve(process.argv[2])
  : new URL('../../../data/engine/aptitude-bank-v1.draft.json', import.meta.url);
const pack = JSON.parse(await readFile(packPath, 'utf8')) as AptitudeBankPack;
const problems = validateAptitudeBankPack(pack);
console.log(JSON.stringify({ valid: problems.length === 0, summary: summariseAptitudeBankPack(pack), problems }, null, 2));
if (problems.length) process.exit(1);
