import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { AcademicVerificationPage } from './academicVerificationPage.js';

const institutionId = '33333333-3333-4333-8333-333333333333';
const queuePath = `/api/v1/institutions/${institutionId}/academic-verification-queue`;

const current = {
  termId: 'term-current', label: 'Semester 6', sequence: 6, resultValue: '8.40', resultScale: 'CGPA_10',
  resultLetter: null, backlogCount: null, source: 'STUDENT_DECLARED',
  qualificationId: 'q-1', programmeName: 'Computer Science and Engineering', qualificationType: 'BTECH',
  claimedStartedOn: '2022-08-01', claimedCompletedOn: null,
  studentUserId: 'u-1', studentEmail: 'priya@uat.example.test', studentName: 'Priya Nair',
  institutionStudentId: 'CSE-2022-014', relationship: 'CURRENT',
};

const alumnus = {
  termId: 'term-alumnus', label: 'Semester 8', sequence: 8, resultValue: '7.90', resultScale: 'CGPA_10',
  resultLetter: null, backlogCount: null, source: 'DOCUMENT_BACKED',
  qualificationId: 'q-2', programmeName: 'Mechanical Engineering', qualificationType: 'BTECH',
  claimedStartedOn: '2015-08-01', claimedCompletedOn: '2019-06-30',
  studentUserId: 'u-2', studentEmail: 'older.graduate@uat.example.test', studentName: null,
  institutionStudentId: null, relationship: 'NONE',
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/institution/faculty'); });

describe('academic verification queue', () => {
  it('shows an alumnus without a roster record honestly, rather than inventing a name', async () => {
    stub({ [queuePath]: { queue: [alumnus] } });
    await authenticate();
    render(<AcademicVerificationPage institutionId={institutionId} />);
    expect(await screen.findByText('Not on your roster')).toBeInTheDocument();
    expect(screen.getByText('No roster record — identify by email')).toBeInTheDocument();
    expect(screen.getByText('older.graduate@uat.example.test')).toBeInTheDocument();
    // The claimed years are what makes an archive lookup possible.
    expect(screen.getByText('Claims 2015 – 2019')).toBeInTheDocument();
  });

  it('separates a current student from a former one', async () => {
    stub({ [queuePath]: { queue: [current, { ...alumnus, relationship: 'FORMER', studentName: 'Arun Rao' }] } });
    await authenticate();
    render(<AcademicVerificationPage institutionId={institutionId} />);
    expect(await screen.findByText('Current student')).toBeInTheDocument();
    expect(screen.getByText('Former student')).toBeInTheDocument();
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
  });

  it('counts the requests that need an archive lookup', async () => {
    stub({ [queuePath]: { queue: [current, alumnus] } });
    await authenticate();
    render(<AcademicVerificationPage institutionId={institutionId} />);
    expect(await screen.findByText(/1 request is from someone who is not a current student/)).toBeInTheDocument();
  });

  it('warns that confirming cannot be undone', async () => {
    stub({ [queuePath]: { queue: [current] }, [`/api/v1/institutions/${institutionId}/academic-verification/term-current/decide`]: { queue: [] } });
    await authenticate();
    render(<AcademicVerificationPage institutionId={institutionId} />);
    // Said before the decision, because the database trigger will not allow a second thought.
    expect(await screen.findByText(/a confirmation is permanent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByText(/This decision is permanent and cannot be reversed/)).toBeInTheDocument());
  });

  it('says an empty queue is empty', async () => {
    stub({ [queuePath]: { queue: [] } });
    await authenticate();
    render(<AcademicVerificationPage institutionId={institutionId} />);
    expect(await screen.findByText(/Nothing is waiting/)).toBeInTheDocument();
  });

  it('renders NA for a result recorded on no scale rather than a bare number', async () => {
    stub({ [queuePath]: { queue: [{ ...current, resultValue: null, resultScale: null }] } });
    await authenticate();
    render(<AcademicVerificationPage institutionId={institutionId} />);
    expect(await screen.findByText('NA')).toBeInTheDocument();
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
