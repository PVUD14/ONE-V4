import { createHash, randomUUID } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthenticationBoundaryError,
  hasScopedRole,
  resolveAuthorizationContext,
  type InternalIdentityStore,
  type InternalMembershipIdentity,
  type RequestAuthorizationContext,
} from '@planthepath/identity/src/principal.js';
import {
  extractBearerToken,
  type IdentityTokenVerifier,
  type VerifiedIdentityToken,
} from '@planthepath/identity/src/cognito.js';
import {
  digestInvitationToken,
  requireVerifiedRecipientEmail,
} from '@planthepath/identity/src/invitation-token.js';
import {
  acceptInvitationByTokenHashForVerifiedRecipientWithIdempotency,
} from '@planthepath/persistence/src/identity-authentication.js';
import {
  assertEmployerApplicantAccessForAuthenticatedPrincipal,
} from '@planthepath/persistence/src/employer-authentication.js';
import {
  hasInstitutionRelationshipAuthorizationForActivity,
  type PersistenceDb,
} from '@planthepath/persistence/src/repositories.js';

export const API_IDENTITY_VERIFIER = Symbol('API_IDENTITY_VERIFIER');
export const API_INTERNAL_IDENTITY_STORE = Symbol('API_INTERNAL_IDENTITY_STORE');
export const API_PERSISTENCE_DB = Symbol('API_PERSISTENCE_DB');
export const API_ID_GENERATOR = Symbol('API_ID_GENERATOR');

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const correlationIdPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const invitationTokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

const institutionStaffRoles = [
  'INSTITUTION_OWNER',
  'INSTITUTION_ADMIN',
  'PLACEMENT_ADMIN',
  'DEPARTMENT_HEAD',
  'FACULTY_LECTURER',
] as const;

export interface ApiIdGenerator {
  uuid(): string;
}

export const cryptoApiIdGenerator: ApiIdGenerator = { uuid: randomUUID };

export interface ProtectedHttpRequest {
  readonly headers: Record<string, string | readonly string[] | undefined>;
  readonly params?: Record<string, string | undefined>;
  readonly query?: Record<string, string | readonly string[] | undefined>;
  readonly body?: unknown;
  planThePath?: TrustedApiRequestContext;
}

export interface TrustedApiRequestContext {
  readonly correlationId: string;
  readonly verifiedIdentity: VerifiedIdentityToken;
  readonly authorization?: RequestAuthorizationContext;
}

export interface ApiSecurityDependencies {
  readonly verifier: IdentityTokenVerifier;
  readonly identityStore: InternalIdentityStore;
  readonly db: PersistenceDb;
  readonly ids?: ApiIdGenerator;
}

@Injectable()
export class VerifiedIdentityAuthenticationGuard implements CanActivate {
  constructor(@Inject(API_IDENTITY_VERIFIER) private readonly verifier: IdentityTokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProtectedHttpRequest>();
    request.planThePath = await authenticateVerifiedIdentityRequest(request, this.verifier);
    return true;
  }
}

@Injectable()
export class ProtectedApiAuthenticationGuard implements CanActivate {
  constructor(
    @Inject(API_IDENTITY_VERIFIER) private readonly verifier: IdentityTokenVerifier,
    @Inject(API_INTERNAL_IDENTITY_STORE) private readonly identityStore: InternalIdentityStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProtectedHttpRequest>();
    request.planThePath = await authenticateProtectedRequest(request, this.verifier, this.identityStore);
    return true;
  }
}

export async function authenticateVerifiedIdentityRequest(
  request: ProtectedHttpRequest,
  verifier: IdentityTokenVerifier,
): Promise<TrustedApiRequestContext> {
  const correlationId = resolveCorrelationId(request.headers['x-correlation-id']);
  const rawToken = extractAuthorizedBearerToken(request.headers.authorization, correlationId);
  try {
    const verifiedIdentity = await verifier.verifyAccessToken(rawToken);
    return { correlationId, verifiedIdentity };
  } catch {
    throw new UnauthorizedException(safeError('UNAUTHENTICATED', correlationId));
  }
}

export async function authenticateProtectedRequest(
  request: ProtectedHttpRequest,
  verifier: IdentityTokenVerifier,
  identityStore: InternalIdentityStore,
): Promise<TrustedApiRequestContext> {
  const correlationId = resolveCorrelationId(request.headers['x-correlation-id']);
  const rawToken = extractAuthorizedBearerToken(request.headers.authorization, correlationId);
  const requestedOrganizationId = extractCandidateOrganizationId(request, correlationId);

  try {
    const authorization = await resolveAuthorizationContext(rawToken, verifier, identityStore);
    const selectedMembership = requestedOrganizationId
      ? selectCurrentMembership(authorization.memberships, requestedOrganizationId)
      : undefined;
    const scopedAuthorization: RequestAuthorizationContext = selectedMembership
      ? { ...authorization, selectedMembership }
      : authorization;
    return { correlationId, verifiedIdentity: scopedAuthorization.verifiedIdentity, authorization: scopedAuthorization };
  } catch (error) {
    if (error instanceof AuthenticationBoundaryError && error.code === 'UNAUTHENTICATED') {
      throw new UnauthorizedException(safeError('UNAUTHENTICATED', correlationId));
    }
    throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
  }
}

@Injectable()
export class Phase1ProtectedApiRoutes {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Optional() @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator = cryptoApiIdGenerator,
  ) {}

  async currentContext(request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    return {
      userId: context.authorization.principal.userId,
      selectedOrganizationId: context.authorization.selectedMembership?.organizationId ?? null,
      memberships: context.authorization.memberships.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role,
        scope: membership.scope,
      })),
      correlationId: context.correlationId,
    };
  }

  async institutionStudentActivityAccess(
    request: ProtectedHttpRequest,
    input: { readonly institutionId: string; readonly studentUserId: string; readonly activityAt: string },
  ): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const institutionId = requireUuid(input.institutionId, context.correlationId);
    const studentUserId = requireUuid(input.studentUserId, context.correlationId);
    const activityAt = parseIsoDate(input.activityAt, context.correlationId);

    if (context.authorization.selectedMembership?.organizationId !== institutionId) {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }
    if (!hasScopedRole(context.authorization, { organizationId: institutionId, roles: institutionStaffRoles })) {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }

    const hasRelationship = await hasInstitutionRelationshipAuthorizationForActivity(this.db, institutionId, studentUserId, activityAt);
    if (!hasRelationship) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { allowed: true, correlationId: context.correlationId };
  }

  async acceptInvitation(
    request: ProtectedHttpRequest,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const context = requireTrustedIdentity(request);
    const rawToken = readRequiredStringField(body, 'token', context.correlationId);
    if (!invitationTokenPattern.test(rawToken)) {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }

    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key'], context.correlationId);
    let normalizedRecipientEmail: string;
    try {
      normalizedRecipientEmail = requireVerifiedRecipientEmail(context.verifiedIdentity);
    } catch {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }

    const tokenHash = digestInvitationToken(rawToken);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ operation: 'invitation.accept', tokenHash, normalizedRecipientEmail, subject: context.verifiedIdentity.externalSubject }))
      .digest('hex');

    try {
      const result = await acceptInvitationByTokenHashForVerifiedRecipientWithIdempotency(this.db, {
        invitationTokenHash: tokenHash,
        normalizedRecipientEmail,
        userId: this.ids.uuid(),
        externalSubject: context.verifiedIdentity.externalSubject,
        now: new Date(),
        idempotencyRecordId: this.ids.uuid(),
        idempotencyScope: `invitation.accept:${context.verifiedIdentity.externalSubject}`,
        idempotencyKey,
        requestHash,
        membershipId: this.ids.uuid(),
        auditId: this.ids.uuid(),
        outboxEventId: this.ids.uuid(),
        correlationId: context.correlationId,
      });
      return { accepted: true, userId: result.userId, idempotentReplay: result.idempotentReplay, correlationId: context.correlationId };
    } catch {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }
  }

  async employerApplicantAccess(
    request: ProtectedHttpRequest,
    input: { readonly employerId: string; readonly opportunityId: string; readonly studentUserId: string },
  ): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const employerId = requireUuid(input.employerId, context.correlationId);
    const opportunityId = requireUuid(input.opportunityId, context.correlationId);
    const studentUserId = requireUuid(input.studentUserId, context.correlationId);

    if (context.authorization.selectedMembership?.organizationId !== employerId) {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }

    try {
      await assertEmployerApplicantAccessForAuthenticatedPrincipal(this.db, {
        actorUserId: context.authorization.principal.userId,
        employerId,
        opportunityId,
        studentUserId,
      });
      return { allowed: true, correlationId: context.correlationId };
    } catch {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }
  }
}

function selectCurrentMembership(
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

function extractAuthorizedBearerToken(value: string | readonly string[] | undefined, correlationId: string): string {
  try {
    if (typeof value !== 'string') throw new Error('invalid authorization header');
    return extractBearerToken(value);
  } catch {
    throw new UnauthorizedException(safeError('UNAUTHENTICATED', correlationId));
  }
}

function extractCandidateOrganizationId(request: ProtectedHttpRequest, correlationId: string): string | undefined {
  const candidate = firstHeaderOrValue(request.params?.organizationId)
    ?? firstHeaderOrValue(request.params?.institutionId)
    ?? firstHeaderOrValue(request.params?.employerId)
    ?? firstHeaderOrValue(request.query?.organizationId);
  if (candidate === undefined) return undefined;
  return requireUuid(candidate, correlationId);
}

function resolveCorrelationId(value: string | readonly string[] | undefined): string {
  const candidate = firstHeaderOrValue(value);
  if (candidate && correlationIdPattern.test(candidate)) return candidate;
  return randomUUID();
}

function firstHeaderOrValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
  return undefined;
}

function requireIdempotencyKey(value: string | readonly string[] | undefined, correlationId: string): string {
  const key = firstHeaderOrValue(value);
  if (!key || !idempotencyKeyPattern.test(key)) {
    throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
  }
  return key;
}

export function requireTrustedIdentity(request: ProtectedHttpRequest): TrustedApiRequestContext {
  if (!request.planThePath?.verifiedIdentity) throw new UnauthorizedException(safeError('UNAUTHENTICATED', undefined));
  return request.planThePath;
}

export function requireTrustedAuthorization(request: ProtectedHttpRequest): TrustedApiRequestContext & { readonly authorization: RequestAuthorizationContext } {
  const context = requireTrustedIdentity(request);
  if (!context.authorization) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
  return context as TrustedApiRequestContext & { readonly authorization: RequestAuthorizationContext };
}

function readRequiredStringField(body: unknown, field: string, correlationId: string): string {
  if (!body || typeof body !== 'object') throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
  return value;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
  return value;
}

function parseIsoDate(value: string, correlationId: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
  return parsed;
}

export function safeError(code: 'UNAUTHENTICATED' | 'FORBIDDEN', correlationId: string | undefined): { readonly error: { readonly code: string; readonly message: string; readonly correlationId?: string } } {
  return {
    error: {
      code,
      message: 'Access denied',
      ...(correlationId ? { correlationId } : {}),
    },
  };
}
