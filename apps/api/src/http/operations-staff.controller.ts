/**
 * Operations Settings — staff and capabilities (OPS-01, ADR-032).
 *
 * Lists the ONE platform organisation's memberships with what each can do, and lets a
 * CAPABILITY_ADMIN holder grant or revoke internal capabilities. Every change carries
 * a reason code from a fixed list and is audited with an outbox event in the same
 * transaction; the grant rules are decided by the pure functions in
 * packages/authorization and repeated by the database trigger from 0039, so a second
 * writer cannot skip them.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  baselineInternalCapabilities,
  effectiveInternalCapabilities,
  hasInternalCapability,
  internalCapabilities,
  internalCapabilityGrantReasons,
  internalCapabilityRevokeReasons,
  isHighRiskInternalCapability,
  isInternalCapability,
  refuseInternalCapabilityGrant,
  refuseInternalCapabilityRevoke,
  type InternalCapability,
  type InternalCapabilityChangeRefusal,
} from '@planthepath/authorization/src/index.js';
import {
  PlatformControlError,
  grantInternalCapability,
  listPlatformStaff,
  revokeInternalCapability,
  type PlatformStaffMember,
} from '@planthepath/persistence/src/platform-controls.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { loadCallerCapabilityContext, poolCapabilityGrantLoader } from './internal-capability-guard.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;

type Actor = Awaited<ReturnType<typeof loadCallerCapabilityContext>>;

@Controller('/api/v1/operations/staff')
export class OperationsStaffController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireCapabilityAdmin(request);
    rejectUnknown(query, ['limit', 'cursor'], correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listPlatformStaff(this.pool, { limit, ...(cursor ? { cursor } : {}) });
    return {
      staff: page.staff.map((member) => toStaffDto(member, actor.userId)),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      capabilities: internalCapabilities.map((capability) => ({
        capability,
        highRisk: isHighRiskInternalCapability(capability),
        grantableHere: capability !== 'CONTENT_REVIEW_EXTERNAL',
      })),
      grantReasons: internalCapabilityGrantReasons,
      revokeReasons: internalCapabilityRevokeReasons,
      actorMayGrantHighRisk: actor.memberships.some((membership) => membership.state === 'ACTIVE' && membership.role === 'PLATFORM_SUPER_ADMIN'),
      correlationId,
    };
  }

  @Post('/:membershipId/capabilities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async grant(@Req() request: ProtectedHttpRequest, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireCapabilityAdmin(request);
    const id = requireUuid(membershipId, correlationId);
    const raw = readObject(body, ['capability', 'reasonCode', 'note'], correlationId);
    const capability = readCapability(raw.capability, correlationId);
    const reasonCode = readReason(raw.reasonCode, internalCapabilityGrantReasons, correlationId);
    const note = readNote(raw.note, correlationId);
    try {
      const member = await grantInternalCapability(this.pool, {
        membershipId: id, capability, actorUserId: actor.userId, reasonCode, ...(note ? { note } : {}), correlationId,
        decide: (target) => refuseInternalCapabilityGrant({ actor, target, capability }),
      });
      return { member: toStaffDto(member, actor.userId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/:membershipId/capabilities/:capability/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revoke(
    @Req() request: ProtectedHttpRequest,
    @Param('membershipId') membershipId: string,
    @Param('capability') capabilityParam: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireCapabilityAdmin(request);
    const id = requireUuid(membershipId, correlationId);
    const capability = readCapability(capabilityParam, correlationId);
    const raw = readObject(body, ['reasonCode', 'note'], correlationId);
    const reasonCode = readReason(raw.reasonCode, internalCapabilityRevokeReasons, correlationId);
    const note = readNote(raw.note, correlationId);
    try {
      const member = await revokeInternalCapability(this.pool, {
        membershipId: id, capability, actorUserId: actor.userId, reasonCode, ...(note ? { note } : {}), correlationId,
        decide: (target) => refuseInternalCapabilityRevoke({ actor, target, capability }),
      });
      return { member: toStaffDto(member, actor.userId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  private async requireCapabilityAdmin(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    // The grants are needed anyway (for the self-grant and high-risk rules), so this
    // loads them up front rather than trying the baseline first.
    const actor = await loadCallerCapabilityContext(context.authorization, poolCapabilityGrantLoader(this.pool));
    if (!hasInternalCapability(actor, 'CAPABILITY_ADMIN')) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

function toStaffDto(member: PlatformStaffMember, actorUserId: string): Record<string, unknown> {
  const grants = member.grants.map((grant) => grant.capability);
  const active = member.state === 'ACTIVE';
  return {
    membershipId: member.membershipId,
    email: member.email,
    role: member.role,
    state: member.state,
    isSelf: member.userId === actorUserId,
    baseline: active ? baselineInternalCapabilities(member.role) : [],
    grants: member.grants.map((grant) => ({
      capability: grant.capability,
      grantedAt: grant.grantedAt,
      reasonCode: grant.reasonCode,
      highRisk: isInternalCapability(grant.capability) && isHighRiskInternalCapability(grant.capability),
    })),
    // Only ACTIVE memberships count, so an inactive one shows an empty effective set.
    effective: active ? effectiveInternalCapabilities(member.role, grants) : [],
  };
}

/** safeError types only the authentication codes; these are domain codes in the same shape. */
function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

const refusalStatus: Readonly<Record<InternalCapabilityChangeRefusal, number>> = {
  FORBIDDEN: 403,
  CAPABILITY_SELF_CHANGE_REFUSED: 403,
  HIGH_RISK_GRANT_REQUIRES_SUPER_ADMIN: 403,
  CAPABILITY_NOT_GRANTABLE_HERE: 400,
  CAPABILITY_ROLE_NOT_ELIGIBLE: 400,
  MEMBERSHIP_NOT_ACTIVE: 400,
  CAPABILITY_ALREADY_HELD: 409,
  CAPABILITY_NOT_GRANTED: 404,
};

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof PlatformControlError) {
    if (error.code === 'MEMBERSHIP_NOT_FOUND') return new NotFoundException(domainError(error.code, correlationId));
    const status = refusalStatus[error.code as InternalCapabilityChangeRefusal];
    if (status === 403) return new ForbiddenException(domainError(error.code, correlationId));
    if (status === 404) return new NotFoundException(domainError(error.code, correlationId));
    if (status === 409) return new ConflictException(domainError(error.code, correlationId));
    return badRequest(error.code, correlationId);
  }
  // Never forward database or driver text to the browser.
  return badRequest('CAPABILITY_CHANGE_REJECTED', correlationId);
}

function rejectUnknown(source: Record<string, unknown>, allowed: readonly string[], correlationId: string): void {
  if (Object.keys(source).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  rejectUnknown(raw, allowed, correlationId);
  return raw;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value;
}

function readCapability(value: unknown, correlationId: string): InternalCapability {
  if (!isInternalCapability(value)) throw badRequest('CAPABILITY_INVALID', correlationId);
  return value;
}

function readReason(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('REASON_CODE_INVALID', correlationId);
  return value;
}

function readNote(value: unknown, correlationId: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > noteLimit) throw badRequest('NOTE_INVALID', correlationId);
  return value.trim() || undefined;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('STAFF_LIMIT_INVALID', correlationId);
  return parsed;
}

function encodeCursor(position: { readonly createdAt: string; readonly id: string }): string {
  return Buffer.from(position.createdAt + '|' + position.id, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): { readonly createdAt: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('STAFF_CURSOR_INVALID', correlationId);
  const [createdAt, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || rest.length || Number.isNaN(Date.parse(createdAt)) || !uuidPattern.test(id)) {
    throw badRequest('STAFF_CURSOR_INVALID', correlationId);
  }
  return { createdAt, id };
}
