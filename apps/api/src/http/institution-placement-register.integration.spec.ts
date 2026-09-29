/**
 * Placement register, statistics and drive categories (INST-12).
 *
 * Acceptance: every count reconciles with consented application records for a fixture dataset, and
 * a student who shared nothing counts as "not shared", never as unplaced. Plus Appendix 3 §6.3:
 * scope (head A cannot see department B; admin sees both), relationship (transferred students leave,
 * graduated students stay in their season), consent (revoked sharing drops out on the next request),
 * contract (no compensation, no numeric readiness), aggregates (<5 withheld, margins that would
 * reveal one withheld), API (401, 403, 400, audit rows).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for placement register tests');
const schemaName = 'placereg_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;
let institutionId: string; let otherInstitutionId: string;
let departmentA: string; let departmentB: string; let batchA1: string; let batchB1: string;
let admin: Staff; let officer: Staff; let officerB: Staff; let headA: Staff; let headB: Staff; let faculty: Staff; let otherAdmin: Staff;

interface Student { userId: string; name: string }
interface Staff { id: string; membershipId: string }

/** Inside the last ended month (the statistics period); "now" is after it. */
const PAST = "(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '10 days'";
const EARLIER = "(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '20 days'";

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
        if (!tokens.has(token)) throw new Error('Invalid local test identity');
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
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
}, 120_000);
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  tokens.clear();
  institutionId = randomUUID(); otherInstitutionId = randomUUID();
  departmentA = randomUUID(); departmentB = randomUUID(); batchA1 = randomUUID(); batchB1 = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute','VERIFIED',true), ($2,'INSTITUTION','Other Institute','VERIFIED',true)", [institutionId, otherInstitutionId]);
  await unit(departmentA, 'DEPARTMENT', 'Department A', null);
  await unit(departmentB, 'DEPARTMENT', 'Department B', null);
  await unit(batchA1, 'BATCH', 'Batch A1', departmentA);
  await unit(batchB1, 'BATCH', 'Batch B1', departmentB);
  admin = await staff('INSTITUTION_ADMIN');
  officer = await staff('PLACEMENT_ADMIN');
  officerB = await staff('PLACEMENT_ADMIN', departmentB);
  headA = await staff('DEPARTMENT_HEAD', departmentA);
  headB = await staff('DEPARTMENT_HEAD', departmentB);
  faculty = await staff('FACULTY_LECTURER');
  otherAdmin = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);
});
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 120_000);

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
let rollSequence = 0;
async function student(department: string, batch: string, relationship: { state?: string; endedAt?: string } = {}): Promise<Student> {
  const userId = randomUUID(); rollSequence += 1;
  const name = 'Student ' + rollSequence;
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  const state = relationship.state ?? 'ACTIVE';
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), institutionId, userId, 'R-' + rollSequence, name, state, department, batch]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to)
    VALUES ($1,$2,$3,$4,'2020-01-01T00:00:00Z',${relationship.endedAt ?? 'NULL'})`, [randomUUID(), institutionId, userId, state]);
  return { userId, name };
}
async function staff(role: string, department: string | null = null, organization = institutionId): Promise<Staff> {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, organization, id, role, department]);
  return { id, membershipId };
}
async function employer(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER',$2,'VERIFIED',true)", [id, name]);
  return id;
}
async function job(employerId: string, title = 'Graduate engineer', published = false): Promise<string> {
  const opportunity = randomUUID(); const version = randomUUID();
  await pool.query('INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)', [opportunity, employerId, admin.id, 'LOCAL-' + opportunity.slice(0, 8)]);
  await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id) VALUES ($1,$2,1,$3,'FULL_TIME','REMOTE',$4,$5)", [version, opportunity, title, '0'.repeat(64), admin.id]);
  await pool.query(`UPDATE opportunities SET current_version_id=$2 ${published ? ", lifecycle_state='PUBLISHED', published_at=" + PAST : ''} WHERE id=$1`, [opportunity, version]);
  return opportunity;
}
interface ApplicationOptions {
  state?: string; shared?: boolean; at?: string; offer?: string; offerAt?: string; shortlistHistory?: boolean;
  opportunity?: { id: string; employerId: string };
}
/** A shared native application dated in the last ended month unless told otherwise; an optional offer. */
async function application(subject: Student, options: ApplicationOptions = {}): Promise<string> {
  const state = options.state ?? 'APPLIED';
  const at = options.at ?? PAST;
  let target = options.opportunity;
  if (!target) { const employerId = await employer('Employer ' + randomUUID().slice(0, 6)); target = { id: await job(employerId), employerId }; }
  const version = (await pool.query('SELECT current_version_id FROM opportunities WHERE id=$1', [target.id])).rows[0].current_version_id;
  const id = randomUUID();
  const closed = ['HIRED', 'REJECTED', 'WITHDRAWN'].includes(state) ? at : 'NULL';
  await pool.query(`INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,closed_at,created_at,updated_at,institution_visibility_granted_at)
    VALUES ($1,$2,$3,$4,$5,$6,${at},${at},${closed},${at},${at},${options.shared === false ? 'NULL' : at})`, [id, target.id, target.employerId, version, subject.userId, state]);
  if (options.shortlistHistory) {
    await pool.query(`INSERT INTO application_state_history (id,application_id,from_state,to_state,occurred_at) VALUES ($1,$2,'APPLIED','SHORTLISTED',${at})`, [randomUUID(), id]);
  }
  if (options.offer) {
    const offerAt = options.offerAt ?? at;
    await pool.query(`INSERT INTO offers (id,application_id,employer_id,state,compensation_currency,compensation_amount,compensation_period,offer_expires_at,extended_at,responded_at,withdrawn_at,created_by_user_id,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'INR',900000,'YEAR',${offerAt} + interval '60 days',${offerAt},${['ACCEPTED', 'DECLINED'].includes(options.offer) ? offerAt : 'NULL'},${options.offer === 'WITHDRAWN' ? offerAt : 'NULL'},$5,${offerAt},${offerAt})`,
    [randomUUID(), id, target.employerId, options.offer, admin.id]);
  }
  return id;
}
async function drive(employerId: string, opportunityId: string, state: string, institution = institutionId): Promise<string> {
  const id = randomUUID();
  const decided = ['APPROVED', 'SCHEDULED', 'REJECTED', 'CHANGES_REQUESTED', 'COMPLETED'].includes(state);
  const closed = ['COMPLETED', 'CANCELLED'].includes(state);
  await pool.query(`INSERT INTO campus_drives (id,employer_id,opportunity_id,institution_id,requested_by_user_id,state,scheduled_start_at,decided_by_user_id,decided_at,decision_reason_code,closed_by_user_id,closed_at,close_reason_code)
    VALUES ($1,$2,$3,$4,$5,$6,${state === 'SCHEDULED' || state === 'COMPLETED' ? PAST : 'NULL'},${decided ? '$5' : 'NULL'},${decided ? EARLIER : 'NULL'},
      ${['REJECTED', 'CHANGES_REQUESTED'].includes(state) ? "'DETAILS_MISSING'" : 'NULL'},${closed ? '$5' : 'NULL'},${closed ? 'now()' : 'NULL'},${state === 'CANCELLED' ? "'SEASON_CLOSED'" : 'NULL'})`,
  [id, employerId, opportunityId, institution, admin.id, state]);
  return id;
}
async function linkToDrive(driveId: string, opportunityId: string, applicationId: string) {
  await pool.query('INSERT INTO campus_drive_applications (campus_drive_id,application_id,opportunity_id) VALUES ($1,$2,$3)', [driveId, applicationId, opportunityId]);
}

const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
type Count = { suppressed: boolean; value: number | null };
interface StatsRow { eligible: Count; notShared: Count; applied: Count; shortlisted: Count; withOffer: Count; placed: Count; placementPercentage: number | null; offersPerPlacedStudent: number | null }
interface Stats { asOf: { month: string; lastDay: string }; overall: StatsRow; groups: (StatsRow & { department: { name: string } | null; batch: { name: string } | null })[]; offersByMonth: { month: string; offers: Count }[] }
const statistics = async (actor: Staff) => (await api().get(base() + '/placement-statistics').set(auth(actor.id)).expect(200)).body as Stats;
const shown = (value: number): Count => ({ suppressed: false, value });
const withheld: Count = { suppressed: true, value: null };
function expectNoPayOrNumericReadiness(body: unknown) {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/compensation|salary|stipend|ctc|package|900000/i);
  expect(text).not.toMatch(/readiness/i);
}
const audits = async (action: string) => (await pool.query('SELECT actor_user_id, outcome, resource_id, organization_id, context FROM audit_events WHERE action=$1 ORDER BY occurred_at', [action])).rows;

/**
 * Department A, Batch A1: 30 students, six in each stage as of the end of last month, including the
 * awkward ones — an unshared acceptance, a revoked share, an acceptance dated this month, a hire with
 * no offer, a graduate — and one transferred student who must not be counted at all.
 */
async function seasonFixture(): Promise<{ revoked: string }> {
  // Not shared (6): five with nothing (one of whom stopped sharing a hire), one with an accepted offer they kept private.
  const quiet = await student(departmentA, batchA1);
  for (let index = 0; index < 4; index += 1) await student(departmentA, batchA1);
  await application(await student(departmentA, batchA1), { state: 'HIRED', shared: false, offer: 'ACCEPTED' });
  // Applied (6): one of them also had an offer accepted this month — after the period, so still "applied".
  for (let index = 0; index < 5; index += 1) await application(await student(departmentA, batchA1));
  const late = await student(departmentA, batchA1);
  await application(late, { state: 'APPLIED', at: PAST, offer: 'ACCEPTED', offerAt: 'now()' });
  // Shortlisted (6): four by current state, two by history (then rejected).
  for (let index = 0; index < 4; index += 1) await application(await student(departmentA, batchA1), { state: 'INTERVIEW' });
  for (let index = 0; index < 2; index += 1) await application(await student(departmentA, batchA1), { state: 'REJECTED', shortlistHistory: true });
  // With an offer, not placed (6): five awaiting an answer, one declined.
  for (let index = 0; index < 5; index += 1) await application(await student(departmentA, batchA1), { state: 'OFFER', offer: 'EXTENDED' });
  await application(await student(departmentA, batchA1), { state: 'OFFER', offer: 'DECLINED' });
  // Placed (6): four accepted offers, one graduate who accepted before leaving, one hire without an offer.
  for (let index = 0; index < 4; index += 1) await application(await student(departmentA, batchA1), { state: 'HIRED', offer: 'ACCEPTED' });
  const graduate = await student(departmentA, batchA1, { state: 'GRADUATED', endedAt: "(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '2 days'" });
  await application(graduate, { state: 'HIRED', offer: 'ACCEPTED' });
  await application(graduate, { state: 'OFFER', offer: 'DECLINED' });   // a second offer: 6 offers over 6 placed
  await application(await student(departmentA, batchA1), { state: 'HIRED' });
  const revoked = await application(quiet, { state: 'HIRED', offer: 'ACCEPTED' });
  await pool.query('UPDATE applications SET institution_visibility_revoked_at=now() WHERE id=$1', [revoked]);
  // Transferred out before the period ended: not eligible, whatever they shared.
  const transferred = await student(departmentA, batchA1, { state: 'TRANSFERRED', endedAt: EARLIER });
  await application(transferred, { state: 'HIRED', offer: 'ACCEPTED', at: "(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '40 days'" });
  return { revoked };
}

describe('placement statistics', () => {
  it('reconciles every count with the consented records, and never counts a student who shared nothing as unplaced', async () => {
    await seasonFixture();
    const body = await statistics(admin);
    expect(body.groups).toHaveLength(1);
    const row = body.groups[0]!;
    expect(row.department?.name).toBe('Department A');
    expect(row.batch?.name).toBe('Batch A1');
    expect(row.eligible).toEqual(shown(30));
    expect(row.notShared).toEqual(shown(6));
    expect(row.applied).toEqual(shown(24));
    expect(row.shortlisted).toEqual(shown(18));
    expect(row.withOffer).toEqual(shown(12));
    expect(row.placed).toEqual(shown(6));
    // 6 placed of the 24 who shared — the 6 who shared nothing are not in the denominator.
    expect(row.placementPercentage).toBe(25);
    expect(row.offersPerPlacedStudent).toBe(1);
    expect(body.overall).toMatchObject({ eligible: shown(30), notShared: shown(6), applied: shown(24), placed: shown(6), placementPercentage: 25 });
    // The last six ended months of offers: this month's acceptance is not in any of them.
    expect(body.offersByMonth).toHaveLength(6);
    expect(body.offersByMonth.at(-1)).toEqual({ month: body.asOf.month, offers: shown(12) });
    expectNoPayOrNumericReadiness(body);
  });

  it('drops a revoked share on the next request, and counts a newly shared one', async () => {
    await seasonFixture();
    const placed = (await pool.query("SELECT a.id FROM applications a WHERE a.state='HIRED' AND a.institution_visibility_revoked_at IS NULL AND a.institution_visibility_granted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.application_id=a.id)")).rows[0].id as string;
    await pool.query('UPDATE applications SET institution_visibility_revoked_at=now() WHERE id=$1', [placed]);
    const row = (await statistics(officer)).groups[0]!;
    // The hire without an offer stops counting on the next request: 5 placed, 7 not shared.
    expect(row.placed).toEqual(shown(5));
    expect(row.notShared).toEqual(shown(7));
    expect(row.eligible).toEqual(shown(30));
    // The student who kept an acceptance private shares it now: it counts on the next request.
    await pool.query('UPDATE applications SET institution_visibility_granted_at=now() WHERE institution_visibility_granted_at IS NULL');
    const after = (await statistics(officer)).groups[0]!;
    expect(after.placed).toEqual(shown(6));
    expect(after.notShared).toEqual(shown(6));
  });

  it('limits each reader to their scope and withholds small groups and the margins that would reveal them', async () => {
    await seasonFixture();
    for (let index = 0; index < 3; index += 1) await application(await student(departmentB, batchB1), { state: 'HIRED', offer: 'ACCEPTED' });
    const adminView = await statistics(admin);
    expect(adminView.groups.map((group) => group.department?.name)).toEqual(['Department A', 'Department B']);
    const b = adminView.groups[1]!;
    expect(b).toMatchObject({ eligible: withheld, placed: withheld, placementPercentage: null, offersPerPlacedStudent: null });
    // Placed overall (9) would give department B's 3 back from department A's 6.
    expect(adminView.overall.placed).toEqual(withheld);
    expect(adminView.overall.eligible).toEqual(withheld);
    expect(adminView.overall.placementPercentage).toBeNull();
    // Department A's own figures are unchanged.
    expect(adminView.groups[0]!.placed).toEqual(shown(6));

    const headAView = await statistics(headA);
    expect(headAView.groups.map((group) => group.department?.name)).toEqual(['Department A']);
    expect(headAView.overall.eligible).toEqual(shown(30));
    const headBView = await statistics(headB);
    expect(JSON.stringify(headBView)).not.toContain('Department A');
    expect(headBView.overall.eligible).toEqual(withheld);
    const narrowed = await statistics(officerB);
    expect(narrowed.groups.map((group) => group.department?.name)).toEqual(['Department B']);
  });

  it('refuses faculty, other colleges and anonymous callers', async () => {
    await api().get(base() + '/placement-statistics').expect(401);
    await api().get(base() + '/placement-statistics').set(auth(faculty.id)).expect(403);
    await api().get(base() + '/placement-statistics').set(auth(otherAdmin.id)).expect(403);
    await api().get(base() + '/placement-register').set(auth(faculty.id)).expect(403);
    await api().get(base() + '/placement-register').set(auth(otherAdmin.id)).expect(403);
    await api().get(base() + '/drive-categories').set(auth(faculty.id)).expect(403);
  });
});

describe('placement register', () => {
  it('lists engaged employers and the drive calendar, with outcomes over shared applications only', async () => {
    const drivingEmployer = await employer('Drive Employer');
    const driveJob = await job(drivingEmployer, 'Campus engineer');
    const completed = await drive(drivingEmployer, driveJob, 'COMPLETED');
    // Fifteen shared through the drive (five placed, five offered, five applied only), one placed but
    // not shared. Every stage holds five: an empty stage would withhold the total (zero is under five).
    for (let index = 0; index < 5; index += 1) {
      await linkToDrive(completed, driveJob, await application(await student(departmentA, batchA1), { state: 'OFFER', offer: 'EXTENDED', opportunity: { id: driveJob, employerId: drivingEmployer } }));
      await linkToDrive(completed, driveJob, await application(await student(departmentA, batchA1), { state: 'HIRED', offer: 'ACCEPTED', opportunity: { id: driveJob, employerId: drivingEmployer } }));
      await linkToDrive(completed, driveJob, await application(await student(departmentA, batchA1), { opportunity: { id: driveJob, employerId: drivingEmployer } }));
    }
    await linkToDrive(completed, driveJob, await application(await student(departmentA, batchA1), { state: 'HIRED', offer: 'ACCEPTED', shared: false, opportunity: { id: driveJob, employerId: drivingEmployer } }));
    const scheduledJob = await job(drivingEmployer, 'Analyst');
    await drive(drivingEmployer, scheduledJob, 'SCHEDULED');
    const addressing = await employer('Addressing Employer');
    const addressed = await job(addressing, 'Associate', true);
    await pool.query("INSERT INTO opportunity_audiences (id,opportunity_id,audience_kind,institution_id) VALUES ($1,$2,'INSTITUTION',$3)", [randomUUID(), addressed, institutionId]);
    const asking = await employer('Asking Employer');
    await drive(asking, await job(asking), 'REQUESTED');
    const elsewhere = await employer('Elsewhere Employer');
    await drive(elsewhere, await job(elsewhere), 'APPROVED', otherInstitutionId);

    const body = (await api().get(base() + '/placement-register').set(auth(officer.id)).expect(200)).body;
    const names = body.employers.map((entry: { name: string }) => entry.name).sort();
    expect(names).toEqual(['Addressing Employer', 'Drive Employer']);
    expect(body.employers.find((entry: { name: string }) => entry.name === 'Drive Employer')).toMatchObject({ drives: { approved: 0, scheduled: 1, completed: 1 }, jobsAddressedToCollege: 0 });
    expect(body.employers.find((entry: { name: string }) => entry.name === 'Addressing Employer')).toMatchObject({ drives: { approved: 0, scheduled: 0, completed: 0 }, jobsAddressedToCollege: 1 });
    expect(body.drives).toHaveLength(2);
    const done = body.drives.find((entry: { id: string }) => entry.id === completed);
    // Sixteen applied through the drive; the register counts the fifteen who shared.
    expect(done.outcome).toEqual({ studentsSharing: shown(15), withOffer: shown(10), placed: shown(5) });
    expect(body.drives.find((entry: { state: string }) => entry.state === 'SCHEDULED').outcome).toBeNull();
    expectNoPayOrNumericReadiness(body);

    // A department head outside the drive's students sees the drive but none of its outcome counts.
    const headBView = (await api().get(base() + '/placement-register').set(auth(headB.id)).expect(200)).body;
    expect(headBView.drives.find((entry: { id: string }) => entry.id === completed).outcome).toEqual({ studentsSharing: withheld, withOffer: withheld, placed: withheld });
  });
});

describe('drive categories', () => {
  it('lets the placement office define categories, label drives and retire them, audited; never for employers', async () => {
    const created = (await api().post(base() + '/drive-categories').set(auth(admin.id)).send({ name: 'Dream', description: 'Top product companies', rank: 1 }).expect(201)).body.category;
    await api().post(base() + '/drive-categories').set(auth(officer.id)).send({ name: 'Core', rank: 2 }).expect(201);
    await api().post(base() + '/drive-categories').set(auth(admin.id)).send({ name: 'dream' }).expect(409);
    await api().post(base() + '/drive-categories').set(auth(admin.id)).send({ name: '=HYPERLINK()' }).expect(400);
    await api().post(base() + '/drive-categories').set(auth(admin.id)).send({ name: 'Mass', colour: 'red' }).expect(400);
    await api().post(base() + '/drive-categories').set(auth(admin.id)).send({ name: 'Mass', rank: 50 }).expect(400);
    await api().post(base() + '/drive-categories').set(auth(headA.id)).send({ name: 'Mass' }).expect(403);
    const narrowed = await api().post(base() + '/drive-categories').set(auth(officerB.id)).send({ name: 'Mass' }).expect(403);
    expect(narrowed.body.error.code).toBe('INSTITUTION_WIDE_SCOPE_REQUIRED');
    await api().post(base() + '/drive-categories').set(auth(otherAdmin.id)).send({ name: 'Mass' }).expect(403);

    const listed = (await api().get(base() + '/drive-categories').set(auth(headA.id)).expect(200)).body;
    expect(listed.categories.map((entry: { name: string }) => entry.name)).toEqual(['Dream', 'Core']);
    expect(listed.canManage).toBe(false);

    const employerId = await employer('Drive Employer');
    const opportunity = await job(employerId);
    const driveId = await drive(employerId, opportunity, 'APPROVED');
    const set = (await api().post(base() + '/campus-drives/' + driveId + '/category').set(auth(officer.id)).send({ categoryId: created.id }).expect(201)).body;
    expect(set.category).toEqual({ id: created.id, name: 'Dream', retired: false });
    // Setting the same category again writes nothing.
    await api().post(base() + '/campus-drives/' + driveId + '/category').set(auth(officer.id)).send({ categoryId: created.id }).expect(201);
    expect(await audits('campus_drive.category_set')).toHaveLength(1);
    const collegeList = (await api().get(base() + '/campus-drives').set(auth(headA.id)).expect(200)).body;
    expect(collegeList.drives[0].category).toMatchObject({ name: 'Dream' });
    // The employer's own drive list never carries the college's label.
    const recruiter = randomUUID(); tokens.add(recruiter);
    await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [recruiter, recruiter + '@example.test']);
    await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
      VALUES ($1,$2,$3,'RECRUITER','ACTIVE',$2,$2)`, [randomUUID(), employerId, recruiter]);
    const employerView = (await api().get('/api/v1/employers/' + employerId + '/campus-drives').set(auth(recruiter)).expect(200)).body;
    expect(employerView.drives).toHaveLength(1);
    expect(JSON.stringify(employerView)).not.toMatch(/category|Dream/);
    const register = (await api().get(base() + '/placement-register').set(auth(admin.id)).expect(200)).body;
    expect(register.drives[0].category).toMatchObject({ name: 'Dream' });
    // A category from another college, or a drive of another college, is refused.
    await api().post(base() + '/campus-drives/' + driveId + '/category').set(auth(officer.id)).send({ categoryId: randomUUID() }).expect(400);
    await api().post(base() + '/campus-drives/' + driveId + '/category').set(auth(headA.id)).send({ categoryId: null }).expect(403);
    await api().post(base(otherInstitutionId) + '/campus-drives/' + driveId + '/category').set(auth(otherAdmin.id)).send({ categoryId: null }).expect(403);
    await api().post(base() + '/campus-drives/' + driveId + '/category').set(auth(officer.id)).send({}).expect(400);

    await api().post(base() + '/drive-categories/' + created.id + '/retire').set(auth(admin.id)).send({ reasonCode: 'NOT_A_REASON' }).expect(400);
    await api().post(base() + '/drive-categories/' + created.id + '/retire').set(auth(admin.id)).send({ reasonCode: 'RENAMED' }).expect(201);
    await api().post(base() + '/drive-categories/' + created.id + '/retire').set(auth(admin.id)).send({ reasonCode: 'RENAMED' }).expect(400);
    // The drive keeps what it was labelled, marked retired; a retired category cannot be assigned again.
    expect((await api().get(base() + '/campus-drives').set(auth(admin.id)).expect(200)).body.drives[0].category).toMatchObject({ name: 'Dream', retired: true });
    await api().post(base() + '/campus-drives/' + driveId + '/category').set(auth(officer.id)).send({ categoryId: created.id }).expect(400);
    const cleared = (await api().post(base() + '/campus-drives/' + driveId + '/category').set(auth(officer.id)).send({ categoryId: null }).expect(201)).body;
    expect(cleared.category).toBeNull();
    // A retired name can be reused.
    await api().post(base() + '/drive-categories').set(auth(admin.id)).send({ name: 'Dream' }).expect(201);

    expect(await audits('institution.drive_category.created')).toHaveLength(3);
    const retired = await audits('institution.drive_category.retired');
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({ actor_user_id: admin.id, organization_id: institutionId, resource_id: created.id, outcome: 'SUCCESS' });
    // History is append-only and a category can only be retired.
    await expect(pool.query('DELETE FROM campus_drive_category_assignments')).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE institution_drive_categories SET name='Renamed' WHERE id=$1", [created.id])).rejects.toThrow(/only be retired/);
  });
});
