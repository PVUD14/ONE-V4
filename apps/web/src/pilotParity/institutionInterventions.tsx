/**
 * ONE · Pilot-parity — Stream C — Institution
 *
 * The interventions shell. Its not-attempted queue is real, derived from live
 * assessment results; tracked interventions use institution-scoped staff actions.
 */
import { ApiRequestError, apiBaseUrl, getProtectedAccessToken, listInstitutionExamResults, listInstitutionExams } from '../api.js';
import type { ExamNotAttemptedDto } from '../api.js';
import { Ring } from '../pilot/pilotComponents.js';
import { NaListCard, go } from './naWidgets.js';
import { AlertTriangle, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { bearerHeader } from '../sandbox.js';

interface Intervention {
  id: string; title: string; note: string | null; outcomeNote: string | null;
  studentName: string; ownerName: string; state: string; version: number;
  dueAt: string | null; allowedTransitions: string[];
}
interface InterventionResponse { actions: Intervention[]; students: { id: string; name: string }[] }
const transitionLabels: Record<string, string> = {
  DRAFT: 'Return to draft', UNDER_REVIEW: 'Submit for review', APPROVED: 'Approve',
  REJECTED: 'Reject', IN_PROGRESS: 'Start intervention', COMPLETED: 'Complete',
  CANCELLED: 'Cancel intervention', ARCHIVED: 'Archive',
};
function requestError(cause: unknown): string {
  if (cause instanceof ApiRequestError && cause.status === 401) return 'Your session has expired. Sign in again.';
  if (cause instanceof ApiRequestError && cause.status === 403) return 'This action is not available in your current institution scope.';
  if (cause instanceof ApiRequestError && cause.status === 409) return 'This intervention has changed. Refresh the records before trying again.';
  if (cause instanceof ApiRequestError && cause.status === 400) return 'Check the student, title, date and outcome fields.';
  return 'Unable to save or load interventions. Try again.';
}
async function interventionRequest<T>(path: string, token: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(apiBaseUrl + path, {
    method: body === undefined ? 'GET' : 'POST', signal,
    headers: { Accept: 'application/json', ...bearerHeader(token), 'X-Correlation-Id': correlationId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new ApiRequestError({ status: response.status, correlationId });
  return response.json() as Promise<T>;
}

export function InstitutionInterventionsPage(props: { readonly institutionId: string; readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  return <InterventionsWorkspace key={props.institutionId + ':' + token} {...props} token={token} />;
}

function InterventionsWorkspace({ institutionId, basePath, token }: { readonly institutionId: string; readonly basePath: string; readonly token: string | null }): React.ReactElement {
  const [queue, setQueue] = useState<readonly (ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string })[] | null>(null);
  const [queueError, setQueueError] = useState(false);
  const [records, setRecords] = useState<InterventionResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ studentUserId: '', title: '', note: '', dueAt: '' });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const mutation = useRef<AbortController | null>(null);
  const path = '/api/v1/institutions/' + encodeURIComponent(institutionId) + '/staff-actions';
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void listInstitutionExams(token, institutionId, controller.signal).then(async (response) => {
      const published = response.assessments.filter((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0).slice(0, 3);
      const groups = await Promise.all(published.map((exam) =>
        listInstitutionExamResults(token, institutionId, exam.id, controller.signal)
          .then((result) => result.notAttempted.map((entry) => ({ ...entry, examTitle: exam.title, endsAt: exam.endsAt })))));
      if (!controller.signal.aborted) setQueue(groups.flat());
    }).catch(() => { if (!controller.signal.aborted) setQueueError(true); });
    return () => controller.abort();
  }, [token, institutionId]);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    setRecords(null);
    void interventionRequest<InterventionResponse>(path, token, controller.signal).then((result) => {
      if (!controller.signal.aborted) setRecords(result);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(requestError(cause)); });
    return () => controller.abort();
  }, [token, path, refresh]);

  async function save(body: unknown, suffix = ''): Promise<void> {
    if (!token || mutation.current && !mutation.current.signal.aborted && busy) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      await interventionRequest(path + suffix, token, controller.signal, body);
      if (controller.signal.aborted) return;
      if (!suffix) { setShowForm(false); setForm({ studentUserId: '', title: '', note: '', dueAt: '' }); }
      setNotice(suffix ? 'Intervention updated.' : 'Draft intervention saved. Submit it for review when ready.');
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (!controller.signal.aborted) setError(requestError(cause));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  function create(event: FormEvent): void {
    event.preventDefault();
    void save({ ...form, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null });
  }
  const actions = records?.actions ?? [];
  const completed = actions.filter((action) => action.state === 'COMPLETED').length;
  const rate = actions.length ? Math.round(completed * 100 / actions.length) : 0;

  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div><h1>Interventions</h1><p>Structured support for students who need attention before the placement season.</p></div>
        <button type="button" className="pilot-btn" disabled={!token || !records || busy} onClick={() => setShowForm((value) => !value)}><Plus size={15} /> Assign Intervention</button>
      </div>
      {!token ? <p role="alert">Sign in to an institution workspace to manage interventions.</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {showForm && records ? <form className="role-management-form pilot-card" onSubmit={create}>
        <h2>New intervention</h2>
        <p>You will own this intervention. Student choices are limited to your current scope.</p>
        <label>Student<select required disabled={busy} value={form.studentUserId} onChange={(event) => setForm({ ...form, studentUserId: event.target.value })}>
          <option value="">Select a student</option>{records.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}
        </select></label>
        {!records.students.length ? <p>No eligible students are available in your scope.</p> : null}
        <label>Title<input required maxLength={200} disabled={busy} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
        <label>Note<textarea maxLength={4000} disabled={busy} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
        <label>Due date and time<input type="datetime-local" disabled={busy} value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} /></label>
        <button className="pilot-btn" type="submit" disabled={busy || !records.students.length}>{busy ? 'Saving…' : 'Save draft'}</button>
      </form> : null}

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Needs attention now</h2><span className="pilot-chip blue">Live — from assessment data</span></div>
        <div className="pilot-list">
          {!token || queueError ? <p>NA — assessment queue unavailable.</p> : queue === null ? <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Loading…</p>
            : queue.length ? queue.slice(0, 8).map((entry, index) => (
              <div key={`${entry.institutionStudentId}-${index}`} className="pilot-list-row">
                <span className="pilot-tile rose"><AlertTriangle size={16} /></span>
                <div className="grow"><strong>{entry.studentName}</strong><small>{entry.inProgress ? `In progress now: ${entry.examTitle}` : `Has not attempted: ${entry.examTitle}`}</small></div>
                <span className="pilot-chip amber">Due {new Date(entry.endsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                <button type="button" className="pilot-btn ghost small" onClick={() => go(`${basePath}/assessments`)}>Review</button>
              </div>
            )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Nobody needs attention right now — every assigned assessment is attempted.</p>}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Tracked interventions</h2><button type="button" className="pilot-btn ghost small" disabled={!token || busy} onClick={() => { setError(''); setRefresh((value) => value + 1); }}>Refresh records</button></div>
        {!records ? <p>{error || !token ? 'NA — intervention records unavailable.' : 'Loading intervention records…'}</p> :
          !actions.length ? <p>No tracked interventions in your scope yet.</p> : <div className="pilot-list">
            {actions.map((action) => <article className="pilot-card" key={action.id}>
              <h3>{action.title}</h3><p>{action.studentName} · Owner: {action.ownerName}</p>
              <span className="pilot-chip blue">{action.state.replaceAll('_', ' ')}</span>
              <p>Due: {action.dueAt ? new Date(action.dueAt).toLocaleString() : 'NA'}</p>
              {action.note ? <p>{action.note}</p> : null}{action.outcomeNote ? <p>Outcome: {action.outcomeNote}</p> : null}
              {action.allowedTransitions.length ? <>
                <label>Review or outcome note for {action.title}<textarea maxLength={2000} disabled={busy} value={reasons[action.id] ?? ''} onChange={(event) => setReasons({ ...reasons, [action.id]: event.target.value })} /></label>
                <div className="role-record-actions">{action.allowedTransitions.map((state) => <button className="pilot-btn ghost small" type="button" key={state} disabled={busy} onClick={() => {
                  if (['REJECTED', 'COMPLETED', 'CANCELLED'].includes(state) && !reasons[action.id]?.trim()) { setError('Add a review or outcome note before this action.'); return; }
                  void save({ toState: state, version: action.version, note: reasons[action.id] ?? null }, '/' + encodeURIComponent(action.id) + '/transition');
                }}>{transitionLabels[state] ?? state.replaceAll('_', ' ')}</button>)}</div>
              </> : null}
            </article>)}
          </div>}
      </section>
    </div>
    <aside className="pilot-rail">
      <NaListCard title="Why Interventions Work" note={records ? `${completed} of ${actions.length} visible interventions completed. Recorded outcomes appear on each intervention.` : 'NA — intervention outcomes unavailable.'} />
      <section className="pilot-card" style={{ textAlign: 'center' }}>
        <h2 style={{ textAlign: 'left' }}>Completion Rate</h2>
        <Ring value={rate} size={104} stroke={11} tone="blue"><span style={{ fontSize: 16, color: 'var(--p-muted)' }}>{records ? `${rate}%` : 'NA'}</span></Ring>
        <small style={{ display: 'block', marginTop: 8, color: 'var(--p-muted)' }}>{records ? `${completed} of ${actions.length} visible interventions complete` : 'NA — intervention records unavailable'}</small>
      </section>
    </aside>
  </div></div>;
}
