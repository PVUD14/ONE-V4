/**
 * Lead pipeline rules (GROWTH-04; design §6): the stage machine a growth person moves, the handoff
 * request to operations, and the derived milestones' vocabulary.
 *
 * Why this exists: the API, the web lead page and the phone must agree on which moves are allowed
 * and which need a reason, and the database trigger repeats the parts that protect onboarding (a
 * lost or handed-off lead never moves; HANDOFF_REQUESTED is entered only with an open request).
 * Pure functions, no I/O.
 *
 * Design: docs/architecture/growth-college-pipeline-table-design.md
 */
import { refuseGrowthLeadReassign, type GrowthLeadCaller, type GrowthLeadFacts, type GrowthLeadKind } from './growth-leads.js';

/** The stages a growth person works through, in order, per kind (ON_HOLD, LOST and HANDOFF_REQUESTED are separate). */
export const growthWorkingStages: Readonly<Record<GrowthLeadKind, readonly string[]>> = {
  COLLEGE: ['IDENTIFIED', 'CONTACTED', 'MEETING_SCHEDULED', 'MET', 'PROPOSAL_SHARED', 'NEGOTIATION', 'AGREEMENT_SIGNED_REPORTED'],
  EMPLOYER: ['IDENTIFIED', 'CONTACTED', 'MEETING_SCHEDULED', 'MET', 'INTERESTED', 'ACCESS_REQUEST_INVITED'],
};

export const growthStageReasons = {
  backward: ['MEETING_CANCELLED', 'PROPOSAL_REVISED', 'CORRECTION'],
  hold: ['ORGANISATION_PAUSED', 'BUDGET_CYCLE', 'LEADERSHIP_CHANGE', 'OTHER'],
  lost: ['NO_BUDGET', 'CHOSE_COMPETITOR', 'NOT_DECISION_MAKER', 'NO_RESPONSE', 'NOT_ELIGIBLE', 'DUPLICATE', 'OTHER'],
  resume: ['RESUMED'],
} as const;

export const growthHandoffDeclineReasons = ['NOT_A_REAL_COLLEGE', 'DUPLICATE_OF_EXISTING', 'INCOMPLETE', 'CONTRACT_NOT_CONFIRMED'] as const;
export type GrowthHandoffDeclineReason = (typeof growthHandoffDeclineReasons)[number];

/** The derived milestones of a handed-off college, in the order the screens show them. */
export const growthCollegeMilestones = [
  'HANDED_OFF', 'CONTRACT_RECORDED', 'VERIFIED', 'ADMIN_JOINED', 'DATA_TERMS_ACCEPTED', 'FIRST_ROSTER', 'STUDENTS_ACTIVATING',
  'FIRST_PAYMENT_CLEARED', 'EXITED',
] as const;
export type GrowthCollegeMilestone = (typeof growthCollegeMilestones)[number];

/** Same shape as OPS-14's `contract_reference` (0078): an identifier, never an amount, name or sentence. */
export const growthContractReferencePattern = /^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,63}$/;

/** OPS-14's contact roles a lead contact keeps when it is carried to the college's account; the rest become OTHER. */
export function growthContactRoleOnAccount(role: string): 'PRINCIPAL' | 'PLACEMENT_OFFICER' | 'OTHER' {
  return role === 'PRINCIPAL' || role === 'PLACEMENT_OFFICER' ? role : 'OTHER';
}

export type GrowthStageRefusal =
  | 'GROWTH_LEAD_NOT_FOUND'
  | 'GROWTH_NOT_LEAD_OWNER'
  | 'GROWTH_LEAD_CLOSED'
  | 'GROWTH_LEAD_DO_NOT_CONTACT'
  | 'GROWTH_STAGE_INVALID'
  | 'GROWTH_STAGE_UNCHANGED'
  | 'GROWTH_STAGE_REASON_REQUIRED'
  | 'GROWTH_STAGE_NEEDS_HANDOFF_ROUTE'
  | 'GROWTH_STAGE_IN_HANDOFF'
  | 'GROWTH_STAGE_NOT_ON_HOLD';

export interface GrowthStageMove {
  readonly kind: GrowthLeadKind;
  readonly from: string;
  /** The target stage, or 'RESUME' to come back from ON_HOLD. */
  readonly to: string;
  readonly reasonCode: string | null;
  readonly doNotContact: boolean;
  readonly handedOff: boolean;
}

const has = (list: readonly string[], value: string | null): boolean => value !== null && list.includes(value);

/** Whether a move is allowed by the stage machine (who moves it is `refuseGrowthStageWriter`). */
export function refuseGrowthStageMove(move: GrowthStageMove): GrowthStageRefusal | null {
  const working = growthWorkingStages[move.kind];
  if (move.handedOff || move.from === 'LOST') return 'GROWTH_LEAD_CLOSED';
  if (move.from === 'HANDOFF_REQUESTED') return 'GROWTH_STAGE_IN_HANDOFF';
  if (move.to === 'HANDOFF_REQUESTED') return 'GROWTH_STAGE_NEEDS_HANDOFF_ROUTE';
  if (move.doNotContact && move.to !== 'LOST') return 'GROWTH_LEAD_DO_NOT_CONTACT';
  if (move.to === 'RESUME') {
    if (move.from !== 'ON_HOLD') return 'GROWTH_STAGE_NOT_ON_HOLD';
    return null;
  }
  if (move.to === move.from) return 'GROWTH_STAGE_UNCHANGED';
  if (move.to === 'LOST') return has(growthStageReasons.lost, move.reasonCode) ? null : 'GROWTH_STAGE_REASON_REQUIRED';
  if (move.to === 'ON_HOLD') {
    if (!working.includes(move.from)) return 'GROWTH_STAGE_INVALID';
    return has(growthStageReasons.hold, move.reasonCode) ? null : 'GROWTH_STAGE_REASON_REQUIRED';
  }
  if (!working.includes(move.to)) return 'GROWTH_STAGE_INVALID';
  // From ON_HOLD a person resumes (back where they were), they do not jump.
  if (!working.includes(move.from)) return 'GROWTH_STAGE_INVALID';
  const backward = working.indexOf(move.to) < working.indexOf(move.from);
  if (backward && !has(growthStageReasons.backward, move.reasonCode)) return 'GROWTH_STAGE_REASON_REQUIRED';
  return null;
}

/** The stages a person may pick next from `from` (for the screens); RESUME stands for "back from hold". */
export function growthNextStages(kind: GrowthLeadKind, from: string): readonly string[] {
  if (from === 'LOST' || from === 'HANDOFF_REQUESTED') return [];
  if (from === 'ON_HOLD') return ['RESUME', 'LOST'];
  return [...growthWorkingStages[kind].filter((stage) => stage !== from), 'ON_HOLD', 'LOST'];
}

/** The stage a lead returns to from ON_HOLD: the stage it held when it was put on hold. */
export function growthResumeStage(history: readonly { readonly from: string | null; readonly to: string }[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]!;
    if (entry.to === 'ON_HOLD') return entry.from;
  }
  return null;
}

/** Moving a stage or asking for the handoff: the owner, or a manager who could reassign the lead. */
export function refuseGrowthStageWriter(caller: GrowthLeadCaller, lead: GrowthLeadFacts): 'GROWTH_LEAD_NOT_FOUND' | 'GROWTH_NOT_LEAD_OWNER' | null {
  const owns = lead.ownerMembershipId !== null && caller.memberships.some((membership) => membership.membershipId === lead.ownerMembershipId);
  if (owns) return null;
  const refusal = refuseGrowthLeadReassign(caller, { ...lead, doNotContact: false, open: true });
  if (refusal === 'GROWTH_LEAD_NOT_FOUND') return 'GROWTH_LEAD_NOT_FOUND';
  return refusal === null ? null : 'GROWTH_NOT_LEAD_OWNER';
}

export type GrowthHandoffRefusal =
  | 'GROWTH_HANDOFF_COLLEGES_ONLY'
  | 'GROWTH_HANDOFF_NEEDS_AGREEMENT'
  | 'GROWTH_LEAD_DO_NOT_CONTACT'
  | 'GROWTH_LEAD_CLOSED'
  | 'GROWTH_CONTRACT_REFERENCE_INVALID';

/** A handoff request (design §6.3): a college lead at AGREEMENT_SIGNED_REPORTED, contactable, with a reported reference. */
export function refuseGrowthHandoffRequest(lead: { readonly kind: GrowthLeadKind; readonly stage: string; readonly doNotContact: boolean; readonly handedOff: boolean }, contractReference: unknown): GrowthHandoffRefusal | null {
  if (lead.kind !== 'COLLEGE') return 'GROWTH_HANDOFF_COLLEGES_ONLY';
  if (lead.handedOff || lead.stage === 'LOST') return 'GROWTH_LEAD_CLOSED';
  if (lead.doNotContact) return 'GROWTH_LEAD_DO_NOT_CONTACT';
  if (lead.stage !== 'AGREEMENT_SIGNED_REPORTED') return 'GROWTH_HANDOFF_NEEDS_AGREEMENT';
  if (typeof contractReference !== 'string' || !growthContractReferencePattern.test(contractReference.trim())) return 'GROWTH_CONTRACT_REFERENCE_INVALID';
  return null;
}
