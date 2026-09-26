/**
 * Opportunity lifecycle and term-change rules (EMP-05).
 *
 * Before EMP-05 a job could only be created and published (EMPLOYER_BASELINE D-8). These
 * are the pure rules the employer lifecycle routes and the deadline job share: which state
 * each action may start from, which states may take a new version, which reason codes each
 * action accepts, and which edits count as a change to the terms an applicant applied under.
 * No database or transport here, so every rule is tested exhaustively without Postgres.
 */
import { HiringRuleError } from './index.js';

export type OpportunityLifecycleState = 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'PAUSED' | 'CLOSED' | 'WITHDRAWN' | 'ARCHIVED';

/** What an employer can do to a job after creating it. Publishing stays on its own route. */
export type OpportunityLifecycleAction = 'PAUSE' | 'CLOSE' | 'REOPEN' | 'WITHDRAW';

const LIFECYCLE_ACTIONS: Readonly<Record<OpportunityLifecycleAction, { readonly from: readonly OpportunityLifecycleState[]; readonly to: OpportunityLifecycleState }>> = {
  // Paused: hidden from students and closed to applications, expected to come back.
  PAUSE: { from: ['PUBLISHED'], to: 'PAUSED' },
  // Closed: no more applications; the employer keeps working the applicants it has.
  CLOSE: { from: ['PUBLISHED', 'PAUSED'], to: 'CLOSED' },
  // Reopen brings a paused or closed job back in front of students.
  REOPEN: { from: ['PAUSED', 'CLOSED'], to: 'PUBLISHED' },
  // Withdrawn: the role no longer exists. Terminal.
  WITHDRAW: { from: ['DRAFT', 'PUBLISHED', 'PAUSED', 'CLOSED'], to: 'WITHDRAWN' },
};

/** The state an action leads to; throws OPPORTUNITY_TRANSITION_NOT_ALLOWED when it cannot start from `from`. */
export function opportunityLifecycleTarget(from: string, action: OpportunityLifecycleAction): OpportunityLifecycleState {
  const rule = LIFECYCLE_ACTIONS[action];
  if (!rule.from.includes(from as OpportunityLifecycleState)) {
    throw new HiringRuleError('OPPORTUNITY_TRANSITION_NOT_ALLOWED', `A ${from} opportunity cannot be ${action.toLowerCase()}d.`);
  }
  return rule.to;
}

export function canApplyLifecycleAction(from: string, action: OpportunityLifecycleAction): boolean {
  return LIFECYCLE_ACTIONS[action].from.includes(from as OpportunityLifecycleState);
}

/** The lifecycle actions available from a state, in the order a screen should offer them. */
export function availableLifecycleActions(from: string): readonly OpportunityLifecycleAction[] {
  return (['PAUSE', 'CLOSE', 'REOPEN', 'WITHDRAW'] as const).filter((action) => canApplyLifecycleAction(from, action));
}

/**
 * States that accept a new version. A withdrawn job is gone; PENDING_REVIEW and ARCHIVED are
 * not reachable from any route today. A closed job may be edited so an employer can, for
 * example, move a passed deadline before reopening it.
 */
const EDITABLE_STATES: readonly OpportunityLifecycleState[] = ['DRAFT', 'PUBLISHED', 'PAUSED', 'CLOSED'];

export function canEditOpportunity(state: string): boolean {
  return EDITABLE_STATES.includes(state as OpportunityLifecycleState);
}

/** A job whose text students may already have seen: an edit there goes live at once. */
export function isLiveOpportunityState(state: string): boolean {
  return state === 'PUBLISHED' || state === 'PAUSED' || state === 'CLOSED';
}

/**
 * Reason codes, from fixed lists (Appendix 2 §5.7, security finding EMP-SR-08): a free-text
 * reason cannot be compared across employers, and a code from a list can. Close and withdraw
 * require one; pause may carry one. DEADLINE_PASSED is written only by the deadline job.
 */
export const opportunityLifecycleReasonCodes = {
  PAUSE: ['HIRING_ON_HOLD', 'REVIEWING_APPLICANTS', 'UPDATING_DETAILS'],
  CLOSE: ['POSITION_FILLED', 'ENOUGH_APPLICANTS', 'HIRING_ON_HOLD', 'ROLE_CANCELLED', 'POSTED_IN_ERROR'],
  REOPEN: [],
  WITHDRAW: ['POSTED_IN_ERROR', 'ROLE_CANCELLED', 'DUPLICATE_POSTING', 'TERMS_INCORRECT'],
} as const satisfies Record<OpportunityLifecycleAction, readonly string[]>;

export const OPPORTUNITY_DEADLINE_REASON_CODE = 'DEADLINE_PASSED';

export function lifecycleReasonRequired(action: OpportunityLifecycleAction): boolean {
  return action === 'CLOSE' || action === 'WITHDRAW';
}

// ---------------------------------------------------------------------------
// Term changes
// ---------------------------------------------------------------------------

/**
 * The field names changedMaterialTerms reports, plus `eligibility`: eligibility rules live
 * in their own table per version, so the caller compares them and adds this name.
 */
export const ELIGIBILITY_TERM = 'eligibility';

export interface TermChangeClassification {
  /** The terms an applicant applied under differ from the new version. */
  readonly material: boolean;
  /** The applicant must accept the change before the employer can move them on. */
  readonly acknowledgementRequired: boolean;
}

/**
 * Whether a change to these fields binds applicants.
 *
 * Every material field (pay, location, work mode, employment type, duration, joining
 * conditions, eligibility, deadline) makes the change material, so each applicant gets a
 * recorded term change. Only the application deadline is exempt from acknowledgement: it
 * governs who may still apply, not what a person who has applied agreed to, and asking
 * every applicant to accept a deadline extension trains them to click through the changes
 * that matter. A deadline change alongside any other material change still needs it.
 */
export function classifyTermChange(changedFields: readonly string[]): TermChangeClassification {
  if (changedFields.length === 0) return { material: false, acknowledgementRequired: false };
  return { material: true, acknowledgementRequired: changedFields.some((field) => field !== 'applicationDeadline') };
}
