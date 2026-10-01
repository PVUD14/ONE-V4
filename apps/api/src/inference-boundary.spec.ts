/**
 * Contract: no request handler can reach the inference endpoint (ENG-20).
 *
 * CLAUDE.md: "No portal and no request handler calls an inference endpoint", and generation is a
 * job on the outbox pipeline. The adapter and the worker factory that wires it to the database
 * exist only for workers, so this fails the build if any non-test source under apps/ imports them,
 * reads the key's variable, or speaks the chat-completions path itself. The API may describe the
 * endpoint (configured, host, model) through persistence's `loadAiInferenceStatus`, which never
 * makes a call.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appsRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Anything that would let a handler make, or be wired to make, an inference call. */
const forbidden: readonly [string, RegExp][] = [
  ['the worker orchestrator module', /persistence\/src\/ai-workers(\.js)?['"]/],
  // ENG-23: the content factory's worker runs model calls; only its request and read module is the API's.
  ['the content factory worker', /persistence\/src\/(content-factory-worker|run-content-factory-worker)(\.js)?['"]/],
  ['the test fake endpoint', /ai-orchestration\/src\/testing\//],
  ['the inference adapter', /\bOpenAICompatibleProvider\b/],
  ['the environment adapter factory', /\binferenceProviderFromEnvironment\b/],
  ['the worker orchestrator factory', /\bcreateWorkerAiOrchestrator\b/],
  ['the orchestrator itself', /\bAiOrchestrator\b/],
  // Reading the variables, not naming them: the console's copy may say which variables exist.
  ['reading the endpoint key', /\benv(\.|\[['"])ONE_AI_API_KEY\b/],
  ['reading the endpoint address', /\benv(\.|\[['"])ONE_AI_BASE_URL\b/],
  ['a chat-completions call', /\/chat\/completions/],
];

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe('the inference boundary', () => {
  it('no non-test source in the API or the web app imports the adapter, the worker orchestrator or the endpoint variables', async () => {
    const files = [...await sources(join(appsRoot, 'api', 'src')), ...await sources(join(appsRoot, 'web', 'src'))];
    // The walk must actually find the code it guards, or this test proves nothing.
    expect(files.some((file) => file.endsWith('operations-ai.controller.ts'))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const [what, pattern] of forbidden) if (pattern.test(text)) violations.push(`${file.slice(appsRoot.length)}: ${what}`);
    }
    expect(violations).toEqual([]);
  });

  it('the scan would catch a handler that imported the worker orchestrator', () => {
    const offending = "import { createWorkerAiOrchestrator } from '@planthepath/persistence/src/ai-workers.js';";
    expect(forbidden.filter(([, pattern]) => pattern.test(offending)).map(([what]) => what)).toEqual([
      'the worker orchestrator module',
      'the worker orchestrator factory',
    ]);
    expect(forbidden.filter(([, pattern]) => pattern.test("import { runContentFactoryOnce } from '@planthepath/persistence/src/content-factory-worker.js';")).map(([what]) => what))
      .toEqual(['the content factory worker']);
    expect(forbidden.some(([, pattern]) => pattern.test("import { requestContentDraft } from '@planthepath/persistence/src/content-factory.js';"))).toBe(false);
    expect(forbidden.some(([, pattern]) => pattern.test('const key = process.env.ONE_AI_API_KEY;'))).toBe(true);
    expect(forbidden.some(([, pattern]) => pattern.test("const url = env['ONE_AI_BASE_URL'];"))).toBe(true);
  });
});
