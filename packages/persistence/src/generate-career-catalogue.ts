/**
 * Writes data/careers/catalogue-v1.json from docs/ops/inputs/job-role-catalogue.md (OPS-08).
 *
 * The markdown is the source; the JSON is what the seed reads. Regenerate after any change
 * to the input: `corepack pnpm --filter @planthepath/persistence catalogue:generate`. The
 * career-catalogue-input test fails if the two differ.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildCareerCatalogueFile } from './career-catalogue-input.js';

const inputPath = fileURLToPath(new URL('../../../docs/ops/inputs/job-role-catalogue.md', import.meta.url));
const outputPath = fileURLToPath(new URL('../../../data/careers/catalogue-v1.json', import.meta.url));

const file = buildCareerCatalogueFile(await readFile(inputPath, 'utf8'));
await writeFile(outputPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ event: 'career.catalogue.generated', roles: file.roles.length, goals: file.goals.length }));
