/**
 * The Operations Overview's access rules (OPS-03, Appendix 1 §5.1, §5.5, §5.7).
 *
 * The Overview is one server-side summary of the operator queues. Who may open it, and
 * which of its sections each caller receives, is decided here so the API and its tests
 * read the same table:
 *
 * - The endpoint opens for anyone holding at least one operations capability — every
 *   ACTIVE platform role does through its baseline. CONTENT_REVIEW_EXTERNAL does not
 *   count: it is the faculty reviewer's capability (OPS-10), not an operator's.
 * - Each section is computed only when the caller holds that module's capability, the
 *   same capability its own screen checks. Otherwise the section is null and renders NA,
 *   so a count never reaches someone who could not open the queue it summarises.
 *
 * Suppression (§5.5): sections that count people (accounts) pass through
 * `suppressPeopleCount`; sections that count work items an operator opens one by one
 * (requests, cases, invitations, events, approvals) are not suppressed — the same
 * operator can already see each item on the linked screen, and hiding "3 failed
 * deliveries" would hide work, not protect anyone.
 */
import { hasInternalCapability, internalCapabilities, type InternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

export const operationsOverviewSections = [
  'organizations',
  'verification',
  'employerAccessRequests',
  'invitations',
  'accounts',
  'trustSafety',
  'jobs',
  'privacyRequests',
  'privacyHolds',
  'approvals',
  'support',
] as const;

export type OperationsOverviewSection = (typeof operationsOverviewSections)[number];

/** The capability each section needs: the one its own screen or endpoint already checks. */
export const operationsOverviewSectionCapabilities: Readonly<Record<OperationsOverviewSection, InternalCapability>> = {
  organizations: 'OPS_ORG_MANAGE',
  verification: 'OPS_VERIFY',
  employerAccessRequests: 'OPS_ORG_MANAGE',
  invitations: 'OPS_ORG_MANAGE',
  // Platform-wide counts of people are aggregate analytics, not a queue.
  accounts: 'ANALYTICS_VIEW',
  trustSafety: 'TRUST_SAFETY_INVESTIGATE',
  jobs: 'OPS_JOBS_REPLAY',
  privacyRequests: 'PRIVACY_REQUESTS',
  privacyHolds: 'PRIVACY_HOLDS',
  // Only an approver sees the whole queue; others see only their own requests there.
  approvals: 'APPROVE_HIGH_RISK',
  support: 'SUPPORT_CASES',
};

/** Capabilities that open the Overview: every operations capability except the faculty reviewer's. */
export const operationsOverviewEntryCapabilities: readonly InternalCapability[] = internalCapabilities.filter(
  (capability) => capability !== 'CONTENT_REVIEW_EXTERNAL',
);

export function canViewOperationsOverview(context: InternalCapabilityContext): boolean {
  return operationsOverviewEntryCapabilities.some((capability) => hasInternalCapability(context, capability));
}

/** The sections this caller receives, in display order. Empty when the Overview is closed to them. */
export function operationsOverviewSectionsFor(context: InternalCapabilityContext): readonly OperationsOverviewSection[] {
  if (!canViewOperationsOverview(context)) return [];
  return operationsOverviewSections.filter((section) => hasInternalCapability(context, operationsOverviewSectionCapabilities[section]));
}

/** Appendix 1 §5.5: any aggregate cell representing fewer than 5 people shows <5. */
export const overviewSuppressionThreshold = 5;

export type SuppressedPeopleCount =
  | { readonly suppressed: true; readonly value: null; readonly capped: false }
  | { readonly suppressed: false; readonly value: number; readonly capped: boolean };

/**
 * A count of people as it may leave the server. Below the threshold — zero included,
 * since "none" is also fewer than 5 — only the fact of suppression is returned, never the
 * value, so no screen or network inspector can recover it. `capped` carries through from
 * a bounded count (the value is then a lower bound).
 */
export function suppressPeopleCount(count: number, capped = false, threshold: number = overviewSuppressionThreshold): SuppressedPeopleCount {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError('threshold must be a positive integer');
  return count < threshold ? { suppressed: true, value: null, capped: false } : { suppressed: false, value: count, capped };
}
