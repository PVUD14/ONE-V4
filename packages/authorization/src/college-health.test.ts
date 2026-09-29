/**
 * College health and account field rules (OPS-14): who may read health and manage account
 * fields, the field rules the 0078 CHECKs mirror, and that the college list's order never
 * reveals a suppressed count's true size.
 */
import { describe, expect, it } from 'vitest';
import {
  canManageCollegeAccount,
  canViewCollegeHealth,
  collegeAccountUpdateReasons,
  collegeContactAddReasons,
  collegeContactRemoveReasons,
  collegeContactRevealReasons,
  isValidContractReference,
  isValidRenewalDate,
  normaliseContactEmail,
  normaliseContactPhone,
  sortCollegesByActivity,
  sortCollegesByRenewal,
} from './college-health.js';
import { suppressSmallCount } from './aggregate-suppression.js';

const context = (role: string, state = 'ACTIVE', grants: readonly string[] = []) => ({ memberships: [{ role, state, grants }] });

describe('who may read college health and manage account fields', () => {
  it('allows OPERATIONS_ADMIN and the super admin by baseline', () => {
    for (const role of ['OPERATIONS_ADMIN', 'PLATFORM_SUPER_ADMIN']) {
      expect(canViewCollegeHealth(context(role))).toBe(true);
      expect(canManageCollegeAccount(context(role))).toBe(true);
    }
  });

  it('denies SECURITY_ADMIN without a grant and allows each capability only by its own grant', () => {
    expect(canViewCollegeHealth(context('SECURITY_ADMIN'))).toBe(false);
    expect(canManageCollegeAccount(context('SECURITY_ADMIN'))).toBe(false);
    expect(canViewCollegeHealth(context('SECURITY_ADMIN', 'ACTIVE', ['ANALYTICS_VIEW']))).toBe(true);
    expect(canManageCollegeAccount(context('SECURITY_ADMIN', 'ACTIVE', ['ANALYTICS_VIEW']))).toBe(false);
    expect(canManageCollegeAccount(context('SECURITY_ADMIN', 'ACTIVE', ['ACCOUNT_MANAGE']))).toBe(true);
    expect(canViewCollegeHealth(context('SECURITY_ADMIN', 'ACTIVE', ['ACCOUNT_MANAGE']))).toBe(false);
  });

  it('denies an inactive membership and every institution role', () => {
    for (const state of ['SUSPENDED', 'ENDED', 'PENDING']) {
      expect(canViewCollegeHealth(context('OPERATIONS_ADMIN', state))).toBe(false);
      expect(canManageCollegeAccount(context('OPERATIONS_ADMIN', state))).toBe(false);
    }
    for (const role of ['INSTITUTION_ADMIN', 'INSTITUTION_OWNER', 'PLACEMENT_ADMIN', 'STUDENT']) {
      expect(canViewCollegeHealth(context(role, 'ACTIVE', ['ANALYTICS_VIEW']))).toBe(false);
      expect(canManageCollegeAccount(context(role, 'ACTIVE', ['ACCOUNT_MANAGE']))).toBe(false);
    }
  });
});

describe('account field rules', () => {
  it('reason codes match the house pattern', () => {
    for (const code of [...collegeAccountUpdateReasons, ...collegeContactAddReasons, ...collegeContactRemoveReasons, ...collegeContactRevealReasons]) {
      expect(code).toMatch(/^[A-Z0-9_:-]{3,64}$/);
    }
  });

  it('accepts a contract reference identifier and refuses anything that could carry an amount or prose', () => {
    for (const ok of ['AI8HT-2026-014', 'MOU/2026/07', 'PO.4411', 'A']) expect(isValidContractReference(ok)).toBe(true);
    for (const bad of ['Rs 5,00,000', '₹500000', '$1200', 'two words', '-leading', '', 'x'.repeat(65)]) expect(isValidContractReference(bad)).toBe(false);
  });

  it('accepts only real calendar dates in range for renewal', () => {
    expect(isValidRenewalDate('2027-03-31')).toBe(true);
    expect(isValidRenewalDate('2028-02-29')).toBe(true);
    for (const bad of ['2027-02-29', '2027-13-01', '1999-12-31', '2101-01-01', '31/03/2027', '2027-3-1']) expect(isValidRenewalDate(bad)).toBe(false);
  });

  it('normalises contact email and phone or refuses them', () => {
    expect(normaliseContactEmail(' Principal@College.EDU ')).toBe('principal@college.edu');
    expect(normaliseContactEmail('not-an-address')).toBeNull();
    expect(normaliseContactPhone('+91 98450 12345')).toBe('+91 98450 12345');
    expect(normaliseContactPhone('call me')).toBeNull();
    expect(normaliseContactPhone('123')).toBeNull();
  });
});

describe('college ordering never reveals a suppressed count', () => {
  const college = (name: string, renewalDate: string | null, active: number) => ({ name, renewalDate, weeklyActiveLearners: suppressSmallCount(active) });

  it('sorts by renewal date soonest first with unset last, then by shown activity', () => {
    const sorted = sortCollegesByRenewal([
      college('Unset', null, 50),
      college('Late', '2027-06-30', 10),
      college('Soon busy', '2026-12-31', 40),
      college('Soon quiet', '2026-12-31', 6),
    ]);
    expect(sorted.map((c) => c.name)).toEqual(['Soon busy', 'Soon quiet', 'Late', 'Unset']);
  });

  it('orders suppressed colleges by name only, whatever their true counts', () => {
    // Same suppressed output whether the true counts are 4 and 0 or 0 and 4.
    const one = sortCollegesByActivity([college('Zeta', null, 4), college('Alpha', null, 0), college('Mid', null, 9)]);
    const two = sortCollegesByActivity([college('Zeta', null, 0), college('Alpha', null, 4), college('Mid', null, 9)]);
    expect(one.map((c) => c.name)).toEqual(['Mid', 'Alpha', 'Zeta']);
    expect(two.map((c) => c.name)).toEqual(['Mid', 'Alpha', 'Zeta']);
    const renewalOne = sortCollegesByRenewal([college('Zeta', '2027-01-01', 4), college('Alpha', '2027-01-01', 1)]);
    const renewalTwo = sortCollegesByRenewal([college('Zeta', '2027-01-01', 1), college('Alpha', '2027-01-01', 4)]);
    expect(renewalOne.map((c) => c.name)).toEqual(['Alpha', 'Zeta']);
    expect(renewalTwo.map((c) => c.name)).toEqual(['Alpha', 'Zeta']);
  });
});
