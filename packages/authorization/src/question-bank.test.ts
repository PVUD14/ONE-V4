/**
 * Question bank editor rules (OPS-09b): who reads the bank, who sees an answer key, who moves and
 * publishes a question revision (never its author, editors or submitter), reason codes, and that
 * every publish needs an approval while the readiness check draws from every published question.
 * Pure functions; the API spec proves the endpoints and the 0004/0061 triggers agree.
 */
import { describe, expect, it } from 'vitest';
import { approvalRequestReasons, highRiskActions, isLegacyHighRiskActionKey, refuseApprovalRequest } from './high-risk-actions.js';
import {
  canReadQuestionBank,
  canSeeAnswerKeys,
  currentReadinessPool,
  questionPublishAltersReadinessInputs,
  questionPublishReasons,
  refuseQuestionPublish,
  refuseQuestionTransition,
  type QuestionRevisionState,
} from './question-bank.js';

const withGrants = (userId: string, grants: readonly string[], state = 'ACTIVE') => ({ userId, memberships: [{ role: 'OPERATIONS_ADMIN', state, grants }] });
const editor = withGrants('editor', ['CONTENT_EDIT']);
const reviewer = withGrants('reviewer', ['CONTENT_REVIEW']);
const editorWhoReviews = withGrants('editor', ['CONTENT_EDIT', 'CONTENT_REVIEW']);
const publisher = withGrants('publisher', ['CONTENT_PUBLISH']);
const plain = { userId: 'ops', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] };

const move = (actor: typeof editor, from: QuestionRevisionState, to: QuestionRevisionState, reasonCode: string, contributors: readonly string[] = ['editor'], rightsReasonCode: string | null = null) =>
  refuseQuestionTransition({ actor, from, to, reasonCode, rightsReasonCode, contributorUserIds: contributors });

describe('reading the bank and seeing answer keys', () => {
  it('reads with a content capability on an ACTIVE platform membership only', () => {
    expect(canReadQuestionBank(editor)).toBe(true);
    expect(canReadQuestionBank(reviewer)).toBe(true);
    expect(canReadQuestionBank(publisher)).toBe(true);
    expect(canReadQuestionBank(withGrants('c', ['CATALOGUE_MANAGE']))).toBe(false);
    expect(canReadQuestionBank(plain)).toBe(false);
    expect(canReadQuestionBank(withGrants('s', ['CONTENT_EDIT'], 'SUSPENDED'))).toBe(false);
    expect(canReadQuestionBank({ memberships: [{ role: 'INSTITUTION_ADMIN', state: 'ACTIVE', grants: ['CONTENT_EDIT'] }] })).toBe(false);
  });

  it('shows answer keys only with CONTENT_EDIT or CONTENT_REVIEW', () => {
    expect(canSeeAnswerKeys(editor)).toBe(true);
    expect(canSeeAnswerKeys(reviewer)).toBe(true);
    expect(canSeeAnswerKeys(publisher)).toBe(false);
    expect(canSeeAnswerKeys(plain)).toBe(false);
    expect(canSeeAnswerKeys(withGrants('e', ['CONTENT_EDIT'], 'ENDED'))).toBe(false);
    expect(canSeeAnswerKeys({ memberships: [{ role: 'STUDENT', state: 'ACTIVE' }] })).toBe(false);
  });
});

describe('question revision transitions', () => {
  it('lets an editor submit and a different reviewer request changes or approve (with a rights reason)', () => {
    expect(move(editor, 'DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW')).toBeNull();
    expect(move(editor, 'CHANGES_REQUESTED', 'IN_REVIEW', 'CHANGES_MADE')).toBeNull();
    expect(move(reviewer, 'IN_REVIEW', 'CHANGES_REQUESTED', 'HINTS_REVEAL_ANSWER')).toBeNull();
    expect(move(reviewer, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', ['editor'], 'LICENCE_VERIFIED')).toBeNull();
  });

  it('refuses a self-review by any contributor, even holding CONTENT_REVIEW', () => {
    expect(move(editorWhoReviews, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', ['author', 'editor'], 'OWNERSHIP_VERIFIED')).toBe('QUESTION_SELF_REVIEW_REFUSED');
    expect(move(editorWhoReviews, 'IN_REVIEW', 'CHANGES_REQUESTED', 'ANSWER_KEY_WRONG', ['editor'])).toBe('QUESTION_SELF_REVIEW_REFUSED');
  });

  it('needs a rights reason to approve, and only there', () => {
    expect(move(reviewer, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED')).toBe('REASON_CODE_INVALID');
    expect(move(reviewer, 'IN_REVIEW', 'CHANGES_REQUESTED', 'DISTRACTORS_WEAK', ['editor'], 'OWNERSHIP_VERIFIED')).toBe('REASON_CODE_INVALID');
  });

  it('follows the 0004 lifecycle and needs the capability the move uses', () => {
    expect(move(editor, 'DRAFT', 'APPROVED', 'REVIEW_PASSED', [], 'OWNERSHIP_VERIFIED')).toBe('QUESTION_TRANSITION_NOT_ALLOWED');
    expect(move(editor, 'PUBLISHED', 'IN_REVIEW', 'READY_FOR_REVIEW')).toBe('QUESTION_TRANSITION_NOT_ALLOWED');
    expect(move(editor, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', [], 'OWNERSHIP_VERIFIED')).toBe('FORBIDDEN');
    expect(move(reviewer, 'DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW')).toBe('FORBIDDEN');
    expect(move(withGrants('reviewer', ['CONTENT_REVIEW'], 'PENDING'), 'IN_REVIEW', 'CHANGES_REQUESTED', 'DISTRACTORS_WEAK')).toBe('FORBIDDEN');
    expect(move(editor, 'DRAFT', 'IN_REVIEW', 'FREE_TEXT')).toBe('REASON_CODE_INVALID');
  });
});

describe('publishing a question', () => {
  it('needs CONTENT_PUBLISH and a publisher who wrote, edited and submitted none of it', () => {
    expect(refuseQuestionPublish({ actor: publisher, contributorUserIds: ['editor'] })).toBeNull();
    expect(refuseQuestionPublish({ actor: withGrants('editor', ['CONTENT_PUBLISH']), contributorUserIds: ['author', 'editor'] })).toBe('QUESTION_SELF_PUBLISH_REFUSED');
    expect(refuseQuestionPublish({ actor: reviewer, contributorUserIds: ['editor'] })).toBe('FORBIDDEN');
    expect(refuseQuestionPublish({ actor: withGrants('publisher', ['CONTENT_PUBLISH'], 'SUSPENDED'), contributorUserIds: [] })).toBe('FORBIDDEN');
  });

  it('always changes readiness inputs while the check draws from every published question', () => {
    expect(currentReadinessPool).toBe('EVERY_PUBLISHED_QUESTION');
    expect(questionPublishAltersReadinessInputs({ readinessPool: currentReadinessPool })).toBe(true);
  });

  it('is an extended high-risk action held by CONTENT_PUBLISH, with its reasons in code', () => {
    expect(highRiskActions.CONTENT_QUESTION_PUBLISH).toMatchObject({ capability: 'CONTENT_PUBLISH', targetType: 'content_revision' });
    expect(isLegacyHighRiskActionKey('CONTENT_QUESTION_PUBLISH')).toBe(false);
    expect(approvalRequestReasons.CONTENT_QUESTION_PUBLISH).toEqual(questionPublishReasons);
    expect(refuseApprovalRequest({ ...publisher }, 'CONTENT_QUESTION_PUBLISH')).toBeNull();
    expect(refuseApprovalRequest({ ...editor }, 'CONTENT_QUESTION_PUBLISH')).toBe('FORBIDDEN');
    // The earlier extended keys are untouched.
    expect(highRiskActions.CONTENT_SKILL_PUBLISH.capability).toBe('CONTENT_PUBLISH');
    expect(highRiskActions.CAREER_REQUIREMENT_SET_PUBLISH.targetType).toBe('career_requirement_set');
  });
});
