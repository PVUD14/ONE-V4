/**
 * Operations Settings — Approvals (OPS-02): the queue renders the server's requests,
 * decisions and executions need a reason code or the stored payload, the high-risk
 * buttons on Organizations and Feature Flags file a request instead of acting, and the
 * loading / empty / error / forbidden states are honest.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsApprovalsPanel } from './approvals.js';
import { OperationsFeatureFlagsPage, OperationsOrganizationsPage } from './operations.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const organizationId = crypto.randomUUID();
const approval = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  actionKey: 'ORGANIZATION_SUSPEND',
  actionLabel: 'Suspend an organisation',
  state: 'PENDING',
  payload: { organizationId, toState: 'SUSPENDED', reasonCode: 'POLICY_VIOLATION' },
  summary: { organizationName: 'Northwind Employer', flagKey: null, enabled: null, capability: null, memberEmail: null, holdReason: null, olderThan: null, limit: null },
  reasonCode: 'POLICY_VIOLATION',
  note: null,
  requestedBy: { email: 'ops.lead@example.test', isSelf: false },
  requestedAt: '2026-09-25T10:00:00.000000Z',
  expiresAt: '2026-09-26T10:00:00.000000Z',
  coolingOffEndsAt: '2026-09-25T10:15:00.000000Z',
  decidedBy: null,
  decidedAt: null,
  decisionReasonCode: null,
  mode: null,
  soloNotice: null,
  executedAt: null,
  canApprove: true,
  canReject: true,
  approveRefusal: null,
  canExecute: false,
  ...over,
});
const queue = (approvals: unknown[], over: Record<string, unknown> = {}) => ({
  approvals, nextCursor: null,
  decisionReasons: { APPROVE: ['VERIFIED_NEED', 'POLICY_REQUIREMENT'], REJECT: ['NOT_NEEDED', 'WRONG_TARGET'] },
  approverCount: 2, soloSafeguardActive: false, viewerIsApprover: true, correlationId: 'corr-queue', ...over,
});
const policy = {
  actions: [
    { actionKey: 'ORGANIZATION_SUSPEND', label: 'Suspend an organisation', reasons: ['POLICY_VIOLATION', 'FRAUD_SUSPECTED'] },
    { actionKey: 'FEATURE_FLAG_HIGH_RISK_CHANGE', label: 'Change a high-risk feature flag', reasons: ['PILOT_ROLLOUT', 'ROLLBACK'] },
  ],
  decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 1, soloSafeguardActive: true, correlationId: 'corr-policy',
};

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let current: unknown = queue([approval()]);

beforeEach(() => {
  current = queue([approval()]);
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') return ok({ approval: approval({ state: 'APPROVED', mode: 'DUAL' }), organization: {}, flags: [], correlationId: 'corr-post' });
    if (path.includes('/operations/approvals/policy')) return ok(policy);
    if (path.includes('/operations/approvals')) return ok(current);
    if (path.includes('/operations/organizations')) return ok({ organizations: [{ id: organizationId, kind: 'EMPLOYER', legalName: 'Northwind Employer Pvt Ltd', verificationState: 'VERIFIED', active: true, updatedAt: '2026-09-25T10:00:00.000Z', profile: { displayName: 'Northwind Employer' } }] });
    if (path.includes('/operations/feature-flags')) return ok({ flags: [{ key: 'ai.tutor', description: 'AI tutor', enabled: false, cap: null, overrides: 0, lastChangedAt: null, highRiskDirection: 'ENABLE' }] });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('Approvals queue', () => {
  it('renders the server\'s requests as plain sentences, without identifiers', async () => {
    render(<OperationsApprovalsPanel />);
    const row = (await screen.findByText('Suspend Northwind Employer')).closest('tr')!;
    expect(within(row).getByText('ops.lead@example.test')).toBeInTheDocument();
    expect(within(row).getByText('Policy violation')).toBeInTheDocument();
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(row.textContent).not.toContain(organizationId);
    expect(screen.getByText('People who can approve').previousSibling).toHaveTextContent('2');
    expect(screen.getByText('Solo safeguard').previousSibling).toHaveTextContent('Off');
  });

  it('requires a decision reason code before approving, then sends it', async () => {
    render(<OperationsApprovalsPanel />);
    const row = (await screen.findByText('Suspend Northwind Employer')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Approve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve: Suspend an organisation' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm approval' });
    expect(confirm).toBeDisabled();
    const reasons = within(within(dialog).getByLabelText(/Reason code/)).getAllByRole('option').map((option) => option.textContent);
    expect(reasons).toEqual(['Choose a reason…', 'VERIFIED_NEED', 'POLICY_REQUIREMENT']);
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'VERIFIED_NEED' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/operations\/approvals\/[0-9a-f-]+\/decision$/);
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
  });

  it('executes an approved request through the action\'s own endpoint with the stored payload', async () => {
    const approved = approval({ state: 'APPROVED', canApprove: false, canReject: false, canExecute: true, requestedBy: { email: 'me@example.test', isSelf: true },
      decidedBy: { email: 'approver@example.test', isSelf: false }, decidedAt: '2026-09-25T10:05:00.000Z', decisionReasonCode: 'VERIFIED_NEED', mode: 'DUAL' });
    current = queue([approved]);
    render(<OperationsApprovalsPanel />);
    const row = (await screen.findByText('Suspend Northwind Employer')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Execute' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain(`/api/v1/operations/organizations/${organizationId}/verification`);
    expect(JSON.parse(String(init.body))).toEqual({ toState: 'SUSPENDED', reasonCode: 'POLICY_VIOLATION', approvalId: approved.id });
  });

  it('marks a solo approval and says plainly that its notice was not delivered', async () => {
    current = queue([approval({ state: 'APPROVED', canApprove: false, canReject: false, decidedBy: { email: 'me@example.test', isSelf: true },
      decidedAt: '2026-09-25T10:20:00.000Z', decisionReasonCode: 'VERIFIED_NEED', mode: 'SOLO', soloNotice: 'NOT_DELIVERED' })], { approverCount: 1, soloSafeguardActive: true });
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByText('Solo')).toBeInTheDocument();
    expect(screen.getByText('Notice not delivered — no email sender is configured.')).toBeInTheDocument();
    expect(screen.getByText(/Only one person can approve right now/)).toBeInTheDocument();
  });

  it('tells a sole approver when their own request becomes approvable', async () => {
    current = queue([approval({ canApprove: false, canReject: false, approveRefusal: 'APPROVAL_SOLO_COOLING_OFF', requestedBy: { email: 'me@example.test', isSelf: true } })]);
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByText(/You can approve your own request from/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve…' })).not.toBeInTheDocument();
  });

  it('shows an empty state, a loading state, an error with its reference, and a forbidden state', async () => {
    current = queue([]);
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByText('No high-risk action is waiting for a decision.')).toBeInTheDocument();
    cleanup();

    fetchMock.mockImplementation(() => new Promise(() => undefined));
    render(<OperationsApprovalsPanel />);
    expect(screen.getByText('Loading approvals…')).toBeInTheDocument();
    expect(screen.getByText('People who can approve').previousSibling).toHaveTextContent('NA');
    cleanup();

    fetchMock.mockImplementation(() => failure(500, 'INTERNAL', 'corr-appr-error'));
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load approvals. Support code: corrappr');
    cleanup();

    fetchMock.mockImplementation(() => failure(403, 'FORBIDDEN', 'corr-appr-403'));
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrappr')).toBeInTheDocument();
  });
});

describe('high-risk buttons file a request instead of acting', () => {
  it('Suspend on Organizations opens a confirm dialog that requires a reason and files an approval request', async () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    render(<OperationsOrganizationsPage portal={operations} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Northwind Employer' });
    expect(within(dialog).getByText(/approval required from a second person/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/you may approve it yourself after 15 minutes/)).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Request approval' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'FRAUD_SUSPECTED' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/operations\/approvals$/);
    expect(JSON.parse(String(init.body))).toEqual({ actionKey: 'ORGANIZATION_SUSPEND', payload: { organizationId, reasonCode: 'FRAUD_SUSPECTED' } });
    expect(posts().some(([postUrl]) => String(postUrl).includes('/verification'))).toBe(false);
  });

  it('enabling a high-risk flag files an approval request; its badge says which direction is high-risk', async () => {
    render(<OperationsFeatureFlagsPage />);
    expect(await screen.findByText('High-risk to enable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enable flag ai.tutor' });
    await within(dialog).findByRole('option', { name: 'PILOT_ROLLOUT' });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'PILOT_ROLLOUT' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'FEATURE_FLAG_HIGH_RISK_CHANGE', payload: { key: 'ai.tutor', enabled: true, reasonCode: 'PILOT_ROLLOUT' } });
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
