/**
 * The support desk and account lookup over HTTP (OPS-05).
 *
 * A case logged from a phone call in one request; transitions that follow the state
 * machine and 400 otherwise; notes, assignment and keyset paging; the account view with
 * masked contacts, its audited reveal and its audited reads; and a privacy deletion that
 * leaves the case with no link to the person. The 0043 triggers are exercised directly
 * as well, because a second writer must not be able to skip the rules.
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
import { executeDueDeletions } from './privacy-deletion.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for support desk tests');

const schemaName = 'ops_support_' + randomUUID().replaceAll('-', '');
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
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Support test college')", [institutionId]);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

interface Member { readonly userId: string; readonly membershipId: string; readonly email: string }
const platformRoles = ['PLATFORM_SUPER_ADMIN', 'OPERATIONS_ADMIN', 'SECURITY_ADMIN'];

async function member(role: string, state = 'ACTIVE'): Promise<Member> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  const email = 'staff-' + userId.slice(0, 8) + '@example.test';
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  const isPlatform = platformRoles.includes(role);
  const org = isPlatform ? platformId : institutionId;
  await pool.query(
    `INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
     VALUES ($1,$2,$3,$4,$5,$2,$6)`,
    [membershipId, org, userId, role, state, isPlatform ? null : org],
  );
  return { userId, membershipId, email };
}

/** A student account the way the roster creates one: an address, no staff role. */
async function student(): Promise<{ readonly userId: string; readonly email: string }> {
  const userId = randomUUID();
  const email = 'asha.' + userId.slice(0, 8) + '@college.example.test';
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  await pool.query(
    "INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE',now() - interval '30 days')",
    [randomUUID(), institutionId, userId],
  );
  return { userId, email };
}

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'ops-support-' + randomUUID() });
const phoneCall = (over: Record<string, unknown> = {}) => ({
  channel: 'PHONE', category: 'ACCOUNT_ACCESS', severity: 'MEDIUM', summary: 'Cannot sign in after invitation', reasonCode: 'CUSTOMER_CONTACT', ...over,
});
const openCase = (actor: Member, body: Record<string, unknown> = phoneCall()) => api().post('/api/v1/operations/support/cases').set(auth(actor.userId)).send(body);
const transition = (actor: Member, caseId: string, toState: string, reasonCode: string) =>
  api().post('/api/v1/operations/support/cases/' + caseId + '/transition').set(auth(actor.userId)).send({ toState, reasonCode });

describe('authorisation', () => {
  it('returns 401 without a token', async () => {
    await api().get('/api/v1/operations/support/cases').expect(401);
    await api().get('/api/v1/operations/support/accounts/' + randomUUID()).expect(401);
    await api().post('/api/v1/operations/support/cases').send(phoneCall()).expect(401);
  });

  it('returns 403 to an ACTIVE institution admin for every route', async () => {
    const admin = await member('INSTITUTION_ADMIN');
    const calls = [
      api().get('/api/v1/operations/support/policy').set(auth(admin.userId)),
      api().get('/api/v1/operations/support/cases').set(auth(admin.userId)),
      api().post('/api/v1/operations/support/cases').set(auth(admin.userId)).send(phoneCall()),
      api().get('/api/v1/operations/support/accounts?q=college').set(auth(admin.userId)),
      api().get('/api/v1/operations/support/accounts/' + admin.userId).set(auth(admin.userId)),
      api().post('/api/v1/operations/support/accounts/' + admin.userId + '/contact-reveal').set(auth(admin.userId)).send({ reasonCode: 'ACCOUNT_RECOVERY' }),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({ code: 'FORBIDDEN', correlationId: expect.any(String) });
    }
  });

  it('keeps the case desk to SUPPORT_CASES and the lookup to SUPPORT_ACCOUNT_LOOKUP', async () => {
    const security = await member('SECURITY_ADMIN');
    const operations = await member('OPERATIONS_ADMIN');
    const person = await student();
    // Security holds account lookup by baseline, but not the case desk.
    expect((await api().get('/api/v1/operations/support/cases').set(auth(security.userId))).status).toBe(403);
    expect((await openCase(security)).status).toBe(403);
    await api().get('/api/v1/operations/support/accounts/' + person.userId).set(auth(security.userId)).expect(200);
    await api().get('/api/v1/operations/support/cases').set(auth(operations.userId)).expect(200);
    await api().get('/api/v1/operations/support/accounts/' + person.userId).set(auth(operations.userId)).expect(200);
  });

  it('honours a SUPPORT_CASES grant and ignores an inactive membership', async () => {
    const granted = await member('SECURITY_ADMIN');
    const admin = await member('PLATFORM_SUPER_ADMIN');
    await pool.query(
      `INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,'SUPPORT_CASES',$3,'NEW_RESPONSIBILITY')`,
      [randomUUID(), granted.membershipId, admin.userId],
    );
    await api().get('/api/v1/operations/support/cases').set(auth(granted.userId)).expect(200);
    const suspended = await member('OPERATIONS_ADMIN', 'SUSPENDED');
    expect((await api().get('/api/v1/operations/support/cases').set(auth(suspended.userId))).status).toBe(403);
  });
});

describe('logging a case', () => {
  it('logs a phone call in one request, with SLA, history, audit and outbox', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const person = await student();
    const response = await openCase(operator, phoneCall({ subjectUserId: person.userId, organizationId: institutionId, assignToMe: true }));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = response.body.case;
    expect(created).toMatchObject({ state: 'OPEN', channel: 'PHONE', category: 'ACCOUNT_ACCESS', severity: 'MEDIUM', summary: 'Cannot sign in after invitation' });
    expect(created.reference).toMatch(/^SC-[0-9A-F]{8}$/);
    expect(created.assignee).toMatchObject({ isSelf: true });
    expect(created.subject.maskedEmail).toMatch(/^a\*\*\*@college\.example\.test$/);
    expect(JSON.stringify(response.body)).not.toContain(person.email);
    expect(created.events.map((event: { kind: string }) => event.kind)).toEqual(['OPENED', 'ASSIGNED']);

    const row = (await pool.query('SELECT extract(epoch FROM sla_due_at - opened_at)::int AS seconds FROM support_cases WHERE id=$1', [created.id])).rows[0];
    expect(row.seconds).toBe(72 * 3600);
    const audit = await pool.query("SELECT actor_user_id, context, correlation_id FROM audit_events WHERE action='operations.support_case.opened' AND resource_id=$1", [created.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_user_id).toBe(operator.userId);
    expect(audit.rows[0].context.reasonCode).toBe('CUSTOMER_CONTACT');
    expect(audit.rows[0].context).not.toHaveProperty('summary');
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='support_case.opened' AND aggregate_id=$1", [created.id]);
    expect(outbox.rows).toHaveLength(1);
    expect(Object.keys(outbox.rows[0].payload).sort()).toEqual(['caseId', 'category', 'channel', 'severity']);
  });

  it('stamps SLA targets by severity from the database clock', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const urgent = await openCase(operator, phoneCall({ severity: 'URGENT' }));
    const low = await openCase(operator, phoneCall({ severity: 'LOW' }));
    const windows = await pool.query(
      "SELECT id, extract(epoch FROM sla_due_at - opened_at)::int AS seconds FROM support_cases WHERE id IN ($1,$2)",
      [urgent.body.case.id, low.body.case.id],
    );
    const byId = Object.fromEntries(windows.rows.map((row) => [row.id, row.seconds]));
    expect(byId[urgent.body.case.id]).toBe(4 * 3600);
    expect(byId[low.body.case.id]).toBe(120 * 3600);
  });

  it('rejects invalid input with 400 and a code', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const cases: [Record<string, unknown>, string][] = [
      [phoneCall({ summary: 'x' }), 'SUPPORT_SUMMARY_INVALID'],
      [phoneCall({ summary: 'y'.repeat(501) }), 'SUPPORT_SUMMARY_INVALID'],
      [phoneCall({ channel: 'FAX' }), 'SUPPORT_CHANNEL_INVALID'],
      [phoneCall({ category: 'BILLING' }), 'SUPPORT_CATEGORY_INVALID'],
      [phoneCall({ severity: 'CRITICAL' }), 'SUPPORT_SEVERITY_INVALID'],
      [phoneCall({ reasonCode: 'BECAUSE' }), 'REASON_CODE_INVALID'],
      [phoneCall({ subjectUserId: 'not-a-uuid' }), 'INVALID_REQUEST'],
      [phoneCall({ contactPhone: '9876543210' }), 'INVALID_REQUEST'],
    ];
    for (const [body, code] of cases) {
      const response = await openCase(operator, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe(code);
    }
    const missingSubject = await openCase(operator, phoneCall({ subjectUserId: randomUUID() }));
    expect(missingSubject.status).toBe(404);
    expect(missingSubject.body.error.code).toBe('SUPPORT_SUBJECT_NOT_FOUND');
  });
});

describe('the state machine', () => {
  it('follows the documented transitions and stamps resolution times', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const id = (await openCase(operator)).body.case.id as string;
    await transition(operator, id, 'IN_PROGRESS', 'WORK_STARTED').expect(201);
    const resolved = await transition(operator, id, 'RESOLVED', 'FIXED');
    expect(resolved.status).toBe(201);
    expect(resolved.body.case.resolvedAt).not.toBeNull();
    const reopened = await transition(operator, id, 'IN_PROGRESS', 'REOPENED_NOT_FIXED');
    expect(reopened.body.case.resolvedAt).toBeNull();
    await transition(operator, id, 'RESOLVED', 'ANSWERED').expect(201);
    const closed = await transition(operator, id, 'CLOSED', 'CONFIRMED_WITH_CUSTOMER');
    expect(closed.body.case).toMatchObject({ state: 'CLOSED', allowedTransitions: [] });
    expect(closed.body.case.closedAt).not.toBeNull();
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='operations.support_case.transitioned' AND resource_id=$1", [id]);
    expect(audit.rows).toHaveLength(5);
    expect(audit.rows.every((row) => typeof row.context.reasonCode === 'string')).toBe(true);
    expect((await pool.query("SELECT 1 FROM outbox_events WHERE event_type='support_case.state_changed' AND aggregate_id=$1", [id])).rowCount).toBe(5);
  });

  it('returns 400 for a transition the machine does not have, and for a mismatched reason', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const id = (await openCase(operator)).body.case.id as string;
    await transition(operator, id, 'IN_PROGRESS', 'WORK_STARTED').expect(201);
    const skip = await transition(operator, id, 'CLOSED', 'DUPLICATE');
    expect(skip.status).toBe(400);
    expect(skip.body.error.code).toBe('SUPPORT_CASE_TRANSITION_NOT_ALLOWED');
    const back = await transition(operator, id, 'OPEN', 'WORK_STARTED');
    expect(back.status).toBe(400);
    const reason = await transition(operator, id, 'RESOLVED', 'DUPLICATE');
    expect(reason.status).toBe(400);
    expect(reason.body.error.code).toBe('REASON_CODE_INVALID');
    const state = await transition(operator, id, 'ARCHIVED', 'FIXED');
    expect(state.body.error.code).toBe('SUPPORT_STATE_INVALID');
    expect((await pool.query('SELECT state FROM support_cases WHERE id=$1', [id])).rows[0].state).toBe('IN_PROGRESS');
  });

  it('is enforced by the database for any other writer', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const id = (await openCase(operator)).body.case.id as string;
    await expect(pool.query("UPDATE support_cases SET state='CLOSED' WHERE id=$1", [id])).resolves.toBeDefined();
    await expect(pool.query("UPDATE support_cases SET state='OPEN' WHERE id=$1", [id])).rejects.toThrow(/cannot move from CLOSED to OPEN/);
    await expect(pool.query('DELETE FROM support_cases WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
    await expect(pool.query("UPDATE support_cases SET severity='URGENT' WHERE id=$1", [id])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE support_cases SET summary='rewritten' WHERE id=$1", [id])).rejects.toThrow(/privacy deletion/);
    await expect(pool.query('DELETE FROM support_case_events WHERE case_id=$1', [id])).rejects.toThrow(/never deleted/);
    await expect(pool.query("UPDATE support_case_events SET reason_code='CORRECTION' WHERE case_id=$1", [id])).rejects.toThrow(/append-only/);
  });
});

describe('notes and assignment', () => {
  it('adds a note linked to a reference, audited without its text, and refuses notes on a closed case', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const id = (await openCase(operator)).body.case.id as string;
    const noted = await api().post('/api/v1/operations/support/cases/' + id + '/notes').set(auth(operator.userId))
      .send({ note: 'Invitation expired; resent from the Students screen.', reasonCode: 'CASE_UPDATE', linkedCorrelationId: 'web-9f1c2d3e4b5a' });
    expect(noted.status, JSON.stringify(noted.body)).toBe(201);
    const noteEvent = noted.body.case.events.find((event: { kind: string }) => event.kind === 'NOTE');
    expect(noteEvent).toMatchObject({ note: 'Invitation expired; resent from the Students screen.', linkedCorrelationId: 'web-9f1c2d3e4b5a', reasonCode: 'CASE_UPDATE' });
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='operations.support_case.note_added' AND resource_id=$1", [id]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0].context)).not.toContain('Invitation expired');
    const badReference = await api().post('/api/v1/operations/support/cases/' + id + '/notes').set(auth(operator.userId)).send({ note: 'x', reasonCode: 'CASE_UPDATE', linkedCorrelationId: 'no spaces allowed' });
    expect(badReference.body.error.code).toBe('SUPPORT_REFERENCE_INVALID');
    await transition(operator, id, 'CLOSED', 'DUPLICATE').expect(201);
    const late = await api().post('/api/v1/operations/support/cases/' + id + '/notes').set(auth(operator.userId)).send({ note: 'After closing', reasonCode: 'CASE_UPDATE' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('SUPPORT_CASE_CLOSED');
  });

  it('assigns only to staff who hold SUPPORT_CASES', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const colleague = await member('OPERATIONS_ADMIN');
    const security = await member('SECURITY_ADMIN');
    const id = (await openCase(operator)).body.case.id as string;
    const assigned = await api().post('/api/v1/operations/support/cases/' + id + '/assign').set(auth(operator.userId)).send({ assigneeUserId: colleague.userId, reasonCode: 'REBALANCE' });
    expect(assigned.status).toBe(201);
    expect(assigned.body.case.assignee).toMatchObject({ email: colleague.email, isSelf: false });
    const refused = await api().post('/api/v1/operations/support/cases/' + id + '/assign').set(auth(operator.userId)).send({ assigneeUserId: security.userId, reasonCode: 'REBALANCE' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('SUPPORT_ASSIGNEE_NOT_ELIGIBLE');
    const unassigned = await api().post('/api/v1/operations/support/cases/' + id + '/assign').set(auth(operator.userId)).send({ assigneeUserId: null, reasonCode: 'CORRECTION' });
    expect(unassigned.body.case.assignee).toBeNull();
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='operations.support_case.assigned' AND resource_id=$1", [id])).rowCount).toBe(2);
  });
});

describe('the queue', () => {
  it('pages with a keyset cursor inside the bounds and counts in SQL', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const subject = await student();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push((await openCase(operator, phoneCall({ subjectUserId: subject.userId }))).body.case.id);
    const first = await api().get('/api/v1/operations/support/cases?limit=2&subjectUserId=' + subject.userId).set(auth(operator.userId));
    expect(first.status).toBe(200);
    expect(first.body.cases).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const seen = new Set<string>(first.body.cases.map((item: { id: string }) => item.id));
    let cursor = first.body.nextCursor as string | null;
    while (cursor) {
      const page = await api().get('/api/v1/operations/support/cases?limit=2&subjectUserId=' + subject.userId + '&cursor=' + cursor).set(auth(operator.userId));
      for (const item of page.body.cases) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.body.nextCursor;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(first.body.summary.open).toBeGreaterThanOrEqual(5);

    for (const limit of ['0', '201', 'abc']) {
      const response = await api().get('/api/v1/operations/support/cases?limit=' + limit).set(auth(operator.userId));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SUPPORT_LIMIT_INVALID');
    }
    await api().get('/api/v1/operations/support/cases?limit=200').set(auth(operator.userId)).expect(200);
    expect((await api().get('/api/v1/operations/support/cases?cursor=garbage').set(auth(operator.userId))).body.error.code).toBe('SUPPORT_CURSOR_INVALID');
    expect((await api().get('/api/v1/operations/support/cases?view=OLD').set(auth(operator.userId))).body.error.code).toBe('SUPPORT_VIEW_INVALID');
    expect((await api().get('/api/v1/operations/support/cases?sort=desc').set(auth(operator.userId))).status).toBe(400);
  });

  it('audits reading a case', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const id = (await openCase(operator)).body.case.id as string;
    const detail = await api().get('/api/v1/operations/support/cases/' + id).set(auth(operator.userId));
    expect(detail.status).toBe(200);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='operations.support_case.viewed' AND resource_id=$1 AND actor_user_id=$2", [id, operator.userId])).rowCount).toBe(1);
    expect((await api().get('/api/v1/operations/support/cases/' + randomUUID()).set(auth(operator.userId))).status).toBe(404);
  });
});

describe('account lookup', () => {
  it('shows the account with masked contacts, memberships, cases and a timeline, and audits the read', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const person = await student();
    await pool.query(
      "INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,outcome,correlation_id,context) VALUES ($1,$2::uuid,'student.profile.updated','student_profile',$2::text,'SUCCESS','corr-student-1','{\"secret\":\"do not show\"}'::jsonb)",
      [randomUUID(), person.userId],
    );
    await openCase(operator, phoneCall({ subjectUserId: person.userId }));
    const response = await api().get('/api/v1/operations/support/accounts/' + person.userId).set(auth(operator.userId));
    expect(response.status).toBe(200);
    const body = response.body;
    expect(body.account).toMatchObject({ maskedEmail: 'a***@college.example.test', maskedPhone: null, state: 'ACTIVE', identityLinked: true, deleted: false });
    expect(body.studentRelationships).toEqual([expect.objectContaining({ institutionName: 'Support test college', state: 'ACTIVE' })]);
    expect(body.cases).toHaveLength(1);
    expect(body.timeline.map((event: { action: string }) => event.action)).toContain('student.profile.updated');
    expect(body.canOpenCase).toBe(true);
    // Minimised: the full address and audit context never leave the server here.
    const text = JSON.stringify(body);
    expect(text).not.toContain(person.email);
    expect(text).not.toContain('do not show');
    expect(Object.keys(body.timeline[0]).sort()).toEqual(['action', 'byThisUser', 'correlationId', 'occurredAt', 'outcome', 'resourceType']);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='operations.support_account.viewed' AND resource_id=$1", [person.userId])).rowCount).toBe(1);
    // Looking at an account does not fill its own timeline.
    const again = await api().get('/api/v1/operations/support/accounts/' + person.userId).set(auth(operator.userId));
    expect(again.body.timeline.some((event: { resourceType: string }) => event.resourceType === 'support_account')).toBe(false);
    expect((await api().get('/api/v1/operations/support/accounts/' + randomUUID()).set(auth(operator.userId))).status).toBe(404);
  });

  it('searches by address with masked results and never copies the search into audit', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const person = await student();
    const exact = await api().get('/api/v1/operations/support/accounts?q=' + encodeURIComponent(person.email.toUpperCase())).set(auth(operator.userId));
    expect(exact.status).toBe(200);
    expect(exact.body.accounts).toEqual([expect.objectContaining({ userId: person.userId, maskedEmail: 'a***@college.example.test' })]);
    expect(JSON.stringify(exact.body)).not.toContain(person.email);
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='operations.support_account.searched' AND actor_user_id=$1", [operator.userId]);
    expect(audit.rows[0].context).toEqual({ queryKind: 'EMAIL', resultCount: 1 });
    for (const q of ['', 'ab']) {
      const short = await api().get('/api/v1/operations/support/accounts?q=' + q).set(auth(operator.userId));
      expect(short.status).toBe(400);
      expect(short.body.error.code).toBe('SUPPORT_SEARCH_TOO_SHORT');
    }
    const limit = await api().get('/api/v1/operations/support/accounts?q=college&limit=201').set(auth(operator.userId));
    expect(limit.body.error.code).toBe('SUPPORT_LIMIT_INVALID');
  });

  it('reveals the full contact only with a reason, and audits the reveal', async () => {
    const security = await member('SECURITY_ADMIN');
    const person = await student();
    const url = '/api/v1/operations/support/accounts/' + person.userId + '/contact-reveal';
    const noReason = await api().post(url).set(auth(security.userId)).send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('REASON_CODE_INVALID');
    const revealed = await api().post(url).set(auth(security.userId)).send({ reasonCode: 'IDENTITY_VERIFICATION' });
    expect(revealed.status).toBe(201);
    expect(revealed.body.contact).toEqual({ email: person.email, phone: null });
    const audit = await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='operations.support_account.contact_revealed' AND resource_id=$1", [person.userId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_user_id).toBe(security.userId);
    expect(audit.rows[0].context).toMatchObject({ reasonCode: 'IDENTITY_VERIFICATION', fields: ['email', 'phone'] });
    expect(JSON.stringify(audit.rows[0].context)).not.toContain(person.email);
  });
});

describe('privacy deletion', () => {
  it('removes the person from their cases and keeps only non-identifying fields', async () => {
    const operator = await member('OPERATIONS_ADMIN');
    const person = await student();
    const id = (await openCase(operator, phoneCall({ subjectUserId: person.userId, organizationId: institutionId, summary: 'Asha cannot open her marksheet upload' }))).body.case.id as string;
    await api().post('/api/v1/operations/support/cases/' + id + '/notes').set(auth(operator.userId)).send({ note: 'Asha called back from her mother\'s phone.', reasonCode: 'CUSTOMER_CONTACT' }).expect(201);
    await transition(operator, id, 'IN_PROGRESS', 'WORK_STARTED').expect(201);
    const untouched = (await openCase(operator, phoneCall({ summary: 'Another person entirely' }))).body.case.id as string;

    const requestId = randomUUID();
    await pool.query(
      `INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
       VALUES ($1,$2,$2,'DELETION', now() - interval '31 days', now() - interval '1 day')`, [requestId, person.userId],
    );
    const summaries = await executeDueDeletions({ db, ids: { uuid: () => randomUUID() } });
    expect(summaries.find((summary) => summary.requestId === requestId)?.outcome).toBe('COMPLETED');

    const row = (await pool.query('SELECT subject_user_id, subject_detached_at, summary, summary_redacted_at, organization_id, category, severity, state FROM support_cases WHERE id=$1', [id])).rows[0];
    expect(row.subject_user_id).toBeNull();
    expect(row.subject_detached_at).not.toBeNull();
    expect(row.summary).toBe('Summary removed on privacy deletion.');
    expect(row.summary_redacted_at).not.toBeNull();
    // What remains says a case of this kind happened, and how it was handled.
    expect(row).toMatchObject({ organization_id: institutionId, category: 'ACCOUNT_ACCESS', severity: 'MEDIUM', state: 'IN_PROGRESS' });
    const notes = await pool.query("SELECT note, redacted_at FROM support_case_events WHERE case_id=$1 AND event_kind='NOTE'", [id]);
    expect(notes.rows).toEqual([{ note: null, redacted_at: expect.any(Date) }]);
    expect((await pool.query('SELECT 1 FROM support_cases WHERE subject_user_id=$1', [person.userId])).rowCount).toBe(0);
    expect((await pool.query('SELECT summary FROM support_cases WHERE id=$1', [untouched])).rows[0].summary).toBe('Another person entirely');

    const record = await pool.query("SELECT disposition, record_count, basis FROM privacy_deletion_records WHERE request_id=$1 AND category='SUPPORT_CASES'", [requestId]);
    expect(record.rows).toEqual([expect.objectContaining({ disposition: 'ANONYMISED', record_count: 1 })]);
    expect(record.rows[0].basis).toBeTruthy();

    const detail = await api().get('/api/v1/operations/support/cases/' + id).set(auth(operator.userId));
    expect(detail.body.case).toMatchObject({ subject: null, subjectDetached: true, summaryRedacted: true });
    expect(JSON.stringify(detail.body)).not.toContain('Asha');
    // The link cannot be put back.
    await expect(pool.query('UPDATE support_cases SET subject_user_id=$2, subject_detached_at=NULL WHERE id=$1', [id, person.userId])).rejects.toThrow();
  });
});
