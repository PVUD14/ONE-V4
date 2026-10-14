/**
 * ONE · API client — System Health background jobs console (OPS-04).
 *
 * Read endpoints for the console (one bounded summary, the keyset failed-event list,
 * event detail and the supersede preview) and the audited replay. Supersede goes through
 * the OPS-02 approvals client in operations.ts. Its own file keeps the parallel OPS goals
 * out of each other's way; api.ts re-exports it.
 */
import { requestJson } from './http.js';

export interface CappedCountDto {
  readonly value: number;
  readonly capped: boolean;
}

export type JobsAlertCondition = 'FAILED_EVENTS_THRESHOLD' | 'PENDING_EVENTS_STALLED' | 'CONSUMER_SILENT';

export interface JobsHealthAlertDto {
  readonly id: string;
  readonly conditionKey: JobsAlertCondition;
  readonly subject: string | null;
  readonly state: 'OPEN' | 'CLEARED';
  readonly observedValue: number;
  readonly threshold: number;
  readonly notice: 'QUEUED' | 'NOT_DELIVERED';
  readonly raisedAt: string;
  readonly clearedAt: string | null;
}

export interface JobsHealthSummaryDto {
  readonly generatedAt: string;
  readonly outbox: {
    readonly counts: Readonly<Record<'PENDING' | 'PROCESSING' | 'FAILED' | 'PUBLISHED', CappedCountDto>>;
    readonly oldestPendingAt: string | null;
    readonly oldestDueWaitingSince: string | null;
    readonly oldestDueWaitingMinutes: number | null;
    readonly failedByType: readonly { readonly eventType: string; readonly count: number }[];
    readonly failedByClass: readonly { readonly failureClass: string; readonly count: number }[];
  };
  readonly worker: {
    readonly verdict: 'DRAINING' | 'STALLED' | 'NO_WORK_WAITING';
    readonly lastDeliveredAt: string | null;
    readonly activeLeases: CappedCountDto;
    readonly expiredLeases: CappedCountDto;
  };
  readonly consumers: readonly {
    readonly name: string;
    readonly label: string;
    readonly lastActivityAt: string | null;
    readonly lastSucceededAt: string | null;
    readonly failedReceipts: CappedCountDto;
    readonly silenceMinutes: number | null;
    readonly silent: boolean | null;
  }[];
  readonly automation: {
    readonly workflows: readonly { readonly allowlistId: string; readonly version: number; readonly operation: string; readonly active: boolean; readonly killSwitch: boolean }[];
    readonly commandCounts: Readonly<Record<string, CappedCountDto>>;
    readonly lastCommandAt: string | null;
    readonly lastCallbackAt: string | null;
  };
  readonly alerts: {
    readonly config: { readonly failedThreshold: number; readonly pendingStallMinutes: number; readonly consumerSilenceMinutes: Readonly<Record<string, number>>; readonly ignored: readonly string[] };
    readonly delivery: { readonly workflowEnabled: boolean; readonly templateApproved: boolean };
    readonly open: readonly JobsHealthAlertDto[];
    readonly recent: readonly JobsHealthAlertDto[];
  };
}

export interface JobsHealthResponseDto {
  readonly summary: JobsHealthSummaryDto;
  readonly reasons: { readonly replay: readonly string[]; readonly supersede: readonly string[] };
  readonly correlationId: string;
}

export interface FailedJobDto {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateType: string;
  readonly attempts: number;
  readonly failureClass: string;
  readonly occurredAt: string;
  readonly failedAt: string;
  readonly expiresAt: string | null;
  readonly replayable: boolean;
}

export interface FailedJobDetailDto extends FailedJobDto {
  readonly correlationId: string;
  readonly explanation: string;
  readonly receipts: readonly { readonly consumer: string; readonly status: string; readonly attempts: number; readonly failureClass: string | null; readonly updatedAt: string }[];
  readonly automationCommand: { readonly workflow: string; readonly state: string; readonly attempts: number; readonly failureClass: string | null } | null;
}

export interface FailedJobsFilters {
  readonly eventType?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
}

export function getJobsHealthSummary(token: string, signal?: AbortSignal): Promise<JobsHealthResponseDto> {
  return requestJson('/api/v1/operations/jobs/summary', { token, ...(signal ? { signal } : {}) });
}

export function listFailedJobs(token: string, filters: FailedJobsFilters = {}, signal?: AbortSignal): Promise<{ readonly events: readonly FailedJobDto[]; readonly nextCursor: string | null }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`/api/v1/operations/jobs/failed${suffix}`, { token, ...(signal ? { signal } : {}) });
}

export function getFailedJob(token: string, eventId: string, signal?: AbortSignal): Promise<{ readonly event: FailedJobDetailDto }> {
  return requestJson(`/api/v1/operations/jobs/failed/${encodeURIComponent(eventId)}`, { token, ...(signal ? { signal } : {}) });
}

export function previewBacklogSupersede(token: string, olderThan: string, signal?: AbortSignal): Promise<{ readonly olderThan: string; readonly pending: CappedCountDto; readonly limit: number }> {
  return requestJson(`/api/v1/operations/jobs/backlog?olderThan=${encodeURIComponent(olderThan)}`, { token, ...(signal ? { signal } : {}) });
}

export function replayFailedJob(token: string, eventId: string, reasonCode: string): Promise<{ readonly replayed: boolean }> {
  return requestJson(`/api/v1/operations/outbox/${encodeURIComponent(eventId)}/replay`, { token, method: 'POST', body: { reasonCode } });
}
