import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EmployerAssessmentsPage } from './employerAssessmentsPage.js';

const employerId = '44444444-4444-4444-8444-444444444444';
const base = `/api/v1/employers/${employerId}`;

const draftQuestion = {
  id: 'q-draft', questionText: 'Which log shows failed logins?', questionType: 'SINGLE_CHOICE_MCQ',
  difficulty: 'MEDIUM', marks: 2, approvalStatus: 'UNDER_REVIEW', version: 1, optionCount: 3,
};
const approvedQuestion = { ...draftQuestion, id: 'q-approved', approvalStatus: 'APPROVED' };

const assessment = {
  id: 'assess-1', title: 'SOC screening test', durationSeconds: 1800, totalMarks: 2,
  lifecycleState: 'PUBLISHED', opportunityId: null, publishedAt: '2026-09-01T00:00:00.000Z',
  itemCount: 1, invitedCount: 2, submittedCount: 1,
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/employer/recruiter'); });

describe('screening tests, employer side', () => {
  it('states on the screen that an author cannot approve their own question', async () => {
    stub({ [`${base}/assessment-questions`]: { questions: [draftQuestion] }, [`${base}/assessments`]: { assessments: [] } });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Question bank' }));
    // Said up front, rather than discovered as an error after writing a question.
    expect(await screen.findByText(/Somebody other than the author has to approve it/)).toBeInTheDocument();
  });

  it('translates the server\'s refusal into something a recruiter can act on', async () => {
    stubWithError(
      { [`${base}/assessment-questions`]: { questions: [draftQuestion] }, [`${base}/assessments`]: { assessments: [] } },
      { [`${base}/assessment-questions/q-draft/transition`]: { status: 400, body: { error: { code: 'AUTHOR_CANNOT_APPROVE_OWN_QUESTION', correlationId: 'c-1' } } } },
    );
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Question bank' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('Somebody other than the author has to approve a question.')).toBeInTheDocument());
  });

  it('will not offer a test builder with nothing approved to build from', async () => {
    stub({ [`${base}/assessment-questions`]: { questions: [draftQuestion] }, [`${base}/assessments`]: { assessments: [] } });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    expect(await screen.findByText(/Approve at least one question in your bank/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Build a test' })).not.toBeInTheDocument();
  });

  it('shows results with no readiness band anywhere', async () => {
    stub({
      [`${base}/assessment-questions`]: { questions: [approvedQuestion] },
      [`${base}/assessments`]: { assessments: [assessment] },
      [`${base}/assessments/assess-1/results`]: { results: [
        { invitationId: 'inv-1', applicationId: 'a-1', state: 'SUBMITTED', candidateName: 'Priya Nair',
          candidateEmail: 'priya@uat.example.test', closesAt: '2099-01-01T00:00:00.000Z',
          score: 2, maxScore: 2, percentage: 100, submittedAt: '2026-09-10T00:00:00.000Z' },
        { invitationId: 'inv-2', applicationId: 'a-2', state: 'INVITED', candidateName: null,
          candidateEmail: 'arun@uat.example.test', closesAt: '2099-01-01T00:00:00.000Z',
          score: null, maxScore: null, percentage: null, submittedAt: null },
      ] },
    });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Results' }));
    expect(await screen.findByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    // A candidate who has not sat it yet reads NA, never a zero that looks like a failure.
    expect(screen.getByText('NA')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/readiness|demonstrated|progressing/i);
  });

  it('says a score decides nothing on its own', async () => {
    stub({
      [`${base}/assessment-questions`]: { questions: [approvedQuestion] },
      [`${base}/assessments`]: { assessments: [assessment] },
      [`${base}/assessments/assess-1/results`]: { results: [] },
    });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Results' }));
    expect(await screen.findByText(/A score is information, not a decision/)).toBeInTheDocument();
  });
});

type ErrorStub = Readonly<Record<string, { readonly status: number; readonly body: unknown }>>;

function stub(routes: Readonly<Record<string, unknown>>): void {
  stubWithError(routes, {});
}

function stubWithError(routes: Readonly<Record<string, unknown>>, errors: ErrorStub): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const failure = errors[path];
    if (failure) return { ok: false, status: failure.status, json: async () => failure.body };
    return { ok: true, status: 200, json: async () => routes[path] ?? {} };
  }));
}

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
