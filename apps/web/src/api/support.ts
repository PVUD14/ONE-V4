/**
 * ONE · API client — Operations Support (OPS-05).
 *
 * The support case desk and the minimised account lookup. Contacts arrive masked; the
 * full value only comes back from `revealSupportContact`, which the server audits with
 * the reason code given.
 */
import { requestJson } from './http.js';

export type SupportCaseState = 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';

export interface SupportPolicyDto {
  readonly viewer: { readonly cases: boolean; readonly accountLookup: boolean };
  readonly channels: readonly string[];
  readonly categories: readonly string[];
  readonly severities: readonly string[];
  readonly slaHours: Readonly<Record<string, number>>;
  readonly transitions: Readonly<Record<SupportCaseState, readonly SupportCaseState[]>>;
  readonly reasons: {
    readonly open: readonly string[];
    readonly transition: Readonly<Record<string, readonly string[]>>;
    readonly note: readonly string[];
    readonly assign: readonly string[];
    readonly reveal: readonly string[];
  };
  readonly assignees: readonly { readonly userId: string; readonly email: string; readonly isSelf: boolean }[];
  readonly correlationId: string;
}

export interface SupportCaseDto {
  readonly id: string;
  readonly reference: string;
  readonly channel: string;
  readonly category: string;
  readonly severity: string;
  readonly state: SupportCaseState;
  readonly summary: string;
  readonly summaryRedacted: boolean;
  readonly organization: { readonly id: string; readonly name: string } | null;
  readonly subject: { readonly userId: string; readonly maskedEmail: string | null } | null;
  readonly subjectDetached: boolean;
  readonly assignee: { readonly email: string; readonly isSelf: boolean; readonly userId?: string } | null;
  readonly openedBy: { readonly email: string };
  readonly openedAt: string;
  readonly slaDueAt: string;
  readonly overdue: boolean;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
}

export interface SupportCaseEventDto {
  readonly id: string;
  readonly kind: 'OPENED' | 'STATE_CHANGED' | 'NOTE' | 'ASSIGNED';
  readonly fromState: SupportCaseState | null;
  readonly toState: SupportCaseState | null;
  readonly assignee: { readonly email: string } | null;
  readonly note: string | null;
  readonly noteRedacted: boolean;
  readonly linkedCorrelationId: string | null;
  readonly reasonCode: string;
  readonly actor: { readonly email: string };
  readonly correlationId: string;
  readonly occurredAt: string;
}

export interface SupportCaseDetailDto extends SupportCaseDto {
  readonly events: readonly SupportCaseEventDto[];
  readonly allowedTransitions: readonly SupportCaseState[];
}

export interface SupportCaseQueueDto {
  readonly cases: readonly SupportCaseDto[];
  readonly nextCursor: string | null;
  readonly summary: { readonly open: number; readonly inProgress: number; readonly waitingOnCustomer: number; readonly overdue: number; readonly unassigned: number; readonly mine: number };
  readonly correlationId: string;
}

export interface SupportCaseFilters {
  readonly view?: string;
  readonly severity?: string;
  readonly category?: string;
  readonly assignee?: string;
  readonly subjectUserId?: string;
  readonly overdue?: boolean;
}

export interface SupportAccountSummaryDto {
  readonly userId: string;
  readonly maskedEmail: string | null;
  readonly state: string;
  readonly identityLinked: boolean;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly membershipCount: number;
}

export interface SupportAccountDto {
  readonly account: SupportAccountSummaryDto & { readonly maskedPhone: string | null };
  readonly memberships: readonly { readonly organizationId: string; readonly organizationName: string; readonly organizationKind: string; readonly role: string; readonly state: string }[];
  readonly studentRelationships: readonly { readonly institutionName: string; readonly state: string; readonly effectiveFrom: string | null; readonly effectiveTo: string | null }[];
  readonly invitations: readonly { readonly organizationName: string | null; readonly role: string | null; readonly kind: string; readonly state: string; readonly deliveryState: string | null; readonly createdAt: string; readonly expiresAt: string }[];
  readonly cases: readonly { readonly id: string; readonly reference: string; readonly state: SupportCaseState; readonly category: string; readonly openedAt: string }[];
  readonly timeline: readonly { readonly action: string; readonly outcome: string; readonly resourceType: string; readonly occurredAt: string; readonly correlationId: string; readonly byThisUser: boolean }[];
  readonly canOpenCase: boolean;
  readonly correlationId: string;
}

const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});

export function getSupportPolicy(token: string, signal?: AbortSignal): Promise<SupportPolicyDto> {
  return requestJson('/api/v1/operations/support/policy', { token, ...signalOf(signal) });
}

export function listSupportCases(token: string, filters: SupportCaseFilters = {}, cursor?: string | null, signal?: AbortSignal): Promise<SupportCaseQueueDto> {
  const query = new URLSearchParams();
  if (filters.view) query.set('view', filters.view);
  if (filters.severity) query.set('severity', filters.severity);
  if (filters.category) query.set('category', filters.category);
  if (filters.assignee) query.set('assignee', filters.assignee);
  if (filters.subjectUserId) query.set('subjectUserId', filters.subjectUserId);
  if (filters.overdue) query.set('overdue', 'true');
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/support/cases${suffix}`, { token, ...signalOf(signal) });
}

export function getSupportCase(token: string, caseId: string, signal?: AbortSignal): Promise<{ readonly case: SupportCaseDetailDto; readonly correlationId: string }> {
  return requestJson(`/api/v1/operations/support/cases/${encodeURIComponent(caseId)}`, { token, ...signalOf(signal) });
}

export function openSupportCase(token: string, body: {
  readonly channel: string; readonly category: string; readonly severity: string; readonly summary: string; readonly reasonCode: string;
  readonly subjectUserId?: string; readonly organizationId?: string; readonly assignToMe?: boolean;
}): Promise<{ readonly case: SupportCaseDetailDto; readonly correlationId: string }> {
  return requestJson('/api/v1/operations/support/cases', { token, method: 'POST', body });
}

export function transitionSupportCase(token: string, caseId: string, body: { readonly toState: SupportCaseState; readonly reasonCode: string; readonly note?: string }): Promise<{ readonly case: SupportCaseDetailDto }> {
  return requestJson(`/api/v1/operations/support/cases/${encodeURIComponent(caseId)}/transition`, { token, method: 'POST', body });
}

export function addSupportCaseNote(token: string, caseId: string, body: { readonly note: string; readonly reasonCode: string; readonly linkedCorrelationId?: string }): Promise<{ readonly case: SupportCaseDetailDto }> {
  return requestJson(`/api/v1/operations/support/cases/${encodeURIComponent(caseId)}/notes`, { token, method: 'POST', body });
}

export function assignSupportCase(token: string, caseId: string, body: { readonly assigneeUserId: string | null; readonly reasonCode: string }): Promise<{ readonly case: SupportCaseDetailDto }> {
  return requestJson(`/api/v1/operations/support/cases/${encodeURIComponent(caseId)}/assign`, { token, method: 'POST', body });
}

export function searchSupportAccounts(token: string, q: string, cursor?: string | null, signal?: AbortSignal): Promise<{ readonly accounts: readonly SupportAccountSummaryDto[]; readonly nextCursor: string | null; readonly correlationId: string }> {
  const query = new URLSearchParams({ q });
  if (cursor) query.set('cursor', cursor);
  return requestJson(`/api/v1/operations/support/accounts?${query.toString()}`, { token, ...signalOf(signal) });
}

export function getSupportAccount(token: string, userId: string, signal?: AbortSignal): Promise<SupportAccountDto> {
  return requestJson(`/api/v1/operations/support/accounts/${encodeURIComponent(userId)}`, { token, ...signalOf(signal) });
}

export function revealSupportContact(token: string, userId: string, body: { readonly reasonCode: string; readonly caseId?: string }): Promise<{ readonly contact: { readonly email: string; readonly phone: string | null } }> {
  return requestJson(`/api/v1/operations/support/accounts/${encodeURIComponent(userId)}/contact-reveal`, { token, method: 'POST', body });
}
