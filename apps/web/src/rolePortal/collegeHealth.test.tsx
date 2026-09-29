/**
 * Operations college health (Analytics) and college account fields (Organization Detail),
 * OPS-14: the health table renders the server's figures with <5 and "Withheld" exactly
 * where the server suppressed, sorts by activity without ranking suppressed colleges by
 * size, opens a college's view with bands only and an NA movement slot; the account panel
 * shows masked contacts, needs a reason code for every change and reveal, and every screen
 * has honest loading, empty, error and forbidden states. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { formatCollegePeople, formatSplitTotal, OperationsCollegeAccountPanel, OperationsCollegeHealthPanel } from './collegeHealth.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const shown = (value: number) => ({ suppressed: false as const, value });
const suppressed = { suppressed: true as const, value: null };
const alphaId = crypto.randomUUID();
const betaId = crypto.randomUUID();
const gammaId = crypto.randomUUID();
const windows = { weekStart: '2026-09-21', weekEnd: '2026-09-27', month: '2026-08', monthStart: '2026-08-01', monthEnd: '2026-08-31' };

const row = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), name: 'College', verificationState: 'VERIFIED', active: true, renewalDate: null,
  students: { total: shown(20), yes: shown(12), no: shown(8) }, weeklyActiveLearners: shown(10),
  staff: { total: shown(10), yes: shown(6), no: shown(4) }, openSupportCases: 0, overdueSupportCases: 0, ...over,
});

const list = (over: Record<string, unknown> = {}) => ({
  health: {
    generatedAt: '2026-09-29T10:00:00.000Z',
    windows,
    colleges: [
      row({ id: alphaId, name: 'Alpha College', renewalDate: '2026-11-30', students: { total: suppressed, yes: shown(10), no: suppressed }, weeklyActiveLearners: shown(6), staff: { total: suppressed, yes: shown(5), no: suppressed }, openSupportCases: 2, overdueSupportCases: 1 }),
      row({ id: betaId, name: 'Beta College', students: { total: suppressed, yes: suppressed, no: suppressed }, weeklyActiveLearners: suppressed, staff: { total: suppressed, yes: suppressed, no: suppressed } }),
      row({ id: gammaId, name: 'Gamma College', weeklyActiveLearners: shown(40), verificationState: 'UNDER_REVIEW' }),
    ],
    collegesCapped: false,
    totals: { colleges: 3, renewingWithin90Days: 1, withoutRenewalDate: 2, openSupportCases: 2 },
    ...over,
  },
  correlationId: 'corr-list',
});

const detail = {
  detail: {
    generatedAt: '2026-09-29T10:00:00.000Z',
    windows,
    college: list().health.colleges[0],
    weeklyActiveTrend: [
      { weekStart: '2026-08-31', learners: suppressed }, { weekStart: '2026-09-07', learners: suppressed },
      { weekStart: '2026-09-14', learners: shown(9) }, { weekStart: '2026-09-21', learners: shown(6) },
    ],
    assessments: { attempts: shown(7), students: shown(6) },
    staffActionsOpened: shown(5),
    readinessBands: {
      suppressed: false, cohortSize: null, cohortSizeSuppressed: true,
      bands: [
        { band: 'NOT_ENOUGH_EVIDENCE', count: null, suppressed: true }, { band: 'DEVELOPING', count: 5, suppressed: false },
        { band: 'PROGRESSING', count: null, suppressed: true }, { band: 'READY_FOR_NEXT_STEP', count: null, suppressed: true },
      ],
    },
    readinessMovement: { available: false, reason: 'NOT_COMPUTED' },
  },
  correlationId: 'corr-detail',
};

const ownerId = crypto.randomUUID();
const contactId = crypto.randomUUID();
const policy = {
  contactRoles: ['PRINCIPAL', 'PLACEMENT_OFFICER', 'OTHER'],
  reasons: { update: ['NEW_CONTRACT', 'RENEWAL_AGREED', 'OWNER_HANDOVER', 'CORRECTION'], addContact: ['NEW_CONTACT'], removeContact: ['CONTACT_LEFT', 'PRIVACY_REQUEST'], reveal: ['RENEWAL_OUTREACH'] },
  owners: [{ membershipId: ownerId, email: 'owner@ai8ht.test', role: 'OPERATIONS_ADMIN' }],
  correlationId: 'corr-policy',
};
const account = (over: Record<string, unknown> = {}) => ({
  account: {
    institution: { id: alphaId, name: 'Alpha College', verificationState: 'VERIFIED', active: true },
    account: { renewalDate: '2026-11-30', contractReference: 'AI8HT-2026-014', accountOwner: { membershipId: ownerId, email: 'owner@ai8ht.test', role: 'OPERATIONS_ADMIN', active: true }, version: 2, updatedAt: '2026-09-29T09:00:00.000Z' },
    contacts: [{ id: contactId, role: 'PLACEMENT_OFFICER', name: 'Meera Iyer', email: 'm***@alpha.edu', phone: '***2345', addedAt: '2026-09-29T09:00:00.000Z' }],
    contactLimit: 10,
    ...over,
  },
  correlationId: 'corr-account',
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let listResponse: () => Promise<unknown> = () => ok(list());
let policyResponse: () => Promise<unknown> = () => ok(policy);
let accountResponse: () => Promise<unknown> = () => ok(account());

beforeEach(() => {
  listResponse = () => ok(list());
  policyResponse = () => ok(policy);
  accountResponse = () => ok(account());
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/operations/analytics/colleges/')) return ok(detail);
    if (path.includes('/operations/analytics/colleges')) return listResponse();
    if (path.includes('/operations/college-accounts/policy')) return policyResponse();
    if (path.includes('/reveal')) return ok({ contact: { email: 'meera.iyer@alpha.edu', phone: '+91 98450 12345' }, correlationId: 'corr-reveal' });
    if (path.includes('/operations/college-accounts/') && (init?.method ?? 'GET') === 'PATCH') {
      return ok(account({ account: { ...account().account.account, renewalDate: '2027-03-31', version: 3 } }));
    }
    if (path.includes('/operations/college-accounts/')) return accountResponse();
    if (path.includes('/operations/organizations')) return ok({ organizations: [{ id: alphaId, legalName: 'Alpha College Trust', profile: { displayName: 'Alpha College' } }] });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('college health on Analytics', () => {
  it('renders the server figures, with <5 and Withheld exactly where the server suppressed', async () => {
    render(<OperationsCollegeHealthPanel />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['Alpha College', 'Beta College', 'Gamma College']);
    const alpha = within(rows[0]!).getAllByRole('cell').map((cell) => cell.textContent);
    expect(alpha.slice(1, 8)).toEqual(['30 Nov 2026', 'Withheld', '10', '<5', '6', '5 of Withheld', '2 (1 overdue)']);
    const beta = within(rows[1]!).getAllByRole('cell').map((cell) => cell.textContent);
    expect(beta.slice(1, 7)).toEqual(['NA', '<5', '<5', '<5', '<5', '<5 of <5']);
    expect(screen.getByText('Renewing within 90 days').parentElement).toHaveTextContent('1');
    expect(screen.getByText(/last complete week/)).toBeInTheDocument();
  });

  it('sorts by activity with suppressed colleges last, without refetching', async () => {
    render(<OperationsCollegeHealthPanel />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Sort colleges'), { target: { value: 'activity' } });
    const names = within(screen.getByRole('table')).getAllByRole('rowheader').map((cell) => cell.textContent);
    expect(names).toEqual(['Gamma College', 'Alpha College', 'Beta College']);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/analytics/colleges'))).toHaveLength(1);
  });

  it('opens a college: trend, assessments, bands only, and NA for band movement', async () => {
    render(<OperationsCollegeHealthPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Health of Alpha College' }));
    const section = await screen.findByRole('region', { name: 'College health detail' });
    expect(await within(section).findByText('Alpha College: health')).toBeInTheDocument();
    const trend = within(section).getByLabelText('Weekly active learners');
    expect(trend).toHaveTextContent('<5');
    expect(trend).toHaveTextContent('6');
    expect(within(section).getByText('Developing').nextSibling).toHaveTextContent('5');
    expect(within(section).getByText('Progressing').nextSibling).toHaveTextContent('<5');
    expect(within(section).getByText('Students with an update').nextSibling).toHaveTextContent('Withheld');
    expect(within(section).getByText(/Readiness band movement: NA/)).toBeInTheDocument();
    expect(within(section).getByText(/7 attempts by 6 students/)).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/%|score/i);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(`/analytics/colleges/${alphaId}`);
  });

  it('shows the empty state when there are no colleges', async () => {
    listResponse = () => ok(list({ colleges: [], totals: { colleges: 0, renewingWithin90Days: 0, withoutRenewalDate: 0, openSupportCases: 0 } }));
    render(<OperationsCollegeHealthPanel />);
    expect(await screen.findByText('No colleges yet')).toBeInTheDocument();
  });

  it('shows an error with its reference and NA in every stat slot', async () => {
    listResponse = () => failure(500, 'COLLEGE_HEALTH_UNAVAILABLE', 'corr-broken');
    render(<OperationsCollegeHealthPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference: corr-broken');
    expect(screen.getByText('Colleges in ONE').parentElement).toHaveTextContent('NA');
    expect(screen.getByText('Open support cases').parentElement).toHaveTextContent('NA');
  });

  it('shows the forbidden state with its reference, and loading first', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    listResponse = () => new Promise((done) => { resolve = done; });
    render(<OperationsCollegeHealthPanel />);
    expect(screen.getByText('Loading college health…')).toBeInTheDocument();
    resolve(await failure(403, 'FORBIDDEN', 'corr-forbidden'));
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders nothing without a token (the page above asks for sign-in)', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    const { container } = render(<OperationsCollegeHealthPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('formats counts exactly as the server suppressed them', () => {
    expect(formatCollegePeople(undefined)).toBe('NA');
    expect(formatCollegePeople(suppressed)).toBe('<5');
    expect(formatCollegePeople(shown(1200))).toBe('1,200');
    expect(formatSplitTotal({ total: suppressed, yes: suppressed, no: suppressed })).toBe('<5');
    expect(formatSplitTotal({ total: suppressed, yes: shown(9), no: suppressed })).toBe('Withheld');
    expect(formatSplitTotal({ total: shown(15), yes: shown(8), no: shown(7) })).toBe('15');
  });
});

describe('college account fields on Organization Detail', () => {
  async function openAlpha(): Promise<HTMLElement> {
    render(<OperationsCollegeAccountPanel />);
    const select = await screen.findByLabelText('College');
    await within(select).findByText('Alpha College');
    fireEvent.change(select, { target: { value: alphaId } });
    await screen.findByText('Meera Iyer');
    return screen.getByRole('region', { name: 'College account' });
  }

  it('shows the fields and masked contacts only', async () => {
    const panel = await openAlpha();
    expect(panel).toHaveTextContent('AI8HT-2026-014');
    expect(panel).toHaveTextContent('30 Nov 2026');
    expect(panel).toHaveTextContent('owner@ai8ht.test (Operations admin)');
    expect(panel).toHaveTextContent('m***@alpha.edu');
    expect(panel).toHaveTextContent('***2345');
    expect(panel.textContent).not.toContain('meera.iyer@alpha.edu');
  });

  it('shows NA for a college with no account yet', async () => {
    accountResponse = () => ok(account({ account: null, contacts: [] }));
    render(<OperationsCollegeAccountPanel />);
    const select = await screen.findByLabelText('College');
    await within(select).findByText('Alpha College');
    fireEvent.change(select, { target: { value: alphaId } });
    expect(await screen.findByText('No contacts recorded for this college.')).toBeInTheDocument();
    expect(screen.getByText('Renewal date').nextSibling).toHaveTextContent('NA');
    expect(screen.getByText('Contract reference').nextSibling).toHaveTextContent('NA');
  });

  it('needs a reason code to save account fields and sends only what changed', async () => {
    await openAlpha();
    fireEvent.click(screen.getByRole('button', { name: 'Edit account fields…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Renewal date'), { target: { value: '2027-03-31' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'RENEWAL_AGREED' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Account fields saved.')).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ reasonCode: 'RENEWAL_AGREED', expectedVersion: 2, renewalDate: '2027-03-31' });
  });

  it('reveals a contact only with a reason and marks it as recorded', async () => {
    await openAlpha();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal contact for Meera Iyer' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('recorded in the audit log');
    expect(within(dialog).getByRole('button', { name: 'Reveal' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'RENEWAL_OUTREACH' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText(/meera\.iyer@alpha\.edu/)).toBeInTheDocument();
    expect(screen.getByText(/revealed, recorded/)).toBeInTheDocument();
    const reveal = fetchMock.mock.calls.find(([url]) => String(url).includes('/reveal'));
    expect(JSON.parse(String((reveal![1] as RequestInit).body))).toEqual({ reasonCode: 'RENEWAL_OUTREACH' });
  });

  it('shows the forbidden state with its reference', async () => {
    policyResponse = () => failure(403, 'FORBIDDEN', 'corr-no-account');
    render(<OperationsCollegeAccountPanel />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-no-account')).toBeInTheDocument();
  });

  it('shows an error with its reference when an account cannot load', async () => {
    accountResponse = () => failure(500, 'COLLEGE_ACCOUNT_REJECTED', 'corr-account-broken');
    render(<OperationsCollegeAccountPanel />);
    const select = await screen.findByLabelText('College');
    await within(select).findByText('Alpha College');
    fireEvent.change(select, { target: { value: alphaId } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference: corr-account-broken');
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
