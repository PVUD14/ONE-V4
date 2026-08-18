import { describe, expect, it } from 'vitest';
import {
  digestInvitationToken,
  generateInvitationToken,
  normalizeEmailAddress,
  requireVerifiedRecipientEmail,
  verifyInvitationTokenDigest,
} from '../src/invitation-token.js';

describe('invitation token protection', () => {
  it('generates high-entropy URL-safe tokens and stores only irreversible digests', () => {
    const token = generateInvitationToken(() => Buffer.alloc(32, 7));
    const digest = digestInvitationToken(token);

    expect(token).not.toContain('=');
    expect(token).not.toBe(digest);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyInvitationTokenDigest(token, digest)).toBe(true);
    expect(verifyInvitationTokenDigest(`${token}x`, digest)).toBe(false);
  });

  it('normalizes invitation recipient email from verified identity claims', () => {
    expect(requireVerifiedRecipientEmail({
      externalSubject: 'sub-1',
      clientId: 'client-1',
      issuer: 'issuer',
      tokenUse: 'access',
      expiresAt: 2_000_000_000,
      issuedAt: 1_900_000_000,
      scopes: [],
      email: ' Student@Example.Test ',
      emailVerified: true,
    })).toBe('student@example.test');
  });

  it('rejects unverified or missing recipient email claims', () => {
    const base = {
      externalSubject: 'sub-1',
      clientId: 'client-1',
      issuer: 'issuer',
      tokenUse: 'access',
      expiresAt: 2_000_000_000,
      issuedAt: 1_900_000_000,
      scopes: [],
    };

    expect(() => requireVerifiedRecipientEmail(base)).toThrow('verified recipient email is required');
    expect(() => requireVerifiedRecipientEmail({ ...base, email: 'student@example.test', emailVerified: false })).toThrow('verified recipient email is required');
  });

  it('normalizes email addresses deterministically for recipient binding', () => {
    expect(normalizeEmailAddress(' USER@Example.Test ')).toBe('user@example.test');
    expect(() => normalizeEmailAddress('not-an-email')).toThrow('valid email is required');
  });
});
