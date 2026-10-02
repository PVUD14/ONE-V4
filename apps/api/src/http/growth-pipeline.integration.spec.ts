/**
 * The college pipeline and the operations handoff (GROWTH-04; growth-college-pipeline-table-design.md).
 *
 * The acceptance criteria this file carries:
 *  - only an operator with OPS_ORG_MANAGE can link a handoff (growth staff, a security admin and an
 *    operator without the capability are refused; the database refuses a lead naming an organisation
 *    without a linked request);
 *  - derived milestones match their source tables, in a spec that changes each source and reads again;
 *  - the student-activation count is suppressed below 5.
 * Also: the stage machine (forward, backward with a reason, hold and resume, lost terminal, a stale
 * move refused), the handoff request's preconditions, the link (owner recorded at link, contacts
 * carried to the account with ONBOARDING and every lead copy erased), the decline, and that no growth
 * route writes an organisation.
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
import { acceptInstitutionDataTerms, endInstitutionOffboarding, publishInstitutionDataTermsVersion, recordInstitutionOffboardingNotice } from '@planthepath/persistence/src/institution-contract.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for growth pipeline tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Growth pipeline tests require local Postgres');
const schemaName = 'growth_pipeline_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

const identities = new Map<string, { readonly email: string }>();
let app: INestApplication;
let platformId: string;
let superAdmin: Person;
let opsAdmin: Person;
let securityAdmin: Person;
let karnataka: string;
let manager: Person;
let execA: Person;
let execB: Person;

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
  opsAdmin = await member('OPERATIONS_ADMIN');
  securityAdmin = await member('SECURITY_ADMIN');
  karnataka = await region('South-KA', 'IN-KA');
  manager = await member('GROWTH_MANAGER');
  await team(manager, 'COLLEGE_PARTNERSHIPS');
  await assign(karnataka, manager, 'MANAGER');
  execA = await member('GROWTH_EXECUTIVE');
  await team(execA, 'COLLEGE_PARTNERSHIPS', manager);
  await assign(karnataka, execA, 'EXECUTIVE');
  execB = await member('GROWTH_EXECUTIVE');
  await team(execB, 'COLLEGE_PARTNERSHIPS');
  await assign(karnataka, execB, 'EXECUTIVE');
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

async function team(person: Person, name: string, reportsTo: Person | null = null): Promise<void> {
  await pool.query("INSERT INTO growth_team_members (id,membership_id,team,manager_membership_id,joined_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_MEMBER')",
    [randomUUID(), person.membershipId, name, reportsTo?.membershipId ?? null, superAdmin.userId]);
}

async function region(name: string, stateCode: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO growth_regions (id,name,created_by_user_id,reason_code) VALUES ($1,$2,$3,'NEW_REGION')", [id, name, superAdmin.userId]);
  await pool.query("INSERT INTO growth_region_areas (id,region_id,state_code,added_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_COVERAGE')", [randomUUID(), id, stateCode, superAdmin.userId]);
  return id;
}

async function assign(regionId: string, person: Person, role: 'EXECUTIVE' | 'MANAGER'): Promise<void> {
  await pool.query("INSERT INTO growth_territory_assignments (id,region_id,membership_id,assignment_role,assigned_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_ASSIGNMENT')",
    [randomUUID(), regionId, person.membershipId, role, superAdmin.userId]);
}

const api = () => request(app.getHttpServer());
const auth = (subject: string, key?: string) => ({
  Authorization: 'Bearer ' + subject, 'X-Correlation-Id': 'growth-pipeline-' + randomUUID(), ...(key ? { 'Idempotency-Key': key } : {}),
});
const unique = () => randomUUID().slice(0, 6);
const tokenHash = () => randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const leads = '/api/v1/growth/leads';
const handoffs = '/api/v1/operations/growth-handoffs';

async function leadOf(person: Person): Promise<string> {
  const created = await api().post(leads).set(auth(person.userId)).send({ kind: 'COLLEGE', name: 'College ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT' }).expect(201);
  return created.body.lead.id as string;
}

function stage(person: Person, leadId: string, fromStage: string, toStage: string, reasonCode?: string, key?: string) {
  return api().post(`${leads}/${leadId}/stage`).set(auth(person.userId, key)).send({ fromStage, toStage, ...(reasonCode ? { reasonCode } : {}) });
}

async function contactOn(person: Person, leadId: string, role: string): Promise<string> {
  const added = await api().post(`${leads}/${leadId}/contacts`).set(auth(person.userId))
    .send({ role, fullName: 'Contact ' + unique(), email: `c.${unique()}@college.example`, phone: '+91 98450 1' + String(Math.floor(Math.random() * 9000) + 1000), permissionBasis: 'PROVIDED_BY_PERSON', source: 'MEETING' }).expect(201);
  return (added.body.lead.contacts as { id: string; role: string }[]).filter((contact) => contact.role === role).at(-1)!.id;
}

/** A lead at AGREEMENT_SIGNED_REPORTED with an open handoff request carrying the given contacts. */
async function requested(person: Person, contactRoles: readonly string[] = []): Promise<{ readonly leadId: string; readonly contactIds: readonly string[] }> {
  const leadId = await leadOf(person);
  const contactIds: string[] = [];
  for (const role of contactRoles) contactIds.push(await contactOn(person, leadId, role));
  await stage(person, leadId, 'IDENTIFIED', 'AGREEMENT_SIGNED_REPORTED').expect(201);
  await api().post(`${leads}/${leadId}/handoff`).set(auth(person.userId)).send({ contractReference: 'AGR/2026-' + unique(), contactIds }).expect(201);
  return { leadId, contactIds };
}

async function institution(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION',$2)", [id, 'Institution ' + unique()]);
  return id;
}

describe('the stage machine', () => {
  it('moves forward freely, backward with a reason, and records every move', async () => {
    const lead = await leadOf(execA);
    const moved = await stage(execA, lead, 'IDENTIFIED', 'MET').expect(201);
    expect(moved.body).toMatchObject({ stage: 'MET', canMove: true });
    expect(moved.body.nextStages).not.toContain('HANDOFF_REQUESTED');
    await stage(execA, lead, 'MET', 'CONTACTED').expect(400).expect((r) => expect(r.body.error.code).toBe('GROWTH_STAGE_REASON_REQUIRED'));
    await stage(execA, lead, 'MET', 'CONTACTED', 'MEETING_CANCELLED').expect(201);
    const history = await pool.query('SELECT from_stage, to_stage, reason_code FROM growth_lead_stage_history WHERE lead_id=$1 ORDER BY occurred_at, id', [lead]);
    expect(history.rows).toEqual([
      { from_stage: null, to_stage: 'IDENTIFIED', reason_code: null },
      { from_stage: 'IDENTIFIED', to_stage: 'MET', reason_code: null },
      { from_stage: 'MET', to_stage: 'CONTACTED', reason_code: 'MEETING_CANCELLED' },
    ]);
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='growth.lead.stage_moved' AND aggregate_id=$1", [lead])).rows[0].n).toBe(2);
  });

  it('refuses a move made against a stage that has since changed (an old offline move)', async () => {
    const lead = await leadOf(execA);
    await stage(execA, lead, 'IDENTIFIED', 'CONTACTED').expect(201);
    const stale = await stage(execA, lead, 'IDENTIFIED', 'MET').expect(409);
    expect(stale.body.error).toMatchObject({ code: 'GROWTH_STAGE_CHANGED', currentStage: 'CONTACTED' });
  });

  it('lands a resent move once', async () => {
    const lead = await leadOf(execA);
    const key = randomUUID();
    for (let attempt = 0; attempt < 3; attempt += 1) await stage(execA, lead, 'IDENTIFIED', 'CONTACTED', undefined, key).expect(201);
    expect((await pool.query("SELECT count(*)::int AS n FROM growth_lead_stage_history WHERE lead_id=$1 AND to_stage='CONTACTED'", [lead])).rows[0].n).toBe(1);
  });

  it('holds with a reason and resumes to where it was', async () => {
    const lead = await leadOf(execA);
    await stage(execA, lead, 'IDENTIFIED', 'PROPOSAL_SHARED').expect(201);
    await stage(execA, lead, 'PROPOSAL_SHARED', 'ON_HOLD').expect(400);
    await stage(execA, lead, 'PROPOSAL_SHARED', 'ON_HOLD', 'BUDGET_CYCLE').expect(201);
    await stage(execA, lead, 'ON_HOLD', 'MET').expect(400);
    const resumed = await stage(execA, lead, 'ON_HOLD', 'RESUME').expect(201);
    expect(resumed.body.stage).toBe('PROPOSAL_SHARED');
  });

  it('makes LOST terminal, in the API and the database', async () => {
    const lead = await leadOf(execA);
    await stage(execA, lead, 'IDENTIFIED', 'LOST').expect(400);
    const lost = await stage(execA, lead, 'IDENTIFIED', 'LOST', 'NO_BUDGET').expect(201);
    expect(lost.body).toMatchObject({ stage: 'LOST', lostReasonCode: 'NO_BUDGET', nextStages: [] });
    await stage(execA, lead, 'LOST', 'CONTACTED', 'CORRECTION').expect(409);
    await expect(pool.query("UPDATE growth_leads SET stage='CONTACTED', lost_reason_code=NULL WHERE id=$1", [lead])).rejects.toThrow(/lost lead/);
  });

  it('is moved by the owner or their manager; another executive of the region is told nothing', async () => {
    const lead = await leadOf(execA);
    await stage(manager, lead, 'IDENTIFIED', 'CONTACTED').expect(201);
    await stage(execB, lead, 'CONTACTED', 'MET').expect(404);
    await api().post(`${leads}/${lead}/stage`).set(auth(opsAdmin.userId)).send({ fromStage: 'CONTACTED', toStage: 'MET' }).expect(403);
  });

  it('enters HANDOFF_REQUESTED only through the handoff route, in the API and the database', async () => {
    const lead = await leadOf(execA);
    await stage(execA, lead, 'IDENTIFIED', 'AGREEMENT_SIGNED_REPORTED').expect(201);
    await stage(execA, lead, 'AGREEMENT_SIGNED_REPORTED', 'HANDOFF_REQUESTED').expect(400)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_STAGE_NEEDS_HANDOFF_ROUTE'));
    await expect(pool.query("UPDATE growth_leads SET stage='HANDOFF_REQUESTED' WHERE id=$1", [lead])).rejects.toThrow(/open handoff request/);
  });
});

describe('the handoff request', () => {
  it('needs the agreement reported and a reference in the account\'s shape, and opens one request at a time', async () => {
    const lead = await leadOf(execA);
    await api().post(`${leads}/${lead}/handoff`).set(auth(execA.userId)).send({ contractReference: 'AGR-1' }).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_HANDOFF_NEEDS_AGREEMENT'));
    await stage(execA, lead, 'IDENTIFIED', 'AGREEMENT_SIGNED_REPORTED').expect(201);
    await api().post(`${leads}/${lead}/handoff`).set(auth(execA.userId)).send({ contractReference: 'Rs 5,00,000 for 300 students' }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_CONTRACT_REFERENCE_INVALID'));
    const other = await leadOf(execA);
    const foreign = await contactOn(execA, other, 'PRINCIPAL');
    await api().post(`${leads}/${lead}/handoff`).set(auth(execA.userId)).send({ contractReference: 'AGR-1', contactIds: [foreign] }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_HANDOFF_CONTACT_INVALID'));
    const asked = await api().post(`${leads}/${lead}/handoff`).set(auth(execA.userId)).send({ contractReference: 'AGR-1' }).expect(201);
    expect(asked.body).toMatchObject({ stage: 'HANDOFF_REQUESTED', canRequestHandoff: false, nextStages: [] });
    expect(asked.body.handoffRequests[0]).toMatchObject({ state: 'REQUESTED', contractReferenceReported: 'AGR-1' });
    await stage(execA, lead, 'HANDOFF_REQUESTED', 'NEGOTIATION', 'CORRECTION').expect(409);
    await expect(pool.query(`INSERT INTO growth_handoff_requests (id, lead_id, requested_by_user_id, requested_by_membership_id, contract_reference_reported)
      VALUES ($1,$2,$3,$4,'AGR-2')`, [randomUUID(), lead, execA.userId, execA.membershipId])).rejects.toThrow(/growth_handoff_open_uq/);
  });

  it('writes nothing to organisations or accounts from a growth route', async () => {
    const before = (await pool.query('SELECT (SELECT count(*) FROM organizations) AS orgs, (SELECT count(*) FROM institution_accounts) AS accounts')).rows[0];
    await requested(execA, ['PRINCIPAL']);
    const after = (await pool.query('SELECT (SELECT count(*) FROM organizations) AS orgs, (SELECT count(*) FROM institution_accounts) AS accounts')).rows[0];
    expect(after).toEqual(before);
  });
});

describe('only an operator with OPS_ORG_MANAGE can link a handoff', () => {
  it('refuses growth staff and an operator without the capability (a security admin)', async () => {
    const { leadId } = await requested(execA);
    const org = await institution();
    for (const person of [execA, manager, securityAdmin]) {
      await api().get(handoffs).set(auth(person.userId)).expect(403);
      await api().post(`${handoffs}/${leadId}/link`).set(auth(person.userId)).send({ organizationId: org }).expect(403);
      await api().post(`${handoffs}/${leadId}/decline`).set(auth(person.userId)).send({ reasonCode: 'INCOMPLETE' }).expect(403);
    }
    // A security admin's baseline has no OPS_ORG_MANAGE. The request is untouched by every refusal.
    expect((await pool.query("SELECT state FROM growth_handoff_requests WHERE lead_id=$1", [leadId])).rows[0].state).toBe('REQUESTED');
    expect((await pool.query('SELECT organization_id FROM growth_leads WHERE id=$1', [leadId])).rows[0].organization_id).toBeNull();
  });

  it('refuses, in the database, a lead naming an organisation without a linked request', async () => {
    const { leadId } = await requested(execA);
    const org = await institution();
    await expect(pool.query('UPDATE growth_leads SET organization_id=$2 WHERE id=$1', [leadId, org])).rejects.toThrow(/linked handoff request/);
  });

  it('shows the queue to an operations admin with contacts masked', async () => {
    const { leadId } = await requested(execA, ['PRINCIPAL']);
    const queue = await api().get(handoffs).set(auth(opsAdmin.userId)).expect(200);
    const entry = queue.body.requests.find((item: { leadId: string }) => item.leadId === leadId);
    expect(entry).toMatchObject({ state: 'REQUESTED', owner: execA.email, contactsMarked: 1 });
    expect(entry.contacts[0].email).toMatch(/\*/);
    expect(entry.contacts[0].phone).toMatch(/\*/);
  });
});

describe('the link', () => {
  it('records the owner at link, carries the marked contacts to the account with ONBOARDING, and erases every lead copy', async () => {
    const { leadId, contactIds } = await requested(execA, ['PRINCIPAL', 'CHAIRMAN_OR_TRUSTEE']);
    // A contact added after the request and not marked is not carried, but is erased too.
    const unmarked = await contactOn(execA, leadId, 'HR');
    const org = await institution();
    const linked = await api().post(`${handoffs}/${leadId}/link`).set(auth(opsAdmin.userId)).send({ organizationId: org }).expect(201);
    expect(linked.body.linked).toMatchObject({ contactsCarried: 2, contactsErased: 3, contactsOverLimit: 0 });
    const req = (await pool.query('SELECT state, organization_id, owner_membership_id_at_link, owner_user_id_at_link, decided_by_user_id FROM growth_handoff_requests WHERE lead_id=$1', [leadId])).rows[0];
    expect(req).toEqual({ state: 'LINKED', organization_id: org, owner_membership_id_at_link: execA.membershipId, owner_user_id_at_link: execA.userId, decided_by_user_id: opsAdmin.userId });
    expect((await pool.query('SELECT organization_id FROM growth_leads WHERE id=$1', [leadId])).rows[0].organization_id).toBe(org);
    const account = await pool.query("SELECT contact_role, added_reason_code, full_name IS NOT NULL AS named FROM institution_account_contacts WHERE institution_id=$1 ORDER BY created_at, contact_role", [org]);
    expect(account.rows.map((row) => [row.contact_role, row.added_reason_code, row.named]).sort()).toEqual([['OTHER', 'ONBOARDING', true], ['PRINCIPAL', 'ONBOARDING', true]]);
    const leadCopies = await pool.query('SELECT full_name, email, phone, removed_reason_code FROM growth_lead_contacts WHERE id = ANY($1)', [[...contactIds, unmarked]]);
    expect(leadCopies.rows).toHaveLength(3);
    for (const row of leadCopies.rows) expect(row).toEqual({ full_name: null, email: null, phone: null, removed_reason_code: 'HANDED_OVER' });
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.lead.handed_off' AND aggregate_id=$1", [leadId])).rows[0].payload).toEqual({ leadId, organizationId: org });
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='operations.institution_account.contact_added' AND organization_id=$1", [org])).rows[0].n).toBe(2);
    // A handed-off lead never moves again.
    await stage(execA, leadId, 'HANDOFF_REQUESTED', 'NEGOTIATION', 'CORRECTION').expect(409);
  });

  it('refuses an employer organisation and an organisation already linked to another lead', async () => {
    const first = await requested(execA);
    const second = await requested(execA);
    const employer = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','Acme')", [employer]);
    await api().post(`${handoffs}/${first.leadId}/link`).set(auth(opsAdmin.userId)).send({ organizationId: employer }).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_HANDOFF_NOT_AN_INSTITUTION'));
    const org = await institution();
    await api().post(`${handoffs}/${first.leadId}/link`).set(auth(opsAdmin.userId)).send({ organizationId: org }).expect(201);
    await api().post(`${handoffs}/${second.leadId}/link`).set(auth(opsAdmin.userId)).send({ organizationId: org }).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_ORGANIZATION_ALREADY_LINKED'));
    await api().post(`${handoffs}/${first.leadId}/link`).set(auth(opsAdmin.userId)).send({ organizationId: org }).expect(404);
  });

  it('declines back to NEGOTIATION with the reason, after which the owner may ask again', async () => {
    const { leadId } = await requested(execA);
    await api().post(`${handoffs}/${leadId}/decline`).set(auth(opsAdmin.userId)).send({ reasonCode: 'LOOKS_WRONG' }).expect(400);
    await api().post(`${handoffs}/${leadId}/decline`).set(auth(opsAdmin.userId)).send({ reasonCode: 'CONTRACT_NOT_CONFIRMED' }).expect(201);
    const pipeline = await api().get(`${leads}/${leadId}/pipeline`).set(auth(execA.userId)).expect(200);
    expect(pipeline.body).toMatchObject({ stage: 'NEGOTIATION', milestones: null });
    expect(pipeline.body.handoffRequests[0]).toMatchObject({ state: 'DECLINED', declineReasonCode: 'CONTRACT_NOT_CONFIRMED' });
    const history = await pool.query("SELECT reason_code FROM growth_lead_stage_history WHERE lead_id=$1 AND to_stage='NEGOTIATION'", [leadId]);
    expect(history.rows[0].reason_code).toBe('CONTRACT_NOT_CONFIRMED');
    await stage(execA, leadId, 'NEGOTIATION', 'AGREEMENT_SIGNED_REPORTED').expect(201);
    await api().post(`${leads}/${leadId}/handoff`).set(auth(execA.userId)).send({ contractReference: 'AGR-RETRY' }).expect(201);
  });
});

describe('derived milestones match their source tables', () => {
  it('reads each milestone from its source, and moves when the source changes', async () => {
    const { leadId } = await requested(execA);
    const org = await institution();
    await api().post(`${handoffs}/${leadId}/link`).set(auth(opsAdmin.userId)).send({ organizationId: org }).expect(201);
    const read = async () => {
      const body = (await api().get(`${leads}/${leadId}/pipeline`).set(auth(execA.userId)).expect(200)).body;
      return Object.fromEntries((body.milestones as { code: string }[]).map((milestone) => [milestone.code, milestone])) as unknown as Record<string, { state: string; at: string | null; count?: { suppressed: boolean; value: number | null } }>;
    };
    let m = await read();
    expect(m.HANDED_OFF!.state).toBe('REACHED');
    for (const code of ['CONTRACT_RECORDED', 'VERIFIED', 'ADMIN_JOINED', 'FIRST_ROSTER', 'EXITED', 'STUDENTS_ACTIVATING']) expect(m[code]!.state).toBe('NOT_REACHED');
    expect(m.DATA_TERMS_ACCEPTED!.state).toBe('NA');
    // GROWTH-10 records college payments; until one clears the milestone is not reached (its own spec
    // changes the source: institution-payments.integration.spec.ts).
    expect(m.FIRST_PAYMENT_CLEARED).toEqual({ code: 'FIRST_PAYMENT_CLEARED', state: 'NOT_REACHED', at: null, note: "Waiting for the college's payment to clear." });
    expect(m.STUDENTS_ACTIVATING!.count).toEqual({ suppressed: true, value: null });

    // CONTRACT_RECORDED: operations records the reference on the account (OPS-14).
    await pool.query("UPDATE institution_accounts SET contract_reference='AGR-2026-77', updated_by_user_id=$2 WHERE institution_id=$1", [org, opsAdmin.userId]);
    // VERIFIED: the verification history and the organisation's state.
    await pool.query("INSERT INTO organization_verification_events (id, organization_id, from_state, to_state, reason_code, actor_user_id, correlation_id) VALUES ($1,$2,'PENDING','VERIFIED','DOCUMENTS_CHECKED',$3,'corr-verify')", [randomUUID(), org, opsAdmin.userId]);
    await pool.query("UPDATE organizations SET verification_state='VERIFIED' WHERE id=$1", [org]);
    // ADMIN_JOINED: the initial institution admin invitation accepted.
    const admin = await member('PLATFORM_SUPER_ADMIN');
    await pool.query(`INSERT INTO invitations (id, email, token_hash, state, invited_by_user_id, organization_id, role, scope_organization_id, scope_institution_id, expires_at, accepted_by_user_id, accepted_at)
      VALUES ($1,$2,$3,'ACCEPTED',$4,$5,'INSTITUTION_ADMIN',$5,$5,now() + interval '7 days',$6,now())`, [randomUUID(), 'admin.' + unique() + '@college.example', tokenHash(), opsAdmin.userId, org, admin.userId]);
    // DATA_TERMS_ACCEPTED: NA until a version is published; then not reached until the college accepts.
    await publishInstitutionDataTermsVersion(db, { version: 'v' + unique(), title: 'Data terms', body: 'Terms body.', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: null,
      requiresReacceptance: true, changeSummary: null, reasonCode: 'INITIAL_TERMS', actorUserId: opsAdmin.userId, correlationId: 'corr-terms' });
    m = await read();
    expect(m.CONTRACT_RECORDED!.state).toBe('REACHED');
    expect(m.VERIFIED!.state).toBe('REACHED');
    expect(m.VERIFIED!.at).not.toBeNull();
    expect(m.ADMIN_JOINED!.state).toBe('REACHED');
    expect(m.DATA_TERMS_ACCEPTED!.state).toBe('NOT_REACHED');
    const version = (await pool.query('SELECT version FROM institution_data_terms_versions ORDER BY published_at DESC LIMIT 1')).rows[0].version as string;
    await acceptInstitutionDataTerms(db, { institutionId: org, version, actorUserId: admin.userId, correlationId: 'corr-accept' });

    // FIRST_ROSTER and STUDENTS_ACTIVATING: the college rosters students; four activate (suppressed), then a fifth.
    const students: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const student = randomUUID();
      students.push(student);
      await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [student, `student.${unique()}@example.test`]);
      await pool.query("INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status) VALUES ($1,$2,$3,$4,'Student','INVITED')", [randomUUID(), org, student, 'ROLL-' + unique()]);
      await pool.query("INSERT INTO institution_relationships (id, institution_id, student_user_id, state, effective_from) VALUES ($1,$2,$3,'ACTIVE',now())", [randomUUID(), org, student]);
    }
    const activate = async (student: string) => pool.query(`INSERT INTO invitations (id, kind, email, token_hash, state, invited_by_user_id, organization_id, student_user_id, expires_at, accepted_by_user_id, accepted_at)
      VALUES ($1,'STUDENT',$2,$3,'ACCEPTED',$4,$5,$6,now() + interval '7 days',$6,now())`, [randomUUID(), `invite.${unique()}@example.test`, tokenHash(), opsAdmin.userId, org, student]);
    for (const student of students.slice(0, 4)) await activate(student);
    m = await read();
    expect(m.DATA_TERMS_ACCEPTED!.state).toBe('REACHED');
    expect(m.FIRST_ROSTER!.state).toBe('REACHED');
    expect(m.STUDENTS_ACTIVATING!.count).toEqual({ suppressed: true, value: null });
    await activate(students[4]!);
    m = await read();
    expect(m.STUDENTS_ACTIVATING).toMatchObject({ state: 'REACHED', count: { suppressed: false, value: 5 } });

    // EXITED: the college exit runbook ends the agreement (INST-18).
    const notice = await recordInstitutionOffboardingNotice(db, { institutionId: org, reasonCode: 'CONTRACT_NOT_RENEWED', actorUserId: opsAdmin.userId, correlationId: 'corr-exit' });
    await endInstitutionOffboarding(db, { offboardingId: notice.id, reasonCode: 'CONTRACT_ENDED', actorUserId: opsAdmin.userId, correlationId: 'corr-exit-end' });
    m = await read();
    expect(m.EXITED!.state).toBe('REACHED');
    // Nothing about a student ever reaches a growth person.
    const body = JSON.stringify((await api().get(`${leads}/${leadId}/pipeline`).set(auth(execA.userId)).expect(200)).body);
    for (const student of students) expect(body).not.toContain(student);
    expect(body).not.toContain('ROLL-');
    expect(body).not.toContain('AGR-2026-77');
  });
});
