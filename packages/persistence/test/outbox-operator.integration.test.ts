/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * The two things ADR-028 requires to exist before a dispatcher is ever deployed:
 * a way to retire the accumulated backlog, and a way for a person to redrive a dead
 * letter. Neither had a caller before, and the first worker to start without them
 * would deliver months of events at once.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../src/schema.js';
import { listFailedOutboxEvents, replayOutboxEvent, supersedeOutboxBacklog } from '../src/outbox-dispatcher.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });
const migrationDir = new URL('../drizzle/', import.meta.url);

let actorId: string;
let marker: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  actorId = randomUUID();
  marker = randomUUID();
  await pool.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [actorId, actorId + '@example.test']);
});

// Cleanup then close: these tests write outside a transaction because the dispatcher
// functions manage their own.
afterAll(async () => {
  await db.execute(sql`DELETE FROM outbox_events WHERE aggregate_type = 'test_aggregate'`);
  await pool.end();
});

/** A pending event, aged so the cutoff can be expressed without touching the clock. */
async function seedPending(ageDays: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at, delivery_state, available_at)
     VALUES ($1,'test_aggregate',$2,'notification.delivery.requested',$3::jsonb, now() - ($4 || ' days')::interval, 'PENDING', now())`,
    [id, randomUUID(), JSON.stringify({ marker }), String(ageDays)],
  );
  return id;
}

describe('outbox backlog disposition', () => {
  it('retires stale pending events without touching recent ones', async () => {
    const stale = await seedPending(45);
    const recent = await seedPending(1);

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const superseded = await supersedeOutboxBacklog(db, {
      olderThan: cutoff, actorUserId: actorId, reasonCode: 'PRE_DISPATCHER_BACKLOG',
      auditId: randomUUID(), correlationId: randomUUID(), limit: 1_000, now: new Date(),
    });
    expect(superseded).toBeGreaterThanOrEqual(1);

    const states = await pool.query<{ id: string; delivery_state: string; last_failure_class: string | null }>(
      'SELECT id, delivery_state, last_failure_class FROM outbox_events WHERE id = ANY($1::uuid[])', [[stale, recent]],
    );
    const byId = new Map(states.rows.map((row) => [row.id, row]));
    expect(byId.get(stale)?.delivery_state).toBe('FAILED');
    // Its own failure class, so a retired backlog is never read as a delivery that broke.
    expect(byId.get(stale)?.last_failure_class).toBe('SUPERSEDED_BACKLOG');
    expect(byId.get(recent)?.delivery_state).toBe('PENDING');
  });

  it('records one audit row carrying the cutoff and the count', async () => {
    await seedPending(45);
    const auditId = randomUUID();
    await supersedeOutboxBacklog(db, {
      olderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), actorUserId: actorId,
      reasonCode: 'PRE_DISPATCHER_BACKLOG', auditId, correlationId: randomUUID(), limit: 1_000, now: new Date(),
    });
    const audit = await pool.query<{ action: string; context: Record<string, unknown> }>(
      'SELECT action, context FROM audit_events WHERE id=$1', [auditId],
    );
    expect(audit.rows[0]?.action).toBe('outbox.backlog.superseded');
    expect(audit.rows[0]?.context.reasonCode).toBe('PRE_DISPATCHER_BACKLOG');
    expect(audit.rows[0]?.context.olderThan).toBeTruthy();
  });

  it('rejects a reason code outside the bounded shape', async () => {
    await expect(supersedeOutboxBacklog(db, {
      olderThan: new Date(), actorUserId: actorId, reasonCode: 'no lowercase or spaces',
      auditId: randomUUID(), correlationId: randomUUID(), limit: 10, now: new Date(),
    })).rejects.toThrow();
  });
});

describe('dead letter and redrive', () => {
  it('lists a failed event and replays it back to pending', async () => {
    const id = await seedPending(45);
    await supersedeOutboxBacklog(db, {
      olderThan: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), actorUserId: actorId,
      reasonCode: 'PRE_DISPATCHER_BACKLOG', auditId: randomUUID(), correlationId: randomUUID(),
      limit: 1_000, now: new Date(),
    });

    const failed = await listFailedOutboxEvents(db, { limit: 500 });
    expect(failed.some((event) => event.id === id)).toBe(true);

    const replayed = await replayOutboxEvent(db, {
      eventId: id, actorUserId: actorId, reasonCode: 'OPERATOR_REDRIVE',
      auditId: randomUUID(), now: new Date(),
    });
    expect(replayed).toBe(true);

    const after = await pool.query<{ delivery_state: string; attempts: number }>(
      'SELECT delivery_state, attempts FROM outbox_events WHERE id=$1', [id],
    );
    expect(after.rows[0]?.delivery_state).toBe('PENDING');
    expect(after.rows[0]?.attempts).toBe(0);
  });

  it('refuses to replay an event that is not in the dead letter', async () => {
    const id = await seedPending(1);
    const replayed = await replayOutboxEvent(db, {
      eventId: id, actorUserId: actorId, reasonCode: 'OPERATOR_REDRIVE',
      auditId: randomUUID(), now: new Date(),
    });
    expect(replayed).toBe(false);
  });
});
