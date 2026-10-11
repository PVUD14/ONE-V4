/**
 * ONE · Role portal — Operations Settings: Staff and capabilities (OPS-01, ADR-032).
 *
 * Lists the ONE platform organisation's staff memberships with what each can do —
 * the role's baseline plus explicit grants — and lets a CAPABILITY_ADMIN holder grant
 * or revoke a capability. Every change goes through a confirm step that requires a
 * reason code from the server's fixed list, because the grant record exists to answer
 * "who could do what, and why" later. A high-risk grant files an approval request
 * instead (OPS-02) and is carried out from the Approvals queue once approved.
 *
 * The server decides everything: this screen only hides buttons it knows will be
 * refused (your own membership, capabilities already held) and says why.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, getProtectedAccessToken, grantStaffCapability, listOperationsStaff, revokeStaffCapability } from '../api.js';
import type { StaffDirectoryDto, StaffMemberDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError, RestrictedApiState } from './shared.js';
import { RequestApprovalDialog } from './approvals.js';
import { SupportCode } from '../supportCode.js';
import { formatDate } from '../dates.js';
import { codeLabel, roleLabel } from '../labels.js';

type PendingChange =
  | { readonly kind: 'grant'; readonly member: StaffMemberDto; readonly capability: string }
  | { readonly kind: 'revoke'; readonly member: StaffMemberDto; readonly capability: string };

const noteLimit = 500;

export function OperationsStaffCapabilitiesPage(): React.ReactElement {
  const token = getProtectedAccessToken();
  const [directory, setDirectory] = useState<StaffDirectoryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbiddenReference, setForbiddenReference] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLoading(true);
    listOperationsStaff(token, null, controller.signal)
      .then((result) => { setDirectory(result); setError(''); setForbiddenReference(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbiddenReference(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load staff and capabilities.'));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, reload]);

  if (!token) return <RestrictedApiState title="Staff and capabilities" message="Sign in with an authorized platform identity to manage internal staff access." />;

  const heading = <div className="role-page-heading"><div><span className="eyebrow">Settings</span><h1>Staff and capabilities</h1>
    <p>What each AI8HT staff member can do in the Operations portal: the baseline that comes with their role, plus capabilities granted to them explicitly. Every grant and revoke records who made it and why.</p></div></div>;

  if (forbiddenReference) {
    return <section className="role-module role-module--dense">{heading}
      <div className="role-wide"><V2EmptyState illustration="no-access" icon="🔐" title="Not permitted"
        note="Managing staff capabilities needs the Capability Admin capability. Your access has not changed."
        hint={<SupportCode reference={forbiddenReference} />} /></div></section>;
  }

  const staff = directory?.staff ?? [];
  const liveGrants = staff.reduce((total, member) => total + member.grants.length, 0);
  const highRiskGrants = staff.reduce((total, member) => total + member.grants.filter((grant) => grant.highRisk).length, 0);
  const catalogue = directory?.capabilities ?? [];
  const highRisk = new Set(catalogue.filter((entry) => entry.highRisk).map((entry) => entry.capability));

  const grantable = (member: StaffMemberDto): readonly string[] => catalogue
    // GROWTH-01: a growth role can be granted nothing, and the growth capabilities go to
    // operations admins only; the server refuses anything else, so it is not offered.
    .filter((entry) => entry.grantableHere && (entry.grantableToRoles ?? [member.role]).includes(member.role) && !member.effective.includes(entry.capability))
    .map((entry) => entry.capability);

  const completed = (message: string): void => {
    setPending(null);
    setNotice(message);
    setReload((value) => value + 1);
  };

  return <section className="role-module role-module--dense">
    {heading}
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👥" tone="teal" value={directory ? staff.length : undefined} label="Staff memberships" />
      <V2Stat icon="✅" tone="blue" value={directory ? staff.filter((member) => member.state === 'ACTIVE').length : undefined} label="Active" />
      <V2Stat icon="🔑" tone="purple" value={directory ? liveGrants : undefined} label="Live explicit grants" />
      <V2Stat icon="⚠️" tone="amber" value={directory ? highRiskGrants : undefined} label="High-risk grants" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <section className="role-card role-wide"><h2>Platform staff</h2>
      {loading && !directory ? <p>Loading staff…</p> : null}
      {!loading && directory && !staff.length ? <V2EmptyState icon="👥" title="No platform staff yet"
        note="No memberships exist in the ONE platform organisation, so there is nothing to grant." /> : null}
      {staff.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Staff member</th><th>Role</th><th>State</th><th>Baseline</th><th>Explicit grants</th><th>Grant a capability</th></tr></thead>
        <tbody>{staff.map((member) => {
          const options = grantable(member);
          const choice = selected[member.membershipId] ?? '';
          const locked = member.isSelf || member.state !== 'ACTIVE';
          return <tr key={member.membershipId}>
            <td>{member.email}{member.isSelf ? <><br /><small>You</small></> : null}</td>
            <td>{roleLabel(member.role)}</td>
            <td><StatusBadge label={member.state} tone={member.state === 'ACTIVE' ? 'success' : 'neutral'} /></td>
            <td>{member.state === 'ACTIVE' ? `${member.baseline.length} capabilities` : 'None while not active'}</td>
            <td>{member.grants.length ? <ul>{member.grants.map((grant) => <li key={grant.capability}>
              <StatusBadge label={grant.capability} tone={grant.highRisk ? 'warning' : 'info'} />{' '}
              <small>{codeLabel(grant.reasonCode)} · {formatDate(grant.grantedAt)}</small>{' '}
              {member.isSelf ? null : <button type="button" className="pilot-btn" onClick={() => setPending({ kind: 'revoke', member, capability: grant.capability })}
                aria-label={`Revoke ${codeLabel(grant.capability)} from ${member.email}`}>Revoke</button>}
            </li>)}</ul> : 'None'}</td>
            <td>{locked
              ? <small>{member.isSelf ? 'Your own access is changed by another operator.' : 'Only active memberships can be granted capabilities.'}</small>
              : options.length
                ? <div className="role-actions">
                  <select value={choice} aria-label={`Capability for ${member.email}`}
                      onChange={(event) => setSelected({ ...selected, [member.membershipId]: event.target.value })}>
                      <option value="">Choose…</option>
                      {options.map((capability) => <option key={capability} value={capability}>{codeLabel(capability)}{highRisk.has(capability) ? ' (high-risk)' : ''}</option>)}
                  </select>
                  <button type="button" className="pilot-btn" disabled={!choice}
                    onClick={() => setPending({ kind: 'grant', member, capability: choice })}>Grant…</button>
                </div>
                : <small>Holds every capability that can be granted here.</small>}</td>
          </tr>;
        })}</tbody></table></div> : null}
    </section>
    {pending && directory && pending.kind === 'grant' && highRisk.has(pending.capability)
      // OPS-02: a high-risk grant files an approval request; it is granted from the Approvals queue once approved.
      ? <RequestApprovalDialog token={token} actionKey="CAPABILITY_GRANT_HIGH_RISK"
        payload={{ membershipId: pending.member.membershipId, capability: pending.capability }}
        title={`Grant ${codeLabel(pending.capability)}`} reasons={directory.grantReasons}
        details={[['Staff member', pending.member.email], ['Role', roleLabel(pending.member.role)], ['Capability', `${codeLabel(pending.capability)} (high-risk)`]]}
        onCancel={() => setPending(null)} onFiled={(message) => { setPending(null); setNotice(message); }} />
      : pending && directory ? <ConfirmCapabilityChange token={token} change={pending} directory={directory}
        onCancel={() => setPending(null)} onDone={completed} /> : null}
  </section>;
}

function ConfirmCapabilityChange({ token, change, directory, onCancel, onDone }: {
  readonly token: string; readonly change: PendingChange; readonly directory: StaffDirectoryDto;
  readonly onCancel: () => void; readonly onDone: (message: string) => void;
}): React.ReactElement {
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => { firstFieldRef.current?.focus(); }, []);

  const grant = change.kind === 'grant';
  const reasons = grant ? directory.grantReasons : directory.revokeReasons;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reasonCode) { setError('Choose a reason code.'); return; }
    setBusy(true);
    try {
      const body = { reasonCode, ...(note.trim() ? { note: note.trim() } : {}) };
      if (grant) await grantStaffCapability(token, change.member.membershipId, { capability: change.capability, ...body });
      else await revokeStaffCapability(token, change.member.membershipId, change.capability, body);
      onDone(`${codeLabel(change.capability)} ${grant ? 'granted to' : 'revoked from'} ${change.member.email}.`);
    } catch (cause) {
      setError(formatApiError(cause, grant ? 'The capability could not be granted.' : 'The capability could not be revoked.'));
      setBusy(false);
    }
  };

  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="staff-capability-title">
      <h2 id="staff-capability-title">{grant ? 'Grant' : 'Revoke'} {codeLabel(change.capability)}</h2>
      <dl>
        <div><dt>Staff member</dt><dd>{change.member.email}</dd></div>
        <div><dt>Role</dt><dd>{roleLabel(change.member.role)}</dd></div>
        <div><dt>Approval</dt><dd>No second approval is required.</dd></div>
      </dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <label><span>Reason code <em>required</em></span>
          <select ref={firstFieldRef} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label>
        <label><span>Note (optional, {noteLimit} characters) — do not include personal data</span>
          <textarea value={note} maxLength={noteLimit} onChange={(event) => setNote(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy || !reasonCode}>{busy ? 'Saving…' : grant ? 'Confirm grant' : 'Confirm revoke'}</button>
        </div>
      </form>
    </section>
  </div>;
}
