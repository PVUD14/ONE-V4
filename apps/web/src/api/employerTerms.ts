/**
 * ONE · API client — employer terms, Settings and trust-case participation (EMP-16).
 *
 * The employer side (Settings, terms acceptance, trust cases about the employer) and the
 * operations side (publishing a terms version, asking an employer to respond, sharing a summary,
 * and the case timeline). Kept in its own file so the goal's client surface is in one place.
 */
import { requestJson } from './http.js';

export type EmployerTermsStatus = 'NO_TERMS_PUBLISHED' | 'ACCEPTED' | 'ACCEPTANCE_REQUIRED';
export type EmployerTermsLegalReviewState = 'DRAFT_FOR_LEGAL_REVIEW' | 'LEGAL_APPROVED';

export interface EmployerTermsVersionDto {
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly legalReviewState: EmployerTermsLegalReviewState;
  readonly legalReviewReference: string | null;
  readonly requiresReacceptance: boolean;
  readonly changeSummary: string | null;
  readonly publishedAt: string;
}

export interface EmployerSettingsDto {
  readonly terms: {
    readonly status: EmployerTermsStatus;
    readonly current: EmployerTermsVersionDto | null;
    readonly required: { readonly version: string; readonly publishedAt: string } | null;
    readonly latestAcceptance: { readonly version: string; readonly acceptedAt: string; readonly acceptedBy: string | null } | null;
    readonly currentVersionAccepted: boolean;
    readonly canAccept: boolean;
  };
  readonly retention: {
    readonly accessEndsWhen: readonly string[];
    readonly resumeLinkSeconds: number;
    readonly messageRetentionDaysAfterAccessEnds: number;
    readonly candidateDeletionGraceDays: number;
    readonly heldForOpenTrustCasesAndLegalHolds: boolean;
  };
  readonly notificationPreferences: NotificationPreferencesDto | null;
  readonly notificationDefaults: NotificationPreferencesDto;
}

export interface NotificationPreferencesDto {
  readonly emailEnabled: boolean;
  readonly quietHoursStartMinute: number;
  readonly quietHoursEndMinute: number;
  readonly dailyCap: number;
}

export type EmployerTrustCaseStatus = 'UNDER_REVIEW' | 'RESPONSE_REQUESTED' | 'DECIDED' | 'APPEAL_UNDER_REVIEW' | 'CLOSED' | 'CLOSED_NO_ACTION';

export interface EmployerTrustCaseDto {
  readonly id: string;
  readonly caseType: string;
  readonly status: EmployerTrustCaseStatus;
  readonly subject: { readonly kind: 'ORGANIZATION' } | { readonly kind: 'JOB'; readonly jobTitle: string | null; readonly jobVersion: number | null };
  readonly responseRequestedAt: string | null;
  readonly decidedAt: string | null;
  readonly canRespond: boolean;
  readonly canAppeal: boolean;
}

export interface EmployerTrustCaseDetailDto extends EmployerTrustCaseDto {
  readonly statements: readonly { readonly kind: 'ALLEGATION_SUMMARY' | 'DECISION_SUMMARY' | 'EMPLOYER_RESPONSE' | 'EMPLOYER_APPEAL'; readonly body: string; readonly createdAt: string }[];
  readonly actions: readonly { readonly action: string; readonly effectiveFrom: string; readonly effectiveTo: string | null; readonly reversed: boolean }[];
  readonly evidence: {
    readonly shared: readonly { readonly kind: 'DETECTOR_SIGNAL' | 'JOB_VERSION'; readonly signalCode?: string; readonly jobTitle: string | null; readonly jobVersion: number | null }[];
    readonly withheldCount: number;
  };
}

const employerPath = (employerId: string) => `/api/v1/employers/${encodeURIComponent(employerId)}`;

export function getEmployerSettings(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly settings: EmployerSettingsDto }> {
  return requestJson(`${employerPath(employerId)}/settings`, { token, ...(signal ? { signal } : {}) });
}

export function acceptEmployerTerms(token: string, employerId: string, version: string): Promise<{ readonly settings: EmployerSettingsDto }> {
  return requestJson(`${employerPath(employerId)}/terms/accept`, { token, method: 'POST', body: { version } });
}

export function updateEmployerNotificationPreferences(token: string, employerId: string, changes: Partial<NotificationPreferencesDto>): Promise<{ readonly settings: EmployerSettingsDto }> {
  return requestJson(`${employerPath(employerId)}/settings/notification-preferences`, { token, method: 'POST', body: changes });
}

export function listEmployerTrustCases(token: string, employerId: string, signal?: AbortSignal): Promise<{ readonly cases: readonly EmployerTrustCaseDto[] }> {
  return requestJson(`${employerPath(employerId)}/trust-cases`, { token, ...(signal ? { signal } : {}) });
}

export function getEmployerTrustCase(token: string, employerId: string, caseId: string, signal?: AbortSignal): Promise<{ readonly case: EmployerTrustCaseDetailDto }> {
  return requestJson(`${employerPath(employerId)}/trust-cases/${encodeURIComponent(caseId)}`, { token, ...(signal ? { signal } : {}) });
}

export function answerEmployerTrustCase(token: string, employerId: string, caseId: string, kind: 'response' | 'appeal', statement: string): Promise<{ readonly case: EmployerTrustCaseDetailDto }> {
  return requestJson(`${employerPath(employerId)}/trust-cases/${encodeURIComponent(caseId)}/${kind}`, { token, method: 'POST', body: { statement } });
}

// --- Operations ------------------------------------------------------------------

export interface OperatorEmployerTermsVersionDto extends EmployerTermsVersionDto {
  readonly acceptedBy: number;
}

export function listOperatorEmployerTerms(token: string, signal?: AbortSignal): Promise<{ readonly versions: readonly OperatorEmployerTermsVersionDto[] }> {
  return requestJson('/api/v1/operations/employer-terms', { token, ...(signal ? { signal } : {}) });
}

export function publishOperatorEmployerTerms(token: string, body: {
  readonly version: string; readonly title: string; readonly body: string; readonly legalReviewState: EmployerTermsLegalReviewState;
  readonly legalReviewReference?: string; readonly requiresReacceptance: boolean; readonly changeSummary?: string; readonly reasonCode: string;
}): Promise<{ readonly version: EmployerTermsVersionDto }> {
  return requestJson('/api/v1/operations/employer-terms', { token, method: 'POST', body });
}

export interface OperatorTrustCaseTimelineDto {
  readonly id: string;
  readonly state: string;
  readonly subjectEmployerId: string | null;
  readonly events: readonly { readonly id: string; readonly from_state: string; readonly to_state: string; readonly reason_code: string; readonly occurred_at: string; readonly actor_user_id: string }[];
  readonly employerStatements: readonly { readonly id: string; readonly kind: string; readonly authorSide: 'OPERATIONS' | 'EMPLOYER'; readonly body: string; readonly authorEmail: string | null; readonly createdAt: string }[];
}

export function getOperatorTrustCase(token: string, caseId: string, signal?: AbortSignal): Promise<{ readonly case: OperatorTrustCaseTimelineDto }> {
  return requestJson(`/api/v1/operations/trust-safety/cases/${encodeURIComponent(caseId)}`, { token, ...(signal ? { signal } : {}) });
}

export function requestEmployerTrustResponse(token: string, caseId: string, summary: string): Promise<{ readonly case: OperatorTrustCaseTimelineDto }> {
  return requestJson(`/api/v1/operations/trust-safety/cases/${encodeURIComponent(caseId)}/request-response`, { token, method: 'POST', body: { summary, reasonCode: 'RIGHT_OF_REPLY' } });
}

export function shareEmployerTrustStatement(token: string, caseId: string, kind: 'ALLEGATION_SUMMARY' | 'DECISION_SUMMARY', body: string): Promise<{ readonly case: OperatorTrustCaseTimelineDto }> {
  return requestJson(`/api/v1/operations/trust-safety/cases/${encodeURIComponent(caseId)}/employer-statements`, { token, method: 'POST', body: { kind, body } });
}
