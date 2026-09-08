/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import { getAccessToken } from '../auth.js';
import type { ParticipantInterviewDto } from '../api/hiring.js';
import { rolePortals } from '../rolePortalConfig.js';
import { EmployerRecruiterRealityPage } from './employer.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(), getSecurityContext: vi.fn(),
}));
vi.mock('../auth.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../auth.js')>(), getAccessToken: vi.fn(),
}));

const employerId = crypto.randomUUID();
const portal = rolePortals.find((item) => item.key === 'interviewer')!;
const interview: ParticipantInterviewDto = {
  id: crypto.randomUUID(), title: 'Test interview role', roundNumber: 1, mode: 'VIDEO', state: 'SCHEDULED',
  scheduledStart: '2099-10-01T09:00:00Z', scheduledEnd: '2099-10-01T10:00:00Z', consentRevoked: false,
  candidateName: 'Test Candidate', candidateEmail: 'candidate@example.test', institutionStudentId: 'TEST-STUDENT',
  locationDetail: 'Candidate meeting arrangements', joiningLink: 'https://meet.example.test/interview',
  summary: 'Role summary', responsibilities: 'Role responsibilities', canRecordOutcome: true,
};
const base = `/api/v1/employers/${employerId}/my-interviews`;
let rows: readonly ParticipantInterviewDto[];
let brief: ParticipantInterviewDto;
let denyBrief: boolean;

beforeEach(() => {
  const session = crypto.randomUUID();
  vi.mocked(getProtectedAccessToken).mockReturnValue(session);
  vi.mocked(getAccessToken).mockReturnValue(session);
  vi.mocked(getSecurityContext).mockResolvedValue({ userId: crypto.randomUUID(), memberships: [
    { organizationId: employerId, role: 'RECRUITER', scope: { organizationId: employerId, employerId } },
  ] } as Awaited<ReturnType<typeof getSecurityContext>>);
  rows = [interview]; brief = interview; denyBrief = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, window.location.origin).pathname;
    if (path === base && init?.method !== 'POST') return response({ interviews: rows });
    if (path === `${base}/${interview.id}`) return denyBrief ? response({ error: { message: 'Internal upstream failure' } }, 403) : response({ interview: brief });
    if (path === `${base}/${interview.id}/outcome` && init?.method === 'POST') return response({ ok: true });
    throw new Error('Unexpected endpoint');
  }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function response(body: unknown, status = 200) { return { ok: status < 400, status, json: async () => body }; }
function show(routeLabel: string) { return render(<EmployerRecruiterRealityPage portal={portal} routeLabel={routeLabel} />); }
function selectInterview() { fireEvent.change(screen.getByLabelText('Assigned interview'), { target: { value: interview.id } }); }
function paths() { return vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url), window.location.origin).pathname); }

describe('assignment-scoped interviewer screens', () => {
  it.each(['My Interviews', 'Candidate Brief', 'Scorecards'])('dispatches %s to participant APIs without loading the employer pipeline', async (label) => {
    show(label);
    await waitFor(() => expect(paths()).toContain(base));
    if (label === 'My Interviews') expect(await screen.findByText('Test Candidate')).toBeInTheDocument();
    else expect(await screen.findByLabelText('Assigned interview')).toBeInTheDocument();
    expect(paths()).toEqual([base]);
    expect(document.body.textContent).not.toContain(employerId);
    expect(document.body.textContent).not.toContain(interview.id);
  });

  it('loads candidate context only for the explicitly selected assignment', async () => {
    show('Candidate Brief');
    await screen.findByRole('option', { name: /Test interview role/ });
    expect(screen.queryByText('Test Candidate')).not.toBeInTheDocument();
    selectInterview();
    expect(await screen.findByText('Role responsibilities')).toBeInTheDocument();
    expect(screen.getByText(/candidate@example.test/)).toBeInTheDocument();
    expect(paths()).toEqual([base, `${base}/${interview.id}`]);
  });

  it.each(['My Interviews', 'Candidate Brief', 'Scorecards'])('masks all populated identity and contact fields after consent revocation on %s', async (label) => {
    rows = [{ ...interview, consentRevoked: true }]; brief = rows[0]!;
    show(label);
    if (label !== 'My Interviews') { await screen.findByRole('option', { name: /Test interview role/ }); selectInterview(); }
    expect(await screen.findByText('Withdrawn — details no longer shared')).toBeInTheDocument();
    for (const text of ['Test Candidate', 'candidate@example.test', 'TEST-STUDENT', 'Candidate meeting arrangements']) {
      expect(document.body.textContent).not.toContain(text);
    }
    expect(screen.queryByRole('link', { name: 'Open interview meeting' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('submits the scorecard only through the selected participant endpoint', async () => {
    show('Scorecards'); await screen.findByRole('option', { name: /Test interview role/ }); selectInterview();
    fireEvent.change(await screen.findByLabelText('Recommendation'), { target: { value: 'YES' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Clear reasoning.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Your scorecard was recorded.')).toBeInTheDocument();
    const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(new URL(String(posts[0]![0]), window.location.origin).pathname).toBe(`${base}/${interview.id}/outcome`);
    expect(JSON.parse(posts[0]![1]!.body as string)).toEqual({ recommendation: 'YES', strengths: '', concerns: '', notes: 'Clear reasoning.' });
  });

  it('also masks the list row when the brief reveals a more recent consent revocation', async () => {
    brief = { ...interview, consentRevoked: true, canRecordOutcome: false };
    show('My Interviews');
    fireEvent.click(await screen.findByRole('button', { name: 'Candidate brief' }));
    await waitFor(() => expect(screen.getAllByText('Withdrawn — details no longer shared')).toHaveLength(2));
    expect(document.body.textContent).not.toMatch(/Test Candidate|candidate@example.test|TEST-STUDENT/);
  });

  it('keeps scorecard edits during a normal refresh but masks a newly revoked candidate', async () => {
    show('Scorecards'); await screen.findByRole('option', { name: /Test interview role/ }); selectInterview();
    fireEvent.change(await screen.findByLabelText('Notes'), { target: { value: 'Unsaved assessment.' } });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(paths().filter((path) => path === `${base}/${interview.id}`)).toHaveLength(2));
    expect(screen.getByLabelText('Notes')).toHaveValue('Unsaved assessment.');
    rows = [{ ...interview, consentRevoked: true, canRecordOutcome: false }];
    // An older detail response cannot undo the latest list's revoked consent.
    fireEvent(window, new Event('focus'));
    expect(await screen.findByText('Withdrawn — details no longer shared')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Test Candidate');
    expect(screen.queryByLabelText('Notes')).not.toBeInTheDocument();
  });

  it('clears an open brief when the assignment disappears on refresh', async () => {
    show('Candidate Brief'); await screen.findByRole('option', { name: /Test interview role/ }); selectInterview();
    await screen.findByText('Role responsibilities');
    rows = []; fireEvent(window, new Event('focus'));
    expect(await screen.findByText('No interviews are assigned to you.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Test Candidate');
  });

  it('does not expose identity or upstream text when detail authorization is denied', async () => {
    denyBrief = true; show('Candidate Brief'); await screen.findByRole('option', { name: /Test interview role/ }); selectInterview();
    expect(await screen.findByText('This interview is no longer available to you.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Test Candidate|Internal upstream failure/);
  });

  it('does not load interviews without an employer-scoped membership', async () => {
    vi.mocked(getSecurityContext).mockResolvedValue({ userId: crypto.randomUUID(), memberships: [] } as Awaited<ReturnType<typeof getSecurityContext>>);
    show('My Interviews');
    expect(await screen.findByText('You have no active employer membership.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not expose interviews after their scheduled end', async () => {
    rows = [{ ...interview, scheduledStart: '2000-01-01T09:00:00Z', scheduledEnd: '2000-01-01T10:00:00Z' }];
    show('My Interviews');
    expect(await screen.findByText('No interviews are assigned to you.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Test Candidate');
  });
});

describe('recruiter integration entry views', () => {
  it.each([
    ['Interviews', 'INTERVIEW', 'Scheduled interviews', 'interviews'],
    ['Offers', 'OFFER', 'Sent offers', 'offers'],
  ])('keeps %s stage applicants and exposes the delivered record workflow', async (label, stage, recordButton, resource) => {
    const opportunityId = crypto.randomUUID();
    const managementBase = `/api/v1/employers/${employerId}`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path === `${managementBase}/opportunities`) return response({ opportunities: [{ id: opportunityId, title: 'Stage role', lifecycleState: 'PUBLISHED', applicationCount: 1 }] });
      if (path.endsWith('/applications')) return response({ applications: [{ id: crypto.randomUUID(), state: stage, consentRevoked: false, candidateName: 'Stage Candidate', interviewCount: 0, offerState: null }] });
      if (path === `${managementBase}/${resource}`) return response({ [resource]: [{ ...interview, candidateName: 'Record Candidate', state: resource === 'offers' ? 'EXTENDED' : 'SCHEDULED', outcomeCount: 0, compensation: { currency: null, amount: null, period: null } }] });
      throw new Error('Unexpected endpoint');
    }));
    show(label);
    expect(await screen.findByText('Stage Candidate')).toBeInTheDocument();
    expect(screen.getByText((_text, element) => element?.textContent === `Application state filter: ${stage === 'INTERVIEW' ? 'Interview' : 'Offer'}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: recordButton }));
    expect(await screen.findByText('Record Candidate')).toBeInTheDocument();
    expect(screen.queryByText('Stage Candidate')).not.toBeInTheDocument();
    expect(paths()).toContain(`${managementBase}/${resource}`);
  });
});
