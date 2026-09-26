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
  /** EMP-04: the hiring company's profile. Absent from older API responses. */
  readonly company?: OpportunityCompanyDto;
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
}> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/opportunities/${encodeURIComponent(opportunityId)}`, { token, ...(signal ? { signal } : {}) });
}

export function createOpportunityVersion(token: string, employerId: string, opportunityId: string, body: Record<string, unknown>): Promise<{
  readonly version: { readonly id: string; readonly versionNumber: number; readonly change: 'EDITORIAL' | 'MATERIAL'; readonly changedTerms: readonly string[] };
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
  readonly eligibility: readonly { readonly ruleType: string; readonly comparator: string; readonly valueNumeric: number | null; readonly valueText: string | null; readonly isBlocking: boolean }[];
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
