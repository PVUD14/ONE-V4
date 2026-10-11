/**
 * EMP-09 on the web: reason-coded reschedules and cancellations, the interview history, templated
 * scorecards, the scorecard-template screen inside Interviews, and "Add to calendar" for the
 * student. Real API shapes, stubbed fetch; nothing here invents data the API did not send.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeHostedLoginFromLocation } from './auth.js';
import { EmployerInterviewsPage, StudentInterviewsPanel } from './hiringPages.js';
import { ScorecardTemplatesPanel } from './interviewScheduling.js';

const employerId = '44444444-4444-4444-8444-444444444444';
const base = `/api/v1/employers/${employerId}`;
const template = {
  id: '66666666-6666-4666-8666-666666666666', name: 'Technical round', guidance: 'Rate what you observed.', retiredAt: null,
  criteria: [
    { id: '77777777-7777-4777-8777-777777777771', position: 1, label: 'Problem solving', guidance: 'Breaks the problem down.' },
    { id: '77777777-7777-4777-8777-777777777772', position: 2, label: 'Communication', guidance: null },
  ],
};
const interview = {
  id: 'interview-a', applicationId: 'application-a', applicationState: 'INTERVIEW', opportunityId: 'opportunity-a', referenceCode: null,
  title: 'Robotics engineer', consentRevoked: false, candidateAccess: true, candidateName: 'Test Candidate', candidateEmail: 'candidate@example.test',
  institutionStudentId: null, roundNumber: 1, mode: 'VIDEO', state: 'RESCHEDULED', scheduledStart: '2099-10-01T09:30:00Z', scheduledEnd: '2099-10-01T10:15:00Z',
  locationDetail: null, joiningLink: null, joiningLinkWithheld: true, stageLabel: 'Technical interview',
  scorecardTemplate: { id: template.id, name: template.name }, lastChange: { kind: 'RESCHEDULED', reasonCode: 'CANDIDATE_REQUESTED', at: '2099-09-01T00:00:00Z' },
  submittedAt: null, closedAt: null, outcomeCount: 1, createdAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.stubEnv('VITE_COGNITO_DOMAIN', 'https://uat-auth.example.test');
  vi.stubEnv('VITE_COGNITO_CLIENT_ID', 'uat-client');
  vi.stubEnv('VITE_COGNITO_REDIRECT_URI', 'http://127.0.0.1:5173/auth/callback');
});
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); window.history.pushState(null, '', '/'); });

function stubFetch(routes: Readonly<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'test-access-token' }) };
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] ?? '';
    const match = Object.keys(routes).find((route) => path === route);
    if (path.endsWith('/calendar')) {
      return { ok: true, status: 200, headers: new Headers({ 'content-disposition': 'attachment; filename="interview-robotics-engineer-round-1.ics"' }), blob: async () => new Blob(['BEGIN:VCALENDAR']) };
    }
    return { ok: true, status: 200, headers: new Headers(), json: async () => (match ? routes[match] : {}) };
  }));
}
async function authenticate(): Promise<void> {
  window.sessionStorage.setItem('planthepath.oauthState', 'state-123');
  window.sessionStorage.setItem('planthepath.oauthVerifier', 'verifier-12345678901234567890');
  window.history.pushState(null, '', '/auth/callback?code=code-123&state=state-123');
  await completeHostedLoginFromLocation();
}
function posts(suffix: string): unknown[] {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)));
}

describe('EMP-09 interviews for employers', () => {
  it('shows the stage and the last change with its reason, and the history of every change', async () => {
    stubFetch({
      [`${base}/interviews`]: { interviews: [interview] },
      [`${base}/scorecard-templates`]: { templates: [template] },
      [`${base}/interviews/${interview.id}/history`]: { revisions: [
        { revisionNumber: 1, changeKind: 'SCHEDULED', reasonCode: null, note: null, mode: 'VIDEO', scheduledStart: '2099-09-30T09:30:00Z', scheduledEnd: '2099-09-30T10:15:00Z', locationDetail: null, joiningLink: null, actorLabel: 'recruiter@example.test', recordedAt: '2099-08-01T00:00:00Z' },
        { revisionNumber: 2, changeKind: 'RESCHEDULED', reasonCode: 'CANDIDATE_REQUESTED', note: 'Exam that morning.', mode: 'VIDEO', scheduledStart: '2099-10-01T09:30:00Z', scheduledEnd: '2099-10-01T10:15:00Z', locationDetail: null, joiningLink: null, actorLabel: 'owner@example.test', recordedAt: '2099-09-01T00:00:00Z' },
      ] },
    });
    await authenticate(); render(<EmployerInterviewsPage employerId={employerId} />);
    expect(await screen.findByText('Rescheduled — The candidate asked')).toBeInTheDocument();
    expect(screen.getByText(/Technical interview/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    const history = await screen.findByRole('region', { name: 'Interview history' });
    await within(history).findByText('Note: Exam that morning.');
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(history.textContent).toContain('by owner@example.test');
  });

  it('asks for every criterion of the stage template on a scorecard and posts one rating each', async () => {
    stubFetch({ [`${base}/interviews`]: { interviews: [{ ...interview, state: 'COMPLETED' }] }, [`${base}/scorecard-templates`]: { templates: [template] }, [`${base}/interviews/${interview.id}/outcome`]: { ok: true } });
    await authenticate(); render(<EmployerInterviewsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record outcome' }));
    await screen.findByRole('group', { name: 'Problem solving' });
    expect(screen.getByText('Breaks the problem down.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Recommendation'), { target: { value: 'YES' } });
    fireEvent.change(screen.getByLabelText('Problem solving (1–5)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Communication (1–5)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Note on Communication (optional)'), { target: { value: 'Rushed the summary.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(posts('/outcome')).toHaveLength(1));
    expect(posts('/outcome')[0]).toMatchObject({ recommendation: 'YES', criteria: [
      { criterionId: template.criteria[0]!.id, rating: 4 }, { criterionId: template.criteria[1]!.id, rating: 3, note: 'Rushed the summary.' }] });
  });

  it('shows each interviewer\'s ratings per criterion and never a total', async () => {
    stubFetch({
      [`${base}/interviews`]: { interviews: [interview] },
      [`${base}/interviews/${interview.id}/scorecards`]: { template, scorecards: [{ submittedBy: 'panel@example.test', recommendation: 'STRONG_YES', overallRating: null, strengths: null, concerns: null, notes: null, submittedAt: '2099-10-01T11:00:00Z',
        ratings: [{ criterionId: template.criteria[0]!.id, label: 'Problem solving', rating: 5, note: null }, { criterionId: template.criteria[1]!.id, label: 'Communication', rating: 4, note: 'Clear.' }] }] },
    });
    await authenticate(); render(<EmployerInterviewsPage employerId={employerId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Scorecards' }));
    const panel = await screen.findByRole('region', { name: 'Interview scorecards' });
    expect(await within(panel).findByText('Problem solving: 5 of 5')).toBeInTheDocument();
    expect(within(panel).getByText('Communication: 4 of 5 — Clear.')).toBeInTheDocument();
    expect(within(panel).getByText(/Overall rating: NA/)).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/average|total|score of|rank/i);
  });

  it('creates a scorecard template with its criteria', async () => {
    stubFetch({ [`${base}/scorecard-templates`]: { templates: [] } });
    await authenticate(); render(<ScorecardTemplatesPanel employerId={employerId} />);
    expect(await screen.findByText(/No scorecard templates yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New scorecard template' }));
    const form = screen.getByRole('form', { name: 'New scorecard template' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Technical round' } });
    fireEvent.change(within(within(form).getByRole('group', { name: 'Criterion 1' })).getByLabelText('Criterion'), { target: { value: 'Problem solving' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add a criterion' }));
    fireEvent.change(within(within(form).getByRole('group', { name: 'Criterion 2' })).getByLabelText('Criterion'), { target: { value: 'Communication' } });
    fireEvent.change(within(within(form).getByRole('group', { name: 'Criterion 2' })).getByLabelText('Guidance (optional)'), { target: { value: 'Explains trade-offs.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save template' }));
    await waitFor(() => expect(posts('/scorecard-templates')).toHaveLength(1));
    expect(posts('/scorecard-templates')[0]).toEqual({ name: 'Technical round', criteria: [{ label: 'Problem solving' }, { label: 'Communication', guidance: 'Explains trade-offs.' }] });
  });
});

describe('EMP-09 interviews for students', () => {
  const student = {
    id: 'interview-s', employerName: 'Acme Robotics', title: 'Robotics engineer', roundNumber: 1, stageLabel: null, applicationState: 'INTERVIEW',
    mode: 'VIDEO', state: 'RESCHEDULED', upcoming: true, scheduledStart: '2099-10-01T09:30:00Z', scheduledEnd: '2099-10-01T10:15:00Z',
    locationDetail: null, joiningLink: 'https://meet.example.test/room', preparationNote: null,
  };

  it('offers Add to calendar for an upcoming or cancelled interview, not a past one, and fetches the invite', async () => {
    stubFetch({ '/api/v1/students/me/interviews': { interviews: [
      student, { ...student, id: 'interview-c', state: 'CANCELLED', upcoming: false, joiningLink: null },
      { ...student, id: 'interview-p', state: 'COMPLETED', upcoming: false, joiningLink: null, scheduledStart: '2020-01-01T09:00:00Z' },
    ] } });
    const createObjectURL = vi.fn(() => 'blob:calendar'); const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    await authenticate(); render(<StudentInterviewsPanel />);
    const upcoming = await screen.findByRole('list', { name: 'Upcoming interviews' });
    const past = screen.getByRole('list', { name: 'Past interviews' });
    expect(within(past).getAllByRole('button', { name: 'Add to calendar' })).toHaveLength(1);
    fireEvent.click(within(upcoming).getByRole('button', { name: 'Add to calendar' }));
    expect(await within(upcoming).findByText(/Calendar file downloaded/)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/api/v1/students/me/interviews/interview-s/calendar'))).toBe(true);
  });
});
