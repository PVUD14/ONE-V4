/**
 * Web tests for student goals and onboarding (ENG-19): the first-run "What job do you want?" search and
 * choice, "Not sure yet" with reasons for each suggestion, the goals list with shared skills listed once,
 * and NA when the goals cannot be loaded. The API is stubbed with synthetic rows; no readiness value or
 * score is ever rendered.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { StudentGoalsPanel } from './studentGoals.js';

const emptyGoals = { onboarding: true, catalogueOpen: false, goals: [], skills: { algorithmId: 'learner-goal-skills-v1', skills: [] } };
const roleOption = { id: 'role-soc', code: 'SOC_ANALYST', title: 'Security Operations Analyst', family: 'Cyber Security', summary: null, releaseLabel: null, catalogueCode: null, matchedSynonym: 'SOC analyst' };
const survey = {
  interests: [{ code: 'SECURING_SYSTEMS', label: 'Protecting systems and networks' }, { code: 'BUSINESS_AND_PEOPLE', label: 'Business, customers and operations' }],
  strengths: [{ code: 'COMMUNICATION', label: 'Explaining and persuading' }],
  branches: ['CSE', 'ECE', 'NOT_LISTED'],
};
const withGoals = {
  onboarding: false, catalogueOpen: false,
  goals: [
    { id: 'goal-role', goalType: 'ROLE', priority: 'PRIMARY', origin: 'ONBOARDING', createdAt: '2026-09-29T00:00:00.000Z', role: { careerRoleId: 'role-soc', targetId: 't1', code: 'SOC_ANALYST', title: 'Security Operations Analyst', family: 'Cyber Security', releaseLabel: null }, topic: null, catalogueGoal: null, discovery: null },
    { id: 'goal-topic', goalType: 'TOPIC', priority: 'SECONDARY', origin: 'GOALS', createdAt: '2026-09-29T00:00:00.000Z', role: null, topic: { topicId: 'topic-comms', name: 'Professional communication' }, catalogueGoal: null, discovery: null },
  ],
  skills: { algorithmId: 'learner-goal-skills-v1', skills: [
    { topicId: 'topic-comms', topicTitle: 'Professional communication', goals: [{ goalId: 'goal-role', goalType: 'ROLE', status: 'MET' }, { goalId: 'goal-topic', goalType: 'TOPIC', status: null }] },
    { topicId: 'topic-logs', topicTitle: 'Log triage', goals: [{ goalId: 'goal-role', goalType: 'ROLE', status: 'UNKNOWN' }] },
  ] },
};

type Route = { readonly status?: number; readonly body: unknown };
let calls: { path: string; method: string; body: unknown }[] = [];

function stub(routes: Readonly<Record<string, Route>>): void {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${path}:${method}`] ?? routes[path];
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

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('student onboarding and goals', () => {
  it('asks "What job do you want?" first, finds a role by synonym and sets it as the main goal', async () => {
    stub({
      '/api/v1/students/me/goals:GET': { body: emptyGoals },
      '/api/v1/students/me/goals/options': { body: { catalogueOpen: false, roles: [roleOption], topics: [], catalogueGoals: [] } },
      '/api/v1/students/me/goals:POST': { status: 201, body: withGoals },
    });
    await authenticate();
    render(<StudentGoalsPanel />);
    expect(await screen.findByRole('heading', { name: 'What job do you want?' })).toBeInTheDocument();
    expect(screen.getByText(/studying now or finished college already/)).toBeInTheDocument();
    expect(await screen.findByText(/also called “SOC analyst”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose Security Operations Analyst' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Security Operations Analyst is now your main goal.'));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ goalType: 'ROLE', careerRoleId: 'role-soc', priority: 'PRIMARY', origin: 'ONBOARDING' });
  });

  it('"Not sure yet" asks the short survey and shows each suggestion with its reasons, from answers only', async () => {
    stub({
      '/api/v1/students/me/goals:GET': { body: emptyGoals },
      '/api/v1/students/me/goals/options': { body: { catalogueOpen: false, roles: [], topics: [], catalogueGoals: [] } },
      '/api/v1/students/me/goals/discovery:GET': { body: { discovery: { algorithmId: 'career-discovery-v1', survey, answers: null, result: null } } },
      '/api/v1/students/me/goals/discovery:POST': { status: 201, body: { discovery: {
        algorithmId: 'career-discovery-v1', survey,
        answers: { interests: ['SECURING_SYSTEMS'], strengths: ['COMMUNICATION'], branch: 'ECE' },
        result: { usedShownSkills: false, fewerThanMinimum: false, suggestions: [
          { role: roleOption, reasons: [{ code: 'INTEREST_MATCH', detail: 'SECURING_SYSTEMS' }, { code: 'BRANCH_MATCH', detail: 'ECE' }] },
          { role: { ...roleOption, id: 'role-cs', title: 'Customer Success Associate', family: 'Business' }, reasons: [{ code: 'STRENGTH_MATCH', detail: 'COMMUNICATION' }] },
          { role: { ...roleOption, id: 'role-ba', title: 'Business Analyst', family: 'Business' }, reasons: [{ code: 'OPEN_TO_ALL_BRANCHES' }] },
        ] },
      } } },
    });
    await authenticate();
    render(<StudentGoalsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not sure yet' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Protecting systems and networks/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Explaining and persuading/ }));
    fireEvent.change(screen.getByRole('combobox', { name: /branch or degree/ }), { target: { value: 'ECE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show suggestions' }));
    expect(await screen.findByText('Matches your interest: protecting systems and networks')).toBeInTheDocument();
    expect(screen.getByText('Named for your branch (ECE)')).toBeInTheDocument();
    expect(screen.getByText('Uses a strength you named: explaining and persuading')).toBeInTheDocument();
    expect(screen.getByText('Open to every branch')).toBeInTheDocument();
    expect(screen.getByText(/your learning history was not used/)).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/discovery') && call.method === 'POST')!.body)
      .toEqual({ interests: ['SECURING_SYSTEMS'], strengths: ['COMMUNICATION'], branch: 'ECE', origin: 'ONBOARDING' });
    expect(document.body.textContent).not.toMatch(/score|readiness|%/i);
  });

  it('lists goals, and each shared skill once with its status for every goal that needs it', async () => {
    stub({
      '/api/v1/students/me/goals:GET': { body: withGoals },
      '/api/v1/students/me/goals/options': { body: { catalogueOpen: false, roles: [], topics: [{ id: 'topic-sql', name: 'SQL basics' }], catalogueGoals: [] } },
    });
    await authenticate();
    render(<StudentGoalsPanel />);
    // The loading card shares the heading, so wait for the loaded list itself.
    expect(await screen.findByText('Main goal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your goals' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'What job do you want?' })).not.toBeInTheDocument();
    const skills = screen.getByRole('heading', { name: 'Skills across your goals' }).closest('section')!;
    expect(within(skills).getAllByText('Professional communication')).toHaveLength(1);
    expect(within(skills).getByText('Needed by 2 of your goals')).toBeInTheDocument();
    expect(within(skills).getByText('Security Operations Analyst: Met')).toBeInTheDocument();
    expect(within(skills).getByText('Security Operations Analyst: Not measured yet')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Add topic SQL basics' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/score|readiness|%/i);
  });

  it('says plainly when the goals cannot be loaded, and invents nothing', async () => {
    stub({ '/api/v1/students/me/goals:GET': { status: 503, body: { error: { code: 'UNAVAILABLE' } } } });
    await authenticate();
    render(<StudentGoalsPanel />);
    expect(await screen.findByText('Your goals could not be loaded right now.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
    expect(screen.queryByRole('button', { name: /Choose/ })).not.toBeInTheDocument();
  });
});
