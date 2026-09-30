/**
 * Background jobs health for the System Health console and its alerting (OPS-04).
 *
 * Every number here is computed in bounded SQL: counts are capped, lists are keyset
 * paginated, and each read is an index probe (0045 adds the partial indexes). The
 * browser never counts a full list. Nothing here returns an event payload, a recipient
 * address or an upstream error string. Failure messages come from a fixed map in code,
 * not from the stored column.
 *
 * Alerting: `evaluateJobsAlerts` raises one `jobs_health_alerts` row per breach and
 * clears it when the condition recovers, so a breach produces one alert, not one per
 * event or per run. It is run by a one-shot timer, not by the worker, so it still
 * reports a worker that has stopped.
 *
 * Design: docs/architecture/jobs-health-alerts-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { platformInternalRoles } from '@planthepath/authorization/src/index.js';
import { CONTENT_GENERATION_CONSUMER } from './content-generation.js';
import { STUDENT_INVITATION_CONSUMER, STUDENT_INVITATION_REQUESTED } from './student-invitations.js';

/** A drizzle database or transaction. */
export interface JobsSqlRunner {
  execute(query: SQL): Promise<unknown>;
}
export interface JobsDb extends JobsSqlRunner {
  transaction<T>(work: (tx: JobsSqlRunner) => Promise<T>): Promise<T>;
}

type Rows<T> = { rows: T[] };
async function rows<T>(runner: JobsSqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

/** Counts stop here, so a large backlog reads as "10,000+" rather than a table scan. */
export const JOBS_COUNT_CAP = 10_000;

export interface CappedCount {
  readonly value: number;
  /** True when there are more than `value` rows; `value` is then the cap. */
  readonly capped: boolean;
}

function capped(raw: number | string): CappedCount {
  const value = Number(raw);
  return value > JOBS_COUNT_CAP ? { value: JOBS_COUNT_CAP, capped: true } : { value, capped: false };
}

async function cappedCount(runner: JobsSqlRunner, from: SQL): Promise<CappedCount> {
  const [row] = await rows<{ n: string }>(runner, sql`SELECT count(*)::text AS n FROM (SELECT 1 FROM ${from} LIMIT ${JOBS_COUNT_CAP + 1}) bounded`);
  return capped(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Known consumers (code constants — the receipts table has no registry of its own)
// ---------------------------------------------------------------------------

export interface JobConsumer {
  readonly name: string;
  readonly label: string;
  readonly eventType: string;
}

export const knownJobConsumers: readonly JobConsumer[] = [
  { name: STUDENT_INVITATION_CONSUMER, label: 'Student invitation delivery', eventType: STUDENT_INVITATION_REQUESTED },
  { name: CONTENT_GENERATION_CONSUMER, label: 'Content generation (seeded drafts)', eventType: 'content.generation.requested' },
];

// ---------------------------------------------------------------------------
// Configuration (app.env, shared by the API and the evaluator)
// ---------------------------------------------------------------------------

export interface JobsAlertConfig {
  readonly failedThreshold: number;
  readonly pendingStallMinutes: number;
  /** Consumer name → minutes without a receipt before it is silent. Only configured consumers alert. */
  readonly consumerSilenceMinutes: Readonly<Record<string, number>>;
  /** Variables that were set but could not be used; the default applies instead. */
  readonly ignored: readonly string[];
}

export const defaultJobsAlertConfig = { failedThreshold: 10, pendingStallMinutes: 30 } as const;

function positiveInteger(raw: string | undefined, max: number): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 && value <= max ? value : Number.NaN;
}

export function readJobsAlertConfig(env: Readonly<Record<string, string | undefined>>): JobsAlertConfig {
  const ignored: string[] = [];
  const failed = positiveInteger(env.JOBS_ALERT_FAILED_THRESHOLD, JOBS_COUNT_CAP);
  const stall = positiveInteger(env.JOBS_ALERT_PENDING_STALL_MINUTES, 7 * 24 * 60);
  if (Number.isNaN(failed)) ignored.push('JOBS_ALERT_FAILED_THRESHOLD');
  if (Number.isNaN(stall)) ignored.push('JOBS_ALERT_PENDING_STALL_MINUTES');
  const consumerSilenceMinutes: Record<string, number> = {};
  const rawConsumers = env.JOBS_ALERT_CONSUMER_SILENCE_MINUTES?.trim();
  if (rawConsumers) {
    let valid = true;
    for (const entry of rawConsumers.split(',')) {
      const [name, minutes] = entry.split('=').map((part) => part.trim());
      const parsed = positiveInteger(minutes, 30 * 24 * 60);
      if (!name || !knownJobConsumers.some((consumer) => consumer.name === name) || parsed === null || Number.isNaN(parsed)) { valid = false; continue; }
      consumerSilenceMinutes[name] = parsed;
    }
    if (!valid) ignored.push('JOBS_ALERT_CONSUMER_SILENCE_MINUTES');
  }
  return {
    failedThreshold: failed && !Number.isNaN(failed) ? failed : defaultJobsAlertConfig.failedThreshold,
    pendingStallMinutes: stall && !Number.isNaN(stall) ? stall : defaultJobsAlertConfig.pendingStallMinutes,
    consumerSilenceMinutes,
    ignored,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type WorkerVerdict = 'DRAINING' | 'STALLED' | 'NO_WORK_WAITING';

export interface JobsHealthAlertRow {
  readonly id: string;
  readonly conditionKey: 'FAILED_EVENTS_THRESHOLD' | 'PENDING_EVENTS_STALLED' | 'CONSUMER_SILENT';
  readonly subject: string | null;
  readonly state: 'OPEN' | 'CLEARED';
  readonly observedValue: number;
  readonly threshold: number;
  readonly notice: 'QUEUED' | 'NOT_DELIVERED';
  readonly raisedAt: string;
  readonly clearedAt: string | null;
}

export interface JobsHealthSummary {
  readonly generatedAt: string;
  readonly outbox: {
    readonly counts: Readonly<Record<'PENDING' | 'PROCESSING' | 'FAILED' | 'PUBLISHED', CappedCount>>;
    readonly oldestPendingAt: string | null;
    readonly oldestDueWaitingSince: string | null;
    readonly oldestDueWaitingMinutes: number | null;
    /** Grouped over the most recent failures only (at most the count cap). */
    readonly failedByType: readonly { readonly eventType: string; readonly count: number }[];
    readonly failedByClass: readonly { readonly failureClass: string; readonly count: number }[];
  };
  readonly worker: {
    readonly verdict: WorkerVerdict;
    readonly lastDeliveredAt: string | null;
    readonly activeLeases: CappedCount;
    readonly expiredLeases: CappedCount;
  };
  readonly consumers: readonly {
    readonly name: string;
    readonly label: string;
    readonly lastActivityAt: string | null;
    readonly lastSucceededAt: string | null;
    readonly failedReceipts: CappedCount;
    readonly silenceMinutes: number | null;
    /** null when no interval is configured: silence is then not judged. */
    readonly silent: boolean | null;
  }[];
  readonly automation: {
    readonly workflows: readonly { readonly allowlistId: string; readonly version: number; readonly operation: string; readonly active: boolean; readonly killSwitch: boolean }[];
    readonly commandCounts: Readonly<Record<string, CappedCount>>;
    readonly lastCommandAt: string | null;
    readonly lastCallbackAt: string | null;
  };
  readonly alerts: {
    readonly config: Omit<JobsAlertConfig, 'ignored'> & { readonly ignored: readonly string[] };
    readonly delivery: { readonly workflowEnabled: boolean; readonly templateApproved: boolean };
    readonly open: readonly JobsHealthAlertRow[];
    readonly recent: readonly JobsHealthAlertRow[];
  };
}

const automationCommandStates = ['PENDING', 'ACCEPTED', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL', 'EXPIRED', 'CANCELLED'] as const;

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

interface OutboxMetrics {
  readonly now: Date;
  readonly failed: CappedCount;
  readonly oldestDueWaitingSince: Date | null;
}

async function readOutboxMetrics(runner: JobsSqlRunner): Promise<OutboxMetrics> {
  const [clock] = await rows<{ now: Date | string }>(runner, sql`SELECT now() AS now`);
  const failed = await cappedCount(runner, sql`outbox_events WHERE delivery_state = 'FAILED'`);
  const [due] = await rows<{ since: Date | string | null }>(runner, sql`
    SELECT available_at AS since FROM outbox_events
    WHERE delivery_state = 'PENDING' AND available_at <= now() AND (expires_at IS NULL OR expires_at > now())
    ORDER BY available_at ASC LIMIT 1
  `);
  return { now: new Date(clock!.now), failed, oldestDueWaitingSince: due?.since ? new Date(due.since) : null };
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

async function consumerActivity(runner: JobsSqlRunner, name: string): Promise<{ lastActivityAt: Date | null; lastSucceededAt: Date | null }> {
  const [activity] = await rows<{ at: Date | string }>(runner, sql`
    SELECT updated_at AS at FROM event_consumer_receipts WHERE consumer_name = ${name} ORDER BY updated_at DESC LIMIT 1
  `);
  // A SUCCEEDED receipt is never updated again, so its updated_at is its success time.
  const [success] = await rows<{ at: Date | string }>(runner, sql`
    SELECT succeeded_at AS at FROM event_consumer_receipts WHERE consumer_name = ${name} AND status = 'SUCCEEDED'
    ORDER BY updated_at DESC LIMIT 1
  `);
  return { lastActivityAt: activity ? new Date(activity.at) : null, lastSucceededAt: success ? new Date(success.at) : null };
}

function isSilent(lastActivityAt: Date | null, minutes: number | undefined, now: Date): boolean | null {
  if (minutes === undefined) return null;
  return lastActivityAt === null || now.getTime() - lastActivityAt.getTime() >= minutes * 60_000;
}

function mapAlert(row: Record<string, unknown>): JobsHealthAlertRow {
  return {
    id: String(row.id),
    conditionKey: row.condition_key as JobsHealthAlertRow['conditionKey'],
    subject: row.subject === null ? null : String(row.subject),
    state: row.state as JobsHealthAlertRow['state'],
    observedValue: Number(row.observed_value),
    threshold: Number(row.threshold),
    notice: row.notice as JobsHealthAlertRow['notice'],
    raisedAt: iso(row.raised_at as Date | string)!,
    clearedAt: iso(row.cleared_at as Date | string | null),
  };
}

async function alertDelivery(runner: JobsSqlRunner): Promise<{ workflowEnabled: boolean; templateId: string | null }> {
  const workflow = await rows(runner, sql`
    SELECT 1 FROM automation_workflow_registry WHERE allowlist_id = 'ops-failure' AND active AND NOT kill_switch LIMIT 1
  `);
  const [template] = await rows<{ id: string }>(runner, sql`
    SELECT id FROM notification_templates WHERE stable_key = 'ops-failure' AND locale = 'en-IN' AND published_at <= now()
    ORDER BY version DESC LIMIT 1
  `);
  return { workflowEnabled: workflow.length > 0, templateId: template?.id ?? null };
}

export async function readJobsHealthSummary(runner: JobsSqlRunner, config: JobsAlertConfig): Promise<JobsHealthSummary> {
  const metrics = await readOutboxMetrics(runner);
  const now = metrics.now;
  const counts = {
    PENDING: await cappedCount(runner, sql`outbox_events WHERE delivery_state = 'PENDING'`),
    PROCESSING: await cappedCount(runner, sql`outbox_events WHERE delivery_state = 'PROCESSING'`),
    FAILED: metrics.failed,
    PUBLISHED: await cappedCount(runner, sql`outbox_events WHERE delivery_state = 'PUBLISHED'`),
  };
  const [oldestPending] = await rows<{ at: Date | string }>(runner, sql`
    SELECT occurred_at AS at FROM outbox_events WHERE delivery_state = 'PENDING' ORDER BY occurred_at ASC LIMIT 1
  `);
  const failedByType = await rows<{ event_type: string; n: string }>(runner, sql`
    SELECT event_type, count(*)::text AS n FROM (
      SELECT event_type FROM outbox_events WHERE delivery_state = 'FAILED' ORDER BY occurred_at DESC, id DESC LIMIT ${JOBS_COUNT_CAP}
    ) recent GROUP BY event_type ORDER BY count(*) DESC, event_type ASC LIMIT 20
  `);
  const failedByClass = await rows<{ failure_class: string | null; n: string }>(runner, sql`
    SELECT last_failure_class AS failure_class, count(*)::text AS n FROM (
      SELECT last_failure_class FROM outbox_events WHERE delivery_state = 'FAILED' ORDER BY occurred_at DESC, id DESC LIMIT ${JOBS_COUNT_CAP}
    ) recent GROUP BY last_failure_class ORDER BY count(*) DESC LIMIT 10
  `);
  const [delivered] = await rows<{ at: Date | string }>(runner, sql`
    SELECT published_at AS at FROM outbox_events WHERE delivery_state = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1
  `);
  const activeLeases = await cappedCount(runner, sql`outbox_events WHERE delivery_state = 'PROCESSING' AND lease_expires_at > now()`);
  const expiredLeases = await cappedCount(runner, sql`outbox_events WHERE delivery_state = 'PROCESSING' AND lease_expires_at <= now()`);
  const waitingMinutes = metrics.oldestDueWaitingSince ? minutesBetween(metrics.oldestDueWaitingSince, now) : null;
  const verdict: WorkerVerdict = waitingMinutes === null ? 'NO_WORK_WAITING'
    : waitingMinutes >= config.pendingStallMinutes ? 'STALLED' : 'DRAINING';

  const consumers = [];
  for (const consumer of knownJobConsumers) {
    const activity = await consumerActivity(runner, consumer.name);
    const silenceMinutes = config.consumerSilenceMinutes[consumer.name];
    consumers.push({
      name: consumer.name,
      label: consumer.label,
      lastActivityAt: iso(activity.lastActivityAt),
      lastSucceededAt: iso(activity.lastSucceededAt),
      failedReceipts: await cappedCount(runner, sql`event_consumer_receipts WHERE consumer_name = ${consumer.name} AND status = 'FAILED'`),
      silenceMinutes: silenceMinutes ?? null,
      silent: isSilent(activity.lastActivityAt, silenceMinutes, now),
    });
  }

  const workflows = await rows<{ allowlist_id: string; version: number; operation: string; active: boolean; kill_switch: boolean }>(runner, sql`
    SELECT allowlist_id, version, operation, active, kill_switch FROM automation_workflow_registry
    ORDER BY allowlist_id ASC, version DESC LIMIT 50
  `);
  const commandCounts: Record<string, CappedCount> = {};
  for (const state of automationCommandStates) {
    commandCounts[state] = await cappedCount(runner, sql`automation_commands WHERE state = ${state}`);
  }
  const [lastCommand] = await rows<{ at: Date | string }>(runner, sql`SELECT max(created_at) AS at FROM (SELECT created_at FROM automation_commands ORDER BY created_at DESC LIMIT 1) latest`);
  const [lastCallback] = await rows<{ at: Date | string }>(runner, sql`SELECT max(received_at) AS at FROM (SELECT received_at FROM automation_callbacks ORDER BY received_at DESC LIMIT 1) latest`);

  const open = await rows<Record<string, unknown>>(runner, sql`
    SELECT * FROM jobs_health_alerts WHERE state = 'OPEN' ORDER BY raised_at DESC, id DESC LIMIT 20
  `);
  const recent = await rows<Record<string, unknown>>(runner, sql`
    SELECT * FROM jobs_health_alerts ORDER BY raised_at DESC, id DESC LIMIT 10
  `);
  const delivery = await alertDelivery(runner);

  return {
    generatedAt: now.toISOString(),
    outbox: {
      counts,
      oldestPendingAt: iso(oldestPending?.at),
      oldestDueWaitingSince: iso(metrics.oldestDueWaitingSince),
      oldestDueWaitingMinutes: waitingMinutes,
      failedByType: failedByType.map((row) => ({ eventType: row.event_type, count: Number(row.n) })),
      failedByClass: failedByClass.map((row) => ({ failureClass: row.failure_class ?? 'UNCLASSIFIED', count: Number(row.n) })),
    },
    worker: { verdict, lastDeliveredAt: iso(delivered?.at), activeLeases, expiredLeases },
    consumers,
    automation: {
      workflows: workflows.map((row) => ({ allowlistId: row.allowlist_id, version: Number(row.version), operation: row.operation, active: row.active, killSwitch: row.kill_switch })),
      commandCounts,
      lastCommandAt: iso(lastCommand?.at),
      lastCallbackAt: iso(lastCallback?.at),
    },
    alerts: {
      config: { failedThreshold: config.failedThreshold, pendingStallMinutes: config.pendingStallMinutes, consumerSilenceMinutes: config.consumerSilenceMinutes, ignored: config.ignored },
      delivery: { workflowEnabled: delivery.workflowEnabled, templateApproved: delivery.templateId !== null },
      open: open.map(mapAlert),
      recent: recent.map(mapAlert),
    },
  };
}

// ---------------------------------------------------------------------------
// Failed events: keyset list and detail
// ---------------------------------------------------------------------------

/** Fixed, safe explanations per failure class. The stored message column is never returned. */
export const failureClassExplanations: Readonly<Record<string, string>> = {
  TERMINAL_PUBLISH_FAILURE: 'Delivery failed on every attempt, or the receiver refused it permanently.',
  SCHEMA_VALIDATION_FAILED: 'The event did not match its registered schema, so it was never delivered.',
  EVENT_EXPIRED: 'The event expired before it could be delivered.',
  SUPERSEDED_BACKLOG: 'Retired with the pre-dispatcher backlog by an approved supersede. It was never delivered.',
};

export interface FailedJobRow {
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

export interface FailedJobsPage {
  readonly events: readonly FailedJobRow[];
  readonly nextCursor: string | null;
}

export interface FailedJobsFilter {
  readonly eventType?: string;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly cursor?: { readonly occurredAt: string; readonly id: string };
  readonly limit: number;
}

function mapFailed(row: Record<string, unknown>): FailedJobRow {
  return {
    eventId: String(row.id),
    eventType: String(row.event_type),
    eventVersion: Number(row.event_version),
    aggregateType: String(row.aggregate_type),
    attempts: Number(row.attempts),
    failureClass: row.last_failure_class === null ? 'UNCLASSIFIED' : String(row.last_failure_class),
    occurredAt: iso(row.occurred_at as Date | string)!,
    failedAt: iso(row.updated_at as Date | string)!,
    expiresAt: iso(row.expires_at as Date | string | null),
    replayable: row.replayable === true,
  };
}

export function encodeFailedJobsCursor(occurredAtText: string, id: string): string {
  return Buffer.from(JSON.stringify({ o: occurredAtText, i: id }), 'utf8').toString('base64url');
}

export function decodeFailedJobsCursor(raw: string): { readonly occurredAt: string; readonly id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { o?: unknown; i?: unknown };
    if (typeof parsed.o !== 'string' || typeof parsed.i !== 'string') return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.i)) return null;
    // Postgres timestamptz text, microseconds kept: 2026-09-25 16:41:32.123456+00
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/.test(parsed.o)) return null;
    return { occurredAt: parsed.o, id: parsed.i };
  } catch {
    return null;
  }
}

export async function listFailedJobs(runner: JobsSqlRunner, filter: FailedJobsFilter): Promise<FailedJobsPage> {
  if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > 200) throw new RangeError('limit must be an integer from 1 to 200');
  const conditions: SQL[] = [sql`delivery_state = 'FAILED'`];
  if (filter.eventType) conditions.push(sql`event_type = ${filter.eventType}`);
  if (filter.occurredFrom) conditions.push(sql`occurred_at >= ${filter.occurredFrom}::timestamptz`);
  if (filter.occurredTo) conditions.push(sql`occurred_at < ${filter.occurredTo}::timestamptz`);
  if (filter.cursor) conditions.push(sql`(occurred_at, id) < (${filter.cursor.occurredAt}::timestamptz, ${filter.cursor.id}::uuid)`);
  const where = conditions.reduce((left, right) => sql`${left} AND ${right}`);
  // occurred_at::text keeps microseconds, so the cursor never skips or repeats a row.
  const found = await rows<Record<string, unknown>>(runner, sql`
    SELECT id, event_type, event_version, aggregate_type, attempts, last_failure_class, occurred_at, occurred_at::text AS occurred_at_text,
           updated_at, expires_at, (expires_at IS NULL OR expires_at > now()) AS replayable
    FROM outbox_events
    WHERE ${where}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${filter.limit + 1}
  `);
  const page = found.slice(0, filter.limit);
  const last = page[page.length - 1];
  return {
    events: page.map(mapFailed),
    nextCursor: found.length > filter.limit && last ? encodeFailedJobsCursor(String(last.occurred_at_text), String(last.id)) : null,
  };
}

export interface FailedJobDetail extends FailedJobRow {
  readonly correlationId: string;
  readonly explanation: string;
  readonly receipts: readonly { readonly consumer: string; readonly status: string; readonly attempts: number; readonly failureClass: string | null; readonly updatedAt: string }[];
  readonly automationCommand: { readonly workflow: string; readonly state: string; readonly attempts: number; readonly failureClass: string | null } | null;
}

/** A FAILED event's operator view, or null when there is no FAILED event with that id. */
export async function getFailedJobDetail(runner: JobsSqlRunner, eventId: string): Promise<FailedJobDetail | null> {
  const [row] = await rows<Record<string, unknown>>(runner, sql`
    SELECT id, event_type, event_version, aggregate_type, attempts, last_failure_class, occurred_at, updated_at, expires_at,
           correlation_id, (expires_at IS NULL OR expires_at > now()) AS replayable
    FROM outbox_events WHERE id = ${eventId}::uuid AND delivery_state = 'FAILED'
  `);
  if (!row) return null;
  const base = mapFailed(row);
  const receipts = await rows<{ consumer_name: string; status: string; attempts: number; last_failure_class: string | null; updated_at: Date | string }>(runner, sql`
    SELECT consumer_name, status, attempts, last_failure_class, updated_at FROM event_consumer_receipts
    WHERE event_id = ${eventId}::uuid ORDER BY updated_at DESC LIMIT 20
  `);
  const [command] = await rows<{ allowlist_id: string; state: string; attempts: number; last_failure_class: string | null }>(runner, sql`
    SELECT r.allowlist_id, c.state, c.attempts, c.last_failure_class FROM automation_commands c
    JOIN automation_workflow_registry r ON r.id = c.workflow_registry_id WHERE c.event_id = ${eventId}::uuid LIMIT 1
  `);
  const label = (name: string): string => knownJobConsumers.find((consumer) => consumer.name === name)?.label ?? name;
  return {
    ...base,
    correlationId: String(row.correlation_id),
    explanation: failureClassExplanations[base.failureClass] ?? 'The event failed for a reason this console does not classify. Search the audit log by its reference.',
    receipts: receipts.map((receipt) => ({
      consumer: label(receipt.consumer_name), status: receipt.status, attempts: Number(receipt.attempts),
      failureClass: receipt.last_failure_class, updatedAt: iso(receipt.updated_at)!,
    })),
    automationCommand: command ? { workflow: command.allowlist_id, state: command.state, attempts: Number(command.attempts), failureClass: command.last_failure_class } : null,
  };
}

/** How many PENDING events a supersede with this cutoff would retire (capped). */
export async function countSupersedableBacklog(runner: JobsSqlRunner, olderThan: Date): Promise<CappedCount> {
  return cappedCount(runner, sql`outbox_events WHERE delivery_state = 'PENDING' AND occurred_at < ${olderThan}`);
}

// ---------------------------------------------------------------------------
// Alert evaluation
// ---------------------------------------------------------------------------

type ConditionKey = JobsHealthAlertRow['conditionKey'];

interface Observation {
  readonly conditionKey: ConditionKey;
  readonly subject: string | null;
  readonly breached: boolean;
  readonly observedValue: number;
  readonly threshold: number;
}

export interface JobsAlertEvaluation {
  readonly raised: readonly JobsHealthAlertRow[];
  readonly cleared: readonly JobsHealthAlertRow[];
  readonly stillOpen: number;
}

const conditionText: Readonly<Record<ConditionKey, string>> = {
  FAILED_EVENTS_THRESHOLD: 'failed background events reached the alert threshold',
  PENDING_EVENTS_STALLED: 'background events are waiting longer than the alert limit',
  CONSUMER_SILENT: 'a background consumer has been silent longer than its expected interval',
};

async function observe(runner: JobsSqlRunner, config: JobsAlertConfig): Promise<Observation[]> {
  const metrics = await readOutboxMetrics(runner);
  const waitingMinutes = metrics.oldestDueWaitingSince ? minutesBetween(metrics.oldestDueWaitingSince, metrics.now) : 0;
  const observations: Observation[] = [
    { conditionKey: 'FAILED_EVENTS_THRESHOLD', subject: null, breached: metrics.failed.value >= config.failedThreshold,
      observedValue: metrics.failed.value, threshold: config.failedThreshold },
    { conditionKey: 'PENDING_EVENTS_STALLED', subject: null, breached: waitingMinutes >= config.pendingStallMinutes,
      observedValue: waitingMinutes, threshold: config.pendingStallMinutes },
  ];
  for (const consumer of knownJobConsumers) {
    const minutes = config.consumerSilenceMinutes[consumer.name];
    const activity = await consumerActivity(runner, consumer.name);
    const silentFor = activity.lastActivityAt ? minutesBetween(activity.lastActivityAt, metrics.now) : minutes ?? 0;
    // Unconfigured consumers are observed as healthy so any earlier breach for them clears.
    observations.push({ conditionKey: 'CONSUMER_SILENT', subject: consumer.name,
      breached: isSilent(activity.lastActivityAt, minutes, metrics.now) === true,
      observedValue: silentFor, threshold: minutes ?? 1 });
  }
  return observations;
}

/**
 * GROWTH-01 (ADR-040): operator notices go to the internal platform roles only. Growth field
 * staff are ACTIVE memberships of the same platform organisation, and must never receive them.
 */
function operatorRoleList(): SQL {
  return sql.join(platformInternalRoles.map((role) => sql`${role}`), sql`, `);
}

async function queueAlertNotice(tx: JobsSqlRunner, alert: { readonly id: string; readonly conditionKey: ConditionKey; readonly observedValue: number; readonly threshold: number; readonly correlationId: string }): Promise<'QUEUED' | 'NOT_DELIVERED'> {
  const delivery = await alertDelivery(tx);
  if (!delivery.workflowEnabled || !delivery.templateId) return 'NOT_DELIVERED';
  const recipients = await rows<{ id: string }>(tx, sql`
    SELECT DISTINCT u.id FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id AND o.kind = 'PLATFORM'
    JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
    WHERE m.state = 'ACTIVE' AND m.role IN (${operatorRoleList()})
  `);
  if (!recipients.length) return 'NOT_DELIVERED';
  for (const recipient of recipients) {
    const commandId = randomUUID();
    await tx.execute(sql`
      INSERT INTO notification_commands
        (id, subject_user_id, template_id, channel, legal_purpose, destination_ref, render_parameters, dedupe_key, state, expires_at, correlation_id)
      VALUES (${commandId}::uuid, ${recipient.id}::uuid, ${delivery.templateId}::uuid, 'EMAIL', 'operational failure notification',
              ${'user:' + recipient.id},
              ${JSON.stringify({ condition: alert.conditionKey, summary: conditionText[alert.conditionKey], observedValue: alert.observedValue, threshold: alert.threshold })}::jsonb,
              ${'jobs-alert:' + alert.id + ':' + recipient.id}, 'PENDING', now() + interval '24 hours', ${alert.correlationId})
    `);
    await tx.execute(sql`
      INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, correlation_id)
      VALUES (${randomUUID()}::uuid, 'notification_command', ${commandId}, 'notification.delivery.requested', 1,
              ${JSON.stringify({ commandId, templateId: delivery.templateId, channel: 'EMAIL' })}::jsonb, ${alert.correlationId})
    `);
  }
  return 'QUEUED';
}

/**
 * Raise each breached condition that has no open alert, and clear each open alert whose
 * condition has recovered. One advisory lock serialises evaluators; the partial unique
 * index backs it up.
 */
export async function evaluateJobsAlerts(db: JobsDb, config: JobsAlertConfig): Promise<JobsAlertEvaluation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('jobs_health_alerts'))`);
    const observations = await observe(tx, config);
    const openRows = (await rows<Record<string, unknown>>(tx, sql`SELECT * FROM jobs_health_alerts WHERE state = 'OPEN' FOR UPDATE`)).map(mapAlert);
    const raised: JobsHealthAlertRow[] = [];
    const cleared: JobsHealthAlertRow[] = [];
    for (const observation of observations) {
      const open = openRows.find((row) => row.conditionKey === observation.conditionKey && row.subject === observation.subject);
      if (observation.breached && !open) {
        const id = randomUUID();
        const correlationId = 'jobs-alert:' + id;
        const notice = await queueAlertNotice(tx, { id, conditionKey: observation.conditionKey, observedValue: observation.observedValue, threshold: observation.threshold, correlationId });
        const [row] = await rows<Record<string, unknown>>(tx, sql`
          INSERT INTO jobs_health_alerts (id, condition_key, subject, observed_value, threshold, notice, correlation_id)
          VALUES (${id}::uuid, ${observation.conditionKey}, ${observation.subject}, ${observation.observedValue}, ${observation.threshold}, ${notice}, ${correlationId})
          RETURNING *
        `);
        raised.push(mapAlert(row!));
      } else if (!observation.breached && open) {
        const [row] = await rows<Record<string, unknown>>(tx, sql`
          UPDATE jobs_health_alerts SET state = 'CLEARED' WHERE id = ${open.id}::uuid RETURNING *
        `);
        cleared.push(mapAlert(row!));
      }
    }
    const stillOpen = openRows.length - cleared.length + raised.length;
    return { raised, cleared, stillOpen };
  });
}
