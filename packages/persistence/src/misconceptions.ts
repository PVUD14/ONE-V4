/**
 * Misconception codes, question-option tags and teaching strategies — storage and lifecycle
 * (ENG-07, migration 0049).
 *
 * Why this exists: the engine needs reviewed, versioned content that says which wrong idea a
 * distractor signals and which way of teaching fits. Every row is drafted against its own
 * content_revisions row and moves through the 0004 lifecycle, so author and approver stay
 * separate by trigger and nothing reaches a learner until a person publishes it through a
 * release manifest. Designs: docs/architecture/misconception-codes-table-design.md and its two
 * siblings.
 *
 * Written against PersistenceDb and never opens a transaction itself (the pattern of
 * exam-evidence-bridge.ts): callers run each function inside their own transaction, so a
 * multi-step publish commits or rolls back as one.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  assertContentTransition,
  misconceptionsForResponse,
  sha256Hex,
  stableStringify,
  validateEngineContentProvenance,
  validateMisconceptionCodeDraft,
  validateOptionTag,
  validateTeachingStrategyDraft,
  type ContentLifecycleState,
  type EngineContentProvenance,
  type MisconceptionCodeDraft,
  type ResponseMisconception,
  type StrategyApplicability,
  type TeachingStrategyDraft,
  type TeachingStrategyKind,
} from '@planthepath/career-readiness';
import type { PoolClient } from 'pg';
import type { PersistenceDb } from './repositories.js';
import { drizzleAsPgClient } from './learning-attempts.js';

type QueryResult<T> = { rows: T[] };

export const ENGINE_CONTENT_ENTITY_TYPES = ['MISCONCEPTION', 'QUESTION_OPTION_MISCONCEPTION', 'TEACHING_STRATEGY'] as const;
export type EngineContentEntityType = (typeof ENGINE_CONTENT_ENTITY_TYPES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_CODE_PATTERN = /^[A-Z0-9_:-]{3,64}$/;
const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as unknown as QueryResult<T>).rows;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

function uuidArrayLiteral(values: readonly string[], label: string): string {
  for (const value of values) assertUuid(value, label);
  return `{${values.join(',')}}`;
}

function provenanceColumns(provenance: EngineContentProvenance) {
  return {
    source: provenance.source,
    generatorVersion: provenance.generatorVersion ?? null,
    promptVersion: provenance.promptVersion ?? null,
    generatedAt: provenance.generatedAt ? provenance.generatedAt.toISOString() : null,
    basis: provenance.basis,
    expertCheckNotes: provenance.expertCheckNotes ?? null,
  };
}

/** The revision body is the reviewed snapshot; its hash is what a release manifest pins. */
async function insertDraftRevision(
  db: PersistenceDb,
  entityType: EngineContentEntityType,
  entityId: string,
  authorUserId: string,
  body: Record<string, unknown>,
): Promise<{ readonly revisionId: string; readonly contentHash: string }> {
  const revisionId = randomUUID();
  const contentHash = sha256Hex(stableStringify(body));
  await db.execute(sql`
    INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES (${revisionId}::uuid, ${entityType}, ${entityId}::uuid, 1, ${authorUserId}::uuid, 'DRAFT', ${contentHash},
            ${JSON.stringify(body)}::jsonb)
  `);
  return { revisionId, contentHash };
}

async function nextVersion(db: PersistenceDb, table: 'misconception_codes' | 'teaching_strategies', code: string): Promise<number> {
  const query = table === 'misconception_codes'
    ? sql`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM misconception_codes WHERE code = ${code}`
    : sql`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM teaching_strategies WHERE code = ${code}`;
  const [row] = await rows<{ next: number }>(db, query);
  return Number(row?.next ?? 1);
}

export interface CreatedEngineContent {
  readonly id: string;
  readonly revisionId: string;
  readonly contentHash: string;
}

/** A new version of a misconception, always DRAFT. */
export async function createMisconceptionCodeDraft(
  db: PersistenceDb,
  input: MisconceptionCodeDraft & { readonly authorUserId: string },
): Promise<CreatedEngineContent & { readonly code: string; readonly version: number }> {
  validateMisconceptionCodeDraft(input);
  assertUuid(input.authorUserId, 'authorUserId');
  assertUuid(input.skillId, 'skillId');
  const id = randomUUID();
  const version = await nextVersion(db, 'misconception_codes', input.code);
  const p = provenanceColumns(input);
  const body = {
    code: input.code, version, skillId: input.skillId, title: input.title, description: input.description,
    basis: p.basis, expertCheckNotes: p.expertCheckNotes, source: p.source,
    generatorVersion: p.generatorVersion, promptVersion: p.promptVersion, generatedAt: p.generatedAt,
  };
  const revision = await insertDraftRevision(db, 'MISCONCEPTION', id, input.authorUserId, body);
  await db.execute(sql`
    INSERT INTO misconception_codes
      (id, code, version, skill_id, title, description, basis, expert_check_notes, source, generator_version,
       prompt_version, generated_at, content_revision_id, created_by_user_id)
    VALUES (${id}::uuid, ${input.code}, ${version}, ${input.skillId}::uuid, ${input.title}, ${input.description},
            ${p.basis}, ${p.expertCheckNotes}, ${p.source}, ${p.generatorVersion}, ${p.promptVersion},
            ${p.generatedAt}::timestamptz, ${revision.revisionId}::uuid, ${input.authorUserId}::uuid)
  `);
  return { id, code: input.code, version, ...revision };
}

/** A new version of a teaching strategy, always DRAFT. */
export async function createTeachingStrategyDraft(
  db: PersistenceDb,
  input: TeachingStrategyDraft & { readonly authorUserId: string },
): Promise<CreatedEngineContent & { readonly code: string; readonly version: number }> {
  validateTeachingStrategyDraft(input);
  assertUuid(input.authorUserId, 'authorUserId');
  const id = randomUUID();
  const version = await nextVersion(db, 'teaching_strategies', input.code);
  const p = provenanceColumns(input);
  const body = {
    code: input.code, version, strategyKind: input.strategyKind, title: input.title, description: input.description,
    applicability: input.applicability, requiresModel: input.requiresModel,
    basis: p.basis, expertCheckNotes: p.expertCheckNotes, source: p.source,
    generatorVersion: p.generatorVersion, promptVersion: p.promptVersion, generatedAt: p.generatedAt,
  };
  const revision = await insertDraftRevision(db, 'TEACHING_STRATEGY', id, input.authorUserId, body);
  await db.execute(sql`
    INSERT INTO teaching_strategies
      (id, code, version, strategy_kind, title, description, applicability, requires_model, basis, expert_check_notes,
       source, generator_version, prompt_version, generated_at, content_revision_id, created_by_user_id)
    VALUES (${id}::uuid, ${input.code}, ${version}, ${input.strategyKind}, ${input.title}, ${input.description},
            ${JSON.stringify(input.applicability)}::jsonb, ${input.requiresModel}, ${p.basis}, ${p.expertCheckNotes},
            ${p.source}, ${p.generatorVersion}, ${p.promptVersion}, ${p.generatedAt}::timestamptz,
            ${revision.revisionId}::uuid, ${input.authorUserId}::uuid)
  `);
  return { id, code: input.code, version, ...revision };
}

export interface OptionMisconceptionDraft extends EngineContentProvenance {
  /** The QUESTION content revision (what question_versions.content_revision_id points at once published). */
  readonly questionRevisionId: string;
  readonly optionId: string;
  readonly misconceptionCodeId: string;
  readonly rationale: string;
  readonly authorUserId: string;
}

/** Tag one wrong option of a question revision with one misconception version, as DRAFT. */
export async function createQuestionOptionMisconceptionDraft(
  db: PersistenceDb,
  input: OptionMisconceptionDraft,
): Promise<CreatedEngineContent> {
  assertUuid(input.authorUserId, 'authorUserId');
  assertUuid(input.questionRevisionId, 'questionRevisionId');
  assertUuid(input.misconceptionCodeId, 'misconceptionCodeId');
  const [question] = await rows<{ entity_type: string; body: { options?: { id: string }[]; correctOptionId?: string } }>(db, sql`
    SELECT entity_type, body FROM content_revisions WHERE id = ${input.questionRevisionId}::uuid
  `);
  if (!question || question.entity_type !== 'QUESTION') throw new Error('question revision was not found');
  if (!Array.isArray(question.body.options) || typeof question.body.correctOptionId !== 'string') {
    throw new Error('question revision has no options or answer key');
  }
  validateOptionTag({ options: question.body.options, correctOptionId: question.body.correctOptionId }, input.optionId, input.rationale);
  validateEngineContentProvenance(input);
  const id = randomUUID();
  const p = provenanceColumns(input);
  const body = {
    questionRevisionId: input.questionRevisionId, optionId: input.optionId, misconceptionCodeId: input.misconceptionCodeId,
    rationale: input.rationale, basis: p.basis, expertCheckNotes: p.expertCheckNotes, source: p.source,
    generatorVersion: p.generatorVersion, promptVersion: p.promptVersion, generatedAt: p.generatedAt,
  };
  const revision = await insertDraftRevision(db, 'QUESTION_OPTION_MISCONCEPTION', id, input.authorUserId, body);
  await db.execute(sql`
    INSERT INTO question_option_misconceptions
      (id, question_revision_id, option_id, misconception_code_id, rationale, basis, expert_check_notes, source,
       generator_version, prompt_version, generated_at, content_revision_id, created_by_user_id)
    VALUES (${id}::uuid, ${input.questionRevisionId}::uuid, ${input.optionId}, ${input.misconceptionCodeId}::uuid,
            ${input.rationale}, ${p.basis}, ${p.expertCheckNotes}, ${p.source}, ${p.generatorVersion},
            ${p.promptVersion}, ${p.generatedAt}::timestamptz, ${revision.revisionId}::uuid, ${input.authorUserId}::uuid)
  `);
  return { id, ...revision };
}

export type EngineReviewTarget = 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED';
const ACTION_FOR: Readonly<Record<EngineReviewTarget, string>> = {
  IN_REVIEW: 'SUBMIT', CHANGES_REQUESTED: 'REQUEST_CHANGES', APPROVED: 'APPROVE',
};

/**
 * Submit, request changes or approve one engine-content revision. The author submits; nobody
 * approves their own work (assertContentTransition here, enforce_content_review_separation in
 * the database). Publication is only publishEngineContentRelease. Archiving is not offered:
 * the 0004 trigger makes a published revision immutable, archive included.
 */
export async function transitionEngineContent(
  db: PersistenceDb,
  input: {
    readonly revisionId: string; readonly to: EngineReviewTarget; readonly actorUserId: string;
    readonly reasonCode: string; readonly correlationId: string;
  },
): Promise<{ readonly revisionId: string; readonly from: ContentLifecycleState; readonly to: EngineReviewTarget }> {
  assertUuid(input.revisionId, 'revisionId');
  assertUuid(input.actorUserId, 'actorUserId');
  if (!REASON_CODE_PATTERN.test(input.reasonCode)) throw new Error('reason code is invalid');
  if (!CORRELATION_PATTERN.test(input.correlationId)) throw new Error('correlation id is invalid');
  if (!(input.to in ACTION_FOR)) throw new Error('engine content can only be submitted, sent back or approved here');
  const [revision] = await rows<{ entity_type: string; author_user_id: string; state: ContentLifecycleState }>(db, sql`
    SELECT entity_type, author_user_id, state FROM content_revisions WHERE id = ${input.revisionId}::uuid FOR UPDATE
  `);
  if (!revision || !(ENGINE_CONTENT_ENTITY_TYPES as readonly string[]).includes(revision.entity_type)) {
    throw new Error('engine content revision was not found');
  }
  if (input.to === 'IN_REVIEW' && revision.author_user_id !== input.actorUserId) throw new Error('only the author submits content for review');
  assertContentTransition({ from: revision.state, to: input.to, authorUserId: revision.author_user_id, actorUserId: input.actorUserId });
  await db.execute(sql`
    INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
    VALUES (${randomUUID()}::uuid, ${input.revisionId}::uuid, ${input.actorUserId}::uuid, ${ACTION_FOR[input.to]},
            ${revision.state}, ${input.to}, ${input.reasonCode}, ${input.correlationId})
  `);
  await db.execute(sql`UPDATE content_revisions SET state = ${input.to} WHERE id = ${input.revisionId}::uuid`);
  return { revisionId: input.revisionId, from: revision.state, to: input.to };
}

const PUBLISH_ORDER: Readonly<Record<EngineContentEntityType, number>> = {
  MISCONCEPTION: 0, TEACHING_STRATEGY: 1, QUESTION_OPTION_MISCONCEPTION: 2,
};

/**
 * Publish approved engine-content revisions through one release manifest, the way the pilot
 * release is published: manifest items while DRAFT, approve, publish, then each revision
 * APPROVED → PUBLISHED with a PUBLISH action. Codes publish before the tags that use them.
 * Refuses unless every revision is an APPROVED engine revision and neither the manifest
 * approver nor the publisher authored any of them. The source record must already be
 * release-eligible (rights reviewed) — the 0004 trigger refuses otherwise.
 */
export async function publishEngineContentRelease(
  db: PersistenceDb,
  input: {
    readonly revisionIds: readonly string[]; readonly releaseName: string; readonly releaseVersion: number;
    readonly sourceRecordId: string; readonly approverUserId: string; readonly publisherUserId: string;
    readonly correlationId: string;
  },
): Promise<{ readonly releaseManifestId: string; readonly published: number }> {
  if (input.revisionIds.length === 0) throw new Error('a release needs at least one revision');
  if (new Set(input.revisionIds).size !== input.revisionIds.length) throw new Error('a release lists each revision once');
  if (!CORRELATION_PATTERN.test(input.correlationId)) throw new Error('correlation id is invalid');
  if (!Number.isInteger(input.releaseVersion) || input.releaseVersion < 1) throw new Error('release version is invalid');
  if (input.releaseName.trim().length < 1 || input.releaseName.length > 160) throw new Error('release name is invalid');
  assertUuid(input.sourceRecordId, 'sourceRecordId');
  assertUuid(input.approverUserId, 'approverUserId');
  assertUuid(input.publisherUserId, 'publisherUserId');
  const ids = uuidArrayLiteral(input.revisionIds, 'revisionIds');
  const revisions = await rows<{ id: string; entity_type: EngineContentEntityType; author_user_id: string; state: string; content_hash: string }>(db, sql`
    SELECT id, entity_type, author_user_id, state, content_hash FROM content_revisions
    WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE
  `);
  if (revisions.length !== input.revisionIds.length) throw new Error('a revision in the release was not found');
  for (const revision of revisions) {
    if (!(ENGINE_CONTENT_ENTITY_TYPES as readonly string[]).includes(revision.entity_type)) throw new Error('only engine content is published here');
    if (revision.state !== 'APPROVED') throw new Error('only approved revisions can be published');
    if (revision.author_user_id === input.publisherUserId) throw new Error('authors cannot publish their own content');
    if (revision.author_user_id === input.approverUserId) throw new Error('authors cannot approve a release of their own content');
  }
  const manifestId = randomUUID();
  const manifestHash = sha256Hex(stableStringify({
    name: input.releaseName, version: input.releaseVersion,
    items: revisions.map((revision) => ({ id: revision.id, hash: revision.content_hash })),
  }));
  await db.execute(sql`
    INSERT INTO release_manifests (id, name, version, manifest_hash, status)
    VALUES (${manifestId}::uuid, ${input.releaseName}, ${input.releaseVersion}, ${manifestHash}, 'DRAFT')
  `);
  for (const revision of revisions) {
    await db.execute(sql`
      INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash)
      VALUES (${manifestId}::uuid, ${revision.id}::uuid, ${input.sourceRecordId}::uuid, ${revision.content_hash})
    `);
  }
  await db.execute(sql`
    UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = ${input.approverUserId}::uuid, approved_at = now()
    WHERE id = ${manifestId}::uuid
  `);
  await db.execute(sql`
    UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = ${input.publisherUserId}::uuid, published_at = now()
    WHERE id = ${manifestId}::uuid
  `);
  const ordered = [...revisions].sort((left, right) =>
    PUBLISH_ORDER[left.entity_type] - PUBLISH_ORDER[right.entity_type] || (left.id < right.id ? -1 : 1));
  for (const revision of ordered) {
    await db.execute(sql`
      UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = ${manifestId}::uuid, published_at = now()
      WHERE id = ${revision.id}::uuid
    `);
    await db.execute(sql`
      INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
      VALUES (${randomUUID()}::uuid, ${revision.id}::uuid, ${input.publisherUserId}::uuid, 'PUBLISH', 'APPROVED', 'PUBLISHED',
              'ENGINE_CONTENT_RELEASED', ${input.correlationId})
    `);
  }
  return { releaseManifestId: manifestId, published: revisions.length };
}

export interface GradedChoice {
  readonly questionVersionId: string;
  /** NULL for a blank response. */
  readonly selectedOptionId: string | null;
}

/**
 * The published misconceptions each response signals. Only tags and codes that are both
 * PUBLISHED count; a draft never reaches a learner's record. A correct, blank or untagged
 * response yields none (misconceptionsForResponse). The attempt writer (ENG-03) stores the
 * returned ids on the attempt row at insert; the projector (ENG-05) derives active codes.
 */
export async function resolveResponseMisconceptions(
  db: PersistenceDb,
  responses: readonly GradedChoice[],
): Promise<readonly (GradedChoice & { readonly misconceptions: readonly ResponseMisconception[] })[]> {
  return resolveResponseMisconceptionsWith(drizzleAsPgClient(db), responses);
}

/**
 * The same resolution over a pg-style client, so the readiness-check submit (a pg transaction)
 * can resolve its responses and store the ids on the attempt rows it writes (ENG-05, 0052).
 */
export async function resolveResponseMisconceptionsWith(
  client: Pick<PoolClient, 'query'>,
  responses: readonly GradedChoice[],
): Promise<readonly (GradedChoice & { readonly misconceptions: readonly ResponseMisconception[] })[]> {
  if (responses.length === 0) return [];
  const ids = uuidArrayLiteral([...new Set(responses.map((response) => response.questionVersionId))], 'questionVersionId');
  const found = (await client.query<{
    question_version_id: string; correct_option_id: string;
    option_id: string | null; misconception_code_id: string | null; code: string | null;
  }>(
    `SELECT q.id AS question_version_id, k.correct_option_id, t.option_id, c.id AS misconception_code_id, c.code
     FROM question_versions q
     JOIN question_answer_keys k ON k.question_version_id = q.id
     LEFT JOIN question_option_misconceptions t
       ON t.question_revision_id = q.content_revision_id AND t.review_state = 'PUBLISHED'
     LEFT JOIN misconception_codes c ON c.id = t.misconception_code_id AND c.review_state = 'PUBLISHED'
     WHERE q.id = ANY($1::uuid[])
     ORDER BY q.id, t.option_id, c.id`,
    [ids],
  )).rows;
  const byQuestion = new Map<string, { correctOptionId: string; tags: { optionId: string; misconceptionCodeId: string; code: string }[] }>();
  for (const row of found) {
    const entry = byQuestion.get(row.question_version_id) ?? { correctOptionId: row.correct_option_id, tags: [] };
    if (row.option_id && row.misconception_code_id && row.code) {
      entry.tags.push({ optionId: row.option_id, misconceptionCodeId: row.misconception_code_id, code: row.code });
    }
    byQuestion.set(row.question_version_id, entry);
  }
  return responses.map((response) => {
    const question = byQuestion.get(response.questionVersionId);
    if (!question) throw new Error('response references an unknown question version');
    return {
      ...response,
      misconceptions: misconceptionsForResponse({
        selectedOptionId: response.selectedOptionId, correctOptionId: question.correctOptionId, tags: question.tags,
      }),
    };
  });
}

export interface PublishedTeachingStrategy {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly strategyKind: TeachingStrategyKind;
  readonly title: string;
  readonly description: string;
  readonly applicability: StrategyApplicability;
  readonly requiresModel: boolean;
}

/** Only PUBLISHED strategy versions, in a stable order. Drafts are never returned. */
export async function listPublishedTeachingStrategies(db: PersistenceDb): Promise<readonly PublishedTeachingStrategy[]> {
  const found = await rows<{
    id: string; code: string; version: number; strategy_kind: TeachingStrategyKind; title: string;
    description: string; applicability: StrategyApplicability; requires_model: boolean;
  }>(db, sql`
    SELECT id, code, version, strategy_kind, title, description, applicability, requires_model
    FROM teaching_strategies WHERE review_state = 'PUBLISHED' ORDER BY code, version
  `);
  return found.map((row) => ({
    id: row.id, code: row.code, version: Number(row.version), strategyKind: row.strategy_kind, title: row.title,
    description: row.description, applicability: row.applicability, requiresModel: row.requires_model,
  }));
}

// ---------------------------------------------------------------------------
// Agent-drafted content packs
// ---------------------------------------------------------------------------

export interface TeachingStrategyDraftPack {
  readonly notice: string;
  readonly generatorVersion: string;
  readonly promptVersion: string;
  readonly generatedAt: string;
  readonly strategies: readonly {
    readonly code: string; readonly strategyKind: TeachingStrategyKind; readonly title: string; readonly description: string;
    readonly applicability: StrategyApplicability; readonly requiresModel: boolean; readonly basis: string;
    readonly expertCheckNotes: string;
  }[];
}

/**
 * Import an agent-drafted pack as DRAFT versions attributed to the importing user, with
 * AGENT_DRAFTED provenance (program B.8). Never submits, approves or publishes. Idempotent:
 * an entry whose latest version already has the same content is skipped.
 */
export async function importTeachingStrategyDraftPack(
  db: PersistenceDb,
  pack: TeachingStrategyDraftPack,
  importerUserId: string,
): Promise<{ readonly created: readonly string[]; readonly skipped: readonly string[] }> {
  const generatedAt = new Date(pack.generatedAt);
  if (!/DRAFT/.test(pack.notice)) throw new Error('a draft pack must say it is a draft');
  const created: string[] = [];
  const skipped: string[] = [];
  for (const entry of pack.strategies) {
    const [latest] = await rows<Record<string, unknown>>(db, sql`
      SELECT strategy_kind, title, description, applicability, requires_model, basis, expert_check_notes
      FROM teaching_strategies WHERE code = ${entry.code} ORDER BY version DESC LIMIT 1
    `);
    const incoming = {
      strategy_kind: entry.strategyKind, title: entry.title, description: entry.description,
      applicability: entry.applicability, requires_model: entry.requiresModel, basis: entry.basis,
      expert_check_notes: entry.expertCheckNotes,
    };
    if (latest && stableStringify(latest) === stableStringify(incoming)) {
      skipped.push(entry.code);
      continue;
    }
    await createTeachingStrategyDraft(db, {
      ...entry, source: 'AGENT_DRAFTED', generatorVersion: pack.generatorVersion, promptVersion: pack.promptVersion,
      generatedAt, authorUserId: importerUserId,
    });
    created.push(entry.code);
  }
  return { created, skipped };
}
