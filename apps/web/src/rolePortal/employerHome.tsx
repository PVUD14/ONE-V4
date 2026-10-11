/**
 * ONE · Role portal — Employer — the Hiring overview (re-skin phase 7)
 *
 * The recruiter's Dashboard in the approved Momentum composition (inventory 06-screens/employer.html):
 * the hiring figures, where every applicant stands, this week's interviews, open roles, offers,
 * people recently shortlisted, campus drives, the team and messages. It replaces the earlier
 * pilot-parity dashboard, which printed "NA" in every slot it could not fill.
 *
 * Every figure comes from a read this employer already makes: the server's summary (EMP-15), the
 * interview, offer, opportunity, applicant and campus-drive lists, message threads and — for owners
 * and admins only — the team. A block renders only when its read succeeded. The counts are the
 * employer's own candidates, whom the recruiter already sees by name, so they are exact.
 *
 * Employers never see readiness (product rule 2): nothing here reads, draws or names it, and a test
 * fails if this file ever imports a readiness component. Candidates appear only as they chose to
 * be seen, and only while their applicant-access grant is live.
 */
import React, { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon.js';
import {
  getProtectedAccessToken,
  getSecurityContext,
  listEmployerApplicants,
  listEmployerOpportunities,
  type EmployerApplicantDto,
  type EmployerOpportunityDto,
} from '../api.js';
import { campusDriveStateLabels, listEmployerCampusDrives, venueModeLabels, type CampusDriveDto } from '../api/campusDrives.js';
import {
  getEmployerSummary,
  getEmployerTeam,
  listEmployerInterviews,
  listEmployerMessageThreads,
  listEmployerOffers,
  type EmployerInterviewDto,
  type EmployerOfferDto,
  type EmployerSummaryDto,
  type EmployerTeamDto,
  type MessageThreadSummaryDto,
} from '../api/hiring.js';
import { formatDate } from '../dates.js';
import { applicationStageLabel, codeLabel } from '../labels.js';
import { StatusTag } from '../momentum/statusTag.js';
import { CandidateIdentity } from '../hiringPages.js';
import { employerManagesOrganisation } from './employer.js';
import { IhAvatar, IhCard, IhInsight, IhKpis, IhNote, IhPage, IhTiles, RecordCount, go, shortDate, shortTime } from './institutionMomentum.js';

type NamedApplicant = EmployerApplicantDto & { readonly opportunityTitle: string };

export interface EmployerHomeData {
  readonly role: string;
  readonly summary: EmployerSummaryDto | null;
  readonly interviews: readonly EmployerInterviewDto[] | null;
  readonly drives: readonly CampusDriveDto[] | null;
  readonly opportunities: readonly EmployerOpportunityDto[] | null;
  readonly offers: readonly EmployerOfferDto[] | null;
  readonly applicants: readonly NamedApplicant[];
  /** Owners and admins only; null for a recruiter, and when the read failed. */
  readonly team: EmployerTeamDto | null;
  readonly threads: { readonly threads: readonly MessageThreadSummaryDto[]; readonly withheldCount: number } | null;
}

const STAGES = [
  ['APPLIED', 'Applied'], ['SCREENING', 'Screening'], ['SHORTLISTED', 'Shortlisted'], ['ASSESSMENT', 'Assessment'],
  ['INTERVIEW', 'Interview'], ['OFFER', 'Offer'], ['HIRED', 'Hired'],
] as const;
const LIVE_ROLE_STATES = new Set(['PUBLISHED', 'LIVE', 'OPEN', 'ACTIVE']);
const OPEN_DRIVE_STATES = new Set(['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED']);
const DRIVE_STEPS = ['Requested', 'Approved', 'Date confirmed', 'Drive day', 'Completed'] as const;
const EMPLOYER_ROLES = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'];
const TEAM_ROLE_LABELS: Readonly<Record<string, string>> = { EMPLOYER_OWNER: 'Owner', EMPLOYER_ADMIN: 'Admin', RECRUITER: 'Recruiter' };

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The interviews that count toward "this week": the server's window, not cancelled. */
export function interviewsInWeek(interviews: readonly EmployerInterviewDto[], summary: EmployerSummaryDto): readonly EmployerInterviewDto[] {
  const start = new Date(summary.week.startsAt).getTime();
  const end = new Date(summary.week.endsAt).getTime();
  return interviews
    .filter((item) => item.state !== 'CANCELLED' && item.scheduledStart !== null)
    .filter((item) => { const at = new Date(item.scheduledStart!).getTime(); return at >= start && at < end; })
    .sort((a, b) => a.scheduledStart!.localeCompare(b.scheduledStart!));
}

export async function loadEmployerHome(token: string, signal: AbortSignal): Promise<EmployerHomeData | { readonly error: string }> {
  const context = await getSecurityContext(token, signal).catch(() => null);
  if (!context) return { error: 'Your employer workspace could not be opened. Try again shortly.' };
  const membership = context.memberships.find((item) => EMPLOYER_ROLES.includes(item.role));
  if (!membership) return { error: 'This identity has no active employer membership.' };
  const employerId = membership.organizationId;
  const manages = employerManagesOrganisation(membership.role);
  // EMP-15: every figure comes from the one summary the server computes in SQL. The lists below only
  // feed named rows, each person shown only while their applicant-access grant is live.
  const [summary, interviews, drives, opportunities, offers, team, threads] = await Promise.all([
    getEmployerSummary(token, employerId, signal).then((response) => response?.summary ?? null).catch(() => null),
    listEmployerInterviews(token, employerId, signal).then((response) => (Array.isArray(response?.interviews) ? response.interviews : null)).catch(() => null),
    listEmployerCampusDrives(token, employerId, undefined, signal).then((response) => (Array.isArray(response?.drives) ? response.drives : null)).catch(() => null),
    listEmployerOpportunities(token, employerId, signal).then((response) => (Array.isArray(response?.opportunities) ? response.opportunities : null)).catch(() => null),
    listEmployerOffers(token, employerId, signal).then((response) => (Array.isArray(response?.offers) ? response.offers : null)).catch(() => null),
    manages ? getEmployerTeam(token, employerId, undefined, signal).then((response) => (response?.team && Array.isArray(response.team.members) ? response.team : null)).catch(() => null) : Promise.resolve(null),
    listEmployerMessageThreads(token, employerId, undefined, signal).then((response) => (Array.isArray(response?.threads) ? { threads: response.threads, withheldCount: response.withheldCount ?? 0 } : null)).catch(() => null),
  ]);
  const groups = await Promise.all((opportunities ?? []).filter((item) => item.applicationCount > 0).slice(0, 4).map((opportunity) =>
    listEmployerApplicants(token, employerId, opportunity.id, signal)
      .then((response) => (response?.applications ?? []).map((applicant) => ({ ...applicant, opportunityTitle: opportunity.title ?? opportunity.referenceCode })))
      .catch(() => [] as NamedApplicant[])));
  return { role: membership.role, summary, interviews, drives, opportunities, offers, team, threads, applicants: groups.flat() };
}

// --- Cards -------------------------------------------------------------------------------------

function PipelineCard({ summary, onOpen }: { readonly summary: EmployerSummaryDto; readonly onOpen: () => void }): React.ReactElement {
  const values = STAGES.map(([code]) => summary.currentStages[code] ?? 0);
  const max = Math.max(1, ...values);
  const screening = summary.currentStages.APPLIED ?? 0;
  return <IhCard title="Applicant pipeline" link={{ label: 'Applicants', onClick: onOpen }} aside="All roles · where each applicant is now">
    <ol className="bh-climb" style={{ '--n': STAGES.length } as React.CSSProperties} aria-label="Applicants by stage">
      {STAGES.map(([code, label], index) => {
        const value = values[index]!;
        return <li key={code} className={value === 0 ? 'z' : undefined} style={{ '--h': value / max, '--k': index } as React.CSSProperties}>
          <span className="bh-climb-n"><RecordCount value={value} /></span>
          <i className="bh-climb-bar" aria-hidden="true" />
          <span className="bh-climb-l">{label}</span>
        </li>;
      })}
    </ol>
    <div className="bh-foot">
      <p className="bh-foot-t"><b><RecordCount value={summary.applicationsTotal} /></b> {plural(summary.applicationsTotal, 'application', 'applications')} · {summary.openApplications} still open · {summary.hires} hired</p>
      <IhInsight icon="applicants" title={`${summary.newApplicantsLast7Days} new this week`} line={screening ? `${screening} waiting to be screened` : 'Nobody is waiting to be screened'} />
      <IhInsight icon="offers" title={`${summary.offersPending} ${plural(summary.offersPending, 'offer', 'offers')} pending`} line="Waiting for the candidate's reply" />
    </div>
    <IhNote>Stages show where each applicant is today. You see what each candidate chose to share with you, and nothing else.</IhNote>
  </IhCard>;
}

function InterviewsCard({ week, count, onOpen }: { readonly week: readonly EmployerInterviewDto[]; readonly count: number; readonly onOpen: () => void }): React.ReactElement {
  return <IhCard title="Interviews this week" aside={<span className="tag t-band"><i />{count} scheduled</span>}>
    {week.length ? <ul className="ih-list">{week.slice(0, 4).map((item) => {
      const at = new Date(item.scheduledStart!);
      return <li key={item.id} className="ih-li">
        <span className="ih-date" aria-hidden="true"><small>{at.toLocaleDateString('en-GB', { weekday: 'short' })}</small><b>{at.getDate()}</b></span>
        <div className="ih-li-t"><b><CandidateIdentity item={item} /></b><small>{item.title}</small></div>
        <div className="ih-when"><b>{shortTime(item.scheduledStart)}</b>Round {item.roundNumber} · {codeLabel(item.mode)}</div>
      </li>;
    })}</ul> : <p className="ih-empty">No interviews are scheduled this week.</p>}
    <div className="ih-btns"><button type="button" className="pilot-btn ghost small" onClick={onOpen}><Icon name="interviews" size={16} /> Open interviews</button></div>
  </IhCard>;
}

function RolesCard({ roles, drives, onOpen }: { readonly roles: readonly EmployerOpportunityDto[]; readonly drives: readonly CampusDriveDto[] | null; readonly onOpen: () => void }): React.ReactElement {
  const live = roles.filter((role) => LIVE_ROLE_STATES.has(role.lifecycleState));
  const shown = (live.length ? live : roles).slice(0, 5);
  const applicants = live.reduce((sum, role) => sum + role.applicationCount, 0);
  const driveFor = (id: string) => drives?.find((drive) => drive.opportunityId === id && OPEN_DRIVE_STATES.has(drive.state)) ?? null;
  return <IhCard title={live.length ? 'Open roles' : 'Roles'} link={{ label: 'Opportunities', onClick: onOpen }}
    aside={live.length ? `${live.length} live · ${applicants} ${plural(applicants, 'applicant', 'applicants')}` : ''}>
    <div className="ih-table-wrap"><table className="ih-table"><caption className="sr-only">Your roles</caption>
      <thead><tr><th scope="col">Role</th><th scope="col" className="r">Applicants</th><th scope="col" className="r">Open</th><th scope="col">Campus drive</th><th scope="col">Closes</th></tr></thead>
      <tbody>{shown.map((role) => {
        const drive = driveFor(role.id);
        const meta = [role.employmentType ? codeLabel(role.employmentType) : null, role.workMode ? codeLabel(role.workMode) : null, role.locationCity].filter(Boolean).join(' · ');
        return <tr key={role.id}>
          <th scope="row" className="bh-role"><b>{role.title ?? role.referenceCode}{LIVE_ROLE_STATES.has(role.lifecycleState) ? null : <> <StatusTag state={role.lifecycleState} label={codeLabel(role.lifecycleState)} /></>}</b>{meta ? <small>{meta}</small> : null}</th>
          <td className="r num">{role.applicationCount}</td>
          <td className="r num">{role.openApplicationCount}</td>
          <td className="bh-drive">{drive ? <><span>{drive.institutionName}</span><StatusTag state={drive.state} label={campusDriveStateLabels[drive.state]} /></> : null}</td>
          <td className="ih-muted">{role.applicationDeadline ? shortDate(role.applicationDeadline) : null}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </IhCard>;
}

function OffersCard({ offers, onOpen }: { readonly offers: readonly EmployerOfferDto[]; readonly onOpen: () => void }): React.ReactElement {
  const count = (state: string) => offers.filter((offer) => offer.state === state).length;
  const recent = [...offers].sort((a, b) => (b.extendedAt ?? '').localeCompare(a.extendedAt ?? '')).slice(0, 3);
  return <IhCard title="Offers" link={{ label: 'Offers', onClick: onOpen }}>
    <IhTiles columns={3} tiles={[
      { key: 'out', label: 'Awaiting reply', value: <RecordCount value={count('EXTENDED')} />, muted: count('EXTENDED') === 0 },
      { key: 'accepted', label: 'Accepted', value: <RecordCount value={count('ACCEPTED')} />, muted: count('ACCEPTED') === 0 },
      { key: 'declined', label: 'Declined', value: <RecordCount value={count('DECLINED')} />, muted: count('DECLINED') === 0 },
    ]} />
    {recent.length ? <ul className="ih-list ih-gap">{recent.map((offer) => <li key={offer.id} className="ih-li">
      <div className="ih-li-t"><b><CandidateIdentity item={offer} /></b><small>{[offer.title, offer.offerExpiresAt && offer.state === 'EXTENDED' ? `Reply by ${formatDate(offer.offerExpiresAt)}` : null].filter(Boolean).join(' · ')}</small></div>
      <StatusTag kind="offer" state={offer.state} label={codeLabel(offer.state)} />
    </li>)}</ul> : <p className="ih-empty ih-gap">No offers sent yet. Send one from Applicants once a candidate reaches the offer stage.</p>}
  </IhCard>;
}

function ShortlistCard({ applicants, onOpen }: { readonly applicants: readonly NamedApplicant[]; readonly onOpen: () => void }): React.ReactElement {
  return <IhCard title="Recently shortlisted" link={{ label: 'Applicants', onClick: onOpen }}>
    <ul className="ih-list">{applicants.map((applicant) => <li key={applicant.id} className="ih-li">
      <IhAvatar name={applicant.candidateName ?? 'Candidate'} />
      <div className="ih-li-t"><b><CandidateIdentity item={applicant} /></b><small>{applicant.opportunityTitle}</small></div>
      <StatusTag kind="application" state={applicant.state} label={applicationStageLabel(applicant.state)} />
    </li>)}</ul>
    <IhNote>Candidates choose what you see: the evidence, badges and résumé they share with an application. Anything they keep private never reaches you.</IhNote>
  </IhCard>;
}

function driveStep(drive: CampusDriveDto, now: number): number {
  if (drive.state === 'COMPLETED') return 4;
  if (drive.state === 'SCHEDULED') return drive.scheduledStartAt && Date.parse(drive.scheduledStartAt) <= now ? 3 : 2;
  if (drive.state === 'APPROVED') return 1;
  return 0;
}

function DrivesCard({ drives, summary }: { readonly drives: readonly CampusDriveDto[]; readonly summary: EmployerSummaryDto | null }): React.ReactElement {
  const now = Date.now();
  const open = drives.filter((drive) => OPEN_DRIVE_STATES.has(drive.state));
  const at = (value: string | null) => (value ? Date.parse(value) : Number.MAX_SAFE_INTEGER);
  const featured = [...open].sort((a, b) => at(a.scheduledStartAt ?? a.proposedStartAt) - at(b.scheduledStartAt ?? b.proposedStartAt))[0] ?? null;
  const when = featured ? featured.scheduledStartAt ?? featured.proposedStartAt : null;
  const whenDate = when ? new Date(when) : null;
  const step = featured ? driveStep(featured, now) : -1;
  const others = open.filter((drive) => drive !== featured).slice(0, 3);
  return <IhCard title="Campus drives" aside={featured ? <StatusTag state={featured.state} label={campusDriveStateLabels[featured.state]} /> : null}>
    {featured ? <div className="ih-drive">
      <div className="ih-drive-h">
        {whenDate ? <span className="ih-cal" aria-hidden="true"><b>{whenDate.getDate()}</b><small>{whenDate.toLocaleDateString('en-GB', { month: 'short' })}</small></span> : null}
        <div>
          <b>{featured.institutionName}</b>
          <small>{[featured.opportunityTitle, featured.venueMode ? venueModeLabels[featured.venueMode] : null,
            when ? `${featured.scheduledStartAt ? '' : 'Proposed '}${formatDate(when)}${shortTime(when) ? `, ${shortTime(when)}` : ''}` : null].filter(Boolean).join(' · ')}</small>
        </div>
      </div>
      <ol className="ih-steps" aria-label="Where this drive stands">
        {DRIVE_STEPS.map((label, index) => <li key={label} className={index < step ? 'd' : index === step ? 'c' : undefined} {...(index === step ? { 'aria-current': 'step' as const } : {})}>{label}</li>)}
      </ol>
    </div> : <p className="ih-empty">No campus drive is open. Request one from a role's Opportunity Detail.</p>}
    {summary && (summary.drivesAwaitingApproval || summary.drivesChangesRequested) ? <div className="ih-tiles ih-drive-tiles" style={{ '--cols': 2 } as React.CSSProperties}>
      <div className={`ih-tile${summary.drivesAwaitingApproval ? '' : ' z'}`}><span className="ih-tile-l">Waiting for colleges</span><b className="num"><RecordCount value={summary.drivesAwaitingApproval} /></b></div>
      <div className={`ih-tile${summary.drivesChangesRequested ? '' : ' z'}`}><span className="ih-tile-l">Need your changes</span><b className="num"><RecordCount value={summary.drivesChangesRequested} /></b></div>
    </div> : null}
    {others.length ? <ul className="ih-list">{others.map((drive) => <li key={drive.id} className="ih-li">
      <IhAvatar name={drive.institutionName} />
      <div className="ih-li-t"><b>{drive.institutionName}</b><small>{[drive.opportunityTitle, shortDate(drive.scheduledStartAt ?? drive.proposedStartAt)].filter(Boolean).join(' · ')}</small></div>
      <StatusTag state={drive.state} label={campusDriveStateLabels[drive.state]} />
    </li>)}</ul> : null}
    <IhNote icon="info">A drive reaches students only once the college approves it.</IhNote>
  </IhCard>;
}

/** Team: the members for owners and admins, with the link to manage them; a plain lock note for recruiters. */
function TeamCard({ role, team, onOpen }: { readonly role: string; readonly team: EmployerTeamDto | null; readonly onOpen: () => void }): React.ReactElement {
  const manages = employerManagesOrganisation(role);
  return <IhCard title="Team" aside={manages ? null : <span className="tag t-mute"><Icon name="lock" size={16} className="tag-icon" />Owner manages</span>}>
    {manages && team ? <>
      <ul className="ih-list">{team.members.slice(0, 4).map((member) => <li key={member.membershipId} className="ih-li">
        <IhAvatar name={member.email} />
        <div className="ih-li-t"><b>{member.email}{member.isSelf ? ' · you' : ''}</b><small>{member.since ? `Since ${formatDate(member.since)}` : codeLabel(member.state)}</small></div>
        <span className="ih-muted">{TEAM_ROLE_LABELS[member.role] ?? codeLabel(member.role)}</span>
      </li>)}</ul>
      {team.invitations.length ? <p className="ih-lead ih-gap">{team.invitations.length} {plural(team.invitations.length, 'invitation', 'invitations')} not yet accepted.</p> : null}
      <div className="ih-btns"><button type="button" className="pilot-btn ghost small" onClick={onOpen}><Icon name="team" size={16} /> Manage team</button></div>
    </> : null}
    {!manages ? <div className="bh-lockbox" data-testid="owner-only-hint"><Icon name="lock" size={16} />
      <div><b>Team and settings are managed by your owner or admin</b><small>Ask them to add a colleague or change a setting. Opportunities, applicants, interviews and offers are yours to run.</small></div>
    </div> : null}
  </IhCard>;
}

function MessagesCard({ threads, onOpen }: { readonly threads: readonly MessageThreadSummaryDto[]; readonly onOpen: () => void }): React.ReactElement {
  const unread = threads.reduce((sum, thread) => sum + thread.unreadCount, 0);
  const recent = [...threads].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)).slice(0, 3);
  return <IhCard title="Messages" aside={unread ? <span className="tag t-band"><i />{unread} unread</span> : null} link={{ label: 'Open', onClick: onOpen }}>
    {recent.length ? <ul className="ih-list">{recent.map((thread) => <li key={thread.applicationId} className="ih-li">
      <IhAvatar name={thread.candidateName ?? 'Candidate'} />
      <div className="ih-li-t"><b>{thread.candidateName?.trim() ? thread.candidateName : 'Candidate'}</b><small>{[thread.title, shortDate(thread.lastMessageAt)].filter(Boolean).join(' · ')}</small></div>
      {thread.unreadCount ? <span className="bh-unread" aria-label={`${thread.unreadCount} unread`}>{thread.unreadCount}</span> : null}
    </li>)}</ul> : <p className="ih-empty">No conversations yet. A conversation opens with each shortlisted candidate.</p>}
  </IhCard>;
}

function NoApplicantsCard({ role, onOpen }: { readonly role: EmployerOpportunityDto; readonly onOpen: () => void }): React.ReactElement {
  return <IhCard title={role.title ?? role.referenceCode} aside={role.publishedAt ? `Live since ${shortDate(role.publishedAt)}` : null}>
    <div className="ih-calm">
      <span className="ih-calm-i" aria-hidden="true"><Icon name="applicants" size={24} /></span>
      <b>No applicants yet</b>
      <small>This role is live and nobody has applied so far. Asking a college for a campus drive brings it to their students.</small>
      <button type="button" className="pilot-btn small" onClick={onOpen}><Icon name="opportunities" size={16} /> Open opportunities</button>
    </div>
  </IhCard>;
}

// --- Page --------------------------------------------------------------------------------------

export function EmployerHome({ basePath }: { readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<EmployerHomeData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void loadEmployerHome(token, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if ('error' in result) setError(result.error); else setData(result);
    });
    return () => controller.abort();
  }, [token]);

  const open = (path: string) => () => go(`${basePath}${path}`);
  const summary = data?.summary ?? null;
  const week = summary && data?.interviews ? interviewsInWeek(data.interviews, summary) : null;
  const shortlisted = (data?.applicants ?? [])
    .filter((applicant) => applicant.candidateAccess !== false && !applicant.consentRevoked && ['SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER'].includes(applicant.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const quiet = data?.opportunities?.find((role) => LIVE_ROLE_STATES.has(role.lifecycleState) && role.applicationCount === 0) ?? null;

  return <IhPage className="bh" title="Hiring overview" summary="Your open roles, where every applicant is, and the interviews coming up this week."
    actions={<button type="button" className="pilot-btn" onClick={open('/opportunities')}><Icon name="plus" size={16} /> Post a role</button>}>
    {error ? <p role="alert" className="ih-empty">{error}</p> : null}
    {!data && !error ? <p role="status" className="ih-empty">Loading your hiring overview…</p> : null}
    {data && !summary ? <p className="bh-banner" role="status"><Icon name="warning" size={16} /> Your hiring figures could not be loaded just now, so they are left out. Try again shortly.</p> : null}
    {summary ? <IhKpis items={[
      { key: 'roles', icon: 'opportunities', value: <RecordCount value={summary.openJobs} />, label: summary.openJobs === 1 ? 'Open role' : 'Open roles' },
      { key: 'applicants', icon: 'applicants', value: <RecordCount value={summary.applicationsTotal} />, label: 'Applicants', note: `${summary.newApplicantsLast7Days} new this week` },
      { key: 'pipeline', icon: 'pipeline', value: <RecordCount value={summary.openApplications} />, label: 'In the pipeline', note: 'Applied → offer' },
      { key: 'interviews', icon: 'interviews', value: <RecordCount value={summary.interviewsThisWeek} />, label: summary.interviewsThisWeek === 1 ? 'Interview' : 'Interviews', note: 'This week' },
      { key: 'offers', icon: 'offers', value: <RecordCount value={summary.offersPending} />, label: summary.offersPending === 1 ? 'Offer pending' : 'Offers pending', note: `${summary.hires} hired so far` },
    ]} /> : null}
    {data ? <div className="ih-grid">
      {summary ? <div className={week ? 'ih-c8' : 'ih-c12'}><PipelineCard summary={summary} onOpen={open('/applicants')} /></div> : null}
      {summary && week ? <div className={summary ? 'ih-c4' : 'ih-c12'}><InterviewsCard week={week} count={summary.interviewsThisWeek} onOpen={open('/interviews')} /></div> : null}
      {data.opportunities && data.opportunities.length ? <div className={data.offers ? 'ih-c8' : 'ih-c12'}><RolesCard roles={data.opportunities} drives={data.drives} onOpen={open('/opportunities')} /></div> : null}
      {data.offers ? <div className={data.opportunities && data.opportunities.length ? 'ih-c4' : 'ih-c12'}><OffersCard offers={data.offers} onOpen={open('/offers')} /></div> : null}
      {shortlisted.length ? <div className={data.drives ? 'ih-c8' : 'ih-c12'}><ShortlistCard applicants={shortlisted} onOpen={open('/applicants')} /></div> : null}
      {data.drives ? <div className={shortlisted.length ? 'ih-c4' : 'ih-c12'}><DrivesCard drives={data.drives} summary={summary} /></div> : null}
      {quiet ? <div className="ih-c4"><NoApplicantsCard role={quiet} onOpen={open('/opportunities')} /></div> : null}
      <div className="ih-c4"><TeamCard role={data.role} team={data.team} onOpen={open('/team')} /></div>
      {data.threads ? <div className={quiet ? 'ih-c4' : 'ih-c8'}><MessagesCard threads={data.threads.threads} onOpen={open('/messages')} /></div> : null}
    </div> : null}
  </IhPage>;
}
