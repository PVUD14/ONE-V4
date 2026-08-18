import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EventValidationError,
  createIntegrationEventEnvelope,
  eventSchemas,
  serializeIntegrationEvent,
  validateIntegrationEventEnvelope,
} from './index.js';

function invitationEvent(overrides: Partial<Parameters<typeof validateIntegrationEventEnvelope>[0]> = {}) {
  return createIntegrationEventEnvelope({
    eventId: randomUUID(),
    eventType: 'identity.invitation.accepted',
    eventVersion: 1,
    occurredAt: '2026-08-18T00:00:00.000Z',
    aggregateId: randomUUID(),
    organizationId: randomUUID(),
    subjectId: randomUUID(),
    actorId: randomUUID(),
    correlationId: randomUUID(),
    payload: { userId: randomUUID(), invitationId: randomUUID() },
    ...overrides,
  });
}

describe('integration event envelope', () => {
  it('creates a registered versioned event envelope with required fields', () => {
    const event = invitationEvent();
    expect(event).toMatchObject({
      eventType: 'identity.invitation.accepted',
      eventVersion: 1,
      producer: 'identity-organization',
      aggregateType: 'user',
      purpose: 'identity-invitation-acceptance',
      dataClassification: 'confidential',
      schemaRef: 'registry://identity.invitation.accepted/1',
    });
  });

  it('fails safely for unknown event versions', () => {
    expect(() => invitationEvent({ eventVersion: 2 })).toThrow(EventValidationError);
  });

  it('requires minimum payload and rejects unexpected fields', () => {
    expect(() => invitationEvent({ payload: { userId: randomUUID() } })).toThrow(/missing payload field invitationId/);
    expect(() => invitationEvent({ payload: { userId: randomUUID(), invitationId: randomUUID(), rawEmail: 'person@example.test' } })).toThrow(/unexpected payload field rawEmail/);
  });

  it('rejects prohibited or sensitive payload content', () => {
    expect(() => invitationEvent({ payload: { userId: randomUUID(), invitationId: randomUUID(), invitationToken: 'abc' } })).toThrow(/unexpected payload field invitationToken/);
    expect(() => invitationEvent({ payload: { userId: 'person@example.test', invitationId: randomUUID() } })).toThrow(/looks sensitive/);
  });

  it('validates payload values, versions, correlation shape, and JSON compatibility', () => {
    expect(() => invitationEvent({ correlationId: 'system' })).toThrow(/correlationId must be bounded printable ASCII/);
    expect(() => invitationEvent({ correlationId: 'api-correlation-123' })).not.toThrow();
    expect(() => invitationEvent({ payload: { userId: null, invitationId: randomUUID() } })).toThrow(/payload field userId must be a UUID string/);
    expect(() => invitationEvent({ payload: { userId: 7, invitationId: randomUUID() } })).toThrow(/payload field userId must be a UUID string/);
    expect(() => invitationEvent({ payload: { userId: undefined, invitationId: randomUUID() } })).toThrow(/payload.userId must not be undefined/);
    expect(() => invitationEvent({ payload: { userId: 'not-a-uuid', invitationId: randomUUID() } })).toThrow(/payload.userId must be an opaque UUID/);
    expect(() => invitationEvent({ payload: { userId: randomUUID(), invitationId: randomUUID(), nested: { surprise: true } } })).toThrow(/unexpected payload field nested/);
    expect(() => invitationEvent({ aggregateVersion: Number.NaN })).toThrow(/aggregateVersion must be a positive integer/);
  });

  it('registers every executable application event literal', () => {
    const sourceFiles = [
      resolve(process.cwd(), '../../apps/api/src/application/identity-organization/services.ts'),
      resolve(process.cwd(), '../persistence/src/repositories.ts'),
      resolve(process.cwd(), '../persistence/src/identity-authentication.ts'),
    ];
    const registered = new Set(Object.values(eventSchemas).map((schema) => schema.eventType));
    const emitted = new Set<string>();
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/['"]([a-z][a-z0-9_.-]+\.[a-z0-9_.-]+)['"]/g)) {
        if (match[1]?.includes('.')) emitted.add(match[1]);
      }
    }
    expect([...emitted].filter((eventType) => eventType.includes('created') || eventType.includes('accepted') || eventType.includes('assigned') || eventType.includes('provisioned') || eventType.includes('suspended')).sort())
      .toEqual([...registered].sort());
  });

  it('enforces expiry and deterministic serialization', () => {
    const event = invitationEvent({ expiresAt: '2026-08-18T00:05:00.000Z' });
    const first = serializeIntegrationEvent(event);
    const second = serializeIntegrationEvent({ ...event, payload: { invitationId: event.payload.invitationId, userId: event.payload.userId } });
    expect(first).toBe(second);
    expect(() => invitationEvent({ expiresAt: '2026-08-17T23:59:59.000Z' })).toThrow(/expiresAt must be after occurredAt/);
  });
});
