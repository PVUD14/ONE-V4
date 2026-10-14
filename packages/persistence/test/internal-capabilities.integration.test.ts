/**
 * Internal capability grant rules at the database (OPS-01, migration 0039).
 *
 * ADR-032 says internal capabilities are grantable only inside the ONE platform
 * organisation, never to oneself, and never survive a role change. Those sentences are
 * only true if the database refuses the rest, so these tests write rows directly — not
 * through the API — and expect the trigger to stop them.
 *
 * Runs in its own schema because the role-change path commits its own transaction.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { refuseInternalCapabilityGrant } from '@planthepath/authorization/src/index.js';
import {
  PlatformControlError,
  changeMembershipRole,
  grantInternalCapability,
  listPlatformStaff,
  loadLiveCapabilityGrants,
  revokeInternalCapability,
} from '../src/platform-controls.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const schemaName = 'internal_caps_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const migrationDir = new URL('../drizzle/', import.meta.url);

let platformId: string;
let institutionId: string;
let superAdmin: { userId: string; membershipId: string };
let operations: { userId: string; membershipId: string };
let security: { userId: string; membershipId: string };
let faculty: { userId: string; membershipId: string };
let institutionAdmin: { userId: string; membershipId: string };

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
}, 180_000);

afterAll(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function member(role: string, organizationId: string, institutional: boolean): Promise<{ userId: string; membershipId: string }> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  await pool.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(
    `INSERT INTO organization_memberships (id, organization_id, user_id, role, state, scope_organization_id, scope_institution_id)
     VALUES ($1,$2,$3,$4,'ACTIVE',$2,$5)`,
    [membershipId, organizationId, userId, role, institutional ? organizationId : null],
  );
  return { userId, membershipId };
}

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  await pool.query('TRUNCATE organizations CASCADE');
  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'PLATFORM', 'ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', 'Capability college')", [institutionId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN', platformId, false);
  operations = await member('OPERATIONS_ADMIN', platformId, false);
  security = await member('SECURITY_ADMIN', platformId, false);
  faculty = await member('FACULTY_LECTURER', institutionId, true);
  institutionAdmin = await member('INSTITUTION_ADMIN', institutionId, true);
});

const insert = (membershipId: string, capability: string, grantedBy: string) => pool.query(
  `INSERT INTO membership_capabilities (id, membership_id, capability, granted_by_user_id, reason_code)
   VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')`, [randomUUID(), membershipId, capability, grantedBy],
);

describe('internal capability vocabulary and grant rules (0039)', () => {
  it('accepts SUPPORT_CASES on a platform membership', async () => {
    await insert(security.membershipId, 'SUPPORT_CASES', superAdmin.userId);
    const grants = await loadLiveCapabilityGrants(pool, [security.membershipId]);
    expect(grants.get(security.membershipId)).toEqual(['SUPPORT_CASES']);
  });

  it('refuses SUPPORT_CASES on an institution membership at the database', async () => {
    await expect(insert(institutionAdmin.membershipId, 'SUPPORT_CASES', superAdmin.userId))
      .rejects.toThrow(/may be granted only to a membership of the ONE platform organisation/);
  });

  it('refuses a self-grant at the database', async () => {
    await expect(insert(operations.membershipId, 'SUPPORT_CASES', operations.userId)).rejects.toThrow(/may not be self-granted/);
  });

  it('refuses a capability outside the vocabulary', async () => {
    await expect(insert(security.membershipId, 'EVERYTHING', superAdmin.userId)).rejects.toThrow(/membership_capability_ck/);
  });

  it('allows faculty review only on institution faculty and department heads', async () => {
    await insert(faculty.membershipId, 'CONTENT_REVIEW_EXTERNAL', institutionAdmin.userId);
    await expect(insert(security.membershipId, 'CONTENT_REVIEW_EXTERNAL', superAdmin.userId)).rejects.toThrow(/CONTENT_REVIEW_EXTERNAL may be granted only/);
    await expect(insert(institutionAdmin.membershipId, 'CONTENT_REVIEW_EXTERNAL', superAdmin.userId)).rejects.toThrow(/CONTENT_REVIEW_EXTERNAL may be granted only/);
  });

  it('keeps 0031 institution analytics rules and messages unchanged', async () => {
    await insert(institutionAdmin.membershipId, 'INSTITUTION_ANALYTICS', superAdmin.userId);
    await expect(insert(faculty.membershipId, 'INSTITUTION_ANALYTICS', superAdmin.userId)).rejects.toThrow(/INSTITUTION_ANALYTICS may be granted only to INSTITUTION_ADMIN or DEPARTMENT_HEAD/);
    await expect(insert(security.membershipId, 'INSTITUTION_ANALYTICS', superAdmin.userId)).rejects.toThrow(/INSTITUTION_ANALYTICS may be granted only/);
  });

  it('treats a grant as immutable except for its revocation, and never un-revokes', async () => {
    await insert(security.membershipId, 'SUPPORT_CASES', superAdmin.userId);
    await expect(pool.query("UPDATE membership_capabilities SET capability='CAPABILITY_ADMIN' WHERE membership_id=$1", [security.membershipId]))
      .rejects.toThrow(/immutable except for revocation/);
    await pool.query("UPDATE membership_capabilities SET revoked_by_user_id=$2, revoked_at=now(), revoked_reason_code='LEAVER' WHERE membership_id=$1", [security.membershipId, superAdmin.userId]);
    await expect(pool.query('UPDATE membership_capabilities SET revoked_by_user_id=NULL, revoked_at=NULL, revoked_reason_code=NULL WHERE membership_id=$1', [security.membershipId]))
      .rejects.toThrow(/cannot be changed/);
  });

  it('bounds the revocation reason code', async () => {
    await insert(security.membershipId, 'SUPPORT_CASES', superAdmin.userId);
    await expect(pool.query("UPDATE membership_capabilities SET revoked_by_user_id=$2, revoked_at=now(), revoked_reason_code='not a code' WHERE membership_id=$1", [security.membershipId, superAdmin.userId]))
      .rejects.toThrow(/membership_capability_revoked_reason_ck/);
  });
});

describe('role changes revoke internal capabilities', () => {
  it('refuses a raw role change while an internal grant is live', async () => {
    await insert(operations.membershipId, 'SUPPORT_CASES', superAdmin.userId);
    await expect(pool.query("UPDATE organization_memberships SET role='SECURITY_ADMIN' WHERE id=$1", [operations.membershipId]))
      .rejects.toThrow(/revoke internal capabilities before changing the membership role/);
  });

  it('changeMembershipRole revokes every live grant with ROLE_CHANGED and audits it in one transaction', async () => {
    await insert(operations.membershipId, 'SUPPORT_CASES', superAdmin.userId);
    await insert(operations.membershipId, 'CONTENT_EDIT', superAdmin.userId);
    const result = await changeMembershipRole(pool, {
      membershipId: operations.membershipId, role: 'SECURITY_ADMIN', actorUserId: superAdmin.userId,
      reasonCode: 'RESPONSIBILITY_ENDED', correlationId: 'role-change-test-1',
    });
    expect(result.revokedCapabilities).toBe(2);
    expect((await loadLiveCapabilityGrants(pool, [operations.membershipId])).get(operations.membershipId)).toBeUndefined();
    const rows = await pool.query('SELECT revoked_reason_code, revoked_by_user_id FROM membership_capabilities WHERE membership_id=$1', [operations.membershipId]);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) expect(row).toEqual({ revoked_reason_code: 'ROLE_CHANGED', revoked_by_user_id: superAdmin.userId });
    const role = await pool.query('SELECT role FROM organization_memberships WHERE id=$1', [operations.membershipId]);
    expect(role.rows[0].role).toBe('SECURITY_ADMIN');
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='organization_membership.role_changed' AND resource_id=$1", [operations.membershipId]);
    expect(audit.rows[0].context).toMatchObject({ fromRole: 'OPERATIONS_ADMIN', toRole: 'SECURITY_ADMIN', reasonCode: 'RESPONSIBILITY_ENDED', revokedCapabilities: 2 });
  });

  it('leaves an institution analytics holder to 0031, which never guarded role changes', async () => {
    await insert(institutionAdmin.membershipId, 'INSTITUTION_ANALYTICS', superAdmin.userId);
    await pool.query("UPDATE organization_memberships SET role='DEPARTMENT_HEAD' WHERE id=$1", [institutionAdmin.membershipId]);
  });
});

describe('grant and revoke with audit and outbox', () => {
  const decideAsSuperAdmin = (capability: 'SUPPORT_CASES') => (target: Parameters<typeof refuseInternalCapabilityGrant>[0]['target']) =>
    refuseInternalCapabilityGrant({ actor: { userId: superAdmin.userId, memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE' }] }, target, capability });

  it('writes the grant, an audit row with the reason code and an outbox event together', async () => {
    const member = await grantInternalCapability(pool, {
      membershipId: security.membershipId, capability: 'SUPPORT_CASES', actorUserId: superAdmin.userId,
      reasonCode: 'TEMPORARY_COVER', note: 'Covering the support inbox', correlationId: 'grant-test-0001', decide: decideAsSuperAdmin('SUPPORT_CASES'),
    });
    expect(member.grants.map((grant) => grant.capability)).toEqual(['SUPPORT_CASES']);
    const audit = await pool.query("SELECT actor_user_id, organization_id, correlation_id, context FROM audit_events WHERE action='operations.staff_capability.granted'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: superAdmin.userId, organization_id: platformId, correlation_id: 'grant-test-0001' });
    expect(audit.rows[0].context).toMatchObject({ capability: 'SUPPORT_CASES', reasonCode: 'TEMPORARY_COVER', targetUserId: security.userId });
    const outbox = await pool.query("SELECT aggregate_id, payload FROM outbox_events WHERE event_type='organization_membership.capability_granted'");
    expect(outbox.rows).toEqual([{ aggregate_id: security.membershipId, payload: { membershipId: security.membershipId, capability: 'SUPPORT_CASES' } }]);
  });

  it('rolls everything back when the rule refuses, leaving no grant, audit or outbox row', async () => {
    await expect(grantInternalCapability(pool, {
      membershipId: institutionAdmin.membershipId, capability: 'SUPPORT_CASES', actorUserId: superAdmin.userId,
      reasonCode: 'NEW_RESPONSIBILITY', correlationId: 'grant-test-0002', decide: () => null,
    })).rejects.toEqual(new PlatformControlError('CAPABILITY_ROLE_NOT_ELIGIBLE'));
    expect((await pool.query('SELECT 1 FROM membership_capabilities')).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action LIKE 'operations.staff_capability.%'")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM outbox_events WHERE event_type LIKE 'organization_membership.capability_%'")).rowCount).toBe(0);
  });

  it('revokes with the reason recorded on the row and in audit', async () => {
    await insert(security.membershipId, 'SUPPORT_CASES', superAdmin.userId);
    const member = await revokeInternalCapability(pool, {
      membershipId: security.membershipId, capability: 'SUPPORT_CASES', actorUserId: superAdmin.userId,
      reasonCode: 'LEAVER', correlationId: 'revoke-test-0001', decide: () => null,
    });
    expect(member.grants).toEqual([]);
    const row = await pool.query('SELECT revoked_reason_code FROM membership_capabilities WHERE membership_id=$1', [security.membershipId]);
    expect(row.rows[0].revoked_reason_code).toBe('LEAVER');
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='operations.staff_capability.revoked'");
    expect(audit.rows[0].context).toMatchObject({ capability: 'SUPPORT_CASES', reasonCode: 'LEAVER' });
  });

  it('lists only platform memberships, keyset-paged', async () => {
    const first = await listPlatformStaff(pool, { limit: 2 });
    expect(first.staff).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listPlatformStaff(pool, { limit: 2, cursor: first.nextCursor! });
    expect(second.staff).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.staff, ...second.staff].map((entry) => entry.membershipId).sort();
    expect(ids).toEqual([superAdmin.membershipId, operations.membershipId, security.membershipId].sort());
  });
});
