import { platformInternalRoles } from '@planthepath/authorization/src/index.js';
import { createCognitoTokenVerifier, type IdentityTokenVerifier } from '@planthepath/identity/src/cognito.js';
import { createStaffPoolPolicy, type StaffPoolPolicy } from '@planthepath/identity/src/staff-pool.js';
import type { RuntimeConfig } from './config.js';

export function createRuntimeIdentityVerifier(config: RuntimeConfig): IdentityTokenVerifier {
  if (config.cognito.userPoolId && config.cognito.clientId) {
    return createCognitoTokenVerifier({
      userPoolId: config.cognito.userPoolId,
      clientId: config.cognito.clientId,
      ...(config.cognito.staffPool ? { additionalPools: [config.cognito.staffPool] } : {}),
    });
  }

  return {
    async verifyAccessToken(): Promise<never> {
      throw new Error('Cognito runtime authentication is not configured');
    },
  };
}

/**
 * ADR-025 / OPS-07: with a staff pool configured, the internal platform roles count only
 * for tokens that pool issued. Undefined (no staff pool) leaves memberships untouched.
 *
 * The internal roles are enforced first because they reach every organisation. ADR-025's
 * wider definition of staff (institution and employer roles) follows once those users
 * have staff-pool accounts; widening the list before then would lock them out.
 */
export function createRuntimeStaffPoolPolicy(config: RuntimeConfig): StaffPoolPolicy | undefined {
  const staffPool = config.cognito.staffPool;
  if (!staffPool) return undefined;
  return createStaffPoolPolicy({
    userPoolId: staffPool.userPoolId,
    clientId: staffPool.clientId,
    staffOnlyRoles: platformInternalRoles,
  });
}
