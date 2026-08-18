import { describe, expect, it } from 'vitest';
import type { IdentityTokenVerifier } from '../src/cognito.js';
import { resolveAuthenticatedPrincipal, resolveAuthorizationContext, type InternalIdentityStore } from '../src/principal.js';

const verifier: IdentityTokenVerifier = {
  async verifyAccessToken() {
    return {
      externalSubject: 'cognito-sub-123',
      clientId: 'client-1',
      issuer: 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_test',
      tokenUse: 'access',
      expiresAt: 2_000_000_000,
      issuedAt: 1_900_000_000,
      scopes: ['openid'],
    };
  },
};

describe('identity boundary', () => {
  it('maps verified external subject to immutable internal user identity', async () => {
    const store: InternalIdentityStore = {
      async findByExternalSubject(subject) {
        return { id: 'internal-user-1', externalSubject: subject, state: 'ACTIVE' };
      },
    };

    await expect(resolveAuthenticatedPrincipal('token', verifier, store)).resolves.toEqual({
      userId: 'internal-user-1',
      externalSubject: 'cognito-sub-123',
    });
  });

  it('rejects a suspended internal account even when the IdP token verifies', async () => {
    const store: InternalIdentityStore = {
      async findByExternalSubject(subject) {
        return { id: 'internal-user-1', externalSubject: subject, state: 'SUSPENDED' };
      },
    };

    await expect(resolveAuthenticatedPrincipal('still-valid-token', verifier, store)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects an unknown external subject without exposing whether the token subject exists', async () => {
    const store: InternalIdentityStore = { async findByExternalSubject() { return null; } };
    await expect(resolveAuthenticatedPrincipal('token', verifier, store)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('constructs authorization context from current active memberships only', async () => {
    const store: InternalIdentityStore = {
      async findByExternalSubject(subject) {
        return { id: 'internal-user-1', externalSubject: subject, state: 'ACTIVE' };
      },
      async loadActiveMembershipsForUser(userId) {
        return [{
          id: 'membership-1',
          organizationId: 'org-1',
          userId,
          role: 'INSTITUTION_ADMIN',
          state: 'ACTIVE',
          scope: { organizationId: 'org-1', institutionId: 'org-1' },
        }];
      },
    };

    await expect(resolveAuthorizationContext('token', verifier, store, { requestedOrganizationId: 'org-1' })).resolves.toMatchObject({
      principal: { userId: 'internal-user-1' },
      selectedMembership: { id: 'membership-1', organizationId: 'org-1' },
    });
  });

  it('rejects client-selected organization context without a current active membership', async () => {
    const store: InternalIdentityStore = {
      async findByExternalSubject(subject) {
        return { id: 'internal-user-1', externalSubject: subject, state: 'ACTIVE' };
      },
      async loadActiveMembershipsForUser(userId) {
        return [{
          id: 'membership-1',
          organizationId: 'org-1',
          userId,
          role: 'INSTITUTION_ADMIN',
          state: 'ACTIVE',
          scope: { organizationId: 'org-1', institutionId: 'org-1' },
        }];
      },
    };

    await expect(resolveAuthorizationContext('token', verifier, store, { requestedOrganizationId: 'org-2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
