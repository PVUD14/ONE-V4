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
  listFeatureFlags,
  listMembershipCapabilities,
  setFeatureFlagEnabled,
} from '@planthepath/persistence/src/platform-controls.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';
import { callerHasInternalCapability, poolCapabilityGrantLoader } from './internal-capability-guard.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { isHighRiskFlagChange } from '@planthepath/authorization/src/index.js';
import { OperationApprovalError, consumeOperationApproval } from '@planthepath/persistence/src/operation-approvals.js';
import { approvalHttpError, approvalPayloads, readApprovalId } from './operation-approval-gate.js';
import {
  InstitutionExportError,
  grantInstitutionAnalytics,
  listInstitutionAnalyticsAccess,
  revokeInstitutionAnalytics,
} from '@planthepath/persistence/src/institution-exports.js';

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
    const correlationId = request.planThePath?.correlationId ?? 'unknown';
    const approvalId = readApprovalId(raw, correlationId);
    const enabled = raw.enabled;
    try {
      await setFeatureFlagEnabled(this.pool, {
        key, enabled, actorUserId, reasonCode, correlationId,
        // OPS-02: a flag marked high-risk needs an approval for its risky direction,
        // consumed in the same transaction as the change.
        guard: async (client, flag) => {
          const highRisk = isHighRiskFlagChange(flag.highRiskDirection, enabled);
          if (!highRisk) {
            if (approvalId) throw new OperationApprovalError('APPROVAL_NOT_REQUIRED');
            return;
          }
          if (!approvalId) throw new OperationApprovalError('APPROVAL_REQUIRED');
          await consumeOperationApproval(drizzle(client), {
            approvalId, actionKey: 'FEATURE_FLAG_HIGH_RISK_CHANGE',
            payload: approvalPayloads.FEATURE_FLAG_HIGH_RISK_CHANGE({ key, enabled, reasonCode }),
            executorUserId: actorUserId, correlationId,
          });
        },
      });
    } catch (error) {
      throw approvalHttpError(error, correlationId) ?? mapControlError(error);
    }
    return { flags: await listFeatureFlags(this.pool) };
  }

  @Get('/institutions/:institutionId/capabilities')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async capabilities(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    requireInstitutionAdmin(request, id);
    // INST-08: `eligible` lists who may hold INSTITUTION_ANALYTICS (active admins and
    // department heads), with their live grant, so the Staff screen can grant and revoke.
    return { capabilities: await listMembershipCapabilities(this.pool, id), eligible: await listInstitutionAnalyticsAccess(this.pool, id) };
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

    const reasonCode = readReasonCode(raw.reasonCode);
    try {
      // INST-08: the grant and its audit row in one transaction.
      await grantInstitutionAnalytics(this.pool, {
        institutionId: id, membershipId: raw.membershipId, actorUserId, reasonCode,
        correlationId: request.planThePath?.correlationId ?? 'unknown',
      });
    } catch (error) {
      throw mapControlError(error);
    }
    return { capabilities: await listMembershipCapabilities(this.pool, id), eligible: await listInstitutionAnalyticsAccess(this.pool, id) };
  }

  @Post('/institutions/:institutionId/capabilities/:capabilityId/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revoke(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('capabilityId') capabilityId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const id = requireUuid(institutionId);
    const actorUserId = requireInstitutionAdmin(request, id);
    const capability = requireUuid(capabilityId);
    // INST-08: a revocation carries a reason code, like the grant, and is audited in the same
    // transaction. Only INSTITUTION_ANALYTICS grants of this institution can be revoked here:
    // an operations grant on an institution membership is not the college's to remove.
    const reasonCode = readReasonCode(readObject(body).reasonCode);
    try {
      await revokeInstitutionAnalytics(this.pool, {
        institutionId: id, capabilityId: capability, actorUserId, reasonCode,
        correlationId: request.planThePath?.correlationId ?? 'unknown',
      });
    } catch (error) {
      throw mapControlError(error);
    }
    return { capabilities: await listMembershipCapabilities(this.pool, id), eligible: await listInstitutionAnalyticsAccess(this.pool, id) };
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
  if (error instanceof PlatformControlError || error instanceof InstitutionExportError) {
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
