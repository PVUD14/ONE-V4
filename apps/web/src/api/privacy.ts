/**
 * ONE · API client — Stream E — Core
 *
 * Data export, account deletion and DPDP consent.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';
import { requestJson } from './http.js';

export interface PrivacyRequestDto {
  readonly id: string;
  readonly requestType: 'EXPORT' | 'DELETION';
  readonly state: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly scheduledFor: string | null;
  readonly expiresAt: string | null;
  readonly downloadedAt: string | null;
  readonly rejectionReasonCode: string | null;
}

export function listPrivacyRequests(token: string, signal?: AbortSignal): Promise<{ readonly requests: readonly PrivacyRequestDto[] }> {
  return requestJson('/api/v1/students/me/privacy/requests', { token, ...(signal ? { signal } : {}) });
}

export function requestDataExport(token: string): Promise<{ readonly request: { readonly id: string; readonly state: string; readonly expiresAt: string } }> {
  return requestJson('/api/v1/students/me/privacy/exports', { token, method: 'POST' });
}

export function requestAccountDeletion(token: string, reason?: string): Promise<{ readonly request: { readonly id: string; readonly state: string; readonly scheduledFor: string }; readonly gracePeriodDays: number }> {
  return requestJson('/api/v1/students/me/privacy/deletions', { token, method: 'POST', body: reason ? { reason } : {} });
}

export function cancelPrivacyRequest(token: string, requestId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/students/me/privacy/requests/${encodeURIComponent(requestId)}/cancel`, { token, method: 'POST' });
}

export async function downloadDataExport(token: string, requestId: string): Promise<Blob> {
  const response = await fetch(`${apiBaseUrl}/api/v1/students/me/privacy/exports/${encodeURIComponent(requestId)}/download`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': crypto.randomUUID() },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { readonly error?: { readonly code?: string } } | null;
    throw new ApiRequestError({ status: response.status, correlationId: '', ...(body?.error?.code ? { code: body.error.code } : {}) });
  }
  return response.blob();
}

export interface ConsentStatusDto {
  readonly requiredVersion: string | null;
  readonly grantedVersion: string | null;
  readonly required: boolean;
}

export function getPrivacyConsentStatus(token: string, signal?: AbortSignal): Promise<ConsentStatusDto> {
  return requestJson('/api/v1/me/consents/privacy-notice', { token, ...(signal ? { signal } : {}) });
}

export function grantPrivacyConsent(token: string, version: string): Promise<{ granted: boolean; version: string }> {
  return requestJson('/api/v1/me/consents/privacy-notice', { token, method: 'POST', body: { version } });
}

// --- Help & FAQ ---------------------------------------------------------------
