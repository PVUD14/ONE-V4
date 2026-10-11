/**
 * Content bulk import rules (OPS-09d): only CONTENT_EDIT on an ACTIVE platform membership may
 * preview or commit an import, and a commit carries one of the reason codes declared in code.
 * Pure functions; the API spec proves the endpoints agree.
 */
import { describe, expect, it } from 'vitest';
import { canImportContent, contentImportReasons, isContentImportReason } from './content-import.js';

const withGrants = (userId: string, grants: readonly string[], state = 'ACTIVE') => ({ userId, memberships: [{ role: 'OPERATIONS_ADMIN', state, grants }] });

describe('who may import content', () => {
  it('allows CONTENT_EDIT on an ACTIVE platform membership', () => {
    expect(canImportContent(withGrants('e', ['CONTENT_EDIT']))).toBe(true);
  });

  it('denies reviewers, publishers, catalogue managers and plain operators', () => {
    expect(canImportContent(withGrants('r', ['CONTENT_REVIEW']))).toBe(false);
    expect(canImportContent(withGrants('p', ['CONTENT_PUBLISH']))).toBe(false);
    expect(canImportContent(withGrants('c', ['CATALOGUE_MANAGE']))).toBe(false);
    expect(canImportContent({ memberships: [{ role: 'OPERATIONS_ADMIN', state: 'ACTIVE' }] })).toBe(false);
  });

  it('denies an inactive membership and a non-platform role holding the grant', () => {
    expect(canImportContent(withGrants('s', ['CONTENT_EDIT'], 'SUSPENDED'))).toBe(false);
    expect(canImportContent(withGrants('e', ['CONTENT_EDIT'], 'ENDED'))).toBe(false);
    expect(canImportContent({ memberships: [{ role: 'INSTITUTION_ADMIN', state: 'ACTIVE', grants: ['CONTENT_EDIT'] }] })).toBe(false);
    expect(canImportContent({ memberships: [{ role: 'STUDENT', state: 'ACTIVE' }] })).toBe(false);
  });

  it('keeps the super admin as break-glass', () => {
    expect(canImportContent({ memberships: [{ role: 'PLATFORM_SUPER_ADMIN', state: 'ACTIVE' }] })).toBe(true);
  });
});

describe('import reason codes', () => {
  it('accepts only the codes declared in code, all in the §5.3 pattern', () => {
    for (const reason of contentImportReasons) {
      expect(isContentImportReason(reason)).toBe(true);
      expect(reason).toMatch(/^[A-Z0-9_:-]{3,64}$/);
    }
    expect(isContentImportReason('PUBLISH_NOW')).toBe(false);
    expect(isContentImportReason('track_build')).toBe(false);
    expect(isContentImportReason(undefined)).toBe(false);
  });
});
