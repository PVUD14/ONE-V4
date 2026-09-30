/**
 * Background jobs health: bounded summary, keyset list and breach alerting (OPS-04).
 *
 * The acceptance rule under test is "a threshold breach produces one alert, not one per
 * event": an evaluator run repeatedly during one breach raises exactly one alert, clears
 * it when the condition recovers, and raises a new one only for a new breach. Delivery
 * uses the existing ops-failure workflow when it is switched on, and is recorded as
 * NOT_DELIVERED otherwise. Nothing claims an email that was not queued.
 *
 * Real Postgres, in a throwaway schema so the counts belong to this file alone.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema.js';
import {
  JOBS_COUNT_CAP,
  evaluateJobsAlerts,
  getFailedJobDetail,
  listFailedJobs,
  readJobsAlertConfig,
  readJobsHealthSummary,
} from '../src/jobs-health.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const schemaName = 'jobs_health_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const migrationDir = new URL('../drizzle/', import.meta.url);

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, migrationDir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  // The migrator replays every file on every run: the new migration must survive that.
  await pool.query(await readFile(new URL('0045_jobs_health_alerts.sql', migrationDir), 'utf8'));
}, 180_000);

afterAll(async () => {
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

beforeEach(async () => {
  await pool.query('ALTER TABLE jobs_health_alerts DISABLE TRIGGER jobs_health_alert_guard');
  await pool.query('DELETE FROM jobs_health_alerts');
  await pool.query('ALTER TABLE jobs_health_alerts ENABLE TRIGGER jobs_health_alert_guard');
  await pool.query('DELETE FROM notification_delivery_attempts');
  await pool.query('DELETE FROM notification_commands');
  await pool.query('DELETE FROM notification_templates');
  await pool.query('DELETE FROM event_consumer_receipts');
  await pool.query('DELETE FROM outbox_events');
  await pool.query('DELETE FROM automation_workflow_registry');
});

const config = (overrides: Record<string, string> = {}) =>
  readJobsAlertConfig({ JOBS_ALERT_FAILED_THRESHOLD: '3', JOBS_ALERT_PENDING_STALL_MINUTES: '30', ...overrides });

async function failed(count: number, input: { eventType?: string; ageMinutes?: number; failureClass?: string; payload?: Record<string, unknown> } = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at, delivery_state, attempts, last_failure_class, last_failure_message)
       VALUES ($1,'test_aggregate',$2,$3,$4::jsonb, now() - ($5 || ' minutes')::interval - ($6 || ' milliseconds')::interval, 'FAILED', 5, $7, 'upstream said: secret-stack-trace')`,
      [id, randomUUID(), input.eventType ?? 'notification.delivery.requested', JSON.stringify(input.payload ?? { marker: 'payload' }),
        String(input.ageMinutes ?? 1), String(index), input.failureClass ?? 'TERMINAL_PUBLISH_FAILURE'],
    );
  }
  return ids;
}

async function pending(waitingMinutes: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at, available_at, delivery_state)
     VALUES ($1,'test_aggregate',$2,'notification.delivery.requested','{}'::jsonb, now() - ($3 || ' minutes')::interval, now() - ($3 || ' minutes')::interval, 'PENDING')`,
    [id, randomUUID(), String(waitingMinutes)],
  );
  return id;
}

async function platformStaff(count: number): Promise<string[]> {
  const organizationId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [organizationId]);
  const users: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const userId = randomUUID();
    users.push(userId);
    await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, userId + '@example.test']);
    await pool.query(
      "INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,'OPERATIONS_ADMIN','ACTIVE',$2)",
      [randomUUID(), organizationId, userId],
    );
  }
  return users;
}

async function enableOpsFailure(approverUserId: string): Promise<void> {
  await pool.query(
    "INSERT INTO automation_workflow_registry (id,allowlist_id,version,workflow_hash,operation,destination_class,active,kill_switch) VALUES ($1,'ops-failure',1,repeat('c',64),'SEND_EMAIL','EMAIL',true,false)",
    [randomUUID()],
  );
  await pool.query(
    `INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
     VALUES ($1,'ops-failure',1,'en-IN','ONE: background jobs need attention','Open Operations, System Health.',$2,now())
     ON CONFLICT (stable_key, version, locale) DO NOTHING`,
    [randomUUID(), approverUserId],
  );
}

const alertCount = async (): Promise<number> => Number((await pool.query('SELECT count(*) FROM jobs_health_alerts')).rows[0].count);

describe('breach alerting', () => {
  it('raises one alert for a breach however many events fail and however often it runs', async () => {
    await failed(3);
    const first = await evaluateJobsAlerts(db, config());
    expect(first.raised.map((alert) => alert.conditionKey)).toEqual(['FAILED_EVENTS_THRESHOLD']);
    expect(first.raised[0]).toMatchObject({ observedValue: 3, threshold: 3, notice: 'NOT_DELIVERED', state: 'OPEN' });

    await failed(5);
    const second = await evaluateJobsAlerts(db, config());
    const third = await evaluateJobsAlerts(db, config());
    expect(second.raised).toEqual([]);
    expect(third.raised).toEqual([]);
    expect(await alertCount()).toBe(1);
  });

  it('clears the alert when the condition recovers and raises a new one for a new breach', async () => {
    const ids = await failed(3);
    await evaluateJobsAlerts(db, config());
    await pool.query("UPDATE outbox_events SET delivery_state='PENDING', available_at=now() + interval '1 hour' WHERE id = ANY($1::uuid[])", [ids]);
    const recovered = await evaluateJobsAlerts(db, config());
    expect(recovered.cleared.map((alert) => alert.conditionKey)).toEqual(['FAILED_EVENTS_THRESHOLD']);
    expect(recovered.cleared[0]!.clearedAt).not.toBeNull();
    await failed(4);
    const again = await evaluateJobsAlerts(db, config());
    expect(again.raised).toHaveLength(1);
    expect(await alertCount()).toBe(2);
  });

  it('queues one ops-failure email per platform staff member only when the workflow and an approved template exist', async () => {
    const staff = await platformStaff(2);
    await enableOpsFailure(staff[0]!);
    await failed(3);
    const result = await evaluateJobsAlerts(db, config());
    expect(result.raised[0]!.notice).toBe('QUEUED');
    const commands = await pool.query(
      "SELECT n.subject_user_id, n.render_parameters, n.dedupe_key, t.stable_key FROM notification_commands n JOIN notification_templates t ON t.id=n.template_id",
    );
    expect(commands.rows.map((row) => row.subject_user_id).sort()).toEqual([...staff].sort());
    expect(commands.rows.every((row) => row.stable_key === 'ops-failure')).toBe(true);
    // The email names the condition class only: no payload, no failure text, no identifiers.
    expect(JSON.stringify(commands.rows.map((row) => row.render_parameters))).not.toMatch(/payload|secret-stack-trace|test_aggregate/);
    const requested = await pool.query("SELECT count(*) FROM outbox_events WHERE event_type='notification.delivery.requested' AND aggregate_type='notification_command'");
    expect(Number(requested.rows[0].count)).toBe(2);
    // A second run during the same breach sends nothing more.
    await evaluateJobsAlerts(db, config());
    expect(Number((await pool.query('SELECT count(*) FROM notification_commands')).rows[0].count)).toBe(2);
  });

  it('records NOT_DELIVERED when the workflow is behind its kill switch', async () => {
    const staff = await platformStaff(1);
    await enableOpsFailure(staff[0]!);
    await pool.query("UPDATE automation_workflow_registry SET kill_switch = true WHERE allowlist_id='ops-failure'");
    await failed(3);
    const result = await evaluateJobsAlerts(db, config());
    expect(result.raised[0]!.notice).toBe('NOT_DELIVERED');
    expect(Number((await pool.query('SELECT count(*) FROM notification_commands')).rows[0].count)).toBe(0);
  });

  it('raises a stalled-worker alert when a due event waits past the limit, and not before', async () => {
    await pending(10);
    expect((await evaluateJobsAlerts(db, config())).raised).toEqual([]);
    await pending(45);
    const result = await evaluateJobsAlerts(db, config());
    expect(result.raised.map((alert) => alert.conditionKey)).toEqual(['PENDING_EVENTS_STALLED']);
    expect(result.raised[0]!.observedValue).toBeGreaterThanOrEqual(45);
  });

  it('judges consumer silence only for a configured consumer', async () => {
    expect((await evaluateJobsAlerts(db, config())).raised).toEqual([]);
    const configured = config({ JOBS_ALERT_CONSUMER_SILENCE_MINUTES: 'student-invitation-delivery=60' });
    const result = await evaluateJobsAlerts(db, configured);
    expect(result.raised).toHaveLength(1);
    expect(result.raised[0]).toMatchObject({ conditionKey: 'CONSUMER_SILENT', subject: 'student-invitation-delivery' });
    // A receipt now clears it.
    const eventId = (await failed(1, { eventType: 'institution.student.invitation.requested' }))[0]!;
    await pool.query("INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, attempts) VALUES ($1,'student-invitation-delivery',$2,'FAILED',1)", [randomUUID(), eventId]);
    expect((await evaluateJobsAlerts(db, configured)).cleared).toHaveLength(1);
  });

  it('lists the learner skill state projector as a consumer and can alert on its silence', async () => {
    // Gap 1 of the ENG-17 incident runbook: the projector had no Consumers row and its name was
    // refused by JOBS_ALERT_CONSUMER_SILENCE_MINUTES.
    const configured = config({ JOBS_ALERT_CONSUMER_SILENCE_MINUTES: 'learner-skill-state-projector=60' });
    expect(configured.ignored).toEqual([]);
    expect(configured.consumerSilenceMinutes).toEqual({ 'learner-skill-state-projector': 60 });
    const summary = await readJobsHealthSummary(db, configured);
    expect(summary.consumers.find((consumer) => consumer.name === 'learner-skill-state-projector'))
      .toMatchObject({ label: 'Learner skill state projection', lastActivityAt: null, silenceMinutes: 60 });
    const result = await evaluateJobsAlerts(db, configured);
    expect(result.raised).toHaveLength(1);
    expect(result.raised[0]).toMatchObject({ conditionKey: 'CONSUMER_SILENT', subject: 'learner-skill-state-projector' });
    const eventId = (await failed(1, { eventType: 'learning.skill_state.projection_requested' }))[0]!;
    await pool.query("INSERT INTO event_consumer_receipts (id, consumer_name, event_id, status, attempts) VALUES ($1,'learner-skill-state-projector',$2,'FAILED',1)", [randomUUID(), eventId]);
    expect((await evaluateJobsAlerts(db, configured)).cleared).toHaveLength(1);
  });

  it('keeps the alert record immutable and undeletable, and at most one open alert per condition', async () => {
    await failed(3);
    const [alert] = (await evaluateJobsAlerts(db, config())).raised;
    await expect(pool.query('UPDATE jobs_health_alerts SET observed_value = 0 WHERE id=$1', [alert!.id])).rejects.toThrow(/immutable/);
    await expect(pool.query('DELETE FROM jobs_health_alerts WHERE id=$1', [alert!.id])).rejects.toThrow(/never deleted/);
    await expect(pool.query(
      "INSERT INTO jobs_health_alerts (id, condition_key, observed_value, threshold, notice, correlation_id) VALUES ($1,'FAILED_EVENTS_THRESHOLD',9,3,'NOT_DELIVERED','jobs-alert:test-dup')",
      [randomUUID()],
    )).rejects.toThrow(/jobs_health_alert_open_uq/);
    await pool.query("UPDATE jobs_health_alerts SET state='CLEARED' WHERE id=$1", [alert!.id]);
    await expect(pool.query("UPDATE jobs_health_alerts SET state='OPEN' WHERE id=$1", [alert!.id])).rejects.toThrow(/cannot change/);
  });

  it('ignores an unusable configuration value and says so', () => {
    const parsed = readJobsAlertConfig({ JOBS_ALERT_FAILED_THRESHOLD: 'lots', JOBS_ALERT_CONSUMER_SILENCE_MINUTES: 'unknown-consumer=5' });
    expect(parsed.failedThreshold).toBe(10);
    expect(parsed.pendingStallMinutes).toBe(30);
    expect(parsed.consumerSilenceMinutes).toEqual({});
    expect(parsed.ignored).toEqual(['JOBS_ALERT_FAILED_THRESHOLD', 'JOBS_ALERT_CONSUMER_SILENCE_MINUTES']);
  });
});

describe('bounded summary and failed-event views', () => {
  it('reports empty sources as null rather than inventing a value', async () => {
    const summary = await readJobsHealthSummary(db, config());
    expect(summary.outbox.counts.FAILED).toEqual({ value: 0, capped: false });
    expect(summary.outbox.oldestPendingAt).toBeNull();
    expect(summary.worker).toMatchObject({ verdict: 'NO_WORK_WAITING', lastDeliveredAt: null });
    expect(summary.consumers.every((consumer) => consumer.lastActivityAt === null && consumer.silent === null)).toBe(true);
    expect(summary.automation.lastCommandAt).toBeNull();
    expect(summary.alerts.delivery).toEqual({ workflowEnabled: false, templateApproved: false });
  });

  it('counts by state, groups failures, and judges the worker stalled from waiting work', async () => {
    await failed(2, { eventType: 'content.generation.requested', failureClass: 'SCHEMA_VALIDATION_FAILED' });
    await failed(1);
    await pending(45);
    const summary = await readJobsHealthSummary(db, config());
    expect(summary.outbox.counts.FAILED).toEqual({ value: 3, capped: false });
    expect(summary.outbox.counts.PENDING).toEqual({ value: 1, capped: false });
    expect(summary.outbox.failedByType[0]).toEqual({ eventType: 'content.generation.requested', count: 2 });
    expect(summary.outbox.failedByClass).toContainEqual({ failureClass: 'SCHEMA_VALIDATION_FAILED', count: 2 });
    expect(summary.worker.verdict).toBe('STALLED');
    expect(summary.outbox.oldestDueWaitingMinutes).toBeGreaterThanOrEqual(45);
  });

  it('caps a count instead of scanning past the cap', async () => {
    await pool.query(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, delivery_state, published_at)
       SELECT gen_random_uuid(), 'test_aggregate', gen_random_uuid()::text, 'bulk.test', '{}'::jsonb, 'PUBLISHED', now()
       FROM generate_series(1, ${JOBS_COUNT_CAP + 5})`,
    );
    const summary = await readJobsHealthSummary(db, config());
    expect(summary.outbox.counts.PUBLISHED).toEqual({ value: JOBS_COUNT_CAP, capped: true });
    expect(summary.worker.lastDeliveredAt).not.toBeNull();
  });

  it('pages failed events by keyset without repeats, filters, and never returns payload or stored failure text', async () => {
    await failed(3, { eventType: 'content.generation.requested', payload: { email: 'student@example.test' } });
    await failed(2, { ageMinutes: 3 * 24 * 60 });
    const first = await listFailedJobs(db, { limit: 2 });
    const second = await listFailedJobs(db, { limit: 2, cursor: decode(first.nextCursor!) });
    const third = await listFailedJobs(db, { limit: 2, cursor: decode(second.nextCursor!) });
    const ids = [...first.events, ...second.events, ...third.events].map((event) => event.eventId);
    expect(new Set(ids).size).toBe(5);
    expect(third.nextCursor).toBeNull();
    const typed = await listFailedJobs(db, { limit: 50, eventType: 'content.generation.requested' });
    expect(typed.events).toHaveLength(3);
    const old = await listFailedJobs(db, { limit: 50, occurredTo: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
    expect(old.events).toHaveLength(2);
    const serialised = JSON.stringify([first, second, third]);
    expect(serialised).not.toMatch(/student@example\.test|secret-stack-trace|payload/);
    const detail = await getFailedJobDetail(db, ids[0]!);
    expect(detail).toMatchObject({ failureClass: 'TERMINAL_PUBLISH_FAILURE', replayable: true, receipts: [], automationCommand: null });
    expect(JSON.stringify(detail)).not.toMatch(/student@example\.test|secret-stack-trace/);
    expect(await getFailedJobDetail(db, await pending(1))).toBeNull();
  });
});

function decode(cursor: string): { occurredAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: string; i: string };
  return { occurredAt: parsed.o, id: parsed.i };
}
