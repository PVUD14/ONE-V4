/**
 * API client for placement-office nominations with student consent (INST-14).
 *
 * The college's placement office puts eligible students forward for one of its live campus drives;
 * each student sees who nominated them, to whom and what would be shared, and opts in or declines.
 * Nothing about a student reaches the employer unless they opt in, and opting in is an ordinary
 * application. Kept in its own file so the college and student screens share one set of types.
 */
import { requestJson } from './http.js';
import type { SuppressedCountDto } from './privacyOperations.js';
import type { SnapshotChoicesInput } from './hiring.js';
import type { CampusDriveState, VenueMode } from './campusDrives.js';

export type CollegeNominationResponse = 'OPTED_IN' | 'NOT_OPTED_IN' | 'CANCELLED' | 'CLOSED';
export type StudentNominationState = 'INVITED' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'CANCELLED' | 'CLOSED';
export type NominationEligibility = 'ELIGIBLE' | 'NOT_MET' | 'UNKNOWN';

export const nominationReasons = ['MEETS_ELIGIBILITY', 'PLACEMENT_OFFICE_SHORTLIST', 'STUDENT_EXPRESSED_INTEREST'] as const;
export const nominationCancelReasons = ['NOMINATED_IN_ERROR', 'DRIVE_CHANGED', 'STUDENT_REQUESTED'] as const;

export const collegeResponseLabels: Readonly<Record<CollegeNominationResponse, string>> = {
  OPTED_IN: 'Opted in', NOT_OPTED_IN: 'Not opted in', CANCELLED: 'Nomination withdrawn', CLOSED: 'Drive closed',
};
export const nominationEligibilityLabels: Readonly<Record<NominationEligibility, string>> = {
  ELIGIBLE: 'Eligible', NOT_MET: 'Does not meet a rule', UNKNOWN: 'Cannot confirm yet',
};
export const studentNominationLabels: Readonly<Record<StudentNominationState, string>> = {
  INVITED: 'Waiting for your answer', ACCEPTED: 'You opted in', DECLINED: 'You declined', WITHDRAWN: 'You withdrew',
  CANCELLED: 'Your college withdrew this nomination', CLOSED: 'Closed — the drive has ended',
};

export interface NominationDriveDto {
  readonly id: string;
  readonly state: CampusDriveState;
  readonly live: boolean;
  readonly opportunityTitle: string | null;
  readonly employerName: string;
}

export interface NominationCandidateDto {
  readonly studentUserId: string;
  readonly fullName: string;
  readonly institutionStudentId: string | null;
  readonly department: string | null;
  readonly batch: string | null;
  readonly eligibility: NominationEligibility;
  readonly nomination: { readonly id: string; readonly revision: number; readonly response: CollegeNominationResponse } | null;
}

export interface CollegeNominationDto {
  readonly id: string;
  readonly revision: number;
  readonly studentName: string;
  readonly institutionStudentId: string | null;
  readonly response: CollegeNominationResponse;
  readonly reasonCode: string;
  readonly nominatedByRole: string;
  readonly nominatedAt: string | null;
  readonly cancelReasonCode: string | null;
  readonly canCancel: boolean;
}

export interface CollegeNominationsDto {
  readonly drive: NominationDriveDto;
  readonly canNominate: boolean;
  readonly summary: { readonly nominated: SuppressedCountDto; readonly optedIn: SuppressedCountDto; readonly notOptedIn: SuppressedCountDto };
  readonly nominations: readonly CollegeNominationDto[];
  readonly nextCursor: string | null;
}

export interface StudentNominationDto {
  readonly id: string;
  readonly state: StudentNominationState;
  readonly institutionName: string;
  readonly nominatedBy: { readonly role: string; readonly label: string };
  readonly reasonCode: string;
  readonly note: string | null;
  readonly nominatedAt: string | null;
  readonly respondedAt: string | null;
  readonly opportunity: { readonly id: string; readonly title: string | null; readonly employerName: string; readonly applicationDeadline: string | null };
  readonly drive: { readonly state: CampusDriveState; readonly scheduledStartAt: string | null; readonly scheduledEndAt: string | null; readonly venueMode: VenueMode | null };
  readonly applicationId: string | null;
  readonly applicationState: string | null;
  readonly alreadyApplied: boolean;
  readonly canRespond: boolean;
  readonly blocksYou: boolean;
}

const driveBase = (institutionId: string, driveId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}/campus-drives/${encodeURIComponent(driveId)}`;

export function listNominationCandidates(token: string, institutionId: string, driveId: string, cursor?: string, signal?: AbortSignal): Promise<{ readonly drive: NominationDriveDto; readonly candidates: readonly NominationCandidateDto[]; readonly nextCursor: string | null }> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestJson(`${driveBase(institutionId, driveId)}/nomination-candidates${query}`, { token, ...(signal ? { signal } : {}) });
}

export function listDriveNominations(token: string, institutionId: string, driveId: string, cursor?: string, signal?: AbortSignal): Promise<CollegeNominationsDto> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestJson(`${driveBase(institutionId, driveId)}/nominations${query}`, { token, ...(signal ? { signal } : {}) });
}

export function nominateStudents(token: string, institutionId: string, driveId: string, body: { readonly studentUserIds: readonly string[]; readonly reasonCode: string; readonly note?: string }): Promise<{
  readonly created: readonly { readonly studentUserId: string; readonly nominationId: string }[];
  readonly skipped: readonly { readonly studentUserId: string; readonly code: 'ALREADY_NOMINATED' | 'NOT_ELIGIBLE' | 'NOT_IN_SCOPE' }[];
}> {
  return requestJson(`${driveBase(institutionId, driveId)}/nominations`, { token, method: 'POST', body });
}

export function cancelNomination(token: string, institutionId: string, driveId: string, nominationId: string, revision: number, reasonCode: string): Promise<{ readonly nomination: { readonly id: string } }> {
  return requestJson(`${driveBase(institutionId, driveId)}/nominations/${encodeURIComponent(nominationId)}/cancel`, { token, method: 'POST', body: { revision, reasonCode } });
}

export function listMyNominations(token: string, signal?: AbortSignal): Promise<{ readonly nominations: readonly StudentNominationDto[] }> {
  return requestJson('/api/v1/students/me/nominations', { token, ...(signal ? { signal } : {}) });
}

/** Opting in is applying: with the reviewed snapshot's hash, which the API requires for a nomination. */
export function acceptNomination(token: string, nominationId: string, input: { readonly institutionVisibilityGranted: boolean; readonly choices: SnapshotChoicesInput; readonly reviewedSnapshotHash: string }): Promise<{ readonly application: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/students/me/nominations/${encodeURIComponent(nominationId)}/accept`, {
    token, method: 'POST',
    body: { consentGranted: true, institutionVisibilityGranted: input.institutionVisibilityGranted, ...input.choices, reviewedSnapshotHash: input.reviewedSnapshotHash },
  });
}

export function declineNomination(token: string, nominationId: string): Promise<{ readonly nomination: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/students/me/nominations/${encodeURIComponent(nominationId)}/decline`, { token, method: 'POST', body: {} });
}
