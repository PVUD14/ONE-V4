/**
 * ONE · Role portal — Institution — role homes
 *
 * The Dashboard each institution role lands on, in the approved Momentum composition (re-skin
 * phase 6): the institution administrator after unified/college-admin.html, the lecturer after
 * 06-screens/lecturer.html and the department head after 06-screens/department-head.html. The
 * placement officer's home is placementOfficerHome.tsx.
 *
 * Each home is composed from data that role is already authorized to read. The approved guide's
 * rule (owner decision 2026-10-10) decides what is drawn: a block renders only when its data
 * exists, and never "NA", a made-up 0 or a sample name in its place. Counts of people go through
 * <SmallCount>; where a total sits beside the parts of the same people, the parts become ranges
 * when a small group could otherwise be worked out (06-screens/README-institution.md). Readiness
 * is a band distribution (<BandClimb>), never a score or an average; no screen here shows one
 * student's band, because no institution read returns it.
 */
import React, { useEffect, useState } from 'react';
import { Icon } from '../icons/Icon.js';
import {
  getDepartmentOverview,
  getPlacementPipeline,
  getProtectedAccessToken,
  getVerificationSummary,
  institutionStudentScopeLabel,
  listCalendar,
  listDepartmentStaff,
  listInstitutionExamResults,
  listInstitutionExams,
  listInstitutionStaff,
  listInstitutionStudents,
  listInstitutionUnits,
  listMyStudents,
  listPlacementApplications,
  listStaffActionSummaries,
} from '../api.js';
import type {
  CalendarEntryDto,
  DepartmentOverviewDto,
  DepartmentStaffDto,
  ExamNotAttemptedDto,
  InstitutionExamDto,
  InstitutionStaffDto,
  InstitutionStudentDto,
  InstitutionUnitDto,
  MyStudentsDto,
  PlacementApplicationDto,
  PlacementPipelineDto,
  StaffActionSummaryDto,
  StudentActivationState,
  VerificationSummaryDto,
} from '../api.js';
import { getPlacementStatistics, type PlacementStatisticsDto } from '../api/placementRegister.js';
import { workspaceGuard } from './institutionDepartment.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { SmallCount, partitionNeedsRanges, isSmallCount } from '../momentum/smallCount.js';
import { bandCount } from '../momentum/bandClimb.js';
import { codeLabel, roleLabel } from '../labels.js';
import {
  ActivationCard, BatchTable, CohortBandsCard, IhAvatar, IhCard, IhKpis, IhNote, IhPage, IhRows, IhTiles, NeedsAttentionCard, OPEN_ACTION_STATES,
  PeopleCount, RecordCount, VerificationBlock, go, shortDate, shortTime, validOverview,
} from './institutionMomentum.js';

type HomeProps = { readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined; readonly basePath: string; readonly title: string };
type NotAttempted = ExamNotAttemptedDto & { readonly examTitle: string; readonly endsAt: string };

const unitKindLabels: readonly (readonly [string, string, string, string])[] = [
  ['DEPARTMENT', 'Departments', 'dept', 'depts'], ['PROGRAM', 'Programs', 'program', 'programs'], ['BATCH', 'Batches', 'batch', 'batches'],
  ['SECTION', 'Sections', 'section', 'sections'], ['CAMPUS', 'Campuses', 'campus', 'campuses'],
];
const staffRoleLabels: readonly (readonly [string, string])[] = [
  ['PLACEMENT_ADMIN', 'Placement officers'], ['DEPARTMENT_HEAD', 'Department heads'], ['FACULTY_LECTURER', 'Lecturers'],
  ['CAREER_COUNSELOR', 'Career counsellors'], ['INSTITUTION_ADMIN', 'Administrators'], ['INSTITUTION_OWNER', 'Owners'],
];

/** Who has not attempted the first published, assigned assessment — the rule the Interventions queue uses. */
async function loadNotAttempted(token: string, institutionId: string, exams: readonly InstitutionExamDto[] | null, signal: AbortSignal): Promise<readonly NotAttempted[]> {
  const target = exams?.find((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0) ?? null;
  if (!target) return [];
  return listInstitutionExamResults(token, institutionId, target.id, signal)
    .then((response) => response.notAttempted.map((entry) => ({ ...entry, examTitle: target.title, endsAt: target.endsAt })))
    .catch(() => []);
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

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
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
  readonly overview: DepartmentOverviewDto | null;
  readonly notAttempted: readonly NotAttempted[] | null;
}

async function loadAdminHome(token: string, institutionId: string, signal: AbortSignal): Promise<AdminHomeData> {
  const [roster, units, staff, verification, exams, placement, overview] = await Promise.all([
    listInstitutionStudents(token, institutionId, signal).catch(() => null),
    listInstitutionUnits(token, institutionId, signal).then((response) => (Array.isArray(response?.units) ? response.units : null)).catch(() => null),
    listInstitutionStaff(token, institutionId, signal).then((response) => (response?.staff && Array.isArray(response.staff.memberships) ? response.staff : null)).catch(() => null),
    getVerificationSummary(token, institutionId, signal).then((response) => response?.summary ?? null).catch(() => null),
    listInstitutionExams(token, institutionId, signal).then((response) => (Array.isArray(response?.assessments) ? response.assessments : null)).catch(() => null),
    getPlacementStatistics(token, institutionId, signal).then((response) => (response && response.overall ? response : null)).catch(() => null),
    // The institution-wide band distribution and batches come from the overview the server scopes to the reader.
    getDepartmentOverview(token, institutionId, signal).then(validOverview).catch(() => null),
  ]);
  const notAttempted = exams ? await loadNotAttempted(token, institutionId, exams, signal) : null;
  return {
    students: Array.isArray(roster?.students) ? roster.students : null, activation: roster?.activationSummary ?? null,
    units, staff, verification, exams, placement, overview, notAttempted,
  };
}

/** The institution administrator's home: the roster, structure, staff and queues they run. */
export function InstitutionAdminHome({ authenticatedWorkspace, basePath, title }: HomeProps): React.ReactElement {
  const data = useHomeData(authenticatedWorkspace, loadAdminHome);
  const guard = workspaceGuard(title, authenticatedWorkspace);
  if (guard) return guard;
  const students = data?.students ?? null;
  const active = students ? students.filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE').length : null;
  const activeRanged = students && active !== null ? partitionNeedsRanges([active, students.length - active]) : false;
  const activeStaff = data?.staff ? data.staff.memberships.filter((member) => member.state === 'ACTIVE') : null;
  const pendingInvitations = data?.staff ? data.staff.invitations.filter((invitation) => invitation.state === 'PENDING').length : 0;
  const units = data?.units ?? null;
  const unitSummary = units ? unitKindLabels.map(([kind, , one, many]) => [units.filter((unit) => unit.kind === kind).length, one, many] as const)
    .filter(([count]) => count > 0).slice(0, 3).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`).join(' · ') : '';
  const published = data?.exams ? data.exams.filter((exam) => exam.lifecycleState === 'PUBLISHED').length : null;
  const overview = data?.overview ?? null;
  const readiness = overview?.readiness.aggregate && overview.readiness.month ? overview.readiness : null;
  const batches = overview?.batches ?? [];

  return <IhPage eyebrow={institutionStudentScopeLabel(overview?.scope) ?? null} title={title}
    summary="Your roster, academic structure, staff and the queues waiting on you."
    actions={<button type="button" className="pilot-btn ghost" onClick={() => go(`${basePath}/students`)}><Icon name="plus" size={16} /> Invite students</button>}>
    {!data ? <p role="status" className="ih-empty">Loading your institution…</p> : null}
    <IhKpis items={[
      students !== null && { key: 'roster', icon: 'students', value: <PeopleCount value={students.length} />, label: 'Students on roster', note: batches.length ? `${batches.length} ${plural(batches.length, 'batch', 'batches')}` : null },
      active !== null && { key: 'active', icon: 'students', value: <PeopleCount value={active} range={activeRanged} />, label: 'Active students', note: 'Current relationship' },
      units !== null && { key: 'units', icon: 'academic-structure', value: <RecordCount value={units.length} />, label: 'Academic units', note: unitSummary || null },
      activeStaff !== null && { key: 'staff', icon: 'staff', value: <RecordCount value={activeStaff.length} />, label: 'Staff members', note: pendingInvitations ? `${pendingInvitations} ${plural(pendingInvitations, 'invitation', 'invitations')} pending` : null },
      data?.verification ? { key: 'verify', icon: 'verification', value: <RecordCount value={data.verification.pending} />, label: 'Awaiting verification', note: data.verification.pending ? null : 'Queue is clear', ...(data.verification.pending ? {} : { tone: 'ok' as const }) } : null,
    ]} />
    <div className="ih-grid">
      {readiness ? <div className="ih-c8"><CohortBandsCard title="Cohort readiness" aggregate={readiness.aggregate!} month={readiness.month}
        link={{ label: 'Career Readiness', onClick: () => go(`${basePath}/career-readiness`) }}
        action={<button type="button" className="pilot-btn ghost small" onClick={() => go(`${basePath}/interventions`)}><Icon name="interventions" size={16} /> Plan an intervention</button>} /></div> : null}
      {data?.verification || data?.placement ? <div className={`${readiness ? 'ih-c4' : 'ih-c12'} ih-col`}>
        {data.verification ? <IhCard title="Academic verification" link={{ label: 'Review queue', onClick: () => go(`${basePath}/students`) }}>
          <VerificationBlock pending={data.verification.pending} />
        </IhCard> : null}
        {data.placement ? <IhCard title="Placement" link={{ label: 'Open', onClick: () => go(`${basePath}/placement`) }}>
          <IhTiles tiles={[
            { key: 'eligible', icon: 'placement', label: 'Eligible', value: <SmallCount value={data.placement.overall.eligible} /> },
            { key: 'offers', icon: 'offers', label: 'With offers', value: <SmallCount value={data.placement.overall.withOffer} /> },
            { key: 'placed', icon: 'students', label: 'Placed', value: <SmallCount value={data.placement.overall.placed} /> },
          ]} />
          <IhNote>From applications students chose to share. Counts under five show as “&lt;5”.</IhNote>
        </IhCard> : null}
      </div> : null}
      {data?.activation ? <div className="ih-c4"><ActivationCard activation={data.activation} onOpen={() => go(`${basePath}/students`)} /></div> : null}
      {units ? <div className="ih-c4"><IhCard title="Academic structure" link={{ label: 'Manage', onClick: () => go(`${basePath}/academic-structure`) }}>
        <IhTiles tiles={unitKindLabels.map(([kind, label]) => {
          const count = units.filter((unit) => unit.kind === kind).length;
          return { key: kind, label, value: <RecordCount value={count} />, muted: count === 0 };
        })} />
        {units.some((unit) => unit.kind === 'DEPARTMENT') ? <div className="ih-chips">{units.filter((unit) => unit.kind === 'DEPARTMENT').map((unit) => <span key={unit.id} className="ih-chip">{unit.name}</span>)}</div> : null}
        <IhNote icon="info">Sections and campuses are optional. Add them when you want reports split that way.</IhNote>
      </IhCard></div> : null}
      {activeStaff ? <div className="ih-c4"><IhCard title="Staff" link={{ label: 'Manage staff', onClick: () => go(`${basePath}/staff`) }}>
        <IhRows rows={staffRoleLabels.map(([role, label]) => [label, activeStaff.filter((member) => member.role === role).length] as const)} />
        {pendingInvitations ? <div className="ih-pend"><Icon name="clock" size={16} /><span><b>{pendingInvitations} {plural(pendingInvitations, 'invitation', 'invitations')}</b> not yet accepted</span></div> : null}
      </IhCard></div> : null}
      {overview && batches.length ? <div className="ih-c8"><BatchTable overview={overview} onOpen={() => go(`${basePath}/reports`)} /></div> : null}
      {data?.notAttempted ? <div className="ih-c4 ih-col">
        <NeedsAttentionCard entries={data.notAttempted} onOpen={() => go(`${basePath}/assessments`)} />
        {data.exams && published !== null ? <IhCard title="Assessments" link={{ label: 'Open', onClick: () => go(`${basePath}/assessments`) }}>
          <IhTiles columns={2} tiles={[
            { key: 'published', label: 'Published', value: <RecordCount value={published} />, muted: published === 0 },
            { key: 'draft', label: 'Not published', value: <RecordCount value={data.exams.length - published} />, muted: data.exams.length === published },
          ]} />
          {published === 0 ? <div className="ih-btns"><button type="button" className="pilot-btn ghost small" onClick={() => go(`${basePath}/assessments`)}><Icon name="plus" size={16} /> Create an assessment</button></div> : null}
        </IhCard> : null}
      </div> : null}
    </div>
  </IhPage>;
}

// --- Lecturer -----------------------------------------------------------------

interface FacultyHomeData {
  readonly myStudents: MyStudentsDto | null;
  readonly verification: VerificationSummaryDto | null;
  readonly notAttempted: readonly NotAttempted[] | null;
  readonly tasks: readonly StaffActionSummaryDto[] | null;
  readonly interventions: readonly StaffActionSummaryDto[] | null;
  readonly calendar: readonly CalendarEntryDto[] | null;
}

async function loadFacultyHome(token: string, institutionId: string, signal: AbortSignal): Promise<FacultyHomeData> {
  // Campus drives and placement statistics are not read here: the lecturer is not one of
  // their reader roles (campus-drives.controller.ts, institution-placement-register.controller.ts).
  const [myStudents, verification, exams, tasks, interventions, calendar] = await Promise.all([
    listMyStudents(token, institutionId, null, signal).then((response) => (Array.isArray(response?.students) && Array.isArray(response.assignments) ? response : null)).catch(() => null),
    getVerificationSummary(token, institutionId, signal).then((response) => response?.summary ?? null).catch(() => null),
    listInstitutionExams(token, institutionId, signal).then((response) => (Array.isArray(response?.assessments) ? response.assessments : null)).catch(() => null),
    listStaffActionSummaries(token, institutionId, 'ASSIGNED_TASK', signal).catch(() => null),
    listStaffActionSummaries(token, institutionId, 'INTERVENTION', signal).catch(() => null),
    listCalendar(token, signal).then((response) => (Array.isArray(response?.entries) ? response.entries : null)).catch(() => null),
  ]);
  const notAttempted = exams ? await loadNotAttempted(token, institutionId, exams, signal) : null;
  return { myStudents, verification, notAttempted, tasks, interventions, calendar };
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const KIND_TAGS: Readonly<Record<CalendarEntryDto['kind'], readonly [string, string]>> = {
  INTERVIEW: ['Interview', 't-cyan'], EXAM: ['Assessment', 't-band'], TASK: ['Task due', 't-band'], MEETING: ['Meeting', 't-band'], ROADMAP: ['Plan', 't-mute'],
};

/** The next seven days from today and what falls on them, from the lecturer's own calendar. */
function WeekCard({ entries, onOpen }: { readonly entries: readonly CalendarEntryDto[]; readonly onOpen: () => void }): React.ReactElement {
  const today = startOfDay(Date.now());
  const days = Array.from({ length: 7 }, (_, index) => today + index * 86400000);
  const end = today + 7 * 86400000;
  const inWeek = entries.filter((entry) => { const at = Date.parse(entry.startsAt); return Number.isFinite(at) && at >= today && at < end; })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const first = new Date(days[0]!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const last = new Date(days[6]!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return <IhCard title="Calendar" aside={`${first} – ${last}`} link={{ label: 'Open calendar', onClick: onOpen }}>
    <ol className="ih-week" aria-label="The next seven days">{days.map((day, index) => {
      const has = inWeek.some((entry) => startOfDay(Date.parse(entry.startsAt)) === day);
      const date = new Date(day);
      const classes = [index === 0 ? 'today' : '', has ? 'has' : ''].filter(Boolean).join(' ');
      return <li key={day} {...(classes ? { className: classes } : {})}>
        <small>{date.toLocaleDateString('en-GB', { weekday: 'short' })}</small><b>{date.getDate()}</b><i aria-hidden="true" />
        <span className="sr-only">{has ? 'Something scheduled' : 'Nothing scheduled'}</span>
      </li>;
    })}</ol>
    {inWeek.length ? <ul className="ih-list">{inWeek.slice(0, 5).map((entry) => {
      const [tag, tone] = KIND_TAGS[entry.kind] ?? ['Event', 't-mute'];
      return <li key={entry.id} className="ih-li">
        <div className="ih-when"><b>{new Date(entry.startsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</b>{shortTime(entry.startsAt)}{entry.endsAt && shortTime(entry.endsAt) ? ` – ${shortTime(entry.endsAt)}` : ''}</div>
        <div className="ih-li-t"><b>{entry.title}</b>{entry.detail || entry.location ? <small>{[entry.detail, entry.location].filter(Boolean).join(' · ')}</small> : null}</div>
        <span className={`tag ${tone}`}><i />{tag}</span>
      </li>;
    })}</ul> : <p className="ih-empty">Nothing is on your calendar for the next seven days.</p>}
  </IhCard>;
}

/** A staff action's due date as a tag, or its state when it has none. */
function ActionTag({ action }: { readonly action: StaffActionSummaryDto }): React.ReactElement {
  if (!OPEN_ACTION_STATES.has(action.state)) return <span className={`tag ${action.state === 'COMPLETED' ? 't-ok' : 't-mute'}`}><i />{codeLabel(action.state)}</span>;
  const due = shortDate(action.dueAt);
  const overdue = action.dueAt ? Date.parse(action.dueAt) < Date.now() : false;
  return <span className={`tag ${overdue ? 't-warn' : 't-band'}`}><i />{due ? `Due ${due}` : codeLabel(action.state)}</span>;
}

function ActionList({ actions, limit = 4 }: { readonly actions: readonly StaffActionSummaryDto[]; readonly limit?: number }): React.ReactElement {
  return <ul className="ih-list">{actions.slice(0, limit).map((action) => <li key={action.id} className="ih-li">
    <span className="ih-li-i" aria-hidden="true"><Icon name={action.actionType === 'INTERVENTION' ? 'interventions' : action.actionType === 'MEETING' ? 'meetings' : 'tasks'} size={16} /></span>
    <div className="ih-li-t"><b>{action.title}</b><small>{[action.studentName, shortDate(action.updatedAt) ? `Updated ${shortDate(action.updatedAt)}` : null].filter(Boolean).join(' · ')}</small></div>
    <ActionTag action={action} />
  </li>)}</ul>;
}

/** Open actions first (soonest due), then the most recently closed. */
function orderActions(actions: readonly StaffActionSummaryDto[]): readonly StaffActionSummaryDto[] {
  const due = (action: StaffActionSummaryDto) => (action.dueAt ? Date.parse(action.dueAt) : Number.MAX_SAFE_INTEGER);
  const open = actions.filter((action) => OPEN_ACTION_STATES.has(action.state)).sort((a, b) => due(a) - due(b));
  const closed = actions.filter((action) => !OPEN_ACTION_STATES.has(action.state)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return [...open, ...closed];
}

/** The lecturer's teaching home: the students they teach, the tasks they set them and the week ahead. */
export function FacultyTeachingHome({ authenticatedWorkspace, basePath, title }: HomeProps): React.ReactElement {
  const data = useHomeData(authenticatedWorkspace, loadFacultyHome);
  const guard = workspaceGuard(title, authenticatedWorkspace);
  if (guard) return guard;
  const students = data?.myStudents?.students ?? null;
  const openTasks = students ? students.reduce((sum, student) => sum + student.openTasks, 0) : null;
  const openInterventions = data?.interventions ? data.interventions.filter((action) => OPEN_ACTION_STATES.has(action.state)) : null;
  const batchNames = students ? [...new Set(students.map((student) => student.units.batch).filter((name): name is string => Boolean(name)))] : [];
  const weekStart = startOfDay(Date.now());
  const thisWeek = data?.calendar ? data.calendar.filter((entry) => { const at = Date.parse(entry.startsAt); return at >= weekStart && at < weekStart + 7 * 86400000; }) : null;
  const tasks = data?.tasks ? orderActions(data.tasks) : null;

  return <IhPage eyebrow={institutionStudentScopeLabel(data?.myStudents?.scope) ?? null} title={title}
    summary="The students you teach, the tasks you set them and what is coming up this week."
    actions={<button type="button" className="pilot-btn" onClick={() => go(`${basePath}/assigned-tasks`)}><Icon name="plus" size={16} /> Assign a task</button>}>
    {!data ? <p role="status" className="ih-empty">Loading your teaching…</p> : null}
    <IhKpis items={[
      students !== null && { key: 'students', icon: 'students', value: <PeopleCount value={students.length} />, label: 'My students', note: batchNames.length && batchNames.length <= 2 ? batchNames.join(' · ') : null },
      openTasks !== null && { key: 'tasks', icon: 'tasks', value: <RecordCount value={openTasks} />, label: 'Open tasks', note: openTasks ? null : 'Nothing open' },
      data?.verification ? { key: 'verify', icon: 'verification', value: <RecordCount value={data.verification.pending} />, label: 'Awaiting verification', note: data.verification.pending ? null : 'Queue is clear', ...(data.verification.pending ? {} : { tone: 'ok' as const }) } : null,
      openInterventions !== null && { key: 'interventions', icon: 'interventions', value: <RecordCount value={openInterventions.length} />, label: openInterventions.length === 1 ? 'Active intervention' : 'Active interventions' },
      thisWeek !== null && { key: 'week', icon: 'calendar', value: <RecordCount value={thisWeek.length} />, label: 'This week', note: 'On your calendar' },
    ]} />
    <div className="ih-grid">
      {students ? <div className="ih-c8"><IhCard title="My Students" aside={students.length ? 'Sorted by name' : ''} link={{ label: 'View all', onClick: () => go(`${basePath}/my-students`) }}>
        {students.length ? <div className="ih-table-wrap"><table className="ih-table"><caption className="sr-only">My students</caption>
          <thead><tr><th scope="col">Student</th><th scope="col">Latest evidence</th><th scope="col" className="r">Status</th></tr></thead>
          <tbody>{students.slice(0, 8).map((student) => <tr key={student.profileId}>
            <th scope="row"><div className="ih-who"><IhAvatar name={student.fullName} /><div><b>{student.fullName}</b><small>{[student.units.batch, student.units.section].filter(Boolean).join(' · ') || student.institutionStudentId}</small></div></div></th>
            <td>{student.recentAssessments.latestTitle
              ? <><span>{student.recentAssessments.latestTitle}</span>{shortDate(student.recentAssessments.latestSubmittedAt) ? <small>Submitted {shortDate(student.recentAssessments.latestSubmittedAt)}</small> : null}</>
              : <span className="ih-muted">No assessment submitted in the last 30 days</span>}</td>
            <td className="r">{student.openTasks > 0 ? <span className="tag t-band"><i />{student.openTasks} {plural(student.openTasks, 'task', 'tasks')} open</span> : <span className="tag t-ok"><i />All done</span>}</td>
          </tr>)}</tbody></table></div>
          : <p className="ih-empty">No students are assigned to you yet.</p>}
        <IhNote icon="info">Latest evidence is the most recent assessment a student submitted in the last 30 days.</IhNote>
      </IhCard></div> : null}
      {data?.verification || (data?.notAttempted && data.notAttempted.length) ? <div className="ih-c4 ih-col">
        {data.verification ? <IhCard title="Academic verification" link={{ label: 'Review queue', onClick: () => go(`${basePath}/academic-verification`) }}>
          <VerificationBlock pending={data.verification.pending} />
        </IhCard> : null}
        {data.notAttempted && data.notAttempted.length ? <NeedsAttentionCard entries={data.notAttempted} onOpen={() => go(`${basePath}/assessments`)} /> : null}
      </div> : null}
      {tasks ? <div className="ih-c8"><IhCard title="Assigned Tasks" aside={tasks.length ? `${tasks.filter((task) => OPEN_ACTION_STATES.has(task.state)).length} open` : ''} link={{ label: 'All tasks', onClick: () => go(`${basePath}/assigned-tasks`) }}>
        {tasks.length ? <ActionList actions={tasks} /> : <p className="ih-empty">You have not set any tasks yet.</p>}
      </IhCard></div> : null}
      {openInterventions ? <div className="ih-c4"><IhCard title="Interventions" link={{ label: 'Open', onClick: () => go(`${basePath}/interventions`) }}>
        {openInterventions.length ? <ActionList actions={orderActions(openInterventions)} limit={3} /> : <p className="ih-empty">No intervention is open.</p>}
      </IhCard></div> : null}
      {data?.calendar ? <div className="ih-c8"><WeekCard entries={data.calendar} onOpen={() => go(`${basePath}/calendar`)} /></div> : null}
    </div>
  </IhPage>;
}

// --- Department head ------------------------------------------------------------

interface DepartmentHomeData {
  readonly overview: DepartmentOverviewDto | null;
  readonly verification: VerificationSummaryDto | null;
  readonly notAttempted: readonly NotAttempted[] | null;
  readonly pipeline: PlacementPipelineDto | null;
  readonly staff: DepartmentStaffDto | null;
  readonly interventions: readonly StaffActionSummaryDto[] | null;
  readonly meetings: readonly StaffActionSummaryDto[] | null;
  /** Every shared application in scope, or null when they run past one page (counts would then be partial). */
  readonly applications: readonly PlacementApplicationDto[] | null;
}

async function loadDepartmentHome(token: string, institutionId: string, signal: AbortSignal): Promise<DepartmentHomeData> {
  const [overview, verification, exams, pipeline, staff, interventions, meetings, applications] = await Promise.all([
    getDepartmentOverview(token, institutionId, signal).then(validOverview).catch(() => null),
    getVerificationSummary(token, institutionId, signal).then((response) => response?.summary ?? null).catch(() => null),
    listInstitutionExams(token, institutionId, signal).then((response) => (Array.isArray(response?.assessments) ? response.assessments : null)).catch(() => null),
    getPlacementPipeline(token, institutionId, signal).then((response) => (response && response.stages && Array.isArray(response.stages.cells) ? response : null)).catch(() => null),
    listDepartmentStaff(token, institutionId, signal).then((response) => (Array.isArray(response?.staff) ? response : null)).catch(() => null),
    listStaffActionSummaries(token, institutionId, 'INTERVENTION', signal).catch(() => null),
    listStaffActionSummaries(token, institutionId, 'MEETING', signal).catch(() => null),
    listPlacementApplications(token, institutionId, null, signal).then((page) => (Array.isArray(page?.applications) && !page.nextCursor ? page.applications : null)).catch(() => null),
  ]);
  const notAttempted = exams ? await loadNotAttempted(token, institutionId, exams, signal) : null;
  return { overview, verification, notAttempted, pipeline, staff, interventions, meetings, applications };
}

const pipelineStages: readonly (readonly [string, string])[] = [['APPLIED', 'Applied'], ['SHORTLISTED', 'Shortlisted'], ['INTERVIEW', 'Interview'], ['OFFER', 'Offer'], ['HIRED', 'Hired']];

/** The opportunities the department's students applied to and shared, with how many applied and how many hold an offer. */
function opportunityRows(applications: readonly PlacementApplicationDto[]): readonly { readonly key: string; readonly title: string; readonly employer: string; readonly applied: number; readonly offers: number }[] {
  const rows = new Map<string, { key: string; title: string; employer: string; applied: number; offers: number }>();
  for (const application of applications) {
    const key = `${application.employer.name}\u0000${application.opportunityTitle}`;
    const row = rows.get(key) ?? { key, title: application.opportunityTitle, employer: application.employer.name, applied: 0, offers: 0 };
    row.applied += 1;
    if (application.offer.exists) row.offers += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.applied - a.applied || a.title.localeCompare(b.title));
}

/**
 * The department head's home: the department's bands, people, placement and the work waiting on
 * them this week. The full breakdown stays on Department Overview, which this links to.
 */
export function DepartmentHeadHome({ authenticatedWorkspace, basePath, title }: HomeProps): React.ReactElement {
  const data = useHomeData(authenticatedWorkspace, loadDepartmentHome);
  const guard = workspaceGuard(title, authenticatedWorkspace);
  if (guard) return guard;
  const overview = data?.overview ?? null;
  const readiness = overview?.readiness.aggregate && overview.readiness.month ? overview.readiness : null;
  const ready = readiness && !readiness.aggregate!.suppressed ? bandCount(readiness.aggregate!, 'READY_FOR_NEXT_STEP') : null;
  const currentRanged = overview ? partitionNeedsRanges([overview.students.current, overview.students.onRoster - overview.students.current]) : false;
  const openInterventions = data?.interventions ? orderActions(data.interventions.filter((action) => OPEN_ACTION_STATES.has(action.state))) : null;
  const today = startOfDay(Date.now());
  const meetings = data?.meetings ? data.meetings.filter((meeting) => OPEN_ACTION_STATES.has(meeting.state) && meeting.scheduledStartAt && Date.parse(meeting.scheduledStartAt) >= today)
    .sort((a, b) => Date.parse(a.scheduledStartAt!) - Date.parse(b.scheduledStartAt!)) : null;
  const pipeline = data?.pipeline ?? null;
  const stageCell = (key: string) => (pipeline && !pipeline.stages.suppressed ? pipeline.stages.cells.find((cell) => cell.key === key) ?? null : null);
  const notShared = pipeline?.placementStatus && !pipeline.placementStatus.suppressed ? pipeline.placementStatus.cells.find((cell) => cell.key === 'NOT_SHARED') ?? null : null;
  const opportunities = data?.applications ? opportunityRows(data.applications) : null;

  return <IhPage eyebrow={institutionStudentScopeLabel(overview?.scope) ?? null} title={title}
    summary="Your department's students, the faculty who teach them and the placement season ahead."
    actions={<>
      <button type="button" className="pilot-btn ghost" onClick={() => go(`${basePath}/department-overview`)}><Icon name="departments" size={16} /> Department Overview</button>
      <button type="button" className="pilot-btn" onClick={() => go(`${basePath}/meetings`)}><Icon name="meetings" size={16} /> Schedule a meeting</button>
    </>}>
    {!data ? <p role="status" className="ih-empty">Loading your department…</p> : null}
    <IhKpis items={[
      overview && { key: 'students', icon: 'students', value: <PeopleCount value={overview.students.onRoster} />, label: 'Students', note: overview.batches.length ? `${overview.batches.length} ${plural(overview.batches.length, 'batch', 'batches')}` : null },
      overview && { key: 'current', icon: 'students', value: <PeopleCount value={overview.students.current} range={currentRanged} />, label: 'Enrolled now', note: 'Current relationship' },
      ready && { key: 'ready', icon: 'readiness', value: <SmallCount value={ready} />, label: 'Ready For Next Step', note: isSmallCount(ready) ? 'Too few to show' : 'Advisory band' },
      overview && { key: 'interventions', icon: 'interventions', value: <RecordCount value={overview.staffActions.openInterventions} />, label: overview.staffActions.openInterventions === 1 ? 'Open intervention' : 'Open interventions', note: `${overview.staffActions.openTasks} ${plural(overview.staffActions.openTasks, 'task', 'tasks')} open` },
      data?.verification ? { key: 'verify', icon: 'verification', value: <RecordCount value={data.verification.pending} />, label: 'Awaiting verification', note: data.verification.pending ? null : 'Queue is clear', ...(data.verification.pending ? {} : { tone: 'ok' as const }) } : null,
    ]} />
    <div className="ih-grid">
      {readiness ? <div className="ih-c8"><CohortBandsCard title="Cohort bands" aggregate={readiness.aggregate!} month={readiness.month}
        link={{ label: 'Readiness', onClick: () => go(`${basePath}/readiness`) }} /></div> : null}
      {data?.staff ? <div className={readiness ? 'ih-c4' : 'ih-c12'}><IhCard title="Faculty and staff" link={{ label: 'Manage', onClick: () => go(`${basePath}/faculty-and-staff`) }}>
        {data.staff.staff.length ? <ul className="ih-list">{data.staff.staff.slice(0, 5).map((member) => <li key={member.email + member.role} className="ih-li">
          <IhAvatar name={member.email} />
          <div className="ih-li-t"><b>{member.email}</b><small>{[roleLabel(member.role), member.department, member.batch].filter(Boolean).join(' · ')}</small></div>
          {member.assignments.length ? <span className="tag t-band"><i />{member.assignments.length} {plural(member.assignments.length, 'class', 'classes')}</span> : null}
        </li>)}</ul> : <p className="ih-empty">No staff are scoped to your department yet.</p>}
      </IhCard></div> : null}
      {pipeline ? <div className="ih-c8"><IhCard title="Placement pipeline" aside="From shared applications" link={{ label: 'Pipeline', onClick: () => go(`${basePath}/placement-pipeline`) }}>
        {pipeline.stages.suppressed ? <p className="ih-empty">Fewer than five applications have been shared in your department, so the stages are withheld.</p>
          : <IhTiles columns={5} tiles={pipelineStages.map(([key, label]) => ({ key, label, value: <SmallCount value={stageCell(key) ?? null} /> }))} />}
        <IhRows rows={[
          ['Students sharing applications', <SmallCount key="sharing" value={pipeline.studentsSharing} />],
          ...(notShared ? [['Students who have not shared applications', <SmallCount key="ns" value={notShared} />] as const] : []),
        ]} />
        <IhNote>Counted only from applications students chose to share. “Not shared” is never counted as unplaced.</IhNote>
      </IhCard></div> : null}
      {meetings ? <div className="ih-c4"><IhCard title="Meetings" link={{ label: 'Calendar', onClick: () => go(`${basePath}/meetings`) }}>
        {meetings.length ? <ul className="ih-list">{meetings.slice(0, 4).map((meeting) => {
          const at = new Date(meeting.scheduledStartAt!);
          return <li key={meeting.id} className="ih-li">
            <span className="ih-date"><b>{at.getDate()}</b><small>{at.toLocaleDateString('en-GB', { weekday: 'short' })}</small></span>
            <div className="ih-li-t"><b>{meeting.title}</b><small>{[shortTime(meeting.scheduledStartAt), meeting.studentName].filter(Boolean).join(' · ')}</small></div>
          </li>;
        })}</ul> : <p className="ih-empty">No meeting is scheduled.</p>}
      </IhCard></div> : null}
      {opportunities && opportunities.length ? <div className="ih-c8"><IhCard title="Opportunities and offers" aside="Shared by your students" link={{ label: 'All opportunities', onClick: () => go(`${basePath}/opportunities-and-offers`) }}>
        <div className="ih-table-wrap"><table className="ih-table"><caption className="sr-only">Opportunities and offers</caption>
          <thead><tr><th scope="col">Opportunity</th><th scope="col" className="r">Applied</th><th scope="col" className="r">Offers</th></tr></thead>
          <tbody>{opportunities.slice(0, 5).map((row) => <tr key={row.key}>
            <th scope="row"><div className="ih-who"><IhAvatar name={row.employer} /><div><b>{row.title}</b><small>{row.employer}</small></div></div></th>
            <td className="r num"><SmallCount value={row.applied} /></td><td className="r num"><SmallCount value={row.offers} /></td>
          </tr>)}</tbody></table></div>
        <IhNote>Offer pay is never shown. Employers see only the evidence a student chooses to share, never their band.</IhNote>
      </IhCard></div> : null}
      {openInterventions || (data?.notAttempted && data.notAttempted.length) ? <div className="ih-c4 ih-col">
        {openInterventions ? <IhCard title="Interventions" link={{ label: 'Open', onClick: () => go(`${basePath}/interventions`) }}>
          {openInterventions.length ? <ActionList actions={openInterventions} limit={3} /> : <p className="ih-empty">No intervention is open.</p>}
        </IhCard> : null}
        {data?.notAttempted && data.notAttempted.length ? <NeedsAttentionCard entries={data.notAttempted} onOpen={() => go(`${basePath}/assessments`)} /> : null}
      </div> : null}
    </div>
  </IhPage>;
}
