import { and, eq, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import type { AuditWriteInput, OutboxWriteInput, PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

export interface PersistedIdentityUser {
  readonly id: string;
  readonly externalSubject: string;
  readonly state: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DELETION_PENDING' | 'DELETED';
}

export interface PersistedActiveMembership {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly state: 'ACTIVE';
  readonly scope: {
    readonly organizationId: string;
    readonly institutionId?: string;
    readonly departmentId?: string;
    readonly batchId?: string;
    readonly employerId?: string;
  };
}

export async function findIdentityByExternalSubject(
  db: PersistenceDb,
  externalSubject: string,
): Promise<PersistedIdentityUser | null> {
  const [user] = await db
    .select({
      id: schema.users.id,
      externalSubject: schema.users.externalSubject,
      state: schema.users.state,
    })
    .from(schema.users)
    .where(eq(schema.users.externalSubject, externalSubject))
    .limit(1);

  if (!user || !user.externalSubject) return null;
  return { id: user.id, externalSubject: user.externalSubject, state: user.state };
}

export async function loadActiveMembershipsForUser(
  db: PersistenceDb,
  userId: string,
): Promise<readonly PersistedActiveMembership[]> {
  const rows = await db
    .select({
      id: schema.organizationMemberships.id,
      organizationId: schema.organizationMemberships.organizationId,
      userId: schema.organizationMemberships.userId,
      role: schema.organizationMemberships.role,
      state: schema.organizationMemberships.state,
      scopeOrganizationId: schema.organizationMemberships.scopeOrganizationId,
      scopeInstitutionId: schema.organizationMemberships.scopeInstitutionId,
      scopeDepartmentUnitId: schema.organizationMemberships.scopeDepartmentUnitId,
      scopeBatchUnitId: schema.organizationMemberships.scopeBatchUnitId,
      scopeEmployerId: schema.organizationMemberships.scopeEmployerId,
    })
    .from(schema.organizationMemberships)
    .where(and(
      eq(schema.organizationMemberships.userId, userId),
      eq(schema.organizationMemberships.state, 'ACTIVE'),
    ));

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role: row.role,
    state: 'ACTIVE' as const,
    scope: {
      organizationId: row.scopeOrganizationId,
      ...(row.scopeInstitutionId ? { institutionId: row.scopeInstitutionId } : {}),
      ...(row.scopeDepartmentUnitId ? { departmentId: row.scopeDepartmentUnitId } : {}),
      ...(row.scopeBatchUnitId ? { batchId: row.scopeBatchUnitId } : {}),
      ...(row.scopeEmployerId ? { employerId: row.scopeEmployerId } : {}),
    },
  }));
}

export async function acceptInvitationByTokenHashForVerifiedRecipientWithIdempotency(
  db: PersistenceDb,
  input: {
    readonly invitationTokenHash: string;
    readonly normalizedRecipientEmail: string;
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
      WHERE token_hash = ${input.invitationTokenHash}
        AND lower(email) = ${input.normalizedRecipientEmail}
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
      WHERE id = ${invitation.id}::uuid
        AND token_hash = ${input.invitationTokenHash}
        AND lower(email) = ${input.normalizedRecipientEmail}
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
      resourceId: invitation.id,
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
      payload: { userId: input.userId, invitationId: invitation.id },
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
