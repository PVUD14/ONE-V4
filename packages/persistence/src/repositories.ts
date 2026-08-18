import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type PersistenceDb = NodePgDatabase<typeof schema>;

type QueryResult<T> = { rows: T[] };

export interface AuditWriteInput {
  readonly id: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly organizationId?: string;
  readonly outcome?: 'SUCCESS' | 'DENIED';
  readonly correlationId: string;
  readonly context?: Record<string, unknown>;
}

export interface OutboxWriteInput {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion?: number;
  readonly payload: Record<string, unknown>;
  readonly actorUserId?: string;
  readonly organizationId?: string;
  readonly correlationId: string;
}

export interface RoleScopeInput {
  readonly organizationId: string;
  readonly institutionId?: string;
  readonly departmentUnitId?: string;
  readonly batchUnitId?: string;
  readonly employerId?: string;
}

export async function hasActiveInstitutionRelationship(
  db: PersistenceDb,
  institutionId: string,
  studentUserId: string,
  activityAt: Date,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.institutionRelationships.id })
    .from(schema.institutionRelationships)
    .where(and(
      eq(schema.institutionRelationships.institutionId, institutionId),
      eq(schema.institutionRelationships.studentUserId, studentUserId),
      or(
        eq(schema.institutionRelationships.state, 'VERIFIED'),
        eq(schema.institutionRelationships.state, 'ACTIVE'),
        eq(schema.institutionRelationships.state, 'TRANSFERRED'),
        eq(schema.institutionRelationships.state, 'GRADUATED'),
      ),
      lte(schema.institutionRelationships.effectiveFrom, activityAt),
      or(isNull(schema.institutionRelationships.effectiveTo), gt(schema.institutionRelationships.effectiveTo, activityAt)),
    ))
    .limit(1);

  return rows.length === 1;
}

export async function hasEmployerApplicantAccess(
  db: PersistenceDb,
  employerId: string,
  opportunityId: string,
  studentUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.employerApplicantAccessGrants.id })
    .from(schema.employerApplicantAccessGrants)
    .where(and(
      eq(schema.employerApplicantAccessGrants.employerId, employerId),
      eq(schema.employerApplicantAccessGrants.opportunityId, opportunityId),
      eq(schema.employerApplicantAccessGrants.studentUserId, studentUserId),
      isNull(schema.employerApplicantAccessGrants.revokedAt),
      or(isNull(schema.employerApplicantAccessGrants.expiresAt), gt(schema.employerApplicantAccessGrants.expiresAt, now)),
    ))
    .limit(1);

  return rows.length === 1;
}

export async function hasActiveMembership(
  db: PersistenceDb,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.organizationMemberships.id })
    .from(schema.organizationMemberships)
    .where(and(
      eq(schema.organizationMemberships.organizationId, organizationId),
      eq(schema.organizationMemberships.userId, userId),
      eq(schema.organizationMemberships.state, 'ACTIVE'),
    ))
    .limit(1);

  return rows.length === 1;
}

export async function assertActiveMembershipForMutation(
  db: PersistenceDb,
  organizationId: string,
  userId: string,
): Promise<void> {
  const result = await db.execute(sql`
    SELECT id
    FROM organization_memberships
    WHERE organization_id = ${organizationId}::uuid
      AND user_id = ${userId}::uuid
      AND state = 'ACTIVE'
    FOR UPDATE
  `) as QueryResult<{ id: string }>;

  if (result.rows.length !== 1) throw new Error('active membership not found');
}

export async function assertActiveEmployerGrantForMutation(
  db: PersistenceDb,
  employerId: string,
  opportunityId: string,
  studentUserId: string,
  now: Date = new Date(),
): Promise<void> {
  const result = await db.execute(sql`
    SELECT id
    FROM employer_applicant_access_grants
    WHERE employer_id = ${employerId}::uuid
      AND opportunity_id = ${opportunityId}::uuid
      AND student_user_id = ${studentUserId}::uuid
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ${now})
    FOR UPDATE
  `) as QueryResult<{ id: string }>;

  if (result.rows.length !== 1) throw new Error('active employer applicant grant not found');
}

export async function assignOrganizationMembershipWithAuditOutbox(
  db: PersistenceDb,
  input: {
    readonly membershipId: string;
    readonly organizationId: string;
    readonly targetUserId: string;
    readonly role: string;
    readonly scope: RoleScopeInput;
    readonly audit: AuditWriteInput;
    readonly outbox: OutboxWriteInput;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(schema.organizationMemberships).values({
      id: input.membershipId,
      organizationId: input.organizationId,
      userId: input.targetUserId,
      role: input.role,
      state: 'ACTIVE',
      scopeOrganizationId: input.scope.organizationId,
      ...(input.scope.institutionId ? { scopeInstitutionId: input.scope.institutionId } : {}),
      ...(input.scope.departmentUnitId ? { scopeDepartmentUnitId: input.scope.departmentUnitId } : {}),
      ...(input.scope.batchUnitId ? { scopeBatchUnitId: input.scope.batchUnitId } : {}),
      ...(input.scope.employerId ? { scopeEmployerId: input.scope.employerId } : {}),
    });
    await writeAuditEvent(tx, input.audit);
    await writeOutboxEvent(tx, input.outbox);
  });
}

export async function createEmployerApplicantGrantWithAuditOutbox(
  db: PersistenceDb,
  input: {
    readonly grantId: string;
    readonly employerId: string;
    readonly opportunityId: string;
    readonly studentUserId: string;
    readonly grantedAt: Date;
    readonly expiresAt?: Date;
    readonly audit: AuditWriteInput;
    readonly outbox: OutboxWriteInput;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(schema.employerApplicantAccessGrants).values({
      id: input.grantId,
      employerId: input.employerId,
      opportunityId: input.opportunityId,
      studentUserId: input.studentUserId,
      grantedAt: input.grantedAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    });
    await writeAuditEvent(tx, input.audit);
    await writeOutboxEvent(tx, input.outbox);
  });
}

export async function revokeEmployerApplicantGrantWithAuditOutbox(
  db: PersistenceDb,
  input: {
    readonly grantId: string;
    readonly employerId: string;
    readonly revokedAt: Date;
    readonly audit: AuditWriteInput;
    readonly outbox: OutboxWriteInput;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [grant] = await tx
      .update(schema.employerApplicantAccessGrants)
      .set({ revokedAt: input.revokedAt })
      .where(and(
        eq(schema.employerApplicantAccessGrants.id, input.grantId),
        eq(schema.employerApplicantAccessGrants.employerId, input.employerId),
        isNull(schema.employerApplicantAccessGrants.revokedAt),
      ))
      .returning({ id: schema.employerApplicantAccessGrants.id });

    if (!grant) throw new Error('active employer applicant grant not found');
    await writeAuditEvent(tx, input.audit);
    await writeOutboxEvent(tx, input.outbox);
  });
}

export async function suspendMembershipWithOutbox(
  db: PersistenceDb,
  input: {
    readonly membershipId: string;
    readonly organizationId: string;
    readonly eventId: string;
    readonly audit?: AuditWriteInput;
    readonly correlationId?: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [membership] = await tx
      .update(schema.organizationMemberships)
      .set({ state: 'SUSPENDED' })
      .where(and(
        eq(schema.organizationMemberships.id, input.membershipId),
        eq(schema.organizationMemberships.organizationId, input.organizationId),
      ))
      .returning({ id: schema.organizationMemberships.id, organizationId: schema.organizationMemberships.organizationId });

    if (!membership) throw new Error('membership not found');

    if (input.audit) await writeAuditEvent(tx, input.audit);
    await writeOutboxEvent(tx, {
      id: input.eventId,
      aggregateType: 'organization_membership',
      aggregateId: membership.id,
      eventType: 'organization_membership.suspended',
      eventVersion: 1,
      payload: { membershipId: membership.id },
      organizationId: membership.organizationId,
      correlationId: input.correlationId ?? 'system',
    });
  });
}

export async function acceptInvitationWithIdempotency(
  db: PersistenceDb,
  input: {
    readonly invitationId: string;
    readonly userId: string;
    readonly externalSubject: string;
    readonly now: Date;
    readonly idempotencyRecordId: string;
    readonly idempotencyScope: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly membershipId?: string;
    readonly auditId: string;
    readonly outboxEventId: string;
    readonly correlationId: string;
  },
): Promise<{ readonly userId: string; readonly idempotentReplay: boolean }> {
  return db.transaction(async (tx) => {
    const idempotency = await tx.execute(sql`
      INSERT INTO idempotency_records (id, scope, key, request_hash, status)
      VALUES (${input.idempotencyRecordId}::uuid, ${input.idempotencyScope}, ${input.idempotencyKey}, ${input.requestHash}, 'STARTED')
      ON CONFLICT (scope, key) DO UPDATE SET updated_at = idempotency_records.updated_at
      RETURNING request_hash, status, response_resource_id
    `) as QueryResult<{ request_hash: string; status: 'STARTED' | 'SUCCEEDED' | 'FAILED'; response_resource_id: string | null }>;

    const [idempotencyRow] = idempotency.rows;
    if (!idempotencyRow) throw new Error('idempotency record unavailable');
    if (idempotencyRow.request_hash !== input.requestHash) throw new Error('idempotency key reused with different request');
    if (idempotencyRow.status === 'SUCCEEDED' && idempotencyRow.response_resource_id) {
      return { userId: idempotencyRow.response_resource_id, idempotentReplay: true };
    }

    const invitationResult = await tx.execute(sql`
      SELECT id, email, organization_id, role, scope_organization_id, scope_institution_id,
             scope_department_unit_id, scope_batch_unit_id, scope_employer_id
      FROM invitations
      WHERE id = ${input.invitationId}::uuid
        AND state = 'PENDING'
        AND expires_at >= ${input.now}
        AND revoked_at IS NULL
      FOR UPDATE
    `) as QueryResult<{
      id: string;
      email: string;
      organization_id: string | null;
      role: string | null;
      scope_organization_id: string | null;
      scope_institution_id: string | null;
      scope_department_unit_id: string | null;
      scope_batch_unit_id: string | null;
      scope_employer_id: string | null;
    }>;

    const [invitation] = invitationResult.rows;
    if (!invitation) throw new Error('invitation is not usable');

    await tx.insert(schema.users).values({
      id: input.userId,
      externalSubject: input.externalSubject,
      email: invitation.email,
      state: 'ACTIVE',
    });

    const consumed = await tx.execute(sql`
      UPDATE invitations
      SET state = 'ACCEPTED', accepted_by_user_id = ${input.userId}::uuid, accepted_at = ${input.now}, updated_at = now()
      WHERE id = ${input.invitationId}::uuid
        AND state = 'PENDING'
        AND expires_at >= ${input.now}
        AND revoked_at IS NULL
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (consumed.rows.length !== 1) throw new Error('invitation is not usable');

    if (invitation.organization_id && invitation.role && invitation.scope_organization_id) {
      if (!input.membershipId) throw new Error('membership id required for scoped invitation');
      await tx.insert(schema.organizationMemberships).values({
        id: input.membershipId,
        organizationId: invitation.organization_id,
        userId: input.userId,
        role: invitation.role,
        state: 'ACTIVE',
        scopeOrganizationId: invitation.scope_organization_id,
        ...(invitation.scope_institution_id ? { scopeInstitutionId: invitation.scope_institution_id } : {}),
        ...(invitation.scope_department_unit_id ? { scopeDepartmentUnitId: invitation.scope_department_unit_id } : {}),
        ...(invitation.scope_batch_unit_id ? { scopeBatchUnitId: invitation.scope_batch_unit_id } : {}),
        ...(invitation.scope_employer_id ? { scopeEmployerId: invitation.scope_employer_id } : {}),
      });
    }

    await writeAuditEvent(tx, {
      id: input.auditId,
      actorUserId: input.userId,
      action: 'identity.invitation.accepted',
      resourceType: 'invitation',
      resourceId: input.invitationId,
      ...(invitation.organization_id ? { organizationId: invitation.organization_id } : {}),
      outcome: 'SUCCESS',
      correlationId: input.correlationId,
    });
    await writeOutboxEvent(tx, {
      id: input.outboxEventId,
      aggregateType: 'user',
      aggregateId: input.userId,
      eventType: 'identity.invitation.accepted',
      eventVersion: 1,
      payload: { userId: input.userId, invitationId: input.invitationId },
      actorUserId: input.userId,
      ...(invitation.organization_id ? { organizationId: invitation.organization_id } : {}),
      correlationId: input.correlationId,
    });

    await tx.update(schema.idempotencyRecords)
      .set({ status: 'SUCCEEDED', responseResourceType: 'user', responseResourceId: input.userId })
      .where(and(eq(schema.idempotencyRecords.scope, input.idempotencyScope), eq(schema.idempotencyRecords.key, input.idempotencyKey)));

    return { userId: input.userId, idempotentReplay: false };
  });
}

async function writeAuditEvent(db: PersistenceDb, input: AuditWriteInput): Promise<void> {
  await db.insert(schema.auditEvents).values({
    id: input.id,
    actorUserId: input.actorUserId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    outcome: input.outcome ?? 'SUCCESS',
    correlationId: input.correlationId,
    context: input.context ?? {},
  });
}

async function writeOutboxEvent(db: PersistenceDb, input: OutboxWriteInput): Promise<void> {
  await db.insert(schema.outboxEvents).values({
    id: input.id,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    eventVersion: input.eventVersion ?? 1,
    payload: input.payload,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    correlationId: input.correlationId,
  });
}
