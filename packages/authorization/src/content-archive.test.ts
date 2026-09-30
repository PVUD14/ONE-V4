/**
 * Archiving published content: CONTENT_PUBLISH and a coded reason, no second person, and refused
 * while something live still depends on the item (docs/architecture/content-archive-design.md).
 */
import { describe, expect, it } from 'vitest';
import {
  contentArchiveReasons,
  lessonArchiveBlockers,
  questionArchiveBlockers,
  refuseContentArchive,
  skillArchiveBlockers,
} from './content-archive.js';

const actor = (role: string, grants: string[] = []) => ({ userId: 'u-' + role, memberships: [{ role, state: 'ACTIVE', grants }] });

describe('who archives', () => {
  it('needs CONTENT_PUBLISH and a reason code from the list', () => {
    const publisher = actor('OPERATIONS_ADMIN', ['CONTENT_PUBLISH']);
    for (const reasonCode of contentArchiveReasons) expect(refuseContentArchive({ actor: publisher, reasonCode })).toBeNull();
    expect(refuseContentArchive({ actor: publisher, reasonCode: 'BECAUSE' })).toBe('REASON_CODE_INVALID');
    expect(refuseContentArchive({ actor: actor('OPERATIONS_ADMIN', ['CONTENT_EDIT', 'CONTENT_REVIEW']), reasonCode: 'OUT_OF_DATE' })).toBe('FORBIDDEN');
    expect(refuseContentArchive({ actor: actor('INSTITUTION_ADMIN', ['CONTENT_PUBLISH']), reasonCode: 'OUT_OF_DATE' })).toBe('FORBIDDEN');
  });
});

describe('what may be archived', () => {
  const clearSkill = { openRevision: false, liveRequirementCount: 0, liveDependentSkillCount: 0, currentQuestionCount: 0, currentLessonCount: 0 };

  it('archives a skill nothing live depends on, and names every dependency otherwise', () => {
    expect(skillArchiveBlockers(clearSkill)).toEqual([]);
    expect(skillArchiveBlockers({ openRevision: true, liveRequirementCount: 2, liveDependentSkillCount: 1, currentQuestionCount: 3, currentLessonCount: 1 }))
      .toEqual(['ARCHIVE_OPEN_REVISION', 'SKILL_REQUIRED_BY_ROLE', 'SKILL_PREREQUISITE_OF_LIVE_SKILL', 'SKILL_HAS_LIVE_QUESTIONS', 'SKILL_HAS_LIVE_LESSONS']);
    expect(skillArchiveBlockers({ ...clearSkill, currentQuestionCount: 1 })).toEqual(['SKILL_HAS_LIVE_QUESTIONS']);
  });

  it('archives a question unless a revision is on its way', () => {
    expect(questionArchiveBlockers({ openRevision: false })).toEqual([]);
    expect(questionArchiveBlockers({ openRevision: true })).toEqual(['ARCHIVE_OPEN_REVISION']);
  });

  it('archives a lesson unless a revision is open, a variant is live, or a live lesson needs it first', () => {
    expect(lessonArchiveBlockers({ openRevision: false, liveVariantCount: 0, liveDependentLessonCount: 0 })).toEqual([]);
    expect(lessonArchiveBlockers({ openRevision: false, liveVariantCount: 1, liveDependentLessonCount: 2 }))
      .toEqual(['LESSON_HAS_LIVE_VARIANTS', 'LESSON_PREREQUISITE_OF_LIVE_LESSON']);
  });
});
