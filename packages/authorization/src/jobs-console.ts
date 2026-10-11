/**
 * Reason codes for the background jobs console (OPS-04, Appendix 1 §5.3).
 *
 * Replaying a failed event causes a real-world effect again (an email, a generated
 * draft), so the operator says why from a fixed list rather than free text. The list
 * lives here so the API's validation and the screen's choices come from one place.
 */
export const outboxReplayReasons = [
  'TRANSIENT_FAILURE_RESOLVED',
  'CONFIGURATION_FIXED',
  'RECEIVER_RESTORED',
  'INCIDENT_RECOVERY',
  'CUSTOMER_REQUEST',
] as const;

export type OutboxReplayReason = (typeof outboxReplayReasons)[number];

export function isOutboxReplayReason(value: unknown): value is OutboxReplayReason {
  return typeof value === 'string' && (outboxReplayReasons as readonly string[]).includes(value);
}
