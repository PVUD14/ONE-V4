export interface TemporalInstitutionScope {
  readonly institutionId: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly relationshipState: 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'ENDED' | 'TRANSFERRED' | 'GRADUATED' | 'REVOKED';
}

export function canInstitutionReadStudentActivity(
  scope: TemporalInstitutionScope,
  activityOccurredAt: Date,
): boolean {
  if (!['VERIFIED', 'ACTIVE', 'GRADUATED'].includes(scope.relationshipState)) return false;
  if (activityOccurredAt < scope.effectiveFrom) return false;
  if (scope.effectiveTo && activityOccurredAt > scope.effectiveTo) return false;
  return true;
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
