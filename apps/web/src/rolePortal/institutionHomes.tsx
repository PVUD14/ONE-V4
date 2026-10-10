/**
 * ONE · Role portal — Institution — role homes
 *
 * The Dashboard each institution role lands on. The institution admin, the lecturer and the
 * department head used to land on the placement officer's Placement Dashboard: offer figures
 * and campus drives the lecturer's role cannot read (so the page asked for them, was refused,
 * and printed NA), and nothing about the work each of them actually does. Each home here is
 * composed from data that role is already authorized to read, with the pilot cards the other
 * institution screens use; a source that cannot be read shows NA in the same slot. The
 * placement officer keeps the Placement Dashboard.
 */
import { Icon } from '../icons/Icon.js';
import { useEffect, useState } from 'react';
import {
  getDepartmentOverview,
  getProtectedAccessToken,
  getVerificationSummary,
  institutionStudentScopeLabel,
  listInstitutionExamResults,
  listInstitutionExams,
  listInstitutionStaff,
  listInstitutionStudents,
  listInstitutionUnits,
  listMyStudents,
  studentActivationLabels,
  suppressedCountLabel,
} from '../api.js';
import type {
  DepartmentOverviewDto,
  ExamNotAttemptedDto,
  InstitutionExamDto,
  InstitutionStaffDto,
  InstitutionStudentDto,
  InstitutionUnitDto,
  MyStudentsDto,
  StudentActivationState,
  VerificationSummaryDto,
} from '../api.js';
import { getPlacementStatistics, type PlacementStatisticsDto } from '../api/placementRegister.js';
import { go } from '../pilotParity/naWidgets.js';
import { Kpis, PageHead, VerificationCard, workspaceGuard } from './institutionDepartment.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { formatDate } from '../dates.js';

type HomeProps = { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined; readonly basePath: string; readonly title: string };
type NotAttempted = ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string };

const muted = { color: 'var(--p-muted)', margin: '8px 0' } as const;
const activationStates: readonly StudentActivationState[] = ['ACTIVATED', 'INVITED', 'EXPIRED', 'BOUNCED', 'NOT_INVITED'];
const unitKindLabels: readonly (readonly [string, string])[] = [['DEPARTMENT', 'Departments'], ['PROGRAM', 'Programs'], ['BATCH', 'Batches'], ['SECTION', 'Sections'], ['CAMPUS', 'Campuses']];
const staffRoleLabels: Readonly<Record<string, string>> = {
  INSTITUTION_OWNER: 'Owner', INSTITUTION_ADMIN: 'Administrators', PLACEMENT_ADMIN: 'Placement officers',
  DEPARTMENT_HEAD: 'Department heads', FACULTY_LECTURER: 'Lecturers', CAREER_COUNSELOR: 'Career counsellors',
};

/** Who has not attempted the first published, assigned assessment — the same rule the Placement Dashboard uses. */
async function loadNotAttempted(token: string, institutionId: string, exams: readonly InstitutionExamDto[] | null, signal: AbortSignal): Promise<readonly NotAttempted[]> {
  const target = exams?.find((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0) ?? null;
  if (!target) return [];
  return listInstitutionExamResults(token, institutionId, target.id, signal)
    .then((response) => response.notAttempted.map((entry) => ({ ...entry, examTitle: target.title, endsAt: target.endsAt })))
    .catch(() => []);
}

function NeedsAttentionCard({ entries, onOpen }: { readonly entries: readonly NotAttempted[] | null; readonly onOpen: () => void }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>Students Needing Attention</h2><button type="button" className="pilot-link" onClick={onOpen}>View All</button></div>
    <div className="pilot-list">
      {entries === null ? <p style={muted}>NA</p>
        : entries.length ? entries.slice(0, 5).map((entry) => (
          <div key={entry.institutionStudentId} className="pilot-list-row">
            <span className="pilot-tile rose"><Icon name="warning" size={16} /></span>
            <div className="grow"><strong>{entry.studentName}</strong><small>{entry.inProgress ? `In progress now: ${entry.examTitle}` : `Has not attempted: ${entry.examTitle}`}</small></div>
            <span className="pilot-chip amber">Due {formatDate(entry.endsAt)}</span>
          </div>))
          : <p style={muted}>Nobody needs attention right now — every assigned assessment is attempted.</p>}
    </div>
  </section>;
}

function ActivationCard({ activation, onOpen }: { readonly activation: Readonly<Record<StudentActivationState, number>> | null; readonly onOpen: () => void }): React.ReactElement {
  return <section className="pilot-card">
    <div className="pilot-card-head"><h2>Student Activation</h2><button type="button" className="pilot-link" onClick={onOpen}>View Students</button></div>
    <div className="pilot-legend">
      {activationStates.map((state) => <div key={state}><i style={{ background: '#e5eaf2' }} /> {studentActivationLabels[state]} <span className="num">{activation ? activation[state] : 'NA'}</span></div>)}
    </div>
  </section>;
}

function useHomeData<T>(workspace: AuthenticatedWorkspaceSummary | undefined, load: (token: string, institutionId: string, signal: AbortSignal) => Promise<T>): T | null {
  const token = getProtectedAccessToken();
  const institutionId = workspace?.organizationId ?? '';
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!token || !institutionId) return undefined;
    const controller = new AbortController();
    setData(null);
    void load(token, institutionId, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); });
    return () => controller.abort();
    // `load` is a module-level function per home, so only the workspace can change.
  }, [token, institutionId, load]);
  return data;
}

// --- Institution administrator ------------------------------------------------

interface AdminHomeData {
  readonly students: readonly InstitutionStudentDto[] | null;
  readonly activation: Readonly<Record<StudentActivationState, number>> | null;
  readonly units: readonly InstitutionUnitDto[] | null;
  readonly staff: InstitutionStaffDto | null;
  readonly verification: VerificationSummaryDto | null;
  readonly exams: readonly InstitutionExamDto[] | null;
  readonly placement: PlacementStatisticsDto | null;
  readonly notAttempted: readonly NotAttempted[] | null;
}

async function loadAdminHome(token: string, institutionId: string, signal: AbortSignal): Promise<AdminHomeData> {
  const [roster, units, staff, verification, exams, placement] = await Promise.all([
    listInstitutionStudents(token, institutionId, signal).catch(() => null),
    listInstitutionUnits(token, institutionId, signal).then((response) => response.units).catch(() => null),
    listInstitutionStaff(token, institutionId, signal).then((response) => response.staff).catch(() => null),
    getVerificationSummary(token, institutionId, signal).then((response) => response.summary ?? null).catch(() => null),
    listInstitutionExams(token, institutionId, signal).then((response) => response.assessments).catch(() => null),
    getPlacementStatistics(token, institutionId, signal).then((response) => (response && response.overall ? response : null)).catch(() => null),
  ]);
  const notAttempted = exams ? await loadNotAttempted(token, institutionId, exams, signal) : null;
  return { students: roster?.students ?? null, activation: roster?.activationSummary ?? null, units, staff, verification, exams, placement, notAttempted };
}

/** The institution administrator's home: the roster, structure, staff and queues they run. */
export function InstitutionAdminHome({ authenticatedWorkspace, basePath, title }: HomeProps): React.ReactElement {
  const data = useHomeData(authenticatedWorkspace, loadAdminHome);
  const guard = workspaceGuard(title, authenticatedWorkspace);
  if (guard) return guard;
  const active = data?.students ? data.students.filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE').length : null;
  const activeStaff = data?.staff ? data.staff.memberships.filter((member) => member.state === 'ACTIVE') : null;
  const pendingInvitations = data?.staff ? data.staff.invitations.filter((invitation) => invitation.state === 'PENDING').length : null;
  const published = data?.exams ? data.exams.filter((exam) => exam.lifecycleState === 'PUBLISHED').length : null;
  const show = (value: number | null | undefined): string => (value === null || value === undefined ? 'NA' : String(value));
  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <PageHead title={title} summary="Your institution at a glance: the roster, its academic structure, your staff and the queues waiting on you." />
      {!data ? <p role="status">Loading your institution…</p> : null}
      <Kpis items={[
        ['Students on roster', show(data?.students?.length), 'blue', 'students'],
        ['Active students', show(active), 'teal', 'students'],
        ['Academic units', show(data?.units?.length), 'indigo', 'batches'],
        ['Staff members', show(activeStaff?.length), 'green', 'staff'],
        ['Awaiting verification', show(data?.verification?.pending), 'rose', 'verification'],
      ]} />
      <div className="pilot-row cols-2">
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Academic Structure</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/academic-structure`)}>Manage Structure</button></div>
          <div className="pilot-legend">
            {unitKindLabels.map(([kind, label]) => <div key={kind}><i style={{ background: '#e5eaf2' }} /> {label} <span className="num">{data?.units ? data.units.filter((unit) => unit.kind === kind).length : 'NA'}</span></div>)}
          </div>
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Staff</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/staff`)}>Manage Staff</button></div>
          <div className="pilot-legend">
            {Object.entries(staffRoleLabels).map(([role, label]) => <div key={role}><i style={{ background: '#e5eaf2' }} /> {label} <span className="num">{activeStaff ? activeStaff.filter((member) => member.role === role).length : 'NA'}</span></div>)}
            <div><i style={{ background: '#e5eaf2' }} /> Invitations not yet accepted <span className="num">{show(pendingInvitations)}</span></div>
          </div>
        </section>
      </div>
      <ActivationCard activation={data?.activation ?? null} onOpen={() => go(`${basePath}/students`)} />
      <NeedsAttentionCard entries={data?.notAttempted ?? null} onOpen={() => go(`${basePath}/assessments`)} />
    </div>
    <aside className="pilot-rail">
      <VerificationCard summary={data?.verification ?? null} onOpen={() => go(`${basePath}/students`)} />
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Assessments</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/assessments`)}>Open</button></div>
        <div className="pilot-legend">
          <div><i style={{ background: '#e5eaf2' }} /> Published <span className="num">{show(published)}</span></div>
          <div><i style={{ background: '#e5eaf2' }} /> Not published <span className="num">{data?.exams && published !== null ? data.exams.length - published : 'NA'}</span></div>
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Placement</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/placement`)}>Open Placement</button></div>
        <div className="pilot-legend">
          <div><i style={{ background: '#e5eaf2' }} /> Placement eligible <span className="num">{suppressedCountLabel(data?.placement?.overall.eligible)}</span></div>
          <div><i style={{ background: '#e5eaf2' }} /> Students with offers <span className="num">{suppressedCountLabel(data?.placement?.overall.withOffer)}</span></div>
          <div><i style={{ background: '#e5eaf2' }} /> Students placed <span className="num">{suppressedCountLabel(data?.placement?.overall.placed)}</span></div>
        </div>
        <small style={{ color: 'var(--p-muted)' }}>From applications students shared with the college. Fewer than five reads &lt;5.</small>
      </section>
    </aside>
  </div></div>;
}

// --- Lecturer -----------------------------------------------------------------

interface FacultyHomeData {
  readonly myStudents: MyStudentsDto | null;
  readonly verification: VerificationSummaryDto | null;
  readonly exams: readonly InstitutionExamDto[] | null;
  readonly notAttempted: readonly NotAttempted[] | null;
}

async function loadFacultyHome(token: string, institutionId: string, signal: AbortSignal): Promise<FacultyHomeData> {
  // Campus drives and placement statistics are not read here: the lecturer is not one of
  // their reader roles (campus-drives.controller.ts, institution-placement-register.controller.ts).
  const [myStudents, verification, exams] = await Promise.all([
    listMyStudents(token, institutionId, null, signal).then((response) => (Array.isArray(response?.students) && Array.isArray(response.assignments) ? response : null)).catch(() => null),
    getVerificationSummary(token, institutionId, signal).then((response) => response.summary ?? null).catch(() => null),
    listInstitutionExams(token, institutionId, signal).then((response) => response.assessments).catch(() => null),
  ]);
  const notAttempted = exams ? await loadNotAttempted(token, institutionId, exams, signal) : null;
  return { myStudents, verification, exams, notAttempted };
}

/** The lecturer's teaching home: the students they teach, their open tasks and the verification queue. */
export function FacultyTeachingHome({ authenticatedWorkspace, basePath, title }: HomeProps): React.ReactElement {
  const data = useHomeData(authenticatedWorkspace, loadFacultyHome);
  const guard = workspaceGuard(title, authenticatedWorkspace);
  if (guard) return guard;
  const students = data?.myStudents?.students ?? null;
  const openTasks = students ? students.reduce((sum, student) => sum + student.openTasks, 0) : null;
  const withTasks = students ? students.filter((student) => student.openTasks > 0) : null;
  const show = (value: number | null | undefined): string => (value === null || value === undefined ? 'NA' : String(value));
  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <PageHead title={title} summary="The students you teach, the tasks you have open with them and the results waiting for you to verify."
        scopeLabel={institutionStudentScopeLabel(data?.myStudents?.scope)} />
      {!data ? <p role="status">Loading your teaching…</p> : null}
      <Kpis items={[
        ['My students', show(students?.length), 'blue', 'students'],
        ['Teaching assignments', show(data?.myStudents?.assignments?.length), 'indigo', 'learning'],
        ['Open tasks', show(openTasks), 'green', 'tasks'],
        ['Awaiting verification', show(data?.verification?.pending), 'amber', 'verification'],
        ['Need attention', show(data?.notAttempted?.length), 'rose', 'warning'],
      ]} />
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>My Students</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/my-students`)}>View My Students</button></div>
        <div className="pilot-list">
          {students === null ? <p style={muted}>NA</p>
            : students.length ? students.slice(0, 6).map((student) => (
              <div key={student.profileId} className="pilot-list-row">
                <span className="pilot-tile blue"><Icon name="students" size={16} /></span>
                <div className="grow"><strong>{student.fullName}</strong><small>{[student.units.section, student.units.batch].filter(Boolean).join(' · ') || 'NA'}</small></div>
                <span className="pilot-chip slate">{student.recentAssessments.latestTitle ?? 'No submitted assessment'}</span>
              </div>))
              : <p style={muted}>No students are assigned to you yet.</p>}
        </div>
      </section>
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Assigned Tasks</h2><button type="button" className="pilot-link" onClick={() => go(`${basePath}/assigned-tasks`)}>Open Tasks</button></div>
        <div className="pilot-list">
          {withTasks === null ? <p style={muted}>NA</p>
            : withTasks.length ? withTasks.slice(0, 5).map((student) => (
              <div key={student.profileId} className="pilot-list-row">
                <span className="pilot-tile green"><Icon name="assessments" size={16} /></span>
                <div className="grow"><strong>{student.fullName}</strong><small>{student.institutionStudentId}</small></div>
                <span className="pilot-chip amber">{student.openTasks} open</span>
              </div>))
              : <p style={muted}>No tasks are open with your students.</p>}
        </div>
      </section>
    </div>
    <aside className="pilot-rail">
      <VerificationCard summary={data?.verification ?? null} onOpen={() => go(`${basePath}/academic-verification`)} />
      <NeedsAttentionCard entries={data?.notAttempted ?? null} onOpen={() => go(`${basePath}/assessments`)} />
    </aside>
  </div></div>;
}

// --- Department head ------------------------------------------------------------

interface DepartmentHomeData {
  readonly overview: DepartmentOverviewDto | null;
  readonly verification: VerificationSummaryDto | null;
  readonly notAttempted: readonly NotAttempted[] | null;
}

async function loadDepartmentHome(token: string, institutionId: string, signal: AbortSignal): Promise<DepartmentHomeData> {
  const [overview, verification, exams] = await Promise.all([
    getDepartmentOverview(token, institutionId, signal).then((response) => (response && response.students && response.staffActions ? response : null)).catch(() => null),
    getVerificationSummary(token, institutionId, signal).then((response) => response.summary ?? null).catch(() => null),
    listInstitutionExams(token, institutionId, signal).then((response) => response.assessments).catch(() => null),
  ]);
  const notAttempted = exams ? await loadNotAttempted(token, institutionId, exams, signal) : null;
  return { overview, verification, notAttempted };
}

/**
 * The department head's home: the department overview's headline figures and the work
 * waiting on them this week. The full breakdown (readiness bands, pipeline, batches) stays on
 * Department Overview, which this links to rather than repeats.
 */
export function DepartmentHeadHome({ authenticatedWorkspace, basePath, title }: HomeProps): React.ReactElement {
  const data = useHomeData(authenticatedWorkspace, loadDepartmentHome);
  const guard = workspaceGuard(title, authenticatedWorkspace);
  if (guard) return guard;
  const overview = data?.overview ?? null;
  const show = (value: number | null | undefined): string => (value === null || value === undefined ? 'NA' : String(value));
  return <div className="pilot pilot-embed"><div className="pilot-page">
    <div className="pilot-content">
      <PageHead title={title} summary="What needs you in your department this week. The full breakdown is under Department Overview."
        scopeLabel={institutionStudentScopeLabel(overview?.scope)} />
      {!data ? <p role="status">Loading your department…</p> : null}
      <Kpis items={[
        ['Currently enrolled', show(overview?.students.current), 'blue', 'students'],
        ['Open interventions', show(overview?.staffActions.openInterventions), 'rose', 'warning'],
        ['Open tasks', show(overview?.staffActions.openTasks), 'green', 'tasks'],
        ['Awaiting verification', show(data?.verification?.pending), 'amber', 'verification'],
        ['Need attention', show(data?.notAttempted?.length), 'indigo', 'students'],
      ]} />
      <NeedsAttentionCard entries={data?.notAttempted ?? null} onOpen={() => go(`${basePath}/assessments`)} />
      <section className="pilot-card">
        <div className="pilot-card-head"><h2>Your Department</h2></div>
        <div className="pilot-list">
          {([
            ['Department Overview', 'Readiness bands, pipeline, activation and batches', 'department-overview', 'departments'],
            ['Interventions', `${show(overview?.staffActions.openInterventions)} open`, 'interventions', 'warning'],
            ['Placement Pipeline', 'Applications students shared, by stage', 'placement-pipeline', 'pipeline'],
            ['Faculty and Staff', 'Who teaches in your department', 'faculty-and-staff', 'staff'],
          ] as const).map(([label, detail, slug, glyph]) => (
            <div key={slug} className="pilot-list-row">
              <span className="pilot-tile blue"><Icon name={glyph} size={16} /></span>
              <div className="grow"><strong>{label}</strong><small>{detail}</small></div>
              <button type="button" className="pilot-btn ghost small" onClick={() => go(`${basePath}/${slug}`)}>Open</button>
            </div>))}
        </div>
      </section>
    </div>
    <aside className="pilot-rail">
      <VerificationCard summary={data?.verification ?? null} onOpen={() => go(`${basePath}/students`)} />
      <ActivationCard activation={overview?.activation ?? null} onOpen={() => go(`${basePath}/students`)} />
    </aside>
  </div></div>;
}
