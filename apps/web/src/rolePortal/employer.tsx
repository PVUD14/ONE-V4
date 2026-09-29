/**
 * ONE · Role portal — Stream B — Hiring
 *
 * The authenticated recruiter surface.
 *
 * Split out of rolePortalPages.tsx so each stream owns its own surface. The
 * shell and the route dispatcher remain there and import from here.
 */
import { getProtectedAccessToken, getSecurityContext } from '../api.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { EmployerApplicantsPage, EmployerOpportunitiesPage, EmployerInterviewsPage, EmployerOffersPage, CandidateIdentity, InterviewActionForm } from '../hiringPages.js';
import { downloadMyInterviewCalendar, getMyInterview, listMyInterviews, submitMyInterviewOutcome, type ParticipantInterviewDto, type InterviewOutcomeInput } from '../api/hiring.js';
import { AddToCalendarButton, ScorecardTemplatesPanel } from '../interviewScheduling.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { EmployerTeamPage } from './employerTeam.js';
import { EmployerCompanyProfilePage } from './employerCompanyProfile.js';
import { EmployerSettingsPage } from './employerSettings.js';
import { EmployerOpportunityDetailPage } from './employerOpportunityDetail.js';
import { EmployerCandidateDetailPage, EmployerTalentPoolPage } from './employerCandidateDetail.js';
import { EmployerMessagesPage } from '../applicationMessages.js';
import { EmployerReportsPage } from './employerReports.js';
import type { RolePortalConfig } from '../rolePortalConfig.js';
import { RestrictedApiState } from './shared.js';
import { useEffect, useState } from 'react';

const participantRouteLabels = ['My Interviews', 'Candidate Brief', 'Scorecards'];
const ownerAdminOnlyLabels = ['Team', 'Settings'];

/** Display-only: whether an employer role manages the organisation (team, settings). */
export function employerManagesOrganisation(role: string): boolean {
  return role === 'EMPLOYER_OWNER' || role === 'EMPLOYER_ADMIN';
}

export function EmployerRecruiterRealityPage({ portal, routeLabel }: { readonly portal: RolePortalConfig; readonly routeLabel: string }): React.ReactElement {
  if (participantRouteLabels.includes(routeLabel)) return <EmployerInterviewerRealityPage routeLabel={routeLabel} />;
  return <EmployerManagementRealityPage portal={portal} routeLabel={routeLabel} />;
}

function EmployerManagementRealityPage({ portal, routeLabel }: { readonly portal: RolePortalConfig; readonly routeLabel: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [employerMembership, setEmployerMembership] = useState<{ readonly organizationId: string; readonly role: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getSecurityContext(token, controller.signal).then((context) => {
      const membership = context.memberships.find((item) => ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(item.role));
      if (membership) setEmployerMembership({ organizationId: membership.organizationId, role: membership.role });
      else setError('This identity has no active employer-scoped membership.');
    }).catch(() => setError('Unable to resolve employer context.'));
    return () => controller.abort();
  }, [token]);
  if (!token) return <RestrictedApiState title="Sign in to manage hiring" message="Sign in with an employer identity to see your opportunities and applicants. Preview role switching is not authentication." />;
  if (error) return <section className="role-module role-module--dense"><div className="role-page-heading"><div><h1>{routeLabel}</h1><p role="alert" className="form-error">{error}</p></div></div></section>;
  if (!employerMembership) return <section className="role-module role-module--dense"><div className="role-page-heading"><div><h1>{routeLabel}</h1><p role="status">Loading your employer workspace…</p></div></div></section>;

  const employerId = employerMembership.organizationId;
  if (/interview/i.test(routeLabel)) return <EmployerStageWorkspace key={`${employerId}-interviews`} employerId={employerId} stage="INTERVIEW" />;
  if (/offer/i.test(routeLabel)) return <EmployerStageWorkspace key={`${employerId}-offers`} employerId={employerId} stage="OFFER" />;
  // EMP-15: suppressed reports by job, college and drive replace the unsuppressed funnel view.
  if (/report|analytic/i.test(routeLabel)) return <StaffPilotWrap title="Reports" subtitle="Your employer's hiring funnel."><EmployerReportsPage key={employerId} employerId={employerId} /></StaffPilotWrap>;
  // EMP-05: Opportunity Detail is one job — its versions, state and actions. It used to fall
  // through to the list below.
  if (routeLabel === 'Opportunity Detail') return <EmployerOpportunityDetailPage key={employerId} employerId={employerId} />;
  if (/opportunit/i.test(routeLabel)) {
    return <StaffPilotWrap title="Opportunities" subtitle="Post roles, choose their audience and publish. Applications land under Applicants.">
      <EmployerOpportunitiesPage key={employerId} employerId={employerId} /></StaffPilotWrap>;
  }
  // EMP-07: Candidate Detail shows one applicant as they chose to be seen, and Talent Pool says it
  // is not available yet (EMP-14). Both used to fall through to the applicants list below.
  if (routeLabel === 'Candidate Detail') return <EmployerCandidateDetailPage key={employerId} employerId={employerId} />;
  if (routeLabel === 'Talent Pool') return <EmployerTalentPoolPage />;
  if (/applicant|candidate|talent/i.test(routeLabel)) {
    return <StaffPilotWrap title="Applicants" subtitle="Move real candidates through your process; every change is logged.">
      <EmployerApplicantsPage key={employerId} employerId={employerId} canExport={employerManagesOrganisation(employerMembership.role)} /></StaffPilotWrap>;
  }

  // Team and Settings belong to the employer's owner and admins (Appendix 2 §5.1). The role
  // check here only decides what to display; the server remains the authority when these
  // screens gain actions (EMP-02, EMP-16).
  if (ownerAdminOnlyLabels.includes(routeLabel) && !employerManagesOrganisation(employerMembership.role)) {
    return <section className="role-module role-module--dense">
      <div className="role-page-heading"><div>
        <span className="eyebrow">Owner and admin only</span>
        <h1>{routeLabel}</h1>
        <p>{routeLabel} is managed by your employer's owner or admin.</p>
      </div></div>
      <div className="role-wide"><V2EmptyState icon="🔒" title="Managed by your owner or admin"
        note={`Recruiters do not change ${routeLabel.toLowerCase()}. Ask your employer's owner or admin if something here needs to change.`}
        hint="Opportunities, Applicants, Interviews and Offers are all yours to run." /></div>
    </section>;
  }

  // EMP-02: Team is live for owners and admins; recruiters were answered above.
  if (routeLabel === 'Team') return <EmployerTeamPage key={employerId} employerId={employerId} />;

  // EMP-16: Settings is live for owners and admins (recruiters were answered above): the employer
  // terms, what ONE keeps about candidates, the viewer's notifications and trust cases.
  if (routeLabel === 'Settings') return <EmployerSettingsPage key={employerId} employerId={employerId} />;

  // EMP-04: Company Profile is live for every employer role; the server decides who may edit
  // (owners and admins) and who only reads (recruiters).
  if (routeLabel === 'Company Profile') return <EmployerCompanyProfilePage key={employerId} employerId={employerId} />;

  // EMP-10: the existing Messages item shows the conversations, one per application. It is live for
  // every employer role (Appendix 2 §5.1: messages pass for owner, admin and recruiter).
  if (routeLabel === 'Messages') {
    return <StaffPilotWrap title="Messages" subtitle="Conversations with shortlisted candidates, one per application.">
      <EmployerMessagesPage key={employerId} employerId={employerId} /></StaffPilotWrap>;
  }

  // Routes whose backend does not exist yet keep saying so rather than borrowing
  // another page's data.
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Coming later</span>
      <h1>{routeLabel}</h1>
      <p>Opportunities and Applicants carry your live pipeline today.</p>
    </div></div>
    <div className="role-wide"><V2EmptyState icon="🧭" title="Not built yet"
      note={`${routeLabel} is on the roadmap but has no live workflow behind it yet - nothing here is hidden or broken.`}
      hint="Interviews and offers are managed from the applicant row on the Applicants page." /></div>
  </section>;
}

/** Preserve integration's stage entry view alongside the delivered record workflows. */
function EmployerStageWorkspace({ employerId, stage }: { readonly employerId: string; readonly stage: 'INTERVIEW' | 'OFFER' }): React.ReactElement {
  const [view, setView] = useState<'applicants' | 'records' | 'templates'>('applicants');
  const interviews = stage === 'INTERVIEW';
  return <StaffPilotWrap title={interviews ? 'Interviews' : 'Offers'} subtitle={interviews ? 'Schedule interviews and record outcomes.' : 'Send offers and track candidate responses.'}>
    <div className="hiring-actions" role="group" aria-label={interviews ? 'Interview views' : 'Offer views'}>
      <button type="button" aria-pressed={view === 'applicants'} onClick={() => setView('applicants')}>{interviews ? 'Applicants at interview stage' : 'Applicants at offer stage'}</button>
      <button type="button" aria-pressed={view === 'records'} onClick={() => setView('records')}>{interviews ? 'Scheduled interviews' : 'Sent offers'}</button>
      {/* EMP-09: a view inside Interviews, not a navigation item. */}
      {interviews ? <button type="button" aria-pressed={view === 'templates'} onClick={() => setView('templates')}>Scorecard templates</button> : null}
    </div>
    {view === 'templates' && interviews ? <ScorecardTemplatesPanel employerId={employerId} />
      : view === 'records' ? interviews ? <EmployerInterviewsPage employerId={employerId} /> : <EmployerOffersPage employerId={employerId} />
        : <EmployerApplicantsPage employerId={employerId} applicationStateFilter={stage} />}
  </StaffPilotWrap>;
}

/** Core can dispatch its Interviewer navigation here without any membership-role provisioning. */
export function EmployerInterviewerRealityPage({ routeLabel }: { readonly routeLabel: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [employerIds, setEmployerIds] = useState<readonly string[]>([]);
  const [status, setStatus] = useState('Loading your interview workspace…');
  useEffect(() => {
    const abort = new AbortController();
    if (!token) return;
    setEmployerIds([]);
    void getSecurityContext(token, abort.signal).then((context) => {
      if (abort.signal.aborted) return;
      const ids = [...new Set(context.memberships.filter((m) => m.scope.employerId === m.organizationId
        && m.scope.organizationId === m.organizationId).map((m) => m.organizationId))];
      setEmployerIds(ids); setStatus(ids.length ? '' : 'You have no active employer membership.');
    }).catch(() => { if (!abort.signal.aborted) { setEmployerIds([]); setStatus('Your interview workspace could not be loaded.'); } });
    return () => abort.abort();
  }, [token]);
  if (!token) return <RestrictedApiState title="Sign in to view assigned interviews" message="Sign in with the identity assigned to the interview." />;
  if (!participantRouteLabels.includes(routeLabel)) return <section className="role-card"><p>This interview screen is not available.</p></section>;
  return <StaffPilotWrap title={routeLabel} subtitle="Access is limited to interviews you are assigned to.">
    {status ? <p role="status">{status}</p> : null}
    {employerIds.length ? <AssignedInterviewWorkspace key={`${token}-${routeLabel}`} employerIds={employerIds} routeLabel={routeLabel} /> : null}
  </StaffPilotWrap>;
}

type AssignedInterview = ParticipantInterviewDto & { readonly employerId: string };

function AssignedInterviewWorkspace({ employerIds, routeLabel }: { readonly employerIds: readonly string[]; readonly routeLabel: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [interviews, setInterviews] = useState<readonly AssignedInterview[]>([]);
  const [selected, setSelected] = useState<AssignedInterview | null>(null);
  const [detail, setDetail] = useState<AssignedInterview | null>(null);
  const [status, setStatus] = useState('Loading assigned interviews…');
  const [reload, setReload] = useState(0);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    if (!token) return;
    // Reload on focus as well as periodically so assignment and consent changes are reflected.
    const refresh = () => setReload((value) => value + 1);
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    void Promise.all(employerIds.map(async (employerId) => {
      const { interviews } = await listMyInterviews(token, employerId, abort.signal);
      return interviews.map((interview) => ({ ...interview, employerId }));
    })).then((groups) => {
      if (!abort.signal.aborted) { setInterviews(groups.flat().sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart))); setStatus(''); }
    }).catch(() => { if (!abort.signal.aborted) { setInterviews([]); setSelected(null); setDetail(null); setStatus('Assigned interviews could not be loaded.'); } });
    return () => { abort.abort(); window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [token, employerIds, reload]);
  const active = interviews.filter((item) => ['SCHEDULED', 'RESCHEDULED'].includes(item.state)
    && (!item.scheduledEnd || Date.parse(item.scheduledEnd) > clock));
  const selectedListItem = active.find((item) => item.id === selected?.id && item.employerId === selected.employerId);
  useEffect(() => {
    const abort = new AbortController();
    if (!token || !selected || !selectedListItem) return;
    void getMyInterview(token, selected.employerId, selected.id, abort.signal).then(({ interview }) => {
      if (abort.signal.aborted) return;
      setDetail({ ...interview, employerId: selected.employerId });
      if (interview.consentRevoked) setInterviews((previous) => previous.some((item) => item.id === interview.id
        && item.employerId === selected.employerId && !item.consentRevoked)
        ? previous.map((item) => item.id === interview.id && item.employerId === selected.employerId ? { ...interview, employerId: selected.employerId } : item)
        : previous);
    }).catch(() => { if (!abort.signal.aborted) { setDetail(null); setStatus('This interview is no longer available to you.'); } });
    return () => abort.abort();
  }, [token, selected, selectedListItem]);
  const current = detail && selectedListItem && detail.id === selectedListItem.id
    ? { ...detail, consentRevoked: detail.consentRevoked || selectedListItem.consentRevoked,
      canRecordOutcome: detail.canRecordOutcome && selectedListItem.canRecordOutcome } : null;
  const label = (item: AssignedInterview) => `${item.title || 'NA'} · Round ${item.roundNumber} · ${new Date(item.scheduledStart).toLocaleString()}`;
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><h1>{routeLabel}</h1><p>Only your active interview assignments appear here. Times are local.</p></div></div>
    <section className="role-card role-wide">
      {status ? <p role="status">{status}</p> : null}
      <button type="button" className="secondary" onClick={() => { setDetail(null); setReload((value) => value + 1); }}>Refresh assignments</button>
      {!status && active.length === 0 ? <p>No interviews are assigned to you.</p> : null}
      {routeLabel === 'My Interviews' ? <div className="role-record-table-wrap"><table className="role-record-table">
        <thead><tr><th>Candidate</th><th>Opportunity</th><th>Round</th><th>Mode</th><th>Start</th><th>End</th><th>Action</th></tr></thead>
        <tbody>{active.map((item) => <tr key={`${item.employerId}-${item.id}`}><td><CandidateIdentity item={item} /></td><td>{item.title || 'NA'}</td><td>{item.roundNumber}</td><td>{item.mode}</td>
          <td>{new Date(item.scheduledStart).toLocaleString()}</td><td>{item.scheduledEnd ? new Date(item.scheduledEnd).toLocaleString() : 'NA'}</td>
          <td><button type="button" onClick={() => { setDetail(null); setSelected(item); }}>Candidate brief</button></td></tr>)}</tbody>
      </table></div> : <label className="student-form-field"><span>Assigned interview</span>
        <select value={selectedListItem?.id ?? ''} onChange={(event) => { setDetail(null); setSelected(active.find((item) => item.id === event.target.value) ?? null); }}>
          <option value="">Select your interview</option>{active.map((item) => <option key={`${item.employerId}-${item.id}`} value={item.id}>{label(item)}</option>)}
        </select></label>}
    </section>
    {current ? <section className="role-card role-wide">
      <h2>{routeLabel === 'Scorecards' ? 'Your scorecard' : 'Candidate brief'}</h2>
      <p><CandidateIdentity item={current} /></p>
      {current.consentRevoked || current.candidateAccess === false ? null : <>
        <p>Email: {current.candidateEmail ?? 'NA'}</p><p>Location or phone arrangements: {current.locationDetail ?? 'NA'}</p>
        <p>Joining link: {current.joiningLink && /^https:\/\//i.test(current.joiningLink) ? <a href={current.joiningLink} target="_blank" rel="noopener noreferrer">Open interview meeting</a> : 'NA'}</p>
      </>}
      {/* EMP-09: the stage, its scorecard guidance, and the invite for the panellist's own calendar. */}
      <p>Stage: {current.stageLabel ?? 'NA'} · Scorecard: {current.scorecardTemplate ? current.scorecardTemplate.name : 'Free-text scorecard (no stage template)'}</p>
      {current.scorecardTemplate?.guidance ? <p className="hiring-meta">{current.scorecardTemplate.guidance}</p> : null}
      <AddToCalendarButton download={(accessToken) => downloadMyInterviewCalendar(accessToken, current.employerId, current.id)} />
      <h3>{current.title || 'NA'}</h3><p>{current.summary ?? 'NA'}</p><p>{current.responsibilities ?? 'NA'}</p>
      {routeLabel === 'Scorecards' ? current.canRecordOutcome && !current.consentRevoked
        ? <InterviewActionForm key={`${current.employerId}-${current.id}`} kind="outcome" template={current.scorecardTemplate ?? null} onCancel={() => { setDetail(null); setSelected(null); }} onSave={async (body) => {
          if (!token) throw new Error('Unavailable');
          try {
            await submitMyInterviewOutcome(token, current.employerId, current.id, body as InterviewOutcomeInput);
            setStatus('Your scorecard was recorded.'); setSelected(null); setDetail(null);
          } catch {
            setSelected(null); setDetail(null); setInterviews([]); setStatus('The scorecard could not be saved. Refresh your assignments to check access.');
            throw new Error('Unavailable');
          }
        }} /> : <p>Scorecard submission is no longer available for this interview.</p> : null}
    </section> : null}
  </section>;
}
