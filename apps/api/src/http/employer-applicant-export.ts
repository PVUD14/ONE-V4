/**
 * The employer applicant export's content rules (EMP-17), kept pure so they can be tested
 * without a database.
 *
 * It decides what one exported row holds: only what the student shared in their frozen EMP-07
 * snapshot, read through `employerSnapshotView`, so contact details appear only from SHORTLISTED
 * onward (decisions 10.2 #9 and #10). It also sets which header words may never appear
 * (readiness, scores, identifiers, compensation, protected attributes) and how the document and
 * its SHA-256 are produced. Cells are encoded by INST-08's writer, whose formula neutralising is
 * reused rather than copied. Design: docs/architecture/employer-applicant-exports-design.md.
 */
import { createHash } from 'node:crypto';
import { employerSnapshotView } from '@planthepath/hiring/src/application-snapshot.js';
import { csvDocument, type CsvValue } from './institution-export-csv.js';

/** Why an owner or admin takes applicants out of ONE. A fixed list keeps the audit queryable. */
export const employerExportReasonCodes = ['SHORTLIST_REVIEW', 'INTERVIEW_PLANNING', 'HIRING_COMMITTEE', 'OFFER_PREPARATION', 'RECORD_KEEPING'] as const;
export type EmployerExportReasonCode = typeof employerExportReasonCodes[number];

/** Which open applications to include. Closed ones never are: closing revokes the grant. */
export const employerExportScopes = {
  ALL_OPEN: ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED'],
  SHORTLISTED_ONWARD: ['SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED'],
} as const satisfies Record<string, readonly string[]>;
export type EmployerExportScope = keyof typeof employerExportScopes;

/** Rows per file; a larger result is refused rather than cut short. */
export const employerExportMaxRows = 5_000;
/** Exports per person per employer in any 24 hours. */
export const employerExportDailyLimit = 20;
/** The audit action every successful export writes. */
export const employerExportAuditAction = 'employer.applicants.exported';

export const employerApplicantExportHeader = [
  'Candidate', 'Email', 'Phone', 'Contact details', 'College', 'Programme', 'Department', 'Expected graduation year',
  'Qualifications', 'Headline', 'Summary', 'Links', 'Résumé shared', 'Stage', 'Applied on', 'Snapshot',
] as const;

/**
 * Words no employer export header may contain: readiness in any form (§5.3), internal identifiers,
 * offer pay, and protected attributes or their proxies (§5.4). Matched as whole words on the
 * normalised header, so "Candidate" does not trip "id" and "Stage" does not trip "age".
 */
const forbiddenHeaderWords = [
  'readiness', 'band', 'score', 'scores', 'mastery', 'gap', 'fit', 'rank', 'ranking', 'percentile',
  'id', 'uuid', 'identifier', 'roll',
  'compensation', 'salary', 'ctc', 'pay',
  'gender', 'sex', 'religion', 'caste', 'age', 'birth', 'dob', 'disability', 'marital', 'photo', 'hometown', 'native', 'origin',
] as const;

export function isForbiddenEmployerExportHeader(header: string): boolean {
  const words = header.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => (forbiddenHeaderWords as readonly string[]).includes(word));
}

const stageLabels: Readonly<Record<string, string>> = {
  APPLIED: 'Applied', SCREENING: 'Screening', SHORTLISTED: 'Shortlisted', ASSESSMENT: 'Assessment',
  INTERVIEW: 'Interview', OFFER: 'Offer', HIRED: 'Hired',
};

/** What the export reads for one application: the stored snapshot and the application's own facts. */
export interface ApplicantExportSource {
  readonly state: string;
  readonly submittedAt: string | Date | null;
  readonly snapshot: unknown;
  readonly snapshotErased: boolean;
}

type SnapshotView = {
  readonly candidate: { readonly fullName: string | null; readonly email: string | null; readonly phone: string | null; readonly contactVisibleFrom: string | null };
  readonly education: { readonly institutionName: string | null; readonly programmeName: string | null; readonly departmentName: string | null; readonly expectedGraduationYear: number | null } | null;
  readonly qualifications: readonly { readonly qualificationType: string; readonly programmeName: string; readonly institutionName: string | null;
    readonly startedYear: number | null; readonly completedYear: number | null; readonly awarded: boolean; readonly verification: string }[];
  readonly profile: { readonly headline: string | null; readonly summary: string | null };
  readonly links: readonly { readonly label: string | null; readonly url: string }[];
  readonly resume: unknown;
};

/** One row, in header order. Without a readable snapshot, only the stage and date are written. */
export function applicantExportRow(source: ApplicantExportSource): CsvValue[] {
  const view = source.snapshotErased ? null : employerSnapshotView(source.snapshot, source.state) as SnapshotView | null;
  const stage = stageLabels[source.state] ?? source.state;
  const appliedOn = dayOf(source.submittedAt);
  if (!view) return [null, null, null, null, null, null, null, null, null, null, null, null, null, stage, appliedOn, 'Not captured'];
  const { candidate, education, profile } = view;
  return [
    candidate.fullName,
    candidate.email,
    candidate.phone,
    candidate.contactVisibleFrom ? 'Shown from Shortlisted' : 'Shown',
    education?.institutionName ?? null,
    education?.programmeName ?? null,
    education?.departmentName ?? null,
    education?.expectedGraduationYear ?? null,
    view.qualifications.map(qualificationText).join('; ') || null,
    profile.headline,
    profile.summary,
    view.links.map((link) => (link.label ? `${link.label}: ${link.url}` : link.url)).join('; ') || null,
    view.resume ? 'Yes' : 'No',
    stage,
    appliedOn,
    'Shared',
  ];
}

function qualificationText(q: SnapshotView['qualifications'][number]): string {
  const years = q.startedYear || q.completedYear ? `${q.startedYear ?? ''}–${q.completedYear ?? ''}` : null;
  const basis = q.verification === 'VERIFIED' ? 'verified by the college' : q.verification === 'PENDING_VERIFICATION' ? 'verification pending' : 'self-reported';
  return [`${q.qualificationType} ${q.programmeName}`, q.institutionName, years, q.awarded ? 'awarded' : null, basis].filter(Boolean).join(', ');
}

function dayOf(value: string | Date | null): string | null {
  if (value === null) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : new Date(text).toISOString().slice(0, 10);
}

/** The whole file and the SHA-256 of its exact UTF-8 bytes, which the audit row and the response both carry. */
export function employerApplicantCsv(rows: readonly (readonly CsvValue[])[], header: readonly string[] = employerApplicantExportHeader): { readonly document: string; readonly sha256: string } {
  if (header.some(isForbiddenEmployerExportHeader)) throw new Error('export header names a forbidden field');
  const document = csvDocument(header, rows);
  return { document, sha256: createHash('sha256').update(document, 'utf8').digest('hex') };
}

/** A filename built from the job title: ASCII only, no quotes, never an identifier. */
export function employerExportFilename(title: string | null, today: string): string {
  const slug = (title ?? '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 48);
  return `one-applicants-${slug || 'job'}-${today}.csv`;
}
