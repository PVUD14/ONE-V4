/**
 * ONE · API client — Stream D — Learner
 *
 * Catalogue, learner state, lesson completion and career-readiness assessments.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { requestJson } from './http.js';

export interface CareerReadinessCatalog {
  readonly pilot: string;
  readonly releaseManifestId: string;
  readonly topics: readonly { readonly id: string; readonly stableKey: string; readonly name: string; readonly description: string }[];
  readonly modules: readonly {
    readonly id: string; readonly stableKey: string; readonly version: number; readonly title: string; readonly description: string;
    readonly lessons: readonly { readonly id: string; readonly stableKey: string; readonly version: number; readonly title: string;
      readonly body: { readonly summary?: string; readonly practice?: string }; readonly topicId: string; readonly prerequisiteLessonIds: readonly string[] }[];
  }[];
  readonly assessments: readonly { readonly id: string; readonly stableKey: string; readonly title: string;
    readonly blueprintId: string; readonly selectionCount: number; readonly timeLimitSeconds: number }[];
}

export interface ReadinessHistoryEntry {
  readonly id: string;
  readonly band: 'NOT_ENOUGH_EVIDENCE' | 'DEVELOPING' | 'PROGRESSING' | 'READY_FOR_NEXT_STEP';
  readonly modelVersionId: string;
  readonly generatedAt: string;
}

export interface LearnerCareerReadinessState {
  readonly catalog: CareerReadinessCatalog;
  readonly progress: readonly { readonly lessonVersionId: string; readonly state: string; readonly startedAt?: string | null; readonly completedAt?: string | null }[];
  readonly attempts: readonly { readonly id: string; readonly state: string; readonly startedAt?: string; readonly submittedAt?: string | null;
    readonly scoreCorrect?: number; readonly scorePossible?: number }[];
  readonly evidence: readonly { readonly id: string; readonly evidenceType: string; readonly topicId: string; readonly occurredAt?: string;
    readonly demonstrated: number; readonly possible: number }[];
  readonly mastery: readonly { readonly id: string; readonly topicId: string; readonly band: string; readonly evidenceIds: readonly string[] }[];
  readonly readiness: { readonly id: string; readonly band: string; readonly advisory: true; readonly employerVisible: false;
    readonly explanation: { readonly factors?: readonly { readonly topicId: string; readonly masteryBand: string; readonly explanation: string }[] } } | null;
  /** Newest first, at most 100 snapshots. Optional for unavailable/older responses. */
  readonly readinessHistory?: readonly ReadinessHistoryEntry[];
  readonly roadmap: readonly { readonly id: string; readonly topicId: string; readonly actionCode: string; readonly reasonCode: string; readonly state: string; readonly dueAt?: string }[];
  readonly notificationPreferences: { readonly emailEnabled: boolean; readonly quietHoursStartMinute: number;
    readonly quietHoursEndMinute: number; readonly dailyCap: number } | null;
  readonly notifications: readonly { readonly id: string; readonly templateKey: string; readonly channel: 'EMAIL';
    readonly legalPurpose: string; readonly state: string; readonly createdAt: string; readonly expiresAt: string }[];
}

export interface CareerReadinessOperationsStatus {
  readonly releases: readonly { readonly id: string; readonly name: string; readonly version: number; readonly manifestHash: string;
    readonly status: string; readonly publishedAt?: string }[];
  readonly sourceGovernance: readonly { readonly rightsState: string; readonly smeState: string; readonly qualityState: string;
    readonly releaseState: string; readonly releaseEligible: boolean; readonly count: number }[];
  readonly reviewQueue: readonly { readonly id: string; readonly entityType: string; readonly revision: number; readonly state: string }[];
  readonly outboxFailures: readonly { readonly id: string; readonly eventType: string; readonly aggregateType: string;
    readonly attempts: number; readonly failureClass?: string; readonly correlationId: string }[];
  readonly workflows: readonly { readonly id: string; readonly allowlistId: string; readonly version: number; readonly workflowHash: string;
    readonly operation: string; readonly destinationClass: 'EMAIL'; readonly active: boolean; readonly killSwitch: boolean }[];
  readonly automationCommands: readonly { readonly id: string; readonly allowlistId: string; readonly state: string;
    readonly attempts: number; readonly failureClass?: string; readonly correlationId: string }[];
}

export interface AssessmentAttemptDto {
  readonly attemptId: string;
  readonly assignmentId: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly questions: readonly { readonly id: string; readonly topicId: string; readonly prompt: string;
    readonly options: readonly { readonly id: string; readonly text: string }[]; readonly publishedRevision: number }[];
}

export function getCareerReadinessCatalog(signal?: AbortSignal): Promise<CareerReadinessCatalog> {
  return requestJson('/api/v1/career-readiness/catalog', signal ? { signal } : {});
}

export function getLearnerCareerReadinessState(token: string, signal?: AbortSignal): Promise<LearnerCareerReadinessState> {
  return requestJson('/api/v1/career-readiness/me', { token, ...(signal ? { signal } : {}) });
}

export function completeCareerReadinessLesson(token: string, lessonVersionId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/career-readiness/lessons/${encodeURIComponent(lessonVersionId)}/complete`, { token, method: 'POST' });
}

export function startCareerReadinessAssessment(token: string, assessmentDefinitionId: string): Promise<AssessmentAttemptDto> {
  return requestJson(`/api/v1/career-readiness/assessments/${encodeURIComponent(assessmentDefinitionId)}/attempts`, { token, method: 'POST' });
}

export function submitCareerReadinessAssessment(
  token: string,
  attemptId: string,
  selectedOptions: Readonly<Record<string, string>>,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/career-readiness/attempts/${encodeURIComponent(attemptId)}/submit`, {
    token, method: 'POST', idempotencyKey, body: { selectedOptions },
  });
}

export function getCareerReadinessImportOperations(token: string, signal?: AbortSignal): Promise<readonly {
  readonly id: string; readonly packageIdentity: string; readonly sourceRepository: string; readonly sourceCommit: string;
  readonly manifestHash: string; readonly transformVersion: string; readonly status: string; readonly blockedRecords: number;
}[]> {
  return requestJson('/api/v1/operations/career-readiness/imports', { token, ...(signal ? { signal } : {}) });
}

export function getCareerReadinessOperationsStatus(token: string, signal?: AbortSignal): Promise<CareerReadinessOperationsStatus> {
  return requestJson('/api/v1/operations/career-readiness/status', { token, ...(signal ? { signal } : {}) });
}
