/**
 * Consented, per-skill verified evidence per application (EMP-13, ADR-043).
 *
 * Pins: nothing is shared without the student's per-application choice; only verified evidence
 * (graded, DEMONSTRATED at capture, something correct, not superseded, never a lesson) for the job's
 * catalogue skills can be chosen; the employer reads it only through a live applicant-access grant,
 * audited, as type / source / date / unaided per skill; revocation takes effect on the next request;
 * the filter narrows without ranking and never reveals a withdrawn applicant; no readiness band,
 * score, gap status, mastery value, stage, marks, count or identifier reaches an employer; the
 * database refuses to share someone else's evidence; deletion revokes every share; and while the
 * flag is off (HG-4 pending) nothing is offered, accepted or shown.
 *
 * Runs over real HTTP with a stub verifier, like the EMP-07 spec, in a throwaway schema of the local
 * Postgres in DATABASE_URL.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createLocalDiskStorage, type FileStorage } from '../storage/file-storage.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { assembleSubjectExport } from './privacy-export.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for skill evidence tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Skill evidence tests require local Postgres');
const schemaName = 'skill_evidence_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'a'.repeat(64);
let storageRoot: string;
let storage: FileStorage;
let app: INestApplication;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  storageRoot = await mkdtemp(join(tmpdir(), 'one-emp13-'));
  storage = createLocalDiskStorage(storageRoot);
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      fileStorage: storage,
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

const setFlag = (enabled: boolean) => pool.query("UPDATE feature_flags SET enabled = $1 WHERE key = 'employer.skill-evidence'", [enabled]);
beforeEach(async () => { await setFlag(true); });

async function user(email?: string): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, email ?? id + '@example.test']);
  return id;
}
async function member(employerId: string, role = 'RECRUITER', state = 'ACTIVE'): Promise<string> {
  const id = await user();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_employer_id)
    VALUES ($1,$2,$3,$4,$5,$2,$2)`, [randomUUID(), employerId, id, role, state]);
  return id;
}
async function employer() {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Evidence employer','VERIFIED',true)", [employerId]);
  return { employerId, recruiterId: await member(employerId) };
}
async function student(): Promise<string> {
  const id = await user('candidate-' + randomUUID().slice(0, 8) + '@uat.example.test');
  const institutionId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION','Synthetic Institute of Technology','VERIFIED',true)", [institutionId]);
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status)
    VALUES ($1,$2,$3,$4,'Synthetic Candidate','ACTIVE')`, [randomUUID(), institutionId, id, 'R-' + id.slice(0, 8)]);
  await pool.query("INSERT INTO student_profiles (user_id, profile_headline, target_career) VALUES ($1,'Aspiring analyst','Data Analyst')", [id]);
  return id;
}
/** A catalogue skill: a topic that a published career-role requirement names (OPS-08). */
async function catalogueSkill(name: string): Promise<string> {
  const author = await user();
  const topicId = randomUUID();
  const revision = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id,entity_type,entity_id,revision,author_user_id,state,content_hash,body) VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id,kind,stable_key,version,name,description,content_revision_id) VALUES ($1,'TOPIC',$2,1,$3,'Synthetic topic for EMP-13 tests',$4)`,
    [topicId, 'emp13-' + topicId.slice(0, 8), name, revision]);
  const roleId = randomUUID();
  await pool.query("INSERT INTO career_roles (id,code,title,family) VALUES ($1,$2,'Synthetic data analyst','Data')", [roleId, 'EMP13_' + roleId.slice(0, 8).toUpperCase()]);
  await pool.query("INSERT INTO career_role_requirements (id,career_role_id,topic_id,requirement_level,target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.7)", [randomUUID(), roleId, topicId]);
  return topicId;
}
interface EvidenceOptions {
  type?: string; stage?: string; demonstrated?: number; possible?: number; assisted?: boolean; source?: string; daysAgo?: number; supersedes?: string;
}
async function evidence(subject: string, topicId: string, options: EvidenceOptions = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO evidence_records (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id,
      content_version, provenance, occurred_at, assisted, stage_at_capture, supersedes_evidence_id, correction_reason_code)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'assessment-v1','{}'::jsonb, now() - make_interval(days => $9), $10, $11, $12, $13)`,
  [id, subject, options.type ?? 'ASSESSMENT_OUTCOME', topicId, options.demonstrated ?? 7, options.possible ?? 10, options.source ?? 'assessment_attempt', randomUUID(),
    options.daysAgo ?? 1, options.assisted ?? false, options.stage ?? 'DEMONSTRATED', options.supersedes ?? null, options.supersedes ? 'SCORING_FIX' : null]);
  return id;
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId;
const terms = {
  title: 'Graduate analyst', summary: 'Analyse data.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai',
  compensationDisclosed: true, compensationCurrency: 'INR', compensationMin: 800000, compensationPeriod: 'YEAR',
};
/** A published job asking for two catalogue skills (SQL required, statistics preferred) and a free-text one. */
async function job(employerId: string, recruiterId: string, sqlTopic: string, statsTopic: string): Promise<string> {
  const created = await api().post(base(employerId) + '/opportunities').set(auth(recruiterId)).send({ referenceCode: 'EV-' + randomUUID().slice(0, 8), ...terms }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(base(employerId) + '/opportunities/' + id + '/versions').set(auth(recruiterId)).send({
    ...terms, expectedCurrentVersionId: created.body.opportunity.versionId,
    skills: [{ taxonomyTopicId: sqlTopic, level: 'REQUIRED' }, { taxonomyTopicId: statsTopic, level: 'PREFERRED' }, { name: 'Written communication', level: 'REQUIRED' }],
  }).expect(201);
  await api().post(base(employerId) + '/opportunities/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind: 'PUBLIC' }).expect(201);
  await api().post(base(employerId) + '/opportunities/' + id + '/publish').set(auth(recruiterId)).expect(201);
  return id;
}
const preview = (studentId: string, opportunityId: string) => api().post('/api/v1/students/me/application-previews').set(auth(studentId)).send({ opportunityId });
const applyAs = (studentId: string, opportunityId: string, extra: Record<string, unknown> = {}) =>
  api().post('/api/v1/students/me/applications').set(auth(studentId)).send({ consentGranted: true, opportunityId, ...extra });
const panel = (employerId: string, actor: string, applicationId: string) => api().get(base(employerId) + '/applications/' + applicationId + '/evidence').set(auth(actor));
const own = (studentId: string, applicationId: string) => api().get('/api/v1/students/me/applications/' + applicationId + '/evidence').set(auth(studentId));
const choose = (studentId: string, applicationId: string, evidenceRecordIds: unknown) =>
  api().put('/api/v1/students/me/applications/' + applicationId + '/evidence').set(auth(studentId)).send({ evidenceRecordIds });
const applicants = (employerId: string, actor: string, opportunityId: string, evidenceSkill?: string) =>
  api().get(base(employerId) + '/opportunities/' + opportunityId + '/applications').query(evidenceSkill ? { evidenceSkill } : {}).set(auth(actor));
const audits = async (action: string, resourceId: string) =>
  (await pool.query('SELECT actor_user_id, organization_id, context FROM audit_events WHERE action = $1 AND resource_id = $2', [action, resourceId])).rows;

/**
 * The contract: nothing readiness-like, no marks, no stage, no count, no identifier of the evidence
 * or the skill. Keys are checked by name, and values against every band, stage and gap status.
 */
const forbiddenKey = /^(readiness.*|band|.*Band|score|.*Score|mastery.*|gapStatus|gap_status|percent.*|percentage|rank.*|total.*|count|evidenceCount|demonstrated|possible|stage|stageAtCapture|stage_at_capture|evidenceId|evidence_id|topicId|taxonomyTopicId|fit.*)$/i;
const forbiddenValue = new Set(['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP', 'DEMONSTRATED', 'TRANSFERRED', 'RETAINED', 'ESTIMATED', 'PARTIAL', 'MISSING']);
function assertNoReadiness(body: unknown, secrets: readonly string[] = []): void {
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        expect(key, `${path}.${key}`).not.toMatch(forbiddenKey);
        walk(inner, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === 'string') expect(forbiddenValue.has(value), `${path} = ${value}`).toBe(false);
  };
  walk(body, '$');
  const text = JSON.stringify(body);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/Data Analyst|"7"|7\/10|70%/);
}

interface Setup {
  employerId: string; recruiterId: string; opportunityId: string; sqlTopic: string; statsTopic: string;
  studentId: string; good: string; aided: string; exam: string;
  notShareable: Record<'lesson' | 'retained' | 'estimated' | 'nothingRight' | 'replaced' | 'otherTopic' | 'someoneElses', string>;
}
/** One job and one student with a spread of evidence: three shareable items and six that must never be offered. */
async function setup(): Promise<Setup> {
  const org = await employer();
  const sqlTopic = await catalogueSkill('Synthetic SQL ' + randomUUID().slice(0, 4));
  const statsTopic = await catalogueSkill('Synthetic statistics ' + randomUUID().slice(0, 4));
  const opportunityId = await job(org.employerId, org.recruiterId, sqlTopic, statsTopic);
  const studentId = await student();
  const good = await evidence(studentId, sqlTopic, { daysAgo: 2 });
  const aided = await evidence(studentId, sqlTopic, { assisted: true, stage: 'TRANSFERRED', daysAgo: 1 });
  const exam = await evidence(studentId, statsTopic, { source: 'exam_attempt', daysAgo: 3 });
  const replaced = await evidence(studentId, sqlTopic, { daysAgo: 5 });
  const otherTopic = await catalogueSkill('Synthetic unrelated ' + randomUUID().slice(0, 4));
  const someoneElse = await student();
  const notShareable = {
    lesson: await evidence(studentId, sqlTopic, { type: 'LESSON_COMPLETION', demonstrated: 1, possible: 1, source: 'learner_progress' }),
    retained: await evidence(studentId, sqlTopic, { stage: 'RETAINED' }),
    estimated: await evidence(studentId, sqlTopic, { stage: 'ESTIMATED' }),
    nothingRight: await evidence(studentId, sqlTopic, { demonstrated: 0 }),
    replaced,
    otherTopic: await evidence(studentId, otherTopic),
    someoneElses: await evidence(someoneElse, sqlTopic),
  };
  // The correction that supersedes `replaced` is itself shareable; `replaced` no longer is.
  await evidence(studentId, sqlTopic, { supersedes: replaced, daysAgo: 4 });
  return { ...org, opportunityId, sqlTopic, statsTopic, studentId, good, aided, exam, notShareable };
}
async function appliedWith(s: Setup, evidenceRecordIds: string[]): Promise<string> {
  const reviewed = await preview(s.studentId, s.opportunityId).expect(201);
  const response = await applyAs(s.studentId, s.opportunityId, { reviewedSnapshotHash: reviewed.body.preview.snapshotHash, evidenceRecordIds }).expect(201);
  return response.body.application.id as string;
}

describe('EMP-13: the student sees which of their verified evidence matches the job, and chooses', () => {
  it('offers only verified evidence for the job\'s catalogue skills, with exactly the fields the employer would see', async () => {
    const s = await setup();
    const response = await preview(s.studentId, s.opportunityId).expect(201);
    const { evidence: offered } = response.body.preview;
    expect(offered.available).toBe(true);
    expect(offered.skills.map((skill: { name: string; level: string; catalogue: boolean }) => [skill.level, skill.catalogue]))
      .toEqual([['REQUIRED', true], ['REQUIRED', false], ['PREFERRED', true]]);
    const ids = offered.skills.flatMap((skill: { items: { evidenceId: string }[] }) => skill.items.map((item) => item.evidenceId));
    expect(ids).toEqual(expect.arrayContaining([s.good, s.aided, s.exam]));
    for (const id of Object.values(s.notShareable)) expect(ids).not.toContain(id);
    expect(offered.skills[1].items).toEqual([]);
    const aided = offered.skills[0].items.find((item: { evidenceId: string }) => item.evidenceId === s.aided);
    expect(aided).toEqual({ evidenceId: s.aided, type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: expect.any(String), unaided: false });
    expect(offered.skills[2].items).toEqual([{ evidenceId: s.exam, type: 'ASSESSMENT_OUTCOME', source: 'INSTITUTION_EXAM', occurredAt: expect.any(String), unaided: true }]);
    expect(JSON.stringify(offered)).not.toMatch(/demonstrated|possible|stage|DEMONSTRATED|TRANSFERRED/);
  });

  it('shares exactly what was chosen at apply, and nothing when nothing was chosen', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good, s.exam]);
    const rows = await pool.query("SELECT evidence_record_id, shared_via, revoked_at FROM application_evidence_shares WHERE application_id = $1 ORDER BY shared_at", [applicationId]);
    expect(rows.rows.map((row) => row.evidence_record_id).sort()).toEqual([s.good, s.exam].sort());
    expect(rows.rows.every((row) => row.shared_via === 'APPLY' && row.revoked_at === null)).toBe(true);
    expect(await audits('application.evidence_shared', applicationId)).toHaveLength(1);

    // A second student applies without choosing anything: the employer sees every skill with nothing shared.
    const other = await student();
    await evidence(other, s.sqlTopic);
    const reviewed = await preview(other, s.opportunityId).expect(201);
    const plain = (await applyAs(other, s.opportunityId, { reviewedSnapshotHash: reviewed.body.preview.snapshotHash }).expect(201)).body.application.id as string;
    const seen = await panel(s.employerId, s.recruiterId, plain).expect(200);
    expect(seen.body.evidence.skills.every((skill: { items: unknown[] }) => skill.items.length === 0)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM application_evidence_shares WHERE application_id = $1', [plain])).rows[0].n).toBe(0);
  });

  it('refuses the whole application when a chosen item is not shareable, and validates the selection', async () => {
    const s = await setup();
    for (const [label, id] of Object.entries(s.notShareable)) {
      const refused = await applyAs(s.studentId, s.opportunityId, { evidenceRecordIds: [s.good, id] }).expect(400);
      expect(refused.body.error.code, label).toBe('EVIDENCE_NOT_SHAREABLE');
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM applications WHERE student_user_id = $1', [s.studentId])).rows[0].n).toBe(0);
    for (const bad of ['not-a-list', ['nope'], [s.good, s.good], Array.from({ length: 61 }, () => randomUUID())]) {
      expect((await applyAs(s.studentId, s.opportunityId, { evidenceRecordIds: bad }).expect(400)).body.error.code).toBe('INVALID_EVIDENCE_SELECTION');
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM applications WHERE student_user_id = $1', [s.studentId])).rows[0].n).toBe(0);
  });

  it('lets the student add and take back evidence after applying; revocation takes effect on the employer\'s next request', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good]);
    const before = await panel(s.employerId, s.recruiterId, applicationId).expect(200);
    expect(before.body.evidence.skills[0].items).toHaveLength(1);

    const added = await choose(s.studentId, applicationId, [s.good, s.aided, s.exam]).expect(200);
    expect(added.body.evidence.canShare).toBe(true);
    const sharedIds = added.body.evidence.skills.flatMap((skill: { items: { evidenceId: string; shared: boolean }[] }) => skill.items.filter((item) => item.shared).map((item) => item.evidenceId));
    expect(sharedIds.sort()).toEqual([s.good, s.aided, s.exam].sort());
    expect((await panel(s.employerId, s.recruiterId, applicationId).expect(200)).body.evidence.skills[0].items).toHaveLength(2);

    // Take the SQL items back: the very next employer read has none for that skill.
    await choose(s.studentId, applicationId, [s.exam]).expect(200);
    const after = await panel(s.employerId, s.recruiterId, applicationId).expect(200);
    expect(after.body.evidence.skills[0].items).toEqual([]);
    expect(after.body.evidence.skills[2].items).toHaveLength(1);
    expect(await audits('application.evidence_share_revoked', applicationId)).toHaveLength(1);
    const revoked = await pool.query("SELECT count(*)::int AS n FROM application_evidence_shares WHERE application_id = $1 AND revoked_reason = 'STUDENT_REVOKED'", [applicationId]);
    expect(revoked.rows[0].n).toBe(2);

    // Not shareable after applying either; unknown fields and malformed ids are refused.
    expect((await choose(s.studentId, applicationId, [s.exam, s.notShareable.lesson]).expect(400)).body.error.code).toBe('EVIDENCE_NOT_SHAREABLE');
    expect((await api().put('/api/v1/students/me/applications/' + applicationId + '/evidence').set(auth(s.studentId)).send({ evidenceRecordIds: [], readinessBand: 'HIGH' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await choose(s.studentId, applicationId, 'all').expect(400)).body.error.code).toBe('INVALID_EVIDENCE_SELECTION');
    // Only the applicant can see or change it.
    const stranger = await student();
    await own(stranger, applicationId).expect(403);
    await choose(stranger, applicationId, []).expect(403);
    await api().get('/api/v1/students/me/applications/' + applicationId + '/evidence').expect(401);
  });

  it('after withdrawal the employer is refused, adding is refused, and taking back still works', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good]);
    await api().post('/api/v1/students/me/applications/' + applicationId + '/withdraw').set(auth(s.studentId)).send({}).expect(201);
    await panel(s.employerId, s.recruiterId, applicationId).expect(403);
    expect((await choose(s.studentId, applicationId, [s.good, s.exam]).expect(400)).body.error.code).toBe('APPLICATION_CLOSED');
    const view = await own(s.studentId, applicationId).expect(200);
    expect(view.body.evidence.canShare).toBe(false);
    await choose(s.studentId, applicationId, []).expect(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM application_evidence_shares WHERE application_id = $1 AND revoked_at IS NULL', [applicationId])).rows[0].n).toBe(0);
  });
});

describe('EMP-13: the employer\'s Evidence panel', () => {
  it('lists, per job skill in the job\'s order, the shared items as type, source, date and unaided — audited, and nothing else', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good, s.aided, s.exam]);
    const response = await panel(s.employerId, s.recruiterId, applicationId).expect(200);
    const skills = response.body.evidence.skills as { name: string; level: string; catalogue: boolean; items: Record<string, unknown>[] }[];
    expect(response.body.evidence.available).toBe(true);
    expect(skills.map((skill) => [skill.level, skill.catalogue, skill.items.length])).toEqual([['REQUIRED', true, 2], ['REQUIRED', false, 0], ['PREFERRED', true, 1]]);
    expect(skills[1]?.name).toBe('Written communication');
    // Newest first within a skill; each item carries only the four fields and when it was shared.
    expect(skills[0]?.items).toEqual([
      { type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: expect.any(String), unaided: false, sharedAt: expect.any(String) },
      { type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: expect.any(String), unaided: true, sharedAt: expect.any(String) },
    ]);
    expect(skills[2]?.items).toEqual([{ type: 'ASSESSMENT_OUTCOME', source: 'INSTITUTION_EXAM', occurredAt: expect.any(String), unaided: true, sharedAt: expect.any(String) }]);
    const audit = await audits('application.evidence_viewed', applicationId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: s.recruiterId, organization_id: s.employerId });
    assertNoReadiness(response.body, [s.good, s.aided, s.exam, s.sqlTopic, s.statsTopic, s.studentId]);
  });

  it('refuses without a token, another employer, an ended membership, an inactive employer, a malformed id and an expired or deleting grant', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good]);
    await api().get(base(s.employerId) + '/applications/' + applicationId + '/evidence').expect(401);
    const other = await employer();
    await panel(other.employerId, other.recruiterId, applicationId).expect(403);
    await panel(s.employerId, other.recruiterId, applicationId).expect(403);
    const ended = await member(s.employerId, 'RECRUITER', 'ENDED');
    await panel(s.employerId, ended, applicationId).expect(403);
    await panel(s.employerId, s.recruiterId, 'not-a-uuid').expect(403);

    await pool.query("UPDATE employer_applicant_access_grants SET expires_at = now() - interval '1 second', granted_at = now() - interval '1 day' WHERE student_user_id = $1", [s.studentId]);
    await panel(s.employerId, s.recruiterId, applicationId).expect(403);
    await pool.query('UPDATE employer_applicant_access_grants SET expires_at = NULL WHERE student_user_id = $1', [s.studentId]);
    await panel(s.employerId, s.recruiterId, applicationId).expect(200);
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() + interval '30 days', 'emp13-test')`, [randomUUID(), s.studentId]);
    await panel(s.employerId, s.recruiterId, applicationId).expect(403);

    const suspended = await setup();
    const suspendedApplication = await appliedWith(suspended, [suspended.good]);
    await pool.query("UPDATE organizations SET verification_state = 'SUSPENDED', active = false WHERE id = $1", [suspended.employerId]);
    await panel(suspended.employerId, suspended.recruiterId, suspendedApplication).expect(403);
    expect(await audits('application.evidence_viewed', suspendedApplication)).toHaveLength(0);
  });

  it('keeps readiness out of every employer response that now carries evidence (contract)', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good, s.exam]);
    const secrets = [s.good, s.exam, s.sqlTopic, s.statsTopic];
    assertNoReadiness((await panel(s.employerId, s.recruiterId, applicationId).expect(200)).body, secrets);
    const list = await applicants(s.employerId, s.recruiterId, s.opportunityId, s.sqlTopic).expect(200);
    assertNoReadiness({ applications: list.body.applications }, secrets);
    const candidate = await api().get(base(s.employerId) + '/applications/' + applicationId).set(auth(s.recruiterId)).expect(200);
    expect(JSON.stringify(candidate.body)).not.toMatch(/readiness|mastery|gapStatus|"band"|"score"|stage_at_capture|stageAtCapture/i);
    for (const secret of secrets) expect(JSON.stringify(candidate.body)).not.toContain(secret);
  });
});

describe('EMP-13: filter applicants by shared evidence for one skill (decision 10.2 #5)', () => {
  it('narrows to live applicants who share qualifying evidence for the skill, in the list\'s own order, and audits the use', async () => {
    const s = await setup();
    const sharing = await appliedWith(s, [s.good]);
    const second = await student();
    const secondGood = await evidence(second, s.sqlTopic);
    const reviewed = await preview(second, s.opportunityId).expect(201);
    const secondApplication = (await applyAs(second, s.opportunityId, { reviewedSnapshotHash: reviewed.body.preview.snapshotHash, evidenceRecordIds: [secondGood] }).expect(201)).body.application.id as string;
    const quiet = await student();
    await evidence(quiet, s.sqlTopic);
    const quietReview = await preview(quiet, s.opportunityId).expect(201);
    await applyAs(quiet, s.opportunityId, { reviewedSnapshotHash: quietReview.body.preview.snapshotHash }).expect(201);
    const statsOnly = await student();
    const statsItem = await evidence(statsOnly, s.statsTopic);
    const statsReview = await preview(statsOnly, s.opportunityId).expect(201);
    const statsApplication = (await applyAs(statsOnly, s.opportunityId, { reviewedSnapshotHash: statsReview.body.preview.snapshotHash, evidenceRecordIds: [statsItem] }).expect(201)).body.application.id as string;

    const all = await applicants(s.employerId, s.recruiterId, s.opportunityId).expect(200);
    expect(all.body.applications).toHaveLength(4);
    expect(all.body.evidenceSkills.map((skill: { topicId: string }) => skill.topicId)).toEqual([s.sqlTopic, s.statsTopic]);
    const ordered = all.body.applications.map((item: { id: string }) => item.id);

    const filtered = await applicants(s.employerId, s.recruiterId, s.opportunityId, s.sqlTopic).expect(200);
    const ids = filtered.body.applications.map((item: { id: string }) => item.id);
    expect(ids.sort()).toEqual([sharing, secondApplication].sort());
    expect(filtered.body.applications.map((item: { id: string }) => item.id)).toEqual(ordered.filter((id: string) => ids.includes(id)));
    expect((await applicants(s.employerId, s.recruiterId, s.opportunityId, s.statsTopic).expect(200)).body.applications.map((item: { id: string }) => item.id)).toEqual([statsApplication]);
    expect(await audits('application.evidence_filter_used', s.opportunityId)).toHaveLength(2);

    // Revoked evidence and a withdrawn applicant drop out of the filter at once.
    await choose(second, secondApplication, []).expect(200);
    await api().post('/api/v1/students/me/applications/' + sharing + '/withdraw').set(auth(s.studentId)).send({}).expect(201);
    expect((await applicants(s.employerId, s.recruiterId, s.opportunityId, s.sqlTopic).expect(200)).body.applications).toEqual([]);

    expect((await applicants(s.employerId, s.recruiterId, s.opportunityId, 'sql').expect(400)).body.error.code).toBe('INVALID_EVIDENCE_SKILL');
  });
});

describe('EMP-13: dark until HG-4 is approved', () => {
  it('offers, accepts and shows nothing while the flag is off, but still lets a student take evidence back', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good]);
    await setFlag(false);
    const offered = await preview(s.studentId, s.opportunityId).expect(201);
    expect(offered.body.preview.evidence).toEqual({ available: false, skills: [] });
    const other = await student();
    const item = await evidence(other, s.sqlTopic);
    expect((await applyAs(other, s.opportunityId, { evidenceRecordIds: [item] }).expect(400)).body.error.code).toBe('EVIDENCE_SHARING_UNAVAILABLE');
    expect((await pool.query('SELECT count(*)::int AS n FROM applications WHERE student_user_id = $1', [other])).rows[0].n).toBe(0);

    const before = (await audits('application.evidence_viewed', applicationId)).length;
    expect((await panel(s.employerId, s.recruiterId, applicationId).expect(200)).body.evidence).toEqual({ available: false, skills: [] });
    expect(await audits('application.evidence_viewed', applicationId)).toHaveLength(before);
    expect((await applicants(s.employerId, s.recruiterId, s.opportunityId, s.sqlTopic).expect(400)).body.error.code).toBe('EVIDENCE_SHARING_UNAVAILABLE');
    expect((await applicants(s.employerId, s.recruiterId, s.opportunityId).expect(200)).body.evidenceSkills).toBeUndefined();

    // The student still sees what is shared, can take it back, and cannot add.
    const mine = await own(s.studentId, applicationId).expect(200);
    expect(mine.body.evidence).toMatchObject({ available: false, canShare: false });
    expect(mine.body.evidence.skills[0].items.map((entry: { evidenceId: string }) => entry.evidenceId)).toEqual([s.good]);
    expect((await choose(s.studentId, applicationId, [s.good, s.exam]).expect(400)).body.error.code).toBe('EVIDENCE_SHARING_UNAVAILABLE');
    await choose(s.studentId, applicationId, []).expect(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM application_evidence_shares WHERE application_id = $1 AND revoked_at IS NULL', [applicationId])).rows[0].n).toBe(0);
  });

  it('ships the flag off and marks switching it on as needing a second person', async () => {
    const flag = await pool.query("SELECT enabled, high_risk_direction FROM feature_flags WHERE key = 'employer.skill-evidence'");
    expect(flag.rows[0].high_risk_direction).toBe('ENABLE');
    // A fresh schema carries it off; this suite turned it on only for its own tests.
    const fresh = await readFile(new URL('../../../../packages/persistence/drizzle/0093_application_evidence_shares.sql', import.meta.url), 'utf8');
    expect(fresh).toMatch(/'employer\.skill-evidence',[\s\S]*?false, 'ENABLE'\)\s*ON CONFLICT \(key\) DO NOTHING/);
  });
});

describe('EMP-13: the database guards the consent record', () => {
  it('refuses another person\'s evidence, rewriting, a second revocation and deletion', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good]);
    const insert = (studentId: string, evidenceId: string) => pool.query(
      "INSERT INTO application_evidence_shares (id, application_id, student_user_id, evidence_record_id, shared_via) VALUES ($1,$2,$3,$4,'APPLICATION')",
      [randomUUID(), applicationId, studentId, evidenceId]);
    await expect(insert(s.studentId, s.notShareable.someoneElses)).rejects.toThrow(/only their own evidence/);
    const someoneElse = (await pool.query('SELECT subject_user_id FROM evidence_records WHERE id = $1', [s.notShareable.someoneElses])).rows[0].subject_user_id as string;
    await expect(insert(someoneElse, s.notShareable.someoneElses)).rejects.toThrow(/only their own evidence/);
    await expect(insert(s.studentId, s.good)).rejects.toThrow(/duplicate key/);
    await expect(pool.query("UPDATE application_evidence_shares SET shared_at = now() - interval '1 day' WHERE application_id = $1", [applicationId])).rejects.toThrow(/never rewritten/);
    await expect(pool.query('DELETE FROM application_evidence_shares WHERE application_id = $1', [applicationId])).rejects.toThrow(/never deleted/);
    await pool.query("UPDATE application_evidence_shares SET revoked_at = now(), revoked_reason = 'STUDENT_REVOKED' WHERE application_id = $1", [applicationId]);
    await expect(pool.query("UPDATE application_evidence_shares SET revoked_at = now(), revoked_reason = 'ACCOUNT_DELETION' WHERE application_id = $1", [applicationId])).rejects.toThrow(/never rewritten/);
    await expect(pool.query("UPDATE application_evidence_shares SET revoked_reason = 'SOMETHING' WHERE application_id = $1", [applicationId])).rejects.toThrow();
  });
});

describe('EMP-13: privacy', () => {
  it('lists shares in the student\'s export and revokes every one when the account is deleted', async () => {
    const s = await setup();
    const applicationId = await appliedWith(s, [s.good, s.exam]);
    const exported = await assembleSubjectExport(db, s.studentId) as { evidenceShares: Record<string, unknown>[] };
    expect(exported.evidenceShares).toHaveLength(2);
    expect(exported.evidenceShares[0]).toMatchObject({ employerName: 'Evidence employer', title: 'Graduate analyst', type: 'ASSESSMENT_OUTCOME', sharedVia: 'APPLY', revokedAt: null });
    expect(JSON.stringify(exported.evidenceShares)).not.toContain(s.good);

    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, requested_at, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() - interval '31 days', now() - interval '1 day', 'emp13-test')`, [randomUUID(), s.studentId]);
    const summaries = await executeDueDeletions({ db, ids: { uuid: randomUUID }, storage });
    expect(summaries.find((summary) => summary.subjectUserId === s.studentId)?.outcome).toBe('COMPLETED');
    const left = await pool.query('SELECT revoked_reason FROM application_evidence_shares WHERE application_id = $1', [applicationId]);
    expect(left.rows.map((row) => row.revoked_reason)).toEqual(['ACCOUNT_DELETION', 'ACCOUNT_DELETION']);
    await panel(s.employerId, s.recruiterId, applicationId).expect(403);
  });
});
