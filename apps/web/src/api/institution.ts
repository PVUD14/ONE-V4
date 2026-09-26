/**
 * ONE · API client — Stream C — Institution
 *
 * Academic structure, the student roster, staff invitations and roster import.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';
import { requestJson } from './http.js';
import type { SuppressedCountDto } from './privacyOperations.js';

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

/** INST-10: year-end batch actions — graduate, transfer or end a unit or a list of roll numbers. */
export type RelationshipBatchState = 'GRADUATED' | 'TRANSFERRED' | 'ENDED';

export interface RelationshipBatchRequest {
  readonly state: RelationshipBatchState;
  readonly unitId?: string;
  readonly institutionStudentIds?: readonly string[];
  readonly effectiveTo?: string;
}

export interface RelationshipBatchRowDto {
  readonly institutionStudentId: string;
  readonly fullName: string | null;
  readonly currentState: string | null;
  readonly outcome: 'CHANGE' | 'UNCHANGED' | 'INVALID';
  readonly issues: readonly string[];
}

export interface RelationshipBatchPreviewDto {
  readonly state: RelationshipBatchState;
  readonly effectiveTo: string | null;
  readonly counts: { readonly change: number; readonly unchanged: number; readonly invalid: number };
  readonly digest: string;
  readonly rows: readonly RelationshipBatchRowDto[];
}

export function previewRelationshipBatch(token: string, institutionId: string, request: RelationshipBatchRequest): Promise<{ readonly batch: RelationshipBatchPreviewDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/relationship-batches/preview`, { token, method: 'POST', body: request });
}

export function commitRelationshipBatch(token: string, institutionId: string, request: RelationshipBatchRequest & { readonly previewDigest: string; readonly reasonCode: string }): Promise<{ readonly batch: RelationshipBatchPreviewDto & { readonly changed: number; readonly effectiveTo: string } }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/relationship-batches/commit`, { token, method: 'POST', body: request });
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

// --- College settings, grading scales, academic calendar, staff profile (INST-05) ---

export type InstitutionResultScale = 'CGPA_10' | 'GPA_4' | 'PERCENTAGE' | 'LETTER' | 'PASS_FAIL';

export const institutionResultScaleLabels: Readonly<Record<InstitutionResultScale, string>> = {
  CGPA_10: 'CGPA out of 10', GPA_4: 'GPA out of 4', PERCENTAGE: 'Percentage', LETTER: 'Letter grades', PASS_FAIL: 'Pass / fail',
};

export interface ProgrammeGradingScaleDto {
  readonly programUnitId: string;
  readonly scale: InstitutionResultScale;
  /** Null: the college has not given one, or the scale has none. Shown as NA. */
  readonly passThreshold: number | null;
  readonly updatedAt: string;
}

export interface InstitutionSettingsDto {
  /** Verified by AI8HT operations; read-only from the college side. */
  readonly profile: {
    readonly legalName: string; readonly verificationState: string; readonly profileSetUp: boolean;
    readonly displayName: string | null; readonly websiteUrl: string | null; readonly countryCode: string | null;
    readonly stateOrProvince: string | null; readonly city: string | null; readonly postalCode: string | null;
    readonly addressLine1: string | null; readonly addressLine2: string | null; readonly primaryContactEmail: string | null;
    readonly institutionType: string | null;
  };
  readonly college: { readonly about: string | null; readonly placementContactEmail: string | null; readonly updatedAt: string | null };
  /** Every programme; gradingScale null means NA — no scale is ever guessed. */
  readonly programmes: readonly { readonly programUnitId: string; readonly programName: string; readonly parentName: string | null; readonly gradingScale: ProgrammeGradingScaleDto | null }[];
  readonly canEdit: boolean;
  readonly options: { readonly scales: readonly InstitutionResultScale[]; readonly numericScaleMaximum: Readonly<Partial<Record<InstitutionResultScale, number>>> };
}

export type AcademicTermKind = 'TERM' | 'EXAMINATIONS' | 'BREAK';

export const academicTermKindLabels: Readonly<Record<AcademicTermKind, string>> = { TERM: 'Term', EXAMINATIONS: 'Examinations', BREAK: 'Break' };

export interface AcademicTermDto {
  readonly id: string; readonly name: string; readonly kind: AcademicTermKind; readonly startsOn: string; readonly endsOn: string;
  readonly unit: { readonly id: string; readonly kind: string; readonly name: string } | null;
  readonly current: boolean; readonly archived: boolean; readonly archiveReasonCode: string | null; readonly updatedAt: string;
}

export interface AcademicTermListDto {
  readonly terms: readonly AcademicTermDto[];
  readonly nextCursor: string | null;
  readonly canEdit: boolean;
  readonly options: { readonly kinds: readonly AcademicTermKind[]; readonly units: readonly { readonly id: string; readonly kind: string; readonly name: string }[] };
}

export interface AcademicTermInput {
  readonly name?: string; readonly kind?: AcademicTermKind; readonly startsOn?: string; readonly endsOn?: string; readonly unitId?: string | null;
}

export interface NotificationPreferencesDto {
  readonly emailEnabled: boolean; readonly quietHoursStartMinute: number; readonly quietHoursEndMinute: number; readonly dailyCap: number;
}

export interface StaffProfileDto {
  readonly email: string;
  readonly institutionName: string;
  readonly roles: readonly { readonly role: string; readonly department: string | null; readonly batch: string | null }[];
  readonly teachingAssignments: readonly { readonly unit: string; readonly subject: string | null; readonly academicTerm: string }[];
  /** Null until the person saves; the defaults below then apply. */
  readonly notificationPreferences: NotificationPreferencesDto | null;
  readonly notificationDefaults: NotificationPreferencesDto;
  /** False while ONE sends institution staff no reminder emails. */
  readonly staffRemindersLive: boolean;
}

const institutionPath = (institutionId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}`;

export function getInstitutionSettings(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly settings: InstitutionSettingsDto }> {
  return requestJson(`${institutionPath(institutionId)}/settings`, { token, ...(signal ? { signal } : {}) });
}

export function updateInstitutionSettings(token: string, institutionId: string, body: { readonly about?: string | null; readonly placementContactEmail?: string | null }): Promise<{ readonly settings: InstitutionSettingsDto }> {
  return requestJson(`${institutionPath(institutionId)}/settings`, { token, method: 'POST', body });
}

export function setProgrammeGradingScale(token: string, institutionId: string, body: { readonly programUnitId: string; readonly scale: InstitutionResultScale; readonly passThreshold?: number | null }): Promise<{ readonly gradingScale: ProgrammeGradingScaleDto }> {
  return requestJson(`${institutionPath(institutionId)}/grading-scales`, { token, method: 'POST', body });
}

export function removeProgrammeGradingScale(token: string, institutionId: string, programUnitId: string, reasonCode: string): Promise<{ readonly gradingScale: null }> {
  return requestJson(`${institutionPath(institutionId)}/grading-scales/${encodeURIComponent(programUnitId)}/remove`, { token, method: 'POST', body: { reasonCode } });
}

export function listAcademicTerms(token: string, institutionId: string, signal?: AbortSignal): Promise<AcademicTermListDto> {
  return requestJson(`${institutionPath(institutionId)}/academic-terms?limit=200`, { token, ...(signal ? { signal } : {}) });
}

export function createAcademicTerm(token: string, institutionId: string, body: AcademicTermInput): Promise<{ readonly term: AcademicTermDto }> {
  return requestJson(`${institutionPath(institutionId)}/academic-terms`, { token, method: 'POST', body });
}

export function updateAcademicTerm(token: string, institutionId: string, termId: string, body: AcademicTermInput): Promise<{ readonly term: AcademicTermDto }> {
  return requestJson(`${institutionPath(institutionId)}/academic-terms/${encodeURIComponent(termId)}`, { token, method: 'PATCH', body });
}

export function archiveAcademicTerm(token: string, institutionId: string, termId: string, reasonCode: string): Promise<{ readonly term: AcademicTermDto }> {
  return requestJson(`${institutionPath(institutionId)}/academic-terms/${encodeURIComponent(termId)}/archive`, { token, method: 'POST', body: { reasonCode } });
}

export function getStaffProfile(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly staffProfile: StaffProfileDto }> {
  return requestJson(`${institutionPath(institutionId)}/staff-profile`, { token, ...(signal ? { signal } : {}) });
}

export function updateStaffNotificationPreferences(token: string, institutionId: string, body: Partial<NotificationPreferencesDto>): Promise<{ readonly staffProfile: StaffProfileDto }> {
  return requestJson(`${institutionPath(institutionId)}/staff-profile/notification-preferences`, { token, method: 'POST', body });
}

// --- Cohort announcements (INST-06) ---------------------------------------------

export type AnnouncementChannel = 'IN_APP' | 'EMAIL';

export interface AnnouncementAudienceDto {
  /** null addresses the whole institution. */
  readonly unitId: string | null;
  readonly kind: string;
  readonly name: string | null;
}

export interface InstitutionAnnouncementDto {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly audience: AnnouncementAudienceDto;
  readonly channels: readonly AnnouncementChannel[];
  readonly state: 'SCHEDULED' | 'SENT' | 'CANCELLED';
  readonly senderRole: string;
  readonly sentByMe: boolean;
  readonly scheduledFor: string;
  readonly sentAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReasonCode: string | null;
  readonly createdAt: string;
  readonly delivery: {
    readonly recipients: number;
    readonly email: { readonly sent: number; readonly notConfigured: number; readonly failed: number; readonly bounced: number; readonly skipped: number; readonly pending: number };
  } | null;
}

export interface InstitutionAnnouncementListDto {
  readonly announcements: readonly InstitutionAnnouncementDto[];
  readonly nextCursor: string | null;
  readonly audiences: readonly AnnouncementAudienceDto[];
  readonly canSend: boolean;
  readonly emailConfigured: boolean;
  readonly dailyLimit: number;
}

export interface InstitutionAnnouncementCreateRequest {
  readonly title: string;
  readonly body: string;
  readonly audienceUnitId: string | null;
  readonly channels: readonly AnnouncementChannel[];
  readonly scheduledFor?: string;
}

export function listInstitutionAnnouncements(token: string, institutionId: string, cursor?: string | null, signal?: AbortSignal): Promise<InstitutionAnnouncementListDto> {
  const query = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : '?limit=50';
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/announcements${query}`, { token, ...(signal ? { signal } : {}) });
}

export function createInstitutionAnnouncement(token: string, institutionId: string, body: InstitutionAnnouncementCreateRequest): Promise<{ readonly announcement: InstitutionAnnouncementDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/announcements`, { token, method: 'POST', body });
}

export function cancelInstitutionAnnouncement(token: string, institutionId: string, announcementId: string, reasonCode: string): Promise<{ readonly announcement: InstitutionAnnouncementDto }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/announcements/${encodeURIComponent(announcementId)}/cancel`, { token, method: 'POST', body: { reasonCode } });
}

// --- Analytics capability and CSV exports (INST-08) ---

/** A member who may hold INSTITUTION_ANALYTICS (an active admin or department head), with their live grant. */
export interface InstitutionAnalyticsAccessDto {
  readonly membershipId: string;
  readonly email: string;
  readonly role: string;
  readonly department: string | null;
  readonly grant: { readonly capabilityId: string; readonly grantedAt: string; readonly reasonCode: string } | null;
}

export function listInstitutionAnalyticsAccess(token: string, institutionId: string, signal?: AbortSignal): Promise<{ readonly eligible?: readonly InstitutionAnalyticsAccessDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/capabilities`, { token, ...(signal ? { signal } : {}) });
}

export function grantInstitutionAnalyticsAccess(token: string, institutionId: string, membershipId: string, reasonCode: string): Promise<{ readonly eligible?: readonly InstitutionAnalyticsAccessDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/capabilities`, { token, method: 'POST', body: { membershipId, capability: 'INSTITUTION_ANALYTICS', reasonCode } });
}

export function revokeInstitutionAnalyticsAccess(token: string, institutionId: string, capabilityId: string, reasonCode: string): Promise<{ readonly eligible?: readonly InstitutionAnalyticsAccessDto[] }> {
  return requestJson(`/api/v1/institutions/${encodeURIComponent(institutionId)}/capabilities/${encodeURIComponent(capabilityId)}/revoke`, { token, method: 'POST', body: { reasonCode } });
}

export type InstitutionExportPath = 'roster' | 'readiness-bands' | 'assessment-results' | 'staff-action-summary';

export interface InstitutionExportRequest {
  readonly reasonCode: string;
  readonly month?: string;
  readonly unitId?: string;
  readonly assessmentId?: string;
}

/**
 * Request one export and return the CSV with the file name the server chose. The route is
 * authenticated like every other, so the file is fetched with the token and handed to the
 * browser rather than linked. Errors carry only the code and reference, never upstream text.
 */
export async function downloadInstitutionExport(token: string, institutionId: string, path: InstitutionExportPath, body: InstitutionExportRequest): Promise<{ readonly filename: string; readonly csv: string }> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}/api/v1/institutions/${encodeURIComponent(institutionId)}/exports/${path}`, {
    method: 'POST',
    headers: { Accept: 'text/csv', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Correlation-Id': correlationId },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { readonly error?: { readonly code?: string; readonly correlationId?: string } } | null;
    throw new ApiRequestError({
      status: response.status,
      correlationId: failure?.error?.correlationId ?? correlationId,
      ...(failure?.error?.code ? { code: failure.error.code } : {}),
    });
  }
  const disposition = response.headers?.get('content-disposition') ?? '';
  const filename = /filename="([A-Za-z0-9._-]+)"/.exec(disposition)?.[1] ?? `one-${path}.csv`;
  return { filename, csv: await response.text() };
}

// --- Department head and faculty workspaces (INST-07) ---


/** A table whose cells partition a total, after the one suppression rule (Appendix 3 §5.3). */
export interface SuppressedTableDto<K extends string = string> {
  readonly suppressed: boolean;
  readonly total: SuppressedCountDto;
  readonly cells: readonly { readonly key: K; readonly count: number | null; readonly suppressed: boolean }[];
}

export interface ReadinessAggregateDto {
  readonly suppressed: boolean;
  readonly minimumCohortSize: number;
  readonly cohortSize: number | null;
  readonly cohortSizeSuppressed: boolean;
  readonly bands: readonly { readonly band: string; readonly count: number | null; readonly suppressed: boolean }[];
}

export interface DepartmentUnitDto { readonly id: string; readonly kind: string; readonly name: string }

export interface DepartmentOverviewDto {
  readonly scope?: InstitutionStudentScopeDto;
  readonly unit: DepartmentUnitDto | null;
  readonly students: { readonly onRoster: number; readonly current: number };
  readonly activation: Readonly<Record<StudentActivationState, number>>;
  readonly assessments: { readonly inProgress: number; readonly assignedStudents: number; readonly completedStudents: number };
  /** Last ended month's bands (a report covers one whole ended month). */
  readonly readiness: { readonly month: string | null; readonly aggregate: ReadinessAggregateDto | null };
  readonly staffActions: { readonly openInterventions: number; readonly openTasks: number };
  readonly batches: readonly { readonly id: string; readonly name: string; readonly parentName: string | null; readonly students: number; readonly current: number; readonly activated: number }[];
}

export type ApplicationStage = 'APPLIED' | 'SCREENING' | 'SHORTLISTED' | 'ASSESSMENT' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED' | 'WITHDRAWN';
export type OfferResponseState = 'EXTENDED' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';

export interface PlacementPipelineDto {
  readonly scope?: InstitutionStudentScopeDto;
  readonly unit: DepartmentUnitDto | null;
  readonly studentsSharing: SuppressedCountDto;
  readonly stages: SuppressedTableDto<ApplicationStage>;
  readonly offers: SuppressedTableDto<OfferResponseState>;
  /** INST-09: current students by placement status, small groups suppressed. */
  readonly placementStatus?: SuppressedTableDto<PlacementStatus>;
}

/**
 * INST-09: where a student is in their placement journey, from applications they shared
 * with the college only. NOT_SHARED is not "not applied" — the college cannot tell.
 */
export type PlacementStatus = 'NOT_SHARED' | 'APPLIED' | 'IN_PROCESS' | 'OFFER' | 'ACCEPTED';

export interface PlacementStatusRowDto {
  readonly studentUserId: string;
  readonly fullName: string;
  readonly institutionStudentId: string;
  readonly department: string | null;
  readonly batch: string | null;
  readonly status: PlacementStatus;
  readonly sharedApplications: number;
  /** Unverified student declarations; they never change the status. */
  readonly sharedExternalDeclarations: number;
  readonly lastSharedActivityAt: string | null;
}

export interface PlacementApplicationDto {
  readonly id: string;
  readonly student: { readonly fullName: string; readonly institutionStudentId: string };
  readonly employer: { readonly name: string };
  readonly opportunityTitle: string;
  readonly state: ApplicationStage;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly offer: { readonly exists: boolean; readonly responseState: OfferResponseState | null };
}

export interface DepartmentStaffDto {
  readonly scope?: InstitutionStudentScopeDto;
  readonly staff: readonly { readonly email: string; readonly role: string; readonly department: string | null; readonly batch: string | null;
    readonly assignments: readonly { readonly unitName: string; readonly subject: string | null; readonly academicTerm: string }[] }[];
}

export interface ClassReportDto {
  readonly unit: DepartmentUnitDto;
  readonly subjects: readonly string[];
  readonly students: number;
  readonly activated: number;
  readonly openTasks: number;
  readonly assessments: readonly { readonly id: string; readonly title: string; readonly lifecycleState: string; readonly startsAt: string; readonly endsAt: string;
    readonly assigned: number; readonly completed: number; readonly averagePercentage: number | null; readonly averageSuppressed: boolean }[];
}

export interface ClassReportsDto { readonly mode: 'ASSIGNMENTS' | 'MEMBERSHIP'; readonly classes: readonly ClassReportDto[] }

export function getDepartmentOverview(token: string, institutionId: string, signal?: AbortSignal): Promise<DepartmentOverviewDto> {
  return requestJson(`${institutionPath(institutionId)}/department-overview`, { token, ...(signal ? { signal } : {}) });
}

export function getPlacementPipeline(token: string, institutionId: string, signal?: AbortSignal): Promise<PlacementPipelineDto> {
  return requestJson(`${institutionPath(institutionId)}/placement-pipeline`, { token, ...(signal ? { signal } : {}) });
}

export function listPlacementApplications(token: string, institutionId: string, cursor?: string | null, signal?: AbortSignal): Promise<{ readonly applications: readonly PlacementApplicationDto[]; readonly nextCursor: string | null }> {
  const query = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : '?limit=50';
  return requestJson(`${institutionPath(institutionId)}/placement-applications${query}`, { token, ...(signal ? { signal } : {}) });
}

/** One page of per-student placement status (audited server-side). */
export function listPlacementStatus(token: string, institutionId: string, options: { readonly cursor?: string | null; readonly limit?: number } = {}, signal?: AbortSignal): Promise<{ readonly students: readonly PlacementStatusRowDto[]; readonly nextCursor: string | null }> {
  const query = `?limit=${options.limit ?? 50}${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ''}`;
  return requestJson(`${institutionPath(institutionId)}/placement-status${query}`, { token, ...(signal ? { signal } : {}) });
}

export function listDepartmentStaff(token: string, institutionId: string, signal?: AbortSignal): Promise<DepartmentStaffDto> {
  return requestJson(`${institutionPath(institutionId)}/department-staff`, { token, ...(signal ? { signal } : {}) });
}

export function listClassReports(token: string, institutionId: string, signal?: AbortSignal): Promise<ClassReportsDto> {
  return requestJson(`${institutionPath(institutionId)}/class-reports`, { token, ...(signal ? { signal } : {}) });
}

/** How a suppressed count is shown: never the number, always "<5". */
export function suppressedCountLabel(count: { readonly suppressed: boolean; readonly value?: number | null; readonly count?: number | null } | null | undefined): string {
  if (!count) return 'NA';
  const value = count.value !== undefined ? count.value : count.count;
  return count.suppressed || value === null || value === undefined ? '<5' : String(value);
}
