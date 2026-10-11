/**
 * Growth roles and who may administer growth people (GROWTH-01, ADR-040).
 *
 * The Growth portal's field staff are ACTIVE memberships of the ONE platform organisation
 * with a growth login role. ADR-040 decision 2: those roles start from no authority and can
 * never be given any — they are not platform internal roles, so `internal-capabilities.ts`
 * gives them no baseline and refuses every grant. What growth people may do is decided by
 * growth rules (their own leads, territory and team), which later goals add here.
 *
 * The operator side (GROWTH_ADMIN, GROWTH_FINANCE) is ordinary capability work and lives in
 * `internal-capabilities.ts`.
 */
import { hasInternalCapability, platformInternalRoles, type InternalCapabilityContext } from './internal-capabilities.js';

export const growthRoles = ['GROWTH_EXECUTIVE', 'GROWTH_MANAGER'] as const;
export type GrowthRole = (typeof growthRoles)[number];

/** The two field teams (design §3.3). A person may be on both. */
export const growthTeams = ['COLLEGE_PARTNERSHIPS', 'EMPLOYER_PARTNERSHIPS'] as const;
export type GrowthTeam = (typeof growthTeams)[number];

/** D13: how a growth person is engaged. ONE records it; it computes no tax for either. */
export const growthStaffTypes = ['EMPLOYEE', 'CONTRACTOR'] as const;
export type GrowthStaffType = (typeof growthStaffTypes)[number];

/**
 * Staff-only roles for the staff identity pool policy (ADR-025, OPS-07): once the MFA-required
 * staff pool exists, these count only from it. Growth field staff are AI8HT staff (design §3.2).
 */
export const platformStaffOnlyRoles: readonly string[] = [...platformInternalRoles, ...growthRoles];

/** Reason codes, defined in code so the audit trail is comparable (never free text). */
export const growthTeamReasons = {
  joinTeam: ['NEW_MEMBER', 'TEAM_CHANGE', 'MANAGER_CHANGE', 'CORRECTION'],
  leaveTeam: ['LEFT_TEAM', 'TEAM_CHANGE', 'CORRECTION'],
  endMembership: ['LEFT_AI8HT', 'ACCESS_NO_LONGER_NEEDED', 'SECURITY_CONCERN', 'CORRECTION'],
  revokeInvitation: ['SENT_IN_ERROR', 'WRONG_EMAIL', 'WRONG_ROLE', 'NO_LONGER_NEEDED'],
  initialStaffType: ['INITIAL_TYPE'],
  changeStaffType: ['ENGAGEMENT_CHANGED', 'CORRECTION'],
} as const;

export function isGrowthRole(role: string): role is GrowthRole {
  return (growthRoles as readonly string[]).includes(role);
}

export function isGrowthTeam(value: unknown): value is GrowthTeam {
  return typeof value === 'string' && (growthTeams as readonly string[]).includes(value);
}

export function isGrowthStaffType(value: unknown): value is GrowthStaffType {
  return typeof value === 'string' && (growthStaffTypes as readonly string[]).includes(value);
}

/**
 * The growth workspace a person opens, or null. Only ACTIVE memberships count; a person who is
 * both a manager and an executive works as the manager.
 */
export function growthWorkspaceRole(memberships: readonly { readonly role: string; readonly state: string }[]): GrowthRole | null {
  const active = memberships.filter((membership) => membership.state === 'ACTIVE' && isGrowthRole(membership.role));
  if (active.some((membership) => membership.role === 'GROWTH_MANAGER')) return 'GROWTH_MANAGER';
  return active.length ? 'GROWTH_EXECUTIVE' : null;
}

export type GrowthAdministrationRefusal =
  | 'FORBIDDEN'
  | 'GROWTH_SELF_CHANGE_REFUSED'
  | 'GROWTH_NOT_A_GROWTH_MEMBERSHIP'
  | 'MEMBERSHIP_NOT_ACTIVE';

/** Whether the caller may administer growth people at all (invite, list, revoke). */
export function canAdministerGrowthTeam(actor: InternalCapabilityContext): boolean {
  return hasInternalCapability(actor, 'GROWTH_ADMIN');
}

/**
 * Whether a GROWTH_ADMIN holder may change this membership's team, manager, staff type or
 * state. Returns the refusal, or null when allowed. Nobody administers their own growth
 * membership; the database repeats that rule for team rows and staff types.
 */
export function refuseGrowthTeamChange(input: {
  readonly actor: InternalCapabilityContext & { readonly userId: string };
  readonly target: { readonly userId: string; readonly role: string; readonly state: string; readonly organizationKind: string };
}): GrowthAdministrationRefusal | null {
  if (!canAdministerGrowthTeam(input.actor)) return 'FORBIDDEN';
  if (input.actor.userId === input.target.userId) return 'GROWTH_SELF_CHANGE_REFUSED';
  if (input.target.organizationKind !== 'PLATFORM' || !isGrowthRole(input.target.role)) return 'GROWTH_NOT_A_GROWTH_MEMBERSHIP';
  if (input.target.state !== 'ACTIVE') return 'MEMBERSHIP_NOT_ACTIVE';
  return null;
}
