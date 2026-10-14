/**
 * The employer Team screen (EMP-02).
 *
 * The "Team" label in the employer navigation said "Not built yet" until the team API
 * existed. These tests render it through the real route dispatcher for the label, with the
 * API stubbed at fetch, and check that it shows only what the server returned, offers only
 * the roles the server says the actor may invite, asks for confirmation and a reason before
 * any change, and reports errors and email delivery plainly.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import type { EmployerTeamDto } from '../api/hiring.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './employer.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));

const employerId = crypto.randomUUID();
const ownerMembershipId = crypto.randomUUID();
const recruiterMembershipId = crypto.randomUUID();
const invitationId = crypto.randomUUID();
const portal = rolePortals.find((item) => item.key === 'recruiter') ?? rolePortals[0]!;
const base = `/api/v1/employers/${employerId}`;

function teamFor(actorRole: 'EMPLOYER_OWNER' | 'EMPLOYER_ADMIN'): EmployerTeamDto {
  return {
    actorRole,
    invitableRoles: actorRole === 'EMPLOYER_OWNER' ? ['EMPLOYER_ADMIN', 'RECRUITER'] : ['RECRUITER'],
    deliveryConfigured: false,
    members: [
      { membershipId: ownerMembershipId, email: 'owner@example.test', role: 'EMPLOYER_OWNER', state: 'ACTIVE', since: '2026-09-01T00:00:00Z', isSelf: actorRole === 'EMPLOYER_OWNER', canEnd: false },
      { membershipId: recruiterMembershipId, email: 'recruiter@example.test', role: 'RECRUITER', state: 'ACTIVE', since: '2026-09-02T00:00:00Z', isSelf: false, canEnd: true },
    ],
    nextCursor: null,
    invitations: [
      { id: invitationId, email: 'pending.person@example.test', role: 'RECRUITER', state: 'PENDING', createdAt: '2026-09-20T00:00:00Z', expiresAt: '2026-10-04T00:00:00Z',
        delivery: { state: 'NOT_CONFIGURED', sendCount: 0, lastSentAt: null }, canRevoke: true, canResend: true },
    ],
    invitationsTruncated: false,
    reasonCodes: { revoke: ['SENT_IN_ERROR', 'WRONG_EMAIL'], resend: ['NOT_RECEIVED', 'LINK_EXPIRED'], end: ['LEFT_ORGANISATION', 'SECURITY_CONCERN'] },
  };
}

let team: EmployerTeamDto;
let role: string;
let failWith: { status: number; body: unknown } | null;

beforeEach(() => {
  const session = crypto.randomUUID();
  role = 'EMPLOYER_OWNER';
  team = teamFor('EMPLOYER_OWNER');
  failWith = null;
  vi.mocked(getProtectedAccessToken).mockReturnValue(session);
  vi.mocked(getSecurityContext).mockImplementation(async () => ({ userId: crypto.randomUUID(), memberships: [
    { organizationId: employerId, role, scope: { organizationId: employerId, employerId } },
  ] }) as unknown as Awaited<ReturnType<typeof getSecurityContext>>);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, window.location.origin).pathname;
    if (init?.method === 'POST' && failWith) return response(failWith.body, failWith.status);
    if (path === `${base}/team` && init?.method !== 'POST') return response({ team });
    if (path === `${base}/team-invitations` && init?.method === 'POST') return response({ invitation: { id: crypto.randomUUID(), delivery: { state: 'NOT_CONFIGURED' } } }, 201);
    if (path === `${base}/team-invitations/${invitationId}/resend`) return response({ invitation: { id: invitationId, delivery: { state: 'SENT' } } }, 201);
    if (path === `${base}/team-invitations/${invitationId}/revoke`) return response({ invitation: { id: invitationId, state: 'REVOKED' } }, 201);
    if (path === `${base}/team/${recruiterMembershipId}/end`) return response({ member: { membershipId: recruiterMembershipId, state: 'ENDED' } }, 201);
    throw new Error('Unexpected endpoint ' + path);
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function response(body: unknown, status = 200) { return { ok: status < 400, status, json: async () => body, headers: new Headers() }; }
function show() { return render(<EmployerRecruiterRealityPage portal={portal} routeLabel="Team" />); }
function posts() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({ path: new URL(String(url), window.location.origin).pathname, body: JSON.parse(String(init!.body)) as unknown }));
}

describe('EMP-02 employer Team screen', () => {
  it('shows the real members and invitations, with honest delivery, and no internal identifiers', async () => {
    show();
    expect(await screen.findByText('recruiter@example.test')).toBeInTheDocument();
    expect(screen.getByText('owner@example.test (you)')).toBeInTheDocument();
    expect(screen.getByText('pending.person@example.test')).toBeInTheDocument();
    expect(screen.getByText('Not emailed — email delivery is not set up yet')).toBeInTheDocument();
    expect(screen.getByText('Not set up')).toBeInTheDocument();
    expect(screen.queryByText('Not built yet')).not.toBeInTheDocument();
    for (const id of [employerId, ownerMembershipId, recruiterMembershipId, invitationId]) expect(document.body.textContent).not.toContain(id);
    // The last owner has no end action; the server said canEnd: false.
    const ownerRow = screen.getByText('owner@example.test (you)').closest('tr')!;
    expect(within(ownerRow).queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers an owner admin and recruiter, and says an invitation was not emailed when delivery is not set up', async () => {
    show();
    const select = await screen.findByLabelText('Role *');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Admin', 'Recruiter']);
    expect(select).toHaveValue('RECRUITER');
    fireEvent.change(screen.getByLabelText('Work email *'), { target: { value: ' new.person@example.test ' } });
    fireEvent.change(select, { target: { value: 'EMPLOYER_ADMIN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('Invitation created, but not emailed: email delivery is not set up yet.')).toBeInTheDocument();
    expect(posts()).toEqual([{ path: `${base}/team-invitations`, body: { email: 'new.person@example.test', role: 'EMPLOYER_ADMIN' } }]);
  });

  it('offers an admin recruiters only', async () => {
    role = 'EMPLOYER_ADMIN'; team = teamFor('EMPLOYER_ADMIN');
    show();
    const select = await screen.findByLabelText('Role *');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Recruiter']);
    expect(screen.getByText('As an admin you can invite recruiters. Your owner invites admins.')).toBeInTheDocument();
  });

  it('tells a recruiter Team is managed by the owner or admin and never calls the team API', async () => {
    role = 'RECRUITER';
    show();
    expect(await screen.findByText('Managed by your owner or admin')).toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('ends a membership only after confirmation with a reason', async () => {
    show();
    const row = (await screen.findByText('recruiter@example.test')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'End membership' }));
    const confirm = screen.getByRole('form', { name: 'Confirm team change' });
    expect(within(confirm).getByText("End recruiter@example.test's membership?")).toBeInTheDocument();
    expect(within(confirm).getByRole('button', { name: 'End membership' })).toBeDisabled();
    expect(posts()).toEqual([]);
    fireEvent.change(within(confirm).getByLabelText('Reason *'), { target: { value: 'LEFT_ORGANISATION' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'End membership' }));
    expect(await screen.findByText('recruiter@example.test no longer has access. Their past actions stay in the audit record.')).toBeInTheDocument();
    expect(posts()).toEqual([{ path: `${base}/team/${recruiterMembershipId}/end`, body: { reasonCode: 'LEFT_ORGANISATION' } }]);
  });

  it('cancels a change without calling the API', async () => {
    show();
    const row = (await screen.findByText('pending.person@example.test')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Confirm team change' })).not.toBeInTheDocument();
    expect(posts()).toEqual([]);
  });

  it('revokes and resends an invitation with a reason', async () => {
    show();
    let row = (await screen.findByText('pending.person@example.test')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Resend' }));
    let confirm = screen.getByRole('form', { name: 'Confirm team change' });
    fireEvent.change(within(confirm).getByLabelText('Reason *'), { target: { value: 'NOT_RECEIVED' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Resend invitation' }));
    expect(await screen.findByText('Invitation emailed. The earlier link no longer works.')).toBeInTheDocument();
    row = (await screen.findByText('pending.person@example.test')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    confirm = screen.getByRole('form', { name: 'Confirm team change' });
    fireEvent.change(within(confirm).getByLabelText('Reason *'), { target: { value: 'WRONG_EMAIL' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke invitation' }));
    expect(await screen.findByText('The invitation to pending.person@example.test was revoked. Its link no longer works.')).toBeInTheDocument();
    expect(posts()).toEqual([
      { path: `${base}/team-invitations/${invitationId}/resend`, body: { reasonCode: 'NOT_RECEIVED' } },
      { path: `${base}/team-invitations/${invitationId}/revoke`, body: { reasonCode: 'WRONG_EMAIL' } },
    ]);
  });

  it('explains a refusal plainly with its reference and never shows upstream text', async () => {
    const correlationId = crypto.randomUUID();
    failWith = { status: 409, body: { error: { code: 'TEAM_MEMBER_ALREADY_EXISTS', message: 'duplicate key value violates unique constraint', correlationId } } };
    show();
    fireEvent.change(await screen.findByLabelText('Work email *'), { target: { value: 'recruiter@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This person is already on your team.');
    expect(alert).toHaveTextContent(`Support code: ${correlationId.slice(0, 8)}`);
    expect(alert).not.toHaveTextContent(correlationId);
    expect(document.body.textContent).not.toContain('duplicate key');
  });

  it('shows a plain error when the team cannot be loaded, and an empty state when nobody is invited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'EMPLOYER_ORGANISATION_INACTIVE', message: 'Access denied', correlationId: 'corr-team-load-1' } }, 403)));
    const { unmount } = show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your employer account is suspended or was not approved');
    unmount();
    team = { ...teamFor('EMPLOYER_OWNER'), invitations: [] };
    vi.stubGlobal('fetch', vi.fn(async () => response({ team })));
    show();
    expect(await screen.findByText('No pending invitations.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('recruiter@example.test')).toBeInTheDocument());
  });
});
