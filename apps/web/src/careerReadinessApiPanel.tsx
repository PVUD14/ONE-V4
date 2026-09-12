import { useEffect, useMemo, useState } from 'react';
import {
  ApiRequestError,
  completeCareerReadinessLesson,
  getCareerReadinessAccessToken,
  getCareerReadinessCatalog,
  getLearnerCareerReadinessState,
  startCareerReadinessAssessment,
  submitCareerReadinessAssessment,
  type AssessmentAttemptDto,
  type CareerReadinessCatalog,
  type LearnerCareerReadinessState,
} from './api.js';
import { V2EmptyState, V2Stat } from './dashboardsV2.js';

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
        setStatus('API-backed learner state is current.');
      } else {
        setStatus('Published API content is available. Sign in to record learner progress.');
      }
    } catch {
      setStatus('Career Readiness API is unavailable. The demo preview below remains read-only and separate.');
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
      setStatus('Lesson completion and evidence were committed by the API.');
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
        <div><span className="eyebrow">Published API content</span><h2 id="career-api-title">Career Readiness Fundamentals</h2></div>
        <span className={`career-api-state ${catalog ? 'connected' : 'unavailable'}`}>{catalog ? 'API-backed' : 'API unavailable'}</span>
      </div>
      <p className="career-api-status" role="status" aria-live="polite">{status}</p>
      {route === 'learning' ? <LearningApiView catalog={catalog} learner={learner} token={token} busy={busy} onComplete={complete} /> : null}
      {route === 'assessments' ? <AssessmentApiView catalog={catalog} learner={learner} token={token} busy={busy} attempt={attempt}
        selectedOptions={selectedOptions} onSelect={(questionId, optionId) => setSelectedOptions((current) => ({ ...current, [questionId]: optionId }))}
        onStart={start} onSubmit={submit} /> : null}
      {learner && route !== 'notifications' ? <CareerStatStrip learner={learner} catalog={catalog} /> : null}
      {route === 'readiness' ? <ReadinessApiView learner={learner} /> : null}
      {route === 'skills' ? <SkillsApiView learner={learner} /> : null}
      {route === 'roadmap' ? <RoadmapApiView learner={learner} /> : null}
      {route === 'notifications' ? <NotificationsApiView learner={learner} /> : null}
      <p className="career-api-boundary">Named bands are advisory, never employer-visible, and derived only from versioned ONE evidence. The preview content below is not written to the API.</p>
    </section>
  );
}

function LearningApiView({ catalog, learner, token, busy, onComplete }: {
  readonly catalog: CareerReadinessCatalog | null; readonly learner: LearnerCareerReadinessState | null; readonly token: string | null;
  readonly busy: boolean; readonly onComplete: (lessonId: string) => void;
}): React.ReactElement {
  const completed = new Set(learner?.progress?.filter((item) => item.state === 'COMPLETED').map((item) => item.lessonVersionId) ?? []);
  return <div className="career-api-grid">{(catalog?.modules ?? []).flatMap((module) => module.lessons).map((lesson) => (
    <article key={lesson.id}><span>{completed.has(lesson.id) ? 'Completed with evidence' : 'Published lesson'}</span><h3>{lesson.title}</h3>
      <p>{lesson.body.summary}</p><small>{lesson.prerequisiteLessonIds.length ? `${lesson.prerequisiteLessonIds.length} prerequisite` : 'No prerequisite'}</small>
      <button type="button" disabled={!token || busy || completed.has(lesson.id)} onClick={() => onComplete(lesson.id)}>{completed.has(lesson.id) ? 'Completed' : 'Complete lesson'}</button>
    </article>
  )) ?? null}</div>;
}

function AssessmentApiView({ catalog, learner, token, busy, attempt, selectedOptions, onSelect, onStart, onSubmit }: {
  readonly catalog: CareerReadinessCatalog | null; readonly learner: LearnerCareerReadinessState | null; readonly token: string | null;
  readonly busy: boolean; readonly attempt: AssessmentAttemptDto | null; readonly selectedOptions: Readonly<Record<string, string>>;
  readonly onSelect: (questionId: string, optionId: string) => void; readonly onStart: (assessmentId: string) => void; readonly onSubmit: () => void;
}): React.ReactElement {
  if (attempt) return <form className="career-assessment-form" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
    <p>Expires {new Date(attempt.expiresAt).toLocaleString()}. Answer keys and scoring logic remain server-side.</p>
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

function ReadinessApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  return learner?.readiness ? <div className="career-readiness-result"><span>Current advisory band</span><strong>{formatBand(learner.readiness.band)}</strong>
    <p>Based on {learner.evidence.length} immutable evidence record{learner.evidence.length === 1 ? '' : 's'}. No personal readiness history is shown.</p></div>
    : <V2EmptyState icon="📈" title="No advisory band yet"
      note="Complete learning and the published assessment to create enough evidence. Bands are advisory and never employer-visible." />;
}

function SkillsApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  return <div className="career-api-grid">{learner?.mastery?.map((mastery) => <article key={mastery.id}><span>Evidence-derived mastery</span>
    <h3>{formatBand(mastery.band)}</h3><p>{mastery.evidenceIds.length} active evidence record{mastery.evidenceIds.length === 1 ? '' : 's'}.</p></article>) ?? null}</div>;
}

function RoadmapApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  if (!learner?.roadmap?.length) return <V2EmptyState icon="🗺️" title="No next action yet"
    note="Advisory next actions appear here after your versioned evidence is evaluated — complete lessons and assessments to generate them." />;
  return <div className="career-api-grid">{learner.roadmap.map((action) => <article key={action.id}><span>Advisory next action</span>
    <h3>{formatBand(action.actionCode)}</h3><p>Reason: {formatBand(action.reasonCode)}. State: {formatBand(action.state)}.</p>
    {action.dueAt ? <small>Due {new Date(action.dueAt).toLocaleDateString()}</small> : null}</article>)}</div>;
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

