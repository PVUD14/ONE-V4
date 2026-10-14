/**
 * Attribution rules (GROWTH-07; design §8): who is credited for an organisation, how a dispute
 * changes it, who may decide or reassign, the dispute window and the self-dealing guard.
 *
 * Why this exists: the onboarding route, the growth and Operations attribution routes and both
 * clients must agree on the vocabulary and on who may act, and 0110's CHECKs and triggers repeat
 * the parts that decide who is paid. Pure functions, no I/O. No amount is computed here or anywhere
 * in this goal (rates are GROWTH-09, the ledger GROWTH-11).
 *
 * Design: docs/architecture/growth-attribution-table-design.md
 */
import type { GrowthEmployerCandidateBasis } from './growth-employer.js';

export const growthAttributionBases = ['LEAD_OWNER_AT_HANDOFF', 'REFERRAL_LINK', 'DISPUTE_DECISION', 'MANUAL_CORRECTION'] as const;
export type GrowthAttributionBasis = (typeof growthAttributionBases)[number];

/** A reassignment's reasons (basis MANUAL_CORRECTION); the same list as 0110's CHECK. */
export const growthAttributionReassignReasons = ['BENEFICIARY_LEFT', 'WRONG_PERSON_CREDITED', 'TEAM_CHANGE', 'CORRECTION'] as const;
export type GrowthAttributionReassignReason = (typeof growthAttributionReassignReasons)[number];

export const growthAttributionEndReasons = ['REASSIGNED', 'DISPUTE_DECISION', 'CORRECTION', 'ORGANIZATION_EXITED'] as const;
export type GrowthAttributionEndReason = (typeof growthAttributionEndReasons)[number];
/** The ends a growth admin may make without a successor. */
export const growthAttributionAdminEndReasons = ['CORRECTION', 'ORGANIZATION_EXITED'] as const satisfies readonly GrowthAttributionEndReason[];

export const growthDisputeOrigins = ['CLAIM', 'ONBOARDING_CONFLICT'] as const;
export type GrowthDisputeOrigin = (typeof growthDisputeOrigins)[number];
export const growthDisputeStates = ['OPEN', 'UPHELD', 'REJECTED'] as const;
export type GrowthDisputeState = (typeof growthDisputeStates)[number];
export const growthDisputeOutcomes = ['UPHELD', 'REJECTED'] as const;
export type GrowthDisputeOutcome = (typeof growthDisputeOutcomes)[number];
export const growthDisputeDecisionReasons = ['CLAIMANT_DID_THE_WORK', 'RESPONDENT_DID_THE_WORK', 'INSUFFICIENT_EVIDENCE', 'OUTSIDE_POLICY', 'OTHER'] as const;
export type GrowthDisputeDecisionReason = (typeof growthDisputeDecisionReasons)[number];

export const growthLeaverEvents = ['LEFT', 'RETURNED'] as const;

/** Design §8.4 [decided, O-8]: a claim within 90 days of the organisation's handoff. */
export const GROWTH_DISPUTE_WINDOW_DAYS = 90;
/** Design §8.5 [decided, O-5]: a leaver's entries that become payable within 90 days of leaving are settled. */
export const GROWTH_LEAVER_SETTLEMENT_DAYS = 90;
export const GROWTH_DISPUTE_STATEMENT_MAX = 2000;
export const GROWTH_DISPUTE_NOTE_MAX = 1000;

const dayMs = 24 * 60 * 60 * 1000;

export type GrowthOrganizationKind = 'INSTITUTION' | 'EMPLOYER';

/** The team whose people may be credited for an organisation of this kind (reassignment target). */
export function growthTeamForOrganizationKind(kind: GrowthOrganizationKind): 'COLLEGE_PARTNERSHIPS' | 'EMPLOYER_PARTNERSHIPS' {
  return kind === 'INSTITUTION' ? 'COLLEGE_PARTNERSHIPS' : 'EMPLOYER_PARTNERSHIPS';
}

export type GrowthOnboardingAttribution =
  | { readonly kind: 'ATTRIBUTE'; readonly basis: 'REFERRAL_LINK' | 'LEAD_OWNER_AT_HANDOFF'; readonly beneficiaryUserId: string }
  | { readonly kind: 'DISPUTE'; readonly claimantUserId: string; readonly respondentUserId: string }
  | { readonly kind: 'NONE' };

/**
 * Design §8.3, turned into credit at an employer's first onboarding: the referrer, else the lead
 * owner; a conflict writes no attribution and opens a dispute with the referrer as claimant (the
 * referral comes first) and the lead owner as respondent; house writes nothing.
 */
export function growthAttributionFromCandidate(candidate: GrowthEmployerCandidateBasis, people: {
  readonly referrerUserId: string | null; readonly leadOwnerUserId: string | null;
}): GrowthOnboardingAttribution {
  if (candidate === 'REFERRAL_LINK' && people.referrerUserId) return { kind: 'ATTRIBUTE', basis: 'REFERRAL_LINK', beneficiaryUserId: people.referrerUserId };
  if (candidate === 'LEAD_OWNER_AT_HANDOFF' && people.leadOwnerUserId) return { kind: 'ATTRIBUTE', basis: 'LEAD_OWNER_AT_HANDOFF', beneficiaryUserId: people.leadOwnerUserId };
  if (candidate === 'CONFLICT' && people.referrerUserId && people.leadOwnerUserId && people.referrerUserId !== people.leadOwnerUserId) {
    return { kind: 'DISPUTE', claimantUserId: people.referrerUserId, respondentUserId: people.leadOwnerUserId };
  }
  return { kind: 'NONE' };
}

/** When the dispute window closes for an organisation handed off at `handedOffAt`. */
export function growthDisputeWindowEnds(handedOffAt: Date): Date {
  return new Date(handedOffAt.getTime() + GROWTH_DISPUTE_WINDOW_DAYS * dayMs);
}

export function growthDisputeWindowOpen(handedOffAt: Date | null, now: Date): boolean {
  return handedOffAt !== null && now.getTime() <= growthDisputeWindowEnds(handedOffAt).getTime();
}

/** The date a leaver's settlement period ends (design §8.5); the ledger applies it. */
export function growthLeaverSettlementEnds(leftAt: Date): Date {
  return new Date(leftAt.getTime() + GROWTH_LEAVER_SETTLEMENT_DAYS * dayMs);
}

/**
 * What a decision does (design table "Outcomes"): who is credited afterwards (null: nobody new),
 * and whether the disputed live attribution ends. Upheld credits the claimant; rejected keeps the
 * status quo, except an onboarding conflict, where rejecting the referrer credits the lead owner.
 */
export function growthDisputeDecisionEffect(dispute: {
  readonly origin: GrowthDisputeOrigin; readonly attributionId: string | null;
  readonly claimantUserId: string; readonly respondentUserId: string | null;
}, outcome: GrowthDisputeOutcome): { readonly creditUserId: string | null; readonly endsAttribution: boolean } {
  if (outcome === 'UPHELD') return { creditUserId: dispute.claimantUserId, endsAttribution: dispute.attributionId !== null };
  if (dispute.origin === 'ONBOARDING_CONFLICT') return { creditUserId: dispute.respondentUserId, endsAttribution: false };
  return { creditUserId: null, endsAttribution: false };
}

/** Design §8.6: the people with a stake in an organisation's credit may not act on it. */
export function growthSelfDealing(actorUserId: string, parties: readonly (string | null | undefined)[]): boolean {
  return parties.some((party) => party === actorUserId);
}

/** A dispute decision's refusal, or null: only a decision on an open dispute by someone who is neither party. */
export function refuseGrowthDisputeDecision(deciderUserId: string, dispute: {
  readonly state: string; readonly claimantUserId: string; readonly respondentUserId: string | null;
}): 'GROWTH_DISPUTE_DECIDED' | 'GROWTH_SELF_DEALING_REFUSED' | null {
  if (dispute.state !== 'OPEN') return 'GROWTH_DISPUTE_DECIDED';
  if (growthSelfDealing(deciderUserId, [dispute.claimantUserId, dispute.respondentUserId])) return 'GROWTH_SELF_DEALING_REFUSED';
  return null;
}

/** A reassignment's (or end's) refusal, or null. */
export function refuseGrowthAttributionChange(input: {
  readonly actorUserId: string; readonly currentBeneficiaryUserId: string; readonly newBeneficiaryUserId: string | null;
  readonly ended: boolean; readonly disputeOpen: boolean;
}): 'GROWTH_ATTRIBUTION_ENDED' | 'GROWTH_DISPUTE_OPEN' | 'GROWTH_SELF_DEALING_REFUSED' | 'GROWTH_ATTRIBUTION_UNCHANGED' | null {
  if (input.ended) return 'GROWTH_ATTRIBUTION_ENDED';
  if (input.disputeOpen) return 'GROWTH_DISPUTE_OPEN';
  if (growthSelfDealing(input.actorUserId, [input.currentBeneficiaryUserId, input.newBeneficiaryUserId])) return 'GROWTH_SELF_DEALING_REFUSED';
  if (input.newBeneficiaryUserId !== null && input.newBeneficiaryUserId === input.currentBeneficiaryUserId) return 'GROWTH_ATTRIBUTION_UNCHANGED';
  return null;
}

/** A claim's statement, trimmed, or null when empty or over 2000 characters. */
export function readGrowthDisputeStatement(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const statement = value.trim();
  return statement.length >= 1 && statement.length <= GROWTH_DISPUTE_STATEMENT_MAX ? statement : null;
}

/** A decision note: absent, or 1–1000 characters; required with OTHER. Returns undefined when invalid. */
export function readGrowthDisputeNote(value: unknown, reason: GrowthDisputeDecisionReason): string | null | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return reason === 'OTHER' ? undefined : null;
  if (typeof value !== 'string') return undefined;
  const note = value.trim();
  return note.length <= GROWTH_DISPUTE_NOTE_MAX ? note : undefined;
}

/** How a growth person is told about a dispute: the claimant sees their statement; the respondent never does. */
export function growthDisputeRoleFor(viewerUserId: string, dispute: { readonly claimantUserId: string; readonly respondentUserId: string | null }): 'CLAIMANT' | 'RESPONDENT' | null {
  if (dispute.claimantUserId === viewerUserId) return 'CLAIMANT';
  if (dispute.respondentUserId === viewerUserId) return 'RESPONDENT';
  return null;
}
