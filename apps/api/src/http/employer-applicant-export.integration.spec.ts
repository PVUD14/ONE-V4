/**
 * Employer applicant exports (EMP-17, journey J9).
 *
 * Pins: only owners and admins of a verified, active employer export; the file holds only
 * candidates whose applicant-access grant is live at export time (withdrawn, expired before or
 * after EMP-16's sweep, in deletion: all left out); every value comes from the student's frozen
 * snapshot, with contact details from Shortlisted only; formula-leading cells are neutralised; the
 * whole file matches a CSV fixture; every export is audited with its reason and the SHA-256 of the
 * bytes before it is sent; the per-person limit holds; and nothing readiness-related, no internal
 * identifier and no protected attribute is written.
 *
 * Runs over real HTTP with a stub verifier, in a throwaway schema of the local Postgres in
 * DATABASE_URL, like the EMP-07 spec.
 */
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@planthepath/persistence/src/schema.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { revokeExpiredApplicantGrants } from '@planthepath/persistence/src/employer-terms.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for applicant export tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Applicant export tests require local Postgres');
const schemaName = 'employer_export_' + randomUUID().replaceAll('-', '');
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
});

async function user(email?: string): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, email ?? id + '@example.test']);
  return id;
}
async function member(employerId: string, role: string, state = 'ACTIVE'): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,$5,$2,$2)`, [randomUUID(), employerId, id, role, state]);
  return id;
}
async function employer(verification = 'VERIFIED', active = true) {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Export employer',$2,$3)", [employerId, verification, active]);
  return { employerId, ownerId: await member(employerId, 'EMPLOYER_OWNER'), adminId: await member(employerId, 'EMPLOYER_ADMIN'), recruiterId: await member(employerId, 'RECRUITER') };
}

/** A student at a synthetic college, with a roster name, a qualification and a profile the test chooses. */
async function student(label: string, profile: { headline?: string; summary?: string; fullName?: string } = {}): Promise<{ id: string; email: string }> {
  const email = `candidate-${label}-${randomUUID().slice(0, 6)}@uat.example.test`;
  const id = await user(email);
  const institutionId = randomUUID();
  const departmentId = randomUUID();
  const programId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute of Technology','VERIFIED',true)", [institutionId]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Computer Science')", [departmentId, institutionId]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'PROGRAM','BTech')", [programId, institutionId]);
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,program_unit_id,expected_graduation_date)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,'2027-06-30')`, [randomUUID(), institutionId, id, 'ROLL-' + label, profile.fullName ?? `Synthetic ${label}`, departmentId, programId]);
  await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,started_on,verification_state)
    VALUES ($1,$2,$3,'BTECH','BTech Computer Science','2023-08-01','SELF_REPORTED')`, [randomUUID(), id, institutionId]);
  await pool.query("INSERT INTO student_profiles (user_id, profile_headline, profile_summary, target_career) VALUES ($1,$2,$3,'Data Analyst')",
    [id, profile.headline ?? 'Aspiring analyst', profile.summary ?? 'I like data.']);
  return { id, email };
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId;
const exportPath = (employerId: string, opportunityId: string) => base(employerId) + '/opportunities/' + opportunityId + '/applicant-export';
const exportAs = (employerId: string, opportunityId: string, actor: string, body: Record<string, unknown> = { reasonCode: 'SHORTLIST_REVIEW' }) =>
  api().post(exportPath(employerId, opportunityId)).set(auth(actor)).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  }).send(body);
const terms = {
  title: 'Graduate analyst', summary: 'Analyse data.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai',
  compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: 800000, compensationPeriod: 'YEAR',
};
async function job(employerId: string, recruiterId: string): Promise<string> {
  const created = await api().post(base(employerId) + '/opportunities').set(auth(recruiterId)).send({ referenceCode: 'EX-' + randomUUID().slice(0, 8), ...terms }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(base(employerId) + '/opportunities/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  await api().post(base(employerId) + '/opportunities/' + id + '/publish').set(auth(recruiterId)).expect(201);
  return id;
}
async function apply(studentId: string, opportunityId: string, choices: Record<string, unknown> = {}): Promise<string> {
  const reviewed = await api().post('/api/v1/students/me/application-previews').set(auth(studentId)).send({ opportunityId, ...choices }).expect(201);
  const response = await api().post('/api/v1/students/me/applications').set(auth(studentId))
    .send({ consentGranted: true, opportunityId, ...choices, reviewedSnapshotHash: reviewed.body.preview.snapshotHash }).expect(201);
  return response.body.application.id as string;
}
const move = (employerId: string, recruiterId: string, applicationId: string, toState: string) =>
  api().post(base(employerId) + '/applications/' + applicationId + '/transition').set(auth(recruiterId)).send({ toState }).expect(201);
const csvText = (body: Buffer) => body.toString('utf8');
const dataRows = (text: string) => text.replace(/^﻿/, '').split('\r\n').filter(Boolean).slice(1);

describe('EMP-17: the export holds only candidates with a live grant, and only what they shared', () => {
  it('writes the live-grant candidates exactly as the fixture, and leaves out withdrawn, expired and deleting students', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const shortlisted = await student('A', { fullName: 'Synthetic Shortlisted' });
    const applied = await student('B', { fullName: '@Synthetic Applied', headline: '=HYPERLINK("https://evil.example.test","click")', summary: '-2+3' });
    const withdrawn = await student('C', { fullName: 'Synthetic Withdrawn' });
    const expiredSwept = await student('D', { fullName: 'Synthetic Expired Swept' });
    const expiredUnswept = await student('E', { fullName: 'Synthetic Expired Unswept' });
    const deleting = await student('F', { fullName: 'Synthetic Deleting' });

    const a = await apply(shortlisted.id, opportunityId, { contactPhone: '+91 98765 43210', links: [{ url: 'https://portfolio.example.test/a', label: 'Portfolio' }] });
    await apply(applied.id, opportunityId, { contactPhone: '+91 90000 00000' });
    const c = await apply(withdrawn.id, opportunityId);
    await apply(expiredSwept.id, opportunityId);
    await apply(expiredUnswept.id, opportunityId);
    await apply(deleting.id, opportunityId);
    await move(org.employerId, org.recruiterId, a, 'SHORTLISTED');
    await api().post('/api/v1/students/me/applications/' + c + '/withdraw').set(auth(withdrawn.id)).send({}).expect(201);
    // D expired and EMP-16's daily sweep revoked it; E expired a moment ago and the sweep has not run yet.
    await pool.query("UPDATE employer_applicant_access_grants SET expires_at = now() - interval '1 minute' WHERE student_user_id = $1", [expiredSwept.id]);
    expect(await revokeExpiredApplicantGrants(db)).toBe(1);
    await pool.query("UPDATE employer_applicant_access_grants SET expires_at = now() - interval '1 second' WHERE student_user_id = $1", [expiredUnswept.id]);
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() + interval '30 days', 'export-test')`, [randomUUID(), deleting.id]);

    const response = await exportAs(org.employerId, opportunityId, org.ownerId).expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/csv/);
    expect(response.headers['content-disposition']).toBe(`attachment; filename="one-applicants-graduate-analyst-${new Date().toISOString().slice(0, 10)}.csv"`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const text = csvText(response.body as Buffer);
    const today = new Date().toISOString().slice(0, 10);
    const fixture = (await readFile(new URL('./employer-applicant-export.integration.fixture.csv', import.meta.url), 'utf8'))
      .replace(/\r?\n/g, '\r\n').replaceAll('{APPLIED_ON}', today).replace('{EMAIL_A}', shortlisted.email);
    expect(text).toBe(fixture);
    expect(text).not.toMatch(/Withdrawn|Expired|Deleting/);
    expect(text).not.toContain(applied.email);
  });

  it('exports only Shortlisted onward when asked, and an admin may export as well as the owner', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const one = await student('G');
    const two = await student('H');
    const g = await apply(one.id, opportunityId);
    await apply(two.id, opportunityId);
    await move(org.employerId, org.recruiterId, g, 'SHORTLISTED');
    const response = await exportAs(org.employerId, opportunityId, org.adminId, { reasonCode: 'INTERVIEW_PLANNING', scope: 'SHORTLISTED_ONWARD' }).expect(200);
    const rows = dataRows(csvText(response.body as Buffer));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('"Synthetic G"');
    expect(rows[0]).toContain(`"${one.email}"`);
  });

  it('writes an application made before snapshots existed with nothing shared, never the live profile', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const old = await student('I', { fullName: 'Synthetic Before Snapshots' });
    const version = await pool.query('SELECT current_version_id FROM opportunities WHERE id = $1', [opportunityId]);
    await pool.query(`INSERT INTO applications (id,opportunity_id,employer_id,applied_version_id,student_user_id,state,consent_granted_at,submitted_at)
      VALUES ($1,$2,$3,$4,$5,'APPLIED',now(),now())`, [randomUUID(), opportunityId, org.employerId, version.rows[0].current_version_id, old.id]);
    await pool.query('INSERT INTO employer_applicant_access_grants (id,employer_id,student_user_id,opportunity_id,granted_at) VALUES ($1,$2,$3,$4,now())',
      [randomUUID(), org.employerId, old.id, opportunityId]);
    const rows = dataRows(csvText((await exportAs(org.employerId, opportunityId, org.ownerId).expect(200)).body as Buffer));
    expect(rows).toEqual([`"","","","","","","","","","","","","","Applied","${new Date().toISOString().slice(0, 10)}","Not captured"`]);
  });

  it('writes no readiness, no identifier, no roll number and no protected attribute', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const candidate = await student('J');
    const applicationId = await apply(candidate.id, opportunityId);
    await move(org.employerId, org.recruiterId, applicationId, 'SHORTLISTED');
    const text = csvText((await exportAs(org.employerId, opportunityId, org.ownerId).expect(200)).body as Buffer);
    const header = text.replace(/^﻿/, '').split('\r\n')[0]!;
    expect(header).not.toMatch(/readiness|band|score|mastery|gap|fit|rank|\bid\b|roll|compensation|salary|gender|religion|caste|\bage\b|birth|disabilit|marital|photo|origin/i);
    expect(text).not.toMatch(/readiness|mastery|Data Analyst|ROLL-J|800000/i);
    for (const id of [applicationId, candidate.id, opportunityId, org.employerId]) expect(text).not.toContain(id);
  });
});

describe('EMP-17: who may export (§5.1, §6.3)', () => {
  it('refuses a recruiter, another employer, an ended membership, a missing token and another employer\'s job', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const other = await employer();
    const otherJob = await job(other.employerId, other.recruiterId);
    const ended = await member(org.employerId, 'EMPLOYER_ADMIN', 'ENDED');
    await api().post(exportPath(org.employerId, opportunityId)).send({ reasonCode: 'SHORTLIST_REVIEW' }).expect(401);
    for (const actor of [org.recruiterId, other.ownerId, ended]) {
      const refused = await exportAs(org.employerId, opportunityId, actor).expect(403);
      expect(JSON.parse(csvText(refused.body as Buffer)).error.code).toBe('FORBIDDEN');
    }
    await exportAs(org.employerId, otherJob, org.ownerId).expect(403);
    await exportAs(org.employerId, 'not-a-uuid', org.ownerId).expect(403);
    const audits = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'employer.applicants.exported' AND organization_id = $1", [org.employerId]);
    expect(audits.rows[0].n).toBe(0);
  });

  it('refuses a suspended or rejected employer as inactive and an unverified one as unverified', async () => {
    for (const [verification, active, code] of [['SUSPENDED', false, 'EMPLOYER_ORGANISATION_INACTIVE'], ['REJECTED', true, 'EMPLOYER_ORGANISATION_INACTIVE'], ['PENDING', true, 'EMPLOYER_ORGANISATION_UNVERIFIED']] as const) {
      const org = await employer();
      const opportunityId = await job(org.employerId, org.recruiterId);
      await pool.query('UPDATE organizations SET verification_state = $2, active = $3 WHERE id = $1', [org.employerId, verification, active]);
      const refused = await exportAs(org.employerId, opportunityId, org.ownerId).expect(403);
      expect(JSON.parse(csvText(refused.body as Buffer)).error.code).toBe(code);
    }
  });

  it('refuses a missing or unknown reason code, an unknown scope and an unknown field, writing nothing', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    for (const [body, code] of [
      [{}, 'REASON_CODE_REQUIRED'],
      [{ reasonCode: 'BECAUSE' }, 'REASON_CODE_REQUIRED'],
      [{ reasonCode: 'SHORTLIST_REVIEW', scope: 'EVERYONE' }, 'EXPORT_SCOPE_INVALID'],
      [{ reasonCode: 'SHORTLIST_REVIEW', includeReadiness: true }, 'UNKNOWN_FIELD'],
    ] as const) {
      const refused = await exportAs(org.employerId, opportunityId, org.ownerId, body as Record<string, unknown>).expect(400);
      expect(JSON.parse(csvText(refused.body as Buffer)).error.code).toBe(code);
    }
    const audits = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'employer.applicants.exported' AND organization_id = $1", [org.employerId]);
    expect(audits.rows[0].n).toBe(0);
  });
});

describe('EMP-17: audit, hash and limits', () => {
  it('audits every export before sending, with the reason, the scope, the exported applications and the SHA-256 of the bytes sent', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const candidate = await student('K');
    const gone = await student('L');
    const applicationId = await apply(candidate.id, opportunityId);
    const goneId = await apply(gone.id, opportunityId);
    await api().post('/api/v1/students/me/applications/' + goneId + '/withdraw').set(auth(gone.id)).send({}).expect(201);
    const response = await exportAs(org.employerId, opportunityId, org.ownerId, { reasonCode: 'HIRING_COMMITTEE' }).expect(200);
    const bytes = response.body as Buffer;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(response.headers['x-export-sha256']).toBe(sha256);
    const audits = await pool.query(`SELECT actor_user_id, outcome, resource_type, context FROM audit_events
      WHERE action = 'employer.applicants.exported' AND organization_id = $1`, [org.employerId]);
    expect(audits.rows).toHaveLength(1);
    const [audit] = audits.rows;
    expect(audit.actor_user_id).toBe(org.ownerId);
    expect(audit.outcome).toBe('SUCCESS');
    expect(audit.resource_type).toBe('opportunity');
    expect(audit.context).toMatchObject({ reasonCode: 'HIRING_COMMITTEE', scope: 'ALL_OPEN', opportunityId, rowCount: 1, withheldWithoutLiveGrant: 1, sha256, applicationIds: [applicationId] });
  });

  it('allows 20 exports per person per employer in 24 hours and refuses the next without writing anything', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    await pool.query(`INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      SELECT gen_random_uuid(), $1, 'employer.applicants.exported', 'opportunity', $2, $3, 'SUCCESS', 'seed', '{}'::jsonb FROM generate_series(1, 19)`,
    [org.ownerId, opportunityId, org.employerId]);
    await exportAs(org.employerId, opportunityId, org.ownerId).expect(200);
    const refused = await exportAs(org.employerId, opportunityId, org.ownerId).expect(429);
    expect(JSON.parse(csvText(refused.body as Buffer)).error.code).toBe('EXPORT_RATE_LIMITED');
    // The limit is per person: the admin still has their own allowance.
    await exportAs(org.employerId, opportunityId, org.adminId).expect(200);
    const audits = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'employer.applicants.exported' AND actor_user_id = $1", [org.ownerId]);
    expect(audits.rows[0].n).toBe(20);
  });
});
