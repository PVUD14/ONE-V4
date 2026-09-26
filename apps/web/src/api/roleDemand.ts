/**
 * ONE · API client — Operations → Analytics: role demand (OPS-11).
 *
 * One bounded summary and a per-role drill-down. Every count of people arrives already
 * suppressed by the server: below 5 it carries no value, and a cell withheld only to stop
 * subtraction is marked `complementary`. Its own file keeps the parallel OPS goals out of
 * each other's way; api.ts re-exports it.
 */
import { requestJson } from './http.js';

/** A count of people: below 5 it is suppressed and carries no value. */
export type RoleDemandPeopleCountDto =
  | { readonly suppressed: true; readonly value: null }
  | { readonly suppressed: false; readonly value: number };

export type RolePromotionStatusDto = 'MEETS' | 'NOT_MET' | 'NOT_APPLICABLE';

export interface RoleDemandRoleDto {
  readonly id: string;
  readonly code: string;
  readonly catalogueCode: string | null;
  readonly title: string;
  readonly family: string;
  readonly catalogueFamily: string | null;
  readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | null;
  readonly plannedRelease: 'V1' | 'V2' | 'V3' | null;
  readonly active: boolean;
  readonly students: RoleDemandPeopleCountDto;
  /** Withheld (null) whenever the student count is suppressed. */
  readonly colleges: number | null;
  readonly promotion: { readonly status: RolePromotionStatusDto; readonly studentArmMet: boolean | null; readonly employerArm: 'NOT_RECORDED' };
}

export interface RoleDemandCellDto {
  readonly label: string;
  readonly students: RoleDemandPeopleCountDto;
  readonly complementary: boolean;
}

export interface RoleDemandSummaryDto {
  readonly generatedAt: string;
  readonly totals: {
    readonly studentsWithTarget: RoleDemandPeopleCountDto;
    readonly roles: number;
    readonly catalogueRoles: number;
    readonly rolesMeetingPromotionRule: number;
  };
  readonly roles: readonly RoleDemandRoleDto[];
  readonly rolesCapped: boolean;
  readonly byReleaseLabel: readonly (RoleDemandCellDto & { readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | 'NONE'; readonly roles: number })[];
  readonly trend: readonly { readonly month: string; readonly students: RoleDemandPeopleCountDto }[];
  readonly employerDemand: { readonly available: false; readonly reason: 'NO_ROLE_MAPPING' };
}

export interface RolePromotionRuleDto {
  readonly minimumStudents: number;
  readonly minimumColleges: number;
  readonly employerArm: 'NOT_RECORDED';
}

export interface RoleDemandSummaryResponseDto {
  readonly demand: RoleDemandSummaryDto;
  readonly promotionRule: RolePromotionRuleDto;
  readonly correlationId: string;
}

export interface RoleDemandCollegeDto extends RoleDemandCellDto {
  readonly departments: readonly RoleDemandCellDto[] | null;
  readonly departmentsCapped: boolean;
}

export interface RoleDemandDetailResponseDto {
  readonly detail: {
    readonly role: RoleDemandRoleDto;
    readonly colleges: readonly RoleDemandCollegeDto[] | null;
    readonly collegesCapped: boolean;
  };
  readonly promotionRule: RolePromotionRuleDto;
  readonly correlationId: string;
}

export function getRoleDemandSummary(token: string, signal?: AbortSignal): Promise<RoleDemandSummaryResponseDto> {
  return requestJson('/api/v1/operations/analytics/role-demand', { token, ...(signal ? { signal } : {}) });
}

export function getRoleDemandDetail(token: string, roleId: string, signal?: AbortSignal): Promise<RoleDemandDetailResponseDto> {
  return requestJson(`/api/v1/operations/analytics/role-demand/roles/${encodeURIComponent(roleId)}`, { token, ...(signal ? { signal } : {}) });
}
