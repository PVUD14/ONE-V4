import { describe, expect, it } from 'vitest';
import {
  auditSearchRoles,
  canEmployerReadApplicant,
  canInstitutionReadStudentActivity,
  canReadInstitutionAnalytics,
  canSearchAuditEvents,
  canonicalInstitutionRelationshipPolicy,
  type AuditSearchScope,
  institutionAnalyticsCapableRoles,
  institutionForbiddenDisclosureFields,
  institutionRelationshipAuthorizesActivity,
  isInstitutionForbiddenDisclosureField,
  type InstitutionAnalyticsScope,
  type TemporalInstitutionScope,
} from './index.js';

describe('temporal institution authorization', () => {
  const from = new Date('2025-06-01T00:00:00.000Z');
  const to = new Date('2026-06-01T00:00:00.000Z');
  const oneMsBeforeTo = new Date(to.getTime() - 1);

  function scope(relationshipState: TemporalInstitutionScope['relationshipState'], effectiveTo?: Date): TemporalInstitutionScope {
    return {
      institutionId: 'college-a',
      relationshipState,
      effectiveFrom: from,
      ...(effectiveTo ? { effectiveTo } : {}),
    };
  }

  it('documents the canonical exclusive effective_to boundary', () => {
    expect(canonicalInstitutionRelationshipPolicy.effectiveToBoundary).toBe('exclusive');
  });

  it.each([
    ['before effective_from', scope('ACTIVE', to), new Date('2025-05-31T23:59:59.999Z'), false],
    ['exactly effective_from', scope('ACTIVE', to), from, true],
    ['inside active window', scope('ACTIVE', to), new Date('2025-12-01T00:00:00.000Z'), true],
    ['immediately before effective_to', scope('ACTIVE', to), oneMsBeforeTo, true],
    ['exactly effective_to', scope('ACTIVE', to), to, false],
    ['after effective_to', scope('ACTIVE', to), new Date('2026-06-01T00:00:00.001Z'), false],
    ['continuing active without effective_to', scope('ACTIVE'), new Date('2026-07-01T00:00:00.000Z'), true],
    ['transferred historical access before effective_to', scope('TRANSFERRED', to), oneMsBeforeTo, true],
    ['transferred post-end denial', scope('TRANSFERRED', to), to, false],
    ['transferred missing effective_to fails closed', scope('TRANSFERRED'), new Date('2025-12-01T00:00:00.000Z'), false],
    ['graduated historical access before effective_to', scope('GRADUATED', to), oneMsBeforeTo, true],
    ['graduated post-end denial', scope('GRADUATED', to), to, false],
    ['graduated missing effective_to fails closed', scope('GRADUATED'), new Date('2025-12-01T00:00:00.000Z'), false],
    ['revoked denies inside prior window', scope('REVOKED', to), new Date('2025-12-01T00:00:00.000Z'), false],
    ['pending denies inside window', scope('PENDING', to), new Date('2025-12-01T00:00:00.000Z'), false],
    ['ended remains denied pending explicit historical policy', scope('ENDED', to), new Date('2025-12-01T00:00:00.000Z'), false],
  ])('%s', (_name, candidateScope, activityAt, expected) => {
    expect(institutionRelationshipAuthorizesActivity(candidateScope, activityAt)).toBe(expected);
  });

  it('permits activity inside an active relationship window', () => {
    expect(
      canInstitutionReadStudentActivity(
        {
          institutionId: 'college-b',
          relationshipState: 'ACTIVE',
          effectiveFrom: new Date('2026-06-02T00:00:00Z'),
        },
        new Date('2026-07-01T00:00:00Z'),
      ),
    ).toBe(true);
  });
});

describe('employer applicant authorization', () => {
  it('denies access to another employer application', () => {
    expect(
      canEmployerReadApplicant({
        employerId: 'employer-a',
        owningEmployerId: 'employer-b',
        applicationStatus: 'SCREENING',
      }),
    ).toBe(false);
  });

  it('denies access after consent is revoked', () => {
    expect(
      canEmployerReadApplicant({
        employerId: 'employer-a',
        owningEmployerId: 'employer-a',
        applicationStatus: 'WITHDRAWN',
        consentRevokedAt: new Date(),
      }),
    ).toBe(false);
  });
});

describe('institution analytics capability', () => {
  function scope(overrides: Partial<InstitutionAnalyticsScope> = {}): InstitutionAnalyticsScope {
    return {
      institutionId: 'college-a',
      requestedInstitutionId: 'college-a',
      role: 'INSTITUTION_ADMIN',
      membershipState: 'ACTIVE',
      analyticsCapabilityGranted: true,
      ...overrides,
    };
  }

  it('names exactly the two roles ADR-018 makes capable', () => {
    expect([...institutionAnalyticsCapableRoles]).toStrictEqual(['INSTITUTION_ADMIN', 'DEPARTMENT_HEAD']);
  });

  it.each([
    ['granted institution admin', scope(), true],
    ['granted department head', scope({ role: 'DEPARTMENT_HEAD' }), true],
    ['capable role without the grant', scope({ analyticsCapabilityGranted: false }), false],
    ['placement admin holding the grant', scope({ role: 'PLACEMENT_ADMIN' }), false],
    ['faculty holding the grant', scope({ role: 'FACULTY_LECTURER' }), false],
    ['the dropped analyst role holding the grant', scope({ role: 'INSTITUTION_ANALYST' }), false],
    ['another institution', scope({ requestedInstitutionId: 'college-b' }), false],
    ['pending membership', scope({ membershipState: 'PENDING' }), false],
    ['suspended membership', scope({ membershipState: 'SUSPENDED' }), false],
    ['ended membership', scope({ membershipState: 'ENDED' }), false],
  ])('%s', (_name, candidateScope, expected) => {
    expect(canReadInstitutionAnalytics(candidateScope)).toBe(expected);
  });
});

describe('institution disclosure exclusions', () => {
  it.each([
    ['compensation_currency', true],
    ['compensation_amount', true],
    ['compensation_period', true],
    ['state', false],
    ['joining_date', false],
    ['reference_code', false],
  ])('%s is excluded: %s', (field, expected) => {
    expect(isInstitutionForbiddenDisclosureField(field)).toBe(expected);
  });

  it('excludes every compensation column on offers and nothing else', () => {
    expect([...institutionForbiddenDisclosureFields]).toStrictEqual([
      'compensation_currency',
      'compensation_amount',
      'compensation_period',
    ]);
  });
});

describe('audit event search authorization', () => {
  function scope(overrides: Partial<AuditSearchScope> = {}): AuditSearchScope {
    return { role: 'SECURITY_ADMIN', membershipState: 'ACTIVE', ...overrides };
  }

  it('admits exactly the three cross-tenant platform roles', () => {
    expect([...auditSearchRoles]).toStrictEqual(['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN']);
  });

  it.each([
    ['security admin', scope(), true],
    ['operations admin', scope({ role: 'OPERATIONS_ADMIN' }), true],
    ['platform super admin', scope({ role: 'PLATFORM_SUPER_ADMIN' }), true],
    ['institution admin', scope({ role: 'INSTITUTION_ADMIN' }), false],
    ['department head', scope({ role: 'DEPARTMENT_HEAD' }), false],
    ['recruiter', scope({ role: 'RECRUITER' }), false],
    ['suspended security admin', scope({ membershipState: 'SUSPENDED' }), false],
    ['ended operations admin', scope({ role: 'OPERATIONS_ADMIN', membershipState: 'ENDED' }), false],
    ['pending platform super admin', scope({ role: 'PLATFORM_SUPER_ADMIN', membershipState: 'PENDING' }), false],
  ])('%s', (_name, candidateScope, expected) => {
    expect(canSearchAuditEvents(candidateScope)).toBe(expected);
  });
});
