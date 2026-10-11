/**
 * Operations Security — access reviews (OPS-15): the screen renders the server's review,
 * shows an overdue review plainly, never offers a decision on the viewer's own access
 * (except the marked solo keep), requires a reason code for every write, and has honest
 * loading / missing-source / empty / error / forbidden states. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsAccessReviewsPage } from './accessReviews.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const campaignId = crypto.randomUUID();
const campaign = (over: Record<string, unknown> = {}) => ({
  id: campaignId, periodLabel: '2026-Q4', state: 'OPEN', openedBy: { email: 'security.lead@example.test' },
  openedAt: '2026-10-01T10:00:00.000Z', dueAt: '2026-10-31T10:00:00.000Z', openReasonCode: 'QUARTERLY_REVIEW', openNote: null,
  itemCount: 2, closedBy: null, closedAt: null, closeReasonCode: null,
  counts: { decided: 0, kept: 0, revoked: 0, solo: 0, highRisk: 1 }, ...over,
});
const item = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), position: 1, kind: 'CAPABILITY_GRANT', subject: { email: 'ops.person@example.test', isSelf: false },
  organizationName: 'ONE platform', organizationKind: 'PLATFORM', role: 'OPERATIONS_ADMIN', membershipState: 'ACTIVE',
  capability: 'INCIDENT_MANAGE', capabilities: ['INCIDENT_MANAGE'], highRisk: false, grantedBy: { email: 'founder@example.test' },
  grantedAt: '2026-09-01T10:00:00.000Z', grantReasonCode: 'NEW_RESPONSIBILITY', decision: null, decisionReasonCode: null,
  decisionNote: null, decidedBy: null, decidedAt: null, mode: null, revocationOutcome: null,
  canKeep: true, canRevoke: true, keepMode: 'DUAL', refusal: null, coolingOffEndsAt: null, ...over,
});
const policy = {
  reasons: {
    open: ['QUARTERLY_REVIEW', 'AD_HOC_REVIEW'],
    decision: { KEEP: ['STILL_REQUIRED', 'ROLE_REQUIRES_IT'], REVOKE: ['NO_LONGER_REQUIRED', 'LEAVER'] },
    close: ['REVIEW_COMPLETE'], export: ['AUDIT_EVIDENCE', 'INTERNAL_RECORD'],
  },
  soloCoolingOffMinutes: 15, campaignWindowDays: 30, cadenceMonths: 3,
};
const overview = (over: Record<string, unknown> = {}, campaigns: unknown[] = [campaign()]) => ({
  summary: { reviewerCount: 2, soloSafeguardActive: false, open: campaign(), lastClosed: null, status: 'IN_PROGRESS', overdue: true, nextDueAt: null, ...over },
  campaigns, nextCursor: null, policy, correlationId: 'corr-overview',
});

const fetchMock = vi.fn();
const ok = (body: unknown, headers: Record<string, string> = {}) => Promise.resolve({
  ok: true, status: 200, json: async () => body, text: async () => String(body), headers: new Headers(headers),
});
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let currentOverview: unknown;
let currentItems: unknown[];

beforeEach(() => {
  currentOverview = overview();
  currentItems = [
    item(),
    item({ position: 2, kind: 'PLATFORM_ROLE', subject: { email: 'me@example.test', isSelf: true }, role: 'SECURITY_ADMIN', capability: null,
      capabilities: ['SECURITY_ACCESS_REVIEW', 'INCIDENT_MANAGE'], grantedBy: null, grantReasonCode: null,
      canKeep: false, canRevoke: false, keepMode: null, refusal: 'ACCESS_REVIEW_OWN_ACCESS', highRisk: true }),
  ];
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST' && path.endsWith('/export')) return ok('"campaign_id"\r\n', { 'content-disposition': 'attachment; filename="one-access-review-2026-q4-2026-10-01.csv"' });
    if (init?.method === 'POST' && path.includes('/decision')) return ok({ item: { ...(currentItems[0] as object), decision: 'REVOKE', revocationOutcome: 'APPLIED', mode: 'DUAL' }, campaign: campaign(), correlationId: 'corr-post' });
    if (init?.method === 'POST') return ok({ campaign: campaign(), correlationId: 'corr-post' });
    if (path.includes('/items')) return ok({ campaign: campaign(), items: currentItems, nextCursor: null, correlationId: 'corr-items' });
    if (path.includes('/operations/access-reviews')) return ok(currentOverview);
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('Access reviews', () => {
  it('renders the open review from the server, with who granted each access and when', async () => {
    render(<OperationsAccessReviewsPage />);
    const row = (await screen.findByText('INCIDENT_MANAGE on OPERATIONS_ADMIN')).closest('tr')!;
    expect(within(row).getByText('ops.person@example.test')).toBeInTheDocument();
    expect(within(row).getByText(/By founder@example.test/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review 2026-Q4' })).toBeInTheDocument();
    expect(screen.getByText('Open review decided').previousSibling).toHaveTextContent('0 / 2');
    expect(row.textContent).not.toContain(campaignId);
  });

  it('hides a slot whose source is missing and says plainly that no review has been completed', async () => {
    render(<OperationsAccessReviewsPage />);
    await screen.findByText('INCIDENT_MANAGE on OPERATIONS_ADMIN');
    expect(screen.queryByText('Last completed review')).toBeNull();
    expect(screen.getByText('Next review due').previousSibling).toHaveTextContent('Now');
    expect(screen.getAllByRole('alert').some((node) => /No access review has been completed yet/.test(node.textContent ?? ''))).toBe(true);
    // A role with no invitation on record has no known grantor: the "By ..." clause is left out.
    const own = screen.getByText('Role SECURITY_ADMIN (2 capabilities)').closest('tr')!;
    expect(within(own).queryByText(/^By /)).toBeNull();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });

  it('shows an overdue quarterly review with its due date', async () => {
    currentOverview = overview({ open: null, status: 'REVIEW_OVERDUE', overdue: true, nextDueAt: '2026-09-01T00:00:00.000Z',
      lastClosed: campaign({ state: 'CLOSED', closedAt: '2026-06-01T00:00:00.000Z', closedBy: { email: 'security.lead@example.test' } }) }, []);
    render(<OperationsAccessReviewsPage />);
    expect(await screen.findByText(/The quarterly access review was due on .* and is overdue/)).toBeInTheDocument();
    expect(screen.getByText('Review status').previousSibling).toHaveTextContent('Overdue');
    expect(screen.getByRole('button', { name: 'Open access review…' })).toBeInTheDocument();
    expect(screen.getByText('No reviews yet')).toBeInTheDocument();
  });

  it('never offers a decision on the viewer\'s own access', async () => {
    render(<OperationsAccessReviewsPage />);
    const own = (await screen.findByText('Role SECURITY_ADMIN (2 capabilities)')).closest('tr')!;
    expect(within(own).queryByRole('button')).toBeNull();
    expect(within(own).getByText(/another reviewer decides this/)).toBeInTheDocument();
    expect(within(own).getByText('You')).toBeInTheDocument();
  });

  it('offers the only reviewer a solo keep on their own access, marked as such', async () => {
    currentOverview = overview({ reviewerCount: 1, soloSafeguardActive: true });
    currentItems = [item({ subject: { email: 'me@example.test', isSelf: true }, canRevoke: false, keepMode: 'SOLO', refusal: 'ACCESS_REVIEW_OWN_ACCESS' })];
    render(<OperationsAccessReviewsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep (solo)…' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/It will be marked SOLO/)).toBeInTheDocument();
    expect(screen.getByText(/Each such decision is marked SOLO/)).toBeInTheDocument();
  });

  it('requires a reason code before a revocation, says it is immediate, and sends it', async () => {
    render(<OperationsAccessReviewsPage />);
    const row = (await screen.findByText('INCIDENT_MANAGE on OPERATIONS_ADMIN')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke…' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke: ops.person@example.test' });
    expect(within(dialog).getByText(/The grant is revoked now/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Revoke now' });
    expect(confirm).toBeDisabled();
    const reasons = within(within(dialog).getByLabelText(/Reason code/)).getAllByRole('option').map((option) => option.textContent);
    expect(reasons).toEqual(['Choose a reason…', 'NO_LONGER_REQUIRED', 'LEAVER']);
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'LEAVER' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toMatch(new RegExp(`/api/v1/operations/access-reviews/${campaignId}/items/[0-9a-f-]+/decision$`));
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'REVOKE', reasonCode: 'LEAVER' });
    expect(await screen.findByText(/Revoked: INCIDENT_MANAGE on OPERATIONS_ADMIN/)).toBeInTheDocument();
  });

  it('keeps Close disabled until every item is decided', async () => {
    render(<OperationsAccessReviewsPage />);
    expect(await screen.findByRole('button', { name: 'Close review…' })).toBeDisabled();
    expect(screen.getByText('2 items still to decide before the review can close.')).toBeInTheDocument();
  });

  it('opens a review only with a reason code', async () => {
    currentOverview = overview({ open: null, status: 'NEVER_REVIEWED' }, []);
    render(<OperationsAccessReviewsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open access review…' }));
    const dialog = screen.getByRole('dialog', { name: 'Open an access review' });
    expect(within(dialog).getByRole('button', { name: 'Open review' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'QUARTERLY_REVIEW' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open review' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'QUARTERLY_REVIEW' });
  });

  it('exports CSV with a reason code', async () => {
    render(<OperationsAccessReviewsPage />);
    await screen.findByText('INCIDENT_MANAGE on OPERATIONS_ADMIN');
    fireEvent.click(screen.getAllByRole('button', { name: 'Export CSV…' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Export review 2026-Q4' });
    expect(within(dialog).getByText(/No student data/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'AUDIT_EVIDENCE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain(`/api/v1/operations/access-reviews/${campaignId}/export`);
    expect(JSON.parse(String(init.body))).toEqual({ reasonCode: 'AUDIT_EVIDENCE' });
    expect(await screen.findByText(/Exported one-access-review-2026-q4-2026-10-01.csv/)).toBeInTheDocument();
  });

  it('shows a loading state, then an empty review', async () => {
    currentItems = [];
    render(<OperationsAccessReviewsPage />);
    expect(screen.getByText('Loading access reviews…')).toBeInTheDocument();
    expect(await screen.findByText(/no standing internal access existed when it opened/)).toBeInTheDocument();
  });

  it('shows an error with its reference', async () => {
    fetchMock.mockImplementation(() => failure(500, 'INTERNAL', 'corr-broken'));
    render(<OperationsAccessReviewsPage />);
    expect(await screen.findByText(/Unable to load access reviews\. Support code: corrbrok/)).toBeInTheDocument();
  });

  it('shows a forbidden state to staff without the capability', async () => {
    fetchMock.mockImplementation(() => failure(403, 'FORBIDDEN', 'corr-denied'));
    render(<OperationsAccessReviewsPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrdeni')).toBeInTheDocument();
    // The only control on a forbidden page copies the support code; nothing acts on reviews.
    expect(screen.queryAllByRole('button').map((button) => button.textContent)).toEqual(['Copy support code']);
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((entry) => entry.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
