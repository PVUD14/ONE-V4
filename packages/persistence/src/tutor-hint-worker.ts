/**
 * The tutor hint job (ENG-22): the outbox consumer that writes one AI hint. Worker-only.
 *
 * Why this exists: CLAUDE.md puts every model call in a job on the outbox pipeline, never in a request
 * handler. A student's request (tutor-hints.ts) leaves a PENDING row and a `tutor.hint.requested`
 * event; this consumer, run by the local outbox dispatcher (ADR-028), re-checks that the hint is still
 * wanted and allowed, claims the row so a redelivered event never calls twice, builds the brief from
 * content, calls ONE AI Orchestration (kill switch, feature switch, cap, size, metering — ENG-20) with a
 * deadline inside the pending window, runs the guard, and records SHOWN or FALLBACK with provenance.
 * The model call happens outside any database transaction.
 *
 * Like `ai-workers.ts`, nothing under apps/ may import this (inference-boundary.spec.ts). It writes
 * only `tutor_hints`, `audit_events`, `event_consumer_receipts` and (through the orchestrator)
 * `ai_generations`; never evidence, mastery, skill state, attempts or readiness, and it never reads
 * readiness (tutor-evidence-boundary.test.ts).
 *
 * Design: docs/architecture/tutor-hints-table-design.md (Decisions 4 and 5).
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
import {
  TUTOR_HINT_FEATURE_KEY,
  TUTOR_HINT_PENDING_SECONDS,
  TUTOR_HINT_PROMPT,
  buildTutorBrief,
  guardTutorReply,
  tutorAudienceFromEnvironment,
  tutorPromptParameters,
  type TutorGuardResult,
} from '@planthepath/tutoring/src/index.js';
import { createWorkerAiOrchestrator } from './ai-workers.js';
import { loadAiFeaturePolicy } from './ai-orchestration.js';
import { hasConsentPurpose } from './consent-purposes.js';
import { drizzleAsPgClient } from './learning-attempts.js';
import { handleEventIdempotently } from './outbox-dispatcher.js';
import type { PersistenceDb } from './repositories.js';
import { TUTOR_HINT_CONSUMER, TUTOR_HINT_REQUESTED } from './tutor-hints.js';

type QueryResult<T> = { rows: T[] };
type Environment = Readonly<Record<string, string | undefined>>;
type FallbackReason = 'GUARD_REFUSED' | 'REDIRECTED' | 'GENERATION_FAILED' | 'AI_UNAVAILABLE' | 'EXPIRED' | 'WITHDRAWN';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Time kept back from the pending window for the guard and the final write. */
const WRITE_MARGIN_MS = 3_000;

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as QueryResult<T>).rows;
}

export interface TutorHintWorkerOptions {
  readonly db: PersistenceDb;
  /** The worker's environment: the inference endpoint and the tutor audience. Defaults to process.env. */
  readonly env?: Environment;
  /** Tests may supply the generation step; the worker uses ONE AI Orchestration from the environment. */
  readonly generate?: (request: GenerationRequest) => Promise<GenerationRecord>;
}

export type TutorHintJobOutcome = 'SHOWN' | FallbackReason | 'NOTHING_TO_DO';

interface HintContext {
  id: string; subject_user_id: string; institution_id: string | null; decision_id: string; item_id: string; hint_level: number; language: string;
  status: string; correlation_id: string; age_ms: number; answered: boolean; prompt: string; options: unknown; correct_option_id: string | null;
  hint_1: string | null; hint_2: string | null; hint_3: string | null; hint_4: string | null;
}

async function loadContext(db: PersistenceDb, tutorHintId: string): Promise<HintContext | null> {
  const [row] = await rows<HintContext>(db, sql`
    SELECT h.id::text AS id, h.subject_user_id::text AS subject_user_id, h.institution_id::text AS institution_id, h.decision_id::text AS decision_id,
           h.item_id::text AS item_id, h.hint_level, h.language, h.status, h.correlation_id,
           (extract(epoch FROM (now() - h.requested_at)) * 1000)::float8 AS age_ms,
           EXISTS (SELECT 1 FROM learning_attempt_events e WHERE e.source_attempt_type = 'learning_step'
                     AND e.source_attempt_id = h.decision_id AND e.item_id = h.item_id) AS answered,
           q.prompt, q.options, k.correct_option_id, l.hint_1, l.hint_2, l.hint_3, l.hint_4
    FROM tutor_hints h
    JOIN question_versions q ON q.id = h.item_id
    LEFT JOIN question_answer_keys k ON k.question_version_id = q.id
    LEFT JOIN question_hint_ladders l ON l.question_revision_id = q.content_revision_id AND l.review_state = 'PUBLISHED'
    WHERE h.id = ${tutorHintId}::uuid
  `);
  return row ?? null;
}

function optionsOf(value: unknown): { id: string; text: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (!option || typeof option !== 'object') return [];
    const { id, text } = option as { id?: unknown; text?: unknown };
    return typeof id === 'string' && typeof text === 'string' ? [{ id, text }] : [];
  });
}

function failureReason(error: unknown): FallbackReason {
  // Off, stopped, over the feature's cap, or no endpoint configured: AI is unavailable, not broken.
  if (error instanceof AiFeatureDisabledError || error instanceof AiCapExceededError || error instanceof InferenceUnconfiguredError) return 'AI_UNAVAILABLE';
  return 'GENERATION_FAILED';
}

interface Completion {
  readonly reason: FallbackReason | null;
  readonly guard: TutorGuardResult | null;
  readonly generation: GenerationRecord | null;
  readonly model: string | null;
  readonly rawText: string | null;
}

/**
 * Records the outcome once, under the consumer receipt. A shown hint must still be inside its window
 * at commit (database clock); a late one is kept for audit and marked EXPIRED. With nothing claimed,
 * an abandoned GENERATING row past its window is closed as EXPIRED.
 */
async function finish(db: PersistenceDb, event: IntegrationEventEnvelope, context: HintContext, completion: Completion | null): Promise<{ executed: boolean; result?: TutorHintJobOutcome }> {
  return handleEventIdempotently(db, {
    consumerName: TUTOR_HINT_CONSUMER,
    eventId: event.eventId,
    failureClass: 'TUTOR_HINT_RECORD_FAILED',
    effect: async (tx) => {
      if (!completion) {
        const closed = await rows<{ id: string }>(tx, sql`
          UPDATE tutor_hints SET status = 'FALLBACK', fallback_reason = 'EXPIRED', completed_at = now()
          WHERE id = ${context.id}::uuid AND status IN ('PENDING','GENERATING')
            AND requested_at <= now() - make_interval(secs => ${TUTOR_HINT_PENDING_SECONDS})
          RETURNING id::text AS id
        `);
        if (closed.length) await audit(tx, context, 'EXPIRED', []);
        return closed.length ? 'EXPIRED' : 'NOTHING_TO_DO';
      }
      const guard = completion.guard;
      const shown = guard?.outcome === 'SHOW';
      const reason: FallbackReason | null = completion.reason
        ?? (guard?.outcome === 'REFUSED' ? 'GUARD_REFUSED' : guard?.outcome === 'REDIRECTED' ? 'REDIRECTED' : null);
      const text = guard ? (guard.text ?? completion.rawText) : completion.rawText;
      const generation = completion.generation;
      const findings = guard?.outcome === 'REFUSED' ? guard.findings : [];
      const repairs = guard?.outcome === 'SHOW' ? guard.repairs : [];
      const keepText = generation !== null && completion.model !== null && text !== null && text.trim().length > 0;
      const [updated] = await rows<{ status: string; fallback_reason: string | null }>(tx, sql`
        UPDATE tutor_hints SET
          status = CASE WHEN ${shown} AND requested_at > now() - make_interval(secs => ${TUTOR_HINT_PENDING_SECONDS}) THEN 'SHOWN' ELSE 'FALLBACK' END,
          fallback_reason = CASE WHEN ${shown} AND requested_at > now() - make_interval(secs => ${TUTOR_HINT_PENDING_SECONDS}) THEN NULL
                                 ELSE COALESCE(${reason}, 'EXPIRED') END,
          guard_findings = ${`{${findings.join(',')}}`}::text[],
          guard_repairs = ${`{${repairs.join(',')}}`}::text[],
          guard_version = ${guard?.guardVersion ?? null},
          generated_text = ${keepText ? text!.slice(0, 4000) : null},
          generated_at = ${keepText ? generation!.generatedAt : null}::timestamptz,
          generator_version = ${keepText ? generation!.generatorVersion : null},
          prompt_fingerprint = ${keepText ? generation!.promptFingerprint : null},
          model = ${keepText ? completion.model : null},
          completed_at = now()
        WHERE id = ${context.id}::uuid AND status = 'GENERATING'
        RETURNING status, fallback_reason
      `);
      if (!updated) return 'NOTHING_TO_DO';
      const outcome: TutorHintJobOutcome = updated.status === 'SHOWN' ? 'SHOWN' : (updated.fallback_reason as FallbackReason);
      await audit(tx, context, outcome, findings);
      return outcome;
    },
  });
}

/**
 * Records how the job ended: outcome and the guard's codes, never the text. The actor is the student whose
 * request the job carried out (audit rows always have one); `by` names the worker.
 */
async function audit(db: PersistenceDb, context: HintContext, outcome: string, findings: readonly string[]): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${context.subject_user_id}::uuid, 'tutor.hint.completed', 'tutor_hint', ${context.id}, ${context.institution_id}::uuid, 'SUCCESS',
      ${context.correlation_id}, ${JSON.stringify({ by: TUTOR_HINT_CONSUMER, outcome, findings, level: Number(context.hint_level) })}::jsonb)
  `);
}

/** Closes a request without a model call (still PENDING), under the receipt. */
async function closeWithoutCall(db: PersistenceDb, event: IntegrationEventEnvelope, context: HintContext, reason: FallbackReason): Promise<{ executed: boolean; result?: TutorHintJobOutcome }> {
  return handleEventIdempotently(db, {
    consumerName: TUTOR_HINT_CONSUMER,
    eventId: event.eventId,
    failureClass: 'TUTOR_HINT_RECORD_FAILED',
    effect: async (tx) => {
      const closed = await rows<{ id: string }>(tx, sql`
        UPDATE tutor_hints SET status = 'FALLBACK', fallback_reason = ${reason}, completed_at = now()
        WHERE id = ${context.id}::uuid AND status = 'PENDING' RETURNING id::text AS id
      `);
      if (!closed.length) return 'NOTHING_TO_DO' as const;
      await audit(tx, context, reason, []);
      return reason;
    },
  });
}

/** The outbox consumer for `tutor.hint.requested` v1. */
export async function consumeTutorHintRequested(options: TutorHintWorkerOptions, event: IntegrationEventEnvelope): Promise<{ readonly executed: boolean; readonly outcome?: TutorHintJobOutcome }> {
  if (event.eventType !== TUTOR_HINT_REQUESTED || event.eventVersion !== 1) throw new Error('event is outside the tutor hint consumer contract');
  const tutorHintId = typeof event.payload.tutorHintId === 'string' ? event.payload.tutorHintId : '';
  if (!UUID.test(tutorHintId) || event.aggregateId !== tutorHintId) throw new Error('invalid tutor hint event');
  const db = options.db;
  const env = options.env ?? process.env;
  const context = await loadContext(db, tutorHintId);
  if (!context) throw new Error('tutor hint not found');

  const shape = (result: { executed: boolean; result?: TutorHintJobOutcome }) =>
    ({ executed: result.executed, ...(result.result ? { outcome: result.result } : {}) });

  if (context.status !== 'PENDING') return shape(await finish(db, event, context, null));

  // Re-check everything that may have changed since the request; none of these call the model.
  const windowMs = TUTOR_HINT_PENDING_SECONDS * 1000;
  const remainingMs = windowMs - Number(context.age_ms) - WRITE_MARGIN_MS;
  const ladder = [context.hint_1, context.hint_2, context.hint_3, context.hint_4];
  if (remainingMs <= 0) return shape(await closeWithoutCall(db, event, context, 'EXPIRED'));
  if (context.answered) return shape(await closeWithoutCall(db, event, context, 'WITHDRAWN'));
  if (tutorAudienceFromEnvironment(env) !== 'SANDBOX') return shape(await closeWithoutCall(db, event, context, 'AI_UNAVAILABLE'));
  if (!(await hasConsentPurpose(db, context.subject_user_id, 'ai-tutoring'))) return shape(await closeWithoutCall(db, event, context, 'AI_UNAVAILABLE'));
  if (!context.correct_option_id || ladder.some((hint) => typeof hint !== 'string')) return shape(await closeWithoutCall(db, event, context, 'AI_UNAVAILABLE'));

  // Claim: only one worker ever calls the model for a request.
  const claimed = await rows<{ id: string }>(db, sql`
    UPDATE tutor_hints SET status = 'GENERATING' WHERE id = ${context.id}::uuid AND status = 'PENDING' RETURNING id::text AS id
  `);
  if (!claimed.length) return shape(await finish(db, event, context, null));

  let completion: Completion;
  const brief = buildTutorBrief({
    questionPrompt: context.prompt, options: optionsOf(context.options), correctOptionId: context.correct_option_id,
    publishedLadder: ladder as string[], level: Number(context.hint_level), language: context.language,
  });
  const pg = drizzleAsPgClient(db);
  const model = (await loadAiFeaturePolicy(pg, TUTOR_HINT_FEATURE_KEY))?.model ?? null;
  const generate = options.generate ?? ((request: GenerationRequest) => createWorkerAiOrchestrator({ db: pg, env }).orchestrator.generate(request));
  try {
    const generation = await generate({
      featureKey: TUTOR_HINT_FEATURE_KEY,
      promptKey: TUTOR_HINT_PROMPT.key,
      promptVersion: TUTOR_HINT_PROMPT.version,
      parameters: tutorPromptParameters(brief),
      subjectUserId: context.subject_user_id,
      correlationId: context.correlation_id,
      signal: AbortSignal.timeout(Math.max(1_000, Math.floor(remainingMs))),
    });
    const guard = guardTutorReply(generation.text, brief, { truncated: generation.truncated });
    completion = { reason: null, guard, generation, model, rawText: generation.text.trim() ? generation.text.trim() : null };
  } catch (error) {
    completion = { reason: failureReason(error), guard: null, generation: null, model, rawText: null };
  }
  return shape(await finish(db, event, context, completion));
}
