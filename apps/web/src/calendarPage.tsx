/**
 * One calendar per person, for every role.
 *
 * Everything shown here is already recorded by the feature that owns it — interviews,
 * exam windows, tasks a member of staff assigned, roadmap deadlines. This page invents
 * nothing: an empty week says so rather than filling itself with examples, and a download
 * is offered only when there is something to put in it.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import { listCalendar, type CalendarEntryDto } from './api.js';

const KIND_LABEL: Readonly<Record<CalendarEntryDto['kind'], string>> = {
  INTERVIEW: 'Interview',
  EXAM: 'Exam',
  TASK: 'Task',
  MEETING: 'Meeting',
  ROADMAP: 'Next step',
};

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toISOString().slice(0, 10);
  const prefix = date.toISOString().slice(0, 10) === today ? 'Today · ' : '';
  return prefix + date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function timeLabel(entry: CalendarEntryDto): string {
  const start = new Date(entry.startsAt);
  const time = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (!entry.endsAt || entry.endsAt === entry.startsAt) return time;
  const end = new Date(entry.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${time} – ${end}`;
}

export function CalendarPage(): React.ReactElement {
  const [entries, setEntries] = useState<readonly CalendarEntryDto[] | null>(null);
  const [status, setStatus] = useState('Loading your calendar…');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return; }
    const abort = new AbortController();
    listCalendar(token, abort.signal)
      .then((response) => { setEntries(response.entries); setStatus(''); })
      .catch(() => { if (!abort.signal.aborted) setStatus('Your calendar could not be loaded.'); });
    return () => abort.abort();
  }, []);

  function download(): void {
    // The download route is authenticated like every other, so the file is fetched with
    // the access token and handed to the browser rather than linked directly.
    const token = getAccessToken();
    if (!token || !entries?.length) return;
    void fetch('/api/v1/me/calendar.ics', { headers: { authorization: `Bearer ${token}` } })
      .then((response) => response.text())
      .then((text) => {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'one-calendar.ics';
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => setStatus('The calendar file could not be prepared.'));
  }

  const upcoming = entries ?? [];
  const days = [...new Set(upcoming.map((entry) => dayKey(entry.startsAt)))];

  return <div className="workspace-grid">
    <section className="card wide-card">
      <h2>Your calendar</h2>
      <p>Interviews, exam windows, tasks and deadlines already recorded across ONE, in one place.</p>
      {status ? <p role="status">{status}</p> : null}
      {entries && entries.length > 0
        ? <button type="button" className="secondary" onClick={download}>Download for Outlook or Google Calendar</button>
        : null}
    </section>

    {entries && entries.length === 0
      ? <section className="card wide-card">
        <p>Nothing is scheduled in the next few weeks. Interviews, exam windows and anything your institution assigns you will appear here.</p>
      </section>
      : null}

    {days.map((day) => <section className="card wide-card" key={day}>
      <h3>{dayLabel(day)}</h3>
      <ul className="check-stack">
        {upcoming.filter((entry) => dayKey(entry.startsAt) === day).map((entry) => <li key={`${entry.kind}-${entry.id}`}>
          <span className={`hiring-state state-${entry.kind.toLowerCase()}`}>{KIND_LABEL[entry.kind]}</span>
          {' '}<strong>{entry.title}</strong>
          <span className="hiring-meta"> {timeLabel(entry)}</span>
          {entry.detail ? <span className="hiring-meta"> · {entry.detail}</span> : null}
          {entry.location ? <span className="hiring-meta"> · {entry.location}</span> : null}
          {entry.joinUrl ? <> · <a href={entry.joinUrl} rel="noreferrer noopener" target="_blank">Join</a></> : null}
        </li>)}
      </ul>
    </section>)}
  </div>;
}
