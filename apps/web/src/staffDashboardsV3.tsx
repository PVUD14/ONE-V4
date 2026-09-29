import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Briefcase, Building2, ClipboardCheck, Download, Plus, TrendingUp, Users, Video } from 'lucide-react';
import { MultiRing, Spark } from './pilot/pilotComponents.js';
import {
  getProtectedAccessToken,
  getSecurityContext,
  getVerificationSummary,
  listEmployerApplicants,
  listEmployerOpportunities,
  listInstitutionExamResults,
  listInstitutionExams,
  listInstitutionStudents,
  listInstitutionUnits,
  type EmployerApplicantDto,
  type EmployerOpportunityDto,
  type ExamNotAttemptedDto,
  type InstitutionExamDto,
  type InstitutionStudentDto,
  type InstitutionUnitDto,
  type StudentActivationState,
  type VerificationSummaryDto,
  studentActivationLabels,
} from './api.js';
import { campusDriveStateLabels, listEmployerCampusDrives, listInstitutionCampusDrives, type CampusDriveDto } from './api/campusDrives.js';
import { getPlacementStatistics, type PlacementStatisticsDto } from './api/placementRegister.js';
import type { SuppressedCountDto } from './api/privacyOperations.js';
import { getEmployerSummary, listEmployerInterviews, type EmployerInterviewDto, type EmployerSummaryDto } from './api/hiring.js';

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

function Funnel({ rows }: { readonly rows: readonly { readonly label: string; readonly value: number | null; readonly display?: string }[] }): React.ReactElement {
  const max = Math.max(...rows.map((row) => row.value ?? 0), 1);
  return <div className="pilot-funnel">
    {rows.map((row) => (
      <div key={row.label} className="pilot-funnel-row">
        <span>{row.label}</span>
        <div className="pilot-bar"><i style={{ width: `${((row.value ?? 0) / max) * 100}%` }} /></div>
        <span className="num">{row.display ?? row.value ?? 'NA'}</span>
      </div>
    ))}
  </div>;
}

/** INST-12: a suppressed count for the funnel: the bar only when published, <5 when withheld, NA without a source. */
function funnelRow(label: string, count: SuppressedCountDto | null | undefined): { readonly label: string; readonly value: number | null; readonly display: string } {
  if (!count) return { label, value: null, display: 'NA' };
  return count.suppressed ? { label, value: null, display: '<5' } : { label, value: count.value, display: String(count.value) };
}

// --- Institution -------------------------------------------------------------

function countLabel(count: SuppressedCountDto | null | undefined): string {
  if (!count) return 'NA';
  return count.suppressed ? '<5' : String(count.value);
}

/** Where each institution portal reaches the verification queue (existing labels only). */
function verificationPath(basePath: string): string | null {
  if (basePath.endsWith('/faculty')) return `${basePath}/academic-verification`;
  if (basePath.endsWith('/admin') || basePath.endsWith('/department-head')) return `${basePath}/students`;
  return null;
}

interface InstitutionV3Data {
  readonly students: readonly InstitutionStudentDto[] | null;
  /** Server-computed over the same roster the Students page lists, so the two always agree. */
  readonly activation: Readonly<Record<StudentActivationState, number>> | null;
  readonly exams: readonly InstitutionExamDto[] | null;
  readonly units: readonly InstitutionUnitDto[] | null;
  readonly notAttempted: readonly (ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string })[];
  /** INST-04 verification backlog, counted server-side over the reader's scope; null reads NA. */
  readonly verification: VerificationSummaryDto | null;
  /** EMP-11: confirmed drives ahead and requests awaiting a decision; null (NA) when this role cannot read drives. */
  readonly drives: { readonly upcoming: readonly CampusDriveDto[]; readonly waiting: number } | null;
  /** INST-12: season statistics as of the last month end; null (NA) when this role cannot read them. */
  readonly placement: PlacementStatisticsDto | null;
}

/** EMP-11: the college's scheduled drives still ahead, soonest first, and how many requests wait. */
async function loadCollegeDrives(token: string, institutionId: string, signal: AbortSignal): Promise<InstitutionV3Data['drives']> {
  const [scheduled, requested] = await Promise.all([
    listInstitutionCampusDrives(token, institutionId, { state: 'SCHEDULED' }, signal),
    listInstitutionCampusDrives(token, institutionId, { state: 'REQUESTED' }, signal),
  ]);
  const now = Date.now();
  return {
    upcoming: (scheduled.drives ?? []).filter((drive) => drive.scheduledStartAt && Date.parse(drive.scheduledStartAt) >= now)
      .sort((a, b) => Date.parse(a.scheduledStartAt ?? '') - Date.parse(b.scheduledStartAt ?? '')),
    waiting: (requested.drives ?? []).length,
  };
}

export function InstitutionDashboardV3({ institutionId, basePath }: { readonly institutionId: string; readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<InstitutionV3Data | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void Promise.all([
      listInstitutionStudents(token, institutionId, controller.signal).catch(() => null),
      listInstitutionExams(token, institutionId, controller.signal).then((response) => response.assessments).catch(() => null),
      listInstitutionUnits(token, institutionId, controller.signal).then((response) => response.units).catch(() => null),
      getVerificationSummary(token, institutionId, controller.signal).then((response) => response.summary ?? null).catch(() => null),
      loadCollegeDrives(token, institutionId, controller.signal).catch(() => null),
      getPlacementStatistics(token, institutionId, controller.signal).then((response) => (response && response.overall ? response : null)).catch(() => null),
    ]).then(async ([roster, exams, units, verification, drives, placement]) => {
      const students = roster?.students ?? null;
      const activation = roster?.activationSummary ?? null;
      const target = exams?.find((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0) ?? null;
      const notAttempted = target
        ? await listInstitutionExamResults(token, institutionId, target.id).then((response) =>
            response.notAttempted.map((entry) => ({ ...entry, examTitle: target.title, endsAt: target.endsAt }))).catch(() => [])
        : [];
      setData({ students, activation, exams, units, notAttempted, verification, drives, placement });
    });
    return () => controller.abort();
  }, [token, institutionId]);

  if (!data) return <section className="pilot-card"><h2>Placement Dashboard</h2><p style={{ color: 'var(--p-muted)' }}>Loading…</p></section>;

  const activeStudents = (data.students ?? []).filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE').length;
  const departments = (data.units ?? []).filter((unit) => unit.kind === 'DEPARTMENT');

  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div className="pilot-greeting">
          <h1>Placement Dashboard</h1>
          <p>Cohort readiness, placement activity and the students who need you this week.</p>
        </div>
        <button type="button" className="pilot-btn ghost" onClick={() => go(`${basePath}/assessments`)}><Download size={15} /> Export Report</button>
      </div>

      <div className="pilot-row cols-5">
        {([
          ['Active Students', String(activeStudents), 'blue', Users],
          ['Placement Eligible', data.placement ? countLabel(data.placement.overall.eligible) : 'NA', 'indigo', ClipboardCheck],
          ['Students With Offers', data.placement ? countLabel(data.placement.overall.withOffer) : 'NA', 'green', TrendingUp],
          ['Students Placed', data.placement ? countLabel(data.placement.overall.placed) : 'NA', 'teal', Building2],
          ['Need Intervention', String(data.notAttempted.length), 'rose', AlertTriangle],
        ] as const).map(([label, value, tone, Icon]) => (
          <section key={label} className="pilot-card pilot-kpi">
            <span className={`pilot-tile ${tone}`}><Icon size={17} /></span>
            <div><b>{value}</b><small>{label}</small></div>
          </section>
        ))}
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Cohort Readiness</h2><small style={{ color: 'var(--p-muted)' }}>{activeStudents} on roster</small></div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            <MultiRing segments={[]}>NA<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>Avg readiness</div></MultiRing>
            <div className="pilot-legend" style={{ flex: 1 }}>
              {['Job Ready', 'Nearly Ready', 'Developing', 'Needs Support'].map((label) => (
                <div key={label}><i style={{ background: '#e5eaf2' }} /> {label} <span className="num">NA</span></div>
              ))}
            </div>
          </div>
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Placement Pipeline</h2><small style={{ color: 'var(--p-muted)' }}>{data.placement ? `As of ${data.placement.asOf.lastDay}` : 'NA'}</small></div>
          <Funnel rows={[
            funnelRow('Eligible', data.placement?.overall.eligible), funnelRow('Applied', data.placement?.overall.applied),
            funnelRow('Shortlisted', data.placement?.overall.shortlisted), funnelRow('Offers', data.placement?.overall.withOffer), funnelRow('Placed', data.placement?.overall.placed),
          ]} />
          <small style={{ color: 'var(--p-muted)' }}>From applications students shared with the college. A student who shared nothing is not counted as unplaced.</small>
        </section>
      </div>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Student Activation</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/students`)}>View Students</button></div>
        <div className="pilot-legend">
          {(['ACTIVATED', 'INVITED', 'EXPIRED', 'BOUNCED', 'NOT_INVITED'] as const).map((state) => (
            <div key={state}><i style={{ background: '#e5eaf2' }} /> {studentActivationLabels[state]} <span className="num">{data.activation ? data.activation[state] : 'NA'}</span></div>
          ))}
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Academic Verification</h2>{verificationPath(basePath)
          ? <button type="button" className="pilot-link" onClick={() => go(verificationPath(basePath)!)}>Review Queue</button> : null}</div>
        <div className="pilot-legend">
          <div><i style={{ background: '#e5eaf2' }} /> Waiting for a decision <span className="num">{data.verification ? data.verification.pending : 'NA'}</span></div>
          <div><i style={{ background: '#e5eaf2' }} /> From former students or people not on the roster <span className="num">{data.verification ? data.verification.notCurrent : 'NA'}</span></div>
        </div>
      </section>

      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Students Needing Attention</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/assessments`)}>View All</button></div>
        <div className="pilot-list">
          {data.notAttempted.length ? data.notAttempted.slice(0, 5).map((entry) => (
            <div key={entry.institutionStudentId} className="pilot-list-row">
              <span className="pilot-tile rose"><AlertTriangle size={16} /></span>
              <div className="grow"><strong>{entry.studentName}</strong><small>{entry.inProgress ? `In progress now: ${entry.examTitle}` : `Has not attempted: ${entry.examTitle}`}</small></div>
              <span className="pilot-chip amber">Due {new Date(entry.endsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              <button type="button" className="pilot-btn ghost small" onClick={() => go(`${basePath}/assessments`)}>Review</button>
            </div>
          )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Nobody needs attention right now — every assigned assessment is attempted.</p>}
        </div>
      </section>
    </div>

    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Offers Trend</h2><span className="pilot-chip slate">{data.placement ? 'Last 6 months' : 'NA'}</span></div>
        {data.placement && data.placement.offersByMonth.length && data.placement.offersByMonth.every((entry) => !entry.offers.suppressed)
          ? <Spark points={data.placement.offersByMonth.map((entry) => entry.offers.value ?? 0)} tone="green" />
          : <Spark points={[0, 0, 0, 0, 0, 0, 0]} tone="green" />}
        {data.placement ? <div className="pilot-legend">{data.placement.offersByMonth.map((entry) => (
          <div key={entry.month}><i style={{ background: '#e5eaf2' }} /> {entry.month} <span className="num">{countLabel(entry.offers)}</span></div>))}</div>
          : <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Offer figures are not available to your role — NA.</p>}
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Drives</h2>{data.drives
          ? <span className={`pilot-chip ${data.drives.waiting ? 'amber' : 'slate'}`}>{data.drives.waiting} awaiting decision</span>
          : <span className="pilot-chip slate">NA</span>}</div>
        {!data.drives ? <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Campus drives are not available to your role — NA.</p>
          : data.drives.upcoming.length ? <div className="pilot-list">{data.drives.upcoming.slice(0, 4).map((drive) => (
            <div key={drive.id} className="pilot-list-row">
              <span className="pilot-tile blue"><Building2 size={16} /></span>
              <div className="grow"><strong>{drive.employerName}</strong><small>{drive.opportunityTitle ?? 'Untitled'} · {new Date(drive.scheduledStartAt ?? '').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></div>
            </div>))}</div>
            : <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>No drive is scheduled yet.</p>}
      </section>
      <section className="pilot-card">
        <h2>Department Readiness</h2>
        {departments.length ? departments.slice(0, 5).map((department) => (
          <div key={department.id} className="pilot-skill">
            <header><b>{department.name}</b><span>NA</span></header>
            <div className="pilot-bar thin"><i style={{ width: '0%' }} /></div>
          </div>
        )) : <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>No departments defined yet.</p>}
      </section>
    </aside>
  </div></div>;
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

const STAGE_TONE: Readonly<Record<string, string>> = { SHORTLISTED: 'indigo', INTERVIEW: 'purple', APPLIED: 'blue', OFFER: 'amber', HIRED: 'green' };

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
    { label: 'Applied', value: stage('APPLIED'), color: '#1f55e5' },
    { label: 'Screening', value: stage('SCREENING'), color: '#0e7490' },
    { label: 'Shortlisted', value: stage('SHORTLISTED'), color: '#4f46e5' },
    { label: 'Assessment', value: stage('ASSESSMENT'), color: '#0f766e' },
    { label: 'Interview', value: stage('INTERVIEW'), color: '#5936cf' },
    { label: 'Offer', value: stage('OFFER'), color: '#b45309' },
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
        <button type="button" className="pilot-btn" onClick={() => go(`${basePath}/opportunities`)}><Plus size={15} /> Post a Role</button>
      </div>

      {!summary ? <div className="pilot-banner amber" role="status"><AlertTriangle size={17} /> Your hiring figures could not be loaded, so they read NA.</div> : null}

      <div className="pilot-row cols-5">
        {([
          ['Open Roles', figure(summary?.openJobs), 'blue', Briefcase, null],
          ['Total Applicants', figure(summary?.applicationsTotal), 'indigo', Users, summary ? `${summary.newApplicantsLast7Days} new in 7 days` : null],
          ['In Pipeline', figure(summary?.openApplications), 'purple', ClipboardCheck, null],
          ['Offers Extended', figure(summary?.offersPending), 'amber', TrendingUp, summary ? 'Awaiting an answer' : null],
          ['Hires', figure(summary?.hires), 'green', Building2, null],
        ] as const).map(([label, value, tone, Icon, note]) => (
          <section key={label} className="pilot-card pilot-kpi">
            <span className={`pilot-tile ${tone}`}><Icon size={17} /></span>
            <div><b>{value}</b><small>{label}</small>{note ? <small>{note}</small> : null}</div>
          </section>
        ))}
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Hiring Funnel</h2><small style={{ color: 'var(--p-muted)' }}>All roles · where applications are now</small></div>
          <Funnel rows={[
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
                  <span className="pilot-tile purple"><Video size={16} /></span>
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
              <span className={`pilot-chip ${STAGE_TONE[applicant.state] ?? 'blue'}`}>{applicant.state.replaceAll('_', ' ')}</span>
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
                <span className="pilot-tile indigo"><Building2 size={16} /></span>
                <div className="grow"><strong>{drive.institutionName}</strong><small>{drive.opportunityTitle ?? 'Untitled'}</small></div>
                <span className="pilot-chip blue">{campusDriveStateLabels[drive.state]}</span>
              </div>))}</div>
            : <p style={muted}>No open campus drives. Request one from a job&apos;s Opportunity Detail.</p>}
      </section>
      <div className="pilot-banner blue"><TrendingUp size={17} /> {!summary ? 'Open applications: NA.' : summary.openApplications > 0 ? `${summary.openApplications} open application${summary.openApplications === 1 ? '' : 's'} awaiting your review.` : 'No open applications right now.'}</div>
    </aside>
  </div></div>;
}
