import { useEffect, useRef, useState } from 'react';
import {
  getProtectedAccessToken,
  listStudentExams,
  reportExamFocusEvent,
  saveExamAnswer,
  startExamAttempt,
  submitExamAttempt,
  type ExamAttemptDto,
  type ExamAttemptQuestionDto,
  type ExamResultDto,
  type StudentExamDto,
} from './api.js';

/**
 * The student side of the institution assessment engine: assigned exams, a
 * timed attempt with per-question saving and focus-loss reporting, and the
 * scored result. Papers and grading live entirely on the server - this panel
 * never sees a correct answer before submission.
 */
export function ExamAttemptPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [exams, setExams] = useState<StudentExamDto[] | null>(null);
  const [attempt, setAttempt] = useState<ExamAttemptDto | null>(null);
  const [result, setResult] = useState<ExamResultDto | null>(null);
  const [status, setStatus] = useState('Loading your assigned assessments…');
  const [busy, setBusy] = useState(false);

  async function refresh(signal?: AbortSignal): Promise<void> {
    if (!token) return;
    try {
      const response = await listStudentExams(token, signal);
      setExams(response.assessments);
      setStatus(response.assessments.length
        ? 'These assessments were assigned by your institution.'
        : 'No assessments are assigned to you yet. They appear here when your institution schedules one.');
    } catch {
      setExams([]);
      setStatus('Assigned assessments could not be loaded right now.');
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [token]);

  if (!token) {
    return (
      <section className="career-api-panel" aria-labelledby="exam-panel-title">
        <div className="career-api-heading">
          <div><span className="eyebrow">Institution assessments</span><h2 id="exam-panel-title">Scheduled Assessments</h2></div>
        </div>
        <p className="career-api-status" role="status">Sign in to see the assessments your institution has assigned to you.</p>
      </section>
    );
  }

  async function start(definitionId: string): Promise<void> {
    setBusy(true);
    try {
      const response = await startExamAttempt(token as string, definitionId);
      setResult(null);
      setAttempt(response.attempt);
    } catch (error) {
      setStatus(error instanceof Error && 'code' in error ? `The attempt could not start (${String((error as { code?: string }).code ?? 'error')}).` : 'The attempt could not start.');
    } finally {
      setBusy(false);
    }
  }

  if (attempt) {
    return <ExamAttemptRunner
      token={token}
      attempt={attempt}
      onFinished={(finished) => { setAttempt(null); setResult(finished); void refresh(); }}
      onExit={() => { setAttempt(null); void refresh(); }}
    />;
  }

  return (
    <section className="career-api-panel" aria-labelledby="exam-panel-title">
      <div className="career-api-heading">
        <div><span className="eyebrow">Institution assessments</span><h2 id="exam-panel-title">Scheduled Assessments</h2></div>
        <span className={`career-api-state ${exams ? 'connected' : 'unavailable'}`}>{exams ? 'API-backed' : 'Loading'}</span>
      </div>
      <p className="career-api-status" role="status" aria-live="polite">{status}</p>
      {result ? (
        <div className="role-card role-wide exam-result-card">
          <h3>Result recorded</h3>
          <p><strong>{result.score}</strong> / {result.maxScore} · {result.percentage}% — {result.correct} correct, {result.wrong} wrong, {result.notAttempted} not attempted.</p>
        </div>
      ) : null}
      {exams?.length ? (
        <div className="exam-list">
          {exams.map((exam) => {
            const windowOpen = Date.now() >= Date.parse(exam.startsAt) && Date.now() <= Date.parse(exam.endsAt);
            const attemptsLeft = exam.attemptsAllowed - exam.attemptsUsed;
            return (
              <div key={exam.id} className="exam-list-row">
                <div className="exam-list-main">
                  <strong>{exam.title}</strong>
                  <small>{exam.subjectName} · {exam.assessmentKind.replace('_', ' ')} · {exam.institutionName}</small>
                  <small>{new Date(exam.startsAt).toLocaleString()} → {new Date(exam.endsAt).toLocaleString()} · {Math.round(exam.durationSeconds / 60)} min · {exam.totalMarks} marks</small>
                </div>
                <div className="exam-list-side">
                  {exam.latestResult ? <span className="exam-chip done">{exam.latestResult.percentage}%</span> : null}
                  <small>{exam.attemptsUsed} / {exam.attemptsAllowed} attempts used</small>
                  {exam.openAttemptId ? (
                    <button type="button" disabled={busy} onClick={() => void start(exam.id)}>Resume Attempt</button>
                  ) : windowOpen && attemptsLeft > 0 ? (
                    <button type="button" disabled={busy} onClick={() => void start(exam.id)}>Start Attempt</button>
                  ) : (
                    <span className="exam-chip muted" title={attemptsLeft <= 0 ? 'All allowed attempts are used. Your institution can grant a retake.' : Date.now() < Date.parse(exam.startsAt) ? 'The window has not opened yet.' : 'The window has closed. Your institution can reopen it.'}>
                      {attemptsLeft <= 0 ? (exam.latestResult ? 'Completed' : 'Attempts used') : Date.now() < Date.parse(exam.startsAt) ? 'Opens soon' : 'Window closed'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function ExamAttemptRunner({ token, attempt, onFinished, onExit }: {
  readonly token: string;
  readonly attempt: ExamAttemptDto;
  readonly onFinished: (result: ExamResultDto | null) => void;
  readonly onExit: () => void;
}): React.ReactElement {
  const [remaining, setRemaining] = useState(attempt.remainingSeconds);
  const [saveState, setSaveState] = useState('All changes save automatically.');
  const [focusNote, setFocusNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitted = useRef(false);

  async function finalize(): Promise<void> {
    if (submitted.current) return;
    submitted.current = true;
    setSubmitting(true);
    try {
      const response = await submitExamAttempt(token, attempt.id);
      onFinished(response.result);
    } catch {
      submitted.current = false;
      setSubmitting(false);
      setSaveState('Submission failed. Check your connection and press Submit again.');
    }
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((previous) => {
        if (previous <= 1) {
          clearInterval(timer);
          void finalize();
          return 0;
        }
        return previous - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden' || submitted.current) return;
      void reportExamFocusEvent(token, attempt.id).then((event) => {
        if (event.autoSubmitted) {
          submitted.current = true;
          onFinished(event.result ?? null);
        } else if (event.level === 'WARNING') {
          setFocusNote('Leaving this tab is recorded. One more switch will auto-submit your attempt.');
        } else if (event.remainingBeforeAutoSubmit != null) {
          setFocusNote(`Tab switches are recorded (${event.remainingBeforeAutoSubmit} remaining before auto-submit).`);
        } else {
          setFocusNote('Tab switches are recorded on your attempt.');
        }
      }).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [token, attempt.id]);

  async function save(questionId: string, response: unknown): Promise<void> {
    try {
      await saveExamAnswer(token, attempt.id, questionId, response);
      setSaveState('Saved.');
    } catch {
      setSaveState('An answer failed to save. It will be retried when you change it again.');
    }
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return (
    <section className="career-api-panel exam-runner" aria-labelledby="exam-runner-title">
      <div className="career-api-heading">
        <div><span className="eyebrow">Attempt {attempt.attemptNumber} · in progress</span><h2 id="exam-runner-title">{attempt.title}</h2></div>
        <span className={`exam-timer ${remaining <= 60 ? 'critical' : ''}`} role="timer" aria-live="off">{minutes}:{String(seconds).padStart(2, '0')}</span>
      </div>
      <p className="career-api-status" role="status">{saveState}{focusNote ? ` ${focusNote}` : ''}</p>
      <div className="exam-questions">
        {attempt.questions.map((question) => (
          <ExamQuestionCard key={question.questionId} question={question} onSave={(response) => void save(question.questionId, response)} />
        ))}
      </div>
      <div className="exam-runner-actions">
        <button type="button" className="secondary" onClick={onExit} disabled={submitting}>Save &amp; Exit (resume later)</button>
        <button type="button" onClick={() => void finalize()} disabled={submitting}>{submitting ? 'Submitting…' : 'Submit Assessment'}</button>
      </div>
    </section>
  );
}

function ExamQuestionCard({ question, onSave }: {
  readonly question: ExamAttemptQuestionDto;
  readonly onSave: (response: unknown) => void;
}): React.ReactElement {
  const saved = (question.savedResponse ?? {}) as { selectedOptionKeys?: string[]; text?: string; matches?: Record<string, string> };
  const [selected, setSelected] = useState<string[]>(saved.selectedOptionKeys ?? []);
  const [text, setText] = useState(saved.text ?? '');
  const [matches, setMatches] = useState<Record<string, string>>(saved.matches ?? {});
  const multi = question.questionType === 'MULTIPLE_SELECT';

  function chooseOption(key: string): void {
    const next = multi
      ? (selected.includes(key) ? selected.filter((value) => value !== key) : [...selected, key])
      : [key];
    setSelected(next);
    onSave({ selectedOptionKeys: next });
  }

  return (
    <div className="role-card role-wide exam-question">
      <div className="exam-question-head">
        <strong>Q{question.position}.</strong>
        <span className="exam-question-text">{question.questionText}</span>
        <span className="exam-chip muted">{question.marks} mark{question.marks === 1 ? '' : 's'}{question.negativeMarks > 0 ? ` · −${question.negativeMarks} wrong` : ''}</span>
      </div>
      {question.questionType === 'FILL_IN_THE_BLANK' ? (
        <label className="exam-fill">
          <span>Your answer</span>
          <input value={text} onChange={(event) => setText(event.target.value)} onBlur={() => onSave({ text })} />
        </label>
      ) : question.questionType === 'MATCH_THE_FOLLOWING' && question.options ? (
        <div className="exam-match">
          {question.options.map((option) => (
            <label key={option.key}>
              <span>{option.text}</span>
              <select value={matches[option.key] ?? ''} onChange={(event) => {
                const next = { ...matches, [option.key]: event.target.value };
                setMatches(next);
                onSave({ matches: next });
              }}>
                <option value="">Select…</option>
                {(question.matchTargets ?? []).map((target) => <option key={target} value={target}>{target}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : (
        <div className="exam-options" role={multi ? 'group' : 'radiogroup'}>
          {(question.options ?? []).map((option) => (
            <label key={option.key} className={`exam-option ${selected.includes(option.key) ? 'chosen' : ''}`}>
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={`question-${question.questionId}`}
                checked={selected.includes(option.key)}
                onChange={() => chooseOption(option.key)}
              />
              <span className="exam-option-key">{option.key}</span>
              <span>{option.text}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
