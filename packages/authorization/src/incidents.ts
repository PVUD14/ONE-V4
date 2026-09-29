/**
 * Incident register, breach clock and status notice rules (OPS-16, Appendix 1 §3 Security and
 * Communications, §5.3).
 *
 * The incident vocabularies and state machine, the reason codes each write may carry, the breach
 * clock period, the status-notice rate limit and audience, and the personal-data refusal for
 * free text — declared once, as data and pure functions, so the API, the web screens and the 0081
 * triggers agree. The capability checks are `hasInternalCapability` (INCIDENT_MANAGE,
 * COMMS_TEMPLATES); nothing here names a platform role.
 *
 * The 72-hour period is the ONE plan's, pending legal confirmation. It is not presented as settled
 * law anywhere: the basis travels with the value.
 *
 * Design: docs/architecture/incident-register-table-design.md
 */

export const incidentCategories = ['PERSONAL_DATA_BREACH', 'SECURITY', 'SERVICE_OUTAGE', 'DEGRADED_SERVICE', 'DATA_INTEGRITY', 'OTHER'] as const;
export type IncidentCategory = (typeof incidentCategories)[number];

export const incidentSeverities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof incidentSeverities)[number];

export const incidentStates = ['OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED'] as const;
export type IncidentState = (typeof incidentStates)[number];

/**
 * Hours from `detected_at` to the Board reporting deadline for a personal data breach. Stamped on
 * each breach by the 0081 trigger (which repeats this number), so changing it later never moves a
 * running deadline.
 */
export const breachBoardClockHours = 72;
/** Where the period comes from. Shown next to the clock on every screen. */
export const breachClockBasis = 'PLAN_PENDING_LEGAL_CONFIRMATION' as const;
export const breachClockBasisText =
  'The 72-hour period comes from the ONE plan and is pending legal confirmation. ONE never contacts the Data Protection Board itself: a person reports, and records it here.';

/** The state machine. `OPEN → CLOSED` is only for a duplicate or a false alarm. */
export const incidentTransitions: Readonly<Record<IncidentState, readonly IncidentState[]>> = {
  OPEN: ['CONTAINED', 'RESOLVED', 'CLOSED'],
  CONTAINED: ['OPEN', 'RESOLVED'],
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: [],
};

/** §5.3: reason codes are defined in code, per write. */
export const incidentDeclareReasons = ['MONITORING_ALERT', 'CUSTOMER_REPORT', 'INTERNAL_DISCOVERY', 'THIRD_PARTY_REPORT', 'SUSPECTED_BREACH'] as const;

/** Reasons for moving an incident into each state; `OPEN` is a reopen. */
export const incidentTransitionReasons: Readonly<Record<IncidentState, readonly string[]>> = {
  OPEN: ['RECURRENCE', 'CONTAINMENT_FAILED', 'NEW_EVIDENCE'],
  CONTAINED: ['ACCESS_PATH_CLOSED', 'CREDENTIAL_ROTATED', 'SERVICE_ISOLATED', 'MITIGATION_APPLIED'],
  RESOLVED: ['ROOT_CAUSE_FIXED', 'SERVICE_RESTORED', 'DATA_RESTORED', 'NO_IMPACT_CONFIRMED'],
  CLOSED: ['POST_INCIDENT_REVIEW_DONE', 'DUPLICATE', 'FALSE_ALARM'],
};

/** The only reasons that close an incident straight from OPEN. */
export const incidentCloseFromOpenReasons = ['DUPLICATE', 'FALSE_ALARM'] as const;

export const incidentSeverityReasons = ['ASSESSMENT_UPDATED', 'SCOPE_GREW', 'SCOPE_REDUCED'] as const;
export const incidentCategoryReasons = ['ASSESSMENT_UPDATED', 'CONFIRMED_PERSONAL_DATA', 'NO_PERSONAL_DATA_INVOLVED'] as const;
export const incidentNoteReasons = ['TIMELINE_UPDATE', 'EVIDENCE_RECORDED', 'DECISION_RECORDED'] as const;
export const incidentOrganizationAddReasons = ['SCOPE_ASSESSED', 'NEW_EVIDENCE'] as const;
export const incidentOrganizationRemoveReasons = ['SCOPE_ASSESSED', 'ENTERED_IN_ERROR'] as const;
export const incidentBoardNotifiedReasons = ['BOARD_REPORT_FILED'] as const;
export const incidentUsersNotifiedReasons = ['USERS_NOTIFIED_BY_EMAIL', 'USERS_NOTIFIED_BY_COLLEGE', 'USERS_NOTIFIED_OTHER_CHANNEL'] as const;

export const commsTemplateDraftReasons = ['NEW_TEMPLATE', 'WORDING_UPDATE', 'CORRECTION'] as const;
export const commsTemplateWithdrawReasons = ['SUPERSEDED', 'ENTERED_IN_ERROR', 'NOT_NEEDED'] as const;
/** Why a template version is put to an approver; also the reason recorded when it is published. */
export const commsTemplatePublishReasons = ['INCIDENT_COMMUNICATION', 'PLANNED_COMMUNICATION', 'WORDING_CORRECTION'] as const;

export const statusNoticeDraftReasons = ['INITIAL_NOTICE', 'INCIDENT_UPDATE', 'RESOLUTION_NOTICE'] as const;
export const statusNoticeApproveReasons = ['APPROVED_FOR_SEND'] as const;
export const statusNoticeWithdrawReasons = ['NOT_NEEDED', 'WRONG_TEMPLATE', 'SUPERSEDED'] as const;

/** Rate limit on approving notices for one incident, on the database clock (the 0081 trigger repeats it). */
export const statusNoticeMinimumSpacingMinutes = 15;
export const statusNoticeDailyLimit = 6;

/** Who receives a status notice: administrators of an affected college or employer. Never a student. */
export const statusNoticeAudienceRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'EMPLOYER_OWNER', 'EMPLOYER_ADMIN'] as const;

/** The notification_templates stable key of a status notice template. */
export function statusNoticeStableKey(templateKey: string): string {
  return `status-notice.${templateKey}`;
}
export const statusNoticeTemplateKeyPattern = /^[a-z][a-z0-9-]{2,48}$/;

export function isIncidentState(value: unknown): value is IncidentState {
  return typeof value === 'string' && (incidentStates as readonly string[]).includes(value);
}

export type IncidentTransitionRefusal =
  | 'INCIDENT_TRANSITION_NOT_ALLOWED'
  | 'REASON_CODE_INVALID'
  | 'INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING';

/**
 * Whether an incident may move from one state to another with this reason, or why not. A breach
 * cannot close before the Board and the affected users are recorded as notified.
 */
export function refuseIncidentTransition(input: {
  readonly from: IncidentState;
  readonly to: IncidentState;
  readonly reasonCode: string;
  readonly category: IncidentCategory;
  readonly boardNotified: boolean;
  readonly usersNotified: boolean;
}): IncidentTransitionRefusal | null {
  if (!incidentTransitions[input.from].includes(input.to)) return 'INCIDENT_TRANSITION_NOT_ALLOWED';
  if (!incidentTransitionReasons[input.to].includes(input.reasonCode)) return 'REASON_CODE_INVALID';
  if (input.from === 'OPEN' && input.to === 'CLOSED' && !(incidentCloseFromOpenReasons as readonly string[]).includes(input.reasonCode)) {
    return 'REASON_CODE_INVALID';
  }
  if (input.to === 'CLOSED' && input.category === 'PERSONAL_DATA_BREACH' && (!input.boardNotified || !input.usersNotified)) {
    return 'INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING';
  }
  return null;
}

/** A breach that anyone was told about stays a breach: the record of the notification depends on it. */
export function refuseIncidentReclassification(input: {
  readonly from: IncidentCategory;
  readonly to: IncidentCategory;
  readonly state: IncidentState;
  readonly boardNotified: boolean;
  readonly usersNotified: boolean;
}): 'INCIDENT_CATEGORY_UNCHANGED' | 'INCIDENT_CLOSED' | 'INCIDENT_BREACH_ALREADY_NOTIFIED' | null {
  if (input.state === 'CLOSED') return 'INCIDENT_CLOSED';
  if (input.from === input.to) return 'INCIDENT_CATEGORY_UNCHANGED';
  if (input.from === 'PERSONAL_DATA_BREACH' && (input.boardNotified || input.usersNotified)) return 'INCIDENT_BREACH_ALREADY_NOTIFIED';
  return null;
}

export type BreachClockStatus = 'RUNNING' | 'OVERDUE' | 'MET' | 'MET_LATE';

/**
 * The state of a breach's Board clock, from facts the database computed on its own clock:
 * whether the Board was notified, whether that was within the period, and whether the deadline
 * has passed.
 */
export function classifyBreachClock(input: {
  readonly boardNotified: boolean;
  readonly notifiedWithinPeriod: boolean;
  readonly deadlinePassed: boolean;
}): BreachClockStatus {
  if (input.boardNotified) return input.notifiedWithinPeriod ? 'MET' : 'MET_LATE';
  return input.deadlinePassed ? 'OVERDUE' : 'RUNNING';
}

/**
 * Titles, summaries and notes carry no contact details (§5.5, "no personal data in incident
 * titles and summaries beyond what's needed"): an email address or a run of ten or more digits,
 * optionally split by single spaces (a phone number), is refused. Dates written with dashes pass. Names cannot be detected reliably; the screen asks for none.
 */
export function containsContactDetails(text: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text) || /\+?\d(?: ?\d){9,}/.test(text);
}

export type StatusNoticeRefusal =
  | 'STATUS_NOTICE_INCIDENT_CLOSED'
  | 'STATUS_NOTICE_NO_AUDIENCE'
  | 'STATUS_NOTICE_RATE_LIMITED'
  | 'STATUS_NOTICE_NOT_DRAFT';

/** Whether a drafted notice may be approved for sending now, from facts read under the incident's lock. */
export function refuseStatusNoticeApproval(input: {
  readonly noticeState: string;
  readonly incidentState: IncidentState;
  readonly liveAffectedOrganizations: number;
  readonly approvedInSpacingWindow: number;
  readonly approvedInLastDay: number;
}): StatusNoticeRefusal | null {
  if (input.noticeState !== 'DRAFT') return 'STATUS_NOTICE_NOT_DRAFT';
  if (input.incidentState === 'CLOSED') return 'STATUS_NOTICE_INCIDENT_CLOSED';
  if (input.liveAffectedOrganizations < 1) return 'STATUS_NOTICE_NO_AUDIENCE';
  if (input.approvedInSpacingWindow > 0 || input.approvedInLastDay >= statusNoticeDailyLimit) return 'STATUS_NOTICE_RATE_LIMITED';
  return null;
}

/** Only a template version's author may put it to an approver, so the approver is never its author. */
export function refuseCommsTemplatePublishRequest(input: {
  readonly actorUserId: string;
  readonly authorUserId: string;
  readonly state: string;
}): 'COMMS_TEMPLATE_NOT_DRAFT' | 'COMMS_TEMPLATE_NOT_AUTHOR' | null {
  if (input.state !== 'DRAFT') return 'COMMS_TEMPLATE_NOT_DRAFT';
  if (input.actorUserId !== input.authorUserId) return 'COMMS_TEMPLATE_NOT_AUTHOR';
  return null;
}
