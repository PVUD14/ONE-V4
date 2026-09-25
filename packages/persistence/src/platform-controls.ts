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
import type { InternalCapability, InternalCapabilityChangeRefusal } from '@planthepath/authorization/src/index.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

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

// Deliberately still one value: internal capabilities are written only through
// grantInternalCapability below, which audits in the same transaction.
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
  // ROLE_CHANGED (0039) records why the grant ended, so an access review can tell a
  // role change from a deliberate removal.
  const result = await client.query(
    `UPDATE membership_capabilities SET revoked_by_user_id=$2, revoked_at=now(), revoked_reason_code='ROLE_CHANGED'
     WHERE membership_id=$1 AND revoked_at IS NULL`,
    [input.membershipId, input.revokedByUserId],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Internal operator capabilities (OPS-01, ADR-032, migration 0039)
// ---------------------------------------------------------------------------

/** Live grants for a set of memberships, keyed by membership id. */
export async function loadLiveCapabilityGrants(
  client: Queryable,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const grants = new Map<string, string[]>();
  if (!membershipIds.length) return grants;
  const result = await client.query<{ membership_id: string; capability: string }>(
    `SELECT membership_id, capability FROM membership_capabilities
     WHERE membership_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
    [[...membershipIds]],
  );
  for (const row of result.rows) grants.set(row.membership_id, [...(grants.get(row.membership_id) ?? []), row.capability]);
  return grants;
}

export interface PlatformStaffGrant {
  readonly capability: string;
  readonly grantedAt: string;
  readonly reasonCode: string;
}

export interface PlatformStaffMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly state: string;
  readonly organizationId: string;
  readonly organizationKind: string;
  readonly createdAt: string;
  readonly grants: readonly PlatformStaffGrant[];
}

const staffSelect = `
  SELECT m.id AS membership_id, m.user_id, u.email, m.role, m.state::text AS state, m.organization_id,
         o.kind::text AS organization_kind,
         -- Microsecond precision: a millisecond cursor would repeat rows created in the
         -- same millisecond on the next page.
         to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
         COALESCE(json_agg(json_build_object('capability', c.capability, 'grantedAt', c.granted_at, 'reasonCode', c.reason_code)
                  ORDER BY c.granted_at) FILTER (WHERE c.id IS NOT NULL), '[]'::json) AS grants
  FROM organization_memberships m
  JOIN organizations o ON o.id = m.organization_id
  JOIN users u ON u.id = m.user_id
  LEFT JOIN membership_capabilities c ON c.membership_id = m.id AND c.revoked_at IS NULL
    AND c.capability <> 'INSTITUTION_ANALYTICS'`;

interface StaffRow {
  membership_id: string; user_id: string; email: string; role: string; state: string; organization_id: string;
  organization_kind: string; created_at: string; grants: { capability: string; grantedAt: string; reasonCode: string }[];
}

function mapStaffRow(row: StaffRow): PlatformStaffMember {
  return {
    membershipId: row.membership_id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    state: row.state,
    organizationId: row.organization_id,
    organizationKind: row.organization_kind,
    createdAt: row.created_at,
    grants: row.grants.map((grant) => ({
      capability: grant.capability,
      grantedAt: new Date(grant.grantedAt).toISOString(),
      reasonCode: grant.reasonCode,
    })),
  };
}

/**
 * Memberships of the ONE platform organisation with their live internal grants, keyset
 * paginated on (created_at, id) so a page is stable while staff are added.
 */
export async function listPlatformStaff(
  pool: Pool,
  input: { readonly limit: number; readonly cursor?: { readonly createdAt: string; readonly id: string } },
): Promise<{ readonly staff: readonly PlatformStaffMember[]; readonly nextCursor: { readonly createdAt: string; readonly id: string } | null }> {
  const result = await pool.query<StaffRow>(
    `${staffSelect}
     WHERE o.kind = 'PLATFORM'
       AND ($1::timestamptz IS NULL OR (m.created_at, m.id) > ($1::timestamptz, $2::uuid))
     GROUP BY m.id, u.email, o.kind
     ORDER BY m.created_at, m.id
     LIMIT $3`,
    [input.cursor?.createdAt ?? null, input.cursor?.id ?? null, input.limit + 1],
  );
  const page = result.rows.slice(0, input.limit).map(mapStaffRow);
  const last = page[page.length - 1];
  return { staff: page, nextCursor: result.rows.length > input.limit && last ? { createdAt: last.createdAt, id: last.membershipId } : null };
}

async function loadStaffMember(client: Queryable, membershipId: string, lock: boolean): Promise<PlatformStaffMember | null> {
  if (lock) await client.query('SELECT 1 FROM organization_memberships WHERE id=$1 FOR UPDATE', [membershipId]);
  const result = await client.query<StaffRow>(
    `${staffSelect}
     WHERE m.id = $1
     GROUP BY m.id, u.email, o.kind`,
    [membershipId],
  );
  return result.rows[0] ? mapStaffRow(result.rows[0]) : null;
}

/** What the pure grant/revoke rules need to know about the target membership. */
export interface CapabilityChangeTarget {
  readonly userId: string;
  readonly role: string;
  readonly state: string;
  readonly organizationKind: string;
  readonly grants: readonly string[];
}

export interface InternalCapabilityChangeInput {
  readonly membershipId: string;
  readonly capability: InternalCapability;
  readonly actorUserId: string;
  readonly reasonCode: string;
  readonly note?: string;
  readonly correlationId: string;
  /** The authorization rule, evaluated against the locked target inside the transaction. */
  readonly decide: (target: CapabilityChangeTarget) => InternalCapabilityChangeRefusal | null;
}

async function inCapabilityTransaction<T>(
  pool: Pool,
  input: InternalCapabilityChangeInput,
  work: (client: PoolClient, target: PlatformStaffMember) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await loadStaffMember(client, input.membershipId, true);
    if (!target) throw new PlatformControlError('MEMBERSHIP_NOT_FOUND');
    const refusal = input.decide({
      userId: target.userId, role: target.role, state: target.state, organizationKind: target.organizationKind,
      grants: target.grants.map((grant) => grant.capability),
    });
    if (refusal) throw new PlatformControlError(refusal);
    const outcome = await work(client, target);
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function writeCapabilityAuditAndOutbox(
  client: PoolClient,
  input: InternalCapabilityChangeInput & { readonly target: PlatformStaffMember; readonly kind: 'granted' | 'revoked' },
): Promise<void> {
  const audit = {
    id: randomUUID(),
    actorUserId: input.actorUserId,
    action: 'operations.staff_capability.' + input.kind,
    resourceType: 'organization_membership',
    resourceId: input.membershipId,
    organizationId: input.target.organizationId,
    correlationId: input.correlationId,
    context: {
      capability: input.capability,
      reasonCode: input.reasonCode,
      targetUserId: input.target.userId,
      targetRole: input.target.role,
      ...(input.note ? { note: input.note } : {}),
    },
  };
  validateAuditWriteInput(audit);
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
     VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS',$7,$8::jsonb)`,
    [audit.id, audit.actorUserId, audit.action, audit.resourceType, audit.resourceId, audit.organizationId, audit.correlationId, JSON.stringify(audit.context)],
  );
  const outbox = {
    id: randomUUID(),
    aggregateType: 'organization_membership',
    aggregateId: input.membershipId,
    eventType: 'organization_membership.capability_' + input.kind,
    eventVersion: 1,
    payload: { membershipId: input.membershipId, capability: input.capability },
    actorUserId: input.actorUserId,
    organizationId: input.target.organizationId,
    correlationId: input.correlationId,
  };
  validateOutboxWriteInput(outbox);
  await client.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
     VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$7,$8)`,
    [outbox.id, outbox.aggregateType, outbox.aggregateId, outbox.eventType, JSON.stringify(outbox.payload), outbox.actorUserId, outbox.organizationId, outbox.correlationId],
  );
}

/**
 * Grant an internal capability to a platform membership, with its audit row and
 * outbox event, in one transaction. The 0039 trigger re-checks eligibility and
 * self-grant; a refusal there maps to the same codes the pure rules use.
 */
export async function grantInternalCapability(pool: Pool, input: InternalCapabilityChangeInput): Promise<PlatformStaffMember> {
  return inCapabilityTransaction(pool, input, async (client, target) => {
    await client.query('SAVEPOINT capability_insert');
    try {
      await client.query(
        `INSERT INTO membership_capabilities (id, membership_id, capability, granted_by_user_id, reason_code)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), input.membershipId, input.capability, input.actorUserId, input.reasonCode],
      );
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT capability_insert');
      const message = error instanceof Error ? error.message : '';
      if (/self-granted/.test(message)) throw new PlatformControlError('CAPABILITY_SELF_CHANGE_REFUSED');
      if (/may be granted only to/.test(message)) throw new PlatformControlError('CAPABILITY_ROLE_NOT_ELIGIBLE');
      if (/membership_capability_live_uq/.test(message)) throw new PlatformControlError('CAPABILITY_ALREADY_HELD');
      throw new PlatformControlError('CAPABILITY_GRANT_REJECTED');
    }
    await writeCapabilityAuditAndOutbox(client, { ...input, target, kind: 'granted' });
    return (await loadStaffMember(client, input.membershipId, false))!;
  });
}

/** Revoke a live internal grant, recording why, with its audit row and outbox event. */
export async function revokeInternalCapability(pool: Pool, input: InternalCapabilityChangeInput): Promise<PlatformStaffMember> {
  return inCapabilityTransaction(pool, input, async (client, target) => {
    const result = await client.query(
      `UPDATE membership_capabilities SET revoked_by_user_id=$3, revoked_at=now(), revoked_reason_code=$4
       WHERE membership_id=$1 AND capability=$2 AND revoked_at IS NULL`,
      [input.membershipId, input.capability, input.actorUserId, input.reasonCode],
    );
    if (!result.rowCount) throw new PlatformControlError('CAPABILITY_NOT_GRANTED');
    await writeCapabilityAuditAndOutbox(client, { ...input, target, kind: 'revoked' });
    return (await loadStaffMember(client, input.membershipId, false))!;
  });
}

/**
 * Change a membership's role. Every live capability is revoked in the same
 * transaction first: a grant was validated against the role it was written for, and
 * the 0039 trigger refuses a role change that would carry an internal grant across.
 * The 0001 membership scope trigger still decides which roles are valid where.
 */
export async function changeMembershipRole(
  pool: Pool,
  input: {
    readonly membershipId: string; readonly role: string; readonly actorUserId: string;
    readonly reasonCode: string; readonly correlationId: string;
  },
): Promise<{ readonly revokedCapabilities: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ role: string; organization_id: string }>(
      'SELECT role, organization_id FROM organization_memberships WHERE id=$1 FOR UPDATE', [input.membershipId],
    );
    const row = current.rows[0];
    if (!row) throw new PlatformControlError('MEMBERSHIP_NOT_FOUND');
    if (row.role === input.role) {
      await client.query('COMMIT');
      return { revokedCapabilities: 0 };
    }
    const revokedCapabilities = await revokeCapabilitiesForRoleChange(client, { membershipId: input.membershipId, revokedByUserId: input.actorUserId });
    await client.query('UPDATE organization_memberships SET role=$2, updated_at=now() WHERE id=$1', [input.membershipId, input.role]);
    const audit = {
      id: randomUUID(), actorUserId: input.actorUserId, action: 'organization_membership.role_changed',
      resourceType: 'organization_membership', resourceId: input.membershipId, organizationId: row.organization_id,
      correlationId: input.correlationId,
      context: { fromRole: row.role, toRole: input.role, reasonCode: input.reasonCode, revokedCapabilities },
    };
    validateAuditWriteInput(audit);
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
       VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS',$7,$8::jsonb)`,
      [audit.id, audit.actorUserId, audit.action, audit.resourceType, audit.resourceId, audit.organizationId, audit.correlationId, JSON.stringify(audit.context)],
    );
    await client.query('COMMIT');
    return { revokedCapabilities };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
