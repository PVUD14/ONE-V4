/**
 * The Security → Privacy and consent console's rules (OPS-06, Appendix 1 §5.3 and §5.5).
 *
 * Two things live here so the API's validation and the screen's choices come from one
 * place: the reason codes for placing a legal hold, and the small-group suppression every
 * aggregate count passes through before it leaves the server.
 *
 * Suppression (aggregate-suppression.ts) is applied on the server and the raw value is dropped, not hidden: a count
 * below the threshold never reaches the browser, so no screen, test double or network
 * inspector can recover it.
 */

/**
 * Why a hold is placed. These are the five lawful bases 0009's
 * `retention_hold_reason_ck` already bounds `data_retention_holds.reason_code` to.
 */
export const privacyHoldPlaceReasons = [
  'LEGAL_OBLIGATION',
  'SAFETY_INVESTIGATION',
  'EMPLOYER_ACCOUNTABILITY_CASE',
  'DISPUTE',
  'REGULATORY_REQUEST',
] as const;

export type PrivacyHoldPlaceReason = (typeof privacyHoldPlaceReasons)[number];

export function isPrivacyHoldPlaceReason(value: unknown): value is PrivacyHoldPlaceReason {
  return typeof value === 'string' && (privacyHoldPlaceReasons as readonly string[]).includes(value);
}

// Small-group suppression is the one shared rule in aggregate-suppression.ts (OPS-SR-24);
// re-exported so the console's callers keep importing it from here.
export { aggregateSuppressionThreshold, suppressSmallCount, type SuppressedCount } from './aggregate-suppression.js';
