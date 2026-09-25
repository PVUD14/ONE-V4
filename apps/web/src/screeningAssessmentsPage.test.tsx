import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { ScreeningAssessmentsPage } from './screeningAssessmentsPage.js';

const invitation = {
  id: 'inv-1', state: 'INVITED',
  opensAt: '2026-09-01T00:00:00.000Z', closesAt: '2099-09-30T00:00:00.000Z',
  title: 'SOC screening test', durationSeconds: 1800,
  employerName: 'Aster Mobility', roleTitle: 'SOC Analyst Intern',
  attemptId: null, attemptState: null, percentage: null,
};

const attempt = {
  id: 'attempt-1',
  questions: [{
    questionId: 'q-1', displayOrder: 1, questionText: 'Which log shows failed logins?',
    questionType: 'SINGLE_CHOICE_MCQ', marks: 2,
    options: [{ key: 'A', text: 'Auth log' }, { key: 'B', text: 'Mail log' }, { key: 'C', text: 'Cron log' }],
    selectedOptionKeys: [],
  }],
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('screening tests, candidate side', () => {
  it('tells the candidate where the result goes and what it does not touch', async () => {
    stub({ '/api/v1/students/me/screening-assessments': { invitations: [invitation] } });
    await authenticate();
    render(<ScreeningAssessmentsPage />);
    expect(await screen.findByText('SOC screening test')).toBeInTheDocument();
    expect(screen.getByText(/not part of your academic record and it does not change your readiness/)).toBeInTheDocument();
  });

  it('shows no hint of which option is correct', async () => {
    stub({
      '/api/v1/students/me/screening-assessments': { invitations: [invitation] },
      '/api/v1/students/me/screening-assessments/inv-1/start': { attempt },
    });
    await authenticate();
    render(<ScreeningAssessmentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Which log shows failed logins?')).toBeInTheDocument();
    expect(screen.getByLabelText('Auth log')).toBeInTheDocument();
    // Nothing in the rendered paper distinguishes the right answer.
    expect(document.body.textContent).not.toMatch(/correct|isCorrect/i);
  });

  it('warns that submitting is final before it happens, not after', async () => {
    stub({
      '/api/v1/students/me/screening-assessments': { invitations: [invitation] },
      '/api/v1/students/me/screening-assessments/inv-1/start': { attempt },
      '/api/v1/students/me/screening-attempts/attempt-1/answers': { saved: true },
      '/api/v1/students/me/screening-attempts/attempt-1/submit': { result: { score: 2, maxScore: 2, percentage: 100 } },
    });
    await authenticate();
    render(<ScreeningAssessmentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    fireEvent.click(await screen.findByLabelText('Auth log'));
    fireEvent.click(screen.getByRole('button', { name: 'Submit test' }));
    expect(await screen.findByText(/Submitting is final/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, submit' }));
    await waitFor(() => expect(screen.getByText(/You scored/)).toBeInTheDocument());
  });

  it('offers no start button once the window has closed', async () => {
    stub({ '/api/v1/students/me/screening-assessments': { invitations: [{ ...invitation, closesAt: '2020-01-01T00:00:00.000Z' }] } });
    await authenticate();
    render(<ScreeningAssessmentsPage />);
    expect(await screen.findByText(/closed before it was submitted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('says there is nothing rather than showing an example', async () => {
    stub({ '/api/v1/students/me/screening-assessments': { invitations: [] } });
    await authenticate();
    render(<ScreeningAssessmentsPage />);
    expect(await screen.findByText(/No screening tests right now/)).toBeInTheDocument();
  });
});

function stub(routes: Readonly<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    return { ok: true, status: 200, json: async () => routes[path] ?? {} };
  }));
}

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
