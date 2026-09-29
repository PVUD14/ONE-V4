/**
 * ONE · API client — Stream C + D
 *
 * The governed exam engine: question bank and publication (institution), attempts
 * and submission (student).
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { requestJson } from './http.js';

export interface ExamSubjectDto { readonly id: string; readonly name: string; readonly code: string | null; readonly approvedQuestions: number }

export interface ExamQuestionDto {
  readonly id: string; readonly subjectId: string; readonly subjectName: string; readonly questionType: string;
  readonly questionText: string; readonly difficulty: string; readonly marks: number; readonly approvalStatus: string; readonly version: number;
}

export interface InstitutionExamDto {
  readonly id: string; readonly title: string; readonly assessmentKind: string; readonly lifecycleState: string;
  readonly subjectName: string; readonly totalMarks: number; readonly durationSeconds: number;
  readonly startsAt: string; readonly endsAt: string; readonly attemptsAllowed: number;
  readonly assignedCount: number; readonly completedAttempts: number;
}

export interface StudentExamDto {
  readonly id: string; readonly title: string; readonly assessmentKind: string; readonly subjectName: string;
  readonly institutionName: string; readonly totalMarks: number; readonly durationSeconds: number;
  readonly startsAt: string; readonly endsAt: string; readonly attemptsAllowed: number; readonly attemptsUsed: number;
  readonly openAttemptId: string | null;
  readonly latestResult: { readonly score: number; readonly maxScore: number; readonly percentage: number } | null;
}

export interface ExamAttemptQuestionDto {
  readonly questionId: string; readonly position: number; readonly questionType: string; readonly questionText: string;
  readonly marks: number; readonly negativeMarks: number;
  readonly options?: readonly { readonly key: string; readonly text: string }[];
  readonly matchTargets?: readonly string[];
  readonly savedResponse: unknown;
}

export interface ExamAttemptDto {
  readonly id: string; readonly status: string; readonly attemptNumber: number; readonly assessmentId: string;
  readonly title: string; readonly totalMarks: number; readonly startedAt: string; readonly durationSeconds: number;
  readonly remainingSeconds: number; readonly screenShiftCount: number; readonly autoSubmitOnFocusLoss: number | null;
  readonly questions: readonly ExamAttemptQuestionDto[];
}

export interface ExamResultDto {
  readonly score: number; readonly maxScore: number; readonly percentage: number;
  readonly correct: number; readonly wrong: number; readonly notAttempted: number;
}

export function listExamSubjects(token: string, institutionId: string, signal?: AbortSignal): Promise<{ subjects: ExamSubjectDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessment-subjects`, { token, ...(signal ? { signal } : {}) });
}

export function createExamSubject(token: string, institutionId: string, body: { name: string; code?: string }): Promise<{ subject: { id: string } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessment-subjects`, { token, method: 'POST', body });
}

export function listExamQuestions(token: string, institutionId: string, filters: { subjectId?: string; status?: string } = {}, signal?: AbortSignal): Promise<{ questions: ExamQuestionDto[] }> {
  const params = new URLSearchParams();
  if (filters.subjectId) params.set('subjectId', filters.subjectId);
  if (filters.status) params.set('status', filters.status);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessment-questions${suffix}`, { token, ...(signal ? { signal } : {}) });
}

export function createExamQuestion(token: string, institutionId: string, body: Record<string, unknown>): Promise<{ question: { id: string; duplicateSuspects: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessment-questions`, { token, method: 'POST', body });
}

export function transitionExamQuestion(token: string, institutionId: string, questionId: string, toStatus: string, note?: string): Promise<{ question: { id: string; approvalStatus: string } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessment-questions/${encodeURIComponent(questionId)}/transition`, { token, method: 'POST', body: { toStatus, note } });
}

export function listInstitutionExams(token: string, institutionId: string, signal?: AbortSignal): Promise<{ assessments: InstitutionExamDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessments`, { token, ...(signal ? { signal } : {}) });
}

export function createInstitutionExam(token: string, institutionId: string, body: Record<string, unknown>): Promise<{ assessment: { id: string } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessments`, { token, method: 'POST', body });
}

export function publishInstitutionExam(token: string, institutionId: string, definitionId: string): Promise<{ assessment: { id: string; lifecycleState: string } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessments/${encodeURIComponent(definitionId)}/publish`, { token, method: 'POST' });
}

export function assignInstitutionExam(token: string, institutionId: string, definitionId: string, studentProfileIds: readonly string[]): Promise<{ assignment: { requested: number; eligible: number; newlyAssigned: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessments/${encodeURIComponent(definitionId)}/assignments`, { token, method: 'POST', body: { studentProfileIds } });
}

export interface ExamNotAttemptedDto { readonly studentName: string; readonly institutionStudentId: string; readonly inProgress: boolean }

export function reopenInstitutionExam(token: string, institutionId: string, definitionId: string, body: { extendMinutes?: number; extraAttempts?: number; durationMinutes?: number }): Promise<{ assessment: { id: string; attemptsAllowed: number; extendedMinutes: number; durationSeconds: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessments/${encodeURIComponent(definitionId)}/reopen`, { token, method: 'POST', body });
}

export function listInstitutionExamResults(token: string, institutionId: string, definitionId: string, signal?: AbortSignal): Promise<{ results: Record<string, unknown>[]; notAttempted: ExamNotAttemptedDto[]; summary: { attempts: number; averagePercentage: number; assigned: number; notAttemptedCount: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/assessments/${encodeURIComponent(definitionId)}/results`, { token, ...(signal ? { signal } : {}) });
}

export function listStudentExams(token: string, signal?: AbortSignal): Promise<{ assessments: StudentExamDto[] }> {
  return requestJson('/api/v1/student/assessments', { token, ...(signal ? { signal } : {}) });
}

export function startExamAttempt(token: string, definitionId: string): Promise<{ attempt: ExamAttemptDto }> {
  return requestJson(`/api/v1/student/assessments/${encodeURIComponent(definitionId)}/attempts`, { token, method: 'POST' });
}

export function getExamAttempt(token: string, attemptId: string, signal?: AbortSignal): Promise<{ attempt: ExamAttemptDto }> {
  return requestJson(`/api/v1/student/assessment-attempts/${encodeURIComponent(attemptId)}`, { token, ...(signal ? { signal } : {}) });
}

export function saveExamAnswer(token: string, attemptId: string, questionId: string, response: unknown): Promise<{ saved: boolean }> {
  return requestJson(`/api/v1/student/assessment-attempts/${encodeURIComponent(attemptId)}/answers`, { token, method: 'POST', body: { questionId, response } });
}

export function reportExamFocusEvent(token: string, attemptId: string): Promise<{ recorded: boolean; level: string; autoSubmitted?: boolean; result?: ExamResultDto | null; remainingBeforeAutoSubmit?: number | null }> {
  return requestJson(`/api/v1/student/assessment-attempts/${encodeURIComponent(attemptId)}/focus-events`, { token, method: 'POST' });
}

export function submitExamAttempt(token: string, attemptId: string): Promise<{ submitted: boolean; autoSubmitted: boolean; result: ExamResultDto | null }> {
  return requestJson(`/api/v1/student/assessment-attempts/${encodeURIComponent(attemptId)}/submit`, { token, method: 'POST' });
}

// --- ONE Assistant -----------------------------------------------------------

// --- Employer screening assessments -------------------------------------------

export interface EmployerQuestionDto {
  readonly id: string;
  readonly questionText: string;
  readonly questionType: string;
  readonly difficulty: string;
  readonly marks: number;
  readonly approvalStatus: string;
  readonly version: number;
  readonly optionCount: number;
  /** EMP-12: the text names a protected attribute or proxy; flagged for the reviewer, never refused. */
  readonly mentionsProtectedAttribute?: boolean;
}

export interface EmployerAssessmentDto {
  readonly id: string;
  readonly title: string;
  readonly durationSeconds: number;
  readonly totalMarks: number;
  readonly lifecycleState: string;
  readonly opportunityId: string | null;
  readonly publishedAt: string | null;
  readonly itemCount: number;
  readonly invitedCount: number;
  readonly submittedCount: number;
}

export interface EmployerAssessmentResultDto {
  readonly invitationId: string;
  readonly applicationId: string;
  readonly state: string;
  readonly candidateName: string | null;
  /** Only from SHORTLISTED onward (decision 10.2 #9). */
  readonly candidateEmail: string | null;
  readonly invitedAt?: string;
  readonly opensAt?: string;
  readonly closesAt: string;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly percentage: number | null;
  readonly submittedAt: string | null;
  /** How a submitted attempt ended: the candidate submitted, or the time limit or window ran out. */
  readonly endedBy?: 'CANDIDATE' | 'TIME_LIMIT' | null;
}

/** EMP-12: one candidate's results on this employer's tests for one application. */
export interface EmployerCandidateAssessmentDto {
  readonly invitationId: string;
  readonly assessmentId: string;
  readonly title: string;
  readonly durationSeconds: number;
  readonly totalMarks: number;
  readonly invitedAt: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly state: string;
  readonly startedAt: string | null;
  readonly submittedAt: string | null;
  readonly endedBy: 'CANDIDATE' | 'TIME_LIMIT' | null;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly percentage: number | null;
  readonly questions: readonly {
    readonly displayOrder: number; readonly questionText: string; readonly questionType: string;
    readonly marks: number; readonly marksAwarded: number; readonly answered: boolean;
  }[];
}

/** Fixed reason codes (server lists; Appendix 2 section 5.7). */
export const QUESTION_REJECT_REASONS = [
  ['INACCURATE', 'Inaccurate'], ['AMBIGUOUS', 'Ambiguous'], ['NOT_RELEVANT_TO_ROLE', 'Not relevant to the role'],
  ['DUPLICATE', 'Duplicate'], ['UNFAIR_OR_BIASED', 'Unfair or biased'],
] as const;
export const QUESTION_ARCHIVE_REASONS = [
  ['OUTDATED', 'Outdated'], ['REPLACED', 'Replaced'], ['FLAWED', 'Flawed'], ['NO_LONGER_USED', 'No longer used'],
] as const;
export const ASSESSMENT_CLOSE_REASONS = [
  ['ROLE_FILLED', 'Role filled'], ['ROLE_CLOSED', 'Role closed'], ['SCREENING_COMPLETE', 'Screening complete'],
  ['REPLACED_BY_NEW_TEST', 'Replaced by a new test'], ['CONTENT_FLAWED', 'Content flawed'],
] as const;

export interface ScreeningInvitationDto {
  readonly id: string;
  readonly state: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly title: string;
  readonly durationSeconds: number;
  readonly employerName: string;
  readonly roleTitle: string;
  readonly attemptId: string | null;
  readonly attemptState: string | null;
  readonly percentage: number | null;
  /** EMP-12: whether it can be started or continued now (employer in good standing, application shared, window open). */
  readonly available?: boolean;
  readonly questionCount?: number;
  readonly totalMarks?: number;
  readonly remainingSeconds?: number | null;
}

/** EMP-12: what the candidate is about to be assessed on, read before starting. */
export interface ScreeningBriefDto {
  readonly id: string;
  readonly title: string;
  readonly employerName: string;
  readonly roleTitle: string;
  readonly state: string;
  readonly attemptState: string | null;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly notOpenYet: boolean;
  readonly durationSeconds: number;
  readonly totalMarks: number;
  readonly questionCount: number;
  readonly questionFormats: readonly { readonly questionType: string; readonly count: number }[];
  readonly minutesAvailableIfStartedNow: number | null;
  readonly available: boolean;
  readonly rules: {
    readonly oneSitting: boolean; readonly timerRunsOnServer: boolean; readonly timerPauses: boolean;
    readonly cameraOrMicrophone: boolean; readonly screenCapture: boolean; readonly tabSwitchesRecorded: boolean;
    readonly resultGoesTo: string; readonly learningEvidence: boolean; readonly readinessChanged: boolean;
  };
}

export interface ScreeningAttemptDto {
  readonly id: string;
  readonly title?: string | null;
  /** Seconds left by the server's clock when the paper was sent; the server enforces it. */
  readonly remainingSeconds?: number;
  readonly questions: readonly {
    readonly questionId: string;
    readonly displayOrder: number;
    readonly questionText: string;
    readonly questionType: string;
    readonly marks: number;
    /** Presented in the candidate's own key order. No indication of which is correct. */
    readonly options: readonly { readonly key: string; readonly text: string }[];
    readonly selectedOptionKeys: readonly string[];
  }[];
}

const employerBase = (employerId: string): string => `/api/v1/employers/${encodeURIComponent(employerId)}`;

export function listEmployerQuestions(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly questions: readonly EmployerQuestionDto[] }> {
  return requestJson(`${employerBase(employerId)}/assessment-questions`, { token, ...(signal ? { signal } : {}) });
}

export function createEmployerQuestion(token: string, employerId: string, body: {
  readonly questionText: string; readonly questionType: string; readonly marks: number;
  readonly difficulty?: string;
  readonly options: readonly { readonly key: string; readonly text: string; readonly isCorrect: boolean }[];
}): Promise<{ readonly question: { readonly id: string } }> {
  return requestJson(`${employerBase(employerId)}/assessment-questions`, { token, method: 'POST', body });
}

export function transitionEmployerQuestion(token: string, employerId: string, questionId: string, toState: string, reasonCode?: string): Promise<{ readonly question: { readonly id: string; readonly approvalStatus: string } }> {
  return requestJson(`${employerBase(employerId)}/assessment-questions/${encodeURIComponent(questionId)}/transition`, { token, method: 'POST', body: reasonCode ? { toState, reasonCode } : { toState } });
}

export function listEmployerAssessments(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly assessments: readonly EmployerAssessmentDto[] }> {
  return requestJson(`${employerBase(employerId)}/assessments`, { token, ...(signal ? { signal } : {}) });
}

export function createEmployerAssessment(token: string, employerId: string, body: {
  readonly title: string; readonly durationSeconds: number;
  readonly opportunityId: string | null; readonly questionIds: readonly string[];
}): Promise<{ readonly assessment: { readonly id: string } }> {
  return requestJson(`${employerBase(employerId)}/assessments`, { token, method: 'POST', body });
}

export function publishEmployerAssessment(token: string, employerId: string, assessmentId: string): Promise<{ readonly assessment: { readonly id: string } }> {
  return requestJson(`${employerBase(employerId)}/assessments/${encodeURIComponent(assessmentId)}/publish`, { token, method: 'POST' });
}

export function closeEmployerAssessment(token: string, employerId: string, assessmentId: string, reasonCode: string): Promise<{ readonly assessment: { readonly id: string } }> {
  return requestJson(`${employerBase(employerId)}/assessments/${encodeURIComponent(assessmentId)}/close`, { token, method: 'POST', body: { reasonCode } });
}

export function inviteToEmployerAssessment(token: string, employerId: string, assessmentId: string, applicationIds: readonly string[], closesAt: string, opensAt?: string): Promise<{ readonly invited: number }> {
  return requestJson(`${employerBase(employerId)}/assessments/${encodeURIComponent(assessmentId)}/invitations`, { token, method: 'POST', body: opensAt ? { applicationIds, opensAt, closesAt } : { applicationIds, closesAt } });
}

export function listEmployerAssessmentResults(token: string, employerId: string, assessmentId: string, signal?: AbortSignal, cursor?: string | null): Promise<{ readonly results: readonly EmployerAssessmentResultDto[]; readonly nextCursor?: string | null }> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestJson(`${employerBase(employerId)}/assessments/${encodeURIComponent(assessmentId)}/results${query}`, { token, ...(signal ? { signal } : {}) });
}

/** EMP-12: one candidate's results on this employer's tests; needs the live applicant-access grant. */
export function listEmployerCandidateAssessments(token: string, employerId: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly assessments: readonly EmployerCandidateAssessmentDto[] }> {
  return requestJson(`${employerBase(employerId)}/applications/${encodeURIComponent(applicationId)}/assessment-results`, { token, ...(signal ? { signal } : {}) });
}

export function listScreeningInvitations(token: string, signal?: AbortSignal): Promise<{ readonly invitations: readonly ScreeningInvitationDto[] }> {
  return requestJson('/api/v1/students/me/screening-assessments', { token, ...(signal ? { signal } : {}) });
}

export function getScreeningBrief(token: string, invitationId: string, signal?: AbortSignal): Promise<{ readonly assessment: ScreeningBriefDto }> {
  return requestJson(`/api/v1/students/me/screening-assessments/${encodeURIComponent(invitationId)}`, { token, ...(signal ? { signal } : {}) });
}

/** Starting records that the candidate read the brief and accepts its terms. */
export function startScreeningAttempt(token: string, invitationId: string): Promise<{ readonly attempt: ScreeningAttemptDto }> {
  return requestJson(`/api/v1/students/me/screening-assessments/${encodeURIComponent(invitationId)}/start`, { token, method: 'POST', body: { acknowledged: true } });
}

export function saveScreeningAnswer(token: string, attemptId: string, questionId: string, selectedOptionKeys: readonly string[]): Promise<{ readonly saved: boolean }> {
  return requestJson(`/api/v1/students/me/screening-attempts/${encodeURIComponent(attemptId)}/answers`, { token, method: 'POST', body: { questionId, selectedOptionKeys } });
}

export function submitScreeningAttempt(token: string, attemptId: string): Promise<{ readonly result: { readonly score: number; readonly maxScore: number; readonly percentage: number } }> {
  return requestJson(`/api/v1/students/me/screening-attempts/${encodeURIComponent(attemptId)}/submit`, { token, method: 'POST' });
}
