/**
 * Operations Settings — Staff and capabilities (OPS-01): renders the server's staff
 * directory, shows honest loading / empty / error / forbidden states, and never sends
 * a grant or revoke without a reason code chosen in the confirm dialog.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsStaffCapabilitiesPage } from './staffCapabilities.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const securityMembership = crypto.randomUUID();
const selfMembership = crypto.randomUUID();
const directory = (over: Record<string, unknown> = {}) => ({
  staff: [
    { membershipId: securityMembership, email: 'security.lead@example.test', role: 'SECURITY_ADMIN', state: 'ACTIVE', isSelf: false,
      baseline: ['SECURITY_AUDIT_SEARCH', 'OPS_FLAGS_MANAGE'], effective: ['SECURITY_AUDIT_SEARCH', 'OPS_FLAGS_MANAGE', 'INCIDENT_MANAGE'],
      grants: [{ capability: 'INCIDENT_MANAGE', grantedAt: '2026-09-20T10:00:00.000Z', reasonCode: 'NEW_RESPONSIBILITY', highRisk: false }] },
    { membershipId: selfMembership, email: 'me@example.test', role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE', isSelf: true,
      baseline: ['CAPABILITY_ADMIN'], effective: ['CAPABILITY_ADMIN'], grants: [] },
  ],
  nextCursor: null,
  capabilities: [
    { capability: 'SUPPORT_CASES', highRisk: false, grantableHere: true },
    { capability: 'PRIVACY_HOLDS', highRisk: true, grantableHere: true },
    { capability: 'INCIDENT_MANAGE', highRisk: false, grantableHere: true },
    { capability: 'CONTENT_REVIEW_EXTERNAL', highRisk: false, grantableHere: false },
  ],
  grantReasons: ['NEW_RESPONSIBILITY', 'TEMPORARY_COVER'],
  revokeReasons: ['RESPONSIBILITY_ENDED', 'LEAVER'],
  highRiskGrantsNeedApproval: true,
  correlationId: 'corr-staff-list',
  ...over,
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return ok({ member: directory().staff[0], correlationId: 'corr-change' });
    if (String(url).includes('/operations/staff')) return ok(directory());
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('Staff and capabilities', () => {
  it('renders each platform membership with its baseline and explicit grants from the server', async () => {
    render(<OperationsStaffCapabilitiesPage />);
    const row = (await screen.findByText('security.lead@example.test')).closest('tr')!;
    expect(within(row).getByText('Security Admin')).toBeInTheDocument();
    expect(within(row).getByText('2 capabilities')).toBeInTheDocument();
    expect(within(row).getByText('Incident manage')).toBeInTheDocument();
    expect(within(row).getByText(/New responsibility/)).toBeInTheDocument();
    // Already-held and faculty-only capabilities are not offered.
    const options = within(within(row).getByLabelText('Capability for security.lead@example.test')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Choose…', 'Support cases', 'Privacy holds (high-risk)']);
    expect(screen.getByText('Staff memberships').previousSibling).toHaveTextContent('2');
    expect(screen.getByText('Live explicit grants').previousSibling).toHaveTextContent('1');
  });

  it('offers no change on the operator\'s own membership', async () => {
    render(<OperationsStaffCapabilitiesPage />);
    const row = (await screen.findByText('me@example.test')).closest('tr')!;
    expect(within(row).getByText('Your own access is changed by another operator.')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  it('requires a reason code in the confirm dialog before granting, then sends it', async () => {
    render(<OperationsStaffCapabilitiesPage />);
    const row = (await screen.findByText('security.lead@example.test')).closest('tr')!;
    fireEvent.change(within(row).getByLabelText('Capability for security.lead@example.test'), { target: { value: 'SUPPORT_CASES' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Grant…' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant Support cases' });
    expect(within(dialog).getByText('No second approval is required.')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm grant' });
    expect(confirm).toBeDisabled();
    expect(posts()).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'TEMPORARY_COVER' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Support cases granted to security.lead@example.test.'));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain(`/api/v1/operations/staff/${securityMembership}/capabilities`);
    expect(JSON.parse(String(init.body))).toEqual({ capability: 'SUPPORT_CASES', reasonCode: 'TEMPORARY_COVER' });
  });

  // OPS-02 replaced OPS-01's "super admin only" block with dual control: a high-risk grant
  // files an approval request instead of granting, for every operator.
  it('files an approval request for a high-risk capability instead of granting it', async () => {
    render(<OperationsStaffCapabilitiesPage />);
    const row = (await screen.findByText('security.lead@example.test')).closest('tr')!;
    fireEvent.change(within(row).getByLabelText('Capability for security.lead@example.test'), { target: { value: 'PRIVACY_HOLDS' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Grant…' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant Privacy holds' });
    expect(within(dialog).getByText(/approval required from a second person/)).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Request approval' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_RESPONSIBILITY' } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Approval requested: Grant Privacy holds.'));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain('/api/v1/operations/approvals');
    expect(JSON.parse(String(init.body))).toEqual({
      actionKey: 'CAPABILITY_GRANT_HIGH_RISK', payload: { membershipId: securityMembership, capability: 'PRIVACY_HOLDS', reasonCode: 'NEW_RESPONSIBILITY' },
    });
    expect(posts().some(([postUrl]) => String(postUrl).includes('/capabilities'))).toBe(false);
  });

  it('revokes a grant with a revoke reason code', async () => {
    render(<OperationsStaffCapabilitiesPage />);
    const row = (await screen.findByText('security.lead@example.test')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke Incident manage from security.lead@example.test' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Incident manage' });
    const reasons = within(within(dialog).getByLabelText(/Reason code/)).getAllByRole('option').map((option) => option.textContent);
    expect(reasons).toEqual(['Choose a reason…', 'RESPONSIBILITY_ENDED', 'LEAVER']);
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'LEAVER' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm revoke' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(String(url)).toContain(`/api/v1/operations/staff/${securityMembership}/capabilities/INCIDENT_MANAGE/revoke`);
    expect(JSON.parse(String(init.body))).toEqual({ reasonCode: 'LEAVER' });
  });

  it('shows a plain empty state when there is no platform staff', async () => {
    fetchMock.mockImplementation(() => ok(directory({ staff: [] })));
    render(<OperationsStaffCapabilitiesPage />);
    expect(await screen.findByText('No platform staff yet')).toBeInTheDocument();
  });

  it('shows a loading state before the directory arrives', () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    render(<OperationsStaffCapabilitiesPage />);
    expect(screen.getByText('Loading staff…')).toBeInTheDocument();
    expect(screen.queryByText('Staff memberships')).toBeNull();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });

  it('shows a forbidden state with the reference when the caller lacks CAPABILITY_ADMIN', async () => {
    fetchMock.mockImplementation(() => failure(403, 'FORBIDDEN', 'corr-forbidden-1'));
    render(<OperationsStaffCapabilitiesPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrforb')).toBeInTheDocument();
  });

  it('shows an error with the correlation id and no internal detail', async () => {
    fetchMock.mockImplementation(() => failure(500, 'INTERNAL', 'corr-error-1'));
    render(<OperationsStaffCapabilitiesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load staff and capabilities. Support code: correrro');
  });

  it('asks for sign-in when there is no token', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(<OperationsStaffCapabilitiesPage />);
    expect(screen.getByText('Sign-in required')).toBeInTheDocument();
  });

  it('leaves the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
