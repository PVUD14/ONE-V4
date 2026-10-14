/**
 * Placement statistics by department and batch (INST-12).
 *
 * The placement office reports each season: eligible, applied, placed, placement percentage and
 * offers per placed student. Every figure here is built from applications a student chose to share
 * with the college (ADR-019), already filtered by the caller for consent, relationship, scope and the
 * period, and every count leaves through the one suppression helper. Design:
 * docs/architecture/placement-register-design.md.
 *
 * Each eligible student is in exactly one stage (a partition), and the pilot's cumulative funnel
 * (Applied ⊇ Shortlisted ⊇ With an offer ⊇ Placed) is derived from it, so suppression can reason
 * about one partition instead of nested counts. A student who shared nothing is NOT_SHARED — never
 * "unplaced" and never "not applied" (INST-09): the placement percentage is taken over students who
 * shared, and the not-shared group is reported beside it.
 *
 * Offer pay is never an input (ADR-024); readiness is not involved at all (ADR-020).
 */
import {
  publishedSubtotal,
  suppressGroupedPartition,
  suppressSmallCount,
  type SuppressedAggregateTable,
  type SuppressedCount,
} from './aggregate-suppression.js';

export const placementFunnelStages = ['NOT_SHARED', 'APPLIED', 'SHORTLISTED', 'OFFERED', 'PLACED'] as const;
export type PlacementFunnelStage = typeof placementFunnelStages[number];

/** One shared application as of the period end: what had happened to it by then. */
export interface SharedApplicationFacts {
  readonly reachedShortlist: boolean;
  readonly offerExtended: boolean;
  /** An offer accepted, or the application hired. */
  readonly placed: boolean;
  /** Non-draft offers extended on this application before the period end. */
  readonly offers: number;
}

const stageRank: Readonly<Record<PlacementFunnelStage, number>> = { NOT_SHARED: 0, APPLIED: 1, SHORTLISTED: 2, OFFERED: 3, PLACED: 4 };

/** The furthest stage any of the student's shared applications reached; NOT_SHARED for none. */
export function placementFunnelStage(applications: readonly SharedApplicationFacts[]): PlacementFunnelStage {
  let stage: PlacementFunnelStage = 'NOT_SHARED';
  for (const application of applications) {
    const next: PlacementFunnelStage = application.placed ? 'PLACED'
      : application.offerExtended ? 'OFFERED'
        : application.reachedShortlist ? 'SHORTLISTED' : 'APPLIED';
    if (stageRank[next] > stageRank[stage]) stage = next;
  }
  return stage;
}

/** One eligible student: their group and their shared applications as of the period end. */
export interface PlacementStatisticsStudent<G extends string> {
  readonly group: G;
  readonly applications: readonly SharedApplicationFacts[];
}

/** The published figures for one group, or for everyone in scope. */
export interface PlacementStatisticsRow {
  readonly eligible: SuppressedCount;
  readonly notShared: SuppressedCount;
  readonly applied: SuppressedCount;
  readonly shortlisted: SuppressedCount;
  readonly withOffer: SuppressedCount;
  readonly placed: SuppressedCount;
  /** Placed ÷ students who shared, as a percentage to one decimal; null when either is withheld. */
  readonly placementPercentage: number | null;
  /** Offers extended to placed students ÷ placed students, to two decimals; null when placed is withheld. */
  readonly offersPerPlacedStudent: number | null;
  /** The partition behind the funnel, as published. */
  readonly stages: SuppressedAggregateTable<PlacementFunnelStage>;
}

const appliedStages: readonly PlacementFunnelStage[] = ['APPLIED', 'SHORTLISTED', 'OFFERED', 'PLACED'];
const shortlistedStages: readonly PlacementFunnelStage[] = ['SHORTLISTED', 'OFFERED', 'PLACED'];
const offerStages: readonly PlacementFunnelStage[] = ['OFFERED', 'PLACED'];

function row(stages: SuppressedAggregateTable<PlacementFunnelStage>, placedOffers: number): PlacementStatisticsRow {
  const cell = (key: PlacementFunnelStage): SuppressedCount => {
    if (stages.suppressed) return { suppressed: true, value: null };
    const found = stages.cells.find((entry) => entry.key === key);
    return found && !found.suppressed && found.count !== null ? { suppressed: false, value: found.count } : { suppressed: true, value: null };
  };
  const applied = publishedSubtotal(stages, appliedStages);
  const placed = cell('PLACED');
  return {
    eligible: stages.suppressed ? { suppressed: true, value: null } : stages.total,
    notShared: cell('NOT_SHARED'),
    applied,
    shortlisted: publishedSubtotal(stages, shortlistedStages),
    withOffer: publishedSubtotal(stages, offerStages),
    placed,
    placementPercentage: !applied.suppressed && !placed.suppressed && applied.value > 0
      ? Math.round((placed.value / applied.value) * 1000) / 10 : null,
    offersPerPlacedStudent: !placed.suppressed && placed.value > 0 ? Math.round((placedOffers / placed.value) * 100) / 100 : null,
    stages,
  };
}

/**
 * Statistics for every group and for everyone in scope. `groups` lists every group to report,
 * including empty ones (an empty group is a published zero only through suppression: it reads
 * withheld). Students whose group is not listed are ignored.
 */
export function placementStatistics<G extends string>(
  groups: readonly G[],
  students: readonly PlacementStatisticsStudent<G>[],
): { readonly groups: readonly { readonly key: G; readonly row: PlacementStatisticsRow }[]; readonly overall: PlacementStatisticsRow } {
  const counts = new Map<G, Map<PlacementFunnelStage, number>>(groups.map((group) => [group, new Map(placementFunnelStages.map((stage) => [stage, 0]))]));
  const placedOffers = new Map<G, number>(groups.map((group) => [group, 0]));
  for (const student of students) {
    const cells = counts.get(student.group);
    if (!cells) continue;
    const stage = placementFunnelStage(student.applications);
    cells.set(stage, (cells.get(stage) ?? 0) + 1);
    if (stage === 'PLACED') placedOffers.set(student.group, (placedOffers.get(student.group) ?? 0) + student.applications.reduce((sum, application) => sum + application.offers, 0));
  }
  const suppressed = suppressGroupedPartition(
    groups.map((group) => ({ key: group, cells: placementFunnelStages.map((stage) => ({ key: stage, count: counts.get(group)?.get(stage) ?? 0 })) })),
    placementFunnelStages,
  );
  const totalPlacedOffers = [...placedOffers.values()].reduce((sum, value) => sum + value, 0);
  return {
    groups: suppressed.groups.map(({ key, table }) => ({ key, row: row(table, placedOffers.get(key) ?? 0) })),
    overall: row(suppressed.overall, totalPlacedOffers),
  };
}

/** A monthly flow count (offers extended in one month), suppressed on its own. */
export function suppressedMonthlyCounts(months: readonly { readonly month: string; readonly count: number }[]): readonly { readonly month: string; readonly count: SuppressedCount }[] {
  return months.map((entry) => ({ month: entry.month, count: suppressSmallCount(entry.count) }));
}
