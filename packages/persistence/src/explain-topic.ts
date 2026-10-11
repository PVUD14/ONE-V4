/**
 * "Ask ONE to explain" (ADR-052, migration 0117) — the request side, the student's view, "Report a mistake",
 * and the operations review-by-exception queue (withdraw, promote to an official draft).
 *
 * Why this exists: under Divakar's scoped waiver of 2026-10-10 a student may read an AI lesson on any topic
 * before any person has. This module is everything about that which is plain database work: the per-student
 * limits and the feature switch, the cache (one lesson per normalised topic, model and prompt version), the
 * outbox job a request leaves when nothing is cached, what a student is shown, and the staff actions.
 *
 * It never calls a model and never imports the orchestrator: the job is `explain-topic-worker.ts`, run by the
 * outbox worker (CLAUDE.md: no model call in a request handler). It writes only `explain_lessons`,
 * `explain_topic_requests`, `explain_lesson_reports`, `outbox_events` and `audit_events` — and, on promote,
 * a DRAFT lesson through the lesson editor's own functions. It never writes or reads attempts, evidence,
 * mastery, skill state, placement or readiness (explain-boundary.test.ts holds it to that).
 *
 * Design: docs/architecture/ask-to-explain-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createIntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import { explainTopicPromptV1 } from '@planthepath/ai-orchestration/src/index.js';
import { fitLesson, lessonSectionNames } from '@planthepath/ai-evaluation/src/content-guard.js';
import { EXPLAIN_GUARD_VERSION, guardExplainLesson } from '@planthepath/ai-evaluation/src/explain-guard.js';
import {
  EXPLAIN_FEATURE_KEY,
  EXPLAIN_LESSON_LABEL,
  EXPLAIN_OPEN_PER_STUDENT,
  EXPLAIN_PENDING_SECONDS,
  EXPLAIN_REPORT_NOTE_MAX,
  EXPLAIN_REPORT_REASONS,
  EXPLAIN_REQUESTS_PER_DAY,
  EXPLAIN_TOPIC_MAX,
  EXPLAIN_TOPIC_MIN,
  explainReportNoteProblem,
  explainTopicProblem,
  normaliseExplainTopic,
  tidyExplainTopic,
} from '@planthepath/ai-evaluation/src/explain-topic-rules.js';
import { LESSON_LEVELS, LESSON_STYLES, type LessonLevel, type LessonStyle } from '@planthepath/career-readiness';
import { loadAiFeaturePolicy } from './ai-orchestration.js';
import { drizzleAsPgClient } from './learning-attempts.js';
import { createLesson, LessonEditorError, saveLessonDraft, type TransactionalRunner } from './lesson-editor.js';
import type { PersistenceDb } from './repositories.js';

export const EXPLAIN_LESSON_REQUESTED = 'explain.lesson.requested' as const;
export const EXPLAIN_LESSON_CONSUMER = 'explain-lesson-generator' as const;
export const EXPLAIN_PROMPT = explainTopicPromptV1;
export const EXPLAIN_PROMPT_VERSION = `${explainTopicPromptV1.key}@${explainTopicPromptV1.version}`;

type QueryResult<T> = { rows: T[] };

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as QueryResult<T>).rows;
}

// ---------------------------------------------------------------------------
// Errors and views
// ---------------------------------------------------------------------------

export type ExplainErrorCode =
  | 'EXPLAIN_NOT_AVAILABLE'
  | 'TOPIC_LENGTH' | 'TOPIC_NOT_ENGLISH' | 'TOPIC_PERSONAL_DATA' | 'TOPIC_LINK'
  | 'EXPLAIN_PREPARING' | 'EXPLAIN_DAILY_LIMIT' | 'EXPLAIN_BUSY'
  | 'EXPLAIN_REQUEST_NOT_FOUND' | 'EXPLAIN_NOT_REPORTABLE' | 'EXPLAIN_ALREADY_REPORTED' | 'REPORT_REASON_INVALID' | 'NOTE_LENGTH' | 'NOTE_PERSONAL_DATA'
  | 'EXPLAIN_LESSON_NOT_FOUND' | 'EXPLAIN_NOT_REVIEWABLE' | 'EXPLAIN_ALREADY_WITHDRAWN' | 'EXPLAIN_ALREADY_PROMOTED' | 'PROMOTE_INVALID' | 'LESSON_KEY_EXISTS';

export class ExplainError extends Error {
  constructor(readonly code: ExplainErrorCode, readonly problems: readonly string[] = []) {
    super(`explain: ${code}`);
    this.name = 'ExplainError';
  }
}

/** What the screen shows for a request. `READY` with `reported` is the "Reported" state. */
export type ExplainState = 'PREPARING' | 'READY' | 'NOT_AVAILABLE' | 'REFUSED';
/** Why a request shows NOT_AVAILABLE, in terms a screen can explain plainly. */
export type ExplainNotAvailable = 'CHECKS_FAILED' | 'TIMED_OUT' | 'AI_UNAVAILABLE' | 'WITHDRAWN';

export interface ExplainLessonView {
  readonly label: typeof EXPLAIN_LESSON_LABEL;
  readonly title: string;
  readonly sections: readonly { readonly heading: string; readonly text: string }[];
  readonly generatedAt: string;
  readonly promptVersion: string;
}

export interface ExplainRequestView {
  readonly id: string;
  readonly topic: string;
  readonly askedAt: string;
  readonly state: ExplainState;
  readonly notAvailable: ExplainNotAvailable | null;
  readonly servedFromCache: boolean;
  readonly reported: boolean;
  /** Only when READY. Never the text of a refused, blocked or withdrawn lesson. */
  readonly lesson: ExplainLessonView | null;
}

export interface ExplainAvailability {
  readonly available: boolean;
  /** Null when available. OFF: the screen shows the empty state; nothing else is offered. */
  readonly reason: 'OFF' | 'PREPARING' | 'DAILY_LIMIT' | null;
  /** Requests left today; null when the feature is off. */
  readonly remainingToday: number | null;
  readonly limits: { readonly topicMin: number; readonly topicMax: number; readonly perDay: number; readonly reportNoteMax: number };
}

interface RequestRow {
  id: string; topic_text: string; requested_at: Date | string; served_from_cache: boolean; lesson_id: string;
  status: string; failure_code: string | null; review_state: string; generated_text: string | null; generated_at: Date | string | null;
  prompt_version: string; topic_key: string; expired: boolean; reported: boolean;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

function stateOf(row: RequestRow): { readonly state: ExplainState; readonly notAvailable: ExplainNotAvailable | null } {
  if (row.status === 'PENDING' || row.status === 'GENERATING') return row.expired ? { state: 'NOT_AVAILABLE', notAvailable: 'TIMED_OUT' } : { state: 'PREPARING', notAvailable: null };
  if (row.status === 'READY') return row.review_state === 'WITHDRAWN' ? { state: 'NOT_AVAILABLE', notAvailable: 'WITHDRAWN' } : { state: 'READY', notAvailable: null };
  if (row.status === 'REFUSED') return { state: 'REFUSED', notAvailable: null };
  if (row.status === 'BLOCKED') return { state: 'NOT_AVAILABLE', notAvailable: 'CHECKS_FAILED' };
  return { state: 'NOT_AVAILABLE', notAvailable: row.failure_code === 'EXPIRED' ? 'TIMED_OUT' : 'AI_UNAVAILABLE' };
}

function viewOf(row: RequestRow): ExplainRequestView {
  const { state, notAvailable } = stateOf(row);
  const lesson = state === 'READY' && row.generated_text && row.generated_at
    ? (() => {
      const fitted = fitLesson(row.generated_text);
      return {
        label: EXPLAIN_LESSON_LABEL, title: row.topic_key,
        sections: lessonSectionNames.map((heading) => ({ heading, text: fitted.sections[heading] })).filter((section) => section.text.length > 0),
        generatedAt: iso(row.generated_at), promptVersion: row.prompt_version,
      } satisfies ExplainLessonView;
    })()
    : null;
  return {
    id: row.id, topic: row.topic_text, askedAt: iso(row.requested_at), state, notAvailable,
    servedFromCache: row.served_from_cache === true, reported: row.reported === true, lesson,
  };
}

function requestSelect(where: ReturnType<typeof sql>, limit: number) {
  return sql`
    SELECT r.id::text AS id, r.topic_text, r.requested_at, r.served_from_cache, r.lesson_id::text AS lesson_id,
           l.status, l.failure_code, l.review_state, l.generated_text, l.generated_at, l.prompt_version, l.topic_key,
           (l.requested_at <= now() - make_interval(secs => ${EXPLAIN_PENDING_SECONDS})) AS expired,
           EXISTS (SELECT 1 FROM explain_lesson_reports p WHERE p.lesson_id = r.lesson_id AND p.subject_user_id = r.subject_user_id) AS reported
    FROM explain_topic_requests r JOIN explain_lessons l ON l.id = r.lesson_id
    WHERE ${where}
    ORDER BY r.requested_at DESC, r.id
    LIMIT ${limit}
  `;
}

/** One of the student's own requests, or null (another person's request is simply not found). */
export async function loadExplainRequest(db: PersistenceDb, subjectUserId: string, requestId: string): Promise<ExplainRequestView | null> {
  const [row] = await rows<RequestRow>(db, requestSelect(sql`r.id = ${requestId}::uuid AND r.subject_user_id = ${subjectUserId}::uuid`, 1));
  return row ? viewOf(row) : null;
}

/** The student's latest requests, newest first. */
export async function listExplainRequests(db: PersistenceDb, subjectUserId: string, limit = 20): Promise<readonly ExplainRequestView[]> {
  return (await rows<RequestRow>(db, requestSelect(sql`r.subject_user_id = ${subjectUserId}::uuid`, Math.min(Math.max(1, Math.trunc(limit)), 50)))).map(viewOf);
}

// ---------------------------------------------------------------------------
// Availability and limits
// ---------------------------------------------------------------------------

/** On only when the policy exists and is enabled; the global kill switch reads as off (loadAiFeaturePolicy). */
export async function explainFeatureOn(db: PersistenceDb): Promise<{ readonly on: boolean; readonly model: string | null; readonly cap: number; readonly window: 'DAY' | 'MONTH' }> {
  const policy = await loadAiFeaturePolicy(drizzleAsPgClient(db), EXPLAIN_FEATURE_KEY);
  return { on: policy?.enabled === true, model: policy?.model ?? null, cap: policy?.cap ?? 0, window: policy?.window ?? 'DAY' };
}

async function studentCounts(db: PersistenceDb, subjectUserId: string): Promise<{ readonly today: number; readonly open: number }> {
  const [counts] = await rows<{ today: number; open: number }>(db, sql`
    SELECT
      (SELECT count(*)::int FROM explain_topic_requests WHERE subject_user_id = ${subjectUserId}::uuid AND requested_at >= date_trunc('day', now())) AS today,
      (SELECT count(*)::int FROM explain_topic_requests r JOIN explain_lessons l ON l.id = r.lesson_id
        WHERE r.subject_user_id = ${subjectUserId}::uuid AND l.status IN ('PENDING','GENERATING')
          AND l.requested_at > now() - make_interval(secs => ${EXPLAIN_PENDING_SECONDS})) AS open
  `);
  return { today: Number(counts?.today ?? 0), open: Number(counts?.open ?? 0) };
}

const limits = { topicMin: EXPLAIN_TOPIC_MIN, topicMax: EXPLAIN_TOPIC_MAX, perDay: EXPLAIN_REQUESTS_PER_DAY, reportNoteMax: EXPLAIN_REPORT_NOTE_MAX } as const;

/** Whether the student may ask now, read on every call (no cache: the switch and kill switch apply at once). */
export async function explainAvailability(db: PersistenceDb, subjectUserId: string): Promise<ExplainAvailability> {
  const feature = await explainFeatureOn(db);
  if (!feature.on) return { available: false, reason: 'OFF', remainingToday: null, limits };
  const counts = await studentCounts(db, subjectUserId);
  const remainingToday = Math.max(0, EXPLAIN_REQUESTS_PER_DAY - counts.today);
  if (counts.open >= EXPLAIN_OPEN_PER_STUDENT) return { available: false, reason: 'PREPARING', remainingToday, limits };
  if (remainingToday === 0) return { available: false, reason: 'DAILY_LIMIT', remainingToday, limits };
  return { available: true, reason: null, remainingToday, limits };
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/**
 * Ask ONE to explain a topic. A cached lesson (ready, refused, blocked, withdrawn or still preparing) answers
 * at once; otherwise a PENDING lesson, its outbox job and an audit row are written in one transaction with the
 * request. Asking again for a topic already asked returns the same request.
 */
export async function requestExplanation(db: PersistenceDb, input: {
  readonly subjectUserId: string; readonly topic: unknown; readonly correlationId: string;
}): Promise<ExplainRequestView> {
  const problem = explainTopicProblem(input.topic);
  if (problem) throw new ExplainError(problem);
  const topicText = tidyExplainTopic(input.topic as string);
  const topicKey = normaliseExplainTopic(topicText);
  const requestId = await db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    // One student's requests one at a time (the limits are counts), and one topic's cache slot at a time.
    await runner.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'explain-subject:' + input.subjectUserId}))`);
    await runner.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'explain-topic:' + topicKey}))`);
    const feature = await explainFeatureOn(runner);
    if (!feature.on || !feature.model) throw new ExplainError('EXPLAIN_NOT_AVAILABLE');
    // A lesson preparing for longer than the window is closed, so a lost job never holds a topic.
    await runner.execute(sql`
      UPDATE explain_lessons SET status = 'FAILED', failure_code = 'EXPIRED', completed_at = now()
      WHERE topic_key = ${topicKey} AND status IN ('PENDING','GENERATING') AND requested_at <= now() - make_interval(secs => ${EXPLAIN_PENDING_SECONDS})
    `);
    const [live] = await rows<{ id: string }>(runner, sql`
      SELECT id::text AS id FROM explain_lessons
      WHERE topic_key = ${topicKey} AND model = ${feature.model} AND prompt_version = ${EXPLAIN_PROMPT_VERSION} AND status <> 'FAILED'
      FOR UPDATE
    `);
    if (live) {
      const [mine] = await rows<{ id: string }>(runner, sql`
        SELECT id::text AS id FROM explain_topic_requests WHERE subject_user_id = ${input.subjectUserId}::uuid AND lesson_id = ${live.id}::uuid`);
      if (mine) return mine.id;
    }
    const counts = await studentCounts(runner, input.subjectUserId);
    if (counts.today >= EXPLAIN_REQUESTS_PER_DAY) throw new ExplainError('EXPLAIN_DAILY_LIMIT');
    if (counts.open >= EXPLAIN_OPEN_PER_STUDENT) throw new ExplainError('EXPLAIN_PREPARING');
    const id = randomUUID();
    let lessonId = live?.id ?? null;
    if (!lessonId) {
      // The orchestrator checks the cap again before any call; checking here tells the student now.
      const [used] = await rows<{ n: number }>(runner, sql`
        SELECT count(*)::int AS n FROM ai_generations
        WHERE feature_key = ${EXPLAIN_FEATURE_KEY} AND outcome = 'SUCCEEDED'
          AND occurred_at >= date_trunc(${feature.window === 'DAY' ? 'day' : 'month'}, now())
      `);
      if (Number(used?.n ?? 0) >= feature.cap) throw new ExplainError('EXPLAIN_BUSY');
      lessonId = randomUUID();
      const eventId = randomUUID();
      const payload = { explainLessonId: lessonId };
      // Validates the payload against the registered schema before anything is written.
      createIntegrationEventEnvelope({
        eventId, eventType: EXPLAIN_LESSON_REQUESTED, eventVersion: 1, occurredAt: new Date().toISOString(),
        aggregateId: lessonId, correlationId: input.correlationId, payload,
      });
      await runner.execute(sql`
        INSERT INTO explain_lessons (id, topic_key, feature_key, prompt_version, model, correlation_id)
        VALUES (${lessonId}::uuid, ${topicKey}, ${EXPLAIN_FEATURE_KEY}, ${EXPLAIN_PROMPT_VERSION}, ${feature.model}, ${input.correlationId})
      `);
      await runner.execute(sql`
        INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
        VALUES (${eventId}::uuid, 'explain_lesson', ${lessonId}::uuid, ${EXPLAIN_LESSON_REQUESTED}, 1, ${JSON.stringify(payload)}::jsonb, ${input.subjectUserId}::uuid, ${input.correlationId})
      `);
    }
    await runner.execute(sql`
      INSERT INTO explain_topic_requests (id, subject_user_id, lesson_id, topic_text, served_from_cache, correlation_id)
      VALUES (${id}::uuid, ${input.subjectUserId}::uuid, ${lessonId}::uuid, ${topicText}, ${live !== undefined}, ${input.correlationId})
    `);
    // The audit row names the request and lesson, never the topic text.
    await runner.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${randomUUID()}::uuid, ${input.subjectUserId}::uuid, 'learning.explain.requested', 'explain_topic_request', ${id}, NULL, 'SUCCESS',
        ${input.correlationId}, ${JSON.stringify({ lessonId, servedFromCache: live !== undefined, promptVersion: EXPLAIN_PROMPT_VERSION })}::jsonb)
    `);
    return id;
  });
  const view = await loadExplainRequest(db, input.subjectUserId, requestId);
  if (!view) throw new ExplainError('EXPLAIN_REQUEST_NOT_FOUND');
  return view;
}

// ---------------------------------------------------------------------------
// Report a mistake
// ---------------------------------------------------------------------------

/** A student reports a ready lesson they were answered with: a reason, an optional PII-free note. Flags the lesson. */
export async function reportExplainLesson(db: PersistenceDb, input: {
  readonly subjectUserId: string; readonly requestId: string; readonly reasonCode: unknown; readonly note: unknown; readonly correlationId: string;
}): Promise<ExplainRequestView> {
  if (typeof input.reasonCode !== 'string' || !(EXPLAIN_REPORT_REASONS as readonly string[]).includes(input.reasonCode)) throw new ExplainError('REPORT_REASON_INVALID');
  const noteProblem = explainReportNoteProblem(input.note);
  if (noteProblem) throw new ExplainError(noteProblem);
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : null;
  await db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    const [request] = await rows<{ lesson_id: string; status: string; review_state: string; reported: boolean }>(runner, sql`
      SELECT r.lesson_id::text AS lesson_id, l.status, l.review_state,
             EXISTS (SELECT 1 FROM explain_lesson_reports p WHERE p.lesson_id = r.lesson_id AND p.subject_user_id = r.subject_user_id) AS reported
      FROM explain_topic_requests r JOIN explain_lessons l ON l.id = r.lesson_id
      WHERE r.id = ${input.requestId}::uuid AND r.subject_user_id = ${input.subjectUserId}::uuid
      FOR UPDATE OF l
    `);
    if (!request) throw new ExplainError('EXPLAIN_REQUEST_NOT_FOUND');
    if (request.status !== 'READY' || request.review_state === 'WITHDRAWN') throw new ExplainError('EXPLAIN_NOT_REPORTABLE');
    if (request.reported) throw new ExplainError('EXPLAIN_ALREADY_REPORTED');
    const reportId = randomUUID();
    await runner.execute(sql`
      INSERT INTO explain_lesson_reports (id, lesson_id, subject_user_id, reason_code, note)
      VALUES (${reportId}::uuid, ${request.lesson_id}::uuid, ${input.subjectUserId}::uuid, ${input.reasonCode}, ${note})
    `);
    // The first report puts the lesson in the review queue.
    await runner.execute(sql`UPDATE explain_lessons SET review_state = 'FLAGGED' WHERE id = ${request.lesson_id}::uuid AND review_state = 'AI_UNREVIEWED'`);
    await runner.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${randomUUID()}::uuid, ${input.subjectUserId}::uuid, 'learning.explain.reported', 'explain_lesson', ${request.lesson_id}, NULL, 'SUCCESS',
        ${input.correlationId}, ${JSON.stringify({ reportId, reasonCode: input.reasonCode, withNote: note !== null })}::jsonb)
    `);
  });
  const view = await loadExplainRequest(db, input.subjectUserId, input.requestId);
  if (!view) throw new ExplainError('EXPLAIN_REQUEST_NOT_FOUND');
  return view;
}

// ---------------------------------------------------------------------------
// Operations: the review-by-exception queue (Content Management)
// ---------------------------------------------------------------------------

export interface ExplainReviewRow {
  readonly id: string;
  readonly topic: string;
  readonly status: string;
  readonly reviewState: string;
  readonly requests: number;
  readonly reports: number;
  readonly reportReasons: Readonly<Record<string, number>>;
  /** The latest report notes (at most five), never who wrote them. */
  readonly reportNotes: readonly string[];
  readonly text: string | null;
  readonly model: string;
  readonly servedModel: string | null;
  readonly promptVersion: string;
  readonly generatorVersion: string | null;
  readonly guardVersion: string | null;
  readonly generatedAt: string | null;
  readonly reviewReasonCode: string | null;
  readonly reviewedAt: string | null;
  readonly promotedLessonId: string | null;
}

export type ExplainReviewListView = 'flagged' | 'most-viewed' | 'withdrawn' | 'promoted';

/** Lessons for staff review. No student identity is returned: no requester, no reporter. */
export async function listExplainLessonsForReview(db: PersistenceDb, input: { readonly view: ExplainReviewListView; readonly limit: number }): Promise<{
  readonly lessons: readonly ExplainReviewRow[];
  readonly counts: { readonly ready: number; readonly flagged: number; readonly withdrawn: number; readonly promoted: number; readonly blocked: number; readonly refused: number };
}> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), 100);
  const filter = input.view === 'flagged' ? sql`l.status = 'READY' AND l.review_state = 'FLAGGED'`
    : input.view === 'most-viewed' ? sql`l.status = 'READY' AND l.review_state IN ('AI_UNREVIEWED','FLAGGED')`
      : input.view === 'withdrawn' ? sql`l.review_state = 'WITHDRAWN'` : sql`l.review_state = 'PROMOTED'`;
  const order = input.view === 'flagged' ? sql`reports DESC, l.completed_at DESC, l.id`
    : input.view === 'most-viewed' ? sql`requests DESC, l.completed_at DESC, l.id` : sql`l.reviewed_at DESC, l.id`;
  const found = await rows<{
    id: string; topic_key: string; status: string; review_state: string; requests: number; reports: number; reasons: Record<string, number> | null;
    notes: string[] | null; generated_text: string | null; model: string; served_model: string | null; prompt_version: string; generator_version: string | null;
    guard_version: string | null; generated_at: Date | string | null; review_reason_code: string | null; reviewed_at: Date | string | null; promoted_lesson_id: string | null;
  }>(db, sql`
    SELECT l.id::text AS id, l.topic_key, l.status, l.review_state,
           (SELECT count(*)::int FROM explain_topic_requests r WHERE r.lesson_id = l.id) AS requests,
           (SELECT count(*)::int FROM explain_lesson_reports p WHERE p.lesson_id = l.id) AS reports,
           (SELECT jsonb_object_agg(reason_code, n) FROM (SELECT reason_code, count(*)::int AS n FROM explain_lesson_reports p WHERE p.lesson_id = l.id GROUP BY reason_code) x) AS reasons,
           (SELECT array_agg(note ORDER BY reported_at DESC) FROM (SELECT note, reported_at FROM explain_lesson_reports p WHERE p.lesson_id = l.id AND note IS NOT NULL ORDER BY reported_at DESC LIMIT 5) y) AS notes,
           l.generated_text, l.model, l.served_model, l.prompt_version, l.generator_version, l.guard_version, l.generated_at,
           l.review_reason_code, l.reviewed_at, l.promoted_lesson_id::text AS promoted_lesson_id
    FROM explain_lessons l
    WHERE ${filter}
    ORDER BY ${order}
    LIMIT ${limit}
  `);
  const [counts] = await rows<Record<string, number>>(db, sql`
    SELECT count(*) FILTER (WHERE status = 'READY')::int AS ready,
           count(*) FILTER (WHERE status = 'READY' AND review_state = 'FLAGGED')::int AS flagged,
           count(*) FILTER (WHERE review_state = 'WITHDRAWN')::int AS withdrawn,
           count(*) FILTER (WHERE review_state = 'PROMOTED')::int AS promoted,
           count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked,
           count(*) FILTER (WHERE status = 'REFUSED')::int AS refused
    FROM explain_lessons
  `);
  return {
    lessons: found.map((row) => ({
      id: row.id, topic: row.topic_key, status: row.status, reviewState: row.review_state, requests: Number(row.requests), reports: Number(row.reports),
      reportReasons: row.reasons ?? {}, reportNotes: row.notes ?? [], text: row.generated_text, model: row.model, servedModel: row.served_model,
      promptVersion: row.prompt_version, generatorVersion: row.generator_version, guardVersion: row.guard_version,
      generatedAt: row.generated_at ? iso(row.generated_at) : null, reviewReasonCode: row.review_reason_code,
      reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null, promotedLessonId: row.promoted_lesson_id,
    })),
    counts: {
      ready: Number(counts?.ready ?? 0), flagged: Number(counts?.flagged ?? 0), withdrawn: Number(counts?.withdrawn ?? 0),
      promoted: Number(counts?.promoted ?? 0), blocked: Number(counts?.blocked ?? 0), refused: Number(counts?.refused ?? 0),
    },
  };
}

export interface ExplainReviewActor {
  readonly userId: string;
  readonly correlationId: string;
  readonly breakGlass: boolean;
}

interface LockedLesson {
  id: string; status: string; review_state: string; topic_key: string; generated_text: string | null; generator_version: string | null;
  served_model: string | null; prompt_version: string; prompt_fingerprint: string | null; generated_at: Date | string | null;
}

async function lockLesson(runner: PersistenceDb, lessonId: string): Promise<LockedLesson> {
  const [lesson] = await rows<LockedLesson>(runner, sql`
    SELECT id::text AS id, status, review_state, topic_key, generated_text, generator_version, served_model, prompt_version, prompt_fingerprint, generated_at
    FROM explain_lessons WHERE id = ${lessonId}::uuid FOR UPDATE`);
  if (!lesson) throw new ExplainError('EXPLAIN_LESSON_NOT_FOUND');
  return lesson;
}

async function auditReview(runner: PersistenceDb, actor: ExplainReviewActor, action: string, lessonId: string, context: Record<string, unknown>): Promise<void> {
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${actor.userId}::uuid, ${action}, 'explain_lesson', ${lessonId}, NULL, 'SUCCESS', ${actor.correlationId},
      ${JSON.stringify({ ...context, ...(actor.breakGlass ? { break_glass: true } : {}) })}::jsonb)
  `);
}

/** Withdraw: hidden from every student on their next read. Immediate and final; the cache slot is kept. */
export async function withdrawExplainLesson(db: PersistenceDb, actor: ExplainReviewActor, input: { readonly lessonId: string; readonly reasonCode: string }): Promise<{ readonly id: string; readonly reviewState: 'WITHDRAWN' }> {
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    const lesson = await lockLesson(runner, input.lessonId);
    if (lesson.status !== 'READY') throw new ExplainError('EXPLAIN_NOT_REVIEWABLE');
    if (lesson.review_state === 'WITHDRAWN') throw new ExplainError('EXPLAIN_ALREADY_WITHDRAWN');
    await runner.execute(sql`
      UPDATE explain_lessons SET review_state = 'WITHDRAWN', reviewed_by_user_id = ${actor.userId}::uuid, review_reason_code = ${input.reasonCode}
      WHERE id = ${input.lessonId}::uuid
    `);
    await auditReview(runner, actor, 'operations.content.explain_lesson_withdrawn', input.lessonId, { from: lesson.review_state, reasonCode: input.reasonCode });
    return { id: input.lessonId, reviewState: 'WITHDRAWN' as const };
  });
}

/**
 * Promote to an official draft: a new base lesson, revision 1 in DRAFT, authored by the promoter, through the
 * lesson editor's own functions, carrying the AI provenance block (so the editor labels it an AI draft) and
 * an expert-check note. From there it is reviewed and published like any lesson; the promoter never may.
 */
export async function promoteExplainLesson(db: PersistenceDb, actor: ExplainReviewActor, input: {
  readonly lessonId: string; readonly reasonCode: string; readonly stableKey: unknown; readonly title: unknown; readonly level: unknown; readonly style: unknown;
}): Promise<{ readonly id: string; readonly reviewState: 'PROMOTED'; readonly lessonId: string; readonly revisionId: string }> {
  const stableKey = typeof input.stableKey === 'string' ? input.stableKey.trim() : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/u.test(stableKey) || title.length < 1 || title.length > 200
      || !(LESSON_LEVELS as readonly unknown[]).includes(input.level) || !(LESSON_STYLES as readonly unknown[]).includes(input.style)) {
    throw new ExplainError('PROMOTE_INVALID');
  }
  try {
    return await db.transaction(async (tx) => {
      const runner = tx as unknown as PersistenceDb;
      const lesson = await lockLesson(runner, input.lessonId);
      if (lesson.status !== 'READY' || !lesson.generated_text || !lesson.generated_at || !lesson.generator_version || !lesson.served_model || !lesson.prompt_fingerprint) {
        throw new ExplainError('EXPLAIN_NOT_REVIEWABLE');
      }
      if (lesson.review_state === 'PROMOTED') throw new ExplainError('EXPLAIN_ALREADY_PROMOTED');
      if (lesson.review_state === 'WITHDRAWN') throw new ExplainError('EXPLAIN_ALREADY_WITHDRAWN');
      const guarded = guardExplainLesson({ text: lesson.generated_text, truncated: false });
      if (!guarded.ok || !guarded.value) throw new ExplainError('EXPLAIN_NOT_REVIEWABLE');
      const generatedAt = iso(lesson.generated_at);
      const lessonActor = { userId: actor.userId, breakGlass: actor.breakGlass, correlationId: actor.correlationId };
      const editor = tx as unknown as TransactionalRunner;
      const created = await createLesson(editor, {
        stableKey, title, level: input.level as LessonLevel, style: input.style as LessonStyle, reasonCode: 'NEW_LESSON', actor: lessonActor,
        aiDraft: {
          jobId: lesson.id, generatorVersion: lesson.generator_version, promptVersion: lesson.prompt_version, promptFingerprint: lesson.prompt_fingerprint,
          model: lesson.served_model, generatedAt,
          expertCheck: `Promoted from an "Ask ONE to explain" lesson (${lesson.prompt_version}, model ${lesson.served_model}, ${generatedAt}) that students saw labelled as not checked by a person. `
            + 'A reviewer checks every fact, example and number against a reliable source before approving; it reaches the course only when a person publishes it.',
          sections: guarded.value.sections, fitted: guarded.value.fitted, truncated: false, guardVersion: EXPLAIN_GUARD_VERSION,
        },
      });
      await saveLessonDraft(editor, {
        revisionId: created.revisionId, actor: lessonActor,
        draft: {
          title, summary: guarded.value.summary, practice: guarded.value.practice || null, moduleKey: null, topicKey: null, prerequisites: [],
          licenceLabel: null, attribution: null,
          basis: `Generated by ONE's AI for "Ask ONE to explain" (${lesson.prompt_version}, model ${lesson.served_model}, ${generatedAt}) from the topic alone. Every claim needs checking against a reliable source.`,
        },
      });
      await runner.execute(sql`
        UPDATE explain_lessons SET review_state = 'PROMOTED', reviewed_by_user_id = ${actor.userId}::uuid, review_reason_code = ${input.reasonCode},
          promoted_lesson_id = ${created.lessonId}::uuid, promoted_revision_id = ${created.revisionId}::uuid
        WHERE id = ${input.lessonId}::uuid
      `);
      await auditReview(runner, actor, 'operations.content.explain_lesson_promoted', input.lessonId, {
        from: lesson.review_state, reasonCode: input.reasonCode, promotedLessonId: created.lessonId, promotedRevisionId: created.revisionId, stableKey,
        promptVersion: lesson.prompt_version, model: lesson.served_model,
      });
      return { id: input.lessonId, reviewState: 'PROMOTED' as const, lessonId: created.lessonId, revisionId: created.revisionId };
    });
  } catch (error) {
    if (error instanceof LessonEditorError) throw new ExplainError(error.code === 'LESSON_KEY_EXISTS' ? 'LESSON_KEY_EXISTS' : 'PROMOTE_INVALID', error.problems);
    throw error;
  }
}
