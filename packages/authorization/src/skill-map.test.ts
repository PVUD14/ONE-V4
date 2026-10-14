/**
 * Skill map editor rules (OPS-09a): who may read, move and publish a skill revision, the
 * contributor rule (no one reviews or publishes what they wrote), reason codes, and when a
 * publish changes readiness inputs and so needs an approval. Pure functions; the API spec
 * proves the endpoints and the 0004/0057 triggers agree.
 */
import { describe, expect, it } from 'vitest';
import { approvalRequestReasons, highRiskActions, isLegacyHighRiskActionKey, refuseApprovalRequest } from './high-risk-actions.js';
import {
  canReadSkillMap,
  refuseSkillPublish,
  refuseSkillTransition,
  skillPublishAltersReadinessInputs,
  skillPublishReasons,
  type SkillRevisionState,
} from './skill-map.js';

const withGrants = (userId: string, grants: readonly string[], state = 'ACTIVE') => ({ userId, memberships: [{ role: 'OPERATIONS_ADMIN', state, grants }] });
const editor = withGrants('editor', ['CONTENT_EDIT']);
const reviewer = withGrants('reviewer', ['CONTENT_REVIEW']);
const editorWhoReviews = withGrants('editor', ['CONTENT_EDIT', 'CONTENT_REVIEW']);
const publisher = withGrants('publisher', ['CONTENT_PUBLISH']);
const plain = { userId: 'ops', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] };

const move = (actor: typeof editor, from: SkillRevisionState, to: SkillRevisionState, reasonCode: string, contributors: readonly string[] = ['editor'], rightsReasonCode: string | null = null) =>
  refuseSkillTransition({ actor, from, to, reasonCode, rightsReasonCode, contributorUserIds: contributors });

describe('reading the skill map', () => {
  it('needs a content or catalogue capability on an ACTIVE membership', () => {
    expect(canReadSkillMap(editor)).toBe(true);
    expect(canReadSkillMap(reviewer)).toBe(true);
    expect(canReadSkillMap(publisher)).toBe(true);
    expect(canReadSkillMap(withGrants('c', ['CATALOGUE_MANAGE']))).toBe(true);
    expect(canReadSkillMap(plain)).toBe(false);
    expect(canReadSkillMap(withGrants('s', ['CONTENT_EDIT'], 'SUSPENDED'))).toBe(false);
    expect(canReadSkillMap({ memberships: [{ role: 'INSTITUTION_ADMIN', state: 'ACTIVE', grants: ['CONTENT_EDIT'] }] })).toBe(false);
  });
});

describe('skill revision transitions', () => {
  it('lets an editor submit and a different reviewer request changes or approve (with a rights reason)', () => {
    expect(move(editor, 'DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW')).toBeNull();
    expect(move(editor, 'CHANGES_REQUESTED', 'IN_REVIEW', 'CHANGES_MADE')).toBeNull();
    expect(move(reviewer, 'IN_REVIEW', 'CHANGES_REQUESTED', 'LEVELS_UNCLEAR')).toBeNull();
    expect(move(reviewer, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', ['editor'], 'OWNERSHIP_VERIFIED')).toBeNull();
  });

  it('refuses a self-review by the author or any contributor, even holding CONTENT_REVIEW', () => {
    expect(move(editorWhoReviews, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', ['editor'], 'OWNERSHIP_VERIFIED')).toBe('SKILL_SELF_REVIEW_REFUSED');
    expect(move(editorWhoReviews, 'IN_REVIEW', 'CHANGES_REQUESTED', 'LEVELS_UNCLEAR', ['importer', 'editor'])).toBe('SKILL_SELF_REVIEW_REFUSED');
  });

  it('approving is also the rights review: a rights reason is required, and only there', () => {
    expect(move(reviewer, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED')).toBe('REASON_CODE_INVALID');
    expect(move(reviewer, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', ['editor'], 'MADE_UP')).toBe('REASON_CODE_INVALID');
    expect(move(reviewer, 'IN_REVIEW', 'CHANGES_REQUESTED', 'LEVELS_UNCLEAR', ['editor'], 'OWNERSHIP_VERIFIED')).toBe('REASON_CODE_INVALID');
  });

  it('follows the 0004 lifecycle and needs the capability the move uses', () => {
    expect(move(editor, 'DRAFT', 'APPROVED', 'REVIEW_PASSED', [], 'OWNERSHIP_VERIFIED')).toBe('SKILL_TRANSITION_NOT_ALLOWED');
    expect(move(editor, 'APPROVED', 'IN_REVIEW', 'READY_FOR_REVIEW')).toBe('SKILL_TRANSITION_NOT_ALLOWED');
    expect(move(editor, 'IN_REVIEW', 'APPROVED', 'REVIEW_PASSED', [], 'OWNERSHIP_VERIFIED')).toBe('FORBIDDEN');
    expect(move(reviewer, 'DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW')).toBe('FORBIDDEN');
    expect(move(withGrants('reviewer', ['CONTENT_REVIEW'], 'ENDED'), 'IN_REVIEW', 'CHANGES_REQUESTED', 'LEVELS_UNCLEAR')).toBe('FORBIDDEN');
    expect(move(editor, 'DRAFT', 'IN_REVIEW', 'FREE_TEXT')).toBe('REASON_CODE_INVALID');
  });
});

describe('publishing a skill', () => {
  it('needs CONTENT_PUBLISH and a publisher who wrote none of it', () => {
    expect(refuseSkillPublish({ actor: publisher, contributorUserIds: ['editor'] })).toBeNull();
    expect(refuseSkillPublish({ actor: withGrants('editor', ['CONTENT_PUBLISH']), contributorUserIds: ['importer', 'editor'] })).toBe('SKILL_SELF_PUBLISH_REFUSED');
    expect(refuseSkillPublish({ actor: reviewer, contributorUserIds: ['editor'] })).toBe('FORBIDDEN');
    expect(refuseSkillPublish({ actor: withGrants('publisher', ['CONTENT_PUBLISH'], 'SUSPENDED'), contributorUserIds: [] })).toBe('FORBIDDEN');
  });

  it('needs an approval when it changes readiness inputs: a first publish, or a skill a live requirement names', () => {
    expect(skillPublishAltersReadinessInputs({ firstPublish: true, liveRequirementCount: 0 })).toBe(true);
    expect(skillPublishAltersReadinessInputs({ firstPublish: false, liveRequirementCount: 2 })).toBe(true);
    expect(skillPublishAltersReadinessInputs({ firstPublish: false, liveRequirementCount: 0 })).toBe(false);
  });

  it('is an extended high-risk action held by CONTENT_PUBLISH, with its reasons in code', () => {
    expect(highRiskActions.CONTENT_SKILL_PUBLISH).toMatchObject({ capability: 'CONTENT_PUBLISH', targetType: 'content_revision' });
    expect(isLegacyHighRiskActionKey('CONTENT_SKILL_PUBLISH')).toBe(false);
    expect(approvalRequestReasons.CONTENT_SKILL_PUBLISH).toEqual(skillPublishReasons);
    expect(refuseApprovalRequest({ ...publisher }, 'CONTENT_SKILL_PUBLISH')).toBeNull();
    expect(refuseApprovalRequest({ ...editor }, 'CONTENT_SKILL_PUBLISH')).toBe('FORBIDDEN');
  });
});
