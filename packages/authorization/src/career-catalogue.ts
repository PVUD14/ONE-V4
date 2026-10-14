/**
 * Job-role catalogue administration rules (OPS-08, Appendix 1 §3 Content, §5.3, §5.4).
 *
 * The requirement-set lifecycle, who may move a set along it, the reason codes each
 * operator write carries, and the catalogue vocabularies — declared once, as data, so
 * the API, the web screen and the 0051 trigger agree. The capability checks themselves
 * are `hasInternalCapability`; nothing here names a role.
 *
 * Publishing is not a transition here: it is the high-risk action
 * CAREER_REQUIREMENT_SET_PUBLISH (high-risk-actions.ts), done only with an approval.
 *
 * Design: docs/architecture/career-catalogue-table-design.md
 */
import { hasInternalCapability, type InternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

/** Feature flag that lets students see and pick the full catalogue (default off, created by 0051). */
export const careerCatalogueStudentFlagKey = 'career-catalogue.selectable-roles';

export const careerCatalogueFamilies = [
  { code: 'A', label: 'Software, IT and product' },
  { code: 'B', label: 'Data, AI and cybersecurity' },
  { code: 'C', label: 'Electronics, electrical and instrumentation' },
  { code: 'D', label: 'Mechanical, manufacturing, chemical and process' },
  { code: 'E', label: 'Civil and construction' },
  { code: 'F', label: 'Business, finance, sales and operations' },
] as const;
export type CareerCatalogueFamily = (typeof careerCatalogueFamilies)[number]['code'];

export const careerReleaseLabels = ['SELECTABLE', 'VERIFIED'] as const;
export type CareerReleaseLabel = (typeof careerReleaseLabels)[number];

export const careerPlannedReleases = ['V1', 'V2', 'V3'] as const;

export const careerRequirementLevels = ['ESSENTIAL', 'IMPORTANT', 'HELPFUL'] as const;

/** The evidence_records.evidence_type vocabulary: a requirement can only ask for evidence ONE records. */
export const careerRequiredEvidenceTypes = ['LESSON_COMPLETION', 'ASSESSMENT_OUTCOME', 'TOPIC_DEMONSTRATION'] as const;

export const careerRequirementSetStates = ['DRAFT', 'IN_REVIEW', 'REVIEWED', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'] as const;
export type CareerRequirementSetState = (typeof careerRequirementSetStates)[number];

/** Operator transitions. REVIEWED → PUBLISHED is the approved publish, not listed here. */
export const careerRequirementSetTransitions: Readonly<Record<CareerRequirementSetState, readonly CareerRequirementSetState[]>> = {
  DRAFT: ['IN_REVIEW', 'WITHDRAWN'],
  IN_REVIEW: ['REVIEWED', 'DRAFT', 'WITHDRAWN'],
  REVIEWED: ['DRAFT', 'WITHDRAWN'],
  PUBLISHED: [],
  SUPERSEDED: [],
  WITHDRAWN: [],
};

/**
 * The capability an operator transition needs. Passing or sending back a review is the
 * reviewer's call (CONTENT_REVIEW); submitting, withdrawing and an author recalling their
 * own set are catalogue work (CATALOGUE_MANAGE).
 */
export function careerTransitionCapability(to: CareerRequirementSetState, reasonCode: string): InternalCapability {
  if (to === 'REVIEWED') return 'CONTENT_REVIEW';
  if (to === 'DRAFT' && reasonCode === 'CHANGES_REQUESTED') return 'CONTENT_REVIEW';
  return 'CATALOGUE_MANAGE';
}

/** §5.3: reason codes are defined in code, per write. */
export const careerCatalogueReasons = {
  synonymAdd: ['STUDENT_WORDING', 'INDUSTRY_TITLE', 'REGIONAL_TITLE', 'CORRECTION'],
  synonymRemove: ['MISLEADING', 'DUPLICATE', 'CORRECTION'],
  draftCreate: ['NEW_REQUIREMENT_SET', 'REVISION', 'EVIDENCE_UPDATE'],
  itemsSave: ['DRAFT_EDIT'],
  transition: {
    IN_REVIEW: ['READY_FOR_REVIEW'],
    REVIEWED: ['REVIEW_PASSED'],
    DRAFT: ['CHANGES_REQUESTED', 'AUTHOR_RECALL'],
    WITHDRAWN: ['ABANDONED', 'SUPERSEDED_BY_NEW_DRAFT', 'ENTERED_IN_ERROR'],
  },
} as const;

/** Why a publish is requested; part of the approved payload (high-risk-actions.ts). */
export const careerPublishReasons = ['NEW_REQUIREMENT_SET', 'REQUIREMENT_CORRECTION', 'ROLE_VERIFIED', 'EVIDENCE_UPDATE'] as const;

/** Anyone who works the catalogue may read it. */
export const careerCatalogueReadCapabilities: readonly InternalCapability[] = ['CATALOGUE_MANAGE', 'CONTENT_REVIEW', 'CONTENT_PUBLISH'];

export function canReadCareerCatalogue(context: InternalCapabilityContext): boolean {
  return careerCatalogueReadCapabilities.some((capability) => hasInternalCapability(context, capability));
}

export function isCareerRequirementSetState(value: unknown): value is CareerRequirementSetState {
  return typeof value === 'string' && (careerRequirementSetStates as readonly string[]).includes(value);
}

export type CareerTransitionRefusal =
  | 'FORBIDDEN'
  | 'CAREER_SET_TRANSITION_NOT_ALLOWED'
  | 'REASON_CODE_INVALID'
  | 'CAREER_SET_SELF_REVIEW_REFUSED';

/**
 * Whether an operator may move a set from one state to another, or why not. The reviewer
 * is never the author: a second pair of eyes is the point of review (the 0051 trigger
 * repeats this).
 */
export function refuseCareerSetTransition(input: {
  readonly actor: InternalCapabilityContext & { readonly userId: string };
  readonly from: CareerRequirementSetState;
  readonly to: CareerRequirementSetState;
  readonly reasonCode: string;
  readonly authorUserId: string;
}): CareerTransitionRefusal | null {
  if (!careerRequirementSetTransitions[input.from].includes(input.to)) return 'CAREER_SET_TRANSITION_NOT_ALLOWED';
  const reasons = (careerCatalogueReasons.transition as Readonly<Record<string, readonly string[]>>)[input.to] ?? [];
  if (!reasons.includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (!hasInternalCapability(input.actor, careerTransitionCapability(input.to, input.reasonCode))) return 'FORBIDDEN';
  if (input.to === 'REVIEWED' && input.actor.userId === input.authorUserId) return 'CAREER_SET_SELF_REVIEW_REFUSED';
  // Recalling a draft from review is for its author; anyone else sends it back as a reviewer.
  if (input.to === 'DRAFT' && input.reasonCode === 'AUTHOR_RECALL' && input.actor.userId !== input.authorUserId) return 'REASON_CODE_INVALID';
  if (input.to === 'DRAFT' && input.reasonCode === 'CHANGES_REQUESTED' && input.actor.userId === input.authorUserId) return 'CAREER_SET_SELF_REVIEW_REFUSED';
  return null;
}

/** Lower-case, trimmed, single-spaced: the form synonyms and searches are compared in (0051 CHECK). */
export function normalizeCareerSynonym(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Branch labels in `eligible_branches` that mean "every branch". */
export const careerAllBranchLabels = ['all branches', 'any'] as const;

/** Whether a role with these typical branches is open to a student of this branch. */
export function careerRoleMatchesBranch(eligibleBranches: readonly string[], branch: string): boolean {
  const wanted = branch.trim().toLowerCase();
  return eligibleBranches.some((label) => {
    const value = label.trim().toLowerCase();
    return value === wanted || (careerAllBranchLabels as readonly string[]).includes(value);
  });
}
