/**
 * Operations Content Management — the job-role catalogue (OPS-08): the list renders the
 * server's roles and counts with honest labels, search sends the filters, catalogue writes
 * need a reason code, the author is never offered their own review, a publish only files
 * an approval request (and the Approvals queue carries it out), and the loading / NA /
 * empty / error / forbidden states are honest. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsApprovalsPanel } from './approvals.js';
import { OperationsCareerCataloguePage } from './careerCatalogue.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const viewerId = crypto.randomUUID();
const otherAuthorId = crypto.randomUUID();
const roleId = crypto.randomUUID();
const setId = crypto.randomUUID();
const topicId = crypto.randomUUID();

const policy = (viewer: Record<string, unknown> = {}) => ({
  viewer: { manage: true, review: true, publish: true, userId: viewerId, ...viewer },
  families: [{ code: 'A', label: 'Software, IT and product' }, { code: 'B', label: 'Data, AI and cybersecurity' }],
  branches: ['CSE', 'Civil', 'ECE'],
  releaseLabels: ['SELECTABLE', 'VERIFIED'],
  plannedReleases: ['V1', 'V2', 'V3'],
  requirementLevels: ['ESSENTIAL', 'IMPORTANT', 'HELPFUL'],
  evidenceTypes: ['LESSON_COMPLETION', 'ASSESSMENT_OUTCOME', 'TOPIC_DEMONSTRATION'],
  transitions: { DRAFT: ['IN_REVIEW', 'WITHDRAWN'], IN_REVIEW: ['REVIEWED', 'DRAFT', 'WITHDRAWN'], REVIEWED: ['DRAFT', 'WITHDRAWN'], PUBLISHED: [], SUPERSEDED: [], WITHDRAWN: [] },
  reasons: {
    synonymAdd: ['STUDENT_WORDING', 'INDUSTRY_TITLE'], synonymRemove: ['MISLEADING'], draftCreate: ['NEW_REQUIREMENT_SET', 'REVISION'], itemsSave: ['DRAFT_EDIT'],
    transition: { IN_REVIEW: ['READY_FOR_REVIEW'], REVIEWED: ['REVIEW_PASSED'], DRAFT: ['CHANGES_REQUESTED', 'AUTHOR_RECALL'], WITHDRAWN: ['ABANDONED'] },
    publish: ['NEW_REQUIREMENT_SET', 'ROLE_VERIFIED'],
  },
  studentFlag: { key: 'career-catalogue.selectable-roles', enabled: false },
  correlationId: 'corr-policy',
});

const role = (over: Record<string, unknown> = {}) => ({
  id: roleId, code: 'SOC_ANALYST', catalogueCode: 'C01', title: 'Security Operations Analyst', catalogueTitle: 'SOC Analyst L1',
  family: 'Cyber Security', catalogueFamily: 'B', eligibleBranches: ['CSE', 'IT', 'ECE'], plannedRelease: 'V1', releaseLabel: 'SELECTABLE',
  origin: 'STARTER', active: true, liveRequirementCount: 1, openSetState: null, publishedVersion: null, synonymCount: 0, ...over,
});
const set = (over: Record<string, unknown> = {}) => ({
  id: setId, version: 1, state: 'DRAFT', basedOn: 'LIVE', reasonCode: 'REVISION', author: { userId: viewerId, email: 'author@example.test' },
  createdAt: '2026-09-26T10:00:00.000Z', submittedAt: null, reviewer: null, reviewedAt: null, reviewReasonCode: null, reviewNote: null,
  publishedAt: null, publisherEmail: null, releaseLabelAtPublish: null, supersededAt: null, withdrawnAt: null,
  items: [{ topicId, topicKey: 'incident-handover', topicTitle: 'Incident handover', requirementLevel: 'ESSENTIAL', targetMastery: 0.75, rationale: null, requiredEvidenceTypes: [] }],
  ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...role(), summary: null, coreSkillAreas: 'Networking, SIEM alert triage', mainEvidence: 'Scenarios and objective tests now; labs in V3',
  catalogueVersion: 'catalogue-v1', synonyms: [], liveTargetCount: 3,
  liveRequirements: [{ topicId, topicKey: 'incident-handover', topicTitle: 'Incident handover', requirementLevel: 'ESSENTIAL', targetMastery: 0.75, rationale: null, requiredEvidenceTypes: [] }],
  requirementSets: [], ...over,
});
const summary = { totalRoles: 108, catalogueRoles: 108, starterRoles: 5, selectable: 108, verified: 0, plannedV1: 1, plannedV2: 13, plannedV3: 38, liveSynonyms: 0, setsInDraft: 0, setsInReview: 1, setsReviewed: 0, setsPublished: 0 };
const list = (roles: unknown[]) => ({ roles, nextCursor: null, summary, correlationId: 'corr-list' });

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
  listResponse = () => ok(list([role(), role({ id: crypto.randomUUID(), code: 'S02', catalogueCode: 'S02', title: 'Software Developer (backend)', catalogueTitle: 'Software Developer (backend)', catalogueFamily: 'A', origin: 'CATALOGUE', plannedRelease: 'V2', eligibleBranches: ['CSE', 'IT', 'ECE', 'EEE'], liveRequirementCount: 0 })]));
  detailBody = detail();
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') {
      if (path.includes('/operations/approvals')) return ok({ approval: { id: crypto.randomUUID() }, correlationId: 'corr-approval' });
      return ok({ role: detailBody, correlationId: 'corr-post' });
    }
    if (path.includes('/operations/approvals/policy')) return ok({ actions: [], decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 2, soloSafeguardActive: false, correlationId: 'corr-ap' });
    if (path.includes('/career-catalogue/policy')) return policyResponse();
    if (path.includes('/career-catalogue/roles/')) return ok({ role: detailBody, correlationId: 'corr-detail' });
    if (path.includes('/career-catalogue/roles')) return listResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const openRole = async (): Promise<HTMLElement> => {
  render(<OperationsCareerCataloguePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open C01' }));
  return screen.findByRole('region', { name: 'Catalogue role C01' });
};

describe('job-role catalogue', () => {
  it('renders the server roles and counts, with the plan kept apart from an honest label', async () => {
    render(<OperationsCareerCataloguePage />);
    expect(await screen.findByText('Security Operations Analyst')).toBeInTheDocument();
    expect(screen.getByText('Catalogue: SOC Analyst L1')).toBeInTheDocument();
    expect(screen.getByText('V1 (planned)')).toBeInTheDocument();
    expect(screen.getAllByText('Not yet verified').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Roles in the catalogue').previousSibling?.textContent).toBe('108');
    expect(screen.getByText('Verified', { selector: 'small' }).previousSibling?.textContent).toBe('0');
    expect(screen.getByRole('note')).toHaveTextContent('the starter roles only');
  });

  it('shows NA in the counts and a loading state until the list arrives', async () => {
    listResponse = () => new Promise(() => undefined);
    render(<OperationsCareerCataloguePage />);
    expect(screen.getByText('Loading the catalogue…')).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(4);
  });

  it('says so plainly when nothing matches', async () => {
    listResponse = () => ok(list([]));
    render(<OperationsCareerCataloguePage />);
    expect(await screen.findByText('No roles match')).toBeInTheDocument();
  });

  it('shows an error with its reference', async () => {
    listResponse = () => failure(500, 'INTERNAL', 'corr-list-fail');
    render(<OperationsCareerCataloguePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('corr-list-fail');
  });

  it('shows a forbidden state with its reference to staff without a catalogue capability', async () => {
    policyResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    listResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    render(<OperationsCareerCataloguePage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-forbidden')).toBeInTheDocument();
  });

  it('sends the search and filters to the server', async () => {
    render(<OperationsCareerCataloguePage />);
    await screen.findByText('Security Operations Analyst');
    fireEvent.change(screen.getByPlaceholderText('Code, name, branch or synonym'), { target: { value: 'cyber defender' } });
    fireEvent.change(screen.getByLabelText('Family filter'), { target: { value: 'B' } });
    fireEvent.change(screen.getByLabelText('Branch filter'), { target: { value: 'Civil' } });
    fireEvent.change(screen.getByLabelText('Release label filter'), { target: { value: 'SELECTABLE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = String(fetchMock.mock.calls.filter(([url]) => String(url).includes('/career-catalogue/roles?')).at(-1)?.[0]);
      expect(last).toContain('q=cyber+defender');
      expect(last).toContain('family=B');
      expect(last).toContain('branch=Civil');
      expect(last).toContain('releaseLabel=SELECTABLE');
    });
  });

  it('shows a role with its draft skill areas, live requirements and a target count', async () => {
    const panel = await openRole();
    expect(within(panel).getByText('Networking, SIEM alert triage')).toBeInTheDocument();
    expect(within(panel).getByText('SOC_ANALYST')).toBeInTheDocument();
    expect(within(panel).getByText('3')).toBeInTheDocument();
    expect(within(panel).getByText('Incident handover')).toBeInTheDocument();
    expect(within(panel).getByText(/Written by the starter seed; not yet versioned/)).toBeInTheDocument();
  });

  it('adds a synonym only with a reason code', async () => {
    const panel = await openRole();
    const form = within(panel).getByRole('form', { name: 'Add a synonym' });
    fireEvent.change(within(form).getByLabelText('Synonym'), { target: { value: 'Cyber defender' } });
    const submit = within(form).getByRole('button', { name: 'Add synonym' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Reason code/), { target: { value: 'STUDENT_WORDING' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/career-catalogue/roles/${roleId}/synonyms`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ synonym: 'Cyber defender', reasonCode: 'STUDENT_WORDING' });
  });

  it('submits a draft for review through a dialog that requires a reason code', async () => {
    detailBody = detail({ requirementSets: [set()] });
    const panel = await openRole();
    fireEvent.click(within(panel).getByRole('button', { name: 'Submit for review…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Submit version 1 for review' });
    const submit = within(dialog).getByRole('button', { name: 'Submit version 1 for review' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'READY_FOR_REVIEW' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/requirement-sets/${setId}/transition`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ toState: 'IN_REVIEW', reasonCode: 'READY_FOR_REVIEW' });
  });

  it('never offers the author their own review, and offers a different reviewer both decisions', async () => {
    detailBody = detail({ requirementSets: [set({ state: 'IN_REVIEW', submittedAt: '2026-09-26T11:00:00.000Z' })] });
    let panel = await openRole();
    expect(within(panel).queryByRole('button', { name: 'Pass review…' })).not.toBeInTheDocument();
    expect(within(panel).getByText('You drafted this set, so someone else reviews it.')).toBeInTheDocument();
    cleanup();
    detailBody = detail({ requirementSets: [set({ state: 'IN_REVIEW', author: { userId: otherAuthorId, email: 'other@example.test' } })] });
    panel = await openRole();
    expect(within(panel).getByRole('button', { name: 'Pass review…' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog');
    // A reviewer sends back; recalling is only the author's.
    expect(within(dialog).queryByRole('option', { name: 'AUTHOR_RECALL' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('option', { name: 'CHANGES_REQUESTED' })).toBeInTheDocument();
  });

  it('publishing only files an approval request, bound to the set and the label', async () => {
    detailBody = detail({ requirementSets: [set({ state: 'REVIEWED', author: { userId: otherAuthorId, email: 'other@example.test' }, reviewer: { userId: viewerId, email: 'rev@example.test' }, reviewReasonCode: 'REVIEW_PASSED' })] });
    const panel = await openRole();
    fireEvent.change(within(panel).getByLabelText('Label after publishing'), { target: { value: 'VERIFIED' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Request publish…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish version 1 of C01' });
    expect(within(dialog).getByText(/approval required from a second person/)).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Request approval' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'ROLE_VERIFIED' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/api/v1/operations/approvals');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'CAREER_REQUIREMENT_SET_PUBLISH', payload: { setId, releaseLabel: 'VERIFIED', reasonCode: 'ROLE_VERIFIED' } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/publish'))).toBe(false);
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});

describe('the approvals queue carries out an approved publish', () => {
  it('describes it in plain words and replays the stored payload to the publish endpoint', async () => {
    const approvalId = crypto.randomUUID();
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return ok({ role: detail(), correlationId: 'corr-publish' });
      return ok({
        approvals: [{
          id: approvalId, actionKey: 'CAREER_REQUIREMENT_SET_PUBLISH', actionLabel: 'Publish a career-role requirement set', state: 'APPROVED',
          payload: { setId, releaseLabel: 'SELECTABLE', reasonCode: 'NEW_REQUIREMENT_SET' },
          summary: { organizationName: null, flagKey: null, enabled: null, capability: null, memberEmail: null, holdReason: null, olderThan: null, limit: null,
            careerRoleTitle: 'Security Operations Analyst', careerRoleCatalogueCode: 'C01', careerSetVersion: 2, releaseLabel: 'SELECTABLE' },
          reasonCode: 'NEW_REQUIREMENT_SET', note: null, requestedBy: { email: 'publisher@example.test', isSelf: true },
          requestedAt: '2026-09-26T10:00:00.000000Z', expiresAt: '2026-09-27T10:00:00.000000Z', coolingOffEndsAt: '2026-09-26T10:15:00.000000Z',
          decidedBy: { email: 'approver@example.test', isSelf: false }, decidedAt: '2026-09-26T10:05:00.000Z', decisionReasonCode: 'VERIFIED_NEED',
          mode: 'DUAL', soloNotice: null, executedAt: null, canApprove: false, canReject: false, approveRefusal: 'APPROVAL_NOT_PENDING', canExecute: true,
        }],
        nextCursor: null, decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 2, soloSafeguardActive: false, viewerIsApprover: false, correlationId: 'corr-q',
      });
    });
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByText('Publish requirement set v2 for C01 Security Operations Analyst as Not yet verified')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/career-catalogue/requirement-sets/${setId}/publish`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ releaseLabel: 'SELECTABLE', reasonCode: 'NEW_REQUIREMENT_SET', approvalId });
  });
});

describe('an agent-drafted requirement set (ENG-11)', () => {
  it('tells the reviewer it is agent-drafted, what it rests on, and which topics are not yet published', async () => {
    const pendingId = crypto.randomUUID();
    detailBody = detail({ requirementSets: [set({
      state: 'IN_REVIEW', submittedAt: '2026-09-26T11:00:00.000Z', reasonCode: 'NEW_REQUIREMENT_SET',
      author: { userId: otherAuthorId, email: 'importer@example.test' },
      provenance: { source: 'AGENT_DRAFTED', generatorVersion: 'agent-model', promptVersion: 'eng-11-soc-analyst-l1-target-v1', generatedAt: '2026-09-26T00:00:00.000Z', sourceBasis: 'NQR qualification file' },
      items: [
        { topicId, topicKey: 'incident-handover', topicTitle: 'Incident handover', topicLive: true, requirementLevel: 'ESSENTIAL', targetMastery: 0.75, rationale: null, requiredEvidenceTypes: [] },
        { topicId: pendingId, topicKey: 'soc-alert-triage', topicTitle: 'Alert triage and prioritisation', topicLive: false, requirementLevel: 'ESSENTIAL', targetMastery: 0.7, rationale: 'Core of the job.', requiredEvidenceTypes: ['ASSESSMENT_OUTCOME'] },
      ],
    })] });
    const region = await openRole();
    const card = within(region).getByRole('article', { name: 'Requirement set v1' });
    expect(within(card).getByText('Agent-drafted')).toBeInTheDocument();
    expect(card).toHaveTextContent('eng-11-soc-analyst-l1-target-v1');
    expect(card).toHaveTextContent('Basis: NQR qualification file');
    expect(card).toHaveTextContent('1 of these topics are not yet published. This set cannot be published until they are.');
    expect(within(card).getAllByText('Topic not yet published')).toHaveLength(1);
    // A person, not the drafter, reviews it.
    expect(within(card).getByRole('button', { name: 'Pass review…' })).toBeInTheDocument();
  });

  it('shows no agent notice on a set a person drafted', async () => {
    detailBody = detail({ requirementSets: [set({ state: 'IN_REVIEW', submittedAt: '2026-09-26T11:00:00.000Z', author: { userId: otherAuthorId, email: 'author@example.test' },
      provenance: { source: 'AUTHORED', generatorVersion: null, promptVersion: null, generatedAt: null, sourceBasis: null } })] });
    const region = await openRole();
    const card = within(region).getByRole('article', { name: 'Requirement set v1' });
    expect(within(card).queryByText('Agent-drafted')).toBeNull();
    expect(within(card).queryByText('Topic not yet published')).toBeNull();
  });
});
