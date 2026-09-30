/**
 * A college's contract lifecycle (INST-18): the rules for its data-processing terms, its exit
 * export and its offboarding, as data and pure functions so the API's answer and error code come
 * from one place. Migration 0088's triggers repeat the state machine so a second writer cannot skip it.
 *
 * Design: docs/architecture/institution-contract-lifecycle-design.md
 */
import { institutionExportMaxRows } from './institution-exports.js';

/** Decision 10.2 #10: a departed college's records are deleted 90 days after its exit ends. 0088 CHECKs the same. */
export const institutionOffboardingRetentionDays = 90;

/** Rows per exit-export file: INST-08's per-file cap, so an exit never fails on size — it becomes more parts. */
export const institutionExitExportPartRows = institutionExportMaxRows;

export const institutionOffboardingStates = ['NOTICE', 'ENDED', 'CANCELLED', 'PURGED'] as const;
export type InstitutionOffboardingState = (typeof institutionOffboardingStates)[number];

/** Why each step is taken (§5.4: reason codes are defined in code, not free text). */
export const institutionOffboardingReasons = {
  NOTICE: ['CONTRACT_ENDED', 'COLLEGE_REQUESTED_EXIT', 'NON_RENEWAL'],
  END: ['NOTICE_PERIOD_COMPLETE', 'COLLEGE_CONFIRMED_EXIT'],
  CANCEL: ['COLLEGE_RENEWED', 'COLLEGE_WITHDREW_NOTICE', 'ENTERED_IN_ERROR'],
} as const;

/** Why a purge is requested; the approval binds it. */
export const institutionDataPurgeReasons = ['RETENTION_PERIOD_ENDED'] as const;

export type InstitutionOffboardingStep = 'END' | 'CANCEL' | 'PURGE';

export type InstitutionOffboardingRefusal =
  | 'OFFBOARDING_NOT_IN_NOTICE'
  | 'OFFBOARDING_NOT_OPEN'
  | 'OFFBOARDING_RETENTION_ENDED'
  | 'OFFBOARDING_NOT_ENDED'
  | 'OFFBOARDING_RETENTION_RUNNING';

/**
 * Which step an exit in `state` may take now. `retentionElapsed` is the database clock's answer to
 * `now() >= retention_ends_at` (false while there is no retention clock yet).
 */
export function refuseInstitutionOffboardingStep(state: InstitutionOffboardingState, step: InstitutionOffboardingStep, retentionElapsed: boolean): InstitutionOffboardingRefusal | null {
  switch (step) {
    case 'END':
      return state === 'NOTICE' ? null : 'OFFBOARDING_NOT_IN_NOTICE';
    case 'CANCEL':
      if (state !== 'NOTICE' && state !== 'ENDED') return 'OFFBOARDING_NOT_OPEN';
      return state === 'ENDED' && retentionElapsed ? 'OFFBOARDING_RETENTION_ENDED' : null;
    case 'PURGE':
      if (state !== 'ENDED') return 'OFFBOARDING_NOT_ENDED';
      return retentionElapsed ? null : 'OFFBOARDING_RETENTION_RUNNING';
  }
}

/** The exit export's files, in the order the owner is shown them. Counselling notes are separate and restricted. */
export const institutionExitExportSections = [
  'units', 'roster', 'staff', 'teaching-assignments', 'assessments', 'assessment-results', 'staff-actions', 'verification-decisions',
] as const;
export type InstitutionExitExportSection = (typeof institutionExitExportSections)[number] | 'counselling-notes';

export function isInstitutionExitExportSection(value: unknown): value is InstitutionExitExportSection {
  return value === 'counselling-notes' || (typeof value === 'string' && (institutionExitExportSections as readonly string[]).includes(value));
}

/** Why an owner releases restricted counselling notes in the exit export (INST-11). Nothing else is accepted. */
export const institutionExitCounsellingReasons = ['STUDENT_WELFARE_CONTINUITY', 'LEGAL_OBLIGATION', 'REGULATOR_REQUEST', 'COLLEGE_RECORDS_POLICY'] as const;

/** Why the owner takes the exit export (§5.4). */
export const institutionExitExportReasons = ['COLLEGE_EXIT_RECORDS', 'ACCREDITATION_ARCHIVE', 'LEGAL_RETENTION'] as const;

/** The audit action for one exit-export file; matches INST-08's `institution.%.exported`, so both share one daily allowance. */
export function institutionExitExportAuditAction(section: InstitutionExitExportSection): string {
  return section === 'counselling-notes'
    ? 'institution.exit_export.counselling_notes.exported'
    : `institution.exit_export.${section.replaceAll('-', '_')}.exported`;
}

/** How many files a section of `rows` rows needs (at least one, so an empty section still downloads its header). */
export function institutionExitExportParts(rows: number): number {
  return Math.max(1, Math.ceil(Math.max(0, rows) / institutionExitExportPartRows));
}

/**
 * What the exit export never contains, in the words the owner is shown. Every item is the student's,
 * or an employer's jointly with the student (design: "What belongs to whom").
 */
export const institutionExitExportExclusions = [
  'Students’ own learning activity, readiness and practice',
  'Students’ applications, offers and anything employers hold — and never offer pay',
  'Students’ messages, documents, consents and self-reported outcomes',
  'Counselling notes, unless the owner asks for them with a reason',
] as const;

const exitNoticeDate = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The in-app notice a student receives when their college leaves ONE. It says what happened and
 * what the student keeps. It is deliberately not INST-10's "the college recorded you as no longer
 * enrolled … you can still ask it to verify past results": the college recorded nothing, and it can
 * no longer verify anything on ONE. Plain words, no identifiers, the date in India time.
 */
export function institutionExitNotice(input: { readonly institutionName: string; readonly endedAt: Date }): { readonly title: string; readonly body: string } {
  const college = input.institutionName.trim() || 'Your college';
  const date = exitNoticeDate.format(input.endedAt);
  return {
    title: `${college} has stopped using ONE`.slice(0, 160),
    body: [
      `From ${date}, ${college} no longer uses ONE, so your link with it on ONE has ended.`,
      'Your ONE account, your records and your choices stay yours, and results it verified stay verified.',
      `${college} no longer sees anything about you on ONE.`,
    ].join(' ').slice(0, 500),
  };
}

/** The notice when an exit is cancelled and the student's link with the college is restored. */
export function institutionReturnNotice(input: { readonly institutionName: string }): { readonly title: string; readonly body: string } {
  const college = input.institutionName.trim() || 'Your college';
  return {
    title: `${college} is using ONE again`.slice(0, 160),
    body: [
      `${college} has continued with ONE, so your link with it is back as it was.`,
      `${college} sees what it saw before, under the same choices you have made.`,
    ].join(' ').slice(0, 500),
  };
}
