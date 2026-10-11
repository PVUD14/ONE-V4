/**
 * EMP-14 web: the student joins the talent pool only by an explicit agreement, ticks exactly what a
 * card shows, answers invitations, blocks employers and leaves; the employer filters (never ranks),
 * opens a card with no name, contact, college, score or count, and invites it to an invite-only job.
 * While the feature is off (HG-4 pending) the student is offered nothing and the employer page keeps
 * its not-available state.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EmployerTalentPoolWorkspace, StudentTalentPoolCard } from './talentPool.js';

const employerId = 'employer';
const evidenceA = '55555555-5555-4555-8555-555555555555';
const evidenceB = '66666666-6666-4666-8666-666666666666';
const sqlTopic = '77777777-7777-4777-8777-777777777777';
const opportunityId = '11111111-1111-4111-8111-111111111111';
const invitationId = '22222222-2222-4222-8222-222222222222';
const blockedId = '33333333-3333-4333-8333-333333333333';
const cardRef = 'abcdef0123456789abcdef0123456789';

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
let routes: Record<string, Handler>;
let calls: { path: string; init?: RequestInit }[];

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
  calls = [];
  routes = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, ...(init ? { init } : {}) });
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0] ?? ''}`;
    const handler = routes[key] ?? routes[path.split('?')[0] ?? ''];
    const result = handler ? handler(init) : { body: {} };
    const status = result.status ?? 200;
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => result.body };
  }));
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/student'); });

async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
const sent = (method: string, suffix: string) => calls.filter((call) => call.init?.method === method && call.path.endsWith(suffix))
  .map((call) => (call.init?.body ? JSON.parse(String(call.init.body)) : null));

const item = (evidenceId: string, overrides: Record<string, unknown> = {}) => ({
  evidenceId, type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: '2026-09-20T00:00:00.000Z', unaided: true, shown: false, ...overrides,
});
const studentPool = (overrides: Record<string, unknown> = {}) => ({
  available: true, optedIn: false, discoverable: false,
  consent: { version: '2026-10-draft', title: 'Let verified employers find me in the talent pool', granted: false },
  visibility: 'PRIVATE', listing: null, roster: { branch: 'Computer Science', graduationYear: 2027 },
  skills: [{ name: 'Synthetic SQL', items: [item(evidenceA), item(evidenceB, { source: 'INSTITUTION_EXAM', unaided: false })] }],
  invitations: [], blocks: [], ...overrides,
});
const joined = (overrides: Record<string, unknown> = {}) => studentPool({
  optedIn: true, discoverable: true, consent: { version: '2026-10-draft', title: 'Let verified employers find me in the talent pool', granted: true },
  listing: { showBranch: true, showGraduationYear: false, preferredCities: ['Chennai'], optedInAt: '2026-09-30T00:00:00.000Z' },
  skills: [{ name: 'Synthetic SQL', items: [item(evidenceA, { shown: true }), item(evidenceB, { source: 'INSTITUTION_EXAM', unaided: false })] }],
  ...overrides,
});

/** Nothing score-like on screen — apart from the sentences that promise there is none. */
function expectNoScores(): void {
  const text = (document.body.textContent ?? '')
    .replace('Never your name, email, phone, photo, college, marks, scores or readiness.', '')
    .replace('Results are filtered, never ranked or scored, and show no names, contact details or colleges.', '')
    .replace('Nothing here is totalled, graded or ranked.', '');
  expect(text).not.toMatch(/readiness|score|band|mastery|DEMONSTRATED|TRANSFERRED|%|rank/i);
}

describe('EMP-14 student: the talent pool card on Profile', () => {
  it('offers nothing at all while the feature is off', async () => {
    await authenticate();
    routes = { 'GET /api/v1/students/me/talent-pool': () => ({ body: { talentPool: { available: false, optedIn: false, discoverable: false, consent: null, listing: null, roster: null, skills: [], invitations: [], blocks: [] } } }) };
    const { container } = render(<StudentTalentPoolCard />);
    await waitFor(() => expect(calls.some((call) => call.path === '/api/v1/students/me/talent-pool')).toBe(true));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: /add me to the talent pool/i })).not.toBeInTheDocument();
  });

  it('still lets someone who joined while it was on leave, while it is off', async () => {
    await authenticate();
    routes = {
      'GET /api/v1/students/me/talent-pool': () => ({ body: { talentPool: { available: false, optedIn: true, discoverable: false, consent: null, listing: null, roster: null, skills: [], invitations: [], blocks: [] } } }),
      'DELETE /api/v1/students/me/talent-pool': () => ({ body: { talentPool: { available: false, optedIn: false, discoverable: false, consent: null, listing: null, roster: null, skills: [], invitations: [], blocks: [] } } }),
    };
    render(<StudentTalentPoolCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Leave the talent pool' }));
    await waitFor(() => expect(sent('DELETE', '/students/me/talent-pool')).toHaveLength(1));
  });

  it('joins only by the explicit agreement, sending the notice version and exactly what was ticked', async () => {
    await authenticate();
    routes = {
      'GET /api/v1/students/me/talent-pool': () => ({ body: { talentPool: studentPool() } }),
      'PUT /api/v1/students/me/talent-pool': () => ({ body: { talentPool: joined() } }),
    };
    render(<StudentTalentPoolCard />);
    expect(await screen.findByRole('heading', { name: 'Let verified employers find me in the talent pool' })).toBeInTheDocument();
    expect(screen.getByText(/You are not in the talent pool/)).toBeInTheDocument();
    expect(screen.getByText(/Never your name, email, phone, photo, college, marks, scores or readiness/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /My branch: Computer Science/ }));
    fireEvent.change(screen.getByLabelText(/Cities I would like to work in/), { target: { value: 'Chennai, Pune' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Institution exam/ }));
    // The preview is the card as an employer would see it.
    const preview = screen.getByLabelText('Your card, as employers see it');
    expect(within(preview).getByText('Synthetic SQL')).toBeInTheDocument();
    expect(within(preview).getByText(/Branch: Computer Science · Graduation year: hidden · Cities: Chennai, Pune/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I agree — add me to the talent pool' }));
    await waitFor(() => expect(sent('PUT', '/students/me/talent-pool')).toEqual([{
      consentVersion: '2026-10-draft', showBranch: true, showGraduationYear: false, preferredCities: ['Chennai', 'Pune'], evidenceRecordIds: [evidenceB],
    }]));
    expect(await screen.findByText(/Verified employers can now find your card/)).toBeInTheDocument();
    expectNoScores();
  });

  it('saves changes without re-agreeing, says why it is not findable, answers invitations, blocks and leaves', async () => {
    await authenticate();
    const invitation = { id: invitationId, opportunityId, employerName: 'Synthetic Mobility', title: 'Graduate analyst', state: 'SENT', sentAt: '2026-09-28T00:00:00.000Z', expiresAt: '2026-10-12T00:00:00.000Z', respondedAt: null };
    routes = {
      'GET /api/v1/students/me/talent-pool': () => ({ body: { talentPool: joined({ discoverable: false, visibility: 'INSTITUTION_VISIBLE', invitations: [invitation] }) } }),
      'PUT /api/v1/students/me/talent-pool': () => ({ body: { talentPool: joined({ invitations: [invitation] }) } }),
      [`POST /api/v1/students/me/talent-pool/invitations/${invitationId}/decline`]: () => ({ body: { talentPool: joined({ invitations: [{ ...invitation, state: 'DECLINED' }] }) } }),
      'GET /api/v1/students/me/talent-pool/employers': () => ({ body: { employers: [{ employerId: blockedId, name: 'Synthetic Current Employer' }] } }),
      'POST /api/v1/students/me/talent-pool/blocks': () => ({ body: { talentPool: joined({ blocks: [{ employerId: blockedId, employerName: 'Synthetic Current Employer', blockedAt: '2026-09-30T00:00:00.000Z' }] }) } }),
      'DELETE /api/v1/students/me/talent-pool': () => ({ body: { talentPool: studentPool() } }),
    };
    render(<StudentTalentPoolCard />);
    expect(await screen.findByText(/your profile visibility is not set to employer discovery/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View the job and apply' })).toHaveAttribute('href', `/student/opportunities?opportunity=${opportunityId}`);

    fireEvent.click(screen.getByRole('button', { name: 'Save my card' }));
    await waitFor(() => expect(sent('PUT', '/students/me/talent-pool')).toHaveLength(1));
    expect(sent('PUT', '/students/me/talent-pool')[0]).not.toHaveProperty('consentVersion');

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText(/Declined. The employer is not told./)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Block an employer by name'), { target: { value: 'Synthetic Cur' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(within(await screen.findByLabelText('Employers to block')).getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(sent('POST', '/students/me/talent-pool/blocks')).toEqual([{ employerId: blockedId }]));
    expect(within(await screen.findByLabelText('Blocked employers')).getByText('Synthetic Current Employer')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Leave the talent pool' }));
    expect(await screen.findByText(/You have left the talent pool/)).toBeInTheDocument();
    expectNoScores();
  });
});

describe('EMP-14 employer: Talent Pool filters, never ranks, and invites without learning who', () => {
  const overview = { available: true, invitableJobs: [{ opportunityId, title: 'Graduate analyst (invite only)', referenceCode: 'R-1', applicationDeadline: null }],
    dailyInvitationLimit: 20, invitationsLeftToday: 19, invitations: [{ title: 'Graduate analyst (invite only)', sentAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-10-13T00:00:00.000Z', status: 'PENDING' }] };

  it('keeps the honest not-available state while the feature is off', async () => {
    await authenticate();
    routes = { [`GET /api/v1/employers/${employerId}/talent-pool`]: () => ({ body: { talentPool: { available: false } } }) };
    render(<EmployerTalentPoolWorkspace employerId={employerId} />);
    expect(await screen.findByRole('heading', { name: 'Not available yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search the talent pool' })).not.toBeInTheDocument();
    expect(calls.filter((call) => call.path.includes('/talent-pool/search'))).toEqual([]);
  });

  it('searches by catalogue skill and filters, shows minimal cards, opens one and invites it to an invite-only job', async () => {
    await authenticate();
    routes = {
      [`GET /api/v1/employers/${employerId}/talent-pool`]: () => ({ body: { talentPool: overview } }),
      [`GET /api/v1/employers/${employerId}/skill-catalogue`]: () => ({ body: { skills: [{ taxonomyTopicId: sqlTopic, name: 'Synthetic SQL' }], nextCursor: null, careerRoles: [] } }),
      [`GET /api/v1/employers/${employerId}/talent-pool/search`]: () => ({ body: { talentPool: { available: true, hasMore: false,
        cards: [{ cardRef, skills: ['Synthetic SQL'], branch: 'Computer Science', graduationYear: null, preferredCities: ['Chennai'] }] } } }),
      [`GET /api/v1/employers/${employerId}/talent-pool/cards/${cardRef}`]: () => ({ body: { talentPool: { available: true, card: {
        cardRef, branch: 'Computer Science', graduationYear: null, preferredCities: ['Chennai'],
        skills: [{ name: 'Synthetic SQL', items: [{ type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: '2026-09-20T00:00:00.000Z', unaided: false }] }] } } } }),
      [`POST /api/v1/employers/${employerId}/talent-pool/invitations`]: () => ({ status: 201, body: { invitation: { status: 'PENDING', expiresAt: '2026-10-14T00:00:00.000Z' } } }),
    };
    render(<EmployerTalentPoolWorkspace employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Search the talent pool' }));
    expect(await screen.findByText(/Choose at least one skill, branch, graduation year or city/)).toBeInTheDocument();
    expect(calls.filter((call) => call.path.includes('/talent-pool/search'))).toEqual([]);

    fireEvent.change(screen.getByLabelText(/Skill \(from the ONE catalogue/), { target: { value: 'SQL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find skill' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Synthetic SQL' }));
    fireEvent.change(screen.getByLabelText('Preferred city'), { target: { value: 'Chennai' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search the talent pool' }));
    const results = await screen.findByLabelText('Matching students');
    const searchCall = calls.find((call) => call.path.includes('/talent-pool/search'))!;
    expect(searchCall.path).toContain(`skill=${sqlTopic}`);
    expect(searchCall.path).toContain('city=Chennai');
    expect(within(results).getByText('Student card abcdef')).toBeInTheDocument();
    expect(within(results).getByText(/Graduation year: not shown/)).toBeInTheDocument();

    fireEvent.click(within(results).getByRole('button', { name: 'Open card' }));
    const opened = await screen.findByLabelText('Student card');
    expect(within(opened).getByText('Aided')).toBeInTheDocument();
    fireEvent.change(within(opened).getByLabelText('Job'), { target: { value: opportunityId } });
    fireEvent.click(within(opened).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(sent('POST', '/talent-pool/invitations')).toEqual([{ cardRef, opportunityId }]));
    expect(await screen.findByText(/You will see who they are only if they apply/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Your invitations')).getByText('No answer yet')).toBeInTheDocument();
    expectNoScores();
    expect(document.body.textContent).not.toMatch(/Synthetic Candidate|@uat\.example\.test|College|Institute/);
  }, 20_000);

  it('explains the daily limit and a card that has left', async () => {
    await authenticate();
    let inviteStatus = 429;
    routes = {
      [`GET /api/v1/employers/${employerId}/talent-pool`]: () => ({ body: { talentPool: overview } }),
      [`GET /api/v1/employers/${employerId}/talent-pool/search`]: () => ({ body: { talentPool: { available: true, hasMore: false, cards: [{ cardRef, skills: [], branch: null, graduationYear: null, preferredCities: [] }] } } }),
      [`GET /api/v1/employers/${employerId}/talent-pool/cards/${cardRef}`]: () => ({ body: { talentPool: { available: true, card: { cardRef, branch: null, graduationYear: null, preferredCities: [], skills: [] } } } }),
      [`POST /api/v1/employers/${employerId}/talent-pool/invitations`]: () => ({ status: inviteStatus, body: { error: { code: inviteStatus === 429 ? 'INVITATION_LIMIT_REACHED' : 'CARD_NOT_AVAILABLE' } } }),
    };
    render(<EmployerTalentPoolWorkspace employerId={employerId} />);
    fireEvent.change(await screen.findByLabelText('Branch'), { target: { value: 'Computer Science' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search the talent pool' }));
    fireEvent.click(within(await screen.findByLabelText('Matching students')).getByRole('button', { name: 'Open card' }));
    const opened = await screen.findByLabelText('Student card');
    expect(within(opened).getByText('This student shows no skill evidence.')).toBeInTheDocument();
    fireEvent.change(within(opened).getByLabelText('Job'), { target: { value: opportunityId } });
    fireEvent.click(within(opened).getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText(/You have used today's invitations/)).toBeInTheDocument();
    inviteStatus = 404;
    fireEvent.click(within(opened).getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findByText('That student is no longer in the talent pool.')).toBeInTheDocument();
  });
});
