/**
 * Consented application snapshot and candidate view (EMP-07, defects D-4 and D-7).
 *
 * Pins: apply writes exactly one snapshot, equal to what the student reviewed; the snapshot is
 * immutable and bound to the job version applied under; the employer sees it only through a live
 * applicant-access grant, from a verified and active employer, audited every time, with contact
 * details from SHORTLISTED only; the résumé leaves only through a single-use, short-lived link
 * bound to the recruiter who asked; no readiness field appears in any response; and deleting the
 * student's account erases what they shared.
 *
 * Runs over real HTTP with a stub verifier, like the EMP-06 spec, in a throwaway schema of the
 * local Postgres in DATABASE_URL, with a temporary local-disk file store.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createLocalDiskStorage, type FileStorage } from '../storage/file-storage.js';
import { executeDueDeletions } from './privacy-deletion.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for candidate view tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Candidate view tests require local Postgres');
const schemaName = 'employer_candidate_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const RESUME_BYTES = Buffer.from('%PDF-1.4 synthetic résumé for EMP-07 tests');
let storageRoot: string;
let storage: FileStorage;
let app: INestApplication;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  storageRoot = await mkdtemp(join(tmpdir(), 'one-emp07-'));
  storage = createLocalDiskStorage(storageRoot);
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      fileStorage: storage,
      fileScanner: { engine: 'test-scanner', async scan() { return { state: 'CLEAN' }; } },
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
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

async function user(email?: string): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, email ?? id + '@example.test']);
  return id;
}
async function employer(verification = 'VERIFIED', active = true) {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Candidate view employer',$2,$3)", [employerId, verification, active]);
  const recruiterId = await user();
  const membershipId = randomUUID();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,'RECRUITER','ACTIVE',$2,$2)`, [membershipId, employerId, recruiterId]);
  return { employerId, recruiterId, membershipId };
}
async function colleague(employerId: string): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,'RECRUITER','ACTIVE',$2,$2)`, [randomUUID(), employerId, id]);
  return id;
}
/** A student at a synthetic college with a roster record, a verified qualification, a profile and (optionally) a résumé. */
async function student(options: { resume?: boolean } = {}): Promise<{ id: string; email: string; resumeDocumentId: string | null }> {
  const email = 'candidate-' + randomUUID().slice(0, 8) + '@uat.example.test';
  const id = await user(email);
  const institutionId = randomUUID();
  const departmentId = randomUUID();
  const programId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute of Technology','VERIFIED',true)", [institutionId]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT','Computer Science')", [departmentId, institutionId]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'PROGRAM','BTech')", [programId, institutionId]);
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,program_unit_id,expected_graduation_date)
    VALUES ($1,$2,$3,$4,'Synthetic Candidate','ACTIVE',$5,$6,'2027-06-30')`, [randomUUID(), institutionId, id, 'R-' + id.slice(0, 8), departmentId, programId]);
  const qualificationId = randomUUID();
  await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,started_on,verification_state)
    VALUES ($1,$2,$3,'BTECH','BTech Computer Science','2023-08-01','SELF_REPORTED')`, [qualificationId, id, institutionId]);
  await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,backlog_count,source,verification_state)
    VALUES ($1,$2,1,'Semester 1',8.4,'CGPA_10',0,'STUDENT_DECLARED','SELF_REPORTED')`, [randomUUID(), qualificationId]);
  await pool.query("INSERT INTO student_profiles (user_id, profile_headline, profile_summary, target_career) VALUES ($1,'Aspiring analyst','I like data.','Data Analyst')", [id]);
  // Synthetic readiness for the same student: it must never reach an employer.
  let resumeDocumentId: string | null = null;
  if (options.resume) {
    resumeDocumentId = randomUUID();
    const fileId = randomUUID();
    const versionId = randomUUID();
    const key = `students/${id}/${resumeDocumentId}/v1.pdf`;
    await storage.put(key, RESUME_BYTES);
    await pool.query("INSERT INTO student_document_metadata (id,student_user_id,title,document_type) VALUES ($1,$2,'My résumé','RESUME')", [resumeDocumentId, id]);
    await pool.query(`INSERT INTO stored_files (id,storage_key,original_filename,content_type,byte_size,checksum_sha256,upload_state,scan_state,scan_engine,scan_completed_at,uploaded_by_user_id)
      VALUES ($1,$2,'resume.pdf','application/pdf',$3,$4,'STORED','CLEAN','test-scanner',now(),$5)`, [fileId, key, RESUME_BYTES.length, 'b'.repeat(64), id]);
    await pool.query('INSERT INTO student_document_versions (id,document_id,version_number,file_id,created_by_user_id) VALUES ($1,$2,1,$3,$4)', [versionId, resumeDocumentId, fileId, id]);
    await pool.query('UPDATE student_document_metadata SET current_version_id=$1 WHERE id=$2', [versionId, resumeDocumentId]);
  }
  return { id, email, resumeDocumentId };
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId;
const terms = {
  title: 'Graduate analyst', summary: 'Analyse data.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai',
  compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: 800000, compensationPeriod: 'YEAR',
};
/** A published job with one MIN_CGPA rule, so the employer view carries an EMP-06 outcome. */
async function job(employerId: string, recruiterId: string): Promise<string> {
  const created = await api().post(base(employerId) + '/opportunities').set(auth(recruiterId)).send({ referenceCode: 'CV-' + randomUUID().slice(0, 8), ...terms }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(base(employerId) + '/opportunities/' + id + '/versions').set(auth(recruiterId))
    .send({ ...terms, expectedCurrentVersionId: created.body.opportunity.versionId, eligibilityRules: [{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7 }] }).expect(201);
  await api().post(base(employerId) + '/opportunities/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  await api().post(base(employerId) + '/opportunities/' + id + '/publish').set(auth(recruiterId)).expect(201);
  return id;
}
const preview = (studentId: string, body: Record<string, unknown>) => api().post('/api/v1/students/me/application-previews').set(auth(studentId)).send(body);
const applyAs = (studentId: string, body: Record<string, unknown>) => api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ consentGranted: true, ...body });
const view = (employerId: string, actor: string, applicationId: string) => api().get(base(employerId) + '/applications/' + applicationId).set(auth(actor));
const resumeLink = (employerId: string, actor: string, applicationId: string) => api().get(base(employerId) + '/applications/' + applicationId + '/resume').set(auth(actor));
const noReadiness = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/readiness|mastery|gapStatus|fitScore|"score"|"band"|targetCareer|Data Analyst/i);

/** A published job, a student who reviewed and applied with a résumé, phone and link. */
async function applied(options: { resume?: boolean } = { resume: true }) {
  const org = await employer();
  const opportunityId = await job(org.employerId, org.recruiterId);
  const candidate = await student(options);
  const choices = { ...(candidate.resumeDocumentId ? { resumeDocumentId: candidate.resumeDocumentId } : {}), contactPhone: '+91 98765 43210', links: [{ url: 'https://portfolio.example.test/me', label: 'Portfolio' }] };
  const reviewed = await preview(candidate.id, { opportunityId, ...choices }).expect(201);
  const response = await applyAs(candidate.id, { opportunityId, ...choices, reviewedSnapshotHash: reviewed.body.preview.snapshotHash }).expect(201);
  return { ...org, opportunityId, candidate, applicationId: response.body.application.id as string, reviewed: reviewed.body.preview };
}
async function shortlist(p: { employerId: string; recruiterId: string; applicationId: string }) {
  await api().post(base(p.employerId) + '/applications/' + p.applicationId + '/transition').set(auth(p.recruiterId)).send({ toState: 'SHORTLISTED' }).expect(201);
}

describe('EMP-07: the student reviews the snapshot, and apply stores exactly that', () => {
  it('previews what will be shared — name, education, qualifications without figures, links, the chosen résumé — and nothing readiness-related', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const candidate = await student({ resume: true });
    const response = await preview(candidate.id, { opportunityId, resumeDocumentId: candidate.resumeDocumentId, links: [{ url: 'https://portfolio.example.test/me' }] }).expect(201);
    const { snapshot, snapshotHash, resumeOptions } = response.body.preview;
    expect(snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot).toEqual({
      schemaVersion: 1,
      candidate: { fullName: 'Synthetic Candidate', email: candidate.email, phone: null },
      education: { institutionName: 'Synthetic Institute of Technology', programmeName: 'BTech', departmentName: 'Computer Science', expectedGraduationYear: 2027 },
      qualifications: [{ qualificationType: 'BTECH', programmeName: 'BTech Computer Science', institutionName: 'Synthetic Institute of Technology', startedYear: 2023, completedYear: null, awarded: false, verification: 'SELF_REPORTED' }],
      profile: { headline: 'Aspiring analyst', summary: 'I like data.' },
      links: [{ label: null, url: 'https://portfolio.example.test/me' }],
      resume: { title: 'My résumé', filename: 'resume.pdf', versionNumber: 1, contentType: 'application/pdf', byteSize: RESUME_BYTES.length },
    });
    expect(resumeOptions).toEqual([{ documentId: candidate.resumeDocumentId, title: 'My résumé', versionNumber: 1, filename: 'resume.pdf', contentType: 'application/pdf', byteSize: RESUME_BYTES.length }]);
    expect(JSON.stringify(snapshot)).not.toMatch(/8\.4|cgpa|backlog/i);
    noReadiness(response.body);
  });

  it('writes exactly one snapshot per application, equal to the reviewed one and bound to the version applied under', async () => {
    const p = await applied();
    const rows = await pool.query(`SELECT s.snapshot, s.snapshot_hash, s.opportunity_version_id, s.resume_document_id, s.resume_file_id, s.resume_document_version_id, a.applied_version_id
      FROM application_profile_snapshots s JOIN applications a ON a.id = s.application_id WHERE s.application_id = $1`, [p.applicationId]);
    expect(rows.rows).toHaveLength(1);
    const [row] = rows.rows;
    expect(row.snapshot_hash).toBe(p.reviewed.snapshotHash);
    expect(row.snapshot).toEqual(p.reviewed.snapshot);
    expect(row.opportunity_version_id).toBe(row.applied_version_id);
    expect(row.resume_document_id).toBe(p.candidate.resumeDocumentId);
    expect(row.resume_file_id).not.toBeNull();
    // The student can read back exactly what they shared.
    const own = await api().get('/api/v1/students/me/applications/' + p.applicationId + '/snapshot').set(auth(p.candidate.id)).expect(200);
    expect(own.body.snapshot).toMatchObject({ content: p.reviewed.snapshot, snapshotHash: p.reviewed.snapshotHash });
    const stranger = await user();
    await api().get('/api/v1/students/me/applications/' + p.applicationId + '/snapshot').set(auth(stranger)).expect(403);
  });

  it('refuses the application, writing nothing, when what would be shared changed after the review', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const candidate = await student();
    const reviewed = await preview(candidate.id, { opportunityId }).expect(201);
    await pool.query("UPDATE student_profiles SET profile_headline = 'Changed my mind' WHERE user_id = $1", [candidate.id]);
    const refused = await applyAs(candidate.id, { opportunityId, reviewedSnapshotHash: reviewed.body.preview.snapshotHash }).expect(409);
    expect(refused.body.error.code).toBe('SNAPSHOT_CHANGED');
    expect((await pool.query('SELECT count(*)::int AS n FROM applications WHERE student_user_id = $1', [candidate.id])).rows[0].n).toBe(0);
    // A client built before EMP-07 sends no hash; the snapshot is still written.
    const legacy = await applyAs(candidate.id, { opportunityId }).expect(201);
    expect((await pool.query('SELECT snapshot FROM application_profile_snapshots WHERE application_id = $1', [legacy.body.application.id])).rows[0].snapshot.profile.headline).toBe('Changed my mind');
  });

  it('validates the choices: unknown fields, bad links and phones, and a résumé that is not the student\'s own', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const candidate = await student();
    const other = await student({ resume: true });
    const expectCode = async (body: Record<string, unknown>, code: string) => {
      expect((await preview(candidate.id, { opportunityId, ...body }).expect(400)).body.error.code).toBe(code);
      expect((await applyAs(candidate.id, { opportunityId, ...body }).expect(400)).body.error.code).toBe(code);
    };
    await expectCode({ readinessBand: 'HIGH' }, 'UNKNOWN_FIELD');
    await expectCode({ links: [{ url: 'http://insecure.example.test' }] }, 'INVALID_LINK_URL');
    await expectCode({ contactPhone: 'call me' }, 'INVALID_CONTACT_PHONE');
    await expectCode({ resumeDocumentId: other.resumeDocumentId }, 'RESUME_NOT_AVAILABLE');
    expect((await applyAs(candidate.id, { opportunityId, reviewedSnapshotHash: 'nope' }).expect(400)).body.error.code).toBe('INVALID_SNAPSHOT_HASH');
    await api().post('/api/v1/students/me/application-previews').send({ opportunityId }).expect(401);
    expect((await pool.query('SELECT count(*)::int AS n FROM applications WHERE student_user_id = $1', [candidate.id])).rows[0].n).toBe(0);
  });

  it('keeps the snapshot immutable: no update, no delete, and no snapshot for another version', async () => {
    const p = await applied({ resume: false });
    await expect(pool.query("UPDATE application_profile_snapshots SET snapshot = '{\"x\":1}' WHERE application_id = $1", [p.applicationId])).rejects.toThrow(/never rewritten/);
    await expect(pool.query('DELETE FROM application_profile_snapshots WHERE application_id = $1', [p.applicationId])).rejects.toThrow(/never deleted/);
    await expect(pool.query("INSERT INTO application_profile_snapshots (id, application_id, opportunity_version_id, snapshot, snapshot_hash) SELECT $1, id, NULL, '{}'::jsonb, $2 FROM applications WHERE id = $3",
      [randomUUID(), 'c'.repeat(64), p.applicationId])).rejects.toThrow();
    // Someone else's erase setting does not open the row either.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('one.privacy_erase_subject', $1, true)", [randomUUID()]);
      await expect(client.query("UPDATE application_profile_snapshots SET erased_at = now() WHERE application_id = $1", [p.applicationId])).rejects.toThrow(/never rewritten/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});

describe('EMP-07: the candidate view', () => {
  it('shows the snapshot, eligibility without figures, the timeline, interviews and the offer; contact details only from SHORTLISTED; audited', async () => {
    const p = await applied();
    const early = await view(p.employerId, p.recruiterId, p.applicationId).expect(200);
    const candidate = early.body.candidate;
    expect(candidate.snapshotStatus).toBe('SHARED');
    expect(candidate.snapshot.candidate).toEqual({ fullName: 'Synthetic Candidate', email: null, phone: null, contactVisibleFrom: 'SHORTLISTED' });
    expect(candidate.snapshot.education).toMatchObject({ institutionName: 'Synthetic Institute of Technology', expectedGraduationYear: 2027 });
    expect(candidate.snapshot.links).toEqual([{ label: 'Portfolio', url: 'https://portfolio.example.test/me' }]);
    expect(candidate.resumeAvailable).toBe(true);
    expect(candidate.application).toMatchObject({ id: p.applicationId, state: 'APPLIED', title: 'Graduate analyst', appliedVersionNumber: 2 });
    expect(candidate.eligibility).toMatchObject({ eligible: true, selfReportedCount: 1 });
    expect(candidate.eligibility.outcomes[0]).toMatchObject({ ruleType: 'MIN_CGPA', outcome: 'MET', basis: 'SELF_REPORTED' });
    expect(JSON.stringify(candidate)).not.toMatch(/8\.4/);
    expect(candidate.timeline.map((entry: { toState: string }) => entry.toState)).toEqual(['APPLIED']);
    expect(candidate.interviews).toEqual([]);
    expect(candidate.offer).toBeNull();
    expect(JSON.stringify(early.body)).not.toContain(p.candidate.resumeDocumentId);
    noReadiness(early.body);

    await shortlist(p);
    const later = await view(p.employerId, p.recruiterId, p.applicationId).expect(200);
    expect(later.body.candidate.snapshot.candidate).toEqual({ fullName: 'Synthetic Candidate', email: p.candidate.email, phone: '+91 98765 43210', contactVisibleFrom: null });
    expect(later.body.candidate.timeline.map((entry: { toState: string }) => entry.toState)).toEqual(['APPLIED', 'SHORTLISTED']);
    noReadiness(later.body);

    const audit = await pool.query("SELECT organization_id, actor_user_id, context FROM audit_events WHERE action = 'application.candidate_viewed' AND resource_id = $1", [p.applicationId]);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]).toMatchObject({ organization_id: p.employerId, actor_user_id: p.recruiterId });
    expect(audit.rows[0].context.snapshotHash).toBe(p.reviewed.snapshotHash);
  });

  it('says an application from before snapshots has none, rather than showing the live profile', async () => {
    const org = await employer();
    const opportunityId = await job(org.employerId, org.recruiterId);
    const candidate = await student();
    const applicationId = randomUUID();
    await pool.query(`INSERT INTO applications (id, opportunity_id, employer_id, applied_version_id, student_user_id, state, consent_granted_at, submitted_at)
      SELECT $1, o.id, o.employer_id, o.current_version_id, $2, 'APPLIED', now(), now() FROM opportunities o WHERE o.id = $3`, [applicationId, candidate.id, opportunityId]);
    await pool.query('INSERT INTO employer_applicant_access_grants (id, employer_id, student_user_id, opportunity_id, granted_at) VALUES ($1,$2,$3,$4,now())', [randomUUID(), org.employerId, candidate.id, opportunityId]);
    const response = await view(org.employerId, org.recruiterId, applicationId).expect(200);
    expect(response.body.candidate).toMatchObject({ snapshot: null, snapshotStatus: 'NOT_CAPTURED', resumeAvailable: false });
    expect(JSON.stringify(response.body)).not.toContain('Aspiring analyst');
    await resumeLink(org.employerId, org.recruiterId, applicationId).expect(404);
  });

  it('refuses without a token, for another employer, an ended membership, a suspended or unverified organisation, and a malformed id', async () => {
    const p = await applied({ resume: false });
    await api().get(base(p.employerId) + '/applications/' + p.applicationId).expect(401);
    const rival = await employer();
    await view(p.employerId, rival.recruiterId, p.applicationId).expect(403);
    await view(rival.employerId, rival.recruiterId, p.applicationId).expect(403);
    await view(p.employerId, p.recruiterId, 'not-a-uuid').expect(403);
    const student = await user();
    await view(p.employerId, student, p.applicationId).expect(403);

    await pool.query("UPDATE organizations SET verification_state = 'SUSPENDED', active = false WHERE id = $1", [p.employerId]);
    expect((await view(p.employerId, p.recruiterId, p.applicationId).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    await resumeLink(p.employerId, p.recruiterId, p.applicationId).expect(403);
    await pool.query("UPDATE organizations SET verification_state = 'PENDING', active = true WHERE id = $1", [p.employerId]);
    expect((await view(p.employerId, p.recruiterId, p.applicationId).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
    await pool.query("UPDATE organizations SET verification_state = 'VERIFIED', active = true WHERE id = $1", [p.employerId]);
    await view(p.employerId, p.recruiterId, p.applicationId).expect(200);

    await pool.query("UPDATE organization_memberships SET state = 'ENDED' WHERE id = $1", [p.membershipId]);
    await view(p.employerId, p.recruiterId, p.applicationId).expect(403);
  });

  it('withholds the candidate on the next request once the grant is revoked, expired, or the student asks to be deleted', async () => {
    // Revoked: the student withdraws.
    const withdrawn = await applied();
    await view(withdrawn.employerId, withdrawn.recruiterId, withdrawn.applicationId).expect(200);
    await api().post('/api/v1/students/me/applications/' + withdrawn.applicationId + '/withdraw').set(auth(withdrawn.candidate.id)).send({}).expect(201);
    await view(withdrawn.employerId, withdrawn.recruiterId, withdrawn.applicationId).expect(403);
    await resumeLink(withdrawn.employerId, withdrawn.recruiterId, withdrawn.applicationId).expect(403);

    // Expired.
    const expired = await applied();
    await pool.query("UPDATE employer_applicant_access_grants SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE student_user_id = $1", [expired.candidate.id]);
    await view(expired.employerId, expired.recruiterId, expired.applicationId).expect(403);
    await resumeLink(expired.employerId, expired.recruiterId, expired.applicationId).expect(403);

    // An open deletion request.
    const deleting = await applied();
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() + interval '30 days', 'emp07-test')`, [randomUUID(), deleting.candidate.id]);
    await view(deleting.employerId, deleting.recruiterId, deleting.applicationId).expect(403);
    await resumeLink(deleting.employerId, deleting.recruiterId, deleting.applicationId).expect(403);

    // Rejection closes the application and revokes the grant too.
    const rejected = await applied({ resume: false });
    await api().post(base(rejected.employerId) + '/applications/' + rejected.applicationId + '/transition').set(auth(rejected.recruiterId)).send({ toState: 'REJECTED', reasonCode: 'NOT_A_FIT' }).expect(201);
    await view(rejected.employerId, rejected.recruiterId, rejected.applicationId).expect(403);
  });
});

describe('EMP-07: the résumé leaves only through a single-use, short-lived link', () => {
  it('issues a 60-second link, serves the bytes once as an attachment to the recruiter who asked, and audits both', async () => {
    const p = await applied();
    const issued = await resumeLink(p.employerId, p.recruiterId, p.applicationId).expect(200);
    const { path, expiresAt } = issued.body.download;
    expect(path).toMatch(new RegExp(`^/api/v1/employers/${p.employerId}/applications/${p.applicationId}/resume/file\\?token=[A-Za-z0-9_-]{43}$`));
    // Measured against the database clock, which can run ahead of Node's.
    const window = await pool.query('SELECT extract(epoch FROM expires_at - issued_at)::int AS seconds, expires_at FROM application_resume_download_links WHERE application_id = $1', [p.applicationId]);
    expect(window.rows[0].seconds).toBe(60);
    expect(Date.parse(expiresAt)).toBe(new Date(window.rows[0].expires_at).getTime());

    // Another recruiter of the same employer cannot use someone else's link.
    const other = await colleague(p.employerId);
    await api().get(path).set(auth(other)).expect(403);

    const file = await api().get(path).set(auth(p.recruiterId)).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(Buffer.compare(file.body as Buffer, RESUME_BYTES)).toBe(0);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toBe('attachment; filename="resume.pdf"');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('no-store');

    // Once only.
    await api().get(path).set(auth(p.recruiterId)).expect(403);
    const actions = await pool.query("SELECT action, organization_id FROM audit_events WHERE resource_id = $1 AND action LIKE 'application.resume_%' ORDER BY occurred_at", [p.applicationId]);
    expect(actions.rows.map((row) => row.action)).toEqual(['application.resume_link_issued', 'application.resume_downloaded']);
    expect(actions.rows.every((row) => row.organization_id === p.employerId)).toBe(true);
    const stored = await pool.query('SELECT token_digest FROM application_resume_download_links WHERE application_id = $1', [p.applicationId]);
    expect(stored.rows[0].token_digest).not.toBe(path.split('token=')[1]);
  });

  it('refuses an expired link, a forged token, a link after the grant ends, and a résumé-less application', async () => {
    const p = await applied();
    const first = (await resumeLink(p.employerId, p.recruiterId, p.applicationId).expect(200)).body.download.path as string;
    await pool.query("UPDATE application_resume_download_links SET issued_at = now() - interval '10 minutes', expires_at = now() - interval '9 minutes' WHERE application_id = $1", [p.applicationId]);
    await api().get(first).set(auth(p.recruiterId)).expect(403);
    await api().get(base(p.employerId) + '/applications/' + p.applicationId + '/resume/file?token=' + 'A'.repeat(43)).set(auth(p.recruiterId)).expect(403);
    await api().get(base(p.employerId) + '/applications/' + p.applicationId + '/resume/file').set(auth(p.recruiterId)).expect(403);

    const second = (await resumeLink(p.employerId, p.recruiterId, p.applicationId).expect(200)).body.download.path as string;
    await api().post('/api/v1/students/me/applications/' + p.applicationId + '/withdraw').set(auth(p.candidate.id)).send({}).expect(201);
    await api().get(second).set(auth(p.recruiterId)).expect(403);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE resource_id = $1 AND action = 'application.resume_downloaded'", [p.applicationId])).rows[0].n).toBe(0);

    const none = await applied({ resume: false });
    expect((await resumeLink(none.employerId, none.recruiterId, none.applicationId).expect(404)).body.error.code).toBe('RESUME_NOT_AVAILABLE');
  });
});

describe('EMP-07: deleting the account erases what the student shared', () => {
  it('replaces the snapshot content, clears the résumé pointers and still deletes the documents', async () => {
    const p = await applied();
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, requested_at, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() - interval '31 days', now() - interval '1 day', 'emp07-test')`, [randomUUID(), p.candidate.id]);
    const summaries = await executeDueDeletions({ db, ids: { uuid: randomUUID }, storage });
    expect(summaries.find((summary) => summary.subjectUserId === p.candidate.id)?.outcome).toBe('COMPLETED');
    const row = (await pool.query('SELECT snapshot, erased_at, resume_document_id, resume_file_id, resume_document_version_id FROM application_profile_snapshots WHERE application_id = $1', [p.applicationId])).rows[0];
    expect(row.snapshot).toEqual({ schemaVersion: 1, erased: true });
    expect(row.erased_at).not.toBeNull();
    expect([row.resume_document_id, row.resume_file_id, row.resume_document_version_id]).toEqual([null, null, null]);
    expect((await pool.query('SELECT count(*)::int AS n FROM student_document_metadata WHERE student_user_id = $1', [p.candidate.id])).rows[0].n).toBe(0);
    await view(p.employerId, p.recruiterId, p.applicationId).expect(403);
  });
});
