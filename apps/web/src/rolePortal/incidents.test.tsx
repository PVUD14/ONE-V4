/**
 * Operations Security incident register and Settings status communications (OPS-16): the register
 * renders the server's incidents and counts, a breach shows its Board deadline labelled as the
 * plan's period pending legal confirmation and who recorded the Board report, every write dialog
 * needs a reason code, a notice can only be drafted from a published template version with no
 * free-text field, and loading / NA / empty / error / forbidden states are honest. Navigation
 * labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { formatRemaining, OperationsIncidentRegisterPage } from './incidents.js';
import { OperationsCommunicationsPage } from './communications.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const incidentId = crypto.randomUUID();
const templateId = crypto.randomUUID();
const noticeId = crypto.randomUUID();
const basisText = 'The 72-hour period comes from the ONE plan and is pending legal confirmation. ONE never contacts the Data Protection Board itself: a person reports, and records it here.';

const policy = {
  categories: ['PERSONAL_DATA_BREACH', 'SECURITY', 'SERVICE_OUTAGE'],
  severities: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
  states: ['OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED'],
  transitions: { OPEN: ['CONTAINED', 'RESOLVED', 'CLOSED'], CONTAINED: ['OPEN', 'RESOLVED'], RESOLVED: ['OPEN', 'CLOSED'], CLOSED: [] },
  breachClock: { hours: 72, basis: 'PLAN_PENDING_LEGAL_CONFIRMATION', basisText },
  reasons: {
    declare: ['INTERNAL_DISCOVERY'], transition: { OPEN: ['RECURRENCE'], CONTAINED: ['CREDENTIAL_ROTATED'], RESOLVED: ['ROOT_CAUSE_FIXED'], CLOSED: ['POST_INCIDENT_REVIEW_DONE'] },
    closeFromOpen: ['DUPLICATE', 'FALSE_ALARM'], severity: ['SCOPE_GREW'], category: ['CONFIRMED_PERSONAL_DATA'], note: ['TIMELINE_UPDATE'],
    organizationAdd: ['SCOPE_ASSESSED'], organizationRemove: ['ENTERED_IN_ERROR'], boardNotified: ['BOARD_REPORT_FILED'], usersNotified: ['USERS_NOTIFIED_BY_EMAIL'],
  },
  correlationId: 'corr-policy',
};

const clock = (over: Record<string, unknown> = {}) => ({
  hours: 72, basis: 'PLAN_PENDING_LEGAL_CONFIRMATION', deadlineAt: '2026-10-02T08:00:00.000000Z', status: 'RUNNING', remainingSeconds: 250_000,
  boardNotifiedAt: null, boardNotifiedBy: null, boardReference: null, usersNotifiedAt: null, usersNotifiedBy: null, ...over,
});
const incident = (over: Record<string, unknown> = {}) => ({
  id: incidentId, reference: 'INC-1A2B3C4D', title: 'Backup credential exposed in a build log', summary: 'A storage credential appeared in a public CI log.',
  category: 'PERSONAL_DATA_BREACH', severity: 'HIGH', state: 'OPEN', detectedAt: '2026-09-29T08:00:00.000000Z', declaredAt: '2026-09-29T09:00:00.000000Z',
  declaredBy: 'security.lead@example.test', containedAt: null, resolvedAt: null, closedAt: null, affectedOrganizationsCount: 1, breachClock: clock(),
  updatedAt: '2026-09-29T09:00:00.000000Z', ...over,
});
const list = (incidents: unknown[]) => ({ incidents, nextCursor: null, summary: { open: 2, openBreaches: 1, breachClocksRunning: 1, breachClocksOverdue: 0 }, correlationId: 'corr-list' });
const detail = (over: Record<string, unknown> = {}) => ({
  incident: incident(over), allowedTransitions: ['CONTAINED', 'RESOLVED', 'CLOSED'],
  timeline: [{ kind: 'DECLARED', fromValue: null, toValue: 'OPEN', organizationName: null, noticeId: null, note: null, reasonCode: 'INTERNAL_DISCOVERY', actor: 'security.lead@example.test', occurredAt: '2026-09-29T09:00:00.000000Z' }],
  organizations: [{ organizationId: crypto.randomUUID(), name: 'Riverside College', kind: 'INSTITUTION', addedAt: '2026-09-29T09:05:00.000000Z', removedAt: null }],
  notices: [{ id: noticeId, state: 'SENT', templateKey: 'credential-rotated', templateVersion: 1, subject: 'Service notice: credential rotated', approvedBy: 'ops.lead@example.test',
    approvedAt: '2026-09-29T10:00:00.000000Z', sentAt: '2026-09-29T10:00:05.000000Z', recipientCount: 2, organizationCount: 1,
    email: { sent: 0, pending: 0, notConfigured: 2, failed: 0, bounced: 0, skipped: 0 } }],
  correlationId: 'corr-detail',
});

const commsPolicy = {
  reasons: { templateDraft: ['NEW_TEMPLATE'], templatePublish: ['INCIDENT_COMMUNICATION'], templateWithdraw: ['NOT_NEEDED'], noticeDraft: ['INITIAL_NOTICE'], noticeApprove: ['APPROVED_FOR_SEND'], noticeWithdraw: ['NOT_NEEDED'] },
  rateLimit: { minimumSpacingMinutes: 15, dailyLimit: 6 }, approverCount: 1, soloSafeguardActive: true,
  incidents: [{ id: incidentId, reference: 'INC-1A2B3C4D', title: 'Backup credential exposed in a build log', state: 'OPEN', category: 'PERSONAL_DATA_BREACH', affectedOrganizationsCount: 1 }],
  correlationId: 'corr-comms',
};
const template = (over: Record<string, unknown> = {}) => ({
  id: templateId, templateKey: 'credential-rotated', version: 1, subject: 'Service notice: credential rotated', body: 'We rotated a storage credential.', contentHash: 'a'.repeat(64),
  state: 'DRAFT', draftedBy: { email: 'ops.lead@example.test', isSelf: true }, draftedAt: '2026-09-29T09:30:00.000000Z', publishedAt: null, approvedBy: null, publishMode: null,
  withdrawnAt: null, approval: null, canRequestApproval: true, canPublish: false, ...over,
});
const statusNotice = (over: Record<string, unknown> = {}) => ({
  id: noticeId, incident: { id: incidentId, reference: 'INC-1A2B3C4D', title: 'Backup credential exposed in a build log', state: 'OPEN' },
  template: { id: templateId, templateKey: 'credential-rotated', version: 1, subject: 'Service notice: credential rotated', body: 'We rotated a storage credential.' },
  state: 'DRAFT', draftedBy: 'ops.lead@example.test', draftedAt: '2026-09-29T09:40:00.000000Z', approvedBy: null, approvedAt: null, sentAt: null,
  recipientCount: null, organizationCount: null, email: { sent: 0, pending: 0, notConfigured: 0, failed: 0, bounced: 0, skipped: 0 }, withdrawnAt: null, ...over,
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let listResponse: () => Promise<unknown> = () => ok(list([incident()]));
let templatesResponse: () => Promise<unknown> = () => ok({ templates: [template()], nextCursor: null });
let noticeApproveResponse: () => Promise<unknown> = () => ok({ notice: statusNotice({ state: 'QUEUED' }) });
let noticesResponse: () => Promise<unknown> = () => ok({ notices: [statusNotice()], nextCursor: null });
let commsPolicyResponse: () => Promise<unknown> = () => ok(commsPolicy);

beforeEach(() => {
  listResponse = () => ok(list([incident()]));
  templatesResponse = () => ok({ templates: [template(), template({ id: crypto.randomUUID(), templateKey: 'outage-update', state: 'PUBLISHED', approvedBy: 'super@example.test', publishMode: 'SOLO', canRequestApproval: false })], nextCursor: null });
  noticeApproveResponse = () => ok({ notice: statusNotice({ state: 'QUEUED' }) });
  noticesResponse = () => ok({ notices: [statusNotice()], nextCursor: null });
  commsPolicyResponse = () => ok(commsPolicy);
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') {
      if (path.includes('/notices/') && path.endsWith('/approve')) return noticeApproveResponse();
      if (path.includes('/communications/')) return ok({ template: template(), notice: statusNotice(), correlationId: 'corr-post' });
      if (path.includes('/operations/approvals')) return ok({ approval: { id: crypto.randomUUID() }, correlationId: 'corr-approval' });
      if (path.endsWith('/operations/incidents')) return ok({ incident: incident({ id: crypto.randomUUID(), reference: 'INC-9F9F9F9F' }), correlationId: 'corr-declare' });
      return ok(detail({ state: 'CONTAINED' }));
    }
    if (path.includes('/incidents/policy')) return ok(policy);
    if (path.includes('/incidents/') && !path.includes('organization-options')) return ok(detail());
    if (path.includes('/operations/incidents')) return listResponse();
    if (path.includes('/communications/policy')) return commsPolicyResponse();
    if (path.includes('/communications/templates')) return templatesResponse();
    if (path.includes('/communications/notices')) return noticesResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

describe('incident register', () => {
  it('renders the server register, its counts and the breach clock label', async () => {
    render(<OperationsIncidentRegisterPage />);
    expect(await screen.findByText('INC-1A2B3C4D')).toBeInTheDocument();
    expect(screen.getByText('Backup credential exposed in a build log')).toBeInTheDocument();
    expect(screen.getByText('Open personal data breaches').previousSibling?.textContent).toBe('1');
    expect(screen.getByText('Clock running')).toBeInTheDocument();
    expect(await screen.findByText(basisText)).toBeInTheDocument();
  });

  it('shows NA in the counts while nothing has loaded, then the loading state', () => {
    listResponse = () => new Promise(() => undefined);
    render(<OperationsIncidentRegisterPage />);
    expect(screen.getByText('Loading incidents…')).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(4);
  });

  it('says so plainly when the view is empty', async () => {
    listResponse = () => ok(list([]));
    render(<OperationsIncidentRegisterPage />);
    expect(await screen.findByText('No incidents here')).toBeInTheDocument();
  });

  it('shows an error with its reference', async () => {
    listResponse = () => failure(500, 'INTERNAL', 'corr-broken-1');
    render(<OperationsIncidentRegisterPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Support code: corrbrok');
  });

  it('shows a forbidden state with the reference to a caller without Incident Manage', async () => {
    listResponse = () => failure(403, 'FORBIDDEN', 'corr-denied-7');
    render(<OperationsIncidentRegisterPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrdeni')).toBeInTheDocument();
  });

  it('shows NA for the clock of an incident that is not a breach', async () => {
    listResponse = () => ok(list([incident({ category: 'SERVICE_OUTAGE', breachClock: null })]));
    render(<OperationsIncidentRegisterPage />);
    const row = (await screen.findByText('INC-1A2B3C4D')).closest('tr')!;
    expect(within(row).getByText('NA')).toBeInTheDocument();
  });

  it('opens an incident with its deadline, who reported to the Board and when, and the notices sent', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      const path = String(url);
      if (init?.method === 'POST') return ok(detail());
      if (path.includes('/incidents/policy')) return ok(policy);
      if (path.includes(`/incidents/${incidentId}`)) {
        return ok(detail({ breachClock: clock({ status: 'MET', remainingSeconds: null, boardNotifiedAt: '2026-09-30T08:00:00.000000Z', boardNotifiedBy: 'security.lead@example.test', boardReference: 'DPB-ACK-1' }) }));
      }
      return ok(list([incident()]));
    });
    render(<OperationsIncidentRegisterPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INC-1A2B3C4D' }));
    const panel = await screen.findByRole('region', { name: 'Incident INC-1A2B3C4D' });
    expect(within(panel).getByText('Board notified in time')).toBeInTheDocument();
    expect(within(panel).getByText(/recorded by security\.lead@example\.test · reference DPB-ACK-1/)).toBeInTheDocument();
    expect(within(panel).getByText('Not yet told')).toBeInTheDocument();
    expect(within(panel).getByText('2 admins in 1 organisations')).toBeInTheDocument();
    expect(within(panel).getByText('2 not sent — no mail service configured')).toBeInTheDocument();
    expect(within(panel).getByText('Riverside College')).toBeInTheDocument();
  });

  it('needs a reason code before moving an incident', async () => {
    render(<OperationsIncidentRegisterPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INC-1A2B3C4D' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Move to Contained…' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(within(dialog).getByText(/Not required/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'CREDENTIAL_ROTATED' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/incidents/${incidentId}/transition`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ toState: 'CONTAINED', reasonCode: 'CREDENTIAL_ROTATED' });
  });

  it('records a Board report with the time it happened and a reason, saying ONE sends nothing', async () => {
    render(<OperationsIncidentRegisterPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INC-1A2B3C4D' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Record Board report…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ONE sends nothing to the Board/)).toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: 'Save' });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'BOARD_REPORT_FILED' } });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/When it happened/), { target: { value: '2026-09-30T13:30' } });
    fireEvent.click(save);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse(String(posts()[0]![1].body));
    expect(body).toMatchObject({ reasonCode: 'BOARD_REPORT_FILED', notifiedAt: new Date('2026-09-30T13:30').toISOString() });
  });

  it('declares an incident from a form that asks for no personal data', async () => {
    render(<OperationsIncidentRegisterPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Declare incident' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/No names, email addresses or phone numbers/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: 'API unavailable' } });
    fireEvent.change(within(dialog).getByLabelText(/Summary/), { target: { value: 'Errors for twelve minutes.' } });
    fireEvent.change(within(dialog).getByLabelText(/^Category/), { target: { value: 'PERSONAL_DATA_BREACH' } });
    expect(within(dialog).getByText('72-hour Board clock')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Severity/), { target: { value: 'HIGH' } });
    fireEvent.change(within(dialog).getByLabelText(/Detected at/), { target: { value: '2026-09-29T08:00' } });
    const declareButton = within(dialog).getByRole('button', { name: 'Declare incident' });
    expect(declareButton).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'INTERNAL_DISCOVERY' } });
    fireEvent.click(declareButton);
    expect(await screen.findByText('Incident INC-9F9F9F9F declared.')).toBeInTheDocument();
  });

  it('formats the remaining time from the server seconds', () => {
    expect(formatRemaining(250_000)).toBe('69 h 26 min left');
    expect(formatRemaining(0)).toBe('Deadline passed');
    expect(formatRemaining(null)).toBe('NA');
  });
});

describe('status communications', () => {
  it('renders templates and notices, and the solo safeguard', async () => {
    render(<OperationsCommunicationsPage />);
    expect(await screen.findByText('Status communications')).toBeInTheDocument();
    expect(screen.getAllByText('credential-rotated').length).toBeGreaterThan(0);
    expect(screen.getByText('Approved by super@example.test (solo)')).toBeInTheDocument();
    expect(screen.getByText('Solo safeguard active')).toBeInTheDocument();
    expect(screen.getByText(/one notice per incident every 15 minutes, at most 6 in 24 hours/)).toBeInTheDocument();
  });

  it('asks for approval of a draft version through the dual-control queue, with a reason', async () => {
    render(<OperationsCommunicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for approval…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Required: a second person/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'INCIDENT_COMMUNICATION' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/api/v1/operations/approvals');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'COMMS_TEMPLATE_PUBLISH', payload: { templateId, reasonCode: 'INCIDENT_COMMUNICATION' } });
  });

  it('offers only published template versions for a notice, and has no free-text field', async () => {
    render(<OperationsCommunicationsPage />);
    const form = await screen.findByRole('form', { name: 'Draft a notice' });
    const templateSelect = within(form).getByLabelText(/Published template version/);
    const options = within(templateSelect).getAllByRole('option').map((option) => option.textContent);
    expect(options.some((text) => text?.startsWith('outage-update v1'))).toBe(true);
    expect(options.some((text) => text?.startsWith('credential-rotated'))).toBe(false);
    expect(within(form).queryByRole('textbox')).toBeNull();
  });

  it('approves a drafted notice for sending with a reason, and explains the rate limit on 429', async () => {
    noticeApproveResponse = () => failure(429, 'STATUS_NOTICE_RATE_LIMITED', 'corr-limit-3');
    render(<OperationsCommunicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve for sending…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/from the approved wording only/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'APPROVED_FOR_SEND' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Rate limit: a notice for this incident was approved in the last 15 minutes, or 6 in the last day. Support code: corrlimi');
  });

  it('leaves a notice the viewer drafted to another person, and marks a solo approval', async () => {
    noticesResponse = () => ok({ notices: [
      statusNotice({ draftedBySelf: true }),
      statusNotice({ id: crypto.randomUUID(), state: 'QUEUED', approvedBy: 'ops.lead@example.test', approvedAt: '2026-09-29T10:00:00.000000Z', approveMode: 'SOLO' }),
    ], nextCursor: null });
    commsPolicyResponse = () => ok({ ...commsPolicy, noticeApproverCount: 2, noticeSoloSafeguardActive: false, soloCoolingOffMinutes: 15 });
    render(<OperationsCommunicationsPage />);
    expect(await screen.findByText('You drafted this notice, so another person approves it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve for sending/ })).toBeNull();
    // The drafter can still withdraw it (the template row has its own Withdraw button too).
    expect(screen.getAllByRole('button', { name: 'Withdraw…' }).length).toBeGreaterThan(1);
    expect(screen.getByText(/by ops\.lead@example\.test \(solo\)/)).toBeInTheDocument();
  });

  it('lets the sole approver approve their own notice under the solo safeguard, and explains the cooling-off', async () => {
    noticesResponse = () => ok({ notices: [statusNotice({ draftedBySelf: true, soloApprovalAvailableAt: '2026-09-29T09:55:00.000000Z' })], nextCursor: null });
    commsPolicyResponse = () => ok({ ...commsPolicy, noticeApproverCount: 1, noticeSoloSafeguardActive: true, soloCoolingOffMinutes: 15 });
    noticeApproveResponse = () => failure(403, 'STATUS_NOTICE_SOLO_COOLING_OFF', 'corr-cool-1');
    render(<OperationsCommunicationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve for sending (solo)…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/the solo safeguard applies/)).toBeInTheDocument();
    expect(within(dialog).getByText(/15-minute cooling-off\) and is marked Solo/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'APPROVED_FOR_SEND' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/The solo cooling-off has not passed: you can approve your own notice from .+\. Support code: corrcool/);
  });

  it('shows empty states plainly', async () => {
    templatesResponse = () => ok({ templates: [], nextCursor: null });
    render(<OperationsCommunicationsPage />);
    expect(await screen.findByText('No templates yet')).toBeInTheDocument();
    expect(screen.getByText('No template version is published yet. A notice can only use a published version.')).toBeInTheDocument();
  });

  it('shows a forbidden state with the reference', async () => {
    templatesResponse = () => failure(403, 'FORBIDDEN', 'corr-denied-9');
    render(<OperationsCommunicationsPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrdeni')).toBeInTheDocument();
  });

  it('shows an error with its reference', async () => {
    templatesResponse = () => failure(500, 'INTERNAL', 'corr-broken-4');
    render(<OperationsCommunicationsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Support code: corrbrok');
  });
});

describe('navigation', () => {
  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
