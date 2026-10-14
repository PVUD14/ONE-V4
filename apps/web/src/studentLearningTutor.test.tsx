/**
 * Web tests for the AI tutor in practice (ENG-22): no AI control unless the tutor is the student's to use;
 * "Ask the AI tutor" requests the next level and the screen polls while the hint is written by a job; an AI
 * hint is labelled as AI with what that means; a refused or late AI hint shows the written hint for that level
 * and says why; the daily cap and the language gap are explained; written hints keep working throughout.
 * The API is stubbed with synthetic rows.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { AI_HINT_NOTE, StudentLearningPlan } from './studentLearning.js';

type Tutor = { available: boolean; reason: string | null; remainingToday: number | null };
type Entry = { level: number; source: 'LADDER' | 'AI_TUTOR'; state: 'SHOWN' | 'PENDING' | 'FALLBACK'; text: string | null; fallback: string | null };

const question = (hints: readonly string[], tutor: Tutor | undefined, hintDetails?: readonly Entry[]) => ({
  id: 'q-1', prompt: 'Synthetic question: which option?', position: 1, hintsAvailable: true, hints,
  options: [{ id: 'a', text: 'Option A' }, { id: 'b', text: 'Option B' }],
  ...(tutor ? { tutor } : {}), ...(hintDetails ? { hintDetails } : {}),
});
const inProgress = (q: unknown) => ({
  decisionId: 'd-1', decidedAt: '2026-10-02T00:00:00.000Z', action: 'PRACTICE', skill: { id: 's-1', name: 'Arithmetic' },
  strategyKind: null, reasonCodes: ['GAP_PARTIAL'], adaptive: false, lessons: [], practice: { status: 'IN_PROGRESS', questionsAnswered: 0, question: q },
});
const path = (latestStep: unknown) => ({
  adaptive: false, target: { careerRoleId: 'role-1', title: 'Synthetic role' }, requirements: { total: 1, met: 0, notMeasured: 0 },
  groups: { policyVersion: 'learning-path-groups-v1', skip: [], review: [], learn: [] }, dueReviews: [], latestStep,
});

type Route = { readonly status?: number; readonly body: unknown };
let calls: { path: string; method: string }[] = [];

function stub(routes: Readonly<Record<string, Route | Route[]>>): void {
  calls = [];
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const routePath = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = init?.method ?? 'GET';
    calls.push({ path: routePath, method });
    const queue = queues.get(`${routePath}:${method}`) ?? queues.get(routePath);
    const route = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    const status = route?.status ?? 200;
    return { ok: status < 400, status, headers: new Headers(), json: async () => route?.body ?? {} };
  }));
}

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}

const base = {
  '/api/v1/learning/placement-test': { body: { placement: { status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' } } },
  '/api/v1/students/me/learning-actions': { body: {} },
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('the AI tutor in practice (ENG-22)', () => {
  it('shows no AI control while the tutor is off, without consent, or from an older API — written hints still work', async () => {
    for (const tutor of [{ available: false, reason: 'OFF', remainingToday: null }, { available: false, reason: 'NO_CONSENT', remainingToday: null }, undefined]) {
      stub({ ...base, '/api/v1/learning/path': { body: { path: path(inProgress(question([], tutor))) } } });
      await authenticate();
      render(<StudentLearningPlan />);
      expect(await screen.findByRole('button', { name: /Show hint 1 · Nudge/ })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /Ask the AI tutor/ })).toBeNull();
      expect(screen.queryByText('AI')).toBeNull();
      cleanup();
    }
  });

  it('asks for the next level, shows it being written, polls, then shows the AI hint labelled as AI', async () => {
    const available = { available: true, reason: null, remainingToday: 20 };
    const pendingStep = inProgress(question(['Written nudge'], { available: false, reason: 'PENDING', remainingToday: 19 },
      [{ level: 1, source: 'AI_TUTOR', state: 'PENDING', text: null, fallback: null }]));
    const shownStep = inProgress(question(['AI nudge text'], { available: true, reason: null, remainingToday: 19 },
      [{ level: 1, source: 'AI_TUTOR', state: 'SHOWN', text: 'AI nudge text', fallback: null }]));
    stub({
      ...base,
      '/api/v1/learning/path': { body: { path: path(inProgress(question([], available))) } },
      '/api/v1/learning/steps/d-1/tutor-hints:POST': { status: 202, body: { step: pendingStep } },
      '/api/v1/learning/steps/d-1:GET': { body: { step: shownStep } },
    });
    await authenticate();
    render(<StudentLearningPlan />);
    const ask = await screen.findByRole('button', { name: /Ask the AI tutor for hint 1 · Nudge/ });
    expect(screen.getByText(/never the answer\. It counts like a written hint\. AI hints left today: 20\./)).toBeInTheDocument();
    fireEvent.click(ask);
    expect(await screen.findByText('The AI tutor is writing this hint…')).toBeInTheDocument();
    // While it is written, neither hint control can climb another level.
    expect(screen.getByRole('button', { name: /Show hint 2 · Strategy/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Ask the AI tutor for hint 2/ })).toBeDisabled();
    const shown = await screen.findByLabelText('AI hint 1', {}, { timeout: 5000 });
    expect(within(shown).getByText(/AI nudge text/)).toBeInTheDocument();
    expect(within(shown).getByText('AI hint')).toBeInTheDocument();
    expect(within(shown).getByText(AI_HINT_NOTE)).toBeInTheDocument();
    expect(calls.filter((call) => call.path === '/api/v1/learning/steps/d-1/tutor-hints' && call.method === 'POST')).toHaveLength(1);
    expect(calls.some((call) => call.path === '/api/v1/learning/steps/d-1' && call.method === 'GET')).toBe(true);
  });

  it('a refused or late AI hint shows the written hint for that level, and says why', async () => {
    const fallbackStep = inProgress(question(['Written nudge', 'Written strategy'], { available: true, reason: null, remainingToday: 18 }, [
      { level: 1, source: 'AI_TUTOR', state: 'FALLBACK', text: 'Written nudge', fallback: 'CHECKS_FAILED' },
      { level: 2, source: 'AI_TUTOR', state: 'FALLBACK', text: 'Written strategy', fallback: 'TIMED_OUT' },
    ]));
    stub({ ...base, '/api/v1/learning/path': { body: { path: path(fallbackStep) } } });
    await authenticate();
    render(<StudentLearningPlan />);
    const hints = await screen.findByLabelText('Hints shown');
    expect(within(hints).getByText('Written nudge')).toBeInTheDocument();
    expect(within(hints).getByText('The AI hint did not pass ONE’s checks, so this is the written hint for this level.')).toBeInTheDocument();
    expect(within(hints).getByText('The AI tutor took too long, so this is the written hint for this level.')).toBeInTheDocument();
    expect(within(hints).queryByText('AI hint')).toBeNull();
  });

  it('explains the daily cap and the language gap, and keeps the written hints', async () => {
    for (const [reason, text] of [['DAILY_LIMIT', 'You have used today’s AI hints. The written hints still work.'],
      ['LANGUAGE_NOT_SUPPORTED', 'The AI tutor does not write in your language yet. The written hints still work.']] as const) {
      stub({ ...base, '/api/v1/learning/path': { body: { path: path(inProgress(question([], { available: false, reason, remainingToday: reason === 'DAILY_LIMIT' ? 0 : 20 }))) } } });
      await authenticate();
      render(<StudentLearningPlan />);
      expect(await screen.findByRole('button', { name: /Ask the AI tutor for hint 1/ })).toBeDisabled();
      expect(screen.getByText(new RegExp(text.slice(0, 30)))).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Show hint 1 · Nudge/ })).toBeEnabled();
      cleanup();
    }
  });

  it('X2 (ENG-25): a no-tutor or AI-off student walks a practice step to the end with the written hints, and never sees the tutor', async () => {
    // A no-tutor-group student gets exactly the AI-off view from the server: reason OFF, nothing counted.
    const off = { available: false, reason: 'OFF', remainingToday: null };
    const second = { ...question([], off), id: 'q-2', position: 2, prompt: 'Synthetic question two: which option?' };
    const hinted = inProgress(question(['Written nudge'], off, [{ level: 1, source: 'LADDER', state: 'SHOWN', text: 'Written nudge', fallback: null }]));
    const onSecond = { ...inProgress(second), practice: { status: 'IN_PROGRESS', questionsAnswered: 1, question: second } };
    const finished = { ...inProgress(second), practice: { status: 'COMPLETED', questionsAnswered: 2 } };
    stub({
      ...base,
      '/api/v1/learning/path': { body: { path: path(inProgress(question([], off))) } },
      '/api/v1/learning/steps/d-1/hints:POST': { status: 201, body: { step: hinted } },
      '/api/v1/learning/steps/d-1/answers:POST': [
        { status: 201, body: { feedback: { questionId: 'q-1', correct: true, assisted: false }, step: onSecond } },
        { status: 201, body: { feedback: { questionId: 'q-2', correct: false, assisted: false }, step: finished } },
      ],
    });
    await authenticate();
    render(<StudentLearningPlan />);
    fireEvent.click(await screen.findByRole('button', { name: /Show hint 1 · Nudge/ }));
    expect(await screen.findByText('Written nudge')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ask the AI tutor/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('Option B'));
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByText('Synthetic question two: which option?')).toBeInTheDocument();
    expect(screen.getByText('Right.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ask the AI tutor/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('Option A'));
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByText(/Step finished: you answered 2 questions/)).toBeInTheDocument();
    // No AI control, no AI label, no AI count, no empty widget, at any point.
    expect(screen.queryByText('AI')).toBeNull();
    expect(screen.queryByText(/AI tutor|AI hints left/)).toBeNull();
    expect(calls.some((call) => call.path.endsWith('/tutor-hints'))).toBe(false);
  });
});
