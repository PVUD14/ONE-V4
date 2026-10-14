/**
 * EMP-06 on the student and Applicants screens: the student sees each eligibility rule with
 * "you meet / you don't meet" and the basis of their own value, is told which rule stopped an
 * application, and the employer's pipeline offers the job's stages in order and shows eligibility
 * flags — self-reported marked, never a figure.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EmployerApplicantsPage, StudentOpportunitiesPage } from './hiringPages.js';

const opportunityId = '11111111-1111-4111-8111-111111111111';
const employerId = '44444444-4444-4444-8444-444444444444';
const opportunity = {
  id: opportunityId, referenceCode: 'GA-2026-01', employerName: 'Synthetic Analytics', title: 'Graduate analyst', summary: null,
  employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai', durationMonths: null, applicationDeadline: null,
  publishedAt: '2026-09-01T00:00:00.000Z', compensation: null, alreadyApplied: false,
};
const rule = (ruleType: string, comparator: string, valueNumeric: number | null, valueText: string | null, extra: Record<string, unknown>) => ({
  ruleType, comparator, valueNumeric, valueText, isBlocking: true, displayValue: valueNumeric != null ? String(valueNumeric) : valueText, basis: null, unknownReason: null, yourValue: null, ...extra,
});
const detail = (eligibility: Record<string, unknown>) => ({
  opportunity: { ...opportunity, responsibilities: null, positionsAvailable: 1, joiningConditions: null,
    skills: [{ name: 'SQL', level: 'REQUIRED', catalogue: true }],
    selectionStages: [{ order: 1, kind: 'SCREENING', label: 'Résumé screen', detail: null }, { order: 2, kind: 'INTERVIEW', label: 'Panel interview', detail: null }] },
  eligibility,
});

type Routes = Record<string, unknown>;
let routes: Routes;
let postFailure: { status: number; body: unknown } | null;

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  postFailure = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    if (init?.method === 'POST' && postFailure) return { ok: false, status: postFailure.status, json: async () => postFailure!.body };
    return { ok: true, status: 200, json: async () => routes[path] ?? {} };
  }));
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}

describe('EMP-06 student: eligibility rule by rule', () => {
  it('marks each blocking rule met or not, with the basis of the student\'s own value', async () => {
    routes = {
      '/api/v1/opportunities': { opportunities: [opportunity] },
      [`/api/v1/opportunities/${opportunityId}`]: detail({
        eligible: false, blockingFailures: ['MAX_BACKLOGS'], advisoryFailures: [], needsMoreInformation: [],
        rules: [
          rule('MIN_CGPA', 'GTE', 7, null, { outcome: 'MET', basis: 'SELF_REPORTED', yourValue: '8.2 on a 10-point CGPA (Semester 5)' }),
          rule('MAX_BACKLOGS', 'LTE', 0, null, { outcome: 'NOT_MET', basis: 'VERIFIED', yourValue: '2 across 5 terms' }),
          rule('CUSTOM', 'EQ', null, 'Willing to relocate to Chennai', { isBlocking: false, outcome: 'NOT_EVALUATED' }),
        ],
      }),
    };
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    const list = await screen.findByRole('list', { name: 'Eligibility rules' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Minimum CGPA 7 (10-point scale) — You meet this Your record: 8.2 on a 10-point CGPA (Semester 5) (self-reported).');
    expect(items[0]).toHaveTextContent('The employer sees that this rests on your own declaration.');
    expect(items[1]).toHaveTextContent("No active backlogs — You don't meet this Your record: 2 across 5 terms (verified by the college).");
    expect(items[2]).toHaveTextContent('Willing to relocate to Chennai — The employer will consider this with you; it does not stop you applying.');
    expect(screen.getByText('You do not meet a rule that decides who can apply, so you cannot apply to this role.')).toBeInTheDocument();
    expect(screen.getByText('Panel interview')).toBeInTheDocument();
  });

  it('says what would fix a rule it cannot confirm, and names the refusal when applying', async () => {
    routes = {
      '/api/v1/opportunities': { opportunities: [opportunity] },
      [`/api/v1/opportunities/${opportunityId}`]: detail({
        eligible: false, blockingFailures: [], advisoryFailures: [], needsMoreInformation: ['MIN_CGPA'],
        rules: [rule('MIN_CGPA', 'GTE', 7, null, { outcome: 'UNKNOWN', unknownReason: 'NO_RECORD' })],
      }),
    };
    postFailure = { status: 400, body: { error: { code: 'ELIGIBILITY_UNKNOWN', correlationId: 'corr-1', rules: [] } } };
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(await screen.findByText(/Cannot be confirmed yet/)).toBeInTheDocument();
    expect(screen.getByText(/Ask your college to add your results to ONE/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply and share my profile' }));
    expect(await screen.findByText(/ONE cannot confirm a rule this employer requires/)).toBeInTheDocument();
  });

  it('says plainly when a job sets no rules', async () => {
    routes = {
      '/api/v1/opportunities': { opportunities: [opportunity] },
      [`/api/v1/opportunities/${opportunityId}`]: detail({ eligible: true, blockingFailures: [], advisoryFailures: [], needsMoreInformation: [], rules: [] }),
    };
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(await screen.findByText('The employer has set no eligibility rules for this role.')).toBeInTheDocument();
  });
});

describe('EMP-06 employer: stage template and eligibility flags on Applicants', () => {
  const job = { id: opportunityId, referenceCode: 'GA-2026-01', lifecycleState: 'PUBLISHED', title: 'Graduate analyst', employmentType: 'FULL_TIME', workMode: 'ONSITE',
    locationCity: 'Chennai', applicationDeadline: null, publishedAt: '2026-09-01T00:00:00.000Z', applicationCount: 2, openApplicationCount: 2 };
  const stages = [
    { order: 1, kind: 'SCREENING', label: 'Résumé screen', detail: null, applicationState: 'SCREENING' },
    { order: 2, kind: 'GROUP_DISCUSSION', label: 'Group discussion', detail: null, applicationState: 'ASSESSMENT' },
    { order: 3, kind: 'INTERVIEW', label: 'Technical interview', detail: null, applicationState: 'INTERVIEW' },
    { order: 4, kind: 'INTERVIEW', label: 'HR interview', detail: null, applicationState: 'INTERVIEW' },
  ];
  const applicant = (id: string, state: string, eligibility: unknown) => ({ id, state, consentRevoked: false, candidateAccess: true, candidateName: 'Synthetic ' + id,
    candidateEmail: id + '@uat.example.test', institutionStudentId: null, submittedAt: '2026-09-02T00:00:00.000Z', closedAt: null, interviewCount: 0,
    offerState: null, updatedAt: '2026-09-02T00:00:00.000Z', eligibility });

  it('offers the job\'s stages in order and flags self-reported eligibility without a figure', async () => {
    routes = {
      [`/api/v1/employers/${employerId}/opportunities`]: { opportunities: [job] },
      [`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications`]: { stages, applications: [
        applicant('declared', 'APPLIED', { eligible: true, evaluatedAt: '2026-09-02T00:00:00.000Z', trigger: 'APPLY', versionNumber: 2, flagCount: 1, selfReportedCount: 1,
          outcomes: [{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7, valueText: null, isBlocking: true, outcome: 'MET', basis: 'SELF_REPORTED', unknownReason: null, flagged: true }] }),
        applicant('verified', 'SCREENING', { eligible: true, evaluatedAt: '2026-09-02T00:00:00.000Z', trigger: 'APPLY', versionNumber: 2, flagCount: 0, selfReportedCount: 0,
          outcomes: [{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7, valueText: null, isBlocking: true, outcome: 'MET', basis: 'VERIFIED', unknownReason: null, flagged: false }] }),
      ] },
    };
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} />);
    expect(await screen.findByText('Selection stages: 1. Résumé screen → 2. Group discussion → 3. Technical interview → 4. HR interview')).toBeInTheDocument();
    const declaredRow = screen.getByText('Synthetic declared').closest('tr')!;
    expect(within(declaredRow).getAllByRole('button').map((button) => button.textContent)).toEqual(['Résumé screen', 'Group discussion', 'Technical interview', 'Shortlist', 'Not selected']);
    expect(within(declaredRow).getByRole('list', { name: 'Eligibility flags' })).toHaveTextContent('Minimum CGPA 7 (10-point scale): met');
    expect(within(declaredRow).getByText('Self-reported')).toBeInTheDocument();
    const verifiedRow = screen.getByText('Synthetic verified').closest('tr')!;
    expect(within(verifiedRow).getByText('Résumé screen')).toBeInTheDocument();
    expect(within(verifiedRow).getByText('Meets every rule (college records)')).toBeInTheDocument();
    expect(within(verifiedRow).getAllByRole('button').map((button) => button.textContent)).toEqual(['Group discussion', 'Technical interview', 'Shortlist', 'Not selected']);
    expect(document.body.textContent).not.toMatch(/readiness|mastery/i);
  });

  it('keeps the standard steps when a job has no stages, and says so', async () => {
    routes = {
      [`/api/v1/employers/${employerId}/opportunities`]: { opportunities: [job] },
      [`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications`]: { stages: [], applications: [applicant('plain', 'APPLIED', null)] },
    };
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} />);
    const row = (await screen.findByText('Synthetic plain')).closest('tr')!;
    expect(screen.getByText(/This job has no selection stages yet/)).toBeInTheDocument();
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['Screening', 'Shortlisted', 'Not selected']);
    expect(within(row).getByText('No rules')).toBeInTheDocument();
  });
});
