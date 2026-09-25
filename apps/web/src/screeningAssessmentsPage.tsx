/**
 * Screening tests an employer has sent this candidate, and taking one.
 *
 * The paper is built by the server and frozen when the attempt starts: the option order
 * here is this candidate's own, and nothing in the payload says which answer is right.
 * Submitting is final, so the screen says so before the button rather than after it.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  listScreeningInvitations,
  saveScreeningAnswer,
  startScreeningAttempt,
  submitScreeningAttempt,
  type ScreeningAttemptDto,
  type ScreeningInvitationDto,
} from './api.js';

function windowLabel(invitation: ScreeningInvitationDto): string {
  const closes = new Date(invitation.closesAt);
  const days = Math.ceil((closes.getTime() - Date.now()) / 86400000);
  if (days < 0) return 'Closed';
  if (days === 0) return 'Closes today';
  return `Closes in ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function ScreeningAssessmentsPage(): React.ReactElement {
  const [invitations, setInvitations] = useState<readonly ScreeningInvitationDto[] | null>(null);
  const [status, setStatus] = useState('Loading…');
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

  async function start(invitationId: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      const response = await startScreeningAttempt(token, invitationId);
      setResult(null);
      setAttempt(response.attempt);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      setStatus(code === 'ASSESSMENT_WINDOW_CLOSED' ? 'That test has closed.'
        : code === 'ASSESSMENT_NOT_OPEN_YET' ? 'That test has not opened yet.'
          : code === 'ASSESSMENT_ALREADY_SUBMITTED' ? 'You have already submitted that test.'
            : 'That test could not be opened.');
    }
  }

  if (attempt) {
    return <AttemptRunner
      attempt={attempt}
      onFinished={(outcome) => { setAttempt(null); setResult(outcome); void reload(); }}
      onFailed={(message) => setStatus(message)}
    />;
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
      <p>{invitation.employerName} · {invitation.roleTitle} · {Math.round(invitation.durationSeconds / 60)} minutes</p>
      <p className="hiring-meta">{windowLabel(invitation)}</p>
      {invitation.state === 'SUBMITTED'
        ? <p>Submitted{invitation.percentage === null ? '' : ` — you scored ${invitation.percentage}%`}.</p>
        : new Date(invitation.closesAt).getTime() < Date.now()
          ? <p className="hiring-meta">This test closed before it was submitted.</p>
          : <button type="button" onClick={() => { void start(invitation.id); }}>
            {invitation.state === 'STARTED' ? 'Continue' : 'Start'}
          </button>}
    </section>)}
  </div>;
}

function AttemptRunner({ attempt, onFinished, onFailed }: {
  readonly attempt: ScreeningAttemptDto;
  readonly onFinished: (result: { score: number; maxScore: number; percentage: number }) => void;
  readonly onFailed: (message: string) => void;
}): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>(
    Object.fromEntries(attempt.questions.map((question) => [question.questionId, question.selectedOptionKeys])),
  );
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function choose(questionId: string, key: string, multiple: boolean): Promise<void> {
    const token = getAccessToken();
    const current = answers[questionId] ?? [];
    const next = multiple
      ? (current.includes(key) ? current.filter((item) => item !== key) : [...current, key])
      : [key];
    setAnswers({ ...answers, [questionId]: next });
    if (!token) return;
    // Saved as they go, so a closed tab does not lose the paper.
    await saveScreeningAnswer(token, attempt.id, questionId, next).catch(() => onFailed('That answer could not be saved.'));
  }

  async function submit(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setSubmitting(true);
    try {
      const response = await submitScreeningAttempt(token, attempt.id);
      onFinished(response.result);
    } catch {
      onFailed('That test could not be submitted.');
    } finally { setSubmitting(false); }
  }

  const answered = attempt.questions.filter((question) => (answers[question.questionId] ?? []).length > 0).length;

  return <div className="workspace-grid">
    <section className="card wide-card">
      <h2>Screening test in progress</h2>
      <p>{answered} of {attempt.questions.length} answered. Your answers are saved as you go.</p>
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
