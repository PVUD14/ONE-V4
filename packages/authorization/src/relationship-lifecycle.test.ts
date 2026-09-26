/**
 * Former-student standing and the relationship-change notice (INST-10): who keeps the student
 * workspace after leaving college, and what the student is told.
 */
import { describe, expect, it } from 'vitest';
import {
  formerStudentRelationshipStates,
  relationshipBatchStates,
  relationshipChangeNotice,
  relationshipReasonCodePattern,
  studentStanding,
} from './index.js';

const now = new Date('2026-09-26T10:00:00Z');
const start = new Date('2022-07-01T00:00:00Z');

describe('studentStanding', () => {
  it('is CURRENT with an open active or verified relationship', () => {
    expect(studentStanding([{ state: 'ACTIVE', effectiveFrom: start }], now)).toBe('CURRENT');
    expect(studentStanding([{ state: 'VERIFIED', effectiveFrom: start, effectiveTo: new Date('2027-01-01T00:00:00Z') }], now)).toBe('CURRENT');
  });

  it('is FORMER after graduating, transferring or ending, including a graduation dated ahead', () => {
    for (const state of ['GRADUATED', 'TRANSFERRED', 'ENDED']) {
      expect(studentStanding([{ state, effectiveFrom: start, effectiveTo: new Date('2026-06-01T00:00:00Z') }], now)).toBe('FORMER');
    }
    expect(studentStanding([{ state: 'GRADUATED', effectiveFrom: start, effectiveTo: new Date('2026-12-01T00:00:00Z') }], now)).toBe('FORMER');
  });

  it('prefers a current relationship at another college over a former one', () => {
    expect(studentStanding([
      { state: 'TRANSFERRED', effectiveFrom: start, effectiveTo: new Date('2025-06-01T00:00:00Z') },
      { state: 'ACTIVE', effectiveFrom: new Date('2025-06-01T00:00:00Z') },
    ], now)).toBe('CURRENT');
  });

  it('is NONE for a revoked, pending, not-yet-started or absent relationship', () => {
    expect(studentStanding([{ state: 'REVOKED', effectiveFrom: start, effectiveTo: new Date('2026-01-01T00:00:00Z') }], now)).toBe('NONE');
    expect(studentStanding([{ state: 'PENDING', effectiveFrom: start }], now)).toBe('NONE');
    expect(studentStanding([{ state: 'ACTIVE', effectiveFrom: new Date('2027-01-01T00:00:00Z') }], now)).toBe('NONE');
    expect(studentStanding([], now)).toBe('NONE');
  });

  it('never lets a year-end batch revoke, and never counts a revocation as leaving college', () => {
    expect(relationshipBatchStates).not.toContain('REVOKED');
    expect(formerStudentRelationshipStates).not.toContain('REVOKED');
  });
});

describe('relationshipChangeNotice', () => {
  it('names the college, the change and its date in India time, and says what the student keeps', () => {
    // Midnight 31 May in India is 30 May in UTC; the student must read 31 May.
    const notice = relationshipChangeNotice({ institutionName: 'Local College', state: 'GRADUATED', effectiveTo: new Date('2026-05-30T18:30:00Z') });
    expect(notice.title).toBe('Local College recorded you as graduated');
    expect(notice.body).toContain('31 May 2026');
    expect(notice.body).toContain('Your ONE account, your records and your choices stay yours.');
    expect(notice.body).toContain('sees only what happened before that date');
    expect(notice.body).toContain('verify past results');
  });

  it('fits the notification column limits and carries no identifiers', () => {
    const notice = relationshipChangeNotice({ institutionName: 'A'.repeat(300), state: 'TRANSFERRED', effectiveTo: now });
    expect(notice.title.length).toBeLessThanOrEqual(160);
    expect(notice.body.length).toBeLessThanOrEqual(500);
    const plain = relationshipChangeNotice({ institutionName: 'Local College', state: 'ENDED', effectiveTo: now });
    expect(JSON.stringify(plain)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(plain.title).toBe('Local College recorded you as no longer enrolled');
  });

  it('does not promise verification after a revocation', () => {
    expect(relationshipChangeNotice({ institutionName: 'Local College', state: 'REVOKED', effectiveTo: now }).body).not.toContain('verify');
  });
});

describe('relationshipReasonCodePattern', () => {
  it('matches the plan-wide reason code shape', () => {
    expect(relationshipReasonCodePattern.test('YEAR_END_GRADUATION')).toBe(true);
    expect(relationshipReasonCodePattern.test('ab')).toBe(false);
    expect(relationshipReasonCodePattern.test('year end')).toBe(false);
  });
});
