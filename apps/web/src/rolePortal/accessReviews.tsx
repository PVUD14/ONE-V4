/**
 * ONE · Role portal — Operations Security: quarterly access reviews (OPS-15).
 *
 * A reviewer opens a campaign (a frozen snapshot of every standing internal access),
 * decides KEEP or REVOKE on each item with a reason code, closes it when every item is
 * decided, and downloads it as CSV evidence. Overdue reviews are shown plainly. The server
 * decides everything — which items the viewer may decide, the solo safeguard, whether a
 * removal took effect — and this screen shows what it says. Sits under the existing
 * Security label; no navigation changes.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  closeAccessReview,
  decideAccessReviewItem,
  downloadAccessReviewCsv,
  getAccessReviewOverview,
  getProtectedAccessToken,
  listAccessReviewItems,
  openAccessReview,
} from '../api.js';
import type { AccessReviewCampaignDto, AccessReviewDecision, AccessReviewItemDto, AccessReviewOverviewDto, AccessReviewScheduleStatus } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';
import { SupportCode } from '../supportCode.js';
import * as dates from '../dates.js';

const noteLimit = 500;
const NA = 'NA';

const statusLabel: Readonly<Record<AccessReviewScheduleStatus, string>> = {
  NEVER_REVIEWED: 'Never reviewed',
  REVIEW_OVERDUE: 'Overdue',
  CAMPAIGN_OVERDUE: 'Open review overdue',
  IN_PROGRESS: 'In progress',
  CURRENT: 'Up to date',
};

const refusalText: Readonly<Record<string, string>> = {
  ACCESS_REVIEW_OWN_ACCESS: 'Your own access — another reviewer decides this.',
  ACCESS_REVIEW_SOLO_COOLING_OFF: 'Your own access — as the only reviewer you may keep it after the cooling-off.',
  ACCESS_REVIEW_ALREADY_DECIDED: 'Decided.',
  ACCESS_REVIEW_NOT_OPEN: 'Review closed.',
};

const formatDate = (value: string | null | undefined): string => (value ? dates.formatDate(value) : NA);
const formatDateTime = (value: string | null | undefined): string => (value ? dates.formatDateTime(value) : NA);

/** What the item grants, in words: a role with its capability set, or one capability. */
export function describeAccessReviewItem(item: AccessReviewItemDto): string {
  if (item.kind === 'PLATFORM_ROLE') return `Role ${item.role} (${item.capabilities.length} capabilities)`;
  return `${item.capability ?? NA} on ${item.role}`;
}

function overdueSentence(summary: AccessReviewOverviewDto['summary']): string | null {
  if (!summary.overdue) return null;
  if (summary.status === 'NEVER_REVIEWED' || (summary.status === 'IN_PROGRESS' && !summary.lastClosed)) return 'No access review has been completed yet. Internal access is due for review now.';
  if (summary.status === 'CAMPAIGN_OVERDUE') return `The open review was due to finish on ${formatDate(summary.open?.dueAt)} and is overdue.`;
  return `The quarterly access review was due on ${formatDate(summary.nextDueAt)} and is overdue.`;
}

export function OperationsAccessReviewsPage(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [overview, setOverview] = useState<AccessReviewOverviewDto | null>(null);
  const [items, setItems] = useState<readonly AccessReviewItemDto[] | null>(null);
  const [filter, setFilter] = useState<'' | 'UNDECIDED' | 'DECIDED'>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [notice, setNotice] = useState('');
  const [opening, setOpening] = useState(false);
  const [deciding, setDeciding] = useState<{ readonly item: AccessReviewItemDto; readonly decision: AccessReviewDecision } | null>(null);
  const [closing, setClosing] = useState(false);
  const [exporting, setExporting] = useState<AccessReviewCampaignDto | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    getAccessReviewOverview(token, controller.signal)
      .then(async (result) => {
        setOverview(result);
        setForbiddenReference('');
        const open = result.summary.open;
        if (open) {
          const page = await listAccessReviewItems(token, open.id, filter ? { filter } : {}, controller.signal);
          setItems(page.items);
        } else {
          setItems(null);
        }
        setError('');
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load access reviews.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, filter, reload]);

  if (!token) return null;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Security</span><h1>Access reviews</h1>
    <p>Each quarter, every standing internal access — platform staff roles, internal capability grants and faculty content-review grants — is frozen into a review. A reviewer keeps or revokes each one with a reason; a revocation takes effect at once and is recorded in the audit log with the review. Nobody decides their own access.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState icon="🔐" title="Not permitted"
        note="Access reviews are run by staff who hold the access review capability. Your access has not changed."
        hint={<SupportCode reference={forbiddenReference} />} /></div></section>;
  }

  const summary = overview?.summary;
  const open = summary?.open ?? null;
  const reasons = overview?.policy.reasons;
  const overdue = summary ? overdueSentence(summary) : null;
  const undecided = open ? open.itemCount - open.counts.decided : 0;

  const download = async (campaign: AccessReviewCampaignDto, reasonCode: string): Promise<void> => {
    const file = await downloadAccessReviewCsv(token, campaign.id, reasonCode);
    if (typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([file.csv], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
    }
    setNotice(`Exported ${file.filename}. The export is recorded in the audit log.`);
  };

  return <section className="role-module role-module--dense">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🛡️" tone={summary?.overdue ? 'amber' : 'teal'} value={summary ? statusLabel[summary.status] : NA} label="Review status" />
      <V2Stat icon="✅" tone="blue" value={summary?.lastClosed ? `${summary.lastClosed.periodLabel} · ${formatDate(summary.lastClosed.closedAt)}` : NA} label="Last completed review" />
      <V2Stat icon="📅" tone="purple" value={summary ? (summary.nextDueAt ? formatDate(summary.nextDueAt) : 'Now') : NA} label="Next review due" />
      <V2Stat icon="📋" tone="green" value={summary ? (open ? `${open.counts.decided} / ${open.itemCount}` : 'None open') : NA} label="Open review decided" />
    </div>
    {overdue ? <p className="form-error role-wide" role="alert">{overdue}</p> : null}
    {summary?.soloSafeguardActive ? <p className="role-wide">Only one person can review right now, so they may keep their own access {overview?.policy.soloCoolingOffMinutes ?? 15} minutes after a review opens. Each such decision is marked SOLO in the review, the audit log and the export; this switches off by itself when a second reviewer exists.</p> : null}
    {error ? <p className="form-error role-wide" role="alert">{error}</p> : null}
    {notice ? <p className="role-wide" role="status">{notice}</p> : null}
    {loading && !overview ? <p className="role-wide">Loading access reviews…</p> : null}

    {overview && !open ? <section className="role-card role-wide"><h2>Open a review</h2>
      <p>Opening a review freezes every standing internal access as it is now. Items added later are reviewed next time. A review should be finished within {overview.policy.campaignWindowDays} days.</p>
      <div className="role-actions"><button type="button" className="pilot-btn" onClick={() => setOpening(true)}>Open access review…</button></div>
    </section> : null}

    {open ? <section className="role-card role-wide">
      <h2>Review {open.periodLabel}</h2>
      <p>Opened by {open.openedBy.email} on {formatDateTime(open.openedAt)} ({open.openReasonCode}). Due by {formatDate(open.dueAt)}. {open.counts.revoked} revoked, {open.counts.kept} kept{open.counts.solo ? `, ${open.counts.solo} self-attested (solo)` : ''}.</p>
      <div className="role-actions">
        <label className="role-local-search"><span>Show</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as '' | 'UNDECIDED' | 'DECIDED')} aria-label="Item filter">
            <option value="">All items</option><option value="UNDECIDED">Undecided</option><option value="DECIDED">Decided</option>
          </select></label>
        <button type="button" className="pilot-btn" disabled={undecided > 0} onClick={() => setClosing(true)}>Close review…</button>
        <button type="button" className="secondary" onClick={() => setExporting(open)}>Export CSV…</button>
      </div>
      {undecided > 0 ? <p>{undecided} item{undecided === 1 ? '' : 's'} still to decide before the review can close.</p> : null}
      {items && !items.length ? <V2EmptyState icon="✅" title="Nothing here" note={filter ? 'No items match this view.' : 'This review has no items: no standing internal access existed when it opened.'} /> : null}
      {items?.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Person</th><th>Access</th><th>Granted</th><th>Decision</th><th>Actions</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td>{item.subject.email}{item.subject.isSelf ? <><br /><small>You</small></> : null}<br /><small>{item.organizationName}</small></td>
          <td><strong>{describeAccessReviewItem(item)}</strong>{item.highRisk ? <><br /><StatusBadge label="High risk" tone="warning" /></> : null}
            {item.kind === 'PLATFORM_ROLE' && item.capabilities.length ? <><br /><small>{item.capabilities.join(', ')}</small></> : null}</td>
          <td>By {item.grantedBy?.email ?? NA}<br /><small>{formatDate(item.grantedAt)}{item.grantReasonCode ? ` · ${item.grantReasonCode}` : ''}</small></td>
          <td>{item.decision
            ? <><StatusBadge label={item.decision} tone={item.decision === 'KEEP' ? 'success' : 'danger'} /> {item.decisionReasonCode}
              {item.mode === 'SOLO' ? <><br /><StatusBadge label="SOLO" tone="warning" /></> : null}
              <br /><small>{item.decidedBy?.email ?? NA} · {formatDateTime(item.decidedAt)}</small>
              {item.revocationOutcome === 'APPLIED' ? <><br /><small>Access removed.</small></> : null}
              {item.revocationOutcome === 'ALREADY_ENDED' ? <><br /><small>Access had already ended.</small></> : null}</>
            : 'Not yet decided'}</td>
          <td><div className="role-actions">
            {item.canKeep ? <button type="button" className="pilot-btn" onClick={() => setDeciding({ item, decision: 'KEEP' })}>{item.keepMode === 'SOLO' ? 'Keep (solo)…' : 'Keep…'}</button> : null}
            {item.canRevoke ? <button type="button" className="secondary" onClick={() => setDeciding({ item, decision: 'REVOKE' })}>Revoke…</button> : null}
            {!item.decision && item.refusal ? <small>{refusalText[item.refusal] ?? 'You cannot decide this item.'}
              {item.coolingOffEndsAt ? ` From ${dates.formatTime(item.coolingOffEndsAt)}.` : ''}</small> : null}
          </div></td>
        </tr>)}</tbody></table></div> : null}
    </section> : null}

    <section className="role-card role-wide"><h2>Review history</h2>
      {overview && !overview.campaigns.length ? <V2EmptyState icon="📜" title="No reviews yet" note="No access review has been opened in this environment." /> : null}
      {overview && overview.campaigns.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Period</th><th>State</th><th>Opened</th><th>Closed</th><th>Items</th><th>Outcome</th><th>Evidence</th></tr></thead>
        <tbody>{overview.campaigns.map((campaign) => <tr key={campaign.id}>
          <td>{campaign.periodLabel}</td>
          <td><StatusBadge label={campaign.state} tone={campaign.state === 'CLOSED' ? 'success' : 'info'} /></td>
          <td>{campaign.openedBy.email}<br /><small>{formatDateTime(campaign.openedAt)}</small></td>
          <td>{campaign.closedBy ? <>{campaign.closedBy.email}<br /><small>{formatDateTime(campaign.closedAt)}</small></> : NA}</td>
          <td>{campaign.itemCount}</td>
          <td>{campaign.counts.kept} kept · {campaign.counts.revoked} revoked{campaign.counts.solo ? ` · ${campaign.counts.solo} solo` : ''}</td>
          <td><button type="button" className="secondary" onClick={() => setExporting(campaign)}>Export CSV…</button></td>
        </tr>)}</tbody></table></div> : null}
    </section>

    {opening && reasons ? <ReasonDialog title="Open an access review" reasons={reasons.open} withNote confirmLabel="Open review"
      details={[['What happens', 'Every standing internal access is frozen into this review now. Only one review can be open at a time.']]}
      onCancel={() => setOpening(false)}
      onConfirm={async (reasonCode, note) => {
        const result = await openAccessReview(token, { reasonCode, ...(note ? { note } : {}) });
        setOpening(false); setNotice(`Opened review ${result.campaign.periodLabel} with ${result.campaign.itemCount} items.`); setReload((value) => value + 1);
      }} /> : null}
    {deciding && reasons ? <ReasonDialog title={`${deciding.decision === 'KEEP' ? 'Keep' : 'Revoke'}: ${deciding.item.subject.email}`}
      reasons={reasons.decision[deciding.decision]} withNote confirmLabel={deciding.decision === 'KEEP' ? 'Confirm keep' : 'Revoke now'}
      details={[
        ['Access', describeAccessReviewItem(deciding.item)],
        ['Granted', `By ${deciding.item.grantedBy?.email ?? NA} on ${formatDate(deciding.item.grantedAt)}`],
        ...(deciding.decision === 'REVOKE' ? [['Effect', deciding.item.kind === 'PLATFORM_ROLE'
          ? 'The staff membership is suspended now and its capability grants are revoked. This is recorded in the audit log with this review.'
          : 'The grant is revoked now. This is recorded in the audit log with this review.'] as const] : []),
        ...(deciding.item.keepMode === 'SOLO' && deciding.decision === 'KEEP' ? [['Solo', 'You are keeping your own access as the only reviewer. It will be marked SOLO.'] as const] : []),
      ]}
      onCancel={() => setDeciding(null)}
      onConfirm={async (reasonCode, note) => {
        const result = await decideAccessReviewItem(token, open?.id ?? '', deciding.item.id, { decision: deciding.decision, reasonCode, ...(note ? { note } : {}) });
        setDeciding(null);
        setNotice(result.item.decision === 'REVOKE'
          ? (result.item.revocationOutcome === 'APPLIED' ? `Revoked: ${describeAccessReviewItem(result.item)} for ${result.item.subject.email}.` : `Recorded. The access had already ended.`)
          : `Kept: ${describeAccessReviewItem(result.item)} for ${result.item.subject.email}${result.item.mode === 'SOLO' ? ' (SOLO)' : ''}.`);
        setReload((value) => value + 1);
      }} /> : null}
    {closing && open && reasons ? <ReasonDialog title={`Close review ${open.periodLabel}`} reasons={reasons.close} confirmLabel="Close review"
      details={[['Outcome', `${open.counts.kept} kept, ${open.counts.revoked} revoked${open.counts.solo ? `, ${open.counts.solo} self-attested (solo)` : ''}. A closed review cannot change.`]]}
      onCancel={() => setClosing(false)}
      onConfirm={async (reasonCode) => {
        await closeAccessReview(token, open.id, reasonCode);
        setClosing(false); setNotice(`Closed review ${open.periodLabel}.`); setReload((value) => value + 1);
      }} /> : null}
    {exporting && reasons ? <ReasonDialog title={`Export review ${exporting.periodLabel}`} reasons={reasons.export} confirmLabel="Download CSV"
      details={[['Contents', 'One row per item: staff and faculty emails, roles, capabilities and decisions. No student data. The export is recorded in the audit log.']]}
      onCancel={() => setExporting(null)}
      onConfirm={async (reasonCode) => { await download(exporting, reasonCode); setExporting(null); }} /> : null}
  </section>;
}

/** Every write here opens this: it collects the reason code (and an optional note) and shows the effect. */
function ReasonDialog({ title, reasons, details, withNote = false, confirmLabel, onCancel, onConfirm }: {
  readonly title: string; readonly reasons: readonly string[]; readonly details: readonly (readonly [string, string])[];
  readonly withNote?: boolean; readonly confirmLabel: string;
  readonly onCancel: () => void; readonly onConfirm: (reasonCode: string, note: string | undefined) => Promise<void>;
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
      await onConfirm(reasonCode, note.trim() || undefined);
    } catch (cause) {
      setError(formatApiError(cause, 'This could not be completed.'));
      setBusy(false);
    }
  };
  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="access-review-dialog-title">
      <h2 id="access-review-dialog-title">{title}</h2>
      <dl>{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        {withNote ? <label><span>Note (optional, {noteLimit} characters) — do not include personal data</span>
          <textarea value={note} maxLength={noteLimit} onChange={(event) => setNote(event.target.value)} /></label> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </form>
    </section>
  </div>;
}
