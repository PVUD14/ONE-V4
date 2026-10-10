/**
 * The Momentum student home (re-skin phase 5): the hero with the band climb, the next climb, the
 * streak, and the dashboard cards from the approved page (inventory unified/student-home.html,
 * mobile.html), each wired to data the dashboard already loads.
 *
 * It exists as its own module so the dashboard's data loading, support and reports stay where
 * they were and this file only decides what to draw. The rule it follows is the approved guide's:
 * a block renders only when its data exists, and never a placeholder ("NA", a made-up 0, a sample
 * name) in its place. Readiness is drawn only by <ReadinessBand>, from the band code, never as a
 * number; course and lesson progress may be a percentage.
 */
import React from 'react';
import { Icon, type IconName } from './icons/Icon.js';
import { ReadinessBand, READINESS_BAND_LABELS, READINESS_BANDS, toReadinessBand } from './momentum/readinessBand.js';
import { StatusTag } from './momentum/statusTag.js';
import { CountUp } from './momentum/useCountUp.js';
import type {
  CalendarEntryDto,
  LearnerCareerReadinessState,
  StudentActivityDto,
  StudentApplicationDto,
  StudentExamDto,
  StudentProfileDto,
  UserNotificationDto,
} from './api.js';

export interface StudentHomeData {
  readonly profile: StudentProfileDto | null;
  readonly learner: LearnerCareerReadinessState | null;
  readonly exams: readonly StudentExamDto[] | null;
  readonly notifications: { readonly notifications: readonly UserNotificationDto[]; readonly unreadCount: number } | null;
  readonly activity: StudentActivityDto | null;
  readonly applications: readonly StudentApplicationDto[] | null;
  /** The student's own calendar (interviews, exam windows, tasks, roadmap dates); null when it could not be read. */
  readonly calendar: readonly CalendarEntryDto[] | null;
}

export function go(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function validTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function shortDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function relativeWhen(iso: string, now: number): string | null {
  const time = validTime(iso);
  if (time === null) return null;
  const hours = Math.floor((now - time) / 3600000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

function daysUntil(time: number, now: number): string {
  const startOfDay = (value: number) => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const days = Math.round((startOfDay(time) - startOfDay(now)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

function sentence(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function initials(name: string): string {
  return name.split(/\s+/).filter((word) => /^[A-Za-z0-9]/.test(word)).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('');
}

/** The chevron that marks a climb (the approved eyebrow mark). */
function ClimbMark({ size = 12 }: { readonly size?: number }): React.ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
    <path fillRule="evenodd" d="M3.57 14.57Q3 14 3.6 13.47L11.4 6.53Q12 6 12.6 6.53L20.4 13.47Q21 14 20.43 14.57L18.57 16.43Q18 17 17.41 16.46L12.59 12.14Q12 11.6 11.41 12.14L6.59 16.46Q6 17 5.43 16.43Z" />
  </svg>;
}

function Flame(): React.ReactElement {
  return <svg className="sh-flame-ic" width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
    <path fillRule="evenodd" d="M11.9 4.2Q12.4 1.8 13.96 3.69L14.54 4.4Q16.2 6.4 17.58 8.6L18.09 9.42Q19.2 11.2 19.2 13.3L19.2 13.3Q19.2 15.4 18.19 17.24L18 17.6Q16.8 19.8 14.52 20.84L14.36 20.92Q12 22 9.64 20.92L9.48 20.84Q7.2 19.8 6 17.6L5.82 17.26Q4.8 15.4 5.1 13.3L5.1 13.3Q5.4 11.2 6.8 9.6L6.99 9.38Q8.2 8 8.9 9.7L8.9 9.7Q9.6 11.4 10.25 9.68L10.54 8.9Q11.4 6.6 11.9 4.2ZM11.06 12.9Q12 11.6 13.02 12.84L13.84 13.84Q14.8 15 14.7 16.5L14.7 16.5Q14.6 18 13.32 18.79L13.3 18.8Q12 19.6 10.7 18.8L10.59 18.73Q9.4 18 9.4 16.6L9.4 16.6Q9.4 15.2 10.22 14.07Z" />
  </svg>;
}

function CardHead({ id, title, children }: { readonly id: string; readonly title: string; readonly children?: React.ReactNode }): React.ReactElement {
  return <div className="sh-ch"><h2 id={id}>{title}</h2>{children}</div>;
}

function CardLink({ label, path, href }: { readonly label: string; readonly path?: string; readonly href?: string }): React.ReactElement {
  if (href) return <a className="sh-lnk" href={href}>{label} <Icon name="arrow-right" size={16} /></a>;
  return <button type="button" className="sh-lnk" onClick={() => go(path ?? '/student')}>{label} <Icon name="arrow-right" size={16} /></button>;
}

// ---------------------------------------------------------------------------------------------
// Derived state: everything below is computed from the loaded records, nothing is assumed.
// ---------------------------------------------------------------------------------------------

type Lesson = LearnerCareerReadinessState['catalog']['modules'][number]['lessons'][number];
type Module = LearnerCareerReadinessState['catalog']['modules'][number];

export interface PlanItem {
  readonly key: string;
  readonly title: string;
  /** Where the item comes from, and its length only when a record says so. */
  readonly meta: string;
  readonly icon: IconName;
  readonly path: string;
  readonly done: boolean;
}

interface NextClimb {
  readonly item: PlanItem;
  readonly detail: string | null;
  /** Course progress (lessons completed of the course), never readiness. */
  readonly coursePercent: number | null;
  readonly action: string;
}

interface Derived {
  readonly modules: readonly Module[];
  readonly completed: ReadonlySet<string>;
  readonly nextLesson: Lesson | undefined;
  readonly nextModule: Module | undefined;
  readonly openExams: readonly StudentExamDto[];
  readonly plan: readonly PlanItem[];
}

export function deriveStudentHome(data: StudentHomeData, now: number): Derived {
  const exams = data.exams ?? [];
  const modules = data.learner?.catalog?.modules ?? [];
  const lessons = modules.flatMap((module) => module.lessons ?? []);
  const completed = new Set(data.learner?.progress?.filter((item) => item.state === 'COMPLETED').map((item) => item.lessonVersionId) ?? []);
  const nextLesson = lessons.find((lesson) => !completed.has(lesson.id));
  const nextModule = nextLesson ? modules.find((module) => (module.lessons ?? []).some((lesson) => lesson.id === nextLesson.id)) : undefined;
  const openExams = exams.filter((exam) => exam.openAttemptId !== null
    || (now >= Date.parse(exam.startsAt) && now <= Date.parse(exam.endsAt) && exam.attemptsUsed < exam.attemptsAllowed));

  // Today's plan is rule-derived from live account state (the honest v1 of a daily-plan engine).
  const plan: PlanItem[] = [
    ...openExams.slice(0, 2).map((exam) => ({
      key: `exam-${exam.id}`, title: exam.openAttemptId ? `Resume ${exam.title}` : `Attempt ${exam.title}`,
      meta: exam.durationSeconds > 0 ? `Assessments · ${Math.round(exam.durationSeconds / 60)} min` : 'Assessments',
      icon: 'assessments' as const, path: '/student/assessments', done: false,
    })),
    ...(nextLesson ? [{ key: `lesson-${nextLesson.id}`, title: `Complete lesson: ${nextLesson.title}`, meta: 'Learning', icon: 'learning' as const, path: '/student/learning', done: false }] : []),
    ...(data.profile?.targetCareer
      ? [{ key: 'profile', title: 'Keep your profile current', meta: 'Profile · 5 min', icon: 'profile' as const, path: '/student/profile', done: false }]
      : [{ key: 'target', title: 'Set your target career', meta: 'Profile · 2 min', icon: 'profile' as const, path: '/student/profile', done: false }]),
    ...(lessons.length > 0 && completed.size >= lessons.length && lessons.every((lesson) => completed.has(lesson.id))
      ? [{ key: 'review', title: 'All lessons completed - review your readiness', meta: 'Readiness', icon: 'readiness' as const, path: '/student/readiness', done: true }] : []),
  ].slice(0, 4);

  return { modules, completed, nextLesson, nextModule, openExams, plan };
}

function nextClimb(derived: Derived): NextClimb | null {
  const first = derived.plan.find((item) => !item.done);
  if (!first) return null;
  if (first.key.startsWith('lesson-') && derived.nextLesson && derived.nextModule) {
    const moduleLessons = derived.nextModule.lessons ?? [];
    const index = moduleLessons.findIndex((lesson) => lesson.id === derived.nextLesson!.id);
    const done = moduleLessons.filter((lesson) => derived.completed.has(lesson.id)).length;
    return {
      item: first,
      detail: `${derived.nextModule.title} · Lesson ${index + 1} of ${moduleLessons.length}`,
      coursePercent: moduleLessons.length ? Math.round((done / moduleLessons.length) * 100) : null,
      action: done > 0 ? 'Resume lesson' : 'Start lesson',
    };
  }
  if (first.key.startsWith('exam-')) {
    return { item: first, detail: first.meta, coursePercent: null, action: first.title.startsWith('Resume') ? 'Resume assessment' : 'Start assessment' };
  }
  return { item: first, detail: first.meta, coursePercent: null, action: 'Open profile' };
}

// ---------------------------------------------------------------------------------------------
// Hero: greeting, the band climb, the streak and the next climb
// ---------------------------------------------------------------------------------------------

function Streak({ activity }: { readonly activity: StudentActivityDto }): React.ReactElement {
  const streak = Math.max(0, Math.trunc(activity.currentStreakDays));
  const last7 = activity.last7 ?? [];
  const today = last7[last7.length - 1];
  const activeToday = Boolean(today && today.count > 0);
  const title = streak > 0 ? `${streak}-day streak` : 'No streak yet';
  const line = streak === 0 ? 'Complete a lesson or an assessment to start one'
    : activeToday ? 'You learned today. Come back tomorrow to keep it going'
      : `Learn something today to make it ${streak + 1}`;
  // Orange is the celebration colour: it lights only for a streak that exists.
  return <section className={`sh-streak sh-a sh-slide${streak === 0 ? ' sh-streak--none' : ''}`} style={{ '--d0': '380ms' } as React.CSSProperties} aria-label="Learning streak">
    <div className="sh-flame"><Flame /></div>
    <div className="sh-sk"><b className="num">{title}</b><span>{line}</span></div>
    {last7.length ? <ol className="sh-sdots" aria-label="Your last seven days">
      {last7.map((entry, index) => {
        const date = new Date(`${entry.date}T00:00:00`);
        const letter = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { weekday: 'narrow' });
        const full = Number.isNaN(date.getTime()) ? entry.date : date.toLocaleDateString(undefined, { weekday: 'long' });
        const isToday = index === last7.length - 1;
        return <li key={entry.date} className={`sd${entry.count > 0 ? ' lit' : ''}${isToday ? ' td' : ''}`}
          style={{ '--k': index } as React.CSSProperties}
          aria-label={`${full}${isToday ? ' (today)' : ''}: ${entry.count > 0 ? 'active' : 'no learning recorded'}`}>
          <span aria-hidden="true">{letter}</span>
        </li>;
      })}
    </ol> : null}
  </section>;
}

function NextClimbCard({ climb, then }: { readonly climb: NextClimb; readonly then: PlanItem | undefined }): React.ReactElement {
  return <section className="sh-nxc sh-a sh-rise" style={{ '--d0': '520ms' } as React.CSSProperties} aria-labelledby="sh-next-title">
    <div className="sh-nx-eb"><ClimbMark /> Your next climb</div>
    <h2 id="sh-next-title">{climb.item.title}</h2>
    {climb.detail ? <p className="sh-nx-m">{climb.detail}</p> : null}
    {climb.coursePercent !== null ? <div className="sh-nx-p">
      <div className="sh-prog" role="progressbar" aria-label="Course progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={climb.coursePercent}>
        <div className="sh-grow-x" style={{ width: `${climb.coursePercent}%` }} />
      </div>
      <CountUp value={climb.coursePercent} format={(value) => `${value}%`} delay={1000} /><span className="sh-muted">of course</span>
    </div> : null}
    <div className="sh-nx-a">
      <button type="button" className="pilot-btn sh-shine" onClick={() => go(climb.item.path)}>{climb.action} <Icon name="arrow-right" size={16} /></button>
      {then ? <span className="sh-muted">Then: {then.title.charAt(0).toLowerCase()}{then.title.slice(1)}</span> : null}
    </div>
  </section>;
}

function heroLine(band: ReturnType<typeof toReadinessBand>, target: string | null): React.ReactNode {
  const towards = target ? <> towards {target}</> : null;
  if (!band) {
    return <>Your advisory band appears once ONE has verified evidence to build it from{target ? <>. You are working towards {target}</> : null}.</>;
  }
  const index = READINESS_BANDS.indexOf(band);
  const next = READINESS_BANDS[index + 1];
  if (!next) return <>You&rsquo;re at <b>{READINESS_BAND_LABELS[band]}</b>{towards}.</>;
  return <>You&rsquo;re on the <b>{READINESS_BAND_LABELS[band]}</b> step{towards}. One more climb to <b>{READINESS_BAND_LABELS[next]}</b>.</>;
}

function Hero({ firstName, data, derived, now }: { readonly firstName: string; readonly data: StudentHomeData; readonly derived: Derived; readonly now: number }): React.ReactElement {
  const hour = new Date(now).getHours();
  const daypart = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const today = new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const band = toReadinessBand(data.learner?.readiness?.band ?? null);
  const climb = nextClimb(derived);
  const then = climb ? derived.plan.find((item) => !item.done && item.key !== climb.item.key) : undefined;
  const hasActivity = Boolean(data.activity && Array.isArray(data.activity.last7));
  const hasRight = hasActivity || climb !== null;
  return <section className={`sh-hero sh-a sh-rise${hasRight ? '' : ' sh-hero--solo'}`} style={{ '--d0': '120ms', '--dur': '800ms' } as React.CSSProperties} aria-labelledby="sh-greeting">
    <div className="sh-hflow" aria-hidden="true" /><div className="sh-hdeco" aria-hidden="true" /><div className="sh-hsweep" aria-hidden="true" />
    <div className="sh-hl">
      <div className="sh-heb sh-a sh-rise-sm" style={{ '--d0': '320ms' } as React.CSSProperties}><ClimbMark size={13} /> Momentum · {today}</div>
      <h1 id="sh-greeting" className="sh-a sh-rise-sm" style={{ '--d0': '400ms' } as React.CSSProperties}>Good {daypart}, {firstName}.</h1>
      <p className="sh-hsub sh-a sh-rise-sm" style={{ '--d0': '480ms' } as React.CSSProperties}>{heroLine(band, data.profile?.targetCareer ?? null)}</p>
      {data.profile?.targetCareer ? <button type="button" className="sh-goal" onClick={() => go('/student/profile')}>Change goal <Icon name="arrow-right" size={16} /></button> : null}
      {/* The advisory band, drawn only by <ReadinessBand>: the enum in, never a number. */}
      <ReadinessBand band={band} variant="hero" className="sh-climb" />
    </div>
    {hasRight ? <div className="sh-hr">
      {hasActivity ? <Streak activity={data.activity!} /> : null}
      {climb ? <NextClimbCard climb={climb} then={then} /> : null}
    </div> : null}
  </section>;
}

// ---------------------------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------------------------

const MASTERY_ORDER = ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'DEMONSTRATED'] as const;

/** Topic mastery (not readiness): an ordinal meter, four steps by order, never an amount. */
function MasteryMeter({ band }: { readonly band: string }): React.ReactElement | null {
  const index = (MASTERY_ORDER as readonly string[]).indexOf(band);
  if (index < 0) return null;
  return <span className="mb sh-mb" aria-hidden="true">
    {MASTERY_ORDER.map((code, step) => <i key={code} className={step <= index ? (step === index ? 'f c' : 'f') : undefined} style={{ '--k': step } as React.CSSProperties} />)}
  </span>;
}

function BuildingYourBand({ learner, factorText }: { readonly learner: LearnerCareerReadinessState; readonly factorText: (text: string | null | undefined) => string | null }): React.ReactElement | null {
  const evidence = learner.evidence ?? [];
  const mastery = learner.mastery ?? [];
  if (!evidence.length && !mastery.length) return null;
  const topics = new Map((learner.catalog?.topics ?? []).map((topic) => [topic.id, topic.name]));
  const factors = new Map((learner.readiness?.explanation?.factors ?? []).map((factor) => [factor.topicId, factor]));
  const lastAdded = evidence.map((item) => validTime(item.occurredAt)).filter((time): time is number => time !== null).sort((a, b) => b - a)[0];
  // Band history only when there is a change to show: the latest three snapshots, oldest first.
  const history = (learner.readinessHistory ?? []).filter((entry) => toReadinessBand(entry.band) && validTime(entry.generatedAt) !== null).slice(0, 3).reverse();
  return <article className="sh-card sh-a sh-rise" style={{ '--w': 5 } as React.CSSProperties} aria-labelledby="sh-building">
    <CardHead id="sh-building" title="What’s building your band"><CardLink label="Readiness report" href="#student-reports-title" /></CardHead>
    {evidence.length ? <div className="sh-evt">
      <div className="sh-evn"><CountUp value={evidence.length} delay={250} duration={700} />
        <div><b>evidence record{evidence.length === 1 ? '' : 's'}</b>{lastAdded ? <small>Last added {shortDate(lastAdded)}</small> : null}</div></div>
    </div> : null}
    {mastery.length ? <ul className="sh-evr-list" aria-label="Topics with evidence">
      {mastery.slice(0, 5).map((item) => {
        const explanation = factorText(factors.get(item.topicId)?.explanation);
        const count = item.evidenceIds.length;
        return <li key={item.id} className="sh-evr">
          <span className="sh-evi"><Icon name="evidence" size={20} /></span>
          <div className="sh-evx"><b>{topics.get(item.topicId) ?? 'Readiness topic'}</b>
            <small>{count} evidence record{count === 1 ? '' : 's'}</small>
            {explanation ? <small>{explanation}</small> : null}</div>
          <MasteryMeter band={item.band} />
          <span className="tag t-band"><i aria-hidden="true" />{sentence(item.band)}</span>
        </li>;
      })}
    </ul> : null}
    {history.length >= 2 ? <div className="sh-hist">
      <span className="eyebrow">Band history</span>
      <ol className="sh-hrow" aria-label="Band history, oldest first">
        {history.map((entry) => <li key={entry.id}>
          <small><time dateTime={entry.generatedAt}>{shortDate(validTime(entry.generatedAt)!)}</time></small>
          <ReadinessBand band={toReadinessBand(entry.band)} variant="mini" />
        </li>)}
      </ol>
    </div> : null}
  </article>;
}

function TodaysPlan({ plan }: { readonly plan: readonly PlanItem[] }): React.ReactElement | null {
  if (!plan.length) return null;
  const open = plan.filter((item) => !item.done).length;
  return <article className="sh-card sh-a sh-rise" style={{ '--w': 4, '--d0': '90ms' } as React.CSSProperties} aria-labelledby="sh-plan">
    <CardHead id="sh-plan" title="Today’s plan"><span className="tag t-band"><i aria-hidden="true" />{open} task{open === 1 ? '' : 's'}</span></CardHead>
    <ul className="sh-tasks">
      {plan.map((task, index) => <li key={task.key}>
        <button type="button" className={`sh-task${index === 0 && !task.done ? ' hot' : ''}${task.done ? ' done' : ''}`} onClick={() => go(task.path)}>
          <span className="sh-cb" aria-hidden="true">{task.done ? <Icon name="check" size={16} /> : null}</span>
          <span className="sh-task-t"><b>{task.title}</b><small><Icon name={task.icon} size={16} /> {task.meta}</small></span>
          {index === 0 && !task.done ? <span className="tag t-band">Next climb</span> : null}
        </button>
      </li>)}
    </ul>
    <CardLink label="View full plan" path="/student/assessments" />
  </article>;
}

const KIND_LABEL: Readonly<Record<CalendarEntryDto['kind'], string>> = {
  INTERVIEW: 'Interview', EXAM: 'Exam', TASK: 'Task', MEETING: 'Meeting', ROADMAP: 'Next step',
};

interface UpcomingEntry { readonly id: string; readonly kind: CalendarEntryDto['kind']; readonly title: string; readonly detail: string | null; readonly startsAt: number; readonly location: string | null }

export function upcomingEntries(data: StudentHomeData, now: number): readonly UpcomingEntry[] {
  // The calendar is the one place that already joins interviews, exam windows, tasks and
  // roadmap dates; when it cannot be read, the exam windows the dashboard has are used instead.
  const source: UpcomingEntry[] = data.calendar
    ? data.calendar.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, detail: entry.detail, startsAt: validTime(entry.startsAt) ?? NaN, location: entry.location }))
    : (data.exams ?? []).flatMap((exam) => {
      const opens = validTime(exam.startsAt);
      const closes = validTime(exam.endsAt);
      return [
        ...(opens !== null ? [{ id: `${exam.id}-opens`, kind: 'EXAM' as const, title: `${exam.title} opens`, detail: exam.subjectName || null, startsAt: opens, location: null }] : []),
        ...(closes !== null && opens !== null && opens <= now ? [{ id: `${exam.id}-closes`, kind: 'EXAM' as const, title: `${exam.title} closes`, detail: exam.subjectName || null, startsAt: closes, location: null }] : []),
      ];
    });
  return source.filter((entry) => Number.isFinite(entry.startsAt) && entry.startsAt > now).sort((a, b) => a.startsAt - b.startsAt);
}

function UpNext({ entries, now }: { readonly entries: readonly UpcomingEntry[]; readonly now: number }): React.ReactElement | null {
  const next = entries[0];
  if (!next) return null;
  const date = new Date(next.startsAt);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const interview = next.kind === 'INTERVIEW';
  return <article className="sh-card sh-upc sh-a sh-rise" style={{ '--w': 3, '--d0': '180ms' } as React.CSSProperties} aria-labelledby="sh-upnext">
    <CardHead id="sh-upnext" title="Up next" />
    <div className="sh-dateb" aria-hidden="true">
      <span>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span><b className="num">{date.getDate()}</b><span>{date.toLocaleDateString(undefined, { month: 'short' })}</span>
    </div>
    <StatusTag state={next.kind} tone={interview ? 'cyan' : 'band'} label={KIND_LABEL[next.kind] ?? sentence(next.kind)} />
    <h3>{next.title}</h3>
    {next.detail ? <p className="sh-sub">{next.detail}</p> : null}
    <p className="sh-when"><Icon name="clock" size={16} />
      <time dateTime={date.toISOString()}>{date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, {time}</time> · {daysUntil(next.startsAt, now)}</p>
    {next.location ? <p className="sh-sub sh-loc">{next.location}</p> : null}
    {entries.length > 1 ? <p className="sh-muted sh-more">{entries.length - 1} more on your calendar</p> : null}
    <button type="button" className="pilot-btn ghost small" onClick={() => go(interview ? '/student/interviews' : '/student/calendar')}>
      {interview ? 'Prepare for this interview' : 'Open calendar'}
    </button>
  </article>;
}

function ContinueLearning({ derived }: { readonly derived: Derived }): React.ReactElement | null {
  const course = derived.nextModule ?? derived.modules[0];
  if (!course) return null;
  const lessons = course.lessons ?? [];
  const done = lessons.filter((lesson) => derived.completed.has(lesson.id)).length;
  const current = lessons.find((lesson) => !derived.completed.has(lesson.id));
  const percent = lessons.length ? Math.round((done / lessons.length) * 100) : null;
  const others = derived.modules.filter((module) => module.id !== course.id).slice(0, 3);
  return <article className="sh-card sh-a sh-rise" style={{ '--w': 4 } as React.CSSProperties} aria-labelledby="sh-learning">
    <CardHead id="sh-learning" title="Continue learning"><CardLink label="Learning" path="/student/learning" /></CardHead>
    <div className="sh-course"><span className="sh-cth"><Icon name="learning" size={24} /></span>
      <div><b>{course.title}</b><small>{lessons.length} lesson{lessons.length === 1 ? '' : 's'} · {done} complete</small></div></div>
    {lessons.length ? <ol className="sh-lessons">
      {lessons.slice(0, 5).map((lesson, index) => {
        const isDone = derived.completed.has(lesson.id);
        const isCurrent = lesson.id === current?.id;
        return <li key={lesson.id} className={isDone ? 'd' : isCurrent ? 'c' : undefined} style={{ '--k': index } as React.CSSProperties}>
          <i aria-hidden="true">{isDone ? <Icon name="check" size={16} /> : index + 1}</i>{lesson.title}
          <small>{isDone ? 'Done' : isCurrent ? 'Up next' : 'Not started'}</small>
        </li>;
      })}
    </ol> : null}
    {percent !== null ? <div className="sh-nx-p">
      <div className="sh-prog" role="progressbar" aria-label="Course progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="sh-grow-x" style={{ width: `${percent}%` }} />
      </div>
      <CountUp value={percent} format={(value) => `${value}%`} delay={500} /><span className="sh-muted">course progress</span>
    </div> : null}
    {/* The learning page lists every lesson; it has no per-lesson address yet, so this opens it. */}
    <button type="button" className="pilot-btn soft small" onClick={() => go('/student/learning')}>
      <Icon name="arrow-right" size={16} /> {current ? (done > 0 ? 'Resume lesson' : 'Start lesson') : 'Review lessons'}
    </button>
    {others.length ? <div className="sh-more-courses">
      <span className="eyebrow">Also in your learning</span>
      <ul>{others.map((module) => <li key={module.id}>
        <button type="button" className="sh-mc" onClick={() => go('/student/learning')}>
          <b>{module.title}</b><small>{module.lessons.length} lesson{module.lessons.length === 1 ? '' : 's'}</small>
        </button>
      </li>)}</ul>
    </div> : null}
  </article>;
}

const PIPELINE = ['Applied', 'Screening', 'Interview', 'Offer'] as const;
const PIPELINE_STEP: Readonly<Record<string, number>> = {
  APPLIED: 0, SCREENING: 1, SHORTLISTED: 1, ASSESSMENT: 1, INTERVIEW: 2, OFFER: 3, HIRED: 3,
};
const CLOSED = new Set(['WITHDRAWN', 'REJECTED', 'NOT_SELECTED']);

function ApplicationRow({ item }: { readonly item: StudentApplicationDto }): React.ReactElement {
  const state = item.state.toUpperCase();
  const step = PIPELINE_STEP[state];
  const submitted = validTime(item.submittedAt);
  const closed = validTime(item.closedAt);
  const muted = CLOSED.has(state);
  const mark = initials(item.employerName);
  const sub = [item.employerName, submitted !== null ? `applied ${shortDate(submitted)}` : state === 'DRAFT' ? 'not submitted yet' : null].filter(Boolean).join(' · ');
  return <li className={`sh-app${muted ? ' mute' : ''}`}>
    <div className="sh-ar-h">
      {mark ? <span className="sh-logo-co" aria-hidden="true">{mark}</span> : null}
      <div><b>{item.title}</b>{sub ? <small>{sub}</small> : null}</div>
      <StatusTag state={state} kind="application" label={sentence(state === 'REJECTED' ? 'NOT_SELECTED' : state)} />
    </div>
    {step !== undefined && !muted ? <ol className="sh-pipe" aria-label={`Stage: ${PIPELINE[step]}`}>
      {PIPELINE.map((label, index) => <li key={label} className={index < step ? 'd' : index === step ? 'c' : undefined} style={{ '--k': index } as React.CSSProperties}>{label}</li>)}
    </ol> : null}
    {muted && closed !== null ? <p className="sh-ar-n">{state === 'WITHDRAWN' ? 'You withdrew' : 'Closed'} on {shortDate(closed)}.</p> : null}
    {item.unreadMessages && item.unreadMessages > 0 ? <p className="sh-ar-n"><Icon name="message" size={16} /> {item.unreadMessages} new message{item.unreadMessages === 1 ? '' : 's'} from the employer</p> : null}
  </li>;
}

function Applications({ applications }: { readonly applications: readonly StudentApplicationDto[] }): React.ReactElement | null {
  if (!applications.length) return null;
  const rank = (item: StudentApplicationDto) => (CLOSED.has(item.state.toUpperCase()) ? 1 : 0);
  const shown = [...applications].sort((a, b) => rank(a) - rank(b) || (validTime(b.updatedAt) ?? 0) - (validTime(a.updatedAt) ?? 0)).slice(0, 3);
  return <article className="sh-card sh-a sh-rise" style={{ '--w': 5, '--d0': '90ms' } as React.CSSProperties} aria-labelledby="sh-applications">
    <CardHead id="sh-applications" title="Applications"><CardLink label="All applications" path="/student/applications" /></CardHead>
    <ul className="sh-apps">{shown.map((item) => <ApplicationRow key={item.id} item={item} />)}</ul>
  </article>;
}

function ThisWeek({ activity }: { readonly activity: StudentActivityDto }): React.ReactElement | null {
  const days = activity.last7 ?? [];
  if (!days.length) return null;
  const total = days.reduce((sum, day) => sum + Math.max(0, day.count), 0);
  const peak = Math.max(1, ...days.map((day) => day.count));
  const active = days.filter((day) => day.count > 0).length;
  // A week with no recorded learning has nothing to chart; the streak card already says so.
  if (total === 0) return null;
  return <article className="sh-card sh-a sh-rise" style={{ '--w': 3, '--d0': '180ms' } as React.CSSProperties} aria-labelledby="sh-week">
    <CardHead id="sh-week" title="This week" />
    <div className="sh-wk-t"><CountUp value={total} delay={200} duration={1100} /><small>learning action{total === 1 ? '' : 's'} · lessons and assessments</small></div>
    <ol className="sh-wks" aria-label="Learning actions per day, last seven days">
      {days.map((day, index) => {
        const date = new Date(`${day.date}T00:00:00`);
        const letter = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { weekday: 'narrow' });
        const full = Number.isNaN(date.getTime()) ? day.date : date.toLocaleDateString(undefined, { weekday: 'long' });
        const isToday = index === days.length - 1;
        const height = day.count > 0 ? Math.max(10, Math.round((day.count / peak) * 96)) : 6;
        return <li key={day.date} className={`sh-wb${day.count > 0 ? '' : ' zero'}${isToday ? ' today' : ''}`}
          aria-label={`${full}${isToday ? ' (today)' : ''}: ${day.count} learning action${day.count === 1 ? '' : 's'}`}>
          <span className="sh-wbar" aria-hidden="true"><i style={{ height, '--k': index } as React.CSSProperties} /></span>
          <span aria-hidden="true">{letter}</span>
        </li>;
      })}
    </ol>
    <p className="sh-wk-n">{active} of 7 days active</p>
  </article>;
}

const QUICK_ACTIONS: readonly (readonly [string, IconName, string, string])[] = [
  ['Take a mock test', 'assessments', '/student/assessments', 'Assessments'],
  ['Practice questions', 'practice', '/student/assessments', 'Assessments'],
  ['Build resume', 'resume', '/student/documents', 'Documents'],
  ['Explore roles', 'opportunities', '/student/opportunities', 'Opportunities'],
  ['Update profile', 'profile', '/student/profile', 'Profile'],
  ['View scholarships', 'scholarships', '/student/opportunities', 'Opportunities'],
];

function QuickActions(): React.ReactElement {
  return <article className="sh-card sh-qcard sh-a sh-rise" style={{ '--w': 5 } as React.CSSProperties} aria-labelledby="sh-quick">
    <CardHead id="sh-quick" title="Quick actions" />
    <ul className="sh-qa">{QUICK_ACTIONS.map(([label, icon, path, where], index) => <li key={label} style={{ '--k': index } as React.CSSProperties}>
      <button type="button" className="sh-qi one-icon-host" onClick={() => go(path)}>
        <span className="sh-qt"><Icon name={icon} size={20} animated /></span><b>{label}</b><small>{where}</small>
      </button>
    </li>)}</ul>
  </article>;
}

function RecentActivity({ rows, now }: { readonly rows: readonly UserNotificationDto[]; readonly now: number }): React.ReactElement | null {
  if (!rows.length) return null;
  return <article className="sh-card sh-a sh-rise" style={{ '--w': 7, '--d0': '90ms' } as React.CSSProperties} aria-labelledby="sh-activity">
    <CardHead id="sh-activity" title="Recent activity" />
    <ul className="sh-acts">{rows.map((entry) => {
      const when = relativeWhen(entry.createdAt, now);
      return <li key={entry.id}><span className="sh-evi"><Icon name="bell" size={16} /></span><b>{entry.title}</b>{when ? <small>{when}</small> : null}</li>;
    })}</ul>
  </article>;
}

// ---------------------------------------------------------------------------------------------
// The home
// ---------------------------------------------------------------------------------------------

export function StudentHomeView({ studentName, data, now, factorText, support }: {
  readonly studentName: string;
  readonly data: StudentHomeData;
  readonly now: number;
  readonly factorText: (text: string | null | undefined) => string | null;
  /** The college's support items and shared notes (unchanged), placed in the home's flow. */
  readonly support: React.ReactNode;
}): React.ReactElement {
  const firstName = studentName.split(/\s+/)[0] ?? studentName;
  const derived = deriveStudentHome(data, now);
  const upcoming = upcomingEntries(data, now);
  const activity = data.activity && Array.isArray(data.activity.last7) ? data.activity : null;
  const notifications = (data.notifications?.notifications ?? []).slice(0, 4);
  return <div className="sh">
    <div className="sh-head">
      <button type="button" className="pilot-btn ghost small" onClick={() => go('/student/calendar')}><Icon name="calendar-small" size={16} /> View calendar</button>
    </div>
    <Hero firstName={firstName} data={data} derived={derived} now={now} />
    <div className="sh-grid">
      <div className="sh-row">
        {data.learner ? <BuildingYourBand learner={data.learner} factorText={factorText} /> : null}
        <TodaysPlan plan={derived.plan} />
        <UpNext entries={upcoming} now={now} />
      </div>
      <div className="sh-row">
        <ContinueLearning derived={derived} />
        <Applications applications={data.applications ?? []} />
        {activity ? <ThisWeek activity={activity} /> : null}
      </div>
      <div className="sh-row">
        <QuickActions />
        <RecentActivity rows={notifications} now={now} />
      </div>
      <div className="sh-row sh-row--full">{support}</div>
      <div className="sh-privacy sh-a sh-fade">
        <Icon name="lock" size={20} />
        <p><b>Your data is yours.</b> Readiness is advisory and comes only from verified evidence. It is never a score, and it is never shared with employers. Your college sees only what you permit.</p>
        <CardLink label="Privacy & sharing" path="/student/settings" />
      </div>
    </div>
  </div>;
}
