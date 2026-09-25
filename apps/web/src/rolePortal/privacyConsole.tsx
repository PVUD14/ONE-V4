/**
 * ONE · Role portal — Operations: Security → Privacy and consent (OPS-06, Appendix 1 §4.2).
 *
 * The screen for the privacy operations API that existed without one: the DPDP request
 * queue with each request's state history, legal holds (place one; ask to release one
 * through the OPS-02 approval flow, carried out from Settings → Approvals), and consent
 * coverage per consent key. The Career Readiness governance status this label showed
 * before is kept below it.
 *
 * Nothing here is invented. A statutory due date is NA because no response period is
 * defined in code yet; an engine consent purpose that is not published says "Not
 * published", not 0; any count of fewer than 5 people arrives from the server already
 * suppressed and renders "<5". Subjects are shown masked; the reason a person typed when
 * asking for deletion is never sent to this screen. There is no per-person consent view.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  getConsentCoverage,
  getOperationsPrivacyRequest,
  getProtectedAccessToken,
  listOperationsPrivacyRequests,
  listRetentionHolds,
  placeRetentionHold,
} from '../api.js';
import type {
  ConsentCoverageDto,
  ConsentKeyCoverageDto,
  OperationsPrivacyRequestDetailDto,
  PrivacyRequestQueueDto,
  RetentionHoldDto,
  RetentionHoldListDto,
  SuppressedCountDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { OperationsCareerReadinessPanel } from '../operationsCareerReadinessPanel.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { formatApiError, RestrictedApiState } from './shared.js';

const NA = 'NA';
const detailLimit = 2000;
const when = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString() : NA);

const views = [
  { value: 'OPEN', label: 'Open' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'ALL', label: 'All' },
  { value: 'RECEIVED', label: 'Received' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'READY', label: 'Ready to download' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'FAILED', label: 'Failed' },
] as const;

const typeLabel = { EXPORT: 'Data export', DELETION: 'Deletion' } as const;

const stateTone = (state: string): 'success' | 'warning' | 'neutral' | 'info' | 'danger' =>
  state === 'COMPLETED' ? 'success' : state === 'FAILED' ? 'danger' : state === 'CANCELLED' || state === 'REJECTED' ? 'neutral' : state === 'READY' ? 'info' : 'warning';

/** A people count as the server sent it: suppressed counts have no value to show. */
export function formatSuppressed(count: SuppressedCountDto | undefined): string {
  if (!count) return NA;
  return count.suppressed ? '<5' : count.value.toLocaleString();
}

const subjectLabel = (subject: { readonly maskedEmail: string | null; readonly erased: boolean }): string =>
  subject.erased ? 'Erased person' : subject.maskedEmail ?? NA;

export function OperationsPrivacyConsolePage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [view, setView] = useState('OPEN');
  const [type, setType] = useState('');
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const [queue, setQueue] = useState<PrivacyRequestQueueDto | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [detail, setDetail] = useState<OperationsPrivacyRequestDetailDto | null>(null);
  const [detailError, setDetailError] = useState('');
  const [holds, setHolds] = useState<RetentionHoldListDto | null>(null);
  const [holdsError, setHoldsError] = useState('');
  const [coverage, setCoverage] = useState<ConsentCoverageDto | null>(null);
  const [coverageError, setCoverageError] = useState('');
  const [notice, setNotice] = useState('');
  const [placing, setPlacing] = useState<OperationsPrivacyRequestDetailDto | null>(null);
  const [releasing, setReleasing] = useState<RetentionHoldDto | null>(null);
  const [reload, setReload] = useState(0);
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setQueueLoading(true);
    listOperationsPrivacyRequests(token, { view, ...(type ? { type } : {}), ...(cursor ? { cursor } : {}) }, controller.signal)
      .then((result) => { setQueue(result); setQueueError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setQueueError(formatApiError(cause, 'Unable to load privacy requests.'));
      })
      .finally(() => { if (!controller.signal.aborted) setQueueLoading(false); });
    return () => controller.abort();
  }, [token, view, type, cursor, reload]);

  useEffect(() => {
    if (!token || forbiddenReference) return;
    const controller = new AbortController();
    listRetentionHolds(token, controller.signal)
      .then((result) => { setHolds(result); setHoldsError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setHoldsError(formatApiError(cause, 'Unable to load legal holds.')); });
    getConsentCoverage(token, controller.signal)
      .then((result) => { setCoverage(result); setCoverageError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setCoverageError(formatApiError(cause, 'Unable to load consent coverage.')); });
    return () => controller.abort();
  }, [token, forbiddenReference, reload]);

  if (!token) return <RestrictedApiState title="Security" message="Sign in with an Operations identity to see privacy requests, legal holds and consent coverage." />;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Operations · security</span><h1>Security</h1>
    <p>Privacy and consent: every data-subject request with its state and history, legal holds, and how many people stand behind each consent. Opening a request is recorded in the audit log. Releasing a hold needs a second person&apos;s approval. People are shown masked, and there is no per-person consent view.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="The privacy console is for staff who work privacy requests. Your access has not changed."
        hint={`Reference: ${forbiddenReference}`} /></div>
      <OperationsCareerReadinessPanel /></section>;
  }

  const summary = queue?.summary;
  const statutoryDefined = queue ? Object.values(queue.policy.statutoryResponsePeriodDays).some((days) => days !== null) : false;
  const requests = queue?.requests ?? [];

  const openDetail = async (requestId: string): Promise<void> => {
    setDetailError('');
    try {
      setDetail((await getOperationsPrivacyRequest(token, requestId)).request);
    } catch (cause) {
      setDetailError(formatApiError(cause, 'Unable to open this request.'));
    }
  };

  return <section className="role-module role-module--dense">
    {heading}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📦" tone="blue" value={summary ? summary.open.EXPORT : NA} label="Open data exports" />
      <V2Stat icon="🗑️" tone="purple" value={summary ? summary.open.DELETION : NA} label="Open deletions" />
      <V2Stat icon="⏳" tone="amber" value={summary ? summary.deletionsDueWithinSevenDays : NA} label="Erasures due in 7 days" />
      <V2Stat icon="⚖️" tone="teal" value={summary ? summary.activeHolds : NA} label="Legal holds in force" />
    </div>

    <section className="role-card role-wide"><h2>Privacy requests</h2>
      <p>Requests people made from their Privacy settings. A deletion runs when its {queue?.policy.deletionGracePeriodDays ?? NA}-day grace period ends, unless a legal hold stops it.
        {statutoryDefined ? '' : ' Statutory response deadlines show NA: no DPDP response period is defined in ONE yet.'}</p>
      {summary ? <p>{summary.deletionsPastSchedule} deletion{summary.deletionsPastSchedule === 1 ? ' is' : 's are'} past the scheduled erasure without completing · {summary.failed} failed · {summary.releasesInFlight} hold release{summary.releasesInFlight === 1 ? '' : 's'} awaiting approval or execution.</p> : null}
      <div className="role-management-form">
        <label><span>Show</span><select aria-label="Request state" value={view} onChange={(event) => { setView(event.target.value); setCursors([]); }}>
          {views.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label><span>Type</span><select aria-label="Request type" value={type} onChange={(event) => { setType(event.target.value); setCursors([]); }}>
          <option value="">All types</option><option value="EXPORT">Data export</option><option value="DELETION">Deletion</option>
        </select></label>
      </div>
      {queueError ? <p className="form-error" role="alert">{queueError}</p> : null}
      {queueLoading && !queue ? <p>Loading privacy requests…</p> : null}
      {!queueLoading && queue && !requests.length ? <V2EmptyState icon="✅" title="No requests here"
        note={view === 'OPEN' && !type ? 'Nobody has an open export or deletion request.' : 'No requests match this view.'} /> : null}
      {requests.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Request</th><th>Person</th><th>State</th><th>Received</th><th>Erasure scheduled</th><th>Statutory deadline</th><th>Holds</th><th>Actions</th></tr></thead>
        <tbody>{requests.map((request) => <tr key={request.id}>
          <th scope="row">{typeLabel[request.requestType]}<br /><small>{request.reference}</small></th>
          <td>{subjectLabel(request.subject)}</td>
          <td><StatusBadge label={request.state} tone={stateTone(request.state)} /></td>
          <td>{when(request.requestedAt)}</td>
          <td>{request.requestType === 'DELETION' ? when(request.deletionScheduledFor) : NA}</td>
          <td>{when(request.statutoryDueAt)}</td>
          <td>{request.activeHolds ? <StatusBadge label={`${request.activeHolds} in force`} tone="warning" /> : 'None'}</td>
          <td><button type="button" className="secondary" onClick={() => void openDetail(request.id)}>View</button></td>
        </tr>)}</tbody></table></div> : null}
      <div className="role-record-actions">
        {cursors.length ? <button type="button" className="secondary" onClick={() => setCursors((value) => value.slice(0, -1))}>Previous page</button> : null}
        {queue?.nextCursor ? <button type="button" className="secondary" onClick={() => setCursors((value) => [...value, queue.nextCursor!])}>Next page</button> : null}
      </div>
      {detailError ? <p className="form-error" role="alert">{detailError}</p> : null}
    </section>

    {detail ? <section className="role-card role-wide" aria-label="Privacy request detail"><h2>{typeLabel[detail.requestType]} {detail.reference}</h2>
      <p>Opening this request was recorded in the audit log.</p>
      <dl>
        <div><dt>Person</dt><dd>{subjectLabel(detail.subject)}</dd></div>
        <div><dt>State</dt><dd><StatusBadge label={detail.state} tone={stateTone(detail.state)} /></dd></div>
        <div><dt>Received</dt><dd>{when(detail.requestedAt)}</dd></div>
        <div><dt>Statutory deadline</dt><dd>{when(detail.statutoryDueAt)}</dd></div>
        {detail.requestType === 'DELETION' ? <div><dt>Erasure scheduled</dt><dd>{when(detail.deletionScheduledFor)}</dd></div> : null}
        {detail.requestType === 'EXPORT' ? <div><dt>Download available until</dt><dd>{when(detail.exportExpiresAt)}</dd></div> : null}
        <div><dt>Completed</dt><dd>{when(detail.completedAt)}</dd></div>
        {detail.cancelledAt ? <div><dt>Cancelled by the person</dt><dd>{when(detail.cancelledAt)}</dd></div> : null}
        {detail.rejectionReasonCode ? <div><dt>Rejection reason</dt><dd>{detail.rejectionReasonCode}</dd></div> : null}
      </dl>
      <h3>State history</h3>
      {detail.history.length
        ? <ol className="role-check-list">{detail.history.map((entry, index) => <li key={`${entry.occurredAt}:${index}`}>
            {entry.fromState ? `${entry.fromState} → ${entry.toState}` : `Received as ${entry.toState}`} · {entry.actorRole === 'SUBJECT' ? 'by the person' : entry.actorRole === 'SYSTEM' ? 'by ONE' : entry.actorRole === 'OPERATIONS' ? 'by operations' : NA} · {when(entry.occurredAt)}
          </li>)}</ol>
        : <p>No state changes are recorded for this request.</p>}
      {detail.requestType === 'DELETION' ? <>
        <h3>What the deletion did</h3>
        {detail.deletionOutcome.length ? <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>Category</th><th>Outcome</th><th>Records</th><th>Basis for keeping</th></tr></thead>
          <tbody>{detail.deletionOutcome.map((row) => <tr key={row.category}><th scope="row">{row.category}</th><td>{row.disposition}</td><td>{row.recordCount ?? NA}</td><td>{row.basis ?? NA}</td></tr>)}</tbody>
        </table></div> : <p>Nothing has been erased yet.</p>}
      </> : null}
      <h3>Legal holds on this person</h3>
      {detail.holds.length
        ? <ul className="role-check-list">{detail.holds.map((hold) => <li key={hold.id}>{hold.reasonCode} · placed {when(hold.placedAt)}</li>)}</ul>
        : <p>None. An erasure proceeds when it is due.</p>}
      <div className="role-record-actions">
        {!detail.subject.erased && holds ? <button type="button" onClick={() => setPlacing(detail)}>Place a legal hold…</button> : null}
        <button type="button" className="secondary" onClick={() => setDetail(null)}>Close</button>
      </div>
    </section> : null}

    <section className="role-card role-wide"><h2>Legal holds</h2>
      <p>A hold stops an erasure from completing while a legal obligation, investigation or dispute needs the record. Place one from a request above. Releasing one lets a waiting erasure run, so it needs a second person&apos;s approval; once approved, carry it out from Settings → Approvals.</p>
      {holdsError ? <p className="form-error" role="alert">{holdsError}</p> : null}
      {!holds && !holdsError ? <p>Loading legal holds…</p> : null}
      {holds && !holds.holds.length ? <V2EmptyState icon="⚖️" title="No holds in force" note="No person's erasure is suspended." /> : null}
      {holds?.holds.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Person</th><th>Reason</th><th>Context</th><th>Placed</th><th>Blocks</th><th>Release</th></tr></thead>
        <tbody>{holds.holds.map((hold) => <tr key={hold.id}>
          <th scope="row">{subjectLabel(hold.subject)}</th>
          <td>{hold.reasonCode}</td>
          <td>{hold.detail ?? NA}</td>
          <td>{when(hold.placedAt)}<br /><small>{hold.placedBy.email}</small></td>
          <td>{hold.openDeletion ? <>Deletion {hold.openDeletion.reference}<br /><small>scheduled {when(hold.openDeletion.scheduledFor)}</small></> : 'No open deletion'}</td>
          <td>{hold.releaseRequest
            ? <><StatusBadge label={hold.releaseRequest.state === 'PENDING' ? 'Release awaiting approval' : 'Release approved'} tone="warning" /><br />
              <small>{hold.releaseRequest.state === 'APPROVED' ? 'Carry it out from Settings → Approvals' : `Asked by ${hold.releaseRequest.requestedBy.email}`} · expires {when(hold.releaseRequest.expiresAt)}</small></>
            : <button type="button" className="secondary" onClick={() => setReleasing(hold)}>Request release…</button>}</td>
        </tr>)}</tbody></table></div> : null}
      {holds?.capped ? <p>Showing the 200 most recent holds.</p> : null}
    </section>

    <ConsentCoverageSection coverage={coverage} error={coverageError} />

    <section className="role-card role-wide"><h2>Breach response and incidents</h2>
      <p>If personal data may have been exposed, follow the breach response runbook in the ONE repository: docs/ops/runbook-breach-response.md. It covers declaring, containing, assessing scope and notifying the Data Protection Board and every affected person.</p>
      <p><StatusBadge label="Incident register: not built yet" tone="neutral" /> The incident register and breach clocks arrive with a later Security module. Until then, keep the incident log the runbook describes.</p>
    </section>

    <OperationsCareerReadinessPanel />
    <section className="role-card role-wide"><h2>Mutation boundary</h2><p>n8n remains inactive unless explicitly enabled outside this UI. Kill-switch, workflow activation and credential operations are not exposed as buttons here.</p></section>

    {placing && holds ? <PlaceHoldDialog token={token} request={placing} reasons={holds.reasons.place}
      onCancel={() => setPlacing(null)}
      onDone={() => { setPlacing(null); setNotice(`Legal hold placed on ${subjectLabel(placing.subject)}. The erasure cannot complete while it is in force.`); setReload((value) => value + 1); void openDetail(placing.id); }} /> : null}
    {releasing && holds ? <RequestApprovalDialog token={token} actionKey="PRIVACY_HOLD_RELEASE"
      payload={{ holdId: releasing.id }} reasons={holds.reasons.release}
      title="Release a legal hold"
      details={[
        ['Person', subjectLabel(releasing.subject)],
        ['Hold reason', releasing.reasonCode],
        ['Placed', when(releasing.placedAt)],
        ['Effect', releasing.openDeletion ? `The waiting deletion ${releasing.openDeletion.reference} can complete at its next run.` : 'Nothing waits on this hold today; a future erasure would no longer be stopped.'],
      ]}
      onCancel={() => setReleasing(null)} onFiled={(message) => { setReleasing(null); setNotice(message); setReload((value) => value + 1); }} /> : null}
  </section>;
}

function coverageCell(key: ConsentKeyCoverageDto, pick: (counts: NonNullable<ConsentKeyCoverageDto['counts']>) => SuppressedCountDto): string {
  if (key.status === 'NOT_PUBLISHED') return 'Not published';
  if (!key.counts) return NA;
  return formatSuppressed(pick(key.counts));
}

function ConsentCoverageSection({ coverage, error }: { readonly coverage: ConsentCoverageDto | null; readonly error: string }): React.ReactElement {
  return <section className="role-card role-wide"><h2>Consent coverage</h2>
    <p>Where people stand against the version of each consent in force now, counted from their latest record. Counts of fewer than {coverage?.suppressionThreshold ?? 5} people show &lt;5. People who were erased are not counted. There is no per-person consent view here, and consents are not changed from this screen.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!coverage && !error ? <p>Loading consent coverage…</p> : null}
    {coverage ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Consent</th><th>Version in force</th><th>Enforcement</th><th>Consented to this version</th><th>Withdrawn</th><th>On an older version</th></tr></thead>
      <tbody>{coverage.keys.map((key) => <tr key={key.consentKey}>
        <th scope="row">{key.title ? <>{key.title}<br /><small>{key.consentKey}</small></> : key.consentKey}</th>
        <td>{key.status === 'LIVE' ? key.liveVersion
          : <StatusBadge label={key.status === 'NOT_PUBLISHED' ? 'Not published' : 'No version in force'} tone="neutral" />}</td>
        <td>{key.enforcement ?? NA}</td>
        <td>{coverageCell(key, (counts) => counts.consentedToLiveVersion)}</td>
        <td>{coverageCell(key, (counts) => counts.withdrawn)}</td>
        <td>{coverageCell(key, (counts) => counts.onOlderVersion)}</td>
      </tr>)}</tbody></table></div> : null}
    {coverage?.keys.some((key) => key.status === 'NOT_PUBLISHED')
      ? <p>Not published: the learning-engine consents are drafted but their wording waits for legal approval, so nobody has been asked yet and there is no coverage to report.</p> : null}
    <h3>Definitions and versions</h3>
    {coverage && !coverage.definitions.length ? <V2EmptyState icon="📜" title="No consent definitions" note="The consent registry has no definitions in this environment." /> : null}
    {coverage?.definitions.length ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Consent</th><th>Version</th><th>Status</th><th>Enforcement</th><th>Withdrawable</th><th>In force from</th><th>Retired</th></tr></thead>
      <tbody>{coverage.definitions.map((definition) => <tr key={`${definition.consentKey}:${definition.version}`}>
        <th scope="row">{definition.title}<br /><small>{definition.consentKey}</small></th>
        <td>{definition.version}</td>
        <td><StatusBadge label={definition.status === 'LIVE' ? 'In force' : definition.status === 'SCHEDULED' ? 'Scheduled' : 'Retired'} tone={definition.status === 'LIVE' ? 'success' : 'neutral'} /></td>
        <td>{definition.enforcement}</td>
        <td>{definition.withdrawable ? 'Yes' : 'No'}</td>
        <td>{when(definition.effectiveFrom)}</td>
        <td>{when(definition.retiredAt)}</td>
      </tr>)}</tbody></table></div> : null}
  </section>;
}

function PlaceHoldDialog({ token, request, reasons, onCancel, onDone }: {
  readonly token: string; readonly request: OperationsPrivacyRequestDetailDto; readonly reasons: readonly string[];
  readonly onCancel: () => void; readonly onDone: () => void;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);
  const submit = async (form: React.FormEvent): Promise<void> => {
    form.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      await placeRetentionHold(token, { subjectUserId: request.subject.userId, reasonCode, ...(detail.trim() ? { detail: detail.trim() } : {}) });
      onDone();
    } catch (cause) {
      setError(formatApiError(cause, 'The hold could not be placed.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="privacy-hold-title">
      <h2 id="privacy-hold-title">Place a legal hold</h2>
      <dl>
        <div><dt>Person</dt><dd>{subjectLabel(request.subject)}</dd></div>
        <div><dt>Request</dt><dd>{typeLabel[request.requestType]} {request.reference}</dd></div>
        <div><dt>Effect</dt><dd>Any erasure of this person cannot complete while the hold is in force. The hold is recorded in the audit log with your reason.</dd></div>
        <div><dt>Approval</dt><dd>Not required to place a hold. Releasing it later needs a second person&apos;s approval.</dd></div>
      </dl>
      <form onSubmit={(form) => void submit(form)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(change) => setReasonCode(change.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <label><span>Context (optional, {detailLimit} characters) — a case or reference number, not personal data</span>
          <textarea value={detail} maxLength={detailLimit} onChange={(change) => setDetail(change.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Placing…' : 'Place hold'}</button>
        </div>
      </form>
    </section>
  </div>;
}
