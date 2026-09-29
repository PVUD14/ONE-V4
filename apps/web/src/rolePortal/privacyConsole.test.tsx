/**
 * Operations Security → Privacy and consent (OPS-06): the console renders the server's
 * queue, holds and coverage; a statutory deadline with no period in code is NA; engine
 * purposes that are not published say so instead of 0; suppressed counts render <5;
 * placing a hold needs a reason; releasing one files an approval request instead of
 * acting; and the loading, empty, error and forbidden states are honest.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsPrivacyConsolePage } from './privacyConsole.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const requestId = crypto.randomUUID();
const subjectUserId = crypto.randomUUID();
const holdId = crypto.randomUUID();
const deletion = {
  id: requestId, reference: 'PR-1A2B3C4D', requestType: 'DELETION', state: 'RECEIVED',
  subject: { userId: subjectUserId, maskedEmail: 'l***@college.example', erased: false },
  requestedAt: '2026-09-20T10:00:00.000Z', startedAt: null, completedAt: null, cancelledAt: null,
  deletionScheduledFor: '2026-10-20T10:00:00.000Z', exportExpiresAt: null, rejectionReasonCode: null,
  updatedAt: '2026-09-20T10:00:00.000Z', activeHolds: 0, statutoryDueAt: null,
};
const queue = (over: Record<string, unknown> = {}) => ({
  requests: [deletion],
  nextCursor: null,
  summary: { open: { EXPORT: 0, DELETION: 1 }, deletionsDueWithinSevenDays: 0, deletionsPastSchedule: 0, failed: 0, activeHolds: 1, releasesInFlight: 0 },
  policy: { deletionGracePeriodDays: 30, statutoryResponsePeriodDays: { EXPORT: null, DELETION: null } },
  correlationId: 'corr-queue',
  ...over,
});
const detail = {
  ...deletion,
  history: [{ fromState: null, toState: 'RECEIVED', actorRole: 'SUBJECT', occurredAt: '2026-09-20T10:00:00.000Z' }],
  deletionOutcome: [],
  holds: [],
};
const hold = (over: Record<string, unknown> = {}) => ({
  id: holdId, reasonCode: 'DISPUTE', detail: 'Case 2026-114',
  subject: { userId: crypto.randomUUID(), maskedEmail: 'a***@college.example', erased: false },
  placedAt: '2026-09-21T10:00:00.000Z', placedBy: { email: 'security@one.example' },
  openDeletion: { requestId: crypto.randomUUID(), reference: 'PR-99887766', scheduledFor: '2026-10-01T10:00:00.000Z' },
  releaseRequest: null,
  ...over,
});
const holds = (rows: readonly unknown[] = [hold()]) => ({
  holds: rows, capped: false,
  reasons: { place: ['LEGAL_OBLIGATION', 'DISPUTE'], release: ['OBLIGATION_ENDED', 'CASE_CLOSED', 'ENTERED_IN_ERROR'] },
  correlationId: 'corr-holds',
});
const suppressed = { suppressed: true, value: null };
const coverage = {
  keys: [
    { consentKey: 'adaptive-learning', status: 'NOT_PUBLISHED', liveVersion: null, title: null, enforcement: null, counts: null },
    { consentKey: 'privacy-notice', status: 'LIVE', liveVersion: '2026-09', title: 'Privacy notice', enforcement: 'BLOCKING',
      counts: { consentedToLiveVersion: { suppressed: false, value: 1234 }, withdrawn: suppressed, onOlderVersion: { suppressed: false, value: 7 } } },
    { consentKey: 'old-terms', status: 'NO_LIVE_VERSION', liveVersion: null, title: 'Old terms', enforcement: 'OPTIONAL', counts: null },
  ],
  definitions: [
    { consentKey: 'privacy-notice', version: '2026-09', title: 'Privacy notice', enforcement: 'BLOCKING', withdrawable: true, documentRef: null, effectiveFrom: '2026-09-01T00:00:00.000Z', retiredAt: null, status: 'LIVE' },
    { consentKey: 'privacy-notice', version: '2026-01', title: 'Privacy notice', enforcement: 'BLOCKING', withdrawable: true, documentRef: null, effectiveFrom: '2026-01-01T00:00:00.000Z', retiredAt: '2026-09-01T00:00:00.000Z', status: 'RETIRED' },
  ],
  suppressionThreshold: 5,
  correlationId: 'corr-coverage',
};

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let queueResponse: () => Promise<unknown>;
let holdsResponse: () => Promise<unknown>;

beforeEach(() => {
  queueResponse = () => ok(queue());
  holdsResponse = () => ok(holds());
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') return ok({ placed: true, id: crypto.randomUUID(), approval: {}, correlationId: 'corr-post' });
    if (path.includes('/operations/privacy/requests/')) return ok({ request: detail, correlationId: 'corr-detail' });
    if (path.includes('/operations/privacy/requests')) return queueResponse();
    if (path.includes('/operations/privacy/holds')) return holdsResponse();
    if (path.includes('/operations/privacy/consents')) return ok(coverage);
    if (path.includes('/operations/approvals/policy')) return ok({ actions: [], decisionReasons: { APPROVE: [], REJECT: [] }, approverCount: 2, soloSafeguardActive: false, correlationId: 'corr-policy' });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('Security: privacy and consent console', () => {
  it('renders the queue with a masked person and NA for a statutory deadline no rule defines', async () => {
    render(<OperationsPrivacyConsolePage />);
    const table = (await screen.findByText('PR-1A2B3C4D')).closest('table')!;
    const row = within(table).getByText('PR-1A2B3C4D').closest('tr')!;
    expect(within(row).getByText('l***@college.example')).toBeInTheDocument();
    expect(within(row).getByText('RECEIVED')).toBeInTheDocument();
    // Statutory deadline column: NA, because no DPDP period is defined in code.
    expect(within(row).getAllByRole('cell')[4]).toHaveTextContent('NA');
    expect(screen.getByText(/no DPDP response period is defined in ONE yet/)).toBeInTheDocument();
    expect(screen.getByText('Open deletions', { selector: 'small' }).previousSibling).toHaveTextContent('1');
    expect(screen.getByText('Legal holds in force', { selector: 'small' }).previousSibling).toHaveTextContent('1');
  });

  it('shows consent coverage from the server: real counts, <5 when suppressed, and not published for engine purposes', async () => {
    render(<OperationsPrivacyConsolePage />);
    const section = (await screen.findByText('Consent coverage', { selector: 'h2' })).closest('section')!;
    await within(section).findByText('adaptive-learning');
    const table = section.querySelector('table')!;
    const notice = within(table).getByText('privacy-notice', { selector: 'small' }).closest('tr')!;
    expect(within(notice).getByText('1,234')).toBeInTheDocument();
    expect(within(notice).getByText('<5')).toBeInTheDocument();
    expect(within(notice).getByText('7')).toBeInTheDocument();
    const engine = within(table).getByText('adaptive-learning').closest('tr')!;
    expect(within(engine).getAllByText('Not published').length).toBe(4);
    expect(within(engine).queryByText('0')).not.toBeInTheDocument();
    expect(within(engine).queryByText(/%/)).not.toBeInTheDocument();
    const retired = within(table).getByText('old-terms').closest('tr')!;
    expect(within(retired).getByText('No version in force')).toBeInTheDocument();
    expect(within(retired).getAllByText('NA').length).toBe(3);
    expect(within(section).getByText('Retired', { selector: 'span' })).toBeInTheDocument();
  });

  it('opens a request with its state history and says the read is audited', async () => {
    render(<OperationsPrivacyConsolePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    const panel = await screen.findByRole('region', { name: 'Privacy request detail' });
    expect(within(panel).getByText(/Received as RECEIVED · by the person/)).toBeInTheDocument();
    expect(within(panel).getByText('Opening this request was recorded in the audit log.')).toBeInTheDocument();
    expect(within(panel).getByText('Nothing has been erased yet.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/operations/privacy/requests/${requestId}`))).toBe(true);
  });

  it('places a hold only after a reason code is chosen', async () => {
    render(<OperationsPrivacyConsolePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Place a legal hold…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Place a legal hold' });
    const confirm = within(dialog).getByRole('button', { name: 'Place hold' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'DISPUTE' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/operations/privacy/holds');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ subjectUserId, reasonCode: 'DISPUTE' });
    expect(await screen.findByText(/Legal hold placed on l\*\*\*@college.example/)).toBeInTheDocument();
  });

  it('files a hold release as an approval request, never releasing it directly', async () => {
    render(<OperationsPrivacyConsolePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request release…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release a legal hold' });
    expect(within(dialog).getByText(/approval required from a second person/)).toBeInTheDocument();
    expect(within(dialog).getByText(/PR-99887766 can complete/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Request approval' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'CASE_CLOSED' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/operations/approvals');
    expect(String(posts()[0]![0])).not.toContain('/release');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'PRIVACY_HOLD_RELEASE', payload: { holdId, reasonCode: 'CASE_CLOSED' } });
  });

  it('shows a release already in flight instead of offering another', async () => {
    holdsResponse = () => ok(holds([hold({ releaseRequest: { state: 'APPROVED', expiresAt: '2026-09-27T10:00:00.000Z', requestedBy: { email: 'security@one.example' } } })]));
    render(<OperationsPrivacyConsolePage />);
    expect(await screen.findByText('Release approved')).toBeInTheDocument();
    expect(screen.getByText(/Carry it out from Settings → Approvals/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request release…' })).not.toBeInTheDocument();
  });

  it('shows honest empty states', async () => {
    queueResponse = () => ok(queue({ requests: [] }));
    holdsResponse = () => ok(holds([]));
    render(<OperationsPrivacyConsolePage />);
    expect(await screen.findByText('Nobody has an open export or deletion request.')).toBeInTheDocument();
    expect(await screen.findByText('No holds in force')).toBeInTheDocument();
  });

  it('shows a loading state first', () => {
    queueResponse = () => new Promise(() => undefined);
    render(<OperationsPrivacyConsolePage />);
    expect(screen.getByText('Loading privacy requests…')).toBeInTheDocument();
    expect(screen.getByText('Open deletions', { selector: 'small' }).previousSibling).toHaveTextContent('NA');
  });

  it('shows an error with its reference, and NA in every tile', async () => {
    queueResponse = () => failure(500, 'INTERNAL', 'corr-broken');
    render(<OperationsPrivacyConsolePage />);
    expect(await screen.findByText(/Reference: corr-broken/)).toBeInTheDocument();
    expect(screen.getByText('Erasures due in 7 days', { selector: 'small' }).previousSibling).toHaveTextContent('NA');
  });

  it('says plainly when the caller may not use the console', async () => {
    queueResponse = () => failure(403, 'FORBIDDEN', 'corr-denied');
    render(<OperationsPrivacyConsolePage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-denied')).toBeInTheDocument();
  });

  it('asks for sign-in without a token', () => {
    vi.mocked(getProtectedAccessToken).mockReturnValue(null);
    render(<OperationsPrivacyConsolePage />);
    expect(screen.getByText('Sign-in required')).toBeInTheDocument();
  });

  it('links the breach runbook and points to the incident register (OPS-16)', async () => {
    render(<OperationsPrivacyConsolePage />);
    expect(await screen.findByText(/docs\/ops\/runbook-breach-response\.md/)).toBeInTheDocument();
    expect(screen.getByText('Incident register: below')).toBeInTheDocument();
    expect(screen.queryByText('Incident register: not built yet')).not.toBeInTheDocument();
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
