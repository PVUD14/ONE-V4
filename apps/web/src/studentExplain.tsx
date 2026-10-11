/**
 * "Ask ONE to explain" on the web (ADR-052): a student names any topic and reads an AI-written lesson.
 *
 * Why it exists: Divakar decided (2026-10-10) a student may ask ONE to explain any topic and read the AI lesson
 * without a person reviewing each one. This screen is where that happens, and it carries the safeguards the
 * student can see: every lesson is labelled "AI-generated — not checked by a person"; asking answers at once
 * with "Your lesson is being prepared" and polls until the job is done (no model runs in the request); a
 * refused, blocked or withdrawn lesson is never shown, only a plain sentence; and "Report a mistake" sends it
 * to operations. Nothing here counts toward readiness or anything else. While the feature is off the screen is
 * the existing empty state saying so plainly. Momentum re-skin: status uses <StatusTag>, the AI marker is the
 * Momentum coach icon, and a figure the API did not send is left out rather than shown as a placeholder.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  askOneToExplain,
  getExplainRequest,
  getExplainStatus,
  listExplainRequests,
  reportExplainLesson,
  type ExplainAvailabilityDto,
  type ExplainNotAvailable,
  type ExplainReportReason,
  type ExplainRequestDto,
} from './api.js';
import { V2EmptyState } from './dashboardsV2.js';
import { Icon } from './icons/Icon.js';
import { StatusTag } from './momentum/statusTag.js';

export const EXPLAIN_LABEL = 'AI-generated — not checked by a person';
export const EXPLAIN_PREPARING_TEXT = 'Your lesson is being prepared';
const POLL_MS = 3_000;
/** Ten minutes: the server closes a lesson still preparing after that. */
const POLL_LIMIT = 200;

export const EXPLAIN_NOT_AVAILABLE_TEXT: Readonly<Record<ExplainNotAvailable, string>> = {
  CHECKS_FAILED: 'ONE could not prepare a lesson on this topic that passed its checks. Try different wording, or try again later.',
  TIMED_OUT: 'Preparing this lesson took too long. You can ask again.',
  AI_UNAVAILABLE: 'Lessons cannot be prepared right now. Try again later.',
  WITHDRAWN: 'This lesson was taken down after a check.',
};
export const EXPLAIN_REFUSED_TEXT = 'ONE can’t explain this. Ask ONE to explain covers learning topics only — not anything harmful, cheating, personal information about anyone, or tasks outside learning.';

const REPORT_REASONS: readonly { readonly code: ExplainReportReason; readonly label: string }[] = [
  { code: 'WRONG_FACT', label: 'Something in it is wrong' },
  { code: 'CONFUSING', label: 'It is confusing' },
  { code: 'UNSAFE', label: 'It is unsafe or inappropriate' },
  { code: 'NOT_WHAT_I_ASKED', label: 'It is not what I asked' },
  { code: 'OTHER', label: 'Something else' },
];

const muted: React.CSSProperties = { color: 'var(--text-2)', margin: '4px 0' };

/** The AI marker: a brand-soft pill with the coach icon (the nav icon of this screen). */
function AiPill({ children }: { readonly children?: React.ReactNode }): React.ReactElement {
  return <span className="pilot-chip purple" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="coach" size={16} />{children ?? 'AI'}</span>;
}

function errorText(error: unknown, fallback: string): string {
  return (error as { detail?: string }).detail ?? fallback;
}

function stateChip(request: ExplainRequestDto): React.ReactElement {
  if (request.state === 'READY') return request.reported ? <StatusTag state="REPORTED" tone="warn" label="Reported" /> : <StatusTag state="READY" tone="ok" label="Ready" />;
  if (request.state === 'PREPARING') return <StatusTag state="PREPARING" tone="band" label="Preparing" />;
  if (request.state === 'REFUSED') return <StatusTag state="REFUSED" tone="danger" label="Refused" />;
  return <StatusTag state="NOT_AVAILABLE" tone="mute" label="Not available" />;
}

export function StudentExplainPage(): React.ReactElement {
  const [availability, setAvailability] = useState<ExplainAvailabilityDto | null>(null);
  const [requests, setRequests] = useState<readonly ExplainRequestDto[]>([]);
  const [selected, setSelected] = useState<ExplainRequestDto | null>(null);
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  async function refresh(signal?: AbortSignal): Promise<void> {
    const token = getAccessToken();
    if (!token) { setLoadError('You are not signed in.'); return; }
    const status = await getExplainStatus(token, signal);
    setAvailability(status.availability);
    if (status.availability.reason === 'OFF') { setRequests([]); return; }
    const list = await listExplainRequests(token, signal);
    setRequests(list.requests);
  }

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setLoadError('Ask ONE to explain could not be loaded right now.'); });
    return () => controller.abort();
  }, []);

  function show(next: ExplainRequestDto): void {
    setSelected(next);
    setRequests((current) => [next, ...current.filter((entry) => entry.id !== next.id)]);
  }

  async function ask(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token || !topic.trim()) return;
    setBusy(true);
    setError('');
    try {
      const asked = await askOneToExplain(token, topic);
      show(asked.request);
      setTopic('');
      await refresh().catch(() => undefined);
    } catch (failure) {
      setError(errorText(failure, 'ONE could not take this request. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <section className="pilot-card" aria-label="Ask ONE to explain"><p role="alert" className="form-error">{loadError}</p></section>;
  if (!availability) return <section className="pilot-card" aria-label="Ask ONE to explain"><p role="status" style={muted}>Loading…</p></section>;
  if (availability.reason === 'OFF') {
    return <V2EmptyState icon="💡" title="Ask ONE to explain is not available yet"
      note="When it is switched on, you will be able to ask ONE to explain any topic and read an AI-written lesson about it."
      hint="Your Learning page has the lessons and practice that are live today." />;
  }
  const preparing = requests.some((entry) => entry.state === 'PREPARING');
  return <>
    <section className="pilot-card" aria-labelledby="explain-ask">
      <div className="pilot-card-head"><h2 id="explain-ask">Ask ONE to explain</h2><AiPill /></div>
      <p style={muted}>Name a topic — “data science”, “nuclear physics”, “how a hash table works” — and ONE writes a short lesson about it. Lessons are AI-generated and not checked by a person, and they do not count toward your readiness or anything a college or employer sees.</p>
      <form onSubmit={(event) => { void ask(event); }}>
        <label className="pilot-field"><span>Topic (English, {availability.limits.topicMin}–{availability.limits.topicMax} characters)</span>
          <input value={topic} maxLength={availability.limits.topicMax} onChange={(event) => setTopic(event.target.value)} aria-label="Topic to explain" placeholder="e.g. how photosynthesis works" />
        </label>
        <button type="submit" className="pilot-btn" disabled={busy || !availability.available || topic.trim().length < availability.limits.topicMin}>Explain</button>
        <small style={{ ...muted, marginLeft: 8 }}>
          {availability.reason === 'PREPARING' ? 'Your last lesson is still being prepared.' : availability.reason === 'DAILY_LIMIT' ? 'You have asked for 10 lessons today. You can ask again tomorrow.'
            : availability.remainingToday === null || availability.remainingToday === undefined ? null : `${availability.remainingToday} of ${availability.limits.perDay} left today.`}
        </small>
      </form>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </section>
    {selected ? <ExplainRequestCard key={selected.id} request={selected} onChange={show} /> : null}
    <section className="pilot-card" aria-labelledby="explain-history">
      <div className="pilot-card-head"><h2 id="explain-history">Your questions</h2><span className="pilot-chip slate">{requests.length.toLocaleString()}</span></div>
      {requests.length ? requests.map((entry) => <div key={entry.id} className="pilot-list-row">
        <div className="grow"><strong>{entry.topic}</strong><small>{new Date(entry.askedAt).toLocaleString()}</small></div>
        {stateChip(entry)}
        <button type="button" className="pilot-btn small soft" onClick={() => setSelected(entry)} aria-label={`Open ${entry.topic}`}>Open</button>
      </div>) : <p style={muted}>You have not asked ONE to explain anything yet.</p>}
      {preparing && selected?.state !== 'PREPARING' ? <p role="status" style={muted}>{EXPLAIN_PREPARING_TEXT}…</p> : null}
    </section>
  </>;
}

/** One request: preparing (polling), the lesson with its label and "Report a mistake", or a plain sentence. */
export function ExplainRequestCard({ request, onChange }: { readonly request: ExplainRequestDto; readonly onChange: (next: ExplainRequestDto) => void }): React.ReactElement {
  return <section className="pilot-card" aria-label={`Lesson: ${request.topic}`}>
    <div className="pilot-card-head"><h2>{request.lesson?.title ?? request.topic}</h2>{stateChip(request)}</div>
    {request.state === 'PREPARING' ? <>
      <p role="status"><AiPill /> {EXPLAIN_PREPARING_TEXT}…</p>
      <ExplainPoll requestId={request.id} onChange={onChange} />
    </> : null}
    {request.state === 'REFUSED' ? <p role="note">{EXPLAIN_REFUSED_TEXT}</p> : null}
    {request.state === 'NOT_AVAILABLE' ? <p role="note">{EXPLAIN_NOT_AVAILABLE_TEXT[request.notAvailable ?? 'AI_UNAVAILABLE']}</p> : null}
    {request.state === 'READY' && request.lesson ? <>
      <p><span aria-label="Lesson label"><AiPill>{request.lesson.label}</AiPill></span></p>
      {request.lesson.sections.map((section) => <div key={section.heading} style={{ marginTop: 12 }}>
        <h3 style={{ margin: '0 0 4px' }}>{section.heading}</h3>
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{section.text}</p>
      </div>)}
      <small style={muted}>Written by ONE’s AI and checked only by ONE’s automatic rules{request.servedFromCache ? '; another student asked the same topic first' : ''}.</small>
      {request.reported ? <p role="status" style={muted}>You reported this lesson. Thank you — operations will look at it.</p> : <ReportMistake requestId={request.id} onChange={onChange} />}
    </> : null}
  </section>;
}

function ExplainPoll({ requestId, onChange }: { readonly requestId: string; readonly onChange: (next: ExplainRequestDto) => void }): null {
  useEffect(() => {
    const token = getAccessToken();
    if (!token) return undefined;
    const controller = new AbortController();
    let rounds = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      rounds += 1;
      getExplainRequest(token, requestId, controller.signal).then((next) => {
        if (next.request.state !== 'PREPARING') { onChange(next.request); return; }
        if (rounds < POLL_LIMIT) timer = setTimeout(tick, POLL_MS);
      }).catch(() => { if (!controller.signal.aborted && rounds < POLL_LIMIT) timer = setTimeout(tick, POLL_MS); });
    };
    timer = setTimeout(tick, POLL_MS);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [requestId]);
  return null;
}

function ReportMistake({ requestId, onChange }: { readonly requestId: string; readonly onChange: (next: ExplainRequestDto) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ExplainReportReason>('WRONG_FACT');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!open) return <p><button type="button" className="pilot-btn small ghost" onClick={() => setOpen(true)}>Report a mistake</button></p>;
  async function send(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true);
    setError('');
    try {
      onChange((await reportExplainLesson(token, requestId, reason, note.trim() || null)).request);
    } catch (failure) {
      setError(errorText(failure, 'The report could not be sent. Try again.'));
    } finally {
      setBusy(false);
    }
  }
  return <div style={{ marginTop: 12 }} aria-label="Report a mistake">
    <label className="pilot-field"><span>What is wrong?</span>
      <select value={reason} onChange={(event) => setReason(event.target.value as ExplainReportReason)} aria-label="What is wrong">
        {REPORT_REASONS.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
      </select>
    </label>
    <label className="pilot-field"><span>Note (optional, no personal details, up to 300 characters)</span>
      <textarea value={note} maxLength={300} rows={3} onChange={(event) => setNote(event.target.value)} aria-label="Note" />
    </label>
    <button type="button" className="pilot-btn small" disabled={busy} onClick={() => { void send(); }}>Send report</button>
    <button type="button" className="pilot-btn small ghost" disabled={busy} onClick={() => setOpen(false)} style={{ marginLeft: 8 }}>Cancel</button>
    {error ? <p role="alert" className="form-error">{error}</p> : null}
  </div>;
}
