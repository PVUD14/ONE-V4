/**
 * College payments received (GROWTH-10; institution-payments-table-design.md).
 *
 * The acceptance criteria this file carries:
 *  - a payment row cannot change except by the listed transitions (route and database: every other
 *    update, a second change and DELETE are refused; corrections are a void plus a new row);
 *  - clearance needs a second person (OPS-02 INSTITUTION_PAYMENT_CLEARANCE, bound to the amount, the
 *    student count and the cleared date; the trigger refuses a clearance without it);
 *  - `students_paid` must be a positive count (route and CHECK);
 *  - no institution, employer, student or growth route returns an amount, a student count or a cheque
 *    reference (every such GET route is called by each of those callers; and a source scan);
 *  - a college's access in ONE is unaffected by any payment state (the same routes answer the same
 *    before any payment, after a bounce, after a clearance and after a void).
 * Also: who may read and write, the self-dealing guard (design §8.6), audit rows and events without
 * amounts, and GROWTH-04's FIRST_PAYMENT_CLEARED milestone reading this table.
 *
 * Real Postgres in a private schema. Dates are relative to now; no real payment data.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
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
if (!connectionString) throw new Error('DATABASE_URL is required for college payment tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('College payment tests require local Postgres');
const schemaName = 'inst_payments_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

type Constructor = abstract new (...args: never[]) => unknown;
interface Route { readonly method: string; readonly path: string }
interface Person { readonly userId: string; readonly membershipId: string; readonly email: string }

const identities = new Map<string, { readonly email: string }>();
let app: INestApplication;
let readRoutes: readonly Route[] = [];
let platformId: string;
let superAdmin: Person;
let approver: Person;
let finance: Person;
let finance2: Person;
let accountOnly: Person;
let securityAdmin: Person;
let manager: Person;
let execA: Person;
let regionId: string;

const methodNames: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete', [RequestMethod.PATCH]: 'patch',
};

function joinPath(...parts: readonly string[]): string {
  return '/' + parts.map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

function routesOf(controller: Constructor): Route[] {
  const base = Reflect.getMetadata('path', controller) as string | string[] | undefined;
  const bases = Array.isArray(base) ? base : [base ?? '/'];
  const found: Route[] = [];
  const prototype = controller.prototype as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = prototype[name];
    if (typeof handler !== 'function') continue;
    const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
    const path = Reflect.getMetadata('path', handler) as string | string[] | undefined;
    if (method === undefined || path === undefined) continue;
    const verb = methodNames[method];
    if (!verb) continue;
    for (const prefix of bases) for (const suffix of Array.isArray(path) ? path : [path]) found.push({ method: verb, path: joinPath(prefix, suffix) });
  }
  return found;
}

async function allControllers(): Promise<Constructor[]> {
  const dir = new URL('./', import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith('.controller.ts')).sort();
  const classes: Constructor[] = [];
  for (const file of files) {
    const loaded = await import(new URL(file, dir).href) as Record<string, unknown>;
    for (const value of Object.values(loaded)) {
      if (typeof value === 'function' && Reflect.getMetadata('path', value) !== undefined && Reflect.hasMetadata('__controller__', value)) classes.push(value as Constructor);
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
  });
  // Every GET route a college, an employer, a student or a growth person could call: every
  // controller's own metadata, minus the operations surface (which those callers cannot pass).
  const registered = new Set<unknown>(security.controllers ?? []);
  const controllers = await allControllers();
  readRoutes = controllers.filter((controller) => registered.has(controller)).flatMap(routesOf)
    .filter((route) => route.method === 'get' && !route.path.startsWith('/api/v1/operations'))
    .sort((a, b) => a.path.localeCompare(b.path));
  const module = await Test.createTestingModule({ imports: [security], providers: [{ provide: PG_POOL, useValue: pool }] }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();

  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state) VALUES ($1,'PLATFORM','ONE platform','VERIFIED')", [platformId]);
  superAdmin = await member('PLATFORM_SUPER_ADMIN');
  approver = await member('OPERATIONS_ADMIN');
  await grant(approver, 'APPROVE_HIGH_RISK');
  finance = await member('OPERATIONS_ADMIN');
  await grant(finance, 'GROWTH_FINANCE');
  finance2 = await member('OPERATIONS_ADMIN');
  await grant(finance2, 'GROWTH_FINANCE');
  accountOnly = await member('OPERATIONS_ADMIN');
  securityAdmin = await member('SECURITY_ADMIN');
  const region = randomUUID();
  regionId = region;
  await pool.query("INSERT INTO growth_regions (id,name,created_by_user_id,reason_code) VALUES ($1,'South-KA',$2,'NEW_REGION')", [region, superAdmin.userId]);
  await pool.query("INSERT INTO growth_region_areas (id,region_id,state_code,added_by_user_id,reason_code) VALUES ($1,$2,'IN-KA',$3,'NEW_COVERAGE')", [randomUUID(), region, superAdmin.userId]);
  manager = await member('GROWTH_MANAGER');
  await team(manager, null);
  await assign(region, manager, 'MANAGER');
  execA = await member('GROWTH_EXECUTIVE');
  await team(execA, manager);
  await assign(region, execA, 'EXECUTIVE');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

async function person(): Promise<{ readonly userId: string; readonly email: string }> {
  const userId = randomUUID();
  const email = 'person-' + userId.slice(0, 8) + '@example.test';
  identities.set(userId, { email });
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, email]);
  return { userId, email };
}

async function member(role: string, existing?: { readonly userId: string; readonly email: string }): Promise<Person> {
  const who = existing ?? await person();
  const membershipId = randomUUID();
  await pool.query("INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,'ACTIVE',$2)",
    [membershipId, platformId, who.userId, role]);
  return { userId: who.userId, membershipId, email: who.email };
}

async function grant(holder: Person, capability: string): Promise<void> {
  await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
    [randomUUID(), holder.membershipId, capability, superAdmin.userId]);
}

async function team(holder: Person, reportsTo: Person | null): Promise<void> {
  await pool.query("INSERT INTO growth_staff_types (id,membership_id,staff_type,set_by_user_id,reason_code) VALUES ($1,$2,'EMPLOYEE',$3,'INITIAL_TYPE')",
    [randomUUID(), holder.membershipId, superAdmin.userId]);
  await pool.query("INSERT INTO growth_team_members (id,membership_id,team,manager_membership_id,joined_by_user_id,reason_code) VALUES ($1,$2,'COLLEGE_PARTNERSHIPS',$3,$4,'NEW_MEMBER')",
    [randomUUID(), holder.membershipId, reportsTo?.membershipId ?? null, superAdmin.userId]);
}

async function assign(regionId: string, holder: Person, role: 'EXECUTIVE' | 'MANAGER'): Promise<void> {
  await pool.query("INSERT INTO growth_territory_assignments (id,region_id,membership_id,assignment_role,assigned_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_ASSIGNMENT')",
    [randomUUID(), regionId, holder.membershipId, role, superAdmin.userId]);
}

const api = () => request(app.getHttpServer());
const auth = (subject: string) => ({ Authorization: 'Bearer ' + subject, 'X-Correlation-Id': 'payments-' + randomUUID() });
const unique = () => randomUUID().slice(0, 6);
const payments = '/api/v1/operations/college-payments';
const approvals = '/api/v1/operations/approvals';

/** A UTC calendar date n days from today; India is never behind UTC, so a past one is past there too. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function college(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION',$2,'VERIFIED',true)", [id, 'Synthetic College ' + unique()]);
  return id;
}

/** A reference with letters outside hex, so it can be searched for in any response body. */
const reference = () => 'CHQZ' + Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');

function paymentBody(collegeId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collegeId, instrument: 'CHEQUE', instrumentReference: reference(), amountPaise: 12_500_050, studentsPaid: 37,
    receivedOn: day(-10), coversFrom: day(-30), coversTo: day(300), reasonCode: 'PAYMENT_RECEIVED', ...overrides,
  };
}

async function recorded(collegeId: string, overrides: Record<string, unknown> = {}): Promise<{ readonly id: string; readonly reference: string }> {
  const body = paymentBody(collegeId, overrides);
  const response = await api().post(payments).set(auth(finance.userId)).send(body).expect(201);
  return { id: response.body.payment.id as string, reference: body.instrumentReference as string };
}

async function requestClearance(paymentId: string, clearedOn: string, by: Person = finance): Promise<string> {
  const filed = await api().post(approvals).set(auth(by.userId))
    .send({ actionKey: 'INSTITUTION_PAYMENT_CLEARANCE', payload: { paymentId, clearedOn, reasonCode: 'BANK_STATEMENT_CONFIRMED' } }).expect(201);
  return filed.body.approval.id as string;
}

function approve(approvalId: string, by: Person = approver) {
  return api().post(`${approvals}/${approvalId}/decision`).set(auth(by.userId)).send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
}

function clear(paymentId: string, clearedOn: string, approvalId?: string, by: Person = finance) {
  return api().post(`${payments}/${paymentId}/clear`).set(auth(by.userId))
    .send({ clearedOn, reasonCode: 'BANK_STATEMENT_CONFIRMED', ...(approvalId ? { approvalId } : {}) });
}

async function cleared(collegeId: string): Promise<{ readonly id: string; readonly reference: string; readonly approvalId: string }> {
  const payment = await recorded(collegeId);
  const approvalId = await requestClearance(payment.id, day(-2));
  await approve(approvalId).expect(201);
  await clear(payment.id, day(-2), approvalId).expect(201);
  return { ...payment, approvalId };
}

const row = async (id: string) => (await pool.query('SELECT * FROM institution_payments WHERE id=$1', [id])).rows[0];

describe('who may read and write payments', () => {
  it('lets finance write, account managers read only, and refuses everyone else on every route', async () => {
    const collegeId = await college();
    const { id } = await recorded(collegeId);
    const policy = await api().get(`${payments}/policy`).set(auth(accountOnly.userId)).expect(200);
    expect(policy.body).toMatchObject({ canRecord: false, currency: 'INR' });
    const list = await api().get(payments).query({ collegeId }).set(auth(accountOnly.userId)).expect(200);
    expect(list.body.payments).toHaveLength(1);
    expect(list.body.canRecord).toBe(false);
    await api().post(payments).set(auth(accountOnly.userId)).send(paymentBody(collegeId)).expect(403);
    await api().post(`${payments}/${id}/void`).set(auth(accountOnly.userId)).send({ reasonCode: 'ENTERED_IN_ERROR' }).expect(403);
    const routes: readonly [string, string][] = [
      ['get', `${payments}/policy`], ['get', `${payments}?collegeId=${collegeId}`], ['post', payments], ['post', `${payments}/${id}/clear`],
      ['post', `${payments}/${id}/bounce`], ['post', `${payments}/${id}/refund`], ['post', `${payments}/${id}/void`],
    ];
    for (const caller of [execA, manager, securityAdmin]) {
      for (const [method, path] of routes) {
        const call = (api() as unknown as Record<string, (p: string) => request.Test>)[method]!(path).set(auth(caller.userId));
        const response = method === 'get' ? await call : await call.send({});
        expect(`${caller.email} ${method} ${path} -> ${response.status}`).toBe(`${caller.email} ${method} ${path} -> 403`);
      }
    }
    // A growth person cannot even file the clearance approval.
    await api().post(approvals).set(auth(execA.userId))
      .send({ actionKey: 'INSTITUTION_PAYMENT_CLEARANCE', payload: { paymentId: id, clearedOn: day(-1), reasonCode: 'BANK_STATEMENT_CONFIRMED' } }).expect(403);
  });
});

describe('recording a payment', () => {
  it('records amount in paise, the count and the period, audited and evented without the amount or the reference', async () => {
    const collegeId = await college();
    const body = paymentBody(collegeId, { note: 'Payment letter dated last week' });
    const created = await api().post(payments).set(auth(finance.userId)).send(body).expect(201);
    expect(created.body.payment).toMatchObject({
      instrument: 'CHEQUE', instrumentReference: body.instrumentReference, amountPaise: 12_500_050, currency: 'INR', studentsPaid: 37,
      receivedOn: body.receivedOn, coversFrom: body.coversFrom, coversTo: body.coversTo, state: 'RECEIVED', recordedBy: finance.email,
      cleared: null, bounced: null, refunded: null, voided: null,
    });
    const id = created.body.payment.id as string;
    expect(typeof (await row(id)).amount_paise).toBe('string'); // bigint in the database
    const audit = (await pool.query("SELECT actor_user_id, organization_id, context FROM audit_events WHERE action='operations.institution_payment.recorded' AND resource_id=$1", [id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: finance.userId, organization_id: collegeId });
    const auditText = JSON.stringify(audit[0].context);
    expect(auditText).not.toContain(String(body.instrumentReference));
    expect(auditText).not.toContain('12500050');
    const events = (await pool.query("SELECT payload FROM outbox_events WHERE event_type='institution_payment.recorded' AND aggregate_id=$1", [id])).rows;
    expect(events.map((event) => event.payload)).toEqual([{ paymentId: id, institutionId: collegeId }]);
  });

  it('requires a positive whole count of students, a positive whole amount in paise, a real period and real dates', async () => {
    const collegeId = await college();
    const refused = async (overrides: Record<string, unknown>, code: string) => {
      const response = await api().post(payments).set(auth(finance.userId)).send(paymentBody(collegeId, overrides)).expect(400);
      expect(response.body.error.code).toBe(code);
    };
    for (const studentsPaid of [0, -3, 2.5, '12', null, 100_001]) await refused({ studentsPaid }, 'INSTITUTION_PAYMENT_STUDENTS_INVALID');
    for (const amountPaise of [0, -100, 1250.5, '125000', 100_000_000_001]) await refused({ amountPaise }, 'INSTITUTION_PAYMENT_AMOUNT_INVALID');
    for (const instrumentReference of ['12', 'has space 123', 'x'.repeat(41), 'Rs.5000']) await refused({ instrumentReference }, 'INSTITUTION_PAYMENT_REFERENCE_INVALID');
    await refused({ instrument: 'CASH' }, 'INSTITUTION_PAYMENT_INSTRUMENT_INVALID');
    await refused({ receivedOn: day(3) }, 'INSTITUTION_PAYMENT_DATE_INVALID');
    await refused({ receivedOn: '2026-02-30' }, 'INSTITUTION_PAYMENT_DATE_INVALID');
    await refused({ coversFrom: day(10), coversTo: day(5) }, 'INSTITUTION_PAYMENT_COVERAGE_INVALID');
    await refused({ coversFrom: day(-10), coversTo: day(1200) }, 'INSTITUTION_PAYMENT_COVERAGE_INVALID');
    await refused({ reasonCode: 'CORRECTION' }, 'INSTITUTION_PAYMENT_CORRECTION_INVALID');
    await refused({ seats: 3 }, 'INVALID_REQUEST');
    await api().post(payments).set(auth(finance.userId)).send(paymentBody(randomUUID())).expect(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM institution_payments WHERE institution_id=$1', [collegeId])).rows[0].n).toBe(0);
  });

  it('is refused by the database for a non-positive count, a non-INR currency, a non-college or a future date', async () => {
    const collegeId = await college();
    const employer = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Synthetic Employer')", [employer]);
    const insert = (values: { institution?: string; students?: number; currency?: string; received?: string }) => pool.query(
      `INSERT INTO institution_payments (id,institution_id,instrument,instrument_reference,amount_paise,currency,students_paid,received_on,covers_from,covers_to,record_reason_code,recorded_by_user_id,correlation_id)
       VALUES ($1,$2,'CHEQUE',$3,100,$4,$5,$6::date,$6::date,$6::date,'PAYMENT_RECEIVED',$7,'corr-direct')`,
      [randomUUID(), values.institution ?? collegeId, reference(), values.currency ?? 'INR', values.students ?? 1, values.received ?? day(-1), finance.userId]);
    await expect(insert({ students: 0 })).rejects.toThrow();
    await expect(insert({ students: -1 })).rejects.toThrow();
    await expect(insert({ currency: 'USD' })).rejects.toThrow();
    await expect(insert({ institution: employer })).rejects.toThrow(/institution/);
    await expect(insert({ received: day(3) })).rejects.toThrow(/future/);
    await insert({});
  });

  it('refuses the same instrument twice while it stands, and accepts a bounced cheque presented again', async () => {
    const collegeId = await college();
    const first = await recorded(collegeId);
    const again = await api().post(payments).set(auth(finance.userId)).send(paymentBody(collegeId, { instrumentReference: first.reference.toLowerCase() })).expect(409);
    expect(again.body.error.code).toBe('INSTITUTION_PAYMENT_DUPLICATE');
    await api().post(`${payments}/${first.id}/bounce`).set(auth(finance.userId)).send({ on: day(-5), reasonCode: 'INSUFFICIENT_FUNDS' }).expect(201);
    await api().post(payments).set(auth(finance.userId)).send(paymentBody(collegeId, { instrumentReference: first.reference, receivedOn: day(-3) })).expect(201);
  });
});

describe('a payment changes only by the listed transitions', () => {
  it('refuses every direct edit and a delete', async () => {
    const collegeId = await college();
    const { id } = await recorded(collegeId);
    for (const change of ['amount_paise = 1', 'students_paid = 38', "instrument_reference = 'ABCD1234'", "received_on = received_on - 1", "note = 'changed'",
      "covers_to = covers_to + 1", "recorded_at = now() - interval '1 day'", "institution_id = '" + await college() + "'"]) {
      await expect(pool.query(`UPDATE institution_payments SET ${change} WHERE id=$1`, [id])).rejects.toThrow(/immutable/);
    }
    // CLEARED without an approval, straight from the database.
    await expect(pool.query(`UPDATE institution_payments SET state='CLEARED', cleared_on=received_on, cleared_at=now(), cleared_recorded_by_user_id=$2, clearance_approval_id=NULL WHERE id=$1`, [id, finance.userId])).rejects.toThrow();
    await expect(pool.query('DELETE FROM institution_payments WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
    expect((await row(id)).state).toBe('RECEIVED');
  });

  it('bounces a received payment once; nothing moves a bounced payment but a void', async () => {
    const collegeId = await college();
    const { id } = await recorded(collegeId);
    await api().post(`${payments}/${id}/bounce`).set(auth(finance.userId)).send({ on: day(-20), reasonCode: 'INSUFFICIENT_FUNDS' }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('INSTITUTION_PAYMENT_DATE_INVALID')); // before receipt
    await api().post(`${payments}/${id}/bounce`).set(auth(finance.userId)).send({ on: day(-5), reasonCode: 'NOT_A_REASON' }).expect(400);
    const bounced = await api().post(`${payments}/${id}/bounce`).set(auth(finance.userId)).send({ on: day(-5), reasonCode: 'SIGNATURE_MISMATCH' }).expect(201);
    expect(bounced.body.payment).toMatchObject({ state: 'BOUNCED', bounced: { on: day(-5), reasonCode: 'SIGNATURE_MISMATCH', by: finance.email } });
    await api().post(`${payments}/${id}/bounce`).set(auth(finance.userId)).send({ on: day(-4), reasonCode: 'STALE' }).expect(409);
    await api().post(`${payments}/${id}/refund`).set(auth(finance.userId)).send({ on: day(-1), reasonCode: 'OVERPAYMENT' }).expect(409);
    const approval = await api().post(approvals).set(auth(finance.userId))
      .send({ actionKey: 'INSTITUTION_PAYMENT_CLEARANCE', payload: { paymentId: id, clearedOn: day(-1), reasonCode: 'BANK_STATEMENT_CONFIRMED' } }).expect(400);
    expect(approval.body.error.code).toBe('APPROVAL_TARGET_STATE_INVALID');
    await expect(pool.query("UPDATE institution_payments SET state='RECEIVED', bounced_on=NULL, bounced_at=NULL, bounced_recorded_by_user_id=NULL, bounce_reason_code=NULL WHERE id=$1", [id])).rejects.toThrow();
    await expect(pool.query("UPDATE institution_payments SET bounce_reason_code='STALE' WHERE id=$1", [id])).rejects.toThrow();
    const voided = await api().post(`${payments}/${id}/void`).set(auth(finance.userId)).send({ reasonCode: 'ENTERED_IN_ERROR' }).expect(201);
    expect(voided.body.payment).toMatchObject({ state: 'VOIDED', bounced: { reasonCode: 'SIGNATURE_MISMATCH' }, voided: { reasonCode: 'ENTERED_IN_ERROR' } });
    await api().post(`${payments}/${id}/void`).set(auth(finance.userId)).send({ reasonCode: 'ENTERED_IN_ERROR' }).expect(409);
    const audits = (await pool.query("SELECT action, context FROM audit_events WHERE resource_type='institution_payment' AND resource_id=$1 ORDER BY occurred_at, id", [id])).rows;
    expect(audits.map((entry) => entry.action)).toEqual(['operations.institution_payment.recorded', 'operations.institution_payment.bounced', 'operations.institution_payment.voided']);
    expect(audits[1].context).toMatchObject({ fromState: 'RECEIVED', toState: 'BOUNCED', on: day(-5), reasonCode: 'SIGNATURE_MISMATCH' });
  });

  it('refunds only a cleared payment, voids it keeping every earlier column, and is corrected by a new row naming it', async () => {
    const collegeId = await college();
    const payment = await cleared(collegeId);
    await api().post(`${payments}/${payment.id}/refund`).set(auth(finance.userId)).send({ on: day(-3), reasonCode: 'OVERPAYMENT' }).expect(400); // before clearance
    await api().post(`${payments}/${payment.id}/refund`).set(auth(finance.userId)).send({ on: day(2), reasonCode: 'OVERPAYMENT' }).expect(400); // future
    await api().post(`${payments}/${payment.id}/refund`).set(auth(finance.userId)).send({ on: day(-1), reasonCode: 'OVERPAYMENT' }).expect(201);
    await api().post(`${payments}/${payment.id}/void`).set(auth(finance.userId)).send({ reasonCode: 'WRONG_DETAILS', note: 'Amount typed wrongly' }).expect(201);
    const stored = await row(payment.id);
    expect(stored).toMatchObject({ state: 'VOIDED', clearance_approval_id: payment.approvalId, refund_reason_code: 'OVERPAYMENT', void_reason_code: 'WRONG_DETAILS' });
    expect(stored.cleared_on).not.toBeNull();
    // A correction names the voided row; one correction per voided row; only a voided row of the same college.
    const correction = await api().post(payments).set(auth(finance.userId))
      .send(paymentBody(collegeId, { reasonCode: 'CORRECTION', replacesPaymentId: payment.id, instrumentReference: payment.reference })).expect(201);
    expect(correction.body.payment).toMatchObject({ recordReasonCode: 'CORRECTION', replacesPaymentId: payment.id, state: 'RECEIVED' });
    await api().post(payments).set(auth(finance.userId)).send(paymentBody(collegeId, { reasonCode: 'CORRECTION', replacesPaymentId: payment.id })).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('INSTITUTION_PAYMENT_CORRECTION_INVALID'));
    const live = await recorded(collegeId);
    await api().post(payments).set(auth(finance.userId)).send(paymentBody(collegeId, { reasonCode: 'CORRECTION', replacesPaymentId: live.id })).expect(400);
    const otherCollege = await college();
    await api().post(payments).set(auth(finance.userId)).send(paymentBody(otherCollege, { reasonCode: 'CORRECTION', replacesPaymentId: payment.id })).expect(400);
    const list = await api().get(payments).query({ collegeId }).set(auth(finance.userId)).expect(200);
    const voided = (list.body.payments as { id: string; replacedByPaymentId: string | null }[]).find((entry) => entry.id === payment.id)!;
    expect(voided.replacedByPaymentId).toBe(correction.body.payment.id);
    expect(list.body.counts).toMatchObject({ VOIDED: 1, RECEIVED: 2 });
  });
});

describe('clearance needs a second person', () => {
  it('refuses a clearance without an approval, before approval, by the requester, by another executor or for another date', async () => {
    const collegeId = await college();
    const { id } = await recorded(collegeId);
    await clear(id, day(-2)).expect(403).expect((r) => expect(r.body.error.code).toBe('APPROVAL_REQUIRED'));
    // The request binds the amount and count from the row and the date from the request.
    await api().post(approvals).set(auth(finance.userId))
      .send({ actionKey: 'INSTITUTION_PAYMENT_CLEARANCE', payload: { paymentId: id, clearedOn: day(-20), reasonCode: 'BANK_STATEMENT_CONFIRMED' } }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('INSTITUTION_PAYMENT_DATE_INVALID'));
    await api().post(approvals).set(auth(finance.userId))
      .send({ actionKey: 'INSTITUTION_PAYMENT_CLEARANCE', payload: { paymentId: id, clearedOn: day(-2), amountPaise: 1, reasonCode: 'BANK_STATEMENT_CONFIRMED' } }).expect(400);
    const approvalId = await requestClearance(id, day(-2));
    const filed = (await pool.query('SELECT payload, extended_action_key, extended_target_type, target_id FROM operation_approvals WHERE id=$1', [approvalId])).rows[0];
    expect(filed).toEqual({
      payload: { paymentId: id, amountPaise: 12_500_050, studentsPaid: 37, clearedOn: day(-2), reasonCode: 'BANK_STATEMENT_CONFIRMED' },
      extended_action_key: 'INSTITUTION_PAYMENT_CLEARANCE', extended_target_type: 'institution_payment', target_id: id,
    });
    await clear(id, day(-2), approvalId).expect(403).expect((r) => expect(r.body.error.code).toBe('APPROVAL_NOT_APPROVED'));
    // The approver sees what they approve: the college, the instrument, the amount, the count and the date.
    const queue = await api().get(approvals).query({ state: 'PENDING' }).set(auth(approver.userId)).expect(200);
    const listed = (queue.body.approvals as { id: string; summary: Record<string, unknown>; canApprove: boolean }[]).find((entry) => entry.id === approvalId)!;
    expect(listed.summary).toMatchObject({ paymentInstrument: 'CHEQUE', paymentAmountPaise: 12_500_050, paymentStudentsPaid: 37, paymentClearedOn: day(-2) });
    expect(String(listed.summary.organizationName)).toMatch(/^Synthetic College /);
    // The requester cannot approve their own request while another approver exists (finance holds no
    // APPROVE_HIGH_RISK at all here, so a second finance person who also approves is shown below).
    await approve(approvalId, finance).expect(403);
    await approve(approvalId).expect(201);
    await clear(id, day(-2), approvalId, finance2).expect(403).expect((r) => expect(r.body.error.code).toBe('APPROVAL_NOT_REQUESTER'));
    await clear(id, day(-1), approvalId).expect(403).expect((r) => expect(r.body.error.code).toBe('APPROVAL_PAYLOAD_MISMATCH'));
    expect((await row(id)).state).toBe('RECEIVED');
    const done = await clear(id, day(-2), approvalId).expect(201);
    expect(done.body).toMatchObject({ payment: { state: 'CLEARED', cleared: { on: day(-2), by: finance.email, approvedBy: approver.email, mode: 'DUAL' } }, approval: { id: approvalId, mode: 'DUAL' } });
    expect(await row(id)).toMatchObject({ state: 'CLEARED', clearance_approval_id: approvalId, cleared_recorded_by_user_id: finance.userId });
    // An approval clears once.
    await clear(id, day(-2), approvalId).expect(409);
    const audit = (await pool.query("SELECT context FROM audit_events WHERE action='operations.institution_payment.cleared' AND resource_id=$1", [id])).rows;
    expect(audit[0].context).toMatchObject({ fromState: 'RECEIVED', toState: 'CLEARED', clearedOn: day(-2), approvalId, approvedByUserId: approver.userId, mode: 'DUAL' });
    expect(JSON.stringify(audit[0].context)).not.toContain('12500050');
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='institution_payment.cleared' AND aggregate_id=$1", [id])).rows[0].payload)
      .toEqual({ paymentId: id, institutionId: collegeId, approvalId });
  });

  it('refuses a person who requests and approves their own clearance while a second approver exists', async () => {
    const both = await member('OPERATIONS_ADMIN');
    await grant(both, 'GROWTH_FINANCE');
    await grant(both, 'APPROVE_HIGH_RISK');
    const collegeId = await college();
    const { id } = await recorded(collegeId);
    const approvalId = await requestClearance(id, day(-1), both);
    await approve(approvalId, both).expect(403).expect((r) => expect(r.body.error.code).toBe('APPROVAL_SELF_DECISION_REFUSED'));
    await clear(id, day(-1), approvalId, both).expect(403);
    expect((await row(id)).state).toBe('RECEIVED');
  });

  it('refuses, in the database, a clearance whose approval does not bind this payment, amount, count and date', async () => {
    const collegeId = await college();
    const first = await recorded(collegeId);
    const second = await recorded(collegeId);
    const approvalId = await requestClearance(first.id, day(-2));
    await approve(approvalId).expect(201);
    await clear(first.id, day(-2), approvalId).expect(201);
    // The executed approval for the first payment cannot clear the second, even by a direct write.
    await expect(pool.query(
      "UPDATE institution_payments SET state='CLEARED', cleared_on=$2::date, cleared_at=now(), cleared_recorded_by_user_id=$3, clearance_approval_id=$4 WHERE id=$1",
      [second.id, day(-2), finance.userId, approvalId])).rejects.toThrow(/INSTITUTION_PAYMENT_CLEARANCE/);
  });
});

describe('the self-dealing guard (design §8.6)', () => {
  it('refuses the person credited with the college to record, request, approve or clear its payments', async () => {
    // A college handed off by a growth executive, who is the lead owner at link.
    const seller = await member('GROWTH_EXECUTIVE');
    await team(seller, manager);
    await assign(regionId, seller, 'EXECUTIVE');
    // A colleague found the lead first and their manager moved it to the seller, so both worked on it.
    const claimant = await member('GROWTH_EXECUTIVE');
    await team(claimant, manager);
    await assign(regionId, claimant, 'EXECUTIVE');
    const created = await api().post('/api/v1/growth/leads').set(auth(claimant.userId)).send({ kind: 'COLLEGE', name: 'College ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT' }).expect(201);
    const leadId = created.body.lead.id as string;
    await api().post(`/api/v1/growth/leads/${leadId}/reassign`).set(auth(manager.userId)).send({ toMembershipId: seller.membershipId, reasonCode: 'WORKLOAD' }).expect(201);
    await api().post(`/api/v1/growth/leads/${leadId}/stage`).set(auth(seller.userId)).send({ fromStage: 'IDENTIFIED', toStage: 'AGREEMENT_SIGNED_REPORTED' }).expect(201);
    await api().post(`/api/v1/growth/leads/${leadId}/handoff`).set(auth(seller.userId)).send({ contractReference: 'AGR/2026-' + unique(), contactIds: [] }).expect(201);
    const collegeId = await college();
    await api().post(`/api/v1/operations/growth-handoffs/${leadId}/link`).set(auth(superAdmin.userId)).send({ organizationId: collegeId }).expect(201);

    // The same person also holds an operations membership with finance and approval capabilities.
    const execAsOperator = await member('OPERATIONS_ADMIN', seller);
    await grant(execAsOperator, 'GROWTH_FINANCE');
    await grant(execAsOperator, 'APPROVE_HIGH_RISK');
    const refused = await api().post(payments).set(auth(seller.userId)).send(paymentBody(collegeId)).expect(403);
    expect(refused.body.error.code).toBe('INSTITUTION_PAYMENT_SELF_DEALING');
    await expect(pool.query(
      `INSERT INTO institution_payments (id,institution_id,instrument,instrument_reference,amount_paise,students_paid,received_on,covers_from,covers_to,record_reason_code,recorded_by_user_id,correlation_id)
       VALUES ($1,$2,'UPI',$3,100,1,$4::date,$4::date,$4::date,'PAYMENT_RECEIVED',$5,'corr-self')`,
      [randomUUID(), collegeId, reference(), day(-1), seller.userId])).rejects.toThrow(/credited/);

    const { id } = await recorded(collegeId);
    await api().post(approvals).set(auth(seller.userId))
      .send({ actionKey: 'INSTITUTION_PAYMENT_CLEARANCE', payload: { paymentId: id, clearedOn: day(-1), reasonCode: 'BANK_STATEMENT_CONFIRMED' } }).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('INSTITUTION_PAYMENT_SELF_DEALING'));
    const approvalId = await requestClearance(id, day(-1));
    await approve(approvalId, execAsOperator).expect(403).expect((r) => expect(r.body.error.code).toBe('APPROVAL_SUBJECT_CONFLICT'));
    await approve(approvalId).expect(201);
    await clear(id, day(-1), approvalId).expect(201);
    // GROWTH-07's parties: the live attribution's beneficiary is the seller; a claimant to an open
    // dispute about the college is refused too, through growth_organization_parties().
    const attribution = (await pool.query('SELECT id, beneficiary_user_id FROM growth_attributions WHERE organization_id=$1 AND ended_at IS NULL', [collegeId])).rows[0];
    expect(attribution.beneficiary_user_id).toBe(seller.userId);
    const claimantAsOperator = await member('OPERATIONS_ADMIN', claimant);
    await grant(claimantAsOperator, 'GROWTH_FINANCE');
    await api().post(payments).set(auth(claimant.userId)).send(paymentBody(collegeId)).expect(201);
    await pool.query(`INSERT INTO growth_attribution_disputes (id,organization_id,organization_kind,origin,attribution_id,claimant_user_id,respondent_user_id,statement,opened_by_user_id,correlation_id)
      VALUES ($1,$2,'INSTITUTION','CLAIM',$3,$4,$5,'I met the principal first.',$4,'corr-dispute')`, [randomUUID(), collegeId, attribution.id, claimant.userId, seller.userId]);
    await api().post(payments).set(auth(claimant.userId)).send(paymentBody(collegeId)).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('INSTITUTION_PAYMENT_SELF_DEALING'));
    // Another college is not this person's: they may record its payments.
    await api().post(payments).set(auth(seller.userId)).send(paymentBody(await college())).expect(201);
  });
});

describe('what growth sees: FIRST_PAYMENT_CLEARED', () => {
  it('is reached only while a payment stands cleared, and never shows an amount, a count, a reference or a date', async () => {
    const created = await api().post('/api/v1/growth/leads').set(auth(execA.userId)).send({ kind: 'COLLEGE', name: 'College ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT' }).expect(201);
    const leadId = created.body.lead.id as string;
    await api().post(`/api/v1/growth/leads/${leadId}/stage`).set(auth(execA.userId)).send({ fromStage: 'IDENTIFIED', toStage: 'AGREEMENT_SIGNED_REPORTED' }).expect(201);
    await api().post(`/api/v1/growth/leads/${leadId}/handoff`).set(auth(execA.userId)).send({ contractReference: 'AGR/2026-' + unique(), contactIds: [] }).expect(201);
    const collegeId = await college();
    await api().post(`/api/v1/operations/growth-handoffs/${leadId}/link`).set(auth(superAdmin.userId)).send({ organizationId: collegeId }).expect(201);
    const read = async (viewer: Person) => {
      const response = await api().get(`/api/v1/growth/leads/${leadId}/pipeline`).set(auth(viewer.userId)).expect(200);
      return { text: response.text, milestone: (response.body.milestones as { code: string }[]).find((entry) => entry.code === 'FIRST_PAYMENT_CLEARED') };
    };
    const waiting = { code: 'FIRST_PAYMENT_CLEARED', state: 'NOT_REACHED', at: null, note: "Waiting for the college's payment to clear." };
    expect((await read(execA)).milestone).toEqual(waiting);
    const payment = await recorded(collegeId);
    expect((await read(execA)).milestone).toEqual(waiting); // a receipt is not revealed
    const approvalId = await requestClearance(payment.id, day(-1));
    await approve(approvalId).expect(201);
    await clear(payment.id, day(-1), approvalId).expect(201);
    for (const viewer of [execA, manager]) {
      const seen = await read(viewer);
      expect(seen.milestone).toEqual({ code: 'FIRST_PAYMENT_CLEARED', state: 'REACHED', at: null });
      expect(seen.text).not.toContain(payment.reference);
      expect(seen.text).not.toMatch(/amountPaise|studentsPaid|instrumentReference|12500050/);
      expect(seen.text).not.toContain(day(-1));
    }
    await api().post(`${payments}/${payment.id}/void`).set(auth(finance.userId)).send({ reasonCode: 'WRONG_COLLEGE' }).expect(201);
    expect((await read(execA)).milestone).toEqual(waiting);
  });
});

describe('nothing outside operations finance reads a payment, and nothing is gated on one', () => {
  it('reads institution_payments only in the operations payments module, the approvals queue and the growth milestone', async () => {
    const root = new URL('../', import.meta.url);
    const readers: string[] = [];
    const walk = async (dir: URL, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(new URL(entry.name + '/', dir), prefix + entry.name + '/');
        else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
          const text = await readFile(new URL(entry.name, dir), 'utf8');
          if (/institution_payments|institution-payments\.js/.test(text)) readers.push(prefix + entry.name);
        }
      }
    };
    await walk(root, '');
    expect(readers.sort()).toEqual(['http/growth-pipeline-service.ts', 'http/operations-approvals.controller.ts', 'http/operations-college-payments.controller.ts']);
    // The growth side imports the yes-or-no read and nothing else.
    const growth = await readFile(new URL('http/growth-pipeline-service.ts', root), 'utf8');
    expect(growth.match(/import \{([^}]*)\} from '@planthepath\/persistence\/src\/institution-payments\.js'/)?.[1]?.trim()).toBe('institutionHasClearedPayment');
  });

  it('returns no amount, count or reference to a college, an employer, a student or growth staff, and answers them the same whatever the payment state', async () => {
    const collegeId = await college();
    const institutionAdmin = await person();
    await pool.query("INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id) VALUES ($1,$2,$3,'INSTITUTION_ADMIN','ACTIVE',$2,$2)",
      [randomUUID(), collegeId, institutionAdmin.userId]);
    const student = await person();
    await pool.query("INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE',now() - interval '30 days')",
      [randomUUID(), collegeId, student.userId]);
    const employerId = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Synthetic Employer','VERIFIED',true)", [employerId]);
    const employerAdmin = await person();
    await pool.query("INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id) VALUES ($1,$2,$3,'EMPLOYER_ADMIN','ACTIVE',$2,$2)",
      [randomUUID(), employerId, employerAdmin.userId]);
    const callers = [
      { name: 'institution admin', userId: institutionAdmin.userId, organizationId: collegeId },
      { name: 'student', userId: student.userId, organizationId: collegeId },
      { name: 'employer admin', userId: employerAdmin.userId, organizationId: employerId },
      { name: 'growth executive', userId: execA.userId, organizationId: collegeId },
      { name: 'growth manager', userId: manager.userId, organizationId: collegeId },
    ];
    expect(readRoutes.length).toBeGreaterThan(50);
    const fill = (path: string, organizationId: string) => path.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
      ['institutionId', 'organizationId', 'employerId', 'collegeId'].includes(name) ? organizationId : randomUUID());
    const sweep = async (secret: string | null): Promise<Record<string, number>> => {
      const statuses: Record<string, number> = {};
      for (const caller of callers) {
        for (const route of readRoutes) {
          const response = await api().get(fill(route.path, caller.organizationId)).set(auth(caller.userId)).set('X-Organization-Id', caller.organizationId);
          statuses[`${caller.name} GET ${route.path}`] = response.status;
          const text = response.text ?? '';
          if (secret && text.includes(secret)) throw new Error(`${caller.name} GET ${route.path} returned the payment reference`);
          if (/amountPaise|studentsPaid|instrumentReference|amount_paise|students_paid|instrument_reference/.test(text)) {
            throw new Error(`${caller.name} GET ${route.path} returned a payment field`);
          }
        }
      }
      return statuses;
    };
    const before = await sweep(null);
    // The sweep reaches real answers, not only refusals: the college admin and the student read their own pages.
    const answered = (who: string) => Object.entries(before).filter(([key, status]) => key.startsWith(who + ' GET') && status === 200).length;
    expect(answered('institution admin')).toBeGreaterThan(10);
    expect(answered('student')).toBeGreaterThan(10);
    expect(answered('growth executive')).toBeGreaterThan(3);
    const bouncedPayment = await recorded(collegeId);
    await api().post(`${payments}/${bouncedPayment.id}/bounce`).set(auth(finance.userId)).send({ on: day(-5), reasonCode: 'INSUFFICIENT_FUNDS' }).expect(201);
    expect(await sweep(bouncedPayment.reference)).toEqual(before);
    const clearedPayment = await cleared(collegeId);
    expect(await sweep(clearedPayment.reference)).toEqual(before);
    await api().post(`${payments}/${clearedPayment.id}/void`).set(auth(finance.userId)).send({ reasonCode: 'ENTERED_IN_ERROR' }).expect(201);
    expect(await sweep(clearedPayment.reference)).toEqual(before);
  }, 240_000);
});
