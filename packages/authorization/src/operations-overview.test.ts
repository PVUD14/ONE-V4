/**
 * The Operations Overview's access table (OPS-03): who opens it, which sections each
 * platform role receives, that grants add sections, that inactive memberships and
 * institution roles get nothing, and that counts of people below 5 never leave the server.
 */
import { describe, expect, it } from 'vitest';
import {
  canViewOperationsOverview,
  operationsOverviewSections,
  operationsOverviewSectionsFor,
  suppressPeopleCount,
} from './operations-overview.js';

const context = (role: string, state = 'ACTIVE', grants: readonly string[] = []) => ({ memberships: [{ role, state, grants }] });

describe('opening the Overview', () => {
  it('is allowed for each ACTIVE platform role through its baseline', () => {
    for (const role of ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN']) {
      expect(canViewOperationsOverview(context(role)), role).toBe(true);
    }
  });

  it('is denied to an inactive platform membership', () => {
    for (const state of ['PENDING', 'SUSPENDED', 'ENDED']) {
      expect(canViewOperationsOverview(context('PLATFORM_SUPER_ADMIN', state)), state).toBe(false);
      expect(operationsOverviewSectionsFor(context('OPERATIONS_ADMIN', state)), state).toEqual([]);
    }
  });

  it('is denied to institution roles, even with stray grants, and to a faculty content reviewer', () => {
    expect(canViewOperationsOverview(context('INSTITUTION_ADMIN', 'ACTIVE', ['OPS_ORG_MANAGE', 'SUPPORT_CASES']))).toBe(false);
    expect(canViewOperationsOverview(context('FACULTY_LECTURER', 'ACTIVE', ['CONTENT_REVIEW_EXTERNAL']))).toBe(false);
    expect(operationsOverviewSectionsFor(context('FACULTY_LECTURER', 'ACTIVE', ['CONTENT_REVIEW_EXTERNAL']))).toEqual([]);
  });
});

describe('sections per role', () => {
  it('gives the super admin every section', () => {
    expect(operationsOverviewSectionsFor(context('PLATFORM_SUPER_ADMIN'))).toEqual([...operationsOverviewSections]);
  });

  it('gives the operations admin everything except the approvals queue', () => {
    expect(operationsOverviewSectionsFor(context('OPERATIONS_ADMIN'))).toEqual(
      operationsOverviewSections.filter((section) => section !== 'approvals'),
    );
  });

  it('gives the security admin trust, jobs and privacy only', () => {
    expect(operationsOverviewSectionsFor(context('SECURITY_ADMIN'))).toEqual(['trustSafety', 'jobs', 'privacyRequests', 'privacyHolds']);
  });

  it('adds a section when the capability is granted, and only on a platform membership', () => {
    expect(operationsOverviewSectionsFor(context('SECURITY_ADMIN', 'ACTIVE', ['SUPPORT_CASES']))).toContain('support');
    expect(operationsOverviewSectionsFor(context('SECURITY_ADMIN', 'ACTIVE', ['APPROVE_HIGH_RISK']))).toContain('approvals');
    expect(operationsOverviewSectionsFor(context('SECURITY_ADMIN', 'ACTIVE', ['SUPPORT_CASES', 'OPS_ORG_MANAGE']))).toEqual(
      ['organizations', 'employerAccessRequests', 'invitations', 'trustSafety', 'jobs', 'privacyRequests', 'privacyHolds', 'support'],
    );
  });
});

describe('suppressing counts of people (§5.5)', () => {
  it('drops the value below 5, zero included', () => {
    for (const count of [0, 1, 4]) expect(suppressPeopleCount(count)).toEqual({ suppressed: true, value: null, capped: false });
  });

  it('keeps the value at 5 and above, and carries the cap flag', () => {
    expect(suppressPeopleCount(5)).toEqual({ suppressed: false, value: 5, capped: false });
    expect(suppressPeopleCount(10_000, true)).toEqual({ suppressed: false, value: 10_000, capped: true });
  });

  it('refuses a count or threshold that is not a whole number', () => {
    expect(() => suppressPeopleCount(-1)).toThrow(RangeError);
    expect(() => suppressPeopleCount(2.5)).toThrow(RangeError);
    expect(() => suppressPeopleCount(3, false, 0)).toThrow(RangeError);
  });
});
