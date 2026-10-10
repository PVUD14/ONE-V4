import { useEffect, useState } from 'react';
import { Icon } from './icons/Icon.js';
import { MultiRing } from './pilot/pilotComponents.js';
import { NaSlotStrip, NaValue, allMissing } from './naState.js';
import { StatusTag } from './momentum/statusTag.js';
import { SuppressedBlock, SuppressedLegend, isSmallCountText } from './momentum/smallCount.js';
import {
  getProtectedAccessToken,
  getSecurityContext,
  listEmployerApplicants,
  listEmployerOpportunities,
  type EmployerApplicantDto,
  type EmployerOpportunityDto,
} from './api.js';
import { campusDriveStateLabels, listEmployerCampusDrives, type CampusDriveDto } from './api/campusDrives.js';
import { getEmployerSummary, listEmployerInterviews, type EmployerInterviewDto, type EmployerSummaryDto } from './api/hiring.js';
import { codeLabel } from './labels.js';
import { PlacementOfficerHome } from './rolePortal/placementOfficerHome.js';

/**
 * Pilot-exact staff dashboards. Same rule as the student V3: the pilot's
 * composition reproduced widget for widget - real data where an engine
 * exists, an explicit NA (or 0) in the same slot where it does not. Never
 * invent a number, never drop a pilot widget.
 */

function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function Funnel({ rows, label, naReason = 'Placement figures are not available to your role — NA.' }: {
  readonly rows: readonly { readonly label: string; readonly value: number | null; readonly display?: string }[]; readonly label: string; readonly naReason?: string;
}): React.ReactElement {
  const displays = rows.map((row) => row.display ?? (row.value === null ? 'NA' : String(row.value)));
  // Every stage withheld or missing: empty bars would read as zero, so each stage is a labelled chip.
  if (allMissing(displays)) {
    return <NaSlotStrip card={false} label={label} slots={rows.map((row, index) => ({ label: row.label, value: displays[index] }))}
      reason={displays.some(isSmallCountText) ? 'Each stage holds fewer than 5 students, so the counts are withheld.' : naReason} />;
  }
  const max = Math.max(...rows.map((row) => row.value ?? 0), 1);
  return <div className="pilot-funnel">
    {rows.map((row, index) => (
      <div key={row.label} className="pilot-funnel-row">
        <span>{row.label}</span>
        {/* A small count has no proportional bar: the uniform hatched block takes its slot. */}
        {isSmallCountText(displays[index])
          ? <div className="sc-slot" aria-hidden="true"><SuppressedBlock /></div>
          : <div className="pilot-bar"><i style={{ width: `${((row.value ?? 0) / max) * 100}%` }} /></div>}
        <span className="num"><NaValue value={displays[index]} /></span>
      </div>
    ))}
    {displays.some(isSmallCountText) ? <SuppressedLegend /> : null}
  </div>;
}

// --- Institution -------------------------------------------------------------

/**
 * The placement officer's Placement Dashboard. Re-skin phase 6 moved it to the approved Momentum
 * composition in rolePortal/placementOfficerHome.tsx; this name stays so existing callers do not change.
 */
export function InstitutionDashboardV3({ institutionId, basePath }: { readonly institutionId: string; readonly basePath: string }): React.ReactElement {
  return <PlacementOfficerHome institutionId={institutionId} basePath={basePath} />;
}

// --- Employer ----------------------------------------------------------------

interface EmployerV3Data {
  /** EMP-15: the server-computed figures; null (NA in every slot) when they could not be read. */
  readonly summary: EmployerSummaryDto | null;
  /** EMP-15: the employer's interviews, for this week's list; null when the list could not be read. */
  readonly interviews: readonly EmployerInterviewDto[] | null;
  /** EMP-11: this employer's campus drives; null (NA) when they could not be read. */
  readonly drives: readonly CampusDriveDto[] | null;
  readonly applicants: readonly (EmployerApplicantDto & { readonly opportunityTitle: string })[];
}


/** The interviews that count toward "this week": the server's window, not cancelled. */
function interviewsInWeek(interviews: readonly EmployerInterviewDto[], summary: EmployerSummaryDto): readonly EmployerInterviewDto[] {
  const start = new Date(summary.week.startsAt).getTime();
  const end = new Date(summary.week.endsAt).getTime();
  return interviews
    .filter((item) => item.state !== 'CANCELLED' && item.scheduledStart !== null)
    .filter((item) => { const at = new Date(item.scheduledStart!).getTime(); return at >= start && at < end; })
    .sort((a, b) => a.scheduledStart!.localeCompare(b.scheduledStart!));
}

function interviewCandidate(item: EmployerInterviewDto): string {
  if (item.consentRevoked) return 'Withdrawn — details no longer shared';
  if (item.candidateAccess === false) return 'Details no longer shared';
  return item.candidateName ?? 'Candidate';
}

export function EmployerDashboardV3({ basePath }: { readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<EmployerV3Data | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void getSecurityContext(token, controller.signal).then(async (context) => {
      const membership = context.memberships.find((item) => ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(item.role));
      if (!membership) { setError('This identity has no active employer-scoped membership.'); return; }
      const employerId = membership.organizationId;
      // EMP-15: every figure comes from the one summary the server computes in SQL. The lists below
      // only feed the named rows (Recently Shortlisted, this week's interviews), each person shown
      // only while their applicant-access grant is live.
      const [summary, interviews, drives, opportunities] = await Promise.all([
        getEmployerSummary(token, employerId, controller.signal).then((response) => response.summary).catch(() => null),
        listEmployerInterviews(token, employerId, controller.signal).then((response) => response.interviews).catch(() => null),
        listEmployerCampusDrives(token, employerId, undefined, controller.signal).then((response) => response.drives ?? []).catch(() => null),
        listEmployerOpportunities(token, employerId, controller.signal).then((response) => response.opportunities).catch(() => [] as readonly EmployerOpportunityDto[]),
      ]);
      const groups = await Promise.all(opportunities.filter((item) => item.applicationCount > 0).slice(0, 4).map((opportunity) =>
        listEmployerApplicants(token, employerId, opportunity.id, controller.signal)
          .then((response) => response.applications.map((applicant) => ({ ...applicant, opportunityTitle: opportunity.title ?? opportunity.referenceCode })))
          .catch(() => [])));
      setData({ summary, interviews, drives, applicants: groups.flat() });
    }).catch(() => setError('Unable to resolve employer context.'));
    return () => controller.abort();
  }, [token]);

  if (error) return <section className="pilot-card"><h2>Recruiter Dashboard</h2><p style={{ color: 'var(--p-muted)' }}>{error}</p></section>;
  if (!data) return <section className="pilot-card"><h2>Recruiter Dashboard</h2><p style={{ color: 'var(--p-muted)' }}>Loading…</p></section>;

  const summary = data.summary;
  const figure = (value: number | undefined): string => (summary && value !== undefined ? String(value) : 'NA');
  const stage = (key: string): number | null => (summary ? summary.currentStages[key] ?? 0 : null);
  const shortlistRows = data.applicants.filter((applicant) => ['SHORTLIST', 'INTERVIEW'].some((needle) => applicant.state.includes(needle))).slice(0, 5);
  const mix = [
    // The approved stage colours: the early stages in the brand blues, Interview cyan, Offer orange.
    { label: 'Applied', value: stage('APPLIED'), color: 'var(--band-1)' },
    { label: 'Screening', value: stage('SCREENING'), color: 'var(--band-2)' },
    { label: 'Shortlisted', value: stage('SHORTLISTED'), color: 'var(--band-3)' },
    { label: 'Assessment', value: stage('ASSESSMENT'), color: 'var(--band-4)' },
    { label: 'Interview', value: stage('INTERVIEW'), color: 'var(--cyan)' },
    { label: 'Offer', value: stage('OFFER'), color: 'var(--orange)' },
  ];
  const weekInterviews = summary && data.interviews ? interviewsInWeek(data.interviews, summary) : null;
  const openDrives = (data.drives ?? []).filter((drive) => !['REJECTED', 'COMPLETED', 'CANCELLED'].includes(drive.state));
  const muted = { color: 'var(--p-muted)', margin: '4px 0' } as const;

  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div className="pilot-greeting">
          <h1>Recruiter Dashboard</h1>
          <p>Your open roles, pipeline health and the interviews coming up this week.</p>
        </div>
        <button type="button" className="pilot-btn" onClick={() => go(`${basePath}/opportunities`)}><Icon name="plus" size={16} /> Post a Role</button>
      </div>

      {!summary ? <div className="pilot-banner amber" role="status"><Icon name="warning" size={16} /> Your hiring figures could not be loaded, so they read NA.</div> : null}

      <div className="pilot-row cols-5">
        {([
          ['Open Roles', figure(summary?.openJobs), 'blue', 'opportunities', null],
          ['Total Applicants', figure(summary?.applicationsTotal), 'indigo', 'applicants', summary ? `${summary.newApplicantsLast7Days} new in 7 days` : null],
          ['In Pipeline', figure(summary?.openApplications), 'purple', 'pipeline', null],
          ['Offers Pending', figure(summary?.offersPending), 'amber', 'offers', null],
          ['Hires', figure(summary?.hires), 'green', 'placement', null],
        ] as const).map(([label, value, tone, glyph, note]) => (
          <section key={label} className="pilot-card pilot-kpi">
            <span className={`pilot-tile ${tone}`}><Icon name={glyph} size={16} /></span>
            <div><b><NaValue value={value} /></b><small>{label}</small>{note ? <><br /><small>{note}</small></> : null}</div>
          </section>
        ))}
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Hiring Funnel</h2><small style={{ color: 'var(--p-muted)' }}>All roles · where applications are now</small></div>
          <Funnel label="Hiring funnel stages" naReason="Each stage reads NA until your hiring figures can be loaded." rows={[
            { label: 'Applied', value: summary ? summary.applicationsTotal : null },
            { label: 'Shortlisted', value: stage('SHORTLISTED') },
            { label: 'Interview', value: stage('INTERVIEW') },
            { label: 'Offer', value: stage('OFFER') },
            { label: 'Hired', value: summary ? summary.hires : null },
          ]} />
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>This Week&apos;s Interviews</h2>
            <span className="pilot-chip slate">{summary ? `${summary.interviewsThisWeek} this week` : 'NA'}</span></div>
          {!summary ? <p style={muted}>Interviews this week could not be counted — NA.</p>
            : weekInterviews === null ? <p style={muted}>The interview list could not be loaded. Open Interviews to try again.</p>
              : weekInterviews.length ? <div className="pilot-list">{weekInterviews.slice(0, 5).map((item) => (
                <div key={item.id} className="pilot-list-row">
                  <span className="pilot-tile purple"><Icon name="meetings" size={16} /></span>
                  <div className="grow"><strong>{interviewCandidate(item)}</strong><small>Round {item.roundNumber} · {item.title || 'NA'}</small></div>
                  <small>{new Date(item.scheduledStart!).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>
                </div>))}</div>
                : <p style={muted}>No interviews this week.</p>}
          <button type="button" className="pilot-link" onClick={() => go(`${basePath}/interviews`)}>Open Interviews</button>
        </section>
      </div>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Recently Shortlisted</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/applicants`)}>Open Applicants</button></div>
        <div className="pilot-list">
          {shortlistRows.length ? shortlistRows.map((applicant) => (
            <div key={applicant.id} className="pilot-list-row">
              <span className="pilot-avatar" style={{ width: 34, height: 34, fontSize: 11.5 }}>{(applicant.candidateName ?? 'C').split(/\s+/).slice(0, 2).map((word) => word[0]).join('')}</span>
              <div className="grow"><strong>{applicant.candidateName ?? 'Candidate'}</strong><small>{applicant.opportunityTitle}</small></div>
              <StatusTag kind="application" state={applicant.state} label={codeLabel(applicant.state)} />
            </div>
          )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Nobody shortlisted yet.</p>}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Pipeline Mix</h2><small style={{ color: 'var(--p-muted)' }}>Active candidates</small></div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <MultiRing segments={mix.filter((entry) => (entry.value ?? 0) > 0).map((entry) => ({ value: entry.value ?? 0, color: entry.color }))}>
            {figure(summary?.openApplications)}<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>In pipeline</div>
          </MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            {mix.map((entry) => <div key={entry.label}><i style={{ background: entry.color }} /> {entry.label} <span className="num">{entry.value ?? 'NA'}</span></div>)}
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Campus Drives</h2>
          <span className="pilot-chip slate">{summary ? `${summary.drivesAwaitingApproval} awaiting colleges` : 'NA'}</span></div>
        {summary && summary.drivesChangesRequested > 0
          ? <p style={muted}>{summary.drivesChangesRequested} drive{summary.drivesChangesRequested === 1 ? '' : 's'} need{summary.drivesChangesRequested === 1 ? 's' : ''} your changes.</p> : null}
        {!data.drives ? <p style={muted}>Campus drives could not be loaded — NA.</p>
          : openDrives.length
            ? <div className="pilot-list">{openDrives.slice(0, 4).map((drive) => (
              <div key={drive.id} className="pilot-list-row">
                <span className="pilot-tile indigo"><Icon name="company" size={16} /></span>
                <div className="grow"><strong>{drive.institutionName}</strong><small>{drive.opportunityTitle ?? 'Untitled'}</small></div>
                <StatusTag state={drive.state} label={campusDriveStateLabels[drive.state]} />
              </div>))}</div>
            : <p style={muted}>No open campus drives. Request one from a job&apos;s Opportunity Detail.</p>}
      </section>
      <div className="pilot-banner blue"><Icon name="analytics" size={16} /> {!summary ? 'Open applications: NA.' : summary.openApplications > 0 ? `${summary.openApplications} open application${summary.openApplications === 1 ? '' : 's'} awaiting your review.` : 'No open applications right now.'}</div>
    </aside>
  </div></div>;
}
