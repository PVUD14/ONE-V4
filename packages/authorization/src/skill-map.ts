/**
 * Skill map editor rules (OPS-09a, Appendix 1 §3 Content, §5.3, §5.4).
 *
 * Who may move a skill revision along the 0004 content lifecycle, the reason codes each write
 * carries, and when a publish changes readiness inputs and so needs a second person's approval
 * — declared once, as data and pure functions, so the API and the web screen agree. Nothing
 * here names a role; capabilities are `hasInternalCapability`.
 *
 * The author rule is widened to contributors: whoever saved an edit to a revision wrote it,
 * and never reviews or publishes it.
 *
 * Design: docs/architecture/skill-map-editor-design.md
 */
import { hasInternalCapability, type InternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

export const skillRevisionStates = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'ARCHIVED'] as const;
export type SkillRevisionState = (typeof skillRevisionStates)[number];

/** A revision still on its way to publication; a skill has at most one. */
export const skillOpenRevisionStates: readonly SkillRevisionState[] = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED'];
/** States in which the body may still be edited. */
export const skillEditableRevisionStates: readonly SkillRevisionState[] = ['DRAFT', 'CHANGES_REQUESTED'];

/** Operator moves. APPROVED → PUBLISHED is the publish, not listed here. Mirrors 0004's lifecycle. */
export const skillRevisionTransitions: Readonly<Record<SkillRevisionState, readonly SkillRevisionState[]>> = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['CHANGES_REQUESTED', 'APPROVED'],
  CHANGES_REQUESTED: ['IN_REVIEW'],
  APPROVED: [],
  PUBLISHED: [],
  ARCHIVED: [],
};

/** §5.3: reason codes are defined in code, per write. */
export const skillMapReasons = {
  create: ['NEW_SKILL', 'TRACK_BUILD'],
  revise: ['LEVEL_DESCRIPTORS', 'PREREQUISITE_CHANGE', 'CORRECTION', 'EXPERT_FEEDBACK'],
  save: ['DRAFT_EDIT'],
  transition: {
    IN_REVIEW: ['READY_FOR_REVIEW', 'CHANGES_MADE'],
    CHANGES_REQUESTED: ['CONTENT_INACCURATE', 'LEVELS_UNCLEAR', 'PREREQUISITES_WRONG', 'RIGHTS_NOT_CLEARED', 'EXPERT_CHECK_OPEN'],
    APPROVED: ['REVIEW_PASSED'],
  },
  /** The reviewer's confirmation of the rights the author declared, recorded in rights_reviews. */
  rights: ['OWNERSHIP_VERIFIED', 'LICENCE_VERIFIED'],
} as const;

/** Why a skill is published; part of the approved payload when an approval is needed. */
export const skillPublishReasons = ['NEW_SKILL', 'SKILL_REVISION', 'CORRECTION', 'TRACK_RELEASE'] as const;

/** Anyone who works content or the catalogue may read the skill map. */
export const skillMapReadCapabilities: readonly InternalCapability[] = ['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH', 'CATALOGUE_MANAGE'];

export function canReadSkillMap(context: InternalCapabilityContext): boolean {
  return skillMapReadCapabilities.some((capability) => hasInternalCapability(context, capability));
}

export function isSkillRevisionState(value: unknown): value is SkillRevisionState {
  return typeof value === 'string' && (skillRevisionStates as readonly string[]).includes(value);
}

/** The capability a move needs: submitting is editing work; the rest is review. */
export function skillTransitionCapability(to: SkillRevisionState): InternalCapability {
  return to === 'IN_REVIEW' ? 'CONTENT_EDIT' : 'CONTENT_REVIEW';
}

export type SkillMapRefusal =
  | 'FORBIDDEN'
  | 'SKILL_TRANSITION_NOT_ALLOWED'
  | 'REASON_CODE_INVALID'
  | 'SKILL_SELF_REVIEW_REFUSED'
  | 'SKILL_SELF_PUBLISH_REFUSED';

type Actor = InternalCapabilityContext & { readonly userId: string };

/**
 * Whether an operator may move a revision, or why not. `contributorUserIds` is the author
 * plus everyone who saved an edit; none of them reviews it. A rights reason is required to
 * approve, because approving is also the rights review.
 */
export function refuseSkillTransition(input: {
  readonly actor: Actor;
  readonly from: SkillRevisionState;
  readonly to: SkillRevisionState;
  readonly reasonCode: string;
  readonly rightsReasonCode?: string | null;
  readonly contributorUserIds: readonly string[];
}): SkillMapRefusal | null {
  if (!skillRevisionTransitions[input.from].includes(input.to)) return 'SKILL_TRANSITION_NOT_ALLOWED';
  const reasons = (skillMapReasons.transition as Readonly<Record<string, readonly string[]>>)[input.to] ?? [];
  if (!reasons.includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (input.to === 'APPROVED' && !(skillMapReasons.rights as readonly string[]).includes(input.rightsReasonCode ?? '')) return 'REASON_CODE_INVALID';
  if (input.to !== 'APPROVED' && input.rightsReasonCode) return 'REASON_CODE_INVALID';
  if (!hasInternalCapability(input.actor, skillTransitionCapability(input.to))) return 'FORBIDDEN';
  if (input.to !== 'IN_REVIEW' && input.contributorUserIds.includes(input.actor.userId)) return 'SKILL_SELF_REVIEW_REFUSED';
  return null;
}

/** Publishing needs CONTENT_PUBLISH and a publisher who wrote none of the revision. */
export function refuseSkillPublish(input: {
  readonly actor: Actor;
  readonly contributorUserIds: readonly string[];
}): SkillMapRefusal | null {
  if (!hasInternalCapability(input.actor, 'CONTENT_PUBLISH')) return 'FORBIDDEN';
  if (input.contributorUserIds.includes(input.actor.userId)) return 'SKILL_SELF_PUBLISH_REFUSED';
  return null;
}

/**
 * §5.4: a publish that changes readiness inputs needs an approval. It does when the skill
 * goes live for the first time (it becomes measurable: evidence, exam mapping, and the
 * requirement sets naming it become publishable) or when a live requirement names it (the
 * definition students' gaps are measured against changes).
 */
export function skillPublishAltersReadinessInputs(facts: {
  readonly firstPublish: boolean;
  readonly liveRequirementCount: number;
}): boolean {
  return facts.firstPublish || facts.liveRequirementCount > 0;
}
