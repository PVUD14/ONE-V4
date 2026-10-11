/**
 * Operations Analytics — role demand (OPS-11): the dashboard renders the server's summary,
 * shows <5 and "Withheld" exactly where the server suppressed, says employer demand is not
 * recorded (never "NA"), gives suppressed roles no rank, drills into a role's colleges, and its
 * loading, empty, error and forbidden states are honest. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { formatPeople, OperationsRoleDemandPage } from './roleDemand.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const shown = (value: number) => ({ suppressed: false as const, value });
const suppressed = { suppressed: true as const, value: null };
const bigId = crypto.randomUUID();
const smallId = crypto.randomUUID();

const role = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), code: 'ROLE', catalogueCode: 'S01', title: 'Role', family: 'Software', catalogueFamily: 'A',
  releaseLabel: 'SELECTABLE', plannedRelease: 'V2', active: true, students: shown(10), colleges: 2,
  promotion: { status: 'NOT_MET', studentArmMet: false, employerArm: 'NOT_RECORDED' }, ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  demand: {
    generatedAt: '2026-09-26T10:00:00.000Z',
    totals: { studentsWithTarget: shown(411), roles: 3, catalogueRoles: 2, rolesMeetingPromotionRule: 1 },
    roles: [
      role({ id: bigId, catalogueCode: 'S01', title: 'Software Developer', students: shown(240), colleges: 4, promotion: { status: 'MEETS', studentArmMet: true, employerArm: 'NOT_RECORDED' } }),
      role({ catalogueCode: 'D01', title: 'Data Analyst', students: shown(8), colleges: 2 }),
      role({ id: smallId, catalogueCode: 'C01', title: 'SOC Analyst L1', students: suppressed, colleges: null, plannedRelease: 'V1' }),
      role({ catalogueCode: null, code: 'STARTER', title: 'Starter role', releaseLabel: null, plannedRelease: null, students: suppressed, colleges: null, promotion: { status: 'NOT_APPLICABLE', studentArmMet: null, employerArm: 'NOT_RECORDED' } }),
    ],
    rolesCapped: false,
    byReleaseLabel: [
      { releaseLabel: 'SELECTABLE', label: 'SELECTABLE', roles: 3, students: shown(411), complementary: false },
      { releaseLabel: 'NONE', label: 'NONE', roles: 1, students: suppressed, complementary: false },
    ],
    trend: [{ month: '2026-08', students: suppressed }, { month: '2026-09', students: shown(52) }],
    employerDemand: { available: false, reason: 'NO_ROLE_MAPPING' },
    ...over,
  },
  promotionRule: { minimumStudents: 200, minimumColleges: 3, employerArm: 'NOT_RECORDED' },
  correlationId: 'corr-summary',
});

const detail = {
  detail: {
    role: summary().demand.roles[0],
    colleges: [
      { label: 'Alpha Engineering College', students: shown(100), complementary: false, departmentsCapped: false,
        departments: [{ label: 'Computer Science', students: shown(90), complementary: false }, { label: 'Electrical', students: suppressed, complementary: true }, { label: 'Mechanical', students: suppressed, complementary: false }] },
      { label: 'Delta College', students: suppressed, complementary: false, departments: null, departmentsCapped: false },
    ],
    collegesCapped: false,
  },
  promotionRule: { minimumStudents: 200, minimumColleges: 3, employerArm: 'NOT_RECORDED' },
  correlationId: 'corr-detail',
};

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let summaryResponse: () => Promise<unknown> = () => ok(summary());
let detailResponse: () => Promise<unknown> = () => ok(detail);

beforeEach(() => {
  summaryResponse = () => ok(summary());
  detailResponse = () => ok(detail);
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string) => {
    const path = String(url);
    if (path.includes('/operations/analytics/role-demand/roles/')) return detailResponse();
    if (path.includes('/operations/analytics/role-demand')) return summaryResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('role demand dashboard', () => {
  it('renders the server summary, ranks only shown roles, and shows <5 where the server suppressed', async () => {
    render(<OperationsRoleDemandPage />);
    const table = await screen.findByRole('table', { name: 'Roles ranked by demand' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]!.textContent)).toEqual(['1', '2', '—', '—']);
    expect(within(rows[0]!).getByText('S01 · Software Developer')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('240')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Meets rule')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('<5')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Withheld')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Not applicable')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Not in catalogue')).toBeInTheDocument();
    expect(screen.getByText('411', { selector: 'b' })).toBeInTheDocument();
    expect(screen.getByText(/at least 200 students across at least 3 colleges/)).toBeInTheDocument();
    const trend = screen.getByRole('table', { name: 'Monthly trend' });
    expect(within(trend).getByRole('row', { name: /2026-08/ })).toHaveTextContent('<5');
    expect(within(trend).getByRole('row', { name: /2026-09/ })).toHaveTextContent('52');
  });

  it('says employer demand is not recorded, with no tile and no NA', async () => {
    render(<OperationsRoleDemandPage />);
    await screen.findByRole('table', { name: 'Roles ranked by demand' });
    expect(screen.queryByText('Employer demand (not recorded)')).toBeNull();
    expect(screen.getByText(/Employer demand is not recorded/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });

  it('filters by release label without refetching', async () => {
    render(<OperationsRoleDemandPage />);
    await screen.findByRole('table', { name: 'Roles ranked by demand' });
    fireEvent.change(screen.getByLabelText('Release label filter'), { target: { value: 'NONE' } });
    expect(within(screen.getByRole('table', { name: 'Roles ranked by demand' })).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('Starter role')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Release label filter'), { target: { value: 'VERIFIED' } });
    expect(screen.getByText('No roles carry this release label.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/role-demand'))).toHaveLength(1);
  });

  it('drills into a role: colleges and departments, with <5 and Withheld as sent', async () => {
    render(<OperationsRoleDemandPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Colleges for Software Developer' }));
    const section = await screen.findByRole('region', { name: 'Role demand by college' });
    expect(await within(section).findByText('Alpha Engineering College')).toBeInTheDocument();
    expect(within(section).getByText('Computer Science:')).toBeInTheDocument();
    expect(within(section).getByText('Electrical:').parentElement).toHaveTextContent('Electrical: Withheld');
    expect(within(section).getByText('Mechanical:').parentElement).toHaveTextContent('Mechanical: <5');
    expect(within(section).getByText('Not shown for a withheld count')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(`/role-demand/roles/${bigId}`);
  });

  it('says plainly when a role has too few students for a breakdown', async () => {
    detailResponse = () => ok({ ...detail, detail: { role: summary().demand.roles[2], colleges: null, collegesCapped: false } });
    render(<OperationsRoleDemandPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Colleges for SOC Analyst L1' }));
    expect(await screen.findByText('Fewer than 5 students')).toBeInTheDocument();
  });

  it('shows the empty state when no roles are loaded', async () => {
    summaryResponse = () => ok(summary({ roles: [], byReleaseLabel: [], totals: { studentsWithTarget: suppressed, roles: 0, catalogueRoles: 0, rolesMeetingPromotionRule: 0 } }));
    render(<OperationsRoleDemandPage />);
    expect(await screen.findByText('No career roles loaded')).toBeInTheDocument();
  });

  it('shows an error with its reference and no numbers', async () => {
    summaryResponse = () => failure(500, 'ROLE_DEMAND_UNAVAILABLE', 'corr-broken');
    render(<OperationsRoleDemandPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Support code: corrbrok');
    expect(screen.queryByText('Students with a career target')).toBeNull();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });

  it('shows the forbidden state with its reference', async () => {
    summaryResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    render(<OperationsRoleDemandPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrforb')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows loading, then asks for sign-in without a token', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    summaryResponse = () => new Promise((done) => { resolve = done; });
    render(<OperationsRoleDemandPage />);
    expect(screen.getByText('Loading role demand…')).toBeInTheDocument();
    resolve(await ok(summary()));
    cleanup();
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(<OperationsRoleDemandPage />);
    expect(screen.getByText('Sign-in required')).toBeInTheDocument();
  });

  it('formats counts exactly as the server suppressed them', () => {
    expect(formatPeople(undefined)).toBeUndefined();
    expect(formatPeople(suppressed)).toBe('<5');
    expect(formatPeople(shown(12), true)).toBe('Withheld');
    expect(formatPeople(shown(10_000))).toBe('10,000');
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
