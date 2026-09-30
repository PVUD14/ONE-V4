/**
 * ONE · API client — Stream B — Hiring
 *
 * Opportunities, applications, interviews and offers — student and employer sides.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { ApiRequestError, apiBaseUrl } from './core.js';
import { requestJson } from './http.js';
import type { CampusDriveState, StudentCampusDriveDto } from './campusDrives.js';

export interface CompensationDto {
  readonly currency: string | null;
  readonly min?: string | null;
  readonly max?: string | null;
  readonly amount?: string | null;
  readonly period: string | null;
}

export interface OpportunitySummaryDto {
  readonly id: string;
  readonly referenceCode: string | null;
  readonly employerName: string;
  readonly title: string;
  readonly summary: string | null;
  readonly employmentType: string;
  readonly workMode: string;
  readonly locationCity: string | null;
  readonly durationMonths: number | null;
  readonly applicationDeadline: string | null;
  readonly publishedAt: string | null;
  readonly compensation: CompensationDto | null;
  readonly alreadyApplied?: boolean;
  /** EMP-04: the hiring company's profile. Absent from older API responses. */
  readonly company?: OpportunityCompanyDto;
  /** EMP-11: live campus drives at the student's college through which this job reaches them. */
  readonly campusDrives?: readonly { readonly institutionName: string; readonly state: CampusDriveState; readonly scheduledStartAt: string | null }[];
}

/** What a student sees about the company behind a job (EMP-04). Unfilled fields are null. */
export interface OpportunityCompanyDto {
  readonly displayName: string | null;
  readonly industry: string | null;
  readonly companySizeBand: string | null;
  readonly about: string | null;
  readonly websiteUrl: string | null;
  readonly careersPageUrl: string | null;
  readonly city: string | null;
  readonly stateOrProvince: string | null;
  readonly countryCode: string | null;
}

export interface OpportunityDetailDto extends OpportunitySummaryDto {
  readonly responsibilities: string | null;
  readonly positionsAvailable: number | null;
  readonly joiningConditions: string | null;
  /** `catalogue`: picked from the ONE skill catalogue (EMP-06), not typed by the employer. */
  readonly skills: readonly { readonly name: string; readonly level: string; readonly catalogue?: boolean }[];
  readonly selectionStages: readonly { readonly order: number; readonly kind: string; readonly label: string; readonly detail: string | null }[];
}

export interface EligibilityDto {
  readonly eligible: boolean;
  readonly blockingFailures: readonly string[];
  readonly advisoryFailures: readonly string[];
  readonly needsMoreInformation: readonly string[];
  /** EMP-06: each rule, whether the student meets it, on what basis, and their own value. */
  readonly rules?: readonly StudentEligibilityRuleDto[];
}

export type EligibilityBasis = 'VERIFIED' | 'INSTITUTION_RECORD' | 'SELF_REPORTED';
export type EligibilityOutcome = 'MET' | 'NOT_MET' | 'UNKNOWN' | 'NOT_EVALUATED';

/** One eligibility rule as a job states it; `displayValue` names a college rather than its identifier. */
export interface EligibilityRuleDto {
  readonly ruleType: string;
  readonly comparator: string;
  readonly valueNumeric: number | null;
  readonly valueText: string | null;
  readonly isBlocking: boolean;
  readonly displayValue?: string;
}

export interface StudentEligibilityRuleDto extends EligibilityRuleDto {
  readonly outcome: EligibilityOutcome;
  readonly basis: EligibilityBasis | null;
  readonly unknownReason: 'NO_RECORD' | 'SCALE_NOT_COMPARABLE' | 'NOT_RECORDED_BY_ONE' | null;
  readonly yourValue: string | null;
}

/** What an employer is told per rule: the outcome and its basis, never the student's figure. */
export interface EmployerEligibilityOutcomeDto extends EligibilityRuleDto {
  readonly outcome: EligibilityOutcome;
  readonly basis: EligibilityBasis | null;
  readonly unknownReason: string | null;
  readonly flagged: boolean;
}

export interface ApplicantEligibilityDto {
  readonly eligible: boolean;
  readonly evaluatedAt: string;
  readonly trigger: 'APPLY' | 'TERMS_ACKNOWLEDGED';
  readonly versionNumber: number | null;
  readonly flagCount: number;
  readonly selfReportedCount: number;
  readonly outcomes: readonly EmployerEligibilityOutcomeDto[];
}

/** A job's selection stage, with the application state moving an applicant to it means. */
export interface SelectionStageDto {
  /** Present where a screen acts on the stage now (the applicant pipeline schedules against it). */
  readonly id?: string;
  readonly order: number;
  readonly kind: string;
  readonly label: string;
  readonly detail: string | null;
  readonly applicationState: string | null;
  /** EMP-09: the scorecard template an interview stage uses. Absent from older responses. */
  readonly scorecardTemplate?: { readonly id: string; readonly name: string | null } | null;
}

export interface StudentApplicationDto {
  readonly id: string;
  readonly state: string;
  readonly opportunityId: string;
  readonly employerName: string;
  readonly title: string;
  readonly employmentType: string;
  readonly workMode: string;
  readonly locationCity: string | null;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly consentRevokedAt: string | null;
  readonly institutionVisibilityGrantedAt: string | null;
  readonly institutionVisibilityRevokedAt: string | null;
  readonly updatedAt: string;
  readonly termsAcknowledgementPending: boolean;
  /** True when the employer chose to tell this candidate why. Fetch the detail separately. */
  readonly feedbackReleased: boolean;
  /** EMP-10: the employer started a conversation on this application. Absent from older API responses. */
  readonly conversationStarted?: boolean;
  /** EMP-10: the employer's messages the student has not opened yet. */
  readonly unreadMessages?: number;
  /** EMP-11: the college whose campus drive this application came through, if any. */
  readonly campusDrive?: { readonly institutionName: string } | null;
  /** INST-14: made by opting in to this college's placement-office nomination. */
  readonly nominatedBy?: { readonly institutionName: string } | null;
  /** EMP-13: verified evidence is shared with this employer now. Absent from older API responses. */
  readonly evidenceShared?: boolean;
}

export interface CandidateFeedbackReasonDto {
  readonly code: string;
  readonly studentLabel: string;
  readonly category: string;
}

export interface StudentApplicationFeedbackDto {
  readonly id: string;
  readonly employerName: string;
  readonly title: string;
  readonly releasedAt: string;
  readonly note: string | null;
  readonly reasons: readonly (CandidateFeedbackReasonDto & {
    /** Empty when nothing a student studies addresses this reason. Never filled with a guess. */
    readonly topics: readonly { readonly topicId: string; readonly name: string }[];
  })[];
}

export interface StudentOfferDto {
  readonly id: string;
  readonly state: string;
  readonly applicationId: string;
  readonly employerName: string;
  readonly title: string;
  readonly compensation: CompensationDto;
  readonly joiningDate: string | null;
  readonly offerExpiresAt: string | null;
  readonly conditions: string | null;
  readonly extendedAt: string | null;
}

export interface EmployerOpportunityDto {
  readonly id: string;
  readonly referenceCode: string;
  readonly lifecycleState: string;
  readonly title: string | null;
  readonly employmentType: string | null;
  readonly workMode: string | null;
  readonly locationCity: string | null;
  readonly applicationDeadline: string | null;
  readonly publishedAt: string | null;
  /** EMP-05: when the job was closed or withdrawn, and its current version number. Absent from older API responses. */
  readonly closedAt?: string | null;
  readonly versionNumber?: number | null;
  readonly applicationCount: number;
  readonly openApplicationCount: number;
}

export interface EmployerApplicantDto {
  readonly id: string;
  readonly state: string;
  readonly consentRevoked: boolean;
  /** False once the student's applicant-access grant has ended; the person is then withheld. */
  readonly candidateAccess?: boolean;
  readonly candidateName: string | null;
  readonly candidateEmail: string | null;
  readonly institutionStudentId: string | null;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly interviewCount: number;
  readonly offerState: string | null;
  /** EMP-05: the job's terms changed after they applied and they have not accepted yet. */
  readonly termsAcknowledgementPending?: boolean;
  /** EMP-06: frozen eligibility flags; null when the job had no rules or the person is withheld. */
  readonly eligibility?: ApplicantEligibilityDto | null;
  /** INST-14: the student opted in to their college's nomination ("Nominated by placement office"). */
  readonly source?: 'DIRECT' | 'PLACEMENT_OFFICE_NOMINATION';
  readonly updatedAt: string;
}

export interface EmployerInterviewDto {
  readonly id: string;
  readonly applicationId: string;
  readonly applicationState: string;
  readonly opportunityId: string;
  readonly referenceCode: string | null;
  readonly title: string;
  readonly consentRevoked: boolean;
  /** False once the student's applicant-access grant has ended; the person is then withheld. */
  readonly candidateAccess?: boolean;
  readonly candidateName: string | null;
  readonly candidateEmail: string | null;
  readonly institutionStudentId: string | null;
  readonly roundNumber: number;
  readonly mode: string;
  readonly state: string;
  readonly scheduledStart: string | null;
  readonly scheduledEnd: string | null;
  readonly locationDetail: string | null;
  /** EMP-09: only for the member who scheduled it and the panel; otherwise null and `joiningLinkWithheld`. */
  readonly joiningLink: string | null;
  readonly joiningLinkWithheld?: boolean;
  readonly stageLabel?: string | null;
  readonly scorecardTemplate?: { readonly id: string; readonly name: string } | null;
  /** EMP-09: the latest schedule change, with its reason code. */
  readonly lastChange?: { readonly kind: string; readonly reasonCode: string | null; readonly at: string | null } | null;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly outcomeCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EmployerOfferDto {
  readonly id: string;
  readonly applicationId: string;
  readonly applicationState: string;
  readonly opportunityId: string;
  readonly referenceCode: string | null;
  readonly title: string;
  readonly consentRevoked: boolean;
  /** False once the student's applicant-access grant has ended; the person is then withheld. */
  readonly candidateAccess?: boolean;
  readonly candidateName: string | null;
  readonly candidateEmail: string | null;
  readonly institutionStudentId: string | null;
  readonly state: string;
  readonly compensation: CompensationDto;
  readonly joiningDate: string | null;
  readonly offerExpiresAt: string | null;
  readonly conditions: string | null;
  readonly extendedAt: string | null;
  readonly respondedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function listOpportunities(token: string, q = '', signal?: AbortSignal): Promise<{ readonly opportunities: readonly OpportunitySummaryDto[] }> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return requestJson(`/api/v1/opportunities${query}`, { token, ...(signal ? { signal } : {}) });
}

export function getOpportunity(token: string, opportunityId: string, signal?: AbortSignal): Promise<{ readonly opportunity: OpportunityDetailDto; readonly eligibility: EligibilityDto; readonly campusDrives?: readonly StudentCampusDriveDto[] }> {
  return requestJson(`/api/v1/opportunities/${encodeURIComponent(opportunityId)}`, { token, ...(signal ? { signal } : {}) });
}

export function listStudentApplications(token: string, signal?: AbortSignal): Promise<{ readonly applications: readonly StudentApplicationDto[]; readonly evidenceSharingAvailable?: boolean }> {
  return requestJson('/api/v1/students/me/applications', { token, ...(signal ? { signal } : {}) });
}

export function applyToOpportunity(token: string, opportunityId: string, institutionVisibilityGranted = false): Promise<{ readonly application: { readonly id: string; readonly state: string } }> {
  return requestJson('/api/v1/students/me/applications', { token, method: 'POST', body: { opportunityId, consentGranted: true, institutionVisibilityGranted } });
}

export function revokeInstitutionVisibility(token: string, applicationId: string): Promise<{ readonly ok: boolean }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/institution-visibility/revoke`, { token, method: 'POST' });
}

/** INST-09: share an application with the student's college after applying; revocable at any time. */
export function grantInstitutionVisibility(token: string, applicationId: string): Promise<{ readonly ok: boolean }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/institution-visibility/grant`, { token, method: 'POST' });
}

export function withdrawApplication(token: string, applicationId: string, reason?: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/withdraw`, { token, method: 'POST', body: reason ? { reason } : {} });
}

/** EMP-08: an interview as its candidate sees it; where and how to join only while it is ahead. */
export interface StudentInterviewDto {
  readonly id: string;
  readonly employerName: string;
  readonly title: string;
  readonly roundNumber: number;
  readonly stageLabel: string | null;
  readonly applicationState: string;
  readonly mode: 'VIDEO' | 'PHONE' | 'ONSITE';
  readonly state: 'SCHEDULED' | 'RESCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  readonly upcoming: boolean;
  readonly scheduledStart: string | null;
  readonly scheduledEnd: string | null;
  readonly locationDetail: string | null;
  readonly joiningLink: string | null;
  readonly preparationNote: string | null;
}

export function listStudentInterviews(token: string, signal?: AbortSignal): Promise<{ readonly interviews: readonly StudentInterviewDto[] }> {
  return requestJson('/api/v1/students/me/interviews', { token, ...(signal ? { signal } : {}) });
}

export function listStudentOffers(token: string, signal?: AbortSignal): Promise<{ readonly offers: readonly StudentOfferDto[] }> {
  return requestJson('/api/v1/students/me/offers', { token, ...(signal ? { signal } : {}) });
}

export function respondToOffer(token: string, offerId: string, decision: 'ACCEPT' | 'DECLINE', reason?: string): Promise<{ readonly offer: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/students/me/offers/${encodeURIComponent(offerId)}/respond`, { token, method: 'POST', body: { decision, ...(reason ? { reason } : {}) } });
}

/** An employer organisation's own verification state and what it allows (EMP-03). */
export interface EmployerOrganisationStatusDto {
  readonly verificationState: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  readonly active: boolean;
  readonly canDraft: boolean;
  readonly canPublish: boolean;
  readonly canReachCandidates: boolean;
}

export function getEmployerOrganisationStatus(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly organisation: EmployerOrganisationStatusDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/organisation-status`, { token, ...(signal ? { signal } : {}) });
}

export function listEmployerOpportunities(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly opportunities: readonly EmployerOpportunityDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities`, { token, ...(signal ? { signal } : {}) });
}

export function createEmployerOpportunity(token: string, employerId: string, body: unknown): Promise<{ readonly opportunity: { readonly id: string; readonly versionId: string; readonly lifecycleState: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities`, { token, method: 'POST', body });
}

export function addOpportunityAudience(token: string, employerId: string, opportunityId: string, body: unknown): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/audiences`, { token, method: 'POST', body });
}

export function publishOpportunity(token: string, employerId: string, opportunityId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/publish`, { token, method: 'POST' });
}

export function listEmployerApplicants(token: string, employerId: string, opportunityId: string, signal?: AbortSignal): Promise<{ readonly applications: readonly EmployerApplicantDto[]; readonly stages?: readonly SelectionStageDto[]; readonly evidenceSkills?: readonly EvidenceFilterSkillDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/applications`, { token, ...(signal ? { signal } : {}) });
}

/** EMP-13: a job's catalogue skill an employer may filter applicants by. `topicId` is a filter value, never shown. */
export interface EvidenceFilterSkillDto { readonly topicId: string; readonly name: string }

/** EMP-13 (decision 10.2 #5): only applicants who share verified evidence for one skill. Narrows; never re-orders. */
export function listEmployerApplicantsWithEvidence(token: string, employerId: string, opportunityId: string, evidenceSkill: string, signal?: AbortSignal): Promise<{ readonly applications: readonly EmployerApplicantDto[]; readonly stages?: readonly SelectionStageDto[]; readonly evidenceSkills?: readonly EvidenceFilterSkillDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/applications?evidenceSkill=${encodeURIComponent(evidenceSkill)}`, { token, ...(signal ? { signal } : {}) });
}

export function listEmployerInterviews(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly interviews: readonly EmployerInterviewDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/interviews`, { token, ...(signal ? { signal } : {}) });
}

export function listEmployerOffers(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly offers: readonly EmployerOfferDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/offers`, { token, ...(signal ? { signal } : {}) });
}

export function readApplicationFeedback(token: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly feedback: StudentApplicationFeedbackDto | null }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/feedback`, { token, ...(signal ? { signal } : {}) });
}

export function listCandidateFeedbackReasons(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly reasons: readonly CandidateFeedbackReasonDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/candidate-feedback-reasons`, { token, ...(signal ? { signal } : {}) });
}

export function releaseCandidateFeedback(token: string, employerId: string, applicationId: string, reasonCodes: readonly string[], note?: string): Promise<{ readonly feedback: { readonly id: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/feedback`, { token, method: 'POST', body: { reasonCodes, ...(note ? { note } : {}) } });
}

export function transitionApplication(token: string, employerId: string, applicationId: string, toState: string, note?: string): Promise<{ readonly application: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/transition`, { token, method: 'POST', body: { toState, ...(note ? { note } : {}) } });
}

export interface InterviewScheduleInput {
  readonly mode: 'VIDEO' | 'PHONE' | 'ONSITE';
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  readonly locationDetail?: string;
  readonly joiningLink?: string;
  readonly participantUserIds?: readonly string[];
  readonly participantVisibilityAcknowledged?: boolean;
  /** EMP-08: shown to the candidate as written, in their interview view. */
  readonly preparationNote?: string;
  /** EMP-09: the interview or group-discussion stage; its scorecard template is copied onto the interview. */
  readonly selectionStageId?: string;
}

export interface InterviewParticipantOptionDto {
  readonly userId: string;
  readonly label: string;
}

export interface ParticipantInterviewDto {
  readonly id: string;
  readonly title: string;
  readonly roundNumber: number;
  readonly mode: string;
  readonly state: string;
  readonly scheduledStart: string;
  readonly scheduledEnd: string | null;
  readonly consentRevoked: boolean;
  /** False once the student's applicant-access grant has ended; the person is then withheld. */
  readonly candidateAccess?: boolean;
  readonly candidateName: string | null;
  readonly candidateEmail: string | null;
  readonly institutionStudentId: string | null;
  readonly locationDetail: string | null;
  readonly joiningLink: string | null;
  readonly summary: string | null;
  readonly responsibilities: string | null;
  readonly canRecordOutcome: boolean;
  /** EMP-09: on the brief only. */
  readonly stageLabel?: string | null;
  readonly scorecardTemplate?: ScorecardTemplateDto | null;
}

/** EMP-09: an employer's scorecard template: criteria and guidance an interview stage uses. */
export interface ScorecardTemplateDto {
  readonly id: string;
  readonly name: string;
  readonly guidance: string | null;
  readonly retiredAt: string | null;
  readonly createdAt?: string | null;
  readonly criteria: readonly { readonly id: string; readonly position: number; readonly label: string; readonly guidance: string | null }[];
}

export interface ScorecardTemplateInput {
  readonly name: string;
  readonly guidance?: string;
  readonly criteria: readonly { readonly label: string; readonly guidance?: string }[];
}

export function listScorecardTemplates(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly templates: readonly ScorecardTemplateDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/scorecard-templates`, { token, ...(signal ? { signal } : {}) });
}

export function createScorecardTemplate(token: string, employerId: string, body: ScorecardTemplateInput): Promise<{ readonly template: ScorecardTemplateDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/scorecard-templates`, { token, method: 'POST', body });
}

export const scorecardTemplateRetireReasons = ['NO_LONGER_USED', 'REPLACED', 'CREATED_IN_ERROR'] as const;

export function retireScorecardTemplate(token: string, employerId: string, templateId: string, reasonCode: typeof scorecardTemplateRetireReasons[number]): Promise<{ readonly template: ScorecardTemplateDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/scorecard-templates/${encodeURIComponent(templateId)}/retire`, { token, method: 'POST', body: { reasonCode } });
}

/** EMP-09: one change to an interview's schedule, oldest first. */
export interface InterviewRevisionDto {
  readonly revisionNumber: number;
  readonly changeKind: 'BASELINE' | 'SCHEDULED' | 'RESCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly mode: string;
  readonly scheduledStart: string | null;
  readonly scheduledEnd: string | null;
  readonly locationDetail: string | null;
  readonly joiningLink: string | null;
  readonly actorLabel: string;
  readonly recordedAt: string | null;
}

export function listInterviewHistory(token: string, employerId: string, interviewId: string, signal?: AbortSignal): Promise<{ readonly revisions: readonly InterviewRevisionDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/interviews/${encodeURIComponent(interviewId)}/history`, { token, ...(signal ? { signal } : {}) });
}

/** EMP-09: every scorecard on an interview, per interviewer and criterion. Never a total. */
export interface InterviewScorecardsDto {
  readonly template: ScorecardTemplateDto | null;
  readonly scorecards: readonly {
    readonly submittedBy: string; readonly recommendation: string; readonly overallRating: number | null;
    readonly strengths: string | null; readonly concerns: string | null; readonly notes: string | null; readonly submittedAt: string | null;
    readonly ratings: readonly { readonly criterionId: string; readonly label: string; readonly rating: number; readonly note: string | null }[];
  }[];
}

export function getInterviewScorecards(token: string, employerId: string, interviewId: string, signal?: AbortSignal): Promise<InterviewScorecardsDto> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/interviews/${encodeURIComponent(interviewId)}/scorecards`, { token, ...(signal ? { signal } : {}) });
}

/** EMP-09: an interview's calendar invite, fetched with the access token for the browser to save. */
async function downloadCalendar(token: string, path: string): Promise<{ readonly blob: Blob; readonly filename: string }> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/calendar', 'X-Correlation-Id': correlationId } });
  if (!response.ok) throw new ApiRequestError({ status: response.status, correlationId: response.headers?.get('x-correlation-id') ?? correlationId });
  const disposition = response.headers?.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'interview.ics';
  return { blob: await response.blob(), filename };
}

export function downloadStudentInterviewCalendar(token: string, interviewId: string): Promise<{ readonly blob: Blob; readonly filename: string }> {
  return downloadCalendar(token, `/api/v1/students/me/interviews/${encodeURIComponent(interviewId)}/calendar`);
}

export function downloadMyInterviewCalendar(token: string, employerId: string, interviewId: string): Promise<{ readonly blob: Blob; readonly filename: string }> {
  return downloadCalendar(token, `/api/v1/employers/${encodeURIComponent(employerId)}/my-interviews/${encodeURIComponent(interviewId)}/calendar`);
}

/** EMP-17: why an owner or admin exports, and which applicants. Mirrors the API's fixed lists. */
export const employerExportReasons = [
  ['SHORTLIST_REVIEW', 'Reviewing the shortlist'],
  ['INTERVIEW_PLANNING', 'Planning interviews'],
  ['HIRING_COMMITTEE', 'Hiring committee review'],
  ['OFFER_PREPARATION', 'Preparing offers'],
  ['RECORD_KEEPING', 'Our own hiring records'],
] as const;
export type EmployerExportScope = 'ALL_OPEN' | 'SHORTLISTED_ONWARD';

/**
 * EMP-17: one job's applicants as a CSV file. A POST, because the server records the export with
 * its reason before sending it. Errors carry only the code and reference, never upstream text.
 */
export async function downloadEmployerApplicantExport(token: string, employerId: string, opportunityId: string,
  body: { readonly reasonCode: string; readonly scope: EmployerExportScope }): Promise<{ readonly blob: Blob; readonly filename: string }> {
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/applicant-export`, {
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
  const filename = /filename="([A-Za-z0-9._-]+)"/.exec(disposition)?.[1] ?? 'one-applicants.csv';
  return { blob: await response.blob(), filename };
}

/** Hand a downloaded file to the browser to save. */
export function saveDownloadedFile(file: { readonly blob: Blob; readonly filename: string }): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url; link.download = file.filename; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

export function listInterviewParticipantOptions(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly participants: readonly InterviewParticipantOptionDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/interview-participant-options`, { token, ...(signal ? { signal } : {}) });
}

export function listMyInterviews(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly interviews: readonly ParticipantInterviewDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/my-interviews`, { token, ...(signal ? { signal } : {}) });
}

export function getMyInterview(token: string, employerId: string, interviewId: string, signal?: AbortSignal): Promise<{ readonly interview: ParticipantInterviewDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/my-interviews/${encodeURIComponent(interviewId)}`, { token, ...(signal ? { signal } : {}) });
}

export function submitMyInterviewOutcome(token: string, employerId: string, interviewId: string, body: InterviewOutcomeInput): Promise<{ readonly ok: boolean }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/my-interviews/${encodeURIComponent(interviewId)}/outcome`, { token, method: 'POST', body });
}

export interface OfferInput {
  readonly compensationCurrency: string;
  readonly compensationAmount: number;
  readonly compensationPeriod: 'HOUR' | 'MONTH' | 'YEAR' | 'TOTAL_STIPEND';
  readonly joiningDate?: string;
  readonly offerExpiresAt: string;
  readonly conditions?: string;
}

/** EMP-09: why an interview moved or was cancelled. Never shown to the candidate. */
export const interviewRescheduleReasons = ['CANDIDATE_REQUESTED', 'INTERVIEWER_UNAVAILABLE', 'SCHEDULING_CONFLICT', 'LOGISTICS_CHANGED', 'TECHNICAL_ISSUE'] as const;
export const interviewCancelReasons = ['CANDIDATE_REQUESTED', 'CANDIDATE_WITHDREW', 'INTERVIEWER_UNAVAILABLE', 'POSITION_FILLED', 'PROCESS_CHANGED', 'SCHEDULED_IN_ERROR'] as const;

export interface InterviewStateInput {
  readonly toState: 'RESCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  /** Required for RESCHEDULED and CANCELLED (EMP-09). */
  readonly reasonCode?: string;
  /** Internal; never shown to the candidate. */
  readonly note?: string;
  readonly scheduledStart?: string;
  readonly scheduledEnd?: string;
}

export interface InterviewOutcomeInput {
  readonly recommendation: 'STRONG_YES' | 'YES' | 'NEUTRAL' | 'NO' | 'STRONG_NO';
  readonly overallRating?: number;
  readonly strengths?: string;
  readonly concerns?: string;
  readonly notes?: string;
  /** EMP-09: one rating (1–5) per criterion of the interview's scorecard template, when it has one. */
  readonly criteria?: readonly { readonly criterionId: string; readonly rating: number; readonly note?: string }[];
}

export function updateInterviewState(token: string, employerId: string, interviewId: string, body: InterviewStateInput): Promise<{ readonly interview: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/interviews/${encodeURIComponent(interviewId)}/state`, { token, method: 'POST', body });
}

export function submitInterviewOutcome(token: string, employerId: string, interviewId: string, body: InterviewOutcomeInput): Promise<{ readonly ok: boolean }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/interviews/${encodeURIComponent(interviewId)}/outcome`, { token, method: 'POST', body });
}

export function withdrawEmployerOffer(token: string, employerId: string, offerId: string): Promise<{ readonly offer: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/offers/${encodeURIComponent(offerId)}/withdraw`, { token, method: 'POST' });
}

export interface HiringAnalyticsDto {
  readonly applicationCount: number;
  readonly stages: readonly { readonly stage: string; readonly count: number; readonly reached: number }[];
  readonly conversions: readonly { readonly from: string; readonly to: string; readonly entrants: number; readonly progressed: number; readonly rate: number | null }[];
  readonly meanTimeToOfferDays: number | null;
  readonly timedOfferCount: number;
  readonly opportunities: readonly { readonly title: string; readonly applicationCount: number; readonly funnel: readonly { readonly stage: string; readonly count: number }[] }[];
}

export function getEmployerHiringAnalytics(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly analytics: HiringAnalyticsDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/hiring-analytics`, { token, ...(signal ? { signal } : {}) });
}

/**
 * EMP-15: the employer Dashboard's figures, computed by the server. Each is the count of rows the
 * employer's own lists already show, so they are exact. "This week" is the Asia/Kolkata week the
 * server counted, returned so a client lists the same window.
 */
export interface EmployerSummaryDto {
  readonly openJobs: number;
  readonly newApplicantsLast7Days: number;
  readonly interviewsThisWeek: number;
  readonly offersPending: number;
  readonly drivesAwaitingApproval: number;
  readonly drivesChangesRequested: number;
  readonly applicationsTotal: number;
  readonly openApplications: number;
  readonly hires: number;
  readonly currentStages: Readonly<Record<string, number>>;
  readonly week: { readonly startsAt: string; readonly endsAt: string };
  readonly timeZone: string;
}

export function getEmployerSummary(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly summary: EmployerSummaryDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/summary`, { token, ...(signal ? { signal } : {}) });
}

/** A figure about people as a report may carry it: withheld (no value) under 5. */
export interface ReportCountDto { readonly suppressed: boolean; readonly value: number | null }
export interface ReportTableDto {
  /** The whole group is under 5: nothing in it is shown. */
  readonly suppressed: boolean;
  readonly total: ReportCountDto;
  readonly cells: readonly { readonly key: string; readonly count: number | null; readonly suppressed: boolean }[];
}
export interface EmployerReportsDto {
  readonly threshold: number;
  readonly overall: ReportTableDto;
  readonly byJob: readonly { readonly opportunityId: string; readonly referenceCode: string | null; readonly title: string | null; readonly lifecycleState: string; readonly table: ReportTableDto }[];
  readonly byJobTruncated: boolean;
  readonly byCollege: readonly { readonly collegeName: string | null; readonly table: ReportTableDto }[];
  readonly byDrive: readonly { readonly driveId: string; readonly opportunityTitle: string | null; readonly institutionName: string; readonly state: string; readonly table: ReportTableDto }[];
  readonly byDriveTruncated: boolean;
  readonly timeToStage: readonly { readonly metric: 'SHORTLIST' | 'INTERVIEW' | 'OFFER' | 'HIRE'; readonly applications: ReportCountDto; readonly medianDays: number | null }[];
  readonly offers: { readonly table: ReportTableDto; readonly acceptanceRate: number | null };
}

export function getEmployerReports(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly reports: EmployerReportsDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/reports`, { token, ...(signal ? { signal } : {}) });
}

export function scheduleInterview(token: string, employerId: string, applicationId: string, body: InterviewScheduleInput): Promise<{ readonly interview: { readonly id: string; readonly state: string; readonly roundNumber: number } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/interviews`, { token, method: 'POST', body });
}

export function extendOffer(token: string, employerId: string, applicationId: string, body: OfferInput): Promise<{ readonly offer: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/offers`, { token, method: 'POST', body });
}
export interface ExternalApplicationInput {
  readonly companyName: string;
  readonly roleTitle: string;
  readonly sourceKind: 'JOB_BOARD' | 'COMPANY_SITE' | 'REFERRAL';
  readonly appliedOn: string;
  readonly applicationUrl?: string | null;
  readonly stage: 'APPLIED' | 'SCREENING' | 'ASSESSMENT' | 'INTERVIEW' | 'OFFER' | 'HIRED' | 'REJECTED' | 'WITHDRAWN';
  readonly institutionVisibilityGranted?: boolean;
}
export interface ExternalApplicationDto extends Omit<ExternalApplicationInput, 'institutionVisibilityGranted'> {
  readonly id: string;
  readonly applicationUrl: string | null;
  readonly source: 'STUDENT_DECLARED';
  readonly verificationState: 'UNVERIFIED';
  readonly revision: number;
  readonly institutionVisibilityGrantedAt: string | null;
  readonly institutionVisibilityRevokedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ExternalApplicationPageDto {
  readonly externalApplications: readonly ExternalApplicationDto[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
const externalApplicationsPath = '/api/v1/students/me/external-applications';
export function listExternalApplications(token: string, offset = 0, signal?: AbortSignal): Promise<ExternalApplicationPageDto> {
  return requestJson(`${externalApplicationsPath}?offset=${offset}&limit=50`, { token, ...(signal ? { signal } : {}) });
}
export function getExternalApplication(token: string, id: string, signal?: AbortSignal): Promise<{ readonly externalApplication: ExternalApplicationDto }> {
  return requestJson(`${externalApplicationsPath}/${encodeURIComponent(id)}`, { token, ...(signal ? { signal } : {}) });
}
export function createExternalApplication(token: string, body: ExternalApplicationInput): Promise<{ readonly externalApplication: ExternalApplicationDto }> {
  return requestJson(externalApplicationsPath, { token, method: 'POST', body });
}
export function updateExternalApplication(token: string, id: string, body: Partial<Omit<ExternalApplicationInput, 'institutionVisibilityGranted'>> & { readonly revision: number }): Promise<{ readonly externalApplication: ExternalApplicationDto }> {
  return requestJson(`${externalApplicationsPath}/${encodeURIComponent(id)}`, { token, method: 'PATCH', body });
}
export function deleteExternalApplication(token: string, id: string, revision: number): Promise<{ readonly ok: boolean }> {
  return requestJson(`${externalApplicationsPath}/${encodeURIComponent(id)}`, { token, method: 'DELETE', body: { revision } });
}
export function changeExternalInstitutionVisibility(token: string, id: string, revision: number, action: 'grant' | 'revoke'): Promise<{ readonly externalApplication: ExternalApplicationDto }> {
  return requestJson(`${externalApplicationsPath}/${encodeURIComponent(id)}/institution-visibility/${action}`, { token, method: 'POST', body: { revision } });
}

// --- Employer team (EMP-02) --------------------------------------------------
// Owners and admins manage the team; the server decides who may invite, revoke, resend or
// end whom. Interviewers join as recruiters (decision 10.2 #2).

export type EmployerTeamRole = 'EMPLOYER_OWNER' | 'EMPLOYER_ADMIN' | 'RECRUITER';

export interface EmployerTeamMemberDto {
  readonly membershipId: string;
  readonly email: string;
  readonly role: EmployerTeamRole;
  readonly state: string;
  readonly since: string | null;
  readonly isSelf: boolean;
  readonly canEnd: boolean;
}

export interface EmployerTeamInvitationDto {
  readonly id: string;
  readonly email: string;
  readonly role: EmployerTeamRole;
  readonly state: 'PENDING' | 'EXPIRED';
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  readonly delivery: { readonly state: string; readonly sendCount: number; readonly lastSentAt: string | null };
  readonly canRevoke: boolean;
  readonly canResend: boolean;
}

export interface EmployerTeamDto {
  readonly actorRole: EmployerTeamRole;
  readonly invitableRoles: readonly EmployerTeamRole[];
  readonly deliveryConfigured: boolean;
  readonly members: readonly EmployerTeamMemberDto[];
  readonly nextCursor: string | null;
  readonly invitations: readonly EmployerTeamInvitationDto[];
  readonly invitationsTruncated: boolean;
  readonly reasonCodes: { readonly revoke: readonly string[]; readonly resend: readonly string[]; readonly end: readonly string[] };
}

export function getEmployerTeam(token: string, employerId: string, cursor?: string, signal?: AbortSignal): Promise<{ readonly team: EmployerTeamDto }> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/team${query}`, { token, ...(signal ? { signal } : {}) });
}

export function inviteEmployerTeamMember(token: string, employerId: string, email: string, role: EmployerTeamRole): Promise<{ readonly invitation: { readonly id: string; readonly delivery: { readonly state: string } } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/team-invitations`, { token, method: 'POST', body: { email, role } });
}

export function revokeEmployerTeamInvitation(token: string, employerId: string, invitationId: string, reasonCode: string): Promise<{ readonly invitation: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/team-invitations/${encodeURIComponent(invitationId)}/revoke`, { token, method: 'POST', body: { reasonCode } });
}

export function resendEmployerTeamInvitation(token: string, employerId: string, invitationId: string, reasonCode: string): Promise<{ readonly invitation: { readonly id: string; readonly delivery: { readonly state: string } } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/team-invitations/${encodeURIComponent(invitationId)}/resend`, { token, method: 'POST', body: { reasonCode } });
}

export function endEmployerTeamMembership(token: string, employerId: string, membershipId: string, reasonCode: string): Promise<{ readonly member: { readonly membershipId: string; readonly state: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/team/${encodeURIComponent(membershipId)}/end`, { token, method: 'POST', body: { reasonCode } });
}

// --- Company profile (EMP-04) --------------------------------------------------

/** The employer's own view of its company profile. The server decides canEdit. */
export interface EmployerCompanyProfileDto {
  readonly legalName: string;
  readonly verificationState: string;
  readonly profileSetUp: boolean;
  readonly displayName: string | null;
  readonly websiteUrl: string | null;
  readonly countryCode: string | null;
  readonly stateOrProvince: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly primaryContactEmail: string | null;
  readonly about: string | null;
  readonly industry: string | null;
  readonly companySizeBand: string | null;
  readonly careersPageUrl: string | null;
  readonly updatedAt: string | null;
  readonly canEdit: boolean;
  readonly options: { readonly industries: readonly string[]; readonly sizeBands: readonly string[] };
}

export interface EmployerCompanyProfileChanges {
  readonly about?: string | null;
  readonly industry?: string | null;
  readonly companySizeBand?: string | null;
  readonly careersPageUrl?: string | null;
}

export function getEmployerCompanyProfile(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly companyProfile: EmployerCompanyProfileDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/company-profile`, { token, ...(signal ? { signal } : {}) });
}

export function updateEmployerCompanyProfile(token: string, employerId: string, changes: EmployerCompanyProfileChanges): Promise<{ readonly companyProfile: EmployerCompanyProfileDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/company-profile`, { token, method: 'POST', body: changes });
}

/** Human labels for the fixed industry list and size bands. */
export const companyIndustryLabels: Readonly<Record<string, string>> = {
  SOFTWARE_AND_IT_SERVICES: 'Software and IT services',
  FINANCIAL_SERVICES: 'Financial services',
  MANUFACTURING: 'Manufacturing',
  ENGINEERING_AND_CONSTRUCTION: 'Engineering and construction',
  HEALTHCARE_AND_LIFE_SCIENCES: 'Healthcare and life sciences',
  CONSULTING_AND_PROFESSIONAL_SERVICES: 'Consulting and professional services',
  RETAIL_AND_CONSUMER: 'Retail and consumer',
  EDUCATION: 'Education',
  MEDIA_AND_COMMUNICATIONS: 'Media and communications',
  ENERGY_AND_UTILITIES: 'Energy and utilities',
  LOGISTICS_AND_TRANSPORT: 'Logistics and transport',
  GOVERNMENT_AND_PUBLIC_SECTOR: 'Government and public sector',
  NON_PROFIT: 'Non-profit',
  OTHER: 'Other',
};

export function companySizeLabel(band: string | null | undefined): string | null {
  return band ? `${band} employees` : null;
}

// --- Job lifecycle (EMP-05) -------------------------------------------------

export type OpportunityLifecycleAction = 'PAUSE' | 'CLOSE' | 'REOPEN' | 'WITHDRAW';

/** Every field of a version: what the edit form shows and sends back. */
export interface OpportunityVersionTermsDto {
  readonly id: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly summary: string | null;
  readonly responsibilities: string | null;
  readonly employmentType: string;
  readonly workMode: string;
  readonly locationCity: string | null;
  readonly positionsAvailable: number | null;
  readonly durationMonths: number | null;
  readonly compensationDisclosed: boolean;
  readonly compensationCurrency: string | null;
  readonly compensationMin: string | null;
  readonly compensationMax: string | null;
  readonly compensationPeriod: string | null;
  readonly joiningConditions: string | null;
  readonly applicationDeadline: string | null;
  readonly createdAt: string;
  /** EMP-06: what the version asks for. */
  readonly requirements?: OpportunityRequirementsDto;
}

export interface OpportunityRequirementsDto {
  readonly eligibilityRules: readonly EligibilityRuleDto[];
  readonly skills: readonly { readonly name: string; readonly level: 'REQUIRED' | 'PREFERRED'; readonly taxonomyTopicId: string | null; readonly catalogue: boolean }[];
  readonly stages: readonly SelectionStageDto[];
  readonly careerRole: { readonly id: string; readonly code: string; readonly title: string } | null;
}

export interface OpportunityVersionHistoryDto {
  readonly id: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly createdAt: string;
  readonly isCurrent: boolean;
  /** INITIAL for version 1; MATERIAL when a term an applicant applied under moved. */
  readonly change: 'INITIAL' | 'EDITORIAL' | 'MATERIAL';
  readonly changedTerms: readonly string[];
  /** EMP-06: skills, stages or catalogue role changed (never asks applicants anything). */
  readonly changedDetails?: readonly string[];
}

export interface EmployerOpportunityDetailDto {
  readonly id: string;
  readonly referenceCode: string;
  readonly lifecycleState: string;
  readonly publishedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly canEdit: boolean;
  readonly availableActions: readonly OpportunityLifecycleAction[];
  readonly reasonCodes: Readonly<Record<OpportunityLifecycleAction, readonly string[]>>;
  readonly audiences: readonly { readonly kind: string; readonly institutionName: string | null; readonly unitName: string | null }[];
  readonly applicationCount: number;
  readonly openApplicationCount: number;
  readonly awaitingAcknowledgementCount: number;
  readonly lastLifecycleChange: { readonly action: string; readonly reasonCode: string | null; readonly trigger: string; readonly occurredAt: string } | null;
}

export function getEmployerOpportunity(token: string, employerId: string, opportunityId: string, signal?: AbortSignal): Promise<{
  readonly opportunity: EmployerOpportunityDetailDto; readonly currentVersion: OpportunityVersionTermsDto | null; readonly versions: readonly OpportunityVersionHistoryDto[];
  readonly requirementReasonCodes?: readonly string[];
}> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}`, { token, ...(signal ? { signal } : {}) });
}

export function createOpportunityVersion(token: string, employerId: string, opportunityId: string, body: Record<string, unknown>): Promise<{
  readonly version: { readonly id: string; readonly versionNumber: number; readonly change: 'EDITORIAL' | 'MATERIAL'; readonly changedTerms: readonly string[]; readonly changedDetails?: readonly string[] };
  readonly applicants: { readonly termChangesRecorded: number; readonly acknowledgementsRequired: number };
}> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/versions`, { token, method: 'POST', body });
}

export function changeOpportunityLifecycle(token: string, employerId: string, opportunityId: string, action: OpportunityLifecycleAction, reasonCode?: string): Promise<{ readonly opportunity: { readonly id: string; readonly lifecycleState: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/${action.toLowerCase()}`,
    { token, method: 'POST', body: reasonCode ? { reasonCode } : {} });
}

/** The terms a student applied under (or last accepted), and the new ones they are asked to accept. */
export interface StudentTermsDto {
  readonly title: string;
  readonly employmentType: string;
  readonly workMode: string;
  readonly locationCity: string | null;
  readonly durationMonths: number | null;
  readonly compensation: { readonly currency: string; readonly min: string; readonly max: string | null; readonly period: string } | null;
  readonly joiningConditions: string | null;
  readonly applicationDeadline: string | null;
  readonly eligibility: readonly EligibilityRuleDto[];
}

export interface StudentTermsChangeDto {
  readonly toVersionId: string;
  readonly employerName: string;
  readonly changedTerms: readonly string[];
  readonly appliedTerms: StudentTermsDto;
  readonly newTerms: StudentTermsDto;
}

export function readTermsChange(token: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly termsChange: StudentTermsChangeDto | null }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/terms-change`, { token, ...(signal ? { signal } : {}) });
}

export function respondToTermsChange(token: string, applicationId: string, decision: 'acknowledge' | 'decline', toVersionId: string): Promise<{ readonly application: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/terms-change/${decision}`, { token, method: 'POST', body: { toVersionId } });
}

// --- Eligibility, skills and stages (EMP-06) --------------------------------

export interface SkillCatalogueDto {
  readonly skills: readonly { readonly taxonomyTopicId: string; readonly name: string }[];
  readonly nextCursor: string | null;
  readonly careerRoles: readonly { readonly id: string; readonly code: string; readonly title: string; readonly family: string }[];
}

/** The ONE skill catalogue (OPS-08) a recruiter picks from; `q` filters skills and roles by name. */
export function searchSkillCatalogue(token: string, employerId: string, q: string, signal?: AbortSignal): Promise<SkillCatalogueDto> {
  const query = q.trim() ? `?q=${encodeURIComponent(q.trim().slice(0, 80))}` : '';
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/skill-catalogue${query}`, { token, ...(signal ? { signal } : {}) });
}

// --- Consented application snapshot and candidate view (EMP-07) --------------

export interface SnapshotLinkDto { readonly label: string | null; readonly url: string }
export interface SnapshotResumeDto { readonly title: string; readonly filename: string; readonly versionNumber: number; readonly contentType: string; readonly byteSize: number }

/** What the student shares with one employer at apply: their own words and records, never readiness or figures. */
export interface ApplicationSnapshotDto {
  readonly schemaVersion: number;
  readonly candidate: { readonly fullName: string | null; readonly email: string | null; readonly phone: string | null; readonly contactVisibleFrom?: string | null };
  readonly education: { readonly institutionName: string | null; readonly programmeName: string | null; readonly departmentName: string | null; readonly expectedGraduationYear: number | null } | null;
  readonly qualifications: readonly {
    readonly qualificationType: string; readonly programmeName: string; readonly institutionName: string | null;
    readonly startedYear: number | null; readonly completedYear: number | null; readonly awarded: boolean; readonly verification: string;
  }[];
  readonly profile: { readonly headline: string | null; readonly summary: string | null };
  readonly links: readonly SnapshotLinkDto[];
  readonly resume: SnapshotResumeDto | null;
}

export interface ResumeOptionDto { readonly documentId: string; readonly title: string; readonly versionNumber: number; readonly filename: string; readonly contentType: string; readonly byteSize: number }

export interface ApplicationPreviewDto {
  readonly employerName: string;
  readonly snapshot: ApplicationSnapshotDto;
  readonly snapshotHash: string;
  readonly resumeOptions: readonly ResumeOptionDto[];
  /** EMP-13: the student's verified evidence per job skill, to choose from. Absent from older API responses. */
  readonly evidence?: { readonly available: boolean; readonly skills: readonly EvidenceSkillDto<EvidenceChoiceDto>[] };
}

// ---------------------------------------------------------------------------
// EMP-13: consented, per-skill verified evidence (ADR-043)
// ---------------------------------------------------------------------------

/** One evidence item: exactly what the employer is shown. Never marks, a stage or a score. */
export interface EvidenceItemDto {
  readonly type: string;
  /** ONE_SKILL_CHECK, INSTITUTION_EXAM or ONE_RECORD. */
  readonly source: string;
  readonly occurredAt: string;
  readonly unaided: boolean;
}
/** The student's own item, with the id they choose it by and whether it is shared now. */
export interface EvidenceChoiceDto extends EvidenceItemDto {
  readonly evidenceId: string;
  readonly shared?: boolean;
  readonly sharedAt?: string | null;
}
export interface EvidenceSkillDto<T> {
  readonly name: string;
  readonly level: string;
  /** False for a free-text skill: evidence cannot be matched to it. */
  readonly catalogue: boolean;
  readonly items: readonly T[];
}
export interface StudentApplicationEvidenceDto {
  readonly available: boolean;
  readonly canShare: boolean;
  readonly employerName: string;
  readonly skills: readonly EvidenceSkillDto<EvidenceChoiceDto>[];
}
export interface EmployerCandidateEvidenceDto {
  readonly available: boolean;
  readonly skills: readonly EvidenceSkillDto<EvidenceItemDto & { readonly sharedAt: string }>[];
}

export function getMyApplicationEvidence(token: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly evidence: StudentApplicationEvidenceDto }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/evidence`, { token, ...(signal ? { signal } : {}) });
}

/** Replaces what is shared on the application: anything left out is taken back at once. */
export function setMyApplicationEvidence(token: string, applicationId: string, evidenceRecordIds: readonly string[]): Promise<{ readonly evidence: StudentApplicationEvidenceDto }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/evidence`, { token, method: 'PUT', body: { evidenceRecordIds } });
}

export function getEmployerCandidateEvidence(token: string, employerId: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly evidence?: EmployerCandidateEvidenceDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/evidence`, { token, ...(signal ? { signal } : {}) });
}

/** The student's choices for one application. Every field is optional. */
export interface SnapshotChoicesInput {
  readonly resumeDocumentId?: string;
  readonly contactPhone?: string;
  readonly links?: readonly { readonly url: string; readonly label?: string }[];
}

export function previewApplication(token: string, opportunityId: string, choices: SnapshotChoicesInput = {}): Promise<{ readonly preview: ApplicationPreviewDto }> {
  return requestJson('/api/v1/students/me/application-previews', { token, method: 'POST', body: { opportunityId, ...choices } });
}

/** Applying with the reviewed snapshot: the API refuses (SNAPSHOT_CHANGED) if what would be shared changed since. */
export function applyWithSnapshot(token: string, opportunityId: string, institutionVisibilityGranted: boolean, choices: SnapshotChoicesInput, reviewedSnapshotHash: string,
  evidenceRecordIds: readonly string[] = []): Promise<{ readonly application: { readonly id: string; readonly state: string } }> {
  // EMP-13: evidence chosen for this application is sent only when there is some.
  return requestJson('/api/v1/students/me/applications', { token, method: 'POST', body: { opportunityId, consentGranted: true, institutionVisibilityGranted, ...choices, reviewedSnapshotHash,
    ...(evidenceRecordIds.length ? { evidenceRecordIds } : {}) } });
}

export function getMyApplicationSnapshot(token: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly snapshot: { readonly content: ApplicationSnapshotDto; readonly snapshotHash: string; readonly sharedAt: string } | null }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/snapshot`, { token, ...(signal ? { signal } : {}) });
}

export interface CandidateDetailDto {
  readonly application: {
    readonly id: string; readonly opportunityId: string; readonly state: string; readonly title: string;
    readonly appliedVersionNumber: number; readonly currentVersionNumber: number | null;
    readonly submittedAt: string | null; readonly closedAt: string | null; readonly updatedAt: string;
    readonly termsAcknowledgementPending: boolean;
  };
  readonly snapshot: ApplicationSnapshotDto | null;
  /** SHARED, NOT_CAPTURED (applied before snapshots existed), ERASED (account deleted) or UNREADABLE. */
  readonly snapshotStatus: string;
  readonly sharedAt: string | null;
  readonly resumeAvailable: boolean;
  readonly eligibility: ApplicantEligibilityDto | null;
  readonly timeline: readonly { readonly fromState: string | null; readonly toState: string; readonly actor: string | null; readonly reasonCode: string | null; readonly occurredAt: string }[];
  readonly interviews: readonly { readonly roundNumber: number; readonly mode: string; readonly state: string; readonly scheduledStart: string | null; readonly scheduledEnd: string | null; readonly scorecardCount: number }[];
  readonly offer: { readonly state: string; readonly compensation: CompensationDto | null; readonly joiningDate: string | null; readonly expiresAt: string | null; readonly extendedAt: string | null; readonly respondedAt: string | null } | null;
}

export function getEmployerCandidate(token: string, employerId: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly candidate: CandidateDetailDto }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}`, { token, ...(signal ? { signal } : {}) });
}

/**
 * Downloads the candidate's résumé: asks for a single-use link (audited), then redeems it at once
 * with the same identity (audited again). Returns the bytes and the file name for the caller to save.
 */
export async function downloadCandidateResume(token: string, employerId: string, applicationId: string): Promise<{ readonly blob: Blob; readonly filename: string }> {
  const { download } = await requestJson<{ readonly download: { readonly path: string; readonly expiresAt: string } }>(
    `/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/resume`, { token });
  const correlationId = crypto.randomUUID();
  const response = await fetch(`${apiBaseUrl}${download.path}`, { headers: { Authorization: `Bearer ${token}`, 'X-Correlation-Id': correlationId } });
  if (!response.ok) throw new ApiRequestError({ status: response.status, correlationId: response.headers?.get('x-correlation-id') ?? correlationId });
  const disposition = response.headers?.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'resume';
  return { blob: await response.blob(), filename };
}

// ---------------------------------------------------------------------------
// EMP-10: application-bound messages
// ---------------------------------------------------------------------------

/** One message as either side sees it. Never the sender's identity; `mine` says whether you wrote it. */
export interface ConversationMessageDto {
  readonly id: string;
  readonly from: 'EMPLOYER' | 'STUDENT';
  readonly mine: boolean;
  /** Null once erased (account deletion or the retention period). */
  readonly body: string | null;
  /** The text looks like it carries a link. Shown as plain text with a warning, never as a link. */
  readonly containsLink: boolean;
  readonly sentAt: string;
  readonly readAt: string | null;
  readonly erased: boolean;
  /** Student side only: when you reported this employer message. */
  readonly reportedAt?: string | null;
}

export interface EmployerConversationDto {
  readonly applicationId: string;
  readonly applicationState: string;
  readonly title: string;
  readonly started: boolean;
  readonly startedAt: string | null;
  readonly canSend: boolean;
  readonly sendBlockedReason: 'APPLICATION_CLOSED' | 'NOT_SHORTLISTED' | null;
  readonly messages: readonly ConversationMessageDto[];
  readonly hasEarlier: boolean;
}

export interface StudentConversationDto {
  readonly applicationId: string;
  readonly employerName: string;
  readonly title: string;
  readonly started: boolean;
  readonly startedAt: string | null;
  readonly muted: boolean;
  readonly canReply: boolean;
  readonly replyBlockedReason: 'NOT_STARTED' | 'ACCESS_ENDED' | null;
  readonly messages: readonly ConversationMessageDto[];
  readonly hasEarlier: boolean;
}

export interface MessageThreadSummaryDto {
  readonly applicationId: string;
  readonly opportunityId: string;
  readonly title: string;
  readonly referenceCode: string | null;
  readonly candidateName: string | null;
  readonly applicationState: string;
  readonly startedAt: string;
  readonly lastMessageAt: string;
  readonly lastFrom: 'EMPLOYER' | 'STUDENT' | null;
  readonly messageCount: number;
  readonly unreadCount: number;
}

export const messageReportReasons = [
  { code: 'SCAM_OR_PAYMENT_REQUEST', label: 'Asked me for money or a fee' },
  { code: 'OFF_PLATFORM_PRESSURE', label: 'Pushed me to talk outside ONE' },
  { code: 'HARASSMENT', label: 'Harassment or threats' },
  { code: 'INAPPROPRIATE_CONTENT', label: 'Inappropriate content' },
  { code: 'DISCRIMINATION', label: 'Discrimination' },
  { code: 'OTHER', label: 'Something else' },
] as const;
export type MessageReportReason = typeof messageReportReasons[number]['code'];

const messagesPath = (employerId: string, applicationId: string) =>
  `/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/messages`;
const studentMessagesPath = (applicationId: string) => `/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/messages`;

export function listEmployerMessageThreads(token: string, employerId: string, cursor?: string, signal?: AbortSignal): Promise<{
  readonly threads: readonly MessageThreadSummaryDto[]; readonly withheldCount: number; readonly nextCursor: string | null;
}> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/message-threads${query}`, { token, ...(signal ? { signal } : {}) });
}

export function getEmployerConversation(token: string, employerId: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly conversation: EmployerConversationDto }> {
  return requestJson(messagesPath(employerId, applicationId), { token, ...(signal ? { signal } : {}) });
}

export function sendEmployerMessage(token: string, employerId: string, applicationId: string, body: string): Promise<{ readonly message: ConversationMessageDto }> {
  return requestJson(messagesPath(employerId, applicationId), { token, method: 'POST', body: { body } });
}

export function getStudentConversation(token: string, applicationId: string, signal?: AbortSignal): Promise<{ readonly conversation: StudentConversationDto }> {
  return requestJson(studentMessagesPath(applicationId), { token, ...(signal ? { signal } : {}) });
}

export function sendStudentMessage(token: string, applicationId: string, body: string): Promise<{ readonly message: ConversationMessageDto }> {
  return requestJson(studentMessagesPath(applicationId), { token, method: 'POST', body: { body } });
}

export function muteConversation(token: string, applicationId: string, muted: boolean): Promise<{ readonly conversation: { readonly applicationId: string; readonly muted: boolean } }> {
  return requestJson(`${studentMessagesPath(applicationId)}/mute`, { token, method: 'POST', body: { muted } });
}

export function reportMessage(token: string, applicationId: string, messageId: string, reasonCode: MessageReportReason, statement?: string): Promise<{ readonly report: { readonly messageId: string; readonly reportedAt: string } }> {
  return requestJson(`${studentMessagesPath(applicationId)}/${encodeURIComponent(messageId)}/report`, {
    token, method: 'POST', body: statement ? { reasonCode, statement } : { reasonCode },
  });
}
