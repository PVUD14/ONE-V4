/**
 * The employer applicant export's content rules (EMP-17): only what the student shared, contact
 * details from Shortlisted only, formulas neutralised, no forbidden column, and a hash of the exact
 * bytes. The whole file is compared with a committed CSV fixture.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applicantExportRow,
  employerApplicantCsv,
  employerApplicantExportHeader,
  employerExportFilename,
  isForbiddenEmployerExportHeader,
} from './employer-applicant-export.js';

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  candidate: { fullName: 'Synthetic Candidate One', email: 'one@uat.example.test', phone: '+91 98765 43210' },
  education: { institutionName: 'Synthetic Institute of Technology', programmeName: 'BTech', departmentName: 'Computer Science', expectedGraduationYear: 2027 },
  qualifications: [{ qualificationType: 'BTECH', programmeName: 'BTech Computer Science', institutionName: 'Synthetic Institute of Technology', startedYear: 2023, completedYear: null, awarded: false, verification: 'VERIFIED' }],
  profile: { headline: 'Aspiring analyst', summary: 'I like data, "clean" data.' },
  links: [{ label: 'Portfolio', url: 'https://portfolio.example.test/one' }],
  resume: { title: 'My résumé', filename: 'resume.pdf', versionNumber: 1, contentType: 'application/pdf', byteSize: 10 },
  ...overrides,
});

describe('applicantExportRow', () => {
  it('writes contact details only from Shortlisted onward, and says so when withheld', () => {
    const shortlisted = applicantExportRow({ state: 'SHORTLISTED', submittedAt: '2026-09-01T10:00:00.000Z', snapshot: snapshot(), snapshotErased: false });
    expect(shortlisted.slice(0, 4)).toEqual(['Synthetic Candidate One', 'one@uat.example.test', '+91 98765 43210', 'Shown']);
    const applied = applicantExportRow({ state: 'APPLIED', submittedAt: '2026-09-01T10:00:00.000Z', snapshot: snapshot(), snapshotErased: false });
    expect(applied.slice(0, 4)).toEqual(['Synthetic Candidate One', null, null, 'Shown from Shortlisted']);
  });

  it('writes nothing shared when there is no snapshot, or it was erased, and never falls back to anything else', () => {
    const none = applicantExportRow({ state: 'APPLIED', submittedAt: new Date('2026-09-02T00:00:00Z'), snapshot: null, snapshotErased: false });
    expect(none).toEqual([null, null, null, null, null, null, null, null, null, null, null, null, null, 'Applied', '2026-09-02', 'Not captured']);
    const erased = applicantExportRow({ state: 'SHORTLISTED', submittedAt: null, snapshot: snapshot(), snapshotErased: true });
    expect(erased[0]).toBeNull();
    expect(erased.at(-1)).toBe('Not captured');
  });
});

describe('isForbiddenEmployerExportHeader', () => {
  it.each(['Readiness band', 'Score', 'Mastery', 'Gap status', 'Fit', 'Application ID', 'Roll number', 'Compensation amount', 'Salary',
    'Gender', 'Religion', 'Caste', 'Age', 'Date of birth', 'Disability', 'Marital status', 'Photo', 'Region of origin', 'Hometown'])('refuses %j', (header) => {
    expect(isForbiddenEmployerExportHeader(header)).toBe(true);
  });

  it('accepts every column the export writes (whole words: Stage is not age, Candidate is not id)', () => {
    expect(employerApplicantExportHeader.filter(isForbiddenEmployerExportHeader)).toEqual([]);
  });

  it('refuses to build a document whose header names a forbidden field', () => {
    expect(() => employerApplicantCsv([], ['Candidate', 'Readiness band'])).toThrow();
  });
});

describe('employerApplicantCsv', () => {
  it('builds exactly the committed fixture, neutralising formula-leading cells, with the hash of the exact bytes', () => {
    const rows = [
      applicantExportRow({ state: 'SHORTLISTED', submittedAt: '2026-09-01T10:00:00.000Z', snapshot: snapshot(), snapshotErased: false }),
      applicantExportRow({
        state: 'APPLIED', submittedAt: '2026-09-03T08:30:00.000Z', snapshotErased: false,
        snapshot: snapshot({
          candidate: { fullName: '@Synthetic Two', email: 'two@uat.example.test', phone: null },
          qualifications: [],
          profile: { headline: '=HYPERLINK("https://evil.example.test","click")', summary: '+SUM(A1:A9)' },
          links: [{ label: null, url: 'https://code.example.test/two' }],
          resume: null,
        }),
      }),
      applicantExportRow({ state: 'INTERVIEW', submittedAt: '2026-09-04T00:00:00.000Z', snapshot: null, snapshotErased: false }),
    ];
    const { document, sha256 } = employerApplicantCsv(rows);
    // The repository stores text with LF (.gitattributes); the file ONE sends uses CRLF.
    const fixture = readFileSync(new URL('./employer-applicant-export.fixture.csv', import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n');
    expect(document).toBe(fixture);
    expect(document.startsWith('\uFEFF')).toBe(true);
    expect(document.split('\r\n')).toHaveLength(5);
    expect(document).toContain(`"'=HYPERLINK(""https://evil.example.test"",""click"")"`);
    expect(document).toContain(`"'+SUM(A1:A9)"`);
    expect(document).toContain(`"'@Synthetic Two"`);
    expect(sha256).toBe(createHash('sha256').update(Buffer.from(document, 'utf8')).digest('hex'));
  });
});

describe('employerExportFilename', () => {
  it('names the file after the job, in ASCII, and never carries an identifier', () => {
    expect(employerExportFilename('Graduate analyst — Chennai "2027"', '2026-09-30')).toBe('one-applicants-graduate-analyst-chennai-2027-2026-09-30.csv');
    expect(employerExportFilename(null, '2026-09-30')).toBe('one-applicants-job-2026-09-30.csv');
  });
});
