/**
 * The incident register, breach clocks and status notices over HTTP (OPS-16).
 *
 * A breach shows its 72-hour deadline (labelled as the plan's period, pending legal confirmation)
 * and who recorded notifying the Board and the affected users, and when; a breach cannot close
 * until both are recorded. A status notice cannot be drafted from an unapproved template version —
 * refused by the API, and by the 0081 trigger for any other writer. Template publication goes
 * through OPS-02 dual control; a notice is a draft until a person approves it, is rate-limited,
 * and is sent by the outbox worker to the administrators of the affected organisations only, with
 * email NOT_CONFIGURED when no mail sink exists. Every write is audited with its reason code.
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
import { createLocalIntegrationEventPublisher, publishOutboxOnce } from '@planthepath/persistence/src/automation-workers.js';
import type { InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';

type IntegrationEventEnvelope = Parameters<ReturnType<typeof createLocalIntegrationEventPublisher>['publisher']['publish']>[0];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for incident register tests');

const schemaName = 'ops_incidents_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let platformId: string;
let collegeId: string;
let otherCollegeId: string;
let security: Member;
let operations: Member;
let secondOperations: Member;
let superAdmin: Member;
let collegeAdmin: Member;
let otherCollegeAdmin: Member;
let collegeStudent: { readonly userId: string };

const delivered: { toEmail: string; subject: string; textBody: string }[] = [];
const captureSink: InvitationMailSink = {
  async send(input) {
    delivered.push({ toEmail: input.toEmail, subject: input.subject, textBody: input.textBody });
    return { providerReference: 'capture:' + delivered.length };
  },
};

interface Member { readonly userId: string; readonly membershipId: string; readonly email: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

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
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  collegeId = randomUUID();
  otherCollegeId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Incident test college')", [collegeId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Unaffected test college')", [otherCollegeId]);
  security = await member('SECURITY_ADMIN');
  operations = await member('OPERATIONS_ADMIN');
  secondOperations = await member('OPERATIONS_ADMIN');
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  collegeAdmin = await member('INSTITUTION_ADMIN', 'ACTIVE', collegeId);
  otherCollegeAdmin = await member('INSTITUTION_ADMIN', 'ACTIVE', otherCollegeId);
  collegeStudent = await student(collegeId);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

async function member(role: string, state = 'ACTIVE', organizationId?: string): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  const email = 'staff-' + userId.slice(0, 8) + '@example.test';
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : organizationId ?? collegeId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId, email };
}

async function student(institutionId: string): Promise<{ readonly userId: string }> {
  const userId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, 'learner-' + userId.slice(0, 8) + '@college.example.test']);
  await pool.query(
    "INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE',now() - interval '30 days')",
    [randomUUID(), institutionId, userId],
  );
  return { userId };
}

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-incident-' + randomUUID() });
const base = '/api/v1/operations/incidents';
const comms = '/api/v1/operations/communications';
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const breach = (over: Record<string, unknown> = {}) => ({
  title: 'Backup credential exposed in a build log', summary: 'A storage credential appeared in a public CI log for about two hours.',
  category: 'PERSONAL_DATA_BREACH', severity: 'HIGH', detectedAt: hoursAgo(2), reasonCode: 'INTERNAL_DISCOVERY', ...over,
});
const declare = (actor: Member, body: Record<string, unknown> = breach()) => api().post(base).set(auth(actor.userId)).send(body);

async function declared(body: Record<string, unknown> = breach()): Promise<string> {
  const response = await declare(security, body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.incident.id as string;
}
async function auditRows(action: string, resourceId: string): Promise<{ context: Record<string, unknown>; actor_user_id: string }[]> {
  return (await pool.query('SELECT context, actor_user_id FROM audit_events WHERE action=$1 AND resource_id=$2', [action, resourceId])).rows;
}
async function publishedTemplate(key: string): Promise<string> {
  const drafted = await api().post(comms + '/templates').set(auth(operations.userId))
    .send({ templateKey: key, subject: 'Service notice: storage credential rotated', body: 'We rotated a storage credential after it appeared in a build log. No action is needed from your college.', reasonCode: 'NEW_TEMPLATE' });
  expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
  const templateId = drafted.body.template.id as string;
  const requested = await api().post('/api/v1/operations/approvals').set(auth(operations.userId))
    .send({ actionKey: 'COMMS_TEMPLATE_PUBLISH', payload: { templateId, reasonCode: 'INCIDENT_COMMUNICATION' } });
  expect(requested.status, JSON.stringify(requested.body)).toBe(201);
  const approvalId = requested.body.approval.id as string;
  const decided = await api().post(`/api/v1/operations/approvals/${approvalId}/decision`).set(auth(superAdmin.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
  expect(decided.status, JSON.stringify(decided.body)).toBe(201);
  const published = await api().post(`${comms}/templates/${templateId}/publish`).set(auth(operations.userId)).send({ reasonCode: 'INCIDENT_COMMUNICATION', approvalId });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  return templateId;
}
async function addCollege(incidentId: string, organizationId = collegeId): Promise<void> {
  const response = await api().post(`${base}/${incidentId}/organizations`).set(auth(security.userId)).send({ organizationId, reasonCode: 'SCOPE_ASSESSED' });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}
/** Run the deployed worker mode (ADR-028 local dispatcher) until the outbox is drained. */
async function drain(sink: InvitationMailSink | null = null): Promise<IntegrationEventEnvelope[]> {
  const local = createLocalIntegrationEventPublisher({ pool, db, ...(sink ? { invitationMailSink: sink } : {}) });
  const published: IntegrationEventEnvelope[] = [];
  const publisher = { async publish(event: IntegrationEventEnvelope) { published.push(event); await local.publisher.publish(event); } };
  for (let round = 0; round < 20; round += 1) {
    const result = await publishOutboxOnce({ db, publisher, leaseOwner: 'incident-test', now: new Date(Date.now() + 5_000) });
    if (result.claimed === 0) break;
  }
  return published;
}

describe('authorisation', () => {
  it('returns 401 without a token', async () => {
    await api().get(base).expect(401);
    await api().post(base).send(breach()).expect(401);
    await api().get(comms + '/templates').expect(401);
    await api().post(comms + '/notices').send({}).expect(401);
  });

  it('returns 403 to an ACTIVE institution admin for every route', async () => {
    const id = randomUUID();
    const calls = [
      api().get(base + '/policy').set(auth(collegeAdmin.userId)),
      api().get(base).set(auth(collegeAdmin.userId)),
      api().post(base).set(auth(collegeAdmin.userId)).send(breach()),
      api().get(`${base}/${id}`).set(auth(collegeAdmin.userId)),
      api().post(`${base}/${id}/transition`).set(auth(collegeAdmin.userId)).send({ toState: 'CONTAINED', reasonCode: 'ACCESS_PATH_CLOSED' }),
      api().post(`${base}/${id}/board-notification`).set(auth(collegeAdmin.userId)).send({ notifiedAt: hoursAgo(1), reasonCode: 'BOARD_REPORT_FILED' }),
      api().get(comms + '/policy').set(auth(collegeAdmin.userId)),
      api().get(comms + '/templates').set(auth(collegeAdmin.userId)),
      api().post(comms + '/notices').set(auth(collegeAdmin.userId)).send({ incidentId: id, templateId: id, reasonCode: 'INITIAL_NOTICE' }),
      api().post(`${comms}/notices/${id}/approve`).set(auth(collegeAdmin.userId)).send({ reasonCode: 'APPROVED_FOR_SEND' }),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({ code: 'FORBIDDEN', correlationId: expect.any(String) });
    }
  });

  it('keeps the register to INCIDENT_MANAGE and notices to COMMS_TEMPLATES', async () => {
    expect((await api().get(base).set(auth(operations.userId))).status).toBe(403);
    expect((await api().get(comms + '/templates').set(auth(security.userId))).status).toBe(403);
    expect((await api().get(base).set(auth(security.userId))).status).toBe(200);
    expect((await api().get(base).set(auth(superAdmin.userId))).status).toBe(200);
    expect((await api().get(comms + '/templates').set(auth(operations.userId))).status).toBe(200);
  });

  it('denies a suspended platform membership', async () => {
    const suspended = await member('SECURITY_ADMIN', 'SUSPENDED');
    expect((await api().get(base).set(auth(suspended.userId))).status).toBe(403);
  });

  it('admits a granted capability outside the baseline', async () => {
    const granted = await member('OPERATIONS_ADMIN');
    await pool.query(
      `INSERT INTO membership_capabilities (id, membership_id, capability, granted_by_user_id, reason_code)
       VALUES ($1, $2, 'INCIDENT_MANAGE', $3, 'NEW_RESPONSIBILITY')`,
      [randomUUID(), granted.membershipId, superAdmin.userId],
    );
    expect((await api().get(base).set(auth(granted.userId))).status).toBe(200);
  });
});

describe('declaring an incident', () => {
  it('shows a breach with its 72-hour deadline from detected_at, labelled pending legal confirmation', async () => {
    const detectedAt = hoursAgo(2);
    const response = await declare(security, breach({ detectedAt }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const incident = response.body.incident;
    expect(incident).toMatchObject({ state: 'OPEN', category: 'PERSONAL_DATA_BREACH', reference: expect.stringMatching(/^INC-[0-9A-F]{8}$/) });
    expect(incident.breachClock).toMatchObject({ hours: 72, basis: 'PLAN_PENDING_LEGAL_CONFIRMATION', status: 'RUNNING', boardNotifiedAt: null, usersNotifiedAt: null });
    expect(Date.parse(incident.breachClock.deadlineAt) - Date.parse(detectedAt)).toBe(72 * 3_600_000);
    expect(incident.breachClock.remainingSeconds).toBeGreaterThan(69 * 3600);
    expect(incident.breachClock.remainingSeconds).toBeLessThanOrEqual(70 * 3600 + 60);
    const policy = await api().get(base + '/policy').set(auth(security.userId)).expect(200);
    expect(policy.body.breachClock).toMatchObject({ hours: 72, basis: 'PLAN_PENDING_LEGAL_CONFIRMATION', basisText: expect.stringContaining('pending legal confirmation') });
  });

  it('has no clock for an incident that is not a breach', async () => {
    const response = await declare(security, breach({ category: 'SERVICE_OUTAGE', title: 'API unavailable', summary: 'The API returned errors for twelve minutes.' }));
    expect(response.status).toBe(201);
    expect(response.body.incident.breachClock).toBeNull();
  });

  it('shows OVERDUE once 72 hours have passed without a Board report', async () => {
    const id = await declared(breach({ detectedAt: hoursAgo(80) }));
    const detail = await api().get(`${base}/${id}`).set(auth(security.userId)).expect(200);
    expect(detail.body.incident.breachClock).toMatchObject({ status: 'OVERDUE', remainingSeconds: 0 });
    const list = await api().get(base).set(auth(security.userId)).expect(200);
    expect(list.body.summary.breachClocksOverdue).toBeGreaterThanOrEqual(1);
  });

  it('refuses invalid input with 400', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [breach({ detectedAt: new Date(Date.now() + 3_600_000).toISOString() }), 'INCIDENT_DETECTED_AT_INVALID'],
      [breach({ detectedAt: 'yesterday' }), 'INCIDENT_DETECTED_AT_INVALID'],
      [breach({ title: 'Reported by asha@college.example.test' }), 'INCIDENT_TEXT_PERSONAL_DATA'],
      [breach({ summary: 'Caller on 98765 43210 said the export leaked' }), 'INCIDENT_TEXT_PERSONAL_DATA'],
      [breach({ category: 'ALIENS' }), 'INCIDENT_CATEGORY_INVALID'],
      [breach({ severity: 'SEV1' }), 'INCIDENT_SEVERITY_INVALID'],
      [breach({ reasonCode: 'FREE TEXT' }), 'REASON_CODE_INVALID'],
      [breach({ title: 'x' }), 'INCIDENT_TITLE_INVALID'],
      [breach({ extra: true }), 'INVALID_REQUEST'],
    ];
    for (const [body, code] of cases) {
      const response = await declare(security, body);
      expect(response.status, code).toBe(400);
      expect(response.body.error.code).toBe(code);
    }
    expect((await api().get(`${base}/not-a-uuid`).set(auth(security.userId))).status).toBe(400);
    expect((await api().get(`${base}/${randomUUID()}`).set(auth(security.userId))).status).toBe(404);
  });

  it('audits the declaration with its reason code, writes the outbox event and the timeline', async () => {
    const id = await declared();
    const [audit] = await auditRows('operations.incident.declared', id);
    expect(audit).toMatchObject({ actor_user_id: security.userId, context: { reasonCode: 'INTERNAL_DISCOVERY', category: 'PERSONAL_DATA_BREACH', severity: 'HIGH' } });
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='incident.declared' AND aggregate_id=$1", [id]);
    expect(outbox.rows[0].payload).toEqual({ incidentId: id, category: 'PERSONAL_DATA_BREACH', severity: 'HIGH' });
    const detail = await api().get(`${base}/${id}`).set(auth(security.userId)).expect(200);
    expect(detail.body.timeline[0]).toMatchObject({ kind: 'DECLARED', toValue: 'OPEN', reasonCode: 'INTERNAL_DISCOVERY', actor: security.email });
    expect(await auditRows('operations.incident.viewed', id)).toHaveLength(1);
  });

  it('pages the register with keyset bounds', async () => {
    await declared(); await declared();
    expect((await api().get(base + '?limit=201').set(auth(security.userId))).status).toBe(400);
    expect((await api().get(base + '?limit=0').set(auth(security.userId))).status).toBe(400);
    expect((await api().get(base + '?cursor=bad').set(auth(security.userId))).status).toBe(400);
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const response = await api().get(base + '?view=ALL&limit=1' + (cursor ? '&cursor=' + cursor : '')).set(auth(security.userId)).expect(200);
      for (const incident of response.body.incidents) { expect(seen.has(incident.id)).toBe(false); seen.add(incident.id); }
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }
    const total = (await pool.query('SELECT count(*)::int AS n FROM incidents')).rows[0].n;
    expect(seen.size).toBe(total);
  });
});

describe('breach notification records and the lifecycle', () => {
  it('shows who recorded notifying the Board and the affected users, and when', async () => {
    const id = await declared(breach({ detectedAt: hoursAgo(10) }));
    const boardAt = hoursAgo(4);
    const board = await api().post(`${base}/${id}/board-notification`).set(auth(security.userId))
      .send({ notifiedAt: boardAt, reasonCode: 'BOARD_REPORT_FILED', reference: 'DPB/ACK-2026-001' });
    expect(board.status, JSON.stringify(board.body)).toBe(201);
    expect(board.body.incident.breachClock).toMatchObject({ status: 'MET', remainingSeconds: null, boardNotifiedBy: security.email, boardReference: 'DPB/ACK-2026-001' });
    expect(Date.parse(board.body.incident.breachClock.boardNotifiedAt)).toBe(Date.parse(boardAt));
    const users = await api().post(`${base}/${id}/users-notification`).set(auth(superAdmin.userId)).send({ notifiedAt: hoursAgo(3), reasonCode: 'USERS_NOTIFIED_BY_EMAIL' });
    expect(users.status).toBe(201);
    expect(users.body.incident.breachClock).toMatchObject({ usersNotifiedBy: superAdmin.email });
    expect(users.body.timeline.map((entry: { kind: string }) => entry.kind)).toEqual(['DECLARED', 'BOARD_NOTIFIED', 'USERS_NOTIFIED']);
    expect((await auditRows('operations.incident.board_notified_recorded', id))[0]?.context).toEqual({ reasonCode: 'BOARD_REPORT_FILED', hasReference: true });
    // Set once.
    const again = await api().post(`${base}/${id}/board-notification`).set(auth(security.userId)).send({ notifiedAt: hoursAgo(1), reasonCode: 'BOARD_REPORT_FILED' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INCIDENT_BOARD_ALREADY_NOTIFIED');
  });

  it('marks a Board report after the deadline as met late', async () => {
    const id = await declared(breach({ detectedAt: hoursAgo(100) }));
    const board = await api().post(`${base}/${id}/board-notification`).set(auth(security.userId)).send({ notifiedAt: hoursAgo(1), reasonCode: 'BOARD_REPORT_FILED' });
    expect(board.body.incident.breachClock.status).toBe('MET_LATE');
  });

  it('refuses a notified time before detection or in the future, and on an incident that is not a breach', async () => {
    const id = await declared(breach({ detectedAt: hoursAgo(5) }));
    const early = await api().post(`${base}/${id}/board-notification`).set(auth(security.userId)).send({ notifiedAt: hoursAgo(6), reasonCode: 'BOARD_REPORT_FILED' });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe('INCIDENT_NOTIFIED_AT_INVALID');
    const future = await api().post(`${base}/${id}/users-notification`).set(auth(security.userId)).send({ notifiedAt: new Date(Date.now() + 3_600_000).toISOString(), reasonCode: 'USERS_NOTIFIED_BY_EMAIL' });
    expect(future.body.error.code).toBe('INCIDENT_NOTIFIED_AT_INVALID');
    const outage = await declared(breach({ category: 'SERVICE_OUTAGE' }));
    const notBreach = await api().post(`${base}/${outage}/board-notification`).set(auth(security.userId)).send({ notifiedAt: hoursAgo(1), reasonCode: 'BOARD_REPORT_FILED' });
    expect(notBreach.body.error.code).toBe('INCIDENT_NOT_A_BREACH');
  });

  it('keeps a breach open until the Board and the users are recorded as notified', async () => {
    const id = await declared(breach({ detectedAt: hoursAgo(10) }));
    const contained = await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'CONTAINED', reasonCode: 'CREDENTIAL_ROTATED' });
    expect(contained.status).toBe(201);
    expect(contained.body.incident.containedAt).not.toBeNull();
    await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'RESOLVED', reasonCode: 'ROOT_CAUSE_FIXED' }).expect(201);
    const early = await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'CLOSED', reasonCode: 'POST_INCIDENT_REVIEW_DONE' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INCIDENT_BREACH_NOTIFICATIONS_OUTSTANDING');
    await api().post(`${base}/${id}/board-notification`).set(auth(security.userId)).send({ notifiedAt: hoursAgo(2), reasonCode: 'BOARD_REPORT_FILED' }).expect(201);
    await api().post(`${base}/${id}/users-notification`).set(auth(security.userId)).send({ notifiedAt: hoursAgo(1), reasonCode: 'USERS_NOTIFIED_BY_COLLEGE' }).expect(201);
    const closed = await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'CLOSED', reasonCode: 'POST_INCIDENT_REVIEW_DONE' });
    expect(closed.status).toBe(201);
    expect(closed.body.incident).toMatchObject({ state: 'CLOSED', closedAt: expect.any(String) });
    // Closed is final.
    const note = await api().post(`${base}/${id}/notes`).set(auth(security.userId)).send({ note: 'Late finding', reasonCode: 'TIMELINE_UPDATE' });
    expect(note.status).toBe(409);
    expect((await auditRows('operations.incident.transitioned', id)).map((row) => row.context.reasonCode)).toEqual(expect.arrayContaining(['CREDENTIAL_ROTATED', 'ROOT_CAUSE_FIXED', 'POST_INCIDENT_REVIEW_DONE']));
  });

  it('follows the state machine and its reason codes', async () => {
    const id = await declared(breach({ category: 'SECURITY' }));
    const bad = await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'CLOSED', reasonCode: 'POST_INCIDENT_REVIEW_DONE' });
    expect(bad.body.error.code).toBe('REASON_CODE_INVALID');
    const wrongReason = await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'CONTAINED', reasonCode: 'ROOT_CAUSE_FIXED' });
    expect(wrongReason.body.error.code).toBe('REASON_CODE_INVALID');
    await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'CONTAINED', reasonCode: 'SERVICE_ISOLATED' }).expect(201);
    const skip = await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'CLOSED', reasonCode: 'DUPLICATE' });
    expect(skip.body.error.code).toBe('INCIDENT_TRANSITION_NOT_ALLOWED');
    const reopened = await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'OPEN', reasonCode: 'CONTAINMENT_FAILED', note: 'Access recurred from a second key' });
    expect(reopened.status).toBe(201);
    expect(reopened.body.timeline.at(-1)).toMatchObject({ kind: 'STATE_CHANGED', fromValue: 'CONTAINED', toValue: 'OPEN', note: 'Access recurred from a second key' });
    await api().post(`${base}/${id}/transition`).set(auth(security.userId)).send({ toState: 'CLOSED', reasonCode: 'FALSE_ALARM' }).expect(201);
  });

  it('reclassifies, stamping or removing the clock, but never a breach someone was told about', async () => {
    const id = await declared(breach({ category: 'SECURITY', detectedAt: hoursAgo(3) }));
    const toBreach = await api().post(`${base}/${id}/category`).set(auth(security.userId)).send({ category: 'PERSONAL_DATA_BREACH', reasonCode: 'CONFIRMED_PERSONAL_DATA' });
    expect(toBreach.status).toBe(201);
    expect(toBreach.body.incident.breachClock).toMatchObject({ hours: 72, status: 'RUNNING' });
    await api().post(`${base}/${id}/board-notification`).set(auth(security.userId)).send({ notifiedAt: hoursAgo(1), reasonCode: 'BOARD_REPORT_FILED' }).expect(201);
    const away = await api().post(`${base}/${id}/category`).set(auth(security.userId)).send({ category: 'SECURITY', reasonCode: 'NO_PERSONAL_DATA_INVOLVED' });
    expect(away.status).toBe(409);
    expect(away.body.error.code).toBe('INCIDENT_BREACH_ALREADY_NOTIFIED');
    const severity = await api().post(`${base}/${id}/severity`).set(auth(security.userId)).send({ severity: 'CRITICAL', reasonCode: 'SCOPE_GREW' });
    expect(severity.body.incident.severity).toBe('CRITICAL');
    expect((await auditRows('operations.incident.severity_changed', id))[0]?.context).toEqual({ reasonCode: 'SCOPE_GREW', fromSeverity: 'HIGH', toSeverity: 'CRITICAL' });
  });

  it('names affected colleges, never a platform organisation, and counts them', async () => {
    const id = await declared();
    const options = await api().get(`${base}/organization-options?q=test college`).set(auth(security.userId)).expect(200);
    expect(options.body.organizations.map((org: { name: string }) => org.name)).toEqual(expect.arrayContaining(['Incident test college']));
    expect(options.body.organizations.some((org: { kind: string }) => org.kind === 'PLATFORM')).toBe(false);
    expect((await api().get(`${base}/organization-options?q=x`).set(auth(security.userId))).status).toBe(400);
    await addCollege(id);
    const duplicate = await api().post(`${base}/${id}/organizations`).set(auth(security.userId)).send({ organizationId: collegeId, reasonCode: 'SCOPE_ASSESSED' });
    expect(duplicate.status).toBe(409);
    const platform = await api().post(`${base}/${id}/organizations`).set(auth(security.userId)).send({ organizationId: platformId, reasonCode: 'SCOPE_ASSESSED' });
    expect(platform.status).toBe(404);
    const detail = await api().get(`${base}/${id}`).set(auth(security.userId)).expect(200);
    expect(detail.body.incident.affectedOrganizationsCount).toBe(1);
    expect(detail.body.organizations[0]).toMatchObject({ name: 'Incident test college', kind: 'INSTITUTION', removedAt: null });
    const removed = await api().post(`${base}/${id}/organizations/${collegeId}/remove`).set(auth(security.userId)).send({ reasonCode: 'ENTERED_IN_ERROR' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(201);
    expect(removed.body.incident.affectedOrganizationsCount).toBe(0);
  });
});

describe('the 0081 triggers refuse a second writer', () => {
  it('keeps the timeline append-only and incidents undeletable', async () => {
    const id = await declared();
    await expect(pool.query("UPDATE incident_events SET reason_code='TAMPERED' WHERE incident_id=$1", [id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM incident_events WHERE incident_id=$1', [id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM incidents WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
    await expect(pool.query("UPDATE incidents SET detected_at = detected_at - interval '1 day' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE incidents SET board_clock_hours = 96 WHERE id=$1', [id])).rejects.toThrow(/stamped/);
    await expect(pool.query("UPDATE incidents SET state='CLOSED' WHERE id=$1", [id])).rejects.toThrow(/Board and affected users/);
  });

  it('refuses a notice on a template version nobody approved', async () => {
    const id = await declared();
    const unapproved = randomUUID();
    await pool.query(
      `INSERT INTO notification_templates (id, stable_key, version, locale, subject_template, body_template, approved_by_user_id, published_at)
       VALUES ($1, 'status-notice.rogue', 1, 'en-IN', 'Rogue', 'Never approved through dual control', $2, now())`,
      [unapproved, operations.userId],
    );
    await expect(pool.query(
      "INSERT INTO incident_status_notices (id, incident_id, template_id, drafted_by_user_id, draft_reason_code) VALUES ($1,$2,$3,$4,'INITIAL_NOTICE')",
      [randomUUID(), id, unapproved, operations.userId],
    )).rejects.toThrow(/approved status notice template/);
  });
});

describe('communication templates', () => {
  it('drafts a version and refuses to publish it without a second person', async () => {
    const drafted = await api().post(comms + '/templates').set(auth(operations.userId))
      .send({ templateKey: 'planned-downtime', subject: 'Planned maintenance tonight', body: 'ONE will be unavailable for thirty minutes from 23:00 IST.', reasonCode: 'NEW_TEMPLATE' });
    expect(drafted.status).toBe(201);
    expect(drafted.body.template).toMatchObject({ state: 'DRAFT', version: 1, canRequestApproval: true, canPublish: false });
    const templateId = drafted.body.template.id as string;
    const bare = await api().post(`${comms}/templates/${templateId}/publish`).set(auth(operations.userId)).send({ reasonCode: 'PLANNED_COMMUNICATION' });
    expect(bare.status).toBe(403);
    expect(bare.body.error.code).toBe('APPROVAL_REQUIRED');
    // Only the author asks for approval, so the approver can never be the author.
    const other = await api().post('/api/v1/operations/approvals').set(auth(secondOperations.userId))
      .send({ actionKey: 'COMMS_TEMPLATE_PUBLISH', payload: { templateId, reasonCode: 'PLANNED_COMMUNICATION' } });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('COMMS_TEMPLATE_NOT_AUTHOR');
    const second = await api().post(comms + '/templates').set(auth(operations.userId))
      .send({ templateKey: 'planned-downtime', subject: 'Planned maintenance tonight (revised)', body: 'ONE will be unavailable for forty minutes from 23:00 IST.', reasonCode: 'WORDING_UPDATE' });
    expect(second.body.template.version).toBe(2);
    expect((await auditRows('operations.comms_template.drafted', templateId))[0]?.context).toEqual({ reasonCode: 'NEW_TEMPLATE', templateKey: 'planned-downtime', version: 1 });
  });

  it('publishes with an executed approval, carrying the approver into notification_templates', async () => {
    const templateId = await publishedTemplate('credential-rotated');
    const row = (await pool.query(
      `SELECT nt.stable_key, nt.version, nt.approved_by_user_id FROM status_notice_templates s JOIN notification_templates nt ON nt.id = s.published_template_id WHERE s.id=$1`, [templateId],
    )).rows[0];
    expect(row).toEqual({ stable_key: 'status-notice.credential-rotated', version: 1, approved_by_user_id: superAdmin.userId });
    const list = await api().get(comms + '/templates?state=PUBLISHED').set(auth(operations.userId)).expect(200);
    expect(list.body.templates.find((t: { id: string }) => t.id === templateId)).toMatchObject({ state: 'PUBLISHED', approvedBy: superAdmin.email, publishMode: 'DUAL' });
    const [audit] = await auditRows('operations.comms_template.published', templateId);
    expect(audit?.context).toMatchObject({ reasonCode: 'INCIDENT_COMMUNICATION', approvedByUserId: superAdmin.userId, mode: 'DUAL' });
    const edit = pool.query("UPDATE status_notice_templates SET body='Changed after approval' WHERE id=$1", [templateId]);
    await expect(edit).rejects.toThrow(/immutable/);
  });
});

describe('status notices', () => {
  it('cannot be drafted from an unapproved template version, or with free text', async () => {
    const incidentId = await declared();
    const drafted = await api().post(comms + '/templates').set(auth(operations.userId))
      .send({ templateKey: 'unapproved-wording', subject: 'Not yet approved', body: 'This wording has not been approved by a second person.', reasonCode: 'NEW_TEMPLATE' });
    const response = await api().post(comms + '/notices').set(auth(operations.userId)).send({ incidentId, templateId: drafted.body.template.id, reasonCode: 'INITIAL_NOTICE' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('STATUS_NOTICE_TEMPLATE_NOT_APPROVED');
    const freeText = await api().post(comms + '/notices').set(auth(operations.userId))
      .send({ incidentId, templateId: drafted.body.template.id, reasonCode: 'INITIAL_NOTICE', body: 'Anything I like' });
    expect(freeText.status).toBe(400);
    expect(freeText.body.error.code).toBe('INVALID_REQUEST');
  });

  it('is a draft until a person approves it, then reaches the affected college admins only, rate-limited', async () => {
    const templateId = await publishedTemplate('breach-first-notice');
    const incidentId = await declared();
    const draft = await api().post(comms + '/notices').set(auth(operations.userId)).send({ incidentId, templateId, reasonCode: 'INITIAL_NOTICE' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.notice).toMatchObject({ state: 'DRAFT', sentAt: null, recipientCount: null });
    const noticeId = draft.body.notice.id as string;
    // No affected organisation yet: nothing to send to.
    const noAudience = await api().post(`${comms}/notices/${noticeId}/approve`).set(auth(operations.userId)).send({ reasonCode: 'APPROVED_FOR_SEND' });
    expect(noAudience.status).toBe(409);
    expect(noAudience.body.error.code).toBe('STATUS_NOTICE_NO_AUDIENCE');
    await addCollege(incidentId);
    const approved = await api().post(`${comms}/notices/${noticeId}/approve`).set(auth(operations.userId)).send({ reasonCode: 'APPROVED_FOR_SEND' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.notice).toMatchObject({ state: 'QUEUED', approvedBy: operations.email, sentAt: null });
    // Nothing is sent inside the request.
    expect((await pool.query("SELECT count(*)::int AS n FROM user_notifications WHERE kind='STATUS_NOTICE' AND user_id=$1", [collegeAdmin.userId])).rows[0].n).toBe(0);

    const events = await drain();
    expect(events.some((event) => event.eventType === 'incident.status_notice.dispatch.requested')).toBe(true);
    const sent = (await api().get(`${comms}/notices?incidentId=${incidentId}`).set(auth(operations.userId)).expect(200)).body.notices[0];
    expect(sent).toMatchObject({ state: 'SENT', recipientCount: 1, organizationCount: 1, email: { notConfigured: 1, sent: 0, pending: 0 } });
    expect(sent.sentAt).toEqual(expect.any(String));

    const feed = await api().get('/api/v1/me/notifications').set(auth(collegeAdmin.userId)).expect(200);
    const notices = feed.body.notifications.filter((note: { kind: string }) => note.kind === 'STATUS_NOTICE');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: 'Service notice: storage credential rotated', data: { from: 'AI8HT ONE', organizationName: 'Incident test college' } });
    for (const outsider of [otherCollegeAdmin.userId, collegeStudent.userId]) {
      const other = await api().get('/api/v1/me/notifications').set(auth(outsider)).expect(200);
      expect(other.body.notifications.filter((note: { kind: string }) => note.kind === 'STATUS_NOTICE')).toHaveLength(0);
    }

    // The incident shows who was notified when.
    const detail = await api().get(`${base}/${incidentId}`).set(auth(security.userId)).expect(200);
    expect(detail.body.notices[0]).toMatchObject({ state: 'SENT', approvedBy: operations.email, recipientCount: 1, organizationCount: 1 });
    expect(detail.body.timeline.map((entry: { kind: string }) => entry.kind)).toEqual(expect.arrayContaining(['NOTICE_DRAFTED', 'NOTICE_QUEUED', 'NOTICE_SENT']));
    expect((await auditRows('operations.status_notice.sent', noticeId))[0]).toMatchObject({ actor_user_id: operations.userId, context: { recipientCount: 1, organizationCount: 1, emailConfigured: false } });

    // A second notice within 15 minutes is refused.
    const next = await api().post(comms + '/notices').set(auth(operations.userId)).send({ incidentId, templateId, reasonCode: 'INCIDENT_UPDATE' });
    const limited = await api().post(`${comms}/notices/${next.body.notice.id}/approve`).set(auth(operations.userId)).send({ reasonCode: 'APPROVED_FOR_SEND' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('STATUS_NOTICE_RATE_LIMITED');
    // A replayed dispatch sends nothing twice.
    const dispatch = events.find((event) => event.eventType === 'incident.status_notice.dispatch.requested' && event.aggregateId === noticeId)!;
    await createLocalIntegrationEventPublisher({ pool, db }).publisher.publish(dispatch);
    expect((await pool.query("SELECT count(*)::int AS n FROM user_notifications WHERE kind='STATUS_NOTICE' AND user_id=$1", [collegeAdmin.userId])).rows[0].n).toBe(1);
  });

  it('emails each administrator once through a configured sink, from the approved wording', async () => {
    const templateId = await publishedTemplate('breach-emailed-notice');
    const incidentId = await declared();
    await addCollege(incidentId, otherCollegeId);
    const draft = await api().post(comms + '/notices').set(auth(operations.userId)).send({ incidentId, templateId, reasonCode: 'INITIAL_NOTICE' });
    await api().post(`${comms}/notices/${draft.body.notice.id}/approve`).set(auth(operations.userId)).send({ reasonCode: 'APPROVED_FOR_SEND' }).expect(201);
    delivered.length = 0;
    await drain(captureSink);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ toEmail: otherCollegeAdmin.email, subject: 'Service notice: storage credential rotated' });
    expect(delivered[0]!.textBody).toContain('We rotated a storage credential');
    const sent = (await api().get(`${comms}/notices?incidentId=${incidentId}`).set(auth(operations.userId)).expect(200)).body.notices[0];
    expect(sent.email).toMatchObject({ sent: 1, notConfigured: 0 });
  });

  it('withdraws a draft with a reason and refuses to approve it afterwards', async () => {
    const templateId = await publishedTemplate('withdrawn-notice');
    const incidentId = await declared();
    const draft = await api().post(comms + '/notices').set(auth(operations.userId)).send({ incidentId, templateId, reasonCode: 'INITIAL_NOTICE' });
    const withdrawn = await api().post(`${comms}/notices/${draft.body.notice.id}/withdraw`).set(auth(operations.userId)).send({ reasonCode: 'WRONG_TEMPLATE' });
    expect(withdrawn.body.notice.state).toBe('WITHDRAWN');
    await addCollege(incidentId);
    const approve = await api().post(`${comms}/notices/${draft.body.notice.id}/approve`).set(auth(operations.userId)).send({ reasonCode: 'APPROVED_FOR_SEND' });
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('STATUS_NOTICE_NOT_DRAFT');
    expect((await api().post(`${comms}/notices/${draft.body.notice.id}/approve`).set(auth(operations.userId)).send({ reasonCode: 'SEND_IT' })).status).toBe(400);
  });

  it('bounds notice and template paging', async () => {
    expect((await api().get(comms + '/notices?limit=201').set(auth(operations.userId))).status).toBe(400);
    expect((await api().get(comms + '/templates?limit=0').set(auth(operations.userId))).status).toBe(400);
    expect((await api().get(comms + '/templates?state=LIVE').set(auth(operations.userId))).status).toBe(400);
    const policy = await api().get(comms + '/policy').set(auth(operations.userId)).expect(200);
    expect(policy.body.rateLimit).toEqual({ minimumSpacingMinutes: 15, dailyLimit: 6 });
    expect(policy.body.incidents.length).toBeGreaterThan(0);
    expect(Object.keys(policy.body.incidents[0]).sort()).toEqual(['affectedOrganizationsCount', 'category', 'id', 'reference', 'state', 'title']);
  });
});
