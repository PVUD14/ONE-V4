/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
export const FUNNEL_STAGES = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED'] as const;
const ALL_STAGES = [...FUNNEL_STAGES, 'REJECTED', 'WITHDRAWN'];
export interface HiringAggregateRow extends Record<string, unknown> {
  readonly opportunity_id: string;
  readonly title: string;
  readonly state: string | null;
  readonly reached: readonly string[];
  readonly count: string | number;
  readonly offer_days: string | number | null;
  readonly timed_offers: string | number;
}

/** Counts are grouped in SQL; no candidate identities enter the report model. */
export function summarizeHiringAnalytics(rows: readonly HiringAggregateRow[]) {
  const stages = ALL_STAGES.map((stage) => ({ stage, count: 0, reached: 0 }));
  const conversions = FUNNEL_STAGES.slice(0, -1).map((from, index) => ({ from, to: FUNNEL_STAGES[index + 1]!, entrants: 0, progressed: 0, rate: null as number | null }));
  const opportunities = new Map<string, { title: string; applicationCount: number; funnel: { stage: string; count: number }[] }>();
  let applicationCount = 0;
  let offerDays = 0;
  let timedOfferCount = 0;
  for (const row of rows) {
    const count = Number(row.count);
    let opportunity = opportunities.get(row.opportunity_id);
    if (!opportunity) {
      opportunity = { title: row.title, applicationCount: 0, funnel: FUNNEL_STAGES.map((stage) => ({ stage, count: 0 })) };
      opportunities.set(row.opportunity_id, opportunity);
    }
    opportunity.applicationCount += count;
    applicationCount += count;
    offerDays += Number(row.offer_days ?? 0);
    timedOfferCount += Number(row.timed_offers);
    for (const stage of stages) {
      if (row.state === stage.stage) stage.count += count;
      if (row.reached.includes(stage.stage)) stage.reached += count;
    }
    for (const stage of opportunity.funnel) if (row.reached.includes(stage.stage)) stage.count += count;
    for (const conversion of conversions) {
      if (!row.reached.includes(conversion.from)) continue;
      conversion.entrants += count;
      if (row.reached.includes(conversion.to)) conversion.progressed += count;
    }
  }
  for (const conversion of conversions) conversion.rate = conversion.entrants ? conversion.progressed / conversion.entrants : null;
  return { applicationCount, stages, conversions, meanTimeToOfferDays: timedOfferCount ? offerDays / timedOfferCount : null, timedOfferCount, opportunities: [...opportunities.values()] };
}
