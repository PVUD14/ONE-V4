/**
 * ONE · Role portal — the content factory's pieces for the lesson editor and the question bank
 * (ENG-23): the "AI drafts" card with **Draft with AI**, the dialog that asks for a translation of a
 * live lesson, the "AI draft" provenance block a reviewer sees, and the answer-key check.
 *
 * Why this exists: the factory adds no screen and no navigation item (HG-3); it lives inside the two
 * editors that already own lessons and questions. Asking only queues a job — the worker drafts it
 * later — so the card shows each job's state and links to the draft once it lands. A draft is the
 * requester's, so the editors' own rules keep them from approving or publishing it; this file says so
 * plainly and never offers a shortcut. Missing figures read NA; nothing here is invented.
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  getContentFactoryStatus,
  listContentDrafts,
  requestContentDraft,
} from '../api.js';
import type { AiDraftDto, ContentDraftDto, ContentDraftKind, ContentDraftRequestDto, ContentFactoryStatusDto } from '../api.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';

const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');
const label = (value: string): string => value.split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
const keyPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

const stateText: Readonly<Record<string, string>> = {
  QUEUED: 'Waiting for the worker', RUNNING: 'Drafting', SUCCEEDED: 'Drafted', REFUSED: 'Refused', REJECTED: 'Rejected by the checks', FAILED: 'Failed',
};
const stateTone = (state: string): 'success' | 'warning' | 'neutral' | 'info' | 'danger' =>
  state === 'SUCCEEDED' ? 'success' : state === 'QUEUED' || state === 'RUNNING' ? 'info' : state === 'REJECTED' || state === 'FAILED' ? 'danger' : 'warning';

/** Why a job landed nothing, in words. Unknown codes are shown as they are. */
const outcomeText: Readonly<Record<string, string>> = {
  CAP_EXCEEDED: "Today's limit for this feature was reached before the call.",
  KILL_SWITCH_ENGAGED: 'AI was stopped by the kill switch before the call.',
  FEATURE_DISABLED: 'The feature was switched off before the call.',
  INPUT_TOO_LARGE: 'The request was too long for this feature.',
  MODEL_REFUSED: 'The model declined: the request asked for something its rules forbid.',
  GUARD_REJECTED: 'The checks found a problem in the reply, so nothing was saved.',
  TARGET_CHANGED: 'The skill, lesson or question changed before the draft was made.',
  ATTEMPTS_EXHAUSTED: 'Three attempts did not finish.',
  PROVIDER_UNCONFIGURED: 'The AI endpoint is not configured on the server.',
  PROVIDER_TIMEOUT: 'The AI endpoint took too long to answer.',
  PROVIDER_UNREACHABLE: 'The AI endpoint could not be reached.',
  PROVIDER_MODEL_MISMATCH: 'The server serves a different model from the one this feature was evaluated on.',
};
const findingText: Readonly<Record<string, string>> = {
  FORMAT_INVALID: 'not in the expected shape', TRUNCATED: 'cut off', LANGUAGE_MISMATCH: 'not in the requested language',
  PERSONAL_DATA: 'personal data', READINESS_FIGURE: 'a readiness figure', PLACEMENT_CHANCE: "someone's job or placement chances",
  OUTCOME_PROMISE: 'a promised outcome', QUOTES_ASSESSMENT_ITEM: 'a copy of an assessment question', DUPLICATE_OPTIONS: 'two identical options',
  HINT_MISSING: 'a missing hint', HINT_REPEATS_EARLIER: 'a hint repeating an earlier one', HINT_NAMES_ANSWER: 'a hint stating the answer',
  HINT_NAMES_OPTION: 'a hint pointing at the correct option',
};
const kindText: Readonly<Record<ContentDraftKind, string>> = {
  LESSON: 'Lesson', LESSON_VARIANT: 'Translation', QUESTION: 'Practice question', ANSWER_CHECK: 'Answer-key check',
};

/** The request's refusals, in words; the reference is always shown. */
export function aiRequestError(cause: unknown, fallback: string): string {
  const code = cause instanceof ApiRequestError ? cause.code : undefined;
  const words: Readonly<Record<string, string>> = {
    AI_FEATURE_DISABLED: 'This AI feature is switched off. AI Operations switches it on after it passes its evaluation.',
    AI_KILL_SWITCH_ENGAGED: 'AI is stopped by the kill switch. Nothing is drafted until AI Operations releases it.',
    AI_FEATURE_NOT_REGISTERED: 'This AI feature is not set up on this server yet.',
    AI_CAP_REACHED: "Today's limit for this AI feature is reached, counting the drafts already waiting. Try again tomorrow.",
    AI_DRAFTS_IN_FLIGHT: 'You already have three AI drafts waiting. Wait for one to finish.',
    AI_NOTE_PERSONAL_DATA: 'The note contains an e-mail address or phone number. Remove it: the note is sent to the AI.',
    AI_DRAFT_KEY_EXISTS: 'That key is already used, or already waiting for an AI draft. Choose another.',
    AI_DRAFT_VARIANT_EXISTS: 'That language, level and style already exists for this lesson, or is already being drafted.',
    AI_DRAFT_TOPIC_UNKNOWN: 'No live or pending skill has that key.',
    AI_DRAFT_BASE_NOT_LIVE: 'Only a published lesson can be translated.',
    AI_DRAFT_LANGUAGE_NOT_EVALUATED: 'AI translation is not offered in that language yet: the model has not passed its evaluation in it. A person can still write the translation.',
    AI_DRAFT_QUESTION_NOT_CHECKABLE: 'The question needs its prompt, every option and an answer key before it can be checked.',
  };
  return formatApiError(cause, (code && words[code]) || fallback);
}

function outcomeLine(draft: ContentDraftDto): string {
  if (draft.state === 'REJECTED') {
    const found = draft.findings.map((finding) => findingText[finding] ?? label(finding)).join(', ');
    return `${outcomeText.GUARD_REJECTED} Found: ${found || 'NA'}.`;
  }
  if (draft.outcomeCode) return outcomeText[draft.outcomeCode] ?? label(draft.outcomeCode);
  if (draft.state === 'SUCCEEDED' && draft.kind === 'ANSWER_CHECK') return 'Checked — see the question.';
  if (draft.state === 'SUCCEEDED') return draft.generation && draft.generation.fitted ? 'Drafted; the text was shortened to fit — the full text is in the draft.' : 'Drafted.';
  return '';
}

function targetLine(draft: ContentDraftDto): string {
  const target = draft.target;
  if (draft.kind === 'LESSON_VARIANT') return `${target.baseLesson ? target.baseLesson.stableKey : 'NA'} → ${target.language}`;
  if (draft.kind === 'ANSWER_CHECK') return 'A question under review';
  return `${target.stableKey ?? 'NA'} · ${target.topic ? target.topic.name : 'NA'}`;
}

function featureFor(status: ContentFactoryStatusDto | null, kind: ContentDraftKind) {
  return status ? status.features.find((feature) => feature.kinds.includes(kind)) ?? null : null;
}

function FeatureState({ status, kind }: { readonly status: ContentFactoryStatusDto | null; readonly kind: ContentDraftKind }): React.ReactElement {
  const feature = featureFor(status, kind);
  if (!status || !feature) return <StatusBadge label="NA" tone="neutral" />;
  if (status.killSwitchEngaged) return <StatusBadge label="Stopped by the kill switch" tone="danger" />;
  if (!feature.registered) return <StatusBadge label="Not set up" tone="neutral" />;
  if (!feature.switchedOn) return <StatusBadge label="Off" tone="neutral" />;
  return <StatusBadge label={feature.available ? 'On' : 'Unavailable'} tone={feature.available ? 'success' : 'warning'} />;
}

export interface LessonVocabulary {
  readonly languages: readonly { readonly language: string; readonly name: string }[];
  readonly levels: readonly { readonly level: string; readonly meaning: string }[];
  readonly styles: readonly { readonly style: string; readonly meaning: string }[];
}

/**
 * The "AI drafts" card: the feature's state and today's use, Draft with AI, and recent jobs.
 * `scope` picks lessons (lessons and translations) or questions (questions and answer checks).
 */
export function AiDraftsCard({ token, scope, vocabulary, onOpenLesson, onOpenQuestion, reload = 0 }: {
  readonly token: string; readonly scope: 'LESSONS' | 'QUESTIONS'; readonly vocabulary?: LessonVocabulary;
  readonly onOpenLesson?: (lessonId: string) => void; readonly onOpenQuestion?: (questionId: string) => void; readonly reload?: number;
}): React.ReactElement {
  const kinds: readonly ContentDraftKind[] = scope === 'LESSONS' ? ['LESSON', 'LESSON_VARIANT'] : ['QUESTION', 'ANSWER_CHECK'];
  const draftKind: ContentDraftKind = scope === 'LESSONS' ? 'LESSON' : 'QUESTION';
  const [status, setStatus] = useState<ContentFactoryStatusDto | null>(null);
  const [drafts, setDrafts] = useState<readonly ContentDraftDto[] | null>(null);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(false);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getContentFactoryStatus(token, controller.signal), listContentDrafts(token, { kinds, limit: 10 }, controller.signal)])
      .then(([loaded, list]) => { setStatus(loaded); setDrafts(list.drafts); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setHidden(true);
        else setError(formatApiError(cause, 'Unable to load the AI drafts.'));
      });
    return () => controller.abort();
  }, [token, scope, tick, reload]);

  // Jobs run in the background: look again while any is waiting or drafting.
  const waiting = drafts ? drafts.some((draft) => draft.state === 'QUEUED' || draft.state === 'RUNNING') : false;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 5_000);
    return () => clearInterval(timer);
  }, [waiting]);

  if (hidden) return <></>;
  const feature = featureFor(status, draftKind);
  const mayRequest = status ? status.viewer.mayRequest[draftKind] : false;
  const available = Boolean(status && feature && feature.available);
  const used = feature && feature.usedInWindow !== null && feature.cap !== null ? `${feature.usedInWindow} of ${feature.cap} ${feature.window === 'MONTH' ? 'this month' : 'today'}` : 'NA';

  return <section className="role-card role-wide" aria-label="AI drafts">
    <div className="role-section-title"><h2>AI drafts</h2>
      {mayRequest ? <button type="button" className="secondary" disabled={!available} onClick={() => setAsking(true)}>Draft with AI…</button> : null}</div>
    <p>ONE&apos;s AI can write a first draft{scope === 'LESSONS' ? ' of a lesson for a skill, or a translation of a published lesson' : ' of a practice question with its four hints, and check the answer key of a question under review'}. A draft appears here and in the list marked <strong>AI draft</strong>, written in your name, and goes through the same review as anything a person writes: you cannot approve or publish it yourself, and no student sees it until a second person publishes it.</p>
    <dl>
      <div><dt>Status</dt><dd><FeatureState status={status} kind={draftKind} /></dd></div>
      <div><dt>Used</dt><dd>{used}</dd></div>
      <div><dt>Waiting or drafting</dt><dd>{feature && feature.openJobs !== null ? feature.openJobs : 'NA'}</dd></div>
      <div><dt>Model</dt><dd>{feature && feature.model ? feature.model : 'NA'}</dd></div>
    </dl>
    {status && feature && !available ? <p role="note"><small>{status.killSwitchEngaged
      ? 'AI is stopped by the kill switch, so nothing can be drafted now.'
      : !feature.registered ? 'This AI feature is not set up on this server yet.'
        : 'This AI feature is off. AI Operations switches it on after it passes its evaluation and a second person approves.'}</small></p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {drafts && !drafts.length ? <p>No AI drafts yet.</p> : null}
    {drafts && drafts.length ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Recent AI drafts">
      <thead><tr><th>Asked</th><th>What</th><th>For</th><th>By</th><th>State</th><th>Outcome</th><th>Draft</th></tr></thead>
      <tbody>{drafts.map((draft) => <tr key={draft.id}>
        <td>{when(draft.requestedAt)}</td><td>{kindText[draft.kind]}</td><td>{targetLine(draft)}</td><td>{draft.requestedBy.email}</td>
        <td><StatusBadge label={stateText[draft.state] ?? label(draft.state)} tone={stateTone(draft.state)} /></td>
        <td>{outcomeLine(draft)}</td>
        <td>{draft.produced && draft.produced.lessonId && onOpenLesson
          ? <button type="button" className="secondary" onClick={() => onOpenLesson(draft.produced!.lessonId!)}>Open draft</button>
          : draft.produced && draft.produced.questionId && onOpenQuestion
            ? <button type="button" className="secondary" onClick={() => onOpenQuestion(draft.produced!.questionId!)}>Open draft</button> : 'NA'}</td>
      </tr>)}</tbody></table></div> : null}
    <button type="button" className="secondary" onClick={() => setTick((value) => value + 1)}>Refresh</button>
    {asking && status ? <DraftWithAiDialog token={token} kind={draftKind} status={status} {...(vocabulary ? { vocabulary } : {})}
      onCancel={() => setAsking(false)}
      onQueued={() => { setAsking(false); setNotice('Asked. The draft appears here when the worker has written it; you can keep working.'); setTick((value) => value + 1); }} /> : null}
  </section>;
}

const difficulties = [
  { level: 'FOUNDATION', meaning: 'Checks the core idea directly' },
  { level: 'INTERMEDIATE', meaning: 'Applies the idea to an ordinary case' },
  { level: 'ADVANCED', meaning: 'Combines ideas or handles an unusual case' },
];

function DraftWithAiDialog({ token, kind, status, vocabulary, onCancel, onQueued }: {
  readonly token: string; readonly kind: 'LESSON' | 'QUESTION' | ContentDraftKind; readonly status: ContentFactoryStatusDto;
  readonly vocabulary?: LessonVocabulary; readonly onCancel: () => void; readonly onQueued: () => void;
}): React.ReactElement {
  const lesson = kind === 'LESSON';
  const [form, setForm] = useState({ topicKey: '', stableKey: '', title: '', level: lesson ? 'STANDARD' : 'INTERMEDIATE', style: 'EXPLANATION', authorNote: '', reasonCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = keyPattern.test(form.topicKey) && keyPattern.test(form.stableKey) && Boolean(form.reasonCode) && (!lesson || Boolean(form.title.trim()));
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) { setError('Give the skill key, a new key, a reason code' + (lesson ? ' and a title.' : '.')); return; }
    setBusy(true);
    try {
      const body: ContentDraftRequestDto = {
        kind, topicKey: form.topicKey, stableKey: form.stableKey, level: form.level, reasonCode: form.reasonCode,
        ...(lesson ? { title: form.title.trim(), style: form.style } : {}),
        ...(form.authorNote.trim() ? { authorNote: form.authorNote.trim() } : {}),
      };
      await requestContentDraft(token, body);
      onQueued();
    } catch (cause) {
      setError(aiRequestError(cause, 'The AI draft could not be requested.'));
      setBusy(false);
    }
  };
  const levels = lesson ? (vocabulary ? vocabulary.levels : []) : difficulties;
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="ai-draft-title">
      <h2 id="ai-draft-title">{lesson ? 'Draft a lesson with AI' : 'Draft a practice question with AI'}</h2>
      <dl><div><dt>Approval</dt><dd>Not required to ask. The draft is written in your name, so someone else reviews it, and it is published only through the usual review and second-person approval.</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Skill key <em>required</em></span><input value={form.topicKey} maxLength={80} placeholder="e.g. soc-alert-triage"
          onChange={(event) => setForm({ ...form, topicKey: event.target.value.trim().toLowerCase() })} /></label>
        <label><span>{lesson ? 'Key of the new lesson' : 'Key of the new question'} <em>required, cannot change later</em></span>
          <input value={form.stableKey} maxLength={80} placeholder={form.topicKey ? `${form.topicKey}-${lesson ? 'lesson' : 'q1'}` : ''}
            onChange={(event) => setForm({ ...form, stableKey: event.target.value.trim().toLowerCase() })} /></label>
        {lesson ? <label><span>Title</span><input value={form.title} maxLength={200} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label> : null}
        <label><span>{lesson ? 'Level' : 'Difficulty'}</span><select aria-label={lesson ? 'Level' : 'Difficulty'} value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>
          {levels.map((entry) => <option key={entry.level} value={entry.level}>{label(entry.level)} — {entry.meaning}</option>)}</select></label>
        {lesson && vocabulary ? <label><span>Style</span><select aria-label="Style" value={form.style} onChange={(event) => setForm({ ...form, style: event.target.value })}>
          {vocabulary.styles.map((entry) => <option key={entry.style} value={entry.style}>{label(entry.style)} — {entry.meaning}</option>)}</select></label> : null}
        <label><span>Note for the AI (optional) — never personal data</span>
          <textarea value={form.authorNote} maxLength={status.limits.authorNote} onChange={(event) => setForm({ ...form, authorNote: event.target.value })} /></label>
        <label><span>Reason code <em>required</em></span>
          <select value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {(status.reasons[kind] ?? []).map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Asking…' : 'Ask for a draft'}</button>
        </div>
      </form>
    </section>
  </div>;
}

/** Ask for a translation (or another level or style) of a published lesson. */
export function TranslateWithAiDialog({ token, lessonId, lessonKey, vocabulary, current, onCancel, onQueued }: {
  readonly token: string; readonly lessonId: string; readonly lessonKey: string; readonly vocabulary: LessonVocabulary;
  readonly current: { readonly level: string; readonly style: string }; readonly onCancel: () => void; readonly onQueued: () => void;
}): React.ReactElement {
  const [status, setStatus] = useState<ContentFactoryStatusDto | null>(null);
  const [form, setForm] = useState({ language: '', level: current.level, style: current.style, title: '', authorNote: '', reasonCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getContentFactoryStatus(token, controller.signal).then(setStatus).catch((cause) => {
      if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load the AI status.'));
    });
    return () => controller.abort();
  }, [token]);
  const feature = featureFor(status, 'LESSON_VARIANT');
  const available = Boolean(status && feature && feature.available);
  const ready = available && Boolean(form.language && form.reasonCode && form.title.trim());
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) { setError('Choose a language and a reason code, and give the translation a title.'); return; }
    setBusy(true);
    try {
      await requestContentDraft(token, {
        kind: 'LESSON_VARIANT', baseLessonId: lessonId, language: form.language, level: form.level, style: form.style, title: form.title.trim(),
        reasonCode: form.reasonCode, ...(form.authorNote.trim() ? { authorNote: form.authorNote.trim() } : {}),
      });
      onQueued();
    } catch (cause) {
      setError(aiRequestError(cause, 'The AI translation could not be requested.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="ai-translate-title">
      <h2 id="ai-translate-title">Draft a translation of {lessonKey} with AI</h2>
      <dl>
        <div><dt>Status</dt><dd><FeatureState status={status} kind="LESSON_VARIANT" /></dd></div>
        <div><dt>Approval</dt><dd>Not required to ask. The translation is written in your name and marked for native-speaker review: someone who reads the language checks it before it is approved.</dd></div>
      </dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Language <em>required</em></span><select aria-label="Language" value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}>
          <option value="">Choose a language…</option>
          {vocabulary.languages.filter((entry) => (status?.translationLanguages ?? []).includes(entry.language)).map((entry) => <option key={entry.language} value={entry.language}>{entry.name} ({entry.language})</option>)}</select></label>
        <label><span>Level</span><select aria-label="Level" value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>
          {vocabulary.levels.map((entry) => <option key={entry.level} value={entry.level}>{label(entry.level)} — {entry.meaning}</option>)}</select></label>
        <label><span>Style</span><select aria-label="Style" value={form.style} onChange={(event) => setForm({ ...form, style: event.target.value })}>
          {vocabulary.styles.map((entry) => <option key={entry.style} value={entry.style}>{label(entry.style)} — {entry.meaning}</option>)}</select></label>
        <label><span>Title of the translation</span><input value={form.title} maxLength={200} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
        <label><span>Note for the AI (optional) — never personal data</span>
          <textarea value={form.authorNote} maxLength={status ? status.limits.authorNote : 1000} onChange={(event) => setForm({ ...form, authorNote: event.target.value })} /></label>
        <label><span>Reason code <em>required</em></span>
          <select value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {(status ? status.reasons.LESSON_VARIANT : []).map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {status && !available ? <p role="note"><small>This AI feature is not available now, so nothing can be asked for.</small></p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Asking…' : 'Ask for a translation'}</button>
        </div>
      </form>
    </section>
  </div>;
}

/** What a reviewer sees on an AI draft: the label, where it came from, and the model's full text. */
export function AiDraftProvenance({ aiDraft, author }: { readonly aiDraft: AiDraftDto; readonly author?: string }): React.ReactElement {
  return <div aria-label="AI draft provenance">
    <p><StatusBadge label="AI draft" tone="warning" /> <small>Written by ONE&apos;s AI{author ? ` at the request of ${author}` : ''}. Check every fact, example and number before approving; a person must review and publish it.</small></p>
    <dl>
      <div><dt>Model</dt><dd>{aiDraft.model}</dd></div>
      <div><dt>Prompt version</dt><dd>{aiDraft.promptVersion}</dd></div>
      <div><dt>Generator</dt><dd>{aiDraft.generatorVersion}</dd></div>
      <div><dt>Generated</dt><dd>{when(aiDraft.generatedAt)}</dd></div>
      <div><dt>Job</dt><dd>{aiDraft.jobId}</dd></div>
    </dl>
    {aiDraft.fitted ? <p role="note"><small>The model&apos;s text was longer than a lesson allows, so it was shortened at a sentence to fit. The full text is below.</small></p> : null}
    {aiDraft.sections ? <details><summary>The model&apos;s full text</summary>
      {Object.entries(aiDraft.sections).map(([heading, text]) => <div key={heading}><h5>{heading}</h5>
        {(text ? text.split(/\n{2,}/u) : ['NA']).map((part, index) => <p key={index}>{part}</p>)}</div>)}
    </details> : null}
  </div>;
}

/** The answer-key check on a question revision: reviewers ask for it; only answer-key holders see the result. */
export function AnswerKeyCheck({ token, revisionId, editable }: { readonly token: string; readonly revisionId: string; readonly editable: boolean }): React.ReactElement | null {
  const [status, setStatus] = useState<ContentFactoryStatusDto | null>(null);
  const [checks, setChecks] = useState<readonly ContentDraftDto[] | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getContentFactoryStatus(token, controller.signal), listContentDrafts(token, { kinds: ['ANSWER_CHECK'], questionRevisionId: revisionId, limit: 5 }, controller.signal)])
      .then(([loaded, list]) => { setStatus(loaded); setChecks(list.drafts); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setHidden(true);
        else setError(formatApiError(cause, 'Unable to load the answer-key checks.'));
      });
    return () => controller.abort();
  }, [token, revisionId, tick]);
  const waiting = checks ? checks.some((check) => check.state === 'QUEUED' || check.state === 'RUNNING') : false;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 5_000);
    return () => clearInterval(timer);
  }, [waiting]);
  if (hidden || !status || !status.viewer.seesAnswerChecks) return null;
  const feature = featureFor(status, 'ANSWER_CHECK');
  const latest = checks && checks.length ? checks[0]! : null;
  const ask = async (): Promise<void> => {
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      await requestContentDraft(token, { kind: 'ANSWER_CHECK', questionRevisionId: revisionId, reasonCode });
      setNotice('Asked. The check appears here when the worker has run it.');
      setError('');
      setTick((value) => value + 1);
    } catch (cause) {
      setError(aiRequestError(cause, 'The answer-key check could not be requested.'));
    } finally { setBusy(false); }
  };
  return <section aria-label="Answer-key check">
    <h4>Answer-key check by AI</h4>
    <p><small>ONE&apos;s AI solves the question on its own and says whether it agrees with the key. It is advice for the reviewer: it changes nothing and never decides.</small></p>
    {latest && latest.check ? <p role="status">
      <StatusBadge label={latest.check.agreesWithKey ? 'Agrees with the key' : 'Disagrees with the key'} tone={latest.check.agreesWithKey ? 'success' : 'danger'} />{' '}
      The AI chose option {latest.check.option}. {latest.check.working}
      {latest.check.stale ? ' (The question has been edited since this check.)' : ''} <small>{when(latest.finishedAt)} · {latest.generation ? latest.generation.model : 'NA'}</small></p>
      : latest ? <p>{stateText[latest.state] ?? label(latest.state)}: {outcomeLine(latest) || 'NA'}</p> : <p>No check yet.</p>}
    {status.viewer.mayRequest.ANSWER_CHECK && editable ? <div className="role-actions">
      <label><span>Reason code</span><select aria-label="Check reason" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
        <option value="">Choose a reason…</option>
        {status.reasons.ANSWER_CHECK.map((reason) => <option key={reason} value={reason}>{reason}</option>)}</select></label>
      <button type="button" className="secondary" disabled={busy || !feature || !feature.available || waiting} onClick={() => void ask()}>Check the answer key with AI</button>
    </div> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
