/**
 * Content factory rules (ENG-23): who may ask ONE's AI for a draft or an answer check, the reason
 * codes a request carries, and how many jobs one person may have in flight — as data and pure
 * functions, so the API and the web screen agree.
 *
 * Asking for a draft is an author's act (CONTENT_EDIT): the requester becomes the draft's author,
 * so the existing editor rules keep them from reviewing, approving or publishing it. Asking for an
 * answer check is a reviewer's aid (CONTENT_REVIEW): its result is shown next to the answer key,
 * so only viewers who may see answer keys see it.
 *
 * Design: docs/architecture/content-factory-design.md
 */
import { hasInternalCapability, type InternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

export const contentFactoryKinds = ['LESSON', 'LESSON_VARIANT', 'QUESTION', 'ANSWER_CHECK'] as const;
export type ContentFactoryKind = (typeof contentFactoryKinds)[number];

/** The AI feature (flag and cap) each kind runs. Lessons and variants share one prompt, so one feature. */
export const contentFactoryFeatureKeys: Readonly<Record<ContentFactoryKind, string>> = {
  LESSON: 'content.lesson-draft',
  LESSON_VARIANT: 'content.lesson-draft',
  QUESTION: 'content.item-draft',
  ANSWER_CHECK: 'content.answer-check',
};

/** §5.3: reason codes are defined in code, per write. */
export const contentFactoryReasons: Readonly<Record<ContentFactoryKind, readonly string[]>> = {
  LESSON: ['NEW_LESSON', 'TRACK_BUILD'],
  LESSON_VARIANT: ['NEW_LANGUAGE', 'NEW_LEVEL', 'NEW_STYLE', 'ACCESSIBILITY'],
  QUESTION: ['NEW_QUESTION', 'TRACK_BUILD', 'BANK_COVERAGE'],
  ANSWER_CHECK: ['ANSWER_KEY_CHECK', 'REVIEW_SUPPORT'],
};

/** Jobs one person may have queued or running at once. */
export const contentFactoryMaxInFlight = 3;
/** The longest note a requester may add to what the model is asked. */
export const contentFactoryAuthorNoteMax = 1000;

export function contentFactoryCapability(kind: ContentFactoryKind): InternalCapability {
  return kind === 'ANSWER_CHECK' ? 'CONTENT_REVIEW' : 'CONTENT_EDIT';
}

/** Anyone who works lessons or questions sees the factory's state and its jobs (answer checks need the key, below). */
export const contentFactoryReadCapabilities: readonly InternalCapability[] = ['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH', 'CATALOGUE_MANAGE'];

export function canReadContentFactory(context: InternalCapabilityContext): boolean {
  return contentFactoryReadCapabilities.some((capability) => hasInternalCapability(context, capability));
}

/** An answer check reveals whether the key is right, so it follows the answer-key rule (OPS-09b). */
export function canSeeAnswerChecks(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'CONTENT_EDIT') || hasInternalCapability(context, 'CONTENT_REVIEW');
}

export type ContentFactoryRefusal = 'FORBIDDEN' | 'REASON_CODE_INVALID' | 'AI_DRAFT_KIND_INVALID';

/** Whether this person may ask for this kind of job with this reason, or why not. */
export function refuseContentDraftRequest(input: {
  readonly actor: InternalCapabilityContext;
  readonly kind: string;
  readonly reasonCode: string;
}): ContentFactoryRefusal | null {
  if (!(contentFactoryKinds as readonly string[]).includes(input.kind)) return 'AI_DRAFT_KIND_INVALID';
  const kind = input.kind as ContentFactoryKind;
  if (!hasInternalCapability(input.actor, contentFactoryCapability(kind))) return 'FORBIDDEN';
  if (!contentFactoryReasons[kind].includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  return null;
}
