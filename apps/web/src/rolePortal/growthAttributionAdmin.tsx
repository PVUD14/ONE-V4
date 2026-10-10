/**
 * ONE · Role portal — Operations → Settings → Growth attribution (GROWTH-07; design §8, §16.2).
 *
 * For a GROWTH_ADMIN holder: open disputes with the claimant's statement, the parties and the
 * evidence pointers, and a decision form; attributions by view (live, beneficiary left, ended) with
 * an organisation's full history; reassignment and ending, each with a reason. The server refuses a
 * decision, reassignment or end by anyone who is a party to it, and says so. A section of the existing
 * Settings page — no navigation item (O-24). Renders nothing without the capability. No amount.
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  decideGrowthAttributionDispute,
  endGrowthAttribution,
  getGrowthAttributionReassignOptions,
  getProtectedAccessToken,
  listGrowthAdminAttributions,
  listGrowthAdminDisputes,
  reassignGrowthAttribution,
  type GrowthAdminAttributionDto,
  type GrowthAdminAttributionsDto,
  type GrowthAdminDisputeDto,
} from '../api.js';
import { V2Chip, V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { growthCodeLabel } from './growthLeads.js';
import { formatApiError } from './shared.js';
import { formatDate } from '../dates.js';

type View = 'LIVE' | 'LEFT' | 'ENDED';

function day(value: string | null | undefined): string {
  return value ? formatDate(value) : 'NA';
}

export function OperationsGrowthAttributionPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [view, setView] = useState<View>('LIVE');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<GrowthAdminAttributionsDto | null>(null);
  const [disputes, setDisputes] = useState<readonly GrowthAdminDisputeDto[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    Promise.all([
      listGrowthAdminAttributions(token, { view, ...(search.trim() ? { q: search.trim() } : {}) }, controller.signal),
      listGrowthAdminDisputes(token, 'OPEN', controller.signal),
    ]).then(([attributions, open]) => { setData(attributions); setDisputes(open.disputes); setError(''); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbidden(true);
        else setError(formatApiError(cause, 'Growth attribution could not be loaded.'));
      });
    return () => controller.abort();
  }, [token, view, search, reload]);

  if (!token || forbidden) return null;
  if (!data && !error) return null;
  const refresh = (message: string) => { setNotice(message); setReload((value) => value + 1); };

  return <section className="role-module role-module--dense" aria-labelledby="growth-attribution-heading">
    <div className="role-page-heading"><div><span className="eyebrow">Settings</span><h1 id="growth-attribution-heading">Growth attribution</h1>
      <p>Who is credited for each college and employer. Decide disputes you are not party to, and reassign or end credit with a reason. Every change ends one record and writes another, so who was credited on any date stays answerable.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide" role="region" aria-label="Growth attribution summary">
      <V2Stat icon="🤝" tone="blue" value={data ? data.counts.live : 'NA'} label="Live credits" />
      <V2Stat icon="⚖️" tone="amber" value={data ? data.counts.openDisputes : 'NA'} label="Open disputes" />
      <V2Stat icon="🚪" tone="teal" value={data ? data.counts.beneficiaryLeft : 'NA'} label="Credited person left" />
      <V2Stat icon="🗂️" tone="purple" value={data ? data.counts.ended : 'NA'} label="Ended" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    <section className="role-card role-wide" aria-label="Open disputes">
      <h2>Open disputes</h2>
      {disputes.length ? disputes.map((dispute) => <DisputeCard key={dispute.disputeId} dispute={dispute} token={token}
        reasons={data?.vocabulary.decisionReasons ?? []} onDone={refresh} onError={setError} />)
        : <V2EmptyState icon="⚖️" title="No open disputes" note="A dispute appears here when a growth person claims credit, or when an employer's referral and lead owner differ at onboarding." />}
    </section>

    <section className="role-card role-wide" aria-label="Attributions">
      <h2>Attributions</h2>
      <div className="role-actions">
        <label>Show<select aria-label="Attribution view" value={view} onChange={(event) => setView(event.target.value as View)}>
          <option value="LIVE">Live</option><option value="LEFT">Credited person left</option><option value="ENDED">Ended</option>
        </select></label>
        <label>Search organisation or email<input aria-label="Search attributions" value={search} maxLength={120} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      {data && data.attributions.length ? <ul className="role-check-list">{data.attributions.map((row) => <AttributionRow key={row.attributionId} row={row} token={token}
        reassignReasons={data.vocabulary.reassignReasons} endReasons={data.vocabulary.endReasons} onDone={refresh} onError={setError} />)}</ul>
        : <V2EmptyState icon="🤝" title="No attributions" note="Nothing in this view." />}
    </section>
  </section>;
}

function DisputeCard({ dispute, token, reasons, onDone, onError }: {
  readonly dispute: GrowthAdminDisputeDto; readonly token: string; readonly reasons: readonly string[];
  readonly onDone: (message: string) => void; readonly onError: (message: string) => void;
}): React.ReactElement {
  const [outcome, setOutcome] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const conflict = dispute.origin === 'ONBOARDING_CONFLICT';
  return <article className="role-card" aria-label={`Dispute about ${dispute.organizationName}`}>
    <h3>{dispute.organizationName} <V2Chip tone="slate">{dispute.organizationKind === 'INSTITUTION' ? 'College' : 'Employer'}</V2Chip> <V2Chip tone="amber">{conflict ? 'Onboarding conflict' : 'Claim'}</V2Chip></h3>
    <p>{conflict ? `Referral by ${dispute.claimant.email}; lead owned by ${dispute.respondent?.email ?? 'NA'}.`
      : `${dispute.claimant.email} claims credit${dispute.respondent ? ` now held by ${dispute.respondent.email}` : ' (nobody is credited)'}.`}</p>
    {dispute.statement ? <blockquote>{dispute.statement}</blockquote> : null}
    <small>Opened {day(dispute.openedAt)} by {dispute.openedBy} · handed off {day(dispute.evidence.handedOffAt)}{dispute.evidence.leadName ? ` · lead ${dispute.evidence.leadName}` : ''}{dispute.evidence.onboardingCandidate ? ` · onboarding candidate ${growthCodeLabel(dispute.evidence.onboardingCandidate)}` : ''}</small>
    <div className="role-actions">
      <label>Decision<select aria-label={`Decision for ${dispute.organizationName}`} value={outcome} onChange={(event) => setOutcome(event.target.value)}>
        <option value="">Choose…</option>
        <option value="UPHELD">{conflict ? 'Uphold: credit the referrer' : 'Uphold: credit the claimant'}</option>
        <option value="REJECTED">{conflict ? 'Reject: credit the lead owner' : 'Reject: no change'}</option>
      </select></label>
      <label>Reason<select aria-label={`Reason for ${dispute.organizationName}`} value={reason} onChange={(event) => setReason(event.target.value)}>
        <option value="">Choose…</option>{reasons.map((code) => <option key={code} value={code}>{growthCodeLabel(code)}</option>)}
      </select></label>
      <label>Note{reason === 'OTHER' ? ' (required)' : ''}<input aria-label={`Note for ${dispute.organizationName}`} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></label>
      <button type="button" className="pilot-btn" disabled={busy || !outcome || !reason || (reason === 'OTHER' && !note.trim())} onClick={() => {
        setBusy(true);
        decideGrowthAttributionDispute(token, dispute.disputeId, { outcome, reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) })
          .then(() => onDone(`Dispute about ${dispute.organizationName} decided.`))
          .catch((cause: unknown) => onError(formatApiError(cause, 'The decision could not be recorded. You cannot decide a dispute you are party to.')))
          .finally(() => setBusy(false));
      }}>Record decision</button>
    </div>
  </article>;
}

function AttributionRow({ row, token, reassignReasons, endReasons, onDone, onError }: {
  readonly row: GrowthAdminAttributionDto; readonly token: string; readonly reassignReasons: readonly string[]; readonly endReasons: readonly string[];
  readonly onDone: (message: string) => void; readonly onError: (message: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<readonly { readonly userId: string; readonly email: string }[] | null>(null);
  const [toUserId, setToUserId] = useState('');
  const [reason, setReason] = useState('');
  const [endReason, setEndReason] = useState('');
  const [busy, setBusy] = useState(false);
  const live = !row.endedAt;

  function run(action: () => Promise<unknown>, message: string): void {
    setBusy(true);
    action().then(() => onDone(message))
      .catch((cause: unknown) => onError(formatApiError(cause, 'The change could not be recorded. You cannot move credit to or from yourself.')))
      .finally(() => setBusy(false));
  }

  return <li>
    <strong>{row.organizationName}</strong> <small>{row.organizationKind === 'INSTITUTION' ? 'College' : 'Employer'} · {row.beneficiary.email} · {growthCodeLabel(row.basis)} · since {day(row.since)}{row.endedAt ? ` · ended ${day(row.endedAt)} (${growthCodeLabel(row.endedReasonCode)})` : ''}</small>
    {row.leaver ? <> <V2Chip tone="amber">{row.leaver.leftAt ? `Left ${day(row.leaver.leftAt)}; settlement ends ${day(row.leaver.settlementEndsAt)}` : 'Left; leave date not recorded'}</V2Chip></> : null}
    {row.disputeOpen ? <> <V2Chip tone="amber">Dispute open</V2Chip></> : null}
    {live && !row.disputeOpen ? <> <button type="button" className="pilot-btn" aria-expanded={open} onClick={() => {
      setOpen(!open);
      if (!options) getGrowthAttributionReassignOptions(token, row.organizationKind).then((found) => setOptions(found.options)).catch(() => setOptions([]));
    }}>Change</button></> : null}
    {open && live ? <div className="role-actions">
      <label>Reassign to<select aria-label={`Reassign ${row.organizationName} to`} value={toUserId} onChange={(event) => setToUserId(event.target.value)}>
        <option value="">Choose…</option>{(options ?? []).filter((option) => option.userId !== row.beneficiary.userId).map((option) => <option key={option.userId} value={option.userId}>{option.email}</option>)}
      </select></label>
      <label>Reason<select aria-label={`Reassign reason for ${row.organizationName}`} value={reason} onChange={(event) => setReason(event.target.value)}>
        <option value="">Choose…</option>{reassignReasons.map((code) => <option key={code} value={code}>{growthCodeLabel(code)}</option>)}
      </select></label>
      <button type="button" className="pilot-btn" disabled={busy || !toUserId || !reason}
        onClick={() => run(() => reassignGrowthAttribution(token, row.attributionId, { toUserId, reasonCode: reason }), `Credit for ${row.organizationName} reassigned. It applies to what is earned from now on.`)}>Reassign</button>
      <label>Or end with<select aria-label={`End reason for ${row.organizationName}`} value={endReason} onChange={(event) => setEndReason(event.target.value)}>
        <option value="">Choose…</option>{endReasons.map((code) => <option key={code} value={code}>{growthCodeLabel(code)}</option>)}
      </select></label>
      <button type="button" className="pilot-btn" disabled={busy || !endReason}
        onClick={() => run(() => endGrowthAttribution(token, row.attributionId, { reasonCode: endReason }), `Credit for ${row.organizationName} ended; nobody is credited from now on.`)}>End credit</button>
    </div> : null}
  </li>;
}
