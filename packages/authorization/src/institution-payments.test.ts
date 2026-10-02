/**
 * College payments received (GROWTH-10): the vocabulary pinned to migration 0111, the transition
 * rules, and money as integer paise converted without a float.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  approvalRequestReasons,
  formatPaiseAsRupees,
  highRiskActionKeys,
  highRiskActions,
  institutionPaymentBounceReasons,
  institutionPaymentClearanceReasons,
  institutionPaymentInstruments,
  institutionPaymentMaxAmountPaise,
  institutionPaymentNextTransitions,
  institutionPaymentRefundReasons,
  institutionPaymentStates,
  institutionPaymentVoidReasons,
  isCalendarDate,
  isHighRiskInternalCapability,
  isInstitutionPaymentAmount,
  isInstitutionPaymentStudentCount,
  isLegacyHighRiskActionKey,
  parseRupeesToPaise,
  refuseInstitutionPaymentTransition,
} from './index.js';

const migration = readFileSync(new URL('../../persistence/drizzle/0111_institution_payments.sql', import.meta.url), 'utf8');
const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

describe('the vocabulary matches migration 0111', () => {
  it('pins instruments, states and every reason list to the CHECKs', () => {
    expect(migration).toContain(`instrument IN (${quoted(institutionPaymentInstruments)})`);
    expect(migration).toContain(`state IN (${quoted(institutionPaymentStates)})`);
    expect(migration).toContain(`bounce_reason_code IN (${quoted(institutionPaymentBounceReasons)})`);
    expect(migration).toContain(`refund_reason_code IN (${quoted(institutionPaymentRefundReasons)})`);
    expect(migration).toContain(`void_reason_code IN (${quoted(institutionPaymentVoidReasons)})`);
    expect(migration).toContain(`amount_paise <= ${institutionPaymentMaxAmountPaise}`);
  });

  it('makes clearance an extended, high-risk OPS-02 action needing GROWTH_FINANCE', () => {
    expect(highRiskActionKeys).toContain('INSTITUTION_PAYMENT_CLEARANCE');
    expect(isLegacyHighRiskActionKey('INSTITUTION_PAYMENT_CLEARANCE')).toBe(false);
    expect(highRiskActions.INSTITUTION_PAYMENT_CLEARANCE).toMatchObject({ capability: 'GROWTH_FINANCE', targetType: 'institution_payment' });
    expect(approvalRequestReasons.INSTITUTION_PAYMENT_CLEARANCE).toEqual(institutionPaymentClearanceReasons);
    expect(isHighRiskInternalCapability('GROWTH_FINANCE')).toBe(true);
    expect(migration).toContain("WHEN 'INSTITUTION_PAYMENT_CLEARANCE' THEN 'institution_payment'");
    // 0111 repeats every earlier extended key, so it drops none of them.
    for (const key of highRiskActionKeys.filter((candidate) => !isLegacyHighRiskActionKey(candidate))) {
      expect(migration).toContain(`WHEN '${key}' THEN '${highRiskActions[key].targetType}'`);
    }
  });
});

describe('transitions', () => {
  it('allows exactly the listed steps', () => {
    expect(institutionPaymentNextTransitions('RECEIVED')).toEqual(['CLEAR', 'BOUNCE', 'VOID']);
    expect(institutionPaymentNextTransitions('CLEARED')).toEqual(['REFUND', 'VOID']);
    expect(institutionPaymentNextTransitions('BOUNCED')).toEqual(['VOID']);
    expect(institutionPaymentNextTransitions('REFUNDED')).toEqual(['VOID']);
    expect(institutionPaymentNextTransitions('VOIDED')).toEqual([]);
    expect(refuseInstitutionPaymentTransition('BOUNCED', 'CLEAR')).toBe('INSTITUTION_PAYMENT_STATE_INVALID');
    expect(refuseInstitutionPaymentTransition('RECEIVED', 'REFUND')).toBe('INSTITUTION_PAYMENT_STATE_INVALID');
    expect(refuseInstitutionPaymentTransition('CLEARED', 'BOUNCE')).toBe('INSTITUTION_PAYMENT_STATE_INVALID');
    expect(refuseInstitutionPaymentTransition('unknown', 'VOID')).toBe('INSTITUTION_PAYMENT_STATE_INVALID');
  });
});

describe('money is integer paise', () => {
  it('parses rupees typed as text without a float', () => {
    expect(parseRupeesToPaise('125000')).toBe(12_500_000);
    expect(parseRupeesToPaise('1,25,000.50')).toBe(12_500_050);
    expect(parseRupeesToPaise('₹ 99.5')).toBe(9_950);
    expect(parseRupeesToPaise('0.29')).toBe(29); // 0.29 * 100 is 28.999… as a float
    expect(parseRupeesToPaise('1000000000')).toBe(100_000_000_000);
    for (const bad of ['', '0', '0.00', '-5', '12.345', 'abc', '1e5', '1000000000.01', '12..5']) expect(parseRupeesToPaise(bad)).toBeNull();
  });

  it('formats paise with Indian grouping', () => {
    expect(formatPaiseAsRupees(12_500_050)).toBe('₹1,25,000.50');
    expect(formatPaiseAsRupees(5)).toBe('₹0.05');
    expect(formatPaiseAsRupees(100_000_000_000)).toBe('₹1,00,00,00,000.00');
    expect(formatPaiseAsRupees(1.5)).toBe('NA');
  });

  it('accepts only positive whole amounts and counts within the bounds', () => {
    expect(isInstitutionPaymentAmount(1)).toBe(true);
    for (const bad of [0, -1, 1.5, '100', null, institutionPaymentMaxAmountPaise + 1]) expect(isInstitutionPaymentAmount(bad)).toBe(false);
    expect(isInstitutionPaymentStudentCount(1)).toBe(true);
    for (const bad of [0, -2, 2.5, '3', 100_001]) expect(isInstitutionPaymentStudentCount(bad)).toBe(false);
  });

  it('accepts only real calendar dates', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', 20260101]) expect(isCalendarDate(bad)).toBe(false);
  });
});
