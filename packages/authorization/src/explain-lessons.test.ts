/**
 * "Ask ONE to explain" review rules (ADR-052): any content capability reads the queue; withdrawing needs
 * CONTENT_REVIEW, promoting CONTENT_EDIT; each write carries one of its own reason codes.
 */
import { describe, expect, it } from 'vitest';
import { canReadExplainLessons, explainPromoteReasons, explainWithdrawReasons, refuseExplainReview } from './explain-lessons.js';

const withGrants = (userId: string, grants: readonly string[], state = 'ACTIVE') => ({ userId, memberships: [{ role: 'OPERATIONS_ADMIN', state, grants }] });
const editor = withGrants('editor', ['CONTENT_EDIT']);
const reviewer = withGrants('reviewer', ['CONTENT_REVIEW']);
const publisher = withGrants('publisher', ['CONTENT_PUBLISH']);
const plain = { userId: 'ops', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] };
const employer = { userId: 'emp', memberships: [{ role: 'EMPLOYER_ADMIN', state: 'ACTIVE', grants: ['CONTENT_REVIEW'] }] };

describe('explain lesson review', () => {
  it('reading the queue needs a content capability', () => {
    for (const actor of [editor, reviewer, publisher, withGrants('c', ['CATALOGUE_MANAGE'])]) expect(canReadExplainLessons(actor)).toBe(true);
    expect(canReadExplainLessons(plain)).toBe(false);
    expect(canReadExplainLessons(employer)).toBe(false);
  });

  it('withdraw is a reviewer\'s act, promote an author\'s, each with its own reasons', () => {
    expect(refuseExplainReview({ actor: reviewer, action: 'WITHDRAW', reasonCode: 'FACTUALLY_WRONG' })).toBeNull();
    expect(refuseExplainReview({ actor: editor, action: 'WITHDRAW', reasonCode: 'FACTUALLY_WRONG' })).toBe('FORBIDDEN');
    expect(refuseExplainReview({ actor: editor, action: 'PROMOTE', reasonCode: 'WORTH_OFFICIAL_LESSON' })).toBeNull();
    expect(refuseExplainReview({ actor: reviewer, action: 'PROMOTE', reasonCode: 'WORTH_OFFICIAL_LESSON' })).toBe('FORBIDDEN');
    expect(refuseExplainReview({ actor: reviewer, action: 'WITHDRAW', reasonCode: 'WORTH_OFFICIAL_LESSON' })).toBe('REASON_CODE_INVALID');
    expect(refuseExplainReview({ actor: withGrants('s', ['CONTENT_REVIEW'], 'SUSPENDED'), action: 'WITHDRAW', reasonCode: 'UNSAFE' })).toBe('FORBIDDEN');
    expect(explainWithdrawReasons).toContain('STUDENT_REPORTS');
    expect(explainPromoteReasons).toEqual(['WORTH_OFFICIAL_LESSON']);
  });
});
