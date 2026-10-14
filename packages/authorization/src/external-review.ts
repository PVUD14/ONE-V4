/**
 * External faculty review rules (OPS-10, ADR-037, Appendix 1 §3, §5.1, §5.3).
 *
 * College faculty review ONE's global content drafts. The CONTENT_REVIEW_EXTERNAL grant makes a
 * faculty membership eligible; an assignment, made by an internal CONTENT_REVIEW holder who did not
 * write the draft, gives that membership one revision to see for a fixed period. The faculty
 * decision is advisory: approving and publishing stay with internal CONTENT_REVIEW and
 * CONTENT_PUBLISH holders. Declared once, as data and pure functions, so the API, the database
 * trigger (0066) and the web screens agree. Nothing here names a platform role.
 *
 * Design: docs/architecture/external-review-assignments-table-design.md
 */
import {
  externalContentReviewerRoles,
  hasInternalCapability,
  isInternalCapabilityGrantableToRole,
  type InternalCapabilityContext,
} from './internal-capabilities.js';

/** §5.3: reason codes, defined in code, per write. */
export const externalReviewReasons = {
  /** Granting CONTENT_REVIEW_EXTERNAL to a faculty membership. */
  grant: ['FACULTY_REVIEWER_AGREED', 'CORRECTION'],
  /** Revoking it. */
  revoke: ['REVIEW_PROGRAMME_ENDED', 'COLLEGE_REQUEST', 'LEAVER', 'SECURITY_INCIDENT', 'CORRECTION'],
  /** Assigning a revision to a reviewer. */
  assign: ['SUBJECT_EXPERT_REVIEW', 'CURRICULUM_ALIGNMENT', 'AGENT_DRAFT_CHECK'],
  /** Withdrawing an open assignment. */
  unassign: ['NO_LONGER_NEEDED', 'REASSIGNED', 'CORRECTION'],
  /** The faculty decision. */
  decision: {
    APPROVE: ['REVIEW_PASSED'],
    REQUEST_CHANGES: ['CONTENT_INACCURATE', 'OUT_OF_SYLLABUS', 'UNCLEAR_WORDING', 'LEVEL_MISMATCH', 'ANSWER_OPTIONS_WEAK', 'OTHER_CONCERN'],
  },
} as const;

/** Written by the system when a grant is revoked with assignments still open. */
export const externalReviewGrantRevokedReason = 'GRANT_REVOKED';

export const externalReviewDecisions = ['APPROVE', 'REQUEST_CHANGES'] as const;
export type ExternalReviewDecision = (typeof externalReviewDecisions)[number];

export const externalReviewEntityTypes = ['TOPIC', 'QUESTION', 'LESSON'] as const;
export type ExternalReviewEntityType = (typeof externalReviewEntityTypes)[number];

/** How long an assignment lasts, in days: 1 to 30, 14 unless the assigner chooses. */
export const externalReviewWindowDays = { min: 1, max: 30, default: 14 } as const;
/** Revisions assigned in one action (an item set): one row each. */
export const externalReviewMaxRevisionsPerAssignment = 50;
export const externalReviewCommentMax = 2000;

export type ExternalReviewRefusal =
  | 'FORBIDDEN'
  | 'REASON_CODE_INVALID'
  | 'EXTERNAL_REVIEW_WINDOW_INVALID'
  | 'EXTERNAL_REVIEWER_NOT_ELIGIBLE'
  | 'EXTERNAL_REVIEWER_SELF_CHANGE_REFUSED'
  | 'EXTERNAL_REVIEW_SELF_ASSIGN_REFUSED'
  | 'EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED'
  | 'EXTERNAL_REVIEW_REVISION_NOT_IN_REVIEW'
  | 'EXTERNAL_REVIEW_COMMENT_REQUIRED'
  | 'EXTERNAL_REVIEW_COMMENT_TOO_LONG';

type Actor = InternalCapabilityContext & { readonly userId: string };

/** Operators who may see assignments and faculty decisions: the content staff. */
export function canReadExternalReviews(context: InternalCapabilityContext): boolean {
  return (['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH'] as const).some((capability) => hasInternalCapability(context, capability));
}

/** Granting and revoking the faculty grant is capability administration (ADR-032 §6). */
export function canAdministerExternalReviewers(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'CAPABILITY_ADMIN');
}

/** Assigning drafts to faculty is part of reviewing: CONTENT_REVIEW (OPS-10, conflict rules). */
export function canAssignExternalReviews(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'CONTENT_REVIEW');
}

/** The membership a grant or an assignment is about. */
export interface ExternalReviewerTarget {
  readonly userId: string;
  readonly role: string;
  readonly state: string;
  readonly organizationKind: string;
}

/** Whether a membership may hold the grant: ACTIVE institution faculty or department head. */
export function isEligibleExternalReviewer(target: ExternalReviewerTarget): boolean {
  return target.state === 'ACTIVE' && target.organizationKind === 'INSTITUTION'
    && isInternalCapabilityGrantableToRole('CONTENT_REVIEW_EXTERNAL', target.role);
}

/** Grant CONTENT_REVIEW_EXTERNAL, or why not. Not high-risk (§5.4): no approval. */
export function refuseExternalReviewerGrant(input: { readonly actor: Actor; readonly target: ExternalReviewerTarget; readonly reasonCode: string }): ExternalReviewRefusal | null {
  if (!canAdministerExternalReviewers(input.actor)) return 'FORBIDDEN';
  if (!(externalReviewReasons.grant as readonly string[]).includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (input.actor.userId === input.target.userId) return 'EXTERNAL_REVIEWER_SELF_CHANGE_REFUSED';
  if (!isEligibleExternalReviewer(input.target)) return 'EXTERNAL_REVIEWER_NOT_ELIGIBLE';
  return null;
}

/** Revoke it. Revoking removes authority, so eligibility does not matter; a leaver can be revoked. */
export function refuseExternalReviewerRevoke(input: { readonly actor: Actor; readonly target: ExternalReviewerTarget; readonly reasonCode: string }): ExternalReviewRefusal | null {
  if (!canAdministerExternalReviewers(input.actor)) return 'FORBIDDEN';
  if (!(externalReviewReasons.revoke as readonly string[]).includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (input.actor.userId === input.target.userId) return 'EXTERNAL_REVIEWER_SELF_CHANGE_REFUSED';
  if (!(externalContentReviewerRoles as readonly string[]).includes(input.target.role) || input.target.organizationKind !== 'INSTITUTION') return 'EXTERNAL_REVIEWER_NOT_ELIGIBLE';
  return null;
}

/**
 * Assign one revision to one faculty reviewer, or why not. `contributorUserIds` is the revision's
 * author, editors and submitters (from the audit log, as the editors compute it): none of them
 * chooses its reviewer or is chosen.
 */
export function refuseExternalReviewAssignment(input: {
  readonly actor: Actor;
  readonly reviewerUserId: string;
  readonly reviewerEligible: boolean;
  readonly revisionState: string;
  readonly contributorUserIds: readonly string[];
  readonly reasonCode: string;
  readonly days: number;
}): ExternalReviewRefusal | null {
  if (!canAssignExternalReviews(input.actor)) return 'FORBIDDEN';
  if (!(externalReviewReasons.assign as readonly string[]).includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (!Number.isInteger(input.days) || input.days < externalReviewWindowDays.min || input.days > externalReviewWindowDays.max) return 'EXTERNAL_REVIEW_WINDOW_INVALID';
  if (input.actor.userId === input.reviewerUserId) return 'EXTERNAL_REVIEW_SELF_ASSIGN_REFUSED';
  if (input.contributorUserIds.includes(input.actor.userId)) return 'EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED';
  if (input.contributorUserIds.includes(input.reviewerUserId)) return 'EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED';
  if (!input.reviewerEligible) return 'EXTERNAL_REVIEWER_NOT_ELIGIBLE';
  if (input.revisionState !== 'IN_REVIEW') return 'EXTERNAL_REVIEW_REVISION_NOT_IN_REVIEW';
  return null;
}

/** Withdraw an open assignment: CONTENT_REVIEW and a listed reason. */
export function refuseExternalReviewUnassign(input: { readonly actor: Actor; readonly reasonCode: string }): ExternalReviewRefusal | null {
  if (!canAssignExternalReviews(input.actor)) return 'FORBIDDEN';
  if (!(externalReviewReasons.unassign as readonly string[]).includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  return null;
}

/** A faculty membership as the institution route sees it. */
export interface ExternalReviewerMembership {
  readonly id: string;
  readonly organizationId: string;
  readonly role: string;
  readonly state: string;
  /** Live capability grants on this membership. */
  readonly grants: readonly string[];
}

/**
 * The caller's memberships in one college that may act as an external reviewer: ACTIVE, faculty or
 * department head, holding a live CONTENT_REVIEW_EXTERNAL grant. A grant on any other membership —
 * another college, another role — counts for nothing here.
 */
export function externalReviewerMembershipsIn(memberships: readonly ExternalReviewerMembership[], institutionId: string): readonly ExternalReviewerMembership[] {
  return memberships.filter((membership) => membership.organizationId === institutionId && membership.state === 'ACTIVE'
    && (externalContentReviewerRoles as readonly string[]).includes(membership.role)
    && membership.grants.includes('CONTENT_REVIEW_EXTERNAL'));
}

/**
 * Record a faculty decision, or why not. Contributors are refused again here, in case a person who
 * wrote the draft also holds a faculty membership. A request for changes needs a comment.
 */
export function refuseExternalReviewDecision(input: {
  readonly reviewerUserId: string;
  readonly contributorUserIds: readonly string[];
  readonly decision: ExternalReviewDecision;
  readonly reasonCode: string;
  readonly comment: string | null;
}): ExternalReviewRefusal | null {
  const reasons = externalReviewReasons.decision[input.decision] as readonly string[] | undefined;
  if (!reasons || !reasons.includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (input.comment !== null && input.comment.length > externalReviewCommentMax) return 'EXTERNAL_REVIEW_COMMENT_TOO_LONG';
  if (input.decision === 'REQUEST_CHANGES' && !input.comment) return 'EXTERNAL_REVIEW_COMMENT_REQUIRED';
  if (input.contributorUserIds.includes(input.reviewerUserId)) return 'EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED';
  return null;
}

export type ExternalReviewStatus = 'OPEN' | 'DECIDED' | 'REVOKED' | 'EXPIRED' | 'CLOSED';

/**
 * What an assignment is now. Expired and closed are derived from the clock and the revision, never
 * stored: an ASSIGNED row past its expiry is EXPIRED; one whose revision left review or changed is
 * CLOSED. Only OPEN shows content or accepts a decision.
 */
export function externalReviewStatus(input: {
  readonly state: 'ASSIGNED' | 'DECIDED' | 'REVOKED' | string;
  readonly expired: boolean;
  readonly revisionInReviewAsAssigned: boolean;
}): ExternalReviewStatus {
  if (input.state === 'DECIDED') return 'DECIDED';
  if (input.state === 'REVOKED') return 'REVOKED';
  if (input.expired) return 'EXPIRED';
  if (!input.revisionInReviewAsAssigned) return 'CLOSED';
  return 'OPEN';
}
