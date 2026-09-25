/**
 * ONE · Role portal — Operations Support desk and account lookup (OPS-05).
 *
 * Two screens under existing navigation labels (Appendix 1 §4.2):
 *  - Support → the case desk: a queue with server-side counts, a case with its history,
 *    and the forms to log, move, note and assign a case. Logging a phone call needs
 *    four choices and one line of text.
 *  - Users / User Detail → the account lookup: search by what the caller reads out, see
 *    the account with its contact masked, its memberships, invitations, cases and a
 *    short audit timeline, reveal the full contact only with a reason (audited), and
 *    open a case for the person.
 *
 * The server decides everything: reason codes, transitions and assignees come from its
 * policy, and nothing here shows academic content, documents or assistant conversations.
 */
import { useEffect, useRef, useState } from 'react';
import {
  addSupportCaseNote,
  ApiRequestError,
  assignSupportCase,
  getProtectedAccessToken,
  getSupportAccount,
  getSupportCase,
  getSupportPolicy,
  listSupportCases,
  openSupportCase,
  revealSupportContact,
  searchSupportAccounts,
  transitionSupportCase,
} from '../api.js';
import type {
  SupportAccountDto,
  SupportAccountSummaryDto,
  SupportCaseDetailDto,
  SupportCaseDto,
  SupportCaseQueueDto,
  SupportCaseState,
  SupportPolicyDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError, RestrictedApiState } from './shared.js';

const noteLimit = 2000;
const summaryLimit = 500;

const label = (value: string): string => value.split('_').map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : 'NA');

const stateTone = (state: string): 'success' | 'warning' | 'neutral' | 'info' | 'danger' =>
  state === 'RESOLVED' || state === 'CLOSED' ? 'success' : state === 'WAITING_ON_CUSTOMER' ? 'info' : state === 'OPEN' ? 'warning' : 'neutral';
const severityTone = (severity: string): 'success' | 'warning' | 'neutral' | 'info' | 'danger' =>
  severity === 'URGENT' ? 'danger' : severity === 'HIGH' ? 'warning' : severity === 'MEDIUM' ? 'info' : 'neutral';

function useSupportPolicy(token: string | null): { readonly policy: SupportPolicyDto | null; readonly forbiddenReference: string; readonly error: string } {
  const [policy, setPolicy] = useState<SupportPolicyDto | null>(null);
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getSupportPolicy(token, controller.signal)
      .then((result) => { setPolicy(result); setForbiddenReference(''); setError(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load the support desk policy.'));
      });
    return () => controller.abort();
  }, [token]);
  return { policy, forbiddenReference, error };
}

function Forbidden({ heading, note, reference }: { readonly heading: React.ReactElement; readonly note: string; readonly reference: string }): React.ReactElement {
  return <section className="role-module role-module--dense">{heading}
    <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted" note={note} hint={`Reference: ${reference}`} /></div></section>;
}

// ---------------------------------------------------------------------------
// Support → case desk
// ---------------------------------------------------------------------------

const views = [
  { value: 'ACTIVE', label: 'Active (open, in progress, waiting)' },
  { value: 'OPEN', label: 'Open' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'WAITING_ON_CUSTOMER', label: 'Waiting on customer' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'ALL', label: 'All' },
] as const;

export function OperationsSupportDeskPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const { policy, forbiddenReference: policyForbidden, error: policyError } = useSupportPolicy(token);
  const [filters, setFilters] = useState({ view: 'ACTIVE', severity: '', assignee: '', overdue: false });
  const [queue, setQueue] = useState<SupportCaseQueueDto | null>(null);
  const [more, setMore] = useState<readonly SupportCaseDto[]>([]);
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [notice, setNotice] = useState('');
  const [opening, setOpening] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    listSupportCases(token, { view: filters.view, severity: filters.severity, assignee: filters.assignee, overdue: filters.overdue }, null, controller.signal)
      .then((result) => { setQueue(result); setMore([]); setMoreCursor(null); setError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load support cases.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, filters, reload]);

  if (!token) return <RestrictedApiState title="Support" message="Sign in with an Operations identity to work the support desk." />;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Support</span><h1>Support desk</h1>
    <p>Log every call, email and message as a case, work it to resolution and close it with a record. Contacts are masked; nothing academic, no documents and no assistant conversations appear here.</p></div>
    {policy?.viewer.cases ? <button type="button" className="pilot-btn" onClick={() => setOpening(true)}>New case</button> : null}</div>;

  const reference = forbiddenReference || policyForbidden;
  if (reference) return <Forbidden heading={heading} reference={reference} note="The support desk is for staff who hold Support Cases. Your access has not changed." />;

  const cases = [...(queue?.cases ?? []), ...more];
  const nextCursor = more.length ? moreCursor : queue?.nextCursor ?? null;
  const loadMore = async (): Promise<void> => {
    if (!nextCursor) return;
    try {
      const page = await listSupportCases(token, { view: filters.view, severity: filters.severity, assignee: filters.assignee, overdue: filters.overdue }, nextCursor);
      setMoreCursor(page.nextCursor);
      setMore((current) => [...current, ...page.cases]);
    } catch (cause) {
      setError(formatApiError(cause, 'Unable to load more cases.'));
    }
  };

  return <section className="role-module role-module--dense">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📥" tone="amber" value={queue ? queue.summary.open : 'NA'} label="Open" />
      <V2Stat icon="🛠️" tone="blue" value={queue ? queue.summary.inProgress : 'NA'} label="In progress" />
      <V2Stat icon="⏳" tone="purple" value={queue ? queue.summary.waitingOnCustomer : 'NA'} label="Waiting on customer" />
      <V2Stat icon="⏰" tone="teal" value={queue ? queue.summary.overdue : 'NA'} label="Past SLA target" />
    </div>
    {error || policyError ? <p className="form-error" role="alert">{error || policyError}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <section className="role-card role-wide"><h2>Cases</h2>
      <div className="role-actions">
        <label className="role-local-search"><span>Show</span>
          <select aria-label="Case view" value={filters.view} onChange={(event) => setFilters({ ...filters, view: event.target.value })}>
            {views.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
        <label className="role-local-search"><span>Severity</span>
          <select aria-label="Severity filter" value={filters.severity} onChange={(event) => setFilters({ ...filters, severity: event.target.value })}>
            <option value="">Any</option>
            {(policy?.severities ?? []).map((severity) => <option key={severity} value={severity}>{label(severity)}</option>)}
          </select></label>
        <label className="role-local-search"><span>Assigned</span>
          <select aria-label="Assignee filter" value={filters.assignee} onChange={(event) => setFilters({ ...filters, assignee: event.target.value })}>
            <option value="">Anyone</option><option value="ME">To me</option><option value="UNASSIGNED">Unassigned</option>
          </select></label>
        <label><input type="checkbox" checked={filters.overdue} onChange={(event) => setFilters({ ...filters, overdue: event.target.checked })} /> Past SLA target only</label>
      </div>
      {loading && !queue ? <p>Loading cases…</p> : null}
      {!loading && queue && !cases.length ? <V2EmptyState icon="✅" title="No cases here" note="No support case matches this view." /> : null}
      {cases.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Case</th><th>Summary</th><th>Category</th><th>Severity</th><th>State</th><th>SLA target</th><th>Assigned</th><th>Actions</th></tr></thead>
        <tbody>{cases.map((item) => <tr key={item.id}>
          <td><strong>{item.reference}</strong><br /><small>{label(item.channel)} · {when(item.openedAt)}</small></td>
          <td>{item.summary}{item.organization ? <><br /><small>{item.organization.name}</small></> : null}{item.subject ? <><br /><small>{item.subject.maskedEmail ?? 'NA'}</small></> : null}</td>
          <td>{label(item.category)}</td>
          <td><StatusBadge label={label(item.severity)} tone={severityTone(item.severity)} /></td>
          <td><StatusBadge label={label(item.state)} tone={stateTone(item.state)} /></td>
          <td>{when(item.slaDueAt)}{item.overdue ? <><br /><StatusBadge label="Past target" tone="danger" /></> : null}</td>
          <td>{item.assignee ? `${item.assignee.email}${item.assignee.isSelf ? ' (you)' : ''}` : 'Unassigned'}</td>
          <td><button type="button" className="secondary" onClick={() => setSelectedId(item.id)}>Open {item.reference}</button></td>
        </tr>)}</tbody></table></div> : null}
      {nextCursor ? <button type="button" className="secondary" onClick={() => void loadMore()}>Load more</button> : null}
    </section>
    {selectedId && policy ? <SupportCasePanel token={token} caseId={selectedId} policy={policy} onChanged={() => setReload((value) => value + 1)} onClose={() => setSelectedId('')} /> : null}
    {opening && policy ? <OpenCaseDialog token={token} policy={policy} onCancel={() => setOpening(false)}
      onOpened={(created) => { setOpening(false); setNotice(`Case ${created.reference} logged.`); setSelectedId(created.id); setReload((value) => value + 1); }} /> : null}
  </section>;
}

function SupportCasePanel({ token, caseId, policy, onChanged, onClose }: {
  readonly token: string; readonly caseId: string; readonly policy: SupportPolicyDto; readonly onChanged: () => void; readonly onClose: () => void;
}): React.ReactElement {
  const [item, setItem] = useState<SupportCaseDetailDto | null>(null);
  const [error, setError] = useState('');
  const [moving, setMoving] = useState<SupportCaseState | null>(null);
  const [note, setNote] = useState({ note: '', reasonCode: '', linkedCorrelationId: '' });
  const [assign, setAssign] = useState({ assigneeUserId: '', reasonCode: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setItem(null);
    getSupportCase(token, caseId, controller.signal)
      .then((result) => { setItem(result.case); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this case.')); });
    return () => controller.abort();
  }, [token, caseId]);

  const apply = (updated: SupportCaseDetailDto): void => { setItem(updated); setError(''); onChanged(); };

  const submitNote = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!note.reasonCode || !note.note.trim()) { setError('Choose a reason code and write the note.'); return; }
    setBusy(true);
    try {
      const result = await addSupportCaseNote(token, caseId, { note: note.note.trim(), reasonCode: note.reasonCode, ...(note.linkedCorrelationId.trim() ? { linkedCorrelationId: note.linkedCorrelationId.trim() } : {}) });
      apply(result.case);
      setNote({ note: '', reasonCode: '', linkedCorrelationId: '' });
    } catch (cause) {
      setError(formatApiError(cause, 'The note could not be added.'));
    } finally { setBusy(false); }
  };

  const submitAssign = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!assign.reasonCode) { setError('Choose a reason code for the assignment.'); return; }
    setBusy(true);
    try {
      const result = await assignSupportCase(token, caseId, { assigneeUserId: assign.assigneeUserId || null, reasonCode: assign.reasonCode });
      apply(result.case);
      setAssign({ assigneeUserId: '', reasonCode: '' });
    } catch (cause) {
      setError(formatApiError(cause, 'The case could not be assigned.'));
    } finally { setBusy(false); }
  };

  if (!item) {
    return <section className="role-card role-wide" aria-label="Support case"><h2>Case</h2>
      {error ? <p className="form-error" role="alert">{error}</p> : <p>Loading case…</p>}
      <button type="button" className="secondary" onClick={onClose}>Close</button></section>;
  }

  const closed = item.state === 'CLOSED';
  return <section className="role-card role-wide" aria-label={`Support case ${item.reference}`}>
    <div className="role-section-title"><h2>{item.reference}</h2><button type="button" className="secondary" onClick={onClose}>Close case view</button></div>
    <dl>
      <div><dt>Summary</dt><dd>{item.summaryRedacted ? <em>{item.summary}</em> : item.summary}</dd></div>
      <div><dt>State</dt><dd><StatusBadge label={label(item.state)} tone={stateTone(item.state)} /></dd></div>
      <div><dt>Severity</dt><dd><StatusBadge label={label(item.severity)} tone={severityTone(item.severity)} /> · SLA target {when(item.slaDueAt)}{item.overdue ? ' (past target)' : ''}</dd></div>
      <div><dt>Channel · category</dt><dd>{label(item.channel)} · {label(item.category)}</dd></div>
      <div><dt>Organisation</dt><dd>{item.organization?.name ?? 'NA'}</dd></div>
      <div><dt>Person</dt><dd>{item.subjectDetached ? 'Removed on privacy deletion' : item.subject ? item.subject.maskedEmail ?? 'NA' : 'None linked'}</dd></div>
      <div><dt>Assigned</dt><dd>{item.assignee ? `${item.assignee.email}${item.assignee.isSelf ? ' (you)' : ''}` : 'Unassigned'}</dd></div>
      <div><dt>Opened</dt><dd>{when(item.openedAt)} by {item.openedBy.email}</dd></div>
      <div><dt>Resolved · closed</dt><dd>{when(item.resolvedAt)} · {when(item.closedAt)}</dd></div>
    </dl>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {item.allowedTransitions.length ? <div className="role-actions">{item.allowedTransitions.map((state) =>
      <button key={state} type="button" className="secondary" onClick={() => setMoving(state)}>Move to {label(state)}…</button>)}</div> : <p>This case is closed.</p>}
    <h3>History</h3>
    <ol className="role-check-list">{item.events.map((event) => <li key={event.id}>
      <strong>{describeEvent(event)}</strong> — {event.actor.email}, {when(event.occurredAt)} · {event.reasonCode}
      {event.noteRedacted ? <><br /><em>Note removed on privacy deletion.</em></> : event.note ? <><br />{event.note}</> : null}
      {event.linkedCorrelationId ? <><br /><small>Linked reference: {event.linkedCorrelationId}</small></> : null}
    </li>)}</ol>
    {!closed ? <form onSubmit={(event) => void submitNote(event)} noValidate aria-label="Add a note">
      <h3>Add a note</h3>
      <label><span>Reason code <em>required</em></span>
        <select value={note.reasonCode} onChange={(event) => setNote({ ...note, reasonCode: event.target.value })}>
          <option value="">Choose a reason…</option>
          {policy.reasons.note.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
        </select></label>
      <label><span>Note ({noteLimit} characters) — only what the case needs</span>
        <textarea value={note.note} maxLength={noteLimit} onChange={(event) => setNote({ ...note, note: event.target.value })} /></label>
      <label><span>Reference from an error screen (optional)</span>
        <input value={note.linkedCorrelationId} onChange={(event) => setNote({ ...note, linkedCorrelationId: event.target.value })} placeholder="The reference the person read out" /></label>
      <button type="submit" disabled={busy || !note.reasonCode || !note.note.trim()}>Add note</button>
    </form> : null}
    {!closed ? <form onSubmit={(event) => void submitAssign(event)} noValidate aria-label="Assign the case">
      <h3>Assign</h3>
      <label><span>Assign to</span>
        <select value={assign.assigneeUserId} onChange={(event) => setAssign({ ...assign, assigneeUserId: event.target.value })}>
          <option value="">Unassigned</option>
          {policy.assignees.map((person) => <option key={person.userId} value={person.userId}>{person.email}{person.isSelf ? ' (you)' : ''}</option>)}
        </select></label>
      <label><span>Reason code <em>required</em></span>
        <select value={assign.reasonCode} onChange={(event) => setAssign({ ...assign, reasonCode: event.target.value })}>
          <option value="">Choose a reason…</option>
          {policy.reasons.assign.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
        </select></label>
      <button type="submit" disabled={busy || !assign.reasonCode}>Save assignment</button>
    </form> : null}
    {moving ? <TransitionDialog token={token} item={item} toState={moving} reasons={policy.reasons.transition[moving] ?? []}
      onCancel={() => setMoving(null)} onDone={(updated) => { setMoving(null); apply(updated); }} /> : null}
  </section>;
}

function describeEvent(event: SupportCaseDetailDto['events'][number]): string {
  switch (event.kind) {
    case 'OPENED': return 'Opened';
    case 'STATE_CHANGED': return `${label(event.fromState ?? 'NA')} → ${label(event.toState ?? 'NA')}`;
    case 'NOTE': return 'Note';
    case 'ASSIGNED': return event.assignee ? `Assigned to ${event.assignee.email}` : 'Unassigned';
  }
}

function TransitionDialog({ token, item, toState, reasons, onCancel, onDone }: {
  readonly token: string; readonly item: SupportCaseDetailDto; readonly toState: SupportCaseState; readonly reasons: readonly string[];
  readonly onCancel: () => void; readonly onDone: (updated: SupportCaseDetailDto) => void;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      const result = await transitionSupportCase(token, item.id, { toState, reasonCode, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone(result.case);
    } catch (cause) {
      setError(formatApiError(cause, 'The case could not be moved.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="support-transition-title">
      <h2 id="support-transition-title">Move {item.reference} to {label(toState)}</h2>
      <dl><div><dt>From</dt><dd>{label(item.state)}</dd></div><div><dt>Approval</dt><dd>Not required: this is a routine support action. It is recorded with your reason.</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <label><span>Note (optional, {noteLimit} characters) — only what the case needs</span>
          <textarea value={note} maxLength={noteLimit} onChange={(event) => setNote(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : `Move to ${label(toState)}`}</button>
        </div>
      </form>
    </section>
  </div>;
}

/** Logging a call: channel, category, severity, one line, a reason. Under a minute. */
export function OpenCaseDialog({ token, policy, subject, onCancel, onOpened }: {
  readonly token: string; readonly policy: SupportPolicyDto;
  readonly subject?: { readonly userId: string; readonly maskedEmail: string | null; readonly organizations: readonly { readonly id: string; readonly name: string }[] };
  readonly onCancel: () => void; readonly onOpened: (created: SupportCaseDetailDto) => void;
}): React.ReactElement {
  const [form, setForm] = useState({ channel: 'PHONE', category: '', severity: 'MEDIUM', summary: '', reasonCode: 'CUSTOMER_CONTACT', organizationId: '', assignToMe: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const ready = Boolean(form.category && form.severity && form.channel && form.reasonCode && form.summary.trim().length >= 3);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) { setError('Choose a category and write a summary of at least 3 characters.'); return; }
    setBusy(true);
    try {
      const result = await openSupportCase(token, {
        channel: form.channel, category: form.category, severity: form.severity, summary: form.summary.trim(), reasonCode: form.reasonCode,
        assignToMe: form.assignToMe, ...(subject ? { subjectUserId: subject.userId } : {}), ...(form.organizationId ? { organizationId: form.organizationId } : {}),
      });
      onOpened(result.case);
    } catch (cause) {
      setError(formatApiError(cause, 'The case could not be logged.'));
      setBusy(false);
    }
  };
  const pick = (key: 'channel' | 'category' | 'severity' | 'reasonCode' | 'organizationId') => (event: React.ChangeEvent<HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="support-open-title">
      <h2 id="support-open-title">Log a support case</h2>
      {subject ? <dl><div><dt>Person</dt><dd>{subject.maskedEmail ?? 'NA'}</dd></div></dl> : null}
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Category <em>required</em></span>
          <select ref={firstFieldRef} value={form.category} onChange={pick('category')}>
            <option value="">Choose a category…</option>
            {policy.categories.map((category) => <option key={category} value={category}>{label(category)}</option>)}
          </select></label>
        <label><span>Severity <em>required</em></span>
          <select value={form.severity} onChange={pick('severity')}>
            {policy.severities.map((severity) => <option key={severity} value={severity}>{label(severity)} — resolve within {policy.slaHours[severity] ?? 'NA'} h</option>)}
          </select></label>
        <label><span>Channel <em>required</em></span>
          <select value={form.channel} onChange={pick('channel')}>
            {policy.channels.map((channel) => <option key={channel} value={channel}>{label(channel)}</option>)}
          </select></label>
        <label><span>Summary <em>required</em> ({summaryLimit} characters) — the problem, not contact details</span>
          <input value={form.summary} maxLength={summaryLimit} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
        {subject?.organizations.length ? <label><span>Organisation</span>
          <select value={form.organizationId} onChange={pick('organizationId')}>
            <option value="">None</option>
            {subject.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select></label> : null}
        <label><span>Reason code <em>required</em></span>
          <select value={form.reasonCode} onChange={pick('reasonCode')}>
            {policy.reasons.open.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <label><input type="checkbox" checked={form.assignToMe} onChange={(event) => setForm({ ...form, assignToMe: event.target.checked })} /> Assign to me</label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !ready}>{busy ? 'Logging…' : 'Log case'}</button>
        </div>
      </form>
    </section>
  </div>;
}

// ---------------------------------------------------------------------------
// Users / User Detail → account lookup
// ---------------------------------------------------------------------------

export function OperationsAccountLookupPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const { policy } = useSupportPolicy(token);
  const [draft, setDraft] = useState('');
  const [results, setResults] = useState<readonly SupportAccountSummaryDto[] | null>(null);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState('');

  if (!token) return <RestrictedApiState title="Users" message="Sign in with an Operations identity to look up accounts." />;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Users</span><h1>Account lookup</h1>
    <p>Find an account from the address or reference a person gives you. Contacts are masked; the full value needs a reason and is recorded. Every lookup is recorded in the audit log.</p></div></div>;

  if (forbiddenReference) return <Forbidden heading={heading} reference={forbiddenReference} note="Account lookup is for staff who hold Support Account Lookup. Your access has not changed." />;

  const search = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (draft.trim().length < 3) { setError('Enter at least 3 characters of an email address, or a full address.'); return; }
    setSearching(true);
    try {
      const result = await searchSupportAccounts(token, draft.trim());
      setResults(result.accounts);
      setSelectedId(result.accounts.length === 1 ? result.accounts[0]!.userId : '');
      setError('');
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
      else setError(formatApiError(cause, 'Unable to search accounts.'));
    } finally { setSearching(false); }
  };

  return <section className="role-module role-module--dense">
    {heading}
    <section className="role-card role-wide">
      <form onSubmit={(event) => void search(event)} noValidate aria-label="Search accounts">
        <label className="role-local-search"><span>Email address, part of one, or account reference</span>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="The address the person gives you" /></label>
        <button type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
      </form>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {results && !results.length ? <V2EmptyState icon="🔎" title="No matching account" note="No ONE account matches this search." /> : null}
      {results?.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Email (masked)</th><th>State</th><th>Sign-in linked</th><th>Memberships</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>{results.map((account) => <tr key={account.userId}>
          <td>{account.maskedEmail ?? 'NA'}{account.deleted ? <><br /><small>Deleted account</small></> : null}</td>
          <td><StatusBadge label={label(account.state)} tone={account.state === 'ACTIVE' ? 'success' : 'neutral'} /></td>
          <td>{account.identityLinked ? 'Yes' : 'No'}</td>
          <td>{account.membershipCount}</td>
          <td>{when(account.createdAt)}</td>
          <td><button type="button" className="secondary" onClick={() => setSelectedId(account.userId)}>View account</button></td>
        </tr>)}</tbody></table></div> : null}
    </section>
    {selectedId ? <SupportAccountPanel token={token} userId={selectedId} policy={policy} /> : null}
  </section>;
}

function SupportAccountPanel({ token, userId, policy }: { readonly token: string; readonly userId: string; readonly policy: SupportPolicyDto | null }): React.ReactElement {
  const [view, setView] = useState<SupportAccountDto | null>(null);
  const [error, setError] = useState('');
  const [revealing, setRevealing] = useState(false);
  const [revealed, setRevealed] = useState<{ readonly email: string; readonly phone: string | null } | null>(null);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setRevealed(null);
    getSupportAccount(token, userId, controller.signal)
      .then((result) => { setView(result); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this account.')); });
    return () => controller.abort();
  }, [token, userId, reload]);

  if (!view) return <section className="role-card role-wide" aria-label="Account">{error ? <p className="form-error" role="alert">{error}</p> : <p>Loading account…</p>}</section>;

  const account = view.account;
  return <>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👤" tone="teal" value={label(account.state)} label="Account state" />
      <V2Stat icon="🏛️" tone="blue" value={view.memberships.length} label="Memberships" />
      <V2Stat icon="✉️" tone="amber" value={view.invitations.filter((invitation) => invitation.state === 'PENDING').length} label="Pending invitations" />
      <V2Stat icon="🎧" tone="purple" value={view.cases.filter((item) => item.state !== 'CLOSED').length} label="Open support cases" />
    </div>
    <section className="role-card role-wide" aria-label="Account summary">
      <div className="role-section-title"><h2>Account</h2>
        <div className="role-actions">
          {!account.deleted ? <button type="button" className="secondary" onClick={() => setRevealing(true)}>Reveal contact…</button> : null}
          {view.canOpenCase && policy?.viewer.cases ? <button type="button" className="pilot-btn" onClick={() => setOpening(true)}>Open case</button> : null}
        </div></div>
      <dl>
        <div><dt>Email</dt><dd>{revealed ? revealed.email : account.maskedEmail ?? 'NA'}{revealed ? ' (revealed, recorded)' : ''}</dd></div>
        <div><dt>Phone</dt><dd>{revealed ? revealed.phone ?? 'NA' : account.maskedPhone ?? 'NA'}</dd></div>
        <div><dt>Sign-in linked</dt><dd>{account.identityLinked ? 'Yes' : 'No'}</dd></div>
        <div><dt>Created</dt><dd>{when(account.createdAt)}</dd></div>
        {account.deleted ? <div><dt>Privacy</dt><dd>This account was deleted at the person&apos;s request.</dd></div> : null}
      </dl>
      {notice ? <p role="status">{notice}</p> : null}
    </section>
    <section className="role-card role-wide"><h2>Memberships</h2>
      {view.memberships.length ? <table className="role-record-table"><thead><tr><th>Organisation</th><th>Kind</th><th>Role</th><th>State</th></tr></thead>
        <tbody>{view.memberships.map((membership, index) => <tr key={`${membership.organizationId}-${membership.role}-${index}`}><td>{membership.organizationName}</td><td>{label(membership.organizationKind)}</td><td>{label(membership.role)}</td><td>{label(membership.state)}</td></tr>)}</tbody></table>
        : <p>No organisation memberships.</p>}
      {view.studentRelationships.length ? <><h3>Student relationships</h3><table className="role-record-table"><thead><tr><th>Institution</th><th>State</th><th>From</th><th>To</th></tr></thead>
        <tbody>{view.studentRelationships.map((relationship, index) => <tr key={index}><td>{relationship.institutionName}</td><td>{label(relationship.state)}</td><td>{when(relationship.effectiveFrom)}</td><td>{when(relationship.effectiveTo)}</td></tr>)}</tbody></table></> : null}
    </section>
    <section className="role-card role-wide"><h2>Invitations</h2>
      {view.invitations.length ? <table className="role-record-table"><thead><tr><th>Organisation</th><th>Kind · role</th><th>State</th><th>Delivery</th><th>Expires</th></tr></thead>
        <tbody>{view.invitations.map((invitation, index) => <tr key={index}><td>{invitation.organizationName ?? 'NA'}</td><td>{label(invitation.kind)}{invitation.role ? ` · ${label(invitation.role)}` : ''}</td><td>{label(invitation.state)}</td><td>{invitation.deliveryState ? label(invitation.deliveryState) : 'NA'}</td><td>{when(invitation.expiresAt)}</td></tr>)}</tbody></table>
        : <p>No invitations.</p>}
    </section>
    <section className="role-card role-wide"><h2>Support cases</h2>
      {view.cases.length ? <ul className="role-check-list">{view.cases.map((item) => <li key={item.id}>{item.reference} · {label(item.category)} · {label(item.state)} · {when(item.openedAt)}</li>)}</ul>
        : <p>No support cases for this person.</p>}
    </section>
    <section className="role-card role-wide"><h2>Recent activity</h2>
      <p>The last 20 audit events by or about this account: what happened, never the content.</p>
      {view.timeline.length ? <table className="role-record-table"><thead><tr><th>When</th><th>Action</th><th>Outcome</th><th>By</th><th>Reference</th></tr></thead>
        <tbody>{view.timeline.map((event, index) => <tr key={`${event.correlationId}-${index}`}><td>{when(event.occurredAt)}</td><td>{event.action}</td><td>{event.outcome}</td><td>{event.byThisUser ? 'This person' : 'Staff or system'}</td><td>{event.correlationId}</td></tr>)}</tbody></table>
        : <p>No audit events for this account.</p>}
    </section>
    {revealing && policy ? <RevealDialog token={token} userId={userId} reasons={policy.reasons.reveal} onCancel={() => setRevealing(false)}
      onRevealed={(contact) => { setRevealing(false); setRevealed(contact); }} /> : null}
    {opening && policy ? <OpenCaseDialog token={token} policy={policy}
      subject={{ userId, maskedEmail: account.maskedEmail, organizations: dedupeOrganizations(view.memberships) }}
      onCancel={() => setOpening(false)}
      onOpened={(created) => { setOpening(false); setNotice(`Case ${created.reference} logged for this account.`); setReload((value) => value + 1); }} /> : null}
  </>;
}

function dedupeOrganizations(memberships: SupportAccountDto['memberships']): readonly { readonly id: string; readonly name: string }[] {
  const seen = new Map<string, string>();
  for (const membership of memberships) if (membership.organizationKind !== 'PLATFORM') seen.set(membership.organizationId, membership.organizationName);
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

function RevealDialog({ token, userId, reasons, onCancel, onRevealed }: {
  readonly token: string; readonly userId: string; readonly reasons: readonly string[];
  readonly onCancel: () => void; readonly onRevealed: (contact: { readonly email: string; readonly phone: string | null }) => void;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      const result = await revealSupportContact(token, userId, { reasonCode });
      onRevealed(result.contact);
    } catch (cause) {
      setError(formatApiError(cause, 'The contact could not be revealed.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="support-reveal-title">
      <h2 id="support-reveal-title">Reveal full contact</h2>
      <dl><div><dt>Record</dt><dd>Revealing the full email and phone is recorded in the audit log with your reason.</dd></div>
        <div><dt>Approval</dt><dd>Not required.</dd></div></dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Revealing…' : 'Reveal'}</button>
        </div>
      </form>
    </section>
  </div>;
}
