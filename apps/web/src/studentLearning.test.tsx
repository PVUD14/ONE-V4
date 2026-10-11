/**
 * Web tests for the student learning experience (ENG-18): the path in skip / review / learn groups (C1) with
 * "not enough evidence" labels (C3), due reviews first and shown without a date (C7), one next step with its
 * reasons in plain words (C4), practice with the hint ladder and the assisted warning, the placement test, the
 * Practice page's skill card, and honest hidden / empty / error states. The API is stubbed with synthetic rows; no
 * readiness value, score or model number is ever rendered.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { PlacementCard, PracticeBySkillCard, StudentLearningPlan } from './studentLearning.js';

const entry = (skillId: string, skillName: string, over: Record<string, unknown> = {}) => ({
  skillId, skillName, requirementLevel: 'ESSENTIAL', gapStatus: 'UNKNOWN', band: 'NOT_ENOUGH_EVIDENCE', due: false, reasonCodes: ['GAP_UNKNOWN'], ...over,
});

const question = (hints: readonly string[], hintsAvailable = true) => ({
  id: 'q-1', prompt: 'Synthetic question: which option?', position: 1, hintsAvailable, hints,
  options: [{ id: 'a', text: 'Option A' }, { id: 'b', text: 'Option B' }],
});

const step = (practice: unknown, over: Record<string, unknown> = {}) => ({
  decisionId: 'd-1', decidedAt: '2026-09-29T00:00:00.000Z', action: 'PRACTICE', skill: { id: 's-partial', name: 'Log triage' },
  strategyKind: null, reasonCodes: ['GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'NON_ADAPTIVE_NO_CONSENT'], adaptive: false, lessons: [], practice, ...over,
});

const path = (over: Record<string, unknown> = {}) => ({
  adaptive: false,
  target: { careerRoleId: 'role-1', title: 'Security Operations Analyst' },
  requirements: { total: 4, met: 1, notMeasured: 2 },
  groups: {
    policyVersion: 'learning-path-groups-v1',
    skip: [entry('s-met', 'Networking basics', { gapStatus: 'MET', reasonCodes: ['ALREADY_MET'], band: 'DEMONSTRATED' })],
    review: [entry('s-partial', 'Log triage', { gapStatus: 'PARTIAL', reasonCodes: ['GAP_PARTIAL'] })],
    learn: [entry('s-new', 'Incident reporting')],
  },
  dueReviews: [],
  latestStep: null,
  ...over,
});

type Route = { readonly status?: number; readonly body: unknown };
let calls: { path: string; method: string; body: unknown }[] = [];

function stub(routes: Readonly<Record<string, Route | Route[]>>): void {
  calls = [];
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const routePath = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = init?.method ?? 'GET';
    calls.push({ path: routePath, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
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

const notAvailable = { body: { placement: { status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' } } };

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('student learning plan', () => {
  it('shows the path in review / learn / skip groups with evidence labels, and no numbers beyond counts (C1, C3)', async () => {
    stub({ '/api/v1/learning/path': { body: { path: path() } }, '/api/v1/learning/placement-test': notAvailable });
    await authenticate();
    render(<StudentLearningPlan />);
    const review = await screen.findByLabelText('Review group');
    expect(within(review).getByText('Log triage')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Learn group')).getByText('Incident reporting')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Skip group')).getByText('Networking basics')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Learn group')).getByText('Not enough evidence')).toBeInTheDocument();
    expect(screen.queryByText('Developing')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 4 requirements met · 2 not measured yet')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/%|readiness score|likelihood/i);
    // Not adaptive: there are no due reviews to show, so that card is not drawn; the placement test says why it is not open.
    expect(screen.queryByRole('region', { name: 'Due for review' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
    expect(await screen.findByText(/Not open yet — the placement test adapts to your answers/)).toBeInTheDocument();
  });

  it('puts due reviews first, marked due with no date (C7)', async () => {
    stub({
      '/api/v1/learning/path': { body: { path: path({
        adaptive: true,
        groups: { policyVersion: 'learning-path-groups-v1', skip: [], learn: [],
          review: [entry('s-due', 'Packet analysis', { due: true, reasonCodes: ['DUE_REVIEW'], gapStatus: 'MET' }), entry('s-partial', 'Log triage', { reasonCodes: ['GAP_PARTIAL'] })] },
        dueReviews: [{ skillId: 's-due', skillName: 'Packet analysis' }],
      }) } },
      '/api/v1/learning/placement-test': notAvailable,
    });
    await authenticate();
    render(<StudentLearningPlan />);
    const review = await screen.findByLabelText('Review group');
    expect(within(review).getAllByText(/Packet analysis|Log triage/).map((node) => node.textContent)).toEqual(['Packet analysis', 'Log triage']);
    expect(within(review).getByText('Due for review')).toBeInTheDocument();
    const due = screen.getByRole('region', { name: 'Due for review' });
    expect(within(due).getByText('Packet analysis')).toBeInTheDocument();
    expect(due.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}|days?/);
  });

  it('plans the next step and shows why in plain words (C4), then practises with hints and the assisted warning', async () => {
    stub({
      '/api/v1/learning/path': { body: { path: path() } },
      '/api/v1/learning/placement-test': notAvailable,
      '/api/v1/learning/next-step:POST': { status: 201, body: { step: step({ status: 'IN_PROGRESS', questionsAnswered: 0, question: question([]) }) } },
      '/api/v1/learning/steps/d-1/hints:POST': [
        { status: 201, body: { step: step({ status: 'IN_PROGRESS', questionsAnswered: 0, question: question(['Nudge']) }) } },
        { status: 201, body: { step: step({ status: 'IN_PROGRESS', questionsAnswered: 0, question: question(['Nudge', 'Strategy']) }) } },
      ],
      '/api/v1/learning/steps/d-1/answers:POST': { status: 201, body: { feedback: { questionId: 'q-1', correct: true, assisted: false }, step: step({ status: 'COMPLETED', questionsAnswered: 1 }) } },
    });
    await authenticate();
    render(<StudentLearningPlan />);
    fireEvent.click(await screen.findByRole('button', { name: 'Plan my first step' }));
    const reasons = await screen.findByRole('list', { name: 'Why this step' });
    expect(within(reasons).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Your evidence partly meets this requirement.',
      'Your target role lists it as essential.',
      'Your plan follows your target role’s order; it does not adapt to your answers.',
    ]);
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ sessionMinutes: null });

    fireEvent.click(screen.getByRole('button', { name: /Show hint 1/ }));
    expect(await screen.findByText('Nudge')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show hint 2/ }));
    expect(await screen.findByText('Strategy')).toBeInTheDocument();
    expect(screen.getByText(/an answer after it counts as assisted/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Option B'));
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Right.');
    expect(screen.getByText(/Step finished: you answered 1 question/)).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/answers'))!.body).toEqual({ questionId: 'q-1', selectedOptionId: 'b' });
  });

  it('labels each hint by its level and says when a right answer after hint 3 counts as assisted (ENG-15)', async () => {
    stub({
      '/api/v1/learning/path': { body: { path: path() } },
      '/api/v1/learning/placement-test': notAvailable,
      '/api/v1/learning/next-step:POST': { status: 201, body: { step: step({ status: 'IN_PROGRESS', questionsAnswered: 0, question: question(['Nudge text', 'Strategy text']) }) } },
      '/api/v1/learning/steps/d-1/hints:POST': { status: 201, body: { step: step({ status: 'IN_PROGRESS', questionsAnswered: 0, question: question(['Nudge text', 'Strategy text', 'Worked step text']) }) } },
      '/api/v1/learning/steps/d-1/answers:POST': { status: 201, body: { feedback: { questionId: 'q-1', correct: true, assisted: true }, step: step({ status: 'COMPLETED', questionsAnswered: 1 }) } },
    });
    await authenticate();
    render(<StudentLearningPlan />);
    fireEvent.click(await screen.findByRole('button', { name: 'Plan my first step' }));
    const hints = await screen.findByLabelText('Hints shown');
    expect(within(hints).getByText('Hint 1 · Nudge')).toBeInTheDocument();
    expect(within(hints).getByText('Hint 2 · Strategy')).toBeInTheDocument();
    expect(screen.getByText(/an answer after it counts as assisted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show hint 3 · Worked step/ }));
    expect(await screen.findByText('Hint 3 · Worked step')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show hint 4 · Near solution/ })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Option B'));
    fireEvent.click(screen.getByRole('button', { name: 'Check answer' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Right. Counted as assisted: it does not count as solved on your own.');
  });

  it('says plainly when nothing is published for the step, and when there is no target', async () => {
    stub({
      '/api/v1/learning/path': { body: { path: path({ latestStep: step({ status: 'NO_PRACTICE' }, { action: 'LEARN' }) }) } },
      '/api/v1/learning/placement-test': notAvailable,
    });
    await authenticate();
    render(<StudentLearningPlan />);
    expect(await screen.findByText(/No published practice for this skill yet/)).toBeInTheDocument();
    cleanup();

    stub({
      '/api/v1/learning/path': { body: { path: path({ target: null, requirements: null, groups: { policyVersion: 'learning-path-groups-v1', skip: [], review: [], learn: [] } }) } },
      '/api/v1/learning/placement-test': notAvailable,
    });
    render(<StudentLearningPlan />);
    expect(await screen.findByText(/Choose the job you want first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to My Career' })).toBeInTheDocument();
    expect(screen.getByText('Choose your target role in My Career to see what to skip, review and learn.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });

  it('says plainly, not a guess, when the plan cannot be loaded', async () => {
    stub({ '/api/v1/learning/path': { status: 500, body: { error: { code: 'INTERNAL', correlationId: 'c-1' } } }, '/api/v1/learning/placement-test': { status: 500, body: {} } });
    await authenticate();
    render(<StudentLearningPlan />);
    expect((await screen.findAllByText('Your learning plan could not be loaded right now.')).length).toBeGreaterThan(0);
    expect(await screen.findByText('The placement test could not be loaded right now.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });
});

describe('placement test card', () => {
  it('starts, asks one question at a time and shows the level, never a score', async () => {
    stub({
      '/api/v1/learning/placement-test:GET': { body: { placement: { status: 'NOT_STARTED' } } },
      '/api/v1/learning/placement-test:POST': { status: 201, body: { placement: { status: 'IN_PROGRESS', placementTestId: 'p-1', questionsAnswered: 0, maxQuestions: 25, deadlineAt: '2026-09-29T10:25:00.000Z',
        question: { id: 'pq-1', prompt: 'Synthetic aptitude question', position: 1, options: [{ id: 'a', text: 'Seven' }, { id: 'b', text: 'Nine' }] } } } },
      '/api/v1/learning/placement-test/p-1/answers:POST': { status: 201, body: { placement: { status: 'COMPLETED', placementTestId: 'p-1', placementLevel: 'GUIDED', stopReason: 'CONFIDENT', questionsAnswered: 9, completedAt: '2026-09-29T10:10:00.000Z' } } },
    });
    await authenticate();
    render(<PlacementCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Start the placement test/ }));
    expect(await screen.findByText('Synthetic aptitude question')).toBeInTheDocument();
    expect(screen.getByText(/Question 1 of up to 25/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Nine'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Guided')).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/answers'))!.body).toEqual({ questionId: 'pq-1', selectedOptionId: 'b' });
    expect(document.body.textContent).not.toMatch(/theta|ability|%/i);
  });
});

describe('practice by skill (Practice page)', () => {
  it('lists the path skills to practise and links to the runner on Learning', async () => {
    stub({ '/api/v1/learning/path': { body: { path: path() } } });
    await authenticate();
    render(<PracticeBySkillCard />);
    expect(await screen.findByText('Log triage')).toBeInTheDocument();
    expect(screen.getByText('Incident reporting')).toBeInTheDocument();
    expect(screen.queryByText('Networking basics')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Practise from your next step' }));
    await waitFor(() => expect(window.location.pathname).toBe('/student/learning'));
  });
});
