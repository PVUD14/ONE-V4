/**
 * The résumé generator over HTTP (RESUME-GEN): 401 on every route; 403 on another student's résumé; another
 * student's records never appear, even when their ids are sent; unverified records are never labelled
 * verified (a certificate row in state VERIFIED included); no readiness, band, score, mastery or stage
 * in any response (contract test); saved versions are immutable and versioned; the PDF is a PDF; the save and
 * render limits answer 429; the student's export carries the résumés and account deletion erases them.
 *
 * Real Postgres in a throwaway schema of the local database in DATABASE_URL, a stub verifier, synthetic
 * people and institutions, dates relative to now.
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
import { RENDERS_PER_HOUR, SAVES_PER_HOUR } from './student-resumes.controller.js';
import { PG_POOL } from '../persistence.provider.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { assembleSubjectExport } from './privacy-export.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for résumé tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Résumé tests require local Postgres');

const schemaName = 'resume_api_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'd'.repeat(64);
let app: INestApplication;

/** Words that must never appear in a résumé response. */
const FORBIDDEN = /readiness|\bscore|\bband\b|mastery|\bstage\b|percentile|\brank/i;

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
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 60_000);

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': 'resume-' + randomUUID() });
const base = '/api/v1/students/me';
const binary = (response: request.Response, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
};

async function user(email?: string): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, email ?? 'resume-' + id.slice(0, 8) + '@example.test']);
  return id;
}

async function topic(name: string): Promise<string> {
  const author = await user();
  const topicId = randomUUID();
  const revision = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id,entity_type,entity_id,revision,author_user_id,state,content_hash,body) VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id,kind,stable_key,version,name,description,content_revision_id) VALUES ($1,'TOPIC',$2,1,$3,'Synthetic topic for résumé tests',$4)`,
    [topicId, 'resume-' + topicId.slice(0, 8), name, revision]);
  return topicId;
}

async function evidence(subject: string, topicId: string, stage = 'DEMONSTRATED'): Promise<void> {
  await pool.query(`INSERT INTO evidence_records (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id,
      content_version, provenance, occurred_at, assisted, stage_at_capture)
    VALUES ($1,$2,'ASSESSMENT_OUTCOME',$3,7,10,'assessment_attempt',$4,'assessment-v1','{}'::jsonb, now() - interval '3 days', false, $5)`,
  [randomUUID(), subject, topicId, randomUUID(), stage]);
}

interface Person {
  readonly id: string; readonly email: string; readonly college: string; readonly verifiedQ: string; readonly selfQ: string; readonly pendingQ: string;
  readonly rejectedQ: string; readonly verifiedTerm: string; readonly selfTerm: string; readonly skill: string; readonly hiddenSkill: string;
  readonly certificate: string; readonly target: string;
}

/** A student with a verified, a self-declared, a pending and a rejected qualification, evidence, a certificate and a career target. */
async function student(label: string): Promise<Person> {
  const email = `resume-${label}-${randomUUID().slice(0, 6)}@uat.example.test`;
  const id = await user(email);
  const staff = await user();
  const institutionId = randomUUID();
  const college = `Synthetic ${label} Institute`;
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION',$2,'VERIFIED',true)", [institutionId, college]);
  await pool.query("INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE', now() - interval '400 days')", [randomUUID(), institutionId, id]);
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,expected_graduation_date)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE', (now() + interval '300 days')::date)`, [randomUUID(), institutionId, id, 'ROLL-' + id.slice(0, 8), `Synthetic ${label} Student`]);
  await pool.query("INSERT INTO student_profiles (user_id, profile_headline, profile_summary) VALUES ($1,$2,'Builds small data tools.')", [id, `${label} headline`]);

  const verifiedQ = randomUUID(); const selfQ = randomUUID(); const pendingQ = randomUUID(); const rejectedQ = randomUUID();
  await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,started_on,verification_state,verified_by_user_id,verified_at)
    VALUES ($1,$2,$3,'BTECH',$4,(now() - interval '800 days')::date,'VERIFIED',$5, now() - interval '10 days')`, [verifiedQ, id, institutionId, `${label} Computer Science`, staff]);
  await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_name_declared,qualification_type,programme_name,started_on,completed_on,awarded)
    VALUES ($1,$2,'Synthetic Junior College','OTHER',$3,(now() - interval '1600 days')::date,(now() - interval '900 days')::date,true)`, [selfQ, id, `${label} Class XII`]);
  await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,verification_state)
    VALUES ($1,$2,$3,'DIPLOMA',$4,'PENDING_VERIFICATION')`, [pendingQ, id, institutionId, `${label} Pending Diploma`]);
  await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,verification_state,verified_by_user_id,verified_at)
    VALUES ($1,$2,$3,'MBA',$4,'REJECTED',$5, now() - interval '5 days')`, [rejectedQ, id, institutionId, `${label} Rejected MBA`, staff]);
  const verifiedTerm = randomUUID(); const selfTerm = randomUUID();
  await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,source,verification_state,verified_by_user_id,verified_at)
    VALUES ($1,$2,1,'Semester 1',8.4,'CGPA_10','INSTITUTION_IMPORTED','VERIFIED',$3, now() - interval '9 days')`, [verifiedTerm, verifiedQ, staff]);
  await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,source)
    VALUES ($1,$2,2,'Semester 2',7.9,'CGPA_10','STUDENT_DECLARED')`, [selfTerm, verifiedQ]);

  const skill = await topic(`${label} SQL joins`);
  await evidence(id, skill);
  await evidence(id, skill);
  // Graded work recorded before the skill was demonstrated does not qualify (EMP-13's rule).
  const hiddenSkill = await topic(`${label} Pivot tables`);
  await evidence(id, hiddenSkill, 'ESTIMATED');

  const certificate = randomUUID();
  // A student can no longer mark their own document VERIFIED (0107), so the fixture records a real
  // institution verifier. The résumé still labels every certificate self-declared: a document's
  // verification state is not one of its sources, so nothing a document row says can earn a badge.
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
    VALUES ($1,$2,$3,'INSTITUTION_ADMIN','ACTIVE',$2,$2)`, [randomUUID(), institutionId, staff]);
  await pool.query(`INSERT INTO student_document_metadata (id,student_user_id,title,document_type,description,verification_state,
      verified_by_user_id,verified_at,verification_institution_id)
    VALUES ($1,$2,$3,'CERTIFICATE','Online course','VERIFIED',$4, now() - interval '2 days',$5)`, [certificate, id, `${label} Cloud certificate`, staff, institutionId]);
  const roleId = randomUUID();
  await pool.query("INSERT INTO career_roles (id,code,title,family) VALUES ($1,$2,$3,'Data')", [roleId, 'RESUME_' + roleId.slice(0, 8).toUpperCase(), `${label} Data Analyst`]);
  const target = randomUUID();
  await pool.query("INSERT INTO student_career_targets (id,student_user_id,career_role_id,priority) VALUES ($1,$2,$3,'PRIMARY')", [target, id, roleId]);
  return { id, email, college, verifiedQ, selfQ, pendingQ, rejectedQ, verifiedTerm, selfTerm, skill, hiddenSkill, certificate, target };
}

function draftFor(p: Person, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    title: 'Campus drives', template: 'MODERN',
    header: { fullName: 'Synthetic Student', headline: 'Final-year student', phone: '+91 90000 00000', location: 'Hyderabad', showEmail: true,
      links: [{ label: 'GitHub', url: 'https://github.com/example' }] },
    summary: 'I build small data tools.',
    qualificationIds: [p.verifiedQ, p.selfQ, p.pendingQ, p.rejectedQ], termIds: [p.verifiedTerm, p.selfTerm],
    skillTopicIds: [p.skill, p.hiddenSkill], certificateIds: [p.certificate], careerTargetIds: [p.target],
    declaredSkills: ['Python'], projects: [{ title: 'Attendance tracker', description: 'A small web app.' }], languages: ['English', 'తెలుగు'],
    ...extra,
  };
}

describe('student résumés API', () => {
  it('401 without a token on every route', async () => {
    const id = randomUUID();
    for (const response of [
      await api().get(base + '/resume-sources'), await api().post(base + '/resumes/preview').send({}),
      await api().get(base + '/resumes'), await api().post(base + '/resumes').send({}),
      await api().get(`${base}/resumes/${id}`), await api().post(`${base}/resumes/${id}/versions`).send({}),
      await api().get(`${base}/resumes/${id}/versions/1/pdf`), await api().delete(`${base}/resumes/${id}`),
    ]) expect(response.status).toBe(401);
  });

  it('offers only the student’s own records, labelled honestly, with no readiness anywhere', async () => {
    const a = await student('Alpha');
    const b = await student('Beta');
    const response = await api().get(base + '/resume-sources').set(auth(a.id)).expect(200);
    const sources = response.body.sources;
    expect(sources.header).toMatchObject({ fullName: 'Synthetic Alpha Student', email: a.email, headline: 'Alpha headline' });
    const byTitle = Object.fromEntries(sources.qualifications.map((q: { title: string }) => [q.title, q]));
    expect(Object.keys(byTitle).sort()).toEqual(['Alpha Class XII', 'B.Tech — Alpha Computer Science', 'Diploma — Alpha Pending Diploma']);
    expect(byTitle['B.Tech — Alpha Computer Science']).toMatchObject({ verification: `Verified by ${a.college}`, verified: true });
    expect(byTitle['Alpha Class XII']).toMatchObject({ verification: 'Self-declared', verified: false });
    expect(byTitle['Diploma — Alpha Pending Diploma']).toMatchObject({ verification: 'Self-declared · verification pending', verified: false });
    expect(byTitle['B.Tech — Alpha Computer Science'].terms).toEqual([
      { id: a.verifiedTerm, label: 'Semester 1', result: '8.40 CGPA (of 10)', verification: `Verified by ${a.college}`, verified: true },
      { id: a.selfTerm, label: 'Semester 2', result: '7.90 CGPA (of 10)', verification: 'Self-declared', verified: false },
    ]);
    expect(sources.skills.map((s: { name: string }) => s.name)).toEqual(['Alpha SQL joins']);
    expect(sources.skills[0].basis).toMatch(/^Shown in ONE skill checks, /);
    expect(sources.certificates).toEqual([{ id: a.certificate, title: 'Alpha Cloud certificate', description: 'Online course', verification: 'Self-declared' }]);
    expect(sources.careerTargets).toEqual([{ id: a.target, roleTitle: 'Alpha Data Analyst' }]);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('Beta');
    expect(text).not.toContain(b.email);
    expect(text).not.toMatch(FORBIDDEN);
    expect(response.body.templates.map((t: { key: string }) => t.key)).toEqual(['CLASSIC', 'MODERN', 'COMPACT']);
  });

  it('previews without writing, ignores another student’s ids, and never labels an unverified item verified', async () => {
    const a = await student('Gamma');
    const b = await student('Delta');
    const body = draftFor(a, {
      qualificationIds: [a.verifiedQ, a.selfQ, a.pendingQ, a.rejectedQ, b.verifiedQ], termIds: [a.verifiedTerm, a.selfTerm, b.verifiedTerm],
      skillTopicIds: [a.skill, a.hiddenSkill, b.skill], certificateIds: [a.certificate, b.certificate], careerTargetIds: [a.target, b.target],
    });
    const response = await api().post(base + '/resumes/preview').set(auth(a.id)).send(body).expect(201);
    const { content, checks } = response.body;
    expect(content.education.map((e: { title: string }) => e.title)).toEqual(['B.Tech — Gamma Computer Science', 'Gamma Class XII', 'Diploma — Gamma Pending Diploma']);
    expect(content.skills.shown.map((s: { name: string }) => s.name)).toEqual(['Gamma SQL joins']);
    expect(content.certificates).toEqual([{ title: 'Gamma Cloud certificate', description: 'Online course', verification: 'Self-declared' }]);
    expect(content.objective).toEqual(['Gamma Data Analyst']);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('Delta');
    expect(text).not.toContain('Rejected');
    expect(text).not.toMatch(FORBIDDEN);
    // "Verified by <college>" appears only on the verified B.Tech and its verified term (the legend explains the label).
    expect(text.match(/Verified by Synthetic/g)).toHaveLength(2);
    for (const entry of content.education) if (!entry.verified) expect(entry.verification).not.toMatch(/Verified/);
    expect(checks.every((c: { passed: unknown }) => typeof c.passed === 'boolean')).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM student_resumes WHERE student_user_id = $1', [a.id])).rows[0].n).toBe(0);
  });

  it('refuses a malformed draft and a client-sent label', async () => {
    const a = await student('Epsilon');
    const bad = await api().post(base + '/resumes/preview').set(auth(a.id)).send({ ...draftFor(a), verified: true }).expect(400);
    expect(bad.body.error.code).toBe('UNKNOWN_FIELD');
    const url = await api().post(base + '/resumes/preview').set(auth(a.id)).send(draftFor(a, { header: { links: [{ url: 'javascript:alert(1)' }] } })).expect(400);
    expect(url.body.error.code).toBe('INVALID_URL');
  });

  it('saves versions, serves the PDF, keeps versions immutable, and answers 403 on another student’s résumé', async () => {
    const a = await student('Zeta');
    const b = await student('Eta');
    const created = await api().post(base + '/resumes').set(auth(a.id)).send(draftFor(a)).expect(201);
    const resumeId = created.body.resume.id as string;
    expect(created.body.resume.latest).toMatchObject({ versionNumber: 1, template: 'MODERN' });
    expect(JSON.stringify(created.body)).not.toMatch(FORBIDDEN);

    const second = await api().post(`${base}/resumes/${resumeId}/versions`).set(auth(a.id))
      .send(draftFor(a, { template: 'COMPACT', title: 'Data roles', summary: 'Changed summary.' })).expect(201);
    expect(second.body.resume).toMatchObject({ title: 'Data roles' });
    expect(second.body.resume.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    expect(second.body.resume.latest.content.summary).toBe('Changed summary.');
    expect(second.body.resume.latest.selections.template).toBe('COMPACT');

    const list = await api().get(base + '/resumes').set(auth(a.id)).expect(200);
    expect(list.body.resumes).toEqual([expect.objectContaining({ id: resumeId, title: 'Data roles', latestVersion: 2, versionCount: 2, template: 'COMPACT' })]);
    expect((await api().get(base + '/resumes').set(auth(b.id)).expect(200)).body.resumes).toEqual([]);

    const pdf = await api().get(`${base}/resumes/${resumeId}/versions/1/pdf`).set(auth(a.id)).buffer(true).parse(binary).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="Data-roles-v1.pdf"');
    expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Another student: every route on this résumé is 403, and nothing changes.
    await api().get(`${base}/resumes/${resumeId}`).set(auth(b.id)).expect(403);
    await api().post(`${base}/resumes/${resumeId}/versions`).set(auth(b.id)).send(draftFor(b)).expect(403);
    await api().get(`${base}/resumes/${resumeId}/versions/1/pdf`).set(auth(b.id)).expect(403);
    await api().delete(`${base}/resumes/${resumeId}`).set(auth(b.id)).expect(403);
    await api().get(`${base}/resumes/${resumeId}/versions/9/pdf`).set(auth(a.id)).expect(403);
    await api().get(`${base}/resumes/not-a-uuid`).set(auth(a.id)).expect(403);

    // A saved version is what the student saw: the database refuses to rewrite it.
    await expect(pool.query("UPDATE student_resume_versions SET content = '{}'::jsonb WHERE resume_id = $1", [resumeId])).rejects.toThrow(/never rewritten/);
    // And it refuses readiness in content even from a direct write.
    await expect(pool.query(`INSERT INTO student_resume_versions (id,resume_id,student_user_id,version_number,template_key,selections,content,content_hash)
      VALUES ($1,$2,$3,9,'CLASSIC','{}','{"readiness":"HIGH"}',$4)`, [randomUUID(), resumeId, a.id, SHA.replaceAll('d', 'a')])).rejects.toThrow(/student_resume_version_content_ck/);
    // A version cannot be filed under another student's résumé.
    await expect(pool.query(`INSERT INTO student_resume_versions (id,resume_id,student_user_id,version_number,template_key,selections,content,content_hash)
      VALUES ($1,$2,$3,9,'CLASSIC','{}','{}',$4)`, [randomUUID(), resumeId, b.id, SHA.replaceAll('d', 'a')])).rejects.toThrow(/student_resume_version_resume_fk/);

    await api().delete(`${base}/resumes/${resumeId}`).set(auth(a.id)).expect(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM student_resume_versions WHERE resume_id = $1', [resumeId])).rows[0].n).toBe(0);
    const audit = await pool.query("SELECT action FROM audit_events WHERE actor_user_id = $1 AND resource_type = 'student_resume' ORDER BY occurred_at, action", [a.id]);
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['resume.created', 'resume.version_saved', 'resume.pdf_rendered', 'resume.deleted']));
  });

  it('answers 429 past the hourly save and render limits', async () => {
    const a = await student('Theta');
    const created = await api().post(base + '/resumes').set(auth(a.id)).send(draftFor(a)).expect(201);
    const resumeId = created.body.resume.id as string;
    // Fill the hour with saves on a second résumé, written directly so the test stays quick.
    const other = randomUUID();
    await pool.query("INSERT INTO student_resumes (id,student_user_id,title) VALUES ($1,$2,'Filler')", [other, a.id]);
    for (let version = 1; version < SAVES_PER_HOUR; version += 1) {
      await pool.query(`INSERT INTO student_resume_versions (id,resume_id,student_user_id,version_number,template_key,selections,content,content_hash)
        VALUES ($1,$2,$3,$4,'CLASSIC','{}','{}',$5)`, [randomUUID(), other, a.id, version, SHA]);
    }
    const limited = await api().post(`${base}/resumes/${resumeId}/versions`).set(auth(a.id)).send(draftFor(a)).expect(429);
    expect(limited.body.error.code).toBe('SAVE_RATE_LIMITED');

    for (let render = 0; render < RENDERS_PER_HOUR; render += 1) {
      await pool.query(`INSERT INTO audit_events (id,actor_user_id,action,resource_type,resource_id,outcome,correlation_id)
        VALUES ($1,$2,'resume.pdf_rendered','student_resume',$3,'SUCCESS','resume-test')`, [randomUUID(), a.id, resumeId]);
    }
    const rendered = await api().get(`${base}/resumes/${resumeId}/versions/1/pdf`).set(auth(a.id)).expect(429);
    expect(rendered.body.error.code).toBe('PDF_RATE_LIMITED');
  });

  it('puts the résumés in the student’s export and erases them on account deletion', async () => {
    const a = await student('Iota');
    const b = await student('Kappa');
    await api().post(base + '/resumes').set(auth(a.id)).send(draftFor(a)).expect(201);
    await api().post(base + '/resumes').set(auth(b.id)).send(draftFor(b)).expect(201);

    const exported = await assembleSubjectExport(db, a.id);
    const resumes = exported.resumes as { title: string; versions: { versionNumber: number; template: string; content: { education: unknown[] } }[] }[];
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ title: 'Campus drives', versions: [{ versionNumber: 1, template: 'MODERN' }] });
    expect(resumes[0]?.versions[0]?.content.education).toHaveLength(3);
    const exportText = JSON.stringify(resumes);
    expect(exportText).not.toContain('Kappa');
    // The selections are record ids; the export carries the words, not the ids.
    expect(exportText).not.toContain(a.verifiedQ);

    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, requested_at, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() - interval '31 days', now() - interval '1 day', 'resume-delete')`, [randomUUID(), a.id]);
    const [summary] = (await executeDueDeletions({ db, ids: { uuid: () => randomUUID() } })).filter((row) => row.subjectUserId === a.id);
    expect(summary?.outcome).toBe('COMPLETED');
    expect((await pool.query('SELECT count(*)::int AS n FROM student_resumes WHERE student_user_id = $1', [a.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM student_resume_versions WHERE student_user_id = $1', [a.id])).rows[0].n).toBe(0);
    // Another student's résumé is untouched.
    expect((await pool.query('SELECT count(*)::int AS n FROM student_resumes WHERE student_user_id = $1', [b.id])).rows[0].n).toBe(1);
  });
});
