import { randomUUID } from 'node:crypto';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { validateIntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import {
  LEARNER_CONTENT_SEED_KEYS,
  assertLearnerContentDraft,
  learnerContentSeed,
  type LearnerContentSeedKey,
} from '@planthepath/learner-content';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import { validateOutboxWriteInput, type PersistenceDb } from './repositories.js';
import * as schema from './schema.js';

export const CONTENT_GENERATION_CONSUMER = 'learner-content-seeded-generation-v1';

export interface SeededContentGenerationRequest {
  readonly requestId: string;
  readonly contentId: string;
  readonly eventId: string;
  readonly seedKey: LearnerContentSeedKey;
  readonly requestedByUserId: string;
  readonly correlationId: string;
  readonly requestedAt?: Date;
}

/**
 * Request-side handler: validates and persists one outbox job, then returns.
 * Generation is deliberately absent from this call path.
 */
export async function handleSeededContentGenerationRequest(
  db: PersistenceDb,
  input: SeededContentGenerationRequest,
): Promise<{ readonly requestId: string; readonly contentId: string; readonly eventId: string; readonly state: 'QUEUED' }> {
  const outbox = {
    id: input.eventId,
    aggregateType: 'content_generation_request',
    aggregateId: input.requestId,
    eventType: 'content.generation.requested',
    eventVersion: 1,
    payload: { requestId: input.requestId, contentId: input.contentId, seedKey: input.seedKey },
    actorUserId: input.requestedByUserId,
    correlationId: input.correlationId,
  } as const;
  validateOutboxWriteInput(outbox);
  await db.insert(schema.outboxEvents).values({
    id: outbox.id,
    aggregateType: outbox.aggregateType,
    aggregateId: outbox.aggregateId,
    eventType: outbox.eventType,
    eventVersion: outbox.eventVersion,
    payload: outbox.payload,
    actorUserId: outbox.actorUserId,
    correlationId: outbox.correlationId,
    ...(input.requestedAt ? { occurredAt: input.requestedAt, availableAt: input.requestedAt } : {}),
  });
  return { requestId: input.requestId, contentId: input.contentId, eventId: input.eventId, state: 'QUEUED' };
}

/** Consumes a dispatched request using the existing receipt-based idempotency rail. */
export async function consumeSeededContentGenerationRequested(
  db: PersistenceDb,
  event: IntegrationEventEnvelope,
): Promise<{ readonly executed: boolean; readonly contentId?: string }> {
  validateIntegrationEventEnvelope(event);
  if (event.eventType !== 'content.generation.requested' || event.eventVersion !== 1) {
    throw new Error('event is outside the seeded content generation consumer contract');
  }
  if (!event.actorId) throw new Error('seeded content generation requires an actor');
  const actorId = event.actorId;
  const requestId = requirePayloadUuid(event.payload.requestId, 'requestId');
  const contentId = requirePayloadUuid(event.payload.contentId, 'contentId');
  const seedKey = requireSeedKey(event.payload.seedKey);
  if (event.aggregateId !== requestId) throw new Error('generation request aggregate does not match payload');
  const seed = learnerContentSeed(seedKey);

  const outcome = await handleEventIdempotently(db, {
    consumerName: CONTENT_GENERATION_CONSUMER,
    eventId: event.eventId,
    failureClass: 'CONTENT_SEED_INSERT_FAILED',
    effect: async (tx) => {
      const draft = {
        id: contentId,
        contentType: seed.contentType,
        title: seed.title,
        summary: seed.summary,
        content: seed.content,
        source: 'SEEDED' as const,
        createdByUserId: actorId,
        sortOrder: seed.sortOrder,
        metadata: { ...seed.metadata, seedKey },
      };
      assertLearnerContentDraft(draft);
      await tx.insert(schema.learnerContentItems).values({
        id: draft.id,
        contentType: draft.contentType,
        title: draft.title,
        summary: draft.summary,
        content: draft.content,
        source: draft.source,
        reviewState: 'DRAFT',
        createdByUserId: draft.createdByUserId,
        sortOrder: draft.sortOrder,
        metadata: draft.metadata,
      });

      const completedEventId = randomUUID();
      const completedOutbox = {
        id: completedEventId,
        aggregateType: 'learner_content',
        aggregateId: contentId,
        eventType: 'content.generation.completed',
        eventVersion: 1,
        payload: { requestId, contentId, seedKey, reviewState: 'DRAFT', source: 'SEEDED' },
        actorUserId: actorId,
        correlationId: event.correlationId,
      } as const;
      validateOutboxWriteInput(completedOutbox);
      await tx.insert(schema.outboxEvents).values({
        id: completedOutbox.id,
        aggregateType: completedOutbox.aggregateType,
        aggregateId: completedOutbox.aggregateId,
        eventType: completedOutbox.eventType,
        eventVersion: completedOutbox.eventVersion,
        payload: completedOutbox.payload,
        actorUserId: completedOutbox.actorUserId,
        correlationId: completedOutbox.correlationId,
      });
      return contentId;
    },
  });
  if (!outcome.executed) return { executed: false };
  if (!outcome.result) throw new Error('seeded content generation completed without a content identifier');
  return { executed: true, contentId: outcome.result };
}

function requirePayloadUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`generation ${field} is invalid`);
  return value;
}

function requireSeedKey(value: unknown): LearnerContentSeedKey {
  if (typeof value !== 'string' || !LEARNER_CONTENT_SEED_KEYS.includes(value as LearnerContentSeedKey)) {
    throw new Error('generation seed key is invalid');
  }
  return value as LearnerContentSeedKey;
}
