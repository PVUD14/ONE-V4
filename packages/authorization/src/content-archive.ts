/**
 * Archiving published content (skills, questions, lessons): who may archive, the reason codes,
 * and what may not be archived out from under something live.
 *
 * Why this exists: the 0004 lifecycle ends PUBLISHED → ARCHIVED, but no editor built that step,
 * so published content could never be withdrawn (ENG-17's rollback runbook, gap 1). Archiving is a
 * removal: it needs CONTENT_PUBLISH and a reason, is recorded, and needs no second person.
 * Pure functions, evaluated by the persistence layer against rows read under the editor's lock.
 *
 * Design: docs/architecture/content-archive-design.md
 */
import { hasInternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

/** §5.3: why published content is withdrawn, defined in code. */
export const contentArchiveReasons = ['CONTENT_INACCURATE', 'RIGHTS_WITHDRAWN', 'OUT_OF_DATE', 'DUPLICATE', 'INCIDENT_RESPONSE'] as const;
export type ContentArchiveReason = (typeof contentArchiveReasons)[number];

export type ContentArchiveKind = 'SKILL' | 'QUESTION' | 'LESSON';

type Actor = InternalCapabilityContext & { readonly userId: string };

/** Archiving is the reverse of publishing: CONTENT_PUBLISH and a reason code from the list. */
export function refuseContentArchive(input: { readonly actor: Actor; readonly reasonCode: string }): 'FORBIDDEN' | 'REASON_CODE_INVALID' | null {
  if (!hasInternalCapability(input.actor, 'CONTENT_PUBLISH')) return 'FORBIDDEN';
  if (!(contentArchiveReasons as readonly string[]).includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  return null;
}

/** Why an archive would leave something live pointing at something that is not. Stable codes, safe to show. */
export type ContentArchiveBlocker =
  | 'ARCHIVE_OPEN_REVISION'
  | 'SKILL_REQUIRED_BY_ROLE'
  | 'SKILL_PREREQUISITE_OF_LIVE_SKILL'
  | 'SKILL_HAS_LIVE_QUESTIONS'
  | 'SKILL_HAS_LIVE_LESSONS'
  | 'LESSON_HAS_LIVE_VARIANTS'
  | 'LESSON_PREREQUISITE_OF_LIVE_LESSON';

/**
 * A skill is archived only when nothing live depends on it: no open revision (publishing it would
 * bring the skill back), no live requirement (readiness is measured against it), no live skill
 * naming it as a prerequisite, and no current question or lesson on it (the readiness pool reads
 * question versions, not the skill's `active` flag).
 */
export function skillArchiveBlockers(facts: {
  readonly openRevision: boolean;
  readonly liveRequirementCount: number;
  readonly liveDependentSkillCount: number;
  readonly currentQuestionCount: number;
  readonly currentLessonCount: number;
}): readonly ContentArchiveBlocker[] {
  const blockers: ContentArchiveBlocker[] = [];
  if (facts.openRevision) blockers.push('ARCHIVE_OPEN_REVISION');
  if (facts.liveRequirementCount > 0) blockers.push('SKILL_REQUIRED_BY_ROLE');
  if (facts.liveDependentSkillCount > 0) blockers.push('SKILL_PREREQUISITE_OF_LIVE_SKILL');
  if (facts.currentQuestionCount > 0) blockers.push('SKILL_HAS_LIVE_QUESTIONS');
  if (facts.currentLessonCount > 0) blockers.push('SKILL_HAS_LIVE_LESSONS');
  return blockers;
}

/** A question is archived only without an open revision. */
export function questionArchiveBlockers(facts: { readonly openRevision: boolean }): readonly ContentArchiveBlocker[] {
  return facts.openRevision ? ['ARCHIVE_OPEN_REVISION'] : [];
}

/**
 * A lesson is archived only without an open revision; a base lesson also only when none of its
 * variants is live and no current lesson lists it as a prerequisite.
 */
export function lessonArchiveBlockers(facts: {
  readonly openRevision: boolean;
  readonly liveVariantCount: number;
  readonly liveDependentLessonCount: number;
}): readonly ContentArchiveBlocker[] {
  const blockers: ContentArchiveBlocker[] = [];
  if (facts.openRevision) blockers.push('ARCHIVE_OPEN_REVISION');
  if (facts.liveVariantCount > 0) blockers.push('LESSON_HAS_LIVE_VARIANTS');
  if (facts.liveDependentLessonCount > 0) blockers.push('LESSON_PREREQUISITE_OF_LIVE_LESSON');
  return blockers;
}
