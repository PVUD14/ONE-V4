/**
 * The lead register, contacts and their personal-data paths (GROWTH-03; growth-leads-table-design.md).
 *
 * The acceptance criteria this file carries:
 *  - a duplicate AISHE code or website domain is refused without revealing another team's
 *    pipeline (the owner is named only to someone whose scope includes the existing lead);
 *  - a removed contact keeps no name, email or phone (the database CHECK, and every removal path);
 *  - a leaver's open leads become unowned in the same transaction that ends (or suspends) them;
 *  - a contact's permission basis is required (API and database).
 * Also: masking and the audited reveal, first-claim-wins, do-not-contact, the 24-month retention
 * sweep, the Privacy console lookup and erasure, the growth admin's routes, the growth person's
 * export section, and 403/404 for every caller who must not pass.
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
import { sweepGrowthLeadContactRetention } from '@planthepath/persistence/src/growth-leads.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { assembleCoverageSections } from './privacy-export-sections.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for growth lead tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Growth lead tests require local Postgres');
const schemaName = 'growth_leads_' + randomUUID().replaceAll('-', '');
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
let execA: Person;
let execB: Person;
let execEmployer: Person;

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
  await team(manager, 'EMPLOYER_PARTNERSHIPS');
  await assign(karnataka, manager, 'MANAGER');
  execA = await member('GROWTH_EXECUTIVE');
  await team(execA, 'COLLEGE_PARTNERSHIPS', manager);
  await assign(karnataka, execA, 'EXECUTIVE');
  execB = await member('GROWTH_EXECUTIVE');
  await team(execB, 'COLLEGE_PARTNERSHIPS');
  await assign(tamilNadu, execB, 'EXECUTIVE');
  execEmployer = await member('GROWTH_EXECUTIVE');
  await team(execEmployer, 'EMPLOYER_PARTNERSHIPS', manager);
  await assign(karnataka, execEmployer, 'EXECUTIVE');
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
const auth = (subject: string) => ({ Authorization: 'Bearer ' + subject, 'X-Correlation-Id': 'growth-leads-' + randomUUID() });
const leads = '/api/v1/growth/leads';
const opsLeads = '/api/v1/operations/growth-leads';
const privacy = '/api/v1/operations/privacy/growth-contacts';
const unique = () => randomUUID().slice(0, 6);
const aishe = () => 'C-' + String(Math.floor(Math.random() * 90_000_000) + 10_000_000);

function createCollege(person: Person, overrides: Record<string, unknown> = {}) {
  return api().post(leads).set(auth(person.userId)).send({ kind: 'COLLEGE', name: 'College ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT', ...overrides });
}

const contact = (overrides: Record<string, unknown> = {}) => ({
  role: 'PRINCIPAL', fullName: 'Dr Asha Rao', email: `principal.${unique()}@college.example`, phone: '+91 98450 12345',
  permissionBasis: 'PROVIDED_BY_PERSON', source: 'BUSINESS_CARD', noticeGiven: true, ...overrides,
});

describe('who reaches the lead register', () => {
  it('admits only ACTIVE growth people; operators use Operations', async () => {
    await api().get(leads).set(auth(growthAdmin.userId)).expect(403);
    await api().get(leads).set(auth(superAdmin.userId)).expect(403);
    await api().get(leads).set(auth(execA.userId)).expect(200);
    const suspended = await member('GROWTH_EXECUTIVE', 'SUSPENDED');
    await api().get(leads).set(auth(suspended.userId)).expect(403);
  });

  it('keeps the Operations lead routes to GROWTH_ADMIN and the privacy routes to PRIVACY_REQUESTS', async () => {
    const plainOps = await member('OPERATIONS_ADMIN');
    await api().get(opsLeads).set(auth(plainOps.userId)).expect(403);
    await api().get(opsLeads).set(auth(manager.userId)).expect(403);
    await api().get(opsLeads).set(auth(growthAdmin.userId)).expect(200);
    await api().post(`${privacy}/lookup`).set(auth(manager.userId)).send({ email: 'x@y.example', reference: 'REQ-1' }).expect(403);
  });
});

describe('creating a lead', () => {
  it('makes the creator its owner through their matching team, and records the history', async () => {
    const created = await createCollege(execA, { aisheCode: ' c-1234 ', city: 'Mysuru' }).expect(201);
    expect(created.body.lead).toMatchObject({ kind: 'COLLEGE', aisheCode: 'C-1234', stage: 'IDENTIFIED', owner: { email: execA.email, isMe: true }, liveContacts: 0 });
    const id = created.body.lead.id as string;
    expect(created.body.lead.ownerHistory).toEqual([expect.objectContaining({ reasonCode: 'CREATED', from: null, to: execA.email })]);
    expect(created.body.lead.stageHistory).toEqual([expect.objectContaining({ from: null, to: 'IDENTIFIED' })]);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='growth.lead.created' AND resource_id=$1", [id])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.lead.created' AND aggregate_id=$1", [id])).rows[0].payload).toEqual({ leadId: id, kind: 'COLLEGE' });
  });

  it('refuses a lead whose kind the creator\'s team does not work, and an AISHE code on an employer', async () => {
    await api().post(leads).set(auth(execA.userId)).send({ kind: 'EMPLOYER', name: 'Acme', source: 'EVENT' }).expect(403)
      .expect((response) => expect(response.body.error.code).toBe('GROWTH_TEAM_MISMATCH'));
    await api().post(leads).set(auth(execEmployer.userId)).send({ kind: 'EMPLOYER', name: 'Acme', aisheCode: 'C-1', source: 'EVENT' }).expect(400);
    await createCollege(execA, { stateCode: 'IN-KA', districtCode: 99999 }).expect(404);
  });
});

describe('duplicates are refused without revealing another team\'s pipeline', () => {
  it('names the existing owner to someone who can see the lead, and nobody to anyone else', async () => {
    const code = aishe();
    const first = await createCollege(execA, { aisheCode: code }).expect(201);
    // execB works Tamil Nadu: the Karnataka lead is outside their scope.
    const outsider = await createCollege(execB, { aisheCode: code, stateCode: 'IN-TN' }).expect(409);
    expect(outsider.body.error).toMatchObject({ code: 'GROWTH_LEAD_DUPLICATE', existing: null, detail: 'Already registered by another team member — ask your manager.' });
    expect(JSON.stringify(outsider.body)).not.toContain(execA.email);
    expect(JSON.stringify(outsider.body)).not.toContain(first.body.lead.id);
    // The Karnataka manager can see it, so is told whose it is.
    const insider = await createCollege(manager, { aisheCode: code }).expect(409);
    expect(insider.body.error).toMatchObject({ code: 'GROWTH_LEAD_DUPLICATE', existing: { leadId: first.body.lead.id, owner: { email: execA.email } } });
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_leads WHERE aishe_code=$1', [code])).rows[0].n).toBe(1);
  });

  it('treats website forms of one employer as one domain, and refuses an employer already on ONE', async () => {
    const host = `acme-${unique()}.example`;
    await api().post(leads).set(auth(execEmployer.userId)).send({ kind: 'EMPLOYER', name: 'Acme', websiteDomain: `https://www.${host}/careers`, stateCode: 'IN-KA', source: 'EVENT' }).expect(201);
    await api().post(leads).set(auth(manager.userId)).send({ kind: 'EMPLOYER', name: 'Acme Ltd', websiteDomain: host.toUpperCase(), source: 'EVENT' }).expect(409)
      .expect((response) => expect(response.body.error.code).toBe('GROWTH_LEAD_DUPLICATE'));
    const employer = randomUUID();
    const onOne = `onone-${unique()}.example`;
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER','On ONE Ltd')", [employer]);
    await pool.query("INSERT INTO organization_profiles (organization_id,website_url,country_code) VALUES ($1,$2,'IN')", [employer, `https://www.${onOne}/about`]);
    await api().post(leads).set(auth(execEmployer.userId)).send({ kind: 'EMPLOYER', name: 'On ONE', websiteDomain: onOne, source: 'EVENT' }).expect(409)
      .expect((response) => expect(response.body.error.code).toBe('GROWTH_ORGANIZATION_ALREADY_ON_ONE'));
  });

  it('lets the database decide a race on the same AISHE code', async () => {
    const code = aishe();
    const results = await Promise.all([createCollege(execA, { aisheCode: code }), createCollege(manager, { aisheCode: code })]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it('flags a same-name lead in the same district as a possible duplicate, without refusing it', async () => {
    await pool.query("INSERT INTO growth_district_imports (id,filename,file_digest,row_count,created_count,renamed_count,unchanged_count,reason_code,imported_by_user_id) VALUES ($1,'x.csv',$2,1,1,0,0,'INITIAL_IMPORT',$3)",
      [randomUUID(), 'a'.repeat(64), growthAdmin.userId]).catch(() => undefined);
    const importId = (await pool.query('SELECT id FROM growth_district_imports LIMIT 1')).rows[0].id as string;
    await pool.query("INSERT INTO growth_districts (lgd_code,state_code,name,created_import_id) VALUES (556,'IN-KA','Mysuru',$1) ON CONFLICT DO NOTHING", [importId]);
    const name = 'St Philomena ' + unique();
    const first = await createCollege(execA, { name, districtCode: 556 }).expect(201);
    expect(first.body.lead.possibleDuplicate).toBe(false);
    const second = await createCollege(manager, { name: name.toUpperCase() + '.', districtCode: 556 }).expect(201);
    expect(second.body.lead.possibleDuplicate).toBe(true);
  });
});

describe('contacts', () => {
  it('requires a permission basis, and a source that fits it (API and database)', async () => {
    const lead = (await createCollege(execA).expect(201)).body.lead;
    const { permissionBasis: _omit, ...withoutBasis } = contact();
    await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(withoutBasis).expect(400)
      .expect((response) => expect(response.body.error.code).toBe('GROWTH_CONTACT_BASIS_REQUIRED'));
    await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(contact({ permissionBasis: 'PURCHASED_LIST' })).expect(400);
    await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(contact({ permissionBasis: 'PROVIDED_BY_PERSON', source: 'OFFICIAL_WEBSITE' })).expect(400);
    await expect(pool.query(
      "INSERT INTO growth_lead_contacts (id,lead_id,contact_role,full_name,email,permission_basis,source,added_by_user_id) VALUES ($1,$2,'HR','X','x@y.example',NULL,'MEETING',$3)",
      [randomUUID(), lead.id, execA.userId],
    )).rejects.toThrow(/permission_basis/);
    await expect(pool.query(
      "INSERT INTO growth_lead_contacts (id,lead_id,contact_role,full_name,email,permission_basis,source,added_by_user_id) VALUES ($1,$2,'HR','X','x@y.example','PROVIDED_BY_PERSON','OFFICIAL_WEBSITE',$3)",
      [randomUUID(), lead.id, execA.userId],
    )).rejects.toThrow(/growth_lead_contact_basis_ck/);
  });

  it('shows the owner their contacts in full, everyone else masked, and audits a reveal', async () => {
    const lead = (await createCollege(execA).expect(201)).body.lead;
    const details = contact();
    const added = await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(details).expect(201);
    const mine = added.body.lead.contacts[0];
    expect(mine).toMatchObject({ fullName: 'Dr Asha Rao', email: details.email, phone: details.phone, masked: false, notice: { version: 'draft-2026-10' } });
    const seen = await api().get(`${leads}/${lead.id}`).set(auth(manager.userId)).expect(200);
    expect(seen.body.lead.contacts[0]).toMatchObject({ fullName: 'Dr Asha Rao', email: 'p***@college.example', phone: '***2345', masked: true });
    expect(JSON.stringify(seen.body)).not.toContain(details.email);
    await api().post(`${leads}/${lead.id}/contacts/${mine.id}/reveal`).set(auth(manager.userId)).send({ reasonCode: 'BECAUSE' }).expect(400);
    const revealed = await api().post(`${leads}/${lead.id}/contacts/${mine.id}/reveal`).set(auth(manager.userId)).send({ reasonCode: 'MANAGER_REVIEW' }).expect(201);
    expect(revealed.body.contact).toMatchObject({ email: details.email, phone: details.phone });
    const audit = (await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='growth.lead_contact.revealed' AND resource_id=$1", [mine.id])).rows;
    expect(audit).toEqual([{ actor_user_id: manager.userId, context: expect.objectContaining({ reasonCode: 'MANAGER_REVIEW', fields: ['email', 'phone'] }) }]);
    expect(JSON.stringify(audit)).not.toContain(details.email);
    // Someone outside the lead's scope cannot read, reveal or write it: 404, so it is not disclosed.
    await api().get(`${leads}/${lead.id}`).set(auth(execB.userId)).expect(404);
    await api().post(`${leads}/${lead.id}/contacts/${mine.id}/reveal`).set(auth(execB.userId)).send({ reasonCode: 'MANAGER_REVIEW' }).expect(404);
    // Only the owner adds contacts.
    await api().post(`${leads}/${lead.id}/contacts`).set(auth(manager.userId)).send(contact()).expect(403);
  });

  it('records the notice once, and the contact-added audit holds no personal details', async () => {
    const lead = (await createCollege(execA).expect(201)).body.lead;
    const added = await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(contact({ noticeGiven: false, phone: null })).expect(201);
    const id = added.body.lead.contacts[0].id as string;
    expect(added.body.lead.contacts[0].notice).toBeNull();
    await api().post(`${leads}/${lead.id}/contacts/${id}/notice`).set(auth(execA.userId)).expect(201);
    await api().post(`${leads}/${lead.id}/contacts/${id}/notice`).set(auth(execA.userId)).expect(409);
    const audit = (await pool.query("SELECT context FROM audit_events WHERE action='growth.lead_contact.added' AND resource_id=$1", [id])).rows[0].context;
    expect(audit).toEqual({ leadId: lead.id, role: 'PRINCIPAL', permissionBasis: 'PROVIDED_BY_PERSON', source: 'BUSINESS_CARD', noticeGiven: false });
  });

  it('keeps no name, email or phone on a removed contact: the CHECK refuses anything else', async () => {
    const lead = (await createCollege(execA).expect(201)).body.lead;
    const added = await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(contact()).expect(201);
    const id = added.body.lead.contacts[0].id as string;
    await expect(pool.query("UPDATE growth_lead_contacts SET removed_at=now(), removed_by_user_id=$2, removed_reason_code='OWNER_REMOVED' WHERE id=$1", [id, execA.userId]))
      .rejects.toThrow(/growth_lead_contact_state_ck/);
    await expect(pool.query("UPDATE growth_lead_contacts SET removed_at=now(), removed_by_user_id=$2, removed_reason_code='OWNER_REMOVED', full_name=NULL, email=NULL WHERE id=$1", [id, execA.userId]))
      .rejects.toThrow(/growth_lead_contact_state_ck/);
    await expect(pool.query("UPDATE growth_lead_contacts SET full_name='Someone else' WHERE id=$1", [id])).rejects.toThrow(/only have its notice recorded or be removed/);
    await expect(pool.query('DELETE FROM growth_lead_contacts WHERE id=$1', [id])).rejects.toThrow(/never deleted/);
    await api().post(`${leads}/${lead.id}/contacts/${id}/remove`).set(auth(execA.userId)).send({ reasonCode: 'LEFT_ORGANISATION' }).expect(201);
    expect((await pool.query('SELECT full_name, email, phone, phone_digits, removed_reason_code FROM growth_lead_contacts WHERE id=$1', [id])).rows[0])
      .toEqual({ full_name: null, email: null, phone: null, phone_digits: '', removed_reason_code: 'LEFT_ORGANISATION' });
    await expect(pool.query("UPDATE growth_lead_contacts SET full_name='Back' WHERE id=$1", [id])).rejects.toThrow(/removed contact cannot be changed/);
  });

  it('caps live contacts at ten per lead', async () => {
    const lead = (await createCollege(execA).expect(201)).body.lead;
    for (let index = 0; index < 10; index += 1) await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(contact({ phone: null })).expect(201);
    await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(contact({ phone: null })).expect(409)
      .expect((response) => expect(response.body.error.code).toBe('GROWTH_CONTACT_LIMIT_REACHED'));
  });
});

describe('ownership', () => {
  it('lets the first of two concurrent claims win', async () => {
    const id = (await createCollege(manager).expect(201)).body.lead.id as string;
    await api().post(`${opsLeads}/${id}/reassign`).set(auth(growthAdmin.userId)).send({ toMembershipId: null, reasonCode: 'CORRECTION' }).expect(201);
    const second = await member('GROWTH_EXECUTIVE');
    await team(second, 'COLLEGE_PARTNERSHIPS');
    await assign(karnataka, second, 'EXECUTIVE');
    const results = await Promise.all([api().post(`${leads}/${id}/claim`).set(auth(execA.userId)), api().post(`${leads}/${id}/claim`).set(auth(second.userId))]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await pool.query("SELECT count(*)::int AS n FROM growth_lead_owner_history WHERE lead_id=$1 AND reason_code='CLAIMED'", [id])).rows[0].n).toBe(1);
    // An executive outside the region cannot even see it to claim.
    await api().post(`${leads}/${id}/claim`).set(auth(execB.userId)).expect(404);
  });

  it('lets a manager reassign within their region with a reason, and refuses an executive', async () => {
    const id = (await createCollege(execA).expect(201)).body.lead.id as string;
    await api().post(`${leads}/${id}/reassign`).set(auth(execA.userId)).send({ toMembershipId: manager.membershipId, reasonCode: 'WORKLOAD' }).expect(403);
    const options = await api().get(`${leads}/${id}/reassign-options`).set(auth(manager.userId)).expect(200);
    expect(options.body.options.map((option: { email: string }) => option.email)).toEqual(expect.arrayContaining([execA.email, manager.email]));
    await api().post(`${leads}/${id}/reassign`).set(auth(manager.userId)).send({ toMembershipId: execEmployer.membershipId, reasonCode: 'WORKLOAD' }).expect(400)
      .expect((response) => expect(response.body.error.code).toBe('GROWTH_REASSIGN_TARGET_INVALID'));
    await api().post(`${leads}/${id}/reassign`).set(auth(manager.userId)).send({ toMembershipId: manager.membershipId, reasonCode: 'WORKLOAD' }).expect(201);
    const history = (await pool.query('SELECT reason_code, actor_user_id FROM growth_lead_owner_history WHERE lead_id=$1 ORDER BY occurred_at, id', [id])).rows;
    expect(history).toEqual([{ reason_code: 'CREATED', actor_user_id: execA.userId }, { reason_code: 'WORKLOAD', actor_user_id: manager.userId }]);
    await expect(pool.query("UPDATE growth_lead_owner_history SET reason_code='CORRECTION' WHERE lead_id=$1", [id])).rejects.toThrow(/append-only/);
  });

  it('releases a leaver\'s open leads in the same transaction that ends their membership, and keeps lost ones', async () => {
    const leaver = await member('GROWTH_EXECUTIVE');
    await team(leaver, 'COLLEGE_PARTNERSHIPS', manager);
    await assign(karnataka, leaver, 'EXECUTIVE');
    const open1 = (await createCollege(leaver).expect(201)).body.lead.id as string;
    const open2 = (await createCollege(leaver).expect(201)).body.lead.id as string;
    const lost = (await createCollege(leaver).expect(201)).body.lead.id as string;
    await pool.query("UPDATE growth_leads SET stage='LOST', lost_reason_code='NO_RESPONSE' WHERE id=$1", [lost]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE organization_memberships SET state='ENDED' WHERE id=$1", [leaver.membershipId]);
      // Inside the same transaction, before it commits, the leads are already released.
      const inside = (await client.query('SELECT id, owner_membership_id FROM growth_leads WHERE id = ANY($1) ORDER BY id', [[open1, open2, lost]])).rows;
      expect(inside.filter((row) => row.owner_membership_id === null).map((row) => row.id).sort()).toEqual([open1, open2].sort());
      expect(inside.find((row) => row.id === lost)!.owner_membership_id).toBe(leaver.membershipId);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const history = (await pool.query("SELECT lead_id, actor_user_id FROM growth_lead_owner_history WHERE reason_code='OWNER_LEFT' AND from_membership_id=$1", [leaver.membershipId])).rows;
    expect(history.map((row) => row.lead_id).sort()).toEqual([open1, open2].sort());
    expect(history.every((row) => row.actor_user_id === null)).toBe(true);
    // The region manager sees them in "needs a new owner".
    const needs = await api().get(leads).query({ view: 'NEEDS_OWNER' }).set(auth(manager.userId)).expect(200);
    expect(needs.body.leads.map((lead: { id: string }) => lead.id)).toEqual(expect.arrayContaining([open1, open2]));
    expect(needs.body.leads.find((lead: { id: string }) => lead.id === open1)).toMatchObject({ owner: null, needsNewOwner: true });
  });

  it('releases a suspended person\'s open leads too (an access-review revocation suspends)', async () => {
    const person = await member('GROWTH_EXECUTIVE');
    await team(person, 'COLLEGE_PARTNERSHIPS');
    const id = (await createCollege(person).expect(201)).body.lead.id as string;
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [person.membershipId]);
    expect((await pool.query('SELECT owner_membership_id FROM growth_leads WHERE id=$1', [id])).rows[0].owner_membership_id).toBeNull();
  });
});

describe('do-not-contact', () => {
  it('freezes the lead for outreach and refuses the same organisation again', async () => {
    const code = aishe();
    const lead = (await createCollege(execA, { aisheCode: code }).expect(201)).body.lead;
    await api().post(`${leads}/${lead.id}/do-not-contact`).set(auth(execA.userId)).send({ reasonCode: 'ORGANISATION_DECLINED' }).expect(201);
    await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(contact()).expect(409);
    await expect(pool.query(
      "INSERT INTO growth_lead_contacts (id,lead_id,contact_role,full_name,email,permission_basis,source,added_by_user_id) VALUES ($1,$2,'HR','X','x@y.example','PROVIDED_BY_PERSON','MEETING',$3)",
      [randomUUID(), lead.id, execA.userId],
    )).rejects.toThrow(/do-not-contact/);
    await api().post(`${leads}/${lead.id}/reassign`).set(auth(manager.userId)).send({ toMembershipId: manager.membershipId, reasonCode: 'WORKLOAD' }).expect(409);
    await createCollege(manager, { aisheCode: code }).expect(409).expect((response) => expect(response.body.error.code).toBe('GROWTH_LEAD_DO_NOT_CONTACT'));
    await expect(pool.query('UPDATE growth_leads SET do_not_contact_at=NULL, do_not_contact_reason=NULL, do_not_contact_by_user_id=NULL WHERE id=$1', [lead.id]))
      .rejects.toThrow(/set once and never cleared/);
    await expect(pool.query('DELETE FROM growth_leads WHERE id=$1', [lead.id])).rejects.toThrow(/never deleted/);
  });
});

describe('retention: 24 months after the last activity (D12)', () => {
  it('erases contacts of leads quiet for 24 months, keeps the lead, skips handed-off leads, and is idempotent', async () => {
    const quiet = (await createCollege(execA).expect(201)).body.lead.id as string;
    const recent = (await createCollege(execA).expect(201)).body.lead.id as string;
    const handedOff = (await createCollege(execA).expect(201)).body.lead.id as string;
    for (const id of [quiet, recent, handedOff]) await api().post(`${leads}/${id}/contacts`).set(auth(execA.userId)).send(contact()).expect(201);
    const institution = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Handed off college')", [institution]);
    // GROWTH-04: a college lead names an organisation only through a linked handoff request (0104), so the
    // fixture hands it off that way. Contacts are left in place here on purpose: this spec checks the sweep.
    const handoff = randomUUID();
    await pool.query(`INSERT INTO growth_handoff_requests (id, lead_id, requested_by_user_id, requested_by_membership_id, contract_reference_reported)
      VALUES ($1,$2,$3,$4,'AGR-FIXTURE')`, [handoff, handedOff, execA.userId, execA.membershipId]);
    await pool.query(`UPDATE growth_handoff_requests SET state='LINKED', decided_by_user_id=$2, organization_id=$3, contacts_carried=0, contacts_erased=0
      WHERE id=$1`, [handoff, growthAdmin.userId, institution]);
    await pool.query('UPDATE growth_leads SET organization_id=$2 WHERE id=$1', [handedOff, institution]);
    await pool.query("UPDATE growth_leads SET last_activity_at = now() - interval '24 months 1 day' WHERE id = ANY($1)", [[quiet, handedOff]]);
    await pool.query("UPDATE growth_leads SET last_activity_at = now() - interval '23 months' WHERE id=$1", [recent]);

    let total = 0;
    for (let batch = await sweepGrowthLeadContactRetention(db); batch.contacts > 0; batch = await sweepGrowthLeadContactRetention(db)) total += batch.contacts;
    expect(total).toBe(1);
    const rows = (await pool.query('SELECT lead_id, full_name, email, phone, removed_reason_code, removed_by_user_id FROM growth_lead_contacts WHERE lead_id = ANY($1)', [[quiet, recent, handedOff]])).rows;
    expect(rows.find((row) => row.lead_id === quiet)).toEqual({ lead_id: quiet, full_name: null, email: null, phone: null, removed_reason_code: 'RETENTION_EXPIRED', removed_by_user_id: null });
    expect(rows.find((row) => row.lead_id === recent)!.full_name).toBe('Dr Asha Rao');
    expect(rows.find((row) => row.lead_id === handedOff)!.full_name).toBe('Dr Asha Rao');
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_leads WHERE id=$1', [quiet])).rows[0].n).toBe(1);
    expect(await sweepGrowthLeadContactRetention(db)).toEqual({ leads: 0, contacts: 0 });
  });
});

describe('the Privacy console: a contact\'s access and erasure requests', () => {
  it('finds every row holding an email or phone, audits by reference and hash, and erases on request', async () => {
    const email = `trustee.${unique()}@college.example`;
    const lead1 = (await createCollege(execA).expect(201)).body.lead.id as string;
    const lead2 = (await createCollege(execA).expect(201)).body.lead.id as string;
    await api().post(`${leads}/${lead1}/contacts`).set(auth(execA.userId)).send(contact({ email, phone: '+91 99000 11122', role: 'CHAIRMAN_OR_TRUSTEE' })).expect(201);
    await api().post(`${leads}/${lead2}/contacts`).set(auth(execA.userId)).send(contact({ email: null, phone: '099000 11122' })).expect(201);

    await api().post(`${privacy}/lookup`).set(auth(superAdmin.userId)).send({ email }).expect(400);
    const byEmail = await api().post(`${privacy}/lookup`).set(auth(superAdmin.userId)).send({ email: email.toUpperCase(), reference: 'PRQ-2026-001' }).expect(201);
    expect(byEmail.body.matches).toEqual([expect.objectContaining({ leadId: lead1, contactRole: 'CHAIRMAN_OR_TRUSTEE', email, permissionBasis: 'PROVIDED_BY_PERSON', source: 'BUSINESS_CARD', noticeVersion: 'draft-2026-10', removedAt: null })]);
    const byPhone = await api().post(`${privacy}/lookup`).set(auth(superAdmin.userId)).send({ phone: '9900011122', reference: 'PRQ-2026-001' }).expect(201);
    expect(byPhone.body.matches.map((match: { leadId: string }) => match.leadId).sort()).toEqual([lead1, lead2].sort());
    const audit = (await pool.query("SELECT context FROM audit_events WHERE action='operations.growth_contacts.looked_up' AND resource_id='PRQ-2026-001'")).rows;
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(email);
    expect(JSON.stringify(audit)).not.toContain('9900011122');

    const erased = await api().post(`${privacy}/erase`).set(auth(superAdmin.userId)).send({ phone: '+91 99000 11122', reference: 'PRQ-2026-001', doNotContact: true }).expect(201);
    expect(erased.body).toMatchObject({ removed: 2, doNotContactLeads: 2 });
    const after = (await pool.query("SELECT full_name, email, phone, removed_reason_code FROM growth_lead_contacts WHERE lead_id = ANY($1)", [[lead1, lead2]])).rows;
    expect(after.every((row) => row.full_name === null && row.email === null && row.phone === null && row.removed_reason_code === 'PRIVACY_REQUEST')).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_leads WHERE id = ANY($1) AND do_not_contact_reason = $2', [[lead1, lead2], 'PERSON_REQUEST'])).rows[0].n).toBe(2);
    // The lookup now answers that the rows exist but hold nothing.
    const again = await api().post(`${privacy}/lookup`).set(auth(superAdmin.userId)).send({ email, reference: 'PRQ-2026-001' }).expect(201);
    expect(again.body.matches).toEqual([]);
    await api().post(`${leads}/${lead1}/contacts`).set(auth(execA.userId)).send(contact({ email })).expect(409);
  });
});

describe('the growth admin in Operations', () => {
  it('lists every region\'s leads masked, reassigns anywhere with a reason, and never to their own growth membership', async () => {
    const lead = (await createCollege(execA).expect(201)).body.lead;
    await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(contact()).expect(201);
    const listed = await api().get(opsLeads).query({ kind: 'COLLEGE' }).set(auth(growthAdmin.userId)).expect(200);
    expect(listed.body.leads.length).toBeGreaterThan(0);
    const detail = await api().get(`${opsLeads}/${lead.id}`).set(auth(growthAdmin.userId)).expect(200);
    expect(detail.body.lead.contacts[0].masked).toBe(true);
    await api().post(`${opsLeads}/${lead.id}/reassign`).set(auth(growthAdmin.userId)).send({ toMembershipId: execB.membershipId, reasonCode: 'NOPE' }).expect(400);
    await api().post(`${opsLeads}/${lead.id}/reassign`).set(auth(growthAdmin.userId)).send({ toMembershipId: execB.membershipId, reasonCode: 'TERRITORY_CHANGE' }).expect(201);
    expect((await pool.query('SELECT owner_membership_id FROM growth_leads WHERE id=$1', [lead.id])).rows[0].owner_membership_id).toBe(execB.membershipId);
    // execB now owns it although it is in Karnataka: an owner sees their own lead anywhere.
    await api().get(`${leads}/${lead.id}`).set(auth(execB.userId)).expect(200);
    // The previous owner, an executive, no longer sees an owned lead of someone else.
    await api().get(`${leads}/${lead.id}`).set(auth(execA.userId)).expect(404);
  });
});

describe('the growth person\'s own counts and export', () => {
  it('counts open owned leads on /me and unowned leads per region on /territory', async () => {
    const counter = await member('GROWTH_EXECUTIVE');
    await team(counter, 'COLLEGE_PARTNERSHIPS');
    await assign(tamilNadu, counter, 'EXECUTIVE');
    await createCollege(counter, { stateCode: 'IN-TN' }).expect(201);
    const before = (await api().get('/api/v1/growth/territory').set(auth(counter.userId)).expect(200)).body.regions[0].unownedLeads as number;
    const unowned = (await createCollege(execB, { stateCode: 'IN-TN' }).expect(201)).body.lead.id as string;
    await api().post(`${opsLeads}/${unowned}/reassign`).set(auth(growthAdmin.userId)).send({ toMembershipId: null, reasonCode: 'CORRECTION' }).expect(201);
    expect((await api().get('/api/v1/growth/me').set(auth(counter.userId)).expect(200)).body.openLeads).toBe(1);
    expect((await api().get('/api/v1/growth/territory').set(auth(counter.userId)).expect(200)).body.regions[0].unownedLeads).toBe(before + 1);
  });

  it('exports a growth person\'s own work, never a contact\'s details', async () => {
    const lead = (await createCollege(execA, { name: 'Export College ' + unique() }).expect(201)).body.lead;
    const details = contact();
    await api().post(`${leads}/${lead.id}/contacts`).set(auth(execA.userId)).send(details).expect(201);
    const sections = await assembleCoverageSections(async (query) => ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows, execA.userId);
    const growthWork = sections.growthWork as { leads: { organisation: string }[]; territory: { region: string }[]; teams: unknown[] };
    expect(growthWork.leads.map((row) => row.organisation)).toContain(lead.name);
    expect(growthWork.territory.map((row) => row.region)).toContain('South-KA');
    expect(growthWork.teams.length).toBeGreaterThan(0);
    expect(JSON.stringify(growthWork)).not.toContain(details.email);
    expect(JSON.stringify(growthWork)).not.toContain('Dr Asha Rao');
  });
});
