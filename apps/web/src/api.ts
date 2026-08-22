import { getAccessToken } from './auth.js';

export type ApiHealth = 'checking' | 'online' | 'offline';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL;
export const apiBaseUrl = resolveApiBaseUrl(configuredBaseUrl, import.meta.env.DEV);

export class ApiRequestError extends Error {
  readonly status: number;
  readonly correlationId: string;
  readonly code?: string;

  constructor(input: { readonly status: number; readonly correlationId: string; readonly code?: string }) {
    super(`API request failed with status ${input.status}`);
    this.name = 'ApiRequestError';
    this.status = input.status;
    this.correlationId = input.correlationId;
    if (input.code) this.code = input.code;
  }
}

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
  return getAccessToken();
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
    readonly displayName?: string | null; readonly countryCode?: string | null; readonly stateOrProvince?: string | null; readonly city?: string | null; readonly postalCode?: string | null;
    readonly addressLine1?: string | null; readonly addressLine2?: string | null;
    readonly websiteUrl?: string | null; readonly institutionType?: string | null; readonly primaryContactEmail?: string | null;
  };
  readonly initialAdminInvitation?: { readonly id: string; readonly email: string; readonly state: string } | null;
}

export interface InstitutionUnitDto {
  readonly id: string; readonly institutionId: string; readonly kind: string; readonly name: string; readonly parentUnitId?: string | null;
}

export interface InstitutionStaffDto {
  readonly invitations: readonly {
    readonly id: string; readonly email: string; readonly role: string; readonly state: string;
    readonly createdAt: string; readonly expiresAt: string; readonly acceptedAt?: string | null; readonly revokedAt?: string | null;
    readonly delivery?: { readonly commandId: string; readonly state: string; readonly providerKind?: string | null; readonly providerReference?: string | null; readonly outcome?: string | null } | null;
  }[];
  readonly memberships: readonly {
    readonly id: string; readonly userId: string; readonly email: string; readonly role: string; readonly state: string; readonly createdAt: string; readonly updatedAt: string;
  }[];
  readonly unavailableActions: readonly string[];
}

export interface OperationsUserAccessDto {
  readonly id: string;
  readonly email: string;
  readonly verifiedEmail: string | null;
  readonly identityLinkStatus: string;
  readonly state: string;
  readonly memberships: readonly Record<string, unknown>[];
  readonly studentRelationshipCount: number;
  readonly studentRelationships: readonly Record<string, unknown>[];
}

export interface OperationsInvitationDto {
  readonly id: string;
  readonly recipientEmail: string;
  readonly organization: { readonly id: string; readonly legalName: string; readonly kind: string } | null;
  readonly role: string;
  readonly state: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt?: string | null;
  readonly revokedAt?: string | null;
  readonly delivery?: { readonly commandId: string; readonly state: string; readonly destinationRef?: string; readonly providerKind?: string | null; readonly providerReference?: string | null; readonly outcome?: string | null } | null;
}

export interface InstitutionStudentDto {
  readonly id: string; readonly institutionId: string; readonly institutionStudentId: string; readonly fullName: string; readonly email: string; readonly status: string;
  readonly relationship?: { readonly id: string; readonly state: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null } | null;
  readonly units?: Record<string, string | null | undefined>;
}

export interface CurrentStudentDto {
  readonly userId: string;
  readonly verifiedEmail: string | null;
  readonly fullName: string;
  readonly institutionStudentId: string;
  readonly institutionId: string;
  readonly academicStatus: string;
  readonly department?: string | null;
  readonly program?: string | null;
  readonly batch?: string | null;
  readonly section?: string | null;
  readonly relationship?: { readonly id: string; readonly state: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null } | null;
}

export interface StudentProfileDto {
  readonly userId: string;
  readonly verifiedEmail: string | null;
  readonly targetCareer: string | null;
  readonly careerInterests: readonly string[];
  readonly profileHeadline: string | null;
  readonly profileSummary: string | null;
  readonly portfolioUrl: string | null;
  readonly visibilityState: string;
  readonly employerDiscoveryEnabled: boolean;
  readonly updatedAt: string | null;
}

export interface StudentDocumentDto {
  readonly id: string;
  readonly title: string;
  readonly documentType: string;
  readonly description: string | null;
  readonly verificationState: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StudentSavedOpportunityDto {
  readonly id: string;
  readonly opportunityRef: string;
  readonly title: string;
  readonly organizationName: string | null;
  readonly source: string;
  readonly notes: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RosterImportPreviewDto {
  readonly id: string; readonly rowCount: number; readonly acceptedCount: number; readonly warningCount: number; readonly rejectedCount: number;
  readonly rows: readonly { readonly rowNumber: number; readonly institutionStudentId: string; readonly fullName: string; readonly email: string; readonly state: string; readonly issues: readonly string[]; readonly departmentUnitId?: string | null; readonly programUnitId?: string | null; readonly batchUnitId?: string | null; readonly sectionUnitId?: string | null }[];
}

export interface SecurityContextDto {
  readonly userId: string;
  readonly selectedOrganizationId?: string | null;
  readonly memberships: readonly { readonly organizationId: string; readonly role: string; readonly scope: Record<string, string | undefined> }[];
  readonly studentRelationships?: readonly { readonly institutionId: string; readonly state: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null }[];
}

export function getSecurityContext(token: string, signal?: AbortSignal): Promise<SecurityContextDto> {
  return requestJson('/api/v1/security/context', { token, ...(signal ? { signal } : {}) });
}

export function getCurrentStudent(token: string, signal?: AbortSignal): Promise<{ readonly student: CurrentStudentDto }> {
  return requestJson('/api/v1/students/me', { token, ...(signal ? { signal } : {}) });
}

export function getStudentProfile(token: string, signal?: AbortSignal): Promise<{ readonly profile: StudentProfileDto }> {
  return requestJson('/api/v1/students/me/profile', { token, ...(signal ? { signal } : {}) });
}

export function updateStudentProfile(token: string, body: unknown): Promise<{ readonly profile: StudentProfileDto }> {
  return requestJson('/api/v1/students/me/profile', { token, method: 'PATCH', body });
}

export function listStudentDocuments(token: string, signal?: AbortSignal): Promise<{ readonly documents: readonly StudentDocumentDto[]; readonly storage: { readonly fileStorage: string; readonly message: string } }> {
  return requestJson('/api/v1/students/me/documents', { token, ...(signal ? { signal } : {}) });
}

export function createStudentDocument(token: string, body: unknown): Promise<{ readonly document: StudentDocumentDto }> {
  return requestJson('/api/v1/students/me/documents', { token, method: 'POST', body });
}

export function updateStudentDocument(token: string, documentId: string, body: unknown): Promise<{ readonly document: StudentDocumentDto }> {
  return requestJson(`/api/v1/students/me/documents/${encodeURIComponent(documentId)}`, { token, method: 'PATCH', body });
}

export function archiveStudentDocument(token: string, documentId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/students/me/documents/${encodeURIComponent(documentId)}`, { token, method: 'DELETE' });
}

export function listStudentSavedOpportunities(token: string, signal?: AbortSignal): Promise<{ readonly savedOpportunities: readonly StudentSavedOpportunityDto[] }> {
  return requestJson('/api/v1/students/me/saved-opportunities', { token, ...(signal ? { signal } : {}) });
}

export function saveStudentOpportunity(token: string, body: unknown): Promise<{ readonly savedOpportunities: readonly StudentSavedOpportunityDto[] }> {
  return requestJson('/api/v1/students/me/saved-opportunities', { token, method: 'POST', body });
}

export function removeStudentSavedOpportunity(token: string, savedOpportunityId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/students/me/saved-opportunities/${encodeURIComponent(savedOpportunityId)}`, { token, method: 'DELETE' });
}

export function listOperationsOrganizations(token: string, filters: { readonly q?: string; readonly kind?: string; readonly verification?: string } = {}, signal?: AbortSignal): Promise<{ readonly organizations: readonly OrganizationManagementDto[] }> {
  const query = new URLSearchParams();
  if (filters.q?.trim()) query.set('q', filters.q.trim());
  if (filters.kind?.trim()) query.set('kind', filters.kind.trim());
  if (filters.verification?.trim()) query.set('verification', filters.verification.trim());
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/organizations${suffix}`, { token, ...(signal ? { signal } : {}) });
}

export function listOperationsUsersAccess(token: string, q = '', signal?: AbortSignal): Promise<{ readonly users: readonly OperationsUserAccessDto[] }> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return requestJson(`/api/v1/operations/users-access${query}`, { token, ...(signal ? { signal } : {}) });
}

export function listOperationsInvitations(token: string, q = '', signal?: AbortSignal): Promise<{ readonly invitations: readonly OperationsInvitationDto[] }> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return requestJson(`/api/v1/operations/invitations${query}`, { token, ...(signal ? { signal } : {}) });
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

export function getOperationsOrganizationOnboardingStatus(token: string, organizationId: string): Promise<{ readonly status: Record<string, unknown> }> {
  return requestJson(`/api/v1/operations/organizations/${encodeURIComponent(organizationId)}/onboarding-status`, { token });
}

export function acceptInvitation(token: string, invitationToken: string, idempotencyKey: string): Promise<Record<string, unknown>> {
  return requestJson('/api/v1/invitations/accept', { token, method: 'POST', idempotencyKey, body: { token: invitationToken } });
}

export function listInstitutionUnits(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly units: readonly InstitutionUnitDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units`, { token, ...(signal ? { signal } : {}) });
}

export function createInstitutionUnit(token: string, institutionId: string, body: unknown): Promise<{ readonly unit: InstitutionUnitDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units`, { token, method: 'POST', body });
}

export function updateInstitutionUnit(token: string, institutionId: string, unitId: string, body: unknown): Promise<{ readonly unit: InstitutionUnitDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units/${encodeURIComponent(unitId)}`, { token, method: 'PATCH', body });
}

export function listInstitutionStaff(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly staff: InstitutionStaffDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/staff-role-assignments`, { token, ...(signal ? { signal } : {}) });
}

export function listInstitutionStudents(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly students: readonly InstitutionStudentDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students`, { token, ...(signal ? { signal } : {}) });
}

export function addInstitutionStudent(token: string, institutionId: string, body: unknown): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students`, { token, method: 'POST', body });
}

export function updateInstitutionStudent(token: string, institutionId: string, studentProfileId: string, body: unknown): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students/${encodeURIComponent(studentProfileId)}`, { token, method: 'PATCH', body });
}

export function endInstitutionStudentRelationship(token: string, institutionId: string, studentProfileId: string, state: string, effectiveTo?: string): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students/${encodeURIComponent(studentProfileId)}/relationship`, { token, method: 'POST', body: { state, ...(effectiveTo ? { effectiveTo } : {}) } });
}

export function inviteInstitutionStaff(token: string, institutionId: string, email: string, role: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/staff-role-assignments`, { token, method: 'POST', body: { email, role } });
}

export function previewStudentRosterImport(token: string, institutionId: string, filename: string, csv: string): Promise<{ readonly import: RosterImportPreviewDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-imports`, { token, method: 'POST', body: { filename, csv } });
}

export function commitStudentRosterImport(token: string, institutionId: string, importId: string): Promise<{ readonly import: { readonly id: string; readonly committedCount: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-imports/${encodeURIComponent(importId)}/commit`, { token, method: 'POST' });
}

async function requestJson<T>(path: string, input: {
  readonly token?: string; readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; readonly body?: unknown;
  readonly idempotencyKey?: string; readonly signal?: AbortSignal;
} = {}): Promise<T> {
  const correlationId = crypto.randomUUID();
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Correlation-Id': correlationId };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: input.method ?? 'GET', headers, ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { readonly message?: { readonly code?: string; readonly correlationId?: string } } | null;
    throw new ApiRequestError({
      status: response.status,
      correlationId: body?.message?.correlationId ?? response.headers?.get('x-correlation-id') ?? correlationId,
      ...(body?.message?.code ? { code: body.message.code } : {}),
    });
  }
  return response.json() as Promise<T>;
}
