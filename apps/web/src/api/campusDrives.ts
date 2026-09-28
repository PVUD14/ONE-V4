/**
 * API client for campus drives and college placement policies (EMP-11, ADR-038).
 *
 * Employers request a drive for a job at one college; the college's placement office approves,
 * schedules, asks for changes or declines, and sets the placement policies enforced at apply.
 * Students see the drives through the existing opportunity reads (hiring.ts). Kept in its own
 * file so both portals import one set of types.
 */
import { requestJson } from './http.js';
import type { SuppressedCountDto } from './privacyOperations.js';

export type CampusDriveState = 'REQUESTED' | 'CHANGES_REQUESTED' | 'APPROVED' | 'SCHEDULED' | 'REJECTED' | 'COMPLETED' | 'CANCELLED';
export type CampusDriveAction = 'RESUBMIT' | 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES' | 'SCHEDULE' | 'CANCEL' | 'COMPLETE';
export type VenueMode = 'ON_CAMPUS' | 'VIRTUAL' | 'OFF_CAMPUS';

export interface CampusDriveDto {
  readonly id: string;
  readonly opportunityId: string;
  readonly opportunityTitle: string | null;
  readonly opportunityState: string;
  readonly applicationDeadline: string | null;
  readonly employerName: string;
  readonly employerInGoodStanding: boolean;
  readonly institutionName: string;
  readonly state: CampusDriveState;
  readonly revision: number;
  readonly proposedStartAt: string | null;
  readonly proposedEndAt: string | null;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly venueMode: VenueMode | null;
  readonly employerNote: string | null;
  readonly offerHoldersEligible: boolean;
  readonly decision: { readonly reasonCode: string | null; readonly note: string | null; readonly decidedAt: string | null } | null;
  readonly closedAt: string | null;
  readonly closeReasonCode: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly availableActions: readonly CampusDriveAction[];
  /** Employer side only: applications that came through this drive. */
  readonly applicationCount?: number;
}

export interface CampusDriveHistoryDto {
  readonly fromState: CampusDriveState | null;
  readonly toState: CampusDriveState;
  readonly actorSide: 'EMPLOYER' | 'INSTITUTION';
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly at: string | null;
}

export interface CampusDriveResultsDto {
  readonly driveState: CampusDriveState;
  /** Null until the drive is complete. */
  readonly counts: { readonly applied: SuppressedCountDto; readonly offered: SuppressedCountDto; readonly selected: SuppressedCountDto } | null;
  readonly named: readonly { readonly fullName: string; readonly institutionStudentId: string | null; readonly applicationState: string; readonly offerState: string | null; readonly updatedAt: string | null }[];
}

export interface PlacementPolicyDto {
  readonly id: string;
  readonly policyType: 'ONE_OFFER_PER_STUDENT';
  readonly allowDriveExceptions: boolean;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly state: 'ACTIVE' | 'RETIRED';
  readonly inForce: boolean;
  readonly note: string | null;
  readonly retiredAt: string | null;
  readonly retireReasonCode: string | null;
  readonly createdAt: string | null;
}

/** What a student sees about a drive on a job (GET /opportunities/:id). */
export interface StudentCampusDriveDto {
  readonly institutionName: string;
  readonly state: CampusDriveState;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly venueMode: VenueMode | null;
  readonly offerHoldersEligible: boolean;
  readonly placementPolicy: { readonly policyType: 'ONE_OFFER_PER_STUDENT'; readonly allowDriveExceptions: boolean; readonly note: string | null } | null;
  readonly blocksYou: boolean;
}

export const campusDriveRejectReasons = ['SEASON_CLOSED', 'SCHEDULE_CONFLICT', 'ROLE_NOT_SUITABLE', 'TERMS_NOT_ACCEPTABLE', 'EMPLOYER_CONCERN', 'DUPLICATE_REQUEST'] as const;
export const campusDriveChangeReasons = ['SCHEDULE_CHANGE_NEEDED', 'ELIGIBILITY_CHANGE_NEEDED', 'TERMS_CLARIFICATION_NEEDED', 'DETAILS_MISSING'] as const;
export const campusDriveEmployerCancelReasons = ['HIRING_ON_HOLD', 'ROLE_CANCELLED', 'POSITIONS_FILLED', 'SCHEDULE_UNWORKABLE', 'REQUESTED_IN_ERROR'] as const;
export const campusDriveInstitutionCancelReasons = ['SCHEDULE_UNWORKABLE', 'SEASON_CLOSED', 'EMPLOYER_CONCERN', 'POLICY_CONFLICT'] as const;
export const placementPolicyRetireReasons = ['POLICY_CHANGED', 'SEASON_ENDED', 'SET_IN_ERROR'] as const;

export const campusDriveStateLabels: Readonly<Record<CampusDriveState, string>> = {
  REQUESTED: 'Awaiting the college', CHANGES_REQUESTED: 'Changes requested', APPROVED: 'Approved', SCHEDULED: 'Scheduled',
  REJECTED: 'Declined', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};
export const venueModeLabels: Readonly<Record<VenueMode, string>> = { ON_CAMPUS: 'On campus', VIRTUAL: 'Virtual', OFF_CAMPUS: 'Off campus' };

/** A reason code as words: SCHEDULE_CHANGE_NEEDED → "Schedule change needed". */
export function reasonLabel(code: string | null | undefined): string {
  if (!code) return 'NA';
  const words = code.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const employerBase = (employerId: string) => `/api/v1/employers/${encodeURIComponent(employerId)}`;
const institutionBase = (institutionId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}`;

export function listCampusDriveInstitutions(token: string, employerId: string, q: string, signal?: AbortSignal): Promise<{ readonly institutions: readonly { readonly id: string; readonly name: string; readonly city: string | null }[] }> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return requestJson(`${employerBase(employerId)}/campus-drive-institutions${query}`, { token, ...(signal ? { signal } : {}) });
}

export function listEmployerCampusDrives(token: string, employerId: string, opportunityId?: string, signal?: AbortSignal): Promise<{ readonly drives: readonly CampusDriveDto[] }> {
  const query = opportunityId ? `?opportunityId=${encodeURIComponent(opportunityId)}` : '';
  return requestJson(`${employerBase(employerId)}/campus-drives${query}`, { token, ...(signal ? { signal } : {}) });
}

export interface CampusDriveRequestInput {
  readonly institutionId: string;
  readonly proposedStartAt?: string;
  readonly proposedEndAt?: string;
  readonly venueMode?: VenueMode;
  readonly note?: string;
}

export function requestCampusDrive(token: string, employerId: string, opportunityId: string, body: CampusDriveRequestInput): Promise<{ readonly drive: CampusDriveDto }> {
  return requestJson(`${employerBase(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/campus-drives`, { token, method: 'POST', body });
}

export function moveEmployerCampusDrive(token: string, employerId: string, driveId: string, action: 'resubmit' | 'cancel' | 'complete', body: Record<string, unknown>): Promise<{ readonly drive: CampusDriveDto }> {
  return requestJson(`${employerBase(employerId)}/campus-drives/${encodeURIComponent(driveId)}/${action}`, { token, method: 'POST', body });
}

export function listInstitutionCampusDrives(token: string, institutionId: string, options: { readonly state?: CampusDriveState; readonly cursor?: string } = {}, signal?: AbortSignal): Promise<{ readonly drives: readonly CampusDriveDto[]; readonly canDecide: boolean; readonly nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options.state) params.set('state', options.state);
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString() ? `?${params.toString()}` : '';
  return requestJson(`${institutionBase(institutionId)}/campus-drives${query}`, { token, ...(signal ? { signal } : {}) });
}

export function moveInstitutionCampusDrive(token: string, institutionId: string, driveId: string, action: 'approve' | 'reject' | 'request-changes' | 'schedule' | 'cancel' | 'complete', body: Record<string, unknown>): Promise<{ readonly drive: CampusDriveDto }> {
  return requestJson(`${institutionBase(institutionId)}/campus-drives/${encodeURIComponent(driveId)}/${action}`, { token, method: 'POST', body });
}

export function getCampusDriveHistory(token: string, side: { readonly employerId: string } | { readonly institutionId: string }, driveId: string, signal?: AbortSignal): Promise<{ readonly history: readonly CampusDriveHistoryDto[] }> {
  const base = 'employerId' in side ? employerBase(side.employerId) : institutionBase(side.institutionId);
  return requestJson(`${base}/campus-drives/${encodeURIComponent(driveId)}/history`, { token, ...(signal ? { signal } : {}) });
}

export function getCampusDriveResults(token: string, institutionId: string, driveId: string, signal?: AbortSignal): Promise<{ readonly results: CampusDriveResultsDto }> {
  return requestJson(`${institutionBase(institutionId)}/campus-drives/${encodeURIComponent(driveId)}/results`, { token, ...(signal ? { signal } : {}) });
}

export function listPlacementPolicies(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly policies: readonly PlacementPolicyDto[]; readonly canManage: boolean }> {
  return requestJson(`${institutionBase(institutionId)}/placement-policies`, { token, ...(signal ? { signal } : {}) });
}

export function setPlacementPolicy(token: string, institutionId: string, body: { readonly policyType: 'ONE_OFFER_PER_STUDENT'; readonly allowDriveExceptions?: boolean; readonly note?: string }): Promise<{ readonly policy: { readonly id: string } }> {
  return requestJson(`${institutionBase(institutionId)}/placement-policies`, { token, method: 'POST', body });
}

export function retirePlacementPolicy(token: string, institutionId: string, policyId: string, reasonCode: typeof placementPolicyRetireReasons[number]): Promise<{ readonly policy: { readonly id: string } }> {
  return requestJson(`${institutionBase(institutionId)}/placement-policies/${encodeURIComponent(policyId)}/retire`, { token, method: 'POST', body: { reasonCode } });
}
