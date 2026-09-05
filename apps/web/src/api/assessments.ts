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
