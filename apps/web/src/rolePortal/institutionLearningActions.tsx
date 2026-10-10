/**
 * ONE · Role portal — Institution — Faculty learning actions (INST-16), on the lecturer's existing
 * "Learning Resources" page (no navigation change, HG-3).
 *
 * Why it exists: the cohort view on My Students (INST-15) shows who is stuck and who has reviews due; this is
 * where the lecturer acts on it. They browse approved ONE content (published practice sets and lessons), assign
 * it to a class they teach or to selected students, plan a group session around it, or set one student's next
 * step with a reason. Each action is a constraint the learning planner honours — nothing here changes a
 * student's mastery, evidence or readiness. Everything comes from the server, already limited to the lecturer's
 * active teaching assignments; nothing is filtered here for security. A student's current plan is shown only
 * when the student has chosen to share their learning data; counts of people under five read "<5".
 */
import { useEffect, useState } from 'react';
import {
  ApiRequestError,
  createGroupSession,
  createLearningAssignment,
  createPlanOverride,
  getFacultyLearningActions,
  getProtectedAccessToken,
  getStudentLearningPlan,
  listLearningAssignmentStudents,
  listLearningResources,
  listMyStudents,
  suppressedCountLabel,
  withdrawLearningAssignment,
  withdrawPlanOverride,
} from '../api.js';
import type {
  FacultyLearningActionsDto,
  FacultyOverrideAction,
  LearningActionTarget,
  LearningContentKind,
  LearningResourceDto,
  LearningResourceRefDto,
  LearningResourcesPageDto,
  MyStudentDto,
  StudentLearningPlanDto,
} from '../api.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { REASON_TEXT } from '../studentLearning.js';
import { formatApiError } from './shared.js';
import type { AuthenticatedWorkspaceSummary } from './shared.js';
import { supportCodeSuffix } from '../supportCode.js';
import { formatDateTime } from '../dates.js';
import { NaValue } from '../naState.js';

export const OVERRIDE_REASON_LABELS: Readonly<Record<string, string>> = {
  CLASS_TOPIC_ALIGNMENT: 'Matches what the class is working on now',
  PREREQUISITE_FIRST: 'A prerequisite needs attention first',
  REVISIT_FUNDAMENTALS: 'Go back over the fundamentals',
  UPCOMING_ASSESSMENT: 'Preparation for an upcoming assessment',
  STUDENT_REQUEST: 'The student asked for it',
  FACULTY_JUDGEMENT: 'The lecturer’s judgement',
};
const WITHDRAW_LABELS: Readonly<Record<string, string>> = { NO_LONGER_NEEDED: 'No longer needed', SET_IN_ERROR: 'Set in error', REPLACED: 'Replaced by another' };
const ACTION_LABELS: Readonly<Record<string, string>> = {
  LEARN: 'Learn', PRACTICE: 'Practise', REVIEW: 'Review', REMEDIATE: 'Fix a mistake pattern', FOLLOW_ASSIGNMENT: 'Assigned work', NONE: 'Nothing planned',
};
const KIND_LABELS: Readonly<Record<LearningContentKind, string>> = { PRACTICE: 'Practice set', LESSON: 'Lesson' };
const STATE_LABELS: Readonly<Record<string, string>> = { PENDING: 'Waiting for the student', APPLIED: 'Used as their next step', WITHDRAWN: 'Withdrawn' };

const ERROR_TEXT: Readonly<Record<string, string>> = {
  SCOPE_REQUIRED: 'You need an active teaching assignment to do this. Ask your institution administrator to assign your classes.',
  UNIT_NOT_TAUGHT: 'Choose one of the classes you teach.',
  STUDENT_OUT_OF_SCOPE: 'Choose students from the classes you teach.',
  CONTENT_NOT_PUBLISHED: 'That content is no longer published, so it cannot be assigned. Reload the list.',
  OVERRIDE_PENDING: 'This student already has a next step set by a lecturer. Withdraw it first.',
  OVERRIDE_NOT_PENDING: 'That next step has already been used or withdrawn.',
  ASSIGNMENT_WITHDRAWN: 'That assignment was already withdrawn.',
  NO_STUDENTS: 'That class has no current students.',
  TOO_MANY_STUDENTS: 'At most 500 students at a time.',
  INVALID_REASON_CODE: 'Choose one of the listed reasons.',
};

function actionError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.code && ERROR_TEXT[error.code]) return `${ERROR_TEXT[error.code]}${supportCodeSuffix(error.correlationId)}`;
    if (error.status === 403) return `You do not have permission to do this.${supportCodeSuffix(error.correlationId)}`;
  }
  return formatApiError(error, fallback);
}

const refOf = (resource: LearningResourceRefDto): LearningResourceRefDto =>
  ({ kind: resource.kind, skillId: resource.skillId, lessonVersionId: resource.lessonVersionId });
const keyOf = (resource: LearningResourceRefDto): string => `${resource.kind}:${resource.skillId}:${resource.lessonVersionId ?? ''}`;
const when = (value: string): string => formatDateTime(value);

function isActions(value: unknown): value is FacultyLearningActionsDto {
  const body = value as Partial<FacultyLearningActionsDto> | null;
  return Boolean(body && typeof body.canAct === 'boolean' && Array.isArray(body.assignments) && Array.isArray(body.sessions)
    && Array.isArray(body.overrides) && Array.isArray(body.targets) && Array.isArray(body.overrideReasonCodes));
}
function isResources(value: unknown): value is LearningResourcesPageDto {
  const body = value as Partial<LearningResourcesPageDto> | null;
  return Boolean(body && Array.isArray(body.resources));
}

type Panel =
  | { readonly kind: 'assign'; readonly resource: LearningResourceDto | null; readonly skillId?: string; readonly profileIds?: readonly string[] }
  | { readonly kind: 'session'; readonly resource: LearningResourceDto | null }
  | { readonly kind: 'override'; readonly resource: LearningResourceDto | null; readonly profileId?: string };

/** What the cohort view (or a link) asked for, read once from the address. */
function initialPanel(): { panel: Panel | null; q: string } {
  try {
    const params = new URLSearchParams(window.location.search);
    const skill = params.get('skill') ?? undefined;
    const students = (params.get('students') ?? '').split(',').filter(Boolean);
    if (params.get('assign')) return { panel: { kind: 'assign', resource: null, ...(skill ? { skillId: skill } : {}), profileIds: students }, q: '' };
    if (params.get('override')) return { panel: { kind: 'override', resource: null, profileId: params.get('override') ?? '' }, q: '' };
    if (params.get('session')) return { panel: { kind: 'session', resource: null }, q: params.get('q') ?? '' };
  } catch { /* no address to read */ }
  return { panel: null, q: '' };
}

export function FacultyLearningActionsPage({ authenticatedWorkspace }: {
  readonly authenticatedWorkspace?: AuthenticatedWorkspaceSummary | undefined;
}): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const institutionId = authenticatedWorkspace?.organizationId ?? '';
  const isFaculty = authenticatedWorkspace?.role === 'FACULTY_LECTURER';
  const [initial] = useState(initialPanel);
  const [actions, setActions] = useState<FacultyLearningActionsDto | null>(null);
  const [resources, setResources] = useState<LearningResourcesPageDto | null>(null);
  const [query, setQuery] = useState(initial.q);
  const [kind, setKind] = useState<LearningContentKind | ''>('');
  const [panel, setPanel] = useState<Panel | null>(initial.panel);
  const [students, setStudents] = useState<readonly MyStudentDto[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token || !institutionId || !isFaculty) return;
    const controller = new AbortController();
    getFacultyLearningActions(token, institutionId, controller.signal)
      .then((body) => { if (isActions(body)) setActions(body); else setError('Unable to load your learning actions.'); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(actionError(cause, 'Unable to load your learning actions.')); });
    return () => controller.abort();
  }, [token, institutionId, isFaculty, reload]);

  useEffect(() => {
    if (!token || !institutionId || !isFaculty) return;
    const controller = new AbortController();
    listLearningResources(token, institutionId, { q: query, kind }, controller.signal)
      .then((body) => { if (isResources(body)) setResources(body); else setError('Unable to load learning resources.'); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(actionError(cause, 'Unable to load learning resources.')); });
    return () => controller.abort();
  }, [token, institutionId, isFaculty, query, kind]);

  // The students of the lecturer's classes, for choosing who an action is for (server-scoped).
  useEffect(() => {
    if (!token || !institutionId || !isFaculty || !panel || students) return;
    const controller = new AbortController();
    listMyStudents(token, institutionId, null, controller.signal)
      .then((body) => setStudents(Array.isArray(body?.students) ? body.students : []))
      .catch(() => { if (!controller.signal.aborted) setStudents([]); });
    return () => controller.abort();
  }, [token, institutionId, isFaculty, panel, students]);

  // A link from the cohort view names a skill: pick its practice set once the catalogue is here.
  useEffect(() => {
    if (panel?.kind !== 'assign' || panel.resource || !panel.skillId || !resources) return;
    const match = resources.resources.find((resource) => resource.kind === 'PRACTICE' && resource.skillId === panel.skillId);
    if (match) setPanel({ ...panel, resource: match });
  }, [panel, resources]);

  if (!token || !institutionId || !isFaculty) return null;

  async function moreResources(): Promise<void> {
    if (!resources?.nextCursor) return;
    try {
      const next = await listLearningResources(token!, institutionId, { q: query, kind, cursor: resources.nextCursor });
      if (isResources(next)) setResources({ resources: [...resources.resources, ...next.resources], nextCursor: next.nextCursor });
    } catch (cause) {
      setError(actionError(cause, 'Unable to load more resources.'));
    }
  }

  function done(message: string): void {
    setPanel(null); setNotice(message); setError(''); setReload((value) => value + 1);
  }

  const canAct = actions?.canAct ?? false;
  const open = actions ? actions.assignments.filter((assignment) => !assignment.withdrawn).length : null;
  const upcoming = actions ? actions.sessions.filter((session) => new Date(session.scheduledEndAt).getTime() > Date.now() && session.state !== 'CANCELLED').length : null;
  const pending = actions ? actions.overrides.filter((override) => override.state === 'PENDING').length : null;
  const choose = (next: Panel) => { setPanel(next); setNotice(''); setError(''); };

  return <section className="role-card role-wide" aria-label="Assign and plan learning">
    <div className="pilot-card-head"><h2>Assign and plan learning</h2></div>
    <p>Approved ONE content you can give your classes. What you assign comes up as your students’ next step; it never changes their results or readiness.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="v2-row v2-cols-4 career-stat-strip">
      <V2Stat icon="📚" tone="blue" value={resources ? `${resources.resources.length}${resources.nextCursor ? '+' : ''}` : 'NA'} label="Resources available" />
      <V2Stat icon="📝" tone="purple" value={open ?? 'NA'} label="Open assignments" />
      <V2Stat icon="👥" tone="green" value={upcoming ?? 'NA'} label="Upcoming group sessions" />
      <V2Stat icon="🧭" tone="amber" value={pending ?? 'NA'} label="Next steps waiting" />
    </div>
    {actions && !canAct ? <p>You need an active teaching assignment to assign work or change a student’s next step. Ask your institution administrator to assign your classes.</p> : null}

    <h3>Learning resources</h3>
    <form className="role-management-form" aria-label="Find resources" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); setQuery(String(data.get('q') ?? '').trim()); }}>
      <label><span>Search</span><input name="q" defaultValue={query} maxLength={100} placeholder="Skill or title" /></label>
      <label><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as LearningContentKind | '')}>
        <option value="">All</option><option value="PRACTICE">Practice sets</option><option value="LESSON">Lessons</option>
      </select></label>
      <div className="hiring-actions"><button type="submit" className="secondary">Search</button></div>
    </form>
    {!resources && !error ? <p role="status">Loading learning resources…</p> : null}
    {resources && resources.resources.length === 0 ? <V2EmptyState icon="📚" title="No published content yet"
      note="No practice set or lesson has been published in ONE for this search. Content appears here once it is reviewed and published." /> : null}
    {resources && resources.resources.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Learning resources</caption>
      <thead><tr><th scope="col">Resource</th><th scope="col">Kind</th><th scope="col">Skill</th><th scope="col">Actions</th></tr></thead>
      <tbody>{resources.resources.map((resource) => <tr key={keyOf(resource)}>
        <th scope="row">{resource.title}{resource.moduleTitle ? <span>{resource.moduleTitle}</span> : null}</th>
        <td>{KIND_LABELS[resource.kind]}{resource.questionCount !== null ? ` · ${resource.questionCount} questions` : ''}</td>
        <td>{resource.skillName}</td>
        <td><div className="hiring-actions">
          <button type="button" className="pilot-link" disabled={!canAct} onClick={() => choose({ kind: 'assign', resource })}>Assign</button>
          <button type="button" className="pilot-link" disabled={!canAct} onClick={() => choose({ kind: 'session', resource })}>Plan a group session</button>
          <button type="button" className="pilot-link" disabled={!canAct} onClick={() => choose({ kind: 'override', resource })}>Set as a student’s next step</button>
        </div></td>
      </tr>)}</tbody></table></div> : null}
    {resources?.nextCursor ? <div className="role-record-actions"><button type="button" className="secondary" onClick={() => void moreResources()}>Show more resources</button></div> : null}

    {panel && actions ? <ActionPanel key={`${panel.kind}:${panel.resource ? keyOf(panel.resource) : ''}`} panel={panel} actions={actions}
      resources={resources?.resources ?? []} students={students} token={token} institutionId={institutionId}
      onChoose={(resource) => setPanel({ ...panel, resource })} onCancel={() => setPanel(null)} onDone={done} /> : null}

    {actions ? <YourActions actions={actions} token={token} institutionId={institutionId} onChanged={done} /> : null}
  </section>;
}

// --- The three forms ------------------------------------------------------------------------------

function ActionPanel({ panel, actions, resources, students, token, institutionId, onChoose, onCancel, onDone }: {
  readonly panel: Panel; readonly actions: FacultyLearningActionsDto; readonly resources: readonly LearningResourceDto[];
  readonly students: readonly MyStudentDto[] | null; readonly token: string; readonly institutionId: string;
  readonly onChoose: (resource: LearningResourceDto) => void; readonly onCancel: () => void; readonly onDone: (message: string) => void;
}): React.ReactElement {
  const [targetKind, setTargetKind] = useState<'UNIT' | 'STUDENTS'>(panel.kind === 'assign' && panel.profileIds?.length ? 'STUDENTS' : 'UNIT');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(panel.kind === 'assign' ? panel.profileIds ?? [] : []));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resource = panel.resource;
  const title = panel.kind === 'assign' ? 'Assign to your students' : panel.kind === 'session' ? 'Plan a group session' : 'Set one student’s next step';

  function target(form: FormData): LearningActionTarget | null {
    if (targetKind === 'UNIT') {
      const unitId = String(form.get('unitId') ?? '');
      return unitId ? { unitId } : null;
    }
    return chosen.size ? { studentProfileIds: [...chosen] } : null;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!resource) { setError('Choose a resource first.'); return; }
    const form = new FormData(event.currentTarget);
    const note = String(form.get('note') ?? '').trim();
    setBusy(true); setError('');
    try {
      if (panel.kind === 'override') {
        const profileId = String(form.get('profileId') ?? '');
        const reasonCode = String(form.get('reasonCode') ?? '');
        if (!profileId || !reasonCode) { setError('Choose a student and a reason.'); return; }
        await createPlanOverride(token, institutionId, profileId, {
          action: String(form.get('action') ?? 'PRACTICE') as FacultyOverrideAction, resource: refOf(resource), reasonCode, ...(note ? { note } : {}),
        });
        onDone('Next step set. The student has been told, and it starts when they plan their next step.');
        return;
      }
      const chosenTarget = target(form);
      if (!chosenTarget) { setError('Choose a class or at least one student.'); return; }
      if (panel.kind === 'assign') {
        const created = await createLearningAssignment(token, institutionId, { resource: refOf(resource), ...chosenTarget, ...(note ? { note } : {}) });
        onDone(`Assigned to ${created.assignment.students} ${created.assignment.students === 1 ? 'student' : 'students'}. They have been told.`);
        return;
      }
      const start = String(form.get('start') ?? ''); const end = String(form.get('end') ?? '');
      const sessionTitle = String(form.get('title') ?? '').trim();
      if (!sessionTitle || !start || !end) { setError('Give the session a title, a start and an end.'); return; }
      const created = await createGroupSession(token, institutionId, {
        title: sessionTitle, scheduledStartAt: new Date(start).toISOString(), scheduledEndAt: new Date(end).toISOString(),
        resources: [refOf(resource)], ...chosenTarget, ...(note ? { note } : {}),
      });
      onDone(`Group session planned for ${created.session.attendees} ${created.session.attendees === 1 ? 'student' : 'students'}. It is on your Calendar.`);
    } catch (cause) {
      setError(actionError(cause, 'That could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (profileId: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(profileId)) next.delete(profileId); else next.add(profileId);
    return next;
  });

  return <form className="role-management-form" aria-label={title} onSubmit={(event) => { void submit(event); }}>
    <h3>{title}</h3>
    {resource ? <p>Resource: <strong>{resource.title}</strong> ({KIND_LABELS[resource.kind]} · {resource.skillName})</p>
      : <label><span>Resource</span><select defaultValue="" onChange={(event) => { const found = resources.find((item) => keyOf(item) === event.target.value); if (found) onChoose(found); }}>
        <option value="">Choose a resource</option>
        {resources.map((item) => <option key={keyOf(item)} value={keyOf(item)}>{item.title} ({KIND_LABELS[item.kind]})</option>)}
      </select></label>}
    {panel.kind === 'session' ? <>
      <label><span>Title</span><input name="title" maxLength={200} defaultValue={resource ? `Group session: ${resource.skillName}` : ''} /></label>
      <label><span>Starts</span><input name="start" type="datetime-local" /></label>
      <label><span>Ends</span><input name="end" type="datetime-local" /></label>
    </> : null}
    {panel.kind === 'override' ? <OverrideFields panel={panel} actions={actions} students={students} token={token} institutionId={institutionId} onChanged={onDone} />
      : <fieldset>
        <legend>Who it is for</legend>
        <label><input type="radio" name="targetKind" checked={targetKind === 'UNIT'} onChange={() => setTargetKind('UNIT')} /> A class you teach</label>
        <label><input type="radio" name="targetKind" checked={targetKind === 'STUDENTS'} onChange={() => setTargetKind('STUDENTS')} /> Selected students</label>
        {targetKind === 'UNIT' ? (actions.targets.length
          ? <label><span>Class</span><select name="unitId" defaultValue={actions.targets[0]?.unitId ?? ''}>
            {actions.targets.map((unit) => <option key={unit.unitId} value={unit.unitId}>{unit.name}</option>)}</select></label>
          : <p>You have no active teaching assignment, so there is no class to choose.</p>)
          : students === null ? <p role="status">Loading your students…</p>
            : students.length === 0 ? <p>No students are in your classes.</p>
              : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Your students</caption>
                <thead><tr><th scope="col">Choose</th><th scope="col">Student</th><th scope="col">Roll number</th></tr></thead>
                <tbody>{students.map((student) => <tr key={student.profileId}>
                  <td><input type="checkbox" aria-label={`Choose ${student.fullName}`} checked={chosen.has(student.profileId)} onChange={() => toggle(student.profileId)} /></td>
                  <td>{student.fullName}</td><td>{student.institutionStudentId}</td></tr>)}</tbody></table></div>}
      </fieldset>}
    <label><span>{panel.kind === 'session' ? 'Note for staff (optional; students do not see it)' : 'Note to the student (optional)'}</span><textarea name="note" maxLength={panel.kind === 'session' ? 2000 : 500} /></label>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="hiring-actions">
      <button type="submit" disabled={busy || !resource}>{panel.kind === 'assign' ? 'Assign' : panel.kind === 'session' ? 'Plan the session' : 'Set next step'}</button>
      <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

/** The override's student, their plan (only with their consent), action and reason. */
function OverrideFields({ panel, actions, students, token, institutionId, onChanged }: {
  readonly panel: Extract<Panel, { kind: 'override' }>; readonly actions: FacultyLearningActionsDto; readonly students: readonly MyStudentDto[] | null;
  readonly token: string; readonly institutionId: string; readonly onChanged: (message: string) => void;
}): React.ReactElement {
  const [profileId, setProfileId] = useState(panel.profileId ?? '');
  const [plan, setPlan] = useState<StudentLearningPlanDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!profileId) { setPlan(null); return undefined; }
    const controller = new AbortController();
    setPlan(null); setError('');
    getStudentLearningPlan(token, institutionId, profileId, controller.signal)
      .then((body) => { if (body && typeof body.consent?.held === 'boolean') setPlan(body); else setError('Unable to load this student’s plan.'); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(actionError(cause, 'Unable to load this student’s plan.')); });
    return () => controller.abort();
  }, [token, institutionId, profileId]);

  async function lift(reasonCode: string): Promise<void> {
    if (!plan?.pendingOverride || !reasonCode) return;
    try {
      await withdrawPlanOverride(token, institutionId, plan.pendingOverride.id, reasonCode);
      onChanged('The waiting next step was withdrawn.');
    } catch (cause) {
      setError(actionError(cause, 'That could not be withdrawn.'));
    }
  }

  return <>
    <label><span>Student</span><select name="profileId" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
      <option value="">Choose a student</option>
      {(students ?? []).map((student) => <option key={student.profileId} value={student.profileId}>{student.fullName} ({student.institutionStudentId})</option>)}
    </select></label>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {plan ? <div aria-label="Current plan">
      <h4>Their current next step</h4>
      {!plan.consent.offered ? <p>NA — students have not yet been asked whether to share their learning data, so their plan is not shown.</p>
        : !plan.consent.held ? <p>NA — this student has not chosen to share their learning data, so their plan is not shown.</p>
          : plan.latestStep ? <p><strong>{ACTION_LABELS[plan.latestStep.action] ?? 'Step'}{plan.latestStep.skillName ? `: ${plan.latestStep.skillName}` : ''}</strong>
            {' — '}{plan.latestStep.reasonCodes.map((code) => REASON_TEXT[code] ?? 'A rule of their plan chose it.').join(' ')}</p>
            : <p>No step planned yet.</p>}
      {plan.pendingOverride ? <div>
        <p>A next step set by a lecturer is waiting: {ACTION_LABELS[plan.pendingOverride.action]} {plan.pendingOverride.resource.title} — {OVERRIDE_REASON_LABELS[plan.pendingOverride.reasonCode] ?? 'NA'}.</p>
        <label><span>Withdraw it</span><select aria-label="Withdraw the waiting next step" defaultValue="" onChange={(event) => { void lift(event.target.value); }}>
          <option value="">Choose a reason to withdraw</option>
          {actions.withdrawReasonCodes.map((code) => <option key={code} value={code}>{WITHDRAW_LABELS[code] ?? code}</option>)}
        </select></label>
      </div> : null}
    </div> : null}
    <label><span>Next step</span><select name="action" defaultValue="PRACTICE">
      {actions.overrideActions.map((action) => <option key={action} value={action}>{ACTION_LABELS[action] ?? action}</option>)}
    </select></label>
    <label><span>Reason</span><select name="reasonCode" defaultValue="">
      <option value="">Choose a reason</option>
      {actions.overrideReasonCodes.map((code) => <option key={code} value={code}>{OVERRIDE_REASON_LABELS[code] ?? code}</option>)}
    </select></label>
  </>;
}

// --- What the lecturer has set ------------------------------------------------------------------------

function YourActions({ actions, token, institutionId, onChanged }: {
  readonly actions: FacultyLearningActionsDto; readonly token: string; readonly institutionId: string; readonly onChanged: (message: string) => void;
}): React.ReactElement {
  const [roster, setRoster] = useState<{ id: string; rows: readonly { profileId: string; fullName: string; rollNumber: string; status: 'DONE' | 'NOT_YET' }[] } | null>(null);
  const [error, setError] = useState('');

  async function show(id: string): Promise<void> {
    try {
      const body = await listLearningAssignmentStudents(token, institutionId, id);
      setRoster({ id, rows: Array.isArray(body?.students) ? body.students : [] });
    } catch (cause) {
      setError(actionError(cause, 'Unable to load who it reached.'));
    }
  }
  async function withdraw(kind: 'assignment' | 'override', id: string, reasonCode: string): Promise<void> {
    if (!reasonCode) return;
    try {
      if (kind === 'assignment') await withdrawLearningAssignment(token, institutionId, id, reasonCode);
      else await withdrawPlanOverride(token, institutionId, id, reasonCode);
      onChanged(kind === 'assignment' ? 'Assignment withdrawn.' : 'The waiting next step was withdrawn.');
    } catch (cause) {
      setError(actionError(cause, 'That could not be withdrawn.'));
    }
  }
  const withdrawSelect = (kind: 'assignment' | 'override', id: string, label: string) =>
    <select aria-label={label} defaultValue="" onChange={(event) => { void withdraw(kind, id, event.target.value); }}>
      <option value="">Withdraw…</option>
      {actions.withdrawReasonCodes.map((code) => <option key={code} value={code}>{WITHDRAW_LABELS[code] ?? code}</option>)}
    </select>;

  return <>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <h3>Your assignments</h3>
    {actions.assignments.length === 0 ? <p>You have not assigned anything yet.</p>
      : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Your assignments</caption>
        <thead><tr><th scope="col">Resource</th><th scope="col">For</th><th scope="col">Students</th><th scope="col">Done</th><th scope="col">Action</th></tr></thead>
        <tbody>{actions.assignments.map((assignment) => <tr key={assignment.id}>
          <th scope="row">{assignment.resource.title}<span>{KIND_LABELS[assignment.resource.kind]} · {when(assignment.assignedAt)}</span></th>
          <td>{assignment.target.kind === 'UNIT' ? assignment.target.unitName ?? 'A class' : 'Selected students'}</td>
          <td>{assignment.students}</td>
          <td><NaValue value={assignment.withdrawn ? 'Withdrawn' : suppressedCountLabel(assignment.done)} /></td>
          <td><div className="hiring-actions">
            <button type="button" className="pilot-link" onClick={() => void show(assignment.id)}>Who it reached</button>
            {assignment.withdrawn ? null : withdrawSelect('assignment', assignment.id, `Withdraw ${assignment.resource.title}`)}
          </div></td>
        </tr>)}</tbody></table></div>}
    {roster ? <div className="role-record-table-wrap"><table className="role-record-table"><caption>Who it reached</caption>
      <thead><tr><th scope="col">Student</th><th scope="col">Roll number</th><th scope="col">Status</th></tr></thead>
      <tbody>{roster.rows.map((row) => <tr key={row.profileId}><th scope="row">{row.fullName}</th><td>{row.rollNumber}</td><td>{row.status === 'DONE' ? 'Done' : 'Not yet'}</td></tr>)}</tbody>
    </table></div> : null}

    <h3>Your group sessions</h3>
    {actions.sessions.length === 0 ? <p>You have not planned a group session yet.</p>
      : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Your group sessions</caption>
        <thead><tr><th scope="col">Session</th><th scope="col">When</th><th scope="col">Covers</th><th scope="col">Invited</th></tr></thead>
        <tbody>{actions.sessions.map((session) => <tr key={session.id}>
          <th scope="row">{session.title}{session.state === 'CANCELLED' ? <span>Cancelled</span> : null}</th>
          <td>{when(session.scheduledStartAt)}</td>
          <td>{session.content.map((item) => item.title).join(', ') || 'NA'}</td>
          <td>{session.attendees}</td>
        </tr>)}</tbody></table></div>}

    <h3>Next steps you set</h3>
    {actions.overrides.length === 0 ? <p>You have not set a student’s next step yet.</p>
      : <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Next steps you set</caption>
        <thead><tr><th scope="col">Student</th><th scope="col">Next step</th><th scope="col">Reason</th><th scope="col">Status</th></tr></thead>
        <tbody>{actions.overrides.map((override) => <tr key={override.id}>
          <th scope="row">{override.student ? `${override.student.fullName} (${override.student.rollNumber})` : 'No longer in your classes'}</th>
          <td>{ACTION_LABELS[override.action]} {override.resource.title}</td>
          <td>{OVERRIDE_REASON_LABELS[override.reasonCode] ?? 'NA'}</td>
          <td>{STATE_LABELS[override.state] ?? override.state}
            {override.state === 'PENDING' && override.student ? <> {withdrawSelect('override', override.id, `Withdraw next step for ${override.student.fullName}`)}</> : null}</td>
        </tr>)}</tbody></table></div>}
  </>;
}
