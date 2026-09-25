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

  it('validates payload values, versions, canonical correlation shape, and JSON compatibility', () => {
    expect(() => invitationEvent({ correlationId: 'system' })).toThrow(/correlationId must match/);
    expect(() => invitationEvent({ correlationId: 'bad quote"' })).toThrow(/correlationId must match/);
    expect(() => invitationEvent({ correlationId: 'bad\\slash' })).toThrow(/correlationId must match/);
    expect(() => invitationEvent({ correlationId: 'bad space' })).toThrow(/correlationId must match/);
    expect(() => invitationEvent({ correlationId: 'api-correlation-123' })).not.toThrow();
    expect(() => invitationEvent({ payload: { userId: null, invitationId: randomUUID() } })).toThrow(/payload field userId must be a UUID string/);
    expect(() => invitationEvent({ payload: { userId: 7, invitationId: randomUUID() } })).toThrow(/payload field userId must be a UUID string/);
    expect(() => invitationEvent({ payload: { userId: undefined, invitationId: randomUUID() } })).toThrow(/payload.userId must not be undefined/);
    expect(() => invitationEvent({ payload: { userId: 'not-a-uuid', invitationId: randomUUID() } })).toThrow(/payload.userId must be an opaque UUID/);
    expect(() => invitationEvent({ payload: { userId: randomUUID(), invitationId: randomUUID(), nested: { surprise: true } } })).toThrow(/unexpected payload field nested/);
    expect(() => invitationEvent({ aggregateVersion: Number.NaN })).toThrow(/aggregateVersion must be a positive integer/);
  });

  it('registers every persistence outbox producer event literal', () => {
    const sourceFiles = [
      resolve(process.cwd(), '../persistence/src/repositories.ts'),
      resolve(process.cwd(), '../persistence/src/identity-authentication.ts'),
    ];
    const registered: Set<string> = new Set(Object.values(eventSchemas).map((schema) => schema.eventType));
    const emitted = new Set<string>();
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/['"]([a-z][a-z0-9_.-]+\.[a-z0-9_.-]+)['"]/g)) {
        if (match[1]?.includes('.')) emitted.add(match[1]);
      }
    }
    const producerEvents = [...emitted].filter((eventType) => (
      eventType.includes('created')
      || eventType.includes('accepted')
      || eventType.includes('assigned')
      || eventType.includes('provisioned')
      || eventType.includes('suspended')
      || eventType.includes('revoked')
    ));
    expect(producerEvents.filter((eventType) => !registered.has(eventType))).toEqual([]);
  });

  it('keeps the in-memory service event list explicitly out of the integration producer contract', () => {
    const text = readFileSync(resolve(process.cwd(), '../../apps/api/src/application/identity-organization/services.ts'), 'utf8');
    expect(text).toContain('SequenceIdGenerator');
    expect(text).toContain('organization.role.assigned');
  });

  it('accepts the organization.role.assigned producer contract with a role payload', () => {
    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(),
      eventType: 'organization.role.assigned',
      eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z',
      aggregateId: randomUUID(),
      organizationId: randomUUID(),
      actorId: randomUUID(),
      correlationId: 'role-contract-1',
      payload: { membershipId: randomUUID(), role: 'PLACEMENT_ADMIN' },
    })).not.toThrow();
    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(),
      eventType: 'organization.role.assigned',
      eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z',
      aggregateId: randomUUID(),
      correlationId: 'role-contract-2',
      payload: { membershipId: randomUUID(), role: 'OWNER_OF_EVERYTHING' },
    })).toThrow(/invalid enum/);
  });

  it('allows safe opaque future identifiers without permitting raw document or answer content', () => {
    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(),
      eventType: 'document.reference.recorded',
      eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z',
      aggregateId: randomUUID(),
      correlationId: 'doc-reference-1',
      payload: { documentId: randomUUID(), documentVersionId: randomUUID() },
    })).not.toThrow();
    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(),
      eventType: 'assessment.answer_sheet.recorded',
      eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z',
      aggregateId: randomUUID(),
      correlationId: 'answer-sheet-1',
      payload: { answerSheetId: randomUUID() },
    })).not.toThrow();
    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(),
      eventType: 'document.reference.recorded',
      eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z',
      aggregateId: randomUUID(),
      correlationId: 'doc-reference-2',
      payload: { documentId: randomUUID(), documentVersionId: randomUUID(), documentContent: 'raw essay answers' },
    })).toThrow(/unexpected payload field documentContent/);
  });

  it('enforces expiry and deterministic serialization', () => {
    const event = invitationEvent({ expiresAt: '2026-08-18T00:05:00.000Z' });
    const first = serializeIntegrationEvent(event);
    const second = serializeIntegrationEvent({ ...event, payload: { invitationId: event.payload.invitationId, userId: event.payload.userId } });
    expect(first).toBe(second);
    expect(() => invitationEvent({ expiresAt: '2026-08-17T23:59:59.000Z' })).toThrow(/expiresAt must be after occurredAt/);
  });

  it('keeps career-readiness event payloads opaque and purpose-bound', () => {
    const event = createIntegrationEventEnvelope({
      eventId: randomUUID(), eventType: 'assessment.attempt.submitted', eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z', aggregateId: randomUUID(),
      subjectId: randomUUID(), correlationId: 'career-readiness-event-1',
      payload: { attemptId: randomUUID(), evidenceId: randomUUID(), outcomeBand: 'PROGRESSING' },
    });
    expect(event.payload).not.toHaveProperty('answers');
    expect(event).toMatchObject({ producer: 'career-readiness', purpose: 'assessment-scoring-and-projection' });
    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(), eventType: 'assessment.attempt.submitted', eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z', aggregateId: randomUUID(), correlationId: 'career-readiness-event-2',
      payload: { attemptId: randomUUID(), evidenceId: randomUUID(), outcomeBand: 'PROGRESSING', answers: 'raw' },
    })).toThrow(/unexpected payload field answers/);
  });

  it('accepts NOT_ENOUGH_EVIDENCE as a submitted check outcome, so one attempt never has to claim a band (C3)', () => {
    const event = createIntegrationEventEnvelope({
      eventId: randomUUID(), eventType: 'assessment.attempt.submitted', eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z', aggregateId: randomUUID(), correlationId: 'career-readiness-event-3',
      payload: { attemptId: randomUUID(), evidenceId: randomUUID(), outcomeBand: 'NOT_ENOUGH_EVIDENCE' },
    });
    expect(event.payload).toMatchObject({ outcomeBand: 'NOT_ENOUGH_EVIDENCE' });
    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(), eventType: 'assessment.attempt.submitted', eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z', aggregateId: randomUUID(), correlationId: 'career-readiness-event-4',
      payload: { attemptId: randomUUID(), evidenceId: randomUUID(), outcomeBand: 'READY' },
    })).toThrow();
  });

  it('registers minimum-data seeded content generation lifecycle events', () => {
    const requestId = randomUUID();
    const contentId = randomUUID();
    const actorId = randomUUID();
    const requested = createIntegrationEventEnvelope({
      eventId: randomUUID(), eventType: 'content.generation.requested', eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z', aggregateId: requestId,
      actorId, correlationId: 'content-generation-1',
      payload: { requestId, contentId, seedKey: 'COMPANY_RESEARCH_CHECKLIST' },
    });
    expect(requested).toMatchObject({ producer: 'learner-content', aggregateType: 'content_generation_request' });

    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(), eventType: 'content.generation.completed', eventVersion: 1,
      occurredAt: '2026-08-18T00:00:01.000Z', aggregateId: contentId,
      actorId, correlationId: requested.correlationId, causationId: requested.eventId,
      payload: { requestId, contentId, seedKey: 'COMPANY_RESEARCH_CHECKLIST', reviewState: 'DRAFT', source: 'SEEDED' },
    })).not.toThrow();
    expect(() => createIntegrationEventEnvelope({
      eventId: randomUUID(), eventType: 'content.generation.requested', eventVersion: 1,
      occurredAt: '2026-08-18T00:00:00.000Z', aggregateId: requestId,
      actorId: randomUUID(), correlationId: 'content-generation-2',
      payload: { requestId, contentId, seedKey: 'UNREGISTERED_SEED' },
    })).toThrow(/invalid enum/);
  });
});
