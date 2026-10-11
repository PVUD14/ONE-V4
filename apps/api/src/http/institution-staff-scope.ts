/**
 * Validation for the unit scope an institution admin puts on a staff member (INST-03).
 *
 * INST-02 made every student read honour a membership's department and batch, but
 * nothing could set them. Both the staff invitation (which acceptance copies onto the
 * membership) and the later "set scope" action use this one check, so an invitation and
 * an edit cannot disagree about what a valid scope is: units of this institution only; a
 * department in the department slot (a placement admin may be narrowed to a campus
 * instead, Appendix 3 Section 5.1); a batch in the batch slot and below the department
 * when both are given; no batch for a department head, whose scope is a department.
 */
import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { isUnitWithin } from '@planthepath/authorization/src/index.js';
import { loadInstitutionUnitTree } from '@planthepath/persistence/src/institution-scope.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StaffUnitScope {
  readonly departmentUnitId: string | null;
  readonly batchUnitId: string | null;
}

export function staffScopeError(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException({ error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } });
}

/** Reads `departmentUnitId` / `batchUnitId` from a body: absent, null or '' means none. */
export function readStaffUnitScope(body: unknown, correlationId: string): StaffUnitScope {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const read = (field: 'departmentUnitId' | 'batchUnitId'): string | null => {
    const value = source[field];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !uuidPattern.test(value)) throw staffScopeError('INVALID_STAFF_UNIT_SCOPE', correlationId, field);
    return value.toLowerCase();
  };
  return { departmentUnitId: read('departmentUnitId'), batchUnitId: read('batchUnitId') };
}

export async function validateStaffUnitScope(
  db: PersistenceDb,
  institutionId: string,
  role: string,
  scope: StaffUnitScope,
  correlationId: string,
): Promise<void> {
  if (!scope.departmentUnitId && !scope.batchUnitId) return;
  const ids = [scope.departmentUnitId, scope.batchUnitId].filter((id): id is string => Boolean(id));
  const found = await db.execute(sql`
    SELECT id, kind::text AS kind FROM institution_units
    WHERE institution_id = ${institutionId}::uuid AND id = ANY(${`{${ids.join(',')}}`}::uuid[])
  `) as unknown as { rows: { id: string; kind: string }[] };
  const kindOf = new Map(found.rows.map((row) => [row.id, row.kind]));
  if (scope.departmentUnitId) {
    const allowed = role === 'PLACEMENT_ADMIN' ? ['DEPARTMENT', 'CAMPUS'] : ['DEPARTMENT'];
    if (!allowed.includes(kindOf.get(scope.departmentUnitId) ?? '')) throw staffScopeError('INVALID_STAFF_UNIT_SCOPE', correlationId, 'departmentUnitId');
  }
  if (scope.batchUnitId) {
    if (role === 'DEPARTMENT_HEAD' || kindOf.get(scope.batchUnitId) !== 'BATCH') throw staffScopeError('INVALID_STAFF_UNIT_SCOPE', correlationId, 'batchUnitId');
    if (scope.departmentUnitId && !isUnitWithin(scope.batchUnitId, scope.departmentUnitId, await loadInstitutionUnitTree(db, institutionId))) {
      throw staffScopeError('INVALID_STAFF_UNIT_SCOPE', correlationId, 'batchUnitId');
    }
  }
}
