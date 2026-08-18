import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const accountState = pgEnum('account_state', ['INVITED', 'ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'DELETED']);
export const organizationKind = pgEnum('organization_kind', ['PLATFORM', 'INSTITUTION', 'EMPLOYER']);
export const verificationState = pgEnum('verification_state', ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED']);
export const membershipState = pgEnum('membership_state', ['ACTIVE', 'SUSPENDED', 'ENDED']);
export const invitationState = pgEnum('invitation_state', ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']);
export const relationshipState = pgEnum('relationship_state', ['PENDING', 'VERIFIED', 'ACTIVE', 'ENDED', 'TRANSFERRED', 'GRADUATED', 'REVOKED']);
export const institutionUnitKind = pgEnum('institution_unit_kind', ['INSTITUTION', 'CAMPUS', 'DEPARTMENT', 'PROGRAM', 'BATCH', 'SECTION']);
export const outboxDeliveryState = pgEnum('outbox_delivery_state', ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED']);
export const idempotencyStatus = pgEnum('idempotency_status', ['STARTED', 'SUCCEEDED', 'FAILED']);
export const eventConsumerReceiptStatus = pgEnum('event_consumer_receipt_status', ['STARTED', 'SUCCEEDED', 'FAILED']);

const zeroUuid = '00000000-0000-0000-0000-000000000000';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  externalSubject: text('external_subject'),
  email: text('email').notNull(),
  state: accountState('state').notNull().default('INVITED'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('users_external_subject_uq').on(t.externalSubject).where(sql`${t.externalSubject} is not null`),
  uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
]);

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  kind: organizationKind('kind').notNull(),
  legalName: text('legal_name').notNull(),
  verificationState: verificationState('verification_state').notNull().default('PENDING'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const institutionUnits = pgTable('institution_units', {
  id: uuid('id').primaryKey(),
  institutionId: uuid('institution_id').notNull().references(() => organizations.id),
  kind: institutionUnitKind('kind').notNull(),
  name: text('name').notNull(),
  parentUnitId: uuid('parent_unit_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('institution_units_id_institution_uq').on(t.id, t.institutionId),
  index('institution_units_institution_parent_idx').on(t.institutionId, t.parentUnitId),
  foreignKey({
    columns: [t.parentUnitId, t.institutionId],
    foreignColumns: [t.id, t.institutionId],
    name: 'institution_units_parent_same_institution_fk',
  }),
]);

export const organizationMemberships = pgTable('organization_memberships', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').notNull(),
  state: membershipState('state').notNull().default('ACTIVE'),
  scopeOrganizationId: uuid('scope_organization_id').notNull().references(() => organizations.id),
  scopeInstitutionId: uuid('scope_institution_id').references(() => organizations.id),
  scopeDepartmentUnitId: uuid('scope_department_unit_id'),
  scopeBatchUnitId: uuid('scope_batch_unit_id'),
  scopeEmployerId: uuid('scope_employer_id').references(() => organizations.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('membership_org_user_role_scope_uq').on(
    t.organizationId,
    t.userId,
    t.role,
    t.scopeOrganizationId,
    sql`coalesce(${t.scopeDepartmentUnitId}, ${zeroUuid}::uuid)`,
    sql`coalesce(${t.scopeBatchUnitId}, ${zeroUuid}::uuid)`,
    sql`coalesce(${t.scopeEmployerId}, ${zeroUuid}::uuid)`,
  ).where(sql`${t.state} <> 'ENDED'`),
  index('membership_user_org_idx').on(t.userId, t.organizationId),
  index('membership_active_scope_idx').on(t.organizationId, t.userId, t.state),
  check('membership_scope_org_match_ck', sql`${t.scopeOrganizationId} = ${t.organizationId}`),
  foreignKey({
    columns: [t.scopeDepartmentUnitId, t.organizationId],
    foreignColumns: [institutionUnits.id, institutionUnits.institutionId],
    name: 'membership_department_same_institution_fk',
  }),
  foreignKey({
    columns: [t.scopeBatchUnitId, t.organizationId],
    foreignColumns: [institutionUnits.id, institutionUnits.institutionId],
    name: 'membership_batch_same_institution_fk',
  }),
]);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull(),
  state: invitationState('state').notNull().default('PENDING'),
  invitedByUserId: uuid('invited_by_user_id').notNull().references(() => users.id),
  organizationId: uuid('organization_id').references(() => organizations.id),
  role: text('role'),
  scopeOrganizationId: uuid('scope_organization_id').references(() => organizations.id),
  scopeInstitutionId: uuid('scope_institution_id').references(() => organizations.id),
  scopeDepartmentUnitId: uuid('scope_department_unit_id'),
  scopeBatchUnitId: uuid('scope_batch_unit_id'),
  scopeEmployerId: uuid('scope_employer_id').references(() => organizations.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('invitations_token_hash_uq').on(t.tokenHash),
  uniqueIndex('invitations_pending_email_org_uq')
    .on(sql`lower(${t.email})`, sql`coalesce(${t.organizationId}, ${zeroUuid}::uuid)`)
    .where(sql`${t.state} = 'PENDING'`),
  index('invitations_pending_lookup_idx').on(t.id, t.state, t.expiresAt),
  check('invitation_token_hash_length_ck', sql`length(${t.tokenHash}) >= 32`),
  check('invitation_role_scope_pair_ck', sql`(${t.role} is null and ${t.scopeOrganizationId} is null) or (${t.role} is not null and ${t.scopeOrganizationId} is not null)`),
  check('invitation_consumed_state_ck', sql`(${t.state} = 'ACCEPTED' and ${t.acceptedByUserId} is not null and ${t.acceptedAt} is not null) or (${t.state} <> 'ACCEPTED' and ${t.acceptedByUserId} is null and ${t.acceptedAt} is null)`),
  foreignKey({
    columns: [t.scopeDepartmentUnitId, t.organizationId],
    foreignColumns: [institutionUnits.id, institutionUnits.institutionId],
    name: 'invitation_department_same_institution_fk',
  }),
  foreignKey({
    columns: [t.scopeBatchUnitId, t.organizationId],
    foreignColumns: [institutionUnits.id, institutionUnits.institutionId],
    name: 'invitation_batch_same_institution_fk',
  }),
]);

export const institutionRelationships = pgTable('institution_relationships', {
  id: uuid('id').primaryKey(),
  institutionId: uuid('institution_id').notNull().references(() => organizations.id),
  studentUserId: uuid('student_user_id').notNull().references(() => users.id),
  state: relationshipState('state').notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('institution_relationship_identity_window_uq').on(t.institutionId, t.studentUserId, t.effectiveFrom),
  index('institution_relationship_scope_idx').on(t.institutionId, t.studentUserId, t.effectiveFrom, t.effectiveTo),
  check('institution_relationship_window_ck', sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`),
  check('institution_relationship_transferred_end_ck', sql`${t.state} <> 'TRANSFERRED' or ${t.effectiveTo} is not null`),
  check('institution_relationship_graduated_end_ck', sql`${t.state} <> 'GRADUATED' or ${t.effectiveTo} is not null`),
]);

export const employerApplicantAccessGrants = pgTable('employer_applicant_access_grants', {
  id: uuid('id').primaryKey(),
  employerId: uuid('employer_id').notNull().references(() => organizations.id),
  studentUserId: uuid('student_user_id').notNull().references(() => users.id),
  opportunityId: uuid('opportunity_id').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('employer_applicant_active_scope_uq').on(t.employerId, t.studentUserId, t.opportunityId).where(sql`${t.revokedAt} is null`),
  index('employer_applicant_lookup_idx').on(t.employerId, t.opportunityId, t.studentUserId),
  check('employer_applicant_revocation_ck', sql`${t.revokedAt} is null or ${t.revokedAt} >= ${t.grantedAt}`),
  check('employer_applicant_expiry_ck', sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.grantedAt}`),
]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  organizationId: uuid('organization_id').references(() => organizations.id),
  outcome: text('outcome').notNull(),
  correlationId: text('correlation_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  context: jsonb('context').notNull().default(sql`'{}'::jsonb`),
}, (t) => [
  index('audit_actor_time_idx').on(t.actorUserId, t.occurredAt),
  index('audit_organization_time_idx').on(t.organizationId, t.occurredAt),
  check('audit_outcome_ck', sql`${t.outcome} in ('SUCCESS','DENIED')`),
]);

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  eventVersion: integer('event_version').notNull().default(1),
  payload: jsonb('payload').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  organizationId: uuid('organization_id').references(() => organizations.id),
  correlationId: text('correlation_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  deliveryState: outboxDeliveryState('delivery_state').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastFailureClass: text('last_failure_class'),
  lastFailureMessage: text('last_failure_message'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('outbox_unpublished_idx').on(t.deliveryState, t.availableAt, t.occurredAt),
  index('outbox_lease_expiry_idx').on(t.deliveryState, t.leaseExpiresAt),
  check('outbox_event_version_ck', sql`${t.eventVersion} > 0`),
  check('outbox_attempts_ck', sql`${t.attempts} >= 0`),
  check('outbox_lease_state_ck', sql`(${t.deliveryState} = 'PROCESSING' and ${t.leaseOwner} is not null and ${t.leaseToken} is not null and ${t.leaseExpiresAt} is not null) or (${t.deliveryState} <> 'PROCESSING' and ${t.leaseOwner} is null and ${t.leaseToken} is null and ${t.leaseExpiresAt} is null)`),
  check('outbox_published_state_ck', sql`(${t.deliveryState} = 'PUBLISHED' and ${t.publishedAt} is not null) or (${t.deliveryState} <> 'PUBLISHED' and ${t.publishedAt} is null)`),
]);

export const idempotencyRecords = pgTable('idempotency_records', {
  id: uuid('id').primaryKey(),
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  status: idempotencyStatus('status').notNull().default('STARTED'),
  responseResourceType: text('response_resource_type'),
  responseResourceId: text('response_resource_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('idempotency_scope_key_uq').on(t.scope, t.key),
  check('idempotency_request_hash_ck', sql`length(${t.requestHash}) >= 32`),
  check('idempotency_response_pair_ck', sql`(${t.responseResourceType} is null and ${t.responseResourceId} is null) or (${t.responseResourceType} is not null and ${t.responseResourceId} is not null)`),
]);

export const eventConsumerReceipts = pgTable('event_consumer_receipts', {
  id: uuid('id').primaryKey(),
  consumerName: text('consumer_name').notNull(),
  eventId: uuid('event_id').notNull().references(() => outboxEvents.id),
  status: eventConsumerReceiptStatus('status').notNull().default('STARTED'),
  attempts: integer('attempts').notNull().default(0),
  lastFailureClass: text('last_failure_class'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  succeededAt: timestamp('succeeded_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('event_consumer_receipts_consumer_event_uq').on(t.consumerName, t.eventId),
  index('event_consumer_receipts_event_idx').on(t.eventId),
  check('event_consumer_receipts_attempts_ck', sql`${t.attempts} >= 0`),
  check('event_consumer_receipts_success_ck', sql`(${t.status} = 'SUCCEEDED' and ${t.succeededAt} is not null) or (${t.status} <> 'SUCCEEDED')`),
]);
