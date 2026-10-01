/**
 * ONE · Role portal — Growth → Field (GROWTH-06; design §14, §16.1), and the field-work panel the
 * lead detail shows.
 *
 * Field staff see their follow-ups (overdue, due today, upcoming) and their recent visits, calls,
 * meetings and notes; a regional manager can switch to their team's. On a lead they log what they
 * did and what comes next. Every write carries an Idempotency-Key that is kept until the server
 * answers, so a double click or a retry after a dropped connection lands once.
 *
 * A visit's location is attached on the phone only (by a tap in the ONE app); here it is shown
 * to its author and their manager — the server leaves it out for everyone else — and its author
 * can remove it. Every figure comes from a real row; an empty list says so.
 */
import { useEffect, useRef, useState } from 'react';
import {
  addGrowthFollowUp,
  ApiRequestError,
  cancelGrowthFollowUp,
  completeGrowthFollowUp,
  getGrowthField,
  getGrowthLeadField,
  getProtectedAccessToken,
  logGrowthActivity,
  removeGrowthActivityLocation,
  type GrowthActivityDto,
  type GrowthActivityKindDto,
  type GrowthFieldDto,
  type GrowthFieldVocabularyDto,
  type GrowthFollowUpDto,
  type GrowthLeadContactDto,
  type GrowthLeadFieldDto,
} from '../api.js';
import { V2Chip, V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { growthCodeLabel } from './growthLeads.js';
import { formatApiError } from './shared.js';

const NA = 'NA';

const kindLabels: Readonly<Record<string, string>> = { VISIT: 'Visit', CALL: 'Call', MEETING: 'Meeting', NOTE: 'Note' };
const kindIcons: Readonly<Record<string, string>> = { VISIT: '📍', CALL: '📞', MEETING: '🤝', NOTE: '📝' };

/** Refusals in plain words; the server's codes never reach the screen as text. */
function fieldError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiRequestError) {
    const code = cause.code;
    if (code === 'GROWTH_REPORT_TOO_OLD') return 'That is more than 7 days ago. Work older than a week cannot be logged.';
    if (code === 'GROWTH_REPORT_IN_FUTURE') return 'That time is in the future. Check the date and time.';
    if (code === 'GROWTH_LEAD_DO_NOT_CONTACT') return 'This organisation asked not to be contacted. No work can be logged on it.';
    if (code === 'GROWTH_LEAD_CLOSED') return 'This lead is closed (lost or handed off). No more work can be logged on it.';
    if (code === 'GROWTH_NOT_LEAD_OWNER') return 'Claim this lead first: work is logged by its owner or their manager.';
    if (code === 'GROWTH_FOLLOW_UP_ALREADY_CLOSED') return 'This follow-up is already closed.';
    if (code === 'GROWTH_FOLLOW_UP_DUE_TOO_EARLY' || code === 'GROWTH_FOLLOW_UP_DUE_TOO_LATE') return 'Choose a due date from a week ago to a year ahead.';
  }
  return formatApiError(cause, fallback);
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : NA;
}

function dueLabel(followUp: GrowthFollowUpDto): string {
  if (followUp.state !== 'OPEN') return growthCodeLabel(followUp.state);
  if (followUp.overdue) return `Overdue since ${followUp.dueOn}`;
  if (followUp.dueToday) return 'Due today';
  return `Due ${followUp.dueOn}`;
}

/** A key for one intended write: kept across retries of the same submission, renewed after it lands. */
function useWriteKey(): { readonly current: () => string; readonly renew: () => void } {
  const key = useRef<string>(crypto.randomUUID());
  return { current: () => key.current, renew: () => { key.current = crypto.randomUUID(); } };
}

export function GrowthFieldPage({ role }: { readonly role?: string | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [view, setView] = useState<'MINE' | 'TEAM'>('MINE');
  const [field, setField] = useState<GrowthFieldDto | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const manager = role === 'GROWTH_MANAGER';

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    getGrowthField(token, view, controller.signal)
      .then((result) => { setField(result); setError(''); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setField(null); setError(fieldError(cause, 'Your field work could not be loaded.')); } });
    return () => controller.abort();
  }, [token, view, reload]);

  const counts = field?.counts ?? null;
  const followUps = field?.followUps ?? [];
  const overdue = followUps.filter((item) => item.overdue);
  const today = followUps.filter((item) => item.dueToday);
  const upcoming = followUps.filter((item) => !item.overdue && !item.dueToday);
  const team = view === 'TEAM';

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">ONE · Growth · Field</p>
            <h1>Field</h1>
            <p>{team ? 'Your team\'s follow-ups and recent field work.' : 'Your follow-ups and your recent visits, calls, meetings and notes. Log work from a lead, here or in the ONE app — the app also works offline.'}</p>
            <div className="v2-hero-chips">
              {manager ? <>
                <button type="button" className="pilot-btn" aria-pressed={!team} onClick={() => setView('MINE')}>Mine</button>
                <button type="button" className="pilot-btn" aria-pressed={team} onClick={() => setView('TEAM')}>My team</button>
              </> : null}
              <V2Chip tone="slate">{field ? `Today ${field.today}` : NA}</V2Chip>
            </div>
          </div>
        </div>

        <div className="v2-row v2-cols-4" role="region" aria-label="Field summary">
          <V2Stat icon="📍" tone="teal" value={counts ? counts.visitsThisMonth : NA} label="Visits this month" />
          <V2Stat icon="🤝" tone="blue" value={counts ? counts.metThisMonth : NA} label="Met this month" />
          <V2Stat icon="📅" tone="amber" value={counts ? counts.followUpsDueToday : NA} label="Follow-ups due today" />
          <V2Stat icon="⏰" tone="purple" value={counts ? counts.followUpsOverdue : NA} label="Overdue follow-ups" />
        </div>

        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <section className="v2-card" aria-label="Follow-ups">
          <div className="v2-card-head"><h2>Follow-ups</h2><V2Chip tone="slate">{counts ? `${counts.followUpsOpen} open` : NA}</V2Chip></div>
          {!field && !error ? <p className="v2-empty">Loading…</p> : null}
          {field && !followUps.length ? <V2EmptyState icon="📅" title="No open follow-ups" note={team ? 'Nobody on your team has an open follow-up.' : 'Add a follow-up from a lead when there is something to do next.'} /> : null}
          {field && token ? <>
            <FollowUpGroup title="Overdue" items={overdue} token={token} vocabulary={field.vocabulary} team={team} onChanged={() => setReload((value) => value + 1)} />
            <FollowUpGroup title="Due today" items={today} token={token} vocabulary={field.vocabulary} team={team} onChanged={() => setReload((value) => value + 1)} />
            <FollowUpGroup title="Upcoming" items={upcoming} token={token} vocabulary={field.vocabulary} team={team} onChanged={() => setReload((value) => value + 1)} />
          </> : null}
        </section>

        <section className="v2-card" aria-label="Recent field work">
          <div className="v2-card-head"><h2>Recent field work</h2><V2Chip tone="slate">{counts ? `${counts.activitiesThisMonth} this month` : NA}</V2Chip></div>
          {field && token ? (field.activities.length
            ? <ActivityList items={field.activities} token={token} showLead onChanged={() => setReload((value) => value + 1)} />
            : <V2EmptyState icon="📍" title="No field work logged yet" note="Visits, calls, meetings and notes appear here once they are logged on a lead." />)
            : <p className="v2-empty">{error ? NA : 'Loading…'}</p>}
        </section>
      </div>

      <div className="v2-rail">
        <LocationNoticeCard vocabulary={field?.vocabulary ?? null} />
        <section className="v2-card">
          <div className="v2-card-head"><h2>Reminders and offline</h2></div>
          <p className="v2-empty">The ONE app reminds you on the morning a follow-up is due, from your phone. Work logged in the app without a signal is kept on the phone, encrypted, and sent once when the network returns; anything the server refuses is shown to you, never dropped.</p>
        </section>
      </div>
    </div>
  );
}

function LocationNoticeCard({ vocabulary }: { readonly vocabulary: GrowthFieldVocabularyDto | null }): React.ReactElement {
  return <section className="v2-card" aria-label="Visit location">
    <div className="v2-card-head"><h2>Visit location</h2><V2Chip tone="amber">Draft for legal review</V2Chip></div>
    {vocabulary ? <>{vocabulary.locationNotice.text.map((line) => <p key={line} className="v2-empty">{line}</p>)}<small>Version {vocabulary.locationNotice.version}</small></> : <p className="v2-empty">{NA}</p>}
  </section>;
}

function FollowUpGroup({ title, items, token, vocabulary, team, onChanged }: {
  readonly title: string; readonly items: readonly GrowthFollowUpDto[]; readonly token: string; readonly vocabulary: GrowthFieldVocabularyDto;
  readonly team: boolean; readonly onChanged: () => void;
}): React.ReactElement | null {
  if (!items.length) return null;
  return <>
    <h3>{title} ({items.length})</h3>
    <div className="v2-list">{items.map((item) => <FollowUpRow key={item.id} item={item} token={token} vocabulary={vocabulary} showAssignee={team} onChanged={onChanged} />)}</div>
  </>;
}

function FollowUpRow({ item, token, vocabulary, showAssignee, showLead = true, onChanged }: {
  readonly item: GrowthFollowUpDto; readonly token: string; readonly vocabulary: GrowthFieldVocabularyDto; readonly showAssignee: boolean;
  readonly showLead?: boolean; readonly onChanged: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = useWriteKey();
  const cancel = useWriteKey();
  async function close(action: () => Promise<unknown>, key: { readonly renew: () => void }): Promise<void> {
    setBusy(true);
    try {
      await action();
      key.renew();
      setError('');
      onChanged();
    } catch (cause) {
      setError(fieldError(cause, 'The follow-up could not be updated.'));
    } finally {
      setBusy(false);
    }
  }
  return <div className="v2-list-row" aria-label={`Follow-up ${item.title ?? ''}`}>
    <span className="v2-tile amber" aria-hidden="true">📅</span>
    <div className="grow">
      <strong>{item.title ?? 'Text erased after 24 months'}</strong>
      <small>{showLead ? `${item.leadName} · ` : ''}{dueLabel(item)}{showAssignee ? ` · ${item.assignee.isMe ? 'you' : item.assignee.email}` : ''}</small>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
    <V2Chip tone={item.overdue ? 'red' : item.dueToday ? 'amber' : 'slate'}>{dueLabel(item)}</V2Chip>
    {item.state === 'OPEN' ? <span className="role-actions">
      <button type="button" className="pilot-btn" disabled={busy} onClick={() => void close(() => completeGrowthFollowUp(token, item.id, done.current()), done)}>Done</button>
      <label>Cancel reason<select aria-label={`Cancel reason for ${item.title ?? 'follow-up'}`} value={reason} onChange={(event) => setReason(event.target.value)}>
        <option value="">Reason…</option>{vocabulary.cancelReasons.map((code) => <option key={code} value={code}>{growthCodeLabel(code)}</option>)}
      </select></label>
      <button type="button" className="pilot-btn" disabled={!reason || busy} onClick={() => void close(() => cancelGrowthFollowUp(token, item.id, { reasonCode: reason }, cancel.current()), cancel)}>Cancel follow-up</button>
    </span> : null}
  </div>;
}

function ActivityList({ items, token, showLead, onChanged }: {
  readonly items: readonly GrowthActivityDto[]; readonly token: string; readonly showLead: boolean; readonly onChanged: () => void;
}): React.ReactElement {
  const [error, setError] = useState('');
  return <div className="v2-list">
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {items.map((item) => (
      <div key={item.id} className="v2-list-row" aria-label={`${kindLabels[item.kind] ?? item.kind} ${item.leadName}`}>
        <span className="v2-tile teal" aria-hidden="true">{kindIcons[item.kind] ?? '•'}</span>
        <div className="grow">
          <strong>{kindLabels[item.kind] ?? item.kind}{item.outcome ? ` · ${growthCodeLabel(item.outcome)}` : ''}{showLead ? ` · ${item.leadName}` : ''}</strong>
          <small>{when(item.occurredAt)} (as reported) · received {when(item.receivedAt)} · {item.author.isMe ? 'you' : item.author.email}
            {item.contact ? ` · met ${item.contact.fullName ?? 'an erased contact'} (${growthCodeLabel(item.contact.role)})` : ''}</small>
          {item.notes ? <p>{item.notes}</p> : item.notesErased ? <p className="v2-empty">Notes erased after 24 months.</p> : null}
          {'location' in item ? (item.location
            ? <small>Location attached, about 100 m: {item.location.latitude.toFixed(3)}, {item.location.longitude.toFixed(3)} (±{item.location.accuracyM} m). Only {item.author.isMe ? 'you and your manager' : 'the author and you, their manager,'} can see this; it is erased 180 days after the visit.</small>
            : item.locationRemoved ? <small>Location removed ({growthCodeLabel(item.locationRemoved.reasonCode)}).</small>
              : item.kind === 'VISIT' || item.kind === 'MEETING' ? <small>No location attached.</small> : null) : null}
        </div>
        {item.location && item.author.isMe ? <button type="button" className="pilot-btn" onClick={() => void removeGrowthActivityLocation(token, item.id)
          .then(() => { setError(''); onChanged(); }).catch((cause: unknown) => setError(fieldError(cause, 'The location could not be removed.')))}>Remove location</button> : null}
      </div>
    ))}
  </div>;
}

/** The field work on one lead: log an activity, add a follow-up, and the lead's history of both. */
export function LeadFieldPanel({ leadId, token, contacts }: {
  readonly leadId: string; readonly token: string; readonly contacts: readonly GrowthLeadContactDto[];
}): React.ReactElement {
  const [field, setField] = useState<GrowthLeadFieldDto | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getGrowthLeadField(token, leadId, controller.signal)
      .then((result) => { setField(result); setError(''); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(fieldError(cause, 'Field work on this lead could not be loaded.')); });
    return () => controller.abort();
  }, [leadId, token, reload]);

  const activities = field?.activities ?? [];
  const followUps = field?.followUps ?? [];
  const changed = (message: string) => { setStatus(message); setReload((value) => value + 1); };
  return <div aria-label="Field work">
    <h3>Field work</h3>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {status ? <p role="status">{status}</p> : null}
    {field?.canLog && field.vocabulary ? <>
      <LogActivityForm leadId={leadId} token={token} vocabulary={field.vocabulary} contacts={contacts} onLogged={() => changed('Logged.')} />
      <AddFollowUpForm leadId={leadId} token={token} vocabulary={field.vocabulary} onAdded={() => changed('Follow-up added.')} />
    </> : field ? <p className="v2-empty">Work on this lead is logged by its owner or their manager, while it is open and may be contacted.</p> : null}
    <h4>Follow-ups</h4>
    {followUps.length && field?.vocabulary ? <div className="v2-list">{followUps.map((item) => (
      <FollowUpRow key={item.id} item={item} token={token} vocabulary={field.vocabulary} showAssignee showLead={false} onChanged={() => changed('Follow-up updated.')} />
    ))}</div> : <p className="v2-empty">{field ? 'No follow-ups on this lead.' : NA}</p>}
    <h4>Activity</h4>
    {activities.length ? <ActivityList items={activities} token={token} showLead={false} onChanged={() => changed('Location removed.')} />
      : <p className="v2-empty">{field ? 'No visits, calls, meetings or notes logged yet.' : NA}</p>}
  </div>;
}

function nowLocal(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function LogActivityForm({ leadId, token, vocabulary, contacts, onLogged }: {
  readonly leadId: string; readonly token: string; readonly vocabulary: GrowthFieldVocabularyDto; readonly contacts: readonly GrowthLeadContactDto[];
  readonly onLogged: () => void;
}): React.ReactElement {
  const empty = { kind: 'VISIT' as GrowthActivityKindDto, outcome: '', contactId: '', notes: '', occurredAt: nowLocal() };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useWriteKey();
  const needsOutcome = form.kind !== 'NOTE';
  const ready = (!needsOutcome || form.outcome) && (form.kind !== 'NOTE' || form.notes.trim()) && form.occurredAt;
  return <fieldset aria-label="Log field work"><legend>Log a visit, call, meeting or note</legend>
    <div className="role-actions">
      <label>Kind<select aria-label="Activity kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as GrowthActivityKindDto, outcome: '' })}>
        {vocabulary.kinds.map((value) => <option key={value} value={value}>{kindLabels[value] ?? value}</option>)}
      </select></label>
      {needsOutcome ? <label>Outcome<select aria-label="Activity outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: event.target.value })}>
        <option value="">Choose…</option>{vocabulary.outcomes.map((value) => <option key={value} value={value}>{growthCodeLabel(value)}</option>)}
      </select></label> : null}
      <label>Who was met<select aria-label="Contact met" value={form.contactId} onChange={(event) => setForm({ ...form, contactId: event.target.value })}>
        <option value="">Nobody named</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.fullName} ({growthCodeLabel(contact.role)})</option>)}
      </select></label>
      <label>When<input aria-label="When it happened" type="datetime-local" value={form.occurredAt} onChange={(event) => setForm({ ...form, occurredAt: event.target.value })} /></label>
      <label>Notes<textarea aria-label="Activity notes" value={form.notes} maxLength={vocabulary.notesMax} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      <button type="button" className="pilot-btn" disabled={!ready || busy} onClick={() => void (async () => {
        setBusy(true);
        try {
          await logGrowthActivity(token, leadId, {
            kind: form.kind, outcome: needsOutcome ? form.outcome : null, contactId: form.contactId || null,
            notes: form.notes.trim() || null, occurredAt: new Date(form.occurredAt).toISOString(),
          }, key.current());
          key.renew();
          setForm({ ...empty, occurredAt: nowLocal() });
          setError('');
          onLogged();
        } catch (cause) {
          setError(fieldError(cause, 'The work could not be logged.'));
        } finally {
          setBusy(false);
        }
      })()}>Log it</button>
    </div>
    <small>Notes are about the organisation. Do not write personal details about anyone (health, family, opinions of the person). Work older than {vocabulary.reportMaxAgeDays} days cannot be logged. A location can be attached to a visit from the ONE app on your phone.</small>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </fieldset>;
}

function AddFollowUpForm({ leadId, token, vocabulary, onAdded }: {
  readonly leadId: string; readonly token: string; readonly vocabulary: GrowthFieldVocabularyDto; readonly onAdded: () => void;
}): React.ReactElement {
  const [form, setForm] = useState({ title: '', dueOn: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useWriteKey();
  return <fieldset aria-label="Add a follow-up"><legend>Add a follow-up</legend>
    <div className="role-actions">
      <label>What next<input aria-label="Follow-up" value={form.title} maxLength={vocabulary.titleMax} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
      <label>Due<input aria-label="Due date" type="date" value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} /></label>
      <button type="button" className="pilot-btn" disabled={!form.title.trim() || !form.dueOn || busy} onClick={() => void (async () => {
        setBusy(true);
        try {
          await addGrowthFollowUp(token, leadId, { title: form.title.trim(), dueOn: form.dueOn }, key.current());
          key.renew();
          setForm({ title: '', dueOn: '' });
          setError('');
          onAdded();
        } catch (cause) {
          setError(fieldError(cause, 'The follow-up could not be added.'));
        } finally {
          setBusy(false);
        }
      })()}>Add follow-up</button>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </fieldset>;
}
