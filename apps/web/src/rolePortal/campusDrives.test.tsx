/**
 * Campus drives on the web (EMP-11): the placement officer decides drive requests and sets the
 * one-offer policy from their Dashboard, and the employer requests and follows drives from
 * Opportunity Detail. Rendered through the real route dispatcher with the API stubbed at fetch.
 * Checks real data, the reason a refusal needs, the revision a decision names, the honest
 * states (none yet, cannot decide, load failure) and that no navigation label changed (HG-3).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './employer.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));
vi.mock('../auth.js', async (original) => ({
  ...await original<typeof import('../auth.js')>(), getAccessToken: vi.fn(() => 'test-access-token'),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const employerId = crypto.randomUUID();
const jobId = crypto.randomUUID();
const driveId = crypto.randomUUID();
const collegeId = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() });

function drive(overrides: Record<string, unknown> = {}) {
  return {
    id: driveId, opportunityId: jobId, opportunityTitle: 'Graduate engineer', opportunityState: 'PUBLISHED', applicationDeadline: '2027-01-30T00:00:00.000Z',
    employerName: 'Synthetic Drive Employer', employerInGoodStanding: true, institutionName: 'Synthetic Institute of Technology',
    state: 'REQUESTED', revision: 3, proposedStartAt: '2027-01-10T04:30:00.000Z', proposedEndAt: null, scheduledStartAt: null, scheduledEndAt: null,
    venueMode: 'ON_CAMPUS', employerNote: 'Two rounds on the day.', offerHoldersEligible: false, decision: null, closedAt: null, closeReasonCode: null,
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', availableActions: ['APPROVE', 'REQUEST_CHANGES', 'REJECT'],
    ...overrides,
  };
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ path: new URL(String(url), window.location.origin).pathname, body: JSON.parse(String(init!.body)) as Record<string, unknown> }));

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

function officerDashboard(role = 'PLACEMENT_ADMIN') {
  const portal = rolePortals.find((item) => item.key === 'placement-officer')!;
  window.history.replaceState(null, '', portal.nav.find((item) => item.label === 'Dashboard')!.path);
  return render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
    showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
    authenticatedWorkspace={{ organizationId: institutionId, role }} />);
}
function collegeRoutes(options: { canDecide?: boolean; drives?: unknown[]; policies?: unknown[] } = {}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url, window.location.origin).pathname;
    if (init?.method === 'POST') {
      if (path.endsWith('/approve')) return ok({ drive: drive({ state: 'SCHEDULED', revision: 4, availableActions: [] }) }, 201);
      if (path.endsWith('/reject')) return ok({ drive: drive({ state: 'REJECTED', revision: 4, availableActions: [] }) }, 201);
      if (path.endsWith('/placement-policies')) return ok({ policy: { id: crypto.randomUUID() } }, 201);
      throw new Error('Unexpected POST ' + path);
    }
    if (path === `/api/v1/institutions/${institutionId}/campus-drives`) {
      return ok({ drives: options.drives ?? [drive()], canDecide: options.canDecide ?? true, nextCursor: null });
    }
    if (path === `/api/v1/institutions/${institutionId}/placement-policies`) return ok({ policies: options.policies ?? [], canManage: options.canDecide ?? true });
    return ok({ students: [], assessments: [], units: [], actions: [] });
  });
}

describe('EMP-11 placement officer: drive approvals and the one-offer policy on the Dashboard', () => {
  it('keeps every navigation label as it was (no Drives item, HG-3)', () => {
    const labels = (key: string) => rolePortals.find((item) => item.key === key)!.nav.map((item) => item.label);
    expect(labels('placement-officer')).toEqual(['Dashboard', 'Assessments', 'Help & FAQ', 'Students', 'Student Search', 'Readiness', 'Departments', 'Batches']);
    expect(labels('recruiter')).toEqual(['Dashboard', 'Opportunities', 'Opportunity Detail', 'Applicants', 'Candidate Detail', 'Assessments', 'Interviews', 'Talent Pool', 'Offers', 'Reports', 'Team', 'Messages', 'Company Profile', 'Settings', 'Help & FAQ']);
  });

  it('lists the request as the server returned it and approves it naming the revision it read, with the confirmed date', async () => {
    collegeRoutes();
    officerDashboard();
    const section = await screen.findByRole('region', { name: 'Campus drive approvals' });
    const row = await within(section).findByRole('row', { name: /Synthetic Drive Employer/ });
    expect(row).toHaveTextContent('Graduate engineer');
    expect(row).toHaveTextContent('Awaiting the college');
    expect(row).toHaveTextContent('Two rounds on the day.');
    expect(within(section).getByText('1 request awaiting your decision.')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    const form = screen.getByRole('form', { name: 'Approve campus drive' });
    fireEvent.change(within(form).getByLabelText('Confirmed start (optional)'), { target: { value: '2027-01-12T10:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm: approve' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.path).toBe(`/api/v1/institutions/${institutionId}/campus-drives/${driveId}/approve`);
    expect(posts()[0]!.body).toMatchObject({ revision: 3, offerHoldersEligible: false });
    expect(posts()[0]!.body.scheduledStartAt).toBe(new Date('2027-01-12T10:00').toISOString());
    expect(await screen.findByText(/Graduate engineer: scheduled\./)).toBeInTheDocument();
  });

  it('will not decline without a reason, then sends the chosen one', async () => {
    collegeRoutes();
    officerDashboard();
    const row = await screen.findByRole('row', { name: /Synthetic Drive Employer/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Decline' }));
    const form = screen.getByRole('form', { name: 'Decline campus drive' });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm: decline' }));
    expect(await screen.findByText('Choose a reason.')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'SEASON_CLOSED' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm: decline' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ revision: 3, reasonCode: 'SEASON_CLOSED' });
  });

  it('sets one offer per student, and says plainly when nothing is in force', async () => {
    collegeRoutes({ drives: [] });
    officerDashboard();
    expect(await screen.findByText('No employer has asked for a campus drive yet.')).toBeInTheDocument();
    const policies = await screen.findByRole('region', { name: 'Placement policies' });
    expect(await within(policies).findByText(/No placement policy is in force/)).toBeInTheDocument();
    const form = within(policies).getByRole('form', { name: 'Set placement policy' });
    fireEvent.click(within(form).getByLabelText(/Allow exceptions/));
    fireEvent.click(within(form).getByRole('button', { name: 'Put this policy in force' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ path: `/api/v1/institutions/${institutionId}/placement-policies`, body: { policyType: 'ONE_OFFER_PER_STUDENT', allowDriveExceptions: true } });
  });

  it('shows a policy in force, and offers no decisions to someone who cannot make them', async () => {
    collegeRoutes({ canDecide: false, drives: [drive({ availableActions: [] })], policies: [{
      id: crypto.randomUUID(), policyType: 'ONE_OFFER_PER_STUDENT', allowDriveExceptions: false, effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null,
      state: 'ACTIVE', inForce: true, note: 'One offer per student this season.', retiredAt: null, retireReasonCode: null, createdAt: '2026-09-01T00:00:00.000Z',
    }] });
    officerDashboard();
    const section = await screen.findByRole('region', { name: 'Campus drive approvals' });
    expect(await within(section).findByText(/deciding them needs a placement role for the whole college/)).toBeInTheDocument();
    const row = within(section).getByRole('row', { name: /Synthetic Drive Employer/ });
    expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    const policies = screen.getByRole('region', { name: 'Placement policies' });
    expect(await within(policies).findByText(/One offer per student this season/)).toBeInTheDocument();
    expect(within(policies).queryByRole('button', { name: 'Retire this policy' })).not.toBeInTheDocument();
  });

  it('reports a failed load plainly with a reference, never an internal detail', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path.endsWith('/campus-drives')) return ok({ error: { code: 'FORBIDDEN', correlationId: 'corr-drives' } }, 403);
      if (path.endsWith('/placement-policies')) return ok({ policies: [], canManage: false });
      return ok({ students: [], assessments: [], units: [] });
    });
    officerDashboard();
    const section = await screen.findByRole('region', { name: 'Campus drive approvals' });
    expect(await within(section).findByRole('alert')).toHaveTextContent('Support code: corrdriv');
  });
});

describe('EMP-11 employer: campus drives on Opportunity Detail', () => {
  const base = `/api/v1/employers/${employerId}`;
  let drives: unknown[];
  beforeEach(() => {
    drives = [drive({ state: 'CHANGES_REQUESTED', decision: { reasonCode: 'SCHEDULE_CHANGE_NEEDED', note: 'Exams that week.', decidedAt: '2026-09-21T00:00:00.000Z' }, availableActions: ['RESUBMIT', 'CANCEL'], applicationCount: 0 })];
    vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: crypto.randomUUID(), memberships: [
      { organizationId: employerId, role: 'RECRUITER', scope: { organizationId: employerId, employerId } },
    ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url, window.location.origin).pathname;
      if (init?.method === 'POST') {
        if (path === `${base}/opportunities/${jobId}/campus-drives`) return ok({ drive: drive() }, 201);
        if (path === `${base}/campus-drives/${driveId}/cancel`) return ok({ drive: drive({ state: 'CANCELLED', availableActions: [] }) }, 201);
        throw new Error('Unexpected POST ' + path);
      }
      if (path === `${base}/opportunities`) return ok({ opportunities: [{ id: jobId, referenceCode: 'CD-01', lifecycleState: 'PUBLISHED', title: 'Graduate engineer', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai', applicationDeadline: null, publishedAt: '2026-09-01T00:00:00Z', closedAt: null, versionNumber: 1, applicationCount: 0, openApplicationCount: 0 }] });
      if (path === `${base}/opportunities/${jobId}`) return ok({
        opportunity: { id: jobId, referenceCode: 'CD-01', lifecycleState: 'PUBLISHED', publishedAt: '2026-09-01T00:00:00Z', closedAt: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
          canEdit: true, availableActions: [], reasonCodes: { PAUSE: [], CLOSE: [], REOPEN: [], WITHDRAW: [] }, audiences: [], applicationCount: 0, openApplicationCount: 0, awaitingAcknowledgementCount: 0, lastLifecycleChange: null },
        currentVersion: null, versions: [],
      });
      if (path === `${base}/campus-drives`) return ok({ drives });
      if (path === `${base}/campus-drive-institutions`) return ok({ institutions: [{ id: collegeId, name: 'Synthetic Institute of Technology', city: 'Chennai' }] });
      throw new Error('Unexpected endpoint ' + path);
    });
  });

  function detailPage() {
    const portal = rolePortals.find((item) => item.key === 'recruiter')!;
    return render(<EmployerRecruiterRealityPage portal={portal} routeLabel="Opportunity Detail" />);
  }

  it('shows the college\'s decision and reason, and says the job reaches nobody else through it', async () => {
    detailPage();
    const section = await screen.findByRole('region', { name: 'Campus drives' });
    const row = await within(section).findByRole('row', { name: /Synthetic Institute of Technology/ });
    expect(row).toHaveTextContent('Changes requested');
    expect(row).toHaveTextContent('Schedule change needed. Exams that week.');
    expect(within(row).getByRole('button', { name: 'Send changes' })).toBeInTheDocument();
    expect(screen.getByText(/students see it only through a campus drive a college has approved/)).toBeInTheDocument();
  });

  it('requests a drive at a verified college it found by name', async () => {
    drives = [];
    detailPage();
    const section = await screen.findByRole('region', { name: 'Campus drives' });
    expect(await within(section).findByText('No campus drives for this job yet.')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Request a campus drive' }));
    const form = within(section).getByRole('form', { name: 'Request a campus drive' });
    fireEvent.change(within(form).getByLabelText('Find a college'), { target: { value: 'Synthetic' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Search' }));
    expect(await within(form).findByRole('option', { name: 'Synthetic Institute of Technology · Chennai' })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Note to the placement office (optional)'), { target: { value: 'Two rounds.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ path: `${base}/opportunities/${jobId}/campus-drives`, body: { institutionId: collegeId, note: 'Two rounds.' } });
    expect(await screen.findByText(/students there see this job only once they approve/)).toBeInTheDocument();
  });

  it('cancels only with a listed reason', async () => {
    detailPage();
    const row = await screen.findByRole('row', { name: /Synthetic Institute of Technology/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel drive' }));
    const form = screen.getByRole('form', { name: 'Cancel campus drive' });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Choose a reason.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'POSITIONS_FILLED' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ revision: 3, reasonCode: 'POSITIONS_FILLED' });
  });
});
