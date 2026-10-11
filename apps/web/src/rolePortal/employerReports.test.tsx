/**
 * The employer Reports on the web (EMP-15). Reports shows the server's suppressed figures as
 * "<5" / "Withheld", never a candidate, and a plain error with a reference. Navigation labels are
 * unchanged (HG-3). The Dashboard's tests moved to employerHome.test.tsx with re-skin phase 7.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './employer.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));
vi.mock('../auth.js', async (original) => ({
  ...await original<typeof import('../auth.js')>(), getAccessToken: vi.fn(() => 'test-access-token'),
}));

const employerId = crypto.randomUUID();
const base = `/api/v1/employers/${employerId}`;
const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() });

const weekStart = new Date(Date.now() - 2 * 86_400_000);
const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);
const summary = {
  openJobs: 3, newApplicantsLast7Days: 4, interviewsThisWeek: 2, offersPending: 1, drivesAwaitingApproval: 2, drivesChangesRequested: 1,
  applicationsTotal: 41, openApplications: 30, hires: 6,
  currentStages: { APPLIED: 12, SCREENING: 7, SHORTLISTED: 5, ASSESSMENT: 2, INTERVIEW: 3, OFFER: 1, HIRED: 6, REJECTED: 4, WITHDRAWN: 1 },
  week: { startsAt: weekStart.toISOString(), endsAt: weekEnd.toISOString() }, timeZone: 'Asia/Kolkata',
};
function interview(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(), applicationId: crypto.randomUUID(), applicationState: 'INTERVIEW', opportunityId: crypto.randomUUID(), referenceCode: 'R-1',
    title: 'Graduate engineer', consentRevoked: false, candidateAccess: true, candidateName: 'Asha Synthetic', candidateEmail: null, institutionStudentId: null,
    roundNumber: 1, mode: 'VIDEO', state: 'SCHEDULED', scheduledStart: new Date(weekStart.getTime() + 86_400_000).toISOString(), scheduledEnd: null,
    locationDetail: null, joiningLink: null, ...overrides,
  };
}
const table = (cells: Record<string, number | null>, total: number | null) => ({
  suppressed: false, total: { suppressed: total === null, value: total },
  cells: ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'LEFT_AT_APPLIED', 'LEFT_AT_SCREENING', 'LEFT_AT_SHORTLISTED', 'LEFT_AT_ASSESSMENT', 'LEFT_AT_INTERVIEW', 'LEFT_AT_OFFER']
    .map((key) => ({ key, count: cells[key] ?? null, suppressed: (cells[key] ?? null) === null })),
});
const withheldGroup = { suppressed: true, total: { suppressed: true, value: null }, cells: [] };
const reports = {
  threshold: 5,
  overall: table({ APPLIED: 12, SCREENING: 7, SHORTLISTED: 5, HIRED: 6 }, 41),
  byJob: [{ opportunityId: crypto.randomUUID(), referenceCode: 'GE-1', title: 'Graduate engineer', lifecycleState: 'PUBLISHED', table: table({ APPLIED: 9 }, null) },
    { opportunityId: crypto.randomUUID(), referenceCode: 'DA-1', title: 'Data analyst', lifecycleState: 'CLOSED', table: withheldGroup }],
  byJobTruncated: false,
  byCollege: [{ collegeName: 'Alpha Institute', table: table({ APPLIED: 6 }, null) }, { collegeName: null, table: table({}, 8) }],
  byDrive: [{ driveId: crypto.randomUUID(), opportunityTitle: 'Graduate engineer', institutionName: 'Synthetic Drive College', state: 'SCHEDULED', table: withheldGroup }],
  byDriveTruncated: false,
  timeToStage: [
    { metric: 'SHORTLIST', applications: { suppressed: false, value: 10 }, medianDays: 2.5 },
    { metric: 'INTERVIEW', applications: { suppressed: true, value: null }, medianDays: null },
    { metric: 'OFFER', applications: { suppressed: false, value: 7 }, medianDays: 10 },
    { metric: 'HIRE', applications: { suppressed: false, value: 6 }, medianDays: 12 },
  ],
  offers: { table: { suppressed: false, total: { suppressed: true, value: null }, cells: [
    { key: 'EXTENDED', count: null, suppressed: true }, { key: 'ACCEPTED', count: 6, suppressed: false }, { key: 'DECLINED', count: null, suppressed: true },
    { key: 'EXPIRED', count: null, suppressed: true }, { key: 'WITHDRAWN', count: null, suppressed: true }] }, acceptanceRate: null },
};

function routes(options: { summaryStatus?: number; reportsStatus?: number } = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url, window.location.origin).pathname;
    if (path === `${base}/summary`) return options.summaryStatus ? ok({ error: { code: 'FORBIDDEN', correlationId: 'corr-summary' } }, options.summaryStatus) : ok({ summary });
    if (path === `${base}/reports`) return options.reportsStatus ? ok({ error: { code: 'FORBIDDEN', message: 'Access denied', correlationId: 'corr-reports-1' } }, options.reportsStatus) : ok({ reports });
    if (path === `${base}/interviews`) {
      return ok({ interviews: [
        interview({}),
        interview({ candidateAccess: false, candidateName: null, scheduledStart: new Date(weekStart.getTime() + 2 * 86_400_000).toISOString() }),
        interview({ state: 'CANCELLED', candidateName: 'Cancelled Person' }),
        interview({ candidateName: 'Next Week Person', scheduledStart: new Date(weekEnd.getTime() + 3_600_000).toISOString() }),
      ] });
    }
    if (path === `${base}/campus-drives`) return ok({ drives: [] });
    // Deliberately different numbers from the summary: the dashboard must not count these lists.
    if (path === `${base}/opportunities`) return ok({ opportunities: [{ id: 'job', title: 'Graduate engineer', referenceCode: 'GE-1', lifecycleState: 'PUBLISHED', applicationCount: 1, openApplicationCount: 1 }] });
    if (path === `${base}/opportunities/job/applications`) return ok({ applications: [{ id: 'a1', state: 'SHORTLISTED', candidateName: 'Bala Synthetic', consentRevoked: false, candidateAccess: true }] });
    throw new Error('Unexpected request ' + path);
  });
}

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: crypto.randomUUID(), memberships: [
    { organizationId: employerId, role: 'RECRUITER', scope: { organizationId: employerId, employerId } },
  ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('EMP-15 employer Reports', () => {
  const portal = rolePortals.find((item) => item.key === 'recruiter')!;

  it('keeps every navigation label as it was (HG-3)', () => {
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'Opportunities', 'Opportunity Detail', 'Applicants', 'Candidate Detail', 'Assessments', 'Interviews', 'Talent Pool', 'Offers', 'Reports', 'Team', 'Messages', 'Company Profile', 'Settings', 'Help & FAQ']);
  });

  it('shows the suppressed figures by job, college and drive as the server sent them, and no candidate', async () => {
    routes();
    render(<EmployerRecruiterRealityPage portal={portal} routeLabel="Reports" />);
    expect(await screen.findByRole('heading', { name: 'Hiring reports' })).toBeInTheDocument();
    const byJob = (await screen.findByRole('heading', { name: 'Funnel by job' })).closest('section') as HTMLElement;
    // The section heading renders before the figures arrive; wait for the row itself.
    const engineer = await within(byJob).findByRole('row', { name: /Graduate engineer/ });
    expect(within(engineer).getByText('9')).toBeInTheDocument();
    expect(within(engineer).getByText('Withheld')).toBeInTheDocument();
    // Every stage except Applied is <5 in every broken-down job, so those twelve columns fold into
    // one strip under the table: each stage is still named, and still reads <5.
    expect(within(engineer).queryAllByText('<5')).toHaveLength(0);
    const folded = within(within(byJob).getByRole('list', { name: 'Funnel by job: stages under 5 in every row' })).getAllByRole('listitem');
    expect(folded.map((slot) => slot.textContent)).toEqual(['Screening <5', 'Shortlisted <5', 'Assessment <5', 'Interview <5', 'Offer <5', 'Hired <5',
      'Left at applied <5', 'Left at screening <5', 'Left at shortlisted <5', 'Left at assessment <5', 'Left at interview <5', 'Left at offer <5']);
    expect(within(byJob).getByRole('columnheader', { name: 'Applied' })).toBeInTheDocument();
    expect(within(byJob).queryByRole('columnheader', { name: 'Hired' })).toBeNull();
    expect(within(within(byJob).getByRole('row', { name: /Data analyst/ })).getByText('Fewer than 5 applications — not broken down.')).toBeInTheDocument();

    const byCollege = screen.getByRole('heading', { name: 'Funnel by college' }).closest('section') as HTMLElement;
    expect(within(byCollege).getByRole('row', { name: /Alpha Institute/ })).toBeInTheDocument();
    expect(within(within(byCollege).getByRole('row', { name: /Other colleges or not stated/ })).getByText('8')).toBeInTheDocument();

    const byDrive = screen.getByRole('heading', { name: 'Funnel by campus drive' }).closest('section') as HTMLElement;
    expect(within(byDrive).getByRole('row', { name: /Synthetic Drive College/ })).toHaveTextContent('Scheduled');

    const timing = screen.getByRole('heading', { name: 'Time to each stage' }).closest('section') as HTMLElement;
    expect(within(within(timing).getByRole('row', { name: /Submission to shortlist/ })).getByText('2.5')).toBeInTheDocument();
    expect(within(within(timing).getByRole('row', { name: /Submission to interview/ })).getByText('Too few')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
    expect(screen.getByText('Too few answers')).toBeInTheDocument();
    expect(within(screen.getByText('Median days to first offer').closest('.v2-stat') as HTMLElement).getByText('10.0')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Synthetic(?! Drive College)|@|readiness/i);
  });

  it('says plainly when reports cannot be loaded, with a reference', async () => {
    routes({ reportsStatus: 403 });
    render(<EmployerRecruiterRealityPage portal={portal} routeLabel="Reports" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Support code: corrrepo');
    expect(alert.textContent).not.toMatch(/stack|Error:/);
    expect(screen.getByRole('heading', { name: 'Funnel by college' })).toBeInTheDocument();
  });
});
