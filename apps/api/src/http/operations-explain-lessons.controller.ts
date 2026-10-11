/**
 * Operations Content Management — "Ask ONE to explain" review by exception (ADR-052).
 *
 * Under Divakar's scoped waiver these lessons reach students without a person reading them first, so
 * operations reviews by exception: the lessons students flagged and the most read ones, with two actions —
 * withdraw (hidden from every student at once; CONTENT_REVIEW; single-person, because taking content down
 * must never wait) and promote to an official draft (CONTENT_EDIT; creates a DRAFT lesson in the lesson
 * editor with the AI provenance, which then follows the normal review and OPS-02 publish). Both carry a
 * reason code from code and are audited. Nothing here names who asked or who reported, and nothing here
 * calls a model. Android shows none of it (Operations on Android is view-only).
 *
 * Design: docs/architecture/ask-to-explain-design.md (Decision 6).
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  canPromoteExplainLesson,
  canReadExplainLessons,
  canWithdrawExplainLesson,
  explainPromoteCapability,
  explainPromoteReasons,
  explainReviewViews,
  explainWithdrawCapability,
  explainWithdrawReasons,
  refuseExplainReview,
  resolveInternalCapability,
  type ExplainReviewView,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  ExplainError,
  listExplainLessonsForReview,
  promoteExplainLesson,
  withdrawExplainLesson,
} from '@planthepath/persistence/src/explain-topic.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function domainError(code: string, correlationId: string, problems?: readonly string[]): Record<string, unknown> {
  return { error: { code, message: 'The request could not be completed.', correlationId, ...(problems?.length ? { problems } : {}) } };
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
  return raw;
}

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof ExplainError) {
    if (error.code === 'EXPLAIN_LESSON_NOT_FOUND') return new NotFoundException(domainError(error.code, correlationId));
    if (['EXPLAIN_NOT_REVIEWABLE', 'EXPLAIN_ALREADY_WITHDRAWN', 'EXPLAIN_ALREADY_PROMOTED', 'LESSON_KEY_EXISTS'].includes(error.code)) {
      return new ConflictException(domainError(error.code, correlationId));
    }
    return new BadRequestException(domainError(error.code, correlationId, error.problems));
  }
  return new BadRequestException(domainError('EXPLAIN_REVIEW_REJECTED', correlationId));
}

@Controller('/api/v1/operations/explain-lessons')
export class OperationsExplainLessonsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** The queue: flagged (reports first), most-viewed, withdrawn or promoted; what the viewer may do. */
  @Get('/')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.caller(request);
    if (!canReadExplainLessons(actor)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (Object.keys(query).some((key) => !['view', 'limit'].includes(key))) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
    const view = (query.view === undefined || query.view === '' ? 'flagged' : query.view) as ExplainReviewView;
    if (!(explainReviewViews as readonly unknown[]).includes(view)) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
    const limit = query.limit === undefined || query.limit === '' ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException(domainError('LIMIT_INVALID', correlationId));
    const found = await listExplainLessonsForReview(this.db, { view, limit });
    return {
      ...found,
      viewer: { canWithdraw: canWithdrawExplainLesson(actor), canPromote: canPromoteExplainLesson(actor) },
      reasons: { withdraw: explainWithdrawReasons, promote: explainPromoteReasons },
      correlationId,
    };
  }

  /** Withdraw: hidden from every student on their next read. Immediate; audited. */
  @Post('/:lessonId/withdraw')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async withdraw(@Req() request: ProtectedHttpRequest, @Param('lessonId') lessonId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.caller(request);
    if (!canReadExplainLessons(actor) && !canWithdrawExplainLesson(actor)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (!uuidPattern.test(lessonId)) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = typeof raw.reasonCode === 'string' ? raw.reasonCode : '';
    const refusal = refuseExplainReview({ actor, action: 'WITHDRAW', reasonCode });
    if (refusal === 'FORBIDDEN') throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (refusal) throw new BadRequestException(domainError(refusal, correlationId));
    try {
      const lesson = await withdrawExplainLesson(this.db, {
        userId: actor.userId, correlationId, breakGlass: resolveInternalCapability(actor, explainWithdrawCapability) === 'BREAK_GLASS',
      }, { lessonId: lessonId.toLowerCase(), reasonCode });
      return { lesson, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Promote to an official draft: a DRAFT lesson authored by the promoter, with the AI provenance. Audited. */
  @Post('/:lessonId/promote')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async promote(@Req() request: ProtectedHttpRequest, @Param('lessonId') lessonId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.caller(request);
    if (!canReadExplainLessons(actor) && !canPromoteExplainLesson(actor)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (!uuidPattern.test(lessonId)) throw new BadRequestException(domainError('INVALID_REQUEST', correlationId));
    const raw = readObject(body, ['reasonCode', 'stableKey', 'title', 'level', 'style'], correlationId);
    const reasonCode = typeof raw.reasonCode === 'string' ? raw.reasonCode : '';
    const refusal = refuseExplainReview({ actor, action: 'PROMOTE', reasonCode });
    if (refusal === 'FORBIDDEN') throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (refusal) throw new BadRequestException(domainError(refusal, correlationId));
    try {
      const lesson = await promoteExplainLesson(this.db, {
        userId: actor.userId, correlationId, breakGlass: resolveInternalCapability(actor, explainPromoteCapability) === 'BREAK_GLASS',
      }, { lessonId: lessonId.toLowerCase(), reasonCode, stableKey: raw.stableKey, title: raw.title, level: raw.level, style: raw.style });
      return { lesson, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  private async caller(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    return { correlationId: context.correlationId, actor };
  }
}
