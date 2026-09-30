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
