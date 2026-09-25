/**
 * ONE · API client — Stream C — Institution
 *
 * Academic structure, the student roster, staff invitations and roster import.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { requestJson } from './http.js';

export interface InstitutionUnitDto {
  readonly id: string; readonly institutionId: string; readonly kind: string; readonly name: string; readonly parentUnitId?: string | null;
}

/** A staff member's department/batch scope (INST-03). Both null: the whole institution. */
export interface StaffUnitScopeDto {
  readonly departmentUnitId: string | null;
  readonly batchUnitId: string | null;
}

export interface InstitutionStaffDto {
  readonly invitations: readonly {
    readonly id: string; readonly email: string; readonly role: string; readonly state: string;
    readonly scope?: StaffUnitScopeDto;
    readonly createdAt: string; readonly expiresAt: string; readonly acceptedAt?: string | null; readonly revokedAt?: string | null;
    readonly delivery?: { readonly commandId: string; readonly state: string; readonly providerKind?: string | null; readonly providerReference?: string | null; readonly outcome?: string | null } | null;
  }[];
  readonly memberships: readonly {
    readonly id: string; readonly userId: string; readonly email: string; readonly role: string; readonly state: string; readonly createdAt: string; readonly updatedAt: string;
    readonly scope?: StaffUnitScopeDto;
  }[];
  readonly unavailableActions: readonly string[];
}

export interface InstitutionStudentDto {
  readonly id: string; readonly institutionId: string; readonly institutionStudentId: string; readonly fullName: string; readonly email: string; readonly status: string;
  readonly relationship?: { readonly id: string; readonly state: string; readonly effectiveFrom: string; readonly effectiveTo?: string | null } | null;
  readonly units?: Record<string, string | null | undefined>;
  readonly studentUserId?: string;
  readonly activation?: InstitutionStudentActivationDto | null;
}

export type StudentActivationState = 'ACTIVATED' | 'INVITED' | 'EXPIRED' | 'BOUNCED' | 'NOT_INVITED';

/** Whether a rostered student has accepted their invitation (INST-01). */
export interface InstitutionStudentActivationDto {
  readonly state: StudentActivationState;
  readonly deliveryState: string | null;
  readonly invitedAt: string | null;
  readonly expiresAt: string | null;
  readonly lastSentAt: string | null;
}

export const studentActivationLabels: Readonly<Record<StudentActivationState, string>> = {
  ACTIVATED: 'Activated', INVITED: 'Invited', EXPIRED: 'Expired', BOUNCED: 'Bounced', NOT_INVITED: 'Not invited',
};

/** A plain reason for a delivery that has not happened, or null when nothing needs saying. */
export function studentInvitationDeliveryNote(activation: InstitutionStudentActivationDto | null | undefined): string | null {
  if (!activation || activation.state !== 'INVITED') return null;
  if (activation.deliveryState === 'NOT_CONFIGURED') return 'Email not sent: no sender is set up yet';
  if (activation.deliveryState === 'NOT_SENT') return 'Queued to send';
  if (activation.deliveryState === 'FAILED') return 'Sending failed; will retry';
  return null;
}

export function resendStudentInvitations(token: string, institutionId: string, body: { readonly reasonCode: string; readonly studentUserIds?: readonly string[]; readonly all?: true }): Promise<{ readonly resend: { readonly queued: number; readonly skipped: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-invitations/resend`, { token, method: 'POST', body });
}

export interface InstitutionStudentCreateRequest {
  readonly institutionStudentId: string;
  readonly fullName: string;
  readonly email: string;
  readonly departmentUnitId?: string;
  readonly programUnitId?: string | null;
  readonly batchUnitId?: string | null;
  readonly sectionUnitId?: string | null;
  readonly academicStartDate?: string;
  readonly expectedGraduationDate?: string;
}

export interface InstitutionStudentUpdateRequest {
  readonly fullName?: string;
  readonly departmentUnitId?: string | null;
  readonly programUnitId?: string | null;
  readonly batchUnitId?: string | null;
  readonly sectionUnitId?: string | null;
  readonly academicStartDate?: string | null;
  readonly expectedGraduationDate?: string | null;
}

export interface InstitutionUnitCreateRequest {
  readonly kind: string;
  readonly name: string;
  readonly parentUnitId?: string;
}

export interface InstitutionUnitUpdateRequest {
  readonly name: string;
}

export interface InstitutionStaffInvitationRequest {
  readonly email: string;
  readonly role: string;
  readonly departmentUnitId?: string;
  readonly batchUnitId?: string;
}

export interface RosterImportPreviewDto {
  readonly id: string; readonly rowCount: number; readonly acceptedCount: number; readonly warningCount: number; readonly rejectedCount: number;
  readonly rows: readonly { readonly rowNumber: number; readonly institutionStudentId: string; readonly fullName: string; readonly email: string; readonly state: string; readonly issues: readonly string[]; readonly departmentUnitId?: string | null; readonly programUnitId?: string | null; readonly batchUnitId?: string | null; readonly sectionUnitId?: string | null }[];
}

export function listInstitutionUnits(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly units: readonly InstitutionUnitDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units`, { token, ...(signal ? { signal } : {}) });
}

export function createInstitutionUnit(token: string, institutionId: string, body: InstitutionUnitCreateRequest): Promise<{ readonly unit: InstitutionUnitDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units`, { token, method: 'POST', body });
}

export function updateInstitutionUnit(token: string, institutionId: string, unitId: string, body: InstitutionUnitUpdateRequest): Promise<{ readonly unit: InstitutionUnitDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/units/${encodeURIComponent(unitId)}`, { token, method: 'PATCH', body });
}

export function listInstitutionStaff(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly staff: InstitutionStaffDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/staff-role-assignments`, { token, ...(signal ? { signal } : {}) });
}

/** Whose students a roster response covers. UNITS names the units the reader is scoped to. */
export interface InstitutionStudentScopeDto {
  readonly kind: 'INSTITUTION' | 'UNITS' | 'NONE';
  readonly units: readonly { readonly id: string; readonly kind: string; readonly name: string }[];
}

/** "Department of Mechanical Engineering · Batch 2027" for a scoped reader; null when the whole institution is shown. */
export function institutionStudentScopeLabel(scope: InstitutionStudentScopeDto | undefined): string | null {
  if (!scope || scope.kind !== 'UNITS' || scope.units.length === 0) return null;
  return scope.units.map((unit) => unit.name).join(' · ');
}

export function listInstitutionStudents(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly students: readonly InstitutionStudentDto[]; readonly scope?: InstitutionStudentScopeDto; readonly activationSummary?: Readonly<Record<StudentActivationState, number>> }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students`, { token, ...(signal ? { signal } : {}) });
}

export function addInstitutionStudent(token: string, institutionId: string, body: InstitutionStudentCreateRequest): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students`, { token, method: 'POST', body });
}

export function updateInstitutionStudent(token: string, institutionId: string, studentProfileId: string, body: InstitutionStudentUpdateRequest): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students/${encodeURIComponent(studentProfileId)}`, { token, method: 'PATCH', body });
}

export function endInstitutionStudentRelationship(token: string, institutionId: string, studentProfileId: string, state: string, effectiveTo?: string): Promise<{ readonly student: InstitutionStudentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/students/${encodeURIComponent(studentProfileId)}/relationship`, { token, method: 'POST', body: { state, ...(effectiveTo ? { effectiveTo } : {}) } });
}

export function inviteInstitutionStaff(token: string, institutionId: string, email: string, role: string, scope: Partial<StaffUnitScopeDto> = {}): Promise<Record<string, unknown>> {
  const body: InstitutionStaffInvitationRequest = {
    email, role,
    ...(scope.departmentUnitId ? { departmentUnitId: scope.departmentUnitId } : {}),
    ...(scope.batchUnitId ? { batchUnitId: scope.batchUnitId } : {}),
  };
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/staff-role-assignments`, { token, method: 'POST', body });
}

export function previewStudentRosterImport(token: string, institutionId: string, filename: string, csv: string): Promise<{ readonly import: RosterImportPreviewDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-imports`, { token, method: 'POST', body: { filename, csv } });
}

export function commitStudentRosterImport(token: string, institutionId: string, importId: string): Promise<{ readonly import: { readonly id: string; readonly committedCount: number } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/student-imports/${encodeURIComponent(importId)}/commit`, { token, method: 'POST' });
}

// --- Hiring: opportunities, applications, interviews, offers -----------------

// --- Academic verification ----------------------------------------------------

export interface VerificationQueueEntryDto {
  readonly termId: string;
  readonly label: string;
  readonly sequence: number;
  readonly resultValue: string | null;
  readonly resultScale: string | null;
  readonly resultLetter: string | null;
  readonly backlogCount: number | null;
  readonly source: string;
  readonly qualificationId: string;
  readonly programmeName: string;
  readonly qualificationType: string;
  readonly claimedStartedOn: string | null;
  readonly claimedCompletedOn: string | null;
  readonly studentUserId: string;
  readonly studentEmail: string;
  /** Null when this institution has no roster record of the person — ONE holds no name of its own. */
  readonly studentName: string | null;
  readonly institutionStudentId: string | null;
  /** CURRENT and FORMER can be checked on the roster; NONE needs the archive. */
  readonly relationship: 'CURRENT' | 'FORMER' | 'NONE';
  /** ADR-027 metadata only: never a filename or a link. `shared` stays false until per-version consent exists. */
  readonly evidence?: { readonly title: string; readonly documentType: string; readonly versionNumber: number; readonly shared: boolean } | null;
  /** A different value this institution has already verified for the same term (a conflict left in place). */
  readonly institutionRecord?: { readonly resultValue: number | null; readonly resultScale: string | null; readonly resultLetter: string | null; readonly backlogCount: number | null } | null;
}

export interface VerificationQueuePage { readonly queue: readonly VerificationQueueEntryDto[]; readonly nextCursor?: string | null }

export function listVerificationQueue(token: string, institutionId: string, signal?: AbortSignal, after?: string | null): Promise<VerificationQueuePage> {
  const query = after ? `?after=${encodeURIComponent(after)}` : '';
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/academic-verification-queue${query}`, { token, ...(signal ? { signal } : {}) });
}

/** Every decision carries a reason code (plan Section 5.4); the server refuses one without. */
export function decideVerification(token: string, institutionId: string, termId: string, decision: 'VERIFIED' | 'REJECTED', reasonCode: string): Promise<VerificationQueuePage> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/academic-verification/${encodeURIComponent(termId)}/decide`, { token, method: 'POST', body: { decision, reasonCode } });
}

export interface VerificationSummaryDto { readonly pending: number; readonly notCurrent: number }

export function getVerificationSummary(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly summary: VerificationSummaryDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/academic-verification-summary`, { token, ...(signal ? { signal } : {}) });
}

// --- Bulk academic results upload (INST-04) -------------------------------------

export type ResultsImportOutcome = 'CREATE' | 'CONFIRM' | 'UNCHANGED' | 'CONFLICT' | 'INVALID';

export interface RecordedResultDto {
  readonly resultValue: string | null; readonly resultScale: string | null; readonly resultLetter: string | null;
  readonly backlogCount: number | null; readonly verificationState: string;
}

export interface ResultsImportRowDto {
  readonly rowNumber: number; readonly institutionStudentId: string; readonly studentName: string | null;
  readonly termSequence: number | null; readonly termLabel: string; readonly scale: string; readonly result: string;
  readonly backlogs: number | null; readonly outcome: ResultsImportOutcome; readonly issues: readonly string[];
  readonly studentReported: RecordedResultDto | null; readonly verifiedRecord: RecordedResultDto | null;
}

export interface ResultsImportPreviewDto {
  readonly digest: string; readonly rowCount: number;
  readonly counts: { readonly create: number; readonly confirm: number; readonly unchanged: number; readonly conflict: number; readonly invalid: number; readonly differsFromStudent: number };
  readonly rows: readonly ResultsImportRowDto[];
}

export function previewAcademicResults(token: string, institutionId: string, filename: string, csv: string): Promise<{ readonly preview: ResultsImportPreviewDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/academic-results-imports/preview`, { token, method: 'POST', body: { filename, csv } });
}

export function commitAcademicResults(token: string, institutionId: string, input: { readonly filename: string; readonly csv: string; readonly previewDigest: string; readonly reasonCode: string }): Promise<{ readonly import: { readonly reference: string; readonly created: number; readonly confirmed: number; readonly counts: ResultsImportPreviewDto['counts']; readonly rows: readonly ResultsImportRowDto[] } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/academic-results-imports/commit`, { token, method: 'POST', body: input });
}

// --- Teaching assignments and My Students (INST-03) ---------------------------

export interface TeachingAssignmentDto {
  readonly id: string;
  readonly facultyMembershipId: string;
  readonly facultyEmail: string;
  readonly unit: { readonly id: string; readonly kind: string; readonly name: string };
  readonly subject: { readonly id: string; readonly name: string; readonly code: string | null } | null;
  readonly subjectCode: string | null;
  readonly academicTerm: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly state: 'ACTIVE' | 'ENDED';
  /** ACTIVE and inside its start/end dates today, so it currently grants access. */
  readonly active: boolean;
  readonly reasonCode: string;
}

export interface TeachingAssignmentListDto {
  readonly assignments: readonly TeachingAssignmentDto[];
  readonly nextCursor: string | null;
  readonly canAssign: boolean;
  readonly faculty: readonly { readonly membershipId: string; readonly email: string }[];
  readonly units: readonly { readonly id: string; readonly kind: string; readonly name: string; readonly parentUnitId?: string | null }[];
  readonly subjects: readonly { readonly id: string; readonly name: string; readonly code: string | null }[];
}

export interface TeachingAssignmentCreateRequest {
  readonly facultyMembershipId: string;
  readonly unitId: string;
  readonly subjectId?: string;
  readonly subjectCode?: string;
  readonly academicTerm: string;
  readonly startsOn?: string;
  readonly endsOn?: string;
  readonly reasonCode: string;
}

export interface MyStudentDto {
  readonly profileId: string;
  readonly studentUserId: string;
  readonly fullName: string;
  readonly institutionStudentId: string;
  readonly units: { readonly section: string | null; readonly batch: string | null };
  readonly activation: InstitutionStudentActivationDto | null;
  readonly openTasks: number;
  readonly recentAssessments: { readonly submitted: number; readonly latestTitle: string | null; readonly latestSubmittedAt: string | null };
}

export interface MyStudentsDto {
  /** ASSIGNMENTS: scope comes from teaching assignments. MEMBERSHIP: the institution has not started assigning yet. */
  readonly mode: 'ASSIGNMENTS' | 'MEMBERSHIP';
  readonly assignments: readonly TeachingAssignmentDto[];
  readonly students: readonly MyStudentDto[];
  readonly nextCursor: string | null;
  readonly scope?: InstitutionStudentScopeDto;
}

export function listTeachingAssignments(token: string, institutionId: string, signal?: AbortSignal): Promise<TeachingAssignmentListDto> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/teaching-assignments?limit=200`, { token, ...(signal ? { signal } : {}) });
}

export function createTeachingAssignment(token: string, institutionId: string, body: TeachingAssignmentCreateRequest): Promise<{ readonly assignment: TeachingAssignmentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/teaching-assignments`, { token, method: 'POST', body });
}

export function endTeachingAssignment(token: string, institutionId: string, assignmentId: string, reasonCode: string): Promise<{ readonly assignment: TeachingAssignmentDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/teaching-assignments/${encodeURIComponent(assignmentId)}/end`, { token, method: 'POST', body: { reasonCode } });
}

export function listMyStudents(token: string, institutionId: string, cursor?: string | null, signal?: AbortSignal): Promise<MyStudentsDto> {
  const query = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : '?limit=200';
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/my-students${query}`, { token, ...(signal ? { signal } : {}) });
}

export function setInstitutionStaffScope(token: string, institutionId: string, membershipId: string, body: StaffUnitScopeDto & { readonly reasonCode: string }): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/staff-memberships/${encodeURIComponent(membershipId)}/scope`, { token, method: 'POST', body });
}
