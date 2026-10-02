/**
 * Tutor hints (ENG-22, migration 0108) — the request side, the student's view and the staff review.
 *
 * Why this exists: a student stuck on a practice question can ask the AI tutor for the next hint. This
 * module is everything about that which is plain database work: whether the student may ask now (the
 * pure `tutor-hint-policy-v1` over what is stored and the deployment's audience), recording the request
 * with its outbox job in the step's transaction, what the step view shows for each hint level (the AI
 * hint, "being written", or the human hint for that level), and the staff sample and review.
 *
 * It never calls a model and never imports the orchestrator: the job is `tutor-hint-worker.ts`, run by
 * the outbox worker (CLAUDE.md: no model call in a request handler). It writes only `tutor_hints`,
 * `outbox_events` and `audit_events`; it never writes evidence, mastery, skill state, attempts or
 * readiness, and never reads readiness (a test holds it to that).
 *
 * Design: docs/architecture/tutor-hints-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createIntegrationEventEnvelope } from '@planthepath/events/src/index.js';
import {
  TUTOR_HINTS_PER_STUDENT_PER_DAY,
  TUTOR_HINT_FEATURE_KEY,
  TUTOR_HINT_PENDING_SECONDS,
  TUTOR_HINT_POLICY_VERSION,
  TUTOR_HINT_PROMPT,
  decideTutorHintRequest,
  tutorAudienceFromEnvironment,
  type TutorHintDecision,
  type TutorLanguage,
  type TutorRefusalReason,
} from '@planthepath/tutoring/src/index.js';
import { loadAiFeaturePolicy, loadAiKillSwitchEngaged } from './ai-orchestration.js';
import { hasConsentPurpose } from './consent-purposes.js';
import { drizzleAsPgClient } from './learning-attempts.js';
import { learnerLessonLanguage } from './lesson-languages.js';
import type { PersistenceDb } from './repositories.js';

export const TUTOR_HINT_REQUESTED = 'tutor.hint.requested' as const;
export const TUTOR_HINT_CONSUMER = 'tutor-hint-generator' as const;

type QueryResult<T> = { rows: T[] };
type Environment = Readonly<Record<string, string | undefined>>;

async function rows<T>(db: PersistenceDb, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(query)) as QueryResult<T>).rows;
}

// ---------------------------------------------------------------------------
// Views (what a student may see)
// ---------------------------------------------------------------------------

/** Why a student was shown the human hint instead of the AI one, in terms a screen can explain. */
export type TutorFallbackView = 'CHECKS_FAILED' | 'UNAVAILABLE' | 'TIMED_OUT' | 'NOT_A_HINT';

/** One shown hint level of a question. */
export interface StepHintView {
  readonly level: number;
  /** LADDER: the human hint was asked for. AI_TUTOR: the student asked the AI tutor for this level. */
  readonly source: 'LADDER' | 'AI_TUTOR';
  /** SHOWN: `text` is what to show. PENDING: the AI is still writing it. FALLBACK: `text` is the human hint. */
  readonly state: 'SHOWN' | 'PENDING' | 'FALLBACK';
  /** The AI hint when an AI hint is shown; the human hint otherwise; null while pending. */
  readonly text: string | null;
  readonly fallback: TutorFallbackView | null;
}

export interface TutorAvailabilityView {
  readonly available: boolean;
  /** Null when available. `OFF` means the screen shows no AI control at all. */
  readonly reason: TutorRefusalReason | null;
  /** AI hints left today; null where the tutor is off for this student. */
  readonly remainingToday: number | null;
}

export interface TutorHintRow {
  readonly level: number;
  readonly status: 'PENDING' | 'GENERATING' | 'SHOWN' | 'FALLBACK';
  readonly fallbackReason: string | null;
  readonly generatedText: string | null;
  /** The pending window has passed (database clock). */
  readonly expired: boolean;
}

export async function loadTutorHintRows(db: PersistenceDb, decisionId: string, itemId: string): Promise<TutorHintRow[]> {
  return (await rows<{ hint_level: number; status: TutorHintRow['status']; fallback_reason: string | null; generated_text: string | null; expired: boolean }>(db, sql`
    SELECT hint_level, status, fallback_reason, generated_text,
           (requested_at <= now() - make_interval(secs => ${TUTOR_HINT_PENDING_SECONDS})) AS expired
    FROM tutor_hints WHERE decision_id = ${decisionId}::uuid AND item_id = ${itemId}::uuid ORDER BY hint_level
  `)).map((row) => ({
    level: Number(row.hint_level), status: row.status, fallbackReason: row.fallback_reason, generatedText: row.generated_text, expired: row.expired === true,
  }));
}

function fallbackView(reason: string | null): TutorFallbackView {
  if (reason === 'GUARD_REFUSED') return 'CHECKS_FAILED';
  if (reason === 'REDIRECTED') return 'NOT_A_HINT';
  if (reason === 'EXPIRED') return 'TIMED_OUT';
  return 'UNAVAILABLE';
}

/**
 * The hint levels shown so far, each as the student sees it. A level the AI wrote and the guard passed
 * shows the AI text; a level still inside its window is pending; anything else shows the human hint for
 * that level. `hints` (the older contract, one text per level) carries the same texts, with the human
 * hint for a pending level, so a client that predates the tutor keeps working.
 */
export function composeHintEntries(ladder: readonly string[] | null, shownLevel: number, tutorRows: readonly TutorHintRow[]): {
  readonly entries: readonly StepHintView[];
  readonly hints: readonly string[];
} {
  if (!ladder) return { entries: [], hints: [] };
  const entries: StepHintView[] = [];
  const hints: string[] = [];
  for (let level = 1; level <= shownLevel; level += 1) {
    const human = ladder[level - 1] ?? '';
    const ai = tutorRows.find((row) => row.level === level);
    if (!ai) {
      entries.push({ level, source: 'LADDER', state: 'SHOWN', text: human, fallback: null });
      hints.push(human);
    } else if (ai.status === 'SHOWN' && ai.generatedText) {
      entries.push({ level, source: 'AI_TUTOR', state: 'SHOWN', text: ai.generatedText, fallback: null });
      hints.push(ai.generatedText);
    } else if ((ai.status === 'PENDING' || ai.status === 'GENERATING') && !ai.expired) {
      entries.push({ level, source: 'AI_TUTOR', state: 'PENDING', text: null, fallback: null });
      hints.push(human);
    } else {
      entries.push({ level, source: 'AI_TUTOR', state: 'FALLBACK', text: human, fallback: ai.status === 'FALLBACK' ? fallbackView(ai.fallbackReason) : 'TIMED_OUT' });
      hints.push(human);
    }
  }
  return { entries, hints };
}

// ---------------------------------------------------------------------------
// The policy over stored data
// ---------------------------------------------------------------------------

export interface TutorPolicyContext {
  readonly subjectUserId: string;
  readonly decisionId: string;
  readonly itemId: string;
  readonly sessionMode: string;
  readonly ladderPublished: boolean;
  readonly currentLevel: number;
  readonly env?: Environment;
}

/** Reads everything the policy needs (no cache: consent, the switch and the kill switch apply on the next request). */
export async function decideTutorHintFromStore(db: PersistenceDb, context: TutorPolicyContext): Promise<{
  readonly decision: TutorHintDecision; readonly requestedToday: number;
}> {
  const pg = drizzleAsPgClient(db);
  const audience = tutorAudienceFromEnvironment(context.env ?? process.env);
  const policy = await loadAiFeaturePolicy(pg, TUTOR_HINT_FEATURE_KEY);
  const killSwitchEngaged = await loadAiKillSwitchEngaged(pg);
  const consented = await hasConsentPurpose(db, context.subjectUserId, 'ai-tutoring');
  const language = await learnerLessonLanguage(pg, context.subjectUserId);
  const [counts] = await rows<{ pending: boolean; today: number }>(db, sql`
    SELECT
      EXISTS (SELECT 1 FROM tutor_hints WHERE decision_id = ${context.decisionId}::uuid AND item_id = ${context.itemId}::uuid
                AND status IN ('PENDING','GENERATING') AND requested_at > now() - make_interval(secs => ${TUTOR_HINT_PENDING_SECONDS})) AS pending,
      (SELECT count(*)::int FROM tutor_hints WHERE subject_user_id = ${context.subjectUserId}::uuid AND requested_at >= date_trunc('day', now())) AS today
  `);
  const requestedToday = Number(counts?.today ?? 0);
  const decision = decideTutorHintRequest({
    sessionMode: context.sessionMode,
    audience,
    featureEnabled: policy?.enabled === true,
    killSwitchEngaged,
    consented,
    language,
    ladderPublished: context.ladderPublished,
    currentLevel: context.currentLevel,
    pending: counts?.pending === true,
    requestedToday,
  });
  return { decision, requestedToday };
}

/** The availability a question shows. `OFF` and `NO_CONSENT` leave no count: the tutor is not theirs to use. */
export async function tutorAvailability(db: PersistenceDb, context: TutorPolicyContext): Promise<TutorAvailabilityView> {
  const { decision, requestedToday } = await decideTutorHintFromStore(db, context);
  const remaining = Math.max(0, TUTOR_HINTS_PER_STUDENT_PER_DAY - requestedToday);
  if (decision.allowed) return { available: true, reason: null, remainingToday: remaining };
  const counted = !['OFF', 'NO_CONSENT', 'ASSESSMENT_MODE'].includes(decision.reason);
  return { available: false, reason: decision.reason, remainingToday: counted ? remaining : null };
}

// ---------------------------------------------------------------------------
// Recording a request (inside the step transaction)
// ---------------------------------------------------------------------------

/** The policy refused the request; `reason` is what the screen explains. */
export class TutorHintRequestError extends Error {
  constructor(readonly reason: TutorRefusalReason) {
    super(`tutor hint refused: ${reason}`);
    this.name = 'TutorHintRequestError';
  }
}

/**
 * Records an allowed request at its level: the row (PENDING, DRAFT), the outbox job and the audit row.
 * The caller has already raised the step item's hint level in this transaction (the 0108 insert trigger
 * checks the two agree).
 */
export async function recordTutorHintRequest(db: PersistenceDb, input: {
  readonly subjectUserId: string;
  readonly institutionId: string | null;
  readonly decisionId: string;
  readonly itemId: string;
  readonly level: 1 | 2 | 3 | 4;
  readonly language: TutorLanguage;
  readonly correlationId: string;
}): Promise<string> {
  const id = randomUUID();
  const eventId = randomUUID();
  const payload = { tutorHintId: id };
  // Validates the payload against the registered schema before anything is written.
  createIntegrationEventEnvelope({
    eventId, eventType: TUTOR_HINT_REQUESTED, eventVersion: 1, occurredAt: new Date().toISOString(),
    aggregateId: id, correlationId: input.correlationId, payload,
  });
  await db.execute(sql`
    INSERT INTO tutor_hints (id, subject_user_id, institution_id, decision_id, item_id, hint_level, language, prompt_version, policy_version, correlation_id)
    VALUES (${id}::uuid, ${input.subjectUserId}::uuid, ${input.institutionId}::uuid, ${input.decisionId}::uuid, ${input.itemId}::uuid,
      ${input.level}, ${input.language}, ${`${TUTOR_HINT_PROMPT.key}@${TUTOR_HINT_PROMPT.version}`}, ${TUTOR_HINT_POLICY_VERSION}, ${input.correlationId})
  `);
  await db.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${eventId}::uuid, 'tutor_hint', ${id}::uuid, ${TUTOR_HINT_REQUESTED}, 1, ${JSON.stringify(payload)}::jsonb, ${input.subjectUserId}::uuid, ${input.correlationId})
  `);
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${randomUUID()}::uuid, ${input.subjectUserId}::uuid, 'tutor.hint.requested', 'tutor_hint', ${id}, ${input.institutionId}::uuid, 'SUCCESS',
      ${input.correlationId}, ${JSON.stringify({ level: input.level, language: input.language, policyVersion: TUTOR_HINT_POLICY_VERSION })}::jsonb)
  `);
  return id;
}

// ---------------------------------------------------------------------------
// Staff audit and sampling (AI Operations)
// ---------------------------------------------------------------------------

export const TUTOR_REVIEW_VIEWS = ['sample', 'refused', 'reviewed'] as const;
export type TutorReviewListView = (typeof TUTOR_REVIEW_VIEWS)[number];
export const TUTOR_REVIEW_APPROVE_REASONS = ['ACCURATE_AND_SAFE'] as const;
export const TUTOR_REVIEW_REJECT_REASONS = ['LEAKS_ANSWER', 'WRONG_CONTENT', 'WRONG_LEVEL', 'WRONG_LANGUAGE', 'UNSAFE', 'POOR_TEACHING'] as const;
export const TUTOR_SAMPLE_SIZE = 20;

export interface TutorHintReviewRow {
  readonly id: string;
  readonly requestedAt: string;
  readonly level: number;
  readonly language: string;
  readonly status: string;
  readonly fallbackReason: string | null;
  readonly guardFindings: readonly string[];
  readonly generatedText: string | null;
  /** The question (content), so the reviewer can judge the hint. Never anything about the student. */
  readonly questionPrompt: string;
  readonly model: string | null;
  readonly promptVersion: string;
  readonly guardVersion: string | null;
  readonly reviewState: string;
  readonly reviewReasonCode: string | null;
}

/**
 * Hints for staff review. `sample`: up to 20 completed DRAFT hints from the last 7 days, in an order
 * fixed for the day (two reviewers see the same sample). `refused`: recent fallbacks with the guard's
 * findings. `reviewed`: recent verdicts. No student identity is returned.
 */
export async function listTutorHintsForReview(db: PersistenceDb, input: { readonly view: TutorReviewListView; readonly limit: number }): Promise<{
  readonly hints: readonly TutorHintReviewRow[];
  readonly counts: { readonly shown7d: number; readonly fallback7d: number; readonly published: number; readonly rejected: number };
}> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), 200);
  const filter = input.view === 'sample'
    ? sql`h.review_state = 'DRAFT' AND h.status IN ('SHOWN','FALLBACK') AND h.generated_text IS NOT NULL AND h.requested_at >= now() - interval '7 days'`
    : input.view === 'refused'
      ? sql`h.status = 'FALLBACK' AND h.requested_at >= now() - interval '7 days'`
      : sql`h.review_state <> 'DRAFT'`;
  const order = input.view === 'sample'
    ? sql`md5(h.id::text || to_char(now(), 'YYYY-MM-DD')), h.id`
    : input.view === 'refused' ? sql`h.requested_at DESC, h.id` : sql`h.reviewed_at DESC, h.id`;
  const take = input.view === 'sample' ? Math.min(limit, TUTOR_SAMPLE_SIZE) : limit;
  const found = await rows<{
    id: string; requested_at: Date | string; hint_level: number; language: string; status: string; fallback_reason: string | null;
    guard_findings: string[]; generated_text: string | null; prompt: string; model: string | null; prompt_version: string; guard_version: string | null;
    review_state: string; review_reason_code: string | null;
  }>(db, sql`
    SELECT h.id::text AS id, h.requested_at, h.hint_level, h.language, h.status, h.fallback_reason, h.guard_findings, h.generated_text,
           q.prompt, h.model, h.prompt_version, h.guard_version, h.review_state, h.review_reason_code
    FROM tutor_hints h JOIN question_versions q ON q.id = h.item_id
    WHERE ${filter}
    ORDER BY ${order}
    LIMIT ${take}
  `);
  const [counts] = await rows<{ shown7d: number; fallback7d: number; published: number; rejected: number }>(db, sql`
    SELECT count(*) FILTER (WHERE status = 'SHOWN' AND requested_at >= now() - interval '7 days')::int AS shown7d,
           count(*) FILTER (WHERE status = 'FALLBACK' AND requested_at >= now() - interval '7 days')::int AS fallback7d,
           count(*) FILTER (WHERE review_state = 'PUBLISHED')::int AS published,
           count(*) FILTER (WHERE review_state = 'REJECTED')::int AS rejected
    FROM tutor_hints
  `);
  return {
    hints: found.map((row) => ({
      id: row.id, requestedAt: new Date(row.requested_at).toISOString(), level: Number(row.hint_level), language: row.language, status: row.status,
      fallbackReason: row.fallback_reason, guardFindings: row.guard_findings ?? [], generatedText: row.generated_text, questionPrompt: row.prompt,
      model: row.model, promptVersion: row.prompt_version, guardVersion: row.guard_version, reviewState: row.review_state, reviewReasonCode: row.review_reason_code,
    })),
    counts: {
      shown7d: Number(counts?.shown7d ?? 0), fallback7d: Number(counts?.fallback7d ?? 0),
      published: Number(counts?.published ?? 0), rejected: Number(counts?.rejected ?? 0),
    },
  };
}

export class TutorHintReviewError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'NOT_REVIEWABLE' | 'ALREADY_REVIEWED' | 'INVALID_REASON') {
    super(`tutor hint review: ${code}`);
    this.name = 'TutorHintReviewError';
  }
}

/** A staff verdict on one hint: DRAFT → PUBLISHED (approve) or REJECTED (reject), once, audited. */
export async function reviewTutorHint(db: PersistenceDb, actor: { readonly userId: string; readonly correlationId: string; readonly breakGlass: boolean }, input: {
  readonly tutorHintId: string; readonly verdict: 'APPROVE' | 'REJECT'; readonly reasonCode: string;
}): Promise<{ readonly id: string; readonly reviewState: 'PUBLISHED' | 'REJECTED' }> {
  const reasons: readonly string[] = input.verdict === 'APPROVE' ? TUTOR_REVIEW_APPROVE_REASONS : TUTOR_REVIEW_REJECT_REASONS;
  if (!reasons.includes(input.reasonCode)) throw new TutorHintReviewError('INVALID_REASON');
  return db.transaction(async (tx) => {
    const runner = tx as unknown as PersistenceDb;
    const [row] = await rows<{ status: string; review_state: string; generated_text: string | null; institution_id: string | null }>(runner, sql`
      SELECT status, review_state, generated_text, institution_id::text AS institution_id FROM tutor_hints WHERE id = ${input.tutorHintId}::uuid FOR UPDATE
    `);
    if (!row) throw new TutorHintReviewError('NOT_FOUND');
    if (row.review_state !== 'DRAFT') throw new TutorHintReviewError('ALREADY_REVIEWED');
    if (!row.generated_text || (row.status !== 'SHOWN' && row.status !== 'FALLBACK')) throw new TutorHintReviewError('NOT_REVIEWABLE');
    const reviewState = input.verdict === 'APPROVE' ? 'PUBLISHED' : 'REJECTED';
    await runner.execute(sql`
      UPDATE tutor_hints SET review_state = ${reviewState}, reviewed_by_user_id = ${actor.userId}::uuid, reviewed_at = now(), review_reason_code = ${input.reasonCode}
      WHERE id = ${input.tutorHintId}::uuid
    `);
    await runner.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
      VALUES (${randomUUID()}::uuid, ${actor.userId}::uuid, 'tutor.hint.reviewed', 'tutor_hint', ${input.tutorHintId}, NULL, 'SUCCESS', ${actor.correlationId},
        ${JSON.stringify({ verdict: input.verdict, reviewState, reasonCode: input.reasonCode, ...(actor.breakGlass ? { break_glass: true } : {}) })}::jsonb)
    `);
    return { id: input.tutorHintId, reviewState };
  });
}
