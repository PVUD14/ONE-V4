import type { UserId } from '../identity/models.js';

export type OrganizationId = string;
export type StudentId = string;

export type OrganizationType = 'INSTITUTION' | 'EMPLOYER';
export type VerificationState = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';

export interface Organization {
  readonly id: OrganizationId;
  readonly type: OrganizationType;
  readonly legalName: string;
  readonly verificationState: VerificationState;
}

export type InstitutionRelationshipState =
  | 'PENDING'
  | 'VERIFIED'
  | 'ACTIVE'
  | 'ENDED'
  | 'TRANSFERRED'
  | 'GRADUATED'
  | 'REVOKED';

export interface InstitutionRelationship {
  readonly id: string;
  readonly studentId: StudentId;
  readonly institutionId: OrganizationId;
  readonly state: InstitutionRelationshipState;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly verifiedBy?: UserId;
}

export interface EmployerApplicantGrant {
  readonly employerId: OrganizationId;
  readonly studentId: StudentId;
  readonly applicationId: string;
  readonly grantedAt: Date;
  readonly revokedAt?: Date;
}
