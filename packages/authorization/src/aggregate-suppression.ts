/**
 * The one small-cell suppression rule for every aggregate count of people that leaves the
 * server: the operations Overview and privacy console (Appendix 1 §5.5) and the institution
 * readiness report (Appendix 3 §5.3). It exists so the rule is written once — two copies
 * had already drifted into separate thresholds (OPS-SR-24), and the institution report had
 * none at cell level at all (INST-SR-01).
 *
 * Two rules live here:
 *
 *   Primary: any count under 5 — zero included, since "none" is also fewer than 5 — leaves
 *   only as "suppressed", with no value. The raw value is dropped, not hidden.
 *
 *   Complementary: when a table's cells partition a published total, a suppressed cell can
 *   be recalculated as the total minus the published cells. The total is therefore
 *   withheld whenever the suppressed cells together hold fewer than the threshold; if they
 *   hold at least the threshold, the difference reveals only a group of 5 or more.
 *
 * Plus the period rule for reports that count people over a caller-chosen window: two
 * overlapping windows can be differenced to isolate one person, so a report covers exactly
 * one whole calendar month that has already ended (see `institutionReportingMonth`).
 */

/** Appendix 1 §5.5 and Appendix 3 §5.3: any aggregate cell representing fewer than 5 people shows <5. */
export const aggregateSuppressionThreshold = 5;

export type SuppressedCount =
  | { readonly suppressed: true; readonly value: null }
  | { readonly suppressed: false; readonly value: number };

/**
 * A count of people as it may leave the server. Fewer than the threshold — zero included —
 * is reported only as suppressed, with no value.
 */
export function suppressSmallCount(count: number, threshold: number = aggregateSuppressionThreshold): SuppressedCount {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError('threshold must be a positive integer');
  return count < threshold ? { suppressed: true, value: null } : { suppressed: false, value: count };
}

export interface AggregateCell<K extends string> {
  readonly key: K;
  readonly count: number;
}

export interface SuppressedAggregateCell<K extends string> {
  readonly key: K;
  readonly count: number | null;
  readonly suppressed: boolean;
}

export interface SuppressedAggregateTable<K extends string> {
  /** True when the whole table is withheld because its total is under the threshold. */
  readonly suppressed: boolean;
  readonly total: SuppressedCount;
  /** Every input cell, in input order; empty when the whole table is withheld. */
  readonly cells: readonly SuppressedAggregateCell<K>[];
}

/**
 * Suppress a table whose cells partition its total (every person counted in exactly one
 * cell). Pass every possible cell, zero counts included: a cell left out is itself a
 * published zero.
 *
 *   total under the threshold      → everything withheld (`suppressed: true`, no cells)
 *   cell under the threshold       → that cell withheld
 *   withheld cells sum under it    → the total withheld too, so no withheld cell (or group
 *                                     of them under 5) can be recovered by subtraction
 */
export function suppressAggregateTable<K extends string>(
  cells: readonly AggregateCell<K>[],
  threshold: number = aggregateSuppressionThreshold,
): SuppressedAggregateTable<K> {
  const keys = new Set<string>();
  let total = 0;
  for (const cell of cells) {
    suppressSmallCount(cell.count, threshold); // validates count and threshold
    if (keys.has(cell.key)) throw new RangeError('cell keys must be unique');
    keys.add(cell.key);
    total += cell.count;
  }
  if (total < threshold) return { suppressed: true, total: { suppressed: true, value: null }, cells: [] };
  const suppressedCells = cells.map((cell) => ({ key: cell.key, published: suppressSmallCount(cell.count, threshold) }));
  const withheld = cells.filter((cell) => cell.count < threshold);
  const withheldSum = withheld.reduce((sum, cell) => sum + cell.count, 0);
  const totalRecoversCell = withheld.length > 0 && withheldSum < threshold;
  return {
    suppressed: false,
    total: totalRecoversCell ? { suppressed: true, value: null } : { suppressed: false, value: total },
    cells: suppressedCells.map(({ key, published }) => ({ key, count: published.value, suppressed: published.suppressed })),
  };
}

/**
 * A sum over some cells of a suppressed table (a funnel value such as "reached shortlist or
 * further"), published only when it reveals nothing the table withheld: every cell in it is
 * published, or the total and every cell outside it are (then it was derivable anyway).
 * Otherwise withheld. Under the threshold it is withheld like any count (INST-12).
 */
export function publishedSubtotal<K extends string>(table: SuppressedAggregateTable<K>, keys: readonly K[], threshold: number = aggregateSuppressionThreshold): SuppressedCount {
  if (table.suppressed) return { suppressed: true, value: null };
  const inside = table.cells.filter((cell) => keys.includes(cell.key));
  const outside = table.cells.filter((cell) => !keys.includes(cell.key));
  let value: number | null = null;
  if (inside.every((cell) => !cell.suppressed)) value = inside.reduce((sum, cell) => sum + (cell.count ?? 0), 0);
  else if (!table.total.suppressed && outside.every((cell) => !cell.suppressed)) {
    value = (table.total.value ?? 0) - outside.reduce((sum, cell) => sum + (cell.count ?? 0), 0);
  }
  return value === null ? { suppressed: true, value: null } : suppressSmallCount(value, threshold);
}

export interface AggregateGroup<G extends string, K extends string> {
  readonly key: G;
  /** Every stage, zero counts included; the cells partition the group. */
  readonly cells: readonly AggregateCell<K>[];
}

export interface SuppressedGroupedPartition<G extends string, K extends string> {
  readonly groups: readonly { readonly key: G; readonly table: SuppressedAggregateTable<K> }[];
  /** The column totals and grand total over every group. */
  readonly overall: SuppressedAggregateTable<K>;
}

/**
 * Suppress a two-way table — groups (rows) by a partition (columns) — with its row totals,
 * column totals and grand total, every one of which can be subtracted from (INST-12):
 *
 *   cells and row totals → each group through `suppressAggregateTable`
 *   column total         → withheld under the threshold, or when that column's withheld
 *                           cells across groups hold 1–4 people (subtraction would recover them)
 *   grand total          → withheld under the threshold, or when the people hidden behind
 *                           withheld row totals, or behind withheld column totals, number 1–4
 *
 * The groups must partition the population and every group must list every column key.
 * This protects each margin; it is not a full linear audit (see the placement register design).
 */
export function suppressGroupedPartition<G extends string, K extends string>(
  groups: readonly AggregateGroup<G, K>[],
  keys: readonly K[],
  threshold: number = aggregateSuppressionThreshold,
): SuppressedGroupedPartition<G, K> {
  const risky = (hidden: number) => hidden > 0 && hidden < threshold;
  const suppressedGroups = groups.map((group) => {
    const cellKeys = group.cells.map((cell) => cell.key);
    if (cellKeys.length !== keys.length || keys.some((key) => !cellKeys.includes(key))) throw new RangeError('every group must list every key');
    return { key: group.key, table: suppressAggregateTable(group.cells, threshold), raw: group.cells };
  });
  const columnValue = new Map<K, number>(keys.map((key) => [key, 0]));
  const columnHidden = new Map<K, number>(keys.map((key) => [key, 0]));
  let rowHidden = 0;
  for (const group of suppressedGroups) {
    let hiddenInRow = 0;
    for (const cell of group.raw) {
      columnValue.set(cell.key, (columnValue.get(cell.key) ?? 0) + cell.count);
      const published = group.table.cells.find((entry) => entry.key === cell.key);
      if (!published || published.suppressed) {
        columnHidden.set(cell.key, (columnHidden.get(cell.key) ?? 0) + cell.count);
        hiddenInRow += cell.count;
      }
    }
    if (group.table.total.suppressed) rowHidden += hiddenInRow;
  }
  const total = [...columnValue.values()].reduce((sum, value) => sum + value, 0);
  const cells = keys.map((key) => {
    const value = columnValue.get(key) ?? 0;
    const withheld = value < threshold || risky(columnHidden.get(key) ?? 0);
    return { key, count: withheld ? null : value, suppressed: withheld };
  });
  const hiddenBehindColumns = cells.filter((cell) => cell.suppressed).reduce((sum, cell) => sum + (columnHidden.get(cell.key) ?? 0), 0);
  const overall: SuppressedAggregateTable<K> = total < threshold
    ? { suppressed: true, total: { suppressed: true, value: null }, cells: [] }
    : {
      suppressed: false,
      total: risky(rowHidden) || risky(hiddenBehindColumns) ? { suppressed: true, value: null } : { suppressed: false, value: total },
      cells,
    };
  return { groups: suppressedGroups.map(({ key, table }) => ({ key, table })), overall };
}

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The period rule for a report that counts people over a window (INST-SR-01): exactly one
 * whole calendar month that has already ended.
 *
 * Why a month, and why ended: a caller-chosen window lets two overlapping reports be
 * differenced to isolate one student's band (1 Jan–31 Jan against 2 Jan–31 Jan), and a
 * window still in progress lets the same report be regenerated day after day and
 * differenced over time. Calendar months never overlap, and an ended month's readiness
 * snapshots are immutable, so the same month always gives the same answer. Academic terms
 * were considered and rejected: they are institution-edited (INST-05), so two versions of a
 * term are two overlapping windows again. A minimum length alone was rejected too: it does
 * not stop two long windows that differ by one day.
 *
 * Returns the normalised month, or null when the period is not one whole ended month.
 * `today` is an ISO date (YYYY-MM-DD) in UTC.
 */
export function institutionReportingMonth(periodStart: string, periodEnd: string, today: string): { readonly month: string; readonly periodStart: string; readonly periodEnd: string } | null {
  const start = parseIsoDate(periodStart);
  const end = parseIsoDate(periodEnd);
  const now = parseIsoDate(today);
  if (!start || !end || !now) return null;
  if (start.day !== 1 || start.year !== end.year || start.month !== end.month) return null;
  if (end.day !== daysInMonth(end.year, end.month)) return null;
  // Ended: the month is strictly before the month containing today.
  if (start.year > now.year || (start.year === now.year && start.month >= now.month)) return null;
  const month = `${String(start.year).padStart(4, '0')}-${String(start.month).padStart(2, '0')}`;
  return { month, periodStart, periodEnd };
}

/** The most recent month a report may cover, as YYYY-MM, given today's UTC date. */
export function latestReportingMonth(today: string): string | null {
  const now = parseIsoDate(today);
  if (!now) return null;
  const year = now.month === 1 ? now.year - 1 : now.year;
  const month = now.month === 1 ? 12 : now.month - 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

function parseIsoDate(value: string): { readonly year: number; readonly month: number; readonly day: number } | null {
  const match = isoDatePattern.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
