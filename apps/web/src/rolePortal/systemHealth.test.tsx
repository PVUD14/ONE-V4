/**
 * Operations System Health (OPS-04): the console renders the server's summary and
 * failed events, a missing source hides its slot (never "NA"), replay needs a reason code,
 * supersede files an approval request instead of acting, and the loading, empty, error
 * and forbidden states are honest.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsSystemHealthPage } from './systemHealth.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const eventId = crypto.randomUUID();
const count = (value: number, capped = false) => ({ value, capped });
const summary = (over: Record<string, unknown> = {}) => ({
  summary: {
    generatedAt: '2026-09-25T10:00:00.000Z',
    outbox: {
      counts: { PENDING: count(4), PROCESSING: count(0), FAILED: count(2), PUBLISHED: count(10_000, true) },
      oldestPendingAt: '2026-09-25T09:00:00.000Z', oldestDueWaitingSince: '2026-09-25T09:15:00.000Z', oldestDueWaitingMinutes: 45,
      failedByType: [{ eventType: 'institution.student.invitation.requested', count: 2 }], failedByClass: [{ failureClass: 'TERMINAL_PUBLISH_FAILURE', count: 2 }],
    },
    worker: { verdict: 'STALLED', lastDeliveredAt: null, activeLeases: count(0), expiredLeases: count(1) },
    consumers: [{ name: 'student-invitation-delivery', label: 'Student invitation delivery', lastActivityAt: null, lastSucceededAt: null, failedReceipts: count(0), silenceMinutes: null, silent: null }],
    automation: {
      workflows: [{ allowlistId: 'ops-failure', version: 1, operation: 'SEND_EMAIL', active: false, killSwitch: true }],
      commandCounts: { PENDING: count(0), FAILED_TERMINAL: count(3) }, lastCommandAt: null, lastCallbackAt: null,
    },
    alerts: {
      config: { failedThreshold: 10, pendingStallMinutes: 30, consumerSilenceMinutes: {}, ignored: [] },
      delivery: { workflowEnabled: false, templateApproved: false },
      open: [{ id: crypto.randomUUID(), conditionKey: 'PENDING_EVENTS_STALLED', subject: null, state: 'OPEN', observedValue: 45, threshold: 30, notice: 'NOT_DELIVERED', raisedAt: '2026-09-25T09:45:00.000Z', clearedAt: null }],
      recent: [],
    },
    ...over,
  },
  reasons: { replay: ['TRANSIENT_FAILURE_RESOLVED', 'CONFIGURATION_FIXED'], supersede: ['PRE_DISPATCHER_BACKLOG', 'INCIDENT_CLEANUP'] },
  correlationId: 'corr-summary',
});
const failedEvent = {
  eventId, eventType: 'institution.student.invitation.requested', eventVersion: 1, aggregateType: 'invitation', attempts: 5,
  failureClass: 'TERMINAL_PUBLISH_FAILURE', occurredAt: '2026-09-25T08:00:00.000Z', failedAt: '2026-09-25T08:30:00.000Z', expiresAt: null, replayable: true,
};
const detail = { ...failedEvent, correlationId: 'corr-event-reference', explanation: 'Delivery failed on every attempt, or the receiver refused it permanently.', receipts: [], automationCommand: null };

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let summaryResponse: () => Promise<unknown> = () => ok(summary());
let failedResponse: () => Promise<unknown> = () => ok({ events: [failedEvent], nextCursor: null });

beforeEach(() => {
  summaryResponse = () => ok(summary());
  failedResponse = () => ok({ events: [failedEvent], nextCursor: null });
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') return ok({ replayed: true, approval: {}, correlationId: 'corr-post' });
    if (path.includes('/operations/jobs/summary')) return summaryResponse();
    if (path.includes('/operations/jobs/failed/')) return ok({ event: detail, correlationId: 'corr-detail' });
    if (path.includes('/operations/jobs/failed')) return failedResponse();
    if (path.includes('/operations/jobs/backlog')) return ok({ olderThan: '2026-01-01T00:00:00.000Z', pending: count(12), limit: 10_000, correlationId: 'corr-backlog' });
    if (path.includes('/operations/approvals/policy')) return ok({ actions: [], decisionReasons: { APPROVE: [], REJECT: [] }, approverCount: 2, soloSafeguardActive: false, correlationId: 'corr-policy' });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('System Health console', () => {
  it('renders the server summary, and hides a slot whose source has nothing', async () => {
    render(<OperationsSystemHealthPage />);
    expect(await screen.findByText('45 min')).toBeInTheDocument();
    expect(screen.getByText('Failed events', { selector: 'small' }).previousSibling).toHaveTextContent('2');
    expect(screen.getByText('10,000+')).toBeInTheDocument();
    expect(screen.getByText('Stalled')).toBeInTheDocument();
    // No delivery has happened: the tile is hidden rather than reading NA.
    expect(screen.queryByText('Last event delivered', { selector: 'small' })).toBeNull();
    const consumers = screen.getByRole('heading', { name: 'Consumers' }).closest('section')!;
    expect(within(consumers).getAllByText('Never')).toHaveLength(2);
    expect(within(consumers).getByText('Not judged')).toBeInTheDocument();
    const automation = screen.getByRole('heading', { name: 'Automation workflows and commands' }).closest('section')!;
    expect(within(automation).getByText('Last command created').nextSibling).toHaveTextContent('Never');
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
    expect(within(consumers).getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText(/An event waited past the limit: 45 minutes, limit 30/)).toBeInTheDocument();
    expect(screen.getByText(/recorded here but not emailed/)).toBeInTheDocument();
    expect(screen.getByText('ops-failure')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Replay…' })).toBeInTheDocument();
  });

  it('inspects a failed event and shows its explanation and reference, never its payload', async () => {
    render(<OperationsSystemHealthPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect' }));
    const panel = await screen.findByRole('region', { name: 'Failed event detail' });
    expect(within(panel).getByText(/Delivery failed on every attempt/)).toBeInTheDocument();
    expect(within(panel).getByText('corr-event-reference')).toBeInTheDocument();
    expect(within(panel).getByText('No consumer has handled this event.')).toBeInTheDocument();
  });

  it('replays only after a reason code is chosen', async () => {
    render(<OperationsSystemHealthPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replay…' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm replay' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText(/Not required: a single replay/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'TRANSIENT_FAILURE_RESOLVED' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/operations/outbox/${eventId}/replay`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'TRANSIENT_FAILURE_RESOLVED' });
    expect(await screen.findByText(/Replay queued/)).toBeInTheDocument();
  });

  it('files a supersede as an approval request with the previewed cutoff and limit', async () => {
    render(<OperationsSystemHealthPage />);
    await screen.findByText('45 min');
    fireEvent.change(screen.getByLabelText('Cutoff'), { target: { value: '2026-01-01T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Count waiting events' }));
    expect(await screen.findByText(/12 waiting events occurred before/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Request supersede…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Supersede the waiting backlog' });
    expect(within(dialog).getByText(/approval required from a second person/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Request approval' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'PRE_DISPATCHER_BACKLOG' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/operations/approvals');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({
      actionKey: 'OUTBOX_BACKLOG_SUPERSEDE', payload: { olderThan: '2026-01-01T00:00:00.000Z', limit: 10_000, reasonCode: 'PRE_DISPATCHER_BACKLOG' },
    });
  });

  it('shows an honest empty state when nothing has failed', async () => {
    failedResponse = () => ok({ events: [], nextCursor: null });
    render(<OperationsSystemHealthPage />);
    expect(await screen.findByText('Nothing is in the dead letter.')).toBeInTheDocument();
  });

  it('shows a loading state first', () => {
    summaryResponse = () => new Promise(() => undefined);
    render(<OperationsSystemHealthPage />);
    expect(screen.getByText('Loading background job health…')).toBeInTheDocument();
  });

  it('shows an error with its reference, and hides every tile', async () => {
    summaryResponse = () => failure(500, 'INTERNAL', 'corr-broken');
    render(<OperationsSystemHealthPage />);
    expect(await screen.findByText(/Support code: corrbrok/)).toBeInTheDocument();
    expect(screen.queryByText('Failed events', { selector: 'small' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });

  it('says plainly when the caller may not use the console', async () => {
    summaryResponse = () => failure(403, 'FORBIDDEN', 'corr-denied');
    render(<OperationsSystemHealthPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrdeni')).toBeInTheDocument();
  });

  it('asks for sign-in without a token', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(<OperationsSystemHealthPage />);
    expect(screen.getByText('Sign-in required')).toBeInTheDocument();
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
