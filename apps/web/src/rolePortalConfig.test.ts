/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-08
 * Agent-assisted: yes (Claude) · Reviewed: pending
 */
import { describe, expect, it } from 'vitest';
import { institutionStaffWorkspaceRoles, institutionWorkspaceRoles } from './rolePortal/shared.js';
import { rolePortals } from './rolePortalConfig.js';

function navLabels(key: string): readonly string[] {
  const portal = rolePortals.find((candidate) => candidate.key === key);
  if (!portal) throw new Error(`no portal for ${key}`);
  return portal.nav.map((item) => item.label);
}

describe('placement officer navigation', () => {
  it('keeps every previously shipped item in its original position', () => {
    // The standing rule is that sidebar items are never removed, renamed or
    // reordered. New screens were appended, so the three items that shipped before
    // must still be the first three, in the same order. This test exists so a later
    // tidy-up of the menu has to be a deliberate decision rather than a silent one.
    expect(navLabels('placement-officer').slice(0, 3)).toStrictEqual([
      'Dashboard', 'Assessments', 'Help & FAQ',
    ]);
  });

  it('adds the five placement screens after them', () => {
    expect(navLabels('placement-officer')).toStrictEqual([
      'Dashboard', 'Assessments', 'Help & FAQ',
      'Students', 'Student Search', 'Readiness',
      'Departments', 'Batches',
    ]);
  });

  it('gives every navigation item a distinct route', () => {
    const portal = rolePortals.find((candidate) => candidate.key === 'placement-officer')!;
    const paths = portal.nav.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('placement officer workspace predicates', () => {
  it('is institution staff, not an institution administrator', () => {
    // Routing a Placement Officer screen through the admin predicate denies the very
    // role the screen exists for, even where the server would have allowed the read.
    // Screens for this role use the staff predicate; the admin one stays for
    // management surfaces.
    expect(institutionWorkspaceRoles.has('PLACEMENT_ADMIN')).toBe(false);
    expect(institutionStaffWorkspaceRoles.has('PLACEMENT_ADMIN')).toBe(true);
  });
});
