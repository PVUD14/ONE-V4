/**
 * The System Health jobs console over HTTP (OPS-04).
 *
 * An operator can find, inspect and replay a failed event without the API or a database
 * client, and superseding the backlog still needs an approval. Every route needs
 * OPS_JOBS_REPLAY, validates its input, returns bounded, server-computed numbers, and never
 * returns an event payload or stored failure text.
 *
 * Real Postgres in a throwaway schema.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for jobs console tests');

const schemaName = 'ops_jobs_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let institutionId: string;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db,
      ids: { uuid: () => randomUUID() },
      verifier: {
        async verifyAccessToken(token: string) {
          if (!tokens.has(token)) throw new Error('Invalid local test identity');
          return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
        },
      },
      identityStore: {
        findByExternalSubject: (subject) => findIdentityByExternalSubject(db, subject),
        loadActiveMembershipsForUser: (id) => loadActiveMembershipsForUser(db, id),
      },
    })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Jobs college')", [institutionId]);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

interface Member { readonly userId: string; readonly membershipId: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function member(role: string, state = 'ACTIVE'): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : institutionId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId };
}

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-jobs-' + randomUUID() });

/** A FAILED event whose payload and stored failure text must never reach the browser. */
async function failedEvent(eventType: string, ageMinutes = 5): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at, delivery_state, attempts, last_failure_class, last_failure_message, correlation_id)
     VALUES ($1,'test_aggregate',$2,$3,$4::jsonb, now() - ($5 || ' minutes')::interval, 'FAILED', 5, 'TERMINAL_PUBLISH_FAILURE', 'smtp said: private-upstream-text', 'jobs-test-correlation')`,
    [id, randomUUID(), eventType, JSON.stringify({ email: 'learner-private@example.test' }), String(ageMinutes)],
  );
  return id;
}

async function pendingEvent(ageDays: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at, available_at, delivery_state)
     VALUES ($1,'test_aggregate',$2,'jobs.backlog.test','{}'::jsonb, now() - ($3 || ' days')::interval, now() + interval '1 hour', 'PENDING')`,
    [id, randomUUID(), String(ageDays)],
  );
  return id;
}

const routes = [
  { name: 'GET summary', call: (userId: string) => api().get('/api/v1/operations/jobs/summary').set(auth(userId)) },
  { name: 'GET failed list', call: (userId: string) => api().get('/api/v1/operations/jobs/failed').set(auth(userId)) },
  { name: 'GET failed detail', call: (userId: string) => api().get('/api/v1/operations/jobs/failed/' + randomUUID()).set(auth(userId)) },
  { name: 'GET backlog preview', call: (userId: string) => api().get('/api/v1/operations/jobs/backlog?olderThan=2000-01-01T00:00:00.000Z').set(auth(userId)) },
] as const;

describe('who may use the jobs console', () => {
  it.each(routes.map((route) => [route.name, route] as const))('%s: 401 without a token, 403 without OPS_JOBS_REPLAY, admitted for the three platform roles', async (_name, route) => {
    expect((await route.call(randomUUID())).status).toBe(401);
    const institutionAdmin = await member('INSTITUTION_ADMIN');
    const denied = await route.call(institutionAdmin.userId);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    const suspended = await member('OPERATIONS_ADMIN', 'SUSPENDED');
    expect([401, 403]).toContain((await route.call(suspended.userId)).status);
    for (const role of platformRoles) {
      const actor = await member(role);
      expect([401, 403], role).not.toContain((await route.call(actor.userId)).status);
    }
  });
});

describe('summary', () => {
  it('returns server-computed counts, NA-able nulls, alert settings and the reason codes the screen offers', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    await failedEvent('jobs.summary.test');
    const response = await api().get('/api/v1/operations/jobs/summary').set(auth(operator.userId)).expect(200);
    const summary = response.body.summary;
    expect(summary.outbox.counts.FAILED.value).toBeGreaterThanOrEqual(1);
    expect(summary.outbox.counts.FAILED.capped).toBe(false);
    expect(summary.worker.lastDeliveredAt).toBeNull();
    expect(summary.alerts.config).toMatchObject({ failedThreshold: 10, pendingStallMinutes: 30 });
    expect(summary.alerts.delivery).toEqual({ workflowEnabled: false, templateApproved: false });
    expect(summary.consumers.map((consumer: { label: string }) => consumer.label)).toContain('Student invitation delivery');
    expect(response.body.reasons.replay).toContain('TRANSIENT_FAILURE_RESOLVED');
    expect(response.body.reasons.supersede).toEqual(['PRE_DISPATCHER_BACKLOG', 'INCIDENT_CLEANUP']);
    expect(JSON.stringify(response.body)).not.toMatch(/learner-private|private-upstream-text/);
  });
});

describe('failed events', () => {
  it('pages by keyset within the bounds, filters by type and age, and returns no payload or failure text', async () => {
    const operator = await member('SECURITY_ADMIN');
    const eventType = 'jobs.page.' + randomUUID().slice(0, 8);
    const ids = [await failedEvent(eventType, 10), await failedEvent(eventType, 20), await failedEvent(eventType, 3 * 24 * 60)];
    const first = await api().get('/api/v1/operations/jobs/failed').query({ eventType, limit: 2 }).set(auth(operator.userId)).expect(200);
    expect(first.body.events).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api().get('/api/v1/operations/jobs/failed').query({ eventType, limit: 2, cursor: first.body.nextCursor }).set(auth(operator.userId)).expect(200);
    expect(second.body.nextCursor).toBeNull();
    expect([...first.body.events, ...second.body.events].map((event: { eventId: string }) => event.eventId)).toEqual(ids);
    const older = await api().get('/api/v1/operations/jobs/failed').query({ eventType, to: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() })
      .set(auth(operator.userId)).expect(200);
    expect(older.body.events.map((event: { eventId: string }) => event.eventId)).toEqual([ids[2]]);
    expect(Object.keys(first.body.events[0]).sort()).toEqual(
      ['aggregateType', 'attempts', 'eventId', 'eventType', 'eventVersion', 'expiresAt', 'failedAt', 'failureClass', 'occurredAt', 'replayable'],
    );
    expect(JSON.stringify([first.body, second.body])).not.toMatch(/learner-private|private-upstream-text/);
  });

  it.each([
    ['limit 0', { limit: 0 }, 'JOBS_LIMIT_INVALID'],
    ['limit 201', { limit: 201 }, 'JOBS_LIMIT_INVALID'],
    ['an unknown filter', { payload: 'x' }, 'JOBS_FILTER_UNKNOWN'],
    ['a malformed event type', { eventType: 'DROP TABLE' }, 'JOBS_EVENT_TYPE_INVALID'],
    ['a malformed date', { from: 'yesterday' }, 'JOBS_FROM_INVALID'],
    ['a forged cursor', { cursor: 'not-a-cursor' }, 'JOBS_CURSOR_INVALID'],
  ])('rejects %s with 400', async (_name, query, code) => {
    const operator = await member('OPERATIONS_ADMIN');
    const response = await api().get('/api/v1/operations/jobs/failed').query(query).set(auth(operator.userId));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code, correlationId: expect.any(String) });
  });

  it('shows one failed event with a plain explanation and its reference, and 404s anything that is not failed', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const eventId = await failedEvent('jobs.detail.test');
    const detail = await api().get('/api/v1/operations/jobs/failed/' + eventId).set(auth(operator.userId)).expect(200);
    expect(detail.body.event).toMatchObject({ eventId, failureClass: 'TERMINAL_PUBLISH_FAILURE', correlationId: 'jobs-test-correlation', replayable: true, receipts: [], automationCommand: null });
    expect(detail.body.event.explanation).toMatch(/Delivery failed/);
    expect(JSON.stringify(detail.body)).not.toMatch(/learner-private|private-upstream-text/);
    const missing = await api().get('/api/v1/operations/jobs/failed/' + (await pendingEvent(1))).set(auth(operator.userId));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('JOBS_EVENT_NOT_FOUND');
    expect((await api().get('/api/v1/operations/jobs/failed/not-a-uuid').set(auth(operator.userId))).status).toBe(400);
  });

  it('replays a failed event with a listed reason, audits it, and takes it off the failed list', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const eventType = 'jobs.replay.' + randomUUID().slice(0, 8);
    const eventId = await failedEvent(eventType);
    const unlisted = await api().post('/api/v1/operations/outbox/' + eventId + '/replay').set(auth(operator.userId)).send({ reasonCode: 'BECAUSE_I_SAID' });
    expect(unlisted.status).toBe(400);
    expect(unlisted.body.error.code).toBe('OUTBOX_REASON_INVALID');
    await api().post('/api/v1/operations/outbox/' + eventId + '/replay').set(auth(operator.userId)).send({ reasonCode: 'TRANSIENT_FAILURE_RESOLVED' }).expect(201);
    const state = await pool.query('SELECT delivery_state, attempts FROM outbox_events WHERE id=$1', [eventId]);
    expect(state.rows[0]).toMatchObject({ delivery_state: 'PENDING', attempts: 0 });
    const audit = await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='outbox.event.replayed' AND resource_id=$1", [eventId]);
    expect(audit.rows[0].actor_user_id).toBe(operator.userId);
    expect(audit.rows[0].context).toMatchObject({ reasonCode: 'TRANSIENT_FAILURE_RESOLVED', priorFailureClass: 'TERMINAL_PUBLISH_FAILURE' });
    const list = await api().get('/api/v1/operations/jobs/failed').query({ eventType }).set(auth(operator.userId)).expect(200);
    expect(list.body.events).toEqual([]);
  });
});

describe('backlog supersede', () => {
  it('previews what a cutoff would retire, and still refuses to supersede without an approval', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    await pendingEvent(400);
    await pendingEvent(400);
    const olderThan = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const preview = await api().get('/api/v1/operations/jobs/backlog').query({ olderThan }).set(auth(operator.userId)).expect(200);
    expect(preview.body.pending).toEqual({ value: 2, capped: false });
    expect((await api().get('/api/v1/operations/jobs/backlog').set(auth(operator.userId))).status).toBe(400);

    const refused = await api().post('/api/v1/operations/outbox/backlog/supersede').set(auth(operator.userId)).send({ olderThan, limit: 10_000, reasonCode: 'PRE_DISPATCHER_BACKLOG' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('APPROVAL_REQUIRED');

    const payload = { olderThan, limit: 10_000, reasonCode: 'PRE_DISPATCHER_BACKLOG' };
    const filed = await api().post('/api/v1/operations/approvals').set(auth(operator.userId)).send({ actionKey: 'OUTBOX_BACKLOG_SUPERSEDE', payload });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    await api().post('/api/v1/operations/approvals/' + filed.body.approval.id + '/decision').set(auth(approver.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' }).expect(201);
    const done = await api().post('/api/v1/operations/outbox/backlog/supersede').set(auth(operator.userId)).send({ ...payload, approvalId: filed.body.approval.id });
    expect(done.status).toBe(201);
    expect(done.body.superseded).toBe(2);
    const after = await api().get('/api/v1/operations/jobs/backlog').query({ olderThan }).set(auth(operator.userId)).expect(200);
    expect(after.body.pending.value).toBe(0);
    const superseded = await api().get('/api/v1/operations/jobs/failed').query({ eventType: 'jobs.backlog.test' }).set(auth(operator.userId)).expect(200);
    expect(superseded.body.events.every((event: { failureClass: string }) => event.failureClass === 'SUPERSEDED_BACKLOG')).toBe(true);
  });
});
