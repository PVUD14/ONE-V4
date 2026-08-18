export type ApiHealth = 'checking' | 'online' | 'offline';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL;
export const apiBaseUrl = configuredBaseUrl || 'http://127.0.0.1:3000';

export async function getApiHealth(signal?: AbortSignal): Promise<ApiHealth> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, signal ? { signal } : undefined);
    return response.ok ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

export interface CareerReadinessCatalog {
  readonly pilot: string;
  readonly releaseManifestId: string;
  readonly modules: readonly {
    readonly id: string; readonly stableKey: string; readonly version: number; readonly title: string; readonly description: string;
    readonly lessons: readonly { readonly id: string; readonly stableKey: string; readonly version: number; readonly title: string;
      readonly body: { readonly summary?: string; readonly practice?: string }; readonly topicId: string; readonly prerequisiteLessonIds: readonly string[] }[];
  }[];
  readonly assessments: readonly { readonly id: string; readonly stableKey: string; readonly title: string;
    readonly blueprintId: string; readonly selectionCount: number; readonly timeLimitSeconds: number }[];
}

export interface LearnerCareerReadinessState {
  readonly catalog: CareerReadinessCatalog;
  readonly progress: readonly { readonly lessonVersionId: string; readonly state: string; readonly completedAt?: string }[];
  readonly attempts: readonly { readonly id: string; readonly state: string; readonly scoreCorrect?: number; readonly scorePossible?: number }[];
  readonly evidence: readonly { readonly id: string; readonly evidenceType: string; readonly topicId: string; readonly demonstrated: number; readonly possible: number }[];
  readonly mastery: readonly { readonly id: string; readonly topicId: string; readonly band: string; readonly evidenceIds: readonly string[] }[];
  readonly readiness: { readonly id: string; readonly band: string; readonly advisory: true; readonly employerVisible: false;
    readonly explanation: { readonly factors?: readonly unknown[] } } | null;
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

export function getCareerReadinessAccessToken(): string | null {
  return window.sessionStorage.getItem('planthepath.accessToken');
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

async function requestJson<T>(path: string, input: {
  readonly token?: string; readonly method?: 'GET' | 'POST'; readonly body?: unknown;
  readonly idempotencyKey?: string; readonly signal?: AbortSignal;
} = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Correlation-Id': crypto.randomUUID() };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: input.method ?? 'GET', headers, ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) throw new Error(`API request failed with status ${response.status}`);
  return response.json() as Promise<T>;
}
