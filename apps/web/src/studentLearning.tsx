/**
 * The student learning experience on the web (ENG-18), shown at the top of the authenticated Learning page,
 * with a short "Practice by skill" card on the Practice page.
 *
 * Why it exists: the engine can now say what a student should do next and why. This is where the student sees
 * it: the placement test (after the onboarding question in My Career), one next step with its reasons, practice
 * on that step with the hint ladder, the path in skip / review / learn groups, and what is due for review. It uses
 * the pilot design system and the existing navigation only (no item added, renamed or moved), shows labels and
 * reasons — never a readiness value, a score, a likelihood, a due date or any other model number — and says NA or
 * states plainly what is not available rather than inventing it. Everything works with every AI flag off.
 */
import React, { useEffect, useState } from 'react';
import { BookOpen, ClipboardCheck, Lightbulb, RotateCcw, SkipForward, Target } from 'lucide-react';
import { getAccessToken } from './auth.js';
import {
  answerPlacementQuestion,
  answerStepQuestion,
  getLearningPath,
  getMyLearningActions,
  getPlacementTest,
  revealStepHint,
  startNextLearningStep,
  startPlacementTest,
  type LearningPathDto,
  type LearningStepDto,
  type PathBand,
  type PathEntryDto,
  type PlacementDto,
  type PlacementLevel,
  type StepAction,
  type StepAnswerDto,
  type StudentLearningActionsDto,
} from './api.js';
import { FromYourLecturerCard, hasLecturerWork, isStudentLearningActions } from './studentLearningActions.js';
import { go } from './pilotParity/naWidgets.js';

/** Plain words for every reason code the planner and the path grouping can give. */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  FACULTY_OVERRIDE: 'Your faculty set this step.',
  DUE_REVIEW: 'It is due for review — a quick check that you still remember it.',
  FACULTY_ASSIGNMENT: 'Your faculty assigned it.',
  REPEATED_MISCONCEPTION: 'The same mistake has come up more than once.',
  GAP_UNKNOWN: 'Nothing has measured this skill yet.',
  GAP_MISSING: 'Your evidence does not meet this requirement yet.',
  GAP_PARTIAL: 'Your evidence partly meets this requirement.',
  REQUIREMENT_ESSENTIAL: 'Your target role lists it as essential.',
  REQUIREMENT_IMPORTANT: 'Your target role lists it as important.',
  REQUIREMENT_HELPFUL: 'Your target role lists it as helpful.',
  SHORTER_ACTION_FOR_SESSION: 'It fits the time you have.',
  SESSION_TIME_SHORT: 'Every step needs more time than you have; this is the shortest.',
  NEW_SKILL: 'You have not practised it yet.',
  NOT_ENOUGH_EVIDENCE: 'There is not enough evidence about it yet.',
  NEAR_MASTERY: 'You are close to showing it.',
  STUCK: 'You have tried it on more than one day without an unaided success.',
  ACTIVE_MISCONCEPTION: 'A mistake pattern is still open on it.',
  NO_APPLICABLE_STRATEGY: 'No published teaching approach fits yet, so this is plain practice.',
  NON_ADAPTIVE_NO_CONSENT: 'Your plan follows your target role’s order; it does not adapt to your answers.',
  NO_CAREER_TARGET: 'You have not chosen a target role yet.',
  ALL_REQUIREMENTS_MET: 'Every requirement of your target role is met.',
  ALREADY_MET: 'Already met by your evidence.',
  PRACTISED_BEFORE: 'You have practised it before.',
};

const ACTION_LABEL: Readonly<Record<StepAction, string>> = {
  REVIEW: 'Review', REMEDIATE: 'Fix a mistake pattern', PRACTICE: 'Practise', LEARN: 'Learn', FOLLOW_ASSIGNMENT: 'Assigned by faculty', NONE: 'Nothing to do right now',
};

export const BAND_LABEL: Readonly<Record<PathBand, string>> = {
  NOT_ENOUGH_EVIDENCE: 'Not enough evidence', DEVELOPING: 'Developing', PROGRESSING: 'Progressing', DEMONSTRATED: 'Demonstrated',
};

const PLACEMENT_LEVEL: Readonly<Record<PlacementLevel, string>> = {
  AWARE: 'Aware', GUIDED: 'Guided', INDEPENDENT: 'Independent', TROUBLESHOOT: 'Can troubleshoot', NOT_ENOUGH_EVIDENCE: 'Not enough evidence',
};

const muted: React.CSSProperties = { color: 'var(--p-muted)', margin: '4px 0' };

function bandChip(band: PathBand): React.ReactElement {
  const tone = band === 'DEMONSTRATED' ? 'green' : band === 'PROGRESSING' ? 'blue' : band === 'DEVELOPING' ? 'amber' : 'slate';
  return <span className={`pilot-chip ${tone}`}>{BAND_LABEL[band]}</span>;
}

function errorText(error: unknown, fallback: string): string {
  return (error as { detail?: string }).detail ?? fallback;
}

// --- The page section ---------------------------------------------------------

export function StudentLearningPlan(): React.ReactElement {
  const [path, setPath] = useState<LearningPathDto | null>(null);
  const [status, setStatus] = useState('Loading your plan…');
  const [step, setStep] = useState<LearningStepDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // INST-16: what the student's lecturers set for them (assignments, sessions, a chosen next step).
  const [lecturer, setLecturer] = useState<StudentLearningActionsDto | null>(null);
  const [lecturerStatus, setLecturerStatus] = useState('Loading…');

  function load(signal?: AbortSignal): void {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); setLecturerStatus('You are not signed in.'); return; }
    getMyLearningActions(token, signal)
      .then((loaded) => { if (!isStudentLearningActions(loaded)) throw new Error('unexpected learning actions response'); setLecturer(loaded); setLecturerStatus(''); })
      .catch(() => { if (!signal?.aborted) setLecturerStatus('NA — what your lecturers set could not be loaded right now.'); });
    getLearningPath(token, signal)
      .then((loaded) => {
        const value = loaded?.path;
        // A response without the groups is treated as unavailable, never guessed at.
        if (!value || !Array.isArray(value.groups?.skip) || !Array.isArray(value.groups?.review) || !Array.isArray(value.groups?.learn)) throw new Error('unexpected path response');
        setPath(value); setStatus('');
        // A refresh after acting keeps the step the student is on; only the first load takes the latest one.
        setStep((current) => current ?? value.latestStep);
      })
      .catch(() => { if (!signal?.aborted) setStatus('NA — your learning plan could not be loaded right now.'); });
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, []);

  async function planNext(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true); setNotice('');
    try {
      setStep((await startNextLearningStep(token)).step);
      load();
    } catch (error) {
      setNotice(errorText(error, 'Your next step could not be planned. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  const lecturerWork = hasLecturerWork(lecturer);
  return <>
    <PlacementCard />
    <FromYourLecturerCard actions={lecturer} status={lecturerStatus} busy={busy} onStart={() => void planNext()} />
    <section className="pilot-card" aria-labelledby="next-step-heading">
      <div className="pilot-card-head">
        <h2 id="next-step-heading">Your next step</h2>
        {step ? <span className="pilot-chip purple">{ACTION_LABEL[step.action]}</span> : <span className="pilot-chip slate">NA</span>}
      </div>
      {notice ? <p role="alert" className="pilot-chip rose" style={{ display: 'inline-block' }}>{notice}</p> : null}
      {!path ? <p style={muted}>{status}</p> : !path.target && !lecturerWork ? <>
        <p style={muted}>Choose the job you want first. Your path and next steps are planned against it.</p>
        <button type="button" className="pilot-btn small" onClick={() => go('/student/career-path')}>Go to My Career</button>
      </> : <>
        {!path.target ? <p style={muted}>Your lecturer’s work is planned now. Choose the job you want in My Career to plan the rest of your path.</p> : null}
        {step ? <StepCard step={step} onStep={(next) => { setStep(next); load(); }} /> : <p style={muted}>No step planned yet.</p>}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="pilot-btn small" disabled={busy} onClick={() => void planNext()}>
            {step ? 'Plan my next step' : 'Plan my first step'}
          </button>
        </div>
      </>}
    </section>
    <PathCard path={path} status={status} />
    <section className="pilot-card" aria-labelledby="due-heading">
      <div className="pilot-card-head"><h2 id="due-heading">Due for review</h2>
        {path?.adaptive ? <span className="pilot-chip blue">{path.dueReviews.length ? 'Due now' : 'Nothing due'}</span> : <span className="pilot-chip slate">NA</span>}
      </div>
      {!path ? <p style={muted}>{status}</p>
        : !path.adaptive ? <p style={muted}>NA — reviews are scheduled from your answers once adaptive learning is available to you.</p>
          : path.dueReviews.length === 0 ? <p style={muted}>Nothing is due for review right now.</p>
            : <div className="pilot-list">
              {path.dueReviews.map((review) => <div key={review.skillId} className="pilot-list-row">
                <span className="pilot-tile blue"><RotateCcw size={16} /></span>
                <div className="grow"><strong>{review.skillName}</strong><small>Due for review</small></div>
              </div>)}
            </div>}
    </section>
  </>;
}

// --- One step and its practice ---------------------------------------------------

function StepCard({ step, onStep }: { readonly step: LearningStepDto; readonly onStep: (step: LearningStepDto) => void }): React.ReactElement {
  return <div>
    <p style={{ margin: '4px 0 8px' }}><strong>{step.skill ? step.skill.name : ACTION_LABEL.NONE}</strong></p>
    <strong style={{ fontSize: 12 }}>Why this step</strong>
    <ul aria-label="Why this step" style={{ margin: '4px 0 10px', paddingLeft: 18 }}>
      {step.reasonCodes.map((code) => <li key={code}>{REASON_TEXT[code] ?? 'A rule of your plan chose it.'}</li>)}
    </ul>
    {step.lessons.length ? <div style={{ marginBottom: 10 }}>
      <strong style={{ fontSize: 12 }}>Lessons on this skill</strong>
      <div className="pilot-list">{step.lessons.map((lesson) => <div key={lesson.id} className="pilot-list-row">
        <span className="pilot-tile teal"><BookOpen size={16} /></span><div className="grow"><strong>{lesson.title}</strong><small>Listed with your modules below</small></div>
      </div>)}</div>
    </div> : null}
    <StepPractice key={step.decisionId} step={step} onStep={onStep} />
  </div>;
}

function StepPractice({ step, onStep }: { readonly step: LearningStepDto; readonly onStep: (step: LearningStepDto) => void }): React.ReactElement | null {
  const [choice, setChoice] = useState('');
  const [feedback, setFeedback] = useState<StepAnswerDto['feedback'] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const practice = step.practice;

  if (practice.status === 'NO_SKILL') return null;
  if (practice.status === 'NO_PRACTICE') {
    return <p style={muted}>No published practice for this skill yet. Your plan will use it as soon as questions are published.</p>;
  }
  if (practice.status === 'COMPLETED') {
    return <div>
      {feedback ? <p role="status" className={`pilot-chip ${feedback.correct ? 'green' : 'amber'}`} style={{ display: 'inline-block' }}>{feedback.correct ? 'Right.' : 'Not quite.'}{feedback.assisted ? ' Counted as assisted.' : ''}</p> : null}
      <p style={muted}>Step finished: you answered {practice.questionsAnswered} {practice.questionsAnswered === 1 ? 'question' : 'questions'}. Plan your next step when you are ready.</p>
    </div>;
  }
  const question = practice.question;
  const nextHintAssists = question.hints.length >= 2;

  async function hint(): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true); setError('');
    try { onStep((await revealStepHint(token, step.decisionId, question.id)).step); } catch (failure) { setError(errorText(failure, 'The hint could not be shown. Try again.')); } finally { setBusy(false); }
  }

  async function answer(): Promise<void> {
    const token = getAccessToken();
    if (!token || !choice) return;
    setBusy(true); setError('');
    try {
      const result = await answerStepQuestion(token, step.decisionId, question.id, choice);
      setFeedback(result.feedback); setChoice(''); onStep(result.step);
    } catch (failure) {
      setError(errorText(failure, 'Your answer could not be checked. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return <div className="pilot-card" style={{ margin: 0 }} aria-label="Practice question">
    <div className="pilot-card-head"><h3 style={{ margin: 0, fontSize: 13 }}>Question {question.position}</h3><span className="pilot-chip slate">{practice.questionsAnswered} answered</span></div>
    {feedback ? <p role="status" className={`pilot-chip ${feedback.correct ? 'green' : 'amber'}`} style={{ display: 'inline-block' }}>{feedback.correct ? 'Right.' : 'Not quite.'}{feedback.assisted ? ' Counted as assisted.' : ''}</p> : null}
    <p style={{ margin: '6px 0 10px' }}>{question.prompt}</p>
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sr-only" style={{ position: 'absolute', left: -9999 }}>Choose an answer</legend>
      {question.options.map((option) => <label key={option.id} className="pilot-list-row" style={{ cursor: 'pointer' }}>
        <input type="radio" name={`step-${question.id}`} value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} />
        <span className="grow">{option.text}</span>
      </label>)}
    </fieldset>
    {question.hints.length ? <div style={{ marginTop: 8 }} aria-label="Hints shown">
      {question.hints.map((text, index) => <p key={index} style={{ margin: '4px 0' }}><span className="pilot-chip amber">Hint {index + 1}</span> {text}</p>)}
    </div> : null}
    {!question.hintsAvailable ? <p style={muted}>No hints for this question.</p>
      : question.hints.length < 4 && nextHintAssists ? <p style={muted}>The next hint shows a worked step: an answer after it counts as assisted, not as your own.</p> : null}
    {error ? <p role="alert" style={{ color: 'var(--p-rose)' }}>{error}</p> : null}
    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      <button type="button" className="pilot-btn small" disabled={busy || !choice} onClick={() => void answer()}>Check answer</button>
      {question.hintsAvailable && question.hints.length < 4
        ? <button type="button" className="pilot-btn ghost small" disabled={busy} onClick={() => void hint()}><Lightbulb size={14} /> Show hint {question.hints.length + 1}</button> : null}
    </div>
  </div>;
}

// --- The path -----------------------------------------------------------------

const GROUPS: readonly { key: 'skip' | 'review' | 'learn'; title: string; icon: React.ReactElement; tone: string; empty: string }[] = [
  { key: 'review', title: 'Review', icon: <RotateCcw size={16} />, tone: 'blue', empty: 'Nothing to review.' },
  { key: 'learn', title: 'Learn', icon: <BookOpen size={16} />, tone: 'purple', empty: 'Nothing new to learn.' },
  { key: 'skip', title: 'Skip', icon: <SkipForward size={16} />, tone: 'green', empty: 'Nothing to skip yet.' },
];

function PathCard({ path, status }: { readonly path: LearningPathDto | null; readonly status: string }): React.ReactElement {
  return <section className="pilot-card" aria-labelledby="path-heading">
    <div className="pilot-card-head"><h2 id="path-heading">Your path</h2>
      <span className="pilot-chip slate">{path?.target ? path.target.title : 'NA'}</span>
    </div>
    {!path ? <p style={muted}>{status}</p> : !path.target ? <p style={muted}>NA — choose your target role in My Career to see what to skip, review and learn.</p> : <>
      <p style={muted}>{path.requirements
        ? `${path.requirements.met} of ${path.requirements.total} requirements met · ${path.requirements.notMeasured} not measured yet`
        : 'Requirements: NA — not measured yet.'}</p>
      <div className="pilot-row cols-3">
        {GROUPS.map((group) => {
          const entries = path.groups[group.key];
          return <div key={group.key} aria-label={`${group.title} group`}>
            <div className="pilot-card-head"><h3 style={{ margin: 0, fontSize: 13 }}>{group.title}</h3><span className={`pilot-chip ${group.tone}`}>{entries.length}</span></div>
            {entries.length === 0 ? <p style={muted}>{group.empty}</p> : <div className="pilot-list">
              {entries.map((entry) => <PathRow key={entry.skillId} entry={entry} icon={group.icon} tone={group.tone} />)}
            </div>}
          </div>;
        })}
      </div>
    </>}
  </section>;
}

function PathRow({ entry, icon, tone }: { readonly entry: PathEntryDto; readonly icon: React.ReactElement; readonly tone: string }): React.ReactElement {
  return <div className="pilot-list-row">
    <span className={`pilot-tile ${tone}`}>{icon}</span>
    <div className="grow">
      <strong>{entry.skillName}</strong>
      <small>{entry.reasonCodes.map((code) => REASON_TEXT[code] ?? code).join(' ')}</small>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        {bandChip(entry.band)}
        {entry.due ? <span className="pilot-chip blue">Due for review</span> : null}
      </div>
    </div>
  </div>;
}

// --- Placement test -----------------------------------------------------------------

export function PlacementCard(): React.ReactElement {
  const [placement, setPlacement] = useState<PlacementDto | null>(null);
  const [status, setStatus] = useState('Loading…');
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return undefined; }
    const controller = new AbortController();
    getPlacementTest(token, controller.signal)
      .then((loaded) => { if (!loaded?.placement?.status) throw new Error('unexpected placement response'); setPlacement(loaded.placement); setStatus(''); })
      .catch(() => { if (!controller.signal.aborted) setStatus('NA — the placement test could not be loaded right now.'); });
    return () => controller.abort();
  }, []);

  async function act(run: (token: string) => Promise<{ readonly placement: PlacementDto }>): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    setBusy(true); setError('');
    try { setPlacement((await run(token)).placement); setChoice(''); } catch (failure) { setError(errorText(failure, 'That could not be saved. Try again.')); } finally { setBusy(false); }
  }

  return <section className="pilot-card" aria-labelledby="placement-heading">
    <div className="pilot-card-head"><h2 id="placement-heading">Placement test</h2>
      <span className={`pilot-chip ${placement?.status === 'COMPLETED' ? 'green' : 'slate'}`}>{placement?.status === 'COMPLETED' ? 'Done' : placement?.status === 'IN_PROGRESS' ? 'In progress' : 'Aptitude'}</span>
    </div>
    {!placement ? <p style={muted}>{status}</p>
      : placement.status === 'NOT_AVAILABLE' ? <p style={muted}>{placement.reason === 'CONSENT_REQUIRED'
        ? 'Not open yet — the placement test adapts to your answers, and adaptive learning is not available to you yet.'
        : 'Not open yet — there are not enough published aptitude questions for a placement test.'}</p>
        : placement.status === 'NOT_STARTED' ? <>
          <p style={muted}>Up to 25 questions and 25 minutes. It places you at a level so your plan starts in the right place. It does not count toward readiness.</p>
          <button type="button" className="pilot-btn small" disabled={busy} onClick={() => void act(startPlacementTest)}><ClipboardCheck size={14} /> Start the placement test</button>
        </>
          : placement.status === 'COMPLETED' ? <p style={muted}>Your placement level: <strong>{PLACEMENT_LEVEL[placement.placementLevel]}</strong> ({placement.questionsAnswered} questions answered).</p>
            : <div aria-label="Placement question">
              <p style={muted}>Question {placement.question.position} of up to {placement.maxQuestions} · ends at {new Date(placement.deadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
              <p style={{ margin: '6px 0 10px' }}>{placement.question.prompt}</p>
              {placement.question.options.map((option) => <label key={option.id} className="pilot-list-row" style={{ cursor: 'pointer' }}>
                <input type="radio" name={`placement-${placement.question.id}`} value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} />
                <span className="grow">{option.text}</span>
              </label>)}
              <button type="button" className="pilot-btn small" disabled={busy || !choice}
                onClick={() => void act((token) => answerPlacementQuestion(token, placement.placementTestId, placement.question.id, choice))}>Next</button>
            </div>}
    {error ? <p role="alert" style={{ color: 'var(--p-rose)' }}>{error}</p> : null}
  </section>;
}

// --- Practice page card ---------------------------------------------------------------

/** "Practice by Skill" on the Practice page: the path's review and learn skills, practised from the Learning page. */
export function PracticeBySkillCard(): React.ReactElement {
  const [path, setPath] = useState<LearningPathDto | null>(null);
  const [status, setStatus] = useState('NA — sign in to see the skills your plan practises.');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return undefined;
    const controller = new AbortController();
    getLearningPath(token, controller.signal)
      .then((loaded) => { if (!Array.isArray(loaded?.path?.groups?.review)) throw new Error('unexpected path response'); setPath(loaded.path); })
      .catch(() => { if (!controller.signal.aborted) setStatus('NA — your practice skills could not be loaded right now.'); });
    return () => controller.abort();
  }, []);

  const skills = path ? [...path.groups.review, ...path.groups.learn] : [];
  return <section className="pilot-card" aria-labelledby="practice-by-skill">
    <div className="pilot-card-head"><h2 id="practice-by-skill">Practice by Skill</h2><span className={`pilot-chip ${skills.length ? 'blue' : 'slate'}`}>{path ? skills.length : 'NA'}</span></div>
    {!path ? <p style={muted}>{status}</p>
      : !path.target ? <p style={muted}>NA — choose your target role in My Career; practice follows your path.</p>
        : skills.length === 0 ? <p style={muted}>Nothing to practise: every requirement of your target is met.</p>
          : <div className="pilot-list">
            {skills.map((entry) => <div key={entry.skillId} className="pilot-list-row">
              <span className="pilot-tile purple"><Target size={16} /></span>
              <div className="grow"><strong>{entry.skillName}</strong><small>{entry.due ? 'Due for review' : BAND_LABEL[entry.band]}</small></div>
            </div>)}
          </div>}
    <button type="button" className="pilot-btn soft small" style={{ marginTop: 8 }} onClick={() => go('/student/learning')}>Practise from your next step</button>
  </section>;
}
