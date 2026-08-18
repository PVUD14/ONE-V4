import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { VerifiedIdentityToken } from './cognito.js';

export const invitationTokenBytes = 32;
export const invitationTokenDigestAlgorithm = 'sha256';

export function generateInvitationToken(randomBytesFn: (size: number) => Buffer = randomBytes): string {
  return randomBytesFn(invitationTokenBytes).toString('base64url');
}

export function digestInvitationToken(rawToken: string): string {
  if (!rawToken) throw new Error('invitation token is required');
  return createHash(invitationTokenDigestAlgorithm).update(rawToken, 'utf8').digest('hex');
}

export function verifyInvitationTokenDigest(rawToken: string, expectedDigest: string): boolean {
  const actualDigest = digestInvitationToken(rawToken);
  const actual = Buffer.from(actualDigest, 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function normalizeEmailAddress(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) throw new Error('valid email is required');
  return normalized;
}

export function requireVerifiedRecipientEmail(token: VerifiedIdentityToken): string {
  if (!token.email || token.emailVerified !== true) throw new Error('verified recipient email is required');
  return normalizeEmailAddress(token.email);
}
