/**
 * ONE · Growth — "Your employer referral links" (GROWTH-05; design §7.2).
 *
 * A growth person on the employer partnerships team creates a referral link, shares it with a
 * company, and sees how many access requests each link brought, by state. The link is the public
 * "Request employer access" page with a random code: it carries nothing about the person, opens
 * nothing, and the form answers the same whether a code is valid or not. Limits (live links, links a
 * day) are the server's; this card only reports them. Shown on the Leads page — no new navigation.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ApiRequestError,
  createGrowthReferralCode,
  listGrowthReferralCodes,
  revokeGrowthReferralCode,
  type GrowthReferralCodesDto,
} from '../api.js';
import { V2Chip } from '../dashboardsV2.js';
import { formatApiError } from './shared.js';
import { formatDate } from '../dates.js';

const NA = 'NA';

function referralError(cause: unknown, fallback: string): string {
  if (cause instanceof ApiRequestError) {
    if (cause.code === 'GROWTH_REFERRAL_CODE_LIMIT') return 'You already have the most live links allowed. Revoke one you no longer share first.';
    if (cause.code === 'GROWTH_REFERRAL_CODE_DAILY_LIMIT') return 'You have created the most links allowed today. Try again tomorrow.';
    if (cause.code === 'GROWTH_TEAM_MISMATCH') return 'Referral links are for the employer partnerships team.';
  }
  return formatApiError(cause, fallback);
}

export function GrowthReferralLinksCard({ token }: { readonly token: string }): React.ReactElement {
  const [data, setData] = useState<GrowthReferralCodesDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    const controller = new AbortController();
    listGrowthReferralCodes(token, controller.signal)
      .then((result) => {
        if (!Array.isArray(result.codes)) throw new Error('malformed referral codes');
        setData(result); setError('');
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(referralError(cause, 'Your referral links could not be loaded.')); });
    return () => controller.abort();
  }, [token, reload]);

  async function act(action: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      key.current = crypto.randomUUID();
      setNotice(done);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(referralError(cause, 'That change could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function copy(link: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setNotice('Link copied.');
    } catch {
      setNotice(`Copy this link: ${link}`);
    }
  }

  const live = (data?.codes ?? []).filter((code) => !code.revokedAt);
  const revoked = (data?.codes ?? []).filter((code) => code.revokedAt);
  return <section className="v2-card" aria-label="Your employer referral links">
    <div className="v2-card-head"><h2>Your employer referral links</h2>{data ? <V2Chip tone="blue">{live.length} live</V2Chip> : null}</div>
    <p className="v2-empty">Share a link with a company you are working. It opens the public request form; operations see that the request came through your link. The link carries a random code and nothing about you.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {!data ? (error ? null : <p className="v2-empty">Loading…</p>) : !data.eligible && !data.codes.length
      ? <p className="v2-empty">Referral links are for the employer partnerships team.</p>
      : <>
        {live.length ? <div className="v2-list">{live.map((code) => {
          const link = `${window.location.origin}${code.linkPath}`;
          return <div key={code.id} className="v2-list-row">
            <span className="v2-tile teal" aria-hidden="true">🔗</span>
            <div className="grow"><strong>{code.code}</strong><small>{link}</small>
              <small>{code.referrals.pending} waiting · {code.referrals.onboarded} onboarded · {code.referrals.closed} closed</small></div>
            <div className="role-actions">
              <button type="button" className="pilot-btn" onClick={() => void copy(link)} aria-label={`Copy link ${code.code}`}>Copy</button>
              <button type="button" className="secondary" disabled={busy} aria-label={`Revoke link ${code.code}`}
                onClick={() => void act(() => revokeGrowthReferralCode(token, code.id), `Link ${code.code} revoked. A company that opens it can still send a request; it just will not be marked as yours.`)}>Revoke</button>
            </div>
          </div>;
        })}</div> : <p className="v2-empty">No live link yet.</p>}
        {data.eligible ? <button type="button" className="pilot-btn" disabled={busy || live.length >= data.limits.liveCodesPerPerson}
          onClick={() => void act(() => createGrowthReferralCode(token, key.current), 'New referral link created.')}>New referral link</button> : null}
        <small>Up to {data.limits.liveCodesPerPerson ?? NA} live links and {data.limits.createdPerDay ?? NA} new links a day. Links stop working if you leave the employer team.</small>
        {revoked.length ? <details><summary>Revoked links ({revoked.length})</summary><ul>{revoked.map((code) => <li key={code.id}>
          {code.code} · revoked {code.revokedAt ? formatDate(code.revokedAt) : NA} · {code.referrals.onboarded} onboarded
        </li>)}</ul></details> : null}
      </>}
  </section>;
}
