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
  | { readonly kind: 'uuid' }
  | { readonly kind: 'string'; readonly minLength?: number; readonly maxLength: number; readonly pattern?: RegExp }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rfc3339UtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const correlationIdPattern = /^[\x20-\x7E]{8,128}$/;
const prohibitedPayloadKeys = [
  /email/i,
  /password/i,
  /token/i,
  /credential/i,
  /secret/i,
  /resume/i,
  /document/i,
  /answer/i,
  /answerKey/i,
  /prompt/i,
  /conversation/i,
  /stack/i,
  /snapshot/i,
];

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
  organizationRoleAssignedV1: {
    eventType: 'organization.role.assigned',
    eventVersion: 1,
    producer: 'identity-organization',
    aggregateType: 'organization_membership',
    purpose: 'organization-role-assignment',
    dataClassification: 'confidential',
    schemaRef: 'registry://organization.role.assigned/1',
    payload: { membershipId: { kind: 'uuid' } },
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
    if (!(key in event.payload)) throw new EventValidationError(`missing payload field ${key}`);
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

function requireCorrelationId(value: string, field: string): void {
  if (!correlationIdPattern.test(value)) throw new EventValidationError(`${field} must be bounded printable ASCII`);
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
