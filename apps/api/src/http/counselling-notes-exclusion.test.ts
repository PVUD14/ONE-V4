/**
 * Counselling notes live in `staff_actions` (ADR-036), so any query over that table that does
 * not name the action types it wants would return them to whoever that endpoint serves. This
 * static check fails the build when a `FROM staff_actions` query appears in API or package
 * source without an `action_type` condition in the same SQL template, and when an employer
 * surface mentions staff actions or counselling at all.
 * Design: docs/architecture/counselling-notes-table-design.md ("Never exported, never aggregated").
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) found.push(path);
  }
  return found;
}

async function allSources(): Promise<{ path: string; text: string }[]> {
  const roots = [join(repoRoot, 'apps/api/src')];
  for (const pkg of await readdir(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (pkg.isDirectory()) roots.push(join(repoRoot, 'packages', pkg.name, 'src'));
  }
  const files: string[] = [];
  for (const root of roots) files.push(...await sourceFiles(root).catch(() => []));
  return Promise.all(files.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
}

describe('counselling notes stay out of every other staff-action query', () => {
  it('every FROM staff_actions query names the action types it reads', async () => {
    const offenders: string[] = [];
    let queries = 0;
    for (const { path, text } of await allSources()) {
      for (const match of text.matchAll(/FROM staff_actions\b/g)) {
        queries += 1;
        // The rest of the SQL template the match sits in.
        const end = text.indexOf('`', match.index);
        const statement = text.slice(match.index, end === -1 ? undefined : end);
        if (!/action_type/.test(statement)) offenders.push(path.slice(repoRoot.length) + ' @' + match.index);
      }
    }
    expect(queries).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });

  it('no employer surface reads staff actions or counselling notes', async () => {
    const employerFiles = (await allSources()).filter(({ path }) => /[\\/]employer[^\\/]*\.ts$/.test(path));
    expect(employerFiles.length).toBeGreaterThan(3);
    for (const { path, text } of employerFiles) {
      expect(/staff_actions|counselling/i.test(text), path).toBe(false);
    }
  });
});
