/**
 * The faculty cohort view (INST-15) on seeded, synthetic data.
 *
 * Acceptance: every figure comes from the engine tables (learner_skill_state, published misconception
 * codes) or shows nothing; only students in the lecturer's active teaching assignments appear. Plus the
 * Appendix 3 §6.3 minimum tests that apply: scope, relationship, consent (fails closed until the
 * adaptive-learning definition is published; withdrawal effective on the next request), contract (no
 * model number, no readiness, no compensation), aggregates (misconceptions under 5 withheld), API (401,
 * 403, 400, pagination bounds, audit rows).
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
import { createMisconceptionCodeDraft, publishEngineContentRelease, transitionEngineContent } from '@planthepath/persistence/src/misconceptions.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for learning cohort tests');
const schemaName = 'cohort_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const persistence = db as unknown as PersistenceDb;
const tokens = new Set<string>();
const CONSENT_VERSION = 'inst15-synthetic';
const SHA = 'f'.repeat(64);
let app: INestApplication;

let institutionId: string; let otherInstitutionId: string;
let department: string; let batch: string; let sectionX: string; let sectionY: string;
let admin: Staff; let head: Staff; let faculty: Staff; let otherFaculty: Staff; let outsideFaculty: Staff;
let subjectId: string;
let topicA: string; let topicB: string;
// Section X: six consenting students (s1–s6) and one who never consented (sNo). Section Y: sY, consenting.
let s: Student[]; let sNo: Student; let sY: Student;
let author: string; let reviewer: string; let publisher: string; let sourceRecordId: string;

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
  // No adaptive-learning definition is live in any real environment until HG-6; the suite publishes a
  // synthetic one per test and removes it where a test needs the real state.
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
  otherFaculty = await staff('FACULTY_LECTURER');
  outsideFaculty = await staff('FACULTY_LECTURER', null, otherInstitutionId);

  s = [];
  for (let index = 1; index <= 6; index += 1) s.push(await student(`X-${index}`, `Student ${String.fromCharCode(64 + index)}`, sectionX, true));
  sNo = await student('X-NO', 'Student Unconsented', sectionX, false);
  sY = await student('Y-1', 'Student Other Section', sectionY, true);

  author = await plainUser(); reviewer = await plainUser(); publisher = await plainUser();
  await seedSourceRecord();
  topicA = await topic('Synthetic subnetting');
  topicB = await topic('Synthetic ports');
  subjectId = randomUUID();
  await pool.query("INSERT INTO exam_subjects (id,institution_id,name,code) VALUES ($1,$2,'Synthetic networks','SYN101')", [subjectId, institutionId]);
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
  const userId = await plainUser(); const profileId = randomUUID();
  await pool.query(`INSERT INTO institution_student_profiles
    (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id,section_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7,$8)`, [profileId, institutionId, userId, rollNumber, fullName, department, batch, section]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from)
    VALUES ($1,$2,$3,'ACTIVE',now()-interval '2 days')`, [randomUUID(), institutionId, userId]);
  if (consent) await grant(userId);
  return { userId, profileId, name: fullName };
}
async function grant(userId: string, action: 'GRANTED' | 'WITHDRAWN' = 'GRANTED') {
  await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
    VALUES ($1, $2, 'adaptive-learning', $3, $4, now())`, [randomUUID(), userId, CONSENT_VERSION, action]);
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
async function seedSourceRecord(): Promise<void> {
  const [runId, packageId] = [randomUUID(), randomUUID()];
  sourceRecordId = randomUUID();
  await pool.query(`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES ($1, $2, 'synthetic/inst-15', $3, $4, 'inst15-test', 'STAGED', $5, now())`, [runId, `inst15-${runId}`, 'c'.repeat(40), SHA, author]);
  await pool.query(`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES ($1, $2, $3, 'synthetic/inst-15', $4, $5, 'inst15-test', '[]', '{}', '{}')`, [packageId, runId, `inst15-${packageId}`, 'c'.repeat(40), SHA]);
  await pool.query(`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES ($1, $2, 'ENGINE_CONTENT', 'inst15', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
  [sourceRecordId, packageId, SHA]);
}
async function topic(name: string): Promise<string> {
  const [topicId, revision] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'Synthetic topic for INST-15 tests', $4)`, [topicId, `inst15-${topicId}`, name, revision]);
  return topicId;
}
/** A misconception code on topic A, published through the engine-content lifecycle unless `publish` is false. */
async function misconception(code: string, title: string, publish = true): Promise<void> {
  const draft = await createMisconceptionCodeDraft(persistence, {
    source: 'AUTHORED', basis: 'Synthetic basis for a test.', code, skillId: topicA, title,
    description: 'Synthetic misconception for the INST-15 tests.', authorUserId: author,
  });
  if (!publish) return;
  const correlationId = `inst15-${randomUUID()}`;
  await transitionEngineContent(persistence, { revisionId: draft.revisionId, to: 'IN_REVIEW', actorUserId: author, reasonCode: 'SYNTHETIC_REVIEW', correlationId });
  await transitionEngineContent(persistence, { revisionId: draft.revisionId, to: 'APPROVED', actorUserId: reviewer, reasonCode: 'SYNTHETIC_REVIEW', correlationId });
  await publishEngineContentRelease(persistence, {
    revisionIds: [draft.revisionId], releaseName: `inst15-${randomUUID()}`, releaseVersion: 1, sourceRecordId,
    approverUserId: reviewer, publisherUserId: publisher, correlationId,
  });
}

interface StateRow {
  days: number; unaided: number; codes?: string[]; due?: 'PAST' | 'FUTURE' | null; institution?: string;
}
/** A learner_skill_state row as the projector writes it (the 0052 guard admits only the projector's setting). */
async function skillState(learner: Student, skill: string, row: StateRow): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('one.learner_skill_state_writer', 'learner-skill-state-projector', true)");
    const attempts = Math.max(row.days, 1) + row.unaided;
    const due = row.due === 'PAST' ? "now() - interval '1 day'" : row.due === 'FUTURE' ? "now() + interval '3 days'" : null;
    await client.query(
      `INSERT INTO learner_skill_state (subject_user_id, skill_id, institution_id, attempt_count, attempt_day_count, unaided_success_count,
         unaided_success_day_count, assisted_success_count, last_attempt_at, evidence_stage, evidence_band, active_misconception_codes,
         mastery_likelihood, mastery_uncertainty, mastery_algorithm_version,
         review_stability, review_difficulty, review_due_at, review_algorithm_version, algorithm_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,now(),'ESTIMATED','NOT_ENOUGH_EVIDENCE',$8,
         0.4321,0.1234,'mastery-bkt-v1',
         ${due ? `2.5,5.5,${due},'review-scheduler-fsrs-v1'` : 'NULL,NULL,NULL,NULL'},'learner-skill-state-v2')`,
      [learner.userId, skill, row.institution ?? institutionId, attempts, row.days, row.unaided, row.unaided > 0 ? 1 : 0, row.codes ?? []],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const api = () => request(app.getHttpServer());
const base = (institution = institutionId) => '/api/v1/institutions/' + institution + '/learning-cohort';
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': randomUUID() });
const summary = async (actor: Staff = faculty) => (await api().get(base()).set(auth(actor.id)).expect(200)).body;
const dueList = async (query = '', actor: Staff = faculty) => (await api().get(base() + '/due-reviews' + query).set(auth(actor.id)).expect(200)).body;
async function assign(unitId = sectionX, lecturer: Staff = faculty): Promise<string> {
  const created = await api().post('/api/v1/institutions/' + institutionId + '/teaching-assignments').set(auth(admin.id))
    .send({ facultyMembershipId: lecturer.membershipId, unitId, subjectId, academicTerm: '2026-27 Odd semester', reasonCode: 'NEW_TERM' }).expect(201);
  return created.body.assignment.id as string;
}

/** The standard picture: two stuck on A, two not-quite-stuck, leaks that must stay out, and misconceptions. */
async function seedCohort(): Promise<void> {
  await misconception('SYN_COMMON_TRAP', 'Counts the network address as a host');
  await misconception('SYN_RARE_TRAP', 'Confuses the mask with the block size');
  await misconception('SYN_DRAFT_TRAP', 'Unpublished synthetic trap', false);
  const [s1, s2, s3, s4, s5, s6] = s as [Student, Student, Student, Student, Student, Student];
  await skillState(s1, topicA, { days: 2, unaided: 0, codes: ['SYN_COMMON_TRAP', 'SYN_DRAFT_TRAP', 'SYN_RARE_TRAP'], due: 'PAST' });
  await skillState(s2, topicA, { days: 3, unaided: 0, codes: ['SYN_COMMON_TRAP', 'SYN_DRAFT_TRAP', 'SYN_RARE_TRAP'] });
  await skillState(s2, topicB, { days: 1, unaided: 1, due: 'FUTURE' });
  await skillState(s3, topicA, { days: 1, unaided: 0, codes: ['SYN_COMMON_TRAP', 'SYN_DRAFT_TRAP', 'SYN_RARE_TRAP'] }); // one day: not stuck (engine rule)
  await skillState(s4, topicA, { days: 3, unaided: 1, codes: ['SYN_COMMON_TRAP', 'SYN_DRAFT_TRAP', 'SYN_RARE_TRAP'] }); // succeeded once: not stuck
  await skillState(s5, topicB, { days: 2, unaided: 1, codes: ['SYN_COMMON_TRAP', 'SYN_DRAFT_TRAP'], due: 'PAST' });
  await skillState(s5, topicA, { days: 2, unaided: 1, due: 'PAST' });
  // Attributed to another college: must not appear here.
  await skillState(s6, topicB, { days: 4, unaided: 0, codes: ['SYN_RARE_TRAP'], due: 'PAST', institution: otherInstitutionId });
  // Would-be leaks: no consent, and outside the assignment. Both also hold SYN_RARE_TRAP, which would lift it to 5+.
  await skillState(sNo, topicA, { days: 2, unaided: 0, codes: ['SYN_RARE_TRAP'], due: 'PAST' });
  await skillState(sY, topicA, { days: 2, unaided: 0, codes: ['SYN_RARE_TRAP'], due: 'PAST' });
}

const forbiddenKeys = /mastery|likelihood|uncertainty|stability|difficulty|due_?at|dueAt|interval|readiness|score|percent|compensation|salary|ctc|attempt/i;
function assertContract(body: unknown): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        expect(key).not.toMatch(forbiddenKeys);
        walk(inner);
      }
    }
  };
  walk(body);
  const text = JSON.stringify(body);
  expect(text).not.toContain('0.4321');
  expect(text).not.toContain('2.5');
  expect(text).not.toContain('5.5');
}

describe('acceptance: only students in the lecturer\'s assignments appear', () => {
  it('groups the lecturer\'s students stuck on the same skill, by the engine\'s rule', async () => {
    await seedCohort();
    await assign();
    const body = await summary();
    expect(body.mode).toBe('ASSIGNMENTS');
    expect(body.consent).toEqual({ offered: true });
    expect(body.students).toBe(7); // s1–s6 and sNo in section X
    expect(body.studentsSharing).toEqual({ suppressed: false, count: 6 });
    expect(body.stuckSkills).toEqual([{
      skillId: topicA, skillName: 'Synthetic subnetting', studentCount: 2,
      students: [
        { profileId: s[0]!.profileId, fullName: 'Student A', rollNumber: 'X-1' },
        { profileId: s[1]!.profileId, fullName: 'Student B', rollNumber: 'X-2' },
      ],
    }]);
    assertContract(body);
  });

  it('shows nobody to a lecturer with no active assignment, or before the college records any', async () => {
    await seedCohort();
    // Before any assignment: MEMBERSHIP mode, and the view does not fall back to the department or college.
    const before = await summary();
    expect(before).toMatchObject({ mode: 'MEMBERSHIP', students: 0, stuckSkills: [], misconceptions: [] });
    expect((await dueList()).students).toEqual([]);
    await assign();
    const other = await summary(otherFaculty);
    expect(other).toMatchObject({ mode: 'ASSIGNMENTS', students: 0, stuckSkills: [], misconceptions: [] });
  });

  it('covers every section of an assigned batch', async () => {
    await seedCohort();
    await assign(batch);
    const body = await summary();
    expect(body.stuckSkills[0].students.map((entry: { fullName: string }) => entry.fullName)).toEqual(['Student A', 'Student B', 'Student Other Section']);
  });

  it('removes access on the next request when the assignment ends', async () => {
    await seedCohort();
    const id = await assign();
    expect((await summary()).stuckSkills).toHaveLength(1);
    await api().post('/api/v1/institutions/' + institutionId + '/teaching-assignments/' + id + '/end').set(auth(admin.id)).send({ reasonCode: 'TERM_ENDED' }).expect(201);
    expect((await summary()).stuckSkills).toEqual([]);
  });
});

describe('consent: adaptive data only for students who hold adaptive-learning', () => {
  it('fails closed to empty while the definition is not published (the state until HG-6)', async () => {
    await seedCohort();
    await assign();
    await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning'");
    const body = await summary();
    expect(body).toMatchObject({ consent: { offered: false }, students: 7, studentsSharing: { suppressed: true, count: null }, stuckSkills: [], misconceptions: [], misconceptionsWithheld: false });
    expect((await dueList()).students).toEqual([]);
  });

  it('drops a student on the next request after they withdraw', async () => {
    await seedCohort();
    await assign();
    await grant(s[0]!.userId, 'WITHDRAWN');
    const body = await summary();
    expect(body.stuckSkills[0].students.map((entry: { fullName: string }) => entry.fullName)).toEqual(['Student B']);
    expect((await dueList()).students.map((entry: { fullName: string }) => entry.fullName)).toEqual(['Student E']);
  });

  it('treats a grant of a superseded version as no consent', async () => {
    await seedCohort();
    await assign();
    await pool.query("UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning'");
    await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
      VALUES ('adaptive-learning', 'inst15-v2', 'Synthetic adaptive learning purpose v2', 'OPTIONAL', true, now() - interval '1 second')`);
    expect((await summary()).stuckSkills).toEqual([]);
  });
});

describe('relationship: current students only', () => {
  it('leaves out a student whose relationship has ended', async () => {
    await seedCohort();
    await assign();
    await pool.query("UPDATE institution_relationships SET state = 'ENDED', effective_to = now() - interval '1 second' WHERE student_user_id = $1", [s[1]!.userId]);
    const body = await summary();
    expect(body.stuckSkills[0].students.map((entry: { fullName: string }) => entry.fullName)).toEqual(['Student A']);
    expect(body.students).toBe(6);
  });
});

describe('aggregates: misconceptions under 5 are withheld', () => {
  it('shows a published code held by 5 or more students, withholds one held by 4, never counts a draft code', async () => {
    await seedCohort();
    await assign();
    const body = await summary();
    // SYN_COMMON_TRAP: s1–s5. SYN_RARE_TRAP: s1–s4 here (sNo, sY and s6's other-college row must not lift it to 5+).
    expect(body.misconceptions).toEqual([{ code: 'SYN_COMMON_TRAP', title: 'Counts the network address as a host', skillName: 'Synthetic subnetting', students: 5 }]);
    expect(body.misconceptionsWithheld).toBe(true);
    expect(JSON.stringify(body)).not.toContain('SYN_RARE_TRAP');
    expect(JSON.stringify(body)).not.toContain('SYN_DRAFT_TRAP');
  });

  it('suppresses the count of students sharing learning data under 5', async () => {
    await assign();
    for (const learner of s.slice(0, 3)) await grant(learner.userId, 'WITHDRAWN');
    expect((await summary()).studentsSharing).toEqual({ suppressed: true, count: null });
  });
});

describe('reviews due: skill names, never a date', () => {
  it('lists students with a review due now, with the due skills, keyset-paginated', async () => {
    await seedCohort();
    await assign();
    const first = await dueList('?limit=1');
    expect(first.students).toEqual([{ profileId: s[0]!.profileId, fullName: 'Student A', rollNumber: 'X-1', dueSkills: ['Synthetic subnetting'] }]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await dueList('?limit=1&cursor=' + first.nextCursor);
    expect(second.students).toEqual([{ profileId: s[4]!.profileId, fullName: 'Student E', rollNumber: 'X-5', dueSkills: ['Synthetic ports', 'Synthetic subnetting'] }]);
    expect(second.nextCursor).toBeNull();
    assertContract(first); assertContract(second);
  });

  it('rejects limits outside 1–200 and malformed cursors', async () => {
    await assign();
    for (const query of ['?limit=0', '?limit=201', '?limit=abc', '?cursor=not-a-cursor']) {
      const response = await api().get(base() + '/due-reviews' + query).set(auth(faculty.id)).expect(400);
      expect(response.body.error.code).toBe('INVALID_QUERY');
    }
    await api().get(base() + '/due-reviews?limit=200').set(auth(faculty.id)).expect(200);
  });
});

describe('API: authentication, roles, audit', () => {
  it('401 without a token', async () => {
    await api().get(base()).expect(401);
    await api().get(base() + '/due-reviews').expect(401);
  });

  it('403 for every non-faculty role and for a lecturer of another college, with no internal detail', async () => {
    for (const actor of [admin, head]) {
      const response = await api().get(base()).set(auth(actor.id)).expect(403);
      expect(response.body.error).toMatchObject({ code: 'FORBIDDEN' });
      await api().get(base() + '/due-reviews').set(auth(actor.id)).expect(403);
    }
    await api().get(base()).set(auth(outsideFaculty.id)).expect(403);
    await api().get(base('not-a-uuid')).set(auth(faculty.id)).expect(403);
  });

  it('audits every read with the students returned', async () => {
    await seedCohort();
    await assign();
    await summary();
    await dueList('?limit=5');
    const audit = await pool.query("SELECT action, actor_user_id, organization_id, outcome, context FROM audit_events WHERE action LIKE 'institution.learning_cohort.%' ORDER BY occurred_at, action");
    expect(audit.rows.map((row) => row.action).sort()).toEqual(['institution.learning_cohort.due_reviews_listed', 'institution.learning_cohort.read']);
    const read = audit.rows.find((row) => row.action === 'institution.learning_cohort.read');
    expect(read).toMatchObject({ actor_user_id: faculty.id, organization_id: institutionId, outcome: 'SUCCESS' });
    expect(read.context).toMatchObject({ block: 'SUMMARY', returned: 2, mode: 'ASSIGNMENTS' });
    expect([...read.context.studentUserIds].sort()).toEqual([s[0]!.userId, s[1]!.userId].sort());
    const listed = audit.rows.find((row) => row.action === 'institution.learning_cohort.due_reviews_listed');
    expect(listed.context).toMatchObject({ block: 'DUE_REVIEWS', returned: 2, page: 'FIRST' });
  });
});
