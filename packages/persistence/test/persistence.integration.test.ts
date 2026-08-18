import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/schema.js';
import {
  acceptInvitationWithIdempotency,
  assertActiveEmployerGrantForMutation,
  assertActiveMembershipForMutation,
  assignOrganizationMembershipWithAuditOutbox,
  createEmployerApplicantGrantWithAuditOutbox,
  hasActiveInstitutionRelationship,
  hasActiveMembership,
  hasEmployerApplicantAccess,
  revokeEmployerApplicantGrantWithAuditOutbox,
  suspendMembershipWithOutbox,
} from '../src/repositories.js';
import {
  InMemoryIntegrationEventPublisher,
  EventConsumerEffectError,
  OutboxReconciliationRequiredError,
  OutboxPublishError,
  claimOutboxBatch,
  computeRetryDelayMs,
  dispatchClaimedOutboxEvent,
  handleEventIdempotently,
  markExpiredOutboxEvents,
  markOutboxPublished,
  markOutboxTerminalFailure,
  replayOutboxEvent,
} from '../src/outbox-dispatcher.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });
const zeroUuid = '00000000-0000-0000-0000-000000000000';

async function applyMigrations() {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const migrationName of migrations) {
    const migration = await readFile(new URL(migrationName, migrationDir), 'utf8');
    await pool.query(migration);
  }
}

async function seedUser(email: string, externalSubject: string | null = `sub:${randomUUID()}`) {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject, email, state: 'ACTIVE' });
  return id;
}

async function seedOrg(kind: 'PLATFORM' | 'INSTITUTION' | 'EMPLOYER', legalName: string) {
  const id = randomUUID();
  await db.insert(schema.organizations).values({ id, kind, legalName, verificationState: kind === 'EMPLOYER' ? 'VERIFIED' : 'PENDING' });
  return id;
}

async function seedInstitutionUnit(institutionId: string, kind: 'INSTITUTION' | 'CAMPUS' | 'DEPARTMENT' | 'PROGRAM' | 'BATCH' | 'SECTION', name: string, parentUnitId?: string) {
  const id = randomUUID();
  await db.insert(schema.institutionUnits).values({ id, institutionId, kind, name, ...(parentUnitId ? { parentUnitId } : {}) });
  return id;
}

async function seedInstitutionMembership(userId: string, institutionId: string, role = 'FACULTY_LECTURER', departmentUnitId?: string) {
  const id = randomUUID();
  await db.insert(schema.organizationMemberships).values({
    id,
    organizationId: institutionId,
    userId,
    role,
    state: 'ACTIVE',
    scopeOrganizationId: institutionId,
    scopeInstitutionId: institutionId,
    ...(departmentUnitId ? { scopeDepartmentUnitId: departmentUnitId } : {}),
  });
  return id;
}

async function seedEmployerMembership(userId: string, employerId: string, role = 'RECRUITER') {
  const id = randomUUID();
  await db.insert(schema.organizationMemberships).values({
    id,
    organizationId: employerId,
    userId,
    role,
    state: 'ACTIVE',
    scopeOrganizationId: employerId,
    scopeEmployerId: employerId,
  });
  return id;
}

async function countById(table: string, id: string): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE id = $1`, [id]);
  return Number(result.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE
      idempotency_records,
      event_consumer_receipts,
      outbox_events,
      audit_events,
      employer_applicant_access_grants,
      institution_relationships,
      invitations,
      organization_memberships,
      institution_units,
      organizations,
      users
    CASCADE
  `);
});

afterAll(async () => pool.end());

describe('Phase 1 identity organization persistence invariants', () => {
  it('allows invited users without external subjects but rejects duplicate external subjects', async () => {
    await seedUser('invited1@example.test', null);
    await seedUser('invited2@example.test', null);
    const externalSubject = `sub:${randomUUID()}`;
    await seedUser('active1@example.test', externalSubject);
    await expect(seedUser('active2@example.test', externalSubject)).rejects.toThrow();
  });

  it('denies former institution access to activity after relationship end', async () => {
    const student = await seedUser('student1@example.test');
    const institution = await seedOrg('INSTITUTION', 'College A');
    await db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId: institution,
      studentUserId: student,
      state: 'TRANSFERRED',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: new Date('2026-06-30T00:00:00Z'),
    });

    await expect(hasActiveInstitutionRelationship(db, institution, student, new Date('2026-05-01T00:00:00Z'))).resolves.toBe(true);
    await expect(hasActiveInstitutionRelationship(db, institution, student, new Date('2026-07-01T00:00:00Z'))).resolves.toBe(false);
  });

  it('applies the canonical temporal matrix for institution relationship reads', async () => {
    const student = await seedUser('student-temporal@example.test');
    const institution = await seedOrg('INSTITUTION', 'Temporal College');
    const effectiveFrom = new Date('2026-01-01T00:00:00Z');
    const effectiveTo = new Date('2026-06-01T00:00:00Z');

    async function seedRelationship(state: 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'ENDED' | 'TRANSFERRED' | 'GRADUATED' | 'REVOKED', to: Date | null) {
      await pool.query('TRUNCATE institution_relationships CASCADE');
      await db.insert(schema.institutionRelationships).values({
        id: randomUUID(),
        institutionId: institution,
        studentUserId: student,
        state,
        effectiveFrom,
        ...(to ? { effectiveTo: to } : {}),
      });
    }

    await seedRelationship('ACTIVE', effectiveTo);
    await expect(hasActiveInstitutionRelationship(db, institution, student, new Date('2025-12-31T23:59:59.999Z'))).resolves.toBe(false);
    await expect(hasActiveInstitutionRelationship(db, institution, student, effectiveFrom)).resolves.toBe(true);
    await expect(hasActiveInstitutionRelationship(db, institution, student, new Date('2026-05-31T23:59:59.999Z'))).resolves.toBe(true);
    await expect(hasActiveInstitutionRelationship(db, institution, student, effectiveTo)).resolves.toBe(false);
    await expect(hasActiveInstitutionRelationship(db, institution, student, new Date('2026-06-01T00:00:00.001Z'))).resolves.toBe(false);

    await seedRelationship('TRANSFERRED', effectiveTo);
    await expect(hasActiveInstitutionRelationship(db, institution, student, new Date('2026-05-31T23:59:59.999Z'))).resolves.toBe(true);
    await expect(hasActiveInstitutionRelationship(db, institution, student, effectiveTo)).resolves.toBe(false);

    await expect(db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId: institution,
      studentUserId: student,
      state: 'TRANSFERRED',
      effectiveFrom,
    })).rejects.toThrow();

    await seedRelationship('REVOKED', effectiveTo);
    await expect(hasActiveInstitutionRelationship(db, institution, student, new Date('2026-02-01T00:00:00Z'))).resolves.toBe(false);
  });

  it('rejects institution relationships attached to employer organizations', async () => {
    const student = await seedUser('student-invalid-rel@example.test');
    const employer = await seedOrg('EMPLOYER', 'Employer As Institution');
    await expect(db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId: employer,
      studentUserId: student,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    })).rejects.toThrow();
  });

  it('rejects cross-tenant institution hierarchy parents on insert and update', async () => {
    const institutionA = await seedOrg('INSTITUTION', 'College Parent');
    const institutionB = await seedOrg('INSTITUTION', 'College Child');
    const parent = await seedInstitutionUnit(institutionA, 'DEPARTMENT', 'Computer Science');
    const child = await seedInstitutionUnit(institutionB, 'BATCH', '2026');

    await expect(seedInstitutionUnit(institutionB, 'BATCH', '2027', parent)).rejects.toThrow();
    await expect(db.update(schema.institutionUnits)
      .set({ parentUnitId: parent })
      .where(eq(schema.institutionUnits.id, child))).rejects.toThrow();
  });

  it('rejects institution units under non-institution organizations', async () => {
    const employer = await seedOrg('EMPLOYER', 'Not A College');
    await expect(seedInstitutionUnit(employer, 'DEPARTMENT', 'Invalid')).rejects.toThrow();
  });

  it('requires active organization membership and rejects duplicate scoped membership', async () => {
    const user = await seedUser('staff@example.test');
    const institution = await seedOrg('INSTITUTION', 'College B');
    const department = await seedInstitutionUnit(institution, 'DEPARTMENT', 'ECE');
    const membershipId = await seedInstitutionMembership(user, institution, 'FACULTY_LECTURER', department);

    await expect(hasActiveMembership(db, institution, user)).resolves.toBe(true);
    await expect(seedInstitutionMembership(user, institution, 'FACULTY_LECTURER', department)).rejects.toThrow();

    await db.update(schema.organizationMemberships).set({ state: 'SUSPENDED' }).where(eq(schema.organizationMemberships.id, membershipId));
    await expect(hasActiveMembership(db, institution, user)).resolves.toBe(false);
    await expect(assertActiveMembershipForMutation(db, institution, user)).rejects.toThrow('active membership not found');
  });

  it('rejects role assignments whose role does not match organization kind or scope on insert and update', async () => {
    const user = await seedUser('role-shape@example.test');
    const employer = await seedOrg('EMPLOYER', 'Employer Role Shape');
    const institution = await seedOrg('INSTITUTION', 'Institution Role Shape');
    const membershipId = await seedInstitutionMembership(user, institution, 'FACULTY_LECTURER');

    await expect(db.insert(schema.organizationMemberships).values({
      id: randomUUID(),
      organizationId: employer,
      userId: user,
      role: 'FACULTY_LECTURER',
      state: 'ACTIVE',
      scopeOrganizationId: employer,
      scopeInstitutionId: institution,
    })).rejects.toThrow();

    await expect(db.insert(schema.organizationMemberships).values({
      id: randomUUID(),
      organizationId: institution,
      userId: user,
      role: 'RECRUITER',
      state: 'ACTIVE',
      scopeOrganizationId: institution,
      scopeEmployerId: employer,
    })).rejects.toThrow();

    await expect(db.update(schema.organizationMemberships)
      .set({ scopeOrganizationId: employer })
      .where(eq(schema.organizationMemberships.id, membershipId))).rejects.toThrow();
  });

  it('isolates employer applicant grants, honors revocation, and rejects invalid employer relationships', async () => {
    const student = await seedUser('student2@example.test');
    const employerA = await seedOrg('EMPLOYER', 'Employer A');
    const employerB = await seedOrg('EMPLOYER', 'Employer B');
    const institution = await seedOrg('INSTITUTION', 'Not Employer');
    const opportunity = randomUUID();
    const grantId = randomUUID();

    await db.insert(schema.employerApplicantAccessGrants).values({
      id: grantId,
      employerId: employerA,
      studentUserId: student,
      opportunityId: opportunity,
      grantedAt: new Date('2026-08-01T00:00:00Z'),
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    });

    await expect(hasEmployerApplicantAccess(db, employerA, opportunity, student, new Date('2026-08-15T00:00:00Z'))).resolves.toBe(true);
    await expect(hasEmployerApplicantAccess(db, employerB, opportunity, student, new Date('2026-08-15T00:00:00Z'))).resolves.toBe(false);
    await expect(hasEmployerApplicantAccess(db, employerA, opportunity, student, new Date('2026-10-01T00:00:00Z'))).resolves.toBe(false);
    await expect(db.insert(schema.employerApplicantAccessGrants).values({
      id: randomUUID(), employerId: institution, studentUserId: student, opportunityId: randomUUID(), grantedAt: new Date(),
    })).rejects.toThrow();
    await expect(db.update(schema.employerApplicantAccessGrants)
      .set({ employerId: institution })
      .where(eq(schema.employerApplicantAccessGrants.id, grantId))).rejects.toThrow();

    await db.update(schema.employerApplicantAccessGrants).set({ revokedAt: new Date('2026-08-16T00:00:00Z') }).where(eq(schema.employerApplicantAccessGrants.id, grantId));
    await expect(hasEmployerApplicantAccess(db, employerA, opportunity, student, new Date('2026-08-17T00:00:00Z'))).resolves.toBe(false);
    await expect(assertActiveEmployerGrantForMutation(db, employerA, opportunity, student, new Date('2026-08-17T00:00:00Z'))).rejects.toThrow('active employer applicant grant not found');
  });

  it('prevents duplicate active employer grants and requires employer scope for grant revocation', async () => {
    const student = await seedUser('student-grants@example.test');
    const employer = await seedOrg('EMPLOYER', 'Employer Grants');
    const otherEmployer = await seedOrg('EMPLOYER', 'Other Employer Grants');
    const actor = await seedUser('grant-actor@example.test');
    const opportunity = randomUUID();
    const now = new Date('2026-08-01T00:00:00Z');

    await createEmployerApplicantGrantWithAuditOutbox(db, {
      grantId: randomUUID(), employerId: employer, opportunityId: opportunity, studentUserId: student, grantedAt: now,
      audit: { id: randomUUID(), actorUserId: actor, action: 'employer.grant.created', resourceType: 'employer_applicant_grant', resourceId: opportunity, organizationId: employer, correlationId: 'corr-grant' },
      outbox: { id: randomUUID(), aggregateType: 'employer_applicant_grant', aggregateId: opportunity, eventType: 'employer.grant.created', payload: { opportunityId: opportunity }, actorUserId: actor, organizationId: employer, correlationId: 'corr-grant' },
    });

    await expect(createEmployerApplicantGrantWithAuditOutbox(db, {
      grantId: randomUUID(), employerId: employer, opportunityId: opportunity, studentUserId: student, grantedAt: now,
      audit: { id: randomUUID(), actorUserId: actor, action: 'employer.grant.created', resourceType: 'employer_applicant_grant', resourceId: opportunity, organizationId: employer, correlationId: 'corr-grant-dup' },
      outbox: { id: randomUUID(), aggregateType: 'employer_applicant_grant', aggregateId: opportunity, eventType: 'employer.grant.created', payload: { opportunityId: opportunity }, actorUserId: actor, organizationId: employer, correlationId: 'corr-grant-dup' },
    })).rejects.toThrow();

    const [grant] = await db.select().from(schema.employerApplicantAccessGrants).where(eq(schema.employerApplicantAccessGrants.opportunityId, opportunity));
    await expect(revokeEmployerApplicantGrantWithAuditOutbox(db, {
      grantId: grant!.id,
      employerId: otherEmployer,
      revokedAt: new Date('2026-08-02T00:00:00Z'),
      audit: { id: randomUUID(), actorUserId: actor, action: 'employer.grant.revoked', resourceType: 'employer_applicant_grant', resourceId: grant!.id, organizationId: otherEmployer, correlationId: 'corr-grant-wrong-employer' },
      outbox: { id: randomUUID(), aggregateType: 'employer_applicant_grant', aggregateId: grant!.id, eventType: 'employer.grant.revoked', payload: { grantId: grant!.id }, actorUserId: actor, organizationId: otherEmployer, correlationId: 'corr-grant-wrong-employer' },
    })).rejects.toThrow('active employer applicant grant not found');
    await expect(hasEmployerApplicantAccess(db, employer, opportunity, student, new Date('2026-08-02T12:00:00Z'))).resolves.toBe(true);

    await revokeEmployerApplicantGrantWithAuditOutbox(db, {
      grantId: grant!.id,
      employerId: employer,
      revokedAt: new Date('2026-08-02T00:00:00Z'),
      audit: { id: randomUUID(), actorUserId: actor, action: 'employer.grant.revoked', resourceType: 'employer_applicant_grant', resourceId: grant!.id, organizationId: employer, correlationId: 'corr-grant-revoke' },
      outbox: { id: randomUUID(), aggregateType: 'employer_applicant_grant', aggregateId: grant!.id, eventType: 'employer.grant.revoked', payload: { grantId: grant!.id }, actorUserId: actor, organizationId: employer, correlationId: 'corr-grant-revoke' },
    });

    await expect(createEmployerApplicantGrantWithAuditOutbox(db, {
      grantId: randomUUID(), employerId: employer, opportunityId: opportunity, studentUserId: student, grantedAt: new Date('2026-08-03T00:00:00Z'),
      audit: { id: randomUUID(), actorUserId: actor, action: 'employer.grant.created', resourceType: 'employer_applicant_grant', resourceId: opportunity, organizationId: employer, correlationId: 'corr-grant-new' },
      outbox: { id: randomUUID(), aggregateType: 'employer_applicant_grant', aggregateId: opportunity, eventType: 'employer.grant.created', payload: { opportunityId: opportunity }, actorUserId: actor, organizationId: employer, correlationId: 'corr-grant-new' },
    })).resolves.toBeUndefined();
  });

  it('accepts an invitation once and treats retry with the same idempotency key as a replay', async () => {
    const inviter = await seedUser('inviter@example.test');
    const institution = await seedOrg('INSTITUTION', 'Invite College');
    const invitationId = randomUUID();
    const userId = randomUUID();
    await db.insert(schema.invitations).values({
      id: invitationId,
      email: 'invitee@example.test',
      tokenHash: 'h'.repeat(64),
      state: 'PENDING',
      invitedByUserId: inviter,
      organizationId: institution,
      role: 'FACULTY_LECTURER',
      scopeOrganizationId: institution,
      scopeInstitutionId: institution,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    });

    const first = await acceptInvitationWithIdempotency(db, {
      invitationId,
      userId,
      externalSubject: `sub:${userId}`,
      now: new Date('2026-08-16T00:00:00Z'),
      idempotencyRecordId: randomUUID(),
      idempotencyScope: 'invitation.accept',
      idempotencyKey: 'idem-invite-1',
      requestHash: 'a'.repeat(64),
      membershipId: randomUUID(),
      auditId: randomUUID(),
      outboxEventId: randomUUID(),
      correlationId: 'corr-invite-1',
    });
    const second = await acceptInvitationWithIdempotency(db, {
      invitationId,
      userId: randomUUID(),
      externalSubject: `sub:${randomUUID()}`,
      now: new Date('2026-08-16T00:00:00Z'),
      idempotencyRecordId: randomUUID(),
      idempotencyScope: 'invitation.accept',
      idempotencyKey: 'idem-invite-1',
      requestHash: 'a'.repeat(64),
      membershipId: randomUUID(),
      auditId: randomUUID(),
      outboxEventId: randomUUID(),
      correlationId: 'corr-invite-1',
    });

    expect(first).toEqual({ userId, idempotentReplay: false });
    expect(second).toEqual({ userId, idempotentReplay: true });
    await expect(acceptInvitationWithIdempotency(db, {
      invitationId,
      userId: randomUUID(),
      externalSubject: `sub:${randomUUID()}`,
      now: new Date('2026-08-16T00:00:00Z'),
      idempotencyRecordId: randomUUID(),
      idempotencyScope: 'invitation.accept',
      idempotencyKey: 'idem-invite-1',
      requestHash: 'b'.repeat(64),
      membershipId: randomUUID(),
      auditId: randomUUID(),
      outboxEventId: randomUUID(),
      correlationId: 'corr-invite-1',
    })).rejects.toThrow('idempotency key reused with different request');
  });

  it('returns one logical result for concurrent identical invitation acceptance requests', async () => {
    const inviter = await seedUser('inviter-idempotent-race@example.test');
    const invitationId = randomUUID();
    const userId = randomUUID();
    await db.insert(schema.invitations).values({
      id: invitationId,
      email: 'idempotent-race@example.test',
      tokenHash: 'i'.repeat(64),
      state: 'PENDING',
      invitedByUserId: inviter,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    });

    const attempts = await Promise.allSettled([
      acceptInvitationWithIdempotency(db, {
        invitationId,
        userId,
        externalSubject: `sub:${userId}`,
        now: new Date('2026-08-16T00:00:00Z'),
        idempotencyRecordId: randomUUID(),
        idempotencyScope: 'invitation.accept',
        idempotencyKey: 'idem-same-concurrent',
        requestHash: 's'.repeat(64),
        auditId: randomUUID(),
        outboxEventId: randomUUID(),
        correlationId: 'corr-same-concurrent',
      }),
      acceptInvitationWithIdempotency(db, {
        invitationId,
        userId,
        externalSubject: `sub:${userId}`,
        now: new Date('2026-08-16T00:00:00Z'),
        idempotencyRecordId: randomUUID(),
        idempotencyScope: 'invitation.accept',
        idempotencyKey: 'idem-same-concurrent',
        requestHash: 's'.repeat(64),
        auditId: randomUUID(),
        outboxEventId: randomUUID(),
        correlationId: 'corr-same-concurrent',
      }),
    ]);

    expect(attempts.every((attempt) => attempt.status === 'fulfilled')).toBe(true);
    const values = attempts.map((attempt) => {
      if (attempt.status === 'rejected') throw attempt.reason;
      return attempt.value;
    });
    expect(values).toContainEqual({ userId, idempotentReplay: false });
    expect(values).toContainEqual({ userId, idempotentReplay: true });
    await expect(countById('users', userId)).resolves.toBe(1);
  });

  it('blocks invitation replay with a new idempotency key after consumption', async () => {
    const inviter = await seedUser('inviter-replay@example.test');
    const invitationId = randomUUID();
    await db.insert(schema.invitations).values({
      id: invitationId,
      email: 'replay@example.test',
      tokenHash: 'r'.repeat(64),
      state: 'PENDING',
      invitedByUserId: inviter,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    });

    await acceptInvitationWithIdempotency(db, {
      invitationId,
      userId: randomUUID(),
      externalSubject: `sub:${randomUUID()}`,
      now: new Date('2026-08-16T00:00:00Z'),
      idempotencyRecordId: randomUUID(),
      idempotencyScope: 'invitation.accept',
      idempotencyKey: 'idem-replay-1',
      requestHash: 'c'.repeat(64),
      auditId: randomUUID(),
      outboxEventId: randomUUID(),
      correlationId: 'corr-replay-1',
    });

    await expect(acceptInvitationWithIdempotency(db, {
      invitationId,
      userId: randomUUID(),
      externalSubject: `sub:${randomUUID()}`,
      now: new Date('2026-08-16T00:00:00Z'),
      idempotencyRecordId: randomUUID(),
      idempotencyScope: 'invitation.accept',
      idempotencyKey: 'idem-replay-2',
      requestHash: 'd'.repeat(64),
      auditId: randomUUID(),
      outboxEventId: randomUUID(),
      correlationId: 'corr-replay-2',
    })).rejects.toThrow('invitation is not usable');
  });

  it('allows only one concurrent invitation acceptance to succeed', async () => {
    const inviter = await seedUser('inviter-concurrent@example.test');
    const invitationId = randomUUID();
    await db.insert(schema.invitations).values({
      id: invitationId,
      email: 'concurrent@example.test',
      tokenHash: 'q'.repeat(64),
      state: 'PENDING',
      invitedByUserId: inviter,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    });

    const attempts = await Promise.allSettled([
      acceptInvitationWithIdempotency(db, {
        invitationId,
        userId: randomUUID(),
        externalSubject: `sub:${randomUUID()}`,
        now: new Date('2026-08-16T00:00:00Z'),
        idempotencyRecordId: randomUUID(),
        idempotencyScope: 'invitation.accept',
        idempotencyKey: 'idem-concurrent-1',
        requestHash: 'e'.repeat(64),
        auditId: randomUUID(),
        outboxEventId: randomUUID(),
        correlationId: 'corr-concurrent-1',
      }),
      acceptInvitationWithIdempotency(db, {
        invitationId,
        userId: randomUUID(),
        externalSubject: `sub:${randomUUID()}`,
        now: new Date('2026-08-16T00:00:00Z'),
        idempotencyRecordId: randomUUID(),
        idempotencyScope: 'invitation.accept',
        idempotencyKey: 'idem-concurrent-2',
        requestHash: 'f'.repeat(64),
        auditId: randomUUID(),
        outboxEventId: randomUUID(),
        correlationId: 'corr-concurrent-2',
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    const acceptedUsers = await pool.query<{ count: string }>('SELECT count(*) FROM users WHERE email = $1', ['concurrent@example.test']);
    expect(Number(acceptedUsers.rows[0]?.count ?? '0')).toBe(1);
  });

  it('rejects expired, revoked, short token-hash, and unsafe scoped invitations', async () => {
    const inviter = await seedUser('inviter-invalid@example.test');
    const employer = await seedOrg('EMPLOYER', 'Invite Employer');

    await db.insert(schema.invitations).values({
      id: randomUUID(), email: 'expired@example.test', tokenHash: 'x'.repeat(64), state: 'PENDING', invitedByUserId: inviter, expiresAt: new Date('2026-01-01T00:00:00Z'),
    });
    await db.insert(schema.invitations).values({
      id: randomUUID(), email: 'revoked@example.test', tokenHash: 'y'.repeat(64), state: 'REVOKED', invitedByUserId: inviter, expiresAt: new Date('2026-09-01T00:00:00Z'), revokedAt: new Date('2026-08-01T00:00:00Z'),
    });
    await expect(db.insert(schema.invitations).values({
      id: randomUUID(),
      email: 'raw-token@example.test',
      tokenHash: 'raw-token',
      state: 'PENDING',
      invitedByUserId: inviter,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    })).rejects.toThrow();
    await expect(db.insert(schema.invitations).values({
      id: randomUUID(),
      email: 'bad-scope@example.test',
      tokenHash: 'z'.repeat(64),
      state: 'PENDING',
      invitedByUserId: inviter,
      organizationId: employer,
      role: 'FACULTY_LECTURER',
      scopeOrganizationId: employer,
      scopeInstitutionId: employer,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    })).rejects.toThrow();
  });

  it('rejects unsafe invitation scope updates', async () => {
    const inviter = await seedUser('inviter-update-invalid@example.test');
    const institution = await seedOrg('INSTITUTION', 'Invite Update Institution');
    const employer = await seedOrg('EMPLOYER', 'Invite Update Employer');
    const invitationId = randomUUID();
    await db.insert(schema.invitations).values({
      id: invitationId,
      email: 'scope-update@example.test',
      tokenHash: 'u'.repeat(64),
      state: 'PENDING',
      invitedByUserId: inviter,
      organizationId: institution,
      role: 'FACULTY_LECTURER',
      scopeOrganizationId: institution,
      scopeInstitutionId: institution,
      expiresAt: new Date('2026-09-01T00:00:00Z'),
    });

    await expect(db.update(schema.invitations)
      .set({ scopeOrganizationId: employer })
      .where(eq(schema.invitations.id, invitationId))).rejects.toThrow();
  });

  it('commits membership suspension and outbox event atomically', async () => {
    const user = await seedUser('staff2@example.test');
    const institution = await seedOrg('INSTITUTION', 'College C');
    const actor = await seedUser('auditor@example.test');
    const membershipId = await seedInstitutionMembership(user, institution);
    const eventId = randomUUID();

    await suspendMembershipWithOutbox(db, {
      membershipId,
      organizationId: institution,
      eventId,
      audit: {
        id: randomUUID(), actorUserId: actor, action: 'organization_membership.suspended', resourceType: 'organization_membership', resourceId: membershipId, organizationId: institution, correlationId: 'corr-suspend',
      },
      correlationId: 'corr-suspend',
    });

    const [membership] = await db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.id, membershipId));
    const [event] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, eventId));
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.resourceId, membershipId));
    expect(membership?.state).toBe('SUSPENDED');
    expect(event?.eventType).toBe('organization_membership.suspended');
    expect(event?.correlationId).toBe('corr-suspend');
    expect(audits).toHaveLength(1);
  });

  it('requires organization scope for membership suspension repository mutation', async () => {
    const user = await seedUser('staff-scope-bypass@example.test');
    const actor = await seedUser('staff-scope-actor@example.test');
    const institutionA = await seedOrg('INSTITUTION', 'Scoped College A');
    const institutionB = await seedOrg('INSTITUTION', 'Scoped College B');
    const membershipId = await seedInstitutionMembership(user, institutionA);
    const eventId = randomUUID();
    const auditId = randomUUID();

    await expect(suspendMembershipWithOutbox(db, {
      membershipId,
      organizationId: institutionB,
      eventId,
      audit: {
        id: auditId, actorUserId: actor, action: 'organization_membership.suspended', resourceType: 'organization_membership', resourceId: membershipId, organizationId: institutionB, correlationId: 'corr-scope-bypass',
      },
      correlationId: 'corr-scope-bypass',
    })).rejects.toThrow('membership not found');

    const [membership] = await db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.id, membershipId));
    expect(membership?.state).toBe('ACTIVE');
    await expect(countById('outbox_events', eventId)).resolves.toBe(0);
    await expect(countById('audit_events', auditId)).resolves.toBe(0);
  });

  it('rolls back aggregate and audit writes when outbox persistence fails', async () => {
    const actor = await seedUser('role-actor@example.test');
    const target = await seedUser('role-target@example.test');
    const institution = await seedOrg('INSTITUTION', 'Atomic College');
    const membershipId = randomUUID();
    const auditId = randomUUID();
    const duplicateOutboxId = randomUUID();

    await db.insert(schema.outboxEvents).values({
      id: duplicateOutboxId,
      aggregateType: 'seed',
      aggregateId: zeroUuid,
      eventType: 'seed.created',
      payload: {},
      correlationId: 'seed',
    });

    await expect(assignOrganizationMembershipWithAuditOutbox(db, {
      membershipId,
      organizationId: institution,
      targetUserId: target,
      role: 'FACULTY_LECTURER',
      scope: { organizationId: institution, institutionId: institution },
      audit: { id: auditId, actorUserId: actor, action: 'organization.role.assigned', resourceType: 'organization_membership', resourceId: membershipId, organizationId: institution, correlationId: 'corr-rollback' },
      outbox: { id: duplicateOutboxId, aggregateType: 'organization_membership', aggregateId: membershipId, eventType: 'organization.role.assigned', payload: { membershipId }, actorUserId: actor, organizationId: institution, correlationId: 'corr-rollback' },
    })).rejects.toThrow();

    await expect(countById('organization_memberships', membershipId)).resolves.toBe(0);
    await expect(countById('audit_events', auditId)).resolves.toBe(0);
  });

  it('rejects unsupported outbox events before committing the domain transaction', async () => {
    const actor = await seedUser('unsupported-event-actor@example.test');
    const target = await seedUser('unsupported-event-target@example.test');
    const institution = await seedOrg('INSTITUTION', 'Unsupported Event College');
    const membershipId = randomUUID();
    const auditId = randomUUID();

    await expect(assignOrganizationMembershipWithAuditOutbox(db, {
      membershipId,
      organizationId: institution,
      targetUserId: target,
      role: 'FACULTY_LECTURER',
      scope: { organizationId: institution, institutionId: institution },
      audit: { id: auditId, actorUserId: actor, action: 'organization.role.assigned', resourceType: 'organization_membership', resourceId: membershipId, organizationId: institution, correlationId: 'corr-unsupported' },
      outbox: { id: randomUUID(), aggregateType: 'organization_membership', aggregateId: membershipId, eventType: 'organization.role.poisoned', payload: { membershipId }, actorUserId: actor, organizationId: institution, correlationId: 'corr-unsupported' },
    })).rejects.toThrow(/unsupported event schema/);

    await expect(countById('organization_memberships', membershipId)).resolves.toBe(0);
    await expect(countById('audit_events', auditId)).resolves.toBe(0);
  });

  it('rejects invalid audit correlation and outbox schema before commit', async () => {
    const actor = await seedUser('invalid-outbox-actor@example.test');
    const target = await seedUser('invalid-outbox-target@example.test');
    const institution = await seedOrg('INSTITUTION', 'Invalid Outbox College');
    const membershipId = randomUUID();

    await expect(assignOrganizationMembershipWithAuditOutbox(db, {
      membershipId,
      organizationId: institution,
      targetUserId: target,
      role: 'FACULTY_LECTURER',
      scope: { organizationId: institution, institutionId: institution },
      audit: { id: randomUUID(), actorUserId: actor, action: 'organization.role.assigned', resourceType: 'organization_membership', resourceId: membershipId, organizationId: institution, correlationId: 'bad quote"' },
      outbox: { id: randomUUID(), aggregateType: 'user', aggregateId: membershipId, eventType: 'organization.role.assigned', payload: { membershipId, role: 'FACULTY_LECTURER' }, actorUserId: actor, organizationId: institution, correlationId: 'bad quote"' },
    })).rejects.toThrow(/correlationId must match/);

    await expect(countById('organization_memberships', membershipId)).resolves.toBe(0);
  });

  it('claims outbox events in bounded batches with deterministic ordering and leases', async () => {
    const actor = await seedUser('outbox-actor@example.test');
    const organization = await seedOrg('INSTITUTION', 'Outbox College');
    const firstId = randomUUID();
    const secondId = randomUUID();
    const thirdId = randomUUID();
    const now = new Date('2026-08-18T00:00:00Z');

    await db.insert(schema.outboxEvents).values([
      {
        id: secondId,
        aggregateType: 'user',
        aggregateId: randomUUID(),
        eventType: 'identity.user.provisioned',
        payload: { userId: randomUUID() },
        actorUserId: actor,
        organizationId: organization,
        correlationId: randomUUID(),
        occurredAt: new Date('2026-08-18T00:00:02Z'),
        availableAt: now,
      },
      {
        id: firstId,
        aggregateType: 'user',
        aggregateId: randomUUID(),
        eventType: 'identity.user.provisioned',
        payload: { userId: randomUUID() },
        actorUserId: actor,
        organizationId: organization,
        correlationId: randomUUID(),
        occurredAt: new Date('2026-08-18T00:00:01Z'),
        availableAt: now,
      },
      {
        id: thirdId,
        aggregateType: 'user',
        aggregateId: randomUUID(),
        eventType: 'identity.user.provisioned',
        payload: { userId: randomUUID() },
        actorUserId: actor,
        organizationId: organization,
        correlationId: randomUUID(),
        occurredAt: new Date('2026-08-18T00:00:03Z'),
        availableAt: new Date('2026-08-19T00:00:00Z'),
      },
    ]);

    const firstClaim = await claimOutboxBatch(db, { leaseOwner: 'worker-a', batchSize: 2, leaseDurationMs: 30_000, now });
    expect(firstClaim.map((event) => event.id)).toEqual([firstId, secondId]);
    expect(firstClaim.every((event) => event.leaseOwner === 'worker-a' && event.attempts === 1)).toBe(true);

    const secondClaim = await claimOutboxBatch(db, { leaseOwner: 'worker-b', batchSize: 2, leaseDurationMs: 30_000, now });
    expect(secondClaim).toEqual([]);
  });

  it('reclaims abandoned outbox leases after expiry', async () => {
    const eventId = randomUUID();
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: randomUUID(),
      eventType: 'identity.user.provisioned',
      payload: { userId: randomUUID() },
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
      availableAt: new Date('2026-08-18T00:00:00Z'),
      deliveryState: 'PROCESSING',
      leaseOwner: 'dead-worker',
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date('2026-08-18T00:00:01Z'),
      attempts: 1,
    });

    const claimed = await claimOutboxBatch(db, {
      leaseOwner: 'worker-b',
      batchSize: 1,
      leaseDurationMs: 30_000,
      now: new Date('2026-08-18T00:00:02Z'),
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(eventId);
    expect(claimed[0]?.attempts).toBe(2);
    expect(claimed[0]?.leaseOwner).toBe('worker-b');
    expect(claimed[0]?.leaseToken).toMatch(/[0-9a-f-]{36}/);
  });

  it('does not let expiry sweeping clear an active PROCESSING lease', async () => {
    const eventId = randomUUID();
    const now = new Date('2026-08-18T00:00:10Z');
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: randomUUID(),
      eventType: 'identity.user.provisioned',
      payload: { userId: randomUUID() },
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
      availableAt: new Date('2026-08-18T00:00:00Z'),
      expiresAt: new Date('2026-08-18T00:00:05Z'),
      deliveryState: 'PROCESSING',
      leaseOwner: 'active-worker',
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date('2026-08-18T00:01:00Z'),
      attempts: 1,
    });

    await expect(markExpiredOutboxEvents(db, { now, limit: 10 })).resolves.toBe(0);
    const [row] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, eventId));
    expect(row?.deliveryState).toBe('PROCESSING');
    expect(row?.leaseOwner).toBe('active-worker');
  });

  it('publishes valid events and rejects stale lease completion', async () => {
    const eventId = randomUUID();
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: randomUUID(),
      eventType: 'identity.user.provisioned',
      payload: { userId: randomUUID() },
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
      availableAt: new Date('2026-08-18T00:00:00Z'),
    });

    const [claimed] = await claimOutboxBatch(db, {
      leaseOwner: 'worker-a',
      batchSize: 1,
      leaseDurationMs: 30_000,
      now: new Date('2026-08-18T00:00:01Z'),
    });
    expect(claimed).toBeDefined();
    await expect(markOutboxPublished(db, eventId, 'worker-b', claimed!.leaseToken, new Date('2026-08-18T00:00:02Z'), new Date('2026-08-18T00:00:02Z'))).resolves.toBe(false);

    const publisher = new InMemoryIntegrationEventPublisher();
    await dispatchClaimedOutboxEvent(db, claimed!, publisher, {
      leaseOwner: 'worker-a',
      leaseToken: claimed!.leaseToken,
      now: new Date('2026-08-18T00:00:02Z'),
      retryPolicy: { maxAttempts: 3, maxEventAgeMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0 },
    });

    expect(publisher.published).toHaveLength(1);
    const [row] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, eventId));
    expect(row?.deliveryState).toBe('PUBLISHED');
    expect(row?.leaseOwner).toBeNull();
    expect(row?.publishedAt).toBeInstanceOf(Date);
  });

  it('surfaces reconciliation when publish succeeds but the claimed row is stolen before acknowledgement', async () => {
    const eventId = randomUUID();
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: randomUUID(),
      eventType: 'identity.user.provisioned',
      payload: { userId: randomUUID() },
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
      availableAt: new Date('2026-08-18T00:00:00Z'),
    });
    const [claimed] = await claimOutboxBatch(db, { leaseOwner: 'worker-a', batchSize: 1, leaseDurationMs: 30_000, now: new Date('2026-08-18T00:00:01Z') });
    const publisher = {
      async publish() {
        await db.execute(sql`
          UPDATE outbox_events
          SET lease_token = ${randomUUID()}
          WHERE id = ${eventId}::uuid
        `);
      },
    };

    await expect(dispatchClaimedOutboxEvent(db, claimed!, publisher, {
      leaseOwner: claimed!.leaseOwner,
      leaseToken: claimed!.leaseToken,
      now: new Date('2026-08-18T00:00:02Z'),
      retryPolicy: { maxAttempts: 3, maxEventAgeMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0 },
    })).rejects.toBeInstanceOf(OutboxReconciliationRequiredError);
  });

  it('schedules retryable failures with deterministic exponential backoff and terminal states', async () => {
    expect(computeRetryDelayMs(3, { maxAttempts: 5, maxEventAgeMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.5, random: () => 0.5 })).toBe(5_000);

    const retryId = randomUUID();
    const terminalId = randomUUID();
    const now = new Date('2026-08-18T00:00:00Z');
    await db.insert(schema.outboxEvents).values([
      {
        id: retryId,
        aggregateType: 'user',
        aggregateId: randomUUID(),
        eventType: 'identity.user.provisioned',
        payload: { userId: randomUUID() },
        correlationId: randomUUID(),
        occurredAt: now,
        availableAt: now,
      },
      {
        id: terminalId,
        aggregateType: 'user',
        aggregateId: randomUUID(),
        eventType: 'identity.user.provisioned',
        payload: { userId: randomUUID() },
        correlationId: randomUUID(),
        occurredAt: new Date('2026-08-18T00:00:01Z'),
        availableAt: now,
      },
    ]);

    const [retryClaim] = await claimOutboxBatch(db, { leaseOwner: 'worker-a', batchSize: 1, leaseDurationMs: 30_000, now });
    expect(retryClaim?.id).toBe(retryId);
    const retryPublisher = new InMemoryIntegrationEventPublisher();
    retryPublisher.failNext = new OutboxPublishError('provider timeout', true);
    await dispatchClaimedOutboxEvent(db, retryClaim!, retryPublisher, {
      leaseOwner: 'worker-a',
      leaseToken: retryClaim!.leaseToken,
      now,
      retryPolicy: { maxAttempts: 3, maxEventAgeMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0 },
    });
    const [retryRow] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, retryId));
    expect(retryRow?.deliveryState).toBe('PENDING');
    expect(retryRow?.lastFailureClass).toBe('RETRYABLE_PUBLISH_FAILURE');
    expect(retryRow?.availableAt.toISOString()).toBe('2026-08-18T00:00:01.000Z');

    const [terminalClaim] = await claimOutboxBatch(db, { leaseOwner: 'worker-b', batchSize: 1, leaseDurationMs: 30_000, now });
    expect(terminalClaim?.id).toBe(terminalId);
    const terminalPublisher = new InMemoryIntegrationEventPublisher();
    terminalPublisher.failNext = new OutboxPublishError('bad destination', false);
    await dispatchClaimedOutboxEvent(db, terminalClaim!, terminalPublisher, {
      leaseOwner: 'worker-b',
      leaseToken: terminalClaim!.leaseToken,
      now,
      retryPolicy: { maxAttempts: 3, maxEventAgeMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0 },
    });
    const [terminalRow] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, terminalId));
    expect(terminalRow?.deliveryState).toBe('FAILED');
    expect(terminalRow?.lastFailureClass).toBe('TERMINAL_PUBLISH_FAILURE');
    expect(JSON.stringify(terminalRow)).not.toContain('Error:');
  });

  it('treats attempts as claims and does not publish after a final-attempt crash is reclaimed', async () => {
    const eventId = randomUUID();
    const eventUserId = randomUUID();
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: eventUserId,
      eventType: 'identity.user.provisioned',
      payload: { userId: eventUserId },
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
      availableAt: new Date('2026-08-18T00:00:00Z'),
      deliveryState: 'PROCESSING',
      leaseOwner: 'crashed-worker',
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date('2026-08-18T00:00:01Z'),
      attempts: 2,
    });

    const [claimed] = await claimOutboxBatch(db, {
      leaseOwner: 'reclaimer',
      batchSize: 1,
      leaseDurationMs: 30_000,
      now: new Date('2026-08-18T00:00:02Z'),
    });
    expect(claimed?.attempts).toBe(3);

    const publisher = new InMemoryIntegrationEventPublisher();
    await expect(dispatchClaimedOutboxEvent(db, claimed!, publisher, {
      leaseOwner: 'reclaimer',
      leaseToken: claimed!.leaseToken,
      now: new Date('2026-08-18T00:00:02Z'),
      retryPolicy: { maxAttempts: 2, maxEventAgeMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0 },
    })).resolves.toBe('TERMINAL_FAILURE');
    expect(publisher.published).toHaveLength(0);
  });

  it('persists only fixed safe terminal failure messages', async () => {
    const eventId = randomUUID();
    const leaseToken = randomUUID();
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: randomUUID(),
      eventType: 'identity.user.provisioned',
      payload: { userId: randomUUID() },
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
      deliveryState: 'PROCESSING',
      leaseOwner: 'worker-safe-failure',
      leaseToken,
      leaseExpiresAt: new Date('2026-08-18T00:01:00Z'),
      attempts: 1,
    });

    await markOutboxTerminalFailure(db, eventId, 'worker-safe-failure', leaseToken, new Date('2026-08-18T00:00:10Z'), 'TERMINAL_PUBLISH_FAILURE');
    const [row] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, eventId));
    expect(row?.lastFailureMessage).toBe('publisher terminal failure');
    expect(JSON.stringify(row)).not.toContain('secret');
    expect(JSON.stringify(row)).not.toContain('@');
  });

  it('marks expired events failed without publishing and rejects incompatible schemas', async () => {
    const expiredId = randomUUID();
    const invalidId = randomUUID();
    const now = new Date('2026-08-18T00:00:00Z');
    await db.insert(schema.outboxEvents).values([
      {
        id: expiredId,
        aggregateType: 'user',
        aggregateId: randomUUID(),
        eventType: 'identity.user.provisioned',
        payload: { userId: randomUUID() },
        correlationId: randomUUID(),
        occurredAt: new Date('2026-08-17T00:00:00Z'),
        availableAt: now,
        expiresAt: new Date('2026-08-17T00:05:00Z'),
      },
      {
        id: invalidId,
        aggregateType: 'user',
        aggregateId: randomUUID(),
        eventType: 'identity.unknown',
        payload: {},
        correlationId: randomUUID(),
        occurredAt: now,
        availableAt: now,
      },
    ]);

    await expect(markExpiredOutboxEvents(db, { now, limit: 10 })).resolves.toBe(1);
    const [expiredRow] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, expiredId));
    expect(expiredRow?.deliveryState).toBe('FAILED');
    expect(expiredRow?.lastFailureClass).toBe('EVENT_EXPIRED');

    const claims = await claimOutboxBatch(db, { leaseOwner: 'worker-a', batchSize: 2, leaseDurationMs: 30_000, now });
    const publisher = new InMemoryIntegrationEventPublisher();
    for (const event of claims) {
      await dispatchClaimedOutboxEvent(db, event, publisher, { leaseOwner: 'worker-a', leaseToken: event.leaseToken, now });
    }

    expect(publisher.published).toHaveLength(0);
    const [invalidRow] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, invalidId));
    expect(invalidRow?.deliveryState).toBe('FAILED');
    expect(invalidRow?.lastFailureClass).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('records audited replay without changing event identity or payload and preserves consumer idempotency', async () => {
    const actor = await seedUser('replay-actor@example.test');
    const eventId = randomUUID();
    const payload = { userId: randomUUID() };
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: payload.userId,
      eventType: 'identity.user.provisioned',
      payload,
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
      deliveryState: 'FAILED',
      lastFailureClass: 'TERMINAL_PUBLISH_FAILURE',
    });

    const first = await handleEventIdempotently(db, {
      consumerName: 'projection-a',
      eventId,
      effect: async (tx) => {
        await tx.execute(sql`SELECT 1`);
        return 'done';
      },
    });
    const second = await handleEventIdempotently(db, {
      consumerName: 'projection-a',
      eventId,
      effect: async () => {
        throw new Error('should not run');
      },
    });
    const otherConsumer = await handleEventIdempotently(db, {
      consumerName: 'projection-b',
      eventId,
      effect: async () => 'other',
    });

    expect(first).toEqual({ executed: true, result: 'done' });
    expect(second).toEqual({ executed: false });
    expect(otherConsumer).toEqual({ executed: true, result: 'other' });

    await expect(replayOutboxEvent(db, {
      eventId,
      actorUserId: actor,
      reasonCode: 'PROVIDER_OUTAGE',
      ticketReference: 'INC-123',
      auditId: randomUUID(),
      now: new Date('2026-08-18T00:05:00Z'),
    })).resolves.toBe(true);

    const [event] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, eventId));
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.resourceId, eventId));
    expect(event?.id).toBe(eventId);
    expect(event?.payload).toEqual(payload);
    expect(event?.deliveryState).toBe('PENDING');
    expect(audits).toHaveLength(1);

    const replayConsumer = await handleEventIdempotently(db, {
      consumerName: 'projection-a',
      eventId,
      effect: async () => {
        throw new Error('replay should remain idempotent');
      },
    });
    expect(replayConsumer).toEqual({ executed: false });
  });

  it('rejects replay for pending, active processing, published, and expired failed events', async () => {
    const actor = await seedUser('replay-states-actor@example.test');
    const now = new Date('2026-08-18T00:05:00Z');
    const rows = [
      { id: randomUUID(), deliveryState: 'PENDING' as const },
      { id: randomUUID(), deliveryState: 'PROCESSING' as const, leaseOwner: 'worker', leaseToken: randomUUID(), leaseExpiresAt: new Date('2026-08-18T00:10:00Z') },
      { id: randomUUID(), deliveryState: 'PUBLISHED' as const },
      { id: randomUUID(), deliveryState: 'FAILED' as const, expiresAt: new Date('2026-08-18T00:00:00Z'), lastFailureClass: 'TERMINAL_PUBLISH_FAILURE' },
    ];
    for (const row of rows) {
      const userId = randomUUID();
      await db.insert(schema.outboxEvents).values({
        id: row.id,
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'identity.user.provisioned',
        payload: { userId },
        correlationId: randomUUID(),
        occurredAt: new Date('2026-08-18T00:00:00Z'),
        deliveryState: row.deliveryState,
        ...(row.deliveryState === 'PUBLISHED' ? { publishedAt: now } : {}),
        ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
        ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
        ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
        ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
        ...(row.lastFailureClass ? { lastFailureClass: row.lastFailureClass } : {}),
      });
      await expect(replayOutboxEvent(db, {
        eventId: row.id,
        actorUserId: actor,
        reasonCode: 'RETRY_BLOCKED',
        ticketReference: 'INC-REPLAY-1',
        auditId: randomUUID(),
        now,
      })).resolves.toBe(false);
    }
  });

  it('persists consumer failure receipt while rolling back failed effect writes and allows retry', async () => {
    const actor = await seedUser('consumer-failure-actor@example.test');
    const eventId = randomUUID();
    const auditId = randomUUID();
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: actor,
      eventType: 'identity.user.provisioned',
      payload: { userId: actor },
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
    });

    await expect(handleEventIdempotently(db, {
      consumerName: 'projection-failure',
      eventId,
      failureClass: 'projection failed with raw details that should be bounded and redacted',
      effect: async (tx) => {
        await tx.insert(schema.auditEvents).values({
          id: auditId,
          actorUserId: actor,
          action: 'consumer.side.effect',
          resourceType: 'outbox_event',
          resourceId: eventId,
          outcome: 'SUCCESS',
          correlationId: 'consumer-fail-1',
        });
        throw new Error('boom with secret@example.test');
      },
    })).rejects.toBeInstanceOf(EventConsumerEffectError);

    const failedReceipts = await db.select().from(schema.eventConsumerReceipts).where(eq(schema.eventConsumerReceipts.eventId, eventId));
    const failedAudit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, auditId));
    expect(failedReceipts).toHaveLength(1);
    expect(failedReceipts[0]?.status).toBe('FAILED');
    expect(failedReceipts[0]?.attempts).toBe(1);
    expect(failedReceipts[0]?.lastFailureClass).not.toContain('secret');
    expect(failedAudit).toHaveLength(0);

    const retry = await handleEventIdempotently(db, {
      consumerName: 'projection-failure',
      eventId,
      effect: async () => 'ok',
    });
    const [receipt] = await db.select().from(schema.eventConsumerReceipts).where(eq(schema.eventConsumerReceipts.eventId, eventId));
    expect(retry).toEqual({ executed: true, result: 'ok' });
    expect(receipt?.status).toBe('SUCCEEDED');
    expect(receipt?.attempts).toBe(2);
  });

  it('executes only one concurrent consumer effect for duplicate deliveries', async () => {
    const actor = await seedUser('consumer-concurrent-actor@example.test');
    const eventId = randomUUID();
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: actor,
      eventType: 'identity.user.provisioned',
      payload: { userId: actor },
      correlationId: randomUUID(),
      occurredAt: new Date('2026-08-18T00:00:00Z'),
    });

    const effectAuditId = randomUUID();
    const results = await Promise.all([
      handleEventIdempotently(db, {
        consumerName: 'projection-concurrent',
        eventId,
        effect: async (tx) => {
          await tx.execute(sql`SELECT pg_sleep(0.1)`);
          await tx.insert(schema.auditEvents).values({
            id: effectAuditId,
            actorUserId: actor,
            action: 'consumer.concurrent.effect',
            resourceType: 'outbox_event',
            resourceId: eventId,
            outcome: 'SUCCESS',
            correlationId: 'consumer-concurrent-1',
          });
          return 'first';
        },
      }),
      handleEventIdempotently(db, {
        consumerName: 'projection-concurrent',
        eventId,
        effect: async () => 'second',
      }),
    ]);

    expect(results.filter((result) => result.executed)).toHaveLength(1);
    const [receipt] = await db.select().from(schema.eventConsumerReceipts).where(eq(schema.eventConsumerReceipts.eventId, eventId));
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, effectAuditId));
    expect(receipt?.status).toBe('SUCCEEDED');
    expect(audits).toHaveLength(1);
  });

  it('allows only one concurrent duplicate role assignment to commit', async () => {
    const actor = await seedUser('role-race-actor@example.test');
    const target = await seedUser('role-race-target@example.test');
    const institution = await seedOrg('INSTITUTION', 'Race College');

    const firstMembershipId = randomUUID();
    const secondMembershipId = randomUUID();
    const attempts = await Promise.allSettled([
      assignOrganizationMembershipWithAuditOutbox(db, {
        membershipId: firstMembershipId, organizationId: institution, targetUserId: target, role: 'PLACEMENT_ADMIN', scope: { organizationId: institution, institutionId: institution },
        audit: { id: randomUUID(), actorUserId: actor, action: 'organization.role.assigned', resourceType: 'organization_membership', resourceId: firstMembershipId, organizationId: institution, correlationId: 'race-1-ok' },
        outbox: { id: randomUUID(), aggregateType: 'organization_membership', aggregateId: firstMembershipId, eventType: 'organization.role.assigned', payload: { membershipId: firstMembershipId, role: 'PLACEMENT_ADMIN' }, actorUserId: actor, organizationId: institution, correlationId: 'race-1-ok' },
      }),
      assignOrganizationMembershipWithAuditOutbox(db, {
        membershipId: secondMembershipId, organizationId: institution, targetUserId: target, role: 'PLACEMENT_ADMIN', scope: { organizationId: institution, institutionId: institution },
        audit: { id: randomUUID(), actorUserId: actor, action: 'organization.role.assigned', resourceType: 'organization_membership', resourceId: secondMembershipId, organizationId: institution, correlationId: 'race-2-ok' },
        outbox: { id: randomUUID(), aggregateType: 'organization_membership', aggregateId: secondMembershipId, eventType: 'organization.role.assigned', payload: { membershipId: secondMembershipId, role: 'PLACEMENT_ADMIN' }, actorUserId: actor, organizationId: institution, correlationId: 'race-2-ok' },
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
  });

  it('enforces database temporal and revocation constraints', async () => {
    const student = await seedUser('student3@example.test');
    const institution = await seedOrg('INSTITUTION', 'College D');
    const employer = await seedOrg('EMPLOYER', 'Temporal Employer');
    await expect(db.insert(schema.institutionRelationships).values({
      id: randomUUID(),
      institutionId: institution,
      studentUserId: student,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      effectiveTo: new Date('2026-07-01T00:00:00Z'),
    })).rejects.toThrow();
    await expect(db.insert(schema.employerApplicantAccessGrants).values({
      id: randomUUID(),
      employerId: employer,
      studentUserId: student,
      opportunityId: randomUUID(),
      grantedAt: new Date('2026-08-01T00:00:00Z'),
      revokedAt: new Date('2026-07-01T00:00:00Z'),
    })).rejects.toThrow();
  });
});
