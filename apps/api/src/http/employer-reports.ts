/**
 * The employer report model (EMP-15): how counts the database groups become the figures an
 * employer's Reports screen may show. Pure, so the suppression decisions are unit-tested in one
 * place; the controller only runs the SQL and hands the grouped counts here.
 *
 * Every figure about people in a report goes through the one suppression helper
 * (packages/authorization/src/aggregate-suppression.ts): a group under 5 — zero included — leaves
 * only as "suppressed", and a table's total is withheld when its withheld cells could be
 * recovered from it. No report row is ever one application, and nothing here reads readiness,
 * ONE's own student records or any protected attribute.
 *
 * One partition per group. Each application is counted in exactly one cell: where it is now
 * while open (APPLIED … OFFER), HIRED, or LEFT_AT_<stage> — the stage it was at when it was
 * rejected or withdrew. That one table gives both the funnel and the stage drop-off, and keeps
 * them consistent: publishing the funnel and the drop-off as two tables over the same people
 * would let one be subtracted from the other.
 */
import {
  aggregateSuppressionThreshold,
  suppressAggregateTable,
  suppressSmallCount,
  type SuppressedAggregateTable,
  type SuppressedCount,
} from '@planthepath/authorization/src/index.js';

export const reportOpenStages = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER'] as const;
export const reportCells = [
  ...reportOpenStages,
  'HIRED',
  'LEFT_AT_APPLIED', 'LEFT_AT_SCREENING', 'LEFT_AT_SHORTLISTED', 'LEFT_AT_ASSESSMENT', 'LEFT_AT_INTERVIEW', 'LEFT_AT_OFFER',
] as const;
export type ReportCell = typeof reportCells[number];

const cellSet = new Set<string>(reportCells);
const openStageSet = new Set<string>(reportOpenStages);

/**
 * Where one application sits in the partition. Mirrors the SQL CASE in the controller, and is
 * what the unit tests pin: a closed application with no usable "from" stage is counted as
 * leaving at APPLIED rather than dropped, so the table still sums to every application.
 */
export function reportCellFor(state: string, leftFrom: string | null): ReportCell {
  if (openStageSet.has(state) || state === 'HIRED') return state as ReportCell;
  const from = leftFrom && openStageSet.has(leftFrom) ? leftFrom : 'APPLIED';
  return `LEFT_AT_${from}` as ReportCell;
}

export interface GroupedCellCount extends Record<string, unknown> {
  readonly cell: string;
  readonly count: number | string;
}

/** One group's partition, every cell present (a missing cell is a zero), suppressed. */
export function stageTable(rows: readonly GroupedCellCount[]): SuppressedAggregateTable<ReportCell> {
  const counts = new Map<ReportCell, number>(reportCells.map((cell) => [cell, 0]));
  for (const row of rows) {
    if (!cellSet.has(row.cell)) throw new RangeError('unknown report cell');
    counts.set(row.cell as ReportCell, (counts.get(row.cell as ReportCell) ?? 0) + Number(row.count));
  }
  return suppressAggregateTable(reportCells.map((key) => ({ key, count: counts.get(key) ?? 0 })));
}

export interface CollegeCellCount extends GroupedCellCount {
  /** Lower-cased, trimmed college name as the student shared it in their application; null when not stated. */
  readonly collegeKey: string | null;
  readonly collegeName: string | null;
}

export interface CollegeGroup {
  /** The college as students named it, or null for "other colleges or not stated". */
  readonly collegeName: string | null;
  readonly table: SuppressedAggregateTable<ReportCell>;
}

/**
 * Funnel by college. A college is named only when at least 5 applications name it, so a row can
 * never say "someone from College X applied". Everything else — smaller colleges and
 * applications that do not state one — is one "other" row. If that row would hold 1–4, the
 * smallest named college joins it, so it is either empty (and left out) or 5 and more. Named
 * rows are ordered by name, never by size, so their order says nothing about withheld totals.
 */
export function collegeGroups(rows: readonly CollegeCellCount[]): readonly CollegeGroup[] {
  const byKey = new Map<string, { name: string; rows: CollegeCellCount[]; total: number }>();
  const other: CollegeCellCount[] = [];
  for (const row of rows) {
    if (row.collegeKey === null || row.collegeName === null) { other.push(row); continue; }
    const entry = byKey.get(row.collegeKey) ?? { name: row.collegeName, rows: [], total: 0 };
    entry.rows.push(row);
    entry.total += Number(row.count);
    byKey.set(row.collegeKey, entry);
  }
  const named = [...byKey.values()].filter((entry) => entry.total >= aggregateSuppressionThreshold);
  for (const entry of byKey.values()) if (entry.total < aggregateSuppressionThreshold) other.push(...entry.rows);
  let otherTotal = other.reduce((sum, row) => sum + Number(row.count), 0);
  if (otherTotal > 0 && otherTotal < aggregateSuppressionThreshold && named.length) {
    const smallest = [...named].sort((a, b) => a.total - b.total || a.name.localeCompare(b.name))[0]!;
    named.splice(named.indexOf(smallest), 1);
    other.push(...smallest.rows);
    otherTotal += smallest.total;
  }
  const groups: CollegeGroup[] = named
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ collegeName: entry.name, table: stageTable(entry.rows) }));
  if (otherTotal > 0) groups.push({ collegeName: null, table: stageTable(other) });
  return groups;
}

export const offerOutcomeCells = ['EXTENDED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'] as const;
export type OfferOutcomeCell = typeof offerOutcomeCells[number];

export interface OfferOutcomes {
  readonly table: SuppressedAggregateTable<OfferOutcomeCell>;
  /**
   * Accepted ÷ (accepted + declined + expired), only when both the accepted group and the
   * not-accepted group hold at least 5; otherwise null. A rate over smaller groups is a count
   * of fewer than 5 people in disguise.
   */
  readonly acceptanceRate: number | null;
}

/** One row per application that has a non-draft offer: the state of its latest offer. */
export function offerOutcomes(rows: readonly GroupedCellCount[]): OfferOutcomes {
  const counts = new Map<OfferOutcomeCell, number>(offerOutcomeCells.map((cell) => [cell, 0]));
  for (const row of rows) {
    if (!counts.has(row.cell as OfferOutcomeCell)) throw new RangeError('unknown offer outcome');
    counts.set(row.cell as OfferOutcomeCell, (counts.get(row.cell as OfferOutcomeCell) ?? 0) + Number(row.count));
  }
  const accepted = counts.get('ACCEPTED') ?? 0;
  const notAccepted = (counts.get('DECLINED') ?? 0) + (counts.get('EXPIRED') ?? 0);
  const rate = accepted >= aggregateSuppressionThreshold && notAccepted >= aggregateSuppressionThreshold
    ? Math.round((accepted / (accepted + notAccepted)) * 1000) / 1000
    : null;
  return { table: suppressAggregateTable(offerOutcomeCells.map((key) => ({ key, count: counts.get(key) ?? 0 }))), acceptanceRate: rate };
}

export const durationMetrics = ['SHORTLIST', 'INTERVIEW', 'OFFER', 'HIRE'] as const;
export type DurationMetric = typeof durationMetrics[number];

export interface DurationFigure {
  readonly metric: DurationMetric;
  /** How many applications the median is over, suppressed under 5. */
  readonly applications: SuppressedCount;
  /** Median days from submission, one decimal; null whenever the count is suppressed. */
  readonly medianDays: number | null;
}

export function durationFigure(metric: DurationMetric, count: number | string, medianDays: number | string | null): DurationFigure {
  const applications = suppressSmallCount(Number(count));
  const median = applications.suppressed || medianDays === null ? null : Math.round(Number(medianDays) * 10) / 10;
  return { metric, applications, medianDays: median };
}
