import { useEffect, useState } from 'react';
import { NaReason, NaValue, isMissing } from './naState.js';
import { SupportCode } from './supportCode.js';
import { formatDate } from './dates.js';
import { codeLabel, roleLabel } from './labels.js';
import {
  ApiRequestError,
  getLearnerCareerReadinessState,
  getOperationsOverview,
  getProtectedAccessToken,
  getSecurityContext,
  getStudentActivity,
  getStudentProfile,
  listEmployerApplicants,
  listEmployerOpportunities,
  listExamQuestions,
  listExamSubjects,
  listInstitutionExamResults,
  listInstitutionExams,
  listInstitutionStaff,
  listInstitutionStudents,
  listInstitutionUnits,
  listMyNotifications,
  listStudentExams,
  type EmployerApplicantDto,
  type EmployerOpportunityDto,
  type ExamNotAttemptedDto,
  type ExamSubjectDto,
  type InstitutionExamDto,
  type InstitutionStaffDto,
  type InstitutionStudentDto,
  type InstitutionUnitDto,
  type LearnerCareerReadinessState,
  type OperationsOverviewDto,
  type OverviewCountDto,
  type OverviewPeopleCountDto,
  type StudentActivityDto,
  type StudentExamDto,
  type StudentProfileDto,
  type UserNotificationDto,
} from './api.js';

/**
 * Version 2 dashboards: the pilot preview's composition (hero, stat tiles,
 * rings, chips, rail) applied to the REAL authenticated workspaces. Every
 * widget is fed only by data the product's APIs serve today — widgets that
 * would need engines the product does not have (numeric scores, streaks,
 * recommendations) are deliberately absent. Each fetch degrades on its own:
 * a 403 or failure hides that widget instead of breaking the page.
 */

function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function prettify(code: string): string {
  return code.replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\w/g, (char) => char.toUpperCase());
}

function shortDate(iso: string): { readonly month: string; readonly day: string } {
  const date = new Date(iso);
  return { month: date.toLocaleString(undefined, { month: 'short' }).toUpperCase(), day: String(date.getDate()).padStart(2, '0') };
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

// --- Shared primitives -------------------------------------------------------

export function V2Ring({ percent, label, value, tone = '#1f55e5' }: {
  readonly percent: number; readonly label: string; readonly value: string; readonly tone?: string;
}): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * 45;
  return (
    <div className="v2-ring" role="img" aria-label={`${value} ${label}`}>
      <svg width="106" height="106">
        <circle cx="53" cy="53" r="45" fill="none" stroke="#edf1f7" strokeWidth="10" />
        <circle cx="53" cy="53" r="45" fill="none" stroke={tone} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`} transform="rotate(-90 53 53)" />
      </svg>
      <div><b>{value}</b><small>{label}</small></div>
    </div>
  );
}

/** A stat tile. A missing value (NA, <5, Withheld, Too few answers) keeps its text, muted, with an optional reason. */
export function V2Stat({ icon, tone, value, label, reason }: {
  readonly icon: string; readonly tone: string; readonly value: React.ReactNode; readonly label: string; readonly reason?: string;
}): React.ReactElement {
  const missing = isMissing(value);
  return <div className="v2-card v2-stat" data-na={missing ? 'true' : undefined}><span className={`v2-tile ${missing ? 'na-tile' : tone}`} aria-hidden="true">{icon}</span>
    <div><b><NaValue value={value} /></b><small>{label}</small>{missing && reason ? <NaReason>{reason}</NaReason> : null}</div></div>;
}

export function V2Chip({ tone, children }: { readonly tone: string; readonly children: React.ReactNode }): React.ReactElement {
  // A raw code passed as the whole label (ACTIVE, UNDER_REVIEW) reads as words.
  return <span className={`v2-chip ${tone}`}>{typeof children === 'string' ? codeLabel(children) : children}</span>;
}

export function V2Bar({ percent, tone = '' }: { readonly percent: number; readonly tone?: string }): React.ReactElement {
  return <div className={`v2-bar ${tone}`}><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>;
}

function chipToneForState(state: string): string {
  if (['PUBLISHED', 'ACTIVE', 'ACCEPTED', 'VERIFIED', 'COMPLETED', 'OFFER'].some((value) => state.includes(value))) return 'green';
  if (['DRAFT', 'PENDING', 'UNDER_REVIEW', 'IN_PROGRESS'].some((value) => state.includes(value))) return 'amber';
  if (['SHORTLIST', 'INTERVIEW'].some((value) => state.includes(value))) return 'purple';
  return 'blue';
}

export function V2EmptyState({ icon, title, note, hint }: {
  readonly icon: string; readonly title: string; readonly note: string; readonly hint?: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="v2-card v2-empty-state">
      <span className="v2-empty-icon" aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
      <p>{note}</p>
      {hint ? <p className="v2-empty-hint">{hint}</p> : null}
    </section>
  );
}

// --- Student -----------------------------------------------------------------

interface StudentDashboardData {
  readonly profile: StudentProfileDto | null;
  readonly learner: LearnerCareerReadinessState | null;
  readonly exams: readonly StudentExamDto[] | null;
  readonly notifications: { readonly notifications: readonly UserNotificationDto[]; readonly unreadCount: number } | null;
  readonly activity: StudentActivityDto | null;
}

export function StudentDashboardV2({ studentName }: { readonly studentName: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<StudentDashboardData | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void Promise.all([
      getStudentProfile(token, controller.signal).then((response) => response.profile).catch(() => null),
      getLearnerCareerReadinessState(token, controller.signal).catch(() => null),
      listStudentExams(token, controller.signal).then((response) => response.assessments).catch(() => null),
      listMyNotifications(token, controller.signal).catch(() => null),
      getStudentActivity(token, controller.signal).catch(() => null),
    ]).then(([profile, learner, exams, notifications, activity]) => setData({ profile, learner, exams, notifications, activity }));
    return () => controller.abort();
  }, [token]);

  if (!data) return <section className="card wide-card"><h2>Student Dashboard</h2><p>Loading your workspace…</p></section>;

  const now = Date.now();
  const exams = data.exams ?? [];
  const lessons = data.learner?.catalog?.modules?.flatMap((module) => module.lessons ?? []) ?? [];
  const completedLessonIds = new Set(data.learner?.progress?.filter((item) => item.state === 'COMPLETED').map((item) => item.lessonVersionId) ?? []);
  const openExams = exams.filter((exam) => exam.openAttemptId !== null || (now >= Date.parse(exam.startsAt) && now <= Date.parse(exam.endsAt) && exam.attemptsUsed < exam.attemptsAllowed));
  const results = exams.filter((exam) => exam.latestResult !== null);
  const bestScore = results.length ? Math.max(...results.map((exam) => exam.latestResult!.percentage)) : null;
  const nextDeadline = openExams.map((exam) => exam.endsAt).sort()[0] ?? null;
  const band = data.learner?.readiness?.band ?? null;
  const firstName = studentName.split(/\s+/)[0] ?? studentName;
  const upcoming = [
    ...exams.filter((exam) => Date.parse(exam.startsAt) > now).map((exam) => ({ at: exam.startsAt, title: `${exam.title} opens`, detail: `${Math.round(exam.durationSeconds / 60)} min · ${exam.totalMarks} marks` })),
    ...openExams.filter((exam) => Date.parse(exam.endsAt) > now).map((exam) => ({ at: exam.endsAt, title: `${exam.title} closes`, detail: 'Laptop only · timer runs per attempt' })),
  ].sort((left, right) => left.at.localeCompare(right.at)).slice(0, 4);
  const nextLesson = lessons.find((lesson) => !completedLessonIds.has(lesson.id));

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">Your placement-readiness workspace</p>
            <h1>{greeting()}, {firstName} 👋</h1>
            <p>{nextDeadline
              ? <>Your next assessment window closes <b>{formatDate(nextDeadline)}</b>. Keep building your evidence.</>
              : 'No assessment window is open right now. Keep building your evidence.'}</p>
            <div className="v2-hero-chips">
              {(data.activity?.currentStreakDays ?? 0) > 0 ? <V2Chip tone="amber">🔥 {data.activity!.currentStreakDays}-day streak</V2Chip> : null}
              {data.profile?.targetCareer ? <V2Chip tone="blue">Target: {data.profile.targetCareer}</V2Chip> : null}
              {band ? <V2Chip tone="purple">Advisory band: {prettify(band)}</V2Chip> : <V2Chip tone="slate">No advisory band yet</V2Chip>}
            </div>
          </div>
          {lessons.length ? <V2Ring percent={(completedLessonIds.size / lessons.length) * 100} value={`${completedLessonIds.size}/${lessons.length}`} label="LESSONS COMPLETED" /> : null}
        </div>

        <div className="v2-row v2-cols-4">
          <V2Stat icon="📝" tone="blue" value={openExams.length} label="Open assessments" />
          <V2Stat icon="✅" tone="green" value={bestScore !== null ? `${bestScore}%` : '—'} label="Best recent score" />
          <V2Stat icon="📚" tone="purple" value={`${completedLessonIds.size} / ${lessons.length}`} label="Lessons completed" />
          <V2Stat icon="🔔" tone="amber" value={data.notifications?.unreadCount ?? 0} label="Unread notifications" />
        </div>

        <div className="v2-row v2-cols-2">
          <section className="v2-card">
            <div className="v2-card-head"><h2>Next steps</h2><V2Chip tone="slate">From your account</V2Chip></div>
            <div className="v2-list">
              {openExams.slice(0, 2).map((exam) => (
                <div key={exam.id} className="v2-list-row">
                  <span className="v2-tile blue" aria-hidden="true">📝</span>
                  <div className="grow"><strong>{exam.title}</strong><small>{exam.openAttemptId ? 'Attempt in progress — resume it' : `Window closes ${formatDate(exam.endsAt)}`} · {exam.attemptsUsed} of {exam.attemptsAllowed} attempts used</small></div>
                  <button type="button" className="v2-btn small" onClick={() => go('/student/assessments')}>{exam.openAttemptId ? 'Resume' : 'Start'}</button>
                </div>
              ))}
              {nextLesson ? (
                <div className="v2-list-row">
                  <span className="v2-tile purple" aria-hidden="true">📚</span>
                  <div className="grow"><strong>Continue learning: {nextLesson.title}</strong><small>{completedLessonIds.size} of {lessons.length} lessons completed</small></div>
                  <button type="button" className="v2-btn ghost small" onClick={() => go('/student/learning')}>Resume</button>
                </div>
              ) : null}
              {!data.profile?.targetCareer ? (
                <div className="v2-list-row">
                  <span className="v2-tile teal" aria-hidden="true">🎯</span>
                  <div className="grow"><strong>Set your target career</strong><small>It anchors your roadmap and guidance</small></div>
                  <button type="button" className="v2-btn ghost small" onClick={() => go('/student/profile')}>Open</button>
                </div>
              ) : (
                <div className="v2-list-row">
                  <span className="v2-tile teal" aria-hidden="true">👤</span>
                  <div className="grow"><strong>Keep your profile current</strong><small>Skills and projects feed your readiness evidence</small></div>
                  <button type="button" className="v2-btn ghost small" onClick={() => go('/student/profile')}>Open</button>
                </div>
              )}
            </div>
          </section>
          <section className="v2-card">
            <div className="v2-card-head"><h2>Recent results</h2><button type="button" className="v2-link" onClick={() => go('/student/assessments')}>View all</button></div>
            {results.length ? (
              <div className="v2-list">
                {results.slice(0, 3).map((exam) => (
                  <div key={exam.id} className="v2-list-row">
                    <div className="grow"><strong>{exam.title}</strong><small>{exam.subjectName} · {exam.latestResult!.score} / {exam.latestResult!.maxScore}</small>
                      <V2Bar percent={exam.latestResult!.percentage} tone={exam.latestResult!.percentage >= 60 ? 'green' : 'amber'} /></div>
                    <V2Chip tone={exam.latestResult!.percentage >= 60 ? 'green' : 'amber'}>{exam.latestResult!.percentage}%</V2Chip>
                  </div>
                ))}
              </div>
            ) : <p className="v2-empty">No published results yet. Your scores appear here after your institution publishes them.</p>}
            <p className="v2-boundary">Scores are visible to you and your institution only — never to employers.</p>
          </section>
        </div>

        <section className="v2-card">
          <div className="v2-card-head"><h2>Quick actions</h2></div>
          <div className="v2-quick">
            <button type="button" onClick={() => go('/student/assessments')}>📝 Assessments</button>
            <button type="button" onClick={() => go('/student/learning')}>📚 Learning</button>
            <button type="button" onClick={() => go('/student/documents')}>📄 Documents</button>
            <button type="button" onClick={() => go('/student/profile')}>👤 Update profile</button>
            <button type="button" onClick={() => go('/student/readiness')}>📈 Readiness</button>
            <button type="button" onClick={() => go('/student/help')}>❓ Help &amp; FAQ</button>
          </div>
        </section>
      </div>

      <div className="v2-rail">
        {upcoming.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Upcoming</h2></div>
            <div className="v2-list">
              {upcoming.map((entry, index) => {
                const date = shortDate(entry.at);
                return (
                  <div key={index} className="v2-list-row">
                    <span className="v2-date"><b>{date.month}</b><span>{date.day}</span></span>
                    <div className="grow"><strong>{entry.title}</strong><small>{entry.detail}</small></div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        {data.activity ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Your week</h2>
              {data.activity.activeDaysLast7 > 0 ? <V2Chip tone="green">{data.activity.activeDaysLast7} active day{data.activity.activeDaysLast7 === 1 ? '' : 's'}</V2Chip> : null}</div>
            <div className="v2-week">
              {data.activity.last7.map((entry) => (
                <div key={entry.date} className="v2-week-day">
                  <i className={entry.count > 0 ? 'on' : ''} title={`${entry.date}: ${entry.count} action${entry.count === 1 ? '' : 's'}`}>
                    {entry.count > 0 ? '✓' : ''}
                  </i>
                  <small>{new Date(`${entry.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })}</small>
                </div>
              ))}
            </div>
            <p className="v2-boundary">A day counts when you complete a lesson or work an assessment — real actions only.</p>
          </section>
        ) : null}
        <section className="v2-assist">
          <strong>✦ Ask ONE</strong>
          <p>Stuck? The assistant answers from the product guide — use the sparkle button, or browse the FAQ.</p>
          <button type="button" onClick={() => go('/student/help')}>How do I take an assessment?</button>
          <button type="button" onClick={() => go('/student/help')}>Why can&apos;t I start my assessment?</button>
        </section>
        {data.notifications?.notifications?.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Notifications</h2>{data.notifications.unreadCount > 0 ? <V2Chip tone="amber">{data.notifications.unreadCount} new</V2Chip> : null}</div>
            <div className="v2-list">
              {data.notifications.notifications.slice(0, 3).map((notification) => (
                <div key={notification.id} className="v2-list-row">
                  <div className="grow"><strong>{notification.title}</strong><small>{notification.body}</small></div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

// --- Institution -------------------------------------------------------------

interface InstitutionDashboardData {
  readonly students: readonly InstitutionStudentDto[] | null;
  readonly staff: InstitutionStaffDto | null;
  readonly exams: readonly InstitutionExamDto[] | null;
  readonly subjects: readonly ExamSubjectDto[] | null;
  readonly underReview: number | null;
  readonly units: readonly InstitutionUnitDto[] | null;
  readonly results: {
    readonly exam: InstitutionExamDto;
    readonly rows: readonly Record<string, unknown>[];
    readonly notAttempted: readonly ExamNotAttemptedDto[];
    readonly summary: { readonly attempts: number; readonly averagePercentage: number; readonly assigned: number; readonly notAttemptedCount: number };
  } | null;
}

export function InstitutionDashboardV2({ institutionId, basePath }: { readonly institutionId: string; readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<InstitutionDashboardData | null>(null);
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void Promise.all([
      listInstitutionStudents(token, institutionId, controller.signal).then((response) => response.students).catch(() => null),
      listInstitutionStaff(token, institutionId, controller.signal).then((response) => response.staff).catch(() => null),
      listInstitutionExams(token, institutionId, controller.signal).then((response) => response.assessments).catch(() => null),
      listExamSubjects(token, institutionId, controller.signal).then((response) => response.subjects).catch(() => null),
      listExamQuestions(token, institutionId, { status: 'UNDER_REVIEW' }, controller.signal).then((response) => response.questions.length).catch(() => null),
      listInstitutionUnits(token, institutionId, controller.signal).then((response) => response.units).catch(() => null),
    ]).then(async ([students, staff, exams, subjects, underReview, units]) => {
      const resultsTarget = exams?.find((exam) => exam.lifecycleState === 'PUBLISHED' && exam.assignedCount > 0) ?? null;
      const results = resultsTarget
        ? await listInstitutionExamResults(token, institutionId, resultsTarget.id).then((response) => ({ exam: resultsTarget, rows: response.results, notAttempted: response.notAttempted, summary: response.summary })).catch(() => null)
        : null;
      setData({ students, staff, exams, subjects, underReview, units, results });
    });
    return () => controller.abort();
  }, [token, institutionId]);

  if (!data) return <section className="v2-card"><h2>Dashboard</h2><p className="v2-empty">Loading your institution workspace…</p></section>;

  const exams = data.exams ?? [];
  const published = exams.filter((exam) => exam.lifecycleState === 'PUBLISHED');
  const drafts = exams.filter((exam) => exam.lifecycleState === 'DRAFT');
  const activeStudents = (data.students ?? []).filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE');
  const memberships = data.staff?.memberships ?? [];
  const departmentUnits = (data.units ?? []).filter((unit) => unit.kind === 'DEPARTMENT');
  const byDepartment = departmentUnits.map((unit) => ({
    name: unit.name,
    count: (data.students ?? []).filter((student) => Object.values(student.units ?? {}).includes(unit.id)).length,
  })).filter((entry) => entry.count > 0);
  const now = Date.now();
  const upcoming = [
    ...exams.filter((exam) => Date.parse(exam.startsAt) > now).map((exam) => ({ at: exam.startsAt, title: `${exam.title} opens`, detail: exam.lifecycleState === 'DRAFT' ? 'Publish before the window' : `${exam.assignedCount} assigned` })),
    ...published.filter((exam) => Date.parse(exam.endsAt) > now && Date.parse(exam.startsAt) <= now).map((exam) => ({ at: exam.endsAt, title: `${exam.title} closes`, detail: `${exam.completedAttempts} of ${exam.assignedCount} attempted` })),
  ].sort((left, right) => left.at.localeCompare(right.at)).slice(0, 4);
  const attention: { readonly icon: string; readonly tone: string; readonly title: string; readonly detail: string }[] = [];
  if ((data.underReview ?? 0) > 0) attention.push({ icon: '🕒', tone: 'amber', title: `${data.underReview} question${data.underReview === 1 ? '' : 's'} in review`, detail: 'Awaiting senior approval' });
  if (data.results && data.results.summary.notAttemptedCount > 0) attention.push({ icon: '📣', tone: 'blue', title: `${data.results.summary.notAttemptedCount} not attempted`, detail: data.results.exam.title });
  if (drafts.length > 0) attention.push({ icon: '✏️', tone: 'purple', title: `${drafts.length} draft exam${drafts.length === 1 ? '' : 's'}`, detail: drafts[0]!.title });

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">Institution workspace</p>
            <h1>{greeting()} 👋</h1>
            <p>{attention.length ? <><b>{attention[0]!.title}</b> — {attention[0]!.detail}.</> : 'Nothing needs your attention right now.'}</p>
            <div className="v2-hero-chips"><V2Chip tone="green">Access-controlled</V2Chip><V2Chip tone="blue">Institution scope only</V2Chip></div>
          </div>
          {data.results ? <V2Ring percent={data.results.summary.averagePercentage} value={`${data.results.summary.averagePercentage}%`} label={`CLASS AVERAGE · ${data.results.exam.subjectName.toUpperCase()}`} tone="#0d6b4f" /> : null}
        </div>

        <div className="v2-row v2-cols-4">
          {data.students ? <V2Stat icon="🎓" tone="blue" value={activeStudents.length} label="Active students" /> : null}
          {data.staff ? <V2Stat icon="👥" tone="teal" value={memberships.length} label="Staff memberships" /> : null}
          <V2Stat icon="📝" tone="green" value={<>{published.length}{drafts.length ? <span className="v2-stat-extra"> +{drafts.length} draft</span> : null}</>} label="Published exams" />
          {data.underReview !== null ? <V2Stat icon="🕒" tone="amber" value={data.underReview} label="Questions in review" /> : null}
        </div>

        {exams.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Assessment pipeline</h2><button type="button" className="v2-link" onClick={() => go(`${basePath}/assessments`)}>Open Assessments</button></div>
            <div className="v2-list">
              {exams.slice(0, 4).map((exam) => (
                <div key={exam.id} className="v2-list-row">
                  <span className={`v2-tile ${exam.lifecycleState === 'PUBLISHED' ? 'green' : 'amber'}`} aria-hidden="true">{exam.lifecycleState === 'PUBLISHED' ? '📝' : '✏️'}</span>
                  <div className="grow">
                    <strong>{exam.title}</strong>
                    <small>{formatDate(exam.startsAt)} → {formatDate(exam.endsAt)} · {exam.totalMarks} marks · {Math.round(exam.durationSeconds / 60)} min · {exam.assignedCount} assigned</small>
                    {exam.assignedCount > 0 ? <><V2Bar percent={(exam.completedAttempts / exam.assignedCount) * 100} tone="green" /><small>{exam.completedAttempts} of {exam.assignedCount} attempts completed</small></> : null}
                  </div>
                  <V2Chip tone={chipToneForState(exam.lifecycleState)}>{codeLabel(exam.lifecycleState)}</V2Chip>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="v2-row v2-cols-2">
          {data.results ? (
            <section className="v2-card">
              <div className="v2-card-head"><h2>Results — {data.results.exam.title}</h2><V2Chip tone="blue">avg {data.results.summary.averagePercentage}%</V2Chip></div>
              <div className="v2-list">
                {data.results.rows.slice(0, 4).map((row, index) => {
                  const percentage = Number(row['percentage'] ?? 0);
                  return (
                    <div key={index} className="v2-list-row">
                      <div className="grow"><strong>{String(row['studentName'] ?? '')}</strong>
                        <small>{String(row['score'] ?? '')} / {String(row['maxScore'] ?? '')}{Number(row['screenShiftCount'] ?? 0) > 0 ? ` · ${row['screenShiftCount']} focus losses` : ''}{row['autoSubmitted'] ? ' · auto-submitted' : ''}</small>
                        <V2Bar percent={percentage} tone={percentage >= 60 ? 'green' : 'amber'} /></div>
                      <V2Chip tone={percentage >= 60 ? 'green' : 'amber'}>{percentage}%</V2Chip>
                    </div>
                  );
                })}
              </div>
              {data.results.notAttempted.length ? <p className="v2-boundary">Not attempted: {data.results.notAttempted.map((entry) => `${entry.studentName}${entry.inProgress ? ' (in progress now)' : ''}`).join(', ')}.</p> : null}
            </section>
          ) : null}
          {data.subjects?.length ? (
            <section className="v2-card">
              <div className="v2-card-head"><h2>Question bank</h2><button type="button" className="v2-link" onClick={() => go(`${basePath}/assessments`)}>Review queue</button></div>
              <div className="v2-list">
                {data.subjects.slice(0, 4).map((subject) => (
                  <div key={subject.id} className="v2-list-row">
                    <div className="grow"><strong>{subject.name}</strong><small>{subject.approvedQuestions} approved</small></div>
                  </div>
                ))}
              </div>
              <p className="v2-boundary">Only approved questions can enter an exam. Publishing re-validates the pool.</p>
            </section>
          ) : null}
        </div>

        {byDepartment.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Roster by department</h2><button type="button" className="v2-link" onClick={() => go(`${basePath}/students`)}>Open Students</button></div>
            <div className="v2-row v2-cols-4">
              {byDepartment.slice(0, 4).map((entry) => (
                <div key={entry.name} className="v2-stat"><span className="v2-tile blue" aria-hidden="true">🎓</span><div><b>{entry.count}</b><small>{entry.name}</small></div></div>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      <div className="v2-rail">
        {attention.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Needs attention</h2><V2Chip tone="amber">{attention.length}</V2Chip></div>
            <div className="v2-list">
              {attention.map((entry, index) => (
                <div key={index} className="v2-list-row"><span className={`v2-tile ${entry.tone}`} aria-hidden="true">{entry.icon}</span><div className="grow"><strong>{entry.title}</strong><small>{entry.detail}</small></div></div>
              ))}
            </div>
          </section>
        ) : null}
        {memberships.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Staff</h2><button type="button" className="v2-link" onClick={() => go(`${basePath}/staff`)}>Manage</button></div>
            <div className="v2-list">
              {memberships.slice(0, 4).map((member) => (
                <div key={member.id} className="v2-list-row">
                  <div className="grow"><strong>{member.email}</strong><small>{prettify(member.role)}</small></div>
                  <V2Chip tone={chipToneForState(member.state)}>{codeLabel(member.state)}</V2Chip>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {upcoming.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Upcoming windows</h2></div>
            <div className="v2-list">
              {upcoming.map((entry, index) => {
                const date = shortDate(entry.at);
                return (
                  <div key={index} className="v2-list-row">
                    <span className="v2-date"><b>{date.month}</b><span>{date.day}</span></span>
                    <div className="grow"><strong>{entry.title}</strong><small>{entry.detail}</small></div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

// --- Employer ----------------------------------------------------------------

interface EmployerDashboardData {
  readonly employerId: string;
  readonly opportunities: readonly EmployerOpportunityDto[];
  readonly applicants: readonly (EmployerApplicantDto & { readonly opportunityTitle: string })[];
}

export function EmployerDashboardV2({ basePath }: { readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [data, setData] = useState<EmployerDashboardData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    void getSecurityContext(token, controller.signal).then(async (context) => {
      const membership = context.memberships.find((item) => ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(item.role));
      if (!membership) { setError('This identity has no active employer-scoped membership.'); return; }
      const opportunities = await listEmployerOpportunities(token, membership.organizationId, controller.signal).then((response) => response.opportunities).catch(() => [] as readonly EmployerOpportunityDto[]);
      const withApplicants = opportunities.filter((opportunity) => opportunity.applicationCount > 0).slice(0, 3);
      const applicantGroups = await Promise.all(withApplicants.map((opportunity) =>
        listEmployerApplicants(token, membership.organizationId, opportunity.id, controller.signal)
          .then((response) => response.applications.map((applicant) => ({ ...applicant, opportunityTitle: opportunity.title ?? opportunity.referenceCode })))
          .catch(() => [])));
      setData({ employerId: membership.organizationId, opportunities, applicants: applicantGroups.flat() });
    }).catch(() => setError('Unable to resolve employer context.'));
    return () => controller.abort();
  }, [token]);

  if (error) return <section className="v2-card"><h2>Dashboard</h2><p className="v2-empty">{error}</p></section>;
  if (!data) return <section className="v2-card"><h2>Dashboard</h2><p className="v2-empty">Loading your employer workspace…</p></section>;

  const publishedRoles = data.opportunities.filter((opportunity) => opportunity.lifecycleState === 'PUBLISHED');
  const draftRoles = data.opportunities.filter((opportunity) => opportunity.lifecycleState !== 'PUBLISHED');
  const totalApplications = data.opportunities.reduce((sum, opportunity) => sum + opportunity.applicationCount, 0);
  const openApplications = data.opportunities.reduce((sum, opportunity) => sum + opportunity.openApplicationCount, 0);
  const interviews = data.applicants.reduce((sum, applicant) => sum + applicant.interviewCount, 0);
  const byState = new Map<string, number>();
  for (const applicant of data.applicants) byState.set(applicant.state, (byState.get(applicant.state) ?? 0) + 1);
  const recentApplicants = [...data.applicants].sort((left, right) => (right.submittedAt ?? right.updatedAt).localeCompare(left.submittedAt ?? left.updatedAt)).slice(0, 5);

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">Employer workspace</p>
            <h1>{greeting()} 👋</h1>
            <p>{openApplications > 0 ? <><b>{openApplications} open application{openApplications === 1 ? '' : 's'}</b> across your roles await review.</> : 'No open applications right now.'}</p>
            <div className="v2-hero-chips"><V2Chip tone="green">Access-controlled</V2Chip><V2Chip tone="amber">Consent-based candidate access</V2Chip></div>
          </div>
          {totalApplications > 0 ? <V2Ring percent={(openApplications / totalApplications) * 100} value={`${openApplications}/${totalApplications}`} label="APPLICATIONS OPEN" tone="#b45309" /> : null}
        </div>

        <div className="v2-row v2-cols-4">
          <V2Stat icon="💼" tone="blue" value={<>{publishedRoles.length}{draftRoles.length ? <span className="v2-stat-extra"> +{draftRoles.length} draft</span> : null}</>} label="Open roles" />
          <V2Stat icon="📥" tone="green" value={totalApplications} label="Applications" />
          <V2Stat icon="⭐" tone="purple" value={byState.get('SHORTLISTED') ?? 0} label="Shortlisted" />
          <V2Stat icon="📅" tone="amber" value={interviews} label="Interviews" />
        </div>

        {data.opportunities.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Role pipeline</h2><button type="button" className="v2-link" onClick={() => go(`${basePath}/opportunities`)}>Open Opportunities</button></div>
            <div className="v2-list">
              {data.opportunities.slice(0, 4).map((opportunity) => (
                <div key={opportunity.id} className="v2-list-row">
                  <span className={`v2-tile ${opportunity.lifecycleState === 'PUBLISHED' ? 'blue' : 'amber'}`} aria-hidden="true">{opportunity.lifecycleState === 'PUBLISHED' ? '💼' : '✏️'}</span>
                  <div className="grow">
                    <strong>{opportunity.title ?? opportunity.referenceCode}</strong>
                    <small>{[opportunity.employmentType ? prettify(opportunity.employmentType) : null, opportunity.locationCity, opportunity.applicationDeadline ? `deadline ${formatDate(opportunity.applicationDeadline)}` : null].filter(Boolean).join(' · ') || 'Details pending'}</small>
                    {opportunity.applicationCount > 0 ? <><V2Bar percent={((opportunity.applicationCount - opportunity.openApplicationCount) / opportunity.applicationCount) * 100} /><small>{opportunity.applicationCount} applied · {opportunity.openApplicationCount} open</small></> : null}
                  </div>
                  <V2Chip tone={chipToneForState(opportunity.lifecycleState)}>{codeLabel(opportunity.lifecycleState)}</V2Chip>
                </div>
              ))}
            </div>
          </section>
        ) : <section className="v2-card"><h2>Role pipeline</h2><p className="v2-empty">No roles yet. Create your first opportunity to start receiving consented applications.</p></section>}

        {recentApplicants.length ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Recent applicants</h2><V2Chip tone="slate">Consented profiles only</V2Chip></div>
            <div className="v2-list">
              {recentApplicants.map((applicant) => (
                <div key={applicant.id} className="v2-list-row">
                  <div className="grow"><strong>{applicant.candidateName ?? 'Candidate'}</strong><small>{applicant.opportunityTitle}{applicant.institutionStudentId ? ` · ${applicant.institutionStudentId}` : ''}</small></div>
                  <V2Chip tone={chipToneForState(applicant.state)}>{prettify(applicant.state)}</V2Chip>
                </div>
              ))}
            </div>
            <p className="v2-boundary">Candidates appear only after they consent to share their profile. Internal readiness scores are never shown to employers — by design.</p>
          </section>
        ) : null}
      </div>

      <div className="v2-rail">
        {byState.size ? (
          <section className="v2-card">
            <div className="v2-card-head"><h2>Pipeline summary</h2></div>
            <div className="v2-list">
              {[...byState.entries()].map(([state, count]) => (
                <div key={state} className="v2-list-row">
                  <div className="grow"><strong>{prettify(state)}</strong><V2Bar percent={(count / Math.max(1, data.applicants.length)) * 100} /></div>
                  <V2Chip tone={chipToneForState(state)}>{count}</V2Chip>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <section className="v2-assist">
          <strong>✦ Ask ONE</strong>
          <p>The assistant answers from the employer guide.</p>
          <button type="button" onClick={() => go(`${basePath}/help-faq`)}>How do I meet candidates?</button>
          <button type="button" onClick={() => go(`${basePath}/help-faq`)}>How do campus drives work?</button>
        </section>
      </div>
    </div>
  );
}

// --- Operations --------------------------------------------------------------
//
// OPS-03: the Overview renders one server-side summary (GET /operations/overview) whose
// counts are computed in bounded SQL — it no longer fetches the organisation, invitation
// and user lists and counts them here (each list stopped at 200 rows, so the numbers were
// wrong above that). Every widget stays on the page: a section the caller's capabilities
// do not cover arrives as null and shows NA in the same slot, a count of fewer than 5
// people shows <5, and each queue links to the screen that works it. No names, emails or
// other personal data are in the summary.

const NA = 'NA';

export function formatOverviewCount(count: OverviewCountDto | null | undefined): string {
  if (!count) return NA;
  return count.capped ? `${count.value.toLocaleString()}+` : count.value.toLocaleString();
}

export function formatOverviewPeople(count: OverviewPeopleCountDto | null | undefined): string {
  if (!count) return NA;
  if (count.suppressed) return '<5';
  return count.capped ? `${count.value.toLocaleString()}+` : count.value.toLocaleString();
}

/** A share for a bar or ring, or 0 when either side is unknown or suppressed. */
function share(part: number | null | undefined, whole: number | null | undefined): number {
  return part != null && whole ? (part / whole) * 100 : 0;
}

interface OperationsQueue {
  readonly key: string;
  readonly icon: string;
  readonly tone: string;
  readonly title: string;
  readonly count: OverviewCountDto | null;
  readonly detail: string | null;
  readonly screen: string;
  readonly path: string;
}

function operationsQueues(overview: OperationsOverviewDto): readonly OperationsQueue[] {
  const { verification, employerAccessRequests, invitations, trustSafety, jobs, privacyRequests, privacyHolds, approvals, support } = overview;
  return [
    {
      key: 'verification', icon: '🛂', tone: 'blue', title: 'Organizations awaiting verification', count: verification?.awaitingDecision ?? null,
      detail: verification ? `${formatOverviewCount(verification.underReview)} under review` : null, screen: 'Verification', path: '/verification',
    },
    {
      key: 'employer-access', icon: '📨', tone: 'amber', title: 'Employer access requests', count: employerAccessRequests?.pending ?? null,
      detail: employerAccessRequests
        ? (employerAccessRequests.oldestPendingAt ? `Oldest waiting since ${formatDate(employerAccessRequests.oldestPendingAt)}` : 'None waiting')
        : null,
      screen: 'Organizations', path: '/organizations',
    },
    {
      key: 'stale-invitations', icon: '⏰', tone: 'amber', title: 'Invitations pending over 72 hours', count: invitations?.staff.pendingOver72Hours ?? null,
      detail: invitations ? `${formatOverviewCount(invitations.staff.expiredUnaccepted)} expired without being accepted` : null, screen: 'Users', path: '/users',
    },
    {
      key: 'student-invitations', icon: '🎓', tone: 'purple', title: 'Student invitations not delivered', count: invitations?.student.notDelivered ?? null,
      detail: invitations
        ? `Of ${formatOverviewCount(invitations.student.pending)} pending · ${formatOverviewCount(invitations.student.byDelivery.FAILED)} failed · ${formatOverviewCount(invitations.student.byDelivery.BOUNCED)} bounced · ${formatOverviewCount(invitations.student.pendingOver72Hours)} over 72 hours`
        : null,
      screen: 'Users', path: '/users',
    },
    {
      key: 'trust', icon: '🛡️', tone: 'purple', title: 'Open trust and safety cases', count: trustSafety?.open ?? null,
      detail: trustSafety
        ? `Critical ${formatOverviewCount(trustSafety.bySeverity.CRITICAL)} · high ${formatOverviewCount(trustSafety.bySeverity.HIGH)} · unassigned ${formatOverviewCount(trustSafety.unassigned)}`
        : null,
      screen: 'Trust and Safety', path: '/trust-and-safety',
    },
    {
      key: 'jobs', icon: '⛔', tone: 'amber', title: 'Failed background events', count: jobs?.failedEvents ?? null,
      detail: jobs ? `${formatOverviewCount(jobs.openAlerts)} open health alerts` : null, screen: 'System Health', path: '/system-health',
    },
    {
      key: 'privacy', icon: '🔏', tone: 'teal', title: 'Open privacy requests', count: privacyRequests?.open ?? null,
      detail: privacyRequests
        ? `${formatOverviewCount(privacyRequests.deletionsDueWithin7Days)} deletions scheduled within 7 days · ${formatOverviewCount(privacyRequests.failed)} failed`
        : null,
      screen: 'Security', path: '/security',
    },
    {
      key: 'holds', icon: '⚖️', tone: 'teal', title: 'Active legal holds', count: privacyHolds?.active ?? null,
      detail: privacyHolds ? 'Releasing a hold needs a second person’s approval' : null, screen: 'Security', path: '/security',
    },
    {
      key: 'approvals', icon: '✅', tone: 'green', title: 'Approvals awaiting a decision', count: approvals?.pending ?? null,
      detail: approvals ? `${formatOverviewCount(approvals.awaitingExecution)} approved, awaiting execution` : null, screen: 'Settings', path: '/settings',
    },
    {
      key: 'support', icon: '🎧', tone: 'blue', title: 'Open support cases', count: support?.open ?? null,
      detail: support ? `${formatOverviewCount(support.overdue)} past their SLA · ${formatOverviewCount(support.unassigned)} unassigned` : null,
      screen: 'Support', path: '/support',
    },
  ];
}

type OperationsOverviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly overview: OperationsOverviewDto }
  | { readonly kind: 'forbidden'; readonly reference: string }
  | { readonly kind: 'error'; readonly reference: string | null };

export function OperationsDashboardV2({ basePath }: { readonly basePath: string }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [state, setState] = useState<OperationsOverviewState>({ kind: 'loading' });
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    getOperationsOverview(token, controller.signal)
      .then((response) => setState({ kind: 'ready', overview: response.overview }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setState({ kind: 'forbidden', reference: cause.correlationId });
        else setState({ kind: 'error', reference: cause instanceof ApiRequestError ? cause.correlationId : null });
      });
    return () => controller.abort();
  }, [token]);

  if (state.kind === 'loading') return <section className="v2-card"><h2>Overview</h2><p className="v2-empty">Loading the operations workspace…</p></section>;
  if (state.kind === 'forbidden') {
    return <V2EmptyState icon="🔐" title="Not permitted" note="The operations overview is for AI8HT operations staff. Your access has not changed." hint={<SupportCode reference={state.reference} />} />;
  }
  if (state.kind === 'error') {
    return <V2EmptyState icon="⚠️" title="The overview could not be loaded" note="Nothing on this page is shown until the server's counts load. Try again shortly."
      {...(state.reference ? { hint: <SupportCode reference={state.reference} /> } : {})} />;
  }

  const { overview } = state;
  const { organizations, invitations, accounts } = overview;
  const staff = invitations?.staff ?? null;
  const pending = staff?.pending.value ?? null;
  const queues = operationsQueues(overview);
  const open = (path: string) => () => go(`${basePath}${path}`);

  return (
    <div className="v2-page">
      <div className="v2-content">
        <div className="v2-hero">
          <div>
            <p className="v2-hero-over">ONE Platform · Operations workspace</p>
            <h1>{greeting()} 👋</h1>
            <p>{staff === null ? 'Invitation counts are NA for your access.'
              : pending ? <><b>{formatOverviewCount(staff.pending)} invitation{pending === 1 ? '' : 's'}</b> pending acceptance.</> : 'No invitations are pending.'}</p>
            <div className="v2-hero-chips"><V2Chip tone="green">Access-controlled</V2Chip><V2Chip tone="slate">Full controls on web · view only in the app</V2Chip></div>
          </div>
          <V2Ring percent={share(staff?.accepted.value, staff?.total.value)}
            value={staff ? `${formatOverviewCount(staff.accepted)}/${formatOverviewCount(staff.total)}` : NA} label="INVITATIONS ACCEPTED" tone="#475569" />
        </div>

        <div className="v2-row v2-cols-4">
          <V2Stat icon="🏛️" tone="blue" value={formatOverviewCount(organizations?.total)} label="Organizations" />
          <V2Stat icon="👥" tone="teal" value={formatOverviewPeople(accounts?.total)} label="Accounts" />
          <V2Stat icon="✉️" tone="amber" value={formatOverviewCount(staff?.pending)} label="Pending invitations" />
          <V2Stat icon="🏢" tone="purple" value={<>{formatOverviewCount(organizations?.institutions.total)} <span className="v2-stat-extra">{organizations?.institutions.total?.value === 1 ? 'college' : 'colleges'}</span> · {formatOverviewCount(organizations?.employers.total)} <span className="v2-stat-extra">{organizations?.employers.total?.value === 1 ? 'employer' : 'employers'}</span></>} label="By kind" />
        </div>

        <section className="v2-card" aria-label="Operator queues">
          <div className="v2-card-head"><h2>Operator queues</h2><V2Chip tone="slate">Live counts</V2Chip></div>
          <div className="v2-list">
            {queues.map((queue) => (
              <div key={queue.key} className="v2-list-row" data-queue={queue.key}>
                <span className={`v2-tile ${queue.tone}`} aria-hidden="true">{queue.icon}</span>
                <div className="grow"><strong>{queue.title}</strong><small>{queue.detail ?? 'NA — not available with your access.'}</small></div>
                <V2Chip tone={queue.count ? (queue.count.value > 0 ? 'amber' : 'green') : 'slate'}>{formatOverviewCount(queue.count)}</V2Chip>
                <button type="button" className="v2-link" onClick={open(queue.path)}>Open {queue.screen}</button>
              </div>
            ))}
          </div>
          <p className="v2-boundary">A queue you cannot open shows NA. Counts stop at 10,000 and then read 10,000+.</p>
        </section>

        <section className="v2-card">
          <div className="v2-card-head"><h2>Organizations</h2><button type="button" className="v2-link" onClick={open('/organizations')}>Open Organizations</button></div>
          {organizations === null ? <p className="v2-empty">NA — organization management is not part of your access.</p>
            : organizations.recent.length ? (
              <div className="v2-list">
                {organizations.recent.map((organization) => (
                  <div key={organization.id} className="v2-list-row">
                    <span className={`v2-tile ${organization.kind === 'INSTITUTION' ? 'blue' : 'amber'}`} aria-hidden="true">{organization.kind === 'INSTITUTION' ? '🏛️' : '🏢'}</span>
                    <div className="grow"><strong>{organization.name}</strong><small>{prettify(organization.kind)} · {prettify(organization.verificationState)}</small></div>
                    <V2Chip tone={organization.active ? 'green' : 'slate'}>{organization.active ? 'Active' : 'Inactive'}</V2Chip>
                  </div>
                ))}
              </div>
            ) : <p className="v2-empty">No organizations onboarded yet.</p>}
        </section>

        <div className="v2-row v2-cols-2">
          <section className="v2-card">
            <div className="v2-card-head"><h2>Invitations</h2>{staff ? <V2Chip tone="amber">{formatOverviewCount(staff.pending)} pending</V2Chip> : <V2Chip tone="slate">NA</V2Chip>}</div>
            {invitations === null ? <p className="v2-empty">NA — invitation tracking is not part of your access.</p>
              : invitations.recent.length ? (
                <div className="v2-list">
                  {invitations.recent.map((invitation) => (
                    <div key={invitation.id} className="v2-list-row">
                      <div className="grow"><strong>{invitation.role ? roleLabel(invitation.role) : 'Invitation'}</strong><small>{invitation.organizationName ?? 'No organization'} · sent {formatDate(invitation.createdAt)}</small></div>
                      <V2Chip tone={chipToneForState(invitation.state)}>{codeLabel(invitation.state)}</V2Chip>
                    </div>
                  ))}
                </div>
              ) : <p className="v2-empty">No invitations sent yet.</p>}
            <p className="v2-boundary">Membership is created only after the verified recipient accepts. Recipients are listed on the Users screen, not here.</p>
          </section>
          <section className="v2-card">
            <div className="v2-card-head"><h2>Accounts</h2><button type="button" className="v2-link" onClick={open('/users')}>Open Users</button></div>
            <div className="v2-list">
              <div className="v2-list-row"><div className="grow"><strong>Student accounts</strong><V2Bar percent={share(accounts?.students.value, accounts?.total.value)} /></div><V2Chip tone="blue">{formatOverviewPeople(accounts?.students)}</V2Chip></div>
              <div className="v2-list-row"><div className="grow"><strong>With organization roles</strong><V2Bar percent={share(accounts?.withOrganizationRoles.value, accounts?.total.value)} tone="green" /></div><V2Chip tone="green">{formatOverviewPeople(accounts?.withOrganizationRoles)}</V2Chip></div>
              <div className="v2-list-row"><div className="grow"><strong>All accounts</strong><V2Bar percent={accounts && !accounts.total.suppressed ? 100 : 0} tone="" /></div><V2Chip tone="slate">{formatOverviewPeople(accounts?.total)}</V2Chip></div>
            </div>
            <p className="v2-boundary">{accounts === null ? 'NA — aggregate analytics is not part of your access.' : 'Counts of fewer than 5 people show <5.'}</p>
          </section>
        </div>
      </div>

      <div className="v2-rail">
        <section className="v2-card">
          <div className="v2-card-head"><h2>Needs attention</h2>{staff ? <V2Chip tone="amber">{formatOverviewCount(staff.pending)}</V2Chip> : <V2Chip tone="slate">NA</V2Chip>}</div>
          {invitations === null ? <p className="v2-empty">NA — invitation tracking is not part of your access.</p>
            : invitations.expiringSoon.length ? (
              <div className="v2-list">
                {invitations.expiringSoon.map((invitation) => {
                  const date = shortDate(invitation.expiresAt);
                  return (
                    <div key={invitation.id} className="v2-list-row">
                      <span className="v2-date"><b>{date.month}</b><span>{date.day}</span></span>
                      <div className="grow"><strong>Invitation expires</strong><small>{invitation.role ? roleLabel(invitation.role) : 'Invitation'}{invitation.organizationName ? ` · ${invitation.organizationName}` : ''}</small></div>
                    </div>
                  );
                })}
              </div>
            ) : <p className="v2-empty">No pending invitation is waiting to expire.</p>}
        </section>
        <section className="v2-card">
          <div className="v2-card-head"><h2>Protected boundaries</h2></div>
          <p className="v2-empty">Operations never sees student private readiness state, employer hiring records beyond scope, or secrets. The overview carries counts only — no names or contact details. The mobile app is view-only for this role by policy.</p>
        </section>
      </div>
    </div>
  );
}
