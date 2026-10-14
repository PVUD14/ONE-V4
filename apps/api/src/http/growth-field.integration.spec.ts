/**
 * Field work on the phone: visits, follow-ups, location and idempotent resends (GROWTH-06;
 * growth-field-work-table-design.md).
 *
 * The acceptance criteria this file carries:
 *  - a write retried five times lands once (one row, one audit row, one outbox event), sequentially
 *    and all at once;
 *  - a report older than 7 days or in the future is refused (API and database clock);
 *  - location is stored at 3 decimal places (API rounding and the column type);
 *  - declining location leaves logging intact (a visit without one is complete and counted).
 * Also: who may log and see work, who may see a location (author and manager only), location never
 * added after the fact and erased once, follow-ups and their closing, the Field page and `/me`
 * counts, the 180-day location sweep and the 24-month text sweep, export and account erasure.
 *
 * Real Postgres in a private schema. Dates are relative to now.
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
import { eraseGrowthLocationsForUser, sweepGrowthActivityLocations, sweepGrowthFieldText } from '@planthepath/persistence/src/growth-field.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { assembleCoverageSections } from './privacy-export-sections.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for growth field tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Growth field tests require local Postgres');
const schemaName = 'growth_field_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

const identities = new Map<string, { readonly email: string }>();
let app: INestApplication;
let platformId: string;
let superAdmin: Person;
let growthAdmin: Person;
let karnataka: string;
let tamilNadu: string;
let manager: Person;
let otherManager: Person;
let execA: Person;
let execB: Person;
let execC: Person;

interface Person { readonly userId: string; readonly membershipId: string; readonly email: string }

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      verifier: { async verifyAccessToken(token: string) {
        const identity = identities.get(token);
        if (!identity) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access',
          issuedAt: 0, expiresAt: 4_000_000_000, scopes: [], email: identity.email, emailVerified: true };
      } },
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
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state) VALUES ($1,'PLATFORM','ONE platform','VERIFIED')", [platformId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  growthAdmin = await member('OPERATIONS_ADMIN');
  await grant(growthAdmin, 'GROWTH_ADMIN');
  karnataka = await region('South-KA', 'IN-KA');
  tamilNadu = await region('South-TN', 'IN-TN');
  manager = await member('GROWTH_MANAGER');
  await team(manager, 'COLLEGE_PARTNERSHIPS');
  await assign(karnataka, manager, 'MANAGER');
  // A second manager of the same region who is not execA's manager: sees the lead, never execA's location.
  otherManager = await member('GROWTH_MANAGER');
  await team(otherManager, 'COLLEGE_PARTNERSHIPS');
  await assign(karnataka, otherManager, 'MANAGER');
  execA = await member('GROWTH_EXECUTIVE');
  await team(execA, 'COLLEGE_PARTNERSHIPS', manager);
  await assign(karnataka, execA, 'EXECUTIVE');
  execB = await member('GROWTH_EXECUTIVE');
  await team(execB, 'COLLEGE_PARTNERSHIPS');
  await assign(tamilNadu, execB, 'EXECUTIVE');
  execC = await member('GROWTH_EXECUTIVE');
  await team(execC, 'COLLEGE_PARTNERSHIPS', manager);
  await assign(karnataka, execC, 'EXECUTIVE');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

async function member(role: string, state = 'ACTIVE'): Promise<Person> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  const email = 'person-' + userId.slice(0, 8) + '@example.test';
  identities.set(userId, { email });
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  await pool.query("INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,$5,$2)",
    [membershipId, platformId, userId, role, state]);
  return { userId, membershipId, email };
}

async function grant(person: Person, capability: string): Promise<void> {
  await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
    [randomUUID(), person.membershipId, capability, superAdmin.userId]);
}

async function team(person: Person, name: string, reportsTo: Person | null = null): Promise<void> {
  await pool.query("INSERT INTO growth_team_members (id,membership_id,team,manager_membership_id,joined_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_MEMBER')",
    [randomUUID(), person.membershipId, name, reportsTo?.membershipId ?? null, growthAdmin.userId]);
}

async function region(name: string, stateCode: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO growth_regions (id,name,created_by_user_id,reason_code) VALUES ($1,$2,$3,'NEW_REGION')", [id, name, growthAdmin.userId]);
  await pool.query("INSERT INTO growth_region_areas (id,region_id,state_code,added_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_COVERAGE')", [randomUUID(), id, stateCode, growthAdmin.userId]);
  return id;
}

async function assign(regionId: string, person: Person, role: 'EXECUTIVE' | 'MANAGER'): Promise<void> {
  await pool.query("INSERT INTO growth_territory_assignments (id,region_id,membership_id,assignment_role,assigned_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_ASSIGNMENT')",
    [randomUUID(), regionId, person.membershipId, role, growthAdmin.userId]);
}

const api = () => request(app.getHttpServer());
const oneQuery = async (query: Parameters<typeof db.execute>[0]) => ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
const auth = (subject: string, key?: string) => ({
  Authorization: 'Bearer ' + subject, 'X-Correlation-Id': 'growth-field-' + randomUUID(), ...(key ? { 'Idempotency-Key': key } : {}),
});
const unique = () => randomUUID().slice(0, 6);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const istDay = (offset: number) => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);

async function leadOf(person: Person, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await api().post('/api/v1/growth/leads').set(auth(person.userId))
    .send({ kind: 'COLLEGE', name: 'College ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT', ...overrides }).expect(201);
  return created.body.lead.id as string;
}

const visit = (overrides: Record<string, unknown> = {}) => ({ kind: 'VISIT', outcome: 'MET', notes: 'Met the principal\'s office about a pilot.', occurredAt: minutesAgo(30), ...overrides });

function logActivity(person: Person, leadId: string, body: Record<string, unknown>, key: string | null = randomUUID()) {
  return api().post(`/api/v1/growth/leads/${leadId}/activities`).set(auth(person.userId, key ?? undefined)).send(body);
}

async function countWhere(table: string, column: string, value: string): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [value])).rows[0].n as number;
}

describe('who reaches the field routes', () => {
  it('admits only ACTIVE growth people, and the team view only for managers', async () => {
    await api().get('/api/v1/growth/field').set(auth(superAdmin.userId)).expect(403);
    await api().get('/api/v1/growth/field').set(auth(growthAdmin.userId)).expect(403);
    const suspended = await member('GROWTH_EXECUTIVE', 'SUSPENDED');
    await api().get('/api/v1/growth/field').set(auth(suspended.userId)).expect(403);
    await api().get('/api/v1/growth/field').set(auth(execA.userId)).expect(200);
    await api().get('/api/v1/growth/field?view=TEAM').set(auth(execA.userId)).expect(403);
    await api().get('/api/v1/growth/field?view=TEAM').set(auth(manager.userId)).expect(200);
    await api().get('/api/v1/growth/field?view=EVERYONE').set(auth(manager.userId)).expect(400);
  });

  it('answers 404 for a lead outside the caller\'s scope, and refuses an operator outright', async () => {
    const lead = await leadOf(execA);
    await api().get(`/api/v1/growth/leads/${lead}/field`).set(auth(execB.userId)).expect(404);
    await logActivity(execB, lead, visit()).expect(404);
    await logActivity(superAdmin, lead, visit()).expect(403);
  });
});

describe('logging a visit', () => {
  it('writes the activity with its audit row, outbox event and idempotency record, and moves the lead\'s activity clock', async () => {
    const lead = await leadOf(execA);
    await pool.query("UPDATE growth_leads SET last_activity_at = now() - interval '40 days' WHERE id=$1", [lead]);
    const key = randomUUID();
    const response = await logActivity(execA, lead, visit({ location: { latitude: 12.9715987, longitude: 77.5945623, accuracyM: 412.6 } }), key).expect(201);
    const activity = response.body.activity;
    expect(response.body.idempotentReplay).toBe(false);
    expect(activity).toMatchObject({ leadId: lead, kind: 'VISIT', outcome: 'MET', author: { email: execA.email, isMe: true }, location: { latitude: 12.972, longitude: 77.595, accuracyM: 413 } });
    const audit = await pool.query("SELECT context FROM audit_events WHERE action='growth.activity.logged' AND resource_id=$1", [activity.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].context).toMatchObject({ leadId: lead, kind: 'VISIT', hasLocation: true });
    // Where the visit was logged is never in an audit row or an event.
    expect(JSON.stringify(audit.rows[0].context)).not.toMatch(/12\.97|77\.59/);
    const event = await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.activity.logged' AND aggregate_id=$1", [activity.id]);
    expect(event.rows.map((row) => row.payload)).toEqual([{ activityId: activity.id, leadId: lead, kind: 'VISIT' }]);
    expect((await pool.query("SELECT status, response_resource_id FROM idempotency_records WHERE key=$1", [key])).rows).toEqual([{ status: 'SUCCEEDED', response_resource_id: activity.id }]);
    expect((await pool.query("SELECT last_activity_at > now() - interval '1 minute' AS moved FROM growth_leads WHERE id=$1", [lead])).rows[0].moved).toBe(true);
  });

  it('stores the location at 3 decimal places, in the column type as well as the API', async () => {
    const lead = await leadOf(execA);
    const response = await logActivity(execA, lead, visit({ location: { latitude: -12.3456789, longitude: 100.0004999, accuracyM: 25 } })).expect(201);
    const stored = await pool.query('SELECT location_latitude::text AS lat, location_longitude::text AS lng, location_accuracy_m FROM growth_activities WHERE id=$1', [response.body.activity.id]);
    expect(stored.rows[0]).toEqual({ lat: '-12.346', lng: '100.000', location_accuracy_m: 25 });
    // A row written without the API is rounded by the column itself.
    const id = randomUUID();
    await pool.query(`INSERT INTO growth_activities (id, lead_id, kind, outcome, author_membership_id, author_user_id, occurred_at, location_latitude, location_longitude, location_accuracy_m)
      VALUES ($1,$2,'VISIT','MET',$3,$4,now(),13.123456,77.987654,100)`, [id, lead, execA.membershipId, execA.userId]);
    expect((await pool.query('SELECT location_latitude::text AS lat, location_longitude::text AS lng FROM growth_activities WHERE id=$1', [id])).rows[0]).toEqual({ lat: '13.123', lng: '77.988' });
  });

  it('logs a complete visit without a location when the person declined it, and counts it', async () => {
    const lead = await leadOf(execC);
    const before = (await api().get('/api/v1/growth/me').set(auth(execC.userId)).expect(200)).body.visitsThisMonth as number;
    const response = await logActivity(execC, lead, visit({ notes: undefined })).expect(201);
    expect(response.body.activity).toMatchObject({ kind: 'VISIT', outcome: 'MET', location: null, locationRemoved: null, notes: null });
    expect((await pool.query("SELECT context FROM audit_events WHERE action='growth.activity.logged' AND resource_id=$1", [response.body.activity.id])).rows[0].context.hasLocation).toBe(false);
    expect((await api().get('/api/v1/growth/me').set(auth(execC.userId)).expect(200)).body.visitsThisMonth).toBe(before + 1);
  });

  it('requires an outcome for visits, calls and meetings, and text for a note; takes a location on in-person kinds only', async () => {
    const lead = await leadOf(execA);
    await logActivity(execA, lead, visit({ outcome: undefined })).expect(400).expect((r) => expect(r.body.error.code).toBe('GROWTH_ACTIVITY_OUTCOME_REQUIRED'));
    await logActivity(execA, lead, { kind: 'NOTE', occurredAt: minutesAgo(1) }).expect(400).expect((r) => expect(r.body.error.code).toBe('GROWTH_ACTIVITY_NOTES_REQUIRED'));
    await logActivity(execA, lead, { kind: 'NOTE', outcome: 'MET', notes: 'x', occurredAt: minutesAgo(1) }).expect(400);
    await logActivity(execA, lead, { kind: 'NOTE', notes: 'Prefers email.', occurredAt: minutesAgo(1) }).expect(201);
    await logActivity(execA, lead, { kind: 'CALL', outcome: 'NOT_AVAILABLE', occurredAt: minutesAgo(1), location: { latitude: 1, longitude: 1, accuracyM: 5 } }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_LOCATION_NOT_ALLOWED'));
    await logActivity(execA, lead, { kind: 'MEETING', outcome: 'INTERESTED', occurredAt: minutesAgo(1), location: { latitude: 1, longitude: 1, accuracyM: 5 } }).expect(201);
    await logActivity(execA, lead, visit({ location: { latitude: 95, longitude: 1, accuracyM: 5 } })).expect(400);
    await expect(pool.query(`INSERT INTO growth_activities (id, lead_id, kind, outcome, author_membership_id, author_user_id, occurred_at, location_latitude, location_longitude, location_accuracy_m)
      VALUES ($1,$2,'CALL','MET',$3,$4,now(),1,1,5)`, [randomUUID(), lead, execA.membershipId, execA.userId])).rejects.toThrow(/growth_activity_location_ck/);
  });

  it('names who was met by a contact of the same lead only', async () => {
    const lead = await leadOf(execA);
    const other = await leadOf(execA);
    const withContact = await api().post(`/api/v1/growth/leads/${other}/contacts`).set(auth(execA.userId))
      .send({ role: 'PRINCIPAL', fullName: 'Dr Asha Rao', email: `p.${unique()}@college.example`, permissionBasis: 'PROVIDED_BY_PERSON', source: 'BUSINESS_CARD' }).expect(201);
    const contactId = withContact.body.lead.contacts[0].id as string;
    await logActivity(execA, lead, visit({ contactId })).expect(400).expect((r) => expect(r.body.error.code).toBe('GROWTH_CONTACT_NOT_ON_LEAD'));
    const ok = await logActivity(execA, other, visit({ contactId })).expect(201);
    expect(ok.body.activity.contact).toEqual({ id: contactId, role: 'PRINCIPAL', fullName: 'Dr Asha Rao' });
  });
});

describe('a write retried five times lands once', () => {
  it('replays the first answer to every resend of the same key', async () => {
    const lead = await leadOf(execA);
    const key = randomUUID();
    const body = visit({ location: { latitude: 12.3, longitude: 76.6, accuracyM: 80 } });
    const responses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) responses.push(await logActivity(execA, lead, body, key).expect(201));
    const ids = new Set(responses.map((response) => response.body.activity.id));
    expect(ids.size).toBe(1);
    expect(responses.map((response) => response.body.idempotentReplay)).toEqual([false, true, true, true, true]);
    const id = [...ids][0]!;
    expect(await countWhere('growth_activities', 'lead_id', lead)).toBe(1);
    expect(await countWhere('audit_events', 'resource_id', id)).toBe(1);
    expect(await countWhere('outbox_events', 'aggregate_id', id)).toBe(1);
  });

  it('lands once when five copies arrive at the same moment', async () => {
    const lead = await leadOf(execA);
    const key = randomUUID();
    const body = visit();
    const responses = await Promise.all(Array.from({ length: 5 }, () => logActivity(execA, lead, body, key)));
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(responses.map((response) => response.body.activity.id)).size).toBe(1);
    expect(responses.filter((response) => response.body.idempotentReplay === false)).toHaveLength(1);
    expect(await countWhere('growth_activities', 'lead_id', lead)).toBe(1);
  });

  it('lands a follow-up, its completion and an offline lead once each', async () => {
    const lead = await leadOf(execA);
    const addKey = randomUUID();
    const add = { title: 'Send the pilot proposal', dueOn: istDay(2) };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await api().post(`/api/v1/growth/leads/${lead}/follow-ups`).set(auth(execA.userId, addKey)).send(add).expect(201);
    }
    const followUps = await pool.query('SELECT id FROM growth_follow_ups WHERE lead_id=$1', [lead]);
    expect(followUps.rows).toHaveLength(1);
    const followUp = followUps.rows[0].id as string;
    const doneKey = randomUUID();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const done = await api().post(`/api/v1/growth/follow-ups/${followUp}/complete`).set(auth(execA.userId, doneKey)).send({}).expect(201);
      expect(done.body.followUp.state).toBe('DONE');
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='growth.follow_up.completed' AND resource_id=$1", [followUp])).rows[0].n).toBe(1);
    // A second, different key on a closed follow-up is a real second request: refused.
    await api().post(`/api/v1/growth/follow-ups/${followUp}/complete`).set(auth(execA.userId, randomUUID())).send({}).expect(409);
    const leadKey = randomUUID();
    const name = 'Offline College ' + unique();
    const ids = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const created = await api().post('/api/v1/growth/leads').set(auth(execA.userId, leadKey)).send({ kind: 'COLLEGE', name, stateCode: 'IN-KA', source: 'FIELD_VISIT' }).expect(201);
      ids.add(created.body.lead.id as string);
    }
    expect(ids.size).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_leads WHERE name=$1', [name])).rows[0].n).toBe(1);
  });

  it('refuses a missing key, a malformed key, and one key reused for a different write', async () => {
    const lead = await leadOf(execA);
    await logActivity(execA, lead, visit(), null).expect(400).expect((r) => expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED'));
    await logActivity(execA, lead, visit(), 'short').expect(400).expect((r) => expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID'));
    const key = randomUUID();
    await logActivity(execA, lead, visit({ notes: 'First.' }), key).expect(201);
    await logActivity(execA, lead, visit({ notes: 'Second.' }), key).expect(422).expect((r) => expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED'));
    // The same key from another person is their own key, not a replay of someone else's write.
    const otherLead = await leadOf(execC);
    const theirs = await logActivity(execC, otherLead, visit({ notes: 'First.' }), key).expect(201);
    expect(theirs.body.idempotentReplay).toBe(false);
  });

  it('leaves no record behind a refusal, so a resend is refused the same way', async () => {
    const lead = await leadOf(execA);
    await pool.query("UPDATE growth_leads SET do_not_contact_at = now(), do_not_contact_reason = 'ORGANISATION_DECLINED', do_not_contact_by_user_id = $2 WHERE id=$1", [lead, execA.userId]);
    const key = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await logActivity(execA, lead, visit(), key).expect(409).expect((r) => expect(r.body.error.code).toBe('GROWTH_LEAD_DO_NOT_CONTACT'));
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM idempotency_records WHERE key=$1', [key])).rows[0].n).toBe(0);
  });
});

describe('a report older than 7 days or in the future is refused', () => {
  it('refuses through the API', async () => {
    const lead = await leadOf(execA);
    await logActivity(execA, lead, visit({ occurredAt: new Date(Date.now() - 7 * 86_400_000 - 60_000).toISOString() })).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_REPORT_TOO_OLD'));
    await logActivity(execA, lead, visit({ occurredAt: new Date(Date.now() + 60 * 60_000).toISOString() })).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_REPORT_IN_FUTURE'));
    await logActivity(execA, lead, visit({ occurredAt: new Date(Date.now() - 6 * 86_400_000).toISOString() })).expect(201);
    await logActivity(execA, lead, visit({ occurredAt: 'yesterday' })).expect(400);
  });

  it('refuses on the database clock too, and keeps the device time as reported beside the server\'s', async () => {
    const lead = await leadOf(execA);
    const insert = (occurred: string) => pool.query(`INSERT INTO growth_activities (id, lead_id, kind, outcome, author_membership_id, author_user_id, occurred_at)
      VALUES ($1,$2,'CALL','MET',$3,$4,${occurred})`, [randomUUID(), lead, execA.membershipId, execA.userId]);
    await expect(insert("now() - interval '7 days 1 minute'")).rejects.toThrow(/more than 7 days old/);
    await expect(insert("now() + interval '1 hour'")).rejects.toThrow(/in the future/);
    const occurred = minutesAgo(90);
    const response = await logActivity(execA, lead, visit({ occurredAt: occurred, kind: 'CALL', notes: undefined })).expect(201);
    expect(response.body.activity.occurredAt).toBe(occurred);
    expect(Date.parse(response.body.activity.receivedAt)).toBeGreaterThan(Date.parse(occurred));
  });
});

describe('who logs work and who sees where it was logged', () => {
  it('lets the owner and their region\'s manager log; an executive claims an unowned lead first', async () => {
    const lead = await leadOf(execA);
    await logActivity(manager, lead, visit({ notes: 'Went with the executive.' })).expect(201);
    const unowned = await leadOf(execC);
    await pool.query("UPDATE growth_leads SET owner_membership_id = NULL WHERE id=$1", [unowned]);
    await logActivity(execA, unowned, visit()).expect(403).expect((r) => expect(r.body.error.code).toBe('GROWTH_NOT_LEAD_OWNER'));
    await api().post(`/api/v1/growth/leads/${unowned}/claim`).set(auth(execA.userId)).expect(201);
    await logActivity(execA, unowned, visit()).expect(201);
  });

  it('shows a location to its author and their manager only — not to another manager who sees the lead', async () => {
    const lead = await leadOf(execA);
    const logged = await logActivity(execA, lead, visit({ location: { latitude: 12.5, longitude: 77.1, accuracyM: 50 } })).expect(201);
    const read = async (person: Person) => (await api().get(`/api/v1/growth/leads/${lead}/field`).set(auth(person.userId)).expect(200)).body.activities
      .find((activity: { id: string }) => activity.id === logged.body.activity.id);
    expect((await read(execA)).location).toEqual({ latitude: 12.5, longitude: 77.1, accuracyM: 50 });
    expect((await read(manager)).location).toEqual({ latitude: 12.5, longitude: 77.1, accuracyM: 50 });
    const outsider = await read(otherManager);
    expect(outsider).toBeDefined();
    expect(outsider).not.toHaveProperty('location');
    expect(outsider).not.toHaveProperty('locationRemoved');
    expect(JSON.stringify(outsider)).not.toContain('77.1');
    const team = await api().get('/api/v1/growth/field?view=TEAM').set(auth(otherManager.userId)).expect(200);
    expect(JSON.stringify(team.body)).not.toContain('77.1');
  });

  it('never adds or moves a location after the visit is logged, and erases it once', async () => {
    const lead = await leadOf(execA);
    const plain = await logActivity(execA, lead, visit()).expect(201);
    await expect(pool.query('UPDATE growth_activities SET location_latitude=1, location_longitude=1, location_accuracy_m=1 WHERE id=$1', [plain.body.activity.id]))
      .rejects.toThrow(/never added or changed/);
    const located = await logActivity(execA, lead, visit({ location: { latitude: 12.1, longitude: 77.2, accuracyM: 30 } })).expect(201);
    await expect(pool.query('UPDATE growth_activities SET location_latitude=12.2 WHERE id=$1', [located.body.activity.id])).rejects.toThrow(/never added or changed/);
    await expect(pool.query('UPDATE growth_activities SET notes=$2 WHERE id=$1', [located.body.activity.id, 'Rewritten'])).rejects.toThrow(/only erased once/);
    await expect(pool.query('DELETE FROM growth_activities WHERE id=$1', [located.body.activity.id])).rejects.toThrow(/never deleted/);
    // Only the author removes it; their manager cannot, and learns nothing from trying.
    await api().post(`/api/v1/growth/activities/${located.body.activity.id}/remove-location`).set(auth(manager.userId)).expect(404);
    const removed = await api().post(`/api/v1/growth/activities/${located.body.activity.id}/remove-location`).set(auth(execA.userId)).expect(201);
    expect(removed.body.activity).toMatchObject({ location: null, locationRemoved: { reasonCode: 'AUTHOR_REMOVED' } });
    expect((await pool.query('SELECT location_latitude, location_longitude, location_accuracy_m, location_erased_reason FROM growth_activities WHERE id=$1', [located.body.activity.id])).rows[0])
      .toEqual({ location_latitude: null, location_longitude: null, location_accuracy_m: null, location_erased_reason: 'AUTHOR_REMOVED' });
    expect((await pool.query("SELECT context FROM audit_events WHERE action='growth.activity.location_removed' AND resource_id=$1", [located.body.activity.id])).rows).toHaveLength(1);
    await api().post(`/api/v1/growth/activities/${located.body.activity.id}/remove-location`).set(auth(execA.userId)).expect(404);
  });

  it('refuses work on a do-not-contact lead in the database as well as the API', async () => {
    const lead = await leadOf(execA);
    await api().post(`/api/v1/growth/leads/${lead}/do-not-contact`).set(auth(execA.userId)).send({ reasonCode: 'ORGANISATION_DECLINED' }).expect(201);
    await logActivity(execA, lead, visit()).expect(409);
    await expect(pool.query(`INSERT INTO growth_activities (id, lead_id, kind, outcome, author_membership_id, author_user_id, occurred_at)
      VALUES ($1,$2,'CALL','MET',$3,$4,now())`, [randomUUID(), lead, execA.membershipId, execA.userId])).rejects.toThrow(/do-not-contact/);
    await api().post(`/api/v1/growth/leads/${lead}/follow-ups`).set(auth(execA.userId, randomUUID())).send({ title: 'Call back', dueOn: istToday() }).expect(409);
  });
});

describe('follow-ups', () => {
  it('keeps the due date between a week back and a year ahead', async () => {
    const lead = await leadOf(execA);
    const add = (dueOn: string) => api().post(`/api/v1/growth/leads/${lead}/follow-ups`).set(auth(execA.userId, randomUUID())).send({ title: 'Check in', dueOn });
    await add(istDay(-8)).expect(400).expect((r) => expect(r.body.error.code).toBe('GROWTH_FOLLOW_UP_DUE_TOO_EARLY'));
    await add(istDay(400)).expect(400).expect((r) => expect(r.body.error.code).toBe('GROWTH_FOLLOW_UP_DUE_TOO_LATE'));
    await add('2026-02-30').expect(400);
    await add(istDay(-1)).expect(201);
    await expect(pool.query(`INSERT INTO growth_follow_ups (id, lead_id, assignee_membership_id, created_by_user_id, due_on, title)
      VALUES ($1,$2,$3,$4,(now() AT TIME ZONE 'Asia/Kolkata')::date - 30,'Late')`, [randomUUID(), lead, execA.membershipId, execA.userId])).rejects.toThrow(/out of range/);
  });

  it('is closed by its assignee or their manager, once; anyone else is not told it exists', async () => {
    const lead = await leadOf(execA);
    const added = await api().post(`/api/v1/growth/leads/${lead}/follow-ups`).set(auth(execA.userId, randomUUID())).send({ title: 'Share brochure', dueOn: istToday() }).expect(201);
    const id = added.body.followUp.id as string;
    expect(added.body.followUp).toMatchObject({ state: 'OPEN', dueToday: true, overdue: false, assignee: { email: execA.email, isMe: true } });
    await api().post(`/api/v1/growth/follow-ups/${id}/complete`).set(auth(otherManager.userId, randomUUID())).send({}).expect(404);
    await api().post(`/api/v1/growth/follow-ups/${id}/cancel`).set(auth(manager.userId, randomUUID())).send({}).expect(400);
    const cancelled = await api().post(`/api/v1/growth/follow-ups/${id}/cancel`).set(auth(manager.userId, randomUUID())).send({ reasonCode: 'NO_LONGER_NEEDED' }).expect(201);
    expect(cancelled.body.followUp).toMatchObject({ state: 'CANCELLED', cancelReasonCode: 'NO_LONGER_NEEDED' });
    await expect(pool.query("UPDATE growth_follow_ups SET state='OPEN', closed_at=NULL, closed_by_user_id=NULL, cancel_reason_code=NULL WHERE id=$1", [id])).rejects.toThrow(/closed once/);
    await expect(pool.query('DELETE FROM growth_follow_ups WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
  });

  it('fills the Field page and Home: due today, overdue, this month\'s visits, and the team view for a manager', async () => {
    const person = await member('GROWTH_EXECUTIVE');
    await team(person, 'COLLEGE_PARTNERSHIPS', manager);
    await assign(karnataka, person, 'EXECUTIVE');
    const lead = await leadOf(person);
    const add = (title: string, dueOn: string) => api().post(`/api/v1/growth/leads/${lead}/follow-ups`).set(auth(person.userId, randomUUID())).send({ title, dueOn }).expect(201);
    await add('Overdue', istDay(-2));
    await add('Today', istToday());
    await add('Later', istDay(5));
    await logActivity(person, lead, visit()).expect(201);
    await logActivity(person, lead, { kind: 'CALL', outcome: 'NOT_AVAILABLE', occurredAt: minutesAgo(5) }).expect(201);
    const mine = await api().get('/api/v1/growth/field').set(auth(person.userId)).expect(200);
    expect(mine.body.counts).toEqual({ visitsThisMonth: 1, activitiesThisMonth: 2, metThisMonth: 1, followUpsOverdue: 1, followUpsDueToday: 1, followUpsOpen: 3 });
    expect(mine.body.followUps.map((f: { title: string }) => f.title)).toEqual(['Overdue', 'Today', 'Later']);
    expect(mine.body.canSeeTeam).toBe(false);
    expect(mine.body.vocabulary.locationNotice).toMatchObject({ status: 'DRAFT_FOR_LEGAL_REVIEW', version: 'draft-2026-10' });
    const me = await api().get('/api/v1/growth/me').set(auth(person.userId)).expect(200);
    expect(me.body).toMatchObject({ visitsThisMonth: 1, followUpsDue: 2 });
    const teamView = await api().get('/api/v1/growth/field?view=TEAM').set(auth(manager.userId)).expect(200);
    expect(teamView.body.followUps.some((f: { title: string; assignee: { email: string } }) => f.title === 'Overdue' && f.assignee.email === person.email)).toBe(true);
    expect((await api().get('/api/v1/growth/field?view=TEAM').set(auth(otherManager.userId)).expect(200)).body.followUps
      .some((f: { assignee: { email: string } }) => f.assignee.email === person.email)).toBe(false);
  });
});

describe('location and text retention, export and erasure', () => {
  async function backdate(activityId: string, interval: string): Promise<void> {
    // Fixture only: received_at is fixed by the guard, so the test moves it with the guard paused.
    await pool.query('ALTER TABLE growth_activities DISABLE TRIGGER growth_activity_guard');
    try {
      await pool.query(`UPDATE growth_activities SET received_at = now() - interval '${interval}', occurred_at = now() - interval '${interval}' WHERE id=$1`, [activityId]);
    } finally {
      await pool.query('ALTER TABLE growth_activities ENABLE TRIGGER growth_activity_guard');
    }
  }

  it('erases a location 180 days after the visit, keeps the visit, and is idempotent', async () => {
    const lead = await leadOf(execA);
    const old = await logActivity(execA, lead, visit({ location: { latitude: 12.4, longitude: 77.4, accuracyM: 40 } })).expect(201);
    const recent = await logActivity(execA, lead, visit({ location: { latitude: 12.6, longitude: 77.6, accuracyM: 40 } })).expect(201);
    await backdate(old.body.activity.id, '181 days');
    await backdate(recent.body.activity.id, '179 days');
    let erased = 0;
    for (let batch = await sweepGrowthActivityLocations(db); batch > 0; batch = await sweepGrowthActivityLocations(db)) erased += batch;
    expect(erased).toBe(1);
    const rows = await pool.query('SELECT id, location_latitude::text AS lat, location_erased_reason, notes FROM growth_activities WHERE id = ANY($1)', [[old.body.activity.id, recent.body.activity.id]]);
    const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
    expect(byId[old.body.activity.id]).toMatchObject({ lat: null, location_erased_reason: 'RETENTION_EXPIRED' });
    expect(byId[old.body.activity.id].notes).not.toBeNull();
    expect(byId[recent.body.activity.id]).toMatchObject({ lat: '12.600', location_erased_reason: null });
    expect(await sweepGrowthActivityLocations(db)).toBe(0);
  });

  it('erases notes and follow-up titles with the contacts of leads quiet for 24 months, and nothing else', async () => {
    const quiet = await leadOf(execA);
    const active = await leadOf(execA);
    const note = await logActivity(execA, quiet, { kind: 'NOTE', notes: 'Trustee prefers mornings.', occurredAt: minutesAgo(1) }).expect(201);
    const keep = await logActivity(execA, active, { kind: 'NOTE', notes: 'Keep this.', occurredAt: minutesAgo(1) }).expect(201);
    await api().post(`/api/v1/growth/leads/${quiet}/follow-ups`).set(auth(execA.userId, randomUUID())).send({ title: 'Ask about budget', dueOn: istDay(3) }).expect(201);
    await pool.query("UPDATE growth_leads SET last_activity_at = now() - interval '24 months 1 day' WHERE id=$1", [quiet]);
    await pool.query("UPDATE growth_leads SET last_activity_at = now() - interval '23 months' WHERE id=$1", [active]);
    let notes = 0;
    let titles = 0;
    for (let batch = await sweepGrowthFieldText(db); batch.notes + batch.titles > 0; batch = await sweepGrowthFieldText(db)) { notes += batch.notes; titles += batch.titles; }
    expect({ notes, titles }).toEqual({ notes: 1, titles: 1 });
    expect((await pool.query('SELECT notes, notes_erased_at IS NOT NULL AS erased FROM growth_activities WHERE id=$1', [note.body.activity.id])).rows[0]).toEqual({ notes: null, erased: true });
    expect((await pool.query('SELECT notes FROM growth_activities WHERE id=$1', [keep.body.activity.id])).rows[0].notes).toBe('Keep this.');
    expect((await pool.query('SELECT title, title_erased_at IS NOT NULL AS erased FROM growth_follow_ups WHERE lead_id=$1', [quiet])).rows).toEqual([{ title: null, erased: true }]);
    expect(await sweepGrowthFieldText(db)).toEqual({ notes: 0, titles: 0 });
  });

  it('puts the person\'s own field log, with locations still held, in their export', async () => {
    const person = await member('GROWTH_EXECUTIVE');
    await team(person, 'COLLEGE_PARTNERSHIPS');
    await assign(karnataka, person, 'EXECUTIVE');
    const lead = await leadOf(person, { name: 'Export College' });
    await logActivity(person, lead, visit({ location: { latitude: 12.9, longitude: 77.5, accuracyM: 60 } })).expect(201);
    await api().post(`/api/v1/growth/leads/${lead}/follow-ups`).set(auth(person.userId, randomUUID())).send({ title: 'Send deck', dueOn: istDay(1) }).expect(201);
    const sections = await assembleCoverageSections(oneQuery, person.userId) as { growthWork: { fieldActivities: unknown[]; followUps: unknown[] } };
    expect(sections.growthWork.fieldActivities).toEqual([expect.objectContaining({ organisation: 'Export College', kind: 'VISIT', location: { latitude: 12.9, longitude: 77.5, accuracyM: 60 } })]);
    expect(sections.growthWork.followUps).toEqual([expect.objectContaining({ organisation: 'Export College', title: 'Send deck', state: 'OPEN' })]);
    const nobody = await member('OPERATIONS_ADMIN');
    const empty = await assembleCoverageSections(oneQuery, nobody.userId) as { growthWork: { fieldActivities: unknown[]; followUps: unknown[] } };
    expect(empty.growthWork).toMatchObject({ fieldActivities: [], followUps: [] });
  });

  it('erases every location a person logged when their account is erased', async () => {
    const person = await member('GROWTH_EXECUTIVE');
    await team(person, 'COLLEGE_PARTNERSHIPS');
    await assign(karnataka, person, 'EXECUTIVE');
    const lead = await leadOf(person);
    const one = await logActivity(person, lead, visit({ location: { latitude: 12.1, longitude: 77.1, accuracyM: 60 } })).expect(201);
    const other = await logActivity(execA, await leadOf(execA), visit({ location: { latitude: 12.2, longitude: 77.2, accuracyM: 60 } })).expect(201);
    expect(await eraseGrowthLocationsForUser(db, person.userId)).toBe(1);
    expect((await pool.query('SELECT location_erased_reason FROM growth_activities WHERE id=$1', [one.body.activity.id])).rows[0].location_erased_reason).toBe('ACCOUNT_ERASED');
    expect((await pool.query('SELECT location_erased_reason FROM growth_activities WHERE id=$1', [other.body.activity.id])).rows[0].location_erased_reason).toBeNull();
    expect(await eraseGrowthLocationsForUser(db, person.userId)).toBe(0);
  });
});
