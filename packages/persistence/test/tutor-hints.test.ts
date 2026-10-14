/**
 * ENG-22, no database: what each shown hint level looks like to the student (AI hint, being written, or
 * the human hint for that level after a fallback or a timeout), and the lock on the sandbox set-up.
 */
import { describe, expect, it } from 'vitest';
import { composeHintEntries, type TutorHintRow } from '../src/tutor-hints.js';
import { TutorSandboxRefused, assertTutorSandboxTarget, isSampleAddress } from '../src/tutor-sandbox.js';

const ladder = ['Human nudge', 'Human strategy', 'Human worked step', 'Human near solution'];
const row = (level: number, change: Partial<TutorHintRow>): TutorHintRow => ({
  level, status: 'PENDING', fallbackReason: null, generatedText: null, expired: false, ...change,
});

describe('composeHintEntries', () => {
  it('shows ladder levels as written, and nothing without a ladder', () => {
    expect(composeHintEntries(ladder, 2, [])).toEqual({
      entries: [
        { level: 1, source: 'LADDER', state: 'SHOWN', text: 'Human nudge', fallback: null },
        { level: 2, source: 'LADDER', state: 'SHOWN', text: 'Human strategy', fallback: null },
      ],
      hints: ['Human nudge', 'Human strategy'],
    });
    expect(composeHintEntries(null, 2, [])).toEqual({ entries: [], hints: [] });
  });

  it('shows an AI hint the guard passed, labelled as the tutor\'s', () => {
    const { entries, hints } = composeHintEntries(ladder, 1, [row(1, { status: 'SHOWN', generatedText: 'AI nudge' })]);
    expect(entries).toEqual([{ level: 1, source: 'AI_TUTOR', state: 'SHOWN', text: 'AI nudge', fallback: null }]);
    expect(hints).toEqual(['AI nudge']);
  });

  it('shows "being written" inside the window, and the human hint once the window has passed', () => {
    expect(composeHintEntries(ladder, 1, [row(1, { status: 'GENERATING' })]).entries[0]).toEqual({ level: 1, source: 'AI_TUTOR', state: 'PENDING', text: null, fallback: null });
    // An older client reads `hints`: it gets the human hint for a pending level.
    expect(composeHintEntries(ladder, 1, [row(1, {})]).hints).toEqual(['Human nudge']);
    expect(composeHintEntries(ladder, 1, [row(1, { expired: true })]).entries[0]).toEqual({ level: 1, source: 'AI_TUTOR', state: 'FALLBACK', text: 'Human nudge', fallback: 'TIMED_OUT' });
  });

  it('never shows a refused reply: the human hint for that level, with why in plain terms', () => {
    const refused = composeHintEntries(ladder, 3, [
      row(1, { status: 'FALLBACK', fallbackReason: 'GUARD_REFUSED', generatedText: 'The answer is 42' }),
      row(2, { status: 'FALLBACK', fallbackReason: 'REDIRECTED', generatedText: 'Stay with the question' }),
      row(3, { status: 'FALLBACK', fallbackReason: 'GENERATION_FAILED' }),
    ]);
    expect(refused.entries.map((entry) => [entry.text, entry.fallback])).toEqual([
      ['Human nudge', 'CHECKS_FAILED'], ['Human strategy', 'NOT_A_HINT'], ['Human worked step', 'UNAVAILABLE'],
    ]);
    expect(JSON.stringify(refused)).not.toContain('42');
    expect(JSON.stringify(refused)).not.toContain('Stay with the question');
  });
});

describe('the tutor sandbox set-up lock', () => {
  const sandbox = { ONE_SANDBOX: 'true', NODE_ENV: 'development', DATABASE_URL: 'postgresql://one_sandbox:x@postgres-demo:5432/one_sandbox' };
  const refusal = (env: Record<string, string | undefined>) => {
    try { assertTutorSandboxTarget(env); return 'ALLOWED'; } catch (error) { return error instanceof TutorSandboxRefused ? 'REFUSED' : 'OTHER'; }
  };

  it('runs only against the sandbox database, on its own host, outside production', () => {
    expect(refusal(sandbox)).toBe('ALLOWED');
    expect(refusal({ ...sandbox, DATABASE_URL: 'postgresql://u:x@127.0.0.1:55432/local_sandbox' })).toBe('ALLOWED');
    expect(refusal({ ...sandbox, ONE_SANDBOX: undefined })).toBe('REFUSED');
    expect(refusal({ ...sandbox, NODE_ENV: 'production' })).toBe('REFUSED');
    expect(refusal({ ...sandbox, DATABASE_URL: 'postgresql://u:x@postgres-demo:5432/planthepath_uat' })).toBe('REFUSED');
    expect(refusal({ ...sandbox, DATABASE_URL: 'postgresql://u:x@postgres:5432/one_sandbox' })).toBe('REFUSED');
    expect(refusal({ ...sandbox, DATABASE_URL: 'not a url' })).toBe('REFUSED');
  });

  it('never prints the password in a refusal', () => {
    try { assertTutorSandboxTarget({ ...sandbox, DATABASE_URL: 'postgresql://u:secret-value@postgres:5432/prod' }); } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret-value');
    }
  });

  it('knows a sample address from a real one', () => {
    for (const email of ['student1@demo.oneby8.com', 'a@lakeview.example', 'x@learning.test', 'y@example.com']) expect(isSampleAddress(email)).toBe(true);
    for (const email of ['someone@gmail.com', 'ops@oneby8.com', 'a@demo.oneby8.com.evil.in']) expect(isSampleAddress(email)).toBe(false);
  });
});
