import React, { useEffect, useRef, useState } from 'react';
import { StudentHomeView, type StudentHomeData } from './studentHomeSections.js';
import { completeStudentStaffAction, getCurrentStudent, listStudentStaffActions, type StudentStaffActionDto } from './api/student.js';
import { SharedCounsellingNotes } from './studentCounsellingNotes.js';
import { formatDateTime } from './dates.js';
import {
  getLearnerCareerReadinessState,
  getProtectedAccessToken,
  getStudentActivity,
  getStudentProfile,
  listCalendar,
  listMyNotifications,
  listStudentApplications,
  listStudentExams,
  type LearnerCareerReadinessState,
  type StudentApplicationDto,
  type StudentExamDto,
} from './api.js';

/**
 * The student (and graduate) home: data loading, the college's support items and the reports.
 * What the home draws is in ./studentHomeSections.tsx, on the approved Momentum layout. The
 * standing rule (owner decision, 2026-10-10): a block renders only when its data exists, and
 * never "NA", a made-up 0 or a sample in its place. Advisory readiness stays banded and never
 * employer-visible.
 */

function prettify(code: string): string {
  return code.replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\w/g, (char) => char.toUpperCase());
}

const READINESS_BANDS = ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP'] as const;

interface DashboardData {
  readonly learner: LearnerCareerReadinessState | null;
  readonly exams: readonly StudentExamDto[] | null;
  readonly applications: readonly StudentApplicationDto[] | null;
}

/**
 * The readiness explanation names the evidence count and the internal model that
 * evaluated it ("4 active evidence records evaluated by career-readiness-mastery-v1").
 * The card already shows the count, and a model id means nothing to a student, so that
 * form is dropped; any other explanation is shown as written.
 */
export function plainFactorExplanation(explanation: string | null | undefined): string | null {
  if (!explanation) return null;
  if (/\bevaluated by [\w.-]+\s*\.?$/i.test(explanation)) return null;
  return explanation;
}

function readable(value: string | null | undefined): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function ReportDate({ value }: { readonly value: string | null | undefined }): React.ReactElement {
  if (!readable(value)) return <>Date not recorded</>;
  return <time dateTime={value}>{formatDateTime(value)}</time>;
}

/** "Label: date" pairs with an unreadable date left out; nothing at all when none can be read. */
function ReportDates({ dates }: { readonly dates: readonly (readonly [string, string | null | undefined])[] }): React.ReactElement | null {
  const shown = dates.filter(([, value]) => readable(value));
  if (!shown.length) return null;
  return <p>{shown.map(([label, value], index) => <React.Fragment key={label}>{index ? ' · ' : ''}{label}: <ReportDate value={value} /></React.Fragment>)}</p>;
}

function reportState(value: string | undefined, allowed: readonly string[]): string {
  return value && allowed.includes(value) ? prettify(value) : 'Status unavailable';
}

function StudentReports({ learner, exams, applications }: Pick<DashboardData, 'learner' | 'exams' | 'applications'>): React.ReactElement {
  const history = learner?.readinessHistory ?? [];
  const lessonTitles = new Map((learner?.catalog?.modules ?? []).flatMap((module) =>
    (module.lessons ?? []).map((lesson) => [lesson.id, lesson.title] as const)));
  const topicNames = new Map((learner?.catalog?.topics ?? []).map((topic) => [topic.id, topic.name]));

  return <section aria-labelledby="student-reports-title">
    <div className="pilot-page-head"><div>
      <h2 id="student-reports-title">Your Reports</h2>
      <p>Your recorded learning, assessment and application activity. Readiness is advisory and is never shared with employers.</p>
    </div></div>
    <section className="pilot-card" aria-labelledby="report-readiness-title">
      <h3 id="report-readiness-title">Readiness over time</h3>
      <p>Your 100 most recent readiness steps, newest first. Each step is a band, not a score.</p>
      <p>Not Enough Evidence · Developing · Progressing · Ready For Next Step</p>
      {history.length ? <ol className="pilot-list" aria-label="Readiness band history, newest first">
        {history.map((point, index) => {
          const previous = history[index + 1];
          const modelChanged = previous && point.modelVersionId && previous.modelVersionId
            && point.modelVersionId !== previous.modelVersionId;
          return <li key={point.id} className="pilot-list-row">
            <div className="grow">
              <strong><ReportDate value={point.generatedAt} /></strong>
              <span className="pilot-chip blue">{reportState(point.band, READINESS_BANDS)}</span>
              {modelChanged ? <p>Model version changed since the previous snapshot. Bands across this change are not comparable.</p> : null}
              {!point.modelVersionId || (previous && !previous.modelVersionId)
                ? <p>Model version unavailable; comparison unavailable.</p> : null}
            </div>
          </li>;
        })}
      </ol> : <p>No readiness history recorded yet.</p>}
    </section>
    <div className="pilot-row cols-2">
      <section className="pilot-card" aria-labelledby="report-learning-title">
        <h3 id="report-learning-title">Learning progress</h3>
        {learner?.progress?.length ? <ul className="pilot-list" aria-label="Recorded lesson progress">
          {learner.progress.map((item) => <li key={item.lessonVersionId} className="pilot-list-row"><div className="grow">
            <strong>{lessonTitles.get(item.lessonVersionId) ?? 'Lesson title unavailable'}</strong>
            <span className="pilot-chip slate">{reportState(item.state, ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'])}</span>
            <ReportDates dates={[['Started', item.startedAt], ['Completed', item.completedAt]]} />
          </div></li>)}
        </ul> : <p>No lesson progress recorded yet.</p>}
      </section>
      <section className="pilot-card" aria-labelledby="report-evidence-title">
        <h3 id="report-evidence-title">Learning evidence</h3>
        {learner?.evidence?.length ? <ul className="pilot-list" aria-label="Recorded learning evidence">
          {learner.evidence.map((item) => <li key={item.id} className="pilot-list-row"><div className="grow">
            <strong>{topicNames.get(item.topicId) ?? 'Topic name unavailable'}</strong>
            <ReportDates dates={[['Recorded', item.occurredAt]]} />
          </div></li>)}
        </ul> : <p>No learning evidence recorded yet.</p>}
      </section>
    </div>
    <section className="pilot-card" aria-labelledby="report-assessments-title">
      <h3 id="report-assessments-title">Assessment activity</h3>
      <h4>Career-readiness attempts</h4>
      {learner?.attempts?.length ? <ul className="pilot-list" aria-label="Career-readiness assessment attempts">
        {learner.attempts.map((item) => <li key={item.id} className="pilot-list-row"><div className="grow">
          <strong>{reportState(item.state, ['IN_PROGRESS', 'SUBMITTED', 'EXPIRED', 'VOIDED'])}</strong>
          <ReportDates dates={[['Started', item.startedAt], ['Submitted', item.submittedAt]]} />
        </div></li>)}
      </ul> : <p>No career-readiness attempts recorded yet.</p>}
      <h4>Assigned assessments</h4>
      <p>Up to 100 of your assigned assessments, by start date. Attempts used does not count an attempt still in progress.</p>
      {exams?.length ? <ul className="pilot-list" aria-label="Assigned assessment activity">
        {exams.map((exam) => <li key={exam.id} className="pilot-list-row"><div className="grow">
          <strong>{exam.title || 'Assessment title unavailable'}</strong>
          {Number.isFinite(exam.attemptsUsed) && Number.isFinite(exam.attemptsAllowed)
            ? <p>Attempts used: {exam.attemptsUsed} · Allowed: {exam.attemptsAllowed}</p> : null}
          <span className="pilot-chip slate">{exam.openAttemptId ? 'In progress'
            : exam.latestResult ? 'Published result available' : 'No published result available'}</span>
        </div></li>)}
      </ul> : <p>No assigned assessment activity recorded yet.</p>}
    </section>
    <section className="pilot-card" aria-labelledby="report-applications-title">
      <h3 id="report-applications-title">Application activity</h3>
      <p>Your 200 most recently updated applications, newest first.</p>
      {applications?.length ? <ul className="pilot-list" aria-label="Your application activity">
        {applications.map((item) => <li key={item.id} className="pilot-list-row"><div className="grow">
          <strong>{item.title || 'Role title unavailable'}</strong>
          {item.employerName ? <p>{item.employerName}</p> : null}
          <span className="pilot-chip slate">{reportState(item.state,
            ['DRAFT', 'APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'])}</span>
          <ReportDates dates={[['Submitted', item.submittedAt], ['Updated', item.updatedAt]]} />
        </div></li>)}
      </ul> : <p>No application activity recorded yet.</p>}
    </section>
  </section>;
}

const SUPPORT_ROLES: Readonly<Record<string, string>> = {
  PLACEMENT_ADMIN: 'Placement Officer', INSTITUTION_ADMIN: 'Institution Administrator',
  DEPARTMENT_HEAD: 'Department Head', FACULTY_LECTURER: 'Faculty Lecturer', INSTITUTION_OWNER: 'Institution Owner',
};
const SUPPORT_STATES: Readonly<Record<string, string>> = {
  DRAFT: 'Draft', UNDER_REVIEW: 'Under review', CHANGES_REQUESTED: 'Changes requested', APPROVED: 'Approved',
  OPEN: 'Open', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', REJECTED: 'Rejected', CANCELLED: 'Cancelled', ARCHIVED: 'Archived',
};

function StudentSupport({ token }: { readonly token: string | null }): React.ReactElement {
  const [view, setView] = useState<{ institutionId: string; actions: readonly StudentStaffActionDto[]; loading: boolean; unavailable: boolean }>({
    institutionId: '', actions: [], loading: true, unavailable: false,
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const completing = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    async function load(): Promise<void> {
      try {
        if (!token) throw new Error('No student session');
        // Resolve the institution from the protected profile, not a URL or a staff-selected scope.
        const { student } = await getCurrentStudent(token, controller.signal);
        if (!student?.institutionId) throw new Error('No student institution');
        const { actions } = await listStudentStaffActions(token, student.institutionId, controller.signal);
        if (!controller.signal.aborted) setView({ institutionId: student.institutionId, actions, loading: false, unavailable: false });
      } catch {
        if (!controller.signal.aborted) setView({ institutionId: '', actions: [], loading: false, unavailable: true });
      }
    }
    void load();
    return () => controller.abort();
  }, [token]);

  async function complete(action: StudentStaffActionDto): Promise<void> {
    const signal = request.current?.signal;
    if (!token || !view.institutionId || !signal || signal.aborted || completing.current || action.canComplete !== true) return;
    completing.current = true;
    setBusy(true);
    setNotice('');
    let saved = false;
    try {
      await completeStudentStaffAction(token, action.id, { version: action.version, responseNote: notes[action.id] ?? '' }, signal);
      saved = true;
    } catch {
      // A failed or stale write never becomes a local success, and upstream error text stays private.
    }
    if (signal.aborted) return;
    try {
      const { actions } = await listStudentStaffActions(token, view.institutionId, signal);
      if (signal.aborted) return;
      setView({ ...view, actions, unavailable: false });
      setNotice(saved ? 'Completion saved.' : 'Completion could not be confirmed. Review the refreshed item before trying again.');
      if (saved) setNotes((previous) => ({ ...previous, [action.id]: '' }));
    } catch {
      if (signal.aborted) return;
      setView({ ...view, actions: [], unavailable: true });
      setNotice(saved ? 'Completion saved. Support could not be refreshed.' : 'Completion could not be confirmed. Please reload the page before trying again.');
    } finally {
      completing.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  return <section className="pilot-card" aria-labelledby="student-support-title">
    <div className="pilot-card-head"><h2 id="student-support-title">Support</h2></div>
    <p>Tasks and interventions your college has assigned to you.</p>
    {notice ? <p role="status">{notice}</p> : null}
    {view.loading ? <p role="status">Loading your support…</p> : view.actions.length ? <ul className="pilot-list" aria-label="Assigned support items">
      {view.actions.map((action) => {
        const role = Object.hasOwn(SUPPORT_ROLES, action.assignerRole) ? SUPPORT_ROLES[action.assignerRole] : null;
        const state = Object.hasOwn(SUPPORT_STATES, action.state) ? SUPPORT_STATES[action.state] : 'Status unavailable';
        const kind = action.actionType === 'ASSIGNED_TASK' ? 'Assigned task' : action.actionType === 'INTERVENTION' ? 'Intervention' : null;
        return <li key={action.id} className="pilot-list-row"><div className="grow">
          <h3>{action.title || 'Untitled item'}</h3>
          {kind ? <p>{kind}</p> : null}
          <p>{role ? `Assigned by your ${role}` : 'Assigned by your college'}</p>
          {/* No due date is said plainly rather than shown as a placeholder. */}
          <p>{action.dueAt && Number.isFinite(Date.parse(action.dueAt))
            ? <>Due: <time dateTime={action.dueAt}>{formatDateTime(action.dueAt)}</time></> : 'No due date set'}</p>
          <p>State: <span className="pilot-chip slate">{state}</span></p>
          {action.note ? <p>{action.note}</p> : null}
          {action.responseNote ? <p>Your response: {action.responseNote}</p> : null}
          {action.canComplete === true ? <form onSubmit={(event) => { event.preventDefault(); void complete(action); }} aria-label={`Complete ${action.title}`}>
            <label className="pilot-field"><span>Response note for {action.title} (optional)</span>
              <textarea maxLength={2000} rows={3} value={notes[action.id] ?? ''} disabled={busy}
                onChange={(event) => setNotes((previous) => ({ ...previous, [action.id]: event.target.value }))} />
            </label>
            <button type="submit" className="pilot-btn primary small" disabled={busy}>{busy ? 'Saving…' : 'Mark complete'}</button>
          </form> : <p>Read-only — no student action is available for this item.</p>}
        </div></li>;
      })}
    </ul> : <p>{view.unavailable ? 'No support items are available right now.' : 'Nothing has been assigned to you yet.'}</p>}
    {/* INST-11: only notes the college explicitly shared; staff-only notes never reach this read. */}
    {token && view.institutionId ? <SharedCounsellingNotes token={token} institutionId={view.institutionId} /> : null}
  </section>;
}

export function StudentDashboardV3({ studentName }: { readonly studentName: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<StudentHomeData | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void Promise.all([
      getStudentProfile(token, controller.signal).then((response) => response.profile).catch(() => null),
      getLearnerCareerReadinessState(token, controller.signal).catch(() => null),
      listStudentExams(token, controller.signal).then((response) => response.assessments).catch(() => null),
      listMyNotifications(token, controller.signal).catch(() => null),
      getStudentActivity(token, controller.signal).catch(() => null),
      listStudentApplications(token, controller.signal).then((response) => response.applications).catch(() => null),
      // The same calendar the Calendar page reads; Up next shows its first future entry.
      listCalendar(token, controller.signal).then((response) => (Array.isArray(response.entries) ? response.entries : null)).catch(() => null),
    ]).then(([profile, learner, exams, notifications, activity, applications, calendar]) => {
      if (!controller.signal.aborted) setData({ profile, learner, exams, notifications, activity, applications, calendar });
    });
    return () => controller.abort();
  }, [token]);

  if (!data) return <section className="card wide-card"><h2>Student Dashboard</h2><p>Loading your workspace…</p></section>;

  return <div className="pilot pilot-embed sh-page">
    <StudentHomeView studentName={studentName} data={data} now={Date.now()} factorText={plainFactorExplanation}
      support={<StudentSupport key={token} token={token} />} />
    <StudentReports learner={data.learner} exams={data.exams} applications={data.applications} />
  </div>;
}
