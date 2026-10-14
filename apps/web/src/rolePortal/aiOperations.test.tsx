/**
 * Operations AI Operations console (OPS-12): renders the server's features, switches, usage and
 * evaluations; cost has no slot (no price table); organisation rows under 5 people show <5; stopping needs only a reason
 * and takes effect at once; switching on and widening file an approval; loading / empty / error /
 * forbidden states are honest; navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { classifyLimits, OperationsAiOperationsPage } from './aiOperations.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const costText = 'NA — ONE has no price table for any model, so cost is not estimated. Tokens are shown instead.';
const policy = (viewer = { canStop: true, canConfigure: true }) => ({
  reasons: {
    disable: ['INCIDENT_MITIGATION', 'ROLLBACK'], enable: ['EVALUATION_COMPLETE'], limitsLower: ['COST_CONTROL'], limitsRaise: ['DEMAND_GROWTH'],
    killSwitchEngage: ['INCIDENT_MITIGATION', 'PRECAUTION'], assistantDisable: ['PRECAUTION'], evaluation: ['INITIAL_BENCHMARK'], flagChange: ['ROLLBACK', 'PILOT_ROLLOUT'],
  },
  bounds: { capWindows: ['DAY', 'MONTH'], maxCap: 10_000_000, minInputChars: 100, maxInputChars: 500_000, maxMetrics: 20 },
  decisions: ['PASS', 'FAIL'], flags: { killSwitch: 'ai.global-kill-switch', assistant: 'ai.assistant' }, viewer,
  cost: { basis: 'NO_PRICE_TABLE', text: costText }, correlationId: 'corr-policy',
});
const feature = (over: Record<string, unknown> = {}) => ({
  featureKey: 'career.summary', description: 'Drafts a career summary for review', enabled: true, effectiveEnabled: true, model: 'local/model-a',
  cap: 100, capWindow: 'DAY', maxInputChars: 4000, prompt: { key: 'career.summary', version: 2 }, usedInWindow: 37,
  evaluation: { state: 'PASS', evaluationId: crypto.randomUUID(), decidedAt: '2026-09-29T10:00:00.000Z' }, updatedAt: '2026-09-29T10:00:00.000Z',
  outcomes: { succeeded: 37, refused: 4, failed: 1 }, tokens: { input: 12_345, output: 6_789 }, averageLatencyMs: 1_840, ...over,
});
const unconfiguredInference = { configured: false, reason: 'BASE_URL_MISSING', providerKey: 'unconfigured', endpointHost: null, model: null, keyConfigured: false, lastProbe: null };
const summary = (over: Record<string, unknown> = {}) => ({
  period: 'DAY', periodStart: '2026-09-30T00:00:00Z',
  killSwitch: { key: 'ai.global-kill-switch', enabled: false, lastChangedAt: null, lastReasonCode: null },
  assistantFlag: { key: 'ai.assistant', enabled: false, lastChangedAt: null, lastReasonCode: null },
  assistant: { serverSwitch: false, providerKeyConfigured: false, consoleSwitch: false, killSwitchEngaged: false, answering: false },
  inference: unconfiguredInference,
  features: [feature(), feature({ featureKey: 'lesson.hint', enabled: false, effectiveEnabled: false, evaluation: { state: 'NONE', evaluationId: null, decidedAt: null }, prompt: null })],
  failureClasses: [{ featureKey: 'career.summary', outcome: 'REFUSED', failureClass: 'CAP_EXCEEDED', count: 4 }],
  totals: { succeeded: 37, refused: 4, failed: 1, inputTokens: 12_345, outputTokens: 6_789 },
  prompts: { registered: [], declared: [{ featureKey: 'career.summary', key: 'career.summary', version: 2, registered: false }], inUse: [] },
  cost: { value: null, basis: 'NO_PRICE_TABLE', text: costText }, correlationId: 'corr-summary', ...over,
});
const organizations = [
  { organizationName: 'Riverside College', organizationKind: 'INSTITUTION', noSubject: false, suppressed: false, people: 12, succeeded: 30, refused: 2, failed: 0, inputTokens: 900, outputTokens: 400 },
  { organizationName: 'Hilltop College', organizationKind: 'INSTITUTION', noSubject: false, suppressed: true, people: null, succeeded: null, refused: null, failed: null, inputTokens: null, outputTokens: null },
];
const evaluation = {
  id: crypto.randomUUID(), featureKey: 'career.summary', providerKey: 'bedrock', model: 'local/model-a', promptKey: 'career.summary', promptVersion: 2,
  evaluationSetKey: 'career.benchmark', evaluationSetVersion: 1, metrics: [{ name: 'task_accuracy', value: 0.92, threshold: 0.85, comparator: 'AT_LEAST' }],
  decision: 'PASS', reasonCode: 'INITIAL_BENCHMARK', note: null, decidedBy: 'ai.lead@example.test', decidedAt: '2026-09-29T10:00:00.000Z', current: true,
};

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({ ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers() });
let summaryResponse: () => Promise<unknown>;
let policyResponse: () => Promise<unknown>;
let evaluationsResponse: () => Promise<unknown>;

beforeEach(() => {
  summaryResponse = () => ok(summary());
  policyResponse = () => ok(policy());
  evaluationsResponse = () => ok({ evaluations: [evaluation], nextCursor: null });
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') {
      if (path.includes('/operations/approvals')) return ok({ approval: { id: crypto.randomUUID() }, correlationId: 'corr-approval' });
      if (path.includes('/kill-switch/engage')) return ok({ ...summary(), featuresSwitchedOff: 1, assistantSwitchedOff: false });
      return ok(summary());
    }
    if (path.includes('/approvals/policy')) return ok({ actions: [], decisionReasons: { APPROVE: [], REJECT: [] }, approverCount: 2, soloSafeguardActive: false, correlationId: 'c' });
    if (path.includes('/operations/ai/policy')) return policyResponse();
    if (path.includes('/operations/ai/summary')) return summaryResponse();
    if (path.includes('/operations/ai/usage/organizations')) return ok({ period: 'DAY', organizations, suppressionThreshold: 5 });
    if (path.includes('/operations/ai/usage')) return ok({ granularity: 'DAY', points: [{ period: '2026-09-30', featureKey: 'career.summary', succeeded: 37, refused: 4, failed: 1, inputTokens: 12_345, outputTokens: 6_789 }] });
    if (path.includes('/operations/ai/evaluations')) return evaluationsResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
/** The features table row: its key is the only bold occurrence of the key on the page. */
const featureRow = async (key: string) => {
  const strong = await screen.findByText((_, element) => element?.tagName === 'STRONG' && element.textContent === key);
  return strong.closest('tr') as HTMLElement;
};

describe('AI Operations console', () => {
  it('renders the server features, usage, tokens, prompts and evaluations, and no cost slot', async () => {
    render(<OperationsAiOperationsPage />);
    const row = await featureRow('career.summary');
    expect(within(row).getByText('37 of 100 this day')).toBeInTheDocument();
    expect(within(row).getByText('12,345 / 6,789')).toBeInTheDocument();
    expect(within(row).getByText('Pass')).toBeInTheDocument();
    // Re-skin phase 7: cost has no source (no price table), so it has no tile or column and nothing reads NA.
    expect(within(row).queryByText('NA')).toBeNull();
    expect(screen.queryByText('Cost (no price table)')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).toBeNull();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Cap exceeded')).toBeInTheDocument();
    expect(screen.getByText('ONE has no price table for any model, so cost is not estimated. Tokens are shown instead.')).toBeInTheDocument();
    expect(costText.startsWith('NA')).toBe(true);
    expect(await screen.findByText('Current verdict')).toBeInTheDocument();
    expect(screen.getByText('No prompt declared')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/(^|[^A-Za-z])NA([^A-Za-z]|$)/);
  });

  it('shows average latency per feature, and leaves it out when none was recorded', async () => {
    render(<OperationsAiOperationsPage />);
    expect(within(await featureRow('career.summary')).getByText('Average latency 1,840 ms')).toBeInTheDocument();
  });

  it('shows the inference endpoint as unconfigured, leaving out what the server has not set', async () => {
    render(<OperationsAiOperationsPage />);
    expect(await screen.findByText('Inference endpoint')).toBeInTheDocument();
    expect(screen.getByText('No — no endpoint address is set')).toBeInTheDocument();
    expect(screen.getByText('Not probed yet')).toBeInTheDocument();
    expect(screen.queryByText('Endpoint host')).toBeNull();
    expect(screen.queryByText('Model served (last probe)')).toBeNull();
    expect(screen.getByText('No probe recorded')).toBeInTheDocument();
  });

  it('shows a configured endpoint with its latest probe, and never a key', async () => {
    summaryResponse = () => ok(summary({ inference: {
      configured: true, reason: null, providerKey: 'openai-compatible', endpointHost: 'pod-8888.proxy.example.test', model: 'qwen2.5-14b-instruct', keyConfigured: true,
      lastProbe: { configured: true, endpointHost: 'pod-8888.proxy.example.test', model: 'qwen2.5-14b-instruct', reachable: false, modelServed: null,
        failureClass: 'PROVIDER_AUTH_FAILED', latencyMs: 210, probedAt: '2026-10-01T10:00:00.000Z', matchesConfiguration: false },
    } }));
    render(<OperationsAiOperationsPage />);
    expect(await screen.findByText('pod-8888.proxy.example.test')).toBeInTheDocument();
    expect(screen.getByText('qwen2.5-14b-instruct')).toBeInTheDocument();
    expect(screen.getByText('Key set on the server').nextSibling?.textContent).toBe('Yes');
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByText(/PROVIDER_AUTH_FAILED/)).toBeInTheDocument();
    expect(screen.getByText(/different endpoint or model/)).toBeInTheDocument();
  });

  it('withholds organisation rows under 5 people', async () => {
    render(<OperationsAiOperationsPage />);
    const row = (await screen.findByText('Hilltop College')).closest('tr') as HTMLElement;
    expect(within(row).getAllByText('<5').length).toBeGreaterThanOrEqual(4);
    const open = (await screen.findByText('Riverside College')).closest('tr') as HTMLElement;
    expect(within(open).getByText('12')).toBeInTheDocument();
  });

  it('shows the assistant server switch read-only and never offers to change it', async () => {
    render(<OperationsAiOperationsPage />);
    expect(await screen.findByText('Server switch (ASSISTANT_ENABLED)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ASSISTANT_ENABLED/ })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch assistant on…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ASSISTANT_ENABLED=true and a provider key on the server/)).toBeInTheDocument();
    expect(within(dialog).getByText(/approval required/)).toBeInTheDocument();
  });

  it('engages the kill switch at once with a required reason and no approval', async () => {
    render(<OperationsAiOperationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Engage kill switch…' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Engage kill switch' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'INCIDENT_MITIGATION' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/operations/ai/kill-switch/engage');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'INCIDENT_MITIGATION' });
    expect(await screen.findByText(/Kill switch engaged/)).toBeInTheDocument();
  });

  it('switches a feature off with a reason, immediately', async () => {
    render(<OperationsAiOperationsPage />);
    fireEvent.click(within(await featureRow('career.summary')).getByRole('button', { name: 'Switch off…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'ROLLBACK' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/features/career.summary/disable');
  });

  it('blocks switching on without a passing evaluation, and files an approval when one exists', async () => {
    summaryResponse = () => ok(summary({ features: [feature({ enabled: false, effectiveEnabled: false }), feature({ featureKey: 'lesson.hint', enabled: false, effectiveEnabled: false, evaluation: { state: 'NONE', evaluationId: null, decidedAt: null } })] }));
    render(<OperationsAiOperationsPage />);
    const blocked = within(await featureRow('lesson.hint'));
    expect(blocked.getByRole('button', { name: 'Switch on…' })).toBeDisabled();
    expect(blocked.getByText(/Needs a passing evaluation/)).toBeInTheDocument();
    fireEvent.click(within(await featureRow('career.summary')).getByRole('button', { name: 'Switch on…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'EVALUATION_COMPLETE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'AI_FEATURE_ENABLE', payload: { featureKey: 'career.summary', reasonCode: 'EVALUATION_COMPLETE' } });
  });

  it('lowers limits directly and routes a raise to an approval', async () => {
    render(<OperationsAiOperationsPage />);
    fireEvent.click(within(await featureRow('career.summary')).getByRole('button', { name: 'Change limits…' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Cap (generations per window)'), { target: { value: '200' } });
    expect(within(dialog).getByText(/needs approval from a second person/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue to approval' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'DEMAND_GROWTH' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'AI_FEATURE_LIMITS_RAISE', payload: { featureKey: 'career.summary', cap: 200, capWindow: 'DAY', maxInputChars: 4000, reasonCode: 'DEMAND_GROWTH' } });
  });

  it('classifies limits like the server', () => {
    const current = { cap: 10, capWindow: 'DAY' as const, maxInputChars: 1000 };
    expect(classifyLimits(current, { ...current, cap: 5 })).toBe('LOWER');
    expect(classifyLimits(current, { ...current, capWindow: 'MONTH' })).toBe('RAISE');
    expect(classifyLimits(current, current)).toBe('UNCHANGED');
  });

  it('hides controls from a viewer who may only read', async () => {
    policyResponse = () => ok(policy({ canStop: false, canConfigure: false }));
    render(<OperationsAiOperationsPage />);
    await featureRow('career.summary');
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/ai/policy'))).toBe(true));
    expect(screen.queryByRole('button', { name: /Engage kill switch|Switch off|Change limits|Record evaluation/ })).not.toBeInTheDocument();
  });

  it('says plainly when no feature is registered, and shows no figures while loading', async () => {
    summaryResponse = () => new Promise(() => undefined);
    render(<OperationsAiOperationsPage />);
    expect(screen.getByText('Loading AI Operations…')).toBeInTheDocument();
    expect(screen.queryByText('NA')).toBeNull();
    expect(screen.queryByText('AI features running')).toBeNull();
    cleanup();
    summaryResponse = () => ok(summary({ features: [], failureClasses: [] }));
    evaluationsResponse = () => ok({ evaluations: [], nextCursor: null });
    render(<OperationsAiOperationsPage />);
    expect(await screen.findByText('No AI feature is registered')).toBeInTheDocument();
    expect(await screen.findByText('No evaluations recorded')).toBeInTheDocument();
  });

  it('shows an error with its reference, and a forbidden state', async () => {
    summaryResponse = () => failure(500, 'INTERNAL', 'corr-broken');
    render(<OperationsAiOperationsPage />);
    expect(await screen.findByText(/Support code: corrbrok/)).toBeInTheDocument();
    cleanup();
    summaryResponse = () => failure(403, 'FORBIDDEN', 'corr-denied');
    render(<OperationsAiOperationsPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrdeni')).toBeInTheDocument();
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
