/**
 * Cohort announcements on the web (INST-06): faculty "Messages" composes to the audiences the
 * server allows, shows sent and scheduled announcements with honest email delivery, cancels with a
 * reason, and shows the lecturer's inbox; students see announcements in their notification bell.
 * Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { RolePortal } from '../rolePortalPages.js';
import { rolePortals } from '../rolePortalConfig.js';
import { StudentNotificationsBell } from '../notificationsBell.js';
import { FacultyMessagesPage, InstitutionAnnouncementsPanel } from './institutionAnnouncements.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
vi.mock('../consentGate.js', () => ({ ConsentGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const institutionId = crypto.randomUUID();
const section = crypto.randomUUID();
const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const sentAnnouncement = {
  id: crypto.randomUUID(), title: 'Lab moved', body: 'Tomorrow the lab is in room 204.', audience: { kind: 'SECTION', unitId: section, name: 'CSE 3A' },
  channels: ['IN_APP', 'EMAIL'], state: 'SENT', senderRole: 'FACULTY_LECTURER', sentByMe: true, scheduledFor: '2026-09-20T10:00:00Z',
  sentAt: '2026-09-20T10:00:05Z', cancelledAt: null, cancelReasonCode: null, createdAt: '2026-09-20T10:00:00Z',
  delivery: { recipients: 42, email: { sent: 0, notConfigured: 40, failed: 0, bounced: 0, skipped: 2, pending: 0 } },
};
const scheduledAnnouncement = {
  ...sentAnnouncement, id: crypto.randomUUID(), title: 'Quiz on Monday', state: 'SCHEDULED', sentAt: null, delivery: null, channels: ['IN_APP'],
};
const listing = {
  announcements: [scheduledAnnouncement, sentAnnouncement], nextCursor: null, canSend: true, emailConfigured: false, dailyLimit: 20,
  audiences: [{ unitId: section, kind: 'SECTION', name: 'CSE 3A' }],
};
const inbox = { notifications: [{ id: crypto.randomUUID(), kind: 'SYSTEM', title: 'Welcome', body: 'Your staff account is ready.', data: {}, createdAt: '2026-09-01T00:00:00Z', readAt: null }], unreadCount: 1 };

function route(url: string, init?: { method?: string }) {
  if (url.includes('/me/notifications')) return Promise.resolve(ok(inbox));
  if (init?.method === 'POST' && url.endsWith('/cancel')) return Promise.resolve(ok({ announcement: { ...scheduledAnnouncement, state: 'CANCELLED' } }));
  if (init?.method === 'POST') return Promise.resolve(ok({ announcement: scheduledAnnouncement }));
  return Promise.resolve(ok(listing));
}
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('faculty Messages', () => {
  const page = () => <FacultyMessagesPage authenticatedWorkspace={{ organizationId: institutionId, role: 'FACULTY_LECTURER' }} />;

  it('lists sent and scheduled announcements with honest email delivery, and the inbox', async () => {
    fetchMock.mockImplementation(route);
    render(page());
    const row = (await screen.findByText('Lab moved')).closest('tr')!;
    expect(within(row).getByText('Section: CSE 3A')).toBeInTheDocument();
    expect(within(row).getByText('42')).toBeInTheDocument();
    expect(within(row).getByText(/40 not sent: no sender is set up yet/)).toBeInTheDocument();
    expect(within(row).queryByText(/40 sent/)).not.toBeInTheDocument();
    expect(within(screen.getByText('Quiz on Monday').closest('tr')!).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(await screen.findByText(/Your staff account is ready/)).toBeInTheDocument();
    expect(screen.getByText('Not set up')).toBeInTheDocument();
  });

  it('sends only to an audience the server offered, with the chosen channels', async () => {
    fetchMock.mockImplementation(route);
    render(page());
    await screen.findByText('Lab moved');
    const options = within(screen.getByLabelText('Send to')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Choose', 'Section: CSE 3A']);
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: section } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' Assignment due ' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Submit by Friday.' } });
    fireEvent.click(screen.getByLabelText('Also send by email'));
    expect(screen.getByText(/the email will be recorded as not sent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send announcement' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/institutions/' + institutionId + '/announcements');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ title: 'Assignment due', body: 'Submit by Friday.', audienceUnitId: section, channels: ['IN_APP', 'EMAIL'] });
    expect(await screen.findByText(/Announcement sent/)).toBeInTheDocument();
  });

  it('schedules for a chosen time', async () => {
    fetchMock.mockImplementation(route);
    render(page());
    await screen.findByText('Lab moved');
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: section } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Quiz' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Monday 9am.' } });
    fireEvent.click(screen.getByLabelText('Schedule for later'));
    fireEvent.change(screen.getByLabelText('Send at'), { target: { value: '2030-01-06T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule announcement' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toMatchObject({ channels: ['IN_APP'], scheduledFor: new Date('2030-01-06T09:00').toISOString() });
  });

  it('cancels a scheduled announcement with a reason code', async () => {
    fetchMock.mockImplementation(route);
    render(page());
    await screen.findByText('Quiz on Monday');
    fireEvent.change(screen.getByLabelText('Reason for cancelling'), { target: { value: 'DUPLICATE' } });
    fireEvent.click(within(screen.getByText('Quiz on Monday').closest('tr')!).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/announcements/' + scheduledAnnouncement.id + '/cancel');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'DUPLICATE' });
  });

  it('says plainly when the lecturer has nobody to address', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(ok(url.includes('/me/notifications') ? inbox : { ...listing, announcements: [], audiences: [], canSend: false })));
    render(page());
    expect(await screen.findByText(/You have no active teaching assignment right now/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Send to')).not.toBeInTheDocument();
  });

  it('shows the rate limit and forbidden refusals without upstream text', async () => {
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => init?.method === 'POST'
      ? Promise.resolve({ ok: false, status: 429, json: async () => ({ error: { code: 'ANNOUNCEMENT_RATE_LIMITED', correlationId: 'corr-1', message: 'internal detail' } }) })
      : route(url, init));
    render(page());
    await screen.findByText('Lab moved');
    fireEvent.change(screen.getByLabelText('Send to'), { target: { value: section } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send announcement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('limit of announcements for today');
    expect(screen.queryByText(/internal detail/)).not.toBeInTheDocument();
  });

  it('is what the faculty "Messages" item opens, with the navigation unchanged', async () => {
    fetchMock.mockImplementation(route);
    const portal = rolePortals.find((item) => item.key === 'faculty')!;
    expect(portal.nav.map((item) => item.label)).toEqual(['Dashboard', 'My Students', 'Student Detail', 'Academic Verification', 'Assessments', 'Assessment Detail', 'Assigned Tasks', 'Interventions', 'Learning Resources', 'Reports', 'Calendar', 'Messages', 'Profile', 'Settings', 'Help & FAQ']);
    window.history.replaceState(null, '', portal.nav.find((item) => item.label === 'Messages')!.path);
    render(<RolePortal portal={portal} apiHealth="online" authStatus={{ state: 'unconfigured' }} authNotice=""
      showDevelopmentIndicators={false} onNavigate={vi.fn()} onSignIn={vi.fn()} onSignOut={vi.fn()}
      authenticatedWorkspace={{ organizationId: institutionId, role: 'FACULTY_LECTURER' }} />);
    expect(await screen.findByText('Lab moved')).toBeInTheDocument();
    expect(screen.queryByText('View-only for your role')).not.toBeInTheDocument();
  });

  it('works for any sending role through the shared panel', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(ok({ ...listing, audiences: [{ unitId: null, kind: 'INSTITUTION', name: null }, ...listing.audiences] })));
    render(<InstitutionAnnouncementsPanel token="token" institutionId={institutionId} noAudienceNote="none" />);
    await screen.findByText('Lab moved');
    expect(within(screen.getByLabelText('Send to')).getByRole('option', { name: 'Whole institution' })).toBeInTheDocument();
  });
});

describe('student notifications', () => {
  it('shows college announcements in their own list, with who they are from', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(ok(url.includes('/me/notifications') ? {
      notifications: [
        { id: crypto.randomUUID(), kind: 'ANNOUNCEMENT', title: 'Placement drive on Friday', body: 'Bring two copies of your resume.', data: { announcementId: crypto.randomUUID(), institutionName: 'Local College', from: 'your placement office', audience: 'Local College' }, createdAt: '2026-09-20T10:00:00Z', readAt: null },
        { id: crypto.randomUUID(), kind: 'RESULT_PUBLISHED', title: 'Result published', body: 'Unit test 1', data: {}, createdAt: '2026-09-19T10:00:00Z', readAt: '2026-09-19T11:00:00Z' },
      ],
      unreadCount: 1,
    } : { assessments: [] })));
    render(<StudentNotificationsBell />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    const list = await screen.findByRole('list', { name: 'Announcements' });
    expect(within(list).getByText(/Placement drive on Friday — Bring two copies of your resume/)).toBeInTheDocument();
    expect(within(list).getByText('From your placement office · Local College')).toBeInTheDocument();
    expect(within(list).queryByText(/Result published/)).not.toBeInTheDocument();
    expect(screen.getByText(/Result published — Unit test 1/)).toBeInTheDocument();
  });
});
