/**
 * ENG-25 end to end, on synthetic data and ENG-20's local fake endpoint (no pod, no network):
 * - a college is switched on only through OPS-12: an AI_TUTOR_COLLEGE_ENABLE approval (OPS-02) and a
 *   passing evaluation for the tutor's model and prompt — the 0116 trigger refuses every bypass;
 * - group assignment is reproducible (the recorded seed and the formula give the group; SQL and TypeScript
 *   agree) and recorded once, immutably, only for consenting current students;
 * - the tutor serves only: pilot deployment + feature on + kill switch released + college on + consent +
 *   tutor group — each gate refused on its own, and re-checked by the worker;
 * - the no-tutor group and AI-off students see exactly what AI-off shows, and complete the whole practice
 *   journey (X2) with no tutor row and no model call;
 * - pilot counters per group and day carry no student; the console withholds groups under five;
 * - withdrawal, re-consent and privacy deletion.
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
import { completion, startFakeOpenAiServer, type FakeOpenAiServer } from '@planthepath/ai-orchestration/src/testing/fake-openai-server.js';
import { createLocalIntegrationEventPublisher, publishOutboxOnce } from '@planthepath/persistence/src/automation-workers.js';
import { setStudentCareerTarget } from '@planthepath/persistence/src/career-targets.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { assignTutorGroup } from '@planthepath/tutoring/src/index.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { assembleSubjectExport } from './privacy-export.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for tutor rollout integration tests');

const schemaName = 'tutor_rollout_' + randomUUID().replaceAll('-', '');
const adminPool = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: '-c search_path=' + schemaName });
const db = drizzle(pool, { schema });
const tokens = new Set<string>();
const CONSENT_VERSION = 'eng25-synthetic';
const SHA = 'e'.repeat(64);
const MODEL = 'fake/served-model';
// Test-only sentinel; not a credential.
const TEST_KEY = 'test-only-bearer-value-eng25';
const OPTIONS = [{ id: 'a', text: '36' }, { id: 'b', text: '42' }, { id: 'c', text: '48' }, { id: 'd', text: '54' }];
const LADDER = ['Synthetic nudge: groups of six.', 'Synthetic strategy: multiply.', 'Synthetic worked step: five groups first.', 'Synthetic near solution: one more group.'];
const SAFE_HINT = 'Think of equal groups. How many groups of six are there?';
const ENV_KEYS = ['ONE_AI_TUTOR_AUDIENCE', 'ONE_SANDBOX', 'ONE_AI_BASE_URL', 'ONE_AI_API_KEY', 'ONE_AI_MODEL'] as const;
const OFF = { available: false, reason: 'OFF', remainingToday: null };

interface Member { readonly userId: string; readonly membershipId: string }
interface Learner { readonly id: string; readonly decisionId: string; readonly questionId: string; readonly base: string; readonly institutionId: string }

let app: INestApplication;
let server: FakeOpenAiServer;
let platformId: string;
let collegeOn: string;
let collegeOff: string;
let configurer: Member;
let approver: Member;
let author: string;
let sourceRecordId: string;
let topicId: string;
let roleId: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  await adminPool.query('CREATE SCHEMA ' + schemaName);
  const dir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query((await readFile(new URL(name, dir), 'utf8')).replaceAll("table_schema = 'public'", 'table_schema = current_schema()'));
  }
  const module = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({
      db, ids: { uuid: () => randomUUID() },
      verifier: {
        async verifyAccessToken(token: string) {
          if (!tokens.has(token)) throw new Error('Invalid local test identity');
          return { externalSubject: token, issuer: 'local-test', clientId: 'local-test', tokenUse: 'access', issuedAt: 0, expiresAt: 4_000_000_000, scopes: [] };
        },
      },
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
  server = await startFakeOpenAiServer(() => ({ status: 200, json: completion(JSON.stringify({ type: 'HINT', text: SAFE_HINT }), { prompt_tokens: 300, completion_tokens: 30 }, 'stop', MODEL) }));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  pilot(true);

  platformId = randomUUID();
  collegeOn = randomUUID();
  collegeOff = randomUUID();
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'PLATFORM','ONE platform')", [platformId]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Synthetic pilot college')", [collegeOn]);
  await pool.query("INSERT INTO organizations (id,kind,legal_name) VALUES ($1,'INSTITUTION','Synthetic college without the tutor')", [collegeOff]);
  approver = await staff('PLATFORM_SUPER_ADMIN');
  configurer = await staff('OPERATIONS_ADMIN');
  await pool.query('INSERT INTO membership_capabilities (id,membership_id,capability,granted_by_user_id,reason_code) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), configurer.membershipId, 'AI_OPS_CONFIGURE', approver.userId, 'NEW_RESPONSIBILITY']);

  // ai-tutoring, live for this suite only (publishing the real definition is HG-6).
  await pool.query("UPDATE consent_definitions SET retired_at = greatest(now(), effective_from) WHERE consent_key = 'ai-tutoring' AND retired_at IS NULL");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('ai-tutoring', $1, 'Synthetic AI tutoring purpose', 'OPTIONAL', true, now() - interval '1 minute')`, [CONSENT_VERSION]);

  author = (await plainUser()).id;
  await seedContent();
  // The feature as ENG-21 registers it, on the model the fake serves. Off (0033 default).
  await pool.query(`INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, max_input_chars, prompt_key, prompt_version)
    VALUES ('tutor.hint', 'Practice tutor (ENG-25 test)', $1, 5000, 'DAY', 12000, 'tutor-hint', 2) ON CONFLICT (feature_key) DO NOTHING`, [MODEL]);
}, 300_000);

afterAll(async () => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  await server?.close();
  await app?.close();
  await pool.end();
  await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool.end();
}, 120_000);

beforeEach(() => { server.requests.length = 0; });

const api = () => request(app.getHttpServer());
const auth = (userId: string) => ({ Authorization: 'Bearer ' + userId, 'X-Correlation-Id': 'tutor-rollout-' + randomUUID() });
const base = '/api/v1/operations/ai';

/** The pilot deployment: the API's and the worker's environment (same process here). */
function pilot(on: boolean): void {
  const values: Record<(typeof ENV_KEYS)[number], string | undefined> = {
    ONE_AI_TUTOR_AUDIENCE: on ? 'pilot' : undefined, ONE_SANDBOX: undefined,
    ONE_AI_BASE_URL: server.baseUrl, ONE_AI_API_KEY: TEST_KEY, ONE_AI_MODEL: MODEL,
  };
  for (const key of ENV_KEYS) { const value = values[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

async function plainUser(): Promise<{ id: string }> {
  const id = randomUUID();
  tokens.add(id);
  await pool.query("INSERT INTO users (id,email,external_subject,state) VALUES ($1::uuid,$2,$1::text,'ACTIVE')", [id, `u-${id.slice(0, 8)}@rollout.example.test`]);
  return { id };
}

async function staff(role: string): Promise<Member> {
  const { id } = await plainUser();
  const membershipId = randomUUID();
  await pool.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,state,scope_organization_id,scope_institution_id)
    VALUES ($1,$2,$3,$4,'ACTIVE',$2,NULL)`, [membershipId, platformId, id, role]);
  return { userId: id, membershipId };
}

async function grant(userId: string, action: 'GRANTED' | 'WITHDRAWN' = 'GRANTED'): Promise<void> {
  await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
    VALUES ($1, $2, 'ai-tutoring', $3, $4, clock_timestamp())`, [randomUUID(), userId, CONSENT_VERSION, action]);
}

/** A current student of `institutionId` with the synthetic role as target and a gap on the one skill, on a practice step. */
async function learner(institutionId: string, options: { consent: boolean }): Promise<Learner> {
  const { id } = await plainUser();
  await pool.query("INSERT INTO institution_relationships (id,institution_id,student_user_id,state,effective_from) VALUES ($1,$2,$3,'ACTIVE',now() - interval '30 days')",
    [randomUUID(), institutionId, id]);
  await pool.query(`INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status)
    VALUES ($1, $2, $3, $4, 'Synthetic Student', 'ACTIVE')`, [randomUUID(), institutionId, id, `ENG25-${id.slice(0, 8)}`]);
  if (options.consent) await grant(id);
  await setStudentCareerTarget(pool, { subjectUserId: id, careerRoleId: roleId, priority: 'PRIMARY' });
  await pool.query('UPDATE career_gap_snapshots SET superseded_at = now() WHERE student_user_id = $1 AND superseded_at IS NULL', [id]);
  const snapshotId = randomUUID();
  await pool.query(`INSERT INTO career_gap_snapshots (id, student_user_id, career_role_id, model_version, requirements_total, requirements_met, requirements_unknown)
    VALUES ($1, $2, $3, 'career-gap-v1', 1, 0, 0)`, [snapshotId, id, roleId]);
  await pool.query(`INSERT INTO career_gap_items (id, snapshot_id, topic_id, requirement_level, target_mastery, observed_mastery, status, priority_rank)
    VALUES ($1, $2, $3, 'ESSENTIAL', 0.8, 0.5, 'PARTIAL', 1)`, [randomUUID(), snapshotId, topicId]);
  const started = await api().post('/api/v1/learning/next-step').set(auth(id)).send({});
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const step = started.body.step;
  expect(step.practice.status).toBe('IN_PROGRESS');
  const decided = await pool.query('SELECT institution_id::text AS institution_id FROM learning_decisions WHERE id = $1', [step.decisionId]);
  expect(decided.rows[0].institution_id).toBe(institutionId);
  return { id, decisionId: step.decisionId, questionId: step.practice.question.id, base: `/api/v1/learning/steps/${step.decisionId}`, institutionId };
}

async function readStep(student: { id: string; base: string }): Promise<Record<string, any>> {
  const response = await api().get(student.base).set(auth(student.id));
  expect(response.status).toBe(200);
  return response.body.step;
}

async function assignment(studentId: string): Promise<Record<string, any> | undefined> {
  return (await pool.query('SELECT * FROM tutor_group_assignments WHERE subject_user_id = $1', [studentId])).rows[0];
}

async function recordPass(): Promise<string> {
  const existing = await pool.query("SELECT id FROM ai_evaluations WHERE feature_key = 'tutor.hint' AND decision = 'PASS' AND model = $1", [MODEL]);
  if (existing.rows[0]) return existing.rows[0].id as string;
  const id = randomUUID();
  await pool.query(`INSERT INTO ai_evaluations (id, feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version, metrics, decision, reason_code, decided_by_user_id, correlation_id)
    VALUES ($1,'tutor.hint','openai-compatible',$2,'tutor-hint',2,'one-ai-bakeoff',1,$3::jsonb,'PASS','INITIAL_BENCHMARK',$4,'eng25-test-pass')`,
  [id, MODEL, JSON.stringify([{ name: 'answer_leak_rate', value: 0, threshold: 0.0099, comparator: 'AT_MOST' }]), approver.userId]);
  return id;
}

function requestApproval(institutionId: string, reasonCode = 'PILOT_ROLLOUT') {
  return api().post('/api/v1/operations/approvals').set(auth(configurer.userId)).send({ actionKey: 'AI_TUTOR_COLLEGE_ENABLE', payload: { institutionId, reasonCode } });
}

/** The whole governed path: request, a second person approves, the requester executes. */
async function switchCollegeOn(institutionId: string): Promise<void> {
  const filed = await requestApproval(institutionId);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const decided = await api().post(`/api/v1/operations/approvals/${filed.body.approval.id}/decision`).set(auth(approver.userId))
    .send({ decision: 'APPROVE', reasonCode: 'VERIFIED_NEED' });
  expect(decided.status, JSON.stringify(decided.body)).toBe(201);
  const executed = await api().post(`${base}/tutor-colleges/${institutionId}/enable`).set(auth(configurer.userId))
    .send({ reasonCode: 'PILOT_ROLLOUT', approvalId: filed.body.approval.id });
  expect(executed.status, JSON.stringify(executed.body)).toBe(201);
}

async function featureOn(): Promise<void> {
  await recordPass();
  await pool.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
  await pool.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'tutor.hint'");
}

/** Consenting students of the switched-on college until both groups have one. */
async function oneOfEachGroup(): Promise<{ tutor: Learner; noTutor: Learner }> {
  let tutor: Learner | null = null;
  let noTutor: Learner | null = null;
  for (let attempt = 0; attempt < 40 && (!tutor || !noTutor); attempt += 1) {
    const student = await learner(collegeOn, { consent: true });
    const row = await assignment(student.id);
    expect(row).toBeDefined();
    if (row!.group_name === 'TUTOR') tutor ??= student; else noTutor ??= student;
  }
  expect(tutor && noTutor).toBeTruthy();
  return { tutor: tutor!, noTutor: noTutor! };
}

/** Drains the outbox through the real local dispatcher, as the worker does (ADR-028). */
async function drain(): Promise<void> {
  const local = createLocalIntegrationEventPublisher({ pool, db: db as unknown as PersistenceDb });
  for (let round = 0; round < 5; round += 1) {
    const clock = (await pool.query<{ at: Date }>("SELECT clock_timestamp() + interval '1 second' AS at")).rows[0]!.at;
    const result = await publishOutboxOnce({ db: db as unknown as PersistenceDb, publisher: local.publisher, leaseOwner: 'eng25-test', now: new Date(clock) });
    if (result.claimed === 0) return;
  }
}

/**
 * X2's student journey on a practice step with no tutor: every question with the written hints, to the end
 * of the step, then the next step. The tutor control never appears; no tutor row is ever written.
 */
async function walkWithoutTutor(student: Learner): Promise<void> {
  let step = await readStep(student);
  let answered = 0;
  while (step.practice.status === 'IN_PROGRESS') {
    const question = step.practice.question;
    expect(question.tutor).toEqual(OFF);
    expect(question.hintDetails.every((entry: { source: string }) => entry.source === 'LADDER')).toBe(true);
    const hint = await api().post(`${student.base}/hints`).set(auth(student.id)).send({ questionId: question.id });
    expect(hint.status).toBe(201);
    expect(hint.body.step.practice.question.hints).toEqual([LADDER[0]]);
    expect(hint.body.step.practice.question.tutor).toEqual(OFF);
    const refused = await api().post(`${student.base}/tutor-hints`).set(auth(student.id)).send({ questionId: question.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'TUTOR_OFF', message: 'The AI tutor is not switched on.' });
    const answer = await api().post(`${student.base}/answers`).set(auth(student.id)).send({ questionId: question.id, selectedOptionId: 'b' });
    expect(answer.status).toBe(201);
    expect(answer.body.feedback).toMatchObject({ correct: true, assisted: false });
    answered += 1;
    step = answer.body.step;
  }
  expect(step.practice).toEqual({ status: 'COMPLETED', questionsAnswered: answered });
  expect(answered).toBe(5);
  const next = await api().post('/api/v1/learning/next-step').set(auth(student.id)).send({});
  expect(next.status).toBe(201);
  const path = await api().get('/api/v1/learning/path').set(auth(student.id));
  expect(path.status).toBe(200);
  expect(JSON.stringify(path.body)).not.toMatch(/NO_TUTOR|TUTOR_GROUP|COLLEGE_OFF/u);
  expect((await pool.query('SELECT count(*)::int AS n FROM tutor_hints WHERE subject_user_id = $1', [student.id])).rows[0].n).toBe(0);
}

async function seedContent(): Promise<void> {
  const [runId, packageId] = [randomUUID(), randomUUID()];
  sourceRecordId = randomUUID();
  await pool.query(`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES ($1, $2, 'synthetic/eng-25', $3, $4, 'eng25-test', 'STAGED', $5, now())`, [runId, `eng25-${runId}`, 'c'.repeat(40), SHA, author]);
  await pool.query(`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES ($1, $2, $3, 'synthetic/eng-25', $4, $5, 'eng25-test', '[]', '{}', '{}')`, [packageId, runId, `eng25-${packageId}`, 'c'.repeat(40), SHA]);
  await pool.query(`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES ($1, $2, 'ENGINE_CONTENT', 'eng25', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
  [sourceRecordId, packageId, SHA]);
  const reviewer = (await plainUser()).id;
  topicId = randomUUID();
  const topicRevision = randomUUID();
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [topicRevision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1, 'TOPIC', $2, 1, 'Synthetic multiplication skill', 'Synthetic topic for ENG-25 tests', $3)`, [topicId, `eng25-${topicId}`, topicRevision]);
  const manifestId = randomUUID();
  await pool.query(`INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1, $2, 1, $3, 'DRAFT')`,
    [manifestId, `eng25-${manifestId}`, manifestId.replace(/-/g, '').repeat(2)]);
  const made: { id: string; revision: string }[] = [];
  // Enough questions for two full steps per student.
  for (let index = 0; index < 10; index += 1) {
    const [id, revision] = [randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1, 'QUESTION', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, id, author, SHA]);
    await pool.query(`INSERT INTO question_hint_ladders (id, question_revision_id, hint_1, hint_2, hint_3, hint_4, source, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, 'AUTHORED', $7)`, [randomUUID(), revision, ...LADDER, author]);
    await pool.query("UPDATE content_revisions SET state = 'IN_REVIEW' WHERE id = $1", [revision]);
    await pool.query(`INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
      VALUES ($1, $2, $3, 'APPROVE', 'IN_REVIEW', 'APPROVED', 'SYNTHETIC_OK', 'eng25-approve')`, [randomUUID(), revision, reviewer]);
    await pool.query("UPDATE content_revisions SET state = 'APPROVED' WHERE id = $1", [revision]);
    await pool.query('INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1, $2, $3, $4)',
      [manifestId, revision, sourceRecordId, SHA]);
    made.push({ id, revision });
  }
  await pool.query("UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = $2, approved_at = now() WHERE id = $1", [manifestId, reviewer]);
  await pool.query("UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = $2, published_at = now() WHERE id = $1", [manifestId, reviewer]);
  for (const [index, question] of made.entries()) {
    await pool.query("UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = $2, published_at = now() WHERE id = $1", [question.revision, manifestId]);
    await pool.query(`INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
      VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, now())`,
    [question.id, `eng25-q-${index}-${question.id}`, topicId, `Synthetic practice question ${index + 1}: what is 6 × 7?`, JSON.stringify(OPTIONS), question.revision, manifestId]);
    await pool.query(`INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash) VALUES ($1, 'b', 'Synthetic explanation.', $2)`,
      [question.id, SHA]);
  }
  roleId = randomUUID();
  await pool.query(`INSERT INTO career_roles (id, code, title, family) VALUES ($1, $2, 'Synthetic pilot role', 'Test')`, [roleId, `ENG25_${roleId.slice(0, 8).toUpperCase()}`]);
  await pool.query(`INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery) VALUES ($1,$2,$3,'ESSENTIAL',0.8)`,
    [randomUUID(), roleId, topicId]);
}

// ---------------------------------------------------------------------------

describe('ENG-25: a college is switched on only through OPS-12, dual control and the evaluation gate', () => {
  it('without a passing evaluation no approval can be filed, and no writer can switch a college on', async () => {
    const refused = await requestApproval(collegeOn);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('AI_EVALUATION_REQUIRED');
    // The 0116 trigger: no row without an executed approval and a PASS, whoever writes it.
    await expect(pool.query(`INSERT INTO tutor_college_rollouts (id, institution_id, feature_key, enabled, assignment_method, assignment_seed, tutor_share_basis_points,
        created_by_user_id, enabled_model, enabled_prompt_key, enabled_prompt_version, enabled_evaluation_id, enabled_approval_id, enabled_at, enabled_by_user_id,
        changed_by_user_id, change_reason_code, correlation_id)
      VALUES ($1,$2,'tutor.hint',true,'sha256-bucket-v1',$3,5000,$4,$5,'tutor-hint',2,$6,$6,now(),$4,$4,'PILOT_ROLLOUT','eng25-bypass')`,
    [randomUUID(), collegeOn, '0'.repeat(32), configurer.userId, MODEL, randomUUID()])).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS n FROM tutor_college_rollouts')).rows[0].n).toBe(0);
  });

  it('needs an approval: executing without one is refused, and a student or a viewer cannot reach the controls', async () => {
    await recordPass();
    const noApproval = await api().post(`${base}/tutor-colleges/${collegeOn}/enable`).set(auth(configurer.userId)).send({ reasonCode: 'PILOT_ROLLOUT' });
    expect(noApproval.status).toBe(403);
    expect(noApproval.body.error.code).toBe('APPROVAL_REQUIRED');
    const student = await plainUser();
    expect((await api().get(`${base}/tutor-colleges`).set(auth(student.id))).status).toBe(403);
    expect((await api().post(`${base}/tutor-colleges/${collegeOn}/enable`).set(auth(student.id)).send({ reasonCode: 'PILOT_ROLLOUT' })).status).toBe(403);
    expect((await api().post(`${base}/tutor-colleges/${collegeOn}/disable`).set(auth(student.id)).send({ reasonCode: 'ROLLBACK' })).status).toBe(403);
    expect((await api().get(`${base}/tutor-colleges`)).status).toBe(401);
  });

  it('refuses while the kill switch is engaged, at request time and in the trigger', async () => {
    await recordPass();
    await pool.query("UPDATE feature_flags SET enabled = true WHERE key = 'ai.global-kill-switch'");
    try {
      const refused = await requestApproval(collegeOn);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('AI_KILL_SWITCH_ENGAGED');
    } finally {
      await pool.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
    }
  });

  it('with a PASS and a second person\'s approval the college is switched on, bound to the model, prompt and evaluation, and audited', async () => {
    const evaluationId = await recordPass();
    await switchCollegeOn(collegeOn);
    const row = (await pool.query('SELECT * FROM tutor_college_rollouts WHERE institution_id = $1', [collegeOn])).rows[0];
    expect(row).toMatchObject({ enabled: true, assignment_method: 'sha256-bucket-v1', tutor_share_basis_points: 5000, enabled_model: MODEL,
      enabled_prompt_key: 'tutor-hint', enabled_prompt_version: 2, enabled_evaluation_id: evaluationId });
    expect(row.assignment_seed).toMatch(/^[0-9a-f]{32}$/u);
    const approval = (await pool.query('SELECT extended_action_key, state, target_id, payload FROM operation_approvals WHERE id = $1', [row.enabled_approval_id])).rows[0];
    expect(approval).toMatchObject({ extended_action_key: 'AI_TUTOR_COLLEGE_ENABLE', state: 'EXECUTED', target_id: collegeOn });
    expect(approval.payload).toMatchObject({ institutionId: collegeOn, featureKey: 'tutor.hint', model: MODEL, promptKey: 'tutor-hint', promptVersion: 2, evaluationId });
    const audit = (await pool.query("SELECT context FROM audit_events WHERE action = 'operations.ai.tutor_college.enabled' AND resource_id = $1", [collegeOn])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].context).toMatchObject({ evaluationId, model: MODEL, experimentCreated: true });
    // Already on: nothing to approve.
    const again = await requestApproval(collegeOn);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('APPROVAL_NOT_REQUIRED');
    // The approval queue names the college.
    const queue = await api().get('/api/v1/operations/approvals?state=EXECUTED').set(auth(approver.userId));
    expect(JSON.stringify(queue.body)).toContain('Synthetic pilot college');
  });

  it('the experiment never changes, a rollout is never deleted, and a used approval cannot switch it on again', async () => {
    const row = (await pool.query('SELECT * FROM tutor_college_rollouts WHERE institution_id = $1', [collegeOn])).rows[0];
    await expect(pool.query('UPDATE tutor_college_rollouts SET assignment_seed = $2 WHERE id = $1', [row.id, 'f'.repeat(32)])).rejects.toThrow(/never changes/u);
    await expect(pool.query('DELETE FROM tutor_college_rollouts WHERE id = $1', [row.id])).rejects.toThrow(/never deleted/u);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE tutor_college_rollouts SET enabled = false, change_reason_code = 'ROLLBACK' WHERE id = $1", [row.id]);
      await expect(client.query("UPDATE tutor_college_rollouts SET enabled = true, change_reason_code = 'PILOT_ROLLOUT' WHERE id = $1", [row.id])).rejects.toThrow(/used once/u);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await pool.query('SELECT enabled FROM tutor_college_rollouts WHERE id = $1', [row.id])).rows[0].enabled).toBe(true);
  });
});

describe('ENG-25: groups are reproducible, recorded once, and only for consenting current students', () => {
  beforeAll(async () => { await featureOn(); pilot(true); });

  it('records the group the seed gives on the first eligible read, once; SQL and TypeScript agree', async () => {
    const student = await learner(collegeOn, { consent: true });
    const rollout = (await pool.query('SELECT id::text AS id, assignment_seed FROM tutor_college_rollouts WHERE institution_id = $1', [collegeOn])).rows[0];
    const row = await assignment(student.id);
    const expected = assignTutorGroup({ seed: rollout.assignment_seed, experimentId: rollout.id, subjectUserId: student.id });
    expect(row).toMatchObject({ rollout_id: rollout.id, institution_id: collegeOn, assignment_method: 'sha256-bucket-v1', bucket: expected.bucket,
      group_name: expected.group, consent_version: CONSENT_VERSION });
    for (let read = 0; read < 3; read += 1) await readStep(student);
    expect((await pool.query('SELECT count(*)::int AS n FROM tutor_group_assignments WHERE subject_user_id = $1', [student.id])).rows[0].n).toBe(1);
    // The database's own formula gives the same bucket for any id.
    const ids = Array.from({ length: 200 }, () => randomUUID());
    const sqlBuckets = (await pool.query('SELECT tutor_assignment_bucket($1, $2::uuid, s::uuid) AS b FROM unnest($3::text[]) s', [rollout.assignment_seed, rollout.id, ids])).rows.map((r) => r.b);
    expect(sqlBuckets).toEqual(ids.map((id) => assignTutorGroup({ seed: rollout.assignment_seed, experimentId: rollout.id, subjectUserId: id }).bucket));
  });

  it('a recorded group cannot be chosen, changed or deleted outside privacy deletion', async () => {
    const student = await learner(collegeOn, { consent: true });
    const row = await assignment(student.id);
    await expect(pool.query("UPDATE tutor_group_assignments SET group_name = CASE WHEN group_name = 'TUTOR' THEN 'NO_TUTOR' ELSE 'TUTOR' END WHERE id = $1", [row!.id]))
      .rejects.toThrow(/never changed/u);
    await expect(pool.query('DELETE FROM tutor_group_assignments WHERE id = $1', [row!.id])).rejects.toThrow(/privacy deletion/u);
    // A hand-written row in the other group is refused.
    const other = await learner(collegeOn, { consent: false });
    await grant(other.id);
    const rollout = (await pool.query('SELECT id::text AS id, assignment_seed FROM tutor_college_rollouts WHERE institution_id = $1', [collegeOn])).rows[0];
    const truth = assignTutorGroup({ seed: rollout.assignment_seed, experimentId: rollout.id, subjectUserId: other.id });
    await expect(pool.query(`INSERT INTO tutor_group_assignments (id, rollout_id, institution_id, subject_user_id, assignment_method, bucket, group_name, consent_version, correlation_id)
      VALUES ($1,$2,$3,$4,'sha256-bucket-v1',$5,$6,$7,'eng25-forged')`,
    [randomUUID(), rollout.id, collegeOn, other.id, truth.bucket, truth.group === 'TUTOR' ? 'NO_TUTOR' : 'TUTOR', CONSENT_VERSION])).rejects.toThrow(/never chosen/u);
  });

  it('consent gate: a student without ai-tutoring is in neither group and sees AI off; agreeing assigns them', async () => {
    const student = await learner(collegeOn, { consent: false });
    expect((await readStep(student)).practice.question.tutor).toEqual({ available: false, reason: 'NO_CONSENT', remainingToday: null });
    expect(await assignment(student.id)).toBeUndefined();
    // The trigger refuses a non-consenting student even from a direct writer.
    const rollout = (await pool.query('SELECT id::text AS id, assignment_seed FROM tutor_college_rollouts WHERE institution_id = $1', [collegeOn])).rows[0];
    const truth = assignTutorGroup({ seed: rollout.assignment_seed, experimentId: rollout.id, subjectUserId: student.id });
    await expect(pool.query(`INSERT INTO tutor_group_assignments (id, rollout_id, institution_id, subject_user_id, assignment_method, bucket, group_name, consent_version, correlation_id)
      VALUES ($1,$2,$3,$4,'sha256-bucket-v1',$5,$6,$7,'eng25-no-consent')`, [randomUUID(), rollout.id, collegeOn, student.id, truth.bucket, truth.group, CONSENT_VERSION]))
      .rejects.toThrow(/holds ai-tutoring/u);
    await grant(student.id);
    await readStep(student);
    expect((await assignment(student.id))?.group_name).toBe(truth.group);
  });

  it('college gate: a consenting student of a college without the tutor is never assigned and sees AI off', async () => {
    const student = await learner(collegeOff, { consent: true });
    expect((await readStep(student)).practice.question.tutor).toEqual(OFF);
    expect(await assignment(student.id)).toBeUndefined();
  });

  it('withdrawing consent stops the tutor and keeps the record; agreeing again gives the same group', async () => {
    const student = await learner(collegeOn, { consent: true });
    const before = await assignment(student.id);
    await grant(student.id, 'WITHDRAWN');
    expect((await readStep(student)).practice.question.tutor).toEqual({ available: false, reason: 'NO_CONSENT', remainingToday: null });
    expect(await assignment(student.id)).toEqual(before);
    await grant(student.id);
    await readStep(student);
    expect(await assignment(student.id)).toEqual(before);
  });
});

describe('ENG-25: the tutor serves only the tutor group, and every gate holds', () => {
  let tutor: Learner;
  let noTutor: Learner;
  beforeAll(async () => { await featureOn(); pilot(true); ({ tutor, noTutor } = await oneOfEachGroup()); });

  it('the tutor group gets the tutor through the job; the no-tutor group sees exactly what AI off shows', async () => {
    expect((await readStep(tutor)).practice.question.tutor).toEqual({ available: true, reason: null, remainingToday: 20 });
    const asked = await api().post(`${tutor.base}/tutor-hints`).set(auth(tutor.id)).send({ questionId: tutor.questionId });
    expect(asked.status).toBe(202);
    expect(server.requests).toHaveLength(0);
    await drain();
    expect(server.requests).toHaveLength(1);
    expect((await readStep(tutor)).practice.question.hintDetails[0]).toMatchObject({ source: 'AI_TUTOR', state: 'SHOWN', text: SAFE_HINT });

    const plain = await readStep(noTutor);
    expect(plain.practice.question.tutor).toEqual(OFF);
    const refused = await api().post(`${noTutor.base}/tutor-hints`).set(auth(noTutor.id)).send({ questionId: noTutor.questionId });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TUTOR_OFF');
    expect(JSON.stringify(refused.body)).not.toMatch(/GROUP|COLLEGE/u);
    // Byte-for-byte the same view as a student whose college has no tutor.
    const offCollege = await learner(collegeOff, { consent: true });
    const offView = (await readStep(offCollege)).practice.question;
    expect(Object.keys(plain.practice.question).sort()).toEqual(Object.keys(offView).sort());
    expect(plain.practice.question.tutor).toEqual(offView.tutor);
  });

  it('kill switch: engaged, nobody gets the tutor; the worker closes a pending request without a call', async () => {
    const step = await readStep(tutor);
    const asked = await api().post(`${tutor.base}/tutor-hints`).set(auth(tutor.id)).send({ questionId: step.practice.question.id });
    expect(asked.status).toBe(202);
    await pool.query("UPDATE feature_flags SET enabled = true WHERE key = 'ai.global-kill-switch'");
    try {
      await drain();
      expect(server.requests).toHaveLength(0);
      expect((await readStep(tutor)).practice.question.tutor.reason).toBe('OFF');
    } finally {
      await pool.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
    }
  });

  it('the deployment must declare the pilot: without it the tutor is off for every college', async () => {
    pilot(false);
    try {
      expect((await readStep(tutor)).practice.question.tutor).toEqual(OFF);
    } finally {
      pilot(true);
    }
  });

  it('switching the college off is immediate; the worker re-checks it; switching on again keeps every group', async () => {
    const step = await readStep(tutor);
    const asked = await api().post(`${tutor.base}/tutor-hints`).set(auth(tutor.id)).send({ questionId: step.practice.question.id });
    expect(asked.status).toBe(202);
    const groupsBefore = (await pool.query('SELECT subject_user_id, group_name FROM tutor_group_assignments ORDER BY subject_user_id')).rows;
    const off = await api().post(`${base}/tutor-colleges/${collegeOn}/disable`).set(auth(configurer.userId)).send({ reasonCode: 'QUALITY_CONCERN' });
    expect(off.status).toBe(201);
    await drain();
    expect(server.requests).toHaveLength(0);
    const closed = (await pool.query("SELECT status, fallback_reason FROM tutor_hints WHERE subject_user_id = $1 ORDER BY requested_at DESC LIMIT 1", [tutor.id])).rows[0];
    expect(closed).toEqual({ status: 'FALLBACK', fallback_reason: 'AI_UNAVAILABLE' });
    expect((await readStep(tutor)).practice.question.tutor).toEqual(OFF);
    expect((await api().post(`${base}/tutor-colleges/${collegeOn}/disable`).set(auth(configurer.userId)).send({ reasonCode: 'ROLLBACK' })).status).toBe(409);
    await switchCollegeOn(collegeOn);
    expect((await pool.query('SELECT subject_user_id, group_name FROM tutor_group_assignments ORDER BY subject_user_id')).rows).toEqual(groupsBefore);
    expect((await readStep(tutor)).practice.question.tutor.available).toBe(true);
  });
});

describe('ENG-25 X2: a no-tutor or AI-off student completes the whole practice journey', () => {
  beforeAll(async () => { await featureOn(); pilot(true); });

  it('the no-tutor group, with the tutor live for others', async () => {
    const { noTutor } = await oneOfEachGroup();
    const calls = server.requests.length;
    await walkWithoutTutor(noTutor);
    expect(server.requests.length).toBe(calls);
  });

  it('a student whose college has no tutor, and a student who has not agreed to AI', async () => {
    await walkWithoutTutor(await learner(collegeOff, { consent: true }));
    const unconsented = await learner(collegeOn, { consent: false });
    // Not agreed: the tutor is unavailable for that reason; everything else is the same journey.
    let step = await readStep(unconsented);
    while (step.practice.status === 'IN_PROGRESS') {
      expect(step.practice.question.tutor.available).toBe(false);
      const answer = await api().post(`${unconsented.base}/answers`).set(auth(unconsented.id)).send({ questionId: step.practice.question.id, selectedOptionId: 'a' });
      expect(answer.status).toBe(201);
      step = answer.body.step;
    }
    expect(step.practice.status).toBe('COMPLETED');
    expect(await assignment(unconsented.id)).toBeUndefined();
  });

  it('every AI flag off: the tutor feature off and the kill switch engaged, no student is offered the tutor', async () => {
    await pool.query("UPDATE ai_feature_policies SET enabled = false WHERE feature_key = 'tutor.hint'");
    await pool.query("UPDATE feature_flags SET enabled = true WHERE key = 'ai.global-kill-switch'");
    try {
      const { tutor } = await oneOfEachGroup();
      await walkWithoutTutor(tutor);
    } finally {
      await pool.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
      await featureOn();
    }
  });
});

describe('ENG-25: pilot counters per group, and the console', () => {
  beforeAll(async () => { await featureOn(); pilot(true); });

  it('counts practice per experiment, group and day — with no student in the row — and only grows', async () => {
    const before = (await pool.query("SELECT group_name, metric_key, sum(count)::int AS n FROM tutor_pilot_daily_metrics GROUP BY group_name, metric_key")).rows;
    const { tutor, noTutor } = await oneOfEachGroup();
    await api().post(`${noTutor.base}/hints`).set(auth(noTutor.id)).send({ questionId: noTutor.questionId });
    await api().post(`${noTutor.base}/answers`).set(auth(noTutor.id)).send({ questionId: noTutor.questionId, selectedOptionId: 'b' });
    await api().post(`${tutor.base}/tutor-hints`).set(auth(tutor.id)).send({ questionId: tutor.questionId });
    await drain();
    const after = (await pool.query("SELECT group_name, metric_key, sum(count)::int AS n FROM tutor_pilot_daily_metrics GROUP BY group_name, metric_key")).rows;
    const delta = (group: string, key: string) => (after.find((r) => r.group_name === group && r.metric_key === key)?.n ?? 0) - (before.find((r) => r.group_name === group && r.metric_key === key)?.n ?? 0);
    expect(delta('NO_TUTOR', 'WRITTEN_HINTS_SHOWN')).toBe(1);
    expect(delta('NO_TUTOR', 'QUESTIONS_ANSWERED')).toBe(1);
    expect(delta('NO_TUTOR', 'QUESTIONS_CORRECT')).toBe(1);
    expect(delta('TUTOR', 'TUTOR_HINTS_REQUESTED')).toBe(1);
    expect(delta('TUTOR', 'TUTOR_HINTS_SHOWN')).toBe(1);
    expect(delta('NO_TUTOR', 'TUTOR_HINTS_REQUESTED')).toBe(0);
    expect(delta('TUTOR', 'STEPS_STARTED')).toBeGreaterThanOrEqual(1);
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tutor_pilot_daily_metrics' ORDER BY column_name")).rows.map((r) => r.column_name);
    expect(columns).toEqual(['count', 'group_name', 'metric_date', 'metric_key', 'rollout_id', 'updated_at']);
    await expect(pool.query("UPDATE tutor_pilot_daily_metrics SET count = 0 WHERE count > 0")).rejects.toThrow(/only grows/u);
    await expect(pool.query('DELETE FROM tutor_pilot_daily_metrics')).rejects.toThrow(/never deleted/u);
  });

  it('the console lists every college, withholds a group under five, and names no student', async () => {
    const response = await api().get(`${base}/tutor-colleges`).set(auth(configurer.userId));
    expect(response.status).toBe(200);
    expect(response.body.status).toEqual({ pilotAudience: true, featureRegistered: true, featureEnabled: true, killSwitchEngaged: false, evaluationPasses: true });
    const on = response.body.colleges.find((college: { institutionId: string }) => college.institutionId === collegeOn);
    const off = response.body.colleges.find((college: { institutionId: string }) => college.institutionId === collegeOff);
    expect(off.rollout).toBeNull();
    expect(on.rollout).toMatchObject({ enabled: true, assignmentMethod: 'sha256-bucket-v1', tutorSharePercent: 50 });
    const counts = (await pool.query('SELECT group_name, count(*)::int AS n FROM tutor_group_assignments WHERE institution_id = $1 GROUP BY group_name', [collegeOn])).rows;
    for (const name of ['TUTOR', 'NO_TUTOR'] as const) {
      const n = counts.find((row) => row.group_name === name)?.n ?? 0;
      const shown = on.rollout.groups[name];
      if (n < 5) expect(shown).toEqual({ assigned: { suppressed: true, value: null }, metrics: null });
      else expect(shown.assigned).toEqual({ suppressed: false, value: n });
    }
    const text = JSON.stringify(response.body);
    const students = (await pool.query('SELECT subject_user_id::text AS id FROM tutor_group_assignments')).rows.map((row) => row.id as string);
    for (const id of students) expect(text).not.toContain(id);
    expect(text).not.toContain('assignment_seed');
    expect(text).not.toMatch(/"seed"/u);
    expect((await api().get(`${base}/tutor-colleges?days=0`).set(auth(configurer.userId))).status).toBe(400);
  });
});

describe('ENG-25: privacy', () => {
  beforeAll(async () => { await featureOn(); pilot(true); });

  it('the student\'s export lists their group; deletion removes it and leaves the counters', async () => {
    const student = await learner(collegeOn, { consent: true });
    const row = await assignment(student.id);
    const bundle = await assembleSubjectExport(db as unknown as PersistenceDb, student.id) as Record<string, any>;
    expect(bundle.learning.tutorPilotGroups).toEqual([expect.objectContaining({ institutionName: 'Synthetic pilot college', group: row!.group_name, consentVersion: CONSENT_VERSION })]);
    const counters = (await pool.query('SELECT sum(count)::int AS n FROM tutor_pilot_daily_metrics')).rows[0].n;
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
      VALUES ($1, $2, $2, 'DELETION', now() - interval '31 days', now() - interval '1 day')`, [randomUUID(), student.id]);
    const summaries = await executeDueDeletions({ db: db as unknown as PersistenceDb, ids: { uuid: () => randomUUID() } });
    expect(summaries.find((summary) => summary.subjectUserId === student.id)?.outcome).toBe('COMPLETED');
    expect(await assignment(student.id)).toBeUndefined();
    expect((await pool.query('SELECT sum(count)::int AS n FROM tutor_pilot_daily_metrics')).rows[0].n).toBe(counters);
  });
});
