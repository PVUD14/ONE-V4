/**
 * The Security → Privacy and consent console's rules (OPS-06, Appendix 1 §5.3 and §5.5).
 *
 * Two things live here so the API's validation and the screen's choices come from one
 * place: the reason codes for placing a legal hold, and the small-group suppression every
 * aggregate count passes through before it leaves the server.
 *
 * Suppression is applied on the server and the raw value is dropped, not hidden: a count
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

/** Appendix 1 §5.5: any aggregate cell representing fewer than 5 people shows <5. */
export const aggregateSuppressionThreshold = 5;

export type SuppressedCount =
  | { readonly suppressed: true; readonly value: null }
  | { readonly suppressed: false; readonly value: number };

/**
 * A count of people as it may leave the server. Fewer than the threshold — zero included,
 * since "none" is also "fewer than 5" — is reported only as suppressed, with no value.
 */
export function suppressSmallCount(count: number, threshold: number = aggregateSuppressionThreshold): SuppressedCount {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError('threshold must be a positive integer');
  return count < threshold ? { suppressed: true, value: null } : { suppressed: false, value: count };
}
