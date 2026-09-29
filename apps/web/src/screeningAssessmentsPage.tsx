/**
 * Screening tests an employer has sent this candidate, and taking one.
 *
 * Before starting, the candidate reads what the test covers and on what terms (EMP-12): the
 * question formats and count, the time actually available, one sitting, no camera, microphone
 * or screen capture, and where the result goes. Starting records that they read it.
 *
 * The paper is built by the server and frozen when the attempt starts: the option order
 * here is this candidate's own, and nothing in the payload says which answer is right. The
 * clock shown here is a courtesy; the server's clock decides, and the screen says so.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  getScreeningBrief,
  listScreeningInvitations,
  saveScreeningAnswer,
  startScreeningAttempt,
  submitScreeningAttempt,
  type ScreeningAttemptDto,
  type ScreeningBriefDto,
  type ScreeningInvitationDto,
} from './api.js';

const FORMAT_LABELS: Readonly<Record<string, string>> = {
  SINGLE_CHOICE_MCQ: 'single choice', MULTIPLE_SELECT: 'multiple select', TRUE_FALSE: 'true or false',
  SCENARIO_MCQ: 'scenario', CODE_OUTPUT_MCQ: 'code output', NUMERICAL_MCQ: 'numerical',
};

function windowLabel(invitation: ScreeningInvitationDto): string {
  const closes = new Date(invitation.closesAt);
  const days = Math.ceil((closes.getTime() - Date.now()) / 86400000);
  if (days < 0) return 'Closed';
  if (days === 0) return 'Closes today';
  return `Closes in ${days} ${days === 1 ? 'day' : 'days'}`;
}

function isOpen(invitation: ScreeningInvitationDto): boolean {
  return invitation.available !== false && new Date(invitation.closesAt).getTime() > Date.now();
}

function codeMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'ASSESSMENT_WINDOW_CLOSED': return 'That test has closed.';
    case 'ASSESSMENT_NOT_OPEN_YET': return 'That test has not opened yet.';
    case 'ASSESSMENT_ALREADY_SUBMITTED': return 'You have already submitted that test.';
    case 'ASSESSMENT_UNAVAILABLE': return 'That test is no longer available: the employer cannot take it forward, or your application is no longer shared with them.';
    case 'ATTEMPT_TIME_OVER': return 'Time ran out. Your answers saved before the time limit have been submitted.';
    default: return fallback;
  }
}

export function ScreeningAssessmentsPage(): React.ReactElement {
  const [invitations, setInvitations] = useState<readonly ScreeningInvitationDto[] | null>(null);
  const [status, setStatus] = useState('Loading…');
  const [brief, setBrief] = useState<ScreeningBriefDto | null>(null);
  const [attempt, setAttempt] = useState<ScreeningAttemptDto | null>(null);
  const [result, setResult] = useState<{ score: number; maxScore: number; percentage: number } | null>(null);

  const reload = async (message?: string): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const response = await listScreeningInvitations(token);
    setInvitations(response.invitations);
    setStatus(message ?? '');
  };
  useEffect(() => { void reload().catch(() => setStatus('Your screening tests could not be loaded.')); }, []);

  async function open(invitationId: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      const response = await getScreeningBrief(token, invitationId);
      setResult(null);
      setBrief(response.assessment);
    } catch (error) {
      setStatus(codeMessage((error as { code?: string })?.code, 'That test could not be opened.'));
    }
  }

  async function start(invitationId: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      const response = await startScreeningAttempt(token, invitationId);
      setBrief(null);
      setAttempt(response.attempt);
    } catch (error) {
      setBrief(null);
      setStatus(codeMessage((error as { code?: string })?.code, 'That test could not be opened.'));
    }
  }

  if (attempt) {
    return <AttemptRunner
      attempt={attempt}
      onFinished={(outcome) => { setAttempt(null); setResult(outcome); void reload(); }}
      onFailed={(message) => setStatus(message)}
      onTimeOver={() => { setAttempt(null); void reload(codeMessage('ATTEMPT_TIME_OVER', '')); }}
    />;
  }

  if (brief) {
    return <BriefPanel brief={brief} onStart={() => { void start(brief.id); }} onBack={() => setBrief(null)} />;
  }

  return <div className="workspace-grid">
    <section className="card wide-card">
      <h2>Screening tests</h2>
      <p>Tests employers have sent you for roles you applied to. Your result goes to that employer only — it is not part of your academic record and it does not change your readiness.</p>
      {status ? <p role="status">{status}</p> : null}
    </section>

    {result ? <section className="card wide-card">
      <h3>Submitted</h3>
      <p>You scored <strong>{result.percentage}%</strong> ({result.score} of {result.maxScore}).</p>
    </section> : null}

    {invitations && invitations.length === 0
      ? <section className="card wide-card"><p>No screening tests right now. If an employer sends you one it will appear here.</p></section>
      : null}

    {(invitations ?? []).map((invitation) => <section className="card wide-card" key={invitation.id}>
      <h3>{invitation.title}</h3>
      <p>{invitation.employerName} · {invitation.roleTitle} · {Math.round(invitation.durationSeconds / 60)} minutes
        {invitation.questionCount ? ` · ${invitation.questionCount} ${invitation.questionCount === 1 ? 'question' : 'questions'}` : ''}</p>
      <p className="hiring-meta">{windowLabel(invitation)}</p>
      {invitation.state === 'SUBMITTED'
        ? <p>Submitted{invitation.percentage === null ? '' : ` — you scored ${invitation.percentage}%`}.</p>
        : new Date(invitation.closesAt).getTime() < Date.now() || invitation.state === 'EXPIRED'
          ? <p className="hiring-meta">This test closed before it was submitted.</p>
          : !isOpen(invitation)
            ? <p className="hiring-meta">This test is no longer available: the employer cannot take it forward, or your application is no longer shared with them.</p>
            : <button type="button" onClick={() => { void open(invitation.id); }}>
              {invitation.state === 'STARTED' ? 'Continue' : 'Start'}
            </button>}
    </section>)}
  </div>;
}

/** What the test covers and the terms, read and agreed before the timer starts. */
function BriefPanel({ brief, onStart, onBack }: {
  readonly brief: ScreeningBriefDto;
  readonly onStart: () => void;
  readonly onBack: () => void;
}): React.ReactElement {
  const [agreed, setAgreed] = useState(false);
  const resuming = brief.attemptState === 'IN_PROGRESS';
  const minutes = brief.minutesAvailableIfStartedNow;
  const fullMinutes = Math.round(brief.durationSeconds / 60);
  return <div className="workspace-grid">
    <section className="card wide-card">
      <h2>{brief.title}</h2>
      <p>{brief.employerName} · {brief.roleTitle}</p>
      <h3>What you are assessed on</h3>
      <p>{brief.questionCount} {brief.questionCount === 1 ? 'question' : 'questions'}, {brief.totalMarks} marks in total:{' '}
        {brief.questionFormats.map((format) => `${format.count} ${FORMAT_LABELS[format.questionType] ?? format.questionType.toLowerCase()}`).join(', ')}.</p>
      <p>Time allowed: {fullMinutes} minutes.{' '}
        {minutes === null ? 'NA' : resuming ? `You have ${minutes} minutes left.` : minutes < fullMinutes
          ? `The test closes soon, so if you start now you have ${minutes} minutes.`
          : `If you start now you have the full ${minutes} minutes.`}</p>
      <p className="hiring-meta">Closes {new Date(brief.closesAt).toLocaleString()}.</p>
    </section>
    <section className="card wide-card">
      <h3>Before you start</h3>
      <ul className="check-stack">
        <li>One sitting. There is no second attempt at this test.</li>
        <li>The timer runs on ONE&rsquo;s server from the moment you start and does not pause if you close the page.</li>
        <li>No camera, microphone or screen capture is used, and nothing records switching tabs.</li>
        <li>Your result goes to {brief.employerName} for this application only, while they can see your application.</li>
        <li>It is not part of your academic record or your learning evidence, and it does not change your readiness.</li>
      </ul>
      {brief.notOpenYet
        ? <p role="status">This test opens {new Date(brief.opensAt).toLocaleString()}.</p>
        : !brief.available
          ? <p role="status">This test is no longer available.</p>
          : <>
            <label><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /> I have read what this test covers and how it works.</label>
            <div className="hiring-actions">
              <button type="button" disabled={!agreed} onClick={onStart}>{resuming ? 'Continue the test' : 'Begin the test'}</button>
              <button type="button" className="secondary" onClick={onBack}>Not now</button>
            </div>
          </>}
      {brief.notOpenYet || !brief.available ? <button type="button" className="secondary" onClick={onBack}>Back</button> : null}
    </section>
  </div>;
}

function AttemptRunner({ attempt, onFinished, onFailed, onTimeOver }: {
  readonly attempt: ScreeningAttemptDto;
  readonly onFinished: (result: { score: number; maxScore: number; percentage: number }) => void;
  readonly onFailed: (message: string) => void;
  readonly onTimeOver: () => void;
}): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>(
    Object.fromEntries(attempt.questions.map((question) => [question.questionId, question.selectedOptionKeys])),
  );
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [endsAt] = useState(() => (attempt.remainingSeconds === undefined ? null : Date.now() + attempt.remainingSeconds * 1000));
  const [secondsLeft, setSecondsLeft] = useState<number | null>(attempt.remainingSeconds ?? null);

  useEffect(() => {
    if (endsAt === null) return undefined;
    const timer = window.setInterval(() => setSecondsLeft(Math.max(0, Math.round((endsAt - Date.now()) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [endsAt]);

  async function choose(questionId: string, key: string, multiple: boolean): Promise<void> {
    const token = getAccessToken();
    const current = answers[questionId] ?? [];
    const next = multiple
      ? (current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
      : [key];
    setAnswers({ ...answers, [questionId]: next });
    if (!token) return;
    // Saved as they go, so a closed tab does not lose the paper.
    await saveScreeningAnswer(token, attempt.id, questionId, next).catch((error: unknown) => {
      if ((error as { code?: string })?.code === 'ATTEMPT_TIME_OVER') onTimeOver();
      else onFailed(codeMessage((error as { code?: string })?.code, 'That answer could not be saved.'));
    });
  }

  async function submit(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setSubmitting(true);
    try {
      const response = await submitScreeningAttempt(token, attempt.id);
      onFinished(response.result);
    } catch (error) {
      onFailed(codeMessage((error as { code?: string })?.code, 'That test could not be submitted.'));
    } finally { setSubmitting(false); }
  }

  const answered = attempt.questions.filter((question) => (answers[question.questionId] ?? []).length > 0).length;
  const clock = secondsLeft === null ? null : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;

  return <div className="workspace-grid">
    <section className="card wide-card">
      <h2>Screening test in progress</h2>
      <p>{answered} of {attempt.questions.length} answered. Your answers are saved as you go.</p>
      {clock ? <p className="hiring-meta" role="timer">Time left: {clock}. ONE&rsquo;s server keeps the time; answers after it runs out are not saved.</p> : null}
    </section>

    {attempt.questions.map((question) => {
      const multiple = question.questionType === 'MULTIPLE_SELECT';
      const chosen = answers[question.questionId] ?? [];
      return <section className="card wide-card" key={question.questionId}>
        <h3>Question {question.displayOrder}</h3>
        <p>{question.questionText}</p>
        <ul className="check-stack">
          {question.options.map((option) => <li key={option.key}>
            <label>
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={`question-${question.questionId}`}
                checked={chosen.includes(option.key)}
                onChange={() => { void choose(question.questionId, option.key, multiple); }}
              />
              {' '}{option.text}
            </label>
          </li>)}
        </ul>
        <p className="hiring-meta">{question.marks} {question.marks === 1 ? 'mark' : 'marks'}</p>
      </section>;
    })}

    <section className="card wide-card">
      {confirming
        ? <>
          <p><strong>Submitting is final.</strong> You cannot change your answers afterwards, and there is no second attempt at this test.</p>
          <div className="hiring-actions">
            <button type="button" disabled={submitting} onClick={() => { void submit(); }}>Yes, submit</button>
            <button type="button" className="secondary" onClick={() => setConfirming(false)}>Keep working</button>
          </div>
        </>
        : <button type="button" onClick={() => setConfirming(true)}>Submit test</button>}
    </section>
  </div>;
}
