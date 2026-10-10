/**
 * Student activation on the institution screens (INST-01): the Students page shows each
 * student's invitation state and can resend with a reason, and the Dashboard's activation
 * counts come from the same server summary as the list.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { InstitutionAdminHome } from './institutionHomes.js';
import { InstitutionStudentsPage } from './institution.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));
const institutionId = crypto.randomUUID();
const invitedUser = crypto.randomUUID();
const activatedUser = crypto.randomUUID();
const fetchMock = vi.fn();
const response = (body: unknown) => ({ ok: true, json: async () => body });
const summary = { ACTIVATED: 1, INVITED: 1, EXPIRED: 0, BOUNCED: 0, NOT_INVITED: 0 };
const roster = {
  students: [
    { id: crypto.randomUUID(), studentUserId: invitedUser, institutionId, institutionStudentId: 'S-1', fullName: 'Waiting Student', email: 'waiting@example.test', status: 'INVITED',
      units: {}, activation: { state: 'INVITED', deliveryState: 'NOT_CONFIGURED', invitedAt: null, expiresAt: null, lastSentAt: null } },
    { id: crypto.randomUUID(), studentUserId: activatedUser, institutionId, institutionStudentId: 'S-2', fullName: 'Active Student', email: 'active@example.test', status: 'ACTIVE',
      units: {}, activation: { state: 'ACTIVATED', deliveryState: 'SENT', invitedAt: null, expiresAt: null, lastSentAt: null } },
  ],
  activationSummary: summary,
};

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/student-invitations/resend')) return Promise.resolve(response({ resend: { queued: 1, skipped: 0 } }));
    if (url.includes('/units')) return Promise.resolve(response({ units: [] }));
    if (url.includes('/assessments')) return Promise.resolve(response({ assessments: [] }));
    if (url.includes('/students') && (!init?.method || init.method === 'GET')) return Promise.resolve(response(roster));
    return Promise.resolve(response({}));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Students page activation', () => {
  const portal = rolePortals.find((item) => item.key === 'institution-admin')!;
  const page = () => <InstitutionStudentsPage portal={portal} authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} />;

  it('shows each student activation state, says plainly when no email was sent, and offers resend only to those waiting', async () => {
    render(page());
    const waiting = (await screen.findByText('Waiting Student')).closest('tr')!;
    // The relationship state and the invitation state both read in words, never as codes.
    expect(within(waiting).getAllByText('Invited')).toHaveLength(2);
    expect(within(waiting).getByText('Email not sent: no sender is set up yet')).toBeInTheDocument();
    expect(within(waiting).getByRole('button', { name: 'Resend invitation' })).toBeInTheDocument();
    const active = screen.getByText('Active Student').closest('tr')!;
    expect(within(active).getByText('Activated')).toBeInTheDocument();
    expect(within(active).queryByRole('button', { name: 'Resend invitation' })).not.toBeInTheDocument();
  });

  it('resends one invitation with the chosen reason code', async () => {
    render(page());
    const waiting = (await screen.findByText('Waiting Student')).closest('tr')!;
    fireEvent.change(screen.getByLabelText('Reason for resending'), { target: { value: 'EMAIL_CORRECTED' } });
    fireEvent.click(within(waiting).getByRole('button', { name: 'Resend invitation' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 invitation queued to send.'));
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/student-invitations/resend'))!;
    expect(JSON.parse(String(call[1].body))).toEqual({ reasonCode: 'EMAIL_CORRECTED', studentUserIds: [invitedUser] });
  });

  it('resends to everyone not yet activated in one action', async () => {
    render(page());
    await screen.findByText('Waiting Student');
    fireEvent.click(screen.getByRole('button', { name: 'Resend to all students not yet activated' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/student-invitations/resend'))).toBe(true));
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/student-invitations/resend'))!;
    expect(JSON.parse(String(call[1].body))).toEqual({ reasonCode: 'NOT_RECEIVED', all: true });
  });
});

describe('Dashboard activation counts', () => {
  const home = () => <InstitutionAdminHome authenticatedWorkspace={{ organizationId: institutionId, role: 'INSTITUTION_ADMIN' }} basePath="/institution/admin" title="Institution Administration" />;

  it('shows the server summary the Students list is built from, every group under five as <5 with no bar', async () => {
    render(home());
    const card = (await screen.findByRole('heading', { name: 'Student activation' })).closest('section')!;
    expect(within(card).getByText('Activated', { selector: 'dt' }).parentElement).toHaveTextContent('Activated<5');
    expect(within(card).getByText('Invited', { selector: 'dt' }).parentElement).toHaveTextContent('Invited<5');
    expect(within(card).getByText('Bounced', { selector: 'dt' }).parentElement).toHaveTextContent('Bounced<5');
    expect(card.querySelector('.ih-abar')).toBeNull();
  });

  it('shows larger groups exactly, and turns them into ranges when a small group could be worked out from the roster total', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.includes('/students') ? { ...roster, activationSummary: { ACTIVATED: 32, INVITED: 0, EXPIRED: 0, BOUNCED: 0, NOT_INVITED: 1 } } : {})));
    render(home());
    const card = (await screen.findByRole('heading', { name: 'Student activation' })).closest('section')!;
    // 33 on the roster, 32 activated: an exact 32 would reveal the one student not invited.
    expect(within(card).getByText('Activated', { selector: 'dt' }).parentElement).toHaveTextContent('Activated30–34');
    expect(within(card).getByText('Not invited', { selector: 'dt' }).parentElement).toHaveTextContent('Not invited<5');
    expect(card).not.toHaveTextContent(/32/);
    expect(card.querySelector('.ih-abar')).toBeNull();
  });

  it('leaves the card out, never NA or zero, when the roster cannot be loaded', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.includes('/students') ? { ok: false, status: 500, json: async () => ({}) } : response(url.includes('/units') ? { units: [] } : { assessments: [] })));
    render(home());
    await waitFor(() => expect(screen.queryByText('Loading your institution…')).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Student activation' })).not.toBeInTheDocument();
    expect(screen.queryByText(/NA/)).not.toBeInTheDocument();
  });
});
