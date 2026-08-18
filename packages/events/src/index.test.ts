import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EventValidationError,
  createIntegrationEventEnvelope,
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

  it('enforces expiry and deterministic serialization', () => {
    const event = invitationEvent({ expiresAt: '2026-08-18T00:05:00.000Z' });
    const first = serializeIntegrationEvent(event);
    const second = serializeIntegrationEvent({ ...event, payload: { invitationId: event.payload.invitationId, userId: event.payload.userId } });
    expect(first).toBe(second);
    expect(() => invitationEvent({ expiresAt: '2026-08-17T23:59:59.000Z' })).toThrow(/expiresAt must be after occurredAt/);
  });
});
