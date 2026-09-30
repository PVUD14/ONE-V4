/**
 * Operations Content Management — the lesson and variant editor (OPS-09c, Appendix 1 §3 Content,
 * §4.2, §5.3, §5.4).
 *
 * Lessons are versioned LESSON content revisions taken from draft through review — which includes
 * the rights review — to a publish that writes the `lesson_versions` row students complete, through
 * a release manifest. A variant renders a live lesson in another language, level or style, and is
 * reviewed and published the same way; it writes no lesson version (ENG-16 serves it). Review
 * follows the learner-content lifecycle: the author, every editor and the submitter never review or
 * publish their revision, and its approver never publishes it. Publishing needs CONTENT_PUBLISH
 * and, when completing the lesson would produce different evidence, a second person's approval.
 * Every write carries a reason code from packages/authorization and writes its audit row (and
 * events) in one transaction. Nothing here is a learner route.
 *
 * Design: docs/architecture/lesson-variant-editor-design.md
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
  canReadLessons,
  contentArchiveReasons,
  hasInternalCapability,
  lessonEditorReasons,
  lessonPublishReasons,
  lessonRevisionTransitions,
  lessonTransitionCapability,
  refuseContentArchive,
  refuseLessonPublish,
  refuseLessonTransition,
  resolveInternalCapability,
  type InternalCapability,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  archiveLesson,
  createLesson,
  createLessonVariant,
  LESSON_ATTRIBUTION_MAX,
  LESSON_BASIS_MAX,
  LESSON_LANGUAGE_NAMES,
  LESSON_LANGUAGES,
  LESSON_LEVEL_MEANINGS,
  LESSON_LEVELS,
  LESSON_LICENCES,
  LESSON_LICENCES_REQUIRING_ATTRIBUTION,
  LESSON_PRACTICE_MAX,
  LESSON_PREREQUISITES_MAX,
  LESSON_STABLE_KEY_PATTERN,
  LESSON_STYLE_MEANINGS,
  LESSON_STYLES,
  LESSON_SUMMARY_MAX,
  LESSON_TITLE_MAX,
  LessonEditorError,
  LessonEditorRefused,
  listLessonModules,
  listLessons,
  loadLesson,
  publishLessonRevision,
  saveLessonDraft,
  startLessonRevision,
  summariseLessons,
  transitionLessonRevision,
  type LessonActor,
  type LessonDraftInput,
  type LessonLanguage,
  type LessonLevel,
  type LessonLicence,
  type LessonListFilter,
  type LessonStyle,
} from '@planthepath/persistence/src/lesson-editor.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, approvalRequired, readApprovalId } from './operation-approval-gate.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;
const listFilters: readonly LessonListFilter[] = ['LIVE', 'PENDING', 'ARCHIVED', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'AWAITING_PUBLISH', 'VARIANTS'];

@Controller('/api/v1/operations/lessons')
export class OperationsLessonsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** Vocabularies, reason codes, the published modules and the viewer's powers. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    return {
      viewer: {
        edit: hasInternalCapability(actor, 'CONTENT_EDIT'),
        review: hasInternalCapability(actor, 'CONTENT_REVIEW'),
        publish: hasInternalCapability(actor, 'CONTENT_PUBLISH'),
        userId: actor.userId,
      },
      languages: LESSON_LANGUAGES.map((language) => ({ language, name: LESSON_LANGUAGE_NAMES[language] })),
      levels: LESSON_LEVELS.map((level) => ({ level, meaning: LESSON_LEVEL_MEANINGS[level] })),
      styles: LESSON_STYLES.map((style) => ({ style, meaning: LESSON_STYLE_MEANINGS[style] })),
      licences: LESSON_LICENCES.map((licence) => ({ licence, attributionRequired: LESSON_LICENCES_REQUIRING_ATTRIBUTION.includes(licence) })),
      modules: await listLessonModules(this.db),
      transitions: lessonRevisionTransitions,
      reasons: { ...lessonEditorReasons, publish: lessonPublishReasons, archive: contentArchiveReasons },
      limits: {
        title: LESSON_TITLE_MAX, summary: LESSON_SUMMARY_MAX, practice: LESSON_PRACTICE_MAX, prerequisites: LESSON_PREREQUISITES_MAX,
        attribution: LESSON_ATTRIBUTION_MAX, basis: LESSON_BASIS_MAX, note: noteLimit,
      },
      correlationId,
    };
  }

  @Get('/lessons')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    rejectUnknown(query, ['q', 'filter', 'limit', 'cursor'], correlationId);
    const q = optionalText(query.q, 120, 'LESSON_SEARCH_INVALID', correlationId);
    const filter = query.filter === undefined || query.filter === '' ? undefined : requireEnum(query.filter, listFilters, 'LESSON_FILTER_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listLessons(this.db, { ...(q ? { q } : {}), ...(filter ? { filter } : {}), limit, ...(cursor ? { cursor } : {}) });
    return {
      lessons: page.lessons,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      summary: await summariseLessons(this.db),
      correlationId,
    };
  }

  @Get('/lessons/:lessonId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('lessonId') lessonId: string): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    const lesson = await loadLesson(this.db, requireUuid(lessonId, correlationId));
    if (!lesson) throw new NotFoundException(domainError('LESSON_NOT_FOUND', correlationId));
    return { lesson, correlationId };
  }

  /** A new base lesson: English, with the level and style chosen now. */
  @Post('/lessons')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const raw = readObject(body, ['stableKey', 'title', 'level', 'style', 'reasonCode'], correlationId);
    if (typeof raw.stableKey !== 'string' || !LESSON_STABLE_KEY_PATTERN.test(raw.stableKey)) throw badRequest('LESSON_KEY_INVALID', correlationId);
    const title = requireText(raw.title, 1, LESSON_TITLE_MAX, 'LESSON_TITLE_INVALID', correlationId);
    const level = raw.level === undefined ? 'STANDARD' : requireEnum(raw.level, LESSON_LEVELS, 'LESSON_LEVEL_INVALID', correlationId);
    const style = raw.style === undefined ? 'EXPLANATION' : requireEnum(raw.style, LESSON_STYLES, 'LESSON_STYLE_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, lessonEditorReasons.create, 'REASON_CODE_INVALID', correlationId);
    try {
      const created = await createLesson(this.db, { stableKey: raw.stableKey, title, level, style, reasonCode, actor: this.lessonActor(actor, 'CONTENT_EDIT', correlationId) });
      return { lesson: await loadLesson(this.db, created.lessonId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** A variant of a live lesson: another language, level or style, fixed now. */
  @Post('/lessons/:lessonId/variants')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createVariant(@Req() request: ProtectedHttpRequest, @Param('lessonId') lessonId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const baseLessonId = requireUuid(lessonId, correlationId);
    const raw = readObject(body, ['language', 'level', 'style', 'title', 'reasonCode'], correlationId);
    const language = requireEnum(raw.language, LESSON_LANGUAGES, 'LESSON_LANGUAGE_INVALID', correlationId) as LessonLanguage;
    const level = requireEnum(raw.level, LESSON_LEVELS, 'LESSON_LEVEL_INVALID', correlationId) as LessonLevel;
    const style = requireEnum(raw.style, LESSON_STYLES, 'LESSON_STYLE_INVALID', correlationId) as LessonStyle;
    const title = requireText(raw.title, 1, LESSON_TITLE_MAX, 'LESSON_TITLE_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, lessonEditorReasons.createVariant, 'REASON_CODE_INVALID', correlationId);
    try {
      const created = await createLessonVariant(this.db, {
        baseLessonId, variant: { language, level, style }, title, reasonCode, actor: this.lessonActor(actor, 'CONTENT_EDIT', correlationId),
      });
      return { lesson: await loadLesson(this.db, created.lessonId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/lessons/:lessonId/revisions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revise(@Req() request: ProtectedHttpRequest, @Param('lessonId') lessonId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const id = requireUuid(lessonId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, lessonEditorReasons.revise, 'REASON_CODE_INVALID', correlationId);
    try {
      await startLessonRevision(this.db, { lessonId: id, reasonCode, actor: this.lessonActor(actor, 'CONTENT_EDIT', correlationId) });
      return { lesson: await loadLesson(this.db, id), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * Archive a live lesson or variant (docs/architecture/content-archive-design.md): CONTENT_PUBLISH and a
   * reason code; a removal, so no second person, but every archived revision is recorded. It stops
   * being served to students at once and is never deleted.
   */
  @Post('/lessons/:lessonId/archive')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async archive(@Req() request: ProtectedHttpRequest, @Param('lessonId') lessonId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_PUBLISH');
    const id = requireUuid(lessonId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = typeof raw.reasonCode === 'string' ? raw.reasonCode : '';
    const refusal = refuseContentArchive({ actor, reasonCode });
    if (refusal === 'FORBIDDEN') throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (refusal) throw badRequest(refusal, correlationId);
    try {
      const archived = await archiveLesson(this.db, { lessonId: id, reasonCode, actor: this.lessonActor(actor, 'CONTENT_PUBLISH', correlationId) });
      return { lesson: await loadLesson(this.db, id), archivedRevisions: archived.archivedRevisions, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/revisions/:revisionId/draft')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async save(@Req() request: ProtectedHttpRequest, @Param('revisionId') revisionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const id = requireUuid(revisionId, correlationId);
    const raw = readObject(body, ['title', 'summary', 'practice', 'moduleKey', 'topicKey', 'prerequisites', 'licenceLabel', 'attribution', 'basis', 'reasonCode'], correlationId);
    requireEnum(raw.reasonCode, lessonEditorReasons.save, 'REASON_CODE_INVALID', correlationId);
    const draft = readDraft(raw, correlationId);
    try {
      const saved = await saveLessonDraft(this.db, { revisionId: id, draft, actor: this.lessonActor(actor, 'CONTENT_EDIT', correlationId) });
      return { lesson: await loadLesson(this.db, saved.lessonId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/revisions/:revisionId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transition(@Req() request: ProtectedHttpRequest, @Param('revisionId') revisionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    const id = requireUuid(revisionId, correlationId);
    const raw = readObject(body, ['toState', 'reasonCode', 'rightsReasonCode', 'note'], correlationId);
    if (raw.toState !== 'IN_REVIEW' && raw.toState !== 'CHANGES_REQUESTED' && raw.toState !== 'APPROVED') throw badRequest('LESSON_STATE_INVALID', correlationId);
    const toState = raw.toState;
    if (typeof raw.reasonCode !== 'string') throw badRequest('REASON_CODE_INVALID', correlationId);
    const reasonCode = raw.reasonCode;
    const rightsReasonCode = raw.rightsReasonCode === undefined || raw.rightsReasonCode === null ? null : typeof raw.rightsReasonCode === 'string' ? raw.rightsReasonCode : '';
    const note = optionalText(raw.note, noteLimit, 'LESSON_NOTE_INVALID', correlationId);
    if (!hasInternalCapability(actor, lessonTransitionCapability(toState))) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    try {
      const moved = await transitionLessonRevision(this.db, {
        revisionId: id, toState, reasonCode, rightsReasonCode, note, actor: this.lessonActor(actor, lessonTransitionCapability(toState), correlationId),
        refuse: ({ from, contributorUserIds }) => refuseLessonTransition({ actor, from, to: toState, reasonCode, rightsReasonCode, contributorUserIds }),
      });
      return { lesson: await loadLesson(this.db, moved.lessonId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * Publish an approved revision. A base lesson's first publish, or a revision that changes its
   * skill or prerequisites, needs an approval for exactly this revision, its content hash and this
   * reason; a wording change or a variant needs CONTENT_PUBLISH only.
   */
  @Post('/revisions/:revisionId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publish(@Req() request: ProtectedHttpRequest, @Param('revisionId') revisionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_PUBLISH');
    const id = requireUuid(revisionId, correlationId);
    const raw = readObject(body, ['reasonCode', 'approvalId'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, lessonPublishReasons, 'REASON_CODE_INVALID', correlationId);
    const approvalId = readApprovalId(body, correlationId) ?? null;
    try {
      const published = await publishLessonRevision(this.db, {
        revisionId: id, reasonCode, approvalId,
        approvalPayload: (contentHash) => approvalPayloads.CONTENT_LESSON_PUBLISH({ revisionId: id, contentHash, reasonCode }),
        actor: this.lessonActor(actor, 'CONTENT_PUBLISH', correlationId),
        refuse: ({ contributorUserIds, approverUserId }) => refuseLessonPublish({ actor, contributorUserIds, approverUserId }),
      });
      return {
        lesson: await loadLesson(this.db, published.lessonId),
        approval: published.approval ? { id: published.approval.approvalId, mode: published.approval.mode } : null,
        correlationId,
      };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private lessonActor(actor: Actor, capability: InternalCapability, correlationId: string): LessonActor {
    return { userId: actor.userId, breakGlass: resolveInternalCapability(actor, capability) === 'BREAK_GLASS', correlationId };
  }

  private async require(request: ProtectedHttpRequest, capability: InternalCapability): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!hasInternalCapability(actor, capability)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }

  private async requireReader(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!canReadLessons(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function readDraft(raw: Record<string, unknown>, correlationId: string): LessonDraftInput {
  const title = requireText(raw.title, 1, LESSON_TITLE_MAX, 'LESSON_TITLE_INVALID', correlationId);
  const summary = optionalBlock(raw.summary, LESSON_SUMMARY_MAX, 'LESSON_SUMMARY_INVALID', correlationId) ?? '';
  const practice = optionalBlock(raw.practice, LESSON_PRACTICE_MAX, 'LESSON_PRACTICE_INVALID', correlationId);
  const moduleKey = raw.moduleKey === undefined || raw.moduleKey === null || raw.moduleKey === '' ? null : requireKey(raw.moduleKey, 'LESSON_MODULE_INVALID', correlationId);
  const topicKey = raw.topicKey === undefined || raw.topicKey === null || raw.topicKey === '' ? null : requireKey(raw.topicKey, 'LESSON_TOPIC_INVALID', correlationId);
  const prerequisitesRaw = raw.prerequisites === undefined ? [] : raw.prerequisites;
  if (!Array.isArray(prerequisitesRaw) || prerequisitesRaw.length > LESSON_PREREQUISITES_MAX) throw badRequest('LESSON_PREREQUISITES_INVALID', correlationId);
  const prerequisites = prerequisitesRaw.map((key) => requireKey(key, 'LESSON_PREREQUISITES_INVALID', correlationId));
  const licenceLabel = raw.licenceLabel === undefined || raw.licenceLabel === null || raw.licenceLabel === ''
    ? null : requireEnum(raw.licenceLabel, LESSON_LICENCES, 'LESSON_LICENCE_INVALID', correlationId) as LessonLicence;
  return {
    title, summary, practice, moduleKey, topicKey, prerequisites, licenceLabel,
    attribution: optionalText(raw.attribution, LESSON_ATTRIBUTION_MAX, 'LESSON_ATTRIBUTION_INVALID', correlationId),
    basis: optionalBlock(raw.basis, LESSON_BASIS_MAX, 'LESSON_BASIS_INVALID', correlationId),
  };
}

function domainError(code: string, correlationId: string, problems?: readonly string[]): Record<string, unknown> {
  return { error: { code, message: 'The request could not be completed.', correlationId, ...(problems?.length ? { problems } : {}) } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

const withProblems: readonly string[] = ['LESSON_INVALID', 'LESSON_TOPIC_UNKNOWN', 'LESSON_PREREQUISITE_NOT_LIVE'];
const notFound: readonly string[] = ['LESSON_NOT_FOUND', 'LESSON_REVISION_NOT_FOUND'];
const plainBadRequest: readonly string[] = ['LESSON_EDITOR_REJECTED', 'LESSON_TRANSITION_NOT_ALLOWED', 'LESSON_MODULE_UNKNOWN', 'LESSON_TOPIC_NOT_LIVE', 'LESSON_NOT_A_BASE'];

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  const approval = approvalHttpError(error, correlationId);
  if (approval) return approval;
  if (error instanceof LessonEditorRefused) {
    if (error.code === 'APPROVAL_REQUIRED') return approvalRequired(correlationId);
    if (error.code === 'FORBIDDEN' || error.code === 'LESSON_SELF_REVIEW_REFUSED' || error.code === 'LESSON_SELF_PUBLISH_REFUSED' || error.code === 'LESSON_APPROVER_PUBLISH_REFUSED') {
      return new ForbiddenException(domainError(error.code, correlationId));
    }
    return badRequest(error.code, correlationId);
  }
  if (error instanceof LessonEditorError) {
    if (notFound.includes(error.code)) return new NotFoundException(domainError(error.code, correlationId));
    if (error.code === 'LESSON_ARCHIVE_BLOCKED') return new ConflictException(domainError(error.code, correlationId, error.problems));
    if (withProblems.includes(error.code)) return new BadRequestException(domainError(error.code, correlationId, error.problems));
    if (plainBadRequest.includes(error.code)) return badRequest(error.code, correlationId);
    return new ConflictException(domainError(error.code, correlationId));
  }
  // Never forward database or driver text to the browser.
  return badRequest('LESSON_EDITOR_REJECTED', correlationId);
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

function requireKey(value: unknown, code: string, correlationId: string): string {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw badRequest(code, correlationId);
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw badRequest(code, correlationId);
  return value as T;
}

/** One line: runs of spaces collapse. */
function requireText(value: unknown, min: number, max: number, code: string, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim().replace(/[ \t]+/g, ' ');
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

/** A block of text (a summary, a practice prompt): trimmed, inner layout kept. */
function requireBlock(value: unknown, min: number, max: number, code: string, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim();
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

function optionalText(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requireText(value, 1, max, code, correlationId);
}

function optionalBlock(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requireBlock(value, 1, max, code, correlationId);
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const limit = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw badRequest('LIMIT_INVALID', correlationId);
  return limit;
}

function encodeCursor(cursor: { readonly key: string; readonly id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): { readonly key: string; readonly id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 400) throw badRequest('CURSOR_INVALID', correlationId);
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { key?: unknown; id?: unknown };
    if (typeof parsed.key !== 'string' || parsed.key.length > 200 || typeof parsed.id !== 'string' || !uuidPattern.test(parsed.id)) throw new Error('shape');
    return { key: parsed.key, id: parsed.id };
  } catch {
    throw badRequest('CURSOR_INVALID', correlationId);
  }
}
