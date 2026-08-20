import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createIntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import {
  EventBridgeIntegrationEventPublisher,
  InMemoryReplayStore,
  N8nAmbiguousDeliveryError,
  N8nAutomationAdapter,
  N8nRateLimitedError,
  SqsIntegrationEventConsumer,
  assertWorkflowInvocationAllowed,
  mintAutomationToken,
  parseSqsEventBridgeMessage,
  verifyAutomationToken,
  validateAutomationToken,
} from '../src/index.js';

function notificationEvent() {
  const commandId = randomUUID();
  return createIntegrationEventEnvelope({ eventId: randomUUID(), eventType: 'notification.delivery.requested', eventVersion: 1,
    occurredAt: '2026-08-18T12:00:00.000Z', aggregateId: commandId, actorId: randomUUID(), correlationId: 'automation-event-1',
    payload: { commandId, templateId: randomUUID(), channel: 'EMAIL' } });
}

describe('production event boundary', () => {
  it('publishes validated least-data events to the configured EventBridge bus', async () => {
    const send = vi.fn().mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: randomUUID() }] });
    const publisher = new EventBridgeIntegrationEventPublisher('planthepath-production', { send });
    await publisher.publish(notificationEvent());
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(send.mock.calls[0])).not.toContain('@example');
  });

  it('validates SQS EventBridge envelopes and acknowledges only successful handling', async () => {
    const event = notificationEvent();
    expect(parseSqsEventBridgeMessage(JSON.stringify({ detail: JSON.stringify(event) }))).toEqual(event);
    const send = vi.fn()
      .mockResolvedValueOnce({ Messages: [{ Body: JSON.stringify({ detail: event }), ReceiptHandle: 'receipt-1' }] })
      .mockResolvedValueOnce({});
    const handler = vi.fn().mockResolvedValue(undefined);
    const consumer = new SqsIntegrationEventConsumer('https://sqs.ap-south-1.amazonaws.com/123456789012/ptp', handler, { send });
    await expect(consumer.pollOnce()).resolves.toEqual({ received: 1, acknowledged: 1, failed: 0 });
    expect(handler).toHaveBeenCalledWith(event);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('signed allowlisted automation boundary', () => {
  const secret = randomBytes(32);
  const input = { secret, audience: 'n8n-private', subject: 'automation-command', tokenId: randomUUID(), nowEpochSeconds: 1_787_056_800,
    lifetimeSeconds: 60, purpose: 'WORKFLOW_INVOCATION' as const, workflowKey: 'assessment-result-email', commandId: randomUUID(),
    workflowRegistryId: randomUUID(), workflowVersion: 1, workflowHash: 'a'.repeat(64), requestDigest: 'b'.repeat(64),
    correlationId: 'automation-correlation-1', payloadRef: `notification:${randomUUID()}` };

  it('enforces registry hash, version, operation and kill switch', () => {
    const registration = { allowlistId: 'assessment-result-email', version: 1, workflowHash: 'a'.repeat(64),
      operation: 'SEND_EMAIL', destinationClass: 'EMAIL' as const, active: true, killSwitch: false };
    expect(() => assertWorkflowInvocationAllowed(registration, { ...registration })).not.toThrow();
    expect(() => assertWorkflowInvocationAllowed({ ...registration, killSwitch: true }, { ...registration })).toThrow('disabled');
    expect(() => assertWorkflowInvocationAllowed(registration, { ...registration, workflowHash: 'b'.repeat(64) })).toThrow('not allowlisted');
  });

  it('accepts a short-lived audience-bound token once and rejects tampering, expiry, and replay', async () => {
    const token = mintAutomationToken(input);
    const replayStore = new InMemoryReplayStore();
    await expect(verifyAutomationToken(token, { secret, audience: 'n8n-private', purpose: 'WORKFLOW_INVOCATION',
      nowEpochSeconds: input.nowEpochSeconds + 1, replayStore })).resolves.toMatchObject({ commandId: input.commandId });
    await expect(verifyAutomationToken(token, { secret, audience: 'n8n-private', purpose: 'WORKFLOW_INVOCATION',
      nowEpochSeconds: input.nowEpochSeconds + 2, replayStore })).rejects.toThrow('replay');
    await expect(verifyAutomationToken(`${token.slice(0, -1)}x`, { secret, audience: 'n8n-private', purpose: 'WORKFLOW_INVOCATION',
      nowEpochSeconds: input.nowEpochSeconds + 1, replayStore: new InMemoryReplayStore() })).rejects.toThrow('signature');
    await expect(verifyAutomationToken(token, { secret, audience: 'n8n-private', purpose: 'WORKFLOW_INVOCATION',
      nowEpochSeconds: input.nowEpochSeconds + 61, replayStore: new InMemoryReplayStore() })).rejects.toThrow('time window');
    await expect(verifyAutomationToken(token, { secret, audience: 'wrong-audience', purpose: 'WORKFLOW_INVOCATION',
      nowEpochSeconds: input.nowEpochSeconds + 1, replayStore: new InMemoryReplayStore() })).rejects.toThrow('scope');
    await expect(verifyAutomationToken(token, { secret, audience: 'n8n-private', purpose: 'WORKFLOW_CALLBACK',
      nowEpochSeconds: input.nowEpochSeconds + 1, replayStore: new InMemoryReplayStore() })).rejects.toThrow('header');
    expect(validateAutomationToken(token, { secret, audience: 'n8n-private', purpose: 'WORKFLOW_INVOCATION',
      nowEpochSeconds: input.nowEpochSeconds + 1 })).toMatchObject({ commandId: input.commandId });
  });

  it('sends only a bounded email command to the private n8n webhook', async () => {
    const callbackId = 'callback-automation-delivery-1';
    const callbackToken = 'callback-token-placeholder-0000000000000001';
    const response = new Response(JSON.stringify({ status: 'SUCCEEDED', callbackId, callbackToken, providerReference: 'execution-1' }), { status: 200 });
    const fetcher = vi.fn().mockResolvedValue(response);
    const adapter = new N8nAutomationAdapter('http://n8n:5678', fetcher);
    const invocationToken = mintAutomationToken(input);
    await expect(adapter.invoke({ workflowKey: input.workflowKey, invocationToken, delivery: {
      commandId: input.commandId, idempotencyId: 'automation-delivery-1', recipientEmail: 'learner@example.test',
      subject: 'Your result is available', textBody: 'Open PlanThePath to review your advisory result.',
      expiresAt: '2026-08-18T12:05:00.000Z', callbackId, callbackToken,
    } })).resolves.toEqual({ status: 'SUCCEEDED', callbackId, callbackToken, providerReference: 'execution-1' });
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual({ Authorization: `Bearer ${invocationToken}`,
      'Content-Type': 'application/json', 'Idempotency-Key': 'automation-delivery-1' });
    expect(String(request.body)).not.toContain('readinessBand');
    expect(String(request.body)).not.toContain('score');
  });

  it('rejects unbound delivery input and mismatched synchronous callbacks', async () => {
    const callbackToken = 'callback-token-placeholder-0000000000000001';
    const adapter = new N8nAutomationAdapter('http://n8n:5678', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'SUCCEEDED', callbackId: 'callback-wrong-0001', callbackToken }), { status: 200 }),
    ));
    const delivery = { commandId: input.commandId, idempotencyId: 'automation-delivery-1', recipientEmail: 'learner@example.test',
      subject: 'Your result is available', textBody: 'Open PlanThePath to review your advisory result.',
      expiresAt: '2026-08-18T12:05:00.000Z', callbackId: 'callback-automation-delivery-1', callbackToken };
    await expect(adapter.invoke({ workflowKey: input.workflowKey, invocationToken: mintAutomationToken(input), delivery }))
      .rejects.toBeInstanceOf(N8nAmbiguousDeliveryError);
    await expect(adapter.invoke({ workflowKey: input.workflowKey, invocationToken: 'short', delivery }))
      .rejects.toThrow('token');
    await expect(adapter.invoke({ workflowKey: input.workflowKey, invocationToken: mintAutomationToken(input),
      delivery: { ...delivery, expiresAt: 'not-a-date' } })).rejects.toThrow('expiry');
  });

  it('retries only pre-execution throttling and treats server or network outcomes as ambiguous', async () => {
    const delivery = {
      commandId: input.commandId, idempotencyId: 'automation-delivery-1', recipientEmail: 'learner@example.test',
      subject: 'Your result is available', textBody: 'Open PlanThePath to review your advisory result.',
      expiresAt: '2026-08-18T12:05:00.000Z', callbackId: 'callback-automation-delivery-1',
      callbackToken: 'callback-token-placeholder-0000000000000001',
    };
    const rateLimited = new N8nAutomationAdapter('http://n8n:5678',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));
    await expect(rateLimited.invoke({ workflowKey: input.workflowKey, invocationToken: mintAutomationToken(input), delivery }))
      .rejects.toBeInstanceOf(N8nRateLimitedError);
    const unavailable = new N8nAutomationAdapter('http://n8n:5678',
      vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    await expect(unavailable.invoke({ workflowKey: input.workflowKey, invocationToken: mintAutomationToken(input), delivery }))
      .rejects.toBeInstanceOf(N8nAmbiguousDeliveryError);
    const disconnected = new N8nAutomationAdapter('http://n8n:5678', vi.fn().mockRejectedValue(new Error('connection reset')));
    await expect(disconnected.invoke({ workflowKey: input.workflowKey, invocationToken: mintAutomationToken(input), delivery }))
      .rejects.toBeInstanceOf(N8nAmbiguousDeliveryError);
  });
});
