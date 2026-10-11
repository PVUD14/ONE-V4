/**
 * Migration 0106 and the content factory worker's bookkeeping (ENG-23), against the real database.
 *
 * Pinned: a job starts queued and its request never changes; it only moves forward, a finished job
 * never changes and nothing is deleted; provenance exists exactly when the model replied, findings
 * exactly on a rejection, an answer check's result only on its success and always DRAFT; each kind
 * runs its own feature; the claim takes the oldest job, takes over a job whose worker died, and
 * ends one that has used every attempt; a worker that lost its lease writes nothing; a provider
 * failure worth retrying goes back to the queue until the last attempt; a typed refusal from the
 * orchestrator ends the job refused; a hint ladder accepts AI_GENERATED only with full provenance.
 *
 * Every test runs in a transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AiCapExceededError, InferenceProviderError, type GenerationRecord } from '@planthepath/ai-orchestration/src/index.js';
import { registerOneAiFeatures } from '../src/ai-bake-off.js';
import type { TransactionalRunner } from '../src/content-factory.js';
import { claimNextContentDraft, ContentDraftLeaseLostError, runContentDraft, type ContentDraftGenerator } from '../src/content-factory-worker.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

let client: PoolClient;
let db: TransactionalRunner;
let userId: string;
let topicId: string;
let savepoint = 0;

/** A runner over the test's transaction whose nested transactions are savepoints, so a failed one rolls back. */
function transactionDb(connection: PoolClient): TransactionalRunner {
  const inner = drizzle(connection);
  const self: TransactionalRunner = {
    execute: (query) => inner.execute(query),
    async transaction(work) {
      const name = `eng23_${savepoint += 1}`;
      await connection.query(`SAVEPOINT ${name}`);
      try {
        const result = await work(self);
        await connection.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await connection.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      }
    },
  };
  return self;
}

async function expectRefused(statement: string, values: unknown[], message: RegExp): Promise<void> {
  await client.query('SAVEPOINT refused');
  await expect(client.query(statement, values)).rejects.toThrow(message);
  await client.query('ROLLBACK TO SAVEPOINT refused');
}

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  db = transactionDb(client);
  await client.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
  await registerOneAiFeatures(db);
  userId = randomUUID();
  await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [userId, `eng23-${userId.slice(0, 8)}@example.test`]);
  // A pending skill: a TOPIC node on a DRAFT revision.
  topicId = randomUUID();
  const revisionId = randomUUID();
  await client.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
     VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}'::jsonb)`, [revisionId, topicId, userId, 'a'.repeat(64)],
  );
  await client.query(
    `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id, active)
     VALUES ($1, 'TOPIC', $2, 1, 'Subnetting', 'Reading masks and counting hosts.', $3, false)`, [topicId, `eng23-skill-${topicId.slice(0, 8)}`, revisionId],
  );
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => { await pool.end(); });

async function queueLesson(stableKey = `eng23-lesson-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO ai_content_drafts (id, kind, feature_key, prompt_key, prompt_version, topic_id, stable_key, title, language, level, style,
                                    requested_by_user_id, reason_code, correlation_id)
     VALUES ($1, 'LESSON', 'content.lesson-draft', 'content-lesson-draft', 2, $2, $3, 'Subnetting', 'en', 'STANDARD', 'EXPLANATION', $4, 'NEW_LESSON', 'eng23-test-corr')`,
    [id, topicId, stableKey, userId],
  );
  return id;
}

async function job(id: string): Promise<Record<string, unknown>> {
  return (await client.query('SELECT * FROM ai_content_drafts WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
}

const record = (text: string): GenerationRecord => ({
  featureKey: 'content.lesson-draft', text, source: 'AI_GENERATED', generatorVersion: 'test-generator', promptVersion: 'content-lesson-draft@2',
  promptFingerprint: 'abcd1234', model: 'test/model', reviewState: 'DRAFT', generatedAt: new Date().toISOString(),
  usage: { inputTokens: 1, outputTokens: 1 }, truncated: false, latencyMs: 1,
});
const generator = (answer: () => GenerationRecord | Promise<GenerationRecord>): ContentDraftGenerator & { calls: number } => {
  const stub = { calls: 0, async generate() { stub.calls += 1; return answer(); } };
  return stub;
};

describe('0106: the job row', () => {
  it('starts queued, stamped by the database, and its request never changes', async () => {
    const id = await queueLesson();
    expect(await job(id)).toMatchObject({ state: 'QUEUED', attempts: 0, source: null, outcome_code: null, finished_at: null });
    await expectRefused(
      `INSERT INTO ai_content_drafts (id, kind, feature_key, prompt_key, prompt_version, topic_id, stable_key, title, language, level, style,
                                      requested_by_user_id, reason_code, correlation_id, state, attempts, started_at, lease_expires_at)
       VALUES ($1, 'LESSON', 'content.lesson-draft', 'content-lesson-draft', 2, $2, 'eng23-running', 'T', 'en', 'STANDARD', 'EXPLANATION', $3,
               'NEW_LESSON', 'eng23-test-corr', 'RUNNING', 1, now(), now())`, [randomUUID(), topicId, userId], /starts queued/);
    await expectRefused("UPDATE ai_content_drafts SET title = 'Changed' WHERE id = $1", [id], /request is immutable/);
    await expectRefused('UPDATE ai_content_drafts SET requested_by_user_id = $2 WHERE id = $1', [id, randomUUID()], /request is immutable|foreign key/);
    await expectRefused('DELETE FROM ai_content_drafts WHERE id = $1', [id], /never deleted/);
  });

  it('runs each kind on its own feature, with exactly its target', async () => {
    await expectRefused(
      `INSERT INTO ai_content_drafts (id, kind, feature_key, prompt_key, prompt_version, topic_id, stable_key, title, language, level, style, requested_by_user_id, reason_code, correlation_id)
       VALUES ($1, 'LESSON', 'content.item-draft', 'content-lesson-draft', 2, $2, 'eng23-wrong-feature', 'T', 'en', 'STANDARD', 'EXPLANATION', $3, 'NEW_LESSON', 'eng23-test-corr')`,
      [randomUUID(), topicId, userId], /ai_content_draft_feature_ck/);
    await expectRefused(
      `INSERT INTO ai_content_drafts (id, kind, feature_key, prompt_key, prompt_version, stable_key, title, language, level, style, requested_by_user_id, reason_code, correlation_id)
       VALUES ($1, 'LESSON', 'content.lesson-draft', 'content-lesson-draft', 2, 'eng23-no-topic', 'T', 'en', 'STANDARD', 'EXPLANATION', $2, 'NEW_LESSON', 'eng23-test-corr')`,
      [randomUUID(), userId], /ai_content_draft_target_ck/);
    await expectRefused(
      `INSERT INTO ai_content_drafts (id, kind, feature_key, prompt_key, prompt_version, topic_id, stable_key, language, level, requested_by_user_id, reason_code, correlation_id)
       VALUES ($1, 'QUESTION', 'content.item-draft', 'content-item-draft', 1, $2, 'eng23-q', 'te', 'INTERMEDIATE', $3, 'NEW_QUESTION', 'eng23-test-corr')`,
      [randomUUID(), topicId, userId], /ai_content_draft_target_ck/);
    await expectRefused(
      `INSERT INTO ai_content_drafts (id, kind, feature_key, prompt_key, prompt_version, topic_id, stable_key, title, language, level, style, author_note, requested_by_user_id, reason_code, correlation_id)
       VALUES ($1, 'LESSON', 'content.lesson-draft', 'content-lesson-draft', 2, $2, 'eng23-note', 'T', 'en', 'STANDARD', 'EXPLANATION', $3, $4, 'NEW_LESSON', 'eng23-test-corr')`,
      [randomUUID(), topicId, 'x'.repeat(1001), userId], /ai_content_draft_text_ck/);
  });

  it('only moves forward; provenance only with a reply, findings only on a rejection; a finished job never changes', async () => {
    const id = await queueLesson();
    await expectRefused("UPDATE ai_content_drafts SET state = 'SUCCEEDED' WHERE id = $1", [id], /invalid content draft job transition/);
    await client.query("UPDATE ai_content_drafts SET state = 'RUNNING', attempts = 1, lease_expires_at = now() + interval '10 minutes' WHERE id = $1", [id]);
    expect((await job(id)).started_at).not.toBeNull();
    await expectRefused("UPDATE ai_content_drafts SET state = 'RUNNING', attempts = 0 WHERE id = $1", [id], /never decrease/);
    await expectRefused("UPDATE ai_content_drafts SET state = 'SUCCEEDED' WHERE id = $1", [id], /ai_content_draft_provenance_ck|ai_content_draft_produced_ck/);
    await expectRefused("UPDATE ai_content_drafts SET state = 'REJECTED', outcome_code = 'GUARD_REJECTED' WHERE id = $1", [id], /ai_content_draft_findings_ck/);
    await expectRefused("UPDATE ai_content_drafts SET state = 'FAILED' WHERE id = $1", [id], /ai_content_draft_outcome_ck/);
    await expectRefused(
      "UPDATE ai_content_drafts SET state = 'FAILED', outcome_code = 'X_FAILED', source = 'AI_GENERATED', generator_version = 'g', model = 'm', generated_at = now(), truncated = false WHERE id = $1",
      [id], /ai_content_draft_provenance_ck/);
    await client.query(
      `UPDATE ai_content_drafts SET state = 'REJECTED', outcome_code = 'GUARD_REJECTED', guard_findings = '["PERSONAL_DATA"]'::jsonb,
         source = 'AI_GENERATED', generator_version = 'g', model = 'm', generated_at = now(), truncated = false WHERE id = $1`, [id]);
    const finished = await job(id);
    expect(finished).toMatchObject({ state: 'REJECTED', lease_expires_at: null });
    expect(finished.finished_at).not.toBeNull();
    await expectRefused("UPDATE ai_content_drafts SET outcome_code = 'OTHER' WHERE id = $1", [id], /finished content draft job is immutable/);
  });

  it('keeps an answer check advice: its result only on success, and always DRAFT', async () => {
    const questionRevision = randomUUID();
    await client.query(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
       VALUES ($1, 'QUESTION', $2, 1, $3, 'DRAFT', $4, '{}'::jsonb)`, [questionRevision, randomUUID(), userId, 'b'.repeat(64)],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO ai_content_drafts (id, kind, feature_key, prompt_key, prompt_version, question_revision_id, language, requested_by_user_id, reason_code, correlation_id)
       VALUES ($1, 'ANSWER_CHECK', 'content.answer-check', 'content-answer-check', 1, $2, 'en', $3, 'ANSWER_KEY_CHECK', 'eng23-test-corr')`, [id, questionRevision, userId]);
    await client.query("UPDATE ai_content_drafts SET state = 'RUNNING', attempts = 1, lease_expires_at = now() + interval '10 minutes' WHERE id = $1", [id]);
    const success = `UPDATE ai_content_drafts SET state = 'SUCCEEDED', source = 'AI_GENERATED', generator_version = 'g', model = 'm', generated_at = now(), truncated = false,
       check_option = 'a', check_working = 'Because.', check_agrees = true, checked_content_hash = $2, review_state = $3 WHERE id = $1`;
    await expectRefused(success, [id, 'b'.repeat(64), 'PUBLISHED'], /ai_content_draft_check_ck/);
    await client.query(success, [id, 'b'.repeat(64), 'DRAFT']);
    expect(await job(id)).toMatchObject({ state: 'SUCCEEDED', check_option: 'a', review_state: 'DRAFT' });
  });

  it('lets a hint ladder be AI_GENERATED only with full provenance and an expert note', async () => {
    const questionRevision = randomUUID();
    await client.query(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
       VALUES ($1, 'QUESTION', $2, 1, $3, 'DRAFT', $4, '{}'::jsonb)`, [questionRevision, randomUUID(), userId, 'c'.repeat(64)],
    );
    const insert = `INSERT INTO question_hint_ladders (id, question_revision_id, hint_1, hint_2, hint_3, hint_4, source, generator_version, prompt_version, generated_at, expert_check_notes, created_by_user_id)
       VALUES ($1, $2, 'h1', 'h2', 'h3', 'h4', 'AI_GENERATED', $3, $4, now(), $5, $6)`;
    await expectRefused(insert, [randomUUID(), questionRevision, 'g', 'content-item-draft@1', null, userId], /question_hint_ladders_provenance_ck/);
    await expectRefused(insert, [randomUUID(), questionRevision, null, 'content-item-draft@1', 'Check it.', userId], /question_hint_ladders_provenance_ck/);
    await client.query(insert, [randomUUID(), questionRevision, 'g', 'content-item-draft@1', 'Check every hint.', userId]);
    await expectRefused(
      "INSERT INTO question_hint_ladders (id, question_revision_id, hint_1, hint_2, hint_3, hint_4, source, created_by_user_id) VALUES ($1, $2, 'a', 'b', 'c', 'd', 'MODEL', $3)",
      [randomUUID(), questionRevision, userId], /question_hint_ladders_(source|provenance)_ck/);
  });
});

describe('the worker', () => {
  it('claims the oldest job, takes over one whose worker died, and ends one that used every attempt', async () => {
    const queued = [await queueLesson(), await queueLesson()];
    // Queued in one transaction, both carry the same database time; the id breaks the tie.
    const order = (await client.query('SELECT id FROM ai_content_drafts WHERE id = ANY($1) ORDER BY requested_at, id', [queued])).rows.map((row) => row.id as string);
    const [first, second] = order as [string, string];
    const claimed = await claimNextContentDraft(db);
    expect(claimed).toMatchObject({ id: first, attempts: 1, kind: 'LESSON', requestedByUserId: userId });
    // Its worker died: the lease runs out and the next claim takes it over, as attempt 2.
    await client.query("UPDATE ai_content_drafts SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [first]);
    expect(await claimNextContentDraft(db)).toMatchObject({ id: first, attempts: 2 });
    await client.query("UPDATE ai_content_drafts SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [first]);
    expect(await claimNextContentDraft(db)).toMatchObject({ id: first, attempts: 3 });
    await client.query("UPDATE ai_content_drafts SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [first]);
    expect(await claimNextContentDraft(db)).toMatchObject({ id: second, attempts: 1 });
    expect(await job(first)).toMatchObject({ state: 'FAILED', outcome_code: 'ATTEMPTS_EXHAUSTED' });
  });

  it('writes nothing when another worker took the job over meanwhile', async () => {
    const id = await queueLesson();
    const mine = (await claimNextContentDraft(db))!;
    await client.query("UPDATE ai_content_drafts SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    const theirs = (await claimNextContentDraft(db))!;
    expect(theirs.attempts).toBe(2);
    await expect(runContentDraft({ db, generator: generator(() => record('REFUSED: no.')), job: mine })).rejects.toBeInstanceOf(ContentDraftLeaseLostError);
    expect(await job(id)).toMatchObject({ state: 'RUNNING', attempts: 2 });
  });

  it('a retryable provider failure goes back to the queue, and fails on the last attempt; a typed refusal ends it refused', async () => {
    const id = await queueLesson();
    const failing = generator(() => { throw new InferenceProviderError('PROVIDER_SERVER_ERROR', 'fixed message'); });
    for (const attempt of [1, 2]) {
      const claimed = (await claimNextContentDraft(db))!;
      expect(claimed.attempts).toBe(attempt);
      expect(await runContentDraft({ db, generator: failing, job: claimed })).toMatchObject({ state: 'QUEUED', outcomeCode: 'PROVIDER_SERVER_ERROR' });
    }
    const last = (await claimNextContentDraft(db))!;
    expect(await runContentDraft({ db, generator: failing, job: last })).toMatchObject({ state: 'FAILED', outcomeCode: 'PROVIDER_SERVER_ERROR' });
    expect(failing.calls).toBe(3);

    const capped = await queueLesson();
    const claimed = (await claimNextContentDraft(db))!;
    expect(claimed.id).toBe(capped);
    expect(await runContentDraft({ db, generator: generator(() => { throw new AiCapExceededError('content.lesson-draft', 1); }), job: claimed }))
      .toMatchObject({ state: 'REFUSED', outcomeCode: 'CAP_EXCEEDED' });
    expect(await job(capped)).toMatchObject({ state: 'REFUSED', source: null });
    const audit = (await client.query("SELECT actor_user_id, context FROM audit_events WHERE resource_id = $1 AND action = 'operations.content.ai_draft_finished'", [capped])).rows[0];
    expect(audit).toMatchObject({ actor_user_id: userId, context: { state: 'REFUSED', outcomeCode: 'CAP_EXCEEDED', performedBy: 'content-factory-worker' } });
    expect(id).not.toBe(capped);
  });

  it('a target that changed since the request ends the job without a call', async () => {
    await queueLesson();
    // The skill is retired: its revision is archived and the node never went live.
    await client.query("UPDATE content_revisions SET state = 'ARCHIVED' WHERE entity_type = 'TOPIC' AND entity_id = $1", [topicId]);
    const stub = generator(() => record('unused'));
    expect(await runContentDraft({ db, generator: stub, job: (await claimNextContentDraft(db))! })).toMatchObject({ state: 'FAILED', outcomeCode: 'TARGET_CHANGED' });
    expect(stub.calls).toBe(0);
  });
});
