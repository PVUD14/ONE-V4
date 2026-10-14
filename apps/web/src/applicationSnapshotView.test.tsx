/**
 * EMP-07 web: the student reviews what applying shares, and the employer's Candidate Detail shows
 * exactly that — contact details only from SHORTLISTED, eligibility as outcome and basis, the
 * résumé only through the single-use link — with honest states for a withheld candidate, an
 * application from before snapshots, and Talent Pool.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EmployerApplicantsPage, StudentOpportunitiesPage } from './hiringPages.js';
import { EmployerCandidateDetailPage, EmployerTalentPoolPage } from './rolePortal/employerCandidateDetail.js';

const opportunityId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';
const resumeDocumentId = '33333333-3333-4333-8333-333333333333';
const employerId = 'employer';
const hash = 'a'.repeat(64);
const hash2 = 'b'.repeat(64);

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  candidate: { fullName: 'Synthetic Candidate', email: 'candidate@uat.example.test', phone: null },
  education: { institutionName: 'Synthetic Institute', programmeName: 'BTech', departmentName: 'Computer Science', expectedGraduationYear: 2027 },
  qualifications: [{ qualificationType: 'BTECH', programmeName: 'BTech Computer Science', institutionName: 'Synthetic Institute', startedYear: 2023, completedYear: null, awarded: false, verification: 'SELF_REPORTED' }],
  profile: { headline: 'Aspiring analyst', summary: null },
  links: [],
  resume: null,
  ...overrides,
});

type Handler = (init?: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string>; blob?: Blob };
let routes: Record<string, Handler>;
let calls: { path: string; init?: RequestInit }[];

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, ...(init ? { init } : {}) });
    const handler = routes[path] ?? routes[path.split('?')[0] ?? ''];
    const result = handler ? handler(init) : { body: {} };
    const status = result.status ?? 200;
    const headers = new Map(Object.entries(result.headers ?? {}));
    return { ok: status < 400, status, headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => result.body, blob: async () => result.blob ?? new Blob([]) };
  }));
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
const posts = (suffix: string) => calls.filter((call) => call.init?.method === 'POST' && call.path.endsWith(suffix)).map((call) => JSON.parse(String(call.init!.body)));

describe('EMP-07 student: review what the employer will see, then apply with exactly that', () => {
  const opportunity = { id: opportunityId, referenceCode: 'R-1', employerName: 'Aster Mobility', title: 'Graduate analyst', summary: null, employmentType: 'FULL_TIME',
    workMode: 'ONSITE', locationCity: 'Chennai', durationMonths: null, applicationDeadline: null, publishedAt: null, compensation: null, alreadyApplied: false };
  const detail = { opportunity: { ...opportunity, responsibilities: null, positionsAvailable: 1, joiningConditions: null, skills: [], selectionStages: [] },
    eligibility: { eligible: true, blockingFailures: [], advisoryFailures: [], needsMoreInformation: [], rules: [] } };
  const resumeOption = { documentId: resumeDocumentId, title: 'My résumé', versionNumber: 2, filename: 'resume.pdf', contentType: 'application/pdf', byteSize: 2048 };

  it('shows the snapshot, rebuilds it when a résumé is chosen, and applies with the reviewed hash and choices', async () => {
    routes = {
      '/api/v1/opportunities': () => ({ body: { opportunities: [opportunity] } }),
      [`/api/v1/opportunities/${opportunityId}`]: () => ({ body: detail }),
      '/api/v1/students/me/application-previews': (init) => {
        const body = JSON.parse(String(init?.body));
        return body.resumeDocumentId
          ? { body: { preview: { employerName: 'Aster Mobility', snapshot: snapshot({ resume: { title: 'My résumé', filename: 'resume.pdf', versionNumber: 2, contentType: 'application/pdf', byteSize: 2048 } }), snapshotHash: hash2, resumeOptions: [resumeOption] } } }
          : { body: { preview: { employerName: 'Aster Mobility', snapshot: snapshot(), snapshotHash: hash, resumeOptions: [resumeOption] } } };
      },
      '/api/v1/students/me/applications': () => ({ body: { application: { id: applicationId, state: 'APPLIED' } } }),
    };
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(await screen.findByRole('heading', { name: 'What Aster Mobility will see' })).toBeInTheDocument();
    const shared = await screen.findByLabelText('Shared profile');
    expect(within(shared).getByText('Synthetic Candidate')).toBeInTheDocument();
    expect(within(shared).getByText('No résumé attached.')).toBeInTheDocument();
    expect(within(shared).getByText('self-reported')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/readiness band|readiness score/i);

    fireEvent.change(screen.getByLabelText('Résumé to attach'), { target: { value: resumeDocumentId } });
    expect(await screen.findByText(/My résumé — resume.pdf, version 2, 2 KB/)).toBeInTheDocument();
    expect(posts('/application-previews').at(-1)).toEqual({ opportunityId, resumeDocumentId });

    fireEvent.click(screen.getByRole('button', { name: 'Apply and share my profile' }));
    await waitFor(() => expect(posts('/students/me/applications')).toHaveLength(1));
    expect(posts('/students/me/applications')[0]).toEqual({ opportunityId, consentGranted: true, institutionVisibilityGranted: false, resumeDocumentId, reviewedSnapshotHash: hash2 });
  });

  it('asks the student to look again when what they reviewed changed', async () => {
    routes = {
      '/api/v1/opportunities': () => ({ body: { opportunities: [opportunity] } }),
      [`/api/v1/opportunities/${opportunityId}`]: () => ({ body: detail }),
      '/api/v1/students/me/application-previews': () => ({ body: { preview: { employerName: 'Aster Mobility', snapshot: snapshot(), snapshotHash: hash, resumeOptions: [] } } }),
      '/api/v1/students/me/applications': () => ({ status: 409, body: { error: { code: 'SNAPSHOT_CHANGED', correlationId: 'c-1' } } }),
    };
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    await screen.findByLabelText('Shared profile');
    expect(screen.getByText('Upload a résumé under Documents to attach one.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply and share my profile' }));
    expect(await screen.findByText(/Something you would share changed after you reviewed it/)).toBeInTheDocument();
    await waitFor(() => expect(posts('/application-previews').length).toBeGreaterThanOrEqual(2));
  });
});

const candidate = (overrides: Record<string, unknown> = {}) => ({
  application: { id: applicationId, opportunityId, state: 'APPLIED', title: 'Graduate analyst', appliedVersionNumber: 2, currentVersionNumber: 3,
    submittedAt: '2026-09-20T00:00:00.000Z', closedAt: null, updatedAt: '2026-09-20T00:00:00.000Z', termsAcknowledgementPending: false },
  snapshot: snapshot({ candidate: { fullName: 'Synthetic Candidate', email: null, phone: null, contactVisibleFrom: 'SHORTLISTED' },
    resume: { title: 'My résumé', filename: 'resume.pdf', versionNumber: 2, contentType: 'application/pdf', byteSize: 2048 },
    links: [{ label: 'Portfolio', url: 'https://portfolio.example.test/me' }] }),
  snapshotStatus: 'SHARED', sharedAt: '2026-09-20T00:00:00.000Z', resumeAvailable: true,
  eligibility: { eligible: true, evaluatedAt: '2026-09-20T00:00:00.000Z', trigger: 'APPLY', versionNumber: 2, flagCount: 1, selfReportedCount: 1,
    outcomes: [{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7, valueText: null, isBlocking: true, outcome: 'MET', basis: 'SELF_REPORTED', flagged: true, unknownReason: null }] },
  timeline: [{ fromState: 'DRAFT', toState: 'APPLIED', actor: 'STUDENT', reasonCode: null, occurredAt: '2026-09-20T00:00:00.000Z' }],
  interviews: [], offer: null,
  ...overrides,
});
const applicantRow = (id: string, access: boolean, name: string) => ({ id, state: 'APPLIED', consentRevoked: false, candidateAccess: access,
  candidateName: access ? name : null, candidateEmail: null, institutionStudentId: null, submittedAt: null, closedAt: null, interviewCount: 0, offerState: null, updatedAt: '2026-09-20T00:00:00.000Z' });
const employerOpportunity = { id: opportunityId, referenceCode: 'R-1', title: 'Graduate analyst', lifecycleState: 'PUBLISHED', applicationCount: 2 };

describe('EMP-07 employer: Candidate Detail', () => {
  beforeEach(() => {
    routes = {
      [`/api/v1/employers/${employerId}/opportunities`]: () => ({ body: { opportunities: [employerOpportunity] } }),
      [`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications`]: () => ({ body: { applications: [applicantRow(applicationId, true, 'Synthetic Candidate'), applicantRow('44444444-4444-4444-8444-444444444444', false, 'Hidden')], stages: [] } }),
      [`/api/v1/employers/${employerId}/applications/${applicationId}`]: () => ({ body: { candidate: candidate() } }),
    };
  });

  it('opens a shared candidate: what they shared, contact after shortlisting, eligibility basis, timeline — never readiness', async () => {
    await authenticate();
    render(<EmployerCandidateDetailPage employerId={employerId} />);
    fireEvent.change(await screen.findByLabelText('Job'), { target: { value: opportunityId } });
    const picker = await screen.findByLabelText('Candidate');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    expect(screen.getByText('1 applicant is no longer sharing their details and cannot be opened.')).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: applicationId } });

    const panel = await screen.findByRole('region', { name: 'Candidate detail' });
    expect(await within(panel).findByText('Synthetic Candidate')).toBeInTheDocument();
    expect(within(panel).getByText('Contact details are shown once you shortlist this candidate.')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Portfolio' })).toHaveAttribute('href', 'https://portfolio.example.test/me');
    expect(within(panel).getByText(/applied under version 2 \(the job is now on version 3\)/)).toBeInTheDocument();
    expect(within(within(panel).getByRole('list', { name: 'Eligibility outcomes' })).getByText(/met/)).toBeInTheDocument();
    expect(within(panel).getByRole('list', { name: 'Stage timeline' })).toHaveTextContent('Applied');
    expect(within(panel).getByText('No interviews yet.')).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/readiness|mastery|score/i);
  });

  it('downloads the résumé through the single-use link', async () => {
    routes[`/api/v1/employers/${employerId}/applications/${applicationId}/resume`] = () => ({ body: { download: { path: `/api/v1/employers/${employerId}/applications/${applicationId}/resume/file?token=${'t'.repeat(43)}`, expiresAt: '2026-09-26T00:01:00.000Z' } } });
    routes[`/api/v1/employers/${employerId}/applications/${applicationId}/resume/file`] = () => ({ body: null, blob: new Blob(['pdf']), headers: { 'content-disposition': 'attachment; filename="resume.pdf"' } });
    const createObjectURL = vi.fn(() => 'blob:resume');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await authenticate();
    render(<EmployerCandidateDetailPage employerId={employerId} />);
    fireEvent.change(await screen.findByLabelText('Job'), { target: { value: opportunityId } });
    const picker = await screen.findByLabelText('Candidate');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(picker, { target: { value: applicationId } });
    fireEvent.click(await screen.findByRole('button', { name: 'Download résumé' }));
    expect(await screen.findByText('Résumé downloaded. The download was recorded.')).toBeInTheDocument();
    expect(calls.map((call) => call.path)).toContain(`/api/v1/employers/${employerId}/applications/${applicationId}/resume/file?token=${'t'.repeat(43)}`);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it('says so when the candidate stopped sharing, and when they applied before snapshots existed', async () => {
    routes[`/api/v1/employers/${employerId}/applications/${applicationId}`] = () => ({ status: 403, body: { error: { code: 'FORBIDDEN', correlationId: 'c-9' } } });
    await authenticate();
    render(<EmployerCandidateDetailPage employerId={employerId} />);
    fireEvent.change(await screen.findByLabelText('Job'), { target: { value: opportunityId } });
    const picker = await screen.findByLabelText('Candidate');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(picker, { target: { value: applicationId } });
    expect(await screen.findByText('This candidate is no longer sharing their details with you, or you do not have access to them.')).toBeInTheDocument();

    cleanup();
    routes[`/api/v1/employers/${employerId}/applications/${applicationId}`] = () => ({ body: { candidate: candidate({ snapshot: null, snapshotStatus: 'NOT_CAPTURED', resumeAvailable: false }) } });
    render(<EmployerCandidateDetailPage employerId={employerId} />);
    fireEvent.change(await screen.findByLabelText('Job'), { target: { value: opportunityId } });
    const again = await screen.findByLabelText('Candidate');
    await waitFor(() => expect(within(again).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(again, { target: { value: applicationId } });
    expect(await screen.findByText(/applied before ONE kept a copy of what was shared/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download résumé' })).not.toBeInTheDocument();
  });

  it('offers View candidate on Applicants only for people still sharing', async () => {
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} />);
    const buttons = await screen.findAllByRole('link', { name: 'View candidate' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(await screen.findByRole('region', { name: 'Candidate detail' })).toBeInTheDocument();
  });

  it('keeps Talent Pool honest while consented discovery is switched off (EMP-14, HG-4 pending)', async () => {
    await authenticate();
    routes = { [`/api/v1/employers/${employerId}/talent-pool`]: () => ({ body: { talentPool: { available: false } } }) };
    render(<EmployerTalentPoolPage employerId={employerId} />);
    expect(await screen.findByRole('heading', { name: 'Not available yet' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Talent Pool' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Search the talent pool' })).not.toBeInTheDocument();
  });
});
