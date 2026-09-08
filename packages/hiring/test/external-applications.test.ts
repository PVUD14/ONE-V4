/**
 * ONE · Stream B — Hiring
 * Owner: Manisha · Created: 2026-09-08
 * Agent-assisted: yes (Codex) · Reviewed: pending
 */
import { describe, expect, it } from 'vitest';
import { externalFields, externalInputRecord, externalRevision } from '../src/external-applications.js';
const input = { companyName: ' Company ', roleTitle: ' Role ', sourceKind: 'REFERRAL', appliedOn: '2024-02-29' };
describe('external declaration input boundary', () => {
  it('accepts a real leap day and trims labels without inventing a link or consent', () => {
    expect(externalFields(input, false, '2026-01-01')).toEqual({ companyName: 'Company', roleTitle: 'Role', sourceKind: 'REFERRAL', appliedOn: '2024-02-29', applicationUrl: null, stage: 'APPLIED' });
  });
  it.each(['2025-02-29', '2024-02-30', '2025-13-01', '2025-01-01T00:00Z', '0000-01-01', '2027-01-01'])('rejects a noncalendar or future date %s', (appliedOn) => {
    expect(() => externalFields({ ...input, appliedOn }, false, '2026-01-01')).toThrow();
  });
  it('rejects embedded URL credentials, whitespace, unsupported schemes and empty host', () => {
    const credentialed = new URL('https://example.test/application');
    credentialed.username = crypto.randomUUID(); credentialed.password = crypto.randomUUID();
    for (const applicationUrl of [credentialed.href, 'https://example.test/a b', 'http://example.test', 'https://', 'https://example.test\\path']) {
      expect(() => externalFields({ ...input, applicationUrl })).toThrow();
    }
  });
  it('rejects mass assignment, arrays, empty edits and invalid revisions', () => {
    expect(() => externalFields({ ...input, source: 'NATIVE' })).toThrow();
    expect(() => externalFields({ revision: 1 }, true)).toThrow();
    expect(() => externalInputRecord([], [])).toThrow();
    for (const revision of [0, -1, 1.5, '1', null, 2_147_483_647]) expect(() => externalRevision({ revision })).toThrow();
    expect(externalRevision({ revision: 1 })).toBe(1);
  });
});
