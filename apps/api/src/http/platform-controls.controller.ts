/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Feature flags (migration 0029) and institution analytics capability grants
 * (migration 0031).
 *
 * Flags are platform-operated; capability grants are institution-operated, because
 * ADR-018 makes analytics a thing an institution decides about its own staff rather
 * than something Operations awards on a customer's behalf.
 *
 * Every mutation here requires a reason code. Platform control 103 asks for reason
 * capture on high-risk actions, and both flipping a flag that gates a safety behaviour
 * and widening what a staff member may export qualify.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  PlatformControlError,
  grantMembershipCapability,
  listFeatureFlags,
  listMembershipCapabilities,
  revokeMembershipCapability,
  setFeatureFlagEnabled,
} from '@planthepath/persistence/src/platform-controls.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';
import { callerHasInternalCapability, poolCapabilityGrantLoader } from './internal-capability-guard.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;
const flagKeyPattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/** Only the institution's own owner or admin may widen a colleague's reach. */
const capabilityGrantRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'];

@Controller('/api/v1')
export class PlatformControlsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('/operations/feature-flags')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async flags(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    await requireFlagOperator(request, this.pool);
    return { flags: await listFeatureFlags(this.pool) };
  }

  @Post('/operations/feature-flags/:key/state')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async setFlag(
    @Req() request: ProtectedHttpRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const actorUserId = await requireFlagOperator(request, this.pool);
    if (!flagKeyPattern.test(key)) throw badRequest('FEATURE_FLAG_KEY_INVALID');
    const raw = readObject(body);
    if (typeof raw.enabled !== 'boolean') throw badRequest('FEATURE_FLAG_STATE_INVALID');
    const reasonCode = readReasonCode(raw.reasonCode);
    try {
      await setFeatureFlagEnabled(this.pool, {
        key, enabled: raw.enabled, actorUserId, reasonCode,
        correlationId: request.planThePath?.correlationId ?? 'unknown',
      });
    } catch (error) {
      throw mapControlError(error);
    }
    return { flags: await listFeatureFlags(this.pool) };
  }

  @Get('/institutions/:institutionId/capabilities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async capabilities(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    requireInstitutionAdmin(request, id);
    return { capabilities: await listMembershipCapabilities(this.pool, id) };
  }

  @Post('/institutions/:institutionId/capabilities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async grant(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    const actorUserId = requireInstitutionAdmin(request, id);
    const raw = readObject(body);
    if (typeof raw.membershipId !== 'string' || !uuidPattern.test(raw.membershipId)) throw badRequest('MEMBERSHIP_ID_INVALID');
    if (raw.capability !== 'INSTITUTION_ANALYTICS') throw badRequest('CAPABILITY_INVALID');

    // Scoped to this institution's own memberships, so an admin cannot grant into
    // another organisation by supplying its membership id.
    const owned = await this.pool.query(
      'SELECT 1 FROM organization_memberships WHERE id=$1 AND organization_id=$2',
      [raw.membershipId, id],
    );
    if (!owned.rowCount) throw new NotFoundException({ error: { code: 'MEMBERSHIP_NOT_FOUND' } });

    try {
      await grantMembershipCapability(this.pool, {
        membershipId: raw.membershipId, capability: 'INSTITUTION_ANALYTICS',
        grantedByUserId: actorUserId, reasonCode: readReasonCode(raw.reasonCode),
      });
    } catch (error) {
      throw mapControlError(error);
    }
    return { capabilities: await listMembershipCapabilities(this.pool, id) };
  }

  @Post('/institutions/:institutionId/capabilities/:capabilityId/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revoke(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('capabilityId') capabilityId: string,
  ): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    const actorUserId = requireInstitutionAdmin(request, id);
    const owned = await this.pool.query(
      `SELECT 1 FROM membership_capabilities c JOIN organization_memberships m ON m.id = c.membership_id
       WHERE c.id=$1 AND m.organization_id=$2`, [requireUuid(capabilityId), id],
    );
    if (!owned.rowCount) throw new NotFoundException({ error: { code: 'CAPABILITY_NOT_FOUND' } });
    try {
      await revokeMembershipCapability(this.pool, { capabilityId, revokedByUserId: actorUserId });
    } catch (error) {
      throw mapControlError(error);
    }
    return { capabilities: await listMembershipCapabilities(this.pool, id) };
  }
}

/**
 * OPS_FLAGS_MANAGE (OPS-01). Baseline for all three platform roles: flags were guarded by
 * the audit-search role family, which includes Security, and ADR-032 preserves that
 * (divergence D1 from the plan's table, to be tightened by its own ADR).
 */
async function requireFlagOperator(request: ProtectedHttpRequest, pool: Pool): Promise<string> {
  const authorization = request.planThePath?.authorization;
  const userId = authorization?.principal.userId;
  const permitted = await callerHasInternalCapability(authorization, poolCapabilityGrantLoader(pool), 'OPS_FLAGS_MANAGE');
  if (!userId || !permitted) throw forbidden();
  return userId;
}

function requireInstitutionAdmin(request: ProtectedHttpRequest, institutionId: string): string {
  const authorization = request.planThePath?.authorization;
  const userId = authorization?.principal.userId;
  const permitted = (authorization?.memberships ?? []).some((membership) => (
    membership.state === 'ACTIVE'
    && capabilityGrantRoles.includes(membership.role)
    && membership.organizationId === institutionId
    && membership.scope.organizationId === institutionId
  ));
  if (!userId || !permitted) throw forbidden();
  return userId;
}

function readObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST');
  return body as Record<string, unknown>;
}

function readReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !reasonCodePattern.test(value)) throw badRequest('REASON_CODE_REQUIRED');
  return value;
}

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_REQUEST');
  return value;
}

function mapControlError(error: unknown): BadRequestException | NotFoundException {
  if (error instanceof PlatformControlError) {
    if (error.code.endsWith('NOT_FOUND')) return new NotFoundException({ error: { code: error.code } });
    return new BadRequestException({ error: { code: error.code } });
  }
  return badRequest('INVALID_REQUEST');
}

function badRequest(code: string): BadRequestException {
  return new BadRequestException({ error: { code } });
}

function forbidden(): ForbiddenException {
  return new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
}
