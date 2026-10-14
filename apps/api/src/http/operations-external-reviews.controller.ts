/**
 * Operations Content Management — external faculty reviewers (OPS-10, ADR-037, Appendix 1 §3,
 * §4.2, §5.1–§5.3).
 *
 * The operator side of faculty review. A CAPABILITY_ADMIN holder grants or revokes
 * CONTENT_REVIEW_EXTERNAL on an institution faculty or department-head membership (never from the
 * Settings staff screen, never on themselves). A CONTENT_REVIEW holder who did not write a draft
 * assigns an IN_REVIEW skill, question or lesson revision — or an item set of them — to a granted
 * reviewer for 1–30 days, and may withdraw it. Content staff read the assignments and the faculty
 * decisions beside the editors. Nothing here approves or publishes a revision: the editors' own
 * review (with its rights review) and publish are unchanged. Every write carries a reason code
 * from packages/authorization and writes its audit row and outbox event in one transaction.
 *
 * Design: docs/architecture/external-review-assignments-table-design.md
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
  canAdministerExternalReviewers,
  canAssignExternalReviews,
  canReadExternalReviews,
  externalReviewCommentMax,
  externalReviewMaxRevisionsPerAssignment,
  externalReviewReasons,
  externalReviewWindowDays,
  refuseExternalReviewAssignment,
  refuseExternalReviewerGrant,
  refuseExternalReviewerRevoke,
  refuseExternalReviewUnassign,
  resolveInternalCapability,
  type InternalCapability,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  assignExternalReviews,
  ExternalReviewError,
  ExternalReviewRefused,
  findExternalReviewerCandidates,
  grantExternalReviewer,
  listExternalReviewAssignments,
  listExternalReviewers,
  listReviewableRevisions,
  revokeExternalReviewAssignment,
  revokeExternalReviewer,
  summariseExternalReviews,
  type ExternalReviewActor,
  type ExternalReviewStatusFilter,
} from '@planthepath/persistence/src/external-reviews.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emailPattern = /^[^@\s]{1,120}@[^@\s]{1,120}\.[^@\s]{1,60}$/;
const defaultLimit = 50;
const maxLimit = 200;
const noteLimit = 500;
const statusFilters: readonly ExternalReviewStatusFilter[] = ['OPEN', 'DECIDED', 'REVOKED', 'EXPIRED', 'CLOSED'];

@Controller('/api/v1/operations/external-reviews')
export class OperationsExternalReviewsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** Reason codes, limits and the viewer's powers. */
  @Get('/policy')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    return {
      viewer: {
        read: canReadExternalReviews(actor),
        assign: canAssignExternalReviews(actor),
        administer: canAdministerExternalReviewers(actor),
        userId: actor.userId,
      },
      reasons: externalReviewReasons,
      window: externalReviewWindowDays,
      limits: { revisionsPerAssignment: externalReviewMaxRevisionsPerAssignment, comment: externalReviewCommentMax, note: noteLimit },
      correlationId,
    };
  }

  /** Every faculty membership holding the grant, with bounded counts for the panel. */
  @Get('/reviewers')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async reviewers(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    rejectUnknown(query, ['limit', 'cursor'], correlationId);
    const limit = readLimit(query.limit, correlationId);
    const after = query.cursor === undefined || query.cursor === '' ? undefined : requireUuid(query.cursor, correlationId, 'CURSOR_INVALID');
    const page = await listExternalReviewers(this.db, { limit, ...(after ? { after } : {}) });
    return { ...page, summary: await summariseExternalReviews(this.db), correlationId };
  }

  /** Faculty memberships of one exact email address, for granting. Never a partial search. */
  @Get('/reviewers/lookup')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async lookup(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.requireReader(request);
    if (!canAdministerExternalReviewers(actor) && !canAssignExternalReviews(actor)) throw forbidden(correlationId);
    rejectUnknown(query, ['email'], correlationId);
    if (typeof query.email !== 'string' || query.email.length > 254 || !emailPattern.test(query.email.trim())) throw badRequest('EMAIL_INVALID', correlationId);
    return { candidates: await findExternalReviewerCandidates(this.db, query.email.trim()), correlationId };
  }

  @Post('/reviewers/:membershipId/grant')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async grant(@Req() request: ProtectedHttpRequest, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CAPABILITY_ADMIN');
    const id = requireUuid(membershipId, correlationId);
    const raw = readObject(body, ['reasonCode', 'note'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, externalReviewReasons.grant, 'REASON_CODE_INVALID', correlationId);
    const note = optionalText(raw.note, noteLimit, 'NOTE_INVALID', correlationId);
    try {
      const reviewer = await grantExternalReviewer(this.db, {
        membershipId: id, reasonCode, note, actor: this.reviewActor(actor, 'CAPABILITY_ADMIN', correlationId),
        decide: (target) => refuseExternalReviewerGrant({ actor, target, reasonCode }),
      });
      return { reviewer, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/reviewers/:membershipId/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revoke(@Req() request: ProtectedHttpRequest, @Param('membershipId') membershipId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CAPABILITY_ADMIN');
    const id = requireUuid(membershipId, correlationId);
    const raw = readObject(body, ['reasonCode', 'note'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, externalReviewReasons.revoke, 'REASON_CODE_INVALID', correlationId);
    const note = optionalText(raw.note, noteLimit, 'NOTE_INVALID', correlationId);
    try {
      const reviewer = await revokeExternalReviewer(this.db, {
        membershipId: id, reasonCode, note, actor: this.reviewActor(actor, 'CAPABILITY_ADMIN', correlationId),
        decide: (target) => refuseExternalReviewerRevoke({ actor, target, reasonCode }),
      });
      return { reviewer, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  /** Skill, question and lesson revisions now in review, which may be assigned. */
  @Get('/revisions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revisions(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    rejectUnknown(query, ['q', 'limit'], correlationId);
    const q = optionalText(query.q, 120, 'SEARCH_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    return { revisions: await listReviewableRevisions(this.db, { ...(q ? { q } : {}), limit }), correlationId };
  }

  @Get('/assignments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async assignments(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId } = await this.requireReader(request);
    rejectUnknown(query, ['revisionId', 'status', 'limit', 'cursor'], correlationId);
    const revisionId = query.revisionId === undefined || query.revisionId === '' ? undefined : requireUuid(query.revisionId, correlationId);
    const status = query.status === undefined || query.status === '' ? undefined : requireEnum(query.status, statusFilters, 'STATUS_INVALID', correlationId);
    const limit = readLimit(query.limit, correlationId);
    const after = query.cursor === undefined || query.cursor === '' ? undefined : requireUuid(query.cursor, correlationId, 'CURSOR_INVALID');
    const page = await listExternalReviewAssignments(this.db, { ...(revisionId ? { revisionId } : {}), ...(status ? { status } : {}), limit, ...(after ? { after } : {}) });
    return { ...page, correlationId };
  }

  /** Assign one revision, or an item set of them, to one reviewer: all or none. */
  @Post('/assignments')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async assign(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_REVIEW');
    const raw = readObject(body, ['revisionIds', 'reviewerMembershipId', 'days', 'reasonCode'], correlationId);
    if (!Array.isArray(raw.revisionIds) || raw.revisionIds.length < 1 || raw.revisionIds.length > externalReviewMaxRevisionsPerAssignment) throw badRequest('REVISIONS_INVALID', correlationId);
    const revisionIds = [...new Set(raw.revisionIds.map((value) => requireUuid(value, correlationId, 'REVISIONS_INVALID')))];
    const reviewerMembershipId = requireUuid(raw.reviewerMembershipId, correlationId, 'REVIEWER_INVALID');
    const days = raw.days === undefined ? externalReviewWindowDays.default : raw.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < externalReviewWindowDays.min || days > externalReviewWindowDays.max) {
      throw badRequest('EXTERNAL_REVIEW_WINDOW_INVALID', correlationId);
    }
    const reasonCode = requireEnum(raw.reasonCode, externalReviewReasons.assign, 'REASON_CODE_INVALID', correlationId);
    try {
      const assignments = await assignExternalReviews(this.db, {
        revisionIds, reviewerMembershipId, days, reasonCode, actor: this.reviewActor(actor, 'CONTENT_REVIEW', correlationId),
        refuse: (current) => refuseExternalReviewAssignment({ actor, ...current, reasonCode, days }),
      });
      return { assignments, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  @Post('/assignments/:assignmentId/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async unassign(@Req() request: ProtectedHttpRequest, @Param('assignmentId') assignmentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, 'CONTENT_REVIEW');
    const id = requireUuid(assignmentId, correlationId);
    const raw = readObject(body, ['reasonCode'], correlationId);
    const reasonCode = requireEnum(raw.reasonCode, externalReviewReasons.unassign, 'REASON_CODE_INVALID', correlationId);
    const refusal = refuseExternalReviewUnassign({ actor, reasonCode });
    if (refusal) throw mapError(new ExternalReviewRefused(refusal), correlationId);
    try {
      const assignment = await revokeExternalReviewAssignment(this.db, { assignmentId: id, reasonCode, actor: this.reviewActor(actor, 'CONTENT_REVIEW', correlationId) });
      return { assignment, correlationId };
    } catch (error) {
      throw mapError(error, correlationId);
    }
  }

  // -------------------------------------------------------------------------

  private reviewActor(actor: Actor, capability: InternalCapability, correlationId: string): ExternalReviewActor {
    return { userId: actor.userId, breakGlass: resolveInternalCapability(actor, capability) === 'BREAK_GLASS', correlationId };
  }

  private async load(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    return { correlationId: context.correlationId, actor };
  }

  private async require(request: ProtectedHttpRequest, capability: InternalCapability): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const loaded = await this.load(request);
    const allowed = capability === 'CAPABILITY_ADMIN' ? canAdministerExternalReviewers(loaded.actor) : canAssignExternalReviews(loaded.actor);
    if (!allowed) throw forbidden(loaded.correlationId);
    return loaded;
  }

  /** Content staff, and capability administrators (who grant), read the panel. */
  private async requireReader(request: ProtectedHttpRequest): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const loaded = await this.load(request);
    if (!canReadExternalReviews(loaded.actor) && !canAdministerExternalReviewers(loaded.actor)) throw forbidden(loaded.correlationId);
    return loaded;
  }
}

// ---------------------------------------------------------------------------
// Input and errors
// ---------------------------------------------------------------------------

function domainError(code: string, correlationId: string): Record<string, unknown> {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

const forbiddenRefusals = new Set(['FORBIDDEN', 'EXTERNAL_REVIEWER_SELF_CHANGE_REFUSED', 'EXTERNAL_REVIEW_SELF_ASSIGN_REFUSED', 'EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED']);
const conflictRefusals = new Set(['EXTERNAL_REVIEWER_NOT_ELIGIBLE', 'EXTERNAL_REVIEW_REVISION_NOT_IN_REVIEW']);

export function mapExternalReviewError(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof ExternalReviewRefused) {
    if (error.code === 'FORBIDDEN') return forbidden(correlationId);
    if (forbiddenRefusals.has(error.code)) return new ForbiddenException(domainError(error.code, correlationId));
    if (conflictRefusals.has(error.code)) return new ConflictException(domainError(error.code, correlationId));
    return badRequest(error.code, correlationId);
  }
  if (error instanceof ExternalReviewError) {
    if (error.code === 'EXTERNAL_REVIEW_NOT_FOUND' || error.code === 'EXTERNAL_REVIEWER_NOT_FOUND' || error.code === 'EXTERNAL_REVIEW_REVISION_NOT_FOUND') {
      return new NotFoundException(domainError(error.code, correlationId));
    }
    if (error.code === 'EXTERNAL_REVIEW_REJECTED') return badRequest(error.code, correlationId);
    return new ConflictException(domainError(error.code, correlationId));
  }
  // Never forward database or driver text to the browser.
  return badRequest('EXTERNAL_REVIEW_REJECTED', correlationId);
}

const mapError = mapExternalReviewError;

function rejectUnknown(raw: Record<string, unknown>, allowed: readonly string[], correlationId: string): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
}

function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  rejectUnknown(raw, allowed, correlationId);
  return raw;
}

function requireUuid(value: unknown, correlationId: string, code = 'INVALID_REQUEST'): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest(code, correlationId);
  return value.toLowerCase();
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string, correlationId: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw badRequest(code, correlationId);
  return value as T;
}

function optionalText(value: unknown, max: number, code: string, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest(code, correlationId);
  const text = value.trim().replace(/[ \t]+/g, ' ');
  if (!text) return null;
  if (text.length > max) throw badRequest(code, correlationId);
  return text;
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const limit = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw badRequest('LIMIT_INVALID', correlationId);
  return limit;
}
