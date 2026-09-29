/**
 * API tests for the student learning experience (ENG-18) on seeded, synthetic data:
 * - C1: a new student with a target sees skip / review / learn groups in the first session;
 * - C3: a skill with one attempt shows "not enough evidence", never "developing";
 * - C4: every next step carries reasons, and replaying the stored decision gives the same decision;
 * - C7: a skill past its due interval comes first (path and next step), shown as due with no date;
 * - X2: all of it with every AI flag off (the default) and no model anywhere;
 * plus practice with the hint ladder (the server's hint level makes a success after hint 3 assisted, C5), the
 * attempt linked to its decision, no answer key / correct option / model number in any response, input and
 * ownership refusals (400 / 404 / 409), an honest empty state when nothing is published, the 0072 guard, and
 * privacy deletion of the new rows.
 */
import 'reflect-metadata';
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createTrustedJwtVerifier, type TrustedJwk } from '@planthepath/identity/src/jwt.js';
import { findIdentityByExternalSubject, loadActiveMembershipsForUser } from '@planthepath/persistence/src/identity-authentication.js';
import { setStudentCareerTarget } from '@planthepath/persistence/src/career-targets.js';
import { projectSubjectSkillState } from '@planthepath/persistence/src/learner-skill-state.js';
import { replayLearningDecision } from '@planthepath/persistence/src/learning-decisions.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import * as schema from '@planthepath/persistence/src/schema.js';
import { Phase1ApiSecurityModule } from './api-security.module.js';
import { executeDueDeletions } from './privacy-deletion.js';
import { PG_POOL } from '../persistence.provider.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for learning experience integration tests');

const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_testpool';
const clientId = 'plan-the-path-learning-experience-client';
const keyId = 'learning-experience-key';
const schemaName = `learning_exp_${process.pid}`;
const CONSENT_VERSION = 'eng18-api-synthetic';
const SHA = 'e'.repeat(64);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createTrustedJwtVerifier({
  issuer, clientId, tokenUse: 'access',
  jwks: [publicKeyToTrustedJwk(publicKey, keyId)],
  now: () => new Date('2026-08-16T12:00:00Z'),
});

let adminPool: Pool;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: INestApplication;
let author: string;
let reviewer: string;
let sourceRecordId: string;
// Topics: met, partial and unknown for the role; a fourth with nothing published.
let topicMet: string;
let topicPartial: string;
let topicUnknown: string;
let topicEmpty: string;
let roleId: string;
const keyOf = new Map<string, string>();
let ladderQuestion: string;

beforeAll(async () => {
  adminPool = new Pool({ connectionString });
  await adminPool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
  db = drizzle(pool, { schema });
  await applyMigrations(pool);
  const identityStore = {
    findByExternalSubject: (externalSubject: string) => findIdentityByExternalSubject(db, externalSubject),
    loadActiveMembershipsForUser: (userId: string) => loadActiveMembershipsForUser(db, userId),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [Phase1ApiSecurityModule.register({ verifier, identityStore, db })],
    providers: [{ provide: PG_POOL, useValue: pool }],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  // adaptive-learning, live for this suite only (publishing the real definition is HG-6).
  await pool.query("UPDATE consent_definitions SET retired_at = greatest(now(), effective_from) WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL");
  await pool.query(`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', $1, 'Synthetic adaptive learning purpose', 'OPTIONAL', true, now() - interval '1 minute')`, [CONSENT_VERSION]);

  author = (await student({ consent: false })).id;
  reviewer = (await student({ consent: false })).id;
  await seedSourceRecord();
  [topicMet, topicPartial, topicUnknown, topicEmpty] = [
    await topic('Synthetic met skill'), await topic('Synthetic partial skill'), await topic('Synthetic unknown skill'), await topic('Synthetic empty skill'),
  ];
  // Three questions on the partial skill (the first with a published hint ladder), two on the unknown one.
  const partialQuestions = await publishQuestions(topicPartial, 3, { ladderOnFirst: true });
  ladderQuestion = partialQuestions[0]!;
  await publishQuestions(topicUnknown, 2, { ladderOnFirst: false });

  roleId = randomUUID();
  await pool.query(`INSERT INTO career_roles (id, code, title, family) VALUES ($1, $2, 'Synthetic analyst role', 'Test')`,
    [roleId, `ENG18_${roleId.slice(0, 8).toUpperCase()}`]);
  await pool.query(`INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery)
    VALUES ($1,$2,$3,'ESSENTIAL',0.8), ($4,$2,$5,'ESSENTIAL',0.8), ($6,$2,$7,'IMPORTANT',0.6), ($8,$2,$9,'HELPFUL',0.6)`,
  [randomUUID(), roleId, topicMet, randomUUID(), topicPartial, randomUUID(), topicUnknown, randomUUID(), topicEmpty]);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await adminPool?.end();
});

const api = () => request(app.getHttpServer());
const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'x-correlation-id': `learning-${randomUUID()}` });

async function student(options: { consent: boolean }): Promise<{ id: string; token: string }> {
  const sub = `sub:${randomUUID()}`;
  const email = `${randomUUID()}@learning.test`;
  const id = randomUUID();
  await db.insert(schema.users).values({ id, externalSubject: sub, email, state: 'ACTIVE' });
  if (options.consent) {
    await pool.query(`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
      VALUES ($1, $2, 'adaptive-learning', $3, 'GRANTED', now() - interval '10 seconds')`, [randomUUID(), id, CONSENT_VERSION]);
  }
  return { id, token: signAccessToken(privateKey, { sub, email }) };
}

async function seedSourceRecord(): Promise<void> {
  const [runId, packageId] = [randomUUID(), randomUUID()];
  sourceRecordId = randomUUID();
  await pool.query(`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES ($1, $2, 'synthetic/eng-18', $3, $4, 'eng18-test', 'STAGED', $5, now())`, [runId, `eng18-${runId}`, 'c'.repeat(40), SHA, author]);
  await pool.query(`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES ($1, $2, $3, 'synthetic/eng-18', $4, $5, 'eng18-test', '[]', '{}', '{}')`, [packageId, runId, `eng18-${packageId}`, 'c'.repeat(40), SHA]);
  await pool.query(`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES ($1, $2, 'ENGINE_CONTENT', 'eng18', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
  [sourceRecordId, packageId, SHA]);
}

async function topic(name: string): Promise<string> {
  const [topicId, revision] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, topicId, author, SHA]);
  await pool.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
    VALUES ($1, 'TOPIC', $2, 1, $3, 'Synthetic topic for ENG-18 API tests', $4)`, [topicId, `eng18-${topicId}`, name, revision]);
  return topicId;
}

/** Publishes `count` synthetic questions on a topic through the content lifecycle; optionally a hint ladder on the first. */
async function publishQuestions(topicId: string, count: number, options: { ladderOnFirst: boolean }): Promise<string[]> {
  const manifestId = randomUUID();
  await pool.query(`INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1, $2, 1, $3, 'DRAFT')`,
    [manifestId, `eng18-${manifestId}`, manifestId.replace(/-/g, '').repeat(2)]);
  const questions: { id: string; revision: string; key: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const [id, revision] = [randomUUID(), randomUUID()];
    const key = ['a', 'b', 'c', 'd'][index % 4]!;
    await pool.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1, 'QUESTION', $2, 1, $3, 'DRAFT', $4, '{}')`, [revision, id, author, SHA]);
    if (options.ladderOnFirst && index === 0) {
      await pool.query(`INSERT INTO question_hint_ladders (id, question_revision_id, hint_1, hint_2, hint_3, hint_4, source, created_by_user_id)
        VALUES ($1, $2, 'Synthetic nudge', 'Synthetic strategy', 'Synthetic worked step', 'Synthetic near solution', 'AUTHORED', $3)`,
      [randomUUID(), revision, author]);
    }
    await pool.query("UPDATE content_revisions SET state = 'IN_REVIEW' WHERE id = $1", [revision]);
    await pool.query(`INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
      VALUES ($1, $2, $3, 'APPROVE', 'IN_REVIEW', 'APPROVED', 'SYNTHETIC_OK', 'eng18-approve')`, [randomUUID(), revision, reviewer]);
    await pool.query("UPDATE content_revisions SET state = 'APPROVED' WHERE id = $1", [revision]);
    await pool.query('INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1, $2, $3, $4)',
      [manifestId, revision, sourceRecordId, SHA]);
    questions.push({ id, revision, key });
  }
  await pool.query("UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = $2, approved_at = now() WHERE id = $1", [manifestId, reviewer]);
  await pool.query("UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = $2, published_at = now() WHERE id = $1", [manifestId, reviewer]);
  for (const [index, question] of questions.entries()) {
    await pool.query("UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = $2, published_at = now() WHERE id = $1", [question.revision, manifestId]);
    const options = ['a', 'b', 'c', 'd'].map((option) => ({ id: option, text: `Synthetic option ${option.toUpperCase()}` }));
    await pool.query(`INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
      VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, $7, now())`,
    [question.id, `eng18-q-${index}-${question.id}`, topicId, `Synthetic practice question ${index + 1}`, JSON.stringify(options), question.revision, manifestId]);
    await pool.query(`INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash) VALUES ($1, $2, 'Synthetic explanation.', $3)`,
      [question.id, question.key, SHA]);
    keyOf.set(question.id, question.key);
  }
  return questions.map((question) => question.id);
}

/** A student with the synthetic role as primary target, and a seeded current gap: met, partial, unknown, unknown. */
async function studentWithTarget(options: { consent: boolean }): Promise<{ id: string; token: string }> {
  const learner = await student(options);
  await setStudentCareerTarget(pool, { subjectUserId: learner.id, careerRoleId: roleId, priority: 'PRIMARY' });
  await pool.query("UPDATE career_gap_snapshots SET superseded_at = now() WHERE student_user_id = $1 AND superseded_at IS NULL", [learner.id]);
  const snapshotId = randomUUID();
  await pool.query(`INSERT INTO career_gap_snapshots (id, student_user_id, career_role_id, model_version, requirements_total, requirements_met, requirements_unknown)
    VALUES ($1, $2, $3, 'career-gap-v1', 4, 1, 2)`, [snapshotId, learner.id, roleId]);
  await pool.query(`INSERT INTO career_gap_items (id, snapshot_id, topic_id, requirement_level, target_mastery, observed_mastery, status, priority_rank) VALUES
    ($1, $2, $3, 'ESSENTIAL', 0.8, 0.9, 'MET', 1),
    ($4, $2, $5, 'ESSENTIAL', 0.8, 0.5, 'PARTIAL', 2),
    ($6, $2, $7, 'IMPORTANT', 0.6, NULL, 'UNKNOWN', 3),
    ($8, $2, $9, 'HELPFUL', 0.6, NULL, 'UNKNOWN', 4)`,
  [randomUUID(), snapshotId, topicMet, randomUUID(), topicPartial, randomUUID(), topicUnknown, randomUUID(), topicEmpty]);
  return learner;
}

/** One graded attempt fact on a topic, as a grading path writes it (for skill state and due reviews). */
async function pastAttempt(studentId: string, skillId: string, correct: boolean, daysAgo: number): Promise<void> {
  const [sessionId, sourceId] = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO learning_sessions (id, subject_user_id, mode, source_type, source_id, started_at, ended_at)
    VALUES ($1, $2, 'ASSESSMENT', 'assessment_attempt', $3, now() - make_interval(days => $4) - interval '5 minutes', now() - make_interval(days => $4))`,
  [sessionId, studentId, sourceId, daysAgo]);
  await pool.query(`INSERT INTO learning_attempt_events
      (id, subject_user_id, session_id, item_source, item_id, item_version, skill_id, context, answered, correct, score,
       highest_hint_level, assisted, content_version, source_attempt_type, source_attempt_id, occurred_at)
    VALUES ($1, $2, $3, 'CAREER_READINESS_QUESTION', $4, 1, $5, 'ASSESSMENT', true, $6, $7, 0, false, 'assessment-v1', 'assessment_attempt', $8,
      now() - make_interval(days => $9))`,
  [randomUUID(), studentId, sessionId, randomUUID(), skillId, correct, correct ? 1 : 0, sourceId, daysAgo]);
}

// Nothing a learner receives may carry a key, a model number or a readiness value.
const LEAKS = ['correctOption', 'correct_option', 'explanation', 'answerKey', 'answer_hash', 'observed', 'target_mastery', 'targetMastery',
  'likelihood', 'stability', 'difficulty', 'reviewDue', 'review_due', 'dueAt', 'percent', 'readiness', 'theta', 'ability', 'inputs'];
function expectNoLeak(body: unknown): void {
  const text = JSON.stringify(body);
  for (const leak of LEAKS) expect(text).not.toContain(leak);
}

describe('learning experience routes', () => {
  it('require a signed-in user', async () => {
    const id = randomUUID();
    expect((await api().get('/api/v1/learning/path')).status).toBe(401);
    expect((await api().post('/api/v1/learning/next-step')).status).toBe(401);
    expect((await api().get(`/api/v1/learning/steps/${id}`)).status).toBe(401);
    expect((await api().post(`/api/v1/learning/steps/${id}/hints`)).status).toBe(401);
    expect((await api().post(`/api/v1/learning/steps/${id}/answers`)).status).toBe(401);
  });

  it('with no target: nothing to group, and the next step says there is no target', async () => {
    const learner = await student({ consent: false });
    const path = await api().get('/api/v1/learning/path').set(auth(learner.token));
    expect(path.status).toBe(200);
    expect(path.body.path).toMatchObject({ adaptive: false, target: null, requirements: null, dueReviews: [], latestStep: null,
      groups: { policyVersion: 'learning-path-groups-v1', skip: [], review: [], learn: [] } });
    const step = await api().post('/api/v1/learning/next-step').set(auth(learner.token)).send({});
    expect(step.status).toBe(201);
    expect(step.body.step).toMatchObject({ action: 'NONE', skill: null, practice: { status: 'NO_SKILL' } });
    expect(step.body.step.reasonCodes).toEqual(['NO_CAREER_TARGET', 'NON_ADAPTIVE_NO_CONSENT']);
  });

  it('C1 and X2: a new student with a target sees skip / review / learn in the first session, with every AI flag off', async () => {
    expect(process.env.ASSISTANT_ENABLED === 'true').toBe(false);
    const learner = await studentWithTarget({ consent: false });
    const response = await api().get('/api/v1/learning/path').set(auth(learner.token));
    expect(response.status).toBe(200);
    const path = response.body.path;
    expectNoLeak(response.body);
    expect(path.adaptive).toBe(false);
    expect(path.target).toEqual({ careerRoleId: roleId, title: 'Synthetic analyst role' });
    expect(path.requirements).toEqual({ total: 4, met: 1, notMeasured: 2 });
    expect(path.groups.skip.map((entry: { skillId: string }) => entry.skillId)).toEqual([topicMet]);
    expect(path.groups.review.map((entry: { skillId: string }) => entry.skillId)).toEqual([topicPartial]);
    expect(path.groups.learn.map((entry: { skillId: string }) => entry.skillId)).toEqual([topicUnknown, topicEmpty]);
    expect(path.groups.learn[0]).toMatchObject({ skillName: 'Synthetic unknown skill', band: 'NOT_ENOUGH_EVIDENCE', due: false, reasonCodes: ['GAP_UNKNOWN'] });
    expect(path.dueReviews).toEqual([]);
  });

  it('C4: the next step carries its reasons and replays to the same decision; practice runs with the hint ladder (C5)', async () => {
    const learner = await studentWithTarget({ consent: false });
    const other = await studentWithTarget({ consent: false });
    const started = await api().post('/api/v1/learning/next-step').set(auth(learner.token)).send({ sessionMinutes: 20 });
    expect(started.status).toBe(201);
    let step = started.body.step;
    expectNoLeak(started.body);
    expect(step).toMatchObject({ action: 'PRACTICE', skill: { id: topicPartial, name: 'Synthetic partial skill' }, adaptive: false, strategyKind: null });
    expect(step.reasonCodes).toEqual(['GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'NON_ADAPTIVE_NO_CONSENT']);
    expect(await replayLearningDecision(db as unknown as PersistenceDb, step.decisionId)).toEqual({ decisionId: step.decisionId, status: 'MATCHED' });
    const pathAfter = await api().get('/api/v1/learning/path').set(auth(learner.token));
    expect(pathAfter.body.path.latestStep.decisionId).toBe(step.decisionId);

    // The first question is the one with a published ladder (fresh questions by stable key).
    expect(step.practice.status).toBe('IN_PROGRESS');
    expect(step.practice.question).toMatchObject({ id: ladderQuestion, position: 1, hintsAvailable: true, hints: [] });
    expect(step.practice.question.options.map((option: { id: string }) => option.id)).toEqual(['a', 'b', 'c', 'd']);
    const base = `/api/v1/learning/steps/${step.decisionId}`;

    // Refusals: bad input, another student's step, a question not being answered.
    expect((await api().post(`${base}/hints`).set(auth(learner.token)).send({ questionId: 'nope' })).status).toBe(400);
    expect((await api().post(`${base}/answers`).set(auth(learner.token)).send({ questionId: ladderQuestion, selectedOptionId: 'a', extra: 1 })).status).toBe(400);
    expect((await api().post('/api/v1/learning/next-step').set(auth(learner.token)).send({ sessionMinutes: 0 })).status).toBe(400);
    expect((await api().get('/api/v1/learning/steps/not-a-uuid').set(auth(learner.token))).status).toBe(400);
    const foreign = await api().post(`${base}/answers`).set(auth(other.token)).send({ questionId: ladderQuestion, selectedOptionId: 'a' });
    expect(foreign.status).toBe(404);
    expect((await api().get(base).set(auth(other.token))).status).toBe(404);
    const notCurrent = [...keyOf.keys()].find((id) => id !== ladderQuestion)!;
    const conflict = await api().post(`${base}/answers`).set(auth(learner.token)).send({ questionId: notCurrent, selectedOptionId: 'a' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('NOT_CURRENT_QUESTION');
    const invalid = await api().post(`${base}/answers`).set(auth(learner.token)).send({ questionId: ladderQuestion, selectedOptionId: 'z' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_OPTION');

    // Three hints, one level at a time, recorded by the server.
    for (const expected of [['Synthetic nudge'], ['Synthetic nudge', 'Synthetic strategy'], ['Synthetic nudge', 'Synthetic strategy', 'Synthetic worked step']]) {
      const hinted = await api().post(`${base}/hints`).set(auth(learner.token)).send({ questionId: ladderQuestion });
      expect(hinted.status).toBe(201);
      expect(hinted.body.step.practice.question.hints).toEqual(expected);
      expectNoLeak(hinted.body);
    }
    // The guard: a level cannot jump, and nothing else about a served row changes.
    await expect(pool.query('UPDATE learning_step_items SET hint_level = 0 WHERE decision_id = $1 AND item_id = $2', [step.decisionId, ladderQuestion]))
      .rejects.toThrow(/hint level/);

    // A right answer after hint 3 is recorded as assisted (C5), from the server's level.
    const answered = await api().post(`${base}/answers`).set(auth(learner.token)).send({ questionId: ladderQuestion, selectedOptionId: keyOf.get(ladderQuestion) });
    expect(answered.status).toBe(201);
    expectNoLeak(answered.body);
    expect(answered.body.feedback).toEqual({ questionId: ladderQuestion, correct: true, assisted: true });
    const attempt = await pool.query(`SELECT id, context, highest_hint_level, assisted, correct FROM learning_attempt_events
      WHERE source_attempt_type = 'learning_step' AND source_attempt_id = $1 AND item_id = $2`, [step.decisionId, ladderQuestion]);
    expect(attempt.rows[0]).toMatchObject({ context: 'PRACTICE', highest_hint_level: 3, assisted: true, correct: true });
    const linked = await pool.query('SELECT outcome_attempt_ids FROM learning_decisions WHERE id = $1', [step.decisionId]);
    expect(linked.rows[0].outcome_attempt_ids).toEqual([attempt.rows[0].id]);
    // Replaying the same answer returns what was recorded; the hint level is now history.
    const again = await api().post(`${base}/answers`).set(auth(learner.token)).send({ questionId: ladderQuestion, selectedOptionId: 'a' });
    expect(again.body.feedback).toEqual({ questionId: ladderQuestion, correct: true, assisted: true });
    await expect(pool.query('UPDATE learning_step_items SET hint_level = 4 WHERE decision_id = $1 AND item_id = $2', [step.decisionId, ladderQuestion]))
      .rejects.toThrow(/hint level/);

    // The next question has no ladder: it says so, and a wrong unaided answer is not assisted.
    step = answered.body.step;
    expect(step.practice).toMatchObject({ status: 'IN_PROGRESS', questionsAnswered: 1, question: { position: 2, hintsAvailable: false, hints: [] } });
    const second = step.practice.question.id;
    const noHints = await api().post(`${base}/hints`).set(auth(learner.token)).send({ questionId: second });
    expect(noHints.status).toBe(409);
    expect(noHints.body.error.code).toBe('NO_HINTS');
    const wrong = ['a', 'b', 'c', 'd'].find((option) => option !== keyOf.get(second))!;
    const wrongAnswer = await api().post(`${base}/answers`).set(auth(learner.token)).send({ questionId: second, selectedOptionId: wrong });
    expect(wrongAnswer.body.feedback).toEqual({ questionId: second, correct: false, assisted: false });
    step = wrongAnswer.body.step;
    const third = step.practice.question.id;
    const last = await api().post(`${base}/answers`).set(auth(learner.token)).send({ questionId: third, selectedOptionId: keyOf.get(third) });
    expect(last.body.step.practice).toEqual({ status: 'COMPLETED', questionsAnswered: 3 });
    const session = await pool.query("SELECT mode, ended_at FROM learning_sessions WHERE source_type = 'learning_step' AND source_id = $1", [step.decisionId]);
    expect(session.rows[0].mode).toBe('PRACTICE');
    expect(session.rows[0].ended_at).not.toBeNull();
    const outcomes = await pool.query('SELECT cardinality(outcome_attempt_ids) AS n FROM learning_decisions WHERE id = $1', [step.decisionId]);
    expect(Number(outcomes.rows[0].n)).toBe(3);

    // A newer step supersedes this one: acting on the old one is refused.
    const next = await api().post('/api/v1/learning/next-step').set(auth(learner.token)).send({});
    expect(next.status).toBe(201);
    const superseded = await api().post(`${base}/hints`).set(auth(learner.token)).send({ questionId: third });
    expect(superseded.status).toBe(409);
    expect(superseded.body.error.code).toBe('STEP_SUPERSEDED');
    expect(await replayLearningDecision(db as unknown as PersistenceDb, next.body.step.decisionId)).toMatchObject({ status: 'MATCHED' });
  });

  it('a step on a skill with nothing published says so and records nothing', async () => {
    const learner = await studentWithTarget({ consent: false });
    // Only the empty skill is open: the planner goes there.
    await pool.query(`UPDATE career_gap_items SET status = 'MET', observed_mastery = 0.9
      WHERE snapshot_id = (SELECT id FROM career_gap_snapshots WHERE student_user_id = $1 AND superseded_at IS NULL) AND topic_id <> $2`, [learner.id, topicEmpty]);
    const started = await api().post('/api/v1/learning/next-step').set(auth(learner.token)).send({});
    expect(started.body.step).toMatchObject({ action: 'LEARN', skill: { id: topicEmpty }, lessons: [], practice: { status: 'NO_PRACTICE' } });
    const items = await pool.query('SELECT 1 FROM learning_step_items WHERE decision_id = $1', [started.body.step.decisionId]);
    expect(items.rowCount).toBe(0);
    const sessions = await pool.query("SELECT 1 FROM learning_sessions WHERE source_type = 'learning_step' AND source_id = $1", [started.body.step.decisionId]);
    expect(sessions.rowCount).toBe(0);
  });

  it('C3: a skill with one attempt shows "not enough evidence", never "developing"', async () => {
    const learner = await studentWithTarget({ consent: true });
    await pastAttempt(learner.id, topicUnknown, true, 0);
    await projectSubjectSkillState(db as unknown as PersistenceDb, learner.id);
    const path = (await api().get('/api/v1/learning/path').set(auth(learner.token))).body.path;
    expect(path.adaptive).toBe(true);
    const entry = path.groups.review.find((item: { skillId: string }) => item.skillId === topicUnknown);
    expect(entry).toMatchObject({ band: 'NOT_ENOUGH_EVIDENCE', due: false, reasonCodes: ['PRACTISED_BEFORE', 'GAP_UNKNOWN'] });
    expect(JSON.stringify(path)).not.toContain('DEVELOPING');
  });

  it('C7: a skill past its due interval comes first on the path and as the next step, due with no date', async () => {
    const learner = await studentWithTarget({ consent: true });
    await pastAttempt(learner.id, topicUnknown, true, 120);
    await projectSubjectSkillState(db as unknown as PersistenceDb, learner.id);
    const response = await api().get('/api/v1/learning/path').set(auth(learner.token));
    expectNoLeak(response.body);
    const path = response.body.path;
    expect(path.groups.review[0]).toMatchObject({ skillId: topicUnknown, due: true, reasonCodes: ['DUE_REVIEW'] });
    expect(path.dueReviews).toEqual([{ skillId: topicUnknown, skillName: 'Synthetic unknown skill' }]);

    const started = await api().post('/api/v1/learning/next-step').set(auth(learner.token)).send({ sessionMinutes: 10 });
    const step = started.body.step;
    expect(step).toMatchObject({ action: 'REVIEW', skill: { id: topicUnknown }, adaptive: true });
    expect(step.reasonCodes[0]).toBe('DUE_REVIEW');
    expect(await replayLearningDecision(db as unknown as PersistenceDb, step.decisionId)).toMatchObject({ status: 'MATCHED' });
    // The review is practised in a REVIEW session and recorded as REVIEW attempts.
    const question = step.practice.question.id;
    await api().post(`/api/v1/learning/steps/${step.decisionId}/answers`).set(auth(learner.token)).send({ questionId: question, selectedOptionId: keyOf.get(question) });
    const recorded = await pool.query(`SELECT e.context, s.mode FROM learning_attempt_events e JOIN learning_sessions s ON s.id = e.session_id
      WHERE e.source_attempt_type = 'learning_step' AND e.source_attempt_id = $1`, [step.decisionId]);
    expect(recorded.rows).toEqual([{ context: 'REVIEW', mode: 'REVIEW' }]);
  });

  it('privacy deletion erases the served step items with the rest of the learning activity', async () => {
    const learner = await studentWithTarget({ consent: false });
    const started = await api().post('/api/v1/learning/next-step').set(auth(learner.token)).send({});
    const question = started.body.step.practice.question.id;
    await api().post(`/api/v1/learning/steps/${started.body.step.decisionId}/answers`).set(auth(learner.token)).send({ questionId: question, selectedOptionId: 'a' });
    await expect(pool.query('DELETE FROM learning_step_items WHERE subject_user_id = $1', [learner.id])).rejects.toThrow(/privacy deletion/);
    await pool.query(`INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, requested_at, deletion_scheduled_for)
      VALUES ($1, $2, $2, 'DELETION', now() - interval '31 days', now() - interval '1 day')`, [randomUUID(), learner.id]);
    const summaries = await executeDueDeletions({ db: db as unknown as PersistenceDb, ids: { uuid: () => randomUUID() } });
    expect(summaries.find((summary) => summary.subjectUserId === learner.id)?.outcome).toBe('COMPLETED');
    for (const table of ['learning_step_items', 'learning_attempt_events', 'learning_sessions', 'learning_decisions']) {
      const left = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE subject_user_id = $1`, [learner.id]);
      expect(left.rows[0].count).toBe(0);
    }
  });
});

async function applyMigrations(targetPool: Pool): Promise<void> {
  const migrationDir = new URL('../../../../packages/persistence/drizzle/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const migrationName of migrations) {
    const migration = (await readFile(new URL(migrationName, migrationDir), 'utf8'))
      .replaceAll("table_schema = 'public'", 'table_schema = current_schema()');
    await targetPool.query(migration);
  }
}

function signAccessToken(signingKey: KeyObject, input: { readonly sub: string; readonly email: string }): string {
  const header = base64UrlJson({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const payload = base64UrlJson({
    iss: issuer, sub: input.sub, client_id: clientId, token_use: 'access',
    exp: Math.floor(new Date('2026-08-16T13:00:00Z').getTime() / 1000),
    iat: Math.floor(new Date('2026-08-16T11:00:00Z').getTime() / 1000),
    email: input.email, email_verified: true,
  });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(signingKey).toString('base64url')}`;
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function publicKeyToTrustedJwk(key: KeyObject, kid: string): TrustedJwk {
  const jwk = key.export({ format: 'jwk' }) as JsonWebKey;
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') throw new Error('invalid test key');
  return { kty: 'RSA', kid, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' };
}
