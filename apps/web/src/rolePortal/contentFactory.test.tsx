/**
 * The content factory on the web (ENG-23): the AI drafts card shows the feature's real state and
 * today's use against the cap (NA when unknown), lists jobs with their outcome in words, asks for a
 * draft only with a skill, a key, a title and a reason, and shows a typed refusal plainly; when the
 * feature is off or the kill switch is engaged nothing can be asked for; an AI draft carries its
 * label and provenance; a translation request is a LESSON_VARIANT; the answer-key check is shown
 * only to answer-key holders and says whether the AI agrees with the key.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiDraftProvenance, AiDraftsCard, AnswerKeyCheck, TranslateWithAiDialog } from './contentFactory.js';

const token = 'test-token';
const viewerId = crypto.randomUUID();
const lessonId = crypto.randomUUID();
const revisionId = crypto.randomUUID();
const vocabulary = {
  languages: [{ language: 'en', name: 'English' }, { language: 'hi', name: 'Hindi' }, { language: 'te', name: 'Telugu' }],
  levels: [{ level: 'FOUNDATION', meaning: 'Simpler' }, { level: 'STANDARD', meaning: 'As written' }],
  styles: [{ style: 'EXPLANATION', meaning: 'Prose' }, { style: 'SUMMARY', meaning: 'Recap' }],
};

const feature = (featureKey: string, kinds: string[], over: Record<string, unknown> = {}) => ({
  featureKey, kinds, registered: true, switchedOn: true, available: true, cap: 50, window: 'DAY', usedInWindow: 3, openJobs: 1,
  model: 'qwen2.5-14b-instruct', prompt: { key: 'p', version: 1 }, ...over,
});
const status = (over: Record<string, unknown> = {}, viewer: Record<string, unknown> = {}) => ({
  killSwitchEngaged: false,
  features: [
    feature('content.lesson-draft', ['LESSON', 'LESSON_VARIANT']),
    feature('content.item-draft', ['QUESTION'], { switchedOn: false, available: false, usedInWindow: 0 }),
    feature('content.answer-check', ['ANSWER_CHECK']),
  ],
  maxInFlight: 3, viewerOpenJobs: 0, translationLanguages: ['en', 'hi'],
  viewer: { userId: viewerId, mayRequest: { LESSON: true, LESSON_VARIANT: true, QUESTION: true, ANSWER_CHECK: true }, seesAnswerChecks: true, ...viewer },
  reasons: { LESSON: ['NEW_LESSON', 'TRACK_BUILD'], LESSON_VARIANT: ['NEW_LANGUAGE'], QUESTION: ['NEW_QUESTION'], ANSWER_CHECK: ['ANSWER_KEY_CHECK'] },
  limits: { authorNote: 1000 }, correlationId: 'corr-status', ...over,
});
const draft = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), kind: 'LESSON', state: 'SUCCEEDED', outcomeCode: null, findings: [],
  requestedBy: { userId: viewerId, email: 'editor@example.test' }, requestedAt: '2026-10-02T10:00:00.000Z', startedAt: null, finishedAt: '2026-10-02T10:01:00.000Z', attempts: 1,
  target: { topic: { id: crypto.randomUUID(), stableKey: 'soc-subnetting', name: 'Subnetting' }, baseLesson: null, questionRevisionId: null, stableKey: 'soc-subnet-lesson', title: 'Subnets', language: 'en', level: 'STANDARD', style: 'EXPLANATION', authorNote: null },
  prompt: { key: 'content-lesson-draft', version: 1 },
  generation: { source: 'AI_GENERATED', generatorVersion: 'g', model: 'qwen2.5-14b-instruct', generatedAt: '2026-10-02T10:01:00.000Z', fitted: false, truncated: false },
  produced: { lessonId, questionId: null, revisionId }, check: null, ...over,
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string) => Promise.resolve({ ok: false, status, json: async () => ({ error: { code, correlationId: 'corr-refused' } }), headers: new Headers() });
let statusBody: unknown;
let draftsBody: unknown[];
let postAnswer: () => Promise<unknown>;

beforeEach(() => {
  statusBody = status();
  draftsBody = [draft(), draft({ state: 'REJECTED', outcomeCode: 'GUARD_REJECTED', findings: ['PERSONAL_DATA'], produced: null, target: { ...draft().target, stableKey: 'soc-rejected' } }),
    draft({ state: 'REFUSED', outcomeCode: 'CAP_EXCEEDED', produced: null, generation: null, target: { ...draft().target, stableKey: 'soc-capped' } })];
  postAnswer = () => ok({ draft: draft({ state: 'QUEUED', produced: null, generation: null }), correlationId: 'corr-post' });
  fetchMock.mockReset().mockImplementation((url: string, init?: { method?: string }) => {
    const path = String(url);
    if (init?.method === 'POST') return postAnswer();
    if (path.includes('/content-factory/status')) return ok(statusBody);
    if (path.includes('/content-factory/drafts')) return ok({ drafts: draftsBody, correlationId: 'corr-drafts' });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posted = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);

describe('the AI drafts card', () => {
  it('shows the real state, today\'s use against the cap and each job\'s outcome in words, and opens a landed draft', async () => {
    const onOpenLesson = vi.fn();
    render(<AiDraftsCard token={token} scope="LESSONS" vocabulary={vocabulary} onOpenLesson={onOpenLesson} />);
    const card = await screen.findByRole('region', { name: 'AI drafts' });
    expect(await within(card).findByText('3 of 50 today')).toBeInTheDocument();
    expect(within(card).getByText('On', { selector: '.status-pill' })).toBeInTheDocument();
    expect(within(card).getByText('qwen2.5-14b-instruct')).toBeInTheDocument();
    expect(within(card).getByText(/you cannot approve or publish it yourself/)).toBeInTheDocument();
    const table = within(card).getByRole('table', { name: 'Recent AI drafts' });
    expect(within(table).getByText(/Found: personal data/)).toBeInTheDocument();
    expect(within(table).getByText("Today's limit for this feature was reached before the call.")).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Open draft' }));
    expect(onOpenLesson).toHaveBeenCalledWith(lessonId);
    // The lesson card asks only about lessons and translations.
    expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes('/drafts'))![0])).toContain('kinds=LESSON%2CLESSON_VARIANT');
  });

  it('asks for a lesson only with a skill, a key, a title and a reason, and sends exactly that', async () => {
    render(<AiDraftsCard token={token} scope="LESSONS" vocabulary={vocabulary} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft with AI…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Draft a lesson with AI' });
    const submit = within(dialog).getByRole('button', { name: 'Ask for a draft' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Skill key/), { target: { value: 'soc-subnetting' } });
    fireEvent.change(within(dialog).getByLabelText(/Key of the new lesson/), { target: { value: 'soc-subnet-lesson' } });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Reading a subnet mask' } });
    fireEvent.change(within(dialog).getByLabelText(/Note for the AI/), { target: { value: 'Use a home router.' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_LESSON' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toEqual({
      kind: 'LESSON', topicKey: 'soc-subnetting', stableKey: 'soc-subnet-lesson', level: 'STANDARD', reasonCode: 'NEW_LESSON',
      title: 'Reading a subnet mask', style: 'EXPLANATION', authorNote: 'Use a home router.',
    });
    expect(await screen.findByText(/The draft appears here when the worker has written it/)).toBeInTheDocument();
  });

  it('shows a typed refusal in plain words with its reference', async () => {
    postAnswer = () => failure(429, 'AI_CAP_REACHED');
    render(<AiDraftsCard token={token} scope="LESSONS" vocabulary={vocabulary} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft with AI…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Draft a lesson with AI' });
    fireEvent.change(within(dialog).getByLabelText(/Skill key/), { target: { value: 'soc-subnetting' } });
    fireEvent.change(within(dialog).getByLabelText(/Key of the new lesson/), { target: { value: 'soc-subnet-lesson' } });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Subnets' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_LESSON' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for a draft' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain("Today's limit for this AI feature is reached");
    expect(alert.textContent).toContain('Support code: corrrefu');
  });

  it('offers nothing to ask for when the feature is off, and says why', async () => {
    render(<AiDraftsCard token={token} scope="QUESTIONS" />);
    const card = await screen.findByRole('region', { name: 'AI drafts' });
    expect(await within(card).findByText('Off', { selector: '.status-pill' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Draft with AI…' })).toBeDisabled();
    expect(within(card).getByText(/This AI feature is off/)).toBeInTheDocument();
  });

  it('says the kill switch stopped AI, and reads NA where the server has no figure', async () => {
    statusBody = status({ killSwitchEngaged: true, features: [feature('content.lesson-draft', ['LESSON', 'LESSON_VARIANT'], { available: false, cap: null, usedInWindow: null, openJobs: null, model: null })] });
    draftsBody = [];
    render(<AiDraftsCard token={token} scope="LESSONS" vocabulary={vocabulary} />);
    const card = await screen.findByRole('region', { name: 'AI drafts' });
    expect(await within(card).findByText('Stopped by the kill switch')).toBeInTheDocument();
    expect(within(card).getAllByText('NA').length).toBeGreaterThanOrEqual(3);
    expect(within(card).getByText('No AI drafts yet.')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Draft with AI…' })).toBeDisabled();
  });

  it('is not shown at all to someone who may not see it', async () => {
    fetchMock.mockImplementation(() => failure(403, 'FORBIDDEN'));
    const { container } = render(<AiDraftsCard token={token} scope="LESSONS" vocabulary={vocabulary} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[aria-label="AI drafts"]')).toBeNull());
  });
});

describe('a translation with AI', () => {
  it('is a LESSON_VARIANT of the live lesson, in the chosen language', async () => {
    const onQueued = vi.fn();
    render(<TranslateWithAiDialog token={token} lessonId={lessonId} lessonKey="write-for-action" vocabulary={vocabulary}
      current={{ level: 'STANDARD', style: 'EXPLANATION' }} onCancel={() => undefined} onQueued={onQueued} />);
    const dialog = await screen.findByRole('dialog', { name: 'Draft a translation of write-for-action with AI' });
    expect(within(dialog).getByText(/marked for native-speaker review/)).toBeInTheDocument();
    await within(dialog).findByText('On', { selector: '.status-pill' });
    // Only the languages the model passed its evaluation in are offered: Telugu is not.
    expect(within(dialog).getByRole('option', { name: 'Hindi (hi)' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: 'Telugu (te)' })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Language'), { target: { value: 'hi' } });
    fireEvent.change(within(dialog).getByLabelText('Title of the translation'), { target: { value: 'कार्रवाई के लिए लिखें' } });
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'NEW_LANGUAGE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ask for a translation' }));
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(posted()[0]).toEqual({ kind: 'LESSON_VARIANT', baseLessonId: lessonId, language: 'hi', level: 'STANDARD', style: 'EXPLANATION', title: 'कार्रवाई के लिए लिखें', reasonCode: 'NEW_LANGUAGE' });
  });
});

describe('an AI draft in the editor', () => {
  it('is labelled AI draft and shows where it came from and the model\'s full text', () => {
    render(<AiDraftProvenance author="editor@example.test" aiDraft={{
      jobId: 'job-1', generatorVersion: 'one-ai-orchestration-v1', promptVersion: 'content-lesson-draft@1', model: 'qwen2.5-14b-instruct',
      generatedAt: '2026-10-02T10:01:00.000Z', expertCheck: 'Check every fact.', fitted: true,
      sections: { Explanation: 'First paragraph.\n\nSecond paragraph.', 'Check yourself': '' },
    }} />);
    expect(screen.getByText('AI draft', { selector: '.status-pill' })).toBeInTheDocument();
    expect(screen.getByText(/at the request of editor@example.test/)).toBeInTheDocument();
    expect(screen.getByText('content-lesson-draft@1')).toBeInTheDocument();
    expect(screen.getByText(/shortened at a sentence to fit/)).toBeInTheDocument();
    expect(screen.getByText('Second paragraph.')).toBeInTheDocument();
    expect(screen.getByText('NA')).toBeInTheDocument();
  });
});

describe('the answer-key check', () => {
  it('says whether the AI agrees with the key, and asks for a check with a reason', async () => {
    draftsBody = [draft({ kind: 'ANSWER_CHECK', produced: null, check: { option: 'b', working: 'Thirty-two addresses.', agreesWithKey: false, contentHash: 'c'.repeat(64), stale: true, reviewState: 'DRAFT' } })];
    render(<AnswerKeyCheck token={token} revisionId={revisionId} editable />);
    expect(await screen.findByText('Disagrees with the key')).toBeInTheDocument();
    expect(screen.getByText(/The AI chose option b/)).toBeInTheDocument();
    expect(screen.getByText(/edited since this check/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Check reason'), { target: { value: 'ANSWER_KEY_CHECK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check the answer key with AI' }));
    await waitFor(() => expect(posted()).toEqual([{ kind: 'ANSWER_CHECK', questionRevisionId: revisionId, reasonCode: 'ANSWER_KEY_CHECK' }]));
  });

  it('is not shown to someone who may not see answer keys', async () => {
    statusBody = status({}, { seesAnswerChecks: false });
    const { container } = render(<AnswerKeyCheck token={token} revisionId={revisionId} editable />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.querySelector('[aria-label="Answer-key check"]')).toBeNull();
  });
});
