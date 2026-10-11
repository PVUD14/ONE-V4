/**
 * "Ask ONE to explain" review rules (ADR-052): who may read the review-by-exception queue, who may withdraw
 * a lesson and who may promote one to an official draft, with the reason codes each write carries — as data
 * and pure functions, so the API and the web screen agree.
 *
 * Withdrawing takes content down and so never waits for a second person (CONTENT_REVIEW, like a content
 * reviewer). Promoting creates a DRAFT lesson authored by the promoter (CONTENT_EDIT, an author's act), so
 * the lesson editor's rules keep them from reviewing or publishing it, and publish needs OPS-02's approval.
 *
 * Design: docs/architecture/ask-to-explain-design.md (Decision 6).
 */
import { hasInternalCapability, type InternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

export const explainReviewViews = ['flagged', 'most-viewed', 'withdrawn', 'promoted'] as const;
export type ExplainReviewView = (typeof explainReviewViews)[number];

export const explainWithdrawReasons = ['FACTUALLY_WRONG', 'UNSAFE', 'OFF_PLATFORM', 'POOR_TEACHING', 'STUDENT_REPORTS'] as const;
export const explainPromoteReasons = ['WORTH_OFFICIAL_LESSON'] as const;

export const explainReadCapabilities: readonly InternalCapability[] = ['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH', 'CATALOGUE_MANAGE'];
export const explainWithdrawCapability: InternalCapability = 'CONTENT_REVIEW';
export const explainPromoteCapability: InternalCapability = 'CONTENT_EDIT';

export function canReadExplainLessons(context: InternalCapabilityContext): boolean {
  return explainReadCapabilities.some((capability) => hasInternalCapability(context, capability));
}

export function canWithdrawExplainLesson(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, explainWithdrawCapability);
}

export function canPromoteExplainLesson(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, explainPromoteCapability);
}

export type ExplainReviewRefusal = 'FORBIDDEN' | 'REASON_CODE_INVALID';

/** Whether this person may withdraw or promote with this reason, or why not. */
export function refuseExplainReview(input: {
  readonly actor: InternalCapabilityContext;
  readonly action: 'WITHDRAW' | 'PROMOTE';
  readonly reasonCode: string;
}): ExplainReviewRefusal | null {
  const allowed = input.action === 'WITHDRAW' ? canWithdrawExplainLesson(input.actor) : canPromoteExplainLesson(input.actor);
  if (!allowed) return 'FORBIDDEN';
  const reasons: readonly string[] = input.action === 'WITHDRAW' ? explainWithdrawReasons : explainPromoteReasons;
  return reasons.includes(input.reasonCode) ? null : 'REASON_CODE_INVALID';
}
