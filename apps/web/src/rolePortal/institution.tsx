/**
 * ONE · Role portal — Stream C — Institution
 *
 * Authenticated institution pages: roster, academic structure and staff.
 *
 * Split out of rolePortalPages.tsx so each stream owns its own surface. The
 * shell and the route dispatcher remain there and import from here.
 */
import { addInstitutionStudent, commitStudentRosterImport, createInstitutionUnit, endInstitutionStudentRelationship, getProtectedAccessToken, inviteInstitutionStaff, listInstitutionStaff, listInstitutionStudents, listInstitutionUnits, previewStudentRosterImport, updateInstitutionStudent, updateInstitutionUnit } from '../api.js';
import type { InstitutionStaffDto, InstitutionStudentCreateRequest, InstitutionStudentDto, InstitutionUnitDto, RosterImportPreviewDto } from '../api.js';
import { V2Stat } from '../dashboardsV2.js';
import type { RolePortalConfig } from '../rolePortalConfig.js';
import { InstitutionWorkspaceError, RestrictedApiState, formatApiError, institutionWorkspaceRoles, isInstitutionWorkspace } from './shared.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';

export function InstitutionStudentsPage({ portal, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
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
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Students</h1><p>Institution-owned roster and relationship lifecycle. This is not an Operations workflow.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🎓" tone="blue" value={students.length} label="Students on roster" />
      <V2Stat icon="✅" tone="green" value={students.filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE').length} label="Active" />
      <V2Stat icon="🏛️" tone="purple" value={units.length} label="Academic units" />
      <V2Stat icon="🔎" tone="amber" value={filteredStudents.length} label="Matching search" />
    </div>
    {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}{relationshipError ? <p className="form-error" role="alert">{relationshipError}</p> : null}{notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void addStudent(event)}><h2>Add Student</h2>{studentError ? <p className="form-error" role="alert">{studentError}</p> : null}<label><span>Full name *</span><input value={form.fullName} onChange={(event) => setForm((value) => ({ ...value, fullName: event.target.value }))} required /></label><label><span>Institution ID *</span><input value={form.institutionStudentId} onChange={(event) => setForm((value) => ({ ...value, institutionStudentId: event.target.value }))} required /></label><label><span>Email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label><UnitSelect label="Department" value={form.departmentUnitId} units={unitsByKind('DEPARTMENT')} onChange={(departmentUnitId) => setForm((value) => ({ ...value, departmentUnitId }))} /><UnitSelect label="Program" value={form.programUnitId} units={unitsByKind('PROGRAM')} onChange={(programUnitId) => setForm((value) => ({ ...value, programUnitId }))} /><UnitSelect label="Batch" value={form.batchUnitId} units={unitsByKind('BATCH')} onChange={(batchUnitId) => setForm((value) => ({ ...value, batchUnitId }))} /><UnitSelect label="Section" value={form.sectionUnitId} units={unitsByKind('SECTION')} onChange={(sectionUnitId) => setForm((value) => ({ ...value, sectionUnitId }))} /><label><span>Academic start date</span><input type="date" value={form.academicStartDate} onChange={(event) => setForm((value) => ({ ...value, academicStartDate: event.target.value }))} /></label><label><span>Expected graduation date</span><input type="date" value={form.expectedGraduationDate} onChange={(event) => setForm((value) => ({ ...value, expectedGraduationDate: event.target.value }))} /></label><button type="submit">Add student</button></form>
    <section className="role-card role-wide"><h2>Import Students</h2>{csvError ? <p className="form-error" role="alert">{csvError}</p> : null}<p>CSV validates academic unit names, stores resolved institution unit IDs, and rejects unknown/cross-institution names.</p><textarea value={csv} onChange={(event) => setCsv(event.target.value)} rows={5} /><div className="role-record-actions"><button type="button" onClick={() => void previewImport()}>Validate CSV</button>{preview ? <button type="button" disabled={preview.rejectedCount > 0} onClick={() => void commitImport()}>Commit {preview.acceptedCount} rows</button> : null}</div>{preview ? <div><p>{preview.acceptedCount} accepted, {preview.warningCount} warnings, {preview.rejectedCount} rejected.</p><table className="role-record-table"><thead><tr><th>Row</th><th>Email</th><th>State</th><th>Resolved units</th><th>Issues</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.email}</td><td>{row.state}</td><td>{[row.departmentUnitId, row.programUnitId, row.batchUnitId, row.sectionUnitId].filter(Boolean).length} IDs</td><td>{row.issues.join(', ') || 'None'}</td></tr>)}</tbody></table></div> : null}</section>
    <section className="role-card role-wide"><h2>Search students</h2><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email, or institution ID" /></section>
    <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} real students</caption><thead><tr><th>Student</th><th>Institution ID</th><th>Units</th><th>Relationship</th><th>Invitation</th><th>Actions</th></tr></thead><tbody>{filteredStudents.map((student) => <tr key={student.id} className="role-record-row"><th scope="row"><strong>{student.fullName}</strong><span>{student.email}</span></th><td>{student.institutionStudentId}</td><td>{Object.values(student.units ?? {}).filter(Boolean).length} assigned</td><td>{student.relationship?.state ?? student.status}</td><td>{student.status}</td><td><div className="role-record-actions"><button type="button" className="secondary" onClick={() => void editStudent(student)}>Edit student</button><button type="button" onClick={() => void relationship(student.id, 'TRANSFERRED')}>Transfer</button><button type="button" onClick={() => void relationship(student.id, 'GRADUATED')}>Graduate</button><button type="button" className="secondary" onClick={() => void relationship(student.id, 'ENDED')}>End relationship</button><button type="button" className="secondary" onClick={() => void relationship(student.id, 'REVOKED')}>Revoke</button></div></td></tr>)}</tbody></table></div>
  </section>;
}

export function InstitutionAcademicStructurePage({ portal, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [units, setUnits] = useState<readonly InstitutionUnitDto[]>([]);
  const [form, setForm] = useState({ kind: 'DEPARTMENT', name: '', parentUnitId: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (token && institutionId) void listInstitutionUnits(token, institutionId).then((result) => setUnits(result.units)).catch(() => setError('Unable to load academic units.')); }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Academic Structure" message="Sign in with an Institution Admin identity to manage academic structure." />;
  if (authenticatedWorkspace && !institutionWorkspaceRoles.has(authenticatedWorkspace.role)) return <InstitutionWorkspaceError title="Academic Structure" unauthorized />;
  if (!isInstitutionWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Academic Structure" />;
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
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Academic Structure</h1><p>Manage institution-scoped departments, programs, batches, sections and campuses. Parent choices are institution-scoped.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🏛️" tone="blue" value={units.filter((unit) => unit.kind === 'DEPARTMENT').length} label="Departments" />
      <V2Stat icon="🎓" tone="purple" value={units.filter((unit) => unit.kind === 'PROGRAM').length} label="Programs" />
      <V2Stat icon="📅" tone="green" value={units.filter((unit) => unit.kind === 'BATCH').length} label="Batches" />
      <V2Stat icon="🧩" tone="amber" value={units.filter((unit) => ['SECTION', 'CAMPUS'].includes(unit.kind)).length} label="Sections and campuses" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}<form className="role-card role-wide role-management-form" onSubmit={(event) => void create(event)}><h2>Add academic unit</h2><label><span>Kind</span><select value={form.kind} onChange={(event) => setForm((value) => ({ ...value, kind: event.target.value }))}><option>DEPARTMENT</option><option>PROGRAM</option><option>BATCH</option><option>SECTION</option><option>CAMPUS</option></select></label><label><span>Name</span><input value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} required /></label><UnitSelect label="Parent unit" value={form.parentUnitId} units={units} onChange={(parentUnitId) => setForm((value) => ({ ...value, parentUnitId }))} /><button type="submit">Create unit</button></form><div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">{portal.roleName} academic units</caption><thead><tr><th>Name</th><th>Kind</th><th>Parent</th><th>Action</th></tr></thead><tbody>{units.map((unit) => <tr key={unit.id}><th>{unit.name}</th><td>{unit.kind}</td><td>{units.find((candidate) => candidate.id === unit.parentUnitId)?.name ?? 'Institution'}</td><td><button type="button" className="secondary" onClick={() => void edit(unit)}>Edit unit</button></td></tr>)}</tbody></table></div></section>;
}

export function InstitutionStaffPage({ portal: _portal, authenticatedWorkspace }: { readonly portal: RolePortalConfig; readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [staff, setStaff] = useState<InstitutionStaffDto | null>(null);
  const [form, setForm] = useState({ email: '', role: 'FACULTY_LECTURER' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    listInstitutionStaff(token, institutionId, controller.signal).then((result) => setStaff(result.staff)).catch((error: unknown) => setError(formatApiError(error, 'Unable to load staff assignments.')));
    return () => controller.abort();
  }, [token, institutionId, notice]);
  if (!token) return <RestrictedApiState title="Staff" message="Sign in with an Institution Admin identity to invite institution staff." />;
  if (authenticatedWorkspace && !institutionWorkspaceRoles.has(authenticatedWorkspace.role)) return <InstitutionWorkspaceError title="Staff" unauthorized />;
  if (!isInstitutionWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Staff" />;
  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    try {
      await inviteInstitutionStaff(token!, institutionId, form.email, form.role);
      setNotice('Staff invitation created. Membership is created only after the verified recipient accepts.');
      setForm({ email: '', role: 'FACULTY_LECTURER' });
    } catch (error) {
      setError(formatApiError(error, 'Staff invitation failed.'));
    }
  }
  return <section className="role-module role-module--dense"><div className="role-page-heading"><div><span className="eyebrow">Authenticated API-backed</span><h1>Staff</h1><p>Invite institution staff through the verified-recipient invitation lifecycle. This screen does not attach arbitrary global user IDs.</p></div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="👥" tone="teal" value={staff?.memberships.length ?? 0} label="Active memberships" />
      <V2Stat icon="✉️" tone="amber" value={staff?.invitations.filter((invite) => invite.state === 'PENDING').length ?? 0} label="Pending invitations" />
      <V2Stat icon="📮" tone="blue" value={staff?.invitations.length ?? 0} label="Invitations sent" />
      <V2Stat icon="🔐" tone="purple" value="Verified" label="Recipient-verified onboarding" />
    </div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    <form className="role-card role-wide role-management-form" onSubmit={(event) => void invite(event)}>
      <h2>Invite institution staff</h2>
      <label><span>Recipient email *</span><input type="email" value={form.email} onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))} required /></label>
      <label><span>Institution role *</span><select value={form.role} onChange={(event) => setForm((value) => ({ ...value, role: event.target.value }))}><option value="FACULTY_LECTURER">Faculty Lecturer</option><option value="DEPARTMENT_HEAD">Department Head</option><option value="PLACEMENT_ADMIN">Placement Admin</option></select></label>
      <button type="submit">Send staff invitation</button>
    </form>
    <section className="role-card role-wide"><h2>Staff onboarding boundary</h2><ul className="role-check-list"><li>Allowed roles: PLACEMENT_ADMIN, DEPARTMENT_HEAD, FACULTY_LECTURER.</li><li>No platform, employer or self-escalation role is exposed.</li><li>The recipient must authenticate with a verified matching email before membership is created.</li></ul></section>
    <section className="role-card role-wide"><h2>Staff invitations</h2>{staff?.invitations.length ? <table className="role-record-table"><thead><tr><th>Email</th><th>Role</th><th>State</th><th>Delivery</th><th>Expires</th></tr></thead><tbody>{staff.invitations.map((invite) => <tr key={invite.id}><td>{invite.email}</td><td>{invite.role}</td><td>{invite.state}</td><td>{invite.delivery?.state ?? 'Pending command'}</td><td>{new Date(invite.expiresAt).toLocaleDateString()}</td></tr>)}</tbody></table> : <p>No staff invitations yet.</p>}</section>
    <section className="role-card role-wide"><h2>Active staff memberships</h2>{staff?.memberships.length ? <table className="role-record-table"><thead><tr><th>Email</th><th>Role</th><th>State</th><th>Actions</th></tr></thead><tbody>{staff.memberships.map((member) => <tr key={member.id}><td>{member.email}</td><td>{member.role}</td><td>{member.state}</td><td><span className="staff-readonly-note">Revoke/resend/end membership: NOT YET AVAILABLE</span></td></tr>)}</tbody></table> : <p>No accepted staff memberships yet.</p>}</section>
  </section>;
}

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
