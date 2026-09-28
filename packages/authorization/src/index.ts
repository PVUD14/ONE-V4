export interface TemporalInstitutionScope {
  readonly institutionId: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly relationshipState: 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'ENDED' | 'TRANSFERRED' | 'GRADUATED' | 'REVOKED';
}

export const canonicalInstitutionRelationshipPolicy = {
  effectiveToBoundary: 'exclusive',
  continuingAccessStates: ['VERIFIED', 'ACTIVE'],
  historicalAccessStates: ['TRANSFERRED', 'GRADUATED'],
} as const;

export function institutionRelationshipAuthorizesActivity(
  scope: TemporalInstitutionScope,
  activityOccurredAt: Date,
): boolean {
  if (activityOccurredAt < scope.effectiveFrom) return false;

  if (canonicalInstitutionRelationshipPolicy.historicalAccessStates.includes(scope.relationshipState as never)) {
    if (!scope.effectiveTo) return false;
    return activityOccurredAt < scope.effectiveTo;
  }

  if (!canonicalInstitutionRelationshipPolicy.continuingAccessStates.includes(scope.relationshipState as never)) return false;
  if (scope.effectiveTo && activityOccurredAt >= scope.effectiveTo) return false;
  return true;
}

export function canInstitutionReadStudentActivity(
  scope: TemporalInstitutionScope,
  activityOccurredAt: Date,
): boolean {
  return institutionRelationshipAuthorizesActivity(scope, activityOccurredAt);
}

export interface EmployerApplicantScope {
  readonly employerId: string;
  readonly owningEmployerId: string;
  readonly applicationStatus: 'APPLIED' | 'SCREENING' | 'SHORTLISTED' | 'ASSESSMENT' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED' | 'WITHDRAWN';
  readonly consentRevokedAt?: Date;
}

export function canEmployerReadApplicant(scope: EmployerApplicantScope): boolean {
  if (scope.employerId !== scope.owningEmployerId) return false;
  if (scope.consentRevokedAt) return false;
  return true;
}

// ADR-018: Institution Analyst is not a role. Analytics-and-export is a capability
// grantable to these two roles and to no others.
export const institutionAnalyticsCapableRoles = ['INSTITUTION_ADMIN', 'DEPARTMENT_HEAD'] as const;

export type InstitutionAnalyticsCapableRole = (typeof institutionAnalyticsCapableRoles)[number];

export interface InstitutionAnalyticsScope {
  readonly institutionId: string;
  readonly requestedInstitutionId: string;
  readonly role: string;
  readonly membershipState: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  readonly analyticsCapabilityGranted: boolean;
}

export function canReadInstitutionAnalytics(scope: InstitutionAnalyticsScope): boolean {
  if (scope.institutionId !== scope.requestedInstitutionId) return false;
  if (scope.membershipState !== 'ACTIVE') return false;
  // The grant is necessary but never sufficient: a role outside the capable set is
  // denied even holding it, so a mis-set flag cannot widen a role's reach.
  if (!institutionAnalyticsCapableRoles.includes(scope.role as InstitutionAnalyticsCapableRole)) return false;
  return scope.analyticsCapabilityGranted;
}

// ADR-024: offer compensation is never institution-visible, per student or in
// aggregate. Named here so an institution read path, report generator or export
// imports the exclusion rather than remembering it.
export const institutionForbiddenDisclosureFields = [
  'compensation_currency',
  'compensation_amount',
  'compensation_period',
] as const;

export function isInstitutionForbiddenDisclosureField(field: string): boolean {
  return institutionForbiddenDisclosureFields.includes(field as (typeof institutionForbiddenDisclosureFields)[number]);
}

// Acceptance 124 requires audit events to be searchable by authorized roles, and
// platform control 102 places that search with platform administration. Security
// Admin exists to hold exactly this and has had no capability until now.
export const auditSearchRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'] as const;

export type AuditSearchRole = (typeof auditSearchRoles)[number];

export interface AuditSearchScope {
  readonly role: string;
  readonly membershipState: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'ENDED';
}

/**
 * Audit search is deliberately platform-wide rather than tenant-scoped. An
 * investigation that stopped at an organization boundary could not follow an actor
 * across tenants, which is the case the search exists for. Only the three roles that
 * already carry cross-tenant authority are admitted, and a membership that is not
 * ACTIVE never qualifies.
 */
export function canSearchAuditEvents(scope: AuditSearchScope): boolean {
  if (scope.membershipState !== 'ACTIVE') return false;
  return auditSearchRoles.includes(scope.role as AuditSearchRole);
}

export * from './institution-scope.js';
export * from './internal-capabilities.js';
export * from './high-risk-actions.js';
export * from './support-desk.js';
export * from './jobs-console.js';
export * from './aggregate-suppression.js';
export * from './privacy-console.js';
export * from './operations-overview.js';
export * from './career-catalogue.js';
export * from './skill-map.js';
export * from './question-bank.js';
export * from './lesson-editor.js';
export * from './institution-exports.js';
export * from './role-demand.js';
export * from './placement-status.js';
export * from './relationship-lifecycle.js';
