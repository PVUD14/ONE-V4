/**
 * Adaptive engine health panel rules (OPS-13): each panel is read with its screen's existing
 * capability; the planner window takes only 7, 14 or 30 days; the calibration job is overdue after
 * eight days; and the small-cell rules — a day, the window total, the overridden count and the rate
 * — never let a group under five people out, including by subtraction (Appendix 1 D5).
 */
import { describe, expect, it } from 'vitest';
import {
  calibrationHealthStatus,
  canViewEngineHealth,
  readEngineHealthWindowDays,
  summarisePlannerHealth,
  suppressReportCount,
  type PlannerDayCounts,
} from './index.js';

const actor = (role: string, state = 'ACTIVE', grants: readonly string[] = []) => ({ userId: 'u-' + role, memberships: [{ role, state, grants }] });

describe('who may read the engine health panels', () => {
  it('reads the AI Operations panels with AI_OPS_VIEW and the System Health panels with OPS_JOBS_REPLAY', () => {
    for (const role of ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN']) {
      expect(canViewEngineHealth(actor(role), 'AI_OPERATIONS')).toBe(true);
      expect(canViewEngineHealth(actor(role), 'SYSTEM_HEALTH')).toBe(true);
    }
  });

  it('denies a role without the capability, even with a grant it cannot hold', () => {
    for (const screen of ['AI_OPERATIONS', 'SYSTEM_HEALTH'] as const) {
      expect(canViewEngineHealth(actor('INSTITUTION_ADMIN'), screen)).toBe(false);
      expect(canViewEngineHealth(actor('STUDENT'), screen)).toBe(false);
      expect(canViewEngineHealth(actor('INSTITUTION_ADMIN', 'ACTIVE', ['AI_OPS_VIEW', 'OPS_JOBS_REPLAY']), screen)).toBe(false);
    }
  });

  it('denies an inactive membership', () => {
    for (const state of ['SUSPENDED', 'REVOKED', 'INVITED']) {
      expect(canViewEngineHealth(actor('OPERATIONS_ADMIN', state), 'AI_OPERATIONS')).toBe(false);
      expect(canViewEngineHealth(actor('OPERATIONS_ADMIN', state), 'SYSTEM_HEALTH')).toBe(false);
    }
  });
});

describe('planner window', () => {
  it('defaults to 14 days and accepts only 7, 14 or 30', () => {
    expect(readEngineHealthWindowDays(undefined)).toBe(14);
    expect(readEngineHealthWindowDays('')).toBe(14);
    expect(readEngineHealthWindowDays('7')).toBe(7);
    expect(readEngineHealthWindowDays('30')).toBe(30);
    for (const bad of ['0', '1', '31', '365', '-7', '7.0', 'abc', 14, ['7']]) expect(readEngineHealthWindowDays(bad)).toBeNull();
  });
});

describe('calibration status', () => {
  it('is NO_RUN without a run, CURRENT up to thirty-eight days, OVERDUE after', () => {
    expect(calibrationHealthStatus(null)).toBe('NO_RUN');
    expect(calibrationHealthStatus(0)).toBe('CURRENT');
    expect(calibrationHealthStatus(38)).toBe('CURRENT');
    expect(calibrationHealthStatus(38.01)).toBe('OVERDUE');
    expect(calibrationHealthStatus(60)).toBe('OVERDUE');
  });
});

describe('planner suppression', () => {
  const day = (d: string, decisions: number, students: number): PlannerDayCounts => ({ day: d, decisions, students });

  it('publishes a day only when five or more students stand behind it, zero included', () => {
    const figures = summarisePlannerHealth(
      [day('2026-09-29', 0, 0), day('2026-09-30', 9, 4), day('2026-10-01', 12, 5)],
      { decisions: 21, students: 9, overridden: 0, overriddenStudents: 0, suppressedDayStudents: 4 },
    );
    expect(figures.days).toEqual([
      { day: '2026-09-29', decisions: { suppressed: true, value: null } },
      { day: '2026-09-30', decisions: { suppressed: true, value: null } },
      { day: '2026-10-01', decisions: { suppressed: false, value: 12 } },
    ]);
    expect(figures.active).toBe(true);
  });

  it('withholds the total when the suppressed days could be recovered by subtraction', () => {
    const small = summarisePlannerHealth([day('2026-09-30', 3, 2), day('2026-10-01', 20, 6)],
      { decisions: 23, students: 7, overridden: 0, overriddenStudents: 0, suppressedDayStudents: 2 });
    expect(small.decisions).toEqual({ suppressed: true, value: null });
    // Five or more students behind the suppressed days together: the difference is itself a safe group.
    const safe = summarisePlannerHealth([day('2026-09-29', 4, 3), day('2026-09-30', 3, 2), day('2026-10-01', 20, 6)],
      { decisions: 27, students: 9, overridden: 0, overriddenStudents: 0, suppressedDayStudents: 5 });
    expect(safe.decisions).toEqual({ suppressed: false, value: 27 });
    // No decisions on the suppressed days: nothing to recover.
    const empty = summarisePlannerHealth([day('2026-09-30', 0, 0), day('2026-10-01', 20, 6)],
      { decisions: 20, students: 6, overridden: 0, overriddenStudents: 0, suppressedDayStudents: 0 });
    expect(empty.decisions).toEqual({ suppressed: false, value: 20 });
  });

  it('withholds the total under five students however many decisions they made', () => {
    const figures = summarisePlannerHealth([day('2026-10-01', 40, 4)], { decisions: 40, students: 4, overridden: 0, overriddenStudents: 0, suppressedDayStudents: 4 });
    expect(figures.decisions).toEqual({ suppressed: true, value: null });
    expect(figures.overrideRate).toBeNull();
  });

  it('publishes overrides and the rate only over five or more overridden students', () => {
    const days = [day('2026-10-01', 50, 10)];
    const few = summarisePlannerHealth(days, { decisions: 50, students: 10, overridden: 6, overriddenStudents: 4, suppressedDayStudents: 0 });
    expect(few.decisions).toEqual({ suppressed: false, value: 50 });
    expect(few.overridden).toEqual({ suppressed: true, value: null });
    expect(few.overrideRate).toBeNull();
    const enough = summarisePlannerHealth(days, { decisions: 50, students: 10, overridden: 7, overriddenStudents: 5, suppressedDayStudents: 0 });
    expect(enough.overridden).toEqual({ suppressed: false, value: 7 });
    expect(enough.overrideRate).toBe(0.14);
  });

  it('reports an idle planner honestly, with every figure withheld', () => {
    const figures = summarisePlannerHealth([day('2026-10-01', 0, 0)], { decisions: 0, students: 0, overridden: 0, overriddenStudents: 0, suppressedDayStudents: 0 });
    expect(figures).toEqual({
      days: [{ day: '2026-10-01', decisions: { suppressed: true, value: null } }],
      decisions: { suppressed: true, value: null }, overridden: { suppressed: true, value: null }, overrideRate: null, active: false,
    });
  });

  it('rejects impossible input rather than publishing it', () => {
    expect(() => summarisePlannerHealth([day('2026-10-01', 2, 3)], { decisions: 2, students: 3, overridden: 0, overriddenStudents: 0, suppressedDayStudents: 0 })).toThrow(RangeError);
    expect(() => summarisePlannerHealth([], { decisions: 2, students: 1, overridden: 3, overriddenStudents: 1, suppressedDayStudents: 0 })).toThrow(RangeError);
    expect(() => summarisePlannerHealth([], { decisions: -1, students: 0, overridden: 0, overriddenStudents: 0, suppressedDayStudents: 0 })).toThrow(RangeError);
  });
});

describe('shadow report cells on an operations route', () => {
  it('turns the report\'s "<5", a missing cell and any count under five into suppressed', () => {
    expect(suppressReportCount('<5')).toEqual({ suppressed: true, value: null });
    expect(suppressReportCount(undefined)).toEqual({ suppressed: true, value: null });
    expect(suppressReportCount(0)).toEqual({ suppressed: true, value: null });
    expect(suppressReportCount(5)).toEqual({ suppressed: false, value: 5 });
  });
});
