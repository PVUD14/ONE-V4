import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../src/schema.js';
import {
  acceptInvitationByTokenHashForVerifiedRecipientWithIdempotency,
  findIdentityByExternalSubject,
  loadActiveMembershipsForUser,
} from '../src/identity-authentication.js';

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

async function seedUser(email: string, externalSubject: string | null = `sub:${randomUUID()}`, state: 'INVITED' | 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject, email, state });
  return id;
}

async function seedOrg(kind: 'PLATFORM' | 'INSTITUTION' | 'EMPLOYER', legalName: string) {
  const id = randomUUID();
  await db.insert(schema.organizations).values({ id, kind, legalName, verificationState: 'VERIFIED' });
  return id;
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

describe('managed identity persistence adapters', () => {
  it('maps external subjects through database-backed internal identity state', async () => {
    const activeUserId = await seedUser('active@example.test', 'sub:active');
    await seedUser('suspended@example.test', 'sub:suspended', 'SUSPENDED');

    await expect(findIdentityByExternalSubject(db, 'sub:active')).resolves.toEqual({
      id: activeUserId,
      externalSubject: 'sub:active',
      state: 'ACTIVE',
    });
    await expect(findIdentityByExternalSubject(db, 'sub:missing')).resolves.toBeNull();
  });

  it('loads only current active memberships for authorization context construction', async () => {
    const userId = await seedUser('member@example.test', 'sub:member');
    const institutionId = await seedOrg('INSTITUTION', 'College A');
    const otherInstitutionId = await seedOrg('INSTITUTION', 'College B');
    await db.insert(schema.organizationMemberships).values({
      id: randomUUID(),
      organizationId: institutionId,
      userId,
      role: 'INSTITUTION_ADMIN',
      state: 'ACTIVE',
      scopeOrganizationId: institutionId,
      scopeInstitutionId: institutionId,
    });
    await db.insert(schema.organizationMemberships).values({
      id: randomUUID(),
      organizationId: otherInstitutionId,
      userId,
      role: 'INSTITUTION_ADMIN',
      state: 'SUSPENDED',
      scopeOrganizationId: otherInstitutionId,
      scopeInstitutionId: otherInstitutionId,
    });

    await expect(loadActiveMembershipsForUser(db, userId)).resolves.toEqual([
      expect.objectContaining({ organizationId: institutionId, state: 'ACTIVE', scope: { organizationId: institutionId, institutionId } }),
    ]);
  });

  it('accepts an invitation only for the verified recipient email bound to the token digest', async () => {
    const inviterId = await seedUser('admin@example.test', 'sub:admin');
    const institutionId = await seedOrg('INSTITUTION', 'College A');
    await db.insert(schema.invitations).values({
      id: randomUUID(),
      email: 'Student@Example.Test',
      tokenHash: 'a'.repeat(64),
      state: 'PENDING',
      invitedByUserId: inviterId,
      organizationId: institutionId,
      role: 'INSTITUTION_ADMIN',
      scopeOrganizationId: institutionId,
      scopeInstitutionId: institutionId,
      expiresAt: new Date('2026-12-31T00:00:00Z'),
    });

    await expect(acceptInvitationByTokenHashForVerifiedRecipientWithIdempotency(db, {
      invitationTokenHash: 'a'.repeat(64),
      normalizedRecipientEmail: 'attacker@example.test',
      userId: randomUUID(),
      externalSubject: 'sub:attacker',
      now: new Date('2026-08-16T00:00:00Z'),
      idempotencyRecordId: randomUUID(),
      idempotencyScope: 'invitation:accept',
      idempotencyKey: 'wrong-recipient',
      requestHash: 'b'.repeat(64),
      membershipId: randomUUID(),
      auditId: randomUUID(),
      outboxEventId: randomUUID(),
      correlationId: 'corr-wrong-recipient',
    })).rejects.toThrow('invitation is not usable');

    const newUserId = randomUUID();
    const result = await acceptInvitationByTokenHashForVerifiedRecipientWithIdempotency(db, {
      invitationTokenHash: 'a'.repeat(64),
      normalizedRecipientEmail: 'student@example.test',
      userId: newUserId,
      externalSubject: 'sub:student',
      now: new Date('2026-08-16T00:00:00Z'),
      idempotencyRecordId: randomUUID(),
      idempotencyScope: 'invitation:accept',
      idempotencyKey: 'right-recipient',
      requestHash: 'c'.repeat(64),
      membershipId: randomUUID(),
      auditId: randomUUID(),
      outboxEventId: randomUUID(),
      correlationId: 'corr-right-recipient',
    });

    expect(result).toEqual({ userId: newUserId, idempotentReplay: false });
    await expect(db.select().from(schema.users).where(eq(schema.users.externalSubject, 'sub:student'))).resolves.toHaveLength(1);
    const outbox = await db.select().from(schema.outboxEvents);
    const audit = await db.select().from(schema.auditEvents);
    expect(JSON.stringify(outbox)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(audit)).not.toContain('a'.repeat(64));
  });

  it('prevents invitation replay and duplicate external-subject mapping through persistence constraints', async () => {
    const inviterId = await seedUser('admin2@example.test', 'sub:admin2');
    const existingUserId = await seedUser('existing@example.test', 'sub:existing');
    await db.insert(schema.invitations).values({
      id: randomUUID(),
      email: 'existing@example.test',
      tokenHash: 'd'.repeat(64),
      state: 'PENDING',
      invitedByUserId: inviterId,
      expiresAt: new Date('2026-12-31T00:00:00Z'),
    });

    await expect(acceptInvitationByTokenHashForVerifiedRecipientWithIdempotency(db, {
      invitationTokenHash: 'd'.repeat(64),
      normalizedRecipientEmail: 'existing@example.test',
      userId: randomUUID(),
      externalSubject: 'sub:existing',
      now: new Date('2026-08-16T00:00:00Z'),
      idempotencyRecordId: randomUUID(),
      idempotencyScope: 'invitation:accept',
      idempotencyKey: 'duplicate-subject',
      requestHash: 'e'.repeat(64),
      auditId: randomUUID(),
      outboxEventId: randomUUID(),
      correlationId: 'corr-duplicate-subject',
    })).rejects.toThrow();

    await expect(db.select().from(schema.users).where(eq(schema.users.id, existingUserId))).resolves.toHaveLength(1);
  });
});
