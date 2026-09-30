/**
 * EMP-13 web: the student ticks which verified evidence to share while applying and can change or
 * take it back from Applications; the employer reads it per job skill on Candidate Detail and may
 * filter applicants by one skill — with no total, score, stage or ranking on screen, and nothing at
 * all while the feature is off (HG-4 pending).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EmployerApplicantsPage, StudentApplicationsPage, StudentOpportunitiesPage } from './hiringPages.js';
import { EmployerCandidateDetailPage } from './rolePortal/employerCandidateDetail.js';

const opportunityId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';
const evidenceA = '55555555-5555-4555-8555-555555555555';
const evidenceB = '66666666-6666-4666-8666-666666666666';
const sqlTopic = '77777777-7777-4777-8777-777777777777';
const employerId = 'employer';
const hash = 'a'.repeat(64);

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
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
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => result.body };
  }));
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
const bodies = (method: string, suffix: string) => calls.filter((call) => call.init?.method === method && call.path.endsWith(suffix)).map((call) => JSON.parse(String(call.init!.body)));

const snapshot = {
  schemaVersion: 1, candidate: { fullName: 'Synthetic Candidate', email: 'candidate@uat.example.test', phone: null },
  education: null, qualifications: [], profile: { headline: null, summary: null }, links: [], resume: null,
};
const item = (evidenceId: string, overrides: Record<string, unknown> = {}) => ({
  evidenceId, type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: '2026-09-20T00:00:00.000Z', unaided: true, ...overrides,
});
const choiceSkills = [
  { name: 'Synthetic SQL', level: 'REQUIRED', catalogue: true, items: [item(evidenceA), item(evidenceB, { source: 'INSTITUTION_EXAM', unaided: false })] },
  { name: 'Written communication', level: 'REQUIRED', catalogue: false, items: [] },
  { name: 'Synthetic statistics', level: 'PREFERRED', catalogue: true, items: [] },
];

describe('EMP-13 student: choose evidence while applying', () => {
  const opportunity = { id: opportunityId, referenceCode: 'R-1', employerName: 'Aster Mobility', title: 'Graduate analyst', summary: null, employmentType: 'FULL_TIME',
    workMode: 'ONSITE', locationCity: 'Chennai', durationMonths: null, applicationDeadline: null, publishedAt: null, compensation: null, alreadyApplied: false };
  const detail = { opportunity: { ...opportunity, responsibilities: null, positionsAvailable: 1, joiningConditions: null, skills: [], selectionStages: [] },
    eligibility: { eligible: true, blockingFailures: [], advisoryFailures: [], needsMoreInformation: [], rules: [] } };
  const withPreview = (evidence: unknown) => {
    routes = {
      '/api/v1/opportunities': () => ({ body: { opportunities: [opportunity] } }),
      [`/api/v1/opportunities/${opportunityId}`]: () => ({ body: detail }),
      '/api/v1/students/me/application-previews': () => ({ body: { preview: { employerName: 'Aster Mobility', snapshot, snapshotHash: hash, resumeOptions: [], evidence } } }),
      '/api/v1/students/me/applications': () => ({ body: { application: { id: applicationId, state: 'APPLIED' } } }),
    };
  };

  it('lists verified evidence per job skill in plain words and applies with only the ticked items', async () => {
    withPreview({ available: true, skills: choiceSkills });
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    const section = await screen.findByRole('list', { name: 'Skill evidence to share' });
    expect(within(section).getByText('Not a ONE catalogue skill, so no evidence can be matched to it.')).toBeInTheDocument();
    expect(within(section).getByText('You have no verified evidence for this skill yet.')).toBeInTheDocument();
    expect(within(section).getByText(/Institution exam · .* · aided \(hint or tutor\)/)).toBeInTheDocument();
    expect(screen.getByText(/Never your readiness, marks, scores or a total/)).toBeInTheDocument();
    const boxes = within(section).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Apply and share my profile' }));
    await waitFor(() => expect(bodies('POST', '/students/me/applications')).toHaveLength(1));
    expect(bodies('POST', '/students/me/applications')[0]).toEqual({ opportunityId, consentGranted: true, institutionVisibilityGranted: false, reviewedSnapshotHash: hash, evidenceRecordIds: [evidenceA] });
  });

  it('shows nothing and sends nothing while the feature is off', async () => {
    withPreview({ available: false, skills: [] });
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    await screen.findByLabelText('Shared profile');
    expect(screen.queryByRole('list', { name: 'Skill evidence to share' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply and share my profile' }));
    await waitFor(() => expect(bodies('POST', '/students/me/applications')).toHaveLength(1));
    expect(bodies('POST', '/students/me/applications')[0]).not.toHaveProperty('evidenceRecordIds');
  });
});

/** The panels under Applications load their own lists; empty ones keep them quiet. */
const studentPanels: Record<string, Handler> = {
  '/api/v1/students/me/interviews': () => ({ body: { interviews: [] } }),
  '/api/v1/students/me/offers': () => ({ body: { offers: [] } }),
  '/api/v1/students/me/external-applications': () => ({ body: { externalApplications: [], total: 0, offset: 0, limit: 50 } }),
  '/api/v1/students/me/nominations': () => ({ body: { nominations: [] } }),
};

describe('EMP-13 student: change or take back evidence from Applications', () => {
  const application = { id: applicationId, state: 'APPLIED', opportunityId, employerName: 'Aster Mobility', title: 'Graduate analyst', employmentType: 'FULL_TIME',
    workMode: 'ONSITE', locationCity: null, submittedAt: '2026-09-20T00:00:00.000Z', closedAt: null, consentRevokedAt: null,
    institutionVisibilityGrantedAt: null, institutionVisibilityRevokedAt: null, updatedAt: '2026-09-20T00:00:00.000Z', termsAcknowledgementPending: false,
    feedbackReleased: false, evidenceShared: true };
  const evidenceView = (shared: string[], canShare = true) => ({ evidence: { available: canShare, canShare, employerName: 'Aster Mobility',
    skills: choiceSkills.map((skill) => ({ ...skill, items: skill.items.map((entry) => ({ ...entry, shared: shared.includes(entry.evidenceId), sharedAt: null })) })) } });

  it('opens the application\'s evidence, saves a change and can stop sharing all', async () => {
    let shared = [evidenceA, evidenceB];
    routes = {
      ...studentPanels,
      '/api/v1/students/me/applications': () => ({ body: { applications: [application], evidenceSharingAvailable: true } }),
      [`/api/v1/students/me/applications/${applicationId}/evidence`]: (init) => {
        if (init?.method === 'PUT') shared = (JSON.parse(String(init.body)) as { evidenceRecordIds: string[] }).evidenceRecordIds;
        return { body: evidenceView(shared) };
      },
    };
    await authenticate();
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skill evidence for Graduate analyst' }));
    const card = await screen.findByRole('region', { name: 'Skill evidence for this application' });
    const boxes = await within(card).findAllByRole('checkbox');
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, true]);
    fireEvent.click(boxes[1]!);
    fireEvent.click(within(card).getByRole('button', { name: 'Save what I share' }));
    expect(await within(card).findByText('Saved. Aster Mobility now sees what is ticked above.')).toBeInTheDocument();
    expect(bodies('PUT', '/evidence').at(-1)).toEqual({ evidenceRecordIds: [evidenceA] });
    fireEvent.click(within(card).getByRole('button', { name: 'Stop sharing all evidence' }));
    expect(await within(card).findByText('Stopped. Aster Mobility no longer sees any of your evidence for this application.')).toBeInTheDocument();
    expect(bodies('PUT', '/evidence').at(-1)).toEqual({ evidenceRecordIds: [] });
  });

  it('hides the control while the feature is off unless something is still shared', async () => {
    routes = { ...studentPanels, '/api/v1/students/me/applications': () => ({ body: { applications: [{ ...application, evidenceShared: false }], evidenceSharingAvailable: false } }) };
    await authenticate();
    render(<StudentApplicationsPage />);
    await screen.findByText('Graduate analyst');
    expect(screen.queryByRole('button', { name: 'Skill evidence for Graduate analyst' })).not.toBeInTheDocument();
    cleanup();
    routes = {
      ...studentPanels,
      '/api/v1/students/me/applications': () => ({ body: { applications: [application], evidenceSharingAvailable: false } }),
      [`/api/v1/students/me/applications/${applicationId}/evidence`]: () => ({ body: evidenceView([evidenceA], false) }),
    };
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Skill evidence for Graduate analyst' }));
    expect(await screen.findByText('Sharing new evidence is not available right now. Anything already shared is listed so you can take it back.')).toBeInTheDocument();
  });
});

const applicantRow = (id: string, name: string) => ({ id, state: 'APPLIED', consentRevoked: false, candidateAccess: true, candidateName: name, candidateEmail: null,
  institutionStudentId: null, submittedAt: null, closedAt: null, interviewCount: 0, offerState: null, updatedAt: '2026-09-20T00:00:00.000Z' });
const employerOpportunity = { id: opportunityId, referenceCode: 'R-1', title: 'Graduate analyst', lifecycleState: 'PUBLISHED', applicationCount: 2 };
const candidateDetail = {
  application: { id: applicationId, opportunityId, state: 'APPLIED', title: 'Graduate analyst', appliedVersionNumber: 1, currentVersionNumber: 1,
    submittedAt: '2026-09-20T00:00:00.000Z', closedAt: null, updatedAt: '2026-09-20T00:00:00.000Z', termsAcknowledgementPending: false },
  snapshot: { ...snapshot, candidate: { fullName: 'Synthetic Candidate', email: null, phone: null, contactVisibleFrom: 'SHORTLISTED' } },
  snapshotStatus: 'SHARED', sharedAt: '2026-09-20T00:00:00.000Z', resumeAvailable: false, eligibility: null,
  timeline: [{ fromState: 'DRAFT', toState: 'APPLIED', actor: 'STUDENT', reasonCode: null, occurredAt: '2026-09-20T00:00:00.000Z' }], interviews: [], offer: null,
};

describe('EMP-13 employer: the Evidence panel on Candidate Detail', () => {
  const open = async () => {
    await authenticate();
    render(<EmployerCandidateDetailPage employerId={employerId} />);
    fireEvent.change(await screen.findByLabelText('Job'), { target: { value: opportunityId } });
    const picker = await screen.findByLabelText('Candidate');
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(picker, { target: { value: applicationId } });
    return screen.findByRole('region', { name: 'Candidate detail' });
  };
  beforeEach(() => {
    routes = {
      [`/api/v1/employers/${employerId}/opportunities`]: () => ({ body: { opportunities: [employerOpportunity] } }),
      [`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications`]: () => ({ body: { applications: [applicantRow(applicationId, 'Synthetic Candidate')], stages: [] } }),
      [`/api/v1/employers/${employerId}/applications/${applicationId}`]: () => ({ body: { candidate: candidateDetail } }),
    };
  });

  it('lists what the candidate shared per job skill — never a total, a score or a ranking', async () => {
    routes[`/api/v1/employers/${employerId}/applications/${applicationId}/evidence`] = () => ({ body: { evidence: { available: true, skills: [
      { name: 'Synthetic SQL', level: 'REQUIRED', catalogue: true, items: [
        { type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: '2026-09-20T00:00:00.000Z', unaided: true, sharedAt: '2026-09-21T00:00:00.000Z' },
        { type: 'TOPIC_DEMONSTRATION', source: 'INSTITUTION_EXAM', occurredAt: '2026-09-18T00:00:00.000Z', unaided: false, sharedAt: '2026-09-21T00:00:00.000Z' },
      ] },
      { name: 'Written communication', level: 'REQUIRED', catalogue: false, items: [] },
      { name: 'Synthetic statistics', level: 'PREFERRED', catalogue: true, items: [] },
    ] } } });
    await open();
    const evidence = await screen.findByRole('region', { name: 'Skill evidence' });
    const perSkill = within(evidence).getByRole('list', { name: 'Evidence per skill' });
    expect(within(perSkill).getByText(/Assessment outcome · ONE skill check · .* · unaided/)).toBeInTheDocument();
    expect(within(perSkill).getByText(/Topic demonstration · Institution exam · .* · aided/)).toBeInTheDocument();
    expect(within(perSkill).getByText('Synthetic statistics (preferred)')).toBeInTheDocument();
    expect(within(perSkill).getByText('No evidence shared.')).toBeInTheDocument();
    expect(within(perSkill).getByText('Not a ONE catalogue skill, so evidence cannot be matched to it.')).toBeInTheDocument();
    expect(evidence.textContent).not.toMatch(/readiness|mastery|score|band|stage|%/i);
    expect(evidence.textContent).not.toMatch(/\b\d+ (items?|of \d+)\b/);
  });

  it('renders nothing while the feature is off, and says so when the grant has ended', async () => {
    routes[`/api/v1/employers/${employerId}/applications/${applicationId}/evidence`] = () => ({ body: { evidence: { available: false, skills: [] } } });
    const panel = await open();
    await within(panel).findByText('Synthetic Candidate');
    await waitFor(() => expect(calls.some((call) => call.path.endsWith(`/applications/${applicationId}/evidence`))).toBe(true));
    expect(screen.queryByRole('region', { name: 'Skill evidence' })).not.toBeInTheDocument();
    cleanup();
    routes[`/api/v1/employers/${employerId}/applications/${applicationId}/evidence`] = () => ({ status: 403, body: { error: { code: 'FORBIDDEN', correlationId: 'c-1' } } });
    await open();
    expect(await screen.findByText('This candidate is no longer sharing their details with you.')).toBeInTheDocument();
  });
});

describe('EMP-13 employer: filter applicants by shared evidence for one skill', () => {
  it('offers the job\'s catalogue skills, narrows the list on request, and keeps no filter when the feature is off', async () => {
    const second = '88888888-8888-4888-8888-888888888888';
    routes = {
      [`/api/v1/employers/${employerId}/opportunities`]: () => ({ body: { opportunities: [employerOpportunity] } }),
      [`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications`]: () => ({ body: {
        applications: [applicantRow(applicationId, 'Synthetic One'), applicantRow(second, 'Synthetic Two')], stages: [],
        evidenceSkills: [{ topicId: sqlTopic, name: 'Synthetic SQL' }] } }),
      [`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications?evidenceSkill=${sqlTopic}`]: () => ({ body: {
        applications: [applicantRow(second, 'Synthetic Two')], stages: [], evidenceSkills: [{ topicId: sqlTopic, name: 'Synthetic SQL' }] } }),
    };
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} />);
    expect(await screen.findByText('Synthetic One')).toBeInTheDocument();
    const filter = await screen.findByLabelText('Has shared verified evidence for');
    fireEvent.change(filter, { target: { value: sqlTopic } });
    await waitFor(() => expect(screen.queryByText('Synthetic One')).not.toBeInTheDocument());
    expect(screen.getByText('Synthetic Two')).toBeInTheDocument();
    expect(screen.getByText(/This is a filter, not a ranking/)).toBeInTheDocument();
    expect(calls.map((call) => call.path)).toContain(`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications?evidenceSkill=${sqlTopic}`);

    cleanup();
    routes[`/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications`] = () => ({ body: { applications: [applicantRow(applicationId, 'Synthetic One')], stages: [] } });
    render(<EmployerApplicantsPage employerId={employerId} />);
    expect(await screen.findByText('Synthetic One')).toBeInTheDocument();
    expect(screen.queryByLabelText('Has shared verified evidence for')).not.toBeInTheDocument();
  });
});
