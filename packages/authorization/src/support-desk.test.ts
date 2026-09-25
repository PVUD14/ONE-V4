/**
 * Support desk rules (OPS-05): who may work cases and look up accounts, the case state
 * machine and its reason codes, SLA targets, assignee eligibility and contact masking.
 * Pure functions; the 0043 trigger repeats the state machine and the API integration
 * spec proves both agree.
 */
import { describe, expect, it } from 'vitest';
import { hasInternalCapability } from './internal-capabilities.js';
import {
  isEligibleSupportAssignee,
  maskEmail,
  maskPhone,
  refuseSupportCaseTransition,
  supportCaseSeverities,
  supportCaseSlaHours,
  supportCaseStates,
  supportCaseTransitionReasons,
  supportCaseTransitions,
} from './support-desk.js';

const context = (role: string, state = 'ACTIVE', grants: string[] = []) => ({ memberships: [{ role, state, grants }] });

describe('support capabilities', () => {
  it('allows the case desk to a role whose baseline holds SUPPORT_CASES', () => {
    expect(hasInternalCapability(context('OPERATIONS_ADMIN'), 'SUPPORT_CASES')).toBe(true);
    expect(hasInternalCapability(context('PLATFORM_SUPER_ADMIN'), 'SUPPORT_CASES')).toBe(true);
  });

  it('denies the case desk when the capability is neither baseline nor granted', () => {
    expect(hasInternalCapability(context('SECURITY_ADMIN'), 'SUPPORT_CASES')).toBe(false);
    expect(hasInternalCapability(context('INSTITUTION_ADMIN'), 'SUPPORT_CASES')).toBe(false);
    expect(hasInternalCapability(context('INSTITUTION_ADMIN'), 'SUPPORT_ACCOUNT_LOOKUP')).toBe(false);
  });

  it('allows the case desk to a platform role through an explicit grant', () => {
    expect(hasInternalCapability(context('SECURITY_ADMIN', 'ACTIVE', ['SUPPORT_CASES']), 'SUPPORT_CASES')).toBe(true);
  });

  it('never honours a grant on a non-platform membership', () => {
    expect(hasInternalCapability(context('INSTITUTION_ADMIN', 'ACTIVE', ['SUPPORT_CASES']), 'SUPPORT_CASES')).toBe(false);
  });

  it('allows account lookup to operations and security staff', () => {
    expect(hasInternalCapability(context('OPERATIONS_ADMIN'), 'SUPPORT_ACCOUNT_LOOKUP')).toBe(true);
    expect(hasInternalCapability(context('SECURITY_ADMIN'), 'SUPPORT_ACCOUNT_LOOKUP')).toBe(true);
  });

  it('denies an inactive membership, whatever it holds', () => {
    for (const state of ['PENDING', 'SUSPENDED', 'ENDED']) {
      expect(hasInternalCapability(context('OPERATIONS_ADMIN', state), 'SUPPORT_CASES')).toBe(false);
      expect(hasInternalCapability(context('SECURITY_ADMIN', state, ['SUPPORT_CASES']), 'SUPPORT_ACCOUNT_LOOKUP')).toBe(false);
    }
  });
});

describe('support case state machine', () => {
  it('declares every state and ends at CLOSED', () => {
    expect(Object.keys(supportCaseTransitions).sort()).toEqual([...supportCaseStates].sort());
    expect(supportCaseTransitions.CLOSED).toEqual([]);
  });

  it('allows the documented transitions with a matching reason', () => {
    expect(refuseSupportCaseTransition('OPEN', 'IN_PROGRESS', 'WORK_STARTED')).toBeNull();
    expect(refuseSupportCaseTransition('IN_PROGRESS', 'RESOLVED', 'FIXED')).toBeNull();
    expect(refuseSupportCaseTransition('RESOLVED', 'CLOSED', 'CONFIRMED_WITH_CUSTOMER')).toBeNull();
    expect(refuseSupportCaseTransition('RESOLVED', 'IN_PROGRESS', 'REOPENED_NOT_FIXED')).toBeNull();
    expect(refuseSupportCaseTransition('OPEN', 'CLOSED', 'DUPLICATE')).toBeNull();
    expect(refuseSupportCaseTransition('WAITING_ON_CUSTOMER', 'CLOSED', 'NO_RESPONSE')).toBeNull();
  });

  it('refuses transitions the machine does not have', () => {
    expect(refuseSupportCaseTransition('IN_PROGRESS', 'CLOSED', 'DUPLICATE')).toBe('SUPPORT_CASE_TRANSITION_NOT_ALLOWED');
    expect(refuseSupportCaseTransition('CLOSED', 'IN_PROGRESS', 'WORK_STARTED')).toBe('SUPPORT_CASE_TRANSITION_NOT_ALLOWED');
    expect(refuseSupportCaseTransition('IN_PROGRESS', 'OPEN', 'WORK_STARTED')).toBe('SUPPORT_CASE_TRANSITION_NOT_ALLOWED');
    expect(refuseSupportCaseTransition('OPEN', 'OPEN', 'WORK_STARTED')).toBe('SUPPORT_CASE_TRANSITION_NOT_ALLOWED');
  });

  it('refuses a reason that belongs to another target state', () => {
    expect(refuseSupportCaseTransition('IN_PROGRESS', 'RESOLVED', 'DUPLICATE')).toBe('REASON_CODE_INVALID');
    expect(refuseSupportCaseTransition('OPEN', 'IN_PROGRESS', 'free text')).toBe('REASON_CODE_INVALID');
  });

  it('gives every reason code the shared reason-code shape', () => {
    for (const reasons of Object.values(supportCaseTransitionReasons)) {
      for (const reason of reasons) expect(reason).toMatch(/^[A-Z0-9_:-]{3,64}$/);
    }
  });
});

describe('SLA targets', () => {
  it('has a target for every severity, shorter as severity rises', () => {
    expect(Object.keys(supportCaseSlaHours).sort()).toEqual([...supportCaseSeverities].sort());
    expect(supportCaseSlaHours.URGENT).toBeLessThan(supportCaseSlaHours.HIGH);
    expect(supportCaseSlaHours.HIGH).toBeLessThan(supportCaseSlaHours.MEDIUM);
    expect(supportCaseSlaHours.MEDIUM).toBeLessThan(supportCaseSlaHours.LOW);
  });
});

describe('assignee eligibility', () => {
  it('accepts an ACTIVE membership holding SUPPORT_CASES by baseline or grant', () => {
    expect(isEligibleSupportAssignee([{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }])).toBe(true);
    expect(isEligibleSupportAssignee([{ role: 'SECURITY_ADMIN', state: 'ACTIVE', grants: ['SUPPORT_CASES'] }])).toBe(true);
  });

  it('refuses staff without the capability, and inactive memberships', () => {
    expect(isEligibleSupportAssignee([{ role: 'SECURITY_ADMIN', state: 'ACTIVE' }])).toBe(false);
    expect(isEligibleSupportAssignee([{ role: 'OPERATIONS_ADMIN', state: 'SUSPENDED' }])).toBe(false);
    expect(isEligibleSupportAssignee([{ role: 'INSTITUTION_ADMIN', state: 'ACTIVE', grants: ['SUPPORT_CASES'] }])).toBe(false);
  });
});

describe('contact masking', () => {
  it('keeps the first character and the domain of an email', () => {
    expect(maskEmail('asha.rao@college.edu')).toBe('a***@college.edu');
    expect(maskEmail('A@x.io')).toBe('A***@x.io');
  });

  it('masks anything that is not an address completely', () => {
    expect(maskEmail('not-an-address')).toBe('***');
    expect(maskEmail('@college.edu')).toBe('***');
    expect(maskEmail(null)).toBeNull();
  });

  it('keeps only the last four digits of a phone number', () => {
    expect(maskPhone('+91 98765 43210')).toBe('***3210');
    expect(maskPhone('12')).toBe('***');
    expect(maskPhone(null)).toBeNull();
  });
});
