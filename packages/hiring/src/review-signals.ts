/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
export const OPPORTUNITY_DETECTOR_VERSION = 'rules-1';
export type OpportunityReviewSignal = 'APPLICANT_PAYMENT_DEMAND' | 'CROSS_EMPLOYER_DUPLICATE' | 'MISSING_COMPENSATION' | 'IMPLAUSIBLE_COMPENSATION';

/** Heuristics supply review evidence, never publication or employer decisions. */
export function detectOpportunitySignals(input: {
  readonly text: string;
  readonly crossEmployerDuplicate: boolean;
  readonly currency: string | null;
  readonly period: string | null;
  readonly min: string | null;
  readonly max: string | null;
}): readonly OpportunityReviewSignal[] {
  const signals: OpportunityReviewSignal[] = [];
  const sentences = input.text.toLowerCase().split(/[.!?\n;,]+|\bbut\b/);
  const demandsPayment = sentences.some((sentence) => {
    if (/\b(no|never|without)\b.{0,35}\b(fee|fees|payment|deposit|pay)\b|\b(do not|don't|not required to)\s+pay\b/.test(sentence)) return false;
    if (/\b(we|employer|company)\s+(will\s+)?pay\b/.test(sentence) && !/\b(applicant|applicants|candidate|candidates)\b.{0,40}\bpay\b/.test(sentence)) return false;
    return /\b(pay|deposit|transfer|remit)\b.{0,65}\b(fee|fees|deposit|registration|processing|security|training|inr|rs|usd|rupees)\b/.test(sentence)
      || /\b(application|registration|recruitment|processing|training|joining|security)\s+(fee|fees|deposit)\b.{0,40}\b(required|mandatory|payable|must|pay)\b/.test(sentence)
      || /\b(applicant|applicants|candidate|candidates)\b.{0,40}\b(must|need to|required to)\s+pay\b/.test(sentence);
  });
  if (demandsPayment) signals.push('APPLICANT_PAYMENT_DEMAND');
  if (input.crossEmployerDuplicate) signals.push('CROSS_EMPLOYER_DUPLICATE');
  if (input.min === null || !input.currency || !input.period) signals.push('MISSING_COMPENSATION');
  // Currency-independent structural anomalies; no invented market salary benchmark.
  // A zero amount or a 100x range merits a person checking the posting.
  const min = input.min === null ? null : Number(input.min);
  const max = input.max === null ? null : Number(input.max);
  if ((min !== null && (!Number.isFinite(min) || min <= 0)) ||
      (max !== null && (!Number.isFinite(max) || max <= 0 || (min !== null && (max < min || (min > 0 && max / min >= 100)))))) {
    signals.push('IMPLAUSIBLE_COMPENSATION');
  }
  return signals;
}
