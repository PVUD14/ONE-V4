/**
 * A college's data-processing terms, exit export and offboarding (INST-18).
 *
 * Pins the goal's acceptance — offboarding is reversible until the retention period ends; student-owned
 * data is untouched by offboarding — and the runbook's dry run on seeded data, plus the rules around
 * them: terms are versioned, immutable, labelled with their legal-review state, accepted only by an
 * owner, gate rostering and are never retroactive; the exit export is owner-only, open only during a
 * notice, audited before send, formula-safe, and never carries a counselling note unless the owner asks
 * for it with a listed reason; the purge needs the retention period to have passed, an OPS-02
 * approval from a second person, and no legal hold, deletes exactly the institution-owned tables, and
 * leaves every other college and every student-owned record alone.
 *
 * Runs over real HTTP with a stub verifier in a throwaway schema of the local Postgres in DATABASE_URL.
 * The tests share one schema and run in order: terms are global, and the first test runs before any
 * version exists. Time is moved by backdating an exit with its trigger disabled (only the table owner can).
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
import { institutionPurgeKept, institutionPurgeOutOfScope, institutionPurgePlan } from '@planthepath/persistence/src/institution-contract.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { InstitutionContractController } from './institution-contract.controller.js';
import { OperationsInstitutionExitsController } from './operations-institution-exits.controller.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for institution contract lifecycle tests');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Institution contract lifecycle tests require local Postgres');
const schemaName = 'inst_contract_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const SHA = 'a'.repeat(64);
let app: INestApplication;
let platformId: string;
let operatorId: string;
let secondOperatorId: string;
let approverId: string;

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
    controllers: [InstitutionContractController, OperationsInstitutionExitsController],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  await app.init();
  platformId = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  operatorId = await platformMember('OPERATIONS_ADMIN');
  secondOperatorId = await platformMember('OPERATIONS_ADMIN');
  approverId = await platformMember('PLATFORM_SUPER_ADMIN');
}, 180_000);
afterAll(async () => {
  await app?.close(); await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function user(state = 'ACTIVE', label = 'person'): Promise<string> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query('INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,$3)', [id, `${label}-${id.slice(0, 8)}@example.test`, state]);
  return id;
}
async function platformMember(role: string): Promise<string> {
  const id = await user();
  await pool.query('INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id) VALUES ($1,$2,$3,$4,\'ACTIVE\',$2)', [randomUUID(), platformId, id, role]);
  return id;
}
interface Staff { readonly id: string; readonly membershipId: string }
async function staff(institutionId: string, role: string, department: string | null = null): Promise<Staff> {
  const id = await user('ACTIVE', role.toLowerCase());
  const membershipId = randomUUID();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id,scope_department_unit_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,$2,$5)`, [membershipId, institutionId, id, role, department]);
  return { id, membershipId };
}
interface Student { readonly userId: string; readonly profileId: string; readonly relationshipId: string }
async function student(institutionId: string, roll: string, fullName: string, department: string | null, relationship = 'ACTIVE', userState = 'ACTIVE'): Promise<Student> {
  const userId = await user(userState, 'student');
  const profileId = randomUUID(); const relationshipId = randomUUID();
  const status = relationship === 'GRADUATED' ? 'GRADUATED' : userState === 'INVITED' ? 'INVITED' : 'ACTIVE';
  await pool.query(`INSERT INTO institution_student_profiles (id,institution_id,student_user_id,institution_student_id,full_name,status,department_unit_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [profileId, institutionId, userId, roll, fullName, status, department]);
  await pool.query(`INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from,effective_to) VALUES ($1,$2,$3,$4,'2020-01-01T00:00:00Z',$5)`,
    [relationshipId, institutionId, userId, relationship, relationship === 'GRADUATED' ? '2025-06-01T00:00:00Z' : null]);
  return { userId, profileId, relationshipId };
}
async function topic(author: string): Promise<string> {
  const [topicId, revision] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1, 'TOPIC', $2, 1, 'Synthetic topic', 'Synthetic topic for INST-18 tests', $3)`, [topicId, `inst18-${topicId}`, revision]);
  return topicId;
}
/** Insert a row a guard would refuse to seed directly, with only that INSERT/UPDATE trigger off. */
async function seedPast(table: string, trigger: string, text: string, values: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await client.query(text, values);
  } finally {
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    client.release();
  }
}

interface College {
  readonly institutionId: string; readonly department: string; readonly batch: string;
  readonly owner: Staff; readonly admin: Staff; readonly faculty: Staff;
  readonly active: Student; readonly invited: Student; readonly graduate: Student;
  readonly assignmentId: string;
}

/** A college with a record in every institution-owned table the purge deletes, and student-owned records beside them. */
async function college(name: string): Promise<College> {
  const institutionId = randomUUID(); const department = randomUUID(); const batch = randomUUID(); const section = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name,verification_state,active) VALUES ($1,'INSTITUTION',$2,'VERIFIED',true)", [institutionId, name]);
  await pool.query(`INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$4,'DEPARTMENT','Mechanical',NULL),
    ($2,$4,'BATCH','Mechanical 2027',$1), ($3,$4,'SECTION','Section A',$2)`, [department, batch, section, institutionId]);
  const owner = await staff(institutionId, 'INSTITUTION_OWNER');
  const admin = await staff(institutionId, 'INSTITUTION_ADMIN');
  const faculty = await staff(institutionId, 'FACULTY_LECTURER', department);
  const active = await student(institutionId, 'ME-001', 'Asha Rao', department);
  const invited = await student(institutionId, 'ME-002', 'Bala Iyer', department, 'ACTIVE', 'INVITED');
  const graduate = await student(institutionId, 'ME-000', 'Chitra Nair', department, 'GRADUATED');
  await pool.query(`INSERT INTO invitations (id,email,token_hash,state,invited_by_user_id,organization_id,kind,student_user_id,expires_at)
    VALUES ($1,$2,$3,'PENDING',$4,$5,'STUDENT',$6, now() + interval '14 days')`, [randomUUID(), `invite-${invited.userId.slice(0, 8)}@example.test`, randomUUID().replaceAll('-', '') + 'x', admin.id, institutionId, invited.userId]);

  // Settings, calendar, grading scale.
  const programme = randomUUID();
  await pool.query("INSERT INTO institution_units (id,institution_id,kind,name,parent_unit_id) VALUES ($1,$2,'PROGRAM','BTech Mechanical',$3)", [programme, institutionId, department]);
  await pool.query('INSERT INTO institution_settings (institution_id, about_text, updated_by_user_id) VALUES ($1, $2, $3)', [institutionId, 'A college in the tests.', admin.id]);
  await pool.query("INSERT INTO institution_grading_scales (id,institution_id,program_unit_id,result_scale,created_by_user_id,updated_by_user_id) VALUES ($1,$2,$3,'CGPA_10',$4,$4)", [randomUUID(), institutionId, programme, admin.id]);
  await pool.query("INSERT INTO institution_academic_terms (id,institution_id,name,kind,starts_on,ends_on,created_by_user_id,updated_by_user_id) VALUES ($1,$2,'2026 Odd','TERM','2026-07-01','2026-11-30',$3,$3)", [randomUUID(), institutionId, admin.id]);

  // Assessment: subject, syllabus, question, definition, section, pool, assignment, attempt, answer, result.
  const subject = randomUUID(); const unitNode = randomUUID(); const question = randomUUID(); const definition = randomUUID();
  const examSection = randomUUID(); const assignment = randomUUID(); const attempt = randomUUID();
  await pool.query("INSERT INTO exam_subjects (id,institution_id,name,code) VALUES ($1,$2,'Thermodynamics','ME201')", [subject, institutionId]);
  await pool.query("INSERT INTO exam_syllabus_nodes (id,institution_id,subject_id,kind,name) VALUES ($1,$2,$3,'UNIT','Laws')", [unitNode, institutionId, subject]);
  await pool.query(`INSERT INTO exam_questions (id,institution_id,subject_id,unit_node_id,question_type,question_text,question_hash,approval_status,created_by_user_id)
    VALUES ($1,$2,$3,$4,'SINGLE_CHOICE_MCQ','What is conserved?','h1','APPROVED',$5)`, [question, institutionId, subject, unitNode, faculty.id]);
  await pool.query("INSERT INTO exam_question_options (id,question_id,option_key,option_text,is_correct) VALUES ($1,$2,'A','Energy',true)", [randomUUID(), question]);
  await pool.query("INSERT INTO exam_question_versions (id,question_id,version,snapshot,changed_by_user_id) VALUES ($1,$2,1,'{}',$3)", [randomUUID(), question, faculty.id]);
  await pool.query("INSERT INTO exam_question_reviews (id,question_id,reviewer_user_id,from_status,to_status) VALUES ($1,$2,$3,'UNDER_REVIEW','APPROVED')", [randomUUID(), question, admin.id]);
  await pool.query(`INSERT INTO exam_definitions (id,institution_id,subject_id,title,exam_kind,lifecycle_state,total_marks,duration_seconds,starts_at,ends_at,created_by_user_id,published_at)
    VALUES ($1,$2,$3,'Mid exam 1','MID_EXAM','PUBLISHED',10,1800,'2026-08-01T04:00:00Z','2026-08-01T06:00:00Z',$4,now())`, [definition, institutionId, subject, faculty.id]);
  await pool.query("INSERT INTO exam_definition_events (id,definition_id,actor_user_id,from_state,to_state) VALUES ($1,$2,$3,'DRAFT','PUBLISHED')", [randomUUID(), definition, admin.id]);
  await pool.query("INSERT INTO exam_sections (id,institution_id,definition_id,title,pool_size,display_count,marks_per_question) VALUES ($1,$2,$3,'Part A',1,1,10)", [examSection, institutionId, definition]);
  await pool.query('INSERT INTO exam_section_pool (section_id,question_id,institution_id,question_version) VALUES ($1,$2,$3,1)', [examSection, question, institutionId]);
  await pool.query('INSERT INTO exam_assignments (id,institution_id,definition_id,student_user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4,$5)', [assignment, institutionId, definition, active.userId, faculty.id]);
  await pool.query(`INSERT INTO exam_attempts (id,institution_id,definition_id,student_user_id,attempt_number,status,paper_seed,started_at,submitted_at)
    VALUES ($1,$2,$3,$4,1,'SUBMITTED','seed','2026-08-01T04:10:00Z','2026-08-01T04:40:00Z')`, [attempt, institutionId, definition, active.userId]);
  await pool.query("INSERT INTO exam_attempt_questions (id,attempt_id,section_id,question_id,position,option_map,marks) VALUES ($1,$2,$3,$4,1,'{}',10)", [randomUUID(), attempt, examSection, question]);
  await pool.query(`INSERT INTO exam_answers (id,attempt_id,question_id,response) VALUES ($1,$2,$3,'{"selected":["A"]}')`, [randomUUID(), attempt, question]);
  await pool.query(`INSERT INTO exam_results (id,attempt_id,score,max_score,percentage,correct_count,wrong_count,not_attempted_count,time_taken_seconds,published,created_at)
    VALUES ($1,$2,10,10,100,1,0,0,1800,true,'2026-08-01T04:40:00Z')`, [randomUUID(), attempt]);
  await pool.query("INSERT INTO exam_screen_events (id,attempt_id,level) VALUES ($1,$2,'INFO')", [randomUUID(), attempt]);
  await pool.query(`INSERT INTO faculty_teaching_assignments (id,institution_id,faculty_membership_id,unit_id,subject_id,academic_term,starts_on,assigned_by_user_id,reason_code)
    VALUES ($1,$2,$3,$4,$5,'2026 Odd','2026-07-01',$6,'TEACHING_LOAD')`, [randomUUID(), institutionId, faculty.membershipId, section, subject, admin.id]);

  // Staff actions: a formula-leading note, a meeting with an attendee and linked content, a counselling note.
  const [note, meeting, counselling] = [randomUUID(), randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO staff_actions (id,institution_id,subject_student_user_id,institution_relationship_id,actor_user_id,actor_membership_id,assigned_to_membership_id,
      department_unit_id,action_type,state,title,note,visibility,source_exam_assignment_id,updated_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'FACULTY_NOTE','OPEN','=HYPERLINK("http://x")','Needs help with entropy','STAFF_ONLY',$8,$5)`,
  [note, institutionId, active.userId, active.relationshipId, faculty.id, faculty.membershipId, department, assignment]);
  await pool.query(`INSERT INTO staff_actions (id,institution_id,actor_user_id,actor_membership_id,assigned_to_membership_id,department_unit_id,action_type,state,title,visibility,scheduled_start_at,scheduled_end_at,updated_by_user_id)
    VALUES ($1,$2,$3,$4,$4,$5,'MEETING','OPEN','Revision session','SUBJECT_VISIBLE','2026-09-01T04:00:00Z','2026-09-01T05:00:00Z',$3)`,
  [meeting, institutionId, faculty.id, faculty.membershipId, department]);
  await pool.query('INSERT INTO staff_action_attendees (staff_action_id,student_user_id,institution_id) VALUES ($1,$2,$3)', [meeting, active.userId, institutionId]);
  const skill = await topic(admin.id);
  await seedPast('staff_action_content_links', 'staff_action_content_links_guard',
    "INSERT INTO staff_action_content_links (staff_action_id,position,content_kind,skill_id) VALUES ($1,1,'PRACTICE',$2)", [meeting, skill]);
  await pool.query(`INSERT INTO staff_actions (id,institution_id,subject_student_user_id,institution_relationship_id,actor_user_id,actor_membership_id,assigned_to_membership_id,
      action_type,state,title,note,visibility,updated_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$6,'COUNSELLING_NOTE','OPEN','Check-in','COUNSELLING-TEXT-ONLY-FOR-OWNER','STAFF_ONLY',$5)`,
  [counselling, institutionId, active.userId, active.relationshipId, admin.id, admin.membershipId]);
  await pool.query(`INSERT INTO counselling_case_participants (id,institution_id,student_user_id,membership_id,added_by_user_id,added_by_membership_id,added_reason_code)
    VALUES ($1,$2,$3,$4,$5,$6,'CASE_SUPPORT')`, [randomUUID(), institutionId, active.userId, faculty.membershipId, admin.id, admin.membershipId]);

  // A lecturer's learning actions (0082): seeded past the publish guard, which is not what is under test.
  const learning = randomUUID();
  await seedPast('learning_assignments', 'learning_assignments_guard',
    `INSERT INTO learning_assignments (id,institution_id,assigned_by_user_id,assigned_by_membership_id,content_kind,skill_id,target_kind)
     VALUES ($1,$2,$3,$4,'PRACTICE',$5,'STUDENTS')`, [learning, institutionId, faculty.id, faculty.membershipId, skill]);
  await pool.query('INSERT INTO learning_assignment_students (assignment_id,student_user_id,institution_id) VALUES ($1,$2,$3)', [learning, active.userId, institutionId]);
  await seedPast('learning_plan_overrides', 'learning_plan_overrides_guard',
    `INSERT INTO learning_plan_overrides (id,institution_id,student_user_id,created_by_user_id,created_by_membership_id,action,content_kind,skill_id,reason_code)
     VALUES ($1,$2,$3,$4,$5,'PRACTICE','PRACTICE',$6,'CATCH_UP')`, [randomUUID(), institutionId, active.userId, faculty.id, faculty.membershipId, skill]);

  // Announcement with a recipient; a roster import with a row.
  const announcement = randomUUID();
  await pool.query(`INSERT INTO institution_announcements (id,institution_id,sender_user_id,sender_membership_id,sender_role,audience_kind,title,body,channels,email_template_key,email_template_version,state,scheduled_for,sent_at,recipient_count)
    VALUES ($1,$2,$3,$4,'INSTITUTION_ADMIN','INSTITUTION','Exams','Exams start Monday.',ARRAY['IN_APP'],'institution-announcement',1,'SENT',now(),now(),1)`, [announcement, institutionId, admin.id, admin.membershipId]);
  await pool.query("INSERT INTO institution_announcement_recipients (announcement_id,student_user_id,email_state) VALUES ($1,$2,'NOT_REQUESTED')", [announcement, active.userId]);
  const importId = randomUUID();
  await pool.query(`INSERT INTO student_roster_imports (id,institution_id,actor_user_id,state,source_filename,row_count,accepted_count,warning_count,rejected_count,correlation_id,committed_at)
    VALUES ($1,$2,$3,'COMMITTED','roster.csv',1,1,0,0,'inst18-seed',now())`, [importId, institutionId, admin.id]);
  await pool.query("INSERT INTO student_roster_import_rows (id,import_id,row_number,state,institution_student_id,full_name,created_profile_id) VALUES ($1,$2,1,'COMMITTED','ME-001','Asha Rao',$3)", [randomUUID(), importId, active.profileId]);

  // Verification decisions on a student's own record (0070), which stay the student's.
  const qualification = randomUUID();
  await pool.query(`INSERT INTO student_qualifications (id,student_user_id,institution_id,qualification_type,programme_name,verification_state,verified_by_user_id,verified_at)
    VALUES ($1,$2,$3,'BTECH','BTech Mechanical','VERIFIED',$4,now())`, [qualification, active.userId, institutionId, faculty.id]);
  await pool.query(`INSERT INTO student_academic_terms (id,qualification_id,sequence,label,result_value,result_scale,backlog_count,source,verification_state,verified_by_user_id,verified_at)
    VALUES ($1,$2,1,'Semester 1',8.2,'CGPA_10',0,'STUDENT_DECLARED','VERIFIED',$3,now())`, [randomUUID(), qualification, faculty.id]);
  // More of the student's own records: an external application and a notification.
  await pool.query("INSERT INTO external_applications (id,student_user_id,company_name,role_title,source_kind,applied_on) VALUES ($1,$2,'Acme','Engineer','JOB_BOARD','2026-08-01')", [randomUUID(), active.userId]);
  await pool.query("INSERT INTO user_notifications (id,user_id,kind,title,body) VALUES ($1,$2,'SYSTEM','Welcome','Welcome to ONE.')", [randomUUID(), active.userId]);
  return { institutionId, department, batch, owner, admin, faculty, active, invited, graduate, assignmentId: assignment };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const api = () => request(app.getHttpServer());
const auth = (id: string) => ({ Authorization: 'Bearer ' + id, 'X-Correlation-Id': 'inst18-' + randomUUID() });
const inst = (id: string) => '/api/v1/institutions/' + id;
const ops = '/api/v1/operations';
const termsBody = (version: string, extra: Record<string, unknown> = {}) => ({
  version, title: 'ONE data-processing terms for colleges', body: 'DRAFT — FOR LEGAL REVIEW. [Legal review: roles.]',
  legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', requiresReacceptance: true, reasonCode: 'TERMS_PUBLISHED', ...extra,
});
const addStudent = (institutionId: string, actor: string, roll = 'NEW-' + randomUUID().slice(0, 6)) => api().post(inst(institutionId) + '/students').set(auth(actor))
  .send({ institutionStudentId: roll, fullName: 'New Student', email: `${roll.toLowerCase()}@student.example.test` });
const exportFile = (institutionId: string, actor: string, section: string, body: Record<string, unknown> = { reasonCode: 'COLLEGE_EXIT_RECORDS' }) =>
  api().post(inst(institutionId) + '/exit-export/' + section).set(auth(actor)).send(body);
const audits = async (action: string, organizationId?: string) => (await pool.query(
  'SELECT actor_user_id, organization_id, outcome, context, resource_id FROM audit_events WHERE action=$1 AND ($2::uuid IS NULL OR organization_id=$2) ORDER BY occurred_at',
  [action, organizationId ?? null])).rows;
const count = async (text: string, values: unknown[] = []) => Number((await pool.query(text, values)).rows[0].n);

function parseCsv(text: string): string[][] {
  expect(text.startsWith('﻿')).toBe(true);
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  const body = text.slice(1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { cell += '"'; index += 1; } else if (char === '"') quoted = false; else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; } else if (char === '\r' && body[index + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; index += 1; } else cell += char;
  }
  return rows;
}
const csvText = (response: request.Response): string => (typeof response.text === 'string' ? response.text : String(response.body));

/** Everything the design lists as the student's, for these students: must be identical before and after an exit. */
async function studentOwned(students: readonly Student[]): Promise<Record<string, unknown>> {
  const ids = students.map((entry) => entry.userId);
  const rows = async (text: string) => (await pool.query(text, [ids])).rows;
  return {
    users: await rows('SELECT id, email, state::text FROM users WHERE id = ANY($1) ORDER BY id'),
    qualifications: await rows('SELECT id, verification_state, verified_by_user_id, verified_at FROM student_qualifications WHERE student_user_id = ANY($1) ORDER BY id'),
    terms: await rows('SELECT t.id, t.verification_state, t.result_value FROM student_academic_terms t JOIN student_qualifications q ON q.id = t.qualification_id WHERE q.student_user_id = ANY($1) ORDER BY t.id'),
    consents: await rows('SELECT id, action FROM user_consents WHERE user_id = ANY($1) ORDER BY id'),
    externalApplications: await rows('SELECT id, stage FROM external_applications WHERE student_user_id = ANY($1) ORDER BY id'),
    otherNotifications: await rows("SELECT id FROM user_notifications WHERE user_id = ANY($1) AND coalesce(data->>'kind', '') NOT IN ('INSTITUTION_EXIT', 'INSTITUTION_RETURN') ORDER BY id"),
  };
}

async function backdate(offboardingId: string, days: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE institution_offboardings DISABLE TRIGGER institution_offboarding_guard');
    await client.query(`UPDATE institution_offboardings SET ended_at = ended_at - make_interval(days => $2), retention_ends_at = retention_ends_at - make_interval(days => $2) WHERE id = $1`, [offboardingId, days]);
  } finally {
    await client.query('ALTER TABLE institution_offboardings ENABLE TRIGGER institution_offboarding_guard');
    client.release();
  }
}
function requestPurgeApproval(offboardingId: string, actor = operatorId): request.Test {
  return api().post(ops + '/approvals').set(auth(actor)).send({ actionKey: 'INSTITUTION_DATA_PURGE', payload: { offboardingId, reasonCode: 'RETENTION_PERIOD_ENDED' } });
}
async function approve(approvalId: string): Promise<void> {
  await api().post(ops + '/approvals/' + approvalId + '/decision').set(auth(approverId)).send({ decision: 'APPROVE', reasonCode: 'POLICY_REQUIREMENT' }).expect(201);
}
const notice = (institutionId: string, actor = operatorId, reasonCode = 'CONTRACT_ENDED') => api().post(ops + '/institution-offboardings').set(auth(actor)).send({ institutionId, reasonCode });
const step = (offboardingId: string, name: 'end' | 'cancel', reasonCode: string, actor = operatorId) =>
  api().post(ops + '/institution-offboardings/' + offboardingId + '/' + name).set(auth(actor)).send({ reasonCode });

// ---------------------------------------------------------------------------
// Part 1 — data-processing terms
// ---------------------------------------------------------------------------

let alpha: College;

describe('INST-18: data-processing terms gate the next rostering, never what is already there', () => {
  it('rosters exactly as before while no terms have been published, and shows that honestly', async () => {
    alpha = await college('Alpha College of Engineering');
    await api().get(inst(alpha.institutionId) + '/data-terms').expect(401);
    const read = await api().get(inst(alpha.institutionId) + '/data-terms').set(auth(alpha.owner.id)).expect(200);
    expect(read.body).toMatchObject({ terms: { status: 'NO_TERMS_PUBLISHED', current: null, required: null }, canAccept: true });
    expect((await api().get(inst(alpha.institutionId) + '/data-terms').set(auth(alpha.admin.id)).expect(200)).body.canAccept).toBe(false);
    await api().get(inst(alpha.institutionId) + '/data-terms').set(auth(alpha.faculty.id)).expect(403);
    await addStudent(alpha.institutionId, alpha.admin.id).expect(201);
  });

  it('lets only operations publish an immutable version, labelled with its legal-review state', async () => {
    await api().post(ops + '/institution-data-terms').set(auth(alpha.owner.id)).send(termsBody('2026-10-draft-1')).expect(403);
    await api().post(ops + '/institution-data-terms').set(auth(operatorId)).send(termsBody('first-minor', { requiresReacceptance: false })).expect(400);
    await api().post(ops + '/institution-data-terms').set(auth(operatorId)).send(termsBody('approved-no-ref', { legalReviewState: 'LEGAL_APPROVED' })).expect(400);
    await api().post(ops + '/institution-data-terms').set(auth(operatorId)).send({ ...termsBody('x-1'), extra: true }).expect(400);
    const published = await api().post(ops + '/institution-data-terms').set(auth(operatorId)).send(termsBody('2026-10-draft-1')).expect(201);
    expect(published.body.version).toMatchObject({ version: '2026-10-draft-1', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW', legalReviewReference: null, requiresReacceptance: true });
    expect(published.body.version.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(published.body.version.bodySha256).not.toBe('0'.repeat(64));
    await api().post(ops + '/institution-data-terms').set(auth(operatorId)).send(termsBody('2026-10-draft-1')).expect(409);
    await expect(pool.query("UPDATE institution_data_terms_versions SET body = 'changed' WHERE version = '2026-10-draft-1'")).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM institution_data_terms_versions WHERE version = '2026-10-draft-1'")).rejects.toThrow(/append-only/);
    expect(await audits('institution.data_terms.published')).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'institution.data_terms.published'")).toBe(1);
    const list = await api().get(ops + '/institution-data-terms').set(auth(operatorId)).expect(200);
    expect(list.body.versions.map((entry: { version: string; acceptedBy: number }) => [entry.version, entry.acceptedBy])).toEqual([['2026-10-draft-1', 0]]);
  });

  it('refuses rostering until an owner accepts, without touching anyone already rostered', async () => {
    const before = await pool.query("SELECT state::text, effective_to FROM institution_relationships WHERE institution_id = $1 ORDER BY id", [alpha.institutionId]);
    const refused = await addStudent(alpha.institutionId, alpha.admin.id).expect(403);
    expect(refused.body.error.code).toBe('INSTITUTION_DATA_TERMS_NOT_ACCEPTED');
    expect(refused.body.error.message).not.toMatch(/institution_data_terms|stack|select/i);
    const commit = await api().post(inst(alpha.institutionId) + '/student-imports/' + randomUUID() + '/commit').set(auth(alpha.admin.id)).expect(403);
    expect(commit.body.error.code).toBe('INSTITUTION_DATA_TERMS_NOT_ACCEPTED');
    const after = await pool.query("SELECT state::text, effective_to FROM institution_relationships WHERE institution_id = $1 ORDER BY id", [alpha.institutionId]);
    expect(after.rows).toEqual(before.rows);
    expect(await count("SELECT count(*)::int AS n FROM invitations WHERE organization_id = $1 AND state = 'PENDING'", [alpha.institutionId])).toBeGreaterThan(0);

    const status = await api().get(inst(alpha.institutionId) + '/data-terms').set(auth(alpha.owner.id)).expect(200);
    expect(status.body.terms).toMatchObject({ status: 'ACCEPTANCE_REQUIRED', current: { version: '2026-10-draft-1', legalReviewState: 'DRAFT_FOR_LEGAL_REVIEW' }, latestAcceptance: null });
  });

  it('records an acceptance by an owner only, of the current version only, once', async () => {
    const path = inst(alpha.institutionId) + '/data-terms/accept';
    await api().post(path).set(auth(alpha.admin.id)).send({ version: '2026-10-draft-1' }).expect(403);
    await api().post(path).set(auth(alpha.faculty.id)).send({ version: '2026-10-draft-1' }).expect(403);
    await api().post(path).set(auth(alpha.owner.id)).send({ version: 'not a version!' }).expect(400);
    expect((await api().post(path).set(auth(alpha.owner.id)).send({ version: 'older' }).expect(409)).body.error.code).toBe('INSTITUTION_DATA_TERMS_VERSION_NOT_CURRENT');
    const accepted = await api().post(path).set(auth(alpha.owner.id)).send({ version: '2026-10-draft-1' }).expect(201);
    expect(accepted.body.terms).toMatchObject({ status: 'ACCEPTED', currentVersionAccepted: true, latestAcceptance: { version: '2026-10-draft-1' } });
    await api().post(path).set(auth(alpha.owner.id)).send({ version: '2026-10-draft-1' }).expect(201);
    expect(await count('SELECT count(*)::int AS n FROM institution_data_terms_acceptances WHERE institution_id = $1', [alpha.institutionId])).toBe(1);
    const trail = await audits('institution.data_terms.accepted', alpha.institutionId);
    expect(trail.map((row) => [row.actor_user_id, row.context.termsVersion])).toEqual([[alpha.owner.id, '2026-10-draft-1']]);
    await expect(pool.query('DELETE FROM institution_data_terms_acceptances WHERE institution_id = $1', [alpha.institutionId])).rejects.toThrow(/append-only/);
    await addStudent(alpha.institutionId, alpha.admin.id).expect(201);
  });

  it('asks again only on a material change', async () => {
    await api().post(ops + '/institution-data-terms').set(auth(operatorId)).send(termsBody('2026-10-draft-2', { requiresReacceptance: false, changeSummary: 'Typo fixed.' })).expect(201);
    expect((await api().get(inst(alpha.institutionId) + '/data-terms').set(auth(alpha.owner.id)).expect(200)).body.terms).toMatchObject({ status: 'ACCEPTED', currentVersionAccepted: false });
    await addStudent(alpha.institutionId, alpha.admin.id).expect(201);
    await api().post(ops + '/institution-data-terms').set(auth(operatorId)).send(termsBody('2026-11-draft-1')).expect(201);
    expect((await api().get(inst(alpha.institutionId) + '/data-terms').set(auth(alpha.owner.id)).expect(200)).body.terms.status).toBe('ACCEPTANCE_REQUIRED');
    expect((await addStudent(alpha.institutionId, alpha.admin.id).expect(403)).body.error.code).toBe('INSTITUTION_DATA_TERMS_NOT_ACCEPTED');
    await api().post(inst(alpha.institutionId) + '/data-terms/accept').set(auth(alpha.owner.id)).send({ version: '2026-11-draft-1' }).expect(201);
    await addStudent(alpha.institutionId, alpha.admin.id).expect(201);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — notice and the exit export
// ---------------------------------------------------------------------------

let beta: College;
let betaExit: string;

describe('INST-18: the exit export', () => {
  it('is not available without an open notice', async () => {
    beta = await college('Beta Arts and Science College');
    await api().post(inst(beta.institutionId) + '/data-terms/accept').set(auth(beta.owner.id)).send({ version: '2026-11-draft-1' }).expect(201);
    const view = await api().get(inst(beta.institutionId) + '/exit').set(auth(beta.owner.id)).expect(200);
    expect(view.body).toMatchObject({ exit: null, export: { available: false, sections: [], restricted: null } });
    expect((await exportFile(beta.institutionId, beta.owner.id, 'units').expect(409)).body.error.code).toBe('EXIT_NOT_IN_NOTICE');
    expect(await audits('institution.exit_export.units.exported', beta.institutionId)).toEqual([]);
  });

  it('opens with a notice recorded by operations, which refuses a second and stops rostering', async () => {
    await notice(beta.institutionId, beta.owner.id).expect(403);
    await notice(beta.institutionId, operatorId, 'WHATEVER').expect(400);
    await notice(randomUUID()).expect(404);
    const opened = await notice(beta.institutionId).expect(201);
    betaExit = opened.body.offboarding.id;
    expect(opened.body.offboarding).toMatchObject({ state: 'NOTICE', institutionName: 'Beta Arts and Science College', endedAt: null, retentionEndsAt: null });
    expect((await notice(beta.institutionId).expect(409)).body.error.code).toBe('OFFBOARDING_ALREADY_OPEN');
    expect((await addStudent(beta.institutionId, beta.admin.id).expect(403)).body.error.code).toBe('INSTITUTION_OFFBOARDING_IN_PROGRESS');
    expect(await audits('institution.offboarding.notice_recorded', beta.institutionId)).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM organizations WHERE id = $1 AND active", [beta.institutionId])).toBe(1);
  });

  it('shows the owner every section with counts, and what never leaves', async () => {
    const view = await api().get(inst(beta.institutionId) + '/exit').set(auth(beta.owner.id)).expect(200);
    expect(view.body.exit).toMatchObject({ state: 'NOTICE', exitExportLastTakenAt: null });
    expect(view.body.exit).not.toHaveProperty('purgeSummary');
    expect(view.body.export.available).toBe(true);
    const counts = Object.fromEntries(view.body.export.sections.map((entry: { section: string; rows: number }) => [entry.section, entry.rows]));
    expect(counts).toEqual({ units: 4, roster: 3, staff: 3, 'teaching-assignments': 1, assessments: 1, 'assessment-results': 1, 'staff-actions': 2, 'verification-decisions': 2 });
    expect(view.body.export.restricted).toMatchObject({ section: 'counselling-notes', rows: 1, parts: 1 });
    expect(view.body.export.excluded.join(' ')).toMatch(/applications/i);
    expect((await api().get(inst(beta.institutionId) + '/exit').set(auth(beta.admin.id)).expect(200)).body.export.available).toBe(false);
    await api().get(inst(beta.institutionId) + '/exit').set(auth(beta.faculty.id)).expect(403);
    await api().get(inst(beta.institutionId) + '/exit').set(auth(alpha.owner.id)).expect(403);
  });

  it('gives the owner each section as a formula-safe CSV, audited before it is sent', async () => {
    await exportFile(beta.institutionId, beta.admin.id, 'roster').expect(403);
    await exportFile(beta.institutionId, alpha.owner.id, 'roster').expect(403);
    expect((await exportFile(beta.institutionId, beta.owner.id, 'roster', {}).expect(400)).body.error.code).toBe('REASON_CODE_REQUIRED');
    await exportFile(beta.institutionId, beta.owner.id, 'roster', { reasonCode: 'COLLEGE_EXIT_RECORDS', unitId: randomUUID() }).expect(400);
    await exportFile(beta.institutionId, beta.owner.id, 'everything').expect(404);
    expect((await exportFile(beta.institutionId, beta.owner.id, 'units', { reasonCode: 'COLLEGE_EXIT_RECORDS', part: 2 }).expect(400)).body.error.code).toBe('EXIT_EXPORT_PART_INVALID');

    const roster = await exportFile(beta.institutionId, beta.owner.id, 'roster').expect(200);
    expect(roster.headers['content-type']).toMatch(/text\/csv/);
    expect(roster.headers['content-disposition']).toMatch(/attachment; filename="one-exit-roster-part-1-/);
    expect(roster.headers['cache-control']).toBe('no-store');
    const rosterRows = parseCsv(csvText(roster));
    expect(rosterRows[0]).toEqual(['Student ID', 'Full name', 'Email', 'Department', 'Programme', 'Batch', 'Section', 'Roster status', 'Relationship', 'From', 'To', 'Academic start', 'Expected graduation']);
    expect(rosterRows.slice(1).map((row) => [row[0], row[8]])).toEqual([['ME-000', 'GRADUATED'], ['ME-001', 'ACTIVE'], ['ME-002', 'ACTIVE']]);
    expect(csvText(roster)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    const actions = parseCsv(csvText(await exportFile(beta.institutionId, beta.owner.id, 'staff-actions').expect(200)));
    expect(actions.slice(1).map((row) => row[0]).sort()).toEqual(['FACULTY_NOTE', 'MEETING']);
    expect(actions.find((row) => row[0] === 'FACULTY_NOTE')![1]).toBe(`'=HYPERLINK("http://x")`);
    expect(JSON.stringify(actions)).not.toContain('COUNSELLING-TEXT-ONLY-FOR-OWNER');

    for (const section of ['units', 'staff', 'teaching-assignments', 'assessments', 'assessment-results', 'verification-decisions']) {
      const file = await exportFile(beta.institutionId, beta.owner.id, section).expect(200);
      const text = csvText(file);
      expect(text).not.toMatch(/compensation|salary|readiness/i);
      expect(parseCsv(text).length).toBeGreaterThan(1);
    }
    const decisions = parseCsv(csvText(await exportFile(beta.institutionId, beta.owner.id, 'verification-decisions').expect(200)));
    expect(decisions.slice(1).map((row) => [row[0], row[3], row[10]])).toEqual([['ME-001', 'Qualification', 'VERIFIED'], ['ME-001', 'Term', 'VERIFIED']]);

    const trail = await audits('institution.exit_export.roster.exported', beta.institutionId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actor_user_id: beta.owner.id, outcome: 'SUCCESS', context: { kind: 'EXIT_EXPORT', section: 'roster', part: 1, rowCount: 3, reasonCode: 'COLLEGE_EXIT_RECORDS', offboardingId: betaExit } });
    expect((await api().get(inst(beta.institutionId) + '/exit').set(auth(beta.owner.id)).expect(200)).body.exit.exitExportLastTakenAt).toBeTruthy();
  });

  it('releases counselling notes only on an explicit request with a listed reason, under their own audit action', async () => {
    expect((await exportFile(beta.institutionId, beta.owner.id, 'counselling-notes').expect(400)).body.error.code).toBe('COUNSELLING_EXPORT_CONFIRMATION_REQUIRED');
    expect((await exportFile(beta.institutionId, beta.owner.id, 'counselling-notes', { reasonCode: 'COLLEGE_EXIT_RECORDS', includeRestrictedCounsellingNotes: true }).expect(400)).body.error.code)
      .toBe('COUNSELLING_EXPORT_REASON_INVALID');
    await exportFile(beta.institutionId, beta.admin.id, 'counselling-notes', { reasonCode: 'LEGAL_OBLIGATION', includeRestrictedCounsellingNotes: true }).expect(403);
    expect(await audits('institution.exit_export.counselling_notes.exported')).toEqual([]);
    const notes = await exportFile(beta.institutionId, beta.owner.id, 'counselling-notes', { reasonCode: 'LEGAL_OBLIGATION', includeRestrictedCounsellingNotes: true }).expect(200);
    expect(csvText(notes)).toContain('COUNSELLING-TEXT-ONLY-FOR-OWNER');
    const trail = await audits('institution.exit_export.counselling_notes.exported', beta.institutionId);
    expect(trail.map((row) => [row.actor_user_id, row.context.reasonCode, row.context.rowCount, row.context.restrictedCounsellingNotes])).toEqual([[beta.owner.id, 'LEGAL_OBLIGATION', 1, true]]);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — ending, and reversal while the retention period runs
// ---------------------------------------------------------------------------

describe('INST-18: offboarding is reversible until the retention period ends', () => {
  let before: Record<string, unknown>;

  it('ends relationships, memberships and invitations, tells activated students, and records every change', async () => {
    before = await studentOwned([beta.active, beta.invited, beta.graduate]);
    await step(betaExit, 'end', 'NOTICE_PERIOD_COMPLETE', beta.owner.id).expect(403);
    await step(betaExit, 'end', 'CONTRACT_ENDED').expect(400);
    const ended = await step(betaExit, 'end', 'NOTICE_PERIOD_COMPLETE').expect(201);
    expect(ended.body.offboarding).toMatchObject({ state: 'ENDED', retentionElapsed: false, changes: { relationships: 2, memberships: 3, restored: 0 } });
    const retention = new Date(ended.body.offboarding.retentionEndsAt).getTime() - new Date(ended.body.offboarding.endedAt).getTime();
    expect(retention).toBe(90 * 86_400_000);

    const relationships = await pool.query('SELECT student_user_id, state::text, effective_to FROM institution_relationships WHERE institution_id = $1', [beta.institutionId]);
    const byStudent = new Map(relationships.rows.map((row) => [row.student_user_id, row]));
    expect(byStudent.get(beta.active.userId)).toMatchObject({ state: 'ENDED' });
    expect(byStudent.get(beta.active.userId)!.effective_to).not.toBeNull();
    expect(byStudent.get(beta.invited.userId)).toMatchObject({ state: 'ENDED' });
    expect(byStudent.get(beta.graduate.userId)).toMatchObject({ state: 'GRADUATED' });
    expect(new Date(byStudent.get(beta.graduate.userId)!.effective_to).toISOString()).toBe('2025-06-01T00:00:00.000Z');
    expect(await count("SELECT count(*)::int AS n FROM institution_student_profiles WHERE institution_id = $1 AND status = 'ENDED'", [beta.institutionId])).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id = $1 AND state = 'ENDED'", [beta.institutionId])).toBe(3);
    expect(await count("SELECT count(*)::int AS n FROM invitations WHERE organization_id = $1 AND state = 'PENDING'", [beta.institutionId])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM invitations WHERE organization_id = $1 AND reason_code = 'INSTITUTION_OFFBOARDED'", [beta.institutionId])).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM organizations WHERE id = $1 AND NOT active', [beta.institutionId])).toBe(1);

    // Only the activated student is told, in words that do not claim the college recorded anything.
    const notices = await pool.query("SELECT user_id, title, body FROM user_notifications WHERE data->>'kind' = 'INSTITUTION_EXIT'");
    expect(notices.rows.map((row) => row.user_id)).toEqual([beta.active.userId]);
    expect(notices.rows[0].title).toBe('Beta Arts and Science College has stopped using ONE');
    expect(notices.rows[0].body).toMatch(/stay yours/);
    expect(notices.rows[0].body).not.toMatch(/verify past results|recorded you/);
    expect(await count("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'institution.relationship.ended' AND organization_id = $1", [beta.institutionId])).toBe(0);
    expect((await audits('institution.relationship.ended', beta.institutionId)).map((row) => row.context.reasonCode)).toEqual(['INSTITUTION_OFFBOARDED', 'INSTITUTION_OFFBOARDED']);
    expect(await audits('institution.staff_membership.ended', beta.institutionId)).toHaveLength(3);
    expect((await audits('institution.offboarding.ended', beta.institutionId))[0].context).toMatchObject({ relationshipsEnded: 2, membershipsEnded: 3, invitationsRevoked: 1, studentsNotified: 1 });
    expect(await count("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'institution.offboarding.ended'")).toBe(1);

    // Staff lose the college on the next request; the export window has closed.
    await api().get(inst(beta.institutionId) + '/exit').set(auth(beta.owner.id)).expect(403);
    await exportFile(beta.institutionId, beta.owner.id, 'units').expect(403);
    await step(betaExit, 'end', 'NOTICE_PERIOD_COMPLETE').expect(409);
    expect(await studentOwned([beta.active, beta.invited, beta.graduate])).toEqual(before);
  });

  it('restores exactly what it changed when cancelled inside the retention period', async () => {
    const cancelled = await step(betaExit, 'cancel', 'COLLEGE_RENEWED').expect(201);
    expect(cancelled.body.offboarding).toMatchObject({ state: 'CANCELLED', changes: { relationships: 2, memberships: 3, restored: 5 } });
    const relationships = await pool.query('SELECT student_user_id, state::text, effective_to FROM institution_relationships WHERE institution_id = $1', [beta.institutionId]);
    const byStudent = new Map(relationships.rows.map((row) => [row.student_user_id, row]));
    expect(byStudent.get(beta.active.userId)).toMatchObject({ state: 'ACTIVE', effective_to: null });
    expect(byStudent.get(beta.invited.userId)).toMatchObject({ state: 'ACTIVE', effective_to: null });
    expect(byStudent.get(beta.graduate.userId)).toMatchObject({ state: 'GRADUATED' });
    const statuses = await pool.query('SELECT student_user_id, status::text FROM institution_student_profiles WHERE institution_id = $1', [beta.institutionId]);
    expect(Object.fromEntries(statuses.rows.map((row) => [row.student_user_id, row.status]))).toEqual({
      [beta.active.userId]: 'ACTIVE', [beta.invited.userId]: 'INVITED', [beta.graduate.userId]: 'GRADUATED',
    });
    expect(await count("SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id = $1 AND state = 'ACTIVE'", [beta.institutionId])).toBe(3);
    expect(await count('SELECT count(*)::int AS n FROM organizations WHERE id = $1 AND active', [beta.institutionId])).toBe(1);
    const back = await pool.query("SELECT user_id, title FROM user_notifications WHERE data->>'kind' = 'INSTITUTION_RETURN'");
    expect(back.rows).toEqual([{ user_id: beta.active.userId, title: 'Beta Arts and Science College is using ONE again' }]);
    expect(await audits('institution.relationship.restored', beta.institutionId)).toHaveLength(2);
    expect(await audits('institution.staff_membership.restored', beta.institutionId)).toHaveLength(3);
    await api().get(inst(beta.institutionId) + '/exit').set(auth(beta.owner.id)).expect(200);
    await step(betaExit, 'cancel', 'COLLEGE_RENEWED').expect(409);
    await expect(pool.query("UPDATE institution_offboardings SET state = 'ENDED' WHERE id = $1", [betaExit])).rejects.toThrow(/not a permitted step/);
    await expect(pool.query('DELETE FROM institution_offboardings WHERE id = $1', [betaExit])).rejects.toThrow(/never deleted/);
    expect(await studentOwned([beta.active, beta.invited, beta.graduate])).toEqual(before);
  });

  it('cannot be reversed once the retention period has passed', async () => {
    const reopened = await notice(beta.institutionId).expect(201);
    const id = reopened.body.offboarding.id as string;
    await step(id, 'cancel', 'COLLEGE_WITHDREW_NOTICE').expect(201);
    const again = await notice(beta.institutionId).expect(201);
    const exitId = again.body.offboarding.id as string;
    await step(exitId, 'end', 'COLLEGE_CONFIRMED_EXIT').expect(201);
    await backdate(exitId, 91);
    expect((await step(exitId, 'cancel', 'COLLEGE_RENEWED').expect(409)).body.error.code).toBe('OFFBOARDING_RETENTION_ENDED');
    betaExit = exitId;
  });
});

// ---------------------------------------------------------------------------
// Part 4 — the purge: dry run, dual control, holds, and exactly the institution-owned tables
// ---------------------------------------------------------------------------

describe('INST-18: the purge deletes institution-owned records only, with a second person and after the retention period', () => {
  let gamma: College;
  let gammaExit: string;
  let other: College;
  let purgeApproval: string;

  it('classifies every table that carries an institution_id', async () => {
    const tables = (await pool.query(`SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'institution_id' ORDER BY 1`)).rows.map((row) => row.table_name as string);
    const classified = new Set([...institutionPurgePlan.map((entry) => entry.table), ...institutionPurgeKept.map((entry) => entry.table), ...Object.keys(institutionPurgeOutOfScope)]);
    expect(tables.filter((table) => !classified.has(table))).toEqual([]);
  });

  it('refuses a purge before the retention period, without an approval, or with the wrong person', async () => {
    gamma = await college('Gamma Polytechnic');
    other = await college('Other College');
    await api().post(inst(gamma.institutionId) + '/data-terms/accept').set(auth(gamma.owner.id)).send({ version: '2026-11-draft-1' }).expect(201);
    gammaExit = (await notice(gamma.institutionId).expect(201)).body.offboarding.id;
    const purge = (body: Record<string, unknown>, actor = operatorId) => api().post(ops + '/institution-offboardings/' + gammaExit + '/purge').set(auth(actor)).send(body);
    expect((await purge({ reasonCode: 'RETENTION_PERIOD_ENDED' }).expect(403)).body.error.code).toBe('APPROVAL_REQUIRED');
    await step(gammaExit, 'end', 'NOTICE_PERIOD_COMPLETE').expect(201);
    expect((await requestPurgeApproval(gammaExit).expect(400)).body.error.code).toBe('APPROVAL_TARGET_STATE_INVALID');
    await purge({ reasonCode: 'RETENTION_PERIOD_ENDED', approvalId: randomUUID() }).expect(409);
    await purge({ reasonCode: 'RETENTION_PERIOD_ENDED', approvalId: randomUUID() }, gamma.owner.id).expect(403);
    // The 0082 delete guards still hold for everyone but the purge.
    await expect(pool.query('DELETE FROM learning_assignments WHERE institution_id = $1', [gamma.institutionId])).rejects.toThrow(/never deleted/);
    await expect(pool.query('DELETE FROM staff_action_content_links WHERE staff_action_id IN (SELECT id FROM staff_actions WHERE institution_id = $1)', [gamma.institutionId])).rejects.toThrow();
  });

  it('dry-runs the purge on seeded data, deleting nothing', async () => {
    await backdate(gammaExit, 90);
    const preview = await api().get(ops + '/institution-offboardings/' + gammaExit + '/purge-preview').set(auth(operatorId)).expect(200);
    expect(preview.body.offboarding).toMatchObject({ state: 'ENDED', retentionElapsed: true });
    const deletes = preview.body.preview.deletes as Record<string, number>;
    for (const table of ['staff_actions', 'staff_action_attendees', 'staff_action_content_links', 'counselling_case_participants', 'learning_assignments',
      'learning_assignment_students', 'learning_plan_overrides', 'exam_results', 'exam_attempts', 'exam_questions', 'exam_subjects', 'faculty_teaching_assignments',
      'institution_announcements', 'institution_announcement_recipients', 'institution_settings', 'institution_grading_scales', 'institution_academic_terms',
      'student_roster_imports', 'student_roster_import_rows', 'institution_student_profiles']) {
      expect(deletes[table], table).toBeGreaterThan(0);
    }
    // The runbook's recorded dry run (docs/institution/sop-college-exit.md): one seeded college, exactly.
    expect(deletes).toEqual({
      staff_action_content_links: 1, staff_action_attendees: 1, learning_assignment_students: 1, learning_assignments: 1, learning_plan_overrides: 1,
      counselling_case_participants: 1, staff_actions: 3, exam_results: 1, exam_screen_events: 1, exam_answers: 1, exam_attempt_questions: 1,
      exam_attempts: 1, exam_assignments: 1, exam_section_pool: 1, exam_sections: 1, exam_definition_events: 1, exam_definitions: 1,
      exam_question_reviews: 1, exam_question_versions: 1, exam_question_options: 1, exam_questions: 1, exam_subject_topic_links: 0,
      faculty_teaching_assignments: 1, exam_syllabus_nodes: 1, exam_subjects: 1, institution_announcement_recipients: 1, institution_announcements: 1,
      institution_settings: 1, institution_grading_scales: 1, institution_academic_terms: 1, student_roster_import_rows: 1, student_roster_imports: 1,
      institution_student_profiles: 3, institution_aggregate_reports: 0,
    });
    expect(preview.body.preview.keeps).toEqual({ institution_units: 4, institution_relationships: 3, student_qualifications: 1, student_academic_terms: 1,
      campus_drives: 0, campus_drive_nominations: 0, student_outcome_declarations: 0, organization_memberships: 3 });
    expect(preview.body.preview.studentsUnderHold).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM staff_actions WHERE institution_id = $1', [gamma.institutionId])).toBe(3);
  });

  it('is refused while a student of the college is under a legal hold, consuming nothing', async () => {
    const holdId = randomUUID();
    await pool.query("INSERT INTO data_retention_holds (id,subject_user_id,reason_code,placed_by_user_id) VALUES ($1,$2,'LEGAL_OBLIGATION',$3)", [holdId, gamma.graduate.userId, operatorId]);
    const approval = (await requestPurgeApproval(gammaExit).expect(201)).body.approval.id as string;
    await approve(approval);
    const refused = await api().post(ops + '/institution-offboardings/' + gammaExit + '/purge').set(auth(operatorId)).send({ reasonCode: 'RETENTION_PERIOD_ENDED', approvalId: approval }).expect(409);
    expect(refused.body.error.code).toBe('OFFBOARDING_PURGE_HELD');
    expect((await pool.query('SELECT state FROM operation_approvals WHERE id = $1', [approval])).rows[0].state).toBe('APPROVED');
    expect(await count('SELECT count(*)::int AS n FROM staff_actions WHERE institution_id = $1', [gamma.institutionId])).toBe(3);
    await pool.query('UPDATE data_retention_holds SET released_at = now(), released_by_user_id = $2 WHERE id = $1', [holdId, approverId]);

    // Only the operator who asked may act on the approval.
    const wrongPerson = await api().post(ops + '/institution-offboardings/' + gammaExit + '/purge').set(auth(secondOperatorId)).send({ reasonCode: 'RETENTION_PERIOD_ENDED', approvalId: approval }).expect(403);
    expect(wrongPerson.body.error.code).toBe('APPROVAL_NOT_REQUESTER');
    purgeApproval = approval;
  });

  it('deletes exactly the institution-owned tables, leaves other colleges and every student-owned record, and documents the deletion', async () => {
    const approval = purgeApproval;
    const studentsBefore = await studentOwned([gamma.active, gamma.invited, gamma.graduate]);
    const dryRun = await api().get(ops + '/institution-offboardings/' + gammaExit + '/purge-preview').set(auth(operatorId)).expect(200);
    const otherCounts = Object.fromEntries(await Promise.all(institutionPurgePlan.map(async (entry) =>
      [entry.table, await count(`SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.where}`, [other.institutionId])] as const)));

    const purged = await api().post(ops + '/institution-offboardings/' + gammaExit + '/purge').set(auth(operatorId)).send({ reasonCode: 'RETENTION_PERIOD_ENDED', approvalId: approval }).expect(201);
    expect(purged.body.offboarding).toMatchObject({ state: 'PURGED' });
    expect(purged.body.approval).toEqual({ id: approval, mode: 'DUAL' });
    expect(purged.body.deleted).toEqual(dryRun.body.preview.deletes);

    for (const entry of institutionPurgePlan) {
      expect(await count(`SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.where}`, [gamma.institutionId]), entry.table).toBe(0);
      expect(await count(`SELECT count(*)::int AS n FROM ${entry.table} WHERE ${entry.where}`, [other.institutionId]), 'other ' + entry.table).toBe(otherCounts[entry.table]);
    }
    expect(await count('SELECT count(*)::int AS n FROM institution_units WHERE institution_id = $1', [gamma.institutionId])).toBe(4);
    expect(await count('SELECT count(*)::int AS n FROM institution_relationships WHERE institution_id = $1', [gamma.institutionId])).toBe(3);
    expect(await studentOwned([gamma.active, gamma.invited, gamma.graduate])).toEqual(studentsBefore);
    expect((await pool.query("SELECT verification_state FROM student_qualifications WHERE student_user_id = $1", [gamma.active.userId])).rows[0].verification_state).toBe('VERIFIED');

    const row = (await pool.query('SELECT purge_approval_id, purge_summary, purged_by_user_id FROM institution_offboardings WHERE id = $1', [gammaExit])).rows[0];
    expect(row).toMatchObject({ purge_approval_id: approval, purged_by_user_id: operatorId });
    expect(row.purge_summary).toEqual(purged.body.deleted);
    expect((await pool.query('SELECT state FROM operation_approvals WHERE id = $1', [approval])).rows[0].state).toBe('EXECUTED');
    const trail = await audits('institution.offboarding.purged', gamma.institutionId);
    expect(trail).toHaveLength(1);
    expect(trail[0].context).toMatchObject({ reasonCode: 'RETENTION_PERIOD_ENDED', approvalId: approval, approvedByUserId: approverId, mode: 'DUAL' });
    expect(await count("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'institution.offboarding.purged'")).toBe(1);

    // Terminal: no second purge, no reversal, no hand-edit.
    await api().post(ops + '/institution-offboardings/' + gammaExit + '/purge').set(auth(operatorId)).send({ reasonCode: 'RETENTION_PERIOD_ENDED', approvalId: approval }).expect(409);
    await step(gammaExit, 'cancel', 'COLLEGE_RENEWED').expect(409);
    await expect(pool.query("UPDATE institution_offboardings SET purge_summary = '{}' WHERE id = $1", [gammaExit])).rejects.toThrow();
  });

  it('refuses a purge in the database without an executed approval for that exit', async () => {
    const approval = purgeApproval;
    const ended = await notice(other.institutionId).expect(201);
    const otherExit = ended.body.offboarding.id as string;
    await step(otherExit, 'end', 'NOTICE_PERIOD_COMPLETE').expect(201);
    await backdate(otherExit, 90);
    await expect(pool.query(`UPDATE institution_offboardings SET state = 'PURGED', purged_by_user_id = $2, purge_approval_id = $3, purge_summary = '{}' WHERE id = $1`,
      [otherExit, operatorId, approval])).rejects.toThrow(/executed INSTITUTION_DATA_PURGE approval for this exit/);
  });

  it('lists every exit for operations, and nothing for anyone else', async () => {
    await api().get(ops + '/institution-offboardings').expect(401);
    await api().get(ops + '/institution-offboardings').set(auth(gamma.owner.id)).expect(403);
    const listed = await api().get(ops + '/institution-offboardings').set(auth(operatorId)).expect(200);
    expect(listed.body.policy.retentionDays).toBe(90);
    expect(listed.body.offboardings.map((entry: { institutionName: string; state: string }) => entry.state)).toContain('PURGED');
    const queue = await api().get(ops + '/approvals?state=EXECUTED').set(auth(approverId)).expect(200);
    const purge = queue.body.approvals.find((entry: { actionKey: string }) => entry.actionKey === 'INSTITUTION_DATA_PURGE');
    expect(purge.summary.organizationName).toBe('Gamma Polytechnic');
  });
});
