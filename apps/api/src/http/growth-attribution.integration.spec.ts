/**
 * Attribution, disputes, reassignment and leavers (GROWTH-07; growth-attribution-table-design.md).
 *
 * The acceptance criteria this file carries:
 *  - one live attribution per organisation (the unique index, and the guard that a row is only ever ended);
 *  - a conflicting referral and lead owner writes no attribution and opens a dispute;
 *  - a disputant cannot decide their own dispute (route and CHECK), on either side;
 *  - an operator attributed to an employer cannot verify it (route and trigger); another operator can.
 * Also: credit at the college link and the employer onboarding (first handoff only, house writes nothing),
 * the 90-day claim window (API and database clock), who may claim, what each party sees, decisions and
 * their effective dates, reassignment and ending with reasons, leave dates, the self-dealing guard on
 * linking and onboarding, access, events, audit and the privacy export. No amount appears anywhere.
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
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { assembleCoverageSections } from './privacy-export-sections.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for growth attribution tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Growth attribution tests require local Postgres');
const schemaName = 'growth_attribution_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

const identities = new Map<string, { readonly email: string }>();
let app: INestApplication;
let platformId: string;
let superAdmin: Person;
let adminA: Person;
let adminB: Person;
let securityAdmin: Person;
let karnataka: string;
let manager: Person;
let execA: Person;
let execB: Person;
let outsider: Person;
/** One person who is both an operator (OPERATIONS_ADMIN with GROWTH_ADMIN) and a growth executive on both teams. */
let dual: Person & { readonly growthMembershipId: string };

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
  adminA = await member('OPERATIONS_ADMIN');
  await grant(adminA, 'GROWTH_ADMIN');
  adminB = await member('OPERATIONS_ADMIN');
  await grant(adminB, 'GROWTH_ADMIN');
  securityAdmin = await member('SECURITY_ADMIN');
  karnataka = await region('South-KA', 'IN-KA');
  manager = await member('GROWTH_MANAGER');
  await team(manager.membershipId, 'COLLEGE_PARTNERSHIPS');
  await team(manager.membershipId, 'EMPLOYER_PARTNERSHIPS');
  await assign(karnataka, manager.membershipId, 'MANAGER');
  execA = await growthExec(['COLLEGE_PARTNERSHIPS']);
  execB = await growthExec(['COLLEGE_PARTNERSHIPS']);
  outsider = await growthExec(['COLLEGE_PARTNERSHIPS']);
  const operator = await member('OPERATIONS_ADMIN');
  await grant(operator, 'GROWTH_ADMIN');
  const growthMembershipId = await alsoMember(operator, 'GROWTH_EXECUTIVE');
  await team(growthMembershipId, 'COLLEGE_PARTNERSHIPS', manager);
  await team(growthMembershipId, 'EMPLOYER_PARTNERSHIPS', manager);
  await assign(karnataka, growthMembershipId, 'EXECUTIVE');
  dual = { ...operator, growthMembershipId };
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

async function alsoMember(person: Person, role: string): Promise<string> {
  const membershipId = randomUUID();
  await pool.query("INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,'ACTIVE',$2)",
    [membershipId, platformId, person.userId, role]);
  return membershipId;
}

async function grant(person: Person, capability: string): Promise<void> {
  await pool.query("INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_RESPONSIBILITY')",
    [randomUUID(), person.membershipId, capability, superAdmin.userId]);
}

async function team(membershipId: string, name: string, reportsTo: Person | null = null): Promise<void> {
  await pool.query("INSERT INTO growth_team_members (id,membership_id,team,manager_membership_id,joined_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_MEMBER')",
    [randomUUID(), membershipId, name, reportsTo?.membershipId ?? null, superAdmin.userId]);
}

async function region(name: string, stateCode: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO growth_regions (id,name,created_by_user_id,reason_code) VALUES ($1,$2,$3,'NEW_REGION')", [id, name, superAdmin.userId]);
  await pool.query("INSERT INTO growth_region_areas (id,region_id,state_code,added_by_user_id,reason_code) VALUES ($1,$2,$3,$4,'NEW_COVERAGE')", [randomUUID(), id, stateCode, superAdmin.userId]);
  return id;
}

async function assign(regionId: string, membershipId: string, role: 'EXECUTIVE' | 'MANAGER'): Promise<void> {
  await pool.query("INSERT INTO growth_territory_assignments (id,region_id,membership_id,assignment_role,assigned_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_ASSIGNMENT')",
    [randomUUID(), regionId, membershipId, role, superAdmin.userId]);
}

async function growthExec(teams: readonly string[]): Promise<Person> {
  const person = await member('GROWTH_EXECUTIVE');
  for (const name of teams) await team(person.membershipId, name, manager);
  await assign(karnataka, person.membershipId, 'EXECUTIVE');
  return person;
}

const api = () => request(app.getHttpServer());
const auth = (subject: string) => ({ Authorization: 'Bearer ' + subject, 'X-Correlation-Id': 'growth-attribution-' + randomUUID() });
const unique = () => randomUUID().slice(0, 8);
const leads = '/api/v1/growth/leads';
const handoffs = '/api/v1/operations/growth-handoffs';
const mine = '/api/v1/growth/attributions';
const claims = '/api/v1/growth/attribution-disputes';
const admin = '/api/v1/operations/growth-attribution';

async function collegeLead(person: Person): Promise<string> {
  const created = await api().post(leads).set(auth(person.userId)).send({ kind: 'COLLEGE', name: 'College ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT' }).expect(201);
  return created.body.lead.id as string;
}

async function requestHandoff(person: Person, leadId: string): Promise<void> {
  await api().post(`${leads}/${leadId}/stage`).set(auth(person.userId)).send({ fromStage: 'IDENTIFIED', toStage: 'AGREEMENT_SIGNED_REPORTED' }).expect(201);
  await api().post(`${leads}/${leadId}/handoff`).set(auth(person.userId)).send({ contractReference: 'AGR/2026-' + unique(), contactIds: [] }).expect(201);
}

async function organization(kind: 'INSTITUTION' | 'EMPLOYER'): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO organizations (id,kind,legal_name) VALUES ($1,$2,$3)', [id, kind, `${kind === 'INSTITUTION' ? 'College' : 'Employer'} ${unique()}`]);
  return id;
}

/** A college lead worked by `owner` (created by `creator`, reassigned by the manager when they differ), handed off and linked. */
async function collegeHandoff(owner: Person, options: { readonly creator?: Person; readonly linker?: Person } = {}): Promise<{ readonly leadId: string; readonly orgId: string }> {
  const creator = options.creator ?? owner;
  const leadId = await collegeLead(creator);
  if (creator.userId !== owner.userId) {
    const ownerMembership = owner.userId === dual.userId ? dual.growthMembershipId : owner.membershipId;
    await api().post(`${leads}/${leadId}/reassign`).set(auth(manager.userId)).send({ toMembershipId: ownerMembership, reasonCode: 'WORKLOAD' }).expect(201);
  }
  await requestHandoff(owner, leadId);
  const orgId = await organization('INSTITUTION');
  await api().post(`${handoffs}/${leadId}/link`).set(auth((options.linker ?? adminA).userId)).send({ organizationId: orgId }).expect(201);
  return { leadId, orgId };
}

let addressCounter = 1;
const nextAddress = () => `203.0.${Math.floor(addressCounter / 250) % 250}.${(addressCounter++ % 250) + 1}`;

/** A public access request, optionally through `referrer`'s link and matching `leadOwner`'s employer lead. */
async function accessRequest(options: { readonly referrer?: Person; readonly leadOwner?: Person }): Promise<{ readonly requestId: string; readonly leadId: string | null }> {
  const domain = 'firm-' + unique() + '.example';
  let ref: string | undefined;
  if (options.referrer) {
    const created = await api().post('/api/v1/growth/referral-codes').set(auth(options.referrer.userId)).send({}).expect(201);
    ref = created.body.code.code as string;
  }
  let leadId: string | null = null;
  if (options.leadOwner) {
    const created = await api().post(leads).set(auth(options.leadOwner.userId))
      .send({ kind: 'EMPLOYER', name: 'Employer ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT', websiteDomain: domain }).expect(201);
    leadId = created.body.lead.id as string;
  }
  await api().post('/api/v1/employer-access-requests').set('X-Forwarded-For', nextAddress())
    .send({ requesterName: 'Asha Rao', companyName: 'Firm ' + domain, workEmail: 'asha@' + domain, websiteUrl: 'https://www.' + domain, ...(ref ? { ref } : {}) }).expect(202);
  const requestId = (await pool.query('SELECT id FROM employer_access_requests WHERE work_email=$1', ['asha@' + domain])).rows[0].id as string;
  return { requestId, leadId };
}

const onboard = (requestId: string, organizationId: string, as: Person = adminA) =>
  api().post(`/api/v1/operations/employer-access-requests/${requestId}/decision`).set(auth(as.userId))
    .send({ decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId });

async function employerOnboarded(options: { readonly referrer?: Person; readonly leadOwner?: Person }): Promise<{ readonly requestId: string; readonly orgId: string; readonly leadId: string | null }> {
  const made = await accessRequest(options);
  const orgId = await organization('EMPLOYER');
  await onboard(made.requestId, orgId).expect(201);
  return { ...made, orgId };
}

async function attributionsOf(orgId: string): Promise<Record<string, unknown>[]> {
  return (await pool.query(`SELECT id, beneficiary_user_id, basis, reason_code, created_by_user_id, ended_at IS NOT NULL AS ended, ended_reason_code, ended_by_user_id,
    supersedes_id, dispute_id FROM growth_attributions WHERE organization_id=$1 ORDER BY created_at, id`, [orgId])).rows;
}

async function disputeOf(orgId: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query('SELECT * FROM growth_attribution_disputes WHERE organization_id=$1 ORDER BY opened_at DESC LIMIT 1', [orgId])).rows[0];
}

/** Moves an organisation's handoff (and its first attribution) back in time, as if `days` had passed. Test set-up only. */
async function age(orgId: string, days: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['growth_handoff_requests', 'growth_employer_onboardings', 'growth_attributions']) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await client.query(`UPDATE growth_handoff_requests SET decided_at = decided_at - make_interval(days => $2) WHERE organization_id=$1`, [orgId, days]);
    await client.query(`UPDATE growth_employer_onboardings SET recorded_at = recorded_at - make_interval(days => $2) WHERE organization_id=$1`, [orgId, days]);
    await client.query(`UPDATE growth_attributions SET effective_from = effective_from - make_interval(days => $2) WHERE organization_id=$1`, [orgId, days]);
    for (const table of ['growth_handoff_requests', 'growth_employer_onboardings', 'growth_attributions']) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('credit at the handoff (design §8.2, §8.3)', () => {
  it('credits the lead owner when operations link a college, audited, with an event and no amount', async () => {
    const { orgId, leadId } = await collegeHandoff(execA);
    const rows = await attributionsOf(orgId);
    expect(rows).toEqual([expect.objectContaining({ beneficiary_user_id: execA.userId, basis: 'LEAD_OWNER_AT_HANDOFF', reason_code: 'COLLEGE_HANDOFF_LINKED', created_by_user_id: adminA.userId, ended: false })]);
    const id = rows[0]!.id as string;
    expect((await pool.query('SELECT lead_id FROM growth_attributions WHERE id=$1', [id])).rows[0].lead_id).toBe(leadId);
    expect((await pool.query("SELECT actor_user_id, context->>'basis' AS basis FROM audit_events WHERE action='growth.attribution.created' AND resource_id=$1", [id])).rows)
      .toEqual([{ actor_user_id: adminA.userId, basis: 'LEAD_OWNER_AT_HANDOFF' }]);
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.attribution.created' AND aggregate_id=$1", [id])).rows)
      .toEqual([{ payload: { attributionId: id, organizationId: orgId, basis: 'LEAD_OWNER_AT_HANDOFF' } }]);
    const read = await api().get(mine).set(auth(execA.userId)).expect(200);
    const credited = (read.body.credited as Record<string, unknown>[]).find((row) => row.organizationId === orgId);
    expect(credited).toMatchObject({ basis: 'LEAD_OWNER_AT_HANDOFF', commission: 'NOT_BUILT', disputeOpen: false, endedAt: null });
    expect(JSON.stringify(read.body)).not.toMatch(/amount|paise|rate/i);
  });

  it('credits nobody when the handed-off lead had no owner (house)', async () => {
    const leaver = await growthExec(['COLLEGE_PARTNERSHIPS']);
    const leadId = await collegeLead(leaver);
    await requestHandoff(leaver, leadId);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [leaver.membershipId]);
    const orgId = await organization('INSTITUTION');
    await api().post(`${handoffs}/${leadId}/link`).set(auth(adminA.userId)).send({ organizationId: orgId }).expect(201);
    expect(await attributionsOf(orgId)).toEqual([]);
  });

  it('keeps one live attribution per organisation and only ever ends a row', async () => {
    const { orgId } = await collegeHandoff(execA);
    const [row] = await attributionsOf(orgId);
    const source = (await pool.query("SELECT id FROM growth_handoff_requests WHERE organization_id=$1 AND state='LINKED'", [orgId])).rows[0].id;
    await expect(pool.query(`INSERT INTO growth_attributions (id,organization_id,organization_kind,beneficiary_user_id,basis,reason_code,source_handoff_request_id,created_by_user_id,correlation_id)
      VALUES ($1,$2,'INSTITUTION',$3,'LEAD_OWNER_AT_HANDOFF','COLLEGE_HANDOFF_LINKED',$4,$5,'test')`, [randomUUID(), orgId, execA.userId, source, adminB.userId]))
      .rejects.toThrow(/growth_attributions_live_org_uq/);
    await expect(pool.query('UPDATE growth_attributions SET beneficiary_user_id=$2 WHERE id=$1', [row!.id, execB.userId])).rejects.toThrow(/can only be ended/);
    await expect(pool.query('DELETE FROM growth_attributions WHERE id=$1', [row!.id])).rejects.toThrow(/never deleted/);
    await expect(pool.query(`INSERT INTO growth_attributions (id,organization_id,organization_kind,beneficiary_user_id,basis,reason_code,source_handoff_request_id,created_by_user_id,correlation_id)
      VALUES ($1,$2,'INSTITUTION',$3,'LEAD_OWNER_AT_HANDOFF','COLLEGE_HANDOFF_LINKED',$4,$3,'test')`, [randomUUID(), await organization('INSTITUTION'), execA.userId, source]))
      .rejects.toThrow();
  });

  it('credits an employer to the referrer, else the lead owner; a house employer to nobody; a second onboarding writes nothing', async () => {
    const referrer = await growthExec(['EMPLOYER_PARTNERSHIPS']);
    const owner = await growthExec(['EMPLOYER_PARTNERSHIPS']);
    const referred = await employerOnboarded({ referrer });
    expect(await attributionsOf(referred.orgId)).toEqual([expect.objectContaining({ beneficiary_user_id: referrer.userId, basis: 'REFERRAL_LINK', reason_code: 'EMPLOYER_ONBOARDED' })]);
    const both = await employerOnboarded({ referrer: owner, leadOwner: owner });
    expect(await attributionsOf(both.orgId)).toEqual([expect.objectContaining({ beneficiary_user_id: owner.userId, basis: 'REFERRAL_LINK' })]);
    const owned = await employerOnboarded({ leadOwner: owner });
    expect(await attributionsOf(owned.orgId)).toEqual([expect.objectContaining({ beneficiary_user_id: owner.userId, basis: 'LEAD_OWNER_AT_HANDOFF' })]);
    const house = await employerOnboarded({});
    expect(await attributionsOf(house.orgId)).toEqual([]);
    // Another request onboarded to the same employer later, with a referral: nothing is inferred later.
    const again = await accessRequest({ referrer: await growthExec(['EMPLOYER_PARTNERSHIPS']) });
    await onboard(again.requestId, house.orgId).expect(201);
    expect(await attributionsOf(house.orgId)).toEqual([]);
    const shown = await api().get(mine).set(auth(referrer.userId)).expect(200);
    expect((shown.body.credited as Record<string, unknown>[]).find((row) => row.organizationId === referred.orgId)).toMatchObject({ commission: 'EMPLOYER_ON_HOLD' });
  });

  it('a conflicting referral and lead owner writes no attribution and opens a dispute', async () => {
    const referrer = await growthExec(['EMPLOYER_PARTNERSHIPS']);
    const owner = await growthExec(['EMPLOYER_PARTNERSHIPS']);
    const { orgId, requestId } = await employerOnboarded({ referrer, leadOwner: owner });
    expect((await pool.query('SELECT candidate_basis FROM growth_employer_onboardings WHERE access_request_id=$1', [requestId])).rows[0].candidate_basis).toBe('CONFLICT');
    expect(await attributionsOf(orgId)).toEqual([]);
    const dispute = await disputeOf(orgId);
    expect(dispute).toMatchObject({ origin: 'ONBOARDING_CONFLICT', state: 'OPEN', claimant_user_id: referrer.userId, respondent_user_id: owner.userId,
      opened_by_user_id: adminA.userId, statement: null, source_access_request_id: requestId, attribution_id: null });
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.attribution_dispute.opened' AND aggregate_id=$1", [dispute!.id])).rows)
      .toEqual([{ payload: { disputeId: dispute!.id, organizationId: orgId, origin: 'ONBOARDING_CONFLICT' } }]);
    // Both parties see it; neither sees a statement (there is none) or an amount.
    for (const party of [referrer, owner]) {
      const read = await api().get(mine).set(auth(party.userId)).expect(200);
      expect((read.body.disputes as Record<string, unknown>[]).find((row) => row.organizationId === orgId))
        .toMatchObject({ origin: 'ONBOARDING_CONFLICT', state: 'OPEN', role: party === referrer ? 'CLAIMANT' : 'RESPONDENT', statement: null });
    }
  });
});

describe('disputes (design §8.4)', () => {
  it('lets a person who worked on an organisation claim it within the window; the respondent never sees the statement', async () => {
    const { orgId } = await collegeHandoff(execA, { creator: execB });
    const eligible = await api().get(mine).set(auth(execB.userId)).expect(200);
    expect((eligible.body.disputable as Record<string, unknown>[]).find((row) => row.organizationId === orgId)).toMatchObject({ organizationKind: 'INSTITUTION', disputeOpen: false });
    expect((await api().get(mine).set(auth(execA.userId)).expect(200)).body.disputable.find((row: { organizationId: string }) => row.organizationId === orgId)).toBeUndefined();

    await api().post(claims).set(auth(execB.userId)).send({ organizationId: orgId, statement: 'x'.repeat(2001) }).expect(400);
    await api().post(claims).set(auth(outsider.userId)).send({ organizationId: orgId, statement: 'I was there.' }).expect(404)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_DISPUTE_NOT_ELIGIBLE'));
    await api().post(claims).set(auth(execA.userId)).send({ organizationId: orgId, statement: 'Mine.' }).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_ALREADY_CREDITED'));
    const opened = await api().post(claims).set(auth(execB.userId)).send({ organizationId: orgId, statement: '  I met the principal three times before the reassignment.  ' }).expect(201);
    const dispute = await disputeOf(orgId);
    expect(dispute).toMatchObject({ id: opened.body.disputeId, origin: 'CLAIM', claimant_user_id: execB.userId, respondent_user_id: execA.userId,
      statement: 'I met the principal three times before the reassignment.', state: 'OPEN' });
    const auditRow = (await pool.query("SELECT context FROM audit_events WHERE action='growth.attribution_dispute.opened' AND resource_id=$1", [dispute!.id])).rows[0];
    expect(JSON.stringify(auditRow)).not.toContain('principal');

    const claimant = (await api().get(mine).set(auth(execB.userId)).expect(200)).body.disputes.find((row: { disputeId: string }) => row.disputeId === dispute!.id);
    expect(claimant).toMatchObject({ role: 'CLAIMANT', statement: 'I met the principal three times before the reassignment.' });
    const respondent = (await api().get(mine).set(auth(execA.userId)).expect(200)).body;
    expect(respondent.disputes.find((row: { disputeId: string }) => row.disputeId === dispute!.id)).toMatchObject({ role: 'RESPONDENT', statement: null });
    expect(JSON.stringify(respondent)).not.toContain('principal three times');
    expect(respondent.credited.find((row: { organizationId: string }) => row.organizationId === orgId)).toMatchObject({ disputeOpen: true });

    // One open dispute per organisation (the route and the index).
    await api().post(claims).set(auth(manager.userId)).send({ organizationId: orgId, statement: 'Me too.' }).expect((r) => expect([404, 409]).toContain(r.status));
    await expect(pool.query(`INSERT INTO growth_attribution_disputes (id,organization_id,organization_kind,origin,attribution_id,claimant_user_id,respondent_user_id,statement,opened_by_user_id,correlation_id)
      VALUES ($1,$2,'INSTITUTION','CLAIM',$3,$4,$5,'again',$4,'test')`, [randomUUID(), orgId, dispute!.attribution_id, execB.userId, execA.userId])).rejects.toThrow(/growth_disputes_open_org_uq/);
  });

  it('refuses a claim after 90 days from the handoff, in the API and on the database clock', async () => {
    const { orgId } = await collegeHandoff(execA, { creator: execB });
    await age(orgId, 91);
    expect((await api().get(mine).set(auth(execB.userId)).expect(200)).body.disputable.find((row: { organizationId: string }) => row.organizationId === orgId)).toBeUndefined();
    await api().post(claims).set(auth(execB.userId)).send({ organizationId: orgId, statement: 'Late.' }).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_DISPUTE_WINDOW_CLOSED'));
    const live = (await attributionsOf(orgId))[0]!;
    await expect(pool.query(`INSERT INTO growth_attribution_disputes (id,organization_id,organization_kind,origin,attribution_id,claimant_user_id,respondent_user_id,statement,opened_by_user_id,correlation_id)
      VALUES ($1,$2,'INSTITUTION','CLAIM',$3,$4,$5,'late',$4,'test')`, [randomUUID(), orgId, live.id, execB.userId, execA.userId])).rejects.toThrow(/dispute window/);
  });

  it('a disputant cannot decide their own dispute, on either side, in the route or the database', async () => {
    // dual (an operator holding GROWTH_ADMIN who is also a growth executive) worked the lead, then it went to execA.
    const { orgId } = await collegeHandoff(execA, { creator: dual });
    await api().post(claims).set(auth(dual.userId)).send({ organizationId: orgId, statement: 'I opened this college.' }).expect(201);
    const dispute = (await disputeOf(orgId))!;
    await api().post(`${admin}/disputes/${dispute.id}/decide`).set(auth(dual.userId)).send({ outcome: 'UPHELD', reasonCode: 'CLAIMANT_DID_THE_WORK' }).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_SELF_DEALING_REFUSED'));
    await expect(pool.query("UPDATE growth_attribution_disputes SET state='UPHELD', decided_by_user_id=$2, decision_reason_code='CLAIMANT_DID_THE_WORK' WHERE id=$1", [dispute.id, dual.userId]))
      .rejects.toThrow(/growth_dispute_decider_ck/);
    await expect(pool.query("UPDATE growth_attribution_disputes SET state='REJECTED', decided_by_user_id=$2, decision_reason_code='RESPONDENT_DID_THE_WORK' WHERE id=$1", [dispute.id, execA.userId]))
      .rejects.toThrow(/growth_dispute_decider_ck/);
    // Growth staff cannot decide at all.
    await api().post(`${admin}/disputes/${dispute.id}/decide`).set(auth(execB.userId)).send({ outcome: 'UPHELD', reasonCode: 'CLAIMANT_DID_THE_WORK' }).expect(403);
    expect((await disputeOf(orgId))!.state).toBe('OPEN');

    // An admin who is neither party upholds it: the old row ends, the new one runs from the original date.
    const before = (await attributionsOf(orgId))[0]!;
    const decided = await api().post(`${admin}/disputes/${dispute.id}/decide`).set(auth(adminB.userId)).send({ outcome: 'UPHELD', reasonCode: 'CLAIMANT_DID_THE_WORK' }).expect(201);
    const rows = await attributionsOf(orgId);
    expect(rows).toEqual([
      expect.objectContaining({ id: before.id, beneficiary_user_id: execA.userId, ended: true, ended_reason_code: 'DISPUTE_DECISION', ended_by_user_id: adminB.userId }),
      expect.objectContaining({ id: decided.body.decided.resultingAttributionId, beneficiary_user_id: dual.userId, basis: 'DISPUTE_DECISION', supersedes_id: before.id,
        dispute_id: dispute.id, created_by_user_id: adminB.userId, ended: false }),
    ]);
    expect((await pool.query('SELECT (SELECT effective_from FROM growth_attributions WHERE id=$1) = (SELECT effective_from FROM growth_attributions WHERE id=$2) AS same',
      [before.id, rows[1]!.id])).rows[0].same).toBe(true);
    expect(await disputeOf(orgId)).toMatchObject({ state: 'UPHELD', decided_by_user_id: adminB.userId, resulting_attribution_id: rows[1]!.id });
    expect((await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.attribution_dispute.decided' AND aggregate_id=$1", [dispute.id])).rows)
      .toEqual([{ payload: { disputeId: dispute.id, organizationId: orgId, outcome: 'UPHELD', reasonCode: 'CLAIMANT_DID_THE_WORK' } }]);
    await api().post(`${admin}/disputes/${dispute.id}/decide`).set(auth(adminA.userId)).send({ outcome: 'REJECTED', reasonCode: 'INSUFFICIENT_EVIDENCE' }).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_DISPUTE_DECIDED'));
    await expect(pool.query("UPDATE growth_attribution_disputes SET decision_note='changed' WHERE id=$1", [dispute.id])).rejects.toThrow(/never changes/);
  });

  it('an onboarding conflict upheld credits the referrer; rejected credits the lead owner; OTHER needs a note', async () => {
    const referrer = await growthExec(['EMPLOYER_PARTNERSHIPS']);
    const owner = await growthExec(['EMPLOYER_PARTNERSHIPS']);
    const first = await employerOnboarded({ referrer, leadOwner: owner });
    const second = await employerOnboarded({ referrer: await growthExec(['EMPLOYER_PARTNERSHIPS']), leadOwner: owner });
    const one = (await disputeOf(first.orgId))!;
    const two = (await disputeOf(second.orgId))!;
    await api().post(`${admin}/disputes/${one.id}/decide`).set(auth(adminA.userId)).send({ outcome: 'UPHELD', reasonCode: 'OTHER' }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_DISPUTE_NOTE_INVALID'));
    await api().post(`${admin}/disputes/${one.id}/decide`).set(auth(adminA.userId)).send({ outcome: 'UPHELD', reasonCode: 'OTHER', note: 'The link was shared first.' }).expect(201);
    expect(await attributionsOf(first.orgId)).toEqual([expect.objectContaining({ beneficiary_user_id: referrer.userId, basis: 'DISPUTE_DECISION', supersedes_id: null })]);
    await api().post(`${admin}/disputes/${two.id}/decide`).set(auth(adminA.userId)).send({ outcome: 'REJECTED', reasonCode: 'RESPONDENT_DID_THE_WORK' }).expect(201);
    expect(await attributionsOf(second.orgId)).toEqual([expect.objectContaining({ beneficiary_user_id: owner.userId, basis: 'DISPUTE_DECISION' })]);
    // Effective from the onboarding.
    expect((await pool.query(`SELECT a.effective_from = growth_organization_handed_off_at(a.organization_id) AS same FROM growth_attributions a WHERE a.organization_id=$1`, [second.orgId])).rows[0].same).toBe(true);
  });
});

describe('reassignment and leavers (design §8.5)', () => {
  it('a leaver keeps credit, gets a recorded leave date, and a growth admin reassigns with a reason', async () => {
    const leaver = await growthExec(['COLLEGE_PARTNERSHIPS']);
    const { orgId } = await collegeHandoff(leaver);
    await pool.query("UPDATE organization_memberships SET state='ENDED' WHERE id=$1", [leaver.membershipId]);
    const events = (await pool.query('SELECT event, from_state, to_state, occurred_at FROM growth_leaver_events WHERE user_id=$1', [leaver.userId])).rows;
    expect(events).toEqual([expect.objectContaining({ event: 'LEFT', from_state: 'ACTIVE', to_state: 'ENDED' })]);
    expect(await attributionsOf(orgId)).toEqual([expect.objectContaining({ beneficiary_user_id: leaver.userId, ended: false })]);
    await expect(pool.query('DELETE FROM growth_leaver_events WHERE user_id=$1', [leaver.userId])).rejects.toThrow(/append-only/);

    const listed = await api().get(admin).query({ view: 'LEFT' }).set(auth(adminA.userId)).expect(200);
    const row = (listed.body.attributions as Record<string, any>[]).find((item) => item.organizationId === orgId)!;
    expect(row.beneficiary).toMatchObject({ userId: leaver.userId, active: false });
    expect(new Date(row.leaver.leftAt).getTime()).toBe(new Date(events[0]!.occurred_at).getTime());
    expect(new Date(row.leaver.settlementEndsAt).getTime() - new Date(row.leaver.leftAt).getTime()).toBe(90 * 24 * 60 * 60 * 1000);
    expect(listed.body.counts.beneficiaryLeft).toBeGreaterThanOrEqual(1);

    const employerOnly = await growthExec(['EMPLOYER_PARTNERSHIPS']);
    await api().post(`${admin}/${row.attributionId}/reassign`).set(auth(adminA.userId)).send({ toUserId: employerOnly.userId, reasonCode: 'BENEFICIARY_LEFT' }).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_ATTRIBUTION_TARGET_INVALID'));
    await api().post(`${admin}/${row.attributionId}/reassign`).set(auth(adminA.userId)).send({ toUserId: execB.userId, reasonCode: 'NOT_A_REASON' }).expect(400);
    const reassigned = await api().post(`${admin}/${row.attributionId}/reassign`).set(auth(adminA.userId)).send({ toUserId: execB.userId, reasonCode: 'BENEFICIARY_LEFT' }).expect(201);
    expect(await attributionsOf(orgId)).toEqual([
      expect.objectContaining({ beneficiary_user_id: leaver.userId, ended: true, ended_reason_code: 'REASSIGNED', ended_by_user_id: adminA.userId }),
      expect.objectContaining({ id: reassigned.body.attributionId, beneficiary_user_id: execB.userId, basis: 'MANUAL_CORRECTION', reason_code: 'BENEFICIARY_LEFT', supersedes_id: row.attributionId }),
    ]);
    // A reassignment affects only what is earned from now on.
    expect((await pool.query('SELECT effective_from > (SELECT effective_from FROM growth_attributions WHERE id=$2) AS later FROM growth_attributions WHERE id=$1', [reassigned.body.attributionId, row.attributionId])).rows[0].later).toBe(true);
    expect((await pool.query("SELECT context FROM audit_events WHERE action='growth.attribution.reassigned' AND resource_id=$1", [reassigned.body.attributionId])).rows[0].context)
      .toMatchObject({ fromUserId: leaver.userId, toUserId: execB.userId, reasonCode: 'BENEFICIARY_LEFT' });
    const history = await api().get(`${admin}/organizations/${orgId}`).set(auth(adminB.userId)).expect(200);
    expect(history.body.attributions.map((item: { basis: string }) => item.basis)).toEqual(['LEAD_OWNER_AT_HANDOFF', 'MANUAL_CORRECTION']);
  });

  it('records a return to ACTIVE and nothing for other growth state changes', async () => {
    const person = await growthExec(['COLLEGE_PARTNERSHIPS']);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [person.membershipId]);
    await pool.query("UPDATE organization_memberships SET state='ACTIVE' WHERE id=$1", [person.membershipId]);
    expect((await pool.query('SELECT event FROM growth_leaver_events WHERE user_id=$1 ORDER BY occurred_at, event', [person.userId])).rows.map((row) => row.event)).toEqual(['LEFT', 'RETURNED']);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [adminB.membershipId]);
    await pool.query("UPDATE organization_memberships SET state='ACTIVE' WHERE id=$1", [adminB.membershipId]);
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_leaver_events WHERE user_id=$1', [adminB.userId])).rows[0].n).toBe(0);
  });

  it('never moves credit to or from the admin acting, and waits for an open dispute', async () => {
    const credited = await collegeHandoff(dual);
    const live = (await attributionsOf(credited.orgId))[0]!;
    await api().post(`${admin}/${live.id}/reassign`).set(auth(dual.userId)).send({ toUserId: execB.userId, reasonCode: 'CORRECTION' }).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_SELF_DEALING_REFUSED'));
    await api().post(`${admin}/${live.id}/end`).set(auth(dual.userId)).send({ reasonCode: 'CORRECTION' }).expect(403);
    await expect(pool.query("UPDATE growth_attributions SET ended_at=now(), ended_reason_code='CORRECTION', ended_by_user_id=$2 WHERE id=$1", [live.id, dual.userId]))
      .rejects.toThrow(/growth_attribution_self_ck/);
    const other = await collegeHandoff(execA);
    const otherLive = (await attributionsOf(other.orgId))[0]!;
    await api().post(`${admin}/${otherLive.id}/reassign`).set(auth(dual.userId)).send({ toUserId: dual.userId, reasonCode: 'CORRECTION' }).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_SELF_DEALING_REFUSED'));

    const disputed = await collegeHandoff(execA, { creator: execB });
    await api().post(claims).set(auth(execB.userId)).send({ organizationId: disputed.orgId, statement: 'Mine first.' }).expect(201);
    const disputedLive = (await attributionsOf(disputed.orgId))[0]!;
    await api().post(`${admin}/${disputedLive.id}/reassign`).set(auth(adminA.userId)).send({ toUserId: outsider.userId, reasonCode: 'CORRECTION' }).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_DISPUTE_OPEN'));

    await api().post(`${admin}/${otherLive.id}/end`).set(auth(adminA.userId)).send({ reasonCode: 'REASSIGNED' }).expect(400);
    await api().post(`${admin}/${otherLive.id}/end`).set(auth(adminA.userId)).send({ reasonCode: 'ORGANIZATION_EXITED' }).expect(201);
    expect(await attributionsOf(other.orgId)).toEqual([expect.objectContaining({ ended: true, ended_reason_code: 'ORGANIZATION_EXITED', ended_by_user_id: adminA.userId })]);
    expect((await api().get(mine).set(auth(execA.userId)).expect(200)).body.credited.find((row: { organizationId: string }) => row.organizationId === other.orgId))
      .toMatchObject({ endedReasonCode: 'ORGANIZATION_EXITED' });
  });
});

describe('the self-dealing guard (design §8.6)', () => {
  it('an operator attributed to an employer cannot verify it, by the route or the database; another operator can', async () => {
    const { orgId } = await employerOnboarded({ referrer: { ...dual, membershipId: dual.growthMembershipId } });
    expect(await attributionsOf(orgId)).toEqual([expect.objectContaining({ beneficiary_user_id: dual.userId, basis: 'REFERRAL_LINK' })]);
    const verify = (as: Person, toState: string) => api().post(`/api/v1/operations/organizations/${orgId}/verification`).set(auth(as.userId)).send({ toState });
    await verify(dual, 'UNDER_REVIEW').expect(403).expect((r) => expect(r.body.error.code).toBe('GROWTH_SELF_DEALING_REFUSED'));
    expect((await pool.query('SELECT verification_state FROM organizations WHERE id=$1', [orgId])).rows[0].verification_state).toBe('PENDING');
    await expect(pool.query(`INSERT INTO organization_verification_events (id,organization_id,from_state,to_state,reason_code,actor_user_id,correlation_id)
      VALUES ($1,$2,'PENDING','UNDER_REVIEW','OPERATIONS_REVIEW',$3,'test')`, [randomUUID(), orgId, dual.userId])).rejects.toThrow(/self-dealing/);
    await verify(adminA, 'UNDER_REVIEW').expect(201);
    await verify(dual, 'VERIFIED').expect(403);
    await verify(adminB, 'VERIFIED').expect(201);
    expect((await pool.query('SELECT verification_state FROM organizations WHERE id=$1', [orgId])).rows[0].verification_state).toBe('VERIFIED');
  });

  it('a party to an open dispute cannot verify the organisation either', async () => {
    const referrer = await growthExec(['EMPLOYER_PARTNERSHIPS']);
    const { orgId } = await employerOnboarded({ referrer, leadOwner: { ...dual, membershipId: dual.growthMembershipId } });
    expect(await disputeOf(orgId)).toMatchObject({ origin: 'ONBOARDING_CONFLICT', respondent_user_id: dual.userId });
    await api().post(`/api/v1/operations/organizations/${orgId}/verification`).set(auth(dual.userId)).send({ toState: 'UNDER_REVIEW' }).expect(403);
  });

  it('an operator cannot link a handoff, onboard an employer or link an access request that would credit them', async () => {
    const leadId = await collegeLead({ ...dual, membershipId: dual.growthMembershipId });
    await requestHandoff(dual, leadId);
    const college = await organization('INSTITUTION');
    await api().post(`${handoffs}/${leadId}/link`).set(auth(dual.userId)).send({ organizationId: college }).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_SELF_DEALING_REFUSED'));
    expect((await pool.query("SELECT state FROM growth_handoff_requests WHERE lead_id=$1", [leadId])).rows[0].state).toBe('REQUESTED');
    await api().post(`${handoffs}/${leadId}/link`).set(auth(adminA.userId)).send({ organizationId: college }).expect(201);
    expect(await attributionsOf(college)).toEqual([expect.objectContaining({ beneficiary_user_id: dual.userId, created_by_user_id: adminA.userId })]);

    const referred = await accessRequest({ referrer: dual });
    const employer = await organization('EMPLOYER');
    await onboard(referred.requestId, employer, dual).expect(403).expect((r) => expect(r.body.error.code).toBe('GROWTH_SELF_DEALING_REFUSED'));
    expect((await pool.query('SELECT state FROM employer_access_requests WHERE id=$1', [referred.requestId])).rows[0].state).toBe('PENDING');
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_employer_onboardings WHERE access_request_id=$1', [referred.requestId])).rows[0].n).toBe(0);
    await onboard(referred.requestId, employer, adminB).expect(201);

    const unlinked = await accessRequest({});
    const ownLead = await api().post(leads).set(auth(dual.userId)).send({ kind: 'EMPLOYER', name: 'Employer ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT' }).expect(201);
    await api().post(`/api/v1/operations/employer-access-requests/${unlinked.requestId}/growth-lead`).set(auth(dual.userId)).send({ leadId: ownLead.body.lead.id }).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('GROWTH_SELF_DEALING_REFUSED'));
    await api().post(`/api/v1/operations/employer-access-requests/${unlinked.requestId}/growth-lead`).set(auth(adminA.userId)).send({ leadId: ownLead.body.lead.id }).expect(201);
  });
});

describe('access and reads', () => {
  it('keeps the Operations attribution routes to GROWTH_ADMIN and the growth read to growth staff', async () => {
    for (const person of [execA, manager, securityAdmin]) {
      await api().get(admin).set(auth(person.userId)).expect(403);
      await api().get(`${admin}/disputes`).set(auth(person.userId)).expect(403);
      await api().post(`${admin}/${randomUUID()}/end`).set(auth(person.userId)).send({ reasonCode: 'CORRECTION' }).expect(403);
    }
    for (const person of [adminA, securityAdmin]) {
      await api().get(mine).set(auth(person.userId)).expect(403);
      await api().post(claims).set(auth(person.userId)).send({ organizationId: randomUUID(), statement: 'x' }).expect(403);
    }
    await api().get(mine).expect(401);
    const listed = await api().get(admin).set(auth(superAdmin.userId)).expect(200);
    expect(listed.body.vocabulary.reassignReasons).toEqual(['BENEFICIARY_LEFT', 'WRONG_PERSON_CREDITED', 'TEAM_CHANGE', 'CORRECTION']);
    const disputes = await api().get(`${admin}/disputes`).set(auth(adminA.userId)).expect(200);
    expect(disputes.body.disputes.length).toBeGreaterThan(0);
    expect(disputes.body.disputes.every((row: { state: string }) => row.state === 'OPEN')).toBe(true);
    const options = await api().get(`${admin}/reassign-options`).query({ kind: 'INSTITUTION' }).set(auth(adminA.userId)).expect(200);
    expect(options.body.options.map((row: { userId: string }) => row.userId)).toEqual(expect.arrayContaining([execA.userId, execB.userId]));
    expect(JSON.stringify(listed.body) + JSON.stringify(disputes.body)).not.toMatch(/amount|paise/i);
  });

  it('puts a growth person\'s credit, their own disputes and leave dates in their export, never another party\'s statement', async () => {
    const { orgId } = await collegeHandoff(execA, { creator: execB });
    await api().post(claims).set(auth(execB.userId)).send({ organizationId: orgId, statement: 'Private reasoning of B.' }).expect(201);
    const one = async (query: Parameters<typeof db.execute>[0]) => ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
    const ofA = (await assembleCoverageSections(one, execA.userId)).growthWork as Record<string, any>;
    expect(ofA.attributions.some((row: { basis: string }) => row.basis === 'LEAD_OWNER_AT_HANDOFF')).toBe(true);
    expect(JSON.stringify(ofA.attributionDisputes)).not.toContain('Private reasoning of B.');
    expect(ofA.attributionDisputes.some((row: { role: string }) => row.role === 'RESPONDENT')).toBe(true);
    const ofB = (await assembleCoverageSections(one, execB.userId)).growthWork as Record<string, any>;
    expect(ofB.attributionDisputes.find((row: { statement: string | null }) => row.statement === 'Private reasoning of B.')).toMatchObject({ role: 'CLAIMANT' });
    expect(Array.isArray(ofB.leaverEvents)).toBe(true);
  });
});
