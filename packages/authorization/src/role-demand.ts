/**
 * The role demand dashboard's rules (OPS-11, Appendix 1 §5.5).
 *
 * Who may read it, the catalogue's promotion rule as code constants, and how a
 * breakdown of people (colleges within a role, departments within a college) is
 * suppressed so that no cell below 5 can be read directly or recovered by subtraction.
 * Pure functions, so the persistence layer applies them before any count leaves it and
 * the unit tests read the same rules.
 *
 * Design: docs/architecture/role-demand-dashboard-design.md
 */
import { hasInternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';
import { overviewSuppressionThreshold, suppressPeopleCount, type SuppressedPeopleCount } from './operations-overview.js';

/** Aggregate analytics (Appendix 1 §6.2): OPERATIONS_ADMIN and the super admin by baseline, anyone else by grant. */
export function canViewRoleDemand(context: InternalCapabilityContext): boolean {
  return hasInternalCapability(context, 'ANALYTICS_VIEW');
}

/**
 * The promotion rule (docs/ops/inputs/job-role-catalogue.md §H): a selectable role moves to
 * the next release's build list when at least 200 students across at least 3 colleges
 * select it, or when a paying employer asks for it as a drive target.
 */
export const rolePromotionMinimumStudents = 200;
export const rolePromotionMinimumColleges = 3;

export type RolePromotionStatus = 'MEETS' | 'NOT_MET' | 'NOT_APPLICABLE';

export interface RolePromotionEvaluation {
  readonly status: RolePromotionStatus;
  /** The student arm: 200 students across 3 colleges. Null when the rule does not apply. */
  readonly studentArmMet: boolean | null;
  /** No paying-employer request is recorded anywhere (ADR-022), so this arm can never be read. */
  readonly employerArm: 'NOT_RECORDED';
}

/**
 * Evaluates the rule on true counts. Only the outcome leaves the server: a MEETS already
 * implies counts far above the suppression threshold, and NOT_MET says nothing about how
 * far below the thresholds a role is.
 */
export function evaluateRolePromotion(input: {
  readonly releaseLabel: string | null;
  readonly students: number;
  readonly colleges: number;
}): RolePromotionEvaluation {
  if (!Number.isInteger(input.students) || input.students < 0 || !Number.isInteger(input.colleges) || input.colleges < 0) {
    throw new RangeError('counts must be non-negative integers');
  }
  // Only a selectable catalogue role can be promoted: a verified role already has its track,
  // and a role outside the catalogue has no release label to move.
  if (input.releaseLabel !== 'SELECTABLE') return { status: 'NOT_APPLICABLE', studentArmMet: null, employerArm: 'NOT_RECORDED' };
  const met = input.students >= rolePromotionMinimumStudents && input.colleges >= rolePromotionMinimumColleges;
  return { status: met ? 'MEETS' : 'NOT_MET', studentArmMet: met, employerArm: 'NOT_RECORDED' };
}

/**
 * A count of colleges beside a role's student count. When the student count is suppressed
 * the college count is withheld too: 4 colleges beside "<5 students" means exactly 4.
 */
export function withholdCollegeCount(students: SuppressedPeopleCount, colleges: number): number | null {
  return students.suppressed ? null : colleges;
}

export interface DemandBreakdownInput<K> {
  readonly key: K;
  /** Sorts suppressed cells, which must not appear in their true order. */
  readonly label: string;
  readonly count: number;
}

export interface DemandBreakdownCell<K> {
  readonly key: K;
  readonly label: string;
  readonly count: SuppressedPeopleCount;
  /** Withheld only because a smaller cell beside it would otherwise be recoverable. Not below 5. */
  readonly complementary: boolean;
}

/**
 * Suppresses one breakdown of people whose total is shown elsewhere.
 *
 * 1. Every cell below the threshold is suppressed.
 * 2. Complementary suppression: if the suppressed cells hold between 1 and threshold-1
 *    people together, subtracting the shown cells from the total would recover them, so
 *    the smallest shown cell is withheld as well. Because every shown cell is at least
 *    the threshold, one extra cell always lifts the hidden mass to at least threshold+1.
 * 3. Shown cells are ordered by count (then label); suppressed and withheld cells follow in
 *    label order, never their true order.
 */
export function suppressDemandBreakdown<K>(
  cells: readonly DemandBreakdownInput<K>[],
  threshold: number = overviewSuppressionThreshold,
): readonly DemandBreakdownCell<K>[] {
  for (const cell of cells) {
    if (!Number.isInteger(cell.count) || cell.count < 0) throw new RangeError('count must be a non-negative integer');
  }
  const small = cells.filter((cell) => cell.count < threshold);
  const shown = cells.filter((cell) => cell.count >= threshold)
    .sort((a, b) => a.count - b.count || a.label.localeCompare(b.label));
  const hiddenMass = small.reduce((sum, cell) => sum + cell.count, 0);
  const complementary = hiddenMass > 0 && hiddenMass < threshold && shown.length ? [shown[0]!] : [];
  const visible = shown.filter((cell) => !complementary.includes(cell))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const byLabel = (a: DemandBreakdownInput<K>, b: DemandBreakdownInput<K>): number => a.label.localeCompare(b.label);
  const withheld = [
    ...small.map((cell) => ({ cell, complementary: false })),
    ...complementary.map((cell) => ({ cell, complementary: true })),
  ].sort((a, b) => byLabel(a.cell, b.cell));
  return [
    ...visible.map((cell) => ({ key: cell.key, label: cell.label, count: suppressPeopleCount(cell.count, false, threshold), complementary: false })),
    ...withheld.map(({ cell, complementary: isComplementary }) => ({
      key: cell.key,
      label: cell.label,
      count: { suppressed: true, value: null, capped: false } as const,
      complementary: isComplementary,
    })),
  ];
}
