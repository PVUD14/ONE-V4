import { createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTrustedJwtVerifier, type TrustedJwk } from '../src/jwt.js';

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'client-123';
const nowSeconds = 1_800_000_000;
const now = () => new Date(nowSeconds * 1000);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
const jwk: TrustedJwk = {
  kty: 'RSA',
  kid: 'kid-1',
  n: String(publicJwk.n),
  e: String(publicJwk.e),
  alg: 'RS256',
  use: 'sig',
};

function signToken(input: {
  readonly header?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  readonly key?: KeyObject;
} = {}): string {
  const header = { alg: 'RS256', kid: 'kid-1', typ: 'JWT', ...input.header };
  const payload = {
    iss: issuer,
    sub: 'cognito-sub-123',
    client_id: clientId,
    token_use: 'access',
    exp: nowSeconds + 300,
    iat: nowSeconds - 30,
    scope: 'openid profile',
    email: 'Student@Example.Test',
    email_verified: true,
    ...input.payload,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(input.key ?? privateKey).toString('base64url')}`;
}

function corruptSignature(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[2]) return token;

  const signature = Buffer.from(parts[2], 'base64url');
  const firstByte = signature.at(0);
  if (firstByte === undefined) return token;

  signature[0] = firstByte ^ 0xff;
  return `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('managed identity JWT verification', () => {
  it('accepts a valid Cognito-compatible access token signed by a trusted key', async () => {
    const verifier = createTrustedJwtVerifier({ issuer, clientId, tokenUse: 'access', jwks: [jwk], now });

    await expect(verifier.verifyAccessToken(signToken())).resolves.toMatchObject({
      externalSubject: 'cognito-sub-123',
      clientId,
      issuer,
      tokenUse: 'access',
      scopes: ['openid', 'profile'],
      email: 'Student@Example.Test',
      emailVerified: true,
    });
  });

  it('rejects invalid signatures', async () => {
    const token = corruptSignature(signToken());
    const verifier = createTrustedJwtVerifier({ issuer, clientId, tokenUse: 'access', jwks: [jwk], now });
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow('invalid token signature');
  });

  it('rejects wrong issuer and wrong audience/client binding', async () => {
    const verifier = createTrustedJwtVerifier({ issuer, clientId, tokenUse: 'access', jwks: [jwk], now });
    await expect(verifier.verifyAccessToken(signToken({ payload: { iss: `${issuer}-evil` } }))).rejects.toThrow('invalid token issuer');
    await expect(verifier.verifyAccessToken(signToken({ payload: { client_id: 'other-client' } }))).rejects.toThrow('invalid token audience');
    await expect(verifier.verifyAccessToken(signToken({ payload: { client_id: undefined, aud: ['other-client', clientId] } }))).rejects.toThrow('invalid token audience');
  });

  it('rejects expired and premature not-before tokens', async () => {
    const verifier = createTrustedJwtVerifier({ issuer, clientId, tokenUse: 'access', jwks: [jwk], now });
    await expect(verifier.verifyAccessToken(signToken({ payload: { exp: nowSeconds - 1 } }))).rejects.toThrow('token expired');
    await expect(verifier.verifyAccessToken(signToken({ payload: { nbf: nowSeconds + 60 } }))).rejects.toThrow('token not yet valid');
  });

  it('rejects malformed required claims after signature verification', async () => {
    const verifier = createTrustedJwtVerifier({ issuer, clientId, tokenUse: 'access', jwks: [jwk], now });
    await expect(verifier.verifyAccessToken(signToken({ payload: { exp: 'not-a-number' } }))).rejects.toThrow('token expired');
    await expect(verifier.verifyAccessToken(signToken({ payload: { iat: 'not-a-number' } }))).rejects.toThrow('issued-at claim is required');
    await expect(verifier.verifyAccessToken(signToken({ payload: { nbf: 'not-a-number' } }))).rejects.toThrow('not-before claim is invalid');
    await expect(verifier.verifyAccessToken(signToken({ payload: { sub: '' } }))).rejects.toThrow('subject claim is required');
  });

  it('rejects unsupported algorithms, unknown key IDs, wrong token use, and malformed tokens', async () => {
    const verifier = createTrustedJwtVerifier({ issuer, clientId, tokenUse: 'access', jwks: [jwk], now });
    await expect(verifier.verifyAccessToken(signToken({ header: { alg: 'HS256' } }))).rejects.toThrow('unsupported token algorithm');
    await expect(verifier.verifyAccessToken(signToken({ header: { alg: 'none' } }))).rejects.toThrow('unsupported token algorithm');
    await expect(verifier.verifyAccessToken(signToken({ header: { kid: 'unknown-kid' } }))).rejects.toThrow('unknown token key id');
    await expect(verifier.verifyAccessToken(signToken({ payload: { token_use: 'id' } }))).rejects.toThrow('invalid token use');
    await expect(verifier.verifyAccessToken('not-a-jwt')).rejects.toThrow('malformed token');
  });

  it('rejects ambiguous trusted key configuration', () => {
    expect(() => createTrustedJwtVerifier({
      issuer,
      clientId,
      tokenUse: 'access',
      jwks: [jwk, { ...jwk }],
      now,
    })).toThrow('duplicate trusted key id');
  });
});
