/**
 * The SQL form of the institution student scope.
 *
 * packages/authorization decides, purely, which units a staff member's memberships
 * cover. This file loads the unit tree that decision needs and turns the result into a
 * predicate over a student profile row, so every institution read filters students the
 * same way. Two forms, because both query styles are in use: drizzle `sql` templates and
 * raw pg queries with positional parameters. Both are parameterised; the profile alias is
 * the only interpolated text and is checked against a fixed pattern.
 */
import type { Pool, PoolClient } from 'pg';
import { sql, type SQL } from 'drizzle-orm';
import {
  institutionStudentScope,
  type InstitutionStaffScopeMembership,
  type InstitutionStudentScope,
  type InstitutionUnitNode,
} from '@planthepath/authorization/src/index.js';
import type { PersistenceDb } from './repositories.js';

const profileAliasPattern = /^[a-z][a-z0-9_]{0,30}$/;

function checkedAlias(alias: string): string {
  if (!profileAliasPattern.test(alias)) throw new Error('invalid profile alias');
  return alias;
}

export async function loadInstitutionUnitTree(db: PersistenceDb | Pool | PoolClient, institutionId: string): Promise<readonly InstitutionUnitNode[]> {
  const query = 'SELECT id, parent_unit_id FROM institution_units WHERE institution_id = $1';
  const rows = 'execute' in db
    ? ((await db.execute(sql`SELECT id, parent_unit_id FROM institution_units WHERE institution_id = ${institutionId}::uuid`)) as unknown as { rows: { id: string; parent_unit_id: string | null }[] }).rows
    : (await db.query<{ id: string; parent_unit_id: string | null }>(query, [institutionId])).rows;
  return rows.map((row) => ({ id: row.id, parentUnitId: row.parent_unit_id }));
}

async function rowsOf<T>(db: PersistenceDb | Pool | PoolClient, drizzleQuery: SQL, text: string, values: unknown[]): Promise<T[]> {
  return 'execute' in db
    ? ((await db.execute(drizzleQuery)) as unknown as { rows: T[] }).rows
    : (await db.query(text, values)).rows as T[];
}

/**
 * INST-03: give each faculty membership the units of its active teaching assignments,
 * once the institution has recorded any assignment at all (in any state). Before that,
 * faculty keep their membership scope. "Active" is decided by the database clock on
 * every call, so an ended or expired assignment stops granting access on the next request.
 */
export async function withTeachingAssignments(
  db: PersistenceDb | Pool | PoolClient,
  institutionId: string,
  memberships: readonly InstitutionStaffScopeMembership[],
): Promise<readonly InstitutionStaffScopeMembership[]> {
  const facultyIds = [...new Set(memberships
    .filter((membership) => membership.role === 'FACULTY_LECTURER' && membership.membershipId)
    .map((membership) => membership.membershipId as string))];
  if (facultyIds.length === 0) return memberships;
  const [adoption] = await rowsOf<{ adopted: boolean }>(db,
    sql`SELECT EXISTS (SELECT 1 FROM faculty_teaching_assignments WHERE institution_id = ${institutionId}::uuid) AS adopted`,
    'SELECT EXISTS (SELECT 1 FROM faculty_teaching_assignments WHERE institution_id = $1::uuid) AS adopted', [institutionId]);
  if (!adoption?.adopted) return memberships;
  const ids = `{${facultyIds.join(',')}}`;
  const active = await rowsOf<{ faculty_membership_id: string; unit_id: string }>(db,
    sql`SELECT faculty_membership_id, unit_id FROM faculty_teaching_assignments fta
        WHERE institution_id = ${institutionId}::uuid AND faculty_membership_id = ANY(${ids}::uuid[])
          AND ${activeTeachingAssignmentSql('fta')}`,
    `SELECT faculty_membership_id, unit_id FROM faculty_teaching_assignments fta
        WHERE institution_id = $1::uuid AND faculty_membership_id = ANY($2::uuid[])
          AND ${activeTeachingAssignmentPredicate('fta')}`,
    [institutionId, ids]);
  return memberships.map((membership) => membership.role === 'FACULTY_LECTURER' && membership.membershipId
    ? { ...membership, teachingUnitIds: active.filter((row) => row.faculty_membership_id === membership.membershipId).map((row) => row.unit_id).sort() }
    : membership);
}

/** The one definition of a teaching assignment that currently grants access, as SQL text over `alias`. */
export function activeTeachingAssignmentPredicate(alias: string): string {
  const a = checkedAlias(alias);
  return `(${a}.state = 'ACTIVE' AND ${a}.starts_on <= current_date AND (${a}.ends_on IS NULL OR ${a}.ends_on >= current_date))`;
}

/** Drizzle form of {@link activeTeachingAssignmentPredicate}. */
export function activeTeachingAssignmentSql(alias: string): SQL {
  return sql.raw(activeTeachingAssignmentPredicate(alias));
}

/** Resolve the scope for the given memberships against the institution's current unit tree. */
export async function resolveInstitutionStudentScope(
  db: PersistenceDb | Pool | PoolClient,
  institutionId: string,
  memberships: readonly InstitutionStaffScopeMembership[],
): Promise<InstitutionStudentScope> {
  const resolved = await withTeachingAssignments(db, institutionId, memberships);
  const trivial = institutionStudentScope(resolved, []);
  if (trivial.kind !== 'UNITS') return trivial;
  return institutionStudentScope(resolved, await loadInstitutionUnitTree(db, institutionId));
}

/** Drizzle predicate: true when the profile row `alias` is inside the scope. */
export function institutionStudentScopeSql(scope: InstitutionStudentScope, alias: string): SQL {
  if (scope.kind === 'INSTITUTION') return sql`TRUE`;
  if (scope.kind === 'NONE') return sql`FALSE`;
  const p = sql.raw(checkedAlias(alias));
  const clauses = scope.clauses.map((anchors) => sql.join(anchors.map((covered) => {
    const ids = `{${covered.join(',')}}`;
    return sql`(${p}.department_unit_id = ANY(${ids}::uuid[]) OR ${p}.program_unit_id = ANY(${ids}::uuid[])
      OR ${p}.batch_unit_id = ANY(${ids}::uuid[]) OR ${p}.section_unit_id = ANY(${ids}::uuid[]))`;
  }), sql` AND `));
  return sql`(${sql.join(clauses.map((clause) => sql`(${clause})`), sql` OR `)})`;
}

/**
 * pg predicate for queries with positional parameters. Appends its values to `values`
 * and returns the SQL text referencing them.
 */
export function institutionStudentScopeClause(scope: InstitutionStudentScope, alias: string, values: unknown[]): string {
  if (scope.kind === 'INSTITUTION') return 'TRUE';
  if (scope.kind === 'NONE') return 'FALSE';
  const p = checkedAlias(alias);
  const clauses = scope.clauses.map((anchors) => anchors.map((covered) => {
    values.push([...covered]);
    const ref = `$${values.length}::uuid[]`;
    return `(${p}.department_unit_id = ANY(${ref}) OR ${p}.program_unit_id = ANY(${ref})`
      + ` OR ${p}.batch_unit_id = ANY(${ref}) OR ${p}.section_unit_id = ANY(${ref}))`;
  }).join(' AND '));
  return `(${clauses.map((clause) => `(${clause})`).join(' OR ')})`;
}
