import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import type { VerifiedIdentityToken } from './cognito.js';

export class TokenVerificationError extends Error {
  readonly code = 'TOKEN_VERIFICATION_FAILED';

  constructor(message = 'token verification failed') {
    super(message);
  }
}

export interface TrustedJwk {
  readonly kty: 'RSA';
  readonly kid: string;
  readonly n: string;
  readonly e: string;
  readonly alg?: string;
  readonly use?: string;
}

export interface TrustedJwtVerifierConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenUse: 'access';
  readonly jwks: readonly TrustedJwk[];
  /**
   * Additional issuer/client pairs this verifier accepts, for ADR-025's separate staff
   * pool with MFA required.
   *
   * An issuer is only ever accepted together with its own client id and its own keys:
   * widening this to "any of these issuers, any of these clients" would let a token
   * minted by the student pool present itself as a staff token, which is the whole
   * thing the pool split exists to prevent. Absent or empty, behaviour is unchanged.
   */
  readonly additionalPools?: readonly {
    readonly issuer: string;
    readonly clientId: string;
    readonly jwks: readonly TrustedJwk[];
  }[];
  readonly now?: () => Date;
}

/** The pool a verified token came from, so a caller can tell staff from student. */
export interface ResolvedIssuerPool {
  readonly issuer: string;
  readonly clientId: string;
  readonly jwks: readonly TrustedJwk[];
}

/**
 * Select the pool matching a token's issuer.
 *
 * Returns undefined for an unknown issuer; the caller rejects. Matching on the issuer
 * first, then requiring that pool's client id, keeps each pool's trust boundary intact.
 */
export function resolveIssuerPool(config: TrustedJwtVerifierConfig, issuer: unknown): ResolvedIssuerPool | undefined {
  if (typeof issuer !== 'string' || !issuer) return undefined;
  if (issuer === config.issuer) return { issuer: config.issuer, clientId: config.clientId, jwks: config.jwks };
  return (config.additionalPools ?? []).find((pool) => pool.issuer === issuer);
}

interface JwtHeader {
  readonly alg?: unknown;
  readonly kid?: unknown;
  readonly typ?: unknown;
}

interface JwtPayload {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly client_id?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly nbf?: unknown;
  readonly token_use?: unknown;
  readonly scope?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
}

export function createTrustedJwtVerifier(config: TrustedJwtVerifierConfig) {
  validateVerifierConfig(config);

  return {
    async verifyAccessToken(token: string): Promise<VerifiedIdentityToken> {
      return verifyJwtWithTrustedJwks(token, config);
    },
  };
}

export function verifyJwtWithTrustedJwks(token: string, config: TrustedJwtVerifierConfig): VerifiedIdentityToken {
  validateVerifierConfig(config);

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new TokenVerificationError('malformed token');

  const header = decodeJson<JwtHeader>(parts[0]);
  if (header.alg !== 'RS256') throw new TokenVerificationError('unsupported token algorithm');
  if (typeof header.kid !== 'string' || !header.kid) throw new TokenVerificationError('token key id is required');

  // The issuing pool is resolved from the unverified payload only to choose which keys
  // to check the signature against. It grants nothing on its own: an unknown issuer is
  // rejected, a key id absent from that pool is rejected, and the signature must still
  // verify under that pool's key before any claim is believed.
  const unverifiedPayload = decodeJson<JwtPayload>(parts[1]);
  const pool = resolveIssuerPool(config, unverifiedPayload.iss);
  if (!pool) throw new TokenVerificationError('invalid token issuer');

  const jwk = pool.jwks.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new TokenVerificationError('unknown token key id');
  validateTrustedJwk(jwk);

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = base64UrlDecode(parts[2]);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput);
  verifier.end();

  const publicKey = createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' });
  if (!verifier.verify(publicKey, signature)) throw new TokenVerificationError('invalid token signature');

  const payload = decodeJson<JwtPayload>(parts[1]);
  validatePayload(payload, config);

  const clientId = payload.client_id ?? audienceToClientId(payload.aud);
  if (typeof clientId !== 'string' || !clientId) throw new TokenVerificationError('invalid token audience');

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  return {
    externalSubject: payload.sub,
    clientId,
    issuer: payload.iss,
    tokenUse: payload.token_use,
    expiresAt: payload.exp,
    issuedAt: payload.iat,
    ...(payload.nbf !== undefined ? { notBefore: payload.nbf } : {}),
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    ...(typeof payload.email === 'string' ? { emailVerified } : {}),
  };
}

function validateVerifierConfig(config: TrustedJwtVerifierConfig): void {
  if (!config.issuer || !config.clientId || config.tokenUse !== 'access') {
    throw new TokenVerificationError('invalid verifier configuration');
  }
  if (!Array.isArray(config.jwks) || config.jwks.length === 0) throw new TokenVerificationError('trusted keys are required');
  validatePoolKeys(config.jwks);

  const seenIssuers = new Set<string>([config.issuer]);
  for (const pool of config.additionalPools ?? []) {
    if (!pool.issuer || !pool.clientId) throw new TokenVerificationError('invalid verifier configuration');
    // Two pools claiming the same issuer would make key selection ambiguous, and an
    // ambiguous trust boundary is not a trust boundary.
    if (seenIssuers.has(pool.issuer)) throw new TokenVerificationError('duplicate issuer configuration');
    seenIssuers.add(pool.issuer);
    if (!Array.isArray(pool.jwks) || pool.jwks.length === 0) throw new TokenVerificationError('trusted keys are required');
    validatePoolKeys(pool.jwks);
  }
}

/** Key ids must be unique within a pool; different pools may reuse an id. */
function validatePoolKeys(jwks: readonly TrustedJwk[]): void {
  const seenKids = new Set<string>();
  for (const jwk of jwks) {
    validateTrustedJwk(jwk);
    if (seenKids.has(jwk.kid)) throw new TokenVerificationError('duplicate trusted key id');
    seenKids.add(jwk.kid);
  }
}

function validateTrustedJwk(jwk: TrustedJwk): void {
  if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid || typeof jwk.n !== 'string' || !jwk.n || typeof jwk.e !== 'string' || !jwk.e) {
    throw new TokenVerificationError('invalid trusted key');
  }
  if (jwk.alg && jwk.alg !== 'RS256') throw new TokenVerificationError('unsupported key algorithm');
  if (jwk.use && jwk.use !== 'sig') throw new TokenVerificationError('unsupported key use');
}

function validatePayload(payload: JwtPayload, config: TrustedJwtVerifierConfig): asserts payload is {
  readonly iss: string;
  readonly sub: string;
  readonly exp: number;
  readonly iat: number;
  readonly nbf?: number;
  readonly token_use: 'access';
  readonly client_id?: string;
  readonly aud?: string | readonly string[];
  readonly scope?: string;
  readonly email?: string;
  readonly email_verified?: boolean | string;
} {
  const now = Math.floor((config.now?.() ?? new Date()).getTime() / 1000);
  const pool = resolveIssuerPool(config, payload.iss);
  if (!pool) throw new TokenVerificationError('invalid token issuer');
  if (payload.token_use !== config.tokenUse) throw new TokenVerificationError('invalid token use');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new TokenVerificationError('subject claim is required');
  if (!isJwtTimestamp(payload.exp) || payload.exp <= now) throw new TokenVerificationError('token expired');
  if (!isJwtTimestamp(payload.iat)) throw new TokenVerificationError('issued-at claim is required');
  if (payload.nbf !== undefined && !isJwtTimestamp(payload.nbf)) throw new TokenVerificationError('not-before claim is invalid');
  if (payload.nbf !== undefined && payload.nbf > now) throw new TokenVerificationError('token not yet valid');

  // The client id of the pool that issued it, never any configured client id.
  const clientId = payload.client_id ?? audienceToClientId(payload.aud);
  if (clientId !== pool.clientId) throw new TokenVerificationError('invalid token audience');
}

function isJwtTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function audienceToClientId(audience: JwtPayload['aud']): string | undefined {
  if (typeof audience === 'string') return audience;
  if (Array.isArray(audience) && audience.length === 1 && typeof audience[0] === 'string') return audience[0];
  return undefined;
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(base64UrlDecode(value).toString('utf8')) as T;
  } catch {
    throw new TokenVerificationError('malformed token');
  }
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
