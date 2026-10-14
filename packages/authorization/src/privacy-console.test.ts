/**
 * The privacy console's access rules, hold reasons and small-group suppression (OPS-06).
 *
 * PRIVACY_REQUESTS opens the console and PRIVACY_HOLDS places a hold, for the three
 * platform roles and never for an inactive membership or an institution role. Any count
 * of fewer than 5 people leaves the server only as "suppressed", with no value.
 */
import { describe, expect, it } from 'vitest';
import { hasInternalCapability } from './internal-capabilities.js';
import { aggregateSuppressionThreshold, isPrivacyHoldPlaceReason, privacyHoldPlaceReasons, suppressSmallCount } from './privacy-console.js';

const context = (role: string, state = 'ACTIVE', grants: readonly string[] = []) => ({ memberships: [{ role, state, grants }] });

describe('privacy console access', () => {
  it.each(['PRIVACY_REQUESTS', 'PRIVACY_HOLDS'] as const)('%s is granted by the baseline of each platform role', (capability) => {
    for (const role of ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN']) {
      expect(hasInternalCapability(context(role), capability), role).toBe(true);
    }
  });

  it.each(['PRIVACY_REQUESTS', 'PRIVACY_HOLDS'] as const)('%s is denied to an institution admin, even with a stray grant', (capability) => {
    expect(hasInternalCapability(context('INSTITUTION_ADMIN', 'ACTIVE', [capability]), capability)).toBe(false);
  });

  it.each(['PRIVACY_REQUESTS', 'PRIVACY_HOLDS'] as const)('%s is denied to an inactive platform membership', (capability) => {
    for (const state of ['SUSPENDED', 'ENDED', 'PENDING']) {
      expect(hasInternalCapability(context('SECURITY_ADMIN', state), capability), state).toBe(false);
    }
  });
});

describe('hold reasons', () => {
  it('are the five lawful bases the schema allows', () => {
    expect([...privacyHoldPlaceReasons]).toEqual(['LEGAL_OBLIGATION', 'SAFETY_INVESTIGATION', 'EMPLOYER_ACCOUNTABILITY_CASE', 'DISPUTE', 'REGULATORY_REQUEST']);
  });

  it('accept only listed values', () => {
    expect(isPrivacyHoldPlaceReason('DISPUTE')).toBe(true);
    expect(isPrivacyHoldPlaceReason('OPS_TEST')).toBe(false);
    expect(isPrivacyHoldPlaceReason(null)).toBe(false);
  });
});

describe('small-group suppression', () => {
  it('uses the plan threshold of 5', () => {
    expect(aggregateSuppressionThreshold).toBe(5);
  });

  it('suppresses every count below 5, zero included, and drops the value', () => {
    for (const count of [0, 1, 2, 3, 4]) expect(suppressSmallCount(count), String(count)).toEqual({ suppressed: true, value: null });
  });

  it('passes 5 and above through unchanged', () => {
    expect(suppressSmallCount(5)).toEqual({ suppressed: false, value: 5 });
    expect(suppressSmallCount(1234)).toEqual({ suppressed: false, value: 1234 });
  });

  it('refuses a value that is not a count', () => {
    expect(() => suppressSmallCount(-1)).toThrow(RangeError);
    expect(() => suppressSmallCount(2.5)).toThrow(RangeError);
    expect(() => suppressSmallCount(Number.NaN)).toThrow(RangeError);
    expect(() => suppressSmallCount(3, 0)).toThrow(RangeError);
  });
});
