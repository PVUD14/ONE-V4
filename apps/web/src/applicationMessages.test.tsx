/**
 * EMP-10 web: the employer's Messages item and the conversation on Candidate Detail, and the
 * student's conversation inside My applications — real data from the API only, text never rendered
 * as a link, a warning on messages that carry one, honest empty, closed and error states, and the
 * navigation labels unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from './api.js';
import { EmployerConversationPanel, StudentConversationCard } from './applicationMessages.js';
import { StudentApplicationsPage } from './hiringPages.js';
import { rolePortals } from './rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './rolePortal/employer.js';

vi.mock('./auth.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./auth.js')>(), getAccessToken: vi.fn(() => 'session-token') }));
vi.mock('./api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));

const employerId = '44444444-4444-4444-8444-444444444444';
const applicationId = '22222222-2222-4222-8222-222222222222';
const messageId = '55555555-5555-4555-8555-555555555555';
const base = `/api/v1/employers/${employerId}`;
const portal = rolePortals.find((item) => item.key === 'recruiter')!;

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
let routes: Record<string, Handler>;

beforeEach(() => {
  routes = {};
  vi.mocked(getProtectedAccessToken).mockReturnValue('session-token');
  vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: 'u', memberships: [
    { organizationId: employerId, role: 'RECRUITER', scope: { organizationId: employerId, employerId } },
  ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, window.location.origin).pathname;
    const key = `${init?.method ?? 'GET'} ${path}`;
    const handler = routes[key];
    if (!handler) throw new Error('Unexpected endpoint ' + key);
    const result = handler(init);
    const status = result.status ?? 200;
    return { ok: status < 400, status, headers: new Headers(), json: async () => result.body };
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const posted = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ path: new URL(String(url), window.location.origin).pathname, body: JSON.parse(String(init!.body)) as unknown }));

const employerMessage = (overrides: Record<string, unknown> = {}) => ({
  id: messageId, from: 'EMPLOYER', mine: false, body: 'Please pay the fee at https://pay.example.test/now', containsLink: true,
  sentAt: '2026-09-20T05:00:00.000Z', readAt: null, erased: false, reportedAt: null, ...overrides,
});

describe('EMP-10 employer Messages', () => {
  it('lists real conversations behind the existing Messages item, and opens one', async () => {
    routes[`GET ${base}/message-threads`] = () => ({ body: {
      threads: [{ applicationId, opportunityId: 'o', title: 'Robotics engineer', referenceCode: 'ROB-7', candidateName: 'Synthetic Candidate',
        applicationState: 'SHORTLISTED', startedAt: '2026-09-20T05:00:00.000Z', lastMessageAt: '2026-09-21T05:00:00.000Z', lastFrom: 'STUDENT', messageCount: 2, unreadCount: 1 }],
      withheldCount: 1, nextCursor: null,
    } });
    routes[`GET ${base}/applications/${applicationId}/messages`] = () => ({ body: { conversation: {
      applicationId, applicationState: 'SHORTLISTED', title: 'Robotics engineer', started: true, startedAt: '2026-09-20T05:00:00.000Z',
      canSend: true, sendBlockedReason: null, hasEarlier: false,
      messages: [
        { id: 'm1', from: 'EMPLOYER', mine: true, body: 'Can you join on Friday?', containsLink: false, sentAt: '2026-09-20T05:00:00.000Z', readAt: '2026-09-20T06:00:00.000Z', erased: false },
        { id: 'm2', from: 'STUDENT', mine: false, body: 'Yes. My portfolio is at www.example.org', containsLink: true, sentAt: '2026-09-21T05:00:00.000Z', readAt: null, erased: false },
      ],
    } } });
    routes[`POST ${base}/applications/${applicationId}/messages`] = () => ({ status: 201, body: { message: { id: 'm3' } } });
    render(<EmployerRecruiterRealityPage portal={portal} routeLabel="Messages" />);

    expect(await screen.findByText(/Synthetic Candidate · Robotics engineer \(ROB-7\)/)).toBeInTheDocument();
    expect(screen.getByText('1 unread')).toBeInTheDocument();
    expect(screen.getByText(/1 conversation is closed because the candidate no longer shares their details/)).toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const log = await screen.findByRole('log', { name: 'Messages' });
    expect(within(log).getByText('Can you join on Friday?')).toBeInTheDocument();
    expect(within(log).getByText(/Read /)).toBeInTheDocument();
    // Plain text, never a link, and flagged.
    expect(within(log).getByText('Yes. My portfolio is at www.example.org')).toBeInTheDocument();
    expect(within(log).queryByRole('link')).toBeNull();
    expect(within(log).getByText(/Contains a link/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: '  See you Friday.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posted()).toEqual([{ path: `${base}/applications/${applicationId}/messages`, body: { body: 'See you Friday.' } }]));
    expect(await screen.findByText('Message sent.')).toBeInTheDocument();
  });

  it('says so plainly when there are no conversations yet', async () => {
    routes[`GET ${base}/message-threads`] = () => ({ body: { threads: [], withheldCount: 0, nextCursor: null } });
    render(<EmployerRecruiterRealityPage portal={portal} routeLabel="Messages" />);
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });

  it('explains why the composer is closed, and a closed conversation with its reference', async () => {
    routes[`GET ${base}/applications/${applicationId}/messages`] = () => ({ body: { conversation: {
      applicationId, applicationState: 'APPLIED', title: 'Robotics engineer', started: false, startedAt: null,
      canSend: false, sendBlockedReason: 'NOT_SHORTLISTED', hasEarlier: false, messages: [] } } });
    render(<EmployerConversationPanel employerId={employerId} applicationId={applicationId} candidateName="Synthetic Candidate" />);
    expect(await screen.findByText('You can message a candidate once you shortlist them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    cleanup();

    routes[`GET ${base}/applications/${applicationId}/messages`] = () => ({ status: 403, body: { error: { code: 'FORBIDDEN', correlationId: 'corr-10' } } });
    render(<EmployerConversationPanel employerId={employerId} applicationId={applicationId} />);
    expect(await screen.findByText('This candidate no longer shares their details with you, so the conversation is closed. (reference corr-10)')).toBeInTheDocument();
  });

  it('keeps the recruiter navigation labels exactly as they were', () => {
    const labels = portal.nav.map((item) => item.label);
    expect(labels).toEqual(['Dashboard', 'Opportunities', 'Opportunity Detail', 'Applicants', 'Candidate Detail', 'Assessments', 'Interviews', 'Talent Pool', 'Offers',
      'Reports', 'Team', 'Messages', 'Company Profile', 'Settings', 'Help & FAQ']);
  });
});

describe('EMP-10 student conversation', () => {
  const conversation = (overrides: Record<string, unknown> = {}) => ({ conversation: {
    applicationId, employerName: 'Acme Robotics', title: 'Robotics engineer', started: true, startedAt: '2026-09-20T05:00:00.000Z',
    muted: false, canReply: true, replyBlockedReason: null, hasEarlier: false,
    messages: [employerMessage(), { id: 'mine', from: 'STUDENT', mine: true, body: 'Why?', containsLink: false, sentAt: '2026-09-20T06:00:00.000Z', readAt: null, erased: false, reportedAt: null }],
    ...overrides,
  } });

  it('shows the thread as plain text with a warning on links, and lets the student reply, mute and report', async () => {
    routes[`GET /api/v1/students/me/applications/${applicationId}/messages`] = () => ({ body: conversation() });
    routes[`POST /api/v1/students/me/applications/${applicationId}/messages`] = () => ({ status: 201, body: { message: { id: 'r' } } });
    routes[`POST /api/v1/students/me/applications/${applicationId}/messages/mute`] = () => ({ status: 201, body: { conversation: { applicationId, muted: true } } });
    routes[`POST /api/v1/students/me/applications/${applicationId}/messages/${messageId}/report`] = () => ({ status: 201, body: { report: { messageId, reportedAt: '2026-09-21T00:00:00.000Z' } } });
    render(<StudentConversationCard applicationId={applicationId} onClose={() => undefined} />);

    const log = await screen.findByRole('log', { name: 'Messages' });
    expect(within(log).getByText('Please pay the fee at https://pay.example.test/now')).toBeInTheDocument();
    expect(within(log).queryByRole('link')).toBeNull();
    expect(within(log).getByText('Contains a link. ONE does not check links — never pay a fee or share a password.')).toBeInTheDocument();
    // The student never learns which recruiter wrote; the company is named.
    expect(within(log).getByText(/^Acme Robotics · /)).toBeInTheDocument();
    // Only the employer's message can be reported.
    expect(within(log).getAllByRole('button', { name: 'Report' })).toHaveLength(1);

    fireEvent.change(screen.getByLabelText('Reply'), { target: { value: 'I will not pay.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(posted()).toContainEqual({ path: `/api/v1/students/me/applications/${applicationId}/messages`, body: { body: 'I will not pay.' } }));

    fireEvent.click(await screen.findByRole('button', { name: 'Mute notifications' }));
    expect(await screen.findByText('Muted. Messages still arrive here, but you will not be notified.')).toBeInTheDocument();
    expect(posted()).toContainEqual({ path: `/api/v1/students/me/applications/${applicationId}/messages/mute`, body: { muted: true } });

    fireEvent.click(within(await screen.findByRole('log', { name: 'Messages' })).getByRole('button', { name: 'Report' }));
    const form = screen.getByRole('form', { name: 'Report this message' });
    fireEvent.change(within(form).getByLabelText('What is wrong?'), { target: { value: 'SCAM_OR_PAYMENT_REQUEST' } });
    fireEvent.change(within(form).getByLabelText(/Anything else/), { target: { value: 'They want a deposit.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(posted()).toContainEqual({ path: `/api/v1/students/me/applications/${applicationId}/messages/${messageId}/report`,
      body: { reasonCode: 'SCAM_OR_PAYMENT_REQUEST', statement: 'They want a deposit.' } }));
    expect(await screen.findByText(/Reported\. The ONE trust and safety team will review it/)).toBeInTheDocument();
  });

  it('is read-only once the application has ended, and says when nothing has started', async () => {
    routes[`GET /api/v1/students/me/applications/${applicationId}/messages`] = () => ({ body: conversation({ canReply: false, replyBlockedReason: 'ACCESS_ENDED',
      messages: [employerMessage({ body: null, erased: true, containsLink: false })] }) });
    render(<StudentConversationCard applicationId={applicationId} onClose={() => undefined} />);
    expect(await screen.findByText('This message was erased.')).toBeInTheDocument();
    expect(screen.getByText(/you can read this conversation but not reply/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Reply')).toBeNull();
    cleanup();

    routes[`GET /api/v1/students/me/applications/${applicationId}/messages`] = () => ({ body: conversation({ started: false, canReply: false, replyBlockedReason: 'NOT_STARTED', messages: [] }) });
    render(<StudentConversationCard applicationId={applicationId} onClose={() => undefined} />);
    expect(await screen.findByText(/Acme Robotics has not started a conversation/)).toBeInTheDocument();
  });

  it('opens from My applications with the unread count, and not before a conversation exists', async () => {
    const row = (id: string, overrides: Record<string, unknown>) => ({ id, state: 'SHORTLISTED', opportunityId: 'o', employerName: 'Acme Robotics', title: 'Role ' + id.slice(0, 1),
      employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: null, submittedAt: '2026-09-01T00:00:00Z', closedAt: null, consentRevokedAt: null,
      institutionVisibilityGrantedAt: null, institutionVisibilityRevokedAt: null, updatedAt: '2026-09-01T00:00:00Z', termsAcknowledgementPending: false,
      feedbackReleased: false, ...overrides });
    routes['GET /api/v1/students/me/applications'] = () => ({ body: { applications: [
      row(applicationId, { conversationStarted: true, unreadMessages: 2 }), row('99999999-9999-4999-8999-999999999999', { conversationStarted: false, unreadMessages: 0 }),
    ] } });
    routes['GET /api/v1/students/me/interviews'] = () => ({ body: { interviews: [] } });
    routes['GET /api/v1/students/me/offers'] = () => ({ body: { offers: [] } });
    routes['GET /api/v1/students/me/external-applications'] = () => ({ body: { externalApplications: [], total: 0, offset: 0, limit: 50 } });
    routes[`GET /api/v1/students/me/applications/${applicationId}/messages`] = () => ({ body: conversation() });
    render(<StudentApplicationsPage />);
    const open = await screen.findByRole('button', { name: 'Messages for Role 2' });
    expect(open).toHaveTextContent('Messages (2 new)');
    expect(screen.getByText('None yet')).toBeInTheDocument();
    fireEvent.click(open);
    expect(await screen.findByRole('log', { name: 'Messages' })).toBeInTheDocument();
  });
});
