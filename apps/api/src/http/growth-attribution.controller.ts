/**
 * Growth → Commission's credit and disputes, and Operations → Settings → Growth attribution
 * (GROWTH-07; design §8, §16).
 *
 * A growth person reads what is credited to them, the disputes they are party to, and the
 * organisations they may still dispute, and opens a claim within 90 days of a handoff. A growth admin
 * (GROWTH_ADMIN) decides disputes they are not party to, reassigns credit (never to or from
 * themselves) and ends it, each with a reason. Nothing here shows or computes an amount.
 *
 * Design: docs/architecture/growth-attribution-table-design.md
 */
import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  growthAttributionAdminEndReasons,
  growthAttributionReassignReasons,
  growthDisputeDecisionReasons,
  growthDisputeOutcomes,
  growthWorkspaceRole,
  hasInternalCapability,
  readGrowthDisputeNote,
  readGrowthDisputeStatement,
  type GrowthDisputeDecisionReason,
  type GrowthDisputeOutcome,
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
import { badRequest, mapGrowthWriteError, notFound, platformOrganizationId, readObject, readReason, readUuid } from './growth-http.js';
import { loadGrowthLeadCaller, type WriteContext } from './growth-leads-service.js';
import {
  adminAttributions,
  adminDisputes,
  decideDispute,
  endAttribution,
  growthAttributionsFor,
  openClaim,
  organizationAttributionHistory,
  reassignAttribution,
  reassignOptions,
  SELF_DEALING_CODE,
  type AdminAttributionView,
} from './growth-attribution-service.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

/** Database refusals that can still reach a route after its own checks (a race), as domain codes. */
const attributionTriggerMessages = {
  'dispute window': 'GROWTH_DISPUTE_WINDOW_CLOSED',
  'had a lead or a referral': 'GROWTH_DISPUTE_NOT_ELIGIBLE',
  'growth_disputes_open_org_uq': 'GROWTH_DISPUTE_ALREADY_OPEN',
  'growth_attributions_live_org_uq': 'GROWTH_ATTRIBUTION_CONFLICT',
  'growth_dispute_decider_ck': SELF_DEALING_CODE,
  'growth_attribution_self_ck': SELF_DEALING_CODE,
} as const;

@Controller('/api/v1/growth')
export class GrowthAttributionController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** The caller's credit (no amounts), their disputes, and what they may dispute. */
  @Get('/attributions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async mine(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.require(request);
    return { ...await growthAttributionsFor(this.db, ctx.actorUserId), correlationId };
  }

  @Post('/attribution-disputes')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async claim(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.require(request);
    const raw = readObject(body, ['organizationId', 'statement'], correlationId);
    const organizationId = readUuid(raw.organizationId, correlationId);
    const statement = readGrowthDisputeStatement(raw.statement);
    if (!statement) throw badRequest('GROWTH_DISPUTE_STATEMENT_INVALID', correlationId);
    const disputeId = await this.db.transaction((tx) => openClaim(tx, ctx, { organizationId, statement }))
      .catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { unique: 'GROWTH_DISPUTE_ALREADY_OPEN', messages: attributionTriggerMessages }); });
    return { disputeId, ...await growthAttributionsFor(this.db, ctx.actorUserId), correlationId };
  }

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly ctx: WriteContext }> {
    const context = requireTrustedAuthorization(request);
    if (!growthWorkspaceRole(context.authorization.memberships)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const userId = context.authorization.principal.userId;
    const caller = await loadGrowthLeadCaller(this.db, { userId, growthAdmin: false });
    if (!caller.memberships.length) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', context.correlationId);
    return { correlationId: context.correlationId, ctx: { actorUserId: userId, organizationId, correlationId: context.correlationId, uuid: () => this.ids.uuid() } };
  }
}

const views: readonly AdminAttributionView[] = ['LIVE', 'LEFT', 'ENDED'];

@Controller('/api/v1/operations/growth-attribution')
export class OperationsGrowthAttributionController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const source = query ?? {};
    if (Object.keys(source).some((key) => key !== 'view' && key !== 'q')) throw badRequest('INVALID_REQUEST', correlationId);
    const view = source.view === undefined ? 'LIVE' : source.view;
    if (typeof view !== 'string' || !(views as readonly string[]).includes(view)) throw badRequest('INVALID_REQUEST', correlationId);
    const q = source.q === undefined ? '' : source.q;
    if (typeof q !== 'string' || q.length > 120) throw badRequest('INVALID_REQUEST', correlationId);
    return {
      ...await adminAttributions(this.db, { view: view as AdminAttributionView, search: q.trim() || null }),
      vocabulary: { reassignReasons: growthAttributionReassignReasons, endReasons: growthAttributionAdminEndReasons, decisionReasons: growthDisputeDecisionReasons, outcomes: growthDisputeOutcomes },
      correlationId,
    };
  }

  @Get('/disputes')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async disputes(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const source = query ?? {};
    if (Object.keys(source).some((key) => key !== 'state')) throw badRequest('INVALID_REQUEST', correlationId);
    const state = source.state === undefined ? 'OPEN' : source.state;
    if (state !== 'OPEN' && state !== 'DECIDED') throw badRequest('INVALID_REQUEST', correlationId);
    return { disputes: await adminDisputes(this.db, { state }), correlationId };
  }

  @Get('/reassign-options')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async options(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const kind = query?.kind;
    if (kind !== 'INSTITUTION' && kind !== 'EMPLOYER') throw badRequest('INVALID_REQUEST', correlationId);
    return { options: await reassignOptions(this.db, kind), correlationId };
  }

  @Get('/organizations/:orgId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async history(@Req() request: ProtectedHttpRequest, @Param('orgId') organizationId: string): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    return { ...await organizationAttributionHistory(this.db, readUuid(organizationId, correlationId), correlationId), correlationId };
  }

  @Post('/disputes/:disputeId/decide')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async decide(@Req() request: ProtectedHttpRequest, @Param('disputeId') disputeId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireWrite(request);
    const id = readUuid(disputeId, correlationId);
    const raw = readObject(body, ['outcome', 'reasonCode', 'note'], correlationId);
    if (typeof raw.outcome !== 'string' || !(growthDisputeOutcomes as readonly string[]).includes(raw.outcome)) throw badRequest('INVALID_REQUEST', correlationId);
    const reasonCode = readReason(raw.reasonCode, growthDisputeDecisionReasons, correlationId) as GrowthDisputeDecisionReason;
    const note = readGrowthDisputeNote(raw.note, reasonCode);
    if (note === undefined) throw badRequest('GROWTH_DISPUTE_NOTE_INVALID', correlationId);
    const decided = await this.db.transaction((tx) => decideDispute(tx, ctx, { disputeId: id, outcome: raw.outcome as GrowthDisputeOutcome, reasonCode, note }))
      .catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: attributionTriggerMessages }); });
    return { decided, correlationId };
  }

  @Post('/:attributionId/reassign')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reassign(@Req() request: ProtectedHttpRequest, @Param('attributionId') attributionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireWrite(request);
    const id = readUuid(attributionId, correlationId);
    const raw = readObject(body, ['toUserId', 'reasonCode'], correlationId);
    const toUserId = readUuid(raw.toUserId, correlationId);
    const reasonCode = readReason(raw.reasonCode, growthAttributionReassignReasons, correlationId);
    const created = await this.db.transaction((tx) => reassignAttribution(tx, ctx, { attributionId: id, toUserId, reasonCode }))
      .catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: attributionTriggerMessages }); });
    return { attributionId: created, correlationId };
  }

  @Post('/:attributionId/end')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async end(@Req() request: ProtectedHttpRequest, @Param('attributionId') attributionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireWrite(request);
    const id = readUuid(attributionId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthAttributionAdminEndReasons, correlationId);
    await this.db.transaction((tx) => endAttribution(tx, ctx, { attributionId: id, reasonCode }))
      .catch((error: unknown) => { throw mapGrowthWriteError(error, correlationId, { messages: attributionTriggerMessages }); });
    return { ended: id, correlationId };
  }

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly userId: string }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!hasInternalCapability(actor, 'GROWTH_ADMIN')) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, userId: actor.userId };
  }

  private async requireWrite(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly ctx: WriteContext }> {
    const { correlationId, userId } = await this.require(request);
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', correlationId);
    return { correlationId, ctx: { actorUserId: userId, organizationId, correlationId, uuid: () => this.ids.uuid() } };
  }
}
