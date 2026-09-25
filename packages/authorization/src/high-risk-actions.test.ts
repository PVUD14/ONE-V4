/**
 * Dual-control rules (OPS-02): who may request, decide and execute an approval, and the
 * solo-operator safeguard. Pure functions; the 0038 trigger repeats them and the API
 * integration spec proves both agree.
 */
import { describe, expect, it } from 'vitest';
import {
  decideApproval,
  highRiskActionKeys,
  highRiskActions,
  isHighRiskFlagChange,
  isHighRiskVerificationTransition,
  refuseApprovalExecution,
  refuseApprovalRequest,
  type ApprovalDecisionInput,
} from './high-risk-actions.js';
import { highRiskInternalCapabilities, internalCapabilities } from './internal-capabilities.js';

const superAdmin = { userId: 'approver', memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE' }] };
const operations = { userId: 'requester', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] };

type DecisionOverrides = Partial<Omit<ApprovalDecisionInput, 'approval'>> & { readonly approval?: Partial<ApprovalDecisionInput['approval']> };
const decision = (over: DecisionOverrides = {}): ApprovalDecisionInput => ({
  actor: superAdmin,
  decision: 'APPROVE',
  approverCount: 2,
  ...over,
  approval: { state: 'PENDING', requestedByUserId: 'requester', expired: false, coolingOffElapsed: false, ...over.approval },
});

describe('the high-risk action list', () => {
  it('names a real capability for every action', () => {
    for (const key of highRiskActionKeys) expect(internalCapabilities).toContain(highRiskActions[key].capability);
  });

  it('marks only SUSPENDED as a high-risk verification transition', () => {
    expect(isHighRiskVerificationTransition('SUSPENDED')).toBe(true);
    for (const state of ['UNDER_REVIEW', 'VERIFIED', 'REJECTED']) expect(isHighRiskVerificationTransition(state)).toBe(false);
  });

  it('marks a flag change high-risk only in its marked direction', () => {
    expect(isHighRiskFlagChange('ENABLE', true)).toBe(true);
    expect(isHighRiskFlagChange('ENABLE', false)).toBe(false);
    expect(isHighRiskFlagChange('DISABLE', false)).toBe(true);
    expect(isHighRiskFlagChange('DISABLE', true)).toBe(false);
    expect(isHighRiskFlagChange(null, true)).toBe(false);
    expect(isHighRiskFlagChange(null, false)).toBe(false);
  });

  it('covers every high-risk capability grant through one action', () => {
    expect(highRiskInternalCapabilities.length).toBeGreaterThan(0);
    expect(highRiskActions.CAPABILITY_GRANT_HIGH_RISK.capability).toBe('CAPABILITY_ADMIN');
  });
});

describe('requesting', () => {
  it('needs the capability the action itself needs', () => {
    expect(refuseApprovalRequest(operations, 'ORGANIZATION_SUSPEND')).toBeNull();
    expect(refuseApprovalRequest(operations, 'CAPABILITY_GRANT_HIGH_RISK')).toBe('FORBIDDEN');
    const security = { userId: 's', memberships: [{ role: 'SECURITY_ADMIN', state: 'ACTIVE' }] };
    expect(refuseApprovalRequest(security, 'ORGANIZATION_SUSPEND')).toBe('FORBIDDEN');
    expect(refuseApprovalRequest(security, 'PRIVACY_HOLD_RELEASE')).toBeNull();
  });

  it('denies an inactive membership', () => {
    expect(refuseApprovalRequest({ userId: 'x', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'SUSPENDED' }] }, 'ORGANIZATION_SUSPEND')).toBe('FORBIDDEN');
  });
});

describe('deciding', () => {
  it('lets a second approver approve or reject', () => {
    expect(decideApproval(decision())).toEqual({ solo: false });
    expect(decideApproval(decision({ decision: 'REJECT' }))).toEqual({ solo: false });
  });

  it('refuses a decider without APPROVE_HIGH_RISK, and admits one granted it', () => {
    expect(decideApproval(decision({ actor: { ...operations, userId: 'other' } }))).toEqual({ refusal: 'FORBIDDEN' });
    const granted = { userId: 'other', memberships: [{ role: 'SECURITY_ADMIN', state: 'ACTIVE', grants: ['APPROVE_HIGH_RISK'] }] };
    expect(decideApproval(decision({ actor: granted }))).toEqual({ solo: false });
    const suspended = { userId: 'other', memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'SUSPENDED' }] };
    expect(decideApproval(decision({ actor: suspended }))).toEqual({ refusal: 'FORBIDDEN' });
  });

  it('refuses the requester approving their own request while a second approver exists', () => {
    const self = decision({ actor: { ...superAdmin, userId: 'requester' }, approval: { coolingOffElapsed: true } });
    expect(decideApproval(self)).toEqual({ refusal: 'APPROVAL_SELF_DECISION_REFUSED' });
  });

  it('allows the solo path only with exactly one approver and after the cooling-off', () => {
    const actor = { ...superAdmin, userId: 'requester' };
    expect(decideApproval(decision({ actor, approverCount: 1, approval: { coolingOffElapsed: false } }))).toEqual({ refusal: 'APPROVAL_SOLO_COOLING_OFF' });
    expect(decideApproval(decision({ actor, approverCount: 1, approval: { coolingOffElapsed: true } }))).toEqual({ solo: true });
    expect(decideApproval(decision({ actor, approverCount: 2, approval: { coolingOffElapsed: true } }))).toEqual({ refusal: 'APPROVAL_SELF_DECISION_REFUSED' });
    expect(decideApproval(decision({ actor, approverCount: 1, decision: 'REJECT', approval: { coolingOffElapsed: true } }))).toEqual({ refusal: 'APPROVAL_SELF_DECISION_REFUSED' });
  });

  it('refuses a decision on an expired or already decided request', () => {
    expect(decideApproval(decision({ approval: { expired: true } }))).toEqual({ refusal: 'APPROVAL_EXPIRED' });
    expect(decideApproval(decision({ approval: { state: 'APPROVED' } }))).toEqual({ refusal: 'APPROVAL_NOT_PENDING' });
  });

  it('refuses an approver deciding a capability grant to themselves', () => {
    expect(decideApproval(decision({ approval: { subjectUserId: 'approver' } }))).toEqual({ refusal: 'APPROVAL_SUBJECT_CONFLICT' });
  });
});

describe('executing', () => {
  const approval = { state: 'APPROVED', actionKey: 'ORGANIZATION_SUSPEND', payloadHash: 'a'.repeat(64), requestedByUserId: 'requester', expired: false };
  const execute = (over: Partial<typeof approval> | null, executorUserId = 'requester', payloadHash = 'a'.repeat(64)) => refuseApprovalExecution({
    executorUserId, actionKey: 'ORGANIZATION_SUSPEND', payloadHash, approval: over === null ? null : { ...approval, ...over },
  });

  it('consumes a valid approval', () => {
    expect(execute({})).toBeNull();
  });

  it('rejects a missing, unapproved, expired, foreign or changed approval', () => {
    expect(execute(null)).toBe('APPROVAL_NOT_FOUND');
    expect(execute({ state: 'PENDING' })).toBe('APPROVAL_NOT_APPROVED');
    expect(execute({ state: 'REJECTED' })).toBe('APPROVAL_NOT_APPROVED');
    expect(execute({ state: 'EXECUTED' })).toBe('APPROVAL_NOT_APPROVED');
    expect(execute({ expired: true })).toBe('APPROVAL_EXPIRED');
    expect(execute({}, 'approver')).toBe('APPROVAL_NOT_REQUESTER');
    expect(execute({}, 'requester', 'b'.repeat(64))).toBe('APPROVAL_PAYLOAD_MISMATCH');
    expect(execute({ actionKey: 'PRIVACY_HOLD_RELEASE' })).toBe('APPROVAL_PAYLOAD_MISMATCH');
  });
});
