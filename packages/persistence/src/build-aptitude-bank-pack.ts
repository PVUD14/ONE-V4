/**
 * Writes the aptitude bank pack (ENG-10) to data/engine/aptitude-bank-v1.draft.json from its
 * authoring source in src/aptitude-bank-content/, refusing if the pack does not validate.
 *
 * Why this exists: the data file is reviewed and imported; the source is where it is written.
 * Rebuilding after any source edit keeps them identical (a test fails if they drift).
 *
 * Usage: corepack pnpm --filter @planthepath/persistence aptitude:build-pack
 */
import { writeFile } from 'node:fs/promises';
import { validateAptitudeBankPack } from './aptitude-bank.js';
import { buildAptitudeBankPack } from './aptitude-bank-content/index.js';

const pack = buildAptitudeBankPack();
const problems = validateAptitudeBankPack(pack);
if (problems.length) {
  console.error(JSON.stringify({ valid: false, problems }, null, 2));
  process.exit(1);
}
const target = new URL('../../../data/engine/aptitude-bank-v1.draft.json', import.meta.url);
await writeFile(target, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ written: 'data/engine/aptitude-bank-v1.draft.json', skills: pack.skills.length, misconceptions: pack.misconceptions.length, items: pack.items.length }));
