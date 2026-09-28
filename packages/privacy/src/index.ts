/**
 * Data subject rights rules: request lifecycle, the deletion grace period, and the
 * declared policy for what a deletion erases, anonymises or retains.
 *
 * The disposition policy lives here as data rather than being scattered through the
 * executor, so what the platform promises about deletion can be read in one place
 * and asserted in tests.
 */

export type PrivacyRequestType = 'EXPORT' | 'DELETION';

export type PrivacyRequestState =
  | 'RECEIVED' | 'IN_PROGRESS' | 'READY' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'FAILED';

export type PrivacyActor = 'SUBJECT' | 'OPERATIONS' | 'SYSTEM';

export type PrivacyRuleCode =
  | 'INVALID_TRANSITION'
  | 'REQUEST_CLOSED'
  | 'ACTOR_NOT_PERMITTED'
  | 'GRACE_PERIOD_ELAPSED'
  | 'RETENTION_HOLD_ACTIVE'
  | 'EXPORT_EXPIRED'
  | 'EXPORT_NOT_READY';

export class PrivacyRuleError extends Error {
  constructor(readonly code: PrivacyRuleCode, message: string) {
    super(message);
    this.name = 'PrivacyRuleError';
  }
}

/**
 * A deletion request waits 30 days before it executes. The delay is the safeguard:
 * account deletion is irreversible and is a common target of account takeover, so
 * the subject keeps a window in which they can still cancel.
 */
export const DELETION_GRACE_PERIOD_DAYS = 30;

export function deletionScheduledFor(requestedAt: Date, graceDays = DELETION_GRACE_PERIOD_DAYS): Date {
  const scheduled = new Date(requestedAt.getTime());
  scheduled.setUTCDate(scheduled.getUTCDate() + graceDays);
  return scheduled;
}

/** How long a produced export bundle stays downloadable. */
export const EXPORT_AVAILABILITY_DAYS = 7;

export function exportExpiresAt(readyAt: Date, availabilityDays = EXPORT_AVAILABILITY_DAYS): Date {
  const expires = new Date(readyAt.getTime());
  expires.setUTCDate(expires.getUTCDate() + availabilityDays);
  return expires;
}

/**
 * The statutory period within which ONE must answer each request type, in days.
 *
 * Not defined yet, so every value is null and every statutory due date is "NA" on the
 * operations console (OPS-06). The privacy notice draft leaves the response period as a
 * TODO for legal review, and neither the DPDP Act text nor rules are encoded anywhere in
 * the codebase. Guessing a number here would print a legal deadline nobody approved.
 * When the period is decided, set it here: the console computes due dates from the real
 * `requested_at` of each request and needs no other change.
 *
 * This is not the deletion grace period above: that is when an erasure is scheduled to
 * run, a product safeguard, not the deadline for responding to the request.
 */
export const STATUTORY_RESPONSE_PERIOD_DAYS: Readonly<Record<PrivacyRequestType, number | null>> = {
  EXPORT: null,
  DELETION: null,
};

/** When a request must be answered by statute, or null when no period is defined. */
export function statutoryResponseDueAt(
  requestType: PrivacyRequestType,
  requestedAt: Date,
  periods: Readonly<Record<PrivacyRequestType, number | null>> = STATUTORY_RESPONSE_PERIOD_DAYS,
): Date | null {
  const days = periods[requestType];
  if (days === null) return null;
  const due = new Date(requestedAt.getTime());
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

const TERMINAL_STATES: readonly PrivacyRequestState[] =['COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED'];

export function isTerminalPrivacyState(state: PrivacyRequestState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface PrivacyTransitionInput {
  readonly requestType: PrivacyRequestType;
  readonly from: PrivacyRequestState;
  readonly to: PrivacyRequestState;
  readonly actor: PrivacyActor;
  readonly retentionHoldActive?: boolean;
}

export function assertPrivacyTransition(input: PrivacyTransitionInput): void {
  const { from, to, actor, requestType } = input;

  // Closed is checked first: asking to cancel an already-cancelled request should be
  // told the request is closed, which is the useful answer, rather than that the
  // transition is malformed.
  if (isTerminalPrivacyState(from)) throw new PrivacyRuleError('REQUEST_CLOSED', `A ${from} request cannot change state.`);
  if (from === to) throw new PrivacyRuleError('INVALID_TRANSITION', `Request is already ${from}.`);

  if (to === 'CANCELLED') {
    // Only the person whose data it is may call it off.
    if (actor !== 'SUBJECT') throw new PrivacyRuleError('ACTOR_NOT_PERMITTED', 'Only the subject can cancel their own request.');
    return;
  }
  if (to === 'REJECTED') {
    if (actor !== 'OPERATIONS') throw new PrivacyRuleError('ACTOR_NOT_PERMITTED', 'Only operations can reject a request.');
    return;
  }
  if (actor === 'SUBJECT') {
    throw new PrivacyRuleError('ACTOR_NOT_PERMITTED', `The subject cannot move a request to ${to}.`);
  }

  if (to === 'IN_PROGRESS') {
    if (from !== 'RECEIVED') throw new PrivacyRuleError('INVALID_TRANSITION', 'Only a received request can start processing.');
    return;
  }
  if (to === 'READY') {
    if (requestType !== 'EXPORT') throw new PrivacyRuleError('INVALID_TRANSITION', 'Only an export becomes ready for download.');
    if (from !== 'IN_PROGRESS') throw new PrivacyRuleError('INVALID_TRANSITION', 'An export must be processed before it is ready.');
    return;
  }
  if (to === 'COMPLETED') {
    if (requestType === 'DELETION') {
      if (from !== 'IN_PROGRESS') throw new PrivacyRuleError('INVALID_TRANSITION', 'A deletion must be processed before it completes.');
      // Mirrors the database trigger, so the caller gets a usable error first.
      if (input.retentionHoldActive) throw new PrivacyRuleError('RETENTION_HOLD_ACTIVE', 'A retention hold prevents this deletion from completing.');
      return;
    }
    if (from !== 'READY') throw new PrivacyRuleError('INVALID_TRANSITION', 'An export completes once it has been collected.');
    return;
  }
  if (to === 'FAILED') return;

  throw new PrivacyRuleError('INVALID_TRANSITION', `${from} cannot move to ${to}.`);
}

export function canTransitionPrivacyRequest(input: PrivacyTransitionInput): boolean {
  try {
    assertPrivacyTransition(input);
    return true;
  } catch {
    return false;
  }
}

/** A deletion is due once its grace period has elapsed and it is still open. */
export function isDeletionDue(input: { readonly state: PrivacyRequestState; readonly scheduledFor: Date; readonly now: Date }): boolean {
  if (input.state !== 'RECEIVED' && input.state !== 'IN_PROGRESS') return false;
  return input.now >= input.scheduledFor;
}

export function assertExportDownloadable(input: {
  readonly state: PrivacyRequestState;
  readonly expiresAt: Date | null;
  readonly now: Date;
}): void {
  if (input.state !== 'READY') throw new PrivacyRuleError('EXPORT_NOT_READY', 'This export is not ready to download.');
  if (input.expiresAt && input.now > input.expiresAt) throw new PrivacyRuleError('EXPORT_EXPIRED', 'This export has expired. Request a new one.');
}

// ---------------------------------------------------------------------------
// Deletion policy
// ---------------------------------------------------------------------------

export type DeletionCategory =
  | 'IDENTITY' | 'STUDENT_PROFILE' | 'INSTITUTION_ROSTER' | 'DOCUMENTS'
  | 'APPLICATIONS' | 'OFFERS' | 'ASSESSMENT_EVIDENCE' | 'NOTIFICATIONS' | 'AUDIT' | 'SUPPORT_CASES'
  | 'LEARNING_ACTIVITY' | 'COUNSELLING_NOTES';

export type DeletionDisposition = 'ERASED' | 'ANONYMISED' | 'RETAINED';

export interface DeletionPolicyEntry {
  readonly category: DeletionCategory;
  readonly disposition: DeletionDisposition;
  /** Required whenever anything is kept; this is the text the subject is shown. */
  readonly basis?: string;
}

/**
 * What deletion actually does, declared once.
 *
 * Records that belong to another party — an employer's hiring decision, an
 * institution's roster history, the security audit trail — are retained with the
 * person detached from them. Everything that is only about the person is erased.
 */
export const DELETION_POLICY: readonly DeletionPolicyEntry[] = [
  { category: 'IDENTITY', disposition: 'ANONYMISED', basis: 'Account rows are retained without identity so existing records remain valid.' },
  { category: 'STUDENT_PROFILE', disposition: 'ERASED' },
  { category: 'DOCUMENTS', disposition: 'ERASED' },
  { category: 'NOTIFICATIONS', disposition: 'ERASED' },
  { category: 'INSTITUTION_ROSTER', disposition: 'ANONYMISED', basis: 'Institutions retain enrolment history for their own academic records.' },
  { category: 'APPLICATIONS', disposition: 'ANONYMISED', basis: 'Employers retain a record of applications and hiring decisions they lawfully made.' },
  { category: 'OFFERS', disposition: 'ANONYMISED', basis: 'Employers retain a record of offers they issued.' },
  { category: 'ASSESSMENT_EVIDENCE', disposition: 'ANONYMISED', basis: 'Aggregate assessment integrity depends on evidence remaining, detached from the person.' },
  // OPS-05: the operator's service record survives with the person removed from it — the
  // subject link, the typed summary and every note (docs/architecture/support-cases-table-design.md).
  { category: 'SUPPORT_CASES', disposition: 'ANONYMISED', basis: 'Support records are kept as a history of the service given, with the person, the summary and the notes removed.' },
  // Engine behavioural data — the attempt log, learning sessions, learning activity
  // telemetry and the learner skill state projection (ENG-05) — is only about the person, so it
  // is erased, not anonymised (ADR-034). It is append-only (or projector-only) for everyone
  // else; only the deletion transaction may remove it.
  { category: 'LEARNING_ACTIVITY', disposition: 'ERASED' },
  // INST-11: counselling notes a college wrote about the person, and the list of staff on their
  // counselling case, are erased with them (docs/architecture/counselling-notes-table-design.md).
  { category: 'COUNSELLING_NOTES', disposition: 'ERASED' },
  { category: 'AUDIT', disposition: 'RETAINED', basis: 'Security and access audit records are retained under the approved retention schedule.' },
];

export function deletionPolicyFor(category: DeletionCategory): DeletionPolicyEntry {
  const entry = DELETION_POLICY.find((item) => item.category === category);
  if (!entry) throw new Error(`no deletion policy declared for ${category}`);
  return entry;
}

/** The identity values written in place of the person. Deterministic, never reused. */
export function anonymisedIdentity(userId: string): { readonly email: string; readonly displayName: string } {
  const suffix = userId.replace(/-/g, '').slice(0, 12);
  return { email: `deleted+${suffix}@deleted.invalid`, displayName: 'Deleted user' };
}
