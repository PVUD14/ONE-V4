/**
 * Growth roles and the operator-side growth capabilities (GROWTH-01, ADR-040).
 *
 * The rule under test is ADR-040 decision 2: a growth person starts from no authority
 * and can never be given any. The two growth login roles hold no internal capability by
 * baseline, no grant can ever count for them, and the operator side (GROWTH_ADMIN,
 * GROWTH_FINANCE) is a super-admin baseline grantable only to operations admins.
 */
import { describe, expect, it } from 'vitest';
import {
  baselineInternalCapabilities,
  effectiveInternalCapabilities,
  growthRoles,
  growthStaffTypes,
  growthTeams,
  growthWorkspaceRole,
  hasInternalCapability,
  internalCapabilities,
  isGrowthRole,
  isHighRiskInternalCapability,
  isInternalCapabilityGrantableToRole,
  isPlatformInternalRole,
  platformStaffOnlyRoles,
  refuseGrowthTeamChange,
  refuseInternalCapabilityGrant,
  superAdminBreakGlassCapabilities,
  type InternalCapability,
} from './index.js';

const active = (role: string, grants: readonly string[] = []) => ({ memberships: [{ role, state: 'ACTIVE', grants }] });

describe('growth login roles hold no internal authority and cannot be given any', () => {
  it('names exactly the two growth roles, neither of which is an internal platform role', () => {
    expect(growthRoles).toEqual(['GROWTH_EXECUTIVE', 'GROWTH_MANAGER']);
    for (const role of growthRoles) {
      expect(isGrowthRole(role)).toBe(true);
      expect(isPlatformInternalRole(role)).toBe(false);
    }
    for (const role of ['OPERATIONS_ADMIN', 'PLATFORM_SUPER_ADMIN', 'SECURITY_ADMIN', 'INSTITUTION_ADMIN', 'RECRUITER']) {
      expect(isGrowthRole(role)).toBe(false);
    }
  });

  it.each(growthRoles)('%s has an empty baseline and an empty effective set even with every grant row present', (role) => {
    expect(baselineInternalCapabilities(role)).toEqual([]);
    expect(effectiveInternalCapabilities(role, internalCapabilities)).toEqual([]);
    for (const capability of internalCapabilities) {
      expect(isInternalCapabilityGrantableToRole(capability, role)).toBe(false);
      expect(hasInternalCapability(active(role, internalCapabilities), capability)).toBe(false);
    }
  });

  it.each(growthRoles)('refuses to grant any capability to a %s membership', (role) => {
    const superAdmin = { userId: 'actor', memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE', grants: [] }] };
    const target = { userId: 'target', role, state: 'ACTIVE', organizationKind: 'PLATFORM', grants: [] };
    for (const capability of internalCapabilities) {
      const refusal = refuseInternalCapabilityGrant({ actor: superAdmin, target, capability, withApproval: true });
      // Faculty review is refused earlier, from this screen, for everyone.
      expect(refusal).toBe(capability === 'CONTENT_REVIEW_EXTERNAL' ? 'CAPABILITY_NOT_GRANTABLE_HERE' : 'CAPABILITY_ROLE_NOT_ELIGIBLE');
    }
  });

  it('adds the growth roles to the staff-only roles, after the internal ones', () => {
    expect(platformStaffOnlyRoles).toEqual(['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN', 'GROWTH_EXECUTIVE', 'GROWTH_MANAGER']);
  });
});

describe('the operator-side growth capabilities', () => {
  const growthCapabilities: readonly InternalCapability[] = ['GROWTH_ADMIN', 'GROWTH_FINANCE'];

  it('are part of the internal vocabulary', () => {
    for (const capability of growthCapabilities) expect(internalCapabilities).toContain(capability);
  });

  it('are baseline for the super admin only, so they are never break-glass', () => {
    for (const capability of growthCapabilities) {
      expect(baselineInternalCapabilities('PLATFORM_SUPER_ADMIN')).toContain(capability);
      expect(superAdminBreakGlassCapabilities).not.toContain(capability);
      expect(baselineInternalCapabilities('OPERATIONS_ADMIN')).not.toContain(capability);
      expect(baselineInternalCapabilities('SECURITY_ADMIN')).not.toContain(capability);
    }
  });

  it('are grantable to an operations admin and to no other role', () => {
    for (const capability of growthCapabilities) {
      expect(isInternalCapabilityGrantableToRole(capability, 'OPERATIONS_ADMIN')).toBe(true);
      expect(isInternalCapabilityGrantableToRole(capability, 'SECURITY_ADMIN')).toBe(false);
      expect(hasInternalCapability(active('OPERATIONS_ADMIN', [capability]), capability)).toBe(true);
      // A grant row on a security admin is necessary-but-never-sufficient, like faculty review.
      expect(hasInternalCapability(active('SECURITY_ADMIN', [capability]), capability)).toBe(false);
    }
  });

  it('refuses a growth capability grant to a security admin before any approval question', () => {
    const superAdmin = { userId: 'actor', memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE', grants: [] }] };
    const target = { userId: 'target', role: 'SECURITY_ADMIN', state: 'ACTIVE', organizationKind: 'PLATFORM', grants: [] };
    for (const capability of growthCapabilities) {
      expect(refuseInternalCapabilityGrant({ actor: superAdmin, target, capability, withApproval: true })).toBe('CAPABILITY_ROLE_NOT_ELIGIBLE');
    }
  });

  it('treats GROWTH_FINANCE as high-risk (it makes commission payable) and GROWTH_ADMIN as ordinary', () => {
    expect(isHighRiskInternalCapability('GROWTH_FINANCE')).toBe(true);
    expect(isHighRiskInternalCapability('GROWTH_ADMIN')).toBe(false);
    const superAdmin = { userId: 'actor', memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE', grants: [] }] };
    const target = { userId: 'target', role: 'OPERATIONS_ADMIN', state: 'ACTIVE', organizationKind: 'PLATFORM', grants: [] };
    expect(refuseInternalCapabilityGrant({ actor: superAdmin, target, capability: 'GROWTH_FINANCE' })).toBe('APPROVAL_REQUIRED');
    expect(refuseInternalCapabilityGrant({ actor: superAdmin, target, capability: 'GROWTH_ADMIN' })).toBeNull();
  });
});

describe('growth vocabulary', () => {
  it('has two teams and two staff types, and nothing about tax', () => {
    expect(growthTeams).toEqual(['COLLEGE_PARTNERSHIPS', 'EMPLOYER_PARTNERSHIPS']);
    expect(growthStaffTypes).toEqual(['EMPLOYEE', 'CONTRACTOR']);
  });
});

describe('which growth workspace a person opens', () => {
  it('is none without an ACTIVE growth membership', () => {
    expect(growthWorkspaceRole([])).toBeNull();
    expect(growthWorkspaceRole([{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }])).toBeNull();
    expect(growthWorkspaceRole([{ role: 'GROWTH_EXECUTIVE', state: 'SUSPENDED' }])).toBeNull();
    expect(growthWorkspaceRole([{ role: 'GROWTH_MANAGER', state: 'ENDED' }])).toBeNull();
  });

  it('prefers the manager role when a person holds both', () => {
    expect(growthWorkspaceRole([{ role: 'GROWTH_EXECUTIVE', state: 'ACTIVE' }])).toBe('GROWTH_EXECUTIVE');
    expect(growthWorkspaceRole([{ role: 'GROWTH_EXECUTIVE', state: 'ACTIVE' }, { role: 'GROWTH_MANAGER', state: 'ACTIVE' }])).toBe('GROWTH_MANAGER');
  });
});

describe('who may change a growth person\'s team, type or membership', () => {
  const admin = { userId: 'admin', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE', grants: ['GROWTH_ADMIN'] }] };
  const target = { userId: 'field', role: 'GROWTH_EXECUTIVE', state: 'ACTIVE', organizationKind: 'PLATFORM' };

  it('allows a GROWTH_ADMIN holder acting on an ACTIVE growth membership', () => {
    expect(refuseGrowthTeamChange({ actor: admin, target })).toBeNull();
    expect(refuseGrowthTeamChange({ actor: { userId: 'root', memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE', grants: [] }] }, target })).toBeNull();
  });

  it('refuses an operator without GROWTH_ADMIN and every growth person', () => {
    expect(refuseGrowthTeamChange({ actor: { userId: 'ops', ...active('OPERATIONS_ADMIN') }, target })).toBe('FORBIDDEN');
    expect(refuseGrowthTeamChange({ actor: { userId: 'sec', ...active('SECURITY_ADMIN', ['GROWTH_ADMIN']) }, target })).toBe('FORBIDDEN');
    expect(refuseGrowthTeamChange({ actor: { userId: 'mgr', ...active('GROWTH_MANAGER', ['GROWTH_ADMIN']) }, target })).toBe('FORBIDDEN');
  });

  it('refuses acting on oneself, on a non-growth membership and on one that is not ACTIVE', () => {
    expect(refuseGrowthTeamChange({ actor: admin, target: { ...target, userId: 'admin' } })).toBe('GROWTH_SELF_CHANGE_REFUSED');
    expect(refuseGrowthTeamChange({ actor: admin, target: { ...target, role: 'OPERATIONS_ADMIN' } })).toBe('GROWTH_NOT_A_GROWTH_MEMBERSHIP');
    expect(refuseGrowthTeamChange({ actor: admin, target: { ...target, organizationKind: 'INSTITUTION' } })).toBe('GROWTH_NOT_A_GROWTH_MEMBERSHIP');
    expect(refuseGrowthTeamChange({ actor: admin, target: { ...target, state: 'ENDED' } })).toBe('MEMBERSHIP_NOT_ACTIVE');
  });
});
