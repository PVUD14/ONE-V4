/**
 * The college pipeline on a lead and the Operations growth handoff queue (GROWTH-04): a move sends
 * the stage the person saw, a hold or a loss cannot be sent without a reason, the handoff request
 * carries the reported reference and the chosen contacts, milestones show no state where there is no
 * source and "<5" for a small count, and the Operations section renders nothing without the
 * capability and offers only institutions to link.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { GrowthHandoffsSection, LeadPipelinePanel } from './growthPipeline.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const vocabulary = {
  reasons: { backward: ['MEETING_CANCELLED', 'CORRECTION'], hold: ['BUDGET_CYCLE'], lost: ['NO_BUDGET', 'OTHER'] },
  declineReasons: ['INCOMPLETE', 'CONTRACT_NOT_CONFIRMED'],
  milestones: [],
};
const pipeline = (overrides: Record<string, unknown> = {}) => ({
  leadId: 'lead-1', kind: 'COLLEGE', stage: 'MET', lostReasonCode: null, canMove: true,
  nextStages: ['IDENTIFIED', 'CONTACTED', 'PROPOSAL_SHARED', 'NEGOTIATION', 'AGREEMENT_SIGNED_REPORTED', 'ON_HOLD', 'LOST'],
  canRequestHandoff: false, handoffRequests: [], milestones: null, vocabulary, ...overrides,
});
const contacts = [{ id: 'contact-1', role: 'PRINCIPAL', fullName: 'Dr Asha Rao', email: 'p@college.example', phone: null, masked: false,
  permissionBasis: 'PROVIDED_BY_PERSON', source: 'MEETING', notice: null, addedAt: null }];

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
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

describe('the pipeline on a lead', () => {
  it('sends the stage the person saw, and will not send a loss without a reason', async () => {
    routes = (url, init) => (url.endsWith('/pipeline') ? ok(pipeline()) : init?.method === 'POST' ? ok(pipeline({ stage: 'LOST', lostReasonCode: 'NO_BUDGET', nextStages: [] })) : null);
    render(<LeadPipelinePanel leadId="lead-1" token="token" contacts={[]} onChanged={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Next stage'), { target: { value: 'LOST' } });
    const move = screen.getByRole('button', { name: 'Move' });
    expect(move).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Stage reason'), { target: { value: 'NO_BUDGET' } });
    fireEvent.click(move);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ body: { fromStage: 'MET', toStage: 'LOST', reasonCode: 'NO_BUDGET' } });
    expect(posts()[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('Lost: No budget')).toBeInTheDocument();
  });

  it('explains a stage that changed meanwhile and reloads it', async () => {
    let loads = 0;
    routes = (url, init) => {
      if (url.endsWith('/pipeline')) { loads += 1; return ok(pipeline({ stage: loads > 1 ? 'PROPOSAL_SHARED' : 'MET' })); }
      return init?.method === 'POST' ? failure(409, 'GROWTH_STAGE_CHANGED') : null;
    };
    render(<LeadPipelinePanel leadId="lead-1" token="token" contacts={[]} onChanged={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Next stage'), { target: { value: 'NEGOTIATION' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText(/stage changed since you opened this lead/)).toBeInTheDocument();
    await waitFor(() => expect(loads).toBe(2));
  });

  it('asks for the handoff with the reported reference and the chosen contacts', async () => {
    routes = (url, init) => (url.endsWith('/pipeline') ? ok(pipeline({ stage: 'AGREEMENT_SIGNED_REPORTED', canRequestHandoff: true }))
      : init?.method === 'POST' ? ok(pipeline({ stage: 'HANDOFF_REQUESTED', nextStages: [], canRequestHandoff: false })) : null);
    render(<LeadPipelinePanel leadId="lead-1" token="token" contacts={contacts} onChanged={() => undefined} />);
    const form = await screen.findByLabelText('Request the handoff');
    const send = within(form).getByRole('button', { name: 'Request the handoff' });
    expect(send).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Agreement reference'), { target: { value: ' AGR/2026-014 ' } });
    fireEvent.click(within(form).getByLabelText(/Dr Asha Rao/));
    fireEvent.click(send);
    await waitFor(() => expect(posts()).toEqual([expect.objectContaining({ url: expect.stringContaining('/lead-1/handoff'), body: { contractReference: 'AGR/2026-014', contactIds: ['contact-1'] } })]));
    expect(await screen.findByText(/Waiting for operations to onboard the college/)).toBeInTheDocument();
  });

  it('shows milestones from the server: no state without a source, <5 for a small count, never a figure invented', async () => {
    routes = (url) => (url.endsWith('/pipeline') ? ok(pipeline({ stage: 'HANDOFF_REQUESTED', nextStages: [], milestones: [
      { code: 'HANDED_OFF', state: 'REACHED', at: '2026-09-20T10:00:00.000Z' },
      { code: 'DATA_TERMS_ACCEPTED', state: 'NA', at: null, note: 'No data-processing terms are published yet.' },
      { code: 'STUDENTS_ACTIVATING', state: 'NOT_REACHED', at: null, count: { suppressed: true, value: null } },
      { code: 'FIRST_PAYMENT_CLEARED', state: 'NA', at: null },
    ] })) : null);
    render(<LeadPipelinePanel leadId="lead-1" token="token" contacts={[]} onChanged={() => undefined} />);
    const list = await screen.findByLabelText('Onboarding milestones');
    expect(within(list).getByText('Students activating').closest('.v2-list-row')).toHaveTextContent('<5');
    const unsourced = within(list).getByText('First payment cleared').closest('.v2-list-row') as HTMLElement;
    expect(unsourced).not.toHaveTextContent(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
    expect(unsourced.querySelector('.v2-chip')).toBeNull();
    expect(within(list).getByText('No data-processing terms are published yet.')).toBeInTheDocument();
  });
});

describe('Operations → Organizations: growth handoffs', () => {
  const organizations = [
    { id: 'inst-1', kind: 'INSTITUTION', legalName: 'Vidya College Trust', profile: { displayName: 'Vidya College' } },
    { id: 'emp-1', kind: 'EMPLOYER', legalName: 'Acme Ltd', profile: { displayName: 'Acme' } },
  ] as never;
  const queue = { declineReasons: ['INCOMPLETE'], requests: [{
    id: 'req-1', leadId: 'lead-1', leadName: 'Vidya College', owner: 'field@example.test', state: 'REQUESTED', requestedAt: '2026-09-30T10:00:00.000Z',
    requestedBy: 'field@example.test', contractReferenceReported: 'AGR-14', contactsMarked: 1, decidedAt: null, declineReasonCode: null,
    contactsCarried: null, contactsErased: null, area: { city: 'Mysuru', stateName: 'Karnataka', districtName: null }, aisheCode: 'C-1234',
    contacts: [{ id: 'contact-1', role: 'CHAIRMAN_OR_TRUSTEE', accountRole: 'OTHER', fullName: 'Shri Rao', email: 'c***@college.example', phone: '***2345' }],
  }] };

  it('renders nothing for an operator without OPS_ORG_MANAGE', async () => {
    routes = (url) => (url.includes('/growth-handoffs') ? failure(403, 'FORBIDDEN') : null);
    const { container } = render(<GrowthHandoffsSection organizations={organizations} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows contacts masked, offers only institutions, and links or declines', async () => {
    routes = (url, init) => (init?.method === 'POST' ? ok({ linked: { contactsCarried: 1, contactsErased: 1, contactsOverLimit: 0 } })
      : url.includes('/growth-handoffs') ? ok(queue) : null);
    render(<GrowthHandoffsSection organizations={organizations} />);
    const section = await screen.findByLabelText('Growth handoffs');
    expect(await within(section).findByText('c***@college.example · ***2345')).toBeInTheDocument();
    const select = within(section).getByLabelText('College for Vidya College');
    expect(within(select).queryByText('Acme')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'inst-1' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(posts()).toEqual([expect.objectContaining({ url: expect.stringContaining('/growth-handoffs/lead-1/link'), body: { organizationId: 'inst-1' } })]));
    expect(await within(section).findByRole('status')).toHaveTextContent('Vidya College linked');
  });
});
