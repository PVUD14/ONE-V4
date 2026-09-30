/**
 * ONE · API client — Operations incident register and status communications (OPS-16).
 *
 * The incident register with its breach clock (Security) and the status-notice templates and
 * notices (Settings). The server computes every clock on the database clock and decides every
 * rule; this client only carries requests. A notice has no text field on purpose: it is only ever
 * an approved template version.
 */
import { requestJson } from './http.js';

export type IncidentState = 'OPEN' | 'CONTAINED' | 'RESOLVED' | 'CLOSED';
export type BreachClockStatus = 'RUNNING' | 'OVERDUE' | 'MET' | 'MET_LATE';

export interface IncidentPolicyDto {
  readonly categories: readonly string[];
  readonly severities: readonly string[];
  readonly states: readonly IncidentState[];
  readonly transitions: Readonly<Record<IncidentState, readonly IncidentState[]>>;
  readonly breachClock: { readonly hours: number; readonly basis: string; readonly basisText: string };
  readonly reasons: {
    readonly declare: readonly string[];
    readonly transition: Readonly<Record<IncidentState, readonly string[]>>;
    readonly closeFromOpen: readonly string[];
    readonly severity: readonly string[];
    readonly category: readonly string[];
    readonly note: readonly string[];
    readonly organizationAdd: readonly string[];
    readonly organizationRemove: readonly string[];
    readonly boardNotified: readonly string[];
    readonly usersNotified: readonly string[];
  };
  readonly correlationId: string;
}

export interface BreachClockDto {
  readonly hours: number;
  readonly basis: string;
  readonly deadlineAt: string;
  readonly status: BreachClockStatus;
  readonly remainingSeconds: number | null;
  readonly boardNotifiedAt: string | null;
  readonly boardNotifiedBy: string | null;
  readonly boardReference: string | null;
  readonly usersNotifiedAt: string | null;
  readonly usersNotifiedBy: string | null;
}

export interface IncidentDto {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly severity: string;
  readonly state: IncidentState;
  readonly detectedAt: string;
  readonly declaredAt: string;
  readonly declaredBy: string;
  readonly containedAt: string | null;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly affectedOrganizationsCount: number;
  readonly breachClock: BreachClockDto | null;
  readonly updatedAt: string;
}

export interface IncidentSummaryDto {
  readonly open: number;
  readonly openBreaches: number;
  readonly breachClocksRunning: number;
  readonly breachClocksOverdue: number;
}

export interface IncidentListDto {
  readonly incidents: readonly IncidentDto[];
  readonly nextCursor: string | null;
  readonly summary: IncidentSummaryDto;
  readonly correlationId: string;
}

export interface NoticeEmailCountsDto {
  readonly sent: number; readonly pending: number; readonly notConfigured: number; readonly failed: number; readonly bounced: number; readonly skipped: number;
}

export interface IncidentDetailDto {
  readonly incident: IncidentDto;
  readonly allowedTransitions: readonly IncidentState[];
  readonly timeline: readonly {
    readonly kind: string; readonly fromValue: string | null; readonly toValue: string | null; readonly organizationName: string | null;
    readonly noticeId: string | null; readonly note: string | null; readonly reasonCode: string; readonly actor: string; readonly occurredAt: string;
  }[];
  readonly organizations: readonly { readonly organizationId: string; readonly name: string; readonly kind: string; readonly addedAt: string; readonly removedAt: string | null }[];
  readonly notices: readonly {
    readonly id: string; readonly state: StatusNoticeState; readonly templateKey: string; readonly templateVersion: number; readonly subject: string;
    readonly approvedBy: string | null; readonly approvedAt: string | null; readonly approveMode?: 'DUAL' | 'SOLO' | null; readonly sentAt: string | null;
    readonly recipientCount: number | null; readonly organizationCount: number | null; readonly email: NoticeEmailCountsDto;
  }[];
  readonly correlationId: string;
}

const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});
const incidentPath = (id: string, suffix = '') => `/api/v1/operations/incidents/${encodeURIComponent(id)}${suffix}`;

export function getIncidentPolicy(token: string, signal?: AbortSignal): Promise<IncidentPolicyDto> {
  return requestJson('/api/v1/operations/incidents/policy', { token, ...signalOf(signal) });
}

export function listIncidents(token: string, filters: { readonly view?: string; readonly category?: string } = {}, cursor?: string | null, signal?: AbortSignal): Promise<IncidentListDto> {
  const query = new URLSearchParams();
  if (filters.view) query.set('view', filters.view);
  if (filters.category) query.set('category', filters.category);
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/incidents${suffix}`, { token, ...signalOf(signal) });
}

export function declareIncident(token: string, body: {
  readonly title: string; readonly summary: string; readonly category: string; readonly severity: string; readonly detectedAt: string; readonly reasonCode: string;
}): Promise<{ readonly incident: IncidentDto; readonly correlationId: string }> {
  return requestJson('/api/v1/operations/incidents', { token, method: 'POST', body });
}

export function getIncident(token: string, incidentId: string, signal?: AbortSignal): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId), { token, ...signalOf(signal) });
}

export function transitionIncident(token: string, incidentId: string, body: { readonly toState: IncidentState; readonly reasonCode: string; readonly note?: string }): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId, '/transition'), { token, method: 'POST', body });
}

export function changeIncidentSeverity(token: string, incidentId: string, body: { readonly severity: string; readonly reasonCode: string }): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId, '/severity'), { token, method: 'POST', body });
}

export function changeIncidentCategory(token: string, incidentId: string, body: { readonly category: string; readonly reasonCode: string }): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId, '/category'), { token, method: 'POST', body });
}

export function addIncidentNote(token: string, incidentId: string, body: { readonly note: string; readonly reasonCode: string }): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId, '/notes'), { token, method: 'POST', body });
}

export function searchIncidentOrganizations(token: string, q: string, signal?: AbortSignal): Promise<{ readonly organizations: readonly { readonly id: string; readonly name: string; readonly kind: string }[] }> {
  return requestJson(`/api/v1/operations/incidents/organization-options?${new URLSearchParams({ q }).toString()}`, { token, ...signalOf(signal) });
}

export function addIncidentOrganization(token: string, incidentId: string, body: { readonly organizationId: string; readonly reasonCode: string }): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId, '/organizations'), { token, method: 'POST', body });
}

export function removeIncidentOrganization(token: string, incidentId: string, organizationId: string, body: { readonly reasonCode: string }): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId, `/organizations/${encodeURIComponent(organizationId)}/remove`), { token, method: 'POST', body });
}

export function recordIncidentBoardNotification(token: string, incidentId: string, body: { readonly notifiedAt: string; readonly reasonCode: string; readonly reference?: string }): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId, '/board-notification'), { token, method: 'POST', body });
}

export function recordIncidentUsersNotification(token: string, incidentId: string, body: { readonly notifiedAt: string; readonly reasonCode: string }): Promise<IncidentDetailDto> {
  return requestJson(incidentPath(incidentId, '/users-notification'), { token, method: 'POST', body });
}

// --- Status communications (Settings) -----------------------------------------

export type StatusNoticeState = 'DRAFT' | 'QUEUED' | 'SENT' | 'WITHDRAWN';

export interface CommunicationsPolicyDto {
  readonly reasons: {
    readonly templateDraft: readonly string[];
    readonly templatePublish: readonly string[];
    readonly templateWithdraw: readonly string[];
    readonly noticeDraft: readonly string[];
    readonly noticeApprove: readonly string[];
    readonly noticeWithdraw: readonly string[];
  };
  readonly rateLimit: { readonly minimumSpacingMinutes: number; readonly dailyLimit: number };
  readonly approverCount: number;
  readonly soloSafeguardActive: boolean;
  /** 0090: how many people can approve a notice for sending; while only one can, they may approve their own after the cooling-off. */
  readonly noticeApproverCount?: number;
  readonly noticeSoloSafeguardActive?: boolean;
  readonly soloCoolingOffMinutes?: number;
  readonly incidents: readonly { readonly id: string; readonly reference: string; readonly title: string; readonly state: IncidentState; readonly category: string; readonly affectedOrganizationsCount: number }[];
  readonly correlationId: string;
}

export interface StatusNoticeTemplateDto {
  readonly id: string;
  readonly templateKey: string;
  readonly version: number;
  readonly subject: string;
  readonly body: string;
  readonly contentHash: string;
  readonly state: 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';
  readonly draftedBy: { readonly email: string; readonly isSelf: boolean };
  readonly draftedAt: string;
  readonly publishedAt: string | null;
  readonly approvedBy: string | null;
  readonly publishMode: 'DUAL' | 'SOLO' | null;
  readonly withdrawnAt: string | null;
  readonly approval: { readonly id: string; readonly state: string } | null;
  readonly canRequestApproval: boolean;
  readonly canPublish: boolean;
}

export interface StatusNoticeDto {
  readonly id: string;
  readonly incident: { readonly id: string; readonly reference: string; readonly title: string; readonly state: IncidentState };
  readonly template: { readonly id: string; readonly templateKey: string; readonly version: number; readonly subject: string; readonly body: string };
  readonly state: StatusNoticeState;
  readonly draftedBy: string;
  /** Whether the viewer drafted it: a notice is approved by someone else (0090). */
  readonly draftedBySelf?: boolean;
  readonly draftedAt: string;
  /** When the drafter may approve it themselves, if they are the sole approver. */
  readonly soloApprovalAvailableAt?: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly approveMode?: 'DUAL' | 'SOLO' | null;
  readonly sentAt: string | null;
  readonly recipientCount: number | null;
  readonly organizationCount: number | null;
  readonly email: NoticeEmailCountsDto;
  readonly withdrawnAt: string | null;
}

export function getCommunicationsPolicy(token: string, signal?: AbortSignal): Promise<CommunicationsPolicyDto> {
  return requestJson('/api/v1/operations/communications/policy', { token, ...signalOf(signal) });
}

export function listStatusNoticeTemplates(token: string, state?: string, cursor?: string | null, signal?: AbortSignal): Promise<{ readonly templates: readonly StatusNoticeTemplateDto[]; readonly nextCursor: string | null }> {
  const query = new URLSearchParams();
  if (state) query.set('state', state);
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/communications/templates${suffix}`, { token, ...signalOf(signal) });
}

export function draftStatusNoticeTemplate(token: string, body: { readonly templateKey: string; readonly subject: string; readonly body: string; readonly reasonCode: string }): Promise<{ readonly template: StatusNoticeTemplateDto }> {
  return requestJson('/api/v1/operations/communications/templates', { token, method: 'POST', body });
}

export function publishStatusNoticeTemplate(token: string, templateId: string, body: { readonly reasonCode: string; readonly approvalId?: string }): Promise<{ readonly template: StatusNoticeTemplateDto }> {
  return requestJson(`/api/v1/operations/communications/templates/${encodeURIComponent(templateId)}/publish`, { token, method: 'POST', body });
}

export function withdrawStatusNoticeTemplate(token: string, templateId: string, body: { readonly reasonCode: string }): Promise<{ readonly template: StatusNoticeTemplateDto }> {
  return requestJson(`/api/v1/operations/communications/templates/${encodeURIComponent(templateId)}/withdraw`, { token, method: 'POST', body });
}

export function listStatusNotices(token: string, incidentId?: string, cursor?: string | null, signal?: AbortSignal): Promise<{ readonly notices: readonly StatusNoticeDto[]; readonly nextCursor: string | null }> {
  const query = new URLSearchParams();
  if (incidentId) query.set('incidentId', incidentId);
  if (cursor) query.set('cursor', cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/communications/notices${suffix}`, { token, ...signalOf(signal) });
}

export function draftStatusNotice(token: string, body: { readonly incidentId: string; readonly templateId: string; readonly reasonCode: string }): Promise<{ readonly notice: StatusNoticeDto }> {
  return requestJson('/api/v1/operations/communications/notices', { token, method: 'POST', body });
}

export function approveStatusNotice(token: string, noticeId: string, body: { readonly reasonCode: string }): Promise<{ readonly notice: StatusNoticeDto }> {
  return requestJson(`/api/v1/operations/communications/notices/${encodeURIComponent(noticeId)}/approve`, { token, method: 'POST', body });
}

export function withdrawStatusNotice(token: string, noticeId: string, body: { readonly reasonCode: string }): Promise<{ readonly notice: StatusNoticeDto }> {
  return requestJson(`/api/v1/operations/communications/notices/${encodeURIComponent(noticeId)}/withdraw`, { token, method: 'POST', body });
}
