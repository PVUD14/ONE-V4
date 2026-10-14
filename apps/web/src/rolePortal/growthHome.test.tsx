/**
 * The Growth Home (re-skin phase 7): its figures come from the person's own workspace, field log,
 * leads and territory; the leads board follows the lead vocabulary's stage order; a block whose
 * read fails is left out; nothing prints "NA"; and the target, streak and commission blocks of the
 * approved page, which have no source yet, are not drawn at all.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { GrowthHome } from './growthHome.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() });
const today = new Date().toISOString().slice(0, 10);

const lead = (id: string, name: string, stage: string) => ({
  id, kind: 'COLLEGE', name, area: { stateCode: 'IN-KA', stateName: 'Karnataka', districtCode: 1, districtName: 'Mysuru', city: null },
  aisheCode: null, websiteDomain: null, owner: { email: null, isMe: true }, needsNewOwner: false, stage, lostReasonCode: null, source: 'INBOUND',
  possibleDuplicate: false, doNotContact: null, handedOff: false, liveContacts: 1, createdAt: null, lastActivityAt: null, stale: false, version: 1,
});

function routes(options: { leadsStatus?: number } = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url, window.location.origin).pathname;
    if (path === '/api/v1/growth/me') return ok({ role: 'GROWTH_EXECUTIVE', staffType: 'EMPLOYEE', openLeads: 3, visitsThisMonth: 6, followUpsDue: 1, teams: [], correlationId: 'c' });
    if (path === '/api/v1/growth/field') {
      return ok({ view: 'MINE', canSeeTeam: false, today,
        counts: { visitsThisMonth: 6, activitiesThisMonth: 8, metThisMonth: 5, followUpsOverdue: 1, followUpsDueToday: 0, followUpsOpen: 1 },
        followUps: [{ id: 'f1', leadId: 'l1', leadName: 'Synthetic Polytechnic', leadKind: 'COLLEGE', title: 'Send the pricing note', titleErased: false, dueOn: today, state: 'OPEN', overdue: true, dueToday: false,
          assignee: { email: 'me@uat.example.test', isMe: true }, activityId: null, createdAt: null, closedAt: null, cancelReasonCode: null }],
        activities: [], vocabulary: {} });
    }
    if (path === '/api/v1/growth/leads') {
      return options.leadsStatus ? ok({ error: { code: 'FAILED', correlationId: 'corr-leads' } }, options.leadsStatus)
        : ok({ leads: [lead('l1', 'Synthetic Polytechnic', 'CONTACTED'), lead('l2', 'Sample Arts College', 'NEW'), lead('l3', 'Placeholder Institute', 'CONTACTED')], nextCursor: null });
    }
    if (path === '/api/v1/growth/leads/vocabulary') return ok({ kinds: ['COLLEGE'], stages: { COLLEGE: ['NEW', 'CONTACTED', 'DEMO', 'WON', 'LOST'], EMPLOYER: ['NEW'] }, sources: [], contactRoles: [], contactSourcesByBasis: {}, reasons: {}, contactLimit: 5, purpose: '', notice: { version: '', status: '', text: [] } });
    if (path === '/api/v1/growth/territory') {
      return ok({ role: 'GROWTH_EXECUTIVE', correlationId: 'c', regions: [{ id: 'r1', name: 'South-1', myRole: 'EXECUTIVE', since: null,
        areas: [{ stateCode: 'IN-KA', stateName: 'Karnataka', districtCode: 1, districtName: 'Mysuru' }], people: [], unownedLeads: 0 }] });
    }
    return ok({ error: { code: 'NOT_FOUND', correlationId: 'x' } }, 404);
  });
}

beforeEach(() => {
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const naPattern = /(^|[^A-Za-z])NA([^A-Za-z]|$)/;

describe('the Growth Home', () => {
  it('draws the hero, figures, leads board, field and territory from real reads, and no NA', async () => {
    routes();
    render(<GrowthHome />);
    const stats = await screen.findByLabelText('Growth summary');
    expect(within(stats).getByText('Open leads').parentElement).toHaveTextContent('3');
    expect(within(stats).getByText('Visits this month').parentElement).toHaveTextContent('6');
    expect(within(stats).getByText('Follow-ups due').parentElement).toHaveTextContent('1');
    expect(within(stats).getByText('Unowned leads').parentElement).toHaveTextContent('0');
    expect(screen.getByRole('banner', { name: /Good (morning|afternoon|evening)/ })).toHaveTextContent('You own 3 open leads.');
    // The board follows the vocabulary's order and leaves the closed stages off.
    const board = screen.getByRole('list', { name: 'Your open leads by stage' });
    expect(within(board).getAllByRole('listitem').map((column) => column.getAttribute('aria-label'))).toEqual(['New: 1', 'Contacted: 2', 'Demo: 0']);
    expect(within(screen.getByRole('heading', { name: 'Field this week' }).closest('section')!).getByText('Send the pricing note')).toBeInTheDocument();
    expect(screen.getByText('No unassigned leads')).toBeInTheDocument();
    for (const heading of ['Targets vs achieved', 'Commission', 'Demos']) expect(screen.queryByRole('heading', { name: heading })).toBeNull();
    expect(document.body.textContent).not.toMatch(/streak/i);
    expect(document.body.textContent).not.toMatch(naPattern);
  });

  it('leaves the leads board out when the leads cannot be read, and still prints no NA', async () => {
    routes({ leadsStatus: 500 });
    render(<GrowthHome />);
    await screen.findByLabelText('Growth summary');
    expect(screen.queryByRole('heading', { name: 'Leads pipeline' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Field this week' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(naPattern);
  });
});
