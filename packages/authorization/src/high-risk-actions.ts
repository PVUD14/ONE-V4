/**
 * Dual control for high-risk operator actions (OPS-02, Appendix 1 §5.4).
 *
 * The action list, the capability each needs, the reason codes, and the rules for
 * requesting, deciding and executing an approval — as pure functions, so the API's
 * answer and error code come from one place. Migration 0038's trigger repeats the
 * rules so a second writer cannot skip them.
 *
 * Design: docs/architecture/high-risk-approvals-table-design.md
 */
import { careerPublishReasons } from './career-catalogue.js';
import { hasInternalCapability, internalCapabilityGrantReasons, type InternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

export const highRiskActionKeys = [
  'ORGANIZATION_SUSPEND',
  'FEATURE_FLAG_HIGH_RISK_CHANGE',
  'OUTBOX_BACKLOG_SUPERSEDE',
  'PRIVACY_HOLD_RELEASE',
  'CAPABILITY_GRANT_HIGH_RISK',
  // OPS-08. Stored in operation_approvals.extended_action_key (0051): 0038 re-adds its
  // five-key CHECK on every replay, so a sixth key cannot live in action_key.
  'CAREER_REQUIREMENT_SET_PUBLISH',
] as const;

/** The keys 0038's CHECK allows in `action_key`; any other key is an extended key (0051). */
export const legacyHighRiskActionKeys = [
  'ORGANIZATION_SUSPEND',
  'FEATURE_FLAG_HIGH_RISK_CHANGE',
  'OUTBOX_BACKLOG_SUPERSEDE',
  'PRIVACY_HOLD_RELEASE',
  'CAPABILITY_GRANT_HIGH_RISK',
] as const;

export type HighRiskActionKey = (typeof highRiskActionKeys)[number];

export interface HighRiskActionDefinition {
  /** Needed both to request the action and to execute it. */
  readonly capability: InternalCapability;
  readonly targetType: 'organization' | 'feature_flag' | 'outbox_backlog' | 'data_retention_hold' | 'organization_membership' | 'career_requirement_set';
  readonly label: string;
}

export const highRiskActions: Readonly<Record<HighRiskActionKey, HighRiskActionDefinition>> = {
  ORGANIZATION_SUSPEND: { capability: 'OPS_VERIFY', targetType: 'organization', label: 'Suspend an organisation' },
  FEATURE_FLAG_HIGH_RISK_CHANGE: { capability: 'OPS_FLAGS_MANAGE', targetType: 'feature_flag', label: 'Change a high-risk feature flag' },
  OUTBOX_BACKLOG_SUPERSEDE: { capability: 'OPS_JOBS_REPLAY', targetType: 'outbox_backlog', label: 'Supersede the background event backlog' },
  PRIVACY_HOLD_RELEASE: { capability: 'PRIVACY_HOLDS', targetType: 'data_retention_hold', label: 'Release a legal hold' },
  CAPABILITY_GRANT_HIGH_RISK: { capability: 'CAPABILITY_ADMIN', targetType: 'organization_membership', label: 'Grant a high-risk capability' },
  CAREER_REQUIREMENT_SET_PUBLISH: { capability: 'CONTENT_PUBLISH', targetType: 'career_requirement_set', label: 'Publish a career-role requirement set' },
};

export function isLegacyHighRiskActionKey(key: HighRiskActionKey): boolean {
  return (legacyHighRiskActionKeys as readonly string[]).includes(key);
}

export function isHighRiskActionKey(value: unknown): value is HighRiskActionKey {
  return typeof value === 'string' && (highRiskActionKeys as readonly string[]).includes(value);
}

/**
 * Why an operator asks for each action (§5.3: each module defines its reason codes in
 * code). The reason is part of the approved payload, so the action runs with it.
 */
export const approvalRequestReasons: Readonly<Record<HighRiskActionKey, readonly string[]>> = {
  ORGANIZATION_SUSPEND: ['POLICY_VIOLATION', 'FRAUD_SUSPECTED', 'CONTRACT_ENDED', 'ORGANISATION_REQUEST'],
  FEATURE_FLAG_HIGH_RISK_CHANGE: ['PILOT_ROLLOUT', 'EVALUATION_COMPLETE', 'INCIDENT_MITIGATION', 'ROLLBACK'],
  OUTBOX_BACKLOG_SUPERSEDE: ['PRE_DISPATCHER_BACKLOG', 'INCIDENT_CLEANUP'],
  PRIVACY_HOLD_RELEASE: ['OBLIGATION_ENDED', 'CASE_CLOSED', 'ENTERED_IN_ERROR'],
  CAPABILITY_GRANT_HIGH_RISK: internalCapabilityGrantReasons,
  CAREER_REQUIREMENT_SET_PUBLISH: careerPublishReasons,
};

/** Hours from request to expiry; one window covers deciding and executing. */
export const approvalWindowHours = 24;
/** Minutes the sole approver must wait before approving their own request. */
export const soloCoolingOffMinutes = 15;

/** Why an approver approves or rejects (§5.3: defined in code, not free text). */
export const approvalDecisionReasons = {
  APPROVE: ['VERIFIED_NEED', 'POLICY_REQUIREMENT', 'INCIDENT_RESPONSE', 'CUSTOMER_REQUEST'],
  REJECT: ['INSUFFICIENT_JUSTIFICATION', 'WRONG_TARGET', 'NOT_NEEDED', 'NEEDS_MORE_INFORMATION'],
} as const;

export type ApprovalDecision = keyof typeof approvalDecisionReasons;

/**
 * A feature flag change is high-risk when the flag is marked and the change goes in the
 * marked direction: ENABLE for AI features, DISABLE for safety controls and kill switches.
 */
export function isHighRiskFlagChange(highRiskDirection: string | null | undefined, enabled: boolean): boolean {
  return (highRiskDirection === 'ENABLE' && enabled) || (highRiskDirection === 'DISABLE' && !enabled);
}

/** Only a transition to SUSPENDED leaves VERIFIED: suspend or un-verify (§5.4). */
export function isHighRiskVerificationTransition(toState: string): boolean {
  return toState === 'SUSPENDED';
}

export type ApprovalRefusal =
  | 'FORBIDDEN'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_NOT_PENDING'
  | 'APPROVAL_NOT_APPROVED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_PAYLOAD_MISMATCH'
  | 'APPROVAL_NOT_REQUESTER'
  | 'APPROVAL_SELF_DECISION_REFUSED'
  | 'APPROVAL_SOLO_COOLING_OFF'
  | 'APPROVAL_SUBJECT_CONFLICT';

type Actor = InternalCapabilityContext & { readonly userId: string };

/** Requesting needs the capability the action itself needs. */
export function refuseApprovalRequest(actor: Actor, actionKey: HighRiskActionKey): ApprovalRefusal | null {
  return hasInternalCapability(actor, highRiskActions[actionKey].capability) ? null : 'FORBIDDEN';
}

export interface ApprovalDecisionInput {
  readonly actor: Actor;
  readonly decision: ApprovalDecision;
  readonly approval: {
    readonly state: string;
    readonly requestedByUserId: string;
    /** Whether the database clock has passed `expires_at`. */
    readonly expired: boolean;
    /** Whether the database clock is at least 15 minutes past `requested_at`. */
    readonly coolingOffElapsed: boolean;
    /** For a capability grant: the user who would receive it. */
    readonly subjectUserId?: string | null;
  };
  /** Live count of people holding APPROVE_HIGH_RISK. */
  readonly approverCount: number;
}

/**
 * Whether a decision may be recorded, and if so whether it is a solo approval. The
 * approver is never the requester, except the sole approver approving their own request
 * after the cooling-off; the safeguard switches itself off once a second approver exists.
 */
export function decideApproval(input: ApprovalDecisionInput): { readonly refusal: ApprovalRefusal } | { readonly solo: boolean } {
  if (!hasInternalCapability(input.actor, 'APPROVE_HIGH_RISK')) return { refusal: 'FORBIDDEN' };
  if (input.approval.state !== 'PENDING') return { refusal: 'APPROVAL_NOT_PENDING' };
  if (input.approval.expired) return { refusal: 'APPROVAL_EXPIRED' };
  if (input.approval.subjectUserId && input.approval.subjectUserId === input.actor.userId) return { refusal: 'APPROVAL_SUBJECT_CONFLICT' };
  if (input.approval.requestedByUserId !== input.actor.userId) return { solo: false };
  if (input.decision !== 'APPROVE' || input.approverCount !== 1) return { refusal: 'APPROVAL_SELF_DECISION_REFUSED' };
  if (!input.approval.coolingOffElapsed) return { refusal: 'APPROVAL_SOLO_COOLING_OFF' };
  return { solo: true };
}

export interface ApprovalExecutionInput {
  readonly executorUserId: string;
  readonly actionKey: HighRiskActionKey;
  readonly payloadHash: string;
  readonly approval: {
    readonly state: string;
    readonly actionKey: string;
    readonly payloadHash: string;
    readonly requestedByUserId: string;
    readonly expired: boolean;
  } | null;
}

/** Whether an approval may be consumed by this execution. */
export function refuseApprovalExecution(input: ApprovalExecutionInput): ApprovalRefusal | null {
  if (!input.approval) return 'APPROVAL_NOT_FOUND';
  if (input.approval.requestedByUserId !== input.executorUserId) return 'APPROVAL_NOT_REQUESTER';
  if (input.approval.state !== 'APPROVED') return 'APPROVAL_NOT_APPROVED';
  if (input.approval.expired) return 'APPROVAL_EXPIRED';
  if (input.approval.actionKey !== input.actionKey || input.approval.payloadHash !== input.payloadHash) return 'APPROVAL_PAYLOAD_MISMATCH';
  return null;
}
