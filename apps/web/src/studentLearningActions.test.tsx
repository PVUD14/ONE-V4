/**
 * "From your lecturer" on the student's Learning page (INST-16): assigned practice and lessons with their
 * status, group sessions, and a next step a lecturer chose with the reason in plain words; lecturers named by
 * role and college only; NA when it cannot be loaded; and planning a step works before a target role is chosen
 * when a lecturer has set work. Synthetic data only; no score or model number is ever rendered.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { StudentLearningPlan } from './studentLearning.js';
import { FromYourLecturerCard } from './studentLearningActions.js';
import type { StudentLearningActionsDto } from './api.js';

const actions: StudentLearningActionsDto = {
  assignments: [
    { id: 'a-1', kind: 'PRACTICE', title: 'Subnetting', skillName: 'Subnetting', institutionName: 'Synthetic College', note: 'Before Friday', assignedAt: '2026-09-28T09:00:00.000Z', status: 'OPEN' },
    { id: 'a-2', kind: 'LESSON', title: 'Ports explained', skillName: 'Ports', institutionName: 'Synthetic College', note: null, assignedAt: '2026-09-20T09:00:00.000Z', status: 'DONE' },
  ],
  sessions: [{ id: 's-1', title: 'Subnetting clinic', institutionName: 'Synthetic College', scheduledStartAt: '2026-10-02T09:00:00.000Z', scheduledEndAt: '2026-10-02T10:00:00.000Z',
    content: [{ kind: 'PRACTICE', title: 'Subnetting', skillName: 'Subnetting' }] }],
  pendingOverride: { id: 'o-1', action: 'PRACTICE', kind: 'PRACTICE', title: 'Ports', skillName: 'Ports', reasonCode: 'UPCOMING_ASSESSMENT', note: null, institutionName: 'Synthetic College', createdAt: '2026-09-28T10:00:00.000Z' },
};

describe('From your lecturer card', () => {
  afterEach(() => cleanup());

  it('shows the chosen next step with its reason, assigned work with status and sessions with what they cover', () => {
    const onStart = vi.fn();
    render(<FromYourLecturerCard actions={actions} status="" busy={false} onStart={onStart} />);
    expect(screen.getByText('Your lecturer at Synthetic College set your next step: Practise Ports')).toBeInTheDocument();
    expect(screen.getByText(/It prepares you for an upcoming assessment\./)).toBeInTheDocument();
    const assigned = screen.getByLabelText('Assigned to you');
    expect(within(assigned).getByText('Subnetting').closest('.pilot-list-row')).toHaveTextContent('To do');
    expect(within(assigned).getByText('Ports explained').closest('.pilot-list-row')).toHaveTextContent('Done');
    expect(within(assigned).getByText(/“Before Friday”/)).toBeInTheDocument();
    expect(screen.getByLabelText('Group sessions')).toHaveTextContent('Covers: Subnetting');
    fireEvent.click(screen.getByRole('button', { name: 'Start my lecturer’s work' }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(document.body.textContent ?? '').not.toMatch(/score|readiness|likelihood|%/i);
  });

  it('INST-17: a preparation sprint from the college shows its end date, and the card says it is from the college', () => {
    render(<FromYourLecturerCard actions={{ ...actions, pendingOverride: null, assignments: [
      { id: 'a-3', kind: 'PRACTICE', title: 'Log triage', skillName: 'Log triage', institutionName: 'Synthetic College', note: null, assignedAt: '2026-09-28T09:00:00.000Z', status: 'OPEN', sprint: { endsAt: '2026-10-12T09:00:00.000Z' } },
    ] }} status="" busy={false} onStart={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'From your college' })).toBeInTheDocument();
    expect(screen.getByText(/Practice set · Log triage · preparation sprint from Synthetic College until/)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/score|readiness|gap|%/i);
  });

  it('says plainly when there is nothing, and NA when it cannot be loaded', () => {
    render(<FromYourLecturerCard actions={{ assignments: [], sessions: [], pendingOverride: null }} status="" busy={false} onStart={vi.fn()} />);
    expect(screen.getByText(/Nothing from your lecturers right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    cleanup();
    render(<FromYourLecturerCard actions={null} status="NA — what your lecturers set could not be loaded right now." busy={false} onStart={vi.fn()} />);
    expect(screen.getByText('NA — what your lecturers set could not be loaded right now.')).toBeInTheDocument();
  });
});

describe('on the Learning page', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
    vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
    vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  });
  afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

  it('plans the lecturer\'s step even before a target role is chosen', async () => {
    const step = { decisionId: 'd-1', decidedAt: '2026-09-29T00:00:00.000Z', action: 'PRACTICE', skill: { id: 's-1', name: 'Ports' }, strategyKind: null,
      reasonCodes: ['FACULTY_OVERRIDE', 'NON_ADAPTIVE_NO_CONSENT'], adaptive: false, lessons: [], practice: { status: 'NO_PRACTICE' } };
    const path = { adaptive: false, target: null, requirements: null, groups: { policyVersion: 'learning-path-groups-v1', skip: [], review: [], learn: [] }, dueReviews: [], latestStep: null };
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
      const route = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
      if ((init?.method ?? 'GET') === 'POST') { posts.push(route); return { ok: true, status: 201, headers: new Headers(), json: async () => ({ step }) }; }
      const body = route === '/api/v1/learning/path' ? { path }
        : route === '/api/v1/students/me/learning-actions' ? actions
          : { placement: { status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' } };
      return { ok: true, status: 200, headers: new Headers(), json: async () => body };
    }));
    window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
    window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
    window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
    await completeHostedLoginFromLocation();
    render(<StudentLearningPlan />);
    expect(await screen.findByText(/Your lecturer’s work is planned now/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Start my lecturer’s work' }));
    expect(await screen.findByText('Your faculty set this step.')).toBeInTheDocument();
    expect(posts).toEqual(['/api/v1/learning/next-step']);
  });
});
