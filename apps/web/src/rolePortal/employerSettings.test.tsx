/**
 * The employer Settings screen, trust-case participation and the operations side of both (EMP-16).
 *
 * Renders the real route dispatcher for the existing "Settings" label with the API stubbed at fetch,
 * and checks that the screen shows only what the server returned: the terms with their legal-review
 * state (a draft is never presented as final), acceptance by an owner only, the enforced retention
 * values, the viewer's own notifications, and the trust cases the organisation may see, with respond
 * and appeal. The operator side shows the employer's words on the case timeline and asks for a
 * response only with a summary. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import type { EmployerSettingsDto, EmployerTrustCaseDetailDto } from '../api/employerTerms.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './employer.js';
import { EmployerOrganisationStatusPage } from './employerOrganisationState.js';
import { OperationsTrustSafetyPage } from './trustSafety.js';
import { EmployerTermsSection } from './operationsEmployerTerms.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));

const employerId = '44444444-4444-4444-8444-444444444444';
const caseId = '66666666-6666-4666-8666-666666666666';
const base = `/api/v1/employers/${employerId}`;
const portal = rolePortals.find((item) => item.key === 'recruiter')!;

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
let routes: Record<string, Handler>;
let role: string;

function settingsFor(overrides: Partial<EmployerSettingsDto['terms']> = {}): EmployerSettingsDto {
  return {
    terms: {
      status: 'ACCEPTANCE_REQUIRED',
      current: { version: '2026-10-draft-1', title: 'ONE employer terms', body: 'Candidate data is for this hiring process only.',
        bodySha256: 'a'.repeat(64), legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: null, requiresReacceptance: true,
        changeSummary: null, publishedAt: '2026-09-29T00:00:00.000Z' },
      required: { version: '2026-10-draft-1', publishedAt: '2026-09-29T00:00:00.000Z' },
      latestAcceptance: null, currentVersionAccepted: false, canAccept: true,
      ...overrides,
    },
    retention: { accessEndsWhen: ['APPLICATION_CLOSED', 'CANDIDATE_WITHDREW'], resumeLinkSeconds: 60, messageRetentionDaysAfterAccessEnds: 180,
      candidateDeletionGraceDays: 30, heldForOpenTrustCasesAndLegalHolds: true },
    notificationPreferences: null,
    notificationDefaults: { emailEnabled: true, quietHoursStartMinute: 1320, quietHoursEndMinute: 420, dailyCap: 3 },
  };
}

function caseDetail(overrides: Partial<EmployerTrustCaseDetailDto> = {}): EmployerTrustCaseDetailDto {
  return {
    id: caseId, caseType: 'EMPLOYER_ACCOUNTABILITY', status: 'RESPONSE_REQUESTED', subject: { kind: 'ORGANIZATION' },
    responseRequestedAt: '2026-09-28T00:00:00.000Z', decidedAt: null, canRespond: true, canAppeal: false,
    statements: [{ kind: 'ALLEGATION_SUMMARY', body: 'A candidate reports a request for payment.', createdAt: '2026-09-28T00:00:00.000Z' }],
    actions: [], evidence: { shared: [], withheldCount: 3 },
    ...overrides,
  };
}

beforeEach(() => {
  routes = {};
  role = 'EMPLOYER_OWNER';
  vi.mocked(getProtectedAccessToken).mockReturnValue('session-token');
  vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: 'u', memberships: [
    { organizationId: employerId, role, scope: { organizationId: employerId, employerId } },
  ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, window.location.origin).pathname;
    const key = `${init?.method ?? 'GET'} ${path}`;
    const handler = routes[key];
    if (!handler) throw new Error('Unexpected endpoint ' + key);
    const result = handler(init);
    const status = result.status ?? 200;
    return { ok: status < 400, status, headers: new Headers(), json: async () => result.body };
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const bodies = (key: string) => vi.mocked(fetch).mock.calls
  .filter(([url, init]) => `${init?.method ?? 'GET'} ${new URL(url as string, window.location.origin).pathname}` === key)
  .map(([, init]) => JSON.parse(String(init!.body)) as unknown);
const showSettings = () => render(<EmployerRecruiterRealityPage portal={portal} routeLabel="Settings" />);

describe('EMP-16 employer Settings', () => {
  it('shows draft terms as a draft, and lets an owner accept the current version', async () => {
    let settings = settingsFor();
    routes[`GET ${base}/settings`] = () => ({ body: { settings } });
    routes[`GET ${base}/trust-cases`] = () => ({ body: { cases: [] } });
    routes[`POST ${base}/terms/accept`] = () => {
      settings = settingsFor({ status: 'ACCEPTED', canAccept: false, currentVersionAccepted: true,
        latestAcceptance: { version: '2026-10-draft-1', acceptedAt: '2026-09-29T10:00:00.000Z', acceptedBy: 'owner@acme.example' } });
      return { status: 201, body: { settings } };
    };
    showSettings();
    const terms = await screen.findByRole('region', { name: 'Employer terms' });
    expect(within(terms).getByText('Draft — pending legal review')).toBeInTheDocument();
    expect(within(terms).getByText('This text is a draft that has not finished legal review. It is not final.')).toBeInTheDocument();
    expect(within(terms).getByText('Candidate data is for this hiring process only.')).toBeInTheDocument();
    expect(within(terms).getByText(/must accept these terms before your organisation publishes another job\. Jobs already live stay live\./)).toBeInTheDocument();
    expect(screen.getByText('Acceptance needed')).toBeInTheDocument();
    fireEvent.click(within(terms).getByRole('button', { name: 'Accept version 2026-10-draft-1 for my organisation' }));
    expect(await screen.findByText('You accepted version 2026-10-draft-1 for your organisation.')).toBeInTheDocument();
    expect(bodies(`POST ${base}/terms/accept`)).toEqual([{ version: '2026-10-draft-1' }]);
    expect(within(terms).getByText(/Last accepted: version 2026-10-draft-1 on .* by owner@acme\.example\./)).toBeInTheDocument();
    expect(within(terms).queryByRole('button', { name: /Accept version/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
  });

  it('tells an admin that only an owner can accept, and leaves the accepted version out where nothing was accepted', async () => {
    role = 'EMPLOYER_ADMIN';
    routes[`GET ${base}/settings`] = () => ({ body: { settings: settingsFor({ canAccept: false }) } });
    routes[`GET ${base}/trust-cases`] = () => ({ body: { cases: [] } });
    showSettings();
    const terms = await screen.findByRole('region', { name: 'Employer terms' });
    expect(within(terms).getByText('Only an owner can accept the terms for the organisation.')).toBeInTheDocument();
    expect(within(terms).queryByRole('button')).not.toBeInTheDocument();
    // Nothing accepted: the "Version accepted" tile is left out, never shown as NA.
    expect(screen.queryByText('Version accepted')).not.toBeInTheDocument();
    expect(within(terms).getByText('Not accepted yet.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
    expect(await screen.findByText('There are no trust and safety cases about your organisation.')).toBeInTheDocument();
  });

  it('says plainly when no terms exist, shows the enforced retention values, and saves only the viewer\'s notifications', async () => {
    routes[`GET ${base}/settings`] = () => ({ body: { settings: settingsFor({ status: 'NO_TERMS_PUBLISHED', current: null, required: null, canAccept: false }) } });
    routes[`GET ${base}/trust-cases`] = () => ({ body: { cases: [] } });
    routes[`POST ${base}/settings/notification-preferences`] = (init) => ({ status: 201, body: { settings: { ...settingsFor(),
      notificationPreferences: { emailEnabled: false, quietHoursStartMinute: 1320, quietHoursEndMinute: 420, dailyCap: 3, ...JSON.parse(String(init!.body)) } } } });
    showSettings();
    expect(await screen.findByText('AI8HT has not published employer terms yet, so there is nothing to accept. Publishing works as it does today.')).toBeInTheDocument();
    const kept = screen.getByRole('region', { name: 'What ONE keeps' });
    expect(within(kept).getByText('Résumé downloads are single-use links that expire after 60 seconds.')).toBeInTheDocument();
    expect(within(kept).getByText('Message text is erased 180 days after your access to that candidate ends.')).toBeInTheDocument();
    expect(within(kept).getByText('Nothing is erased while an open trust and safety case or a legal hold needs it.')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Your notifications' });
    fireEvent.click(within(form).getByLabelText('Email me about hiring activity'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save notifications' }));
    expect(await screen.findByText('Your notification preferences are saved.')).toBeInTheDocument();
    expect(bodies(`POST ${base}/settings/notification-preferences`)).toEqual([{ emailEnabled: false, dailyCap: 3 }]);
  });

  it('keeps Settings with the owner and admin: a recruiter is told so and nothing is fetched', async () => {
    role = 'RECRUITER';
    showSettings();
    expect(await screen.findByRole('heading', { name: 'Managed by your owner or admin' })).toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'Opportunities', 'Opportunity Detail',
      'Applicants', 'Candidate Detail', 'Assessments', 'Interviews', 'Talent Pool', 'Offers', 'Reports', 'Team', 'Messages', 'Company Profile', 'Settings', 'Help & FAQ']);
  });

  it('explains a suspended employer instead of an empty screen', async () => {
    routes[`GET ${base}/settings`] = () => ({ status: 403, body: { error: { code: 'EMPLOYER_ORGANISATION_INACTIVE', correlationId: 'corr-4' } } });
    showSettings();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your employer account is suspended or was not approved, so Settings is not available. Support code: corr4');
  });
});

describe('EMP-16 trust cases for the employer', () => {
  it('shows what operations shared, lets the employer respond, then appeal a decision once', async () => {
    let detail = caseDetail();
    routes[`GET ${base}/settings`] = () => ({ body: { settings: settingsFor() } });
    routes[`GET ${base}/trust-cases`] = () => ({ body: { cases: [detail] } });
    routes[`GET ${base}/trust-cases/${caseId}`] = () => ({ body: { case: detail } });
    routes[`POST ${base}/trust-cases/${caseId}/response`] = (init) => {
      detail = caseDetail({ status: 'UNDER_REVIEW', canRespond: false, statements: [...detail.statements,
        { kind: 'EMPLOYER_RESPONSE', body: JSON.parse(String(init!.body)).statement, createdAt: '2026-09-29T00:00:00.000Z' }] });
      return { status: 201, body: { case: detail } };
    };
    showSettings();
    const panel = await screen.findByRole('region', { name: 'Trust and safety cases' });
    expect(within(panel).getByText('You are never told who reported it.', { exact: false })).toBeInTheDocument();
    expect(await within(panel).findByText('Your response is requested')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Open' }));
    expect(await within(panel).findByText('A candidate reports a request for payment.')).toBeInTheDocument();
    expect(within(panel).getByText(/3 further item\(s\) are held by AI8HT operations and not shared\./)).toBeInTheDocument();
    const form = within(panel).getByRole('form', { name: 'Respond to the case' });
    fireEvent.change(within(form).getByLabelText('Your response'), { target: { value: 'We never ask for payment.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send response' }));
    expect(await within(panel).findByText('Your response was sent to AI8HT operations.')).toBeInTheDocument();
    expect(bodies(`POST ${base}/trust-cases/${caseId}/response`)).toEqual([{ statement: 'We never ask for payment.' }]);
    expect(within(panel).getByText('We never ask for payment.')).toBeInTheDocument();
    expect(within(panel).queryByRole('form', { name: 'Respond to the case' })).not.toBeInTheDocument();
  });

  it('offers an appeal on a decided case and reports a second appeal plainly', async () => {
    const detail = caseDetail({ status: 'DECIDED', canRespond: false, canAppeal: true, decidedAt: '2026-09-29T00:00:00.000Z',
      actions: [{ action: 'WARNING', effectiveFrom: '2026-09-29T00:00:00.000Z', effectiveTo: null, reversed: false }] });
    routes[`GET ${base}/settings`] = () => ({ body: { settings: settingsFor() } });
    routes[`GET ${base}/trust-cases`] = () => ({ body: { cases: [detail] } });
    routes[`GET ${base}/trust-cases/${caseId}`] = () => ({ body: { case: detail } });
    routes[`POST ${base}/trust-cases/${caseId}/appeal`] = () => ({ status: 409, body: { error: { code: 'TRUST_CASE_ALREADY_APPEALED', correlationId: 'corr-8' } } });
    showSettings();
    const panel = await screen.findByRole('region', { name: 'Trust and safety cases' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Open' }));
    expect(await within(panel).findByText(/Warning from/)).toBeInTheDocument();
    const form = within(panel).getByRole('form', { name: 'Appeal the decision' });
    fireEvent.change(within(form).getByLabelText('Why the decision should change (you can appeal once)'), { target: { value: 'Please reconsider.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send appeal' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('This decision has already been appealed. Each decision can be appealed once. Support code: corr8');
  });

  it('shows the cases on a suspended employer\'s status page, where answering is still allowed', async () => {
    routes[`GET ${base}/trust-cases`] = () => ({ body: { cases: [caseDetail()] } });
    render(<EmployerOrganisationStatusPage routeLabel="Dashboard" employerId={employerId}
      organisation={{ verificationState: 'SUSPENDED', active: false, canDraft: false, canPublish: false, canReachCandidates: false }} />);
    expect(screen.getByText(/If operations has asked you to respond to a concern, or decided one, it is listed below\./)).toBeInTheDocument();
    expect(await screen.findByText('Your response is requested')).toBeInTheDocument();
  });

  it('tells a recruiter that cases are answered by the owner or admin', async () => {
    routes[`GET ${base}/trust-cases`] = () => ({ status: 403, body: { error: { code: 'FORBIDDEN', correlationId: 'corr-1' } } });
    render(<EmployerOrganisationStatusPage routeLabel="Dashboard" employerId={employerId}
      organisation={{ verificationState: 'REJECTED', active: true, canDraft: false, canPublish: false, canReachCandidates: false }} />);
    expect(await screen.findByText('Trust and safety cases are answered by your employer\'s owner or admin.')).toBeInTheDocument();
  });
});

describe('EMP-16 operations side', () => {
  const trustCase = { id: caseId, caseType: 'EMPLOYER_ACCOUNTABILITY', subjectKind: 'ORGANIZATION', state: 'TRIAGED', severity: 'HIGH',
    organizationId: employerId, organizationName: 'Acme Robotics', reportedByUserId: null, openedAt: '2026-09-27T00:00:00.000Z', closedAt: null, evidenceCount: 3, liveActions: 0 };

  it('asks an employer to respond only with a summary, and shows the employer\'s words on the timeline', async () => {
    let timeline = { id: caseId, state: 'TRIAGED', subjectEmployerId: employerId,
      events: [{ id: 'e1', from_state: 'REPORTED', to_state: 'TRIAGED', reason_code: 'OPERATIONS_REVIEW', occurred_at: '2026-09-27T01:00:00.000Z', actor_user_id: 'ops' }],
      employerStatements: [] as { id: string; kind: string; authorSide: string; body: string; authorEmail: string | null; createdAt: string }[] };
    routes['GET /api/v1/operations/trust-safety/cases'] = () => ({ body: { cases: [trustCase], pendingSignals: [] } });
    routes[`GET /api/v1/operations/trust-safety/cases/${caseId}`] = () => ({ body: { case: timeline } });
    routes[`POST /api/v1/operations/trust-safety/cases/${caseId}/request-response`] = (init) => {
      const { summary } = JSON.parse(String(init!.body)) as { summary: string };
      timeline = { ...timeline, state: 'UNDER_INVESTIGATION',
        events: [...timeline.events,
          { id: 'e2', from_state: 'TRIAGED', to_state: 'AWAITING_RESPONSE', reason_code: 'RIGHT_OF_REPLY', occurred_at: '2026-09-27T02:00:00.000Z', actor_user_id: 'ops' },
          { id: 'e3', from_state: 'AWAITING_RESPONSE', to_state: 'UNDER_INVESTIGATION', reason_code: 'EMPLOYER_RESPONDED', occurred_at: '2026-09-27T04:00:00.000Z', actor_user_id: 'admin' }],
        employerStatements: [
          { id: 's1', kind: 'ALLEGATION_SUMMARY', authorSide: 'OPERATIONS', body: summary, authorEmail: null, createdAt: '2026-09-27T02:00:00.000Z' },
          { id: 's2', kind: 'EMPLOYER_RESPONSE', authorSide: 'EMPLOYER', body: 'We never ask for payment.', authorEmail: null, createdAt: '2026-09-27T04:00:00.000Z' }] };
      return { status: 201, body: { case: timeline } };
    };
    render(<OperationsTrustSafetyPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for response' }));
    const section = await screen.findByRole('region', { name: 'Case timeline' });
    const form = within(section).getByRole('form', { name: 'Ask the employer to respond' });
    expect(within(form).getByRole('button', { name: 'Share and ask for response' })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Summary of the concern/), { target: { value: 'A candidate reports a request for payment.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Share and ask for response' }));
    expect(await within(section).findByText('We never ask for payment.')).toBeInTheDocument();
    expect(within(section).getByText('Employer response')).toBeInTheDocument();
    expect(within(section).getByText('AWAITING_RESPONSE → UNDER_INVESTIGATION')).toBeInTheDocument();
    expect(bodies(`POST /api/v1/operations/trust-safety/cases/${caseId}/request-response`)).toEqual([{ summary: 'A candidate reports a request for payment.', reasonCode: 'RIGHT_OF_REPLY' }]);
  });

  it('publishes terms from the Organizations screen only when opened, as a labelled draft', async () => {
    const versions: unknown[] = [];
    routes['GET /api/v1/operations/employer-terms'] = () => ({ body: { versions } });
    routes['POST /api/v1/operations/employer-terms'] = (init) => {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      const version = { ...body, bodySha256: 'b'.repeat(64), legalReviewReference: null, changeSummary: null, publishedAt: '2026-09-29T00:00:00.000Z', acceptedBy: 0 };
      versions.push(version);
      return { status: 201, body: { version } };
    };
    render(<EmployerTermsSection />);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manage employer terms' }));
    expect(await screen.findByText(/No employer terms have been published/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Publish employer terms' });
    fireEvent.change(within(form).getByLabelText('Version'), { target: { value: '2026-10-draft-1' } });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'ONE employer terms' } });
    fireEvent.change(within(form).getByLabelText('Terms text'), { target: { value: 'Draft text.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Publish version' }));
    expect(await screen.findByText('Version 2026-10-draft-1 is published. Every employer must accept it before its next publish.')).toBeInTheDocument();
    expect(bodies('POST /api/v1/operations/employer-terms')).toEqual([{ version: '2026-10-draft-1', title: 'ONE employer terms', body: 'Draft text.',
      legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', requiresReacceptance: true, reasonCode: 'TERMS_PUBLISHED' }]);
    expect(await screen.findByText('Draft — pending legal review', { selector: 'span' })).toBeInTheDocument();
  });
});
