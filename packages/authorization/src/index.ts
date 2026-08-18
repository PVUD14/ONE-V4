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
