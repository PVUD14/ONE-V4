/**
 * Screening assessments, from the employer's side: their own question bank, a test built
 * from approved questions, the applicants it goes to, and what came back.
 *
 * Two rules from the design are visible in this screen rather than hidden behind it. A
 * question is approved by somebody other than its author, so the screen says so instead of
 * letting a recruiter discover it as an error. And the results table carries no readiness
 * band — an employer sees what they measured and nothing else.
 *
 * EMP-12: rejecting or archiving a question and closing a test each need a reason from a fixed
 * list; a test goes only to applicants in the Assessment stage, in a window the server checks;
 * results are listed in the order candidates were invited — never ranked by score — a page at a
 * time, with how each attempt ended.
 */
import React, { useEffect, useState } from 'react';
import { getAccessToken } from './auth.js';
import {
  ASSESSMENT_CLOSE_REASONS,
  QUESTION_ARCHIVE_REASONS,
  QUESTION_REJECT_REASONS,
  closeEmployerAssessment,
  createEmployerAssessment,
  createEmployerQuestion,
  inviteToEmployerAssessment,
  listEmployerApplicants,
  listEmployerAssessmentResults,
  listEmployerAssessments,
  listEmployerCandidateAssessments,
  listEmployerOpportunities,
  listEmployerQuestions,
  publishEmployerAssessment,
  transitionEmployerQuestion,
  type EmployerApplicantDto,
  type EmployerAssessmentDto,
  type EmployerAssessmentResultDto,
  type EmployerCandidateAssessmentDto,
  type EmployerOpportunityDto,
  type EmployerQuestionDto,
} from './api.js';
import { V2Stat } from './dashboardsV2.js';

const QUESTION_TYPES = [
  ['SINGLE_CHOICE_MCQ', 'Single choice'],
  ['MULTIPLE_SELECT', 'Multiple select'],
  ['TRUE_FALSE', 'True or false'],
  ['SCENARIO_MCQ', 'Scenario'],
  ['CODE_OUTPUT_MCQ', 'Code output'],
  ['NUMERICAL_MCQ', 'Numerical'],
] as const;

function messageFor(error: unknown, fallback: string): string {
  const code = (error as { code?: string })?.code;
  if (code === 'AUTHOR_CANNOT_APPROVE_OWN_QUESTION') return 'Somebody other than the author has to approve a question.';
  if (code === 'DUPLICATE_QUESTION') return 'That question is already in your bank.';
  if (code === 'QUESTIONS_NOT_APPROVED') return 'Every question in a test has to be approved first.';
  if (code === 'ASSESSMENT_HAS_NO_QUESTIONS') return 'Add at least one question before publishing.';
  if (code === 'APPLICATION_NOT_INVITABLE') return 'One of those candidates cannot be sent this test — a test goes only to candidates in the Assessment stage, and they may have withdrawn, been rejected, or revoked consent.';
  if (code === 'ASSESSMENT_NOT_PUBLISHED') return 'This test is not published — publish it first, or build a new test if it was closed.';
  if (code === 'INVALID_WINDOW') return 'Choose a window that opens now or later and closes within 30 days.';
  if (code === 'REASON_CODE_REQUIRED' || code === 'INVALID_REASONCODE') return 'Choose a reason from the list.';
  return fallback;
}

export function EmployerAssessmentsPage({ employerId }: { readonly employerId: string }): React.ReactElement {
  const [questions, setQuestions] = useState<readonly EmployerQuestionDto[]>([]);
  const [assessments, setAssessments] = useState<readonly EmployerAssessmentDto[]>([]);
  const [status, setStatus] = useState('Loading…');
  const [view, setView] = useState<'bank' | 'tests'>('tests');
  const [openResults, setOpenResults] = useState<string | null>(null);

  const reload = async (message?: string): Promise<void> => {
    const token = getAccessToken();
    if (!token) return setStatus('You are not signed in.');
    const [bank, tests] = await Promise.all([
      listEmployerQuestions(token, employerId),
      listEmployerAssessments(token, employerId),
    ]);
    setQuestions(bank.questions);
    setAssessments(tests.assessments);
    setStatus(message ?? '');
  };
  useEffect(() => { void reload().catch(() => setStatus('Your assessments could not be loaded.')); }, [employerId]);

  const approved = questions.filter((question) => question.approvalStatus === 'APPROVED');

  return <section className="role-module role-module--dense">
    <div className="role-page-heading"><div>
      <span className="eyebrow">Assessments</span>
      <h1>Screening assessments</h1>
      <p>Build a question bank, assemble a test from approved questions, and send it to the people who applied.</p>
    </div></div>

    <div className="v2-row v2-cols-4 career-stat-strip role-wide">
      <V2Stat icon="🗂️" tone="blue" value={questions.length} label="Questions" />
      <V2Stat icon="✅" tone="green" value={approved.length} label="Approved" />
      <V2Stat icon="📝" tone="purple" value={assessments.filter((item) => item.lifecycleState === 'PUBLISHED').length} label="Published tests" />
      <V2Stat icon="📬" tone="amber" value={assessments.reduce((sum, item) => sum + item.submittedCount, 0)} label="Submitted" />
    </div>

    <section className="role-card role-wide">
      <div className="hiring-actions">
        <button type="button" className={view === 'tests' ? undefined : 'secondary'} onClick={() => setView('tests')}>Tests</button>
        <button type="button" className={view === 'bank' ? undefined : 'secondary'} onClick={() => setView('bank')}>Question bank</button>
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>

    {view === 'bank'
      ? <QuestionBank
        employerId={employerId}
        questions={questions}
        onDone={(message) => { void reload(message); }}
        onFail={(message) => setStatus(message)}
      />
      : <TestList
        employerId={employerId}
        assessments={assessments}
        approved={approved}
        openResults={openResults}
        onOpenResults={setOpenResults}
        onDone={(message) => { void reload(message); }}
        onFail={(message) => setStatus(message)}
      />}
  </section>;
}

function QuestionBank({ employerId, questions, onDone, onFail }: {
  readonly employerId: string;
  readonly questions: readonly EmployerQuestionDto[];
  readonly onDone: (message: string) => void;
  readonly onFail: (message: string) => void;
}): React.ReactElement {
  const [adding, setAdding] = useState(false);
  const [deciding, setDeciding] = useState<{ readonly questionId: string; readonly toState: 'REJECTED' | 'ARCHIVED' } | null>(null);
  const [reason, setReason] = useState('');

  async function move(questionId: string, toState: string, reasonCode?: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      await transitionEmployerQuestion(token, employerId, questionId, toState, reasonCode);
      setDeciding(null);
      setReason('');
      onDone(toState === 'APPROVED' ? 'Question approved and available for a test.' : 'Question updated.');
    } catch (error) {
      onFail(messageFor(error, 'That change could not be saved.'));
    }
  }
  const reasons = deciding?.toState === 'ARCHIVED' ? QUESTION_ARCHIVE_REASONS : QUESTION_REJECT_REASONS;

  return <>
    <section className="role-card role-wide">
      <h2>Question bank</h2>
      <p>A question is written, reviewed and approved before it can appear in a test. <strong>Somebody other than the author has to approve it</strong> — a review one person can do alone is not a review.</p>
      {adding
        ? <QuestionForm employerId={employerId} onSaved={() => { setAdding(false); onDone('Question added as a draft.'); }} onFail={onFail} onCancel={() => setAdding(false)} />
        : <button type="button" onClick={() => setAdding(true)}>Write a question</button>}
    </section>

    <section className="role-card role-wide">
      {questions.length === 0
        ? <p>No questions yet. Write one to start your bank.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>Question</th><th>Type</th><th>Marks</th><th>State</th><th>Next</th></tr></thead>
          <tbody>{questions.map((question) => <tr key={question.id}>
            <td>{question.questionText}
              {question.mentionsProtectedAttribute ? <><br /><span className="hiring-state state-rejected">Names a protected attribute — check it does not screen people on who they are</span></> : null}</td>
            <td>{QUESTION_TYPES.find(([code]) => code === question.questionType)?.[1] ?? question.questionType}</td>
            <td>{question.marks}</td>
            <td><span className={`hiring-state state-${question.approvalStatus.toLowerCase()}`}>{question.approvalStatus.replace(/_/g, ' ').toLowerCase()}</span></td>
            <td><div className="hiring-actions">
              {question.approvalStatus === 'DRAFT' ? <button type="button" className="secondary" onClick={() => { void move(question.id, 'UNDER_REVIEW'); }}>Send for review</button> : null}
              {question.approvalStatus === 'UNDER_REVIEW' ? <>
                <button type="button" onClick={() => { void move(question.id, 'APPROVED'); }}>Approve</button>
                <button type="button" className="secondary" onClick={() => { setReason(''); setDeciding({ questionId: question.id, toState: 'REJECTED' }); }}>Reject</button>
              </> : null}
              {question.approvalStatus === 'APPROVED' ? <span className="hiring-meta">Ready to use</span> : null}
              {question.approvalStatus === 'APPROVED' || question.approvalStatus === 'REJECTED'
                ? <button type="button" className="secondary" onClick={() => { setReason(''); setDeciding({ questionId: question.id, toState: 'ARCHIVED' }); }}>Archive</button>
                : null}
            </div>
            {deciding?.questionId === question.id ? <div className="hiring-actions">
              <label className="student-form-field"><span>{deciding.toState === 'ARCHIVED' ? 'Why archive it' : 'Why reject it'}</span>
                <select value={reason} onChange={(event) => setReason(event.target.value)}>
                  <option value="">Choose a reason</option>
                  {reasons.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
              </label>
              <button type="button" disabled={!reason} onClick={() => { void move(question.id, deciding.toState, reason); }}>{deciding.toState === 'ARCHIVED' ? 'Archive' : 'Reject'} question</button>
              <button type="button" className="secondary" onClick={() => setDeciding(null)}>Cancel</button>
            </div> : null}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </>;
}

function QuestionForm({ employerId, onSaved, onFail, onCancel }: {
  readonly employerId: string;
  readonly onSaved: () => void;
  readonly onFail: (message: string) => void;
  readonly onCancel: () => void;
}): React.ReactElement {
  const [questionText, setQuestionText] = useState('');
  const [questionType, setQuestionType] = useState<string>('SINGLE_CHOICE_MCQ');
  const [marks, setMarks] = useState('2');
  const [options, setOptions] = useState([
    { key: 'A', text: '', isCorrect: true },
    { key: 'B', text: '', isCorrect: false },
    { key: 'C', text: '', isCorrect: false },
  ]);
  const [saving, setSaving] = useState(false);

  function setOption(index: number, patch: Partial<{ text: string; isCorrect: boolean }>): void {
    setOptions((current) => current.map((option, position) => position === index ? { ...option, ...patch } : option));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token) return;
    setSaving(true);
    try {
      await createEmployerQuestion(token, employerId, {
        questionText, questionType, marks: Number(marks),
        options: options.filter((option) => option.text.trim().length > 0),
      });
      onSaved();
    } catch (error) {
      onFail(messageFor(error, 'That question could not be saved.'));
    } finally { setSaving(false); }
  }

  return <form className="student-form" onSubmit={(event) => { void submit(event); }}>
    <label className="student-form-field"><span>Question</span>
      <textarea value={questionText} maxLength={4000} onChange={(event) => setQuestionText(event.target.value)} required />
    </label>
    <label className="student-form-field"><span>Type</span>
      <select value={questionType} onChange={(event) => setQuestionType(event.target.value)}>
        {QUESTION_TYPES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select>
    </label>
    <label className="student-form-field"><span>Marks</span>
      <input type="number" min="1" max="100" value={marks} onChange={(event) => setMarks(event.target.value)} />
    </label>
    <p className="hiring-meta">Tick every correct answer. Candidates see these options in their own order, so &ldquo;the answer is B&rdquo; is worth nothing to anyone who shares it.</p>
    {options.map((option, index) => <div key={option.key} className="student-form-field">
      <span>Option {option.key}</span>
      <input value={option.text} maxLength={2000} onChange={(event) => setOption(index, { text: event.target.value })} />
      <label><input type="checkbox" checked={option.isCorrect} onChange={(event) => setOption(index, { isCorrect: event.target.checked })} /> Correct</label>
    </div>)}
    <div className="hiring-actions">
      <button type="submit" disabled={saving || !questionText.trim()}>Save as draft</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

function TestList({ employerId, assessments, approved, openResults, onOpenResults, onDone, onFail }: {
  readonly employerId: string;
  readonly assessments: readonly EmployerAssessmentDto[];
  readonly approved: readonly EmployerQuestionDto[];
  readonly openResults: string | null;
  readonly onOpenResults: (id: string | null) => void;
  readonly onDone: (message: string) => void;
  readonly onFail: (message: string) => void;
}): React.ReactElement {
  const [building, setBuilding] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeReason, setCloseReason] = useState('');

  async function close(assessmentId: string): Promise<void> {
    const token = getAccessToken();
    if (!token || !closeReason) return;
    try {
      await closeEmployerAssessment(token, employerId, assessmentId, closeReason);
      setClosing(null);
      setCloseReason('');
      onDone('Test closed. Candidates already sent it keep their window.');
    } catch (error) {
      onFail(messageFor(error, 'That test could not be closed.'));
    }
  }

  async function publish(assessmentId: string): Promise<void> {
    const token = getAccessToken();
    if (!token) return;
    try {
      await publishEmployerAssessment(token, employerId, assessmentId);
      onDone('Test published. You can now send it to applicants.');
    } catch (error) {
      onFail(messageFor(error, 'That test could not be published.'));
    }
  }

  return <>
    <section className="role-card role-wide">
      <h2>Tests</h2>
      {building
        ? <TestForm employerId={employerId} approved={approved} onSaved={() => { setBuilding(false); onDone('Test created as a draft.'); }} onFail={onFail} onCancel={() => setBuilding(false)} />
        : approved.length === 0
          ? <p>Approve at least one question in your bank before building a test.</p>
          : <button type="button" onClick={() => setBuilding(true)}>Build a test</button>}
    </section>

    <section className="role-card role-wide">
      {assessments.length === 0
        ? <p>No tests yet.</p>
        : <div className="role-record-table-wrap"><table className="role-record-table">
          <thead><tr><th>Test</th><th>Questions</th><th>Length</th><th>State</th><th>Sent</th><th>Actions</th></tr></thead>
          <tbody>{assessments.map((assessment) => <tr key={assessment.id}>
            <td>{assessment.title}</td>
            <td>{assessment.itemCount}</td>
            <td>{Math.round(assessment.durationSeconds / 60)} min</td>
            <td><span className={`hiring-state state-${assessment.lifecycleState.toLowerCase()}`}>{assessment.lifecycleState.toLowerCase()}</span></td>
            <td>{assessment.invitedCount === 0 ? '—' : `${assessment.submittedCount} / ${assessment.invitedCount}`}</td>
            <td><div className="hiring-actions">
              {assessment.lifecycleState === 'DRAFT' ? <button type="button" onClick={() => { void publish(assessment.id); }}>Publish</button> : null}
              {assessment.lifecycleState === 'PUBLISHED' ? <button type="button" className="secondary" onClick={() => setInviting(assessment.id)}>Send to applicants</button> : null}
              {assessment.lifecycleState === 'PUBLISHED' ? <button type="button" className="secondary" onClick={() => { setCloseReason(''); setClosing(assessment.id); }}>Close</button> : null}
              {assessment.invitedCount > 0 ? <button type="button" className="secondary" onClick={() => onOpenResults(openResults === assessment.id ? null : assessment.id)}>Results</button> : null}
            </div>
            {closing === assessment.id ? <div className="hiring-actions">
              <label className="student-form-field"><span>Why close it</span>
                <select value={closeReason} onChange={(event) => setCloseReason(event.target.value)}>
                  <option value="">Choose a reason</option>
                  {ASSESSMENT_CLOSE_REASONS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
              </label>
              <button type="button" disabled={!closeReason} onClick={() => { void close(assessment.id); }}>Close test</button>
              <button type="button" className="secondary" onClick={() => setClosing(null)}>Cancel</button>
            </div> : null}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    {inviting ? <InvitePanel
      employerId={employerId}
      assessmentId={inviting}
      onSent={(count) => { setInviting(null); onDone(count === 0 ? 'Those candidates had already been sent this test.' : `Sent to ${count} ${count === 1 ? 'candidate' : 'candidates'}.`); }}
      onFail={onFail}
      onCancel={() => setInviting(null)}
    /> : null}

    {openResults ? <ResultsPanel employerId={employerId} assessmentId={openResults} /> : null}
  </>;
}

function TestForm({ employerId, approved, onSaved, onFail, onCancel }: {
  readonly employerId: string;
  readonly approved: readonly EmployerQuestionDto[];
  readonly onSaved: () => void;
  readonly onFail: (message: string) => void;
  readonly onCancel: () => void;
}): React.ReactElement {
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [opportunityId, setOpportunityId] = useState('');
  const [opportunities, setOpportunities] = useState<readonly EmployerOpportunityDto[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    void listEmployerOpportunities(token, employerId)
      .then((response) => setOpportunities(response.opportunities))
      .catch(() => undefined);
  }, [employerId]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const token = getAccessToken();
    if (!token || selected.length === 0) return;
    setSaving(true);
    try {
      await createEmployerAssessment(token, employerId, {
        title, durationSeconds: Number(minutes) * 60,
        opportunityId: opportunityId || null, questionIds: selected,
      });
      onSaved();
    } catch (error) {
      onFail(messageFor(error, 'That test could not be created.'));
    } finally { setSaving(false); }
  }

  return <form className="student-form" onSubmit={(event) => { void submit(event); }}>
    <label className="student-form-field"><span>Title</span>
      <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} required />
    </label>
    <label className="student-form-field"><span>Length in minutes</span>
      <input type="number" min="5" max="240" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
    </label>
    <label className="student-form-field"><span>For which role</span>
      <select value={opportunityId} onChange={(event) => setOpportunityId(event.target.value)}>
        <option value="">Any of your roles</option>
        {opportunities.map((opportunity) => <option key={opportunity.id} value={opportunity.id}>{opportunity.title ?? opportunity.referenceCode}</option>)}
      </select>
    </label>
    <p className="hiring-meta">Choosing a role limits who can be sent this test to people who applied to it.</p>
    <ul className="check-stack">
      {approved.map((question) => <li key={question.id}>
        <label>
          <input
            type="checkbox"
            checked={selected.includes(question.id)}
            onChange={() => setSelected((current) => current.includes(question.id)
              ? current.filter((id) => id !== question.id)
              : [...current, question.id])}
          />
          {' '}{question.questionText} <span className="hiring-meta">({question.marks} marks)</span>
        </label>
      </li>)}
    </ul>
    <div className="hiring-actions">
      <button type="submit" disabled={saving || !title.trim() || selected.length === 0}>Create test</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

function InvitePanel({ employerId, assessmentId, onSent, onFail, onCancel }: {
  readonly employerId: string;
  readonly assessmentId: string;
  readonly onSent: (count: number) => void;
  readonly onFail: (message: string) => void;
  readonly onCancel: () => void;
}): React.ReactElement {
  const [opportunities, setOpportunities] = useState<readonly EmployerOpportunityDto[]>([]);
  const [opportunityId, setOpportunityId] = useState('');
  const [applicants, setApplicants] = useState<readonly EmployerApplicantDto[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [days, setDays] = useState('7');
  const [opensAt, setOpensAt] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    void listEmployerOpportunities(token, employerId)
      .then((response) => {
        setOpportunities(response.opportunities);
        const published = response.opportunities.find((item) => item.lifecycleState === 'PUBLISHED');
        if (published) setOpportunityId(published.id);
      })
      .catch(() => undefined);
  }, [employerId]);

  useEffect(() => {
    const token = getAccessToken();
    if (!token || !opportunityId) return;
    void listEmployerApplicants(token, employerId, opportunityId)
      .then((response) => setApplicants(response.applications))
      .catch(() => undefined);
  }, [employerId, opportunityId]);

  // Only open, shared applications in the Assessment stage are offered: the server would refuse
  // anything else, and offering a checkbox that cannot work is worse than not offering it.
  const invitable = applicants.filter((applicant) => applicant.state === 'ASSESSMENT' && !applicant.closedAt && !applicant.consentRevoked && applicant.candidateAccess !== false);
  const elsewhere = applicants.filter((applicant) => applicant.state !== 'ASSESSMENT' && !applicant.closedAt).length;

  async function send(): Promise<void> {
    const token = getAccessToken();
    if (!token || selected.length === 0) return;
    setSending(true);
    try {
      const start = opensAt ? new Date(opensAt) : null;
      const closesAt = new Date((start ? start.getTime() : Date.now()) + Number(days) * 86400000).toISOString();
      const response = await inviteToEmployerAssessment(token, employerId, assessmentId, selected, closesAt, start ? start.toISOString() : undefined);
      onSent(response.invited);
    } catch (error) {
      onFail(messageFor(error, 'That test could not be sent.'));
    } finally { setSending(false); }
  }

  return <section className="role-card role-wide">
    <h2>Send to applicants</h2>
    <label className="student-form-field"><span>Opportunity</span>
      <select value={opportunityId} onChange={(event) => { setSelected([]); setOpportunityId(event.target.value); }}>
        {opportunities.map((opportunity) => <option key={opportunity.id} value={opportunity.id}>{opportunity.title ?? opportunity.referenceCode}</option>)}
      </select>
    </label>
    <label className="student-form-field"><span>Opens (leave empty to open now)</span>
      <input type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} />
    </label>
    <label className="student-form-field"><span>Open for how many days</span>
      <input type="number" min="1" max="30" value={days} onChange={(event) => setDays(event.target.value)} />
    </label>
    <p className="hiring-meta">A candidate has the test&rsquo;s full length unless the window closes first. ONE&rsquo;s server keeps the time.</p>
    {invitable.length === 0
      ? <p>No candidates on this role are in the Assessment stage. Move a candidate to Assessment in Applicants to send them a test.</p>
      : <ul className="check-stack">
        {invitable.map((applicant) => <li key={applicant.id}>
          <label>
            <input
              type="checkbox"
              checked={selected.includes(applicant.id)}
              onChange={() => setSelected((current) => current.includes(applicant.id)
                ? current.filter((id) => id !== applicant.id)
                : [...current, applicant.id])}
            />
            {' '}{applicant.candidateName ?? applicant.candidateEmail} <span className="hiring-meta">({applicant.state.toLowerCase()})</span>
          </label>
        </li>)}
      </ul>}
    {invitable.length > 0 && elsewhere > 0 ? <p className="hiring-meta">{elsewhere} other {elsewhere === 1 ? 'candidate is' : 'candidates are'} not in the Assessment stage and cannot be sent a test yet.</p> : null}
    <div className="hiring-actions">
      <button type="button" disabled={sending || selected.length === 0} onClick={() => { void send(); }}>Send test</button>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
    </div>
  </section>;
}

function ResultsPanel({ employerId, assessmentId }: { readonly employerId: string; readonly assessmentId: string }): React.ReactElement {
  const [results, setResults] = useState<readonly EmployerAssessmentResultDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading results…');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;
    const abort = new AbortController();
    listEmployerAssessmentResults(token, employerId, assessmentId, abort.signal)
      .then((response) => { setResults(response.results); setNextCursor(response.nextCursor ?? null); setStatus(''); })
      .catch(() => { if (!abort.signal.aborted) setStatus('Those results could not be loaded.'); });
    return () => abort.abort();
  }, [employerId, assessmentId]);

  async function more(): Promise<void> {
    const token = getAccessToken();
    if (!token || !nextCursor) return;
    try {
      const response = await listEmployerAssessmentResults(token, employerId, assessmentId, undefined, nextCursor);
      setResults((current) => [...(current ?? []), ...response.results]);
      setNextCursor(response.nextCursor ?? null);
    } catch {
      setStatus('More results could not be loaded.');
    }
  }

  return <section className="role-card role-wide">
    <h2>Results</h2>
    <p>A score is information, not a decision. Nothing here moves a candidate — you do. Candidates are listed in the order they were sent the test, not by score.</p>
    {status ? <p role="status">{status}</p> : null}
    {results && results.length > 0 ? <div className="role-record-table-wrap"><table className="role-record-table">
      <thead><tr><th>Candidate</th><th>State</th><th>Score</th><th>Submitted</th><th>Ended</th></tr></thead>
      <tbody>{results.map((result) => <tr key={result.invitationId}>
        <td>{result.candidateName ?? result.candidateEmail ?? 'NA'}</td>
        <td><span className={`hiring-state state-${result.state.toLowerCase()}`}>{result.state.toLowerCase()}</span></td>
        <td>{result.percentage === null ? <span className="hiring-meta">NA</span> : `${result.percentage}%`}
          {result.score !== null ? <><br /><span className="hiring-meta">{result.score} / {result.maxScore}</span></> : null}</td>
        <td>{result.submittedAt ? new Date(result.submittedAt).toLocaleDateString() : <span className="hiring-meta">Not yet</span>}</td>
        <td>{result.endedBy === 'TIME_LIMIT' ? 'Time ran out' : result.endedBy === 'CANDIDATE' ? 'Submitted by candidate'
          : result.submittedAt ? 'Submitted' : <span className="hiring-meta">Not yet</span>}</td>
      </tr>)}</tbody>
    </table></div> : null}
    {nextCursor ? <button type="button" className="secondary" onClick={() => { void more(); }}>Show more</button> : null}
  </section>;
}

/**
 * EMP-12: one candidate's results on this employer's screening tests, inside Candidate Detail.
 * Read only while the candidate's applicant-access grant is live (the server refuses otherwise,
 * and every read is recorded). Question by question, with how the attempt ended. Nothing about
 * readiness, and nothing from ONE's or the college's own assessments.
 */
export function EmployerCandidateAssessmentsPanel({ employerId, applicationId }: { readonly employerId: string; readonly applicationId: string }): React.ReactElement {
  const [assessments, setAssessments] = useState<readonly EmployerCandidateAssessmentDto[] | null>(null);
  const [status, setStatus] = useState('Loading screening tests…');

  useEffect(() => {
    const token = getAccessToken();
    if (!token) { setStatus('You are not signed in.'); return undefined; }
    const abort = new AbortController();
    listEmployerCandidateAssessments(token, employerId, applicationId, abort.signal)
      .then((response) => { setAssessments(response.assessments ?? []); setStatus(''); })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const failure = error as { status?: number; correlationId?: string };
        setStatus(failure?.status === 403
          ? 'This candidate is no longer sharing their application with you, so their test results are not shown.'
          : `Their screening test results could not be loaded.${failure?.correlationId ? ` Reference: ${failure.correlationId}` : ''}`);
      });
    return () => abort.abort();
  }, [employerId, applicationId]);

  return <section className="role-card role-wide">
    <h2>Screening tests</h2>
    <p className="hiring-meta">Your own tests for this application only. A score is information, not a decision.</p>
    {status ? <p role="status">{status}</p> : null}
    {assessments && assessments.length === 0 ? <p>You have not sent this candidate a screening test. Tests go to candidates in the Assessment stage, from Assessments.</p> : null}
    {(assessments ?? []).map((item) => <div key={item.invitationId} className="role-record-table-wrap">
      <h3>{item.title}</h3>
      <p className="hiring-meta">
        <span className={`hiring-state state-${item.state.toLowerCase()}`}>{item.state.toLowerCase()}</span>
        {' '}· window {new Date(item.opensAt).toLocaleString()} – {new Date(item.closesAt).toLocaleString()}
        {' '}· {Math.round(item.durationSeconds / 60)} min
      </p>
      <p>{item.percentage === null ? 'Score: NA' : `Score: ${item.percentage}% (${item.score} / ${item.maxScore})`}
        {item.endedBy === 'TIME_LIMIT' ? ' · time ran out' : item.endedBy === 'CANDIDATE' ? ' · submitted by the candidate' : ''}</p>
      {item.questions.length > 0 ? <table className="role-record-table">
        <thead><tr><th>#</th><th>Question</th><th>Marks</th><th>Answered</th></tr></thead>
        <tbody>{item.questions.map((question) => <tr key={question.displayOrder}>
          <td>{question.displayOrder}</td>
          <td>{question.questionText}</td>
          <td>{question.marksAwarded} / {question.marks}</td>
          <td>{question.answered ? 'Yes' : 'No'}</td>
        </tr>)}</tbody>
      </table> : null}
    </div>)}
  </section>;
}
