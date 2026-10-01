/**
 * The consented talent pool (EMP-14, ADR-044).
 *
 * Pins the acceptance criteria and the rules around them: students without BOTH the employer-discovery
 * consent and profile visibility EMPLOYER_DISCOVERY never appear; no identity reaches an employer before
 * the student applies; the opt-in is explicit and leaving takes effect on the next request; only verified
 * evidence (EMP-13's rule) the student ticked is shown; search filters never rank and refuse anything that
 * is not a filter; cards carry no name, contact, college, identifier, readiness, score, stage or count;
 * blocks, the daily invitation limit and the employer's organisation state hold; every search, card view
 * and invitation is audited; the export carries it and deletion erases it; the database refuses to show
 * another person's evidence; and while the flag is off (HG-4 pending) nothing is offered, read or shown.
 *
 * Runs over real HTTP with a stub verifier, like the EMP-13 spec, in a throwaway schema of the local
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
if (!connectionString) throw new Error('DATABASE_URL is required for talent pool tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Talent pool tests require local Postgres');
const schemaName = 'talent_pool_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'b'.repeat(64);
const CONSENT_VERSION = '2026-10-draft';
let storageRoot: string;
let storage: FileStorage;
let app: INestApplication;

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  storageRoot = await mkdtemp(join(tmpdir(), 'one-emp14-'));
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

const setFlag = (enabled: boolean) => pool.query("UPDATE feature_flags SET enabled = $1 WHERE key = 'employer.talent-pool'", [enabled]);
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
async function employer(name = 'Pool employer') {
  const employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER',$2,'VERIFIED',true)", [employerId, name]);
  return { employerId, recruiterId: await member(employerId) };
}
const STUDENT_NAME = 'Synthetic Pool Candidate';
const COLLEGE = 'Synthetic Pool Institute';
/** A student on a college roster in the CSE department, graduating next year (relative to now). */
async function student(branch = 'Computer Science'): Promise<{ id: string; email: string; year: number }> {
  const email = 'pool-' + randomUUID().slice(0, 8) + '@uat.example.test';
  const id = await user(email);
  const institutionId = randomUUID();
  const unitId = randomUUID();
  const year = new Date().getUTCFullYear() + 1;
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION',$2,'VERIFIED',true)", [institutionId, COLLEGE]);
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name) VALUES ($1,$2,'DEPARTMENT',$3)", [unitId, institutionId, branch]);
  await pool.query("INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE', now() - interval '1 day')", [randomUUID(), institutionId, id]);
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,expected_graduation_date)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6, make_date($7, 6, 30))`, [randomUUID(), institutionId, id, 'ROLL-' + id.slice(0, 8), STUDENT_NAME, unitId, year]);
  await pool.query("INSERT INTO student_profiles (user_id, profile_headline, target_career) VALUES ($1,'Aspiring analyst','Data Analyst')", [id]);
  return { id, email, year };
}
async function catalogueSkill(name: string): Promise<string> {
  const author = await user();
  const topicId = randomUUID();
  const revision = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id,entity_type,entity_id,revision,author_user_id,state,content_hash,body) VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id,kind,stable_key,version,name,description,content_revision_id) VALUES ($1,'TOPIC',$2,1,$3,'Synthetic topic for EMP-14 tests',$4)`,
    [topicId, 'emp14-' + topicId.slice(0, 8), name, revision]);
  const roleId = randomUUID();
  await pool.query("INSERT INTO career_roles (id,code,title,family) VALUES ($1,$2,'Synthetic pool role','Data')", [roleId, 'EMP14_' + roleId.slice(0, 8).toUpperCase()]);
  await pool.query("INSERT INTO career_role_requirements (id,career_role_id,topic_id,requirement_level,target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.7)", [randomUUID(), roleId, topicId]);
  return topicId;
}
interface EvidenceOptions { type?: string; stage?: string; demonstrated?: number; assisted?: boolean; source?: string; daysAgo?: number }
async function evidence(subject: string, topicId: string, options: EvidenceOptions = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO evidence_records (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type, source_aggregate_id,
      content_version, provenance, occurred_at, assisted, stage_at_capture)
    VALUES ($1,$2,$3,$4,$5,10,$6,$7,'assessment-v1','{}'::jsonb, now() - make_interval(days => $8), $9, $10)`,
  [id, subject, options.type ?? 'ASSESSMENT_OUTCOME', topicId, options.demonstrated ?? 7, options.source ?? 'assessment_attempt', randomUUID(),
    options.daysAgo ?? 1, options.assisted ?? false, options.stage ?? 'DEMONSTRATED']);
  return id;
}

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const base = (employerId: string) => '/api/v1/employers/' + employerId;
const terms = {
  title: 'Graduate analyst (invite only)', summary: 'Analyse data.', employmentType: 'FULL_TIME', workMode: 'ONSITE', locationCity: 'Chennai',
  compensationDisclosed: false,
};
async function job(employerId: string, recruiterId: string, audienceKind = 'INVITE_ONLY'): Promise<string> {
  const created = await api().post(base(employerId) + '/opportunities').set(auth(recruiterId)).send({ referenceCode: 'TP-' + randomUUID().slice(0, 8), ...terms }).expect(201);
  const id = created.body.opportunity.id as string;
  await api().post(base(employerId) + '/opportunities/' + id + '/audiences').set(auth(recruiterId)).send({ audienceKind }).expect(201);
  await api().post(base(employerId) + '/opportunities/' + id + '/publish').set(auth(recruiterId)).expect(201);
  return id;
}

const ownPool = (studentId: string) => api().get('/api/v1/students/me/talent-pool').set(auth(studentId));
const join_ = (studentId: string, body: Record<string, unknown>) => api().put('/api/v1/students/me/talent-pool').set(auth(studentId)).send(body);
const leave = (studentId: string) => api().delete('/api/v1/students/me/talent-pool').set(auth(studentId));
const search = (employerId: string, actor: string, query: Record<string, unknown>) => api().get(base(employerId) + '/talent-pool/search').query(query).set(auth(actor));
const openCard = (employerId: string, actor: string, ref: string) => api().get(base(employerId) + '/talent-pool/cards/' + ref).set(auth(actor));
const invite = (employerId: string, actor: string, cardRef: string, opportunityId: string) =>
  api().post(base(employerId) + '/talent-pool/invitations').set(auth(actor)).send({ cardRef, opportunityId });
const overview = (employerId: string, actor: string) => api().get(base(employerId) + '/talent-pool').set(auth(actor));
const audits = async (action: string, organizationId?: string) =>
  (await pool.query('SELECT actor_user_id, resource_type, resource_id, organization_id, context FROM audit_events WHERE action = $1 AND ($2::uuid IS NULL OR organization_id = $2::uuid)', [action, organizationId ?? null])).rows;

/** EMP-13's contract, plus the identity of the person: no readiness, marks, stage, count, rank, identifier, name, contact or college. */
const forbiddenKey = /^(readiness.*|band|.*Band|score|.*Score|mastery.*|gapStatus|gap_status|percent.*|percentage|rank.*|total.*|count|evidenceCount|demonstrated|possible|stage|stageAtCapture|stage_at_capture|evidenceId|evidence_id|topicId|taxonomyTopicId|fit.*|name|fullName|full_name|email|phone|.*Email|institution.*|college.*|studentUserId|userId|listingId|student_user_id|id)$/i;
const forbiddenValue = new Set(['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'READY_FOR_NEXT_STEP', 'DEMONSTRATED', 'TRANSFERRED', 'RETAINED', 'ESTIMATED', 'PARTIAL', 'MISSING']);
function assertNothingIdentifying(body: unknown, secrets: readonly string[]): void {
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        // A skill's own name is the one `name` a card carries (the catalogue skill, never a person).
        if (!(key === 'name' && /\.skills\[\d+\]$/.test(path))) expect(key, `${path}.${key}`).not.toMatch(forbiddenKey);
        walk(inner, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === 'string') expect(forbiddenValue.has(value), `${path} = ${value}`).toBe(false);
  };
  walk(body, '$');
  const text = JSON.stringify(body);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/Synthetic Pool Candidate|Synthetic Pool Institute|ROLL-|uat\.example\.test|Data Analyst|7\/10|70%/);
}

interface Pooled { student: { id: string; email: string; year: number }; sqlTopic: string; statsTopic: string; good: string; aided: string; exam: string; lesson: string }
/** A student with three showable items (two SQL, one statistics) and one that can never be shown, already in the pool. */
async function pooledStudent(options: { branch?: string; showBranch?: boolean; showGraduationYear?: boolean; cities?: string[]; sqlTopic?: string; statsTopic?: string } = {}): Promise<Pooled> {
  const s = await student(options.branch);
  const sqlTopic = options.sqlTopic ?? await catalogueSkill('Synthetic SQL ' + randomUUID().slice(0, 4));
  const statsTopic = options.statsTopic ?? await catalogueSkill('Synthetic statistics ' + randomUUID().slice(0, 4));
  const good = await evidence(s.id, sqlTopic, { daysAgo: 2 });
  const aided = await evidence(s.id, sqlTopic, { assisted: true, daysAgo: 1 });
  const exam = await evidence(s.id, statsTopic, { source: 'exam_attempt', daysAgo: 3 });
  const lesson = await evidence(s.id, sqlTopic, { type: 'LESSON_COMPLETION', demonstrated: 1 });
  await join_(s.id, {
    consentVersion: CONSENT_VERSION, showBranch: options.showBranch ?? true, showGraduationYear: options.showGraduationYear ?? true,
    preferredCities: options.cities ?? ['Chennai', 'Hyderabad'], evidenceRecordIds: [good, aided, exam],
  }).expect(200);
  return { student: s, sqlTopic, statsTopic, good, aided, exam, lesson };
}
async function cardsFor(employerId: string, actor: string, query: Record<string, unknown>): Promise<{ cardRef: string; skills: string[]; branch: string | null; graduationYear: number | null; preferredCities: string[] }[]> {
  const response = await search(employerId, actor, query).expect(200);
  return response.body.talentPool.cards;
}

describe('EMP-14: the student opts in explicitly and chooses what a card shows', () => {
  it('requires the current consent version to join, and records the consent, the visibility and an audit row', async () => {
    const s = await student();
    const offered = await ownPool(s.id).expect(200);
    expect(offered.body.talentPool).toMatchObject({ available: true, optedIn: false, discoverable: false, consent: { version: CONSENT_VERSION, granted: false } });
    expect((await join_(s.id, { showBranch: true }).expect(400)).body.error.code).toBe('CONSENT_REQUIRED');
    expect((await join_(s.id, { consentVersion: 'v0' }).expect(400)).body.error.code).toBe('CONSENT_VERSION_MISMATCH');
    expect((await join_(s.id, { consentVersion: CONSENT_VERSION, gender: 'F' }).expect(400)).body.error.code).toBe('UNKNOWN_FIELD');
    expect((await join_(s.id, { consentVersion: CONSENT_VERSION, preferredCities: ['<script>'] }).expect(400)).body.error.code).toBe('INVALID_PREFERRED_CITIES');

    const joined = await join_(s.id, { consentVersion: CONSENT_VERSION, preferredCities: ['Pune'] }).expect(200);
    expect(joined.body.talentPool).toMatchObject({ optedIn: true, discoverable: true, visibility: 'EMPLOYER_DISCOVERY', listing: { showBranch: false, showGraduationYear: false, preferredCities: ['Pune'] } });
    const consent = await pool.query("SELECT action, version FROM user_consents WHERE user_id = $1 AND consent_key = 'employer-discovery'", [s.id]);
    expect(consent.rows).toEqual([{ action: 'GRANTED', version: CONSENT_VERSION }]);
    expect((await pool.query('SELECT visibility_state, employer_discovery_enabled FROM student_profiles WHERE user_id = $1', [s.id])).rows[0])
      .toEqual({ visibility_state: 'EMPLOYER_DISCOVERY', employer_discovery_enabled: true });
    expect((await audits('talent_pool.opted_in')).some((row) => row.actor_user_id === s.id)).toBe(true);
  });

  it('offers only verified evidence on catalogue skills, and refuses anything else', async () => {
    const p = await pooledStudent();
    const someoneElse = await student();
    const notOwn = await evidence(someoneElse.id, p.sqlTopic);
    const retained = await evidence(p.student.id, p.sqlTopic, { stage: 'RETAINED' });
    const nothingRight = await evidence(p.student.id, p.sqlTopic, { demonstrated: 0 });
    const view = (await ownPool(p.student.id).expect(200)).body.talentPool;
    const ids = view.skills.flatMap((skill: { items: { evidenceId: string; shown: boolean }[] }) => skill.items.map((item) => item.evidenceId));
    expect(ids).toEqual(expect.arrayContaining([p.good, p.aided, p.exam]));
    for (const id of [p.lesson, notOwn, retained, nothingRight]) expect(ids).not.toContain(id);
    expect(view.skills.flatMap((skill: { items: { shown: boolean }[] }) => skill.items.filter((item) => item.shown)).length).toBe(3);
    for (const id of [p.lesson, notOwn, retained, nothingRight]) {
      expect((await join_(p.student.id, { evidenceRecordIds: [p.good, id] }).expect(400)).body.error.code).toBe('EVIDENCE_NOT_SHOWABLE');
    }
    // The roster values ticking would show are the student's own.
    expect(view.roster).toEqual({ branch: 'Computer Science', graduationYear: p.student.year });
  });

  it('refuses, in the database, a listing row showing someone else\'s evidence, and any rewrite or delete', async () => {
    const p = await pooledStudent();
    const other = await student();
    const otherEvidence = await evidence(other.id, p.sqlTopic);
    const listing = (await pool.query('SELECT id FROM talent_pool_listings WHERE student_user_id = $1 AND ended_at IS NULL', [p.student.id])).rows[0].id;
    await expect(pool.query('INSERT INTO talent_pool_listing_evidence (id, listing_id, student_user_id, evidence_record_id) VALUES ($1,$2,$3,$4)',
      [randomUUID(), listing, p.student.id, otherEvidence])).rejects.toThrow(/only their own evidence/);
    await expect(pool.query("UPDATE talent_pool_listings SET consent_version = 'other' WHERE id = $1", [listing])).rejects.toThrow(/keeps its student/);
    await expect(pool.query('DELETE FROM talent_pool_listings WHERE id = $1', [listing])).rejects.toThrow(/only by privacy deletion/);
    await expect(pool.query('DELETE FROM talent_pool_listing_evidence WHERE listing_id = $1', [listing])).rejects.toThrow(/only by privacy deletion/);
  });
});

describe('EMP-14 acceptance: students without both consent and visibility never appear', () => {
  it('finds an opted-in student, and loses them on the next request when visibility or consent goes', async () => {
    const { employerId, recruiterId } = await employer();
    const p = await pooledStudent({ branch: 'Synthetic Mechatronics ' + randomUUID().slice(0, 6) });
    const query = { skill: p.sqlTopic };
    expect((await cardsFor(employerId, recruiterId, query)).length).toBe(1);

    // Visibility changed on the profile: gone, though the consent stands.
    await api().patch('/api/v1/students/me/profile').set(auth(p.student.id)).send({ targetCareer: 'Analyst', careerInterests: [], visibilityState: 'PRIVATE', employerDiscoveryEnabled: false }).expect(200);
    expect(await cardsFor(employerId, recruiterId, query)).toEqual([]);
    // Joining again restores both; then withdrawing the consent alone removes them.
    await join_(p.student.id, { consentVersion: CONSENT_VERSION }).expect(200);
    expect((await cardsFor(employerId, recruiterId, query)).length).toBe(1);
    await api().post('/api/v1/me/consents/employer-discovery/withdraw').set(auth(p.student.id)).send({}).expect(201);
    expect(await cardsFor(employerId, recruiterId, query)).toEqual([]);
    expect((await ownPool(p.student.id).expect(200)).body.talentPool).toMatchObject({ optedIn: true, discoverable: false });
  });

  it('never shows a student who only set visibility, or who has a listing row without the consent', async () => {
    const { employerId, recruiterId } = await employer();
    const topic = await catalogueSkill('Synthetic Rust ' + randomUUID().slice(0, 4));
    const visibilityOnly = await student();
    await evidence(visibilityOnly.id, topic);
    await pool.query("UPDATE student_profiles SET visibility_state = 'EMPLOYER_DISCOVERY', employer_discovery_enabled = true WHERE user_id = $1", [visibilityOnly.id]);
    const listingOnly = await student();
    const itsEvidence = await evidence(listingOnly.id, topic);
    const listing = randomUUID();
    await pool.query("INSERT INTO talent_pool_listings (id, student_user_id, consent_version) VALUES ($1,$2,$3)", [listing, listingOnly.id, CONSENT_VERSION]);
    await pool.query('INSERT INTO talent_pool_listing_evidence (id, listing_id, student_user_id, evidence_record_id) VALUES ($1,$2,$3,$4)', [randomUUID(), listing, listingOnly.id, itsEvidence]);
    await pool.query("UPDATE student_profiles SET visibility_state = 'EMPLOYER_DISCOVERY' WHERE user_id = $1", [listingOnly.id]);
    expect(await cardsFor(employerId, recruiterId, { skill: topic })).toEqual([]);
  });

  it('withholds a student whose account is being deleted, and one whose consent is for a superseded version', async () => {
    const { employerId, recruiterId } = await employer();
    const p = await pooledStudent();
    expect((await cardsFor(employerId, recruiterId, { skill: p.sqlTopic })).length).toBe(1);
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() + interval '30 days', 'emp14-test')`, [randomUUID(), p.student.id]);
    expect(await cardsFor(employerId, recruiterId, { skill: p.sqlTopic })).toEqual([]);

    // A new version of the notice: everyone who agreed to the old one drops out until they agree again.
    const q = await pooledStudent();
    expect((await cardsFor(employerId, recruiterId, { skill: q.sqlTopic })).length).toBe(1);
    await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'employer-discovery' AND version = $1", [CONSENT_VERSION]);
    await pool.query("INSERT INTO consent_definitions (consent_key, version, title, enforcement) VALUES ('employer-discovery', 'emp14-next', 'Next notice', 'OPTIONAL')");
    try {
      expect(await cardsFor(employerId, recruiterId, { skill: q.sqlTopic })).toEqual([]);
      expect((await ownPool(q.student.id).expect(200)).body.talentPool).toMatchObject({ optedIn: true, discoverable: false, consent: { version: 'emp14-next', granted: false } });
      await join_(q.student.id, { consentVersion: 'emp14-next' }).expect(200);
      expect((await cardsFor(employerId, recruiterId, { skill: q.sqlTopic })).length).toBe(1);
    } finally {
      await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'employer-discovery' AND version = 'emp14-next'");
      await pool.query("UPDATE consent_definitions SET retired_at = NULL WHERE consent_key = 'employer-discovery' AND version = $1", [CONSENT_VERSION]);
    }
  });

  it('leaving takes effect on the next request: no card, no card view, no invitation; the consent is withdrawn and visibility narrowed', async () => {
    const { employerId, recruiterId } = await employer();
    const jobId = await job(employerId, recruiterId);
    const p = await pooledStudent();
    const [card] = await cardsFor(employerId, recruiterId, { skill: p.sqlTopic });
    await leave(p.student.id).expect(200);
    expect(await cardsFor(employerId, recruiterId, { skill: p.sqlTopic })).toEqual([]);
    expect((await openCard(employerId, recruiterId, card!.cardRef).expect(404)).body.error.code).toBe('CARD_NOT_AVAILABLE');
    expect((await invite(employerId, recruiterId, card!.cardRef, jobId).expect(404)).body.error.code).toBe('CARD_NOT_AVAILABLE');
    const consent = await pool.query("SELECT action FROM user_consents WHERE user_id = $1 AND consent_key = 'employer-discovery' ORDER BY recorded_at", [p.student.id]);
    expect(consent.rows.map((row) => row.action)).toEqual(['GRANTED', 'WITHDRAWN']);
    expect((await pool.query('SELECT visibility_state FROM student_profiles WHERE user_id = $1', [p.student.id])).rows[0].visibility_state).toBe('INSTITUTION_VISIBLE');
    expect((await pool.query("SELECT count(*)::int AS n FROM talent_pool_listing_evidence WHERE student_user_id = $1 AND removed_reason = 'LISTING_ENDED'", [p.student.id])).rows[0].n).toBe(3);
    // Rejoining is a new card: the old reference does not come back.
    await join_(p.student.id, { consentVersion: CONSENT_VERSION, evidenceRecordIds: [p.good] }).expect(200);
    const [again] = await cardsFor(employerId, recruiterId, { skill: p.sqlTopic });
    expect(again!.cardRef).not.toBe(card!.cardRef);
  });
});

describe('EMP-14: searching filters and never ranks', () => {
  it('matches every chosen skill, branch, year and city — only on what the student chose to show', async () => {
    const { employerId, recruiterId } = await employer();
    const branch = 'Synthetic Aeronautics ' + randomUUID().slice(0, 6);
    const sqlTopic = await catalogueSkill('Synthetic SQL ' + randomUUID().slice(0, 4));
    const statsTopic = await catalogueSkill('Synthetic statistics ' + randomUUID().slice(0, 4));
    const both = await pooledStudent({ branch, sqlTopic, statsTopic, cities: ['Kochi'] });
    const hidden = await pooledStudent({ branch, sqlTopic, statsTopic, showBranch: false, showGraduationYear: false, cities: ['Kochi'] });
    const sqlOnly = await student(branch);
    await join_(sqlOnly.id, { consentVersion: CONSENT_VERSION, showBranch: true, evidenceRecordIds: [await evidence(sqlOnly.id, sqlTopic)] }).expect(200);

    expect((await cardsFor(employerId, recruiterId, { skill: sqlTopic })).length).toBe(3);
    expect((await cardsFor(employerId, recruiterId, { skill: [sqlTopic, statsTopic] })).length).toBe(2);
    const byBranch = await cardsFor(employerId, recruiterId, { branch: branch.toUpperCase() });
    expect(byBranch.length).toBe(2);
    expect(byBranch.every((card) => card.branch === branch)).toBe(true);
    expect((await cardsFor(employerId, recruiterId, { branch, graduationYear: String(both.student.year) })).length).toBe(1);
    expect((await cardsFor(employerId, recruiterId, { skill: sqlTopic, city: 'kochi' })).length).toBe(2);
    const hiddenCard = (await cardsFor(employerId, recruiterId, { skill: statsTopic, city: 'Kochi' })).find((card) => card.branch === null);
    expect(hiddenCard).toMatchObject({ branch: null, graduationYear: null, preferredCities: ['Kochi'] });
    expect(hidden.student.id).toBeTruthy();
  });

  it('keeps one neutral order per employer, unrelated to evidence or recency, and pages without a total', async () => {
    const { employerId, recruiterId } = await employer();
    const sqlTopic = await catalogueSkill('Synthetic SQL ' + randomUUID().slice(0, 4));
    for (let i = 0; i < 3; i += 1) await pooledStudent({ sqlTopic });
    const first = (await search(employerId, recruiterId, { skill: sqlTopic }).expect(200)).body.talentPool;
    const second = (await search(employerId, recruiterId, { skill: sqlTopic }).expect(200)).body.talentPool;
    expect(first.cards.map((card: { cardRef: string }) => card.cardRef)).toEqual(second.cards.map((card: { cardRef: string }) => card.cardRef));
    expect(first.hasMore).toBe(false);
    expect(Object.keys(first).sort()).toEqual(['available', 'cards', 'hasMore']);
  });

  it('refuses anything that is not a filter — so no protected attribute — and a search with no filter', async () => {
    const { employerId, recruiterId } = await employer();
    for (const query of [{ gender: 'F' }, { religion: 'x', branch: 'CSE' }, { college: 'Synthetic' }, { age: '21' }, { sort: 'evidence', branch: 'CSE' }]) {
      expect((await search(employerId, recruiterId, query).expect(400)).body.error.code).toBe('UNKNOWN_FILTER');
    }
    for (const query of [{ skill: 'not-a-uuid' }, { graduationYear: '20x5' }, { branch: 'x'.repeat(61) }, { page: '8', branch: 'CSE' },
      { skill: Array.from({ length: 6 }, () => randomUUID()) }]) {
      expect((await search(employerId, recruiterId, query).expect(400)).body.error.code).toBe('INVALID_FILTER');
    }
    expect((await search(employerId, recruiterId, {}).expect(400)).body.error.code).toBe('FILTER_REQUIRED');
  });
});

describe('EMP-14 acceptance: no identity is revealed before the student applies', () => {
  it('shows a minimal card with no name, contact, college, identifier, readiness, stage or count; addresses it per employer; audits search and view', async () => {
    const a = await employer();
    const b = await employer('Second pool employer');
    const p = await pooledStudent();
    const searched = await search(a.employerId, a.recruiterId, { skill: p.sqlTopic }).expect(200);
    const [card] = searched.body.talentPool.cards;
    expect(card).toEqual({ cardRef: expect.stringMatching(/^[0-9a-f]{32}$/), skills: expect.any(Array), branch: 'Computer Science', graduationYear: p.student.year, preferredCities: ['Chennai', 'Hyderabad'] });
    const secrets = [p.student.id, p.student.email, p.good, p.aided, p.exam, p.sqlTopic, p.statsTopic];
    assertNothingIdentifying(searched.body.talentPool, secrets);

    const opened = await openCard(a.employerId, a.recruiterId, card.cardRef).expect(200);
    const detail = opened.body.talentPool.card;
    expect(detail.skills.map((skill: { items: unknown[] }) => skill.items.length).sort()).toEqual([1, 2]);
    const sqlSkill = detail.skills.find((skill: { items: unknown[] }) => skill.items.length === 2);
    expect(sqlSkill.items).toEqual([
      { type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: expect.any(String), unaided: false },
      { type: 'ASSESSMENT_OUTCOME', source: 'ONE_SKILL_CHECK', occurredAt: expect.any(String), unaided: true },
    ]);
    assertNothingIdentifying(opened.body.talentPool, secrets);

    // Another employer sees the same person under a different reference.
    const [otherCard] = await cardsFor(b.employerId, b.recruiterId, { skill: p.sqlTopic });
    expect(otherCard!.cardRef).not.toBe(card.cardRef);
    expect((await openCard(b.employerId, b.recruiterId, card.cardRef).expect(404)).body.error.code).toBe('CARD_NOT_AVAILABLE');

    const searches = await audits('talent_pool.searched', a.employerId);
    expect(searches.at(-1)).toMatchObject({ actor_user_id: a.recruiterId, resource_type: 'organization', context: expect.objectContaining({ cardsReturned: 1, skills: 1 }) });
    const listing = (await pool.query('SELECT id FROM talent_pool_listings WHERE student_user_id = $1 AND ended_at IS NULL', [p.student.id])).rows[0].id;
    expect(await audits('talent_pool.card_viewed', a.employerId)).toEqual([expect.objectContaining({ actor_user_id: a.recruiterId, resource_type: 'talent_pool_listing', resource_id: listing })]);
  });

  it('invites through the card to an invite-only job; the employer learns who it was only when the student applies', async () => {
    const { employerId, recruiterId } = await employer();
    const jobId = await job(employerId, recruiterId);
    const publicJob = await job(employerId, recruiterId, 'PUBLIC');
    const p = await pooledStudent();
    const [card] = await cardsFor(employerId, recruiterId, { skill: p.sqlTopic });

    expect((await invite(employerId, recruiterId, card!.cardRef, publicJob).expect(400)).body.error.code).toBe('JOB_NOT_INVITABLE');
    // Before the invitation the invite-only job is invisible to the student.
    await api().get('/api/v1/opportunities/' + jobId).set(auth(p.student.id)).expect(403);
    const sent = await invite(employerId, recruiterId, card!.cardRef, jobId).expect(201);
    assertNothingIdentifying(sent.body, [p.student.id, p.student.email]);
    expect(sent.body.invitation.status).toBe('PENDING');
    expect((await invite(employerId, recruiterId, card!.cardRef, jobId).expect(400)).body.error.code).toBe('ALREADY_INVITED');
    expect((await audits('talent_pool.invitation_sent', employerId)).length).toBe(1);

    // The student is told in the app, sees the invitation and the job, and nothing has reached the employer.
    const notices = await pool.query("SELECT kind, title, body, data FROM user_notifications WHERE user_id = $1", [p.student.id]);
    expect(notices.rows).toEqual([expect.objectContaining({ kind: 'SYSTEM', title: 'An employer invited you to apply', data: { screen: 'talent-pool' } })]);
    const mine = (await ownPool(p.student.id).expect(200)).body.talentPool;
    expect(mine.invitations).toEqual([expect.objectContaining({ employerName: 'Pool employer', title: terms.title, state: 'SENT', opportunityId: jobId })]);
    const listed = await api().get('/api/v1/opportunities').set(auth(p.student.id)).expect(200);
    expect(listed.body.opportunities.find((item: { id: string }) => item.id === jobId)).toMatchObject({ invitedFromTalentPool: true });
    const before = await api().get(base(employerId) + '/opportunities/' + jobId + '/applications').set(auth(recruiterId)).expect(200);
    expect(before.body.applications).toEqual([]);
    const pending = (await overview(employerId, recruiterId).expect(200)).body.talentPool;
    expect(pending.invitations).toEqual([expect.objectContaining({ title: terms.title, status: 'PENDING' })]);
    assertNothingIdentifying(pending, [p.student.id, p.student.email]);

    // Applying is the normal consented apply; it answers the invitation in the same transaction.
    const applied = await api().post('/api/v1/students/me/applications').set(auth(p.student.id)).send({ consentGranted: true, opportunityId: jobId }).expect(201);
    const invitation = await pool.query('SELECT state, application_id FROM talent_pool_invitations WHERE student_user_id = $1', [p.student.id]);
    expect(invitation.rows).toEqual([{ state: 'APPLIED', application_id: applied.body.application.id }]);
    const after = await api().get(base(employerId) + '/opportunities/' + jobId + '/applications').set(auth(recruiterId)).expect(200);
    expect(after.body.applications).toHaveLength(1);
    expect((await overview(employerId, recruiterId).expect(200)).body.talentPool.invitations[0].status).toBe('APPLIED');
    // The applied job stays openable for the student.
    await api().get('/api/v1/opportunities/' + jobId).set(auth(p.student.id)).expect(200);
  });

  it('a decline looks like no answer to the employer, and an expired invitation no longer opens the job', async () => {
    const { employerId, recruiterId } = await employer();
    const jobId = await job(employerId, recruiterId);
    const p = await pooledStudent();
    const [card] = await cardsFor(employerId, recruiterId, { skill: p.sqlTopic });
    await invite(employerId, recruiterId, card!.cardRef, jobId).expect(201);
    const invitationId = (await ownPool(p.student.id).expect(200)).body.talentPool.invitations[0].id;
    await api().post('/api/v1/students/me/talent-pool/invitations/' + invitationId + '/decline').set(auth(p.student.id)).expect(200);
    expect((await overview(employerId, recruiterId).expect(200)).body.talentPool.invitations[0].status).toBe('PENDING');
    await api().get('/api/v1/opportunities/' + jobId).set(auth(p.student.id)).expect(403);
    expect((await api().post('/api/v1/students/me/talent-pool/invitations/' + invitationId + '/decline').set(auth(p.student.id)).expect(400)).body.error.code).toBe('INVITATION_NOT_OPEN');
    // Expired: the job closes to the student and the employer sees CLOSED.
    const another = await job(employerId, recruiterId);
    await invite(employerId, recruiterId, card!.cardRef, another).expect(201);
    await api().get('/api/v1/opportunities/' + another).set(auth(p.student.id)).expect(200);
    // An invitation sent three weeks ago that expired last week (written directly: rows are never rewritten).
    const expiredJob = await job(employerId, recruiterId);
    const listing = (await pool.query('SELECT id FROM talent_pool_listings WHERE student_user_id = $1 AND ended_at IS NULL', [p.student.id])).rows[0].id;
    await pool.query(`INSERT INTO talent_pool_invitations (id, employer_id, opportunity_id, listing_id, student_user_id, invited_by_user_id, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6, now() - interval '20 days', now() - interval '6 days')`, [randomUUID(), employerId, expiredJob, listing, p.student.id, recruiterId]);
    await api().get('/api/v1/opportunities/' + expiredJob).set(auth(p.student.id)).expect(403);
    const statuses = (await overview(employerId, recruiterId).expect(200)).body.talentPool.invitations.map((row: { status: string }) => row.status).sort();
    expect(statuses).toEqual(['CLOSED', 'PENDING', 'PENDING']);
  });
});

describe('EMP-14: blocks and limits', () => {
  it('a blocked employer neither finds nor invites the student, its open invitations are cancelled, and another employer still finds them', async () => {
    const blocked = await employer('Blocked employer');
    const other = await employer('Other employer');
    const jobId = await job(blocked.employerId, blocked.recruiterId);
    const p = await pooledStudent();
    const [card] = await cardsFor(blocked.employerId, blocked.recruiterId, { skill: p.sqlTopic });
    await invite(blocked.employerId, blocked.recruiterId, card!.cardRef, jobId).expect(201);

    const found = await api().get('/api/v1/students/me/talent-pool/employers').query({ q: 'Blocked emp' }).set(auth(p.student.id)).expect(200);
    expect(found.body.employers).toEqual([{ employerId: blocked.employerId, name: 'Blocked employer' }]);
    await api().post('/api/v1/students/me/talent-pool/blocks').set(auth(p.student.id)).send({ employerId: blocked.employerId }).expect(201);
    expect(await cardsFor(blocked.employerId, blocked.recruiterId, { skill: p.sqlTopic })).toEqual([]);
    expect((await openCard(blocked.employerId, blocked.recruiterId, card!.cardRef).expect(404)).body.error.code).toBe('CARD_NOT_AVAILABLE');
    const second = await job(blocked.employerId, blocked.recruiterId);
    expect((await invite(blocked.employerId, blocked.recruiterId, card!.cardRef, second).expect(404)).body.error.code).toBe('CARD_NOT_AVAILABLE');
    expect((await pool.query("SELECT state, cancel_reason FROM talent_pool_invitations WHERE student_user_id = $1", [p.student.id])).rows)
      .toEqual([{ state: 'CANCELLED', cancel_reason: 'STUDENT_BLOCKED' }]);
    // A cancellation looks like no answer, too.
    expect((await overview(blocked.employerId, blocked.recruiterId).expect(200)).body.talentPool.invitations[0].status).toBe('PENDING');
    expect((await cardsFor(other.employerId, other.recruiterId, { skill: p.sqlTopic })).length).toBe(1);
    expect((await ownPool(p.student.id).expect(200)).body.talentPool.blocks).toEqual([expect.objectContaining({ employerId: blocked.employerId, employerName: 'Blocked employer' })]);

    await api().delete('/api/v1/students/me/talent-pool/blocks/' + blocked.employerId).set(auth(p.student.id)).expect(200);
    expect((await cardsFor(blocked.employerId, blocked.recruiterId, { skill: p.sqlTopic })).length).toBe(1);
    expect((await audits('talent_pool.employer_blocked')).some((row) => row.actor_user_id === p.student.id)).toBe(true);
    expect((await audits('talent_pool.employer_unblocked')).some((row) => row.actor_user_id === p.student.id)).toBe(true);
  });

  it('allows at most 20 invitations per employer in any 24 hours', async () => {
    const { employerId, recruiterId } = await employer();
    const jobId = await job(employerId, recruiterId);
    // Twenty earlier invitations today, each to a different synthetic card.
    for (let i = 0; i < 20; i += 1) {
      const id = await user();
      const listing = randomUUID();
      await pool.query('INSERT INTO talent_pool_listings (id, student_user_id, consent_version) VALUES ($1,$2,$3)', [listing, id, CONSENT_VERSION]);
      await pool.query(`INSERT INTO talent_pool_invitations (id, employer_id, opportunity_id, listing_id, student_user_id, invited_by_user_id, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6, now() + interval '14 days')`, [randomUUID(), employerId, jobId, listing, id, recruiterId]);
    }
    const p = await pooledStudent();
    const [card] = await cardsFor(employerId, recruiterId, { skill: p.sqlTopic });
    expect((await overview(employerId, recruiterId).expect(200)).body.talentPool.invitationsLeftToday).toBe(0);
    expect((await invite(employerId, recruiterId, card!.cardRef, jobId).expect(429)).body.error.code).toBe('INVITATION_LIMIT_REACHED');
  });

  it('requires a signed-in, active member of a verified, active employer', async () => {
    const { employerId, recruiterId } = await employer();
    const p = await pooledStudent();
    await api().get(base(employerId) + '/talent-pool/search').query({ skill: p.sqlTopic }).expect(401);
    const stranger = (await employer()).recruiterId;
    await search(employerId, stranger, { skill: p.sqlTopic }).expect(403);
    await search(employerId, await member(employerId, 'RECRUITER', 'ENDED'), { skill: p.sqlTopic }).expect(403);
    await search(employerId, p.student.id, { skill: p.sqlTopic }).expect(403);
    await pool.query("UPDATE organizations SET verification_state = 'PENDING' WHERE id = $1", [employerId]);
    expect((await search(employerId, recruiterId, { skill: p.sqlTopic }).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_UNVERIFIED');
    await pool.query("UPDATE organizations SET verification_state = 'SUSPENDED' WHERE id = $1", [employerId]);
    expect((await search(employerId, recruiterId, { skill: p.sqlTopic }).expect(403)).body.error.code).toBe('EMPLOYER_ORGANISATION_INACTIVE');
    await overview(employerId, recruiterId).expect(403);
    await api().get('/api/v1/students/me/talent-pool').expect(401);
  });
});

describe('EMP-14: dark until HG-4', () => {
  it('offers nothing, reads nothing and shows nothing while the flag is off; leaving stays possible', async () => {
    const { employerId, recruiterId } = await employer();
    const jobId = await job(employerId, recruiterId);
    const p = await pooledStudent();
    const [card] = await cardsFor(employerId, recruiterId, { skill: p.sqlTopic });
    await invite(employerId, recruiterId, card!.cardRef, jobId).expect(201);
    const auditCount = async () => (await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'talent_pool.%' AND organization_id = $1", [employerId])).rows[0].n;
    const before = await auditCount();
    await setFlag(false);

    const fresh = await student();
    const view = (await ownPool(fresh.id).expect(200)).body.talentPool;
    expect(view).toMatchObject({ available: false, optedIn: false, consent: null, skills: [], invitations: [] });
    expect((await join_(fresh.id, { consentVersion: CONSENT_VERSION }).expect(400)).body.error.code).toBe('TALENT_POOL_UNAVAILABLE');
    const consents = await api().get('/api/v1/me/consents').set(auth(fresh.id)).expect(200);
    expect(consents.body.consents.map((row: { consentKey: string }) => row.consentKey)).not.toContain('employer-discovery');
    expect((await api().post('/api/v1/me/consents/employer-discovery/grant').set(auth(fresh.id)).send({ version: CONSENT_VERSION }).expect(400)).body.error.code).toBe('CONSENT_NOT_AVAILABLE');

    expect((await overview(employerId, recruiterId).expect(200)).body.talentPool).toEqual({ available: false });
    expect((await search(employerId, recruiterId, { skill: p.sqlTopic }).expect(200)).body.talentPool).toEqual({ available: false, cards: [], hasMore: false });
    expect((await openCard(employerId, recruiterId, card!.cardRef).expect(200)).body.talentPool).toEqual({ available: false });
    const other = await job(employerId, recruiterId);
    expect((await invite(employerId, recruiterId, card!.cardRef, other).expect(400)).body.error.code).toBe('TALENT_POOL_UNAVAILABLE');
    expect(await auditCount()).toBe(before);
    // The invitation sent while it was on no longer opens the job.
    await api().get('/api/v1/opportunities/' + jobId).set(auth(p.student.id)).expect(403);

    // The student who joined while it was on still sees that, still holds the consent visibly, and can leave.
    expect((await ownPool(p.student.id).expect(200)).body.talentPool).toMatchObject({ available: false, optedIn: true });
    expect((await api().get('/api/v1/me/consents').set(auth(p.student.id)).expect(200)).body.consents.map((row: { consentKey: string }) => row.consentKey)).toContain('employer-discovery');
    expect((await leave(p.student.id).expect(200)).body.talentPool).toMatchObject({ optedIn: false });
  });

  it('migration 0098 is replay-safe and never flips a live switch', async () => {
    await setFlag(true);
    const migration = await readFile(new URL('../../../../packages/persistence/drizzle/0098_talent_pool.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    expect((await pool.query("SELECT enabled, high_risk_direction FROM feature_flags WHERE key = 'employer.talent-pool'")).rows[0]).toEqual({ enabled: true, high_risk_direction: 'ENABLE' });
    expect((await pool.query("SELECT enforcement, withdrawable, retired_at FROM consent_definitions WHERE consent_key = 'employer-discovery' AND version = $1", [CONSENT_VERSION])).rows)
      .toEqual([{ enforcement: 'OPTIONAL', withdrawable: true, retired_at: null }]);
  });
});

describe('EMP-14: privacy', () => {
  it('puts the talent pool in the export and erases it on deletion, keeping an invitation that became an application', async () => {
    const { employerId, recruiterId } = await employer();
    const jobId = await job(employerId, recruiterId);
    const declinedJob = await job(employerId, recruiterId);
    const p = await pooledStudent();
    const [card] = await cardsFor(employerId, recruiterId, { skill: p.sqlTopic });
    await openCard(employerId, recruiterId, card!.cardRef).expect(200);
    await invite(employerId, recruiterId, card!.cardRef, jobId).expect(201);
    await invite(employerId, recruiterId, card!.cardRef, declinedJob).expect(201);
    const blocker = await employer('Blocked by subject');
    await api().post('/api/v1/students/me/talent-pool/blocks').set(auth(p.student.id)).send({ employerId: blocker.employerId }).expect(201);
    await api().post('/api/v1/students/me/applications').set(auth(p.student.id)).send({ consentGranted: true, opportunityId: jobId }).expect(201);

    const bundle = await assembleSubjectExport(db, p.student.id) as Record<string, unknown>;
    const exported = bundle.talentPool as Record<string, unknown[]>;
    expect(exported.listings).toEqual([expect.objectContaining({ endedAt: null, preferredCities: ['Chennai', 'Hyderabad'], consentVersion: CONSENT_VERSION })]);
    expect((exported.listings[0] as { evidence: unknown[] }).evidence).toHaveLength(3);
    expect(exported.blockedEmployers).toEqual([expect.objectContaining({ employerName: 'Blocked by subject' })]);
    expect(exported.invitations.map((row) => (row as { state: string }).state).sort()).toEqual(['APPLIED', 'SENT']);
    expect(exported.cardViews).toEqual([expect.objectContaining({ employerName: 'Pool employer' })]);
    expect(JSON.stringify(exported)).not.toContain(p.good);

    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, requested_at, deletion_scheduled_for, correlation_id)
      VALUES ($1, $2, $2, 'DELETION', 'RECEIVED', now() - interval '31 days', now() - interval '1 day', 'emp14-delete')`, [randomUUID(), p.student.id]);
    const [summary] = (await executeDueDeletions({ db, ids: { uuid: () => randomUUID() }, storage })).filter((row) => row.subjectUserId === p.student.id);
    expect(summary?.outcome).toBe('COMPLETED');
    expect((await pool.query('SELECT count(*)::int AS n FROM talent_pool_listing_evidence WHERE student_user_id = $1', [p.student.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM talent_pool_blocks WHERE student_user_id = $1', [p.student.id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT state FROM talent_pool_invitations WHERE student_user_id = $1', [p.student.id])).rows).toEqual([{ state: 'APPLIED' }]);
    expect((await pool.query('SELECT end_reason, preferred_cities, show_branch FROM talent_pool_listings WHERE student_user_id = $1', [p.student.id])).rows)
      .toEqual([{ end_reason: 'ACCOUNT_DELETION', preferred_cities: [], show_branch: false }]);
    // Consent records are kept as proof.
    expect((await pool.query("SELECT count(*)::int AS n FROM user_consents WHERE user_id = $1 AND consent_key = 'employer-discovery'", [p.student.id])).rows[0].n).toBe(1);
    expect(await cardsFor(employerId, recruiterId, { skill: p.sqlTopic })).toEqual([]);
  });
});
