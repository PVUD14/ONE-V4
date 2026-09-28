/**
 * Operations Content Management — the question bank editor (OPS-09b): the list renders the
 * server's questions and counts honestly, search sends the filters, writes need a reason code,
 * the editor sends options, the answer key, misconception tags and all four hints, approving also
 * asks for the rights reason, whoever wrote a revision is never offered its review or publish, a
 * publish only files an approval request (and the Approvals queue carries it out), a
 * publisher-only reader sees the answer key withheld, and the loading / NA / empty / error /
 * forbidden states are honest. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsApprovalsPanel } from './approvals.js';
import { OperationsQuestionBankPage } from './questionBank.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const viewerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const questionId = crypto.randomUUID();
const revisionId = crypto.randomUUID();
const codeId = crypto.randomUUID();
const topic = { id: crypto.randomUUID(), stableKey: 'professional-communication', name: 'Professional communication', status: 'LIVE' };

const policy = (viewer: Record<string, unknown> = {}) => ({
  viewer: { edit: true, review: true, publish: true, answerKeys: true, userId: viewerId, ...viewer },
  optionIds: ['a', 'b', 'c', 'd', 'e', 'f'],
  difficulties: [
    { difficulty: 'FOUNDATION', meaning: 'Checks the core idea directly' }, { difficulty: 'INTERMEDIATE', meaning: 'Applies the idea to an ordinary case' },
    { difficulty: 'ADVANCED', meaning: 'Combines ideas or handles an unusual case' },
  ],
  hintLevels: [
    { level: 1, name: 'NUDGE', meaning: 'Points at the idea that matters' }, { level: 2, name: 'STRATEGY', meaning: 'Names the method to use' },
    { level: 3, name: 'WORKED_STEP', meaning: 'Does the first step' }, { level: 4, name: 'NEAR_SOLUTION', meaning: 'Everything short of choosing the answer' },
  ],
  licences: [{ licence: 'AI8HT-Owned', attributionRequired: false }, { licence: 'CC-BY-4.0', attributionRequired: true }],
  transitions: { DRAFT: ['IN_REVIEW'], IN_REVIEW: ['CHANGES_REQUESTED', 'APPROVED'], CHANGES_REQUESTED: ['IN_REVIEW'], APPROVED: [], PUBLISHED: [], ARCHIVED: [] },
  reasons: {
    create: ['NEW_QUESTION', 'TRACK_BUILD'], revise: ['CORRECTION', 'HINT_CHANGE'], save: ['DRAFT_EDIT'],
    transition: { IN_REVIEW: ['READY_FOR_REVIEW', 'CHANGES_MADE'], CHANGES_REQUESTED: ['ANSWER_KEY_WRONG', 'HINTS_REVEAL_ANSWER'], APPROVED: ['REVIEW_PASSED'] },
    rights: ['OWNERSHIP_VERIFIED', 'LICENCE_VERIFIED'], publish: ['NEW_QUESTION', 'QUESTION_REVISION'],
  },
  limits: { prompt: 2000, optionText: 500, optionsMin: 2, optionsMax: 6, explanation: 2000, rationale: 2000, hint: 1000, attribution: 300, basis: 2000, note: 500 },
  correlationId: 'corr-policy',
});

const summaryRow = (over: Record<string, unknown> = {}) => ({
  questionId, stableKey: 'ops-q-followup', topic, status: 'PENDING', publishedVersion: null,
  openRevision: { id: revisionId, revision: 1, state: 'DRAFT' }, difficulty: 'FOUNDATION', promptExcerpt: 'Which follow-up is clearest?',
  optionCount: 3, taggedOptionCount: 1, hintsComplete: false, ...over,
});
const hints = ['Look at what is asked.', 'Name the action and the deadline.', 'Compare option b with a.', 'Only one option has a deadline.'];
const fields = (over: Record<string, unknown> = {}) => ({
  topicId: topic.id, prompt: 'Which follow-up is clearest?',
  options: [
    { id: 'a', text: 'Please review when possible.', misconception: { codeId, rationale: 'Mistakes politeness for clarity.' } },
    { id: 'b', text: 'Please confirm by Thursday 3 PM.', misconception: null },
    { id: 'c', text: 'Any update?', misconception: null },
  ],
  correctOptionId: 'b', explanation: 'It names the action and the deadline.', difficulty: 'FOUNDATION', hints,
  licenceLabel: 'AI8HT-Owned', attribution: null, basis: 'Written for the pilot', ...over,
});
const revision = (over: Record<string, unknown> = {}) => ({
  id: revisionId, revision: 1, state: 'DRAFT', contentHash: 'c'.repeat(64), author: { userId: otherId, email: 'author@example.test' },
  contributors: [{ userId: otherId, email: 'author@example.test' }], createdAt: '2026-09-28T10:00:00.000Z', publishedAt: null,
  fields: fields(), answerKeyWithheld: false, topic,
  tags: [], ladder: null, agentDraft: null, expertCheck: null, rightsReview: null, ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...summaryRow(), current: null, open: revision(), versions: [],
  misconceptionChoices: [{ id: codeId, code: 'POLITE_IS_CLEAR', version: 1, title: 'Treats politeness as clarity', state: 'PUBLISHED' }],
  publishNeedsApproval: true, history: [], ...over,
});
const summary = { live: 6, pending: 2, awaitingReview: 1, changesRequested: 0, awaitingPublish: 0 };
const list = (questions: unknown[]) => ({ questions, nextCursor: null, summary, correlationId: 'corr-list' });

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
    questionId: crypto.randomUUID(), stableKey: 'crf-q1', status: 'LIVE', publishedVersion: 1, openRevision: null, difficulty: null,
    taggedOptionCount: 0, hintsComplete: false,
  })]));
  detailBody = detail();
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') {
      if (path.includes('/operations/approvals')) return ok({ approval: { id: crypto.randomUUID() }, correlationId: 'corr-approval' });
      return ok({ question: detailBody, correlationId: 'corr-post' });
    }
    if (path.includes('/operations/approvals/policy')) return ok({ actions: [], decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 2, soloSafeguardActive: false, correlationId: 'corr-ap' });
    if (path.includes('/question-bank/policy')) return policyResponse();
    if (path.includes('/question-bank/questions/')) return ok({ question: detailBody, correlationId: 'corr-detail' });
    if (path.includes('/question-bank/questions')) return listResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const openQuestion = async (): Promise<HTMLElement> => {
  render(<OperationsQuestionBankPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open ops-q-followup' }));
  return screen.findByRole('region', { name: 'Question ops-q-followup' });
};

describe('question bank', () => {
  it('renders the server questions and counts, marking unpublished questions and missing values plainly', async () => {
    render(<OperationsQuestionBankPage />);
    expect(await screen.findByText('ops-q-followup')).toBeInTheDocument();
    expect(screen.getByText('Not yet published', { selector: '.status-pill' })).toBeInTheDocument();
    expect(screen.getByText('Live questions').previousSibling?.textContent).toBe('6');
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getAllByText('Incomplete').length).toBe(2);
    // The live pilot question has no difficulty band yet.
    const pilotRow = screen.getByText('crf-q1').closest('tr')!;
    expect(within(pilotRow).getByText('NA')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('shows NA in the counts and a loading state until the list arrives', () => {
    listResponse = () => new Promise(() => undefined);
    render(<OperationsQuestionBankPage />);
    expect(screen.getByText('Loading the question bank…')).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(4);
  });

  it('says so plainly when nothing matches', async () => {
    listResponse = () => ok(list([]));
    render(<OperationsQuestionBankPage />);
    expect(await screen.findByText('No questions match')).toBeInTheDocument();
  });

  it('shows an error with its reference', async () => {
    listResponse = () => failure(500, 'INTERNAL', 'corr-list-fail');
    render(<OperationsQuestionBankPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('corr-list-fail');
  });

  it('shows a forbidden state with its reference to staff without a content capability', async () => {
    policyResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    listResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    render(<OperationsQuestionBankPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-forbidden')).toBeInTheDocument();
  });

  it('sends the search and filter to the server', async () => {
    render(<OperationsQuestionBankPage />);
    await screen.findByText('ops-q-followup');
    fireEvent.change(screen.getByPlaceholderText('Key or prompt'), { target: { value: 'follow' } });
    fireEvent.change(screen.getByLabelText('Question filter'), { target: { value: 'AWAITING_PUBLISH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = String(fetchMock.mock.calls.filter(([url]) => String(url).includes('/question-bank/questions?')).at(-1)?.[0]);
      expect(last).toContain('q=follow');
      expect(last).toContain('filter=AWAITING_PUBLISH');
    });
  });

  it('creates a question only with valid keys, a prompt and a reason code', async () => {
    render(<OperationsQuestionBankPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New question…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New question' });
    const submit = within(dialog).getByRole('button', { name: 'Create draft' });
    fireEvent.change(within(dialog).getByLabelText(/^Key/), { target: { value: 'ops-q-new' } });
    fireEvent.change(within(dialog).getByLabelText('Skill key'), { target: { value: 'professional-communication' } });
    fireEvent.change(within(dialog).getByLabelText('Prompt'), { target: { value: 'Which is clearest?' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_QUESTION' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/api/v1/operations/question-bank/questions');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ stableKey: 'ops-q-new', topicKey: 'professional-communication', prompt: 'Which is clearest?', reasonCode: 'NEW_QUESTION' });
  });

  it('edits a draft: options, the answer key, a misconception tag and all four hints go to the server', async () => {
    const region = await openQuestion();
    const form = within(region).getByRole('form', { name: 'Edit revision 1' });
    fireEvent.change(within(form).getByLabelText('Option c text'), { target: { value: 'Any update on this?' } });
    fireEvent.change(within(form).getByLabelText('Option c misconception'), { target: { value: codeId } });
    fireEvent.change(within(form).getByLabelText('Option c rationale'), { target: { value: 'Assumes the reader knows the ask.' } });
    fireEvent.change(within(form).getByLabelText('Hint 4'), { target: { value: 'Only one option names a time.' } });
    fireEvent.change(within(form).getByLabelText('Difficulty'), { target: { value: 'INTERMEDIATE' } });
    expect(within(form).getByText(/Wrong options tagged: 2 of 2/)).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/revisions/${revisionId}/draft`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({
      topicKey: 'professional-communication', prompt: 'Which follow-up is clearest?',
      options: [
        { id: 'a', text: 'Please review when possible.', misconceptionCodeId: codeId, rationale: 'Mistakes politeness for clarity.' },
        { id: 'b', text: 'Please confirm by Thursday 3 PM.' },
        { id: 'c', text: 'Any update on this?', misconceptionCodeId: codeId, rationale: 'Assumes the reader knows the ask.' },
      ],
      correctOptionId: 'b', explanation: 'It names the action and the deadline.', difficulty: 'INTERMEDIATE',
      hints: [hints[0], hints[1], hints[2], 'Only one option names a time.'], licenceLabel: 'AI8HT-Owned', basis: 'Written for the pilot', reasonCode: 'DRAFT_EDIT',
    });
  });

  it('the correct option never carries a misconception picker', async () => {
    const region = await openQuestion();
    const form = within(region).getByRole('form', { name: 'Edit revision 1' });
    expect(within(form).queryByLabelText('Option b misconception')).not.toBeInTheDocument();
    fireEvent.click(within(form).getByLabelText('Option a is correct'));
    expect(within(form).queryByLabelText('Option a misconception')).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse(String(posts()[0]![1].body));
    expect(body.correctOptionId).toBe('a');
    expect(body.options[0]).toEqual({ id: 'a', text: 'Please review when possible.' });
  });

  it('approving asks for a reason code and a rights reason, and is not offered to whoever wrote the revision', async () => {
    detailBody = detail({ open: revision({ state: 'IN_REVIEW', tags: [{ optionId: 'a', code: 'POLITE_IS_CLEAR', codeVersion: 1, codeTitle: 'Treats politeness as clarity', codeState: 'PUBLISHED', tagState: 'IN_REVIEW' }] }) });
    let region = await openQuestion();
    expect(region).toHaveTextContent('POLITE_IS_CLEAR v1 — Treats politeness as clarity (In Review; code Published)');
    expect(within(region).getByText('Correct')).toBeInTheDocument();
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
    detailBody = detail({ open: revision({ state: 'IN_REVIEW', contributors: [{ userId: otherId, email: 'author@example.test' }, { userId: viewerId, email: 'me@example.test' }] }) });
    region = await openQuestion();
    expect(within(region).queryByRole('button', { name: 'Approve, with rights review…' })).not.toBeInTheDocument();
    expect(within(region).getByText('You wrote, edited or submitted this revision, so someone else reviews and publishes it.')).toBeInTheDocument();
  });

  it('a publish only files an approval request bound to the revision', async () => {
    detailBody = detail({ open: revision({ state: 'APPROVED', rightsReview: { licenceLabel: 'AI8HT-Owned', reviewerEmail: 'rev@example.test', reasonCode: 'OWNERSHIP_VERIFIED', reviewedAt: '2026-09-28T12:00:00.000Z' } }) });
    const region = await openQuestion();
    expect(region).toHaveTextContent('AI8HT-Owned confirmed by rev@example.test (OWNERSHIP_VERIFIED)');
    fireEvent.click(within(region).getByRole('button', { name: 'Request publish…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish revision 1 of ops-q-followup' });
    expect(within(dialog).getByText(/approval required from a second person/)).toBeInTheDocument();
    expect(within(dialog).getByText('Adds the question to the readiness check that students take.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_QUESTION' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'CONTENT_QUESTION_PUBLISH', payload: { revisionId, reasonCode: 'NEW_QUESTION' } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/publish'))).toBe(false);
  });

  it('shows a publisher-only reader the question with the answer key withheld, and NA where nothing is set', async () => {
    policyResponse = () => ok(policy({ edit: false, review: false, answerKeys: false }));
    detailBody = detail({ open: revision({
      state: 'APPROVED', answerKeyWithheld: true,
      fields: fields({ correctOptionId: null, explanation: null, basis: null, options: fields().options.map((option) => ({ ...option, misconception: null })) }),
    }) });
    const region = await openQuestion();
    expect(await screen.findByText(/You hold Content Publish only/)).toBeInTheDocument();
    expect(within(region).queryByRole('form', { name: 'Edit revision 1' })).not.toBeInTheDocument();
    expect(within(region).getByText(/shown only to staff with Content Edit or Content Review/)).toBeInTheDocument();
    expect(within(region).queryByText('Correct')).not.toBeInTheDocument();
    expect(within(region).getAllByText('Withheld').length).toBeGreaterThanOrEqual(3);
    expect(within(region).getByText('Basis').nextSibling?.textContent).toBe('NA');
    expect(within(region).getByText('Only one option has a deadline.')).toBeInTheDocument();
  });

  it('marks an agent-drafted item and shows its note for the subject expert', async () => {
    detailBody = detail({ open: revision({
      state: 'IN_REVIEW',
      agentDraft: { generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-10-aptitude-bank-v1', generatedAt: '2026-09-28T00:00:00.000Z' },
      expertCheck: 'Check the answer key and that only one option is correct.',
    }) });
    const region = await openQuestion();
    expect(within(region).getByText('Drafted by').nextSibling?.textContent).toMatch(/^The coding agent \(claude-opus-5-5, eng-10-aptitude-bank-v1, .+\) — check it against its basis$/);
    expect(within(region).getByText('For the subject expert').nextSibling?.textContent).toBe('Check the answer key and that only one option is correct.');
  });

  it('says a person wrote an item that carries no agent provenance', async () => {
    detailBody = detail({ open: revision({ state: 'IN_REVIEW' }) });
    const region = await openQuestion();
    expect(within(region).getByText('Drafted by').nextSibling?.textContent).toBe('A person');
    expect(within(region).queryByText('For the subject expert')).not.toBeInTheDocument();
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});

describe('the approvals queue carries out an approved question publish', () => {
  it('describes it in plain words and replays the stored payload to the publish endpoint', async () => {
    const approvalId = crypto.randomUUID();
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return ok({ question: detail(), correlationId: 'corr-publish' });
      return ok({
        approvals: [{
          id: approvalId, actionKey: 'CONTENT_QUESTION_PUBLISH', actionLabel: 'Publish a readiness-check question', state: 'APPROVED',
          payload: { revisionId, contentHash: 'c'.repeat(64), reasonCode: 'NEW_QUESTION' },
          summary: { organizationName: null, flagKey: null, enabled: null, capability: null, memberEmail: null, holdReason: null, olderThan: null, limit: null,
            skillName: null, skillKey: null, skillRevision: null, questionKey: 'ops-q-followup', questionRevision: 1 },
          reasonCode: 'NEW_QUESTION', note: null, requestedBy: { email: 'publisher@example.test', isSelf: true },
          requestedAt: '2026-09-28T10:00:00.000000Z', expiresAt: '2026-09-29T10:00:00.000000Z', coolingOffEndsAt: '2026-09-28T10:15:00.000000Z',
          decidedBy: { email: 'approver@example.test', isSelf: false }, decidedAt: '2026-09-28T10:05:00.000Z', decisionReasonCode: 'VERIFIED_NEED',
          mode: 'DUAL', soloNotice: null, executedAt: null, canApprove: false, canReject: false, approveRefusal: 'APPROVAL_NOT_PENDING', canExecute: true,
        }],
        nextCursor: null, decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 2, soloSafeguardActive: false, viewerIsApprover: false, correlationId: 'corr-q',
      });
    });
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByText('Publish revision 1 of the question ops-q-followup to the readiness check')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/question-bank/revisions/${revisionId}/publish`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'NEW_QUESTION', approvalId });
  });
});
