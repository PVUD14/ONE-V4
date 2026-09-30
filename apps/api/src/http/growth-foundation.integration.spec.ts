/**
 * Growth roles, the Growth team section and operator isolation (GROWTH-01, ADR-040).
 *
 * The acceptance criteria this file carries:
 *  - a growth executive (and a growth manager) gets 403 on every /api/v1/operations/* route —
 *    the routes are enumerated from the controllers' own metadata, not written out, so a route
 *    added later is covered without editing this file;
 *  - growth roles hold no internal capability and the database refuses to give them one;
 *  - an OPS-15 campaign opened after a growth person joins lists their membership with an
 *    empty capability set, and revoking it through the review suspends it;
 *  - a growth invitation without a staff type is refused; acceptance writes the first type;
 *    a type change ends the old row and writes a new one, both audited; no tax field exists;
 *  - team membership is append-only, and a membership that ends ends its team rows.
 *
 * Real Postgres in a private schema; the mail sink is a local capture, never a real sender.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import type { InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import { accessReviewDecisionReasons } from '@planthepath/authorization/src/index.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for growth foundation tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Growth foundation tests require local Postgres');
const schemaName = 'growth_found_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

const identities = new Map<string, { readonly email: string }>();
const sent: { toEmail: string; subject: string; textBody: string; invitationId: string }[] = [];
const sink: InvitationMailSink = {
  async send(input) {
    sent.push({ toEmail: input.toEmail, subject: input.subject, textBody: input.textBody, invitationId: input.invitationId });
    return { providerReference: 'test:' + input.invitationId };
  },
};

type Constructor = abstract new (...args: never[]) => unknown;
interface OperationsRoute { readonly method: string; readonly path: string }

let app: INestApplication;
let operationsRoutes: readonly OperationsRoute[] = [];
let platformId: string;
let institutionId: string;
let superAdmin: Person;
let growthAdmin: Person;

interface Person { readonly userId: string; readonly membershipId: string; readonly email: string }

const methodNames: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete', [RequestMethod.PATCH]: 'patch',
};

function joinPath(...parts: readonly string[]): string {
  return '/' + parts.map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

/** Every route a controller class declares, read from Nest's own decorator metadata. */
function routesOf(controller: Constructor): OperationsRoute[] {
  const base = Reflect.getMetadata('path', controller) as string | string[] | undefined;
  const bases = Array.isArray(base) ? base : [base ?? '/'];
  const found: OperationsRoute[] = [];
  const prototype = controller.prototype as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = prototype[name];
    if (typeof handler !== 'function') continue;
    const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
    const path = Reflect.getMetadata('path', handler) as string | string[] | undefined;
    if (method === undefined || path === undefined) continue;
    const verb = methodNames[method];
    if (!verb) throw new Error('unexpected request method on ' + controller.name + '.' + name);
    for (const prefix of bases) for (const suffix of Array.isArray(path) ? path : [path]) found.push({ method: verb, path: joinPath(prefix, suffix) });
  }
  return found;
}

/** Every controller class exported from apps/api/src/http/*.controller.ts. */
async function allControllers(): Promise<Constructor[]> {
  const dir = new URL('./', import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith('.controller.ts')).sort();
  const classes: Constructor[] = [];
  for (const file of files) {
    const loaded = await import(new URL(file, dir).href) as Record<string, unknown>;
    for (const value of Object.values(loaded)) {
      if (typeof value === 'function' && Reflect.getMetadata('path', value) !== undefined && Reflect.hasMetadata('__controller__', value)) {
        classes.push(value as Constructor);
      }
    }
  }
  return classes;
}

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const security = Phase1ApiSecurityModule.register({
    db, ids: { uuid: () => randomUUID() }, invitationMailSink: sink,
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
  });
  // Controllers AppModule registers outside the security module join here when they serve an
  // operations route, so the enumeration covers everything the running API serves.
  const registered = new Set<unknown>(security.controllers ?? []);
  const controllers = await allControllers();
  const extra = controllers.filter((controller) => !registered.has(controller)
    && routesOf(controller).some((route) => route.path.startsWith('/api/v1/operations')));
  operationsRoutes = controllers.flatMap(routesOf).filter((route) => route.path.startsWith('/api/v1/operations'))
    .sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  const module = await Test.createTestingModule({
    imports: [security],
    controllers: extra as never[],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();

  platformId = randomUUID();
  institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state) VALUES ($1,'PLATFORM','ONE platform','VERIFIED')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Growth test college')", [institutionId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  growthAdmin = await member('OPERATIONS_ADMIN');
  await grant(growthAdmin, 'GROWTH_ADMIN');
}, 180_000);

beforeEach(() => { sent.length = 0; });

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
  await pool.query(
    "INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,$5,$2)",
    [membershipId, platformId, userId, role, state],
  );
  return { userId, membershipId, email };
}

async function grant(person: Person, capability: string): Promise<void> {
  await pool.query(
    "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
    [randomUUID(), person.membershipId, capability, superAdmin.userId],
  );
}

function newcomer(email: string): string {
  const subject = 'sub-' + randomUUID();
  identities.set(subject, { email });
  return subject;
}

const api = () => request(app.getHttpServer());
const auth = (subject: string) => ({ Authorization: 'Bearer ' + subject, 'X-Correlation-Id': 'growth-' + randomUUID() });
const teamPath = '/api/v1/operations/growth-team';

function tokenFromLastEmail(toEmail: string): string {
  const message = [...sent].reverse().find((item) => item.toEmail === toEmail);
  const link = message?.textBody.match(/https?:\/\/\S+/)?.[0] ?? '';
  return new URL(link).searchParams.get('token') ?? '';
}

async function accept(subject: string, token: string, expected = 201): Promise<void> {
  await api().post('/api/v1/invitations/accept').set(auth(subject)).set('Idempotency-Key', 'accept-' + randomUUID()).send({ token }).expect(expected);
}

async function audits(action: string, resourceId: string) {
  return (await pool.query('SELECT actor_user_id, context FROM audit_events WHERE action=$1 AND resource_id=$2 ORDER BY occurred_at, id', [action, resourceId])).rows;
}

/** A growth person, as an ACTIVE membership with a staff type (the fixture shortcut past invitation). */
async function growthPerson(role: 'GROWTH_EXECUTIVE' | 'GROWTH_MANAGER', staffType: 'EMPLOYEE' | 'CONTRACTOR' = 'EMPLOYEE'): Promise<Person> {
  const person = await member(role);
  await pool.query(
    "INSERT INTO growth_staff_types (id,membership_id,staff_type,set_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'INITIAL_TYPE')",
    [randomUUID(), person.membershipId, staffType, growthAdmin.userId],
  );
  return person;
}

function fill(path: string): string {
  return path.replace(/:[A-Za-z]+/g, () => randomUUID());
}

describe('operator isolation: growth people reach no operations route', () => {
  it('finds the operations routes from the controllers themselves', () => {
    // A floor, not an exact count: the point is that enumeration found the whole surface.
    expect(operationsRoutes.length).toBeGreaterThan(100);
    expect(operationsRoutes).toEqual(expect.arrayContaining([
      { method: 'get', path: '/api/v1/operations/organizations' },
      { method: 'get', path: '/api/v1/operations/staff' },
      { method: 'get', path: '/api/v1/operations/access-reviews' },
      { method: 'get', path: '/api/v1/operations/growth-team' },
      { method: 'post', path: '/api/v1/operations/growth-team/invitations' },
    ]));
  });

  it.each(['GROWTH_EXECUTIVE', 'GROWTH_MANAGER'] as const)('answers 403 to a %s on every /api/v1/operations/* route', async (role) => {
    const person = await growthPerson(role);
    const wrong: string[] = [];
    for (const route of operationsRoutes) {
      const call = (api() as unknown as Record<string, (path: string) => request.Test>)[route.method]!(fill(route.path)).set(auth(person.userId));
      const response = route.method === 'get' || route.method === 'delete' ? await call : await call.send({});
      if (response.status !== 403) wrong.push(`${route.method.toUpperCase()} ${route.path} -> ${response.status}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});

describe('the database never gives a growth role authority', () => {
  it('admits growth roles only on the platform organisation, with no unit scope', async () => {
    const userId = randomUUID();
    await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [userId, userId + '@example.test']);
    await expect(pool.query(
      "INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id) VALUES ($1,$2,$3,'GROWTH_EXECUTIVE','ACTIVE',$2,$2)",
      [randomUUID(), institutionId, userId],
    )).rejects.toThrow(/invalid platform role scope/);
    await expect(pool.query(
      "INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id) VALUES ($1,$2,$3,'GROWTH_MANAGER','ACTIVE',$2,$4)",
      [randomUUID(), platformId, userId, institutionId],
    )).rejects.toThrow(/invalid platform role scope/);
    // The other branches are unchanged: an unknown role is still refused.
    await expect(pool.query(
      "INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,'GROWTH_DIRECTOR','ACTIVE',$2)",
      [randomUUID(), platformId, userId],
    )).rejects.toThrow(/unknown organization role/);
  });

  it('refuses every internal capability grant on a growth membership', async () => {
    const person = await growthPerson('GROWTH_MANAGER');
    for (const capability of ['GROWTH_ADMIN', 'GROWTH_FINANCE', 'OPS_VERIFY', 'APPROVE_HIGH_RISK']) {
      await expect(pool.query(
        "INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
        [randomUUID(), person.membershipId, capability, superAdmin.userId],
      ), capability).rejects.toThrow(/may be granted only/);
    }
  });

  it('grants the growth capabilities to an operations admin and to no other role', async () => {
    const ops = await member('OPERATIONS_ADMIN');
    await grant(ops, 'GROWTH_FINANCE');
    const security = await member('SECURITY_ADMIN');
    await expect(grant(security, 'GROWTH_ADMIN')).rejects.toThrow(/GROWTH_ADMIN may be granted only to an OPERATIONS_ADMIN/);
    await expect(grant(superAdmin, 'GROWTH_FINANCE')).rejects.toThrow(/may be granted only to an OPERATIONS_ADMIN/);
  });

  it('requires a staff type on a growth invitation, and refuses one anywhere else', async () => {
    const insert = (role: string, staffType: string | null) => pool.query(
      `INSERT INTO invitations (id,kind,email,token_hash,invited_by_user_id,organization_id,role,scope_organization_id,expires_at,growth_staff_type)
       VALUES ($1,'STAFF',$2,$3,$4,$5,$6,$5,now() + interval '14 days',$7)`,
      [randomUUID(), randomUUID() + '@example.test', randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''), growthAdmin.userId, platformId, role, staffType],
    );
    await expect(insert('GROWTH_EXECUTIVE', null)).rejects.toThrow(/invitation_growth_staff_type_ck/);
    await expect(insert('OPERATIONS_ADMIN', 'EMPLOYEE')).rejects.toThrow(/invitation_growth_staff_type_ck/);
    await expect(insert('GROWTH_MANAGER', 'INTERN')).rejects.toThrow(/invitation_growth_staff_type_value_ck/);
    await insert('GROWTH_MANAGER', 'CONTRACTOR');
  });

  it('keeps team rows append-only, refuses non-growth and self-made rows, and names only a manager as manager', async () => {
    const executive = await growthPerson('GROWTH_EXECUTIVE');
    const manager = await growthPerson('GROWTH_MANAGER');
    const ops = await member('OPERATIONS_ADMIN');
    const row = (membershipId: string, managerId: string | null, by: string, team = 'COLLEGE_PARTNERSHIPS') => pool.query(
      "INSERT INTO growth_team_members (id,membership_id,team,manager_membership_id,joined_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_MEMBER') RETURNING id",
      [randomUUID(), membershipId, team, managerId, by],
    );
    await expect(row(ops.membershipId, null, growthAdmin.userId)).rejects.toThrow(/growth membership/);
    await expect(row(executive.membershipId, null, executive.userId)).rejects.toThrow(/own team/);
    await expect(row(executive.membershipId, ops.membershipId, growthAdmin.userId)).rejects.toThrow(/manager must be an ACTIVE GROWTH_MANAGER/);
    await expect(row(executive.membershipId, executive.membershipId, growthAdmin.userId)).rejects.toThrow(/growth_team_member_not_own_manager_ck/);
    const live = (await row(executive.membershipId, manager.membershipId, growthAdmin.userId)).rows[0].id as string;
    await expect(row(executive.membershipId, null, growthAdmin.userId)).rejects.toThrow(/growth_team_members_live_uq/);
    await row(executive.membershipId, null, growthAdmin.userId, 'EMPLOYER_PARTNERSHIPS');
    await expect(pool.query("UPDATE growth_team_members SET team='EMPLOYER_PARTNERSHIPS' WHERE id=$1", [live])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM growth_team_members WHERE id=$1', [live])).rejects.toThrow(/never deleted/);
    await pool.query("UPDATE growth_team_members SET left_at=now(), left_by_user_id=$2, left_reason_code='CORRECTION' WHERE id=$1", [live, growthAdmin.userId]);
    await expect(pool.query("UPDATE growth_team_members SET left_reason_code='TEAM_CHANGE' WHERE id=$1", [live])).rejects.toThrow(/append-only/);
  });

  it('ends a membership\'s team rows when the membership ends, and keeps them through a suspension', async () => {
    const executive = await growthPerson('GROWTH_EXECUTIVE');
    await pool.query(
      "INSERT INTO growth_team_members (id,membership_id,team,joined_by_user_id,reason_code) VALUES ($1,$2,'EMPLOYER_PARTNERSHIPS',$3,'NEW_MEMBER')",
      [randomUUID(), executive.membershipId, growthAdmin.userId],
    );
    const liveRows = async () => (await pool.query('SELECT left_reason_code FROM growth_team_members WHERE membership_id=$1', [executive.membershipId])).rows;
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [executive.membershipId]);
    expect(await liveRows()).toEqual([{ left_reason_code: null }]);
    await pool.query("UPDATE organization_memberships SET state='ENDED' WHERE id=$1", [executive.membershipId]);
    expect(await liveRows()).toEqual([{ left_reason_code: 'MEMBERSHIP_ENDED' }]);
  });

  it('keeps staff types append-only with one live row, and has no tax column anywhere in growth', async () => {
    const person = await growthPerson('GROWTH_EXECUTIVE', 'CONTRACTOR');
    await expect(pool.query(
      "INSERT INTO growth_staff_types (id,membership_id,staff_type,set_by_user_id,reason_code) VALUES ($1,$2,'EMPLOYEE',$3,'CORRECTION')",
      [randomUUID(), person.membershipId, growthAdmin.userId],
    )).rejects.toThrow(/growth_staff_types_live_uq/);
    await expect(pool.query("UPDATE growth_staff_types SET staff_type='EMPLOYEE' WHERE membership_id=$1", [person.membershipId])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM growth_staff_types WHERE membership_id=$1', [person.membershipId])).rejects.toThrow(/never deleted/);
    const ops = await member('OPERATIONS_ADMIN');
    await expect(pool.query(
      "INSERT INTO growth_staff_types (id,membership_id,staff_type,set_by_user_id,reason_code) VALUES ($1,$2,'EMPLOYEE',$3,'INITIAL_TYPE')",
      [randomUUID(), ops.membershipId, growthAdmin.userId],
    )).rejects.toThrow(/growth membership/);
    const columns = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND (table_name LIKE 'growth%' OR (table_name = 'invitations' AND column_name LIKE 'growth%'))`,
    );
    expect(columns.rows.length).toBeGreaterThan(10);
    expect(columns.rows.filter((row) => /tax|tds|gst|withhold|net_/i.test(row.column_name))).toEqual([]);
  });
});

describe('OPS-15: an access review lists growth staff with no capabilities', () => {
  it('snapshots a growth membership with an empty capability set, and a revocation suspends it', async () => {
    const executive = await growthPerson('GROWTH_EXECUTIVE');
    await pool.query(
      "INSERT INTO growth_team_members (id,membership_id,team,joined_by_user_id,reason_code) VALUES ($1,$2,'COLLEGE_PARTNERSHIPS',$3,'NEW_MEMBER')",
      [randomUUID(), executive.membershipId, growthAdmin.userId],
    );
    const opened = await api().post('/api/v1/operations/access-reviews').set(auth(superAdmin.userId)).send({ reasonCode: 'AD_HOC_REVIEW' });
    expect(opened.status).toBe(201);
    const campaignId = opened.body.campaign.id as string;
    const items = await api().get('/api/v1/operations/access-reviews/' + campaignId + '/items?limit=200').set(auth(superAdmin.userId));
    expect(items.status).toBe(200);
    const item = (items.body.items as { id: string; subject: { email: string }; kind: string; role: string; capabilities: string[] }[])
      .find((entry) => entry.subject.email === executive.email);
    expect(item).toMatchObject({ kind: 'PLATFORM_ROLE', role: 'GROWTH_EXECUTIVE', capabilities: [] });
    // The operator side is reviewed too: the growth admin's grant is its own item.
    expect(items.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'CAPABILITY_GRANT', capability: 'GROWTH_ADMIN', subject: { email: growthAdmin.email, isSelf: false } })]));

    const revoked = await api().post('/api/v1/operations/access-reviews/' + campaignId + '/items/' + item!.id + '/decision').set(auth(superAdmin.userId))
      .send({ decision: 'REVOKE', reasonCode: accessReviewDecisionReasons.REVOKE[0] });
    expect(revoked.status).toBe(201);
    // A review revocation suspends the membership (OPS-15); access stops at once, and the team
    // rows stay so a reinstatement restores the line of reporting.
    const state = await pool.query('SELECT state FROM organization_memberships WHERE id=$1', [executive.membershipId]);
    expect(state.rows[0].state).toBe('SUSPENDED');
    expect((await api().get('/api/v1/growth/me').set(auth(executive.userId))).status).toBe(403);
    const rows = await pool.query('SELECT left_reason_code FROM growth_team_members WHERE membership_id=$1', [executive.membershipId]);
    expect(rows.rows).toEqual([{ left_reason_code: null }]);
  });
});

describe('Operations → Settings → Growth team', () => {
  it('is for GROWTH_ADMIN holders only', async () => {
    const plainOps = await member('OPERATIONS_ADMIN');
    const security = await member('SECURITY_ADMIN');
    expect((await api().get(teamPath).set(auth(plainOps.userId))).status).toBe(403);
    expect((await api().get(teamPath).set(auth(security.userId))).status).toBe(403);
    expect((await api().get(teamPath)).status).toBe(401);
    const listed = await api().get(teamPath).set(auth(growthAdmin.userId));
    expect(listed.status).toBe(200);
    expect(listed.body.vocabulary).toMatchObject({
      roles: ['GROWTH_EXECUTIVE', 'GROWTH_MANAGER'], teams: ['COLLEGE_PARTNERSHIPS', 'EMPLOYER_PARTNERSHIPS'], staffTypes: ['EMPLOYEE', 'CONTRACTOR'],
    });
    expect((await api().get(teamPath).set(auth(superAdmin.userId))).status).toBe(200);
  });

  it('refuses a growth invitation without a staff type, and one for a non-growth role', async () => {
    const missing = await api().post(teamPath + '/invitations').set(auth(growthAdmin.userId)).send({ email: 'no.type@example.test', role: 'GROWTH_EXECUTIVE' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('GROWTH_STAFF_TYPE_REQUIRED');
    const wrongType = await api().post(teamPath + '/invitations').set(auth(growthAdmin.userId)).send({ email: 'no.type@example.test', role: 'GROWTH_EXECUTIVE', staffType: 'INTERN' });
    expect(wrongType.body.error.code).toBe('GROWTH_STAFF_TYPE_INVALID');
    const operator = await api().post(teamPath + '/invitations').set(auth(growthAdmin.userId)).send({ email: 'no.type@example.test', role: 'OPERATIONS_ADMIN', staffType: 'EMPLOYEE' });
    expect(operator.body.error.code).toBe('GROWTH_ROLE_INVALID');
    expect((await pool.query("SELECT 1 FROM invitations WHERE email='no.type@example.test'")).rowCount).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('invites a growth person with a type, and acceptance creates the membership and its first type', async () => {
    const invited = await api().post(teamPath + '/invitations').set(auth(growthAdmin.userId))
      .send({ email: 'Field.Person@Example.test', role: 'GROWTH_EXECUTIVE', staffType: 'CONTRACTOR' });
    expect(invited.status).toBe(201);
    expect(invited.body.invitation).toMatchObject({ email: 'field.person@example.test', role: 'GROWTH_EXECUTIVE', staffType: 'CONTRACTOR', state: 'PENDING', delivery: { state: 'SENT' } });
    const invitationId = invited.body.invitation.id as string;
    expect((await audits('identity.invitation.created', invitationId))[0]).toMatchObject({
      actor_user_id: growthAdmin.userId, context: { role: 'GROWTH_EXECUTIVE', staffType: 'CONTRACTOR', source: 'GROWTH_TEAM' },
    });
    const again = await api().post(teamPath + '/invitations').set(auth(growthAdmin.userId)).send({ email: 'field.person@example.test', role: 'GROWTH_EXECUTIVE', staffType: 'EMPLOYEE' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('GROWTH_INVITATION_ALREADY_PENDING');

    const subject = newcomer('field.person@example.test');
    await accept(subject, tokenFromLastEmail('field.person@example.test'));
    const membership = await pool.query(
      "SELECT m.id, m.role, m.state FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE u.external_subject=$1", [subject],
    );
    expect(membership.rows).toEqual([{ id: expect.any(String), role: 'GROWTH_EXECUTIVE', state: 'ACTIVE' }]);
    const membershipId = membership.rows[0].id as string;
    const types = await pool.query('SELECT staff_type, set_by_user_id, reason_code, ended_at FROM growth_staff_types WHERE membership_id=$1', [membershipId]);
    expect(types.rows).toEqual([{ staff_type: 'CONTRACTOR', set_by_user_id: growthAdmin.userId, reason_code: 'INITIAL_TYPE', ended_at: null }]);
    expect(await audits('growth.staff_type.set', membershipId)).toHaveLength(1);

    // The person now signs in to the Growth workspace, and still cannot reach Operations.
    const me = await api().get('/api/v1/growth/me').set(auth(subject));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: 'GROWTH_EXECUTIVE', staffType: 'CONTRACTOR', teams: [] });
    expect((await api().get('/api/v1/operations/staff').set(auth(subject))).status).toBe(403);
  });

  it('sets a team and manager, changes the manager by ending the old row, and ends a team', async () => {
    const executive = await growthPerson('GROWTH_EXECUTIVE');
    const firstManager = await growthPerson('GROWTH_MANAGER');
    const secondManager = await growthPerson('GROWTH_MANAGER');
    const path = teamPath + '/' + executive.membershipId + '/teams';
    const joined = await api().post(path).set(auth(growthAdmin.userId))
      .send({ team: 'COLLEGE_PARTNERSHIPS', managerMembershipId: firstManager.membershipId, reasonCode: 'NEW_MEMBER' });
    expect(joined.status).toBe(201);
    expect(joined.body.member.teams).toEqual([expect.objectContaining({ team: 'COLLEGE_PARTNERSHIPS', manager: { membershipId: firstManager.membershipId, email: firstManager.email } })]);
    const unchanged = await api().post(path).set(auth(growthAdmin.userId))
      .send({ team: 'COLLEGE_PARTNERSHIPS', managerMembershipId: firstManager.membershipId, reasonCode: 'CORRECTION' });
    expect(unchanged.status).toBe(409);
    const badManager = await api().post(path).set(auth(growthAdmin.userId))
      .send({ team: 'COLLEGE_PARTNERSHIPS', managerMembershipId: growthAdmin.membershipId, reasonCode: 'MANAGER_CHANGE' });
    expect(badManager.body.error.code).toBe('GROWTH_MANAGER_INVALID');

    const moved = await api().post(path).set(auth(growthAdmin.userId))
      .send({ team: 'COLLEGE_PARTNERSHIPS', managerMembershipId: secondManager.membershipId, reasonCode: 'MANAGER_CHANGE' });
    expect(moved.status).toBe(201);
    const history = await pool.query(
      'SELECT manager_membership_id, left_reason_code, left_by_user_id FROM growth_team_members WHERE membership_id=$1 ORDER BY joined_at, id', [executive.membershipId],
    );
    expect(history.rows).toEqual([
      { manager_membership_id: firstManager.membershipId, left_reason_code: 'MANAGER_CHANGE', left_by_user_id: growthAdmin.userId },
      { manager_membership_id: secondManager.membershipId, left_reason_code: null, left_by_user_id: null },
    ]);
    expect(await audits('growth.team_member.left', executive.membershipId)).toHaveLength(1);
    expect(await audits('growth.team_member.joined', executive.membershipId)).toHaveLength(2);

    const ended = await api().post(path + '/COLLEGE_PARTNERSHIPS/end').set(auth(growthAdmin.userId)).send({ reasonCode: 'LEFT_TEAM' });
    expect(ended.status).toBe(201);
    expect(ended.body.member.teams).toEqual([]);
    const notHeld = await api().post(path + '/COLLEGE_PARTNERSHIPS/end').set(auth(growthAdmin.userId)).send({ reasonCode: 'LEFT_TEAM' });
    expect(notHeld.status).toBe(404);
  });

  it('changes a staff type by ending the old row and writing a new one, both audited', async () => {
    const executive = await growthPerson('GROWTH_EXECUTIVE', 'EMPLOYEE');
    const path = teamPath + '/' + executive.membershipId + '/staff-type';
    expect((await api().post(path).set(auth(growthAdmin.userId)).send({ staffType: 'EMPLOYEE', reasonCode: 'CORRECTION' })).status).toBe(409);
    expect((await api().post(path).set(auth(growthAdmin.userId)).send({ staffType: 'CONTRACTOR', reasonCode: 'INITIAL_TYPE' })).body.error.code).toBe('REASON_CODE_INVALID');
    const changed = await api().post(path).set(auth(growthAdmin.userId)).send({ staffType: 'CONTRACTOR', reasonCode: 'ENGAGEMENT_CHANGED' });
    expect(changed.status).toBe(201);
    expect(changed.body.member.staffType).toMatchObject({ staffType: 'CONTRACTOR' });
    const rows = await pool.query(
      'SELECT staff_type, reason_code, ended_reason_code, ended_by_user_id FROM growth_staff_types WHERE membership_id=$1 ORDER BY created_at, (ended_at IS NULL)', [executive.membershipId],
    );
    expect(rows.rows).toEqual([
      { staff_type: 'EMPLOYEE', reason_code: 'INITIAL_TYPE', ended_reason_code: 'ENGAGEMENT_CHANGED', ended_by_user_id: growthAdmin.userId },
      { staff_type: 'CONTRACTOR', reason_code: 'ENGAGEMENT_CHANGED', ended_reason_code: null, ended_by_user_id: null },
    ]);
    expect((await audits('growth.staff_type.ended', executive.membershipId))[0]).toMatchObject({ context: { staffType: 'EMPLOYEE', reasonCode: 'ENGAGEMENT_CHANGED' } });
    expect((await audits('growth.staff_type.set', executive.membershipId))[0]).toMatchObject({ context: { staffType: 'CONTRACTOR', reasonCode: 'ENGAGEMENT_CHANGED' } });
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.staff_type.set' AND payload->>'membershipId'=$1", [executive.membershipId]);
    expect(outbox.rows).toEqual([{ payload: { membershipId: executive.membershipId, staffType: 'CONTRACTOR' } }]);
  });

  it('ends a growth membership, its team rows with it, and refuses acting on oneself or on an operator', async () => {
    const executive = await growthPerson('GROWTH_EXECUTIVE');
    await api().post(teamPath + '/' + executive.membershipId + '/teams').set(auth(growthAdmin.userId)).send({ team: 'EMPLOYER_PARTNERSHIPS', reasonCode: 'NEW_MEMBER' }).expect(201);
    const self = await api().post(teamPath + '/' + growthAdmin.membershipId + '/end').set(auth(growthAdmin.userId)).send({ reasonCode: 'LEFT_AI8HT' });
    expect(self.status).toBe(403);
    const operator = await member('OPERATIONS_ADMIN');
    const notGrowth = await api().post(teamPath + '/' + operator.membershipId + '/end').set(auth(growthAdmin.userId)).send({ reasonCode: 'LEFT_AI8HT' });
    expect(notGrowth.status).toBe(400);
    expect(notGrowth.body.error.code).toBe('GROWTH_NOT_A_GROWTH_MEMBERSHIP');

    const ended = await api().post(teamPath + '/' + executive.membershipId + '/end').set(auth(growthAdmin.userId)).send({ reasonCode: 'LEFT_AI8HT' });
    expect(ended.status).toBe(201);
    expect((await pool.query('SELECT state FROM organization_memberships WHERE id=$1', [executive.membershipId])).rows[0].state).toBe('ENDED');
    expect((await pool.query('SELECT left_reason_code FROM growth_team_members WHERE membership_id=$1', [executive.membershipId])).rows).toEqual([{ left_reason_code: 'MEMBERSHIP_ENDED' }]);
    const outbox = await pool.query("SELECT payload FROM outbox_events WHERE event_type='organization_membership.ended' AND aggregate_id=$1", [executive.membershipId]);
    expect(outbox.rows).toEqual([{ payload: { membershipId: executive.membershipId, role: 'GROWTH_EXECUTIVE' } }]);
    expect((await api().get('/api/v1/growth/me').set(auth(executive.userId))).status).toBe(403);
    // The staff type is kept: it records how the person was engaged, which a settlement needs.
    expect((await pool.query('SELECT ended_at FROM growth_staff_types WHERE membership_id=$1', [executive.membershipId])).rows).toEqual([{ ended_at: null }]);
  });

  it('revokes a pending growth invitation so it can no longer be accepted', async () => {
    const invited = await api().post(teamPath + '/invitations').set(auth(growthAdmin.userId)).send({ email: 'revoked.growth@example.test', role: 'GROWTH_MANAGER', staffType: 'EMPLOYEE' }).expect(201);
    const token = tokenFromLastEmail('revoked.growth@example.test');
    await api().post(teamPath + '/invitations/' + invited.body.invitation.id + '/revoke').set(auth(growthAdmin.userId)).send({ reasonCode: 'SENT_IN_ERROR' }).expect(201);
    await accept(newcomer('revoked.growth@example.test'), token, 403);
    const listed = await api().get(teamPath).set(auth(growthAdmin.userId));
    expect((listed.body.invitations as { id: string }[]).some((row) => row.id === invited.body.invitation.id)).toBe(false);
  });
});

describe('the Growth workspace', () => {
  it('serves a growth person their own role, teams and type, and nobody else', async () => {
    const manager = await growthPerson('GROWTH_MANAGER', 'EMPLOYEE');
    const executive = await growthPerson('GROWTH_EXECUTIVE', 'CONTRACTOR');
    await pool.query(
      "INSERT INTO growth_team_members (id,membership_id,team,manager_membership_id,joined_by_user_id,reason_code) VALUES ($1,$2,'COLLEGE_PARTNERSHIPS',$3,$4,'NEW_MEMBER')",
      [randomUUID(), executive.membershipId, manager.membershipId, growthAdmin.userId],
    );
    const me = await api().get('/api/v1/growth/me').set(auth(executive.userId));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      role: 'GROWTH_EXECUTIVE', staffType: 'CONTRACTOR',
      teams: [{ team: 'COLLEGE_PARTNERSHIPS', joinedAt: expect.any(String), manager: { email: manager.email } }],
    });
    // Nothing that identifies a student, an amount or an internal id beyond the person's own.
    expect(JSON.stringify(me.body)).not.toMatch(/amount|paise|rate|student/i);
    expect((await api().get('/api/v1/growth/me').set(auth(growthAdmin.userId))).status).toBe(403);
    expect((await api().get('/api/v1/growth/me').set(auth(superAdmin.userId))).status).toBe(403);
    expect((await api().get('/api/v1/growth/me')).status).toBe(401);
  });
});
