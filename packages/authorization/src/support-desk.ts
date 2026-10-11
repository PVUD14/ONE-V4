/**
 * Support desk rules (OPS-05, Appendix 1 §3 Support, §5.3, §5.5).
 *
 * The support case state machine, the reason codes each operator write may carry, the
 * SLA target for each severity, and the contact masking the account view applies — all
 * declared once, as data, so the API, the web screen and the 0043 trigger agree. The
 * capability checks themselves are `hasInternalCapability` (SUPPORT_CASES,
 * SUPPORT_ACCOUNT_LOOKUP); nothing here names a role.
 *
 * Design: docs/architecture/support-cases-table-design.md
 */
import { effectiveInternalCapabilities, type InternalCapabilityMembership } from './internal-capabilities.js';

export const supportCaseChannels = ['EMAIL', 'PHONE', 'WHATSAPP', 'IN_APP'] as const;
export type SupportCaseChannel = (typeof supportCaseChannels)[number];

export const supportCaseCategories = [
  'ACCOUNT_ACCESS',
  'INVITATION',
  'ONBOARDING',
  'DATA_CORRECTION',
  'PRIVACY_REQUEST',
  'TECHNICAL_FAULT',
  'HOW_TO',
  'COMPLAINT',
  'OTHER',
] as const;
export type SupportCaseCategory = (typeof supportCaseCategories)[number];

export const supportCaseSeverities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type SupportCaseSeverity = (typeof supportCaseSeverities)[number];

export const supportCaseStates = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;
export type SupportCaseState = (typeof supportCaseStates)[number];

/** Calendar hours from opening to the resolution target. Mirrored by the 0043 trigger. */
export const supportCaseSlaHours: Readonly<Record<SupportCaseSeverity, number>> = {
  URGENT: 4,
  HIGH: 24,
  MEDIUM: 72,
  LOW: 120,
};

/**
 * The state machine. `OPEN → CLOSED` is for a duplicate or misdirected contact and
 * `WAITING_ON_CUSTOMER → CLOSED` for a customer who never replied; everything else is
 * resolved first, so a closed case with a resolution time was fixed and one without was not.
 */
export const supportCaseTransitions: Readonly<Record<SupportCaseState, readonly SupportCaseState[]>> = {
  OPEN: ['IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_ON_CUSTOMER', 'RESOLVED'],
  WAITING_ON_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

/** §5.3: reason codes are defined in code, per write. */
export const supportCaseOpenReasons = ['CUSTOMER_CONTACT', 'OPERATOR_FOLLOW_UP', 'INSTITUTION_ESCALATION', 'MONITORING_ALERT'] as const;

/** Reasons for moving a case into each state. */
export const supportCaseTransitionReasons: Readonly<Record<Exclude<SupportCaseState, 'OPEN'>, readonly string[]>> = {
  IN_PROGRESS: ['WORK_STARTED', 'CUSTOMER_REPLIED', 'REOPENED_NOT_FIXED'],
  WAITING_ON_CUSTOMER: ['INFORMATION_REQUESTED', 'CONFIRMATION_REQUESTED'],
  RESOLVED: ['FIXED', 'ANSWERED', 'NO_FAULT_FOUND', 'REFERRED_ELSEWHERE'],
  CLOSED: ['CONFIRMED_WITH_CUSTOMER', 'NO_RESPONSE', 'DUPLICATE', 'MISDIRECTED'],
};

export const supportCaseNoteReasons = ['CASE_UPDATE', 'CUSTOMER_CONTACT', 'INTERNAL_FINDING'] as const;
export const supportCaseAssignReasons = ['TAKE_OWNERSHIP', 'REBALANCE', 'ESCALATION', 'CORRECTION'] as const;

/** Why an operator needs the full contact value; the reveal is audited with this code. */
export const supportContactRevealReasons = ['ACCOUNT_RECOVERY', 'IDENTITY_VERIFICATION', 'CUSTOMER_CALLBACK', 'PRIVACY_REQUEST'] as const;

export function isSupportCaseState(value: unknown): value is SupportCaseState {
  return typeof value === 'string' && (supportCaseStates as readonly string[]).includes(value);
}

export type SupportCaseTransitionRefusal = 'SUPPORT_CASE_TRANSITION_NOT_ALLOWED' | 'REASON_CODE_INVALID';

/** Whether a case may move from one state to another with this reason, or why not. */
export function refuseSupportCaseTransition(from: SupportCaseState, to: SupportCaseState, reasonCode: string): SupportCaseTransitionRefusal | null {
  if (!supportCaseTransitions[from].includes(to)) return 'SUPPORT_CASE_TRANSITION_NOT_ALLOWED';
  if (to === 'OPEN' || !supportCaseTransitionReasons[to].includes(reasonCode)) return 'REASON_CODE_INVALID';
  return null;
}

/**
 * Whether a person may be assigned a case: they must hold SUPPORT_CASES through an
 * ACTIVE membership, by baseline or by a grant valid for the membership's role.
 */
export function isEligibleSupportAssignee(memberships: readonly InternalCapabilityMembership[]): boolean {
  return memberships.some((membership) => membership.state === 'ACTIVE'
    && effectiveInternalCapabilities(membership.role, membership.grants ?? []).includes('SUPPORT_CASES'));
}

// ---------------------------------------------------------------------------
// Data minimisation (§5.5)
// ---------------------------------------------------------------------------

/**
 * `a***@college.edu`: the first character of the local part and the whole domain, which
 * is enough to confirm "is this the address you signed up with?" on a call without
 * reading the address out. Anything that is not an address masks completely.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (email === null || email === undefined) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** The last four digits only; fewer than four digits masks completely. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}
