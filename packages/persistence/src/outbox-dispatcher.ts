import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  createIntegrationEventEnvelope,
  type IntegrationEventEnvelope,
  validateIntegrationEventEnvelope,
} from '@planthepath/events/src/index.js';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

export type OutboxFailureClass = 'RETRYABLE_PUBLISH_FAILURE' | 'TERMINAL_PUBLISH_FAILURE' | 'SCHEMA_VALIDATION_FAILED' | 'EVENT_EXPIRED';

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Record<string, unknown>;
  readonly actorUserId?: string;
  readonly organizationId?: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly availableAt: Date;
  readonly attempts: number;
  readonly expiresAt?: Date;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export interface IntegrationEventPublisher {
  publish(event: IntegrationEventEnvelope): Promise<void>;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly maxEventAgeMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly random: () => number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 5,
  maxEventAgeMs: 24 * 60 * 60 * 1000,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60 * 1000,
  jitterRatio: 0.2,
  random: Math.random,
};

export class OutboxPublishError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'OutboxPublishError';
    this.retryable = retryable;
  }
}

export class OutboxLeaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxLeaseStateError';
  }
}

export class OutboxReconciliationRequiredError extends Error {
  constructor(readonly eventId: string) {
    super('publish succeeded but outbox acknowledgement failed');
    this.name = 'OutboxReconciliationRequiredError';
  }
}

export class EventConsumerEffectError extends Error {
  constructor(readonly failureClass: string) {
    super('consumer effect failed');
    this.name = 'EventConsumerEffectError';
  }
}

export class InMemoryIntegrationEventPublisher implements IntegrationEventPublisher {
  readonly published: IntegrationEventEnvelope[] = [];
  failNext: OutboxPublishError | undefined;

  async publish(event: IntegrationEventEnvelope): Promise<void> {
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = undefined;
      throw failure;
    }
    this.published.push(event);
  }
}

export function computeRetryDelayMs(attempt: number, policy: RetryPolicy): number {
  validateRetryPolicy(policy);
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jitterWindow = raw * policy.jitterRatio;
  const randomValue = policy.random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) throw new RangeError('retry random must return a finite value in [0, 1)');
  const jitter = Math.floor(randomValue * jitterWindow);
  return Math.min(policy.maxDelayMs, raw + jitter);
}

export async function claimOutboxBatch(
  db: PersistenceDb,
  input: { readonly leaseOwner: string; readonly batchSize: number; readonly leaseDurationMs: number; readonly now: Date },
): Promise<readonly ClaimedOutboxEvent[]> {
  validateLeaseInput(input);
  const leaseToken = randomUUID();
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT id
      FROM outbox_events
      WHERE delivery_state IN ('PENDING','PROCESSING')
        AND available_at <= ${input.now}
        AND (expires_at IS NULL OR expires_at > ${input.now})
        AND (delivery_state = 'PENDING' OR lease_expires_at <= ${input.now})
      ORDER BY available_at ASC, occurred_at ASC, id ASC
      LIMIT ${input.batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events o
    SET delivery_state = 'PROCESSING',
        lease_owner = ${input.leaseOwner},
        lease_token = ${leaseToken},
        lease_expires_at = ${new Date(input.now.getTime() + input.leaseDurationMs)},
        attempts = attempts + 1,
        updated_at = now()
    FROM candidates
    WHERE o.id = candidates.id
    RETURNING o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.event_version, o.payload,
              o.actor_user_id, o.organization_id, o.correlation_id, o.occurred_at, o.attempts,
              o.available_at, o.expires_at, o.lease_owner, o.lease_token, o.lease_expires_at
  `) as QueryResult<{
    id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    event_version: number;
    payload: Record<string, unknown>;
    actor_user_id: string | null;
    organization_id: string | null;
    correlation_id: string;
    occurred_at: Date | string;
    available_at: Date | string;
    attempts: number;
    expires_at: Date | string | null;
    lease_owner: string;
    lease_token: string;
    lease_expires_at: Date | string;
  }>;

  return result.rows.map((row) => ({
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: row.payload,
    ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    correlationId: row.correlation_id,
    occurredAt: toDate(row.occurred_at),
    availableAt: toDate(row.available_at),
    attempts: row.attempts,
    ...(row.expires_at ? { expiresAt: toDate(row.expires_at) } : {}),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: toDate(row.lease_expires_at),
  })).sort((a, b) => (
    a.availableAt.getTime() - b.availableAt.getTime()
    || a.occurredAt.getTime() - b.occurredAt.getTime()
    || a.id.localeCompare(b.id)
  ));
}

export async function markExpiredOutboxEvents(
  db: PersistenceDb,
  input: { readonly now: Date; readonly limit: number },
): Promise<number> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000) throw new RangeError('limit must be an integer from 1 to 10000');
  const result = await db.execute(sql`
    WITH expired AS (
      SELECT id
      FROM outbox_events
      WHERE delivery_state IN ('PENDING','PROCESSING')
        AND expires_at IS NOT NULL
        AND expires_at <= ${input.now}
      ORDER BY expires_at ASC, id ASC
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events o
    SET delivery_state = 'FAILED',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failure_class = 'EVENT_EXPIRED',
        last_failure_message = NULL,
        updated_at = now()
    FROM expired
    WHERE o.id = expired.id
    RETURNING o.id
  `) as QueryResult<{ id: string }>;
  return result.rows.length;
}

export async function dispatchClaimedOutboxEvent(
  db: PersistenceDb,
  event: ClaimedOutboxEvent,
  publisher: IntegrationEventPublisher,
  input: { readonly leaseOwner: string; readonly leaseToken: string; readonly now: Date; readonly retryPolicy?: RetryPolicy },
): Promise<'PUBLISHED' | 'RETRY_SCHEDULED' | 'TERMINAL_FAILURE'> {
  validateLeaseOwner(input.leaseOwner);
  requireUuid(input.leaseToken, 'leaseToken');
  if (input.leaseOwner !== event.leaseOwner || input.leaseToken !== event.leaseToken) throw new OutboxLeaseStateError('claimed event lease does not match dispatcher input');
  const retryPolicy = input.retryPolicy ?? defaultRetryPolicy;
  if (event.expiresAt && event.expiresAt <= input.now) {
    await ensureUpdated(markOutboxTerminalFailure(db, event.id, input.leaseOwner, input.leaseToken, input.now, 'EVENT_EXPIRED', 'event expired before publish'));
    return 'TERMINAL_FAILURE';
  }
  if (input.now.getTime() - event.occurredAt.getTime() > retryPolicy.maxEventAgeMs) {
    await ensureUpdated(markOutboxTerminalFailure(db, event.id, input.leaseOwner, input.leaseToken, input.now, 'EVENT_EXPIRED', 'event exceeded maximum age'));
    return 'TERMINAL_FAILURE';
  }

  let envelope: IntegrationEventEnvelope;
  try {
    envelope = createIntegrationEventEnvelope({
      eventId: event.id,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      occurredAt: event.occurredAt.toISOString(),
      aggregateId: event.aggregateId,
      ...(event.organizationId ? { organizationId: event.organizationId } : {}),
      ...(event.actorUserId ? { actorId: event.actorUserId } : {}),
      correlationId: event.correlationId,
      ...(event.expiresAt ? { expiresAt: event.expiresAt.toISOString() } : {}),
      payload: event.payload,
    });
    validateIntegrationEventEnvelope(envelope);
  } catch {
    await ensureUpdated(markOutboxTerminalFailure(db, event.id, input.leaseOwner, input.leaseToken, input.now, 'SCHEMA_VALIDATION_FAILED', 'event schema validation failed'));
    return 'TERMINAL_FAILURE';
  }

  try {
    await assertCurrentOutboxLease(db, event.id, input.leaseOwner, input.leaseToken, input.now);
    await publisher.publish(envelope);
    const acknowledged = await markOutboxPublished(db, event.id, input.leaseOwner, input.leaseToken, input.now, input.now);
    if (!acknowledged) throw new OutboxReconciliationRequiredError(event.id);
    return 'PUBLISHED';
  } catch (error) {
    if (error instanceof OutboxReconciliationRequiredError || error instanceof OutboxLeaseStateError) throw error;
    const retryable = !(error instanceof OutboxPublishError) || error.retryable;
    if (!retryable || event.attempts >= retryPolicy.maxAttempts) {
      await ensureUpdated(markOutboxTerminalFailure(db, event.id, input.leaseOwner, input.leaseToken, input.now, 'TERMINAL_PUBLISH_FAILURE', 'publisher terminal failure'));
      return 'TERMINAL_FAILURE';
    }
    const delayMs = computeRetryDelayMs(event.attempts, retryPolicy);
    await ensureUpdated(releaseOutboxForRetry(db, event.id, input.leaseOwner, input.leaseToken, input.now, new Date(input.now.getTime() + delayMs), 'RETRYABLE_PUBLISH_FAILURE'));
    return 'RETRY_SCHEDULED';
  }
}

export async function markOutboxPublished(db: PersistenceDb, eventId: string, leaseOwner: string, leaseToken: string, now: Date, publishedAt: Date): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE outbox_events
    SET delivery_state = 'PUBLISHED',
        published_at = ${publishedAt},
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failure_class = NULL,
        last_failure_message = NULL,
        updated_at = now()
    WHERE id = ${eventId}::uuid
      AND delivery_state = 'PROCESSING'
      AND lease_owner = ${leaseOwner}
      AND lease_token = ${leaseToken}
      AND lease_expires_at > ${now}
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return result.rows.length === 1;
}

export async function releaseOutboxForRetry(
  db: PersistenceDb,
  eventId: string,
  leaseOwner: string,
  leaseToken: string,
  now: Date,
  availableAt: Date,
  failureClass: OutboxFailureClass,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE outbox_events
    SET delivery_state = 'PENDING',
        available_at = ${availableAt},
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failure_class = ${failureClass},
        last_failure_message = NULL,
        updated_at = now()
    WHERE id = ${eventId}::uuid
      AND delivery_state = 'PROCESSING'
      AND lease_owner = ${leaseOwner}
      AND lease_token = ${leaseToken}
      AND lease_expires_at > ${now}
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return result.rows.length === 1;
}

export async function markOutboxTerminalFailure(
  db: PersistenceDb,
  eventId: string,
  leaseOwner: string,
  leaseToken: string,
  now: Date,
  failureClass: OutboxFailureClass,
  failureMessage: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE outbox_events
    SET delivery_state = 'FAILED',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_failure_class = ${failureClass},
        last_failure_message = left(${failureMessage}, 240),
        updated_at = now()
    WHERE id = ${eventId}::uuid
      AND delivery_state = 'PROCESSING'
      AND lease_owner = ${leaseOwner}
      AND lease_token = ${leaseToken}
      AND lease_expires_at > ${now}
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return result.rows.length === 1;
}

export async function replayOutboxEvent(
  db: PersistenceDb,
  input: { readonly eventId: string; readonly actorUserId: string; readonly reasonCode: string; readonly ticketReference?: string; readonly auditId: string; readonly now: Date },
): Promise<boolean> {
  requireUuid(input.eventId, 'eventId');
  requireUuid(input.actorUserId, 'actorUserId');
  requireUuid(input.auditId, 'auditId');
  validateReasonCode(input.reasonCode);
  if (input.ticketReference && !/^[A-Za-z0-9._:\/#-]{1,128}$/.test(input.ticketReference)) throw new RangeError('ticketReference must be bounded safe ASCII');
  return db.transaction(async (tx) => {
    const reset = await tx.execute(sql`
      WITH eligible AS (
        SELECT id, aggregate_type, aggregate_id, organization_id, correlation_id, last_failure_class, attempts
        FROM outbox_events
        WHERE id = ${input.eventId}::uuid
          AND delivery_state = 'FAILED'
          AND (expires_at IS NULL OR expires_at > ${input.now})
        FOR UPDATE
      )
      UPDATE outbox_events o
      SET delivery_state = 'PENDING',
          available_at = ${input.now},
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          attempts = 0,
          last_failure_class = NULL,
          last_failure_message = NULL,
          updated_at = now()
      FROM eligible
      WHERE o.id = eligible.id
      RETURNING eligible.id, eligible.aggregate_type, eligible.aggregate_id, eligible.organization_id, eligible.correlation_id, eligible.last_failure_class, eligible.attempts
    `) as QueryResult<{ id: string; aggregate_type: string; aggregate_id: string; organization_id: string | null; correlation_id: string; last_failure_class: string | null; attempts: number }>;
    const [event] = reset.rows;
    if (!event) return false;

    await tx.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (
        ${input.auditId}::uuid,
        ${input.actorUserId}::uuid,
        'outbox.event.replayed',
        'outbox_event',
        ${event.id},
        ${event.organization_id}::uuid,
        'SUCCESS',
        ${event.correlation_id},
        ${JSON.stringify({ reasonCode: input.reasonCode, ticketReference: input.ticketReference, priorFailureClass: event.last_failure_class, priorAttempts: event.attempts })}::jsonb
      )
    `);
    return true;
  });
}

export async function handleEventIdempotently<T>(
  db: PersistenceDb,
  input: {
    readonly consumerName: string;
    readonly eventId: string;
    readonly receiptId?: string;
    readonly failureClass?: string;
    readonly effect: (tx: PersistenceDb) => Promise<T>;
  },
): Promise<{ readonly executed: boolean; readonly result?: T }> {
  const failureClass = sanitizeFailureClass(input.failureClass ?? 'CONSUMER_EFFECT_FAILED');
  let safeFailure: EventConsumerEffectError | undefined;
  const outcome = await db.transaction(async (tx) => {
    const receipt = await tx.execute(sql`
      INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, attempts)
      VALUES (${input.receiptId ?? randomUUID()}::uuid, ${input.consumerName}, ${input.eventId}::uuid, 'STARTED', 1)
      ON CONFLICT (consumer_name, event_id)
      DO UPDATE SET status = 'STARTED',
                    attempts = event_consumer_receipts.attempts + 1,
                    last_failure_class = NULL,
                    updated_at = now()
      WHERE event_consumer_receipts.status <> 'SUCCEEDED'
      RETURNING status
    `) as QueryResult<{ status: 'STARTED' | 'FAILED' | 'SUCCEEDED' }>;

    if (receipt.rows.length === 0) return { executed: false };

    try {
      await tx.execute(sql`SAVEPOINT event_consumer_effect`);
      const result = await input.effect(tx);
      await tx.execute(sql`RELEASE SAVEPOINT event_consumer_effect`);
      await tx.execute(sql`
        UPDATE event_consumer_receipts
        SET status = 'SUCCEEDED', succeeded_at = now(), last_failure_class = NULL, updated_at = now()
        WHERE consumer_name = ${input.consumerName}
          AND event_id = ${input.eventId}::uuid
          AND status <> 'SUCCEEDED'
      `);
      return { executed: true, result };
    } catch {
      await tx.execute(sql`ROLLBACK TO SAVEPOINT event_consumer_effect`);
      await tx.execute(sql`RELEASE SAVEPOINT event_consumer_effect`);
      await tx.execute(sql`
        UPDATE event_consumer_receipts
        SET status = 'FAILED',
            last_failure_class = ${failureClass},
            updated_at = now()
        WHERE consumer_name = ${input.consumerName}
          AND event_id = ${input.eventId}::uuid
          AND status <> 'SUCCEEDED'
      `);
      safeFailure = new EventConsumerEffectError(failureClass);
      return { executed: true };
    }
  });
  if (safeFailure) throw safeFailure;
  return outcome;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function validateLeaseInput(input: { readonly leaseOwner: string; readonly batchSize: number; readonly leaseDurationMs: number; readonly now: Date }): void {
  validateLeaseOwner(input.leaseOwner);
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 1000) throw new RangeError('batchSize must be an integer from 1 to 1000');
  if (!Number.isInteger(input.leaseDurationMs) || input.leaseDurationMs < 1 || input.leaseDurationMs > 60 * 60 * 1000) throw new RangeError('leaseDurationMs must be between 1ms and 1h');
  if (!Number.isFinite(input.now.getTime())) throw new RangeError('now must be a valid Date');
}

function validateLeaseOwner(leaseOwner: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(leaseOwner)) throw new RangeError('leaseOwner must be bounded safe ASCII');
}

function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100) throw new RangeError('maxAttempts must be an integer from 1 to 100');
  for (const [name, value] of Object.entries({ maxEventAgeMs: policy.maxEventAgeMs, baseDelayMs: policy.baseDelayMs, maxDelayMs: policy.maxDelayMs })) {
    if (!Number.isFinite(value) || value < 1) throw new RangeError(`${name} must be positive`);
  }
  if (policy.baseDelayMs > policy.maxDelayMs) throw new RangeError('baseDelayMs must not exceed maxDelayMs');
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) throw new RangeError('jitterRatio must be in [0,1]');
}

async function assertCurrentOutboxLease(db: PersistenceDb, eventId: string, leaseOwner: string, leaseToken: string, now: Date): Promise<void> {
  const result = await db.execute(sql`
    SELECT id
    FROM outbox_events
    WHERE id = ${eventId}::uuid
      AND delivery_state = 'PROCESSING'
      AND lease_owner = ${leaseOwner}
      AND lease_token = ${leaseToken}
      AND lease_expires_at > ${now}
    LIMIT 1
  `) as QueryResult<{ id: string }>;
  if (result.rows.length !== 1) throw new OutboxLeaseStateError('outbox lease is no longer current');
}

async function ensureUpdated(update: Promise<boolean>): Promise<void> {
  if (!(await update)) throw new OutboxLeaseStateError('outbox lease update did not match a current claim');
}

function requireUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new RangeError(`${field} must be a UUID`);
}

function validateReasonCode(value: string): void {
  if (!/^[A-Z0-9_:-]{3,64}$/.test(value)) throw new RangeError('reasonCode must be an uppercase bounded code');
}

function sanitizeFailureClass(value: string): string {
  const sanitized = value.replace(/[^A-Z0-9_:-]/gi, '_').toUpperCase().slice(0, 80);
  return sanitized || 'CONSUMER_EFFECT_FAILED';
}
