/**
 * ADR-052 contract: "Ask ONE to explain" can never count toward anything. Its persistence module and its
 * worker name none of the tables readiness, skill state, attempts, evidence, mastery or placement live in,
 * and no code outside this area (other than privacy export, deletion and the purge plan, which must) reads
 * its tables — so no employer, institution or readiness path can see an explain lesson.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const persistenceSrc = fileURLToPath(new URL('../src/', import.meta.url));
const appsRoot = fileURLToPath(new URL('../../../apps/', import.meta.url));

const countingTables = [
  'learning_attempt_events', 'evidence_records', 'mastery_projections', 'learner_skill_state', 'readiness_snapshots', 'readiness_factors',
  'learner_progress', 'placement_tests', 'placement_test_items', 'roadmap_actions', 'career_gap_snapshots', 'assessment_attempts',
];
const explainTables = /\bexplain_(lessons|topic_requests|lesson_reports)\b/u;

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (/\.(ts|tsx)$/u.test(entry.name) && !/\.(test|spec)\.tsx?$/u.test(entry.name)) found.push(path);
  }
  return found;
}

describe('the explain boundary', () => {
  it('the explain module and its worker never name a table that counts', async () => {
    for (const file of ['explain-topic.ts', 'explain-topic-worker.ts']) {
      const text = await readFile(join(persistenceSrc, file), 'utf8');
      const code = text.replace(/\/\*\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
      for (const table of countingTables) expect(code.includes(table), `${file} names ${table}`).toBe(false);
    }
  });

  it('only the explain area, privacy export and deletion, and the purge classification read the explain tables', async () => {
    const allowed = new Set([
      'packages/persistence/src/explain-topic.ts', 'packages/persistence/src/explain-topic-worker.ts', 'packages/persistence/src/institution-contract.ts',
      'apps/api/src/http/privacy-export-sections.ts', 'apps/api/src/http/privacy-deletion.ts',
    ]);
    const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const files = [...await sources(persistenceSrc), ...await sources(join(appsRoot, 'api', 'src')), ...await sources(join(appsRoot, 'web', 'src'))];
    expect(files.length).toBeGreaterThan(100);
    const readers = [];
    for (const file of files) {
      if (explainTables.test(await readFile(file, 'utf8'))) readers.push(file.slice(repositoryRoot.length).replaceAll('\\', '/'));
    }
    expect(readers.filter((file) => !allowed.has(file))).toEqual([]);
    expect(readers).toContain('packages/persistence/src/explain-topic.ts');
  });

  it('no institution or employer controller imports the explain module', async () => {
    const http = join(appsRoot, 'api', 'src', 'http');
    for (const file of (await readdir(http)).filter((name) => /^(institution|employer)-.*\.ts$/u.test(name) && !/\.(test|spec)\.ts$/u.test(name))) {
      expect(await readFile(join(http, file), 'utf8'), file).not.toMatch(/explain-topic/u);
    }
  });
});
