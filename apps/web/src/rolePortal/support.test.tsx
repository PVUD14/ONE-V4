/**
 * Operations Support desk and account lookup (OPS-05): the queue renders the server's
 * cases and counts, a phone call is logged from one short form, moving a case needs a
 * reason code, the account view shows masked contacts until an audited reveal, and the
 * loading / empty / error / forbidden states are honest. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsAccountLookupPage, OperationsSupportDeskPage } from './support.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const caseId = crypto.randomUUID();
const userId = crypto.randomUUID();
const organizationId = crypto.randomUUID();

const policy = {
  viewer: { cases: true, accountLookup: true },
  channels: ['EMAIL', 'PHONE', 'WHATSAPP', 'IN_APP'],
  categories: ['ACCOUNT_ACCESS', 'INVITATION', 'OTHER'],
  severities: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
  slaHours: { LOW: 120, MEDIUM: 72, HIGH: 24, URGENT: 4 },
  transitions: { OPEN: ['IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'], IN_PROGRESS: ['WAITING_ON_CUSTOMER', 'RESOLVED'], WAITING_ON_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'], RESOLVED: ['IN_PROGRESS', 'CLOSED'], CLOSED: [] },
  reasons: {
    open: ['CUSTOMER_CONTACT', 'OPERATOR_FOLLOW_UP'],
    transition: { IN_PROGRESS: ['WORK_STARTED'], WAITING_ON_CUSTOMER: ['INFORMATION_REQUESTED'], RESOLVED: ['FIXED'], CLOSED: ['DUPLICATE'] },
    note: ['CASE_UPDATE'],
    assign: ['TAKE_OWNERSHIP'],
    reveal: ['ACCOUNT_RECOVERY', 'IDENTITY_VERIFICATION'],
  },
  assignees: [{ userId: crypto.randomUUID(), email: 'ops.lead@example.test', isSelf: true }],
  correlationId: 'corr-policy',
};

const supportCase = (over: Record<string, unknown> = {}) => ({
  id: caseId, reference: 'SC-1A2B3C4D', channel: 'PHONE', category: 'ACCOUNT_ACCESS', severity: 'HIGH', state: 'OPEN',
  summary: 'Cannot sign in after invitation', summaryRedacted: false,
  organization: { id: organizationId, name: 'Riverside College' },
  subject: { userId, maskedEmail: 'a***@college.edu' }, subjectDetached: false,
  assignee: null, openedBy: { email: 'ops.lead@example.test' },
  openedAt: '2026-09-25T10:00:00.000000Z', slaDueAt: '2026-09-26T10:00:00.000000Z', overdue: false, resolvedAt: null, closedAt: null,
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...supportCase(over),
  events: [{ id: crypto.randomUUID(), kind: 'OPENED', fromState: null, toState: 'OPEN', assignee: null, note: null, noteRedacted: false, linkedCorrelationId: null, reasonCode: 'CUSTOMER_CONTACT', actor: { email: 'ops.lead@example.test' }, correlationId: 'corr-open-1', occurredAt: '2026-09-25T10:00:00.000000Z' }],
  allowedTransitions: ['IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'],
});
const queue = (cases: unknown[]) => ({ cases, nextCursor: null, summary: { open: 3, inProgress: 2, waitingOnCustomer: 1, overdue: 1, unassigned: 2, mine: 0 }, correlationId: 'corr-queue' });
const account = {
  account: { userId, maskedEmail: 'a***@college.edu', maskedPhone: null, state: 'ACTIVE', identityLinked: true, deleted: false, createdAt: '2026-09-01T10:00:00.000000Z', membershipCount: 0 },
  memberships: [],
  studentRelationships: [{ institutionName: 'Riverside College', state: 'ACTIVE', effectiveFrom: '2026-06-01T00:00:00.000Z', effectiveTo: null }],
  invitations: [{ organizationName: 'Riverside College', role: null, kind: 'STUDENT', state: 'PENDING', deliveryState: 'NOT_CONFIGURED', createdAt: '2026-09-01T10:00:00.000Z', expiresAt: '2026-09-08T10:00:00.000Z' }],
  cases: [{ id: caseId, reference: 'SC-1A2B3C4D', state: 'OPEN', category: 'ACCOUNT_ACCESS', openedAt: '2026-09-25T10:00:00.000Z' }],
  timeline: [{ action: 'invitation.accepted', outcome: 'DENIED', resourceType: 'invitation', occurredAt: '2026-09-02T10:00:00.000Z', correlationId: 'corr-student-9', byThisUser: true }],
  canOpenCase: true, correlationId: 'corr-account',
};

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let casesResponse: () => Promise<unknown> = () => ok(queue([supportCase()]));

beforeEach(() => {
  casesResponse = () => ok(queue([supportCase()]));
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') {
      if (path.includes('/contact-reveal')) return ok({ contact: { email: 'asha.rao@college.edu', phone: null } });
      return ok({ case: detail({ state: 'IN_PROGRESS', reference: 'SC-9F9F9F9F' }), correlationId: 'corr-post' });
    }
    if (path.includes('/support/policy')) return ok(policy);
    if (path.includes('/support/cases/')) return ok({ case: detail(), correlationId: 'corr-detail' });
    if (path.includes('/support/cases')) return casesResponse();
    if (path.includes('/support/accounts/')) return ok(account);
    if (path.includes('/support/accounts')) return ok({ accounts: [account.account], nextCursor: null, correlationId: 'corr-search' });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('support desk', () => {
  it('renders the server queue and its counts', async () => {
    render(<OperationsSupportDeskPage />);
    expect(await screen.findByText('SC-1A2B3C4D')).toBeInTheDocument();
    expect(screen.getByText('Cannot sign in after invitation')).toBeInTheDocument();
    expect(screen.getByText('a***@college.edu')).toBeInTheDocument();
    expect(screen.getByText('Past SLA target').previousSibling?.textContent).toBe('1');
    expect(screen.getByText('Waiting on customer', { selector: 'small' }).previousSibling?.textContent).toBe('1');
  });

  it('shows NA in the counts while nothing has loaded, then the loading state', async () => {
    casesResponse = () => new Promise(() => undefined);
    render(<OperationsSupportDeskPage />);
    expect(screen.getByText('Loading cases…')).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(4);
  });

  it('says so plainly when the view is empty', async () => {
    casesResponse = () => ok(queue([]));
    render(<OperationsSupportDeskPage />);
    expect(await screen.findByText('No cases here')).toBeInTheDocument();
  });

  it('shows an error with its reference', async () => {
    casesResponse = () => failure(500, 'INTERNAL', 'corr-broken-1');
    render(<OperationsSupportDeskPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Support code: corrbrok');
  });

  it('shows a forbidden state, not an empty queue, to staff without Support Cases', async () => {
    casesResponse = () => failure(403, 'FORBIDDEN', 'corr-denied-1');
    render(<OperationsSupportDeskPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrdeni')).toBeInTheDocument();
    expect(screen.queryByText('No cases here')).not.toBeInTheDocument();
  });

  it('logs a phone call from one short form', async () => {
    render(<OperationsSupportDeskPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New case' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log a support case' });
    const submit = within(dialog).getByRole('button', { name: 'Log case' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Category/), { target: { value: 'ACCOUNT_ACCESS' } });
    fireEvent.change(within(dialog).getByLabelText(/Summary/), { target: { value: 'Invitation link expired' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/operations\/support\/cases$/);
    expect(JSON.parse(String(init.body))).toEqual({
      channel: 'PHONE', category: 'ACCOUNT_ACCESS', severity: 'MEDIUM', summary: 'Invitation link expired', reasonCode: 'CUSTOMER_CONTACT', assignToMe: true,
    });
    expect(await screen.findByText('Case SC-9F9F9F9F logged.')).toBeInTheDocument();
  });

  it('needs a reason code before a case can move', async () => {
    render(<OperationsSupportDeskPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open SC-1A2B3C4D' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Move to In Progress…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move SC-1A2B3C4D to In Progress' });
    const submit = within(dialog).getByRole('button', { name: 'Move to In Progress' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'WORK_STARTED' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain(`/support/cases/${caseId}/transition`);
    expect(JSON.parse(String(init.body))).toEqual({ toState: 'IN_PROGRESS', reasonCode: 'WORK_STARTED' });
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});

describe('account lookup', () => {
  const search = async (): Promise<void> => {
    render(<OperationsAccountLookupPage />);
    fireEvent.change(screen.getByLabelText(/Email address, part of one/), { target: { value: 'asha.rao@college.edu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  };

  it('shows the account with its contact masked and NA for the missing phone', async () => {
    await search();
    const summary = await screen.findByRole('region', { name: 'Account summary' });
    expect(within(summary).getByText('a***@college.edu')).toBeInTheDocument();
    expect(within(summary).getByText('NA')).toBeInTheDocument();
    expect(screen.queryByText('asha.rao@college.edu')).not.toBeInTheDocument();
    expect(screen.getByText('invitation.accepted')).toBeInTheDocument();
    expect(screen.getByText(/SC-1A2B3C4D/)).toBeInTheDocument();
  });

  it('reveals the full contact only after a reason code is chosen', async () => {
    await search();
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal contact…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reveal full contact' });
    const submit = within(dialog).getByRole('button', { name: 'Reveal' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'IDENTITY_VERIFICATION' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'IDENTITY_VERIFICATION' });
    expect(await screen.findByText('asha.rao@college.edu (revealed, recorded)')).toBeInTheDocument();
  });

  it('opens a case for the person from the account view', async () => {
    await search();
    fireEvent.click(await screen.findByRole('button', { name: 'Open case' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log a support case' });
    fireEvent.change(within(dialog).getByLabelText(/Category/), { target: { value: 'INVITATION' } });
    fireEvent.change(within(dialog).getByLabelText(/Summary/), { target: { value: 'Invitation not received' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Log case' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toMatchObject({ subjectUserId: userId, category: 'INVITATION' });
  });

  it('shows a forbidden state with its reference', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/support/policy')) return ok(policy);
      return failure(403, 'FORBIDDEN', 'corr-denied-2');
    });
    await search();
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrdeni')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/support/policy')) return ok(policy);
      return ok({ accounts: [], nextCursor: null, correlationId: 'corr-none' });
    });
    await search();
    expect(await screen.findByText('No matching account')).toBeInTheDocument();
  });
});
