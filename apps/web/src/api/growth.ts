/**
 * ONE · API client — Growth portal (GROWTH-01, ADR-040).
 *
 * The growth person's own workspace read, and the Operations → Settings "Growth team"
 * section a GROWTH_ADMIN holder uses to invite growth people, set their team, manager and
 * staff type, and end their membership. The server decides everything.
 */
import { requestJson } from './http.js';

export type GrowthRoleDto = 'GROWTH_EXECUTIVE' | 'GROWTH_MANAGER';
export type GrowthStaffTypeDto = 'EMPLOYEE' | 'CONTRACTOR';

export interface GrowthMeDto {
  readonly role: GrowthRoleDto;
  readonly staffType: GrowthStaffTypeDto | null;
  readonly teams: readonly { readonly team: string; readonly joinedAt: string; readonly manager: { readonly email: string } | null }[];
  readonly correlationId: string;
}

export function getGrowthMe(token: string, signal?: AbortSignal): Promise<GrowthMeDto> {
  return requestJson('/api/v1/growth/me', { token, ...(signal ? { signal } : {}) });
}

export interface GrowthTeamMemberDto {
  readonly membershipId: string;
  readonly email: string;
  readonly role: GrowthRoleDto;
  readonly state: string;
  readonly joinedAt: string | null;
  readonly isSelf: boolean;
  readonly staffType: { readonly staffType: GrowthStaffTypeDto; readonly effectiveFrom: string | null } | null;
  readonly teams: readonly {
    readonly team: string;
    readonly joinedAt: string | null;
    readonly reasonCode: string;
    readonly manager: { readonly membershipId: string; readonly email: string | null } | null;
  }[];
}

export interface GrowthTeamDirectoryDto {
  readonly members: readonly GrowthTeamMemberDto[];
  readonly invitations: readonly {
    readonly id: string; readonly email: string; readonly role: GrowthRoleDto; readonly staffType: GrowthStaffTypeDto;
    readonly createdAt: string | null; readonly expiresAt: string | null; readonly delivery: { readonly state: string };
  }[];
  readonly truncated: boolean;
  readonly managers: readonly { readonly membershipId: string; readonly email: string }[];
  readonly vocabulary: {
    readonly roles: readonly string[];
    readonly teams: readonly string[];
    readonly staffTypes: readonly string[];
    readonly reasons: {
      readonly joinTeam: readonly string[];
      readonly leaveTeam: readonly string[];
      readonly endMembership: readonly string[];
      readonly revokeInvitation: readonly string[];
      readonly initialStaffType: readonly string[];
      readonly changeStaffType: readonly string[];
    };
  };
  readonly correlationId: string;
}

const teamPath = '/api/v1/operations/growth-team';

export function listGrowthTeam(token: string, signal?: AbortSignal): Promise<GrowthTeamDirectoryDto> {
  return requestJson(teamPath, { token, ...(signal ? { signal } : {}) });
}

export function inviteGrowthPerson(
  token: string, body: { readonly email: string; readonly role: string; readonly staffType: string },
): Promise<{ readonly invitation: { readonly id: string; readonly state: string; readonly delivery: { readonly state: string } }; readonly correlationId: string }> {
  return requestJson(`${teamPath}/invitations`, { token, method: 'POST', body });
}

export function revokeGrowthInvitation(token: string, invitationId: string, body: { readonly reasonCode: string }): Promise<{ readonly correlationId: string }> {
  return requestJson(`${teamPath}/invitations/${encodeURIComponent(invitationId)}/revoke`, { token, method: 'POST', body });
}

export function setGrowthTeam(
  token: string, membershipId: string, body: { readonly team: string; readonly managerMembershipId: string | null; readonly reasonCode: string },
): Promise<{ readonly member: GrowthTeamMemberDto; readonly correlationId: string }> {
  return requestJson(`${teamPath}/${encodeURIComponent(membershipId)}/teams`, { token, method: 'POST', body });
}

export function endGrowthTeam(token: string, membershipId: string, team: string, body: { readonly reasonCode: string }): Promise<{ readonly member: GrowthTeamMemberDto; readonly correlationId: string }> {
  return requestJson(`${teamPath}/${encodeURIComponent(membershipId)}/teams/${encodeURIComponent(team)}/end`, { token, method: 'POST', body });
}

export function setGrowthStaffType(
  token: string, membershipId: string, body: { readonly staffType: string; readonly reasonCode: string },
): Promise<{ readonly member: GrowthTeamMemberDto; readonly correlationId: string }> {
  return requestJson(`${teamPath}/${encodeURIComponent(membershipId)}/staff-type`, { token, method: 'POST', body });
}

export function endGrowthMembership(token: string, membershipId: string, body: { readonly reasonCode: string }): Promise<{ readonly member: GrowthTeamMemberDto; readonly correlationId: string }> {
  return requestJson(`${teamPath}/${encodeURIComponent(membershipId)}/end`, { token, method: 'POST', body });
}

// ---------------------------------------------------------------------------
// GROWTH-02: territories and regions
// ---------------------------------------------------------------------------

export interface GrowthTerritoryAreaDto {
  readonly stateCode: string;
  readonly stateName: string;
  readonly districtCode: number | null;
  readonly districtName: string | null;
}

/** `GET /api/v1/growth/territory`: the regions the signed-in growth person works today. */
export interface GrowthTerritoryDto {
  readonly role: GrowthRoleDto;
  readonly regions: readonly {
    readonly id: string;
    readonly name: string;
    readonly myRole: 'EXECUTIVE' | 'MANAGER';
    readonly since: string | null;
    readonly areas: readonly GrowthTerritoryAreaDto[];
    readonly people: readonly { readonly email: string; readonly role: 'EXECUTIVE' | 'MANAGER'; readonly since: string }[];
  }[];
  readonly correlationId: string;
}

export function getGrowthTerritory(token: string, signal?: AbortSignal): Promise<GrowthTerritoryDto> {
  return requestJson('/api/v1/growth/territory', { token, ...(signal ? { signal } : {}) });
}

export interface GrowthDistrictImportReportDto {
  readonly filename: string;
  readonly fileProblems: readonly string[];
  readonly rowCount: number;
  readonly counts: { readonly new: number; readonly unchanged: number; readonly renamed: number; readonly errors: number };
  readonly rows: readonly {
    readonly line: number; readonly districtCode: number | null; readonly districtName: string | null; readonly stateCode: string | null;
    readonly status: 'NEW' | 'UNCHANGED' | 'RENAMED' | 'ERROR'; readonly issues: readonly string[]; readonly previousName?: string;
  }[];
  readonly committable: boolean;
  readonly digest: string;
}

/** `GET /api/v1/operations/growth-territories`: Operations → Settings → Growth set-up. */
export interface GrowthSetupDto {
  readonly states: readonly { readonly code: string; readonly name: string; readonly kind: 'STATE' | 'UNION_TERRITORY'; readonly districtCount: number }[];
  readonly regions: readonly {
    readonly id: string; readonly name: string; readonly createdAt: string | null; readonly reasonCode: string;
    readonly retiredAt: string | null; readonly retiredReasonCode: string | null;
    readonly areas: readonly (GrowthTerritoryAreaDto & { readonly id: string; readonly addedAt: string | null; readonly reasonCode: string })[];
    readonly assignments: readonly {
      readonly id: string; readonly membershipId: string; readonly email: string; readonly role: 'EXECUTIVE' | 'MANAGER';
      readonly startsAt: string | null; readonly reasonCode: string; readonly membershipState: string;
    }[];
  }[];
  readonly truncated: boolean;
  readonly people: readonly { readonly membershipId: string; readonly email: string; readonly role: GrowthRoleDto }[];
  readonly lastImport: {
    readonly id: string; readonly filename: string; readonly rowCount: number; readonly created: number; readonly renamed: number;
    readonly unchanged: number; readonly reasonCode: string; readonly importedAt: string | null; readonly importedBy: string;
  } | null;
  readonly vocabulary: {
    readonly assignmentRoles: readonly string[];
    readonly reasons: {
      readonly createRegion: readonly string[]; readonly retireRegion: readonly string[]; readonly addArea: readonly string[];
      readonly removeArea: readonly string[]; readonly startAssignment: readonly string[]; readonly endAssignment: readonly string[];
      readonly importDistricts: readonly string[];
    };
  };
  readonly limits: { readonly importRows: number; readonly importCharacters: number };
  readonly correlationId: string;
}

const territoryPath = '/api/v1/operations/growth-territories';

export function getGrowthSetup(token: string, signal?: AbortSignal): Promise<GrowthSetupDto> {
  return requestJson(territoryPath, { token, ...(signal ? { signal } : {}) });
}

export function listGrowthDistricts(token: string, stateCode: string, signal?: AbortSignal): Promise<{
  readonly stateCode: string; readonly districts: readonly { readonly code: number; readonly name: string; readonly region: { readonly id: string; readonly name: string } | null }[];
}> {
  return requestJson(`${territoryPath}/districts?state=${encodeURIComponent(stateCode)}`, { token, ...(signal ? { signal } : {}) });
}

export function previewGrowthDistrictImport(token: string, body: { readonly filename: string; readonly content: string }): Promise<{ readonly preview: GrowthDistrictImportReportDto }> {
  return requestJson(`${territoryPath}/district-imports/preview`, { token, method: 'POST', body });
}

export function commitGrowthDistrictImport(
  token: string, body: { readonly filename: string; readonly content: string; readonly previewDigest: string; readonly reasonCode: string },
): Promise<{ readonly import: { readonly id: string; readonly rowCount: number; readonly counts: GrowthDistrictImportReportDto['counts'] } }> {
  return requestJson(`${territoryPath}/district-imports/commit`, { token, method: 'POST', body });
}

export function createGrowthRegion(token: string, body: { readonly name: string; readonly reasonCode: string }): Promise<{ readonly region: { readonly id: string } }> {
  return requestJson(`${territoryPath}/regions`, { token, method: 'POST', body });
}

export function retireGrowthRegion(token: string, regionId: string, body: { readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/retire`, { token, method: 'POST', body });
}

export function addGrowthRegionArea(token: string, regionId: string, body: { readonly stateCode: string; readonly districtCode: number | null; readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/areas`, { token, method: 'POST', body });
}

export function removeGrowthRegionArea(token: string, regionId: string, areaId: string, body: { readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/areas/${encodeURIComponent(areaId)}/remove`, { token, method: 'POST', body });
}

export function assignGrowthTerritory(token: string, regionId: string, body: { readonly membershipId: string; readonly role: string; readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/assignments`, { token, method: 'POST', body });
}

export function endGrowthTerritoryAssignment(token: string, regionId: string, assignmentId: string, body: { readonly reasonCode: string }): Promise<unknown> {
  return requestJson(`${territoryPath}/regions/${encodeURIComponent(regionId)}/assignments/${encodeURIComponent(assignmentId)}/end`, { token, method: 'POST', body });
}
