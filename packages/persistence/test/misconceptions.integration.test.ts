/**
 * Integration tests for ENG-07: misconception codes, question-option tags and teaching
 * strategies on the 0004 content lifecycle (migration 0049).
 *
 * The acceptance test is "a wrong option tagged with a code resolves to that code"; the other
 * tests pin the governance that makes that safe — rows are born DRAFT, review_state follows the
 * revision, authors cannot approve or publish their own work, a tag can never sit on the correct
 * option, and nothing unpublished is ever resolved. All data is synthetic and every test runs in
 * a transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../src/schema.js';
import type { PersistenceDb } from '../src/repositories.js';
import {
  createMisconceptionCodeDraft,
  createQuestionOptionMisconceptionDraft,
  createTeachingStrategyDraft,
  importTeachingStrategyDraftPack,
  listPublishedTeachingStrategies,
  publishEngineContentRelease,
  resolveResponseMisconceptions,
  transitionEngineContent,
  type TeachingStrategyDraftPack,
} from '../src/misconceptions.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for persistence integration tests');
const pool = new Pool({ connectionString });
const migrationDir = new URL('../drizzle/', import.meta.url);
const SHA = 'a'.repeat(64);

let client: PoolClient;
let db: PersistenceDb;
let authorId: string;
let reviewerId: string;
let publisherId: string;
let topicId: string;
let sourceRecordId: string;

beforeAll(async () => {
  for (const name of (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrationDir), 'utf8'));
  }
});

beforeEach(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  db = drizzle(client as never, { schema }) as unknown as PersistenceDb;
  authorId = randomUUID();
  reviewerId = randomUUID();
  publisherId = randomUUID();
  for (const id of [authorId, reviewerId, publisherId]) {
    await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [id, `${id}@example.test`]);
  }
  // A release-eligible synthetic source record (rights, SME and quality already reviewed).
  const runId = randomUUID();
  const packageId = randomUUID();
  sourceRecordId = randomUUID();
  await client.query(
    `INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, completed_at)
     VALUES ($1,$2,'synthetic/eng-07',$3,$4,'eng07-test','STAGED',$5,now())`,
    [runId, `eng07-${runId}`, 'b'.repeat(40), SHA, authorId],
  );
  await client.query(
    `INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
     VALUES ($1,$2,$3,'synthetic/eng-07',$4,$5,'eng07-test','[]','{}','{}')`,
    [packageId, runId, `eng07-${packageId}`, 'b'.repeat(40), SHA],
  );
  await client.query(
    `INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, license_label,
       rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, release_eligible)
     VALUES ($1,$2,'ENGINE_CONTENT','eng07','synthetic.json',$3,'Synthetic','APPROVED','APPROVED','APPROVED','MAPPED','UNIQUE','ELIGIBLE',true)`,
    [sourceRecordId, packageId, SHA],
  );
  topicId = randomUUID();
  const topicRevision = randomUUID();
  await client.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
     VALUES ($1,'TOPIC',$2,1,$3,'DRAFT',$4,'{}')`, [topicRevision, topicId, authorId, SHA],
  );
  await client.query(
    `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
     VALUES ($1,'TOPIC',$2,1,'Synthetic subnetting','Synthetic topic for ENG-07 tests',$3)`,
    [topicId, `eng07-topic-${topicId}`, topicRevision],
  );
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
});

afterAll(async () => { await pool.end(); });

/** Runs a statement expected to fail without aborting the test transaction. */
async function expectRefusal(action: () => Promise<unknown>, message: string): Promise<void> {
  await client.query('SAVEPOINT refusal');
  try {
    await action();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT refusal');
    expect(String((error as Error).message ?? error) + String((error as { cause?: Error }).cause?.message ?? '')).toContain(message);
    return;
  }
  await client.query('RELEASE SAVEPOINT refusal');
  throw new Error(`expected refusal containing "${message}"`);
}

/** A synthetic question published through the 0004 lifecycle, as the pilot release does. */
async function publishedQuestion(): Promise<{ questionVersionId: string; revisionId: string }> {
  const questionId = randomUUID();
  const revisionId = randomUUID();
  const body = {
    id: questionId, stableKey: `eng07-q-${questionId}`, topicId, prompt: 'Synthetic: how many usable hosts in a /30?',
    options: [{ id: 'a', text: '4' }, { id: 'b', text: '2' }, { id: 'c', text: '3' }], correctOptionId: 'b',
    explanation: 'Synthetic.',
  };
  await client.query(
    `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
     VALUES ($1,'QUESTION',$2,1,$3,'DRAFT',$4,$5::jsonb)`, [revisionId, questionId, authorId, SHA, JSON.stringify(body)],
  );
  await client.query("UPDATE content_revisions SET state='IN_REVIEW' WHERE id=$1", [revisionId]);
  await client.query(
    `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
     VALUES ($1,$2,$3,'APPROVE','IN_REVIEW','APPROVED','SYNTHETIC_OK','eng07-question-approve')`, [randomUUID(), revisionId, reviewerId],
  );
  await client.query("UPDATE content_revisions SET state='APPROVED' WHERE id=$1", [revisionId]);
  const manifestId = randomUUID();
  await client.query(
    `INSERT INTO release_manifests (id, name, version, manifest_hash, status) VALUES ($1,$2,1,$3,'DRAFT')`,
    [manifestId, `eng07-question-${manifestId}`, manifestId.replace(/-/g, '').repeat(2)],
  );
  await client.query(
    'INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash) VALUES ($1,$2,$3,$4)',
    [manifestId, revisionId, sourceRecordId, SHA],
  );
  await client.query("UPDATE release_manifests SET status='APPROVED', approved_by_user_id=$2, approved_at=now() WHERE id=$1", [manifestId, reviewerId]);
  await client.query("UPDATE release_manifests SET status='PUBLISHED', published_by_user_id=$2, published_at=now() WHERE id=$1", [manifestId, publisherId]);
  await client.query("UPDATE content_revisions SET state='PUBLISHED', release_manifest_id=$2, published_at=now() WHERE id=$1", [revisionId, manifestId]);
  await client.query(
    `INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
     VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,$7,now())`,
    [questionId, body.stableKey, topicId, body.prompt, JSON.stringify(body.options), revisionId, manifestId],
  );
  await client.query(
    `INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash) VALUES ($1,'b','Synthetic.',$2)`,
    [questionId, SHA],
  );
  return { questionVersionId: questionId, revisionId };
}

const agentDrafted = {
  source: 'AGENT_DRAFTED' as const,
  generatorVersion: 'claude-opus-5-5',
  promptVersion: 'eng-07-test',
  generatedAt: new Date('2026-09-26T00:00:00Z'),
  basis: 'Synthetic basis for a test.',
  expertCheckNotes: 'Synthetic: nothing here is a real claim.',
};

async function draftCode(code = `SYN_${randomUUID().slice(0, 8).toUpperCase()}`) {
  return createMisconceptionCodeDraft(db, {
    ...agentDrafted, code, skillId: topicId, title: 'Counts network and broadcast as hosts',
    description: 'Synthetic: the student forgets to subtract the network and broadcast addresses.', authorUserId: authorId,
  });
}

async function review(revisionId: string, to: 'IN_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED', actor: string) {
  return transitionEngineContent(db, { revisionId, to, actorUserId: actor, reasonCode: 'SYNTHETIC_REVIEW', correlationId: `eng07-${randomUUID()}` });
}

async function approve(revisionId: string) {
  await review(revisionId, 'IN_REVIEW', authorId);
  await review(revisionId, 'APPROVED', reviewerId);
}

async function publish(revisionIds: string[]) {
  return publishEngineContentRelease(db, {
    revisionIds, releaseName: `eng07-release-${randomUUID()}`, releaseVersion: 1, sourceRecordId,
    approverUserId: reviewerId, publisherUserId: publisherId, correlationId: `eng07-${randomUUID()}`,
  });
}

async function stateOf(table: string, id: string): Promise<string> {
  const result = await client.query<{ review_state: string }>(`SELECT review_state FROM ${table} WHERE id=$1`, [id]);
  return result.rows[0]?.review_state ?? 'MISSING';
}

describe('ENG-07 acceptance: a wrong option tagged with a code resolves to that code', () => {
  it('resolves the published code for the tagged wrong option, and nothing for correct, untagged or draft-tagged options', async () => {
    const question = await publishedQuestion();
    const code = await draftCode('SYN_HOSTS_INCLUDE_NETWORK');
    const tag = await createQuestionOptionMisconceptionDraft(db, {
      ...agentDrafted, questionRevisionId: question.revisionId, optionId: 'a', misconceptionCodeId: code.id,
      rationale: 'Synthetic: 4 is the block size, so choosing it counts the network and broadcast addresses.', authorUserId: authorId,
    });
    await approve(code.revisionId);
    await approve(tag.revisionId);
    await publish([tag.revisionId, code.revisionId]);
    // A second tag on option c stays a draft: it must never be resolved.
    const otherCode = await draftCode();
    await createQuestionOptionMisconceptionDraft(db, {
      ...agentDrafted, questionRevisionId: question.revisionId, optionId: 'c', misconceptionCodeId: otherCode.id,
      rationale: 'Synthetic draft tag.', authorUserId: authorId,
    });

    const resolved = await resolveResponseMisconceptions(db, [
      { questionVersionId: question.questionVersionId, selectedOptionId: 'a' },
      { questionVersionId: question.questionVersionId, selectedOptionId: 'b' },
      { questionVersionId: question.questionVersionId, selectedOptionId: 'c' },
      { questionVersionId: question.questionVersionId, selectedOptionId: null },
    ]);
    expect(resolved.map((item) => item.misconceptions)).toEqual([
      [{ misconceptionCodeId: code.id, code: 'SYN_HOSTS_INCLUDE_NETWORK' }], [], [], [],
    ]);
    expect(await stateOf('misconception_codes', code.id)).toBe('PUBLISHED');
    expect(await stateOf('question_option_misconceptions', tag.id)).toBe('PUBLISHED');
  });

  it('refuses a response on an unknown question version', async () => {
    await expectRefusal(() => resolveResponseMisconceptions(db, [{ questionVersionId: randomUUID(), selectedOptionId: 'a' }]), 'unknown question version');
  });
});

describe('lifecycle and provenance', () => {
  it('every row lands as DRAFT with its provenance, and review_state follows the revision', async () => {
    const code = await draftCode();
    const row = await client.query(
      'SELECT review_state, source, generator_version, prompt_version, generated_at, expert_check_notes FROM misconception_codes WHERE id=$1', [code.id],
    );
    expect(row.rows[0]).toMatchObject({ review_state: 'DRAFT', source: 'AGENT_DRAFTED', generator_version: 'claude-opus-5-5', prompt_version: 'eng-07-test' });
    await review(code.revisionId, 'IN_REVIEW', authorId);
    expect(await stateOf('misconception_codes', code.id)).toBe('IN_REVIEW');
    await review(code.revisionId, 'CHANGES_REQUESTED', reviewerId);
    expect(await stateOf('misconception_codes', code.id)).toBe('CHANGES_REQUESTED');
    const actions = await client.query('SELECT action FROM content_review_actions WHERE content_revision_id=$1 ORDER BY occurred_at', [code.revisionId]);
    expect(actions.rows.map((item) => item.action)).toEqual(['SUBMIT', 'REQUEST_CHANGES']);
  });

  it('an author cannot approve or publish their own content', async () => {
    const code = await draftCode();
    await review(code.revisionId, 'IN_REVIEW', authorId);
    await expectRefusal(() => review(code.revisionId, 'APPROVED', authorId), 'authors cannot approve their own content');
    await review(code.revisionId, 'APPROVED', reviewerId);
    await expectRefusal(() => publishEngineContentRelease(db, {
      revisionIds: [code.revisionId], releaseName: 'eng07-self', releaseVersion: 1, sourceRecordId,
      approverUserId: reviewerId, publisherUserId: authorId, correlationId: 'eng07-self-publish',
    }), 'authors cannot publish their own content');
  });

  it('the database refuses a self-approval even when the application check is bypassed', async () => {
    const code = await draftCode();
    await expectRefusal(() => client.query(
      `INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
       VALUES ($1,$2,$3,'APPROVE','IN_REVIEW','APPROVED','SELF','eng07-self-approve')`, [randomUUID(), code.revisionId, authorId],
    ), 'author cannot approve own content revision');
  });

  it('only approved revisions are published, and a draft is never listed', async () => {
    const strategy = await createTeachingStrategyDraft(db, {
      ...agentDrafted, code: 'SYN_WORKED', strategyKind: 'WORKED_EXAMPLE', title: 'Synthetic', description: 'Synthetic strategy.',
      applicability: { modes: ['LEARN'] }, requiresModel: false, authorUserId: authorId,
    });
    await expectRefusal(() => publish([strategy.revisionId]), 'only approved revisions can be published');
    expect((await listPublishedTeachingStrategies(db)).some((item) => item.id === strategy.id)).toBe(false);
    await approve(strategy.revisionId);
    await publish([strategy.revisionId]);
    const listed = await listPublishedTeachingStrategies(db);
    expect(listed.find((item) => item.id === strategy.id)).toMatchObject({ code: 'SYN_WORKED', version: 1, strategyKind: 'WORKED_EXAMPLE', requiresModel: false });
  });

  it('review_state cannot be set directly, published content cannot change, and rows cannot be deleted', async () => {
    const code = await draftCode();
    await expectRefusal(() => client.query("UPDATE misconception_codes SET review_state='PUBLISHED' WHERE id=$1", [code.id]), 'review_state follows the content revision');
    await client.query("UPDATE misconception_codes SET title='Edited while draft' WHERE id=$1", [code.id]);
    await expectRefusal(() => client.query("UPDATE misconception_codes SET code='SYN_RENAMED' WHERE id=$1", [code.id]), 'identity and provenance are immutable');
    await review(code.revisionId, 'IN_REVIEW', authorId);
    await expectRefusal(() => client.query("UPDATE misconception_codes SET title='Changed under review' WHERE id=$1", [code.id]), 'only be edited while DRAFT or CHANGES_REQUESTED');
    await expectRefusal(() => client.query('DELETE FROM misconception_codes WHERE id=$1', [code.id]), 'cannot be deleted');
  });

  it('a row cannot be inserted against a revision that is not DRAFT or belongs to something else', async () => {
    const code = await draftCode();
    await expectRefusal(() => client.query(
      `INSERT INTO misconception_codes (id, code, version, skill_id, title, description, basis, source, content_revision_id, created_by_user_id)
       VALUES ($1,'SYN_HIJACK',1,$2,'t','d','b','AUTHORED',$3,$4)`, [randomUUID(), topicId, code.revisionId, authorId],
    ), 'does not belong to this engine content row');
  });

  it('agent-drafted content without expert-check notes is refused by the database', async () => {
    const id = randomUUID();
    const revisionId = randomUUID();
    await client.query(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
       VALUES ($1,'MISCONCEPTION',$2,1,$3,'DRAFT',$4,'{}')`, [revisionId, id, authorId, SHA],
    );
    await expectRefusal(() => client.query(
      `INSERT INTO misconception_codes (id, code, version, skill_id, title, description, basis, source, generator_version, prompt_version, generated_at, content_revision_id, created_by_user_id)
       VALUES ($1,'SYN_NO_NOTES',1,$2,'t','d','b','AGENT_DRAFTED','m','p',now(),$3,$4)`, [id, topicId, revisionId, authorId],
    ), 'misconception_codes_provenance_ck');
  });

  it('a misconception must belong to a SKILL or TOPIC node', async () => {
    const careerRole = randomUUID();
    const revision = randomUUID();
    await client.query(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
       VALUES ($1,'CAREER_ROLE',$2,1,$3,'DRAFT',$4,'{}')`, [revision, careerRole, authorId, SHA],
    );
    await client.query(
      `INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id)
       VALUES ($1,'CAREER_ROLE',$2,1,'Synthetic role','Synthetic',$3)`, [careerRole, `eng07-role-${careerRole}`, revision],
    );
    await expectRefusal(() => createMisconceptionCodeDraft(db, {
      ...agentDrafted, code: 'SYN_WRONG_NODE', skillId: careerRole, title: 't', description: 'd', authorUserId: authorId,
    }), 'SKILL or TOPIC');
  });
});

describe('option tags', () => {
  it('refuses a tag on the correct option or a missing option, in the application and in the database', async () => {
    const question = await publishedQuestion();
    const code = await draftCode();
    const base = { ...agentDrafted, questionRevisionId: question.revisionId, misconceptionCodeId: code.id, rationale: 'Synthetic.', authorUserId: authorId };
    await expectRefusal(() => createQuestionOptionMisconceptionDraft(db, { ...base, optionId: 'b' }), 'correct option cannot carry a misconception');
    await expectRefusal(() => createQuestionOptionMisconceptionDraft(db, { ...base, optionId: 'z' }), 'does not exist');
    const id = randomUUID();
    const revisionId = randomUUID();
    await client.query(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
       VALUES ($1,'QUESTION_OPTION_MISCONCEPTION',$2,1,$3,'DRAFT',$4,'{}')`, [revisionId, id, authorId, SHA],
    );
    await expectRefusal(() => client.query(
      `INSERT INTO question_option_misconceptions (id, question_revision_id, option_id, misconception_code_id, rationale, basis, source, content_revision_id, created_by_user_id)
       VALUES ($1,$2,'b',$3,'r','b','AUTHORED',$4,$5)`, [id, question.revisionId, code.id, revisionId, authorId],
    ), 'correct option cannot carry a misconception');
  });

  it('a tag cannot be published before its misconception code', async () => {
    const question = await publishedQuestion();
    const code = await draftCode();
    const tag = await createQuestionOptionMisconceptionDraft(db, {
      ...agentDrafted, questionRevisionId: question.revisionId, optionId: 'a', misconceptionCodeId: code.id, rationale: 'Synthetic.', authorUserId: authorId,
    });
    await approve(tag.revisionId);
    await expectRefusal(() => publish([tag.revisionId]), 'published misconception code');
  });

  it('a tag cannot be published on a question that is not published', async () => {
    const questionId = randomUUID();
    const questionRevision = randomUUID();
    await client.query(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
       VALUES ($1,'QUESTION',$2,1,$3,'DRAFT',$4,$5::jsonb)`,
      [questionRevision, questionId, reviewerId, SHA, JSON.stringify({ options: [{ id: 'a' }, { id: 'b' }], correctOptionId: 'b' })],
    );
    const code = await draftCode();
    const tag = await createQuestionOptionMisconceptionDraft(db, {
      ...agentDrafted, questionRevisionId: questionRevision, optionId: 'a', misconceptionCodeId: code.id, rationale: 'Synthetic draft item tag.', authorUserId: authorId,
    });
    expect(await stateOf('question_option_misconceptions', tag.id)).toBe('DRAFT');
    await approve(code.revisionId);
    await approve(tag.revisionId);
    await expectRefusal(() => publish([code.revisionId, tag.revisionId]), 'published question');
  });
});

describe('agent-drafted teaching strategy pack', () => {
  it('imports every entry as DRAFT with AGENT_DRAFTED provenance and expert-check notes, and is idempotent', async () => {
    const pack = JSON.parse(await readFile(new URL('../../../data/engine/teaching-strategies-v1.draft.json', import.meta.url), 'utf8')) as TeachingStrategyDraftPack;
    const importer = randomUUID();
    await client.query("INSERT INTO users (id, email, state) VALUES ($1, $2, 'ACTIVE')", [importer, `${importer}@example.test`]);
    const first = await importTeachingStrategyDraftPack(db, pack, importer);
    expect(first.created).toHaveLength(7);
    const kinds = new Set(pack.strategies.map((entry) => entry.strategyKind));
    expect(kinds).toEqual(new Set(['WORKED_EXAMPLE', 'GUIDED_PRACTICE', 'SOCRATIC_QUESTIONING', 'HINT_LADDER', 'ERROR_CORRECTION', 'RETRIEVAL_PRACTICE', 'TEACH_BACK']));
    const imported = await client.query(
      `SELECT s.review_state, s.source, s.expert_check_notes, r.state AS revision_state
       FROM teaching_strategies s JOIN content_revisions r ON r.id = s.content_revision_id WHERE s.created_by_user_id = $1`, [importer],
    );
    expect(imported.rows).toHaveLength(7);
    for (const row of imported.rows) {
      expect(row).toMatchObject({ review_state: 'DRAFT', source: 'AGENT_DRAFTED', revision_state: 'DRAFT' });
      expect(String(row.expert_check_notes).length).toBeGreaterThan(0);
    }
    const second = await importTeachingStrategyDraftPack(db, pack, importer);
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(7);
    const importedIds = await client.query<{ id: string }>('SELECT id FROM teaching_strategies WHERE created_by_user_id = $1', [importer]);
    const listed = new Set((await listPublishedTeachingStrategies(db)).map((item) => item.id));
    expect(importedIds.rows.some((row) => listed.has(row.id))).toBe(false);
  });
});

describe('migration 0049', () => {
  it('replays cleanly and keeps every earlier content entity type', async () => {
    await client.query(await readFile(new URL('0049_misconceptions_and_teaching_strategies.sql', migrationDir), 'utf8'));
    for (const entityType of ['CAREER_ROLE', 'SUBJECT', 'TOPIC', 'SKILL', 'MODULE', 'LESSON', 'QUESTION', 'ASSESSMENT_BLUEPRINT']) {
      await client.query(
        `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
         VALUES ($1,$2,$3,1,$4,'DRAFT',$5,'{}')`, [randomUUID(), entityType, randomUUID(), authorId, SHA],
      );
    }
    await expectRefusal(() => client.query(
      `INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
       VALUES ($1,'NOT_A_TYPE',$2,1,$3,'DRAFT',$4,'{}')`, [randomUUID(), randomUUID(), authorId, SHA],
    ), 'content_revisions_entity_type_check');
  });
});
