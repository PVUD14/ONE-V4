/**
 * Database tests for the placement test's online path (ENG-14, migration 0064): it fails closed
 * without the adaptive-learning purpose or without 25 published, calibrated aptitude items; it
 * serves only such items, one at a time, and never an answer key or a parameter; answers become
 * DIAGNOSTIC attempts that request the skill-state projection; it stops within 25 questions and at
 * the 25-minute deadline; a retest avoids earlier questions; and the tables are append-only and
 * erasable only by privacy deletion.
 *
 * Every person, topic and item is synthetic, and every case runs inside a transaction that is
 * rolled back.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema.js';
import type { PersistenceDb } from '../src/repositories.js';
import {
  PlacementTestError,
  answerPlacementQuestion,
  loadEligiblePlacementItems,
  readPlacementTest,
  startPlacementTest,
  type PlacementTestView,
} from '../src/placement-tests.js';
import { projectSubjectSkillState, LEARNER_SKILL_STATE_PROJECTION_REQUESTED } from '../src/learner-skill-state.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema }) as unknown as PersistenceDb;
const migrationDir = new URL('../drizzle/', import.meta.url);
const CONSENT_VERSION = 'eng14-synthetic-test';
const SHA = 'e'.repeat(64);

class Rollback extends Error {}
type QueryResult<T> = { rows: T[] };

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});
afterAll(async () => { await pool.end(); });

/** Runs the case in a transaction that is always rolled back; a real failure surfaces unchanged. */
async function inRollback(body: (tx: PersistenceDb) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx as unknown as PersistenceDb);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return;
    throw error;
  }
}

async function rows<T>(tx: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await tx.execute(query)) as QueryResult<T>).rows;
}

async function user(tx: PersistenceDb): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO users (id, email, state) VALUES (${id}::uuid, ${`${id}@example.test`}, 'ACTIVE')`);
  return id;
}

/** adaptive-learning live at a test-only version, inside the rolled-back transaction. */
async function liveAdaptiveLearning(tx: PersistenceDb): Promise<void> {
  await tx.execute(sql`UPDATE consent_definitions SET retired_at = greatest(now(), effective_from)
    WHERE consent_key = 'adaptive-learning' AND retired_at IS NULL`);
  await tx.execute(sql`INSERT INTO consent_definitions (consent_key, version, title, enforcement, withdrawable, effective_from)
    VALUES ('adaptive-learning', ${CONSENT_VERSION}, 'Test purpose', 'OPTIONAL', true, now() - interval '1 minute')`);
}

async function consent(tx: PersistenceDb, subject: string, action: 'GRANTED' | 'WITHDRAWN', secondsAgo: number): Promise<void> {
  await tx.execute(sql`INSERT INTO user_consents (id, user_id, consent_key, version, action, recorded_at)
    VALUES (${randomUUID()}::uuid, ${subject}::uuid, 'adaptive-learning', ${CONSENT_VERSION}, ${action}, now() - make_interval(secs => ${secondsAgo}))`);
}

async function consentingStudent(tx: PersistenceDb): Promise<string> {
  const id = await user(tx);
  await consent(tx, id, 'GRANTED', 30);
  return id;
}

interface Bank {
  readonly questionIds: string[];
  readonly keyOf: Map<string, string>;
  readonly topics: string[];
}

/**
 * Publishes `count` synthetic aptitude questions through the 0004 lifecycle, spread over three
 * active apt-* topics, and calibrates the first `calibrated` of them in one run.
 */
async function publishAptitudeBank(tx: PersistenceDb, count: number, options: { calibrated?: number; topicPrefix?: string } = {}): Promise<Bank> {
  const calibrated = options.calibrated ?? count;
  const author = await user(tx);
  const reviewer = await user(tx);
  const suffix = randomUUID().slice(0, 8);
  const runId = randomUUID();
  const packageId = randomUUID();
  const sourceRecordId = randomUUID();
  await tx.execute(sql`INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
    VALUES (${runId}::uuid, ${`eng14-${runId}`}, 'synthetic/eng-14', ${'c'.repeat(40)}, ${SHA}, 'eng14-test', 'STAGED', ${author}::uuid, now())`);
  await tx.execute(sql`INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES (${packageId}::uuid, ${runId}::uuid, ${`eng14-${packageId}`}, 'synthetic/eng-14', ${'c'.repeat(40)}, ${SHA}, 'eng14-test', '[]', '{}', '{}')`);
  await tx.execute(sql`INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
      rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
    VALUES (${sourceRecordId}::uuid, ${packageId}::uuid, 'ENGINE_CONTENT', 'eng14', 'synthetic.json', ${SHA}, 'Synthetic',
      'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`);

  const prefixes = options.topicPrefix ? [options.topicPrefix] : ['apt-q', 'apt-l', 'apt-v'];
  const topics: string[] = [];
  for (const prefix of prefixes) {
    const topicId = randomUUID();
    const revision = randomUUID();
    await tx.execute(sql`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES (${revision}::uuid, 'TOPIC', ${topicId}::uuid, 1, ${author}::uuid, 'DRAFT', ${SHA}, '{}')`);
    await tx.execute(sql`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
      VALUES (${topicId}::uuid, 'TOPIC', ${`${prefix}-eng14-${suffix}`}, 1, 'Synthetic aptitude skill', 'Synthetic topic for ENG-14 tests', ${revision}::uuid)`);
    topics.push(topicId);
  }

  const manifestId = randomUUID();
  await tx.execute(sql`INSERT INTO release_manifests (id, name, version, manifest_hash, status)
    VALUES (${manifestId}::uuid, ${`eng14-${manifestId}`}, 1, ${manifestId.replace(/-/g, '').repeat(2)}, 'DRAFT')`);
  const questions: { id: string; revision: string; topic: string; prompt: string; options: { id: string; text: string }[]; key: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    const revision = randomUUID();
    const topic = topics[index % topics.length]!;
    const key = ['a', 'b', 'c', 'd'][index % 4]!;
    const options = ['a', 'b', 'c', 'd'].map((option) => ({ id: option, text: `Synthetic option ${option.toUpperCase()}` }));
    const prompt = `Synthetic placement question ${index + 1}`;
    await tx.execute(sql`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES (${revision}::uuid, 'QUESTION', ${id}::uuid, 1, ${author}::uuid, 'DRAFT', ${SHA}, ${JSON.stringify({ prompt, options, correctOptionId: key })}::jsonb)`);
    await tx.execute(sql`UPDATE content_revisions SET state = 'IN_REVIEW' WHERE id = ${revision}::uuid`);
    await tx.execute(sql`INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
      VALUES (${randomUUID()}::uuid, ${revision}::uuid, ${reviewer}::uuid, 'APPROVE', 'IN_REVIEW', 'APPROVED', 'SYNTHETIC_OK', 'eng14-approve')`);
    await tx.execute(sql`UPDATE content_revisions SET state = 'APPROVED' WHERE id = ${revision}::uuid`);
    await tx.execute(sql`INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash)
      VALUES (${manifestId}::uuid, ${revision}::uuid, ${sourceRecordId}::uuid, ${SHA})`);
    questions.push({ id, revision, topic, prompt, options, key });
  }
  await tx.execute(sql`UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = ${reviewer}::uuid, approved_at = now() WHERE id = ${manifestId}::uuid`);
  await tx.execute(sql`UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = ${reviewer}::uuid, published_at = now() WHERE id = ${manifestId}::uuid`);
  for (const question of questions) {
    await tx.execute(sql`UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = ${manifestId}::uuid, published_at = now() WHERE id = ${question.revision}::uuid`);
    await tx.execute(sql`INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
      VALUES (${question.id}::uuid, ${`eng14-q-${question.id}`}, 1, ${question.topic}::uuid, ${question.prompt}, ${JSON.stringify(question.options)}::jsonb,
        ${question.revision}::uuid, ${manifestId}::uuid, now())`);
    await tx.execute(sql`INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash)
      VALUES (${question.id}::uuid, ${question.key}, 'Synthetic.', ${SHA})`);
  }

  if (calibrated > 0) {
    const run = randomUUID();
    await tx.execute(sql`INSERT INTO item_calibration_runs (id, source, algorithm_id, library, min_responses, learners_read, responses_read, items_read, exported_at, generated_at)
      VALUES (${run}::uuid, 'jobs/calibration', 'item-calibration-2pl-v1', 'girth==0.8.0', 200, 400, 400, ${calibrated}, now(), now())`);
    for (const [index, question] of questions.slice(0, calibrated).entries()) {
      const difficulty = Number((-2 + (4 * index) / Math.max(1, calibrated - 1)).toFixed(4));
      const provisional = index % 5 === 4;
      await tx.execute(sql`INSERT INTO item_calibrations (id, run_id, item_source, item_id, item_version, model, difficulty, discrimination, responses_used, status, status_reason)
        VALUES (${randomUUID()}::uuid, ${run}::uuid, 'CAREER_READINESS_QUESTION', ${question.id}::uuid, 1, '2PL', ${difficulty}, ${provisional ? 1 : 1.4},
          ${provisional ? 50 : 250}, ${provisional ? 'PROVISIONAL' : 'CALIBRATED'}, ${provisional ? 'TOO_FEW_RESPONSES' : null})`);
    }
  }
  return { questionIds: questions.map((question) => question.id), keyOf: new Map(questions.map((question) => [question.id, question.key])), topics };
}

function inProgress(view: PlacementTestView): Extract<PlacementTestView, { status: 'IN_PROGRESS' }> {
  if (view.status !== 'IN_PROGRESS') throw new Error(`expected IN_PROGRESS, got ${view.status}`);
  return view;
}

/** Answers until the sitting ends; right on even positions, wrong on odd ones. */
async function answerToTheEnd(tx: PersistenceDb, subject: string, bank: Bank, first: PlacementTestView): Promise<{ final: PlacementTestView; asked: string[] }> {
  let view = first;
  const asked: string[] = [];
  while (view.status === 'IN_PROGRESS') {
    const question = view.question;
    asked.push(question.id);
    const key = bank.keyOf.get(question.id)!;
    const wrong = ['a', 'b', 'c', 'd'].find((option) => option !== key)!;
    view = await answerPlacementQuestion(tx, {
      subjectUserId: subject, placementTestId: view.placementTestId, questionId: question.id,
      selectedOptionId: question.position % 2 === 0 ? key : wrong,
    });
    if (asked.length > 30) throw new Error('the sitting did not end');
  }
  return { final: view, asked };
}

async function expectPlacementError(action: Promise<unknown>, code: string): Promise<void> {
  const error = await action.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PlacementTestError);
  expect((error as PlacementTestError).code).toBe(code);
}

describe('fails closed', () => {
  it('serves nothing without the live adaptive-learning purpose, even to a student who once granted it', async () => {
    await inRollback(async (tx) => {
      await liveAdaptiveLearning(tx);
      await publishAptitudeBank(tx, 30);
      const never = await user(tx);
      const withdrawn = await consentingStudent(tx);
      await consent(tx, withdrawn, 'WITHDRAWN', 10);
      for (const subject of [never, withdrawn]) {
        expect(await readPlacementTest(tx, subject)).toEqual({ status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' });
        expect(await startPlacementTest(tx, { subjectUserId: subject })).toEqual({ status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' });
      }
      await tx.execute(sql`UPDATE consent_definitions SET retired_at = now() WHERE consent_key = 'adaptive-learning' AND version = ${CONSENT_VERSION}`);
      const granted = await consentingStudent(tx);
      expect(await startPlacementTest(tx, { subjectUserId: granted })).toEqual({ status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' });
      expect(await rows(tx, sql`SELECT 1 FROM placement_tests WHERE subject_user_id IN (${never}::uuid, ${withdrawn}::uuid, ${granted}::uuid)`)).toEqual([]);
    });
  });

  it('is not available with fewer than 25 published, calibrated aptitude items, and writes nothing', async () => {
    await inRollback(async (tx) => {
      await liveAdaptiveLearning(tx);
      const student = await consentingStudent(tx);
      const before = (await loadEligiblePlacementItems(tx)).length;
      // 30 published aptitude items, only 24 of them calibrated; 10 calibrated items on a topic outside the block.
      await publishAptitudeBank(tx, 30, { calibrated: 24 });
      await publishAptitudeBank(tx, 10, { topicPrefix: 'soc' });
      expect((await loadEligiblePlacementItems(tx)).length - before).toBe(24);
      if (before + 24 < 25) {
        expect(await readPlacementTest(tx, student)).toEqual({ status: 'NOT_AVAILABLE', reason: 'NOT_ENOUGH_ITEMS' });
        expect(await startPlacementTest(tx, { subjectUserId: student })).toEqual({ status: 'NOT_AVAILABLE', reason: 'NOT_ENOUGH_ITEMS' });
        expect(await rows(tx, sql`SELECT 1 FROM placement_tests WHERE subject_user_id = ${student}::uuid`)).toEqual([]);
      }
    });
  });

  it('never serves a superseded item, an item on an inactive topic, or ENG-10 drafts', async () => {
    await inRollback(async (tx) => {
      const bank = await publishAptitudeBank(tx, 6);
      const eligible = new Set((await loadEligiblePlacementItems(tx)).map((item) => item.key));
      expect(bank.questionIds.every((id) => eligible.has(id))).toBe(true);
      await tx.execute(sql`UPDATE question_versions SET superseded_at = now() WHERE id = ${bank.questionIds[0]!}::uuid`);
      await tx.execute(sql`UPDATE taxonomy_nodes SET active = false WHERE id = ${bank.topics[1]!}::uuid`);
      const after = new Set((await loadEligiblePlacementItems(tx)).map((item) => item.key));
      expect(after.has(bank.questionIds[0]!)).toBe(false);
      expect(after.has(bank.questionIds[1]!)).toBe(false); // on the now-inactive topic
      expect(after.has(bank.questionIds[2]!)).toBe(true);
      // Draft question revisions (ENG-10's whole bank) have no question_versions row, so nothing to serve.
      const drafts = await rows<{ count: number }>(tx, sql`
        SELECT count(*)::int AS count FROM question_versions q JOIN content_revisions r ON r.id = q.content_revision_id WHERE r.state <> 'PUBLISHED'`);
      expect(drafts[0]!.count).toBe(0);
    });
  });
});

describe('a sitting', () => {
  it('serves one question at a time without keys or parameters, records DIAGNOSTIC attempts and ends within 25', async () => {
    await inRollback(async (tx) => {
      await liveAdaptiveLearning(tx);
      const bank = await publishAptitudeBank(tx, 36);
      const student = await consentingStudent(tx);
      expect(await readPlacementTest(tx, student)).toEqual({ status: 'NOT_STARTED' });

      const started = inProgress(await startPlacementTest(tx, { subjectUserId: student }));
      expect(started.question.position).toBe(1);
      expect(started.questionsAnswered).toBe(0);
      expect(started.maxQuestions).toBe(25);
      expect(Object.keys(started.question).sort()).toEqual(['id', 'options', 'position', 'prompt']);
      expect(started.question.options.every((option) => Object.keys(option).sort().join() === 'id,text')).toBe(true);
      const serialized = JSON.stringify(started);
      for (const leak of ['correct', 'difficulty', 'discrimination', 'theta', 'standardError', 'calibration', 'readiness']) {
        expect(serialized).not.toContain(leak);
      }
      // Starting again resumes the same sitting and question.
      expect(await startPlacementTest(tx, { subjectUserId: student })).toEqual(started);
      expect(await readPlacementTest(tx, student)).toEqual(started);

      const { final, asked } = await answerToTheEnd(tx, student, bank, started);
      expect(final.status).toBe('COMPLETED');
      if (final.status !== 'COMPLETED') return;
      expect(final.questionsAnswered).toBe(asked.length);
      expect(asked.length).toBeLessThanOrEqual(25);
      expect(new Set(asked).size).toBe(asked.length);
      expect(['CONFIDENT', 'MAX_ITEMS']).toContain(final.stopReason);
      expect(['AWARE', 'GUIDED', 'INDEPENDENT', 'TROUBLESHOOT', 'NOT_ENOUGH_EVIDENCE']).toContain(final.placementLevel);
      expect(Object.keys(final).sort()).toEqual(['completedAt', 'placementLevel', 'placementTestId', 'questionsAnswered', 'status', 'stopReason']);
      expect(await readPlacementTest(tx, student)).toEqual(final);

      const attempts = await rows<{ context: string; source_attempt_type: string; skill_id: string | null; content_version: string; mode: string; ended: boolean }>(tx, sql`
        SELECT e.context, e.source_attempt_type, e.skill_id::text AS skill_id, e.content_version, s.mode, s.ended_at IS NOT NULL AS ended
        FROM learning_attempt_events e JOIN learning_sessions s ON s.id = e.session_id
        WHERE e.subject_user_id = ${student}::uuid`);
      expect(attempts).toHaveLength(asked.length);
      expect(attempts.every((row) => row.context === 'DIAGNOSTIC' && row.source_attempt_type === 'placement_test'
        && row.content_version === 'placement-v1' && row.mode === 'DIAGNOSTIC' && row.ended && bank.topics.includes(row.skill_id!))).toBe(true);
      const sittings = await rows<{ state: string; items_answered: number; session_closed: boolean }>(tx, sql`
        SELECT t.state, t.items_answered, s.ended_at = t.completed_at AS session_closed
        FROM placement_tests t JOIN learning_sessions s ON s.id = t.session_id WHERE t.subject_user_id = ${student}::uuid`);
      expect(sittings).toEqual([{ state: 'COMPLETED', items_answered: asked.length, session_closed: true }]);

      // Every served item carries the snapshot of the calibration it was served under.
      const snapshots = await rows<{ matches: boolean }>(tx, sql`
        SELECT (i.difficulty = c.difficulty AND i.discrimination = c.discrimination AND i.calibration_status = c.status AND i.calibration_run_id = c.run_id) AS matches
        FROM placement_test_items i JOIN item_calibrations c ON c.item_id = i.item_id AND c.item_version = i.item_version
        WHERE i.subject_user_id = ${student}::uuid`);
      expect(snapshots).toHaveLength(asked.length);
      expect(snapshots.every((row) => row.matches)).toBe(true);

      // Each answer asked for the skill-state projection, and the existing projector learns from them.
      const requests = await rows<{ count: number }>(tx, sql`
        SELECT count(*)::int AS count FROM outbox_events WHERE event_type = ${LEARNER_SKILL_STATE_PROJECTION_REQUESTED} AND aggregate_id = ${student}`);
      expect(requests[0]!.count).toBe(asked.length);
      const projected = await projectSubjectSkillState(tx, student);
      expect(projected.consented).toBe(true);
      const skillRows = await rows<{ skill_id: string; attempt_count: number }>(tx, sql`
        SELECT skill_id::text AS skill_id, attempt_count FROM learner_skill_state WHERE subject_user_id = ${student}::uuid`);
      expect(skillRows.map((row) => row.skill_id).sort()).toEqual([...bank.topics].sort());
      expect(skillRows.reduce((sum, row) => sum + Number(row.attempt_count), 0)).toBe(asked.length);

      // Nothing about readiness was written.
      expect(await rows(tx, sql`SELECT 1 FROM readiness_snapshots WHERE subject_user_id = ${student}::uuid`)).toEqual([]);
      expect(await rows(tx, sql`SELECT 1 FROM evidence_records WHERE subject_user_id = ${student}::uuid`)).toEqual([]);
    });
  });

  it('refuses an answer to anything but the served question, an unknown option, and another student', async () => {
    await inRollback(async (tx) => {
      await liveAdaptiveLearning(tx);
      const bank = await publishAptitudeBank(tx, 30);
      const student = await consentingStudent(tx);
      const other = await consentingStudent(tx);
      const started = inProgress(await startPlacementTest(tx, { subjectUserId: student }));
      const notServed = bank.questionIds.find((id) => id !== started.question.id)!;
      const base = { subjectUserId: student, placementTestId: started.placementTestId };
      await expectPlacementError(answerPlacementQuestion(tx, { ...base, questionId: notServed, selectedOptionId: 'a' }), 'NOT_SERVED_QUESTION');
      await expectPlacementError(answerPlacementQuestion(tx, { ...base, questionId: started.question.id, selectedOptionId: 'z' }), 'INVALID_OPTION');
      await expectPlacementError(answerPlacementQuestion(tx, { ...base, questionId: started.question.id, selectedOptionId: '' }), 'INVALID_INPUT');
      await expectPlacementError(answerPlacementQuestion(tx, { ...base, subjectUserId: other, questionId: started.question.id, selectedOptionId: 'a' }), 'NOT_FOUND');
      expect(await rows(tx, sql`SELECT 1 FROM learning_attempt_events WHERE subject_user_id IN (${student}::uuid, ${other}::uuid)`)).toEqual([]);

      // Answering, then answering the same question again, records one attempt and returns the current state.
      const next = await answerPlacementQuestion(tx, { ...base, questionId: started.question.id, selectedOptionId: 'a' });
      const replay = await answerPlacementQuestion(tx, { ...base, questionId: started.question.id, selectedOptionId: 'b' });
      expect(replay).toEqual(next);
      expect(await rows(tx, sql`SELECT 1 FROM learning_attempt_events WHERE subject_user_id = ${student}::uuid`)).toHaveLength(1);
    });
  });

  it('stops taking answers once adaptive-learning is withdrawn', async () => {
    await inRollback(async (tx) => {
      await liveAdaptiveLearning(tx);
      await publishAptitudeBank(tx, 30);
      const student = await user(tx);
      await consent(tx, student, 'GRANTED', 30);
      const started = inProgress(await startPlacementTest(tx, { subjectUserId: student }));
      await consent(tx, student, 'WITHDRAWN', 5);
      expect(await answerPlacementQuestion(tx, { subjectUserId: student, placementTestId: started.placementTestId, questionId: started.question.id, selectedOptionId: 'a' }))
        .toEqual({ status: 'NOT_AVAILABLE', reason: 'CONSENT_REQUIRED' });
      expect(await rows(tx, sql`SELECT 1 FROM learning_attempt_events WHERE subject_user_id = ${student}::uuid`)).toEqual([]);
    });
  });

  it('ends at its 25-minute deadline with what it has, and grades nothing after it', async () => {
    await inRollback(async (tx) => {
      await liveAdaptiveLearning(tx);
      const bank = await publishAptitudeBank(tx, 30);
      const student = await consentingStudent(tx);
      const testId = randomUUID();
      const sessionId = randomUUID();
      await tx.execute(sql`INSERT INTO learning_sessions (id, subject_user_id, mode, source_type, source_id, started_at)
        VALUES (${sessionId}::uuid, ${student}::uuid, 'DIAGNOSTIC', 'placement_test', ${testId}::uuid, now() - interval '30 minutes')`);
      await tx.execute(sql`INSERT INTO placement_tests (id, subject_user_id, session_id, scope, algorithm_id, state, started_at, deadline_at)
        VALUES (${testId}::uuid, ${student}::uuid, ${sessionId}::uuid, 'APTITUDE_V1', 'placement-2pl-eap-v1', 'IN_PROGRESS',
          now() - interval '30 minutes', now() - interval '5 minutes')`);
      const run = (await rows<{ run_id: string }>(tx, sql`SELECT run_id::text AS run_id FROM item_calibrations WHERE item_id = ${bank.questionIds[0]!}::uuid`))[0]!.run_id;
      await tx.execute(sql`INSERT INTO placement_test_items (id, placement_test_id, subject_user_id, position, item_source, item_id, item_version, skill_id, item_group,
          difficulty, discrimination, calibration_status, calibration_run_id)
        VALUES (${randomUUID()}::uuid, ${testId}::uuid, ${student}::uuid, 1, 'CAREER_READINESS_QUESTION', ${bank.questionIds[0]!}::uuid, 1, ${bank.topics[0]!}::uuid,
          'QUANTITATIVE', -2, 1.4, 'CALIBRATED', ${run}::uuid)`);

      const late = await answerPlacementQuestion(tx, { subjectUserId: student, placementTestId: testId, questionId: bank.questionIds[0]!, selectedOptionId: 'a' });
      expect(late).toMatchObject({ status: 'COMPLETED', stopReason: 'TIME_LIMIT', placementLevel: 'NOT_ENOUGH_EVIDENCE', questionsAnswered: 0 });
      expect(await rows(tx, sql`SELECT 1 FROM learning_attempt_events WHERE subject_user_id = ${student}::uuid`)).toEqual([]);
      const ended = await rows<{ at_deadline: boolean }>(tx, sql`
        SELECT (t.completed_at = t.deadline_at AND s.ended_at = t.deadline_at) AS at_deadline
        FROM placement_tests t JOIN learning_sessions s ON s.id = t.session_id WHERE t.id = ${testId}::uuid`);
      expect(ended).toEqual([{ at_deadline: true }]);
      // A new sitting can start afterwards.
      expect((await startPlacementTest(tx, { subjectUserId: student })).status).toBe('IN_PROGRESS');
    });
  });

  it('gives a retest questions the student has not answered before, while enough remain', async () => {
    await inRollback(async (tx) => {
      await liveAdaptiveLearning(tx);
      const bank = await publishAptitudeBank(tx, 60);
      const student = await consentingStudent(tx);
      const first = await answerToTheEnd(tx, student, bank, await startPlacementTest(tx, { subjectUserId: student }));
      const second = await answerToTheEnd(tx, student, bank, await startPlacementTest(tx, { subjectUserId: student }));
      expect(second.final.status).toBe('COMPLETED');
      expect(second.asked.some((id) => first.asked.includes(id))).toBe(false);
      expect(await rows(tx, sql`SELECT 1 FROM placement_tests WHERE subject_user_id = ${student}::uuid`)).toHaveLength(2);
    });
  });
});

describe('0064 guards', () => {
  it('keeps sittings and served items append-only, completes a sitting once, and lets only privacy deletion erase them', async () => {
    await inRollback(async (tx) => {
      await liveAdaptiveLearning(tx);
      const bank = await publishAptitudeBank(tx, 30);
      const student = await consentingStudent(tx);
      const started = inProgress(await startPlacementTest(tx, { subjectUserId: student }));
      const refused = async (statement: ReturnType<typeof sql>, message: string): Promise<void> => {
        const error = await tx.transaction(async (inner) => { await inner.execute(statement); }).then(() => null, (caught: unknown) => caught);
        // Drizzle wraps the database error; the trigger's or constraint's words are on the cause.
        expect(`${String((error as Error | null)?.message)} ${String((error as { cause?: Error } | null)?.cause?.message)}`).toContain(message);
      };
      await refused(sql`UPDATE placement_test_items SET difficulty = 0 WHERE subject_user_id = ${student}::uuid`, 'append-only');
      await refused(sql`DELETE FROM placement_test_items WHERE subject_user_id = ${student}::uuid`, 'append-only');
      await refused(sql`DELETE FROM placement_tests WHERE subject_user_id = ${student}::uuid`, 'append-only');
      await refused(sql`UPDATE placement_tests SET deadline_at = deadline_at - interval '1 minute' WHERE subject_user_id = ${student}::uuid`, 'append-only');
      await refused(sql`UPDATE placement_tests SET placement_level = 'AWARE' WHERE subject_user_id = ${student}::uuid`, 'append-only');

      const { final } = await answerToTheEnd(tx, student, bank, started);
      expect(final.status).toBe('COMPLETED');
      await refused(sql`UPDATE placement_tests SET placement_level = 'AWARE' WHERE subject_user_id = ${student}::uuid`, 'append-only');
      await refused(sql`INSERT INTO placement_test_items (id, placement_test_id, subject_user_id, position, item_source, item_id, item_version, skill_id, item_group,
          difficulty, discrimination, calibration_status, calibration_run_id)
        SELECT ${randomUUID()}::uuid, t.id, t.subject_user_id, 25, 'CAREER_READINESS_QUESTION', q.id, 1, q.topic_id, 'VERBAL', 0, 1, 'CALIBRATED', c.run_id
        FROM placement_tests t, question_versions q JOIN item_calibrations c ON c.item_id = q.id
        WHERE t.subject_user_id = ${student}::uuid AND q.id = ${bank.questionIds[29]!}::uuid`, 'only an in-progress sitting');
      await refused(sql`INSERT INTO placement_tests (id, subject_user_id, session_id, scope, algorithm_id, state, started_at, deadline_at)
        SELECT ${randomUUID()}::uuid, subject_user_id, session_id, scope, algorithm_id, 'IN_PROGRESS', now(), now() + interval '26 minutes'
        FROM placement_tests WHERE subject_user_id = ${student}::uuid`, 'placement_tests_deadline_ck');

      // Privacy deletion's transaction-local setting for this subject, and only it, allows erasure.
      await tx.transaction(async (inner) => {
        await inner.execute(sql`SELECT set_config('one.privacy_erase_subject', ${student}, true)`);
        await inner.execute(sql`DELETE FROM learning_attempt_events WHERE subject_user_id = ${student}::uuid`);
        await inner.execute(sql`DELETE FROM placement_test_items WHERE subject_user_id = ${student}::uuid`);
        await inner.execute(sql`DELETE FROM placement_tests WHERE subject_user_id = ${student}::uuid`);
        await inner.execute(sql`DELETE FROM learning_sessions WHERE subject_user_id = ${student}::uuid`);
      });
      expect(await rows(tx, sql`SELECT 1 FROM placement_tests WHERE subject_user_id = ${student}::uuid`)).toEqual([]);
    });
  });

  it('widens the attempt log for placement without dropping any earlier value', async () => {
    const definitions = await rows<{ conname: string; def: string }>(db, sql`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('learning_sessions_mode_ck', 'learning_sessions_source_ck', 'learning_attempt_source_type_ck')`);
    const byName = new Map(definitions.map((row) => [row.conname, row.def]));
    for (const value of ['LEARN', 'PRACTICE', 'REVIEW', 'ASSESSMENT', 'EXPLORE', 'DIAGNOSTIC']) expect(byName.get('learning_sessions_mode_ck')).toContain(`'${value}'`);
    for (const value of ['assessment_attempt', 'exam_attempt', 'placement_test']) {
      expect(byName.get('learning_sessions_source_ck')).toContain(`'${value}'`);
      expect(byName.get('learning_attempt_source_type_ck')).toContain(`'${value}'`);
    }
  });
});
