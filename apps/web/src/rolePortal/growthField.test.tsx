/**
 * Growth → Field and the lead's field-work panel (GROWTH-06): the page shows only what the server
 * returned (counts, follow-ups grouped by due date, recent work), the team view is offered to
 * managers only, a location is shown only when the server included it, and every write carries an
 * Idempotency-Key that is reused when the same submission is retried and renewed after it lands.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { GrowthFieldPage, LeadFieldPanel } from './growthField.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const vocabulary = {
  kinds: ['VISIT', 'CALL', 'MEETING', 'NOTE'], outcomes: ['MET', 'NOT_AVAILABLE'], cancelReasons: ['NO_LONGER_NEEDED', 'OTHER'],
  notesMax: 2000, titleMax: 280, reportMaxAgeDays: 7, locationRetentionDays: 180, listLimit: 100,
  locationNotice: { version: 'draft-2026-10', status: 'DRAFT_FOR_LEGAL_REVIEW', text: ['Attaching your location to a visit is optional.', 'It is never used for attendance, pay, performance ratings or discipline.'] },
};
const followUp = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), leadId: 'lead-1', leadName: 'Vidya College', leadKind: 'COLLEGE', title: 'Send the proposal', titleErased: false,
  dueOn: '2026-10-01', state: 'OPEN', overdue: false, dueToday: true, assignee: { email: 'field@example.test', isMe: true }, activityId: null,
  createdAt: new Date().toISOString(), closedAt: null, cancelReasonCode: null, ...overrides,
});
const activity = (overrides: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), leadId: 'lead-1', leadName: 'Vidya College', leadKind: 'COLLEGE', kind: 'VISIT', outcome: 'MET', contact: null,
  notes: 'Met the principal.', notesErased: false, author: { email: 'field@example.test', isMe: true },
  occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), location: null, locationRemoved: null, ...overrides,
});
const fieldBody = (overrides: Record<string, unknown> = {}) => ({
  view: 'MINE', canSeeTeam: false, today: '2026-10-01',
  counts: { visitsThisMonth: 4, activitiesThisMonth: 6, metThisMonth: 3, followUpsOverdue: 1, followUpsDueToday: 1, followUpsOpen: 3 },
  followUps: [
    followUp({ title: 'Chase the trustee', overdue: true, dueToday: false, dueOn: '2026-09-28' }),
    followUp({ title: 'Send the proposal' }),
    followUp({ title: 'Plan the demo', dueToday: false, dueOn: '2026-10-08' }),
  ],
  activities: [activity({ location: { latitude: 12.972, longitude: 77.595, accuracyM: 413 } }), activity({ id: 'other', kind: 'CALL', outcome: 'NOT_AVAILABLE', notes: null })],
  vocabulary, ...overrides,
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string) =>
  Promise.resolve({ ok: false, status, json: async () => ({ error: { code, message: 'The request could not be completed.', correlationId: 'corr-fail' } }), headers: new Headers() });
let routes: (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<unknown> | null;

beforeEach(() => {
  routes = () => null;
  vi.mocked(getProtectedAccessToken).mockReturnValue('token');
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const special = routes(String(url), init);
    if (special) return special;
    const path = String(url);
    if (path.includes('/api/v1/growth/field?view=MINE')) return ok(fieldBody());
    if (path.includes('/api/v1/growth/field?view=TEAM')) return ok(fieldBody({ view: 'TEAM', canSeeTeam: true, followUps: [followUp({ assignee: { email: 'teammate@example.test', isMe: false } })] }));
    if (path.endsWith('/api/v1/growth/leads/lead-1/field')) return ok({ leadId: 'lead-1', canLog: true, activities: [], followUps: [], vocabulary });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown>, key: (init.headers as Record<string, string>)['Idempotency-Key'] }));

describe('Growth → Field', () => {
  it('shows the server\'s counts, follow-ups by due date and recent work, with the location notice as a draft', async () => {
    render(<GrowthFieldPage role="GROWTH_EXECUTIVE" />);
    const stats = await screen.findByLabelText('Field summary');
    await waitFor(() => expect(within(stats).getByText('Visits this month').parentElement).toHaveTextContent('4'));
    expect(within(stats).getByText('Overdue follow-ups').parentElement).toHaveTextContent('1');
    expect(screen.getByRole('heading', { name: 'Overdue (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Due today (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upcoming (1)' })).toBeInTheDocument();
    expect(screen.getByText(/12\.972, 77\.595 \(±413 m\)/)).toBeInTheDocument();
    expect(screen.getByText('Draft wording, pending approval')).toBeInTheDocument();
    expect(screen.getByText('It is never used for attendance, pay, performance ratings or discipline.')).toBeInTheDocument();
    // An executive has no team view.
    expect(screen.queryByRole('button', { name: 'My team' })).not.toBeInTheDocument();
  });

  it('offers a manager their team\'s follow-ups, with whose each one is', async () => {
    render(<GrowthFieldPage role="GROWTH_MANAGER" />);
    fireEvent.click(await screen.findByRole('button', { name: 'My team' }));
    expect(await screen.findByText(/teammate@example\.test/)).toBeInTheDocument();
  });

  it('leaves every figure out, never NA or a number, when the field work cannot be loaded', async () => {
    routes = (url) => (url.includes('/api/v1/growth/field') ? failure(500, 'INTERNAL') : null);
    render(<GrowthFieldPage role="GROWTH_EXECUTIVE" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const stats = screen.getByLabelText('Field summary');
    expect(within(stats).queryByText('NA')).not.toBeInTheDocument();
    expect(within(stats).queryByText('Visits this month')).not.toBeInTheDocument();
    expect(within(stats).queryByText(/\d/)).not.toBeInTheDocument();
  });

  it('reuses one Idempotency-Key when the same click is retried, and renews it once the write lands', async () => {
    let attempts = 0;
    routes = (url, init) => {
      if (init?.method === 'POST' && url.includes('/complete')) {
        attempts += 1;
        return attempts === 1 ? failure(503, 'UNAVAILABLE') : ok({ followUp: followUp({ state: 'DONE' }) });
      }
      return null;
    };
    render(<GrowthFieldPage role="GROWTH_EXECUTIVE" />);
    const row = await screen.findByLabelText('Follow-up Send the proposal');
    fireEvent.click(within(row).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(within(row).getByRole('alert')).toBeInTheDocument());
    fireEvent.click(within(row).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    const [first, second] = posts();
    expect(first!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(second!.key).toBe(first!.key);
  });

  it('shows no location at all for work whose location the server withheld', async () => {
    const withheld = activity({ author: { email: 'someone@example.test', isMe: false } }) as Record<string, unknown>;
    delete withheld.location;
    delete withheld.locationRemoved;
    routes = (url) => (url.includes('/api/v1/growth/field') ? ok(fieldBody({ activities: [withheld] })) : null);
    render(<GrowthFieldPage role="GROWTH_EXECUTIVE" />);
    expect(await screen.findByText(/someone@example\.test/)).toBeInTheDocument();
    expect(screen.queryByText(/Location attached/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No location attached/)).not.toBeInTheDocument();
  });
});

describe('the field-work panel on a lead', () => {
  const contacts = [{ id: 'contact-1', role: 'PRINCIPAL', fullName: 'Dr Asha Rao', email: null, phone: null, masked: false,
    permissionBasis: 'PROVIDED_BY_PERSON', source: 'BUSINESS_CARD', notice: null, addedAt: null }];

  it('logs a visit with its outcome, the contact met and the time as an instant, under an Idempotency-Key', async () => {
    routes = (url, init) => (init?.method === 'POST' && url.endsWith('/activities') ? ok({ activity: activity(), idempotentReplay: false }) : null);
    render(<LeadFieldPanel leadId="lead-1" token="token" contacts={contacts} />);
    const form = await screen.findByLabelText('Log field work');
    expect(within(form).getByRole('button', { name: 'Log it' })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Activity outcome'), { target: { value: 'MET' } });
    fireEvent.change(within(form).getByLabelText('Contact met'), { target: { value: 'contact-1' } });
    fireEvent.change(within(form).getByLabelText('Activity notes'), { target: { value: 'Discussed a pilot.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Log it' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [sent] = posts();
    expect(sent!.url).toContain('/api/v1/growth/leads/lead-1/activities');
    expect(sent!.body).toMatchObject({ kind: 'VISIT', outcome: 'MET', contactId: 'contact-1', notes: 'Discussed a pilot.' });
    expect(Number.isNaN(Date.parse(String(sent!.body.occurredAt)))).toBe(false);
    expect(sent!.body).not.toHaveProperty('location');
    expect(sent!.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('says in plain words why an old report was refused', async () => {
    routes = (url, init) => (init?.method === 'POST' && url.endsWith('/activities') ? failure(400, 'GROWTH_REPORT_TOO_OLD') : null);
    render(<LeadFieldPanel leadId="lead-1" token="token" contacts={[]} />);
    const form = await screen.findByLabelText('Log field work');
    fireEvent.change(within(form).getByLabelText('Activity kind'), { target: { value: 'NOTE' } });
    fireEvent.change(within(form).getByLabelText('Activity notes'), { target: { value: 'Prefers email.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Log it' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('more than 7 days ago');
  });

  it('adds a follow-up with a due date, and offers no forms on a lead the person may not work', async () => {
    routes = (url, init) => (init?.method === 'POST' && url.endsWith('/follow-ups') ? ok({ followUp: followUp() }) : null);
    render(<LeadFieldPanel leadId="lead-1" token="token" contacts={[]} />);
    const form = await screen.findByLabelText('Add a follow-up');
    fireEvent.change(within(form).getByLabelText('Follow-up'), { target: { value: 'Call back' } });
    fireEvent.change(within(form).getByLabelText('Due date'), { target: { value: '2026-10-05' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add follow-up' }));
    await waitFor(() => expect(posts()).toEqual([expect.objectContaining({ body: { title: 'Call back', dueOn: '2026-10-05' } })]));
    cleanup();
    routes = (url) => (url.endsWith('/field') ? ok({ leadId: 'lead-1', canLog: false, activities: [], followUps: [], vocabulary }) : null);
    render(<LeadFieldPanel leadId="lead-1" token="token" contacts={[]} />);
    expect(await screen.findByText(/logged by its owner or their manager/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Log field work')).not.toBeInTheDocument();
  });
});
