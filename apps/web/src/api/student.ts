/**
 * ONE · API client — Stream D — Learner
 *
 * Student-owned profile, documents (metadata and encrypted binaries), saved
 * opportunities and activity.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';
import { requestJson } from './http.js';

export interface CurrentStudentDto {
  readonly userId: string;
  readonly verifiedEmail: string | null;
  readonly fullName: string;
  readonly institutionStudentId: string;
  readonly institutionId: string;
  /** INST-10: the college's name, and whether the student has left it (graduated, transferred or ended). */
  readonly institutionName?: string | null;
  readonly formerStudent?: boolean;
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

export interface StudentDocumentFileDto {
  readonly versionNumber: number;
  readonly filename: string;
  readonly byteSize: number;
  readonly contentType: string;
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
  /** Present only when a scanned, clean file is attached. */
  readonly file: StudentDocumentFileDto | null;
}

/** File types the API accepts; the same allowlist the database enforces. */
export const ACCEPTED_DOCUMENT_TYPES = 'application/pdf,image/png,image/jpeg,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/**
 * Sends the file as a raw body rather than multipart: the API reads the bytes
 * directly, so there is no multipart parser in front of an untrusted upload.
 */
export async function uploadDocumentFile(token: string, documentId: string, file: File): Promise<{ readonly file: { readonly id: string; readonly versionNumber: number; readonly filename: string; readonly byteSize: number } }> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}/api/v1/students/me/documents/${encodeURIComponent(documentId)}/file`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': file.type,
      'X-Filename': file.name,
      'X-Correlation-Id': correlationId,
    },
    body: file,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { readonly error?: { readonly code?: string; readonly correlationId?: string } } | null;
    throw new ApiRequestError({
      status: response.status,
      correlationId: body?.error?.correlationId ?? correlationId,
      ...(body?.error?.code ? { code: body.error.code } : {}),
    });
  }
  return response.json() as Promise<{ readonly file: { readonly id: string; readonly versionNumber: number; readonly filename: string; readonly byteSize: number } }>;
}

// --- Privacy: export and deletion -------------------------------------------

/** Returns the bytes so the caller decides how to present them. */
export async function downloadDocumentFile(token: string, documentId: string): Promise<Blob> {
  const response = await fetch(`${apiBaseUrl}/api/v1/students/me/documents/${encodeURIComponent(documentId)}/file`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': crypto.randomUUID() },
  });
  if (!response.ok) throw new ApiRequestError({ status: response.status, correlationId: response.headers?.get('x-correlation-id') ?? '' });
  return response.blob();
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

export function getCurrentStudent(token: string, signal?: AbortSignal): Promise<{ readonly student: CurrentStudentDto }> {
  return requestJson('/api/v1/students/me', { token, ...(signal ? { signal } : {}) });
}

/** Student-scoped C7 projection; staff identities and review metadata are not returned. */
export interface StudentStaffActionDto {
  readonly id: string;
  readonly actionType: 'INTERVENTION' | 'ASSIGNED_TASK';
  readonly title: string;
  readonly note: string | null;
  readonly state: string;
  readonly dueAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly canComplete: boolean;
  readonly responseNote: string | null;
  readonly assignerRole: string;
}

export function listStudentStaffActions(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly actions: readonly StudentStaffActionDto[] }> {
  return requestJson(`/api/v1/students/me/staff-actions?institutionId=${encodeURIComponent(institutionId)}`,
    { token, ...(signal ? { signal } : {}) });
}

export function completeStudentStaffAction(token: string, actionId: string,
  body: { readonly version: number; readonly responseNote: string }, signal?: AbortSignal): Promise<{
    readonly id: string; readonly state: 'COMPLETED'; readonly version: number;
    readonly responseNote: string | null; readonly resolvedAt: string;
  }> {
  return requestJson(`/api/v1/students/me/staff-actions/${encodeURIComponent(actionId)}/complete`, {
    token, method: 'POST', body: { version: body.version, responseNote: body.responseNote }, ...(signal ? { signal } : {}),
  });
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

export interface StudentActivityDto {
  readonly today: string;
  readonly currentStreakDays: number;
  readonly activeDaysLast7: number;
  readonly last7: readonly { readonly date: string; readonly count: number }[];
  readonly days: readonly { readonly date: string; readonly count: number }[];
}

export function getStudentActivity(token: string, signal?: AbortSignal): Promise<StudentActivityDto> {
  return requestJson('/api/v1/student/activity', { token, ...(signal ? { signal } : {}) });
}
