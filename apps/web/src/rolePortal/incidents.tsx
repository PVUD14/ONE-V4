/**
 * ONE · Role portal — Operations Security: incident register and breach clocks (OPS-16).
 *
 * Lives under the existing Security label (Appendix 1 §4.2), below the privacy console. An operator
 * with Incident Manage declares an incident, works it through its states, names the colleges and
 * employers it affects, keeps its timeline, and — for a personal data breach — sees the clock to
 * the Board reporting deadline and records when a person reported to the Board and told the
 * affected people. The clock, its status and every time come from the server's database clock; the
 * 72-hour period is shown as the plan's, pending legal confirmation. Nothing here contacts the
 * Board or anyone outside ONE. Status notices to college admins are drafted and sent from
 * Settings; this screen shows who was notified and when.
 */
import { useEffect, useRef, useState } from 'react';
import {
  addIncidentNote,
  addIncidentOrganization,
  ApiRequestError,
  changeIncidentCategory,
  changeIncidentSeverity,
  declareIncident,
  getIncident,
  getIncidentPolicy,
  getProtectedAccessToken,
  listIncidents,
  recordIncidentBoardNotification,
  recordIncidentUsersNotification,
  removeIncidentOrganization,
  searchIncidentOrganizations,
  transitionIncident,
} from '../api.js';
import type { BreachClockDto, IncidentDetailDto, IncidentDto, IncidentListDto, IncidentPolicyDto, IncidentState } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';

type Tone = 'success' | 'warning' | 'neutral' | 'info' | 'danger';

const label = (value: string): string => value.split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');
const textGuidance = 'No names, email addresses or phone numbers: describe what happened, not who it happened to.';

const stateTone = (state: string): Tone => (state === 'CLOSED' || state === 'RESOLVED' ? 'success' : state === 'CONTAINED' ? 'info' : 'warning');
const severityTone = (severity: string): Tone => (severity === 'CRITICAL' ? 'danger' : severity === 'HIGH' ? 'warning' : severity === 'MEDIUM' ? 'info' : 'neutral');
const clockTone = (status: BreachClockDto['status']): Tone => (status === 'OVERDUE' ? 'danger' : status === 'RUNNING' ? 'warning' : status === 'MET_LATE' ? 'info' : 'success');
const clockLabel: Readonly<Record<BreachClockDto['status'], string>> = {
  RUNNING: 'Clock running', OVERDUE: 'Deadline passed — Board not yet notified', MET: 'Board notified in time', MET_LATE: 'Board notified after the deadline',
};

/** "41 h 12 min left" from seconds the server computed. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return 'NA';
  if (seconds <= 0) return 'Deadline passed';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours} h ${minutes} min left`;
}

/** A datetime-local value (the operator's local time) as an ISO instant, or '' when empty/invalid. */
function toIso(local: string): string {
  if (!local) return '';
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

const views = [
  { value: 'ACTIVE', label: 'Active (not closed)' },
  { value: 'OPEN', label: 'Open' },
  { value: 'CONTAINED', label: 'Contained' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'ALL', label: 'All' },
] as const;

export function OperationsIncidentRegisterPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [policy, setPolicy] = useState<IncidentPolicyDto | null>(null);
  const [view, setView] = useState<string>('ACTIVE');
  const [list, setList] = useState<IncidentListDto | null>(null);
  const [more, setMore] = useState<readonly IncidentDto[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [notice, setNotice] = useState('');
  const [declaring, setDeclaring] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getIncidentPolicy(token, controller.signal).then(setPolicy).catch(() => undefined);
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    listIncidents(token, { view }, null, controller.signal)
      .then((result) => { setList(result); setMore([]); setMoreCursor(null); setError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the incident register.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, view, reload]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Security</span><h1>Incident register</h1>
    <p>Declare an incident the moment there is reasonable suspicion, keep its timeline, and name the organisations it affects. For a personal data breach the register shows the clock to the Board reporting deadline and records who reported to the Board and told the affected people, and when. ONE never contacts the Board itself.</p></div>
    {policy && !forbiddenReference ? <button type="button" className="pilot-btn" onClick={() => setDeclaring(true)}>Declare incident</button> : null}</div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted" note="The incident register is for staff who hold Incident Manage. Your access has not changed." hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }

  const incidents = [...(list?.incidents ?? []), ...more];
  const nextCursor = more.length ? moreCursor : list?.nextCursor ?? null;
  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await listIncidents(token, { view }, nextCursor);
      setMoreCursor(page.nextCursor);
      setMore((current) => [...current, ...page.incidents]);
    } catch (cause) {
      setError(formatApiError(cause, 'Unable to load more incidents.'));
    }
  };

  return <section className="role-module role-module--dense" aria-label="Incident register">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🚨" tone="amber" value={list?.summary ? list.summary.open : 'NA'} label="Open incidents" />
      <V2Stat icon="🛡️" tone="purple" value={list?.summary ? list.summary.openBreaches : 'NA'} label="Open personal data breaches" />
      <V2Stat icon="⏱️" tone="blue" value={list?.summary ? list.summary.breachClocksRunning : 'NA'} label="Breach clocks running" />
      <V2Stat icon="⏰" tone="teal" value={list?.summary ? list.summary.breachClocksOverdue : 'NA'} label="Past the Board deadline, not reported" />
    </div>
    {policy?.breachClock ? <p className="role-wide"><small>{policy.breachClock.basisText}</small></p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <section className="role-card role-wide"><h2>Incidents</h2>
      <div className="role-actions">
        <label className="role-local-search"><span>Show</span>
          <select aria-label="Incident view" value={view} onChange={(event) => setView(event.target.value)}>
            {views.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
      </div>
      {loading && !list ? <p>Loading incidents…</p> : null}
      {!loading && list && !incidents.length ? <V2EmptyState icon="✅" title="No incidents here" note="No incident matches this view." /> : null}
      {incidents.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Incident</th><th>Title</th><th>Category</th><th>Severity</th><th>State</th><th>Board deadline</th><th>Affected organisations</th><th>Actions</th></tr></thead>
        <tbody>{incidents.map((item) => <tr key={item.id}>
          <td><strong>{item.reference}</strong><br /><small>Detected {when(item.detectedAt)}</small></td>
          <td>{item.title}</td>
          <td>{label(item.category)}</td>
          <td><StatusBadge label={label(item.severity)} tone={severityTone(item.severity)} /></td>
          <td><StatusBadge label={label(item.state)} tone={stateTone(item.state)} /></td>
          <td>{item.breachClock
            ? <><StatusBadge label={clockLabel[item.breachClock.status]} tone={clockTone(item.breachClock.status)} /><br /><small>{when(item.breachClock.deadlineAt)} · {formatRemaining(item.breachClock.remainingSeconds)}</small></>
            : 'NA'}</td>
          <td>{item.affectedOrganizationsCount}</td>
          <td><button type="button" className="secondary" onClick={() => setSelectedId(item.id)}>Open {item.reference}</button></td>
        </tr>)}</tbody></table></div> : null}
      {nextCursor ? <button type="button" className="secondary" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
    {selectedId && policy ? <IncidentPanel token={token} incidentId={selectedId} policy={policy} onChanged={() => setReload((value) => value + 1)} onClose={() => setSelectedId('')} /> : null}
    {declaring && policy ? <DeclareIncidentDialog token={token} policy={policy} onCancel={() => setDeclaring(false)}
      onDeclared={(created) => { setDeclaring(false); setNotice(`Incident ${created.reference} declared.`); setSelectedId(created.id); setReload((value) => value + 1); }} /> : null}
  </section>;
}

type PanelAction =
  | { readonly kind: 'transition'; readonly toState: IncidentState }
  | { readonly kind: 'severity' } | { readonly kind: 'category' } | { readonly kind: 'board' } | { readonly kind: 'users' }
  | { readonly kind: 'addOrganization' } | { readonly kind: 'removeOrganization'; readonly organizationId: string; readonly name: string };

function IncidentPanel({ token, incidentId, policy, onChanged, onClose }: {
  readonly token: string; readonly incidentId: string; readonly policy: IncidentPolicyDto; readonly onChanged: () => void; readonly onClose: () => void;
}): React.ReactElement {
  const [detail, setDetail] = useState<IncidentDetailDto | null>(null);
  const [error, setError] = useState('');
  const [action, setAction] = useState<PanelAction | null>(null);
  const [note, setNote] = useState({ note: '', reasonCode: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    getIncident(token, incidentId, controller.signal)
      .then((result) => { setDetail(result); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this incident.')); });
    return () => controller.abort();
  }, [token, incidentId]);

  const apply = (updated: IncidentDetailDto): void => { setDetail(updated); setAction(null); setError(''); onChanged(); };

  if (!detail) {
    return <section className="role-card role-wide" aria-label="Incident"><h2>Incident</h2>
      {error ? <p className="form-error" role="alert">{error}</p> : <p>Loading incident…</p>}
      <button type="button" className="secondary" onClick={onClose}>Close</button></section>;
  }
  const item = detail.incident;
  const closed = item.state === 'CLOSED';
  const clock = item.breachClock;

  const submitNote = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!note.reasonCode || !note.note.trim()) { setError('Choose a reason code and write the note.'); return; }
    setBusy(true);
    try {
      apply(await addIncidentNote(token, item.id, { note: note.note.trim(), reasonCode: note.reasonCode }));
      setNote({ note: '', reasonCode: '' });
    } catch (cause) {
      setError(formatApiError(cause, 'The note could not be added.'));
    } finally { setBusy(false); }
  };

  return <section className="role-card role-wide" aria-label={`Incident ${item.reference}`}>
    <div className="role-section-title"><h2>{item.reference}: {item.title}</h2><button type="button" className="secondary" onClick={onClose}>Close incident view</button></div>
    <dl>
      <div><dt>Summary</dt><dd>{item.summary}</dd></div>
      <div><dt>State</dt><dd><StatusBadge label={label(item.state)} tone={stateTone(item.state)} /></dd></div>
      <div><dt>Category · severity</dt><dd>{label(item.category)} · <StatusBadge label={label(item.severity)} tone={severityTone(item.severity)} /></dd></div>
      <div><dt>Detected · declared</dt><dd>{when(item.detectedAt)} · {when(item.declaredAt)} by {item.declaredBy}</dd></div>
      <div><dt>Contained · resolved · closed</dt><dd>{when(item.containedAt)} · {when(item.resolvedAt)} · {when(item.closedAt)}</dd></div>
      <div><dt>Affected organisations</dt><dd>{item.affectedOrganizationsCount}</dd></div>
    </dl>
    {clock ? <section aria-label="Breach clock" className="v2-card">
      <h3>Board reporting clock</h3>
      <p><StatusBadge label={clockLabel[clock.status]} tone={clockTone(clock.status)} /> Deadline {when(clock.deadlineAt)} — {clock.hours} hours from detection. {clock.status === 'RUNNING' || clock.status === 'OVERDUE' ? formatRemaining(clock.remainingSeconds) : null}</p>
      <p><small>{policy.breachClock.basisText}</small></p>
      <dl>
        <div><dt>Data Protection Board</dt><dd>{clock.boardNotifiedAt ? `Reported ${when(clock.boardNotifiedAt)}, recorded by ${clock.boardNotifiedBy ?? 'NA'}${clock.boardReference ? ` · reference ${clock.boardReference}` : ''}` : 'Not yet reported'}</dd></div>
        <div><dt>Affected people</dt><dd>{clock.usersNotifiedAt ? `Told ${when(clock.usersNotifiedAt)}, recorded by ${clock.usersNotifiedBy ?? 'NA'}` : 'Not yet told'}</dd></div>
      </dl>
      {!closed ? <div className="role-actions">
        {!clock.boardNotifiedAt ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'board' })}>Record Board report…</button> : null}
        {!clock.usersNotifiedAt ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'users' })}>Record affected people told…</button> : null}
      </div> : null}
    </section> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!closed ? <div className="role-actions">
      {detail.allowedTransitions.map((state) => <button key={state} type="button" className="secondary" onClick={() => setAction({ kind: 'transition', toState: state })}>
        {state === 'OPEN' ? 'Reopen…' : `Move to ${label(state)}…`}</button>)}
      <button type="button" className="secondary" onClick={() => setAction({ kind: 'severity' })}>Change severity…</button>
      <button type="button" className="secondary" onClick={() => setAction({ kind: 'category' })}>Reclassify…</button>
    </div> : <p>This incident is closed.</p>}

    <h3>Affected organisations</h3>
    {detail.organizations.length ? <ul className="role-check-list">{detail.organizations.map((org) => <li key={`${org.organizationId}-${org.addedAt}`}>
      <strong>{org.name}</strong> ({label(org.kind)}) — added {when(org.addedAt)}{org.removedAt ? `, removed ${when(org.removedAt)}` : ''}
      {!org.removedAt && !closed ? <> <button type="button" className="secondary" onClick={() => setAction({ kind: 'removeOrganization', organizationId: org.organizationId, name: org.name })}>Remove…</button></> : null}
    </li>)}</ul> : <p>None named yet. A status notice needs at least one.</p>}
    {!closed ? <button type="button" className="secondary" onClick={() => setAction({ kind: 'addOrganization' })}>Add an affected organisation…</button> : null}

    <h3>Status notices</h3>
    {detail.notices.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Notice</th><th>State</th><th>Approved</th><th>Sent</th><th>Reached</th><th>Email</th></tr></thead>
      <tbody>{detail.notices.map((notice) => <tr key={notice.id}>
        <td>{notice.subject}<br /><small>{notice.templateKey} v{notice.templateVersion}</small></td>
        <td><StatusBadge label={label(notice.state)} tone={notice.state === 'SENT' ? 'success' : notice.state === 'WITHDRAWN' ? 'neutral' : 'warning'} /></td>
        <td>{notice.approvedAt ? `${when(notice.approvedAt)} by ${notice.approvedBy ?? 'NA'}${notice.approveMode === 'SOLO' ? ' (solo)' : ''}` : 'NA'}</td>
        <td>{when(notice.sentAt)}</td>
        <td>{notice.recipientCount === null ? 'NA' : `${notice.recipientCount} admins in ${notice.organizationCount ?? 0} organisations`}</td>
        <td>{notice.state === 'SENT' ? emailSummary(notice.email) : 'NA'}</td>
      </tr>)}</tbody></table></div> : <p>No status notice for this incident yet. Notices are drafted and sent from Settings → Status communications.</p>}

    <h3>Timeline</h3>
    <ol className="role-check-list">{detail.timeline.map((entry, index) => <li key={`${entry.occurredAt}-${index}`}>
      <strong>{describeEntry(entry)}</strong> — {entry.actor}, {when(entry.occurredAt)} · {entry.reasonCode}
      {entry.note ? <><br />{entry.note}</> : null}
    </li>)}</ol>
    {!closed ? <form onSubmit={(event) => void submitNote(event)} noValidate aria-label="Add to the timeline">
      <h3>Add to the timeline</h3>
      <label><span>Reason code <em>required</em></span>
        <select value={note.reasonCode} onChange={(event) => setNote({ ...note, reasonCode: event.target.value })}>
          <option value="">Choose a reason…</option>
          {policy.reasons.note.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
        </select></label>
      <label><span>Note (500 characters). {textGuidance}</span>
        <textarea value={note.note} maxLength={500} onChange={(event) => setNote({ ...note, note: event.target.value })} /></label>
      <button type="submit" disabled={busy || !note.reasonCode || !note.note.trim()}>Add note</button>
    </form> : null}

    {action ? <IncidentActionDialog token={token} detail={detail} policy={policy} action={action} onCancel={() => setAction(null)} onDone={apply} /> : null}
  </section>;
}

export function emailSummary(email: IncidentDetailDto['notices'][number]['email']): string {
  const parts = [
    email.sent ? `${email.sent} sent` : '', email.pending ? `${email.pending} pending` : '',
    email.notConfigured ? `${email.notConfigured} not sent — no mail service configured` : '',
    email.failed ? `${email.failed} failed` : '', email.bounced ? `${email.bounced} bounced` : '', email.skipped ? `${email.skipped} skipped (email turned off)` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'None';
}

function describeEntry(entry: IncidentDetailDto['timeline'][number]): string {
  switch (entry.kind) {
    case 'DECLARED': return 'Declared';
    case 'STATE_CHANGED': return `${label(entry.fromValue ?? 'NA')} → ${label(entry.toValue ?? 'NA')}`;
    case 'SEVERITY_CHANGED': return `Severity ${label(entry.fromValue ?? 'NA')} → ${label(entry.toValue ?? 'NA')}`;
    case 'CATEGORY_CHANGED': return `Reclassified ${label(entry.fromValue ?? 'NA')} → ${label(entry.toValue ?? 'NA')}`;
    case 'NOTE': return 'Note';
    case 'ORGANIZATION_ADDED': return `Affected: ${entry.organizationName ?? 'NA'}`;
    case 'ORGANIZATION_REMOVED': return `No longer affected: ${entry.organizationName ?? 'NA'}`;
    case 'BOARD_NOTIFIED': return 'Board report recorded';
    case 'USERS_NOTIFIED': return 'Affected people told — recorded';
    case 'NOTICE_DRAFTED': return 'Status notice drafted';
    case 'NOTICE_QUEUED': return 'Status notice approved for sending';
    case 'NOTICE_SENT': return 'Status notice sent';
    case 'NOTICE_WITHDRAWN': return 'Status notice withdrawn';
    default: return label(entry.kind);
  }
}

/** Every write opens this dialog: it collects the reason code (required) and any field the action needs. */
function IncidentActionDialog({ token, detail, policy, action, onCancel, onDone }: {
  readonly token: string; readonly detail: IncidentDetailDto; readonly policy: IncidentPolicyDto; readonly action: PanelAction;
  readonly onCancel: () => void; readonly onDone: (updated: IncidentDetailDto) => void;
}): React.ReactElement {
  const item = detail.incident;
  const [reasonCode, setReasonCode] = useState('');
  const [value, setValue] = useState('');
  const [at, setAt] = useState('');
  const [reference, setReference] = useState('');
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<readonly { readonly id: string; readonly name: string; readonly kind: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);

  const reasons: readonly string[] = (() => {
    switch (action.kind) {
      case 'transition': return item.state === 'OPEN' && action.toState === 'CLOSED' ? policy.reasons.closeFromOpen : policy.reasons.transition[action.toState] ?? [];
      case 'severity': return policy.reasons.severity;
      case 'category': return policy.reasons.category;
      case 'board': return policy.reasons.boardNotified;
      case 'users': return policy.reasons.usersNotified;
      case 'addOrganization': return policy.reasons.organizationAdd;
      case 'removeOrganization': return policy.reasons.organizationRemove;
    }
  })();
  const title = (() => {
    switch (action.kind) {
      case 'transition': return action.toState === 'OPEN' ? `Reopen ${item.reference}` : `Move ${item.reference} to ${label(action.toState)}`;
      case 'severity': return `Change the severity of ${item.reference}`;
      case 'category': return `Reclassify ${item.reference}`;
      case 'board': return `Record the Board report for ${item.reference}`;
      case 'users': return `Record that the affected people were told about ${item.reference}`;
      case 'addOrganization': return `Add an affected organisation to ${item.reference}`;
      case 'removeOrganization': return `Remove ${action.name} from ${item.reference}`;
    }
  })();
  const needsValue = action.kind === 'severity' || action.kind === 'category' || action.kind === 'addOrganization';
  const needsTime = action.kind === 'board' || action.kind === 'users';
  const ready = Boolean(reasonCode) && (!needsValue || Boolean(value)) && (!needsTime || Boolean(toIso(at)));

  const search = async (): Promise<void> => {
    if (query.trim().length < 2) { setError('Type at least 2 characters of the organisation name.'); return; }
    try {
      setOptions((await searchIncidentOrganizations(token, query.trim())).organizations);
      setError('');
    } catch (cause) {
      setError(formatApiError(cause, 'Unable to search organisations.'));
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) { setError('Choose a reason code and fill in every required field.'); return; }
    setBusy(true);
    try {
      switch (action.kind) {
        case 'transition': onDone(await transitionIncident(token, item.id, { toState: action.toState, reasonCode, ...(value.trim() ? { note: value.trim() } : {}) })); break;
        case 'severity': onDone(await changeIncidentSeverity(token, item.id, { severity: value, reasonCode })); break;
        case 'category': onDone(await changeIncidentCategory(token, item.id, { category: value, reasonCode })); break;
        case 'board': onDone(await recordIncidentBoardNotification(token, item.id, { notifiedAt: toIso(at), reasonCode, ...(reference.trim() ? { reference: reference.trim() } : {}) })); break;
        case 'users': onDone(await recordIncidentUsersNotification(token, item.id, { notifiedAt: toIso(at), reasonCode })); break;
        case 'addOrganization': onDone(await addIncidentOrganization(token, item.id, { organizationId: value, reasonCode })); break;
        case 'removeOrganization': onDone(await removeIncidentOrganization(token, item.id, action.organizationId, { reasonCode })); break;
      }
    } catch (cause) {
      setError(formatApiError(cause, 'The change could not be saved.'));
      setBusy(false);
    }
  };

  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="incident-action-title">
      <h2 id="incident-action-title">{title}</h2>
      <dl><div><dt>Approval</dt><dd>Not required: this is recorded in the incident timeline and the audit log with your reason.</dd></div>
        {needsTime ? <div><dt>What this records</dt><dd>That a person already did this outside ONE. ONE sends nothing to the Board or to the affected people.</dd></div> : null}</dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {action.kind === 'severity' ? <label><span>New severity <em>required</em></span>
          <select value={value} onChange={(event) => setValue(event.target.value)}>
            <option value="">Choose…</option>
            {policy.severities.filter((severity) => severity !== item.severity).map((severity) => <option key={severity} value={severity}>{label(severity)}</option>)}
          </select></label> : null}
        {action.kind === 'category' ? <label><span>New category <em>required</em></span>
          <select value={value} onChange={(event) => setValue(event.target.value)}>
            <option value="">Choose…</option>
            {policy.categories.filter((category) => category !== item.category).map((category) => <option key={category} value={category}>{label(category)}</option>)}
          </select></label> : null}
        {action.kind === 'transition' ? <label><span>Note (optional, 500 characters). {textGuidance}</span>
          <textarea value={value} maxLength={500} onChange={(event) => setValue(event.target.value)} /></label> : null}
        {needsTime ? <label><span>When it happened <em>required</em></span>
          <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} /></label> : null}
        {action.kind === 'board' ? <label><span>Acknowledgement reference (optional)</span>
          <input value={reference} maxLength={64} onChange={(event) => setReference(event.target.value)} /></label> : null}
        {action.kind === 'addOrganization' ? <>
          <label><span>Search colleges and employers by name</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="button" className="secondary" onClick={() => void search()}>Search</button>
          {options.length ? <label><span>Organisation <em>required</em></span>
            <select value={value} onChange={(event) => setValue(event.target.value)}>
              <option value="">Choose…</option>
              {options.map((option) => <option key={option.id} value={option.id}>{option.name} ({label(option.kind)})</option>)}
            </select></label> : null}
        </> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </section>
  </div>;
}

function DeclareIncidentDialog({ token, policy, onCancel, onDeclared }: {
  readonly token: string; readonly policy: IncidentPolicyDto; readonly onCancel: () => void; readonly onDeclared: (created: IncidentDto) => void;
}): React.ReactElement {
  const [form, setForm] = useState({ title: '', summary: '', category: '', severity: '', detectedAt: '', reasonCode: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const ready = Boolean(form.title.trim().length >= 3 && form.summary.trim().length >= 3 && form.category && form.severity && toIso(form.detectedAt) && form.reasonCode);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) { setError('Fill in every field, including when the incident was detected and a reason code.'); return; }
    setBusy(true);
    try {
      const result = await declareIncident(token, {
        title: form.title.trim(), summary: form.summary.trim(), category: form.category, severity: form.severity, detectedAt: toIso(form.detectedAt), reasonCode: form.reasonCode,
      });
      onDeclared(result.incident);
    } catch (cause) {
      setError(formatApiError(cause, 'The incident could not be declared.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="incident-declare-title">
      <h2 id="incident-declare-title">Declare an incident</h2>
      <p>{textGuidance}</p>
      {form.category === 'PERSONAL_DATA_BREACH' ? <p><StatusBadge label={`${policy.breachClock.hours}-hour Board clock`} tone="warning" /> {policy.breachClock.basisText}</p> : null}
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Title (120 characters) <em>required</em></span>
          <input ref={firstFieldRef} value={form.title} maxLength={120} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
        <label><span>Summary (1000 characters) <em>required</em></span>
          <textarea value={form.summary} maxLength={1000} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
        <label><span>Category <em>required</em></span>
          <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
            <option value="">Choose…</option>
            {policy.categories.map((category) => <option key={category} value={category}>{label(category)}</option>)}
          </select></label>
        <label><span>Severity <em>required</em></span>
          <select value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value })}>
            <option value="">Choose…</option>
            {policy.severities.map((severity) => <option key={severity} value={severity}>{label(severity)}</option>)}
          </select></label>
        <label><span>Detected at — when there was first reasonable suspicion <em>required</em></span>
          <input type="datetime-local" value={form.detectedAt} onChange={(event) => setForm({ ...form, detectedAt: event.target.value })} /></label>
        <label><span>Reason code <em>required</em></span>
          <select value={form.reasonCode} onChange={(event) => setForm({ ...form, reasonCode: event.target.value })}>
            <option value="">Choose a reason…</option>
            {policy.reasons.declare.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Declaring…' : 'Declare incident'}</button>
        </div>
      </form>
    </section>
  </div>;
}
