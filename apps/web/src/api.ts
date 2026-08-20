export type ApiHealth = 'checking' | 'online' | 'offline';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL;
export const apiBaseUrl = resolveApiBaseUrl(configuredBaseUrl, import.meta.env.DEV);

export function resolveApiBaseUrl(configured: string | undefined, development: boolean): string {
  const value = configured?.trim();
  if (!value) return development ? 'http://127.0.0.1:3000' : '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('VITE_API_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('VITE_API_BASE_URL must contain only a trusted origin');
  }
  if (parsed.protocol !== 'https:' && !(development && parsed.protocol === 'http:')) {
    throw new Error('VITE_API_BASE_URL must use HTTPS outside development');
  }
  return parsed.origin;
}

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

export const getProtectedAccessToken = getCareerReadinessAccessToken;

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

export interface OrganizationManagementDto {
  readonly id: string;
  readonly kind: 'INSTITUTION' | 'EMPLOYER';
  readonly legalName: string;
  readonly verificationState: string;
  readonly active: boolean;
  readonly updatedAt: string;
  readonly profile: {
    readonly displayName?: string | null; readonly countryCode?: string | null; readonly stateOrProvince?: string | null; readonly city?: string | null;
    readonly websiteUrl?: string | null; readonly institutionType?: string | null; readonly primaryContactEmail?: string | null;
  };
  readonly initialAdminInvitation?: { readonly id: string; readonly email: string; readonly state: string } | null;
}

export interface InstitutionUnitDto {
  readonly id: string; readonly institutionId: string; readonly kind: string; readonly name: string; readonly parentUnitId?: string | null;
}

export interface InstitutionStudentDto {
  readonly id: string; readonly institutionId: string; readonly institutionStudentId: string; readonly fullName: string; readonly email: string; readonly status: string;
  readonly relationship?: { readonly id: string; readonly state: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null } | null;
  readonly units?: Record<string, string | null | undefined>;
}

export interface RosterImportPreviewDto {
  readonly id: string; readonly rowCount: number; readonly acceptedCount: number; readonly warningCount: number; readonly rejectedCount: number;
  readonly rows: readonly { readonly rowNumber: number; readonly institutionStudentId: string; readonly fullName: string; readonly email: string; readonly state: string; readonly issues: readonly string[] }[];
}

export interface SecurityContextDto {
  readonly userId: string;
  readonly selectedOrganizationId?: string | null;
  readonly memberships: readonly { readonly organizationId: string; readonly role: string; readonly scope: Record<string, string | undefined> }[];
}

export function getSecurityContext(token: string, signal?: AbortSignal): Promise<SecurityContextDto> {
  return requestJson('/api/v1/security/context', { token, ...(signal ? { signal } : {}) });
}

export function listOperationsOrganizations(token: string, signal?: AbortSignal): Promise<{ readonly organizations: readonly OrganizationManagementDto[] }> {
  return requestJson('/api/v1/operations/organizations', { token, ...(signal ? { signal } : {}) });
}

export function createOperationsOrganization(token: string, body: unknown): Promise<{ readonly organization: OrganizationManagementDto }> {
  return requestJson('/api/v1/operations/organizations', { token, method: 'POST', body });
}

export function updateOperationsOrganization(token: string, organizationId: string, body: unknown): Promise<{ readonly organization: OrganizationManagementDto }> {
  return requestJson(`/api/v1/operations/organizations/${encodeURIComponent(organizationId)}`, { token, method: 'PATCH', body });
}

export function transitionOrganizationVerification(token: string, organizationId: string, toState: string): Promise<{ readonly organization: OrganizationManagementDto }> {
  return requestJson(`/api/v1/operations/organizations/${encodeURIComponent(organizationId)}/verification`, { token, method: 'POST', body: { toState, reasonCode: 'OPERATIONS_UAT' } });
}

export function inviteInitialOrganizationAdmin(token: string, organizationId: string, email: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/operations/organizations/${encodeURIComponent(organizationId)}/initial-admin-invitations`, { token, method: 'POST', body: { email } });
}

export function listInstitutionUnits(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly units: readonly InstitutionUnitDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units`, { token, ...(signal ? { signal } : {}) });
}

export function createInstitutionUnit(token: string, institutionId: string, body: unknown): Promise<{ readonly unit: InstitutionUnitDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units`, { token, method: 'POST', body });
}

export function listInstitutionStudents(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly students: readonly InstitutionStudentDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students`, { token, ...(signal ? { signal } : {}) });
}

export function addInstitutionStudent(token: string, institutionId: string, body: unknown): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students`, { token, method: 'POST', body });
}

export function endInstitutionStudentRelationship(token: string, institutionId: string, studentProfileId: string, state: string): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students/${encodeURIComponent(studentProfileId)}/relationship`, { token, method: 'POST', body: { state } });
}

export function previewStudentRosterImport(token: string, institutionId: string, filename: string, csv: string): Promise<{ readonly import: RosterImportPreviewDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-imports`, { token, method: 'POST', body: { filename, csv } });
}

export function commitStudentRosterImport(token: string, institutionId: string, importId: string): Promise<{ readonly import: { readonly id: string; readonly committedCount: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-imports/${encodeURIComponent(importId)}/commit`, { token, method: 'POST' });
}

async function requestJson<T>(path: string, input: {
  readonly token?: string; readonly method?: 'GET' | 'POST' | 'PATCH'; readonly body?: unknown;
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
