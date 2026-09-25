/**
 * The caller's institution student scope, for controllers.
 *
 * Takes the memberships from the trusted authorization context (never from the request
 * body), keeps the ACTIVE ones that belong to this institution and carry one of the
 * endpoint's roles, and resolves them to a scope with packages/authorization's single
 * definition. Also names the units the scope is anchored on, so a screen can say whose
 * students it is showing ("Department of Mechanical Engineering").
 */
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { institutionScopeAnchors, type InstitutionStaffScopeMembership, type InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { resolveInstitutionStudentScope, withTeachingAssignments } from '@planthepath/persistence/src/institution-scope.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import type { ProtectedHttpRequest } from './api-security.js';

export interface InstitutionStudentScopeView {
  readonly kind: InstitutionStudentScope['kind'];
  readonly units: readonly { readonly id: string; readonly kind: string; readonly name: string }[];
}

export function institutionStaffScopeMemberships(
  request: ProtectedHttpRequest,
  institutionId: string,
  roles: readonly string[],
): readonly InstitutionStaffScopeMembership[] {
  return (request.planThePath?.authorization?.memberships ?? [])
    .filter((membership) => membership.state === 'ACTIVE'
      && membership.organizationId === institutionId
      && membership.scope.organizationId === institutionId
      && membership.scope.institutionId === institutionId
      && roles.includes(membership.role))
    .map((membership) => ({
      role: membership.role,
      membershipId: membership.id,
      departmentUnitId: membership.scope.departmentId ?? null,
      batchUnitId: membership.scope.batchId ?? null,
    }));
}

export async function institutionStudentScopeFor(
  db: PersistenceDb | Pool,
  request: ProtectedHttpRequest,
  institutionId: string,
  roles: readonly string[],
): Promise<InstitutionStudentScope> {
  return resolveInstitutionStudentScope(db, institutionId, institutionStaffScopeMemberships(request, institutionId, roles));
}

/** The units a scoped caller is anchored on, for the page subtitle. Empty when institution-wide. */
export async function describeInstitutionStudentScope(
  db: PersistenceDb,
  request: ProtectedHttpRequest,
  institutionId: string,
  roles: readonly string[],
  scope: InstitutionStudentScope,
): Promise<InstitutionStudentScopeView> {
  if (scope.kind !== 'UNITS') return { kind: scope.kind, units: [] };
  // A faculty member's scope is named by their assigned units once assignments are in use (INST-03).
  const memberships = await withTeachingAssignments(db, institutionId, institutionStaffScopeMemberships(request, institutionId, roles));
  const anchors = [...new Set(memberships.flatMap((membership) => institutionScopeAnchors(membership)))];
  const rows = await db.execute(sql`
    SELECT id, kind::text AS kind, name FROM institution_units
    WHERE institution_id = ${institutionId}::uuid AND id = ANY(${`{${anchors.join(',')}}`}::uuid[])
    ORDER BY name, id
  `) as unknown as { rows: { id: string; kind: string; name: string }[] };
  return { kind: 'UNITS', units: rows.rows };
}
