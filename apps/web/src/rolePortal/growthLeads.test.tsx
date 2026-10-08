/**
 * Growth → Leads and the Operations lead sections (GROWTH-03): the list shows only what the server
 * returns, the duplicate answer is the server's words (never another team's owner unless the server
 * named them), contacts are full for the owner and masked for others, a contact cannot be sent
 * without a permission basis and a source that fits it, and the privacy section erases only after
 * a lookup and a confirmation. Every operator section renders nothing without its capability.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { GrowthLeadsPage } from './growthLeads.js';
import { OperationsGrowthContactsPrivacyPanel, OperationsGrowthLeadsPanel } from './growthLeadsAdmin.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const now = new Date().toISOString();
const vocabulary = {
  kinds: ['COLLEGE', 'EMPLOYER'],
  stages: { COLLEGE: ['IDENTIFIED', 'LOST'], EMPLOYER: ['IDENTIFIED', 'LOST'] },
  sources: ['FIELD_VISIT', 'EVENT'],
  contactRoles: ['PRINCIPAL', 'HR'],
  contactSourcesByBasis: { PROVIDED_BY_PERSON: ['BUSINESS_CARD', 'MEETING'], PUBLIC_INSTITUTIONAL_LISTING: ['OFFICIAL_WEBSITE'], INTRODUCED_BY_COLLEAGUE: ['COLLEAGUE_INTRODUCTION'] },
  reasons: {
    reassign: ['TERRITORY_CHANGE', 'WORKLOAD'], adminReassign: ['TERRITORY_CHANGE', 'CORRECTION'], removeContact: ['OWNER_REMOVED', 'WRONG_DETAILS'],
    adminRemoveContact: ['PRIVACY_REQUEST'], revealContact: ['MANAGER_REVIEW'], doNotContact: ['ORGANISATION_DECLINED'],
  },
  contactLimit: 10,
  purpose: "To contact this person about their organisation partnering with AI8HT's ONE platform.",
  notice: { version: 'draft-2026-10', status: 'DRAFT_FOR_LEGAL_REVIEW', text: ['AI8HT runs ONE.', 'We erase them 24 months after our last contact.'] },
};
const summary = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), kind: 'COLLEGE', name: 'Vidya College', area: { stateCode: 'IN-KA', stateName: 'Karnataka', districtCode: null, districtName: null, city: 'Mysuru' },
  aisheCode: 'C-1234', websiteDomain: null, owner: { email: 'field@example.test', isMe: true }, needsNewOwner: false, stage: 'IDENTIFIED', lostReasonCode: null,
  source: 'FIELD_VISIT', possibleDuplicate: false, doNotContact: null, handedOff: false, liveContacts: 1, createdAt: now, lastActivityAt: now, stale: false, version: 1, ...overrides,
});
const detail = (overrides: Record<string, unknown> = {}, masked = false) => ({
  ...summary(overrides), contactsShownInFull: !masked, removedContacts: 0,
  contacts: [{ id: 'contact-1', role: 'PRINCIPAL', fullName: 'Dr Asha Rao', email: masked ? 'p***@college.example' : 'principal@college.example',
    phone: masked ? '***2345' : '+91 98450 12345', masked, permissionBasis: 'PROVIDED_BY_PERSON', source: 'BUSINESS_CARD', notice: null, addedAt: now }],
  ownerHistory: [{ reasonCode: 'CREATED', at: now, from: null, to: 'field@example.test' }], stageHistory: [],
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, message = 'The request could not be completed.') =>
  Promise.resolve({ ok: false, status, json: async () => ({ error: { code, message, correlationId: 'corr-fail' } }), headers: new Headers() });
let routes: (url: string, init?: { method?: string; body?: string }) => Promise<unknown> | null;

beforeEach(() => {
  routes = () => null;
  vi.mocked(getProtectedAccessToken).mockReturnValue('token');
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const special = routes(String(url), init);
    if (special) return special;
    const path = String(url);
    if (path.endsWith('/api/v1/growth/leads/vocabulary')) return ok(vocabulary);
    if (path.endsWith('/api/v1/growth/me')) return ok({ role: 'GROWTH_EXECUTIVE', staffType: 'EMPLOYEE', teams: [], openLeads: 3 });
    if (path.endsWith('/api/v1/growth/territory')) return ok({ role: 'GROWTH_EXECUTIVE', regions: [{ id: 'r', name: 'South', myRole: 'EXECUTIVE', since: now, areas: [], people: [], unownedLeads: 2 }] });
    if (path.includes('/api/v1/growth/leads?')) return ok({ leads: [summary()], nextCursor: null });
    if (/\/api\/v1\/growth\/leads\/[0-9a-f-]{36}$/.test(path)) return ok({ lead: detail() });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> }));

describe('Growth → Leads', () => {
  it('shows real counts, the leads the server returned, and the notice marked as a draft', async () => {
    render(<GrowthLeadsPage role="GROWTH_EXECUTIVE" />);
    expect(await screen.findByText('Vidya College')).toBeInTheDocument();
    const stats = screen.getByLabelText('Leads summary');
    await waitFor(() => expect(within(stats).getByText('Your open leads').parentElement).toHaveTextContent('3'));
    expect(within(stats).getByText('Unowned in your regions').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Draft wording, pending approval')).toBeInTheDocument();
    expect(screen.getByText('We erase them 24 months after our last contact.')).toBeInTheDocument();
    // Executives are not offered the managers' "needs a new owner" list.
    expect(within(screen.getByLabelText('Which leads')).queryByRole('option', { name: 'Needs a new owner' })).not.toBeInTheDocument();
  });

  it('says plainly when there are no leads, with NA where a count could not be read', async () => {
    routes = (url) => url.includes('/api/v1/growth/leads?') ? ok({ leads: [], nextCursor: null })
      : url.endsWith('/api/v1/growth/me') ? failure(500, 'BROKEN') : null;
    render(<GrowthLeadsPage role="GROWTH_EXECUTIVE" />);
    expect(await screen.findByText('No leads here')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Leads summary')).getByText('Your open leads').parentElement).toHaveTextContent('NA');
  });

  it('shows the server\'s duplicate answer, which names nobody it was not allowed to', async () => {
    routes = (url, init) => init?.method === 'POST' && url.endsWith('/api/v1/growth/leads')
      ? failure(409, 'GROWTH_LEAD_DUPLICATE', 'Already registered by another team member — ask your manager.') : null;
    render(<GrowthLeadsPage role="GROWTH_EXECUTIVE" />);
    await screen.findByText('Vidya College');
    fireEvent.click(screen.getByRole('button', { name: 'New lead' }));
    const form = await screen.findByLabelText('New lead');
    fireEvent.change(within(form).getByLabelText('Organisation name'), { target: { value: 'Vidya College' } });
    fireEvent.change(within(form).getByLabelText('Lead source'), { target: { value: 'FIELD_VISIT' } });
    fireEvent.change(within(form).getByLabelText('AISHE code (optional)'), { target: { value: 'C-1234' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create lead' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Already registered by another team member — ask your manager.');
    expect(posts()[0]!.body).toMatchObject({ kind: 'COLLEGE', name: 'Vidya College', aisheCode: 'C-1234', source: 'FIELD_VISIT' });
  });

  it('gives the owner full contacts with call and mail links, and will not add a contact without a basis and fitting source', async () => {
    render(<GrowthLeadsPage role="GROWTH_EXECUTIVE" />);
    fireEvent.click(await screen.findByText('Vidya College'));
    const panel = await screen.findByLabelText('Lead Vidya College');
    expect(await within(panel).findByRole('link', { name: 'principal@college.example' })).toHaveAttribute('href', 'mailto:principal@college.example');
    expect(within(panel).getByRole('link', { name: '+91 98450 12345' })).toHaveAttribute('href', 'tel:+919845012345');
    expect(within(panel).getByText(/Notice not yet given/)).toBeInTheDocument();
    const form = within(panel).getByRole('group', { name: 'Add a contact' });
    fireEvent.change(within(form).getByLabelText('Contact role'), { target: { value: 'HR' } });
    fireEvent.change(within(form).getByLabelText('Contact name'), { target: { value: 'Ravi K' } });
    fireEvent.change(within(form).getByLabelText('Contact email'), { target: { value: 'ravi@college.example' } });
    const add = within(form).getByRole('button', { name: 'Add contact' });
    expect(add).toBeDisabled();
    expect(within(form).getByLabelText('Contact source')).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Permission basis'), { target: { value: 'PUBLIC_INSTITUTIONAL_LISTING' } });
    expect(within(within(form).getByLabelText('Contact source')).queryByRole('option', { name: 'Business card' })).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Contact source'), { target: { value: 'OFFICIAL_WEBSITE' } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(posts().some((post) => post.url.endsWith('/contacts'))).toBe(true));
    expect(posts().find((post) => post.url.endsWith('/contacts'))!.body).toEqual({
      role: 'HR', fullName: 'Ravi K', email: 'ravi@college.example', phone: null, permissionBasis: 'PUBLIC_INSTITUTIONAL_LISTING', source: 'OFFICIAL_WEBSITE', noticeGiven: false,
    });
  });

  it('shows a manager masked contacts, and reveals one only with a reason', async () => {
    routes = (url, init) => {
      if (/\/api\/v1\/growth\/leads\/[0-9a-f-]{36}$/.test(url)) return ok({ lead: detail({ owner: { email: 'field@example.test', isMe: false } }, true) });
      if (init?.method === 'POST' && url.endsWith('/reveal')) return ok({ contact: { fullName: 'Dr Asha Rao', email: 'principal@college.example', phone: '+91 98450 12345' } });
      return null;
    };
    render(<GrowthLeadsPage role="GROWTH_MANAGER" />);
    fireEvent.click(await screen.findByText('Vidya College'));
    const panel = await screen.findByLabelText('Lead Vidya College');
    expect(await within(panel).findByText(/p\*\*\*@college\.example/)).toBeInTheDocument();
    expect(within(panel).queryByText(/principal@college\.example/)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('group', { name: 'Add a contact' })).not.toBeInTheDocument();
    const reveal = within(panel).getByRole('button', { name: 'Reveal' });
    expect(reveal).toBeDisabled();
    fireEvent.change(within(panel).getByLabelText('Reason to reveal a contact'), { target: { value: 'MANAGER_REVIEW' } });
    fireEvent.click(reveal);
    expect(await within(panel).findByText(/principal@college\.example/)).toBeInTheDocument();
    expect(posts().find((post) => post.url.endsWith('/reveal'))!.body).toEqual({ reasonCode: 'MANAGER_REVIEW' });
  });
});

describe('Operations sections', () => {
  it('render nothing for an operator without the capability', async () => {
    routes = (url) => url.includes('/api/v1/operations/growth-leads') || url.includes('/privacy/growth-contacts') ? failure(403, 'FORBIDDEN') : null;
    const { container } = render(<><OperationsGrowthLeadsPanel /><OperationsGrowthContactsPrivacyPanel /></>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lets a growth admin open any lead with contacts masked', async () => {
    routes = (url) => {
      if (url.includes('/api/v1/operations/growth-leads?')) return ok({ leads: [summary({ owner: { email: 'field@example.test', isMe: false } })], nextCursor: null, vocabulary });
      if (/\/api\/v1\/operations\/growth-leads\/[0-9a-f-]{36}$/.test(url)) return ok({ lead: detail({ owner: { email: 'field@example.test', isMe: false } }, true) });
      return null;
    };
    render(<OperationsGrowthLeadsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vidya College' }));
    const panel = await screen.findByLabelText('Lead Vidya College');
    expect(await within(panel).findByText(/p\*\*\*@college\.example/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Claim this lead' })).not.toBeInTheDocument();
  });

  it('answers a contact\'s request: look up by reference, then erase only after confirming', async () => {
    routes = (url, init) => {
      if (url.endsWith('/privacy/growth-contacts/policy')) return ok({ keys: ['email', 'phone'] });
      if (init?.method === 'POST' && url.endsWith('/lookup')) return ok({ matches: [{
        contactId: 'c1', leadId: 'l1', organisation: 'Vidya College', kind: 'COLLEGE', contactRole: 'PRINCIPAL', fullName: 'Dr Asha Rao', email: 'principal@college.example',
        phone: null, permissionBasis: 'PROVIDED_BY_PERSON', source: 'BUSINESS_CARD', noticeGivenAt: now, noticeVersion: 'draft-2026-10', addedAt: now, removedAt: null,
        removedReasonCode: null, leadDoNotContact: false }] });
      if (init?.method === 'POST' && url.endsWith('/erase')) return ok({ removed: 1, doNotContactLeads: 1 });
      return null;
    };
    render(<OperationsGrowthContactsPrivacyPanel />);
    expect(await screen.findByRole('heading', { name: 'Growth lead contacts' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Contact to look up'), { target: { value: 'principal@college.example' } });
    const lookUp = screen.getByRole('button', { name: 'Look up' });
    expect(lookUp).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Request reference'), { target: { value: 'PRQ-1' } });
    fireEvent.click(lookUp);
    const held = await screen.findByLabelText('What we hold');
    expect(within(held).getByText('Vidya College')).toBeInTheDocument();
    const erase = within(held).getByRole('button', { name: 'Erase these contacts' });
    expect(erase).toBeDisabled();
    fireEvent.click(within(held).getByLabelText(/mark their organisations do not contact/));
    fireEvent.click(within(held).getByLabelText(/cannot be undone/));
    fireEvent.click(erase);
    expect(await screen.findByRole('status')).toHaveTextContent('Erased 1 contact record; 1 organisation marked do not contact.');
    expect(posts().find((post) => post.url.endsWith('/erase'))!.body).toEqual({ email: 'principal@college.example', reference: 'PRQ-1', doNotContact: true });
  });
});
