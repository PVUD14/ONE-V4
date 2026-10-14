/**
 * Who may export institution data and over which students (INST-08): the grant is necessary
 * but never sufficient, scope comes only from the memberships holding it, and the scope is
 * the write scope, so an unscoped department head exports nobody.
 */
import { describe, expect, it } from 'vitest';
import {
  institutionExportMemberships,
  institutionExportScope,
  isStudentInInstitutionScope,
  type InstitutionExportCandidateMembership,
  type InstitutionUnitNode,
} from './index.js';

const institution = 'inst-1';
const units: InstitutionUnitNode[] = [
  { id: 'dept-a', parentUnitId: null }, { id: 'dept-b', parentUnitId: null },
  { id: 'batch-a1', parentUnitId: 'dept-a' },
];
function member(role: string, overrides: Partial<InstitutionExportCandidateMembership> = {}): InstitutionExportCandidateMembership {
  return { role, membershipId: role + '-m', organizationId: institution, state: 'ACTIVE', analyticsGrantId: 'grant', departmentUnitId: null, batchUnitId: null, ...overrides };
}

describe('institutionExportMemberships', () => {
  it('admits an admin or department head holding the grant, and nobody without it', () => {
    expect(institutionExportMemberships([member('INSTITUTION_ADMIN')], institution)).toHaveLength(1);
    expect(institutionExportMemberships([member('DEPARTMENT_HEAD', { departmentUnitId: 'dept-a' })], institution)).toHaveLength(1);
    for (const role of ['INSTITUTION_ADMIN', 'DEPARTMENT_HEAD']) {
      expect(institutionExportMemberships([member(role, { analyticsGrantId: null })], institution)).toEqual([]);
    }
  });

  it('never admits a role outside ADR-018, even holding a grant', () => {
    for (const role of ['INSTITUTION_OWNER', 'PLACEMENT_ADMIN', 'FACULTY_LECTURER', 'STUDENT', 'RECRUITER']) {
      expect(institutionExportMemberships([member(role)], institution)).toEqual([]);
    }
  });

  it('refuses a membership that is not active or belongs to another institution', () => {
    for (const state of ['PENDING', 'SUSPENDED', 'ENDED'] as const) {
      expect(institutionExportMemberships([member('INSTITUTION_ADMIN', { state })], institution)).toEqual([]);
    }
    expect(institutionExportMemberships([member('INSTITUTION_ADMIN', { organizationId: 'inst-2' })], institution)).toEqual([]);
  });
});

describe('institutionExportScope', () => {
  it('is the whole institution for an admin and the department for a scoped head', () => {
    expect(institutionExportScope([member('INSTITUTION_ADMIN')], units)).toEqual({ kind: 'INSTITUTION' });
    const head = institutionExportScope([member('DEPARTMENT_HEAD', { departmentUnitId: 'dept-a' })], units);
    expect(isStudentInInstitutionScope(head, { batchUnitId: 'batch-a1' })).toBe(true);
    expect(isStudentInInstitutionScope(head, { departmentUnitId: 'dept-b' })).toBe(false);
  });

  it('fails closed for a department head with no department, unlike the read scope', () => {
    expect(institutionExportScope([member('DEPARTMENT_HEAD')], units)).toEqual({ kind: 'NONE' });
  });

  it('is nobody without an authorising membership', () => {
    expect(institutionExportScope([], units)).toEqual({ kind: 'NONE' });
  });

  it('takes scope only from the memberships given, so another membership cannot widen it', () => {
    const caller = [member('DEPARTMENT_HEAD', { departmentUnitId: 'dept-a' }), member('INSTITUTION_ADMIN', { analyticsGrantId: null })];
    const exporters = institutionExportMemberships(caller, institution);
    expect(exporters.map((membership) => membership.role)).toEqual(['DEPARTMENT_HEAD']);
    const scope = institutionExportScope(exporters, units);
    expect(scope.kind).toBe('UNITS');
    expect(isStudentInInstitutionScope(scope, { departmentUnitId: 'dept-b' })).toBe(false);
  });
});
