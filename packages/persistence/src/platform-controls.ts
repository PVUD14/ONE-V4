/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Two narrow platform controls that share nothing but their shape: feature flags
 * (migration 0029) and membership capabilities (migration 0031).
 *
 * Both exist because a decision already recorded elsewhere had no storage behind it —
 * CLAUDE.md's per-feature flag rule, and ADR-018's replacement of the Institution
 * Analyst role with a grant.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export class PlatformControlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PlatformControlError';
  }
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export interface FeatureFlagState {
  readonly key: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly cap: { readonly kind: string; readonly value: number; readonly window: string } | null;
  readonly overrides: number;
  readonly lastChangedAt: string | null;
}

export async function listFeatureFlags(pool: Pool): Promise<readonly FeatureFlagState[]> {
  const result = await pool.query<{
    key: string; description: string; enabled: boolean;
    cap_kind: string | null; cap_value: string | null; cap_window: string | null;
    overrides: number; last_changed_at: Date | null;
  }>(
    `SELECT f.key, f.description, f.enabled, f.cap_kind, f.cap_value, f.cap_window,
            (SELECT count(*)::int FROM feature_flag_overrides o WHERE o.flag_key = f.key AND o.revoked_at IS NULL) AS overrides,
            (SELECT max(e.occurred_at) FROM feature_flag_events e WHERE e.flag_key = f.key) AS last_changed_at
     FROM feature_flags f ORDER BY f.key`,
  );
  return result.rows.map((row) => ({
    key: row.key,
    description: row.description,
    enabled: row.enabled,
    cap: row.cap_kind && row.cap_value && row.cap_window
      ? { kind: row.cap_kind, value: Number(row.cap_value), window: row.cap_window }
      : null,
    overrides: row.overrides,
    lastChangedAt: row.last_changed_at ? row.last_changed_at.toISOString() : null,
  }));
}

/**
 * Resolve a flag for one caller.
 *
 * Order is user override, then organization override, then the global value. An
 * absent flag resolves to **off**, never on: a typo in a flag key must not switch
 * something on, and a feature whose flag was never created has not been released.
 */
export async function resolveFeatureFlag(
  client: Queryable,
  input: { readonly key: string; readonly userId?: string | null; readonly organizationId?: string | null },
): Promise<boolean> {
  const flag = await client.query<{ enabled: boolean }>('SELECT enabled FROM feature_flags WHERE key=$1', [input.key]);
  if (!flag.rows[0]) return false;

  const overrides = await client.query<{ scope_kind: string; enabled: boolean }>(
    `SELECT scope_kind, enabled FROM feature_flag_overrides
     WHERE flag_key=$1 AND revoked_at IS NULL
       AND ((scope_kind='USER' AND scope_id=$2::uuid) OR (scope_kind='ORGANIZATION' AND scope_id=$3::uuid))`,
    [input.key, input.userId ?? null, input.organizationId ?? null],
  );
  const user = overrides.rows.find((row) => row.scope_kind === 'USER');
  if (user) return user.enabled;
  const organization = overrides.rows.find((row) => row.scope_kind === 'ORGANIZATION');
  if (organization) return organization.enabled;
  return flag.rows[0].enabled;
}

export async function setFeatureFlagEnabled(
  pool: Pool,
  input: {
    readonly key: string; readonly enabled: boolean; readonly actorUserId: string;
    readonly reasonCode: string; readonly correlationId: string;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ enabled: boolean }>(
      'SELECT enabled FROM feature_flags WHERE key=$1 FOR UPDATE', [input.key],
    );
    if (!current.rows[0]) throw new PlatformControlError('FEATURE_FLAG_NOT_FOUND');
    await client.query('UPDATE feature_flags SET enabled=$2, updated_at=now() WHERE key=$1', [input.key, input.enabled]);
    await client.query(
      `INSERT INTO feature_flag_events (id, flag_key, actor_user_id, change_kind, from_value, to_value, reason_code, correlation_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [randomUUID(), input.key, input.actorUserId, input.enabled ? 'ENABLED' : 'DISABLED',
        JSON.stringify({ enabled: current.rows[0].enabled }), JSON.stringify({ enabled: input.enabled }),
        input.reasonCode, input.correlationId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Membership capabilities
// ---------------------------------------------------------------------------

export type MembershipCapability = 'INSTITUTION_ANALYTICS';

/**
 * Whether a membership currently holds a capability.
 *
 * This is the input `canReadInstitutionAnalytics` has always taken and never had. The
 * predicate still decides: a role outside the capable set is denied even holding the
 * grant, so a mis-set row cannot widen a role's reach.
 */
export async function hasMembershipCapability(
  client: Queryable,
  input: { readonly membershipId: string; readonly capability: MembershipCapability },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM membership_capabilities
     WHERE membership_id=$1 AND capability=$2 AND revoked_at IS NULL LIMIT 1`,
    [input.membershipId, input.capability],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listMembershipCapabilities(
  pool: Pool,
  institutionId: string,
): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT c.id, c.capability, c.granted_at AS "grantedAt", c.reason_code AS "reasonCode",
            c.revoked_at AS "revokedAt",
            m.id AS "membershipId", m.role, m.user_id AS "userId", u.email
     FROM membership_capabilities c
     JOIN organization_memberships m ON m.id = c.membership_id
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND c.revoked_at IS NULL
     ORDER BY c.granted_at DESC`, [institutionId],
  );
  return result.rows;
}

/**
 * Grant a capability.
 *
 * The role restriction is enforced by a trigger in 0031, so a grant to an ineligible
 * role fails at the database rather than depending on this function being the only
 * writer. Self-granting is refused here: the repository already rejects self-approval
 * on content reviews, and a capability someone can award themselves is not a control.
 */
export async function grantMembershipCapability(
  pool: Pool,
  input: {
    readonly membershipId: string; readonly capability: MembershipCapability;
    readonly grantedByUserId: string; readonly reasonCode: string;
  },
): Promise<{ readonly id: string }> {
  const membership = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM organization_memberships WHERE id=$1', [input.membershipId],
  );
  if (!membership.rows[0]) throw new PlatformControlError('MEMBERSHIP_NOT_FOUND');
  if (membership.rows[0].user_id === input.grantedByUserId) throw new PlatformControlError('CAPABILITY_SELF_GRANT_REFUSED');

  const id = randomUUID();
  try {
    await pool.query(
      `INSERT INTO membership_capabilities (id, membership_id, capability, granted_by_user_id, reason_code)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, input.membershipId, input.capability, input.grantedByUserId, input.reasonCode],
    );
  } catch (error) {
    if (error instanceof Error && /may be granted only to/.test(error.message)) {
      throw new PlatformControlError('CAPABILITY_ROLE_NOT_ELIGIBLE');
    }
    throw new PlatformControlError('CAPABILITY_GRANT_REJECTED');
  }
  return { id };
}

export async function revokeMembershipCapability(
  pool: Pool,
  input: { readonly capabilityId: string; readonly revokedByUserId: string },
): Promise<void> {
  const result = await pool.query(
    `UPDATE membership_capabilities SET revoked_by_user_id=$2, revoked_at=now()
     WHERE id=$1 AND revoked_at IS NULL`,
    [input.capabilityId, input.revokedByUserId],
  );
  if (!result.rowCount) throw new PlatformControlError('CAPABILITY_NOT_FOUND');
}

/**
 * Revoke every capability held by a membership.
 *
 * Called when a membership's role changes: the trigger validates a grant at the moment
 * it is written and cannot reach back to one already recorded, so a role change from
 * Institution Admin to Faculty would otherwise leave a grant the rules no longer
 * permit.
 */
export async function revokeCapabilitiesForRoleChange(
  client: Queryable,
  input: { readonly membershipId: string; readonly revokedByUserId: string },
): Promise<number> {
  const result = await client.query(
    `UPDATE membership_capabilities SET revoked_by_user_id=$2, revoked_at=now()
     WHERE membership_id=$1 AND revoked_at IS NULL`,
    [input.membershipId, input.revokedByUserId],
  );
  return result.rowCount ?? 0;
}
