/**
 * Faculty learning actions (INST-16) on seeded, synthetic engine fixtures: published practice sets and lessons,
 * a section with a lecturer's teaching assignment, students with and without the adaptive-learning consent.
 *
 * Acceptance: no faculty action changes a mastery value or an evidence record; every override is replayable from
 * the engine's decision audit. Plus the Appendix 3 §6.3 minimum tests that apply: scope (write scope — only the
 * lecturer's taught students; SCOPE_REQUIRED without an assignment), relationship (a student who has left drops
 * out), consent (a student's plan is shown to staff only with adaptive-learning, failing closed while the
 * definition is unpublished — HG-6), contract (no model number, no readiness), aggregates (done counts under 5
 * shown as <5), API (401, 403, 400, 409, audit rows), and that only published content can be assigned.
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
import { replayLearningDecision } from '@planthepath/persistence/src/learning-decisions.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for learning actions tests');
const schemaName = 'lactions_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const persistence = db as unknown as PersistenceDb;
const tokens = new Set<string>();
const CONSENT_VERSION = 'inst16-synthetic';
const SHA = 'e'.repeat(64);
const keyOf = new Map<string, string>();
let app: INestApplication;

let institutionId: string; let otherInstitutionId: string;
let department: string; let batch: string; let sectionX: string; let sectionY: string;
let admin: Staff; let head: Staff; let faculty: Staff; let colleague: Staff; let untaught: Staff; let yFaculty: Staff;
let subjectId: string;
let topicA: string; let topicB: string; let topicDraft: string;
let lessonA: string; let supersededLesson: string;
// Section X: six students, the first four consenting. Section Y: one student.
let s: Student[]; let sY: Student;
let author: string; let sourceRecordId: string;

interface Student { userId: string; profileId: string; name: string }
interface Staff { id: string; membershipId: string }

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
}, 120_000);

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  tokens.clear();
  keyOf.clear();
  // No adaptive-learning definition is live in any real environment until HG-6; the suite publishes a
  // synthetic one per test and retires it where a test needs the real state.
  await pool.query("DELETE FROM consent_definitions WHERE consent_key = 'adaptive-learning'");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', $1, 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')`, [CONSENT_VERSION]);

  institutionId = randomUUID(); otherInstitutionId = randomUUID();
  department = randomUUID(); batch = randomUUID(); sectionX = randomUUID(); sectionY = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Synthetic college'), ($2,'INSTITUTION','Other synthetic college')", [institutionId, otherInstitutionId]);
  await unit(department, 'DEPARTMENT', 'Department of Synthetic Studies', null);
  await unit(batch, 'BATCH', 'Batch 2026', department);
  await unit(sectionX, 'SECTION', 'Section X', batch);
  await unit(sectionY, 'SECTION', 'Section Y', batch);
  admin = await staff('INSTITUTION_ADMIN');
  head = await staff('DEPARTMENT_HEAD', department);
  faculty = await staff('FACULTY_LECTURER');
  colleague = await staff('FACULTY_LECTURER');
  untaught = await staff('FACULTY_LECTURER');
  yFaculty = await staff('FACULTY_LECTURER');

  s = [];
  for (let index = 1; index <= 6; index += 1) s.push(await student(`X-${index}`, `Student ${String.fromCharCode(64 + index)}`, sectionX, index <= 4));
  sY = await student('Y-1', 'Student Other Section', sectionY, true);

  author = await plainUser();
  await seedSourceRecord();
  topicA = await topic('Synthetic subnetting');
  topicB = await topic('Synthetic ports');
  topicDraft = await topic('Synthetic unpublished skill');
  await publishQuestions(topicA, 3, 'PUBLISHED');
  await publishQuestions(topicB, 1, 'PUBLISHED');
  await publishQuestions(topicDraft, 2, 'DRAFT');
  lessonA = await lesson(topicA, 'Subnetting by hand', false);
  supersededLesson = await lesson(topicB, 'Old ports lesson', true);

  subjectId = randomUUID();
  await pool.query("INSERT INTO exam_subjects (id,institution_id,name,code) VALUES ($1,$2,'Synthetic networks','SYN101')", [subjectId, institutionId]);
  await teach(sectionX, faculty);
  await teach(sectionX, colleague);
  await teach(sectionY, yFaculty);
});

afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

async function unit(id: string, kind: string, name: string, parent: string | null) {
  await pool.query('INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,$3,$4,$5)', [id, institutionId, kind, name, parent]);
}
async function plainUser(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO users (id,email,state) VALUES ($1,$2,'ACTIVE')", [id, id + '@example.test']);
  return id;
}
async function student(rollNumber: string, fullName: string, section: string, consent: boolean): Promise<Student> {
  const userId = randomUUID(); const profileId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id,section_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8)`, [profileId, institutionId, userId, rollNumber, fullName, department, batch, section]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE',now()-interval '2 days')`, [randomUUID(), institutionId, userId]);
  if (consent) {
    await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
      VALUES ($1, $2, 'adaptive-learning', $3, 'GRANTED', now() - interval '10 seconds')`, [randomUUID(), userId, CONSENT_VERSION]);
  }
  return { userId, profileId, name: fullName };
}
async function staff(role: string, dept: string | null = null, organization = institutionId): Promise<Staff> {
  const id = randomUUID(); const membershipId = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, id + '@example.test']);
  await pool.query(`INSERT INTO organization_memberships
    (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, organization, id, role, dept]);
  return { id, membershipId };
}
async function teach(unitId: string, lecturer: Staff): Promise<void> {
  await api().post('/api/v1/institutions/' + institutionId + '/teaching-assignments').set(auth(admin.id))
    .send({ facultyMembershipId: lecturer.membershipId, unitId, subjectId, academicTerm: '2026-27 Odd semester', reasonCode: 'NEW_TERM' }).expect(201);
}
async function seedSourceRecord(): Promise<void> {
  const [runId, packageId] = [randomUUID(), randomUUID()];
  sourceRecordId = randomUUID();
  await pool.query(`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES ($1, $2, 'synthetic/inst-16', $3, $4, 'inst16-test', 'STAGED', $5, now())`, [runId, `inst16-${runId}`, 'c'.repeat(40), SHA, author]);
  await pool.query(`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES ($1, $2, $3, 'synthetic/inst-16', $4, $5, 'inst16-test', '[]', '{}', '{}')`, [packageId, runId, `inst16-${packageId}`, 'c'.repeat(40), SHA]);
  await pool.query(`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES ($1, $2, 'ENGINE_CONTENT', 'inst16', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
  [sourceRecordId, packageId, SHA]);
}
async function topic(name: string): Promise<string> {
  const [topicId, revision] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'Synthetic topic for INST-16 tests', $4)`, [topicId, `inst16-${topicId}`, name, revision]);
  return topicId;
}
async function manifest(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1, $2, 1, $3, 'DRAFT')`,
    [id, `inst16-${id}`, id.replace(/-/g, '').repeat(2)]);
  return id;
}
/** A draft content revision, listed in the manifest (a manifest must carry items before it is approved). */
async function revision(manifestId: string, entityType: string, entityId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, $2, $3, 1, $4, 'DRAFT', $5, '{}')`, [id, entityType, entityId, author, SHA]);
  await pool.query('INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1, $2, $3, $4)',
    [manifestId, id, sourceRecordId, SHA]);
  return id;
}
async function release(manifestId: string, status: 'PUBLISHED' | 'DRAFT'): Promise<void> {
  if (status !== 'PUBLISHED') return;
  await pool.query("UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = $2, approved_at = now() WHERE id = $1", [manifestId, author]);
  await pool.query("UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = $2, published_at = now() WHERE id = $1", [manifestId, author]);
}
/** Answer-keyed questions on a topic in a release of the given status (only PUBLISHED ones are practice). */
async function publishQuestions(topicId: string, count: number, status: 'PUBLISHED' | 'DRAFT'): Promise<void> {
  const manifestId = await manifest();
  const made: { id: string; revision: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    made.push({ id, revision: await revision(manifestId, 'QUESTION', id) });
  }
  await release(manifestId, status);
  for (const [index, question] of made.entries()) {
    const key = ['a', 'b', 'c'][index % 3]!;
    const options = ['a', 'b', 'c'].map((option) => ({ id: option, text: `Synthetic option ${option}` }));
    await pool.query(`INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
      VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, now())`,
    [question.id, `inst16-q-${question.id}`, topicId, `Synthetic question ${index + 1}`, JSON.stringify(options), question.revision, manifestId]);
    await pool.query(`INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash) VALUES ($1, $2, 'Synthetic explanation.', $3)`, [question.id, key, SHA]);
    keyOf.set(question.id, key);
  }
}
async function lesson(topicId: string, title: string, superseded: boolean): Promise<string> {
  const manifestId = await manifest();
  const [moduleId, lessonId] = [randomUUID(), randomUUID()];
  const moduleRevision = await revision(manifestId, 'MODULE', moduleId);
  const lessonRevision = await revision(manifestId, 'LESSON', lessonId);
  await release(manifestId, 'PUBLISHED');
  await pool.query(`INSERT INTO learning_modules (id, stable_key, version, title, description, content_revision_id, release_manifest_id, published_at)
    VALUES ($1, $2, 1, 'Synthetic module', 'Synthetic', $3, $4, now())`, [moduleId, `inst16-m-${moduleId}`, moduleRevision, manifestId]);
  await pool.query(`INSERT INTO lesson_versions (id, module_id, stable_key, version, title, body, topic_id, content_revision_id, published_at)
    VALUES ($1, $2, $3, 1, $4, '{}', $5, $6, now())`, [lessonId, moduleId, `inst16-l-${lessonId}`, title, topicId, lessonRevision]);
  if (superseded) await pool.query('UPDATE lesson_versions SET superseded_at = now() WHERE id = $1', [lessonId]);
  return lessonId;
}

const api = () => request(app.getHttpServer());
const path = (suffix: string, institution = institutionId) => '/api/v1/institutions/' + institution + suffix;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': 'inst16-' + randomUUID() });
const practice = (skillId: string) => ({ kind: 'PRACTICE', skillId });
const lessonRef = (skillId: string, lessonVersionId: string) => ({ kind: 'LESSON', skillId, lessonVersionId });

async function assignTo(body: Record<string, unknown>, actor: Staff = faculty, status = 201) {
  return (await api().post(path('/learning-assignments')).set(auth(actor.id)).send(body).expect(status)).body;
}
async function overrideFor(learner: Student, body: Record<string, unknown>, actor: Staff = faculty, status = 201) {
  return (await api().post(path('/students/' + learner.profileId + '/plan-overrides')).set(auth(actor.id)).send(body).expect(status)).body;
}
async function nextStep(learner: Student) {
  return (await api().post('/api/v1/learning/next-step').set(auth(learner.userId)).send({}).expect(201)).body.step;
}
async function mine(learner: Student) {
  return (await api().get('/api/v1/students/me/learning-actions').set(auth(learner.userId)).expect(200)).body;
}
/** Answers every question the step serves until it is finished. */
async function finishStep(learner: Student, step: { decisionId: string; practice: { status: string; question?: { id: string } } }): Promise<void> {
  let current = step;
  for (let guard = 0; guard < 6 && current.practice.status === 'IN_PROGRESS'; guard += 1) {
    const questionId = current.practice.question!.id;
    current = (await api().post(`/api/v1/learning/steps/${current.decisionId}/answers`).set(auth(learner.userId))
      .send({ questionId, selectedOptionId: keyOf.get(questionId) }).expect(201)).body.step;
  }
  expect(current.practice.status).toBe('COMPLETED');
}
async function auditActions(): Promise<string[]> {
  return (await pool.query('SELECT action FROM audit_events WHERE organization_id = $1 ORDER BY occurred_at, id', [institutionId])).rows.map((row) => row.action as string);
}
/** Every table a faculty action must never write: mastery, attempts, evidence, readiness. */
async function learnerFacts(): Promise<Record<string, number | string>> {
  const counts: Record<string, number | string> = {};
  for (const table of ['learner_skill_state', 'learning_attempt_events', 'evidence_records', 'mastery_projections', 'readiness_snapshots', 'readiness_factors']) {
    counts[table] = (await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count as number;
  }
  const hash = await pool.query("SELECT md5(coalesce(string_agg(subject_user_id::text || skill_id::text || evidence_stage || coalesce(mastery_likelihood::text,''), ',' ORDER BY subject_user_id, skill_id), '')) AS h FROM learner_skill_state");
  counts.stateHash = hash.rows[0].h;
  return counts;
}
async function skillState(learner: Student, skill: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('one.learner_skill_state_writer', 'learner-skill-state-projector', true)");
    await client.query(
      `INSERT INTO learner_skill_state (subject_user_id, skill_id, institution_id, attempt_count, attempt_day_count, unaided_success_count,
         unaided_success_day_count, assisted_success_count, last_attempt_at, evidence_stage, evidence_band, active_misconception_codes,
         mastery_likelihood, mastery_uncertainty, mastery_algorithm_version, algorithm_version)
       VALUES ($1,$2,$3,3,2,0,0,0,now(),'ESTIMATED','NOT_ENOUGH_EVIDENCE','{}',0.4321,0.1234,'mastery-bkt-v1','learner-skill-state-v2')`,
      [learner.userId, skill, institutionId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const forbiddenKeys = /mastery|likelihood|uncertainty|stability|difficulty|readiness|score|percent|compensation|salary/i;
function assertContract(body: unknown): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) { expect(key).not.toMatch(forbiddenKeys); walk(inner); }
    }
  };
  walk(body);
  expect(JSON.stringify(body)).not.toContain('0.4321');
}

describe('Learning Resources: only published ONE content', () => {
  it('lists published practice sets and current lessons, never drafts or superseded lessons', async () => {
    const body = (await api().get(path('/learning-resources')).set(auth(faculty.id)).expect(200)).body;
    const rows = body.resources.map((entry: { kind: string; title: string; questionCount: number | null }) => `${entry.kind}:${entry.title}:${entry.questionCount ?? '-'}`);
    expect(rows).toEqual(['LESSON:Subnetting by hand:-', 'PRACTICE:Synthetic ports:1', 'PRACTICE:Synthetic subnetting:3']);
    expect(JSON.stringify(body)).not.toContain(topicDraft);
    expect(JSON.stringify(body)).not.toContain(supersededLesson);
    assertContract(body);
  });

  it('pages with a keyset cursor, filters and validates', async () => {
    const first = (await api().get(path('/learning-resources?limit=2')).set(auth(faculty.id)).expect(200)).body;
    expect(first.resources).toHaveLength(2);
    const second = (await api().get(path('/learning-resources?limit=2&cursor=' + first.nextCursor)).set(auth(faculty.id)).expect(200)).body;
    expect(second.resources.map((entry: { title: string }) => entry.title)).toEqual(['Synthetic subnetting']);
    expect(second.nextCursor).toBeNull();
    const lessons = (await api().get(path('/learning-resources?kind=LESSON')).set(auth(faculty.id)).expect(200)).body;
    expect(lessons.resources.map((entry: { lessonVersionId: string }) => entry.lessonVersionId)).toEqual([lessonA]);
    const search = (await api().get(path('/learning-resources?q=ports')).set(auth(faculty.id)).expect(200)).body;
    expect(search.resources.map((entry: { title: string }) => entry.title)).toEqual(['Synthetic ports']);
    await api().get(path('/learning-resources?limit=0')).set(auth(faculty.id)).expect(400);
    await api().get(path('/learning-resources?limit=201')).set(auth(faculty.id)).expect(400);
    await api().get(path('/learning-resources?kind=VIDEO')).set(auth(faculty.id)).expect(400);
    await api().get(path('/learning-resources?cursor=nonsense')).set(auth(faculty.id)).expect(400);
  });

  it('is for lecturers only: 401 without a token, 403 for other roles and colleges', async () => {
    await api().get(path('/learning-resources')).expect(401);
    for (const actor of [admin, head]) await api().get(path('/learning-resources')).set(auth(actor.id)).expect(403);
    await api().get(path('/learning-resources', otherInstitutionId)).set(auth(faculty.id)).expect(403);
  });

  it('refuses unpublished content at the API and in the database', async () => {
    const body = await assignTo({ resource: practice(topicDraft), unitId: sectionX }, faculty, 400);
    expect(body.error.code).toBe('CONTENT_NOT_PUBLISHED');
    await assignTo({ resource: lessonRef(topicB, supersededLesson), unitId: sectionX }, faculty, 400);
    await assignTo({ resource: lessonRef(topicB, lessonA), unitId: sectionX }, faculty, 400); // the lesson is not on that skill
    await expect(pool.query(`INSERT INTO learning_assignments (id, institution_id, assigned_by_user_id, assigned_by_membership_id, content_kind, skill_id, target_kind)
      VALUES ($1, $2, $3, $4, 'PRACTICE', $5, 'STUDENTS')`, [randomUUID(), institutionId, faculty.id, faculty.membershipId, topicDraft])).rejects.toThrow(/only published content/);
  });
});

describe('assign a practice set or lesson: a constraint the planner honours', () => {
  it('assigns to a taught class — its current students only — audited and notified', async () => {
    // A student who has left the college is not assigned.
    await pool.query("UPDATE institution_relationships SET state = 'GRADUATED', effective_to = now() - interval '1 hour' WHERE student_user_id = $1", [s[5]!.userId]);
    const body = await assignTo({ resource: practice(topicA), unitId: sectionX, note: 'Before Friday' });
    expect(body.assignment).toMatchObject({ students: 5, resource: { kind: 'PRACTICE', skillId: topicA, title: 'Synthetic subnetting' } });
    const reached = await pool.query('SELECT student_user_id FROM learning_assignment_students WHERE assignment_id = $1', [body.assignment.id]);
    expect(reached.rows.map((row) => row.student_user_id).sort()).toEqual(s.slice(0, 5).map((learner) => learner.userId).sort());
    expect(await auditActions()).toContain('learning_assignment.created');
    const notices = await pool.query("SELECT count(*)::int AS count FROM user_notifications WHERE kind = 'SYSTEM' AND data ->> 'assignmentId' = $1", [body.assignment.id]);
    expect(notices.rows[0].count).toBe(5);
    const seen = await mine(s[0]!);
    expect(seen.assignments).toEqual([expect.objectContaining({ kind: 'PRACTICE', title: 'Synthetic subnetting', institutionName: 'Synthetic college', note: 'Before Friday', status: 'OPEN' })]);
    expect((await mine(sY)).assignments).toEqual([]);
    assertContract(seen);
  });

  it('acts only on the lecturer\'s taught students (write scope)', async () => {
    expect((await assignTo({ resource: practice(topicA), unitId: sectionY }, faculty, 403)).error.code).toBe('UNIT_NOT_TAUGHT');
    expect((await assignTo({ resource: practice(topicA), studentProfileIds: [s[0]!.profileId, sY.profileId] }, faculty, 403)).error.code).toBe('STUDENT_OUT_OF_SCOPE');
    expect((await assignTo({ resource: practice(topicA), studentProfileIds: [s[0]!.profileId] }, untaught, 403)).error.code).toBe('SCOPE_REQUIRED');
    for (const actor of [admin, head]) await assignTo({ resource: practice(topicA), unitId: sectionX }, actor, 403);
    await api().post(path('/learning-assignments')).send({ resource: practice(topicA), unitId: sectionX }).expect(401);
    expect(await pool.query('SELECT 1 FROM learning_assignments')).toMatchObject({ rowCount: 0 });
  });

  it('validates the request', async () => {
    await assignTo({ resource: practice(topicA) }, faculty, 400); // no target
    await assignTo({ resource: practice(topicA), unitId: sectionX, studentProfileIds: [s[0]!.profileId] }, faculty, 400); // two targets
    await assignTo({ resource: practice(topicA), unitId: sectionX, surprise: true }, faculty, 400);
    await assignTo({ resource: { ...practice(topicA), lessonVersionId: lessonA }, unitId: sectionX }, faculty, 400);
    await assignTo({ resource: practice(topicA), studentProfileIds: [s[0]!.profileId, s[0]!.profileId] }, faculty, 400);
    await assignTo({ resource: practice(topicA), unitId: sectionX, note: 'x'.repeat(501) }, faculty, 400);
  });

  it('comes up as the student\'s next step, and is done once they finish a step on the skill', async () => {
    const created = await assignTo({ resource: practice(topicA), studentProfileIds: [s[4]!.profileId] });
    const step = await nextStep(s[4]!); // no consent, no career target: the assignment is the only candidate
    expect(step).toMatchObject({ action: 'FOLLOW_ASSIGNMENT', skill: { id: topicA }, reasonCodes: ['FACULTY_ASSIGNMENT', 'NON_ADAPTIVE_NO_CONSENT'] });
    const decision = await pool.query('SELECT inputs FROM learning_decisions WHERE id = $1', [step.decisionId]);
    expect(decision.rows[0].inputs.constraints.assignments).toEqual([expect.objectContaining({ assignmentId: created.assignment.id, skillId: topicA })]);
    expect(await replayLearningDecision(persistence, step.decisionId)).toMatchObject({ status: 'MATCHED' });
    await finishStep(s[4]!, step);
    expect((await mine(s[4]!)).assignments[0].status).toBe('DONE');
    const after = await nextStep(s[4]!);
    expect(after.action).toBe('NONE');
    const students = (await api().get(path('/learning-assignments/' + created.assignment.id + '/students')).set(auth(faculty.id)).expect(200)).body;
    expect(students.students).toEqual([{ profileId: s[4]!.profileId, fullName: 'Student E', rollNumber: 'X-5', status: 'DONE' }]);
    expect(await auditActions()).toContain('institution.learning_assignment.students_read');
    // One student done is a count of people under five: shown as <5.
    const list = (await api().get(path('/learning-actions')).set(auth(faculty.id)).expect(200)).body;
    expect(list.assignments[0]).toMatchObject({ students: 1, done: { suppressed: true, count: null } });
    // Only the author sees who it reached.
    await api().get(path('/learning-assignments/' + created.assignment.id + '/students')).set(auth(colleague.id)).expect(404);
  });

  it('a lesson assignment is done when the student completes the lesson', async () => {
    const created = await assignTo({ resource: lessonRef(topicA, lessonA), studentProfileIds: [s[0]!.profileId] });
    expect((await mine(s[0]!)).assignments[0]).toMatchObject({ kind: 'LESSON', title: 'Subnetting by hand', status: 'OPEN' });
    await pool.query(`INSERT INTO learner_progress (id, subject_user_id, lesson_version_id, state, started_at, completed_at, last_correlation_id)
      VALUES ($1, $2, $3, 'COMPLETED', now(), now(), 'inst16-lesson-done')`, [randomUUID(), s[0]!.userId, lessonA]);
    expect((await mine(s[0]!)).assignments[0].status).toBe('DONE');
    expect((await api().get(path('/learning-assignments/' + created.assignment.id + '/students')).set(auth(faculty.id)).expect(200)).body.students[0].status).toBe('DONE');
  });

  it('withdrawn assignments stop being constraints; only the author withdraws, with a reason', async () => {
    const created = await assignTo({ resource: practice(topicB), studentProfileIds: [s[4]!.profileId] });
    await api().post(path('/learning-assignments/' + created.assignment.id + '/withdraw')).set(auth(faculty.id)).send({ reasonCode: 'NOT_A_CODE' }).expect(400);
    await api().post(path('/learning-assignments/' + created.assignment.id + '/withdraw')).set(auth(colleague.id)).send({ reasonCode: 'SET_IN_ERROR' }).expect(404);
    await api().post(path('/learning-assignments/' + created.assignment.id + '/withdraw')).set(auth(faculty.id)).send({ reasonCode: 'SET_IN_ERROR' }).expect(201);
    await api().post(path('/learning-assignments/' + created.assignment.id + '/withdraw')).set(auth(faculty.id)).send({ reasonCode: 'SET_IN_ERROR' }).expect(409);
    expect((await nextStep(s[4]!)).action).toBe('NONE');
    expect((await mine(s[4]!)).assignments).toEqual([]);
    expect(await auditActions()).toContain('learning_assignment.withdrawn');
  });
});

describe('plan override for one student: reason code, notified, replayable from the decision audit', () => {
  it('decides the student\'s next step once, is recorded on the decision and replays', async () => {
    const created = await overrideFor(s[0]!, { action: 'PRACTICE', resource: practice(topicB), reasonCode: 'CLASS_TOPIC_ALIGNMENT', note: 'We cover ports this week' });
    expect(created.override).toMatchObject({ state: 'PENDING', action: 'PRACTICE', reasonCode: 'CLASS_TOPIC_ALIGNMENT' });
    const notice = await pool.query("SELECT title FROM user_notifications WHERE user_id = $1 AND data ->> 'overrideId' = $2", [s[0]!.userId, created.override.id]);
    expect(notice.rows).toEqual([{ title: 'Your lecturer set your next step' }]);
    expect((await mine(s[0]!)).pendingOverride).toMatchObject({ action: 'PRACTICE', title: 'Synthetic ports', reasonCode: 'CLASS_TOPIC_ALIGNMENT', note: 'We cover ports this week' });
    await overrideFor(s[0]!, { action: 'LEARN', resource: practice(topicA), reasonCode: 'FACULTY_JUDGEMENT' }, colleague, 409);

    const step = await nextStep(s[0]!);
    expect(step).toMatchObject({ action: 'PRACTICE', skill: { id: topicB } });
    expect(step.reasonCodes[0]).toBe('FACULTY_OVERRIDE');
    const row = await pool.query('SELECT override_by_user_id, override_reason_code, inputs FROM learning_decisions WHERE id = $1', [step.decisionId]);
    expect(row.rows[0]).toMatchObject({ override_by_user_id: faculty.id, override_reason_code: 'CLASS_TOPIC_ALIGNMENT' });
    expect(row.rows[0].inputs.constraints.override).toMatchObject({ overrideId: created.override.id, byUserId: faculty.id, action: 'PRACTICE', skillId: topicB });
    const applied = await pool.query('SELECT state, applied_decision_id FROM learning_plan_overrides WHERE id = $1', [created.override.id]);
    expect(applied.rows[0]).toEqual({ state: 'APPLIED', applied_decision_id: step.decisionId });
    expect(await replayLearningDecision(persistence, step.decisionId)).toMatchObject({ status: 'MATCHED' });
    // Once: the next plan is the planner's own again.
    const next = await nextStep(s[0]!);
    expect(next.reasonCodes).not.toContain('FACULTY_OVERRIDE');
    expect((await mine(s[0]!)).pendingOverride).toBeNull();
    // The link to the decision audit cannot be forged or rewritten.
    const other = await overrideFor(s[1]!, { action: 'LEARN', resource: practice(topicA), reasonCode: 'PREREQUISITE_FIRST' });
    await expect(pool.query("UPDATE learning_plan_overrides SET state = 'APPLIED', applied_decision_id = $2, applied_at = now() WHERE id = $1",
      [other.override.id, step.decisionId])).rejects.toThrow(/only by the decision that carries it/);
    await expect(pool.query("UPDATE learning_plan_overrides SET reason_code = 'FACULTY_JUDGEMENT' WHERE id = $1", [created.override.id])).rejects.toThrow(/only a pending override/);
  });

  it('refuses a reason outside the list, REMEDIATE, unpublished content and students outside the scope', async () => {
    expect((await overrideFor(s[0]!, { action: 'PRACTICE', resource: practice(topicA), reasonCode: 'BECAUSE' }, faculty, 400)).error.code).toBe('INVALID_REASON_CODE');
    await overrideFor(s[0]!, { action: 'PRACTICE', resource: practice(topicA) }, faculty, 400);
    await overrideFor(s[0]!, { action: 'REMEDIATE', resource: practice(topicA), reasonCode: 'FACULTY_JUDGEMENT' }, faculty, 400);
    await overrideFor(s[0]!, { action: 'PRACTICE', resource: practice(topicDraft), reasonCode: 'FACULTY_JUDGEMENT' }, faculty, 400);
    expect((await overrideFor(sY, { action: 'PRACTICE', resource: practice(topicA), reasonCode: 'FACULTY_JUDGEMENT' }, faculty, 403)).error.code).toBe('STUDENT_OUT_OF_SCOPE');
    await overrideFor(s[0]!, { action: 'PRACTICE', resource: practice(topicA), reasonCode: 'FACULTY_JUDGEMENT' }, untaught, 403);
    await overrideFor(s[0]!, { action: 'PRACTICE', resource: practice(topicA), reasonCode: 'FACULTY_JUDGEMENT' }, head, 403);
    await overrideFor(s[0]!, { action: 'PRACTICE', resource: practice(topicA), reasonCode: 'FACULTY_JUDGEMENT', extra: 1 }, faculty, 400);
    expect(await pool.query('SELECT 1 FROM learning_plan_overrides')).toMatchObject({ rowCount: 0 });
  });

  it('a pending override can be withdrawn by a lecturer who teaches the student, not by one who does not', async () => {
    const created = await overrideFor(s[2]!, { action: 'LEARN', resource: lessonRef(topicA, lessonA), reasonCode: 'REVISIT_FUNDAMENTALS' });
    await api().post(path('/plan-overrides/' + created.override.id + '/withdraw')).set(auth(yFaculty.id)).send({ reasonCode: 'REPLACED' }).expect(404);
    await api().post(path('/plan-overrides/' + created.override.id + '/withdraw')).set(auth(colleague.id)).send({ reasonCode: 'REPLACED' }).expect(201);
    await api().post(path('/plan-overrides/' + created.override.id + '/withdraw')).set(auth(faculty.id)).send({ reasonCode: 'REPLACED' }).expect(409);
    expect((await nextStep(s[2]!)).reasonCodes).not.toContain('FACULTY_OVERRIDE');
    expect(await auditActions()).toEqual(expect.arrayContaining(['learning_plan_override.created', 'learning_plan_override.withdrawn']));
  });
});

describe('the student\'s plan is adaptive data: shown to the lecturer only with consent', () => {
  it('shows the latest step for a consenting student, nothing for one who has not consented, and audits the read', async () => {
    await nextStep(s[0]!);
    await nextStep(s[4]!);
    const shown = (await api().get(path('/students/' + s[0]!.profileId + '/learning-plan')).set(auth(faculty.id)).expect(200)).body;
    expect(shown.consent).toEqual({ offered: true, held: true });
    expect(shown.latestStep).toMatchObject({ action: 'NONE', reasonCodes: ['NO_CAREER_TARGET'] });
    const hidden = (await api().get(path('/students/' + s[4]!.profileId + '/learning-plan')).set(auth(faculty.id)).expect(200)).body;
    expect(hidden).toMatchObject({ consent: { offered: true, held: false }, latestStep: null });
    const audits = await pool.query("SELECT context FROM audit_events WHERE action = 'institution.learning_plan.read' ORDER BY occurred_at");
    expect(audits.rows.map((row) => row.context.planShown)).toEqual([true, false]);
    await api().get(path('/students/' + sY.profileId + '/learning-plan')).set(auth(faculty.id)).expect(403);
    assertContract(shown);
  });

  it('fails closed while the adaptive-learning definition is not published (HG-6)', async () => {
    await nextStep(s[0]!);
    await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning'");
    const body = (await api().get(path('/students/' + s[0]!.profileId + '/learning-plan')).set(auth(faculty.id)).expect(200)).body;
    expect(body).toMatchObject({ consent: { offered: false, held: false }, latestStep: null });
  });
});

describe('group session: a MEETING staff action with attendees and linked content', () => {
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();
  const inTwoHours = () => new Date(Date.now() + 7_200_000).toISOString();

  it('is on the lecturer\'s calendar, and on the attendees\' Learning page until cancelled', async () => {
    const body = (await api().post(path('/group-sessions')).set(auth(faculty.id)).send({
      title: 'Subnetting clinic', scheduledStartAt: inAnHour(), scheduledEndAt: inTwoHours(), note: 'Staff-only planning note',
      resources: [practice(topicA), lessonRef(topicA, lessonA)], studentProfileIds: [s[0]!.profileId, s[1]!.profileId],
    }).expect(201)).body;
    expect(body.session.attendees).toBe(2);
    const calendar = (await api().get('/api/v1/institutions/' + institutionId + '/staff-actions?actionType=MEETING').set(auth(faculty.id)).expect(200)).body;
    const meeting = calendar.actions.find((action: { id: string }) => action.id === body.session.id);
    expect(meeting).toMatchObject({ title: 'Subnetting clinic', actionType: 'MEETING', state: 'DRAFT' });
    const seen = await mine(s[0]!);
    expect(seen.sessions).toEqual([expect.objectContaining({
      title: 'Subnetting clinic', institutionName: 'Synthetic college',
      content: [{ kind: 'PRACTICE', title: 'Synthetic subnetting', skillName: 'Synthetic subnetting' }, { kind: 'LESSON', title: 'Subnetting by hand', skillName: 'Synthetic subnetting' }],
    })]);
    expect(JSON.stringify(seen)).not.toContain('Staff-only planning note');
    expect((await mine(s[2]!)).sessions).toEqual([]);
    const list = (await api().get(path('/learning-actions')).set(auth(faculty.id)).expect(200)).body;
    expect(list.sessions[0]).toMatchObject({ title: 'Subnetting clinic', attendees: 2 });
    expect(await auditActions()).toContain('group_session.created');
    await api().post('/api/v1/institutions/' + institutionId + '/staff-actions/' + body.session.id + '/transition?actionType=MEETING').set(auth(faculty.id))
      .send({ version: 1, toState: 'CANCELLED', note: 'Room unavailable' }).expect(201);
    expect((await mine(s[0]!)).sessions).toEqual([]);
  });

  it('validates times, content and the class', async () => {
    const valid = { title: 'Clinic', scheduledStartAt: inAnHour(), scheduledEndAt: inTwoHours(), resources: [practice(topicA)], unitId: sectionX };
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({ ...valid, scheduledEndAt: valid.scheduledStartAt }).expect(400);
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({ ...valid, scheduledStartAt: '2020-01-01T09:00:00Z', scheduledEndAt: '2020-01-01T10:00:00Z' }).expect(400);
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({ ...valid, resources: [] }).expect(400);
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({ ...valid, resources: [practice(topicA), practice(topicA)] }).expect(400);
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({ ...valid, resources: [practice(topicDraft)] }).expect(400);
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({ ...valid, unitId: sectionY }).expect(403);
    await api().post(path('/group-sessions')).set(auth(untaught.id)).send(valid).expect(403);
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({ ...valid, title: '' }).expect(400);
    const created = (await api().post(path('/group-sessions')).set(auth(faculty.id)).send(valid).expect(201)).body;
    expect(created.session.attendees).toBe(6);
  });
});

describe('acceptance: no faculty action changes a mastery value or an evidence record', () => {
  it('leaves skill state, attempts, evidence, projections and readiness untouched', async () => {
    await skillState(s[0]!, topicA);
    const before = await learnerFacts();
    const assignment = await assignTo({ resource: practice(topicA), unitId: sectionX });
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({
      title: 'Clinic', scheduledStartAt: new Date(Date.now() + 3_600_000).toISOString(), scheduledEndAt: new Date(Date.now() + 7_200_000).toISOString(),
      resources: [practice(topicA)], unitId: sectionX,
    }).expect(201);
    const override = await overrideFor(s[0]!, { action: 'REVIEW', resource: practice(topicA), reasonCode: 'UPCOMING_ASSESSMENT' });
    await api().post(path('/plan-overrides/' + override.override.id + '/withdraw')).set(auth(faculty.id)).send({ reasonCode: 'NO_LONGER_NEEDED' }).expect(201);
    await api().post(path('/learning-assignments/' + assignment.assignment.id + '/withdraw')).set(auth(faculty.id)).send({ reasonCode: 'NO_LONGER_NEEDED' }).expect(201);
    await api().get(path('/students/' + s[0]!.profileId + '/learning-plan')).set(auth(faculty.id)).expect(200);
    expect(await learnerFacts()).toEqual(before);
    const list = (await api().get(path('/learning-actions')).set(auth(faculty.id)).expect(200)).body;
    assertContract(list);
    expect(list).toMatchObject({ mode: 'ASSIGNMENTS', canAct: true, targets: [{ unitId: sectionX, kind: 'SECTION', name: 'Section X' }] });
  });
});

describe('privacy deletion', () => {
  it('erases what lecturers set for the person, keeping the lecturer\'s own act', async () => {
    const assignment = await assignTo({ resource: practice(topicA), studentProfileIds: [s[0]!.profileId, s[1]!.profileId] });
    await api().post(path('/group-sessions')).set(auth(faculty.id)).send({
      title: 'Clinic', scheduledStartAt: new Date(Date.now() + 3_600_000).toISOString(), scheduledEndAt: new Date(Date.now() + 7_200_000).toISOString(),
      resources: [practice(topicA)], studentProfileIds: [s[0]!.profileId],
    }).expect(201);
    await overrideFor(s[0]!, { action: 'PRACTICE', resource: practice(topicB), reasonCode: 'STUDENT_REQUEST' });
    await nextStep(s[0]!); // applies the override: it now points at a decision
    await expect(pool.query('DELETE FROM learning_plan_overrides WHERE student_user_id = $1', [s[0]!.userId])).rejects.toThrow(/privacy deletion/);
    await expect(pool.query('DELETE FROM learning_assignment_students WHERE student_user_id = $1', [s[0]!.userId])).rejects.toThrow(/privacy deletion/);
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
      VALUES ($1, $2, $2, 'DELETION', now() - interval '31 days', now() - interval '1 day')`, [randomUUID(), s[0]!.userId]);
    const summaries = await executeDueDeletions({ db: persistence, ids: { uuid: () => randomUUID() } });
    expect(summaries.find((summary) => summary.subjectUserId === s[0]!.userId)?.outcome).toBe('COMPLETED');
    for (const [table, column] of [['learning_plan_overrides', 'student_user_id'], ['learning_assignment_students', 'student_user_id'], ['staff_action_attendees', 'student_user_id'], ['learning_decisions', 'subject_user_id']] as const) {
      expect((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`, [s[0]!.userId])).rows[0].count).toBe(0);
    }
    expect((await pool.query('SELECT count(*)::int AS count FROM learning_assignment_students WHERE assignment_id = $1', [assignment.assignment.id])).rows[0].count).toBe(1);
  });
});
