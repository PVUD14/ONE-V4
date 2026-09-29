/**
 * Cohort readiness by career role and preparation sprints (INST-17) on seeded, synthetic fixtures: one college with
 * two departments, a career role with two essential requirements and one important one, evidence dated last month,
 * published practice and a lesson on the first requirement, and a live campus drive whose job maps to the role.
 *
 * Acceptance: bands only — no numeric readiness anywhere; sprint progress reconciles with the engine's evidence.
 * Plus the Appendix 3 §6.3 minimum tests that apply: scope (a head sees their department; faculty 403; another
 * college 403), relationship (ended and not-yet-started relationships drop out of the month), contract (no number
 * about a student, no student named to staff), aggregates (cells under 5 withheld; one shared cohort total), API
 * (401, 403, 400, 409, audit rows), the time box, and the 0085 guard.
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
import { recomputeCareerGap } from '@planthepath/persistence/src/career-targets.js';
import { loadFacultyConstraints } from '@planthepath/persistence/src/faculty-learning-actions.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { shareCohortTotal } from './institution-cohort-readiness.controller.js';
import { suppressAggregateTable } from '@planthepath/authorization/src/index.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for cohort readiness tests');
const schemaName = 'cohortrole_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const persistence = db as unknown as PersistenceDb;
const tokens = new Set<string>();
const SHA = 'e'.repeat(64);
let app: INestApplication;

let institutionId: string; let otherInstitutionId: string;
let deptA: string; let deptB: string; let batchA: string;
let owner: Staff; let admin: Staff; let tpo: Staff; let otherTpo: Staff; let headA: Staff; let unscopedHead: Staff; let faculty: Staff; let otherAdmin: Staff;
let author: string; let sourceRecordId: string;
let roleId: string; let otherRoleId: string; let topicA: string; let topicB: string; let topicC: string; let lessonA: string;
let employerId: string; let driveId: string;
// Department A: 20 students (topic A: 5 met, 5 partly, 5 missing, 3 too little evidence, 2 none; topic B: first 10 met).
let a: Student[];
// Department B: 3 students with no evidence (one of them gets evidence this month).
let b: Student[];
let ended: Student; let joinedThisMonth: Student;

interface Student { userId: string; profileId: string; name: string; roll: string }
interface Staff { id: string; membershipId: string }

/** A moment in the middle of the last whole calendar month (UTC), and that month as YYYY-MM. */
function lastMonth(): { at: string; month: string } {
  const now = new Date();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10, 12));
  return { at: at.toISOString(), month: at.toISOString().slice(0, 7) };
}

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
  await pool.query('TRUNCATE career_roles CASCADE');
  tokens.clear();
  institutionId = randomUUID(); otherInstitutionId = randomUUID();
  deptA = randomUUID(); deptB = randomUUID(); batchA = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Synthetic college'), ($2,'INSTITUTION','Other synthetic college')", [institutionId, otherInstitutionId]);
  await unit(deptA, 'DEPARTMENT', 'Department A', null);
  await unit(batchA, 'BATCH', 'Batch A 2026', deptA);
  await unit(deptB, 'DEPARTMENT', 'Department B', null);
  owner = await staff('INSTITUTION_OWNER');
  admin = await staff('INSTITUTION_ADMIN');
  tpo = await staff('PLACEMENT_ADMIN');
  otherTpo = await staff('PLACEMENT_ADMIN');
  headA = await staff('DEPARTMENT_HEAD', deptA);
  unscopedHead = await staff('DEPARTMENT_HEAD');
  faculty = await staff('FACULTY_LECTURER', deptA);
  otherAdmin = await staff('INSTITUTION_ADMIN', null, otherInstitutionId);

  author = await plainUser();
  await seedSourceRecord();
  topicA = await topic('Synthetic log triage');
  topicB = await topic('Synthetic network basics');
  topicC = await topic('Synthetic scripting');
  await publishQuestions(topicA, 2);
  lessonA = await lesson(topicA, 'Reading an alert');
  roleId = await careerRole('SYN_SOC', 'Synthetic SOC Analyst L1');
  otherRoleId = await careerRole('SYN_OTHER', 'Synthetic Other Role');
  await requirement(roleId, topicA, 'ESSENTIAL', 0.7);
  await requirement(roleId, topicB, 'ESSENTIAL', 0.7);
  await requirement(roleId, topicC, 'IMPORTANT', 0.5);

  const { at } = lastMonth();
  a = [];
  for (let index = 0; index < 20; index += 1) a.push(await student(`A-${index + 1}`, `Student A${index + 1}`, deptA, batchA));
  for (const [index, learner] of a.entries()) {
    if (index < 5) await evidencePair(learner, topicA, 9, at);        // MET
    else if (index < 10) await evidencePair(learner, topicA, 5, at);  // PARTIAL (0.5 of a 0.7 target)
    else if (index < 15) await evidencePair(learner, topicA, 2, at);  // MISSING
    else if (index < 18) await evidence(learner, topicA, 9, at);      // one record: too little evidence
    if (index < 10) await evidencePair(learner, topicB, 10, at);      // MET on B
  }
  b = [];
  for (let index = 0; index < 3; index += 1) b.push(await student(`B-${index + 1}`, `Student B${index + 1}`, deptB, null));
  // Evidence this month is outside last month's view.
  await evidence(b[0]!, topicA, 9, new Date().toISOString());
  // Relationship ended before the month's end: out of the month. Joined after it: out of the month.
  ended = await student('A-ENDED', 'Student Ended', deptA, batchA, 'ENDED');
  await evidencePair(ended, topicA, 9, at);
  joinedThisMonth = await student('A-NEW', 'Student New', deptA, batchA, 'ACTIVE', "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");

  employerId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'EMPLOYER','Synthetic Employer','VERIFIED',true)", [employerId]);
  driveId = await drive(roleId, 'Synthetic SOC trainee');
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
async function student(roll: string, fullName: string, department: string, batch: string | null, state = 'ACTIVE', from = "now() - interval '120 days'", effectiveTo: string | null = null): Promise<Student> {
  const userId = randomUUID(); const profileId = randomUUID();
  tokens.add(userId);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [userId, userId + '@example.test']);
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id,batch_unit_id)
    VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7)`, [profileId, institutionId, userId, roll, fullName, department, batch]);
  const endedAt = state === 'ENDED' ? "now() - interval '60 days'" : effectiveTo;
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to)
    VALUES ($1,$2,$3,$4,${from},${endedAt ?? 'NULL'})`, [randomUUID(), institutionId, userId, state]);
  return { userId, profileId, name: fullName, roll };
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
async function careerRole(code: string, title: string): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO career_roles (id, code, title, family) VALUES ($1,$2,$3,'Synthetic')", [id, code, title]);
  return id;
}
async function requirement(role: string, topicId: string, level: string, target: number): Promise<void> {
  await pool.query('INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), role, topicId, level, target]);
}
async function evidence(learner: Student, topicId: string, demonstrated: number, at: string, possible = 10): Promise<void> {
  await pool.query(`INSERT INTO evidence_records (id, subject_user_id, evidence_type, topic_id, demonstrated, possible, source_aggregate_type,
      source_aggregate_id, content_version, provenance, occurred_at)
    VALUES ($1,$2,'TOPIC_DEMONSTRATION',$3,$4,$5,'inst17-test',$6,'inst17-v1','{}'::jsonb,$7)`,
  [randomUUID(), learner.userId, topicId, demonstrated, possible, randomUUID(), at]);
}
async function evidencePair(learner: Student, topicId: string, demonstrated: number, at: string): Promise<void> {
  await evidence(learner, topicId, demonstrated, at);
  await evidence(learner, topicId, demonstrated, at);
}
async function seedSourceRecord(): Promise<void> {
  const [runId, packageId] = [randomUUID(), randomUUID()];
  sourceRecordId = randomUUID();
  await pool.query(`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES ($1, $2, 'synthetic/inst-17', $3, $4, 'inst17-test', 'STAGED', $5, now())`, [runId, `inst17-${runId}`, 'c'.repeat(40), SHA, author]);
  await pool.query(`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES ($1, $2, $3, 'synthetic/inst-17', $4, $5, 'inst17-test', '[]', '{}', '{}')`, [packageId, runId, `inst17-${packageId}`, 'c'.repeat(40), SHA]);
  await pool.query(`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES ($1, $2, 'ENGINE_CONTENT', 'inst17', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
  [sourceRecordId, packageId, SHA]);
}
async function topic(name: string): Promise<string> {
  const [topicId, revision] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'Synthetic topic for INST-17 tests', $4)`, [topicId, `inst17-${topicId}`, name, revision]);
  return topicId;
}
async function manifest(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1, $2, 1, $3, 'DRAFT')`,
    [id, `inst17-${id}`, id.replace(/-/g, '').repeat(2)]);
  return id;
}
async function revision(manifestId: string, entityType: string, entityId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, $2, $3, 1, $4, 'DRAFT', $5, '{}')`, [id, entityType, entityId, author, SHA]);
  await pool.query('INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1, $2, $3, $4)',
    [manifestId, id, sourceRecordId, SHA]);
  return id;
}
async function publish(manifestId: string): Promise<void> {
  await pool.query("UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = $2, approved_at = now() WHERE id = $1", [manifestId, author]);
  await pool.query("UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = $2, published_at = now() WHERE id = $1", [manifestId, author]);
}
async function publishQuestions(topicId: string, count: number): Promise<void> {
  const manifestId = await manifest();
  const made: { id: string; revision: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    made.push({ id, revision: await revision(manifestId, 'QUESTION', id) });
  }
  await publish(manifestId);
  for (const [index, question] of made.entries()) {
    const options = ['a', 'b', 'c'].map((option) => ({ id: option, text: `Synthetic option ${option}` }));
    await pool.query(`INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
      VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, now())`,
    [question.id, `inst17-q-${question.id}`, topicId, `Synthetic question ${index + 1}`, JSON.stringify(options), question.revision, manifestId]);
    await pool.query(`INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash) VALUES ($1, 'a', 'Synthetic explanation.', $2)`, [question.id, SHA]);
  }
}
async function lesson(topicId: string, title: string): Promise<string> {
  const manifestId = await manifest();
  const [moduleId, lessonId] = [randomUUID(), randomUUID()];
  const moduleRevision = await revision(manifestId, 'MODULE', moduleId);
  const lessonRevision = await revision(manifestId, 'LESSON', lessonId);
  await publish(manifestId);
  await pool.query(`INSERT INTO learning_modules (id, stable_key, version, title, description, content_revision_id, release_manifest_id, published_at)
    VALUES ($1, $2, 1, 'Synthetic module', 'Synthetic', $3, $4, now())`, [moduleId, `inst17-m-${moduleId}`, moduleRevision, manifestId]);
  await pool.query(`INSERT INTO lesson_versions (id, module_id, stable_key, version, title, body, topic_id, content_revision_id, published_at)
    VALUES ($1, $2, $3, 1, $4, '{}', $5, $6, now())`, [lessonId, moduleId, `inst17-l-${lessonId}`, title, topicId, lessonRevision]);
  return lessonId;
}
async function drive(careerRoleId: string, title: string): Promise<string> {
  const [opportunity, version, id] = [randomUUID(), randomUUID(), randomUUID()];
  await pool.query('INSERT INTO opportunities (id,employer_id,created_by_user_id,reference_code) VALUES ($1,$2,$3,$4)', [opportunity, employerId, admin.id, 'LOCAL-' + opportunity.slice(0, 8)]);
  await pool.query("INSERT INTO opportunity_versions (id,opportunity_id,version_number,title,employment_type,work_mode,material_terms_hash,created_by_user_id,career_role_id) VALUES ($1,$2,1,$3,'FULL_TIME','REMOTE',$4,$5,$6)",
    [version, opportunity, title, '0'.repeat(64), admin.id, careerRoleId]);
  await pool.query('UPDATE opportunities SET current_version_id=$2 WHERE id=$1', [opportunity, version]);
  await pool.query(`INSERT INTO campus_drives (id,employer_id,opportunity_id,institution_id,requested_by_user_id,state,decided_by_user_id,decided_at)
    VALUES ($1,$2,$3,$4,$5,'APPROVED',$5,now())`, [id, employerId, opportunity, institutionId, admin.id]);
  return id;
}

const api = () => request(app.getHttpServer());
const path = (suffix: string, institution = institutionId) => '/api/v1/institutions/' + institution + suffix;
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': 'inst17-' + randomUUID() });
const practiceA = () => ({ kind: 'PRACTICE', skillId: topicA });
type Cell = { key: string; count: number | null; suppressed: boolean };
const cellsOf = (requirement: { cells: Cell[] }) => Object.fromEntries(requirement.cells.map((cell) => [cell.key, cell.suppressed ? '<5' : cell.count]));

async function view(actor: Staff, query = '', status = 200) {
  return (await api().get(path('/cohort-readiness?careerRoleId=' + roleId + query)).set(auth(actor.id)).expect(status)).body;
}
async function sprint(body: Record<string, unknown>, actor: Staff = tpo, status = 201) {
  return (await api().post(path('/preparation-sprints')).set(auth(actor.id)).send(body).expect(status)).body;
}
const sprintBody = (extra: Record<string, unknown> = {}) => ({
  careerRoleId: roleId, topicId: topicA, resource: practiceA(), durationDays: 14, includeUnknown: false, reasonCode: 'CAMPUS_DRIVE_PREPARATION', ...extra,
});
async function reachedBy(sprintId: string): Promise<string[]> {
  return (await pool.query(`SELECT las.student_user_id::text AS id FROM preparation_sprints ps
    JOIN learning_assignment_students las ON las.assignment_id = ps.assignment_id WHERE ps.id = $1 ORDER BY 1`, [sprintId])).rows.map((row) => row.id);
}
/** A sprint made directly in the database, `daysAgo` days in the past, as if the office had run it then. */
async function pastSprint(learners: Student[], daysAgo: number, days: number, resource: 'PRACTICE' | 'LESSON' = 'PRACTICE'): Promise<string> {
  const [assignmentId, sprintId] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO learning_assignments (id, institution_id, assigned_by_user_id, assigned_by_membership_id, content_kind, skill_id, lesson_version_id, target_kind, assigned_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'STUDENTS', now() - make_interval(days => $8::int))`,
  [assignmentId, institutionId, tpo.id, tpo.membershipId, resource, topicA, resource === 'LESSON' ? lessonA : null, daysAgo]);
  for (const learner of learners) await pool.query('INSERT INTO learning_assignment_students (assignment_id, student_user_id, institution_id) VALUES ($1,$2,$3)', [assignmentId, learner.userId, institutionId]);
  await pool.query(`INSERT INTO preparation_sprints (id, institution_id, assignment_id, career_role_id, topic_id, include_unknown, created_by_user_id, created_by_membership_id, reason_code, starts_at, ends_at)
    SELECT $1, $2, a.id, $3, $4, false, $5, $6, 'ESSENTIAL_GAP', a.assigned_at, a.assigned_at + make_interval(days => $7::int) FROM learning_assignments a WHERE a.id = $8`,
  [sprintId, institutionId, roleId, topicA, tpo.id, tpo.membershipId, days, assignmentId]);
  return sprintId;
}
/** Every number in a response, by key path — a response may carry counts of people and nothing else numeric. */
function numericKeys(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => numericKeys(item, prefix));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => numericKeys(item, key));
  return typeof value === 'number' ? [prefix] : [];
}

describe('INST-17 cohort readiness by career role', () => {
  it('shows bands, gaps and unknowns per essential requirement for last month, withholding cells under 5 and the shared total', async () => {
    const body = await view(tpo);
    expect(body.period.month).toBe(lastMonth().month);
    expect(body.requirementCounts).toEqual({ essential: 2, other: 1 });
    expect(body.requirements.map((requirement: { skillName: string }) => requirement.skillName)).toEqual(['Synthetic log triage', 'Synthetic network basics']);
    const [reqA, reqB] = body.requirements;
    // Whole college last month: department A's 20 and department B's 3; the ended student and the newcomer are out,
    // and B1's evidence this month does not count.
    expect(cellsOf(reqA)).toEqual({ MET: 5, PARTIAL: 5, MISSING: 5, NOT_ENOUGH_EVIDENCE: '<5', NO_EVIDENCE: 5 });
    expect(reqA.gaps).toEqual({ suppressed: false, count: 10 });
    expect(reqA.unknowns).toEqual({ suppressed: true, count: null });
    expect(cellsOf(reqB)).toEqual({ MET: 10, PARTIAL: '<5', MISSING: '<5', NOT_ENOUGH_EVIDENCE: '<5', NO_EVIDENCE: 13 });
    // Requirement A's withheld cells hold 3 people, so the cohort total (23) would give them back: withheld everywhere.
    expect(body.cohort).toEqual({ suppressed: false, total: { suppressed: true, count: null } });
    expect(reqA.resources.map((resource: { kind: string; title: string }) => `${resource.kind}:${resource.title}`)).toEqual(['PRACTICE:Synthetic log triage', 'LESSON:Reading an alert']);
    expect(body.canRunSprints).toBe(true);
    const audit = await pool.query("SELECT context FROM audit_events WHERE action = 'institution.cohort_readiness.read' AND actor_user_id = $1", [tpo.id]);
    expect(audit.rows).toHaveLength(1);
  });

  it('reconciles with every student’s own gap: the same functions, the same evidence', async () => {
    const body = await view(headA);
    const counts: Record<string, number> = {};
    for (const learner of a) {
      await recomputeCareerGap(pool, { subjectUserId: learner.userId, careerRoleId: roleId });
      const { rows } = await pool.query(`SELECT i.status FROM career_gap_items i JOIN career_gap_snapshots s ON s.id = i.snapshot_id
        WHERE s.student_user_id = $1 AND s.career_role_id = $2 AND s.superseded_at IS NULL AND i.topic_id = $3`, [learner.userId, roleId, topicA]);
      counts[rows[0].status] = (counts[rows[0].status] ?? 0) + 1;
    }
    const cells = cellsOf(body.requirements[0]);
    expect({ MET: cells.MET, PARTIAL: cells.PARTIAL, MISSING: cells.MISSING }).toEqual({ MET: counts.MET, PARTIAL: counts.PARTIAL, MISSING: counts.MISSING });
    expect(counts.UNKNOWN).toBe(5);
    // Requirement A alone could publish 20 (its withheld cells hold 5), but requirement B has empty cells (zero is
    // under 5), so the shared total is withheld from both.
    expect(body.cohort.total).toEqual({ suppressed: true, count: null });
    expect(cellsOf(body.requirements[1])).toEqual({ MET: 10, PARTIAL: '<5', MISSING: '<5', NOT_ENOUGH_EVIDENCE: '<5', NO_EVIDENCE: 10 });
    expect(body.scope.kind).toBe('UNITS');
  });

  it('never publishes a number about a student, a target or a ratio, and never names a student', async () => {
    const bodies = [await view(tpo), await view(headA), (await api().get(path('/cohort-readiness/roles')).set(auth(tpo.id)).expect(200)).body];
    const created = await sprint(sprintBody());
    bodies.push(created, (await api().get(path('/preparation-sprints')).set(auth(tpo.id)).expect(200)).body);
    for (const body of bodies) {
      for (const key of numericKeys(body)) expect(['count', 'essentialRequirements', 'otherRequirements', 'essential', 'other', 'min', 'max']).toContain(key);
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/"(score|ratio|mastery\w*|percent\w*|observed\w*|target\w*|readiness\w*|band|compensation\w*)"\s*:/i);
      for (const learner of [...a, ...b]) {
        expect(text).not.toContain(learner.userId);
        expect(text).not.toContain(learner.profileId);
        expect(text).not.toContain(learner.name);
      }
    }
  });

  it('lists catalogue roles and the roles behind live campus drives', async () => {
    const body = (await api().get(path('/cohort-readiness/roles')).set(auth(headA.id)).expect(200)).body;
    const soc = body.roles.find((role: { id: string }) => role.id === roleId);
    expect(soc).toMatchObject({ title: 'Synthetic SOC Analyst L1', essentialRequirements: 2, otherRequirements: 1 });
    expect(body.roles.find((role: { id: string }) => role.id === otherRoleId)).toMatchObject({ essentialRequirements: 0 });
    expect(body.drives).toEqual([expect.objectContaining({ driveId, employerName: 'Synthetic Employer', jobTitle: 'Synthetic SOC trainee', careerRoleId: roleId })]);
  });

  it('refuses faculty, another college, no token, a month that has not ended and an unknown role', async () => {
    await api().get(path('/cohort-readiness?careerRoleId=' + roleId)).expect(401);
    await view(faculty, '', 403);
    await api().get(path('/cohort-readiness?careerRoleId=' + roleId)).set(auth(otherAdmin.id)).expect(403);
    await api().get(path('/preparation-sprints')).set(auth(faculty.id)).expect(403);
    const thisMonth = new Date().toISOString().slice(0, 7);
    expect((await view(tpo, '&month=' + thisMonth, 400)).error.code).toBe('REPORT_PERIOD_INVALID');
    await view(tpo, '&month=2026-13', 400);
    await api().get(path('/cohort-readiness?careerRoleId=' + randomUUID())).set(auth(tpo.id)).expect(404);
    await api().get(path('/cohort-readiness?careerRoleId=nope')).set(auth(tpo.id)).expect(400);
  });

  it('a withheld total in one table is withheld from every table of the view', () => {
    const tables = [
      suppressAggregateTable([{ key: 'X', count: 10 }, { key: 'Y', count: 2 }]),
      suppressAggregateTable([{ key: 'X', count: 6 }, { key: 'Y', count: 6 }]),
    ];
    expect(tables[1]!.total.suppressed).toBe(false);
    const shared = shareCohortTotal(tables, 12);
    expect(shared.total.suppressed).toBe(true);
    expect(shared.tables.every((table) => table.total.suppressed)).toBe(true);
    expect(shareCohortTotal(tables, 4).suppressed).toBe(true);
  });
});

describe('INST-17 preparation sprints', () => {
  it('J11: reaches only students with a gap now, as an INST-16 assignment the planner honours, and names nobody', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM evidence_records');
    const body = await sprint(sprintBody({ campusDriveId: driveId, note: 'Before the Synthetic Employer drive' }));
    expect(body.sprint.reached).toEqual({ suppressed: false, count: 10 });
    const reached = await reachedBy(body.sprint.id);
    expect(reached).toEqual(a.slice(5, 15).map((learner) => learner.userId).sort());
    expect(Date.parse(body.sprint.endsAt) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    // The planner's constraint and the student's own view.
    const constraints = await loadFacultyConstraints(persistence, a[5]!.userId);
    expect(constraints.assignments).toEqual([expect.objectContaining({ skillId: topicA })]);
    expect((await loadFacultyConstraints(persistence, a[0]!.userId)).assignments).toEqual([]);
    const mine = (await api().get('/api/v1/students/me/learning-actions').set(auth(a[5]!.userId)).expect(200)).body;
    expect(mine.assignments).toEqual([expect.objectContaining({ title: 'Synthetic log triage', status: 'OPEN', sprint: { endsAt: body.sprint.endsAt } })]);
    const notices = await pool.query("SELECT count(*)::int AS n FROM user_notifications WHERE kind = 'SYSTEM' AND title = 'Preparation sprint from your college'");
    expect(notices.rows[0].n).toBe(10);
    // Audited with the students; no evidence written.
    const audit = await pool.query("SELECT context FROM audit_events WHERE action = 'preparation_sprint.created' AND resource_id = $1", [body.sprint.id]);
    expect(audit.rows[0].context.studentUserIds.sort()).toEqual(reached);
    expect(audit.rows[0].context.campusDriveId).toBe(driveId);
    expect((await pool.query('SELECT count(*)::int AS n FROM evidence_records')).rows[0].n).toBe(before.rows[0].n);
    expect((await pool.query('SELECT count(*)::int AS n FROM readiness_snapshots')).rows[0].n).toBe(0);
  });

  it('includes students with no or too little evidence only when asked, and stays inside the write scope', async () => {
    const wide = await sprint(sprintBody({ includeUnknown: true, reasonCode: 'PLACEMENT_SEASON' }));
    // 10 with gaps + 3 too little + 2 none in A, the newcomer, and B's three (B1's single record is too little evidence).
    expect(wide.sprint.reached).toEqual({ suppressed: false, count: 19 });
    expect(await reachedBy(wide.sprint.id)).not.toContain(ended.userId);
    const head = await sprint(sprintBody({ includeUnknown: true, reasonCode: 'ESSENTIAL_GAP' }), headA);
    const byHead = await reachedBy(head.sprint.id);
    expect(byHead).toHaveLength(16);
    expect(byHead.some((id) => b.some((learner) => learner.userId === id))).toBe(false);
    // Narrowed to a unit: department B has no gaps (unknowns are not asked for) — nothing to run.
    const none = await sprint(sprintBody({ unitId: deptB }), tpo, 409);
    expect(none.error.code).toBe('NO_STUDENTS_WITH_GAPS');
    expect((await sprint(sprintBody(), unscopedHead, 403)).error.code).toBe('SCOPE_REQUIRED');
    await sprint(sprintBody(), faculty, 403);
    await api().post(path('/preparation-sprints', otherInstitutionId)).set(auth(tpo.id)).send(sprintBody()).expect(403);
    await api().post(path('/preparation-sprints')).send(sprintBody()).expect(401);
  });

  it('validates the request', async () => {
    await sprint(sprintBody({ extra: true }), tpo, 400);
    await sprint(sprintBody({ durationDays: 6 }), tpo, 400);
    await sprint(sprintBody({ durationDays: 43 }), tpo, 400);
    await sprint(sprintBody({ includeUnknown: 'yes' }), tpo, 400);
    expect((await sprint(sprintBody({ reasonCode: 'BECAUSE' }), tpo, 400)).error.code).toBe('INVALID_REASON_CODE');
    expect((await sprint(sprintBody({ topicId: topicC, resource: { kind: 'PRACTICE', skillId: topicC } }), tpo, 400)).error.code).toBe('NOT_AN_ESSENTIAL_REQUIREMENT');
    expect((await sprint(sprintBody({ topicId: topicB, resource: { kind: 'PRACTICE', skillId: topicB } }), tpo, 400)).error.code).toBe('CONTENT_NOT_PUBLISHED');
    await sprint(sprintBody({ resource: { kind: 'PRACTICE', skillId: topicB } }), tpo, 400);
    expect((await sprint(sprintBody({ careerRoleId: otherRoleId, campusDriveId: driveId }), tpo, 400)).error.code).toBe('NOT_AN_ESSENTIAL_REQUIREMENT');
    await requirement(otherRoleId, topicA, 'ESSENTIAL', 0.7);
    expect((await sprint(sprintBody({ careerRoleId: otherRoleId, campusDriveId: driveId }), tpo, 400)).error.code).toBe('DRIVE_ROLE_MISMATCH');
    await sprint(sprintBody({ unitId: randomUUID() }), tpo, 400);
    await sprint(sprintBody({ note: 'x'.repeat(501) }), tpo, 400);
  });

  it('progress reconciles with the evidence: met, new evidence, or nothing new, at the start-of-day cut-off', async () => {
    const reachedLearners = a.slice(5, 15);
    const sprintId = await pastSprint(reachedLearners, 3, 14);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    // The five who were partly there reach the target; the five who were well short show new evidence only.
    for (const learner of a.slice(5, 10)) await evidencePair(learner, topicA, 10, twoDaysAgo);
    for (const learner of a.slice(10, 15)) await evidence(learner, topicA, 1, twoDaysAgo);
    // Evidence after the cut-off (today) is not counted yet.
    await evidencePair(a[10]!, topicA, 10, new Date().toISOString());
    const list = (await api().get(path('/preparation-sprints')).set(auth(tpo.id)).expect(200)).body;
    const item = list.sprints.find((entry: { id: string }) => entry.id === sprintId);
    expect(item).toMatchObject({ state: 'RUNNING', skillName: 'Synthetic log triage', role: { id: roleId }, startedByYou: true, canEnd: true });
    expect(item.progress.available).toBe(true);
    expect(cellsOf(item.progress)).toEqual({ MET: 5, NEW_EVIDENCE: 5, NO_NEW_EVIDENCE: '<5' });
    // Direct recomputation from the evidence before the cut-off gives the same MET count.
    const cutoff = item.progress.cutoff as string;
    let met = 0;
    for (const learner of reachedLearners) {
      const { rows } = await pool.query('SELECT demonstrated, possible FROM evidence_records WHERE subject_user_id = $1 AND topic_id = $2 AND occurred_at < $3', [learner.userId, topicA, cutoff]);
      const ratio = rows.reduce((sum, row) => sum + row.demonstrated, 0) / rows.reduce((sum, row) => sum + row.possible, 0);
      if (rows.length >= 2 && ratio >= 0.7) met += 1;
    }
    expect(met).toBe(5);
    // The head sees the same sprint over their department (all ten are in A).
    const head = (await api().get(path('/preparation-sprints')).set(auth(headA.id)).expect(200)).body;
    expect(cellsOf(head.sprints[0].progress)).toEqual({ MET: 5, NEW_EVIDENCE: 5, NO_NEW_EVIDENCE: '<5' });
    expect(head.sprints[0].canEnd).toBe(false);
    const audit = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'institution.preparation_sprints.read'");
    expect(audit.rows[0].n).toBe(2);
  });

  it('counts lesson work done before the cut-off, suppressed under 5', async () => {
    const sprintId = await pastSprint(a.slice(0, 15), 4, 14, 'LESSON');
    const done = new Date(Date.now() - 2 * 86_400_000).toISOString();
    for (const learner of a.slice(0, 6)) {
      await pool.query(`INSERT INTO learner_progress (id, subject_user_id, lesson_version_id, state, started_at, completed_at, last_correlation_id)
        VALUES ($1,$2,$3,'COMPLETED',$4,$4,'inst17-lesson-done')`, [randomUUID(), learner.userId, lessonA, done]);
    }
    const list = (await api().get(path('/preparation-sprints')).set(auth(admin.id)).expect(200)).body;
    const item = list.sprints.find((entry: { id: string }) => entry.id === sprintId);
    expect(item.progress.workDone).toEqual({ suppressed: false, count: 6 });
    expect(item.resource).toEqual({ kind: 'LESSON', title: 'Reading an alert' });
  });

  it('a sprint ends at its time box: no longer a constraint, no longer open work, progress fixed at the end', async () => {
    const sprintId = await pastSprint(a.slice(5, 10), 10, 7);
    expect((await loadFacultyConstraints(persistence, a[5]!.userId)).assignments).toEqual([]);
    const mine = (await api().get('/api/v1/students/me/learning-actions').set(auth(a[5]!.userId)).expect(200)).body;
    expect(mine.assignments).toEqual([]);
    const list = (await api().get(path('/preparation-sprints')).set(auth(tpo.id)).expect(200)).body;
    const item = list.sprints.find((entry: { id: string }) => entry.id === sprintId);
    expect(item.state).toBe('ENDED');
    expect(item.canEnd).toBe(false);
    expect(Date.parse(item.progress.cutoff)).toBe(Date.parse(item.endsAt));
  });

  it('ends early: the creator or an admin, with a reason; the assignment is withdrawn with it', async () => {
    const created = await sprint(sprintBody());
    const id = created.sprint.id;
    expect((await api().post(path('/preparation-sprints/' + id + '/cancel')).set(auth(otherTpo.id)).send({ reasonCode: 'SET_IN_ERROR' }).expect(403)).body.error.code).toBe('NOT_SPRINT_OWNER');
    await api().post(path('/preparation-sprints/' + id + '/cancel')).set(auth(tpo.id)).send({ reasonCode: 'NOPE' }).expect(400);
    await api().post(path('/preparation-sprints/' + id + '/cancel')).set(auth(owner.id)).send({ reasonCode: 'SET_IN_ERROR' }).expect(201);
    expect((await api().post(path('/preparation-sprints/' + id + '/cancel')).set(auth(tpo.id)).send({ reasonCode: 'SET_IN_ERROR' }).expect(409)).body.error.code).toBe('SPRINT_NOT_RUNNING');
    const { rows } = await pool.query('SELECT a.withdrawn_at IS NOT NULL AS withdrawn, a.withdraw_reason_code FROM preparation_sprints ps JOIN learning_assignments a ON a.id = ps.assignment_id WHERE ps.id = $1', [id]);
    expect(rows[0]).toEqual({ withdrawn: true, withdraw_reason_code: 'SET_IN_ERROR' });
    expect((await loadFacultyConstraints(persistence, a[5]!.userId)).assignments).toEqual([]);
    const audit = await pool.query("SELECT context FROM audit_events WHERE action = 'preparation_sprint.cancelled' AND resource_id = $1", [id]);
    expect(audit.rows[0].context.reasonCode).toBe('SET_IN_ERROR');
    await api().post(path('/preparation-sprints/' + randomUUID() + '/cancel')).set(auth(tpo.id)).send({ reasonCode: 'SET_IN_ERROR' }).expect(404);
  });

  it('the 0085 guard: a sprint cannot be re-dated, deleted, or attached to another college’s assignment', async () => {
    const created = await sprint(sprintBody());
    await expect(pool.query("UPDATE preparation_sprints SET ends_at = ends_at + interval '1 day' WHERE id = $1", [created.sprint.id])).rejects.toThrow(/only a running sprint/);
    await expect(pool.query('DELETE FROM preparation_sprints WHERE id = $1', [created.sprint.id])).rejects.toThrow(/never deleted/);
    const [assignmentId] = [randomUUID()];
    await pool.query(`INSERT INTO learning_assignments (id, institution_id, assigned_by_user_id, assigned_by_membership_id, content_kind, skill_id, target_kind)
      VALUES ($1,$2,$3,$4,'PRACTICE',$5,'STUDENTS')`, [assignmentId, institutionId, tpo.id, tpo.membershipId, topicA]);
    await expect(pool.query(`INSERT INTO preparation_sprints (id, institution_id, assignment_id, career_role_id, topic_id, include_unknown, created_by_user_id, created_by_membership_id, reason_code, starts_at, ends_at)
      SELECT $1, $2, a.id, $3, $4, false, $5, $6, 'ESSENTIAL_GAP', a.assigned_at, a.assigned_at + interval '14 days' FROM learning_assignments a WHERE a.id = $7`,
    [randomUUID(), otherInstitutionId, roleId, topicA, tpo.id, tpo.membershipId, assignmentId])).rejects.toThrow(/same college/);
    await expect(pool.query(`INSERT INTO preparation_sprints (id, institution_id, assignment_id, career_role_id, topic_id, include_unknown, created_by_user_id, created_by_membership_id, reason_code, starts_at, ends_at)
      SELECT $1, $2, a.id, $3, $4, false, $5, $6, 'ESSENTIAL_GAP', a.assigned_at, a.assigned_at + interval '60 days' FROM learning_assignments a WHERE a.id = $7`,
    [randomUUID(), institutionId, roleId, topicA, tpo.id, tpo.membershipId, assignmentId])).rejects.toThrow(/preparation_sprints_window_ck/);
  });
});
