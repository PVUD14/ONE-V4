/**
 * Operations Content Management — the lesson and variant editor (OPS-09c): the list renders the
 * server's lessons, variants and counts honestly, search sends the filters, writes need a reason
 * code, the editor sends the text, module, skill and prerequisites (and no structure for a
 * variant), approving also asks for the rights reason, whoever wrote a revision is never offered
 * its review or publish and whoever approved it is never offered its publish, a publish that
 * needs an approval only files a request (and the Approvals queue carries it out) while a wording
 * or variant publish goes straight through, and the loading / NA / empty / error / forbidden
 * states are honest. Navigation labels are unchanged.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { rolePortals } from '../rolePortalConfig.js';
import { OperationsApprovalsPanel } from './approvals.js';
import { OperationsLessonsPage } from './lessons.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const viewerId = crypto.randomUUID();
const otherId = crypto.randomUUID();
const lessonId = crypto.randomUUID();
const variantId = crypto.randomUUID();
const revisionId = crypto.randomUUID();
const topic = { id: crypto.randomUUID(), stableKey: 'professional-communication', name: 'Professional communication', status: 'LIVE' };
const baseVariant = { language: 'en', level: 'STANDARD', style: 'EXPLANATION' };
const teluguVariant = { language: 'te', level: 'STANDARD', style: 'EXPLANATION' };

const policy = (viewer: Record<string, unknown> = {}) => ({
  viewer: { edit: true, review: true, publish: true, userId: viewerId, ...viewer },
  languages: [{ language: 'en', name: 'English' }, { language: 'hi', name: 'Hindi' }, { language: 'te', name: 'Telugu' }],
  levels: [{ level: 'FOUNDATION', meaning: 'Simpler' }, { level: 'STANDARD', meaning: 'As written' }, { level: 'ADVANCED', meaning: 'Denser' }],
  styles: [{ style: 'EXPLANATION', meaning: 'Prose' }, { style: 'WORKED_EXAMPLE', meaning: 'One example' }, { style: 'STEP_BY_STEP', meaning: 'Procedure' }, { style: 'SUMMARY', meaning: 'Recap' }],
  licences: [{ licence: 'AI8HT-Owned', attributionRequired: false }, { licence: 'CC-BY-4.0', attributionRequired: true }],
  modules: [{ stableKey: 'career-readiness-fundamentals', title: 'Career Readiness Fundamentals' }],
  transitions: { DRAFT: ['IN_REVIEW'], IN_REVIEW: ['CHANGES_REQUESTED', 'APPROVED'], CHANGES_REQUESTED: ['IN_REVIEW'], APPROVED: [], PUBLISHED: [], ARCHIVED: [] },
  reasons: {
    create: ['NEW_LESSON', 'TRACK_BUILD'], createVariant: ['NEW_LANGUAGE', 'NEW_LEVEL'], revise: ['CORRECTION', 'CONTENT_UPDATE'], save: ['DRAFT_EDIT'],
    transition: { IN_REVIEW: ['READY_FOR_REVIEW', 'CHANGES_MADE'], CHANGES_REQUESTED: ['CONTENT_INACCURATE', 'TRANSLATION_INACCURATE'], APPROVED: ['REVIEW_PASSED'] },
    rights: ['OWNERSHIP_VERIFIED', 'LICENCE_VERIFIED'], languageReview: ['NATIVE_SPEAKER_REVIEWED', 'NATIVE_SPEAKER_CONSULTED'], publish: ['NEW_LESSON', 'LESSON_REVISION', 'NEW_VARIANT'], archive: ['OUT_OF_DATE', 'RIGHTS_WITHDRAWN'],
  },
  limits: { title: 200, summary: 1000, practice: 2000, prerequisites: 20, attribution: 300, basis: 2000, note: 500 },
  correlationId: 'corr-policy',
});

const summaryRow = (over: Record<string, unknown> = {}) => ({
  lessonId, stableKey: 'ops-lesson-follow-up', kind: 'BASE', variant: baseVariant, variantOf: null, title: 'Write a clear follow-up',
  status: 'PENDING', publishedRevision: null, openRevision: { id: revisionId, revision: 1, state: 'DRAFT' }, topic, moduleKey: 'career-readiness-fundamentals',
  variantCount: 0, basedOnRevision: null, baseRevision: null, ...over,
});
const fields = (over: Record<string, unknown> = {}) => ({
  title: 'Write a clear follow-up', summary: 'Name the action, the owner and the deadline.', practice: null, moduleKey: 'career-readiness-fundamentals',
  topicId: topic.id, prerequisites: ['write-for-action'], licenceLabel: 'AI8HT-Owned', attribution: null, basis: 'Written for the pilot', ...over,
});
const revision = (over: Record<string, unknown> = {}) => ({
  id: revisionId, revision: 1, state: 'DRAFT', contentHash: 'c'.repeat(64), author: { userId: otherId, email: 'author@example.test' },
  contributors: [{ userId: otherId, email: 'author@example.test' }], approver: null, createdAt: '2026-09-28T10:00:00.000Z', publishedAt: null,
  identity: { stableKey: 'ops-lesson-follow-up', variantOf: null, variant: baseVariant, basedOnRevision: null },
  fields: fields(), topic, agentDraft: null, expertCheck: null, rightsReview: null, ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  ...summaryRow(), current: null, open: revision(), versions: [], variants: [], base: null, publishNeedsApproval: true, history: [], ...over,
});
const summary = { live: 3, pending: 2, awaitingReview: 1, awaitingPublish: 0, liveVariants: 0 };
const list = (lessons: unknown[]) => ({ lessons, nextCursor: null, summary, correlationId: 'corr-list' });

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
    lessonId: variantId, kind: 'VARIANT', variant: teluguVariant, variantOf: lessonId, title: 'Telugu title', status: 'LIVE', publishedRevision: 1,
    openRevision: null, topic: null, moduleKey: null, basedOnRevision: 1, baseRevision: 1,
  })]));
  detailBody = detail();
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') {
      if (path.includes('/operations/approvals')) return ok({ approval: { id: crypto.randomUUID() }, correlationId: 'corr-approval' });
      return ok({ lesson: detailBody, correlationId: 'corr-post' });
    }
    if (path.includes('/operations/approvals/policy')) return ok({ actions: [], decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 2, soloSafeguardActive: false, correlationId: 'corr-ap' });
    if (path.includes('/operations/lessons/policy')) return policyResponse();
    if (path.includes('/operations/lessons/lessons/')) return ok({ lesson: detailBody, correlationId: 'corr-detail' });
    if (path.includes('/operations/lessons/lessons')) return listResponse();
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const openLesson = async (): Promise<HTMLElement> => {
  render(<OperationsLessonsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open ops-lesson-follow-up' }));
  return screen.findByRole('region', { name: 'Lesson ops-lesson-follow-up' });
};

describe('lesson editor', () => {
  it('renders the server lessons, variants and counts, marking unpublished lessons and missing values plainly', async () => {
    render(<OperationsLessonsPage />);
    expect((await screen.findAllByText('ops-lesson-follow-up')).length).toBe(2);
    expect(screen.getByText('Not yet published', { selector: '.status-pill' })).toBeInTheDocument();
    expect(screen.getByText('Live lessons').previousSibling?.textContent).toBe('3');
    expect(screen.getByText('Live variants').previousSibling?.textContent).toBe('0');
    expect(screen.getByText('Telugu · Standard · Explanation')).toBeInTheDocument();
    const variantRow = screen.getByText('Telugu title').closest('tr')!;
    expect(within(variantRow).getByText('Variant')).toBeInTheDocument();
    expect(within(variantRow).getByText('As its lesson')).toBeInTheDocument();
    const baseRow = screen.getByText('Write a clear follow-up').closest('tr')!;
    expect(within(baseRow).getByText('NA')).toBeInTheDocument();
  });

  it('shows NA in the counts and a loading state until the list arrives', () => {
    listResponse = () => new Promise(() => undefined);
    render(<OperationsLessonsPage />);
    expect(screen.getByText('Loading lessons…')).toBeInTheDocument();
    expect(screen.getAllByText('NA').length).toBeGreaterThanOrEqual(4);
  });

  it('says so plainly when nothing matches', async () => {
    listResponse = () => ok(list([]));
    render(<OperationsLessonsPage />);
    expect(await screen.findByText('No lessons match')).toBeInTheDocument();
  });

  it('shows an error with its reference', async () => {
    listResponse = () => failure(500, 'INTERNAL', 'corr-list-fail');
    render(<OperationsLessonsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Support code: corrlist');
  });

  it('shows a forbidden state with its reference to staff without a content capability', async () => {
    policyResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    listResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    render(<OperationsLessonsPage />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Support code: corrforb')).toBeInTheDocument();
  });

  it('sends the search and filter to the server', async () => {
    render(<OperationsLessonsPage />);
    await screen.findAllByText('ops-lesson-follow-up');
    fireEvent.change(screen.getByPlaceholderText('Key or title'), { target: { value: 'follow' } });
    fireEvent.change(screen.getByLabelText('Lesson filter'), { target: { value: 'VARIANTS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = String(fetchMock.mock.calls.filter(([url]) => String(url).includes('/operations/lessons/lessons?')).at(-1)?.[0]);
      expect(last).toContain('q=follow');
      expect(last).toContain('filter=VARIANTS');
    });
  });

  it('creates a lesson only with a valid key, a title and a reason code', async () => {
    render(<OperationsLessonsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New lesson…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New lesson' });
    const submit = within(dialog).getByRole('button', { name: 'Create draft' });
    fireEvent.change(within(dialog).getByLabelText(/^Key/), { target: { value: 'ops-lesson-new' } });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'A new lesson' } });
    fireEvent.change(within(dialog).getByLabelText('Style'), { target: { value: 'WORKED_EXAMPLE' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_LESSON' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain('/api/v1/operations/lessons/lessons');
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ stableKey: 'ops-lesson-new', title: 'A new lesson', level: 'STANDARD', style: 'WORKED_EXAMPLE', reasonCode: 'NEW_LESSON' });
  });

  it('edits a draft: the text, module, skill and prerequisites go to the server', async () => {
    const region = await openLesson();
    const form = within(region).getByRole('form', { name: 'Edit revision 1' });
    fireEvent.change(within(form).getByLabelText(/^Summary/), { target: { value: 'Name the action and the deadline.' } });
    fireEvent.change(within(form).getByLabelText(/^Practice prompt/), { target: { value: 'Rewrite one vague message.' } });
    fireEvent.change(within(form).getByLabelText(/^Prerequisite lesson keys/), { target: { value: 'write-for-action, build-an-evidence-story' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/revisions/${revisionId}/draft`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({
      title: 'Write a clear follow-up', summary: 'Name the action and the deadline.', practice: 'Rewrite one vague message.',
      moduleKey: 'career-readiness-fundamentals', topicKey: 'professional-communication', prerequisites: ['write-for-action', 'build-an-evidence-story'],
      licenceLabel: 'AI8HT-Owned', basis: 'Written for the pilot', reasonCode: 'DRAFT_EDIT',
    });
  });

  it('approving asks for a reason code and a rights reason, and is not offered to whoever wrote the revision', async () => {
    detailBody = detail({ open: revision({ state: 'IN_REVIEW' }) });
    let region = await openLesson();
    fireEvent.click(within(region).getByRole('button', { name: 'Approve, with rights review…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve revision 1' });
    const submit = within(dialog).getByRole('button', { name: 'Approve revision 1' });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'REVIEW_PASSED' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Rights reason'), { target: { value: 'OWNERSHIP_VERIFIED' } });
    // An English lesson is not asked who checked its language (ENG-16).
    expect(within(dialog).queryByLabelText('Native-speaker review')).not.toBeInTheDocument();
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ toState: 'APPROVED', reasonCode: 'REVIEW_PASSED', rightsReasonCode: 'OWNERSHIP_VERIFIED' });
    cleanup();
    detailBody = detail({ open: revision({ state: 'IN_REVIEW', contributors: [{ userId: otherId, email: 'author@example.test' }, { userId: viewerId, email: 'me@example.test' }] }) });
    region = await openLesson();
    expect(within(region).queryByRole('button', { name: 'Approve, with rights review…' })).not.toBeInTheDocument();
    expect(within(region).getByText('You wrote, edited or submitted this revision, so someone else reviews and publishes it.')).toBeInTheDocument();
  });

  it('a first publish only files an approval request bound to the revision', async () => {
    detailBody = detail({ open: revision({ state: 'APPROVED', approver: { userId: otherId, email: 'rev@example.test' },
      rightsReview: { licenceLabel: 'AI8HT-Owned', reviewerEmail: 'rev@example.test', reasonCode: 'OWNERSHIP_VERIFIED', reviewedAt: '2026-09-28T12:00:00.000Z' } }) });
    const region = await openLesson();
    expect(region).toHaveTextContent('AI8HT-Owned confirmed by rev@example.test (OWNERSHIP_VERIFIED)');
    fireEvent.click(within(region).getByRole('button', { name: 'Request publish…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish revision 1 of ops-lesson-follow-up' });
    expect(within(dialog).getByText(/approval required from a second person/)).toBeInTheDocument();
    expect(within(dialog).getByText('Adds the lesson to the module students complete; completing it records evidence.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_LESSON' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ actionKey: 'CONTENT_LESSON_PUBLISH', payload: { revisionId, reasonCode: 'NEW_LESSON' } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/publish'))).toBe(false);
  });

  it('the approver is not offered the publish (the learner-content lifecycle rule)', async () => {
    detailBody = detail({ open: revision({ state: 'APPROVED', approver: { userId: viewerId, email: 'me@example.test' } }) });
    const region = await openLesson();
    expect(within(region).queryByRole('button', { name: /publish/i })).not.toBeInTheDocument();
    expect(within(region).getByText('You approved this revision, so someone else publishes it.')).toBeInTheDocument();
  });

  it('a variant shows what it renders, sends no structure, and publishes directly', async () => {
    const variantRevision = revision({
      state: 'DRAFT', identity: { stableKey: 'ops-lesson-follow-up', variantOf: lessonId, variant: teluguVariant, basedOnRevision: 1 },
      fields: fields({ moduleKey: null, topicId: null, prerequisites: [], title: 'Telugu title' }), topic: null,
    });
    detailBody = detail({
      ...summaryRow({ lessonId: variantId, kind: 'VARIANT', variant: teluguVariant, variantOf: lessonId, title: 'Telugu title', topic: null, moduleKey: null, basedOnRevision: 1, baseRevision: 2, status: 'PENDING' }),
      open: variantRevision, base: summaryRow({ status: 'LIVE', publishedRevision: 2, openRevision: null }), publishNeedsApproval: false,
    });
    render(<OperationsLessonsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open ops-lesson-follow-up (te/STANDARD/EXPLANATION)' }));
    const region = await screen.findByRole('region', { name: 'Lesson ops-lesson-follow-up (Telugu · Standard · Explanation)' });
    expect(region).toHaveTextContent('Write a clear follow-up (ops-lesson-follow-up), revision 1 — the lesson is now at revision 2');
    expect(within(region).getByRole('note')).toHaveTextContent('renders an earlier revision of its lesson');
    const form = within(region).getByRole('form', { name: 'Edit revision 1' });
    expect(within(form).queryByLabelText('Module')).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({
      title: 'Telugu title', summary: 'Name the action, the owner and the deadline.', licenceLabel: 'AI8HT-Owned', basis: 'Written for the pilot', reasonCode: 'DRAFT_EDIT',
    });
    cleanup();
    fetchMock.mockClear();
    detailBody = { ...(detailBody as Record<string, unknown>), open: { ...variantRevision, state: 'APPROVED', approver: { userId: otherId, email: 'rev@example.test' } } };
    render(<OperationsLessonsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open ops-lesson-follow-up (te/STANDARD/EXPLANATION)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('dialog', { name: /Publish revision 1/ });
    expect(within(dialog).getByText('Not required: a variant renders its lesson and changes no evidence.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_VARIANT' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/revisions/${revisionId}/publish`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'NEW_VARIANT' });
  });

  it('marks a Telugu variant for native-speaker review, and approving it asks who checked the language (ENG-16)', async () => {
    const variantRevision = revision({
      state: 'IN_REVIEW', identity: { stableKey: 'ops-lesson-follow-up', variantOf: lessonId, variant: teluguVariant, basedOnRevision: 1 },
      fields: fields({ moduleKey: null, topicId: null, prerequisites: [], title: 'Telugu title' }), topic: null,
    });
    listResponse = () => ok(list([summaryRow({
      lessonId: variantId, kind: 'VARIANT', variant: teluguVariant, variantOf: lessonId, title: 'Telugu title', topic: null, moduleKey: null,
      openRevision: { id: revisionId, revision: 1, state: 'IN_REVIEW' }, basedOnRevision: 1, baseRevision: 1,
    })]));
    detailBody = detail({
      ...summaryRow({ lessonId: variantId, kind: 'VARIANT', variant: teluguVariant, variantOf: lessonId, title: 'Telugu title', topic: null, moduleKey: null, basedOnRevision: 1, baseRevision: 1 }),
      open: variantRevision, base: summaryRow({ status: 'LIVE', publishedRevision: 1, openRevision: null }), publishNeedsApproval: false,
    });
    render(<OperationsLessonsPage />);
    expect(await screen.findByText('Needs native-speaker review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open ops-lesson-follow-up (te/STANDARD/EXPLANATION)' }));
    const region = await screen.findByRole('region', { name: 'Lesson ops-lesson-follow-up (Telugu · Standard · Explanation)' });
    expect(within(region).getByText('Needs native-speaker review')).toBeInTheDocument();
    expect(region).toHaveTextContent('Students never see this Telugu text until');
    fireEvent.click(within(region).getByRole('button', { name: 'Approve, with rights review…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve revision 1' });
    const submit = within(dialog).getByRole('button', { name: 'Approve revision 1' });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'REVIEW_PASSED' } });
    fireEvent.change(within(dialog).getByLabelText('Rights reason'), { target: { value: 'OWNERSHIP_VERIFIED' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Native-speaker review'), { target: { value: 'NATIVE_SPEAKER_REVIEWED' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({
      toState: 'APPROVED', reasonCode: 'REVIEW_PASSED', rightsReasonCode: 'OWNERSHIP_VERIFIED', languageReviewCode: 'NATIVE_SPEAKER_REVIEWED',
    });
  });

  it('creates a variant of a live lesson with a language, a title and a reason code', async () => {
    detailBody = detail({ status: 'LIVE', publishedRevision: 1, openRevision: null, open: null, current: revision({ state: 'PUBLISHED' }) });
    const region = await openLesson();
    expect(within(region).getByText('No variants yet.')).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'New variant…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New variant of ops-lesson-follow-up' });
    const submit = within(dialog).getByRole('button', { name: 'Create variant' });
    fireEvent.change(within(dialog).getByLabelText('Language'), { target: { value: 'hi' } });
    fireEvent.change(within(dialog).getByLabelText('Title of the variant'), { target: { value: 'Hindi title' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_LANGUAGE' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/lessons/${lessonId}/variants`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ language: 'hi', level: 'STANDARD', style: 'EXPLANATION', title: 'Hindi title', reasonCode: 'NEW_LANGUAGE' });
  });

  it('shows NA where nothing is set and marks an agent-drafted variant for the expert', async () => {
    detailBody = detail({ topic: null, moduleKey: null, open: revision({
      state: 'IN_REVIEW', fields: fields({ basis: null, practice: null }),
      agentDraft: { generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-16-variants-v1', generatedAt: '2026-09-28T00:00:00.000Z' },
      expertCheck: 'A native Telugu speaker must check this translation.',
    }) });
    const region = await openLesson();
    expect(within(region).getByText('Basis').nextSibling?.textContent).toBe('NA');
    expect(within(region).getByText('Practice').nextSibling?.textContent).toBe('NA');
    expect(within(region).getAllByText('Module')[0]!.nextSibling?.textContent).toBe('NA');
    expect(within(region).getByText('Drafted by').nextSibling?.textContent).toMatch(/^The coding agent \(claude-opus-5-5, eng-16-variants-v1, .+\) — check it against its basis$/);
    expect(within(region).getByText('For the subject expert').nextSibling?.textContent).toBe('A native Telugu speaker must check this translation.');
  });

  it('archives a live lesson with a reason code, saying it leaves the catalogue and needs no second person', async () => {
    detailBody = detail({ status: 'LIVE', publishedRevision: 1, openRevision: null, open: null, current: revision({ state: 'PUBLISHED' }) });
    const region = await openLesson();
    fireEvent.click(within(region).getByRole('button', { name: 'Archive…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive ops-lesson-follow-up' });
    expect(within(dialog).getByText(/leaves the catalogue at once/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'RIGHTS_WITHDRAWN' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive lesson' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toMatch(/\/api\/v1\/operations\/lessons\/lessons\/[0-9a-f-]+\/archive$/);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'RIGHTS_WITHDRAWN' });
  });

  it('keeps the Operations navigation labels unchanged', () => {
    const operations = rolePortals.find((portal) => portal.key === 'operations-admin')!;
    expect(operations.nav.map((item) => item.label)).toEqual([
      'Overview', 'Organizations', 'Organization Detail', 'Users', 'User Detail', 'Verification', 'Trust and Safety', 'Content Management', 'AI Operations',
      'Subscriptions', 'Billing', 'Analytics', 'System Health', 'Audit Logs', 'Security', 'Feature Flags', 'Support', 'Settings',
    ]);
  });
});

describe('the approvals queue carries out an approved lesson publish', () => {
  it('describes it in plain words and replays the stored payload to the publish endpoint', async () => {
    const approvalId = crypto.randomUUID();
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return ok({ lesson: detail(), correlationId: 'corr-publish' });
      return ok({
        approvals: [{
          id: approvalId, actionKey: 'CONTENT_LESSON_PUBLISH', actionLabel: 'Publish a lesson that changes readiness inputs', state: 'APPROVED',
          payload: { revisionId, contentHash: 'c'.repeat(64), reasonCode: 'NEW_LESSON' },
          summary: { organizationName: null, flagKey: null, enabled: null, capability: null, memberEmail: null, holdReason: null, olderThan: null, limit: null,
            questionKey: null, questionRevision: null, lessonKey: 'ops-lesson-follow-up', lessonVariant: 'en/STANDARD/EXPLANATION', lessonRevision: 1 },
          reasonCode: 'NEW_LESSON', note: null, requestedBy: { email: 'publisher@example.test', isSelf: true },
          requestedAt: '2026-09-28T10:00:00.000000Z', expiresAt: '2026-09-29T10:00:00.000000Z', coolingOffEndsAt: '2026-09-28T10:15:00.000000Z',
          decidedBy: { email: 'approver@example.test', isSelf: false }, decidedAt: '2026-09-28T10:05:00.000Z', decisionReasonCode: 'VERIFIED_NEED',
          mode: 'DUAL', soloNotice: null, executedAt: null, canApprove: false, canReject: false, approveRefusal: 'APPROVAL_NOT_PENDING', canExecute: true,
        }],
        nextCursor: null, decisionReasons: { APPROVE: ['VERIFIED_NEED'], REJECT: ['NOT_NEEDED'] }, approverCount: 2, soloSafeguardActive: false, viewerIsApprover: false, correlationId: 'corr-q',
      });
    });
    render(<OperationsApprovalsPanel />);
    expect(await screen.findByText('Publish revision 1 of the lesson ops-lesson-follow-up (en/STANDARD/EXPLANATION)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(String(posts()[0]![0])).toContain(`/operations/lessons/revisions/${revisionId}/publish`);
    expect(JSON.parse(String(posts()[0]![1].body))).toEqual({ reasonCode: 'NEW_LESSON', approvalId });
  });
});
