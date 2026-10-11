/**
 * Growth → employer referral links, and Operations → Organizations' growth-lead link on employer
 * access requests (GROWTH-05; design §7.2, §7.3).
 *
 * A growth person on the employer partnerships team creates, lists and revokes their own referral
 * codes; the link they share is the public access-request form's path with the code. Another
 * person's code is "not found", never "forbidden". An operator holding OPS_ORG_MANAGE may link a
 * pending access request to an open employer lead, move the link or remove it, and search open
 * employer leads to do so. Nothing here creates, onboards or verifies an organisation.
 *
 * Design: docs/architecture/growth-employer-pipeline-table-design.md
 */
import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  growthReferralLimits,
  growthReferralMembership,
  growthWorkspaceRole,
  type GrowthLeadCaller,
} from '@planthepath/authorization/src/index.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { badRequest, forbidden, mapGrowthWriteError, notFound, platformOrganizationId, readObject, readUuid } from './growth-http.js';
import { readGrowthIdempotencyKey, runGrowthIdempotent } from './growth-idempotency.js';
import { loadGrowthLeadCaller, type WriteContext } from './growth-leads-service.js';
import { createReferralCode, listReferralCodes, revokeReferralCode, searchEmployerLeadsForOperations, setAccessRequestLead } from './growth-employer-service.js';
import { callerHasInternalCapability, dbCapabilityGrantLoader } from './internal-capability-guard.js';

const referralLimitMessages = {
  'at most 3 live codes': 'GROWTH_REFERRAL_CODE_LIMIT',
  'at most 5 codes a day': 'GROWTH_REFERRAL_CODE_DAILY_LIMIT',
  'employer partnerships team': 'GROWTH_TEAM_MISMATCH',
} as const;

@Controller('/api/v1/growth/referral-codes')
export class GrowthReferralCodesController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** The caller's own codes (live first), each with its link path and counts of referred requests by state. */
  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, userId, caller } = await this.require(request);
    return {
      eligible: growthReferralMembership(caller) !== null,
      codes: await listReferralCodes(this.db, userId),
      limits: growthReferralLimits,
      correlationId,
    };
  }

  @Post()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, userId, caller, ctx } = await this.requireWrite(request);
    const key = readGrowthIdempotencyKey(request.headers['idempotency-key'], correlationId, false);
    readObject(body ?? {}, [], correlationId);
    const membershipId = growthReferralMembership(caller);
    if (!membershipId) throw forbidden('GROWTH_TEAM_MISMATCH', correlationId);
    const result = await this.db.transaction((tx) => runGrowthIdempotent(tx, {
      userId, route: 'referral_code.create', target: membershipId, key, body: body ?? {}, recordId: this.ids.uuid(), correlationId,
    }, 'growth_referral_code', () => createReferralCode(tx, ctx, membershipId)))
      .catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: referralLimitMessages }); });
    const codes = await listReferralCodes(this.db, userId);
    return { code: codes.find((code) => code.id === result.resourceId) ?? null, codes, idempotentReplay: result.replay, correlationId };
  }

  @Post('/:codeId/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revoke(@Req() request: ProtectedHttpRequest, @Param('codeId') codeId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, userId, ctx } = await this.requireWrite(request);
    const id = readUuid(codeId, correlationId);
    readObject(body ?? {}, [], correlationId);
    await this.db.transaction((tx) => revokeReferralCode(tx, ctx, id))
      .catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId); });
    return { codes: await listReferralCodes(this.db, userId), correlationId };
  }

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly userId: string; readonly caller: GrowthLeadCaller }> {
    const context = requireTrustedAuthorization(request);
    if (!growthWorkspaceRole(context.authorization.memberships)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const userId = context.authorization.principal.userId;
    const caller = await loadGrowthLeadCaller(this.db, { userId, growthAdmin: false });
    if (!caller.memberships.length) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, userId, caller };
  }

  private async requireWrite(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly userId: string; readonly caller: GrowthLeadCaller; readonly ctx: WriteContext }> {
    const required = await this.require(request);
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', required.correlationId);
    return { ...required, ctx: { actorUserId: required.userId, organizationId, correlationId: required.correlationId, uuid: () => this.ids.uuid() } };
  }
}

/** Operations → Organizations: the growth lead of an employer access request (OPS_ORG_MANAGE). */
@Controller('/api/v1/operations')
export class OperationsGrowthEmployerController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** Open employer leads, by name or domain, for linking a request to one. */
  @Get('/growth-employer-leads')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async search(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireOperations(request);
    const source = query ?? {};
    if (Object.keys(source).some((key) => key !== 'q')) throw badRequest('INVALID_REQUEST', correlationId);
    const q = source.q === undefined ? '' : source.q;
    if (typeof q !== 'string' || q.length > 120) throw badRequest('INVALID_REQUEST', correlationId);
    return { leads: await searchEmployerLeadsForOperations(this.db, q), correlationId };
  }

  /** Link a pending request to an open employer lead, move the link, or (leadId null) remove it. */
  @Post('/employer-access-requests/:requestId/growth-lead')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async link(@Req() request: ProtectedHttpRequest, @Param('requestId') requestId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireOperations(request);
    const id = readUuid(requestId, correlationId);
    const raw = readObject(body, ['leadId'], correlationId);
    if (!('leadId' in raw)) throw badRequest('INVALID_REQUEST', correlationId);
    const leadId = raw.leadId === null ? null : readUuid(raw.leadId, correlationId);
    const linked = await this.db.transaction((tx) => setAccessRequestLead(tx, ctx, { requestId: id, leadId }))
      .catch((error: unknown) => {
        throw mapGrowthWriteError(error, correlationId, { messages: {
          'linked to a pending access request': 'EMPLOYER_ACCESS_REQUEST_NOT_PENDING',
          'open, contactable employer lead': 'GROWTH_EMPLOYER_LEAD_NOT_LINKABLE',
        } });
      });
    return { linked, correlationId };
  }

  private async requireOperations(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly ctx: WriteContext }> {
    const context = requireTrustedAuthorization(request);
    if (!await callerHasInternalCapability(context.authorization, dbCapabilityGrantLoader(this.db), 'OPS_ORG_MANAGE')) {
      throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    }
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', context.correlationId);
    return { correlationId: context.correlationId, ctx: { actorUserId: context.authorization.principal.userId, organizationId, correlationId: context.correlationId, uuid: () => this.ids.uuid() } };
  }
}
