/**
 * Company profile and employer access requests (EMP-04).
 *
 * Pins the acceptance criteria and the rules in
 * docs/architecture/employer-access-requests-table-design.md:
 *  - owners and admins edit the student-facing fields (about, industry, size band, careers
 *    page); recruiters read; every field Operations verifies against — the legal name first —
 *    is refused from the employer side and nothing changes;
 *  - the organisation-state matrix of Appendix 2 §5.1 (organisation.manage);
 *  - students see the company profile on every job, list and detail;
 *  - the public access request creates only a pending request, answers the same whatever
 *    exists, is rate-limited, refuses webmail unless Operations allows it, lands in the
 *    Operations queue as pending, and never creates or verifies an organisation.
 *
 * Runs over real HTTP with a stub verifier and the real identity store. Needs a local
 * Postgres in DATABASE_URL; runs in a throwaway schema.
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
if (!connectionString) throw new Error('DATABASE_URL is required for company profile tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Company profile tests require local Postgres');
const schemaName = 'employer_company_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });

const identities = new Map<string, { readonly email: string }>();
let app: INestApplication;
let opsUserId: string;

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
  const platformId = await organization('PLATFORM', 'VERIFIED');
  opsUserId = await user();
  await membership(opsUserId, platformId, 'OPERATIONS_ADMIN');
}, 60_000);
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function user(email = randomUUID() + '@example.test'): Promise<string> {
  const id = randomUUID();
  identities.set(id, { email });
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, email]);
  return id;
}
type Verification = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
async function organization(kind: 'PLATFORM' | 'EMPLOYER' | 'INSTITUTION', verification: Verification, active = true, legalName = 'Company ' + randomUUID().slice(0, 8)): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,$2,$3,$4,$5)', [id, kind, legalName, verification, active]);
  return id;
}
async function profileRow(orgId: string, websiteUrl: string | null = 'https://www.acme-robotics.example'): Promise<void> {
  await pool.query(`INSERT INTO organization_profiles (organization_id, display_name, website_url, country_code, state_or_province, city, primary_contact_email)
    VALUES ($1, 'Acme Robotics', $2, 'IN', 'Karnataka', 'Bengaluru', 'hiring@acme-robotics.example')`, [orgId, websiteUrl]);
}
async function membership(userId: string, orgId: string, role: string, state = 'ACTIVE'): Promise<void> {
  const employerScope = ['EMPLOYER_OWNER', 'EMPLOYER_ADMIN', 'RECRUITER'].includes(role) ? orgId : null;
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,$5,$2,$6)`, [randomUUID(), orgId, userId, role, state, employerScope]);
}
const api = () => request(app.getHttpServer());
const auth = (subject: string) => ({ Authorization: 'Bearer ' + subject, 'X-Correlation-Id': randomUUID() });
const profilePath = (employerId: string) => '/api/v1/employers/' + employerId + '/company-profile';

async function employer(verification: Verification = 'VERIFIED', active = true, websiteUrl: string | null = 'https://www.acme-robotics.example') {
  const employerId = await organization('EMPLOYER', verification, active);
  await profileRow(employerId, websiteUrl);
  const ownerId = await user(); await membership(ownerId, employerId, 'EMPLOYER_OWNER');
  const adminId = await user(); await membership(adminId, employerId, 'EMPLOYER_ADMIN');
  const recruiterId = await user(); await membership(recruiterId, employerId, 'RECRUITER');
  return { employerId, ownerId, adminId, recruiterId };
}
const goodEdit = {
  about: 'We build warehouse robots and hire graduates into our controls and firmware teams.',
  industry: 'MANUFACTURING',
  companySizeBand: '201-1000',
  careersPageUrl: 'https://careers.acme-robotics.example/graduates',
};
async function storedProfile(orgId: string) {
  return (await pool.query(`SELECT o.legal_name, p.display_name, p.website_url, p.city, p.primary_contact_email,
      p.about_text, p.industry, p.company_size_band, p.careers_page_url
    FROM organizations o JOIN organization_profiles p ON p.organization_id = o.id WHERE o.id = $1`, [orgId])).rows[0];
}
const readinessKeys = /readiness|mastery|gapStatus|fitScore|score/i;

describe('EMP-04 company profile: who may edit what', () => {
  it('lets an owner and an admin edit the student-facing fields, audited, and a recruiter only read them', async () => {
    const { employerId, ownerId, adminId, recruiterId } = await employer();
    const saved = await api().post(profilePath(employerId)).set(auth(ownerId)).send(goodEdit).expect(201);
    expect(saved.body.companyProfile).toMatchObject({ about: goodEdit.about, industry: 'MANUFACTURING', companySizeBand: '201-1000',
      careersPageUrl: goodEdit.careersPageUrl, canEdit: true });
    await api().post(profilePath(employerId)).set(auth(adminId)).send({ companySizeBand: '1001-5000' }).expect(201);

    const read = await api().get(profilePath(employerId)).set(auth(recruiterId)).expect(200);
    expect(read.body.companyProfile).toMatchObject({
      displayName: 'Acme Robotics', websiteUrl: 'https://www.acme-robotics.example', city: 'Bengaluru', countryCode: 'IN',
      about: goodEdit.about, industry: 'MANUFACTURING', companySizeBand: '1001-5000', canEdit: false,
    });
    expect(read.body.companyProfile.operationsControlledFields).toEqual(expect.arrayContaining(['legalName', 'displayName', 'websiteUrl']));
    expect(JSON.stringify(Object.keys(read.body.companyProfile))).not.toMatch(readinessKeys);
    await api().post(profilePath(employerId)).set(auth(recruiterId)).send({ about: 'Recruiter edit' }).expect(403);
    expect((await storedProfile(employerId)).about_text).toBe(goodEdit.about);

    const audit = await pool.query("SELECT actor_user_id, organization_id, context FROM audit_events WHERE action='organization.company_profile.updated' AND resource_id=$1 ORDER BY occurred_at", [employerId]);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]).toMatchObject({ actor_user_id: ownerId, organization_id: employerId });
    expect(audit.rows[0].context.changedFields).toEqual(['about', 'industry', 'companySizeBand', 'careersPageUrl']);
    expect(audit.rows[1].context.changedFields).toEqual(['companySizeBand']);
    const outbox = await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='organization.company_profile.updated' AND aggregate_id=$1", [employerId]);
    expect(outbox.rows[0].n).toBe(2);
  });

  it('refuses a legal-name change, and every other field Operations verifies, from the employer side', async () => {
    const { employerId, ownerId } = await employer();
    const before = await storedProfile(employerId);
    for (const [field, value] of [['legalName', 'Impostor Holdings Pvt Ltd'], ['displayName', 'Impostor'], ['websiteUrl', 'https://impostor.example'],
      ['city', 'Pune'], ['countryCode', 'US'], ['primaryContactEmail', 'x@impostor.example'], ['addressLine1', '1 Fake Street']] as const) {
      const refused = await api().post(profilePath(employerId)).set(auth(ownerId)).send({ ...goodEdit, [field]: value }).expect(403);
      expect(refused.body.error.code).toBe('COMPANY_PROFILE_FIELD_OPERATIONS_CONTROLLED');
    }
    expect(await storedProfile(employerId)).toEqual(before);
  });

  it('keeps the careers page on the verified website domain, and refuses payment demands', async () => {
    const { employerId, ownerId } = await employer();
    const offDomain = await api().post(profilePath(employerId)).set(auth(ownerId)).send({ careersPageUrl: 'https://acme-robotics.example.evil.test/jobs' }).expect(400);
    expect(offDomain.body.error.code).toBe('COMPANY_PROFILE_CAREERS_URL_OFF_DOMAIN');
    await api().post(profilePath(employerId)).set(auth(ownerId)).send({ careersPageUrl: 'https://acme-robotics.example/jobs' }).expect(201);
    const fee = await api().post(profilePath(employerId)).set(auth(ownerId))
      .send({ about: 'Selected candidates must pay a registration fee of INR 5000 before joining.' }).expect(400);
    expect(fee.body.error.code).toBe('COMPANY_PROFILE_PAYMENT_DEMAND');

    const noWebsite = await employer('VERIFIED', true, null);
    const unanchored = await api().post(profilePath(noWebsite.employerId)).set(auth(noWebsite.ownerId)).send({ careersPageUrl: 'https://anything.example/jobs' }).expect(400);
    expect(unanchored.body.error.code).toBe('COMPANY_PROFILE_CAREERS_URL_OFF_DOMAIN');
  });

  it('validates input and lets fields be cleared', async () => {
    const { employerId, ownerId } = await employer();
    await api().post(profilePath(employerId)).set(auth(ownerId)).send({ ...goodEdit, tagline: 'x' }).expect(400);
    await api().post(profilePath(employerId)).set(auth(ownerId)).send({ industry: 'CRYPTO' }).expect(400);
    await api().post(profilePath(employerId)).set(auth(ownerId)).send({ companySizeBand: '12' }).expect(400);
    await api().post(profilePath(employerId)).set(auth(ownerId)).send({ about: 'x'.repeat(2001) }).expect(400);
    await api().post(profilePath(employerId)).set(auth(ownerId)).send({ careersPageUrl: 'http://acme-robotics.example/jobs' }).expect(400);
    await api().post(profilePath(employerId)).set(auth(ownerId)).send({}).expect(400);
    await api().post(profilePath(employerId)).set(auth(ownerId)).send(goodEdit).expect(201);
    const cleared = await api().post(profilePath(employerId)).set(auth(ownerId)).send({ about: null, careersPageUrl: '' }).expect(201);
    expect(cleared.body.companyProfile).toMatchObject({ about: null, careersPageUrl: null, industry: 'MANUFACTURING' });
  });

  it('answers 409 when Operations has not set up the profile row, rather than inventing one', async () => {
    const employerId = await organization('EMPLOYER', 'VERIFIED');
    const ownerId = await user(); await membership(ownerId, employerId, 'EMPLOYER_OWNER');
    const read = await api().get(profilePath(employerId)).set(auth(ownerId)).expect(200);
    expect(read.body.companyProfile).toMatchObject({ displayName: null, about: null, countryCode: null });
    const refused = await api().post(profilePath(employerId)).set(auth(ownerId)).send(goodEdit).expect(409);
    expect(refused.body.error.code).toBe('COMPANY_PROFILE_NOT_SET_UP');
  });

  it('survives an Operations edit: the employer fields are not wiped by the Operations profile update', async () => {
    const { employerId, ownerId } = await employer();
    await api().post(profilePath(employerId)).set(auth(ownerId)).send(goodEdit).expect(201);
    await api().patch('/api/v1/operations/organizations/' + employerId).set(auth(opsUserId))
      .send({ legalName: 'Acme Robotics Private Limited', profile: { displayName: 'Acme Robotics', countryCode: 'IN', city: 'Mysuru', websiteUrl: 'https://www.acme-robotics.example' } }).expect(200);
    expect(await storedProfile(employerId)).toMatchObject({ legal_name: 'Acme Robotics Private Limited', city: 'Mysuru', about_text: goodEdit.about, industry: 'MANUFACTURING' });
  });

  it('refuses company-profile fields on an institution at the database', async () => {
    const institutionId = await organization('INSTITUTION', 'VERIFIED');
    await expect(pool.query("INSERT INTO organization_profiles (organization_id, country_code, industry) VALUES ($1,'IN','EDUCATION')", [institutionId]))
      .rejects.toThrow(/only valid for employer/);
  });
});

describe('EMP-04 company profile: organisation state and membership (Appendix 2 §5.1)', () => {
  it.each(['PENDING', 'UNDER_REVIEW'] as const)('lets a %s employer set up its profile before verification', async (verification) => {
    const { employerId, ownerId } = await employer(verification);
    await api().get(profilePath(employerId)).set(auth(ownerId)).expect(200);
    await api().post(profilePath(employerId)).set(auth(ownerId)).send(goodEdit).expect(201);
  });

  it.each([['SUSPENDED', false], ['REJECTED', true]] as const)('refuses a %s employer both reading and editing', async (verification, active) => {
    const { employerId, ownerId, recruiterId } = await employer(verification, active);
    for (const actor of [ownerId, recruiterId]) {
      const read = await api().get(profilePath(employerId)).set(auth(actor)).expect(403);
      expect(read.body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    }
    const write = await api().post(profilePath(employerId)).set(auth(ownerId)).send(goodEdit).expect(403);
    expect(write.body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    expect((await storedProfile(employerId)).about_text).toBeNull();
  });

  it('refuses another employer, ended and suspended memberships, and answers 401 without a token', async () => {
    const { employerId } = await employer();
    const other = await employer();
    const ended = await user(); await membership(ended, employerId, 'EMPLOYER_OWNER', 'ENDED');
    const suspended = await user(); await membership(suspended, employerId, 'EMPLOYER_OWNER', 'SUSPENDED');
    for (const actor of [other.ownerId, ended, suspended]) {
      await api().get(profilePath(employerId)).set(auth(actor)).expect(403);
      await api().post(profilePath(employerId)).set(auth(actor)).send(goodEdit).expect(403);
    }
    await api().get(profilePath(employerId)).expect(401);
    await api().post(profilePath(employerId)).send(goodEdit).expect(401);
  });
});

describe('EMP-04 students see the company profile on every job', () => {
  it('carries the company block in the listing and the detail of a published job', async () => {
    const { employerId, ownerId, recruiterId } = await employer();
    await api().post(profilePath(employerId)).set(auth(ownerId)).send(goodEdit).expect(201);
    const opportunityId = randomUUID(); const versionId = randomUUID();
    await pool.query(`INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code,lifecycle_state)
      VALUES ($1,$2,$3,$4,'DRAFT')`, [opportunityId, employerId, recruiterId, 'CP-' + opportunityId.slice(0, 8)]);
    await pool.query(`INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,summary,employment_type,work_mode,compensation_disclosed,material_terms_hash,created_by_user_id)
      VALUES ($1,$2,1,'Controls engineer','Tune motion controllers.','FULL_TIME','REMOTE',false,repeat('0',64),$3)`, [versionId, opportunityId, recruiterId]);
    await pool.query('UPDATE opportunities SET current_version_id=$1 WHERE id=$2', [versionId, opportunityId]);
    await pool.query("INSERT INTO opportunity_audiences (id,opportunity_id,audience_kind) VALUES ($1,$2,'PUBLIC')", [randomUUID(), opportunityId]);
    await api().post('/api/v1/employers/' + employerId + '/opportunities/' + opportunityId + '/publish').set(auth(recruiterId)).expect(201);

    const studentId = await user();
    const company = {
      displayName: 'Acme Robotics', industry: 'MANUFACTURING', companySizeBand: '201-1000', about: goodEdit.about,
      websiteUrl: 'https://www.acme-robotics.example', careersPageUrl: goodEdit.careersPageUrl, city: 'Bengaluru', stateOrProvince: 'Karnataka', countryCode: 'IN',
    };
    const listed = await api().get('/api/v1/opportunities').set(auth(studentId)).expect(200);
    const item = listed.body.opportunities.find((entry: { id: string }) => entry.id === opportunityId);
    expect(item.company).toEqual(company);
    const detail = await api().get('/api/v1/opportunities/' + opportunityId).set(auth(studentId)).expect(200);
    expect(detail.body.opportunity.company).toEqual(company);
    // The contact email is for Operations, not for students.
    expect(JSON.stringify(detail.body)).not.toContain('hiring@acme-robotics.example');
  });
});

const requestPath = '/api/v1/employer-access-requests';
let addressCounter = 10;
const nextAddress = () => '203.0.113.' + (addressCounter++ % 250);
function accessRequest(overrides: Record<string, unknown> = {}) {
  const domain = 'firm-' + randomUUID().slice(0, 8) + '.example';
  return { requesterName: 'Priya Raman', companyName: 'Firm ' + domain, workEmail: 'priya@' + domain, websiteUrl: 'https://www.' + domain, ...overrides };
}
const submit = (body: unknown, address = nextAddress()) => api().post(requestPath).set('X-Forwarded-For', address).send(body as object);

describe('EMP-04 public employer access request', () => {
  it('records a pending request and creates nothing else — no user, organisation, membership or invitation', async () => {
    const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM organizations)::int AS orgs,
      (SELECT count(*) FROM organization_memberships)::int AS memberships, (SELECT count(*) FROM invitations)::int AS invitations`)).rows[0];
    const before = await counts();
    const body = accessRequest({ workEmail: 'Priya@Acme-Robotics.example', websiteUrl: 'https://www.acme-robotics.example' });
    const response = await submit(body).expect(202);
    expect(response.body).toEqual({ received: true, correlationId: expect.any(String) });
    expect(await counts()).toEqual(before);
    const row = (await pool.query("SELECT * FROM employer_access_requests WHERE work_email='priya@acme-robotics.example'")).rows[0];
    expect(row).toMatchObject({ state: 'PENDING', email_domain: 'acme-robotics.example', email_matches_website: true, free_mail: false, organization_id: null, submission_count: 1 });
    const outbox = await pool.query("SELECT actor_user_id FROM outbox_events WHERE event_type='employer_access_request.submitted' AND aggregate_id=$1", [row.id]);
    expect(outbox.rows).toEqual([{ actor_user_id: null }]);
  });

  it('answers identically for a repeat and for a company already on ONE, so it cannot be used to enumerate', async () => {
    const legalName = 'Known Employer ' + randomUUID().slice(0, 6);
    await organization('EMPLOYER', 'VERIFIED', true, legalName);
    const first = accessRequest();
    const a = await submit(first).expect(202);
    const b = await submit(first).expect(202);
    const c = await submit(accessRequest({ companyName: legalName })).expect(202);
    for (const response of [a, b, c]) expect(Object.keys(response.body).sort()).toEqual(['correlationId', 'received']);
    const rows = await pool.query('SELECT submission_count FROM employer_access_requests WHERE work_email=$1', [first.workEmail]);
    expect(rows.rows).toEqual([{ submission_count: 2 }]);
  });

  it('refuses a public webmail address unless Operations allows it, then flags it', async () => {
    const refused = await submit(accessRequest({ workEmail: 'someone.hiring@gmail.com' })).expect(400);
    expect(refused.body.error.code).toBe('EMPLOYER_ACCESS_REQUEST_WORK_EMAIL_REQUIRED');
    await pool.query("UPDATE feature_flags SET enabled=true WHERE key='employer-access.allow-free-mail'");
    try {
      await submit(accessRequest({ workEmail: 'someone.hiring@gmail.com' })).expect(202);
      expect((await pool.query("SELECT free_mail, email_matches_website FROM employer_access_requests WHERE work_email='someone.hiring@gmail.com'")).rows[0])
        .toEqual({ free_mail: true, email_matches_website: false });
    } finally {
      await pool.query("UPDATE feature_flags SET enabled=false WHERE key='employer-access.allow-free-mail'");
    }
  });

  it('rate-limits by network address and by email domain, without saying anything about records', async () => {
    const address = nextAddress();
    for (let i = 0; i < 5; i += 1) await submit(accessRequest(), address).expect(202);
    const limited = await submit(accessRequest(), address).expect(429);
    expect(limited.body.error.code).toBe('EMPLOYER_ACCESS_REQUEST_RATE_LIMITED');
    await submit(accessRequest(), nextAddress()).expect(202);

    const domain = 'busy-' + randomUUID().slice(0, 8) + '.example';
    for (let i = 0; i < 10; i += 1) {
      await submit(accessRequest({ workEmail: 'person' + i + '@' + domain, websiteUrl: 'https://' + domain }), nextAddress()).expect(202);
    }
    await submit(accessRequest({ workEmail: 'person-eleven@' + domain, websiteUrl: 'https://' + domain }), nextAddress()).expect(429);
    // Only digests of the address are stored.
    const keys = await pool.query('SELECT client_key FROM employer_access_request_attempts');
    expect(keys.rows.every((row: { client_key: string }) => /^[0-9a-f]{64}$/.test(row.client_key))).toBe(true);
    expect(JSON.stringify(keys.rows)).not.toContain(address);
  });

  it('validates the form and refuses unknown fields', async () => {
    await submit({ ...accessRequest(), phone: '999' }).expect(400);
    await submit(accessRequest({ websiteUrl: 'http://plain.example' })).expect(400);
    await submit(accessRequest({ workEmail: 'not-an-email' })).expect(400);
    await submit(accessRequest({ requesterName: '' })).expect(400);
    await submit(accessRequest({ companyName: 'x'.repeat(181) })).expect(400);
    await submit('text').expect(400);
  });
});

describe('EMP-04 access requests in the Operations queue', () => {
  const queuePath = '/api/v1/operations/employer-access-requests';

  it('shows requests as pending to Operations only, with possible matches, and records a decision without verifying anything', async () => {
    const legalName = 'Queue Employer ' + randomUUID().slice(0, 6);
    const existingEmployerId = await organization('EMPLOYER', 'PENDING', true, legalName);
    const body = accessRequest({ companyName: legalName });
    await submit(body).expect(202);

    await api().get(queuePath).expect(401);
    const { ownerId } = await employer();
    await api().get(queuePath).set(auth(ownerId)).expect(403);

    const queue = await api().get(queuePath + '?state=PENDING&limit=200').set(auth(opsUserId)).expect(200);
    const listed = queue.body.requests.find((entry: { workEmail: string }) => entry.workEmail === body.workEmail);
    expect(listed).toMatchObject({ state: 'PENDING', companyName: legalName, emailConfirmed: false, freeMail: false, emailMatchesWebsite: true });
    expect(listed.possibleMatches).toEqual([{ organizationId: existingEmployerId, legalName, verificationState: 'PENDING' }]);

    const decisionPath = queuePath + '/' + listed.id + '/decision';
    await api().post(decisionPath).set(auth(ownerId)).send({ decision: 'DECLINED', reasonCode: 'NOT_AN_EMPLOYER' }).expect(403);
    await api().post(decisionPath).set(auth(opsUserId)).send({ decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED' }).expect(400);
    const institutionId = await organization('INSTITUTION', 'VERIFIED');
    await api().post(decisionPath).set(auth(opsUserId)).send({ decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: institutionId }).expect(400);
    await api().post(decisionPath).set(auth(opsUserId)).send({ decision: 'VERIFIED', reasonCode: 'ORGANISATION_CREATED' }).expect(400);

    const decided = await api().post(decisionPath).set(auth(opsUserId))
      .send({ decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: existingEmployerId }).expect(201);
    expect(decided.body.request).toMatchObject({ id: listed.id, state: 'ONBOARDED', organizationId: existingEmployerId });
    await api().post(decisionPath).set(auth(opsUserId)).send({ decision: 'SPAM', reasonCode: 'BULK_SUBMISSION' }).expect(409);

    // Onboarding a request never verifies the organisation.
    expect((await pool.query('SELECT verification_state FROM organizations WHERE id=$1', [existingEmployerId])).rows[0].verification_state).toBe('PENDING');
    const audit = await pool.query("SELECT actor_user_id, context FROM audit_events WHERE action='employer_access_request.decided' AND resource_id=$1", [listed.id]);
    expect(audit.rows).toEqual([{ actor_user_id: opsUserId, context: { decision: 'ONBOARDED', reasonCode: 'ORGANISATION_CREATED', organizationId: existingEmployerId } }]);
    const pending = await api().get(queuePath + '?state=PENDING&limit=200').set(auth(opsUserId)).expect(200);
    expect(pending.body.requests.map((entry: { id: string }) => entry.id)).not.toContain(listed.id);
  });

  it('paginates the queue with a bounded page size and validates the query', async () => {
    for (let i = 0; i < 3; i += 1) await submit(accessRequest()).expect(202);
    const first = await api().get(queuePath + '?limit=2').set(auth(opsUserId)).expect(200);
    expect(first.body.requests).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api().get(queuePath + '?limit=2&cursor=' + encodeURIComponent(first.body.nextCursor)).set(auth(opsUserId)).expect(200);
    expect(second.body.requests[0].id).not.toBe(first.body.requests[1].id);
    await api().get(queuePath + '?limit=201').set(auth(opsUserId)).expect(400);
    await api().get(queuePath + '?state=VERIFIED').set(auth(opsUserId)).expect(400);
    await api().get(queuePath + '?cursor=nonsense').set(auth(opsUserId)).expect(400);
    await api().get(queuePath + '?extra=1').set(auth(opsUserId)).expect(400);
  });
});
