/**
 * ONE · Role portal — Stream C — Institution
 *
 * Authenticated institution pages: roster, academic structure and staff.
 *
 * Split out of rolePortalPages.tsx so each stream owns its own surface. The
 * shell and the route dispatcher remain there and import from here.
 */
import { ApiRequestError, apiBaseUrl, addInstitutionStudent, commitStudentRosterImport, createInstitutionUnit, endInstitutionStudentRelationship, getProtectedAccessToken, inviteInstitutionStaff, listInstitutionStaff, setInstitutionStaffScope, listInstitutionStudents, listInstitutionUnits, institutionStudentScopeLabel, previewStudentRosterImport, resendStudentInvitations, studentActivationLabels, studentInvitationDeliveryNote, updateInstitutionStudent, updateInstitutionUnit } from '../api.js';
import type { InstitutionStaffDto, InstitutionStudentCreateRequest, InstitutionStudentDto, InstitutionUnitDto, RosterImportPreviewDto, StaffUnitScopeDto } from '../api.js';
import { V2Stat } from '../dashboardsV2.js';
import type { RolePortalConfig } from '../rolePortalConfig.js';
import { InstitutionWorkspaceError, RestrictedApiState, formatApiError, institutionWorkspaceRoles, isInstitutionStaffWorkspace, isInstitutionWorkspace } from './shared.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { Search } from 'lucide-react';
import { NaListCard } from '../pilotParity/naWidgets.js';
import { TeachingAssignmentsPanel } from './institutionTeaching.js';
import { useEffect, useRef, useState } from 'react';

/** Why an invitation is being sent again; recorded with the resend (INST-01). */
const invitationResendReasons = [
  ['NOT_RECEIVED', 'Student did not receive it'],
  ['LINK_EXPIRED', 'Link expired'],
  ['EMAIL_CORRECTED', 'Email address corrected'],
  ['STUDENT_REQUESTED', 'Student asked for a new link'],
] as const;

function InstitutionAdminStudentsPage({ portal, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [students, setStudents] = useState<readonly InstitutionStudentDto[]>([]);
  const [units, setUnits] = useState<readonly InstitutionUnitDto[]>([]);
  const [preview, setPreview] = useState<RosterImportPreviewDto | null>(null);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [studentError, setStudentError] = useState('');
  const [csvError, setCsvError] = useState('');
  const [relationshipError, setRelationshipError] = useState('');
  const [query, setQuery] = useState('');
  const [scopeLabel, setScopeLabel] = useState<string | null>(null);
  const [resendReason, setResendReason] = useState<string>(invitationResendReasons[0][0]);
  const [form, setForm] = useState({ fullName: '', institutionStudentId: '', email: '', departmentUnitId: '', programUnitId: '', batchUnitId: '', sectionUnitId: '', academicStartDate: '', expectedGraduationDate: '' });
  const [csv, setCsv] = useState('institution_student_id,full_name,email,department,program,batch,section\n');
  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    Promise.all([
      listInstitutionStudents(token, institutionId, controller.signal),
      listInstitutionUnits(token, institutionId, controller.signal),
    ]).then(([studentResult, unitResult]) => {
      setStudents(studentResult.students);
      setScopeLabel(institutionStudentScopeLabel(studentResult.scope));
      setUnits(unitResult.units);
    }).catch((error: unknown) => setLoadError(formatApiError(error, 'Unable to load institution students.')));
    return () => controller.abort();
  }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Students" message="Sign in with an Institution Admin identity to manage students." />;
  if (authenticatedWorkspace && !institutionWorkspaceRoles.has(authenticatedWorkspace.role)) return <InstitutionWorkspaceError title="Students" unauthorized />;
  if (!isInstitutionWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Students" />;
  const filteredStudents = students.filter((student) => `${student.fullName} ${student.email} ${student.institutionStudentId}`.toLowerCase().includes(query.toLowerCase()));
  const unitsByKind = (kind: string): readonly InstitutionUnitDto[] => units.filter((unit) => unit.kind === kind);
  async function addStudent(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setStudentError('');
    setNotice('');
    try {
      await addInstitutionStudent(token!, institutionId, cleanStudentPayload(form));
      setForm({ fullName: '', institutionStudentId: '', email: '', departmentUnitId: '', programUnitId: '', batchUnitId: '', sectionUnitId: '', academicStartDate: '', expectedGraduationDate: '' });
      setNotice('Student added with institution relationship; global identity was not hard-deleted or bypassed.');
    } catch (error) {
      setStudentError(formatApiError(error, 'Add student failed.'));
    }
  }
  async function resend(target: { readonly studentUserIds: readonly string[] } | { readonly all: true }): Promise<void> {
    setStudentError('');
    setNotice('');
    try {
      const result = await resendStudentInvitations(token!, institutionId, { reasonCode: resendReason, ...target });
      setNotice(`${result.resend.queued} invitation${result.resend.queued === 1 ? '' : 's'} queued to send.${result.resend.skipped ? ` ${result.resend.skipped} skipped (already activated or no longer enrolled).` : ''}`);
    } catch (error) {
      setStudentError(formatApiError(error, 'Resending invitations failed.'));
    }
  }
  async function editStudent(student: InstitutionStudentDto): Promise<void> {
    const fullName = window.prompt('Student full name', student.fullName);
    if (!fullName || fullName.trim() === student.fullName) return;
    setStudentError('');
    setNotice('');
    try {
      await updateInstitutionStudent(token!, institutionId, student.id, { fullName: fullName.trim() });
      setNotice('Student institution data updated.');
    } catch (error) {
      setStudentError(formatApiError(error, 'Student update failed.'));
    }
  }
  async function relationship(studentId: string, state: string): Promise<void> {
    const effectiveTo = window.prompt(`Confirm ${state}. Effective date/time (ISO or YYYY-MM-DD)`, new Date().toISOString());
    if (!effectiveTo) return;
    if (!window.confirm(`This will mark the current relationship ${state} effective ${effectiveTo}. Historical identity is retained. Continue?`)) return;
    setRelationshipError('');
    setNotice('');
    try {
      await endInstitutionStudentRelationship(token!, institutionId, studentId, state, effectiveTo);
      setNotice(`Student relationship marked ${state}.`);
    } catch (error) {
      setRelationshipError(formatApiError(error, 'Relationship update failed.'));
    }
  }
  async function previewImport(): Promise<void> {
    setCsvError('');
    setNotice('');
    try {
      const result = await previewStudentRosterImport(token!, institutionId, 'uat-roster.csv', csv);
      setPreview(result.import);
    } catch (error) {
      setCsvError(formatApiError(error, 'CSV preview failed validation.'));
    }
  }
  async function commitImport(): Promise<void> {
    if (!preview) return;
    setCsvError('');
    setStudentError('');
    setRelationshipError('');
    await commitStudentRosterImport(token!, institutionId, preview.id);
    setNotice('Roster import committed.');
    setPreview(null);
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Students</h1><p>Institution-owned roster and relationship lifecycle. This is not an Operations workflow.</p>{scopeLabel && <p>Showing students in {scopeLabel}.</p>}</div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🎓" tone="blue" value={students.length} label="Students on roster" />
      <V2Stat icon="✅" tone="green" value={students.filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE').length} label="Active" />
      <V2Stat icon="🏛️" tone="purple" value={units.length} label="Academic units" />
      <V2Stat icon="🔎" tone="amber" value={filteredStudents.length} label="Matching search" />
    </div>
    {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}{relationshipError ? <p className="form-error" role="alert">{relationshipError}</p> : null}{notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void addStudent(event)}><h2>Add Student</h2>{studentError ? <p className="form-error" role="alert">{studentError}</p> : null}<label><span>Full name *</span><input value={form.fullName} onChange={(event) => setForm((value) => ({ ...value, fullName: event.target.value }))} required /></label><label><span>Institution ID *</span><input value={form.institutionStudentId} onChange={(event) => setForm((value) => ({ ...value, institutionStudentId: event.target.value }))} required /></label><label><span>Email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label><UnitSelect label="Department" value={form.departmentUnitId} units={unitsByKind('DEPARTMENT')} onChange={(departmentUnitId) => setForm((value) => ({ ...value, departmentUnitId }))} /><UnitSelect label="Program" value={form.programUnitId} units={unitsByKind('PROGRAM')} onChange={(programUnitId) => setForm((value) => ({ ...value, programUnitId }))} /><UnitSelect label="Batch" value={form.batchUnitId} units={unitsByKind('BATCH')} onChange={(batchUnitId) => setForm((value) => ({ ...value, batchUnitId }))} /><UnitSelect label="Section" value={form.sectionUnitId} units={unitsByKind('SECTION')} onChange={(sectionUnitId) => setForm((value) => ({ ...value, sectionUnitId }))} /><label><span>Academic start date</span><input type="date" value={form.academicStartDate} onChange={(event) => setForm((value) => ({ ...value, academicStartDate: event.target.value }))} /></label><label><span>Expected graduation date</span><input type="date" value={form.expectedGraduationDate} onChange={(event) => setForm((value) => ({ ...value, expectedGraduationDate: event.target.value }))} /></label><button type="submit">Add student</button></form>
    <section className="role-card role-wide"><h2>Import Students</h2>{csvError ? <p className="form-error" role="alert">{csvError}</p> : null}<p>CSV validates academic unit names, stores resolved institution unit IDs, and rejects unknown/cross-institution names.</p><textarea value={csv} onChange={(event) => setCsv(event.target.value)} rows={5} /><div className="role-record-actions"><button type="button" onClick={() => void previewImport()}>Validate CSV</button>{preview ? <button type="button" disabled={preview.rejectedCount > 0} onClick={() => void commitImport()}>Commit {preview.acceptedCount} rows</button> : null}</div>{preview ? <div><p>{preview.acceptedCount} accepted, {preview.warningCount} warnings, {preview.rejectedCount} rejected.</p><table className="role-record-table"><thead><tr><th>Row</th><th>Email</th><th>State</th><th>Resolved units</th><th>Issues</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.email}</td><td>{row.state}</td><td>{[row.departmentUnitId, row.programUnitId, row.batchUnitId, row.sectionUnitId].filter(Boolean).length} IDs</td><td>{row.issues.join(', ') || 'None'}</td></tr>)}</tbody></table></div> : null}</section>
    <section className="role-card role-wide role-management-form"><h2>Student invitations</h2><p>Each student gets an invitation email when they are added or imported. Resend to anyone who has not activated yet.</p><label><span>Reason for resending</span><select value={resendReason} onChange={(event) => setResendReason(event.target.value)}>{invitationResendReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label><div className="role-record-actions"><button type="button" onClick={() => void resend({ all: true })}>Resend to all students not yet activated</button></div></section>
    <section className="role-card role-wide"><h2>Search students</h2><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, or institution ID" /></section>
    <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} real students</caption><thead><tr><th>Student</th><th>Institution ID</th><th>Units</th><th>Relationship</th><th>Invitation</th><th>Actions</th></tr></thead><tbody>{filteredStudents.map((student) => <tr key={student.id} className="role-record-row"><th scope="row"><strong>{student.fullName}</strong><span>{student.email}</span></th><td>{student.institutionStudentId}</td><td>{Object.values(student.units ?? {}).filter(Boolean).length} assigned</td><td>{student.relationship?.state ?? student.status}</td><td>{student.activation ? studentActivationLabels[student.activation.state] : 'NA'}{studentInvitationDeliveryNote(student.activation) ? <span>{studentInvitationDeliveryNote(student.activation)}</span> : null}</td><td><div className="role-record-actions">{student.activation && student.activation.state !== 'ACTIVATED' && student.studentUserId ? <button type="button" className="secondary" onClick={() => void resend({ studentUserIds: [student.studentUserId!] })}>Resend invitation</button> : null}<button type="button" className="secondary" onClick={() => void editStudent(student)}>Edit student</button><button type="button" onClick={() => void relationship(student.id, 'TRANSFERRED')}>Transfer</button><button type="button" onClick={() => void relationship(student.id, 'GRADUATED')}>Graduate</button><button type="button" className="secondary" onClick={() => void relationship(student.id, 'ENDED')}>End relationship</button><button type="button" className="secondary" onClick={() => void relationship(student.id, 'REVOKED')}>Revoke</button></div></td></tr>)}</tbody></table></div>
  </section>;
}

export function InstitutionAcademicStructurePage({ portal, authenticatedWorkspace, canManage = true }: { readonly canManage?: boolean; readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [units, setUnits] = useState<readonly InstitutionUnitDto[]>([]);
  const [form, setForm] = useState({ kind: 'DEPARTMENT', name: '', parentUnitId: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (token && institutionId) void listInstitutionUnits(token, institutionId).then((result) => setUnits(result.units)).catch(() => setError('Unable to load academic units.')); }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Academic Structure" message={canManage ? "Sign in with an Institution Admin identity to manage academic structure." : "Sign in to your institution staff workspace to view academic structure."} />;
  if (authenticatedWorkspace && !(canManage ? institutionWorkspaceRoles.has(authenticatedWorkspace.role) : isInstitutionStaffWorkspace(authenticatedWorkspace))) return <InstitutionWorkspaceError title="Academic Structure" unauthorized />;
  if (canManage ? !isInstitutionWorkspace(authenticatedWorkspace) : !isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Academic Structure" />;
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await createInstitutionUnit(token!, institutionId, { kind: form.kind, name: form.name, ...(form.parentUnitId ? { parentUnitId: form.parentUnitId } : {}) });
      setForm({ kind: 'DEPARTMENT', name: '', parentUnitId: '' });
      setNotice('Academic unit created.');
    } catch {
      setError('Academic unit creation failed. Check parent scope and duplicate/invalid data.');
    }
  }
  async function edit(unit: InstitutionUnitDto): Promise<void> {
    const name = window.prompt('Unit name', unit.name);
    if (!name || name.trim() === unit.name) return;
    setError('');
    try {
      await updateInstitutionUnit(token!, institutionId, unit.id, { name: name.trim() });
      setNotice('Academic unit updated.');
    } catch {
      setError('Academic unit update failed.');
    }
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Academic Structure</h1><p>{canManage ? "Manage institution-scoped departments, programs, batches, sections and campuses. Parent choices are institution-scoped." : "View institution-scoped departments, programs, batches, sections and campuses."}</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🏛️" tone="blue" value={units.filter((unit) => unit.kind === 'DEPARTMENT').length} label="Departments" />
      <V2Stat icon="🎓" tone="purple" value={units.filter((unit) => unit.kind === 'PROGRAM').length} label="Programs" />
      <V2Stat icon="📅" tone="green" value={units.filter((unit) => unit.kind === 'BATCH').length} label="Batches" />
      <V2Stat icon="🧩" tone="amber" value={units.filter((unit) => ['SECTION', 'CAMPUS'].includes(unit.kind)).length} label="Sections and campuses" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}{canManage ? <form className="role-card role-wide role-management-form" onSubmit={(event) => void create(event)}><h2>Add academic unit</h2><label><span>Kind</span><select value={form.kind} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value }))}><option>DEPARTMENT</option><option>PROGRAM</option><option>BATCH</option><option>SECTION</option><option>CAMPUS</option></select></label><label><span>Name</span><input value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} required /></label><UnitSelect label="Parent unit" value={form.parentUnitId} units={units} onChange={(parentUnitId) => setForm((value) => ({ ...value, parentUnitId }))} /><button type="submit">Create unit</button></form> : null}<div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} academic units</caption><thead><tr><th>Name</th><th>Kind</th><th>Parent</th><th>Action</th></tr></thead><tbody>{units.map((unit) => <tr key={unit.id}><th>{unit.name}</th><td>{unit.kind}</td><td>{units.find((candidate) => candidate.id === unit.parentUnitId)?.name ?? 'Institution'}</td><td>{canManage ? <button type="button" className="secondary" onClick={() => void edit(unit)}>Edit unit</button> : "NA"}</td></tr>)}</tbody></table></div></section>;
}

export function InstitutionStaffPage({ portal: _portal, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [staff, setStaff] = useState<InstitutionStaffDto | null>(null);
  const [units, setUnits] = useState<readonly InstitutionUnitDto[]>([]);
  const [form, setForm] = useState({ email: '', role: 'FACULTY_LECTURER', departmentUnitId: '', batchUnitId: '' });
  const [scopeEdits, setScopeEdits] = useState<Record<string, StaffUnitScopeDto>>({});
  const [scopeReason, setScopeReason] = useState<string>(staffScopeReasons[0][0]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    listInstitutionStaff(token, institutionId, controller.signal).then((result) => setStaff(result.staff)).catch((error: unknown) => setError(formatApiError(error, 'Unable to load staff assignments.')));
    listInstitutionUnits(token, institutionId, controller.signal).then((result) => setUnits(result.units)).catch(() => setUnits([]));
    return () => controller.abort();
  }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Staff" message="Sign in with an Institution Admin identity to invite institution staff." />;
  if (authenticatedWorkspace && !institutionWorkspaceRoles.has(authenticatedWorkspace.role)) return <InstitutionWorkspaceError title="Staff" unauthorized />;
  if (!isInstitutionWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Staff" />;
  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await inviteInstitutionStaff(token!, institutionId, form.email, form.role, {
        departmentUnitId: form.departmentUnitId || null,
        batchUnitId: form.role === 'DEPARTMENT_HEAD' ? null : form.batchUnitId || null,
      });
      setNotice('Staff invitation created. Membership is created only after the verified recipient accepts.');
      setForm({ email: '', role: 'FACULTY_LECTURER', departmentUnitId: '', batchUnitId: '' });
    } catch (error) {
      setError(formatApiError(error, 'Staff invitation failed.'));
    }
  }
  const unitName = (id: string | null | undefined): string | null => (id ? units.find((unit) => unit.id === id)?.name ?? 'NA' : null);
  const scopeLabel = (scope: StaffUnitScopeDto | undefined): string => [unitName(scope?.departmentUnitId), unitName(scope?.batchUnitId)].filter(Boolean).join(' · ') || 'Whole institution';
  const departmentChoices = (role: string): readonly InstitutionUnitDto[] => units.filter((unit) => unit.kind === 'DEPARTMENT' || (role === 'PLACEMENT_ADMIN' && unit.kind === 'CAMPUS'));
  const batchChoices = units.filter((unit) => unit.kind === 'BATCH');
  async function saveScope(membershipId: string, current: StaffUnitScopeDto | undefined): Promise<void> {
    const edit = scopeEdits[membershipId] ?? { departmentUnitId: current?.departmentUnitId ?? null, batchUnitId: current?.batchUnitId ?? null };
    setError('');
    try {
      await setInstitutionStaffScope(token!, institutionId, membershipId, { departmentUnitId: edit.departmentUnitId, batchUnitId: edit.batchUnitId, reasonCode: scopeReason });
      setNotice('Staff scope saved. It applies from their next page load.');
    } catch (error) {
      setError(formatApiError(error, 'Saving the staff scope failed.'));
    }
  }
  function editScope(membershipId: string, current: StaffUnitScopeDto | undefined, change: Partial<StaffUnitScopeDto>): void {
    setScopeEdits((edits) => ({ ...edits, [membershipId]: { departmentUnitId: current?.departmentUnitId ?? null, batchUnitId: current?.batchUnitId ?? null, ...edits[membershipId], ...change } }));
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Staff</h1><p>Invite institution staff through the verified-recipient invitation lifecycle. This screen does not attach arbitrary global user IDs.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👥" tone="teal" value={staff?.memberships?.length ?? 0} label="Active memberships" />
      <V2Stat icon="✉️" tone="amber" value={(staff?.invitations ?? []).filter((invite) => invite.state === 'PENDING').length} label="Pending invitations" />
      <V2Stat icon="📮" tone="blue" value={staff?.invitations?.length ?? 0} label="Invitations sent" />
      <V2Stat icon="🔐" tone="purple" value="Verified" label="Recipient-verified onboarding" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void invite(event)}>
      <h2>Invite institution staff</h2>
      <label><span>Recipient email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label>
      <label><span>Institution role *</span><select value={form.role} onChange={(event) => setForm((value) => ({ ...value, role: event.target.value }))}><option value="FACULTY_LECTURER">Faculty Lecturer</option><option value="DEPARTMENT_HEAD">Department Head</option><option value="PLACEMENT_ADMIN">Placement Admin</option></select></label>
      <label><span>Department scope</span><select value={form.departmentUnitId} onChange={(event) => setForm((value) => ({ ...value, departmentUnitId: event.target.value }))}><option value="">None (whole institution)</option>{departmentChoices(form.role).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
      {form.role !== 'DEPARTMENT_HEAD' ? <label><span>Batch scope</span><select value={form.batchUnitId} onChange={(event) => setForm((value) => ({ ...value, batchUnitId: event.target.value }))}><option value="">None</option>{batchChoices.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label> : null}
      <button type="submit">Send staff invitation</button>
    </form>
    <section className="role-card role-wide"><h2>Staff onboarding boundary</h2><ul className="role-check-list"><li>Allowed roles: PLACEMENT_ADMIN, DEPARTMENT_HEAD, FACULTY_LECTURER.</li><li>No platform, employer or self-escalation role is exposed.</li><li>The recipient must authenticate with a verified matching email before membership is created.</li><li>A department or batch scope limits which students the staff member sees. Without one, a placement admin or department head sees the whole institution; a lecturer sees the students of their teaching assignments once your college records any.</li></ul></section>
    <section className="role-card role-wide"><h2>Staff invitations</h2>{staff?.invitations?.length ? <table className="role-record-table"><thead><tr><th>Email</th><th>Role</th><th>State</th><th>Delivery</th><th>Expires</th></tr></thead><tbody>{staff.invitations.map((invite) => <tr key={invite.id}><td>{invite.email}</td><td>{invite.role}{invite.scope && (invite.scope.departmentUnitId || invite.scope.batchUnitId) ? <span>{scopeLabel(invite.scope)}</span> : null}</td><td>{invite.state}</td><td>{invite.delivery?.state ?? 'Pending command'}</td><td>{new Date(invite.expiresAt).toLocaleDateString()}</td></tr>)}</tbody></table> : <p>No staff invitations yet.</p>}</section>
    <section className="role-card role-wide role-management-form"><h2>Active staff memberships</h2>
      <label><span>Reason for scope change</span><select value={scopeReason} onChange={(event) => setScopeReason(event.target.value)}>{staffScopeReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
      {staff?.memberships?.length ? <table className="role-record-table"><thead><tr><th>Email</th><th>Role</th><th>State</th><th>Scope</th><th>Actions</th></tr></thead><tbody>{staff.memberships.map((member) => {
        const edit = scopeEdits[member.id] ?? { departmentUnitId: member.scope?.departmentUnitId ?? null, batchUnitId: member.scope?.batchUnitId ?? null };
        return <tr key={member.id}><td>{member.email}</td><td>{member.role}</td><td>{member.state}</td><td>{scopeLabel(member.scope)}</td><td><div className="role-record-actions">
          <select aria-label={`Department for ${member.email}`} value={edit.departmentUnitId ?? ''} onChange={(event) => editScope(member.id, member.scope, { departmentUnitId: event.target.value || null })}><option value="">None</option>{departmentChoices(member.role).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select>
          {member.role !== 'DEPARTMENT_HEAD' ? <select aria-label={`Batch for ${member.email}`} value={edit.batchUnitId ?? ''} onChange={(event) => editScope(member.id, member.scope, { batchUnitId: event.target.value || null })}><option value="">None</option>{batchChoices.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select> : null}
          <button type="button" className="secondary" onClick={() => void saveScope(member.id, member.scope)}>Save scope</button>
          <span className="staff-readonly-note">Revoke/resend/end membership: NOT YET AVAILABLE</span></div></td></tr>;
      })}</tbody></table> : <p>No accepted staff memberships yet.</p>}</section>
    <TeachingAssignmentsPanel key={institutionId + ':' + token} token={token} institutionId={institutionId} />
  </section>;
}

/** Why a staff member's unit scope is changed; recorded with the change (INST-03). */
const staffScopeReasons = [
  ['SCOPE_REVIEW', 'Access review'],
  ['ROLE_CHANGE', 'Role or responsibility changed'],
  ['DEPARTMENT_MOVE', 'Moved to another department'],
  ['CORRECTION', 'Correcting an earlier scope'],
] as const;

export function UnitSelect({ label, value, units, onChange }: { readonly label: string; readonly value: string; readonly units: readonly InstitutionUnitDto[]; readonly onChange: (value: string) => void }): React.ReactElement {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">None</option>{units.map((unit) => <option key={unit.id} value={unit.id}>{unit.kind}: {unit.name}</option>)}</select></label>;
}

export function cleanStudentPayload(form: Record<string, string>): InstitutionStudentCreateRequest {
  const payload: {
    institutionStudentId: string;
    fullName: string;
    email: string;
    departmentUnitId?: string;
    programUnitId?: string;
    batchUnitId?: string;
    sectionUnitId?: string;
    academicStartDate?: string;
    expectedGraduationDate?: string;
  } = {
    institutionStudentId: (form.institutionStudentId ?? '').trim(),
    fullName: (form.fullName ?? '').trim(),
    email: (form.email ?? '').trim(),
  };
  if (form.departmentUnitId?.trim()) payload.departmentUnitId = form.departmentUnitId.trim();
  if (form.programUnitId?.trim()) payload.programUnitId = form.programUnitId.trim();
  if (form.batchUnitId?.trim()) payload.batchUnitId = form.batchUnitId.trim();
  if (form.sectionUnitId?.trim()) payload.sectionUnitId = form.sectionUnitId.trim();
  if (form.academicStartDate?.trim()) payload.academicStartDate = form.academicStartDate.trim();
  if (form.expectedGraduationDate?.trim()) payload.expectedGraduationDate = form.expectedGraduationDate.trim();
  return payload;
}


interface StaffActionRecord {
  id: string; actionType: string; title: string; note: string | null; outcomeNote: string | null;
  studentUserId: string | null; studentName: string | null; assignedToMembershipId: string;
  ownerName: string; authorName: string; visibility: string; state: string; version: number;
  dueAt: string | null; scheduledStartAt: string | null; scheduledEndAt: string | null;
  reviewerName: string | null; lastReviewedAt: string | null; allowedTransitions: string[]; canEdit: boolean;
}
interface StaffActionResponse {
  actions: StaffActionRecord[]; students: { id: string; name: string }[]; assignees: { id: string; name: string }[];
}
const workflowTypes: Record<string, { type: string; title: string }> = {
  'Assigned Tasks': { type: 'ASSIGNED_TASK', title: 'Assigned Tasks' },
  'Student Detail': { type: 'FACULTY_NOTE', title: 'Faculty Notes' },
  'Academic Verification': { type: 'ACADEMIC_VERIFICATION', title: 'Academic Verification' },
  'Meetings': { type: 'MEETING', title: 'Meetings' },
  'Calendar': { type: 'MEETING', title: 'Meetings' },
};
const workflowTransitions: Record<string, string> = {
  DRAFT: 'Return to draft', UNDER_REVIEW: 'Submit for review', APPROVED: 'Approve',
  REJECTED: 'Reject', IN_PROGRESS: 'Start', COMPLETED: 'Complete', CANCELLED: 'Cancel', ARCHIVED: 'Archive',
};
function workflowError(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    if (cause.status === 401) return 'Your session has expired. Sign in again.';
    if (cause.status === 403) return 'You do not have permission in this institution or student scope.';
    if (cause.status === 409) return 'This record has changed. Refresh before trying again.';
    if (cause.status === 400) return 'Check the title, student, notes and dates.';
  }
  return 'Unable to load or save records. Please try again.';
}
async function staffWorkflowRequest<T>(path: string, token: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(apiBaseUrl + path, {
    method: body === undefined ? 'GET' : 'POST', signal,
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, 'X-Correlation-Id': correlationId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new ApiRequestError({ status: response.status, correlationId });
  return response.json() as Promise<T>;
}

export function InstitutionStaffActionsPage({ routeLabel, authenticatedWorkspace }: {
  readonly routeLabel: string; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined;
}): React.ReactElement {
  const token = getProtectedAccessToken();
  const workflow = workflowTypes[routeLabel];
  if (!workflow) return <InstitutionWorkspaceError title={routeLabel} />;
  if (!token) return <RestrictedApiState title={routeLabel} message="Sign in to your institution staff workspace." />;
  if (!isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title={routeLabel} unauthorized />;
  return <StaffActionWorkflow key={authenticatedWorkspace.organizationId + ':' + authenticatedWorkspace.role + ':' + token + ':' + workflow.type}
    token={token} institutionId={authenticatedWorkspace.organizationId} type={workflow.type} title={workflow.title} routeLabel={routeLabel} />;
}

function StaffActionWorkflow({ token, institutionId, type, title, routeLabel }: {
  readonly token: string; readonly institutionId: string; readonly type: string; readonly title: string; readonly routeLabel: string;
}): React.ReactElement {
  const [records, setRecords] = useState<StaffActionResponse | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<StaffActionRecord | null>(null);
  const emptyForm = { studentUserId: '', title: '', note: '', dueAt: '', assignedToMembershipId: '', scheduledStartAt: '', scheduledEndAt: '' };
  const [form, setForm] = useState(emptyForm);
  const [filters, setFilters] = useState({ studentUserId: '', state: '', assigneeMembershipId: '', period: '' });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const mutation = useRef<AbortController | null>(null);
  const path = '/api/v1/institutions/' + encodeURIComponent(institutionId) + '/staff-actions';
  const query = new URLSearchParams([['actionType', type], ...Object.entries(filters).filter(([, value]) => value)]).toString();
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setRecords(null); setError('');
    void staffWorkflowRequest<StaffActionResponse>(path + (query ? '?' + query : ''), token, controller.signal)
      .then((response) => { if (!controller.signal.aborted) setRecords(response); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(workflowError(cause)); });
    return () => controller.abort();
  }, [path, query, token, refresh]);

  async function save(body: unknown, suffix = ''): Promise<void> {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller; setBusy(true); setError(''); setNotice('');
    try {
      await staffWorkflowRequest(path + suffix + '?actionType=' + encodeURIComponent(type), token, controller.signal, body);
      if (controller.signal.aborted) return;
      setShowForm(false); setEditing(null); setForm(emptyForm); setRecords(null);
      setNotice(suffix ? 'Record updated.' : 'Staff-only draft saved.');
      setRefresh((value) => value + 1);
    } catch (cause) { if (!controller.signal.aborted) setError(workflowError(cause)); }
    finally { if (!controller.signal.aborted) { mutation.current = null; setBusy(false); } }
  }
  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const toIso = (value: string) => value ? new Date(value).toISOString() : null;
    try {
      if (type === 'MEETING' && (!form.scheduledStartAt || !form.scheduledEndAt || Date.parse(form.scheduledEndAt) <= Date.parse(form.scheduledStartAt))) {
        setError('Meeting end must be after its start.'); return;
      }
      if (editing) {
        void save({ version: editing.version, title: form.title, note: form.note, dueAt: toIso(form.dueAt) }, '/' + encodeURIComponent(editing.id) + '/update');
      } else {
        void save({ studentUserId: form.studentUserId || null, title: form.title, note: form.note, dueAt: toIso(form.dueAt),
          visibility: 'STAFF_ONLY', ...(form.assignedToMembershipId ? { assignedToMembershipId: form.assignedToMembershipId } : {}),
          ...(type === 'MEETING' ? { scheduledStartAt: toIso(form.scheduledStartAt), scheduledEndAt: toIso(form.scheduledEndAt) } : {}) });
      }
    } catch { setError('Enter a valid date and time.'); }
  }
  function localDate(value: string | null): string {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const actions = records?.actions ?? [];
  return <div className="pilot pilot-embed"><div className="pilot-page"><div className="pilot-content"><section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Institution staff workspace</span><h1>{routeLabel}</h1>
      <p>{type === 'FACULTY_NOTE' ? 'Student notes are visible to authorized institution staff only.' : type === 'ACADEMIC_VERIFICATION'
        ? 'Record a review and its outcome. This does not change an authoritative academic record or grant document access.'
        : type === 'MEETING' ? 'Record meetings within your institution scope, with an optional student subject.' : 'Manage student tasks in your current institution scope.'}</p></div>
      <button type="button" disabled={!records || busy} onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}>Create {type === 'FACULTY_NOTE' ? 'note' : type === 'MEETING' ? 'meeting' : type === 'ASSIGNED_TASK' ? 'task' : 'verification'}</button>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    <section className="role-card role-wide"><h2>{title}</h2>
      <div className="role-management-form">
        <label>Filter student<select value={filters.studentUserId} disabled={busy} onChange={(event) => setFilters({ ...filters, studentUserId: event.target.value })}>
          <option value="">All students in scope</option>{(records?.students ?? []).map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>
        <label>Filter state<select value={filters.state} disabled={busy} onChange={(event) => setFilters({ ...filters, state: event.target.value })}>
          <option value="">All states</option>{['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ARCHIVED'].map((state) => <option key={state} value={state}>{state.replaceAll('_', ' ')}</option>)}</select></label>
        <label>Filter responsibility<select value={filters.assigneeMembershipId} disabled={busy} onChange={(event) => setFilters({ ...filters, assigneeMembershipId: event.target.value })}>
          <option value="">All responsible staff</option>{(records?.assignees ?? []).map((staff) => <option key={staff.id} value={staff.id}>{staff.name}</option>)}</select></label>
        {type === 'MEETING' ? <label>Meeting period<select value={filters.period} disabled={busy} onChange={(event) => setFilters({ ...filters, period: event.target.value })}><option value="">All meetings</option><option value="upcoming">Upcoming or ongoing</option><option value="past">Past</option></select></label> : null}
        <button type="button" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Refresh records</button>
      </div>
    </section>
    {showForm && records ? <form className="role-card role-wide role-management-form" onSubmit={submit}>
      <h2>{editing ? 'Edit task draft' : 'New ' + title.toLowerCase()}</h2>
      {!editing ? <label>Student<select required={type !== 'MEETING'} disabled={busy} value={form.studentUserId} onChange={(event) => setForm({ ...form, studentUserId: event.target.value })}>
        <option value="">{type === 'MEETING' ? 'No student — staff meeting' : 'Select a student'}</option>
        {records.students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label> : null}
      <label>Title<input required maxLength={200} disabled={busy} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
      <label>Note<textarea required={type === 'FACULTY_NOTE'} maxLength={4000} disabled={busy} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
      {type === 'ASSIGNED_TASK' ? <label>Due date and time<input type="datetime-local" disabled={busy} value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} /></label> : null}
      {!editing ? <label>Responsible staff<select disabled={busy} value={form.assignedToMembershipId} onChange={(event) => setForm({ ...form, assignedToMembershipId: event.target.value })}>
        <option value="">You — current staff membership</option>{records.assignees.map((staff) => <option key={staff.id} value={staff.id}>{staff.name}</option>)}</select></label> : null}
      {type === 'MEETING' ? <>
        <label>Meeting start<input required type="datetime-local" disabled={busy} value={form.scheduledStartAt} onChange={(event) => setForm({ ...form, scheduledStartAt: event.target.value })} /></label>
        <label>Meeting end<input required type="datetime-local" disabled={busy} value={form.scheduledEndAt} onChange={(event) => setForm({ ...form, scheduledEndAt: event.target.value })} /></label>
      </> : null}
      <p>Visibility: staff only. The creating staff member is responsible for the record.</p>
      <button type="submit" disabled={busy || (!editing && type !== 'MEETING' && !records.students.length)}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save draft'}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => { setShowForm(false); setEditing(null); }}>Close form</button>
    </form> : null}
    {!records ? <p role="status">{error ? 'Records unavailable.' : 'Loading records…'}</p> : !actions.length ? <section className="role-card role-wide"><p>No records match your current scope and filters.</p></section> :
      actions.map((action) => <article className="role-card role-wide" key={action.id}>
        <h3>{action.title}</h3><p>{action.studentName ?? 'Staff meeting'} · Responsible: {action.ownerName}</p>
        <p>Author: {action.authorName} · Staff only · {action.state.replaceAll('_', ' ')}</p>
        {action.note ? <p>{action.note}</p> : null}
        {action.dueAt ? <p>Due: {new Date(action.dueAt).toLocaleString()}</p> : null}
        {action.scheduledStartAt && action.scheduledEndAt ? <p>Meeting: {new Date(action.scheduledStartAt).toLocaleString()} — {new Date(action.scheduledEndAt).toLocaleString()}</p> : null}
        {action.outcomeNote ? <p>Outcome: {action.outcomeNote}</p> : null}
        {action.reviewerName && action.lastReviewedAt ? <p>Reviewed by {action.reviewerName} on {new Date(action.lastReviewedAt).toLocaleString()}</p> : null}
        {action.canEdit ? <button type="button" className="secondary" disabled={busy} onClick={() => {
          setEditing(action); setShowForm(true); setForm({ ...emptyForm, title: action.title, note: action.note ?? '', dueAt: localDate(action.dueAt) });
        }}>Edit task</button> : null}
        {action.allowedTransitions.length ? <>
          <label>Review or outcome note for {action.title}<textarea maxLength={2000} disabled={busy} value={reasons[action.id] ?? ''} onChange={(event) => setReasons({ ...reasons, [action.id]: event.target.value })} /></label>
          <div className="role-record-actions">{action.allowedTransitions.map((state) => <button type="button" className="secondary" disabled={busy} key={state} onClick={() => {
            if ((['REJECTED', 'COMPLETED', 'CANCELLED'].includes(state) || (type === 'ACADEMIC_VERIFICATION' && state === 'APPROVED')) && !reasons[action.id]?.trim()) {
              setError('Add a review or outcome note before this action.'); return;
            }
            void save({ version: action.version, toState: state, note: reasons[action.id] ?? null }, '/' + encodeURIComponent(action.id) + '/transition');
          }}>{workflowTransitions[state] ?? state.replaceAll('_', ' ')}</button>)}</div>
        </> : null}
      </article>)}
  </section></div><aside className="pilot-rail">
    <NaListCard title="Recorded outcomes" note={records ? actions.filter((action) => action.state === 'COMPLETED').length + ' of ' + actions.length + ' visible records completed.' : 'NA — records unavailable.'} />
    {type === 'ACADEMIC_VERIFICATION' ? <NaListCard title="Evidence document" note="NA — institution access to student evidence is not available. A verification record does not grant document access." /> : null}
  </aside></div></div>;
}

type InstitutionPageProps = { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined };

export function InstitutionStudentsPage(props: InstitutionPageProps): React.ReactElement {
  if (props.authenticatedWorkspace?.role === 'PLACEMENT_ADMIN') {
    const token = getProtectedAccessToken();
    if (!token) return <RestrictedApiState title="Students" message="Sign in to your institution staff workspace." />;
    if (!isInstitutionStaffWorkspace(props.authenticatedWorkspace)) return <InstitutionWorkspaceError title="Students" unauthorized />;
    return <PlacementStudentRoster key={props.authenticatedWorkspace.organizationId + ':' + token}
      token={token} institutionId={props.authenticatedWorkspace.organizationId} />;
  }
  return <InstitutionAdminStudentsPage {...props} />;
}

function PlacementStudentRoster({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  // The roster response includes studentUserId separately from its profile id.
  const [data, setData] = useState<{ students: readonly (InstitutionStudentDto & { readonly studentUserId?: string })[]; units: readonly InstitutionUnitDto[]; scopeLabel?: string | null } | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [filters, setFilters] = useState({ query: '', department: '', batch: '', status: '' });
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError('');
    void Promise.all([listInstitutionStudents(token, institutionId, controller.signal), listInstitutionUnits(token, institutionId, controller.signal)])
      .then(([roster, structure]) => { if (!controller.signal.aborted) setData({ students: roster.students, units: structure.units, scopeLabel: institutionStudentScopeLabel(roster.scope) }); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(workflowError(cause)); });
    return () => controller.abort();
  }, [token, institutionId, refresh]);
  const unitName = (id: string | null | undefined) => (data?.units ?? []).find((unit) => unit.id === id)?.name ?? 'NA';
  const students = (data?.students ?? []).filter((student) =>
    (!filters.department || student.units?.departmentUnitId === filters.department) &&
    (!filters.batch || student.units?.batchUnitId === filters.batch) &&
    (!filters.status || (student.relationship?.state ?? student.status) === filters.status) &&
    [student.fullName, student.institutionStudentId, unitName(student.units?.departmentUnitId), unitName(student.units?.batchUnitId)]
      .join(' ').toLowerCase().includes(filters.query.trim().toLowerCase()));
  const selectedStudent = students.find((student) => student.id === selectedStudentId);
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Institution placement</span><h1>Students</h1><p>Search your institution roster. Unavailable placement information is shown as NA.</p>{data?.scopeLabel && <p>Showing students in {data.scopeLabel}.</p>}</div></div>
    <section className="role-card role-wide role-management-form">
      <label>Search students<input type="search" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} /></label>
      <label>Department<select value={filters.department} onChange={(event) => setFilters({ ...filters, department: event.target.value })}><option value="">All departments</option>
        {(data?.units ?? []).filter((unit) => unit.kind === 'DEPARTMENT').map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
      <label>Batch<select value={filters.batch} onChange={(event) => setFilters({ ...filters, batch: event.target.value })}><option value="">All batches</option>
        {(data?.units ?? []).filter((unit) => unit.kind === 'BATCH').map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
      <label>Status<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option>
        {[...new Set((data?.students ?? []).map((student) => student.relationship?.state ?? student.status))].sort().map((state) => <option key={state} value={state}>{state.replaceAll('_', ' ')}</option>)}</select></label>
      <button type="button" onClick={() => { setSelectedStudentId(''); setRefresh((value) => value + 1); }}>Refresh roster</button>
    </section>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!data ? <p role="status">{error ? 'Roster unavailable.' : 'Loading roster…'}</p> :
      <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Placement student roster</caption>
        <thead><tr><th>Name</th><th>Roll number</th><th>Department</th><th>Batch</th><th>Status</th><th>Readiness band</th><th>Applications</th><th>Last activity</th></tr></thead>
        <tbody>{students.length ? students.map((student) => <tr key={student.id}><th>{student.fullName}</th><td>{student.institutionStudentId}</td>
          <td>{unitName(student.units?.departmentUnitId)}</td><td>{unitName(student.units?.batchUnitId)}</td><td>{(student.relationship?.state ?? student.status).replaceAll('_', ' ')}</td>
          <td>NA</td><td>{student.studentUserId ? <button type="button" className="secondary" aria-label={'View applications for ' + student.fullName} onClick={() => setSelectedStudentId(student.id)}>View applications</button> : 'NA'}</td><td>NA</td></tr>) : <tr><td colSpan={8}>No students match your scope and filters.</td></tr>}</tbody>
      </table></div>}
    {selectedStudent?.studentUserId ? <section className="role-card role-wide" aria-label={'Shared applications for ' + selectedStudent.fullName}>
      <h2>Shared applications for {selectedStudent.fullName}</h2>
      <p>Only records currently available with institution consent are shown. These counts are not cohort totals.</p>
      <button type="button" className="secondary" onClick={() => setSelectedStudentId('')}>Close applications</button>
      {[false, true].map((external) => <StudentApplicationRecords key={selectedStudent.studentUserId + ':' + external}
        token={token} institutionId={institutionId} studentUserId={selectedStudent.studentUserId!} external={external} />)}
    </section> : null}
  </section>;
}

interface NativeInstitutionApplication {
  id: string; employer: { name: string }; opportunityTitle: string; state: string; submittedAt: string | null;
  createdAt: string; offer: { exists: boolean; responseState: string | null };
}
interface ExternalInstitutionApplication {
  id: string; companyName: string; roleTitle: string; stage: string; appliedOn: string;
  source: 'STUDENT_DECLARED'; verificationState: 'UNVERIFIED'; sourceKind: string;
}
function StudentApplicationRecords({ token, institutionId, studentUserId, external }: {
  readonly token: string; readonly institutionId: string; readonly studentUserId: string; readonly external: boolean;
}): React.ReactElement {
  const [rows, setRows] = useState<readonly { id: string; company: string; title: string; stage: string; date: string | null; detail: string }[] | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const title = external ? 'Student-declared external applications (unverified)' : 'Native applications';
  useEffect(() => {
    const controller = new AbortController();
    setRows(null); setError('');
    const path = '/api/v1/institutions/' + encodeURIComponent(institutionId) + '/students/' + encodeURIComponent(studentUserId) +
      (external ? '/external-applications' : '/applications');
    void staffWorkflowRequest<{ applications?: NativeInstitutionApplication[]; externalApplications?: ExternalInstitutionApplication[] }>(path, token, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (external) {
          if (!Array.isArray(result.externalApplications) || result.externalApplications.some((row) => row.source !== 'STUDENT_DECLARED' || row.verificationState !== 'UNVERIFIED')) {
            throw new Error('Invalid external declaration response');
          }
          setRows(result.externalApplications.map((row) => ({ id: row.id, company: row.companyName, title: row.roleTitle,
            stage: row.stage.replaceAll('_', ' ') + ' (student-declared)', date: row.appliedOn, detail: row.sourceKind.replaceAll('_', ' ') })));
        } else {
          if (!Array.isArray(result.applications)) throw new Error('Invalid native application response');
          setRows(result.applications.map((row) => ({ id: row.id, company: row.employer.name, title: row.opportunityTitle,
            stage: row.state.replaceAll('_', ' '), date: row.submittedAt ?? row.createdAt,
            detail: row.offer.exists ? row.offer.responseState?.replaceAll('_', ' ') ?? 'NA' : 'No offer' })));
        }
      })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(workflowError(cause)); });
    return () => controller.abort();
  }, [token, institutionId, studentUserId, external, refresh]);
  return <section className="role-card role-wide" aria-label={title}>
    <h3>{title}</h3>
    {external ? <p>These are unverified student declarations. A declared HIRED is not a verified placement and does not contribute to native or placement metrics.</p> : null}
    <p>{external ? 'Shared external declarations shown' : 'Shared native applications shown'}: <strong>{rows === null ? 'NA' : rows.length}</strong></p>
    <button type="button" className="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh {external ? 'external declarations' : 'native applications'}</button>
    {error ? <p className="form-error" role="alert">{error}</p> : rows === null ? <p role="status">Loading {external ? 'external declarations' : 'native applications'}…</p> :
      rows.length === 0 ? <p>No {external ? 'external declarations' : 'native applications'} are shared and available in this scope.</p> :
        <div className="role-record-table-wrap"><table className="role-record-table"><caption>{title}</caption>
          <thead><tr><th>Company</th><th>Role</th><th>Stage</th><th>Applied</th><th>{external ? 'Declared source' : 'Offer response'}</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}><th>{row.company}</th><td>{row.title}</td><td>{row.stage}</td>
            <td>{row.date?.slice(0, 10) ?? 'NA'}</td><td>{row.detail}</td></tr>)}</tbody>
        </table></div>}
  </section>;
}
