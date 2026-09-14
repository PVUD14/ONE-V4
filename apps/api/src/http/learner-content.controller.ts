/**
 * Learner content: the route that serves it and the routes that author it.
 *
 * Everything below this file already existed — the tables and their draft → review →
 * publish lifecycle since migration 0024, the domain rules in `@planthepath/learner-content`,
 * and the storage functions in the persistence package, including the rule that approval
 * needs a reviewer other than the author and publication a publisher other than the
 * approver. The only thing missing was a way to reach any of it, which is why Practice,
 * Company Prep, Career Tools, Scholarships and Resume Builder have rendered empty.
 *
 * Two things this file is careful about:
 *
 *   The learner route serves PUBLISHED rows only. A draft is somebody's unfinished
 *   thinking, and the storage function fails closed on that already; the route does not
 *   offer a state parameter that could talk it out of it.
 *
 *   An empty result is an empty result. Where nothing has been published, the answer is an
 *   empty list and the screen says so — it is never filled with a seed or an example.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  LEARNER_CONTENT_REVIEW_STATES,
  LEARNER_CONTENT_TYPES,
  LearnerContentRuleError,
  type LearnerContentReviewState,
  type LearnerContentType,
} from '@planthepath/learner-content';
import {
  createLearnerContentDraft,
  listLearnerContentReviewQueue,
  listPublishedLearnerContent,
  transitionLearnerContentReview,
  type LearnerContentRecord,
} from '@planthepath/persistence/src/learner-content.js';
import { PG_POOL } from '../persistence.provider.js';
import {
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  type ProtectedHttpRequest,
} from './api-security.js';

/** Platform roles that may write and review learner content. */
const contentRoles = ['PLATFORM_OWNER', 'PLATFORM_ADMIN', 'OPERATIONS_ADMIN', 'CONTENT_OPERATIONS'];

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('/api/v1')
export class LearnerContentController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * What a learner sees. Published only, and an empty list when nothing is published —
   * which is the honest state of most of these pages today.
   */
  @Get('/learner-content')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async published(@Req() request: ProtectedHttpRequest, @Query('contentType') contentType?: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const type = readOptionalContentType(contentType, context.correlationId);
    const items = await listPublishedLearnerContent(this.pool, type ? { contentType: type } : {});
    return { items: items.map(toLearnerView), correlationId: context.correlationId };
  }

  @Get('/operations/learner-content')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async queue(@Req() request: ProtectedHttpRequest, @Query('contentType') contentType?: string): Promise<Record<string, unknown>> {
    const context = this.requireContentOperator(request);
    const type = readOptionalContentType(contentType, context.correlationId);
    const items = await listLearnerContentReviewQueue(this.pool, type ? { contentType: type } : {});
    return { items: items.map(toOperatorView), correlationId: context.correlationId };
  }

  @Post('/operations/learner-content')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireContentOperator(request);
    const input = readDraftInput(body, context.correlationId);
    try {
      const created = await createLearnerContentDraft(this.pool, {
        id: randomId(),
        contentType: input.contentType,
        title: input.title,
        summary: input.summary,
        content: input.content,
        // AUTHORED, always. GENERATED is not an accepted source anywhere yet, and this
        // route must not be the place it quietly becomes one.
        source: 'AUTHORED',
        createdByUserId: context.authorization.principal.userId,
        sortOrder: input.sortOrder,
      });
      return { item: toOperatorView(created), correlationId: context.correlationId };
    } catch (error) {
      throw contentFailure(error, context.correlationId);
    }
  }

  @Post('/operations/learner-content/:contentId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transition(@Req() request: ProtectedHttpRequest, @Param('contentId') contentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = this.requireContentOperator(request);
    const id = requireUuid(contentId, context.correlationId);
    const toState = readReviewState(body, context.correlationId);
    const note = readOptionalNote(body, context.correlationId);
    try {
      const result = await transitionLearnerContentReview(this.pool, {
        reviewId: randomId(),
        contentId: id,
        actorUserId: context.authorization.principal.userId,
        toState,
        note,
      });
      return { item: toOperatorView(result.content), correlationId: context.correlationId };
    } catch (error) {
      throw contentFailure(error, context.correlationId);
    }
  }

  private requireContentOperator(request: ProtectedHttpRequest): ReturnType<typeof requireTrustedAuthorization> {
    const context = requireTrustedAuthorization(request);
    const permitted = context.authorization.memberships.some((membership) => (
      membership.state === 'ACTIVE' && contentRoles.includes(membership.role)
    ));
    if (!permitted) throw forbidden(context.correlationId);
    return context;
  }
}

/**
 * The learner's view. Review state, author and provenance are deliberately absent: a
 * student reads the thing, not the paperwork about the thing.
 */
function toLearnerView(record: LearnerContentRecord): Record<string, unknown> {
  return {
    id: record.id,
    contentType: record.contentType,
    title: record.title,
    summary: record.summary,
    content: record.content,
    publishedAt: record.publishedAt,
  };
}

/**
 * The operator's view, which does carry the paperwork — including the provenance columns.
 * They are null for everything today, and they are surfaced anyway so that the day a model
 * writes a draft, whoever reviews it can see that it did.
 */
function toOperatorView(record: LearnerContentRecord): Record<string, unknown> {
  return {
    id: record.id,
    contentType: record.contentType,
    title: record.title,
    summary: record.summary,
    content: record.content,
    source: record.source,
    reviewState: record.reviewState,
    generatorVersion: record.generatorVersion,
    promptVersion: record.promptVersion,
    generatedAt: record.generatedAt,
    publishedAt: record.publishedAt,
    createdByUserId: record.createdByUserId,
    sortOrder: record.sortOrder,
    updatedAt: record.updatedAt,
  };
}

function readOptionalContentType(value: string | undefined, correlationId: string): LearnerContentType | null {
  if (!value) return null;
  if (!(LEARNER_CONTENT_TYPES as readonly string[]).includes(value)) throw badRequest('INVALID_CONTENTTYPE', correlationId);
  return value as LearnerContentType;
}

function readDraftInput(body: unknown, correlationId: string): {
  readonly contentType: LearnerContentType;
  readonly title: string;
  readonly summary: string | null;
  readonly content: Record<string, unknown>;
  readonly sortOrder: number;
} {
  const raw = readObject(body, correlationId);
  const contentType = readOptionalContentType(typeof raw.contentType === 'string' ? raw.contentType : undefined, correlationId);
  if (!contentType) throw badRequest('INVALID_CONTENTTYPE', correlationId);
  const title = readText(raw.title, 200, correlationId);
  const summary = raw.summary == null ? null : readText(raw.summary, 1000, correlationId);
  const content = readObject(raw.content, correlationId);
  const sortOrder = raw.sortOrder == null ? 0 : Number(raw.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) throw badRequest('INVALID_SORTORDER', correlationId);
  return { contentType, title, summary, content, sortOrder };
}

function readReviewState(body: unknown, correlationId: string): LearnerContentReviewState {
  const raw = readObject(body, correlationId);
  const value = raw.toState;
  if (typeof value !== 'string' || !(LEARNER_CONTENT_REVIEW_STATES as readonly string[]).includes(value)) {
    throw badRequest('INVALID_TOSTATE', correlationId);
  }
  return value as LearnerContentReviewState;
}

function readOptionalNote(body: unknown, correlationId: string): string | null {
  const raw = readObject(body, correlationId);
  if (raw.note == null) return null;
  return readText(raw.note, 2000, correlationId);
}

function readObject(value: unknown, correlationId: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('INVALID_BODY', correlationId);
  return value as Record<string, unknown>;
}

function readText(value: unknown, max: number, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest('INVALID_BODY', correlationId);
  const trimmed = value.trim();
  // A leading formula character would execute if this text ever reached a spreadsheet.
  if (!trimmed || trimmed.length > max || /^[=+@-]/.test(trimmed)) throw badRequest('INVALID_BODY', correlationId);
  return trimmed;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_ID', correlationId);
  return value;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function safeError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly correlationId: string } } {
  return { error: { code, correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(safeError(code, correlationId));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

/**
 * Domain rule failures surface their code. The persistence layer raises a plain Error for
 * the separation-of-duties rules — an author approving their own work, or an approver
 * publishing it — and those are mapped to a code a screen can explain rather than leaking
 * the message.
 */
function contentFailure(error: unknown, correlationId: string): Error {
  if (error instanceof LearnerContentRuleError) return badRequest((error as LearnerContentRuleError).code, correlationId);
  const message = error instanceof Error ? error.message : '';
  if (/reviewer|author|publish/i.test(message)) return badRequest('SEPARATION_OF_DUTIES', correlationId);
  if (error instanceof RangeError) return badRequest('INVALID_BODY', correlationId);
  return badRequest('CONTENT_ACTION_FAILED', correlationId);
}
