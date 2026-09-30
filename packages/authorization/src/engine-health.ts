/**
 * Adaptive engine health panels (OPS-13): who may read each panel, the planner window's bounds, the
 * calibration status rule, and the small-cell suppression the planner and shadow panels apply before
 * any figure leaves the server.
 *
 * Why it exists: the panels are aggregate dashboards over students' learning activity, so Appendix 1
 * D5 applies — no individual student, and groups under five suppressed — and that rule must be a pure,
 * unit-tested function rather than something each query remembers. The one threshold and primitive
 * come from aggregate-suppression.ts; this file adds the complementary rule for a per-day series whose
 * days add up to a published total.
 * Design: docs/architecture/engine-health-panels-design.md
 */
import { aggregateSuppressionThreshold, suppressSmallCount, type SuppressedCount } from './aggregate-suppression.js';
import { hasInternalCapability, type InternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

/** Each panel is read with the capability its screen already uses (no new capability). */
export const engineHealthCapabilities = {
  AI_OPERATIONS: 'AI_OPS_VIEW',
  SYSTEM_HEALTH: 'OPS_JOBS_REPLAY',
} as const satisfies Readonly<Record<string, InternalCapability>>;
export type EngineHealthScreen = keyof typeof engineHealthCapabilities;

export function canViewEngineHealth(actor: InternalCapabilityContext, screen: EngineHealthScreen): boolean {
  return hasInternalCapability(actor, engineHealthCapabilities[screen]);
}

/** The planner window: whole UTC days ending today. The list is bounded by the largest choice. */
export const engineHealthWindowDays = [7, 14, 30] as const;
export type EngineHealthWindowDays = (typeof engineHealthWindowDays)[number];
export const engineHealthDefaultWindowDays: EngineHealthWindowDays = 14;

export function readEngineHealthWindowDays(value: unknown): EngineHealthWindowDays | null {
  if (value === undefined || value === '') return engineHealthDefaultWindowDays;
  const parsed = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : Number.NaN;
  return (engineHealthWindowDays as readonly number[]).includes(parsed) ? parsed as EngineHealthWindowDays : null;
}

/** The calibration job runs weekly (ENG-13's timer); a day's grace before it is called overdue. */
export const calibrationExpectedIntervalDays = 7;
export const calibrationOverdueAfterDays = 8;
export type CalibrationHealthStatus = 'NO_RUN' | 'CURRENT' | 'OVERDUE';

export function calibrationHealthStatus(ageDays: number | null): CalibrationHealthStatus {
  if (ageDays === null) return 'NO_RUN';
  if (!Number.isFinite(ageDays) || ageDays < 0) return 'CURRENT';
  return ageDays > calibrationOverdueAfterDays ? 'OVERDUE' : 'CURRENT';
}

// --- Planner decisions -------------------------------------------------------------------------

export interface PlannerDayCounts {
  /** The UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly decisions: number;
  /** Distinct students behind that day's decisions. */
  readonly students: number;
}

export interface PlannerWindowCounts {
  readonly decisions: number;
  readonly students: number;
  readonly overridden: number;
  /** Distinct students whose decisions were overridden. */
  readonly overriddenStudents: number;
  /** Distinct students behind the decisions on days that are themselves suppressed. */
  readonly suppressedDayStudents: number;
}

export interface PlannerHealthFigures {
  readonly days: readonly { readonly day: string; readonly decisions: SuppressedCount }[];
  readonly decisions: SuppressedCount;
  readonly overridden: SuppressedCount;
  /** Overridden ÷ all decisions, four decimals; null unless both counts are published. */
  readonly overrideRate: number | null;
  /** True when at least one decision was made in the window (a fact about the planner, not a person). */
  readonly active: boolean;
}

const withheld: SuppressedCount = { suppressed: true, value: null };
const published = (value: number): SuppressedCount => ({ suppressed: false, value });

function checkCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

/**
 * Apply the suppression rules to the planner panel's raw counts:
 *   - a day's count is published only when it came from five or more distinct students;
 *   - the window total only when it came from five or more, and the suppressed days' decisions came
 *     from none or from five or more together (else total − published days reveals a small group);
 *   - the overridden count only when it concerns five or more distinct students;
 *   - the rate only when both of its counts are published.
 */
export function summarisePlannerHealth(days: readonly PlannerDayCounts[], window: PlannerWindowCounts): PlannerHealthFigures {
  for (const day of days) {
    checkCount(day.decisions, 'decisions');
    checkCount(day.students, 'students');
    if (day.students > day.decisions) throw new RangeError('a day cannot have more students than decisions');
  }
  for (const [name, value] of Object.entries(window)) checkCount(value, name);
  if (window.overridden > window.decisions) throw new RangeError('overridden decisions cannot exceed decisions');

  const publishedDays = days.map((day) => ({
    day: day.day,
    decisions: suppressSmallCount(day.students).suppressed ? withheld : published(day.decisions),
  }));
  const complementSafe = window.suppressedDayStudents === 0 || window.suppressedDayStudents >= aggregateSuppressionThreshold;
  const decisions = !suppressSmallCount(window.students).suppressed && complementSafe
    ? published(window.decisions)
    : withheld;
  const overridden = suppressSmallCount(window.overriddenStudents).suppressed
    ? withheld
    : published(window.overridden);
  const overrideRate = !decisions.suppressed && !overridden.suppressed && decisions.value > 0
    ? Math.round((overridden.value / decisions.value) * 10_000) / 10_000
    : null;
  return { days: publishedDays, decisions, overridden, overrideRate, active: window.decisions > 0 };
}

// --- Mastery shadow ----------------------------------------------------------------------------

/** The offline report's cell (`number | "<5"`) as it may leave an operations route: the stricter rule. */
export function suppressReportCount(value: number | '<5' | undefined): SuppressedCount {
  if (value === undefined || value === '<5') return withheld;
  return suppressSmallCount(value);
}
