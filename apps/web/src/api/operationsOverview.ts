/**
 * ONE · API client — the Operations Overview summary (OPS-03).
 *
 * One request returns every Overview count, computed server-side in bounded SQL. A
 * section the caller's capabilities do not cover arrives as null and renders NA. Its own
 * file keeps the parallel OPS goals out of each other's way; api.ts re-exports it.
 */
import { requestJson } from './http.js';

export interface OverviewCountDto {
  readonly value: number;
  /** True when there are more than `value` rows; `value` is then the cap. */
  readonly capped: boolean;
}

/** A count of people: below 5 it is suppressed and carries no value. */
export type OverviewPeopleCountDto =
  | { readonly suppressed: true; readonly value: null; readonly capped: false }
  | { readonly suppressed: false; readonly value: number; readonly capped: boolean };

export type OverviewVerificationState = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';

export interface OverviewOrganizationKindDto {
  readonly total: OverviewCountDto;
  readonly byVerification: Readonly<Record<OverviewVerificationState, OverviewCountDto>>;
}

export interface OperationsOverviewDto {
  readonly generatedAt: string;
  readonly organizations: {
    readonly total: OverviewCountDto;
    readonly active: OverviewCountDto;
    readonly institutions: OverviewOrganizationKindDto;
    readonly employers: OverviewOrganizationKindDto;
    readonly recent: readonly { readonly id: string; readonly kind: 'INSTITUTION' | 'EMPLOYER'; readonly name: string; readonly verificationState: OverviewVerificationState; readonly active: boolean }[];
  } | null;
  readonly verification: { readonly awaitingDecision: OverviewCountDto; readonly underReview: OverviewCountDto } | null;
  readonly employerAccessRequests: { readonly pending: OverviewCountDto; readonly oldestPendingAt: string | null } | null;
  readonly invitations: {
    readonly staff: {
      readonly total: OverviewCountDto;
      readonly accepted: OverviewCountDto;
      readonly pending: OverviewCountDto;
      readonly pendingOver72Hours: OverviewCountDto;
      readonly expiredUnaccepted: OverviewCountDto;
    };
    readonly expiringSoon: readonly { readonly id: string; readonly role: string | null; readonly organizationName: string | null; readonly expiresAt: string }[];
    readonly recent: readonly { readonly id: string; readonly role: string | null; readonly organizationName: string | null; readonly state: string; readonly createdAt: string }[];
    readonly student: {
      readonly pending: OverviewCountDto;
      readonly pendingOver72Hours: OverviewCountDto;
      readonly notDelivered: OverviewCountDto;
      readonly byDelivery: Readonly<Record<'NOT_SENT' | 'SENT' | 'FAILED' | 'BOUNCED' | 'NOT_CONFIGURED', OverviewCountDto>>;
    };
  } | null;
  readonly accounts: {
    readonly total: OverviewPeopleCountDto;
    readonly students: OverviewPeopleCountDto;
    readonly withOrganizationRoles: OverviewPeopleCountDto;
  } | null;
  readonly trustSafety: {
    readonly open: OverviewCountDto;
    readonly unassigned: OverviewCountDto;
    readonly bySeverity: Readonly<Record<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW', OverviewCountDto>>;
  } | null;
  readonly jobs: { readonly failedEvents: OverviewCountDto; readonly openAlerts: OverviewCountDto } | null;
  readonly privacyRequests: {
    readonly open: OverviewCountDto;
    readonly openExports: OverviewCountDto;
    readonly openDeletions: OverviewCountDto;
    readonly deletionsDueWithin7Days: OverviewCountDto;
    readonly failed: OverviewCountDto;
  } | null;
  readonly privacyHolds: { readonly active: OverviewCountDto } | null;
  readonly approvals: { readonly pending: OverviewCountDto; readonly awaitingExecution: OverviewCountDto } | null;
  readonly support: { readonly open: OverviewCountDto; readonly overdue: OverviewCountDto; readonly unassigned: OverviewCountDto } | null;
}

export interface OperationsOverviewResponseDto {
  readonly overview: OperationsOverviewDto;
  readonly viewer: { readonly sections: readonly string[] };
  readonly correlationId: string;
}

export function getOperationsOverview(token: string, signal?: AbortSignal): Promise<OperationsOverviewResponseDto> {
  return requestJson('/api/v1/operations/overview', { token, ...(signal ? { signal } : {}) });
}
