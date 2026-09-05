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
  readonly updatedAt: string;
  readonly termsAcknowledgementPending: boolean;
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

export function applyToOpportunity(token: string, opportunityId: string): Promise<{ readonly application: { readonly id: string; readonly state: string } }> {
  return requestJson('/api/v1/students/me/applications', { token, method: 'POST', body: { opportunityId, consentGranted: true } });
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

export function transitionApplication(token: string, employerId: string, applicationId: string, toState: string, note?: string): Promise<{ readonly application: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/transition`, { token, method: 'POST', body: { toState, ...(note ? { note } : {}) } });
}

export function scheduleInterview(token: string, employerId: string, applicationId: string, body: unknown): Promise<{ readonly interview: { readonly id: string; readonly state: string; readonly roundNumber: number } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/interviews`, { token, method: 'POST', body });
}

export function extendOffer(token: string, employerId: string, applicationId: string, body: unknown): Promise<{ readonly offer: { readonly id: string; readonly state: string } }> {
  return requestJson(`/api/v1/employers/${encodeURIComponent(employerId)}/applications/${encodeURIComponent(applicationId)}/offers`, { token, method: 'POST', body });
}
