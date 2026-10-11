export type DataClassification = 'public' | 'internal' | 'confidential' | 'highly_restricted';

export interface IntegrationEventEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly producer: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion?: number;
  readonly organizationId?: string;
  readonly subjectId?: string;
  readonly actorId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly purpose: string;
  readonly dataClassification: DataClassification;
  readonly schemaRef: string;
  readonly expiresAt?: string;
  readonly payload: TPayload;
}

export interface EventSchemaDefinition {
  readonly eventType: string;
  readonly eventVersion: number;
  readonly producer: string;
  readonly aggregateType: string;
  readonly purpose: string;
  readonly dataClassification: DataClassification;
  readonly schemaRef: string;
  readonly payload: Readonly<Record<string, PayloadFieldDefinition>>;
}

export type PayloadFieldDefinition =
  | { readonly kind: 'uuid'; readonly required?: boolean }
  | { readonly kind: 'string'; readonly minLength?: number; readonly maxLength: number; readonly pattern?: RegExp; readonly required?: boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly required?: boolean };

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rfc3339UtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const correlationIdPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const prohibitedPayloadKeys = [
  /^email$/i,
  /^raw[A-Z_ -]?email$/i,
  /^password$/i,
  /^token$/i,
  /^credential(s)?$/i,
  /^secret$/i,
  /^resume(Text|Content)?$/i,
  /^document(Content|Text|Body)?$/i,
  /^answer(Text|Content|Body|Key)?$/i,
  /^prompt$/i,
  /^conversation$/i,
  /^stack$/i,
  /^snapshot$/i,
];

const organizationRoles = [
  'PLATFORM_SUPER_ADMIN',
  'OPERATIONS_ADMIN',
  'SECURITY_ADMIN',
  'INSTITUTION_OWNER',
  'INSTITUTION_ADMIN',
  'PLACEMENT_ADMIN',
  'DEPARTMENT_HEAD',
  'FACULTY_LECTURER',
  'EMPLOYER_OWNER',
  'EMPLOYER_ADMIN',
  'RECRUITER',
  // GROWTH-01 (ADR-040): growth field staff are platform memberships; an access review or the
  // Growth team section may end or suspend one, and the event must be able to name the role.
  'GROWTH_EXECUTIVE',
  'GROWTH_MANAGER',
] as const;

const growthTeams = ['COLLEGE_PARTNERSHIPS', 'EMPLOYER_PARTNERSHIPS'] as const;
const growthStaffTypes = ['EMPLOYEE', 'CONTRACTOR'] as const;

// OPS-02: kept in step with highRiskActionKeys in packages/authorization and the 0038 CHECK.
const operationApprovalActionKeys = [
  'ORGANIZATION_SUSPEND',
  'FEATURE_FLAG_HIGH_RISK_CHANGE',
  'OUTBOX_BACKLOG_SUPERSEDE',
  'PRIVACY_HOLD_RELEASE',
  'CAPABILITY_GRANT_HIGH_RISK',
  // OPS-08: stored in operation_approvals.extended_action_key (0051), not 0038's CHECK.
  'CAREER_REQUIREMENT_SET_PUBLISH',
  // OPS-09a: extended key as well (0057).
  'CONTENT_SKILL_PUBLISH',
  // OPS-09b: extended key as well (0061).
  'CONTENT_QUESTION_PUBLISH',
  // OPS-09c: extended key as well (0065).
  'CONTENT_LESSON_PUBLISH',
  // OPS-16: extended key as well (0081).
  'COMMS_TEMPLATE_PUBLISH',
  // OPS-12: extended keys as well (0089).
  'AI_FEATURE_ENABLE',
  'AI_FEATURE_LIMITS_RAISE',
  // INST-18: extended key as well (0088) — deleting a departed college's records.
  'INSTITUTION_DATA_PURGE',
  // ENG-25: extended key as well (0116) — switching the AI tutor on for one college.
  'AI_TUTOR_COLLEGE_ENABLE',
] as const;

// EMP-05: opportunities.lifecycle_state (0007 CHECK).
const opportunityLifecycleStates = ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'PAUSED', 'CLOSED', 'WITHDRAWN', 'ARCHIVED'] as const;

// OPS-08: requirement-set lifecycle states (0051).
const careerRequirementSetStates = ['DRAFT', 'IN_REVIEW', 'REVIEWED', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'] as const;

// OPS-09a: the 0004 content-revision lifecycle, as a skill revision moves through it. ARCHIVED is
// the last step (0090, content-archive-design.md): an additive value, and these events have no consumer.
const skillRevisionStates = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'ARCHIVED'] as const;

// EMP-08: applications.state (0007 CHECK).
const applicationStates = ['DRAFT', 'APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'] as const;

// EMP-11: campus_drives.state (0069 CHECK).
const campusDriveStates = ['REQUESTED', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'REJECTED', 'COMPLETED', 'CANCELLED'] as const;

export const eventSchemas = {
  identityInvitationAcceptedV1: {
    eventType: 'identity.invitation.accepted',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'user',
    purpose: 'identity-invitation-acceptance',
    dataClassification: 'confidential',
    schemaRef: 'registry://identity.invitation.accepted/1',
    payload: { userId: { kind: 'uuid' }, invitationId: { kind: 'uuid' } },
  },
  identityUserProvisionedV1: {
    eventType: 'identity.user.provisioned',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'user',
    purpose: 'identity-user-provisioning',
    dataClassification: 'confidential',
    schemaRef: 'registry://identity.user.provisioned/1',
    payload: { userId: { kind: 'uuid' } },
  },
  identityInvitationCreatedV1: {
    eventType: 'identity.invitation.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'invitation',
    purpose: 'identity-invitation-creation',
    dataClassification: 'confidential',
    schemaRef: 'registry://identity.invitation.created/1',
    payload: { invitationId: { kind: 'uuid' } },
  },
  // EMP-02: an employer owner or admin withdrew a pending team invitation. No consumer yet;
  // the outbox row is the durable record next to the audit event.
  identityInvitationRevokedV1: {
    eventType: 'identity.invitation.revoked',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'invitation',
    purpose: 'identity-invitation-revocation',
    dataClassification: 'confidential',
    schemaRef: 'registry://identity.invitation.revoked/1',
    payload: { invitationId: { kind: 'uuid' } },
  },
  // INST-01: one per rostered student; the outbox worker sends the invitation email.
  studentInvitationRequestedV1: {
    eventType: 'institution.student.invitation.requested',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'invitation',
    purpose: 'student-invitation-delivery',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.student.invitation.requested/1',
    payload: { invitationId: { kind: 'uuid' } },
  },
  // INST-06: one per announcement, available at its scheduled time; the worker sends it once.
  institutionAnnouncementDispatchRequestedV1: {
    eventType: 'institution.announcement.dispatch.requested',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_announcement',
    purpose: 'institution-announcement-dispatch',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.announcement.dispatch.requested/1',
    payload: { announcementId: { kind: 'uuid' } },
  },
  organizationCreatedV1: {
    eventType: 'organization.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization',
    purpose: 'organization-creation',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization.created/1',
    payload: { organizationId: { kind: 'uuid' }, kind: { kind: 'enum', values: ['INSTITUTION', 'EMPLOYER', 'PLATFORM'] } },
  },
  organizationUpdatedV1: {
    eventType: 'organization.updated',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization',
    purpose: 'organization-profile-maintenance',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization.updated/1',
    payload: { organizationId: { kind: 'uuid' } },
  },
  organizationVerificationTransitionedV1: {
    eventType: 'organization.verification_transitioned',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization',
    purpose: 'organization-verification-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization.verification_transitioned/1',
    payload: {
      organizationId: { kind: 'uuid' },
      toState: { kind: 'enum', values: ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED'] },
    },
  },
  // EMP-04: an employer owner or admin changed the student-facing company profile (about,
  // industry, size band, careers page).
  organizationCompanyProfileUpdatedV1: {
    eventType: 'organization.company_profile.updated',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization',
    purpose: 'employer-company-profile-maintenance',
    dataClassification: 'internal',
    schemaRef: 'registry://organization.company_profile.updated/1',
    payload: { organizationId: { kind: 'uuid' } },
  },
  // EMP-04: someone asked, through the public form, for their company to join ONE as an
  // employer. Anonymous, so there is no actor; the payload carries only the request id —
  // never the name or email — and Operations reads the rest from the queue.
  employerAccessRequestSubmittedV1: {
    eventType: 'employer_access_request.submitted',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'employer_access_request',
    purpose: 'employer-access-request-intake',
    dataClassification: 'confidential',
    schemaRef: 'registry://employer_access_request.submitted/1',
    payload: { requestId: { kind: 'uuid' } },
  },
  opportunityPausedV1: {
    eventType: 'opportunity.paused',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'opportunity',
    purpose: 'opportunity-paused-by-organization-state',
    dataClassification: 'confidential',
    schemaRef: 'registry://opportunity.paused/1',
    payload: {
      opportunityId: { kind: 'uuid' },
      employerId: { kind: 'uuid' },
      cause: { kind: 'enum', values: ['ORGANIZATION_SUSPENDED'] },
    },
  },
  // EMP-05: an employer saved a new version of a job. `change` says whether the terms an
  // applicant applied under moved (MATERIAL) or only the wording (EDITORIAL).
  opportunityVersionCreatedV1: {
    eventType: 'opportunity.version.created',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'opportunity',
    purpose: 'opportunity-versioning',
    dataClassification: 'confidential',
    schemaRef: 'registry://opportunity.version.created/1',
    payload: {
      opportunityId: { kind: 'uuid' },
      employerId: { kind: 'uuid' },
      versionId: { kind: 'uuid' },
      change: { kind: 'enum', values: ['EDITORIAL', 'MATERIAL'] },
    },
  },
  // EMP-05: pause, close, reopen and withdraw by the employer, and the deadline job's close.
  opportunityLifecycleChangedV1: {
    eventType: 'opportunity.lifecycle.changed',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'opportunity',
    purpose: 'opportunity-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://opportunity.lifecycle.changed/1',
    payload: {
      opportunityId: { kind: 'uuid' },
      employerId: { kind: 'uuid' },
      fromState: { kind: 'enum', values: opportunityLifecycleStates },
      toState: { kind: 'enum', values: opportunityLifecycleStates },
      trigger: { kind: 'enum', values: ['EMPLOYER', 'DEADLINE'] },
      reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_:-]{3,64}$/, required: false },
    },
  },
  // EMP-05: asks the deadline job to close a job when its current version's deadline passes.
  // available_at is the deadline; a newer version with another deadline makes it a no-op.
  opportunityDeadlineCloseRequestedV1: {
    eventType: 'opportunity.deadline_close.requested',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'opportunity',
    purpose: 'opportunity-deadline-close',
    dataClassification: 'internal',
    schemaRef: 'registry://opportunity.deadline_close.requested/1',
    payload: { opportunityId: { kind: 'uuid' }, versionId: { kind: 'uuid' } },
  },
  // EMP-05: an applicant's terms moved under them. Recorded for EMP-08's student
  // notifications; nothing sends it to the student yet.
  // EMP-11: a campus drive changed state (requested, decided, scheduled, cancelled, completed).
  // The outbox row is the durable record; the in-app notice is written by the route after commit.
  campusDriveStateChangedV1: {
    eventType: 'campus_drive.state_changed',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'campus_drive',
    purpose: 'campus-drive-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://campus_drive.state_changed/1',
    payload: {
      campusDriveId: { kind: 'uuid' },
      opportunityId: { kind: 'uuid' },
      employerId: { kind: 'uuid' },
      institutionId: { kind: 'uuid' },
      fromState: { kind: 'enum', values: campusDriveStates, required: false },
      toState: { kind: 'enum', values: campusDriveStates },
      actorSide: { kind: 'enum', values: ['EMPLOYER', 'INSTITUTION'] },
      reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_:-]{3,64}$/, required: false },
    },
  },
  applicationTermsChangeRecordedV1: {
    eventType: 'application.terms_change.recorded',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-terms-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.terms_change.recorded/1',
    payload: {
      applicationId: { kind: 'uuid' },
      opportunityId: { kind: 'uuid' },
      toVersionId: { kind: 'uuid' },
      acknowledgement: { kind: 'enum', values: ['REQUIRED', 'NOT_REQUIRED'] },
    },
  },
  applicationTermsChangeAcknowledgedV1: {
    eventType: 'application.terms_change.acknowledged',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-terms-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.terms_change.acknowledged/1',
    payload: { applicationId: { kind: 'uuid' }, toVersionId: { kind: 'uuid' } },
  },
  // Declining the new terms withdraws the application (the employer loses access).
  applicationTermsChangeDeclinedV1: {
    eventType: 'application.terms_change.declined',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-terms-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.terms_change.declined/1',
    payload: { applicationId: { kind: 'uuid' }, toVersionId: { kind: 'uuid' } },
  },
  // EMP-08: the hiring events students are notified about. The employer and student controllers
  // wrote these long before anything was registered for them, so every one failed schema
  // validation at dispatch; registering them lets the notification consumers receive them.
  applicationScreeningV1: {
    eventType: 'application.screening',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-stage-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.screening/1',
    payload: { applicationId: { kind: 'uuid' }, fromState: { kind: 'enum', values: applicationStates }, toState: { kind: 'enum', values: ['SCREENING'] } },
  },
  applicationShortlistedV1: {
    eventType: 'application.shortlisted',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-stage-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.shortlisted/1',
    payload: { applicationId: { kind: 'uuid' }, fromState: { kind: 'enum', values: applicationStates }, toState: { kind: 'enum', values: ['SHORTLISTED'] } },
  },
  applicationAssessmentV1: {
    eventType: 'application.assessment',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-stage-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.assessment/1',
    payload: { applicationId: { kind: 'uuid' }, fromState: { kind: 'enum', values: applicationStates }, toState: { kind: 'enum', values: ['ASSESSMENT'] } },
  },
  applicationInterviewV1: {
    eventType: 'application.interview',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-stage-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.interview/1',
    payload: { applicationId: { kind: 'uuid' }, fromState: { kind: 'enum', values: applicationStates }, toState: { kind: 'enum', values: ['INTERVIEW'] } },
  },
  applicationOfferV1: {
    eventType: 'application.offer',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-stage-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.offer/1',
    payload: { applicationId: { kind: 'uuid' }, fromState: { kind: 'enum', values: applicationStates }, toState: { kind: 'enum', values: ['OFFER'] } },
  },
  applicationHiredV1: {
    eventType: 'application.hired',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-stage-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.hired/1',
    payload: { applicationId: { kind: 'uuid' }, fromState: { kind: 'enum', values: applicationStates }, toState: { kind: 'enum', values: ['HIRED'] } },
  },
  applicationRejectedV1: {
    eventType: 'application.rejected',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-stage-change',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.rejected/1',
    payload: { applicationId: { kind: 'uuid' }, fromState: { kind: 'enum', values: applicationStates }, toState: { kind: 'enum', values: ['REJECTED'] } },
  },
  interviewScheduledV1: {
    eventType: 'interview.scheduled',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'interview',
    purpose: 'interview-schedule',
    dataClassification: 'confidential',
    schemaRef: 'registry://interview.scheduled/1',
    // EMP-09: the schedule revision this event announces; optional so events written before 0063 still validate.
    payload: { interviewId: { kind: 'uuid' }, applicationId: { kind: 'uuid' }, revisionId: { kind: 'uuid', required: false } },
  },
  // EMP-08: the interview-state route wrote only an audit row; the student needs to hear about
  // a reschedule or a cancellation. COMPLETED and NO_SHOW are recorded and notify nobody.
  interviewStateChangedV1: {
    eventType: 'interview.state_changed',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'interview',
    purpose: 'interview-schedule',
    dataClassification: 'confidential',
    schemaRef: 'registry://interview.state_changed/1',
    payload: { interviewId: { kind: 'uuid' }, toState: { kind: 'enum', values: ['RESCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] }, revisionId: { kind: 'uuid', required: false } },
  },
  offerExtendedV1: {
    eventType: 'offer.extended',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'offer',
    purpose: 'offer-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://offer.extended/1',
    payload: { offerId: { kind: 'uuid' }, applicationId: { kind: 'uuid' } },
  },
  offerWithdrawnV1: {
    eventType: 'offer.withdrawn',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'offer',
    purpose: 'offer-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://offer.withdrawn/1',
    payload: { offerId: { kind: 'uuid' } },
  },
  offerAcceptedV1: {
    eventType: 'offer.accepted',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'offer',
    purpose: 'offer-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://offer.accepted/1',
    payload: { offerId: { kind: 'uuid' }, applicationId: { kind: 'uuid' } },
  },
  offerDeclinedV1: {
    eventType: 'offer.declined',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'offer',
    purpose: 'offer-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://offer.declined/1',
    payload: { offerId: { kind: 'uuid' }, applicationId: { kind: 'uuid' } },
  },
  // EMP-08: queued by the offer.extended consumer, available 24 hours before the offer expires.
  offerExpiryReminderRequestedV1: {
    eventType: 'offer.expiry_reminder.requested',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'offer',
    purpose: 'offer-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://offer.expiry_reminder.requested/1',
    payload: { offerId: { kind: 'uuid' } },
  },
  // EMP-12: an employer sent an applicant a screening test. Written in the invitation transaction;
  // the hiring-notification consumer re-reads the invitation and the grant at consume time.
  employerAssessmentInvitedV1: {
    eventType: 'employer_assessment.invited',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'employer_assessment_invitation',
    purpose: 'employer-assessments',
    dataClassification: 'confidential',
    schemaRef: 'registry://employer_assessment.invited/1',
    payload: { invitationId: { kind: 'uuid' }, applicationId: { kind: 'uuid' }, assessmentId: { kind: 'uuid' } },
  },
  // EMP-10: one message in an application's conversation. The payload never carries the text; the
  // hiring-notification consumer reads the message at consume time and re-checks the grant.
  applicationMessageSentV1: {
    eventType: 'application.message.sent',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'application',
    purpose: 'application-messages',
    dataClassification: 'confidential',
    schemaRef: 'registry://application.message.sent/1',
    payload: { applicationId: { kind: 'uuid' }, messageId: { kind: 'uuid' } },
  },
  // EMP-16: operations published a version of the employer terms (0084). No consumer yet.
  employerTermsPublishedV1: {
    eventType: 'employer.terms.published',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'employer_terms_version',
    purpose: 'employer-terms',
    dataClassification: 'internal',
    schemaRef: 'registry://employer.terms.published/1',
    payload: {
      version: { kind: 'string', minLength: 1, maxLength: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ },
      legalReviewState: { kind: 'enum', values: ['DRAFT_FOR_LEGAL_REVIEW', 'LEGAL_APPROVED'] },
      requiresReacceptance: { kind: 'enum', values: ['YES', 'NO'] },
    },
  },
  // EMP-16: an employer's owner accepted a terms version for the organisation.
  employerTermsAcceptedV1: {
    eventType: 'employer.terms.accepted',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'organization',
    purpose: 'employer-terms',
    dataClassification: 'internal',
    schemaRef: 'registry://employer.terms.accepted/1',
    payload: {
      employerId: { kind: 'uuid' },
      version: { kind: 'string', minLength: 1, maxLength: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ },
    },
  },
  // EMP-16: a statement was added to a trust case about an employer — a summary operations shared,
  // or the employer's response or appeal. Carries no text and nothing about the reporter.
  trustCaseEmployerStatementRecordedV1: {
    eventType: 'trust.case.employer_statement.recorded',
    eventVersion: 1,
    producer: 'trust-safety',
    aggregateType: 'trust_case',
    purpose: 'trust-case-participation',
    dataClassification: 'confidential',
    schemaRef: 'registry://trust.case.employer_statement.recorded/1',
    payload: {
      caseId: { kind: 'uuid' },
      employerId: { kind: 'uuid' },
      kind: { kind: 'enum', values: ['ALLEGATION_SUMMARY', 'DECISION_SUMMARY', 'EMPLOYER_RESPONSE', 'EMPLOYER_APPEAL'] },
    },
  },
  // EMP-16: the daily retention worker ended an applicant-access grant whose expires_at passed.
  employerApplicantAccessExpiredV1: {
    eventType: 'employer_applicant_access.expired',
    eventVersion: 1,
    producer: 'hiring',
    aggregateType: 'employer_applicant_access_grant',
    purpose: 'applicant-access-retention',
    dataClassification: 'confidential',
    schemaRef: 'registry://employer_applicant_access.expired/1',
    payload: {
      grantId: { kind: 'uuid' },
      employerId: { kind: 'uuid' },
      opportunityId: { kind: 'uuid' },
      reasonCode: { kind: 'enum', values: ['GRANT_EXPIRED'] },
    },
  },
  organizationRoleAssignedV1: {
    eventType: 'organization.role.assigned',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization_membership',
    purpose: 'organization-role-assignment',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization.role.assigned/1',
    payload: { membershipId: { kind: 'uuid' }, role: { kind: 'enum', values: organizationRoles, required: false } },
  },
  employerGrantCreatedV1: {
    eventType: 'employer.grant.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'employer_applicant_grant',
    purpose: 'employer-applicant-grant-creation',
    dataClassification: 'confidential',
    schemaRef: 'registry://employer.grant.created/1',
    payload: { opportunityId: { kind: 'uuid' } },
  },
  employerGrantRevokedV1: {
    eventType: 'employer.grant.revoked',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'employer_applicant_grant',
    purpose: 'employer-applicant-grant-revocation',
    dataClassification: 'confidential',
    schemaRef: 'registry://employer.grant.revoked/1',
    payload: { grantId: { kind: 'uuid' } },
  },
  documentReferenceRecordedV1: {
    eventType: 'document.reference.recorded',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'document_reference',
    purpose: 'document-reference-recording',
    dataClassification: 'confidential',
    schemaRef: 'registry://document.reference.recorded/1',
    payload: { documentId: { kind: 'uuid' }, documentVersionId: { kind: 'uuid' } },
  },
  assessmentAnswerSheetRecordedV1: {
    eventType: 'assessment.answer_sheet.recorded',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'answer_sheet',
    purpose: 'assessment-answer-sheet-recording',
    dataClassification: 'confidential',
    schemaRef: 'registry://assessment.answer_sheet.recorded/1',
    payload: { answerSheetId: { kind: 'uuid' } },
  },
  institutionUnitCreatedV1: {
    eventType: 'institution.unit.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_unit',
    purpose: 'institution-unit-creation',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.unit.created/1',
    payload: { unitId: { kind: 'uuid' } },
  },
  institutionUnitUpdatedV1: {
    eventType: 'institution.unit.updated',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_unit',
    purpose: 'institution-unit-maintenance',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.unit.updated/1',
    payload: { unitId: { kind: 'uuid' } },
  },
  institutionRelationshipCreatedV1: {
    eventType: 'institution.relationship.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_relationship',
    purpose: 'institution-relationship-creation',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.relationship.created/1',
    payload: { relationshipId: { kind: 'uuid' } },
  },
  institutionRelationshipEndedV1: {
    eventType: 'institution.relationship.ended',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_relationship',
    purpose: 'institution-relationship-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.relationship.ended/1',
    payload: {
      relationshipId: { kind: 'uuid' },
      state: { kind: 'enum', values: ['ENDED', 'TRANSFERRED', 'GRADUATED', 'REVOKED'] },
    },
  },
  institutionStudentProfileCreatedV1: {
    eventType: 'institution.student_profile.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_student_profile',
    purpose: 'institution-roster-management',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.student_profile.created/1',
    payload: { profileId: { kind: 'uuid' } },
  },
  institutionStudentProfileUpdatedV1: {
    eventType: 'institution.student_profile.updated',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_student_profile',
    purpose: 'institution-roster-management',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.student_profile.updated/1',
    payload: { profileId: { kind: 'uuid' } },
  },
  institutionRosterImportCommittedV1: {
    eventType: 'institution.roster_import.committed',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'student_roster_import',
    purpose: 'institution-roster-import',
    dataClassification: 'confidential',
    schemaRef: 'registry://institution.roster_import.committed/1',
    payload: { importId: { kind: 'uuid' } },
  },
  // EMP-02: an employer owner or admin ended a team member's membership. Access ends on the
  // member's next request because memberships are read per request; this announces it.
  organizationMembershipEndedV1: {
    eventType: 'organization_membership.ended',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization_membership',
    purpose: 'organization-membership-end',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization_membership.ended/1',
    payload: { membershipId: { kind: 'uuid' }, role: { kind: 'enum', values: organizationRoles } },
  },
  organizationMembershipSuspendedV1: {
    eventType: 'organization_membership.suspended',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization_membership',
    purpose: 'organization-membership-suspension',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization_membership.suspended/1',
    payload: { membershipId: { kind: 'uuid' } },
  },
  // OPS-01 (ADR-032): internal capability grants and revocations. No consumer yet; the
  // outbox row is the durable announcement an access review (OPS-15) can follow.
  organizationMembershipCapabilityGrantedV1: {
    eventType: 'organization_membership.capability_granted',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization_membership',
    purpose: 'internal-capability-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization_membership.capability_granted/1',
    payload: { membershipId: { kind: 'uuid' }, capability: { kind: 'string', minLength: 3, maxLength: 64, pattern: /^[A-Z_]+$/ } },
  },
  organizationMembershipCapabilityRevokedV1: {
    eventType: 'organization_membership.capability_revoked',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization_membership',
    purpose: 'internal-capability-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization_membership.capability_revoked/1',
    payload: { membershipId: { kind: 'uuid' }, capability: { kind: 'string', minLength: 3, maxLength: 64, pattern: /^[A-Z_]+$/ } },
  },
  // GROWTH-01 (ADR-040): a growth person joined or left a field team. No consumer yet; the
  // outbox row is the durable announcement later growth goals (lead ownership) can follow.
  growthTeamMemberJoinedV1: {
    eventType: 'growth.team_member.joined',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_team_member',
    purpose: 'growth-team-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.team_member.joined/1',
    payload: { membershipId: { kind: 'uuid' }, team: { kind: 'enum', values: growthTeams } },
  },
  growthTeamMemberLeftV1: {
    eventType: 'growth.team_member.left',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_team_member',
    purpose: 'growth-team-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.team_member.left/1',
    payload: { membershipId: { kind: 'uuid' }, team: { kind: 'enum', values: growthTeams } },
  },
  // GROWTH-01 (D13): a growth person's staff type was set, at acceptance or by a change.
  // Payout batches (GROWTH-12) will read the table; this announces the change.
  growthStaffTypeSetV1: {
    eventType: 'growth.staff_type.set',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_staff_type',
    purpose: 'growth-team-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.staff_type.set/1',
    payload: { membershipId: { kind: 'uuid' }, staffType: { kind: 'enum', values: growthStaffTypes } },
  },
  // GROWTH-02: territory set-up. No consumer yet; identifiers and enums only. Later goals (regional
  // rates and targets) can follow the outbox row.
  growthRegionCreatedV1: {
    eventType: 'growth.region.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_region',
    purpose: 'growth-territory-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.region.created/1',
    payload: { regionId: { kind: 'uuid' }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthRegionRetiredV1: {
    eventType: 'growth.region.retired',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_region',
    purpose: 'growth-territory-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.region.retired/1',
    payload: { regionId: { kind: 'uuid' }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthRegionAreaAddedV1: {
    eventType: 'growth.region_area.added',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_region_area',
    purpose: 'growth-territory-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.region_area.added/1',
    payload: { regionId: { kind: 'uuid' }, stateCode: { kind: 'string', maxLength: 5, minLength: 5, pattern: /^IN-[A-Z]{2}$/ }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthRegionAreaRemovedV1: {
    eventType: 'growth.region_area.removed',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_region_area',
    purpose: 'growth-territory-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.region_area.removed/1',
    payload: { regionId: { kind: 'uuid' }, stateCode: { kind: 'string', maxLength: 5, minLength: 5, pattern: /^IN-[A-Z]{2}$/ }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthTerritoryAssignmentStartedV1: {
    eventType: 'growth.territory_assignment.started',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_territory_assignment',
    purpose: 'growth-territory-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.territory_assignment.started/1',
    payload: { regionId: { kind: 'uuid' }, membershipId: { kind: 'uuid' }, role: { kind: 'enum', values: ['EXECUTIVE', 'MANAGER'] }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthTerritoryAssignmentEndedV1: {
    eventType: 'growth.territory_assignment.ended',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_territory_assignment',
    purpose: 'growth-territory-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.territory_assignment.ended/1',
    payload: { regionId: { kind: 'uuid' }, membershipId: { kind: 'uuid' }, role: { kind: 'enum', values: ['EXECUTIVE', 'MANAGER'] }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthDistrictsImportedV1: {
    eventType: 'growth.districts.imported',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_district_import',
    purpose: 'growth-territory-administration',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.districts.imported/1',
    payload: { importId: { kind: 'uuid' }, reasonCode: { kind: 'enum', values: ['INITIAL_IMPORT', 'LGD_UPDATE', 'CORRECTION'] } },
  },
  // GROWTH-03: the lead register. Identifiers, kinds and reason codes only — never an organisation's
  // name or a contact's details (contacts are people who are not ONE users).
  growthLeadCreatedV1: {
    eventType: 'growth.lead.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_lead',
    purpose: 'growth-lead-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.lead.created/1',
    payload: { leadId: { kind: 'uuid' }, kind: { kind: 'enum', values: ['COLLEGE', 'EMPLOYER'] } },
  },
  growthLeadClaimedV1: {
    eventType: 'growth.lead.claimed',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_lead',
    purpose: 'growth-lead-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.lead.claimed/1',
    payload: { leadId: { kind: 'uuid' }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthLeadReassignedV1: {
    eventType: 'growth.lead.reassigned',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_lead',
    purpose: 'growth-lead-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.lead.reassigned/1',
    payload: { leadId: { kind: 'uuid' }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthLeadDoNotContactSetV1: {
    eventType: 'growth.lead.do_not_contact_set',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_lead',
    purpose: 'growth-lead-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.lead.do_not_contact_set/1',
    payload: { leadId: { kind: 'uuid' }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  growthLeadContactAddedV1: {
    eventType: 'growth.lead_contact.added',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_lead_contact',
    purpose: 'growth-lead-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.lead_contact.added/1',
    payload: { leadId: { kind: 'uuid' }, contactId: { kind: 'uuid' } },
  },
  growthLeadContactRemovedV1: {
    eventType: 'growth.lead_contact.removed',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_lead_contact',
    purpose: 'growth-lead-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.lead_contact.removed/1',
    payload: { leadId: { kind: 'uuid' }, contactId: { kind: 'uuid' }, reasonCode: { kind: 'string', maxLength: 64, minLength: 3, pattern: /^[A-Z0-9_]{3,64}$/ } },
  },
  // GROWTH-04: the college pipeline and the operations handoff. Identifiers, stages and reason codes
  // only — never a contract reference, an organisation's name or a contact.
  growthLeadStageMovedV1: {
    eventType: 'growth.lead.stage_moved',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_lead',
    purpose: 'growth-lead-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.lead.stage_moved/1',
    payload: { leadId: { kind: 'uuid' }, toStage: { kind: 'string', maxLength: 40, minLength: 3, pattern: /^[A-Z_]{3,40}$/ } },
  },
  growthHandoffRequestedV1: {
    eventType: 'growth.handoff.requested',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_handoff_request',
    purpose: 'growth-college-handoff',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.handoff.requested/1',
    payload: { requestId: { kind: 'uuid' }, leadId: { kind: 'uuid' } },
  },
  growthLeadHandedOffV1: {
    eventType: 'growth.lead.handed_off',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_lead',
    purpose: 'growth-college-handoff',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.lead.handed_off/1',
    payload: { leadId: { kind: 'uuid' }, organizationId: { kind: 'uuid' } },
  },
  growthHandoffDeclinedV1: {
    eventType: 'growth.handoff.declined',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_handoff_request',
    purpose: 'growth-college-handoff',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.handoff.declined/1',
    payload: {
      requestId: { kind: 'uuid' }, leadId: { kind: 'uuid' },
      reasonCode: { kind: 'enum', values: ['NOT_A_REAL_COLLEGE', 'DUPLICATE_OF_EXISTING', 'INCOMPLETE', 'CONTRACT_NOT_CONFIRMED'] },
    },
  },
  // GROWTH-05: the employer pipeline. Identifiers and enums only — never a referral code, a name,
  // an email or a domain. `growth.referral.recorded` is written by the public form, so it has no actor.
  growthReferralCodeCreatedV1: {
    eventType: 'growth.referral_code.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_referral_code',
    purpose: 'growth-employer-referrals',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.referral_code.created/1',
    payload: { referralCodeId: { kind: 'uuid' } },
  },
  growthReferralCodeRevokedV1: {
    eventType: 'growth.referral_code.revoked',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_referral_code',
    purpose: 'growth-employer-referrals',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.referral_code.revoked/1',
    payload: { referralCodeId: { kind: 'uuid' }, reasonCode: { kind: 'enum', values: ['OWNER_REVOKED'] } },
  },
  growthReferralRecordedV1: {
    eventType: 'growth.referral.recorded',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'employer_access_request',
    purpose: 'growth-employer-referrals',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.referral.recorded/1',
    payload: { requestId: { kind: 'uuid' }, referralCodeId: { kind: 'uuid' } },
  },
  growthEmployerLeadLinkedV1: {
    eventType: 'growth.employer_lead.linked',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'employer_access_request',
    purpose: 'growth-employer-handoff',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.employer_lead.linked/1',
    payload: { requestId: { kind: 'uuid' }, leadId: { kind: 'uuid' } },
  },
  growthEmployerLeadUnlinkedV1: {
    eventType: 'growth.employer_lead.unlinked',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'employer_access_request',
    purpose: 'growth-employer-handoff',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.employer_lead.unlinked/1',
    payload: { requestId: { kind: 'uuid' }, leadId: { kind: 'uuid' } },
  },
  growthEmployerOnboardedV1: {
    eventType: 'growth.employer.onboarded',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_employer_onboarding',
    purpose: 'growth-employer-handoff',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.employer.onboarded/1',
    payload: {
      requestId: { kind: 'uuid' }, organizationId: { kind: 'uuid' },
      candidateBasis: { kind: 'enum', values: ['REFERRAL_LINK', 'LEAD_OWNER_AT_HANDOFF', 'CONFLICT', 'HOUSE'] },
    },
  },
  // GROWTH-07: attribution and disputes. Identifiers, enums and reason codes only — never a
  // statement, a name or an email. The ledger (GROWTH-11) follows these to move unpaid accruals.
  growthAttributionCreatedV1: {
    eventType: 'growth.attribution.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_attribution',
    purpose: 'growth-attribution',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.attribution.created/1',
    payload: {
      attributionId: { kind: 'uuid' }, organizationId: { kind: 'uuid' },
      basis: { kind: 'enum', values: ['LEAD_OWNER_AT_HANDOFF', 'REFERRAL_LINK', 'DISPUTE_DECISION', 'MANUAL_CORRECTION'] },
    },
  },
  growthAttributionEndedV1: {
    eventType: 'growth.attribution.ended',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_attribution',
    purpose: 'growth-attribution',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.attribution.ended/1',
    payload: {
      attributionId: { kind: 'uuid' }, organizationId: { kind: 'uuid' },
      reasonCode: { kind: 'enum', values: ['REASSIGNED', 'DISPUTE_DECISION', 'CORRECTION', 'ORGANIZATION_EXITED'] },
    },
  },
  growthAttributionDisputeOpenedV1: {
    eventType: 'growth.attribution_dispute.opened',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_attribution_dispute',
    purpose: 'growth-attribution',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.attribution_dispute.opened/1',
    payload: { disputeId: { kind: 'uuid' }, organizationId: { kind: 'uuid' }, origin: { kind: 'enum', values: ['CLAIM', 'ONBOARDING_CONFLICT'] } },
  },
  growthAttributionDisputeDecidedV1: {
    eventType: 'growth.attribution_dispute.decided',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_attribution_dispute',
    purpose: 'growth-attribution',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.attribution_dispute.decided/1',
    payload: {
      disputeId: { kind: 'uuid' }, organizationId: { kind: 'uuid' },
      outcome: { kind: 'enum', values: ['UPHELD', 'REJECTED'] },
      reasonCode: { kind: 'enum', values: ['CLAIMANT_DID_THE_WORK', 'RESPONDENT_DID_THE_WORK', 'INSUFFICIENT_EVIDENCE', 'OUTSIDE_POLICY', 'OTHER'] },
    },
  },
  // GROWTH-06: field work. Identifiers, kinds and states only — never notes, a follow-up's title or
  // a location (the audit row records whether a location was attached, never where).
  growthActivityLoggedV1: {
    eventType: 'growth.activity.logged',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_activity',
    purpose: 'growth-field-work',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.activity.logged/1',
    payload: { activityId: { kind: 'uuid' }, leadId: { kind: 'uuid' }, kind: { kind: 'enum', values: ['VISIT', 'CALL', 'MEETING', 'NOTE'] } },
  },
  growthActivityLocationRemovedV1: {
    eventType: 'growth.activity.location_removed',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_activity',
    purpose: 'growth-field-work',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.activity.location_removed/1',
    payload: { activityId: { kind: 'uuid' }, reasonCode: { kind: 'enum', values: ['AUTHOR_REMOVED'] } },
  },
  growthFollowUpCreatedV1: {
    eventType: 'growth.follow_up.created',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_follow_up',
    purpose: 'growth-field-work',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.follow_up.created/1',
    payload: { followUpId: { kind: 'uuid' }, leadId: { kind: 'uuid' } },
  },
  growthFollowUpClosedV1: {
    eventType: 'growth.follow_up.closed',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'growth_follow_up',
    purpose: 'growth-field-work',
    dataClassification: 'confidential',
    schemaRef: 'registry://growth.follow_up.closed/1',
    payload: { followUpId: { kind: 'uuid' }, leadId: { kind: 'uuid' }, state: { kind: 'enum', values: ['DONE', 'CANCELLED'] } },
  },
  // OPS-02: dual control for high-risk operator actions. No consumer yet; like the
  // capability events above, the outbox row is the durable announcement an access review
  // (OPS-15) can follow. Identifiers and enums only.
  operationApprovalRequestedV1: {
    eventType: 'operation_approval.requested',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'operation_approval',
    purpose: 'high-risk-action-dual-control',
    dataClassification: 'confidential',
    schemaRef: 'registry://operation_approval.requested/1',
    payload: { approvalId: { kind: 'uuid' }, actionKey: { kind: 'enum', values: operationApprovalActionKeys } },
  },
  operationApprovalDecidedV1: {
    eventType: 'operation_approval.decided',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'operation_approval',
    purpose: 'high-risk-action-dual-control',
    dataClassification: 'confidential',
    schemaRef: 'registry://operation_approval.decided/1',
    payload: {
      approvalId: { kind: 'uuid' },
      actionKey: { kind: 'enum', values: operationApprovalActionKeys },
      decision: { kind: 'enum', values: ['APPROVED', 'REJECTED'] },
      mode: { kind: 'enum', values: ['DUAL', 'SOLO'] },
    },
  },
  operationApprovalExecutedV1: {
    eventType: 'operation_approval.executed',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'operation_approval',
    purpose: 'high-risk-action-dual-control',
    dataClassification: 'confidential',
    schemaRef: 'registry://operation_approval.executed/1',
    payload: { approvalId: { kind: 'uuid' }, actionKey: { kind: 'enum', values: operationApprovalActionKeys } },
  },
  // OPS-15: quarterly internal access reviews. No consumer yet; the outbox rows are the
  // durable announcement of the review's lifecycle. Identifiers and enums only.
  accessReviewOpenedV1: {
    eventType: 'access_review.opened',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'access_review_campaign',
    purpose: 'internal-access-review',
    dataClassification: 'confidential',
    schemaRef: 'registry://access_review.opened/1',
    payload: { campaignId: { kind: 'uuid' } },
  },
  accessReviewItemDecidedV1: {
    eventType: 'access_review.item_decided',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'access_review_campaign',
    purpose: 'internal-access-review',
    dataClassification: 'confidential',
    schemaRef: 'registry://access_review.item_decided/1',
    payload: {
      campaignId: { kind: 'uuid' },
      itemId: { kind: 'uuid' },
      decision: { kind: 'enum', values: ['KEEP', 'REVOKE'] },
      mode: { kind: 'enum', values: ['DUAL', 'SOLO'] },
    },
  },
  accessReviewClosedV1: {
    eventType: 'access_review.closed',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'access_review_campaign',
    purpose: 'internal-access-review',
    dataClassification: 'confidential',
    schemaRef: 'registry://access_review.closed/1',
    payload: { campaignId: { kind: 'uuid' } },
  },
  // OPS-05: the support desk. No consumer yet; the outbox row is the durable
  // announcement a later notification or the Overview (OPS-03) can follow. Identifiers
  // and enums only: a case summary or note never leaves the support tables.
  supportCaseOpenedV1: {
    eventType: 'support_case.opened',
    eventVersion: 1,
    producer: 'operations-support',
    aggregateType: 'support_case',
    purpose: 'support-desk',
    dataClassification: 'confidential',
    schemaRef: 'registry://support_case.opened/1',
    payload: {
      caseId: { kind: 'uuid' },
      category: { kind: 'enum', values: ['ACCOUNT_ACCESS', 'INVITATION', 'ONBOARDING', 'DATA_CORRECTION', 'PRIVACY_REQUEST', 'TECHNICAL_FAULT', 'HOW_TO', 'COMPLAINT', 'OTHER'] },
      severity: { kind: 'enum', values: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
      channel: { kind: 'enum', values: ['EMAIL', 'PHONE', 'WHATSAPP', 'IN_APP'] },
    },
  },
  supportCaseStateChangedV1: {
    eventType: 'support_case.state_changed',
    eventVersion: 1,
    producer: 'operations-support',
    aggregateType: 'support_case',
    purpose: 'support-desk',
    dataClassification: 'confidential',
    schemaRef: 'registry://support_case.state_changed/1',
    payload: {
      caseId: { kind: 'uuid' },
      fromState: { kind: 'enum', values: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] },
      toState: { kind: 'enum', values: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] },
    },
  },
  supportCaseAssignedV1: {
    eventType: 'support_case.assigned',
    eventVersion: 1,
    producer: 'operations-support',
    aggregateType: 'support_case',
    purpose: 'support-desk',
    dataClassification: 'confidential',
    schemaRef: 'registry://support_case.assigned/1',
    payload: { caseId: { kind: 'uuid' }, assigneeUserId: { kind: 'uuid', required: false } },
  },
  // OPS-16: the incident register and status notices. Identifiers and enums only: a title,
  // summary, note or notice text never leaves the incident tables.
  incidentDeclaredV1: {
    eventType: 'incident.declared',
    eventVersion: 1,
    producer: 'operations-incidents',
    aggregateType: 'incident',
    purpose: 'incident-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://incident.declared/1',
    payload: {
      incidentId: { kind: 'uuid' },
      category: { kind: 'enum', values: ['PERSONAL_DATA_BREACH', 'SECURITY', 'SERVICE_OUTAGE', 'DEGRADED_SERVICE', 'DATA_INTEGRITY', 'OTHER'] },
      severity: { kind: 'enum', values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    },
  },
  incidentStateChangedV1: {
    eventType: 'incident.state_changed',
    eventVersion: 1,
    producer: 'operations-incidents',
    aggregateType: 'incident',
    purpose: 'incident-register',
    dataClassification: 'confidential',
    schemaRef: 'registry://incident.state_changed/1',
    payload: {
      incidentId: { kind: 'uuid' },
      fromState: { kind: 'enum', values: ['OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED'] },
      toState: { kind: 'enum', values: ['OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED'] },
    },
  },
  statusNoticeTemplatePublishedV1: {
    eventType: 'status_notice_template.published',
    eventVersion: 1,
    producer: 'operations-communications',
    aggregateType: 'status_notice_template',
    purpose: 'status-communications',
    dataClassification: 'internal',
    schemaRef: 'registry://status_notice_template.published/1',
    payload: { templateId: { kind: 'uuid' }, notificationTemplateId: { kind: 'uuid' } },
  },
  // OPS-12: AI Operations console changes. No consumer yet. Enums and identifiers only: a feature
  // key is free text chosen by an engineer, so it stays in the audit row, not in the event.
  aiFeaturePolicyChangedV1: {
    eventType: 'ai_feature_policy.changed',
    eventVersion: 1,
    producer: 'operations-ai',
    aggregateType: 'ai_operations_change',
    purpose: 'ai-operations',
    dataClassification: 'internal',
    schemaRef: 'registry://ai_feature_policy.changed/1',
    payload: {
      change: { kind: 'enum', values: ['ENABLED', 'DISABLED', 'LIMITS_LOWERED', 'LIMITS_RAISED'] },
      approvalMode: { kind: 'enum', values: ['NONE', 'DUAL', 'SOLO'] },
    },
  },
  aiKillSwitchEngagedV1: {
    eventType: 'ai_kill_switch.engaged',
    eventVersion: 1,
    producer: 'operations-ai',
    aggregateType: 'ai_operations_change',
    purpose: 'ai-operations',
    dataClassification: 'internal',
    schemaRef: 'registry://ai_kill_switch.engaged/1',
    payload: {
      reasonCode: { kind: 'enum', values: ['INCIDENT_MITIGATION', 'HARMFUL_OUTPUT', 'SUSPECTED_KEY_COMPROMISE', 'SPEND_RUNAWAY', 'PRECAUTION'] },
    },
  },
  aiEvaluationRecordedV1: {
    eventType: 'ai_evaluation.recorded',
    eventVersion: 1,
    producer: 'operations-ai',
    aggregateType: 'ai_evaluation',
    purpose: 'ai-operations',
    dataClassification: 'internal',
    schemaRef: 'registry://ai_evaluation.recorded/1',
    payload: { evaluationId: { kind: 'uuid' }, decision: { kind: 'enum', values: ['PASS', 'FAIL'] } },
  },
  // The worker sends an approved notice once, to the administrators of the affected organisations.
  incidentStatusNoticeDispatchRequestedV1: {
    eventType: 'incident.status_notice.dispatch.requested',
    eventVersion: 1,
    producer: 'operations-communications',
    aggregateType: 'incident_status_notice',
    purpose: 'status-communications',
    dataClassification: 'confidential',
    schemaRef: 'registry://incident.status_notice.dispatch.requested/1',
    payload: { noticeId: { kind: 'uuid' }, incidentId: { kind: 'uuid' } },
  },
  // OPS-08: career requirement sets. No consumer yet; a later worker can recompute the
  // gaps of students targeting the role after a publish. Identifiers and enums only.
  careerRequirementSetStateChangedV1: {
    eventType: 'career_requirement_set.state_changed',
    eventVersion: 1,
    producer: 'operations-catalogue',
    aggregateType: 'career_requirement_set',
    purpose: 'career-catalogue-administration',
    dataClassification: 'internal',
    schemaRef: 'registry://career_requirement_set.state_changed/1',
    payload: {
      setId: { kind: 'uuid' },
      careerRoleId: { kind: 'uuid' },
      fromState: { kind: 'enum', values: careerRequirementSetStates },
      toState: { kind: 'enum', values: careerRequirementSetStates },
    },
  },
  careerRequirementSetPublishedV1: {
    eventType: 'career_requirement_set.published',
    eventVersion: 1,
    producer: 'operations-catalogue',
    aggregateType: 'career_requirement_set',
    purpose: 'career-catalogue-administration',
    dataClassification: 'internal',
    schemaRef: 'registry://career_requirement_set.published/1',
    payload: {
      setId: { kind: 'uuid' },
      careerRoleId: { kind: 'uuid' },
      releaseLabel: { kind: 'enum', values: ['SELECTABLE', 'VERIFIED'] },
    },
  },
  // OPS-09a: skill map revisions. No consumer yet; identifiers and enums only.
  skillMapRevisionStateChangedV1: {
    eventType: 'skill_map.revision_state_changed',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'content_revision',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://skill_map.revision_state_changed/1',
    payload: {
      revisionId: { kind: 'uuid' },
      topicId: { kind: 'uuid' },
      fromState: { kind: 'enum', values: skillRevisionStates },
      toState: { kind: 'enum', values: skillRevisionStates },
    },
  },
  skillMapSkillPublishedV1: {
    eventType: 'skill_map.skill_published',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'content_revision',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://skill_map.skill_published/1',
    payload: {
      revisionId: { kind: 'uuid' },
      topicId: { kind: 'uuid' },
      releaseManifestId: { kind: 'uuid' },
    },
  },
  // OPS-09b: question bank revisions. No consumer yet; identifiers and enums only — never an answer.
  questionBankRevisionStateChangedV1: {
    eventType: 'question_bank.revision_state_changed',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'content_revision',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://question_bank.revision_state_changed/1',
    payload: {
      revisionId: { kind: 'uuid' },
      questionId: { kind: 'uuid' },
      fromState: { kind: 'enum', values: skillRevisionStates },
      toState: { kind: 'enum', values: skillRevisionStates },
    },
  },
  questionBankQuestionPublishedV1: {
    eventType: 'question_bank.question_published',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'content_revision',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://question_bank.question_published/1',
    payload: {
      revisionId: { kind: 'uuid' },
      questionId: { kind: 'uuid' },
      questionVersionId: { kind: 'uuid' },
      releaseManifestId: { kind: 'uuid' },
    },
  },
  // OPS-09c: lesson editor revisions (base lessons and their variants). No consumer yet;
  // identifiers and enums only.
  lessonEditorRevisionStateChangedV1: {
    eventType: 'lesson_editor.revision_state_changed',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'content_revision',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://lesson_editor.revision_state_changed/1',
    payload: {
      revisionId: { kind: 'uuid' },
      lessonId: { kind: 'uuid' },
      fromState: { kind: 'enum', values: skillRevisionStates },
      toState: { kind: 'enum', values: skillRevisionStates },
    },
  },
  lessonEditorLessonPublishedV1: {
    eventType: 'lesson_editor.lesson_published',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'content_revision',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://lesson_editor.lesson_published/1',
    payload: {
      revisionId: { kind: 'uuid' },
      lessonId: { kind: 'uuid' },
      // Absent for a variant: it writes no lesson version.
      lessonVersionId: { kind: 'uuid', required: false },
      releaseManifestId: { kind: 'uuid' },
      kind: { kind: 'enum', values: ['BASE', 'VARIANT'] },
      language: { kind: 'enum', values: ['en', 'hi', 'te', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'or'] },
    },
  },
  // ENG-23: the content factory. A job asking ONE's AI for a draft or an answer check, and how it
  // ended. No consumer: the content factory worker runs the job from its own row, never from this
  // event. Identifiers and enums only — never the note, the prompt or anything the model wrote.
  contentFactoryDraftRequestedV1: {
    eventType: 'content_factory.draft_requested',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'ai_content_draft',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://content_factory.draft_requested/1',
    payload: {
      jobId: { kind: 'uuid' },
      kind: { kind: 'enum', values: ['LESSON', 'LESSON_VARIANT', 'QUESTION', 'ANSWER_CHECK'] },
      featureKey: { kind: 'enum', values: ['content.lesson-draft', 'content.item-draft', 'content.answer-check'] },
    },
  },
  contentFactoryDraftFinishedV1: {
    eventType: 'content_factory.draft_finished',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'ai_content_draft',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://content_factory.draft_finished/1',
    payload: {
      jobId: { kind: 'uuid' },
      kind: { kind: 'enum', values: ['LESSON', 'LESSON_VARIANT', 'QUESTION', 'ANSWER_CHECK'] },
      state: { kind: 'enum', values: ['SUCCEEDED', 'REFUSED', 'REJECTED', 'FAILED'] },
      // Present only when a draft landed: the DRAFT revision a person now reviews.
      producedRevisionId: { kind: 'uuid', required: false },
    },
  },
  // OPS-10 (ADR-037): external faculty review assignments. No consumer yet; identifiers and
  // enums only — never the draft, the comment or the reviewer's identity.
  externalReviewAssignedV1: {
    eventType: 'external_review.assigned',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'external_review_assignment',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://external_review.assigned/1',
    payload: {
      assignmentId: { kind: 'uuid' },
      revisionId: { kind: 'uuid' },
      entityType: { kind: 'enum', values: ['TOPIC', 'QUESTION', 'LESSON'] },
    },
  },
  externalReviewDecidedV1: {
    eventType: 'external_review.decided',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'external_review_assignment',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://external_review.decided/1',
    payload: {
      assignmentId: { kind: 'uuid' },
      revisionId: { kind: 'uuid' },
      decision: { kind: 'enum', values: ['APPROVE', 'REQUEST_CHANGES'] },
    },
  },
  externalReviewRevokedV1: {
    eventType: 'external_review.revoked',
    eventVersion: 1,
    producer: 'operations-content',
    aggregateType: 'external_review_assignment',
    purpose: 'content-authoring',
    dataClassification: 'internal',
    schemaRef: 'registry://external_review.revoked/1',
    payload: {
      assignmentId: { kind: 'uuid' },
      revisionId: { kind: 'uuid' },
    },
  },
  learningLessonCompletedV1: {
    eventType: 'learning.lesson.completed',
    eventVersion: 1,
    producer: 'career-readiness',
    aggregateType: 'learner_progress',
    purpose: 'learning-progress-projection',
    dataClassification: 'confidential',
    schemaRef: 'registry://learning.lesson.completed/1',
    payload: { progressId: { kind: 'uuid' }, lessonVersionId: { kind: 'uuid' }, evidenceId: { kind: 'uuid' } },
  },
  // ENG-05: asks the skill-state projector to recompute one student from facts. Written in the
  // grading transaction (ATTEMPTS_RECORDED) or with an adaptive-learning grant (CONSENT_GRANTED).
  // Carries no learning data: the projector reads the facts itself, under the consent then live.
  learningSkillStateProjectionRequestedV1: {
    eventType: 'learning.skill_state.projection_requested',
    eventVersion: 1,
    producer: 'learning-engine',
    aggregateType: 'user',
    purpose: 'adaptive-learning-projection',
    dataClassification: 'confidential',
    schemaRef: 'registry://learning.skill_state.projection_requested/1',
    payload: { subjectUserId: { kind: 'uuid' }, reason: { kind: 'enum', values: ['ATTEMPTS_RECORDED', 'CONSENT_GRANTED'] } },
  },
  // ENG-22: a student asked the AI tutor for a hint; the worker writes it (no model call in the request).
  // Carries only the request's id: the worker reads the question, the ladder and the consent itself.
  tutorHintRequestedV1: {
    eventType: 'tutor.hint.requested',
    eventVersion: 1,
    producer: 'learning-engine',
    aggregateType: 'tutor_hint',
    purpose: 'ai-tutoring',
    dataClassification: 'confidential',
    schemaRef: 'registry://tutor.hint.requested/1',
    payload: { tutorHintId: { kind: 'uuid' } },
  },
  // ADR-052: a student asked ONE to explain a topic and no cached lesson existed; the worker writes it through
  // ONE AI Orchestration (no model call in the request). Carries only the lesson's id: the lesson names no one.
  explainLessonRequestedV1: {
    eventType: 'explain.lesson.requested',
    eventVersion: 1,
    producer: 'learning-engine',
    aggregateType: 'explain_lesson',
    purpose: 'ai-explanation',
    dataClassification: 'internal',
    schemaRef: 'registry://explain.lesson.requested/1',
    payload: { explainLessonId: { kind: 'uuid' } },
  },
  // ENG-12: a student sent a program to the code sandbox; the worker runs it on the isolated VM (no
  // sandbox call in the request). Carries only the submission's id: the worker reads the rest itself.
  codeSubmissionRequestedV1: {
    eventType: 'code.submission.requested',
    eventVersion: 1,
    producer: 'learning-engine',
    aggregateType: 'code_submission',
    purpose: 'code-execution',
    dataClassification: 'confidential',
    schemaRef: 'registry://code.submission.requested/1',
    payload: { codeSubmissionId: { kind: 'uuid' } },
  },
  assessmentAttemptStartedV1: {
    eventType: 'assessment.attempt.started',
    eventVersion: 1,
    producer: 'career-readiness',
    aggregateType: 'assessment_attempt',
    purpose: 'assessment-attempt-lifecycle',
    dataClassification: 'confidential',
    schemaRef: 'registry://assessment.attempt.started/1',
    payload: { attemptId: { kind: 'uuid' }, assignmentId: { kind: 'uuid' }, blueprintId: { kind: 'uuid' } },
  },
  assessmentAttemptSubmittedV1: {
    eventType: 'assessment.attempt.submitted',
    eventVersion: 1,
    producer: 'career-readiness',
    aggregateType: 'assessment_attempt',
    purpose: 'assessment-scoring-and-projection',
    dataClassification: 'confidential',
    schemaRef: 'registry://assessment.attempt.submitted/1',
    payload: {
      attemptId: { kind: 'uuid' },
      evidenceId: { kind: 'uuid' },
      // NOT_ENOUGH_EVIDENCE added by ENG-04 (C3): a first check, or any check on the same day
      // as the only other ones, no longer claims a band from one day's work. No value was removed.
      outcomeBand: { kind: 'enum', values: ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'DEMONSTRATED'] },
    },
  },
  readinessSnapshotCreatedV1: {
    eventType: 'readiness.snapshot.created',
    eventVersion: 1,
    producer: 'career-readiness',
    aggregateType: 'readiness_snapshot',
    purpose: 'advisory-readiness-explanation',
    dataClassification: 'confidential',
    schemaRef: 'registry://readiness.snapshot.created/1',
    payload: { readinessSnapshotId: { kind: 'uuid' }, modelVersionId: { kind: 'uuid' }, band: { kind: 'enum', values: ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP'] } },
  },
  roadmapActionCreatedV1: {
    eventType: 'roadmap.action.created',
    eventVersion: 1,
    producer: 'career-readiness',
    aggregateType: 'roadmap_action',
    purpose: 'learner-roadmap-recommendation',
    dataClassification: 'confidential',
    schemaRef: 'registry://roadmap.action.created/1',
    payload: { roadmapActionId: { kind: 'uuid' }, policyVersionId: { kind: 'uuid' }, actionCode: { kind: 'enum', values: ['COMPLETE_LESSON', 'RETRY_PRACTICE', 'REVIEW_EVIDENCE'] } },
  },
  notificationDeliveryRequestedV1: {
    eventType: 'notification.delivery.requested',
    eventVersion: 1,
    producer: 'career-readiness',
    aggregateType: 'notification_command',
    purpose: 'consented-transactional-email-delivery',
    dataClassification: 'confidential',
    schemaRef: 'registry://notification.delivery.requested/1',
    payload: { commandId: { kind: 'uuid' }, templateId: { kind: 'uuid' }, channel: { kind: 'enum', values: ['EMAIL'] } },
  },
  automationCommandRequestedV1: {
    eventType: 'automation.command.requested',
    eventVersion: 1,
    producer: 'career-readiness',
    aggregateType: 'automation_command',
    purpose: 'approved-workflow-invocation',
    dataClassification: 'internal',
    schemaRef: 'registry://automation.command.requested/1',
    payload: { commandId: { kind: 'uuid' }, workflowKey: { kind: 'string', minLength: 3, maxLength: 64, pattern: /^[a-z0-9-]+$/ }, commandType: { kind: 'string', minLength: 3, maxLength: 64, pattern: /^[A-Z0-9_]+$/ } },
  },
  contentGenerationRequestedV1: {
    eventType: 'content.generation.requested',
    eventVersion: 1,
    producer: 'learner-content',
    aggregateType: 'content_generation_request',
    purpose: 'seeded-learner-content-generation',
    dataClassification: 'internal',
    schemaRef: 'registry://content.generation.requested/1',
    payload: {
      requestId: { kind: 'uuid' },
      contentId: { kind: 'uuid' },
      seedKey: { kind: 'enum', values: ['PRACTICE_PROBLEM_SOLVING', 'COMPANY_RESEARCH_CHECKLIST', 'INTERVIEW_EVIDENCE_PLANNER', 'SCHOLARSHIP_APPLICATION_CHECKLIST', 'EVIDENCE_FIRST_RESUME_OUTLINE'] },
    },
  },
  contentGenerationCompletedV1: {
    eventType: 'content.generation.completed',
    eventVersion: 1,
    producer: 'learner-content',
    aggregateType: 'learner_content',
    purpose: 'seeded-learner-content-generation-completion',
    dataClassification: 'internal',
    schemaRef: 'registry://content.generation.completed/1',
    payload: {
      requestId: { kind: 'uuid' },
      contentId: { kind: 'uuid' },
      seedKey: { kind: 'enum', values: ['PRACTICE_PROBLEM_SOLVING', 'COMPANY_RESEARCH_CHECKLIST', 'INTERVIEW_EVIDENCE_PLANNER', 'SCHOLARSHIP_APPLICATION_CHECKLIST', 'EVIDENCE_FIRST_RESUME_OUTLINE'] },
      reviewState: { kind: 'enum', values: ['DRAFT'] },
      source: { kind: 'enum', values: ['SEEDED'] },
    },
  },
  // INST-18: operations published a version of the college data-processing terms (0088). No consumer.
  institutionDataTermsPublishedV1: {
    eventType: 'institution.data_terms.published',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_data_terms_version',
    purpose: 'institution-data-terms',
    dataClassification: 'internal',
    schemaRef: 'registry://institution.data_terms.published/1',
    payload: {
      version: { kind: 'string', minLength: 1, maxLength: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ },
      legalReviewState: { kind: 'enum', values: ['DRAFT_FOR_LEGAL_REVIEW', 'LEGAL_APPROVED'] },
      requiresReacceptance: { kind: 'enum', values: ['YES', 'NO'] },
    },
  },
  // INST-18: a college's owner accepted a data-processing terms version for the college.
  institutionDataTermsAcceptedV1: {
    eventType: 'institution.data_terms.accepted',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization',
    purpose: 'institution-data-terms',
    dataClassification: 'internal',
    schemaRef: 'registry://institution.data_terms.accepted/1',
    payload: {
      institutionId: { kind: 'uuid' },
      version: { kind: 'string', minLength: 1, maxLength: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ },
    },
  },
  // INST-18: a step of a college's exit — notice recorded, ended, cancelled, or its records purged.
  // Identifiers and enums only; the counts live on the offboarding row and its audit rows.
  institutionOffboardingNoticeRecordedV1: {
    eventType: 'institution.offboarding.notice_recorded',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_offboarding',
    purpose: 'institution-offboarding',
    dataClassification: 'internal',
    schemaRef: 'registry://institution.offboarding.notice_recorded/1',
    payload: { offboardingId: { kind: 'uuid' }, institutionId: { kind: 'uuid' } },
  },
  institutionOffboardingEndedV1: {
    eventType: 'institution.offboarding.ended',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_offboarding',
    purpose: 'institution-offboarding',
    dataClassification: 'internal',
    schemaRef: 'registry://institution.offboarding.ended/1',
    payload: { offboardingId: { kind: 'uuid' }, institutionId: { kind: 'uuid' } },
  },
  institutionOffboardingCancelledV1: {
    eventType: 'institution.offboarding.cancelled',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_offboarding',
    purpose: 'institution-offboarding',
    dataClassification: 'internal',
    schemaRef: 'registry://institution.offboarding.cancelled/1',
    payload: { offboardingId: { kind: 'uuid' }, institutionId: { kind: 'uuid' }, fromState: { kind: 'enum', values: ['NOTICE', 'ENDED'] } },
  },
  institutionOffboardingPurgedV1: {
    eventType: 'institution.offboarding.purged',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'institution_offboarding',
    purpose: 'institution-offboarding',
    dataClassification: 'internal',
    schemaRef: 'registry://institution.offboarding.purged/1',
    payload: { offboardingId: { kind: 'uuid' }, institutionId: { kind: 'uuid' }, approvalId: { kind: 'uuid' } },
  },
} as const satisfies Record<string, EventSchemaDefinition>;

export function schemaForEvent(eventType: string, eventVersion: number): EventSchemaDefinition {
  const definition = Object.values(eventSchemas).find(
    (candidate) => candidate.eventType === eventType && candidate.eventVersion === eventVersion,
  );
  if (!definition) throw new EventValidationError(`unsupported event schema ${eventType} v${eventVersion}`);
  return definition;
}

export function createIntegrationEventEnvelope<TPayload extends Record<string, unknown>>(
  input: Omit<IntegrationEventEnvelope<TPayload>, 'schemaRef' | 'producer' | 'aggregateType' | 'purpose' | 'dataClassification'>,
): IntegrationEventEnvelope<TPayload> {
  const definition = schemaForEvent(input.eventType, input.eventVersion);
  const event = {
    ...input,
    producer: definition.producer,
    aggregateType: definition.aggregateType,
    purpose: definition.purpose,
    dataClassification: definition.dataClassification,
    schemaRef: definition.schemaRef,
  };
  validateIntegrationEventEnvelope(event);
  return event;
}

export function validateIntegrationEventEnvelope(event: IntegrationEventEnvelope): void {
  const definition = schemaForEvent(event.eventType, event.eventVersion);
  requireUuid(event.eventId, 'eventId');
  requireUuid(event.aggregateId, 'aggregateId');
  requireCorrelationId(event.correlationId, 'correlationId');
  if (event.organizationId) requireUuid(event.organizationId, 'organizationId');
  if (event.subjectId) requireUuid(event.subjectId, 'subjectId');
  if (event.actorId) requireUuid(event.actorId, 'actorId');
  if (event.causationId) requireUuid(event.causationId, 'causationId');
  if (event.aggregateVersion !== undefined && (!Number.isInteger(event.aggregateVersion) || event.aggregateVersion < 1)) throw new EventValidationError('aggregateVersion must be a positive integer');
  requireTimestamp(event.occurredAt, 'occurredAt');
  if (event.expiresAt) {
    requireTimestamp(event.expiresAt, 'expiresAt');
    if (event.expiresAt <= event.occurredAt) throw new EventValidationError('expiresAt must be after occurredAt');
  }
  if (event.producer !== definition.producer) throw new EventValidationError('event producer does not match schema');
  if (event.aggregateType !== definition.aggregateType) throw new EventValidationError('event aggregateType does not match schema');
  if (event.purpose !== definition.purpose) throw new EventValidationError('event purpose does not match schema');
  if (event.dataClassification !== definition.dataClassification) throw new EventValidationError('event dataClassification does not match schema');
  if (event.schemaRef !== definition.schemaRef) throw new EventValidationError('event schemaRef does not match schema');

  requirePlainJsonObject(event.payload, 'payload');
  const payloadKeys = Object.keys(event.payload).sort();
  for (const key of Object.keys(definition.payload)) {
    if (definition.payload[key]?.required !== false && !(key in event.payload)) throw new EventValidationError(`missing payload field ${key}`);
  }
  for (const key of payloadKeys) {
    const fieldDefinition = definition.payload[key];
    if (!fieldDefinition) throw new EventValidationError(`unexpected payload field ${key}`);
    if (prohibitedPayloadKeys.some((pattern) => pattern.test(key))) throw new EventValidationError(`prohibited payload field ${key}`);
    const value = event.payload[key];
    validateJsonValue(value, `payload.${key}`);
    validatePayloadField(key, value, fieldDefinition);
  }
}

export function serializeIntegrationEvent(event: IntegrationEventEnvelope): string {
  validateIntegrationEventEnvelope(event);
  return `${stableStringify(event)}\n`;
}

function requireUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new EventValidationError(`${field} must be an opaque UUID`);
}

export function requireCorrelationId(value: string, field = 'correlationId'): void {
  if (!correlationIdPattern.test(value)) throw new EventValidationError(`${field} must match [A-Za-z0-9._:-]{8,128}`);
}

function requireTimestamp(value: string, field: string): void {
  if (!rfc3339UtcPattern.test(value)) throw new EventValidationError(`${field} must be an RFC-3339 UTC timestamp`);
}

function looksSensitive(value: string): boolean {
  return /@/.test(value) || /password|secret|token|credential|-----BEGIN/i.test(value);
}

function requirePlainJsonObject(value: unknown, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new EventValidationError(`${field} must be a JSON object`);
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new EventValidationError(`${field} must be a plain JSON object`);
}

function validateJsonValue(value: unknown, field: string): void {
  if (value === undefined) throw new EventValidationError(`${field} must not be undefined`);
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new EventValidationError(`${field} must be JSON-compatible`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new EventValidationError(`${field} must be finite`);
  if (value === null) return;
  if (Array.isArray(value)) throw new EventValidationError(`${field} must not be nested`);
  if (typeof value === 'object') throw new EventValidationError(`${field} must not be nested`);
  if (typeof value === 'string' && looksSensitive(value)) throw new EventValidationError(`${field} looks sensitive`);
}

function validatePayloadField(key: string, value: unknown, definition: PayloadFieldDefinition): void {
  if (definition.kind === 'uuid') {
    if (typeof value !== 'string') throw new EventValidationError(`payload field ${key} must be a UUID string`);
    requireUuid(value, `payload.${key}`);
    return;
  }
  if (definition.kind === 'string') {
    if (typeof value !== 'string') throw new EventValidationError(`payload field ${key} must be a string`);
    if (value.length < (definition.minLength ?? 1) || value.length > definition.maxLength) throw new EventValidationError(`payload field ${key} is out of bounds`);
    if (definition.pattern && !definition.pattern.test(value)) throw new EventValidationError(`payload field ${key} has invalid format`);
    return;
  }
  if (typeof value !== 'string' || !definition.values.includes(value)) throw new EventValidationError(`payload field ${key} has invalid enum value`);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}
