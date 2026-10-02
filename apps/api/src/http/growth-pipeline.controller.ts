/**
 * Growth → the college pipeline (GROWTH-04; design §6): a growth person moves a lead through its
 * stages, asks operations to onboard the college, and follows the onboarding through milestones
 * read from Operations' own records; and Operations → Organizations' handoff queue, where an
 * operator holding OPS_ORG_MANAGE links a request to the college they created, or declines it.
 *
 * Growth routes admit only an ACTIVE growth membership and are scoped by the one scope rule (a lead
 * outside scope is 404). Stage moves and handoff requests take an optional Idempotency-Key, so the
 * phone's offline queue can resend them. No growth route writes an organisation, an account field
 * or a verification; the link is an Operations act.
 *
 * Design: docs/architecture/growth-college-pipeline-table-design.md
 */
import { Body, Controller, ForbiddenException, Get, HttpException, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  growthCollegeMilestones,
  growthEmployerMilestones,
  growthHandoffDeclineReasons,
  growthNextStages,
  growthOwningMembership,
  growthStageReasons,
  growthWorkspaceRole,
  refuseGrowthHandoffRequest,
  refuseGrowthStageMove,
  refuseGrowthStageWriter,
  type GrowthHandoffRefusal,
  type GrowthLeadCaller,
  type GrowthStageRefusal,
} from '@planthepath/authorization/src/index.js';
import { growthScopePredicate } from '@planthepath/persistence/src/growth-territories.js';
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
import { badRequest, conflict, databaseErrorText, forbidden, notFound, platformOrganizationId, readObject, readReason, readUuid, type QueryResult } from './growth-http.js';
import { readGrowthIdempotencyKey, runGrowthIdempotent } from './growth-idempotency.js';
import { loadGrowthLeadCaller, loadLead, type WriteContext } from './growth-leads-service.js';
import {
  applyStageMove,
  collegeMilestones,
  createHandoffRequest,
  declineHandoff,
  handoffQueue,
  handoffRequestsForLead,
  linkHandoff,
} from './growth-pipeline-service.js';
import { callerHasInternalCapability, dbCapabilityGrantLoader } from './internal-capability-guard.js';
import { accessRequestsForLead, employerMilestones } from './growth-employer-service.js';

const notFoundRefusals = new Set(['GROWTH_LEAD_NOT_FOUND']);
const forbiddenRefusals = new Set(['GROWTH_NOT_LEAD_OWNER']);
const conflictRefusals = new Set(['GROWTH_LEAD_CLOSED', 'GROWTH_LEAD_DO_NOT_CONTACT', 'GROWTH_STAGE_IN_HANDOFF', 'GROWTH_HANDOFF_NEEDS_AGREEMENT', 'GROWTH_STAGE_UNCHANGED']);

function pipelineRefusal(code: GrowthStageRefusal | GrowthHandoffRefusal, correlationId: string): HttpException {
  if (notFoundRefusals.has(code)) return notFound(code, correlationId);
  if (forbiddenRefusals.has(code)) return forbidden(code, correlationId);
  if (conflictRefusals.has(code)) return conflict(code, correlationId);
  return badRequest(code, correlationId);
}

/** The database decides a race (a stage changed under the request, a request already open). */
function mapPipelineError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  const { code, message } = databaseErrorText(error);
  if (code === '23505') return conflict('GROWTH_HANDOFF_ALREADY_OPEN', correlationId);
  if (message.includes('stage never changes') || message.includes('needs an open, contactable lead')) return conflict('GROWTH_LEAD_CLOSED', correlationId);
  if (message.includes('HANDOFF_REQUESTED')) return conflict('GROWTH_STAGE_IN_HANDOFF', correlationId);
  if (message.includes('live contact of the requested lead')) return badRequest('GROWTH_HANDOFF_CONTACT_INVALID', correlationId);
  if (message.includes('linked to an institution') || message.includes('only through a linked handoff')) return conflict('GROWTH_HANDOFF_NOT_AN_INSTITUTION', correlationId);
  return badRequest('GROWTH_CHANGE_REJECTED', correlationId);
}

export function growthPipelineVocabulary(): Record<string, unknown> {
  return { reasons: growthStageReasons, declineReasons: growthHandoffDeclineReasons, milestones: growthCollegeMilestones, employerMilestones: growthEmployerMilestones };
}

@Controller('/api/v1/growth/leads')
export class GrowthPipelineController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** The lead's place in the pipeline: stage, allowed next stages, handoff requests and (once linked) milestones. */
  @Get('/:leadId/pipeline')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async pipeline(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string): Promise<Record<string, unknown>> {
    const { correlationId, caller, userId } = await this.require(request);
    const id = readUuid(leadId, correlationId);
    const loaded = await this.visible(this.db, id, caller, correlationId);
    const employer = loaded.row.kind === 'EMPLOYER';
    const canMove = refuseGrowthStageWriter(caller, loaded.facts) === null;
    const handedOff = loaded.row.organization_id !== null;
    return {
      leadId: id, kind: loaded.row.kind, stage: loaded.row.stage, lostReasonCode: loaded.row.lost_reason_code,
      canMove, nextStages: canMove && !handedOff ? growthNextStages(loaded.row.kind, loaded.row.stage) : [],
      canRequestHandoff: canMove && refuseGrowthHandoffRequest({ kind: loaded.row.kind, stage: loaded.row.stage, doNotContact: loaded.facts.doNotContact, handedOff }, 'X') === null,
      handoffRequests: await handoffRequestsForLead(this.db, id),
      // GROWTH-05: an employer lead's milestones are shown from the start (its access request comes first);
      // a college's only once operations has linked it.
      milestones: employer ? await employerMilestones(this.db, loaded.row) : await collegeMilestones(this.db, loaded.row),
      accessRequests: employer ? await accessRequestsForLead(this.db, id, userId) : [],
      vocabulary: growthPipelineVocabulary(), correlationId,
    };
  }

  @Post('/:leadId/stage')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async move(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const key = readGrowthIdempotencyKey(request.headers['idempotency-key'], correlationId, false);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['fromStage', 'toStage', 'reasonCode'], correlationId);
    if (typeof raw.fromStage !== 'string' || typeof raw.toStage !== 'string') throw badRequest('GROWTH_STAGE_INVALID', correlationId);
    const reasonCode = raw.reasonCode === undefined || raw.reasonCode === null ? null : typeof raw.reasonCode === 'string' ? raw.reasonCode : undefined;
    if (reasonCode === undefined) throw badRequest('REASON_CODE_INVALID', correlationId);
    const result = await this.db.transaction((tx) => runGrowthIdempotent(tx, {
      userId: ctx.actorUserId, route: 'lead.stage', target: id, key, body, recordId: this.ids.uuid(), correlationId,
    }, 'growth_lead', async () => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const writer = refuseGrowthStageWriter(caller, loaded.facts);
      if (writer) throw pipelineRefusal(writer, correlationId);
      // Offline safety: a move made against a stage that has since changed is refused, not applied.
      if (loaded.row.stage !== raw.fromStage) throw conflict('GROWTH_STAGE_CHANGED', correlationId, { currentStage: loaded.row.stage });
      const refusal = refuseGrowthStageMove({
        kind: loaded.row.kind, from: loaded.row.stage, to: raw.toStage as string, reasonCode,
        doNotContact: loaded.facts.doNotContact, handedOff: loaded.row.organization_id !== null,
      });
      if (refusal) throw pipelineRefusal(refusal, correlationId);
      return applyStageMove(tx, ctx, { lead: loaded.row, to: raw.toStage as string, reasonCode });
    })).catch((error: unknown) => { throw mapPipelineError(error, correlationId); });
    return { ...(await this.pipeline(request, id)), idempotentReplay: result.replay };
  }

  @Post('/:leadId/handoff')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async requestHandoff(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, caller, ctx } = await this.requireWrite(request);
    const key = readGrowthIdempotencyKey(request.headers['idempotency-key'], correlationId, false);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['contractReference', 'contactIds'], correlationId);
    const contactIds = raw.contactIds === undefined ? [] : Array.isArray(raw.contactIds) && raw.contactIds.length <= 10 ? raw.contactIds.map((value) => readUuid(value, correlationId)) : null;
    if (!contactIds || new Set(contactIds).size !== contactIds.length) throw badRequest('GROWTH_HANDOFF_CONTACT_INVALID', correlationId);
    const result = await this.db.transaction((tx) => runGrowthIdempotent(tx, {
      userId: ctx.actorUserId, route: 'lead.handoff', target: id, key, body, recordId: this.ids.uuid(), correlationId,
    }, 'growth_handoff_request', async () => {
      const loaded = await this.visible(tx, id, caller, correlationId, true);
      const writer = refuseGrowthStageWriter(caller, loaded.facts);
      if (writer) throw pipelineRefusal(writer, correlationId);
      const refusal = refuseGrowthHandoffRequest({ kind: loaded.row.kind, stage: loaded.row.stage, doNotContact: loaded.facts.doNotContact, handedOff: loaded.row.organization_id !== null }, raw.contractReference);
      if (refusal) throw pipelineRefusal(refusal, correlationId);
      const requestedBy = growthOwningMembership(caller, loaded.row.kind) ?? caller.memberships[0]!.membershipId;
      return createHandoffRequest(tx, ctx, { lead: loaded.row, requestedByMembershipId: requestedBy, contractReference: (raw.contractReference as string).trim(), contactIds });
    })).catch((error: unknown) => { throw mapPipelineError(error, correlationId); });
    return { ...(await this.pipeline(request, id)), requestId: result.resourceId, idempotentReplay: result.replay };
  }

  // -------------------------------------------------------------------------

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly userId: string; readonly caller: GrowthLeadCaller }> {
    const context = requireTrustedAuthorization(request);
    if (!growthWorkspaceRole(context.authorization.memberships)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    const userId = context.authorization.principal.userId;
    const caller = await loadGrowthLeadCaller(this.db, { userId, growthAdmin: false });
    if (!caller.memberships.length) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, userId, caller };
  }

  private async requireWrite(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly caller: GrowthLeadCaller; readonly ctx: WriteContext }> {
    const { correlationId, userId, caller } = await this.require(request);
    const organizationId = await platformOrganizationId(this.db);
    if (!organizationId) throw notFound('GROWTH_PLATFORM_NOT_FOUND', correlationId);
    return { correlationId, caller, ctx: { actorUserId: userId, organizationId, correlationId, uuid: () => this.ids.uuid() } };
  }

  private async visible(runner: Pick<PersistenceDb, 'execute'>, leadId: string, caller: GrowthLeadCaller, correlationId: string, lock = false) {
    const loaded = await loadLead(runner, leadId, lock);
    if (!loaded) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
    const scoped = await runner.execute(sql`SELECT 1 FROM growth_leads l WHERE l.id = ${leadId}::uuid AND ${growthScopePredicate(caller.scope, 'l')}`) as QueryResult<unknown>;
    if (!scoped.rows.length) throw notFound('GROWTH_LEAD_NOT_FOUND', correlationId);
    return loaded;
  }
}

/** Operations → Organizations: the growth handoff queue (OPS_ORG_MANAGE; a section of the existing screen). */
@Controller('/api/v1/operations/growth-handoffs')
export class OperationsGrowthHandoffsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async queue(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireOperations(request);
    return { requests: await handoffQueue(this.db), declineReasons: growthHandoffDeclineReasons, correlationId };
  }

  @Post('/:leadId/link')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async link(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireOperations(request);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['organizationId'], correlationId);
    const organizationId = readUuid(raw.organizationId, correlationId);
    const linked = await this.db.transaction((tx) => linkHandoff(tx, ctx, { leadId: id, organizationId }))
      .catch((error: unknown) => {
        if (databaseErrorText(error).code === '23505') throw conflict('GROWTH_ORGANIZATION_ALREADY_LINKED', correlationId);
        throw mapPipelineError(error, correlationId);
      });
    return { linked, correlationId };
  }

  @Post('/:leadId/decline')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async decline(@Req() request: ProtectedHttpRequest, @Param('leadId') leadId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, ctx } = await this.requireOperations(request);
    const id = readUuid(leadId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, growthHandoffDeclineReasons, correlationId);
    const requestId = await this.db.transaction((tx) => declineHandoff(tx, ctx, { leadId: id, reasonCode }))
      .catch((error: unknown) => { throw mapPipelineError(error, correlationId); });
    return { declined: { requestId, reasonCode }, correlationId };
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
