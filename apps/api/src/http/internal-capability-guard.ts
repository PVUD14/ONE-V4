/**
 * Internal capability checks for operations controllers (OPS-01, ADR-032).
 *
 * Controllers call these after `requireTrustedAuthorization` instead of inlining role
 * lists. The decision itself is the pure `hasInternalCapability` in
 * packages/authorization; this file only supplies its input — the caller's ACTIVE
 * memberships and, when the role baseline does not already answer, their live grants.
 *
 * The baseline is checked first and needs no database read, so the three platform
 * roles reach every endpoint they reached before OPS-01 without an extra query.
 */
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  hasInternalCapability,
  type InternalCapability,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import type { RequestAuthorizationContext } from '@planthepath/identity/src/principal.js';
import { loadLiveCapabilityGrants } from '@planthepath/persistence/src/platform-controls.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Live grants keyed by membership id. */
export type CapabilityGrantLoader = (membershipIds: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>;

export function poolCapabilityGrantLoader(pool: Pool): CapabilityGrantLoader {
  return (membershipIds) => loadLiveCapabilityGrants(pool, membershipIds);
}

export function dbCapabilityGrantLoader(db: PersistenceDb): CapabilityGrantLoader {
  return async (membershipIds) => {
    const grants = new Map<string, string[]>();
    if (!membershipIds.length) return grants;
    const result = await db.execute(sql`
      SELECT membership_id, capability FROM membership_capabilities
      WHERE revoked_at IS NULL
        AND membership_id IN (${sql.join(membershipIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `) as { rows: { membership_id: string; capability: string }[] };
    for (const row of result.rows) grants.set(row.membership_id, [...(grants.get(row.membership_id) ?? []), row.capability]);
    return grants;
  };
}

function activeMembershipIds(authorization: RequestAuthorizationContext): readonly string[] {
  return authorization.memberships
    .filter((membership) => membership.state === 'ACTIVE' && uuidPattern.test(membership.id))
    .map((membership) => membership.id);
}

/** The caller's full capability context, grants included. Used where the grants themselves matter. */
export async function loadCallerCapabilityContext(
  authorization: RequestAuthorizationContext,
  loader: CapabilityGrantLoader,
): Promise<InternalCapabilityContext & { readonly userId: string }> {
  const ids = activeMembershipIds(authorization);
  const grants = ids.length ? await loader(ids) : new Map<string, readonly string[]>();
  return {
    userId: authorization.principal.userId,
    memberships: authorization.memberships.map((membership) => ({
      role: membership.role,
      state: membership.state,
      grants: grants.get(membership.id) ?? [],
    })),
  };
}

/**
 * Whether the authenticated caller holds a capability. A missing authorization context
 * is a denial, never an error, so each controller keeps its own denial shape.
 */
export async function callerHasInternalCapability(
  authorization: RequestAuthorizationContext | undefined,
  loader: CapabilityGrantLoader,
  capability: InternalCapability,
): Promise<boolean> {
  if (!authorization?.principal.userId) return false;
  const baselineOnly = { memberships: authorization.memberships.map((membership) => ({ role: membership.role, state: membership.state })) };
  if (hasInternalCapability(baselineOnly, capability)) return true;
  if (!activeMembershipIds(authorization).length) return false;
  return hasInternalCapability(await loadCallerCapabilityContext(authorization, loader), capability);
}
