/**
 * Tree cases for the institution student scope: which students a staff member sees
 * given their memberships and the institution's unit tree.
 */
import { describe, expect, it } from 'vitest';
import {
  canAddressInstitutionAudience,
  institutionAnnouncementScope,
  institutionAnnouncementSender,
  institutionScopeAnchors,
  institutionStudentScope,
  institutionStudentWriteScope,
  institutionUnitDescendants,
  isUnitWithin,
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

// INST-03: once an institution records teaching assignments, a faculty member's scope is
// exactly the sections and batches they are assigned to teach.
describe('faculty scope from teaching assignments', () => {
  it('limits a faculty member to their assigned section', () => {
    const scope = institutionStudentScope([{ role: 'FACULTY_LECTURER', teachingUnitIds: ['section-a1-1'] }], units);
    expect(isStudentInInstitutionScope(scope, studentA1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, sectionOnly)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA2)).toBe(false);
    expect(isStudentInInstitutionScope(scope, studentB1)).toBe(false);
  });

  it('covers every section of an assigned batch, and unions several assignments', () => {
    const scope = institutionStudentScope([{ role: 'FACULTY_LECTURER', teachingUnitIds: ['batch-a1', 'batch-b1'] }], units);
    for (const student of [studentA1, sectionOnly, studentB1]) expect(isStudentInInstitutionScope(scope, student)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA2)).toBe(false);
  });

  it('ignores the membership department and batch once assignments are in use', () => {
    const scope = institutionStudentScope([{ role: 'FACULTY_LECTURER', departmentUnitId: 'dept-a', teachingUnitIds: ['batch-b1'] }], units);
    expect(isStudentInInstitutionScope(scope, studentB1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA2)).toBe(false);
  });

  it('gives an unassigned faculty member nobody, even when the membership is unscoped', () => {
    expect(institutionStudentScope([{ role: 'FACULTY_LECTURER', teachingUnitIds: [] }], units)).toEqual({ kind: 'NONE' });
  });

  it('does not narrow other roles by teaching assignments', () => {
    expect(institutionStudentScope([{ role: 'INSTITUTION_ADMIN', teachingUnitIds: [] }], units)).toEqual({ kind: 'INSTITUTION' });
    const head = institutionStudentScope([{ role: 'DEPARTMENT_HEAD', departmentUnitId: 'dept-b', teachingUnitIds: ['section-a1-1'] }], units);
    expect(isStudentInInstitutionScope(head, studentB1)).toBe(true);
    expect(isStudentInInstitutionScope(head, studentA1)).toBe(false);
  });

  it('unions an assigned faculty membership with a department head membership', () => {
    const scope = institutionStudentScope([
      { role: 'FACULTY_LECTURER', teachingUnitIds: [] },
      { role: 'DEPARTMENT_HEAD', departmentUnitId: 'dept-b' },
    ], units);
    expect(isStudentInInstitutionScope(scope, studentB1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA1)).toBe(false);
  });

  it('names the units a membership is anchored on', () => {
    expect(institutionScopeAnchors({ role: 'FACULTY_LECTURER', departmentUnitId: 'dept-a', teachingUnitIds: ['batch-b1'] })).toEqual(['batch-b1']);
    expect(institutionScopeAnchors({ role: 'FACULTY_LECTURER', departmentUnitId: 'dept-a', batchUnitId: 'batch-a1' })).toEqual(['dept-a', 'batch-a1']);
    expect(institutionScopeAnchors({ role: 'DEPARTMENT_HEAD', departmentUnitId: 'dept-a', teachingUnitIds: ['batch-b1'] })).toEqual(['dept-a']);
  });
});

describe('unit containment for scoped writes', () => {
  it('accepts a unit at or below the anchor and refuses one outside it', () => {
    expect(isUnitWithin('section-a1-1', 'dept-a', units)).toBe(true);
    expect(isUnitWithin('dept-a', 'dept-a', units)).toBe(true);
    expect(isUnitWithin('batch-b1', 'dept-a', units)).toBe(false);
    expect(isUnitWithin('dept-a', 'batch-a1', units)).toBe(false);
  });
});

// INST-SR-02: permanent writes (verification decisions, results import) do not inherit the
// read fallbacks. Reads are unchanged — see "keeps an unscoped %s institution-wide" above.
describe('write scope for permanent student-record changes', () => {
  it.each(['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'])('keeps %s institution-wide', (role) => {
    expect(institutionStudentWriteScope([{ role }], units)).toEqual({ kind: 'INSTITUTION' });
  });

  it('keeps an unscoped placement admin institution-wide, as for reads', () => {
    expect(institutionStudentWriteScope([{ role: 'PLACEMENT_ADMIN' }], units)).toEqual({ kind: 'INSTITUTION' });
  });

  it('gives a department head without a department nobody, where reads give the whole institution', () => {
    expect(institutionStudentScope([{ role: 'DEPARTMENT_HEAD' }], units)).toEqual({ kind: 'INSTITUTION' });
    expect(institutionStudentWriteScope([{ role: 'DEPARTMENT_HEAD' }], units)).toEqual({ kind: 'NONE' });
    expect(institutionStudentWriteScope([{ role: 'DEPARTMENT_HEAD', batchUnitId: 'batch-a1' }], units)).toEqual({ kind: 'NONE' });
  });

  it('leaves a department head with a department exactly as for reads', () => {
    const membership = [{ role: 'DEPARTMENT_HEAD', departmentUnitId: 'dept-a' }];
    expect(institutionStudentWriteScope(membership, units)).toEqual(institutionStudentScope(membership, units));
  });

  it('gives faculty nobody before any active teaching assignment, whatever the membership scope', () => {
    expect(institutionStudentScope([{ role: 'FACULTY_LECTURER' }], units)).toEqual({ kind: 'INSTITUTION' });
    expect(institutionStudentWriteScope([{ role: 'FACULTY_LECTURER' }], units)).toEqual({ kind: 'NONE' });
    expect(institutionStudentWriteScope([{ role: 'FACULTY_LECTURER', departmentUnitId: 'dept-a' }], units)).toEqual({ kind: 'NONE' });
    expect(institutionStudentWriteScope([{ role: 'FACULTY_LECTURER', teachingUnitIds: [] }], units)).toEqual({ kind: 'NONE' });
  });

  it('limits faculty with a teaching assignment to the assigned units, as for reads', () => {
    const scope = institutionStudentWriteScope([{ role: 'FACULTY_LECTURER', departmentUnitId: 'dept-b', teachingUnitIds: ['batch-a1'] }], units);
    expect(isStudentInInstitutionScope(scope, studentA1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA2)).toBe(false);
    expect(isStudentInInstitutionScope(scope, studentB1)).toBe(false);
  });

  it('keeps a scoped membership held alongside an unscoped head', () => {
    const scope = institutionStudentWriteScope([{ role: 'DEPARTMENT_HEAD' }, { role: 'FACULTY_LECTURER', teachingUnitIds: ['batch-b1'] }], units);
    expect(isStudentInInstitutionScope(scope, studentB1)).toBe(true);
    expect(isStudentInInstitutionScope(scope, studentA1)).toBe(false);
  });

  it('is the definition announcements send through', () => {
    for (const membership of [{ role: 'DEPARTMENT_HEAD' }, { role: 'DEPARTMENT_HEAD', departmentUnitId: 'dept-b' }, { role: 'FACULTY_LECTURER', departmentUnitId: 'dept-a' },
      { role: 'FACULTY_LECTURER', teachingUnitIds: ['section-a1-1'] }, { role: 'PLACEMENT_ADMIN', departmentUnitId: 'dept-a' }, { role: 'INSTITUTION_ADMIN' }]) {
      expect(institutionAnnouncementScope([membership], units), membership.role).toEqual(institutionStudentWriteScope([membership], units));
    }
  });
});

describe('announcement senders (INST-06, decision 10.2 #8)', () => {
  it('lets owners, admins and unscoped placement admins address the whole institution', () => {
    for (const role of ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN']) {
      const scope = institutionAnnouncementScope([{ role }], units);
      expect(canAddressInstitutionAudience(scope, null)).toBe(true);
      expect(canAddressInstitutionAudience(scope, 'batch-b1')).toBe(true);
    }
  });

  it('narrows a scoped placement admin to their department', () => {
    const scope = institutionAnnouncementScope([{ role: 'PLACEMENT_ADMIN', departmentUnitId: 'dept-a' }], units);
    expect(canAddressInstitutionAudience(scope, null)).toBe(false);
    expect(canAddressInstitutionAudience(scope, 'batch-a1')).toBe(true);
    expect(canAddressInstitutionAudience(scope, 'dept-b')).toBe(false);
  });

  it('limits a department head to their department and gives an unscoped head nobody', () => {
    const scope = institutionAnnouncementScope([{ role: 'DEPARTMENT_HEAD', departmentUnitId: 'dept-a' }], units);
    expect(canAddressInstitutionAudience(scope, 'dept-a')).toBe(true);
    expect(canAddressInstitutionAudience(scope, 'section-a1-1')).toBe(true);
    expect(canAddressInstitutionAudience(scope, 'campus')).toBe(false);
    expect(canAddressInstitutionAudience(scope, 'batch-b1')).toBe(false);
    expect(institutionAnnouncementScope([{ role: 'DEPARTMENT_HEAD' }], units)).toEqual({ kind: 'NONE' });
  });

  it('limits faculty to their assigned units, and gives faculty without assignments nobody', () => {
    const scope = institutionAnnouncementScope([{ role: 'FACULTY_LECTURER', teachingUnitIds: ['batch-a1'] }], units);
    expect(canAddressInstitutionAudience(scope, 'batch-a1')).toBe(true);
    expect(canAddressInstitutionAudience(scope, 'section-a1-1')).toBe(true);
    expect(canAddressInstitutionAudience(scope, 'batch-a2')).toBe(false);
    expect(canAddressInstitutionAudience(scope, 'dept-a')).toBe(false);
    expect(canAddressInstitutionAudience(scope, null)).toBe(false);
    // The read fallback (department/batch, or institution-wide when unscoped) never applies to sending.
    expect(institutionAnnouncementScope([{ role: 'FACULTY_LECTURER' }], units)).toEqual({ kind: 'NONE' });
    expect(institutionAnnouncementScope([{ role: 'FACULTY_LECTURER', departmentUnitId: 'dept-a' }], units)).toEqual({ kind: 'NONE' });
  });

  it('requires every anchor of a clause to cover the audience', () => {
    const scope = institutionAnnouncementScope([{ role: 'PLACEMENT_ADMIN', departmentUnitId: 'dept-a', batchUnitId: 'batch-a1' }], units);
    expect(canAddressInstitutionAudience(scope, 'section-a1-1')).toBe(true);
    expect(canAddressInstitutionAudience(scope, 'dept-a')).toBe(false);
    expect(canAddressInstitutionAudience(scope, 'batch-a2')).toBe(false);
  });

  it('never lets other roles send', () => {
    expect(institutionAnnouncementScope([{ role: 'CAREER_COUNSELOR' }, { role: 'STUDENT' }], units)).toEqual({ kind: 'NONE' });
  });

  it('picks the most senior membership that admits the audience', () => {
    const memberships = [
      { role: 'FACULTY_LECTURER', membershipId: 'faculty', teachingUnitIds: ['section-a1-1'] },
      { role: 'DEPARTMENT_HEAD', membershipId: 'head', departmentUnitId: 'dept-a' },
    ];
    expect(institutionAnnouncementSender(memberships, units, 'section-a1-1')?.membership.membershipId).toBe('head');
    expect(institutionAnnouncementSender(memberships, units, 'batch-b1')).toBeNull();
    expect(institutionAnnouncementSender([memberships[0]!], units, 'section-a1-1')?.membership.membershipId).toBe('faculty');
  });
});
