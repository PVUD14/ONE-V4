/**
 * ONE · API client — Stream B — Hiring
 *
 * Opportunities, applications, interviews and offers — student and employer sides.
 *
 * Split out of the single api.ts client so each stream appends to its own
 * file. `api.ts` re-exports every public module, so importers are unchanged.
 */
import { requestJson } from './http.js';

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
}

export interface OpportunityDetailDto extends OpportunitySummaryDto {
  readonly responsibilities: string | null;
  readonly positionsAvailable: number | null;
  readonly joiningConditions: string | null;
  readonly skills: readonly { readonly name: string; readonly level: string }[];
  readonly selectionStages: readonly { readonly order: number; readonly kind: string; readonly label: string; readonly detail: string | null }[];
}

export interface EligibilityDto {
  readonly eligible: boolean;
  readonly blockingFailures: readonly string[];
  readonly advisoryFailures: readonly string[];
  readonly needsMoreInformation: readonly string[];
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
  readonly applicationCount: number;
  readonly openApplicationCount: number;
}

export interface EmployerApplicantDto {
  readonly id: string;
  readonly state: string;
  readonly consentRevoked: boolean;
  readonly candidateName: string | null;
  readonly candidateEmail: string | null;
  readonly institutionStudentId: string | null;
  readonly submittedAt: string | null;
  readonly closedAt: string | null;
  readonly interviewCount: number;
  readonly offerState: string | null;
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
  readonly candidateName: string | null;
  readonly candidateEmail: string | null;
  readonly institutionStudentId: string | null;
  readonly roundNumber: number;
  readonly mode: string;
  readonly state: string;
  readonly scheduledStart: string | null;
  readonly scheduledEnd: string | null;
  readonly locationDetail: string | null;
  readonly joiningLink: string | null;
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

export function getOpportunity(token: string, opportunityId: string, signal?: AbortSignal): Promise<{ readonly opportunity: OpportunityDetailDto; readonly eligibility: EligibilityDto }> {
  return requestJson(`/api/v1/opportunities/${encodeURIComponent(opportunityId)}`, { token, ...(signal ? { signal } : {}) });
}

export function listStudentApplications(token: string, signal?: AbortSignal): Promise<{ readonly applications: readonly StudentApplicationDto[] }> {
  return requestJson('/api/v1/students/me/applications', { token, ...(signal ? { signal } : {}) });
}

export function applyToOpportunity(token: string, opportunityId: string, institutionVisibilityGranted = false): Promise<{ readonly application: { readonly id: string; readonly state: string } }> {
  return requestJson('/api/v1/students/me/applications', { token, method: 'POST', body: { opportunityId, consentGranted: true, institutionVisibilityGranted } });
}

export function revokeInstitutionVisibility(token: string, applicationId: string): Promise<{ readonly ok: boolean }> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/institution-visibility/revoke`, { token, method: 'POST' });
}

export function withdrawApplication(token: string, applicationId: string, reason?: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/v1/students/me/applications/${encodeURIComponent(applicationId)}/withdraw`, { token, method: 'POST', body: reason ? { reason } : {} });
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

export function listEmployerApplicants(token: string, employerId: string, opportunityId: string, signal?: AbortSignal): Promise<{ readonly applications: readonly EmployerApplicantDto[] }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}/applications`, { token, ...(signal ? { signal } : {}) });
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
  readonly candidateName: string | null;
  readonly candidateEmail: string | null;
  readonly institutionStudentId: string | null;
  readonly locationDetail: string | null;
  readonly joiningLink: string | null;
  readonly summary: string | null;
  readonly responsibilities: string | null;
  readonly canRecordOutcome: boolean;
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

export interface InterviewStateInput {
  readonly toState: 'RESCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  readonly reason?: string;
  readonly scheduledStart?: string;
  readonly scheduledEnd?: string;
}

export interface InterviewOutcomeInput {
  readonly recommendation: 'STRONG_YES' | 'YES' | 'NEUTRAL' | 'NO' | 'STRONG_NO';
  readonly overallRating?: number;
  readonly strengths?: string;
  readonly concerns?: string;
  readonly notes?: string;
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
