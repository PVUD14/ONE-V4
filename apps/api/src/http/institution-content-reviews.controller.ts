/**
 * Institution portal — a faculty member's content review queue (OPS-10, ADR-037).
 *
 * A college faculty member or department head who holds CONTENT_REVIEW_EXTERNAL sees the ONE
 * content drafts assigned to them — and nothing else — through their ACTIVE membership in the
 * college named in the path. While an assignment is open they read a whitelisted view of that one
 * revision (never an answer key, a hint, rights, provenance, an author or an operator) and approve
 * or request changes with a reason code and a comment. The decision is advisory: it is recorded,
 * audited and shown to ONE's internal reviewers; it never approves or publishes the revision.
 *
 * Nothing here reads a student, a cohort or any other institution data. Another college's id, an
 * assignment that is someone else's, or a membership without the grant finds nothing.
 *
 * Design: docs/architecture/external-review-assignments-table-design.md
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  externalReviewCommentMax,
  externalReviewDecisions,
  externalReviewerMembershipsIn,
  externalReviewReasons,
  refuseExternalReviewDecision,
  type ExternalReviewDecision,
} from '@planthepath/authorization/src/index.js';
import { decideFacultyReview, listFacultyReviews, loadFacultyReview } from '@planthepath/persistence/src/external-reviews.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader } from './internal-capability-guard.js';
import { mapExternalReviewError } from './operations-external-reviews.controller.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const queueLimit = 100;

interface Reviewer {
  readonly correlationId: string;
  readonly userId: string;
  readonly institutionId: string;
  readonly membershipIds: readonly string[];
}

@Controller('/api/v1/institutions/:institutionId/content-reviews')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionContentReviewsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** The caller's assignments in this college, newest first, with the decision vocabulary. */
  @Get('/')
  async queue(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string): Promise<Record<string, unknown>> {
    const reviewer = await this.requireReviewer(request, institutionId);
    return {
      assignments: await listFacultyReviews(this.db, { ...reviewer, limit: queueLimit }),
      decisions: externalReviewDecisions.map((decision) => ({ decision, reasons: externalReviewReasons.decision[decision] })),
      limits: { comment: externalReviewCommentMax },
      correlationId: reviewer.correlationId,
    };
  }

  /** One assignment of the caller's; the draft only while it is open. */
  @Get('/:assignmentId')
  async detail(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Param('assignmentId') assignmentId: string): Promise<Record<string, unknown>> {
    const reviewer = await this.requireReviewer(request, institutionId);
    const id = requireUuid(assignmentId, reviewer.correlationId);
    const review = await loadFacultyReview(this.db, { ...reviewer, assignmentId: id });
    if (!review) throw new NotFoundException(domainError('EXTERNAL_REVIEW_NOT_FOUND', reviewer.correlationId));
    return { review, correlationId: reviewer.correlationId };
  }

  @Post('/:assignmentId/decision')
  async decide(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('assignmentId') assignmentId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const reviewer = await this.requireReviewer(request, institutionId);
    const { correlationId } = reviewer;
    const id = requireUuid(assignmentId, correlationId);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
    const raw = body as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !['decision', 'reasonCode', 'comment'].includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
    if (typeof raw.decision !== 'string' || !(externalReviewDecisions as readonly string[]).includes(raw.decision)) throw badRequest('DECISION_INVALID', correlationId);
    const decision = raw.decision as ExternalReviewDecision;
    if (typeof raw.reasonCode !== 'string') throw badRequest('REASON_CODE_INVALID', correlationId);
    const reasonCode = raw.reasonCode;
    if (raw.comment !== undefined && raw.comment !== null && typeof raw.comment !== 'string') throw badRequest('EXTERNAL_REVIEW_COMMENT_INVALID', correlationId);
    const comment = typeof raw.comment === 'string' && raw.comment.trim() ? raw.comment.trim() : null;
    const early = refuseExternalReviewDecision({ reviewerUserId: reviewer.userId, contributorUserIds: [], decision, reasonCode, comment });
    // Input checks before any read: reason, comment length, a comment for a request for changes.
    // The contributor rule runs again inside the transaction, against the revision's audit trail.
    if (early) throw badRequest(early, correlationId);
    try {
      const review = await decideFacultyReview(this.db, {
        ...reviewer, assignmentId: id, decision, reasonCode, comment,
        refuse: ({ contributorUserIds }) => refuseExternalReviewDecision({ reviewerUserId: reviewer.userId, contributorUserIds, decision, reasonCode, comment }),
      });
      return { review, correlationId };
    } catch (error) {
      throw mapExternalReviewError(error, correlationId);
    }
  }

  /**
   * The caller's memberships in this college that may review: ACTIVE, faculty or department head,
   * holding a live CONTENT_REVIEW_EXTERNAL grant. Anything else — another college, another role, a
   * revoked grant — is a plain 403 that says nothing about what exists.
   */
  private async requireReviewer(request: ProtectedHttpRequest, institutionId: string): Promise<Reviewer> {
    const context = requireTrustedAuthorization(request);
    const { correlationId } = context;
    if (typeof institutionId !== 'string' || !uuidPattern.test(institutionId)) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    const id = institutionId.toLowerCase();
    const inCollege = context.authorization.memberships.filter((membership) => membership.organizationId.toLowerCase() === id && membership.state === 'ACTIVE' && uuidPattern.test(membership.id));
    const grants = inCollege.length ? await dbCapabilityGrantLoader(this.db)(inCollege.map((membership) => membership.id)) : new Map<string, readonly string[]>();
    const eligible = externalReviewerMembershipsIn(inCollege.map((membership) => ({
      id: membership.id, organizationId: id, role: membership.role, state: membership.state, grants: grants.get(membership.id) ?? [],
    })), id);
    if (!eligible.length) throw new ForbiddenException(safeError('FORBIDDEN', correlationId));
    return { correlationId, userId: context.authorization.principal.userId, institutionId: id, membershipIds: eligible.map((membership) => membership.id) };
  }
}

function domainError(code: string, correlationId: string): Record<string, unknown> {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value.toLowerCase();
}
