/**
 * ONE · Role portal — Institution — Department head and faculty workspaces (INST-07)
 *
 * The department head's Department Overview, Readiness, Batches, Placement Pipeline,
 * Opportunities and Offers, and Reports and Analytics, the department staff list on
 * Faculty and Staff, and the lecturer's Assessment Detail and class Reports. Each is a
 * department-scoped version of an admin module: the server decides whose students are
 * counted (the INST-02 scope helper) and suppresses small groups, and nothing is filtered
 * or counted for security here. Missing sources read NA; a group under five reads <5;
 * readiness is bands only; offers show whether one exists and how the student answered,
 * never pay.
 */
import { Icon, type IconName } from '../icons/Icon.js';
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  getDepartmentOverview,
  getPlacementPipeline,
  getProtectedAccessToken,
  getVerificationSummary,
  institutionStudentScopeLabel,
  listClassReports,
  listDepartmentStaff,
  listInstitutionExamResults,
  listInstitutionExams,
  listPlacementApplications,
  studentActivationLabels,
  suppressedCountLabel,
} from '../api.js';
import type {
  ClassReportsDto,
  DepartmentOverviewDto,
  DepartmentStaffDto,
  InstitutionExamDto,
  PlacementApplicationDto,
  PlacementPipelineDto,
  ReadinessAggregateDto,
  SuppressedTableDto,
  VerificationSummaryDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { InstitutionReportsPage } from '../institutionReportsPage.js';
import { InstitutionExportsPanel } from './institutionAnalytics.js';
import { placementStatusLabels } from './institutionPlacementStatus.js';
import { go } from '../pilotParity/naWidgets.js';
import { InstitutionWorkspaceError, RestrictedApiState, formatApiError, isInstitutionStaffWorkspace } from './shared.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { supportCodeSuffix } from '../supportCode.js';
import { PilotKpi } from '../naState.js';

type WorkspaceProps = { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined };

const readinessBandLabels: Readonly<Record<string, string>> = {
  NOT_ENOUGH_EVIDENCE: 'Not enough evidence',
  DEVELOPING: 'Developing',
  PROGRESSING: 'Progressing',
  READY_FOR_NEXT_STEP: 'Ready for next step',
};

export const applicationStageLabels: Readonly<Record<string, string>> = {
  APPLIED: 'Applied', SCREENING: 'Screening', SHORTLISTED: 'Shortlisted', ASSESSMENT: 'Assessment', INTERVIEW: 'Interview',
  OFFER: 'Offer', HIRED: 'Hired', REJECTED: 'Not selected', WITHDRAWN: 'Withdrawn',
};

export const offerResponseLabels: Readonly<Record<string, string>> = {
  EXTENDED: 'Offer made — awaiting answer', ACCEPTED: 'Offer accepted', DECLINED: 'Offer declined', WITHDRAWN: 'Offer withdrawn', EXPIRED: 'Offer expired',
};

/** A load error as the screen may show it: plain words and the reference, never upstream text. */
export function loadError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.status === 403) return `You do not have permission to view this.${supportCodeSuffix(error.correlationId)}`;
  return formatApiError(error, fallback);
}

/** Load one resource for the signed-in institution workspace; null data until it arrives. */
export function useWorkspaceResource<T>(workspace: AuthenticatedWorkspaceSummary | undefined, load: (token: string, institutionId: string, signal: AbortSignal) => Promise<T>, fallback: string): { readonly data: T | null; readonly error: string } {
  const token = getProtectedAccessToken();
  const institutionId = workspace?.organizationId ?? '';
  const [state, setState] = useState<{ readonly data: T | null; readonly error: string }>({ data: null, error: '' });
  useEffect(() => {
    if (!token || !institutionId) return undefined;
    const controller = new AbortController();
    setState({ data: null, error: '' });
    load(token, institutionId, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ data, error: '' }); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setState({ data: null, error: loadError(cause, fallback) }); });
    return () => controller.abort();
    // `load` is a module-level function per caller; the workspace identity is what changes.
  }, [token, institutionId]);
  return state;
}

/** The sign-in and workspace guards every page here shares. Null when the page may render. */
export function workspaceGuard(title: string, workspace: AuthenticatedWorkspaceSummary | undefined, roles?: readonly string[]): React.ReactElement | null {
  if (!getProtectedAccessToken()) return <RestrictedApiState title={title} message="Sign in to your institution staff workspace." />;
  if (!isInstitutionStaffWorkspace(workspace)) return <InstitutionWorkspaceError title={title} />;
  if (roles && !roles.includes(workspace.role)) return <InstitutionWorkspaceError title={title} unauthorized />;
  return null;
}

export function PageHead({ title, summary, scopeLabel }: { readonly title: string; readonly summary: string; readonly scopeLabel?: string | null }): React.ReactElement {
  return <div className="pilot-page-head"><div className="pilot-greeting"><h1>{title}</h1><p>{summary}</p>{scopeLabel ? <p>Showing students in {scopeLabel}.</p> : null}</div></div>;
}

export function Kpis({ items }: { readonly items: readonly (readonly [string, string, string, IconName])[] }): React.ReactElement {
  return <div className={`pilot-row cols-${items.length}`}>
    {items.map(([label, value, tone, glyph]) => <PilotKpi key={label} icon={<Icon name={glyph} size={16} />} tone={tone} value={value} label={label} />)}
  </div>;
}

/** A funnel over a suppressed table: a cell under five reads <5 and draws no bar. */
export function SuppressedFunnel({ table, labels }: { readonly table: SuppressedTableDto | null; readonly labels: Readonly<Record<string, string>> }): React.ReactElement {
  const keys = Object.keys(labels);
  const cells = new Map((table?.cells ?? []).map((cell) => [cell.key, cell]));
  const max = Math.max(1, ...[...cells.values()].map((cell) => cell.count ?? 0));
  return <div className="pilot-funnel">
    {keys.map((key) => {
      const cell = cells.get(key);
      const value = !table ? 'NA' : table.suppressed ? '<5' : suppressedCountLabel(cell ?? null);
      return <div key={key} className="pilot-funnel-row">
        <span>{labels[key]}</span>
        <div className="pilot-bar"><i style={{ width: `${((cell && !cell.suppressed ? cell.count ?? 0 : 0) / max) * 100}%` }} /></div>
        <span className="num">{value}</span>
      </div>;
    })}
  </div>;
}

function ReadinessBands({ month, aggregate }: { readonly month: string | null; readonly aggregate: ReadinessAggregateDto | null }): React.ReactElement {
  if (!aggregate || !month) return <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Readiness bands: NA.</p>;
  if (aggregate.suppressed) {
    return <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Withheld for {month}: fewer than {aggregate.minimumCohortSize} students have readiness records, so no band can be shown without singling someone out.</p>;
  }
  return <div className="pilot-legend">
    {Object.keys(readinessBandLabels).map((band) => {
      const entry = aggregate.bands.find((item) => item.band === band);
      return <div key={band}><i style={{ background: '#e5eaf2' }} /> {readinessBandLabels[band]} <span className="num">{entry ? suppressedCountLabel(entry) : '<5'}</span></div>;
    })}
    <div><i style={{ background: '#e5eaf2' }} /> Students with readiness records <span className="num">{aggregate.cohortSizeSuppressed || aggregate.cohortSize === null ? 'withheld' : aggregate.cohortSize}</span></div>
  </div>;
}

// --- Department Overview ---------------------------------------------------------

export function DepartmentOverviewPage({ authenticatedWorkspace, basePath }: WorkspaceProps & { readonly basePath: string }): React.ReactElement {
  const overview = useWorkspaceResource(authenticatedWorkspace, getDepartmentOverview, 'Unable to load the department overview.');
  const pipeline = useWorkspaceResource(authenticatedWorkspace, (token, id, signal) => getPlacementPipeline(token, id, signal).catch(() => null), '');
  const verification = useWorkspaceResource(authenticatedWorkspace, (token, id, signal) => getVerificationSummary(token, id, signal).then((result) => result.summary ?? null).catch(() => null), '');
  const guard = workspaceGuard('Department Overview', authenticatedWorkspace);
  if (guard) return guard;
  const data = overview.data;
  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Department Overview" summary="Your department's students, activation, assessments, readiness and open work — counted by the server for your scope." scopeLabel={institutionStudentScopeLabel(data?.scope)} />
      {overview.error ? <p className="form-error" role="alert">{overview.error}</p> : null}
      {!data && !overview.error ? <p role="status">Loading the department overview…</p> : null}
      <Kpis items={[
        ['Students on roster', data ? String(data.students.onRoster) : 'NA', 'blue', 'students'],
        ['Currently enrolled', data ? String(data.students.current) : 'NA', 'teal', 'students'],
        ['Assessments in progress', data ? String(data.assessments.inProgress) : 'NA', 'indigo', 'assessments'],
        ['Open interventions', data ? String(data.staffActions.openInterventions) : 'NA', 'rose', 'warning'],
        ['Open tasks', data ? String(data.staffActions.openTasks) : 'NA', 'green', 'tasks'],
      ]} />
      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Cohort Readiness</h2><small style={{ color: 'var(--p-muted)' }}>{data?.readiness.month ? `Month ${data.readiness.month}` : 'NA'}</small></div>
          <ReadinessBands month={data?.readiness.month ?? null} aggregate={data?.readiness.aggregate ?? null} />
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Placement Pipeline</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/placement-pipeline`)}>Open pipeline</button></div>
          <SuppressedFunnel table={pipeline.data?.stages ?? null} labels={{ APPLIED: 'Applied', SHORTLISTED: 'Shortlisted', INTERVIEW: 'Interview', OFFER: 'Offer', HIRED: 'Hired' }} />
          <small style={{ color: 'var(--p-muted)' }}>Applications students have shared with the college. Fewer than five reads &lt;5.</small>
        </section>
      </div>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Student Activation</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/students`)}>View Students</button></div>
        <div className="pilot-legend">
          {(['ACTIVATED', 'INVITED', 'EXPIRED', 'BOUNCED', 'NOT_INVITED'] as const).map((state) => (
            <div key={state}><i style={{ background: '#e5eaf2' }} /> {studentActivationLabels[state]} <span className="num">{data ? data.activation[state] : 'NA'}</span></div>
          ))}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Batches</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/batches`)}>View Batches</button></div>
        <div className="pilot-list">
          {data && data.batches.length ? data.batches.slice(0, 6).map((batch) => (
            <div key={batch.id} className="pilot-list-row">
              <span className="pilot-tile blue"><Icon name="batches" size={16} /></span>
              <div className="grow"><strong>{batch.name}</strong><small>{batch.parentName ?? 'NA'}</small></div>
              <span className="pilot-chip slate">{batch.current} enrolled · {batch.activated} activated</span>
            </div>
          )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>{data ? 'No batches are set up in your department yet.' : 'NA'}</p>}
        </div>
      </section>
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Assessments</h2></div>
        <div className="pilot-legend">
          <div><i style={{ background: '#e5eaf2' }} /> Students with an assessment open <span className="num">{data ? data.assessments.assignedStudents : 'NA'}</span></div>
          <div><i style={{ background: '#e5eaf2' }} /> Of them, completed <span className="num">{data ? data.assessments.completedStudents : 'NA'}</span></div>
        </div>
      </section>
      <VerificationCard summary={verification.data} onOpen={() => go(`${basePath}/students`)} />
    </aside>
  </div></div>;
}

export function VerificationCard({ summary, onOpen }: { readonly summary: VerificationSummaryDto | null; readonly onOpen: () => void }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>Academic Verification</h2><button type="button" className="pilot-link" onClick={onOpen}>Review Queue</button></div>
    <div className="pilot-legend">
      <div><i style={{ background: '#e5eaf2' }} /> Waiting for a decision <span className="num">{summary ? summary.pending : 'NA'}</span></div>
    </div>
  </section>;
}

// --- Batches ---------------------------------------------------------------------

export function DepartmentBatchesPage({ authenticatedWorkspace }: WorkspaceProps): React.ReactElement {
  const overview = useWorkspaceResource(authenticatedWorkspace, getDepartmentOverview, 'Unable to load your batches.');
  const guard = workspaceGuard('Batches', authenticatedWorkspace);
  if (guard) return guard;
  const batches = overview.data?.batches ?? [];
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Your department</span><h1>Batches</h1>
      <p>The batches of your department as your institution has structured them. The structure is read-only here; your institution administrator changes it.</p>
      {institutionStudentScopeLabel(overview.data?.scope) ? <p>Showing students in {institutionStudentScopeLabel(overview.data?.scope)}.</p> : null}</div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🗂️" tone="blue" value={overview.data ? batches.length : 'NA'} label="Batches" />
      <V2Stat icon="🎓" tone="purple" value={overview.data ? overview.data.students.onRoster : 'NA'} label="Students on roster" />
      <V2Stat icon="✅" tone="green" value={overview.data ? overview.data.students.current : 'NA'} label="Currently enrolled" />
      <V2Stat icon="✉️" tone="amber" value={overview.data ? overview.data.activation.ACTIVATED : 'NA'} label="Activated" />
    </div>
    {overview.error ? <p className="form-error" role="alert">{overview.error}</p> : null}
    {!overview.data && !overview.error ? <p role="status">Loading batches…</p> : null}
    {overview.data && batches.length === 0 ? <div className="role-wide"><V2EmptyState icon="🗂️" title="No batches yet"
      note="Your department has no batch units. Your institution administrator adds them under Academic Structure." /></div> : null}
    {batches.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Department batches</caption>
      <thead><tr><th scope="col">Batch</th><th scope="col">Programme or department</th><th scope="col">On roster</th><th scope="col">Currently enrolled</th><th scope="col">Activated</th></tr></thead>
      <tbody>{batches.map((batch) => <tr key={batch.id} className="role-record-row"><th scope="row">{batch.name}</th><td>{batch.parentName ?? 'NA'}</td>
        <td>{batch.students}</td><td>{batch.current}</td><td>{batch.activated}</td></tr>)}</tbody></table></div> : null}
  </section>;
}

// --- Readiness -------------------------------------------------------------------

export function DepartmentReadinessPage({ authenticatedWorkspace, children }: WorkspaceProps & { readonly children?: React.ReactNode }): React.ReactElement {
  const overview = useWorkspaceResource(authenticatedWorkspace, getDepartmentOverview, 'Unable to load readiness.');
  const guard = workspaceGuard('Readiness', authenticatedWorkspace);
  if (guard) return guard;
  return <div className="pilot pilot-embed"><div className="pilot-page"><div className="pilot-content">
    <PageHead title="Readiness" summary="Readiness bands for your department — advisory bands, never scores. A band with fewer than five students reads <5." scopeLabel={institutionStudentScopeLabel(overview.data?.scope)} />
    {overview.error ? <p className="form-error" role="alert">{overview.error}</p> : null}
    <section className="pilot-card">
      <div className="pilot-card-head"><h2>Last month</h2><small style={{ color: 'var(--p-muted)' }}>{overview.data?.readiness.month ?? 'NA'}</small></div>
      <ReadinessBands month={overview.data?.readiness.month ?? null} aggregate={overview.data?.readiness.aggregate ?? null} />
    </section>
    <InstitutionReportsPage key={authenticatedWorkspace?.organizationId ?? ''} institutionId={authenticatedWorkspace?.organizationId ?? ''} />
    {/* INST-17: cohort readiness by career role and preparation sprints for the department. */}
    {children}
  </div></div></div>;
}

// --- Placement Pipeline ------------------------------------------------------------

export function PlacementPipelinePage({ authenticatedWorkspace, basePath, statistics }: WorkspaceProps & { readonly basePath: string; readonly statistics?: React.ReactNode }): React.ReactElement {
  const pipeline = useWorkspaceResource<PlacementPipelineDto>(authenticatedWorkspace, getPlacementPipeline, 'Unable to load the placement pipeline.');
  const guard = workspaceGuard('Placement Pipeline', authenticatedWorkspace);
  if (guard) return guard;
  const data = pipeline.data;
  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Placement Pipeline" summary="Where your department's students are in the applications they have chosen to share with the college." scopeLabel={institutionStudentScopeLabel(data?.scope)} />
      {pipeline.error ? <p className="form-error" role="alert">{pipeline.error}</p> : null}
      {!data && !pipeline.error ? <p role="status">Loading the placement pipeline…</p> : null}
      <Kpis items={[
        ['Students sharing applications', data ? suppressedCountLabel(data.studentsSharing) : 'NA', 'blue', 'applications'],
        ['Shared applications', data ? (data.stages.suppressed ? '<5' : suppressedCountLabel(data.stages.total)) : 'NA', 'indigo', 'applications'],
        ['Offers', data ? (data.offers.suppressed ? '<5' : suppressedCountLabel(data.offers.total)) : 'NA', 'green', 'offers'],
      ]} />
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Applications by stage</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/opportunities-and-offers`)}>Opportunities and Offers</button></div>
        <SuppressedFunnel table={data?.stages ?? null} labels={applicationStageLabels} />
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Offers by response</h2></div>
        <SuppressedFunnel table={data?.offers ?? null} labels={offerResponseLabels} />
      </section>
      {/* INST-09: every current student by placement status; "Nothing shared" is never "not applied". */}
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Students by placement status</h2></div>
        <SuppressedFunnel table={data?.placementStatus ?? null} labels={placementStatusLabels} />
      </section>
      {/* INST-12: the department's season statistics by batch. */}
      {statistics ?? null}
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card"><div className="pilot-card-head"><h2>What is counted</h2></div>
        <ul className="role-check-list">
          <li>Only applications a student has shared with the college, while they are enrolled. Withdrawing consent removes an application on the next load.</li>
          <li>Any group of fewer than five reads &lt;5; a total that would reveal one is withheld.</li>
          <li>Offer pay and terms are never shown to the college.</li>
          <li>Season statistics stand at the end of the last full month; a student who shared nothing is "Not shared", never unplaced.</li>
        </ul>
      </section>
    </aside>
  </div></div>;
}

// --- Opportunities and Offers ------------------------------------------------------

export function OpportunitiesAndOffersPage({ authenticatedWorkspace }: WorkspaceProps): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [rows, setRows] = useState<readonly PlacementApplicationDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token || !institutionId) return undefined;
    const controller = new AbortController();
    setRows(null); setError('');
    listPlacementApplications(token, institutionId, null, controller.signal)
      .then((page) => { if (!controller.signal.aborted) { setRows(page.applications); setNextCursor(page.nextCursor); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(loadError(cause, 'Unable to load shared applications.')); });
    return () => controller.abort();
  }, [token, institutionId]);
  const guard = workspaceGuard('Opportunities and Offers', authenticatedWorkspace);
  if (guard) return guard;
  async function more(): Promise<void> {
    if (!nextCursor) return;
    try {
      const page = await listPlacementApplications(token!, institutionId, nextCursor);
      setRows([...(rows ?? []), ...page.applications]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(loadError(cause, 'Unable to load more applications.'));
    }
  }
  const offers = (rows ?? []).filter((row) => row.offer.exists);
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Your department</span><h1>Opportunities and Offers</h1>
      <p>The opportunities your students have applied to and shared with the college, with whether an offer was made and how the student answered. Offer pay and terms are never shown to the college.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="📨" tone="blue" value={rows ? rows.length + (nextCursor ? '+' : '') : 'NA'} label="Shared applications loaded" />
      <V2Stat icon="🤝" tone="green" value={rows ? offers.length : 'NA'} label="With an offer" />
      <V2Stat icon="✅" tone="teal" value={rows ? offers.filter((row) => row.offer.responseState === 'ACCEPTED').length : 'NA'} label="Offers accepted" />
      <V2Stat icon="🏢" tone="purple" value={rows ? new Set(rows.map((row) => row.employer.name)).size : 'NA'} label="Employers" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!rows && !error ? <p role="status">Loading shared applications…</p> : null}
    {rows && rows.length === 0 ? <div className="role-wide"><V2EmptyState icon="📨" title="No shared applications"
      note="None of your department's students has shared an application with the college yet. Students choose, per application, whether the college may see it." /></div> : null}
    {rows && rows.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Shared applications</caption>
      <thead><tr><th scope="col">Student</th><th scope="col">Employer</th><th scope="col">Opportunity</th><th scope="col">Stage</th><th scope="col">Offer</th><th scope="col">Last update</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id} className="role-record-row">
        <th scope="row"><strong>{row.student.fullName}</strong><span>{row.student.institutionStudentId}</span></th>
        <td>{row.employer.name}</td><td>{row.opportunityTitle}</td><td>{applicationStageLabels[row.state] ?? 'NA'}</td>
        <td>{row.offer.exists ? offerResponseLabels[row.offer.responseState ?? ''] ?? 'NA' : 'No offer'}</td>
        <td>{row.updatedAt.slice(0, 10)}</td>
      </tr>)}</tbody></table></div> : null}
    {nextCursor ? <div className="role-record-actions"><button type="button" className="secondary" onClick={() => void more()}>Load more applications</button></div> : null}
  </section>;
}

// --- Reports and Analytics -----------------------------------------------------------

export function DepartmentReportsAnalyticsPage({ authenticatedWorkspace }: WorkspaceProps): React.ReactElement {
  const overview = useWorkspaceResource(authenticatedWorkspace, getDepartmentOverview, 'Unable to load department reports.');
  const pipeline = useWorkspaceResource(authenticatedWorkspace, (token, id, signal) => getPlacementPipeline(token, id, signal).catch(() => null), '');
  const guard = workspaceGuard('Reports and Analytics', authenticatedWorkspace);
  if (guard) return guard;
  const data = overview.data;
  const stages = pipeline.data?.stages ?? null;
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Your department</span><h1>Reports and Analytics</h1>
      <p>Department summaries, counted by the server for your scope. Readiness is shown only as bands; any group under five reads &lt;5.</p>
      {institutionStudentScopeLabel(data?.scope) ? <p>Showing students in {institutionStudentScopeLabel(data?.scope)}.</p> : null}</div></div>
    {overview.error ? <p className="form-error" role="alert">{overview.error}</p> : null}
    <section className="role-card role-wide"><h2>Department summary</h2>
      <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Department summary</caption>
        <thead><tr><th scope="col">Measure</th><th scope="col">Value</th></tr></thead>
        <tbody>
          {([
            ['Students on roster', data?.students.onRoster],
            ['Currently enrolled', data?.students.current],
            ['Activated their account', data?.activation.ACTIVATED],
            ['Invited, not yet activated', data ? data.activation.INVITED + data.activation.EXPIRED + data.activation.BOUNCED : undefined],
            ['Not invited', data?.activation.NOT_INVITED],
            ['Assessments in progress', data?.assessments.inProgress],
            ['Students with an assessment open', data?.assessments.assignedStudents],
            ['Of them, completed', data?.assessments.completedStudents],
            ['Open interventions', data?.staffActions.openInterventions],
            ['Open tasks', data?.staffActions.openTasks],
          ] as const).map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value ?? 'NA'}</td></tr>)}
        </tbody></table></div>
    </section>
    <section className="role-card role-wide"><h2>Shared applications by stage</h2>
      {!stages ? <p>NA</p> : stages.suppressed ? <p>Withheld: fewer than five shared applications in your scope.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Applications by stage</caption>
          <thead><tr><th scope="col">Stage</th><th scope="col">Applications</th></tr></thead>
          <tbody>{stages.cells.map((cell) => <tr key={cell.key}><th scope="row">{applicationStageLabels[cell.key] ?? cell.key}</th><td>{suppressedCountLabel(cell)}</td></tr>)}
            <tr><th scope="row">Total</th><td>{stages.total.suppressed ? 'withheld' : suppressedCountLabel(stages.total)}</td></tr></tbody></table></div>}
    </section>
    {authenticatedWorkspace?.organizationId ? <InstitutionExportsPanel institutionId={authenticatedWorkspace.organizationId} /> : null}
    <InstitutionReportsPage key={authenticatedWorkspace?.organizationId ?? ''} institutionId={authenticatedWorkspace?.organizationId ?? ''} />
  </section>;
}

// --- Faculty and Staff: department staff ----------------------------------------------

const staffRoleLabels: Readonly<Record<string, string>> = {
  INSTITUTION_OWNER: 'Institution owner', INSTITUTION_ADMIN: 'Institution admin', PLACEMENT_ADMIN: 'Placement officer',
  DEPARTMENT_HEAD: 'Department head', FACULTY_LECTURER: 'Faculty',
};

export function DepartmentStaffSection({ authenticatedWorkspace }: WorkspaceProps): React.ReactElement {
  const staff = useWorkspaceResource<DepartmentStaffDto>(authenticatedWorkspace, listDepartmentStaff, 'Unable to load your department staff.');
  const rows = staff.data?.staff ?? [];
  return <section className="role-card role-wide"><h2>Department staff</h2>
    <p>Staff whose account is scoped to your department, and everyone teaching one of its sections or batches.</p>
    {staff.error ? <p className="form-error" role="alert">{staff.error}</p> : null}
    {!staff.data && !staff.error ? <p role="status">Loading department staff…</p> : null}
    {staff.data && rows.length === 0 ? <p>No staff are scoped to your department yet.</p> : null}
    {rows.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Department staff</caption>
      <thead><tr><th scope="col">Staff member</th><th scope="col">Role</th><th scope="col">Scope</th><th scope="col">Teaching now</th></tr></thead>
      <tbody>{rows.map((member) => <tr key={member.email + member.role} className="role-record-row">
        <th scope="row">{member.email}</th><td>{staffRoleLabels[member.role] ?? 'NA'}</td>
        <td>{[member.department, member.batch].filter(Boolean).join(' · ') || 'Whole institution'}</td>
        <td>{member.assignments.length ? member.assignments.map((entry) => `${entry.subject ?? 'NA'} · ${entry.unitName} · ${entry.academicTerm}`).join('; ') : 'None'}</td>
      </tr>)}</tbody></table></div> : null}
  </section>;
}

// --- Faculty: Assessment Detail --------------------------------------------------------

interface ResultRow { readonly studentName: string; readonly institutionStudentId: string; readonly attemptNumber: number; readonly status: string; readonly score: number; readonly maxScore: number; readonly percentage: number; readonly timeTakenSeconds: number }

export function FacultyAssessmentDetailPage({ authenticatedWorkspace }: WorkspaceProps): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const exams = useWorkspaceResource<readonly InstitutionExamDto[]>(authenticatedWorkspace, (tokenValue, id, signal) => listInstitutionExams(tokenValue, id, signal).then((response) => response.assessments), 'Unable to load your assessments.');
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof listInstitutionExamResults>> | null>(null);
  const [error, setError] = useState('');
  const choices = (exams.data ?? []).filter((exam) => exam.lifecycleState !== 'DRAFT');
  const current = selected || choices[0]?.id || '';
  useEffect(() => {
    if (!token || !institutionId || !current) return undefined;
    const controller = new AbortController();
    setDetail(null); setError('');
    listInstitutionExamResults(token, institutionId, current, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setDetail(result); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(loadError(cause, 'Unable to load results for this assessment.')); });
    return () => controller.abort();
  }, [token, institutionId, current]);
  const guard = workspaceGuard('Assessment Detail', authenticatedWorkspace);
  if (guard) return guard;
  const exam = choices.find((entry) => entry.id === current);
  const results = (detail?.results ?? []) as unknown as readonly ResultRow[];
  const summary = detail?.summary;
  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Assessment Detail" summary="Results for one assessment, for the students you teach." />
      {exams.error ? <p className="form-error" role="alert">{exams.error}</p> : null}
      {exams.data && choices.length === 0 ? <V2EmptyState icon="📝" title="No published assessments yet" note="Publish an assessment under Assessments to see its results here." /> : null}
      {choices.length ? <section className="pilot-card role-management-form">
        <label><span>Assessment</span><select value={current} onChange={(event) => setSelected(event.target.value)}>
          {choices.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {entry.subjectName}</option>)}</select></label>
      </section> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {exam ? <Kpis items={[
        ['Assigned', summary ? String(summary.assigned) : 'NA', 'blue', 'students'],
        ['Results in', summary ? String(summary.attempts) : 'NA', 'green', 'assessments'],
        ['Not attempted', summary ? String(summary.notAttemptedCount) : 'NA', 'rose', 'warning'],
        ['Class average', summary ? (summary.attempts >= 5 ? `${summary.averagePercentage}%` : '<5 results') : 'NA', 'indigo', 'learning'],
      ]} /> : null}
      {detail && results.length === 0 ? <p>No results yet for this assessment among your students.</p> : null}
      {results.length ? <section className="pilot-card"><div className="pilot-card-head"><h2>Results</h2></div>
        <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Assessment results</caption>
          <thead><tr><th scope="col">Student</th><th scope="col">Attempt</th><th scope="col">Score</th><th scope="col">Percentage</th><th scope="col">Time taken</th></tr></thead>
          <tbody>{results.map((row) => <tr key={row.institutionStudentId + ':' + row.attemptNumber} className="role-record-row">
            <th scope="row"><strong>{row.studentName}</strong><span>{row.institutionStudentId}</span></th>
            <td>{row.attemptNumber}</td><td>{row.score} / {row.maxScore}</td><td>{row.percentage}%</td><td>{Math.round(row.timeTakenSeconds / 60)} min</td>
          </tr>)}</tbody></table></div></section> : null}
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card"><div className="pilot-card-head"><h2>Not attempted yet</h2></div>
        {detail ? (detail.notAttempted.length ? <div className="pilot-list">{detail.notAttempted.slice(0, 12).map((entry) => <div key={entry.institutionStudentId} className="pilot-list-row">
          <div className="grow"><strong>{entry.studentName}</strong><small>{entry.inProgress ? 'In progress now' : 'Not started'}</small></div></div>)}</div>
          : <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Everyone assigned has a result.</p>) : <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>NA</p>}
      </section>
      {exam ? <section className="pilot-card"><div className="pilot-card-head"><h2>Window</h2></div>
        <p style={{ margin: '4px 0' }}>{exam.startsAt.slice(0, 10)} – {exam.endsAt.slice(0, 10)}</p></section> : null}
    </aside>
  </div></div>;
}

// --- Faculty: Reports (class summaries) --------------------------------------------------

export function FacultyClassReportsPage({ authenticatedWorkspace }: WorkspaceProps): React.ReactElement {
  const reports = useWorkspaceResource<ClassReportsDto>(authenticatedWorkspace, listClassReports, 'Unable to load your class reports.');
  const guard = workspaceGuard('Reports', authenticatedWorkspace, ['FACULTY_LECTURER']);
  if (guard) return guard;
  const data = reports.data;
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Your teaching</span><h1>Reports</h1>
      <p>A summary for each section or batch you teach. A class average is shown once at least five students have a result.</p>
      {data?.mode === 'MEMBERSHIP' ? <p>Your college has not started recording teaching assignments, so these follow the department and batch on your staff account.</p> : null}</div></div>
    {reports.error ? <p className="form-error" role="alert">{reports.error}</p> : null}
    {!data && !reports.error ? <p role="status">Loading your class reports…</p> : null}
    {data && data.classes.length === 0 ? <div className="role-wide"><V2EmptyState icon="📚" title="No classes to report on"
      note={data.mode === 'ASSIGNMENTS' ? 'You have no active teaching assignment right now.' : 'Your staff account has no department or batch, so there is no class to summarise.'}
      hint="Ask your institution admin or department head to assign you to a section or batch." /></div> : null}
    {(data?.classes ?? []).map((entry) => <section key={entry.unit.id} className="role-card role-wide" aria-label={entry.unit.name}>
      <h2>{entry.unit.name}</h2>
      <p>{entry.subjects.length ? entry.subjects.join(', ') : 'Subject: NA'}</p>
      <div className="v2-row v2-cols-4 career-stat-strip">
        <V2Stat icon="🎓" tone="blue" value={entry.students} label="Students" />
        <V2Stat icon="✅" tone="green" value={entry.activated} label="Activated" />
        <V2Stat icon="📝" tone="amber" value={entry.openTasks} label="Open tasks" />
        <V2Stat icon="📊" tone="purple" value={entry.assessments.length} label="Assessments" />
      </div>
      {entry.assessments.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Assessments for {entry.unit.name}</caption>
        <thead><tr><th scope="col">Assessment</th><th scope="col">Window</th><th scope="col">Assigned</th><th scope="col">Completed</th><th scope="col">Class average</th></tr></thead>
        <tbody>{entry.assessments.map((row) => <tr key={row.id}><th scope="row">{row.title}</th><td>{row.startsAt.slice(0, 10)} – {row.endsAt.slice(0, 10)}</td>
          <td>{row.assigned}</td><td>{row.completed}</td><td>{row.averageSuppressed || row.averagePercentage === null ? '<5 results' : `${row.averagePercentage}%`}</td></tr>)}</tbody></table></div>
        : <p>No assessments assigned to this class yet.</p>}
    </section>)}
  </section>;
}
