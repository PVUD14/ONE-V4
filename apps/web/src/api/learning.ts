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

/** ENG-22: why the AI tutor cannot give the next hint now. OFF / NO_CONSENT / ASSESSMENT_MODE: no AI control is shown. */
export type TutorReason = 'ASSESSMENT_MODE' | 'OFF' | 'NO_CONSENT' | 'LANGUAGE_NOT_SUPPORTED' | 'NO_LADDER' | 'HINTS_USED' | 'PENDING' | 'DAILY_LIMIT';

/** ENG-22: one shown hint level — from the written ladder or the AI tutor (always labelled as AI). */
export interface StepHintDto {
  readonly level: number;
  readonly source: 'LADDER' | 'AI_TUTOR';
  /** PENDING: the AI tutor is still writing it. FALLBACK: `text` is the written hint for the level. */
  readonly state: 'SHOWN' | 'PENDING' | 'FALLBACK';
  readonly text: string | null;
  readonly fallback: 'CHECKS_FAILED' | 'UNAVAILABLE' | 'TIMED_OUT' | 'NOT_A_HINT' | null;
}

export interface StepQuestionDto {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly position: number;
  readonly hintsAvailable: boolean;
  readonly hints: readonly string[];
  /** ENG-22 (absent from an older API): the same levels with their source and state. */
  readonly hintDetails?: readonly StepHintDto[];
  /** ENG-22 (absent from an older API): whether the AI tutor can give the next level now. */
  readonly tutor?: { readonly available: boolean; readonly reason: TutorReason | null; readonly remainingToday: number | null };
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
  /** Titled in the learner's lesson language where a published version exists (ENG-16); `language` says which. */
  readonly lessons: readonly { readonly id: string; readonly title: string; readonly language?: string }[];
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

/** One step as it stands (the screen polls this while an AI hint is being written). */
export function getLearningStep(token: string, decisionId: string, signal?: AbortSignal): Promise<{ readonly step: LearningStepDto }> {
  return requestJson<{ readonly step: LearningStepDto }>(`${base}/steps/${encodeURIComponent(decisionId)}`, opts(token, signal));
}

/** ENG-22: asks the AI tutor for the next hint level. Answers at once with the level pending; the hint is written by a job. */
export function requestTutorHint(token: string, decisionId: string, questionId: string): Promise<{ readonly step: LearningStepDto }> {
  return requestJson<{ readonly step: LearningStepDto }>(`${base}/steps/${encodeURIComponent(decisionId)}/tutor-hints`, { token, method: 'POST', body: { questionId } });
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
