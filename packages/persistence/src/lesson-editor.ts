/**
 * Lesson and variant editor persistence (OPS-09c, migration 0065): lessons as versioned LESSON
 * content revisions, taken from draft through review (with its rights review) to a publish that
 * writes the `lesson_versions` row students complete — or, for a variant (another language, level
 * or style of a lesson), the published revision ENG-16 will serve — through a release manifest,
 * under a second person's approval when completion evidence would change.
 *
 * Why this exists: the pilot's three lessons were the only ones, written by a seed. This is the
 * operator path, built on the 0004 pipeline rather than beside it. Review follows the
 * learner-content lifecycle: every move is checked against its rules and 0004's, contributors
 * never review or publish, and the approver never publishes. Every write puts its audit row and
 * outbox event in its own transaction; the pure rules live in packages/career-readiness (content)
 * and packages/authorization (who, and when an approval is needed).
 *
 * Design: docs/architecture/lesson-variant-editor-design.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  assertContentTransition,
  composeLessonBody,
  LESSON_LICENCES_REQUIRING_ATTRIBUTION,
  lessonGraphProblems,
  lessonVariantLabel,
  publishedLessonBody,
  readAgentDraftProvenance,
  readLessonDraftFields,
  readLessonIdentity,
  sameLessonVariant,
  sha256Hex,
  stableStringify,
  validateLessonDraft,
  type LessonDraftFields,
  type LessonIdentity,
  type LessonVariantMetadata,
} from '@planthepath/career-readiness';
import { assertLearnerContentReviewTransition } from '@planthepath/learner-content';
import {
  lessonArchiveBlockers,
  lessonOpenRevisionStates,
  lessonPublishAltersReadinessInputs,
  type LessonEditorRefusal,
  type LessonRevisionState,
} from '@planthepath/authorization/src/index.js';
import { archivePublishedRevisions } from './content-archive.js';
import { consumeOperationApproval, type ConsumedApproval } from './operation-approvals.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';
import { agentDraftBodyKeys, type AgentDraftProvenance } from './skill-map.js';

// The content rules, for callers (the API) that do not depend on packages/career-readiness directly.
export {
  LESSON_ATTRIBUTION_MAX,
  LESSON_BASIS_MAX,
  LESSON_LANGUAGE_NAMES,
  LESSON_LANGUAGES,
  LESSON_LEVEL_MEANINGS,
  LESSON_LEVELS,
  LESSON_LICENCES,
  LESSON_LICENCES_REQUIRING_ATTRIBUTION,
  LESSON_PRACTICE_MAX,
  LESSON_PREREQUISITES_MAX,
  LESSON_STABLE_KEY_PATTERN,
  LESSON_STYLE_MEANINGS,
  LESSON_STYLES,
  LESSON_SUMMARY_MAX,
  LESSON_TITLE_MAX,
  type LessonDraftFields,
  type LessonLanguage,
  type LessonLevel,
  type LessonLicence,
  type LessonStyle,
  type LessonVariantMetadata,
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

export type LessonEditorErrorCode =
  | 'LESSON_NOT_FOUND'
  | 'LESSON_REVISION_NOT_FOUND'
  | 'LESSON_KEY_EXISTS'
  | 'LESSON_VARIANT_EXISTS'
  | 'LESSON_BASE_NOT_LIVE'
  | 'LESSON_NOT_A_BASE'
  | 'LESSON_OPEN_REVISION_EXISTS'
  | 'LESSON_NOT_LIVE'
  | 'LESSON_REVISION_NOT_EDITABLE'
  | 'LESSON_REVISION_NOT_APPROVED'
  | 'LESSON_RIGHTS_NOT_REVIEWED'
  | 'LESSON_TOPIC_UNKNOWN'
  | 'LESSON_TOPIC_NOT_LIVE'
  | 'LESSON_MODULE_UNKNOWN'
  | 'LESSON_PREREQUISITE_NOT_LIVE'
  | 'LESSON_TRANSITION_NOT_ALLOWED'
  | 'LESSON_ARCHIVE_BLOCKED'
  | 'LESSON_INVALID'
  | 'LESSON_EDITOR_REJECTED';

export class LessonEditorError extends Error {
  /** For LESSON_INVALID and the reference errors: stable codes, safe to show. */
  constructor(readonly code: LessonEditorErrorCode, readonly problems: readonly string[] = []) {
    super(problems.length ? `${code}: ${problems.join(', ')}` : code);
    this.name = 'LessonEditorError';
  }
}

/** A refusal from a pure rule, carried out of the transaction as is. */
export class LessonEditorRefused extends Error {
  constructor(readonly code: LessonEditorRefusal | 'APPROVAL_REQUIRED') {
    super(code);
    this.name = 'LessonEditorRefused';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code
    ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505';
}

/** Who acted, and whether through the super admin's break-glass (§5.1: audited as such). */
export interface LessonActor {
  readonly userId: string;
  readonly breakGlass: boolean;
  readonly correlationId: string;
}

async function audit(runner: SqlRunner, input: {
  readonly actor: LessonActor; readonly action: string; readonly revisionId: string; readonly context: Record<string, unknown>;
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
  readonly actor: LessonActor; readonly revisionId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, aggregateType: 'content_revision', aggregateId: input.revisionId, eventType: input.eventType, payload: input.payload, actorUserId: input.actor.userId, correlationId: input.actor.correlationId, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, 'content_revision', ${input.revisionId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actor.userId}::uuid, ${input.actor.correlationId})
  `);
}

async function stateChanged(tx: SqlRunner, actor: LessonActor, revisionId: string, lessonId: string, from: LessonRevisionState, to: LessonRevisionState): Promise<void> {
  await outbox(tx, { actor, revisionId, eventType: 'lesson_editor.revision_state_changed', payload: { revisionId, lessonId, fromState: from, toState: to } });
}

/** The audit actions that make someone a contributor: every draft save, and every submission. */
export const lessonDraftSavedAction = 'operations.content.lesson_draft_saved';
export const lessonTransitionedAction = 'operations.content.lesson_transitioned';

const openStates = sql.join(lessonOpenRevisionStates.map((state) => sql`${state}`), sql`, `);
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());
const contentHashOf = (body: Record<string, unknown>): string => sha256Hex(stableStringify(body));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** ARCHIVED: every published revision archived (content-archive-design.md); the lesson is served nowhere. */
export type LessonStatus = 'LIVE' | 'PENDING' | 'ARCHIVED';
export type LessonKind = 'BASE' | 'VARIANT';
export type LessonListFilter = LessonStatus | 'AWAITING_REVIEW' | 'CHANGES_REQUESTED' | 'AWAITING_PUBLISH' | 'VARIANTS';
export type TopicStatus = 'LIVE' | 'PENDING' | 'RETIRED';

export interface LessonTopic {
  readonly id: string;
  readonly stableKey: string;
  readonly name: string;
  readonly status: TopicStatus;
}

export interface LessonSummaryRow {
  readonly lessonId: string;
  readonly stableKey: string;
  readonly kind: LessonKind;
  readonly variant: LessonVariantMetadata;
  /** For a variant: its base lesson's id. */
  readonly variantOf: string | null;
  readonly title: string;
  readonly status: LessonStatus;
  /** The latest published revision (for a base lesson, the current lesson version). */
  readonly publishedRevision: number | null;
  readonly openRevision: { readonly id: string; readonly revision: number; readonly state: LessonRevisionState } | null;
  readonly topic: LessonTopic | null;
  readonly moduleKey: string | null;
  /** For a base lesson: how many variants it has (any state). */
  readonly variantCount: number;
  /** For a variant: the base revision it renders, and the base's current published revision. */
  readonly basedOnRevision: number | null;
  readonly baseRevision: number | null;
}

interface LessonDbRow {
  lesson_id: string; latest_id: string; latest_revision: number; latest_state: LessonRevisionState; latest_body: unknown;
  variant_of: string | null; sort_key: string; published_revision: number | null; variant_count: number; base_published_revision: number | null;
  topic_id: string | null; topic_key: string | null; topic_name: string | null; topic_active: boolean | null; topic_pointer_state: string | null;
}

const lessonSelect = sql`
  WITH latest AS (
    SELECT DISTINCT ON (c.entity_id) c.entity_id AS lesson_id, c.id AS latest_id, c.revision AS latest_revision,
           c.state AS latest_state, c.body AS latest_body
    FROM content_revisions c WHERE c.entity_type = 'LESSON'
    ORDER BY c.entity_id, c.revision DESC
  ), l AS (
    SELECT latest.*,
      NULLIF(latest.latest_body ->> 'variantOf', '') AS variant_of,
      ((COALESCE(latest.latest_body ->> 'stableKey', '') || CASE WHEN COALESCE(latest.latest_body ->> 'variantOf', '') = '' THEN ''
        ELSE '~' || COALESCE(latest.latest_body #>> '{variant,language}', '') || '/' || COALESCE(latest.latest_body #>> '{variant,level}', '')
          || '/' || COALESCE(latest.latest_body #>> '{variant,style}', '') END) COLLATE "C") AS sort_key,
      (SELECT max(p.revision)::int FROM content_revisions p
        WHERE p.entity_type = 'LESSON' AND p.entity_id = latest.lesson_id AND p.state = 'PUBLISHED') AS published_revision
    FROM latest
  )
  SELECT l.*,
    (SELECT count(*)::int FROM latest v WHERE v.latest_body ->> 'variantOf' = l.lesson_id::text) AS variant_count,
    (SELECT max(p.revision)::int FROM content_revisions p
      WHERE p.entity_type = 'LESSON' AND p.entity_id::text = l.variant_of AND p.state = 'PUBLISHED') AS base_published_revision,
    t.id AS topic_id, t.stable_key AS topic_key, t.name AS topic_name, t.active AS topic_active, tp.state AS topic_pointer_state
  FROM l
  LEFT JOIN taxonomy_nodes t ON t.kind = 'TOPIC' AND t.id::text = (l.latest_body ->> 'topicId')
  LEFT JOIN content_revisions tp ON tp.id = t.content_revision_id`;

function topicStatus(active: boolean, pointerState: string | null): TopicStatus {
  if (active) return 'LIVE';
  return pointerState && (lessonOpenRevisionStates as readonly string[]).includes(pointerState) ? 'PENDING' : 'RETIRED';
}

type TopicRow = { topic_id: string | null; topic_key: string | null; topic_name: string | null; topic_active: boolean | null; topic_pointer_state: string | null };
function topicOf(row: TopicRow): LessonTopic | null {
  if (!row.topic_id) return null;
  return { id: row.topic_id, stableKey: row.topic_key ?? 'NA', name: row.topic_name ?? 'NA', status: topicStatus(Boolean(row.topic_active), row.topic_pointer_state) };
}

function mapSummary(row: LessonDbRow): LessonSummaryRow {
  const identity = readLessonIdentity(row.latest_body);
  const fields = readLessonDraftFields(row.latest_body);
  const open = (lessonOpenRevisionStates as readonly string[]).includes(row.latest_state);
  const variant = identity.variantOf !== null;
  return {
    lessonId: row.lesson_id,
    stableKey: identity.stableKey || 'NA',
    kind: variant ? 'VARIANT' : 'BASE',
    variant: identity.variant,
    variantOf: identity.variantOf,
    title: fields.title || 'NA',
    status: row.published_revision !== null ? 'LIVE' : row.latest_state === 'ARCHIVED' ? 'ARCHIVED' : 'PENDING',
    publishedRevision: row.published_revision === null ? null : Number(row.published_revision),
    openRevision: open ? { id: row.latest_id, revision: Number(row.latest_revision), state: row.latest_state } : null,
    topic: variant ? null : topicOf(row),
    moduleKey: variant ? null : fields.moduleKey,
    variantCount: variant ? 0 : Number(row.variant_count ?? 0),
    basedOnRevision: variant ? identity.basedOnRevision : null,
    baseRevision: variant && row.base_published_revision !== null ? Number(row.base_published_revision) : null,
  };
}

function likePattern(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function filterSql(filter: LessonListFilter | undefined): SQL {
  switch (filter) {
    case undefined: return sql`TRUE`;
    case 'LIVE': return sql`q.published_revision IS NOT NULL`;
    case 'PENDING': return sql`q.published_revision IS NULL AND q.latest_state <> 'ARCHIVED'`;
    case 'ARCHIVED': return sql`q.published_revision IS NULL AND q.latest_state = 'ARCHIVED'`;
    case 'AWAITING_REVIEW': return sql`q.latest_state = 'IN_REVIEW'`;
    case 'CHANGES_REQUESTED': return sql`q.latest_state = 'CHANGES_REQUESTED'`;
    case 'AWAITING_PUBLISH': return sql`q.latest_state = 'APPROVED'`;
    case 'VARIANTS': return sql`q.variant_of IS NOT NULL`;
  }
}

/** Lessons and their variants, searchable by key and title, keyset paginated on (sort key, lesson id). */
export async function listLessons(runner: SqlRunner, input: {
  readonly q?: string; readonly filter?: LessonListFilter; readonly limit: number;
  readonly cursor?: { readonly key: string; readonly id: string };
}): Promise<{ readonly lessons: readonly LessonSummaryRow[]; readonly nextCursor: { readonly key: string; readonly id: string } | null }> {
  const q = input.q ? likePattern(input.q) : null;
  const page = await rows<LessonDbRow>(runner, sql`
    SELECT * FROM (${lessonSelect}) q
    WHERE ${filterSql(input.filter)}
      AND (${q}::text IS NULL OR lower(q.latest_body ->> 'stableKey') LIKE ${q} OR lower(q.latest_body ->> 'title') LIKE ${q})
      AND (${input.cursor?.key ?? null}::text IS NULL
        OR (q.sort_key, q.lesson_id) > ((${input.cursor?.key ?? null}::text COLLATE "C"), ${input.cursor?.id ?? null}::uuid))
    ORDER BY q.sort_key, q.lesson_id
    LIMIT ${input.limit + 1}
  `);
  const shown = page.slice(0, input.limit);
  const last = shown[shown.length - 1];
  return { lessons: shown.map(mapSummary), nextCursor: page.length > input.limit && last ? { key: last.sort_key, id: last.lesson_id } : null };
}

export interface LessonEditorSummary {
  readonly live: number;
  readonly pending: number;
  readonly awaitingReview: number;
  readonly awaitingPublish: number;
  readonly liveVariants: number;
  readonly archived: number;
}

/** Counts for the header, in one bounded query (§5.7). */
export async function summariseLessons(runner: SqlRunner): Promise<LessonEditorSummary> {
  const [row] = await rows<Record<string, number>>(runner, sql`
    SELECT
      count(*) FILTER (WHERE q.variant_of IS NULL AND q.published_revision IS NOT NULL)::int AS live,
      count(*) FILTER (WHERE q.published_revision IS NULL AND q.latest_state <> 'ARCHIVED')::int AS pending,
      count(*) FILTER (WHERE q.published_revision IS NULL AND q.latest_state = 'ARCHIVED')::int AS archived,
      count(*) FILTER (WHERE q.latest_state = 'IN_REVIEW')::int AS awaiting_review,
      count(*) FILTER (WHERE q.latest_state = 'APPROVED')::int AS awaiting_publish,
      count(*) FILTER (WHERE q.variant_of IS NOT NULL AND q.published_revision IS NOT NULL)::int AS live_variants
    FROM (${lessonSelect}) q
  `);
  const value = (key: string): number => Number(row?.[key] ?? 0);
  return {
    live: value('live'), pending: value('pending'), awaitingReview: value('awaiting_review'), awaitingPublish: value('awaiting_publish'),
    liveVariants: value('live_variants'), archived: value('archived'),
  };
}

/** The published modules a base lesson can belong to (only the pilot's, today). */
export async function listLessonModules(runner: SqlRunner): Promise<readonly { readonly stableKey: string; readonly title: string }[]> {
  const found = await rows<{ stable_key: string; title: string }>(runner, sql`
    SELECT DISTINCT ON (m.stable_key) m.stable_key, m.title FROM learning_modules m
    JOIN release_manifests rm ON rm.id = m.release_manifest_id AND rm.status = 'PUBLISHED'
    ORDER BY m.stable_key, m.version DESC LIMIT 200
  `);
  return found.map((row) => ({ stableKey: row.stable_key, title: row.title }));
}

export interface LessonRevisionView {
  readonly id: string;
  readonly revision: number;
  readonly state: LessonRevisionState;
  readonly contentHash: string;
  readonly author: { readonly userId: string; readonly email: string };
  readonly contributors: readonly { readonly userId: string; readonly email: string }[];
  /** Who approved it (the latest APPROVE action); null before approval. They never publish it. */
  readonly approver: { readonly userId: string; readonly email: string } | null;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly identity: LessonIdentity;
  readonly fields: LessonDraftFields;
  readonly topic: LessonTopic | null;
  /** Set when an import pack drafted this revision (program B.8); null when a person wrote it. */
  readonly agentDraft: { readonly generatorVersion: string; readonly promptVersion: string; readonly generatedAt: string } | null;
  readonly expertCheck: string | null;
  readonly rightsReview: { readonly licenceLabel: string; readonly reviewerEmail: string; readonly reasonCode: string; readonly reviewedAt: string } | null;
}

export interface LessonDetail extends LessonSummaryRow {
  /** The latest published revision; null for a lesson never published. */
  readonly current: LessonRevisionView | null;
  readonly open: LessonRevisionView | null;
  /** Base lessons: the lesson versions students have been given, newest first. Variants: published revisions. */
  readonly versions: readonly { readonly version: number; readonly publishedAt: string; readonly superseded: boolean }[];
  /** For a base lesson: its variants. For a variant: empty. */
  readonly variants: readonly LessonSummaryRow[];
  /** For a variant: its base lesson. */
  readonly base: LessonSummaryRow | null;
  /** Whether publishing the open revision needs an approval (Decision 8); false with no open revision. */
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
      AND (action = ${lessonDraftSavedAction} OR (action = ${lessonTransitionedAction} AND context ->> 'toState' = 'IN_REVIEW'))
  `);
  return [...new Set([authorUserId, ...found.map((row) => row.actor_user_id)])];
}

async function approverOf(runner: SqlRunner, revisionId: string): Promise<string | null> {
  const [row] = await rows<{ actor_user_id: string }>(runner, sql`
    SELECT actor_user_id FROM content_review_actions WHERE content_revision_id = ${revisionId}::uuid AND action = 'APPROVE'
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  `);
  return row?.actor_user_id ?? null;
}

async function topicById(runner: SqlRunner, topicId: string | null): Promise<LessonTopic | null> {
  if (!topicId) return null;
  const [row] = await rows<TopicRow>(runner, sql`
    SELECT n.id AS topic_id, n.stable_key AS topic_key, n.name AS topic_name, n.active AS topic_active, p.state AS topic_pointer_state
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id WHERE n.kind = 'TOPIC' AND n.id = ${topicId}::uuid
  `);
  return row ? topicOf(row) : null;
}

async function revisionView(runner: SqlRunner, revisionId: string): Promise<LessonRevisionView> {
  const [row] = await rows<{
    id: string; revision: number; state: LessonRevisionState; content_hash: string; author_user_id: string; author_email: string;
    created_at: Date; published_at: Date | null; body: unknown;
  }>(runner, sql`
    SELECT c.id, c.revision, c.state, c.content_hash, c.author_user_id, u.email AS author_email, c.created_at, c.published_at, c.body
    FROM content_revisions c JOIN users u ON u.id = c.author_user_id WHERE c.id = ${revisionId}::uuid AND c.entity_type = 'LESSON'
  `);
  if (!row) throw new LessonEditorError('LESSON_REVISION_NOT_FOUND');
  const contributorIds = await contributorsOf(runner, row.id, row.author_user_id);
  const approverId = await approverOf(runner, row.id);
  const people = [...new Set([...contributorIds, ...(approverId ? [approverId] : [])])];
  const emails = await rows<{ id: string; email: string }>(runner, sql`
    SELECT id, email FROM users WHERE id IN (${sql.join(people.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const emailOf = (id: string): string => emails.find((entry) => entry.id === id)?.email ?? 'NA';
  const [rights] = await rows<{ license_label: string; reviewer_email: string; reason_code: string; reviewed_at: Date }>(runner, sql`
    SELECT r.license_label, u.email AS reviewer_email, r.reason_code, r.reviewed_at
    FROM source_records s JOIN rights_reviews r ON r.source_record_id = s.id JOIN users u ON u.id = r.reviewer_user_id
    WHERE s.source_entity_type = 'LESSON_EDITOR_REVISION' AND s.source_record_id = ${row.id}
    ORDER BY r.reviewed_at DESC LIMIT 1
  `);
  const identity = readLessonIdentity(row.body);
  const fields = readLessonDraftFields(row.body);
  const drafted = readAgentDraftProvenance(row.body);
  return {
    id: row.id, revision: Number(row.revision), state: row.state, contentHash: row.content_hash,
    author: { userId: row.author_user_id, email: row.author_email },
    contributors: contributorIds.map((id) => ({ userId: id, email: emailOf(id) })),
    approver: approverId ? { userId: approverId, email: emailOf(approverId) } : null,
    createdAt: iso(row.created_at)!, publishedAt: iso(row.published_at),
    identity, fields,
    topic: identity.variantOf === null ? await topicById(runner, fields.topicId) : null,
    agentDraft: drafted ? { generatorVersion: drafted.generatorVersion, promptVersion: drafted.promptVersion, generatedAt: drafted.generatedAt } : null,
    expertCheck: drafted ? drafted.expertCheck : null,
    rightsReview: rights ? { licenceLabel: rights.license_label, reviewerEmail: rights.reviewer_email, reasonCode: rights.reason_code, reviewedAt: iso(rights.reviewed_at)! } : null,
  };
}

async function summaryOf(runner: SqlRunner, lessonId: string): Promise<LessonSummaryRow | null> {
  const [row] = await rows<LessonDbRow>(runner, sql`SELECT * FROM (${lessonSelect}) q WHERE q.lesson_id = ${lessonId}::uuid`);
  return row ? mapSummary(row) : null;
}

/** One lesson (base or variant) for the editor. */
export async function loadLesson(runner: SqlRunner, lessonId: string): Promise<LessonDetail | null> {
  const summary = await summaryOf(runner, lessonId);
  if (!summary) return null;
  const [currentRevision] = await rows<{ id: string }>(runner, sql`
    SELECT id FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${lessonId}::uuid AND state = 'PUBLISHED'
    ORDER BY revision DESC LIMIT 1
  `);
  const current = currentRevision ? await revisionView(runner, currentRevision.id) : null;
  const open = summary.openRevision ? await revisionView(runner, summary.openRevision.id) : null;
  const versions = summary.kind === 'BASE'
    ? await rows<{ version: number; published_at: Date; superseded_at: Date | null }>(runner, sql`
      SELECT v.version, v.published_at, v.superseded_at FROM lesson_versions v
      WHERE v.stable_key = ${summary.stableKey} ORDER BY v.version DESC LIMIT 50`)
    : (await rows<{ revision: number; published_at: Date; newest: number }>(runner, sql`
      SELECT revision, published_at, max(revision) OVER () AS newest FROM content_revisions
      WHERE entity_type = 'LESSON' AND entity_id = ${lessonId}::uuid AND state = 'PUBLISHED' ORDER BY revision DESC LIMIT 50`))
      .map((entry) => ({ version: entry.revision, published_at: entry.published_at, superseded_at: Number(entry.revision) < Number(entry.newest) ? entry.published_at : null }));
  const variants = summary.kind === 'BASE'
    ? (await rows<LessonDbRow>(runner, sql`SELECT * FROM (${lessonSelect}) q WHERE q.variant_of = ${lessonId} ORDER BY q.sort_key, q.lesson_id LIMIT 100`)).map(mapSummary)
    : [];
  const base = summary.variantOf ? await summaryOf(runner, summary.variantOf) : null;
  const history = await rows<{ revision: number; action: string; from_state: string; to_state: string; reason_code: string; email: string; occurred_at: Date }>(runner, sql`
    SELECT c.revision, a.action, a.from_state, a.to_state, a.reason_code, u.email, a.occurred_at
    FROM content_review_actions a JOIN content_revisions c ON c.id = a.content_revision_id JOIN users u ON u.id = a.actor_user_id
    WHERE c.entity_type = 'LESSON' AND c.entity_id = ${lessonId}::uuid
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT 50
  `);
  return {
    ...summary,
    current,
    open,
    versions: versions.map((entry) => ({ version: Number(entry.version), publishedAt: iso(entry.published_at)!, superseded: entry.superseded_at !== null })),
    variants,
    base,
    publishNeedsApproval: open ? await needsApprovalFor(runner, open.identity, open.fields) : false,
    history: history.map((entry) => ({
      revision: Number(entry.revision), action: entry.action, fromState: entry.from_state, toState: entry.to_state,
      reasonCode: entry.reason_code, actorEmail: entry.email, occurredAt: iso(entry.occurred_at)!,
    })),
  };
}

// ---------------------------------------------------------------------------
// The lesson graph and live state
// ---------------------------------------------------------------------------

interface CurrentVersion { id: string; topic_id: string; module_id: string; module_key: string }

/** The current (unsuperseded) lesson version for a key, if the lesson is live. */
async function currentVersionOf(runner: SqlRunner, stableKey: string): Promise<CurrentVersion | null> {
  const [row] = await rows<CurrentVersion>(runner, sql`
    SELECT v.id, v.topic_id, v.module_id, m.stable_key AS module_key FROM lesson_versions v JOIN learning_modules m ON m.id = v.module_id
    WHERE v.stable_key = ${stableKey} AND v.superseded_at IS NULL ORDER BY v.version DESC LIMIT 1
  `);
  return row ?? null;
}

/** Live lessons and their live prerequisites, by stable key. */
async function liveGraph(runner: SqlRunner): Promise<Map<string, readonly string[]>> {
  const found = await rows<{ stable_key: string; prerequisites: string[] }>(runner, sql`
    SELECT v.stable_key, COALESCE(array_agg(DISTINCT pv.stable_key) FILTER (WHERE pv.id IS NOT NULL), '{}') AS prerequisites
    FROM lesson_versions v
    LEFT JOIN lesson_prerequisites p ON p.lesson_version_id = v.id
    LEFT JOIN lesson_versions pv ON pv.id = p.prerequisite_lesson_version_id
    WHERE v.superseded_at IS NULL
    GROUP BY v.stable_key
  `);
  return new Map(found.map((row) => [row.stable_key, [...row.prerequisites].sort()]));
}

/** The map as it is being built: live lessons, overlaid with every other base lesson's open revision. */
async function draftGraph(runner: SqlRunner, excludeLessonId: string): Promise<Map<string, readonly string[]>> {
  const graph = await liveGraph(runner);
  const latest = await rows<{ entity_id: string; state: string; body: unknown }>(runner, sql`
    SELECT DISTINCT ON (c.entity_id) c.entity_id, c.state, c.body FROM content_revisions c
    WHERE c.entity_type = 'LESSON' ORDER BY c.entity_id, c.revision DESC
  `);
  for (const row of latest) {
    if (row.entity_id === excludeLessonId || !(lessonOpenRevisionStates as readonly string[]).includes(row.state)) continue;
    const identity = readLessonIdentity(row.body);
    if (identity.variantOf !== null || !identity.stableKey) continue;
    graph.set(identity.stableKey, readLessonDraftFields(row.body).prerequisites);
  }
  return graph;
}

async function moduleIdByKey(runner: SqlRunner, moduleKey: string): Promise<string | null> {
  const [row] = await rows<{ id: string }>(runner, sql`
    SELECT m.id FROM learning_modules m JOIN release_manifests rm ON rm.id = m.release_manifest_id AND rm.status = 'PUBLISHED'
    WHERE m.stable_key = ${moduleKey} ORDER BY m.version DESC LIMIT 1
  `);
  return row?.id ?? null;
}

/** A topic by key: live or pending may be chosen; a retired one may not. */
async function topicByKey(tx: SqlRunner, topicKey: string): Promise<LessonTopic> {
  const [row] = await rows<TopicRow>(tx, sql`
    SELECT n.id AS topic_id, n.stable_key AS topic_key, n.name AS topic_name, n.active AS topic_active, p.state AS topic_pointer_state
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id
    WHERE n.kind = 'TOPIC' AND n.stable_key = ${topicKey} ORDER BY n.version DESC LIMIT 1
  `);
  const topic = row ? topicOf(row) : null;
  if (!topic || topic.status === 'RETIRED') throw new LessonEditorError('LESSON_TOPIC_UNKNOWN', [`LESSON_TOPIC_UNKNOWN:${topicKey}`]);
  return topic;
}

/** References a base draft makes: its module, its skill, and a DAG of known prerequisites. */
async function referenceProblems(tx: SqlRunner, lessonId: string, identity: LessonIdentity, fields: LessonDraftFields): Promise<readonly string[]> {
  if (identity.variantOf !== null) return [];
  const problems: string[] = [];
  if (fields.moduleKey && !(await moduleIdByKey(tx, fields.moduleKey))) problems.push('LESSON_MODULE_UNKNOWN');
  if (fields.topicId) {
    const topic = await topicById(tx, fields.topicId);
    if (!topic || topic.status === 'RETIRED') problems.push('LESSON_TOPIC_UNKNOWN');
  }
  problems.push(...lessonGraphProblems(await draftGraph(tx, lessonId), identity.stableKey, fields.prerequisites));
  return problems;
}

/** Decision 8, from the rows as they are now. */
async function approvalFactsFor(runner: SqlRunner, identity: LessonIdentity, fields: LessonDraftFields): Promise<Parameters<typeof lessonPublishAltersReadinessInputs>[0]> {
  if (identity.variantOf !== null) return { isVariant: true, firstPublish: false, topicChanged: false, prerequisitesChanged: false };
  const current = await currentVersionOf(runner, identity.stableKey);
  if (!current) return { isVariant: false, firstPublish: true, topicChanged: false, prerequisitesChanged: false };
  const live = (await liveGraph(runner)).get(identity.stableKey) ?? [];
  const next = [...fields.prerequisites].sort();
  return {
    isVariant: false,
    firstPublish: false,
    topicChanged: current.topic_id !== fields.topicId,
    prerequisitesChanged: live.length !== next.length || live.some((key, index) => key !== next[index]),
  };
}

async function needsApprovalFor(runner: SqlRunner, identity: LessonIdentity, fields: LessonDraftFields): Promise<boolean> {
  return lessonPublishAltersReadinessInputs(await approvalFactsFor(runner, identity, fields));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function rethrow(error: unknown): never {
  if (error instanceof LessonEditorError || error instanceof LessonEditorRefused) throw error;
  // Approval refusals keep their own type for the HTTP gate.
  if (error instanceof Error && error.name === 'OperationApprovalError') throw error;
  if (isUniqueViolation(error)) throw new LessonEditorError('LESSON_KEY_EXISTS');
  throw new LessonEditorError('LESSON_EDITOR_REJECTED');
}

async function lockLesson(tx: SqlRunner, lessonId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'lesson-editor:' + lessonId}))`);
}

async function keyInUse(tx: SqlRunner, stableKey: string): Promise<boolean> {
  const [row] = await rows<{ used: boolean }>(tx, sql`
    SELECT EXISTS (SELECT 1 FROM content_revisions WHERE entity_type = 'LESSON' AND body ->> 'stableKey' = ${stableKey}
                     AND COALESCE(body ->> 'variantOf', '') = '')
        OR EXISTS (SELECT 1 FROM lesson_versions WHERE stable_key = ${stableKey}) AS used
  `);
  return Boolean(row?.used);
}

async function insertRevision(tx: SqlRunner, input: { readonly revisionId: string; readonly lessonId: string; readonly revision: number; readonly actor: LessonActor; readonly body: Record<string, unknown> }): Promise<void> {
  await tx.execute(sql`
    INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
    VALUES (${input.revisionId}::uuid, 'LESSON', ${input.lessonId}::uuid, ${input.revision}, ${input.actor.userId}::uuid, 'DRAFT',
            ${contentHashOf(input.body)}, ${JSON.stringify(input.body)}::jsonb)
  `);
}

const emptyFields = (title: string): LessonDraftFields => ({
  title, summary: '', practice: null, moduleKey: null, topicId: null, prerequisites: [], licenceLabel: null, attribution: null, basis: null,
});

/**
 * Create a base lesson: revision 1 in DRAFT, in English, with the level and style chosen now.
 * `agentDraft` is given only by an import pack: the body then carries its provenance.
 */
export async function createLesson(db: TransactionalRunner, input: {
  readonly stableKey: string; readonly title: string; readonly level: LessonVariantMetadata['level']; readonly style: LessonVariantMetadata['style'];
  readonly reasonCode: string; readonly actor: LessonActor; readonly agentDraft?: AgentDraftProvenance;
}): Promise<{ readonly lessonId: string; readonly revisionId: string }> {
  const lessonId = randomUUID();
  const revisionId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'lesson-key:' + input.stableKey}))`);
      if (await keyInUse(tx, input.stableKey)) throw new LessonEditorError('LESSON_KEY_EXISTS');
      const identity: LessonIdentity = { stableKey: input.stableKey, variantOf: null, variant: { language: 'en', level: input.level, style: input.style }, basedOnRevision: null };
      const fields = emptyFields(input.title);
      const problems = validateLessonDraft(identity, fields, false);
      if (problems.length) throw new LessonEditorError('LESSON_INVALID', problems);
      const body = composeLessonBody(input.agentDraft ? agentDraftBodyKeys(input.agentDraft) : {}, identity, fields);
      await insertRevision(tx, { revisionId, lessonId, revision: 1, actor: input.actor, body });
      await audit(tx, {
        actor: input.actor, action: 'operations.content.lesson_created', revisionId,
        context: {
          lessonId, stableKey: input.stableKey, revision: 1, variant: lessonVariantLabel(identity.variant), reasonCode: input.reasonCode,
          ...(input.agentDraft ? { source: 'AGENT_DRAFTED', packKey: input.agentDraft.packKey } : {}),
        },
      });
    });
  } catch (error) {
    rethrow(error);
  }
  return { lessonId, revisionId };
}

/**
 * Create a variant of a live base lesson: its own lesson entity, revision 1 in DRAFT, with the
 * language, level and style fixed now, unique for the base and different from the base's own.
 * ENG-16's second-language drafts come through here with `agentDraft` set.
 */
export async function createLessonVariant(db: TransactionalRunner, input: {
  readonly baseLessonId: string; readonly variant: LessonVariantMetadata; readonly title: string;
  readonly reasonCode: string; readonly actor: LessonActor; readonly agentDraft?: AgentDraftProvenance;
}): Promise<{ readonly lessonId: string; readonly revisionId: string }> {
  const lessonId = randomUUID();
  const revisionId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await lockLesson(tx, input.baseLessonId);
      const [baseRevision] = await rows<{ body: unknown; revision: number }>(tx, sql`
        SELECT body, revision FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${input.baseLessonId}::uuid AND state = 'PUBLISHED'
        ORDER BY revision DESC LIMIT 1
      `);
      const [anyRevision] = await rows<{ body: unknown }>(tx, sql`
        SELECT body FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${input.baseLessonId}::uuid ORDER BY revision DESC LIMIT 1
      `);
      if (!anyRevision) throw new LessonEditorError('LESSON_NOT_FOUND');
      const baseIdentity = readLessonIdentity(anyRevision.body);
      if (baseIdentity.variantOf !== null) throw new LessonEditorError('LESSON_NOT_A_BASE');
      if (!baseRevision || !(await currentVersionOf(tx, baseIdentity.stableKey))) throw new LessonEditorError('LESSON_BASE_NOT_LIVE');
      if (sameLessonVariant(readLessonIdentity(baseRevision.body).variant, input.variant)) throw new LessonEditorError('LESSON_VARIANT_EXISTS');
      const siblings = await rows<{ body: unknown }>(tx, sql`
        SELECT DISTINCT ON (entity_id) body FROM content_revisions
        WHERE entity_type = 'LESSON' AND body ->> 'variantOf' = ${input.baseLessonId} ORDER BY entity_id, revision DESC
      `);
      if (siblings.some((sibling) => sameLessonVariant(readLessonIdentity(sibling.body).variant, input.variant))) throw new LessonEditorError('LESSON_VARIANT_EXISTS');
      const identity: LessonIdentity = { stableKey: baseIdentity.stableKey, variantOf: input.baseLessonId, variant: input.variant, basedOnRevision: Number(baseRevision.revision) };
      const fields = emptyFields(input.title);
      const problems = validateLessonDraft(identity, fields, false);
      if (problems.length) throw new LessonEditorError('LESSON_INVALID', problems);
      const body = composeLessonBody(input.agentDraft ? agentDraftBodyKeys(input.agentDraft) : {}, identity, fields);
      await insertRevision(tx, { revisionId, lessonId, revision: 1, actor: input.actor, body });
      await audit(tx, {
        actor: input.actor, action: 'operations.content.lesson_variant_created', revisionId,
        context: {
          lessonId, baseLessonId: input.baseLessonId, stableKey: identity.stableKey, revision: 1, variant: lessonVariantLabel(input.variant),
          basedOnRevision: identity.basedOnRevision, reasonCode: input.reasonCode,
          ...(input.agentDraft ? { source: 'AGENT_DRAFTED', packKey: input.agentDraft.packKey } : {}),
        },
      });
    });
  } catch (error) {
    rethrow(error);
  }
  return { lessonId, revisionId };
}

async function openRevisionOf(tx: SqlRunner, lessonId: string): Promise<string | null> {
  const [open] = await rows<{ id: string }>(tx, sql`
    SELECT id FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${lessonId}::uuid AND state IN (${openStates}) LIMIT 1
  `);
  return open?.id ?? null;
}

/** The base's current published revision, which a variant renders. */
async function basePublishedRevision(tx: SqlRunner, baseLessonId: string): Promise<number | null> {
  const [row] = await rows<{ revision: number | null }>(tx, sql`
    SELECT max(revision)::int AS revision FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${baseLessonId}::uuid AND state = 'PUBLISHED'
  `);
  return row?.revision === null || row?.revision === undefined ? null : Number(row.revision);
}

/**
 * Start revision n+1 of a live lesson from what is live. For a base lesson, the module, skill and
 * prerequisites are read from its current lesson version (so a pilot lesson starts complete); for
 * a variant, from its published body, with the base revision it renders refreshed.
 */
export async function startLessonRevision(db: TransactionalRunner, input: {
  readonly lessonId: string; readonly reasonCode: string; readonly actor: LessonActor;
}): Promise<{ readonly revisionId: string; readonly revision: number }> {
  try {
    return await db.transaction(async (tx) => {
      await lockLesson(tx, input.lessonId);
      const [exists] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${input.lessonId}::uuid`);
      if (!Number(exists?.n)) throw new LessonEditorError('LESSON_NOT_FOUND');
      if (await openRevisionOf(tx, input.lessonId)) throw new LessonEditorError('LESSON_OPEN_REVISION_EXISTS');
      const [published] = await rows<{ body: unknown; revision: number }>(tx, sql`
        SELECT body, revision FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${input.lessonId}::uuid AND state = 'PUBLISHED'
        ORDER BY revision DESC LIMIT 1
      `);
      if (!published) throw new LessonEditorError('LESSON_NOT_LIVE');
      const identity = readLessonIdentity(published.body);
      let fields = readLessonDraftFields(published.body);
      let startIdentity = identity;
      if (identity.variantOf === null) {
        const current = await currentVersionOf(tx, identity.stableKey);
        if (!current) throw new LessonEditorError('LESSON_NOT_LIVE');
        const [version] = await rows<{ title: string; body: unknown }>(tx, sql`SELECT title, body FROM lesson_versions WHERE id = ${current.id}::uuid`);
        const text = readLessonDraftFields({ body: version?.body });
        fields = {
          ...fields,
          title: fields.title || version?.title || '',
          summary: fields.summary || text.summary,
          practice: fields.practice ?? text.practice,
          moduleKey: current.module_key,
          topicId: current.topic_id,
          prerequisites: [...((await liveGraph(tx)).get(identity.stableKey) ?? [])],
        };
      } else {
        startIdentity = { ...identity, basedOnRevision: await basePublishedRevision(tx, identity.variantOf) };
      }
      const [next] = await rows<{ revision: number }>(tx, sql`
        SELECT COALESCE(max(revision), 0)::int + 1 AS revision FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${input.lessonId}::uuid
      `);
      const revision = Number(next!.revision);
      const body = composeLessonBody(published.body, startIdentity, fields);
      const revisionId = randomUUID();
      await insertRevision(tx, { revisionId, lessonId: input.lessonId, revision, actor: input.actor, body });
      await audit(tx, {
        actor: input.actor, action: 'operations.content.lesson_revision_started', revisionId,
        context: { lessonId: input.lessonId, stableKey: identity.stableKey, variant: lessonVariantLabel(identity.variant), revision, reasonCode: input.reasonCode },
      });
      return { revisionId, revision };
    });
  } catch (error) {
    rethrow(error);
  }
}

interface LockedRevision { id: string; entity_id: string; revision: number; author_user_id: string; state: LessonRevisionState; body: unknown; content_hash: string }

async function lockRevision(tx: SqlRunner, revisionId: string): Promise<LockedRevision & { identity: LessonIdentity }> {
  const [found] = await rows<{ entity_id: string }>(tx, sql`SELECT entity_id FROM content_revisions WHERE id = ${revisionId}::uuid AND entity_type = 'LESSON'`);
  if (!found) throw new LessonEditorError('LESSON_REVISION_NOT_FOUND');
  // Lesson first, then revision: every writer of a lesson takes the locks in this order.
  await lockLesson(tx, found.entity_id);
  const [revision] = await rows<LockedRevision>(tx, sql`
    SELECT id, entity_id, revision, author_user_id, state, body, content_hash FROM content_revisions WHERE id = ${revisionId}::uuid FOR UPDATE
  `);
  return { ...revision!, identity: readLessonIdentity(revision!.body) };
}

/** What the editor sends: the fields, with the skill as a topic key. Variants send no structure. */
export type LessonDraftInput = Omit<LessonDraftFields, 'topicId'> & { readonly topicKey: string | null };

/**
 * Replace an editable revision's fields. Anyone with CONTENT_EDIT may edit; whoever saves becomes
 * a contributor (their audit row is the record) and so never reviews or publishes it.
 */
export async function saveLessonDraft(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly draft: LessonDraftInput; readonly actor: LessonActor;
}): Promise<{ readonly lessonId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      if (revision.state !== 'DRAFT' && revision.state !== 'CHANGES_REQUESTED') throw new LessonEditorError('LESSON_REVISION_NOT_EDITABLE');
      const { topicKey, ...rest } = input.draft;
      const isVariant = revision.identity.variantOf !== null;
      const topic = !isVariant && topicKey ? await topicByKey(tx, topicKey) : null;
      const fields: LessonDraftFields = { ...rest, topicId: topic ? topic.id : null };
      // A variant renders the base as it is published now.
      const identity: LessonIdentity = isVariant
        ? { ...revision.identity, basedOnRevision: await basePublishedRevision(tx, revision.identity.variantOf!) }
        : revision.identity;
      const problems = [...validateLessonDraft(identity, fields, false), ...await referenceProblems(tx, revision.entity_id, identity, fields)];
      if (problems.length) throw new LessonEditorError('LESSON_INVALID', problems);
      const body = composeLessonBody(revision.body, identity, fields);
      await tx.execute(sql`
        UPDATE content_revisions SET body = ${JSON.stringify(body)}::jsonb, content_hash = ${contentHashOf(body)} WHERE id = ${input.revisionId}::uuid
      `);
      await audit(tx, {
        actor: input.actor, action: lessonDraftSavedAction, revisionId: input.revisionId,
        context: {
          lessonId: revision.entity_id, stableKey: identity.stableKey, variant: lessonVariantLabel(identity.variant), revision: Number(revision.revision),
          ...(topic ? { topicId: topic.id } : {}), prerequisiteCount: fields.prerequisites.length, reasonCode: 'DRAFT_EDIT',
        },
      });
      return { lessonId: revision.entity_id };
    });
  } catch (error) {
    rethrow(error);
  }
}

const reviewActionFor: Readonly<Record<string, 'SUBMIT' | 'REQUEST_CHANGES' | 'APPROVE'>> = {
  IN_REVIEW: 'SUBMIT', CHANGES_REQUESTED: 'REQUEST_CHANGES', APPROVED: 'APPROVE',
};

/** Both lifecycles must allow a move: 0004's and the learner-content lifecycle's (Decision 1). */
function assertBothLifecycles(from: LessonRevisionState, to: LessonRevisionState, authorUserId: string, actorUserId: string, releaseManifestId?: string): void {
  try {
    assertContentTransition({ from, to, authorUserId, actorUserId, ...(releaseManifestId ? { releaseManifestId } : {}) });
    assertLearnerContentReviewTransition(from, to);
  } catch {
    throw new LessonEditorError('LESSON_TRANSITION_NOT_ALLOWED');
  }
}

async function moveRevision(tx: SqlRunner, input: { readonly revisionId: string; readonly from: string; readonly to: string; readonly action: string; readonly reasonCode: string; readonly actor: LessonActor }): Promise<void> {
  await tx.execute(sql`
    INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
    VALUES (${randomUUID()}::uuid, ${input.revisionId}::uuid, ${input.actor.userId}::uuid, ${input.action}, ${input.from}, ${input.to}, ${input.reasonCode}, ${input.actor.correlationId})
  `);
  await tx.execute(sql`UPDATE content_revisions SET state = ${input.to} WHERE id = ${input.revisionId}::uuid`);
}

/**
 * Move a revision: submit (and resubmit), request changes, or approve. `refuse` is the pure rule,
 * evaluated against the locked row and its contributors. Approving is also the rights review.
 */
export async function transitionLessonRevision(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'; readonly reasonCode: string;
  readonly rightsReasonCode: string | null; readonly note: string | null; readonly actor: LessonActor;
  /** ENG-16: who checked the language of a non-English variant; required to approve one. */
  readonly languageReviewCode?: string | null;
  readonly refuse: (current: {
    readonly from: LessonRevisionState; readonly contributorUserIds: readonly string[]; readonly language: string;
  }) => LessonEditorRefusal | null;
}): Promise<{ readonly lessonId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      const contributors = await contributorsOf(tx, revision.id, revision.author_user_id);
      const refusal = input.refuse({ from: revision.state, contributorUserIds: contributors, language: revision.identity.variant.language });
      if (refusal) throw new LessonEditorRefused(refusal);
      assertBothLifecycles(revision.state, input.toState, revision.author_user_id, input.actor.userId);
      const fields = readLessonDraftFields(revision.body);
      if (input.toState === 'IN_REVIEW') {
        const problems = [...validateLessonDraft(revision.identity, fields, true), ...await referenceProblems(tx, revision.entity_id, revision.identity, fields)];
        if (problems.length) throw new LessonEditorError('LESSON_INVALID', problems);
      }
      await moveRevision(tx, { revisionId: revision.id, from: revision.state, to: input.toState, action: reviewActionFor[input.toState]!, reasonCode: input.reasonCode, actor: input.actor });
      if (input.toState === 'APPROVED') {
        await recordRightsReview(tx, {
          revision, fields, reviewReasonCode: input.reasonCode, rightsReasonCode: input.rightsReasonCode!, languageReviewCode: input.languageReviewCode ?? null, actor: input.actor,
        });
      }
      await audit(tx, {
        actor: input.actor, action: lessonTransitionedAction, revisionId: revision.id,
        context: {
          lessonId: revision.entity_id, stableKey: revision.identity.stableKey, variant: lessonVariantLabel(revision.identity.variant),
          revision: Number(revision.revision), fromState: revision.state, toState: input.toState, reasonCode: input.reasonCode,
          ...(input.rightsReasonCode ? { rightsReasonCode: input.rightsReasonCode } : {}), ...(input.note ? { note: input.note } : {}),
          ...(input.languageReviewCode ? { languageReviewCode: input.languageReviewCode } : {}),
        },
      });
      await stateChanged(tx, input.actor, revision.id, revision.entity_id, revision.state, input.toState);
      return { lessonId: revision.entity_id };
    });
  } catch (error) {
    rethrow(error);
  }
}

function sourcePath(identity: LessonIdentity, revision: number): string {
  const variant = identity.variantOf === null ? '' : `/${lessonVariantLabel(identity.variant)}`;
  return `console://lesson-editor/${identity.stableKey}${variant}/r${revision}`;
}

/**
 * The reviewer's rights review, in the approval's transaction (OPS-09a Decision 5): one source
 * package per reviewed revision and a release-eligible source record in its final state, with the
 * rights review, the SME review and the provenance link that point at it.
 */
async function recordRightsReview(tx: SqlRunner, input: {
  readonly revision: LockedRevision & { identity: LessonIdentity }; readonly fields: LessonDraftFields;
  readonly reviewReasonCode: string; readonly rightsReasonCode: string; readonly languageReviewCode: string | null; readonly actor: LessonActor;
}): Promise<void> {
  const licence = input.fields.licenceLabel;
  if (!licence) throw new LessonEditorError('LESSON_INVALID', ['LESSON_LICENCE_MISSING']);
  const attributionRequired = LESSON_LICENCES_REQUIRING_ATTRIBUTION.includes(licence);
  const identity = `ops-lesson-editor:${input.revision.id}`;
  // Console-authored content has no repository commit; the SHA-1 of the reviewed body is its content address.
  const contentAddress = createHash('sha1').update(stableStringify(input.revision.body), 'utf8').digest('hex');
  const path = sourcePath(input.revision.identity, Number(input.revision.revision));
  const runId = randomUUID();
  const packageId = randomUUID();
  const sourceRecordId = randomUUID();
  await tx.execute(sql`
    INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, record_counts, completed_at)
    VALUES (${runId}::uuid, ${identity}, 'one-operations-console', ${contentAddress}, ${input.revision.content_hash}, 'lesson-editor-v1', 'STAGED',
            ${input.actor.userId}::uuid, ${JSON.stringify({ lessons: 1 })}::jsonb, now())
  `);
  await tx.execute(sql`
    INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES (${packageId}::uuid, ${runId}::uuid, ${identity}, 'one-operations-console', ${contentAddress}, ${input.revision.content_hash}, 'lesson-editor-v1',
            ${JSON.stringify([path])}::jsonb, ${JSON.stringify({ [path]: input.revision.content_hash })}::jsonb,
            ${JSON.stringify({ kind: 'LESSON_EDITOR_REVISION', stableKey: input.revision.identity.stableKey, variant: lessonVariantLabel(input.revision.identity.variant), revision: Number(input.revision.revision) })}::jsonb)
  `);
  await tx.execute(sql`
    INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, source_metadata, license_label,
      attribution_required, rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, rejection_reason_codes, release_eligible)
    VALUES (${sourceRecordId}::uuid, ${packageId}::uuid, 'LESSON_EDITOR_REVISION', ${input.revision.id}, ${path}, ${input.revision.content_hash},
            ${JSON.stringify({
              attribution: input.fields.attribution, language: input.revision.identity.variant.language,
              ...(input.languageReviewCode ? { languageReview: input.languageReviewCode } : {}),
            })}::jsonb, ${licence}, ${attributionRequired},
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
    VALUES (${randomUUID()}::uuid, ${sourceRecordId}::uuid, 'LESSON', ${input.revision.entity_id}::uuid, ${Number(input.revision.revision)},
            ${input.revision.content_hash}, 'lesson-editor-v1')
  `);
  await audit(tx, {
    actor: input.actor, action: 'operations.content.lesson_rights_reviewed', revisionId: input.revision.id,
    context: {
      lessonId: input.revision.entity_id, stableKey: input.revision.identity.stableKey, variant: lessonVariantLabel(input.revision.identity.variant),
      licenceLabel: licence, attributionRequired, reasonCode: input.rightsReasonCode,
    },
  });
}

/** What the approvals endpoint needs to file, and the publish endpoint to execute, a publish approval. */
export async function loadLessonRevisionForPublish(runner: SqlRunner, revisionId: string): Promise<{
  readonly id: string; readonly lessonId: string; readonly state: LessonRevisionState; readonly contentHash: string;
  readonly contributorUserIds: readonly string[]; readonly approverUserId: string | null; readonly needsApproval: boolean;
} | null> {
  const [row] = await rows<{ id: string; entity_id: string; state: LessonRevisionState; content_hash: string; author_user_id: string; body: unknown }>(runner, sql`
    SELECT id, entity_id, state, content_hash, author_user_id, body FROM content_revisions WHERE id = ${revisionId}::uuid AND entity_type = 'LESSON'
  `);
  if (!row) return null;
  return {
    id: row.id, lessonId: row.entity_id, state: row.state, contentHash: row.content_hash,
    contributorUserIds: await contributorsOf(runner, row.id, row.author_user_id),
    approverUserId: await approverOf(runner, row.id),
    needsApproval: await needsApprovalFor(runner, readLessonIdentity(row.body), readLessonDraftFields(row.body)),
  };
}

/**
 * Publish an approved revision, in one transaction: check who publishes (never a contributor,
 * never the approver), that what it points at is live and the lesson graph stays a DAG, and
 * whether an approval is needed (and consume it); then a release manifest approved by the
 * revision's reviewer and published by the actor, and the revision PUBLISHED. A base lesson also
 * supersedes its previous lesson version and writes the new one with its prerequisite rows; a
 * variant writes nothing else. If anything fails, all of it rolls back and the approval stays usable.
 */
export async function publishLessonRevision(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly reasonCode: string; readonly approvalId: string | null;
  /** The approval payload the endpoint rebuilds from this request and the stored content hash. */
  readonly approvalPayload: (contentHash: string) => Record<string, unknown>;
  readonly actor: LessonActor;
  readonly refuse: (current: { readonly contributorUserIds: readonly string[]; readonly approverUserId: string | null }) => LessonEditorRefusal | null;
}): Promise<{ readonly lessonId: string; readonly lessonVersionId: string | null; readonly releaseManifestId: string; readonly approval: ConsumedApproval | null }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      const contributors = await contributorsOf(tx, revision.id, revision.author_user_id);
      const approvedBy = await approverOf(tx, revision.id);
      const refusal = input.refuse({ contributorUserIds: contributors, approverUserId: approvedBy });
      if (refusal) throw new LessonEditorRefused(refusal);
      if (revision.state !== 'APPROVED' || !approvedBy) throw new LessonEditorError('LESSON_REVISION_NOT_APPROVED');
      const identity = revision.identity;
      const fields = readLessonDraftFields(revision.body);
      const isVariant = identity.variantOf !== null;

      // Checked before any approval is consumed, so a refused publish leaves it usable.
      let moduleId: string | null = null;
      if (isVariant) {
        const [base] = await rows<{ body: unknown }>(tx, sql`
          SELECT body FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${identity.variantOf}::uuid AND state = 'PUBLISHED'
          ORDER BY revision DESC LIMIT 1
        `);
        if (!base || !(await currentVersionOf(tx, readLessonIdentity(base.body).stableKey))) throw new LessonEditorError('LESSON_BASE_NOT_LIVE');
      } else {
        const topic = await topicById(tx, fields.topicId);
        if (!topic || topic.status !== 'LIVE') throw new LessonEditorError('LESSON_TOPIC_NOT_LIVE');
        moduleId = fields.moduleKey ? await moduleIdByKey(tx, fields.moduleKey) : null;
        if (!moduleId) throw new LessonEditorError('LESSON_MODULE_UNKNOWN');
        const live = await liveGraph(tx);
        const notLive = fields.prerequisites.filter((key) => !live.has(key));
        if (notLive.length) throw new LessonEditorError('LESSON_PREREQUISITE_NOT_LIVE', notLive.map((key) => `LESSON_PREREQUISITE_NOT_LIVE:${key}`));
        const cycle = lessonGraphProblems(live, identity.stableKey, fields.prerequisites);
        if (cycle.length) throw new LessonEditorError('LESSON_INVALID', cycle);
      }
      const [source] = await rows<{ id: string }>(tx, sql`
        SELECT id FROM source_records
        WHERE source_entity_type = 'LESSON_EDITOR_REVISION' AND source_record_id = ${revision.id} AND release_eligible AND source_hash = ${revision.content_hash}
        LIMIT 1
      `);
      if (!source) throw new LessonEditorError('LESSON_RIGHTS_NOT_REVIEWED');

      const facts = await approvalFactsFor(tx, identity, fields);
      const needsApproval = lessonPublishAltersReadinessInputs(facts);
      if (needsApproval && !input.approvalId) throw new LessonEditorRefused('APPROVAL_REQUIRED');
      const approval = input.approvalId
        ? await consumeOperationApproval(tx, {
          approvalId: input.approvalId, actionKey: 'CONTENT_LESSON_PUBLISH', payload: input.approvalPayload(revision.content_hash),
          executorUserId: input.actor.userId, correlationId: input.actor.correlationId,
        })
        : null;

      const manifestId = randomUUID();
      const releaseName = isVariant ? `Lesson variant: ${identity.stableKey} ${lessonVariantLabel(identity.variant)}` : `Lesson: ${identity.stableKey}`;
      const releaseVersion = Number(revision.revision);
      const manifestHash = sha256Hex(stableStringify({ name: releaseName, version: releaseVersion, items: [{ id: revision.id, hash: revision.content_hash }] }));
      assertBothLifecycles('APPROVED', 'PUBLISHED', revision.author_user_id, input.actor.userId, manifestId);
      await tx.execute(sql`
        INSERT INTO release_manifests (id, name, version, manifest_hash, status)
        VALUES (${manifestId}::uuid, ${releaseName}, ${releaseVersion}, ${manifestHash}, 'DRAFT')
      `);
      await tx.execute(sql`
        INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash)
        VALUES (${manifestId}::uuid, ${revision.id}::uuid, ${source.id}::uuid, ${revision.content_hash})
      `);
      await tx.execute(sql`
        UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = ${approvedBy}::uuid, approved_at = now() WHERE id = ${manifestId}::uuid
      `);
      await tx.execute(sql`
        UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = ${input.actor.userId}::uuid, published_at = now() WHERE id = ${manifestId}::uuid
      `);
      await tx.execute(sql`
        UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = ${manifestId}::uuid, published_at = now() WHERE id = ${revision.id}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
        VALUES (${randomUUID()}::uuid, ${revision.id}::uuid, ${input.actor.userId}::uuid, 'PUBLISH', 'APPROVED', 'PUBLISHED', ${input.reasonCode}, ${input.actor.correlationId})
      `);

      let lessonVersionId: string | null = null;
      let supersededCount = 0;
      if (!isVariant) {
        // One current version per lesson in the catalogue (0065); the old row stays for the progress that points at it.
        const superseded = await rows<{ id: string }>(tx, sql`
          UPDATE lesson_versions SET superseded_at = now() WHERE stable_key = ${identity.stableKey} AND superseded_at IS NULL RETURNING id
        `);
        supersededCount = superseded.length;
        lessonVersionId = randomUUID();
        await tx.execute(sql`
          INSERT INTO lesson_versions (id, module_id, stable_key, version, title, body, topic_id, content_revision_id, published_at)
          VALUES (${lessonVersionId}::uuid, ${moduleId}::uuid, ${identity.stableKey}, ${releaseVersion}, ${fields.title},
                  ${JSON.stringify(publishedLessonBody(fields))}::jsonb, ${fields.topicId}::uuid, ${revision.id}::uuid, now())
        `);
        for (const key of fields.prerequisites) {
          await tx.execute(sql`
            INSERT INTO lesson_prerequisites (lesson_version_id, prerequisite_lesson_version_id)
            SELECT ${lessonVersionId}::uuid, v.id FROM lesson_versions v WHERE v.stable_key = ${key} AND v.superseded_at IS NULL
          `);
        }
      }
      await audit(tx, {
        actor: input.actor, action: 'operations.content.lesson_published', revisionId: revision.id,
        context: {
          lessonId: revision.entity_id, stableKey: identity.stableKey, variant: lessonVariantLabel(identity.variant), kind: isVariant ? 'VARIANT' : 'BASE',
          revision: releaseVersion, lessonVersionId, reasonCode: input.reasonCode, releaseManifestId: manifestId, supersededCount,
          approvalRequired: needsApproval, ...facts,
          ...(approval ? { approvalId: approval.approvalId, requestedByUserId: approval.requestedByUserId, approvedByUserId: approval.approvedByUserId, mode: approval.mode } : {}),
        },
      });
      await stateChanged(tx, input.actor, revision.id, revision.entity_id, 'APPROVED', 'PUBLISHED');
      await outbox(tx, {
        actor: input.actor, revisionId: revision.id, eventType: 'lesson_editor.lesson_published',
        payload: {
          revisionId: revision.id, lessonId: revision.entity_id, ...(lessonVersionId ? { lessonVersionId } : {}), releaseManifestId: manifestId,
          kind: isVariant ? 'VARIANT' : 'BASE', language: identity.variant.language,
        },
      });
      return { lessonId: revision.entity_id, lessonVersionId, releaseManifestId: manifestId, approval };
    });
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Archive a live lesson or variant (docs/architecture/content-archive-design.md): refused while a
 * revision is open, and for a base lesson while a variant of it is live or a current lesson needs
 * it first. Otherwise every published revision becomes ARCHIVED (with its ARCHIVE review action),
 * so no older one becomes "the latest published" a variant reader would serve; for a base lesson
 * the current lesson version is superseded, the column the catalogue, the learning steps and
 * faculty actions read. Progress and evidence already pointing at it stay valid; nothing is
 * deleted, and the lesson cannot be revised again.
 */
export async function archiveLesson(db: TransactionalRunner, input: {
  readonly lessonId: string; readonly reasonCode: string; readonly actor: LessonActor;
}): Promise<{ readonly lessonId: string; readonly archivedRevisions: readonly number[] }> {
  try {
    return await db.transaction(async (tx) => {
      await lockLesson(tx, input.lessonId);
      const [exists] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${input.lessonId}::uuid`);
      if (!Number(exists?.n)) throw new LessonEditorError('LESSON_NOT_FOUND');
      const [published] = await rows<{ id: string; body: unknown }>(tx, sql`
        SELECT id, body FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${input.lessonId}::uuid AND state = 'PUBLISHED'
        ORDER BY revision DESC LIMIT 1
      `);
      if (!published) throw new LessonEditorError('LESSON_NOT_LIVE');
      const identity = readLessonIdentity(published.body);
      const base = identity.variantOf === null;
      const [facts] = base
        ? await rows<{ variants: number; dependents: number }>(tx, sql`
          SELECT
            (SELECT count(DISTINCT c.entity_id)::int FROM content_revisions c
              WHERE c.entity_type = 'LESSON' AND c.state = 'PUBLISHED' AND c.body ->> 'variantOf' = ${input.lessonId}) AS variants,
            (SELECT count(DISTINCT v.stable_key)::int FROM lesson_versions v
              JOIN lesson_prerequisites p ON p.lesson_version_id = v.id
              JOIN lesson_versions pv ON pv.id = p.prerequisite_lesson_version_id
              WHERE v.superseded_at IS NULL AND pv.stable_key = ${identity.stableKey} AND v.stable_key <> ${identity.stableKey}) AS dependents
        `)
        : [{ variants: 0, dependents: 0 }];
      const blockers = lessonArchiveBlockers({
        openRevision: (await openRevisionOf(tx, input.lessonId)) !== null,
        liveVariantCount: Number(facts?.variants ?? 0),
        liveDependentLessonCount: Number(facts?.dependents ?? 0),
      });
      if (blockers.length) throw new LessonEditorError('LESSON_ARCHIVE_BLOCKED', blockers);
      const archived = await archivePublishedRevisions(tx, {
        entityType: 'LESSON', entityId: input.lessonId, reasonCode: input.reasonCode, actorUserId: input.actor.userId, correlationId: input.actor.correlationId,
      });
      // A base lesson leaves the catalogue at once: every read takes superseded_at IS NULL (the 0065
      // guard allows this one change). A variant writes no lesson version.
      const withdrawn = base
        ? await rows<{ id: string }>(tx, sql`
          UPDATE lesson_versions SET superseded_at = now() WHERE stable_key = ${identity.stableKey} AND superseded_at IS NULL RETURNING id
        `)
        : [];
      await audit(tx, {
        actor: input.actor, action: 'operations.content.lesson_archived', revisionId: published.id,
        context: {
          lessonId: input.lessonId, stableKey: identity.stableKey, kind: base ? 'BASE' : 'VARIANT', variant: lessonVariantLabel(identity.variant),
          reasonCode: input.reasonCode, archivedRevisions: archived.map((entry) => entry.revision), lessonVersionIds: withdrawn.map((row) => row.id),
        },
      });
      for (const revision of archived) await stateChanged(tx, input.actor, revision.id, input.lessonId, 'PUBLISHED', 'ARCHIVED');
      return { lessonId: input.lessonId, archivedRevisions: archived.map((entry) => entry.revision) };
    });
  } catch (error) {
    rethrow(error);
  }
}
