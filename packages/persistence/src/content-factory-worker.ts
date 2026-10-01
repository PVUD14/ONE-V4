/**
 * The content factory's worker (ENG-23): runs queued `ai_content_drafts` jobs through ONE AI
 * Orchestration and lands what passes the guard in the existing editors as a DRAFT.
 *
 * Why this exists: CLAUDE.md — generation is a job, never a call from a controller, and anything a
 * model writes lands as DRAFT, with provenance, for a person to publish. For workers and jobs only:
 * like `ai-workers.ts`, no file under apps/ may import it (apps/api/src/inference-boundary.spec.ts).
 *
 * One job, in order:
 *   1. claim it (QUEUED, or RUNNING with an expired lease) under SKIP LOCKED, with a 10-minute lease;
 *   2. read its target as it is now — a skill retired, a base lesson archived or a question moved
 *      on since the request ends the job FAILED / TARGET_CHANGED without a call;
 *   3. outside any transaction, ask the orchestrator, which checks the kill switch, the feature's
 *      switch, its cap and the input size before any call (typed refusals end the job REFUSED);
 *   4. guard the reply in code (content-guard-v1): a refusal by the model ends it REFUSED, a finding
 *      ends it REJECTED with the codes, and nothing lands;
 *   5. in one transaction, create the lesson, variant or question through the editors' own functions
 *      — authored by the requester, so they never review, approve or publish it — or record the
 *      answer check, then finish the job, audit it and emit `content_factory.draft_finished`.
 *
 * Design: docs/architecture/content-factory-design.md
 */
import { sql } from 'drizzle-orm';
import {
  AiCapExceededError,
  AiFeatureDisabledError,
  AiInputTooLargeError,
  AiKillSwitchEngagedError,
  InferenceProviderError,
  type GenerationRecord,
  type GenerationRequest,
} from '@planthepath/ai-orchestration/src/index.js';
import { CONTENT_GUARD_VERSION, guardAnswerCheck, guardItemDraft, guardLessonDraft } from '@planthepath/ai-evaluation/src/content-guard.js';
import {
  LESSON_LANGUAGE_NAMES,
  LESSON_LEVEL_MEANINGS,
  LESSON_STYLE_MEANINGS,
  QUESTION_DIFFICULTY_MEANINGS,
  readLessonDraftFields,
  readQuestionDraftFields,
  type LessonLanguage,
  type LessonLevel,
  type LessonStyle,
  type QuestionDifficulty,
} from '@planthepath/career-readiness';
import type { AiDraftBody } from './ai-draft-provenance.js';
import {
  contentDraftPrompts,
  liveBaseLesson,
  writeAudit,
  writeOutbox,
  type ContentDraftKind,
  type ContentDraftState,
  type ContentFactoryActor,
  type SqlRunner,
  type TransactionalRunner,
} from './content-factory.js';
import { createLesson, createLessonVariant, LessonEditorError, saveLessonDraft } from './lesson-editor.js';
import { createQuestion, QuestionBankError, saveQuestionDraft } from './question-bank.js';

async function rows<T>(runner: SqlRunner, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await runner.execute(query)) as { rows: T[] }).rows;
}

/** What the worker needs of the orchestrator: one generation. */
export interface ContentDraftGenerator {
  generate(request: GenerationRequest): Promise<GenerationRecord>;
}

export const CONTENT_DRAFT_MAX_ATTEMPTS = 3;
const leaseMinutes = 10;
/** Provider failures worth another attempt later. A timeout is not: the model may still be generating (ENG-20). */
const retryableFailures = new Set(['PROVIDER_RATE_LIMITED', 'PROVIDER_SERVER_ERROR', 'PROVIDER_UNREACHABLE']);

export interface ClaimedContentDraft {
  readonly id: string;
  readonly kind: ContentDraftKind;
  readonly featureKey: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly topicId: string | null;
  readonly baseLessonId: string | null;
  readonly questionRevisionId: string | null;
  readonly stableKey: string | null;
  readonly title: string | null;
  readonly language: string;
  readonly level: string | null;
  readonly style: string | null;
  readonly authorNote: string | null;
  readonly requestedByUserId: string;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly attempts: number;
}

interface ClaimRow {
  id: string; kind: ContentDraftKind; feature_key: string; prompt_key: string; prompt_version: number; topic_id: string | null;
  base_lesson_id: string | null; question_revision_id: string | null; stable_key: string | null; title: string | null; language: string;
  level: string | null; style: string | null; author_note: string | null; requested_by_user_id: string; reason_code: string;
  correlation_id: string; attempts: number;
}

/**
 * Claim the oldest runnable job, or null. A RUNNING job whose lease expired (a worker died
 * mid-call) is claimed again; one that has used every attempt is ended FAILED first.
 */
export async function claimNextContentDraft(db: SqlRunner): Promise<ClaimedContentDraft | null> {
  await db.execute(sql`
    UPDATE ai_content_drafts SET state = 'FAILED', outcome_code = 'ATTEMPTS_EXHAUSTED'
    WHERE state = 'RUNNING' AND lease_expires_at <= now() AND attempts >= ${CONTENT_DRAFT_MAX_ATTEMPTS}
  `);
  const [row] = await rows<ClaimRow>(db, sql`
    WITH next AS (
      SELECT id FROM ai_content_drafts
      WHERE (state = 'QUEUED' OR (state = 'RUNNING' AND lease_expires_at <= now())) AND attempts < ${CONTENT_DRAFT_MAX_ATTEMPTS}
      ORDER BY requested_at, id LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ai_content_drafts d
    SET state = 'RUNNING', attempts = d.attempts + 1, lease_expires_at = now() + make_interval(mins => ${leaseMinutes})
    FROM next WHERE d.id = next.id
    RETURNING d.id, d.kind, d.feature_key, d.prompt_key, d.prompt_version, d.topic_id, d.base_lesson_id, d.question_revision_id,
              d.stable_key, d.title, d.language, d.level, d.style, d.author_note, d.requested_by_user_id, d.reason_code,
              d.correlation_id, d.attempts
  `);
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, featureKey: row.feature_key, promptKey: row.prompt_key, promptVersion: Number(row.prompt_version),
    topicId: row.topic_id, baseLessonId: row.base_lesson_id, questionRevisionId: row.question_revision_id, stableKey: row.stable_key,
    title: row.title, language: row.language, level: row.level, style: row.style, authorNote: row.author_note,
    requestedByUserId: row.requested_by_user_id, reasonCode: row.reason_code, correlationId: row.correlation_id, attempts: Number(row.attempts),
  };
}

export interface ContentDraftOutcome {
  readonly jobId: string;
  readonly kind: ContentDraftKind;
  readonly state: ContentDraftState;
  readonly outcomeCode: string | null;
  readonly findings: readonly string[];
  readonly producedRevisionId: string | null;
}

// ---------------------------------------------------------------------------
// Targets and prompt parameters
// ---------------------------------------------------------------------------

interface Target {
  readonly parameters: Readonly<Record<string, string>>;
  /** Lessons: prompts of every question on the skill, which a lesson must not copy. */
  readonly assessmentPrompts: readonly string[];
  readonly topicKey: string | null;
  /** Answer checks: the revision's options, key and content hash now. */
  readonly question: { readonly optionIds: readonly string[]; readonly correctOptionId: string; readonly contentHash: string } | null;
}

const noteOrNone = (note: string | null): string => note ?? 'None.';

async function skill(runner: SqlRunner, topicId: string): Promise<{ readonly key: string; readonly name: string; readonly description: string } | null> {
  const [row] = await rows<{ stable_key: string; name: string; description: string; active: boolean; pointer_state: string }>(runner, sql`
    SELECT n.stable_key, n.name, n.description, n.active, p.state AS pointer_state
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id WHERE n.id = ${topicId}::uuid AND n.kind = 'TOPIC'`);
  if (!row) return null;
  const pending = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED'].includes(row.pointer_state);
  return row.active || pending ? { key: row.stable_key, name: row.name, description: row.description } : null;
}

async function assessmentPromptsFor(runner: SqlRunner, topicId: string): Promise<readonly string[]> {
  const found = await rows<{ prompt: string | null }>(runner, sql`
    SELECT body ->> 'prompt' AS prompt FROM content_revisions WHERE entity_type = 'QUESTION' AND body ->> 'topicId' = ${topicId}`);
  return found.map((row) => row.prompt ?? '').filter((prompt) => prompt.length > 0);
}

function levelDescriptor(level: string | null, style: string | null): string {
  const levelText = level && level in LESSON_LEVEL_MEANINGS ? `${LESSON_LEVEL_MEANINGS[level as LessonLevel]}` : 'The lesson as written for most learners';
  const styleText = style && style in LESSON_STYLE_MEANINGS ? LESSON_STYLE_MEANINGS[style as LessonStyle] : 'Explains the idea in prose';
  return `${levelText}. Style: ${styleText.toLowerCase()}.`;
}

/** The target as it is now, and the prompt's parameters; null when it has changed so the job cannot run. */
async function targetFor(runner: SqlRunner, job: ClaimedContentDraft): Promise<Target | null> {
  const language = LESSON_LANGUAGE_NAMES[job.language as LessonLanguage] ?? 'English';
  if (job.kind === 'LESSON' || job.kind === 'QUESTION') {
    const found = job.topicId ? await skill(runner, job.topicId) : null;
    if (!found) return null;
    const common = { skillName: found.name, skillDescription: found.description, authorNote: noteOrNone(job.authorNote) };
    return job.kind === 'LESSON'
      ? { parameters: { ...common, language, levelDescriptor: levelDescriptor(job.level, job.style) }, assessmentPrompts: await assessmentPromptsFor(runner, job.topicId!), topicKey: found.key, question: null }
      : {
        parameters: { ...common, difficultyDescriptor: `${QUESTION_DIFFICULTY_MEANINGS[job.level as QuestionDifficulty] ?? 'Applies the idea to an ordinary case'}.` },
        assessmentPrompts: [], topicKey: found.key, question: null,
      };
  }
  if (job.kind === 'LESSON_VARIANT') {
    const base = job.baseLessonId ? await liveBaseLesson(runner, job.baseLessonId) : 'NOT_FOUND';
    if (base === 'NOT_FOUND' || base === 'NOT_LIVE' || !base.topicId) return null;
    const found = await skill(runner, base.topicId);
    if (!found) return null;
    const fields = readLessonDraftFields(base.body);
    // The model renders the published English lesson, so the reviewer can compare like with like.
    const rendering = [
      ...(job.authorNote ? [job.authorNote, ''] : []),
      `Write this as a ${language} rendering of the published lesson "${fields.title}". Its English text:`,
      fields.summary,
      ...(fields.practice ? [fields.practice] : []),
    ].join('\n');
    return {
      parameters: { language, levelDescriptor: levelDescriptor(job.level, job.style), skillName: found.name, skillDescription: found.description, authorNote: rendering },
      assessmentPrompts: await assessmentPromptsFor(runner, base.topicId), topicKey: null, question: null,
    };
  }
  const [revision] = await rows<{ state: string; body: unknown; content_hash: string }>(runner, sql`
    SELECT state, body, content_hash FROM content_revisions WHERE id = ${job.questionRevisionId}::uuid AND entity_type = 'QUESTION'`);
  if (!revision || revision.state === 'ARCHIVED') return null;
  const fields = readQuestionDraftFields(revision.body);
  if (!fields.correctOptionId || fields.options.length < 2 || fields.options.some((option) => !option.text)) return null;
  return {
    parameters: { itemPrompt: fields.prompt, itemOptions: fields.options.map((option) => `${option.id}) ${option.text}`).join('\n') },
    assessmentPrompts: [], topicKey: null,
    question: { optionIds: fields.options.map((option) => option.id), correctOptionId: fields.correctOptionId, contentHash: revision.content_hash },
  };
}

// ---------------------------------------------------------------------------
// Finishing a job
// ---------------------------------------------------------------------------

interface Finish {
  readonly state: Exclude<ContentDraftState, 'QUEUED' | 'RUNNING'>;
  readonly outcomeCode: string | null;
  readonly findings?: readonly string[];
  readonly record?: GenerationRecord;
  readonly fitted?: boolean | null;
  readonly produced?: { readonly lessonId: string | null; readonly questionId: string | null; readonly revisionId: string };
  readonly check?: { readonly option: string; readonly working: string; readonly agrees: boolean; readonly contentHash: string };
}

const actorOf = (job: ClaimedContentDraft): ContentFactoryActor => ({ userId: job.requestedByUserId, correlationId: job.correlationId, breakGlass: false });

/** Another worker took the job over (this one's lease ran out): nothing this worker wrote may stand. */
export class ContentDraftLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`content draft job ${jobId} is no longer held by this worker`);
    this.name = 'ContentDraftLeaseLostError';
  }
}

async function finish(runner: SqlRunner, job: ClaimedContentDraft, outcome: Finish): Promise<ContentDraftOutcome> {
  const record = outcome.record;
  const updated = await rows<{ id: string }>(runner, sql`
    UPDATE ai_content_drafts SET
      state = ${outcome.state}, outcome_code = ${outcome.outcomeCode}, guard_findings = ${JSON.stringify(outcome.findings ?? [])}::jsonb,
      source = ${record ? 'AI_GENERATED' : null}, generator_version = ${record ? record.generatorVersion : null}, model = ${record ? record.model : null},
      generated_at = ${record ? record.generatedAt : null}::timestamptz, truncated = ${record ? record.truncated : null},
      fitted = ${record && outcome.fitted !== undefined ? outcome.fitted : null},
      produced_lesson_id = ${outcome.produced ? outcome.produced.lessonId : null}::uuid,
      produced_question_id = ${outcome.produced ? outcome.produced.questionId : null}::uuid,
      produced_revision_id = ${outcome.produced ? outcome.produced.revisionId : null}::uuid,
      check_option = ${outcome.check ? outcome.check.option : null}, check_working = ${outcome.check ? outcome.check.working : null},
      check_agrees = ${outcome.check ? outcome.check.agrees : null}, checked_content_hash = ${outcome.check ? outcome.check.contentHash : null},
      review_state = ${outcome.check ? 'DRAFT' : null}
    WHERE id = ${job.id}::uuid AND state = 'RUNNING' AND attempts = ${job.attempts}
    RETURNING id
  `);
  if (!updated.length) throw new ContentDraftLeaseLostError(job.id);
  const actor = actorOf(job);
  await writeAudit(runner, actor, 'operations.content.ai_draft_finished', job.id, {
    kind: job.kind, state: outcome.state, performedBy: 'content-factory-worker', attempt: job.attempts,
    ...(outcome.outcomeCode ? { outcomeCode: outcome.outcomeCode } : {}),
    ...(outcome.findings && outcome.findings.length ? { findings: outcome.findings } : {}),
    ...(record ? { model: record.model, promptVersion: record.promptVersion, generatorVersion: record.generatorVersion } : {}),
    ...(outcome.produced ? { producedRevisionId: outcome.produced.revisionId } : {}),
    ...(outcome.check ? { agreesWithKey: outcome.check.agrees } : {}),
  });
  await writeOutbox(runner, actor, job.id, 'content_factory.draft_finished', {
    jobId: job.id, kind: job.kind, state: outcome.state, ...(outcome.produced ? { producedRevisionId: outcome.produced.revisionId } : {}),
  });
  return {
    jobId: job.id, kind: job.kind, state: outcome.state, outcomeCode: outcome.outcomeCode, findings: outcome.findings ?? [],
    producedRevisionId: outcome.produced ? outcome.produced.revisionId : null,
  };
}

/** A failure worth retrying goes back to the queue; it ends FAILED on its last attempt. */
async function releaseOrFail(runner: SqlRunner, job: ClaimedContentDraft, failureClass: string): Promise<ContentDraftOutcome> {
  if (job.attempts < CONTENT_DRAFT_MAX_ATTEMPTS) {
    const released = await rows<{ id: string }>(runner, sql`
      UPDATE ai_content_drafts SET state = 'QUEUED', lease_expires_at = NULL
      WHERE id = ${job.id}::uuid AND state = 'RUNNING' AND attempts = ${job.attempts} RETURNING id`);
    if (!released.length) throw new ContentDraftLeaseLostError(job.id);
    return { jobId: job.id, kind: job.kind, state: 'QUEUED', outcomeCode: failureClass, findings: [], producedRevisionId: null };
  }
  return finish(runner, job, { state: 'FAILED', outcomeCode: failureClass });
}

function expertCheckFor(kind: ContentDraftKind, record: GenerationRecord): string {
  const what = kind === 'QUESTION' ? 'question, its answer, its explanation and every hint' : 'lesson';
  return `Drafted by ONE's AI (${record.promptVersion}, model ${record.model}) from the skill's name and description. `
    + `A reviewer checks every fact, example and number in this ${what} against a reliable source before approving, `
    + 'and the text is never shown to a student until a person publishes it.';
}

function aiDraftFor(job: ClaimedContentDraft, record: GenerationRecord, lesson?: { readonly sections: Readonly<Record<string, string>>; readonly fitted: boolean }): AiDraftBody {
  return {
    jobId: job.id, generatorVersion: record.generatorVersion, promptVersion: record.promptVersion, promptFingerprint: record.promptFingerprint,
    model: record.model, generatedAt: record.generatedAt, expertCheck: expertCheckFor(job.kind, record),
    ...(lesson ? { sections: lesson.sections, fitted: lesson.fitted } : {}),
    truncated: record.truncated, guardVersion: CONTENT_GUARD_VERSION,
  };
}

const basisFor = (record: GenerationRecord): string =>
  `Drafted by ONE's AI (${record.promptVersion}, model ${record.model}, ${record.generatedAt}) from the skill's name and description. Every claim needs checking against a reliable source.`;

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------

/** Run one claimed job to its end (or back to the queue for a retryable provider failure). */
export async function runContentDraft(input: {
  readonly db: TransactionalRunner;
  readonly generator: ContentDraftGenerator;
  readonly job: ClaimedContentDraft;
}): Promise<ContentDraftOutcome> {
  const { db, job } = input;
  const target = await targetFor(db, job);
  if (!target) return finish(db, job, { state: 'FAILED', outcomeCode: 'TARGET_CHANGED' });
  const prompt = contentDraftPrompts[job.kind];
  if (prompt.key !== job.promptKey || prompt.version !== job.promptVersion) return finish(db, job, { state: 'FAILED', outcomeCode: 'PROMPT_NOT_SUPPORTED' });

  let record: GenerationRecord;
  try {
    record = await input.generator.generate({
      featureKey: job.featureKey, promptKey: job.promptKey, promptVersion: job.promptVersion,
      parameters: target.parameters, correlationId: job.correlationId,
    });
  } catch (error) {
    // The kill switch is a kind of "disabled": test it first so the job says which.
    if (error instanceof AiKillSwitchEngagedError) return finish(db, job, { state: 'REFUSED', outcomeCode: 'KILL_SWITCH_ENGAGED' });
    if (error instanceof AiFeatureDisabledError) return finish(db, job, { state: 'REFUSED', outcomeCode: 'FEATURE_DISABLED' });
    if (error instanceof AiCapExceededError) return finish(db, job, { state: 'REFUSED', outcomeCode: 'CAP_EXCEEDED' });
    if (error instanceof AiInputTooLargeError) return finish(db, job, { state: 'REFUSED', outcomeCode: 'INPUT_TOO_LARGE' });
    if (error instanceof InferenceProviderError) {
      return retryableFailures.has(error.failureClass) ? releaseOrFail(db, job, error.failureClass) : finish(db, job, { state: 'FAILED', outcomeCode: error.failureClass });
    }
    return finish(db, job, { state: 'FAILED', outcomeCode: 'WORKER_ERROR' });
  }

  if (job.kind === 'ANSWER_CHECK') {
    const guarded = guardAnswerCheck({ text: record.text, truncated: record.truncated, optionIds: target.question!.optionIds });
    if (!guarded.ok || !guarded.value) return finish(db, job, { state: 'REJECTED', outcomeCode: 'GUARD_REJECTED', findings: guarded.findings, record });
    const check = guarded.value;
    return db.transaction((tx) => finish(tx, job, {
      state: 'SUCCEEDED', outcomeCode: null, record,
      check: { option: check.option, working: check.working, agrees: check.option === target.question!.correctOptionId, contentHash: target.question!.contentHash },
    }));
  }

  if (job.kind === 'QUESTION') {
    const guarded = guardItemDraft({ text: record.text, truncated: record.truncated });
    if (guarded.refused) return finish(db, job, { state: 'REFUSED', outcomeCode: 'MODEL_REFUSED', record });
    if (!guarded.ok || !guarded.value) return finish(db, job, { state: 'REJECTED', outcomeCode: 'GUARD_REJECTED', findings: guarded.findings, record });
    const item = guarded.value;
    return land(db, job, record, async (tx, actor) => {
      const created = await createQuestion(tx, {
        stableKey: job.stableKey!, topicKey: target.topicKey!, prompt: item.prompt, reasonCode: job.reasonCode, actor, aiDraft: aiDraftFor(job, record),
      });
      await saveQuestionDraft(tx, {
        revisionId: created.revisionId, actor,
        draft: {
          topicKey: target.topicKey!, prompt: item.prompt,
          options: item.options.map((option) => ({ id: option.id, text: option.text, misconception: null })),
          correctOptionId: item.correctOptionId, explanation: item.explanation, difficulty: job.level as QuestionDifficulty,
          hints: item.hints, licenceLabel: null, attribution: null, basis: basisFor(record),
        },
      });
      return { lessonId: null, questionId: created.questionId, revisionId: created.revisionId, fitted: null };
    });
  }

  const guarded = guardLessonDraft({ text: record.text, truncated: record.truncated, language: job.language, assessmentPrompts: target.assessmentPrompts });
  if (guarded.refused) return finish(db, job, { state: 'REFUSED', outcomeCode: 'MODEL_REFUSED', record });
  if (!guarded.ok || !guarded.value) return finish(db, job, { state: 'REJECTED', outcomeCode: 'GUARD_REJECTED', findings: guarded.findings, record });
  const lesson = guarded.value;
  return land(db, job, record, async (tx, actor) => {
    const aiDraft = aiDraftFor(job, record, { sections: lesson.sections, fitted: lesson.fitted });
    const created = job.kind === 'LESSON'
      ? await createLesson(tx, { stableKey: job.stableKey!, title: job.title!, level: job.level as LessonLevel, style: job.style as LessonStyle, reasonCode: job.reasonCode, actor, aiDraft })
      : await createLessonVariant(tx, {
        baseLessonId: job.baseLessonId!, variant: { language: job.language as LessonLanguage, level: job.level as LessonLevel, style: job.style as LessonStyle },
        title: job.title!, reasonCode: job.reasonCode, actor, aiDraft,
      });
    await saveLessonDraft(tx, {
      revisionId: created.revisionId, actor,
      draft: {
        title: job.title!, summary: lesson.summary, practice: lesson.practice || null, moduleKey: null,
        topicKey: job.kind === 'LESSON' ? target.topicKey : null, prerequisites: [], licenceLabel: null, attribution: null, basis: basisFor(record),
      },
    });
    return { lessonId: created.lessonId, questionId: null, revisionId: created.revisionId, fitted: lesson.fitted };
  });
}

/**
 * Write the draft and finish the job in one transaction. If the editor refuses (the key was taken,
 * the base lesson's variant appeared meanwhile), nothing lands and the job ends FAILED with the
 * editor's code; the generation stays metered.
 */
async function land(
  db: TransactionalRunner, job: ClaimedContentDraft, record: GenerationRecord,
  write: (tx: TransactionalRunner, actor: { readonly userId: string; readonly breakGlass: boolean; readonly correlationId: string }) => Promise<{
    readonly lessonId: string | null; readonly questionId: string | null; readonly revisionId: string; readonly fitted: boolean | null;
  }>,
): Promise<ContentDraftOutcome> {
  const actor = { userId: job.requestedByUserId, breakGlass: false, correlationId: job.correlationId };
  try {
    return await db.transaction(async (tx) => {
      const produced = await write(tx, actor);
      return finish(tx, job, {
        state: 'SUCCEEDED', outcomeCode: null, record, fitted: produced.fitted,
        produced: { lessonId: produced.lessonId, questionId: produced.questionId, revisionId: produced.revisionId },
      });
    });
  } catch (error) {
    if (error instanceof ContentDraftLeaseLostError) throw error;
    const code = error instanceof LessonEditorError || error instanceof QuestionBankError ? error.code : 'DRAFT_NOT_WRITTEN';
    return finish(db, job, { state: 'FAILED', outcomeCode: code.slice(0, 64) });
  }
}

/** Claim and run one job; null when the queue is empty. */
export async function runContentFactoryOnce(input: { readonly db: TransactionalRunner; readonly generator: ContentDraftGenerator }): Promise<ContentDraftOutcome | null> {
  const job = await claimNextContentDraft(input.db);
  if (!job) return null;
  return runContentDraft({ db: input.db, generator: input.generator, job });
}
