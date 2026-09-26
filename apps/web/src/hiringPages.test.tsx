import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EmployerApplicantsPage, EmployerInterviewsPage, EmployerOffersPage, EmployerHiringAnalyticsPage, StudentApplicationsPage, StudentOpportunitiesPage, StudentExternalApplicationsPanel } from './hiringPages.js';

const opportunity = {
  id: '11111111-1111-4111-8111-111111111111',
  referenceCode: 'SOC-2026-01',
  employerName: 'Aster Mobility',
  title: 'SOC Analyst Intern',
  summary: 'Work alongside the security operations team.',
  employmentType: 'INTERNSHIP',
  workMode: 'ONSITE',
  locationCity: 'Bengaluru',
  durationMonths: 6,
  applicationDeadline: '2026-10-01T00:00:00.000Z',
  publishedAt: '2026-08-01T00:00:00.000Z',
  compensation: { currency: 'INR', min: '25000.00', max: null, period: 'MONTH' },
  alreadyApplied: false,
};

const detail = {
  opportunity: { ...opportunity, responsibilities: 'Triage alerts.', positionsAvailable: 2, joiningConditions: null,
    skills: [{ name: 'SIEM', level: 'REQUIRED' }, { name: 'Python', level: 'PREFERRED' }],
    selectionStages: [{ order: 1, kind: 'INTERVIEW', label: 'Technical interview', detail: null }] },
  eligibility: { eligible: true, blockingFailures: [], advisoryFailures: [], needsMoreInformation: [] },
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

describe('student opportunity discovery', () => {
  it('lists open opportunities with pay and deadline', async () => {
    stubFetch({ '/api/v1/opportunities': { opportunities: [opportunity] } });
    await authenticate();
    render(<StudentOpportunitiesPage />);
    expect(await screen.findByRole('heading', { name: 'SOC Analyst Intern' })).toBeInTheDocument();
    expect(screen.getByText(/Aster Mobility/)).toBeInTheDocument();
    expect(screen.getByText(/INR 25,000 \/ month/)).toBeInTheDocument();
    expect(screen.getByText('1 open opportunity.')).toBeInTheDocument();
  });

  it('says nothing is open rather than showing invented roles', async () => {
    stubFetch({ '/api/v1/opportunities': { opportunities: [] } });
    await authenticate();
    render(<StudentOpportunitiesPage />);
    await waitFor(() => expect(screen.getByText('No opportunities are open to you right now.')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('Rahul');
  });

  it('explains what the employer wants and confirms eligibility', async () => {
    stubFetch({ '/api/v1/opportunities': { opportunities: [opportunity] }, [`/api/v1/opportunities/${opportunity.id}`]: detail });
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(await screen.findByText('You meet everything the employer asked for.')).toBeInTheDocument();
    expect(screen.getByText('SIEM')).toBeInTheDocument();
    expect(screen.getByText('Python (preferred)')).toBeInTheDocument();
    expect(screen.getByText(/Applying shares your profile with Aster Mobility for this role only/)).toBeInTheDocument();
  });

  it('says it cannot confirm a missing fact instead of rejecting the student', async () => {
    stubFetch({
      '/api/v1/opportunities': { opportunities: [opportunity] },
      [`/api/v1/opportunities/${opportunity.id}`]: { ...detail, eligibility: { eligible: false, blockingFailures: [], advisoryFailures: [], needsMoreInformation: ['MIN_CGPA'] } },
    });
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(await screen.findByText(/We cannot confirm Min cgpa yet/)).toBeInTheDocument();
    expect(screen.queryByText(/You do not currently meet/)).not.toBeInTheDocument();
  });

  it('translates an API rule code into a sentence the student can act on', async () => {
    stubFetch(
      { '/api/v1/opportunities': { opportunities: [opportunity] }, [`/api/v1/opportunities/${opportunity.id}`]: detail },
      { '/api/v1/students/me/applications': { status: 400, body: { error: { code: 'DEADLINE_PASSED', correlationId: 'c-1' } } } },
    );
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply and share my profile' }));
    expect(await screen.findByText('The deadline for this opportunity has passed.')).toBeInTheDocument();
  });
});

describe('student applications', () => {
  const application = {
    id: '22222222-2222-4222-8222-222222222222',
    state: 'SHORTLISTED', opportunityId: opportunity.id, employerName: 'Aster Mobility',
    title: 'SOC Analyst Intern', employmentType: 'INTERNSHIP', workMode: 'ONSITE', locationCity: 'Bengaluru',
    submittedAt: '2026-08-10T00:00:00.000Z', closedAt: null, consentRevokedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z', termsAcknowledgementPending: false,
  };

  it('shows the stage each application has reached', async () => {
    stubFetch({ '/api/v1/students/me/applications': { applications: [application] }, '/api/v1/students/me/offers': { offers: [] } });
    await authenticate();
    render(<StudentApplicationsPage />);
    expect(await screen.findByText('Shortlisted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });

  it('tells the student that withdrawing ends employer access', async () => {
    stubFetch({
      '/api/v1/students/me/applications': { applications: [application] },
      '/api/v1/students/me/offers': { offers: [] },
      [`/api/v1/students/me/applications/${application.id}/withdraw`]: { ok: true },
    });
    await authenticate();
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText(/The employer no longer has access to your profile for this role/)).toBeInTheDocument();
  });

  it('offers accept and decline only while an offer is live', async () => {
    stubFetch({
      '/api/v1/students/me/applications': { applications: [] },
      '/api/v1/students/me/offers': { offers: [{
        id: '33333333-3333-4333-8333-333333333333', state: 'EXTENDED', applicationId: application.id,
        employerName: 'Aster Mobility', title: 'SOC Analyst Intern',
        compensation: { currency: 'INR', amount: '28000.00', period: 'MONTH' },
        joiningDate: null, offerExpiresAt: '2026-10-01T00:00:00.000Z', conditions: null, extendedAt: '2026-09-01T00:00:00.000Z',
      }] },
    });
    await authenticate();
    render(<StudentApplicationsPage />);
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.getByText(/INR 28,000 \/ month/)).toBeInTheDocument();
  });
});

describe('employer applicant pipeline', () => {
  const employerId = '44444444-4444-4444-8444-444444444444';
  const employerOpportunity = { id: opportunity.id, referenceCode: 'SOC-2026-01', lifecycleState: 'PUBLISHED',
    title: 'SOC Analyst Intern', employmentType: 'INTERNSHIP', workMode: 'ONSITE', locationCity: 'Bengaluru',
    applicationDeadline: null, publishedAt: '2026-08-01T00:00:00.000Z', applicationCount: 2, openApplicationCount: 1 };
  const employerApplicants = [
    { id: 'a-interview', state: 'INTERVIEW', consentRevoked: false, candidateName: 'Aanya Interview', candidateEmail: 'aanya@uat.example.test',
      institutionStudentId: null, submittedAt: '2026-08-10T00:00:00.000Z', closedAt: null, interviewCount: 1, offerState: null, updatedAt: '2026-08-10T00:00:00.000Z' },
    { id: 'a-offer', state: 'OFFER', consentRevoked: false, candidateName: 'Ojas Offer', candidateEmail: 'ojas@uat.example.test',
      institutionStudentId: null, submittedAt: '2026-08-11T00:00:00.000Z', closedAt: null, interviewCount: 2, offerState: 'EXTENDED', updatedAt: '2026-08-11T00:00:00.000Z' },
    { id: 'a-applied', state: 'APPLIED', consentRevoked: false, candidateName: 'Mira Applied', candidateEmail: 'mira@uat.example.test',
      institutionStudentId: null, submittedAt: '2026-08-12T00:00:00.000Z', closedAt: null, interviewCount: 0, offerState: null, updatedAt: '2026-08-12T00:00:00.000Z' },
  ];

  it('withholds the candidate once they withdraw, while keeping the row', async () => {
    stubFetch({
      [`/api/v1/employers/${employerId}/opportunities`]: { opportunities: [employerOpportunity] },
      [`/api/v1/employers/${employerId}/opportunities/${opportunity.id}/applications`]: { applications: [
        { id: 'a-1', state: 'APPLIED', consentRevoked: false, candidateName: 'Aanya Student', candidateEmail: 'aanya@uat.example.test',
          institutionStudentId: 'UAT-STU-001', submittedAt: '2026-08-10T00:00:00.000Z', closedAt: null, interviewCount: 0, offerState: null, updatedAt: '2026-08-10T00:00:00.000Z' },
        { id: 'a-2', state: 'WITHDRAWN', consentRevoked: true, candidateName: null, candidateEmail: null,
          institutionStudentId: null, submittedAt: '2026-08-09T00:00:00.000Z', closedAt: '2026-08-11T00:00:00.000Z', interviewCount: 0, offerState: null, updatedAt: '2026-08-11T00:00:00.000Z' },
      ] },
    });
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} />);
    expect(await screen.findByText('Aanya Student')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn — details no longer shared')).toBeInTheDocument();
  });

  it('says the details are no longer shared once the applicant-access grant ends, and offers no pipeline move', async () => {
    stubFetch({
      [`/api/v1/employers/${employerId}/opportunities`]: { opportunities: [employerOpportunity] },
      [`/api/v1/employers/${employerId}/opportunities/${opportunity.id}/applications`]: { applications: [
        { id: 'a-1', state: 'SHORTLISTED', consentRevoked: false, candidateAccess: false, candidateName: null, candidateEmail: null,
          institutionStudentId: null, submittedAt: '2026-08-10T00:00:00.000Z', closedAt: null, interviewCount: 0, offerState: null, updatedAt: '2026-08-10T00:00:00.000Z' },
      ] },
    });
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} />);
    expect(await screen.findByText('Details no longer shared')).toBeInTheDocument();
    expect(screen.queryByText('NA')).not.toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Interview' })).not.toBeInTheDocument();
  });

  it('offers only the next steps that are legal from the current stage', async () => {
    stubFetch({
      [`/api/v1/employers/${employerId}/opportunities`]: { opportunities: [employerOpportunity] },
      [`/api/v1/employers/${employerId}/opportunities/${opportunity.id}/applications`]: { applications: [
        { id: 'a-1', state: 'INTERVIEW', consentRevoked: false, candidateName: 'Aanya Student', candidateEmail: 'aanya@uat.example.test',
          institutionStudentId: null, submittedAt: '2026-08-10T00:00:00.000Z', closedAt: null, interviewCount: 1, offerState: null, updatedAt: '2026-08-10T00:00:00.000Z' },
      ] },
    });
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} />);
    expect(await screen.findByRole('button', { name: 'Offer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rejected' })).toBeInTheDocument();
    // Moving backwards is not offered at all, so the rule cannot be reached by clicking.
    expect(screen.queryByRole('button', { name: 'Screening' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shortlisted' })).not.toBeInTheDocument();
  });

  it('pre-applies the canonical interview application-state filter', async () => {
    stubFetch({
      [`/api/v1/employers/${employerId}/opportunities`]: { opportunities: [employerOpportunity] },
      [`/api/v1/employers/${employerId}/opportunities/${opportunity.id}/applications`]: { applications: employerApplicants },
    });
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} applicationStateFilter="INTERVIEW" />);
    expect(await screen.findByText('Aanya Interview')).toBeInTheDocument();
    expect(screen.getByText((_content, element) => element?.textContent === 'Application state filter: Interview')).toBeInTheDocument();
    expect(screen.queryByText('Ojas Offer')).not.toBeInTheDocument();
    expect(screen.queryByText('Mira Applied')).not.toBeInTheDocument();
  });

  it('pre-applies the canonical offer application-state filter', async () => {
    stubFetch({
      [`/api/v1/employers/${employerId}/opportunities`]: { opportunities: [employerOpportunity] },
      [`/api/v1/employers/${employerId}/opportunities/${opportunity.id}/applications`]: { applications: employerApplicants },
    });
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} applicationStateFilter="OFFER" />);
    expect(await screen.findByText('Ojas Offer')).toBeInTheDocument();
    expect(screen.getByText((_content, element) => element?.textContent === 'Application state filter: Offer')).toBeInTheDocument();
    expect(screen.queryByText('Aanya Interview')).not.toBeInTheDocument();
    expect(screen.queryByText('Mira Applied')).not.toBeInTheDocument();
  });
});

describe('EMP-04 the company behind every job', () => {
  const company = {
    displayName: 'Aster', industry: 'SOFTWARE_AND_IT_SERVICES', companySizeBand: '201-1000',
    about: 'We build fleet-telematics software.', websiteUrl: 'https://www.aster.example', careersPageUrl: 'https://careers.aster.example',
    city: 'Bengaluru', stateOrProvince: 'Karnataka', countryCode: 'IN',
  };

  it('shows the verified company profile on the job, list and detail', async () => {
    stubFetch({
      '/api/v1/opportunities': { opportunities: [{ ...opportunity, company }] },
      [`/api/v1/opportunities/${opportunity.id}`]: { ...detail, opportunity: { ...detail.opportunity, company } },
    });
    await authenticate();
    render(<StudentOpportunitiesPage />);
    expect(await screen.findByText(/Aster \(Software and IT services\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    const card = await screen.findByRole('region', { name: 'About the company' });
    expect(within(card).getByRole('heading', { name: 'About Aster' })).toBeInTheDocument();
    expect(within(card).getByText(/Registered as Aster Mobility · Software and IT services · 201-1000 employees · Bengaluru, Karnataka, IN/)).toBeInTheDocument();
    expect(within(card).getByText('We build fleet-telematics software.')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Careers page' })).toHaveAttribute('href', 'https://careers.aster.example');
  });

  it('says a description is missing instead of inventing one', async () => {
    const empty = { displayName: null, industry: null, companySizeBand: null, about: null, websiteUrl: null, careersPageUrl: null, city: null, stateOrProvince: null, countryCode: null };
    stubFetch({
      '/api/v1/opportunities': { opportunities: [{ ...opportunity, company: empty }] },
      [`/api/v1/opportunities/${opportunity.id}`]: { ...detail, opportunity: { ...detail.opportunity, company: empty } },
    });
    await authenticate();
    render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    const card = await screen.findByRole('region', { name: 'About the company' });
    expect(within(card).getByRole('heading', { name: 'About Aster Mobility' })).toBeInTheDocument();
    expect(within(card).getByText('The company has not added a description yet.')).toBeInTheDocument();
    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
  });
});

type ErrorStub = Readonly<Record<string, { readonly status: number; readonly body: unknown }>>;

describe('interview and offer management', () => {
  const employerId = '44444444-4444-4444-8444-444444444444';
  const base = `/api/v1/employers/${employerId}`;
  const interview = { id: 'interview-a', applicationId: 'application-a', applicationState: 'INTERVIEW', opportunityId: opportunity.id,
    title: opportunity.title, consentRevoked: false, candidateName: 'Test Candidate', candidateEmail: 'candidate@example.test', institutionStudentId: null,
    roundNumber: 2, mode: 'VIDEO', state: 'SCHEDULED', scheduledStart: '2099-10-01T09:30:00Z', scheduledEnd: '2099-10-01T10:15:00Z',
    closedAt: null, outcomeCount: 0 };
  const offer = { ...interview, id: 'offer-a', state: 'EXTENDED', joiningDate: null, offerExpiresAt: '2099-10-01T09:30:00Z', respondedAt: null,
    compensation: { currency: 'INR', amount: '99999', period: 'MONTH' } };

  it('uses scheduled order and redacts all candidate fields even if revoked data is populated', async () => {
    stubFetch({ [`${base}/interviews`]: { interviews: [interview, { ...interview, id: 'interview-b', scheduledStart: '2099-09-01T09:00:00Z', consentRevoked: true, candidateName: 'Hidden Name', candidateEmail: 'hidden@example.test', institutionStudentId: 'HIDDEN-STUDENT' }] } });
    await authenticate(); render(<EmployerInterviewsPage employerId={employerId} />);
    await screen.findByText('Test Candidate');
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]!).getByText('Withdrawn — details no longer shared')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Hidden Name|hidden@example.test|HIDDEN-STUDENT/);
    expect(within(rows[1]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[2]!).getByText('2')).toBeInTheDocument();
  });

  it('requires confirmation before cancelling, then posts the typed state body', async () => {
    stubFetch({ [`${base}/interviews`]: { interviews: [interview] }, [`${base}/interviews/${interview.id}/state`]: { interview: { id: interview.id, state: 'CANCELLED' } } });
    const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('confirm', confirm);
    await authenticate(); render(<EmployerInterviewsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel interview' }));
    expect(postsTo('/state')).toHaveLength(0);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel interview' }));
    await waitFor(() => expect(postsTo('/state')).toHaveLength(1));
    expect(JSON.parse(postsTo('/state')[0]![1]!.body as string)).toEqual({ toState: 'CANCELLED' });
  });

  it('records an outcome and reschedules with actual times', async () => {
    stubFetch({ [`${base}/interviews`]: { interviews: [{ ...interview, state: 'COMPLETED' }] }, [`${base}/interviews/${interview.id}/outcome`]: { ok: true } });
    await authenticate(); const view = render(<EmployerInterviewsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record outcome' }));
    fireEvent.change(screen.getByLabelText('Recommendation'), { target: { value: 'YES' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Strong technical explanation.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(postsTo('/outcome')).toHaveLength(1));
    expect(JSON.parse(postsTo('/outcome')[0]![1]!.body as string)).toMatchObject({ recommendation: 'YES', notes: 'Strong technical explanation.' });
    view.unmount();
    stubFetch({ [`${base}/interviews`]: { interviews: [interview] } });
    render(<EmployerInterviewsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }));
    fillSchedule();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(postsTo('/state')).toHaveLength(1));
    expect(JSON.parse(postsTo('/state')[0]![1]!.body as string)).toEqual({ toState: 'RESCHEDULED', ...expectedWindow() });
  });

  it('confirms offer withdrawal, preserves missing slots and withholds revoked identity', async () => {
    stubFetch({ [`${base}/offers`]: { offers: [offer, { ...offer, id: 'offer-b', consentRevoked: true, candidateName: 'Secret Candidate' }] } });
    const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('confirm', confirm);
    await authenticate(); render(<EmployerOffersPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw offer' }));
    expect(postsTo('/withdraw')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Secret Candidate|99999/);
    expect(screen.getAllByText('NA').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Awaiting response')).toHaveLength(2);
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Withdraw offer' }));
    await waitFor(() => expect(postsTo('/withdraw')).toHaveLength(1));
  });

  it('renders honest empty states and safe failures', async () => {
    stubFetch({ [`${base}/interviews`]: { interviews: [] } });
    await authenticate(); const view = render(<EmployerInterviewsPage employerId={employerId} />);
    expect(await screen.findByText('No interviews are scheduled.')).toBeInTheDocument(); view.unmount();
    stubFetch({}, { [`${base}/offers`]: { status: 500, body: { error: { code: 'UPSTREAM', message: 'sensitive stack trace' } } } });
    render(<EmployerOffersPage employerId={employerId} />);
    expect(await screen.findByText('Records could not be loaded. Please refresh.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('sensitive');
    expect(screen.queryByText('No offers have been sent. Nothing is scheduled.')).not.toBeInTheDocument();
  });

  it('sends the selected interview mode, location, date and duration', async () => {
    stubApplicant('INTERVIEW'); await authenticate(); render(<EmployerApplicantsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule interview' }));
    fillSchedule(); fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'ONSITE' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Office reception' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save interview' }));
    await waitFor(() => expect(postsTo('/interviews')).toHaveLength(1));
    expect(JSON.parse(postsTo('/interviews')[0]![1]!.body as string)).toEqual({ mode: 'ONSITE', locationDetail: 'Office reception', ...expectedWindow() });
  });

  it('collects offer terms through a form without prompts', async () => {
    stubApplicant('OFFER'); vi.stubGlobal('prompt', vi.fn()); await authenticate(); render(<EmployerApplicantsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send offer' }));
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'USD' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1200.50' } });
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'MONTH' } });
    fireEvent.change(screen.getByLabelText('Joining date (optional)'), { target: { value: '2099-11-01' } });
    fireEvent.change(screen.getByLabelText('Expiry (local time)'), { target: { value: '2099-10-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Conditions (optional)'), { target: { value: 'Subject to document verification.' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Send offer' }).at(-1)!);
    await waitFor(() => expect(postsTo('/offers')).toHaveLength(1));
    expect(JSON.parse(postsTo('/offers')[0]![1]!.body as string)).toEqual({ compensationCurrency: 'USD', compensationAmount: 1200.5, compensationPeriod: 'MONTH', joiningDate: '2099-11-01', offerExpiresAt: new Date('2099-10-01T12:00').toISOString(), conditions: 'Subject to document verification.' });
    expect(window.prompt).not.toHaveBeenCalled();
  });

  it('requires a conscious acknowledgement when scheduling grants participant access to the candidate', async () => {
    const participantId = crypto.randomUUID();
    stubFetch({ [`${base}/opportunities`]: { opportunities: [{ ...opportunity, lifecycleState: 'PUBLISHED', applicationCount: 1 }] },
      [`${base}/opportunities/${opportunity.id}/applications`]: { applications: [{ ...interview, id: 'application-a', state: 'INTERVIEW', offerState: null, interviewCount: 0 }] },
      [`${base}/interview-participant-options`]: { participants: [{ userId: participantId, label: 'participant@example.test' }] } });
    await authenticate(); render(<EmployerApplicantsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule interview' }));
    fillSchedule(); fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'PHONE' } });
    expect(screen.getByText(/Adding a participant lets that person see the candidate details/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'participant@example.test' }));
    const acknowledgement = screen.getByRole('checkbox', { name: /I understand that the selected participants/ });
    expect(acknowledgement).not.toBeChecked(); expect(acknowledgement).toBeRequired();
    const form = screen.getByRole('button', { name: 'Save interview' }).closest('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText('Confirm participant access before scheduling.')).toBeInTheDocument();
    expect(postsTo('/interviews')).toHaveLength(0);
    fireEvent.click(acknowledgement); fireEvent.submit(form);
    await waitFor(() => expect(postsTo('/interviews')).toHaveLength(1));
    expect(JSON.parse(postsTo('/interviews')[0]![1]!.body as string)).toMatchObject({ participantUserIds: [participantId], participantVisibilityAcknowledged: true, mode: 'PHONE', ...expectedWindow() });
    expect(document.body.textContent).not.toContain(participantId);
  });

  function stubApplicant(state: string): void {
    stubFetch({ [`${base}/opportunities`]: { opportunities: [{ ...opportunity, lifecycleState: 'PUBLISHED', applicationCount: 1 }] },
      [`${base}/opportunities/${opportunity.id}/applications`]: { applications: [{ ...interview, id: 'application-a', state, offerState: null, interviewCount: 0 }] } });
  }
  function fillSchedule(): void {
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-09-15' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '14:20' } });
    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '45' } });
  }
  function expectedWindow() {
    const start = new Date('2099-09-15T14:20');
    return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 45 * 60_000).toISOString() };
  }
});

describe('institution consent and reports', () => {
  it('keeps the interview screen usable with a safe error when the API list is malformed', async () => {
    stubFetch({ '/api/v1/employers/employer/interviews': {} });
    await authenticate(); render(<EmployerInterviewsPage employerId="employer" />);
    expect(await screen.findByText('Records could not be loaded. Please refresh.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Interviews' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Invalid hiring list response');
  });
  it('makes institution sharing optional and records the explicit choice', async () => {
    stubFetch({ '/api/v1/opportunities': { opportunities: [opportunity] }, [`/api/v1/opportunities/${opportunity.id}`]: detail,
      '/api/v1/students/me/applications': { application: { id: 'app', state: 'APPLIED' } } });
    await authenticate(); render(<StudentOpportunitiesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    const consent = await screen.findByRole('checkbox'); expect(consent).not.toBeChecked();
    fireEvent.click(consent); fireEvent.click(screen.getByRole('button', { name: 'Apply and share my profile' }));
    await waitFor(() => expect(postsTo('/applications')).toHaveLength(1));
    expect(JSON.parse(postsTo('/applications')[0]![1]!.body as string)).toMatchObject({ consentGranted: true, institutionVisibilityGranted: true });
  });
  it('lets students stop institution sharing on a closed application without withdrawing it', async () => {
    stubFetch({ '/api/v1/students/me/applications': { applications: [{ id: 'app', title: 'Role', employerName: 'Employer', state: 'HIRED', closedAt: '2026-09-01', institutionVisibilityGrantedAt: '2026-08-01', institutionVisibilityRevokedAt: null }] }, '/api/v1/students/me/offers': { offers: [] } });
    await authenticate(); render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop institution sharing' }));
    await waitFor(() => expect(postsTo('/institution-visibility/revoke')).toHaveLength(1));
    expect(postsTo('/withdraw')).toHaveLength(0);
    expect(await screen.findByText('Institution sharing stopped. Your application is unchanged.')).toBeInTheDocument();
  });
  it('keeps analytics widgets present with NA when data cannot be loaded', async () => {
    stubFetch({}, { '/api/v1/employers/employer/hiring-analytics': { status: 500, body: {} } });
    await authenticate(); render(<EmployerHiringAnalyticsPage employerId="employer" />);
    await screen.findByText('Hiring analytics could not be loaded.');
    expect(screen.getByRole('heading', { name: 'Applications by stage' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stage conversion' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Per-opportunity funnel' })).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThan(5);
  });
});

describe('student-declared external application UI', () => {
  const path = '/api/v1/students/me/external-applications';
  const external = { id: crypto.randomUUID(), companyName: 'External Test Company', roleTitle: 'External Test Role', sourceKind: 'REFERRAL', appliedOn: '2026-01-01', stage: 'HIRED',
    applicationUrl: null, source: 'STUDENT_DECLARED', verificationState: 'UNVERIFIED', revision: 4, institutionVisibilityGrantedAt: null, institutionVisibilityRevokedAt: null };

  it('keeps declarations separate from native counters and labels every terminal row and detail', async () => {
    const rows = ['APPLIED', 'SCREENING', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'].map((stage, index) => ({ ...external, id: index === 0 ? external.id : crypto.randomUUID(), stage }));
    stubFetch({ [path]: { externalApplications: rows, total: rows.length }, [`${path}/${external.id}`]: { externalApplication: external },
      '/api/v1/students/me/applications': { applications: [] }, '/api/v1/students/me/offers': { offers: [] } });
    await authenticate(); render(<StudentApplicationsPage />);
    const table = await screen.findByRole('table', { name: 'Student-declared external applications' });
    await waitFor(() => expect(within(table).getAllByText('Student-declared · Unverified')).toHaveLength(8));
    const stats = document.querySelector('.career-stat-strip')!;
    expect(stats.textContent).toMatch(/0.*Applications.*0.*In progress.*0.*At interview.*0.*At offer/);
    fireEvent.click(within(table).getAllByRole('button', { name: 'View external application' })[0]!);
    expect(await screen.findByText('Declared stage: Hired · Unverified')).toBeInTheDocument();
    expect(screen.getAllByText('Student-declared · Unverified')).toHaveLength(9);
    expect(screen.getByText('Application link: NA')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(external.id);
  });

  it('creates a declaration with optional consent off by default', async () => {
    stubFetch({ [path]: { externalApplications: [], total: 0 } });
    await authenticate(); render(<StudentExternalApplicationsPanel />);
    await screen.findByText('No external applications recorded.');
    fireEvent.click(screen.getByRole('button', { name: 'Record external application' }));
    const form = screen.getByRole('button', { name: 'Save external application' }).closest('form')!;
    expect(within(form).getByText('Student-declared · Unverified')).toBeInTheDocument();
    expect(within(form).getByRole('checkbox')).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: ' Test Company ' } });
    fireEvent.change(screen.getByLabelText('Role title'), { target: { value: ' Test Role ' } });
    fireEvent.change(screen.getByLabelText('Application source'), { target: { value: 'COMPANY_SITE' } });
    fireEvent.change(screen.getByLabelText('Date applied'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Declared stage'), { target: { value: 'HIRED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save external application' }));
    await waitFor(() => expect(postsTo('/external-applications')).toHaveLength(1));
    expect(JSON.parse(postsTo('/external-applications')[0]![1]!.body as string)).toEqual({ companyName: 'Test Company', roleTitle: 'Test Role', sourceKind: 'COMPANY_SITE', appliedOn: '2026-01-01', applicationUrl: null, stage: 'HIRED', institutionVisibilityGranted: false });
    expect(await screen.findByText('External application recorded as student-declared and unverified.')).toBeInTheDocument();
  });

  it('updates with the expected revision and handles stale writes without exposing upstream details', async () => {
    stubFetch({ [path]: { externalApplications: [external], total: 1 } }, { [`${path}/${external.id}`]: { status: 409, body: { error: { code: 'EXTERNAL_APPLICATION_STALE', message: 'SQL internal detail' } } } });
    await authenticate(); render(<StudentExternalApplicationsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit external application' }));
    fireEvent.change(screen.getByLabelText('Declared stage'), { target: { value: 'APPLIED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save external application' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ revision: 4, stage: 'APPLIED' });
    expect(JSON.parse(call[1]!.body as string)).not.toHaveProperty('institutionVisibilityGranted');
    expect((await screen.findAllByText('This record changed elsewhere. Refresh and reopen it before trying again.')).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('SQL internal detail');
  });

  it('requires permanent deletion confirmation and sends the revision', async () => {
    const routes: Record<string, unknown> = { [path]: { externalApplications: [external], total: 1 } };
    stubFetch(routes); await authenticate(); render(<StudentExternalApplicationsPanel />);
    vi.stubGlobal('confirm', vi.fn(() => false));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently' }));
    expect(fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'DELETE' }));
    vi.mocked(window.confirm).mockReturnValue(true);
    routes[path] = { externalApplications: [], total: 0 };
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByText('External application permanently deleted. It will no longer appear in later reports.')).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('This cannot be undone. If your institution previously saw it, it will disappear from later reports.'));
    const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'DELETE')!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ revision: 4 });
    expect(await screen.findByText('No external applications recorded.')).toBeInTheDocument();
    expect(screen.queryByText('External Test Role')).not.toBeInTheDocument();
  });

  it('keeps sharing revocable at the cap and excludes the private link from the notice', async () => {
    const shared = { ...external, institutionVisibilityGrantedAt: '2026-01-01T00:00:00Z' };
    stubFetch({ [path]: { externalApplications: [shared], total: 500 }, [`${path}/${external.id}`]: { externalApplication: shared } });
    await authenticate(); render(<StudentExternalApplicationsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'View external application' }));
    expect(screen.getByRole('button', { name: 'Record external application' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit external application' })).toBeEnabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing external application' }));
    await waitFor(() => expect(postsTo('/institution-visibility/revoke')).toHaveLength(1));
    expect(JSON.parse(postsTo('/institution-visibility/revoke')[0]![1]!.body as string)).toEqual({ revision: 4 });
  });

  it('pages through external records with bounded requests', async () => {
    stubFetch({ [path]: { externalApplications: [external], total: 51 } });
    await authenticate(); render(<StudentExternalApplicationsPanel />);
    await screen.findByText('Records: 51 of 500');
    fireEvent.click(screen.getByRole('button', { name: 'Next external applications' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('offset=50&limit=50'))).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous external applications' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Next external applications' })).toBeDisabled();
  });

  it('requires separate confirmation before granting institution visibility', async () => {
    stubFetch({ [path]: { externalApplications: [external], total: 1 }, [`${path}/${external.id}`]: { externalApplication: external } });
    await authenticate(); render(<StudentExternalApplicationsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'View external application' }));
    const share = await screen.findByRole('button', { name: 'Share external application with institution' });
    vi.stubGlobal('confirm', vi.fn(() => false));
    fireEvent.click(share); expect(postsTo('/institution-visibility/grant')).toHaveLength(0);
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(share);
    await waitFor(() => expect(postsTo('/institution-visibility/grant')).toHaveLength(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('The application link stays private.'));
    expect(JSON.parse(postsTo('/institution-visibility/grant')[0]![1]!.body as string)).toEqual({ revision: 4 });
  });
});

function postsTo(suffix: string): [string, RequestInit | undefined][] {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init?.method === 'POST') as [string, RequestInit | undefined][];
}

describe('candidate feedback', () => {
  const rejected = {
    id: '55555555-5555-4555-8555-555555555555',
    state: 'REJECTED', opportunityId: opportunity.id, employerName: 'Aster Mobility',
    title: 'SOC Analyst Intern', employmentType: 'INTERNSHIP', workMode: 'ONSITE', locationCity: 'Bengaluru',
    submittedAt: '2026-08-10T00:00:00.000Z', closedAt: '2026-08-20T00:00:00.000Z', consentRevokedAt: null,
    updatedAt: '2026-08-20T00:00:00.000Z', termsAcknowledgementPending: false, feedbackReleased: true,
  };
  const feedbackPath = `/api/v1/students/me/applications/${rejected.id}/feedback`;

  it('shows what the employer said and what to work on', async () => {
    stubFetch({
      '/api/v1/students/me/applications': { applications: [rejected] },
      '/api/v1/students/me/offers': { offers: [] },
      [feedbackPath]: { feedback: {
        id: 'f-1', employerName: 'Aster Mobility', title: 'SOC Analyst Intern',
        releasedAt: '2026-08-21T00:00:00.000Z', note: 'Strong attitude — keep going.',
        reasons: [{ code: 'CORE_SKILL_GAP', studentLabel: 'A core skill for this role was not yet demonstrated',
          category: 'SKILL_GAP', topics: [{ topicId: 't-1', name: 'SIEM fundamentals' }] }],
      } },
    });
    await authenticate();
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'See why' }));
    expect(await screen.findByText('A core skill for this role was not yet demonstrated')).toBeInTheDocument();
    expect(screen.getByText(/Worth working on: SIEM fundamentals/)).toBeInTheDocument();
    expect(screen.getByText(/Strong attitude/)).toBeInTheDocument();
  });

  it('tells the student the feedback is theirs alone and does not move their readiness', async () => {
    stubFetch({
      '/api/v1/students/me/applications': { applications: [rejected] },
      '/api/v1/students/me/offers': { offers: [] },
      [feedbackPath]: { feedback: { id: 'f-1', employerName: 'Aster Mobility', title: 'SOC Analyst Intern',
        releasedAt: '2026-08-21T00:00:00.000Z', note: null,
        reasons: [{ code: 'STRONGER_APPLICANTS', studentLabel: 'Other applicants were a closer match for this role', category: 'COMPETITION', topics: [] }] } },
    });
    await authenticate();
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'See why' }));
    expect(await screen.findByText(/not shown to your institution or to other employers/)).toBeInTheDocument();
    expect(screen.getByText(/does not affect your readiness/)).toBeInTheDocument();
  });

  it('offers no next step for a reason nothing the student studies would fix', async () => {
    stubFetch({
      '/api/v1/students/me/applications': { applications: [rejected] },
      '/api/v1/students/me/offers': { offers: [] },
      [feedbackPath]: { feedback: { id: 'f-1', employerName: 'Aster Mobility', title: 'SOC Analyst Intern',
        releasedAt: '2026-08-21T00:00:00.000Z', note: null,
        reasons: [{ code: 'STRONGER_APPLICANTS', studentLabel: 'Other applicants were a closer match for this role', category: 'COMPETITION', topics: [] }] } },
    });
    await authenticate();
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'See why' }));
    expect(await screen.findByText('Other applicants were a closer match for this role')).toBeInTheDocument();
    expect(screen.queryByText(/Worth working on/)).not.toBeInTheDocument();
  });

  it('keeps silence silent when the employer released nothing', async () => {
    stubFetch({
      '/api/v1/students/me/applications': { applications: [{ ...rejected, feedbackReleased: false }] },
      '/api/v1/students/me/offers': { offers: [] },
    });
    await authenticate();
    render(<StudentApplicationsPage />);
    expect(await screen.findByText('None shared')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'See why' })).not.toBeInTheDocument();
  });

  it('says so plainly when the employer replaced the feedback mid-read', async () => {
    stubFetch({
      '/api/v1/students/me/applications': { applications: [rejected] },
      '/api/v1/students/me/offers': { offers: [] },
      [feedbackPath]: { feedback: null },
    });
    await authenticate();
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'See why' }));
    expect(await screen.findByText('This feedback is no longer available.')).toBeInTheDocument();
  });

  it('lets an employer share feedback only once the candidate has been rejected', async () => {
    const employerId = '44444444-4444-4444-8444-444444444444';
    const base = `/api/v1/employers/${employerId}`;
    stubFetch({
      [`${base}/opportunities`]: { opportunities: [{ id: opportunity.id, referenceCode: 'SOC-2026-01', lifecycleState: 'PUBLISHED',
        title: 'SOC Analyst Intern', employmentType: 'INTERNSHIP', workMode: 'ONSITE', locationCity: 'Bengaluru',
        applicationDeadline: null, publishedAt: '2026-08-01T00:00:00.000Z', applicationCount: 2, openApplicationCount: 1 }] },
      [`${base}/opportunities/${opportunity.id}/applications`]: { applications: [
        { id: 'a-rejected', state: 'REJECTED', consentRevoked: false, candidateName: 'Rhea Rejected', candidateEmail: 'rhea@uat.example.test',
          institutionStudentId: null, submittedAt: '2026-08-10T00:00:00.000Z', closedAt: '2026-08-20T00:00:00.000Z', interviewCount: 1, offerState: null, updatedAt: '2026-08-20T00:00:00.000Z' },
        { id: 'a-applied', state: 'APPLIED', consentRevoked: false, candidateName: 'Mira Applied', candidateEmail: 'mira@uat.example.test',
          institutionStudentId: null, submittedAt: '2026-08-12T00:00:00.000Z', closedAt: null, interviewCount: 0, offerState: null, updatedAt: '2026-08-12T00:00:00.000Z' },
      ] },
      [`${base}/candidate-feedback-reasons`]: { reasons: [
        { code: 'CORE_SKILL_GAP', studentLabel: 'A core skill for this role was not yet demonstrated', category: 'SKILL_GAP' },
        { code: 'STRONGER_APPLICANTS', studentLabel: 'Other applicants were a closer match for this role', category: 'COMPETITION' },
      ] },
      [`${base}/applications/a-rejected/feedback`]: { feedback: { id: 'f-1' } },
    });
    await authenticate();
    render(<EmployerApplicantsPage employerId={employerId} />);
    // One button, on the rejected row only: a live candidate must not be sent a rejection reason.
    const share = await screen.findAllByRole('button', { name: 'Share feedback' });
    expect(share).toHaveLength(1);

    fireEvent.click(share[0]!);
    expect(await screen.findByText(/your internal notes stay private/)).toBeInTheDocument();
    fireEvent.click(await screen.findByLabelText(/A core skill for this role/));
    fireEvent.click(screen.getByRole('button', { name: 'Share with candidate' }));
    await waitFor(() => expect(screen.getByText('Feedback shared with the candidate.')).toBeInTheDocument());
  });
});

function stubFetch(routes: Readonly<Record<string, unknown>>, errors: ErrorStub = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const failure = errors[path];
    if (failure) return { ok: false, status: failure.status, json: async () => failure.body };
    const match = Object.keys(routes).find((route) => path === route);
    return { ok: true, status: 200, json: async () => (match ? routes[match] : {}) };
  }));
}

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}

describe('EMP-05 changed terms on a student application', () => {
  const applicationId = '44444444-4444-4444-8444-444444444444';
  const toVersionId = '55555555-5555-4555-8555-555555555555';
  const pendingApplication = {
    id: applicationId, state: 'APPLIED', opportunityId: opportunity.id, employerName: 'Aster Mobility',
    title: 'SOC Analyst Intern', employmentType: 'INTERNSHIP', workMode: 'ONSITE', locationCity: 'Bengaluru',
    submittedAt: '2026-08-10T00:00:00.000Z', closedAt: null, consentRevokedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z', termsAcknowledgementPending: true, feedbackReleased: false,
  };
  const terms = (min: string) => ({ title: 'SOC Analyst Intern', employmentType: 'INTERNSHIP', workMode: 'ONSITE', locationCity: 'Bengaluru',
    durationMonths: 6, compensation: { currency: 'INR', min, max: null, period: 'MONTH' }, joiningConditions: null, applicationDeadline: null, eligibility: [] });
  const routes = {
    '/api/v1/students/me/applications': { applications: [pendingApplication] },
    '/api/v1/students/me/offers': { offers: [] },
    [`/api/v1/students/me/applications/${applicationId}/terms-change`]: { termsChange: {
      toVersionId, employerName: 'Aster Mobility', changedTerms: ['compensationMin'], appliedTerms: terms('25000.00'), newTerms: terms('22000.00') } },
    [`/api/v1/students/me/applications/${applicationId}/terms-change/acknowledge`]: { application: { id: applicationId, state: 'APPLIED' } },
    [`/api/v1/students/me/applications/${applicationId}/terms-change/decline`]: { application: { id: applicationId, state: 'WITHDRAWN' } },
  };
  const posted = (suffix: string) => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init?.method === 'POST');

  it('shows what changed side by side and accepts the terms the student saw', async () => {
    stubFetch(routes);
    await authenticate();
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review new terms' }));
    const card = await screen.findByRole('region', { name: 'Changed terms' });
    expect(within(card).getByText('Aster Mobility changed this job')).toBeInTheDocument();
    const payRow = within(card).getByText('Pay').closest('tr')!;
    expect(within(payRow).getByText('Changed')).toBeInTheDocument();
    expect(within(payRow).getByText('INR 25,000 / month')).toBeInTheDocument();
    expect(within(payRow).getByText('INR 22,000 / month')).toBeInTheDocument();
    expect(within(card).getByText(/Declining withdraws your application/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Accept the new terms' }));
    expect(await screen.findByText('You accepted the new terms. Your application carries on.')).toBeInTheDocument();
    const [call] = posted('/terms-change/acknowledge');
    const init = call?.[1];
    expect(JSON.parse(String(init!.body))).toEqual({ toVersionId });
  });

  it('says declining withdraws the application, and reports a change made while reading', async () => {
    stubFetch(routes, { [`/api/v1/students/me/applications/${applicationId}/terms-change/decline`]: { status: 409, body: { error: { code: 'TERMS_CHANGED_AGAIN', correlationId: 'c-1' } } } });
    await authenticate();
    render(<StudentApplicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review new terms' }));
    fireEvent.click(within(await screen.findByRole('region', { name: 'Changed terms' })).getByRole('button', { name: 'Decline and withdraw' }));
    expect(await screen.findByText('The employer changed the job again while you were reading. Review the latest terms.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Changed terms' })).not.toBeInTheDocument();
  });
});
