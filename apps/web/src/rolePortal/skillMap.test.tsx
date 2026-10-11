/**
 * Operations Content Management — the skill map editor (OPS-09a): the list renders the
 * server's skills and counts honestly, search sends the filters, writes need a reason code,
 * approving also asks for the rights reason, whoever wrote a revision is never offered its
 * review or publish, a publish that changes readiness inputs only files an approval request
 * (and the Approvals queue carries it out), and the loading / NA / empty / error / forbidden
 * states are honest. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsApprovalsPanel } from './approvals.js';
import { OperationsSkillMapPage } from './skillMap.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const viewerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const topicId = crypto.randomUUID();
const revisionId = crypto.randomUUID();

const policy = (viewer: Record<string, unknown> = {}) => ({
  viewer: { edit: true, review: true, publish: true, userId: viewerId, ...viewer },
  levels: [
    { level: 'AWARE', meaning: 'Knows what it is and when it matters' }, { level: 'GUIDED', meaning: 'Does it with help, a checklist or a runbook' },
    { level: 'INDEPENDENT', meaning: 'Does it unaided on ordinary cases' }, { level: 'TROUBLESHOOT', meaning: 'Diagnoses and fixes it when it goes wrong' },
  ],
  licences: [{ licence: 'AI8HT-Owned', attributionRequired: false }, { licence: 'CC-BY-4.0', attributionRequired: true }],
  transitions: { DRAFT: ['IN_REVIEW'], IN_REVIEW: ['CHANGES_REQUESTED', 'APPROVED'], CHANGES_REQUESTED: ['IN_REVIEW'], APPROVED: [], PUBLISHED: [], ARCHIVED: [] },
  reasons: {
    create: ['NEW_SKILL', 'TRACK_BUILD'], revise: ['LEVEL_DESCRIPTORS', 'CORRECTION'], save: ['DRAFT_EDIT'],
    transition: { IN_REVIEW: ['READY_FOR_REVIEW', 'CHANGES_MADE'], CHANGES_REQUESTED: ['LEVELS_UNCLEAR', 'RIGHTS_NOT_CLEARED'], APPROVED: ['REVIEW_PASSED'] },
    rights: ['OWNERSHIP_VERIFIED', 'LICENCE_VERIFIED'], publish: ['NEW_SKILL', 'SKILL_REVISION'], archive: ['OUT_OF_DATE', 'DUPLICATE'],
  },
  limits: { name: 160, description: 1000, level: 500, prerequisites: 20, attribution: 300, basis: 2000, note: 500 },
  correlationId: 'corr-policy',
});

const summaryRow = (over: Record<string, unknown> = {}) => ({
  topicId, stableKey: 'soc-alert-triage', name: 'Alert triage and prioritisation', status: 'PENDING', source: 'AGENT_DRAFTED',
  publishedRevision: null, openRevision: { id: revisionId, revision: 1, state: 'DRAFT' }, prerequisites: ['soc-security-fundamentals'],
  levelsComplete: false, liveRequirementCount: 0, ...over,
});
const levels = { AWARE: 'Knows what an alert is', GUIDED: 'Triages with a runbook', INDEPENDENT: 'Triages unaided', TROUBLESHOOT: 'Finds why a rule misfires' };
const revision = (over: Record<string, unknown> = {}) => ({
  id: revisionId, revision: 1, state: 'DRAFT', contentHash: 'c'.repeat(64), author: { userId: otherId, email: 'importer@example.test' },
  contributors: [{ userId: otherId, email: 'importer@example.test' }], createdAt: '2026-09-26T10:00:00.000Z', publishedAt: null,
  fields: { name: 'Alert triage and prioritisation', description: 'Sorting alerts.', levels, prerequisites: ['soc-security-fundamentals'], licenceLabel: 'AI8HT-Owned', attribution: null, basis: 'NQR Q0909' },
  expertCheck: 'Check the triage steps against the qualification file.', rightsReview: null, ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...summaryRow(), description: 'Sorting alerts.',
  provenance: { generatorVersion: 'agent-model', promptVersion: 'eng-11-soc-analyst-l1-target-v1', generatedAt: '2026-09-26T00:00:00.000Z' },
  current: revision(), open: null,
  prerequisiteSkills: [{ stableKey: 'soc-security-fundamentals', name: 'Security fundamentals', status: 'PENDING' }],
  dependents: [], requiredBy: [], openSetCount: 1, publishNeedsApproval: true, history: [], ...over,
});
const summary = { live: 2, pending: 13, agentDraftedPending: 13, awaitingReview: 1, changesRequested: 0, awaitingPublish: 0 };
const list = (skills: unknown[]) => ({ skills, nextCursor: null, summary, correlationId: 'corr-list' });

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let policyResponse: () => Promise<unknown>;
let listResponse: () => Promise<unknown>;
let detailBody: unknown;

beforeEach(() => {
  policyResponse = () => ok(policy());
  listResponse = () => ok(list([summaryRow(), summaryRow({
    topicId: crypto.randomUUID(), stableKey: 'professional-communication', name: 'Professional communication', status: 'LIVE', source: 'AUTHORED',
    publishedRevision: 1, openRevision: null, prerequisites: [], levelsComplete: true, liveRequirementCount: 5,
  })]));
  detailBody = detail();
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') {
      if (path.includes('/operations/approvals')) return ok({ approval: { id: crypto.randomUUID() }, correlationId: 'corr-approval' });
      return ok({ skill: detailBody, correlationId: 'corr-post' });
    }
    if (path.includes('/operations/approvals/policy')) return ok({ actions: [], decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 2, soloSafeguardActive: false, correlationId: 'corr-ap' });
    if (path.includes('/skill-map/policy')) return policyResponse();
    if (path.includes('/skill-map/skills/')) return ok({ skill: detailBody, correlationId: 'corr-detail' });
    if (path.includes('/skill-map/skills')) return listResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const openSkill = async (): Promise<HTMLElement> => {
  render(<OperationsSkillMapPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open soc-alert-triage' }));
  return screen.findByRole('region', { name: 'Skill soc-alert-triage' });
};

describe('skill map', () => {
  it('renders the server skills and counts, marking agent drafts and unpublished skills plainly', async () => {
    render(<OperationsSkillMapPage />);
    expect(await screen.findByText('Alert triage and prioritisation')).toBeInTheDocument();
    expect(screen.getByText('Agent-drafted')).toBeInTheDocument();
    expect(screen.getByText('Not yet published', { selector: '.status-pill' })).toBeInTheDocument();
    expect(screen.getByText('Live skills').previousSibling?.textContent).toBe('2');
    expect(screen.getByRole('note')).toHaveTextContent('13 unpublished skills were drafted by the coding agent');
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
  });

  it('shows NA in the counts and a loading state until the list arrives', () => {
    listResponse = () => new Promise(() => undefined);
    render(<OperationsSkillMapPage />);
    expect(screen.getByText('Loading the skill map…')).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(4);
  });

  it('says so plainly when nothing matches', async () => {
    listResponse = () => ok(list([]));
    render(<OperationsSkillMapPage />);
    expect(await screen.findByText('No skills match')).toBeInTheDocument();
  });

  it('shows an error with its reference', async () => {
    listResponse = () => failure(500, 'INTERNAL', 'corr-list-fail');
    render(<OperationsSkillMapPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('corr-list-fail');
  });

  it('shows a forbidden state with its reference to staff without a content capability', async () => {
    policyResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    listResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    render(<OperationsSkillMapPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-forbidden')).toBeInTheDocument();
  });

  it('sends the search and filter to the server', async () => {
    render(<OperationsSkillMapPage />);
    await screen.findByText('Alert triage and prioritisation');
    fireEvent.change(screen.getByPlaceholderText('Name or key'), { target: { value: 'triage' } });
    fireEvent.change(screen.getByLabelText('Skill filter'), { target: { value: 'AWAITING_REVIEW' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = String(fetchMock.mock.calls.filter(([url]) => String(url).includes('/skill-map/skills?')).at(-1)?.[0]);
      expect(last).toContain('q=triage');
      expect(last).toContain('filter=AWAITING_REVIEW');
    });
  });

  it('creates a skill only with a valid key and a reason code', async () => {
    render(<OperationsSkillMapPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New skill…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New skill' });
    const submit = within(dialog).getByRole('button', { name: 'Create draft' });
    fireEvent.change(within(dialog).getByLabelText(/Key/), { target: { value: 'soc-new-skill' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'New skill' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'What it is.' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_SKILL' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/api/v1/operations/skill-map/skills');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ stableKey: 'soc-new-skill', name: 'New skill', description: 'What it is.', reasonCode: 'NEW_SKILL' });
  });

  it('edits a draft: the four levels, prerequisites and licence go to the server, and the expert check is shown', async () => {
    const region = await openSkill();
    expect(region).toHaveTextContent('The coding agent (agent-model, eng-11-soc-analyst-l1-target-v1');
    const form = within(region).getByRole('form', { name: 'Edit revision 1' });
    fireEvent.change(within(form).getByLabelText('Troubleshoot level'), { target: { value: 'Explains a false positive' } });
    fireEvent.change(within(form).getByLabelText(/Prerequisites/), { target: { value: 'soc-security-fundamentals, soc-security-monitoring-siem' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/revisions/${revisionId}/draft`);
    expect(JSON.parse(String(posts()[0]![1].body))).toMatchObject({
      levels: { ...levels, TROUBLESHOOT: 'Explains a false positive' }, prerequisites: ['soc-security-fundamentals', 'soc-security-monitoring-siem'],
      licenceLabel: 'AI8HT-Owned', reasonCode: 'DRAFT_EDIT',
    });
  });

  it('approving asks for a reason code and a rights reason, and is not offered to whoever wrote the revision', async () => {
    detailBody = detail({ current: revision({ state: 'IN_REVIEW' }) });
    let region = await openSkill();
    fireEvent.click(within(region).getByRole('button', { name: 'Approve, with rights review…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve revision 1' });
    const submit = within(dialog).getByRole('button', { name: 'Approve revision 1' });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'REVIEW_PASSED' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Rights reason'), { target: { value: 'OWNERSHIP_VERIFIED' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ toState: 'APPROVED', reasonCode: 'REVIEW_PASSED', rightsReasonCode: 'OWNERSHIP_VERIFIED' });
    cleanup();
    detailBody = detail({ current: revision({ state: 'IN_REVIEW', contributors: [{ userId: otherId, email: 'importer@example.test' }, { userId: viewerId, email: 'me@example.test' }] }) });
    region = await openSkill();
    expect(within(region).queryByRole('button', { name: 'Approve, with rights review…' })).not.toBeInTheDocument();
    expect(within(region).getByText('You wrote or edited this revision, so someone else reviews and publishes it.')).toBeInTheDocument();
  });

  it('a publish that changes readiness inputs only files an approval request bound to the revision', async () => {
    detailBody = detail({ current: revision({ state: 'APPROVED', rightsReview: { licenceLabel: 'AI8HT-Owned', reviewerEmail: 'rev@example.test', reasonCode: 'OWNERSHIP_VERIFIED', reviewedAt: '2026-09-26T12:00:00.000Z' } }) });
    const region = await openSkill();
    expect(region).toHaveTextContent('AI8HT-Owned confirmed by rev@example.test (OWNERSHIP_VERIFIED)');
    fireEvent.click(within(region).getByRole('button', { name: 'Request publish…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish revision 1 of soc-alert-triage' });
    expect(within(dialog).getByText(/approval required from a second person/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_SKILL' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'CONTENT_SKILL_PUBLISH', payload: { revisionId, reasonCode: 'NEW_SKILL' } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/publish'))).toBe(false);
  });

  it('a revision of a live skill no role requires publishes directly, with a reason code', async () => {
    const nextId = crypto.randomUUID();
    detailBody = detail({
      status: 'LIVE', publishedRevision: 1, publishNeedsApproval: false,
      current: revision({ state: 'PUBLISHED', publishedAt: '2026-09-25T10:00:00.000Z' }),
      open: revision({ id: nextId, revision: 2, state: 'APPROVED' }),
    });
    const region = await openSkill();
    fireEvent.click(within(region).getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish revision 2 of soc-alert-triage' });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'SKILL_REVISION' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/revisions/${nextId}/publish`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'SKILL_REVISION' });
  });

  it('shows a reviewer without edit rights the draft read-only, with NA where nothing is set', async () => {
    policyResponse = () => ok(policy({ edit: false, publish: false }));
    detailBody = detail({ current: revision({ fields: { ...revision().fields, basis: null, licenceLabel: null } }) });
    const region = await openSkill();
    expect(within(region).queryByRole('form', { name: 'Edit revision 1' })).not.toBeInTheDocument();
    expect(within(region).getByText('Licence').nextSibling?.textContent).toBe('NA');
    expect(within(region).getByText('Basis').nextSibling?.textContent).toBe('NA');
    expect(within(region).getByText('Knows what an alert is')).toBeInTheDocument();
  });

  it('archives a live skill with a reason code, saying what blocks it and that no second person approves', async () => {
    detailBody = detail({ status: 'LIVE', publishedRevision: 1, current: revision({ state: 'PUBLISHED', publishedAt: '2026-09-25T10:00:00.000Z' }) });
    const region = await openSkill();
    fireEvent.click(within(region).getByRole('button', { name: 'Archive…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive soc-alert-triage' });
    expect(within(dialog).getByText(/no second person approves it/)).toBeInTheDocument();
    expect(within(dialog).getByText(/refused while a role requires it/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'DUPLICATE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive skill' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/api/v1/operations/skill-map/skills/${topicId}/archive`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'DUPLICATE' });
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});

describe('the approvals queue carries out an approved skill publish', () => {
  it('describes it in plain words and replays the stored payload to the publish endpoint', async () => {
    const approvalId = crypto.randomUUID();
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return ok({ skill: detail(), correlationId: 'corr-publish' });
      return ok({
        approvals: [{
          id: approvalId, actionKey: 'CONTENT_SKILL_PUBLISH', actionLabel: 'Publish a skill that changes readiness inputs', state: 'APPROVED',
          payload: { revisionId, contentHash: 'c'.repeat(64), reasonCode: 'NEW_SKILL' },
          summary: { organizationName: null, flagKey: null, enabled: null, capability: null, memberEmail: null, holdReason: null, olderThan: null, limit: null,
            skillName: 'Alert triage and prioritisation', skillKey: 'soc-alert-triage', skillRevision: 1 },
          reasonCode: 'NEW_SKILL', note: null, requestedBy: { email: 'publisher@example.test', isSelf: true },
          requestedAt: '2026-09-26T10:00:00.000000Z', expiresAt: '2026-09-27T10:00:00.000000Z', coolingOffEndsAt: '2026-09-26T10:15:00.000000Z',
          decidedBy: { email: 'approver@example.test', isSelf: false }, decidedAt: '2026-09-26T10:05:00.000Z', decisionReasonCode: 'VERIFIED_NEED',
          mode: 'DUAL', soloNotice: null, executedAt: null, canApprove: false, canReject: false, approveRefusal: 'APPROVAL_NOT_PENDING', canExecute: true,
        }],
        nextCursor: null, decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 2, soloSafeguardActive: false, viewerIsApprover: false, correlationId: 'corr-q',
      });
    });
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByText('Publish revision 1 of the skill Alert triage and prioritisation (soc-alert-triage)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/skill-map/revisions/${revisionId}/publish`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'NEW_SKILL', approvalId });
  });
});
