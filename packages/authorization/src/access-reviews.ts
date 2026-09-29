/**
 * Quarterly internal access reviews (OPS-15).
 *
 * The rules that make a review evidence rather than a formality, as pure functions: who
 * may review, that nobody attests their own access (with the solo-operator exception
 * marked as such, reusing OPS-02's pattern), that the last super admin cannot be
 * suspended by a review, and when a review is due or overdue. The 0079 triggers repeat
 * the decision rules so a second writer cannot skip them.
 *
 * Design: docs/architecture/access-review-campaigns-table-design.md
 */
import {
  hasInternalCapability,
  highRiskInternalCapabilities,
  type InternalCapability,
  type InternalCapabilityContext,
} from './internal-capabilities.js';

export const accessReviewItemKinds = ['PLATFORM_ROLE', 'CAPABILITY_GRANT'] as const;
export type AccessReviewItemKind = (typeof accessReviewItemKinds)[number];

export const accessReviewDecisions = ['KEEP', 'REVOKE'] as const;
export type AccessReviewDecision = (typeof accessReviewDecisions)[number];

export type AccessReviewMode = 'DUAL' | 'SOLO';

/** §5.3: reason codes are defined in code, per action. */
export const accessReviewOpenReasons = ['QUARTERLY_REVIEW', 'AD_HOC_REVIEW', 'POST_INCIDENT_REVIEW', 'AUDIT_REQUEST'] as const;
export const accessReviewDecisionReasons: Readonly<Record<AccessReviewDecision, readonly string[]>> = {
  KEEP: ['STILL_REQUIRED', 'ROLE_REQUIRES_IT', 'TEMPORARY_COVER_CONTINUES'],
  REVOKE: ['NO_LONGER_REQUIRED', 'LEAVER', 'EXCESSIVE_PRIVILEGE', 'UNRECOGNISED_GRANT', 'SECURITY_INCIDENT'],
};
export const accessReviewCloseReasons = ['REVIEW_COMPLETE'] as const;
export const accessReviewExportReasons = ['AUDIT_EVIDENCE', 'CERTIFICATION_EVIDENCE', 'INTERNAL_RECORD'] as const;

/** The revocation reason written on a grant a review removed (already in OPS-01's revoke list). */
export const accessReviewRevocationReason = 'ACCESS_REVIEW_OUTCOME';

/** OPS-02's solo pause, measured from the campaign opening. */
export const accessReviewSoloCoolingOffMinutes = 15;
/** A campaign should be finished within this many days of opening. */
export const accessReviewCampaignWindowDays = 30;
/** The next review is due this many calendar months after the last one closed. */
export const accessReviewCadenceMonths = 3;

export function isAccessReviewer(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'SECURITY_ACCESS_REVIEW');
}

/** Whether a set of capabilities includes any §5.4 high-risk one. */
export function accessReviewHighRisk(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) => (highRiskInternalCapabilities as readonly string[]).includes(capability as InternalCapability));
}

export type AccessReviewRefusal =
  | 'FORBIDDEN'
  | 'ACCESS_REVIEW_NOT_OPEN'
  | 'ACCESS_REVIEW_ALREADY_DECIDED'
  | 'ACCESS_REVIEW_OWN_ACCESS'
  | 'ACCESS_REVIEW_SOLO_COOLING_OFF'
  | 'ACCESS_REVIEW_LAST_SUPER_ADMIN';

export interface AccessReviewDecisionInput {
  readonly actor: InternalCapabilityContext & { readonly userId: string };
  /** People who hold SECURITY_ACCESS_REVIEW right now (the database's count). */
  readonly reviewerCount: number;
  readonly campaign: { readonly state: string; readonly openedAt: string | Date };
  readonly item: { readonly subjectUserId: string; readonly decided: boolean };
  readonly decision: AccessReviewDecision;
  /** The database clock, never Node's: cooling-off is ordered against a database stamp. */
  readonly now: string | Date;
}

export type AccessReviewDecisionOutcome =
  | { readonly allowed: true; readonly mode: AccessReviewMode }
  | { readonly allowed: false; readonly refusal: AccessReviewRefusal; readonly coolingOffEndsAt?: string };

export function accessReviewCoolingOffEndsAt(openedAt: string | Date): string {
  return new Date(new Date(openedAt).getTime() + accessReviewSoloCoolingOffMinutes * 60_000).toISOString();
}

/**
 * Whether this reviewer may record this decision on this item, and in which mode.
 *
 * A reviewer never attests their own access. The one exception is the solo operator:
 * while exactly one person can review, they may KEEP their own access 15 minutes after
 * the campaign opened, and the decision is marked SOLO. The exception ends by itself when
 * a second reviewer exists, because the count is read at decision time.
 */
export function decideAccessReviewItem(input: AccessReviewDecisionInput): AccessReviewDecisionOutcome {
  if (!isAccessReviewer(input.actor)) return { allowed: false, refusal: 'FORBIDDEN' };
  if (input.campaign.state !== 'OPEN') return { allowed: false, refusal: 'ACCESS_REVIEW_NOT_OPEN' };
  if (input.item.decided) return { allowed: false, refusal: 'ACCESS_REVIEW_ALREADY_DECIDED' };
  if (input.item.subjectUserId !== input.actor.userId) return { allowed: true, mode: 'DUAL' };
  if (input.decision !== 'KEEP' || input.reviewerCount !== 1) return { allowed: false, refusal: 'ACCESS_REVIEW_OWN_ACCESS' };
  const endsAt = accessReviewCoolingOffEndsAt(input.campaign.openedAt);
  if (new Date(input.now).getTime() < new Date(endsAt).getTime()) {
    return { allowed: false, refusal: 'ACCESS_REVIEW_SOLO_COOLING_OFF', coolingOffEndsAt: endsAt };
  }
  return { allowed: true, mode: 'SOLO' };
}

/**
 * A review may suspend a platform membership, but never the last ACTIVE super admin:
 * that would lock AI8HT out of its own console.
 */
export function refuseAccessReviewRoleRevocation(input: {
  readonly targetRole: string; readonly targetState: string; readonly activeSuperAdmins: number;
}): AccessReviewRefusal | null {
  if (input.targetState === 'ACTIVE' && input.targetRole === 'PLATFORM_SUPER_ADMIN' && input.activeSuperAdmins <= 1) {
    return 'ACCESS_REVIEW_LAST_SUPER_ADMIN';
  }
  return null;
}

export type AccessReviewScheduleStatus = 'NEVER_REVIEWED' | 'REVIEW_OVERDUE' | 'CAMPAIGN_OVERDUE' | 'IN_PROGRESS' | 'CURRENT';

export interface AccessReviewSchedule {
  readonly status: AccessReviewScheduleStatus;
  readonly overdue: boolean;
  /** When the next review is due; null when none has ever been completed (it is due now). */
  readonly nextDueAt: string | null;
}

function addUtcMonths(value: Date, months: number): Date {
  const target = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1,
    value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return target;
}

/**
 * Where the review programme stands. Overdue when no review has ever closed, when the
 * next quarterly review is past due, or when the open campaign has run past its window.
 */
export function accessReviewSchedule(input: {
  readonly now: string | Date;
  readonly lastClosedAt: string | Date | null;
  readonly open: { readonly dueAt: string | Date } | null;
}): AccessReviewSchedule {
  const now = new Date(input.now).getTime();
  const nextDue = input.lastClosedAt ? addUtcMonths(new Date(input.lastClosedAt), accessReviewCadenceMonths) : null;
  const nextDueAt = nextDue ? nextDue.toISOString() : null;
  if (input.open && now > new Date(input.open.dueAt).getTime()) return { status: 'CAMPAIGN_OVERDUE', overdue: true, nextDueAt };
  const programmeOverdue = !nextDue || now > nextDue.getTime();
  if (input.open) return { status: 'IN_PROGRESS', overdue: programmeOverdue, nextDueAt };
  if (!nextDue) return { status: 'NEVER_REVIEWED', overdue: true, nextDueAt };
  if (programmeOverdue) return { status: 'REVIEW_OVERDUE', overdue: true, nextDueAt };
  return { status: 'CURRENT', overdue: false, nextDueAt };
}
