/**
 * ONE · Role portal — Operations Content Management: the question bank editor (OPS-09b).
 *
 * Lives under the existing Content Management label (Appendix 1 §4.2), below the skill map; no
 * navigation item is added. Operators draft a readiness-check question — its skill, options, the
 * correct answer and why, a difficulty band, a misconception for each wrong option where one
 * fits, a four-step hint ladder and the rights its text is under — a different person reviews it
 * (approving is also the rights review), and someone who wrote none of it files the publish,
 * which a second person approves (Settings → Approvals): every published question joins the
 * readiness check.
 *
 * The server decides everything: capabilities, reason codes, who wrote a revision, and whether
 * this viewer may see answer keys (only Content Edit or Content Review). Difficulty is a band,
 * never a number. Missing values read NA.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  createBankQuestion,
  getBankQuestion,
  getProtectedAccessToken,
  getQuestionBankPolicy,
  listBankQuestions,
  publishBankQuestionRevision,
  saveBankQuestionDraft,
  startBankQuestionRevision,
  transitionBankQuestionRevision,
} from '../api.js';
import type {
  BankQuestionDetailDto,
  BankQuestionListDto,
  BankQuestionRevisionDto,
  BankQuestionRevisionState,
  BankQuestionSummaryDto,
  QuestionBankPolicyDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { formatApiError } from './shared.js';

const label = (value: string): string => value.split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');
const statusText = (status: string): string => (status === 'LIVE' ? 'Live' : status === 'PENDING' ? 'Not yet published' : status === 'RETIRED' ? 'Retired' : 'Unknown');
const statusTone = (status: string): 'success' | 'warning' | 'neutral' | 'info' => (status === 'LIVE' ? 'success' : status === 'PENDING' ? 'warning' : 'neutral');
const stateTone = (state: BankQuestionRevisionState): 'success' | 'warning' | 'neutral' | 'info' =>
  state === 'PUBLISHED' ? 'success' : state === 'IN_REVIEW' || state === 'APPROVED' ? 'warning' : state === 'DRAFT' || state === 'CHANGES_REQUESTED' ? 'info' : 'neutral';
const filters = [
  { value: '', text: 'All questions' }, { value: 'LIVE', text: 'Live' }, { value: 'PENDING', text: 'Not yet published' },
  { value: 'AWAITING_REVIEW', text: 'Awaiting review' }, { value: 'CHANGES_REQUESTED', text: 'Changes requested' },
  { value: 'AWAITING_PUBLISH', text: 'Approved, awaiting publish' },
];
const keyPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

export function OperationsQuestionBankPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [policy, setPolicy] = useState<QuestionBankPolicyDto | null>(null);
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [draftFilters, setDraftFilters] = useState({ q: '', filter: '' });
  const [applied, setApplied] = useState(draftFilters);
  const [list, setList] = useState<BankQuestionListDto | null>(null);
  const [more, setMore] = useState<readonly BankQuestionSummaryDto[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getQuestionBankPolicy(token, controller.signal)
      .then((result) => { setPolicy(result); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the question bank policy.'));
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token || forbiddenReference) return;
    const controller = new AbortController();
    setLoading(true);
    listBankQuestions(token, applied, null, controller.signal)
      .then((result) => { setList(result); setMore([]); setMoreCursor(null); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the question bank.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, applied, reload, forbiddenReference]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Content Management</span><h1>Question bank</h1>
    <p>The questions the readiness check can ask: each with its skill, a difficulty band, a misconception for each wrong option where one fits, and four hints from a nudge to a near solution. A question is drafted, reviewed by someone who did not write it (including its rights), and published by someone else with a second person's approval, because every published question joins the readiness check.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="The question bank is for staff who hold Content Edit, Content Review or Content Publish. Your access has not changed; the rest of Content Management is unaffected."
        hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }

  const questions = [...(list ? list.questions : []), ...more];
  const nextCursor = more.length ? moreCursor : list ? list.nextCursor : null;
  const summary = list ? list.summary : null;
  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await listBankQuestions(token, applied, nextCursor);
      setMoreCursor(page.nextCursor);
      setMore((current) => [...current, ...page.questions]);
    } catch (cause) {
      setError(formatApiError(cause, 'Unable to load more questions.'));
    }
  };

  return <section className="role-module role-module--dense" aria-label="Question bank">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="❓" tone="teal" value={summary ? summary.live : 'NA'} label="Live questions" />
      <V2Stat icon="📝" tone="purple" value={summary ? summary.pending : 'NA'} label="Not yet published" />
      <V2Stat icon="🔍" tone="amber" value={summary ? summary.awaitingReview : 'NA'} label="Awaiting review" />
      <V2Stat icon="🚀" tone="blue" value={summary ? summary.awaitingPublish : 'NA'} label="Approved, awaiting publish" />
    </div>
    {policy && !policy.viewer.answerKeys ? <p role="note">You hold Content Publish only, so answer keys, explanations and misconception tags are withheld from you. The reviewer who approved each question checked them.</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="role-card role-wide"><div className="role-section-title"><h2>Questions</h2>
      {policy && policy.viewer.edit ? <button type="button" className="secondary" onClick={() => setCreating(true)}>New question…</button> : null}</div>
      <form className="role-actions" aria-label="Search the question bank" onSubmit={(event) => { event.preventDefault(); setApplied(draftFilters); }}>
        <label className="role-local-search"><span>Search</span>
          <input value={draftFilters.q} maxLength={120} placeholder="Key or prompt" onChange={(event) => setDraftFilters({ ...draftFilters, q: event.target.value })} /></label>
        <label className="role-local-search"><span>Show</span>
          <select aria-label="Question filter" value={draftFilters.filter} onChange={(event) => setDraftFilters({ ...draftFilters, filter: event.target.value })}>
            {filters.map((entry) => <option key={entry.value} value={entry.value}>{entry.text}</option>)}
          </select></label>
        <button type="submit" className="pilot-btn">Search</button>
      </form>
      {loading && !list ? <p>Loading the question bank…</p> : null}
      {!loading && list && !questions.length ? <V2EmptyState icon="🔎" title="No questions match" note="No question matches this search. Questions appear here once drafted in this editor or published by the readiness pilot." /> : null}
      {questions.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Key</th><th>Question</th><th>Skill</th><th>Status</th><th>Current version</th><th>Revision on its way</th><th>Difficulty</th><th>Tagged options</th><th>Hints</th><th>Actions</th></tr></thead>
        <tbody>{questions.map((question) => <tr key={question.questionId}>
          <td><strong>{question.stableKey}</strong></td>
          <td>{question.promptExcerpt || 'NA'}</td>
          <td>{question.topic ? question.topic.stableKey : 'NA'}</td>
          <td><StatusBadge label={statusText(question.status)} tone={statusTone(question.status)} /></td>
          <td>{question.publishedVersion ? `Version ${question.publishedVersion}` : 'NA'}</td>
          <td>{question.openRevision ? `Revision ${question.openRevision.revision} · ${label(question.openRevision.state)}` : 'None'}</td>
          <td>{question.difficulty ? label(question.difficulty) : 'NA'}</td>
          <td>{question.taggedOptionCount} of {question.optionCount}</td>
          <td>{question.hintsComplete ? 'All four written' : 'Incomplete'}</td>
          <td><button type="button" className="secondary" onClick={() => setSelectedId(question.questionId)}>Open {question.stableKey}</button></td>
        </tr>)}</tbody></table></div> : null}
      {nextCursor ? <button type="button" className="secondary" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
    {selectedId && policy ? <QuestionPanel token={token} questionId={selectedId} policy={policy}
      onChanged={() => setReload((value) => value + 1)} onClose={() => setSelectedId('')} /> : null}
    {creating && policy ? <CreateQuestionDialog token={token} policy={policy} onCancel={() => setCreating(false)}
      onCreated={(question) => { setCreating(false); setSelectedId(question.questionId); setReload((value) => value + 1); }} /> : null}
  </section>;
}

type Dialog =
  | { readonly kind: 'revise' }
  | { readonly kind: 'transition'; readonly revision: BankQuestionRevisionDto; readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' }
  | { readonly kind: 'publish'; readonly revision: BankQuestionRevisionDto }
  | { readonly kind: 'publishWithApproval'; readonly revision: BankQuestionRevisionDto };

function QuestionPanel({ token, questionId, policy, onChanged, onClose }: {
  readonly token: string; readonly questionId: string; readonly policy: QuestionBankPolicyDto; readonly onChanged: () => void; readonly onClose: () => void;
}): React.ReactElement {
  const [question, setQuestion] = useState<BankQuestionDetailDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setQuestion(null);
    getBankQuestion(token, questionId, controller.signal)
      .then((result) => { setQuestion(result.question); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this question.')); });
    return () => controller.abort();
  }, [token, questionId]);

  const apply = (updated: BankQuestionDetailDto, message = ''): void => { setQuestion(updated); setError(''); setNotice(message); onChanged(); };

  if (!question) {
    return <section className="role-card role-wide" aria-label="Question"><h2>Question</h2>
      {error ? <p className="form-error" role="alert">{error}</p> : <p>Loading question…</p>}
      <button type="button" className="secondary" onClick={onClose}>Close</button></section>;
  }

  const working = question.open;
  const viewerId = policy.viewer.userId;
  const wroteIt = working ? working.contributors.some((entry) => entry.userId === viewerId) : false;
  const editable = working && (working.state === 'DRAFT' || working.state === 'CHANGES_REQUESTED');

  return <section className="role-card role-wide" aria-label={`Question ${question.stableKey}`}>
    <div className="role-section-title"><h2>{question.stableKey}</h2><button type="button" className="secondary" onClick={onClose}>Close question</button></div>
    <dl>
      <div><dt>Status</dt><dd><StatusBadge label={statusText(question.status)} tone={statusTone(question.status)} /></dd></div>
      <div><dt>Skill</dt><dd>{question.topic ? `${question.topic.name} (${question.topic.stableKey}) · ${statusText(question.topic.status)}` : 'NA'}</dd></div>
      <div><dt>Current version</dt><dd>{question.publishedVersion ?? 'NA'}</dd></div>
      <div><dt>Published versions</dt><dd>{question.versions.length
        ? question.versions.map((entry) => `v${entry.version} ${entry.superseded ? '(replaced)' : '(in the readiness check)'} · ${when(entry.publishedAt)}`).join('; ')
        : 'None yet'}</dd></div>
    </dl>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    {question.current ? <><h3>Published — revision {question.current.revision}</h3><QuestionView revision={question.current} policy={policy} /></> : null}
    {!working && question.status === 'LIVE' && policy.viewer.edit
      ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'revise' })}>Start a new revision…</button> : null}

    {working ? <article className="role-card" aria-label={`Revision ${working.revision}`}>
      <div className="role-section-title"><h3>Revision {working.revision}</h3><StatusBadge label={label(working.state)} tone={stateTone(working.state)} /></div>
      <p><small>Author {working.author.email} · started {when(working.createdAt)}{working.contributors.length > 1 ? ` · also written or submitted by ${working.contributors.filter((entry) => entry.userId !== working.author.userId).map((entry) => entry.email).join(', ')}` : ''}</small></p>
      {editable && policy.viewer.edit
        ? <QuestionEditor token={token} revision={working} question={question} policy={policy} onSaved={(updated) => apply(updated, 'Draft saved.')} />
        : <QuestionView revision={working} policy={policy} />}
      <div className="role-actions">
        {editable && policy.viewer.edit ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'IN_REVIEW' })}>Submit for review…</button> : null}
        {working.state === 'IN_REVIEW' && policy.viewer.review && !wroteIt ? <>
          <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'APPROVED' })}>Approve, with rights review…</button>
          <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'CHANGES_REQUESTED' })}>Request changes…</button></> : null}
        {working.state === 'APPROVED' && policy.viewer.publish && !wroteIt
          ? <button type="button" className="pilot-btn" onClick={() => setDialog({ kind: question.publishNeedsApproval ? 'publishWithApproval' : 'publish', revision: working })}>
            {question.publishNeedsApproval ? 'Request publish…' : 'Publish…'}</button> : null}
        {wroteIt && (working.state === 'IN_REVIEW' || working.state === 'APPROVED') ? <small>You wrote, edited or submitted this revision, so someone else reviews and publishes it.</small> : null}
      </div>
    </article> : null}

    <h3>History</h3>
    {question.history.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>When</th><th>Revision</th><th>Action</th><th>Move</th><th>Reason</th><th>By</th></tr></thead>
      <tbody>{question.history.map((entry, index) => <tr key={`${entry.occurredAt}-${index}`}>
        <td>{when(entry.occurredAt)}</td><td>{entry.revision}</td><td>{label(entry.action)}</td>
        <td>{label(entry.fromState)} → {label(entry.toState)}</td><td>{entry.reasonCode}</td><td>{entry.actorEmail}</td>
      </tr>)}</tbody></table></div> : <p>No review actions yet.</p>}

    {dialog?.kind === 'revise' ? <ReasonDialog title={`Start revision of ${question.stableKey}`} approvalNote="Not required: a new revision changes nothing until it is published."
      reasons={policy.reasons.revise} submitLabel="Start revision" onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await startBankQuestionRevision(token, question.questionId, { reasonCode })).question, 'Revision started.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'transition' ? <ReasonDialog title={transitionTitle(dialog.toState, dialog.revision.revision)}
      approvalNote={dialog.toState === 'APPROVED'
        ? `Not required to approve. Approving also records your rights review of the ${dialog.revision.fields.licenceLabel ?? 'NA'} licence the author declared, and approves the hints and misconception tags with the question.`
        : dialog.toState === 'IN_REVIEW' ? 'Not required: submitting records the hints and misconception tags for review with your reason.' : 'Not required: recorded with your reason.'}
      reasons={policy.reasons.transition[dialog.toState] ?? []}
      rightsReasons={dialog.toState === 'APPROVED' ? policy.reasons.rights : null}
      submitLabel={transitionTitle(dialog.toState, dialog.revision.revision)} withNote onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode, note, rightsReasonCode) => {
        apply((await transitionBankQuestionRevision(token, dialog.revision.id, {
          toState: dialog.toState, reasonCode, ...(rightsReasonCode ? { rightsReasonCode } : {}), ...(note ? { note } : {}),
        })).question, `Revision ${dialog.revision.revision}: ${label(dialog.toState)}.`);
        setDialog(null);
      }} /> : null}
    {dialog?.kind === 'publish' ? <ReasonDialog title={`Publish revision ${dialog.revision.revision} of ${question.stableKey}`}
      approvalNote="Not required for this question."
      reasons={policy.reasons.publish} submitLabel="Publish" onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await publishBankQuestionRevision(token, dialog.revision.id, { reasonCode })).question, 'Published.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'publishWithApproval' ? <RequestApprovalDialog token={token} actionKey="CONTENT_QUESTION_PUBLISH"
      payload={{ revisionId: dialog.revision.id }} reasons={policy.reasons.publish}
      title={`Publish revision ${dialog.revision.revision} of ${question.stableKey}`}
      details={[['Question', question.stableKey],
        ['Effect', question.status === 'LIVE'
          ? `Replaces version ${question.publishedVersion ?? 'NA'} in the readiness check; attempts already holding it keep it.`
          : 'Adds the question to the readiness check that students take.']]}
      onCancel={() => setDialog(null)} onFiled={(message) => { setDialog(null); setNotice(message); }} /> : null}
  </section>;
}

function transitionTitle(toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED', revision: number): string {
  switch (toState) {
    case 'IN_REVIEW': return `Submit revision ${revision} for review`;
    case 'CHANGES_REQUESTED': return `Request changes to revision ${revision}`;
    case 'APPROVED': return `Approve revision ${revision}`;
  }
}

function QuestionView({ revision, policy }: { readonly revision: BankQuestionRevisionDto; readonly policy: QuestionBankPolicyDto }): React.ReactElement {
  const fields = revision.fields;
  const tagFor = (optionId: string) => revision.tags.find((tag) => tag.optionId === optionId);
  return <div>
    {revision.answerKeyWithheld ? <p role="note">The answer key, explanation and misconception tags are withheld: they are shown only to staff with Content Edit or Content Review.</p> : null}
    <p>{fields.prompt || 'NA'}</p>
    <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Option</th><th>Text</th><th>Answer</th><th>Misconception</th></tr></thead>
      <tbody>{fields.options.length ? fields.options.map((option) => {
        const tag = tagFor(option.id);
        return <tr key={option.id}>
          <td>{option.id}</td><td>{option.text || 'NA'}</td>
          <td>{revision.answerKeyWithheld ? 'Withheld' : fields.correctOptionId === option.id ? 'Correct' : fields.correctOptionId ? 'Wrong' : 'NA'}</td>
          <td>{revision.answerKeyWithheld ? 'Withheld'
            : tag ? `${tag.code} v${tag.codeVersion} — ${tag.codeTitle} (${label(tag.tagState)}; code ${label(tag.codeState)})`
              : option.misconception ? `Chosen, recorded on submission — ${option.misconception.rationale}` : 'None'}</td>
        </tr>;
      }) : <tr><td colSpan={4}>No options yet</td></tr>}</tbody>
    </table></div>
    <dl>
      <div><dt>Explanation</dt><dd>{revision.answerKeyWithheld ? 'Withheld' : fields.explanation ?? 'NA'}</dd></div>
      <div><dt>Difficulty</dt><dd>{fields.difficulty ? label(fields.difficulty) : 'NA'}</dd></div>
      <div><dt>Skill</dt><dd>{revision.topic ? `${revision.topic.name} (${revision.topic.stableKey})` : 'NA'}</dd></div>
      <div><dt>Licence</dt><dd>{fields.licenceLabel ?? 'NA'}{fields.attribution ? ` — ${fields.attribution}` : ''}</dd></div>
      <div><dt>Basis</dt><dd>{fields.basis ?? 'NA'}</dd></div>
      <div><dt>Drafted by</dt><dd>{revision.agentDraft
        ? `The coding agent (${revision.agentDraft.generatorVersion}, ${revision.agentDraft.promptVersion}, ${when(revision.agentDraft.generatedAt)}) — check it against its basis`
        : 'A person'}</dd></div>
      {revision.expertCheck ? <div><dt>For the subject expert</dt><dd>{revision.expertCheck}</dd></div> : null}
      <div><dt>Rights review</dt><dd>{revision.rightsReview
        ? `${revision.rightsReview.licenceLabel} confirmed by ${revision.rightsReview.reviewerEmail} (${revision.rightsReview.reasonCode}) · ${when(revision.rightsReview.reviewedAt)}`
        : 'Not yet reviewed'}</dd></div>
    </dl>
    <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Hint ladder">
      <thead><tr><th>Hint</th><th>Text</th></tr></thead>
      <tbody>{policy.hintLevels.map((entry, index) => <tr key={entry.level}>
        <td>Level {entry.level} — {label(entry.name)}<br /><small>{entry.meaning}</small></td><td>{fields.hints[index] || 'NA'}</td>
      </tr>)}</tbody>
    </table></div>
    <p><small>Hint ladder record: {revision.ladder
      ? `${revision.ladder.source === 'AGENT_DRAFTED' ? `drafted by the coding agent (${revision.ladder.generatorVersion ?? 'NA'}, ${revision.ladder.promptVersion ?? 'NA'})` : 'written by a person'} · ${label(revision.ladder.state)}`
      : 'written on submission'}</small></p>
  </div>;
}

interface EditorOption { readonly id: string; readonly text: string; readonly codeId: string; readonly rationale: string }

function QuestionEditor({ token, revision, question, policy, onSaved }: {
  readonly token: string; readonly revision: BankQuestionRevisionDto; readonly question: BankQuestionDetailDto; readonly policy: QuestionBankPolicyDto;
  readonly onSaved: (question: BankQuestionDetailDto) => void;
}): React.ReactElement {
  const initialTopic = revision.topic ? revision.topic.stableKey : '';
  const [form, setForm] = useState(() => ({
    topicKey: initialTopic,
    prompt: revision.fields.prompt,
    options: (revision.fields.options.length ? revision.fields.options : policy.optionIds.slice(0, 2).map((id) => ({ id, text: '', misconception: null })))
      .map((option): EditorOption => ({ id: option.id, text: option.text, codeId: option.misconception ? option.misconception.codeId : '', rationale: option.misconception ? option.misconception.rationale : '' })),
    correctOptionId: revision.fields.correctOptionId ?? '',
    explanation: revision.fields.explanation ?? '',
    difficulty: revision.fields.difficulty ?? '',
    hints: [0, 1, 2, 3].map((index) => revision.fields.hints[index] ?? ''),
    licenceLabel: revision.fields.licenceLabel ?? '',
    attribution: revision.fields.attribution ?? '',
    basis: revision.fields.basis ?? '',
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const licence = policy.licences.find((entry) => entry.licence === form.licenceLabel);
  const topicChanged = form.topicKey !== initialTopic;
  const hintsDone = form.hints.filter((hint) => hint.trim()).length;
  const wrong = form.options.filter((option) => option.id !== form.correctOptionId);
  const tagged = wrong.filter((option) => option.codeId).length;

  const setOption = (index: number, change: Partial<EditorOption>): void => {
    setForm({ ...form, options: form.options.map((option, position) => (position === index ? { ...option, ...change } : option)) });
  };
  const setCount = (count: number): void => {
    const options = policy.optionIds.slice(0, count).map((id, index) => form.options[index] ?? { id, text: '', codeId: '', rationale: '' });
    setForm({ ...form, options, correctOptionId: options.some((option) => option.id === form.correctOptionId) ? form.correctOptionId : '' });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await saveBankQuestionDraft(token, revision.id, {
        topicKey: form.topicKey.trim(),
        prompt: form.prompt.trim(),
        options: form.options.map((option) => ({
          id: option.id, text: option.text.trim(),
          ...(option.codeId && option.id !== form.correctOptionId && !topicChanged ? { misconceptionCodeId: option.codeId, rationale: option.rationale.trim() } : {}),
        })),
        correctOptionId: form.correctOptionId || null,
        ...(form.explanation.trim() ? { explanation: form.explanation.trim() } : {}),
        difficulty: form.difficulty || null,
        hints: form.hints.map((hint) => hint.trim()),
        licenceLabel: form.licenceLabel || null,
        ...(form.attribution.trim() ? { attribution: form.attribution.trim() } : {}),
        ...(form.basis.trim() ? { basis: form.basis.trim() } : {}),
        reasonCode: policy.reasons.save[0] ?? 'DRAFT_EDIT',
      });
      onSaved(result.question);
    } catch (cause) {
      setError(formatApiError(cause, 'The draft could not be saved.'));
    } finally { setBusy(false); }
  };

  return <form aria-label={`Edit revision ${revision.revision}`} noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label><span>Skill key</span><input value={form.topicKey} maxLength={80} onChange={(event) => setForm({ ...form, topicKey: event.target.value.trim().toLowerCase() })} /></label>
    {topicChanged ? <p><small>Save to load the misconceptions of the new skill; tags on the old skill are dropped.</small></p> : null}
    <label><span>Prompt</span><textarea value={form.prompt} maxLength={policy.limits.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label>
    <label><span>Number of options</span>
      <select aria-label="Number of options" value={form.options.length} onChange={(event) => setCount(Number(event.target.value))}>
        {policy.optionIds.slice(policy.limits.optionsMin - 1).map((_, index) => <option key={index} value={index + policy.limits.optionsMin}>{index + policy.limits.optionsMin}</option>)}
      </select></label>
    {form.options.map((option, index) => <fieldset key={option.id}>
      <legend>Option {option.id}</legend>
      <label><span>Text</span><input aria-label={`Option ${option.id} text`} value={option.text} maxLength={policy.limits.optionText} onChange={(event) => setOption(index, { text: event.target.value })} /></label>
      <label><input type="radio" name={`correct-${revision.id}`} aria-label={`Option ${option.id} is correct`} checked={form.correctOptionId === option.id}
        onChange={() => setForm({ ...form, correctOptionId: option.id })} /> <span>This is the correct answer</span></label>
      {option.id !== form.correctOptionId ? <>
        <label><span>Misconception it signals (optional)</span>
          <select aria-label={`Option ${option.id} misconception`} value={option.codeId} disabled={topicChanged} onChange={(event) => setOption(index, { codeId: event.target.value })}>
            <option value="">None</option>
            {question.misconceptionChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.code} v{choice.version} — {choice.title}{choice.state === 'PUBLISHED' ? '' : ` (${label(choice.state).toLowerCase()})`}</option>)}
          </select></label>
        {option.codeId ? <label><span>Why choosing it shows that misconception</span>
          <input aria-label={`Option ${option.id} rationale`} value={option.rationale} maxLength={policy.limits.rationale} onChange={(event) => setOption(index, { rationale: event.target.value })} /></label> : null}
      </> : null}
    </fieldset>)}
    {!question.misconceptionChoices.length ? <p><small>No misconception codes exist for this skill yet, so distractors cannot be tagged.</small></p> : null}
    <label><span>Explanation of the answer</span><textarea value={form.explanation} maxLength={policy.limits.explanation} onChange={(event) => setForm({ ...form, explanation: event.target.value })} /></label>
    <label><span>Difficulty</span>
      <select aria-label="Difficulty" value={form.difficulty} onChange={(event) => setForm({ ...form, difficulty: event.target.value })}>
        <option value="">Choose a band…</option>
        {policy.difficulties.map((entry) => <option key={entry.difficulty} value={entry.difficulty}>{label(entry.difficulty)} — {entry.meaning}</option>)}
      </select></label>
    {policy.hintLevels.map((entry, index) => <label key={entry.level}><span>Hint {entry.level} — {label(entry.name)}: {entry.meaning}</span>
      <textarea aria-label={`Hint ${entry.level}`} value={form.hints[index] ?? ''} maxLength={policy.limits.hint}
        onChange={(event) => setForm({ ...form, hints: form.hints.map((hint, position) => (position === index ? event.target.value : hint)) })} /></label>)}
    <label><span>Licence of this text</span>
      <select aria-label="Licence" value={form.licenceLabel} onChange={(event) => setForm({ ...form, licenceLabel: event.target.value })}>
        <option value="">Choose a licence…</option>
        {policy.licences.map((entry) => <option key={entry.licence} value={entry.licence}>{entry.licence}</option>)}
      </select></label>
    {licence && licence.attributionRequired ? <label><span>Attribution (required by this licence)</span>
      <input value={form.attribution} maxLength={policy.limits.attribution} onChange={(event) => setForm({ ...form, attribution: event.target.value })} /></label> : null}
    <label><span>Basis — what this question rests on</span>
      <textarea value={form.basis} maxLength={policy.limits.basis} onChange={(event) => setForm({ ...form, basis: event.target.value })} /></label>
    <p><small>Ready for review needs every option written, the correct answer and its explanation, a difficulty, all four hints ({hintsDone} of 4 written) and a licence ({form.licenceLabel || 'none chosen'}). Wrong options tagged: {tagged} of {wrong.length}.</small></p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <button type="submit" disabled={busy || !form.prompt.trim() || !keyPattern.test(form.topicKey)}>{busy ? 'Saving…' : 'Save draft'}</button>
  </form>;
}

function CreateQuestionDialog({ token, policy, onCancel, onCreated }: {
  readonly token: string; readonly policy: QuestionBankPolicyDto; readonly onCancel: () => void; readonly onCreated: (question: BankQuestionDetailDto) => void;
}): React.ReactElement {
  const [form, setForm] = useState({ stableKey: '', topicKey: '', prompt: '', reasonCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keysValid = keyPattern.test(form.stableKey) && keyPattern.test(form.topicKey);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!form.reasonCode) { setError('Choose a reason code.'); return; }
    if (!keysValid) { setError('Keys are 3 to 80 lower-case letters, digits and hyphens.'); return; }
    setBusy(true);
    try {
      onCreated((await createBankQuestion(token, { ...form, prompt: form.prompt.trim() })).question);
    } catch (cause) {
      setError(formatApiError(cause, 'The question could not be created.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="question-create-title">
      <h2 id="question-create-title">New question</h2>
      <dl><div><dt>Approval</dt><dd>Not required: a new question is a draft that no student sees until it is reviewed, approved by a second person and published.</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Key <em>required, cannot change later</em></span><input value={form.stableKey} maxLength={80} placeholder="e.g. soc-alert-triage-q001" onChange={(event) => setForm({ ...form, stableKey: event.target.value.trim().toLowerCase() })} /></label>
        <label><span>Skill key</span><input value={form.topicKey} maxLength={80} placeholder="e.g. soc-alert-triage" onChange={(event) => setForm({ ...form, topicKey: event.target.value.trim().toLowerCase() })} /></label>
        <label><span>Prompt</span><textarea value={form.prompt} maxLength={policy.limits.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label>
        <label><span>Reason code <em>required</em></span>
          <select value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {policy.reasons.create.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !form.reasonCode || !keysValid || !form.prompt.trim()}>{busy ? 'Creating…' : 'Create draft'}</button>
        </div>
      </form>
    </section>
  </div>;
}

/** The confirm dialog for question writes: a reason code is required; approving also asks for the rights reason. */
function ReasonDialog({ title, approvalNote, reasons, rightsReasons = null, submitLabel, withNote = false, onCancel, onSubmit }: {
  readonly title: string; readonly approvalNote: string; readonly reasons: readonly string[]; readonly rightsReasons?: readonly string[] | null;
  readonly submitLabel: string; readonly withNote?: boolean;
  readonly onCancel: () => void; readonly onSubmit: (reasonCode: string, note: string | null, rightsReasonCode: string | null) => Promise<void>;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [rightsReasonCode, setRightsReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const ready = Boolean(reasonCode) && (!rightsReasons || Boolean(rightsReasonCode));
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) { setError(rightsReasons ? 'Choose a reason code and a rights reason.' : 'Choose a reason code.'); return; }
    setBusy(true);
    try {
      await onSubmit(reasonCode, note.trim() ? note.trim() : null, rightsReasons ? rightsReasonCode : null);
    } catch (cause) {
      setError(formatApiError(cause, 'The change could not be saved.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="question-dialog-title">
      <h2 id="question-dialog-title">{title}</h2>
      <dl><div><dt>Approval</dt><dd>{approvalNote}</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {rightsReasons ? <label><span>Rights reason <em>required</em> — you confirm the declared licence is right</span>
          <select aria-label="Rights reason" value={rightsReasonCode} onChange={(event) => setRightsReasonCode(event.target.value)} required>
            <option value="">Choose a rights reason…</option>
            {rightsReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label> : null}
        {withNote ? <label><span>Note (optional, 500 characters) — do not include personal data</span>
          <textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </form>
    </section>
  </div>;
}
