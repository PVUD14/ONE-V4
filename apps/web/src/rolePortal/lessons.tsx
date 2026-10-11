/**
 * ONE · Role portal — Operations Content Management: the lesson and variant editor (OPS-09c).
 *
 * Lives under the existing Content Management label (Appendix 1 §4.2), below the question bank;
 * no navigation item is added. Operators draft a lesson — its title, the text learners read, its
 * module, skill and prerequisites, and the rights its text is under — a different person reviews
 * it (approving is also the rights review), and a third person, who neither wrote nor approved it,
 * publishes it: the learner-content lifecycle's rule. A variant renders a published lesson in
 * another language, level or style and goes through the same review; it is never a separate lesson
 * for students to complete. A lesson's first publish, or a revision that changes its skill or
 * prerequisites, files an approval a second person grants (Settings → Approvals).
 *
 * The server decides everything: capabilities, reason codes, who wrote or approved a revision, and
 * whether a publish needs an approval. Levels and styles are words, never numbers. A missing value
 * hides its row, or reads in plain words where a column must stay.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  createEditorLesson,
  createEditorLessonVariant,
  getEditorLesson,
  getLessonEditorPolicy,
  getProtectedAccessToken,
  listEditorLessons,
  publishEditorLessonRevision,
  saveEditorLessonDraft,
  archiveEditorLesson,
  startEditorLessonRevision,
  transitionEditorLessonRevision,
} from '../api.js';
import type {
  LessonDetailDto,
  LessonEditorPolicyDto,
  LessonListDto,
  LessonRevisionDto,
  LessonRevisionState,
  LessonSummaryDto,
  LessonVariantDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { AiDraftProvenance, AiDraftsCard, TranslateWithAiDialog } from './contentFactory.js';
import { formatApiError } from './shared.js';
import { SupportCode } from '../supportCode.js';
import { formatDateTime } from '../dates.js';
import { MISSING_TEXT, codeLabel } from '../labels.js';

const label = (value: string): string => value.split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
const when = (value: string | null | undefined): string => (value ? formatDateTime(value) : MISSING_TEXT);
const statusText = (status: string): string => (status === 'LIVE' ? 'Live' : status === 'PENDING' ? 'Not yet published' : status === 'RETIRED' ? 'Retired' : status === 'ARCHIVED' ? 'Archived' : 'Unknown');
const statusTone = (status: string): 'success' | 'warning' | 'neutral' | 'info' => (status === 'LIVE' ? 'success' : status === 'PENDING' ? 'warning' : 'neutral');
const stateTone = (state: LessonRevisionState): 'success' | 'warning' | 'neutral' | 'info' =>
  state === 'PUBLISHED' ? 'success' : state === 'IN_REVIEW' || state === 'APPROVED' ? 'warning' : state === 'DRAFT' || state === 'CHANGES_REQUESTED' ? 'info' : 'neutral';
const filters = [
  { value: '', text: 'All lessons and variants' }, { value: 'LIVE', text: 'Live' }, { value: 'PENDING', text: 'Not yet published' },
  { value: 'AWAITING_REVIEW', text: 'Awaiting review' }, { value: 'CHANGES_REQUESTED', text: 'Changes requested' },
  { value: 'AWAITING_PUBLISH', text: 'Approved, awaiting publish' }, { value: 'VARIANTS', text: 'Variants only' }, { value: 'ARCHIVED', text: 'Archived' },
];
const keyPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

/**
 * ENG-16: a variant in a language other than English is marked for native-speaker review until it
 * is approved; approving it asks who checked the language.
 */
const needsNativeSpeakerReview = (kind: string, variant: LessonVariantDto, state: LessonRevisionState | null | undefined): boolean =>
  kind === 'VARIANT' && variant.language !== 'en' && (state === 'DRAFT' || state === 'IN_REVIEW' || state === 'CHANGES_REQUESTED');
const languageReviewText: Readonly<Record<string, string>> = {
  NATIVE_SPEAKER_REVIEWED: 'I read this language natively and checked it against the English',
  NATIVE_SPEAKER_CONSULTED: 'A native speaker reviewed it and I checked their review',
};

function languageName(policy: LessonEditorPolicyDto | null, code: string): string {
  const found = policy ? policy.languages.find((entry) => entry.language === code) : undefined;
  return found ? found.name : code;
}

function variantText(policy: LessonEditorPolicyDto | null, variant: LessonVariantDto): string {
  return `${languageName(policy, variant.language)} · ${label(variant.level)} · ${label(variant.style)}`;
}

export function OperationsLessonsPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [policy, setPolicy] = useState<LessonEditorPolicyDto | null>(null);
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [draftFilters, setDraftFilters] = useState({ q: '', filter: '' });
  const [applied, setApplied] = useState(draftFilters);
  const [list, setList] = useState<LessonListDto | null>(null);
  const [more, setMore] = useState<readonly LessonSummaryDto[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getLessonEditorPolicy(token, controller.signal)
      .then((result) => { setPolicy(result); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the lesson editor policy.'));
      });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token || forbiddenReference) return;
    const controller = new AbortController();
    setLoading(true);
    listEditorLessons(token, applied, null, controller.signal)
      .then((result) => { setList(result); setMore([]); setMoreCursor(null); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the lessons.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, applied, reload, forbiddenReference]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Content Management</span><h1>Lessons and variants</h1>
    <p>The lessons students read and complete, and their variants in another language, level or style. A lesson is drafted, reviewed by someone who did not write it (including its rights), and published by a third person who neither wrote nor approved it. A lesson going live for the first time, or a change to its skill or prerequisites, also needs a second person's approval, because completing it records evidence. A variant is never a separate lesson to complete.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState illustration="no-access" icon="🔐" title="Not permitted"
        note="The lesson editor is for staff who hold Content Edit, Content Review, Content Publish or Catalogue Manage. Your access has not changed; the rest of Content Management is unaffected."
        hint={<SupportCode reference={forbiddenReference} />} /></div></section>;
  }

  const lessons = [...(list ? list.lessons : []), ...more];
  const nextCursor = more.length ? moreCursor : list ? list.nextCursor : null;
  const summary = list ? list.summary : null;
  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await listEditorLessons(token, applied, nextCursor);
      setMoreCursor(page.nextCursor);
      setMore((current) => [...current, ...page.lessons]);
    } catch (cause) {
      setError(formatApiError(cause, 'Unable to load more lessons.'));
    }
  };

  return <section className="role-module role-module--dense" aria-label="Lessons and variants">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📚" tone="teal" value={summary ? summary.live : null} label="Live lessons" />
      <V2Stat icon="🌐" tone="purple" value={summary ? summary.liveVariants : null} label="Live variants" />
      <V2Stat icon="🔍" tone="amber" value={summary ? summary.awaitingReview : null} label="Awaiting review" />
      <V2Stat icon="🚀" tone="blue" value={summary ? summary.awaitingPublish : null} label="Approved, awaiting publish" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="role-card role-wide"><div className="role-section-title"><h2>Lessons</h2>
      {policy && policy.viewer.edit ? <button type="button" className="secondary" onClick={() => setCreating(true)}>New lesson…</button> : null}</div>
      <form className="role-actions" aria-label="Search lessons" onSubmit={(event) => { event.preventDefault(); setApplied(draftFilters); }}>
        <label className="role-local-search"><span>Search</span>
          <input value={draftFilters.q} maxLength={120} placeholder="Key or title" onChange={(event) => setDraftFilters({ ...draftFilters, q: event.target.value })} /></label>
        <label className="role-local-search"><span>Show</span>
          <select aria-label="Lesson filter" value={draftFilters.filter} onChange={(event) => setDraftFilters({ ...draftFilters, filter: event.target.value })}>
            {filters.map((entry) => <option key={entry.value} value={entry.value}>{entry.text}</option>)}
          </select></label>
        <button type="submit" className="pilot-btn">Search</button>
      </form>
      {loading && !list ? <p>Loading lessons…</p> : null}
      {!loading && list && !lessons.length ? <V2EmptyState illustration="search-no-results" icon="🔎" title="No lessons match" note="No lesson or variant matches this search. Lessons appear here once drafted in this editor or published by the readiness pilot." /> : null}
      {lessons.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Key</th><th>Title</th><th>Kind</th><th>Language, level, style</th><th>Status</th><th>Current revision</th><th>Revision on its way</th><th>Skill</th><th>Actions</th></tr></thead>
        <tbody>{lessons.map((lesson) => <tr key={lesson.lessonId}>
          <td><strong>{lesson.stableKey}</strong>{lesson.aiDrafted ? <><br /><StatusBadge label="AI draft" tone="warning" /></> : null}</td>
          <td>{lesson.title}</td>
          <td>{lesson.kind === 'VARIANT' ? 'Variant' : `Lesson${lesson.variantCount ? ` · ${lesson.variantCount} variant${lesson.variantCount === 1 ? '' : 's'}` : ''}`}</td>
          <td>{variantText(policy, lesson.variant)}</td>
          <td><StatusBadge label={statusText(lesson.status)} tone={statusTone(lesson.status)} /></td>
          <td>{lesson.publishedRevision ? `Revision ${lesson.publishedRevision}` : 'Not published'}</td>
          <td>{lesson.openRevision ? `Revision ${lesson.openRevision.revision} · ${label(lesson.openRevision.state)}` : 'None'}
            {needsNativeSpeakerReview(lesson.kind, lesson.variant, lesson.openRevision ? lesson.openRevision.state : null) ? <> <StatusBadge label="Needs native-speaker review" tone="warning" /></> : null}</td>
          <td>{lesson.kind === 'VARIANT' ? 'As its lesson' : lesson.topic ? lesson.topic.stableKey : 'Not set'}</td>
          <td><button type="button" className="secondary" aria-label={`Open ${lesson.stableKey}${lesson.kind === 'VARIANT' ? ` (${lesson.variant.language}/${lesson.variant.level}/${lesson.variant.style})` : ''}`}
            onClick={() => setSelectedId(lesson.lessonId)}>Open</button></td>
        </tr>)}</tbody></table></div> : null}
      {nextCursor ? <button type="button" className="secondary" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
    {policy ? <AiDraftsCard token={token} scope="LESSONS" vocabulary={policy} onOpenLesson={setSelectedId} reload={reload} /> : null}
    {selectedId && policy ? <LessonPanel token={token} lessonId={selectedId} policy={policy} onOpen={setSelectedId}
      onChanged={() => setReload((value) => value + 1)} onClose={() => setSelectedId('')} /> : null}
    {creating && policy ? <CreateLessonDialog token={token} policy={policy} onCancel={() => setCreating(false)}
      onCreated={(lesson) => { setCreating(false); setSelectedId(lesson.lessonId); setReload((value) => value + 1); }} /> : null}
  </section>;
}

type Dialog =
  | { readonly kind: 'revise' }
  | { readonly kind: 'archive' }
  | { readonly kind: 'variant' }
  | { readonly kind: 'aiVariant' }
  | { readonly kind: 'transition'; readonly revision: LessonRevisionDto; readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' }
  | { readonly kind: 'publish'; readonly revision: LessonRevisionDto }
  | { readonly kind: 'publishWithApproval'; readonly revision: LessonRevisionDto };

function LessonPanel({ token, lessonId, policy, onOpen, onChanged, onClose }: {
  readonly token: string; readonly lessonId: string; readonly policy: LessonEditorPolicyDto;
  readonly onOpen: (lessonId: string) => void; readonly onChanged: () => void; readonly onClose: () => void;
}): React.ReactElement {
  const [lesson, setLesson] = useState<LessonDetailDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLesson(null);
    setNotice('');
    getEditorLesson(token, lessonId, controller.signal)
      .then((result) => { setLesson(result.lesson); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this lesson.')); });
    return () => controller.abort();
  }, [token, lessonId]);

  const apply = (updated: LessonDetailDto, message = ''): void => { setLesson(updated); setError(''); setNotice(message); onChanged(); };

  if (!lesson) {
    return <section className="role-card role-wide" aria-label="Lesson"><h2>Lesson</h2>
      {error ? <p className="form-error" role="alert">{error}</p> : <p>Loading lesson…</p>}
      <button type="button" className="secondary" onClick={onClose}>Close</button></section>;
  }

  const isVariant = lesson.kind === 'VARIANT';
  const name = isVariant ? `${lesson.stableKey} (${variantText(policy, lesson.variant)})` : lesson.stableKey;
  const working = lesson.open;
  const viewerId = policy.viewer.userId;
  const wroteIt = working ? working.contributors.some((entry) => entry.userId === viewerId) : false;
  const approvedIt = working && working.approver ? working.approver.userId === viewerId : false;
  const editable = working && (working.state === 'DRAFT' || working.state === 'CHANGES_REQUESTED');
  const stale = isVariant && lesson.basedOnRevision !== null && lesson.baseRevision !== null && lesson.basedOnRevision < lesson.baseRevision;

  return <section className="role-card role-wide" aria-label={`Lesson ${name}`}>
    <div className="role-section-title"><h2>{name}</h2><button type="button" className="secondary" onClick={onClose}>Close lesson</button></div>
    <dl>
      <div><dt>Status</dt><dd><StatusBadge label={statusText(lesson.status)} tone={statusTone(lesson.status)} /></dd></div>
      <div><dt>Kind</dt><dd>{isVariant ? 'Variant — another rendering of a lesson, completed as that lesson' : 'Lesson — students complete it and it records evidence'}</dd></div>
      <div><dt>Language, level, style</dt><dd>{variantText(policy, lesson.variant)}</dd></div>
      {isVariant ? <div><dt>Renders</dt><dd>{lesson.base
        ? <>{lesson.base.title} ({lesson.base.stableKey}){lesson.basedOnRevision !== null && lesson.basedOnRevision !== undefined ? `, revision ${lesson.basedOnRevision}` : ''}{stale && lesson.baseRevision !== null && lesson.baseRevision !== undefined ? ` — the lesson is now at revision ${lesson.baseRevision}` : ''}{' '}
          <button type="button" className="secondary" onClick={() => onOpen(lesson.base!.lessonId)}>Open the lesson</button></>
        : MISSING_TEXT}</dd></div> : null}
      {!isVariant && lesson.topic ? <div><dt>Skill</dt><dd>{`${lesson.topic.name} (${lesson.topic.stableKey}) · ${statusText(lesson.topic.status)}`}</dd></div> : null}
      {!isVariant && lesson.moduleKey ? <div><dt>Module</dt><dd>{lesson.moduleKey}</dd></div> : null}
      {lesson.publishedRevision !== null && lesson.publishedRevision !== undefined ? <div><dt>Current revision</dt><dd>{lesson.publishedRevision}</dd></div> : null}
      <div><dt>{isVariant ? 'Published revisions' : 'Versions students have been given'}</dt><dd>{lesson.versions.length
        ? lesson.versions.map((entry) => `v${entry.version} ${entry.superseded ? '(replaced)' : '(current)'} · ${when(entry.publishedAt)}`).join('; ')
        : 'None yet'}</dd></div>
    </dl>
    {stale ? <p role="note">This variant renders an earlier revision of its lesson. Start a new revision to bring it up to date.</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    {!isVariant ? <>
      <h3>Variants</h3>
      {lesson.variants.length ? <div className="role-record-table-wrap"><table className="role-record-table" aria-label="Variants">
        <thead><tr><th>Language, level, style</th><th>Title</th><th>Status</th><th>Renders revision</th><th>Actions</th></tr></thead>
        <tbody>{lesson.variants.map((variant) => <tr key={variant.lessonId}>
          <td>{variantText(policy, variant.variant)}</td><td>{variant.title}</td>
          <td><StatusBadge label={statusText(variant.status)} tone={statusTone(variant.status)} /></td>
          <td>{variant.basedOnRevision ?? MISSING_TEXT}</td>
          <td><button type="button" className="secondary" onClick={() => onOpen(variant.lessonId)}>Open variant</button></td>
        </tr>)}</tbody></table></div> : <p>No variants yet.</p>}
      {lesson.status === 'LIVE' && policy.viewer.edit ? <>
        <button type="button" className="secondary" onClick={() => setDialog({ kind: 'variant' })}>New variant…</button>{' '}
        <button type="button" className="secondary" onClick={() => setDialog({ kind: 'aiVariant' })}>Draft a translation with AI…</button></>
        : lesson.status !== 'LIVE' ? <p><small>Variants can be made once this lesson is published.</small></p> : null}
    </> : null}

    {lesson.current ? <><h3>Published — revision {lesson.current.revision}</h3><LessonView revision={lesson.current} policy={policy} /></> : null}
    {!working && lesson.status === 'LIVE' && policy.viewer.edit
      ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'revise' })}>Start a new revision…</button> : null}
    {!working && lesson.status === 'LIVE' && policy.viewer.publish && policy.reasons.archive
      ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'archive' })}>Archive…</button> : null}

    {working ? <article className="role-card" aria-label={`Revision ${working.revision}`}>
      <div className="role-section-title"><h3>Revision {working.revision}</h3><StatusBadge label={label(working.state)} tone={stateTone(working.state)} />
        {needsNativeSpeakerReview(lesson.kind, lesson.variant, working.state) ? <StatusBadge label="Needs native-speaker review" tone="warning" /> : null}</div>
      {needsNativeSpeakerReview(lesson.kind, lesson.variant, working.state)
        ? <p><small>Students never see this {languageName(policy, lesson.variant.language)} text until someone who reads the language natively (or who checked a native speaker&apos;s review) approves it and it is published.</small></p> : null}
      {working.aiDraft ? <AiDraftProvenance aiDraft={working.aiDraft} author={working.author.email} /> : null}
      <p><small>Author {working.author.email} · started {when(working.createdAt)}{working.contributors.length > 1 ? ` · also written or submitted by ${working.contributors.filter((entry) => entry.userId !== working.author.userId).map((entry) => entry.email).join(', ')}` : ''}{working.approver ? ` · approved by ${working.approver.email}` : ''}</small></p>
      {editable && policy.viewer.edit
        ? <LessonEditor token={token} revision={working} isVariant={isVariant} policy={policy} onSaved={(updated) => apply(updated, 'Draft saved.')} />
        : <LessonView revision={working} policy={policy} />}
      <div className="role-actions">
        {editable && policy.viewer.edit ? <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'IN_REVIEW' })}>Submit for review…</button> : null}
        {working.state === 'IN_REVIEW' && policy.viewer.review && !wroteIt ? <>
          <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'APPROVED' })}>Approve, with rights review…</button>
          <button type="button" className="secondary" onClick={() => setDialog({ kind: 'transition', revision: working, toState: 'CHANGES_REQUESTED' })}>Request changes…</button></> : null}
        {working.state === 'APPROVED' && policy.viewer.publish && !wroteIt && !approvedIt
          ? <button type="button" className="pilot-btn" onClick={() => setDialog({ kind: lesson.publishNeedsApproval ? 'publishWithApproval' : 'publish', revision: working })}>
            {lesson.publishNeedsApproval ? 'Request publish…' : 'Publish…'}</button> : null}
        {wroteIt && (working.state === 'IN_REVIEW' || working.state === 'APPROVED') ? <small>You wrote, edited or submitted this revision, so someone else reviews and publishes it.</small> : null}
        {approvedIt && working.state === 'APPROVED' ? <small>You approved this revision, so someone else publishes it.</small> : null}
      </div>
    </article> : null}

    <h3>History</h3>
    {lesson.history.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>When</th><th>Revision</th><th>Action</th><th>Move</th><th>Reason</th><th>By</th></tr></thead>
      <tbody>{lesson.history.map((entry, index) => <tr key={`${entry.occurredAt}-${index}`}>
        <td>{when(entry.occurredAt)}</td><td>{entry.revision}</td><td>{label(entry.action)}</td>
        <td>{label(entry.fromState)} → {label(entry.toState)}</td><td>{codeLabel(entry.reasonCode)}</td><td>{entry.actorEmail}</td>
      </tr>)}</tbody></table></div> : <p>No review actions yet.</p>}

    {dialog?.kind === 'archive' ? <ReasonDialog title={`Archive ${name}`}
      approvalNote={isVariant
        ? 'Not required: archiving removes this variant, so no second person approves it, but it is recorded with your reason. It is never served again and never deleted; the lesson it renders is unchanged.'
        : 'Not required: archiving removes the lesson, so no second person approves it, but it is recorded with your reason. It leaves the catalogue at once; completions already recorded stay, and it is never deleted. It is refused while a variant of it is live or a live lesson needs it first.'}
      reasons={policy.reasons.archive ?? []} submitLabel={isVariant ? 'Archive variant' : 'Archive lesson'} onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await archiveEditorLesson(token, lesson.lessonId, { reasonCode })).lesson, 'Archived: no student is served it any more.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'revise' ? <ReasonDialog title={`Start revision of ${name}`} approvalNote="Not required: a new revision changes nothing until it is published."
      reasons={policy.reasons.revise} submitLabel="Start revision" onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await startEditorLessonRevision(token, lesson.lessonId, { reasonCode })).lesson, 'Revision started.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'aiVariant' ? <TranslateWithAiDialog token={token} lessonId={lesson.lessonId} lessonKey={lesson.stableKey} vocabulary={policy}
      current={{ level: lesson.variant.level, style: lesson.variant.style }} onCancel={() => setDialog(null)}
      onQueued={() => { setDialog(null); setNotice('Asked. The translation appears under AI drafts when the worker has written it.'); onChanged(); }} /> : null}
    {dialog?.kind === 'variant' ? <CreateVariantDialog token={token} policy={policy} lesson={lesson} onCancel={() => setDialog(null)}
      onCreated={(created) => { setDialog(null); onChanged(); onOpen(created.lessonId); }} /> : null}
    {dialog?.kind === 'transition' ? <ReasonDialog title={transitionTitle(dialog.toState, dialog.revision.revision)}
      approvalNote={dialog.toState === 'APPROVED'
        ? `Not required to approve. Approving also records your rights review of the ${dialog.revision.fields.licenceLabel ? `${dialog.revision.fields.licenceLabel} ` : ''}licence the author declared. You will not be able to publish what you approve.`
        : 'Not required: recorded with your reason.'}
      reasons={policy.reasons.transition[dialog.toState] ?? []}
      rightsReasons={dialog.toState === 'APPROVED' ? policy.reasons.rights : null}
      languageReviews={dialog.toState === 'APPROVED' && isVariant && lesson.variant.language !== 'en' ? policy.reasons.languageReview ?? [] : null}
      submitLabel={transitionTitle(dialog.toState, dialog.revision.revision)} withNote onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode, note, rightsReasonCode, languageReviewCode) => {
        apply((await transitionEditorLessonRevision(token, dialog.revision.id, {
          toState: dialog.toState, reasonCode, ...(rightsReasonCode ? { rightsReasonCode } : {}),
          ...(languageReviewCode ? { languageReviewCode } : {}), ...(note ? { note } : {}),
        })).lesson, `Revision ${dialog.revision.revision}: ${label(dialog.toState)}.`);
        setDialog(null);
      }} /> : null}
    {dialog?.kind === 'publish' ? <ReasonDialog title={`Publish revision ${dialog.revision.revision} of ${name}`}
      approvalNote={isVariant ? 'Not required: a variant renders its lesson and changes no evidence.' : 'Not required: this revision changes the wording only, not the skill or prerequisites.'}
      reasons={policy.reasons.publish} submitLabel="Publish" onCancel={() => setDialog(null)}
      onSubmit={async (reasonCode) => { apply((await publishEditorLessonRevision(token, dialog.revision.id, { reasonCode })).lesson, 'Published.'); setDialog(null); }} /> : null}
    {dialog?.kind === 'publishWithApproval' ? <RequestApprovalDialog token={token} actionKey="CONTENT_LESSON_PUBLISH"
      payload={{ revisionId: dialog.revision.id }} reasons={policy.reasons.publish}
      title={`Publish revision ${dialog.revision.revision} of ${name}`}
      details={[['Lesson', name],
        ['Effect', lesson.status === 'LIVE'
          ? `Replaces ${lesson.publishedRevision ? `revision ${lesson.publishedRevision}` : 'the published revision'} for students and changes what completing it records (its skill or prerequisites).`
          : 'Adds the lesson to the module students complete; completing it records evidence.']]}
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

function LessonView({ revision, policy }: { readonly revision: LessonRevisionDto; readonly policy: LessonEditorPolicyDto }): React.ReactElement {
  const fields = revision.fields;
  const isVariant = revision.identity.variantOf !== null;
  return <div>
    {fields.title ? <h4>{fields.title}</h4> : null}
    {fields.summary ? <p>{fields.summary}</p> : null}
    <dl>
      {fields.practice ? <div><dt>Practice</dt><dd>{fields.practice}</dd></div> : null}
      <div><dt>Language, level, style</dt><dd>{variantText(policy, revision.identity.variant)}</dd></div>
      {!isVariant && fields.moduleKey ? <div><dt>Module</dt><dd>{fields.moduleKey}</dd></div> : null}
      {!isVariant && revision.topic ? <div><dt>Skill</dt><dd>{`${revision.topic.name} (${revision.topic.stableKey})`}</dd></div> : null}
      {!isVariant ? <div><dt>Prerequisites</dt><dd>{fields.prerequisites.length ? fields.prerequisites.join(', ') : 'None'}</dd></div> : null}
      {isVariant && revision.identity.basedOnRevision !== null && revision.identity.basedOnRevision !== undefined ? <div><dt>Renders revision</dt><dd>{revision.identity.basedOnRevision}</dd></div> : null}
      {fields.licenceLabel || fields.attribution ? <div><dt>Licence</dt><dd>{fields.licenceLabel ?? MISSING_TEXT}{fields.attribution ? ` — ${fields.attribution}` : ''}</dd></div> : null}
      {fields.basis ? <div><dt>Basis</dt><dd>{fields.basis}</dd></div> : null}
      <div><dt>Drafted by</dt><dd>{revision.agentDraft
        ? `The coding agent (${revision.agentDraft.generatorVersion}, ${revision.agentDraft.promptVersion}, ${when(revision.agentDraft.generatedAt)}) — check it against its basis`
        : revision.aiDraft
          ? `ONE's AI (${revision.aiDraft.model}, ${revision.aiDraft.promptVersion}, ${when(revision.aiDraft.generatedAt)}) at the request of ${revision.author.email} — AI draft`
          : 'A person'}</dd></div>
      {revision.expertCheck ? <div><dt>For the subject expert</dt><dd>{revision.expertCheck}</dd></div> : null}
      <div><dt>Rights review</dt><dd>{revision.rightsReview
        ? `${revision.rightsReview.licenceLabel} confirmed by ${revision.rightsReview.reviewerEmail} (${revision.rightsReview.reasonCode}) · ${when(revision.rightsReview.reviewedAt)}`
        : 'Not yet reviewed'}</dd></div>
    </dl>
  </div>;
}

function LessonEditor({ token, revision, isVariant, policy, onSaved }: {
  readonly token: string; readonly revision: LessonRevisionDto; readonly isVariant: boolean; readonly policy: LessonEditorPolicyDto;
  readonly onSaved: (lesson: LessonDetailDto) => void;
}): React.ReactElement {
  const [form, setForm] = useState(() => ({
    title: revision.fields.title,
    summary: revision.fields.summary,
    practice: revision.fields.practice ?? '',
    moduleKey: revision.fields.moduleKey ?? '',
    topicKey: revision.topic ? revision.topic.stableKey : '',
    prerequisites: revision.fields.prerequisites.join(', '),
    licenceLabel: revision.fields.licenceLabel ?? '',
    attribution: revision.fields.attribution ?? '',
    basis: revision.fields.basis ?? '',
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const licence = policy.licences.find((entry) => entry.licence === form.licenceLabel);
  const prerequisites = form.prerequisites.split(',').map((key) => key.trim().toLowerCase()).filter(Boolean);
  const keysValid = isVariant || ((!form.topicKey || keyPattern.test(form.topicKey)) && prerequisites.every((key) => keyPattern.test(key)));

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await saveEditorLessonDraft(token, revision.id, {
        title: form.title.trim(),
        summary: form.summary.trim(),
        ...(form.practice.trim() ? { practice: form.practice.trim() } : {}),
        ...(!isVariant && form.moduleKey ? { moduleKey: form.moduleKey } : {}),
        ...(!isVariant && form.topicKey ? { topicKey: form.topicKey } : {}),
        ...(!isVariant ? { prerequisites } : {}),
        licenceLabel: form.licenceLabel || null,
        ...(form.attribution.trim() ? { attribution: form.attribution.trim() } : {}),
        ...(form.basis.trim() ? { basis: form.basis.trim() } : {}),
        reasonCode: policy.reasons.save[0] ?? 'DRAFT_EDIT',
      });
      onSaved(result.lesson);
    } catch (cause) {
      setError(formatApiError(cause, 'The draft could not be saved.'));
    } finally { setBusy(false); }
  };

  return <form aria-label={`Edit revision ${revision.revision}`} noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <label><span>Title</span><input value={form.title} maxLength={policy.limits.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
    <label><span>Summary — what learners read</span><textarea value={form.summary} maxLength={policy.limits.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
    <label><span>Practice prompt (optional)</span><textarea value={form.practice} maxLength={policy.limits.practice} onChange={(event) => setForm({ ...form, practice: event.target.value })} /></label>
    {isVariant ? <p><small>The module, skill and prerequisites are the lesson's own; a variant only renders its text.</small></p> : <>
      <label><span>Module</span>
        <select aria-label="Module" value={form.moduleKey} onChange={(event) => setForm({ ...form, moduleKey: event.target.value })}>
          <option value="">Choose a module…</option>
          {policy.modules.map((entry) => <option key={entry.stableKey} value={entry.stableKey}>{entry.title} ({entry.stableKey})</option>)}
        </select></label>
      {!policy.modules.length ? <p><small>No module is published yet, so this lesson cannot be submitted.</small></p> : null}
      <label><span>Skill key</span><input value={form.topicKey} maxLength={80} onChange={(event) => setForm({ ...form, topicKey: event.target.value.trim().toLowerCase() })} /></label>
      <label><span>Prerequisite lesson keys, separated by commas</span><input value={form.prerequisites} onChange={(event) => setForm({ ...form, prerequisites: event.target.value })} /></label>
    </>}
    <label><span>Licence of this text</span>
      <select aria-label="Licence" value={form.licenceLabel} onChange={(event) => setForm({ ...form, licenceLabel: event.target.value })}>
        <option value="">Choose a licence…</option>
        {policy.licences.map((entry) => <option key={entry.licence} value={entry.licence}>{entry.licence}</option>)}
      </select></label>
    {licence && licence.attributionRequired ? <label><span>Attribution (required by this licence)</span>
      <input value={form.attribution} maxLength={policy.limits.attribution} onChange={(event) => setForm({ ...form, attribution: event.target.value })} /></label> : null}
    <label><span>Basis — what this lesson rests on</span>
      <textarea value={form.basis} maxLength={policy.limits.basis} onChange={(event) => setForm({ ...form, basis: event.target.value })} /></label>
    <p><small>Ready for review needs a summary and a licence ({form.licenceLabel || 'none chosen'}){isVariant ? '' : ', a module and a skill'}.</small></p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <button type="submit" disabled={busy || !form.title.trim() || !keysValid}>{busy ? 'Saving…' : 'Save draft'}</button>
  </form>;
}

function CreateLessonDialog({ token, policy, onCancel, onCreated }: {
  readonly token: string; readonly policy: LessonEditorPolicyDto; readonly onCancel: () => void; readonly onCreated: (lesson: LessonDetailDto) => void;
}): React.ReactElement {
  const [form, setForm] = useState({ stableKey: '', title: '', level: 'STANDARD', style: 'EXPLANATION', reasonCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const keyValid = keyPattern.test(form.stableKey);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!form.reasonCode) { setError('Choose a reason code.'); return; }
    if (!keyValid) { setError('A key is 3 to 80 lower-case letters, digits and hyphens.'); return; }
    setBusy(true);
    try {
      onCreated((await createEditorLesson(token, { ...form, title: form.title.trim() })).lesson);
    } catch (cause) {
      setError(formatApiError(cause, 'The lesson could not be created.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="lesson-create-title">
      <h2 id="lesson-create-title">New lesson</h2>
      <dl><div><dt>Approval</dt><dd>Not required: a new lesson is a draft that no student sees until it is reviewed, approved by a second person and published.</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Key <em>required, cannot change later</em></span><input value={form.stableKey} maxLength={80} placeholder="e.g. soc-reading-an-alert" onChange={(event) => setForm({ ...form, stableKey: event.target.value.trim().toLowerCase() })} /></label>
        <label><span>Title</span><input value={form.title} maxLength={policy.limits.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
        <p><small>A lesson is written in English; other languages are its variants.</small></p>
        <label><span>Level</span><select aria-label="Level" value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>
          {policy.levels.map((entry) => <option key={entry.level} value={entry.level}>{label(entry.level)} — {entry.meaning}</option>)}</select></label>
        <label><span>Style</span><select aria-label="Style" value={form.style} onChange={(event) => setForm({ ...form, style: event.target.value })}>
          {policy.styles.map((entry) => <option key={entry.style} value={entry.style}>{label(entry.style)} — {entry.meaning}</option>)}</select></label>
        <label><span>Reason code <em>required</em></span>
          <select value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {policy.reasons.create.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !form.reasonCode || !keyValid || !form.title.trim()}>{busy ? 'Creating…' : 'Create draft'}</button>
        </div>
      </form>
    </section>
  </div>;
}

function CreateVariantDialog({ token, policy, lesson, onCancel, onCreated }: {
  readonly token: string; readonly policy: LessonEditorPolicyDto; readonly lesson: LessonDetailDto;
  readonly onCancel: () => void; readonly onCreated: (lesson: LessonDetailDto) => void;
}): React.ReactElement {
  const [form, setForm] = useState({ language: '', level: lesson.variant.level, style: lesson.variant.style, title: '', reasonCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = Boolean(form.language && form.reasonCode && form.title.trim());
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) { setError('Choose a language and a reason code, and give the variant a title.'); return; }
    setBusy(true);
    try {
      onCreated((await createEditorLessonVariant(token, lesson.lessonId, { ...form, title: form.title.trim() })).lesson);
    } catch (cause) {
      setError(formatApiError(cause, 'The variant could not be created.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="lesson-variant-title">
      <h2 id="lesson-variant-title">New variant of {lesson.stableKey}</h2>
      <dl><div><dt>Approval</dt><dd>Not required: a variant is a draft that no student sees until it is reviewed and published. It renders this lesson and is completed as this lesson.</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Language <em>required</em></span><select aria-label="Language" value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}>
          <option value="">Choose a language…</option>
          {policy.languages.map((entry) => <option key={entry.language} value={entry.language}>{entry.name} ({entry.language})</option>)}</select></label>
        <label><span>Level</span><select aria-label="Level" value={form.level} onChange={(event) => setForm({ ...form, level: event.target.value })}>
          {policy.levels.map((entry) => <option key={entry.level} value={entry.level}>{label(entry.level)} — {entry.meaning}</option>)}</select></label>
        <label><span>Style</span><select aria-label="Style" value={form.style} onChange={(event) => setForm({ ...form, style: event.target.value })}>
          {policy.styles.map((entry) => <option key={entry.style} value={entry.style}>{label(entry.style)} — {entry.meaning}</option>)}</select></label>
        <label><span>Title of the variant</span><input value={form.title} maxLength={policy.limits.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
        <label><span>Reason code <em>required</em></span>
          <select value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {policy.reasons.createVariant.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Creating…' : 'Create variant'}</button>
        </div>
      </form>
    </section>
  </div>;
}

/**
 * The confirm dialog for lesson writes: a reason code is required; approving also asks for the rights
 * reason, and approving a non-English variant for who checked its language (ENG-16).
 */
function ReasonDialog({ title, approvalNote, reasons, rightsReasons = null, languageReviews = null, submitLabel, withNote = false, onCancel, onSubmit }: {
  readonly title: string; readonly approvalNote: string; readonly reasons: readonly string[]; readonly rightsReasons?: readonly string[] | null;
  readonly languageReviews?: readonly string[] | null;
  readonly submitLabel: string; readonly withNote?: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (reasonCode: string, note: string | null, rightsReasonCode: string | null, languageReviewCode: string | null) => Promise<void>;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [rightsReasonCode, setRightsReasonCode] = useState('');
  const [languageReviewCode, setLanguageReviewCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const ready = Boolean(reasonCode) && (!rightsReasons || Boolean(rightsReasonCode)) && (!languageReviews || Boolean(languageReviewCode));
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) {
      setError(languageReviews ? 'Choose a reason code, a rights reason and who checked the language.' : rightsReasons ? 'Choose a reason code and a rights reason.' : 'Choose a reason code.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(reasonCode, note.trim() ? note.trim() : null, rightsReasons ? rightsReasonCode : null, languageReviews ? languageReviewCode : null);
    } catch (cause) {
      setError(formatApiError(cause, 'The change could not be saved.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="lesson-dialog-title">
      <h2 id="lesson-dialog-title">{title}</h2>
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
        {languageReviews ? <label><span>Native-speaker review <em>required</em> — who checked the language</span>
          <select aria-label="Native-speaker review" value={languageReviewCode} onChange={(event) => setLanguageReviewCode(event.target.value)} required>
            <option value="">Choose who checked it…</option>
            {languageReviews.map((code) => <option key={code} value={code}>{languageReviewText[code] ?? code}</option>)}
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
