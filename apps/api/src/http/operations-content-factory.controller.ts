/**
 * Operations Content Management — the content factory (ENG-23): "Draft with AI".
 *
 * An editor asks ONE's AI to draft a lesson for a skill, a language variant of a live lesson or a
 * practice question with its hint ladder; a reviewer asks it to check a question's answer key. This
 * controller only queues the job (a row, its audit and an outbox event, in one transaction) and
 * reads jobs back. It never calls a model and never imports anything that can (CLAUDE.md; the
 * contract test apps/api/src/inference-boundary.spec.ts): the content factory worker runs the job
 * through ONE AI Orchestration, and what passes the guard lands in the lesson editor or the question
 * bank as a DRAFT authored by the requester — so they never review, approve or publish it, and it
 * goes through exactly the same review and second-person publish as anything a person wrote.
 *
 * Requests are refused with a typed code while the feature is off, the kill switch is engaged or
 * the cap would be reached. An answer check's result shows whether the key is right, so it is
 * withheld from anyone who may not see answer keys.
 *
 * Design: docs/architecture/content-factory-design.md
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  canReadContentFactory,
  canSeeAnswerChecks,
  contentFactoryAuthorNoteMax,
  contentFactoryKinds,
  contentFactoryReasons,
  hasInternalCapability,
  refuseContentDraftRequest,
  resolveInternalCapability,
  contentFactoryCapability,
  type ContentFactoryKind,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  ContentFactoryError,
  listContentDrafts,
  loadContentDraft,
  loadContentFactoryStatus,
  requestContentDraft,
  type ContentDraftView,
} from '@planthepath/persistence/src/content-factory.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;
const defaultLimit = 20;
const maxLimit = 100;

@Controller('/api/v1/operations/content-factory')
export class OperationsContentFactoryController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** Whether each AI feature is available, its cap and today's use, and what the viewer may ask for. */
  @Get('/status')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async status(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    return {
      ...(await loadContentFactoryStatus(this.db, actor.userId)),
      viewer: {
        userId: actor.userId,
        mayRequest: Object.fromEntries(contentFactoryKinds.map((kind) => [kind, hasInternalCapability(actor, contentFactoryCapability(kind))])),
        seesAnswerChecks: canSeeAnswerChecks(actor),
      },
      reasons: contentFactoryReasons,
      limits: { authorNote: contentFactoryAuthorNoteMax },
      correlationId,
    };
  }

  @Get('/drafts')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    rejectUnknown(query, ['kinds', 'mine', 'topicKey', 'baseLessonId', 'questionRevisionId', 'producedRevisionId', 'limit'], correlationId);
    const kinds = query.kinds === undefined || query.kinds === '' ? undefined : String(query.kinds).split(',').map((kind) => requireEnum(kind, contentFactoryKinds, 'AI_DRAFT_KIND_INVALID', correlationId));
    if (query.mine !== undefined && query.mine !== 'true' && query.mine !== 'false') throw badRequest('INVALID_REQUEST', correlationId);
    const topicKey = query.topicKey === undefined || query.topicKey === '' ? undefined : requireKey(query.topicKey, correlationId);
    const topicId = topicKey ? await this.topicIdOf(topicKey) : undefined;
    if (topicKey && !topicId) return { drafts: [], correlationId };
    const drafts = await listContentDrafts(this.db, {
      ...(kinds ? { kinds } : {}),
      ...(query.mine === 'true' ? { requestedBy: actor.userId } : {}),
      ...(topicId ? { topicId } : {}),
      ...(query.baseLessonId ? { baseLessonId: requireUuid(query.baseLessonId, correlationId) } : {}),
      ...(query.questionRevisionId ? { questionRevisionId: requireUuid(query.questionRevisionId, correlationId) } : {}),
      ...(query.producedRevisionId ? { producedRevisionId: requireUuid(query.producedRevisionId, correlationId) } : {}),
      limit: readLimit(query.limit, correlationId),
    });
    return { drafts: drafts.map((draft) => forViewer(draft, actor)), correlationId };
  }

  @Get('/drafts/:jobId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('jobId') jobId: string): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    const draft = await loadContentDraft(this.db, requireUuid(jobId, correlationId));
    if (!draft) throw new NotFoundException(domainError('AI_DRAFT_NOT_FOUND', correlationId));
    return { draft: forViewer(draft, actor), correlationId };
  }

  /** Queue one job. No model is called here: the content factory worker runs it. */
  @Post('/drafts')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    const raw = readObject(body, ['kind', 'topicKey', 'baseLessonId', 'questionRevisionId', 'stableKey', 'title', 'language', 'level', 'style', 'authorNote', 'reasonCode'], correlationId);
    const kind = typeof raw.kind === 'string' ? raw.kind : '';
    const reasonCode = typeof raw.reasonCode === 'string' ? raw.reasonCode : '';
    const refusal = refuseContentDraftRequest({ actor, kind, reasonCode });
    if (refusal === 'FORBIDDEN') throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (refusal) throw badRequest(refusal, correlationId);
    const typed = kind as ContentFactoryKind;
    const text = (value: unknown, code: string): string | null => {
      if (value === undefined || value === null || value === '') return null;
      if (typeof value !== 'string') throw badRequest(code, correlationId);
      return value;
    };
    const authorNote = text(raw.authorNote, 'AI_NOTE_INVALID');
    if (authorNote !== null && authorNote.trim().length > contentFactoryAuthorNoteMax) throw badRequest('AI_NOTE_INVALID', correlationId);
    try {
      const { jobId } = await requestContentDraft(this.db, {
        kind: typed,
        topicKey: text(raw.topicKey, 'AI_DRAFT_INVALID'),
        baseLessonId: raw.baseLessonId === undefined || raw.baseLessonId === null ? null : requireUuid(raw.baseLessonId, correlationId),
        questionRevisionId: raw.questionRevisionId === undefined || raw.questionRevisionId === null ? null : requireUuid(raw.questionRevisionId, correlationId),
        stableKey: text(raw.stableKey, 'AI_DRAFT_INVALID'),
        title: text(raw.title, 'AI_DRAFT_INVALID'),
        language: text(raw.language, 'AI_DRAFT_INVALID'),
        level: text(raw.level, 'AI_DRAFT_INVALID'),
        style: text(raw.style, 'AI_DRAFT_INVALID'),
        authorNote,
        reasonCode,
        actor: { userId: actor.userId, correlationId, breakGlass: resolveInternalCapability(actor, contentFactoryCapability(typed)) === 'BREAK_GLASS' },
      });
      const draft = await loadContentDraft(this.db, jobId);
      return { draft: draft ? forViewer(draft, actor) : null, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private async topicIdOf(topicKey: string): Promise<string | undefined> {
    const result = await this.db.execute(sqlTopic(topicKey)) as unknown as { rows: { id: string }[] };
    return result.rows[0]?.id;
  }

  private async requireReader(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!canReadContentFactory(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

function sqlTopic(topicKey: string) {
  return sql`SELECT id FROM taxonomy_nodes WHERE kind = 'TOPIC' AND stable_key = ${topicKey} ORDER BY version DESC LIMIT 1`;
}

/** An answer check shows whether the key is right: withheld from anyone who may not see answer keys. */
function forViewer(draft: ContentDraftView, actor: Actor): ContentDraftView {
  if (draft.kind !== 'ANSWER_CHECK' || canSeeAnswerChecks(actor)) return draft;
  return { ...draft, check: null };
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function domainError(code: string, correlationId: string, problems?: readonly string[]): Record<string, unknown> {
  return { error: { code, message: 'The request could not be completed.', correlationId, ...(problems?.length ? { problems } : {}) } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

const conflicts: readonly string[] = ['AI_FEATURE_NOT_REGISTERED', 'AI_KILL_SWITCH_ENGAGED', 'AI_FEATURE_DISABLED', 'AI_PROMPT_NOT_SUPPORTED', 'AI_DRAFT_KEY_EXISTS', 'AI_DRAFT_VARIANT_EXISTS'];
const tooMany: readonly string[] = ['AI_CAP_REACHED', 'AI_DRAFTS_IN_FLIGHT'];
const notFound: readonly string[] = ['AI_DRAFT_BASE_NOT_FOUND', 'AI_DRAFT_QUESTION_NOT_FOUND', 'AI_DRAFT_NOT_FOUND'];

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof ContentFactoryError) {
    if (conflicts.includes(error.code)) return new ConflictException(domainError(error.code, correlationId));
    if (tooMany.includes(error.code)) return new HttpException(domainError(error.code, correlationId), HttpStatus.TOO_MANY_REQUESTS);
    if (notFound.includes(error.code)) return new NotFoundException(domainError(error.code, correlationId));
    return new BadRequestException(domainError(error.code, correlationId, error.problems));
  }
  // Never forward database or driver text to the browser.
  return badRequest('AI_DRAFT_REJECTED', correlationId);
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

function requireKey(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw badRequest(code, correlationId);
  return value as T;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const limit = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw badRequest('LIMIT_INVALID', correlationId);
  return limit;
}
