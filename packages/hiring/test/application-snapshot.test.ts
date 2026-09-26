/**
 * The consented application snapshot builder (EMP-07): what is in it, what never is, that the
 * hash is stable, and what the employer's view reveals at each stage.
 */
import { describe, expect, it } from 'vitest';
import {
  buildApplicationSnapshot,
  canonicalJson,
  employerSnapshotView,
  ERASED_SNAPSHOT,
  readSnapshotChoices,
  snapshotHash,
  SnapshotInputError,
  type SnapshotSources,
} from '../src/application-snapshot.js';

const sources: SnapshotSources = {
  email: 'student@uat.example.test',
  roster: { fullName: 'Synthetic Student', institutionName: 'Synthetic Institute', programmeName: 'BTech', departmentName: 'Computer Science', expectedGraduationDate: '2027-06-30' },
  qualifications: [
    { qualificationType: 'DIPLOMA', programmeName: 'Diploma in Electronics', institutionName: null, startedOn: '2019-06-01', completedOn: '2022-05-31', awarded: true, verificationState: 'SELF_REPORTED' },
    { qualificationType: 'BTECH', programmeName: 'BTech Computer Science', institutionName: 'Synthetic Institute', startedOn: '2023-08-01', completedOn: null, awarded: false, verificationState: 'VERIFIED' },
  ],
  profile: { headline: 'Aspiring analyst', summary: 'I like data.' },
  resume: { title: 'My résumé', filename: 'resume.pdf', versionNumber: 2, contentType: 'application/pdf', byteSize: 1234 },
};

describe('readSnapshotChoices', () => {
  it('accepts nothing, a phone and https links with labels', () => {
    expect(readSnapshotChoices({})).toEqual({ phone: null, links: [] });
    expect(readSnapshotChoices({ contactPhone: ' +91 98765 43210 ', links: [{ url: 'https://example.test/me', label: 'Portfolio' }, { url: 'https://code.example.test/me' }] }))
      .toEqual({ phone: '+91 98765 43210', links: [{ label: 'Portfolio', url: 'https://example.test/me' }, { label: null, url: 'https://code.example.test/me' }] });
  });

  it.each([
    [{ contactPhone: 'call me' }, 'INVALID_CONTACT_PHONE'],
    [{ contactPhone: '12345' }, 'INVALID_CONTACT_PHONE'],
    [{ contactPhone: 9876543210 }, 'INVALID_CONTACT_PHONE'],
    [{ links: 'https://example.test' }, 'INVALID_LINKS'],
    [{ links: Array.from({ length: 6 }, (_, i) => ({ url: `https://example.test/${i}` })) }, 'INVALID_LINKS'],
    [{ links: [{ url: 'http://example.test' }] }, 'INVALID_LINK_URL'],
    [{ links: [{ url: 'javascript:alert(1)' }] }, 'INVALID_LINK_URL'],
    [{ links: [{ url: 'https://example.test', label: '=HYPERLINK()' }] }, 'INVALID_LINK_LABEL'],
    [{ links: [{ url: 'https://example.test', extra: true }] }, 'INVALID_LINKS'],
    [{ links: [{ url: 'https://example.test' }, { url: 'https://example.test' }] }, 'INVALID_LINKS'],
  ])('refuses %j with %s', (input, code) => {
    expect(() => readSnapshotChoices(input as Record<string, unknown>)).toThrow(SnapshotInputError);
    try { readSnapshotChoices(input as Record<string, unknown>); } catch (error) { expect((error as SnapshotInputError).code).toBe(code); }
  });
});

describe('buildApplicationSnapshot', () => {
  const choices = { phone: '+91 98765 43210', links: [{ label: 'Portfolio', url: 'https://example.test/me' }] };

  it('holds the consented profile: name, contact, current education, qualifications without figures, links and the chosen résumé', () => {
    const snapshot = buildApplicationSnapshot(sources, choices);
    expect(snapshot).toEqual({
      schemaVersion: 1,
      candidate: { fullName: 'Synthetic Student', email: 'student@uat.example.test', phone: '+91 98765 43210' },
      education: { institutionName: 'Synthetic Institute', programmeName: 'BTech', departmentName: 'Computer Science', expectedGraduationYear: 2027 },
      qualifications: [
        { qualificationType: 'BTECH', programmeName: 'BTech Computer Science', institutionName: 'Synthetic Institute', startedYear: 2023, completedYear: null, awarded: false, verification: 'VERIFIED' },
        { qualificationType: 'DIPLOMA', programmeName: 'Diploma in Electronics', institutionName: null, startedYear: 2019, completedYear: 2022, awarded: true, verification: 'SELF_REPORTED' },
      ],
      profile: { headline: 'Aspiring analyst', summary: 'I like data.' },
      links: [{ label: 'Portfolio', url: 'https://example.test/me' }],
      resume: { title: 'My résumé', filename: 'resume.pdf', versionNumber: 2, contentType: 'application/pdf', byteSize: 1234 },
    });
  });

  it('never carries readiness, figures, photos, identifiers or timestamps', () => {
    const text = JSON.stringify(buildApplicationSnapshot(sources, choices));
    expect(text).not.toMatch(/readiness|mastery|gap|score|band|cgpa|backlog|result|photo|Id"|_id|At"/i);
  });

  it('says NA rather than guessing when the student has no roster, profile or résumé', () => {
    const snapshot = buildApplicationSnapshot({ email: 'alumni@uat.example.test', roster: null, qualifications: [], profile: null, resume: null }, { phone: null, links: [] });
    expect(snapshot.candidate).toEqual({ fullName: null, email: 'alumni@uat.example.test', phone: null });
    expect(snapshot.education).toEqual({ institutionName: null, programmeName: null, departmentName: null, expectedGraduationYear: null });
    expect(snapshot.resume).toBeNull();
  });

  it('hashes the same content the same way regardless of key or input order', () => {
    const a = buildApplicationSnapshot(sources, choices);
    const b = buildApplicationSnapshot({ ...sources, qualifications: [...sources.qualifications].reverse() }, choices);
    expect(snapshotHash(a)).toBe(snapshotHash(b));
    expect(snapshotHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"e":2,"f":1}]},"b":1}');
    expect(snapshotHash(buildApplicationSnapshot(sources, { ...choices, phone: null }))).not.toBe(snapshotHash(a));
  });
});

describe('employerSnapshotView', () => {
  const stored = buildApplicationSnapshot(sources, { phone: '+91 98765 43210', links: [] });

  it('withholds contact details before SHORTLISTED and shows them from SHORTLISTED onward', () => {
    const early = employerSnapshotView(stored, 'APPLIED');
    expect(early?.candidate).toEqual({ fullName: 'Synthetic Student', email: null, phone: null, contactVisibleFrom: 'SHORTLISTED' });
    for (const state of ['SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED']) {
      expect(employerSnapshotView(stored, state)?.candidate).toEqual({ fullName: 'Synthetic Student', email: 'student@uat.example.test', phone: '+91 98765 43210', contactVisibleFrom: null });
    }
    expect(employerSnapshotView(stored, 'SCREENING')?.candidate).toMatchObject({ email: null, phone: null });
  });

  it('shows nothing for an erased, missing or unknown-format snapshot', () => {
    expect(employerSnapshotView(ERASED_SNAPSHOT, 'SHORTLISTED')).toBeNull();
    expect(employerSnapshotView(null, 'SHORTLISTED')).toBeNull();
    expect(employerSnapshotView({ schemaVersion: 2 }, 'SHORTLISTED')).toBeNull();
  });
});
