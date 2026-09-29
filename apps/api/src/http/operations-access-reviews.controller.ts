/**
 * Operations Security — quarterly internal access reviews (OPS-15).
 *
 * A holder of SECURITY_ACCESS_REVIEW opens a campaign (a frozen snapshot of every standing
 * internal access), decides KEEP or REVOKE on each item with a reason code, closes it once
 * every item is decided, and exports it as CSV evidence. A REVOKE takes effect in the same
 * transaction and its audit rows carry the campaign reference; nobody attests their own
 * access except the marked solo case. The rules are the pure functions in
 * packages/authorization/src/access-reviews.ts, repeated by the 0079 triggers.
 *
 * Design: docs/architecture/access-review-campaigns-table-design.md
 */
import { createHash } from 'node:crypto';
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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  accessReviewCadenceMonths,
  accessReviewCampaignWindowDays,
  accessReviewCloseReasons,
  accessReviewDecisionReasons,
  accessReviewExportReasons,
  accessReviewOpenReasons,
  accessReviewSchedule,
  accessReviewSoloCoolingOffMinutes,
  decideAccessReviewItem,
  hasInternalCapability,
  refuseAccessReviewRoleRevocation,
  type AccessReviewDecision,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  AccessReviewError,
  accessReviewClock,
  accessReviewOverview,
  closeAccessReviewCampaign,
  decideAccessReviewItemRecord,
  listAccessReviewCampaigns,
  listAccessReviewItems,
  loadAccessReviewCampaign,
  loadAllAccessReviewItems,
  openAccessReviewCampaign,
  recordAccessReviewExport,
  type AccessReviewCampaignView,
  type AccessReviewItemView,
} from '@planthepath/persistence/src/access-reviews.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, requireTrustedAuthorization, type ProtectedHttpRequest } from './api-security.js';
import { loadCallerCapabilityContext, poolCapabilityGrantLoader } from './internal-capability-guard.js';
import { accessReviewCsv, accessReviewCsvFilename } from './access-review-csv.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;

type Actor = InternalCapabilityContext & { readonly userId: string };

interface CsvResponse {
  setHeader(name: string, value: string): void;
  status(code: number): CsvResponse;
  send(body: string): void;
}

@Controller('/api/v1/operations/access-reviews')
export class OperationsAccessReviewsController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Where the programme stands, the campaign history, and the reason codes for each action. */
  @Get()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async overview(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReviewer(request);
    rejectUnknown(query, ['limit', 'cursor'], correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCampaignCursor(query.cursor, correlationId);
    const [overview, page] = await Promise.all([
      accessReviewOverview(this.pool),
      listAccessReviewCampaigns(this.pool, { limit, ...(cursor ? { cursor } : {}) }),
    ]);
    const schedule = accessReviewSchedule({ now: overview.now, lastClosedAt: overview.lastClosed?.closedAt ?? null, open: overview.open });
    return {
      summary: {
        reviewerCount: overview.reviewerCount,
        soloSafeguardActive: overview.reviewerCount === 1,
        open: overview.open ? toCampaignDto(overview.open) : null,
        lastClosed: overview.lastClosed ? toCampaignDto(overview.lastClosed) : null,
        ...schedule,
      },
      campaigns: page.campaigns.map(toCampaignDto),
      nextCursor: page.nextCursor ? Buffer.from(page.nextCursor.openedAt + '|' + page.nextCursor.id, 'utf8').toString('base64url') : null,
      policy: {
        reasons: { open: accessReviewOpenReasons, decision: accessReviewDecisionReasons, close: accessReviewCloseReasons, export: accessReviewExportReasons },
        soloCoolingOffMinutes: accessReviewSoloCoolingOffMinutes,
        campaignWindowDays: accessReviewCampaignWindowDays,
        cadenceMonths: accessReviewCadenceMonths,
      },
      correlationId,
    };
  }

  @Post()
  @UseGuards(ProtectedApiAuthenticationGuard)
  async open(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReviewer(request);
    const raw = readObject(body, ['reasonCode', 'note'], correlationId);
    const reasonCode = readReason(raw.reasonCode, accessReviewOpenReasons, correlationId);
    const note = readNote(raw.note, correlationId);
    try {
      const campaign = await openAccessReviewCampaign(this.pool, { actorUserId: actor.userId, reasonCode, note, correlationId });
      return { campaign: toCampaignDto(campaign), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Get('/:campaignId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async campaign(@Req() request: ProtectedHttpRequest, @Param('campaignId') campaignId: string): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReviewer(request);
    const campaign = await this.loadCampaign(campaignId, correlationId);
    return { campaign: toCampaignDto(campaign), correlationId };
  }

  @Get('/:campaignId/items')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async items(@Req() request: ProtectedHttpRequest, @Param('campaignId') campaignId: string, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReviewer(request);
    rejectUnknown(query, ['limit', 'cursor', 'filter'], correlationId);
    const limit = readLimit(query.limit, correlationId);
    const afterPosition = decodeItemCursor(query.cursor, correlationId);
    const filter = readFilter(query.filter, correlationId);
    const campaign = await this.loadCampaign(campaignId, correlationId);
    const [page, clock] = await Promise.all([
      listAccessReviewItems(this.pool, { campaignId: campaign.id, limit, ...(afterPosition ? { afterPosition } : {}), ...(filter ? { filter } : {}) }),
      accessReviewClock(this.pool),
    ]);
    return {
      campaign: toCampaignDto(campaign),
      items: page.items.map((item) => toItemDto(item, campaign, actor, clock)),
      nextCursor: page.nextPosition ? Buffer.from(String(page.nextPosition), 'utf8').toString('base64url') : null,
      correlationId,
    };
  }

  @Post('/:campaignId/items/:itemId/decision')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async decide(
    @Req() request: ProtectedHttpRequest,
    @Param('campaignId') campaignId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReviewer(request);
    const campaignUuid = requireUuid(campaignId, correlationId);
    const itemUuid = requireUuid(itemId, correlationId);
    const raw = readObject(body, ['decision', 'reasonCode', 'note'], correlationId);
    const decision = readDecision(raw.decision, correlationId);
    const reasonCode = readReason(raw.reasonCode, accessReviewDecisionReasons[decision], correlationId);
    const note = readNote(raw.note, correlationId);
    try {
      const item = await decideAccessReviewItemRecord(this.pool, {
        campaignId: campaignUuid, itemId: itemUuid, decision, reasonCode, note, actorUserId: actor.userId, correlationId,
        decide: (context) => decideAccessReviewItem({ ...context, actor, decision }),
        refuseRoleRevocation: refuseAccessReviewRoleRevocation,
      });
      const campaign = (await loadAccessReviewCampaign(this.pool, campaignUuid))!;
      return { item: toItemDto(item, campaign, actor, await accessReviewClock(this.pool)), campaign: toCampaignDto(campaign), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/:campaignId/close')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async close(@Req() request: ProtectedHttpRequest, @Param('campaignId') campaignId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReviewer(request);
    const id = requireUuid(campaignId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, accessReviewCloseReasons, correlationId);
    try {
      const campaign = await closeAccessReviewCampaign(this.pool, { campaignId: id, actorUserId: actor.userId, reasonCode, correlationId });
      return { campaign: toCampaignDto(campaign), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** The campaign as CSV evidence. The export itself is audited, with the file's SHA-256. */
  @Post('/:campaignId/export')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async export(@Req() request: ProtectedHttpRequest, @Param('campaignId') campaignId: string, @Body() body: unknown, @Res() response: CsvResponse): Promise<void> {
    const { correlationId, actor } = await this.requireReviewer(request);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = readReason(raw.reasonCode, accessReviewExportReasons, correlationId);
    const campaign = await this.loadCampaign(campaignId, correlationId);
    const clock = await accessReviewClock(this.pool);
    const items = (await loadAllAccessReviewItems(this.pool, campaign.id)).map((item) => toItemDto(item, campaign, actor, clock));
    const dto = toCampaignDto(campaign);
    const csv = accessReviewCsv(dto, items);
    await recordAccessReviewExport(this.pool, {
      campaignId: campaign.id, actorUserId: actor.userId, reasonCode, correlationId, rows: items.length, periodLabel: campaign.periodLabel,
      sha256: createHash('sha256').update(csv, 'utf8').digest('hex'),
    });
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${accessReviewCsvFilename(dto)}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Correlation-Id', correlationId);
    response.status(200).send(csv);
  }

  private async loadCampaign(campaignId: string, correlationId: string): Promise<AccessReviewCampaignView> {
    const campaign = await loadAccessReviewCampaign(this.pool, requireUuid(campaignId, correlationId));
    if (!campaign) throw new NotFoundException(domainError('ACCESS_REVIEW_NOT_FOUND', correlationId));
    return campaign;
  }

  private async requireReviewer(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, poolCapabilityGrantLoader(this.pool));
    if (!hasInternalCapability(actor, 'SECURITY_ACCESS_REVIEW')) throw new ForbiddenException(domainError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

/** User ids stay on the server; the screen and the file identify people by email. */
function toCampaignDto(campaign: AccessReviewCampaignView) {
  return {
    id: campaign.id,
    periodLabel: campaign.periodLabel,
    state: campaign.state,
    openedBy: { email: campaign.openedBy.email },
    openedAt: campaign.openedAt,
    dueAt: campaign.dueAt,
    openReasonCode: campaign.openReasonCode,
    openNote: campaign.openNote,
    itemCount: campaign.itemCount,
    closedBy: campaign.closedBy ? { email: campaign.closedBy.email } : null,
    closedAt: campaign.closedAt,
    closeReasonCode: campaign.closeReasonCode,
    counts: campaign.counts,
  };
}

function toItemDto(item: AccessReviewItemView, campaign: AccessReviewCampaignView, actor: Actor, clock: { readonly reviewerCount: number; readonly now: string }) {
  const context = {
    actor, reviewerCount: clock.reviewerCount, now: clock.now,
    campaign: { state: campaign.state, openedAt: campaign.openedAt },
    item: { subjectUserId: item.subject.userId, decided: item.decision !== null },
  };
  const keep = decideAccessReviewItem({ ...context, decision: 'KEEP' });
  const revoke = decideAccessReviewItem({ ...context, decision: 'REVOKE' });
  const refusal = !keep.allowed ? keep : !revoke.allowed ? revoke : null;
  return {
    id: item.id,
    position: item.position,
    kind: item.kind,
    subject: { email: item.subject.email, isSelf: item.subject.userId === actor.userId },
    organizationName: item.organizationName,
    organizationKind: item.organizationKind,
    role: item.role,
    membershipState: item.membershipState,
    capability: item.capability,
    capabilities: item.capabilities,
    highRisk: item.highRisk,
    grantedBy: item.grantedBy ? { email: item.grantedBy.email } : null,
    grantedAt: item.grantedAt,
    grantReasonCode: item.grantReasonCode,
    decision: item.decision,
    decisionReasonCode: item.decisionReasonCode,
    decisionNote: item.decisionNote,
    decidedBy: item.decidedBy ? { email: item.decidedBy.email } : null,
    decidedAt: item.decidedAt,
    mode: item.mode,
    revocationOutcome: item.revocationOutcome,
    canKeep: keep.allowed,
    canRevoke: revoke.allowed,
    keepMode: keep.allowed ? keep.mode : null,
    refusal: refusal && !refusal.allowed ? refusal.refusal : null,
    coolingOffEndsAt: !keep.allowed && keep.coolingOffEndsAt ? keep.coolingOffEndsAt : null,
  };
}

/** safeError types only the authentication codes; these are domain codes in the same shape. */
function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

const forbiddenCodes = new Set(['FORBIDDEN', 'ACCESS_REVIEW_OWN_ACCESS', 'ACCESS_REVIEW_SOLO_COOLING_OFF', 'ACCESS_REVIEW_LAST_SUPER_ADMIN']);
const conflictCodes = new Set(['ACCESS_REVIEW_ALREADY_OPEN', 'ACCESS_REVIEW_NOT_OPEN', 'ACCESS_REVIEW_ALREADY_DECIDED', 'ACCESS_REVIEW_UNDECIDED_ITEMS']);

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof AccessReviewError) {
    if (error.code === 'ACCESS_REVIEW_NOT_FOUND') return new NotFoundException(domainError(error.code, correlationId));
    if (forbiddenCodes.has(error.code)) return new ForbiddenException(domainError(error.code, correlationId));
    if (conflictCodes.has(error.code)) return new ConflictException(domainError(error.code, correlationId));
  }
  // Never forward database or driver text to the browser.
  return badRequest('ACCESS_REVIEW_REJECTED', correlationId);
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

function readDecision(value: unknown, correlationId: string): AccessReviewDecision {
  if (value !== 'KEEP' && value !== 'REVOKE') throw badRequest('ACCESS_REVIEW_DECISION_INVALID', correlationId);
  return value;
}

function readReason(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('REASON_CODE_INVALID', correlationId);
  return value;
}

function readNote(value: unknown, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > noteLimit) throw badRequest('NOTE_INVALID', correlationId);
  return value.trim() || null;
}

function readFilter(value: unknown, correlationId: string): 'UNDECIDED' | 'DECIDED' | undefined {
  if (value === undefined || value === '') return undefined;
  if (value !== 'UNDECIDED' && value !== 'DECIDED') throw badRequest('ACCESS_REVIEW_FILTER_INVALID', correlationId);
  return value;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('ACCESS_REVIEW_LIMIT_INVALID', correlationId);
  return parsed;
}

function decodeCampaignCursor(value: unknown, correlationId: string): { readonly openedAt: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('ACCESS_REVIEW_CURSOR_INVALID', correlationId);
  const [openedAt, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!openedAt || !id || rest.length || Number.isNaN(Date.parse(openedAt)) || !uuidPattern.test(id)) {
    throw badRequest('ACCESS_REVIEW_CURSOR_INVALID', correlationId);
  }
  return { openedAt, id };
}

function decodeItemCursor(value: unknown, correlationId: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('ACCESS_REVIEW_CURSOR_INVALID', correlationId);
  const position = Number(Buffer.from(value, 'base64url').toString('utf8'));
  if (!Number.isInteger(position) || position < 1) throw badRequest('ACCESS_REVIEW_CURSOR_INVALID', correlationId);
  return position;
}
