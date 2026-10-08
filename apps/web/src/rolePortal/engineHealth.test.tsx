/**
 * Adaptive engine health panels (OPS-13): the AI Operations panels render the planner and mastery
 * shadow figures the server sends, withheld counts as <5 and absent ones as NA; the System Health
 * panels render the calibration job's status and the sandbox as NA; loading, error (with its
 * reference) and forbidden states are honest; the window choice asks the server again; navigation
 * labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rolePortals } from '../rolePortalConfig.js';
import { engineCount, EngineBehaviourPanels, EngineJobsPanels } from './engineHealth.js';

const withheld = { suppressed: true, value: null };
const shown = (value: number) => ({ suppressed: false, value });
const comparison = (over: Record<string, unknown> = {}) => ({
  pairsCompared: shown(120), unchanged: shown(80), movedUp: shown(25), movedDown: shown(15),
  becameNotEnoughEvidence: withheld, leftNotEnoughEvidence: withheld, studentsWithAnyChange: shown(31), ...over,
});
const behaviour = (over: Record<string, unknown> = {}) => ({
  planner: {
    windowDays: 14,
    days: [{ day: '2026-09-29', decisions: withheld }, { day: '2026-09-30', decisions: shown(64) }],
    decisions: shown(170), overridden: shown(50), overrideRate: 0.2941, active: true, policyVersions: ['learning-orchestrator-v1'],
  },
  masteryShadow: {
    consentOffered: true, suppressed: false, studentsInScope: shown(42),
    algorithms: { live: 'career-readiness-mastery-v1', engineBand: 'learning-model-v1', projector: 'learner-skill-state-v2', shadow: 'mastery-bkt-v1' },
    coverage: { pairsWithBothBands: shown(120), livePairsWithoutEngineRow: shown(9), engineRowsWithoutLiveBand: withheld, engineRowsOnOlderProjector: withheld },
    c3Adoption: comparison(), bkt: comparison({ movedUp: shown(44), movedDown: withheld }),
  },
  suppressionThreshold: 5, correlationId: 'corr-engine', ...over,
});
const jobs = (over: Record<string, unknown> = {}) => ({
  calibration: {
    status: 'OVERDUE', expectedIntervalDays: 31, overdueAfterDays: 38, runsRecorded: 3,
    lastRun: {
      algorithmId: 'item-calibration-2pl-v1', library: 'girth 0.8.0', minResponses: 30,
      exportedAt: '2026-09-20T20:00:00.000Z', generatedAt: '2026-09-20T21:00:00.000Z', recordedAt: '2026-09-20T22:00:00.000Z', ageDays: 10,
      learnersRead: shown(40), responsesRead: 480, itemsRead: 7, items: { calibrated: 5, provisional: 2, provisionalByReason: { TOO_FEW_RESPONSES: 2 } },
    },
  },
  sandbox: { state: 'NOT_BUILT', available: null, rejectedExecutions: null },
  correlationId: 'corr-jobs', ...over,
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({ ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers() });
let behaviourResponse: () => Promise<unknown>;
let jobsResponse: () => Promise<unknown>;

beforeEach(() => {
  behaviourResponse = () => ok(behaviour());
  jobsResponse = () => ok(jobs());
  fetchMock.mockReset().mockImplementation((url: string) => {
    const path = String(url);
    if (path.includes('/operations/ai/engine-health')) return behaviourResponse();
    if (path.includes('/operations/jobs/engine-health')) return jobsResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('engine counts', () => {
  it('shows NA for an absent figure, <5 for a withheld one, and the value otherwise', () => {
    expect(engineCount(null)).toBe('NA');
    expect(engineCount(undefined)).toBe('NA');
    expect(engineCount(withheld)).toBe('<5');
    expect(engineCount(shown(1200))).toBe((1200).toLocaleString());
  });
});

describe('AI Operations: learning engine panels', () => {
  it('renders the planner and shadow figures from the server, withheld cells as <5', async () => {
    render(<EngineBehaviourPanels token="t" />);
    expect(await screen.findAllByText('29.4%')).toHaveLength(2);
    expect(screen.getByText('Planner decisions, last 14 days', { selector: 'small' }).previousSibling).toHaveTextContent('170');
    expect(screen.getByText('Students in the mastery shadow', { selector: 'small' }).previousSibling).toHaveTextContent('42');
    expect(screen.getByText('learning-orchestrator-v1')).toBeInTheDocument();

    const planner = screen.getByRole('region', { name: 'Planner decisions per day' });
    const rows = within(planner).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('2026-09-29<5');
    expect(rows[2]).toHaveTextContent('2026-09-3064');

    const shadow = screen.getByRole('region', { name: 'Mastery shadow comparison' });
    expect(within(shadow).getByRole('row', { name: /Would move up/ })).toHaveTextContent('Would move up2544');
    expect(within(shadow).getByRole('row', { name: /Would move down/ })).toHaveTextContent('Would move down15<5');
    expect(within(shadow).getByText('Live bands without an engine row').nextSibling).toHaveTextContent('9');
    // No student, topic or college is ever on this panel; readiness is not a number here.
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('asks the server again when the window changes', async () => {
    render(<EngineBehaviourPanels token="t" />);
    await screen.findAllByText('29.4%');
    fireEvent.change(screen.getByLabelText('Planner window'), { target: { value: '30' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/operations/ai/engine-health?days=30'))).toBe(true));
  });

  it('says plainly when adaptive learning is not offered, and when the shadow is withheld under five', async () => {
    behaviourResponse = () => ok(behaviour({
      planner: { windowDays: 14, days: [{ day: '2026-09-30', decisions: withheld }], decisions: withheld, overridden: withheld, overrideRate: null, active: false, policyVersions: [] },
      masteryShadow: { ...behaviour().masteryShadow, consentOffered: false, suppressed: true, studentsInScope: withheld, coverage: null, c3Adoption: null, bkt: null },
    }));
    const { unmount } = render(<EngineBehaviourPanels token="t" />);
    expect(await screen.findByText('Not offered yet')).toBeInTheDocument();
    expect(screen.getByText('No planner decisions in this window')).toBeInTheDocument();
    // An idle planner has no rate at all: NA in the same slot, not a dropped tile.
    expect(screen.getByText('Faculty override rate', { selector: 'small' }).previousSibling).toHaveTextContent('NA');
    expect(screen.getByText('Planner policy in use', { selector: 'small' }).previousSibling).toHaveTextContent('NA');
    unmount();

    behaviourResponse = () => ok(behaviour({ masteryShadow: { ...behaviour().masteryShadow, suppressed: true, studentsInScope: withheld, coverage: null, c3Adoption: null, bkt: null } }));
    render(<EngineBehaviourPanels token="t" />);
    expect(await screen.findByText('Withheld')).toBeInTheDocument();
    expect(screen.getByText('Students in the mastery shadow', { selector: 'small' }).previousSibling).toHaveTextContent('<5');
  });

  it('shows NA in every slot when the server sends nothing usable', async () => {
    behaviourResponse = () => ok({});
    render(<EngineBehaviourPanels token="t" />);
    await waitFor(() => expect(screen.queryByText('Loading learning engine health…')).not.toBeInTheDocument());
    expect(screen.getByText('Planner decisions, last 14 days', { selector: 'small' }).previousSibling).toHaveTextContent('NA');
    expect(screen.getByText('Faculty override rate', { selector: 'small' }).previousSibling).toHaveTextContent('NA');
  });

  it('shows loading, then an error with its reference', async () => {
    let fail: (value: unknown) => void = () => undefined;
    behaviourResponse = () => new Promise((resolve) => { fail = resolve; });
    render(<EngineBehaviourPanels token="t" />);
    expect(screen.getByText('Loading learning engine health…')).toBeInTheDocument();
    fail(await failure(500, 'INTERNAL', 'corr-engine-error'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference: corr-engine-error');
  });

  it('shows forbidden with its reference, and no figures', async () => {
    behaviourResponse = () => failure(403, 'FORBIDDEN', 'corr-engine-forbidden');
    render(<EngineBehaviourPanels token="t" />);
    expect(await screen.findByText(/Not permitted: these panels need AI Operations View\. Reference: corr-engine-forbidden/)).toBeInTheDocument();
    expect(screen.queryByText('29.4%')).not.toBeInTheDocument();
  });
});

describe('System Health: learning engine jobs panels', () => {
  it('renders the last calibration run and its status, and the sandbox as NA', async () => {
    render(<EngineJobsPanels token="t" />);
    expect(await screen.findByText('Overdue')).toBeInTheDocument();
    const calibration = screen.getByRole('heading', { name: 'Item calibration job' }).closest('section')!;
    expect(within(calibration).getByText('Items calibrated').nextSibling).toHaveTextContent('5');
    expect(within(calibration).getByText('Items still provisional').nextSibling).toHaveTextContent('2');
    expect(within(calibration).getByText('Learners read').nextSibling).toHaveTextContent('40');
    expect(within(calibration).getByText('Runs recorded').nextSibling).toHaveTextContent('3');
    expect(within(calibration).getByText('too few responses: 2')).toBeInTheDocument();
    const sandbox = screen.getByRole('heading', { name: 'Code sandbox' }).closest('section')!;
    expect(within(sandbox).getByText('Not built')).toBeInTheDocument();
    expect(within(sandbox).getByText('Available').nextSibling).toHaveTextContent('NA');
    expect(within(sandbox).getByText('Rejected executions').nextSibling).toHaveTextContent('NA');
  });

  it('shows a run that never happened as NA, and a small run\'s learners as <5', async () => {
    jobsResponse = () => ok(jobs({ calibration: { status: 'NO_RUN', expectedIntervalDays: 31, overdueAfterDays: 38, runsRecorded: 0, lastRun: null } }));
    const { unmount } = render(<EngineJobsPanels token="t" />);
    expect(await screen.findByText('No run recorded')).toBeInTheDocument();
    const calibration = screen.getByRole('heading', { name: 'Item calibration job' }).closest('section')!;
    expect(within(calibration).getByText('Items calibrated').nextSibling).toHaveTextContent('NA');
    expect(within(calibration).getByText('Last run imported').nextSibling).toHaveTextContent('NA');
    expect(within(calibration).getByText('Runs recorded').nextSibling).toHaveTextContent('0');
    unmount();

    const small = jobs();
    jobsResponse = () => ok({ ...small, calibration: { ...small.calibration, status: 'CURRENT', lastRun: { ...small.calibration.lastRun, learnersRead: withheld, responsesRead: null } } });
    render(<EngineJobsPanels token="t" />);
    expect(await screen.findByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Learners read').nextSibling).toHaveTextContent('<5');
    expect(screen.getByText('Responses read').nextSibling).toHaveTextContent('<5');
  });

  it('shows an error with its reference and a forbidden reference', async () => {
    jobsResponse = () => failure(500, 'INTERNAL', 'corr-jobs-error');
    const { unmount } = render(<EngineJobsPanels token="t" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference: corr-jobs-error');
    unmount();
    jobsResponse = () => failure(403, 'FORBIDDEN', 'corr-jobs-forbidden');
    render(<EngineJobsPanels token="t" />);
    expect(await screen.findByText('Not permitted. Reference: corr-jobs-forbidden')).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});
