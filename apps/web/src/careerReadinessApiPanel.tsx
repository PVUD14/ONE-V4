import { useEffect, useMemo, useState } from 'react';
import {
  ApiRequestError,
  completeCareerReadinessLesson,
  getCareerReadinessAccessToken,
  getCareerReadinessCatalog,
  getLearnerCareerReadinessState,
  setLearnerLessonLanguage,
  startCareerReadinessAssessment,
  submitCareerReadinessAssessment,
  type AssessmentAttemptDto,
  type CareerReadinessCatalog,
  type LearnerCareerReadinessState,
  type LearnerLessonLanguage,
} from './api.js';
import { V2EmptyState, V2Stat } from './dashboardsV2.js';
import { lessonTextProps } from './lessonScript.js';
import { formatDate, formatDateTime } from './dates.js';
import { ReadinessBand, toReadinessBand } from './momentum/readinessBand.js';

type CareerRoute = 'readiness' | 'skills' | 'assessments' | 'learning' | 'roadmap' | 'notifications';

export function CareerReadinessApiPanel({ route }: { readonly route: CareerRoute }): React.ReactElement {
  const [catalog, setCatalog] = useState<CareerReadinessCatalog | null>(null);
  const [learner, setLearner] = useState<LearnerCareerReadinessState | null>(null);
  const [attempt, setAttempt] = useState<AssessmentAttemptDto | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('Loading published Career Readiness content…');
  const [busy, setBusy] = useState(false);
  const token = useMemo(() => getCareerReadinessAccessToken(), []);

  async function refresh(signal?: AbortSignal): Promise<void> {
    try {
      const published = await getCareerReadinessCatalog(signal);
      setCatalog(published);
      if (token) {
        const state = await getLearnerCareerReadinessState(token, signal);
        setLearner(state);
        setStatus('Your progress is up to date.');
      } else {
        setStatus('Sign in to save your progress.');
      }
    } catch {
      setStatus('Career Readiness could not be loaded right now. Try again shortly.');
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, []);

  async function complete(lessonId: string): Promise<void> {
    if (!token) return;
    setBusy(true);
    try {
      await completeCareerReadinessLesson(token, lessonId);
      await refresh();
      setStatus('Lesson completed and added to your evidence.');
    } catch (error) {
      // Prefer the API's named reason ("finish \"X\" first") over a generic line.
      if (error instanceof ApiRequestError && error.detail) {
        setStatus(error.detail);
      } else {
        setStatus('The lesson could not be completed. Check prerequisites and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  // ENG-16: the learner's lesson language. Lessons with no published version in it stay in English.
  async function chooseLanguage(language: string): Promise<void> {
    if (!token) return;
    setBusy(true);
    try {
      const chosen = await setLearnerLessonLanguage(token, language);
      await refresh();
      const option = chosen.lessonLanguage.offered.find((entry) => entry.language === chosen.lessonLanguage.selected);
      const name = option ? option.name : 'English';
      setStatus(chosen.lessonLanguage.selected === 'en'
        ? 'Lessons are shown in English.'
        : `Lessons are shown in ${name} where a ${name} version is published. The rest are shown in English, and say so.`);
    } catch {
      setStatus('The lesson language could not be changed. Your lessons are unchanged.');
    } finally {
      setBusy(false);
    }
  }

  async function start(assessmentId: string): Promise<void> {
    if (!token) return;
    setBusy(true);
    try {
      setAttempt(await startCareerReadinessAssessment(token, assessmentId));
      setSelectedOptions({});
      setStatus('Assessment attempt started with a server-generated, frozen question selection.');
    } catch {
      setStatus('The assessment could not be started or its attempt limit was reached.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (!token || !attempt || attempt.questions.some((question) => !selectedOptions[question.id])) return;
    setBusy(true);
    try {
      await submitCareerReadinessAssessment(token, attempt.attemptId, selectedOptions, `web-${crypto.randomUUID()}`);
      setAttempt(null);
      setSelectedOptions({});
      await refresh();
      setStatus('Assessment submitted once. Evidence, advisory readiness, and roadmap actions are now updated.');
    } catch {
      setStatus('The assessment was not submitted. Your current selections remain on this page.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="career-api-panel" aria-labelledby="career-api-title">
      <div className="career-api-heading">
        <div><span className="eyebrow">Career Readiness</span><h2 id="career-api-title">Career Readiness Fundamentals</h2></div>
        <span className={`career-api-state ${catalog ? 'connected' : 'unavailable'}`}>{catalog ? 'Up to date' : 'Unavailable'}</span>
      </div>
      <p className="career-api-status" role="status" aria-live="polite">{status}</p>
      {route === 'learning' ? <LearningApiView catalog={learner ? learner.catalog : catalog} learner={learner} token={token} busy={busy}
        onComplete={complete} onChooseLanguage={chooseLanguage} /> : null}
      {route === 'assessments' ? <AssessmentApiView catalog={catalog} learner={learner} token={token} busy={busy} attempt={attempt}
        selectedOptions={selectedOptions} onSelect={(questionId, optionId) => setSelectedOptions((current) => ({ ...current, [questionId]: optionId }))}
        onStart={start} onSubmit={submit} /> : null}
      {/* Readiness is about the advisory band; Skills about each topic's mastery, so it has its own strip. */}
      {learner && route !== 'notifications' && route !== 'skills' ? <CareerStatStrip learner={learner} catalog={catalog} /> : null}
      {route === 'readiness' ? <ReadinessApiView learner={learner} catalog={learner ? learner.catalog : catalog} /> : null}
      {route === 'skills' ? <SkillsApiView learner={learner} catalog={learner ? learner.catalog : catalog} /> : null}
      {route === 'roadmap' ? <RoadmapApiView learner={learner} /> : null}
      {route === 'notifications' ? <NotificationsApiView learner={learner} /> : null}
      <p className="career-api-boundary">Readiness bands are advice for you. They are never shown to employers and come only from the evidence you build in ONE.</p>
    </section>
  );
}

function LearningApiView({ catalog, learner, token, busy, onComplete, onChooseLanguage }: {
  readonly catalog: CareerReadinessCatalog | null; readonly learner: LearnerCareerReadinessState | null; readonly token: string | null;
  readonly busy: boolean; readonly onComplete: (lessonId: string) => void; readonly onChooseLanguage: (language: string) => void;
}): React.ReactElement {
  const completed = new Set(learner?.progress?.filter((item) => item.state === 'COMPLETED').map((item) => item.lessonVersionId) ?? []);
  const lessonLanguage = learner && learner.lessonLanguage ? learner.lessonLanguage : null;
  const chosenName = lessonLanguageName(lessonLanguage);
  return <>
    {token && lessonLanguage ? <LessonLanguagePicker lessonLanguage={lessonLanguage} busy={busy} onChoose={onChooseLanguage} /> : null}
    <div className="career-api-grid">{(catalog?.modules ?? []).flatMap((module) => module.lessons).map((lesson) => (
      <article key={lesson.id}><span>{completed.has(lesson.id) ? 'Completed with evidence' : 'Published lesson'}</span>
        <h3 {...lessonTextProps(lesson.language)}>{lesson.title}</h3>
        <p {...lessonTextProps(lesson.language)}>{lesson.body.summary}</p>
        {lesson.languageNotice === 'TRANSLATION_MISSING' ? <small role="note">Not yet available in {chosenName}. Shown in English.</small> : null}
        {lesson.languageNotice === 'TRANSLATION_OUTDATED' ? <small role="note">The English lesson was updated after this {chosenName} version was written. Choose English to read the latest.</small> : null}
        <small>{lesson.prerequisiteLessonIds.length ? `${lesson.prerequisiteLessonIds.length} prerequisite` : 'No prerequisite'}</small>
        <button type="button" disabled={!token || busy || completed.has(lesson.id)} onClick={() => onComplete(lesson.id)}>{completed.has(lesson.id) ? 'Completed' : 'Complete lesson'}</button>
      </article>
    )) ?? null}</div>
  </>;
}

function lessonLanguageName(lessonLanguage: LearnerLessonLanguage | null): string {
  const option = lessonLanguage ? lessonLanguage.offered.find((entry) => entry.language === lessonLanguage.selected) : undefined;
  return option ? option.name : 'English';
}

/**
 * ENG-16: the learner chooses the language lessons are shown in. Each language is named in its own
 * script beside its English name. Completing a lesson counts the same in any language.
 */
function LessonLanguagePicker({ lessonLanguage, busy, onChoose }: {
  readonly lessonLanguage: LearnerLessonLanguage; readonly busy: boolean; readonly onChoose: (language: string) => void;
}): React.ReactElement {
  return <div className="career-api-heading">
    <label><span>Lesson language</span>{' '}
      <select aria-label="Lesson language" value={lessonLanguage.selected} disabled={busy} onChange={(event) => onChoose(event.target.value)}>
        {lessonLanguage.offered.map((option) => <option key={option.language} value={option.language} {...lessonTextProps(option.language)}>
          {option.nativeName === option.name ? option.name : `${option.nativeName} · ${option.name}`}</option>)}
      </select></label>
    <small>A lesson with no published version in your language is shown in English, and says so. Completing a lesson counts the same in any language.</small>
  </div>;
}

function AssessmentApiView({ catalog, learner, token, busy, attempt, selectedOptions, onSelect, onStart, onSubmit }: {
  readonly catalog: CareerReadinessCatalog | null; readonly learner: LearnerCareerReadinessState | null; readonly token: string | null;
  readonly busy: boolean; readonly attempt: AssessmentAttemptDto | null; readonly selectedOptions: Readonly<Record<string, string>>;
  readonly onSelect: (questionId: string, optionId: string) => void; readonly onStart: (assessmentId: string) => void; readonly onSubmit: () => void;
}): React.ReactElement {
  if (attempt) return <form className="career-assessment-form" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
    <p>Expires {formatDateTime(attempt.expiresAt)}. Answers are checked after you submit.</p>
    {attempt.questions.map((question, index) => <fieldset key={question.id}><legend>{index + 1}. {question.prompt}</legend>
      {question.options.map((option) => <label key={option.id}><input type="radio" name={question.id} value={option.id}
        checked={selectedOptions[question.id] === option.id} onChange={() => onSelect(question.id, option.id)} />{option.text}</label>)}</fieldset>)}
    <button type="submit" disabled={busy || attempt.questions.some((question) => !selectedOptions[question.id])}>Submit assessment once</button>
  </form>;
  // The server allows one attempt per assessment. This previously disabled every
  // assessment as soon as the learner had attempted any one of them, which is a
  // stricter rule than the server's and made readiness effectively impossible to
  // exercise or regression-test. Now each card reflects only its own assessment.
  const attemptedAssessments = new Set((learner?.attempts ?? [])
    .map((attempt) => attempt.assessmentDefinitionId).filter((id): id is string => Boolean(id)));
  return <div className="career-api-grid">{(catalog?.assessments ?? []).map((assessment) => {
    const alreadyAttempted = attemptedAssessments.has(assessment.id);
    return <article key={assessment.id}><span>Published assessment</span>
      <h3>{assessment.title}</h3><p>{assessment.selectionCount} questions · {Math.round(assessment.timeLimitSeconds / 60)} minutes · one attempt</p>
      <button type="button" disabled={!token || busy || alreadyAttempted} onClick={() => onStart(assessment.id)}>
        {alreadyAttempted ? 'Already attempted' : 'Start assessment'}</button>
    </article>;
  }) ?? null}</div>;
}

function CareerStatStrip({ learner, catalog }: { readonly learner: LearnerCareerReadinessState; readonly catalog: CareerReadinessCatalog | null }): React.ReactElement {
  const lessons = (catalog?.modules ?? []).flatMap((module) => module.lessons);
  const completed = learner.progress.filter((item) => item.state === 'COMPLETED').length;
  const scored = learner.attempts.filter((item) => typeof item.scoreCorrect === 'number');
  return (
    <div className="v2-row v2-cols-4 career-stat-strip">
      <V2Stat icon="📚" tone="purple" value={`${completed} / ${lessons.length || completed}`} label="Lessons completed" />
      <V2Stat icon="🧾" tone="blue" value={learner.evidence.length} label="Evidence records" />
      <V2Stat icon="📝" tone="green" value={scored.length} label="Scored attempts" />
      <V2Stat icon="🎯" tone="amber" value={learner.readiness ? formatBand(learner.readiness.band) : '—'} label="Advisory band" />
    </div>
  );
}

function topicName(catalog: CareerReadinessCatalog | null, topicId: string): string {
  return catalog?.topics?.find((topic) => topic.id === topicId)?.name ?? 'NA';
}

/** Readiness: the advisory band, what it rests on, and the bands it has been before. Bands only, never a number. */
function ReadinessApiView({ learner, catalog }: { readonly learner: LearnerCareerReadinessState | null; readonly catalog: CareerReadinessCatalog | null }): React.ReactElement {
  if (!learner?.readiness) return <V2EmptyState icon="📈" title="No advisory band yet"
    note="Complete learning and the published assessment to create enough evidence. Bands are advisory and never employer-visible." />;
  const factors = learner.readiness.explanation.factors ?? [];
  const history = learner.readinessHistory ?? [];
  return <>
    <div className="career-readiness-result"><span>Current advisory band</span><strong>{formatBand(learner.readiness.band)}</strong>
      <ReadinessBand band={toReadinessBand(learner.readiness.band)} variant="compact" />
      <p>Based on {learner.evidence.length} immutable evidence record{learner.evidence.length === 1 ? '' : 's'}.</p></div>
    <div className="career-api-grid">{factors.length ? factors.map((factor) => <article key={factor.topicId}><span>What this band rests on</span>
      <h3>{topicName(catalog, factor.topicId)}</h3><p>{formatBand(factor.masteryBand)}. {factor.explanation}</p></article>)
      : <article><span>What this band rests on</span><h3>NA</h3><p>No topic-level explanation was recorded with this band.</p></article>}</div>
    <div className="career-api-grid">{history.length ? history.slice(0, 6).map((entry) => <article key={entry.id}><span>Band on {new Date(entry.generatedAt).toLocaleDateString()}</span>
      <h3>{formatBand(entry.band)}</h3></article>)
      : <article><span>Band history</span><h3>NA</h3><p>No earlier band has been recorded for you yet.</p></article>}</div>
  </>;
}

/** Skills: each topic's evidence-derived mastery, named, with the evidence behind it. */
function SkillsApiView({ learner, catalog }: { readonly learner: LearnerCareerReadinessState | null; readonly catalog: CareerReadinessCatalog | null }): React.ReactElement {
  const mastery = learner?.mastery ?? [];
  const topics = catalog?.topics ?? [];
  return <>
    <div className="v2-row v2-cols-4 career-stat-strip">
      <V2Stat icon="🧩" tone="purple" value={catalog ? topics.length : 'NA'} label="Skills in this pathway" />
      <V2Stat icon="🎯" tone="green" value={learner ? mastery.length : 'NA'} label="Skills with evidence" />
      <V2Stat icon="🧾" tone="blue" value={learner ? learner.evidence.length : 'NA'} label="Evidence records" />
      <V2Stat icon="📌" tone="amber" value={catalog && learner ? Math.max(topics.length - mastery.length, 0) : 'NA'} label="Skills not yet evidenced" />
    </div>
    {mastery.length ? <div className="career-api-grid">{mastery.map((entry) => <article key={entry.id}><span>{topicName(catalog, entry.topicId)}</span>
      <h3>{formatBand(entry.band)}</h3><p>{entry.evidenceIds.length} active evidence record{entry.evidenceIds.length === 1 ? '' : 's'}.</p></article>)}</div>
      : <V2EmptyState icon="🧩" title="No skill evidence yet" note="Lessons and assessments you complete become evidence for each skill here." />}
  </>;
}

function RoadmapApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  if (!learner?.roadmap?.length) return <V2EmptyState icon="🗺️" title="No next action yet"
    note="Suggested next steps appear here once you have completed lessons and assessments." />;
  return <div className="career-api-grid">{learner.roadmap.map((action) => <article key={action.id}><span>Advisory next action</span>
    <h3>{formatBand(action.actionCode)}</h3><p>Reason: {formatBand(action.reasonCode)}. State: {formatBand(action.state)}.</p>
    {action.dueAt ? <small>Due {formatDate(action.dueAt)}</small> : null}</article>)}</div>;
}

function NotificationsApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  const preference = learner?.notificationPreferences;
  return <><p className="career-api-status">Email is {preference?.emailEnabled ? 'enabled' : 'not enabled'}; daily cap {preference?.dailyCap ?? 0}. Destinations stay server-side.</p>
    <div className="career-api-grid">{learner?.notifications?.map((notification) => <article key={notification.id}><span>Native email command</span>
      <h3>{formatBand(notification.templateKey)}</h3><p>{notification.legalPurpose}</p><small>{formatBand(notification.state)}</small></article>) ?? null}</div></>;
}

function formatBand(value: string): string {
  return value.toLowerCase().split('_').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}

