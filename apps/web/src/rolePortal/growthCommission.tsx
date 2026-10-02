/**
 * ONE · Role portal — Growth → Commission (GROWTH-07; design §8, §10.8, §16.1).
 *
 * What exists today is credit, not money: the colleges and employers credited to the person, the
 * disputes they are party to, and the organisations they may still dispute within 90 days of a
 * handoff. Every amount slot reads NA — commission amounts are later goals and no rate has been set —
 * and employers say "Employer commission on hold — not decided" (D11). Nothing is invented.
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  getGrowthAttributions,
  getProtectedAccessToken,
  openGrowthAttributionDispute,
  type GrowthAttributionsDto,
} from '../api.js';
import { V2Chip, V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { formatApiError } from './shared.js';

const NA = 'NA';

const basisLabels: Readonly<Record<string, string>> = {
  LEAD_OWNER_AT_HANDOFF: 'You owned the lead at handoff',
  REFERRAL_LINK: 'Your referral link',
  DISPUTE_DECISION: 'Decided on a dispute',
  MANUAL_CORRECTION: 'Reassigned by operations',
};
const endedLabels: Readonly<Record<string, string>> = {
  REASSIGNED: 'Reassigned to someone else',
  DISPUTE_DECISION: 'Changed by a dispute decision',
  CORRECTION: 'Ended as a correction',
  ORGANIZATION_EXITED: 'The organisation left ONE',
};
const stateLabels: Readonly<Record<string, string>> = { OPEN: 'Open', UPHELD: 'Upheld', REJECTED: 'Rejected' };

function day(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString() : NA;
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: GrowthAttributionsDto }
  | { readonly kind: 'forbidden' | 'error'; readonly reference: string | null };

export function GrowthCommissionPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [organizationId, setOrganizationId] = useState('');
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    getGrowthAttributions(token, controller.signal)
      .then((data) => setState({ kind: 'ready', data }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const reference = cause instanceof ApiRequestError ? cause.correlationId : null;
        setState({ kind: cause instanceof ApiRequestError && cause.status === 403 ? 'forbidden' : 'error', reference });
      });
    return () => controller.abort();
  }, [token]);

  if (state.kind === 'forbidden') {
    return <V2EmptyState icon="🔐" title="Not permitted" note="Commission is for AI8HT's partnerships staff. Your access has not changed."
      {...(state.reference ? { hint: `Reference: ${state.reference}` } : {})} />;
  }
  const data = state.kind === 'ready' ? state.data : null;
  const live = (data?.credited ?? []).filter((credit) => !credit.endedAt);
  const ended = (data?.credited ?? []).filter((credit) => credit.endedAt);
  const openDisputes = (data?.disputes ?? []).filter((dispute) => dispute.state === 'OPEN').length;
  const choosable = (data?.disputable ?? []).filter((item) => !item.disputeOpen);
  const ready = token && organizationId && statement.trim().length >= 1 && statement.trim().length <= 2000;

  async function submit(): Promise<void> {
    if (!token || !ready) return;
    setBusy(true);
    try {
      const result = await openGrowthAttributionDispute(token, { organizationId, statement: statement.trim() });
      setState({ kind: 'ready', data: result });
      setOrganizationId(''); setStatement(''); setError('');
      setNotice('Your dispute is open. A growth admin who is not part of it will decide; you will see the outcome here.');
    } catch (cause) {
      setError(formatApiError(cause, 'The dispute could not be opened.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">ONE · Growth · Commission</p>
            <h1>Credit and commission</h1>
            <p>{state.kind === 'loading' ? 'Loading what is credited to you…'
              : state.kind === 'error' ? 'Your credit could not be loaded. Try again shortly.'
                : 'The colleges and employers credited to you, as AI8HT recorded them at each handoff. Commission amounts are not built yet, so no amount is shown.'}</p>
            <div className="v2-hero-chips">
              <V2Chip tone="slate">Rate not set</V2Chip>
              <V2Chip tone="amber">Employer commission on hold</V2Chip>
            </div>
          </div>
        </div>

        <div className="v2-row v2-cols-4" role="region" aria-label="Credit summary">
          <V2Stat icon="🏛️" tone="blue" value={data ? live.filter((credit) => credit.organizationKind === 'INSTITUTION').length : NA} label="Colleges credited" />
          <V2Stat icon="🏢" tone="teal" value={data ? live.filter((credit) => credit.organizationKind === 'EMPLOYER').length : NA} label="Employers credited" />
          <V2Stat icon="⚖️" tone="amber" value={data ? openDisputes : NA} label="Open disputes" />
          <V2Stat icon="₹" tone="purple" value={NA} label="Commission this month" />
        </div>

        <section className="v2-card" aria-label="Credited to you">
          <div className="v2-card-head"><h2>Credited to you</h2><V2Chip tone="slate">Recorded at handoff</V2Chip></div>
          {state.kind === 'loading' ? <p className="v2-empty">Loading…</p>
            : state.kind === 'error' ? <p className="v2-empty">{NA} — your credit could not be loaded.</p>
              : live.length ? (
                <div className="v2-list">
                  {live.map((credit) => (
                    <div key={credit.attributionId} className="v2-list-row">
                      <span className="v2-tile teal" aria-hidden="true">{credit.organizationKind === 'INSTITUTION' ? '🏛️' : '🏢'}</span>
                      <div className="grow"><strong>{credit.organizationName}</strong>
                        <small>{basisLabels[credit.basis] ?? credit.basis} · since {day(credit.since)}</small>
                        <small>{credit.commission === 'EMPLOYER_ON_HOLD' ? 'Employer commission on hold — not decided' : 'Commission: NA — not built yet; no rate has been set'}</small></div>
                      {credit.disputeOpen ? <V2Chip tone="amber">Dispute open</V2Chip> : <V2Chip tone="green">Credited</V2Chip>}
                    </div>
                  ))}
                </div>
              ) : <p className="v2-empty">Nothing is credited to you yet. A college is credited to its lead&apos;s owner when operations link its handoff; an employer to the referral link, else the lead owner, when operations onboard it.</p>}
          {ended.length ? <>
            <h3>No longer credited</h3>
            <ul className="role-check-list">{ended.map((credit) => <li key={credit.attributionId}>
              <strong>{credit.organizationName}</strong> <small>{day(credit.since)} to {day(credit.endedAt)} · {endedLabels[credit.endedReasonCode ?? ''] ?? NA}</small>
            </li>)}</ul>
          </> : null}
        </section>

        <section className="v2-card" aria-label="Your disputes">
          <div className="v2-card-head"><h2>Your disputes</h2></div>
          {data && data.disputes.length ? (
            <div className="v2-list">
              {data.disputes.map((dispute) => (
                <div key={dispute.disputeId} className="v2-list-row">
                  <span className="v2-tile amber" aria-hidden="true">⚖️</span>
                  <div className="grow"><strong>{dispute.organizationName}</strong>
                    <small>{dispute.role === 'CLAIMANT' ? 'You claimed this credit' : 'Someone disputes credit for this organisation'}{dispute.origin === 'ONBOARDING_CONFLICT' ? ' (a referral and a lead owner differed at onboarding)' : ''} · opened {day(dispute.openedAt)}</small>
                    {dispute.statement ? <small>Your statement: {dispute.statement}</small> : null}</div>
                  <V2Chip tone={dispute.state === 'OPEN' ? 'amber' : dispute.state === 'UPHELD' ? 'green' : 'slate'}>{stateLabels[dispute.state] ?? dispute.state}</V2Chip>
                </div>
              ))}
            </div>
          ) : <p className="v2-empty">{data ? 'You are not party to any dispute.' : NA}</p>}
        </section>

        <section className="v2-card" aria-label="Dispute a credit">
          <div className="v2-card-head"><h2>Dispute a credit</h2><V2Chip tone="slate">{data ? `Within ${data.windowDays} days of handoff` : NA}</V2Chip></div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {choosable.length ? <div className="role-actions">
            <label>Organisation<select aria-label="Organisation to dispute" value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
              <option value="">Choose…</option>
              {choosable.map((item) => <option key={item.organizationId} value={item.organizationId}>{item.organizationName} (until {day(item.windowEndsAt)})</option>)}
            </select></label>
            <label>What you did, and why the credit should be yours<textarea aria-label="Dispute statement" value={statement} maxLength={2000} rows={4} onChange={(event) => setStatement(event.target.value)} /></label>
            <button type="button" className="pilot-btn" disabled={!ready || busy} onClick={() => void submit()}>Open dispute</button>
          </div> : <p className="v2-empty">{data ? 'There is nothing you can dispute right now. You can dispute an organisation you had a lead or referral for, within 90 days of its handoff.' : NA}</p>}
        </section>
      </div>

      <div className="v2-rail">
        <section className="v2-card">
          <div className="v2-card-head"><h2>How credit works</h2></div>
          <p className="v2-empty">A college is credited to whoever owned its lead when operations linked the handoff. An employer is credited to the referral link it came through, else to its lead&apos;s owner; if those are different people, nobody is credited until a growth admin decides. A change is always recorded with who made it and why.</p>
        </section>
        <section className="v2-card">
          <div className="v2-card-head"><h2>Commission amounts</h2><V2Chip tone="slate">Not built yet</V2Chip></div>
          <p className="v2-empty">Amounts come only from rates operations set, and no rate has been set, so every amount reads NA. Employer commission is on hold until it is decided.</p>
        </section>
        <section className="v2-card">
          <div className="v2-card-head"><h2>If you leave</h2></div>
          <p className="v2-empty">You keep credit for what you earned. What becomes payable within 90 days of leaving is settled; after that, operations may reassign the credit.</p>
        </section>
      </div>
    </div>
  );
}
