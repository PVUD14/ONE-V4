/**
 * Lesson and variant editor rules (OPS-09c): who reads lessons, who moves and publishes a lesson
 * revision (never its author, editors or submitter, and never its approver — the learner-content
 * lifecycle's rule), reason codes, and when a publish needs an approval (a base lesson's first
 * publish, or a change of skill or prerequisites; never a variant). Pure functions; the API spec
 * proves the endpoints and the 0004/0065 triggers agree.
 */
import { describe, expect, it } from 'vitest';
import { approvalRequestReasons, highRiskActions, isLegacyHighRiskActionKey, refuseApprovalRequest } from './high-risk-actions.js';
import {
  canReadLessons,
  lessonPublishAltersReadinessInputs,
  lessonPublishReasons,
  refuseLessonPublish,
  refuseLessonTransition,
  type LessonRevisionState,
} from './lesson-editor.js';

const withGrants = (userId: string, grants: readonly string[], state = 'ACTIVE') => ({ userId, memberships: [{ role: 'OPERATIONS_ADMIN', state, grants }] });
const editor = withGrants('editor', ['CONTENT_EDIT']);
const reviewer = withGrants('reviewer', ['CONTENT_REVIEW']);
const editorWhoReviews = withGrants('editor', ['CONTENT_EDIT', 'CONTENT_REVIEW']);
const publisher = withGrants('publisher', ['CONTENT_PUBLISH']);
const reviewerWhoPublishes = withGrants('reviewer', ['CONTENT_REVIEW', 'CONTENT_PUBLISH']);
const plain = { userId: 'ops', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] };

const move = (actor: typeof editor, from: LessonRevisionState, to: LessonRevisionState, reasonCode: string, contributors: readonly string[] = ['editor'], rightsReasonCode: string | null = null) =>
  refuseLessonTransition({ actor, from, to, reasonCode, rightsReasonCode, contributorUserIds: contributors });

describe('reading lessons', () => {
  it('reads with a content or catalogue capability on an ACTIVE platform membership only', () => {
    for (const actor of [editor, reviewer, publisher, withGrants('c', ['CATALOGUE_MANAGE'])]) expect(canReadLessons(actor)).toBe(true);
    expect(canReadLessons(plain)).toBe(false);
    expect(canReadLessons(withGrants('s', ['CONTENT_EDIT'], 'SUSPENDED'))).toBe(false);
    expect(canReadLessons({ memberships: [{ role: 'INSTITUTION_ADMIN', state: 'ACTIVE', grants: ['CONTENT_EDIT'] }] })).toBe(false);
  });
});

describe('moving a revision', () => {
  it('lets an editor submit and a reviewer who wrote none of it decide', () => {
    expect(move(editor, 'DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW')).toBeNull();
    expect(move(reviewer, 'IN_REVIEW', 'CHANGES_REQUESTED', 'TRANSLATION_INACCURATE')).toBeNull();
    expect(move(reviewer, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', ['editor'], 'OWNERSHIP_VERIFIED')).toBeNull();
  });

  it('refuses self-review by any contributor, a missing capability, a wrong reason, and moves outside the lifecycle', () => {
    expect(move(editorWhoReviews, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', ['someone', 'editor'], 'OWNERSHIP_VERIFIED')).toBe('LESSON_SELF_REVIEW_REFUSED');
    expect(move(editor, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', ['other'], 'OWNERSHIP_VERIFIED')).toBe('FORBIDDEN');
    expect(move(reviewer, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED')).toBe('REASON_CODE_INVALID');
    expect(move(editor, 'DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW', ['editor'], 'OWNERSHIP_VERIFIED')).toBe('REASON_CODE_INVALID');
    expect(move(editor, 'DRAFT', 'IN_REVIEW', 'BECAUSE')).toBe('REASON_CODE_INVALID');
    expect(move(reviewer, 'DRAFT', 'APPROVED', 'REVIEW_PASSED', ['editor'], 'OWNERSHIP_VERIFIED')).toBe('LESSON_TRANSITION_NOT_ALLOWED');
    expect(move(reviewer, 'APPROVED', 'CHANGES_REQUESTED', 'CONTENT_INACCURATE')).toBe('LESSON_TRANSITION_NOT_ALLOWED');
  });
});

describe('publishing', () => {
  it('needs CONTENT_PUBLISH, and refuses contributors and the approver', () => {
    expect(refuseLessonPublish({ actor: publisher, contributorUserIds: ['editor'], approverUserId: 'reviewer' })).toBeNull();
    expect(refuseLessonPublish({ actor: reviewer, contributorUserIds: ['editor'], approverUserId: 'someone' })).toBe('FORBIDDEN');
    expect(refuseLessonPublish({ actor: withGrants('editor', ['CONTENT_PUBLISH']), contributorUserIds: ['editor'], approverUserId: 'reviewer' })).toBe('LESSON_SELF_PUBLISH_REFUSED');
    expect(refuseLessonPublish({ actor: reviewerWhoPublishes, contributorUserIds: ['editor'], approverUserId: 'reviewer' })).toBe('LESSON_APPROVER_PUBLISH_REFUSED');
  });

  it('needs an approval only when completing the lesson would produce different evidence', () => {
    const facts = { isVariant: false, firstPublish: false, topicChanged: false, prerequisitesChanged: false };
    expect(lessonPublishAltersReadinessInputs(facts)).toBe(false);
    expect(lessonPublishAltersReadinessInputs({ ...facts, firstPublish: true })).toBe(true);
    expect(lessonPublishAltersReadinessInputs({ ...facts, topicChanged: true })).toBe(true);
    expect(lessonPublishAltersReadinessInputs({ ...facts, prerequisitesChanged: true })).toBe(true);
    expect(lessonPublishAltersReadinessInputs({ isVariant: true, firstPublish: true, topicChanged: true, prerequisitesChanged: true })).toBe(false);
  });

  it('is an extended high-risk action under CONTENT_PUBLISH with its own reasons', () => {
    expect(highRiskActions.CONTENT_LESSON_PUBLISH).toMatchObject({ capability: 'CONTENT_PUBLISH', targetType: 'content_revision' });
    expect(isLegacyHighRiskActionKey('CONTENT_LESSON_PUBLISH')).toBe(false);
    expect(approvalRequestReasons.CONTENT_LESSON_PUBLISH).toEqual(lessonPublishReasons);
    expect(refuseApprovalRequest(publisher, 'CONTENT_LESSON_PUBLISH')).toBeNull();
    expect(refuseApprovalRequest(editor, 'CONTENT_LESSON_PUBLISH')).toBe('FORBIDDEN');
  });
});
