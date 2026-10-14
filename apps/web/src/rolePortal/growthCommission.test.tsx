/**
 * Credit and disputes on the web (GROWTH-07): Growth → Commission shows only the server's credit,
 * with no amount shown (no rate is set) and employers on hold, the person's disputes (their own statement only)
 * and a dispute form limited to what the server says they may dispute; Operations → Settings → Growth
 * attribution decides a dispute and reassigns credit only with a reason, and shows the server's refusal.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { GrowthCommissionPage } from './growthCommission.js';
import { OperationsGrowthAttributionPanel } from './growthAttributionAdmin.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const fetchMock = vi.fn();
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ error: { code, message: 'The request could not be completed.', correlationId: 'corr' } }), headers: new Headers() });
let routes: (url: string, init?: { method?: string }) => Promise<unknown> | null;

beforeEach(() => {
  routes = () => null;
  vi.mocked(getProtectedAccessToken).mockReturnValue('token');
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => routes(String(url), init) ?? ok({}));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> }));

const mine = {
  credited: [
    { attributionId: 'a1', organizationId: 'o1', organizationName: 'Sri Venkateswara College', organizationKind: 'INSTITUTION', basis: 'LEAD_OWNER_AT_HANDOFF',
      since: '2026-09-01T00:00:00Z', endedAt: null, endedReasonCode: null, disputeOpen: true, commission: 'NOT_BUILT' },
    { attributionId: 'a2', organizationId: 'o2', organizationName: 'Northwind Labs', organizationKind: 'EMPLOYER', basis: 'REFERRAL_LINK',
      since: '2026-09-02T00:00:00Z', endedAt: null, endedReasonCode: null, disputeOpen: false, commission: 'EMPLOYER_ON_HOLD' },
    { attributionId: 'a3', organizationId: 'o3', organizationName: 'Old College', organizationKind: 'INSTITUTION', basis: 'LEAD_OWNER_AT_HANDOFF',
      since: '2026-08-01T00:00:00Z', endedAt: '2026-09-15T00:00:00Z', endedReasonCode: 'REASSIGNED', disputeOpen: false, commission: 'NOT_BUILT' },
  ],
  disputes: [
    { disputeId: 'd1', organizationId: 'o1', organizationName: 'Sri Venkateswara College', organizationKind: 'INSTITUTION', origin: 'CLAIM', state: 'OPEN',
      role: 'RESPONDENT', openedAt: '2026-09-20T00:00:00Z', decidedAt: null, decisionReasonCode: null, statement: null },
  ],
  disputable: [
    { organizationId: 'o9', organizationName: 'Riverside Institute', organizationKind: 'INSTITUTION', handedOffAt: '2026-09-10T00:00:00Z', windowEndsAt: '2026-12-09T00:00:00Z', disputeOpen: false },
  ],
  windowDays: 90,
};

describe('Growth → Commission', () => {
  it('shows the server\'s credit with no amount anywhere and employers on hold', async () => {
    routes = (url) => (url.endsWith('/api/v1/growth/attributions') ? ok(mine) : null);
    render(<GrowthCommissionPage />);
    const credited = await screen.findByLabelText('Credited to you');
    expect(within(credited).getByText('Sri Venkateswara College')).toBeInTheDocument();
    expect(within(credited).getByText('Employer commission on hold — not decided')).toBeInTheDocument();
    expect(within(credited).getByText(/Commission not built yet; no rate has been set/)).toBeInTheDocument();
    expect(within(credited).getByText('Dispute open')).toBeInTheDocument();
    expect(within(credited).getByText('Old College')).toBeInTheDocument();
    expect(within(credited).getByText(/Reassigned to someone else/)).toBeInTheDocument();
    const stats = screen.getByLabelText('Credit summary');
    // No commission figure is shown at all until a rate is set — never NA, never a number.
    expect(within(stats).queryByText('Commission this month')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
    expect(screen.queryByText(/INR|Rs\.|₹\s*\d/)).not.toBeInTheDocument();
    // The respondent is told a dispute exists, never what it says.
    expect(within(screen.getByLabelText('Your disputes')).getByText(/Someone disputes credit/)).toBeInTheDocument();
  });

  it('opens a dispute only for an organisation the server offers, with a statement', async () => {
    routes = (url, init) => {
      if (url.endsWith('/api/v1/growth/attribution-disputes') && init?.method === 'POST') return ok({ ...mine, disputeId: 'd2' }, 201);
      if (url.endsWith('/api/v1/growth/attributions')) return ok(mine);
      return null;
    };
    render(<GrowthCommissionPage />);
    const form = await screen.findByLabelText('Dispute a credit');
    const button = within(form).getByRole('button', { name: 'Open dispute' });
    expect(button).toBeDisabled();
    const select = within(form).getByLabelText('Organisation to dispute');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Choose…', expect.stringContaining('Riverside Institute')]);
    fireEvent.change(select, { target: { value: 'o9' } });
    fireEvent.change(within(form).getByLabelText('Dispute statement'), { target: { value: '  I met the principal first.  ' } });
    fireEvent.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent(/Your dispute is open/);
    expect(posts()).toEqual([{ url: expect.stringContaining('/api/v1/growth/attribution-disputes'), body: { organizationId: 'o9', statement: 'I met the principal first.' } }]);
  });

  it('says plainly when nothing can be loaded', async () => {
    routes = (url) => (url.endsWith('/api/v1/growth/attributions') ? failure(500, 'INTERNAL') : null);
    render(<GrowthCommissionPage />);
    expect(await screen.findByText('Your credit could not be loaded.')).toBeInTheDocument();
  });
});

const adminList = {
  attributions: [
    { attributionId: 'a1', organizationId: 'o1', organizationName: 'Sri Venkateswara College', organizationKind: 'INSTITUTION',
      beneficiary: { userId: 'u1', email: 'leaver@uat.example.test', active: false }, leaver: { leftAt: '2026-09-01T00:00:00Z', settlementEndsAt: '2026-11-30T00:00:00Z' },
      basis: 'LEAD_OWNER_AT_HANDOFF', reasonCode: 'COLLEGE_HANDOFF_LINKED', lead: null, since: '2026-08-01T00:00:00Z', endedAt: null, endedReasonCode: null, endedBy: null,
      createdBy: 'ops@uat.example.test', disputeOpen: false },
  ],
  counts: { live: 1, beneficiaryLeft: 1, ended: 0, openDisputes: 1 },
  vocabulary: { reassignReasons: ['BENEFICIARY_LEFT', 'CORRECTION'], endReasons: ['CORRECTION', 'ORGANIZATION_EXITED'], decisionReasons: ['CLAIMANT_DID_THE_WORK', 'OTHER'], outcomes: ['UPHELD', 'REJECTED'] },
};
const openDispute = {
  disputeId: 'd1', organizationId: 'o2', organizationName: 'Northwind Labs', organizationKind: 'EMPLOYER', origin: 'ONBOARDING_CONFLICT', currentBasis: null,
  claimant: { userId: 'r', email: 'referrer@uat.example.test' }, respondent: { userId: 'o', email: 'owner@uat.example.test' }, statement: null,
  openedAt: '2026-09-20T00:00:00Z', openedBy: 'ops@uat.example.test', state: 'OPEN', decidedAt: null, decidedBy: null, decisionReasonCode: null, decisionNote: null,
  evidence: { handedOffAt: '2026-09-20T00:00:00Z', onboardingCandidate: 'CONFLICT', leadName: 'Northwind' },
};

describe('Operations → Settings → Growth attribution', () => {
  it('renders nothing for an operator without GROWTH_ADMIN', async () => {
    routes = (url) => (url.includes('/api/v1/operations/growth-attribution') ? failure(403, 'FORBIDDEN') : null);
    const { container } = render(<OperationsGrowthAttributionPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('decides a dispute with an outcome and a reason, and shows a refusal from the server', async () => {
    let refuse = true;
    routes = (url, init) => {
      if (url.includes('/disputes/d1/decide') && init?.method === 'POST') return refuse ? failure(403, 'GROWTH_SELF_DEALING_REFUSED') : ok({ decided: {} }, 201);
      if (url.includes('/api/v1/operations/growth-attribution/disputes')) return ok({ disputes: [openDispute] });
      if (url.includes('/api/v1/operations/growth-attribution')) return ok(adminList);
      return null;
    };
    render(<OperationsGrowthAttributionPanel />);
    const card = await screen.findByLabelText('Dispute about Northwind Labs');
    expect(within(card).getByText(/Referral by referrer@uat\.example\.test; lead owned by owner@uat\.example\.test/)).toBeInTheDocument();
    const record = within(card).getByRole('button', { name: 'Record decision' });
    expect(record).toBeDisabled();
    fireEvent.change(within(card).getByLabelText('Decision for Northwind Labs'), { target: { value: 'REJECTED' } });
    fireEvent.change(within(card).getByLabelText('Reason for Northwind Labs'), { target: { value: 'OTHER' } });
    expect(record).toBeDisabled();
    fireEvent.change(within(card).getByLabelText('Note for Northwind Labs'), { target: { value: 'Lead work came first.' } });
    fireEvent.click(record);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    refuse = false;
    fireEvent.click(record);
    expect(await screen.findByRole('status')).toHaveTextContent('Dispute about Northwind Labs decided.');
    expect(posts().at(-1)).toEqual({ url: expect.stringContaining('/disputes/d1/decide'), body: { outcome: 'REJECTED', reasonCode: 'OTHER', note: 'Lead work came first.' } });
  });

  it('flags a leaver and reassigns their credit only with a target and a reason', async () => {
    routes = (url, init) => {
      if (url.includes('/a1/reassign') && init?.method === 'POST') return ok({ attributionId: 'a9' }, 201);
      if (url.includes('/reassign-options')) return ok({ options: [{ userId: 'u1', email: 'leaver@uat.example.test' }, { userId: 'u2', email: 'next@uat.example.test' }] });
      if (url.includes('/api/v1/operations/growth-attribution/disputes')) return ok({ disputes: [] });
      if (url.includes('/api/v1/operations/growth-attribution')) return ok(adminList);
      return null;
    };
    render(<OperationsGrowthAttributionPanel />);
    expect(await screen.findByText(/Left .*; settlement ends/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    const target = await screen.findByLabelText('Reassign Sri Venkateswara College to');
    await waitFor(() => expect(within(target).getAllByRole('option')).toHaveLength(2));
    // The current holder is not offered.
    expect(within(target).queryByText('leaver@uat.example.test')).not.toBeInTheDocument();
    const reassign = screen.getByRole('button', { name: 'Reassign' });
    fireEvent.change(target, { target: { value: 'u2' } });
    expect(reassign).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reassign reason for Sri Venkateswara College'), { target: { value: 'BENEFICIARY_LEFT' } });
    fireEvent.click(reassign);
    expect(await screen.findByRole('status')).toHaveTextContent(/reassigned/);
    expect(posts()).toEqual([{ url: expect.stringContaining('/a1/reassign'), body: { toUserId: 'u2', reasonCode: 'BENEFICIARY_LEFT' } }]);
  });
});
