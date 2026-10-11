/**
 * Staff-pool policy tests (ADR-025, OPS-07).
 *
 * Verifying the staff pool's tokens (jwt-staff-pool.test.ts) is half the control. The
 * other half is that, once the staff pool exists, an internal role cannot be exercised
 * with a token from the student pool, where MFA is off. These tests hold that half:
 * the same person, the same memberships, and only the issuing pool differs.
 */
import { createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IdentityTokenVerifier, VerifiedIdentityToken } from '../src/cognito.js';
import { createCognitoTokenVerifier } from '../src/cognito.js';
import { createTrustedJwtVerifier, type TrustedJwk } from '../src/jwt.js';
import { resolveAuthorizationContext, type InternalIdentityStore, type InternalMembershipIdentity } from '../src/principal.js';
import {
  applyStaffPoolPolicy,
  cognitoIssuersForUserPool,
  createStaffPoolPolicy,
  isCognitoUserPoolId,
  isStaffPoolToken,
} from '../src/staff-pool.js';

const studentPoolId = 'ap-south-1_students';
const staffPoolId = 'ap-south-1_staff';
const studentIssuer = `https://cognito-idp.ap-south-1.amazonaws.com/${studentPoolId}`;
const staffIssuer = `https://cognito-idp.ap-south-1.amazonaws.com/${staffPoolId}`;
const staffGlobalIssuer = `https://issuer-cognito-idp.ap-south-1.amazonaws.com/${staffPoolId}`;
const studentClientId = 'student-client';
const staffClientId = 'staff-client';
const internalRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

const policy = createStaffPoolPolicy({ userPoolId: staffPoolId, clientId: staffClientId, staffOnlyRoles: internalRoles });

function membership(id: string, organizationId: string, role: string): InternalMembershipIdentity {
  return { id, organizationId, userId: 'user-1', role, state: 'ACTIVE', scope: { organizationId } };
}

const memberships = [
  membership('m-ops', 'platform-org', 'OPERATIONS_ADMIN'),
  membership('m-sec', 'platform-org', 'SECURITY_ADMIN'),
  membership('m-fac', 'college-org', 'FACULTY_LECTURER'),
];

const store: InternalIdentityStore = {
  async findByExternalSubject(subject) { return { id: 'user-1', externalSubject: subject, state: 'ACTIVE' }; },
  async loadActiveMembershipsForUser() { return memberships; },
};

function tokenFrom(issuer: string, clientId: string): VerifiedIdentityToken {
  return { externalSubject: 'sub-1', issuer, clientId, tokenUse: 'access', expiresAt: 2_000_000_000, issuedAt: 1_900_000_000, scopes: [] };
}

function stubVerifier(token: VerifiedIdentityToken): IdentityTokenVerifier {
  return { async verifyAccessToken() { return token; } };
}

describe('staff pool issuers', () => {
  it('derives both Cognito issuer formats from a pool id', () => {
    expect(cognitoIssuersForUserPool(staffPoolId)).toEqual([staffIssuer, staffGlobalIssuer]);
  });

  it('refuses something that is not a pool id', () => {
    expect(isCognitoUserPoolId('staff')).toBe(false);
    expect(isCognitoUserPoolId('ap-south-1_abc123')).toBe(true);
    expect(() => cognitoIssuersForUserPool('https://example.test/pool')).toThrow('invalid Cognito user pool id');
  });

  it('refuses a policy with no client id or no roles', () => {
    expect(() => createStaffPoolPolicy({ userPoolId: staffPoolId, clientId: '', staffOnlyRoles: internalRoles })).toThrow();
    expect(() => createStaffPoolPolicy({ userPoolId: staffPoolId, clientId: staffClientId, staffOnlyRoles: [] })).toThrow();
  });
});

describe('staff-only memberships', () => {
  it('keeps every membership for a staff-pool token, in either issuer format', () => {
    expect(applyStaffPoolPolicy(memberships, tokenFrom(staffIssuer, staffClientId), policy)).toEqual(memberships);
    expect(applyStaffPoolPolicy(memberships, tokenFrom(staffGlobalIssuer, staffClientId), policy)).toEqual(memberships);
  });

  it('drops internal roles for a student-pool token and keeps the rest', () => {
    const kept = applyStaffPoolPolicy(memberships, tokenFrom(studentIssuer, studentClientId), policy);
    expect(kept.map((m) => m.role)).toEqual(['FACULTY_LECTURER']);
  });

  it('does not treat the staff issuer with another client id as staff', () => {
    // Verification already refuses this pairing; the policy does not rely on that.
    expect(isStaffPoolToken(tokenFrom(staffIssuer, studentClientId), policy)).toBe(false);
    expect(isStaffPoolToken(tokenFrom(studentIssuer, staffClientId), policy)).toBe(false);
  });

  it('changes nothing when no staff pool is configured', () => {
    expect(applyStaffPoolPolicy(memberships, tokenFrom(studentIssuer, studentClientId), undefined)).toBe(memberships);
  });
});

describe('authorization context with a staff pool configured', () => {
  it('a student-pool token cannot act as an internal role', async () => {
    const context = await resolveAuthorizationContext('t', stubVerifier(tokenFrom(studentIssuer, studentClientId)), store, { staffPool: policy });
    expect(context.memberships.map((m) => m.role)).toEqual(['FACULTY_LECTURER']);
  });

  it('refuses to select the platform organisation for a student-pool token', async () => {
    await expect(resolveAuthorizationContext('t', stubVerifier(tokenFrom(studentIssuer, studentClientId)), store, {
      staffPool: policy, requestedOrganizationId: 'platform-org',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a staff-pool token keeps the internal roles', async () => {
    const context = await resolveAuthorizationContext('t', stubVerifier(tokenFrom(staffIssuer, staffClientId)), store, {
      staffPool: policy, requestedOrganizationId: 'platform-org',
    });
    expect(context.memberships).toHaveLength(3);
    expect(context.selectedMembership?.role).toBe('OPERATIONS_ADMIN');
  });

  it('is unchanged without a staff pool: the student-pool token keeps its internal roles', async () => {
    const context = await resolveAuthorizationContext('t', stubVerifier(tokenFrom(studentIssuer, studentClientId)), store);
    expect(context.memberships).toHaveLength(3);
  });
});

describe('end to end with signed tokens from two pools', () => {
  const nowSeconds = 1_800_000_000;
  function keyPair(kid: string): { key: KeyObject; jwk: TrustedJwk } {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const published = publicKey.export({ format: 'jwk' }) as JsonWebKey;
    return { key: privateKey, jwk: { kty: 'RSA', kid, n: String(published.n), e: String(published.e), alg: 'RS256', use: 'sig' } };
  }
  const students = keyPair('student-kid');
  const staff = keyPair('staff-kid');
  const verifier = createTrustedJwtVerifier({
    issuer: studentIssuer, clientId: studentClientId, tokenUse: 'access', jwks: [students.jwk],
    additionalPools: [{ issuer: staffIssuer, clientId: staffClientId, jwks: [staff.jwk] }],
    now: () => new Date(nowSeconds * 1000),
  });
  function sign(key: KeyObject, kid: string, iss: string, clientId: string): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const input = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode({
      iss, client_id: clientId, sub: 'sub-1', token_use: 'access', exp: nowSeconds + 300, iat: nowSeconds - 30,
    })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(input);
    signer.end();
    return `${input}.${signer.sign(key).toString('base64url')}`;
  }

  it('the same person reaches the internal role only through the staff pool', async () => {
    const viaStudents = await resolveAuthorizationContext(sign(students.key, 'student-kid', studentIssuer, studentClientId), verifier, store, { staffPool: policy });
    const viaStaff = await resolveAuthorizationContext(sign(staff.key, 'staff-kid', staffIssuer, staffClientId), verifier, store, { staffPool: policy });
    expect(viaStudents.memberships.map((m) => m.role)).toEqual(['FACULTY_LECTURER']);
    expect(viaStaff.memberships.map((m) => m.role)).toEqual(['OPERATIONS_ADMIN', 'SECURITY_ADMIN', 'FACULTY_LECTURER']);
  });

  it('a student-pool token claiming the staff client id is unauthenticated, not staff', async () => {
    await expect(resolveAuthorizationContext(sign(students.key, 'student-kid', studentIssuer, staffClientId), verifier, store, { staffPool: policy }))
      .rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('runtime Cognito verifier with a staff pool', () => {
  it('builds for two distinct pools without contacting AWS', () => {
    expect(() => createCognitoTokenVerifier({
      userPoolId: studentPoolId, clientId: studentClientId,
      additionalPools: [{ userPoolId: staffPoolId, clientId: staffClientId }],
    })).not.toThrow();
  });

  it('refuses the same pool twice or a half-configured staff pool', () => {
    expect(() => createCognitoTokenVerifier({
      userPoolId: studentPoolId, clientId: studentClientId,
      additionalPools: [{ userPoolId: studentPoolId, clientId: staffClientId }],
    })).toThrow('repeats a user pool');
    expect(() => createCognitoTokenVerifier({
      userPoolId: studentPoolId, clientId: studentClientId,
      additionalPools: [{ userPoolId: staffPoolId, clientId: '' }],
    })).toThrow('incomplete');
  });

  it('rejects a token from neither pool', async () => {
    const verifier = createCognitoTokenVerifier({
      userPoolId: studentPoolId, clientId: studentClientId,
      additionalPools: [{ userPoolId: staffPoolId, clientId: staffClientId }],
    });
    // Unknown issuer is refused before any key fetch, so this never reaches the network.
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const forged = `${encode({ alg: 'RS256', kid: 'k' })}.${encode({ iss: 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_other', client_id: staffClientId, sub: 's', token_use: 'access', exp: 4_000_000_000, iat: 1 })}.c2ln`;
    await expect(verifier.verifyAccessToken(forged)).rejects.toThrow();
  });
});
