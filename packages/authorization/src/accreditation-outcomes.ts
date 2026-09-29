/**
 * Graduate outcomes for accreditation exports (INST-13).
 *
 * Colleges report what their graduates did next — placed, higher studies, entrepreneurship — for
 * NAAC, NBA and NIRF submissions. This is the pure half: which one stage each graduate falls in, and
 * the suppressed department × programme × year table with its margins. The caller supplies facts it
 * has already filtered for scope, relationship, consent and the period. Design:
 * docs/architecture/accreditation-outcome-exports-design.md.
 *
 * Each graduate is counted once, placed first. "Placed" is INST-12's rule applied by the same code,
 * so the column reconciles with the placement statistics; higher studies and entrepreneurship are
 * the graduate's own shared self-report (0083). NONE_SHARED is everyone else — never "unplaced".
 * No pay (ADR-024) and no readiness (ADR-020) is an input.
 */
import { suppressGroupedPartition, type SuppressedAggregateTable, type SuppressedCount } from './aggregate-suppression.js';

export const selfReportedOutcomes = ['HIGHER_STUDIES', 'ENTREPRENEURSHIP'] as const;
export type SelfReportedOutcome = typeof selfReportedOutcomes[number];

export const accreditationOutcomeStages = ['PLACED', 'HIGHER_STUDIES', 'ENTREPRENEURSHIP', 'NONE_SHARED'] as const;
export type AccreditationOutcomeStage = typeof accreditationOutcomeStages[number];

export function isSelfReportedOutcome(value: unknown): value is SelfReportedOutcome {
  return typeof value === 'string' && (selfReportedOutcomes as readonly string[]).includes(value);
}

/** The one stage a graduate is counted in: placed first, then their self-report, else none shared. */
export function accreditationOutcomeStage(placed: boolean, declared: SelfReportedOutcome | null): AccreditationOutcomeStage {
  if (placed) return 'PLACED';
  return declared ?? 'NONE_SHARED';
}

export interface AccreditationGraduate<G extends string> {
  readonly group: G;
  /** INST-12's placed, as of the period end. */
  readonly placed: boolean;
  /** The graduate's live self-report shared with this college before the period end, if any. */
  readonly declared: SelfReportedOutcome | null;
}

/** The published figures for one group, or for every graduate in scope. */
export interface AccreditationOutcomeRow {
  readonly graduated: SuppressedCount;
  readonly placed: SuppressedCount;
  readonly higherStudies: SuppressedCount;
  readonly entrepreneurship: SuppressedCount;
  readonly noneShared: SuppressedCount;
}

const withheld: SuppressedCount = { suppressed: true, value: null };

function row(table: SuppressedAggregateTable<AccreditationOutcomeStage>): AccreditationOutcomeRow {
  const cell = (key: AccreditationOutcomeStage): SuppressedCount => {
    if (table.suppressed) return withheld;
    const found = table.cells.find((entry) => entry.key === key);
    return found && !found.suppressed && found.count !== null ? { suppressed: false, value: found.count } : withheld;
  };
  return {
    graduated: table.suppressed ? withheld : table.total,
    placed: cell('PLACED'),
    higherStudies: cell('HIGHER_STUDIES'),
    entrepreneurship: cell('ENTREPRENEURSHIP'),
    noneShared: cell('NONE_SHARED'),
  };
}

/**
 * The suppressed table: one row per listed group (empty groups included, which read withheld) and
 * the overall row. Graduates whose group is not listed are ignored.
 */
export function accreditationOutcomes<G extends string>(
  groups: readonly G[],
  graduates: readonly AccreditationGraduate<G>[],
): { readonly groups: readonly { readonly key: G; readonly row: AccreditationOutcomeRow }[]; readonly overall: AccreditationOutcomeRow } {
  const counts = new Map<G, Map<AccreditationOutcomeStage, number>>(
    groups.map((group) => [group, new Map(accreditationOutcomeStages.map((stage) => [stage, 0]))]),
  );
  for (const graduate of graduates) {
    const cells = counts.get(graduate.group);
    if (!cells) continue;
    const stage = accreditationOutcomeStage(graduate.placed, graduate.declared);
    cells.set(stage, (cells.get(stage) ?? 0) + 1);
  }
  const suppressed = suppressGroupedPartition(
    groups.map((group) => ({ key: group, cells: accreditationOutcomeStages.map((stage) => ({ key: stage, count: counts.get(group)?.get(stage) ?? 0 })) })),
    accreditationOutcomeStages,
  );
  return {
    groups: suppressed.groups.map(({ key, table }) => ({ key, row: row(table) })),
    overall: row(suppressed.overall),
  };
}
