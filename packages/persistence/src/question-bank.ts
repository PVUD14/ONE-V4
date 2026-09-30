/**
 * Question bank persistence (OPS-09b, migration 0061): readiness-check questions as versioned
 * content revisions, taken from draft through review (with its rights review) to a publish that
 * writes the learner-facing `question_versions` row and the grading-only `question_answer_keys`
 * row, through a release manifest and under a second person's approval.
 *
 * Why this exists: the only way an item reached the readiness bank was the pilot seed. This is
 * the operator path, built on the 0004 pipeline and ENG-07's tag table rather than beside them.
 * The body of a revision is the draft; submitting writes the rows the reviewer approves (the
 * option tags into `question_option_misconceptions`, the hint ladder into
 * `question_hint_ladders`), and they move and publish with the question. Every write puts its
 * audit row and outbox event in its own transaction; the pure rules live in
 * packages/career-readiness (content) and packages/authorization (who, and when an approval is
 * needed). Answer keys leave this module only when the caller says the viewer may see them.
 *
 * Designs: docs/architecture/question-bank-editor-design.md, question-hint-ladders-table-design.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  composeQuestionBody,
  publishedQuestionColumns,
  questionMisconceptionTags,
  QUESTION_LICENCES_REQUIRING_ATTRIBUTION,
  readAgentDraftProvenance,
  readQuestionDraftFields,
  sha256Hex,
  stableStringify,
  validateQuestionDraft,
  withholdAnswerKey,
  type QuestionDraftFields,
} from '@planthepath/career-readiness';
import {
  currentReadinessPool,
  questionArchiveBlockers,
  questionOpenRevisionStates,
  questionPublishAltersReadinessInputs,
  type QuestionBankRefusal,
  type QuestionRevisionState,
} from '@planthepath/authorization/src/index.js';
import { archivePublishedRevisions } from './content-archive.js';
import { consumeOperationApproval, type ConsumedApproval } from './operation-approvals.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';
import { agentDraftBodyKeys, type AgentDraftProvenance } from './skill-map.js';

// The content rules, for callers (the API) that do not depend on packages/career-readiness directly.
export {
  HINT_LEVELS,
  QUESTION_ATTRIBUTION_MAX,
  QUESTION_BASIS_MAX,
  QUESTION_DIFFICULTIES,
  QUESTION_DIFFICULTY_MEANINGS,
  QUESTION_EXPLANATION_MAX,
  QUESTION_HINT_MAX,
  QUESTION_LICENCES,
  QUESTION_LICENCES_REQUIRING_ATTRIBUTION,
  QUESTION_OPTION_IDS,
  QUESTION_OPTION_TEXT_MAX,
  QUESTION_OPTIONS_MAX,
  QUESTION_OPTIONS_MIN,
  QUESTION_PROMPT_MAX,
  QUESTION_RATIONALE_MAX,
  QUESTION_STABLE_KEY_PATTERN,
  type QuestionDifficulty,
  type QuestionDraftFields,
  type QuestionLicence,
  type QuestionOptionFields,
} from '@planthepath/career-readiness';

/** A drizzle database or transaction. */
export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

export interface TransactionalRunner extends SqlRunner {
  transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

type Rows<T> = { rows: T[] };
async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

export type QuestionBankErrorCode =
  | 'QUESTION_NOT_FOUND'
  | 'QUESTION_REVISION_NOT_FOUND'
  | 'QUESTION_KEY_EXISTS'
  | 'QUESTION_OPEN_REVISION_EXISTS'
  | 'QUESTION_NOT_LIVE'
  | 'QUESTION_REVISION_NOT_EDITABLE'
  | 'QUESTION_REVISION_NOT_APPROVED'
  | 'QUESTION_RIGHTS_NOT_REVIEWED'
  | 'QUESTION_TOPIC_UNKNOWN'
  | 'QUESTION_TOPIC_NOT_LIVE'
  | 'QUESTION_MISCONCEPTION_UNKNOWN'
  | 'QUESTION_MISCONCEPTION_NOT_PUBLISHED'
  | 'QUESTION_ARCHIVE_BLOCKED'
  | 'QUESTION_INVALID'
  | 'QUESTION_BANK_REJECTED';

export class QuestionBankError extends Error {
  /** For QUESTION_INVALID and the reference errors: the validator's codes, safe to show. */
  constructor(readonly code: QuestionBankErrorCode, readonly problems: readonly string[] = []) {
    super(problems.length ? `${code}: ${problems.join(', ')}` : code);
    this.name = 'QuestionBankError';
  }
}

/** A refusal from a pure rule, carried out of the transaction as is. */
export class QuestionBankRefused extends Error {
  constructor(readonly code: QuestionBankRefusal | 'APPROVAL_REQUIRED') {
    super(code);
    this.name = 'QuestionBankRefused';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code
    ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505';
}

/** Who acted, and whether through the super admin's break-glass (§5.1: audited as such). */
export interface QuestionActor {
  readonly userId: string;
  readonly breakGlass: boolean;
  readonly correlationId: string;
}

async function audit(runner: SqlRunner, input: {
  readonly actor: QuestionActor; readonly action: string; readonly revisionId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actor.userId, action: input.action, resourceType: 'content_revision', resourceId: input.revisionId, correlationId: input.actor.correlationId });
  const context = { ...input.context, ...(input.actor.breakGlass ? { break_glass: true } : {}) };
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actor.userId}::uuid, ${input.action}, 'content_revision', ${input.revisionId}, NULL, 'SUCCESS',
            ${input.actor.correlationId}, ${JSON.stringify(context)}::jsonb)
  `);
}

async function outbox(runner: SqlRunner, input: {
  readonly actor: QuestionActor; readonly revisionId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, aggregateType: 'content_revision', aggregateId: input.revisionId, eventType: input.eventType, payload: input.payload, actorUserId: input.actor.userId, correlationId: input.actor.correlationId, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, 'content_revision', ${input.revisionId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actor.userId}::uuid, ${input.actor.correlationId})
  `);
}

async function stateChanged(tx: SqlRunner, actor: QuestionActor, revisionId: string, questionId: string, from: QuestionRevisionState, to: QuestionRevisionState): Promise<void> {
  await outbox(tx, { actor, revisionId, eventType: 'question_bank.revision_state_changed', payload: { revisionId, questionId, fromState: from, toState: to } });
}

/** The audit actions that make someone a contributor: every draft save, and every submission. */
export const questionDraftSavedAction = 'operations.content.question_draft_saved';
export const questionTransitionedAction = 'operations.content.question_transitioned';

const openStates = sql.join(questionOpenRevisionStates.map((state) => sql`${state}`), sql`, `);
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());
const contentHashOf = (body: Record<string, unknown>): string => sha256Hex(stableStringify(body));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** ARCHIVED: every published revision archived (content-archive-design.md); the question is served nowhere. */
export type QuestionStatus = 'LIVE' | 'PENDING' | 'ARCHIVED';
export type QuestionListFilter = QuestionStatus | 'AWAITING_REVIEW' | 'CHANGES_REQUESTED' | 'AWAITING_PUBLISH';
export type TopicStatus = 'LIVE' | 'PENDING' | 'RETIRED';

export interface QuestionTopic {
  readonly id: string;
  readonly stableKey: string;
  readonly name: string;
  readonly status: TopicStatus;
}

export interface QuestionSummaryRow {
  readonly questionId: string;
  readonly stableKey: string;
  readonly topic: QuestionTopic | null;
  readonly status: QuestionStatus;
  /** The current published version (the one the readiness check can draw). */
  readonly publishedVersion: number | null;
  readonly openRevision: { readonly id: string; readonly revision: number; readonly state: QuestionRevisionState } | null;
  readonly difficulty: string | null;
  readonly promptExcerpt: string;
  readonly optionCount: number;
  readonly taggedOptionCount: number;
  readonly hintsComplete: boolean;
}

interface QuestionDbRow {
  question_id: string; latest_id: string; latest_revision: number; latest_state: QuestionRevisionState; latest_body: unknown;
  sort_key: string; published_version: number | null;
  topic_id: string | null; topic_key: string | null; topic_name: string | null; topic_active: boolean | null; topic_pointer_state: string | null;
}

const questionSelect = sql`
  WITH latest AS (
    SELECT DISTINCT ON (c.entity_id) c.entity_id AS question_id, c.id AS latest_id, c.revision AS latest_revision,
           c.state AS latest_state, c.body AS latest_body, (COALESCE(c.body ->> 'stableKey', '') COLLATE "C") AS sort_key
    FROM content_revisions c WHERE c.entity_type = 'QUESTION'
    ORDER BY c.entity_id, c.revision DESC
  ), q AS (
    SELECT l.*,
      (SELECT max(v.version)::int FROM question_versions v JOIN content_revisions r ON r.id = v.content_revision_id
        WHERE r.entity_type = 'QUESTION' AND r.entity_id = l.question_id AND v.superseded_at IS NULL) AS published_version,
      t.id AS topic_id, t.stable_key AS topic_key, t.name AS topic_name, t.active AS topic_active, tp.state AS topic_pointer_state
    FROM latest l
    LEFT JOIN taxonomy_nodes t ON t.kind = 'TOPIC' AND t.id::text = (l.latest_body ->> 'topicId')
    LEFT JOIN content_revisions tp ON tp.id = t.content_revision_id
  )
  SELECT * FROM q`;

function topicStatus(active: boolean, pointerState: string | null): TopicStatus {
  if (active) return 'LIVE';
  return pointerState && (questionOpenRevisionStates as readonly string[]).includes(pointerState) ? 'PENDING' : 'RETIRED';
}

function topicOf(row: { topic_id: string | null; topic_key: string | null; topic_name: string | null; topic_active: boolean | null; topic_pointer_state: string | null }): QuestionTopic | null {
  if (!row.topic_id) return null;
  return { id: row.topic_id, stableKey: row.topic_key ?? 'NA', name: row.topic_name ?? 'NA', status: topicStatus(Boolean(row.topic_active), row.topic_pointer_state) };
}

function mapSummary(row: QuestionDbRow): QuestionSummaryRow {
  const fields = readQuestionDraftFields(row.latest_body);
  const open = (questionOpenRevisionStates as readonly string[]).includes(row.latest_state);
  const body = (row.latest_body && typeof row.latest_body === 'object' ? row.latest_body : {}) as Record<string, unknown>;
  return {
    questionId: row.question_id,
    stableKey: typeof body.stableKey === 'string' ? body.stableKey : 'NA',
    topic: topicOf(row),
    status: row.published_version !== null ? 'LIVE' : row.latest_state === 'ARCHIVED' ? 'ARCHIVED' : 'PENDING',
    publishedVersion: row.published_version === null ? null : Number(row.published_version),
    openRevision: open ? { id: row.latest_id, revision: Number(row.latest_revision), state: row.latest_state } : null,
    difficulty: fields.difficulty,
    promptExcerpt: fields.prompt.length > 160 ? `${fields.prompt.slice(0, 157)}…` : fields.prompt,
    optionCount: fields.options.length,
    taggedOptionCount: fields.options.filter((option) => option.misconception).length,
    hintsComplete: fields.hints.every((hint) => hint.length > 0),
  };
}

function likePattern(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function filterSql(filter: QuestionListFilter | undefined): SQL {
  switch (filter) {
    case undefined: return sql`TRUE`;
    case 'LIVE': return sql`q.published_version IS NOT NULL`;
    case 'PENDING': return sql`q.published_version IS NULL AND q.latest_state <> 'ARCHIVED'`;
    case 'ARCHIVED': return sql`q.published_version IS NULL AND q.latest_state = 'ARCHIVED'`;
    case 'AWAITING_REVIEW': return sql`q.latest_state = 'IN_REVIEW'`;
    case 'CHANGES_REQUESTED': return sql`q.latest_state = 'CHANGES_REQUESTED'`;
    case 'AWAITING_PUBLISH': return sql`q.latest_state = 'APPROVED'`;
  }
}

/** The bank, searchable by key and prompt, keyset paginated on (stable key, question id). No answer keys. */
export async function listQuestions(runner: SqlRunner, input: {
  readonly q?: string; readonly filter?: QuestionListFilter; readonly limit: number;
  readonly cursor?: { readonly key: string; readonly id: string };
}): Promise<{ readonly questions: readonly QuestionSummaryRow[]; readonly nextCursor: { readonly key: string; readonly id: string } | null }> {
  const q = input.q ? likePattern(input.q) : null;
  const page = await rows<QuestionDbRow>(runner, sql`
    SELECT * FROM (${questionSelect}) q
    WHERE ${filterSql(input.filter)}
      AND (${q}::text IS NULL OR lower(q.latest_body ->> 'stableKey') LIKE ${q} OR lower(q.latest_body ->> 'prompt') LIKE ${q})
      AND (${input.cursor?.key ?? null}::text IS NULL
        OR (q.sort_key, q.question_id) > ((${input.cursor?.key ?? null}::text COLLATE "C"), ${input.cursor?.id ?? null}::uuid))
    ORDER BY q.sort_key, q.question_id
    LIMIT ${input.limit + 1}
  `);
  const shown = page.slice(0, input.limit);
  const last = shown[shown.length - 1];
  return { questions: shown.map(mapSummary), nextCursor: page.length > input.limit && last ? { key: last.sort_key, id: last.question_id } : null };
}

export interface QuestionBankSummary {
  readonly live: number;
  readonly pending: number;
  readonly awaitingReview: number;
  readonly changesRequested: number;
  readonly awaitingPublish: number;
  readonly archived: number;
}

/** Counts for the header, in one bounded query (§5.7). */
export async function summariseQuestionBank(runner: SqlRunner): Promise<QuestionBankSummary> {
  const [row] = await rows<Record<string, number>>(runner, sql`
    SELECT
      count(*) FILTER (WHERE q.published_version IS NOT NULL)::int AS live,
      count(*) FILTER (WHERE q.published_version IS NULL AND q.latest_state <> 'ARCHIVED')::int AS pending,
      count(*) FILTER (WHERE q.latest_state = 'IN_REVIEW')::int AS awaiting_review,
      count(*) FILTER (WHERE q.latest_state = 'CHANGES_REQUESTED')::int AS changes_requested,
      count(*) FILTER (WHERE q.latest_state = 'APPROVED')::int AS awaiting_publish,
      count(*) FILTER (WHERE q.published_version IS NULL AND q.latest_state = 'ARCHIVED')::int AS archived
    FROM (${questionSelect}) q
  `);
  const value = (key: string): number => Number(row?.[key] ?? 0);
  return {
    live: value('live'), pending: value('pending'), awaitingReview: value('awaiting_review'), changesRequested: value('changes_requested'),
    awaitingPublish: value('awaiting_publish'), archived: value('archived'),
  };
}

export interface QuestionTagView {
  readonly optionId: string;
  readonly code: string;
  readonly codeVersion: number;
  readonly codeTitle: string;
  readonly codeState: string;
  readonly tagState: string;
}

export interface QuestionRevisionView {
  readonly id: string;
  readonly revision: number;
  readonly state: QuestionRevisionState;
  readonly contentHash: string;
  readonly author: { readonly userId: string; readonly email: string };
  readonly contributors: readonly { readonly userId: string; readonly email: string }[];
  readonly createdAt: string;
  readonly publishedAt: string | null;
  /** With the answer key withheld (correct option, explanation, tags) unless the viewer may see it. */
  readonly fields: QuestionDraftFields;
  readonly answerKeyWithheld: boolean;
  readonly topic: QuestionTopic | null;
  /** The tag rows written at submission, with their states; empty when the key is withheld. */
  readonly tags: readonly QuestionTagView[];
  readonly ladder: { readonly source: string; readonly state: string; readonly generatorVersion: string | null; readonly promptVersion: string | null; readonly generatedAt: string | null } | null;
  /** Set when an import pack drafted this revision (program B.8); null when a person wrote it. */
  readonly agentDraft: { readonly generatorVersion: string; readonly promptVersion: string; readonly generatedAt: string } | null;
  /** The note for the subject expert an agent draft carries. */
  readonly expertCheck: string | null;
  readonly rightsReview: { readonly licenceLabel: string; readonly reviewerEmail: string; readonly reasonCode: string; readonly reviewedAt: string } | null;
}

export interface QuestionDetail extends QuestionSummaryRow {
  /** The revision behind the current published version; null for a question never published. */
  readonly current: QuestionRevisionView | null;
  /** The revision on its way, if any. */
  readonly open: QuestionRevisionView | null;
  readonly versions: readonly { readonly version: number; readonly publishedAt: string; readonly superseded: boolean }[];
  /** Misconception codes of the open revision's topic, for the editor's picker (only with the key). */
  readonly misconceptionChoices: readonly { readonly id: string; readonly code: string; readonly version: number; readonly title: string; readonly state: string }[];
  /** Always true today (§5.4, questionPublishAltersReadinessInputs). */
  readonly publishNeedsApproval: boolean;
  readonly history: readonly {
    readonly revision: number; readonly action: string; readonly fromState: string; readonly toState: string;
    readonly reasonCode: string; readonly actorEmail: string; readonly occurredAt: string;
  }[];
}

async function contributorsOf(runner: SqlRunner, revisionId: string, authorUserId: string): Promise<readonly string[]> {
  const found = await rows<{ actor_user_id: string }>(runner, sql`
    SELECT DISTINCT actor_user_id FROM audit_events
    WHERE resource_type = 'content_revision' AND resource_id = ${revisionId} AND actor_user_id IS NOT NULL
      AND (action = ${questionDraftSavedAction} OR (action = ${questionTransitionedAction} AND context ->> 'toState' = 'IN_REVIEW'))
  `);
  return [...new Set([authorUserId, ...found.map((row) => row.actor_user_id)])];
}

async function topicById(runner: SqlRunner, topicId: string | null): Promise<QuestionTopic | null> {
  if (!topicId) return null;
  const [row] = await rows<{ topic_id: string; topic_key: string; topic_name: string; topic_active: boolean; topic_pointer_state: string }>(runner, sql`
    SELECT n.id AS topic_id, n.stable_key AS topic_key, n.name AS topic_name, n.active AS topic_active, p.state AS topic_pointer_state
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id WHERE n.kind = 'TOPIC' AND n.id = ${topicId}::uuid
  `);
  return row ? topicOf(row) : null;
}

async function revisionView(runner: SqlRunner, revisionId: string, answerKeys: boolean): Promise<QuestionRevisionView> {
  const [row] = await rows<{
    id: string; revision: number; state: QuestionRevisionState; content_hash: string; author_user_id: string; author_email: string;
    created_at: Date; published_at: Date | null; body: unknown;
  }>(runner, sql`
    SELECT c.id, c.revision, c.state, c.content_hash, c.author_user_id, u.email AS author_email, c.created_at, c.published_at, c.body
    FROM content_revisions c JOIN users u ON u.id = c.author_user_id WHERE c.id = ${revisionId}::uuid AND c.entity_type = 'QUESTION'
  `);
  if (!row) throw new QuestionBankError('QUESTION_REVISION_NOT_FOUND');
  const contributorIds = await contributorsOf(runner, row.id, row.author_user_id);
  const emails = await rows<{ id: string; email: string }>(runner, sql`
    SELECT id, email FROM users WHERE id IN (${sql.join(contributorIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const [rights] = await rows<{ license_label: string; reviewer_email: string; reason_code: string; reviewed_at: Date }>(runner, sql`
    SELECT r.license_label, u.email AS reviewer_email, r.reason_code, r.reviewed_at
    FROM source_records s JOIN rights_reviews r ON r.source_record_id = s.id JOIN users u ON u.id = r.reviewer_user_id
    WHERE s.source_entity_type = 'QUESTION_BANK_REVISION' AND s.source_record_id = ${row.id}
    ORDER BY r.reviewed_at DESC LIMIT 1
  `);
  const tags = answerKeys ? await rows<{ option_id: string; code: string; version: number; title: string; code_state: string; tag_state: string }>(runner, sql`
    SELECT t.option_id, c.code, c.version, c.title, c.review_state AS code_state, t.review_state AS tag_state
    FROM question_option_misconceptions t JOIN misconception_codes c ON c.id = t.misconception_code_id
    WHERE t.question_revision_id = ${row.id}::uuid ORDER BY t.option_id, c.code
  `) : [];
  const [ladder] = await rows<{ source: string; review_state: string; generator_version: string | null; prompt_version: string | null; generated_at: Date | null }>(runner, sql`
    SELECT source, review_state, generator_version, prompt_version, generated_at FROM question_hint_ladders WHERE question_revision_id = ${row.id}::uuid
  `);
  const fields = readQuestionDraftFields(row.body);
  const drafted = readAgentDraftProvenance(row.body);
  return {
    id: row.id, revision: Number(row.revision), state: row.state, contentHash: row.content_hash,
    author: { userId: row.author_user_id, email: row.author_email },
    contributors: contributorIds.map((id) => ({ userId: id, email: emails.find((entry) => entry.id === id)?.email ?? 'NA' })),
    createdAt: iso(row.created_at)!, publishedAt: iso(row.published_at),
    fields: answerKeys ? fields : withholdAnswerKey(fields),
    answerKeyWithheld: !answerKeys,
    topic: await topicById(runner, fields.topicId),
    tags: tags.map((tag) => ({ optionId: tag.option_id, code: tag.code, codeVersion: Number(tag.version), codeTitle: tag.title, codeState: tag.code_state, tagState: tag.tag_state })),
    ladder: ladder ? { source: ladder.source, state: ladder.review_state, generatorVersion: ladder.generator_version, promptVersion: ladder.prompt_version, generatedAt: iso(ladder.generated_at) } : null,
    agentDraft: drafted ? { generatorVersion: drafted.generatorVersion, promptVersion: drafted.promptVersion, generatedAt: drafted.generatedAt } : null,
    expertCheck: drafted ? drafted.expertCheck : null,
    rightsReview: rights ? { licenceLabel: rights.license_label, reviewerEmail: rights.reviewer_email, reasonCode: rights.reason_code, reviewedAt: iso(rights.reviewed_at)! } : null,
  };
}

/** One question for the editor. `answerKeys` is the caller's CONTENT_EDIT / CONTENT_REVIEW check. */
export async function loadQuestion(runner: SqlRunner, questionId: string, options: { readonly answerKeys: boolean }): Promise<QuestionDetail | null> {
  const [row] = await rows<QuestionDbRow>(runner, sql`SELECT * FROM (${questionSelect}) q WHERE q.question_id = ${questionId}::uuid`);
  if (!row) return null;
  const summary = mapSummary(row);
  const [currentRevision] = await rows<{ content_revision_id: string }>(runner, sql`
    SELECT v.content_revision_id FROM question_versions v JOIN content_revisions r ON r.id = v.content_revision_id
    WHERE r.entity_type = 'QUESTION' AND r.entity_id = ${questionId}::uuid AND v.superseded_at IS NULL
    ORDER BY v.version DESC LIMIT 1
  `);
  const current = currentRevision ? await revisionView(runner, currentRevision.content_revision_id, options.answerKeys) : null;
  const open = summary.openRevision ? await revisionView(runner, summary.openRevision.id, options.answerKeys) : null;
  const versions = await rows<{ version: number; published_at: Date; superseded_at: Date | null }>(runner, sql`
    SELECT v.version, v.published_at, v.superseded_at FROM question_versions v JOIN content_revisions r ON r.id = v.content_revision_id
    WHERE r.entity_type = 'QUESTION' AND r.entity_id = ${questionId}::uuid ORDER BY v.version DESC LIMIT 50
  `);
  const choiceTopic = open?.fields.topicId ?? null;
  const choices = options.answerKeys && choiceTopic ? await rows<{ id: string; code: string; version: number; title: string; review_state: string }>(runner, sql`
    SELECT id, code, version, title, review_state FROM misconception_codes
    WHERE skill_id = ${choiceTopic}::uuid AND review_state <> 'ARCHIVED' ORDER BY code, version DESC LIMIT 200
  `) : [];
  const history = await rows<{ revision: number; action: string; from_state: string; to_state: string; reason_code: string; email: string; occurred_at: Date }>(runner, sql`
    SELECT c.revision, a.action, a.from_state, a.to_state, a.reason_code, u.email, a.occurred_at
    FROM content_review_actions a JOIN content_revisions c ON c.id = a.content_revision_id JOIN users u ON u.id = a.actor_user_id
    WHERE c.entity_type = 'QUESTION' AND c.entity_id = ${questionId}::uuid
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT 50
  `);
  return {
    ...summary,
    current,
    open,
    versions: versions.map((entry) => ({ version: Number(entry.version), publishedAt: iso(entry.published_at)!, superseded: entry.superseded_at !== null })),
    misconceptionChoices: choices.map((entry) => ({ id: entry.id, code: entry.code, version: Number(entry.version), title: entry.title, state: entry.review_state })),
    publishNeedsApproval: questionPublishAltersReadinessInputs({ readinessPool: currentReadinessPool }),
    history: history.map((entry) => ({
      revision: Number(entry.revision), action: entry.action, fromState: entry.from_state, toState: entry.to_state,
      reasonCode: entry.reason_code, actorEmail: entry.email, occurredAt: iso(entry.occurred_at)!,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function rethrow(error: unknown): never {
  if (error instanceof QuestionBankError || error instanceof QuestionBankRefused) throw error;
  // Approval refusals keep their own type for the HTTP gate.
  if (error instanceof Error && error.name === 'OperationApprovalError') throw error;
  if (isUniqueViolation(error)) throw new QuestionBankError('QUESTION_KEY_EXISTS');
  throw new QuestionBankError('QUESTION_BANK_REJECTED');
}

/** A topic by key: live or pending may be tagged; a retired one may not. */
async function topicByKey(tx: SqlRunner, topicKey: string): Promise<QuestionTopic> {
  const [row] = await rows<{ topic_id: string; topic_key: string; topic_name: string; topic_active: boolean; topic_pointer_state: string }>(tx, sql`
    SELECT n.id AS topic_id, n.stable_key AS topic_key, n.name AS topic_name, n.active AS topic_active, p.state AS topic_pointer_state
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id
    WHERE n.kind = 'TOPIC' AND n.stable_key = ${topicKey} ORDER BY n.version DESC LIMIT 1
  `);
  const topic = row ? topicOf(row) : null;
  if (!topic || topic.status === 'RETIRED') throw new QuestionBankError('QUESTION_TOPIC_UNKNOWN', [`QUESTION_TOPIC_UNKNOWN:${topicKey}`]);
  return topic;
}

/** Every chosen code exists, is not archived, and belongs to the question's topic. */
async function misconceptionProblems(tx: SqlRunner, fields: QuestionDraftFields): Promise<readonly string[]> {
  const chosen = fields.options.filter((option) => option.misconception);
  if (!chosen.length) return [];
  const ids = [...new Set(chosen.map((option) => option.misconception!.codeId))];
  const found = await rows<{ id: string; skill_id: string; review_state: string }>(tx, sql`
    SELECT id, skill_id, review_state FROM misconception_codes WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const problems: string[] = [];
  for (const option of chosen) {
    const code = found.find((entry) => entry.id === option.misconception!.codeId);
    if (!code || code.review_state === 'ARCHIVED' || code.skill_id !== fields.topicId) problems.push(`QUESTION_MISCONCEPTION_UNKNOWN:${option.id}`);
  }
  return problems;
}

async function lockQuestion(tx: SqlRunner, questionId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'question-bank:' + questionId}))`);
}

async function keyInUse(tx: SqlRunner, stableKey: string): Promise<boolean> {
  const [row] = await rows<{ used: boolean }>(tx, sql`
    SELECT EXISTS (SELECT 1 FROM content_revisions WHERE entity_type = 'QUESTION' AND body ->> 'stableKey' = ${stableKey})
        OR EXISTS (SELECT 1 FROM question_versions WHERE stable_key = ${stableKey}) AS used
  `);
  return Boolean(row?.used);
}

/**
 * Create a question: revision 1 in DRAFT, tagged to a live or pending topic. `agentDraft` is given
 * only by an import pack (ENG-10): the body then carries its provenance and expert-check note.
 */
export async function createQuestion(db: TransactionalRunner, input: {
  readonly stableKey: string; readonly topicKey: string; readonly prompt: string; readonly reasonCode: string; readonly actor: QuestionActor;
  readonly agentDraft?: AgentDraftProvenance;
}): Promise<{ readonly questionId: string; readonly revisionId: string }> {
  const questionId = randomUUID();
  const revisionId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'question-key:' + input.stableKey}))`);
      if (await keyInUse(tx, input.stableKey)) throw new QuestionBankError('QUESTION_KEY_EXISTS');
      const topic = await topicByKey(tx, input.topicKey);
      const fields: QuestionDraftFields = {
        topicId: topic.id, prompt: input.prompt, options: [], correctOptionId: null, explanation: null, difficulty: null,
        hints: ['', '', '', ''], licenceLabel: null, attribution: null, basis: null,
      };
      const problems = validateQuestionDraft(input.stableKey, fields, false);
      if (problems.length) throw new QuestionBankError('QUESTION_INVALID', problems);
      const body = composeQuestionBody(input.agentDraft ? agentDraftBodyKeys(input.agentDraft) : {}, input.stableKey, fields);
      await tx.execute(sql`
        INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
        VALUES (${revisionId}::uuid, 'QUESTION', ${questionId}::uuid, 1, ${input.actor.userId}::uuid, 'DRAFT', ${contentHashOf(body)}, ${JSON.stringify(body)}::jsonb)
      `);
      await audit(tx, {
        actor: input.actor, action: 'operations.content.question_created', revisionId,
        context: {
          questionId, stableKey: input.stableKey, topicId: topic.id, revision: 1, reasonCode: input.reasonCode,
          ...(input.agentDraft ? { source: 'AGENT_DRAFTED', packKey: input.agentDraft.packKey } : {}),
        },
      });
    });
  } catch (error) {
    rethrow(error);
  }
  return { questionId, revisionId };
}

async function openRevisionOf(tx: SqlRunner, questionId: string): Promise<string | null> {
  const [open] = await rows<{ id: string }>(tx, sql`
    SELECT id FROM content_revisions WHERE entity_type = 'QUESTION' AND entity_id = ${questionId}::uuid AND state IN (${openStates}) LIMIT 1
  `);
  return open?.id ?? null;
}

/** Start revision n+1 of a live question from its current published body. One open revision per question. */
export async function startQuestionRevision(db: TransactionalRunner, input: {
  readonly questionId: string; readonly reasonCode: string; readonly actor: QuestionActor;
}): Promise<{ readonly revisionId: string; readonly revision: number }> {
  try {
    return await db.transaction(async (tx) => {
      await lockQuestion(tx, input.questionId);
      const [exists] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM content_revisions WHERE entity_type = 'QUESTION' AND entity_id = ${input.questionId}::uuid`);
      if (!Number(exists?.n)) throw new QuestionBankError('QUESTION_NOT_FOUND');
      if (await openRevisionOf(tx, input.questionId)) throw new QuestionBankError('QUESTION_OPEN_REVISION_EXISTS');
      const [published] = await rows<{ body: unknown; stable_key: string }>(tx, sql`
        SELECT r.body, v.stable_key FROM question_versions v JOIN content_revisions r ON r.id = v.content_revision_id
        WHERE r.entity_type = 'QUESTION' AND r.entity_id = ${input.questionId}::uuid AND v.superseded_at IS NULL
        ORDER BY v.version DESC LIMIT 1
      `);
      if (!published) throw new QuestionBankError('QUESTION_NOT_LIVE');
      const [next] = await rows<{ revision: number }>(tx, sql`
        SELECT COALESCE(max(revision), 0)::int + 1 AS revision FROM content_revisions WHERE entity_type = 'QUESTION' AND entity_id = ${input.questionId}::uuid
      `);
      const revision = Number(next!.revision);
      const body = composeQuestionBody(published.body, published.stable_key, readQuestionDraftFields(published.body));
      const revisionId = randomUUID();
      await tx.execute(sql`
        INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
        VALUES (${revisionId}::uuid, 'QUESTION', ${input.questionId}::uuid, ${revision}, ${input.actor.userId}::uuid, 'DRAFT', ${contentHashOf(body)}, ${JSON.stringify(body)}::jsonb)
      `);
      await audit(tx, {
        actor: input.actor, action: 'operations.content.question_revision_started', revisionId,
        context: { questionId: input.questionId, stableKey: published.stable_key, revision, reasonCode: input.reasonCode },
      });
      return { revisionId, revision };
    });
  } catch (error) {
    rethrow(error);
  }
}

interface LockedRevision { id: string; entity_id: string; revision: number; author_user_id: string; state: QuestionRevisionState; body: unknown; content_hash: string }

async function lockRevision(tx: SqlRunner, revisionId: string): Promise<LockedRevision & { stableKey: string }> {
  const [found] = await rows<{ entity_id: string }>(tx, sql`SELECT entity_id FROM content_revisions WHERE id = ${revisionId}::uuid AND entity_type = 'QUESTION'`);
  if (!found) throw new QuestionBankError('QUESTION_REVISION_NOT_FOUND');
  // Question first, then revision: every writer of a question takes the locks in this order.
  await lockQuestion(tx, found.entity_id);
  const [revision] = await rows<LockedRevision>(tx, sql`
    SELECT id, entity_id, revision, author_user_id, state, body, content_hash FROM content_revisions WHERE id = ${revisionId}::uuid FOR UPDATE
  `);
  const body = (revision!.body && typeof revision!.body === 'object' ? revision!.body : {}) as Record<string, unknown>;
  return { ...revision!, stableKey: typeof body.stableKey === 'string' ? body.stableKey : '' };
}

/** What the editor sends: the fields, with the skill tag as a topic key. */
export type QuestionDraftInput = Omit<QuestionDraftFields, 'topicId'> & { readonly topicKey: string };

/**
 * Replace an editable revision's fields. Anyone with CONTENT_EDIT may edit; whoever saves becomes
 * a contributor (their audit row is the record) and so never reviews or publishes it.
 */
export async function saveQuestionDraft(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly draft: QuestionDraftInput; readonly actor: QuestionActor;
}): Promise<{ readonly questionId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      if (revision.state !== 'DRAFT' && revision.state !== 'CHANGES_REQUESTED') throw new QuestionBankError('QUESTION_REVISION_NOT_EDITABLE');
      const topic = await topicByKey(tx, input.draft.topicKey);
      const { topicKey: _key, ...rest } = input.draft;
      const fields: QuestionDraftFields = { ...rest, topicId: topic.id };
      const problems = [...validateQuestionDraft(revision.stableKey, fields, false), ...await misconceptionProblems(tx, fields)];
      if (problems.length) throw new QuestionBankError('QUESTION_INVALID', problems);
      const body = composeQuestionBody(revision.body, revision.stableKey, fields);
      await tx.execute(sql`
        UPDATE content_revisions SET body = ${JSON.stringify(body)}::jsonb, content_hash = ${contentHashOf(body)} WHERE id = ${input.revisionId}::uuid
      `);
      await audit(tx, {
        actor: input.actor, action: questionDraftSavedAction, revisionId: input.revisionId,
        context: {
          questionId: revision.entity_id, stableKey: revision.stableKey, revision: Number(revision.revision), topicId: topic.id,
          optionCount: fields.options.length, taggedOptionCount: questionMisconceptionTags(fields).length, reasonCode: 'DRAFT_EDIT',
        },
      });
      return { questionId: revision.entity_id };
    });
  } catch (error) {
    rethrow(error);
  }
}

const reviewActionFor: Readonly<Record<string, 'SUBMIT' | 'REQUEST_CHANGES' | 'APPROVE'>> = {
  IN_REVIEW: 'SUBMIT', CHANGES_REQUESTED: 'REQUEST_CHANGES', APPROVED: 'APPROVE',
};

async function moveRevision(tx: SqlRunner, input: { readonly revisionId: string; readonly from: string; readonly to: string; readonly action: string; readonly reasonCode: string; readonly actor: QuestionActor }): Promise<void> {
  await tx.execute(sql`
    INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
    VALUES (${randomUUID()}::uuid, ${input.revisionId}::uuid, ${input.actor.userId}::uuid, ${input.action}, ${input.from}, ${input.to}, ${input.reasonCode}, ${input.actor.correlationId})
  `);
  await tx.execute(sql`UPDATE content_revisions SET state = ${input.to} WHERE id = ${input.revisionId}::uuid`);
}

/**
 * Submission writes what the reviewer approves: the hint ladder (0061) and the option tags
 * (ENG-07), both from the body. A tag already written for the same option and code (an earlier
 * submission sent back) is reused with its rationale updated; a tag the author has since dropped
 * stays where it is and is never published.
 */
async function materialiseForReview(tx: SqlRunner, revision: LockedRevision & { stableKey: string }, fields: QuestionDraftFields, actor: QuestionActor, reasonCode: string): Promise<void> {
  const [ladder] = await rows<{ id: string }>(tx, sql`SELECT id FROM question_hint_ladders WHERE question_revision_id = ${revision.id}::uuid`);
  const [h1, h2, h3, h4] = fields.hints;
  // An agent-drafted item (ENG-10) gives agent-drafted ladder and tag rows: a person submitting
  // or editing it checks it, and the review record says so, but it does not become AUTHORED.
  const drafted = readAgentDraftProvenance(revision.body);
  const agent = drafted
    ? {
      source: 'AGENT_DRAFTED', generatorVersion: drafted.generatorVersion as string | null, promptVersion: drafted.promptVersion as string | null,
      generatedAt: drafted.generatedAt as string | null,
      expertCheckNotes: (drafted.expertCheck ?? 'Drafted by the coding agent: check every claim against its basis.') as string | null,
    }
    : { source: 'AUTHORED', generatorVersion: null, promptVersion: null, generatedAt: null, expertCheckNotes: null };
  if (ladder) {
    await tx.execute(sql`
      UPDATE question_hint_ladders SET hint_1 = ${h1}, hint_2 = ${h2}, hint_3 = ${h3}, hint_4 = ${h4}, updated_at = now() WHERE id = ${ladder.id}::uuid
    `);
  } else {
    await tx.execute(sql`
      INSERT INTO question_hint_ladders (id, question_revision_id, hint_1, hint_2, hint_3, hint_4, source, generator_version, prompt_version,
                                         generated_at, expert_check_notes, created_by_user_id)
      VALUES (${randomUUID()}::uuid, ${revision.id}::uuid, ${h1}, ${h2}, ${h3}, ${h4}, ${agent.source}, ${agent.generatorVersion}, ${agent.promptVersion},
              ${agent.generatedAt}::timestamptz, ${agent.expertCheckNotes}, ${actor.userId}::uuid)
    `);
  }
  const basis = `Question bank editor: ${revision.stableKey} revision ${Number(revision.revision)}`;
  for (const tag of questionMisconceptionTags(fields)) {
    const [existing] = await rows<{ id: string; content_revision_id: string; rationale: string; state: string; body: unknown }>(tx, sql`
      SELECT t.id, t.content_revision_id, t.rationale, r.state, r.body
      FROM question_option_misconceptions t JOIN content_revisions r ON r.id = t.content_revision_id
      WHERE t.question_revision_id = ${revision.id}::uuid AND t.option_id = ${tag.optionId} AND t.misconception_code_id = ${tag.codeId}::uuid
    `);
    let tagRevisionId: string;
    let from: string;
    if (existing) {
      if (existing.state !== 'DRAFT' && existing.state !== 'CHANGES_REQUESTED') throw new QuestionBankError('QUESTION_BANK_REJECTED');
      tagRevisionId = existing.content_revision_id;
      from = existing.state;
      if (existing.rationale !== tag.rationale) {
        const tagBody = { ...(existing.body as Record<string, unknown>), rationale: tag.rationale };
        await tx.execute(sql`UPDATE content_revisions SET body = ${JSON.stringify(tagBody)}::jsonb, content_hash = ${contentHashOf(tagBody)} WHERE id = ${tagRevisionId}::uuid`);
        await tx.execute(sql`UPDATE question_option_misconceptions SET rationale = ${tag.rationale} WHERE id = ${existing.id}::uuid`);
      }
    } else {
      const tagId = randomUUID();
      tagRevisionId = randomUUID();
      from = 'DRAFT';
      const tagBody = {
        questionRevisionId: revision.id, optionId: tag.optionId, misconceptionCodeId: tag.codeId, rationale: tag.rationale,
        basis, expertCheckNotes: agent.expertCheckNotes, source: agent.source, generatorVersion: agent.generatorVersion,
        promptVersion: agent.promptVersion, generatedAt: agent.generatedAt,
      };
      await tx.execute(sql`
        INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
        VALUES (${tagRevisionId}::uuid, 'QUESTION_OPTION_MISCONCEPTION', ${tagId}::uuid, 1, ${actor.userId}::uuid, 'DRAFT', ${contentHashOf(tagBody)}, ${JSON.stringify(tagBody)}::jsonb)
      `);
      await tx.execute(sql`
        INSERT INTO question_option_misconceptions (id, question_revision_id, option_id, misconception_code_id, rationale, basis, expert_check_notes,
                                                    source, generator_version, prompt_version, generated_at, content_revision_id, created_by_user_id)
        VALUES (${tagId}::uuid, ${revision.id}::uuid, ${tag.optionId}, ${tag.codeId}::uuid, ${tag.rationale}, ${basis}, ${agent.expertCheckNotes},
                ${agent.source}, ${agent.generatorVersion}, ${agent.promptVersion}, ${agent.generatedAt}::timestamptz, ${tagRevisionId}::uuid, ${actor.userId}::uuid)
      `);
    }
    await moveRevision(tx, { revisionId: tagRevisionId, from, to: 'IN_REVIEW', action: 'SUBMIT', reasonCode, actor });
  }
}

/** The tags submitted with this revision move with it when the reviewer decides. */
async function moveSubmittedTags(tx: SqlRunner, questionRevisionId: string, to: 'CHANGES_REQUESTED' | 'APPROVED', reasonCode: string, actor: QuestionActor): Promise<void> {
  const tags = await rows<{ content_revision_id: string }>(tx, sql`
    SELECT t.content_revision_id FROM question_option_misconceptions t JOIN content_revisions r ON r.id = t.content_revision_id
    WHERE t.question_revision_id = ${questionRevisionId}::uuid AND r.state = 'IN_REVIEW' ORDER BY t.id FOR UPDATE OF r
  `);
  for (const tag of tags) {
    await moveRevision(tx, { revisionId: tag.content_revision_id, from: 'IN_REVIEW', to, action: reviewActionFor[to]!, reasonCode, actor });
  }
}

/**
 * Move a revision: submit (and resubmit), request changes, or approve. `refuse` is the pure rule,
 * evaluated against the locked row and its contributors. Approving is also the rights review.
 */
export async function transitionQuestionRevision(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'; readonly reasonCode: string;
  readonly rightsReasonCode: string | null; readonly note: string | null; readonly actor: QuestionActor;
  readonly refuse: (current: { readonly from: QuestionRevisionState; readonly contributorUserIds: readonly string[] }) => QuestionBankRefusal | null;
}): Promise<{ readonly questionId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      const contributors = await contributorsOf(tx, revision.id, revision.author_user_id);
      const refusal = input.refuse({ from: revision.state, contributorUserIds: contributors });
      if (refusal) throw new QuestionBankRefused(refusal);
      const fields = readQuestionDraftFields(revision.body);
      if (input.toState === 'IN_REVIEW') {
        const problems = [...validateQuestionDraft(revision.stableKey, fields, true), ...await misconceptionProblems(tx, fields)];
        const topic = await topicById(tx, fields.topicId);
        if (fields.topicId && (!topic || topic.status === 'RETIRED')) problems.push('QUESTION_TOPIC_UNKNOWN');
        if (problems.length) throw new QuestionBankError('QUESTION_INVALID', problems);
        await materialiseForReview(tx, revision, fields, input.actor, input.reasonCode);
      } else {
        await moveSubmittedTags(tx, revision.id, input.toState, input.reasonCode, input.actor);
      }
      await moveRevision(tx, { revisionId: revision.id, from: revision.state, to: input.toState, action: reviewActionFor[input.toState]!, reasonCode: input.reasonCode, actor: input.actor });
      if (input.toState === 'APPROVED') {
        await recordRightsReview(tx, { revision, fields, reviewReasonCode: input.reasonCode, rightsReasonCode: input.rightsReasonCode!, actor: input.actor });
      }
      await audit(tx, {
        actor: input.actor, action: questionTransitionedAction, revisionId: revision.id,
        context: {
          questionId: revision.entity_id, stableKey: revision.stableKey, revision: Number(revision.revision), fromState: revision.state, toState: input.toState,
          reasonCode: input.reasonCode, ...(input.rightsReasonCode ? { rightsReasonCode: input.rightsReasonCode } : {}), ...(input.note ? { note: input.note } : {}),
        },
      });
      await stateChanged(tx, input.actor, revision.id, revision.entity_id, revision.state, input.toState);
      return { questionId: revision.entity_id };
    });
  } catch (error) {
    rethrow(error);
  }
}

/**
 * The reviewer's rights review, in the approval's transaction (OPS-09a Decision 5): one source
 * package per reviewed revision and a release-eligible source record in its final state, with the
 * rights review, the SME review and the provenance link that point at it.
 */
async function recordRightsReview(tx: SqlRunner, input: {
  readonly revision: LockedRevision & { stableKey: string }; readonly fields: QuestionDraftFields;
  readonly reviewReasonCode: string; readonly rightsReasonCode: string; readonly actor: QuestionActor;
}): Promise<void> {
  const licence = input.fields.licenceLabel;
  if (!licence) throw new QuestionBankError('QUESTION_INVALID', ['QUESTION_LICENCE_MISSING']);
  const attributionRequired = QUESTION_LICENCES_REQUIRING_ATTRIBUTION.includes(licence);
  const identity = `ops-question-bank:${input.revision.id}`;
  // Console-authored content has no repository commit; the SHA-1 of the reviewed body is its content address.
  const contentAddress = createHash('sha1').update(stableStringify(input.revision.body), 'utf8').digest('hex');
  const path = `console://question-bank/${input.revision.stableKey}/r${Number(input.revision.revision)}`;
  const runId = randomUUID();
  const packageId = randomUUID();
  const sourceRecordId = randomUUID();
  await tx.execute(sql`
    INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, record_counts, completed_at)
    VALUES (${runId}::uuid, ${identity}, 'one-operations-console', ${contentAddress}, ${input.revision.content_hash}, 'question-bank-editor-v1', 'STAGED',
            ${input.actor.userId}::uuid, ${JSON.stringify({ questions: 1 })}::jsonb, now())
  `);
  await tx.execute(sql`
    INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES (${packageId}::uuid, ${runId}::uuid, ${identity}, 'one-operations-console', ${contentAddress}, ${input.revision.content_hash}, 'question-bank-editor-v1',
            ${JSON.stringify([path])}::jsonb, ${JSON.stringify({ [path]: input.revision.content_hash })}::jsonb,
            ${JSON.stringify({ kind: 'QUESTION_BANK_REVISION', stableKey: input.revision.stableKey, revision: Number(input.revision.revision) })}::jsonb)
  `);
  await tx.execute(sql`
    INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, source_metadata, license_label,
      attribution_required, rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, rejection_reason_codes, release_eligible)
    VALUES (${sourceRecordId}::uuid, ${packageId}::uuid, 'QUESTION_BANK_REVISION', ${input.revision.id}, ${path}, ${input.revision.content_hash},
            ${JSON.stringify({ attribution: input.fields.attribution })}::jsonb, ${licence}, ${attributionRequired},
            'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', '{}'::text[], true)
  `);
  await tx.execute(sql`
    INSERT INTO rights_reviews (id, source_record_id, reviewer_user_id, state, license_label, attribution_requirement, reason_code)
    VALUES (${randomUUID()}::uuid, ${sourceRecordId}::uuid, ${input.actor.userId}::uuid, 'APPROVED', ${licence}, ${input.fields.attribution}, ${input.rightsReasonCode})
  `);
  await tx.execute(sql`
    INSERT INTO quality_reviews (id, source_record_id, reviewer_user_id, review_kind, state, reason_code)
    VALUES (${randomUUID()}::uuid, ${sourceRecordId}::uuid, ${input.actor.userId}::uuid, 'SME', 'APPROVED', ${input.reviewReasonCode})
  `);
  await tx.execute(sql`
    INSERT INTO content_provenance (id, source_record_id, canonical_entity_type, canonical_entity_id, canonical_version, provenance_hash, transform_version)
    VALUES (${randomUUID()}::uuid, ${sourceRecordId}::uuid, 'QUESTION', ${input.revision.entity_id}::uuid, ${Number(input.revision.revision)},
            ${input.revision.content_hash}, 'question-bank-editor-v1')
  `);
  await audit(tx, {
    actor: input.actor, action: 'operations.content.question_rights_reviewed', revisionId: input.revision.id,
    context: { questionId: input.revision.entity_id, stableKey: input.revision.stableKey, licenceLabel: licence, attributionRequired, reasonCode: input.rightsReasonCode },
  });
}

/** What the approvals endpoint needs to file, and the publish endpoint to execute, a publish approval. */
export async function loadQuestionRevisionForPublish(runner: SqlRunner, revisionId: string): Promise<{
  readonly id: string; readonly questionId: string; readonly state: QuestionRevisionState; readonly contentHash: string;
  readonly contributorUserIds: readonly string[]; readonly needsApproval: boolean;
} | null> {
  const [row] = await rows<{ id: string; entity_id: string; state: QuestionRevisionState; content_hash: string; author_user_id: string }>(runner, sql`
    SELECT id, entity_id, state, content_hash, author_user_id FROM content_revisions WHERE id = ${revisionId}::uuid AND entity_type = 'QUESTION'
  `);
  if (!row) return null;
  return {
    id: row.id, questionId: row.entity_id, state: row.state, contentHash: row.content_hash,
    contributorUserIds: await contributorsOf(runner, row.id, row.author_user_id),
    needsApproval: questionPublishAltersReadinessInputs({ readinessPool: currentReadinessPool }),
  };
}

/**
 * Publish an approved revision, in one transaction: check who publishes, that the topic is live
 * and every tagged code published, and consume the approval; then a release manifest (the
 * question and its approved tags, against the reviewed source record) approved by the revision's
 * reviewer and published by the actor; the revision PUBLISHED; earlier versions superseded; the
 * learner-facing `question_versions` row and the grading-only answer key written; the tags
 * published. If anything fails, all of it rolls back and the approval stays usable.
 */
export async function publishQuestionRevision(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly reasonCode: string; readonly approvalId: string | null;
  /** The approval payload the endpoint rebuilds from this request and the stored content hash. */
  readonly approvalPayload: (contentHash: string) => Record<string, unknown>;
  readonly actor: QuestionActor;
  readonly refuse: (current: { readonly contributorUserIds: readonly string[] }) => QuestionBankRefusal | null;
}): Promise<{ readonly questionId: string; readonly questionVersionId: string; readonly releaseManifestId: string; readonly approval: ConsumedApproval | null }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      const contributors = await contributorsOf(tx, revision.id, revision.author_user_id);
      const refusal = input.refuse({ contributorUserIds: contributors });
      if (refusal) throw new QuestionBankRefused(refusal);
      if (revision.state !== 'APPROVED') throw new QuestionBankError('QUESTION_REVISION_NOT_APPROVED');
      const fields = readQuestionDraftFields(revision.body);

      // Checked before any approval is consumed, so a refused publish leaves it usable.
      const topic = await topicById(tx, fields.topicId);
      if (!topic || topic.status !== 'LIVE') throw new QuestionBankError('QUESTION_TOPIC_NOT_LIVE');
      const tags = await rows<{ content_revision_id: string; content_hash: string; option_id: string; code_state: string }>(tx, sql`
        SELECT t.content_revision_id, r.content_hash, t.option_id, c.review_state AS code_state
        FROM question_option_misconceptions t
        JOIN content_revisions r ON r.id = t.content_revision_id
        JOIN misconception_codes c ON c.id = t.misconception_code_id
        WHERE t.question_revision_id = ${revision.id}::uuid AND r.state = 'APPROVED'
        ORDER BY t.content_revision_id FOR UPDATE OF r
      `);
      const unpublishedCodes = tags.filter((tag) => tag.code_state !== 'PUBLISHED');
      if (unpublishedCodes.length) {
        throw new QuestionBankError('QUESTION_MISCONCEPTION_NOT_PUBLISHED', unpublishedCodes.map((tag) => `QUESTION_MISCONCEPTION_NOT_PUBLISHED:${tag.option_id}`));
      }
      const [source] = await rows<{ id: string }>(tx, sql`
        SELECT id FROM source_records
        WHERE source_entity_type = 'QUESTION_BANK_REVISION' AND source_record_id = ${revision.id} AND release_eligible AND source_hash = ${revision.content_hash}
        LIMIT 1
      `);
      if (!source) throw new QuestionBankError('QUESTION_RIGHTS_NOT_REVIEWED');
      const [approvedBy] = await rows<{ actor_user_id: string }>(tx, sql`
        SELECT actor_user_id FROM content_review_actions WHERE content_revision_id = ${revision.id}::uuid AND action = 'APPROVE'
        ORDER BY occurred_at DESC, id DESC LIMIT 1
      `);
      if (!approvedBy) throw new QuestionBankError('QUESTION_REVISION_NOT_APPROVED');
      const columns = publishedQuestionColumns(fields);

      const needsApproval = questionPublishAltersReadinessInputs({ readinessPool: currentReadinessPool });
      if (needsApproval && !input.approvalId) throw new QuestionBankRefused('APPROVAL_REQUIRED');
      const approval = input.approvalId
        ? await consumeOperationApproval(tx, {
          approvalId: input.approvalId, actionKey: 'CONTENT_QUESTION_PUBLISH', payload: input.approvalPayload(revision.content_hash),
          executorUserId: input.actor.userId, correlationId: input.actor.correlationId,
        })
        : null;

      const manifestId = randomUUID();
      const releaseName = `Question bank: ${revision.stableKey}`;
      const releaseVersion = Number(revision.revision);
      const items = [{ id: revision.id, hash: revision.content_hash }, ...tags.map((tag) => ({ id: tag.content_revision_id, hash: tag.content_hash }))];
      const manifestHash = sha256Hex(stableStringify({ name: releaseName, version: releaseVersion, items }));
      await tx.execute(sql`
        INSERT INTO release_manifests (id, name, version, manifest_hash, status)
        VALUES (${manifestId}::uuid, ${releaseName}, ${releaseVersion}, ${manifestHash}, 'DRAFT')
      `);
      for (const item of items) {
        await tx.execute(sql`
          INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash)
          VALUES (${manifestId}::uuid, ${item.id}::uuid, ${source.id}::uuid, ${item.hash})
        `);
      }
      await tx.execute(sql`
        UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = ${approvedBy.actor_user_id}::uuid, approved_at = now()
        WHERE id = ${manifestId}::uuid
      `);
      await tx.execute(sql`
        UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = ${input.actor.userId}::uuid, published_at = now()
        WHERE id = ${manifestId}::uuid
      `);
      // The question first: 0049 publishes a tag only on a published question.
      for (const item of items) {
        await tx.execute(sql`
          UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = ${manifestId}::uuid, published_at = now() WHERE id = ${item.id}::uuid
        `);
        await tx.execute(sql`
          INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
          VALUES (${randomUUID()}::uuid, ${item.id}::uuid, ${input.actor.userId}::uuid, 'PUBLISH', 'APPROVED', 'PUBLISHED', ${input.reasonCode}, ${input.actor.correlationId})
        `);
      }
      // One current version per question in the readiness-check pool (0061).
      const superseded = await rows<{ id: string }>(tx, sql`
        UPDATE question_versions v SET superseded_at = now()
        FROM content_revisions r
        WHERE r.id = v.content_revision_id AND r.entity_type = 'QUESTION' AND r.entity_id = ${revision.entity_id}::uuid AND v.superseded_at IS NULL
        RETURNING v.id
      `);
      const questionVersionId = randomUUID();
      await tx.execute(sql`
        INSERT INTO question_versions (id, stable_key, version, topic_id, prompt, options, content_revision_id, release_manifest_id, published_at)
        VALUES (${questionVersionId}::uuid, ${revision.stableKey}, ${releaseVersion}, ${columns.learner.topicId}::uuid, ${columns.learner.prompt},
                ${JSON.stringify(columns.learner.options)}::jsonb, ${revision.id}::uuid, ${manifestId}::uuid, now())
      `);
      await tx.execute(sql`
        INSERT INTO question_answer_keys (question_version_id, correct_option_id, explanation, answer_hash)
        VALUES (${questionVersionId}::uuid, ${columns.answerKey.correctOptionId}, ${columns.answerKey.explanation},
                ${sha256Hex(`${questionVersionId}:${columns.answerKey.correctOptionId}`)})
      `);
      await audit(tx, {
        actor: input.actor, action: 'operations.content.question_published', revisionId: revision.id,
        context: {
          questionId: revision.entity_id, stableKey: revision.stableKey, revision: releaseVersion, questionVersionId, reasonCode: input.reasonCode,
          releaseManifestId: manifestId, tagCount: tags.length, supersededCount: superseded.length, approvalRequired: needsApproval,
          ...(approval ? { approvalId: approval.approvalId, requestedByUserId: approval.requestedByUserId, approvedByUserId: approval.approvedByUserId, mode: approval.mode } : {}),
        },
      });
      await stateChanged(tx, input.actor, revision.id, revision.entity_id, 'APPROVED', 'PUBLISHED');
      await outbox(tx, {
        actor: input.actor, revisionId: revision.id, eventType: 'question_bank.question_published',
        payload: { revisionId: revision.id, questionId: revision.entity_id, questionVersionId, releaseManifestId: manifestId },
      });
      return { questionId: revision.entity_id, questionVersionId, releaseManifestId: manifestId, approval };
    });
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Archive a live question (docs/architecture/content-archive-design.md): refused while a revision
 * is open; otherwise every published revision becomes ARCHIVED (with its ARCHIVE review action;
 * the hint ladder follows through 0061's mirror) and the current version is superseded, which is
 * the column the readiness check, the learning steps, the placement pool and faculty actions all
 * read — so no student is served it again. The version row stays: attempts already holding it
 * still grade against it. Nothing is deleted, and the question cannot be revised again.
 */
export async function archiveQuestion(db: TransactionalRunner, input: {
  readonly questionId: string; readonly reasonCode: string; readonly actor: QuestionActor;
}): Promise<{ readonly questionId: string; readonly archivedRevisions: readonly number[] }> {
  try {
    return await db.transaction(async (tx) => {
      await lockQuestion(tx, input.questionId);
      const [exists] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM content_revisions WHERE entity_type = 'QUESTION' AND entity_id = ${input.questionId}::uuid`);
      if (!Number(exists?.n)) throw new QuestionBankError('QUESTION_NOT_FOUND');
      const current = await rows<{ id: string; stable_key: string; content_revision_id: string }>(tx, sql`
        SELECT v.id, v.stable_key, v.content_revision_id FROM question_versions v JOIN content_revisions r ON r.id = v.content_revision_id
        WHERE r.entity_type = 'QUESTION' AND r.entity_id = ${input.questionId}::uuid AND v.superseded_at IS NULL
        ORDER BY v.version DESC
      `);
      const newest = current[0];
      if (!newest) throw new QuestionBankError('QUESTION_NOT_LIVE');
      const blockers = questionArchiveBlockers({ openRevision: (await openRevisionOf(tx, input.questionId)) !== null });
      if (blockers.length) throw new QuestionBankError('QUESTION_ARCHIVE_BLOCKED', blockers);
      const archived = await archivePublishedRevisions(tx, {
        entityType: 'QUESTION', entityId: input.questionId, reasonCode: input.reasonCode, actorUserId: input.actor.userId, correlationId: input.actor.correlationId,
      });
      // Out of every pool at once: each reads superseded_at IS NULL (the 0061 guard allows this one change).
      for (const version of current) await tx.execute(sql`UPDATE question_versions SET superseded_at = now() WHERE id = ${version.id}::uuid`);
      await audit(tx, {
        actor: input.actor, action: 'operations.content.question_archived', revisionId: newest.content_revision_id,
        context: {
          questionId: input.questionId, stableKey: newest.stable_key, questionVersionId: newest.id, reasonCode: input.reasonCode,
          archivedRevisions: archived.map((entry) => entry.revision),
        },
      });
      for (const revision of archived) await stateChanged(tx, input.actor, revision.id, input.questionId, 'PUBLISHED', 'ARCHIVED');
      return { questionId: input.questionId, archivedRevisions: archived.map((entry) => entry.revision) };
    });
  } catch (error) {
    rethrow(error);
  }
}
