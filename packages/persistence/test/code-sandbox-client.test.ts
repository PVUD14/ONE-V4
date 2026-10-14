/**
 * ENG-12 unit tests for the code sandbox client and grader (no network, no database): the endpoint from
 * the environment, how a Piston answer is read, how each kind of run is classified (code-grader-v1),
 * how transport failures map onto stable codes that carry no sandbox text, and that a case hitting the
 * time limit stops the rest.
 */
import { describe, expect, it } from 'vitest';
import {
  CODE_SANDBOX_LIMITS,
  CodeSandboxError,
  classifyRun,
  codeSandboxConfigFromEnvironment,
  gradeInSandbox,
  normaliseOutput,
  parseSandboxAnswer,
  runInSandbox,
  type FetchLike,
  type SandboxRunResult,
} from '../src/code-sandbox-client.js';

const ok = (overrides: Partial<SandboxRunResult> = {}): SandboxRunResult => ({
  stdout: '5\n', code: 0, signal: null, status: null, wallTimeMs: 80, cpuTimeMs: 60, memoryBytes: 5_000_000, ...overrides,
});

const answer = (run: Record<string, unknown>, status = 200): FetchLike => async () => ({
  status,
  json: async () => ({ language: 'python', version: '3.12.0', run }),
});

const config = { baseUrl: 'http://sandbox.internal:2000', token: 'test-only-token' };

describe('codeSandboxConfigFromEnvironment', () => {
  it('is null when the URL is blank or not http(s), so the worker records SANDBOX_UNAVAILABLE', () => {
    expect(codeSandboxConfigFromEnvironment({})).toBeNull();
    expect(codeSandboxConfigFromEnvironment({ ONE_CODE_SANDBOX_URL: '   ' })).toBeNull();
    expect(codeSandboxConfigFromEnvironment({ ONE_CODE_SANDBOX_URL: 'ftp://sandbox' })).toBeNull();
    expect(codeSandboxConfigFromEnvironment({ ONE_CODE_SANDBOX_URL: 'not a url' })).toBeNull();
  });

  it('trims the trailing slash and keeps the token only when set', () => {
    expect(codeSandboxConfigFromEnvironment({ ONE_CODE_SANDBOX_URL: 'http://10.0.1.5:2000/' })).toEqual({ baseUrl: 'http://10.0.1.5:2000', token: null });
    expect(codeSandboxConfigFromEnvironment({ ONE_CODE_SANDBOX_URL: 'https://sandbox', ONE_CODE_SANDBOX_TOKEN: ' t ' })).toEqual({ baseUrl: 'https://sandbox', token: 't' });
  });
});

describe('normaliseOutput', () => {
  it('ignores line-ending style, trailing spaces per line and trailing blank lines, nothing else', () => {
    expect(normaliseOutput('1 2  \r\n3\t\n\n\n')).toBe('1 2\n3');
    expect(normaliseOutput(' 1')).toBe(' 1');
    expect(normaliseOutput('a\n\nb')).toBe('a\n\nb');
  });
});

describe('classifyRun (code-grader-v1)', () => {
  it('passes only a clean exit whose output matches', () => {
    expect(classifyRun(ok(), '5')).toBe('PASSED');
    expect(classifyRun(ok({ stdout: '5\r\n\n' }), '5\n')).toBe('PASSED');
    expect(classifyRun(ok({ stdout: '6\n' }), '5')).toBe('WRONG_OUTPUT');
  });

  it('names time, output and memory limits', () => {
    expect(classifyRun(ok({ status: 'TO', signal: 'SIGKILL', code: null }), '5')).toBe('TIME_LIMIT');
    expect(classifyRun(ok({ status: 'OL', signal: 'SIGKILL', code: null }), '5')).toBe('OUTPUT_LIMIT');
    expect(classifyRun(ok({ status: 'EL', signal: 'SIGKILL', code: null }), '5')).toBe('OUTPUT_LIMIT');
    // What the attack suite saw for a memory bomb: exit 137 at the cgroup ceiling.
    expect(classifyRun(ok({ status: 'RE', code: 137, memoryBytes: CODE_SANDBOX_LIMITS.runMemoryBytes - 1_000 }), '5')).toBe('MEMORY_LIMIT');
    expect(classifyRun(ok({ status: 'SG', signal: 'SIGKILL', code: null, memoryBytes: CODE_SANDBOX_LIMITS.runMemoryBytes }), '5')).toBe('MEMORY_LIMIT');
  });

  it('treats any other failure as a runtime error, even with the right output', () => {
    expect(classifyRun(ok({ code: 1, status: 'RE' }), '5')).toBe('RUNTIME_ERROR');
    expect(classifyRun(ok({ status: 'SG', signal: 'SIGSEGV', code: null }), '5')).toBe('RUNTIME_ERROR');
    expect(classifyRun(ok({ status: 'RE', code: 137, memoryBytes: 10_000_000 }), '5')).toBe('RUNTIME_ERROR');
  });
});

describe('parseSandboxAnswer', () => {
  it('reads the runtime and measurements', () => {
    const run = parseSandboxAnswer({ language: 'python', version: '3.12.0', run: { stdout: 'x', code: 0, signal: null, status: null, wall_time: 9, cpu_time: 7, memory: 100 } });
    expect(run).toEqual({ runtime: 'python 3.12.0', result: { stdout: 'x', code: 0, signal: null, status: null, wallTimeMs: 9, cpuTimeMs: 7, memoryBytes: 100 } });
  });

  it('turns isolate\'s internal error and unknown shapes into SANDBOX_ERROR', () => {
    expect(() => parseSandboxAnswer({ language: 'python', version: '3.12.0', run: { status: 'XX', message: 'internal' } })).toThrow(CodeSandboxError);
    expect(() => parseSandboxAnswer({ message: 'something' })).toThrow(CodeSandboxError);
    expect(() => parseSandboxAnswer(null)).toThrow(CodeSandboxError);
  });
});

describe('runInSandbox', () => {
  it('sends the program, the input, the v1 limits and the token, and nothing else', async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return { status: 200, json: async () => ({ language: 'python', version: '3.12.0', run: { stdout: '5\n', code: 0, signal: null, status: null } }) };
    };
    await runInSandbox(config, { language: 'python', languageVersion: '3.12.0', source: 'print(5)', stdin: '2 3', fetch });
    expect(seen).toEqual([{
      url: 'http://sandbox.internal:2000/api/v2/execute',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-only-token' },
      body: {
        language: 'python', version: '3.12.0', files: [{ name: 'main.py', content: 'print(5)' }], stdin: '2 3',
        run_timeout: 5000, run_cpu_time: 3000, run_memory_limit: 134217728,
      },
    }]);
  });

  it('maps transport failures onto stable codes with no upstream text', async () => {
    const codeOf = async (fetch: FetchLike): Promise<string> => {
      try {
        await runInSandbox(config, { language: 'python', languageVersion: '3.12.0', source: 'x', stdin: '', fetch });
        return 'no error';
      } catch (error) {
        expect(error).toBeInstanceOf(CodeSandboxError);
        expect((error as Error).message).not.toMatch(/ECONNREFUSED|runtime is unknown|configured limit/);
        return (error as CodeSandboxError).code;
      }
    };
    expect(await codeOf(async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:2000'); })).toBe('SANDBOX_UNAVAILABLE');
    expect(await codeOf(answer({}, 502))).toBe('SANDBOX_UNAVAILABLE');
    expect(await codeOf(answer({}, 401))).toBe('SANDBOX_UNAVAILABLE');
    expect(await codeOf(async () => ({ status: 400, json: async () => ({ message: 'python-9 runtime is unknown' }) }))).toBe('SANDBOX_REJECTED');
    expect(await codeOf(async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } }))).toBe('SANDBOX_ERROR');
  });
});

describe('gradeInSandbox', () => {
  it('grades every case and passes only when all pass', async () => {
    const outputs = ['5\n', '9\n'];
    let call = 0;
    const fetch: FetchLike = async () => {
      const stdout = outputs[call++]!;
      return { status: 200, json: async () => ({ language: 'python', version: '3.12.0', run: { stdout, code: 0, signal: null, status: null, wall_time: 50, cpu_time: 40, memory: 1 } }) };
    };
    const graded = await gradeInSandbox(config, {
      language: 'python', languageVersion: '3.12.0', source: 'x',
      testCases: [{ stdin: '2 3', expectedStdout: '5' }, { stdin: '4 4', expectedStdout: '8' }], fetch,
    });
    expect(graded).toMatchObject({ passed: 1, total: 2, verdict: 'FAILED', runtime: 'python 3.12.0' });
    expect(graded.cases.map((entry) => entry.outcome)).toEqual(['PASSED', 'WRONG_OUTPUT']);
  });

  it('stops after a time limit: the remaining cases are NOT_RUN and the sandbox is not called again', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls += 1;
      return { status: 200, json: async () => ({ language: 'python', version: '3.12.0', run: { stdout: '', code: null, signal: 'SIGKILL', status: 'TO', wall_time: 5100 } }) };
    };
    const graded = await gradeInSandbox(config, {
      language: 'python', languageVersion: '3.12.0', source: 'while True: pass',
      testCases: [{ stdin: '', expectedStdout: '1' }, { stdin: '', expectedStdout: '2' }, { stdin: '', expectedStdout: '3' }], fetch,
    });
    expect(calls).toBe(1);
    expect(graded.cases.map((entry) => entry.outcome)).toEqual(['TIME_LIMIT', 'NOT_RUN', 'NOT_RUN']);
    expect(graded.cases[1]).toMatchObject({ exitCode: null, signal: null, wallTimeMs: null });
    expect(graded).toMatchObject({ passed: 0, total: 3, verdict: 'FAILED' });
  });

  it('gives up as SANDBOX_UNAVAILABLE when a slow sandbox would run past the job budget (inside the outbox lease)', async () => {
    let clock = 0;
    const fetch: FetchLike = async () => {
      clock += 30_000; // each run takes 30 s: the third case would start past the 45 s budget
      return { status: 200, json: async () => ({ language: 'python', version: '3.12.0', run: { stdout: '1\n', code: 0, signal: null, status: null } }) };
    };
    await expect(gradeInSandbox(config, {
      language: 'python', languageVersion: '3.12.0', source: 'print(1)', fetch, now: () => clock,
      testCases: [{ stdin: '', expectedStdout: '1' }, { stdin: '', expectedStdout: '1' }, { stdin: '', expectedStdout: '1' }],
    })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });
});
