/**
 * ONE · Role portal — Institution — Consented placement visibility (INST-09)
 *
 * The placement office's first question — where is each student in their placement
 * journey? — answered only from applications the student chose to share with the college
 * (ADR-019). This file holds the admin's Placement page and the per-student placement
 * status list it shares with Student Detail and the placement officer's roster.
 *
 * The server decides everything that matters here: whose students are listed (the INST-02
 * scope helper), which applications count (shared, not revoked, inside the relationship),
 * what an offer is (never an unsent draft) and what a small group shows (<5). Nothing is
 * filtered or counted for security in the browser. A student who shared nothing reads
 * "Nothing shared" — never "not applied", because the college cannot tell the two apart.
 * Pay never appears (ADR-024); readiness is not shown here at all. INST-12 adds the season
 * statistics and the placement register to the admin's Placement page.
 */
import { Icon } from '../icons/Icon.js';
import { useEffect, useState } from 'react';
import { getPlacementPipeline, getProtectedAccessToken, institutionStudentScopeLabel, listPlacementStatus, suppressedCountLabel } from '../api.js';
import type { PlacementPipelineDto, PlacementStatus, PlacementStatusRowDto } from '../api.js';
import { PlacementStatusChip, placementStatusLabels } from './institutionPlacementStatus.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { Kpis, PageHead, SuppressedFunnel, applicationStageLabels, loadError, offerResponseLabels, useWorkspaceResource, workspaceGuard } from './institutionDepartment.js';
import { StudentApplicationRecords } from './institution.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { CampusDriveApprovalsSection } from './institutionCampusDrives.js';
import { PlacementRegisterSection, PlacementStatisticsSection } from './institutionPlacementRegister.js';

/** The admin's Placement item: the status distribution, the stage funnel and every student's status. */
export function InstitutionPlacementPage({ authenticatedWorkspace }: { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const pipeline = useWorkspaceResource<PlacementPipelineDto>(authenticatedWorkspace, getPlacementPipeline, 'Unable to load placement status.');
  const guard = workspaceGuard('Placement', authenticatedWorkspace);
  if (guard) return guard;
  const data = pipeline.data;
  const statusCell = (key: PlacementStatus) => data?.placementStatus?.cells?.find((cell) => cell.key === key) ?? null;
  const token = getProtectedAccessToken()!;
  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <PageHead title="Placement" summary="Where your students are in their placement journey, from the applications they have chosen to share with the college." scopeLabel={institutionStudentScopeLabel(data?.scope)} />
      {pipeline.error ? <p className="form-error" role="alert">{pipeline.error}</p> : null}
      {!data && !pipeline.error ? <p role="status">Loading placement status…</p> : null}
      <Kpis items={[
        ['Students sharing applications', data ? suppressedCountLabel(data.studentsSharing) : 'NA', 'blue', 'applications'],
        ['In process', data?.placementStatus ? (data.placementStatus.suppressed ? '<5' : suppressedCountLabel(statusCell('IN_PROCESS'))) : 'NA', 'indigo', 'opportunities'],
        ['With an offer', data?.placementStatus ? (data.placementStatus.suppressed ? '<5' : suppressedCountLabel(statusCell('OFFER'))) : 'NA', 'amber', 'offers'],
        ['Accepted an offer', data?.placementStatus ? (data.placementStatus.suppressed ? '<5' : suppressedCountLabel(statusCell('ACCEPTED'))) : 'NA', 'green', 'offers'],
      ]} />
      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Students by placement status</h2></div>
          <SuppressedFunnel table={data?.placementStatus ?? null} labels={placementStatusLabels} />
          <small style={{ color: 'var(--p-muted)' }}>"Nothing shared" means the student has not shared an application with the college — not that they have not applied.</small>
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Shared applications by stage</h2></div>
          <SuppressedFunnel table={data?.stages ?? null} labels={applicationStageLabels} />
        </section>
      </div>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Offers by response</h2></div>
        <SuppressedFunnel table={data?.offers ?? null} labels={offerResponseLabels} />
      </section>
      {/* INST-12: season statistics by department and batch, and the register (employers, drive calendar). */}
      <PlacementStatisticsSection institutionId={authenticatedWorkspace!.organizationId!} />
      <PlacementRegisterSection institutionId={authenticatedWorkspace!.organizationId!} />
      <PlacementStatusList key={(authenticatedWorkspace?.organizationId ?? '') + ':' + token} token={token} institutionId={authenticatedWorkspace!.organizationId!} />
      {/* EMP-11: campus drive approvals sit on the admin's existing Placement item. */}
      <CampusDriveApprovalsSection institutionId={authenticatedWorkspace!.organizationId!} />
    </div>
    <aside className="pilot-rail">
      <section className="pilot-card"><div className="pilot-card-head"><h2>What is counted</h2></div>
        <ul className="role-check-list">
          <li>Only applications a student has shared with the college, while they are enrolled. Stopping sharing removes an application on the next load.</li>
          <li>An employer's unsent draft offer is not an offer.</li>
          <li>Student-declared applications elsewhere are unverified: they are listed per student and never change a status.</li>
          <li>Any group of fewer than five reads &lt;5; a total that would reveal one is withheld.</li>
          <li>Offer pay and terms are never shown to the college.</li>
        </ul>
      </section>
      <section className="pilot-card"><div className="pilot-card-head"><h2>Where things are</h2></div>
        <p style={{ color: 'var(--p-muted)', margin: '4px 0' }}>Statistics, the register and each student's status are on this page, and campus drives are decided here. Placement policies and drive categories are under Settings.</p>
      </section>
    </aside>
  </div></div>;
}

/**
 * Every student in the reader's scope with their placement status, one audited page at a
 * time, and the student's shared applications on request.
 */
export function PlacementStatusList({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [rows, setRows] = useState<readonly PlacementStatusRowDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<PlacementStatusRowDto | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setRows(null); setError('');
    listPlacementStatus(token, institutionId, {}, controller.signal)
      .then((page) => { if (!controller.signal.aborted) { setRows(page.students ?? []); setNextCursor(page.nextCursor ?? null); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(loadError(cause, 'Unable to load placement status.')); });
    return () => controller.abort();
  }, [token, institutionId]);
  async function more(): Promise<void> {
    if (!nextCursor) return;
    try {
      const page = await listPlacementStatus(token, institutionId, { cursor: nextCursor });
      setRows([...(rows ?? []), ...page.students]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(loadError(cause, 'Unable to load more students.'));
    }
  }
  return <section className="pilot-card" aria-label="Placement status by student">
    <div className="pilot-card-head"><h2>Placement status by student</h2></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!rows && !error ? <p role="status">Loading students…</p> : null}
    {rows && rows.length === 0 ? <V2EmptyState icon="🎓" title="No students in your scope" note="Students appear here once they are on the roster with a current relationship." /> : null}
    {rows && rows.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Placement status by student</caption>
      <thead><tr><th scope="col">Student</th><th scope="col">Department</th><th scope="col">Batch</th><th scope="col">Placement status</th><th scope="col">Shared</th><th scope="col">Last shared update</th><th scope="col">Applications</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.studentUserId} className="role-record-row">
        <th scope="row"><strong>{row.fullName}</strong><span>{row.institutionStudentId}</span></th>
        <td>{row.department ?? 'NA'}</td><td>{row.batch ?? 'NA'}</td>
        <td><PlacementStatusChip status={row.status} /></td>
        <td>{row.sharedApplications} on ONE{row.sharedExternalDeclarations ? ` · ${row.sharedExternalDeclarations} declared elsewhere` : ''}</td>
        <td>{row.lastSharedActivityAt?.slice(0, 10) ?? 'NA'}</td>
        <td>{row.sharedApplications || row.sharedExternalDeclarations
          ? <button type="button" className="secondary" aria-label={'View shared applications for ' + row.fullName} onClick={() => setSelected(row)}>View shared applications</button>
          : 'Not shared'}</td>
      </tr>)}</tbody></table></div> : null}
    {nextCursor ? <div className="role-record-actions"><button type="button" className="secondary" onClick={() => void more()}>Load more students</button></div> : null}
    {selected ? <section className="role-card role-wide" aria-label={'Shared applications for ' + selected.fullName}>
      <h2>Shared applications for {selected.fullName}</h2>
      <p>Only what {selected.fullName} currently shares with the college. Anything not shared is not shown and not counted.</p>
      <button type="button" className="secondary" onClick={() => setSelected(null)}>Close applications</button>
      {[false, true].map((external) => <StudentApplicationRecords key={selected.studentUserId + ':' + external}
        token={token} institutionId={institutionId} studentUserId={selected.studentUserId} external={external} />)}
    </section> : null}
  </section>;
}
