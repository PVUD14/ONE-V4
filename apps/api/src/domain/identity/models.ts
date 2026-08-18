export type UserId = string;

export type AccountState =
  | 'INVITED'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'DELETION_PENDING'
  | 'DELETED';

export interface UserIdentity {
  readonly id: UserId;
  readonly externalIdentitySubject: string;
  readonly email: string;
  readonly state: AccountState;
  readonly createdAt: Date;
}

export type PlatformRole =
  | 'PLATFORM_SUPER_ADMIN'
  | 'OPERATIONS_ADMIN'
  | 'SECURITY_ADMIN'
  | 'SUPPORT_AGENT'
  | 'BILLING_ADMIN'
  | 'CONTENT_MODERATION_ADMIN';

export type InstitutionRole =
  | 'INSTITUTION_OWNER'
  | 'INSTITUTION_ADMIN'
  | 'PLACEMENT_ADMIN'
  | 'PLACEMENT_OFFICER'
  | 'DEPARTMENT_HEAD'
  | 'FACULTY_LECTURER'
  | 'CAREER_COUNSELOR'
  | 'INSTITUTION_ANALYST';

export type EmployerRole =
  | 'EMPLOYER_OWNER'
  | 'EMPLOYER_ADMIN'
  | 'RECRUITER'
  | 'HIRING_MANAGER'
  | 'INTERVIEWER';

export type StudentRole = 'STUDENT' | 'GRADUATE';
