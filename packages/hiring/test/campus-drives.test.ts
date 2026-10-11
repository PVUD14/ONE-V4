/**
 * EMP-11: the campus drive state machine per side, its reason codes, and the one-offer placement
 * rule, tested without a database.
 */
import { describe, expect, it } from 'vitest';
import { HiringRuleError } from '../src/index.js';
import {
  availableCampusDriveActions,
  campusDriveReasonCodes,
  campusDriveStates,
  campusDriveTarget,
  canTakeCampusDriveAction,
  holdsAcceptedOffer,
  liveCampusDriveStates,
  oneOfferPolicyBlocks,
  openCampusDriveStates,
  type CampusDriveAction,
} from '../src/campus-drives.js';

const actions: readonly CampusDriveAction[] = ['RESUBMIT', 'APPROVE', 'REJECT', 'REQUEST_CHANGES', 'SCHEDULE', 'CANCEL', 'COMPLETE'];

describe('campus drive state machine', () => {
  it('lets only the college make a drive live, from REQUESTED', () => {
    for (const state of campusDriveStates) {
      for (const action of actions) {
        const target = canTakeCampusDriveAction('EMPLOYER', state, action) ? campusDriveTarget('EMPLOYER', state, action, true) : null;
        expect(target === 'APPROVED' || target === 'SCHEDULED').toBe(false);
      }
    }
    expect(campusDriveTarget('INSTITUTION', 'REQUESTED', 'APPROVE')).toBe('APPROVED');
    expect(campusDriveTarget('INSTITUTION', 'REQUESTED', 'APPROVE', true)).toBe('SCHEDULED');
    expect(canTakeCampusDriveAction('INSTITUTION', 'CHANGES_REQUESTED', 'APPROVE')).toBe(false);
  });

  it('offers each side exactly its actions per state', () => {
    expect(availableCampusDriveActions('INSTITUTION', 'REQUESTED')).toEqual(['APPROVE', 'REQUEST_CHANGES', 'REJECT']);
    expect(availableCampusDriveActions('INSTITUTION', 'APPROVED')).toEqual(['SCHEDULE', 'COMPLETE', 'CANCEL']);
    expect(availableCampusDriveActions('INSTITUTION', 'SCHEDULED')).toEqual(['SCHEDULE', 'COMPLETE', 'CANCEL']);
    expect(availableCampusDriveActions('INSTITUTION', 'CHANGES_REQUESTED')).toEqual([]);
    expect(availableCampusDriveActions('EMPLOYER', 'REQUESTED')).toEqual(['CANCEL']);
    expect(availableCampusDriveActions('EMPLOYER', 'CHANGES_REQUESTED')).toEqual(['RESUBMIT', 'CANCEL']);
    expect(availableCampusDriveActions('EMPLOYER', 'SCHEDULED')).toEqual(['COMPLETE', 'CANCEL']);
    for (const terminal of ['REJECTED', 'COMPLETED', 'CANCELLED']) {
      expect(availableCampusDriveActions('EMPLOYER', terminal)).toEqual([]);
      expect(availableCampusDriveActions('INSTITUTION', terminal)).toEqual([]);
    }
  });

  it('maps every allowed action to its target and refuses the rest with a rule code', () => {
    expect(campusDriveTarget('EMPLOYER', 'CHANGES_REQUESTED', 'RESUBMIT')).toBe('REQUESTED');
    expect(campusDriveTarget('INSTITUTION', 'REQUESTED', 'REJECT')).toBe('REJECTED');
    expect(campusDriveTarget('INSTITUTION', 'REQUESTED', 'REQUEST_CHANGES')).toBe('CHANGES_REQUESTED');
    expect(campusDriveTarget('INSTITUTION', 'APPROVED', 'SCHEDULE')).toBe('SCHEDULED');
    expect(campusDriveTarget('EMPLOYER', 'APPROVED', 'COMPLETE')).toBe('COMPLETED');
    expect(campusDriveTarget('INSTITUTION', 'SCHEDULED', 'CANCEL')).toBe('CANCELLED');
    try {
      campusDriveTarget('INSTITUTION', 'REQUESTED', 'CANCEL');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HiringRuleError);
      expect((error as HiringRuleError).code).toBe('CAMPUS_DRIVE_TRANSITION_NOT_ALLOWED');
    }
    expect(() => campusDriveTarget('EMPLOYER', 'REQUESTED', 'SCHEDULE')).toThrow(HiringRuleError);
  });

  it('treats only approved and scheduled drives as live, and every non-terminal one as open', () => {
    expect(liveCampusDriveStates).toEqual(['APPROVED', 'SCHEDULED']);
    expect(openCampusDriveStates).toEqual(['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED']);
  });

  it('asks for a listed reason exactly where a refusal or cancellation needs one', () => {
    expect(campusDriveReasonCodes('INSTITUTION', 'REJECT')).toContain('SEASON_CLOSED');
    expect(campusDriveReasonCodes('INSTITUTION', 'REQUEST_CHANGES')).toContain('SCHEDULE_CHANGE_NEEDED');
    expect(campusDriveReasonCodes('EMPLOYER', 'CANCEL')).toContain('POSITIONS_FILLED');
    expect(campusDriveReasonCodes('INSTITUTION', 'CANCEL')).toContain('POLICY_CONFLICT');
    expect(campusDriveReasonCodes('INSTITUTION', 'APPROVE')).toBeNull();
    expect(campusDriveReasonCodes('EMPLOYER', 'COMPLETE')).toBeNull();
    for (const list of [campusDriveReasonCodes('INSTITUTION', 'REJECT'), campusDriveReasonCodes('EMPLOYER', 'CANCEL')]) {
      for (const code of list ?? []) expect(code).toMatch(/^[A-Z0-9_:-]{3,64}$/);
      expect(list).not.toContain('OTHER');
    }
  });
});

describe('one offer per student', () => {
  const policy = { id: 'p', policyType: 'ONE_OFFER_PER_STUDENT' as const, allowDriveExceptions: false };

  it('blocks a student holding an accepted offer, and nobody else', () => {
    expect(oneOfferPolicyBlocks(policy, { holdsAcceptedOffer: true, driveOfferHoldersEligible: false })).toBe(true);
    expect(oneOfferPolicyBlocks(policy, { holdsAcceptedOffer: false, driveOfferHoldersEligible: false })).toBe(false);
    expect(oneOfferPolicyBlocks(null, { holdsAcceptedOffer: true, driveOfferHoldersEligible: false })).toBe(false);
  });

  it('exempts a drive only when the policy allows exceptions and the college marked the drive', () => {
    expect(oneOfferPolicyBlocks(policy, { holdsAcceptedOffer: true, driveOfferHoldersEligible: true })).toBe(true);
    const withExceptions = { ...policy, allowDriveExceptions: true };
    expect(oneOfferPolicyBlocks(withExceptions, { holdsAcceptedOffer: true, driveOfferHoldersEligible: false })).toBe(true);
    expect(oneOfferPolicyBlocks(withExceptions, { holdsAcceptedOffer: true, driveOfferHoldersEligible: true })).toBe(false);
  });

  it('counts an accepted offer while its application stands, and a hire', () => {
    expect(holdsAcceptedOffer([{ state: 'OFFER', offerStates: ['ACCEPTED'] }])).toBe(true);
    expect(holdsAcceptedOffer([{ state: 'HIRED', offerStates: [] }])).toBe(true);
    expect(holdsAcceptedOffer([{ state: 'WITHDRAWN', offerStates: ['ACCEPTED'] }])).toBe(false);
    expect(holdsAcceptedOffer([{ state: 'REJECTED', offerStates: ['ACCEPTED'] }])).toBe(false);
    expect(holdsAcceptedOffer([{ state: 'OFFER', offerStates: ['EXTENDED', 'DECLINED'] }])).toBe(false);
    expect(holdsAcceptedOffer([])).toBe(false);
  });
});
