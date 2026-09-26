/**
 * ONE · Role portal — Institution — Analytics access and CSV exports (INST-08)
 *
 * Two panels. On the admin Staff page, "Analytics and exports access" grants and revokes
 * INSTITUTION_ANALYTICS for admins and department heads, each with a reason code (ADR-018).
 * On the admin Reports page and the department head's Reports and Analytics page, "Exports"
 * downloads the four CSV exports. The server decides who may export and over which students;
 * nothing is filtered here. The exports panel makes no request until the person acts, so a
 * person without access learns it from their first export, with who can grant it.
 * Design: docs/architecture/institution-exports-design.md.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiRequestError,
  downloadInstitutionExport,
  getProtectedAccessToken,
  grantInstitutionAnalyticsAccess,
  listInstitutionAnalyticsAccess,
  listInstitutionExams,
  listInstitutionUnits,
  revokeInstitutionAnalyticsAccess,
} from '../api.js';
import type { InstitutionAnalyticsAccessDto, InstitutionExportPath, InstitutionUnitDto } from '../api.js';
import { formatApiError } from './shared.js';

/** Why access is granted; recorded with the grant. */
export const analyticsGrantReasons = [
  ['ANALYTICS_RESPONSIBILITY', 'Responsible for college reporting'],
  ['DEPARTMENT_REPORTING', 'Reports for their department'],
  ['ACCREDITATION_LEAD', 'Leads accreditation preparation'],
] as const;

/** Why access is removed; recorded with the revocation. */
export const analyticsRevokeReasons = [
  ['RESPONSIBILITY_ENDED', 'No longer responsible for reporting'],
  ['ACCESS_REVIEW', 'Periodic access review'],
  ['LEFT_INSTITUTION', 'Left the college'],
] as const;

/** Why data is being exported; recorded with every export. */
export const exportReasons = [
  ['MANAGEMENT_REPORTING', 'Report to college management'],
  ['ACCREDITATION_PREPARATION', 'Accreditation preparation'],
  ['DEPARTMENT_REVIEW', 'Department review'],
  ['PLACEMENT_PLANNING', 'Placement planning'],
] as const;

const exportKinds: readonly { readonly path: InstitutionExportPath; readonly label: string; readonly detail: string }[] = [
  { path: 'roster', label: 'Student roster with activation', detail: 'One row per student with a current relationship: roll number, name, email, units, relationship and activation state.' },
  { path: 'readiness-bands', label: 'Readiness band distribution', detail: 'Students per readiness band for one month that has ended. Bands only; a band with fewer than 5 students shows <5.' },
  { path: 'assessment-results', label: 'Assessment results', detail: 'The marks for one assessment, one row per attempt, plus assigned students who have not taken it.' },
  { path: 'staff-action-summary', label: 'Staff-action summary', detail: 'Interventions, tasks, notes, verifications and meetings opened in one month that has ended, as counts. No notes or titles leave in the file.' },
];

const roleLabels: Readonly<Record<string, string>> = { INSTITUTION_ADMIN: 'Institution admin', DEPARTMENT_HEAD: 'Department head' };

function latestEndedMonth(today: string): string {
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

function exportError(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'The export could not be prepared. Try again.';
  const reference = ` Reference: ${error.correlationId}`;
  switch (error.code) {
    case 'ANALYTICS_CAPABILITY_REQUIRED': return 'You do not have analytics and exports access. An owner or admin of your college can grant it on the Staff page.' + reference;
    case 'SCOPE_REQUIRED': return 'Exports need a department on your staff membership. An admin of your college can set it on the Staff page.' + reference;
    case 'UNIT_OUT_OF_SCOPE': return 'That unit is outside the students you can export.' + reference;
    case 'REPORT_PERIOD_INVALID': return 'Choose a month that has ended. Summaries cover one whole month, so no student can be singled out by comparing files.' + reference;
    case 'EXPORT_TOO_LARGE': return 'This export has more than 10,000 rows. Limit it to one department, programme, batch or section.' + reference;
    case 'EXPORT_RATE_LIMITED': return 'You have reached the limit of 30 exports in 24 hours. Try again later.' + reference;
    case 'ASSESSMENT_NOT_FOUND': return 'That assessment was not found.' + reference;
    default: break;
  }
  if (error.status === 401) return 'Your session has expired. Sign in again to export.';
  if (error.status === 403) return 'You do not have permission to export for this institution.' + reference;
  return 'The export could not be prepared. Try again.' + reference;
}

function saveFile(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Staff page: who may export, with grant and revoke. Owners and admins only (the page's own gate). */
export function AnalyticsAccessPanel({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [eligible, setEligible] = useState<readonly InstitutionAnalyticsAccessDto[] | null>(null);
  const [grantReason, setGrantReason] = useState<string>(analyticsGrantReasons[0][0]);
  const [revokeReason, setRevokeReason] = useState<string>(analyticsRevokeReasons[0][0]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    listInstitutionAnalyticsAccess(token, institutionId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setEligible(Array.isArray(result?.eligible) ? result.eligible : []); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load analytics access.')); });
    return () => controller.abort();
  }, [token, institutionId]);

  async function change(member: InstitutionAnalyticsAccessDto): Promise<void> {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = member.grant
        ? await revokeInstitutionAnalyticsAccess(token, institutionId, member.grant.capabilityId, revokeReason)
        : await grantInstitutionAnalyticsAccess(token, institutionId, member.membershipId, grantReason);
      if (Array.isArray(result?.eligible)) setEligible(result.eligible);
      setNotice(member.grant ? `Access removed for ${member.email}. It stops on their next request.` : `Access granted to ${member.email}.`);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.code === 'CAPABILITY_SELF_GRANT_REFUSED') {
        setError(`You cannot grant access to yourself. Another owner or admin must. Reference: ${cause.correlationId}`);
      } else {
        setError(formatApiError(cause, member.grant ? 'Removing access failed.' : 'Granting access failed.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return <section className="role-card role-wide role-management-form" aria-labelledby="analytics-access-title">
    <h2 id="analytics-access-title">Analytics and exports access</h2>
    <p>Exports leave ONE as files. Only institution admins and department heads can be given access, and a department head exports only their own department. Owners and admins grant it; nobody can grant it to themselves.</p>
    <label><span>Reason for granting</span><select value={grantReason} disabled={busy} onChange={(event) => setGrantReason(event.target.value)}>{analyticsGrantReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
    <label><span>Reason for removing</span><select value={revokeReason} disabled={busy} onChange={(event) => setRevokeReason(event.target.value)}>{analyticsRevokeReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {eligible === null && !error ? <p role="status">Loading analytics access…</p> : null}
    {eligible && eligible.length === 0 ? <p>No institution admins or department heads have joined yet, so there is nobody to give access to.</p> : null}
    {eligible && eligible.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table">
      <caption>Who can export</caption>
      <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Department</th><th scope="col">Access</th><th scope="col">Action</th></tr></thead>
      <tbody>{eligible.map((member) => <tr key={member.membershipId}>
        <td>{member.email}</td>
        <td>{roleLabels[member.role] ?? member.role}</td>
        <td>{member.department ?? (member.role === 'DEPARTMENT_HEAD' ? 'None set — cannot export until one is' : 'Whole institution')}</td>
        <td>{member.grant ? `Granted ${member.grant.grantedAt.slice(0, 10)}` : 'No access'}</td>
        <td><button type="button" className={member.grant ? 'secondary' : undefined} disabled={busy} onClick={() => void change(member)}>
          {member.grant ? `Remove access for ${member.email}` : `Grant access to ${member.email}`}
        </button></td>
      </tr>)}</tbody>
    </table></div> : null}
  </section>;
}

/** Reports pages: the four CSV exports. Requests nothing until the person acts. */
export function InstitutionExportsPanel({ institutionId }: { readonly institutionId: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const latestMonth = latestEndedMonth(new Date().toISOString().slice(0, 10));
  const [path, setPath] = useState<InstitutionExportPath>('roster');
  const [reasonCode, setReasonCode] = useState<string>(exportReasons[0][0]);
  const [month, setMonth] = useState(latestMonth);
  const [assessments, setAssessments] = useState<readonly { readonly id: string; readonly title: string }[] | null>(null);
  const [assessmentId, setAssessmentId] = useState('');
  const [units, setUnits] = useState<readonly InstitutionUnitDto[] | null>(null);
  const [unitId, setUnitId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const kind = exportKinds.find((entry) => entry.path === path) ?? exportKinds[0]!;
  const monthly = path === 'readiness-bands' || path === 'staff-action-summary';
  const perStudent = path === 'roster' || path === 'assessment-results';

  useEffect(() => {
    if (path !== 'assessment-results' || assessments !== null || !token) return;
    const controller = new AbortController();
    listInstitutionExams(token, institutionId, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setAssessments((result?.assessments ?? []).map((entry) => ({ id: entry.id, title: entry.title }))); })
      .catch(() => { if (!controller.signal.aborted) setAssessments([]); });
    return () => controller.abort();
  }, [path, assessments, token, institutionId]);

  function loadUnits(): void {
    if (units !== null || !token) return;
    listInstitutionUnits(token, institutionId).then((result) => setUnits(result?.units ?? [])).catch(() => setUnits([]));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || busy) return;
    setError(''); setNotice('');
    if (monthly && month > latestMonth) {
      setError('Choose a month that has ended. Summaries cover one whole month, so no student can be singled out by comparing files.');
      return;
    }
    if (path === 'assessment-results' && !assessmentId) {
      setError('Choose an assessment to export.');
      return;
    }
    setBusy(true);
    try {
      const file = await downloadInstitutionExport(token, institutionId, path, {
        reasonCode,
        ...(monthly ? { month } : {}),
        ...(path === 'assessment-results' ? { assessmentId } : {}),
        ...(perStudent && unitId ? { unitId } : {}),
      });
      saveFile(file.filename, file.csv);
      setNotice(`${kind.label} exported as ${file.filename}. The export is recorded with your reason.`);
    } catch (cause) {
      setError(exportError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="role-card role-wide" aria-labelledby="institution-exports-title">
    <h2 id="institution-exports-title">Exports</h2>
    <p>Download CSV files for your college's own records. Each export covers only the students you are responsible for, is recorded with your reason, and never includes readiness scores, salary or internal references. You need analytics and exports access, which an owner or admin grants on the Staff page.</p>
    {!token ? <p className="form-error" role="alert">Sign in to an institution workspace to export.</p> : <form className="role-management-form" onSubmit={(event) => void submit(event)}>
      <label><span>What to export</span><select value={path} disabled={busy} onChange={(event) => { setPath(event.target.value as InstitutionExportPath); setError(''); setNotice(''); }}>
        {exportKinds.map((entry) => <option key={entry.path} value={entry.path}>{entry.label}</option>)}
      </select></label>
      <p>{kind.detail}</p>
      {monthly ? <label><span>Month</span><input type="month" required value={month} max={latestMonth} disabled={busy} onChange={(event) => setMonth(event.target.value)} /></label> : null}
      {path === 'assessment-results' ? <label><span>Assessment</span><select value={assessmentId} disabled={busy || assessments === null} onChange={(event) => setAssessmentId(event.target.value)}>
        <option value="">{assessments === null ? 'Loading assessments…' : assessments.length ? 'Choose an assessment' : 'No assessments yet'}</option>
        {(assessments ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
      </select></label> : null}
      {perStudent ? <details onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open) loadUnits(); }}>
        <summary>Limit to one department, programme, batch or section</summary>
        <label><span>Unit</span><select value={unitId} disabled={busy || units === null} onChange={(event) => setUnitId(event.target.value)}>
          <option value="">{units === null ? 'Loading units…' : 'All the students I can export'}</option>
          {(units ?? []).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
        </select></label>
      </details> : null}
      <label><span>Reason for this export</span><select value={reasonCode} disabled={busy} onChange={(event) => setReasonCode(event.target.value)}>
        {exportReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select></label>
      <button type="submit" disabled={busy}>{busy ? 'Preparing export…' : 'Export CSV'}</button>
    </form>}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}
