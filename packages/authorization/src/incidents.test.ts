/**
 * Incident register and status notice rules (OPS-16): who may run incidents and send notices, the
 * incident state machine and its reason codes, the breach clock, the personal-data refusal, the
 * notice rate limit and the template-publication approval action. Pure functions; the 0081
 * triggers repeat them and the API integration spec proves both agree.
 */
import { describe, expect, it } from 'vitest';
import { hasInternalCapability } from './internal-capabilities.js';
import { approvalRequestReasons, highRiskActions, isLegacyHighRiskActionKey, refuseApprovalRequest, soloCoolingOffMinutes } from './high-risk-actions.js';
import {
  breachBoardClockHours,
  breachClockBasis,
  classifyBreachClock,
  commsTemplatePublishReasons,
  containsContactDetails,
  decideStatusNoticeApprover,
  incidentStates,
  incidentTransitionReasons,
  incidentTransitions,
  refuseCommsTemplatePublishRequest,
  refuseIncidentReclassification,
  refuseIncidentTransition,
  refuseStatusNoticeApproval,
  statusNoticeAudienceRoles,
  statusNoticeDailyLimit,
  statusNoticeSoloCoolingOffMinutes,
  statusNoticeStableKey,
} from './incidents.js';

const context = (role: string, state = 'ACTIVE', grants: string[] = []) => ({ memberships: [{ role, state, grants }] });
const actor = (role: string, state = 'ACTIVE', grants: string[] = []) => ({ userId: 'u-' + role, ...context(role, state, grants) });

describe('incident and communications capabilities', () => {
  it('allows the register to a role whose baseline holds INCIDENT_MANAGE', () => {
    expect(hasInternalCapability(context('SECURITY_ADMIN'), 'INCIDENT_MANAGE')).toBe(true);
    expect(hasInternalCapability(context('PLATFORM_SUPER_ADMIN'), 'INCIDENT_MANAGE')).toBe(true);
  });

  it('allows notices and templates to a role whose baseline holds COMMS_TEMPLATES', () => {
    expect(hasInternalCapability(context('OPERATIONS_ADMIN'), 'COMMS_TEMPLATES')).toBe(true);
    expect(hasInternalCapability(context('PLATFORM_SUPER_ADMIN'), 'COMMS_TEMPLATES')).toBe(true);
  });

  it('denies each when neither baseline nor granted', () => {
    expect(hasInternalCapability(context('OPERATIONS_ADMIN'), 'INCIDENT_MANAGE')).toBe(false);
    expect(hasInternalCapability(context('SECURITY_ADMIN'), 'COMMS_TEMPLATES')).toBe(false);
    expect(hasInternalCapability(context('INSTITUTION_ADMIN'), 'INCIDENT_MANAGE')).toBe(false);
    expect(hasInternalCapability(context('INSTITUTION_ADMIN', 'ACTIVE', ['INCIDENT_MANAGE']), 'INCIDENT_MANAGE')).toBe(false);
  });

  it('allows each through an explicit grant on a platform membership', () => {
    expect(hasInternalCapability(context('OPERATIONS_ADMIN', 'ACTIVE', ['INCIDENT_MANAGE']), 'INCIDENT_MANAGE')).toBe(true);
    expect(hasInternalCapability(context('SECURITY_ADMIN', 'ACTIVE', ['COMMS_TEMPLATES']), 'COMMS_TEMPLATES')).toBe(true);
  });

  it('denies an inactive membership, baseline or granted', () => {
    expect(hasInternalCapability(context('SECURITY_ADMIN', 'SUSPENDED'), 'INCIDENT_MANAGE')).toBe(false);
    expect(hasInternalCapability(context('OPERATIONS_ADMIN', 'ENDED'), 'COMMS_TEMPLATES')).toBe(false);
    expect(hasInternalCapability(context('SECURITY_ADMIN', 'SUSPENDED', ['COMMS_TEMPLATES']), 'COMMS_TEMPLATES')).toBe(false);
  });
});

describe('incident state machine', () => {
  const base = { category: 'SECURITY' as const, boardNotified: false, usersNotified: false };

  it('lets CLOSED end every path and never leave it', () => {
    expect(incidentTransitions.CLOSED).toEqual([]);
    for (const state of incidentStates) {
      if (state === 'CLOSED') continue;
      expect(incidentTransitionReasons[state].length).toBeGreaterThan(0);
    }
  });

  it('accepts listed transitions with a reason for the target state', () => {
    expect(refuseIncidentTransition({ ...base, from: 'OPEN', to: 'CONTAINED', reasonCode: 'ACCESS_PATH_CLOSED' })).toBeNull();
    expect(refuseIncidentTransition({ ...base, from: 'CONTAINED', to: 'RESOLVED', reasonCode: 'ROOT_CAUSE_FIXED' })).toBeNull();
    expect(refuseIncidentTransition({ ...base, from: 'RESOLVED', to: 'OPEN', reasonCode: 'RECURRENCE' })).toBeNull();
    expect(refuseIncidentTransition({ ...base, from: 'RESOLVED', to: 'CLOSED', reasonCode: 'POST_INCIDENT_REVIEW_DONE' })).toBeNull();
  });

  it('refuses an unlisted edge and a reason from another state', () => {
    expect(refuseIncidentTransition({ ...base, from: 'CONTAINED', to: 'CLOSED', reasonCode: 'POST_INCIDENT_REVIEW_DONE' })).toBe('INCIDENT_TRANSITION_NOT_ALLOWED');
    expect(refuseIncidentTransition({ ...base, from: 'CLOSED', to: 'OPEN', reasonCode: 'RECURRENCE' })).toBe('INCIDENT_TRANSITION_NOT_ALLOWED');
    expect(refuseIncidentTransition({ ...base, from: 'OPEN', to: 'CONTAINED', reasonCode: 'ROOT_CAUSE_FIXED' })).toBe('REASON_CODE_INVALID');
  });

  it('closes straight from OPEN only as a duplicate or false alarm', () => {
    expect(refuseIncidentTransition({ ...base, from: 'OPEN', to: 'CLOSED', reasonCode: 'DUPLICATE' })).toBeNull();
    expect(refuseIncidentTransition({ ...base, from: 'OPEN', to: 'CLOSED', reasonCode: 'POST_INCIDENT_REVIEW_DONE' })).toBe('REASON_CODE_INVALID');
  });

  it('keeps a breach open until the Board and affected users are recorded as notified', () => {
    const breach = { from: 'RESOLVED' as const, to: 'CLOSED' as const, reasonCode: 'POST_INCIDENT_REVIEW_DONE', category: 'PERSONAL_DATA_BREACH' as const };
    expect(refuseIncidentTransition({ ...breach, boardNotified: false, usersNotified: true })).toBe('INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING');
    expect(refuseIncidentTransition({ ...breach, boardNotified: true, usersNotified: false })).toBe('INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING');
    expect(refuseIncidentTransition({ ...breach, boardNotified: true, usersNotified: true })).toBeNull();
  });

  it('never reclassifies a breach someone was notified about', () => {
    expect(refuseIncidentReclassification({ from: 'PERSONAL_DATA_BREACH', to: 'SECURITY', state: 'OPEN', boardNotified: true, usersNotified: false })).toBe('INCIDENT_BREACH_ALREADY_NOTIFIED');
    expect(refuseIncidentReclassification({ from: 'PERSONAL_DATA_BREACH', to: 'SECURITY', state: 'OPEN', boardNotified: false, usersNotified: false })).toBeNull();
    expect(refuseIncidentReclassification({ from: 'SECURITY', to: 'SECURITY', state: 'OPEN', boardNotified: false, usersNotified: false })).toBe('INCIDENT_CATEGORY_UNCHANGED');
    expect(refuseIncidentReclassification({ from: 'SECURITY', to: 'OTHER', state: 'CLOSED', boardNotified: false, usersNotified: false })).toBe('INCIDENT_CLOSED');
  });
});

describe('breach clock', () => {
  it('uses the plan period and says it is pending legal confirmation', () => {
    expect(breachBoardClockHours).toBe(72);
    expect(breachClockBasis).toBe('PLAN_PENDING_LEGAL_CONFIRMATION');
  });

  it('classifies running, overdue, met and met late', () => {
    expect(classifyBreachClock({ boardNotified: false, notifiedWithinPeriod: false, deadlinePassed: false })).toBe('RUNNING');
    expect(classifyBreachClock({ boardNotified: false, notifiedWithinPeriod: false, deadlinePassed: true })).toBe('OVERDUE');
    expect(classifyBreachClock({ boardNotified: true, notifiedWithinPeriod: true, deadlinePassed: true })).toBe('MET');
    expect(classifyBreachClock({ boardNotified: true, notifiedWithinPeriod: false, deadlinePassed: true })).toBe('MET_LATE');
  });
});

describe('personal data in incident text', () => {
  it('refuses an email address or a phone number', () => {
    expect(containsContactDetails('Reported by asha@college.example')).toBe(true);
    expect(containsContactDetails('Caller on 98765 43210')).toBe(true);
    expect(containsContactDetails('Caller on +919876543210')).toBe(true);
  });

  it('allows ordinary operational text and dates', () => {
    expect(containsContactDetails('API returned 500 for 12 minutes after the 2026-09-29 deploy')).toBe(false);
    expect(containsContactDetails('Backup bucket credential exposed in a public log')).toBe(false);
  });
});

describe('status notices', () => {
  const ready = { noticeState: 'DRAFT', incidentState: 'OPEN' as const, liveAffectedOrganizations: 2, approvedInSpacingWindow: 0, approvedInLastDay: 0 };

  it('approves a draft for an open incident with an audience inside the rate limit', () => {
    expect(refuseStatusNoticeApproval(ready)).toBeNull();
  });

  it('refuses a closed incident, no audience, a non-draft and the rate limit', () => {
    expect(refuseStatusNoticeApproval({ ...ready, incidentState: 'CLOSED' })).toBe('STATUS_NOTICE_INCIDENT_CLOSED');
    expect(refuseStatusNoticeApproval({ ...ready, liveAffectedOrganizations: 0 })).toBe('STATUS_NOTICE_NO_AUDIENCE');
    expect(refuseStatusNoticeApproval({ ...ready, noticeState: 'SENT' })).toBe('STATUS_NOTICE_NOT_DRAFT');
    expect(refuseStatusNoticeApproval({ ...ready, approvedInSpacingWindow: 1 })).toBe('STATUS_NOTICE_RATE_LIMITED');
    expect(refuseStatusNoticeApproval({ ...ready, approvedInLastDay: statusNoticeDailyLimit })).toBe('STATUS_NOTICE_RATE_LIMITED');
  });

  it('is approved by a person other than its drafter (OPS-02 requester-is-not-approver)', () => {
    const facts = { actorUserId: 'second', draftedByUserId: 'drafter', approverCount: 3, coolingOffElapsed: false };
    expect(decideStatusNoticeApprover(facts)).toEqual({ solo: false });
    expect(decideStatusNoticeApprover({ ...facts, actorUserId: 'drafter' })).toEqual({ refusal: 'STATUS_NOTICE_SELF_APPROVAL_REFUSED' });
    expect(decideStatusNoticeApprover({ ...facts, actorUserId: 'drafter', coolingOffElapsed: true })).toEqual({ refusal: 'STATUS_NOTICE_SELF_APPROVAL_REFUSED' });
  });

  it('lets the sole approver approve their own notice only after the cooling-off, marked solo', () => {
    const solo = { actorUserId: 'drafter', draftedByUserId: 'drafter', approverCount: 1, coolingOffElapsed: false };
    expect(decideStatusNoticeApprover(solo)).toEqual({ refusal: 'STATUS_NOTICE_SOLO_COOLING_OFF' });
    expect(decideStatusNoticeApprover({ ...solo, coolingOffElapsed: true })).toEqual({ solo: true });
    // The safeguard switches itself off once a second approver exists.
    expect(decideStatusNoticeApprover({ ...solo, coolingOffElapsed: true, approverCount: 2 })).toEqual({ refusal: 'STATUS_NOTICE_SELF_APPROVAL_REFUSED' });
    expect(statusNoticeSoloCoolingOffMinutes).toBe(soloCoolingOffMinutes);
  });

  it('reaches administrators only, never students', () => {
    expect(statusNoticeAudienceRoles).not.toContain('STUDENT');
    expect(statusNoticeAudienceRoles.every((role) => role.endsWith('_OWNER') || role.endsWith('_ADMIN'))).toBe(true);
  });

  it('keys published templates apart from every other sender', () => {
    expect(statusNoticeStableKey('outage-update')).toBe('status-notice.outage-update');
  });
});

describe('template publication approval', () => {
  it('is an extended dual-control action needing COMMS_TEMPLATES', () => {
    expect(highRiskActions.COMMS_TEMPLATE_PUBLISH).toMatchObject({ capability: 'COMMS_TEMPLATES', targetType: 'status_notice_template' });
    expect(isLegacyHighRiskActionKey('COMMS_TEMPLATE_PUBLISH')).toBe(false);
    expect(approvalRequestReasons.COMMS_TEMPLATE_PUBLISH).toEqual(commsTemplatePublishReasons);
    expect(refuseApprovalRequest(actor('OPERATIONS_ADMIN'), 'COMMS_TEMPLATE_PUBLISH')).toBeNull();
    expect(refuseApprovalRequest(actor('SECURITY_ADMIN'), 'COMMS_TEMPLATE_PUBLISH')).toBe('FORBIDDEN');
  });

  it('lets only the author of a draft request its publication', () => {
    expect(refuseCommsTemplatePublishRequest({ actorUserId: 'a', authorUserId: 'a', state: 'DRAFT' })).toBeNull();
    expect(refuseCommsTemplatePublishRequest({ actorUserId: 'b', authorUserId: 'a', state: 'DRAFT' })).toBe('COMMS_TEMPLATE_NOT_AUTHOR');
    expect(refuseCommsTemplatePublishRequest({ actorUserId: 'a', authorUserId: 'a', state: 'PUBLISHED' })).toBe('COMMS_TEMPLATE_NOT_DRAFT');
  });
});
