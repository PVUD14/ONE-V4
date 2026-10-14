/**
 * Operations → Settings → Growth team (GROWTH-01): a GROWTH_ADMIN holder invites growth
 * people with a required staff type, sets team and manager, changes the type with a reason,
 * and ends a membership; an operator without GROWTH_ADMIN sees nothing of it. No
 * navigation item is added: this is a section of Settings.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsGrowthTeamPanel } from './growthTeam.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const executiveId = crypto.randomUUID();
const managerId = crypto.randomUUID();
const directory = () => ({
  members: [
    { membershipId: executiveId, email: 'field.person@example.test', role: 'GROWTH_EXECUTIVE', state: 'ACTIVE', joinedAt: '2026-09-30T10:00:00.000Z', isSelf: false,
      staffType: { staffType: 'EMPLOYEE', effectiveFrom: '2026-09-30T10:00:00.000Z' },
      teams: [{ team: 'COLLEGE_PARTNERSHIPS', joinedAt: '2026-09-30T10:00:00.000Z', reasonCode: 'NEW_MEMBER', manager: { membershipId: managerId, email: 'region.manager@example.test' } }] },
    { membershipId: managerId, email: 'region.manager@example.test', role: 'GROWTH_MANAGER', state: 'ACTIVE', joinedAt: '2026-09-29T10:00:00.000Z', isSelf: false,
      staffType: null, teams: [] },
  ],
  invitations: [{ id: crypto.randomUUID(), email: 'pending.person@example.test', role: 'GROWTH_MANAGER', staffType: 'CONTRACTOR', createdAt: '2026-09-30T09:00:00.000Z', expiresAt: '2026-10-14T09:00:00.000Z', delivery: { state: 'NOT_CONFIGURED' } }],
  truncated: false,
  managers: [{ membershipId: managerId, email: 'region.manager@example.test' }],
  vocabulary: {
    roles: ['GROWTH_EXECUTIVE', 'GROWTH_MANAGER'], teams: ['COLLEGE_PARTNERSHIPS', 'EMPLOYER_PARTNERSHIPS'], staffTypes: ['EMPLOYEE', 'CONTRACTOR'],
    reasons: {
      joinTeam: ['NEW_MEMBER', 'TEAM_CHANGE', 'MANAGER_CHANGE', 'CORRECTION'], leaveTeam: ['LEFT_TEAM', 'TEAM_CHANGE', 'CORRECTION'],
      endMembership: ['LEFT_AI8HT', 'ACCESS_NO_LONGER_NEEDED', 'SECURITY_CONCERN', 'CORRECTION'], revokeInvitation: ['SENT_IN_ERROR', 'WRONG_EMAIL', 'NO_LONGER_NEEDED'],
      initialStaffType: ['INITIAL_TYPE'], changeStaffType: ['ENGAGEMENT_CHANGED', 'CORRECTION'],
    },
  },
  correlationId: 'corr-list',
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string) => Promise.resolve({ ok: false, status, json: async () => ({ error: { code, correlationId: 'corr-fail' } }), headers: new Headers() });
let listResponse: () => Promise<unknown>;

beforeEach(() => {
  listResponse = () => ok(directory());
  vi.mocked(getProtectedAccessToken).mockReturnValue('ops-token');
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return ok({ member: directory().members[0], invitation: { id: crypto.randomUUID(), state: 'PENDING', delivery: { state: 'SENT' } }, correlationId: 'corr-post' });
    if (String(url).endsWith('/api/v1/operations/growth-team')) return listResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> }));

describe('Growth team section', () => {
  it('lists growth people with their type, team and manager, and pending invitations', async () => {
    render(<OperationsGrowthTeamPanel />);
    expect(await screen.findByRole('heading', { name: 'Growth team' })).toBeInTheDocument();
    const person = screen.getByRole('article', { name: 'field.person@example.test' });
    expect(within(person).getByText('Growth executive')).toBeInTheDocument();
    expect(within(person).getByText('Employee')).toBeInTheDocument();
    expect(within(person).getByText(/College partnerships — manager region\.manager@example\.test/)).toBeInTheDocument();
    const manager = screen.getByRole('article', { name: 'region.manager@example.test' });
    expect(within(manager).getByText('Staff type not set')).toBeInTheDocument();
    expect(screen.getByText('pending.person@example.test')).toBeInTheDocument();
    expect(screen.queryByText(/tax|TDS|GST/i)).not.toBeInTheDocument();
  });

  it('will not send an invitation until a staff type is chosen, and sends the type with it', async () => {
    render(<OperationsGrowthTeamPanel />);
    await screen.findByRole('heading', { name: 'Growth team' });
    fireEvent.change(screen.getByLabelText('Invitee email'), { target: { value: 'new.person@example.test' } });
    fireEvent.change(screen.getByLabelText('Growth role'), { target: { value: 'GROWTH_EXECUTIVE' } });
    const send = screen.getByRole('button', { name: 'Send growth invitation' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Staff type'), { target: { value: 'CONTRACTOR' } });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ url: expect.stringMatching(/\/api\/v1\/operations\/growth-team\/invitations$/), body: { email: 'new.person@example.test', role: 'GROWTH_EXECUTIVE', staffType: 'CONTRACTOR' } });
  });

  it('changes a staff type only with a reason', async () => {
    render(<OperationsGrowthTeamPanel />);
    const person = await screen.findByRole('article', { name: 'field.person@example.test' });
    fireEvent.change(within(person).getByLabelText('New staff type'), { target: { value: 'CONTRACTOR' } });
    const save = within(person).getByRole('button', { name: 'Save staff type' });
    expect(save).toBeDisabled();
    fireEvent.change(within(person).getByLabelText('Reason for the type'), { target: { value: 'ENGAGEMENT_CHANGED' } });
    fireEvent.click(save);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ url: expect.stringMatching(new RegExp(`/growth-team/${executiveId}/staff-type$`)), body: { staffType: 'CONTRACTOR', reasonCode: 'ENGAGEMENT_CHANGED' } });
  });

  it('sets a team with a manager and a reason, and ends a membership with a reason', async () => {
    render(<OperationsGrowthTeamPanel />);
    const person = await screen.findByRole('article', { name: 'field.person@example.test' });
    fireEvent.change(within(person).getByLabelText('Team'), { target: { value: 'EMPLOYER_PARTNERSHIPS' } });
    fireEvent.change(within(person).getByLabelText('Manager'), { target: { value: managerId } });
    fireEvent.change(within(person).getByLabelText('Reason for the team change'), { target: { value: 'TEAM_CHANGE' } });
    fireEvent.click(within(person).getByRole('button', { name: 'Save team' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ team: 'EMPLOYER_PARTNERSHIPS', managerMembershipId: managerId, reasonCode: 'TEAM_CHANGE' });

    const end = within(person).getByRole('button', { name: 'End membership' });
    expect(end).toBeDisabled();
    fireEvent.change(within(person).getByLabelText('Reason for ending'), { target: { value: 'LEFT_AI8HT' } });
    fireEvent.click(end);
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toEqual({ url: expect.stringMatching(new RegExp(`/growth-team/${executiveId}/end$`)), body: { reasonCode: 'LEFT_AI8HT' } });
  });

  it('shows nothing to an operator without GROWTH_ADMIN', async () => {
    listResponse = () => failure(403, 'FORBIDDEN');
    const { container } = render(<OperationsGrowthTeamPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('adds no Operations navigation item', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).not.toContain('Growth');
    expect(operations.nav.map((item) => item.label)).toContain('Settings');
  });
});
