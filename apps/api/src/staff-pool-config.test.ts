/**
 * Staff-pool configuration contract (ADR-025, OPS-07).
 *
 * The staff pool is absent by default and must stay optional: production runs today
 * without one, and nothing here may stop it starting. When it is configured it must be
 * configured completely, because half a staff pool would let the API believe staff MFA
 * is enforced when it is not.
 */
import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.js';
import { createRuntimeIdentityVerifier, createRuntimeStaffPoolPolicy } from './runtime-auth.js';

const base = {
  DATABASE_URL: 'postgresql://planthepath:local@127.0.0.1:55432/planthepath_dev',
  COGNITO_USER_POOL_ID: 'ap-south-1_students',
  COGNITO_CLIENT_ID: 'student-client',
};
const production = { ...base, NODE_ENV: 'production', AUTOMATION_SIGNING_SECRET: 'x'.repeat(48) };

describe('staff pool configuration', () => {
  it('is absent by default, in development and in production', () => {
    expect(loadRuntimeConfig(base).cognito.staffPool).toBeUndefined();
    const config = loadRuntimeConfig(production);
    expect(config.cognito.staffPool).toBeUndefined();
    expect(createRuntimeStaffPoolPolicy(config)).toBeUndefined();
  });

  it('reads both settings together', () => {
    const config = loadRuntimeConfig({ ...production, COGNITO_STAFF_USER_POOL_ID: 'ap-south-1_staff', COGNITO_STAFF_CLIENT_ID: 'staff-client' });
    expect(config.cognito.staffPool).toEqual({ userPoolId: 'ap-south-1_staff', clientId: 'staff-client' });
  });

  it('refuses half a staff pool, naming the settings and never a value', () => {
    expect(() => loadRuntimeConfig({ ...base, COGNITO_STAFF_USER_POOL_ID: 'ap-south-1_staff' }))
      .toThrow('COGNITO_STAFF_USER_POOL_ID and COGNITO_STAFF_CLIENT_ID must be set together');
    expect(() => loadRuntimeConfig({ ...base, COGNITO_STAFF_CLIENT_ID: 'staff-client' }))
      .toThrow('must be set together');
  });

  it('refuses a staff pool without the student pool it sits beside', () => {
    expect(() => loadRuntimeConfig({
      DATABASE_URL: base.DATABASE_URL, COGNITO_STAFF_USER_POOL_ID: 'ap-south-1_staff', COGNITO_STAFF_CLIENT_ID: 'staff-client',
    })).toThrow('requires COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID');
  });

  it('refuses the student pool or client dressed as the staff pool', () => {
    expect(() => loadRuntimeConfig({ ...base, COGNITO_STAFF_USER_POOL_ID: 'ap-south-1_students', COGNITO_STAFF_CLIENT_ID: 'staff-client' }))
      .toThrow('different pool');
    expect(() => loadRuntimeConfig({ ...base, COGNITO_STAFF_USER_POOL_ID: 'ap-south-1_staff', COGNITO_STAFF_CLIENT_ID: 'student-client' }))
      .toThrow('must differ from COGNITO_CLIENT_ID');
  });

  it('refuses something that is not a pool id', () => {
    expect(() => loadRuntimeConfig({ ...base, COGNITO_STAFF_USER_POOL_ID: 'staff-pool', COGNITO_STAFF_CLIENT_ID: 'staff-client' }))
      .toThrow('must be a Cognito user pool id');
  });

  it('turns a configured staff pool into a policy over the internal platform roles only', () => {
    const config = loadRuntimeConfig({ ...base, COGNITO_STAFF_USER_POOL_ID: 'ap-south-1_staff', COGNITO_STAFF_CLIENT_ID: 'staff-client' });
    const policy = createRuntimeStaffPoolPolicy(config);
    expect(policy).toEqual({
      issuers: [
        'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_staff',
        'https://issuer-cognito-idp.ap-south-1.amazonaws.com/ap-south-1_staff',
      ],
      clientId: 'staff-client',
      staffOnlyRoles: ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'],
    });
    // The runtime verifier builds for both pools without contacting AWS.
    expect(() => createRuntimeIdentityVerifier(config)).not.toThrow();
  });
});
