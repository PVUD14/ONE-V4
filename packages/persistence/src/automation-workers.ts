import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PersistenceDb } from './repositories.js';
import { claimOutboxBatch, dispatchClaimedOutboxEvent, markExpiredOutboxEvents, type IntegrationEventPublisher } from './outbox-dispatcher.js';
import {
  EventBridgeIntegrationEventPublisher,
  N8nAutomationAdapter,
  SqsIntegrationEventConsumer,
  assertWorkflowInvocationAllowed,
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
  releaseAutomationClaimForFailure,
  resolveClaimedEmailDelivery,
} from './automation-runtime.js';

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

export function createNotificationEventConsumer(input: { readonly pool: Pool; readonly queueUrl: string }): SqsIntegrationEventConsumer {
  return new SqsIntegrationEventConsumer(input.queueUrl, async (event) => {
    if (event.eventType !== 'notification.delivery.requested' || event.eventVersion !== 1) throw new Error('event is outside the notification consumer contract');
    await createAutomationCommandForNotificationEvent(input.pool, event.eventId);
  });
}

export async function dispatchAutomationOnce(input: {
  readonly pool: Pool; readonly adapter: N8nAutomationAdapter; readonly signingSecret: Uint8Array; readonly leaseOwner: string; readonly now: Date;
}): Promise<{ readonly claimed: number; readonly succeeded: number; readonly retried: number; readonly terminal: number }> {
  await deleteExpiredAutomationTokenReplays(input.pool, input.now);
  const claims = await claimAutomationCommands(input.pool, { leaseOwner: input.leaseOwner, batchSize: 10, leaseDurationMs: 60_000, now: input.now });
  let succeeded = 0;
  let retried = 0;
  let terminal = 0;
  for (const claim of claims) {
    try {
      assertWorkflowInvocationAllowed({ allowlistId: claim.workflowKey, version: claim.workflowVersion, workflowHash: claim.workflowHash,
        operation: claim.operation, destinationClass: claim.destinationClass, active: true, killSwitch: false },
      { allowlistId: claim.workflowKey, version: claim.workflowVersion, workflowHash: claim.workflowHash,
        operation: claim.operation, destinationClass: claim.destinationClass });
      const nowEpochSeconds = Math.floor(input.now.getTime() / 1_000);
      const invocationToken = mintAutomationToken({ secret: input.signingSecret, audience: 'n8n-private', subject: 'automation-command',
        tokenId: randomUUID(), nowEpochSeconds, lifetimeSeconds: 60, purpose: 'WORKFLOW_INVOCATION', workflowKey: claim.workflowKey,
        commandId: claim.id, correlationId: claim.correlationId, payloadRef: claim.payloadRef });
      await verifyAutomationToken(invocationToken,
        { secret: input.signingSecret, audience: 'n8n-private', purpose: 'WORKFLOW_INVOCATION', nowEpochSeconds,
          replayStore: new PostgresAutomationReplayStore(input.pool, claim.id, 'WORKFLOW_INVOCATION') });
      const callbackId = `callback:${randomUUID()}`;
      const callbackToken = mintAutomationToken({ secret: input.signingSecret, audience: 'planthepath-automation-callback',
        subject: 'automation-command', tokenId: randomUUID(), nowEpochSeconds, lifetimeSeconds: 120, purpose: 'WORKFLOW_CALLBACK',
        workflowKey: claim.workflowKey, commandId: claim.id, correlationId: claim.correlationId, payloadRef: claim.payloadRef });
      const delivery = await resolveClaimedEmailDelivery(input.pool, claim, input.now);
      const callback = await input.adapter.invoke({ workflowKey: claim.workflowKey, invocationToken, delivery: { ...delivery, callbackId, callbackToken } });
      const callbackClaims = validateAutomationToken(callback.callbackToken, { secret: input.signingSecret,
        audience: 'planthepath-automation-callback', purpose: 'WORKFLOW_CALLBACK', nowEpochSeconds });
      const completed = await completeClaimedAutomationCommand(input.pool, claim, { claims: callbackClaims,
        callbackId: callback.callbackId, status: callback.status,
        ...(callback.providerReference ? { providerReference: callback.providerReference } : {}) });
      if (!completed) throw new Error('automation command lease expired before callback commit');
      succeeded += 1;
    } catch (error) {
      const retryable = isRetryableAutomationFailure(error);
      const released = await releaseAutomationClaimForFailure(input.pool, claim, { retryable,
        failureClass: retryable ? 'N8N_UNAVAILABLE' : 'N8N_REJECTED', now: input.now });
      if (released && retryable && claim.attempts < 5 && claim.expiresAt > input.now) retried += 1;
      else terminal += 1;
    }
  }
  return { claimed: claims.length, succeeded, retried, terminal };
}

export function createEventBridgePublisher(eventBusName: string): EventBridgeIntegrationEventPublisher {
  return new EventBridgeIntegrationEventPublisher(eventBusName);
}

function isRetryableAutomationFailure(error: unknown): boolean {
  return error instanceof Error && /retryable|timeout|unavailable|abort|lease expired/i.test(error.message);
}
