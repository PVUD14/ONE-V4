/**
 * Internal operator capabilities (ADR-032, OPS-01).
 *
 * The three platform roles each carry a baseline bundle of named capabilities, held
 * here as data; anything beyond a baseline is an explicit grant stored in
 * `membership_capabilities`. Controllers ask "does this caller hold capability X?"
 * through these pure functions and never name a role, so separating a duty later is a
 * data change here rather than an edit to every controller.
 *
 * Baselines preserve exactly what the code allowed before OPS-01; where the plan's
 * table (Appendix 1 §6.2) disagrees, the code wins and the divergence is recorded in
 * docs/architecture/internal-capabilities-table-design.md as a tighten-later item.
 */

export const internalCapabilities = [
  'OPS_ORG_MANAGE',
  'OPS_VERIFY',
  'OPS_FLAGS_MANAGE',
  'OPS_JOBS_REPLAY',
  'SUPPORT_CASES',
  'SUPPORT_ACCOUNT_LOOKUP',
  'TRUST_SAFETY_INVESTIGATE',
  'TRUST_SAFETY_ENFORCE',
  'PRIVACY_REQUESTS',
  'PRIVACY_HOLDS',
  'SECURITY_AUDIT_SEARCH',
  'SECURITY_ACCESS_REVIEW',
  'INCIDENT_MANAGE',
  'CATALOGUE_MANAGE',
  'CONTENT_EDIT',
  'CONTENT_REVIEW',
  'CONTENT_PUBLISH',
  'CONTENT_REVIEW_EXTERNAL',
  'AI_OPS_VIEW',
  'AI_OPS_CONFIGURE',
  'ANALYTICS_VIEW',
  'ACCOUNT_MANAGE',
  'COMMS_TEMPLATES',
  'CAPABILITY_ADMIN',
  'APPROVE_HIGH_RISK',
] as const;

export type InternalCapability = (typeof internalCapabilities)[number];

/** Section 5.4: granting any of these is a high-risk action (dual control arrives with OPS-02). */
export const highRiskInternalCapabilities = [
  'APPROVE_HIGH_RISK',
  'CAPABILITY_ADMIN',
  'PRIVACY_HOLDS',
  'TRUST_SAFETY_ENFORCE',
  'CONTENT_PUBLISH',
  'AI_OPS_CONFIGURE',
] as const satisfies readonly InternalCapability[];

export const platformInternalRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'] as const;
export type PlatformInternalRole = (typeof platformInternalRoles)[number];

/** OPS-10: the one internal capability that may sit on an institution membership. */
export const externalContentReviewerRoles = ['FACULTY_LECTURER', 'DEPARTMENT_HEAD'] as const;

const operationsAdminBaseline = [
  'OPS_ORG_MANAGE',
  'OPS_VERIFY',
  'OPS_FLAGS_MANAGE',
  'OPS_JOBS_REPLAY',
  'SUPPORT_CASES',
  'SUPPORT_ACCOUNT_LOOKUP',
  'TRUST_SAFETY_INVESTIGATE',
  'TRUST_SAFETY_ENFORCE',
  'PRIVACY_REQUESTS',
  'PRIVACY_HOLDS',
  'SECURITY_AUDIT_SEARCH',
  'AI_OPS_VIEW',
  'ANALYTICS_VIEW',
  'ACCOUNT_MANAGE',
  'COMMS_TEMPLATES',
] as const satisfies readonly InternalCapability[];

const securityAdminBaseline = [
  // D1: §6.2 lists flags for OPERATIONS_ADMIN only, but feature flags have always been
  // guarded by the audit-search role family, which includes Security. Preserved.
  'OPS_FLAGS_MANAGE',
  'OPS_JOBS_REPLAY',
  'SUPPORT_ACCOUNT_LOOKUP',
  'TRUST_SAFETY_INVESTIGATE',
  'TRUST_SAFETY_ENFORCE',
  'PRIVACY_REQUESTS',
  'PRIVACY_HOLDS',
  'SECURITY_AUDIT_SEARCH',
  'SECURITY_ACCESS_REVIEW',
  'INCIDENT_MANAGE',
  'AI_OPS_VIEW',
] as const satisfies readonly InternalCapability[];

const superAdminBaseline: readonly InternalCapability[] = [
  ...new Set<InternalCapability>([
    ...operationsAdminBaseline,
    ...securityAdminBaseline,
    'CAPABILITY_ADMIN',
    'APPROVE_HIGH_RISK',
  ]),
];

/** Baseline bundles: what each platform role holds without any grant. */
export const internalCapabilityBaselines: Readonly<Record<PlatformInternalRole, readonly InternalCapability[]>> = {
  PLATFORM_SUPER_ADMIN: superAdminBaseline,
  OPERATIONS_ADMIN: operationsAdminBaseline,
  SECURITY_ADMIN: securityAdminBaseline,
};

/**
 * The super admin keeps every capability (§5.1), but the ones no role holds by
 * default are break-glass: their use is to be audited as such, so they are reported
 * separately rather than folded into the baseline.
 */
export const superAdminBreakGlassCapabilities: readonly InternalCapability[] = internalCapabilities.filter(
  (capability) => capability !== 'CONTENT_REVIEW_EXTERNAL' && !superAdminBaseline.includes(capability),
);

export type MembershipStateValue = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'ENDED';

export interface InternalCapabilityMembership {
  readonly role: string;
  readonly state: MembershipStateValue | string;
  /** Live (unrevoked) capability grants on this membership. Unknown strings are ignored. */
  readonly grants?: readonly string[];
}

export interface InternalCapabilityContext {
  readonly memberships: readonly InternalCapabilityMembership[];
}

export type InternalCapabilitySource = 'BASELINE' | 'GRANT' | 'BREAK_GLASS';

export function isInternalCapability(value: unknown): value is InternalCapability {
  return typeof value === 'string' && (internalCapabilities as readonly string[]).includes(value);
}

export function isHighRiskInternalCapability(capability: InternalCapability): boolean {
  return (highRiskInternalCapabilities as readonly InternalCapability[]).includes(capability);
}

export function isPlatformInternalRole(role: string): role is PlatformInternalRole {
  return (platformInternalRoles as readonly string[]).includes(role);
}

export function baselineInternalCapabilities(role: string): readonly InternalCapability[] {
  return isPlatformInternalRole(role) ? internalCapabilityBaselines[role] : [];
}

/**
 * Whether a grant of this capability is meaningful on a membership with this role.
 * Mirrors the database trigger: a grant row on the wrong kind of membership is
 * necessary-but-never-sufficient, exactly like `canReadInstitutionAnalytics`.
 */
export function isInternalCapabilityGrantableToRole(capability: InternalCapability, role: string): boolean {
  if (capability === 'CONTENT_REVIEW_EXTERNAL') return (externalContentReviewerRoles as readonly string[]).includes(role);
  return isPlatformInternalRole(role);
}

/**
 * Where a membership's authority for one capability comes from, or null when it has
 * none. The caller is responsible for the membership being ACTIVE; `hasInternalCapability`
 * does that check.
 */
function sourceForRole(role: string, grants: readonly string[], capability: InternalCapability): InternalCapabilitySource | null {
  if (baselineInternalCapabilities(role).includes(capability)) return 'BASELINE';
  if (grants.includes(capability) && isInternalCapabilityGrantableToRole(capability, role)) return 'GRANT';
  if (role === 'PLATFORM_SUPER_ADMIN' && superAdminBreakGlassCapabilities.includes(capability)) return 'BREAK_GLASS';
  return null;
}

/**
 * Every capability an ACTIVE membership with this role and these live grants holds —
 * baseline, grants valid for the role, and the super admin's break-glass set.
 */
export function effectiveInternalCapabilities(role: string, grants: readonly string[] = []): readonly InternalCapability[] {
  return internalCapabilities.filter((capability) => sourceForRole(role, grants, capability) !== null);
}

/**
 * The strongest source across the caller's ACTIVE memberships: a baseline beats a
 * grant, and a grant beats break-glass, so an ordinary use is never mislabelled as
 * break-glass merely because the caller also happens to be a super admin.
 */
export function resolveInternalCapability(context: InternalCapabilityContext, capability: InternalCapability): InternalCapabilitySource | null {
  let best: InternalCapabilitySource | null = null;
  for (const membership of context.memberships) {
    if (membership.state !== 'ACTIVE') continue;
    const source = sourceForRole(membership.role, membership.grants ?? [], capability);
    if (source === 'BASELINE') return source;
    if (source === 'GRANT' || (source === 'BREAK_GLASS' && best === null)) best = source;
  }
  return best;
}

/** Only ACTIVE memberships count. Pending, suspended or ended memberships hold nothing. */
export function hasInternalCapability(context: InternalCapabilityContext, capability: InternalCapability): boolean {
  return resolveInternalCapability(context, capability) !== null;
}

/** Reason codes an operator may give for a grant or a revoke (§5.3: defined in code, not free text). */
export const internalCapabilityGrantReasons = [
  'NEW_RESPONSIBILITY',
  'TEMPORARY_COVER',
  'ACCESS_REVIEW_OUTCOME',
  'CORRECTION',
] as const;

export const internalCapabilityRevokeReasons = [
  'RESPONSIBILITY_ENDED',
  'ACCESS_REVIEW_OUTCOME',
  'LEAVER',
  'SECURITY_INCIDENT',
  'CORRECTION',
] as const;

export interface InternalCapabilityChangeInput {
  readonly actor: InternalCapabilityContext & { readonly userId: string };
  readonly target: {
    readonly userId: string;
    readonly role: string;
    readonly state: MembershipStateValue | string;
    readonly organizationKind: string;
    readonly grants: readonly string[];
  };
  readonly capability: InternalCapability;
}

export type InternalCapabilityChangeRefusal =
  | 'FORBIDDEN'
  | 'CAPABILITY_SELF_CHANGE_REFUSED'
  | 'CAPABILITY_NOT_GRANTABLE_HERE'
  | 'CAPABILITY_ROLE_NOT_ELIGIBLE'
  | 'MEMBERSHIP_NOT_ACTIVE'
  | 'CAPABILITY_ALREADY_HELD'
  | 'HIGH_RISK_GRANT_REQUIRES_SUPER_ADMIN'
  | 'CAPABILITY_NOT_GRANTED';

function isActiveSuperAdmin(context: InternalCapabilityContext): boolean {
  return context.memberships.some((membership) => membership.state === 'ACTIVE' && membership.role === 'PLATFORM_SUPER_ADMIN');
}

/**
 * Whether a staff grant through the Operations Settings screen may proceed. Returns the
 * refusal code, or null when allowed. The database trigger repeats the eligibility and
 * self-grant rules so a second writer cannot skip them.
 */
export function refuseInternalCapabilityGrant(input: InternalCapabilityChangeInput): InternalCapabilityChangeRefusal | null {
  if (!hasInternalCapability(input.actor, 'CAPABILITY_ADMIN')) return 'FORBIDDEN';
  if (input.actor.userId === input.target.userId) return 'CAPABILITY_SELF_CHANGE_REFUSED';
  // Faculty review is granted from the institution side (OPS-10), never from here.
  if (input.capability === 'CONTENT_REVIEW_EXTERNAL') return 'CAPABILITY_NOT_GRANTABLE_HERE';
  if (input.target.organizationKind !== 'PLATFORM' || !isPlatformInternalRole(input.target.role)) return 'CAPABILITY_ROLE_NOT_ELIGIBLE';
  if (input.target.state !== 'ACTIVE') return 'MEMBERSHIP_NOT_ACTIVE';
  if (effectiveInternalCapabilities(input.target.role, input.target.grants).includes(input.capability)) return 'CAPABILITY_ALREADY_HELD';
  // Until OPS-02's approvals exist, a second person cannot be required; the interim
  // safeguard is that only the break-glass role may hand out high-risk authority.
  if (isHighRiskInternalCapability(input.capability) && !isActiveSuperAdmin(input.actor)) return 'HIGH_RISK_GRANT_REQUIRES_SUPER_ADMIN';
  return null;
}

/** Revoking removes authority, so it needs CAPABILITY_ADMIN but not a super admin. */
export function refuseInternalCapabilityRevoke(input: InternalCapabilityChangeInput): InternalCapabilityChangeRefusal | null {
  if (!hasInternalCapability(input.actor, 'CAPABILITY_ADMIN')) return 'FORBIDDEN';
  if (input.actor.userId === input.target.userId) return 'CAPABILITY_SELF_CHANGE_REFUSED';
  if (input.target.organizationKind !== 'PLATFORM' || !isPlatformInternalRole(input.target.role)) return 'CAPABILITY_ROLE_NOT_ELIGIBLE';
  if (!input.target.grants.includes(input.capability)) return 'CAPABILITY_NOT_GRANTED';
  return null;
}
