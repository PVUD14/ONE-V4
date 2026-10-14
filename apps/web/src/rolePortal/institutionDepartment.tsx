/**
 * ONE · Role portal — Institution — Department head and faculty workspaces (INST-07)
 *
 * The department head's Department Overview, Readiness, Batches, Placement Pipeline,
 * Opportunities and Offers, and Reports and Analytics, the department staff list on
 * Faculty and Staff, and the lecturer's Assessment Detail and class Reports. Each is a
 * department-scoped version of an admin module: the server decides whose students are
 * counted (the INST-02 scope helper) and suppresses small groups, and nothing is filtered
 * or counted for security here. A figure with no source is hidden (or reads "Not recorded" in a
 * table cell); a group under five reads <5;
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
  suppressedCountLabel,
} from '../api.js';
import type {
  ClassReportsDto,
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
import { NaValue, PilotKpi } from '../naState.js';
import { MISSING_TEXT } from '../labels.js';
import { SmallCount, SuppressedBlock, SuppressedLegend, SMALL_COUNT_TEXT, isSmallCountText, partitionNeedsRanges } from '../momentum/smallCount.js';
import { BandClimb } from '../momentum/bandClimb.js';
import { Loading } from '../momentum/loader.js';
import {
  ActivationCard, BatchTable, CohortBandsCard, IhCard, IhKpis, IhNote, IhPage, IhRows, IhTiles, PeopleCount, RecordCount, VerificationBlock, validOverview,
} from './institutionMomentum.js';

type WorkspaceProps = { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined };


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

/** A KPI row; a null value has no source yet (still loading, or not sent) and its card is hidden. */
export function Kpis({ items }: { readonly items: readonly (readonly [string, string | null, string, IconName])[] }): React.ReactElement {
  return <div className={`pilot-row cols-${items.length}`}>
    {items.map(([label, value, tone, glyph]) => <PilotKpi key={label} icon={<Icon name={glyph} size={16} />} tone={tone} value={value} label={label} />)}
  </div>;
}

/** A funnel over a suppressed table: a cell under five reads <5 and takes the uniform hatched block, never a bar. */
export function SuppressedFunnel({ table, labels }: { readonly table: SuppressedTableDto | null; readonly labels: Readonly<Record<string, string>> }): React.ReactElement {
  const keys = Object.keys(labels);
  const cells = new Map((table?.cells ?? []).map((cell) => [cell.key, cell]));
  const max = Math.max(1, ...[...cells.values()].map((cell) => cell.count ?? 0));
  return <div className="pilot-funnel">
    {keys.map((key) => {
      const cell = cells.get(key);
      const value = !table ? null : table.suppressed ? SMALL_COUNT_TEXT : suppressedCountLabel(cell ?? null);
      return <div key={key} className="pilot-funnel-row">
        <span>{labels[key]}</span>
        {isSmallCountText(value)
          ? <div className="sc-slot" aria-hidden="true"><SuppressedBlock /></div>
          : <div className="pilot-bar"><i style={{ width: `${((cell && !cell.suppressed ? cell.count ?? 0 : 0) / max) * 100}%` }} /></div>}
        {value === null ? null : <span className="num"><NaValue value={value} /></span>}
      </div>;
    })}
    {keys.some((key) => table && (table.suppressed || isSmallCountText(suppressedCountLabel(cells.get(key) ?? null)))) ? <SuppressedLegend /> : null}
  </div>;
}

function ReadinessBands({ month, aggregate }: { readonly month: string | null; readonly aggregate: ReadinessAggregateDto | null }): React.ReactElement {
  if (!aggregate || !month) return <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>No month with band records has ended yet, so there is no distribution to show.</p>;
  return <BandClimb aggregate={aggregate} month={month} />;
}

// --- Department Overview ---------------------------------------------------------

/**
 * The department overview in the approved Momentum composition (re-skin phase 6): the scope's
 * headline figures, its band distribution, the shared-application pipeline, activation and
 * batches. Each block renders only when its read succeeded; counts of people go through
 * <SmallCount>, and parts sitting beside a visible total become ranges where a small group could
 * otherwise be worked out.
 */
export function DepartmentOverviewPage({ authenticatedWorkspace, basePath }: WorkspaceProps & { readonly basePath: string }): React.ReactElement {
  const overview = useWorkspaceResource(authenticatedWorkspace, getDepartmentOverview, 'Unable to load the department overview.');
  const pipeline = useWorkspaceResource(authenticatedWorkspace, (token, id, signal) => getPlacementPipeline(token, id, signal).catch(() => null), '');
  const verification = useWorkspaceResource(authenticatedWorkspace, (token, id, signal) => getVerificationSummary(token, id, signal).then((result) => result?.summary ?? null).catch(() => null), '');
  const guard = workspaceGuard('Department Overview', authenticatedWorkspace);
  if (guard) return guard;
  const data = validOverview(overview.data);
  const readiness = data?.readiness.aggregate && data.readiness.month ? data.readiness : null;
  const stages = pipeline.data && pipeline.data.stages && Array.isArray(pipeline.data.stages.cells) ? pipeline.data.stages : null;
  const currentRanged = data ? partitionNeedsRanges([data.students.current, data.students.onRoster - data.students.current]) : false;
  const assessedRanged = data ? partitionNeedsRanges([data.assessments.completedStudents, data.assessments.assignedStudents - data.assessments.completedStudents]) : false;
  return <IhPage eyebrow={institutionStudentScopeLabel(data?.scope) ?? null} title="Department Overview"
    summary="Your department's students, activation, assessments, readiness and open work, counted by the server for your scope.">
    {overview.error ? <p className="form-error" role="alert">{overview.error}</p> : null}
    {!data && !overview.error ? <Loading className="ih-empty">Loading the department overview…</Loading> : null}
    {data ? <IhKpis items={[
      { key: 'roster', icon: 'students', value: <PeopleCount value={data.students.onRoster} />, label: 'Students on roster', note: data.batches.length ? `${data.batches.length} ${data.batches.length === 1 ? 'batch' : 'batches'}` : null },
      { key: 'current', icon: 'students', value: <PeopleCount value={data.students.current} range={currentRanged} />, label: 'Enrolled now', note: 'Current relationship' },
      { key: 'assessments', icon: 'assessments', value: <RecordCount value={data.assessments.inProgress} />, label: 'Assessments in progress' },
      { key: 'interventions', icon: 'interventions', value: <RecordCount value={data.staffActions.openInterventions} />, label: 'Open interventions' },
      { key: 'tasks', icon: 'tasks', value: <RecordCount value={data.staffActions.openTasks} />, label: 'Open tasks' },
    ]} /> : null}
    {data ? <div className="ih-grid">
      {readiness ? <div className="ih-c8"><CohortBandsCard title="Cohort readiness" aggregate={readiness.aggregate!} month={readiness.month}
        link={{ label: 'Readiness', onClick: () => go(`${basePath}/readiness`) }} /></div> : null}
      <div className={`${readiness ? 'ih-c4' : 'ih-c12'} ih-col`}>
        {verification.data ? <IhCard title="Academic verification" link={{ label: 'Review queue', onClick: () => go(`${basePath}/students`) }}>
          <VerificationBlock pending={verification.data.pending} />
        </IhCard> : null}
        <IhCard title="Assessments">
          <IhRows rows={[
            ['Students with an assessment open', <SmallCount key="assigned" value={data.assessments.assignedStudents} />],
            ['Of them, completed', <SmallCount key="completed" value={data.assessments.completedStudents} range={assessedRanged} />],
          ]} />
        </IhCard>
      </div>
      {stages ? <div className="ih-c8"><IhCard title="Placement pipeline" aside="From shared applications" link={{ label: 'Open pipeline', onClick: () => go(`${basePath}/placement-pipeline`) }}>
        {stages.suppressed ? <p className="ih-empty">Fewer than five applications have been shared in your scope, so the stages are withheld.</p>
          : <IhTiles columns={5} tiles={([['APPLIED', 'Applied'], ['SHORTLISTED', 'Shortlisted'], ['INTERVIEW', 'Interview'], ['OFFER', 'Offer'], ['HIRED', 'Hired']] as const)
            .map(([key, label]) => ({ key, label, value: <SmallCount value={stages.cells.find((cell) => cell.key === key) ?? null} /> }))} />}
        <IhNote>Applications students have shared with the college. Fewer than five reads “&lt;5”.</IhNote>
      </IhCard></div> : null}
      <div className={stages ? 'ih-c4' : 'ih-c12'}><ActivationCard activation={data.activation} onOpen={() => go(`${basePath}/students`)} /></div>
      {data.batches.length ? <div className="ih-c12"><BatchTable overview={data} linkLabel="View Batches" onOpen={() => go(`${basePath}/batches`)} /></div>
        : <div className="ih-c12"><IhCard title="Cohort by batch"><p className="ih-empty">No batches are set up in your department yet.</p></IhCard></div>}
    </div> : null}
  </IhPage>;
}

export function VerificationCard({ summary, onOpen }: { readonly summary: VerificationSummaryDto | null; readonly onOpen: () => void }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>Academic Verification</h2><button type="button" className="pilot-link" onClick={onOpen}>Review Queue</button></div>
    <div className="pilot-legend">
      <div><i /> Waiting for a decision {summary ? <span className="num">{summary.pending}</span> : null}</div>
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
      <V2Stat icon="🗂️" tone="blue" value={overview.data ? batches.length : null} label="Batches" />
      <V2Stat icon="🎓" tone="purple" value={overview.data ? overview.data.students.onRoster : null} label="Students on roster" />
      <V2Stat icon="✅" tone="green" value={overview.data ? overview.data.students.current : null} label="Currently enrolled" />
      <V2Stat icon="✉️" tone="amber" value={overview.data ? overview.data.activation.ACTIVATED : null} label="Activated" />
    </div>
    {overview.error ? <p className="form-error" role="alert">{overview.error}</p> : null}
    {!overview.data && !overview.error ? <p role="status">Loading batches…</p> : null}
    {overview.data && batches.length === 0 ? <div className="role-wide"><V2EmptyState illustration="no-students-roster" icon="🗂️" title="No batches yet"
      note="Your department has no batch units. Your institution administrator adds them under Academic Structure." /></div> : null}
    {batches.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Department batches</caption>
      <thead><tr><th scope="col">Batch</th><th scope="col">Programme or department</th><th scope="col">On roster</th><th scope="col">Currently enrolled</th><th scope="col">Activated</th></tr></thead>
      <tbody>{batches.map((batch) => <tr key={batch.id} className="role-record-row"><th scope="row">{batch.name}</th><td>{batch.parentName ?? MISSING_TEXT}</td>
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
      <div className="pilot-card-head"><h2>Last month</h2>{overview.data?.readiness.month ? <small style={{ color: 'var(--p-muted)' }}>{overview.data.readiness.month}</small> : null}</div>
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
        ['Students sharing applications', data ? suppressedCountLabel(data.studentsSharing) : null, 'blue', 'applications'],
        ['Shared applications', data ? (data.stages.suppressed ? SMALL_COUNT_TEXT : suppressedCountLabel(data.stages.total)) : null, 'indigo', 'applications'],
        ['Offers', data ? (data.offers.suppressed ? SMALL_COUNT_TEXT : suppressedCountLabel(data.offers.total)) : null, 'green', 'offers'],
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
      <V2Stat icon="📨" tone="blue" value={rows ? rows.length + (nextCursor ? '+' : '') : null} label="Shared applications loaded" />
      <V2Stat icon="🤝" tone="green" value={rows ? offers.length : null} label="With an offer" />
      <V2Stat icon="✅" tone="teal" value={rows ? offers.filter((row) => row.offer.responseState === 'ACCEPTED').length : null} label="Offers accepted" />
      <V2Stat icon="🏢" tone="purple" value={rows ? new Set(rows.map((row) => row.employer.name)).size : null} label="Employers" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!rows && !error ? <p role="status">Loading shared applications…</p> : null}
    {rows && rows.length === 0 ? <div className="role-wide"><V2EmptyState illustration="no-applications" icon="📨" title="No shared applications"
      note="None of your department's students has shared an application with the college yet. Students choose, per application, whether the college may see it." /></div> : null}
    {rows && rows.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Shared applications</caption>
      <thead><tr><th scope="col">Student</th><th scope="col">Employer</th><th scope="col">Opportunity</th><th scope="col">Stage</th><th scope="col">Offer</th><th scope="col">Last update</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id} className="role-record-row">
        <th scope="row"><strong>{row.student.fullName}</strong><span>{row.student.institutionStudentId}</span></th>
        <td>{row.employer.name}</td><td>{row.opportunityTitle}</td><td>{applicationStageLabels[row.state] ?? MISSING_TEXT}</td>
        <td>{row.offer.exists ? offerResponseLabels[row.offer.responseState ?? ''] ?? 'Not answered yet' : 'No offer'}</td>
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
    {data ? <section className="role-card role-wide"><h2>Department summary</h2>
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
          ] as const).map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value ?? MISSING_TEXT}</td></tr>)}
        </tbody></table></div>
    </section> : null}
    {stages ? <section className="role-card role-wide"><h2>Shared applications by stage</h2>
      {stages.suppressed ? <p>Withheld: fewer than five shared applications in your scope.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Applications by stage</caption>
          <thead><tr><th scope="col">Stage</th><th scope="col">Applications</th></tr></thead>
          <tbody>{stages.cells.map((cell) => <tr key={cell.key}><th scope="row">{applicationStageLabels[cell.key] ?? cell.key}</th><td><NaValue value={suppressedCountLabel(cell)} /></td></tr>)}
            <tr><th scope="row">Total</th><td><NaValue value={stages.total.suppressed ? 'withheld' : suppressedCountLabel(stages.total)} /></td></tr></tbody></table></div>}
    </section> : null}
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
        <th scope="row">{member.email}</th><td>{staffRoleLabels[member.role] ?? MISSING_TEXT}</td>
        <td>{[member.department, member.batch].filter(Boolean).join(' · ') || 'Whole institution'}</td>
        <td>{member.assignments.length ? member.assignments.map((entry) => [entry.subject, entry.unitName, entry.academicTerm].filter(Boolean).join(' · ')).join('; ') : 'None'}</td>
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
      {exams.data && choices.length === 0 ? <V2EmptyState illustration="no-assessments" icon="📝" title="No published assessments yet" note="Publish an assessment under Assessments to see its results here." /> : null}
      {choices.length ? <section className="pilot-card role-management-form">
        <label><span>Assessment</span><select value={current} onChange={(event) => setSelected(event.target.value)}>
          {choices.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} · {entry.subjectName}</option>)}</select></label>
      </section> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {exam ? <Kpis items={[
        ['Assigned', summary ? String(summary.assigned) : null, 'blue', 'students'],
        ['Results in', summary ? String(summary.attempts) : null, 'green', 'assessments'],
        ['Not attempted', summary ? String(summary.notAttemptedCount) : null, 'rose', 'warning'],
        ['Class average', summary ? (summary.attempts >= 5 ? `${summary.averagePercentage}%` : '<5 results') : null, 'indigo', 'learning'],
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
      {detail ? <section className="pilot-card"><div className="pilot-card-head"><h2>Not attempted yet</h2></div>
        {detail.notAttempted.length ? <div className="pilot-list">{detail.notAttempted.slice(0, 12).map((entry) => <div key={entry.institutionStudentId} className="pilot-list-row">
          <div className="grow"><strong>{entry.studentName}</strong><small>{entry.inProgress ? 'In progress now' : 'Not started'}</small></div></div>)}</div>
          : <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Everyone assigned has a result.</p>}
      </section> : null}
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
    {data && data.classes.length === 0 ? <div className="role-wide"><V2EmptyState illustration="no-reports" icon="📚" title="No classes to report on"
      note={data.mode === 'ASSIGNMENTS' ? 'You have no active teaching assignment right now.' : 'Your staff account has no department or batch, so there is no class to summarise.'}
      hint="Ask your institution admin or department head to assign you to a section or batch." /></div> : null}
    {(data?.classes ?? []).map((entry) => <section key={entry.unit.id} className="role-card role-wide" aria-label={entry.unit.name}>
      <h2>{entry.unit.name}</h2>
      {entry.subjects.length ? <p>{entry.subjects.join(', ')}</p> : null}
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
