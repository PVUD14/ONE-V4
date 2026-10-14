/**
 * The "Ask ONE to explain" job (ADR-052): the outbox consumer that writes one explain lesson. Worker-only.
 *
 * Why this exists: CLAUDE.md puts every model call in a job on the outbox pipeline, never in a request
 * handler. A request with no cached lesson (explain-topic.ts) leaves a PENDING lesson and an
 * `explain.lesson.requested` event; this consumer, run by the local outbox dispatcher (ADR-028), closes a
 * lesson that waited past its window without a call, claims the row (PENDING → GENERATING, so a redelivered
 * event never calls twice), calls ONE AI Orchestration — kill switch, the feature's own switch, its cap, the
 * input size, metering — outside any transaction, runs the explain guard and records READY, REFUSED,
 * BLOCKED or FAILED with provenance under the consumer receipt.
 *
 * The model receives only the normalised topic; the generation is metered against no student (the lesson is
 * shared content). Like `ai-workers.ts`, nothing under apps/ may import this (inference-boundary.spec.ts).
 * It writes only `explain_lessons`, `audit_events`, `event_consumer_receipts` and (through the orchestrator)
 * `ai_generations`; never attempts, evidence, mastery, skill state, placement or readiness.
 *
 * Design: docs/architecture/ask-to-explain-design.md (Decisions 2-4).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { IntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import {
  AiCapExceededError,
  AiFeatureDisabledError,
  InferenceUnconfiguredError,
  type GenerationRecord,
  type GenerationRequest,
} from '@planthepath/ai-orchestration/src/index.js';
import { EXPLAIN_GUARD_VERSION, guardExplainLesson } from '@planthepath/ai-evaluation/src/explain-guard.js';
import { EXPLAIN_FEATURE_KEY, EXPLAIN_PENDING_SECONDS } from '@planthepath/ai-evaluation/src/explain-topic-rules.js';
import { createWorkerAiOrchestrator } from './ai-workers.js';
import { EXPLAIN_LESSON_CONSUMER, EXPLAIN_LESSON_REQUESTED, EXPLAIN_PROMPT, EXPLAIN_PROMPT_VERSION } from './explain-topic.js';
import { drizzleAsPgClient } from './learning-attempts.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };
type Environment = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Time kept back from the pending window for the guard and the final write. */
const WRITE_MARGIN_MS = 5_000;

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as QueryResult<T>).rows;
}

export interface ExplainWorkerOptions {
  readonly db: PersistenceDb;
  /** The worker's environment (the inference endpoint). Defaults to process.env. */
  readonly env?: Environment;
  /** Tests may supply the generation step; the worker uses ONE AI Orchestration from the environment. */
  readonly generate?: (request: GenerationRequest) => Promise<GenerationRecord>;
}

export type ExplainJobOutcome = 'READY' | 'REFUSED' | 'BLOCKED' | 'AI_UNAVAILABLE' | 'GENERATION_FAILED' | 'EXPIRED' | 'NOTHING_TO_DO';

interface LessonContext {
  id: string; topic_key: string; status: string; prompt_version: string; correlation_id: string; age_ms: number; first_requester: string | null;
}

async function loadContext(db: PersistenceDb, lessonId: string): Promise<LessonContext | null> {
  const [row] = await rows<LessonContext>(db, sql`
    SELECT l.id::text AS id, l.topic_key, l.status, l.prompt_version, l.correlation_id,
           (extract(epoch FROM (now() - l.requested_at)) * 1000)::float8 AS age_ms,
           (SELECT r.subject_user_id::text FROM explain_topic_requests r WHERE r.lesson_id = l.id ORDER BY r.requested_at, r.id LIMIT 1) AS first_requester
    FROM explain_lessons l WHERE l.id = ${lessonId}::uuid
  `);
  return row ?? null;
}

/**
 * How the job ended, in the audit trail: outcome and the guard's codes, never the text or the topic. The
 * actor is the student whose request started the job (audit rows always have one); `by` names the worker.
 * With that request gone (privacy deletion), the lesson row is the record.
 */
async function audit(db: PersistenceDb, context: LessonContext, outcome: string, findings: readonly string[]): Promise<void> {
  if (!context.first_requester) return;
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${context.first_requester}::uuid, 'learning.explain.completed', 'explain_lesson', ${context.id}, NULL, 'SUCCESS',
      ${context.correlation_id}, ${JSON.stringify({ by: EXPLAIN_LESSON_CONSUMER, outcome, findings, promptVersion: context.prompt_version })}::jsonb)
  `);
}

function failureCode(error: unknown): 'AI_UNAVAILABLE' | 'GENERATION_FAILED' {
  // Off, stopped by the kill switch, over the cap, or no endpoint configured: unavailable, not broken.
  if (error instanceof AiFeatureDisabledError || error instanceof AiCapExceededError || error instanceof InferenceUnconfiguredError) return 'AI_UNAVAILABLE';
  return 'GENERATION_FAILED';
}

async function closeWithoutCall(db: PersistenceDb, event: IntegrationEventEnvelope, context: LessonContext, code: 'EXPIRED' | 'AI_UNAVAILABLE'): Promise<{ executed: boolean; result?: ExplainJobOutcome }> {
  return handleEventIdempotently(db, {
    consumerName: EXPLAIN_LESSON_CONSUMER, eventId: event.eventId, failureClass: 'EXPLAIN_RECORD_FAILED',
    effect: async (tx) => {
      const closed = await rows<{ id: string }>(tx, sql`
        UPDATE explain_lessons SET status = 'FAILED', failure_code = ${code}, completed_at = now()
        WHERE id = ${context.id}::uuid AND status IN ('PENDING','GENERATING') RETURNING id::text AS id`);
      if (!closed.length) return 'NOTHING_TO_DO' as const;
      await audit(tx, context, code, []);
      return code;
    },
  });
}

/** The outbox consumer for `explain.lesson.requested` v1. */
export async function consumeExplainLessonRequested(options: ExplainWorkerOptions, event: IntegrationEventEnvelope): Promise<{ readonly executed: boolean; readonly outcome?: ExplainJobOutcome }> {
  if (event.eventType !== EXPLAIN_LESSON_REQUESTED || event.eventVersion !== 1) throw new Error('event is outside the explain lesson consumer contract');
  const lessonId = typeof event.payload.explainLessonId === 'string' ? event.payload.explainLessonId : '';
  if (!UUID.test(lessonId) || event.aggregateId !== lessonId) throw new Error('invalid explain lesson event');
  const db = options.db;
  const env = options.env ?? process.env;
  const context = await loadContext(db, lessonId);
  if (!context) throw new Error('explain lesson not found');
  const shape = (result: { executed: boolean; result?: ExplainJobOutcome }) => ({ executed: result.executed, ...(result.result ? { outcome: result.result } : {}) });

  if (context.status !== 'PENDING') {
    // Redelivered: an abandoned GENERATING row past its window is closed; anything else is done.
    if (context.status === 'GENERATING' && Number(context.age_ms) >= EXPLAIN_PENDING_SECONDS * 1000) return shape(await closeWithoutCall(db, event, context, 'EXPIRED'));
    return { executed: false, outcome: 'NOTHING_TO_DO' };
  }
  const remainingMs = EXPLAIN_PENDING_SECONDS * 1000 - Number(context.age_ms) - WRITE_MARGIN_MS;
  if (remainingMs <= 0) return shape(await closeWithoutCall(db, event, context, 'EXPIRED'));
  if (context.prompt_version !== EXPLAIN_PROMPT_VERSION) return shape(await closeWithoutCall(db, event, context, 'AI_UNAVAILABLE'));

  // Claim: only one worker ever calls the model for a lesson.
  const claimed = await rows<{ id: string }>(db, sql`
    UPDATE explain_lessons SET status = 'GENERATING' WHERE id = ${context.id}::uuid AND status = 'PENDING' RETURNING id::text AS id`);
  if (!claimed.length) return { executed: false, outcome: 'NOTHING_TO_DO' };

  const pg = drizzleAsPgClient(db);
  const generate = options.generate ?? ((request: GenerationRequest) => createWorkerAiOrchestrator({ db: pg, env }).orchestrator.generate(request));
  let generation: GenerationRecord | null = null;
  let failure: 'AI_UNAVAILABLE' | 'GENERATION_FAILED' | null = null;
  try {
    generation = await generate({
      featureKey: EXPLAIN_FEATURE_KEY,
      promptKey: EXPLAIN_PROMPT.key,
      promptVersion: EXPLAIN_PROMPT.version,
      parameters: { topic: context.topic_key },
      correlationId: context.correlation_id,
      signal: AbortSignal.timeout(Math.max(1_000, Math.floor(remainingMs))),
    });
  } catch (error) {
    failure = failureCode(error);
  }

  return shape(await handleEventIdempotently(db, {
    consumerName: EXPLAIN_LESSON_CONSUMER, eventId: event.eventId, failureClass: 'EXPLAIN_RECORD_FAILED',
    effect: async (tx): Promise<ExplainJobOutcome> => {
      const text = generation?.text.trim() ?? '';
      if (!generation || failure || !text) {
        const code = failure ?? 'GENERATION_FAILED';
        const closed = await rows<{ id: string }>(tx, sql`
          UPDATE explain_lessons SET status = 'FAILED', failure_code = ${code}, completed_at = now()
          WHERE id = ${context.id}::uuid AND status = 'GENERATING' RETURNING id::text AS id`);
        if (!closed.length) return 'NOTHING_TO_DO';
        await audit(tx, context, code, []);
        return code;
      }
      const guard = guardExplainLesson({ text, truncated: generation.truncated });
      const status = guard.refused ? 'REFUSED' : guard.ok ? 'READY' : 'BLOCKED';
      // A lesson must still be inside its window at commit (database clock); a late one ends EXPIRED, unshown.
      const [held] = await rows<{ inside: boolean }>(tx, sql`
        SELECT requested_at > now() - make_interval(secs => ${EXPLAIN_PENDING_SECONDS}) AS inside
        FROM explain_lessons WHERE id = ${context.id}::uuid AND status = 'GENERATING' FOR UPDATE`);
      if (!held) return 'NOTHING_TO_DO';
      if (!held.inside) {
        await tx.execute(sql`UPDATE explain_lessons SET status = 'FAILED', failure_code = 'EXPIRED', completed_at = now() WHERE id = ${context.id}::uuid`);
        await audit(tx, context, 'EXPIRED', []);
        return 'EXPIRED';
      }
      await tx.execute(sql`
        UPDATE explain_lessons SET
          status = ${status},
          guard_findings = ${`{${guard.findings.join(',')}}`}::text[],
          guard_version = ${EXPLAIN_GUARD_VERSION},
          generated_text = ${text.slice(0, 12000)},
          generated_at = ${generation.generatedAt}::timestamptz,
          generator_version = ${generation.generatorVersion},
          served_model = ${generation.model},
          prompt_fingerprint = ${generation.promptFingerprint},
          truncated = ${generation.truncated}::boolean,
          completed_at = now()
        WHERE id = ${context.id}::uuid AND status = 'GENERATING'
      `);
      await audit(tx, context, status, status === 'BLOCKED' ? guard.findings : []);
      return status;
    },
  }));
}
