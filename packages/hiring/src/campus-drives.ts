/**
 * Campus drive and placement-policy rules (EMP-11, ADR-038).
 *
 * A campus drive is an employer's job offered to one college, live only while the college has
 * approved it. These are the pure rules the employer and college routes share: which side may
 * take which action from which state, the reason codes each action accepts, which states put the
 * job in front of the college's students, and the one-offer placement rule. No database or
 * transport here, so every rule is tested exhaustively without Postgres.
 * Design: docs/architecture/campus-drives-table-design.md.
 */
import { HiringRuleError } from './index.js';

export const campusDriveStates = ['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'REJECTED', 'COMPLETED', 'CANCELLED'] as const;
export type CampusDriveState = typeof campusDriveStates[number];

export type CampusDriveSide = 'EMPLOYER' | 'INSTITUTION';

export type CampusDriveAction =
  | 'RESUBMIT' | 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES' | 'SCHEDULE' | 'CANCEL' | 'COMPLETE';

/** States in which the college's students see the job through the drive. */
export const liveCampusDriveStates: readonly CampusDriveState[] = ['APPROVED', 'SCHEDULED'];
/** States that still hold the one-drive-per-job-and-college slot, and count as the job's audience at publish. */
export const openCampusDriveStates: readonly CampusDriveState[] = ['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED'];

interface ActionRule {
  readonly sides: readonly CampusDriveSide[];
  readonly from: readonly CampusDriveState[];
}

const ACTIONS: Readonly<Record<CampusDriveAction, ActionRule>> = {
  // The employer answers a change request with a revised proposal.
  RESUBMIT: { sides: ['EMPLOYER'], from: ['CHANGES_REQUESTED'] },
  // Only the college makes a drive live. With a schedule it goes straight to SCHEDULED.
  APPROVE: { sides: ['INSTITUTION'], from: ['REQUESTED'] },
  REJECT: { sides: ['INSTITUTION'], from: ['REQUESTED'] },
  REQUEST_CHANGES: { sides: ['INSTITUTION'], from: ['REQUESTED'] },
  // Set or move the confirmed dates of an approved drive.
  SCHEDULE: { sides: ['INSTITUTION'], from: ['APPROVED', 'SCHEDULED'] },
  // The employer may withdraw a request at any point before it ends; the college may withdraw its approval.
  CANCEL: { sides: ['EMPLOYER', 'INSTITUTION'], from: ['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED'] },
  COMPLETE: { sides: ['EMPLOYER', 'INSTITUTION'], from: ['APPROVED', 'SCHEDULED'] },
};

/** Cancel is narrower for the college: it can only withdraw something it approved. */
const INSTITUTION_CANCEL_FROM: readonly CampusDriveState[] = ['APPROVED', 'SCHEDULED'];

export function canTakeCampusDriveAction(side: CampusDriveSide, from: string, action: CampusDriveAction): boolean {
  const rule = ACTIONS[action];
  if (!rule.sides.includes(side)) return false;
  const allowed = action === 'CANCEL' && side === 'INSTITUTION' ? INSTITUTION_CANCEL_FROM : rule.from;
  return allowed.includes(from as CampusDriveState);
}

/** The actions a side may take from a state, in the order a screen should offer them. */
export function availableCampusDriveActions(side: CampusDriveSide, from: string): readonly CampusDriveAction[] {
  return (['APPROVE', 'REQUEST_CHANGES', 'REJECT', 'SCHEDULE', 'RESUBMIT', 'COMPLETE', 'CANCEL'] as const)
    .filter((action) => canTakeCampusDriveAction(side, from, action));
}

/**
 * The state an action leads to. APPROVE goes to SCHEDULED when the college confirms a start at the
 * same time. Throws CAMPUS_DRIVE_TRANSITION_NOT_ALLOWED when the side may not act from `from`.
 */
export function campusDriveTarget(side: CampusDriveSide, from: string, action: CampusDriveAction, withSchedule = false): CampusDriveState {
  if (!canTakeCampusDriveAction(side, from, action)) {
    throw new HiringRuleError('CAMPUS_DRIVE_TRANSITION_NOT_ALLOWED', `A ${from} drive cannot be ${action.toLowerCase().replace('_', ' ')} by the ${side.toLowerCase()}.`);
  }
  switch (action) {
    case 'RESUBMIT': return 'REQUESTED';
    case 'APPROVE': return withSchedule ? 'SCHEDULED' : 'APPROVED';
    case 'REJECT': return 'REJECTED';
    case 'REQUEST_CHANGES': return 'CHANGES_REQUESTED';
    case 'SCHEDULE': return 'SCHEDULED';
    case 'CANCEL': return 'CANCELLED';
    case 'COMPLETE': return 'COMPLETED';
  }
}

/** Reason codes. Fixed lists, no OTHER: the note carries detail. */
export const campusDriveRejectReasonCodes = ['SEASON_CLOSED', 'SCHEDULE_CONFLICT', 'ROLE_NOT_SUITABLE', 'TERMS_NOT_ACCEPTABLE', 'EMPLOYER_CONCERN', 'DUPLICATE_REQUEST'] as const;
export const campusDriveChangeReasonCodes = ['SCHEDULE_CHANGE_NEEDED', 'ELIGIBILITY_CHANGE_NEEDED', 'TERMS_CLARIFICATION_NEEDED', 'DETAILS_MISSING'] as const;
export const campusDriveEmployerCancelReasonCodes = ['HIRING_ON_HOLD', 'ROLE_CANCELLED', 'POSITIONS_FILLED', 'SCHEDULE_UNWORKABLE', 'REQUESTED_IN_ERROR'] as const;
export const campusDriveInstitutionCancelReasonCodes = ['SCHEDULE_UNWORKABLE', 'SEASON_CLOSED', 'EMPLOYER_CONCERN', 'POLICY_CONFLICT'] as const;
export const placementPolicyRetireReasonCodes = ['POLICY_CHANGED', 'SEASON_ENDED', 'SET_IN_ERROR'] as const;

/** The reason codes an action accepts from a side; null when the action takes none. */
export function campusDriveReasonCodes(side: CampusDriveSide, action: CampusDriveAction): readonly string[] | null {
  if (action === 'REJECT') return campusDriveRejectReasonCodes;
  if (action === 'REQUEST_CHANGES') return campusDriveChangeReasonCodes;
  if (action === 'CANCEL') return side === 'EMPLOYER' ? campusDriveEmployerCancelReasonCodes : campusDriveInstitutionCancelReasonCodes;
  return null;
}

export const venueModes = ['ON_CAMPUS', 'VIRTUAL', 'OFF_CAMPUS'] as const;

export const placementPolicyTypes = ['ONE_OFFER_PER_STUDENT'] as const;
export type PlacementPolicyType = typeof placementPolicyTypes[number];

export interface PlacementPolicyInForce {
  readonly id: string;
  readonly policyType: PlacementPolicyType;
  readonly allowDriveExceptions: boolean;
}

export interface OneOfferFacts {
  /** The drive is marked by the college as open to students who already hold an offer. */
  readonly driveOfferHoldersEligible: boolean;
  /** The student holds an accepted offer anywhere in ONE (see `holdsAcceptedOffer`). */
  readonly holdsAcceptedOffer: boolean;
}

/**
 * Whether the college's one-offer rule stops this student applying through this drive. The
 * exception needs both the policy to allow exceptions and the college to have marked the drive.
 */
export function oneOfferPolicyBlocks(policy: PlacementPolicyInForce | null, facts: OneOfferFacts): boolean {
  if (!policy || policy.policyType !== 'ONE_OFFER_PER_STUDENT') return false;
  if (!facts.holdsAcceptedOffer) return false;
  return !(policy.allowDriveExceptions && facts.driveOfferHoldersEligible);
}

/**
 * An accepted offer counts while the application it came from is still standing: an offer in
 * ACCEPTED on an application not later withdrawn or rejected, or an application HIRED.
 */
export function holdsAcceptedOffer(applications: readonly { readonly state: string; readonly offerStates: readonly string[] }[]): boolean {
  return applications.some((application) => application.state === 'HIRED'
    || (application.offerStates.includes('ACCEPTED') && application.state !== 'WITHDRAWN' && application.state !== 'REJECTED'));
}
