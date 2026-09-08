import { useEffect, useState } from 'react';
import { ArrowRight, Award, BookOpen, Building2, CalendarDays, CheckCircle2, ClipboardCheck, Flame, Play, Star, Target, TrendingUp, Trophy } from 'lucide-react';
import { Spark, toneColor } from './pilot/pilotComponents.js';
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

function ReadinessBandRing({ band }: { readonly band: string | null }): React.ReactElement {
  const size = 76;
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const segment = circumference / READINESS_BANDS.length;
  const gap = 5;
  const activeIndex = band ? READINESS_BANDS.indexOf(band as (typeof READINESS_BANDS)[number]) : -1;
  const label = activeIndex >= 0 ? `${prettify(READINESS_BANDS[activeIndex]!)} readiness band` : 'Readiness band unavailable';
  return <span style={{ position: 'relative', width: size, height: size, display: 'inline-grid', placeItems: 'center', flex: '0 0 auto' }}>
    <svg width={size} height={size} role="img" aria-label={label}>
      {READINESS_BANDS.map((candidate, index) => <circle key={candidate}
        cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={index === activeIndex ? toneColor('blue') : '#dce3ee'}
        strokeWidth={index === activeIndex ? stroke : stroke - 2} strokeLinecap="round"
        strokeDasharray={`${segment - gap} ${circumference - segment + gap}`}
        strokeDashoffset={-index * segment} transform={`rotate(-90 ${size / 2} ${size / 2})`} />)}
    </svg>
    <span style={{ position: 'absolute', textAlign: 'center', fontWeight: 700, fontSize: 11, color: activeIndex >= 0 ? 'var(--p-text)' : 'var(--p-muted)' }}>
      {activeIndex >= 0 ? 'BAND' : 'NA'}
    </span>
  </span>;
}

interface DashboardData {
  readonly profile: StudentProfileDto | null;
  readonly learner: LearnerCareerReadinessState | null;
  readonly exams: readonly StudentExamDto[] | null;
  readonly notifications: { readonly notifications: readonly UserNotificationDto[]; readonly unreadCount: number } | null;
  readonly activity: StudentActivityDto | null;
  readonly applications: readonly StudentApplicationDto[] | null;
}

function ReportDate({ value }: { readonly value: string | null | undefined }): React.ReactElement {
  if (!value || !Number.isFinite(Date.parse(value))) return <>NA</>;
  return <time dateTime={value}>{new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })}</time>;
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
      <p>Latest available snapshots, newest first (up to 100). Each step is a band, not a score.</p>
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
      <p>Available assignments ordered by start date (up to 100). Attempts used excludes any attempt still in progress.</p>
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
      <p>Your latest available applications (up to 200), most recently updated first. This is not a lifetime total.</p>
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
    ...exams.filter((exam) => Date.parse(exam.startsAt) > now).map((exam) => ({ title: `${exam.title} opens`, when: new Date(exam.startsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })),
    ...openExams.filter((exam) => Date.parse(exam.endsAt) > now).map((exam) => ({ title: `${exam.title} closes`, when: new Date(exam.endsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })),
  ].slice(0, 3);

  const activityRows = (data.notifications?.notifications ?? []).slice(0, 4);
  const streak = data.activity?.currentStreakDays ?? 0;
  const weekPoints = data.activity?.last7?.map((entry) => entry.count) ?? [0, 0, 0, 0, 0, 0, 0];
  const activeDays = data.activity?.activeDaysLast7 ?? 0;
  const weekDayLetters = (data.activity?.last7 ?? []).map((entry) => new Date(`${entry.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' }));

  // Practice, Resume Builder and Scholarships get their own pilot-parity pages
  // next; until those routes ship, their actions land on the nearest live page.
  const quickActions: readonly [string, typeof Target, string][] = [
    ['Take a Mock Test', ClipboardCheck, '/student/assessments'], ['Practice Questions', Target, '/student/assessments'],
    ['Build Resume', BookOpen, '/student/documents'], ['Explore Roles', Building2, '/student/opportunities'],
    ['Update Profile', Star, '/student/profile'], ['View Scholarships', Award, '/student/opportunities'],
  ];

  return <div className="pilot pilot-embed">
    <div className="pilot-page">
      <div className="pilot-content">
        <div className="pilot-page-head">
          <div className="pilot-greeting">
            <h1>Good {daypart}, {firstName}! 👋</h1>
            <p>Let&apos;s continue your journey and get one step closer to your dream career.</p>
          </div>
          <button type="button" className="pilot-btn ghost" onClick={() => go('/student/assessments')}><CalendarDays size={15} /> View Calendar</button>
        </div>

        <div className="pilot-row v3-score-row">
          <section className="pilot-card">
            <h2>Career Readiness Band</h2>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'nowrap' }}>
              <div style={{ minWidth: 0 }}>
                <div>{band
                  ? <span className="pilot-chip green">{prettify(band)}</span>
                  : <span className="pilot-chip slate">No advisory band yet</span>}</div>
                <div style={{ marginTop: 11 }}><a className="pilot-btn soft small" href="#student-reports-title">View Full Report</a></div>
              </div>
              <ReadinessBandRing band={band} />
            </div>
            <div aria-label="Readiness band legend" style={{ display: 'grid', gap: 5, marginTop: 12 }}>
              {READINESS_BANDS.map((candidate, index) => <span key={candidate} style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 10.5,
                color: candidate === band ? 'var(--p-text)' : 'var(--p-muted)', fontWeight: candidate === band ? 700 : 500 }}>
                <i aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: candidate === band ? toneColor('blue') : '#dce3ee' }} />
                {index + 1}. {prettify(candidate)}{candidate === band ? ' (current)' : ''}
              </span>)}
            </div>
          </section>
          {masteryCards.map((mastery) => {
            const factor = factors.get(mastery.topicId);
            return <section key={mastery.id} className="pilot-card pilot-score-card">
              <header>{topics.get(mastery.topicId)?.name ?? 'Readiness topic'}</header>
              <span className="pilot-chip blue">{prettify(mastery.band)}</span>
              <small>{mastery.evidenceIds.length} active evidence record{mastery.evidenceIds.length === 1 ? '' : 's'}</small>
              {factor ? <small>{factor.explanation}</small> : null}
            </section>
          })}
          {Array.from({ length: Math.max(0, 5 - masteryCards.length) }).map((_, index) => (
            <section key={`mastery-na-${index}`} className="pilot-card pilot-score-card">
              <header>Readiness factor</header>
              <span className="pilot-chip slate">NA</span>
              <small>No mastery projection available.</small>
            </section>
          ))}
        </div>

        <div className="pilot-row cols-3">
          <section className="pilot-card">
            <div className="pilot-card-head"><h2>Today&apos;s Plan</h2><span className="pilot-chip blue">{plan.length} Task{plan.length === 1 ? '' : 's'}</span></div>
            <div className="pilot-list">
              {plan.length ? plan.map((task) => (
                <div key={task.title} className="pilot-list-row" style={{ cursor: 'pointer' }} onClick={() => go(task.path)}>
                  <CheckCircle2 size={17} color={task.done ? '#12996b' : '#c2ccda'} />
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
              <span className="pilot-tile purple"><BookOpen size={19} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ fontSize: 13 }}>{modules[0]?.title ?? 'NA'}</strong>
                <small style={{ display: 'block', color: 'var(--p-muted)' }}>{nextLesson?.title ?? (lessons.length ? 'All lessons completed' : 'No lessons assigned yet')}</small>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
              <div className="pilot-bar" style={{ flex: 1 }}><i style={{ width: `${lessonPercent}%` }} /></div>
              <small style={{ color: 'var(--p-muted)' }}>{lessonPercent}%</small>
            </div>
            <button type="button" className="pilot-btn soft small" onClick={() => go('/student/learning')}><Play size={13} /> Resume Lesson</button>
          </section>

          <section className="pilot-card">
            <div className="pilot-card-head"><h2>Upcoming</h2><button type="button" className="pilot-link" onClick={() => go('/student/assessments')}>View All</button></div>
            <div className="pilot-list">
              {upcoming.length ? upcoming.map((item) => (
                <div key={item.title} className="pilot-list-row">
                  <span className="pilot-tile blue"><CalendarDays size={17} /></span>
                  <div className="grow"><strong>{item.title}</strong><small>{item.when}</small></div>
                  <ArrowRight size={15} color="#98a5ba" />
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
                  <span className="pilot-tile" style={{ background: `${toneColor(NA_COURSE_TONES[index % 4]!)}1a`, color: toneColor(NA_COURSE_TONES[index % 4]!) }}><BookOpen size={18} /></span>
                  <strong>{module.title}</strong>
                  <small>{module.lessons.length} Lessons</small>
                  <button type="button" className="pilot-btn soft small" onClick={() => go('/student/learning')}>Start</button>
                </div>
              ))}
              {Array.from({ length: Math.max(0, 4 - modules.length) }).map((_, index) => (
                <div key={`na-${index}`} className="pilot-course-card" style={{ opacity: .65 }}>
                  <span className="pilot-tile" style={{ background: '#eef1f6', color: '#9aa5b8' }}><BookOpen size={18} /></span>
                  <strong>NA</strong>
                  <small>Recommendations not live yet</small>
                  <button type="button" className="pilot-btn soft small" disabled>Start</button>
                </div>
              ))}
            </div>
          </section>

          <section className="pilot-card">
            <h2>Quick Actions</h2>
            <div className="pilot-row cols-2">
              {quickActions.map(([label, Icon, path]) => (
                <button key={label} type="button" className="pilot-btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => go(path)}>
                  <Icon size={15} />
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
                  <span className="pilot-tile green"><TrendingUp size={16} /></span>
                  <div className="grow"><strong>{entry.title}</strong></div>
                  <small>{relativeWhen(entry.createdAt)}</small>
                </div>
              )) : <p style={{ color: 'var(--p-muted)', margin: '8px 0' }}>NA — no activity recorded yet.</p>}
            </div>
          </section>
          <section className="pilot-card">
            <div className="pilot-card-head"><h2>Badges Earned</h2><button type="button" className="pilot-link" disabled>View All Badges</button></div>
            <div className="pilot-row cols-4">
              {['NA', 'NA', 'NA', 'NA'].map((label, index) => (
                <div key={index} style={{ textAlign: 'center', opacity: .6 }}>
                  <span className="pilot-tile" style={{ margin: '0 auto 8px', background: '#eef1f6', color: '#9aa5b8' }}><Trophy size={18} /></span>
                  <small style={{ display: 'block', fontSize: 11, color: 'var(--p-muted)', fontWeight: 600 }}>{label}</small>
                </div>
              ))}
            </div>
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
            <h2><Flame size={15} color="#f59e0b" style={{ verticalAlign: '-2px' }} /> {streak} Day Streak</h2>
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
