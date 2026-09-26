/**
 * Operations Content Management — job-role catalogue administration (OPS-08, Appendix 1
 * §3 Content, §4.2, §5.3, §5.4).
 *
 * The catalogue list (search by code, name, branch and synonym; filter by family, branch
 * and release label), role detail, the synonyms editor, and requirement sets from draft
 * through review to a publish that needs CONTENT_PUBLISH and a second person's approval.
 * Every write carries a reason code from packages/authorization and writes its audit row
 * (and events) in one transaction; a super admin acting through break-glass is audited
 * as such.
 *
 * Deliberately absent: any student data beyond a count of live targets per role, and any
 * path that changes live requirements or a release label without an approved publish.
 *
 * Design: docs/architecture/career-catalogue-table-design.md
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
  canReadCareerCatalogue,
  careerCatalogueFamilies,
  careerCatalogueReasons,
  careerCatalogueStudentFlagKey,
  careerPlannedReleases,
  careerPublishReasons,
  careerReleaseLabels,
  careerRequiredEvidenceTypes,
  careerRequirementLevels,
  careerRequirementSetTransitions,
  careerTransitionCapability,
  hasInternalCapability,
  isCareerRequirementSetState,
  refuseCareerSetTransition,
  resolveInternalCapability,
  type CareerReleaseLabel,
  type InternalCapability,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  addCareerRoleSynonym,
  CareerCatalogueError,
  CareerTransitionRefused,
  createRequirementSetDraft,
  listCatalogueBranches,
  listCatalogueRoles,
  loadCatalogueRole,
  publishRequirementSet,
  removeCareerRoleSynonym,
  saveRequirementSetItems,
  searchCatalogueTopics,
  summariseCatalogue,
  transitionRequirementSet,
  type CatalogueActor,
  type RequirementItemInput,
} from '@planthepath/persistence/src/career-catalogue.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { sql } from 'drizzle-orm';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, approvalRequired, readApprovalId } from './operation-approval-gate.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;
const maxItems = 50;
const familyCodes = careerCatalogueFamilies.map((family) => family.code);

@Controller('/api/v1/operations/career-catalogue')
export class OperationsCareerCatalogueController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** Vocabularies, reason codes, the viewer's powers and the student flag's state. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    const flag = await this.db.execute(sql`SELECT enabled FROM feature_flags WHERE key = ${careerCatalogueStudentFlagKey}`) as { rows: { enabled: boolean }[] };
    return {
      viewer: {
        manage: hasInternalCapability(actor, 'CATALOGUE_MANAGE'),
        review: hasInternalCapability(actor, 'CONTENT_REVIEW'),
        publish: hasInternalCapability(actor, 'CONTENT_PUBLISH'),
        userId: actor.userId,
      },
      families: careerCatalogueFamilies,
      branches: await listCatalogueBranches(this.db),
      releaseLabels: careerReleaseLabels,
      plannedReleases: careerPlannedReleases,
      requirementLevels: careerRequirementLevels,
      evidenceTypes: careerRequiredEvidenceTypes,
      transitions: careerRequirementSetTransitions,
      reasons: { ...careerCatalogueReasons, publish: careerPublishReasons },
      studentFlag: { key: careerCatalogueStudentFlagKey, enabled: flag.rows[0]?.enabled ?? false },
      correlationId,
    };
  }

  @Get('/roles')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    rejectUnknown(query, ['q', 'family', 'branch', 'releaseLabel', 'limit', 'cursor'], correlationId);
    const q = optionalText(query.q, 120, 'CAREER_SEARCH_INVALID', correlationId);
    const family = optionalEnum(query.family, familyCodes, 'CAREER_FAMILY_INVALID', correlationId);
    const branch = optionalText(query.branch, 60, 'CAREER_BRANCH_INVALID', correlationId);
    const releaseLabel = optionalEnum(query.releaseLabel, careerReleaseLabels, 'CAREER_RELEASE_LABEL_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const cursor = decodeCursor(query.cursor, correlationId);
    const page = await listCatalogueRoles(this.db, {
      filters: { ...(q ? { q } : {}), ...(family ? { family } : {}), ...(branch ? { branch } : {}), ...(releaseLabel ? { releaseLabel } : {}) },
      limit, ...(cursor ? { cursor } : {}),
    });
    return {
      roles: page.roles,
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      summary: await summariseCatalogue(this.db),
      correlationId,
    };
  }

  @Get('/roles/:roleId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('roleId') roleId: string): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    const role = await loadCatalogueRole(this.db, requireUuid(roleId, correlationId));
    if (!role) throw new NotFoundException(domainError('CAREER_ROLE_NOT_FOUND', correlationId));
    return { role, correlationId };
  }

  @Get('/topics')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async topics(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.require(request, 'CATALOGUE_MANAGE');
    rejectUnknown(query, ['q'], correlationId);
    const q = optionalText(query.q, 120, 'CAREER_SEARCH_INVALID', correlationId) ?? '';
    return { topics: await searchCatalogueTopics(this.db, q, 25), correlationId };
  }

  // -------------------------------------------------------------------------
  // Synonyms
  // -------------------------------------------------------------------------

  @Post('/roles/:roleId/synonyms')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async addSynonym(@Req() request: ProtectedHttpRequest, @Param('roleId') roleId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CATALOGUE_MANAGE');
    const id = requireUuid(roleId, correlationId);
    const raw = readObject(body, ['synonym', 'reasonCode'], correlationId);
    const synonym = requireText(raw.synonym, 2, 120, 'CAREER_SYNONYM_INVALID', correlationId);
    if (/^[=+@-]/.test(synonym)) throw badRequest('CAREER_SYNONYM_INVALID', correlationId);
    const reasonCode = requireEnum(raw.reasonCode, careerCatalogueReasons.synonymAdd, 'REASON_CODE_INVALID', correlationId);
    try {
      await addCareerRoleSynonym(this.db, { roleId: id, synonym, reasonCode, actor: this.catalogueActor(actor, 'CATALOGUE_MANAGE', correlationId) });
      return { role: await loadCatalogueRole(this.db, id), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/roles/:roleId/synonyms/:synonymId/remove')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async removeSynonym(@Req() request: ProtectedHttpRequest, @Param('roleId') roleId: string, @Param('synonymId') synonymId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CATALOGUE_MANAGE');
    const id = requireUuid(roleId, correlationId);
    const synonym = requireUuid(synonymId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, careerCatalogueReasons.synonymRemove, 'REASON_CODE_INVALID', correlationId);
    try {
      await removeCareerRoleSynonym(this.db, { roleId: id, synonymId: synonym, reasonCode, actor: this.catalogueActor(actor, 'CATALOGUE_MANAGE', correlationId) });
      return { role: await loadCatalogueRole(this.db, id), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------
  // Requirement sets
  // -------------------------------------------------------------------------

  @Post('/roles/:roleId/requirement-sets')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async createDraft(@Req() request: ProtectedHttpRequest, @Param('roleId') roleId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CATALOGUE_MANAGE');
    const id = requireUuid(roleId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, careerCatalogueReasons.draftCreate, 'REASON_CODE_INVALID', correlationId);
    try {
      const created = await createRequirementSetDraft(this.db, { roleId: id, reasonCode, actor: this.catalogueActor(actor, 'CATALOGUE_MANAGE', correlationId) });
      return { setId: created.id, version: created.version, role: await loadCatalogueRole(this.db, id), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/requirement-sets/:setId/items')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async saveItems(@Req() request: ProtectedHttpRequest, @Param('setId') setId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CATALOGUE_MANAGE');
    const id = requireUuid(setId, correlationId);
    const raw = readObject(body, ['items', 'reasonCode'], correlationId);
    requireEnum(raw.reasonCode, careerCatalogueReasons.itemsSave, 'REASON_CODE_INVALID', correlationId);
    const items = readItems(raw.items, correlationId);
    try {
      await saveRequirementSetItems(this.db, { setId: id, items, actor: this.catalogueActor(actor, 'CATALOGUE_MANAGE', correlationId) });
      return { role: await this.roleForSet(id), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/requirement-sets/:setId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transition(@Req() request: ProtectedHttpRequest, @Param('setId') setId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    const id = requireUuid(setId, correlationId);
    const raw = readObject(body, ['toState', 'reasonCode', 'note'], correlationId);
    if (!isCareerRequirementSetState(raw.toState) || raw.toState === 'PUBLISHED' || raw.toState === 'SUPERSEDED') {
      throw badRequest('CAREER_SET_STATE_INVALID', correlationId);
    }
    const toState = raw.toState;
    if (typeof raw.reasonCode !== 'string') throw badRequest('REASON_CODE_INVALID', correlationId);
    const reasonCode = raw.reasonCode;
    const note = optionalText(raw.note, noteLimit, 'CAREER_NOTE_INVALID', correlationId);
    // Which capability the move uses is known only once the stored author and state are
    // read, so break-glass is settled inside the rule, before the audit row is written.
    const catalogueActor: { userId: string; breakGlass: boolean; correlationId: string } = { userId: actor.userId, breakGlass: false, correlationId };
    try {
      await transitionRequirementSet(this.db, {
        setId: id, toState, reasonCode, note, actor: catalogueActor,
        refuse: ({ from, authorUserId }) => {
          const refusal = refuseCareerSetTransition({ actor, from, to: toState, reasonCode, authorUserId });
          if (!refusal) catalogueActor.breakGlass = resolveInternalCapability(actor, careerTransitionCapability(toState, reasonCode)) === 'BREAK_GLASS';
          return refusal;
        },
      });
      return { role: await this.roleForSet(id), correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /**
   * Publish a reviewed set. High-risk (§5.4): without an approvalId the answer is always
   * 403 APPROVAL_REQUIRED, and the approval must be for exactly this set, label and reason.
   */
  @Post('/requirement-sets/:setId/publish')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async publish(@Req() request: ProtectedHttpRequest, @Param('setId') setId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_PUBLISH');
    const id = requireUuid(setId, correlationId);
    const raw = readObject(body, ['releaseLabel', 'reasonCode', 'approvalId'], correlationId);
    const releaseLabel = requireEnum(raw.releaseLabel, careerReleaseLabels, 'CAREER_RELEASE_LABEL_INVALID', correlationId) as CareerReleaseLabel;
    const reasonCode = requireEnum(raw.reasonCode, careerPublishReasons, 'REASON_CODE_INVALID', correlationId);
    const approvalId = readApprovalId(body, correlationId);
    if (!approvalId) throw approvalRequired(correlationId);
    try {
      const published = await publishRequirementSet(this.db, {
        setId: id, releaseLabel, reasonCode, approvalId,
        approvalPayload: approvalPayloads.CAREER_REQUIREMENT_SET_PUBLISH({ setId: id, releaseLabel, reasonCode }),
        actor: this.catalogueActor(actor, 'CONTENT_PUBLISH', correlationId),
      });
      return { role: await loadCatalogueRole(this.db, published.careerRoleId), approval: { id: approvalId, mode: published.approval.mode }, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private async roleForSet(setId: string): Promise<Record<string, unknown> | null> {
    const found = await this.db.execute(sql`SELECT career_role_id FROM career_requirement_sets WHERE id = ${setId}::uuid`) as { rows: { career_role_id: string }[] };
    const roleId = found.rows[0]?.career_role_id;
    return roleId ? (await loadCatalogueRole(this.db, roleId)) as unknown as Record<string, unknown> : null;
  }

  private catalogueActor(actor: Actor, capability: InternalCapability, correlationId: string): CatalogueActor {
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
    if (!canReadCareerCatalogue(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function readItems(value: unknown, correlationId: string): readonly RequirementItemInput[] {
  if (!Array.isArray(value) || value.length > maxItems) throw badRequest('CAREER_ITEMS_INVALID', correlationId);
  const seen = new Set<string>();
  return value.map((entry) => {
    const raw = readObject(entry, ['topicId', 'requirementLevel', 'targetMastery', 'rationale', 'requiredEvidenceTypes'], correlationId);
    const topicId = requireUuid(raw.topicId, correlationId);
    if (seen.has(topicId)) throw badRequest('CAREER_ITEMS_DUPLICATE_TOPIC', correlationId);
    seen.add(topicId);
    const requirementLevel = requireEnum(raw.requirementLevel, careerRequirementLevels, 'CAREER_ITEM_LEVEL_INVALID', correlationId);
    const targetMastery = raw.targetMastery;
    // numeric(4,3): a proportion in (0, 1] with at most three decimals.
    if (typeof targetMastery !== 'number' || !Number.isFinite(targetMastery) || targetMastery <= 0 || targetMastery > 1
        || Math.round(targetMastery * 1000) !== targetMastery * 1000) {
      throw badRequest('CAREER_ITEM_TARGET_INVALID', correlationId);
    }
    const rationale = optionalText(raw.rationale, 500, 'CAREER_ITEM_RATIONALE_INVALID', correlationId);
    const types = raw.requiredEvidenceTypes === undefined ? [] : raw.requiredEvidenceTypes;
    if (!Array.isArray(types) || types.some((type) => typeof type !== 'string' || !(careerRequiredEvidenceTypes as readonly string[]).includes(type))
        || new Set(types).size !== types.length) {
      throw badRequest('CAREER_ITEM_EVIDENCE_INVALID', correlationId);
    }
    return { topicId, requirementLevel, targetMastery, rationale, requiredEvidenceTypes: types as string[] };
  });
}

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
  if (error instanceof CareerTransitionRefused) {
    if (error.code === 'FORBIDDEN' || error.code === 'CAREER_SET_SELF_REVIEW_REFUSED') return new ForbiddenException(domainError(error.code, correlationId));
    return badRequest(error.code, correlationId);
  }
  if (error instanceof CareerCatalogueError) {
    if (error.code.endsWith('_NOT_FOUND') && error.code !== 'CAREER_TOPIC_NOT_FOUND') return new NotFoundException(domainError(error.code, correlationId));
    if (error.code === 'CAREER_SYNONYM_EXISTS' || error.code === 'CAREER_SET_OPEN_EXISTS' || error.code === 'CAREER_SET_NOT_DRAFT' || error.code === 'CAREER_SET_NOT_REVIEWED'
        || error.code === 'CAREER_TOPIC_NOT_LIVE') {
      return new ConflictException(domainError(error.code, correlationId));
    }
    return badRequest(error.code, correlationId);
  }
  // Never forward database or driver text to the browser.
  return badRequest('CAREER_CATALOGUE_REJECTED', correlationId);
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

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T | undefined {
  if (value === undefined || value === '') return undefined;
  return requireEnum(value, allowed, code, correlationId);
}

function requireText(value: unknown, min: number, max: number, code: string, correlationId: string): string {
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length < min || text.length > max) throw badRequest(code, correlationId);
  return text;
}

function optionalText(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
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
