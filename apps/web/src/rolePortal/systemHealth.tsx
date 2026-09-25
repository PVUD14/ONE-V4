/**
 * ONE · Role portal — Operations: System Health (OPS-04, Appendix 1 §4.2).
 *
 * The background jobs console: outbox health by state, how long the oldest event has
 * waited, whether the worker is draining (judged only from data), per-consumer
 * activity, the automation workflow registry and command states, breach alerts, the
 * failed-event list with inspect and audited replay, and backlog supersede through the
 * OPS-02 approval flow. The Career Readiness governance panel this label showed before
 * is kept below it.
 *
 * Every number comes from one server-side summary computed in bounded SQL. A source
 * that has no data renders NA in its slot. No event payload, failure text or internal
 * identifier is shown; the reference printed is the correlation ID an operator searches
 * the audit log by.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError, getFailedJob, getJobsHealthSummary, getProtectedAccessToken, listFailedJobs, previewBacklogSupersede, replayFailedJob } from '../api.js';
import type { CappedCountDto, FailedJobDetailDto, FailedJobDto, JobsHealthAlertDto, JobsHealthResponseDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { OperationsCareerReadinessPanel } from '../operationsCareerReadinessPanel.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { formatApiError, RestrictedApiState } from './shared.js';

const NA = 'NA';
const dayMs = 24 * 60 * 60 * 1000;

export function formatCapped(count: CappedCountDto | undefined): string {
  if (!count) return NA;
  return count.capped ? `${count.value.toLocaleString()}+` : count.value.toLocaleString();
}

const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : NA);

const verdictText = {
  DRAINING: { label: 'Draining', tone: 'success', note: 'Events that are due are being delivered within the alert limit.' },
  STALLED: { label: 'Stalled', tone: 'warning', note: 'A due event has waited longer than the alert limit. The worker may be stopped, or the backlog was never superseded.' },
  NO_WORK_WAITING: { label: 'No work waiting', tone: 'neutral', note: 'Nothing is due, so whether the worker is running cannot be judged from data right now.' },
} as const;

const conditionText: Readonly<Record<JobsHealthAlertDto['conditionKey'], string>> = {
  FAILED_EVENTS_THRESHOLD: 'Failed events reached the threshold',
  PENDING_EVENTS_STALLED: 'An event waited past the limit',
  CONSUMER_SILENT: 'A consumer went silent',
};

const ageFilters = [
  { value: '', label: 'Any age' },
  { value: 'DAY', label: 'Last 24 hours' },
  { value: 'WEEK', label: '1 to 7 days' },
  { value: 'OLDER', label: 'Older than 7 days' },
] as const;

function ageRange(age: string): { readonly from?: string; readonly to?: string } {
  const now = Date.now();
  if (age === 'DAY') return { from: new Date(now - dayMs).toISOString() };
  if (age === 'WEEK') return { from: new Date(now - 7 * dayMs).toISOString(), to: new Date(now - dayMs).toISOString() };
  if (age === 'OLDER') return { to: new Date(now - 7 * dayMs).toISOString() };
  return {};
}

function alertLine(alert: JobsHealthAlertDto, consumerLabel: (name: string) => string): string {
  const base = conditionText[alert.conditionKey];
  const subject = alert.subject ? ` (${consumerLabel(alert.subject)})` : '';
  const unit = alert.conditionKey === 'FAILED_EVENTS_THRESHOLD' ? 'events' : 'minutes';
  return `${base}${subject}: ${alert.observedValue} ${unit}, limit ${alert.threshold}`;
}

export function OperationsSystemHealthPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [health, setHealth] = useState<JobsHealthResponseDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  const [eventType, setEventType] = useState('');
  const [age, setAge] = useState('');
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [failed, setFailed] = useState<readonly FailedJobDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failedLoading, setFailedLoading] = useState(true);
  const [failedError, setFailedError] = useState('');
  const [inspected, setInspected] = useState<FailedJobDetailDto | null>(null);
  const [replaying, setReplaying] = useState<FailedJobDto | null>(null);

  const [cutoff, setCutoff] = useState('');
  const [preview, setPreview] = useState<{ readonly olderThan: string; readonly pending: CappedCountDto; readonly limit: number } | null>(null);
  const [supersedeError, setSupersedeError] = useState('');
  const [superseding, setSuperseding] = useState(false);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    getJobsHealthSummary(token, controller.signal)
      .then((result) => { setHealth(result); setError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load background job health.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, reload]);

  const cursor = cursors[cursors.length - 1];
  const range = useMemo(() => ageRange(age), [age]);
  useEffect(() => {
    if (!token || forbiddenReference) return;
    const controller = new AbortController();
    setFailedLoading(true);
    listFailedJobs(token, { ...(eventType ? { eventType } : {}), ...range, ...(cursor ? { cursor } : {}) }, controller.signal)
      .then((result) => { setFailed(result.events); setNextCursor(result.nextCursor); setFailedError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setFailedError(formatApiError(cause, 'Unable to load failed events.')); })
      .finally(() => { if (!controller.signal.aborted) setFailedLoading(false); });
    return () => controller.abort();
  }, [token, eventType, range, cursor, reload, forbiddenReference]);

  if (!token) return <RestrictedApiState title="System Health" message="Sign in with an Operations identity to see background job health." />;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Operations · technology</span><h1>System Health</h1>
    <p>Background jobs: what is waiting, what failed and why, whether the worker is draining, and the automation workflows. Replaying a failed event is audited. Superseding the backlog needs a second person&apos;s approval. Event contents, recipients and credentials are never shown here.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="The background jobs console is for staff who can replay failed events. Your access has not changed."
        hint={`Reference: ${forbiddenReference}`} /></div></section>;
  }

  const summary = health?.summary;
  const consumerLabel = (name: string): string => summary?.consumers.find((consumer) => consumer.name === name)?.label ?? name;
  const verdict = summary ? verdictText[summary.worker.verdict] : null;

  const inspect = async (event: FailedJobDto): Promise<void> => {
    try {
      setInspected((await getFailedJob(token, event.eventId)).event);
    } catch (cause) {
      setFailedError(formatApiError(cause, 'Unable to load this event.'));
    }
  };

  const runPreview = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSupersedeError('');
    if (!cutoff || Number.isNaN(Date.parse(cutoff))) { setSupersedeError('Choose the cutoff: events that occurred before it are retired.'); return; }
    try {
      setPreview(await previewBacklogSupersede(token, new Date(cutoff).toISOString()));
    } catch (cause) {
      setSupersedeError(formatApiError(cause, 'Unable to count the backlog for this cutoff.'));
    }
  };

  return <section className="role-module role-module--dense">
    {heading}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {loading && !health ? <p>Loading background job health…</p> : null}

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="⛔" tone="amber" value={formatCapped(summary?.outbox.counts.FAILED)} label="Failed events" />
      <V2Stat icon="⏳" tone="blue" value={formatCapped(summary?.outbox.counts.PENDING)} label="Waiting events" />
      <V2Stat icon="🕰️" tone="purple" value={summary?.outbox.oldestDueWaitingMinutes != null ? `${summary.outbox.oldestDueWaitingMinutes} min` : NA} label="Oldest due event waiting" />
      <V2Stat icon="📬" tone="teal" value={summary?.worker.lastDeliveredAt ? new Date(summary.worker.lastDeliveredAt).toLocaleString() : NA} label="Last event delivered" />
    </div>

    <div className="v2-row v2-cols-2 role-wide">
      <section className="role-card"><h2>Worker</h2>
        <p><StatusBadge label={verdict?.label ?? NA} tone={verdict?.tone ?? 'neutral'} /></p>
        <p>{verdict?.note ?? 'Worker state is not available.'}</p>
        <dl>
          <div><dt>Events being processed</dt><dd>{formatCapped(summary?.worker.activeLeases)}</dd></div>
          <div><dt>Claims left by a stopped worker</dt><dd>{formatCapped(summary?.worker.expiredLeases)}</dd></div>
          <div><dt>Delivered (all time)</dt><dd>{formatCapped(summary?.outbox.counts.PUBLISHED)}</dd></div>
          <div><dt>Oldest waiting event occurred</dt><dd>{when(summary?.outbox.oldestPendingAt)}</dd></div>
        </dl>
      </section>
      <section className="role-card"><h2>Alerts</h2>
        {summary ? <>
          <p>An alert is raised once per breach and cleared when the condition recovers: {summary.alerts.config.failedThreshold} or more failed events, or a due event waiting {summary.alerts.config.pendingStallMinutes} minutes or more.</p>
          <p>{summary.alerts.delivery.workflowEnabled && summary.alerts.delivery.templateApproved
            ? 'Alerts are emailed to platform staff through the ops-failure workflow.'
            : 'Alerts are recorded here but not emailed: the ops-failure workflow is not switched on, or no approved alert template exists.'}</p>
          {summary.alerts.config.ignored.length ? <p className="form-error">Ignored settings (defaults apply): {summary.alerts.config.ignored.join(', ')}</p> : null}
          {summary.alerts.open.length
            ? <ul className="role-check-list">{summary.alerts.open.map((alert) => <li key={alert.id}><StatusBadge label="Open" tone="warning" /> {alertLine(alert, consumerLabel)} · since {when(alert.raisedAt)}{alert.notice === 'NOT_DELIVERED' ? ' · not emailed' : ' · emailed'}</li>)}</ul>
            : <p><StatusBadge label="No open alerts" tone="success" /></p>}
          {summary.alerts.recent.length ? <details><summary>Recent alerts</summary><ul className="role-check-list">{summary.alerts.recent.map((alert) => <li key={alert.id}>{alertLine(alert, consumerLabel)} · {alert.state === 'OPEN' ? 'open' : `cleared ${when(alert.clearedAt)}`}</li>)}</ul></details> : null}
        </> : <p>{NA}</p>}
      </section>
    </div>

    <section className="role-card role-wide"><h2>Consumers</h2>
      <p>The last receipt each consumer wrote. Silence is judged only for a consumer given an expected interval in the alert settings.</p>
      <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Consumer</th><th>Last activity</th><th>Last success</th><th>Failed receipts</th><th>Expected interval</th><th>State</th></tr></thead>
        <tbody>{(summary?.consumers ?? []).map((consumer) => <tr key={consumer.name}>
          <th scope="row">{consumer.label}</th>
          <td>{when(consumer.lastActivityAt)}</td>
          <td>{when(consumer.lastSucceededAt)}</td>
          <td>{formatCapped(consumer.failedReceipts)}</td>
          <td>{consumer.silenceMinutes ? `${consumer.silenceMinutes} min` : 'Not configured'}</td>
          <td>{consumer.silent === null ? NA : <StatusBadge label={consumer.silent ? 'Silent' : 'Active'} tone={consumer.silent ? 'warning' : 'success'} />}</td>
        </tr>)}</tbody></table></div>
      {summary && !summary.consumers.length ? <p>{NA}</p> : null}
    </section>

    <section className="role-card role-wide"><h2>Automation workflows and commands</h2>
      {summary && !summary.automation.workflows.length ? <V2EmptyState icon="🧩" title="No workflows registered" note="No automation workflow is registered in this environment, so no email leaves through automation." /> : null}
      {summary?.automation.workflows.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Workflow</th><th>Version</th><th>Operation</th><th>State</th><th>Kill switch</th></tr></thead>
        <tbody>{summary.automation.workflows.map((workflow) => <tr key={`${workflow.allowlistId}:${workflow.version}`}>
          <th scope="row">{workflow.allowlistId}</th><td>{workflow.version}</td><td>{workflow.operation}</td>
          <td><StatusBadge label={workflow.active ? 'Active' : 'Inactive'} tone={workflow.active ? 'success' : 'neutral'} /></td>
          <td><StatusBadge label={workflow.killSwitch ? 'On' : 'Off'} tone={workflow.killSwitch ? 'warning' : 'success'} /></td>
        </tr>)}</tbody></table></div> : null}
      <dl>
        {Object.entries(summary?.automation.commandCounts ?? {}).map(([state, count]) => <div key={state}><dt>Commands {state.toLowerCase().replaceAll('_', ' ')}</dt><dd>{formatCapped(count)}</dd></div>)}
        <div><dt>Last command created</dt><dd>{when(summary?.automation.lastCommandAt)}</dd></div>
        <div><dt>Last workflow callback</dt><dd>{when(summary?.automation.lastCallbackAt)}</dd></div>
      </dl>
      <p>Workflow activation and the kill switch are changed outside this screen.</p>
    </section>

    <section className="role-card role-wide"><h2>Failed events</h2>
      <div className="role-management-form">
        <label><span>Event type</span><select aria-label="Event type" value={eventType} onChange={(event) => { setEventType(event.target.value); setCursors([]); }}>
          <option value="">All types</option>
          {(summary?.outbox.failedByType ?? []).map((row) => <option key={row.eventType} value={row.eventType}>{row.eventType} ({row.count})</option>)}
        </select></label>
        <label><span>Age</span><select aria-label="Age" value={age} onChange={(event) => { setAge(event.target.value); setCursors([]); }}>
          {ageFilters.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
      </div>
      {failedError ? <p className="form-error" role="alert">{failedError}</p> : null}
      {failedLoading && !failed.length ? <p>Loading failed events…</p> : null}
      {!failedLoading && !failedError && !failed.length ? <V2EmptyState icon="✅" title="No failed events" note={eventType || age ? 'No failed events match these filters.' : 'Nothing is in the dead letter.'} /> : null}
      {failed.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Event type</th><th>Failure</th><th>Attempts</th><th>Occurred</th><th>Failed</th><th>Actions</th></tr></thead>
        <tbody>{failed.map((event) => <tr key={event.eventId}>
          <th scope="row">{event.eventType}<br /><small>v{event.eventVersion} · {event.aggregateType}</small></th>
          <td><StatusBadge label={event.failureClass} tone="warning" /></td>
          <td>{event.attempts}</td>
          <td>{when(event.occurredAt)}</td>
          <td>{when(event.failedAt)}</td>
          <td><div className="role-record-actions">
            <button type="button" className="secondary" onClick={() => void inspect(event)}>Inspect</button>
            {event.replayable ? <button type="button" onClick={() => setReplaying(event)}>Replay…</button> : <small>Expired: cannot be replayed</small>}
          </div></td>
        </tr>)}</tbody></table></div> : null}
      <div className="role-record-actions">
        {cursors.length ? <button type="button" className="secondary" onClick={() => setCursors((value) => value.slice(0, -1))}>Previous page</button> : null}
        {nextCursor ? <button type="button" className="secondary" onClick={() => setCursors((value) => [...value, nextCursor])}>Next page</button> : null}
      </div>
    </section>

    {inspected ? <section className="role-card role-wide" aria-label="Failed event detail"><h2>Event: {inspected.eventType}</h2>
      <p>{inspected.explanation}</p>
      <dl>
        <div><dt>Failure</dt><dd>{inspected.failureClass}</dd></div>
        <div><dt>Attempts</dt><dd>{inspected.attempts}</dd></div>
        <div><dt>Occurred</dt><dd>{when(inspected.occurredAt)}</dd></div>
        <div><dt>Failed</dt><dd>{when(inspected.failedAt)}</dd></div>
        <div><dt>Expires</dt><dd>{inspected.expiresAt ? when(inspected.expiresAt) : 'Does not expire'}</dd></div>
        <div><dt>Reference (search Audit Logs)</dt><dd>{inspected.correlationId}</dd></div>
        <div><dt>Automation command</dt><dd>{inspected.automationCommand ? `${inspected.automationCommand.workflow}: ${inspected.automationCommand.state}, ${inspected.automationCommand.attempts} attempts${inspected.automationCommand.failureClass ? `, ${inspected.automationCommand.failureClass}` : ''}` : 'None'}</dd></div>
      </dl>
      <h3>Consumer receipts</h3>
      {inspected.receipts.length
        ? <ul className="role-check-list">{inspected.receipts.map((receipt) => <li key={`${receipt.consumer}:${receipt.updatedAt}`}>{receipt.consumer}: {receipt.status}, {receipt.attempts} attempts{receipt.failureClass ? `, ${receipt.failureClass}` : ''} · {when(receipt.updatedAt)}</li>)}</ul>
        : <p>No consumer has handled this event.</p>}
      <div className="role-record-actions"><button type="button" className="secondary" onClick={() => setInspected(null)}>Close</button></div>
    </section> : null}

    <section className="role-card role-wide"><h2>Supersede the backlog</h2>
      <p>Retire waiting events that occurred before a cutoff so a newly started worker does not deliver them all at once. Nothing is deleted, and any retired event can still be replayed on its own. This is a high-risk action: it needs a second person&apos;s approval, and you carry it out from Settings → Approvals once approved.</p>
      <form className="role-management-form" onSubmit={(event) => void runPreview(event)} noValidate>
        <label><span>Retire waiting events that occurred before</span><input type="datetime-local" aria-label="Cutoff" value={cutoff} onChange={(event) => { setCutoff(event.target.value); setPreview(null); }} /></label>
        <button type="submit" className="secondary">Count waiting events</button>
      </form>
      {supersedeError ? <p className="form-error" role="alert">{supersedeError}</p> : null}
      {preview ? <p role="status">{formatCapped(preview.pending)} waiting event{preview.pending.value === 1 && !preview.pending.capped ? '' : 's'} occurred before {when(preview.olderThan)}. At most {preview.limit.toLocaleString()} are retired per approval.</p> : null}
      {preview && preview.pending.value > 0 ? <button type="button" onClick={() => setSuperseding(true)}>Request supersede…</button> : null}
    </section>

    <OperationsCareerReadinessPanel />

    {replaying && health ? <ReplayDialog token={token} event={replaying} reasons={health.reasons.replay}
      onCancel={() => setReplaying(null)}
      onDone={() => { setReplaying(null); setInspected(null); setNotice(`Replay queued: ${replaying.eventType}. It is delivered on the worker's next pass.`); setReload((value) => value + 1); }} /> : null}
    {superseding && preview && health ? <RequestApprovalDialog token={token} actionKey="OUTBOX_BACKLOG_SUPERSEDE"
      payload={{ olderThan: preview.olderThan, limit: preview.limit }} reasons={health.reasons.supersede}
      title="Supersede the waiting backlog"
      details={[['Cutoff', when(preview.olderThan)], ['Waiting events before it', formatCapped(preview.pending)], ['Most retired', preview.limit.toLocaleString()], ['Effect', 'Moves them to failed as superseded. They are never delivered unless replayed one by one.']]}
      onCancel={() => setSuperseding(false)} onFiled={(message) => { setSuperseding(false); setNotice(message); }} /> : null}
  </section>;
}

function ReplayDialog({ token, event, reasons, onCancel, onDone }: {
  readonly token: string; readonly event: FailedJobDto; readonly reasons: readonly string[]; readonly onCancel: () => void; readonly onDone: () => void;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const submit = async (form: React.FormEvent): Promise<void> => {
    form.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      await replayFailedJob(token, event.eventId, reasonCode);
      onDone();
    } catch (cause) {
      setError(formatApiError(cause, 'The event could not be replayed.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="jobs-replay-title">
      <h2 id="jobs-replay-title">Replay {event.eventType}</h2>
      <dl>
        <div><dt>Failure</dt><dd>{event.failureClass}</dd></div>
        <div><dt>Attempts so far</dt><dd>{event.attempts}</dd></div>
        <div><dt>Effect</dt><dd>The event is queued again and its real-world effect (an email, a generated draft) can happen again. The replay is recorded in the audit log with your reason.</dd></div>
        <div><dt>Approval</dt><dd>Not required: a single replay is not a high-risk action.</dd></div>
      </dl>
      <form onSubmit={(form) => void submit(form)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(change) => setReasonCode(change.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Replaying…' : 'Confirm replay'}</button>
        </div>
      </form>
    </section>
  </div>;
}
