/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { describe, expect, it } from 'vitest';
import { detectOpportunitySignals } from '../src/review-signals.js';

const valid = { text: 'Build software with our team.', crossEmployerDuplicate: false, currency: 'INR', period: 'MONTH', min: '25000', max: '50000' };
describe('advisory opportunity signals', () => {
  it.each(['Candidates must pay before interview.', 'Pay INR 500 as a registration fee.', 'A security deposit is mandatory.'])('flags applicant payment demands: %s', (text) => {
    expect(detectOpportunitySignals({ ...valid, text })).toContain('APPLICANT_PAYMENT_DEMAND');
  });
  it.each(['We never ask for payment.', 'No application fee is required.', 'Applicants are not required to pay.', 'We pay a training stipend.'])('does not flag a fee disclaimer or employer pay: %s', (text) => {
    expect(detectOpportunitySignals({ ...valid, text })).not.toContain('APPLICANT_PAYMENT_DEMAND');
  });
  it('retains distinct signals together without producing rejection or penalties', () => {
    expect(detectOpportunitySignals({ text: 'Applicants must pay a fee.', crossEmployerDuplicate: true, currency: null, period: null, min: '0', max: null })).toEqual([
      'APPLICANT_PAYMENT_DEMAND', 'CROSS_EMPLOYER_DUPLICATE', 'MISSING_COMPENSATION', 'IMPLAUSIBLE_COMPENSATION',
    ]);
  });
  it('flags missing pay and implausible ranges without currency conversion assumptions', () => {
    expect(detectOpportunitySignals({ ...valid, min: null })).toEqual(['MISSING_COMPENSATION']);
    expect(detectOpportunitySignals({ ...valid, min: '1', max: '1000000000' })).toEqual(['IMPLAUSIBLE_COMPENSATION']);
    expect(detectOpportunitySignals(valid)).toEqual([]);
  });
});
