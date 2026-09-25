/**
 * Tree cases for the institution student scope: which students a staff member sees
 * given their memberships and the institution's unit tree.
 */
import { describe, expect, it } from 'vitest';
import {
  institutionStudentScope,
  institutionUnitDescendants,
  isStudentInInstitutionScope,
  type InstitutionUnitNode,
} from './index.js';

// Campus → Department A → Programme A → Batch A1 → Section A1-1
//                                      → Batch A2
//        → Department B → Batch B1
const units: InstitutionUnitNode[] = [
  { id: 'campus', parentUnitId: null },
  { id: 'dept-a', parentUnitId: 'campus' },
  { id: 'prog-a', parentUnitId: 'dept-a' },
  { id: 'batch-a1', parentUnitId: 'prog-a' },
  { id: 'section-a1-1', parentUnitId: 'batch-a1' },
  { id: 'batch-a2', parentUnitId: 'prog-a' },
  { id: 'dept-b', parentUnitId: 'campus' },
  { id: 'batch-b1', parentUnitId: 'dept-b' },
];
const studentA1 = { departmentUnitId: 'dept-a', programUnitId: 'prog-a', batchUnitId: 'batch-a1', sectionUnitId: 'section-a1-1' };
const studentA2 = { departmentUnitId: 'dept-a', programUnitId: 'prog-a', batchUnitId: 'batch-a2' };
const studentB1 = { departmentUnitId: 'dept-b', batchUnitId: 'batch-b1' };
const sectionOnly = { sectionUnitId: 'section-a1-1' };
const unplaced = {};

describe('institution unit descendants', () => {
  it('covers the unit and everything below it', () => {
    expect(institutionUnitDescendants('dept-a', units)).toEqual(['batch-a1', 'batch-a2', 'dept-a', 'prog-a', 'section-a1-1']);
    expect(institutionUnitDescendants('batch-b1', units)).toEqual(['batch-b1']);
  });

  it('survives a cycle and an unknown unit', () => {
    const cyclic = [{ id: 'x', parentUnitId: 'y' }, { id: 'y', parentUnitId: 'x' }];
    expect(institutionUnitDescendants('x', cyclic)).toEqual(['x', 'y']);
    expect(institutionUnitDescendants('missing', units)).toEqual(['missing']);
  });
});

describe('institution student scope', () => {
  it.each(['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'])('gives %s the whole institution, whatever the membership scope says', (role) => {
    const scope = institutionStudentScope([{ role, departmentUnitId: 'dept-b' }], units);
    expect(scope).toEqual({ kind: 'INSTITUTION' });
    for (const student of [studentA1, studentB1, unplaced]) expect(isStudentInInstitutionScope(scope, student)).toBe(true);
  });

  it('limits a department head to their department, including its programmes, batches and sections', () => {
    const scope = institutionStudentScope([{ role: 'DEPARTMENT_HEAD', departmentUnitId: 'dept-a' }], units);
    expect(isStudentInInstitutionScope(scope, studentA1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA2)).toBe(true);
    expect(isStudentInInstitutionScope(scope, sectionOnly)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentB1)).toBe(false);
    expect(isStudentInInstitutionScope(scope, unplaced)).toBe(false);
  });

  it('narrows a faculty member to a batch within a department', () => {
    const scope = institutionStudentScope([{ role: 'FACULTY_LECTURER', departmentUnitId: 'dept-a', batchUnitId: 'batch-a1' }], units);
    expect(isStudentInInstitutionScope(scope, studentA1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA2)).toBe(false);
    expect(isStudentInInstitutionScope(scope, studentB1)).toBe(false);
  });

  it('treats a campus-level scope as everything on that campus', () => {
    const scope = institutionStudentScope([{ role: 'PLACEMENT_ADMIN', departmentUnitId: 'campus' }], units);
    for (const student of [studentA1, studentA2, studentB1]) expect(isStudentInInstitutionScope(scope, student)).toBe(true);
    expect(isStudentInInstitutionScope(scope, unplaced)).toBe(false);
  });

  it.each(['PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'])('keeps an unscoped %s institution-wide, as staff actions always have', (role) => {
    expect(institutionStudentScope([{ role }], units)).toEqual({ kind: 'INSTITUTION' });
  });

  it('unions two scoped memberships', () => {
    const scope = institutionStudentScope([
      { role: 'FACULTY_LECTURER', departmentUnitId: 'dept-a', batchUnitId: 'batch-a1' },
      { role: 'DEPARTMENT_HEAD', departmentUnitId: 'dept-b' },
    ], units);
    expect(isStudentInInstitutionScope(scope, studentA1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentB1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA2)).toBe(false);
  });

  it('sees nobody without a qualifying staff membership', () => {
    const scope = institutionStudentScope([{ role: 'RECRUITER', departmentUnitId: 'dept-a' }], units);
    expect(scope).toEqual({ kind: 'NONE' });
    expect(isStudentInInstitutionScope(scope, studentA1)).toBe(false);
    expect(institutionStudentScope([], units)).toEqual({ kind: 'NONE' });
  });
});
