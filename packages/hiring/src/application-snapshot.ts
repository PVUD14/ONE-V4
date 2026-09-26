/**
 * The consented application snapshot (EMP-07, spec §115).
 *
 * What a student shares with one employer when they apply, built once from their own records,
 * reviewed by them, frozen and hashed. The API reads the records and stores the row; this module
 * decides the content, so what is included — and, more importantly, what never is — lives in one
 * pure, unit-tested place. Design: docs/architecture/application-snapshots-table-design.md.
 *
 * Never in a snapshot: readiness in any form (bands, scores, gap statuses, mastery, career targets
 * or interests, which feed readiness), academic figures (EMP-06 shows employers outcomes and basis
 * only), assessment results, the profile photo (a protected-attribute proxy), roll numbers or any
 * internal identifier. The content carries no timestamps, so the preview's hash equals the stored
 * hash when nothing changed in between.
 */
import { createHash } from 'node:crypto';

export const APPLICATION_SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_MAX_LINKS = 5;

/** States from which an employer may see the candidate's contact details (decisions 10.2 #9, #10). */
export const CONTACT_VISIBLE_STATES: readonly string[] = ['SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED'];

export interface SnapshotRosterSource {
  readonly fullName: string | null;
  readonly institutionName: string | null;
  readonly programmeName: string | null;
  readonly departmentName: string | null;
  readonly expectedGraduationDate: string | null;
}

export interface SnapshotQualificationSource {
  readonly qualificationType: string;
  readonly programmeName: string;
  readonly institutionName: string | null;
  readonly startedOn: string | null;
  readonly completedOn: string | null;
  readonly awarded: boolean;
  readonly verificationState: string;
}

export interface SnapshotResumeSource {
  readonly title: string;
  readonly filename: string;
  readonly versionNumber: number;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface SnapshotSources {
  readonly email: string;
  readonly roster: SnapshotRosterSource | null;
  readonly qualifications: readonly SnapshotQualificationSource[];
  readonly profile: { readonly headline: string | null; readonly summary: string | null } | null;
  readonly resume: SnapshotResumeSource | null;
}

export interface SnapshotLink { readonly label: string | null; readonly url: string }

/** What the student chose for this application, validated. */
export interface SnapshotChoices {
  readonly phone: string | null;
  readonly links: readonly SnapshotLink[];
}

export interface ApplicationSnapshotV1 {
  readonly schemaVersion: 1;
  readonly candidate: { readonly fullName: string | null; readonly email: string; readonly phone: string | null };
  readonly education: {
    readonly institutionName: string | null;
    readonly programmeName: string | null;
    readonly departmentName: string | null;
    readonly expectedGraduationYear: number | null;
  };
  readonly qualifications: readonly {
    readonly qualificationType: string;
    readonly programmeName: string;
    readonly institutionName: string | null;
    readonly startedYear: number | null;
    readonly completedYear: number | null;
    readonly awarded: boolean;
    readonly verification: string;
  }[];
  readonly profile: { readonly headline: string | null; readonly summary: string | null };
  readonly links: readonly SnapshotLink[];
  readonly resume: SnapshotResumeSource | null;
}

export class SnapshotInputError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SnapshotInputError'; }
}

const phonePattern = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;
const dangerousPrefix = /^[=+@-]/;

/** Validates the student's per-application choices: an optional phone and up to five https links. */
export function readSnapshotChoices(record: Record<string, unknown>): SnapshotChoices {
  let phone: string | null = null;
  if (record.contactPhone !== undefined && record.contactPhone !== null && record.contactPhone !== '') {
    if (typeof record.contactPhone !== 'string') throw new SnapshotInputError('INVALID_CONTACT_PHONE');
    const trimmed = record.contactPhone.trim();
    if (!phonePattern.test(trimmed) || (trimmed.match(/[0-9]/g) ?? []).length < 7) throw new SnapshotInputError('INVALID_CONTACT_PHONE');
    phone = trimmed;
  }
  const links: SnapshotLink[] = [];
  if (record.links !== undefined && record.links !== null) {
    if (!Array.isArray(record.links) || record.links.length > SNAPSHOT_MAX_LINKS) throw new SnapshotInputError('INVALID_LINKS');
    for (const entry of record.links) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new SnapshotInputError('INVALID_LINKS');
      const link = entry as Record<string, unknown>;
      if (Object.keys(link).some((key) => key !== 'url' && key !== 'label')) throw new SnapshotInputError('INVALID_LINKS');
      if (typeof link.url !== 'string') throw new SnapshotInputError('INVALID_LINKS');
      const url = link.url.trim();
      if (url.length > 256 || !/^https:\/\/[^\s]+$/i.test(url)) throw new SnapshotInputError('INVALID_LINK_URL');
      try { if (new URL(url).protocol !== 'https:') throw new Error('protocol'); } catch { throw new SnapshotInputError('INVALID_LINK_URL'); }
      let label: string | null = null;
      if (link.label !== undefined && link.label !== null && link.label !== '') {
        if (typeof link.label !== 'string') throw new SnapshotInputError('INVALID_LINKS');
        const trimmed = link.label.trim();
        if (trimmed.length < 1 || trimmed.length > 60 || dangerousPrefix.test(trimmed)) throw new SnapshotInputError('INVALID_LINK_LABEL');
        label = trimmed;
      }
      if (links.some((existing) => existing.url === url)) throw new SnapshotInputError('INVALID_LINKS');
      links.push({ label, url });
    }
  }
  return { phone, links };
}

/** Locale-independent, so the same records always hash the same on every server. */
function byCodePoint(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function yearOf(date: string | null): number | null {
  if (!date) return null;
  const match = /^(\d{4})-\d{2}-\d{2}/.exec(date);
  return match ? Number(match[1]) : null;
}

/** Builds the snapshot a student reviews and ONE stores. Deterministic: same inputs, same content. */
export function buildApplicationSnapshot(sources: SnapshotSources, choices: SnapshotChoices): ApplicationSnapshotV1 {
  const qualifications = sources.qualifications
    .map((q) => ({
      qualificationType: q.qualificationType,
      programmeName: q.programmeName,
      institutionName: q.institutionName,
      startedYear: yearOf(q.startedOn),
      completedYear: yearOf(q.completedOn),
      awarded: q.awarded,
      verification: q.verificationState,
    }))
    .sort((a, b) => (b.startedYear ?? 0) - (a.startedYear ?? 0) || byCodePoint(a.programmeName, b.programmeName) || byCodePoint(a.qualificationType, b.qualificationType));
  return {
    schemaVersion: APPLICATION_SNAPSHOT_SCHEMA_VERSION,
    candidate: { fullName: sources.roster?.fullName ?? null, email: sources.email, phone: choices.phone },
    education: {
      institutionName: sources.roster?.institutionName ?? null,
      programmeName: sources.roster?.programmeName ?? null,
      departmentName: sources.roster?.departmentName ?? null,
      expectedGraduationYear: yearOf(sources.roster?.expectedGraduationDate ?? null),
    },
    qualifications,
    profile: { headline: sources.profile?.headline ?? null, summary: sources.profile?.summary ?? null },
    links: choices.links.map((link) => ({ label: link.label, url: link.url })),
    resume: sources.resume ? { ...sources.resume } : null,
  };
}

/** JSON with object keys sorted at every level, so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function snapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/** What remains of a snapshot after the student's account is deleted. */
export const ERASED_SNAPSHOT = { schemaVersion: APPLICATION_SNAPSHOT_SCHEMA_VERSION, erased: true } as const;

/**
 * The employer's view of a stored snapshot. Contact details only from SHORTLISTED onward (decisions
 * 10.2 #9 and #10): the email, and the phone only because the student chose to add it. An erased
 * snapshot shows nothing.
 */
export function employerSnapshotView(stored: unknown, applicationState: string): Record<string, unknown> | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const snapshot = stored as Partial<ApplicationSnapshotV1> & { erased?: boolean };
  if (snapshot.erased || snapshot.schemaVersion !== 1 || !snapshot.candidate) return null;
  const contactVisible = CONTACT_VISIBLE_STATES.includes(applicationState);
  return {
    schemaVersion: 1,
    candidate: {
      fullName: snapshot.candidate.fullName ?? null,
      email: contactVisible ? snapshot.candidate.email ?? null : null,
      phone: contactVisible ? snapshot.candidate.phone ?? null : null,
      contactVisibleFrom: contactVisible ? null : 'SHORTLISTED',
    },
    education: snapshot.education ?? null,
    qualifications: snapshot.qualifications ?? [],
    profile: snapshot.profile ?? { headline: null, summary: null },
    links: snapshot.links ?? [],
    resume: snapshot.resume ?? null,
  };
}
