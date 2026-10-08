/**
 * ONE · Role portal — Institution — Student Detail
 *
 * One student, as the institution holds them: their roster record and academic units, the
 * state of their relationship and invitation, their consented placement status and the
 * applications they chose to share. It replaces the administrator's Student Detail item
 * rendering the whole roster a second time. With no student chosen it is a chooser over the
 * same roster; the roster's "Open detail" lands here with that student chosen.
 *
 * The chosen student travels in the history entry's state, not the address bar, so no
 * internal identifier is shown to the person using the page.
 */
import { useEffect, useState } from 'react';
import { getProtectedAccessToken, institutionStudentScopeLabel, listInstitutionStudents, listInstitutionUnits, studentActivationLabels } from '../api.js';
import type { InstitutionStudentDto, InstitutionUnitDto } from '../api.js';
import { V2EmptyState } from '../dashboardsV2.js';
import { StaffPilotWrap } from '../parityWraps.js';
import { StudentApplicationRecords } from './institution.js';
import { PlacementStatusChip, useRosterPlacementStatus } from './institutionPlacementStatus.js';
import { formatApiError, InstitutionWorkspaceError, isInstitutionStaffWorkspace, openPortalRecord, portalRecordFromHistory, RestrictedApiState } from './shared.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { codeLabel } from '../labels.js';

/** The history-state key the roster sets when it opens one student. */
export const studentDetailRecordKey = 'studentProfileId';

/** Opens Student Detail on one student, from any list in the same portal. */
export function openStudentDetail(basePath: string, studentProfileId: string): void {
  openPortalRecord(`${basePath}/student-detail`, { [studentDetailRecordKey]: studentProfileId });
}

const unitLabels: readonly (readonly [string, string])[] = [['departmentUnitId', 'Department'], ['programUnitId', 'Program'], ['batchUnitId', 'Batch'], ['sectionUnitId', 'Section']];

export function InstitutionStudentDetailPage({ authenticatedWorkspace }: { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [data, setData] = useState<{ readonly students: readonly InstitutionStudentDto[]; readonly units: readonly InstitutionUnitDto[]; readonly scopeLabel: string | null } | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => portalRecordFromHistory(studentDetailRecordKey));
  const placement = useRosterPlacementStatus(token ?? '', institutionId, 0);

  useEffect(() => {
    if (!token || !institutionId) return undefined;
    const controller = new AbortController();
    setData(null); setError('');
    Promise.all([listInstitutionStudents(token, institutionId, controller.signal), listInstitutionUnits(token, institutionId, controller.signal)])
      .then(([roster, structure]) => { if (!controller.signal.aborted) setData({ students: roster.students ?? [], units: structure.units ?? [], scopeLabel: institutionStudentScopeLabel(roster.scope) }); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load your students.')); });
    return () => controller.abort();
  }, [token, institutionId]);

  useEffect(() => {
    const onPop = (): void => setSelectedId(portalRecordFromHistory(studentDetailRecordKey));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!token) return <RestrictedApiState title="Student Detail" message="Sign in to your institution staff workspace." />;
  if (!isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Student Detail" />;

  const unitName = (id: string | null | undefined): string => (data?.units ?? []).find((unit) => unit.id === id)?.name ?? 'NA';
  const selected = data?.students.find((student) => student.id === selectedId) ?? null;
  const matches = (data?.students ?? []).filter((student) => `${student.fullName} ${student.institutionStudentId} ${student.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  const choose = (id: string | null): void => {
    setSelectedId(id);
    // Keep the choice on this history entry, so Back and a reload return to the same student.
    try { window.history.replaceState(id ? { [studentDetailRecordKey]: id } : null, ''); } catch { /* history unavailable: the choice still shows */ }
  };
  const shared = selected?.studentUserId ? placement.byStudent?.get(selected.studentUserId) : undefined;

  return <StaffPilotWrap title="Student Detail" subtitle="One student's record, relationship, placement status and the applications they chose to share.">
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {data?.scopeLabel ? <p>Showing students in {data.scopeLabel}.</p> : null}
    {selected ? <>
      <section className="role-card role-wide" aria-label={`Detail for ${selected.fullName}`}>
        <div className="role-section-title"><h2>{selected.fullName}</h2><button type="button" className="secondary" onClick={() => choose(null)}>Choose another student</button></div>
        <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{`Record of ${selected.fullName}`}</caption><tbody>
          <tr><th scope="row">Institution ID</th><td>{selected.institutionStudentId}</td></tr>
          <tr><th scope="row">Email</th><td>{selected.email || 'NA'}</td></tr>
          {unitLabels.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{unitName(selected.units?.[key])}</td></tr>)}
          <tr><th scope="row">Relationship</th><td>{codeLabel(selected.relationship?.state ?? selected.status)}</td></tr>
          <tr><th scope="row">Relationship since</th><td>{selected.relationship?.effectiveFrom?.slice(0, 10) ?? 'NA'}</td></tr>
          <tr><th scope="row">Invitation</th><td>{selected.activation ? studentActivationLabels[selected.activation.state] : 'NA'}</td></tr>
          <tr><th scope="row">Placement status</th><td>{shared ? <PlacementStatusChip status={shared.status} /> : placement.byStudent === null && !placement.failed ? '…' : 'NA'}</td></tr>
        </tbody></table></div>
      </section>
      {selected.studentUserId
        ? [false, true].map((external) => <StudentApplicationRecords key={`${selected.studentUserId}:${external}`} token={token} institutionId={institutionId} studentUserId={selected.studentUserId!} external={external} />)
        : <section className="role-card role-wide"><h2>Shared applications</h2><p>NA — this student has not activated their ONE account, so nothing has been shared.</p></section>}
    </> : <>
      <div className="role-wide"><V2EmptyState icon="🎓" title="Choose a student to see their detail"
        note="Pick a student from your roster below, or use Open detail on the Students list." /></div>
      <section className="role-card role-wide">
        <label className="role-local-search"><span>Find a student</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, institution ID or email" /></label>
        {!data ? <p role="status">{error ? 'Roster unavailable.' : 'Loading roster…'}</p>
          : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Choose a student</caption>
            <thead><tr><th>Student</th><th>Institution ID</th><th>Department</th><th>Relationship</th><th>Detail</th></tr></thead>
            <tbody>{matches.length ? matches.map((student) => <tr key={student.id}>
              <th scope="row">{student.fullName}</th><td>{student.institutionStudentId}</td><td>{unitName(student.units?.departmentUnitId)}</td>
              <td>{codeLabel(student.relationship?.state ?? student.status)}</td>
              <td><button type="button" className="secondary" aria-label={`Open detail for ${student.fullName}`} onClick={() => choose(student.id)}>Open detail</button></td>
            </tr>) : <tr><td colSpan={5}>No students match your search.</td></tr>}</tbody></table></div>}
      </section>
    </>}
  </StaffPilotWrap>;
}
