import { useEffect, useMemo, useState } from 'react';
import {
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
    } catch {
      setStatus('The lesson could not be completed. Check prerequisites and try again.');
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
      {route === 'readiness' ? <ReadinessApiView learner={learner} /> : null}
      {route === 'skills' ? <SkillsApiView learner={learner} /> : null}
      {route === 'roadmap' ? <RoadmapApiView learner={learner} /> : null}
      {route === 'notifications' ? <NotificationsApiView learner={learner} /> : null}
      <p className="career-api-boundary">Named bands are advisory, never employer-visible, and derived only from versioned PlanThePath evidence. The preview content below is not written to the API.</p>
    </section>
  );
}

function LearningApiView({ catalog, learner, token, busy, onComplete }: {
  readonly catalog: CareerReadinessCatalog | null; readonly learner: LearnerCareerReadinessState | null; readonly token: string | null;
  readonly busy: boolean; readonly onComplete: (lessonId: string) => void;
}): React.ReactElement {
  const completed = new Set(learner?.progress.filter((item) => item.state === 'COMPLETED').map((item) => item.lessonVersionId) ?? []);
  return <div className="career-api-grid">{catalog?.modules.flatMap((module) => module.lessons).map((lesson) => (
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
  return <div className="career-api-grid">{catalog?.assessments.map((assessment) => <article key={assessment.id}><span>Published assessment</span>
    <h3>{assessment.title}</h3><p>{assessment.selectionCount} questions · {Math.round(assessment.timeLimitSeconds / 60)} minutes · one attempt</p>
    <button type="button" disabled={!token || busy || Boolean(learner?.attempts.length)} onClick={() => onStart(assessment.id)}>Start assessment</button>
  </article>) ?? null}</div>;
}

function ReadinessApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  return learner?.readiness ? <div className="career-readiness-result"><span>Current advisory band</span><strong>{formatBand(learner.readiness.band)}</strong>
    <p>Based on {learner.evidence.length} immutable evidence record{learner.evidence.length === 1 ? '' : 's'}. No personal readiness history is shown.</p></div>
    : <p className="career-api-empty">No advisory band yet. Complete learning and the published assessment to create enough evidence.</p>;
}

function SkillsApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  return <div className="career-api-grid">{learner?.mastery.map((mastery) => <article key={mastery.id}><span>Evidence-derived mastery</span>
    <h3>{formatBand(mastery.band)}</h3><p>{mastery.evidenceIds.length} active evidence record{mastery.evidenceIds.length === 1 ? '' : 's'}.</p></article>) ?? null}</div>;
}

function RoadmapApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  if (!learner?.roadmap.length) return <p className="career-api-empty">No API-backed next action yet. Recommendations appear only after versioned evidence is evaluated.</p>;
  return <div className="career-api-grid">{learner.roadmap.map((action) => <article key={action.id}><span>Advisory next action</span>
    <h3>{formatBand(action.actionCode)}</h3><p>Reason: {formatBand(action.reasonCode)}. State: {formatBand(action.state)}.</p>
    {action.dueAt ? <small>Due {new Date(action.dueAt).toLocaleDateString()}</small> : null}</article>)}</div>;
}

function NotificationsApiView({ learner }: { readonly learner: LearnerCareerReadinessState | null }): React.ReactElement {
  const preference = learner?.notificationPreferences;
  return <><p className="career-api-status">Email is {preference?.emailEnabled ? 'enabled' : 'not enabled'}; daily cap {preference?.dailyCap ?? 0}. Destinations stay server-side.</p>
    <div className="career-api-grid">{learner?.notifications.map((notification) => <article key={notification.id}><span>Native email command</span>
      <h3>{formatBand(notification.templateKey)}</h3><p>{notification.legalPurpose}</p><small>{formatBand(notification.state)}</small></article>) ?? null}</div></>;
}

function formatBand(value: string): string {
  return value.toLowerCase().split('_').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}
