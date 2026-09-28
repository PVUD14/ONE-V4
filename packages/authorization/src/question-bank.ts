/**
 * Question bank editor rules (OPS-09b, Appendix 1 §3 Content, §5.3, §5.4).
 *
 * Who may read the bank, who may see an answer key, who may move a question revision along the
 * 0004 content lifecycle, the reason codes each write carries, and when a publish needs a
 * second person's approval — declared once, as data and pure functions, so the API and the web
 * screen agree. Nothing here names a role; capabilities are `hasInternalCapability`.
 *
 * The lifecycle and the contributor rule are OPS-09a's (skill-map.ts): whoever wrote, edited or
 * submitted a revision never reviews or publishes it.
 *
 * Design: docs/architecture/question-bank-editor-design.md
 */
import { hasInternalCapability, type InternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';
import {
  skillEditableRevisionStates,
  skillOpenRevisionStates,
  skillRevisionStates,
  skillRevisionTransitions,
  skillTransitionCapability,
  type SkillRevisionState,
} from './skill-map.js';

export type QuestionRevisionState = SkillRevisionState;
export const questionRevisionStates = skillRevisionStates;
export const questionOpenRevisionStates = skillOpenRevisionStates;
export const questionEditableRevisionStates = skillEditableRevisionStates;
export const questionRevisionTransitions = skillRevisionTransitions;

/** §5.3: reason codes are defined in code, per write. */
export const questionBankReasons = {
  create: ['NEW_QUESTION', 'TRACK_BUILD'],
  revise: ['CORRECTION', 'DISTRACTOR_CHANGE', 'HINT_CHANGE', 'EXPERT_FEEDBACK'],
  save: ['DRAFT_EDIT'],
  transition: {
    IN_REVIEW: ['READY_FOR_REVIEW', 'CHANGES_MADE'],
    CHANGES_REQUESTED: ['CONTENT_INACCURATE', 'ANSWER_KEY_WRONG', 'DISTRACTORS_WEAK', 'HINTS_REVEAL_ANSWER', 'RIGHTS_NOT_CLEARED', 'EXPERT_CHECK_OPEN'],
    APPROVED: ['REVIEW_PASSED'],
  },
  /** The reviewer's confirmation of the rights the author declared, recorded in rights_reviews. */
  rights: ['OWNERSHIP_VERIFIED', 'LICENCE_VERIFIED'],
} as const;

/** Why a question is published; part of the approved payload. */
export const questionPublishReasons = ['NEW_QUESTION', 'QUESTION_REVISION', 'CORRECTION', 'TRACK_RELEASE'] as const;

/** Content staff read the bank. Catalogue managers, institution staff and students do not. */
export const questionBankReadCapabilities: readonly InternalCapability[] = ['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH'];

export function canReadQuestionBank(context: InternalCapabilityContext): boolean {
  return questionBankReadCapabilities.some((capability) => hasInternalCapability(context, capability));
}

/** Answer keys (and the tags that reveal which options are wrong) only to editors and reviewers. */
export function canSeeAnswerKeys(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'CONTENT_EDIT') || hasInternalCapability(context, 'CONTENT_REVIEW');
}

export const questionTransitionCapability = skillTransitionCapability;

export type QuestionBankRefusal =
  | 'FORBIDDEN'
  | 'QUESTION_TRANSITION_NOT_ALLOWED'
  | 'REASON_CODE_INVALID'
  | 'QUESTION_SELF_REVIEW_REFUSED'
  | 'QUESTION_SELF_PUBLISH_REFUSED';

type Actor = InternalCapabilityContext & { readonly userId: string };

/**
 * Whether an operator may move a revision, or why not. `contributorUserIds` is the author, every
 * editor and every submitter; none of them reviews it. Approving is also the rights review, so it
 * needs a rights reason.
 */
export function refuseQuestionTransition(input: {
  readonly actor: Actor;
  readonly from: QuestionRevisionState;
  readonly to: QuestionRevisionState;
  readonly reasonCode: string;
  readonly rightsReasonCode?: string | null;
  readonly contributorUserIds: readonly string[];
}): QuestionBankRefusal | null {
  if (!questionRevisionTransitions[input.from].includes(input.to)) return 'QUESTION_TRANSITION_NOT_ALLOWED';
  const reasons = (questionBankReasons.transition as Readonly<Record<string, readonly string[]>>)[input.to] ?? [];
  if (!reasons.includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (input.to === 'APPROVED' && !(questionBankReasons.rights as readonly string[]).includes(input.rightsReasonCode ?? '')) return 'REASON_CODE_INVALID';
  if (input.to !== 'APPROVED' && input.rightsReasonCode) return 'REASON_CODE_INVALID';
  if (!hasInternalCapability(input.actor, questionTransitionCapability(input.to))) return 'FORBIDDEN';
  if (input.to !== 'IN_REVIEW' && input.contributorUserIds.includes(input.actor.userId)) return 'QUESTION_SELF_REVIEW_REFUSED';
  return null;
}

/** Publishing needs CONTENT_PUBLISH and a publisher who wrote, edited and submitted none of it. */
export function refuseQuestionPublish(input: {
  readonly actor: Actor;
  readonly contributorUserIds: readonly string[];
}): QuestionBankRefusal | null {
  if (!hasInternalCapability(input.actor, 'CONTENT_PUBLISH')) return 'FORBIDDEN';
  if (input.contributorUserIds.includes(input.actor.userId)) return 'QUESTION_SELF_PUBLISH_REFUSED';
  return null;
}

/**
 * §5.4: a publish that changes readiness inputs needs an approval. A question publish always
 * does while the readiness check draws from every current published question: a new or revised
 * item changes what the check can ask and how its evidence is scored. If the pool is ever scoped
 * (to a blueprint's topics), this is the one place that changes.
 */
export function questionPublishAltersReadinessInputs(facts: { readonly readinessPool: 'EVERY_PUBLISHED_QUESTION' }): boolean {
  return facts.readinessPool === 'EVERY_PUBLISHED_QUESTION';
}

/** Today's pool, as the readiness check selects it (packages/persistence career-readiness.ts). */
export const currentReadinessPool = 'EVERY_PUBLISHED_QUESTION' as const;
