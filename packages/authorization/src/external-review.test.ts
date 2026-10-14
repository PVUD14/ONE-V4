/**
 * External faculty review rules (OPS-10, ADR-037): who grants, who assigns, which faculty
 * membership may act in which college, the conflict rules, the decision's reason codes and
 * comment, and how an assignment's status is derived. Pure functions; the API spec proves the
 * endpoints and the 0066 trigger agree.
 */
import { describe, expect, it } from 'vitest';
import {
  canAdministerExternalReviewers,
  canAssignExternalReviews,
  canReadExternalReviews,
  externalReviewerMembershipsIn,
  externalReviewReasons,
  externalReviewStatus,
  isEligibleExternalReviewer,
  refuseExternalReviewAssignment,
  refuseExternalReviewDecision,
  refuseExternalReviewerGrant,
  refuseExternalReviewerRevoke,
  refuseExternalReviewUnassign,
} from './external-review.js';

const operator = (userId: string, grants: readonly string[], state = 'ACTIVE', role = 'OPERATIONS_ADMIN') => ({ userId, memberships: [{ role, state, grants }] });
const faculty = { userId: 'f', role: 'FACULTY_LECTURER', state: 'ACTIVE', organizationKind: 'INSTITUTION' };

describe('who may read, assign and administer external reviews', () => {
  it('lets content staff read, CONTENT_REVIEW assign and CAPABILITY_ADMIN administer', () => {
    for (const grant of ['CONTENT_EDIT', 'CONTENT_REVIEW', 'CONTENT_PUBLISH']) expect(canReadExternalReviews(operator('o', [grant]))).toBe(true);
    expect(canAssignExternalReviews(operator('r', ['CONTENT_REVIEW']))).toBe(true);
    expect(canAdministerExternalReviewers({ memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE' }] })).toBe(true);
  });

  it('denies a capability not held, an inactive membership, and institution roles with stray grants', () => {
    expect(canReadExternalReviews(operator('c', ['CATALOGUE_MANAGE']))).toBe(false);
    expect(canAssignExternalReviews(operator('e', ['CONTENT_EDIT']))).toBe(false);
    expect(canAssignExternalReviews(operator('r', ['CONTENT_REVIEW'], 'SUSPENDED'))).toBe(false);
    expect(canAdministerExternalReviewers(operator('o', []))).toBe(false);
    expect(canReadExternalReviews(operator('f', ['CONTENT_REVIEW_EXTERNAL', 'CONTENT_REVIEW'], 'ACTIVE', 'FACULTY_LECTURER'))).toBe(false);
    expect(canAssignExternalReviews(operator('i', ['CONTENT_REVIEW'], 'ACTIVE', 'INSTITUTION_ADMIN'))).toBe(false);
  });
});

describe('granting the faculty grant', () => {
  const admin = { userId: 'a', memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE' }] };

  it('allows an ACTIVE institution faculty member or department head', () => {
    expect(refuseExternalReviewerGrant({ actor: admin, target: faculty, reasonCode: 'FACULTY_REVIEWER_AGREED' })).toBeNull();
    expect(refuseExternalReviewerGrant({ actor: admin, target: { ...faculty, role: 'DEPARTMENT_HEAD' }, reasonCode: 'FACULTY_REVIEWER_AGREED' })).toBeNull();
  });

  it('refuses other roles, other organisations, inactive memberships, self-grants, unlisted reasons and non-admins', () => {
    for (const role of ['INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'STUDENT', 'OPERATIONS_ADMIN']) {
      expect(refuseExternalReviewerGrant({ actor: admin, target: { ...faculty, role }, reasonCode: 'FACULTY_REVIEWER_AGREED' })).toBe('EXTERNAL_REVIEWER_NOT_ELIGIBLE');
    }
    expect(refuseExternalReviewerGrant({ actor: admin, target: { ...faculty, organizationKind: 'EMPLOYER' }, reasonCode: 'FACULTY_REVIEWER_AGREED' })).toBe('EXTERNAL_REVIEWER_NOT_ELIGIBLE');
    expect(refuseExternalReviewerGrant({ actor: admin, target: { ...faculty, state: 'SUSPENDED' }, reasonCode: 'FACULTY_REVIEWER_AGREED' })).toBe('EXTERNAL_REVIEWER_NOT_ELIGIBLE');
    expect(refuseExternalReviewerGrant({ actor: admin, target: { ...faculty, userId: 'a' }, reasonCode: 'FACULTY_REVIEWER_AGREED' })).toBe('EXTERNAL_REVIEWER_SELF_CHANGE_REFUSED');
    expect(refuseExternalReviewerGrant({ actor: admin, target: faculty, reasonCode: 'BECAUSE' })).toBe('REASON_CODE_INVALID');
    expect(refuseExternalReviewerGrant({ actor: operator('o', ['CONTENT_REVIEW']), target: faculty, reasonCode: 'FACULTY_REVIEWER_AGREED' })).toBe('FORBIDDEN');
  });

  it('revokes from a membership that is no longer active, but never from a platform membership', () => {
    expect(refuseExternalReviewerRevoke({ actor: admin, target: { ...faculty, state: 'ENDED' }, reasonCode: 'LEAVER' })).toBeNull();
    expect(refuseExternalReviewerRevoke({ actor: admin, target: { ...faculty, role: 'OPERATIONS_ADMIN', organizationKind: 'PLATFORM' }, reasonCode: 'LEAVER' })).toBe('EXTERNAL_REVIEWER_NOT_ELIGIBLE');
    expect(refuseExternalReviewerRevoke({ actor: admin, target: faculty, reasonCode: 'FACULTY_REVIEWER_AGREED' })).toBe('REASON_CODE_INVALID');
    expect(isEligibleExternalReviewer({ ...faculty, state: 'PENDING' })).toBe(false);
  });
});

describe('assigning a draft', () => {
  const reviewer = operator('r', ['CONTENT_REVIEW']);
  const base = { actor: reviewer, reviewerUserId: 'f', reviewerEligible: true, revisionState: 'IN_REVIEW', contributorUserIds: ['author', 'editor'], reasonCode: 'SUBJECT_EXPERT_REVIEW', days: 14 };

  it('allows a non-contributor with CONTENT_REVIEW to assign an in-review revision to an eligible reviewer', () => {
    expect(refuseExternalReviewAssignment(base)).toBeNull();
  });

  it('refuses contributors on either side, the assigner as reviewer, ineligible reviewers and other states', () => {
    expect(refuseExternalReviewAssignment({ ...base, actor: operator('editor', ['CONTENT_REVIEW']) })).toBe('EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED');
    expect(refuseExternalReviewAssignment({ ...base, reviewerUserId: 'author' })).toBe('EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED');
    expect(refuseExternalReviewAssignment({ ...base, reviewerUserId: 'r' })).toBe('EXTERNAL_REVIEW_SELF_ASSIGN_REFUSED');
    expect(refuseExternalReviewAssignment({ ...base, reviewerEligible: false })).toBe('EXTERNAL_REVIEWER_NOT_ELIGIBLE');
    for (const state of ['DRAFT', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED']) {
      expect(refuseExternalReviewAssignment({ ...base, revisionState: state })).toBe('EXTERNAL_REVIEW_REVISION_NOT_IN_REVIEW');
    }
  });

  it('bounds the window to 1–30 whole days and needs a listed reason and CONTENT_REVIEW', () => {
    for (const days of [0, 31, 1.5, Number.NaN]) expect(refuseExternalReviewAssignment({ ...base, days })).toBe('EXTERNAL_REVIEW_WINDOW_INVALID');
    expect(refuseExternalReviewAssignment({ ...base, days: 1 })).toBeNull();
    expect(refuseExternalReviewAssignment({ ...base, days: 30 })).toBeNull();
    expect(refuseExternalReviewAssignment({ ...base, reasonCode: 'REVIEW_PASSED' })).toBe('REASON_CODE_INVALID');
    expect(refuseExternalReviewAssignment({ ...base, actor: operator('p', ['CONTENT_PUBLISH']) })).toBe('FORBIDDEN');
    expect(refuseExternalReviewUnassign({ actor: reviewer, reasonCode: 'REASSIGNED' })).toBeNull();
    expect(refuseExternalReviewUnassign({ actor: operator('e', ['CONTENT_EDIT']), reasonCode: 'REASSIGNED' })).toBe('FORBIDDEN');
  });
});

describe('which faculty membership may act in a college', () => {
  const memberships = [
    { id: 'm1', organizationId: 'college-a', role: 'FACULTY_LECTURER', state: 'ACTIVE', grants: ['CONTENT_REVIEW_EXTERNAL'] },
    { id: 'm2', organizationId: 'college-b', role: 'FACULTY_LECTURER', state: 'ACTIVE', grants: [] },
    { id: 'm3', organizationId: 'college-b', role: 'INSTITUTION_ADMIN', state: 'ACTIVE', grants: ['CONTENT_REVIEW_EXTERNAL'] },
    { id: 'm4', organizationId: 'college-c', role: 'DEPARTMENT_HEAD', state: 'SUSPENDED', grants: ['CONTENT_REVIEW_EXTERNAL'] },
  ];

  it('is the granted, ACTIVE faculty or department-head membership in that college only', () => {
    expect(externalReviewerMembershipsIn(memberships, 'college-a').map((m) => m.id)).toEqual(['m1']);
    expect(externalReviewerMembershipsIn(memberships, 'college-b')).toEqual([]);
    expect(externalReviewerMembershipsIn(memberships, 'college-c')).toEqual([]);
  });
});

describe('the faculty decision', () => {
  const input = { reviewerUserId: 'f', contributorUserIds: ['author'], decision: 'APPROVE' as const, reasonCode: 'REVIEW_PASSED', comment: null };

  it('approves with a listed reason, and requests changes only with a comment', () => {
    expect(refuseExternalReviewDecision(input)).toBeNull();
    expect(refuseExternalReviewDecision({ ...input, decision: 'REQUEST_CHANGES', reasonCode: 'CONTENT_INACCURATE', comment: 'Synthetic: step 2 is wrong.' })).toBeNull();
    expect(refuseExternalReviewDecision({ ...input, decision: 'REQUEST_CHANGES', reasonCode: 'CONTENT_INACCURATE', comment: null })).toBe('EXTERNAL_REVIEW_COMMENT_REQUIRED');
    expect(refuseExternalReviewDecision({ ...input, reasonCode: 'CONTENT_INACCURATE' })).toBe('REASON_CODE_INVALID');
    expect(refuseExternalReviewDecision({ ...input, comment: 'x'.repeat(2001) })).toBe('EXTERNAL_REVIEW_COMMENT_TOO_LONG');
    expect(refuseExternalReviewDecision({ ...input, reviewerUserId: 'author' })).toBe('EXTERNAL_REVIEW_CONTRIBUTOR_REFUSED');
  });

  it('declares every reason in the §5.3 pattern', () => {
    const all = [...externalReviewReasons.grant, ...externalReviewReasons.revoke, ...externalReviewReasons.assign, ...externalReviewReasons.unassign,
      ...externalReviewReasons.decision.APPROVE, ...externalReviewReasons.decision.REQUEST_CHANGES];
    for (const reason of all) expect(reason).toMatch(/^[A-Z0-9_:-]{3,64}$/);
  });
});

describe('an assignment status', () => {
  it('is derived: decided and revoked are stored; expired and closed come from the clock and the revision', () => {
    expect(externalReviewStatus({ state: 'ASSIGNED', expired: false, revisionInReviewAsAssigned: true })).toBe('OPEN');
    expect(externalReviewStatus({ state: 'ASSIGNED', expired: true, revisionInReviewAsAssigned: true })).toBe('EXPIRED');
    expect(externalReviewStatus({ state: 'ASSIGNED', expired: false, revisionInReviewAsAssigned: false })).toBe('CLOSED');
    expect(externalReviewStatus({ state: 'DECIDED', expired: true, revisionInReviewAsAssigned: false })).toBe('DECIDED');
    expect(externalReviewStatus({ state: 'REVOKED', expired: false, revisionInReviewAsAssigned: true })).toBe('REVOKED');
  });
});
