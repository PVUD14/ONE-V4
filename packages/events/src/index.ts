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
] as const;

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
    payload: { attemptId: { kind: 'uuid' }, evidenceId: { kind: 'uuid' }, outcomeBand: { kind: 'enum', values: ['DEVELOPING', 'PROGRESSING', 'DEMONSTRATED'] } },
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
