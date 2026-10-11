/**
 * ONE · API client — a college's data-processing terms, exit and exit export (INST-18).
 *
 * The college side (terms status and acceptance, its exit, the exit-export files) and the operations
 * side (publishing a terms version, and the exit runbook: notice, end, cancel, purge preview, purge).
 * Kept in its own file so the goal's client surface is in one place.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';
import { requestJson } from './http.js';
import { bearerHeader } from '../sandbox.js';

export type InstitutionDataTermsStatus = 'NO_TERMS_PUBLISHED' | 'ACCEPTED' | 'ACCEPTANCE_REQUIRED';
export type InstitutionDataTermsLegalReviewState = 'DRAFT_FOR_LEGAL_REVIEW' | 'LEGAL_APPROVED';

export interface InstitutionDataTermsVersionDto {
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly legalReviewState: InstitutionDataTermsLegalReviewState;
  readonly legalReviewReference: string | null;
  readonly requiresReacceptance: boolean;
  readonly changeSummary: string | null;
  readonly publishedAt: string;
}

export interface InstitutionDataTermsDto {
  readonly status: InstitutionDataTermsStatus;
  readonly current: InstitutionDataTermsVersionDto | null;
  readonly required: { readonly version: string; readonly publishedAt: string } | null;
  readonly latestAcceptance: { readonly version: string; readonly acceptedAt: string; readonly acceptedBy: string | null } | null;
  readonly currentVersionAccepted: boolean;
}

export type InstitutionExitState = 'NOTICE' | 'ENDED' | 'CANCELLED' | 'PURGED';

export interface InstitutionExitDto {
  readonly state: InstitutionExitState;
  readonly noticeAt: string;
  readonly endedAt: string | null;
  readonly retentionEndsAt: string | null;
  readonly cancelledAt: string | null;
  readonly purgedAt: string | null;
  readonly exitExportLastTakenAt: string | null;
}

export type InstitutionExitExportSection = 'units' | 'roster' | 'staff' | 'teaching-assignments' | 'assessments' | 'assessment-results'
  | 'staff-actions' | 'verification-decisions' | 'counselling-notes';

export interface InstitutionExitExportDto {
  readonly available: boolean;
  readonly sections: readonly { readonly section: InstitutionExitExportSection; readonly rows: number; readonly parts: number }[];
  readonly restricted: { readonly section: 'counselling-notes'; readonly rows: number; readonly parts: number; readonly reasons: readonly string[] } | null;
  readonly reasons: readonly string[];
  readonly excluded: readonly string[];
}

const institutionPath = (institutionId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}`;

export function getInstitutionDataTerms(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly terms: InstitutionDataTermsDto; readonly canAccept: boolean }> {
  return requestJson(`${institutionPath(institutionId)}/data-terms`, { token, ...(signal ? { signal } : {}) });
}

export function acceptInstitutionDataTerms(token: string, institutionId: string, version: string): Promise<{ readonly terms: InstitutionDataTermsDto; readonly canAccept: boolean }> {
  return requestJson(`${institutionPath(institutionId)}/data-terms/accept`, { token, method: 'POST', body: { version } });
}

export function getInstitutionExit(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly exit: InstitutionExitDto | null; readonly export: InstitutionExitExportDto }> {
  return requestJson(`${institutionPath(institutionId)}/exit`, { token, ...(signal ? { signal } : {}) });
}

/**
 * One file of the exit export. Fetched with the token and handed to the browser rather than linked,
 * like every other export. Errors carry only the code and reference, never upstream text.
 */
export async function downloadInstitutionExitExport(token: string, institutionId: string, section: InstitutionExitExportSection, body: {
  readonly reasonCode: string; readonly part?: number; readonly includeRestrictedCounsellingNotes?: boolean;
}): Promise<{ readonly filename: string; readonly csv: string }> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}${institutionPath(institutionId)}/exit-export/${section}`, {
    method: 'POST',
    headers: { Accept: 'text/csv', 'Content-Type': 'application/json', ...bearerHeader(token), 'X-Correlation-Id': correlationId },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { readonly error?: { readonly code?: string; readonly correlationId?: string } } | null;
    throw new ApiRequestError({
      status: response.status,
      correlationId: failure?.error?.correlationId ?? correlationId,
      ...(failure?.error?.code ? { code: failure.error.code } : {}),
    });
  }
  const disposition = response.headers?.get('content-disposition') ?? '';
  const filename = /filename="([A-Za-z0-9._-]+)"/.exec(disposition)?.[1] ?? `one-exit-${section}.csv`;
  return { filename, csv: await response.text() };
}

// --- Operations ------------------------------------------------------------

export interface OperatorInstitutionDataTermsVersionDto extends InstitutionDataTermsVersionDto {
  readonly acceptedBy: number;
}

export function listOperatorInstitutionDataTerms(token: string, signal?: AbortSignal): Promise<{ readonly versions: readonly OperatorInstitutionDataTermsVersionDto[] }> {
  return requestJson('/api/v1/operations/institution-data-terms', { token, ...(signal ? { signal } : {}) });
}

export function publishOperatorInstitutionDataTerms(token: string, body: {
  readonly version: string; readonly title: string; readonly body: string; readonly legalReviewState: InstitutionDataTermsLegalReviewState;
  readonly legalReviewReference?: string; readonly requiresReacceptance: boolean; readonly changeSummary?: string; readonly reasonCode: string;
}): Promise<{ readonly version: InstitutionDataTermsVersionDto }> {
  return requestJson('/api/v1/operations/institution-data-terms', { token, method: 'POST', body });
}

export interface OperatorInstitutionOffboardingDto extends InstitutionExitDto {
  readonly id: string;
  readonly institutionId: string;
  readonly institutionName: string;
  readonly noticeReasonCode: string;
  readonly endReasonCode: string | null;
  readonly cancelReasonCode: string | null;
  readonly retentionElapsed: boolean;
  readonly purgeSummary: Readonly<Record<string, number>> | null;
  readonly changes: { readonly relationships: number; readonly memberships: number; readonly restored: number };
}

export interface OperatorOffboardingPolicyDto {
  readonly retentionDays: number;
  readonly reasons: { readonly NOTICE: readonly string[]; readonly END: readonly string[]; readonly CANCEL: readonly string[] };
  readonly purgeReasons: readonly string[];
}

export interface InstitutionPurgePreviewDto {
  readonly deletes: Readonly<Record<string, number>>;
  readonly keeps: Readonly<Record<string, number>>;
  readonly studentsUnderHold: number;
}

const offboardingsPath = '/api/v1/operations/institution-offboardings';

export function listOperatorInstitutionOffboardings(token: string, signal?: AbortSignal): Promise<{ readonly offboardings: readonly OperatorInstitutionOffboardingDto[]; readonly policy: OperatorOffboardingPolicyDto }> {
  return requestJson(offboardingsPath, { token, ...(signal ? { signal } : {}) });
}

export function recordInstitutionOffboardingNotice(token: string, institutionId: string, reasonCode: string): Promise<{ readonly offboarding: OperatorInstitutionOffboardingDto }> {
  return requestJson(offboardingsPath, { token, method: 'POST', body: { institutionId, reasonCode } });
}

export function stepInstitutionOffboarding(token: string, offboardingId: string, step: 'end' | 'cancel', reasonCode: string): Promise<{ readonly offboarding: OperatorInstitutionOffboardingDto }> {
  return requestJson(`${offboardingsPath}/${encodeURIComponent(offboardingId)}/${step}`, { token, method: 'POST', body: { reasonCode } });
}

export function getInstitutionPurgePreview(token: string, offboardingId: string, signal?: AbortSignal): Promise<{ readonly offboarding: OperatorInstitutionOffboardingDto; readonly preview: InstitutionPurgePreviewDto }> {
  return requestJson(`${offboardingsPath}/${encodeURIComponent(offboardingId)}/purge-preview`, { token, ...(signal ? { signal } : {}) });
}

export function purgeInstitutionOffboarding(token: string, offboardingId: string, body: { readonly reasonCode: string; readonly approvalId: string }): Promise<{
  readonly offboarding: OperatorInstitutionOffboardingDto; readonly deleted: Readonly<Record<string, number>>; readonly approval: { readonly id: string; readonly mode: 'DUAL' | 'SOLO' };
}> {
  return requestJson(`${offboardingsPath}/${encodeURIComponent(offboardingId)}/purge`, { token, method: 'POST', body });
}
