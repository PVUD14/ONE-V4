/**
 * Lesson and variant editor rules (OPS-09c, Appendix 1 §3 Content, §5.3, §5.4).
 *
 * Who may read and write lessons, who may move a lesson revision along the lifecycle, the reason
 * codes each write carries, and when a publish changes readiness inputs and so needs a second
 * person's approval — declared once, as data and pure functions, so the API and the web screen
 * agree. Nothing here names a role; capabilities are `hasInternalCapability`.
 *
 * The lifecycle is OPS-09a's (the 0004 states, which the learner-content lifecycle shares). The
 * separation rules are the learner-content lifecycle's (0026): whoever wrote, edited or submitted
 * a revision never reviews or publishes it, and whoever approved it never publishes it.
 *
 * Design: docs/architecture/lesson-variant-editor-design.md
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

export type LessonRevisionState = SkillRevisionState;
export const lessonRevisionStates = skillRevisionStates;
export const lessonOpenRevisionStates = skillOpenRevisionStates;
export const lessonEditableRevisionStates = skillEditableRevisionStates;
export const lessonRevisionTransitions = skillRevisionTransitions;
export const lessonTransitionCapability = skillTransitionCapability;

/** §5.3: reason codes are defined in code, per write. */
export const lessonEditorReasons = {
  create: ['NEW_LESSON', 'TRACK_BUILD'],
  createVariant: ['NEW_LANGUAGE', 'NEW_LEVEL', 'NEW_STYLE', 'ACCESSIBILITY'],
  revise: ['CORRECTION', 'CONTENT_UPDATE', 'PREREQUISITE_CHANGE', 'EXPERT_FEEDBACK', 'TRANSLATION_UPDATE'],
  save: ['DRAFT_EDIT'],
  transition: {
    IN_REVIEW: ['READY_FOR_REVIEW', 'CHANGES_MADE'],
    CHANGES_REQUESTED: ['CONTENT_INACCURATE', 'TRANSLATION_INACCURATE', 'LEVEL_MISMATCH', 'PREREQUISITES_WRONG', 'RIGHTS_NOT_CLEARED', 'EXPERT_CHECK_OPEN'],
    APPROVED: ['REVIEW_PASSED'],
  },
  /** The reviewer's confirmation of the rights the author declared, recorded in rights_reviews. */
  rights: ['OWNERSHIP_VERIFIED', 'LICENCE_VERIFIED'],
  /**
   * ENG-16: approving a variant in a language other than English also records who checked the
   * language — the draft is marked for native-speaker review until then.
   */
  languageReview: ['NATIVE_SPEAKER_REVIEWED', 'NATIVE_SPEAKER_CONSULTED'],
} as const;

/** Whether approving a revision in `language` needs a native-speaker review code (ENG-16). */
export function lessonNeedsLanguageReview(language: string | null | undefined): boolean {
  return typeof language === 'string' && language !== '' && language !== 'en';
}

/** Why a lesson is published; part of the approved payload when an approval is needed. */
export const lessonPublishReasons = ['NEW_LESSON', 'LESSON_REVISION', 'NEW_VARIANT', 'CORRECTION', 'TRACK_RELEASE'] as const;

/** Anyone who works content or the catalogue may read lessons: they hold no answer keys. */
export const lessonEditorReadCapabilities: readonly InternalCapability[] = ['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH', 'CATALOGUE_MANAGE'];

export function canReadLessons(context: InternalCapabilityContext): boolean {
  return lessonEditorReadCapabilities.some((capability) => hasInternalCapability(context, capability));
}

export type LessonEditorRefusal =
  | 'FORBIDDEN'
  | 'LESSON_TRANSITION_NOT_ALLOWED'
  | 'REASON_CODE_INVALID'
  | 'LESSON_SELF_REVIEW_REFUSED'
  | 'LESSON_SELF_PUBLISH_REFUSED'
  | 'LESSON_APPROVER_PUBLISH_REFUSED'
  | 'LESSON_LANGUAGE_REVIEW_MISSING';

type Actor = InternalCapabilityContext & { readonly userId: string };

/**
 * Whether an operator may move a revision, or why not. `contributorUserIds` is the author, every
 * editor and every submitter; none of them reviews it. Approving is also the rights review, so it
 * needs a rights reason.
 */
export function refuseLessonTransition(input: {
  readonly actor: Actor;
  readonly from: LessonRevisionState;
  readonly to: LessonRevisionState;
  readonly reasonCode: string;
  readonly rightsReasonCode?: string | null;
  /** ENG-16: the revision's language, and the reviewer's native-speaker review code. */
  readonly language?: string | null;
  readonly languageReviewCode?: string | null;
  readonly contributorUserIds: readonly string[];
}): LessonEditorRefusal | null {
  if (!lessonRevisionTransitions[input.from].includes(input.to)) return 'LESSON_TRANSITION_NOT_ALLOWED';
  const reasons = (lessonEditorReasons.transition as Readonly<Record<string, readonly string[]>>)[input.to] ?? [];
  if (!reasons.includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (input.to === 'APPROVED' && !(lessonEditorReasons.rights as readonly string[]).includes(input.rightsReasonCode ?? '')) return 'REASON_CODE_INVALID';
  if (input.to !== 'APPROVED' && input.rightsReasonCode) return 'REASON_CODE_INVALID';
  const languageReview = input.to === 'APPROVED' && lessonNeedsLanguageReview(input.language);
  if (input.languageReviewCode && (!languageReview || !(lessonEditorReasons.languageReview as readonly string[]).includes(input.languageReviewCode))) return 'REASON_CODE_INVALID';
  if (!hasInternalCapability(input.actor, lessonTransitionCapability(input.to))) return 'FORBIDDEN';
  if (input.to !== 'IN_REVIEW' && input.contributorUserIds.includes(input.actor.userId)) return 'LESSON_SELF_REVIEW_REFUSED';
  if (languageReview && !input.languageReviewCode) return 'LESSON_LANGUAGE_REVIEW_MISSING';
  return null;
}

/**
 * Publishing needs CONTENT_PUBLISH and a publisher who neither wrote, edited or submitted the
 * revision nor approved it (the learner-content lifecycle's rule: the approver never publishes).
 */
export function refuseLessonPublish(input: {
  readonly actor: Actor;
  readonly contributorUserIds: readonly string[];
  readonly approverUserId: string | null;
}): LessonEditorRefusal | null {
  if (!hasInternalCapability(input.actor, 'CONTENT_PUBLISH')) return 'FORBIDDEN';
  if (input.contributorUserIds.includes(input.actor.userId)) return 'LESSON_SELF_PUBLISH_REFUSED';
  if (input.approverUserId !== null && input.approverUserId === input.actor.userId) return 'LESSON_APPROVER_PUBLISH_REFUSED';
  return null;
}

/**
 * §5.4: a publish that changes readiness inputs needs an approval. A lesson publish does when
 * completing the lesson would produce different evidence: a base lesson going live for the first
 * time (a new LESSON_COMPLETION source), or a revision that moves it to another skill or changes
 * its prerequisites. A wording-only revision, and every variant (another rendering of the same
 * lesson, completed as that lesson), leave completion and its evidence unchanged.
 */
export function lessonPublishAltersReadinessInputs(facts: {
  readonly isVariant: boolean;
  readonly firstPublish: boolean;
  readonly topicChanged: boolean;
  readonly prerequisitesChanged: boolean;
}): boolean {
  if (facts.isVariant) return false;
  return facts.firstPublish || facts.topicChanged || facts.prerequisitesChanged;
}
