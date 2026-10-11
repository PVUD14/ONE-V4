/**
 * Staff-pool policy (ADR-025, OPS-07): which roles only a staff-pool token may exercise.
 *
 * ADR-025 moves staff into a separate Cognito pool with MFA REQUIRED. Verifying a second
 * issuer (jwt.ts, cognito.ts) only makes staff tokens acceptable; on its own it does not
 * stop a person who holds an internal role from signing in through the student pool,
 * which has MFA off, and using that role anyway. This policy closes that path: once a
 * staff pool is configured, a membership in one of the staff-only roles counts only when
 * the request's token was issued by the staff pool to the staff client.
 *
 * The policy removes memberships; it never adds one, and it never rejects the request
 * outright. A student-pool token still reaches everything its other memberships and
 * relationships allow, so a person who is both a student and staff is not locked out of
 * their student account (ADR-025 accepts that they hold two accounts).
 *
 * Absent (no staff pool configured), behaviour is unchanged.
 */
import type { VerifiedIdentityToken } from './cognito.js';

export interface StaffPoolPolicy {
  /** Every issuer string the staff pool may appear as (Cognito publishes two formats). */
  readonly issuers: readonly string[];
  /** The staff pool's app client id. A staff issuer with another client id is not staff. */
  readonly clientId: string;
  /** Roles that count only from a staff-pool token. */
  readonly staffOnlyRoles: readonly string[];
}

const userPoolIdPattern = /^(?<region>[a-z]{2}(?:-[a-z]+)+-\d+)_[A-Za-z0-9]+$/;

/** True when the id has the shape of a Cognito user pool id (region_suffix). */
export function isCognitoUserPoolId(userPoolId: string): boolean {
  return userPoolIdPattern.test(userPoolId);
}

/**
 * The issuer strings a Cognito pool signs with: the regional form and the newer global
 * form, both of which aws-jwt-verify accepts for the same pool.
 */
export function cognitoIssuersForUserPool(userPoolId: string): readonly string[] {
  const match = userPoolIdPattern.exec(userPoolId);
  const region = match?.groups?.['region'];
  if (!region) throw new Error('invalid Cognito user pool id');
  return [
    `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    `https://issuer-cognito-idp.${region}.amazonaws.com/${userPoolId}`,
  ];
}

export function createStaffPoolPolicy(input: {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly staffOnlyRoles: readonly string[];
}): StaffPoolPolicy {
  if (!input.clientId) throw new Error('staff pool client id is required');
  if (!input.staffOnlyRoles.length) throw new Error('staff-only roles are required');
  return {
    issuers: cognitoIssuersForUserPool(input.userPoolId),
    clientId: input.clientId,
    staffOnlyRoles: [...input.staffOnlyRoles],
  };
}

/** Whether a verified token was issued by the staff pool to the staff client. */
export function isStaffPoolToken(token: Pick<VerifiedIdentityToken, 'issuer' | 'clientId'>, policy: StaffPoolPolicy): boolean {
  return policy.issuers.includes(token.issuer) && token.clientId === policy.clientId;
}

/**
 * Drop staff-only memberships unless the token came from the staff pool.
 * With no policy the list is returned as it is.
 */
export function applyStaffPoolPolicy<T extends { readonly role: string }>(
  memberships: readonly T[],
  token: Pick<VerifiedIdentityToken, 'issuer' | 'clientId'>,
  policy: StaffPoolPolicy | undefined,
): readonly T[] {
  if (!policy || isStaffPoolToken(token, policy)) return memberships;
  return memberships.filter((membership) => !policy.staffOnlyRoles.includes(membership.role));
}
