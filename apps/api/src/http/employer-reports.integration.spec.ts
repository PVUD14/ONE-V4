/**
 * Employer dashboard summary and reports (EMP-15).
 *
 * The acceptance for the goal: every number reconciles with the applicant pipeline for a fixture
 * dataset, and no other employer's data is reachable. Also pinned: every report figure about
 * people goes through the shared suppression rule (a group under 5 is withheld), a college is
 * named only from 5 applications, nothing in either response carries a candidate, readiness or a
 * protected attribute, reading the reports is audited, and the §6.3 minimums.
 *
 * Runs over real HTTP with a stub verifier in a throwaway schema of the local Postgres in DATABASE_URL.
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
if (!connectionString) throw new Error('DATABASE_URL is required for employer report tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Employer report tests require local Postgres');
const schemaName = 'employer_reports_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
let app: INestApplication;

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
        return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access',
          issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
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
}, 60_000);
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 120_000);

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const summaryPath = (employerId: string) => '/api/v1/employers/' + employerId + '/summary';
const reportsPath = (employerId: string) => '/api/v1/employers/' + employerId + '/reports';
const jobs = (employerId: string) => '/api/v1/employers/' + employerId + '/opportunities';
/** Nothing about a single person, readiness, fit or a protected attribute in any response. */
const noPersonOrReadiness = (body: unknown) => {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/readiness|mastery|gapStatus|fitScore|"score"/i);
  expect(text).not.toMatch(/email|fullName|candidateName|studentUserId|institutionStudentId|gender|religion|caste|dateOfBirth|disability/i);
  expect(text).not.toContain('@example.test');
};

async function user(): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function employer(verification = 'VERIFIED', active = true) {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Synthetic Report Employer',$2,$3)", [employerId, verification, active]);
  const recruiterId = await user();
  const membershipId = randomUUID();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,'RECRUITER','ACTIVE',$2,$2)`, [membershipId, employerId, recruiterId]);
  return { employerId, recruiterId, membershipId };
}
async function college(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION',$2,'VERIFIED',true)", [id, name]);
  return id;
}
const terms = {
  title: 'Graduate engineer', summary: 'Build things.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai',
  compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: 800000, compensationPeriod: 'YEAR',
};
/** A job made and (unless `draft`) published through the API, with a public audience. */
async function job(employerId: string, recruiterId: string, title: string, draft = false): Promise<{ id: string; versionId: string }> {
  const created = await api().post(jobs(employerId)).set(auth(recruiterId)).send({ referenceCode: 'RP-' + randomUUID().slice(0, 8), ...terms, title }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(jobs(employerId) + '/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  if (!draft) await api().post(jobs(employerId) + '/' + id + '/publish').set(auth(recruiterId)).expect(201);
  const version = await pool.query('SELECT current_version_id FROM opportunities WHERE id=$1', [id]);
  return { id, versionId: version.rows[0].current_version_id as string };
}

interface Fixture {
  readonly employerId: string;
  readonly opportunity: { id: string; versionId: string };
  readonly count: number;
  readonly state: string;
  /** Days before now the application was submitted. */
  readonly submittedDaysAgo: number;
  /** Stage history after submission: [to_state, days after submission, from_state]. */
  readonly history?: readonly (readonly [string, number, string])[];
  readonly college?: string;
  readonly offer?: { state: string; extendedDaysAfter: number; expiresInDays: number };
  readonly driveId?: string;
}
/** Applications written directly, so the fixture's shape is exact and known. */
async function applications(fixture: Fixture): Promise<string[]> {
  const ids: string[] = [];
  const recruiter = (await pool.query("SELECT user_id FROM organization_memberships WHERE organization_id=$1 LIMIT 1", [fixture.employerId])).rows[0].user_id as string;
  for (let index = 0; index < fixture.count; index += 1) {
    const student = await user();
    const id = randomUUID();
    const closed = ['HIRED', 'REJECTED', 'WITHDRAWN'].includes(fixture.state);
    await pool.query(`INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at,closed_at)
      VALUES ($1,$2,$3,$4,$5,$6,now() - make_interval(days => $7),now() - make_interval(days => $7),${closed ? 'now()' : 'NULL'})`,
    [id, fixture.opportunity.id, fixture.employerId, fixture.opportunity.versionId, student, fixture.state, fixture.submittedDaysAgo]);
    await pool.query(`INSERT INTO application_state_history (id,application_id,from_state,to_state,occurred_at)
      VALUES ($1,$2,NULL,'APPLIED',now() - make_interval(days => $3))`, [randomUUID(), id, fixture.submittedDaysAgo]);
    for (const [to, after, from] of fixture.history ?? []) {
      await pool.query(`INSERT INTO application_state_history (id,application_id,from_state,to_state,occurred_at)
        VALUES ($1,$2,$3,$4,now() - make_interval(days => $5) + make_interval(days => $6))`, [randomUUID(), id, from, to, fixture.submittedDaysAgo, after]);
    }
    if (fixture.college) {
      const snapshot = { schemaVersion: 1, education: { institutionName: fixture.college } };
      await pool.query(`INSERT INTO application_profile_snapshots (id,application_id,snapshot,snapshot_hash,opportunity_version_id)
        VALUES ($1,$2,$3::jsonb,$4,$5)`, [randomUUID(), id, JSON.stringify(snapshot), randomUUID().replaceAll('-', '').padEnd(64, '0'), fixture.opportunity.versionId]);
    }
    if (fixture.offer) {
      const responded = ['ACCEPTED', 'DECLINED'].includes(fixture.offer.state) ? 'now()' : 'NULL';
      await pool.query(`INSERT INTO offers (id,application_id,employer_id,state,compensation_currency,compensation_amount,compensation_period,offer_expires_at,extended_at,responded_at,created_by_user_id)
        VALUES ($1,$2,$3,$4,'INR',900000,'YEAR',now() + make_interval(days => $5),now() - make_interval(days => $6) + make_interval(days => $7),${responded},$8)`,
      [randomUUID(), id, fixture.employerId, fixture.offer.state, fixture.offer.expiresInDays, fixture.submittedDaysAgo, fixture.offer.extendedDaysAfter, recruiter]);
    }
    if (fixture.driveId) {
      await pool.query('INSERT INTO campus_drive_applications (campus_drive_id,application_id,opportunity_id) VALUES ($1,$2,$3)', [fixture.driveId, id, fixture.opportunity.id]);
    }
    ids.push(id);
  }
  return ids;
}
/** An interview whose start is `dayOffset` days after the start of this Asia/Kolkata week, at 10:00. */
async function interview(employerId: string, applicationId: string, state: string, dayOffset: number): Promise<void> {
  const recruiter = (await pool.query("SELECT user_id FROM organization_memberships WHERE organization_id=$1 LIMIT 1", [employerId])).rows[0].user_id as string;
  await pool.query(`INSERT INTO interviews (id,application_id,employer_id,round_number,mode,state,scheduled_start,scheduled_end,created_by_user_id)
    VALUES ($1,$2,$3,1,'VIDEO',$4,
      (date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') + make_interval(days => $5) + interval '10 hours',
      (date_trunc('week', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') + make_interval(days => $5) + interval '11 hours',$6)`,
  [randomUUID(), applicationId, employerId, state, dayOffset, recruiter]);
}

/**
 * The fixture dataset. Employer E:
 *   Job 1 (published): 6 APPLIED a day ago (Alpha Institute, one typed differently); 5 SHORTLISTED 20 days ago, shortlisted
 *     after 2 days (Beta College); 2 REJECTED at SCREENING (Gamma, a college named by fewer than 5);
 *     1 OFFER with a live extended offer and 1 OFFER whose offer has lapsed (no college stated).
 *   Job 2 (published, run as a campus drive): 5 HIRED 30 days ago — shortlisted after 3 days,
 *     interviewed after 5, offer extended after 10 and accepted, hired after 12 (Beta College) — and
 *     1 WITHDRAWN at APPLIED; all 6 linked to the drive.
 *   Job 3: a draft. Interviews: two this week, one cancelled this week, one next week.
 * A second employer has 5 applications of its own that must never appear.
 */
async function fixtureDataset() {
  const e = await employer();
  const job1 = await job(e.employerId, e.recruiterId, 'Graduate engineer');
  const job2 = await job(e.employerId, e.recruiterId, 'Data analyst');
  await job(e.employerId, e.recruiterId, 'Draft role', true);
  const collegeId = await college('Synthetic Drive College');
  const drive = await api().post(jobs(e.employerId) + '/' + job2.id + '/campus-drives').set(auth(e.recruiterId)).send({ institutionId: collegeId }).expect(201);
  const driveId = drive.body.drive.id as string;

  const applied = await applications({ employerId: e.employerId, opportunity: job1, count: 5, state: 'APPLIED', submittedDaysAgo: 1, college: 'Alpha Institute' });
  // The same college as one student typed it: grouped with the others, shown as most wrote it.
  applied.push(...await applications({ employerId: e.employerId, opportunity: job1, count: 1, state: 'APPLIED', submittedDaysAgo: 1, college: ' alpha INSTITUTE ' }));
  const shortlisted = await applications({ employerId: e.employerId, opportunity: job1, count: 5, state: 'SHORTLISTED', submittedDaysAgo: 20, history: [['SHORTLISTED', 2, 'APPLIED']], college: 'Beta College' });
  await applications({ employerId: e.employerId, opportunity: job1, count: 2, state: 'REJECTED', submittedDaysAgo: 20, history: [['SCREENING', 1, 'APPLIED'], ['REJECTED', 4, 'SCREENING']], college: 'Gamma Polytechnic' });
  await applications({ employerId: e.employerId, opportunity: job1, count: 1, state: 'OFFER', submittedDaysAgo: 20, offer: { state: 'EXTENDED', extendedDaysAfter: 19, expiresInDays: 10 } });
  await applications({ employerId: e.employerId, opportunity: job1, count: 1, state: 'OFFER', submittedDaysAgo: 20, offer: { state: 'EXTENDED', extendedDaysAfter: 10, expiresInDays: -1 } });
  await applications({
    employerId: e.employerId, opportunity: job2, count: 5, state: 'HIRED', submittedDaysAgo: 30, college: 'Beta College', driveId,
    history: [['SHORTLISTED', 3, 'APPLIED'], ['INTERVIEW', 5, 'SHORTLISTED'], ['OFFER', 10, 'INTERVIEW'], ['HIRED', 12, 'OFFER']],
    offer: { state: 'ACCEPTED', extendedDaysAfter: 10, expiresInDays: 30 },
  });
  await applications({ employerId: e.employerId, opportunity: job2, count: 1, state: 'WITHDRAWN', submittedDaysAgo: 30, history: [['WITHDRAWN', 1, 'APPLIED']], driveId });

  await interview(e.employerId, shortlisted[0]!, 'SCHEDULED', 1);
  await interview(e.employerId, shortlisted[1]!, 'RESCHEDULED', 3);
  await interview(e.employerId, shortlisted[2]!, 'CANCELLED', 2);
  await interview(e.employerId, shortlisted[3]!, 'SCHEDULED', 8);

  const rival = await employer();
  const rivalJob = await job(rival.employerId, rival.recruiterId, 'Rival role');
  await applications({ employerId: rival.employerId, opportunity: rivalJob, count: 5, state: 'APPLIED', submittedDaysAgo: 1, college: 'Alpha Institute' });
  await applications({ employerId: rival.employerId, opportunity: rivalJob, count: 5, state: 'HIRED', submittedDaysAgo: 30, offer: { state: 'ACCEPTED', extendedDaysAfter: 1, expiresInDays: 30 } });

  return { ...e, job1, job2, driveId, applied, rival };
}

type Cell = { key: string; count: number | null; suppressed: boolean };
type Table = { suppressed: boolean; total: { suppressed: boolean; value: number | null }; cells: Cell[] };
const cell = (table: Table, key: string) => table.cells.find((item) => item.key === key);

describe('EMP-15: every number reconciles with the applicant pipeline', () => {
  it('gives the dashboard summary in SQL, matching the applicant, interview, offer and drive lists', async () => {
    const f = await fixtureDataset();
    const response = await api().get(summaryPath(f.employerId)).set(auth(f.recruiterId)).expect(200);
    const summary = response.body.summary;
    expect(summary).toMatchObject({
      openJobs: 2, newApplicantsLast7Days: 6, interviewsThisWeek: 2, offersPending: 1, drivesAwaitingApproval: 1, drivesChangesRequested: 0,
      applicationsTotal: 21, openApplications: 13, hires: 5, timeZone: 'Asia/Kolkata',
    });
    expect(summary.currentStages).toEqual({ APPLIED: 6, SCREENING: 0, SHORTLISTED: 5, ASSESSMENT: 0, INTERVIEW: 0, OFFER: 2, HIRED: 5, REJECTED: 2, WITHDRAWN: 1 });
    noPersonOrReadiness(response.body);

    // The pipeline, read the way the recruiter reads it.
    const opportunities = (await api().get(jobs(f.employerId)).set(auth(f.recruiterId)).expect(200)).body.opportunities as { id: string; lifecycleState: string }[];
    expect(opportunities.filter((item) => item.lifecycleState === 'PUBLISHED')).toHaveLength(summary.openJobs);
    const pipeline: { state: string; submittedAt: string }[] = [];
    for (const opportunity of opportunities) {
      pipeline.push(...(await api().get(jobs(f.employerId) + '/' + opportunity.id + '/applications').set(auth(f.recruiterId)).expect(200)).body.applications);
    }
    expect(pipeline).toHaveLength(summary.applicationsTotal);
    for (const [stage, count] of Object.entries(summary.currentStages as Record<string, number>)) {
      expect(pipeline.filter((item) => item.state === stage)).toHaveLength(count);
    }
    expect(pipeline.filter((item) => !['HIRED', 'REJECTED', 'WITHDRAWN'].includes(item.state))).toHaveLength(summary.openApplications);
    const weekAgo = Date.now() - 7 * 86_400_000;
    expect(pipeline.filter((item) => new Date(item.submittedAt).getTime() >= weekAgo)).toHaveLength(summary.newApplicantsLast7Days);

    const interviews = (await api().get('/api/v1/employers/' + f.employerId + '/interviews').set(auth(f.recruiterId)).expect(200)).body.interviews as { state: string; scheduledStart: string }[];
    const [start, end] = [new Date(summary.week.startsAt).getTime(), new Date(summary.week.endsAt).getTime()];
    expect(end - start).toBe(7 * 86_400_000);
    expect(interviews.filter((item) => item.state !== 'CANCELLED' && new Date(item.scheduledStart).getTime() >= start && new Date(item.scheduledStart).getTime() < end)).toHaveLength(summary.interviewsThisWeek);

    const offers = (await api().get('/api/v1/employers/' + f.employerId + '/offers').set(auth(f.recruiterId)).expect(200)).body.offers as { state: string; offerExpiresAt: string }[];
    expect(offers.filter((item) => item.state === 'EXTENDED' && new Date(item.offerExpiresAt).getTime() > Date.now())).toHaveLength(summary.offersPending);

    const drives = (await api().get('/api/v1/employers/' + f.employerId + '/campus-drives').set(auth(f.recruiterId)).expect(200)).body.drives as { state: string }[];
    expect(drives.filter((item) => item.state === 'REQUESTED')).toHaveLength(summary.drivesAwaitingApproval);
  });

  it('reports the funnel by job, college and drive, time to each stage and offer acceptance, suppressed and reconciled', async () => {
    const f = await fixtureDataset();
    const response = await api().get(reportsPath(f.employerId)).set(auth(f.recruiterId)).expect(200);
    const reports = response.body.reports;
    noPersonOrReadiness(response.body);
    expect(reports.threshold).toBe(5);

    // Overall: the one partition. Cells of 5 and more are exact; the rest are withheld, and the
    // withheld cells hold 5 between them, so the total may be shown.
    const overall = reports.overall as Table;
    expect(overall.total).toEqual({ suppressed: false, value: 21 });
    expect(cell(overall, 'APPLIED')).toEqual({ key: 'APPLIED', count: 6, suppressed: false });
    expect(cell(overall, 'SHORTLISTED')).toEqual({ key: 'SHORTLISTED', count: 5, suppressed: false });
    expect(cell(overall, 'HIRED')).toEqual({ key: 'HIRED', count: 5, suppressed: false });
    for (const key of ['OFFER', 'LEFT_AT_SCREENING', 'LEFT_AT_APPLIED', 'SCREENING', 'INTERVIEW']) expect(cell(overall, key)).toEqual({ key, count: null, suppressed: true });
    // No figure under 5 leaves the server anywhere in the report.
    expect(JSON.stringify(reports)).not.toMatch(/"(count|value)":[0-4][,}]/);

    // Reconcile the published cells with the pipeline.
    const summary = (await api().get(summaryPath(f.employerId)).set(auth(f.recruiterId)).expect(200)).body.summary;
    for (const published of overall.cells.filter((item) => !item.suppressed)) expect(published.count).toBe(summary.currentStages[published.key]);

    // By job: every job but drafts, withheld where a group is small.
    const byJob = reports.byJob as { opportunityId: string; title: string; table: Table }[];
    expect(byJob.map((row) => row.title).sort()).toEqual(['Data analyst', 'Graduate engineer']);
    const job1 = byJob.find((row) => row.opportunityId === f.job1.id)!.table;
    expect([cell(job1, 'APPLIED')!.count, cell(job1, 'SHORTLISTED')!.count]).toEqual([6, 5]);
    expect(job1.total.suppressed).toBe(true); // 4 withheld in a known total would be recoverable
    const job2 = byJob.find((row) => row.opportunityId === f.job2.id)!.table;
    expect(cell(job2, 'HIRED')!.count).toBe(5);

    // By college: named only from 5 applications (Gamma, with 2, is folded into "other"); names are
    // grouped regardless of case and spacing.
    const byCollege = reports.byCollege as { collegeName: string | null; table: Table }[];
    expect(byCollege.map((row) => row.collegeName)).toEqual(['Alpha Institute', 'Beta College', null]);
    expect(cell(byCollege[1]!.table, 'SHORTLISTED')!.count).toBe(5);
    expect(cell(byCollege[1]!.table, 'HIRED')!.count).toBe(5);
    // Other: 2 left at screening, 2 at offer, 1 left at applied — every cell withheld, but they hold
    // 5 between them, so the row's total may be shown.
    expect(byCollege[2]!.table.total).toEqual({ suppressed: false, value: 5 });
    expect(byCollege[2]!.table.cells.every((item) => item.suppressed)).toBe(true);
    expect(JSON.stringify(byCollege)).not.toContain('Gamma');

    // By drive: the drive's six linked applications.
    const byDrive = reports.byDrive as { driveId: string; institutionName: string; state: string; table: Table }[];
    expect(byDrive).toHaveLength(1);
    expect(byDrive[0]).toMatchObject({ driveId: f.driveId, institutionName: 'Synthetic Drive College', state: 'REQUESTED' });
    expect(cell(byDrive[0]!.table, 'HIRED')!.count).toBe(5);

    // Time to stage: medians over 5 or more applications only.
    const timing = Object.fromEntries((reports.timeToStage as { metric: string; applications: { value: number | null }; medianDays: number | null }[]).map((row) => [row.metric, row]));
    expect(timing.SHORTLIST).toMatchObject({ applications: { suppressed: false, value: 10 }, medianDays: 2.5 });
    expect(timing.INTERVIEW).toMatchObject({ applications: { suppressed: false, value: 5 }, medianDays: 5 });
    expect(timing.OFFER).toMatchObject({ applications: { suppressed: false, value: 7 }, medianDays: 10 });
    expect(timing.HIRE).toMatchObject({ applications: { suppressed: false, value: 5 }, medianDays: 12 });

    // Offers: accepted 5, still extended 2 (withheld); no rate, because nobody has declined.
    const offers = reports.offers as { table: Table; acceptanceRate: number | null };
    expect(cell(offers.table, 'ACCEPTED')!.count).toBe(5);
    expect(cell(offers.table, 'EXTENDED')).toEqual({ key: 'EXTENDED', count: null, suppressed: true });
    expect(offers.acceptanceRate).toBeNull();

    // Reading reports is audited against the employer.
    const audit = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='employer.reports.viewed' AND organization_id=$1 AND outcome='SUCCESS'", [f.employerId]);
    expect(audit.rows[0].n).toBe(1);
  });
});

describe('EMP-15: no other employer\'s data is reachable', () => {
  it('refuses another employer\'s recruiter and never counts another employer\'s applications', async () => {
    const f = await fixtureDataset();
    await api().get(summaryPath(f.employerId)).set(auth(f.rival.recruiterId)).expect(403);
    await api().get(reportsPath(f.employerId)).set(auth(f.rival.recruiterId)).expect(403);
    await api().get(summaryPath(f.rival.employerId)).set(auth(f.recruiterId)).expect(403);

    const rival = (await api().get(summaryPath(f.rival.employerId)).set(auth(f.rival.recruiterId)).expect(200)).body.summary;
    expect(rival).toMatchObject({ openJobs: 1, applicationsTotal: 10, newApplicantsLast7Days: 5, hires: 5, interviewsThisWeek: 0, offersPending: 0, drivesAwaitingApproval: 0 });
    const reports = (await api().get(reportsPath(f.rival.employerId)).set(auth(f.rival.recruiterId)).expect(200)).body.reports;
    // 5 applied and 5 hired; every other cell is an empty (withheld) stage, so the total is withheld.
    expect(cell(reports.overall, 'APPLIED')!.count).toBe(5);
    expect(cell(reports.overall, 'HIRED')!.count).toBe(5);
    expect(reports.overall.total).toEqual({ suppressed: true, value: null });
    expect(reports.byDrive).toEqual([]);
    expect(reports.byJob.map((row: { title: string }) => row.title)).toEqual(['Rival role']);
    // Alpha Institute has 6 of employer E's applications and 5 of the rival's; each sees only its own.
    expect(reports.byCollege.map((row: { collegeName: string | null }) => row.collegeName)).toEqual(['Alpha Institute', null]);
    expect(cell(reports.byCollege[0].table, 'APPLIED')!.count).toBe(5);
  });
});

describe('EMP-15: §6.3 minimums', () => {
  it('needs a token, an active membership and an employer in good standing', async () => {
    const e = await employer();
    await api().get(summaryPath(e.employerId)).expect(401);
    await api().get(reportsPath(e.employerId)).expect(401);
    const empty = (await api().get(summaryPath(e.employerId)).set(auth(e.recruiterId)).expect(200)).body.summary;
    expect(empty).toMatchObject({ openJobs: 0, applicationsTotal: 0, newApplicantsLast7Days: 0, interviewsThisWeek: 0, offersPending: 0, drivesAwaitingApproval: 0 });
    const nothing = (await api().get(reportsPath(e.employerId)).set(auth(e.recruiterId)).expect(200)).body.reports;
    expect(nothing.overall).toEqual({ suppressed: true, total: { suppressed: true, value: null }, cells: [] });
    expect(nothing.timeToStage.every((row: { medianDays: number | null }) => row.medianDays === null)).toBe(true);

    await api().get(summaryPath('not-a-uuid')).set(auth(e.recruiterId)).expect(403);

    await pool.query("UPDATE organization_memberships SET state='ENDED' WHERE id=$1", [e.membershipId]);
    await api().get(summaryPath(e.employerId)).set(auth(e.recruiterId)).expect(403);
    await api().get(reportsPath(e.employerId)).set(auth(e.recruiterId)).expect(403);

    const suspended = await employer();
    await pool.query("UPDATE organizations SET verification_state='SUSPENDED', active=false WHERE id=$1", [suspended.employerId]);
    expect((await api().get(summaryPath(suspended.employerId)).set(auth(suspended.recruiterId)).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    expect((await api().get(reportsPath(suspended.employerId)).set(auth(suspended.recruiterId)).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');

    const pending = await employer('PENDING');
    expect((await api().get(summaryPath(pending.employerId)).set(auth(pending.recruiterId)).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
    expect((await api().get(reportsPath(pending.employerId)).set(auth(pending.recruiterId)).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
  });

  it('refuses query parameters it does not know rather than filter on them', async () => {
    const e = await employer();
    expect((await api().get(reportsPath(e.employerId) + '?gender=F').set(auth(e.recruiterId)).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await api().get(summaryPath(e.employerId) + '?since=2020-01-01').set(auth(e.recruiterId)).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
  });
});
