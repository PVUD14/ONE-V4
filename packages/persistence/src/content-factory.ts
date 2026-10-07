/**
 * The content factory's requests and reads (ENG-23, migration 0106).
 *
 * Why this exists: operations asks ONE's AI for a lesson, a language variant or a practice question
 * for a skill, or for an independent check of a question's answer key. A request is a row in
 * `ai_content_drafts` plus an audit row and an outbox event, written in one transaction by the API;
 * the content factory worker (`content-factory-worker.ts`, never a request handler) runs it through
 * ONE AI Orchestration and lands the result in the existing editors. This module never calls a
 * model and never imports the orchestrator: it reads the feature's policy row (switch, cap, kill
 * switch) only to refuse a request that would certainly be refused later.
 *
 * Design: docs/architecture/content-factory-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  contentFactoryAuthorNoteMax,
  contentFactoryFeatureKeys,
  contentFactoryMaxInFlight,
  type ContentFactoryKind,
} from '@planthepath/authorization/src/index.js';
import { contentAnswerCheckPromptV1, contentItemDraftPromptV1, contentLessonDraftPromptV2, type PromptVersion } from '@planthepath/ai-orchestration/src/index.js';
import { matchesAny, personalDataPatterns } from '@planthepath/ai-evaluation/src/checks.js';
import {
  LESSON_LANGUAGES,
  LESSON_LEVELS,
  LESSON_STABLE_KEY_PATTERN,
  LESSON_STYLES,
  QUESTION_DIFFICULTIES,
  readLessonDraftFields,
  readLessonIdentity,
  readQuestionDraftFields,
  sameLessonVariant,
  type LessonVariantMetadata,
} from '@planthepath/career-readiness';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}
export interface TransactionalRunner extends SqlRunner {
  transaction<T>(work: (tx: TransactionalRunner) => Promise<T>): Promise<T>;
}

async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as { rows: T[] }).rows;
}
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

export type ContentDraftKind = ContentFactoryKind;
export type ContentDraftState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'REFUSED' | 'REJECTED' | 'FAILED';
export const contentDraftOpenStates: readonly ContentDraftState[] = ['QUEUED', 'RUNNING'];

/** The prompt each kind runs. The policy row must name exactly this prompt, or the request is refused. */
export const contentDraftPrompts: Readonly<Record<ContentDraftKind, PromptVersion>> = {
  LESSON: contentLessonDraftPromptV2,
  LESSON_VARIANT: contentLessonDraftPromptV2,
  QUESTION: contentItemDraftPromptV1,
  ANSWER_CHECK: contentAnswerCheckPromptV1,
};

export type ContentFactoryErrorCode =
  | 'AI_FEATURE_NOT_REGISTERED'
  | 'AI_KILL_SWITCH_ENGAGED'
  | 'AI_FEATURE_DISABLED'
  | 'AI_CAP_REACHED'
  | 'AI_DRAFTS_IN_FLIGHT'
  | 'AI_PROMPT_NOT_SUPPORTED'
  | 'AI_DRAFT_INVALID'
  | 'AI_NOTE_PERSONAL_DATA'
  | 'AI_DRAFT_TOPIC_UNKNOWN'
  | 'AI_DRAFT_KEY_EXISTS'
  | 'AI_DRAFT_BASE_NOT_FOUND'
  | 'AI_DRAFT_BASE_NOT_LIVE'
  | 'AI_DRAFT_VARIANT_EXISTS'
  | 'AI_DRAFT_QUESTION_NOT_FOUND'
  | 'AI_DRAFT_QUESTION_NOT_CHECKABLE'
  | 'AI_DRAFT_NOT_FOUND';

export class ContentFactoryError extends Error {
  constructor(readonly code: ContentFactoryErrorCode, readonly problems: readonly string[] = []) {
    super(code);
    this.name = 'ContentFactoryError';
  }
}

export interface ContentFactoryActor {
  readonly userId: string;
  readonly correlationId: string;
  readonly breakGlass: boolean;
}

export interface ContentDraftRequestInput {
  readonly kind: ContentDraftKind;
  /** LESSON, QUESTION: the skill's stable key. */
  readonly topicKey?: string | null;
  /** LESSON_VARIANT: the live base lesson. */
  readonly baseLessonId?: string | null;
  /** ANSWER_CHECK: the question revision under review. */
  readonly questionRevisionId?: string | null;
  /** LESSON, QUESTION: the new lesson's or question's key. */
  readonly stableKey?: string | null;
  /** LESSON, LESSON_VARIANT: the title. */
  readonly title?: string | null;
  /** LESSON_VARIANT: the variant's language (LESSON and QUESTION are English). */
  readonly language?: string | null;
  /** Lessons: FOUNDATION / STANDARD / ADVANCED. Questions: the difficulty band. */
  readonly level?: string | null;
  /** Lessons: the style. */
  readonly style?: string | null;
  readonly authorNote?: string | null;
  readonly reasonCode: string;
  readonly actor: ContentFactoryActor;
}

// ---------------------------------------------------------------------------
// Policy (read only: the switch, the cap and the kill switch, never a call)
// ---------------------------------------------------------------------------

interface PolicyRow {
  feature_key: string; enabled: boolean; cap: number; cap_window: 'DAY' | 'MONTH'; model: string;
  prompt_key: string | null; prompt_version: number | null; kill_switch: boolean; used_in_window: number; open_jobs: number;
}

async function policyFor(runner: SqlRunner, featureKey: string): Promise<PolicyRow | null> {
  const [row] = await rows<PolicyRow>(runner, sql`
    SELECT p.feature_key, p.enabled, p.cap, p.cap_window, p.model, p.prompt_key, p.prompt_version,
      COALESCE((SELECT f.enabled FROM feature_flags f WHERE f.key = 'ai.global-kill-switch'), false) AS kill_switch,
      (SELECT count(*)::int FROM ai_generations g WHERE g.feature_key = p.feature_key AND g.outcome = 'SUCCEEDED'
         AND g.occurred_at >= date_trunc(CASE p.cap_window WHEN 'DAY' THEN 'day' ELSE 'month' END, now())) AS used_in_window,
      (SELECT count(*)::int FROM ai_content_drafts d WHERE d.feature_key = p.feature_key AND d.state IN ('QUEUED','RUNNING')) AS open_jobs
    FROM ai_feature_policies p WHERE p.feature_key = ${featureKey}
  `);
  return row ? { ...row, cap: Number(row.cap), used_in_window: Number(row.used_in_window), open_jobs: Number(row.open_jobs) } : null;
}

export interface ContentFactoryFeatureStatus {
  readonly featureKey: string;
  readonly kinds: readonly ContentDraftKind[];
  /** False until `ai:register-features` has inserted the policy row. */
  readonly registered: boolean;
  /** The feature's own switch, as stored. */
  readonly switchedOn: boolean;
  /** Whether a request would be accepted now: registered, switched on, kill switch released, prompt supported. */
  readonly available: boolean;
  readonly cap: number | null;
  readonly window: 'DAY' | 'MONTH' | null;
  readonly usedInWindow: number | null;
  readonly openJobs: number | null;
  readonly model: string | null;
  readonly prompt: { readonly key: string; readonly version: number } | null;
}

export interface ContentFactoryStatus {
  readonly killSwitchEngaged: boolean;
  readonly features: readonly ContentFactoryFeatureStatus[];
  readonly maxInFlight: number;
  /** The viewer's own jobs still queued or running. */
  readonly viewerOpenJobs: number;
}

const featureKinds = (featureKey: string): ContentDraftKind[] =>
  (Object.entries(contentFactoryFeatureKeys) as [ContentDraftKind, string][]).filter(([, key]) => key === featureKey).map(([kind]) => kind);

const promptSupported = (row: PolicyRow, kind: ContentDraftKind): boolean =>
  row.prompt_key === contentDraftPrompts[kind].key && Number(row.prompt_version) === contentDraftPrompts[kind].version;

/** The factory's state for the editors' AI drafts card. Reads policy rows; never calls a model. */
export async function loadContentFactoryStatus(runner: SqlRunner, viewerUserId: string): Promise<ContentFactoryStatus> {
  const [kill] = await rows<{ engaged: boolean }>(runner, sql`
    SELECT COALESCE((SELECT enabled FROM feature_flags WHERE key = 'ai.global-kill-switch'), false) AS engaged`);
  const features: ContentFactoryFeatureStatus[] = [];
  for (const featureKey of [...new Set(Object.values(contentFactoryFeatureKeys))]) {
    const kinds = featureKinds(featureKey);
    const row = await policyFor(runner, featureKey);
    features.push(row ? {
      featureKey, kinds, registered: true, switchedOn: row.enabled,
      available: row.enabled && !row.kill_switch && promptSupported(row, kinds[0]!),
      cap: row.cap, window: row.cap_window, usedInWindow: row.used_in_window, openJobs: row.open_jobs, model: row.model,
      prompt: row.prompt_key && row.prompt_version ? { key: row.prompt_key, version: Number(row.prompt_version) } : null,
    } : {
      featureKey, kinds, registered: false, switchedOn: false, available: false,
      cap: null, window: null, usedInWindow: null, openJobs: null, model: null, prompt: null,
    });
  }
  const [mine] = await rows<{ n: number }>(runner, sql`
    SELECT count(*)::int AS n FROM ai_content_drafts WHERE requested_by_user_id = ${viewerUserId}::uuid AND state IN ('QUEUED','RUNNING')`);
  return { killSwitchEngaged: Boolean(kill?.engaged), features, maxInFlight: contentFactoryMaxInFlight, viewerOpenJobs: Number(mine?.n ?? 0) };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface TopicRow { id: string; stable_key: string; name: string; active: boolean; pointer_state: string }

async function topicByKey(runner: SqlRunner, topicKey: string): Promise<TopicRow | null> {
  const [row] = await rows<TopicRow>(runner, sql`
    SELECT n.id, n.stable_key, n.name, n.active, p.state AS pointer_state
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id
    WHERE n.kind = 'TOPIC' AND n.stable_key = ${topicKey} ORDER BY n.version DESC LIMIT 1
  `);
  if (!row) return null;
  // Live, or pending (its revision still on its way); a retired skill takes no new content.
  const pending = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED'].includes(row.pointer_state);
  return row.active || pending ? row : null;
}

async function lessonKeyInUse(runner: SqlRunner, stableKey: string): Promise<boolean> {
  const [row] = await rows<{ used: boolean }>(runner, sql`
    SELECT EXISTS (SELECT 1 FROM content_revisions WHERE entity_type = 'LESSON' AND body ->> 'stableKey' = ${stableKey}
                     AND COALESCE(body ->> 'variantOf', '') = '')
        OR EXISTS (SELECT 1 FROM lesson_versions WHERE stable_key = ${stableKey})
        OR EXISTS (SELECT 1 FROM ai_content_drafts WHERE kind = 'LESSON' AND stable_key = ${stableKey} AND state IN ('QUEUED','RUNNING')) AS used
  `);
  return Boolean(row?.used);
}

async function questionKeyInUse(runner: SqlRunner, stableKey: string): Promise<boolean> {
  const [row] = await rows<{ used: boolean }>(runner, sql`
    SELECT EXISTS (SELECT 1 FROM content_revisions WHERE entity_type = 'QUESTION' AND body ->> 'stableKey' = ${stableKey})
        OR EXISTS (SELECT 1 FROM question_versions WHERE stable_key = ${stableKey})
        OR EXISTS (SELECT 1 FROM ai_content_drafts WHERE kind = 'QUESTION' AND stable_key = ${stableKey} AND state IN ('QUEUED','RUNNING')) AS used
  `);
  return Boolean(row?.used);
}

/** The live base lesson a variant renders: its latest published revision, if it is a base lesson with a current version. */
export async function liveBaseLesson(runner: SqlRunner, baseLessonId: string): Promise<{
  readonly body: unknown; readonly revision: number; readonly stableKey: string; readonly topicId: string | null;
} | 'NOT_FOUND' | 'NOT_LIVE'> {
  const [any] = await rows<{ body: unknown }>(runner, sql`
    SELECT body FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${baseLessonId}::uuid ORDER BY revision DESC LIMIT 1`);
  if (!any || readLessonIdentity(any.body).variantOf !== null) return 'NOT_FOUND';
  const [published] = await rows<{ body: unknown; revision: number }>(runner, sql`
    SELECT body, revision FROM content_revisions WHERE entity_type = 'LESSON' AND entity_id = ${baseLessonId}::uuid AND state = 'PUBLISHED'
    ORDER BY revision DESC LIMIT 1`);
  if (!published) return 'NOT_LIVE';
  const identity = readLessonIdentity(published.body);
  const [current] = await rows<{ topic_id: string }>(runner, sql`
    SELECT topic_id FROM lesson_versions WHERE stable_key = ${identity.stableKey} AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`);
  if (!current) return 'NOT_LIVE';
  return { body: published.body, revision: Number(published.revision), stableKey: identity.stableKey, topicId: current.topic_id ?? readLessonDraftFields(published.body).topicId };
}

async function variantTaken(runner: SqlRunner, baseLessonId: string, baseBody: unknown, variant: LessonVariantMetadata): Promise<boolean> {
  if (sameLessonVariant(readLessonIdentity(baseBody).variant, variant)) return true;
  const siblings = await rows<{ body: unknown }>(runner, sql`
    SELECT DISTINCT ON (entity_id) body FROM content_revisions
    WHERE entity_type = 'LESSON' AND body ->> 'variantOf' = ${baseLessonId} ORDER BY entity_id, revision DESC`);
  if (siblings.some((sibling) => sameLessonVariant(readLessonIdentity(sibling.body).variant, variant))) return true;
  const [pending] = await rows<{ n: number }>(runner, sql`
    SELECT count(*)::int AS n FROM ai_content_drafts
    WHERE kind = 'LESSON_VARIANT' AND base_lesson_id = ${baseLessonId}::uuid AND state IN ('QUEUED','RUNNING')
      AND language = ${variant.language} AND level = ${variant.level} AND style = ${variant.style}`);
  return Number(pending?.n ?? 0) > 0;
}

const oneOf = <T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null =>
  (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : null);

const cleanLine = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim().replace(/[ \t]+/g, ' ') : '');

/**
 * Queue one job. Refused with a typed code, writing nothing, when the feature is not registered,
 * off or stopped by the kill switch, when the cap would be reached by the work already queued,
 * when the requester has too many jobs in flight, or when the target is not draftable. The cap
 * check is serialised per feature, so two requests cannot both take the last place.
 */
export async function requestContentDraft(db: TransactionalRunner, input: ContentDraftRequestInput): Promise<{ readonly jobId: string }> {
  const kind = input.kind;
  const featureKey = contentFactoryFeatureKeys[kind];
  const prompt = contentDraftPrompts[kind];
  const note = typeof input.authorNote === 'string' && input.authorNote.trim() ? input.authorNote.trim() : null;
  if (note && note.length > contentFactoryAuthorNoteMax) throw new ContentFactoryError('AI_DRAFT_INVALID', ['AI_NOTE_TOO_LONG']);
  // The note goes to the model: no e-mail address or phone number, ever.
  if (note && matchesAny(note, personalDataPatterns)) throw new ContentFactoryError('AI_NOTE_PERSONAL_DATA');
  const jobId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'content-factory:' + featureKey}))`);
    const policy = await policyFor(tx, featureKey);
    if (!policy) throw new ContentFactoryError('AI_FEATURE_NOT_REGISTERED');
    if (policy.kill_switch) throw new ContentFactoryError('AI_KILL_SWITCH_ENGAGED');
    if (!policy.enabled) throw new ContentFactoryError('AI_FEATURE_DISABLED');
    if (!promptSupported(policy, kind)) throw new ContentFactoryError('AI_PROMPT_NOT_SUPPORTED');
    if (policy.used_in_window + policy.open_jobs >= policy.cap) throw new ContentFactoryError('AI_CAP_REACHED');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'content-factory-requester:' + input.actor.userId}))`);
    const [mine] = await rows<{ n: number }>(tx, sql`
      SELECT count(*)::int AS n FROM ai_content_drafts WHERE requested_by_user_id = ${input.actor.userId}::uuid AND state IN ('QUEUED','RUNNING')`);
    if (Number(mine?.n ?? 0) >= contentFactoryMaxInFlight) throw new ContentFactoryError('AI_DRAFTS_IN_FLIGHT');

    let topicId: string | null = null;
    let baseLessonId: string | null = null;
    let questionRevisionId: string | null = null;
    let stableKey: string | null = null;
    let title: string | null = null;
    let language = 'en';
    let level: string | null = null;
    let style: string | null = null;
    const problems: string[] = [];

    if (kind === 'LESSON' || kind === 'QUESTION') {
      const topic = input.topicKey ? await topicByKey(tx, input.topicKey) : null;
      if (!topic) throw new ContentFactoryError('AI_DRAFT_TOPIC_UNKNOWN');
      topicId = topic.id;
      stableKey = typeof input.stableKey === 'string' ? input.stableKey : '';
      if (!LESSON_STABLE_KEY_PATTERN.test(stableKey)) problems.push('AI_DRAFT_KEY_INVALID');
    }
    if (kind === 'LESSON' || kind === 'LESSON_VARIANT') {
      title = cleanLine(input.title);
      if (title.length < 1 || title.length > 200) problems.push('AI_DRAFT_TITLE_INVALID');
      level = oneOf(input.level ?? 'STANDARD', LESSON_LEVELS);
      style = oneOf(input.style ?? 'EXPLANATION', LESSON_STYLES);
      if (!level) problems.push('AI_DRAFT_LEVEL_INVALID');
      if (!style) problems.push('AI_DRAFT_STYLE_INVALID');
    }
    if (kind === 'LESSON_VARIANT') {
      const chosen = oneOf(input.language, LESSON_LANGUAGES);
      if (!chosen) problems.push('AI_DRAFT_LANGUAGE_INVALID');
      else language = chosen;
    }
    if (kind === 'QUESTION') {
      level = oneOf(input.level ?? 'INTERMEDIATE', QUESTION_DIFFICULTIES);
      if (!level) problems.push('AI_DRAFT_LEVEL_INVALID');
    }
    if (problems.length) throw new ContentFactoryError('AI_DRAFT_INVALID', problems);

    if (kind === 'LESSON' && await lessonKeyInUse(tx, stableKey!)) throw new ContentFactoryError('AI_DRAFT_KEY_EXISTS');
    if (kind === 'QUESTION' && await questionKeyInUse(tx, stableKey!)) throw new ContentFactoryError('AI_DRAFT_KEY_EXISTS');
    if (kind === 'LESSON_VARIANT') {
      if (typeof input.baseLessonId !== 'string') throw new ContentFactoryError('AI_DRAFT_BASE_NOT_FOUND');
      const base = await liveBaseLesson(tx, input.baseLessonId);
      if (base === 'NOT_FOUND') throw new ContentFactoryError('AI_DRAFT_BASE_NOT_FOUND');
      if (base === 'NOT_LIVE') throw new ContentFactoryError('AI_DRAFT_BASE_NOT_LIVE');
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'lesson-editor:' + input.baseLessonId}))`);
      if (await variantTaken(tx, input.baseLessonId, base.body, { language: language as LessonVariantMetadata['language'], level: level as LessonVariantMetadata['level'], style: style as LessonVariantMetadata['style'] })) {
        throw new ContentFactoryError('AI_DRAFT_VARIANT_EXISTS');
      }
      baseLessonId = input.baseLessonId;
    }
    if (kind === 'ANSWER_CHECK') {
      if (typeof input.questionRevisionId !== 'string') throw new ContentFactoryError('AI_DRAFT_QUESTION_NOT_FOUND');
      const [revision] = await rows<{ state: string; body: unknown }>(tx, sql`
        SELECT state, body FROM content_revisions WHERE id = ${input.questionRevisionId}::uuid AND entity_type = 'QUESTION'`);
      if (!revision) throw new ContentFactoryError('AI_DRAFT_QUESTION_NOT_FOUND');
      const fields = readQuestionDraftFields(revision.body);
      if (revision.state === 'ARCHIVED' || fields.options.length < 2 || !fields.prompt || !fields.correctOptionId
          || fields.options.some((option) => !option.text)) {
        throw new ContentFactoryError('AI_DRAFT_QUESTION_NOT_CHECKABLE');
      }
      questionRevisionId = input.questionRevisionId;
    }

    await tx.execute(sql`
      INSERT INTO ai_content_drafts (id, kind, feature_key, prompt_key, prompt_version, topic_id, base_lesson_id, question_revision_id,
                                     stable_key, title, language, level, style, author_note, requested_by_user_id, reason_code, correlation_id)
      VALUES (${jobId}::uuid, ${kind}, ${featureKey}, ${prompt.key}, ${prompt.version}, ${topicId}::uuid, ${baseLessonId}::uuid,
              ${questionRevisionId}::uuid, ${stableKey}, ${title}, ${language}, ${level}, ${style}, ${note},
              ${input.actor.userId}::uuid, ${input.reasonCode}, ${input.actor.correlationId})
    `);
    await writeAudit(tx, input.actor, 'operations.content.ai_draft_requested', jobId, {
      kind, featureKey, prompt: `${prompt.key}@${prompt.version}`, reasonCode: input.reasonCode,
      ...(topicId ? { topicId } : {}), ...(baseLessonId ? { baseLessonId } : {}), ...(questionRevisionId ? { questionRevisionId } : {}),
      ...(stableKey ? { stableKey } : {}), language, ...(level ? { level } : {}), ...(style ? { style } : {}), authorNote: note !== null,
    });
    await writeOutbox(tx, input.actor, jobId, 'content_factory.draft_requested', { jobId, kind, featureKey });
  });
  return { jobId };
}

export async function writeAudit(runner: SqlRunner, actor: ContentFactoryActor, action: string, jobId: string, context: Record<string, unknown>): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: actor.userId, action, resourceType: 'ai_content_draft', resourceId: jobId, correlationId: actor.correlationId });
  const full = { ...context, ...(actor.breakGlass ? { break_glass: true } : {}) };
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${actor.userId}::uuid, ${action}, 'ai_content_draft', ${jobId}, NULL, 'SUCCESS', ${actor.correlationId}, ${JSON.stringify(full)}::jsonb)
  `);
}

export async function writeOutbox(runner: SqlRunner, actor: ContentFactoryActor, jobId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, aggregateType: 'ai_content_draft', aggregateId: jobId, eventType, payload, actorUserId: actor.userId, correlationId: actor.correlationId, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, 'ai_content_draft', ${jobId}, ${eventType}, 1, ${JSON.stringify(payload)}::jsonb, ${actor.userId}::uuid, ${actor.correlationId})
  `);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ContentDraftView {
  readonly id: string;
  readonly kind: ContentDraftKind;
  readonly state: ContentDraftState;
  /** Why a job did not land anything (CAP_EXCEEDED, KILL_SWITCH_ENGAGED, MODEL_REFUSED, GUARD_REJECTED, a provider failure class …). */
  readonly outcomeCode: string | null;
  /** The guard's findings on a rejected reply. */
  readonly findings: readonly string[];
  readonly requestedBy: { readonly userId: string; readonly email: string };
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly attempts: number;
  readonly target: {
    readonly topic: { readonly id: string; readonly stableKey: string; readonly name: string } | null;
    readonly baseLesson: { readonly lessonId: string; readonly stableKey: string; readonly title: string } | null;
    readonly questionRevisionId: string | null;
    readonly stableKey: string | null;
    readonly title: string | null;
    readonly language: string;
    readonly level: string | null;
    readonly style: string | null;
    readonly authorNote: string | null;
  };
  readonly prompt: { readonly key: string; readonly version: number };
  /** Provenance of the reply, when the model produced one. */
  readonly generation: {
    readonly source: 'AI_GENERATED'; readonly generatorVersion: string; readonly model: string; readonly generatedAt: string;
    readonly fitted: boolean | null; readonly truncated: boolean;
  } | null;
  readonly produced: { readonly lessonId: string | null; readonly questionId: string | null; readonly revisionId: string } | null;
  /** An answer check's result; withheld (null) by the API from anyone who may not see answer keys. */
  readonly check: {
    readonly option: string; readonly working: string; readonly agreesWithKey: boolean; readonly contentHash: string;
    /** The question has been edited since the check: the result is about an earlier text. */
    readonly stale: boolean; readonly reviewState: 'DRAFT';
  } | null;
}

interface DraftRow {
  id: string; kind: ContentDraftKind; state: ContentDraftState; outcome_code: string | null; guard_findings: unknown;
  requested_by_user_id: string; requester_email: string; requested_at: Date; started_at: Date | null; finished_at: Date | null; attempts: number;
  topic_id: string | null; topic_key: string | null; topic_name: string | null;
  base_lesson_id: string | null; base_body: unknown; question_revision_id: string | null; current_hash: string | null;
  stable_key: string | null; title: string | null; language: string; level: string | null; style: string | null; author_note: string | null;
  prompt_key: string; prompt_version: number;
  source: string | null; generator_version: string | null; model: string | null; generated_at: Date | null; fitted: boolean | null; truncated: boolean | null;
  produced_lesson_id: string | null; produced_question_id: string | null; produced_revision_id: string | null;
  check_option: string | null; check_working: string | null; check_agrees: boolean | null; checked_content_hash: string | null;
}

const draftSelect = sql`
  SELECT d.*, u.email AS requester_email, t.stable_key AS topic_key, t.name AS topic_name,
    (SELECT b.body FROM content_revisions b WHERE b.entity_type = 'LESSON' AND b.entity_id = d.base_lesson_id ORDER BY b.revision DESC LIMIT 1) AS base_body,
    (SELECT q.content_hash FROM content_revisions q WHERE q.id = d.question_revision_id) AS current_hash
  FROM ai_content_drafts d
  JOIN users u ON u.id = d.requested_by_user_id
  LEFT JOIN taxonomy_nodes t ON t.id = d.topic_id`;

function mapDraft(row: DraftRow): ContentDraftView {
  const findings = Array.isArray(row.guard_findings) ? row.guard_findings.filter((entry): entry is string => typeof entry === 'string') : [];
  const baseIdentity = row.base_body ? readLessonIdentity(row.base_body) : null;
  return {
    id: row.id, kind: row.kind, state: row.state, outcomeCode: row.outcome_code, findings,
    requestedBy: { userId: row.requested_by_user_id, email: row.requester_email },
    requestedAt: iso(row.requested_at)!, startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), attempts: Number(row.attempts),
    target: {
      topic: row.topic_id ? { id: row.topic_id, stableKey: row.topic_key ?? 'NA', name: row.topic_name ?? 'NA' } : null,
      baseLesson: row.base_lesson_id ? {
        lessonId: row.base_lesson_id, stableKey: baseIdentity && baseIdentity.stableKey ? baseIdentity.stableKey : 'NA',
        title: row.base_body ? readLessonDraftFields(row.base_body).title || 'NA' : 'NA',
      } : null,
      questionRevisionId: row.question_revision_id, stableKey: row.stable_key, title: row.title,
      language: row.language, level: row.level, style: row.style, authorNote: row.author_note,
    },
    prompt: { key: row.prompt_key, version: Number(row.prompt_version) },
    generation: row.source === 'AI_GENERATED' && row.generator_version && row.model && row.generated_at ? {
      source: 'AI_GENERATED', generatorVersion: row.generator_version, model: row.model, generatedAt: iso(row.generated_at)!,
      fitted: row.fitted, truncated: Boolean(row.truncated),
    } : null,
    produced: row.produced_revision_id ? { lessonId: row.produced_lesson_id, questionId: row.produced_question_id, revisionId: row.produced_revision_id } : null,
    check: row.check_option && row.check_working !== null && row.check_agrees !== null && row.checked_content_hash ? {
      option: row.check_option, working: row.check_working, agreesWithKey: row.check_agrees, contentHash: row.checked_content_hash,
      stale: row.current_hash !== row.checked_content_hash, reviewState: 'DRAFT',
    } : null,
  };
}

export interface ContentDraftFilter {
  readonly kinds?: readonly ContentDraftKind[];
  readonly requestedBy?: string;
  readonly topicId?: string;
  readonly baseLessonId?: string;
  readonly questionRevisionId?: string;
  readonly producedRevisionId?: string;
  readonly limit: number;
}

/** Jobs, newest first. */
export async function listContentDrafts(runner: SqlRunner, filter: ContentDraftFilter): Promise<readonly ContentDraftView[]> {
  const conditions: SQL[] = [sql`TRUE`];
  if (filter.kinds && filter.kinds.length) conditions.push(sql`d.kind IN (${sql.join(filter.kinds.map((kind) => sql`${kind}`), sql`, `)})`);
  if (filter.requestedBy) conditions.push(sql`d.requested_by_user_id = ${filter.requestedBy}::uuid`);
  if (filter.topicId) conditions.push(sql`d.topic_id = ${filter.topicId}::uuid`);
  if (filter.baseLessonId) conditions.push(sql`d.base_lesson_id = ${filter.baseLessonId}::uuid`);
  if (filter.questionRevisionId) conditions.push(sql`d.question_revision_id = ${filter.questionRevisionId}::uuid`);
  if (filter.producedRevisionId) conditions.push(sql`d.produced_revision_id = ${filter.producedRevisionId}::uuid`);
  const found = await rows<DraftRow>(runner, sql`
    SELECT * FROM (${draftSelect}) d WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY d.requested_at DESC, d.id DESC LIMIT ${Math.max(1, Math.min(filter.limit, 100))}`);
  return found.map(mapDraft);
}

export async function loadContentDraft(runner: SqlRunner, jobId: string): Promise<ContentDraftView | null> {
  const [row] = await rows<DraftRow>(runner, sql`SELECT * FROM (${draftSelect}) d WHERE d.id = ${jobId}::uuid`);
  return row ? mapDraft(row) : null;
}
