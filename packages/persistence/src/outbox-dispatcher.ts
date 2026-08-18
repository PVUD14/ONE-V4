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
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jitterWindow = raw * policy.jitterRatio;
  const jitter = Math.floor(policy.random() * jitterWindow);
  return Math.min(policy.maxDelayMs, raw + jitter);
}

export async function claimOutboxBatch(
  db: PersistenceDb,
  input: { readonly leaseOwner: string; readonly batchSize: number; readonly leaseDurationMs: number; readonly now: Date },
): Promise<readonly ClaimedOutboxEvent[]> {
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT id
      FROM outbox_events
      WHERE delivery_state = 'PENDING'
        AND available_at <= ${input.now}
        AND (expires_at IS NULL OR expires_at > ${input.now})
        AND (lease_expires_at IS NULL OR lease_expires_at <= ${input.now})
      ORDER BY available_at ASC, occurred_at ASC, id ASC
      LIMIT ${input.batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events o
    SET delivery_state = 'PROCESSING',
        lease_owner = ${input.leaseOwner},
        lease_expires_at = ${new Date(input.now.getTime() + input.leaseDurationMs)},
        attempts = attempts + 1,
        updated_at = now()
    FROM candidates
    WHERE o.id = candidates.id
    RETURNING o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.event_version, o.payload,
              o.actor_user_id, o.organization_id, o.correlation_id, o.occurred_at, o.attempts,
              o.available_at, o.expires_at, o.lease_owner
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
  input: { readonly leaseOwner: string; readonly now: Date; readonly retryPolicy?: RetryPolicy },
): Promise<void> {
  const retryPolicy = input.retryPolicy ?? defaultRetryPolicy;
  if (event.expiresAt && event.expiresAt <= input.now) {
    await markOutboxTerminalFailure(db, event.id, input.leaseOwner, 'EVENT_EXPIRED', 'event expired before publish');
    return;
  }
  if (input.now.getTime() - event.occurredAt.getTime() > retryPolicy.maxEventAgeMs) {
    await markOutboxTerminalFailure(db, event.id, input.leaseOwner, 'EVENT_EXPIRED', 'event exceeded maximum age');
    return;
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
    await markOutboxTerminalFailure(db, event.id, input.leaseOwner, 'SCHEMA_VALIDATION_FAILED', 'event schema validation failed');
    return;
  }

  try {
    await publisher.publish(envelope);
    await markOutboxPublished(db, event.id, input.leaseOwner, input.now);
  } catch (error) {
    const retryable = !(error instanceof OutboxPublishError) || error.retryable;
    if (!retryable || event.attempts >= retryPolicy.maxAttempts) {
      await markOutboxTerminalFailure(db, event.id, input.leaseOwner, 'TERMINAL_PUBLISH_FAILURE', 'publisher terminal failure');
      return;
    }
    const delayMs = computeRetryDelayMs(event.attempts, retryPolicy);
    await releaseOutboxForRetry(db, event.id, input.leaseOwner, new Date(input.now.getTime() + delayMs), 'RETRYABLE_PUBLISH_FAILURE');
  }
}

export async function markOutboxPublished(db: PersistenceDb, eventId: string, leaseOwner: string, publishedAt: Date): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE outbox_events
    SET delivery_state = 'PUBLISHED',
        published_at = ${publishedAt},
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_failure_class = NULL,
        last_failure_message = NULL,
        updated_at = now()
    WHERE id = ${eventId}::uuid
      AND delivery_state = 'PROCESSING'
      AND lease_owner = ${leaseOwner}
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return result.rows.length === 1;
}

export async function releaseOutboxForRetry(
  db: PersistenceDb,
  eventId: string,
  leaseOwner: string,
  availableAt: Date,
  failureClass: OutboxFailureClass,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE outbox_events
    SET delivery_state = 'PENDING',
        available_at = ${availableAt},
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_failure_class = ${failureClass},
        last_failure_message = NULL,
        updated_at = now()
    WHERE id = ${eventId}::uuid
      AND delivery_state = 'PROCESSING'
      AND lease_owner = ${leaseOwner}
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return result.rows.length === 1;
}

export async function markOutboxTerminalFailure(
  db: PersistenceDb,
  eventId: string,
  leaseOwner: string,
  failureClass: OutboxFailureClass,
  failureMessage: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE outbox_events
    SET delivery_state = 'FAILED',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_failure_class = ${failureClass},
        last_failure_message = left(${failureMessage}, 240),
        updated_at = now()
    WHERE id = ${eventId}::uuid
      AND delivery_state = 'PROCESSING'
      AND lease_owner = ${leaseOwner}
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return result.rows.length === 1;
}

export async function replayOutboxEvent(
  db: PersistenceDb,
  input: { readonly eventId: string; readonly actorUserId: string; readonly reason: string; readonly auditId: string; readonly now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const reset = await tx.execute(sql`
      UPDATE outbox_events
      SET delivery_state = 'PENDING',
          available_at = ${input.now},
          lease_owner = NULL,
          lease_expires_at = NULL,
          published_at = NULL,
          last_failure_class = NULL,
          last_failure_message = NULL,
          updated_at = now()
      WHERE id = ${input.eventId}::uuid
        AND (expires_at IS NULL OR expires_at > ${input.now})
      RETURNING id, aggregate_type, aggregate_id, organization_id, correlation_id
    `) as QueryResult<{ id: string; aggregate_type: string; aggregate_id: string; organization_id: string | null; correlation_id: string }>;
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
        ${JSON.stringify({ reason: input.reason })}::jsonb
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
  return db.transaction(async (tx) => {
    const receipt = await tx.execute(sql`
      INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, attempts)
      VALUES (${input.receiptId ?? randomUUID()}::uuid, ${input.consumerName}, ${input.eventId}::uuid, 'STARTED', 1)
      ON CONFLICT (consumer_name, event_id)
      DO UPDATE SET attempts = event_consumer_receipts.attempts + 1, updated_at = now()
      WHERE event_consumer_receipts.status <> 'SUCCEEDED'
      RETURNING status
    `) as QueryResult<{ status: 'STARTED' | 'FAILED' | 'SUCCEEDED' }>;

    if (receipt.rows.length === 0) return { executed: false };

    try {
      const result = await input.effect(tx);
      await tx.execute(sql`
        UPDATE event_consumer_receipts
        SET status = 'SUCCEEDED', succeeded_at = now(), last_failure_class = NULL, updated_at = now()
        WHERE consumer_name = ${input.consumerName}
          AND event_id = ${input.eventId}::uuid
          AND status <> 'SUCCEEDED'
      `);
      return { executed: true, result };
    } catch (error) {
      await tx.execute(sql`
        UPDATE event_consumer_receipts
        SET status = 'FAILED',
            last_failure_class = ${input.failureClass ?? 'CONSUMER_EFFECT_FAILED'},
            updated_at = now()
        WHERE consumer_name = ${input.consumerName}
          AND event_id = ${input.eventId}::uuid
          AND status <> 'SUCCEEDED'
      `);
      throw error;
    }
  });
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
