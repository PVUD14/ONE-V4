/**
 * Operations Settings — communication templates and status notices (OPS-16, Appendix 1 §3
 * Communications, §5.3, §5.4).
 *
 * COMMS_TEMPLATES covers both halves. Templates: draft a new version of a status-notice template
 * (existing notification_templates versioning), have a second person approve it through OPS-02
 * dual control (COMMS_TEMPLATE_PUBLISH, requested by the author), then publish it with that
 * approval. Notices: draft a notice for an incident from a published version, approve it for
 * sending (rate-limited on the database clock; by a person other than its drafter, or by the sole
 * approver after OPS-02's cooling-off, marked SOLO — 0090), or withdraw it. Sending happens in the outbox
 * worker, to the administrators of the incident's affected organisations, never to students and
 * never as free text; email is NOT_CONFIGURED until a mail service exists.
 *
 * Design: docs/architecture/incident-register-table-design.md
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
import {
  commsTemplateDraftReasons,
  commsTemplatePublishReasons,
  commsTemplateWithdrawReasons,
  hasInternalCapability,
  statusNoticeApproveReasons,
  statusNoticeDailyLimit,
  statusNoticeDraftReasons,
  statusNoticeMinimumSpacingMinutes,
  statusNoticeSoloCoolingOffMinutes,
  statusNoticeTemplateKeyPattern,
  statusNoticeWithdrawReasons,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  approveStatusNotice,
  countStatusNoticeApprovers,
  draftStatusNotice,
  draftStatusNoticeTemplate,
  listNoticeableIncidents,
  listStatusNotices,
  listStatusNoticeTemplates,
  loadStatusNotice,
  loadStatusNoticeTemplate,
  publishStatusNoticeTemplate,
  StatusNoticeError,
  withdrawStatusNotice,
  withdrawStatusNoticeTemplate,
  type StatusNoticeRow,
  type StatusNoticeTemplateRow,
} from '@planthepath/persistence/src/status-notices.js';
import { countHighRiskApprovers } from '@planthepath/persistence/src/operation-approvals.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, approvalRequired, readApprovalId } from './operation-approval-gate.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultLimit = 50;
const maxLimit = 200;
const templateStates = ['DRAFT', 'PUBLISHED', 'WITHDRAWN'] as const;

@Controller('/api/v1/operations/communications')
export class OperationsCommunicationsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** What the screen needs: reason codes, the rate limit, the approver count and incidents a notice can address. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request);
    const approverCount = await countHighRiskApprovers(this.db);
    const noticeApproverCount = await countStatusNoticeApprovers(this.db);
    return {
      reasons: {
        templateDraft: commsTemplateDraftReasons,
        templatePublish: commsTemplatePublishReasons,
        templateWithdraw: commsTemplateWithdrawReasons,
        noticeDraft: statusNoticeDraftReasons,
        noticeApprove: statusNoticeApproveReasons,
        noticeWithdraw: statusNoticeWithdrawReasons,
      },
      rateLimit: { minimumSpacingMinutes: statusNoticeMinimumSpacingMinutes, dailyLimit: statusNoticeDailyLimit },
      approverCount,
      soloSafeguardActive: approverCount === 1,
      // 0090: who can approve a notice for sending (COMMS_TEMPLATES holders); while only one person
      // can, they may approve their own notice after the cooling-off, marked SOLO.
      noticeApproverCount,
      noticeSoloSafeguardActive: noticeApproverCount === 1,
      soloCoolingOffMinutes: statusNoticeSoloCoolingOffMinutes,
      incidents: await listNoticeableIncidents(this.db),
      correlationId,
    };
  }

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  @Get('/templates')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async templates(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    rejectUnknown(query, ['state', 'limit', 'cursor'], correlationId);
    const state = query.state === undefined || query.state === '' ? undefined : requireEnum(query.state, templateStates, 'COMMS_TEMPLATE_STATE_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listStatusNoticeTemplates(this.db, { ...(state ? { state } : {}), limit, ...(cursor ? { cursor: { draftedAt: cursor.at, id: cursor.id } } : {}) });
    return {
      templates: page.templates.map((row) => templateDto(row, actor)),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor.draftedAt, page.nextCursor.id) : null,
      correlationId,
    };
  }

  @Post('/templates')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async draftTemplate(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const raw = readObject(body, ['templateKey', 'subject', 'body', 'reasonCode'], correlationId);
    if (typeof raw.templateKey !== 'string' || !statusNoticeTemplateKeyPattern.test(raw.templateKey)) throw badRequest('COMMS_TEMPLATE_KEY_INVALID', correlationId);
    const subject = requireText(raw.subject, 3, 160, 'COMMS_TEMPLATE_SUBJECT_INVALID', correlationId);
    const text = requireText(raw.body, 3, 500, 'COMMS_TEMPLATE_BODY_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, commsTemplateDraftReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      const { id } = await draftStatusNoticeTemplate(this.db, { templateKey: raw.templateKey, subject, body: text, reasonCode, actorUserId: actor.userId, correlationId });
      return { template: templateDto((await loadStatusNoticeTemplate(this.db, id))!, actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Publish an approved version. Without a valid COMMS_TEMPLATE_PUBLISH approval: 403 APPROVAL_REQUIRED. */
  @Post('/templates/:templateId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publishTemplate(@Req() request: ProtectedHttpRequest, @Param('templateId') templateId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(templateId, correlationId);
    const raw = readObject(body, ['reasonCode', 'approvalId'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, commsTemplatePublishReasons, 'REASON_CODE_INVALID', correlationId);
    const approvalId = readApprovalId(body, correlationId) ?? null;
    try {
      const published = await publishStatusNoticeTemplate(this.db, {
        templateId: id, reasonCode, approvalId, actorUserId: actor.userId, correlationId,
        approvalPayload: (contentHash) => approvalPayloads.COMMS_TEMPLATE_PUBLISH({ templateId: id, contentHash, reasonCode }),
      });
      return {
        template: templateDto((await loadStatusNoticeTemplate(this.db, id))!, actor),
        approval: { id: published.approvalId, mode: published.mode },
        correlationId,
      };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/templates/:templateId/withdraw')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async withdrawTemplate(@Req() request: ProtectedHttpRequest, @Param('templateId') templateId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(templateId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, commsTemplateWithdrawReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await withdrawStatusNoticeTemplate(this.db, { templateId: id, reasonCode, actorUserId: actor.userId, correlationId });
      return { template: templateDto((await loadStatusNoticeTemplate(this.db, id))!, actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------
  // Notices
  // -------------------------------------------------------------------------

  @Get('/notices')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async notices(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    rejectUnknown(query, ['incidentId', 'limit', 'cursor'], correlationId);
    const incidentId = query.incidentId === undefined || query.incidentId === '' ? undefined : requireUuid(query.incidentId, correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listStatusNotices(this.db, { ...(incidentId ? { incidentId } : {}), limit, ...(cursor ? { cursor: { draftedAt: cursor.at, id: cursor.id } } : {}) });
    return {
      notices: page.notices.map((notice) => noticeDto(notice, actor)),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor.draftedAt, page.nextCursor.id) : null,
      correlationId,
    };
  }

  @Post('/notices')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async draftNotice(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    // Deliberately no subject or body field: a notice is only ever a published template version.
    const raw = readObject(body, ['incidentId', 'templateId', 'reasonCode'], correlationId);
    const incidentId = requireUuid(raw.incidentId, correlationId);
    const templateId = requireUuid(raw.templateId, correlationId);
    const reasonCode = requireEnum(raw.reasonCode, statusNoticeDraftReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      const { id } = await draftStatusNotice(this.db, { incidentId, templateId, reasonCode, actorUserId: actor.userId, correlationId });
      return { notice: noticeDto(await loadStatusNotice(this.db, id), actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * A person other than its drafter approves a drafted notice for sending (the sole approver may
   * approve their own after the cooling-off, marked SOLO); the outbox worker sends it.
   */
  @Post('/notices/:noticeId/approve')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async approveNotice(@Req() request: ProtectedHttpRequest, @Param('noticeId') noticeId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(noticeId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, statusNoticeApproveReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await approveStatusNotice(this.db, { noticeId: id, reasonCode, actorUserId: actor.userId, correlationId });
      return { notice: noticeDto(await loadStatusNotice(this.db, id), actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/notices/:noticeId/withdraw')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async withdrawNotice(@Req() request: ProtectedHttpRequest, @Param('noticeId') noticeId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request);
    const id = requireUuid(noticeId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, statusNoticeWithdrawReasons, 'REASON_CODE_INVALID', correlationId);
    try {
      await withdrawStatusNotice(this.db, { noticeId: id, reasonCode, actorUserId: actor.userId, correlationId });
      return { notice: noticeDto(await loadStatusNotice(this.db, id), actor), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private async require(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!hasInternalCapability(actor, 'COMMS_TEMPLATES')) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

/** A template version as the screen needs it; the author is named by email, never by id. */
function templateDto(row: StatusNoticeTemplateRow, actor: Actor): Record<string, unknown> {
  const own = row.draftedBy.userId === actor.userId;
  const approval = row.pendingApproval;
  return {
    id: row.id, templateKey: row.templateKey, version: row.version, subject: row.subject, body: row.body, contentHash: row.contentHash,
    state: row.state, draftedBy: { email: row.draftedBy.email, isSelf: own }, draftedAt: row.draftedAt, publishedAt: row.publishedAt,
    approvedBy: row.approvedBy, publishMode: row.publishMode, withdrawnAt: row.withdrawnAt,
    approval: approval ? { id: approval.id, state: approval.state } : null,
    canRequestApproval: own && row.state === 'DRAFT' && (!approval || !['PENDING', 'APPROVED'].includes(approval.state)),
    canPublish: own && row.state === 'DRAFT' && approval?.state === 'APPROVED',
  };
}

/**
 * A notice as the screen needs it: whether the viewer drafted it (so the screen can say someone
 * else approves), never the drafter's id.
 */
function noticeDto(row: StatusNoticeRow | null, actor: Actor): Record<string, unknown> | null {
  if (!row) return null;
  const { draftedByUserId, ...rest } = row;
  return { ...rest, draftedBySelf: draftedByUserId === actor.userId };
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  const approval = approvalHttpError(error, correlationId);
  if (approval) return approval;
  if (error instanceof StatusNoticeError) {
    if (error.code === 'APPROVAL_REQUIRED') return approvalRequired(correlationId);
    if (error.code.endsWith('_NOT_FOUND')) return new NotFoundException(domainError(error.code, correlationId));
    if (error.code === 'STATUS_NOTICE_RATE_LIMITED') return new HttpException(domainError(error.code, correlationId), 429);
    // 0090: the drafter approving their own notice while someone else could, or before the cooling-off.
    if (error.code === 'STATUS_NOTICE_SELF_APPROVAL_REFUSED' || error.code === 'STATUS_NOTICE_SOLO_COOLING_OFF') {
      return new ForbiddenException(domainError(error.code, correlationId));
    }
    if (['COMMS_TEMPLATE_NOT_DRAFT', 'STATUS_NOTICE_NOT_DRAFT', 'STATUS_NOTICE_INCIDENT_CLOSED', 'STATUS_NOTICE_NO_AUDIENCE'].includes(error.code)) {
      return new ConflictException(domainError(error.code, correlationId));
    }
    return badRequest(error.code, correlationId);
  }
  // Never forward database or driver text to the browser.
  return badRequest('COMMUNICATION_REJECTED', correlationId);
}

function rejectUnknown(raw: Record<string, unknown>, allowed: readonly string[], correlationId: string): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  rejectUnknown(raw, allowed, correlationId);
  return raw;
}

function requireUuid(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value.toLowerCase();
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw badRequest(code, correlationId);
  return value as T;
}

function requireText(value: unknown, min: number, max: number, code: string, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim();
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('COMMUNICATION_LIMIT_INVALID', correlationId);
  return parsed;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): { readonly at: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('COMMUNICATION_CURSOR_INVALID', correlationId);
  const [at, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!at || !id || rest.length || Number.isNaN(Date.parse(at)) || !uuidPattern.test(id)) throw badRequest('COMMUNICATION_CURSOR_INVALID', correlationId);
  return { at, id };
}
