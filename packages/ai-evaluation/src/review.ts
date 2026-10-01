/**
 * The human review sheet for a bake-off run (ENG-21): a deterministic sample of replies for a person
 * to score on teaching quality, language quality and factual errors.
 *
 * Why this exists: text matching cannot tell a good hint from a useless one, or fluent Telugu from
 * word salad. A PASS for a feature people read needs a person's judgement, recorded against the
 * exact results file it was made from. The rubric is docs/ai/bake-off-human-review-rubric.md.
 *
 * Design: docs/architecture/ai-bake-off-design.md (Decision 4).
 */
import { createHash } from 'node:crypto';
import type { BakeOffResults } from './results.js';
import type { EvaluationCase, EvaluationLanguage, EvaluationSet, EvaluationTask } from './set-format.js';

export const REVIEW_FORMAT = 'one-bakeoff-review';
export const REVIEW_FORMAT_VERSION = 1;
export const REVIEW_RUBRIC_PATH = 'docs/ai/bake-off-human-review-rubric.md';

export type ReviewErrorCode = 'REVIEW_MALFORMED' | 'REVIEW_RESULTS_MISMATCH' | 'REVIEW_INCOMPLETE';

export class BakeOffReviewError extends Error {
  constructor(readonly code: ReviewErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'BakeOffReviewError';
  }
}

/** How many of each kind the sheet asks a person to score. */
const samplePlan: Readonly<Record<'tutor-hint' | 'lesson-draft', Readonly<Record<EvaluationLanguage, number>>>> = {
  'tutor-hint': { en: 18, te: 8, hi: 4 },
  'lesson-draft': { en: 10, te: 3, hi: 2 },
};

export type ReviewedTask = keyof typeof samplePlan;
export const reviewedTasks: readonly ReviewedTask[] = ['tutor-hint', 'lesson-draft'];

export interface ReviewScores {
  /** 1–5, the rubric's teaching-quality scale. */
  readonly teaching: number | null;
  /** 1–5 for Telugu and Hindi replies; "NA" for English. */
  readonly language: number | 'NA' | null;
  /** Whether the reply states anything factually or mathematically wrong. */
  readonly factualError: boolean | null;
}

export interface ReviewItem {
  readonly caseId: string;
  readonly task: ReviewedTask;
  readonly language: EvaluationLanguage;
  /** What the model was asked: the student's message or the skill, never the system prompt. */
  readonly asked: string;
  readonly reply: string;
  readonly scores: ReviewScores;
}

export interface ReviewSheet {
  readonly format: typeof REVIEW_FORMAT;
  readonly formatVersion: typeof REVIEW_FORMAT_VERSION;
  readonly resultsSha256: string;
  readonly model: string;
  readonly setKey: string;
  readonly setVersion: number;
  readonly rubric: string;
  readonly instructions: string;
  readonly items: readonly ReviewItem[];
}

function order(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

/** The sampled case ids for a run: legitimate (non-abuse) cases with a reply, in hash order, per language quota. */
export function reviewSample(set: EvaluationSet, results: BakeOffResults): readonly EvaluationCase[] {
  const answered = new Set(results.cases.filter((entry) => entry.output !== null).map((entry) => entry.id));
  const chosen: EvaluationCase[] = [];
  for (const task of reviewedTasks) {
    for (const language of ['en', 'te', 'hi'] as const) {
      const pool = set.cases
        .filter((entry) => entry.task === task && entry.language === language && entry.block !== 'ABUSE' && answered.has(entry.id))
        .sort((a, b) => order(a.id).localeCompare(order(b.id)));
      chosen.push(...pool.slice(0, samplePlan[task][language]));
    }
  }
  return chosen;
}

function asked(entry: EvaluationCase): string {
  const user = entry.request.messages.find((message) => message.role === 'user')?.content ?? '';
  return entry.task === 'tutor-hint' ? `[${entry.category}, item ${entry.source}] ${user}` : user;
}

export function buildReviewSheet(set: EvaluationSet, results: BakeOffResults, resultsSha256: string): ReviewSheet {
  const replies = new Map(results.cases.map((entry) => [entry.id, entry.output ?? '']));
  return {
    format: REVIEW_FORMAT,
    formatVersion: REVIEW_FORMAT_VERSION,
    resultsSha256,
    model: results.model,
    setKey: set.setKey,
    setVersion: set.setVersion,
    rubric: REVIEW_RUBRIC_PATH,
    instructions: 'Score every item with the rubric: teaching 1-5; language 1-5 for Telugu and Hindi (leave "NA" for English); factualError true or false. A person scores; a model never fills this in. Do not add names or personal data.',
    items: reviewSample(set, results).map((entry) => ({
      caseId: entry.id,
      task: entry.task as ReviewedTask,
      language: entry.language,
      asked: asked(entry),
      reply: replies.get(entry.id) ?? '',
      scores: { teaching: null, language: entry.language === 'en' ? 'NA' : null, factualError: null },
    })),
  };
}

export interface HumanMetrics {
  readonly reviewedCases: number;
  readonly teachingQuality: number;
  readonly languageQuality: number;
  readonly factualErrorRate: number;
}

function score(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

/**
 * Validate a filled sheet against the results it must have been made from, and compute the human
 * metrics per reviewed task. Every sampled item must be scored.
 */
export function readReviewSheet(raw: unknown, set: EvaluationSet, results: BakeOffResults, resultsSha256: string): Readonly<Record<ReviewedTask, HumanMetrics>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BakeOffReviewError('REVIEW_MALFORMED', 'not a review sheet');
  const sheet = raw as Partial<ReviewSheet>;
  if (sheet.format !== REVIEW_FORMAT || sheet.formatVersion !== REVIEW_FORMAT_VERSION || !Array.isArray(sheet.items)) {
    throw new BakeOffReviewError('REVIEW_MALFORMED', 'not a one-bakeoff-review v1 sheet');
  }
  if (sheet.resultsSha256 !== resultsSha256 || sheet.model !== results.model) {
    throw new BakeOffReviewError('REVIEW_RESULTS_MISMATCH', 'the sheet was made from a different results file');
  }
  const expected = reviewSample(set, results).map((entry) => entry.id);
  const items = sheet.items as unknown[];
  const ids = items.map((item) => (item && typeof item === 'object' ? (item as { caseId?: unknown }).caseId : undefined));
  if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
    throw new BakeOffReviewError('REVIEW_RESULTS_MISMATCH', 'the sheet does not list the sampled cases for these results');
  }
  const byTask: Record<ReviewedTask, { teaching: number[]; language: number[]; errors: number }> = {
    'tutor-hint': { teaching: [], language: [], errors: 0 },
    'lesson-draft': { teaching: [], language: [], errors: 0 },
  };
  const caseById = new Map(set.cases.map((entry) => [entry.id, entry]));
  for (const item of items as ReviewItem[]) {
    const entry = caseById.get(item.caseId)!;
    const scores = item.scores as Partial<ReviewScores> | undefined;
    if (!scores || !score(scores.teaching) || typeof scores.factualError !== 'boolean') {
      throw new BakeOffReviewError('REVIEW_INCOMPLETE', `case ${item.caseId} is not fully scored`);
    }
    if (entry.language === 'en' ? scores.language !== 'NA' : !score(scores.language)) {
      throw new BakeOffReviewError('REVIEW_INCOMPLETE', `case ${item.caseId} needs a language score (or "NA" for English)`);
    }
    const bucket = byTask[entry.task as ReviewedTask];
    bucket.teaching.push(scores.teaching);
    if (typeof scores.language === 'number') bucket.language.push(scores.language);
    if (scores.factualError) bucket.errors += 1;
  }
  const mean = (values: readonly number[]): number => (values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000 : 0);
  const summary = (task: ReviewedTask): HumanMetrics => {
    const bucket = byTask[task];
    return {
      reviewedCases: bucket.teaching.length,
      teachingQuality: mean(bucket.teaching),
      languageQuality: mean(bucket.language),
      factualErrorRate: bucket.teaching.length ? Math.round((bucket.errors / bucket.teaching.length) * 10000) / 10000 : 1,
    };
  };
  return { 'tutor-hint': summary('tutor-hint'), 'lesson-draft': summary('lesson-draft') };
}

export function isReviewedTask(task: EvaluationTask): task is ReviewedTask {
  return (reviewedTasks as readonly string[]).includes(task);
}
