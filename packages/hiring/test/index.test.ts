import { describe, expect, it } from 'vitest';
import {
  HiringRuleError,
  assertApplicationTransition,
  assertCanSubmitApplication,
  assertInterviewTransition,
  assertOfferTransition,
  canEmployerViewApplicant,
  canTransitionApplication,
  changedMaterialTerms,
  evaluateEligibility,
  isOfferExpired,
  materialTermsChanged,
  materialTermsHash,
  type EligibilityRule,
  type MaterialTerms,
} from '../src/index.js';

function expectRule(fn: () => void, code: string): void {
  try {
    fn();
    throw new Error('expected a HiringRuleError but none was thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(HiringRuleError);
    expect((error as HiringRuleError).code).toBe(code);
  }
}

describe('application lifecycle', () => {
  it('lets a student submit a draft', () => {
    expect(canTransitionApplication({ from: 'DRAFT', to: 'APPLIED', actor: 'STUDENT' })).toBe(true);
  });

  it('refuses to let an employer submit on the student behalf', () => {
    expectRule(() => assertApplicationTransition({ from: 'DRAFT', to: 'APPLIED', actor: 'EMPLOYER' }), 'ACTOR_NOT_PERMITTED');
  });

  it('hides unsubmitted drafts from employer transitions', () => {
    expectRule(() => assertApplicationTransition({ from: 'DRAFT', to: 'SCREENING', actor: 'EMPLOYER' }), 'INVALID_TRANSITION');
  });

  it('allows the employer to skip forward but never backward', () => {
    expect(canTransitionApplication({ from: 'APPLIED', to: 'SHORTLISTED', actor: 'EMPLOYER' })).toBe(true);
    expectRule(() => assertApplicationTransition({ from: 'INTERVIEW', to: 'SCREENING', actor: 'EMPLOYER' }), 'INVALID_TRANSITION');
  });

  it('does not allow a student to advance their own pipeline', () => {
    expectRule(() => assertApplicationTransition({ from: 'APPLIED', to: 'SHORTLISTED', actor: 'STUDENT' }), 'ACTOR_NOT_PERMITTED');
  });

  it('lets a student withdraw at any open stage', () => {
    for (const from of ['DRAFT', 'APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'] as const) {
      expect(canTransitionApplication({ from, to: 'WITHDRAWN', actor: 'STUDENT' })).toBe(true);
    }
  });

  it('treats terminal applications as immutable', () => {
    for (const from of ['HIRED', 'REJECTED', 'WITHDRAWN'] as const) {
      expectRule(() => assertApplicationTransition({ from, to: 'SCREENING', actor: 'EMPLOYER' }), 'APPLICATION_CLOSED');
    }
  });

  it('only marks hired from an accepted offer', () => {
    expectRule(() => assertApplicationTransition({ from: 'INTERVIEW', to: 'HIRED', actor: 'EMPLOYER' }), 'INVALID_TRANSITION');
    expectRule(() => assertApplicationTransition({ from: 'OFFER', to: 'HIRED', actor: 'EMPLOYER', offerState: 'EXTENDED' }), 'OFFER_NOT_ACCEPTED');
    expect(canTransitionApplication({ from: 'OFFER', to: 'HIRED', actor: 'EMPLOYER', offerState: 'ACCEPTED' })).toBe(true);
  });

  it('blocks employer action once consent is revoked', () => {
    expectRule(() => assertApplicationTransition({ from: 'APPLIED', to: 'SCREENING', actor: 'EMPLOYER', consentRevoked: true }), 'CONSENT_REVOKED');
  });

  it('still lets the student withdraw after revoking consent', () => {
    expect(canTransitionApplication({ from: 'APPLIED', to: 'WITHDRAWN', actor: 'STUDENT', consentRevoked: true })).toBe(true);
  });

  it('will not advance an applicant who owes a terms acknowledgement', () => {
    expectRule(
      () => assertApplicationTransition({ from: 'APPLIED', to: 'SHORTLISTED', actor: 'EMPLOYER', pendingTermsAcknowledgement: true }),
      'TERMS_ACKNOWLEDGEMENT_REQUIRED',
    );
  });

  it('still allows rejection when terms are unacknowledged', () => {
    expect(canTransitionApplication({ from: 'APPLIED', to: 'REJECTED', actor: 'EMPLOYER', pendingTermsAcknowledgement: true })).toBe(true);
  });

  it('rejects a no-op transition', () => {
    expectRule(() => assertApplicationTransition({ from: 'APPLIED', to: 'APPLIED', actor: 'EMPLOYER' }), 'INVALID_TRANSITION');
  });
});

describe('submitting an application', () => {
  const now = new Date('2026-03-01T00:00:00Z');

  it('accepts a published opportunity within deadline and with consent', () => {
    expect(() => assertCanSubmitApplication({
      opportunityLifecycleState: 'PUBLISHED',
      applicationDeadline: new Date('2026-03-10T00:00:00Z'),
      now,
      consentGranted: true,
    })).not.toThrow();
  });

  it('refuses unpublished opportunities', () => {
    for (const state of ['DRAFT', 'PAUSED', 'CLOSED', 'WITHDRAWN']) {
      expectRule(() => assertCanSubmitApplication({ opportunityLifecycleState: state, now, consentGranted: true }), 'OPPORTUNITY_NOT_OPEN');
    }
  });

  it('refuses after the deadline', () => {
    expectRule(() => assertCanSubmitApplication({
      opportunityLifecycleState: 'PUBLISHED',
      applicationDeadline: new Date('2026-02-01T00:00:00Z'),
      now,
      consentGranted: true,
    }), 'DEADLINE_PASSED');
  });

  it('refuses without explicit consent', () => {
    expectRule(() => assertCanSubmitApplication({ opportunityLifecycleState: 'PUBLISHED', now, consentGranted: false }), 'CONSENT_REQUIRED');
  });
});

describe('interview lifecycle', () => {
  it('allows rescheduling and completion from scheduled', () => {
    expect(() => assertInterviewTransition('SCHEDULED', 'RESCHEDULED')).not.toThrow();
    expect(() => assertInterviewTransition('RESCHEDULED', 'COMPLETED')).not.toThrow();
  });

  it('treats completed and cancelled interviews as final', () => {
    expectRule(() => assertInterviewTransition('COMPLETED', 'SCHEDULED'), 'INVALID_TRANSITION');
    expectRule(() => assertInterviewTransition('CANCELLED', 'COMPLETED'), 'INVALID_TRANSITION');
  });
});

describe('offer lifecycle', () => {
  it('lets the employer extend and the candidate respond', () => {
    expect(() => assertOfferTransition({ from: 'DRAFT', to: 'EXTENDED', actor: 'EMPLOYER' })).not.toThrow();
    expect(() => assertOfferTransition({ from: 'EXTENDED', to: 'ACCEPTED', actor: 'STUDENT' })).not.toThrow();
    expect(() => assertOfferTransition({ from: 'EXTENDED', to: 'DECLINED', actor: 'STUDENT' })).not.toThrow();
  });

  it('does not let an employer accept on the candidate behalf', () => {
    expectRule(() => assertOfferTransition({ from: 'EXTENDED', to: 'ACCEPTED', actor: 'EMPLOYER' }), 'ACTOR_NOT_PERMITTED');
  });

  it('does not let a candidate withdraw the employer offer', () => {
    expectRule(() => assertOfferTransition({ from: 'EXTENDED', to: 'WITHDRAWN', actor: 'STUDENT' }), 'ACTOR_NOT_PERMITTED');
  });

  it('cannot respond to an offer that was never extended', () => {
    expectRule(() => assertOfferTransition({ from: 'DRAFT', to: 'ACCEPTED', actor: 'STUDENT' }), 'INVALID_TRANSITION');
  });

  it('treats an accepted offer as final', () => {
    expectRule(() => assertOfferTransition({ from: 'ACCEPTED', to: 'WITHDRAWN', actor: 'EMPLOYER' }), 'INVALID_TRANSITION');
  });

  it('detects expiry', () => {
    const now = new Date('2026-03-05T00:00:00Z');
    expect(isOfferExpired(new Date('2026-03-01T00:00:00Z'), now)).toBe(true);
    expect(isOfferExpired(new Date('2026-03-10T00:00:00Z'), now)).toBe(false);
    expect(isOfferExpired(null, now)).toBe(false);
  });
});

describe('material terms', () => {
  const base: MaterialTerms = {
    employmentType: 'INTERNSHIP',
    workMode: 'ONSITE',
    locationCity: 'Bengaluru',
    compensationDisclosed: true,
    compensationCurrency: 'INR',
    compensationMin: '25000.00',
    compensationMax: '30000.00',
    compensationPeriod: 'MONTH',
    durationMonths: 6,
    applicationDeadline: '2026-04-01T00:00:00.000Z',
    joiningConditions: null,
  };

  it('is stable for identical terms', () => {
    expect(materialTermsHash(base)).toBe(materialTermsHash({ ...base }));
    expect(materialTermsChanged(base, { ...base })).toBe(false);
  });

  it('detects a compensation cut', () => {
    const next = { ...base, compensationMin: '15000.00' };
    expect(materialTermsChanged(base, next)).toBe(true);
    expect(changedMaterialTerms(base, next)).toEqual(['compensationMin']);
  });

  it('detects a location or work mode change', () => {
    expect(changedMaterialTerms(base, { ...base, workMode: 'REMOTE', locationCity: null }))
      .toEqual(['workMode', 'locationCity']);
  });

  it('produces a 64 character hex digest', () => {
    expect(materialTermsHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('eligibility', () => {
  const cgpaRule: EligibilityRule = { ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7, isBlocking: true };
  const backlogRule: EligibilityRule = { ruleType: 'MAX_BACKLOGS', comparator: 'LTE', valueNumeric: 0, isBlocking: true };
  const deptRule: EligibilityRule = { ruleType: 'DEPARTMENT', comparator: 'IN', valueText: 'CSE, IT', isBlocking: true };

  it('passes a student meeting every rule', () => {
    const outcome = evaluateEligibility([cgpaRule, backlogRule, deptRule], {
      cgpa: 8.1, activeBacklogs: 0, departmentName: 'CSE',
    });
    expect(outcome.eligible).toBe(true);
    expect(outcome.blockingFailures).toEqual([]);
  });

  it('blocks a student below the CGPA cut-off', () => {
    const outcome = evaluateEligibility([cgpaRule], { cgpa: 6.4 });
    expect(outcome.eligible).toBe(false);
    expect(outcome.blockingFailures).toEqual(['MIN_CGPA']);
  });

  it('blocks a department outside the target list', () => {
    expect(evaluateEligibility([deptRule], { departmentName: 'MECH' }).eligible).toBe(false);
  });

  it('fails closed when a blocking fact is missing', () => {
    const outcome = evaluateEligibility([cgpaRule], {});
    expect(outcome.eligible).toBe(false);
    expect(outcome.undeterminable).toEqual(['MIN_CGPA']);
    expect(outcome.blockingFailures).toEqual([]);
  });

  it('does not block on an advisory rule', () => {
    const advisory: EligibilityRule = { ruleType: 'PROGRAM', comparator: 'EQ', valueText: 'B.Tech', isBlocking: false };
    const outcome = evaluateEligibility([advisory], { programName: 'BCA' });
    expect(outcome.eligible).toBe(true);
    expect(outcome.advisoryFailures).toEqual(['PROGRAM']);
  });

  it('never auto-evaluates a CUSTOM rule', () => {
    const custom: EligibilityRule = { ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'portfolio required', isBlocking: true };
    const outcome = evaluateEligibility([custom], { cgpa: 9 });
    expect(outcome.eligible).toBe(false);
    expect(outcome.undeterminable).toEqual(['CUSTOM']);
  });

  it('treats an empty rule set as eligible', () => {
    expect(evaluateEligibility([], {}).eligible).toBe(true);
  });
});

describe('employer visibility', () => {
  const base = { viewerEmployerId: 'emp-1', applicationEmployerId: 'emp-1', applicationState: 'APPLIED' as const };

  it('permits the owning employer', () => {
    expect(canEmployerViewApplicant(base)).toBe(true);
  });

  it('refuses a different employer', () => {
    expect(canEmployerViewApplicant({ ...base, viewerEmployerId: 'emp-2' })).toBe(false);
  });

  it('refuses an unsubmitted draft', () => {
    expect(canEmployerViewApplicant({ ...base, applicationState: 'DRAFT' })).toBe(false);
  });

  it('refuses once consent is revoked', () => {
    expect(canEmployerViewApplicant({ ...base, consentRevokedAt: new Date() })).toBe(false);
  });
});
