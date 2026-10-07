/**
 * ENG-24 acceptance, against the real database, with a deterministic fake embedding provider: migration
 * 0114, the content embedding job and tenant-scoped retrieval.
 *
 * Pinned: retrieval never returns an institution's private content to another institution's student or
 * to a student with no institution, and a chunk cannot carry a scope other than its revision's; draft,
 * in-review, approved-but-unpublished and superseded revisions are never embedded, and the database
 * refuses them; archiving, rolling back a release or publishing a newer revision removes chunks from
 * retrieval before the job runs again; a rebuild re-creates exactly the approved content's rows; a model
 * or recipe mismatch returns NO_INDEX_FOR_MODEL and the job replaces the old model's rows; with the
 * endpoint unconfigured, the feature off or the kill switch engaged the job does nothing and says so.
 *
 * Every test runs in a transaction that is rolled back. All content and people are synthetic.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  AiOrchestrator,
  PromptRegistry,
  UnconfiguredEmbeddingProvider,
  UnconfiguredInferenceProvider,
  type EmbeddingGenerationRequest,
  type EmbeddingProvider,
  type EmbeddingRecord,
} from '@planthepath/ai-orchestration/src/index.js';
import { createFakeEmbeddingProvider, type FakeEmbeddingProvider } from '@planthepath/ai-orchestration/src/testing/fake-embedding-provider.js';
import { countAiGenerations, loadAiFeaturePolicy, loadAiKillSwitchEngaged, recordAiGeneration } from '../src/ai-orchestration.js';
import { registerOneEmbeddingFeatures, runContentEmbeddings, type ContentEmbeddingRun } from '../src/content-embeddings.js';
import { retrieveApprovedContent, type RetrievalOutcome } from '../src/content-retrieval.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);

const SHA = 'e'.repeat(64);
const MODEL = 'fake/embedding-model';
const OTHER_MODEL = 'fake/other-embedding-model';

let client: PoolClient;
let author: string;
let reviewer: string;
let sourceRecordId: string;
let collegeA: string;
let collegeB: string;
/** A student of A, a student of B, and a learner with no institution. */
let studentA: string;
let studentB: string;
let independent: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

afterAll(async () => { await pool.end(); });

async function user(): Promise<string> {
  const id = randomUUID();
  await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, `eng24-${id.slice(0, 8)}@example.test`]);
  return id;
}

async function college(name: string): Promise<string> {
  const id = randomUUID();
  await client.query("INSERT INTO organizations (id, kind, legal_name, verification_state) VALUES ($1, 'INSTITUTION', $2, 'VERIFIED')", [id, name]);
  return id;
}

async function enrol(student: string, institution: string): Promise<void> {
  await client.query(
    `INSERT INTO institution_student_profiles (id, institution_id, student_user_id, institution_student_id, full_name, status)
     VALUES ($1, $2, $3, $4, 'Synthetic Student', 'ACTIVE')`, [randomUUID(), institution, student, `ENG24-${student.slice(0, 8)}`]);
}

async function enableFeature(featureKey: string, model: string): Promise<void> {
  await passingEvaluation(featureKey, model);
  await client.query('UPDATE ai_feature_policies SET model = $2, enabled = true WHERE feature_key = $1', [featureKey, model]);
}

async function passingEvaluation(featureKey: string, model: string): Promise<void> {
  await client.query(
    `INSERT INTO ai_evaluations (id, feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version, metrics, decision, reason_code, decided_by_user_id, correlation_id)
     VALUES ($1, $2, 'openai-compatible', $3, 'content-embedding', 1, 'eng24-synthetic-set', 1, $4::jsonb, 'PASS', 'SYNTHETIC_TEST', $5, 'eng24-eval-corr')`,
    [randomUUID(), featureKey, model, JSON.stringify([{ name: 'recall_at_3', value: 0.9, threshold: 0.8, comparator: 'AT_LEAST' }]), reviewer],
  );
}

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("UPDATE feature_flags SET enabled = false WHERE key = 'ai.global-kill-switch'");
  // Other suites commit published lessons to the shared test database. Inside this test's transaction
  // (rolled back afterwards) their releases are rolled back, so the only approved content is this test's.
  await client.query("UPDATE release_manifests SET status = 'ROLLED_BACK' WHERE status = 'PUBLISHED'");
  await client.query('DELETE FROM content_embeddings');
  expect((await client.query('SELECT count(*)::int AS n FROM content_retrieval_sources')).rows[0].n).toBe(0);
  author = await user();
  reviewer = await user();
  const runId = randomUUID();
  const packageId = randomUUID();
  sourceRecordId = randomUUID();
  await client.query(
    `INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
     VALUES ($1, $2, 'synthetic/eng-24', $3, $4, 'eng24-test', 'STAGED', $5, now())`, [runId, `eng24-${runId}`, 'b'.repeat(40), SHA, author]);
  await client.query(
    `INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
     VALUES ($1, $2, $3, 'synthetic/eng-24', $4, $5, 'eng24-test', '[]', '{}', '{}')`, [packageId, runId, `eng24-${packageId}`, 'b'.repeat(40), SHA]);
  await client.query(
    `INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
       rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
     VALUES ($1, $2, 'LESSON', 'eng24', 'synthetic.json', $3, 'Synthetic', 'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', true)`,
    [sourceRecordId, packageId, SHA]);
  collegeA = await college('Synthetic College A');
  collegeB = await college('Synthetic College B');
  [studentA, studentB, independent] = [await user(), await user(), await user()];
  await enrol(studentA, collegeA);
  await enrol(studentB, collegeB);
  await registerOneEmbeddingFeatures(client);
  await enableFeature('content.embeddings', MODEL);
  await enableFeature('tutor.retrieval', MODEL);
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

type Stage = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'PUBLISHED';

interface Lesson { readonly revisionId: string; readonly entityId: string; readonly manifestId: string | null }

/** A LESSON revision with synthetic text, taken as far as `stage`; PUBLISHED means under a PUBLISHED release. */
async function lesson(input: { title: string; summary: string; owner?: string | null; stage?: Stage; entityId?: string; revision?: number; language?: string }): Promise<Lesson> {
  const revisionId = randomUUID();
  const entityId = input.entityId ?? randomUUID();
  const stage = input.stage ?? 'PUBLISHED';
  const body = {
    schema: 'lesson-v2', stableKey: `eng24-${entityId.slice(0, 8)}`, variantOf: null,
    variant: { language: input.language ?? 'en', level: 'STANDARD', style: 'EXPLANATION' },
    title: input.title, body: { summary: input.summary, practice: null },
  };
  await client.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body, owner_institution_id)
     VALUES ($1, 'LESSON', $2, $3, $4, 'DRAFT', $5, $6::jsonb, $7)`,
    [revisionId, entityId, input.revision ?? 1, author, SHA, JSON.stringify(body), input.owner ?? null]);
  if (stage === 'DRAFT') return { revisionId, entityId, manifestId: null };
  await client.query("UPDATE content_revisions SET state = 'IN_REVIEW' WHERE id = $1", [revisionId]);
  if (stage === 'IN_REVIEW') return { revisionId, entityId, manifestId: null };
  await client.query(
    `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
     VALUES ($1, $2, $3, 'APPROVE', 'IN_REVIEW', 'APPROVED', 'SYNTHETIC_OK', 'eng24-approve-corr')`, [randomUUID(), revisionId, reviewer]);
  await client.query("UPDATE content_revisions SET state = 'APPROVED' WHERE id = $1", [revisionId]);
  if (stage === 'APPROVED') return { revisionId, entityId, manifestId: null };
  const manifestId = randomUUID();
  await client.query("INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1, $2, 1, $3, 'DRAFT')",
    [manifestId, `eng24-${manifestId}`, manifestId.replace(/-/g, '').repeat(2)]);
  await client.query('INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1, $2, $3, $4)',
    [manifestId, revisionId, sourceRecordId, SHA]);
  await client.query("UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = $2, approved_at = now() WHERE id = $1", [manifestId, reviewer]);
  await client.query("UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = $2, published_at = now() WHERE id = $1", [manifestId, reviewer]);
  await client.query("UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = $2, published_at = now() WHERE id = $1", [revisionId, manifestId]);
  return { revisionId, entityId, manifestId };
}

async function archive(revisionId: string): Promise<void> {
  await client.query(
    `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
     VALUES ($1, $2, $3, 'ARCHIVE', 'PUBLISHED', 'ARCHIVED', 'OUT_OF_DATE', 'eng24-archive-corr')`, [randomUUID(), revisionId, reviewer]);
  await client.query("UPDATE content_revisions SET state = 'ARCHIVED' WHERE id = $1", [revisionId]);
}

/** ONE AI Orchestration over the test's transaction: real policy, kill switch, cap and metering; a fake endpoint. */
function orchestratorWith(embeddings: EmbeddingProvider): (request: EmbeddingGenerationRequest) => Promise<EmbeddingRecord> {
  const ai = new AiOrchestrator({
    provider: new UnconfiguredInferenceProvider(),
    embeddings,
    prompts: new PromptRegistry([]),
    usage: { count: (input) => countAiGenerations(client, input), record: (input) => recordAiGeneration(client, input) },
    policy: async (featureKey) => {
      const row = await loadAiFeaturePolicy(client, featureKey);
      return row ? { featureKey: row.featureKey, enabled: row.enabled, cap: row.cap, window: row.window, model: row.model, maxInputChars: row.maxInputChars } : undefined;
    },
    killSwitchEngaged: () => loadAiKillSwitchEngaged(client),
    generatorVersion: 'eng24-test-generator',
  });
  return (request) => ai.embed(request);
}

let fake: FakeEmbeddingProvider;
function embedder(): (request: EmbeddingGenerationRequest) => Promise<EmbeddingRecord> {
  fake = createFakeEmbeddingProvider();
  return orchestratorWith(fake);
}

async function job(mode: 'INCREMENTAL' | 'REBUILD' = 'INCREMENTAL', embed = embedder()): Promise<ContentEmbeddingRun> {
  return runContentEmbeddings({ db: client, embed, endpointConfigured: true, mode, correlationId: 'eng24-job-corr' });
}

async function retrieve(student: string, query: string, embed = embedder()): Promise<RetrievalOutcome> {
  return retrieveApprovedContent({ db: client, embed, subjectUserId: student, query, correlationId: 'eng24-retrieve-corr' });
}

/** The revisions a student's retrieval returned, over every query given. */
async function revisionsSeenBy(student: string, queries: readonly string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const query of queries) {
    const outcome = await retrieve(student, query);
    expect(outcome.state).toBe('OK');
    if (outcome.state === 'OK') for (const passage of outcome.passages) seen.add(passage.contentRevisionId);
  }
  return seen;
}

async function embeddedRevisions(): Promise<string[]> {
  return (await client.query('SELECT DISTINCT content_revision_id::text AS id FROM content_embeddings ORDER BY 1')).rows.map((row) => row.id as string);
}

async function expectRefused(statement: string, values: unknown[], message: RegExp): Promise<void> {
  await client.query('SAVEPOINT refused');
  await expect(client.query(statement, values)).rejects.toThrow(message);
  await client.query('ROLLBACK TO SAVEPOINT refused');
}

const globalText = { title: 'Subnet masks', summary: 'A subnet mask splits an IPv4 address into network bits and host bits. Count the host bits to find the hosts.' };
const privateAText = { title: 'College A placement drill', summary: 'Alpha college internal drill: quartz falcon timetable for aptitude rounds.' };
const privateBText = { title: 'College B placement drill', summary: 'Beta college internal drill: copper heron timetable for aptitude rounds.' };
const queries = ['subnet mask host bits', 'quartz falcon timetable aptitude rounds', 'copper heron timetable aptitude rounds', 'college placement drill timetable'];

describe('0114: what may be embedded, and with which scope', () => {
  it('rebuilds from approved, current content only: never a draft, an unreviewed, an unpublished or a replaced revision', async () => {
    const global = await lesson(globalText);
    const privateA = await lesson({ ...privateAText, owner: collegeA });
    const privateB = await lesson({ ...privateBText, owner: collegeB });
    const draft = await lesson({ title: 'Draft lesson', summary: 'Unreviewed words.', stage: 'DRAFT' });
    const inReview = await lesson({ title: 'In review', summary: 'Not yet approved.', stage: 'IN_REVIEW' });
    const approved = await lesson({ title: 'Approved only', summary: 'Approved but never released.', stage: 'APPROVED' });
    const old = await lesson({ title: 'Ratios', summary: 'The first way of writing ratios.' });
    const replacement = await lesson({ title: 'Ratios', summary: 'The second way of writing ratios.', entityId: old.entityId, revision: 2 });

    const run = await job('REBUILD');
    expect(run).toMatchObject({ state: 'COMPLETED', mode: 'REBUILD', model: MODEL, embeddingVersion: 'content-embedding@1', embeddedRevisions: 4, stopReason: null });
    expect(await embeddedRevisions()).toEqual([global, privateA, privateB, replacement].map((entry) => entry.revisionId).sort());
    for (const excluded of [draft, inReview, approved, old]) expect(await embeddedRevisions()).not.toContain(excluded.revisionId);

    // Each chunk carries its revision's scope and full provenance.
    const rows = (await client.query(
      `SELECT content_revision_id::text AS id, owner_institution_id::text AS owner, tenant_scope, source, embedding_model, embedding_version,
              prompt_version, generator_version, dimensions, generated_at FROM content_embeddings`)).rows;
    expect(rows.find((row) => row.id === privateA.revisionId)).toMatchObject({ owner: collegeA, tenant_scope: 'INSTITUTION' });
    expect(rows.find((row) => row.id === global.revisionId)).toMatchObject({ owner: null, tenant_scope: 'GLOBAL' });
    expect(rows.every((row) => row.source === 'AI_GENERATED' && row.embedding_model === MODEL && row.prompt_version === 'content-embedding@1'
      && row.generator_version === 'eng24-test-generator' && row.dimensions === 64 && row.generated_at !== null)).toBe(true);
    // Every call was metered against the feature and its recipe.
    expect((await client.query("SELECT count(*)::int AS n FROM ai_generations WHERE feature_key = 'content.embeddings' AND outcome = 'SUCCEEDED' AND prompt_key = 'content-embedding'")).rows[0].n).toBe(4);

    // Idempotent: a second run embeds nothing and calls nothing.
    const again = await job();
    expect(again).toMatchObject({ state: 'COMPLETED', embeddedRevisions: 0, chunksWritten: 0, pruned: 0 });
    expect(fake.requests).toHaveLength(0);

    // A rebuild starts from nothing and re-creates exactly the same set, from approved content only.
    const before = (await client.query('SELECT count(*)::int AS n FROM content_embeddings')).rows[0].n as number;
    const rebuilt = await job('REBUILD');
    expect(rebuilt).toMatchObject({ pruned: before, embeddedRevisions: 4 });
    expect(await embeddedRevisions()).toEqual([global, privateA, privateB, replacement].map((entry) => entry.revisionId).sort());
  });

  it('refuses, in the database, a chunk of unapproved content or a chunk whose scope is not its revision\'s', async () => {
    const draft = await lesson({ title: 'Draft lesson', summary: 'Unreviewed words.', stage: 'DRAFT' });
    const privateA = await lesson({ ...privateAText, owner: collegeA });
    const insert = `INSERT INTO content_embeddings (id, content_revision_id, entity_type, owner_institution_id, tenant_scope, language, chunk_index, chunk_count,
        chunk_text, chunk_hash, source_content_hash, embedding, dimensions, embedding_model, embedding_version, generator_version, prompt_version, generated_at)
      VALUES ($1, $2, 'LESSON', $3, $4, 'en', 0, 1, 'text', encode(sha256(convert_to('text', 'UTF8')), 'hex'), $5, $6::real[], 8, $7, 'content-embedding@1', 'g', 'content-embedding@1', now())`;
    const unit = [1, 0, 0, 0, 0, 0, 0, 0];
    await expectRefused(insert, [randomUUID(), draft.revisionId, null, 'GLOBAL', SHA, unit, MODEL], /only approved, current content is embedded/);
    // A private chunk can never be stored as global, nor as another college's.
    await expectRefused(insert, [randomUUID(), privateA.revisionId, null, 'GLOBAL', SHA, unit, MODEL], /takes its tenant scope from its content revision/);
    await expectRefused(insert, [randomUUID(), privateA.revisionId, collegeB, 'INSTITUTION', SHA, unit, MODEL], /takes its tenant scope from its content revision/);
    await expectRefused(insert, [randomUUID(), privateA.revisionId, collegeA, 'GLOBAL', SHA, unit, MODEL], /content_embeddings_scope_ck/);
    // Vectors are unit length and finite; rows are never edited.
    await expectRefused(insert, [randomUUID(), privateA.revisionId, collegeA, 'INSTITUTION', SHA, [1, 1, 0, 0, 0, 0, 0, 0], MODEL], /content_embeddings_vector_ck/);
    await expectRefused(insert, [randomUUID(), privateA.revisionId, collegeA, 'INSTITUTION', SHA, [1, 'NaN', 0, 0, 0, 0, 0, 0], MODEL], /content_embeddings_vector_ck/);
    await client.query(insert, [randomUUID(), privateA.revisionId, collegeA, 'INSTITUTION', SHA, unit, MODEL]);
    await expectRefused("UPDATE content_embeddings SET chunk_text = 'changed'", [], /never edited/);
  });

  it('fixes a revision\'s owner at creation, and only an institution owns content', async () => {
    const privateA = await lesson({ ...privateAText, owner: collegeA, stage: 'DRAFT' });
    await expectRefused('UPDATE content_revisions SET owner_institution_id = $2 WHERE id = $1', [privateA.revisionId, collegeB], /owner is fixed/);
    await expectRefused('UPDATE content_revisions SET owner_institution_id = NULL WHERE id = $1', [privateA.revisionId], /owner is fixed/);
    const employer = randomUUID();
    await client.query("INSERT INTO organizations (id, kind, legal_name, verification_state) VALUES ($1, 'EMPLOYER', 'Synthetic Employer', 'VERIFIED')", [employer]);
    await expectRefused(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body, owner_institution_id)
       VALUES ($1, 'LESSON', $2, 1, $3, 'DRAFT', $4, '{}'::jsonb, $5)`, [randomUUID(), randomUUID(), author, SHA, employer], /only an institution owns private content/);
  });
});

describe('retrieval never crosses tenants', () => {
  it('returns A\'s private content only to A\'s students; never to B\'s, nor to a learner with no institution', async () => {
    const global = await lesson(globalText);
    const privateA = await lesson({ ...privateAText, owner: collegeA });
    const privateB = await lesson({ ...privateBText, owner: collegeB });
    await job();

    const seenA = await revisionsSeenBy(studentA, queries);
    const seenB = await revisionsSeenBy(studentB, queries);
    const seenNone = await revisionsSeenBy(independent, queries);
    expect(seenA).toEqual(new Set([global.revisionId, privateA.revisionId]));
    expect(seenB).toEqual(new Set([global.revisionId, privateB.revisionId]));
    expect(seenNone).toEqual(new Set([global.revisionId]));

    // Asked in B's own words, A's student still never sees B's content: the best global match comes back instead.
    const exact = await retrieve(studentA, privateBText.summary);
    expect(exact.state === 'OK' && exact.passages.map((passage) => passage.contentRevisionId)).not.toContain(privateB.revisionId);
    const ownWords = await retrieve(studentA, privateAText.summary);
    expect(ownWords.state === 'OK' && ownWords.passages[0]).toMatchObject({ contentRevisionId: privateA.revisionId, tenantScope: 'INSTITUTION' });

    // The scope is the student's current one: when A's relationship ends, A's content goes with it.
    await client.query("UPDATE institution_student_profiles SET status = 'ENDED' WHERE student_user_id = $1", [studentA]);
    expect(await revisionsSeenBy(studentA, queries)).toEqual(new Set([global.revisionId]));
  });

  it('returns at most three passages, within the character budget, and meters the query against the student', async () => {
    for (let index = 0; index < 5; index += 1) await lesson({ title: `Subnet masks ${index}`, summary: globalText.summary });
    await job();
    const outcome = await retrieve(independent, 'subnet mask host bits');
    expect(outcome.state).toBe('OK');
    if (outcome.state !== 'OK') return;
    expect(outcome.passages).toHaveLength(3);
    expect(outcome.passages.reduce((total, passage) => total + passage.text.length, 0)).toBeLessThanOrEqual(3000);
    expect(outcome.passages.every((passage, index) => index === 0 || passage.score <= outcome.passages[index - 1]!.score)).toBe(true);
    const metered = (await client.query("SELECT subject_user_id::text AS subject, outcome FROM ai_generations WHERE feature_key = 'tutor.retrieval'")).rows;
    expect(metered).toEqual([{ subject: independent, outcome: 'SUCCEEDED' }]);
  });
});

describe('withdrawn content stops being retrievable at once, before the job runs again', () => {
  it('drops an archived revision, a rolled-back release and a replaced revision immediately', async () => {
    const global = await lesson(globalText);
    const privateA = await lesson({ ...privateAText, owner: collegeA });
    const ratios = await lesson({ title: 'Ratios', summary: 'The first way of writing ratios, with colons.' });
    await job();
    expect(await revisionsSeenBy(studentA, [...queries, 'ratios colons'])).toEqual(new Set([global.revisionId, privateA.revisionId, ratios.revisionId]));

    await archive(global.revisionId);
    await client.query("UPDATE release_manifests SET status = 'ROLLED_BACK' WHERE id = $1", [privateA.manifestId]);
    const replacement = await lesson({ title: 'Ratios', summary: 'The second way of writing ratios, as fractions.', entityId: ratios.entityId, revision: 2 });

    // No job has run: the rows are still there, and none of them is returned.
    expect(await embeddedRevisions()).toEqual([global, privateA, ratios].map((entry) => entry.revisionId).sort());
    const seen = await revisionsSeenBy(studentA, [...queries, 'ratios colons', 'ratios fractions']);
    expect(seen.size).toBe(0);

    // The next run tidies the withdrawn rows away and embeds the replacement.
    const run = await job();
    expect(run).toMatchObject({ state: 'COMPLETED', embeddedRevisions: 1 });
    expect(await embeddedRevisions()).toEqual([replacement.revisionId]);
    expect(await revisionsSeenBy(studentA, ['ratios fractions'])).toEqual(new Set([replacement.revisionId]));
  });

  it('drops a base lesson whose lesson version was superseded', async () => {
    const global = await lesson(globalText);
    await job();
    const topicId = randomUUID();
    const topicRevision = randomUUID();
    await client.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1, 'TOPIC', $2, 1, $3, 'DRAFT', $4, '{}')`, [topicRevision, topicId, author, SHA]);
    await client.query(`INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
      VALUES ($1, 'TOPIC', $2, 1, 'Synthetic subnetting', 'Synthetic topic for ENG-24 tests', $3)`, [topicId, `eng24-topic-${topicId}`, topicRevision]);
    const moduleId = randomUUID();
    const moduleRevision = randomUUID();
    await client.query(`INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
      VALUES ($1, 'MODULE', $2, 1, $3, 'DRAFT', $4, '{}')`, [moduleRevision, moduleId, author, SHA]);
    await client.query(`INSERT INTO learning_modules (id, stable_key, version, title, description, content_revision_id, release_manifest_id, published_at)
      VALUES ($1, $2, 1, 'Synthetic module', 'Synthetic', $3, $4, now())`, [moduleId, `eng24-m-${moduleId}`, moduleRevision, global.manifestId]);
    const versionId = randomUUID();
    await client.query(`INSERT INTO lesson_versions (id, module_id, stable_key, version, title, body, topic_id, content_revision_id, published_at)
      VALUES ($1, $2, $3, 1, 'Subnet masks', '{}', $4, $5, now())`, [versionId, moduleId, `eng24-l-${versionId}`, topicId, global.revisionId]);
    expect(await revisionsSeenBy(independent, ['subnet mask host bits'])).toEqual(new Set([global.revisionId]));
    await client.query('UPDATE lesson_versions SET superseded_at = now() WHERE id = $1', [versionId]);
    expect(await revisionsSeenBy(independent, ['subnet mask host bits'])).toEqual(new Set());
  });
});

describe('model and recipe versions', () => {
  it('compares only like with like: a model or dimension mismatch is NO_INDEX_FOR_MODEL, and the job replaces the old model\'s rows', async () => {
    const global = await lesson(globalText);
    await job();
    // The tutor's feature moves to another model (evaluated, so it stays on); the index is still the old model's.
    await passingEvaluation('tutor.retrieval', OTHER_MODEL);
    await client.query("UPDATE ai_feature_policies SET model = $1 WHERE feature_key = 'tutor.retrieval'", [OTHER_MODEL]);
    expect(await retrieve(independent, 'subnet mask host bits')).toEqual({ state: 'UNAVAILABLE', reason: 'NO_INDEX_FOR_MODEL' });

    // Same model, different vector length: also never compared.
    await client.query("UPDATE ai_feature_policies SET model = $1 WHERE feature_key = 'tutor.retrieval'", [MODEL]);
    const shortVectors = orchestratorWith(createFakeEmbeddingProvider({ dimensions: 32 }));
    expect(await retrieve(independent, 'subnet mask host bits', shortVectors)).toEqual({ state: 'UNAVAILABLE', reason: 'NO_INDEX_FOR_MODEL' });

    // The job moves to the new model: the old model's rows go, the new ones come, retrieval matches again.
    await passingEvaluation('content.embeddings', OTHER_MODEL);
    await client.query("UPDATE ai_feature_policies SET model = $1 WHERE feature_key IN ('content.embeddings', 'tutor.retrieval')", [OTHER_MODEL]);
    const before = (await client.query('SELECT count(*)::int AS n FROM content_embeddings')).rows[0].n as number;
    const run = await job();
    expect(run).toMatchObject({ state: 'COMPLETED', model: OTHER_MODEL, pruned: before, embeddedRevisions: 1 });
    expect((await client.query('SELECT DISTINCT embedding_model FROM content_embeddings')).rows).toEqual([{ embedding_model: OTHER_MODEL }]);
    const outcome = await retrieve(independent, 'subnet mask host bits');
    expect(outcome).toMatchObject({ state: 'OK', model: OTHER_MODEL, passages: [expect.objectContaining({ contentRevisionId: global.revisionId })] });
  });

  it('prunes rows of another recipe version', async () => {
    await lesson(globalText);
    await job();
    const run = await runContentEmbeddings({
      db: client, embed: embedder(), endpointConfigured: true,
      recipe: { key: 'content-embedding', version: 2, purpose: 'test', maxChunkChars: 800, maxChunksPerSource: 64, passagePrefix: '', queryPrefix: '' },
    }).catch((error: unknown) => error);
    // The policy names recipe 1; a run with recipe 2 still keeps one recipe in the index at a time.
    expect(run).toMatchObject({ state: 'COMPLETED', embeddingVersion: 'content-embedding@2', embeddedRevisions: 1 });
    expect((await client.query('SELECT DISTINCT embedding_version FROM content_embeddings')).rows).toEqual([{ embedding_version: 'content-embedding@2' }]);
  });
});

describe('when AI is unavailable the job does nothing, and says so', () => {
  it('with no endpoint, the feature off, or the kill switch engaged: no rows, no calls, no metering', async () => {
    await lesson(globalText);
    const embed = embedder();
    expect(await runContentEmbeddings({ db: client, embed, endpointConfigured: false })).toEqual({ state: 'UNAVAILABLE', reason: 'ENDPOINT_UNCONFIGURED' });
    await client.query("UPDATE ai_feature_policies SET enabled = false WHERE feature_key = 'content.embeddings'");
    expect(await runContentEmbeddings({ db: client, embed, endpointConfigured: true })).toEqual({ state: 'UNAVAILABLE', reason: 'FEATURE_DISABLED' });
    await client.query("UPDATE ai_feature_policies SET enabled = true WHERE feature_key = 'content.embeddings'");
    await client.query("UPDATE feature_flags SET enabled = true WHERE key = 'ai.global-kill-switch'");
    expect(await runContentEmbeddings({ db: client, embed, endpointConfigured: true })).toEqual({ state: 'UNAVAILABLE', reason: 'FEATURE_DISABLED' });
    expect(await embeddedRevisions()).toEqual([]);
    expect(fake.requests).toHaveLength(0);
    expect((await client.query("SELECT count(*)::int AS n FROM ai_generations WHERE feature_key = 'content.embeddings'")).rows[0].n).toBe(0);
    // Retrieval refuses too, and says why, rather than throwing.
    expect(await retrieve(independent, 'subnet mask host bits')).toEqual({ state: 'UNAVAILABLE', reason: 'FEATURE_DISABLED' });
  });

  it('stops at the feature\'s cap and resumes on the next run; an empty query asks nothing', async () => {
    await lesson(globalText);
    await lesson({ ...globalText, title: 'Subnet masks again' });
    await client.query("UPDATE ai_feature_policies SET cap = 1 WHERE feature_key = 'content.embeddings'");
    const run = await job();
    expect(run).toMatchObject({ state: 'STOPPED', stopReason: 'CAP_REACHED', embeddedRevisions: 1 });
    expect((await embeddedRevisions())).toHaveLength(1);
    expect(await retrieve(independent, '   ')).toEqual({ state: 'UNAVAILABLE', reason: 'QUERY_EMPTY' });
    // An endpoint serving another model, or none at all: a metered failure, reported as unavailable.
    expect(await retrieve(independent, 'subnet', orchestratorWith(createFakeEmbeddingProvider({ model: 'not/served' }))))
      .toEqual({ state: 'UNAVAILABLE', reason: 'PROVIDER_FAILED' });
    expect(await retrieve(independent, 'subnet', orchestratorWith(new UnconfiguredEmbeddingProvider())))
      .toEqual({ state: 'UNAVAILABLE', reason: 'ENDPOINT_UNCONFIGURED' });
  });
});
