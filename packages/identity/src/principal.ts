import type { IdentityTokenVerifier, VerifiedIdentityToken } from './cognito.js';

export type InternalAccountState = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DELETION_PENDING' | 'DELETED';
export type MembershipState = 'ACTIVE' | 'SUSPENDED' | 'ENDED';

export class AuthenticationBoundaryError extends Error {
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN';
  readonly publicMessage = 'Access denied';

  constructor(code: 'UNAUTHENTICATED' | 'FORBIDDEN') {
    super('Access denied');
    this.code = code;
  }
}

export interface InternalUserIdentity {
  readonly id: string;
  readonly externalSubject: string;
  readonly state: InternalAccountState;
}

export interface InternalMembershipIdentity {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly state: MembershipState;
  readonly scope: {
    readonly organizationId: string;
    readonly institutionId?: string;
    readonly departmentId?: string;
    readonly batchId?: string;
    readonly employerId?: string;
  };
}

export interface InternalIdentityStore {
  findByExternalSubject(externalSubject: string): Promise<InternalUserIdentity | null>;
  loadActiveMembershipsForUser?(userId: string): Promise<readonly InternalMembershipIdentity[]>;
}

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly externalSubject: string;
}

export interface RequestAuthorizationContext {
  readonly principal: AuthenticatedPrincipal;
  readonly verifiedIdentity: VerifiedIdentityToken;
  readonly memberships: readonly InternalMembershipIdentity[];
  readonly selectedMembership?: InternalMembershipIdentity;
}

export interface AuthorizationContextRequest {
  readonly requestedOrganizationId?: string;
}

export async function resolveAuthenticatedPrincipal(
  rawAccessToken: string,
  verifier: IdentityTokenVerifier,
  store: InternalIdentityStore,
): Promise<AuthenticatedPrincipal> {
  const context = await resolveAuthorizationContext(rawAccessToken, verifier, store);
  return context.principal;
}

export async function resolveAuthorizationContext(
  rawAccessToken: string,
  verifier: IdentityTokenVerifier,
  store: InternalIdentityStore,
  request: AuthorizationContextRequest = {},
): Promise<RequestAuthorizationContext> {
  let token: VerifiedIdentityToken;
  try {
    token = await verifier.verifyAccessToken(rawAccessToken);
  } catch {
    throw new AuthenticationBoundaryError('UNAUTHENTICATED');
  }

  const user = await store.findByExternalSubject(token.externalSubject);
  if (!user || user.state !== 'ACTIVE') {
    throw new AuthenticationBoundaryError('FORBIDDEN');
  }

  const memberships = (await store.loadActiveMembershipsForUser?.(user.id) ?? [])
    .filter((membership) => membership.userId === user.id && membership.state === 'ACTIVE');

  const selectedMembership = request.requestedOrganizationId
    ? requireActiveMembershipForOrganization(memberships, request.requestedOrganizationId)
    : undefined;

  return {
    principal: { userId: user.id, externalSubject: user.externalSubject },
    verifiedIdentity: token,
    memberships,
    ...(selectedMembership ? { selectedMembership } : {}),
  };
}

export function requireActiveMembershipForOrganization(
  memberships: readonly InternalMembershipIdentity[],
  requestedOrganizationId: string,
): InternalMembershipIdentity {
  const membership = memberships.find((candidate) => (
    candidate.organizationId === requestedOrganizationId
    && candidate.scope.organizationId === requestedOrganizationId
    && candidate.state === 'ACTIVE'
  ));
  if (!membership) throw new AuthenticationBoundaryError('FORBIDDEN');
  return membership;
}

export function hasScopedRole(
  context: RequestAuthorizationContext,
  input: { readonly organizationId: string; readonly roles: readonly string[] },
): boolean {
  return context.memberships.some((membership) => (
    membership.organizationId === input.organizationId
    && membership.scope.organizationId === input.organizationId
    && membership.state === 'ACTIVE'
    && input.roles.includes(membership.role)
  ));
}
