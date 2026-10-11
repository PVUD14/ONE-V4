/**
 * The employer pipeline on the web (GROWTH-05): the referral-link card shows only the server's codes
 * and counts, makes a link out of the public form path and the code alone, and sends a creation with
 * an idempotency key; an employer lead shows its milestones with counts and states only and its
 * access requests with whose referral, never whose by name; the Operations access-request queue shows
 * the referral and the matching growth lead and links, moves or removes it only on request; and the
 * public form passes the link's `ref` on untouched.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, type EmployerAccessRequestDto } from '../api.js';
import { LeadPipelinePanel } from './growthPipeline.js';
import { GrowthReferralLinksCard } from './growthReferrals.js';
import { EmployerAccessRequestsSection } from './operationsEmployerAccessRequests.js';
import { referralFromLocation } from '../publicEmployerAccessPage.js';

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
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown>, key: (init.headers as Record<string, string>)['Idempotency-Key'] }));

const limits = { liveCodesPerPerson: 3, createdPerDay: 5, referralsPerCodePerDay: 20 };
const code = (overrides: Record<string, unknown> = {}) => ({
  id: 'code-1', code: 'ABCDEFGHJK', linkPath: '/employer-access?ref=ABCDEFGHJK', createdAt: '2026-10-01T00:00:00Z', revokedAt: null, revokedReasonCode: null,
  referrals: { pending: 2, onboarded: 1, closed: 0 }, ...overrides,
});

describe('Your employer referral links', () => {
  it('shows the server\'s codes with a link built from the form path and the code, and their counts', async () => {
    routes = (url) => (url.endsWith('/api/v1/growth/referral-codes') ? ok({ eligible: true, codes: [code(), code({ id: 'code-2', code: 'ZZZZZZZZZZ', revokedAt: '2026-10-01T00:00:00Z' })], limits }) : null);
    render(<GrowthReferralLinksCard token="token" />);
    expect(await screen.findByText('ABCDEFGHJK')).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/employer-access?ref=ABCDEFGHJK`)).toBeInTheDocument();
    expect(screen.getByText('2 waiting · 1 onboarded · 0 closed')).toBeInTheDocument();
    expect(screen.getByText('1 live')).toBeInTheDocument();
    expect(screen.getByText('Revoked links (1)')).toBeInTheDocument();
  });

  it('creates a link with an idempotency key and revokes one on request', async () => {
    let listed = [code()];
    routes = (url, init) => {
      if (url.endsWith('/api/v1/growth/referral-codes') && init?.method === 'POST') { listed = [...listed, code({ id: 'code-3', code: 'MMMMMMMMMM' })]; return ok({ code: listed[1], codes: listed }, 201); }
      if (url.endsWith('/revoke')) return ok({ codes: [] }, 201);
      if (url.endsWith('/api/v1/growth/referral-codes')) return ok({ eligible: true, codes: listed, limits });
      return null;
    };
    render(<GrowthReferralLinksCard token="token" />);
    fireEvent.click(await screen.findByRole('button', { name: 'New referral link' }));
    expect(await screen.findByText('MMMMMMMMMM')).toBeInTheDocument();
    expect(posts()[0]).toMatchObject({ url: expect.stringContaining('/api/v1/growth/referral-codes'), body: {} });
    expect(posts()[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke link ABCDEFGHJK' }));
    await waitFor(() => expect(posts().at(-1)!.url).toContain('/api/v1/growth/referral-codes/code-1/revoke'));
  });

  it('explains the server\'s limits and says plainly when the person is not on the employer team', async () => {
    routes = (url, init) => (init?.method === 'POST' ? failure(409, 'GROWTH_REFERRAL_CODE_DAILY_LIMIT') : url.endsWith('/referral-codes') ? ok({ eligible: true, codes: [], limits }) : null);
    render(<GrowthReferralLinksCard token="token" />);
    fireEvent.click(await screen.findByRole('button', { name: 'New referral link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('most links allowed today');
    cleanup();
    routes = (url) => (url.endsWith('/referral-codes') ? ok({ eligible: false, codes: [], limits }) : null);
    render(<GrowthReferralLinksCard token="token" />);
    expect(await screen.findByText('Referral links are for the employer partnerships team.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New referral link' })).toBeNull();
  });
});

describe('an employer lead\'s pipeline', () => {
  const vocabulary = { reasons: { backward: ['CORRECTION'], hold: ['BUDGET_CYCLE'], lost: ['NO_BUDGET'] }, declineReasons: [], milestones: [] };
  const milestones = [
    { code: 'ACCESS_REQUESTED', state: 'REACHED', at: '2026-09-28T00:00:00Z' },
    { code: 'ONBOARDED', state: 'REACHED', at: '2026-09-29T00:00:00Z' },
    { code: 'VERIFIED', state: 'NOT_REACHED', at: null },
    { code: 'TERMS_ACCEPTED', state: 'NA', at: null, note: 'No employer terms are published yet.' },
    { code: 'FIRST_JOB_PUBLISHED', state: 'REACHED', at: '2026-09-30T00:00:00Z', counts: { PUBLISHED_NOW: 2 } },
    { code: 'CAMPUS_DRIVE', state: 'REACHED', at: '2026-09-30T00:00:00Z', counts: { REQUESTED: 1, SCHEDULED: 3 } },
    { code: 'SUSPENDED', state: 'NOT_REACHED', at: null },
  ];

  it('shows the milestones with counts and states only, and the access requests with whose referral', async () => {
    routes = (url) => (url.endsWith('/pipeline') ? ok({
      leadId: 'lead-1', kind: 'EMPLOYER', stage: 'ACCESS_REQUEST_INVITED', lostReasonCode: null, canMove: true, nextStages: ['ON_HOLD', 'LOST'],
      canRequestHandoff: false, handoffRequests: [], milestones, vocabulary,
      accessRequests: [{ receivedAt: '2026-09-28T00:00:00Z', state: 'ONBOARDED', referral: 'YOU' }, { receivedAt: '2026-09-27T00:00:00Z', state: 'PENDING', referral: 'ANOTHER_TEAM_MEMBER' }],
    }) : null);
    render(<LeadPipelinePanel leadId="lead-1" token="token" contacts={[]} onChanged={() => undefined} />);
    const list = await screen.findByLabelText('Onboarding milestones');
    expect(within(list).getByText('Employer verified')).toBeInTheDocument();
    expect(within(list).getByText('2 published now')).toBeInTheDocument();
    expect(within(list).getByText('1 requested · 3 scheduled')).toBeInTheDocument();
    expect(within(list).getByText('No employer terms are published yet.')).toBeInTheDocument();
    expect(within(list).getAllByText('NA')).toHaveLength(1);
    const requests = screen.getByLabelText('Access requests');
    expect(requests).toHaveTextContent('Onboarded · through your referral link');
    expect(requests).toHaveTextContent("Waiting for operations · through another team member's referral link");
    expect(screen.queryByText(/Hand the college/)).toBeNull();
  });

  it('says plainly when the company has not asked for access yet', async () => {
    routes = (url) => (url.endsWith('/pipeline') ? ok({
      leadId: 'lead-1', kind: 'EMPLOYER', stage: 'MET', lostReasonCode: null, canMove: true, nextStages: ['INTERESTED'], canRequestHandoff: false, handoffRequests: [],
      milestones: milestones.map((item) => ({ code: item.code, state: 'NOT_REACHED', at: null })), vocabulary, accessRequests: [],
    }) : null);
    render(<LeadPipelinePanel leadId="lead-1" token="token" contacts={[]} onChanged={() => undefined} />);
    expect(await screen.findByText(/No access request from this company yet/)).toBeInTheDocument();
  });
});

describe('Operations → employer access requests: the growth column', () => {
  const request = (overrides: Partial<EmployerAccessRequestDto> = {}): EmployerAccessRequestDto => ({
    id: 'req-1', requesterName: 'Priya Raman', companyName: 'Aster Mobility', workEmail: 'priya@aster.example', emailDomain: 'aster.example',
    websiteUrl: 'https://www.aster.example', emailMatchesWebsite: true, freeMail: false, emailConfirmed: false, state: 'PENDING', organizationId: null,
    decisionReasonCode: null, decidedAt: null, submissionCount: 1, createdAt: '2026-09-24T00:00:00Z', lastSubmittedAt: '2026-09-24T00:00:00Z', possibleMatches: [],
    growthReferral: { referrerEmail: 'field@example.test', codeRevoked: true, recordedAt: '2026-09-24T00:00:00Z' },
    growthLead: { leadId: 'lead-1', name: 'Aster lead', websiteDomain: 'aster.example', stage: 'INTERESTED', ownerEmail: 'owner@example.test', basis: 'DOMAIN_MATCH' },
    growthLeadCandidates: [{ leadId: 'lead-2', name: 'Aster Mobility (old)', websiteDomain: null, stage: 'MET', ownerEmail: null }],
    ...overrides,
  });
  const reasonCodes = { ONBOARDED: ['ORGANISATION_CREATED'], DECLINED: ['NOT_AN_EMPLOYER'], SPAM: ['BULK_SUBMISSION'] };

  it('shows the referral and the matching lead, and links, moves or removes it only when asked', async () => {
    routes = (url, init) => {
      if (url.includes('/growth-employer-leads')) return ok({ leads: [{ leadId: 'lead-3', name: 'Searched lead', websiteDomain: 'x.example', stage: 'MET', ownerEmail: 'b@example.test' }] });
      if (url.endsWith('/growth-lead') && init?.method === 'POST') return ok({ linked: {} }, 201);
      if (url.includes('/api/v1/operations/employer-access-requests')) return ok({ requests: [request()], nextCursor: null, reasonCodes });
      return null;
    };
    render(<EmployerAccessRequestsSection organizations={[]} />);
    expect(await screen.findByText(/Referred by field@example.test/)).toBeInTheDocument();
    expect(screen.getByText('(link since revoked)')).toBeInTheDocument();
    expect(screen.getByText('Aster lead')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Link Aster Mobility to growth lead Aster Mobility (old)' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ url: expect.stringContaining('/employer-access-requests/req-1/growth-lead'), body: { leadId: 'lead-2' } });

    fireEvent.change(await screen.findByLabelText('Find a growth lead for Aster Mobility'), { target: { value: 'searched' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Link Aster Mobility to growth lead Searched lead' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.body).toEqual({ leadId: 'lead-3' });

    fireEvent.click(await screen.findByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]!.body).toEqual({ leadId: null });
  });

  it('says so when a request has no referral and no lead', async () => {
    routes = (url) => (url.includes('/api/v1/operations/employer-access-requests')
      ? ok({ requests: [request({ growthReferral: null, growthLead: null, growthLeadCandidates: [] })], nextCursor: null, reasonCodes }) : null);
    render(<EmployerAccessRequestsSection organizations={[]} />);
    expect(await screen.findByText('No referral link')).toBeInTheDocument();
    expect(screen.getByText('No growth lead')).toBeInTheDocument();
  });
});

describe('the public form and the referral link', () => {
  it('passes the link\'s ref on untouched and ignores an absent or over-long one', () => {
    expect(referralFromLocation('?ref=ABCDEFGHJK')).toBe('ABCDEFGHJK');
    expect(referralFromLocation('?ref=whatever-was-pasted')).toBe('whatever-was-pasted');
    expect(referralFromLocation('')).toBeUndefined();
    expect(referralFromLocation('?ref=' + 'A'.repeat(65))).toBeUndefined();
  });
});
