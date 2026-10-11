/**
 * ONE · API client — external faculty review (OPS-10, ADR-037).
 *
 * Operator side (Content Management): grant or revoke CONTENT_REVIEW_EXTERNAL on a college faculty
 * membership, assign in-review drafts to a granted reviewer for a fixed period, withdraw an
 * assignment, and read the faculty decisions. Faculty side (institution portal): the caller's own
 * assignments in their college, the whitelisted draft while an assignment is open (never an answer
 * key), and an advisory decision. The server decides everything; nothing here approves or
 * publishes content.
 */
import { requestJson } from './http.js';

export type ExternalReviewStatus = 'OPEN' | 'DECIDED' | 'REVOKED' | 'EXPIRED' | 'CLOSED';
export type ExternalReviewDecision = 'APPROVE' | 'REQUEST_CHANGES';
export type ExternalReviewEntityType = 'TOPIC' | 'QUESTION' | 'LESSON';

export interface ExternalReviewPolicyDto {
  readonly viewer: { readonly read: boolean; readonly assign: boolean; readonly administer: boolean; readonly userId: string };
  readonly reasons: {
    readonly grant: readonly string[];
    readonly revoke: readonly string[];
    readonly assign: readonly string[];
    readonly unassign: readonly string[];
    readonly decision: Readonly<Record<ExternalReviewDecision, readonly string[]>>;
  };
  readonly window: { readonly min: number; readonly max: number; readonly default: number };
  readonly limits: { readonly revisionsPerAssignment: number; readonly comment: number; readonly note: number };
  readonly correlationId: string;
}

export interface ExternalReviewerDto {
  readonly membershipId: string;
  readonly email: string;
  readonly institutionId: string;
  readonly institutionName: string;
  readonly role: string;
  readonly state: string;
  readonly grant: { readonly grantedAt: string; readonly reasonCode: string } | null;
  readonly openAssignments: number;
}

export interface ExternalReviewSummaryDto {
  readonly reviewers: number;
  readonly open: number;
  readonly approved: number;
  readonly changesRequested: number;
  readonly expired: number;
}

export interface ReviewableRevisionDto {
  readonly revisionId: string;
  readonly entityType: ExternalReviewEntityType;
  readonly stableKey: string;
  readonly title: string;
  readonly revision: number;
  readonly openAssignments: number;
  readonly decisions: { readonly approve: number; readonly requestChanges: number };
}

export interface ExternalReviewDecisionDto {
  readonly decision: ExternalReviewDecision;
  readonly reasonCode: string;
  readonly comment: string | null;
  readonly decidedAt: string;
}

export interface ExternalReviewAssignmentDto {
  readonly id: string;
  readonly status: ExternalReviewStatus;
  readonly revision: { readonly id: string; readonly entityType: ExternalReviewEntityType; readonly stableKey: string; readonly title: string; readonly revision: number; readonly state: string };
  readonly reviewer: { readonly membershipId: string; readonly email: string; readonly institutionName: string; readonly role: string; readonly eligible: boolean };
  readonly assignedBy: string;
  readonly assignedAt: string;
  readonly expiresAt: string;
  readonly reasonCode: string;
  readonly decision: ExternalReviewDecisionDto | null;
  readonly revoked: { readonly reasonCode: string; readonly revokedAt: string } | null;
}

const ops = '/api/v1/operations/external-reviews';
const options = (token: string, signal?: AbortSignal) => ({ token, ...(signal ? { signal } : {}) });

export function getExternalReviewPolicy(token: string, signal?: AbortSignal): Promise<ExternalReviewPolicyDto> {
  return requestJson(`${ops}/policy`, options(token, signal));
}

export function listExternalReviewers(token: string, signal?: AbortSignal): Promise<{
  readonly reviewers: readonly ExternalReviewerDto[]; readonly nextCursor: string | null; readonly summary: ExternalReviewSummaryDto; readonly correlationId: string;
}> {
  return requestJson(`${ops}/reviewers`, options(token, signal));
}

export function lookupExternalReviewer(token: string, email: string): Promise<{ readonly candidates: readonly ExternalReviewerDto[]; readonly correlationId: string }> {
  return requestJson(`${ops}/reviewers/lookup?email=${encodeURIComponent(email)}`, { token });
}

export function grantExternalReviewer(token: string, membershipId: string, body: { readonly reasonCode: string; readonly note?: string }): Promise<{ readonly reviewer: ExternalReviewerDto; readonly correlationId: string }> {
  return requestJson(`${ops}/reviewers/${encodeURIComponent(membershipId)}/grant`, { token, method: 'POST', body });
}

export function revokeExternalReviewer(token: string, membershipId: string, body: { readonly reasonCode: string; readonly note?: string }): Promise<{
  readonly reviewer: ExternalReviewerDto & { readonly closedAssignments: number }; readonly correlationId: string;
}> {
  return requestJson(`${ops}/reviewers/${encodeURIComponent(membershipId)}/revoke`, { token, method: 'POST', body });
}

export function listReviewableRevisions(token: string, q = '', signal?: AbortSignal): Promise<{ readonly revisions: readonly ReviewableRevisionDto[]; readonly correlationId: string }> {
  return requestJson(`${ops}/revisions${q ? `?q=${encodeURIComponent(q)}` : ''}`, options(token, signal));
}

export function listExternalReviewAssignments(token: string, query: { readonly status?: ExternalReviewStatus; readonly cursor?: string } = {}, signal?: AbortSignal): Promise<{
  readonly assignments: readonly ExternalReviewAssignmentDto[]; readonly nextCursor: string | null; readonly correlationId: string;
}> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.toString();
  return requestJson(`${ops}/assignments${suffix ? `?${suffix}` : ''}`, options(token, signal));
}

export function assignExternalReviews(token: string, body: {
  readonly revisionIds: readonly string[]; readonly reviewerMembershipId: string; readonly days: number; readonly reasonCode: string;
}): Promise<{ readonly assignments: readonly ExternalReviewAssignmentDto[]; readonly correlationId: string }> {
  return requestJson(`${ops}/assignments`, { token, method: 'POST', body });
}

export function withdrawExternalReview(token: string, assignmentId: string, reasonCode: string): Promise<{ readonly assignment: ExternalReviewAssignmentDto; readonly correlationId: string }> {
  return requestJson(`${ops}/assignments/${encodeURIComponent(assignmentId)}/revoke`, { token, method: 'POST', body: { reasonCode } });
}

// ---------------------------------------------------------------------------
// Faculty side
// ---------------------------------------------------------------------------

export type FacultyReviewContentDto =
  | { readonly kind: 'SKILL'; readonly stableKey: string; readonly name: string; readonly description: string; readonly levels: readonly { readonly level: string; readonly descriptor: string }[]; readonly prerequisites: readonly string[]; readonly basis: string | null }
  | { readonly kind: 'QUESTION'; readonly stableKey: string; readonly skill: string | null; readonly prompt: string; readonly options: readonly { readonly id: string; readonly text: string }[]; readonly difficulty: string | null }
  | { readonly kind: 'LESSON'; readonly stableKey: string; readonly title: string; readonly summary: string; readonly practice: string | null; readonly variant: { readonly label: string; readonly language: string; readonly level: string; readonly style: string } | null; readonly prerequisites: readonly string[]; readonly basis: string | null };

export interface FacultyReviewDto {
  readonly id: string;
  readonly status: ExternalReviewStatus;
  readonly kind: 'SKILL' | 'QUESTION' | 'LESSON';
  readonly stableKey: string;
  readonly title: string | null;
  readonly assignedAt: string;
  readonly expiresAt: string;
  readonly decision: ExternalReviewDecisionDto | null;
  readonly content?: FacultyReviewContentDto | null;
}

const queue = (institutionId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}/content-reviews`;

export function listFacultyReviews(token: string, institutionId: string, signal?: AbortSignal): Promise<{
  readonly assignments: readonly FacultyReviewDto[];
  readonly decisions: readonly { readonly decision: ExternalReviewDecision; readonly reasons: readonly string[] }[];
  readonly limits: { readonly comment: number };
  readonly correlationId: string;
}> {
  return requestJson(queue(institutionId), options(token, signal));
}

export function getFacultyReview(token: string, institutionId: string, assignmentId: string): Promise<{ readonly review: FacultyReviewDto; readonly correlationId: string }> {
  return requestJson(`${queue(institutionId)}/${encodeURIComponent(assignmentId)}`, { token });
}

export function decideFacultyReview(token: string, institutionId: string, assignmentId: string, body: {
  readonly decision: ExternalReviewDecision; readonly reasonCode: string; readonly comment?: string;
}): Promise<{ readonly review: FacultyReviewDto; readonly correlationId: string }> {
  return requestJson(`${queue(institutionId)}/${encodeURIComponent(assignmentId)}/decision`, { token, method: 'POST', body });
}
