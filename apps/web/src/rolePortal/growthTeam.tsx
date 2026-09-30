/**
 * ONE · Role portal — Operations Settings: Growth team (GROWTH-01, ADR-040).
 *
 * A GROWTH_ADMIN holder invites growth people (a staff type is required), sets each person's
 * team and manager, changes their staff type with a reason, removes them from a team and ends
 * their membership. Every change needs a reason code from the server's fixed list, because the
 * rows it writes are the history a later commission dispute or payout depends on.
 *
 * It is a section of Settings, not a navigation item, and renders nothing at all for an
 * operator without GROWTH_ADMIN. The server decides everything; this screen only withholds
 * controls it knows will be refused (your own membership, inactive members).
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  endGrowthMembership,
  endGrowthTeam,
  getProtectedAccessToken,
  inviteGrowthPerson,
  listGrowthTeam,
  revokeGrowthInvitation,
  setGrowthStaffType,
  setGrowthTeam,
  type GrowthTeamDirectoryDto,
  type GrowthTeamMemberDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { formatApiError } from './shared.js';

const roleLabels: Readonly<Record<string, string>> = { GROWTH_EXECUTIVE: 'Growth executive', GROWTH_MANAGER: 'Regional manager' };
const teamLabels: Readonly<Record<string, string>> = { COLLEGE_PARTNERSHIPS: 'College partnerships', EMPLOYER_PARTNERSHIPS: 'Employer partnerships' };
const typeLabels: Readonly<Record<string, string>> = { EMPLOYEE: 'Employee', CONTRACTOR: 'Contractor' };

function reasonLabel(code: string): string {
  return code.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (char) => char.toUpperCase());
}

export function OperationsGrowthTeamPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [directory, setDirectory] = useState<GrowthTeamDirectoryDto | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [invite, setInvite] = useState({ email: '', role: '', staffType: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    listGrowthTeam(token, controller.signal)
      .then((result) => { setDirectory(result); setError(''); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbidden(true);
        else setError(formatApiError(cause, 'Unable to load the growth team.'));
      });
    return () => controller.abort();
  }, [token, reload]);

  // Not a GROWTH_ADMIN holder: this section does not exist for them.
  if (!token || forbidden) return null;
  if (!directory && !error) return null;

  async function run(action: () => Promise<unknown>, done: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      setNotice(done);
      setError('');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The change could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  const members = directory?.members ?? [];
  const reasons = directory?.vocabulary.reasons;
  const canInvite = Boolean(invite.email.trim() && invite.role && invite.staffType) && !busy;

  return <section className="role-module role-module--dense" aria-labelledby="growth-team-heading">
    <div className="role-page-heading"><div><span className="eyebrow">Settings</span><h1 id="growth-team-heading">Growth team</h1>
      <p>AI8HT&apos;s partnerships field staff: who they are, which team they work in, who they report to, and whether they are an employee or a contractor. Growth people hold no Operations access. ONE records the staff type only; it computes nothing from it.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🧭" tone="teal" value={directory ? members.filter((member) => member.state === 'ACTIVE').length : 'NA'} label="Active growth people" />
      <V2Stat icon="✉️" tone="amber" value={directory ? directory.invitations.length : 'NA'} label="Pending invitations" />
      <V2Stat icon="🏛️" tone="blue" value={directory ? members.filter((member) => member.teams.some((team) => team.team === 'COLLEGE_PARTNERSHIPS')).length : 'NA'} label="College team" />
      <V2Stat icon="🏢" tone="purple" value={directory ? members.filter((member) => member.teams.some((team) => team.team === 'EMPLOYER_PARTNERSHIPS')).length : 'NA'} label="Employer team" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}

    <section className="role-card role-wide"><h2>Invite a growth person</h2>
      <p>The invitation is emailed to the address given; the person joins when they accept it. A staff type is required.</p>
      <div className="role-actions">
        <label>Invitee email<input type="email" value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} /></label>
        <label>Growth role<select aria-label="Growth role" value={invite.role} onChange={(event) => setInvite({ ...invite, role: event.target.value })}>
          <option value="">Choose…</option>
          {(directory?.vocabulary.roles ?? []).map((role) => <option key={role} value={role}>{roleLabels[role] ?? role}</option>)}
        </select></label>
        <label>Staff type<select aria-label="Staff type" value={invite.staffType} onChange={(event) => setInvite({ ...invite, staffType: event.target.value })}>
          <option value="">Choose…</option>
          {(directory?.vocabulary.staffTypes ?? []).map((type) => <option key={type} value={type}>{typeLabels[type] ?? type}</option>)}
        </select></label>
        <button type="button" className="pilot-btn" disabled={!canInvite} onClick={() => void run(async () => {
          await inviteGrowthPerson(token, { email: invite.email.trim(), role: invite.role, staffType: invite.staffType });
          setInvite({ email: '', role: '', staffType: '' });
        }, 'Invitation sent. The person joins when they accept it.')}>Send growth invitation</button>
      </div>
      {(directory?.invitations ?? []).length ? <ul className="role-check-list">{(directory?.invitations ?? []).map((invitation) => <PendingInvitation key={invitation.id}
        invitation={invitation} reasons={reasons?.revokeInvitation ?? []} busy={busy}
        onRevoke={(reasonCode) => void run(() => revokeGrowthInvitation(token, invitation.id, { reasonCode }), 'Invitation revoked.')} />)}</ul>
        : <p>No invitations are pending.</p>}
    </section>

    <section className="role-card role-wide"><h2>Growth people</h2>
      {directory && !members.length ? <V2EmptyState icon="🧭" title="No growth people yet" note="Nobody has joined the Growth team. Invite someone above." /> : null}
      {directory?.truncated ? <p>Showing the first 200 growth people.</p> : null}
      {members.map((member) => <GrowthPerson key={member.membershipId} member={member} directory={directory!} busy={busy}
        onStaffType={(staffType, reasonCode) => void run(() => setGrowthStaffType(token, member.membershipId, { staffType, reasonCode }), 'Staff type saved.')}
        onTeam={(team, managerMembershipId, reasonCode) => void run(() => setGrowthTeam(token, member.membershipId, { team, managerMembershipId, reasonCode }), 'Team saved.')}
        onLeaveTeam={(team, reasonCode) => void run(() => endGrowthTeam(token, member.membershipId, team, { reasonCode }), 'Removed from the team.')}
        onEnd={(reasonCode) => void run(() => endGrowthMembership(token, member.membershipId, { reasonCode }), 'Membership ended.')} />)}
    </section>
  </section>;
}

function PendingInvitation({ invitation, reasons, busy, onRevoke }: {
  readonly invitation: GrowthTeamDirectoryDto['invitations'][number]; readonly reasons: readonly string[]; readonly busy: boolean; readonly onRevoke: (reasonCode: string) => void;
}): React.ReactElement {
  const [reason, setReason] = useState('');
  return <li>
    <strong>{invitation.email}</strong> · {roleLabels[invitation.role] ?? invitation.role} · {typeLabels[invitation.staffType] ?? invitation.staffType}
    {' '}<small>Email: {reasonLabel(invitation.delivery.state)}{invitation.expiresAt ? ` · expires ${new Date(invitation.expiresAt).toLocaleDateString()}` : ''}</small>
    <span className="role-actions">
      <select value={reason} aria-label={`Reason for revoking the invitation to ${invitation.email}`} onChange={(event) => setReason(event.target.value)}>
        <option value="">Reason…</option>
        {reasons.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
      </select>
      <button type="button" className="pilot-btn" disabled={!reason || busy} onClick={() => onRevoke(reason)}>Revoke</button>
    </span>
  </li>;
}

function GrowthPerson({ member, directory, busy, onStaffType, onTeam, onLeaveTeam, onEnd }: {
  readonly member: GrowthTeamMemberDto;
  readonly directory: GrowthTeamDirectoryDto;
  readonly busy: boolean;
  readonly onStaffType: (staffType: string, reasonCode: string) => void;
  readonly onTeam: (team: string, managerMembershipId: string | null, reasonCode: string) => void;
  readonly onLeaveTeam: (team: string, reasonCode: string) => void;
  readonly onEnd: (reasonCode: string) => void;
}): React.ReactElement {
  const [type, setType] = useState('');
  const [typeReason, setTypeReason] = useState('');
  const [team, setTeam] = useState('');
  const [manager, setManager] = useState('');
  const [teamReason, setTeamReason] = useState('');
  const [leaveReason, setLeaveReason] = useState('');
  const [endReason, setEndReason] = useState('');
  const reasons = directory.vocabulary.reasons;
  const current = member.staffType?.staffType ?? null;
  const typeReasons = current ? reasons.changeStaffType : reasons.initialStaffType;
  const editable = member.state === 'ACTIVE' && !member.isSelf;

  return <article className="role-card" aria-label={member.email}>
    <h3>{member.email}{member.isSelf ? ' (you)' : ''}</h3>
    <p><span>{roleLabels[member.role] ?? member.role}</span> · <StatusBadge label={member.state} tone={member.state === 'ACTIVE' ? 'success' : 'neutral'} />
      {' '}· <span>{current ? typeLabels[current] ?? current : 'Staff type not set'}</span></p>
    {member.teams.length ? <ul>{member.teams.map((entry) => <li key={entry.team}>
      {teamLabels[entry.team] ?? entry.team} — {entry.manager ? `manager ${entry.manager.email ?? 'NA'}` : 'no manager recorded'}
      {editable ? <button type="button" className="pilot-btn" disabled={!leaveReason || busy} onClick={() => onLeaveTeam(entry.team, leaveReason)}>Remove from {teamLabels[entry.team] ?? entry.team}</button> : null}
    </li>)}</ul> : <p>Not on a team yet.</p>}
    {!editable ? <small>{member.isSelf ? 'Your own growth membership is changed by another operator.' : 'Only an active membership can be changed.'}</small> : <>
      {member.teams.length ? <label>Reason for leaving a team<select aria-label="Reason for leaving a team" value={leaveReason} onChange={(event) => setLeaveReason(event.target.value)}>
        <option value="">Reason…</option>{reasons.leaveTeam.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
      </select></label> : null}
      <div className="role-actions">
        <label>New staff type<select aria-label="New staff type" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="">Choose…</option>
          {directory.vocabulary.staffTypes.filter((value) => value !== current).map((value) => <option key={value} value={value}>{typeLabels[value] ?? value}</option>)}
        </select></label>
        <label>Reason for the type<select aria-label="Reason for the type" value={typeReason} onChange={(event) => setTypeReason(event.target.value)}>
          <option value="">Reason…</option>{typeReasons.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
        </select></label>
        <button type="button" className="pilot-btn" disabled={!type || !typeReason || busy} onClick={() => onStaffType(type, typeReason)}>Save staff type</button>
      </div>
      <div className="role-actions">
        <label>Team<select aria-label="Team" value={team} onChange={(event) => setTeam(event.target.value)}>
          <option value="">Choose…</option>
          {directory.vocabulary.teams.map((value) => <option key={value} value={value}>{teamLabels[value] ?? value}</option>)}
        </select></label>
        <label>Manager<select aria-label="Manager" value={manager} onChange={(event) => setManager(event.target.value)}>
          <option value="">No manager</option>
          {directory.managers.filter((option) => option.membershipId !== member.membershipId).map((option) => <option key={option.membershipId} value={option.membershipId}>{option.email}</option>)}
        </select></label>
        <label>Reason for the team change<select aria-label="Reason for the team change" value={teamReason} onChange={(event) => setTeamReason(event.target.value)}>
          <option value="">Reason…</option>{reasons.joinTeam.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
        </select></label>
        <button type="button" className="pilot-btn" disabled={!team || !teamReason || busy} onClick={() => onTeam(team, manager || null, teamReason)}>Save team</button>
      </div>
      <div className="role-actions">
        <label>Reason for ending<select aria-label="Reason for ending" value={endReason} onChange={(event) => setEndReason(event.target.value)}>
          <option value="">Reason…</option>{reasons.endMembership.map((code) => <option key={code} value={code}>{reasonLabel(code)}</option>)}
        </select></label>
        <button type="button" className="pilot-btn" disabled={!endReason || busy} onClick={() => onEnd(endReason)}>End membership</button>
      </div>
    </>}
  </article>;
}
