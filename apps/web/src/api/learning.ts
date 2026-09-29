/**
 * ONE · API client — the student learning experience (ENG-18) and the placement test (ENG-14).
 *
 * The path (skip / review / learn, due reviews, latest step), the next step with its reasons, practice on the
 * step with the hint ladder, and the placement test. Responses carry labels, reason codes and question text
 * only — never an answer key, the correct option, a model number (likelihood, stability, ability) or a
 * readiness value.
 */
import { requestJson } from './http.js';

export type PathBand = 'NOT_ENOUGH_EVIDENCE' | 'DEVELOPING' | 'PROGRESSING' | 'DEMONSTRATED';
export type PathGapStatus = 'MET' | 'PARTIAL' | 'MISSING' | 'UNKNOWN';
export type StepAction = 'REVIEW' | 'REMEDIATE' | 'PRACTICE' | 'LEARN' | 'FOLLOW_ASSIGNMENT' | 'NONE';

export interface PathEntryDto {
  readonly skillId: string;
  readonly skillName: string;
  readonly requirementLevel: 'ESSENTIAL' | 'IMPORTANT' | 'HELPFUL';
  readonly gapStatus: PathGapStatus;
  readonly band: PathBand;
  readonly due: boolean;
  readonly reasonCodes: readonly string[];
}

export interface StepQuestionDto {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly position: number;
  readonly hintsAvailable: boolean;
  readonly hints: readonly string[];
}

export type StepPracticeDto =
  | { readonly status: 'NO_SKILL' }
  | { readonly status: 'NO_PRACTICE' }
  | { readonly status: 'IN_PROGRESS'; readonly question: StepQuestionDto; readonly questionsAnswered: number }
  | { readonly status: 'COMPLETED'; readonly questionsAnswered: number };

export interface LearningStepDto {
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly action: StepAction;
  readonly skill: { readonly id: string; readonly name: string } | null;
  readonly strategyKind: string | null;
  readonly reasonCodes: readonly string[];
  readonly adaptive: boolean;
  readonly lessons: readonly { readonly id: string; readonly title: string }[];
  readonly practice: StepPracticeDto;
}

export interface LearningPathDto {
  readonly adaptive: boolean;
  readonly target: { readonly careerRoleId: string; readonly title: string } | null;
  readonly requirements: { readonly total: number; readonly met: number; readonly notMeasured: number } | null;
  readonly groups: { readonly policyVersion: string; readonly skip: readonly PathEntryDto[]; readonly review: readonly PathEntryDto[]; readonly learn: readonly PathEntryDto[] };
  readonly dueReviews: readonly { readonly skillId: string; readonly skillName: string }[];
  readonly latestStep: LearningStepDto | null;
}

export interface StepAnswerDto {
  readonly feedback: { readonly questionId: string; readonly correct: boolean; readonly assisted: boolean };
  readonly step: LearningStepDto;
}

export type PlacementLevel = 'AWARE' | 'GUIDED' | 'INDEPENDENT' | 'TROUBLESHOOT' | 'NOT_ENOUGH_EVIDENCE';

export type PlacementDto =
  | { readonly status: 'NOT_AVAILABLE'; readonly reason: 'CONSENT_REQUIRED' | 'NOT_ENOUGH_ITEMS' }
  | { readonly status: 'NOT_STARTED' }
  | {
      readonly status: 'IN_PROGRESS'; readonly placementTestId: string;
      readonly question: { readonly id: string; readonly prompt: string; readonly options: readonly { readonly id: string; readonly text: string }[]; readonly position: number };
      readonly questionsAnswered: number; readonly maxQuestions: number; readonly deadlineAt: string;
    }
  | { readonly status: 'COMPLETED'; readonly placementTestId: string; readonly placementLevel: PlacementLevel; readonly stopReason: string; readonly questionsAnswered: number; readonly completedAt: string };

const base = '/api/v1/learning';
const opts = (token: string, signal?: AbortSignal) => ({ token, ...(signal ? { signal } : {}) });

export function getLearningPath(token: string, signal?: AbortSignal): Promise<{ readonly path: LearningPathDto }> {
  return requestJson<{ readonly path: LearningPathDto }>(`${base}/path`, opts(token, signal));
}

export function startNextLearningStep(token: string, sessionMinutes: number | null = null): Promise<{ readonly step: LearningStepDto }> {
  return requestJson<{ readonly step: LearningStepDto }>(`${base}/next-step`, { token, method: 'POST', body: { sessionMinutes } });
}

export function revealStepHint(token: string, decisionId: string, questionId: string): Promise<{ readonly step: LearningStepDto }> {
  return requestJson<{ readonly step: LearningStepDto }>(`${base}/steps/${encodeURIComponent(decisionId)}/hints`, { token, method: 'POST', body: { questionId } });
}

export function answerStepQuestion(token: string, decisionId: string, questionId: string, selectedOptionId: string): Promise<StepAnswerDto> {
  return requestJson<StepAnswerDto>(`${base}/steps/${encodeURIComponent(decisionId)}/answers`, { token, method: 'POST', body: { questionId, selectedOptionId } });
}

export function getPlacementTest(token: string, signal?: AbortSignal): Promise<{ readonly placement: PlacementDto }> {
  return requestJson<{ readonly placement: PlacementDto }>(`${base}/placement-test`, opts(token, signal));
}

export function startPlacementTest(token: string): Promise<{ readonly placement: PlacementDto }> {
  return requestJson<{ readonly placement: PlacementDto }>(`${base}/placement-test`, { token, method: 'POST' });
}

export function answerPlacementQuestion(token: string, placementTestId: string, questionId: string, selectedOptionId: string): Promise<{ readonly placement: PlacementDto }> {
  return requestJson<{ readonly placement: PlacementDto }>(`${base}/placement-test/${encodeURIComponent(placementTestId)}/answers`, { token, method: 'POST', body: { questionId, selectedOptionId } });
}
