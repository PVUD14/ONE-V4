/**
 * ONE · Role portal — Institution — Teaching assignments and My Students (INST-03)
 *
 * Faculty "My Students" shows the students of the lecturer's active teaching
 * assignments, as the server scopes them — nothing is filtered here. The teaching
 * assignments panel lets an institution admin (on Staff) or a department head (on
 * Faculty and Staff) assign faculty to sections and batches per subject and term, and end
 * an assignment, each with a reason code. Real data only; missing values read NA.
 */
import { ApiRequestError, createTeachingAssignment, endTeachingAssignment, getProtectedAccessToken, listMyStudents, listTeachingAssignments, studentActivationLabels, studentInvitationDeliveryNote } from '../api.js';
import type { MyStudentsDto, TeachingAssignmentDto, TeachingAssignmentListDto } from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { InstitutionWorkspaceError, RestrictedApiState, formatApiError, isInstitutionStaffWorkspace } from './shared.js';
import { DepartmentStaffSection } from './institutionDepartment.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { useEffect, useState } from 'react';
import { supportCodeSuffix } from '../supportCode.js';

/** Why an assignment is created; recorded with it. */
export const teachingAssignmentReasons = [
  ['NEW_TERM', 'New term allocation'],
  ['COVER', 'Covering for a colleague'],
  ['REALLOCATION', 'Workload reallocation'],
  ['CORRECTION', 'Correcting an earlier assignment'],
] as const;

/** Why an assignment is ended; recorded with it. */
export const teachingAssignmentEndReasons = [
  ['TERM_ENDED', 'Term ended'],
  ['REALLOCATED', 'Reassigned to someone else'],
  ['LEFT_INSTITUTION', 'Faculty member left'],
  ['CORRECTION', 'Assigned in error'],
] as const;

function assignmentLabel(assignment: TeachingAssignmentDto): string {
  const subject = assignment.subject ? assignment.subject.name : assignment.subjectCode ?? 'NA';
  return `${subject} · ${assignment.unit.name} · ${assignment.academicTerm}`;
}

function loadError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.status === 403) return `You do not have permission to view this.${supportCodeSuffix(error.correlationId)}`;
  return formatApiError(error, fallback);
}

/** `children` (INST-15: the cohort view over the learning engine) render at the end of the page. */
export function FacultyMyStudentsPage({ authenticatedWorkspace, children }: { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined; readonly children?: React.ReactNode }): React.ReactElement {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const [data, setData] = useState<MyStudentsDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token || !institutionId) return;
    const controller = new AbortController();
    setData(null);
    setError('');
    listMyStudents(token, institutionId, null, controller.signal)
      .then(setData)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(loadError(cause, 'Unable to load your students.')); });
    return () => controller.abort();
  }, [token, institutionId]);
  if (!token) return <RestrictedApiState title="My Students" message="Sign in to your faculty workspace to see the students you teach." />;
  if (!isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="My Students" />;
  if (authenticatedWorkspace.role !== 'FACULTY_LECTURER') return <InstitutionWorkspaceError title="My Students" unauthorized />;
  async function more(): Promise<void> {
    if (!data?.nextCursor) return;
    try {
      const next = await listMyStudents(token!, institutionId, data.nextCursor);
      setData({ ...next, students: [...data.students, ...next.students] });
    } catch (cause) {
      setError(loadError(cause, 'Unable to load more students.'));
    }
  }
  const students = data?.students ?? [];
  const notActivated = students.filter((student) => student.activation && student.activation.state !== 'ACTIVATED').length;
  const openTasks = students.reduce((sum, student) => sum + student.openTasks, 0);
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Your teaching</span><h1>My Students</h1>
      <p>The students in the sections and batches you are assigned to teach.</p>
      {data?.mode === 'MEMBERSHIP' ? <p>Your college has not started recording teaching assignments yet, so this list follows the department and batch on your staff account.</p> : null}</div></div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🎓" tone="blue" value={data ? students.length : 'NA'} label="Students" />
      <V2Stat icon="📚" tone="purple" value={data ? data.assignments.length : 'NA'} label="Teaching assignments" />
      <V2Stat icon="✉️" tone="amber" value={data ? notActivated : 'NA'} label="Not yet activated" />
      <V2Stat icon="📝" tone="green" value={data ? openTasks : 'NA'} label="Open tasks" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!data && !error ? <p role="status">Loading your students…</p> : null}
    {data ? <section className="role-card role-wide"><h2>Teaching assignments</h2>
      {data.assignments.length ? <ul className="role-check-list">{data.assignments.map((assignment) => <li key={assignment.id}>{assignmentLabel(assignment)}</li>)}</ul>
        : <p>{data.mode === 'MEMBERSHIP' ? 'None recorded yet.' : 'None active.'}</p>}</section> : null}
    {data && data.mode === 'ASSIGNMENTS' && data.assignments.length === 0 ? <div className="role-wide"><V2EmptyState icon="📚" title="You have no active teaching assignment yet"
      note="Your college shows each lecturer the students of the sections and batches they teach. Nobody is assigned to you right now."
      hint="Ask your institution admin or department head to assign you to a section or batch." /></div> : null}
    {data && students.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Students you teach</caption>
      <thead><tr><th>Student</th><th>Section / batch</th><th>Invitation</th><th>Recent assessments</th><th>Open tasks</th></tr></thead>
      <tbody>{students.map((student) => <tr key={student.profileId} className="role-record-row">
        <th scope="row"><strong>{student.fullName}</strong><span>{student.institutionStudentId}</span></th>
        <td>{[student.units.section, student.units.batch].filter(Boolean).join(' · ') || 'NA'}</td>
        <td>{student.activation ? studentActivationLabels[student.activation.state] : 'NA'}{studentInvitationDeliveryNote(student.activation) ? <span>{studentInvitationDeliveryNote(student.activation)}</span> : null}</td>
        <td>{student.recentAssessments.submitted > 0 ? `${student.recentAssessments.submitted} in 30 days · latest ${student.recentAssessments.latestTitle ?? 'NA'}` : 'None in 30 days'}</td>
        <td>{student.openTasks}</td>
      </tr>)}</tbody></table></div> : null}
    {data && students.length === 0 && !(data.mode === 'ASSIGNMENTS' && data.assignments.length === 0) ? <p className="role-wide">No students are enrolled in your assigned sections yet.</p> : null}
    {data?.nextCursor ? <div className="role-record-actions"><button type="button" className="secondary" onClick={() => void more()}>Load more students</button></div> : null}
    {children}
  </section>;
}

const emptyForm = { facultyMembershipId: '', unitId: '', subjectId: '', subjectCode: '', academicTerm: '', startsOn: '', endsOn: '', reasonCode: teachingAssignmentReasons[0][0] as string };

export function TeachingAssignmentsPanel({ token, institutionId }: { readonly token: string; readonly institutionId: string }): React.ReactElement {
  const [data, setData] = useState<TeachingAssignmentListDto | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [endReason, setEndReason] = useState<string>(teachingAssignmentEndReasons[0][0]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    listTeachingAssignments(token, institutionId, controller.signal)
      .then(setData)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(loadError(cause, 'Unable to load teaching assignments.')); });
    return () => controller.abort();
  }, [token, institutionId, reload]);
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      await createTeachingAssignment(token, institutionId, {
        facultyMembershipId: form.facultyMembershipId,
        unitId: form.unitId,
        ...(form.subjectId ? { subjectId: form.subjectId } : {}),
        ...(form.subjectCode.trim() ? { subjectCode: form.subjectCode.trim() } : {}),
        academicTerm: form.academicTerm.trim(),
        ...(form.startsOn ? { startsOn: form.startsOn } : {}),
        ...(form.endsOn ? { endsOn: form.endsOn } : {}),
        reasonCode: form.reasonCode,
      });
      setForm(emptyForm);
      setNotice('Teaching assignment recorded. The lecturer sees these students from their next page load.');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'Teaching assignment failed. Check the lecturer, the section or batch, the subject and the dates.'));
    }
  }
  async function end(assignment: TeachingAssignmentDto): Promise<void> {
    setError('');
    setNotice('');
    try {
      await endTeachingAssignment(token, institutionId, assignment.id, endReason);
      setNotice('Teaching assignment ended. The lecturer no longer sees these students.');
      setReload((value) => value + 1);
    } catch (cause) {
      setError(formatApiError(cause, 'Ending the teaching assignment failed.'));
    }
  }
  const assignments = data?.assignments ?? [];
  return <section className="role-card role-wide">
    <h2>Teaching assignments</h2>
    <p>Each lecturer sees the students of the sections and batches they are assigned to teach, for the subject and term recorded here.</p>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}
    {data?.canAssign ? <form className="role-management-form" onSubmit={(event) => void create(event)}>
      <label><span>Faculty member</span><select value={form.facultyMembershipId} required onChange={(event) => setForm((value) => ({ ...value, facultyMembershipId: event.target.value }))}><option value="">Choose</option>{data.faculty.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.email}</option>)}</select></label>
      <label><span>Section or batch</span><select value={form.unitId} required onChange={(event) => setForm((value) => ({ ...value, unitId: event.target.value }))}><option value="">Choose</option>{data.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.kind === 'SECTION' ? 'Section' : 'Batch'}: {unit.name}</option>)}</select></label>
      <label><span>Subject</span><select value={form.subjectId} onChange={(event) => setForm((value) => ({ ...value, subjectId: event.target.value }))}><option value="">None (use a code)</option>{data.subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.code ? `${subject.code} · ` : ''}{subject.name}</option>)}</select></label>
      <label><span>Subject code</span><input value={form.subjectCode} maxLength={32} onChange={(event) => setForm((value) => ({ ...value, subjectCode: event.target.value }))} /></label>
      <label><span>Academic term</span><input value={form.academicTerm} maxLength={40} required placeholder="2026-27 Odd semester" onChange={(event) => setForm((value) => ({ ...value, academicTerm: event.target.value }))} /></label>
      <label><span>Starts on</span><input type="date" value={form.startsOn} onChange={(event) => setForm((value) => ({ ...value, startsOn: event.target.value }))} /></label>
      <label><span>Ends on</span><input type="date" value={form.endsOn} onChange={(event) => setForm((value) => ({ ...value, endsOn: event.target.value }))} /></label>
      <label><span>Reason</span><select value={form.reasonCode} onChange={(event) => setForm((value) => ({ ...value, reasonCode: event.target.value }))}>{teachingAssignmentReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
      <button type="submit">Assign</button>
    </form> : null}
    {data?.canAssign && assignments.some((assignment) => assignment.state === 'ACTIVE') ? <label><span>Reason for ending</span><select value={endReason} onChange={(event) => setEndReason(event.target.value)}>{teachingAssignmentEndReasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label> : null}
    {!data && !error ? <p role="status">Loading teaching assignments…</p> : null}
    {data && assignments.length === 0 ? <p>No teaching assignments recorded yet. Until the first one is recorded, lecturers see students by the department and batch on their staff account.</p> : null}
    {assignments.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Teaching assignments</caption>
      <thead><tr><th>Faculty</th><th>Section or batch</th><th>Subject</th><th>Term</th><th>Dates</th><th>State</th><th>Actions</th></tr></thead>
      <tbody>{assignments.map((assignment) => <tr key={assignment.id}>
        <td>{assignment.facultyEmail}</td>
        <td>{assignment.unit.name}</td>
        <td>{assignment.subject ? assignment.subject.name : assignment.subjectCode ?? 'NA'}</td>
        <td>{assignment.academicTerm}</td>
        <td>{assignment.startsOn} – {assignment.endsOn ?? 'open'}</td>
        <td>{assignment.state === 'ENDED' ? 'Ended' : assignment.active ? 'Active' : 'Not in effect today'}</td>
        <td>{data?.canAssign && assignment.state === 'ACTIVE' ? <button type="button" className="secondary" onClick={() => void end(assignment)}>End assignment</button> : 'NA'}</td>
      </tr>)}</tbody></table></div> : null}
  </section>;
}

/** Department head "Faculty and Staff": teaching assignments within the head's department. */
export function InstitutionFacultyAndStaffPage({ authenticatedWorkspace }: { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined }): React.ReactElement {
  const token = getProtectedAccessToken();
  if (!token) return <RestrictedApiState title="Faculty and Staff" message="Sign in to your department workspace to manage teaching assignments." />;
  if (!isInstitutionStaffWorkspace(authenticatedWorkspace)) return <InstitutionWorkspaceError title="Faculty and Staff" />;
  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div><span className="eyebrow">Your department</span><h1>Faculty and Staff</h1>
      <p>Your department's staff, and who teaches its sections and batches. You can assign any lecturer of the college, but only to your own department's sections and batches.</p></div></div>
    <DepartmentStaffSection authenticatedWorkspace={authenticatedWorkspace} />
    <TeachingAssignmentsPanel key={authenticatedWorkspace.organizationId + ':' + token} token={token} institutionId={authenticatedWorkspace.organizationId} />
  </section>;
}
