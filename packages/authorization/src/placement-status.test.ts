/**
 * Placement status derivation (INST-09): only shared applications count, nothing shared
 * is never "not applied", and a draft offer is never an offer.
 */
import { describe, expect, it } from 'vitest';
import { applicationPlacementStatus, placementStatuses, studentPlacementStatus } from './placement-status.js';

describe('placement status', () => {
  it('is NOT_SHARED when nothing is shared, never a "not applied"', () => {
    expect(studentPlacementStatus([])).toBe('NOT_SHARED');
    expect(placementStatuses).not.toContain('NOT_APPLIED');
  });

  it.each([
    ['APPLIED', null, 'APPLIED'],
    ['REJECTED', null, 'APPLIED'],
    ['WITHDRAWN', null, 'APPLIED'],
    ['SCREENING', null, 'IN_PROCESS'],
    ['SHORTLISTED', null, 'IN_PROCESS'],
    ['ASSESSMENT', null, 'IN_PROCESS'],
    ['INTERVIEW', null, 'IN_PROCESS'],
    ['OFFER', null, 'OFFER'],
    ['OFFER', 'EXTENDED', 'OFFER'],
    ['OFFER', 'ACCEPTED', 'ACCEPTED'],
    ['OFFER', 'DECLINED', 'APPLIED'],
    ['OFFER', 'WITHDRAWN', 'APPLIED'],
    ['OFFER', 'EXPIRED', 'APPLIED'],
    ['HIRED', null, 'ACCEPTED'],
    ['INTERVIEW', 'DRAFT', 'IN_PROCESS'],
    ['OFFER', 'DRAFT', 'OFFER'],
  ] as const)('%s with offer %s reads %s', (state, offerState, expected) => {
    expect(applicationPlacementStatus({ state, offerState })).toBe(expected);
  });

  it('takes the furthest status across the shared applications', () => {
    expect(studentPlacementStatus([{ state: 'REJECTED', offerState: null }, { state: 'INTERVIEW', offerState: null }])).toBe('IN_PROCESS');
    expect(studentPlacementStatus([{ state: 'OFFER', offerState: 'EXTENDED' }, { state: 'HIRED', offerState: 'ACCEPTED' }, { state: 'APPLIED', offerState: null }])).toBe('ACCEPTED');
    expect(studentPlacementStatus([{ state: 'OFFER', offerState: 'DECLINED' }, { state: 'SCREENING', offerState: null }])).toBe('IN_PROCESS');
  });
});
