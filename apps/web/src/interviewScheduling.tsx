/**
 * Interview scheduling essentials on the web (EMP-09): an interview's schedule history, the
 * scorecards recorded against its stage template, the employer's scorecard templates, the rating
 * fields a templated scorecard asks for, and the "Add to calendar" download.
 *
 * Separate from hiringPages.tsx so the Interviews screen, the participant workspace and the
 * student's Applications screen share one implementation. Everything shown comes from the API; a
 * missing value renders NA, an empty list says so, and nothing sums or ranks ratings.
 */
import { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  ApiRequestError,
  createScorecardTemplate,
  getInterviewScorecards,
  listInterviewHistory,
  listScorecardTemplates,
  retireScorecardTemplate,
  saveDownloadedFile,
  scorecardTemplateRetireReasons,
  type InterviewRevisionDto,
  type InterviewScorecardsDto,
  type ScorecardTemplateDto,
} from './api.js';

/** Plain words for the reason codes (packages/hiring/src/interview-scheduling.ts). */
export const interviewReasonLabels: Readonly<Record<string, string>> = {
  CANDIDATE_REQUESTED: 'The candidate asked', INTERVIEWER_UNAVAILABLE: 'An interviewer is unavailable',
  SCHEDULING_CONFLICT: 'Scheduling conflict', LOGISTICS_CHANGED: 'Arrangements changed', TECHNICAL_ISSUE: 'Technical problem',
  CANDIDATE_WITHDREW: 'The candidate withdrew', POSITION_FILLED: 'The position is filled', PROCESS_CHANGED: 'The process changed',
  SCHEDULED_IN_ERROR: 'Scheduled in error', NO_LONGER_USED: 'No longer used', REPLACED: 'Replaced by another template',
  CREATED_IN_ERROR: 'Created in error',
};

const changeLabels: Readonly<Record<string, string>> = {
  BASELINE: 'As it stood when history began', SCHEDULED: 'Scheduled', RESCHEDULED: 'Rescheduled', CANCELLED: 'Cancelled',
  COMPLETED: 'Marked completed', NO_SHOW: 'Marked no show',
};

const modeLabels: Readonly<Record<string, string>> = { VIDEO: 'Video', PHONE: 'Phone', ONSITE: 'On site' };

function when(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'NA';
  return new Date(value).toLocaleString();
}

function failure(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.status === 403) return 'You do not have access to this, or the candidate is no longer sharing their details.';
  return error instanceof ApiRequestError && error.correlationId ? `${fallback} Reference: ${error.correlationId}.` : fallback;
}

/** The latest change as one line for a table cell: "Rescheduled — The candidate asked". */
export function lastChangeText(change: { readonly kind: string; readonly reasonCode: string | null } | null | undefined): string {
  if (!change) return 'NA';
  const label = changeLabels[change.kind] ?? change.kind;
  return change.reasonCode ? `${label} — ${interviewReasonLabels[change.reasonCode] ?? change.reasonCode}` : label;
}

export function InterviewHistoryPanel({ employerId, interviewId, onClose }: {
  readonly employerId: string; readonly interviewId: string; readonly onClose: () => void;
}): React.ReactElement {
  const [revisions, setRevisions] = useState<readonly InterviewRevisionDto[] | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const abort = new AbortController();
    listInterviewHistory(token, employerId, interviewId, abort.signal)
      .then((response) => { if (!abort.signal.aborted) setRevisions(response.revisions ?? []); })
      .catch((error) => { if (!abort.signal.aborted) { setRevisions([]); setStatus(failure(error, 'The history could not be loaded.')); } });
    return () => abort.abort();
  }, [employerId, interviewId]);
  return <section className="role-card role-wide" aria-label="Interview history">
    <div className="hiring-actions"><h2>Interview history</h2><button type="button" className="secondary" onClick={onClose}>Close history</button></div>
    <p>Every change, oldest first. Reasons and notes stay with your team; the candidate is only told that the interview moved or was cancelled.</p>
    {status ? <p role="status">{status}</p> : null}
    {revisions === null ? <p>Loading the history…</p> : revisions.length === 0 && !status ? <p>No changes recorded.</p> : <ol className="hiring-stages">
      {revisions.map((revision) => <li key={revision.revisionNumber}>
        <strong>{changeLabels[revision.changeKind] ?? revision.changeKind}</strong>
        {revision.reasonCode ? ` — ${interviewReasonLabels[revision.reasonCode] ?? revision.reasonCode}` : ''}
        <span className="hiring-meta"> · {modeLabels[revision.mode] ?? revision.mode} · {when(revision.scheduledStart)} to {when(revision.scheduledEnd)} · by {revision.actorLabel} on {when(revision.recordedAt)}</span>
        {revision.note ? <p className="hiring-meta">Note: {revision.note}</p> : null}
      </li>)}
    </ol>}
  </section>;
}

export function InterviewScorecardsPanel({ employerId, interviewId, onClose }: {
  readonly employerId: string; readonly interviewId: string; readonly onClose: () => void;
}): React.ReactElement {
  const [data, setData] = useState<InterviewScorecardsDto | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const abort = new AbortController();
    getInterviewScorecards(token, employerId, interviewId, abort.signal)
      .then((response) => { if (!abort.signal.aborted) setData(response); })
      .catch((error) => { if (!abort.signal.aborted) setStatus(failure(error, 'The scorecards could not be loaded.')); });
    return () => abort.abort();
  }, [employerId, interviewId]);
  return <section className="role-card role-wide" aria-label="Interview scorecards">
    <div className="hiring-actions"><h2>Scorecards</h2><button type="button" className="secondary" onClick={onClose}>Close scorecards</button></div>
    <p>Each interviewer's own judgement, criterion by criterion, exactly as given. A person decides; ONE never combines them into one number.</p>
    {status ? <p role="status">{status}</p> : null}
    {data ? <>
      <p>Scorecard template: {data.template ? data.template.name : 'NA — this interview has no stage template.'}</p>
      {(data.scorecards ?? []).length === 0 ? <p>No scorecards recorded yet.</p> : <ul className="hiring-list">
        {(data.scorecards ?? []).map((card) => <li key={`${card.submittedBy}-${card.submittedAt ?? ''}`} className="hiring-list-item"><div>
          <h3>{card.submittedBy}</h3>
          <p className="hiring-meta">Recommendation: {card.recommendation.replace(/_/g, ' ').toLowerCase()} · Overall rating: {card.overallRating ?? 'NA'} · {when(card.submittedAt)}</p>
          {card.ratings.length ? <ul>{card.ratings.map((rating) => <li key={rating.criterionId}>{rating.label}: {rating.rating} of 5{rating.note ? ` — ${rating.note}` : ''}</li>)}</ul> : null}
          {card.strengths ? <p>Strengths: {card.strengths}</p> : null}
          {card.concerns ? <p>Concerns: {card.concerns}</p> : null}
          {card.notes ? <p>Notes: {card.notes}</p> : null}
        </div></li>)}
      </ul>}
    </> : status ? null : <p>Loading scorecards…</p>}
  </section>;
}

/**
 * The criterion ratings a templated scorecard needs: one 1–5 choice per criterion, each with its
 * guidance and an optional note. Field names are `criterion:<id>` and `criterionNote:<id>`.
 */
export function CriteriaRatingFields({ template }: { readonly template: ScorecardTemplateDto }): React.ReactElement {
  return <fieldset><legend>{template.name}</legend>
    {template.guidance ? <p>{template.guidance}</p> : null}
    {template.criteria.map((criterion) => <div key={criterion.id} role="group" aria-label={criterion.label}>
      <label><span>{criterion.label} (1–5)</span><select name={`criterion:${criterion.id}`} required defaultValue="">
        <option value="" disabled>Choose a rating</option>
        {[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {criterion.guidance ? <p className="hiring-meta">{criterion.guidance}</p> : null}
      <label><span>Note on {criterion.label} (optional)</span><input name={`criterionNote:${criterion.id}`} maxLength={1000} /></label>
    </div>)}
  </fieldset>;
}

/** Read the criterion ratings back out of a submitted form. */
export function readCriteriaRatings(form: FormData, template: ScorecardTemplateDto): { criterionId: string; rating: number; note?: string }[] {
  return template.criteria.map((criterion) => {
    const note = String(form.get(`criterionNote:${criterion.id}`) ?? '').trim();
    return { criterionId: criterion.id, rating: Number(form.get(`criterion:${criterion.id}`)), ...(note ? { note } : {}) };
  });
}

interface CriterionDraft { readonly key: number; label: string; guidance: string }
let draftKey = 1;

/** The employer's scorecard templates: list, create and retire. Choosing one happens on a job stage. */
export function ScorecardTemplatesPanel({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [templates, setTemplates] = useState<readonly ScorecardTemplateDto[] | null>(null);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [guidance, setGuidance] = useState('');
  const [criteria, setCriteria] = useState<CriterionDraft[]>([{ key: draftKey++, label: '', guidance: '' }]);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const abort = new AbortController();
    listScorecardTemplates(token, employerId, abort.signal)
      .then((response) => { if (!abort.signal.aborted) setTemplates(response.templates ?? []); })
      .catch((error) => { if (!abort.signal.aborted) { setTemplates([]); setStatus(failure(error, 'Scorecard templates could not be loaded.')); } });
    return () => abort.abort();
  }, [employerId, reload]);

  async function create(): Promise<void> {
    const token = getAccessToken();
    if (!token || busy) return;
    setBusy(true); setStatus('');
    try {
      await createScorecardTemplate(token, employerId, {
        name: name.trim(), ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
        criteria: criteria.map((criterion) => ({ label: criterion.label.trim(), ...(criterion.guidance.trim() ? { guidance: criterion.guidance.trim() } : {}) })),
      });
      setCreating(false); setName(''); setGuidance(''); setCriteria([{ key: draftKey++, label: '', guidance: '' }]);
      setStatus('Template saved. Choose it on a job\'s interview stage from Opportunity Detail.');
      setReload((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof ApiRequestError && error.code === 'SCORECARD_TEMPLATE_NAME_TAKEN'
        ? 'A live template already has that name.' : failure(error, 'The template could not be saved.'));
    } finally { setBusy(false); }
  }

  async function retire(template: ScorecardTemplateDto, reasonCode: typeof scorecardTemplateRetireReasons[number]): Promise<void> {
    const token = getAccessToken();
    if (!token || busy) return;
    setBusy(true); setStatus('');
    try {
      await retireScorecardTemplate(token, employerId, template.id, reasonCode);
      setStatus(`${template.name} retired. Stages already using it keep it.`);
      setReload((value) => value + 1);
    } catch (error) { setStatus(failure(error, 'The template could not be retired.')); }
    finally { setBusy(false); }
  }

  const live = (templates ?? []).filter((template) => !template.retiredAt);
  const retired = (templates ?? []).filter((template) => template.retiredAt);
  return <section className="role-card role-wide" aria-label="Scorecard templates">
    <h2>Scorecard templates</h2>
    <p>A template lists what interviewers on a stage judge, with guidance. Templates are never edited: make a new one and choose it on the stage, so every scorecard keeps the criteria its interviewer saw.</p>
    {status ? <p role="status">{status}</p> : null}
    {templates === null ? <p>Loading templates…</p> : live.length === 0 ? <p>No scorecard templates yet. Interviews without one use the free-text scorecard.</p>
      : <ul className="hiring-list">{live.map((template) => <li key={template.id} className="hiring-list-item"><div>
        <h3>{template.name}</h3>
        {template.guidance ? <p className="hiring-meta">{template.guidance}</p> : null}
        <ol>{template.criteria.map((criterion) => <li key={criterion.id}>{criterion.label}{criterion.guidance ? <span className="hiring-meta"> — {criterion.guidance}</span> : null}</li>)}</ol>
      </div><div className="hiring-actions">
        <label><span>Retire because</span><select aria-label={`Retire ${template.name}`} defaultValue="" disabled={busy}
          onChange={(event) => { const value = event.target.value as typeof scorecardTemplateRetireReasons[number]; if (value) void retire(template, value); }}>
          <option value="" disabled>Choose a reason</option>
          {scorecardTemplateRetireReasons.map((reason) => <option key={reason} value={reason}>{interviewReasonLabels[reason] ?? reason}</option>)}
        </select></label>
      </div></li>)}</ul>}
    {retired.length ? <p className="hiring-meta">Retired: {retired.map((template) => template.name).join(', ')}</p> : null}
    {creating ? <form className="role-management-form" aria-label="New scorecard template" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label><span>Name</span><input value={name} required maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>Guidance for interviewers (optional)</span><textarea value={guidance} maxLength={2000} onChange={(event) => setGuidance(event.target.value)} /></label>
      <fieldset><legend>Criteria (1 to 12), each rated 1–5</legend>
        {criteria.map((criterion, index) => <div key={criterion.key} className="hiring-actions" role="group" aria-label={`Criterion ${index + 1}`}>
          <label><span>Criterion</span><input value={criterion.label} required maxLength={120}
            onChange={(event) => setCriteria((current) => current.map((item) => item.key === criterion.key ? { ...item, label: event.target.value } : item))} /></label>
          <label><span>Guidance (optional)</span><input value={criterion.guidance} maxLength={1000}
            onChange={(event) => setCriteria((current) => current.map((item) => item.key === criterion.key ? { ...item, guidance: event.target.value } : item))} /></label>
          <button type="button" className="secondary" disabled={criteria.length === 1} onClick={() => setCriteria((current) => current.filter((item) => item.key !== criterion.key))}>Remove</button>
        </div>)}
        <button type="button" className="secondary" disabled={criteria.length >= 12} onClick={() => setCriteria((current) => [...current, { key: draftKey++, label: '', guidance: '' }])}>Add a criterion</button>
      </fieldset>
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save template'}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => setCreating(false)}>Close form</button>
    </form> : <div className="hiring-actions"><button type="button" onClick={() => setCreating(true)}>New scorecard template</button></div>}
  </section>;
}

/** "Add to calendar": fetches the interview's .ics with the access token and saves it. */
export function AddToCalendarButton({ download }: {
  readonly download: (token: string) => Promise<{ readonly blob: Blob; readonly filename: string }>;
}): React.ReactElement {
  const [status, setStatus] = useState('');
  async function run(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setStatus('Preparing the calendar file…');
    try {
      saveDownloadedFile(await download(token));
      setStatus('Calendar file downloaded. Open it to add the interview to your calendar.');
    } catch {
      setStatus('The calendar file could not be prepared. Try again.');
    }
  }
  return <span className="hiring-actions">
    <button type="button" className="secondary" onClick={() => { void run(); }}>Add to calendar</button>
    {status ? <span role="status" className="hiring-meta">{status}</span> : null}
  </span>;
}
