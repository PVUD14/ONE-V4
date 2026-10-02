/**
 * The employer pipeline, referral links and the EMP-04 handoff (GROWTH-05; growth-employer-pipeline-table-design.md).
 *
 * The acceptance criteria this file carries:
 *  - a valid, revoked, unknown and malformed code produce byte-identical responses (status, headers
 *    and body, with the per-request correlation id pinned) and the same rate-limit behaviour;
 *  - a referral row is deleted with its request under EMP-04 retention (180 days after a decline or
 *    spam decision), and by nothing else;
 *  - growth sees job and drive counts and states, never content or candidates.
 * Also: referral codes (who may create one, the abuse limits in the API and the database, revocation by
 * hand and automatically, a resent creation lands once), the per-code referral cap, first referral
 * wins, the domain match and the operator's lead link, the onboarding record and the §8.3 candidate
 * (referral, lead owner, conflict, house), and the database rule that an employer lead names its
 * employer only through an onboarding.
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
import { acceptEmployerTerms, publishEmployerTermsVersion } from '@planthepath/persistence/src/employer-terms.js';
import { sweepEmployerAccessRequestRetention } from '@planthepath/persistence/src/employer-access-request-retention.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { assembleCoverageSections } from './privacy-export-sections.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for growth employer tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Growth employer tests require local Postgres');
const schemaName = 'growth_employer_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

const identities = new Map<string, { readonly email: string }>();
/** The next id the API generates; the public form's first id is its correlation id. */
let pinnedId: string | null = null;
let app: INestApplication;
let platformId: string;
let superAdmin: Person;
let opsAdmin: Person;
let securityAdmin: Person;
let karnataka: string;
let manager: Person;
let execA: Person;
let execB: Person;
let collegeExec: Person;

interface Person { readonly userId: string; readonly membershipId: string; readonly email: string }

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db,
      ids: { uuid: () => { if (pinnedId) { const id = pinnedId; pinnedId = null; return id; } return randomUUID(); } },
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
  await team(manager, 'EMPLOYER_PARTNERSHIPS');
  await assign(karnataka, manager, 'MANAGER');
  execA = await member('GROWTH_EXECUTIVE');
  await team(execA, 'EMPLOYER_PARTNERSHIPS', manager);
  await assign(karnataka, execA, 'EXECUTIVE');
  execB = await member('GROWTH_EXECUTIVE');
  await team(execB, 'EMPLOYER_PARTNERSHIPS', manager);
  await assign(karnataka, execB, 'EXECUTIVE');
  collegeExec = await member('GROWTH_EXECUTIVE');
  await team(collegeExec, 'COLLEGE_PARTNERSHIPS');
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

async function team(person: Person, name: string, reportsTo: Person | null = null): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO growth_team_members (id,membership_id,team,manager_membership_id,joined_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5,'NEW_MEMBER')",
    [id, person.membershipId, name, reportsTo?.membershipId ?? null, superAdmin.userId]);
  return id;
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

/** A fresh employer-team executive, so code limits in one test do not touch another's. */
async function employerExec(): Promise<Person> {
  const person = await member('GROWTH_EXECUTIVE');
  await team(person, 'EMPLOYER_PARTNERSHIPS', manager);
  await assign(karnataka, person, 'EXECUTIVE');
  return person;
}

const api = () => request(app.getHttpServer());
const auth = (subject: string, key?: string) => ({
  Authorization: 'Bearer ' + subject, 'X-Correlation-Id': 'growth-employer-' + randomUUID(), ...(key ? { 'Idempotency-Key': key } : {}),
});
const unique = () => randomUUID().slice(0, 8);
const codes = '/api/v1/growth/referral-codes';
const leads = '/api/v1/growth/leads';
const formPath = '/api/v1/employer-access-requests';
const queuePath = '/api/v1/operations/employer-access-requests';

let addressCounter = 1;
const nextAddress = () => `198.51.${Math.floor(addressCounter / 250) % 250}.${(addressCounter++ % 250) + 1}`;
function accessRequest(overrides: Record<string, unknown> = {}, domain = 'firm-' + unique() + '.example') {
  return { requesterName: 'Asha Rao', companyName: 'Firm ' + domain, workEmail: 'asha@' + domain, websiteUrl: 'https://www.' + domain, ...overrides };
}
const submit = (body: unknown, address = nextAddress()) => api().post(formPath).set('X-Forwarded-For', address).send(body as object);

async function newCode(person: Person): Promise<{ readonly id: string; readonly code: string }> {
  const created = await api().post(codes).set(auth(person.userId)).send({}).expect(201);
  return { id: created.body.code.id as string, code: created.body.code.code as string };
}

async function requestRow(workEmail: string): Promise<{ id: string; state: string }> {
  return (await pool.query('SELECT id, state FROM employer_access_requests WHERE work_email=$1', [workEmail])).rows[0];
}

async function referralOf(requestId: string): Promise<string | null> {
  return (await pool.query('SELECT referral_code_id FROM employer_access_request_referrals WHERE access_request_id=$1', [requestId])).rows[0]?.referral_code_id ?? null;
}

async function employerOrg(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'EMPLOYER',$2)", [id, 'Employer ' + unique()]);
  return id;
}

async function employerLead(person: Person, domain: string | null = null): Promise<string> {
  const created = await api().post(leads).set(auth(person.userId))
    .send({ kind: 'EMPLOYER', name: 'Employer ' + unique(), stateCode: 'IN-KA', source: 'FIELD_VISIT', ...(domain ? { websiteDomain: domain } : {}) }).expect(201);
  return created.body.lead.id as string;
}

const decide = (requestId: string, body: Record<string, unknown>, as: Person = opsAdmin) =>
  api().post(`${queuePath}/${requestId}/decision`).set(auth(as.userId)).send(body);

/** Everything about a response a caller can observe, except the Date header (it is the clock). */
function observable(response: request.Response): { status: number; text: string; headers: Record<string, unknown> } {
  const { date: _date, ...headers } = response.headers as Record<string, unknown>;
  return { status: response.status, text: response.text, headers };
}

describe('referral codes', () => {
  it('are created by the employer team only, carry no personal data, and are audited', async () => {
    const person = await employerExec();
    const created = await api().post(codes).set(auth(person.userId)).send({}).expect(201);
    const code = created.body.code as { id: string; code: string; linkPath: string };
    expect(code.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/);
    expect(code.linkPath).toBe('/employer-access?ref=' + code.code);
    expect(code.linkPath).not.toContain(person.email.split('@')[0]!);
    const audit = await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='growth.referral_code.created' AND resource_id=$1", [code.id]);
    expect(audit.rows).toEqual([{ actor_user_id: person.userId, context: { membershipId: person.membershipId } }]);
    const event = await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.referral_code.created' AND aggregate_id=$1", [code.id]);
    expect(event.rows).toEqual([{ payload: { referralCodeId: code.id } }]);
    expect(JSON.stringify(event.rows)).not.toContain(code.code);

    const listed = await api().get(codes).set(auth(person.userId)).expect(200);
    expect(listed.body).toMatchObject({ eligible: true, codes: [{ id: code.id, code: code.code, revokedAt: null, referrals: { pending: 0, onboarded: 0, closed: 0 } }] });

    const college = await api().get(codes).set(auth(collegeExec.userId)).expect(200);
    expect(college.body).toMatchObject({ eligible: false, codes: [] });
    await api().post(codes).set(auth(collegeExec.userId)).send({}).expect(403).expect((r) => expect(r.body.error.code).toBe('GROWTH_TEAM_MISMATCH'));
    for (const outsider of [opsAdmin, securityAdmin]) {
      await api().get(codes).set(auth(outsider.userId)).expect(403);
      await api().post(codes).set(auth(outsider.userId)).send({}).expect(403);
    }
  });

  it('allow three live codes and five creations a day, in the API and the database', async () => {
    const person = await employerExec();
    const made = [await newCode(person), await newCode(person), await newCode(person)];
    await api().post(codes).set(auth(person.userId)).send({}).expect(409).expect((r) => expect(r.body.error.code).toBe('GROWTH_REFERRAL_CODE_LIMIT'));
    await expect(pool.query("INSERT INTO growth_referral_codes (id,code,membership_id,user_id) VALUES ($1,'ZZZZZZZZZ2',$2,$3)", [randomUUID(), person.membershipId, person.userId]))
      .rejects.toThrow(/at most 3 live codes/);
    await api().post(`${codes}/${made[0]!.id}/revoke`).set(auth(person.userId)).send({}).expect(201);
    await newCode(person);
    await api().post(`${codes}/${made[1]!.id}/revoke`).set(auth(person.userId)).send({}).expect(201);
    await newCode(person);
    await api().post(`${codes}/${made[2]!.id}/revoke`).set(auth(person.userId)).send({}).expect(201);
    await api().post(codes).set(auth(person.userId)).send({}).expect(409).expect((r) => expect(r.body.error.code).toBe('GROWTH_REFERRAL_CODE_DAILY_LIMIT'));
  });

  it('are revoked by their owner only; another person\'s code is not found; a revoked code never changes', async () => {
    const person = await employerExec();
    const code = await newCode(person);
    await api().post(`${codes}/${code.id}/revoke`).set(auth(execB.userId)).send({}).expect(404);
    const revoked = await api().post(`${codes}/${code.id}/revoke`).set(auth(person.userId)).send({}).expect(201);
    expect(revoked.body.codes[0]).toMatchObject({ id: code.id, revokedReasonCode: 'OWNER_REVOKED' });
    await api().post(`${codes}/${code.id}/revoke`).set(auth(person.userId)).send({}).expect(409);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='growth.referral_code.revoked' AND resource_id=$1", [code.id])).rows[0].n).toBe(1);
    await expect(pool.query('UPDATE growth_referral_codes SET revoked_at=NULL, revoked_reason_code=NULL, revoked_by_user_id=NULL WHERE id=$1', [code.id])).rejects.toThrow(/never changes/);
    await expect(pool.query('DELETE FROM growth_referral_codes WHERE id=$1', [code.id])).rejects.toThrow(/never deleted/);
    // Another person's codes are never listed.
    expect(JSON.stringify((await api().get(codes).set(auth(execB.userId)).expect(200)).body)).not.toContain(code.id);
  });

  it('are revoked automatically when the owner leaves ONE or leaves the employer team', async () => {
    const leaver = await employerExec();
    const leaverCode = await newCode(leaver);
    await pool.query("UPDATE organization_memberships SET state='SUSPENDED' WHERE id=$1", [leaver.membershipId]);
    expect((await pool.query('SELECT revoked_reason_code, revoked_by_user_id FROM growth_referral_codes WHERE id=$1', [leaverCode.id])).rows[0])
      .toEqual({ revoked_reason_code: 'OWNER_LEFT', revoked_by_user_id: null });

    const mover = await member('GROWTH_EXECUTIVE');
    const teamRow = await team(mover, 'EMPLOYER_PARTNERSHIPS');
    await team(mover, 'COLLEGE_PARTNERSHIPS');
    const moverCode = await newCode(mover);
    await pool.query("UPDATE growth_team_members SET left_at=now(), left_by_user_id=$2, left_reason_code='TEAM_CHANGE' WHERE id=$1", [teamRow, superAdmin.userId]);
    expect((await pool.query('SELECT revoked_reason_code FROM growth_referral_codes WHERE id=$1', [moverCode.id])).rows[0].revoked_reason_code).toBe('LEFT_EMPLOYER_TEAM');
  });

  it('are in their owner\'s privacy export, and nobody else\'s', async () => {
    const person = await employerExec();
    const code = await newCode(person);
    const oneQuery = async (query: Parameters<typeof db.execute>[0]) => ((await db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
    const mine = await assembleCoverageSections(oneQuery, person.userId) as { growthWork: { referralCodes: unknown[] } };
    expect(mine.growthWork.referralCodes).toEqual([expect.objectContaining({ code: code.code, revokedAt: null, referralsRecorded: 0 })]);
    const theirs = await assembleCoverageSections(oneQuery, execB.userId) as { growthWork: { referralCodes: unknown[] } };
    expect(JSON.stringify(theirs.growthWork.referralCodes)).not.toContain(code.code);
  });

  it('land once when a creation is resent with the same key', async () => {
    const person = await employerExec();
    const key = randomUUID();
    const first = await api().post(codes).set(auth(person.userId, key)).send({}).expect(201);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const again = await api().post(codes).set(auth(person.userId, key)).send({}).expect(201);
      expect(again.body).toMatchObject({ idempotentReplay: true, code: { id: first.body.code.id } });
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM growth_referral_codes WHERE membership_id=$1', [person.membershipId])).rows[0].n).toBe(1);
  });
});

describe('the public form with a referral code', () => {
  it('answers byte for byte the same for a valid, revoked, unknown and malformed code, and records only the valid one', async () => {
    const owner = await employerExec();
    const valid = await newCode(owner);
    const revoked = await newCode(owner);
    await api().post(`${codes}/${revoked.id}/revoke`).set(auth(owner.userId)).send({}).expect(201);
    const variants: readonly [string, unknown][] = [
      ['valid', valid.code], ['valid, lower case', valid.code.toLowerCase()], ['revoked', revoked.code], ['unknown', 'ABCDEFGHJK'],
      ['malformed', 'not-a-code'], ['ambiguous characters', 'ABCDEFGH10'], ['empty', ''], ['too long', 'A'.repeat(500)],
      ['a number', 12345], ['an object', { code: valid.code }], ['null', null], ['absent', undefined],
    ];
    const correlationId = randomUUID();
    const seen: ReturnType<typeof observable>[] = [];
    for (const [, ref] of variants) {
      const body = accessRequest(ref === undefined ? {} : { ref });
      pinnedId = correlationId;
      const response = await submit(body);
      seen.push(observable(response));
      const saved = await requestRow(body.workEmail);
      expect(saved.state).toBe('PENDING');
    }
    expect(seen[0]!.status).toBe(202);
    expect(JSON.parse(seen[0]!.text)).toEqual({ received: true, correlationId });
    for (const response of seen) expect(response).toEqual(seen[0]);

    // Only the valid code (in either case) was recorded, each with an outbox event and no actor.
    const recorded = await pool.query(`SELECT r.referral_code_id, e.actor_user_id FROM employer_access_request_referrals r
      JOIN growth_referral_codes c ON c.id = r.referral_code_id
      JOIN outbox_events e ON e.aggregate_id = r.access_request_id::text AND e.event_type='growth.referral.recorded'
      WHERE c.membership_id = $1`, [owner.membershipId]);
    expect(recorded.rows).toEqual([{ referral_code_id: valid.id, actor_user_id: null }, { referral_code_id: valid.id, actor_user_id: null }]);
  });

  it('keeps the rate limits exactly as they were, whatever the code', async () => {
    const owner = await employerExec();
    const valid = await newCode(owner);
    const revoked = await newCode(owner);
    await api().post(`${codes}/${revoked.id}/revoke`).set(auth(owner.userId)).send({}).expect(201);
    const outcomes: string[][] = [];
    const refusals: ReturnType<typeof observable>[] = [];
    for (const ref of [valid.code, revoked.code, 'ABCDEFGHJK', '!!', undefined]) {
      const address = nextAddress();
      const statuses: string[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const body = accessRequest(ref === undefined ? {} : { ref });
        pinnedId = '00000000-0000-4000-8000-000000000429';
        const response = await submit(body, address);
        statuses.push(String(response.status));
        if (response.status === 429) {
          refusals.push(observable(response));
          // A refused submission records nothing, referral included.
          expect(await requestRow(body.workEmail)).toBeUndefined();
        }
      }
      outcomes.push(statuses);
    }
    for (const statuses of outcomes) expect(statuses).toEqual(['202', '202', '202', '202', '202', '429']);
    expect(JSON.parse(refusals[0]!.text).error.code).toBe('EMPLOYER_ACCESS_REQUEST_RATE_LIMITED');
    for (const refusal of refusals) expect(refusal).toEqual(refusals[0]);
    // A code never makes a well-formed submission invalid, and a bad field is refused as before.
    await submit(accessRequest({ ref: valid.code, phone: '999' })).expect(400);
    await submit(accessRequest({ ref: valid.code, websiteUrl: 'http://plain.example' })).expect(400);
  });

  it('records at most twenty referrals a code a day; past that the request is still received, without the referral', async () => {
    const owner = await employerExec();
    const code = await newCode(owner);
    const emails: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const body = accessRequest({ ref: code.code });
      emails.push(body.workEmail);
      await submit(body).expect(202);
    }
    const last = await requestRow(emails[20]!);
    expect(last.state).toBe('PENDING');
    expect(await referralOf(last.id)).toBeNull();
    expect((await pool.query('SELECT count(*)::int AS n FROM employer_access_request_referrals WHERE referral_code_id=$1', [code.id])).rows[0].n).toBe(20);
    const listed = await api().get(codes).set(auth(owner.userId)).expect(200);
    expect(listed.body.codes[0].referrals).toEqual({ pending: 20, onboarded: 0, closed: 0 });
  });

  it('keeps the first referral of a repeated pending request', async () => {
    const first = await newCode(await employerExec());
    const second = await newCode(await employerExec());
    const body = accessRequest({ ref: first.code });
    await submit(body).expect(202);
    await submit({ ...body, ref: second.code }).expect(202);
    const saved = await requestRow(body.workEmail);
    expect(await referralOf(saved.id)).toBe(first.id);
    expect((await pool.query('SELECT submission_count FROM employer_access_requests WHERE id=$1', [saved.id])).rows[0].submission_count).toBe(2);
  });

  it('ignores the code of a person who has left', async () => {
    const leaver = await employerExec();
    const code = await newCode(leaver);
    await pool.query("UPDATE organization_memberships SET state='ENDED' WHERE id=$1", [leaver.membershipId]);
    const body = accessRequest({ ref: code.code });
    await submit(body).expect(202);
    expect(await referralOf((await requestRow(body.workEmail)).id)).toBeNull();
  });
});

describe('EMP-04 retention takes the referral and the lead link with the request', () => {
  it('deletes declined and spam requests 180 days after the decision, with their referral and lead link, and nothing else', async () => {
    const owner = await employerExec();
    const code = await newCode(owner);
    const made: Record<string, string> = {};
    for (const name of ['oldDeclined', 'oldSpam', 'recentDeclined', 'pending', 'onboarded']) {
      const domain = name.toLowerCase() + '-' + unique() + '.example';
      await employerLead(owner, domain);
      const body = accessRequest({ ref: code.code }, domain);
      await submit(body).expect(202);
      made[name] = (await requestRow(body.workEmail)).id;
      expect(await referralOf(made[name]!)).toBe(code.id);
      expect((await pool.query('SELECT basis FROM employer_access_request_leads WHERE access_request_id=$1', [made[name]])).rows).toEqual([{ basis: 'DOMAIN_MATCH' }]);
    }
    await decide(made.oldDeclined!, { decision: 'DECLINED', reasonCode: 'COULD_NOT_CONFIRM' }).expect(201);
    await decide(made.oldSpam!, { decision: 'SPAM', reasonCode: 'FAKE_DETAILS' }).expect(201);
    await decide(made.recentDeclined!, { decision: 'DECLINED', reasonCode: 'OUT_OF_SCOPE' }).expect(201);
    await decide(made.onboarded!, { decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: await employerOrg() }).expect(201);
    await pool.query("UPDATE employer_access_requests SET decided_at = now() - interval '181 days' WHERE id IN ($1,$2,$3)", [made.oldDeclined, made.oldSpam, made.onboarded]);
    await pool.query("UPDATE employer_access_requests SET decided_at = now() - interval '179 days' WHERE id=$1", [made.recentDeclined]);

    // While a request exists, its referral cannot be deleted on its own.
    await expect(pool.query('DELETE FROM employer_access_request_referrals WHERE access_request_id=$1', [made.oldDeclined])).rejects.toThrow(/only with its access request/);

    let swept = 0;
    for (let batch = await sweepEmployerAccessRequestRetention(db); batch > 0; batch = await sweepEmployerAccessRequestRetention(db)) swept += batch;
    expect(swept).toBe(2);
    const left = async (table: string, column: string) => (await pool.query(`SELECT ${column} AS id FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [Object.values(made)])).rows.map((row: { id: string }) => row.id).sort();
    const kept = [made.recentDeclined!, made.pending!, made.onboarded!].sort();
    expect(await left('employer_access_requests', 'id')).toEqual(kept);
    expect(await left('employer_access_request_referrals', 'access_request_id')).toEqual(kept);
    expect(await left('employer_access_request_leads', 'access_request_id')).toEqual(kept);
    // Idempotent.
    expect(await sweepEmployerAccessRequestRetention(db)).toBe(0);
  });
});

describe('the growth lead of an access request', () => {
  it('is matched by domain only to exactly one open, contactable employer lead', async () => {
    const domain = 'matched-' + unique() + '.example';
    const lead = await employerLead(execA, domain);
    const body = accessRequest({ workEmail: 'hr@' + domain, websiteUrl: 'https://careers.other-' + unique() + '.example' }, domain);
    await submit(body).expect(202);
    const saved = await requestRow(body.workEmail);
    expect((await pool.query('SELECT lead_id, basis, linked_by_user_id FROM employer_access_request_leads WHERE access_request_id=$1', [saved.id])).rows)
      .toEqual([{ lead_id: lead, basis: 'DOMAIN_MATCH', linked_by_user_id: null }]);

    // A lost or do-not-contact lead is never matched.
    const lostDomain = 'lost-' + unique() + '.example';
    const lost = await employerLead(execA, lostDomain);
    await api().post(`${leads}/${lost}/stage`).set(auth(execA.userId)).send({ fromStage: 'IDENTIFIED', toStage: 'LOST', reasonCode: 'NO_RESPONSE' }).expect(201);
    const lostBody = accessRequest({}, lostDomain);
    await submit(lostBody).expect(202);
    expect((await pool.query('SELECT 1 FROM employer_access_request_leads WHERE access_request_id=$1', [(await requestRow(lostBody.workEmail)).id])).rows).toEqual([]);

    // Two leads that each match one of the request's hosts: no guess.
    const emailDomain = 'mail-' + unique() + '.example';
    const siteDomain = 'site-' + unique() + '.example';
    await employerLead(execA, emailDomain);
    await employerLead(execB, siteDomain);
    const ambiguous = accessRequest({ workEmail: 'a@' + emailDomain, websiteUrl: 'https://' + siteDomain });
    await submit(ambiguous).expect(202);
    expect((await pool.query('SELECT 1 FROM employer_access_request_leads WHERE access_request_id=$1', [(await requestRow(ambiguous.workEmail)).id])).rows).toEqual([]);
  });

  it('shows Operations the referral and the matching lead, and lets only OPS_ORG_MANAGE link, move or remove it while pending', async () => {
    const domain = 'queue-' + unique() + '.example';
    const lead = await employerLead(execA, domain);
    const other = await employerLead(execB, 'other-' + unique() + '.example');
    const code = await newCode(execB);
    const body = accessRequest({ ref: code.code }, domain);
    await submit(body).expect(202);
    const saved = await requestRow(body.workEmail);

    const queue = await api().get(queuePath).set(auth(opsAdmin.userId)).expect(200);
    const row = (queue.body.requests as { id: string }[]).find((item) => item.id === saved.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      growthReferral: { referrerEmail: execB.email, codeRevoked: false },
      growthLead: { leadId: lead, basis: 'DOMAIN_MATCH', ownerEmail: execA.email, websiteDomain: domain },
    });

    const linkPath = `${queuePath}/${saved.id}/growth-lead`;
    for (const outsider of [execA, manager, securityAdmin]) await api().post(linkPath).set(auth(outsider.userId)).send({ leadId: other }).expect(403);
    await api().get('/api/v1/operations/growth-employer-leads?q=employer').set(auth(execA.userId)).expect(403);
    const search = await api().get('/api/v1/operations/growth-employer-leads?q=' + encodeURIComponent('other-')).set(auth(opsAdmin.userId)).expect(200);
    expect((search.body.leads as { leadId: string }[]).map((item) => item.leadId)).toContain(other);

    await api().post(linkPath).set(auth(opsAdmin.userId)).send({ leadId: other }).expect(201);
    expect((await pool.query('SELECT lead_id, basis, linked_by_user_id FROM employer_access_request_leads WHERE access_request_id=$1', [saved.id])).rows)
      .toEqual([{ lead_id: other, basis: 'OPERATOR_LINKED', linked_by_user_id: opsAdmin.userId }]);
    await api().post(linkPath).set(auth(opsAdmin.userId)).send({ leadId: null }).expect(201);
    expect((await pool.query('SELECT 1 FROM employer_access_request_leads WHERE access_request_id=$1', [saved.id])).rows).toEqual([]);
    const audits = await pool.query("SELECT action, context FROM audit_events WHERE resource_id=$1 AND action LIKE 'operations.employer_access_request.growth_lead%' ORDER BY occurred_at, id", [saved.id]);
    expect(audits.rows).toEqual([
      { action: 'operations.employer_access_request.growth_lead_linked', context: { fromLeadId: lead, toLeadId: other } },
      { action: 'operations.employer_access_request.growth_lead_unlinked', context: { fromLeadId: other, toLeadId: null } },
    ]);

    // A lost lead cannot be linked; a decided request cannot be relinked.
    const lost = await employerLead(execA);
    await api().post(`${leads}/${lost}/stage`).set(auth(execA.userId)).send({ fromStage: 'IDENTIFIED', toStage: 'LOST', reasonCode: 'NO_RESPONSE' }).expect(201);
    await api().post(linkPath).set(auth(opsAdmin.userId)).send({ leadId: lost }).expect(409).expect((r) => expect(r.body.error.code).toBe('GROWTH_EMPLOYER_LEAD_NOT_LINKABLE'));
    await decide(saved.id, { decision: 'DECLINED', reasonCode: 'COULD_NOT_CONFIRM' }).expect(201);
    await api().post(linkPath).set(auth(opsAdmin.userId)).send({ leadId: other }).expect(409).expect((r) => expect(r.body.error.code).toBe('EMPLOYER_ACCESS_REQUEST_NOT_PENDING'));
  });
});

describe('onboarding records who could be credited (design §8.3) and links the lead', () => {
  async function onboard(input: { readonly ref?: string; readonly leadOwner?: Person }): Promise<{ requestId: string; org: string; leadId: string | null }> {
    const domain = 'onboard-' + unique() + '.example';
    const leadId = input.leadOwner ? await employerLead(input.leadOwner, domain) : null;
    const body = accessRequest(input.ref ? { ref: input.ref } : {}, domain);
    await submit(body).expect(202);
    const saved = await requestRow(body.workEmail);
    const org = await employerOrg();
    await decide(saved.id, { decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: org }).expect(201);
    return { requestId: saved.id, org, leadId };
  }
  const record = async (requestId: string) => (await pool.query('SELECT * FROM growth_employer_onboardings WHERE access_request_id=$1', [requestId])).rows[0];

  it('credits the referral first; the same person owning the lead agrees', async () => {
    const code = await newCode(execA);
    const done = await onboard({ ref: code.code, leadOwner: execA });
    expect(await record(done.requestId)).toMatchObject({
      organization_id: done.org, lead_id: done.leadId, lead_owner_user_id: execA.userId, lead_owner_membership_id: execA.membershipId,
      referral_code_id: code.id, referrer_user_id: execA.userId, referrer_membership_id: execA.membershipId,
      candidate_basis: 'REFERRAL_LINK', recorded_by_user_id: opsAdmin.userId,
    });
    expect((await pool.query('SELECT organization_id FROM growth_leads WHERE id=$1', [done.leadId])).rows[0].organization_id).toBe(done.org);
    const event = await pool.query("SELECT payload FROM outbox_events WHERE event_type='growth.employer.onboarded' AND aggregate_id=$1", [done.requestId]);
    expect(event.rows).toEqual([{ payload: { requestId: done.requestId, organizationId: done.org, candidateBasis: 'REFERRAL_LINK' } }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='operations.employer.growth_onboarding_recorded' AND resource_id=$1", [done.requestId])).rows[0].n).toBe(1);
  });

  it('records a conflict when the referral and the lead owner are different people', async () => {
    const code = await newCode(execB);
    const done = await onboard({ ref: code.code, leadOwner: execA });
    expect(await record(done.requestId)).toMatchObject({ candidate_basis: 'CONFLICT', referrer_user_id: execB.userId, lead_owner_user_id: execA.userId, lead_id: done.leadId });
  });

  it('credits the lead owner with no referral, and nobody ("house") with neither', async () => {
    const owned = await onboard({ leadOwner: execA });
    expect(await record(owned.requestId)).toMatchObject({ candidate_basis: 'LEAD_OWNER_AT_HANDOFF', lead_owner_user_id: execA.userId, referral_code_id: null });
    const house = await onboard({});
    expect(await record(house.requestId)).toMatchObject({ candidate_basis: 'HOUSE', lead_id: null, referral_code_id: null });
  });

  it('never blocks the decision: a lead already naming another employer is left alone and not recorded', async () => {
    const first = await onboard({ leadOwner: execA });
    const body = accessRequest({ workEmail: 'second@' + unique() + '.example' });
    await submit(body).expect(202);
    const saved = await requestRow(body.workEmail);
    await api().post(`${queuePath}/${saved.id}/growth-lead`).set(auth(opsAdmin.userId)).send({ leadId: first.leadId }).expect(409);
    const org = await employerOrg();
    await decide(saved.id, { decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: org }).expect(201);
    expect(await record(saved.id)).toMatchObject({ candidate_basis: 'HOUSE', lead_id: null });
    expect((await pool.query('SELECT organization_id FROM growth_leads WHERE id=$1', [first.leadId])).rows[0].organization_id).toBe(first.org);
  });

  it('lets an employer lead name its employer only through an onboarding, and never changes the record', async () => {
    const lead = await employerLead(execA);
    await expect(pool.query('UPDATE growth_leads SET organization_id=$2 WHERE id=$1', [lead, await employerOrg()])).rejects.toThrow(/only through an onboarded access request/);
    const done = await onboard({ leadOwner: execA });
    await expect(pool.query("UPDATE growth_employer_onboardings SET candidate_basis='HOUSE' WHERE access_request_id=$1", [done.requestId])).rejects.toThrow(/never changed/);
    await expect(pool.query('DELETE FROM growth_employer_onboardings WHERE access_request_id=$1', [done.requestId])).rejects.toThrow(/never changed/);
    // Growth staff cannot decide a request at all.
    const body = accessRequest();
    await submit(body).expect(202);
    await decide((await requestRow(body.workEmail)).id, { decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: await employerOrg() }, execA).expect(403);
  });
});

describe('the employer pipeline seen by growth', () => {
  it('moves through its own stages with the GROWTH-04 route', async () => {
    const lead = await employerLead(execA);
    await api().post(`${leads}/${lead}/stage`).set(auth(execA.userId)).send({ fromStage: 'IDENTIFIED', toStage: 'INTERESTED' }).expect(201);
    const moved = await api().post(`${leads}/${lead}/stage`).set(auth(execA.userId)).send({ fromStage: 'INTERESTED', toStage: 'ACCESS_REQUEST_INVITED' }).expect(201);
    expect(moved.body).toMatchObject({ kind: 'EMPLOYER', stage: 'ACCESS_REQUEST_INVITED', canRequestHandoff: false });
  });

  it('reads every milestone from its source, again after each source changes, with counts and states only', async () => {
    const domain = 'milestones-' + unique() + '.example';
    const lead = await employerLead(execA, domain);
    const pipeline = async () => (await api().get(`${leads}/${lead}/pipeline`).set(auth(execA.userId)).expect(200)).body as {
      milestones: { code: string; state: string; at: string | null; counts?: Record<string, number> }[]; accessRequests: { state: string; referral: string | null }[];
    };
    const state = async (code: string) => (await pipeline()).milestones.find((item) => item.code === code)!;

    const before = await pipeline();
    expect(before.milestones.map((item) => item.code)).toEqual(['ACCESS_REQUESTED', 'ONBOARDED', 'VERIFIED', 'TERMS_ACCEPTED', 'FIRST_JOB_PUBLISHED', 'CAMPUS_DRIVE', 'SUSPENDED']);
    expect(before.milestones.every((item) => item.state === 'NOT_REACHED')).toBe(true);
    expect(before.accessRequests).toEqual([]);

    const ownCode = await newCode(execA);
    const body = accessRequest({ ref: ownCode.code }, domain);
    await submit(body).expect(202);
    expect(await state('ACCESS_REQUESTED')).toMatchObject({ state: 'REACHED', at: expect.any(String) });
    expect((await pipeline()).accessRequests).toEqual([{ receivedAt: expect.any(String), state: 'PENDING', referral: 'YOU' }]);
    // Another team member's referral is said to be another's, never whose.
    const otherCode = await newCode(execB);
    await submit(accessRequest({ ref: otherCode.code, workEmail: 'second@' + domain }, domain)).expect(202);
    expect((await pipeline()).accessRequests.map((item) => item.referral).sort()).toEqual(['ANOTHER_TEAM_MEMBER', 'YOU']);

    const org = await employerOrg();
    await decide((await requestRow(body.workEmail)).id, { decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: org }).expect(201);
    expect(await state('ONBOARDED')).toMatchObject({ state: 'REACHED' });
    expect(await state('VERIFIED')).toMatchObject({ state: 'NOT_REACHED' });
    expect(await state('TERMS_ACCEPTED')).toMatchObject({ state: 'NA' });

    await pool.query("UPDATE organizations SET verification_state='VERIFIED' WHERE id=$1", [org]);
    await pool.query("INSERT INTO organization_verification_events (id,organization_id,from_state,to_state,reason_code,actor_user_id,correlation_id) VALUES ($1,$2,'PENDING','VERIFIED','DOCUMENTS_CHECKED',$3,'growth05-verify')",
      [randomUUID(), org, opsAdmin.userId]);
    expect(await state('VERIFIED')).toMatchObject({ state: 'REACHED', at: expect.any(String) });

    const version = 'growth05-' + unique();
    await publishEmployerTermsVersion(db, { version, title: 'Employer terms', body: 'Terms text.', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: null,
      requiresReacceptance: true, changeSummary: null, reasonCode: 'INITIAL_TERMS', actorUserId: superAdmin.userId, correlationId: 'growth05-terms' });
    expect(await state('TERMS_ACCEPTED')).toMatchObject({ state: 'NOT_REACHED' });
    const employerOwner = randomUUID();
    await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [employerOwner, 'owner-' + unique() + '@employer.example']);
    await acceptEmployerTerms(db, { employerId: org, version, actorUserId: employerOwner, correlationId: 'growth05-terms' });
    expect(await state('TERMS_ACCEPTED')).toMatchObject({ state: 'REACHED', at: expect.any(String) });

    const job = randomUUID();
    const jobVersion = randomUUID();
    await pool.query("INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)", [job, org, employerOwner, 'SECRET-REF-' + unique()]);
    await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,'Confidential Role Title','FULL_TIME','REMOTE',$3,$4)",
      [jobVersion, job, '0'.repeat(64), employerOwner]);
    expect(await state('FIRST_JOB_PUBLISHED')).toMatchObject({ state: 'NOT_REACHED', counts: { PUBLISHED_NOW: 0 } });
    await pool.query("UPDATE opportunities SET lifecycle_state='PUBLISHED', current_version_id=$2, published_at=now() WHERE id=$1", [job, jobVersion]);
    expect(await state('FIRST_JOB_PUBLISHED')).toMatchObject({ state: 'REACHED', at: expect.any(String), counts: { PUBLISHED_NOW: 1 } });
    await pool.query("UPDATE opportunities SET lifecycle_state='CLOSED', closed_at=now() WHERE id=$1", [job]);
    expect(await state('FIRST_JOB_PUBLISHED')).toMatchObject({ state: 'REACHED', counts: { PUBLISHED_NOW: 0 } });

    const college = randomUUID();
    await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Hidden College Name')", [college]);
    await pool.query("INSERT INTO campus_drives (id,employer_id,opportunity_id,institution_id,requested_by_user_id) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), org, job, college, employerOwner]);
    expect(await state('CAMPUS_DRIVE')).toMatchObject({ state: 'REACHED', counts: { REQUESTED: 1 } });

    expect(await state('SUSPENDED')).toMatchObject({ state: 'NOT_REACHED' });
    await pool.query("UPDATE organizations SET verification_state='SUSPENDED' WHERE id=$1", [org]);
    expect(await state('SUSPENDED')).toMatchObject({ state: 'REACHED' });

    // Never a job's content, a drive's college, a requester, an applicant or a candidate.
    const text = JSON.stringify(await pipeline());
    for (const secret of ['Confidential Role Title', 'SECRET-REF', 'Hidden College Name', college, job, body.workEmail, body.requesterName, body.companyName]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/applicant|candidate|title|requesterName|workEmail/i);
  });
});
