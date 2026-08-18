import { createHmac, timingSafeEqual } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand, type PutEventsCommandOutput } from '@aws-sdk/client-eventbridge';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type DeleteMessageCommandOutput, type ReceiveMessageCommandOutput } from '@aws-sdk/client-sqs';
import {
  serializeIntegrationEvent,
  validateIntegrationEventEnvelope,
  type IntegrationEventEnvelope,
} from '@planthepath/events/src/index.js';

export interface EventBridgeSender {
  send(command: PutEventsCommand): Promise<PutEventsCommandOutput>;
}

export class EventBridgeIntegrationEventPublisher {
  readonly client: EventBridgeSender;

  constructor(
    readonly eventBusName: string,
    client: EventBridgeSender = new EventBridgeClient({}),
  ) {
    if (!/^[A-Za-z0-9._/-]{1,256}$/.test(eventBusName)) throw new Error('invalid EventBridge bus name');
    this.client = client;
  }

  async publish(event: IntegrationEventEnvelope): Promise<void> {
    validateIntegrationEventEnvelope(event);
    const result = await this.client.send(new PutEventsCommand({ Entries: [{
      EventBusName: this.eventBusName,
      Source: `com.planthepath.${event.producer}`,
      DetailType: event.eventType,
      Detail: serializeIntegrationEvent(event).trimEnd(),
      Time: new Date(event.occurredAt),
    }] }));
    if ((result.FailedEntryCount ?? 0) > 0 || result.Entries?.[0]?.ErrorCode) throw new Error('EventBridge rejected integration event');
  }
}

interface SqsCommandSender {
  send(command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput>;
  send(command: DeleteMessageCommand): Promise<DeleteMessageCommandOutput>;
}

export class SqsIntegrationEventConsumer {
  constructor(
    readonly queueUrl: string,
    readonly handler: (event: IntegrationEventEnvelope) => Promise<void>,
    readonly client: SqsCommandSender = new SQSClient({}),
  ) {
    const parsed = new URL(queueUrl);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
      throw new Error('SQS queue URL must use HTTPS');
    }
  }

  async pollOnce(): Promise<{ readonly received: number; readonly acknowledged: number; readonly failed: number }> {
    const response = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20, VisibilityTimeout: 60, MessageAttributeNames: ['All'], AttributeNames: ['All'] }));
    let acknowledged = 0;
    let failed = 0;
    for (const message of response.Messages ?? []) {
      try {
        if (!message.Body || !message.ReceiptHandle) throw new Error('SQS message is incomplete');
        const event = parseSqsEventBridgeMessage(message.Body);
        await this.handler(event);
        await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
        acknowledged += 1;
      } catch {
        failed += 1;
      }
    }
    return { received: response.Messages?.length ?? 0, acknowledged, failed };
  }
}

export function parseSqsEventBridgeMessage(body: string): IntegrationEventEnvelope {
  if (body.length > 262_144) throw new Error('SQS message exceeds the supported bound');
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('SQS message must be an object');
  const candidate = 'detail' in parsed ? (parsed as { detail: unknown }).detail : parsed;
  const event = typeof candidate === 'string' ? JSON.parse(candidate) as IntegrationEventEnvelope : candidate as IntegrationEventEnvelope;
  validateIntegrationEventEnvelope(event);
  return event;
}

export interface AutomationWorkflowRegistration {
  readonly allowlistId: string;
  readonly version: number;
  readonly workflowHash: string;
  readonly operation: string;
  readonly destinationClass: 'EMAIL';
  readonly active: boolean;
  readonly killSwitch: boolean;
}

export function assertWorkflowInvocationAllowed(registration: AutomationWorkflowRegistration, request: {
  readonly allowlistId: string; readonly version: number; readonly workflowHash: string; readonly operation: string;
  readonly destinationClass: 'EMAIL';
}): void {
  if (!registration.active || registration.killSwitch) throw new Error('automation workflow is disabled');
  if (registration.allowlistId !== request.allowlistId || registration.version !== request.version
    || registration.workflowHash !== request.workflowHash || registration.operation !== request.operation
    || registration.destinationClass !== request.destinationClass) throw new Error('automation workflow request is not allowlisted');
  if (!/^[0-9a-f]{64}$/i.test(request.workflowHash)) throw new Error('workflow hash must be SHA-256');
}

export interface AutomationTokenClaims {
  readonly iss: 'planthepath-automation-adapter';
  readonly aud: string;
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly purpose: 'WORKFLOW_INVOCATION' | 'WORKFLOW_CALLBACK';
  readonly workflowKey: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly payloadRef: string;
}

export interface ReplayStore {
  consume(jti: string, expiresAt: number): Promise<boolean>;
}

export class InMemoryReplayStore implements ReplayStore {
  readonly consumed = new Map<string, number>();

  async consume(jti: string, expiresAt: number): Promise<boolean> {
    if (this.consumed.has(jti)) return false;
    this.consumed.set(jti, expiresAt);
    return true;
  }
}

export function mintAutomationToken(input: {
  readonly secret: Uint8Array; readonly audience: string; readonly subject: string; readonly tokenId: string;
  readonly nowEpochSeconds: number; readonly lifetimeSeconds: number; readonly purpose: AutomationTokenClaims['purpose'];
  readonly workflowKey: string; readonly commandId: string; readonly correlationId: string; readonly payloadRef: string;
}): string {
  requireSecret(input.secret);
  if (!Number.isInteger(input.lifetimeSeconds) || input.lifetimeSeconds < 15 || input.lifetimeSeconds > 300) throw new Error('automation token lifetime must be 15 to 300 seconds');
  for (const [field, value] of Object.entries({ audience: input.audience, subject: input.subject, tokenId: input.tokenId,
    workflowKey: input.workflowKey, commandId: input.commandId, correlationId: input.correlationId, payloadRef: input.payloadRef })) {
    if (!/^[A-Za-z0-9._:-]{3,256}$/.test(value)) throw new Error(`invalid automation token ${field}`);
  }
  const claims: AutomationTokenClaims = { iss: 'planthepath-automation-adapter', aud: input.audience, sub: input.subject,
    jti: input.tokenId, iat: input.nowEpochSeconds, exp: input.nowEpochSeconds + input.lifetimeSeconds, purpose: input.purpose,
    workflowKey: input.workflowKey, commandId: input.commandId, correlationId: input.correlationId, payloadRef: input.payloadRef };
  const encodedHeader = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'automation-hmac-v1' }));
  const encodedPayload = base64Url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${base64Url(createHmac('sha256', input.secret).update(signingInput).digest())}`;
}

export async function verifyAutomationToken(token: string, input: {
  readonly secret: Uint8Array; readonly audience: string; readonly purpose: AutomationTokenClaims['purpose'];
  readonly nowEpochSeconds: number; readonly replayStore: ReplayStore;
}): Promise<AutomationTokenClaims> {
  const claims = validateAutomationToken(token, input);
  if (!await input.replayStore.consume(claims.jti, claims.exp)) throw new Error('automation token replay was rejected');
  return claims;
}

export function validateAutomationToken(token: string, input: {
  readonly secret: Uint8Array; readonly audience: string; readonly purpose: AutomationTokenClaims['purpose'];
  readonly nowEpochSeconds: number;
}): AutomationTokenClaims {
  requireSecret(input.secret);
  if (token.length > 4096) throw new Error('automation token is too large');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('automation token is malformed');
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  const header = JSON.parse(fromBase64Url(encodedHeader).toString('utf8')) as Record<string, unknown>;
  if (header.alg !== 'HS256' || header.typ !== 'JWT' || header.kid !== 'automation-hmac-v1') throw new Error('automation token header is invalid');
  const expected = createHmac('sha256', input.secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const supplied = fromBase64Url(encodedSignature);
  if (base64Url(supplied) !== encodedSignature || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('automation token signature is invalid');
  }
  const claims = JSON.parse(fromBase64Url(encodedPayload).toString('utf8')) as AutomationTokenClaims;
  if (claims.iss !== 'planthepath-automation-adapter' || claims.aud !== input.audience || claims.purpose !== input.purpose) {
    throw new Error('automation token scope is invalid');
  }
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= input.nowEpochSeconds || claims.iat > input.nowEpochSeconds + 30
    || claims.exp - claims.iat > 300) throw new Error('automation token time window is invalid');
  for (const value of [claims.sub, claims.jti, claims.workflowKey, claims.commandId, claims.correlationId, claims.payloadRef]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{3,256}$/.test(value)) throw new Error('automation token claims are invalid');
  }
  return claims;
}

export interface EmailDeliveryInvocation {
  readonly commandId: string;
  readonly idempotencyId: string;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly textBody: string;
  readonly expiresAt: string;
  readonly callbackId: string;
  readonly callbackToken: string;
}

export interface N8nDeliveryCallback {
  readonly status: 'SUCCEEDED';
  readonly callbackId: string;
  readonly callbackToken: string;
  readonly providerReference?: string;
}

export class N8nAutomationAdapter {
  readonly baseUrl: URL;

  constructor(baseUrl: string, readonly transportCredential: string, readonly fetcher: typeof fetch = fetch) {
    this.baseUrl = new URL(baseUrl);
    if (transportCredential.length < 32 || transportCredential.length > 256) throw new Error('n8n transport credential must contain 32 to 256 characters');
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) throw new Error('n8n base URL must not contain credentials, query, or fragment');
    const localHttp = this.baseUrl.protocol === 'http:' && ['n8n', '127.0.0.1', 'localhost'].includes(this.baseUrl.hostname);
    if (this.baseUrl.protocol !== 'https:' && !localHttp) throw new Error('n8n base URL must use HTTPS outside the private local runtime');
  }

  async invoke(input: {
    readonly workflowKey: string; readonly invocationToken: string; readonly delivery: EmailDeliveryInvocation; readonly timeoutMs?: number;
  }): Promise<N8nDeliveryCallback> {
    if (!/^[a-z0-9-]{3,64}$/.test(input.workflowKey)) throw new Error('invalid workflow key');
    for (const [field, value] of Object.entries({ commandId: input.delivery.commandId, idempotencyId: input.delivery.idempotencyId,
      callbackId: input.delivery.callbackId })) {
      if (!/^[A-Za-z0-9._:-]{8,256}$/.test(value)) throw new Error(`invalid automation delivery ${field}`);
    }
    if (input.invocationToken.length < 32 || input.invocationToken.length > 4096
      || input.delivery.callbackToken.length < 32 || input.delivery.callbackToken.length > 4096) {
      throw new Error('automation delivery token is outside bounded limits');
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.delivery.expiresAt)
      || !Number.isFinite(Date.parse(input.delivery.expiresAt))) throw new Error('automation delivery expiry is invalid');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.delivery.recipientEmail) || input.delivery.recipientEmail.length > 254) throw new Error('invalid recipient email');
    if (input.delivery.subject.length < 1 || input.delivery.subject.length > 160 || input.delivery.textBody.length < 1 || input.delivery.textBody.length > 10_000) {
      throw new Error('email content is outside bounded limits');
    }
    const timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('n8n timeout must be 100 to 30000 milliseconds');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const endpoint = new URL(`/webhook/${input.workflowKey}`, this.baseUrl);
      const response = await this.fetcher(endpoint, { method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${input.invocationToken}`, 'X-PlanThePath-Adapter-Key': this.transportCredential,
          'Content-Type': 'application/json', 'Idempotency-Key': input.delivery.idempotencyId },
        body: JSON.stringify(input.delivery) });
      if (!response.ok) throw new Error(response.status >= 500 || response.status === 429 ? 'n8n retryable delivery failure' : 'n8n terminal delivery failure');
      const callback = await readN8nCallback(response);
      if (callback.callbackId !== input.delivery.callbackId || callback.callbackToken !== input.delivery.callbackToken) {
        throw new Error('n8n callback binding is invalid');
      }
      return callback;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readN8nCallback(response: Response): Promise<N8nDeliveryCallback> {
  const raw = await response.text();
  if (raw.length < 2 || raw.length > 8_192) throw new Error('n8n callback payload is outside bounded limits');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('n8n callback payload is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('n8n callback payload is invalid');
  const candidate = parsed as Record<string, unknown>;
  if (candidate.status !== 'SUCCEEDED' || typeof candidate.callbackId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(candidate.callbackId)
    || typeof candidate.callbackToken !== 'string' || candidate.callbackToken.length < 32 || candidate.callbackToken.length > 4096
    || (candidate.providerReference !== undefined && (typeof candidate.providerReference !== 'string'
      || !/^[A-Za-z0-9._:@<>-]{1,256}$/.test(candidate.providerReference)))) {
    throw new Error('n8n callback payload is invalid');
  }
  return { status: 'SUCCEEDED', callbackId: candidate.callbackId, callbackToken: candidate.callbackToken,
    ...(typeof candidate.providerReference === 'string' ? { providerReference: candidate.providerReference } : {}) };
}

function requireSecret(secret: Uint8Array): void {
  if (secret.byteLength < 32) throw new Error('automation signing secret must contain at least 32 bytes');
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('automation token encoding is invalid');
  return Buffer.from(value, 'base64url');
}
