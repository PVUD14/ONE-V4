/**
 * Unit tests for the OPS-15 access review rules: who may review, no attesting your own
 * access except the marked solo case, the last super admin, and the review schedule.
 */
import { describe, expect, it } from 'vitest';
import {
  accessReviewHighRisk,
  accessReviewSchedule,
  decideAccessReviewItem,
  isAccessReviewer,
  refuseAccessReviewRoleRevocation,
  type AccessReviewDecisionInput,
} from './access-reviews.js';

const security = (userId = 'reviewer', state = 'ACTIVE') => ({ userId, memberships: [{ role: 'SECURITY_ADMIN', state }] });
const opened = '2026-10-01T10:00:00.000Z';

function input(overrides: Partial<AccessReviewDecisionInput> = {}): AccessReviewDecisionInput {
  return {
    actor: security(),
    reviewerCount: 2,
    campaign: { state: 'OPEN', openedAt: opened },
    item: { subjectUserId: 'someone-else', decided: false },
    decision: 'KEEP',
    now: '2026-10-01T10:01:00.000Z',
    ...overrides,
  };
}

describe('who may review', () => {
  it('holds for the security admin and the super admin by baseline', () => {
    expect(isAccessReviewer(security())).toBe(true);
    expect(isAccessReviewer({ memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE' }] })).toBe(true);
  });
  it('holds for an operations admin only with a grant', () => {
    expect(isAccessReviewer({ memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] })).toBe(false);
    expect(isAccessReviewer({ memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE', grants: ['SECURITY_ACCESS_REVIEW'] }] })).toBe(true);
  });
  it('is denied for an inactive membership and for institution roles', () => {
    expect(isAccessReviewer(security('x', 'SUSPENDED'))).toBe(false);
    expect(isAccessReviewer({ memberships: [{ role: 'INSTITUTION_ADMIN', state: 'ACTIVE', grants: ['SECURITY_ACCESS_REVIEW'] }] })).toBe(false);
  });
});

describe('deciding an item', () => {
  it('allows a reviewer to decide someone else’s access, in dual mode', () => {
    expect(decideAccessReviewItem(input())).toEqual({ allowed: true, mode: 'DUAL' });
    expect(decideAccessReviewItem(input({ decision: 'REVOKE' }))).toEqual({ allowed: true, mode: 'DUAL' });
  });
  it('refuses a non-reviewer, a closed campaign and a decided item', () => {
    expect(decideAccessReviewItem(input({ actor: { userId: 'ops', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] } }))).toMatchObject({ refusal: 'FORBIDDEN' });
    expect(decideAccessReviewItem(input({ campaign: { state: 'CLOSED', openedAt: opened } }))).toMatchObject({ refusal: 'ACCESS_REVIEW_NOT_OPEN' });
    expect(decideAccessReviewItem(input({ item: { subjectUserId: 'someone-else', decided: true } }))).toMatchObject({ refusal: 'ACCESS_REVIEW_ALREADY_DECIDED' });
  });
  it('never lets a reviewer attest their own access while another reviewer exists', () => {
    const own = { subjectUserId: 'reviewer', decided: false };
    expect(decideAccessReviewItem(input({ item: own, now: '2026-10-02T00:00:00.000Z' }))).toMatchObject({ refusal: 'ACCESS_REVIEW_OWN_ACCESS' });
  });
  it('lets the only reviewer KEEP their own access after 15 minutes, marked SOLO', () => {
    const own = { subjectUserId: 'reviewer', decided: false };
    expect(decideAccessReviewItem(input({ item: own, reviewerCount: 1, now: '2026-10-01T10:14:59.000Z' })))
      .toEqual({ allowed: false, refusal: 'ACCESS_REVIEW_SOLO_COOLING_OFF', coolingOffEndsAt: '2026-10-01T10:15:00.000Z' });
    expect(decideAccessReviewItem(input({ item: own, reviewerCount: 1, now: '2026-10-01T10:15:00.000Z' }))).toEqual({ allowed: true, mode: 'SOLO' });
  });
  it('never lets even the only reviewer revoke their own access', () => {
    const own = { subjectUserId: 'reviewer', decided: false };
    expect(decideAccessReviewItem(input({ item: own, reviewerCount: 1, decision: 'REVOKE', now: '2026-10-02T00:00:00.000Z' }))).toMatchObject({ refusal: 'ACCESS_REVIEW_OWN_ACCESS' });
  });
});

describe('suspending a platform role', () => {
  it('protects the last active super admin', () => {
    expect(refuseAccessReviewRoleRevocation({ targetRole: 'PLATFORM_SUPER_ADMIN', targetState: 'ACTIVE', activeSuperAdmins: 1 })).toBe('ACCESS_REVIEW_LAST_SUPER_ADMIN');
    expect(refuseAccessReviewRoleRevocation({ targetRole: 'PLATFORM_SUPER_ADMIN', targetState: 'ACTIVE', activeSuperAdmins: 2 })).toBeNull();
    expect(refuseAccessReviewRoleRevocation({ targetRole: 'SECURITY_ADMIN', targetState: 'ACTIVE', activeSuperAdmins: 1 })).toBeNull();
  });
});

describe('high risk', () => {
  it('marks a set holding any §5.4 capability', () => {
    expect(accessReviewHighRisk(['SUPPORT_CASES'])).toBe(false);
    expect(accessReviewHighRisk(['SUPPORT_CASES', 'CAPABILITY_ADMIN'])).toBe(true);
  });
});

describe('schedule', () => {
  it('is overdue when no review has ever closed', () => {
    expect(accessReviewSchedule({ now: '2026-10-01T00:00:00Z', lastClosedAt: null, open: null })).toEqual({ status: 'NEVER_REVIEWED', overdue: true, nextDueAt: null });
  });
  it('is current for three calendar months after a close, then overdue', () => {
    const lastClosedAt = '2026-08-31T12:00:00.000Z';
    expect(accessReviewSchedule({ now: '2026-11-29T00:00:00Z', lastClosedAt, open: null })).toEqual({ status: 'CURRENT', overdue: false, nextDueAt: '2026-11-30T12:00:00.000Z' });
    expect(accessReviewSchedule({ now: '2026-12-01T00:00:00Z', lastClosedAt, open: null })).toMatchObject({ status: 'REVIEW_OVERDUE', overdue: true });
  });
  it('reports an open campaign in progress, and overdue past its own window', () => {
    const lastClosedAt = '2026-07-01T00:00:00.000Z';
    expect(accessReviewSchedule({ now: '2026-09-15T00:00:00Z', lastClosedAt, open: { dueAt: '2026-10-10T00:00:00Z' } })).toMatchObject({ status: 'IN_PROGRESS', overdue: false });
    expect(accessReviewSchedule({ now: '2026-10-15T00:00:00Z', lastClosedAt, open: { dueAt: '2026-10-10T00:00:00Z' } })).toMatchObject({ status: 'CAMPAIGN_OVERDUE', overdue: true });
    expect(accessReviewSchedule({ now: '2026-10-05T00:00:00Z', lastClosedAt: null, open: { dueAt: '2026-10-10T00:00:00Z' } })).toMatchObject({ status: 'IN_PROGRESS', overdue: true });
  });
});
