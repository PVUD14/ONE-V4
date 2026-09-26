/**
 * Who may export institution data, and over which students (INST-08).
 *
 * Exports are the riskiest institution read: the file leaves the platform and can be compared
 * with the next one. Design: docs/architecture/institution-exports-design.md. Three rules live
 * here so the controller cannot drift from them:
 *
 *   1. The INSTITUTION_ANALYTICS grant is necessary and never sufficient — each membership is
 *      decided by `canReadInstitutionAnalytics` (ADR-018), so a grant on a role outside the
 *      capable set, a suspended membership or another institution's membership admits nothing.
 *   2. Scope comes from the memberships that hold the grant, never from the caller's other
 *      memberships (0031: "Scope always comes from the membership, never from the grant").
 *   3. The scope is the write scope (INST-SR-02), not the read scope: a department head with
 *      no department on their membership exports nobody, rather than the whole college.
 */
import { canReadInstitutionAnalytics } from './index.js';
import {
  institutionStudentWriteScope,
  type InstitutionStaffScopeMembership,
  type InstitutionStudentScope,
  type InstitutionUnitNode,
} from './institution-scope.js';

export const institutionExportKinds = ['ROSTER', 'READINESS_BANDS', 'ASSESSMENT_RESULTS', 'STAFF_ACTION_SUMMARY'] as const;
export type InstitutionExportKind = (typeof institutionExportKinds)[number];

/** The audit action for each export (Appendix 3 §5.3: "audited as *.exported"). */
export const institutionExportAuditActions: Readonly<Record<InstitutionExportKind, string>> = {
  ROSTER: 'institution.roster.exported',
  READINESS_BANDS: 'institution.readiness_bands.exported',
  ASSESSMENT_RESULTS: 'institution.assessment_results.exported',
  STAFF_ACTION_SUMMARY: 'institution.staff_action_summary.exported',
};

/** At most this many data rows leave in one file; larger exports are refused, not truncated. */
export const institutionExportMaxRows = 10_000;
/** At most this many exports per person per institution in any 24 hours. */
export const institutionExportDailyLimit = 30;

export interface InstitutionExportCandidateMembership extends InstitutionStaffScopeMembership {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly state: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'ENDED';
  /** The live INSTITUTION_ANALYTICS grant on this membership, or null. */
  readonly analyticsGrantId: string | null;
}

/** The memberships that authorise an export for `institutionId`, by ADR-018's predicate. */
export function institutionExportMemberships<M extends InstitutionExportCandidateMembership>(
  memberships: readonly M[],
  institutionId: string,
): readonly M[] {
  return memberships.filter((membership) => canReadInstitutionAnalytics({
    institutionId: membership.organizationId,
    requestedInstitutionId: institutionId,
    role: membership.role,
    membershipState: membership.state,
    analyticsCapabilityGranted: membership.analyticsGrantId !== null,
  }));
}

/**
 * The students an export covers: the write scope over the authorising memberships only.
 * NONE for a caller with an authorising membership means "a department must be set on your
 * membership first" (SCOPE_REQUIRED), not "no such student".
 */
export function institutionExportScope(
  exporters: readonly InstitutionExportCandidateMembership[],
  units: readonly InstitutionUnitNode[],
): InstitutionStudentScope {
  if (exporters.length === 0) return { kind: 'NONE' };
  return institutionStudentWriteScope(exporters, units);
}
