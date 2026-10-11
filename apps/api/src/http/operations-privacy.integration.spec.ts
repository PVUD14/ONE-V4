/**
 * The Security → Privacy and consent console over HTTP (OPS-06).
 *
 * Every privacy request is visible with its state and history, a read of one is audited,
 * the subject is masked and the reason a person typed never leaves the server; releasing
 * a legal hold needs an approval; consent coverage counts only live definitions, reports
 * unpublished engine purposes as not published, and suppresses any count under 5.
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
if (!connectionString) throw new Error('DATABASE_URL is required for privacy console tests');

const schemaName = 'ops_privacy_' + randomUUID().replaceAll('-', '');
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
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Privacy college')", [institutionId]);
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

/** A person with no membership: the subject of privacy requests and consents. */
async function person(): Promise<{ readonly userId: string; readonly email: string }> {
  const userId = randomUUID();
  const email = 'learner-' + userId.slice(0, 8) + '@college.example';
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  return { userId, email };
}

const typedReason = 'I no longer study there and my manager must not know';

async function deletionRequest(subjectUserId: string, requestedDaysAgo: number, state = 'RECEIVED'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, reason, requested_at, deletion_scheduled_for, started_at)
     VALUES ($1,$2,$2,'DELETION',$3,$4, now() - ($5 || ' days')::interval, now() - ($5 || ' days')::interval + interval '30 days',
             CASE WHEN $3 = 'IN_PROGRESS' THEN now() END)`,
    [id, subjectUserId, state, typedReason, String(requestedDaysAgo)],
  );
  await pool.query("INSERT INTO privacy_request_events (id, request_id, from_state, to_state, actor_user_id, actor_role, occurred_at) VALUES ($1,$2,NULL,'RECEIVED',$3,'SUBJECT', now() - ($4 || ' days')::interval)",
    [randomUUID(), id, subjectUserId, String(requestedDaysAgo)]);
  if (state === 'IN_PROGRESS') {
    await pool.query("INSERT INTO privacy_request_events (id, request_id, from_state, to_state, actor_role) VALUES ($1,$2,'RECEIVED','IN_PROGRESS','SYSTEM')", [randomUUID(), id]);
  }
  return id;
}

async function exportRequest(subjectUserId: string, requestedMinutesAgo: number, state = 'FAILED'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, requested_at, cancelled_at)
     VALUES ($1,$2,$2,'EXPORT',$3, now() - ($4 || ' minutes')::interval, CASE WHEN $3 = 'CANCELLED' THEN now() END)`,
    [id, subjectUserId, state, String(requestedMinutesAgo)],
  );
  return id;
}

async function hold(subjectUserId: string, placedBy: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO data_retention_holds (id,subject_user_id,reason_code,detail,placed_by_user_id) VALUES ($1,$2,'DISPUTE','Open dispute with the college',$3)", [id, subjectUserId, placedBy]);
  return id;
}

const api = () => request(app.getHttpServer());
const auth = (userId: string, correlationId = 'ops-privacy-' + randomUUID()) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': correlationId });

const routes = [
  { name: 'GET requests', call: (userId: string) => api().get('/api/v1/operations/privacy/requests').set(auth(userId)) },
  { name: 'GET request detail', call: (userId: string) => api().get('/api/v1/operations/privacy/requests/' + randomUUID()).set(auth(userId)) },
  { name: 'GET holds', call: (userId: string) => api().get('/api/v1/operations/privacy/holds').set(auth(userId)) },
  { name: 'GET consents', call: (userId: string) => api().get('/api/v1/operations/privacy/consents').set(auth(userId)) },
] as const;

describe('who may use the privacy console', () => {
  it.each(routes.map((route) => [route.name, route] as const))('%s: 401 without a token, 403 without PRIVACY_REQUESTS, admitted for the three platform roles', async (_name, route) => {
    expect((await route.call(randomUUID())).status).toBe(401);
    const institutionAdmin = await member('INSTITUTION_ADMIN');
    const denied = await route.call(institutionAdmin.userId);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    const suspended = await member('SECURITY_ADMIN', 'SUSPENDED');
    expect([401, 403]).toContain((await route.call(suspended.userId)).status);
    for (const role of platformRoles) {
      const actor = await member(role);
      expect([401, 403, 500], role).not.toContain((await route.call(actor.userId)).status);
    }
  });
});

describe('the request queue', () => {
  it('lists every request with its state, a masked subject and no typed reason', async () => {
    const operator = await member('SECURITY_ADMIN');
    const subject = await person();
    const deletionId = await deletionRequest(subject.userId, 2);
    const response = await api().get('/api/v1/operations/privacy/requests?view=ALL&limit=200').set(auth(operator.userId));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const row = response.body.requests.find((entry: { id: string }) => entry.id === deletionId);
    expect(row).toMatchObject({
      requestType: 'DELETION',
      state: 'RECEIVED',
      reference: expect.stringMatching(/^PR-[0-9A-F]{8}$/),
      subject: { userId: subject.userId, maskedEmail: 'l***@college.example', erased: false },
      deletionScheduledFor: expect.any(String),
      // No DPDP response period is defined in code, so there is no statutory date to compute.
      statutoryDueAt: null,
    });
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(subject.email);
    expect(body).not.toContain(typedReason);
    expect(response.body.policy).toEqual({ deletionGracePeriodDays: 30, statutoryResponsePeriodDays: { EXPORT: null, DELETION: null } });
  });

  it('counts the queue in SQL: open requests, deletions due soon or past schedule, failures and holds', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const before = (await api().get('/api/v1/operations/privacy/requests').set(auth(operator.userId))).body.summary;
    const dueSoon = await person();
    const past = await person();
    const failed = await person();
    await deletionRequest(dueSoon.userId, 26);
    await deletionRequest(past.userId, 31);
    await exportRequest(failed.userId, 5, 'FAILED');
    await hold(past.userId, operator.userId);
    const after = (await api().get('/api/v1/operations/privacy/requests').set(auth(operator.userId))).body.summary;
    expect(after.open.DELETION - before.open.DELETION).toBe(2);
    expect(after.deletionsDueWithinSevenDays - before.deletionsDueWithinSevenDays).toBe(1);
    expect(after.deletionsPastSchedule - before.deletionsPastSchedule).toBe(1);
    expect(after.failed - before.failed).toBe(1);
    expect(after.activeHolds - before.activeHolds).toBe(1);
  });

  it('filters by view and type', async () => {
    const operator = await member('SECURITY_ADMIN');
    const subject = await person();
    const failedId = await exportRequest(subject.userId, 1, 'FAILED');
    const open = await api().get('/api/v1/operations/privacy/requests?limit=200').set(auth(operator.userId));
    expect(open.body.requests.map((entry: { id: string }) => entry.id)).not.toContain(failedId);
    const failedView = await api().get('/api/v1/operations/privacy/requests?view=FAILED&type=EXPORT&limit=200').set(auth(operator.userId));
    expect(failedView.body.requests.map((entry: { id: string }) => entry.id)).toContain(failedId);
    for (const entry of failedView.body.requests) expect(entry).toMatchObject({ state: 'FAILED', requestType: 'EXPORT' });
  });

  it('pages newest first without repeating a request, default 50 and at most 200', async () => {
    const operator = await member('SECURITY_ADMIN');
    const made: string[] = [];
    for (let index = 0; index < 5; index += 1) made.push(await exportRequest((await person()).userId, 1000 + index, 'CANCELLED'));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = '/api/v1/operations/privacy/requests?view=CANCELLED&limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const page = await api().get(query).set(auth(operator.userId));
      expect(page.status).toBe(200);
      expect(page.body.requests.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.requests.map((entry: { id: string }) => entry.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of made) expect(seen).toContain(id);
    const times = seen.filter((id) => made.includes(id));
    expect(times).toEqual([...made]);
    const defaulted = await api().get('/api/v1/operations/privacy/requests?view=ALL').set(auth(operator.userId));
    expect(defaulted.body.requests.length).toBeLessThanOrEqual(50);
  });

  it.each([
    ['limit=0', 'PRIVACY_LIMIT_INVALID'],
    ['limit=201', 'PRIVACY_LIMIT_INVALID'],
    ['view=SOON', 'PRIVACY_VIEW_INVALID'],
    ['type=CORRECTION', 'PRIVACY_TYPE_INVALID'],
    ['cursor=not-a-cursor', 'PRIVACY_CURSOR_INVALID'],
    ['subject=someone', 'PRIVACY_FILTER_UNKNOWN'],
  ])('refuses %s', async (query, code) => {
    const operator = await member('SECURITY_ADMIN');
    const response = await api().get('/api/v1/operations/privacy/requests?' + query).set(auth(operator.userId));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(code);
  });
});

describe('one request', () => {
  it('shows its state history and holds, and audits the read', async () => {
    const operator = await member('SECURITY_ADMIN');
    const subject = await person();
    const requestId = await deletionRequest(subject.userId, 3, 'IN_PROGRESS');
    await hold(subject.userId, operator.userId);
    const correlationId = 'ops-privacy-view-' + randomUUID();
    const response = await api().get('/api/v1/operations/privacy/requests/' + requestId).set(auth(operator.userId, correlationId));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.request).toMatchObject({ id: requestId, state: 'IN_PROGRESS', activeHolds: 1, statutoryDueAt: null });
    expect(response.body.request.history.map((entry: { fromState: string | null; toState: string; actorRole: string }) => [entry.fromState, entry.toState, entry.actorRole]))
      .toEqual([[null, 'RECEIVED', 'SUBJECT'], ['RECEIVED', 'IN_PROGRESS', 'SYSTEM']]);
    expect(response.body.request.holds).toEqual([expect.objectContaining({ reasonCode: 'DISPUTE' })]);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(typedReason);
    expect(body).not.toContain(subject.email);
    const audit = await pool.query("SELECT actor_user_id, resource_type, outcome FROM audit_events WHERE action='operations.privacy_request.viewed' AND resource_id=$1 AND correlation_id=$2", [requestId, correlationId]);
    expect(audit.rows).toEqual([{ actor_user_id: operator.userId, resource_type: 'privacy_request', outcome: 'SUCCESS' }]);
  });

  it('shows what a completed deletion did per category', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const subject = await person();
    const requestId = await exportRequest(subject.userId, 10, 'CANCELLED');
    // A deletion record belongs to a deletion request; a cancelled export has none.
    const empty = await api().get('/api/v1/operations/privacy/requests/' + requestId).set(auth(operator.userId));
    expect(empty.body.request.deletionOutcome).toEqual([]);
    const deletionId = await deletionRequest((await person()).userId, 40, 'IN_PROGRESS');
    await pool.query("INSERT INTO privacy_deletion_records (id, request_id, category, disposition, basis, record_count) VALUES ($1,$2,'AUDIT','RETAINED','Kept under the retention schedule',4)", [randomUUID(), deletionId]);
    const detail = await api().get('/api/v1/operations/privacy/requests/' + deletionId).set(auth(operator.userId));
    expect(detail.body.request.deletionOutcome).toEqual([expect.objectContaining({ category: 'AUDIT', disposition: 'RETAINED', recordCount: 4 })]);
  });

  it('answers 400 for a malformed id and 404 for an unknown one, without auditing a read', async () => {
    const operator = await member('SECURITY_ADMIN');
    expect((await api().get('/api/v1/operations/privacy/requests/not-a-uuid').set(auth(operator.userId))).body.error.code).toBe('PRIVACY_REQUEST_INVALID');
    const unknown = randomUUID();
    const missing = await api().get('/api/v1/operations/privacy/requests/' + unknown).set(auth(operator.userId));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PRIVACY_REQUEST_NOT_FOUND');
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='operations.privacy_request.viewed' AND resource_id=$1", [unknown])).rowCount).toBe(0);
  });
});

describe('legal holds', () => {
  it('lists active holds with a masked subject, the deletion they block, and the reason lists', async () => {
    const operator = await member('SECURITY_ADMIN');
    const subject = await person();
    const deletionId = await deletionRequest(subject.userId, 5);
    const holdId = await hold(subject.userId, operator.userId);
    const response = await api().get('/api/v1/operations/privacy/holds').set(auth(operator.userId));
    expect(response.status).toBe(200);
    const row = response.body.holds.find((entry: { id: string }) => entry.id === holdId);
    expect(row).toMatchObject({
      reasonCode: 'DISPUTE',
      subject: { userId: subject.userId, maskedEmail: 'l***@college.example', erased: false },
      placedBy: { email: operator.userId + '@example.test' },
      openDeletion: { requestId: deletionId, reference: expect.stringMatching(/^PR-/) },
      releaseRequest: null,
    });
    expect(JSON.stringify(response.body)).not.toContain(subject.email);
    expect(response.body.reasons).toEqual({
      place: ['LEGAL_OBLIGATION', 'SAFETY_INVESTIGATION', 'EMPLOYER_ACCOUNTABILITY_CASE', 'DISPUTE', 'REGULATORY_REQUEST'],
      release: ['OBLIGATION_ENDED', 'CASE_CLOSED', 'ENTERED_IN_ERROR'],
    });
  });

  it('places a hold with a listed reason, audited with that reason', async () => {
    const operator = await member('SECURITY_ADMIN');
    const subject = await person();
    const correlationId = 'ops-privacy-place-' + randomUUID();
    const placed = await api().post('/api/v1/operations/privacy/holds').set(auth(operator.userId, correlationId))
      .send({ subjectUserId: subject.userId, reasonCode: 'REGULATORY_REQUEST', detail: 'Board inquiry reference on file' });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='privacy.retention_hold.placed' AND resource_id=$1 AND correlation_id=$2", [placed.body.id, correlationId]);
    expect(audit.rows[0].context).toEqual({ reasonCode: 'REGULATORY_REQUEST' });
  });

  it.each([
    [{ reasonCode: 'DISPUTE' }, 400, 'PRIVACY_SUBJECT_INVALID'],
    [{ reasonCode: 'BECAUSE', subject: true }, 400, 'PRIVACY_HOLD_REASON_INVALID'],
    [{ reasonCode: 'DISPUTE', subject: true, detail: 'x'.repeat(2001) }, 400, 'PRIVACY_HOLD_DETAIL_TOO_LONG'],
    [{ reasonCode: 'DISPUTE', subject: true, detail: 42 }, 400, 'PRIVACY_HOLD_DETAIL_INVALID'],
    [{ reasonCode: 'DISPUTE', subject: true, approvalId: randomUUID() }, 400, 'PRIVACY_FIELD_UNKNOWN'],
    [{ reasonCode: 'DISPUTE', subjectUserId: randomUUID() }, 404, 'PRIVACY_SUBJECT_NOT_FOUND'],
  ])('refuses %j', async (input, status, code) => {
    const operator = await member('SECURITY_ADMIN');
    const { subject, ...body } = input as Record<string, unknown>;
    const payload = subject ? { ...body, subjectUserId: (await person()).userId } : body;
    const response = await api().post('/api/v1/operations/privacy/holds').set(auth(operator.userId)).send(payload);
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });

  it('refuses a hold on a person already erased', async () => {
    const operator = await member('SECURITY_ADMIN');
    const subject = await person();
    await pool.query('UPDATE users SET anonymised_at = now() WHERE id = $1', [subject.userId]);
    const response = await api().post('/api/v1/operations/privacy/holds').set(auth(operator.userId)).send({ subjectUserId: subject.userId, reasonCode: 'DISPUTE' });
    expect(response.body.error.code).toBe('PRIVACY_SUBJECT_ERASED');
  });

  it('releases a hold only through an approval, and shows the release request while it is in flight', async () => {
    const requester = await member('SECURITY_ADMIN');
    const approver = await member('PLATFORM_SUPER_ADMIN');
    await member('PLATFORM_SUPER_ADMIN');
    const subject = await person();
    const holdId = await hold(subject.userId, requester.userId);

    const direct = await api().post('/api/v1/operations/privacy/holds/' + holdId + '/release').set(auth(requester.userId)).send({ reasonCode: 'CASE_CLOSED' });
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe('APPROVAL_REQUIRED');

    const filed = await api().post('/api/v1/operations/approvals').set(auth(requester.userId)).send({ actionKey: 'PRIVACY_HOLD_RELEASE', payload: { holdId, reasonCode: 'CASE_CLOSED' } });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const pending = await api().get('/api/v1/operations/privacy/holds').set(auth(requester.userId));
    expect(pending.body.holds.find((entry: { id: string }) => entry.id === holdId).releaseRequest)
      .toMatchObject({ state: 'PENDING', requestedBy: { email: requester.userId + '@example.test' } });

    const selfDecided = await api().post('/api/v1/operations/approvals/' + filed.body.approval.id + '/decision').set(auth(requester.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
    expect(selfDecided.status).toBe(403);
    await api().post('/api/v1/operations/approvals/' + filed.body.approval.id + '/decision').set(auth(approver.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' }).expect(201);
    const released = await api().post('/api/v1/operations/privacy/holds/' + holdId + '/release').set(auth(requester.userId))
      .send({ reasonCode: 'CASE_CLOSED', approvalId: filed.body.approval.id });
    expect(released.status, JSON.stringify(released.body)).toBe(201);
    const after = await api().get('/api/v1/operations/privacy/holds').set(auth(requester.userId));
    expect(after.body.holds.map((entry: { id: string }) => entry.id)).not.toContain(holdId);
  });
});

describe('consent coverage', () => {
  async function define(key: string, version: string, options: { retired?: boolean; future?: boolean } = {}): Promise<void> {
    await pool.query(
      `INSERT INTO consent_definitions (consent_key, version, title, enforcement, effective_from, retired_at)
       VALUES ($1,$2,$3,'OPTIONAL', CASE WHEN $4 THEN now() + interval '10 days' ELSE now() - interval '30 days' END,
               CASE WHEN $5 THEN now() - interval '1 day' END)`,
      [key, version, 'Consent ' + key + ' ' + version, options.future === true, options.retired === true],
    );
  }
  async function record(userId: string, key: string, version: string, action: 'GRANTED' | 'WITHDRAWN', minutesAgo: number): Promise<void> {
    await pool.query("INSERT INTO user_consents (id,user_id,consent_key,version,action,recorded_at) VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' minutes')::interval)",
      [randomUUID(), userId, key, version, action, String(minutesAgo)]);
  }

  it('reports the engine purposes as not published, never as zero coverage', async () => {
    const operator = await member('SECURITY_ADMIN');
    const response = await api().get('/api/v1/operations/privacy/consents').set(auth(operator.userId));
    expect(response.status).toBe(200);
    expect(response.body.suppressionThreshold).toBe(5);
    for (const key of ['adaptive-learning', 'ai-tutoring', 'model-improvement']) {
      expect(response.body.keys.find((entry: { consentKey: string }) => entry.consentKey === key)).toEqual({
        consentKey: key, status: 'NOT_PUBLISHED', liveVersion: null, title: null, enforcement: null, counts: null,
      });
    }
  });

  it('counts people against the live version, suppressing any count under 5', async () => {
    const operator = await member('SECURITY_ADMIN');
    const key = 'coverage-' + randomUUID().slice(0, 8);
    await define(key, 'v1', { retired: true });
    await define(key, 'v2');
    // 6 consented to v2, 3 withdrew, 2 are still on v1, and one erased person is left out.
    for (let index = 0; index < 6; index += 1) await record((await person()).userId, key, 'v2', 'GRANTED', 10);
    for (let index = 0; index < 3; index += 1) {
      const userId = (await person()).userId;
      await record(userId, key, 'v2', 'GRANTED', 20);
      await record(userId, key, 'v2', 'WITHDRAWN', 5);
    }
    for (let index = 0; index < 2; index += 1) await record((await person()).userId, key, 'v1', 'GRANTED', 60);
    const erased = await person();
    await record(erased.userId, key, 'v2', 'GRANTED', 10);
    await pool.query('UPDATE users SET anonymised_at = now() WHERE id = $1', [erased.userId]);

    const response = await api().get('/api/v1/operations/privacy/consents').set(auth(operator.userId));
    const coverage = response.body.keys.find((entry: { consentKey: string }) => entry.consentKey === key);
    expect(coverage).toEqual({
      consentKey: key, status: 'LIVE', liveVersion: 'v2', title: 'Consent ' + key + ' v2', enforcement: 'OPTIONAL',
      counts: {
        consentedToLiveVersion: { suppressed: false, value: 6 },
        withdrawn: { suppressed: true, value: null },
        onOlderVersion: { suppressed: true, value: null },
      },
    });
    const versions = response.body.definitions.filter((definition: { consentKey: string }) => definition.consentKey === key);
    expect(versions.map((definition: { version: string; status: string }) => [definition.version, definition.status])).toEqual([['v2', 'LIVE'], ['v1', 'RETIRED']]);
    // The suppressed cells carry no value, so the raw counts are nowhere in the answer.
    expect(JSON.stringify(coverage)).not.toMatch(/"value":[1-4]\b/);
  });

  it('gives no counts for a key whose only versions are retired or not yet effective', async () => {
    const operator = await member('SECURITY_ADMIN');
    const retired = 'retired-' + randomUUID().slice(0, 8);
    const scheduled = 'scheduled-' + randomUUID().slice(0, 8);
    await define(retired, 'v1', { retired: true });
    await define(scheduled, 'v1', { future: true });
    for (let index = 0; index < 7; index += 1) await record((await person()).userId, retired, 'v1', 'GRANTED', 10);
    const response = await api().get('/api/v1/operations/privacy/consents').set(auth(operator.userId));
    for (const key of [retired, scheduled]) {
      expect(response.body.keys.find((entry: { consentKey: string }) => entry.consentKey === key)).toMatchObject({ status: 'NO_LIVE_VERSION', liveVersion: null, counts: null });
    }
    expect(response.body.definitions.find((definition: { consentKey: string }) => definition.consentKey === scheduled).status).toBe('SCHEDULED');
  });
});
