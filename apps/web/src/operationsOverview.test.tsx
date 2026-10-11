/**
 * The Operations Overview (OPS-03, re-skin phase 7): it renders from one server-side summary and
 * makes no full-list fetches; a section the caller cannot access is left out and nothing reads
 * NA; counts of fewer than 5 people show <5 with no bar; capped counts read "+"; each block
 * opens its own screen; and loading, error and forbidden are honest.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from './api.js';
import { OperationsDashboardV2 } from './dashboardsV2.js';
import { rolePortals } from './rolePortalConfig.js';

vi.mock('./api.js', async (original) => ({
  ...await original<typeof import('./api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const basePath = '/operations/admin';
const count = (value: number, capped = false) => ({ value, capped });
const verification = (values: Partial<Record<string, number>> = {}) => Object.fromEntries(
  ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED'].map((state) => [state, count(values[state] ?? 0)]),
);

const fullOverview = {
  generatedAt: '2026-09-26T10:00:00.000Z',
  organizations: {
    total: count(12_000, false), active: count(11),
    institutions: { total: count(7), byVerification: verification({ PENDING: 2, VERIFIED: 5 }) },
    employers: { total: count(5), byVerification: verification({ UNDER_REVIEW: 1, VERIFIED: 4 }) },
    recent: [{ id: crypto.randomUUID(), kind: 'INSTITUTION', name: 'Riverside College', verificationState: 'PENDING', active: true }],
  },
  verification: { awaitingDecision: count(3), underReview: count(1) },
  employerAccessRequests: { pending: count(2), oldestPendingAt: '2026-09-20T10:00:00.000Z' },
  invitations: {
    staff: { total: count(10), accepted: count(6), pending: count(3), pendingOver72Hours: count(1), expiredUnaccepted: count(1) },
    expiringSoon: [{ id: crypto.randomUUID(), role: 'INSTITUTION_ADMIN', organizationName: 'Riverside College', expiresAt: '2026-10-02T10:00:00.000Z' }],
    recent: [{ id: crypto.randomUUID(), role: 'EMPLOYER_ADMIN', organizationName: 'Harbour Works', state: 'PENDING', createdAt: '2026-09-25T10:00:00.000Z' }],
    student: {
      pending: count(40), pendingOver72Hours: count(9), notDelivered: count(4),
      byDelivery: { NOT_SENT: count(0), SENT: count(36), FAILED: count(3), BOUNCED: count(1), NOT_CONFIGURED: count(0) },
    },
  },
  accounts: {
    total: { suppressed: false, value: 10_000, capped: true },
    students: { suppressed: true, value: null, capped: false },
    withOrganizationRoles: { suppressed: false, value: 25, capped: false },
  },
  trustSafety: { open: count(2), unassigned: count(1), bySeverity: { CRITICAL: count(1), HIGH: count(0), MEDIUM: count(1), LOW: count(0) } },
  jobs: { failedEvents: count(10_000, true), openAlerts: count(1) },
  privacyRequests: { open: count(3), openExports: count(1), openDeletions: count(2), deletionsDueWithin7Days: count(1), failed: count(0) },
  privacyHolds: { active: count(1) },
  approvals: { pending: count(2), awaitingExecution: count(1) },
  support: { open: count(5), overdue: count(2), unassigned: count(1) },
};

/** What a security admin receives: only trust, jobs and privacy. */
const securityOverview = {
  ...fullOverview,
  organizations: null, verification: null, employerAccessRequests: null, invitations: null, accounts: null, approvals: null, support: null,
};

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let overviewResponse: () => Promise<unknown>;

beforeEach(() => {
  overviewResponse = () => ok({ overview: fullOverview, viewer: { sections: [] }, correlationId: 'corr-overview' });
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string) => (String(url).includes('/operations/overview') ? overviewResponse() : ok({})));
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', basePath);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const kpi = (label: string): HTMLElement => screen.getByText(label, { selector: '.ih-kl' }).closest('.ih-kpi') as HTMLElement;
const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;
const noNa = (): void => {
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
};

describe('Operations Overview', () => {
  it('renders from one summary request and fetches no full lists', async () => {
    render(<OperationsDashboardV2 basePath={basePath} />);
    expect(await screen.findByText('Riverside College')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/api/v1/operations/overview');
    for (const list of ['/operations/organizations', '/operations/invitations', '/operations/users-access']) {
      expect(urls.some((url) => url.includes(list)), list).toBe(false);
    }
  });

  it('shows the server counts, capped counts with a plus, and people below 5 as <5', async () => {
    render(<OperationsDashboardV2 basePath={basePath} />);
    await screen.findByRole('heading', { name: 'Platform overview' });
    expect(within(kpi('Organizations')).getByText('12,000')).toBeInTheDocument();
    expect(within(kpi('Organizations')).getByText('7 colleges · 5 employers')).toBeInTheDocument();
    expect(within(kpi('People on ONE')).getByText('10,000+')).toBeInTheDocument();
    expect(within(kpi('To verify')).getByText('3')).toBeInTheDocument();
    expect(within(kpi('Open safety cases')).getByText('1 critical · 0 high')).toBeInTheDocument();
    expect(within(kpi('Open support cases')).getByText('2 past their SLA')).toBeInTheDocument();
    expect(within(card('System health')).getByText('10,000+')).toBeInTheDocument();
    expect(within(card('Invitations')).getByText('6 of 10 staff accepted')).toBeInTheDocument();
    // People: the students count is withheld by the server, so it reads <5 with the hatched block and no bar.
    const people = card('People on ONE');
    expect(within(people).getByText('<5')).toBeInTheDocument();
    expect(people.querySelector('.sc-hatch')).not.toBeNull();
    // A withheld part sits beside the others, so they read as ranges; the capped total stays as sent.
    expect(within(people).getByText('25–29')).toBeInTheDocument();
    expect(within(people).getByText('10,000+')).toBeInTheDocument();
    expect(people.querySelector('.bh-track')).toBeNull();
    noNa();
  });

  it('leaves out every block the caller cannot access, and prints no NA', async () => {
    overviewResponse = () => ok({ overview: securityOverview, viewer: { sections: ['trustSafety', 'jobs', 'privacyRequests', 'privacyHolds'] }, correlationId: 'corr-security' });
    render(<OperationsDashboardV2 basePath={basePath} />);
    await screen.findByRole('heading', { name: 'Platform overview' });
    for (const heading of ['Trust & safety', 'System health', 'Privacy', 'Protected boundaries']) {
      expect(screen.getByRole('heading', { name: heading }), heading).toBeInTheDocument();
    }
    for (const heading of ['Organizations', 'Invitations', 'People on ONE', 'Verification queue', 'Support']) {
      expect(screen.queryByRole('heading', { name: heading }), heading).toBeNull();
    }
    for (const label of ['Organizations', 'People on ONE', 'To verify']) expect(screen.queryByText(label, { selector: '.ih-kl' }), label).toBeNull();
    expect(screen.queryByRole('button', { name: /Add an organization/ })).toBeNull();
    noNa();
  });

  it('opens the matching screen from each block', async () => {
    const nav = rolePortals.find((portal) => portal.key === 'operations-admin')!.nav;
    const pathFor = (label: string) => nav.find((item) => item.label === label)!.path;
    render(<OperationsDashboardV2 basePath={basePath} />);
    await screen.findByRole('heading', { name: 'Platform overview' });
    const expected: [string, string, string][] = [
      ['Verification queue', 'Open Verification', 'Verification'], ['Verification queue', 'Open Organizations', 'Organizations'], ['Verification queue', 'Open Settings', 'Settings'],
      ['Trust & safety', 'Open cases', 'Trust and Safety'], ['System health', 'System Health', 'System Health'], ['Privacy', 'Security', 'Security'],
      ['Organizations', 'Organizations', 'Organizations'], ['Invitations', 'Users', 'Users'], ['Support', 'Support', 'Support'],
    ];
    for (const [title, button, label] of expected) {
      fireEvent.click(within(card(title)).getByRole('button', { name: new RegExp(`^${button}`) }));
      expect(window.location.pathname, `${title} → ${button}`).toBe(pathFor(label));
    }
  });

  it('says it is loading until the summary arrives', () => {
    overviewResponse = () => new Promise(() => undefined);
    render(<OperationsDashboardV2 basePath={basePath} />);
    expect(screen.getByText('Loading the operations workspace…')).toBeInTheDocument();
  });

  it('shows a plain error with its reference, and no numbers', async () => {
    overviewResponse = () => failure(500, 'OVERVIEW_UNAVAILABLE', 'corr-broken');
    render(<OperationsDashboardV2 basePath={basePath} />);
    expect(await screen.findByText('The overview could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrbrok')).toBeInTheDocument();
    expect(screen.queryByText('Operator queues')).toBeNull();
  });

  it('shows the forbidden state with its reference', async () => {
    overviewResponse = () => failure(403, 'FORBIDDEN', 'corr-denied');
    render(<OperationsDashboardV2 basePath={basePath} />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrdeni')).toBeInTheDocument();
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
