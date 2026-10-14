/**
 * API client for the placement register, placement statistics and drive categories (INST-12).
 *
 * Statistics are a month-end stock over applications students shared with the college, each count
 * suppressed under five by the server; the register lists engaged employers and the drive calendar;
 * categories are the college's own labels for its drives (never shown to employers or students).
 * The server decides scope and suppression; nothing here counts or filters for security.
 */
import { requestJson } from './http.js';
import type { SuppressedCountDto } from './privacyOperations.js';
import type { CampusDriveState, VenueMode } from './campusDrives.js';
import type { InstitutionStudentScopeDto } from './institution.js';

export interface PlacementStatisticsRowDto {
  readonly eligible: SuppressedCountDto;
  readonly notShared: SuppressedCountDto;
  readonly applied: SuppressedCountDto;
  readonly shortlisted: SuppressedCountDto;
  readonly withOffer: SuppressedCountDto;
  readonly placed: SuppressedCountDto;
  readonly placementPercentage: number | null;
  readonly offersPerPlacedStudent: number | null;
}

export interface PlacementStatisticsDto {
  readonly asOf: { readonly month: string; readonly lastDay: string };
  readonly scope?: InstitutionStudentScopeDto;
  readonly overall: PlacementStatisticsRowDto;
  readonly groups: readonly (PlacementStatisticsRowDto & {
    readonly department: { readonly id: string; readonly name: string } | null;
    readonly batch: { readonly id: string; readonly name: string } | null;
  })[];
  readonly offersByMonth: readonly { readonly month: string; readonly offers: SuppressedCountDto }[];
}

export interface DriveCategoryRefDto {
  readonly id: string;
  readonly name: string;
  readonly retired: boolean;
}

export interface PlacementRegisterDto {
  readonly employers: readonly {
    readonly name: string;
    readonly drives: { readonly approved: number; readonly scheduled: number; readonly completed: number };
    readonly jobsAddressedToCollege: number;
    readonly lastEngagedAt: string | null;
  }[];
  readonly drives: readonly {
    readonly id: string;
    readonly employerName: string;
    readonly opportunityTitle: string | null;
    readonly state: CampusDriveState;
    readonly scheduledStartAt: string | null;
    readonly scheduledEndAt: string | null;
    readonly proposedStartAt: string | null;
    readonly venueMode: VenueMode | null;
    readonly closedAt: string | null;
    readonly category: DriveCategoryRefDto | null;
    readonly outcome: { readonly studentsSharing: SuppressedCountDto; readonly withOffer: SuppressedCountDto; readonly placed: SuppressedCountDto } | null;
  }[];
}

export interface DriveCategoryDto {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly rank: number;
  readonly state: 'ACTIVE' | 'RETIRED';
  readonly createdAt: string | null;
  readonly retiredAt: string | null;
  readonly retireReasonCode: string | null;
}

export const driveCategoryRetireReasons = ['NO_LONGER_USED', 'RENAMED', 'SET_IN_ERROR'] as const;

const institutionBase = (institutionId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}`;

export function getPlacementStatistics(token: string, institutionId: string, signal?: AbortSignal): Promise<PlacementStatisticsDto> {
  return requestJson(`${institutionBase(institutionId)}/placement-statistics`, { token, ...(signal ? { signal } : {}) });
}

export function getPlacementRegister(token: string, institutionId: string, signal?: AbortSignal): Promise<PlacementRegisterDto> {
  return requestJson(`${institutionBase(institutionId)}/placement-register`, { token, ...(signal ? { signal } : {}) });
}

export function listDriveCategories(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly categories: readonly DriveCategoryDto[]; readonly canManage: boolean }> {
  return requestJson(`${institutionBase(institutionId)}/drive-categories`, { token, ...(signal ? { signal } : {}) });
}

export function createDriveCategory(token: string, institutionId: string, body: { readonly name: string; readonly description?: string; readonly rank?: number }): Promise<{ readonly category: { readonly id: string } }> {
  return requestJson(`${institutionBase(institutionId)}/drive-categories`, { token, method: 'POST', body });
}

export function retireDriveCategory(token: string, institutionId: string, categoryId: string, reasonCode: typeof driveCategoryRetireReasons[number]): Promise<{ readonly category: { readonly id: string } }> {
  return requestJson(`${institutionBase(institutionId)}/drive-categories/${encodeURIComponent(categoryId)}/retire`, { token, method: 'POST', body: { reasonCode } });
}

export function setCampusDriveCategory(token: string, institutionId: string, driveId: string, categoryId: string | null): Promise<{ readonly category: DriveCategoryRefDto | null }> {
  return requestJson(`${institutionBase(institutionId)}/campus-drives/${encodeURIComponent(driveId)}/category`, { token, method: 'POST', body: { categoryId } });
}
