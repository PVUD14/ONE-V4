/**
 * Tutor hints panel on AI Operations (ENG-22, Decision 8): the staff audit of what the AI tutor wrote.
 *
 * Why it exists: a tutor hint is shown to a student live, after ONE's code guard, while it is still DRAFT;
 * the human check happens here, afterwards. Staff see a daily random sample of DRAFT hints, every hint the
 * guard refused (with what it found) and recent verdicts, and mark a sampled hint reviewed-and-fine
 * (PUBLISHED) or should-not-have-been-shown (REJECTED) with a reason. Rows show the question and the hint —
 * never the student. A section of the existing AI Operations page; no navigation change.
 *
 * Design: docs/architecture/tutor-hints-table-design.md
 */
import { useEffect, useState } from 'react';
import { listTutorHintsForReview, reviewTutorHint, type TutorHintReviewDto, type TutorHintReviewListDto, type TutorHintReviewView } from '../api/aiOperations.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';

const VIEWS: readonly { readonly key: TutorHintReviewView; readonly label: string }[] = [
  { key: 'sample', label: 'Today’s sample' }, { key: 'refused', label: 'Refused by the guard' }, { key: 'reviewed', label: 'Reviewed' },
];
const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');

function outcome(hint: TutorHintReviewDto): string {
  if (hint.status === 'SHOWN') return 'Shown to the student';
  if (hint.fallbackReason === 'GUARD_REFUSED') return 'Refused — written hint shown';
  return `Not shown (${hint.fallbackReason ?? 'NA'}) — written hint shown`;
}

export function TutorHintsPanel({ token }: { readonly token: string }): React.ReactElement {
  const [view, setView] = useState<TutorHintReviewView>('sample');
  const [list, setList] = useState<TutorHintReviewListDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [reload, setReload] = useState(0);
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    const controller = new AbortController();
    setList(null);
    setUnavailable(false);
    listTutorHintsForReview(token, view, controller.signal)
      // A response without the list is shown as NA, never guessed at.
      .then((loaded) => { if (!Array.isArray(loaded?.hints) || !loaded.counts || !loaded.reasons) throw new Error('unexpected tutor hints response'); setList(loaded); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof Error && cause.message === 'unexpected tutor hints response') setUnavailable(true);
        else setError(formatApiError(cause, 'Unable to load tutor hints.'));
      });
    return () => controller.abort();
  }, [token, view, reload]);

  async function decide(hint: TutorHintReviewDto, verdict: 'APPROVE' | 'REJECT'): Promise<void> {
    const reasonCode = verdict === 'APPROVE' ? (list?.reasons.approve[0] ?? '') : (reasons[hint.id] ?? '');
    if (!reasonCode) { setError('Choose why the hint should not have been shown.'); return; }
    try {
      await reviewTutorHint(token, hint.id, { verdict, reasonCode });
      setNotice(verdict === 'APPROVE' ? 'Marked reviewed and fine.' : 'Marked as should not have been shown.');
      setError('');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The verdict could not be recorded.'));
    }
  }

  const counts = list?.counts;
  return <section className="role-card role-wide" aria-label="Tutor hints"><h2>Tutor hints</h2>
    <p>The AI tutor’s hints are shown to students after ONE’s code checks, while still a draft; this is where a person reviews them. Each row shows the question and the hint, never the student.</p>
    <p><small>Last 7 days: {counts ? counts.shown7d.toLocaleString() : 'NA'} shown · {counts ? counts.fallback7d.toLocaleString() : 'NA'} replaced by the written hint · reviewed fine {counts ? counts.published.toLocaleString() : 'NA'} · should not have been shown {counts ? counts.rejected.toLocaleString() : 'NA'}</small></p>
    <div className="role-actions" role="group" aria-label="Tutor hint list">
      {VIEWS.map((entry) => <button key={entry.key} type="button" className={view === entry.key ? 'pilot-btn' : 'secondary'} aria-pressed={view === entry.key} onClick={() => setView(entry.key)}>{entry.label}</button>)}
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {unavailable ? <p>NA — tutor hints could not be read right now.</p> : null}
    {list === null && !error && !unavailable ? <p>Loading tutor hints…</p> : null}
    {list && !list.hints.length ? <V2EmptyState icon="🧑‍🏫" title="No tutor hints here" note="The AI tutor is off by default and runs only in the demo sandbox. Hints appear here once students there ask for them." /> : null}
    {list && list.hints.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Question</th><th>Hint</th><th>Outcome</th><th>Provenance</th><th>Review</th></tr></thead>
      <tbody>{list.hints.map((hint) => <tr key={hint.id}>
        <td>{hint.questionPrompt}<br /><small>Level {hint.level} · {hint.language} · {when(hint.requestedAt)}</small></td>
        <td>{hint.generatedText ?? 'NA'}</td>
        <td>{outcome(hint)}{hint.guardFindings.length ? <><br /><small>Found: {hint.guardFindings.join(', ')}</small></> : null}</td>
        <td><small>{hint.model ?? 'NA'} · {hint.promptVersion} · {hint.guardVersion ?? 'no guard run'}</small></td>
        <td>{hint.reviewState === 'DRAFT'
          ? (list.viewer.canReview && hint.generatedText ? <div className="role-actions">
            <button type="button" className="secondary" onClick={() => void decide(hint, 'APPROVE')}>Reviewed — fine</button>
            <select aria-label={`Why hint ${hint.level} should not have been shown`} value={reasons[hint.id] ?? ''} onChange={(event) => setReasons({ ...reasons, [hint.id]: event.target.value })}>
              <option value="">Reason…</option>
              {list.reasons.reject.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
            </select>
            <button type="button" className="pilot-btn" onClick={() => void decide(hint, 'REJECT')}>Should not have been shown</button>
          </div> : <StatusBadge label="Draft" tone="neutral" />)
          : <StatusBadge label={hint.reviewState === 'PUBLISHED' ? 'Reviewed — fine' : 'Should not have been shown'} tone={hint.reviewState === 'PUBLISHED' ? 'success' : 'danger'} />}
          {hint.reviewReasonCode ? <><br /><small>{hint.reviewReasonCode}</small></> : null}
        </td>
      </tr>)}</tbody></table></div> : null}
  </section>;
}
