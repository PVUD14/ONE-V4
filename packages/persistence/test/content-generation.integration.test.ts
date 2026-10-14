import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  consumeSeededContentGenerationRequested,
  handleSeededContentGenerationRequest,
} from '../src/content-generation.js';
import {
  InMemoryIntegrationEventPublisher,
  claimOutboxBatch,
  dispatchClaimedOutboxEvent,
} from '../src/outbox-dispatcher.js';
import * as schema from '../src/schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for content generation integration tests');

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });
const workerActorId = '33000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  const migrationDir = new URL('../drizzle/', import.meta.url);
  for (const migrationName of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(migrationName, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  await pool.query('TRUNCATE event_consumer_receipts, outbox_events, learner_content_items, users CASCADE');
  await pool.query(
    `INSERT INTO users (id, external_subject, email, state) VALUES ($1,$2,$3,'ACTIVE')`,
    [workerActorId, 'content-generation-test:actor', 'content-generation-actor@example.test'],
  );
});

afterAll(async () => pool.end());

describe('seeded content generation pipeline', () => {
  it('returns after enqueue, dispatches through the outbox, and generates a DRAFT before emitting completion', async () => {
    const requestId = randomUUID();
    const contentId = randomUUID();
    const eventId = randomUUID();
    const now = new Date('2026-09-05T08:00:00.000Z');

    const response = await handleSeededContentGenerationRequest(db, {
      requestId,
      contentId,
      eventId,
      seedKey: 'COMPANY_RESEARCH_CHECKLIST',
      requestedByUserId: workerActorId,
      correlationId: 'content-generation-e2e-1',
      requestedAt: now,
    });

    expect(response).toEqual({ requestId, contentId, eventId, state: 'QUEUED' });
    expect(await db.select().from(schema.learnerContentItems)).toHaveLength(0);
    const [requestedRow] = await db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.id, eventId));
    expect(requestedRow).toMatchObject({
      eventType: 'content.generation.requested',
      deliveryState: 'PENDING',
      payload: { requestId, contentId, seedKey: 'COMPANY_RESEARCH_CHECKLIST' },
    });

    const [claimed] = await claimOutboxBatch(db, {
      leaseOwner: 'content-generation-test-dispatcher', batchSize: 1, leaseDurationMs: 60_000, now,
    });
    expect(claimed).toBeDefined();
    const publisher = new InMemoryIntegrationEventPublisher();
    await expect(dispatchClaimedOutboxEvent(db, claimed!, publisher, {
      leaseOwner: claimed!.leaseOwner, leaseToken: claimed!.leaseToken, now,
    })).resolves.toBe('PUBLISHED');
    expect(publisher.published).toHaveLength(1);

    const first = await consumeSeededContentGenerationRequested(db, publisher.published[0]!);
    const duplicate = await consumeSeededContentGenerationRequested(db, publisher.published[0]!);
    expect(first).toEqual({ executed: true, contentId });
    expect(duplicate).toEqual({ executed: false });

    const contentRows = await db.select().from(schema.learnerContentItems);
    expect(contentRows).toHaveLength(1);
    expect(contentRows[0]).toMatchObject({
      id: contentId,
      contentType: 'COMPANY_PREP',
      title: 'Company research checklist',
      source: 'SEEDED',
      reviewState: 'DRAFT',
      publishedAt: null,
      createdByUserId: workerActorId,
      metadata: { locale: 'en-IN', seedVersion: 'd3-v1', seedKey: 'COMPANY_RESEARCH_CHECKLIST' },
    });

    const completedRows = await db.select().from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.eventType, 'content.generation.completed'));
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0]).toMatchObject({
      aggregateId: contentId,
      deliveryState: 'PENDING',
      payload: {
        requestId,
        contentId,
        seedKey: 'COMPANY_RESEARCH_CHECKLIST',
        reviewState: 'DRAFT',
        source: 'SEEDED',
      },
    });
  });

  it('rejects unrelated events without creating content', async () => {
    const eventId = randomUUID();
    const userId = randomUUID();
    const correlationId = 'content-generation-reject-1';
    const now = new Date();
    await pool.query('TRUNCATE outbox_events CASCADE');
    await db.insert(schema.outboxEvents).values({
      id: eventId,
      aggregateType: 'user',
      aggregateId: userId,
      eventType: 'identity.user.provisioned',
      payload: { userId },
      correlationId,
      availableAt: now,
    });
    const publisher = new InMemoryIntegrationEventPublisher();
    const [claimed] = await claimOutboxBatch(db, { leaseOwner: 'content-reject', batchSize: 1, leaseDurationMs: 60_000, now });
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error(`expected claim for correlation ${correlationId}`);
    expect(claimed).toMatchObject({ id: eventId, correlationId });
    await dispatchClaimedOutboxEvent(db, claimed, publisher, { leaseOwner: claimed.leaseOwner, leaseToken: claimed.leaseToken, now });

    await expect(consumeSeededContentGenerationRequested(db, publisher.published[0]!)).rejects.toThrow(/outside/);
    expect(await db.select().from(schema.learnerContentItems)).toHaveLength(0);
  });
});
