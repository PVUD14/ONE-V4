import { describe, expect, it } from 'vitest';
import {
  IdentityOrganizationService,
  InMemoryIdentityOrganizationStore,
  type AuthorizationContext,
  type EmployerApplicantGrantRecord,
  type InternalUserAccount,
  type InstitutionUnitRecord,
  type OrganizationMembershipRecord,
  type OrganizationRecord,
  type StudentInstitutionRelationshipRecord,
} from './services.js';

function createHarness() {
  const store = new InMemoryIdentityOrganizationStore();
  const service = new IdentityOrganizationService(store);

  const platformUser: InternalUserAccount = { id: 'platform-user', email: 'ops@example.test', externalSubject: 'sub:ops', state: 'ACTIVE' };
  store.state.users.set(platformUser.id, platformUser);
  store.state.memberships.set('platform-membership', {
    id: 'platform-membership',
    organizationId: 'platform',
    userId: platformUser.id,
    role: 'PLATFORM_SUPER_ADMIN',
    state: 'ACTIVE',
    scope: { organizationId: 'platform' },
  });

  const platformContext: AuthorizationContext = { user: platformUser, memberships: [...store.state.memberships.values()] };
  return { store, service, platformContext, platformUser };
}

function addUser(store: InMemoryIdentityOrganizationStore, id: string, externalSubject: string, state: InternalUserAccount['state'] = 'ACTIVE'): InternalUserAccount {
  const user: InternalUserAccount = { id, email: `${id}@example.test`, externalSubject, state };
  store.state.users.set(id, user);
  return user;
}

function addOrganization(store: InMemoryIdentityOrganizationStore, organization: OrganizationRecord): OrganizationRecord {
  store.state.organizations.set(organization.id, organization);
  return organization;
}

function addMembership(store: InMemoryIdentityOrganizationStore, membership: OrganizationMembershipRecord): void {
  store.state.memberships.set(membership.id, membership);
}

describe('identity and organization application services', () => {
  it('rejects a suspended account even when the external subject maps from a valid token', async () => {
    const { store, service } = createHarness();
    addUser(store, 'student-1', 'sub:suspended', 'SUSPENDED');

    await expect(service.loadAuthorizationContext('sub:suspended')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('re-checks current account state for protected operations instead of trusting stale contexts', async () => {
    const { store, service, platformContext, platformUser } = createHarness();
    store.state.users.set(platformUser.id, { ...platformUser, state: 'SUSPENDED' });

    await expect(service.createOrganization(platformContext, {
      kind: 'EMPLOYER',
      legalName: 'Blocked Employer',
      correlationId: 'corr-stale-account',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires platform authorization for internal user provisioning', async () => {
    const { store, service } = createHarness();
    const outsider = addUser(store, 'outsider', 'sub:outsider');
    const outsiderContext: AuthorizationContext = { user: outsider, memberships: [] };

    await expect(service.provisionInternalUser(outsiderContext, {
      email: 'blocked@example.test',
      externalSubject: 'sub:blocked',
      state: 'ACTIVE',
      correlationId: 'corr-provision-forbidden',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies former institution access to post-relationship student activity', async () => {
    const { store, service } = createHarness();
    const institution = addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    const staff = addUser(store, 'staff-a', 'sub:staff-a');
    const student = addUser(store, 'student-a', 'sub:student-a');
    addMembership(store, {
      id: 'member-a',
      organizationId: institution.id,
      userId: staff.id,
      role: 'INSTITUTION_ADMIN',
      state: 'ACTIVE',
      scope: { organizationId: institution.id, institutionId: institution.id },
    });
    store.state.studentInstitutionRelationships.set('rel-a', {
      id: 'rel-a',
      institutionId: institution.id,
      studentUserId: student.id,
      state: 'TRANSFERRED',
      effectiveFrom: new Date('2025-06-01T00:00:00Z'),
      effectiveTo: new Date('2026-06-01T00:00:00Z'),
    } satisfies StudentInstitutionRelationshipRecord);

    const context = await service.loadAuthorizationContext('sub:staff-a');
    expect(service.canReadStudentActivity(context, {
      institutionId: institution.id,
      studentUserId: student.id,
      activityAt: new Date('2026-07-01T00:00:00Z'),
    })).toBe(false);
  });

  it('denies institution identifier manipulation across institutions', async () => {
    const { store, service } = createHarness();
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addOrganization(store, { id: 'inst-b', kind: 'INSTITUTION', legalName: 'Institution B', verificationState: 'VERIFIED' });
    const staff = addUser(store, 'staff-a', 'sub:staff-a');
    const student = addUser(store, 'student-b', 'sub:student-b');
    addMembership(store, {
      id: 'member-a',
      organizationId: 'inst-a',
      userId: staff.id,
      role: 'INSTITUTION_ADMIN',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
    });
    store.state.studentInstitutionRelationships.set('rel-b', {
      id: 'rel-b',
      institutionId: 'inst-b',
      studentUserId: student.id,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const context = await service.loadAuthorizationContext('sub:staff-a');
    expect(service.canReadStudentActivity(context, {
      institutionId: 'inst-b',
      studentUserId: student.id,
      activityAt: new Date('2026-02-01T00:00:00Z'),
    })).toBe(false);
  });

  it('prevents faculty scope from exceeding assigned department and batch scope', async () => {
    const { store, service } = createHarness();
    const faculty = addUser(store, 'faculty-a', 'sub:faculty-a');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'faculty-membership',
      organizationId: 'inst-a',
      userId: faculty.id,
      role: 'FACULTY_LECTURER',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a', departmentId: 'dept-a', batchId: 'batch-a' },
    });
    const student = addUser(store, 'student-a', 'sub:student-a');
    store.state.studentInstitutionRelationships.set('rel-a', {
      id: 'rel-a',
      institutionId: 'inst-a',
      studentUserId: student.id,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const context = await service.loadAuthorizationContext('sub:faculty-a');
    expect(service.canReadStudentActivity(context, {
      institutionId: 'inst-a',
      studentUserId: student.id,
      activityAt: new Date('2026-02-01T00:00:00Z'),
      departmentId: 'dept-b',
      batchId: 'batch-a',
    })).toBe(false);
  });

  it('applies assigned scope to non-faculty institution staff reads', async () => {
    const { store, service } = createHarness();
    const placement = addUser(store, 'placement-a', 'sub:placement-a');
    const student = addUser(store, 'student-a', 'sub:student-a');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'placement-membership',
      organizationId: 'inst-a',
      userId: placement.id,
      role: 'PLACEMENT_ADMIN',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a', departmentId: 'dept-a' },
    });
    store.state.studentInstitutionRelationships.set('rel-a', {
      id: 'rel-a',
      institutionId: 'inst-a',
      studentUserId: student.id,
      state: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });

    const context = await service.loadAuthorizationContext('sub:placement-a');
    expect(service.canReadStudentActivity(context, {
      institutionId: 'inst-a',
      studentUserId: student.id,
      activityAt: new Date('2026-02-01T00:00:00Z'),
      departmentId: 'dept-b',
    })).toBe(false);
    expect(service.canReadStudentActivity(context, {
      institutionId: 'inst-a',
      studentUserId: student.id,
      activityAt: new Date('2026-02-01T00:00:00Z'),
      departmentId: 'dept-a',
    })).toBe(true);
  });

  it('denies stale suspended membership after authorization context load', async () => {
    const { store, service } = createHarness();
    const admin = addUser(store, 'admin-a', 'sub:admin-a');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    const membership: OrganizationMembershipRecord = {
      id: 'admin-membership',
      organizationId: 'inst-a',
      userId: admin.id,
      role: 'INSTITUTION_ADMIN',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
    };
    addMembership(store, membership);

    const context = await service.loadAuthorizationContext('sub:admin-a');
    store.state.memberships.set(membership.id, { ...membership, state: 'SUSPENDED' });

    await expect(service.createInstitutionUnit(context, {
      institutionId: 'inst-a',
      kind: 'DEPARTMENT',
      name: 'Computer Science',
      correlationId: 'corr-stale-membership',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies suspended membership organization actions', async () => {
    const { store, service } = createHarness();
    const admin = addUser(store, 'admin-a', 'sub:admin-a');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'admin-suspended',
      organizationId: 'inst-a',
      userId: admin.id,
      role: 'INSTITUTION_ADMIN',
      state: 'SUSPENDED',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
    });

    const context = await service.loadAuthorizationContext('sub:admin-a');
    await expect(service.createInstitutionUnit(context, {
      institutionId: 'inst-a',
      kind: 'DEPARTMENT',
      name: 'Computer Science',
      correlationId: 'corr-suspended',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies employer access to another employer resource and revoked grants', async () => {
    const { store, service } = createHarness();
    const recruiter = addUser(store, 'recruiter-a', 'sub:recruiter-a');
    addOrganization(store, { id: 'employer-a', kind: 'EMPLOYER', legalName: 'Employer A', verificationState: 'VERIFIED' });
    addOrganization(store, { id: 'employer-b', kind: 'EMPLOYER', legalName: 'Employer B', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'recruiter-membership',
      organizationId: 'employer-a',
      userId: recruiter.id,
      role: 'RECRUITER',
      state: 'ACTIVE',
      scope: { organizationId: 'employer-a', employerId: 'employer-a' },
    });
    store.state.employerApplicantGrants.set('grant-a', {
      id: 'grant-a',
      employerId: 'employer-a',
      opportunityId: 'opp-a',
      studentUserId: 'student-a',
      grantedAt: new Date('2026-01-01T00:00:00Z'),
      revokedAt: new Date('2026-01-02T00:00:00Z'),
    } satisfies EmployerApplicantGrantRecord);

    const context = await service.loadAuthorizationContext('sub:recruiter-a');
    expect(service.canReadEmployerApplicant(context, { employerId: 'employer-b', opportunityId: 'opp-a', studentUserId: 'student-a' })).toBe(false);
    expect(service.canReadEmployerApplicant(context, { employerId: 'employer-a', opportunityId: 'opp-a', studentUserId: 'student-a' })).toBe(false);
  });

  it('prevents role assignment outside permitted administrative scope', async () => {
    const { store, service } = createHarness();
    const admin = addUser(store, 'placement-admin', 'sub:placement-admin');
    const faculty = addUser(store, 'faculty-b', 'sub:faculty-b');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'placement-membership',
      organizationId: 'inst-a',
      userId: admin.id,
      role: 'PLACEMENT_ADMIN',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a', departmentId: 'dept-a' },
    });

    const context = await service.loadAuthorizationContext('sub:placement-admin');
    await expect(service.assignOrganizationRole(context, {
      organizationId: 'inst-a',
      userId: faculty.id,
      role: 'FACULTY_LECTURER',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a', departmentId: 'dept-b' },
      correlationId: 'corr-scope',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('prevents organization administrators from assigning privileged or cross-kind roles', async () => {
    const { store, service } = createHarness();
    const admin = addUser(store, 'admin-a', 'sub:admin-a');
    const target = addUser(store, 'target-a', 'sub:target-a');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'admin-membership',
      organizationId: 'inst-a',
      userId: admin.id,
      role: 'INSTITUTION_ADMIN',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
    });

    const context = await service.loadAuthorizationContext('sub:admin-a');
    await expect(service.assignOrganizationRole(context, {
      organizationId: 'inst-a',
      userId: target.id,
      role: 'PLATFORM_SUPER_ADMIN',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
      correlationId: 'corr-platform-escalation',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.assignOrganizationRole(context, {
      organizationId: 'inst-a',
      userId: target.id,
      role: 'EMPLOYER_ADMIN',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
      correlationId: 'corr-cross-kind',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('prevents self-escalation through role assignment', async () => {
    const { store, service } = createHarness();
    const owner = addUser(store, 'owner-a', 'sub:owner-a');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'owner-membership',
      organizationId: 'inst-a',
      userId: owner.id,
      role: 'INSTITUTION_OWNER',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
    });

    const context = await service.loadAuthorizationContext('sub:owner-a');
    await expect(service.assignOrganizationRole(context, {
      organizationId: 'inst-a',
      userId: owner.id,
      role: 'INSTITUTION_ADMIN',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
      correlationId: 'corr-self',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('prevents privilege escalation through scoped invitations', async () => {
    const { store, service } = createHarness();
    const admin = addUser(store, 'admin-a', 'sub:admin-a');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'admin-membership',
      organizationId: 'inst-a',
      userId: admin.id,
      role: 'INSTITUTION_ADMIN',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
    });

    const context = await service.loadAuthorizationContext('sub:admin-a');
    await expect(service.createInvitation(context, {
      email: 'evil@example.test',
      organizationId: 'inst-a',
      role: 'PLATFORM_SUPER_ADMIN',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      correlationId: 'corr-invite-escalation',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('blocks invitation replay and non-enumerating invalid invitation failures', async () => {
    const { service, platformContext } = createHarness();
    const invitation = await service.createInvitation(platformContext, {
      email: 'new-staff@example.test',
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      correlationId: 'corr-invite',
    });

    await service.acceptInvitation({
      invitationId: invitation.id,
      externalSubject: 'sub:new-staff',
      now: new Date('2026-08-01T00:00:00Z'),
      correlationId: 'corr-accept',
    });

    await expect(service.acceptInvitation({
      invitationId: invitation.id,
      externalSubject: 'sub:replay',
      now: new Date('2026-08-01T00:00:00Z'),
      correlationId: 'corr-replay',
    })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(service.acceptInvitation({
      invitationId: 'invite-does-not-exist',
      externalSubject: 'sub:unknown',
      now: new Date('2026-08-01T00:00:00Z'),
      correlationId: 'corr-unknown',
    })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('prevents duplicate external-subject invitation acceptance', async () => {
    const { store, service, platformContext } = createHarness();
    addUser(store, 'existing-user', 'sub:existing');
    const invitation = await service.createInvitation(platformContext, {
      email: 'duplicate@example.test',
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      correlationId: 'corr-dup-invite',
    });

    await expect(service.acceptInvitation({
      invitationId: invitation.id,
      externalSubject: 'sub:existing',
      now: new Date('2026-08-01T00:00:00Z'),
      correlationId: 'corr-dup-accept',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect([...store.state.users.values()].filter((user) => user.externalSubject === 'sub:existing')).toHaveLength(1);
  });

  it('does not enumerate protected organizations to unrelated users', async () => {
    const { store, service } = createHarness();
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addOrganization(store, { id: 'employer-a', kind: 'EMPLOYER', legalName: 'Employer A', verificationState: 'VERIFIED' });
    addUser(store, 'outsider', 'sub:outsider');

    const context = await service.loadAuthorizationContext('sub:outsider');
    expect(service.listVisibleOrganizations(context)).toEqual([]);
  });

  it('rejects institution hierarchy mutations with a parent unit from another institution', async () => {
    const { store, service } = createHarness();
    const admin = addUser(store, 'admin-a', 'sub:admin-a');
    addOrganization(store, { id: 'inst-a', kind: 'INSTITUTION', legalName: 'Institution A', verificationState: 'VERIFIED' });
    addOrganization(store, { id: 'inst-b', kind: 'INSTITUTION', legalName: 'Institution B', verificationState: 'VERIFIED' });
    addMembership(store, {
      id: 'admin-membership',
      organizationId: 'inst-a',
      userId: admin.id,
      role: 'INSTITUTION_ADMIN',
      state: 'ACTIVE',
      scope: { organizationId: 'inst-a', institutionId: 'inst-a' },
    });
    store.state.institutionUnits.set('dept-b', {
      id: 'dept-b',
      institutionId: 'inst-b',
      kind: 'DEPARTMENT',
      name: 'Other Department',
    } satisfies InstitutionUnitRecord);

    const context = await service.loadAuthorizationContext('sub:admin-a');
    await expect(service.createInstitutionUnit(context, {
      institutionId: 'inst-a',
      kind: 'PROGRAM',
      name: 'Program A',
      parentUnitId: 'dept-b',
      correlationId: 'corr-parent-cross-inst',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('generates audit events for privileged identity and organization changes with scoped context', async () => {
    const { store, service, platformContext } = createHarness();
    const organization = await service.createOrganization(platformContext, {
      kind: 'EMPLOYER',
      legalName: 'Employer A',
      correlationId: 'corr-org',
    });

    expect(store.state.auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'organization.created',
        actorUserId: platformContext.user.id,
        organizationId: organization.id,
        correlationId: 'corr-org',
        outcome: 'SUCCESS',
        occurredAt: expect.any(Date),
      }),
    ]));
    expect(store.state.outboxEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'organization.created',
        actorUserId: platformContext.user.id,
        organizationId: organization.id,
        correlationId: 'corr-org',
        eventVersion: 1,
        occurredAt: expect.any(Date),
      }),
    ]));
  });

  it('commits domain state and required outbox event atomically', async () => {
    const { store, service, platformContext } = createHarness();
    const user = await service.provisionInternalUser(platformContext, {
      email: 'student@example.test',
      externalSubject: 'sub:student',
      state: 'ACTIVE',
      correlationId: 'corr-user',
    });

    expect(store.state.users.has(user.id)).toBe(true);
    expect(store.state.outboxEvents.some((event) => event.aggregateId === user.id && event.eventType === 'identity.user.provisioned')).toBe(true);
  });

  it('rolls back partial privileged changes when the transaction fails', async () => {
    const { store, service, platformContext } = createHarness();
    await expect(service.provisionInternalUser(platformContext, {
      email: 'rollback@example.test',
      externalSubject: 'sub:rollback',
      state: 'ACTIVE',
      correlationId: 'corr-rollback',
      failAfterDomainMutation: true,
    })).rejects.toThrow('simulated failure');

    expect([...store.state.users.values()].some((user) => user.email === 'rollback@example.test')).toBe(false);
    expect(store.state.auditEvents.some((event) => event.correlationId === 'corr-rollback')).toBe(false);
  });
});
