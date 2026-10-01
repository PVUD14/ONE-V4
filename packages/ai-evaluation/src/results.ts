/**
 * Reads a bake-off results file (written by deploy/ai-pod/bake-off/run_bakeoff.py) strictly, and
 * checks it belongs to the evaluation set this repository builds (ENG-21).
 *
 * Why this exists: the importer turns a results file into records that can let a model reach
 * students, so a file from another set version, a partial smoke run, a duplicated case or a
 * hand-edited shape must be refused with a reason, never half-imported.
 *
 * Design: docs/architecture/ai-bake-off-design.md (Decision 7).
 */
import { contentSha256 } from './build-set.js';
import { evaluationTasks, type EvaluationSet, type EvaluationTask } from './set-format.js';

export const RESULTS_FORMAT = 'one-bakeoff-results';
export const RESULTS_FORMAT_VERSION = 1;

export type BakeOffResultsErrorCode =
  | 'RESULTS_MALFORMED'
  | 'RESULTS_SET_MISMATCH'
  | 'RESULTS_CASES_MISMATCH'
  | 'RESULTS_MODEL_INVALID'
  | 'RESULTS_PARTIAL';

export class BakeOffResultsError extends Error {
  constructor(readonly code: BakeOffResultsErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'BakeOffResultsError';
  }
}

export interface CaseResult {
  readonly id: string;
  readonly task: EvaluationTask;
  /** The reply text; null when the request failed. */
  readonly output: string | null;
  readonly finishReason: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly attempts: number;
  /** An ENG-20 failure class (PROVIDER_TIMEOUT, …) or null. */
  readonly error: string | null;
}

export interface BatchResult {
  readonly task: EvaluationTask;
  readonly cases: number;
  readonly wallSeconds: number;
  readonly concurrency: number;
}

export interface BakeOffResults {
  readonly format: typeof RESULTS_FORMAT;
  readonly formatVersion: typeof RESULTS_FORMAT_VERSION;
  readonly harnessVersion: string;
  readonly set: { readonly key: string; readonly version: number; readonly sha256: string };
  readonly model: string;
  readonly providerKey: string;
  readonly options: { readonly concurrency: number; readonly timeoutSeconds: number; readonly maxAttempts: number; readonly chatTemplateKwargs: Readonly<Record<string, unknown>> | null };
  readonly partial: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly batches: readonly BatchResult[];
  readonly cases: readonly CaseResult[];
}

const failureClassPattern = /^PROVIDER_[A-Z_]{2,40}$/u;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function malformed(detail: string): never {
  throw new BakeOffResultsError('RESULTS_MALFORMED', detail);
}

function object(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) malformed(`${where} is not an object`);
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in record));
  if (extra.length || missing.length) malformed(`${where} has unexpected or missing fields`);
  return record;
}

function count(value: unknown, where: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) malformed(`${where} is not a whole number >= ${min}`);
  return value;
}

function text(value: unknown, where: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') malformed(`${where} is not text`);
  return value;
}

function task(value: unknown, where: string): EvaluationTask {
  if (!(evaluationTasks as readonly unknown[]).includes(value)) malformed(`${where} is not a known task`);
  return value as EvaluationTask;
}

/** Parse and validate the shape. Does not compare against the set (see `matchResultsToSet`). */
export function readBakeOffResults(raw: unknown): BakeOffResults {
  const top = object(raw, 'the results file', [
    'format', 'formatVersion', 'harnessVersion', 'set', 'model', 'providerKey', 'options', 'partial', 'startedAt', 'finishedAt', 'batches', 'cases',
  ]);
  if (top.format !== RESULTS_FORMAT || top.formatVersion !== RESULTS_FORMAT_VERSION) malformed('not a one-bakeoff-results v1 file');
  const set = object(top.set, 'set', ['key', 'version', 'sha256']);
  if (typeof set.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(set.sha256)) malformed('set.sha256 is not a SHA-256');
  const options = object(top.options, 'options', ['concurrency', 'timeoutSeconds', 'maxAttempts', 'chatTemplateKwargs']);
  if (options.chatTemplateKwargs !== null && (typeof options.chatTemplateKwargs !== 'object' || Array.isArray(options.chatTemplateKwargs))) {
    malformed('options.chatTemplateKwargs is not an object or null');
  }
  if (typeof top.partial !== 'boolean') malformed('partial is not a boolean');
  for (const key of ['startedAt', 'finishedAt'] as const) {
    if (typeof top[key] !== 'string' || !isoPattern.test(top[key] as string)) malformed(`${key} is not a UTC timestamp`);
  }
  const model = text(top.model, 'model')!;
  if (model.trim() !== model || model.length < 1 || model.length > 200) {
    throw new BakeOffResultsError('RESULTS_MODEL_INVALID', 'the model name must be 1-200 characters with no surrounding spaces');
  }
  const providerKey = text(top.providerKey, 'providerKey')!;
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(providerKey)) malformed('providerKey does not fit ai_evaluations.provider_key');
  if (!Array.isArray(top.batches) || !Array.isArray(top.cases)) malformed('batches and cases must be lists');

  const batches = top.batches.map((value, index): BatchResult => {
    const batch = object(value, `batches[${index}]`, ['task', 'cases', 'wallSeconds', 'concurrency']);
    if (typeof batch.wallSeconds !== 'number' || !Number.isFinite(batch.wallSeconds) || batch.wallSeconds <= 0) malformed(`batches[${index}].wallSeconds is not a positive number`);
    return { task: task(batch.task, `batches[${index}].task`), cases: count(batch.cases, `batches[${index}].cases`, 1), wallSeconds: batch.wallSeconds, concurrency: count(batch.concurrency, `batches[${index}].concurrency`, 1) };
  });
  const cases = top.cases.map((value, index): CaseResult => {
    const where = `cases[${index}]`;
    const entry = object(value, where, ['id', 'task', 'output', 'finishReason', 'promptTokens', 'completionTokens', 'latencyMs', 'attempts', 'error']);
    const error = text(entry.error, `${where}.error`, true);
    if (error !== null && !failureClassPattern.test(error)) malformed(`${where}.error is not a failure class`);
    const output = text(entry.output, `${where}.output`, true);
    if ((error === null) === (output === null)) malformed(`${where} must have exactly one of output and error`);
    return {
      id: text(entry.id, `${where}.id`)!, task: task(entry.task, `${where}.task`), output, error,
      finishReason: text(entry.finishReason, `${where}.finishReason`, true),
      promptTokens: count(entry.promptTokens, `${where}.promptTokens`), completionTokens: count(entry.completionTokens, `${where}.completionTokens`),
      latencyMs: count(entry.latencyMs, `${where}.latencyMs`), attempts: count(entry.attempts, `${where}.attempts`),
    };
  });

  return {
    format: RESULTS_FORMAT, formatVersion: RESULTS_FORMAT_VERSION, harnessVersion: text(top.harnessVersion, 'harnessVersion')!,
    set: { key: text(set.key, 'set.key')!, version: count(set.version, 'set.version', 1), sha256: set.sha256 },
    model, providerKey,
    options: {
      concurrency: count(options.concurrency, 'options.concurrency', 1), timeoutSeconds: count(options.timeoutSeconds, 'options.timeoutSeconds', 1),
      maxAttempts: count(options.maxAttempts, 'options.maxAttempts', 1), chatTemplateKwargs: options.chatTemplateKwargs as Record<string, unknown> | null,
    },
    partial: top.partial, startedAt: top.startedAt as string, finishedAt: top.finishedAt as string, batches, cases,
  };
}

/**
 * The results belong to exactly this set: same key, version and SHA-256 of the file text; every case
 * once, with its task; one batch per task covering its cases. A partial (smoke) run is refused.
 */
export function matchResultsToSet(results: BakeOffResults, set: EvaluationSet, setText: string): void {
  if (results.set.key !== set.setKey || results.set.version !== set.setVersion || results.set.sha256 !== contentSha256(setText)) {
    throw new BakeOffResultsError('RESULTS_SET_MISMATCH', `the results are for ${results.set.key} v${results.set.version}, not the set this repository builds (${set.setKey} v${set.setVersion}, or its content changed)`);
  }
  if (results.partial) throw new BakeOffResultsError('RESULTS_PARTIAL', 'a --limit smoke run cannot be scored or recorded');
  const expected = new Map(set.cases.map((entry) => [entry.id, entry.task]));
  const seen = new Set<string>();
  for (const entry of results.cases) {
    if (seen.has(entry.id)) throw new BakeOffResultsError('RESULTS_CASES_MISMATCH', `case ${entry.id} appears twice`);
    seen.add(entry.id);
    if (expected.get(entry.id) !== entry.task) throw new BakeOffResultsError('RESULTS_CASES_MISMATCH', `case ${entry.id} is not in the set with task ${entry.task}`);
  }
  if (seen.size !== expected.size) throw new BakeOffResultsError('RESULTS_CASES_MISMATCH', `${expected.size - seen.size} case(s) of the set have no result`);
  for (const taskKey of evaluationTasks) {
    const batch = results.batches.filter((entry) => entry.task === taskKey);
    const cases = set.cases.filter((entry) => entry.task === taskKey).length;
    if (batch.length !== 1 || batch[0]!.cases !== cases) throw new BakeOffResultsError('RESULTS_CASES_MISMATCH', `the ${taskKey} batch does not cover its ${cases} cases`);
  }
}
