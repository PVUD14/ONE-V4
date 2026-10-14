/**
 * Internal capability model (OPS-01, ADR-032): baseline bundles, effective
 * capabilities, the ACTIVE-only rule and the grant/revoke refusals.
 *
 * The baseline assertions are the regression guard for "effective behaviour for the
 * three roles must be unchanged": they pin each role to what the code allowed before
 * capabilities existed.
 */
import { describe, expect, it } from 'vitest';
import {
  auditSearchRoles,
  baselineInternalCapabilities,
  effectiveInternalCapabilities,
  hasInternalCapability,
  highRiskInternalCapabilities,
  internalCapabilities,
  internalCapabilityBaselines,
  refuseInternalCapabilityGrant,
  refuseInternalCapabilityRevoke,
  resolveInternalCapability,
  superAdminBreakGlassCapabilities,
  type InternalCapability,
  type InternalCapabilityChangeInput,
} from './index.js';

const active = (role: string, grants: readonly string[] = []) => ({ memberships: [{ role, state: 'ACTIVE', grants }] });

describe('baseline bundles preserve what each role could do before OPS-01', () => {
  // Endpoints guarded by the audit-search family admitted all three roles.
  const auditFamily: readonly InternalCapability[] = ['SECURITY_AUDIT_SEARCH', 'OPS_JOBS_REPLAY', 'PRIVACY_REQUESTS', 'PRIVACY_HOLDS',
    'TRUST_SAFETY_INVESTIGATE', 'TRUST_SAFETY_ENFORCE', 'OPS_FLAGS_MANAGE'];
  // Organisations, verification, users and invitations admitted super and operations only.
  const organisationFamily: readonly InternalCapability[] = ['OPS_ORG_MANAGE', 'OPS_VERIFY'];

  it.each(auditSearchRoles)('%s holds every capability behind the audit-search family', (role) => {
    for (const capability of auditFamily) expect(hasInternalCapability(active(role), capability)).toBe(true);
  });

  it('keeps SECURITY_ADMIN out of organisations and verification, as before', () => {
    for (const capability of organisationFamily) {
      expect(hasInternalCapability(active('SECURITY_ADMIN'), capability)).toBe(false);
      expect(hasInternalCapability(active('OPERATIONS_ADMIN'), capability)).toBe(true);
      expect(hasInternalCapability(active('PLATFORM_SUPER_ADMIN'), capability)).toBe(true);
    }
  });

  it('preserves SECURITY_ADMIN feature-flag control (divergence D1 from the plan table)', () => {
    expect(baselineInternalCapabilities('SECURITY_ADMIN')).toContain('OPS_FLAGS_MANAGE');
  });

  it('gives CAPABILITY_ADMIN and APPROVE_HIGH_RISK to the super admin baseline only', () => {
    expect(baselineInternalCapabilities('PLATFORM_SUPER_ADMIN')).toEqual(expect.arrayContaining(['CAPABILITY_ADMIN', 'APPROVE_HIGH_RISK']));
    for (const role of ['OPERATIONS_ADMIN', 'SECURITY_ADMIN']) {
      expect(baselineInternalCapabilities(role)).not.toContain('CAPABILITY_ADMIN');
      expect(baselineInternalCapabilities(role)).not.toContain('APPROVE_HIGH_RISK');
    }
  });

  it('makes the super admin baseline a superset of both other baselines', () => {
    const superBaseline = internalCapabilityBaselines.PLATFORM_SUPER_ADMIN;
    for (const capability of [...internalCapabilityBaselines.OPERATIONS_ADMIN, ...internalCapabilityBaselines.SECURITY_ADMIN]) {
      expect(superBaseline).toContain(capability);
    }
  });

  it('holds every capability for the super admin except the faculty-only one, the rest as break-glass', () => {
    const effective = effectiveInternalCapabilities('PLATFORM_SUPER_ADMIN');
    expect(effective).toHaveLength(internalCapabilities.length - 1);
    expect(effective).not.toContain('CONTENT_REVIEW_EXTERNAL');
    expect([...superAdminBreakGlassCapabilities].sort()).toEqual(['AI_OPS_CONFIGURE', 'CATALOGUE_MANAGE', 'CONTENT_EDIT', 'CONTENT_PUBLISH', 'CONTENT_REVIEW']);
    expect(resolveInternalCapability(active('PLATFORM_SUPER_ADMIN'), 'CONTENT_PUBLISH')).toBe('BREAK_GLASS');
    expect(resolveInternalCapability(active('PLATFORM_SUPER_ADMIN'), 'OPS_VERIFY')).toBe('BASELINE');
  });

  it('gives no internal capability to an institution, employer or student role', () => {
    for (const role of ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER', 'EMPLOYER_ADMIN', 'RECRUITER', 'STUDENT']) {
      expect(effectiveInternalCapabilities(role)).toEqual([]);
    }
  });
});

describe('effective capabilities and grants', () => {
  it('adds a granted capability to a platform role', () => {
    expect(hasInternalCapability(active('SECURITY_ADMIN'), 'SUPPORT_CASES')).toBe(false);
    expect(hasInternalCapability(active('SECURITY_ADMIN', ['SUPPORT_CASES']), 'SUPPORT_CASES')).toBe(true);
    expect(resolveInternalCapability(active('SECURITY_ADMIN', ['SUPPORT_CASES']), 'SUPPORT_CASES')).toBe('GRANT');
  });

  it('ignores an internal grant on a membership outside the platform roles', () => {
    expect(hasInternalCapability(active('INSTITUTION_ADMIN', ['SUPPORT_CASES', 'OPS_ORG_MANAGE']), 'SUPPORT_CASES')).toBe(false);
    expect(effectiveInternalCapabilities('INSTITUTION_ADMIN', ['OPS_ORG_MANAGE'])).toEqual([]);
  });

  it('honours the faculty review grant only on faculty and department heads', () => {
    expect(hasInternalCapability(active('FACULTY_LECTURER', ['CONTENT_REVIEW_EXTERNAL']), 'CONTENT_REVIEW_EXTERNAL')).toBe(true);
    expect(hasInternalCapability(active('DEPARTMENT_HEAD', ['CONTENT_REVIEW_EXTERNAL']), 'CONTENT_REVIEW_EXTERNAL')).toBe(true);
    expect(hasInternalCapability(active('INSTITUTION_ADMIN', ['CONTENT_REVIEW_EXTERNAL']), 'CONTENT_REVIEW_EXTERNAL')).toBe(false);
    expect(hasInternalCapability(active('OPERATIONS_ADMIN', ['CONTENT_REVIEW_EXTERNAL']), 'CONTENT_REVIEW_EXTERNAL')).toBe(false);
  });

  it('ignores strings that are not capabilities', () => {
    expect(effectiveInternalCapabilities('SECURITY_ADMIN', ['EVERYTHING', 'INSTITUTION_ANALYTICS'])).toEqual(effectiveInternalCapabilities('SECURITY_ADMIN'));
  });

  it('prefers a baseline over break-glass when a caller has both memberships', () => {
    const context = { memberships: [
      { role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE', grants: [] },
      { role: 'OPERATIONS_ADMIN', state: 'ACTIVE', grants: ['CONTENT_EDIT'] },
    ] };
    expect(resolveInternalCapability(context, 'CONTENT_EDIT')).toBe('GRANT');
  });
});

describe('only ACTIVE memberships count', () => {
  it.each(['PENDING', 'SUSPENDED', 'ENDED'])('denies a %s membership its baseline and its grants', (state) => {
    const context = { memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state, grants: ['SUPPORT_CASES'] }] };
    for (const capability of internalCapabilities) expect(hasInternalCapability(context, capability)).toBe(false);
  });

  it('denies a caller with no memberships', () => {
    expect(hasInternalCapability({ memberships: [] }, 'SECURITY_AUDIT_SEARCH')).toBe(false);
  });
});

describe('grant and revoke refusals', () => {
  const superAdmin = { userId: 'actor', memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE', grants: [] }] };
  const target = { userId: 'target', role: 'SECURITY_ADMIN', state: 'ACTIVE', organizationKind: 'PLATFORM', grants: [] as readonly string[] };
  const input = (over: Partial<InternalCapabilityChangeInput> = {}): InternalCapabilityChangeInput => ({ actor: superAdmin, target, capability: 'SUPPORT_CASES', ...over });

  it('allows a super admin to grant a capability outside the target baseline', () => {
    expect(refuseInternalCapabilityGrant(input())).toBeNull();
  });

  it('refuses a caller without CAPABILITY_ADMIN', () => {
    expect(refuseInternalCapabilityGrant(input({ actor: { userId: 'actor', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] } }))).toBe('FORBIDDEN');
  });

  it('refuses a self-grant, even for the super admin', () => {
    expect(refuseInternalCapabilityGrant(input({ target: { ...target, userId: 'actor' } }))).toBe('CAPABILITY_SELF_CHANGE_REFUSED');
  });

  it('refuses a grant to a membership outside the platform organisation', () => {
    expect(refuseInternalCapabilityGrant(input({ target: { ...target, role: 'INSTITUTION_ADMIN', organizationKind: 'INSTITUTION' } }))).toBe('CAPABILITY_ROLE_NOT_ELIGIBLE');
  });

  it('refuses a grant to an inactive membership', () => {
    expect(refuseInternalCapabilityGrant(input({ target: { ...target, state: 'SUSPENDED' } }))).toBe('MEMBERSHIP_NOT_ACTIVE');
  });

  it('refuses a capability the target already holds', () => {
    expect(refuseInternalCapabilityGrant(input({ capability: 'SECURITY_AUDIT_SEARCH' }))).toBe('CAPABILITY_ALREADY_HELD');
    expect(refuseInternalCapabilityGrant(input({ target: { ...target, grants: ['SUPPORT_CASES'] } }))).toBe('CAPABILITY_ALREADY_HELD');
  });

  it('never grants faculty review from the staff screen', () => {
    expect(refuseInternalCapabilityGrant(input({ capability: 'CONTENT_REVIEW_EXTERNAL' }))).toBe('CAPABILITY_NOT_GRANTABLE_HERE');
  });

  // OPS-02 replaced OPS-01's interim rule (only a super admin could grant these) with dual
  // control: every high-risk grant needs an approval, and the super admin is not exempt.
  it.each(highRiskInternalCapabilities)('requires an approval for a %s grant, from a delegate and a super admin alike', (capability) => {
    const delegate = { userId: 'actor', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE', grants: ['CAPABILITY_ADMIN'] }] };
    const fresh = { ...target, role: 'OPERATIONS_ADMIN' };
    const held = effectiveInternalCapabilities('OPERATIONS_ADMIN').includes(capability);
    for (const actor of [delegate, superAdmin]) {
      expect(refuseInternalCapabilityGrant({ actor, target: fresh, capability })).toBe(held ? 'CAPABILITY_ALREADY_HELD' : 'APPROVAL_REQUIRED');
      expect(refuseInternalCapabilityGrant({ actor, target: fresh, capability, withApproval: true })).toBe(held ? 'CAPABILITY_ALREADY_HELD' : null);
    }
  });

  it('lets a delegated CAPABILITY_ADMIN grant an ordinary capability', () => {
    const delegate = { userId: 'actor', memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE', grants: ['CAPABILITY_ADMIN'] }] };
    expect(refuseInternalCapabilityGrant(input({ actor: delegate, capability: 'SUPPORT_CASES' }))).toBeNull();
  });

  it('revokes only a live grant, never a baseline, and never on oneself', () => {
    expect(refuseInternalCapabilityRevoke(input({ target: { ...target, grants: ['SUPPORT_CASES'] } }))).toBeNull();
    expect(refuseInternalCapabilityRevoke(input({ capability: 'SECURITY_AUDIT_SEARCH' }))).toBe('CAPABILITY_NOT_GRANTED');
    expect(refuseInternalCapabilityRevoke(input({ target: { ...target, userId: 'actor', grants: ['SUPPORT_CASES'] } }))).toBe('CAPABILITY_SELF_CHANGE_REFUSED');
  });
});
