/**
 * Placement-office nominations on the web (INST-14). The student reviews who nominated them, to
 * whom and exactly what would be shared before opting in (the opt-in carries the reviewed hash),
 * or declines; the college builds the eligible list, nominates only eligible students with a reason,
 * and sees "opted in" / "not opted in" — never a decline — with a suppressed summary; the employer
 * sees the application's source. API stubbed at fetch; real data, NA, empty and error states.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { StudentNominationsCard } from '../studentNominations.js';
import { EmployerApplicantsPage } from '../hiringPages.js';
import { DriveNominationsPanel } from './institutionNominations.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../auth.js', async (original) => ({
  ...await original<typeof import('../auth.js')>(), getAccessToken: vi.fn(() => 'test-access-token'),
}));

const institutionId = crypto.randomUUID();
const driveId = crypto.randomUUID();
const nominationId = crypto.randomUUID();
const opportunityId = crypto.randomUUID();
const employerId = crypto.randomUUID();
const hash = 'a'.repeat(64);
const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() });
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ path: new URL(String(url), window.location.origin).pathname, body: JSON.parse(String(init!.body)) as Record<string, unknown> }));

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function nomination(overrides: Record<string, unknown> = {}) {
  return {
    id: nominationId, state: 'INVITED', institutionName: 'Synthetic Placement College',
    nominatedBy: { role: 'PLACEMENT_ADMIN', label: 'Placement officer' }, reasonCode: 'MEETS_ELIGIBILITY', note: 'Strong fit for the analytics team.',
    nominatedAt: '2026-09-20T04:30:00.000Z', respondedAt: null,
    opportunity: { id: opportunityId, title: 'Graduate analyst', employerName: 'Synthetic Analytics Employer', applicationDeadline: null },
    drive: { state: 'APPROVED', scheduledStartAt: null, scheduledEndAt: null, venueMode: 'ON_CAMPUS' },
    applicationId: null, applicationState: null, alreadyApplied: false, canRespond: true, blocksYou: false,
    ...overrides,
  };
}
const snapshot = {
  schemaVersion: 1, candidate: { fullName: 'Asha Student', email: null, phone: null, contactVisibleFrom: 'SHORTLISTED' },
  education: null, qualifications: [], profile: { headline: null, summary: null }, links: [], resume: null,
};

describe('INST-14 student: nominations on Applications', () => {
  function studentRoutes(list: unknown[], failures: Record<string, number> = {}) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url, window.location.origin).pathname;
      if (failures[path]) return ok({ error: { code: 'FORBIDDEN', correlationId: 'corr-1' } }, failures[path]);
      if (path === '/api/v1/students/me/nominations') return ok({ nominations: list });
      if (path === '/api/v1/students/me/application-previews' && init?.method === 'POST') {
        return ok({ preview: { employerName: 'Synthetic Analytics Employer', snapshot, snapshotHash: hash, resumeOptions: [] } }, 201);
      }
      if (path.endsWith('/accept')) return ok({ application: { id: crypto.randomUUID(), state: 'APPLIED' }, nomination: { id: nominationId, state: 'ACCEPTED' } }, 201);
      if (path.endsWith('/decline')) return ok({ nomination: { id: nominationId, state: 'DECLINED' } }, 201);
      return ok({});
    });
  }

  it('shows who nominated the student, to whom and why, and opts in only with the reviewed snapshot', async () => {
    studentRoutes([nomination()]);
    const changed = vi.fn();
    render(<StudentNominationsCard onChanged={changed} />);
    expect(await screen.findByRole('heading', { name: 'Graduate analyst · Synthetic Analytics Employer' })).toBeInTheDocument();
    expect(screen.getByText(/Nominated by Placement officer, Synthetic Placement College/)).toBeInTheDocument();
    expect(screen.getByText(/You meet the role's eligibility rules · "Strong fit for the analytics team."/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing about you is shared with the employer unless you opt in/)).toBeInTheDocument();
    expect(screen.getByText(/Drive: NA · On campus · applications close NA/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review and decide' }));
    const panel = await screen.findByLabelText('Opt in to nomination');
    expect(await within(panel).findByLabelText('Shared profile')).toBeInTheDocument();
    expect(within(panel).getByText(/Your college sees that you opted in; it follows your application only if you also share it below/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Opt in and share my profile' }));
    await waitFor(() => expect(posts().some((call) => call.path.endsWith('/accept'))).toBe(true));
    const accepted = posts().find((call) => call.path.endsWith('/accept'))!;
    expect(accepted.path).toBe(`/api/v1/students/me/nominations/${nominationId}/accept`);
    expect(accepted.body).toEqual({ consentGranted: true, institutionVisibilityGranted: false, reviewedSnapshotHash: hash });
    expect(await screen.findByText(/You opted in/)).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
  });

  it('declines without reviewing, and says the employer is not told', async () => {
    studentRoutes([nomination()]);
    render(<StudentNominationsCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByText(/is not told, and your college sees only that you did not opt in/)).toBeInTheDocument();
    expect(posts()).toEqual([{ path: `/api/v1/students/me/nominations/${nominationId}/decline`, body: {} }]);
  });

  it('says plainly when a nomination is closed, withdrawn or blocked by the one-offer policy, and offers no answer', async () => {
    studentRoutes([
      nomination({ id: crypto.randomUUID(), state: 'CLOSED', canRespond: false }),
      nomination({ id: crypto.randomUUID(), state: 'CANCELLED', canRespond: false }),
      nomination({ id: crypto.randomUUID(), blocksYou: true }),
    ]);
    render(<StudentNominationsCard />);
    expect(await screen.findByText('Closed — the drive has ended')).toBeInTheDocument();
    expect(screen.getByText('Your college withdrew this nomination')).toBeInTheDocument();
    expect(screen.getByText(/one-offer policy stops you/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review and decide' })).not.toBeInTheDocument();
  });

  it('renders nothing when there are no nominations, and a plain error when they cannot be loaded', async () => {
    studentRoutes([]);
    const { container, unmount } = render(<StudentNominationsCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    unmount();
    studentRoutes([], { '/api/v1/students/me/nominations': 500 });
    render(<StudentNominationsCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your nominations could not be loaded.');
  });
});

describe('INST-14 college: nominations in a drive\'s details', () => {
  const suppressed = { suppressed: true, value: null };
  function collegeRoutes(options: { canNominate?: boolean; nominations?: unknown[]; summary?: unknown } = {}) {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url, window.location.origin).pathname;
      const base = `/api/v1/institutions/${institutionId}/campus-drives/${driveId}`;
      if (path === `${base}/nominations` && init?.method === 'POST') return ok({ created: [{ studentUserId: 's-1', nominationId: crypto.randomUUID() }], skipped: [{ studentUserId: 's-9', code: 'ALREADY_NOMINATED' }] }, 201);
      if (path === `${base}/nominations`) {
        return ok({
          drive: { id: driveId, state: 'APPROVED', live: true, opportunityTitle: 'Graduate analyst', employerName: 'Synthetic Analytics Employer' },
          canNominate: options.canNominate ?? true,
          summary: options.summary ?? { nominated: suppressed, optedIn: suppressed, notOptedIn: suppressed },
          nominations: options.nominations ?? [], nextCursor: null,
        });
      }
      if (path === `${base}/nomination-candidates`) {
        return ok({
          drive: { id: driveId, state: 'APPROVED', live: true, opportunityTitle: 'Graduate analyst', employerName: 'Synthetic Analytics Employer' },
          candidates: [
            { studentUserId: 's-1', fullName: 'Asha Eligible', institutionStudentId: 'R-1', department: 'Computer Science', batch: null, eligibility: 'ELIGIBLE', nomination: null },
            { studentUserId: 's-2', fullName: 'Bala Unknown', institutionStudentId: null, department: null, batch: null, eligibility: 'UNKNOWN', nomination: null },
          ],
          nextCursor: null,
        });
      }
      if (path.endsWith('/cancel')) return ok({ nomination: { id: 'n', response: 'CANCELLED' } }, 201);
      return ok({});
    });
  }

  it('shows each response as opted in or not, never a decline, with the summary suppressed under five', async () => {
    collegeRoutes({ nominations: [
      { id: 'n-1', revision: 1, studentName: 'Asha Opted', institutionStudentId: 'R-1', response: 'OPTED_IN', reasonCode: 'MEETS_ELIGIBILITY', nominatedByRole: 'PLACEMENT_ADMIN', nominatedAt: '2026-09-20T00:00:00.000Z', cancelReasonCode: null, canCancel: false },
      { id: 'n-2', revision: 1, studentName: 'Bala Quiet', institutionStudentId: null, response: 'NOT_OPTED_IN', reasonCode: 'MEETS_ELIGIBILITY', nominatedByRole: 'PLACEMENT_ADMIN', nominatedAt: '2026-09-20T00:00:00.000Z', cancelReasonCode: null, canCancel: true },
    ] });
    render(<DriveNominationsPanel institutionId={institutionId} driveId={driveId} />);
    const table = await screen.findByRole('table', { name: 'Nominated students' });
    expect(within(table).getByText('Opted in')).toBeInTheDocument();
    expect(within(table).getByText('Not opted in')).toBeInTheDocument();
    expect(within(table).getByText('NA')).toBeInTheDocument();
    expect(screen.getByText(/Nominated: <5 · Opted in: <5 · Not opted in: <5/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Declined|You declined/);

    fireEvent.click(within(table).getByRole('button', { name: 'Withdraw nomination' }));
    const form = screen.getByRole('form', { name: 'Withdraw nomination' });
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: 'NOMINATED_IN_ERROR' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm: withdraw' }));
    await waitFor(() => expect(posts()).toEqual([{ path: `/api/v1/institutions/${institutionId}/campus-drives/${driveId}/nominations/n-2/cancel`, body: { revision: 1, reasonCode: 'NOMINATED_IN_ERROR' } }]));
  });

  it('builds the eligible list and nominates only eligible students, with a reason', async () => {
    collegeRoutes();
    render(<DriveNominationsPanel institutionId={institutionId} driveId={driveId} />);
    expect(await screen.findByText('No student has been nominated for this drive.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Nominate students' }));
    const list = await screen.findByRole('table', { name: 'Eligible list' });
    expect(within(list).getByRole('checkbox', { name: 'Nominate Bala Unknown' })).toBeDisabled();
    expect(within(list).getByText('Cannot confirm yet')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Nominate Asha Eligible' }));
    const form = screen.getByRole('form', { name: 'Nominate students' });
    fireEvent.click(within(form).getByRole('button', { name: 'Nominate 1 student' }));
    expect(await screen.findByText('Choose a reason.')).toBeInTheDocument();
    fireEvent.change(within(form).getAllByRole('combobox')[0]!, { target: { value: 'PLACEMENT_OFFICE_SHORTLIST' } });
    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'Bring your ID card.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Nominate 1 student' }));
    await waitFor(() => expect(posts()).toEqual([{ path: `/api/v1/institutions/${institutionId}/campus-drives/${driveId}/nominations`,
      body: { studentUserIds: ['s-1'], reasonCode: 'PLACEMENT_OFFICE_SHORTLIST', note: 'Bring your ID card.' } }]));
    expect(await screen.findByText(/1 student nominated\. .* 1 skipped \(already nominated\)\./)).toBeInTheDocument();
  });

  it('offers no nominating to a reader who cannot decide, and shows a safe error with a reference', async () => {
    collegeRoutes({ canNominate: false });
    const { unmount } = render(<DriveNominationsPanel institutionId={institutionId} driveId={driveId} />);
    expect(await screen.findByText('Nominating needs a placement role for the whole college.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nominate students' })).not.toBeInTheDocument();
    unmount();
    fetchMock.mockImplementation(async () => ok({ error: { code: 'FORBIDDEN', correlationId: 'corr-42' } }, 403));
    render(<DriveNominationsPanel institutionId={institutionId} driveId={driveId} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference: corr-42');
  });
});

describe('INST-14 employer: the application\'s source', () => {
  it('labels an application made by opting in as nominated by the placement office', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path === `/api/v1/employers/${employerId}/opportunities`) {
        return ok({ opportunities: [{ id: opportunityId, referenceCode: 'NM-1', lifecycleState: 'PUBLISHED', title: 'Graduate analyst', employmentType: 'FULL_TIME',
          workMode: 'ONSITE', locationCity: 'Pune', applicationDeadline: null, publishedAt: '2026-09-01T00:00:00.000Z', applicationCount: 2, openApplicationCount: 2 }] });
      }
      if (path === `/api/v1/employers/${employerId}/opportunities/${opportunityId}/applications`) {
        const row = (id: string, name: string, source: string) => ({ id, state: 'APPLIED', consentRevoked: false, candidateAccess: true, candidateName: name, candidateEmail: null,
          institutionStudentId: null, submittedAt: '2026-09-21T00:00:00.000Z', closedAt: null, interviewCount: 0, offerState: null, source, updatedAt: '2026-09-21T00:00:00.000Z' });
        return ok({ applications: [row('a-1', 'Asha Nominated', 'PLACEMENT_OFFICE_NOMINATION'), row('a-2', 'Dev Direct', 'DIRECT')] });
      }
      return ok({});
    });
    render(<EmployerApplicantsPage employerId={employerId} />);
    expect(await screen.findByText('Asha Nominated')).toBeInTheDocument();
    expect(screen.getAllByText('Nominated by placement office')).toHaveLength(1);
    expect(screen.getByText('Dev Direct')).toBeInTheDocument();
  });
});
