/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { describe, expect, it } from 'vitest';
import { summarizeHiringAnalytics } from '../src/analytics.js';

describe('employer hiring aggregates', () => {
  it('keeps all stages with zero counts and unknown time/conversions for no applications', () => {
    const report = summarizeHiringAnalytics([]);
    expect(report.stages).toHaveLength(9);
    expect(report.stages.every((stage) => stage.count === 0 && stage.reached === 0)).toBe(true);
    expect(report.conversions.every((stage) => stage.rate === null)).toBe(true);
    expect(report.meanTimeToOfferDays).toBeNull();
  });
  it('counts skipped stages only when recorded and weights first-offer times by valid samples', () => {
    const report = summarizeHiringAnalytics([
      { opportunity_id: 'op-a', title: 'Role', state: 'OFFER', reached: ['APPLIED', 'SHORTLISTED', 'OFFER'], count: 2, offer_days: 12, timed_offers: 2 },
      { opportunity_id: 'op-a', title: 'Role', state: 'REJECTED', reached: ['APPLIED', 'SCREENING', 'REJECTED'], count: 1, offer_days: null, timed_offers: 0 },
      { opportunity_id: 'op-b', title: 'Role', state: null, reached: [], count: 0, offer_days: null, timed_offers: 0 },
    ]);
    expect(report.applicationCount).toBe(3);
    expect(report.meanTimeToOfferDays).toBe(6);
    expect(report.conversions[0]).toMatchObject({ entrants: 3, progressed: 1, rate: 1 / 3 });
    expect(report.conversions.find((item) => item.from === 'INTERVIEW')?.rate).toBeNull();
    expect(report.opportunities).toHaveLength(2);
    expect(report.opportunities[1]?.applicationCount).toBe(0);
    expect(JSON.stringify(report)).not.toContain('op-a');
  });
});
