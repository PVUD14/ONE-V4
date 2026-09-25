import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import type { PersistenceDb } from './repositories.js';
import { claimOutboxBatch, dispatchClaimedOutboxEvent, markExpiredOutboxEvents, type IntegrationEventPublisher } from './outbox-dispatcher.js';
import {
  EventBridgeIntegrationEventPublisher,
  N8nAmbiguousDeliveryError,
  N8nAutomationAdapter,
  N8nRateLimitedError,
  SqsIntegrationEventConsumer,
  assertWorkflowInvocationAllowed,
  createAutomationRequestDigest,
  mintAutomationToken,
  validateAutomationToken,
  verifyAutomationToken,
} from '@planthepath/automation/src/index.js';
import {
  PostgresAutomationReplayStore,
  claimAutomationCommands,
  completeClaimedAutomationCommand,
  createAutomationCommandForNotificationEvent,
  deleteExpiredAutomationTokenReplays,
  loadCurrentAutomationWorkflowRegistration,
  releaseAutomationClaimForFailure,
  resolveClaimedEmailDelivery,
} from './automation-runtime.js';
import { consumeSeededContentGenerationRequested } from './content-generation.js';

export async function publishOutboxOnce(input: {
  readonly db: PersistenceDb; readonly publisher: IntegrationEventPublisher; readonly leaseOwner: string; readonly now: Date;
}): Promise<{ readonly claimed: number; readonly published: number; readonly retryScheduled: number; readonly terminal: number }> {
  await markExpiredOutboxEvents(input.db, { now: input.now, limit: 1_000 });
  const claimed = await claimOutboxBatch(input.db, { leaseOwner: input.leaseOwner, batchSize: 25, leaseDurationMs: 60_000, now: input.now });
  let published = 0;
  let retryScheduled = 0;
  let terminal = 0;
  for (const event of claimed) {
    const outcome = await dispatchClaimedOutboxEvent(input.db, event, input.publisher,
      { leaseOwner: event.leaseOwner, leaseToken: event.leaseToken, now: input.now });
    if (outcome === 'PUBLISHED') published += 1;
    else if (outcome === 'RETRY_SCHEDULED') retryScheduled += 1;
    else terminal += 1;
  }
  return { claimed: claimed.length, published, retryScheduled, terminal };
}

/**
 * The transport ADR-028 chose: the outbox table itself.
 *
 * A claimed outbox event is handed straight to the consumer that would otherwise have
 * received it from SQS, in the same process. `event_consumer_receipts` still provides
 * idempotency, and the outbox's own claim-with-lease, retry, backoff and terminal
 * state still provide at-least-once delivery — which is the guarantee the broker was
 * there to supply, minus the network.
 *
 * An event type with no local consumer is acknowledged rather than retried. That is
 * the faithful equivalent of publishing to a bus nobody subscribes to: the outbox row
 * remains the durable record either way, and failing them instead would drive every
 * unconsumed event type to FAILED and bury the ones that genuinely broke. The counter
 * is returned so "nothing is listening to this" stays visible in the worker log
 * rather than becoming silence.
 */
export function createLocalIntegrationEventPublisher(input: { readonly pool: Pool; readonly db: PersistenceDb }): {
  readonly publisher: IntegrationEventPublisher;
  readonly counts: () => { readonly handled: number; readonly unrouted: number };
} {
  let handled = 0;
  let unrouted = 0;
  const handlers: Readonly<Record<string, (event: IntegrationEventEnvelope) => Promise<void>>> = {
    'notification.delivery.requested': async (event) => {
      if (event.eventVersion !== 1) throw new Error('event is outside the notification consumer contract');
      await createAutomationCommandForNotificationEvent(input.pool, event.eventId);
    },
    'content.generation.requested': async (event) => {
      await consumeSeededContentGenerationRequested(input.db, event);
    },
  };
  return {
    publisher: {
      async publish(event: IntegrationEventEnvelope): Promise<void> {
        const handler = handlers[event.eventType];
        if (!handler) { unrouted += 1; return; }
        await handler(event);
        handled += 1;
      },
    },
    counts: () => ({ handled, unrouted }),
  };
}

export function createNotificationEventConsumer(input: { readonly pool: Pool; readonly queueUrl: string }): SqsIntegrationEventConsumer {
  return new SqsIntegrationEventConsumer(input.queueUrl, async (event) => {
    if (event.eventType !== 'notification.delivery.requested' || event.eventVersion !== 1) throw new Error('event is outside the notification consumer contract');
    await createAutomationCommandForNotificationEvent(input.pool, event.eventId);
  });
}

export function createContentGenerationEventConsumer(input: { readonly db: PersistenceDb; readonly queueUrl: string }): SqsIntegrationEventConsumer {
  return new SqsIntegrationEventConsumer(input.queueUrl, async (event) => {
    await consumeSeededContentGenerationRequested(input.db, event);
  });
}

export async function dispatchAutomationOnce(input: {
  readonly pool: Pool; readonly adapter: N8nAutomationAdapter; readonly invocationSigningSecret: Uint8Array;
  readonly callbackSigningSecret: Uint8Array; readonly leaseOwner: string; readonly now: Date;
}): Promise<{ readonly claimed: number; readonly succeeded: number; readonly retried: number; readonly terminal: number }> {
  await deleteExpiredAutomationTokenReplays(input.pool, input.now);
  const claims = await claimAutomationCommands(input.pool, { leaseOwner: input.leaseOwner, batchSize: 1, leaseDurationMs: 60_000, now: input.now });
  let succeeded = 0;
  let retried = 0;
  let terminal = 0;
  for (const claim of claims) {
    try {
      const nowEpochSeconds = Math.floor(input.now.getTime() / 1_000);
      const callbackId = `callback:${randomUUID()}`;
      const callbackToken = mintAutomationToken({ secret: input.callbackSigningSecret, audience: 'planthepath-automation-callback',
        subject: 'automation-command', tokenId: randomUUID(), nowEpochSeconds, lifetimeSeconds: 120, purpose: 'WORKFLOW_CALLBACK',
        workflowKey: claim.workflowKey, workflowRegistryId: claim.workflowRegistryId, commandId: claim.id,
        correlationId: claim.correlationId, payloadRef: claim.payloadRef });
      const resolvedDelivery = await resolveClaimedEmailDelivery(input.pool, claim, input.now);
      const delivery = { ...resolvedDelivery, callbackId, callbackToken };
      const currentRegistration = await loadCurrentAutomationWorkflowRegistration(input.pool, claim);
      assertWorkflowInvocationAllowed(currentRegistration, { allowlistId: claim.workflowKey, version: claim.workflowVersion,
        workflowHash: claim.workflowHash, operation: claim.operation, destinationClass: claim.destinationClass });
      const invocationToken = mintAutomationToken({ secret: input.invocationSigningSecret, audience: 'n8n-private', subject: 'automation-command',
        tokenId: randomUUID(), nowEpochSeconds, lifetimeSeconds: 15, purpose: 'WORKFLOW_INVOCATION', workflowKey: claim.workflowKey,
        workflowRegistryId: claim.workflowRegistryId, workflowVersion: claim.workflowVersion, workflowHash: claim.workflowHash,
        requestDigest: createAutomationRequestDigest(delivery), commandId: claim.id,
        correlationId: claim.correlationId, payloadRef: claim.payloadRef });
      await verifyAutomationToken(invocationToken,
        { secret: input.invocationSigningSecret, audience: 'n8n-private', purpose: 'WORKFLOW_INVOCATION', nowEpochSeconds,
          replayStore: new PostgresAutomationReplayStore(input.pool, claim.id, 'WORKFLOW_INVOCATION') });
      const callback = await input.adapter.invoke({ workflowKey: claim.workflowKey, invocationToken, delivery });
      const callbackClaims = validateAutomationToken(callback.callbackToken, { secret: input.callbackSigningSecret,
        audience: 'planthepath-automation-callback', purpose: 'WORKFLOW_CALLBACK', nowEpochSeconds });
      const completed = await completeClaimedAutomationCommand(input.pool, claim, { claims: callbackClaims,
        callbackId: callback.callbackId, status: callback.status,
        ...(callback.providerReference ? { providerReference: callback.providerReference } : {}) });
      if (!completed) throw new Error('automation command lease expired before callback commit');
      succeeded += 1;
    } catch (error) {
      const failure = classifyAutomationFailure(error);
      const released = await releaseAutomationClaimForFailure(input.pool, claim, { retryable: failure.retryable,
        failureClass: failure.failureClass, now: input.now });
      if (released && failure.retryable && claim.attempts < 5 && claim.expiresAt > input.now) retried += 1;
      else terminal += 1;
    }
  }
  return { claimed: claims.length, succeeded, retried, terminal };
}

export function createEventBridgePublisher(eventBusName: string): EventBridgeIntegrationEventPublisher {
  return new EventBridgeIntegrationEventPublisher(eventBusName);
}

function classifyAutomationFailure(error: unknown): {
  readonly retryable: boolean;
  readonly failureClass: 'N8N_TIMEOUT' | 'N8N_RATE_LIMITED' | 'N8N_UNAVAILABLE' | 'N8N_REJECTED';
} {
  if (error instanceof N8nRateLimitedError) return { retryable: true, failureClass: 'N8N_RATE_LIMITED' };
  if (error instanceof N8nAmbiguousDeliveryError) return { retryable: false, failureClass: 'N8N_TIMEOUT' };
  return { retryable: false, failureClass: 'N8N_REJECTED' };
}
