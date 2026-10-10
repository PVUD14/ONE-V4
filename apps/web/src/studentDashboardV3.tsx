import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons/Icon.js';
import { Spark, toneColor, toneMix } from './pilot/pilotComponents.js';
import { ReadinessBand, toReadinessBand } from './momentum/readinessBand.js';
import { NaSlotChip, NaSlotStrip } from './naState.js';
import { completeStudentStaffAction, getCurrentStudent, listStudentStaffActions, type StudentStaffActionDto } from './api/student.js';
import { SharedCounsellingNotes } from './studentCounsellingNotes.js';
import { formatDateTime } from './dates.js';
import {
  getLearnerCareerReadinessState,
  getProtectedAccessToken,
  getStudentActivity,
  getStudentProfile,
  listMyNotifications,
  listStudentApplications,
  listStudentExams,
  type LearnerCareerReadinessState,
  type StudentActivityDto,
  type StudentApplicationDto,
  type StudentExamDto,
  type StudentProfileDto,
  type UserNotificationDto,
} from './api.js';

/**
 * Version 3 student dashboard: the pilot's dashboard composition reproduced
 * exactly, fed by real data. The standing rule: never invent a number, never
 * drop a pilot widget - a widget whose engine does not exist yet renders an
 * explicit NA (or 0) in the same visual slot. Advisory readiness stays
 * banded and never employer-visible.
 */

function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function prettify(code: string): string {
  return code.replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\w/g, (char) => char.toUpperCase());
}

function relativeWhen(iso: string): string {
  const deltaMs = Date.now() - Date.parse(iso);
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

const READINESS_BANDS = ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP'] as const;
const NA_COURSE_TONES = ['blue', 'purple', 'teal', 'green'] as const;

interface DashboardData {
  readonly profile: StudentProfileDto | null;
  readonly learner: LearnerCareerReadinessState | null;
  readonly exams: readonly StudentExamDto[] | null;
  readonly notifications: { readonly notifications: readonly UserNotificationDto[]; readonly unreadCount: number } | null;
  readonly activity: StudentActivityDto | null;
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

function ReportDate({ value }: { readonly value: string | null | undefined }): React.ReactElement {
  if (!value || !Number.isFinite(Date.parse(value))) return <>NA</>;
  return <time dateTime={value}>{formatDateTime(value)}</time>;
}

function reportState(value: string | undefined, allowed: readonly string[]): string {
  return value && allowed.includes(value) ? prettify(value) : 'NA';
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
      </ol> : <p>NA — no readiness history available.</p>}
    </section>
    <div className="pilot-row cols-2">
      <section className="pilot-card" aria-labelledby="report-learning-title">
        <h3 id="report-learning-title">Learning progress</h3>
        {learner?.progress?.length ? <ul className="pilot-list" aria-label="Recorded lesson progress">
          {learner.progress.map((item) => <li key={item.lessonVersionId} className="pilot-list-row"><div className="grow">
            <strong>{lessonTitles.get(item.lessonVersionId) ?? 'NA'}</strong>
            <span className="pilot-chip slate">{reportState(item.state, ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'])}</span>
            <p>Started: <ReportDate value={item.startedAt} /> · Completed: <ReportDate value={item.completedAt} /></p>
          </div></li>)}
        </ul> : <p>NA — no recorded lesson progress available.</p>}
      </section>
      <section className="pilot-card" aria-labelledby="report-evidence-title">
        <h3 id="report-evidence-title">Learning evidence</h3>
        {learner?.evidence?.length ? <ul className="pilot-list" aria-label="Recorded learning evidence">
          {learner.evidence.map((item) => <li key={item.id} className="pilot-list-row"><div className="grow">
            <strong>{topicNames.get(item.topicId) ?? 'NA'}</strong>
            <p>Recorded: <ReportDate value={item.occurredAt} /></p>
          </div></li>)}
        </ul> : <p>NA — no learning evidence available.</p>}
      </section>
    </div>
    <section className="pilot-card" aria-labelledby="report-assessments-title">
      <h3 id="report-assessments-title">Assessment activity</h3>
      <h4>Career-readiness attempts</h4>
      {learner?.attempts?.length ? <ul className="pilot-list" aria-label="Career-readiness assessment attempts">
        {learner.attempts.map((item) => <li key={item.id} className="pilot-list-row"><div className="grow">
          <strong>{reportState(item.state, ['IN_PROGRESS', 'SUBMITTED', 'EXPIRED', 'VOIDED'])}</strong>
          <p>Started: <ReportDate value={item.startedAt} /> · Submitted: <ReportDate value={item.submittedAt} /></p>
        </div></li>)}
      </ul> : <p>NA — no career-readiness attempts available.</p>}
      <h4>Assigned assessments</h4>
      <p>Up to 100 of your assigned assessments, by start date. Attempts used does not count an attempt still in progress.</p>
      {exams?.length ? <ul className="pilot-list" aria-label="Assigned assessment activity">
        {exams.map((exam) => <li key={exam.id} className="pilot-list-row"><div className="grow">
          <strong>{exam.title || 'NA'}</strong>
          <p>Attempts used: {exam.attemptsUsed ?? 'NA'} · Allowed: {exam.attemptsAllowed ?? 'NA'}</p>
          <span className="pilot-chip slate">{exam.openAttemptId ? 'In progress'
            : exam.latestResult ? 'Published result available' : 'No published result available'}</span>
        </div></li>)}
      </ul> : <p>NA — no assigned assessment activity available.</p>}
    </section>
    <section className="pilot-card" aria-labelledby="report-applications-title">
      <h3 id="report-applications-title">Application activity</h3>
      <p>Your 200 most recently updated applications, newest first.</p>
      {applications?.length ? <ul className="pilot-list" aria-label="Your application activity">
        {applications.map((item) => <li key={item.id} className="pilot-list-row"><div className="grow">
          <strong>{item.title || 'NA'}</strong>
          <p>{item.employerName || 'NA'}</p>
          <span className="pilot-chip slate">{reportState(item.state,
            ['DRAFT', 'APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'])}</span>
          <p>Submitted: <ReportDate value={item.submittedAt} /> · Updated: <ReportDate value={item.updatedAt} /></p>
        </div></li>)}
      </ul> : <p>NA — no application activity available.</p>}
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
        const state = Object.hasOwn(SUPPORT_STATES, action.state) ? SUPPORT_STATES[action.state] : 'NA';
        return <li key={action.id} className="pilot-list-row"><div className="grow">
          <h3>{action.title || 'NA'}</h3>
          <p>{action.actionType === 'ASSIGNED_TASK' ? 'Assigned task' : action.actionType === 'INTERVENTION' ? 'Intervention' : 'NA'}</p>
          <p>{role ? `Assigned by your ${role}` : 'Assigned by your college'}</p>
          <p>Due: {action.dueAt && Number.isFinite(Date.parse(action.dueAt))
            ? <time dateTime={action.dueAt}>{formatDateTime(action.dueAt)}</time> : 'NA'}</p>
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
  const [data, setData] = useState<DashboardData | null>(null);
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
    ]).then(([profile, learner, exams, notifications, activity, applications]) => {
      if (!controller.signal.aborted) setData({ profile, learner, exams, notifications, activity, applications });
    });
    return () => controller.abort();
  }, [token]);

  if (!data) return <section className="card wide-card"><h2>Student Dashboard</h2><p>Loading your workspace…</p></section>;

  const now = Date.now();
  const firstName = studentName.split(/\s+/)[0] ?? studentName;
  const hour = new Date().getHours();
  const daypart = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const exams = data.exams ?? [];
  const lessons = data.learner?.catalog?.modules?.flatMap((module) => module.lessons ?? []) ?? [];
  const completedLessonIds = new Set(data.learner?.progress?.filter((item) => item.state === 'COMPLETED').map((item) => item.lessonVersionId) ?? []);
  const nextLesson = lessons.find((lesson) => !completedLessonIds.has(lesson.id));
  const lessonPercent = lessons.length ? Math.round((completedLessonIds.size / lessons.length) * 100) : 0;
  const openExams = exams.filter((exam) => exam.openAttemptId !== null || (now >= Date.parse(exam.startsAt) && now <= Date.parse(exam.endsAt) && exam.attemptsUsed < exam.attemptsAllowed));
  const band = data.learner?.readiness?.band ?? null;
  const modules = data.learner?.catalog?.modules ?? [];
  const topics = new Map((data.learner?.catalog?.topics ?? []).map((topic) => [topic.id, topic]));
  const factors = new Map((data.learner?.readiness?.explanation?.factors ?? []).map((factor) => [factor.topicId, factor]));
  const masteryCards = (data.learner?.mastery ?? []).slice(0, 5);
  // The empty slots name the published topics with no evidence yet, so they are not five identical cards.
  const measuredTopicIds = new Set((data.learner?.mastery ?? []).map((mastery) => mastery.topicId));
  const unmeasuredTopics = (data.learner?.catalog?.topics ?? []).filter((topic) => !measuredTopicIds.has(topic.id));

  // Today's plan is rule-derived from live account state - the honest v1 of
  // the pilot's daily-plan engine.
  const plan: { readonly title: string; readonly minutes: string; readonly done: boolean; readonly path: string }[] = [
    ...openExams.slice(0, 2).map((exam) => ({
      title: exam.openAttemptId ? `Resume ${exam.title}` : `Attempt ${exam.title}`,
      minutes: `${Math.round(exam.durationSeconds / 60)} min`, done: false, path: '/student/assessments',
    })),
    ...(nextLesson ? [{ title: `Complete lesson: ${nextLesson.title}`, minutes: '—', done: false, path: '/student/learning' }] : []),
    ...(data.profile?.targetCareer
      ? [{ title: 'Keep your profile current', minutes: '5 min', done: false, path: '/student/profile' }]
      : [{ title: 'Set your target career', minutes: '2 min', done: false, path: '/student/profile' }]),
    ...(lessons.length > 0 && completedLessonIds.size === lessons.length
      ? [{ title: 'All lessons completed - review your readiness', minutes: '—', done: true, path: '/student/readiness' }] : []),
  ].slice(0, 4);

  const upcoming = [
    ...exams.filter((exam) => Date.parse(exam.startsAt) > now).map((exam) => ({ title: `${exam.title} opens`, when: formatDateTime(exam.startsAt) })),
    ...openExams.filter((exam) => Date.parse(exam.endsAt) > now).map((exam) => ({ title: `${exam.title} closes`, when: formatDateTime(exam.endsAt) })),
  ].slice(0, 3);

  const activityRows = (data.notifications?.notifications ?? []).slice(0, 4);
  const streak = data.activity?.currentStreakDays ?? 0;
  const weekPoints = data.activity?.last7?.map((entry) => entry.count) ?? [0, 0, 0, 0, 0, 0, 0];
  const activeDays = data.activity?.activeDaysLast7 ?? 0;
  const weekDayLetters = (data.activity?.last7 ?? []).map((entry) => new Date(`${entry.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' }));

  // Practice, Resume Builder and Scholarships get their own pilot-parity pages
  // next; until those routes ship, their actions land on the nearest live page.
  const quickActions: readonly [string, IconName, string][] = [
    ['Take a Mock Test', 'assessments', '/student/assessments'], ['Practice Questions', 'targets', '/student/assessments'],
    ['Build Resume', 'resume', '/student/documents'], ['Explore Roles', 'opportunities', '/student/opportunities'],
    ['Update Profile', 'profile', '/student/profile'], ['View Scholarships', 'scholarships', '/student/opportunities'],
  ];

  return <div className="pilot pilot-embed">
    <div className="pilot-page">
      <div className="pilot-content">
        <div className="pilot-page-head">
          <div className="pilot-greeting">
            <h1>Good {daypart}, {firstName}! 👋</h1>
            <p>Let&apos;s continue your journey and get one step closer to your dream career.</p>
          </div>
          <button type="button" className="pilot-btn ghost" onClick={() => go('/student/assessments')}><Icon name="calendar-small" size={16} /> View Calendar</button>
        </div>

        <StudentSupport key={token} token={token} />

        {/* The band card beside the readiness factors; the factors (real cards, then the
            topics with no evidence yet) share one wrapping grid so they fill the room they have. */}
        <div className="pilot-row v3-score-row">
          <section className="pilot-card v3-band-card">
            <h2>Career Readiness Band</h2>
            <div className="v3-band-body">
              {/* The advisory band, drawn only by <ReadinessBand>: the enum in, never a number. */}
              <ReadinessBand band={toReadinessBand(band)} variant="compact" />
              <div style={{ marginTop: 11 }}><a className="pilot-btn soft small" href="#student-reports-title">View Full Report</a></div>
            </div>
          </section>
          <div className="v3-factor-grid">
          {masteryCards.map((mastery) => {
            const factor = factors.get(mastery.topicId);
            return <section key={mastery.id} className="pilot-card pilot-score-card">
              <header>{topics.get(mastery.topicId)?.name ?? 'Readiness topic'}</header>
              <span className="pilot-chip blue">{prettify(mastery.band)}</span>
              <small>{mastery.evidenceIds.length} active evidence record{mastery.evidenceIds.length === 1 ? '' : 's'}</small>
              {factor && plainFactorExplanation(factor.explanation) ? <small>{plainFactorExplanation(factor.explanation)}</small> : null}
            </section>
          })}
          {masteryCards.length < 5 ? <section className="pilot-card na-strip" data-na-strip="true">
            <div className="pilot-card-head"><h2>Readiness factors</h2><span className="pilot-chip slate">NA</span></div>
            <ul className="na-strip-slots" aria-label="Readiness factors without a projection">
              {Array.from({ length: 5 - masteryCards.length }).map((_, index) => (
                <NaSlotChip key={`mastery-na-${index}`} label={unmeasuredTopics[index]?.name ?? 'Readiness factor'} />
              ))}
            </ul>
            <p className="na-reason">No evidence recorded yet.</p>
          </section> : null}
          </div>
        </div>

        <div className="pilot-row cols-3">
          <section className="pilot-card">
            <div className="pilot-card-head"><h2>Today&apos;s Plan</h2><span className="pilot-chip blue">{plan.length} Task{plan.length === 1 ? '' : 's'}</span></div>
            <div className="pilot-list">
              {plan.length ? plan.map((task) => (
                <div key={task.title} className="pilot-list-row" style={{ cursor: 'pointer' }} onClick={() => go(task.path)}>
                  <Icon name="check" size={16} style={{ color: task.done ? 'var(--ok)' : 'var(--line-2)' }} />
                  <div className="grow"><strong style={task.done ? { color: 'var(--p-muted)' } : undefined}>{task.title}</strong></div>
                  <small>{task.minutes}</small>
                </div>
              )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>Nothing due right now.</p>}
            </div>
            <button type="button" className="pilot-btn soft small" style={{ marginTop: 10 }} onClick={() => go('/student/assessments')}>View Full Plan</button>
          </section>

          <section className="pilot-card">
            <h2>Continue Learning</h2>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span className="pilot-tile purple"><Icon name="learning" size={20} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ fontSize: 13 }}>{modules[0]?.title ?? 'NA'}</strong>
                <small style={{ display: 'block', color: 'var(--p-muted)' }}>{nextLesson?.title ?? (lessons.length ? 'All lessons completed' : 'No lessons assigned yet')}</small>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
              <div className="pilot-bar" style={{ flex: 1 }}><i style={{ width: `${lessonPercent}%` }} /></div>
              <small style={{ color: 'var(--p-muted)' }}>{lessonPercent}%</small>
            </div>
            <button type="button" className="pilot-btn soft small" onClick={() => go('/student/learning')}><Icon name="arrow-right" size={16} /> Resume Lesson</button>
          </section>

          <section className="pilot-card">
            <div className="pilot-card-head"><h2>Upcoming</h2><button type="button" className="pilot-link" onClick={() => go('/student/assessments')}>View All</button></div>
            <div className="pilot-list">
              {upcoming.length ? upcoming.map((item) => (
                <div key={item.title} className="pilot-list-row">
                  <span className="pilot-tile blue"><Icon name="calendar" size={16} /></span>
                  <div className="grow"><strong>{item.title}</strong><small>{item.when}</small></div>
                  <Icon name="arrow-right" size={16} style={{ color: "var(--text-3)" }} />
                </div>
              )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>NA — no scheduled windows.</p>}
            </div>
          </section>
        </div>

        <div className="pilot-row cols-2">
          <section className="pilot-card">
            <div className="pilot-card-head"><h2>Recommended for You</h2><button type="button" className="pilot-link" onClick={() => go('/student/learning')}>View All</button></div>
            <div className="pilot-row cols-4">
              {modules.slice(0, 4).map((module, index) => (
                <div key={module.id} className="pilot-course-card">
                  <span className="pilot-tile" style={{ background: toneMix(NA_COURSE_TONES[index % 4]!, 10), color: toneColor(NA_COURSE_TONES[index % 4]!) }}><Icon name="learning" size={20} /></span>
                  <strong>{module.title}</strong>
                  <small>{module.lessons.length} Lessons</small>
                  <button type="button" className="pilot-btn soft small" onClick={() => go('/student/learning')}>Start</button>
                </div>
              ))}
            </div>
            {modules.length < 4 ? <NaSlotStrip card={false} label="Recommendation slots without a source"
              slots={Array.from({ length: 4 - modules.length }, (_, index) => ({ label: `Recommendation ${modules.length + index + 1}` }))}
              reason="Recommendations not live yet." /> : null}
          </section>

          <section className="pilot-card">
            <h2>Quick Actions</h2>
            <div className="pilot-row cols-2">
              {quickActions.map(([label, glyph, path]) => (
                <button key={label} type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => go(path)}>
                  <Icon name={glyph} size={16} />
                  {label}
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="pilot-row cols-2">
          <section className="pilot-card">
            <h2>Recent Activity</h2>
            <div className="pilot-list">
              {activityRows.length ? activityRows.map((entry) => (
                <div key={entry.id} className="pilot-list-row">
                  <span className="pilot-tile green"><Icon name="analytics" size={16} /></span>
                  <div className="grow"><strong>{entry.title}</strong></div>
                  <small>{relativeWhen(entry.createdAt)}</small>
                </div>
              )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>NA — no activity recorded yet.</p>}
            </div>
          </section>
          <section className="pilot-card">
            <div className="pilot-card-head"><h2>Badges Earned</h2><button type="button" className="pilot-link" disabled>View All Badges</button></div>
            <NaSlotStrip card={false} label="Badge slots" slots={[1, 2, 3, 4].map((index) => ({ label: `Badge ${index}` }))}
              reason="Badges are not live yet." />
            <div style={{ borderTop: '1px solid var(--p-line)', marginTop: 14, paddingTop: 14 }}>
              <div className="pilot-card-head" style={{ marginBottom: 8 }}><h2 style={{ fontSize: 13.5 }}>Career Goal · {data.profile?.targetCareer ?? 'NA'}</h2><button type="button" className="pilot-link" onClick={() => go('/student/profile')}>Change Goal</button></div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span className="pilot-chip slate">Target companies: NA</span>
                <button type="button" className="pilot-chip slate" style={{ border: 0, cursor: 'pointer', font: 'inherit' }} onClick={() => go('/student/profile')}>+ Add More</button>
              </div>
            </div>
          </section>
        </div>
        <StudentReports learner={data.learner} exams={data.exams} applications={data.applications} />
      </div>

      <aside className="pilot-rail">
        <section className="pilot-card">
          <div className="pilot-card-head">
            <h2><Icon name="skills" size={16} style={{ color: "var(--orange)", verticalAlign: '-2px' }} /> {streak} Day Streak</h2>
            <small style={{ color: 'var(--p-muted)' }}>{streak > 0 ? 'Keep it up!' : 'Start today!'}</small>
          </div>
          <div className="pilot-streak-days">
            {(data.activity?.last7 ?? Array.from({ length: 7 }, () => ({ count: 0 }))).map((entry, index) => (
              <i key={index} className={entry.count > 0 ? '' : 'off'}>{entry.count > 0 ? '✓' : (weekDayLetters[index] ?? '·')}</i>
            ))}
          </div>
        </section>
        <section className="pilot-card">
          <div className="pilot-card-head"><h2>Your Progress This Week</h2><span className="pilot-chip blue">{activeDays}/7 days</span></div>
          <Spark points={weekPoints} />
        </section>
        <div className="pilot-quote">&ldquo;Discipline today. Success tomorrow.&rdquo;</div>
      </aside>
    </div>
  </div>;
}
