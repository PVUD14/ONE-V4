import { institutionRelationshipAuthorizesActivity } from '@planthepath/authorization/src/index.js';

export type AccountState = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DELETION_PENDING' | 'DELETED';
export type OrganizationKind = 'INSTITUTION' | 'EMPLOYER';
export type VerificationState = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
export type MembershipState = 'ACTIVE' | 'SUSPENDED' | 'ENDED';
export type InvitationState = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
export type RelationshipState = 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'ENDED' | 'TRANSFERRED' | 'GRADUATED' | 'REVOKED';
export type InstitutionUnitKind = 'INSTITUTION' | 'CAMPUS' | 'DEPARTMENT' | 'PROGRAM' | 'BATCH' | 'SECTION';

export type OrganizationRole =
  | 'PLATFORM_SUPER_ADMIN'
  | 'OPERATIONS_ADMIN'
  | 'SECURITY_ADMIN'
  | 'INSTITUTION_OWNER'
  | 'INSTITUTION_ADMIN'
  | 'PLACEMENT_ADMIN'
  | 'DEPARTMENT_HEAD'
  | 'FACULTY_LECTURER'
  | 'EMPLOYER_OWNER'
  | 'EMPLOYER_ADMIN'
  | 'RECRUITER';

export type ApplicationErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE';

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RoleScope {
  readonly organizationId: string;
  readonly institutionId?: string;
  readonly departmentId?: string;
  readonly batchId?: string;
  readonly employerId?: string;
}

export interface InternalUserAccount {
  readonly id: string;
  readonly email: string;
  readonly state: AccountState;
  readonly externalSubject?: string;
}

export interface OrganizationRecord {
  readonly id: string;
  readonly kind: OrganizationKind;
  readonly legalName: string;
  readonly verificationState: VerificationState;
}

export interface OrganizationMembershipRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
  readonly state: MembershipState;
  readonly scope: RoleScope;
}

export interface InvitationRecord {
  readonly id: string;
  readonly email: string;
  readonly state: InvitationState;
  readonly invitedByUserId: string;
  readonly organizationId?: string;
  readonly role?: OrganizationRole;
  readonly scope?: RoleScope;
  readonly expiresAt: Date;
  readonly acceptedByUserId?: string;
}

export interface InstitutionUnitRecord {
  readonly id: string;
  readonly institutionId: string;
  readonly kind: InstitutionUnitKind;
  readonly name: string;
  readonly parentUnitId?: string;
}

export interface StudentInstitutionRelationshipRecord {
  readonly id: string;
  readonly studentUserId: string;
  readonly institutionId: string;
  readonly state: RelationshipState;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
}

export interface EmployerApplicantGrantRecord {
  readonly id: string;
  readonly employerId: string;
  readonly opportunityId: string;
  readonly studentUserId: string;
  readonly grantedAt: Date;
  readonly revokedAt?: Date;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly organizationId?: string;
  readonly outcome: 'SUCCESS' | 'DENIED';
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface OutboxEventRecord {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Record<string, unknown>;
  readonly actorUserId?: string;
  readonly organizationId?: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface AuthorizationContext {
  readonly user: InternalUserAccount;
  readonly memberships: readonly OrganizationMembershipRecord[];
}

export interface IdentityOrganizationState {
  users: Map<string, InternalUserAccount>;
  organizations: Map<string, OrganizationRecord>;
  memberships: Map<string, OrganizationMembershipRecord>;
  invitations: Map<string, InvitationRecord>;
  institutionUnits: Map<string, InstitutionUnitRecord>;
  studentInstitutionRelationships: Map<string, StudentInstitutionRelationshipRecord>;
  employerApplicantGrants: Map<string, EmployerApplicantGrantRecord>;
  auditEvents: AuditEventRecord[];
  outboxEvents: OutboxEventRecord[];
}

export interface IdGenerator {
  nextId(prefix: string): string;
}

export class SequenceIdGenerator implements IdGenerator {
  private value = 0;

  nextId(prefix: string): string {
    this.value += 1;
    return `${prefix}_${this.value}`;
  }
}

export class InMemoryIdentityOrganizationStore {
  readonly state: IdentityOrganizationState = {
    users: new Map(),
    organizations: new Map(),
    memberships: new Map(),
    invitations: new Map(),
    institutionUnits: new Map(),
    studentInstitutionRelationships: new Map(),
    employerApplicantGrants: new Map(),
    auditEvents: [],
    outboxEvents: [],
  };

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try {
      return await work();
    } catch (error) {
      this.state.users = snapshot.users;
      this.state.organizations = snapshot.organizations;
      this.state.memberships = snapshot.memberships;
      this.state.invitations = snapshot.invitations;
      this.state.institutionUnits = snapshot.institutionUnits;
      this.state.studentInstitutionRelationships = snapshot.studentInstitutionRelationships;
      this.state.employerApplicantGrants = snapshot.employerApplicantGrants;
      this.state.auditEvents = snapshot.auditEvents;
      this.state.outboxEvents = snapshot.outboxEvents;
      throw error;
    }
  }
}

const platformOrganizationId = 'platform';
const platformAdminRoles: readonly OrganizationRole[] = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN'];
const platformRoles: readonly OrganizationRole[] = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];
const institutionRoles: readonly OrganizationRole[] = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];
const employerRoles: readonly OrganizationRole[] = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'];
const institutionManagementRoles: readonly OrganizationRole[] = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN'];
const employerManagementRoles: readonly OrganizationRole[] = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN'];

export class IdentityOrganizationService {
  private readonly store: InMemoryIdentityOrganizationStore;
  private readonly ids: IdGenerator;

  constructor(store: InMemoryIdentityOrganizationStore, ids: IdGenerator = new SequenceIdGenerator()) {
    this.store = store;
    this.ids = ids;
  }

  async loadAuthorizationContext(externalSubject: string): Promise<AuthorizationContext> {
    const user = [...this.store.state.users.values()].find((candidate) => candidate.externalSubject === externalSubject);
    if (!user || user.state !== 'ACTIVE') {
      throw new ApplicationError('FORBIDDEN', 'account is not active');
    }

    return this.currentAuthorizationContextFor(user.id);
  }

  async provisionInternalUser(
    actor: AuthorizationContext,
    input: {
      readonly email: string;
      readonly externalSubject?: string;
      readonly state?: AccountState;
      readonly correlationId: string;
      readonly failAfterDomainMutation?: boolean;
    },
  ): Promise<InternalUserAccount> {
    const freshActor = this.requirePlatformRole(actor, ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN']);
    this.requireUniqueExternalSubject(input.externalSubject);

    return this.store.transaction(async () => {
      const user: InternalUserAccount = {
        id: this.ids.nextId('user'),
        email: input.email,
        state: input.state ?? 'INVITED',
        ...(input.externalSubject ? { externalSubject: input.externalSubject } : {}),
      };
      this.store.state.users.set(user.id, user);
      if (input.failAfterDomainMutation) throw new Error('simulated failure');
      this.recordAudit(freshActor.user.id, 'identity.user.provisioned', 'user', user.id, input.correlationId);
      this.recordOutbox(freshActor.user.id, 'user', user.id, 'identity.user.provisioned', { userId: user.id }, input.correlationId);
      return user;
    });
  }

  async createOrganization(
    actor: AuthorizationContext,
    input: { readonly kind: OrganizationKind; readonly legalName: string; readonly correlationId: string },
  ): Promise<OrganizationRecord> {
    const freshActor = this.requirePlatformRole(actor, ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN']);
    return this.store.transaction(async () => {
      const organization: OrganizationRecord = {
        id: this.ids.nextId('org'),
        kind: input.kind,
        legalName: input.legalName,
        verificationState: 'PENDING',
      };
      this.store.state.organizations.set(organization.id, organization);
      this.recordAudit(freshActor.user.id, 'organization.created', 'organization', organization.id, input.correlationId, organization.id);
      this.recordOutbox(freshActor.user.id, 'organization', organization.id, 'organization.created', {
        organizationId: organization.id,
        kind: organization.kind,
      }, input.correlationId, organization.id);
      return organization;
    });
  }

  async createInvitation(
    actor: AuthorizationContext,
    input: {
      readonly email: string;
      readonly organizationId?: string;
      readonly role?: OrganizationRole;
      readonly scope?: RoleScope;
      readonly expiresAt: Date;
      readonly correlationId: string;
    },
  ): Promise<InvitationRecord> {
    const freshActor = input.organizationId
      ? this.requireOrganizationAuthority(actor, input.organizationId, [...institutionManagementRoles, ...employerManagementRoles]).actor
      : this.requirePlatformRole(actor, ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN']);

    if (Boolean(input.role) !== Boolean(input.scope)) {
      throw new ApplicationError('INVALID_STATE', 'invitation role and scope must be supplied together');
    }
    if (!input.organizationId && (input.role || input.scope)) {
      throw new ApplicationError('FORBIDDEN', 'scoped invitation requires an organization');
    }
    if (input.organizationId && input.role && input.scope) {
      this.authorizeRoleGrant(freshActor, {
        organizationId: input.organizationId,
        role: input.role,
        scope: input.scope,
      });
    }

    return this.store.transaction(async () => {
      const invitation: InvitationRecord = {
        id: this.ids.nextId('invite'),
        email: input.email,
        state: 'PENDING',
        invitedByUserId: freshActor.user.id,
        expiresAt: input.expiresAt,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
      };
      this.store.state.invitations.set(invitation.id, invitation);
      this.recordAudit(freshActor.user.id, 'identity.invitation.created', 'invitation', invitation.id, input.correlationId, input.organizationId);
      this.recordOutbox(freshActor.user.id, 'invitation', invitation.id, 'identity.invitation.created', { invitationId: invitation.id }, input.correlationId, input.organizationId);
      return invitation;
    });
  }

  async acceptInvitation(input: {
    readonly invitationId: string;
    readonly externalSubject: string;
    readonly now: Date;
    readonly correlationId: string;
  }): Promise<InternalUserAccount> {
    this.requireUniqueExternalSubject(input.externalSubject);

    return this.store.transaction(async () => {
      const invitation = this.store.state.invitations.get(input.invitationId);
      if (!invitation || invitation.state !== 'PENDING' || input.now > invitation.expiresAt) {
        throw new ApplicationError('INVALID_STATE', 'invitation is not usable');
      }
      if (Boolean(invitation.role) !== Boolean(invitation.scope)) {
        throw new ApplicationError('INVALID_STATE', 'invitation is not usable');
      }
      if (invitation.organizationId && invitation.role && invitation.scope) {
        this.validateRoleGrantShape(invitation.organizationId, invitation.role, invitation.scope);
      }

      const user: InternalUserAccount = {
        id: this.ids.nextId('user'),
        email: invitation.email,
        externalSubject: input.externalSubject,
        state: 'ACTIVE',
      };
      this.store.state.users.set(user.id, user);
      this.store.state.invitations.set(invitation.id, { ...invitation, state: 'ACCEPTED', acceptedByUserId: user.id });

      if (invitation.organizationId && invitation.role && invitation.scope) {
        const membershipId = this.ids.nextId('membership');
        this.store.state.memberships.set(membershipId, {
          id: membershipId,
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
          state: 'ACTIVE',
          scope: invitation.scope,
        });
      }

      this.recordAudit(user.id, 'identity.invitation.accepted', 'invitation', invitation.id, input.correlationId, invitation.organizationId);
      this.recordOutbox(user.id, 'user', user.id, 'identity.invitation.accepted', { userId: user.id, invitationId: invitation.id }, input.correlationId, invitation.organizationId);
      return user;
    });
  }

  async assignOrganizationRole(
    actor: AuthorizationContext,
    input: {
      readonly organizationId: string;
      readonly userId: string;
      readonly role: OrganizationRole;
      readonly scope: RoleScope;
      readonly correlationId: string;
    },
  ): Promise<OrganizationMembershipRecord> {
    const freshActor = this.currentAuthorizationContext(actor);
    if (freshActor.user.id === input.userId) {
      throw new ApplicationError('FORBIDDEN', 'self role assignment is not permitted');
    }
    this.requireAssignableTargetUser(input.userId);
    this.authorizeRoleGrant(freshActor, input);

    return this.store.transaction(async () => {
      const membership: OrganizationMembershipRecord = {
        id: this.ids.nextId('membership'),
        organizationId: input.organizationId,
        userId: input.userId,
        role: input.role,
        state: 'ACTIVE',
        scope: input.scope,
      };
      this.store.state.memberships.set(membership.id, membership);
      this.recordAudit(freshActor.user.id, 'organization.role.assigned', 'organization_membership', membership.id, input.correlationId, input.organizationId);
      this.recordOutbox(freshActor.user.id, 'organization_membership', membership.id, 'organization.role.assigned', {
        membershipId: membership.id,
        role: membership.role,
      }, input.correlationId, input.organizationId);
      return membership;
    });
  }

  async createInstitutionUnit(
    actor: AuthorizationContext,
    input: {
      readonly institutionId: string;
      readonly kind: InstitutionUnitKind;
      readonly name: string;
      readonly parentUnitId?: string;
      readonly correlationId: string;
    },
  ): Promise<InstitutionUnitRecord> {
    const { actor: freshActor } = this.requireOrganizationAuthority(actor, input.institutionId, institutionManagementRoles);
    this.requireInstitutionOrganization(input.institutionId);
    if (input.parentUnitId) this.requireInstitutionParentUnit(input.institutionId, input.parentUnitId);

    return this.store.transaction(async () => {
      const unit: InstitutionUnitRecord = {
        id: this.ids.nextId('unit'),
        institutionId: input.institutionId,
        kind: input.kind,
        name: input.name,
        ...(input.parentUnitId ? { parentUnitId: input.parentUnitId } : {}),
      };
      this.store.state.institutionUnits.set(unit.id, unit);
      this.recordAudit(freshActor.user.id, 'institution.unit.created', 'institution_unit', unit.id, input.correlationId, input.institutionId);
      this.recordOutbox(freshActor.user.id, 'institution_unit', unit.id, 'institution.unit.created', { unitId: unit.id }, input.correlationId, input.institutionId);
      return unit;
    });
  }

  async createStudentInstitutionRelationship(
    actor: AuthorizationContext,
    input: {
      readonly institutionId: string;
      readonly studentUserId: string;
      readonly state: RelationshipState;
      readonly effectiveFrom: Date;
      readonly effectiveTo?: Date;
      readonly correlationId: string;
    },
  ): Promise<StudentInstitutionRelationshipRecord> {
    const { actor: freshActor } = this.requireOrganizationAuthority(actor, input.institutionId, institutionManagementRoles);
    this.requireInstitutionOrganization(input.institutionId);
    this.requireAssignableTargetUser(input.studentUserId);

    return this.store.transaction(async () => {
      const relationship: StudentInstitutionRelationshipRecord = {
        id: this.ids.nextId('relationship'),
        institutionId: input.institutionId,
        studentUserId: input.studentUserId,
        state: input.state,
        effectiveFrom: input.effectiveFrom,
        ...(input.effectiveTo ? { effectiveTo: input.effectiveTo } : {}),
      };
      this.store.state.studentInstitutionRelationships.set(relationship.id, relationship);
      this.recordAudit(freshActor.user.id, 'institution.relationship.created', 'institution_relationship', relationship.id, input.correlationId, input.institutionId);
      this.recordOutbox(freshActor.user.id, 'institution_relationship', relationship.id, 'institution.relationship.created', {
        relationshipId: relationship.id,
      }, input.correlationId, input.institutionId);
      return relationship;
    });
  }

  canReadStudentActivity(
    actor: AuthorizationContext,
    input: { readonly institutionId: string; readonly studentUserId: string; readonly activityAt: Date; readonly departmentId?: string; readonly batchId?: string },
  ): boolean {
    let freshActor: AuthorizationContext;
    try {
      freshActor = this.currentAuthorizationContext(actor);
      this.requireInstitutionOrganization(input.institutionId);
    } catch {
      return false;
    }

    const requestedScope: RoleScope = {
      organizationId: input.institutionId,
      institutionId: input.institutionId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
    };
    const membership = freshActor.memberships.find((candidate) => (
      candidate.organizationId === input.institutionId
      && institutionRoles.includes(candidate.role)
      && scopeContains(candidate.scope, requestedScope)
    ));
    if (!membership) return false;

    return [...this.store.state.studentInstitutionRelationships.values()].some((relationship) => {
      if (relationship.institutionId !== input.institutionId || relationship.studentUserId !== input.studentUserId) return false;
      return institutionRelationshipAuthorizesActivity({
        institutionId: relationship.institutionId,
        relationshipState: relationship.state,
        effectiveFrom: relationship.effectiveFrom,
        ...(relationship.effectiveTo ? { effectiveTo: relationship.effectiveTo } : {}),
      }, input.activityAt);
    });
  }

  canReadEmployerApplicant(actor: AuthorizationContext, input: { readonly employerId: string; readonly opportunityId: string; readonly studentUserId: string }): boolean {
    let freshActor: AuthorizationContext;
    try {
      freshActor = this.currentAuthorizationContext(actor);
      this.requireEmployerOrganization(input.employerId);
    } catch {
      return false;
    }

    const requestedScope: RoleScope = { organizationId: input.employerId, employerId: input.employerId };
    const hasEmployerMembership = freshActor.memberships.some((membership) => (
      membership.organizationId === input.employerId
      && employerRoles.includes(membership.role)
      && scopeContains(membership.scope, requestedScope)
    ));
    if (!hasEmployerMembership) return false;
    return [...this.store.state.employerApplicantGrants.values()].some((grant) => (
      grant.employerId === input.employerId
      && grant.opportunityId === input.opportunityId
      && grant.studentUserId === input.studentUserId
      && !grant.revokedAt
    ));
  }

  listVisibleOrganizations(actor: AuthorizationContext): OrganizationRecord[] {
    const freshActor = this.currentAuthorizationContext(actor);
    if (this.hasPlatformRole(freshActor, ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN'])) return [...this.store.state.organizations.values()];
    const organizationIds = new Set(freshActor.memberships.map((membership) => membership.organizationId));
    return [...this.store.state.organizations.values()].filter((organization) => organizationIds.has(organization.id));
  }

  private currentAuthorizationContext(actor: AuthorizationContext): AuthorizationContext {
    return this.currentAuthorizationContextFor(actor.user.id);
  }

  private currentAuthorizationContextFor(userId: string): AuthorizationContext {
    const user = this.store.state.users.get(userId);
    if (!user || user.state !== 'ACTIVE') {
      throw new ApplicationError('FORBIDDEN', 'account is not active');
    }

    return {
      user,
      memberships: [...this.store.state.memberships.values()].filter(
        (membership) => membership.userId === user.id && membership.state === 'ACTIVE',
      ),
    };
  }

  private requirePlatformRole(actor: AuthorizationContext, roles: readonly OrganizationRole[]): AuthorizationContext {
    const freshActor = this.currentAuthorizationContext(actor);
    if (!this.hasPlatformRole(freshActor, roles)) {
      throw new ApplicationError('FORBIDDEN', 'missing platform permission');
    }
    return freshActor;
  }

  private hasPlatformRole(actor: AuthorizationContext, roles: readonly OrganizationRole[]): boolean {
    return actor.memberships.some((membership) => (
      membership.organizationId === platformOrganizationId
      && membership.state === 'ACTIVE'
      && roles.includes(membership.role)
    ));
  }

  private requireOrganizationAuthority(
    actor: AuthorizationContext,
    organizationId: string,
    roles: readonly OrganizationRole[],
  ): { actor: AuthorizationContext; membership: OrganizationMembershipRecord; platformAuthority: boolean } {
    const freshActor = this.currentAuthorizationContext(actor);
    const platformMembership = freshActor.memberships.find((membership) => (
      membership.organizationId === platformOrganizationId
      && platformAdminRoles.includes(membership.role)
    ));
    if (platformMembership) return { actor: freshActor, membership: platformMembership, platformAuthority: true };

    const membership = freshActor.memberships.find((candidate) => (
      candidate.organizationId === organizationId
      && roles.includes(candidate.role)
    ));
    if (!membership) throw new ApplicationError('FORBIDDEN', 'missing organization permission');
    return { actor: freshActor, membership, platformAuthority: false };
  }

  private authorizeRoleGrant(
    actor: AuthorizationContext,
    input: { readonly organizationId: string; readonly role: OrganizationRole; readonly scope: RoleScope },
  ): void {
    if (input.organizationId === platformOrganizationId) {
      this.requirePlatformRole(actor, ['PLATFORM_SUPER_ADMIN']);
      if (!platformRoles.includes(input.role) || input.scope.organizationId !== platformOrganizationId) {
        throw new ApplicationError('FORBIDDEN', 'role is not assignable for organization');
      }
      return;
    }

    const organization = this.validateRoleGrantShape(input.organizationId, input.role, input.scope);
    const authorityRoles = organization.kind === 'INSTITUTION' ? institutionManagementRoles : employerManagementRoles;
    const authority = this.requireOrganizationAuthority(actor, input.organizationId, authorityRoles);
    if (authority.platformAuthority) return;
    if (!scopeContains(authority.membership.scope, input.scope)) {
      throw new ApplicationError('FORBIDDEN', 'role scope exceeds assigning authority');
    }
    if (!canAssignRole(authority.membership.role, input.role)) {
      throw new ApplicationError('FORBIDDEN', 'role is not assignable by actor');
    }
  }

  private validateRoleGrantShape(organizationId: string, role: OrganizationRole, scope: RoleScope): OrganizationRecord {
    if (scope.organizationId !== organizationId) {
      throw new ApplicationError('FORBIDDEN', 'role scope does not match organization');
    }
    const organization = this.requireOrganization(organizationId);
    if (organization.kind === 'INSTITUTION') {
      if (!institutionRoles.includes(role) || scope.institutionId !== organization.id || scope.employerId) {
        throw new ApplicationError('FORBIDDEN', 'role is not assignable for organization');
      }
      return organization;
    }
    if (!employerRoles.includes(role) || scope.employerId !== organization.id || scope.institutionId || scope.departmentId || scope.batchId) {
      throw new ApplicationError('FORBIDDEN', 'role is not assignable for organization');
    }
    return organization;
  }

  private requireOrganization(organizationId: string): OrganizationRecord {
    const organization = this.store.state.organizations.get(organizationId);
    if (!organization) throw new ApplicationError('FORBIDDEN', 'missing organization permission');
    return organization;
  }

  private requireInstitutionOrganization(institutionId: string): OrganizationRecord {
    const organization = this.requireOrganization(institutionId);
    if (organization.kind !== 'INSTITUTION') throw new ApplicationError('FORBIDDEN', 'missing institution permission');
    return organization;
  }

  private requireEmployerOrganization(employerId: string): OrganizationRecord {
    const organization = this.requireOrganization(employerId);
    if (organization.kind !== 'EMPLOYER') throw new ApplicationError('FORBIDDEN', 'missing employer permission');
    return organization;
  }

  private requireInstitutionParentUnit(institutionId: string, parentUnitId: string): void {
    const parent = this.store.state.institutionUnits.get(parentUnitId);
    if (!parent || parent.institutionId !== institutionId) {
      throw new ApplicationError('FORBIDDEN', 'missing institution permission');
    }
  }

  private requireAssignableTargetUser(userId: string): InternalUserAccount {
    const user = this.store.state.users.get(userId);
    if (!user || user.state === 'DELETED' || user.state === 'DELETION_PENDING') {
      throw new ApplicationError('FORBIDDEN', 'target user is not assignable');
    }
    return user;
  }

  private requireUniqueExternalSubject(externalSubject: string | undefined): void {
    if (!externalSubject) return;
    const existing = [...this.store.state.users.values()].find((user) => user.externalSubject === externalSubject);
    if (existing) throw new ApplicationError('CONFLICT', 'external subject is already linked');
  }

  private recordAudit(actorUserId: string, action: string, resourceType: string, resourceId: string, correlationId: string, organizationId?: string): void {
    this.store.state.auditEvents.push({
      id: this.ids.nextId('audit'),
      actorUserId,
      action,
      resourceType,
      resourceId,
      ...(organizationId ? { organizationId } : {}),
      outcome: 'SUCCESS',
      correlationId,
      occurredAt: new Date(),
    });
  }

  private recordOutbox(
    actorUserId: string,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
    correlationId: string,
    organizationId?: string,
  ): void {
    this.store.state.outboxEvents.push({
      id: this.ids.nextId('event'),
      aggregateType,
      aggregateId,
      eventType,
      eventVersion: 1,
      payload,
      actorUserId,
      ...(organizationId ? { organizationId } : {}),
      correlationId,
      occurredAt: new Date(),
    });
  }
}

/**
 * Which roles an actor may grant. Exported so the employer team routes (EMP-02) enforce the
 * same rule as this service rather than a second copy that could drift.
 */
export function canAssignRole(actorRole: OrganizationRole, targetRole: OrganizationRole): boolean {
  switch (actorRole) {
    case 'INSTITUTION_OWNER':
      return ['INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'].includes(targetRole);
    case 'INSTITUTION_ADMIN':
      return ['PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'].includes(targetRole);
    case 'PLACEMENT_ADMIN':
      return ['DEPARTMENT_HEAD', 'FACULTY_LECTURER'].includes(targetRole);
    case 'DEPARTMENT_HEAD':
      return targetRole === 'FACULTY_LECTURER';
    case 'EMPLOYER_OWNER':
      return ['EMPLOYER_ADMIN', 'RECRUITER'].includes(targetRole);
    case 'EMPLOYER_ADMIN':
      return targetRole === 'RECRUITER';
    default:
      return false;
  }
}

function scopeContains(authority: RoleScope, requested: RoleScope): boolean {
  if (authority.organizationId !== requested.organizationId) return false;
  if (authority.institutionId && authority.institutionId !== requested.institutionId) return false;
  if (authority.employerId && authority.employerId !== requested.employerId) return false;
  if (authority.departmentId && authority.departmentId !== requested.departmentId) return false;
  if (authority.batchId && authority.batchId !== requested.batchId) return false;
  return true;
}
