/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Two-issuer token verification for ADR-025's separate staff pool.
 *
 * The point of these tests is not that a second pool works. It is that the two pools
 * stay separate: a token minted by the student pool must not be accepted as a staff
 * token by borrowing the staff pool's client id, or vice versa. A verifier that
 * accepted "any configured issuer with any configured client id" would pass a naive
 * test and defeat the entire reason for splitting the pools.
 */
import { createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTrustedJwtVerifier, resolveIssuerPool, verifyJwtWithTrustedJwks, type TrustedJwk } from '../src/jwt.js';

const studentIssuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_students';
const staffIssuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_staff';
const studentClientId = 'student-client';
const staffClientId = 'staff-client';
const nowSeconds = 1_800_000_000;
const now = (): Date => new Date(nowSeconds * 1000);

function pool(kid: string): { key: KeyObject; jwk: TrustedJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const published = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  return {
    key: privateKey,
    jwk: { kty: 'RSA', kid, n: String(published.n), e: String(published.e), alg: 'RS256', use: 'sig' },
  };
}

const students = pool('student-kid');
const staff = pool('staff-kid');

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signToken(input: { kid: string; key: KeyObject; payload: Record<string, unknown> }): string {
  const header = { alg: 'RS256', kid: input.kid, typ: 'JWT' };
  const payload = {
    sub: 'cognito-sub-1',
    token_use: 'access',
    exp: nowSeconds + 300,
    iat: nowSeconds - 30,
    scope: 'openid',
    ...input.payload,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(input.key).toString('base64url')}`;
}

const twoPoolConfig = {
  issuer: studentIssuer,
  clientId: studentClientId,
  tokenUse: 'access' as const,
  jwks: [students.jwk],
  additionalPools: [{ issuer: staffIssuer, clientId: staffClientId, jwks: [staff.jwk] }],
  now,
};

/** The synchronous entry point, so a rejection can be asserted directly. */
const verify = (token: string): ReturnType<typeof verifyJwtWithTrustedJwks> =>
  verifyJwtWithTrustedJwks(token, twoPoolConfig);

describe('two-issuer verification', () => {
  it('accepts a token from the original pool, unchanged', () => {
    const token = signToken({ kid: 'student-kid', key: students.key, payload: { iss: studentIssuer, client_id: studentClientId } });
    const verified = verify(token);
    expect(verified.issuer).toBe(studentIssuer);
    expect(verified.clientId).toBe(studentClientId);
  });

  it('accepts a token from the staff pool', () => {
    const token = signToken({ kid: 'staff-kid', key: staff.key, payload: { iss: staffIssuer, client_id: staffClientId } });
    const verified = verify(token);
    expect(verified.issuer).toBe(staffIssuer);
    expect(verified.clientId).toBe(staffClientId);
  });

  it('refuses a student token claiming the staff client id', () => {
    // The pool is chosen by issuer, and that pool's client id is then required. This is
    // the attack the split exists to prevent.
    const token = signToken({ kid: 'student-kid', key: students.key, payload: { iss: studentIssuer, client_id: staffClientId } });
    expect(() => verify(token)).toThrow('invalid token audience');
  });

  it('refuses a staff-issuer token signed with the student pool key', () => {
    const token = signToken({ kid: 'student-kid', key: students.key, payload: { iss: staffIssuer, client_id: staffClientId } });
    // The staff pool does not publish that key id, so selection fails before signature.
    expect(() => verify(token)).toThrow('unknown token key id');
  });

  it('refuses a staff-issuer token signed with a key the staff pool does not publish', () => {
    const impostor = pool('staff-kid');
    const token = signToken({ kid: 'staff-kid', key: impostor.key, payload: { iss: staffIssuer, client_id: staffClientId } });
    // Same key id, different key: selection succeeds and the signature check fails.
    expect(() => verify(token)).toThrow('invalid token signature');
  });

  it('refuses an issuer that is configured nowhere', () => {
    const token = signToken({ kid: 'staff-kid', key: staff.key, payload: { iss: 'https://example.test/other', client_id: staffClientId } });
    expect(() => verify(token)).toThrow('invalid token issuer');
  });

  it('refuses two pools claiming the same issuer', () => {
    expect(() => createTrustedJwtVerifier({
      issuer: studentIssuer, clientId: studentClientId, tokenUse: 'access', jwks: [students.jwk],
      additionalPools: [{ issuer: studentIssuer, clientId: staffClientId, jwks: [staff.jwk] }], now,
    })).toThrow('duplicate issuer configuration');
  });

  it('lets separate pools reuse a key id without collision', () => {
    const a = pool('shared-kid');
    const b = pool('shared-kid');
    const config = {
      issuer: studentIssuer, clientId: studentClientId, tokenUse: 'access' as const, jwks: [a.jwk],
      additionalPools: [{ issuer: staffIssuer, clientId: staffClientId, jwks: [b.jwk] }], now,
    };
    const token = signToken({ kid: 'shared-kid', key: b.key, payload: { iss: staffIssuer, client_id: staffClientId } });
    expect(verifyJwtWithTrustedJwks(token, config).issuer).toBe(staffIssuer);
  });

  it('resolves pools without a token', () => {
    const config = {
      issuer: studentIssuer, clientId: studentClientId, tokenUse: 'access' as const, jwks: [students.jwk],
      additionalPools: [{ issuer: staffIssuer, clientId: staffClientId, jwks: [staff.jwk] }],
    };
    expect(resolveIssuerPool(config, staffIssuer)?.clientId).toBe(staffClientId);
    expect(resolveIssuerPool(config, 'https://example.test/nope')).toBeUndefined();
    expect(resolveIssuerPool(config, undefined)).toBeUndefined();
  });
});
