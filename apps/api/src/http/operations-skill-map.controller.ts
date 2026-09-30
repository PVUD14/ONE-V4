/**
 * Operations Content Management — the skill map editor (OPS-09a, Appendix 1 §3 Content, §4.2,
 * §5.3, §5.4).
 *
 * Skills are TOPIC nodes; their content (levels, prerequisites, rights) is a versioned content
 * revision taken from draft through review — which includes the rights review — to a publish
 * through a release manifest. The author and every other contributor never review or publish
 * their own revision; publishing needs CONTENT_PUBLISH, and a publish that changes readiness
 * inputs also needs a second person's approval. Every write carries a reason code from
 * packages/authorization and writes its audit row (and events) in one transaction.
 *
 * Deliberately absent: any student data, any numeric level or score, and any path that makes a
 * topic live without a reviewed, rights-cleared, published revision.
 *
 * Design: docs/architecture/skill-map-editor-design.md
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
  canReadSkillMap,
  contentArchiveReasons,
  hasInternalCapability,
  refuseContentArchive,
  refuseSkillPublish,
  refuseSkillTransition,
  resolveInternalCapability,
  skillMapReasons,
  skillPublishReasons,
  skillRevisionTransitions,
  skillTransitionCapability,
  type InternalCapability,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  archiveSkill,
  createSkill,
  SKILL_ATTRIBUTION_MAX,
  SKILL_BASIS_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_LEVEL_MAX,
  SKILL_LEVEL_MEANINGS,
  SKILL_LEVELS,
  SKILL_LICENCES,
  SKILL_LICENCES_REQUIRING_ATTRIBUTION,
  SKILL_NAME_MAX,
  SKILL_PREREQUISITES_MAX,
  SKILL_STABLE_KEY_PATTERN,
  type SkillDraftFields,
  type SkillLevel,
  type SkillLicence,
  listSkills,
  loadSkill,
  publishSkillRevision,
  saveSkillDraft,
  SkillMapError,
  SkillMapRefused,
  startSkillRevision,
  summariseSkillMap,
  transitionSkillRevision,
  type SkillActor,
  type SkillListFilter,
} from '@planthepath/persistence/src/skill-map.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, approvalRequired, readApprovalId } from './operation-approval-gate.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;
const listFilters: readonly SkillListFilter[] = ['LIVE', 'PENDING', 'RETIRED', 'AWAITING_REVIEW', 'CHANGES_REQUESTED', 'AWAITING_PUBLISH'];

@Controller('/api/v1/operations/skill-map')
export class OperationsSkillMapController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** Vocabularies, reason codes and the viewer's powers. */
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
      levels: SKILL_LEVELS.map((level) => ({ level, meaning: SKILL_LEVEL_MEANINGS[level] })),
      licences: SKILL_LICENCES.map((licence) => ({ licence, attributionRequired: SKILL_LICENCES_REQUIRING_ATTRIBUTION.includes(licence) })),
      transitions: skillRevisionTransitions,
      reasons: { ...skillMapReasons, publish: skillPublishReasons, archive: contentArchiveReasons },
      limits: {
        name: SKILL_NAME_MAX, description: SKILL_DESCRIPTION_MAX, level: SKILL_LEVEL_MAX, prerequisites: SKILL_PREREQUISITES_MAX,
        attribution: SKILL_ATTRIBUTION_MAX, basis: SKILL_BASIS_MAX, note: noteLimit,
      },
      correlationId,
    };
  }

  @Get('/skills')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    rejectUnknown(query, ['q', 'filter', 'limit', 'cursor'], correlationId);
    const q = optionalText(query.q, 120, 'SKILL_SEARCH_INVALID', correlationId);
    const filter = query.filter === undefined || query.filter === '' ? undefined : requireEnum(query.filter, listFilters, 'SKILL_FILTER_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listSkills(this.db, { ...(q ? { q } : {}), ...(filter ? { filter } : {}), limit, ...(cursor ? { cursor } : {}) });
    return {
      skills: page.skills,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      summary: await summariseSkillMap(this.db),
      correlationId,
    };
  }

  @Get('/skills/:topicId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('topicId') topicId: string): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    const skill = await loadSkill(this.db, requireUuid(topicId, correlationId));
    if (!skill) throw new NotFoundException(domainError('SKILL_NOT_FOUND', correlationId));
    return { skill, correlationId };
  }

  @Post('/skills')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async create(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const raw = readObject(body, ['stableKey', 'name', 'description', 'reasonCode'], correlationId);
    if (typeof raw.stableKey !== 'string' || !SKILL_STABLE_KEY_PATTERN.test(raw.stableKey)) throw badRequest('SKILL_KEY_INVALID', correlationId);
    const name = requireText(raw.name, 1, SKILL_NAME_MAX, 'SKILL_NAME_INVALID', correlationId);
    const description = requireText(raw.description, 1, SKILL_DESCRIPTION_MAX, 'SKILL_DESCRIPTION_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, skillMapReasons.create, 'REASON_CODE_INVALID', correlationId);
    try {
      const created = await createSkill(this.db, { stableKey: raw.stableKey, name, description, reasonCode, actor: this.skillActor(actor, 'CONTENT_EDIT', correlationId) });
      return { skill: await loadSkill(this.db, created.topicId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/skills/:topicId/revisions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revise(@Req() request: ProtectedHttpRequest, @Param('topicId') topicId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const id = requireUuid(topicId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, skillMapReasons.revise, 'REASON_CODE_INVALID', correlationId);
    try {
      await startSkillRevision(this.db, { topicId: id, reasonCode, actor: this.skillActor(actor, 'CONTENT_EDIT', correlationId) });
      return { skill: await loadSkill(this.db, id), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * Archive a live skill (docs/architecture/content-archive-design.md): CONTENT_PUBLISH and a
   * reason code; a removal, so no second person, but every archived revision is recorded. It stops
   * being served to students at once and is never deleted.
   */
  @Post('/skills/:topicId/archive')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async archive(@Req() request: ProtectedHttpRequest, @Param('topicId') topicId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_PUBLISH');
    const id = requireUuid(topicId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = typeof raw.reasonCode === 'string' ? raw.reasonCode : '';
    const refusal = refuseContentArchive({ actor, reasonCode });
    if (refusal === 'FORBIDDEN') throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    if (refusal) throw badRequest(refusal, correlationId);
    try {
      const archived = await archiveSkill(this.db, { topicId: id, reasonCode, actor: this.skillActor(actor, 'CONTENT_PUBLISH', correlationId) });
      return { skill: await loadSkill(this.db, id), archivedRevisions: archived.archivedRevisions, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/revisions/:revisionId/draft')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async save(@Req() request: ProtectedHttpRequest, @Param('revisionId') revisionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_EDIT');
    const id = requireUuid(revisionId, correlationId);
    const raw = readObject(body, ['name', 'description', 'levels', 'prerequisites', 'licenceLabel', 'attribution', 'basis', 'reasonCode'], correlationId);
    requireEnum(raw.reasonCode, skillMapReasons.save, 'REASON_CODE_INVALID', correlationId);
    const fields = readFields(raw, correlationId);
    try {
      const saved = await saveSkillDraft(this.db, { revisionId: id, fields, actor: this.skillActor(actor, 'CONTENT_EDIT', correlationId) });
      return { skill: await loadSkill(this.db, saved.topicId), correlationId };
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
    if (raw.toState !== 'IN_REVIEW' && raw.toState !== 'CHANGES_REQUESTED' && raw.toState !== 'APPROVED') throw badRequest('SKILL_STATE_INVALID', correlationId);
    const toState = raw.toState;
    if (typeof raw.reasonCode !== 'string') throw badRequest('REASON_CODE_INVALID', correlationId);
    const reasonCode = raw.reasonCode;
    const rightsReasonCode = raw.rightsReasonCode === undefined || raw.rightsReasonCode === null ? null : typeof raw.rightsReasonCode === 'string' ? raw.rightsReasonCode : '';
    const note = optionalText(raw.note, noteLimit, 'SKILL_NOTE_INVALID', correlationId);
    if (!hasInternalCapability(actor, skillTransitionCapability(toState))) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    const skillActor = this.skillActor(actor, skillTransitionCapability(toState), correlationId);
    try {
      const moved = await transitionSkillRevision(this.db, {
        revisionId: id, toState, reasonCode, rightsReasonCode, note, actor: skillActor,
        refuse: ({ from, contributorUserIds }) => refuseSkillTransition({ actor, from, to: toState, reasonCode, rightsReasonCode, contributorUserIds }),
      });
      return { skill: await loadSkill(this.db, moved.topicId), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * Publish an approved revision. When the publish changes readiness inputs (first publish, or
   * a live requirement names the skill) it needs an approval for exactly this revision, its
   * content hash and this reason; otherwise CONTENT_PUBLISH is enough.
   */
  @Post('/revisions/:revisionId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publish(@Req() request: ProtectedHttpRequest, @Param('revisionId') revisionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_PUBLISH');
    const id = requireUuid(revisionId, correlationId);
    const raw = readObject(body, ['reasonCode', 'approvalId'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, skillPublishReasons, 'REASON_CODE_INVALID', correlationId);
    const approvalId = readApprovalId(body, correlationId) ?? null;
    try {
      const published = await publishSkillRevision(this.db, {
        revisionId: id, reasonCode, approvalId,
        approvalPayload: (contentHash) => approvalPayloads.CONTENT_SKILL_PUBLISH({ revisionId: id, contentHash, reasonCode }),
        actor: this.skillActor(actor, 'CONTENT_PUBLISH', correlationId),
        refuse: ({ contributorUserIds }) => refuseSkillPublish({ actor, contributorUserIds }),
      });
      return {
        skill: await loadSkill(this.db, published.topicId),
        approval: published.approval ? { id: published.approval.approvalId, mode: published.approval.mode } : null,
        correlationId,
      };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private skillActor(actor: Actor, capability: InternalCapability, correlationId: string): SkillActor {
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
    if (!canReadSkillMap(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function readFields(raw: Record<string, unknown>, correlationId: string): SkillDraftFields {
  const name = requireText(raw.name, 1, SKILL_NAME_MAX, 'SKILL_NAME_INVALID', correlationId);
  const description = requireText(raw.description, 1, SKILL_DESCRIPTION_MAX, 'SKILL_DESCRIPTION_INVALID', correlationId);
  const levelsRaw = raw.levels;
  if (!levelsRaw || typeof levelsRaw !== 'object' || Array.isArray(levelsRaw)) throw badRequest('SKILL_LEVELS_INVALID', correlationId);
  rejectUnknown(levelsRaw as Record<string, unknown>, SKILL_LEVELS, correlationId);
  const levels = Object.fromEntries(SKILL_LEVELS.map((level) => [level,
    optionalText((levelsRaw as Record<string, unknown>)[level], SKILL_LEVEL_MAX, 'SKILL_LEVELS_INVALID', correlationId) ?? ''])) as Record<SkillLevel, string>;
  const prerequisites = raw.prerequisites === undefined ? [] : raw.prerequisites;
  if (!Array.isArray(prerequisites) || prerequisites.length > SKILL_PREREQUISITES_MAX
      || prerequisites.some((key) => typeof key !== 'string' || !SKILL_STABLE_KEY_PATTERN.test(key))) {
    throw badRequest('SKILL_PREREQUISITES_INVALID', correlationId);
  }
  const licenceLabel = raw.licenceLabel === undefined || raw.licenceLabel === null || raw.licenceLabel === ''
    ? null : requireEnum(raw.licenceLabel, SKILL_LICENCES, 'SKILL_LICENCE_INVALID', correlationId) as SkillLicence;
  return {
    name, description, levels, prerequisites: prerequisites as string[], licenceLabel,
    attribution: optionalText(raw.attribution, SKILL_ATTRIBUTION_MAX, 'SKILL_ATTRIBUTION_INVALID', correlationId),
    basis: optionalText(raw.basis, SKILL_BASIS_MAX, 'SKILL_BASIS_INVALID', correlationId),
  };
}

function domainError(code: string, correlationId: string, problems?: readonly string[]): Record<string, unknown> {
  return { error: { code, message: 'The request could not be completed.', correlationId, ...(problems?.length ? { problems } : {}) } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function mapError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  const approval = approvalHttpError(error, correlationId);
  if (approval) return approval;
  if (error instanceof SkillMapRefused) {
    if (error.code === 'APPROVAL_REQUIRED') return approvalRequired(correlationId);
    if (error.code === 'FORBIDDEN' || error.code === 'SKILL_SELF_REVIEW_REFUSED' || error.code === 'SKILL_SELF_PUBLISH_REFUSED') {
      return new ForbiddenException(domainError(error.code, correlationId));
    }
    return badRequest(error.code, correlationId);
  }
  if (error instanceof SkillMapError) {
    if (error.code === 'SKILL_NOT_FOUND' || error.code === 'SKILL_REVISION_NOT_FOUND') return new NotFoundException(domainError(error.code, correlationId));
    if (error.code === 'SKILL_INVALID' || error.code === 'SKILL_PREREQUISITE_NOT_LIVE') return new BadRequestException(domainError(error.code, correlationId, error.problems));
    if (error.code === 'SKILL_ARCHIVE_BLOCKED') return new ConflictException(domainError(error.code, correlationId, error.problems));
    if (error.code === 'SKILL_MAP_REJECTED') return badRequest(error.code, correlationId);
    return new ConflictException(domainError(error.code, correlationId));
  }
  // Never forward database or driver text to the browser.
  return badRequest('SKILL_MAP_REJECTED', correlationId);
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
  const text = value.trim().replace(/[ \t]+/g, ' ');
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

function optionalText(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requireText(value, 1, max, code, correlationId);
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
