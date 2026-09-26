/**
 * The role demand dashboard's rules (OPS-11): who may read it, the promotion rule against
 * its documented thresholds, and suppression that no cell below 5 survives — directly,
 * by subtraction from a shown total, or by the order of the rows.
 */
import { describe, expect, it } from 'vitest';
import {
  canViewRoleDemand,
  evaluateRolePromotion,
  rolePromotionMinimumColleges,
  rolePromotionMinimumStudents,
  suppressDemandBreakdown,
  withholdCollegeCount,
} from './role-demand.js';
import { suppressSmallCount } from './aggregate-suppression.js';

const context = (role: string, state = 'ACTIVE', grants: readonly string[] = []) => ({ memberships: [{ role, state, grants }] });

describe('who may read role demand', () => {
  it('allows OPERATIONS_ADMIN and the super admin through their baseline', () => {
    expect(canViewRoleDemand(context('OPERATIONS_ADMIN'))).toBe(true);
    expect(canViewRoleDemand(context('PLATFORM_SUPER_ADMIN'))).toBe(true);
  });

  it('denies SECURITY_ADMIN without a grant and allows it with one', () => {
    expect(canViewRoleDemand(context('SECURITY_ADMIN'))).toBe(false);
    expect(canViewRoleDemand(context('SECURITY_ADMIN', 'ACTIVE', ['ANALYTICS_VIEW']))).toBe(true);
  });

  it('denies inactive memberships and institution roles, even with a stray grant', () => {
    for (const state of ['PENDING', 'SUSPENDED', 'ENDED']) expect(canViewRoleDemand(context('OPERATIONS_ADMIN', state)), state).toBe(false);
    expect(canViewRoleDemand(context('INSTITUTION_ADMIN', 'ACTIVE', ['ANALYTICS_VIEW']))).toBe(false);
  });
});

describe('the promotion rule', () => {
  it('is the documented rule: 200 students across 3 colleges', () => {
    expect(rolePromotionMinimumStudents).toBe(200);
    expect(rolePromotionMinimumColleges).toBe(3);
  });

  it('is met exactly at both thresholds and not one below either', () => {
    expect(evaluateRolePromotion({ releaseLabel: 'SELECTABLE', students: 200, colleges: 3 })).toEqual({ status: 'MEETS', studentArmMet: true, employerArm: 'NOT_RECORDED' });
    expect(evaluateRolePromotion({ releaseLabel: 'SELECTABLE', students: 199, colleges: 3 }).status).toBe('NOT_MET');
    expect(evaluateRolePromotion({ releaseLabel: 'SELECTABLE', students: 5000, colleges: 2 }).status).toBe('NOT_MET');
    expect(evaluateRolePromotion({ releaseLabel: 'SELECTABLE', students: 0, colleges: 0 })).toEqual({ status: 'NOT_MET', studentArmMet: false, employerArm: 'NOT_RECORDED' });
  });

  it('does not apply to a verified role or a role outside the catalogue', () => {
    expect(evaluateRolePromotion({ releaseLabel: 'VERIFIED', students: 900, colleges: 9 })).toEqual({ status: 'NOT_APPLICABLE', studentArmMet: null, employerArm: 'NOT_RECORDED' });
    expect(evaluateRolePromotion({ releaseLabel: null, students: 900, colleges: 9 }).status).toBe('NOT_APPLICABLE');
  });

  it('never claims the employer arm: no paying-employer request is recorded', () => {
    expect(evaluateRolePromotion({ releaseLabel: 'SELECTABLE', students: 10, colleges: 1 }).employerArm).toBe('NOT_RECORDED');
  });

  it('rejects impossible counts', () => {
    expect(() => evaluateRolePromotion({ releaseLabel: 'SELECTABLE', students: -1, colleges: 0 })).toThrow(RangeError);
    expect(() => evaluateRolePromotion({ releaseLabel: 'SELECTABLE', students: 1.5, colleges: 0 })).toThrow(RangeError);
  });
});

describe('suppression', () => {
  it('suppresses a role total below 5, zero included, and carries no value', () => {
    for (const count of [0, 1, 4]) expect(suppressSmallCount(count)).toEqual({ suppressed: true, value: null });
    expect(suppressSmallCount(5)).toEqual({ suppressed: false, value: 5 });
  });

  it('withholds the college count whenever the student count is suppressed', () => {
    expect(withholdCollegeCount(suppressSmallCount(4), 4)).toBeNull();
    expect(withholdCollegeCount(suppressSmallCount(6), 2)).toBe(2);
  });

  it('suppresses breakdown cells below 5 and keeps no value on them', () => {
    const cells = suppressDemandBreakdown([
      { key: 'a', label: 'A college', count: 12 },
      { key: 'b', label: 'B college', count: 9 },
      { key: 'c', label: 'C college', count: 3 },
      { key: 'd', label: 'D college', count: 4 },
    ]);
    expect(cells.map((cell) => [cell.key, cell.count.value, cell.complementary])).toEqual([
      ['a', 12, false], ['b', 9, false], ['c', null, false], ['d', null, false],
    ]);
    expect(JSON.stringify(cells)).not.toMatch(/"value":[34]\b/);
  });

  it('withholds the smallest shown cell when the suppressed cells alone could be recovered by subtraction', () => {
    // Total 7 shown elsewhere: with 5 shown, the one suppressed college would be 2.
    const cells = suppressDemandBreakdown([
      { key: 'a', label: 'A college', count: 5 },
      { key: 'b', label: 'B college', count: 2 },
    ]);
    expect(cells.every((cell) => cell.count.suppressed)).toBe(true);
    expect(cells.find((cell) => cell.key === 'a')?.complementary).toBe(true);
    expect(cells.find((cell) => cell.key === 'b')?.complementary).toBe(false);
  });

  it('withholds only the smallest shown cell, leaving at least 6 people behind the withheld cells', () => {
    const cells = suppressDemandBreakdown([
      { key: 'big', label: 'Big', count: 40 },
      { key: 'mid', label: 'Mid', count: 6 },
      { key: 'one', label: 'One', count: 1 },
      { key: 'two', label: 'Two', count: 1 },
    ]);
    expect(cells.map((cell) => [cell.key, cell.count.value, cell.complementary])).toEqual([
      ['big', 40, false], ['mid', null, true], ['one', null, false], ['two', null, false],
    ]);
  });

  it('needs no complementary cell when the suppressed cells already hold 5 or more together', () => {
    const cells = suppressDemandBreakdown([
      { key: 'a', label: 'A', count: 20 },
      { key: 'b', label: 'B', count: 3 },
      { key: 'c', label: 'C', count: 4 },
    ]);
    expect(cells.filter((cell) => cell.complementary)).toEqual([]);
    expect(cells[0]!.count.value).toBe(20);
  });

  it('orders suppressed cells by label, never by their true size', () => {
    const cells = suppressDemandBreakdown([
      { key: 'z', label: 'Zeta', count: 4 },
      { key: 'a', label: 'Alpha', count: 1 },
      { key: 'm', label: 'Mu', count: 3 },
    ]);
    expect(cells.map((cell) => cell.key)).toEqual(['a', 'm', 'z']);
  });

  it('rejects impossible counts', () => {
    expect(() => suppressDemandBreakdown([{ key: 'a', label: 'A', count: -1 }])).toThrow(RangeError);
  });
});
