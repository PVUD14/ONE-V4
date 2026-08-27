import { useEffect, useState } from 'react';
import {
  assignInstitutionExam,
  createExamQuestion,
  createExamSubject,
  createInstitutionExam,
  getProtectedAccessToken,
  listExamQuestions,
  listExamSubjects,
  listInstitutionExamResults,
  listInstitutionExams,
  listInstitutionStudents,
  reopenInstitutionExam,
  publishInstitutionExam,
  transitionExamQuestion,
  type ExamQuestionDto,
  type ExamSubjectDto,
  type ExamNotAttemptedDto,
  type InstitutionExamDto,
  type InstitutionStudentDto,
} from './api.js';

/**
 * Institution-side assessment engine console: subjects, the governed question
 * bank (draft -> review -> approve), blueprint exam creation over approved
 * questions, publication, roster assignment, and results. Authenticated and
 * API-backed; nothing here is sample data.
 */
export function InstitutionExamEnginePage({ institutionId, canApprove = true }: { readonly institutionId: string; readonly canApprove?: boolean }): React.ReactElement {
  const token = getProtectedAccessToken();
  const [subjects, setSubjects] = useState<readonly ExamSubjectDto[]>([]);
  const [questions, setQuestions] = useState<readonly ExamQuestionDto[]>([]);
  const [exams, setExams] = useState<readonly InstitutionExamDto[]>([]);
  const [students, setStudents] = useState<readonly InstitutionStudentDto[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!token || !institutionId) return;
    const abort = new AbortController();
    void Promise.all([
      listExamSubjects(token, institutionId, abort.signal),
      listExamQuestions(token, institutionId, {}, abort.signal),
      listInstitutionExams(token, institutionId, abort.signal),
      listInstitutionStudents(token, institutionId, abort.signal),
    ]).then(([subjectsResponse, questionsResponse, examsResponse, studentsResponse]) => {
      setSubjects(subjectsResponse.subjects);
      setQuestions(questionsResponse.questions);
      setExams(examsResponse.assessments);
      setStudents(studentsResponse.students.filter((student) => (student.relationship?.state ?? student.status) === 'ACTIVE'));
    }).catch(() => setError('Assessment engine data could not be loaded.'));
    return () => abort.abort();
  }, [token, institutionId, reloadNonce]);

  function done(message: string): void {
    setError('');
    setNotice(message);
    setReloadNonce((value) => value + 1);
  }

  function failed(message: string): void {
    setNotice('');
    setError(message);
  }

  if (!token) return <section className="role-module"><p className="form-error">Sign in with an institution staff identity to manage assessments.</p></section>;

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Authenticated API-backed</span>
      <h1>Assessments</h1>
      <p>Build a governed question bank, assemble blueprint assessments over approved questions, publish, assign rostered students and read results.</p>
    </div></div>
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}

    <SubjectsCard token={token} institutionId={institutionId} subjects={subjects} onDone={done} onFail={failed} />
    <QuestionBankCard token={token} institutionId={institutionId} subjects={subjects} questions={questions} canApprove={canApprove} onDone={done} onFail={failed} />
    <ExamBuilderCard token={token} institutionId={institutionId} subjects={subjects} questions={questions} onDone={done} onFail={failed} />
    <ExamListCard token={token} institutionId={institutionId} exams={exams} students={students} canApprove={canApprove} onDone={done} onFail={failed} />
  </section>;
}

function SubjectsCard({ token, institutionId, subjects, onDone, onFail }: {
  readonly token: string; readonly institutionId: string; readonly subjects: readonly ExamSubjectDto[];
  readonly onDone: (message: string) => void; readonly onFail: (message: string) => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  return <form className="role-card role-wide role-management-form" onSubmit={(event) => {
    event.preventDefault();
    createExamSubject(token, institutionId, { name })
      .then(() => { setName(''); onDone('Subject created.'); })
      .catch(() => onFail('Subject creation failed - the name may already exist.'));
  }}>
    <h2>Subjects</h2>
    <label><span>New subject name</span><input value={name} onChange={(event) => setName(event.target.value)} required placeholder="e.g. Data Structures" /></label>
    <button type="submit">Create subject</button>
    <p>{subjects.length ? subjects.map((subject) => `${subject.name} (${subject.approvedQuestions} approved)`).join(' · ') : 'No subjects yet - create one to start the question bank.'}</p>
  </form>;
}

const questionTypeChoices = [
  ['SINGLE_CHOICE_MCQ', 'Single choice'], ['MULTIPLE_SELECT', 'Multiple select'], ['TRUE_FALSE', 'True / False'], ['FILL_IN_THE_BLANK', 'Fill in the blank'],
] as const;

function QuestionBankCard({ token, institutionId, subjects, questions, canApprove, onDone, onFail }: {
  readonly token: string; readonly institutionId: string; readonly subjects: readonly ExamSubjectDto[]; readonly questions: readonly ExamQuestionDto[];
  readonly onDone: (message: string) => void; readonly onFail: (message: string) => void;
  readonly canApprove: boolean;
}): React.ReactElement {
  const [form, setForm] = useState({ subjectId: '', questionType: 'SINGLE_CHOICE_MCQ', questionText: '', difficulty: 'MEDIUM', acceptedAnswers: '' });
  const [options, setOptions] = useState([
    { text: '', isCorrect: true }, { text: '', isCorrect: false }, { text: '', isCorrect: false }, { text: '', isCorrect: false },
  ]);

  const isChoice = form.questionType !== 'FILL_IN_THE_BLANK';

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const body: Record<string, unknown> = {
      subjectId: form.subjectId || subjects[0]?.id,
      questionType: form.questionType,
      questionText: form.questionText,
      difficulty: form.difficulty,
      marks: 1,
    };
    if (form.questionType === 'TRUE_FALSE') {
      body['options'] = [
        { key: 'A', text: 'True', isCorrect: options[0]?.isCorrect ?? true },
        { key: 'B', text: 'False', isCorrect: !(options[0]?.isCorrect ?? true) },
      ];
    } else if (isChoice) {
      body['options'] = options.filter((option) => option.text.trim()).map((option, index) => ({
        key: String.fromCharCode(65 + index), text: option.text, isCorrect: option.isCorrect,
      }));
    } else {
      body['acceptedAnswers'] = form.acceptedAnswers.split(',').map((answer) => answer.trim()).filter(Boolean);
    }
    createExamQuestion(token, institutionId, body)
      .then((response) => {
        setForm((value) => ({ ...value, questionText: '', acceptedAnswers: '' }));
        setOptions([{ text: '', isCorrect: true }, { text: '', isCorrect: false }, { text: '', isCorrect: false }, { text: '', isCorrect: false }]);
        onDone(response.question.duplicateSuspects > 0
          ? `Question drafted - ${response.question.duplicateSuspects} similar question(s) already exist.`
          : 'Question drafted. Submit it for review to make it approvable.');
      })
      .catch(() => onFail('Question creation failed - check the type rules (options, correct answers, blank marker).'));
  }

  function transition(question: ExamQuestionDto, toStatus: string): void {
    transitionExamQuestion(token, institutionId, question.id, toStatus)
      .then(() => onDone(`Question moved to ${toStatus.replace('_', ' ').toLowerCase()}.`))
      .catch(() => onFail('The transition was refused - only reviewers may approve, and the lifecycle order is enforced.'));
  }

  return <>
    <form className="role-card role-wide role-management-form" onSubmit={submit}>
      <h2>Add question</h2>
      <label><span>Subject</span><select value={form.subjectId} onChange={(event) => setForm((value) => ({ ...value, subjectId: event.target.value }))}>
        {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
      </select></label>
      <label><span>Type</span><select value={form.questionType} onChange={(event) => setForm((value) => ({ ...value, questionType: event.target.value }))}>
        {questionTypeChoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label><span>Difficulty</span><select value={form.difficulty} onChange={(event) => setForm((value) => ({ ...value, difficulty: event.target.value }))}>
        <option>EASY</option><option>MEDIUM</option><option>HARD</option>
      </select></label>
      <label><span>Question text {form.questionType === 'FILL_IN_THE_BLANK' ? '(use _____ for the blank)' : ''}</span>
        <input value={form.questionText} onChange={(event) => setForm((value) => ({ ...value, questionText: event.target.value }))} required /></label>
      {form.questionType === 'FILL_IN_THE_BLANK' ? (
        <label><span>Accepted answers (comma separated)</span>
          <input value={form.acceptedAnswers} onChange={(event) => setForm((value) => ({ ...value, acceptedAnswers: event.target.value }))} required /></label>
      ) : form.questionType === 'TRUE_FALSE' ? (
        <label><span>Correct answer</span><select value={options[0]?.isCorrect ? 'True' : 'False'} onChange={(event) => setOptions([{ text: 'True', isCorrect: event.target.value === 'True' }])}>
          <option>True</option><option>False</option>
        </select></label>
      ) : (
        <div className="exam-option-authoring">
          <span className="exam-authoring-label">
            Options — {form.questionType === 'MULTIPLE_SELECT' ? 'tick every correct answer (at least two, plus one wrong)' : 'select the one correct answer'}
          </span>
          {options.map((option, index) => {
            const letter = String.fromCharCode(65 + index);
            return (
              <div key={index} className="exam-option-author-row">
                <input
                  type={form.questionType === 'MULTIPLE_SELECT' ? 'checkbox' : 'radio'}
                  name="correct-option"
                  checked={option.isCorrect}
                  aria-label={`Mark option ${letter} as correct`}
                  onChange={() => setOptions((value) => value.map((entry, i) => form.questionType === 'MULTIPLE_SELECT'
                    ? (i === index ? { ...entry, isCorrect: !entry.isCorrect } : entry)
                    : { ...entry, isCorrect: i === index }))}
                />
                <span className="exam-option-letter">{letter}</span>
                <input
                  className="exam-option-text"
                  type="text"
                  value={option.text}
                  placeholder={`Option ${letter} text${index < 2 ? '' : ' (optional)'}`}
                  aria-label={`Option ${letter} text`}
                  required={index < 2}
                  onChange={(event) => setOptions((value) => value.map((entry, i) => i === index ? { ...entry, text: event.target.value } : entry))}
                />
              </div>
            );
          })}
        </div>
      )}
      <button type="submit" disabled={!subjects.length}>Draft question</button>
    </form>

    <div className="role-record-table-wrap"><table className="role-record-table">
      <caption className="sr-only">Question bank</caption>
      <thead><tr><th>Question</th><th>Subject</th><th>Type</th><th>Difficulty</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        {questions.map((question) => (
          <tr key={question.id}>
            <th scope="row"><strong>{question.questionText.slice(0, 90)}{question.questionText.length > 90 ? '…' : ''}</strong></th>
            <td>{question.subjectName}</td>
            <td>{question.questionType.replace(/_/g, ' ')}</td>
            <td>{question.difficulty}</td>
            <td>{question.approvalStatus.replace('_', ' ')}</td>
            <td><div className="role-record-actions">
              {question.approvalStatus === 'DRAFT' ? <button type="button" onClick={() => transition(question, 'UNDER_REVIEW')}>Submit for review</button> : null}
              {question.approvalStatus === 'UNDER_REVIEW' ? (canApprove ? <>
                <button type="button" onClick={() => transition(question, 'APPROVED')}>Approve</button>
                <button type="button" className="secondary" onClick={() => transition(question, 'REJECTED')}>Reject</button>
              </> : <small>Awaiting senior review</small>) : null}
              {question.approvalStatus === 'APPROVED' || question.approvalStatus === 'REJECTED' ? <button type="button" className="secondary" onClick={() => transition(question, 'ARCHIVED')}>Archive</button> : null}
            </div></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  </>;
}

function ExamBuilderCard({ token, institutionId, subjects, questions, onDone, onFail }: {
  readonly token: string; readonly institutionId: string; readonly subjects: readonly ExamSubjectDto[]; readonly questions: readonly ExamQuestionDto[];
  readonly onDone: (message: string) => void; readonly onFail: (message: string) => void;
}): React.ReactElement {
  const [form, setForm] = useState({
    subjectId: '', title: '', assessmentKind: 'UNIT_TEST', startsAt: '', endsAt: '',
    durationMinutes: 30, attemptsAllowed: 1, marksPerQuestion: 1, displayCount: 5,
  });
  const [pool, setPool] = useState<readonly string[]>([]);
  const subjectId = form.subjectId || subjects[0]?.id || '';
  const approved = questions.filter((question) => question.subjectId === subjectId && question.approvalStatus === 'APPROVED');

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    const totalMarks = form.displayCount * form.marksPerQuestion;
    createInstitutionExam(token, institutionId, {
      subjectId,
      title: form.title,
      assessmentKind: form.assessmentKind,
      startsAt: new Date(form.startsAt).toISOString(),
      endsAt: new Date(form.endsAt).toISOString(),
      durationSeconds: form.durationMinutes * 60,
      attemptsAllowed: form.attemptsAllowed,
      totalMarks,
      sections: [{
        title: 'Section A',
        poolSize: pool.length,
        displayCount: form.displayCount,
        marksPerQuestion: form.marksPerQuestion,
        negativeMarks: 0,
        questionIds: pool,
      }],
    })
      .then(() => { setPool([]); setForm((value) => ({ ...value, title: '' })); onDone('Assessment drafted. Publish it to open assignment.'); })
      .catch(() => onFail(`Assessment creation failed. The pool needs at least ${form.displayCount} approved questions and the window must be valid.`));
  }

  return <form className="role-card role-wide role-management-form" onSubmit={submit}>
    <h2>Create assessment</h2>
    <label><span>Subject</span><select value={subjectId} onChange={(event) => { setForm((value) => ({ ...value, subjectId: event.target.value })); setPool([]); }}>
      {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
    </select></label>
    <label><span>Title</span><input value={form.title} onChange={(event) => setForm((value) => ({ ...value, title: event.target.value }))} required placeholder="e.g. Unit Test 1 - Arrays" /></label>
    <label><span>Kind</span><select value={form.assessmentKind} onChange={(event) => setForm((value) => ({ ...value, assessmentKind: event.target.value }))}>
      <option value="UNIT_TEST">Unit Test</option><option value="MID_EXAM">Mid Exam</option><option value="MOCK_TEST">Mock Test</option>
    </select></label>
    <label><span>Window opens</span><input type="datetime-local" value={form.startsAt} onChange={(event) => setForm((value) => ({ ...value, startsAt: event.target.value }))} required /></label>
    <label><span>Window closes</span><input type="datetime-local" value={form.endsAt} onChange={(event) => setForm((value) => ({ ...value, endsAt: event.target.value }))} required /></label>
    <label><span>Duration (minutes)</span><input type="number" min={1} max={360} value={form.durationMinutes} onChange={(event) => setForm((value) => ({ ...value, durationMinutes: Number(event.target.value) }))} /></label>
    <label><span>Attempts allowed</span><input type="number" min={1} max={10} value={form.attemptsAllowed} onChange={(event) => setForm((value) => ({ ...value, attemptsAllowed: Number(event.target.value) }))} /></label>
    <label><span>Questions shown per attempt</span><input type="number" min={1} max={100} value={form.displayCount} onChange={(event) => setForm((value) => ({ ...value, displayCount: Number(event.target.value) }))} /></label>
    <label><span>Marks per question</span><input type="number" min={1} max={20} value={form.marksPerQuestion} onChange={(event) => setForm((value) => ({ ...value, marksPerQuestion: Number(event.target.value) }))} /></label>
    <div className="exam-pool-picker">
      <span>Question pool ({pool.length} selected, {form.displayCount} shown per attempt, total {form.displayCount * form.marksPerQuestion} marks)</span>
      {approved.length ? approved.map((question) => (
        <label key={question.id} className="exam-pool-item">
          <input type="checkbox" checked={pool.includes(question.id)}
            onChange={() => setPool((value) => value.includes(question.id) ? value.filter((id) => id !== question.id) : [...value, question.id])} />
          <span>{question.questionText.slice(0, 80)}{question.questionText.length > 80 ? '…' : ''} <em>({question.difficulty.toLowerCase()})</em></span>
        </label>
      )) : <p>No approved questions for this subject yet - approve some in the bank above.</p>}
    </div>
    <button type="submit" disabled={pool.length < form.displayCount}>Create draft assessment</button>
  </form>;
}

function ExamListCard({ token, institutionId, exams, students, canApprove, onDone, onFail }: {
  readonly token: string; readonly institutionId: string; readonly exams: readonly InstitutionExamDto[]; readonly students: readonly InstitutionStudentDto[];
  readonly onDone: (message: string) => void; readonly onFail: (message: string) => void;
  readonly canApprove: boolean;
}): React.ReactElement {
  const [assigning, setAssigning] = useState<string | null>(null);
  const [chosenStudents, setChosenStudents] = useState<readonly string[]>([]);
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [results, setResults] = useState<{ rows: Record<string, unknown>[]; pending: ExamNotAttemptedDto[]; average: number; assigned: number } | null>(null);

  function reopen(exam: InstitutionExamDto): void {
    const currentDuration = Math.round(exam.durationSeconds / 60);
    const minutes = Number(window.prompt(
      `WINDOW: keep "${exam.title}" open for how many more minutes from now? (This is how long students may start; each attempt still runs its own duration.)`, '60') ?? 0);
    const attempts = Number(window.prompt('ATTEMPTS: grant how many extra attempts per student? (0 = none)', '1') ?? 0);
    const durationInput = window.prompt(
      `DURATION: minutes on the clock per attempt (currently ${currentDuration} min). Leave blank to keep ${currentDuration}.`, '');
    const durationMinutes = durationInput && Number(durationInput) > 0 ? Number(durationInput) : null;
    if (!minutes && !attempts && durationMinutes == null) return;
    reopenInstitutionExam(token, institutionId, exam.id, {
      extendMinutes: minutes,
      extraAttempts: attempts,
      ...(durationMinutes != null ? { durationMinutes } : {}),
    })
      .then((response) => onDone(`${exam.title} reopened - window extended ${response.assessment.extendedMinutes} min, attempts now ${response.assessment.attemptsAllowed} per student, attempt duration ${Math.round(response.assessment.durationSeconds / 60)} min.`))
      .catch(() => onFail('Reopen failed - only a published assessment can be reopened, and only by a senior role.'));
  }

  function publish(exam: InstitutionExamDto): void {
    publishInstitutionExam(token, institutionId, exam.id)
      .then(() => onDone(`${exam.title} is published - assign students to open it.`))
      .catch(() => onFail('Publication failed - the pool must still contain the exact approved question counts.'));
  }

  function assign(exam: InstitutionExamDto): void {
    assignInstitutionExam(token, institutionId, exam.id, chosenStudents)
      .then((response) => { setAssigning(null); setChosenStudents([]); onDone(`${response.assignment.newlyAssigned} of ${response.assignment.requested} students newly assigned to ${exam.title}.`); })
      .catch(() => onFail('Assignment failed.'));
  }

  function showResults(exam: InstitutionExamDto): void {
    listInstitutionExamResults(token, institutionId, exam.id)
      .then((response) => {
        setResultsFor(exam.id);
        setResults({
          rows: response.results,
          pending: response.notAttempted,
          average: response.summary.averagePercentage,
          assigned: response.summary.assigned,
        });
      })
      .catch(() => onFail('Results could not be loaded.'));
  }

  return <div className="role-record-table-wrap"><table className="role-record-table">
    <caption className="sr-only">Assessments</caption>
    <thead><tr><th>Assessment</th><th>Subject</th><th>Window</th><th>State</th><th>Assigned</th><th>Completed</th><th>Actions</th></tr></thead>
    <tbody>
      {exams.map((exam) => (
        <>
          <tr key={exam.id}>
            <th scope="row"><strong>{exam.title}</strong><span>{exam.assessmentKind.replace('_', ' ')} · {exam.totalMarks} marks · {Math.round(exam.durationSeconds / 60)} min</span></th>
            <td>{exam.subjectName}</td>
            <td>{new Date(exam.startsAt).toLocaleString()} → {new Date(exam.endsAt).toLocaleString()}</td>
            <td>{exam.lifecycleState}</td>
            <td>{exam.assignedCount}</td>
            <td>{exam.completedAttempts}</td>
            <td><div className="role-record-actions">
              {exam.lifecycleState === 'DRAFT' && canApprove ? <button type="button" onClick={() => publish(exam)}>Publish</button> : null}
              {exam.lifecycleState === 'PUBLISHED' ? <button type="button" onClick={() => { setAssigning(assigning === exam.id ? null : exam.id); setChosenStudents([]); }}>Assign students</button> : null}
              {exam.lifecycleState === 'PUBLISHED' && canApprove ? <button type="button" className="secondary" onClick={() => reopen(exam)}>Reopen / Extend</button> : null}
              {exam.assignedCount > 0 ? <button type="button" className="secondary" onClick={() => showResults(exam)}>Results</button> : null}
            </div></td>
          </tr>
          {assigning === exam.id ? (
            <tr key={`${exam.id}-assign`}><td colSpan={7}>
              <div className="exam-pool-picker">
                <span>Choose active rostered students ({chosenStudents.length} selected)</span>
                {students.map((student) => (
                  <label key={student.id} className="exam-pool-item">
                    <input type="checkbox" checked={chosenStudents.includes(student.id)}
                      onChange={() => setChosenStudents((value) => value.includes(student.id) ? value.filter((id) => id !== student.id) : [...value, student.id])} />
                    <span>{student.fullName} · {student.institutionStudentId}</span>
                  </label>
                ))}
                <button type="button" disabled={!chosenStudents.length} onClick={() => assign(exam)}>Assign {chosenStudents.length} student(s)</button>
              </div>
            </td></tr>
          ) : null}
          {resultsFor === exam.id && results ? (
            <tr key={`${exam.id}-results`}><td colSpan={7}>
              <p>
                <strong>{results.assigned}</strong> assigned · <strong>{results.rows.length}</strong> completed attempts (average {results.average}%) ·{' '}
                <strong>{results.pending.length}</strong> not attempted
              </p>
              {results.pending.length ? (
                <p className="exam-pending-line">
                  Not attempted: {results.pending.map((entry) => `${entry.studentName} (${entry.institutionStudentId})${entry.inProgress ? ' — in progress now' : ''}`).join(', ')}
                </p>
              ) : null}
              <table className="role-record-table"><thead><tr><th>Student</th><th>Score</th><th>%</th><th>Right / Wrong / Blank</th><th>Focus losses</th><th>Auto-submitted</th></tr></thead><tbody>
                {results.rows.map((row, index) => (
                  <tr key={index}>
                    <td>{String(row['studentName'])} ({String(row['institutionStudentId'])})</td>
                    <td>{String(row['score'])} / {String(row['maxScore'])}</td>
                    <td>{String(row['percentage'])}%</td>
                    <td>{String(row['correct'])} / {String(row['wrong'])} / {String(row['notAttempted'])}</td>
                    <td>{String(row['screenShiftCount'])}</td>
                    <td>{row['autoSubmitted'] ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody></table>
            </td></tr>
          ) : null}
        </>
      ))}
    </tbody>
  </table></div>;
}
