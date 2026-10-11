/**
 * Web tests for the "Tutor by college" panel on AI Operations (ENG-25): every college with its tutor state,
 * groups under five shown as <5 with counts withheld, no student identity, switching on files an
 * AI_TUTOR_COLLEGE_ENABLE approval (never switches anything itself), switching off needs a reason, the switch-on
 * control is disabled while no passing evaluation exists, and a malformed reply shows NA rather than a crash.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TutorCollegesPanel } from './tutorRollout.js';

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const metrics = { STEPS_STARTED: 12, QUESTIONS_ANSWERED: 40, QUESTIONS_CORRECT: 30, ANSWERS_ASSISTED: 4, STEPS_COMPLETED: 8, WRITTEN_HINTS_SHOWN: 9, TUTOR_HINTS_REQUESTED: 7, TUTOR_HINTS_SHOWN: 6, TUTOR_HINTS_FALLBACK: 1 };
const on = {
  institutionId: '11111111-1111-4111-8111-111111111111', institutionName: 'Synthetic Pilot College',
  rollout: {
    enabled: true, assignmentMethod: 'sha256-bucket-v1', tutorSharePercent: 50, createdAt: '2026-10-01T00:00:00.000Z', enabledAt: '2026-10-01T00:00:00.000Z',
    changedAt: '2026-10-01T00:00:00.000Z', lastReasonCode: 'PILOT_ROLLOUT', enabledModel: 'fake/model', enabledPrompt: 'tutor-hint@2',
    groups: { TUTOR: { assigned: { suppressed: false, value: 21 }, metrics }, NO_TUTOR: { assigned: { suppressed: true, value: null }, metrics: null } },
  },
};
const off = { institutionId: '22222222-2222-4222-8222-222222222222', institutionName: 'Synthetic Other College', rollout: null };
const listing = (over: Record<string, unknown> = {}) => ({
  status: { pilotAudience: true, featureRegistered: true, featureEnabled: true, killSwitchEngaged: false, evaluationPasses: true },
  colleges: [on, off], days: 30, suppressionThreshold: 5, viewer: { canStop: true, canConfigure: true }, ...over,
});
const policy = { reasons: { tutorCollegeEnable: ['PILOT_ROLLOUT', 'PILOT_EXPANSION'], tutorCollegeDisable: ['QUALITY_CONCERN', 'ROLLBACK'] } };
let response: () => Promise<unknown>;

beforeEach(() => {
  response = () => ok(listing());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST' && path === '/api/v1/operations/approvals') return ok({ approval: { id: 'a-1', state: 'PENDING' } });
    if (init?.method === 'POST') return ok({ enabled: false });
    if (path.startsWith('/api/v1/operations/ai/tutor-colleges')) return response();
    if (path.startsWith('/api/v1/operations/ai/policy')) return ok(policy);
    if (path.startsWith('/api/v1/operations/approvals/policy')) return ok({ actions: [] });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  .map(([url, init]) => [String(url).replace(/^https?:\/\/[^/]+/, ''), JSON.parse(String(init.body))]);

describe('Tutor by college panel', () => {
  it('shows every college, the two groups with small groups withheld, and never a student', async () => {
    render(<TutorCollegesPanel token="t" />);
    const row = (await screen.findByText('Synthetic Pilot College')).closest('tr') as HTMLElement;
    expect(within(row).getByText('On')).toBeInTheDocument();
    expect(within(row).getByText('21')).toBeInTheDocument();
    expect(within(row).getByText('<5')).toBeInTheDocument();
    expect(within(row).getByText('Counts withheld (<5 students)')).toBeInTheDocument();
    expect(within(row).getByText(/50% tutor group · sha256-bucket-v1/)).toBeInTheDocument();
    const other = screen.getByText('Synthetic Other College').closest('tr') as HTMLElement;
    expect(within(other).getByText('Never switched on')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[\w.]+@[\w-]+\.[a-z]{2,}|seed/i);
  });

  it('switching on files an approval bound to the college and changes nothing itself', async () => {
    render(<TutorCollegesPanel token="t" />);
    const other = (await screen.findByText('Synthetic Other College')).closest('tr') as HTMLElement;
    fireEvent.click(within(other).getByRole('button', { name: 'Switch on…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Bound to the tutor’s current model, prompt and passing evaluation/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'PILOT_ROLLOUT' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /request|file/i }));
    expect(await screen.findByText(/Approval requested/)).toBeInTheDocument();
    expect(posts()).toEqual([['/api/v1/operations/approvals', { actionKey: 'AI_TUTOR_COLLEGE_ENABLE', payload: { institutionId: off.institutionId, reasonCode: 'PILOT_ROLLOUT' } }]]);
  });

  it('switching off needs a reason and is immediate', async () => {
    render(<TutorCollegesPanel token="t" />);
    const row = (await screen.findByText('Synthetic Pilot College')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Switch off…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Switch off' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'QUALITY_CONCERN' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    expect(await screen.findByText('The AI tutor is switched off for Synthetic Pilot College.')).toBeInTheDocument();
    expect(posts()).toEqual([[`/api/v1/operations/ai/tutor-colleges/${on.institutionId}/disable`, { reasonCode: 'QUALITY_CONCERN' }]]);
  });

  it('cannot be switched on without a passing evaluation, and says why', async () => {
    response = () => ok(listing({ status: { pilotAudience: false, featureRegistered: true, featureEnabled: false, killSwitchEngaged: false, evaluationPasses: false } }));
    render(<TutorCollegesPanel token="t" />);
    const other = (await screen.findByText('Synthetic Other College')).closest('tr') as HTMLElement;
    expect(within(other).getByRole('button', { name: 'Switch on…' })).toBeDisabled();
    expect(screen.getByText(/no passing evaluation is recorded/)).toBeInTheDocument();
    expect(screen.getByText(/No — set on the server by Divakar/)).toBeInTheDocument();
  });

  it('a viewer sees the state and no controls; a malformed reply says so plainly', async () => {
    response = () => ok(listing({ viewer: { canStop: false, canConfigure: false } }));
    render(<TutorCollegesPanel token="t" />);
    await screen.findByText('Synthetic Pilot College');
    expect(screen.queryByRole('button', { name: /Switch (on|off)…/ })).toBeNull();
    cleanup();
    response = () => ok({ colleges: 'nope' });
    render(<TutorCollegesPanel token="t" />);
    expect(await screen.findByText('The tutor by college could not be read right now.')).toBeInTheDocument();
  });
});
