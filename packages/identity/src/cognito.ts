import { CognitoJwtVerifier } from 'aws-jwt-verify';

export interface VerifiedIdentityToken {
  readonly externalSubject: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly tokenUse: string;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly notBefore?: number;
  readonly scopes: readonly string[];
  readonly email?: string;
  readonly emailVerified?: boolean;
}

export interface IdentityTokenVerifier {
  verifyAccessToken(token: string): Promise<VerifiedIdentityToken>;
}

export interface CognitoVerifierConfig {
  readonly userPoolId: string;
  readonly clientId: string;
  /**
   * ADR-025's staff pool. Each pool is verified against its own issuer, keys and client
   * id: aws-jwt-verify selects the pool by the token's issuer and then requires that
   * pool's client id, so a student-pool token cannot borrow the staff client id.
   * Absent, the verifier is built exactly as before.
   */
  readonly additionalPools?: readonly { readonly userPoolId: string; readonly clientId: string }[];
}

export function createCognitoTokenVerifier(config: CognitoVerifierConfig): IdentityTokenVerifier {
  if (!config.userPoolId || !config.clientId) throw new Error('Cognito verifier configuration is incomplete');
  const additionalPools = config.additionalPools ?? [];
  const poolIds = new Set([config.userPoolId]);
  for (const pool of additionalPools) {
    if (!pool.userPoolId || !pool.clientId) throw new Error('Cognito verifier configuration is incomplete');
    if (poolIds.has(pool.userPoolId)) throw new Error('Cognito verifier configuration repeats a user pool');
    poolIds.add(pool.userPoolId);
  }

  const verifier = additionalPools.length
    ? CognitoJwtVerifier.create([
      { userPoolId: config.userPoolId, tokenUse: 'access', clientId: config.clientId },
      ...additionalPools.map((pool) => ({ userPoolId: pool.userPoolId, tokenUse: 'access' as const, clientId: pool.clientId })),
    ])
    : CognitoJwtVerifier.create({
      userPoolId: config.userPoolId,
      tokenUse: 'access',
      clientId: config.clientId,
    });

  return {
    async verifyAccessToken(token: string): Promise<VerifiedIdentityToken> {
      const payload = await verifier.verify(token);
      if (!payload.sub || !payload.client_id || !payload.iss || !payload.token_use || !payload.exp || !payload.iat) {
        throw new Error('verified Cognito token missing required identity claims');
      }

      const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
      return {
        externalSubject: payload.sub,
        clientId: payload.client_id,
        issuer: payload.iss,
        tokenUse: payload.token_use,
        expiresAt: payload.exp,
        issuedAt: payload.iat,
        ...(typeof payload.nbf === 'number' ? { notBefore: payload.nbf } : {}),
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
        ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
        ...(typeof payload.email === 'string' ? { emailVerified } : {}),
      };
    },
  };
}

export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) throw new Error('missing authorization header');
  const [scheme, token, extra] = authorizationHeader.trim().split(/\s+/);
  if (scheme !== 'Bearer' || !token || extra) throw new Error('invalid authorization header');
  return token;
}
