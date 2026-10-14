/**
 * Web tests for "Ask ONE to explain" (ADR-052): off → the existing empty state, saying plainly it is not
 * available; asking shows "Your lesson is being prepared" and polls until the job is done; a lesson always
 * carries "AI-generated — not checked by a person"; refused, blocked and withdrawn lessons show a plain
 * sentence and no text; "Report a mistake" sends a reason and marks the lesson Reported. Also the operations
 * review panel: withdraw needs a reason; promote creates a draft. The API is stubbed with synthetic rows.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EXPLAIN_LABEL, EXPLAIN_NOT_AVAILABLE_TEXT, EXPLAIN_REFUSED_TEXT, StudentExplainPage } from './studentExplain.js';
import { ExplainLessonsPanel } from './rolePortal/explainLessonsReview.js';

type Route = { readonly status?: number; readonly body: unknown };
let calls: { path: string; method: string; body: unknown }[] = [];

function stub(routes: Readonly<Record<string, Route | Route[]>>): void {
  calls = [];
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const routePath = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = init?.method ?? 'GET';
    calls.push({ path: routePath, method, body: init?.body ? JSON.parse(String(init.body)) : null });
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

const limits = { topicMin: 3, topicMax: 120, perDay: 10, reportNoteMax: 300 };
const on = { body: { availability: { available: true, reason: null, remainingToday: 10, limits } } };
const lesson = {
  label: EXPLAIN_LABEL, title: 'synthetic topic', generatedAt: '2026-10-10T10:00:00.000Z', promptVersion: 'explain-topic@1',
  sections: [{ heading: 'What you will learn', text: 'Synthetic learning goal.' }, { heading: 'Explanation', text: 'Synthetic explanation text.' }],
};
const request = (state: string, extra: Record<string, unknown> = {}) => ({
  id: 'r-1', topic: 'Synthetic topic', askedAt: '2026-10-10T10:00:00.000Z', state, notAvailable: null, servedFromCache: false, reported: false, lesson: null, ...extra,
});

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('Ask ONE to explain (ADR-052)', () => {
  it('while the feature is off shows the empty state, saying plainly it is not available — no form, no list', async () => {
    stub({ '/api/v1/learning/explain/status': { body: { availability: { available: false, reason: 'OFF', remainingToday: null, limits } } } });
    await authenticate();
    render(<StudentExplainPage />);
    expect(await screen.findByRole('heading', { name: 'Ask ONE to explain is not available yet' })).toBeVisible();
    expect(screen.queryByLabelText('Topic to explain')).toBeNull();
    expect(calls.some((call) => call.path === '/api/v1/learning/explain/requests')).toBe(false);
  });

  it('asking shows "Your lesson is being prepared", polls, then shows the lesson with its label', async () => {
    stub({
      '/api/v1/learning/explain/status': on,
      '/api/v1/learning/explain/requests': { body: { requests: [] } },
      '/api/v1/learning/explain:POST': { status: 202, body: { request: request('PREPARING') } },
      '/api/v1/learning/explain/requests/r-1': { body: { request: request('READY', { lesson }) } },
    });
    await authenticate();
    render(<StudentExplainPage />);
    fireEvent.change(await screen.findByLabelText('Topic to explain'), { target: { value: 'Synthetic topic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(await screen.findByText(/Your lesson is being prepared/u)).toBeVisible();
    expect(calls.filter((call) => call.method === 'POST')).toEqual([{ path: '/api/v1/learning/explain', method: 'POST', body: { topic: 'Synthetic topic' } }]);
    expect(await screen.findByLabelText('Lesson label', {}, { timeout: 6000 })).toHaveTextContent(EXPLAIN_LABEL);
    expect(screen.getByRole('heading', { name: 'Explanation' })).toBeVisible();
    expect(screen.getByText('Synthetic explanation text.')).toBeVisible();
    expect(calls.some((call) => call.path === '/api/v1/learning/explain/requests/r-1' && call.method === 'GET')).toBe(true);
  }, 10_000);

  it('a refused, blocked or withdrawn lesson shows a plain sentence and no lesson text', async () => {
    const cases = [
      [request('REFUSED'), EXPLAIN_REFUSED_TEXT],
      [request('NOT_AVAILABLE', { notAvailable: 'CHECKS_FAILED' }), EXPLAIN_NOT_AVAILABLE_TEXT.CHECKS_FAILED],
      [request('NOT_AVAILABLE', { notAvailable: 'WITHDRAWN' }), EXPLAIN_NOT_AVAILABLE_TEXT.WITHDRAWN],
    ] as const;
    for (const [entry, text] of cases) {
      stub({ '/api/v1/learning/explain/status': on, '/api/v1/learning/explain/requests': { body: { requests: [entry] } } });
      await authenticate();
      render(<StudentExplainPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Open Synthetic topic' }));
      expect(await screen.findByText(text)).toBeVisible();
      expect(screen.queryByLabelText('Lesson label')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Report a mistake' })).toBeNull();
      cleanup();
    }
  });

  it('"Report a mistake" sends the reason and note, then shows Reported', async () => {
    stub({
      '/api/v1/learning/explain/status': on,
      '/api/v1/learning/explain/requests': { body: { requests: [request('READY', { lesson })] } },
      '/api/v1/learning/explain/requests/r-1/report:POST': { status: 201, body: { request: request('READY', { lesson, reported: true }) } },
    });
    await authenticate();
    render(<StudentExplainPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Synthetic topic' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Report a mistake' }));
    fireEvent.change(screen.getByLabelText('What is wrong'), { target: { value: 'CONFUSING' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'The example skips a step.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/You reported this lesson/u)).toBeVisible();
    expect(screen.getAllByText('Reported').length).toBeGreaterThan(0);
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ reasonCode: 'CONFUSING', note: 'The example skips a step.' });
  });

  it('a refusal from the API (daily limit) is shown in its own words', async () => {
    stub({
      '/api/v1/learning/explain/status': on,
      '/api/v1/learning/explain/requests': { body: { requests: [] } },
      '/api/v1/learning/explain:POST': { status: 429, body: { error: { code: 'EXPLAIN_DAILY_LIMIT', message: 'You have asked for 10 lessons today. You can ask again tomorrow.', correlationId: 'c-1' } } },
    });
    await authenticate();
    render(<StudentExplainPage />);
    fireEvent.change(await screen.findByLabelText('Topic to explain'), { target: { value: 'Another topic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You have asked for 10 lessons today. You can ask again tomorrow.');
  });
});

describe('Ask ONE to explain — operations review (Content Management)', () => {
  const row = {
    id: 'l-1', topic: 'synthetic topic', status: 'READY', reviewState: 'FLAGGED', requests: 4, reports: 1, reportReasons: { WRONG_FACT: 1 }, reportNotes: ['One date is wrong.'],
    text: 'Synthetic lesson text.', model: 'synthetic-model', servedModel: 'synthetic-model', promptVersion: 'explain-topic@1', generatorVersion: 'g', guardVersion: 'explain-guard-v1',
    generatedAt: '2026-10-10T10:00:00.000Z', reviewReasonCode: null, reviewedAt: null, promotedLessonId: null,
  };
  const list = (viewer: { canWithdraw: boolean; canPromote: boolean }) => ({
    body: { lessons: [row], counts: { ready: 1, flagged: 1, withdrawn: 0, promoted: 0, blocked: 0, refused: 0 }, viewer,
      reasons: { withdraw: ['FACTUALLY_WRONG', 'UNSAFE'], promote: ['WORTH_OFFICIAL_LESSON'] } },
  });

  it('shows flagged lessons with reports and no student identity; withdraw needs a reason', async () => {
    stub({
      '/api/v1/operations/explain-lessons': list({ canWithdraw: true, canPromote: false }),
      '/api/v1/operations/explain-lessons/l-1/withdraw:POST': { status: 201, body: { lesson: { id: 'l-1', reviewState: 'WITHDRAWN' } } },
    });
    render(<ExplainLessonsPanel token="ops-token" />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('synthetic topic')).toBeVisible();
    expect(within(table).getByText('“One date is wrong.”')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Promote to official draft…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose why the lesson is withdrawn.');
    fireEvent.change(screen.getByLabelText('Why withdraw synthetic topic'), { target: { value: 'FACTUALLY_WRONG' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/no longer shown to any student/u);
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ path: '/api/v1/operations/explain-lessons/l-1/withdraw', body: { reasonCode: 'FACTUALLY_WRONG' } });
  });

  it('promote creates an official draft from the editor\'s key, title, level and style', async () => {
    stub({
      '/api/v1/operations/explain-lessons': list({ canWithdraw: false, canPromote: true }),
      '/api/v1/operations/explain-lessons/l-1/promote:POST': { status: 201, body: { lesson: { id: 'l-1', reviewState: 'PROMOTED', lessonId: 'x', revisionId: 'y' } } },
    });
    render(<ExplainLessonsPanel token="ops-token" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Promote to official draft…' }));
    fireEvent.change(screen.getByLabelText('Lesson title'), { target: { value: 'Synthetic official lesson' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/now a draft in Lessons/u);
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      reasonCode: 'WORTH_OFFICIAL_LESSON', stableKey: 'explain-synthetic-topic', title: 'Synthetic official lesson', level: 'STANDARD', style: 'EXPLANATION',
    });
  });

  it('is hidden from anyone the API refuses', async () => {
    stub({ '/api/v1/operations/explain-lessons': { status: 403, body: { error: { code: 'FORBIDDEN', correlationId: 'c' } } } });
    const { container } = render(<ExplainLessonsPanel token="ops-token" />);
    await vi.waitFor(() => expect(container.innerHTML).toBe(''));
  });
});
