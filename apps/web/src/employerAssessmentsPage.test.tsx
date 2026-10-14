import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EmployerAssessmentsPage, EmployerCandidateAssessmentsPanel } from './employerAssessmentsPage.js';

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
    // A candidate who has not sat it yet reads "No score yet", never NA and never a zero that looks like a failure.
    expect(screen.getByText('No score yet')).toBeInTheDocument();
    expect(screen.queryByText('NA')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
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

describe('EMP-12: reasons, the assessment stage, windows and results per candidate', () => {
  it('asks for a listed reason before rejecting a question, and sends it', async () => {
    const calls = stubCalls({ [`${base}/assessment-questions`]: { questions: [draftQuestion] }, [`${base}/assessments`]: { assessments: [] } });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Question bank' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const confirm = screen.getByRole('button', { name: 'Reject question' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Why reject it'), { target: { value: 'AMBIGUOUS' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/q-draft/transition'))?.body).toEqual({ toState: 'REJECTED', reasonCode: 'AMBIGUOUS' }));
  });

  it('flags a question that names a protected attribute for its reviewer', async () => {
    stubCalls({ [`${base}/assessment-questions`]: { questions: [{ ...draftQuestion, mentionsProtectedAttribute: true }] }, [`${base}/assessments`]: { assessments: [] } });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Question bank' }));
    expect(await screen.findByText(/Names a protected attribute/)).toBeInTheDocument();
  });

  it('closes a published test only with a reason', async () => {
    const calls = stubCalls({ [`${base}/assessment-questions`]: { questions: [approvedQuestion] }, [`${base}/assessments`]: { assessments: [assessment] } });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    fireEvent.change(screen.getByLabelText('Why close it'), { target: { value: 'ROLE_FILLED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close test' }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/assess-1/close'))?.body).toEqual({ reasonCode: 'ROLE_FILLED' }));
  });

  it('offers only candidates in the Assessment stage and sends the window', async () => {
    const calls = stubCalls({
      [`${base}/assessment-questions`]: { questions: [approvedQuestion] },
      [`${base}/assessments`]: { assessments: [assessment] },
      [`${base}/opportunities`]: { opportunities: [{ id: 'o-1', title: 'SOC Analyst', referenceCode: 'SOC-1', lifecycleState: 'PUBLISHED', applicationCount: 2 }] },
      [`${base}/opportunities/o-1/applications`]: { applications: [
        { id: 'a-1', state: 'ASSESSMENT', candidateName: 'Priya Nair', candidateEmail: null, closedAt: null, consentRevoked: false, candidateAccess: true },
        { id: 'a-2', state: 'SHORTLISTED', candidateName: 'Arun Das', candidateEmail: null, closedAt: null, consentRevoked: false, candidateAccess: true },
      ] },
      [`${base}/assessments/assess-1/invitations`]: { invited: 1 },
    });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to applicants' }));
    fireEvent.click(await screen.findByLabelText(/Priya Nair/));
    expect(screen.queryByLabelText(/Arun Das/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 other candidate is not in the Assessment stage/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/assess-1/invitations'))?.body).toEqual(expect.objectContaining({ applicationIds: ['a-1'], closesAt: expect.any(String) })));
  });

  it('lists results in invitation order with how each ended, a page at a time', async () => {
    const row = { invitationId: 'inv-1', applicationId: 'a-1', state: 'SUBMITTED', candidateName: 'Priya Nair', candidateEmail: null,
      closesAt: '2099-01-01T00:00:00.000Z', score: 0, maxScore: 2, percentage: 0, submittedAt: '2026-09-10T00:00:00.000Z', endedBy: 'TIME_LIMIT' };
    stubCalls({
      [`${base}/assessment-questions`]: { questions: [approvedQuestion] },
      [`${base}/assessments`]: { assessments: [assessment] },
      [`${base}/assessments/assess-1/results`]: { results: [row], nextCursor: 'next-page' },
    });
    await authenticate();
    render(<EmployerAssessmentsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Results' }));
    expect(await screen.findByText('Time ran out')).toBeInTheDocument();
    expect(screen.getByText(/listed in the order they were sent the test, not by score/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
  });

  it('shows one candidate results question by question, and says so when they stop sharing', async () => {
    stubCalls({ [`${base}/applications/a-1/assessment-results`]: { assessments: [{
      invitationId: 'inv-1', assessmentId: 'assess-1', title: 'SOC screening test', durationSeconds: 1800, totalMarks: 2,
      invitedAt: '2026-09-01T00:00:00.000Z', opensAt: '2026-09-01T00:00:00.000Z', closesAt: '2026-09-08T00:00:00.000Z', state: 'SUBMITTED',
      startedAt: '2026-09-02T00:00:00.000Z', submittedAt: '2026-09-02T00:20:00.000Z', endedBy: 'CANDIDATE', score: 2, maxScore: 2, percentage: 100,
      questions: [{ displayOrder: 1, questionText: 'Which log shows failed logins?', questionType: 'SINGLE_CHOICE_MCQ', marks: 2, marksAwarded: 2, answered: true }],
    }] } });
    await authenticate();
    render(<EmployerCandidateAssessmentsPanel employerId={employerId} applicationId="a-1" />);
    expect(await screen.findByText('Which log shows failed logins?')).toBeInTheDocument();
    expect(screen.getByText(/Score: 100% \(2 \/ 2\) · submitted by the candidate/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/readiness|demonstrated|progressing|band/i);
    cleanup();

    stubWithError({}, { [`${base}/applications/a-2/assessment-results`]: { status: 403, body: { error: { code: 'FORBIDDEN', correlationId: 'c-9' } } } });
    render(<EmployerCandidateAssessmentsPanel employerId={employerId} applicationId="a-2" />);
    expect(await screen.findByText(/no longer sharing their application with you/)).toBeInTheDocument();
  });
});

function stubCalls(routes: Readonly<Record<string, unknown>>): { url: string; body: unknown }[] {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    calls.push({ url, body: init?.body ? JSON.parse(init.body) as unknown : undefined });
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    return { ok: true, status: 200, json: async () => routes[path] ?? {} };
  }));
  return calls;
}

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
