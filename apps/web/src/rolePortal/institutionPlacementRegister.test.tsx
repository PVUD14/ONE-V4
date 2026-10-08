/**
 * Placement register and statistics on the web (INST-12): the admin's Placement page, the placement
 * officer's Dashboard, the department head's Placement Pipeline, the dashboard KPIs and Settings'
 * drive categories. Rendered through the real route dispatcher with the API stubbed at fetch.
 * Checks real data, <5 for withheld groups, "Not shared" never counted as unplaced, NA without a
 * source, a safe forbidden state, the category writes, no pay, and navigation labels unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { InstitutionDashboardV3 } from '../staffDashboardsV3.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const institutionId = crypto.randomUUID();
const base = `/api/v1/institutions/${institutionId}`;
const driveId = crypto.randomUUID();
const dreamId = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });

const shown = (value: number) => ({ suppressed: false, value });
const withheld = { suppressed: true, value: null };
const row = (overrides: Record<string, unknown> = {}) => ({
  eligible: shown(30), notShared: shown(6), applied: shown(24), shortlisted: shown(18), withOffer: shown(12), placed: shown(6),
  placementPercentage: 25, offersPerPlacedStudent: 1, ...overrides,
});
const statistics = {
  asOf: { month: '2026-08', lastDay: '2026-08-31' }, scope: { kind: 'INSTITUTION', units: [] },
  overall: row({ eligible: withheld, placed: withheld, placementPercentage: null, offersPerPlacedStudent: null }),
  groups: [
    { department: { id: 'd1', name: 'Computer Science' }, batch: { id: 'b1', name: 'CSE 2027' }, ...row() },
    { department: { id: 'd2', name: 'Mechanical' }, batch: null, ...row({ eligible: withheld, notShared: withheld, applied: withheld, shortlisted: withheld, withOffer: withheld, placed: withheld, placementPercentage: null, offersPerPlacedStudent: null }) },
  ],
  offersByMonth: [{ month: '2026-07', offers: withheld }, { month: '2026-08', offers: shown(12) }],
};
const register = {
  employers: [{ name: 'Synthetic Drive Employer', drives: { approved: 0, scheduled: 1, completed: 1 }, jobsAddressedToCollege: 2, lastEngagedAt: '2026-08-20T00:00:00.000Z' }],
  drives: [
    { id: driveId, employerName: 'Synthetic Drive Employer', opportunityTitle: 'Campus engineer', state: 'COMPLETED', scheduledStartAt: '2026-08-10T04:30:00.000Z', scheduledEndAt: null,
      proposedStartAt: null, venueMode: 'ON_CAMPUS', closedAt: '2026-08-12T00:00:00.000Z', category: { id: dreamId, name: 'Dream', retired: false },
      outcome: { studentsSharing: shown(15), withOffer: shown(10), placed: withheld } },
    { id: crypto.randomUUID(), employerName: 'Synthetic Drive Employer', opportunityTitle: 'Analyst', state: 'SCHEDULED', scheduledStartAt: '2026-10-10T04:30:00.000Z', scheduledEndAt: null,
      proposedStartAt: null, venueMode: null, closedAt: null, category: null, outcome: null },
  ],
};
const categories = [
  { id: dreamId, name: 'Dream', description: 'Top product companies', rank: 1, state: 'ACTIVE', createdAt: '2026-09-01T00:00:00.000Z', retiredAt: null, retireReasonCode: null },
  { id: crypto.randomUUID(), name: 'Mass', description: null, rank: 3, state: 'RETIRED', createdAt: '2026-09-01T00:00:00.000Z', retiredAt: '2026-09-02T00:00:00.000Z', retireReasonCode: 'RENAMED' },
];
const emptyTable = { suppressed: true, total: withheld, cells: [] };
const emptyPipeline = { scope: { kind: 'UNITS', units: [] }, unit: null, studentsSharing: withheld, stages: emptyTable, offers: emptyTable, placementStatus: emptyTable };
function drive(overrides: Record<string, unknown> = {}) {
  return {
    id: driveId, opportunityId: crypto.randomUUID(), opportunityTitle: 'Campus engineer', opportunityState: 'PUBLISHED', applicationDeadline: null,
    employerName: 'Synthetic Drive Employer', employerInGoodStanding: true, institutionName: 'Synthetic Institute', state: 'APPROVED', revision: 2,
    proposedStartAt: null, proposedEndAt: null, scheduledStartAt: null, scheduledEndAt: null, venueMode: null, employerNote: null, offerHoldersEligible: false,
    decision: null, closedAt: null, closeReasonCode: null, createdAt: null, updatedAt: null, availableActions: ['SCHEDULE', 'CANCEL', 'COMPLETE'], category: null, ...overrides,
  };
}

function routes(table: Readonly<Record<string, unknown>>): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    if (init?.method === 'POST') {
      if (path.endsWith('/category')) {
        const body = JSON.parse(String(init.body)) as { categoryId: string | null };
        return ok({ category: body.categoryId ? { id: body.categoryId, name: 'Dream', retired: false } : null }, 201);
      }
      if (path.endsWith('/drive-categories')) return ok({ category: { id: crypto.randomUUID() } }, 201);
      if (path.endsWith('/retire')) return ok({ category: { id: dreamId } }, 201);
      throw new Error('Unexpected POST ' + path);
    }
    const body = table[path];
    if (body === 'FORBIDDEN') return { ok: false, status: 403, headers: { get: () => 'corr-403' }, json: async () => ({ error: { code: 'FORBIDDEN', message: 'upstream private detail', correlationId: 'corr-403' } }) };
    return ok(body ?? {});
  });
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  .map(([url, init]) => ({ path: String(url).replace(/^https?:\/\/[^/]+/, ''), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

function open(key: 'institution-admin' | 'placement-officer' | 'department-head', label: string, role: string): void {
  const portal = rolePortals.find((item) => item.key === key)!;
  window.history.replaceState(null, '', portal.nav.find((item) => item.label === label)!.path);
  render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
    showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
    authenticatedWorkspace={{ organizationId: institutionId, role }} />);
}

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('admin Placement: statistics and register', () => {
  it('shows statistics by department and batch with <5 for small groups, the register, and never pay', async () => {
    routes({ [`${base}/placement-statistics`]: statistics, [`${base}/placement-register`]: register });
    open('institution-admin', 'Placement', 'INSTITUTION_ADMIN');
    const section = await screen.findByRole('region', { name: 'Placement statistics' });
    const table = await within(section).findByRole('table', { name: 'Placement statistics by department and batch' });
    const cse = within(table).getByRole('row', { name: /Computer Science/ });
    expect(cse).toHaveTextContent('CSE 2027');
    expect(cse).toHaveTextContent(/30\s*6\s*24\s*18\s*12\s*6\s*25%\s*1/);
    const mech = within(table).getByRole('row', { name: /Mechanical/ });
    expect(mech).toHaveTextContent('No batch');
    expect(within(mech).getAllByText('<5').length).toBeGreaterThanOrEqual(6);
    const all = within(table).getByRole('row', { name: /All students in your scope/ });
    expect(all).toHaveTextContent('<5');
    expect(within(section).getByText(/As of/)).toBeInTheDocument();
    expect(within(section).getByText(/never counted as unplaced/)).toBeInTheDocument();
    expect(within(section).getByLabelText('Offers made by month')).toHaveTextContent('<5');

    const registerSection = await screen.findByRole('region', { name: 'Placement register' });
    const employers = await within(registerSection).findByRole('table', { name: 'Employers engaged' });
    expect(within(employers).getByRole('row', { name: /Synthetic Drive Employer/ })).toHaveTextContent(/0\s*1\s*1\s*2/);
    const calendar = within(registerSection).getByRole('table', { name: 'Drive calendar' });
    const done = within(calendar).getByRole('row', { name: /Campus engineer/ });
    expect(within(done).getByText('Dream')).toBeInTheDocument();
    expect(done).toHaveTextContent(/15\s*10\s*<5/);
    expect(within(calendar).getByRole('row', { name: /Analyst/ })).toHaveTextContent('After the drive completes');
    expect(screen.queryByText(/season statistics: NA/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/salary|compensation|ctc|package|₹/i);
  });

  it('shows NA and a safe message with the reference when the statistics are forbidden', async () => {
    routes({ [`${base}/placement-statistics`]: 'FORBIDDEN', [`${base}/placement-register`]: 'FORBIDDEN' });
    open('institution-admin', 'Placement', 'INSTITUTION_ADMIN');
    const section = await screen.findByRole('region', { name: 'Placement statistics' });
    expect(await within(section).findByRole('alert')).toHaveTextContent('Reference: corr-403');
    expect(within(section).getAllByText('NA').length).toBe(5);
    expect(document.body.textContent).not.toContain('upstream private detail');
  });
});

describe('placement officer Dashboard and department head Placement Pipeline', () => {
  it('puts the register and statistics on the officer\'s Dashboard, with no navigation change (HG-3)', async () => {
    routes({ [`${base}/placement-statistics`]: statistics, [`${base}/placement-register`]: register, [`${base}/campus-drives`]: { drives: [], canDecide: true, nextCursor: null } });
    open('placement-officer', 'Dashboard', 'PLACEMENT_ADMIN');
    expect(await screen.findByRole('region', { name: 'Placement statistics' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Placement register' })).toBeInTheDocument();
    const labels = (key: string) => rolePortals.find((item) => item.key === key)!.nav.map((item) => item.label);
    expect(labels('placement-officer')).toEqual(['Dashboard', 'Assessments', 'Help & FAQ', 'Students', 'Student Search', 'Readiness', 'Departments', 'Batches']);
    expect(labels('institution-admin')).toEqual(['Dashboard', 'Students', 'Student Detail', 'Academic Structure', 'Assessments', 'Interventions',
      'Staff', 'Career Readiness', 'Placement', 'Reports', 'Settings', 'Help & FAQ']);
    expect(labels('department-head')).toEqual(['Dashboard', 'Department Overview', 'Students', 'Readiness', 'Assessments', 'Interventions',
      'Faculty and Staff', 'Placement Pipeline', 'Opportunities and Offers', 'Batches', 'Meetings', 'Reports and Analytics', 'Settings', 'Help & FAQ']);
  });

  it('shows the department head their department\'s statistics on Placement Pipeline', async () => {
    routes({ [`${base}/placement-statistics`]: { ...statistics, groups: [statistics.groups[0]] }, [`${base}/placement-pipeline`]: emptyPipeline });
    open('department-head', 'Placement Pipeline', 'DEPARTMENT_HEAD');
    const section = await screen.findByRole('region', { name: 'Placement statistics' });
    expect(await within(section).findByRole('row', { name: /Computer Science/ })).toBeInTheDocument();
    expect(screen.queryByText(/Placement drives are not built yet/)).not.toBeInTheDocument();
  });
});

describe('dashboard placement widgets', () => {
  it('fills Placement Eligible, the pipeline funnel and the offers trend from the statistics, <5 where withheld', async () => {
    routes({ [`${base}/placement-statistics`]: { ...statistics, overall: row({ placed: withheld }) } });
    render(<InstitutionDashboardV3 institutionId={institutionId} basePath="/institution/placement-officer" />);
    const eligible = (await screen.findByText('Placement Eligible')).parentElement!;
    expect(eligible).toHaveTextContent('30Placement Eligible');
    expect(screen.getByText('Students With Offers').parentElement).toHaveTextContent('12Students With Offers');
    expect(screen.getByText('Students Placed').parentElement).toHaveTextContent('<5Students Placed');
    const pipeline = screen.getByRole('heading', { name: 'Placement Pipeline' }).closest('section')!;
    expect(pipeline).toHaveTextContent(/Eligible\s*30/);
    expect(pipeline).toHaveTextContent(/Shortlisted\s*18/);
    expect(pipeline).toHaveTextContent(/Placed\s*<5/);
    expect(pipeline).toHaveTextContent('As of 2026-08-31');
    const trend = screen.getByRole('heading', { name: 'Offers Trend' }).closest('section')!;
    expect(trend).toHaveTextContent('2026-08 12');
  });

  it('draws no offers line and no pipeline bars when every figure is withheld, and names every slot as <5', async () => {
    const allWithheld = row({ eligible: withheld, notShared: withheld, applied: withheld, shortlisted: withheld, withOffer: withheld, placed: withheld, placementPercentage: null, offersPerPlacedStudent: null });
    routes({ [`${base}/placement-statistics`]: { ...statistics, overall: allWithheld,
      offersByMonth: ['2026-04', '2026-05', '2026-06'].map((month) => ({ month, offers: withheld })) } });
    render(<InstitutionDashboardV3 institutionId={institutionId} basePath="/institution/placement-officer" />);
    const trend = (await screen.findByRole('heading', { name: 'Offers Trend' })).closest('section')!;
    // A flat line at zero would be a false figure: the frame stays with its title and says why.
    expect(trend.querySelector('svg polyline')).toBeNull();
    expect(within(trend).getByText(/Not enough data yet/)).toBeInTheDocument();
    const months = within(within(trend).getByRole('list', { name: 'Offers by month' })).getAllByRole('listitem');
    expect(months.map((slot) => slot.textContent)).toEqual(['2026-04 <5', '2026-05 <5', '2026-06 <5']);
    const pipeline = screen.getByRole('heading', { name: 'Placement Pipeline' }).closest('section')!;
    expect(pipeline.querySelector('.pilot-bar')).toBeNull();
    expect(within(within(pipeline).getByRole('list', { name: 'Placement pipeline stages' })).getAllByRole('listitem').map((slot) => slot.textContent))
      .toEqual(['Eligible <5', 'Applied <5', 'Shortlisted <5', 'Offers <5', 'Placed <5']);
    expect(screen.getByText('Students Placed').parentElement).toHaveTextContent('<5Students Placed');
  });

  it('reads NA, not zero, when the statistics cannot be read (faculty)', async () => {
    routes({ [`${base}/placement-statistics`]: 'FORBIDDEN' });
    render(<InstitutionDashboardV3 institutionId={institutionId} basePath="/institution/faculty" />);
    expect((await screen.findByText('Placement Eligible')).parentElement).toHaveTextContent('NAPlacement Eligible');
    const pipeline = screen.getByRole('heading', { name: 'Placement Pipeline' }).closest('section')!;
    expect(pipeline).toHaveTextContent(/Placed\s*NA/);
  });
});

describe('drive categories', () => {
  it('lets an admin add and retire categories in Settings, with a reason', async () => {
    routes({ [`${base}/drive-categories`]: { categories, canManage: true } });
    open('institution-admin', 'Settings', 'INSTITUTION_ADMIN');
    const section = await screen.findByRole('region', { name: 'Drive categories' });
    expect(await within(section).findByText('Dream')).toBeInTheDocument();
    expect(within(section).getByText(/employers and students never do/)).toBeInTheDocument();
    const form = within(section).getByRole('form', { name: 'Add drive category' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Core' } });
    fireEvent.change(within(form).getByLabelText('Order in lists (1 first)'), { target: { value: '2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(posts().some((post) => post.path.endsWith('/drive-categories'))).toBe(true));
    expect(posts().find((post) => post.path.endsWith('/drive-categories'))!.body).toEqual({ name: 'Core', rank: 2 });
    fireEvent.click(within(section).getByRole('button', { name: 'Retire Dream' }));
    const retire = within(section).getByRole('form', { name: 'Retire drive category' });
    fireEvent.click(within(retire).getByRole('button', { name: 'Confirm: retire' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('Choose a reason.');
    fireEvent.change(within(retire).getByLabelText(/Reason for retiring/), { target: { value: 'RENAMED' } });
    fireEvent.click(within(retire).getByRole('button', { name: 'Confirm: retire' }));
    await waitFor(() => expect(posts().some((post) => post.path.endsWith(`/drive-categories/${dreamId}/retire`))).toBe(true));
    expect(posts().find((post) => post.path.endsWith('/retire'))!.body).toEqual({ reasonCode: 'RENAMED' });
  });

  it('says plainly when the reader cannot define categories', async () => {
    routes({ [`${base}/drive-categories`]: { categories: [], canManage: false } });
    open('institution-admin', 'Settings', 'INSTITUTION_ADMIN');
    const section = await screen.findByRole('region', { name: 'Drive categories' });
    expect(await within(section).findByText('No drive category is defined yet.')).toBeInTheDocument();
    expect(within(section).queryByRole('form', { name: 'Add drive category' })).not.toBeInTheDocument();
    expect(within(section).getByText(/needs a placement role for the whole college/)).toBeInTheDocument();
  });

  it('lets the placement officer label a drive from the approvals list', async () => {
    routes({ [`${base}/campus-drives`]: { drives: [drive()], canDecide: true, nextCursor: null }, [`${base}/drive-categories`]: { categories, canManage: true } });
    open('placement-officer', 'Dashboard', 'PLACEMENT_ADMIN');
    const approvals = await screen.findByRole('region', { name: 'Campus drive approvals' });
    const picker = await within(approvals).findByRole('combobox', { name: 'Drive category' });
    // Only active categories can be chosen.
    expect(within(picker).queryByRole('option', { name: 'Mass' })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: dreamId } });
    await waitFor(() => expect(posts().some((post) => post.path.endsWith(`/campus-drives/${driveId}/category`))).toBe(true));
    expect(posts().find((post) => post.path.endsWith('/category'))!.body).toEqual({ categoryId: dreamId });
    expect(await within(approvals).findByText('Category set to Dream.')).toBeInTheDocument();
  });

  it('shows the category as text, with no picker, to a reader who cannot decide drives', async () => {
    routes({ [`${base}/campus-drives`]: { drives: [drive({ category: { id: dreamId, name: 'Dream', retired: false } })], canDecide: false, nextCursor: null }, [`${base}/drive-categories`]: { categories, canManage: false } });
    open('placement-officer', 'Dashboard', 'PLACEMENT_ADMIN');
    const approvals = await screen.findByRole('region', { name: 'Campus drive approvals' });
    expect(await within(approvals).findByText('Dream')).toBeInTheDocument();
    expect(within(approvals).queryByRole('combobox', { name: 'Drive category' })).not.toBeInTheDocument();
  });
});
