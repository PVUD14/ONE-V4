import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Briefcase, Building2, ClipboardCheck, Download, Plus, TrendingUp, Users, Video } from 'lucide-react';
import { MultiRing, Spark } from './pilot/pilotComponents.js';
import {
  getProtectedAccessToken,
  getSecurityContext,
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
  studentActivationLabels,
} from './api.js';

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

function Funnel({ rows }: { readonly rows: readonly { readonly label: string; readonly value: number | null }[] }): React.ReactElement {
  const max = Math.max(...rows.map((row) => row.value ?? 0), 1);
  return <div className="pilot-funnel">
    {rows.map((row) => (
      <div key={row.label} className="pilot-funnel-row">
        <span>{row.label}</span>
        <div className="pilot-bar"><i style={{ width: `${((row.value ?? 0) / max) * 100}%` }} /></div>
        <span className="num">{row.value ?? 'NA'}</span>
      </div>
    ))}
  </div>;
}

// --- Institution -------------------------------------------------------------

interface InstitutionV3Data {
  readonly students: readonly InstitutionStudentDto[] | null;
  /** Server-computed over the same roster the Students page lists, so the two always agree. */
  readonly activation: Readonly<Record<StudentActivationState, number>> | null;
  readonly exams: readonly InstitutionExamDto[] | null;
  readonly units: readonly InstitutionUnitDto[] | null;
  readonly notAttempted: readonly (ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string })[];
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
    ]).then(async ([roster, exams, units]) => {
      const students = roster?.students ?? null;
      const activation = roster?.activationSummary ?? null;
      const target = exams?.find((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0) ?? null;
      const notAttempted = target
        ? await listInstitutionExamResults(token, institutionId, target.id).then((response) =>
            response.notAttempted.map((entry) => ({ ...entry, examTitle: target.title, endsAt: target.endsAt }))).catch(() => [])
        : [];
      setData({ students, activation, exams, units, notAttempted });
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
          ['Placement Eligible', 'NA', 'indigo', ClipboardCheck],
          ['Offers This Season', 'NA', 'green', TrendingUp],
          ['Students Placed', 'NA', 'teal', Building2],
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
          <div className="pilot-card-head"><h2>Placement Pipeline</h2><small style={{ color: 'var(--p-muted)' }}>This season</small></div>
          <Funnel rows={[
            { label: 'Eligible', value: null }, { label: 'Applied', value: null },
            { label: 'Shortlisted', value: null }, { label: 'Offers', value: null }, { label: 'Placed', value: null },
          ]} />
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
        <div className="pilot-card-head"><h2>Offers Trend</h2><span className="pilot-chip slate">NA</span></div>
        <Spark points={[0, 0, 0, 0, 0, 0, 0]} tone="green" />
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Upcoming Drives</h2><span className="pilot-chip slate">NA</span></div>
        <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Placement drives are not built yet — NA.</p>
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
  readonly opportunities: readonly EmployerOpportunityDto[];
  readonly applicants: readonly (EmployerApplicantDto & { readonly opportunityTitle: string })[];
}

const STAGE_TONE: Readonly<Record<string, string>> = { SHORTLISTED: 'indigo', INTERVIEW: 'purple', APPLIED: 'blue', OFFER: 'amber', HIRED: 'green' };

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
      const opportunities = await listEmployerOpportunities(token, membership.organizationId, controller.signal).then((response) => response.opportunities).catch(() => [] as readonly EmployerOpportunityDto[]);
      const groups = await Promise.all(opportunities.filter((item) => item.applicationCount > 0).slice(0, 4).map((opportunity) =>
        listEmployerApplicants(token, membership.organizationId, opportunity.id, controller.signal)
          .then((response) => response.applications.map((applicant) => ({ ...applicant, opportunityTitle: opportunity.title ?? opportunity.referenceCode })))
          .catch(() => [])));
      setData({ opportunities, applicants: groups.flat() });
    }).catch(() => setError('Unable to resolve employer context.'));
    return () => controller.abort();
  }, [token]);

  if (error) return <section className="pilot-card"><h2>Recruiter Dashboard</h2><p style={{ color: 'var(--p-muted)' }}>{error}</p></section>;
  if (!data) return <section className="pilot-card"><h2>Recruiter Dashboard</h2><p style={{ color: 'var(--p-muted)' }}>Loading…</p></section>;

  const openRoles = data.opportunities.filter((item) => item.lifecycleState === 'PUBLISHED').length;
  const totalApplicants = data.opportunities.reduce((sum, item) => sum + item.applicationCount, 0);
  const inPipeline = data.opportunities.reduce((sum, item) => sum + item.openApplicationCount, 0);
  const byStage = (needle: string): number => data.applicants.filter((applicant) => applicant.state.includes(needle)).length;
  const offers = data.applicants.filter((applicant) => applicant.offerState).length;
  const hires = byStage('HIRED');
  const shortlistRows = data.applicants.filter((applicant) => ['SHORTLIST', 'INTERVIEW'].some((needle) => applicant.state.includes(needle))).slice(0, 5);
  const mix = [
    { label: 'Applied', value: byStage('APPLIED') + byStage('SUBMITTED'), color: '#1f55e5' },
    { label: 'Shortlisted', value: byStage('SHORTLIST'), color: '#4f46e5' },
    { label: 'Interview', value: byStage('INTERVIEW'), color: '#5936cf' },
    { label: 'Offer', value: offers, color: '#b45309' },
  ];

  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <div className="pilot-page-head">
        <div className="pilot-greeting">
          <h1>Recruiter Dashboard</h1>
          <p>Your open roles, pipeline health and the interviews coming up this week.</p>
        </div>
        <button type="button" className="pilot-btn" onClick={() => go(`${basePath}/opportunities`)}><Plus size={15} /> Post a Role</button>
      </div>

      <div className="pilot-row cols-5">
        {([
          ['Open Roles', String(openRoles), 'blue', Briefcase],
          ['Total Applicants', String(totalApplicants), 'indigo', Users],
          ['In Pipeline', String(inPipeline), 'purple', ClipboardCheck],
          ['Offers Extended', String(offers), 'amber', TrendingUp],
          ['Hires', String(hires), 'green', Building2],
        ] as const).map(([label, value, tone, Icon]) => (
          <section key={label} className="pilot-card pilot-kpi">
            <span className={`pilot-tile ${tone}`}><Icon size={17} /></span>
            <div><b>{value}</b><small>{label}</small></div>
          </section>
        ))}
      </div>

      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Hiring Funnel</h2><small style={{ color: 'var(--p-muted)' }}>All roles · this season</small></div>
          <Funnel rows={[
            { label: 'Applied', value: totalApplicants },
            { label: 'Shortlisted', value: byStage('SHORTLIST') },
            { label: 'Interview', value: byStage('INTERVIEW') },
            { label: 'Offer', value: offers },
            { label: 'Hired', value: hires },
          ]} />
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>This Week&apos;s Interviews</h2><span className="pilot-chip slate">NA</span></div>
          <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>An interview calendar is not built yet — NA. Interviews are scheduled from the applicant row.</p>
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
          <MultiRing segments={mix.filter((entry) => entry.value > 0).map((entry) => ({ value: entry.value, color: entry.color }))}>
            {inPipeline}<div style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--p-muted)' }}>In pipeline</div>
          </MultiRing>
          <div className="pilot-legend" style={{ flex: 1 }}>
            {mix.map((entry) => <div key={entry.label}><i style={{ background: entry.color }} /> {entry.label} <span className="num">{entry.value}</span></div>)}
          </div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Campus Drives</h2><span className="pilot-chip slate">NA</span></div>
        <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Structured campus drives are not built yet — NA.</p>
      </section>
      <div className="pilot-banner blue"><TrendingUp size={17} /> {inPipeline > 0 ? `${inPipeline} open application${inPipeline === 1 ? '' : 's'} awaiting your review.` : 'No open applications right now.'}</div>
    </aside>
  </div></div>;
}
