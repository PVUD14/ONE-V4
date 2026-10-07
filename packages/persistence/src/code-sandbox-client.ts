/**
 * The code sandbox client and grader (ENG-12): how the worker talks to Piston, and how one run is
 * classified. Worker-only.
 *
 * Why this exists: ADR-034 §6 puts untrusted code on an isolated Piston VM reached only by the outbox
 * worker. This module is the whole of that conversation — the limits ONE asks for
 * (`code-sandbox-limits-v1`), one HTTP call per test case with a deadline, the mapping of anything that
 * goes wrong onto a stable failure code, and the pure grading rule (`code-grader-v1`). It never returns
 * the sandbox's own text to a caller: only codes and measurements leave it.
 *
 * Nothing under apps/ imports this; the API only queues (code-submissions.ts).
 * Design: docs/architecture/code-sandbox-design.md.
 */

export const CODE_SANDBOX_RUNNER = 'piston' as const;
export const CODE_SANDBOX_LIMITS_VERSION = 'code-sandbox-limits-v1' as const;
export const CODE_GRADER_VERSION = 'code-grader-v1' as const;

/** code-sandbox-limits-v1. deploy/sandbox/docker-compose.yml sets Piston's ceilings to the same values. */
export const CODE_SANDBOX_LIMITS = {
  runTimeoutMs: 5_000,
  runCpuTimeMs: 3_000,
  runMemoryBytes: 134_217_728,
} as const;

/** HTTP deadline for one run: the wall limit plus queueing and transport. */
export const CODE_SANDBOX_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Budget for a whole submission, kept inside the outbox lease (60 s) so a slow sandbox can never make a
 * second worker pick the event up while the first is still running it.
 */
export const CODE_SANDBOX_JOB_BUDGET_MS = 45_000;

export type CodeCaseOutcome = 'PASSED' | 'WRONG_OUTPUT' | 'RUNTIME_ERROR' | 'TIME_LIMIT' | 'MEMORY_LIMIT' | 'OUTPUT_LIMIT' | 'NOT_RUN';
export type CodeSandboxFailureCode = 'SANDBOX_UNAVAILABLE' | 'SANDBOX_ERROR' | 'SANDBOX_REJECTED';

type Environment = Readonly<Record<string, string | undefined>>;

export interface CodeSandboxConfig {
  readonly baseUrl: string;
  readonly token: string | null;
}

/**
 * The sandbox endpoint from the worker's environment. Blank URL = no sandbox (every job ends
 * SANDBOX_UNAVAILABLE). A URL that is not http(s) is treated the same way rather than guessed at.
 */
export function codeSandboxConfigFromEnvironment(env: Environment): CodeSandboxConfig | null {
  const raw = env.ONE_CODE_SANDBOX_URL?.trim() ?? '';
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const token = env.ONE_CODE_SANDBOX_TOKEN?.trim() ?? '';
  return { baseUrl: url.toString().replace(/\/+$/, ''), token: token || null };
}

/** The fields of a Piston v2 run this module reads. Anything else in the answer is ignored. */
export interface SandboxRunResult {
  readonly stdout: string;
  readonly code: number | null;
  readonly signal: string | null;
  /** Piston/isolate status: null on a normal exit; TO, OL, EL, RE, SG or XX otherwise. */
  readonly status: string | null;
  readonly wallTimeMs: number | null;
  readonly cpuTimeMs: number | null;
  readonly memoryBytes: number | null;
}

export interface SandboxRun {
  readonly result: SandboxRunResult;
  /** "python 3.12.0", as Piston reported the runtime it used. */
  readonly runtime: string;
}

export class CodeSandboxError extends Error {
  constructor(readonly code: CodeSandboxFailureCode) {
    super(`code sandbox: ${code}`);
    this.name = 'CodeSandboxError';
  }
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  readonly status: number;
  json(): Promise<unknown>;
}>;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads a Piston answer defensively; a shape it does not recognise is a sandbox error. */
export function parseSandboxAnswer(body: unknown): SandboxRun {
  if (!body || typeof body !== 'object') throw new CodeSandboxError('SANDBOX_ERROR');
  const record = body as Record<string, unknown>;
  const run = record.run;
  if (!run || typeof run !== 'object') throw new CodeSandboxError('SANDBOX_ERROR');
  const fields = run as Record<string, unknown>;
  const status = stringOrNull(fields.status);
  if (status === 'XX') throw new CodeSandboxError('SANDBOX_ERROR');
  const language = typeof record.language === 'string' ? record.language : '';
  const version = typeof record.version === 'string' ? record.version : '';
  const runtime = `${language} ${version}`.trim().slice(0, 64);
  if (!runtime) throw new CodeSandboxError('SANDBOX_ERROR');
  return {
    runtime,
    result: {
      stdout: typeof fields.stdout === 'string' ? fields.stdout : '',
      code: numberOrNull(fields.code),
      signal: stringOrNull(fields.signal),
      status,
      wallTimeMs: numberOrNull(fields.wall_time),
      cpuTimeMs: numberOrNull(fields.cpu_time),
      memoryBytes: numberOrNull(fields.memory),
    },
  };
}

/**
 * Runs one program on one input. Throws CodeSandboxError only: unreachable, timed out or a 5xx is
 * SANDBOX_UNAVAILABLE; a 4xx (the sandbox refused the request — a limits or runtime mismatch) is
 * SANDBOX_REJECTED; an answer it cannot read, or isolate's internal error, is SANDBOX_ERROR.
 */
export async function runInSandbox(config: CodeSandboxConfig, input: {
  readonly language: string;
  readonly languageVersion: string;
  readonly source: string;
  readonly stdin: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}): Promise<SandboxRun> {
  const doFetch: FetchLike = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  const body = JSON.stringify({
    language: input.language,
    version: input.languageVersion,
    files: [{ name: 'main.py', content: input.source }],
    stdin: input.stdin,
    run_timeout: CODE_SANDBOX_LIMITS.runTimeoutMs,
    run_cpu_time: CODE_SANDBOX_LIMITS.runCpuTimeMs,
    run_memory_limit: CODE_SANDBOX_LIMITS.runMemoryBytes,
  });
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(`${config.baseUrl}/api/v2/execute`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(input.timeoutMs ?? CODE_SANDBOX_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CodeSandboxError('SANDBOX_UNAVAILABLE');
  }
  if (response.status >= 500 || response.status === 401 || response.status === 403 || response.status === 404 || response.status === 429) {
    // A wrong token or path is a deployment problem, not something the student sent: unavailable.
    throw new CodeSandboxError('SANDBOX_UNAVAILABLE');
  }
  if (response.status >= 400) throw new CodeSandboxError('SANDBOX_REJECTED');
  if (response.status !== 200) throw new CodeSandboxError('SANDBOX_ERROR');
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new CodeSandboxError('SANDBOX_ERROR');
  }
  return parseSandboxAnswer(parsed);
}

/**
 * Compares output the way a person reading it would: CRLF and CR become LF, spaces and tabs at the end
 * of each line are ignored, and so are trailing blank lines. Everything else must match exactly.
 */
export function normaliseOutput(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
}

/** code-grader-v1: one run's outcome. Pure. */
export function classifyRun(result: SandboxRunResult, expectedStdout: string): Exclude<CodeCaseOutcome, 'NOT_RUN'> {
  if (result.status === 'TO') return 'TIME_LIMIT';
  if (result.status === 'OL' || result.status === 'EL') return 'OUTPUT_LIMIT';
  const killed = result.signal === 'SIGKILL' || result.code === 137;
  if (killed && result.memoryBytes !== null && result.memoryBytes >= CODE_SANDBOX_LIMITS.runMemoryBytes * 0.95) return 'MEMORY_LIMIT';
  if (result.code !== 0 || result.signal !== null || result.status !== null) return 'RUNTIME_ERROR';
  return normaliseOutput(result.stdout) === normaliseOutput(expectedStdout) ? 'PASSED' : 'WRONG_OUTPUT';
}

export interface GradedCase {
  readonly caseIndex: number;
  readonly outcome: CodeCaseOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly wallTimeMs: number | null;
  readonly cpuTimeMs: number | null;
  readonly memoryBytes: number | null;
}

export interface GradedSubmission {
  readonly cases: readonly GradedCase[];
  readonly passed: number;
  readonly total: number;
  readonly verdict: 'PASSED' | 'FAILED';
  readonly runtime: string;
}

const SIGNAL = /^SIG[A-Z0-9]{1,12}$/;

function measured(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.round(value));
}

/**
 * Runs every case in order and grades the submission. A case that hits the time limit stops the rest
 * (they are NOT_RUN), so a hostile program costs one time limit, not eight. Throws CodeSandboxError
 * if the sandbox fails on any case — a partly graded run is not a grade.
 */
export async function gradeInSandbox(config: CodeSandboxConfig, input: {
  readonly language: string;
  readonly languageVersion: string;
  readonly source: string;
  readonly testCases: readonly { readonly stdin: string; readonly expectedStdout: string }[];
  readonly fetch?: FetchLike;
  /** Whole-submission budget; defaults to CODE_SANDBOX_JOB_BUDGET_MS. Exhausted = SANDBOX_UNAVAILABLE. */
  readonly budgetMs?: number;
  readonly now?: () => number;
}): Promise<GradedSubmission> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? CODE_SANDBOX_JOB_BUDGET_MS);
  const cases: GradedCase[] = [];
  let runtime = '';
  let stopped = false;
  for (const [index, testCase] of input.testCases.entries()) {
    if (stopped) {
      cases.push({ caseIndex: index + 1, outcome: 'NOT_RUN', exitCode: null, signal: null, wallTimeMs: null, cpuTimeMs: null, memoryBytes: null });
      continue;
    }
    // A sandbox too slow to finish inside the budget is, for this job, not available.
    const remaining = deadline - now();
    if (remaining < 1_000) throw new CodeSandboxError('SANDBOX_UNAVAILABLE');
    const run = await runInSandbox(config, {
      language: input.language, languageVersion: input.languageVersion, source: input.source, stdin: testCase.stdin,
      timeoutMs: Math.min(CODE_SANDBOX_REQUEST_TIMEOUT_MS, remaining),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    runtime = run.runtime;
    const outcome = classifyRun(run.result, testCase.expectedStdout);
    cases.push({
      caseIndex: index + 1,
      outcome,
      exitCode: run.result.code,
      signal: run.result.signal && SIGNAL.test(run.result.signal) ? run.result.signal : null,
      wallTimeMs: measured(run.result.wallTimeMs),
      cpuTimeMs: measured(run.result.cpuTimeMs),
      memoryBytes: measured(run.result.memoryBytes),
    });
    if (outcome === 'TIME_LIMIT') stopped = true;
  }
  const passed = cases.filter((entry) => entry.outcome === 'PASSED').length;
  return { cases, passed, total: cases.length, verdict: passed === cases.length ? 'PASSED' : 'FAILED', runtime };
}
