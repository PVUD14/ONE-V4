/**
 * ONE · API client — Operations Security: Privacy and consent (OPS-06).
 *
 * The privacy request queue and one request's history (its read is audited server-side),
 * legal holds, and consent coverage. Subjects arrive masked. Consent counts under 5 arrive
 * already suppressed, with no value, so this client never has a small count to leak.
 * Releasing a hold goes through the approvals queue (`requestOperationApproval`), not here.
 */
import { requestJson } from './http.js';

export type PrivacyRequestTypeDto = 'EXPORT' | 'DELETION';
export type PrivacyRequestStateDto = 'RECEIVED' | 'IN_PROGRESS' | 'READY' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'FAILED';

export interface PrivacySubjectDto {
  readonly userId: string;
  readonly maskedEmail: string | null;
  readonly erased: boolean;
}

export interface OperationsPrivacyRequestDto {
  readonly id: string;
  readonly reference: string;
  readonly requestType: PrivacyRequestTypeDto;
  readonly state: PrivacyRequestStateDto;
  readonly subject: PrivacySubjectDto;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly deletionScheduledFor: string | null;
  readonly exportExpiresAt: string | null;
  readonly rejectionReasonCode: string | null;
  readonly updatedAt: string;
  readonly activeHolds: number;
  /** Null until a statutory response period is defined in code: shown as NA. */
  readonly statutoryDueAt: string | null;
}

export interface OperationsPrivacyRequestDetailDto extends OperationsPrivacyRequestDto {
  readonly history: readonly { readonly fromState: PrivacyRequestStateDto | null; readonly toState: PrivacyRequestStateDto; readonly actorRole: string | null; readonly occurredAt: string }[];
  readonly deletionOutcome: readonly { readonly category: string; readonly disposition: string; readonly basis: string | null; readonly recordCount: number | null; readonly occurredAt: string }[];
  readonly holds: readonly { readonly id: string; readonly reasonCode: string; readonly placedAt: string }[];
}

export interface PrivacyQueueSummaryDto {
  readonly open: { readonly EXPORT: number; readonly DELETION: number };
  readonly deletionsDueWithinSevenDays: number;
  readonly deletionsPastSchedule: number;
  readonly failed: number;
  readonly activeHolds: number;
  readonly releasesInFlight: number;
}

export interface PrivacyRequestQueueDto {
  readonly requests: readonly OperationsPrivacyRequestDto[];
  readonly nextCursor: string | null;
  readonly summary: PrivacyQueueSummaryDto;
  readonly policy: {
    readonly deletionGracePeriodDays: number;
    readonly statutoryResponsePeriodDays: Readonly<Record<PrivacyRequestTypeDto, number | null>>;
  };
  readonly correlationId: string;
}

export interface OperationsPrivacyRequestFilters {
  readonly view?: string;
  readonly type?: string;
  readonly cursor?: string;
}

export interface RetentionHoldDto {
  readonly id: string;
  readonly reasonCode: string;
  readonly detail: string | null;
  readonly subject: PrivacySubjectDto;
  readonly placedAt: string;
  readonly placedBy: { readonly email: string };
  readonly openDeletion: { readonly requestId: string; readonly reference: string; readonly scheduledFor: string | null } | null;
  readonly releaseRequest: { readonly state: 'PENDING' | 'APPROVED'; readonly expiresAt: string; readonly requestedBy: { readonly email: string } } | null;
}

export interface RetentionHoldListDto {
  readonly holds: readonly RetentionHoldDto[];
  readonly capped: boolean;
  readonly reasons: { readonly place: readonly string[]; readonly release: readonly string[] };
  readonly correlationId: string;
}

export type SuppressedCountDto = { readonly suppressed: true; readonly value: null } | { readonly suppressed: false; readonly value: number };

export interface ConsentKeyCoverageDto {
  readonly consentKey: string;
  readonly status: 'LIVE' | 'NO_LIVE_VERSION' | 'NOT_PUBLISHED';
  readonly liveVersion: string | null;
  readonly title: string | null;
  readonly enforcement: 'BLOCKING' | 'OPTIONAL' | null;
  readonly counts: {
    readonly consentedToLiveVersion: SuppressedCountDto;
    readonly withdrawn: SuppressedCountDto;
    readonly onOlderVersion: SuppressedCountDto;
  } | null;
}

export interface ConsentDefinitionDto {
  readonly consentKey: string;
  readonly version: string;
  readonly title: string;
  readonly enforcement: 'BLOCKING' | 'OPTIONAL';
  readonly withdrawable: boolean;
  readonly documentRef: string | null;
  readonly effectiveFrom: string;
  readonly retiredAt: string | null;
  readonly status: 'LIVE' | 'SCHEDULED' | 'RETIRED';
}

export interface ConsentCoverageDto {
  readonly keys: readonly ConsentKeyCoverageDto[];
  readonly definitions: readonly ConsentDefinitionDto[];
  readonly suppressionThreshold: number;
  readonly correlationId: string;
}

export function listOperationsPrivacyRequests(token: string, filters: OperationsPrivacyRequestFilters = {}, signal?: AbortSignal): Promise<PrivacyRequestQueueDto> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/privacy/requests${suffix}`, { token, ...(signal ? { signal } : {}) });
}

export function getOperationsPrivacyRequest(token: string, requestId: string, signal?: AbortSignal): Promise<{ readonly request: OperationsPrivacyRequestDetailDto; readonly correlationId: string }> {
  return requestJson(`/api/v1/operations/privacy/requests/${encodeURIComponent(requestId)}`, { token, ...(signal ? { signal } : {}) });
}

export function listRetentionHolds(token: string, signal?: AbortSignal): Promise<RetentionHoldListDto> {
  return requestJson('/api/v1/operations/privacy/holds', { token, ...(signal ? { signal } : {}) });
}

export function placeRetentionHold(
  token: string, body: { readonly subjectUserId: string; readonly reasonCode: string; readonly detail?: string },
): Promise<{ readonly placed: boolean; readonly id: string; readonly correlationId: string }> {
  return requestJson('/api/v1/operations/privacy/holds', { token, method: 'POST', body });
}

export function getConsentCoverage(token: string, signal?: AbortSignal): Promise<ConsentCoverageDto> {
  return requestJson('/api/v1/operations/privacy/consents', { token, ...(signal ? { signal } : {}) });
}
