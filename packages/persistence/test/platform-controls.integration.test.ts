/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Feature flags and membership capabilities.
 *
 * The capability trigger is the interesting part: ADR-018 says analytics is grantable
 * to two roles and to no others, and that sentence is only true if the database
 * refuses the rest. A controller check would hold only until someone writes a second
 * writer.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { resolveFeatureFlag } from '../src/platform-controls.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

let client: PoolClient;
let institutionId: string;
let adminUserId: string;
let facultyUserId: string;
let adminMembershipId: string;
let facultyMembershipId: string;
let grantorId: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  institutionId = randomUUID();
  adminUserId = randomUUID();
  facultyUserId = randomUUID();
  grantorId = randomUUID();
  adminMembershipId = randomUUID();
  facultyMembershipId = randomUUID();
  for (const id of [adminUserId, facultyUserId, grantorId]) {
    await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, id + '@example.test']);
  }
  await client.query("INSERT INTO organizations (id, kind, legal_name) VALUES ($1, 'INSTITUTION', 'E capability test')", [institutionId]);
  const rows: readonly (readonly [string, string, string])[] = [
    [adminMembershipId, adminUserId, 'INSTITUTION_ADMIN'],
    [facultyMembershipId, facultyUserId, 'FACULTY_LECTURER'],
  ];
  for (const [id, userId, role] of rows) {
    await client.query(
      `INSERT INTO organization_memberships (id, organization_id, user_id, role, state, scope_organization_id, scope_institution_id)
       VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2)`, [id, institutionId, userId, role],
    );
  }
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => { await pool.end(); });

async function grant(membershipId: string): Promise<void> {
  await client.query(
    `INSERT INTO membership_capabilities (id, membership_id, capability, granted_by_user_id, reason_code)
     VALUES ($1,$2,'INSTITUTION_ANALYTICS',$3,'PLACEMENT_REPORTING')`,
    [randomUUID(), membershipId, grantorId],
  );
}

describe('membership capabilities', () => {
  it('grants analytics to an institution admin', async () => {
    await grant(adminMembershipId);
    const held = await client.query(
      'SELECT 1 FROM membership_capabilities WHERE membership_id=$1 AND revoked_at IS NULL', [adminMembershipId],
    );
    expect(held.rowCount).toBe(1);
  });

  it('refuses analytics to a role outside the capable set', async () => {
    await expect(grant(facultyMembershipId)).rejects.toThrow(/may be granted only to/);
  });

  it('permits only one live grant per membership', async () => {
    await grant(adminMembershipId);
    await expect(grant(adminMembershipId)).rejects.toThrow(/membership_capability_live_uq/);
  });

  it('allows a re-grant after revocation, keeping both rows', async () => {
    await grant(adminMembershipId);
    await client.query(
      'UPDATE membership_capabilities SET revoked_by_user_id=$2, revoked_at=now() WHERE membership_id=$1',
      [adminMembershipId, grantorId],
    );
    await grant(adminMembershipId);
    const all = await client.query('SELECT id FROM membership_capabilities WHERE membership_id=$1', [adminMembershipId]);
    expect(all.rowCount).toBe(2);
  });

  it('requires a revoker and a revocation time together', async () => {
    await grant(adminMembershipId);
    await expect(client.query(
      'UPDATE membership_capabilities SET revoked_at=now() WHERE membership_id=$1', [adminMembershipId],
    )).rejects.toThrow(/membership_capability_revoked_ck/);
  });
});

describe('feature flags', () => {
  beforeEach(async () => {
    await client.query(
      "INSERT INTO feature_flags (key, description, enabled) VALUES ('test.flag','A flag used by the integration tests',false)",
    );
  });

  it('resolves an absent flag to off rather than on', async () => {
    expect(await resolveFeatureFlag(client, { key: 'never.created' })).toBe(false);
  });

  it('resolves the global value when no override applies', async () => {
    expect(await resolveFeatureFlag(client, { key: 'test.flag', userId: adminUserId, organizationId: institutionId })).toBe(false);
    await client.query("UPDATE feature_flags SET enabled=true WHERE key='test.flag'");
    expect(await resolveFeatureFlag(client, { key: 'test.flag', userId: adminUserId, organizationId: institutionId })).toBe(true);
  });

  it('lets an organization override enable a globally-off flag', async () => {
    await client.query(
      `INSERT INTO feature_flag_overrides (id, flag_key, scope_kind, scope_id, enabled, created_by_user_id)
       VALUES ($1,'test.flag','ORGANIZATION',$2,true,$3)`, [randomUUID(), institutionId, grantorId],
    );
    expect(await resolveFeatureFlag(client, { key: 'test.flag', organizationId: institutionId })).toBe(true);
  });

  it('lets a user override force a flag off, beating the organization', async () => {
    await client.query(
      `INSERT INTO feature_flag_overrides (id, flag_key, scope_kind, scope_id, enabled, created_by_user_id)
       VALUES ($1,'test.flag','ORGANIZATION',$2,true,$3)`, [randomUUID(), institutionId, grantorId],
    );
    await client.query(
      `INSERT INTO feature_flag_overrides (id, flag_key, scope_kind, scope_id, enabled, created_by_user_id)
       VALUES ($1,'test.flag','USER',$2,false,$3)`, [randomUUID(), adminUserId, grantorId],
    );
    expect(await resolveFeatureFlag(client, { key: 'test.flag', userId: adminUserId, organizationId: institutionId })).toBe(false);
  });

  it('refuses a cap without a window', async () => {
    await expect(client.query(
      "UPDATE feature_flags SET cap_kind='INVOCATIONS', cap_value=100 WHERE key='test.flag'",
    )).rejects.toThrow(/feature_flag_cap_shape_ck/);
  });

  it('requires a bounded reason code on every change event', async () => {
    await expect(client.query(
      `INSERT INTO feature_flag_events (id, flag_key, actor_user_id, change_kind, reason_code, correlation_id)
       VALUES ($1,'test.flag',$2,'ENABLED','lowercase reason',$3)`, [randomUUID(), grantorId, randomUUID()],
    )).rejects.toThrow(/feature_flag_event_reason_ck/);
  });
});
