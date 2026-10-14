import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema.js';
import { assertEmployerApplicantAccessForAuthenticatedPrincipal } from '../src/employer-authentication.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

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

async function seedEmployer(legalName: string) {
  const id = randomUUID();
  await db.insert(schema.organizations).values({ id, kind: 'EMPLOYER', legalName, verificationState: 'VERIFIED' });
  return id;
}

async function seedEmployerMembership(input: {
  readonly userId: string;
  readonly employerId: string;
  readonly state?: 'ACTIVE' | 'SUSPENDED';
  readonly role?: 'EMPLOYER_OWNER' | 'EMPLOYER_ADMIN' | 'RECRUITER';
}) {
  await db.insert(schema.organizationMemberships).values({
    id: randomUUID(),
    organizationId: input.employerId,
    userId: input.userId,
    role: input.role ?? 'RECRUITER',
    state: input.state ?? 'ACTIVE',
    scopeOrganizationId: input.employerId,
    scopeEmployerId: input.employerId,
  });
}

async function seedEmployerGrant(input: {
  readonly employerId: string;
  readonly studentUserId: string;
  readonly opportunityId: string;
  readonly revokedAt?: Date;
  readonly expiresAt?: Date;
}) {
  await db.insert(schema.employerApplicantAccessGrants).values({
    id: randomUUID(),
    employerId: input.employerId,
    studentUserId: input.studentUserId,
    opportunityId: input.opportunityId,
    grantedAt: new Date('2026-08-15T00:00:00Z'),
    ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE
      idempotency_records,
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

describe('employer applicant access authentication guard', () => {
  it('requires an active employer membership and active applicant grant for the same employer', async () => {
    const recruiterId = await seedUser('recruiter@example.test', 'sub:recruiter');
    const studentId = await seedUser('student@example.test', 'sub:student');
    const employerId = await seedEmployer('Employer A');
    const otherEmployerId = await seedEmployer('Employer B');
    const opportunityId = randomUUID();

    await seedEmployerMembership({ userId: recruiterId, employerId });
    await seedEmployerGrant({ employerId, studentUserId: studentId, opportunityId });

    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, {
      actorUserId: recruiterId,
      employerId,
      opportunityId,
      studentUserId: studentId,
      now: new Date('2026-08-16T00:00:00Z'),
    })).resolves.toBeUndefined();

    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, {
      actorUserId: recruiterId,
      employerId: otherEmployerId,
      opportunityId,
      studentUserId: studentId,
      now: new Date('2026-08-16T00:00:00Z'),
    })).rejects.toThrow('employer applicant access not found');
  });

  it('allows a valid actor with multiple qualifying employer roles for the same grant', async () => {
    const recruiterId = await seedUser('multi-role@example.test', 'sub:multi-role');
    const studentId = await seedUser('student-multi-role@example.test', 'sub:student-multi-role');
    const employerId = await seedEmployer('Multi Role Employer');
    const opportunityId = randomUUID();

    await seedEmployerMembership({ userId: recruiterId, employerId, role: 'RECRUITER' });
    await seedEmployerMembership({ userId: recruiterId, employerId, role: 'EMPLOYER_ADMIN' });
    await seedEmployerGrant({ employerId, studentUserId: studentId, opportunityId });

    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, {
      actorUserId: recruiterId,
      employerId,
      opportunityId,
      studentUserId: studentId,
      now: new Date('2026-08-16T00:00:00Z'),
    })).resolves.toBeUndefined();
  });

  it('denies suspended employer memberships and revoked or expired grants', async () => {
    const recruiterId = await seedUser('recruiter2@example.test', 'sub:recruiter2');
    const studentId = await seedUser('student2@example.test', 'sub:student2');
    const suspendedEmployerId = await seedEmployer('Suspended Membership Employer');
    const revokedEmployerId = await seedEmployer('Revoked Grant Employer');
    const expiredEmployerId = await seedEmployer('Expired Grant Employer');
    const opportunityId = randomUUID();

    await seedEmployerMembership({ userId: recruiterId, employerId: suspendedEmployerId, state: 'SUSPENDED' });
    await seedEmployerMembership({ userId: recruiterId, employerId: revokedEmployerId });
    await seedEmployerMembership({ userId: recruiterId, employerId: expiredEmployerId });
    await seedEmployerGrant({ employerId: suspendedEmployerId, studentUserId: studentId, opportunityId });
    await seedEmployerGrant({
      employerId: revokedEmployerId,
      studentUserId: studentId,
      opportunityId,
      revokedAt: new Date('2026-08-15T12:00:00Z'),
    });
    await seedEmployerGrant({
      employerId: expiredEmployerId,
      studentUserId: studentId,
      opportunityId,
      expiresAt: new Date('2026-08-15T12:00:00Z'),
    });

    for (const employerId of [suspendedEmployerId, revokedEmployerId, expiredEmployerId]) {
      await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, {
        actorUserId: recruiterId,
        employerId,
        opportunityId,
        studentUserId: studentId,
        now: new Date('2026-08-16T00:00:00Z'),
        lockForMutation: true,
      })).rejects.toThrow('employer applicant access not found');
    }
  });
});

describe('employer applicant access follows the organisation state (EMP-03)', () => {
  it.each([
    ['SUSPENDED', false],
    ['REJECTED', true],
    ['PENDING', true],
    ['UNDER_REVIEW', true],
  ] as const)('refuses a live grant while the employer is %s', async (verificationState, active) => {
    const recruiterId = await seedUser(`recruiter-${verificationState.toLowerCase()}@example.test`);
    const studentId = await seedUser(`student-${verificationState.toLowerCase()}@example.test`);
    const employerId = await seedEmployer(`Employer ${verificationState}`);
    const opportunityId = randomUUID();
    await seedEmployerMembership({ userId: recruiterId, employerId });
    await seedEmployerGrant({ employerId, studentUserId: studentId, opportunityId });
    const input = { actorUserId: recruiterId, employerId, opportunityId, studentUserId: studentId, now: new Date('2026-08-16T00:00:00Z') };
    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, input)).resolves.toBeUndefined();

    await pool.query('UPDATE organizations SET verification_state = $2::verification_state, active = $3 WHERE id = $1', [employerId, verificationState, active]);
    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, input)).rejects.toThrow('employer applicant access not found');
    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, { ...input, lockForMutation: true })).rejects.toThrow('employer applicant access not found');
  });
});

describe('employer applicant access ends while the student account is in deletion (EMP-SR-02)', () => {
  it('refuses a live grant during an open deletion request, restores it on cancellation, and refuses it once the account is deleted', async () => {
    const recruiterId = await seedUser('recruiter-deletion@example.test');
    const studentId = await seedUser('student-deletion@example.test');
    const employerId = await seedEmployer('Deletion Employer');
    const opportunityId = randomUUID();
    await seedEmployerMembership({ userId: recruiterId, employerId });
    await seedEmployerGrant({ employerId, studentUserId: studentId, opportunityId });
    const input = { actorUserId: recruiterId, employerId, opportunityId, studentUserId: studentId, now: new Date('2026-08-16T00:00:00Z') };
    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, input)).resolves.toBeUndefined();

    const requestId = randomUUID();
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() + interval '30 days')`, [requestId, studentId]);
    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, input)).rejects.toThrow('employer applicant access not found');

    await pool.query(`UPDATE privacy_requests SET state = 'CANCELLED', cancelled_at = now() WHERE id = $1`, [requestId]);
    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, input)).resolves.toBeUndefined();

    await pool.query(`UPDATE users SET state = 'DELETED' WHERE id = $1`, [studentId]);
    await expect(assertEmployerApplicantAccessForAuthenticatedPrincipal(db, input)).rejects.toThrow('employer applicant access not found');
  });
});
