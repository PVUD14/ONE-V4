/**
 * ONE · Employer portal — Team (EMP-02).
 *
 * The screen behind the employer navigation's existing "Team" label, which said "Not built
 * yet" until the team API existed. Owners and admins see who is on the team, invite admins
 * and recruiters (interviewers join as recruiters, decision 10.2 #2), and revoke or resend
 * an invitation or end a membership — each with a confirmation and a reason code.
 *
 * Everything shown comes from GET /employers/:employerId/team; what an actor may do is the
 * server's answer (invitableRoles, canEnd, canRevoke), so this page never decides authority.
 * Email delivery is reported as the server recorded it: with no sender configured (HG-7) the
 * page says the invitation was not emailed rather than implying it was.
 */
import { useEffect, useState } from 'react';
import { getProtectedAccessToken } from '../api.js';
import {
  endEmployerTeamMembership,
  getEmployerTeam,
  inviteEmployerTeamMember,
  resendEmployerTeamInvitation,
  revokeEmployerTeamInvitation,
  type EmployerTeamDto,
  type EmployerTeamInvitationDto,
  type EmployerTeamMemberDto,
  type EmployerTeamRole,
} from '../api/hiring.js';
import { V2Stat } from '../dashboardsV2.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { formatApiError } from './shared.js';
import * as dates from '../dates.js';
import { MISSING_TEXT } from '../labels.js';

export const employerTeamRoleLabels: Readonly<Record<EmployerTeamRole, string>> = {
  EMPLOYER_OWNER: 'Owner',
  EMPLOYER_ADMIN: 'Admin',
  RECRUITER: 'Recruiter',
};

const deliveryLabels: Readonly<Record<string, string>> = {
  SENT: 'Email sent',
  NOT_CONFIGURED: 'Not emailed — email delivery is not set up yet',
  FAILED: 'Sending failed — use Resend',
  BOUNCED: 'Bounced — check the address',
  NOT_SENT: 'Not emailed yet',
};

const reasonLabels: Readonly<Record<string, string>> = {
  SENT_IN_ERROR: 'Sent in error',
  WRONG_EMAIL: 'Wrong email address',
  WRONG_ROLE: 'Wrong role',
  NO_LONGER_NEEDED: 'No longer needed',
  NOT_RECEIVED: 'Not received',
  LINK_EXPIRED: 'Link expired',
  LINK_LOST: 'Link lost',
  LEFT_ORGANISATION: 'Left the organisation',
  ROLE_CHANGE: 'Changing their role',
  ACCESS_NO_LONGER_NEEDED: 'Access no longer needed',
  SECURITY_CONCERN: 'Security concern',
};

type PendingAction =
  | { readonly kind: 'end'; readonly member: EmployerTeamMemberDto }
  | { readonly kind: 'revoke' | 'resend'; readonly invitation: EmployerTeamInvitationDto };

function formatDate(value: string | null): string {
  if (!value) return MISSING_TEXT;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? MISSING_TEXT : dates.formatDate(date);
}

function deliveryNote(state: string): string {
  if (state === 'SENT') return 'Invitation emailed.';
  if (state === 'NOT_CONFIGURED') return 'Invitation created, but not emailed: email delivery is not set up yet.';
  if (state === 'FAILED') return 'Invitation created, but the email could not be sent. Use Resend to try again.';
  if (state === 'BOUNCED') return 'Invitation created, but the email bounced. Check the address.';
  return 'Invitation created.';
}

export function EmployerTeamPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [team, setTeam] = useState<EmployerTeamDto | null>(null);
  const [extraMembers, setExtraMembers] = useState<readonly EmployerTeamMemberDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ email: string; role: EmployerTeamRole | '' }>({ email: '', role: '' });
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getEmployerTeam(token, employerId, undefined, controller.signal).then(({ team: loaded }) => {
      if (controller.signal.aborted) return;
      setTeam(loaded); setExtraMembers([]); setNextCursor(loaded.nextCursor); setLoadError('');
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(formatApiError(cause, 'Your team could not be loaded.')); });
    return () => controller.abort();
  }, [token, employerId, reload]);

  if (!token) return <StaffPilotWrap title="Team" subtitle="Sign in with an employer owner or admin identity to manage your team."><p role="status">You are not signed in.</p></StaffPilotWrap>;
  if (loadError && !team) return <StaffPilotWrap title="Team" subtitle="Members, invitations and roles."><p className="form-error" role="alert">{loadError}</p></StaffPilotWrap>;
  if (!team) return <StaffPilotWrap title="Team" subtitle="Members, invitations and roles."><p role="status">Loading your team…</p></StaffPilotWrap>;

  const members = [...team.members, ...extraMembers];
  const role = form.role || (team.invitableRoles.includes('RECRUITER') ? 'RECRUITER' : team.invitableRoles[0]) || '';

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    try {
      const { team: page } = await getEmployerTeam(token!, employerId, nextCursor);
      setExtraMembers((current) => [...current, ...page.members]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(formatApiError(cause, 'More members could not be loaded.'));
    }
  }

  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!role) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { invitation } = await inviteEmployerTeamMember(token!, employerId, form.email.trim(), role);
      setNotice(deliveryNote(invitation.delivery.state));
      setForm({ email: '', role: '' });
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'The invitation could not be created.'));
    } finally {
      setBusy(false);
    }
  }

  function startAction(action: PendingAction): void {
    setPending(action); setReason(''); setError(''); setNotice('');
  }

  async function confirmAction(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!pending || !reason) return;
    setBusy(true); setError('');
    try {
      if (pending.kind === 'end') {
        await endEmployerTeamMembership(token!, employerId, pending.member.membershipId, reason);
        setNotice(`${pending.member.email} no longer has access. Their past actions stay in the audit record.`);
      } else if (pending.kind === 'revoke') {
        await revokeEmployerTeamInvitation(token!, employerId, pending.invitation.id, reason);
        setNotice(`The invitation to ${pending.invitation.email} was revoked. Its link no longer works.`);
      } else {
        const { invitation } = await resendEmployerTeamInvitation(token!, employerId, pending.invitation.id, reason);
        setNotice(`${deliveryNote(invitation.delivery.state)} The earlier link no longer works.`);
      }
      setPending(null);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'That change could not be made.'));
    } finally {
      setBusy(false);
    }
  }

  const reasonOptions = pending ? team.reasonCodes[pending.kind] : [];
  const actionTitle = pending?.kind === 'end' ? `End ${pending.member.email}'s membership?`
    : pending?.kind === 'revoke' ? `Revoke the invitation to ${pending.invitation.email}?`
    : pending ? `Resend the invitation to ${pending.invitation.email}?` : '';
  const actionNote = pending?.kind === 'end' ? 'They lose access to this employer immediately. Their past actions stay in the audit record.'
    : pending?.kind === 'revoke' ? 'The invitation link stops working and they will not join your team.'
    : 'A new link is emailed and the earlier link stops working. The invitation is valid for 14 days from now.';
  const activeCount = members.filter((member) => member.state === 'ACTIVE').length;

  return <StaffPilotWrap title="Team" subtitle="Members, invitations and roles for your employer. Every change is recorded with a reason.">
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👥" tone="teal" value={activeCount} label="Active members" />
      <V2Stat icon="✉️" tone="amber" value={team.invitations.filter((item) => item.state === 'PENDING').length} label="Pending invitations" />
      <V2Stat icon="⏳" tone="blue" value={team.invitations.filter((item) => item.state === 'EXPIRED').length} label="Expired invitations" />
      <V2Stat icon="📮" tone="purple" value={team.deliveryConfigured ? 'On' : 'Not set up'} label="Invitation email" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}

    {pending ? <form className="role-card role-wide role-management-form" aria-label="Confirm team change" onSubmit={(event) => void confirmAction(event)}>
      <h2>{actionTitle}</h2>
      <p>{actionNote}</p>
      <label><span>Reason *</span><select value={reason} onChange={(event) => setReason(event.target.value)} required>
        <option value="">Choose a reason</option>
        {reasonOptions.map((code) => <option key={code} value={code}>{reasonLabels[code] ?? code}</option>)}
      </select></label>
      <div className="hiring-actions">
        <button type="submit" disabled={busy || !reason}>{pending.kind === 'end' ? 'End membership' : pending.kind === 'revoke' ? 'Revoke invitation' : 'Resend invitation'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
      </div>
    </form> : null}

    {team.invitableRoles.length ? <form className="role-card role-wide role-management-form" onSubmit={(event) => void invite(event)}>
      <h2>Invite a team member</h2>
      <label><span>Work email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label>
      <label><span>Role *</span><select value={role} onChange={(event) => setForm((value) => ({ ...value, role: event.target.value as EmployerTeamRole }))}>
        {team.invitableRoles.map((item) => <option key={item} value={item}>{employerTeamRoleLabels[item]}</option>)}
      </select></label>
      <button type="submit" disabled={busy}>Send invitation</button>
    </form> : null}

    <section className="role-card role-wide"><h2>Who can be invited</h2><ul className="role-check-list">
      <li>{team.actorRole === 'EMPLOYER_OWNER' ? 'As an owner you can invite admins and recruiters.' : 'As an admin you can invite recruiters. Your owner invites admins.'}</li>
      <li>Interviewers join as recruiters. Once they accept, add them to an interview panel from Interviews; they see only the interviews they are assigned to.</li>
      <li>The person must sign in with the email address the invitation was sent to. Invitations expire after 14 days.</li>
      <li>Your last owner cannot be removed.</li>
    </ul></section>

    <section className="role-card role-wide"><h2>Members</h2>
      {members.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Email</th><th>Role</th><th>State</th><th>Member since</th><th>Actions</th></tr></thead>
        <tbody>{members.map((member) => <tr key={member.membershipId}>
          <td>{member.email}{member.isSelf ? ' (you)' : ''}</td>
          <td>{employerTeamRoleLabels[member.role]}</td>
          <td>{member.state === 'ACTIVE' ? 'Active' : 'Suspended'}</td>
          <td>{formatDate(member.since)}</td>
          <td>{member.canEnd ? <button type="button" className="secondary" disabled={busy} onClick={() => startAction({ kind: 'end', member })}>End membership</button> : 'None'}</td>
        </tr>)}</tbody>
      </table></div> : <p>No members yet.</p>}
      {nextCursor ? <button type="button" className="secondary" onClick={() => void loadMore()}>Show more members</button> : null}
    </section>

    <section className="role-card role-wide"><h2>Invitations</h2>
      {team.invitations.length ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Email</th><th>Role</th><th>State</th><th>Delivery</th><th>Expires</th><th>Actions</th></tr></thead>
        <tbody>{team.invitations.map((invitation) => <tr key={invitation.id}>
          <td>{invitation.email}</td>
          <td>{employerTeamRoleLabels[invitation.role]}</td>
          <td>{invitation.state === 'EXPIRED' ? 'Expired' : 'Pending'}</td>
          <td>{deliveryLabels[invitation.delivery.state] ?? MISSING_TEXT}</td>
          <td>{formatDate(invitation.expiresAt)}</td>
          <td>{invitation.canResend || invitation.canRevoke ? <div className="hiring-actions">
            {invitation.canResend ? <button type="button" className="secondary" disabled={busy} onClick={() => startAction({ kind: 'resend', invitation })}>Resend</button> : null}
            {invitation.canRevoke ? <button type="button" className="secondary" disabled={busy} onClick={() => startAction({ kind: 'revoke', invitation })}>Revoke</button> : null}
          </div> : 'None'}</td>
        </tr>)}</tbody>
      </table></div> : <p>No pending invitations.</p>}
      {team.invitationsTruncated ? <p>Showing the 200 most recent pending invitations.</p> : null}
    </section>
  </StaffPilotWrap>;
}
