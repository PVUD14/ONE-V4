/**
 * "Ask ONE to explain" review by exception (ADR-052), a section of the existing Content Management page.
 *
 * Why it exists: under Divakar's scoped waiver these AI lessons reach students without a person reading them
 * first, so operations reviews the exceptions: the lessons students flagged (reports first) and the most read.
 * A reviewer (CONTENT_REVIEW) can withdraw a lesson — hidden from every student at once; an editor
 * (CONTENT_EDIT) can promote one to an official draft, which then goes through the lesson editor's normal
 * review and publish. Rows show the topic, the text, the provenance and the reports — never who asked or who
 * reported. No navigation item: it lives under the existing Content Management label.
 *
 * Design: docs/architecture/ask-to-explain-design.md (Decision 6). Momentum re-skin: states use <StatusTag>, and a
 * value the API did not send is left out (never a placeholder).
 */
import { useEffect, useState } from 'react';
import { getProtectedAccessToken } from '../api.js';
import {
  listExplainLessonsForReview,
  promoteExplainLesson,
  withdrawExplainLesson,
  type ExplainReviewListDto,
  type ExplainReviewRowDto,
  type ExplainReviewView,
} from '../api/explain.js';
import { ApiRequestError } from '../api/core.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { StatusTag } from '../momentum/statusTag.js';
import { formatApiError } from './shared.js';

const VIEWS: readonly { readonly key: ExplainReviewView; readonly label: string }[] = [
  { key: 'flagged', label: 'Flagged by students' }, { key: 'most-viewed', label: 'Most viewed' }, { key: 'withdrawn', label: 'Withdrawn' }, { key: 'promoted', label: 'Promoted' },
];
const LEVELS = ['FOUNDATION', 'STANDARD', 'ADVANCED'] as const;
const STYLES = ['EXPLANATION', 'WORKED_EXAMPLE', 'STEP_BY_STEP', 'SUMMARY'] as const;
const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : '');
const REVIEW_TONE = { WITHDRAWN: 'danger', FLAGGED: 'warn', PROMOTED: 'ok' } as const;
const slug = (topic: string): string => `explain-${topic.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60)}` || 'explain-lesson';

export function OperationsExplainLessonsPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  if (!token) return null;
  return <ExplainLessonsPanel token={token} />;
}

export function ExplainLessonsPanel({ token }: { readonly token: string }): React.ReactElement | null {
  const [view, setView] = useState<ExplainReviewView>('flagged');
  const [list, setList] = useState<ExplainReviewListDto | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [withdrawReason, setWithdrawReason] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    const controller = new AbortController();
    setList(null);
    listExplainLessonsForReview(token, view, controller.signal)
      .then((loaded) => { if (!Array.isArray(loaded?.lessons) || !loaded.viewer || !loaded.reasons) throw new Error('unexpected explain lessons response'); setList(loaded); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        // Not a content person: this section is simply not theirs.
        if (cause instanceof ApiRequestError && cause.status === 403) { setHidden(true); return; }
        setError(formatApiError(cause, 'Unable to load Ask ONE to explain lessons.'));
      });
    return () => controller.abort();
  }, [token, view, reload]);

  if (hidden) return null;

  async function withdraw(lesson: ExplainReviewRowDto): Promise<void> {
    const reasonCode = withdrawReason[lesson.id] ?? '';
    if (!reasonCode) { setError('Choose why the lesson is withdrawn.'); return; }
    try {
      await withdrawExplainLesson(token, lesson.id, reasonCode);
      setNotice(`Withdrawn: “${lesson.topic}” is no longer shown to any student.`);
      setError('');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The lesson could not be withdrawn.'));
    }
  }

  async function promote(lesson: ExplainReviewRowDto, form: { stableKey: string; title: string; level: string; style: string }): Promise<void> {
    try {
      await promoteExplainLesson(token, lesson.id, { reasonCode: list?.reasons.promote[0] ?? 'WORTH_OFFICIAL_LESSON', ...form });
      setNotice(`Promoted: “${form.title}” is now a draft in Lessons, for the normal review and publish.`);
      setError('');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The lesson could not be promoted.'));
    }
  }

  const counts = list?.counts;
  return <section className="role-card role-wide" aria-label="Ask ONE to explain lessons"><h2>Ask ONE to explain — review by exception</h2>
    <p>Students read these AI lessons without a person checking them first (ADR-052). Review the ones students flagged and the most read; withdraw a lesson to hide it from every student at once, or promote it to an official draft. Rows never show who asked or who reported.</p>
    {counts ? <p><small>Ready {counts.ready.toLocaleString()} · flagged {counts.flagged.toLocaleString()} · withdrawn {counts.withdrawn.toLocaleString()} · promoted {counts.promoted.toLocaleString()} · blocked by the checks {counts.blocked.toLocaleString()} · refused {counts.refused.toLocaleString()}</small></p> : null}
    <div className="role-actions" role="group" aria-label="Ask ONE to explain list">
      {VIEWS.map((entry) => <button key={entry.key} type="button" className={view === entry.key ? 'pilot-btn' : 'secondary'} aria-pressed={view === entry.key} onClick={() => setView(entry.key)}>{entry.label}</button>)}
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {list === null && !error ? <p>Loading lessons…</p> : null}
    {list && !list.lessons.length ? <V2EmptyState icon="💡" title="No lessons here" note="Ask ONE to explain is off by default. Lessons appear here once students ask for them and flag or read them." /> : null}
    {list && list.lessons.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Topic</th><th>Lesson</th><th>Students</th><th>Provenance</th><th>Action</th></tr></thead>
      <tbody>{list.lessons.map((lesson) => <tr key={lesson.id}>
        <td><strong>{lesson.topic}</strong><br /><StatusTag state={lesson.reviewState} tone={(REVIEW_TONE as Record<string, 'danger' | 'warn' | 'ok'>)[lesson.reviewState] ?? 'mute'} /></td>
        <td>{lesson.text ? <details><summary>Read the lesson</summary><p style={{ whiteSpace: 'pre-wrap' }}>{lesson.text}</p></details> : <small>The lesson text is not kept.</small>}</td>
        <td>Asked {lesson.requests} · reports {lesson.reports}
          {Object.keys(lesson.reportReasons).length ? <><br /><small>{Object.entries(lesson.reportReasons).map(([code, count]) => `${code} ${count}`).join(', ')}</small></> : null}
          {lesson.reportNotes.map((note, index) => <p key={index}><small>“{note}”</small></p>)}</td>
        <td><small>{[lesson.promptVersion, lesson.servedModel ?? lesson.model, lesson.guardVersion, when(lesson.generatedAt)].filter(Boolean).join(' · ')}</small></td>
        <td>{lesson.reviewState === 'WITHDRAWN' ? <small>Withdrawn {when(lesson.reviewedAt)}{lesson.reviewReasonCode ? ` (${lesson.reviewReasonCode})` : ''}</small> : <>
          {list.viewer.canWithdraw ? <div className="role-actions">
            <select aria-label={`Why withdraw ${lesson.topic}`} value={withdrawReason[lesson.id] ?? ''} onChange={(event) => setWithdrawReason((current) => ({ ...current, [lesson.id]: event.target.value }))}>
              <option value="">Reason…</option>
              {list.reasons.withdraw.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
            <button type="button" className="secondary" onClick={() => { void withdraw(lesson); }}>Withdraw</button>
          </div> : null}
          {list.viewer.canPromote && lesson.reviewState !== 'PROMOTED' ? <PromoteForm lesson={lesson} onPromote={(form) => promote(lesson, form)} /> : null}
          {lesson.reviewState === 'PROMOTED' ? <small>Promoted to an official draft {when(lesson.reviewedAt)}</small> : null}
          {!list.viewer.canWithdraw && !list.viewer.canPromote ? <small>View only</small> : null}
        </>}</td>
      </tr>)}</tbody>
    </table></div> : null}
  </section>;
}

function PromoteForm({ lesson, onPromote }: { readonly lesson: ExplainReviewRowDto; readonly onPromote: (form: { stableKey: string; title: string; level: string; style: string }) => Promise<void> }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [stableKey, setStableKey] = useState(slug(lesson.topic));
  const [title, setTitle] = useState(lesson.topic.charAt(0).toUpperCase() + lesson.topic.slice(1));
  const [level, setLevel] = useState<string>('STANDARD');
  const [style, setStyle] = useState<string>('EXPLANATION');
  if (!open) return <button type="button" className="secondary" onClick={() => setOpen(true)}>Promote to official draft…</button>;
  return <div aria-label={`Promote ${lesson.topic}`}>
    <label>Lesson key <input aria-label="Lesson key" value={stableKey} onChange={(event) => setStableKey(event.target.value)} /></label>
    <label>Title <input aria-label="Lesson title" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Level <select aria-label="Lesson level" value={level} onChange={(event) => setLevel(event.target.value)}>{LEVELS.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></label>
    <label>Style <select aria-label="Lesson style" value={style} onChange={(event) => setStyle(event.target.value)}>{STYLES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></label>
    <div className="role-actions"><button type="button" className="pilot-btn" onClick={() => { void onPromote({ stableKey, title, level, style }); }}>Create draft</button>
      <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button></div>
  </div>;
}
