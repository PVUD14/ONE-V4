import { createHash } from 'node:crypto';

/**
 * Pure assessment-engine domain rules, ported from the ISMS assessment platform
 * (github.com/PVUD14/ISMS--Intreview-assesment) and adapted to ONE's idiom:
 * question lifecycle governance, blueprint validation, deterministic per-student
 * paper assembly, and objective scoring with negative marking.
 *
 * Deliberately free of database and transport concerns, mirroring the shape of
 * @planthepath/hiring. Persistence enforces the same invariants structurally;
 * this module is what produces a useful error before the database has to reject
 * anything, and what makes every paper and score reproducible from its seed.
 */

export type QuestionType =
  | 'SINGLE_CHOICE_MCQ' | 'MULTIPLE_SELECT' | 'TRUE_FALSE' | 'FILL_IN_THE_BLANK'
  | 'MATCH_THE_FOLLOWING' | 'ASSERTION_REASON' | 'SCENARIO_MCQ' | 'CODE_OUTPUT_MCQ' | 'NUMERICAL_MCQ';

export type QuestionDifficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type QuestionStatus = 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
export type AssessmentKind = 'MID_EXAM' | 'UNIT_TEST' | 'MOCK_TEST';
export type DefinitionState = 'DRAFT' | 'PUBLISHED' | 'CLOSED' | 'ARCHIVED';
export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'EXPIRED';

export const QUESTION_TYPES: readonly QuestionType[] = [
  'SINGLE_CHOICE_MCQ', 'MULTIPLE_SELECT', 'TRUE_FALSE', 'FILL_IN_THE_BLANK',
  'MATCH_THE_FOLLOWING', 'ASSERTION_REASON', 'SCENARIO_MCQ', 'CODE_OUTPUT_MCQ', 'NUMERICAL_MCQ',
];
export const ASSESSMENT_KINDS: readonly AssessmentKind[] = ['MID_EXAM', 'UNIT_TEST', 'MOCK_TEST'];

export class AssessmentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentRuleError';
  }
}

// ---------------------------------------------------------------------------
// Question authoring and lifecycle
// ---------------------------------------------------------------------------

export interface QuestionOptionInput {
  readonly key: string;
  readonly text: string;
  readonly isCorrect: boolean;
  readonly matchKey?: string | null;
}

export interface ObjectiveQuestionInput {
  readonly questionText: string;
  readonly questionType: QuestionType;
  readonly options?: readonly QuestionOptionInput[];
  readonly acceptedAnswers?: readonly string[];
}

const singleCorrectTypes: readonly QuestionType[] = ['SINGLE_CHOICE_MCQ', 'SCENARIO_MCQ', 'CODE_OUTPUT_MCQ', 'NUMERICAL_MCQ', 'ASSERTION_REASON'];

/** Structural validation for a question before it may enter the bank. */
export function validateObjectiveQuestion(input: ObjectiveQuestionInput): void {
  const options = input.options ?? [];
  const correct = options.filter((option) => option.isCorrect);
  const keys = new Set(options.map((option) => option.key));
  if (keys.size !== options.length) throw new AssessmentRuleError('Question option keys must be unique.');
  if (singleCorrectTypes.includes(input.questionType)) {
    if (options.length < 2 || correct.length !== 1) throw new AssessmentRuleError('This question type requires at least two options and exactly one correct answer.');
  } else if (input.questionType === 'MULTIPLE_SELECT') {
    if (options.length < 3 || correct.length < 2 || correct.length === options.length) throw new AssessmentRuleError('Multiple-select questions require at least two correct options and one distractor.');
  } else if (input.questionType === 'TRUE_FALSE') {
    const values = new Set(options.map((option) => option.text.trim().toLowerCase()));
    if (options.length !== 2 || !values.has('true') || !values.has('false') || correct.length !== 1) {
      throw new AssessmentRuleError('True/False questions require True and False options with one correct answer.');
    }
  } else if (input.questionType === 'FILL_IN_THE_BLANK') {
    if (!input.questionText.includes('_____')) throw new AssessmentRuleError('Fill-in-the-blank questions must contain _____.');
    if (!input.acceptedAnswers?.length || input.acceptedAnswers.some((answer) => !answer.trim())) {
      throw new AssessmentRuleError('Fill-in-the-blank questions require predefined accepted answers.');
    }
  } else if (input.questionType === 'MATCH_THE_FOLLOWING') {
    if (options.length < 2 || options.some((option) => !option.matchKey)) {
      throw new AssessmentRuleError('Match-the-following questions require at least two keyed pairs.');
    }
  }
}

const questionTransitions: Record<QuestionStatus, readonly QuestionStatus[]> = {
  DRAFT: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['DRAFT', 'ARCHIVED'],
  REJECTED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: [],
};

export function assertQuestionTransition(from: QuestionStatus, to: QuestionStatus): void {
  if (!(questionTransitions[from] ?? []).includes(to)) {
    throw new AssessmentRuleError(`A question cannot move from ${from} to ${to}.`);
  }
}

export function normalizeQuestionText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function questionHash(text: string): string {
  return createHash('sha256').update(normalizeQuestionText(text)).digest('hex');
}

/** Jaccard token similarity in [0,1], used to flag likely duplicates. */
export function textSimilarity(left: string, right: string): number {
  const a = new Set(normalizeQuestionText(left).split(' ').filter(Boolean));
  const b = new Set(normalizeQuestionText(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

// ---------------------------------------------------------------------------
// Definition lifecycle and blueprint validation
// ---------------------------------------------------------------------------

const definitionTransitions: Record<DefinitionState, readonly DefinitionState[]> = {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['CLOSED'],
  CLOSED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function assertDefinitionTransition(from: DefinitionState, to: DefinitionState): void {
  if (!(definitionTransitions[from] ?? []).includes(to)) {
    throw new AssessmentRuleError(`An assessment cannot move from ${from} to ${to}.`);
  }
}

export interface SectionRule {
  readonly title: string;
  readonly poolSize: number;
  readonly displayCount: number;
  readonly marksPerQuestion: number;
  readonly negativeMarks?: number;
}

/**
 * Blueprint integrity: whole-number pool/display counts, display within pool,
 * and section marks that reconcile exactly with the declared exam total.
 */
export function validateSectionCounts(sections: readonly SectionRule[], totalMarks: number, actualPoolCounts?: readonly number[]): { displayedQuestions: number; calculatedMarks: number } {
  if (!sections.length) throw new AssessmentRuleError('At least one assessment section is required.');
  sections.forEach((section, index) => {
    if (!Number.isInteger(section.poolSize) || !Number.isInteger(section.displayCount) || section.poolSize < 1 || section.displayCount < 1) {
      throw new AssessmentRuleError(`${section.title} requires positive whole-number pool and display counts.`);
    }
    if (section.displayCount > section.poolSize) throw new AssessmentRuleError(`${section.title} cannot display more questions than its pool.`);
    if (actualPoolCounts && actualPoolCounts[index] !== section.poolSize) {
      throw new AssessmentRuleError(`${section.title} must contain exactly ${section.poolSize} approved pool questions; found ${actualPoolCounts[index]}.`);
    }
  });
  const calculated = sections.reduce((sum, section) => sum + section.displayCount * section.marksPerQuestion, 0);
  if (Math.abs(calculated - totalMarks) > 0.0001) {
    throw new AssessmentRuleError(`Section marks total ${calculated}, but the assessment total is ${totalMarks}.`);
  }
  return { displayedQuestions: sections.reduce((sum, section) => sum + section.displayCount, 0), calculatedMarks: calculated };
}

export function validateAssessmentAvailability(startsAt: string | Date, endsAt: string | Date, now = Date.now()): void {
  if (now < new Date(startsAt).getTime()) throw new AssessmentRuleError('This assessment has not started yet.');
  if (now > new Date(endsAt).getTime()) throw new AssessmentRuleError('This assessment window has closed.');
}

export function validateAttemptLimit(attemptsUsed: number, attemptsAllowed: number): void {
  if (attemptsUsed >= attemptsAllowed) throw new AssessmentRuleError('No assessment attempts remain.');
}

// ---------------------------------------------------------------------------
// Deterministic paper assembly
// ---------------------------------------------------------------------------

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Fisher-Yates with a seeded generator: the same seed always yields the same order. */
export function deterministicShuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  const random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target] as T, result[index] as T];
  }
  return result;
}

/** Splits a count across difficulties by percentage, largest remainders first. */
export function allocateDifficulty(count: number, distribution: { EASY: number; MEDIUM: number; HARD: number }): QuestionDifficulty[] {
  const entries = (['EASY', 'MEDIUM', 'HARD'] as QuestionDifficulty[]).map((difficulty) => {
    const exact = count * distribution[difficulty] / 100;
    return { difficulty, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = count - entries.reduce((sum, entry) => sum + entry.count, 0);
  for (const entry of [...entries].sort((a, b) => b.remainder - a.remainder)) {
    if (!remaining) break;
    entry.count += 1;
    remaining -= 1;
  }
  return entries.flatMap((entry) => Array.from({ length: entry.count }, () => entry.difficulty));
}

export function selectBlueprintPool<T extends { difficulty: QuestionDifficulty }>(
  candidates: readonly T[],
  poolSize: number,
  distribution: { EASY: number; MEDIUM: number; HARD: number },
  seed: string,
): T[] {
  const allocation = allocateDifficulty(poolSize, distribution);
  const result: T[] = [];
  for (const difficulty of ['EASY', 'MEDIUM', 'HARD'] as QuestionDifficulty[]) {
    const needed = allocation.filter((value) => value === difficulty).length;
    const available = deterministicShuffle(candidates.filter((candidate) => candidate.difficulty === difficulty), `${seed}:${difficulty}`);
    if (available.length < needed) {
      throw new AssessmentRuleError(`Blueprint requires ${needed} ${difficulty} questions, but only ${available.length} approved questions are available.`);
    }
    result.push(...available.slice(0, needed));
  }
  return deterministicShuffle(result, `${seed}:pool`);
}

/** Chooses this attempt's displayed questions from a section pool, seeded per attempt. */
export function selectAttemptQuestions<T>(pool: readonly T[], displayCount: number, attemptSeed: string): T[] {
  if (pool.length < displayCount) throw new AssessmentRuleError(`Question pool has ${pool.length} questions but ${displayCount} must be displayed.`);
  return deterministicShuffle(pool, attemptSeed).slice(0, displayCount);
}

/** Per-attempt option shuffle: display key -> original key, seeded and reversible. */
export function buildOptionMap(optionKeys: readonly string[], seed: string): Record<string, string> {
  const shuffled = deterministicShuffle(optionKeys, seed);
  const map: Record<string, string> = {};
  shuffled.forEach((originalKey, index) => {
    const displayKey = optionKeys[index];
    if (displayKey !== undefined) map[displayKey] = originalKey;
  });
  return map;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface AnswerKey {
  readonly correctOptionKeys?: readonly string[];
  readonly acceptedAnswers?: readonly string[];
  readonly caseSensitive?: boolean;
  readonly matches?: Readonly<Record<string, string>>;
}

export interface ObjectiveQuestionForScoring {
  readonly questionType: QuestionType;
  readonly answerKey: AnswerKey;
  readonly marks: number;
  readonly negativeMarks?: number;
}

export interface AttemptResponse {
  readonly selectedOptionKeys?: readonly string[];
  readonly text?: string;
  readonly matches?: Readonly<Record<string, string>>;
}

/** Translates a response given in display keys back to the question's original keys. */
export function mapDisplayedResponse(questionType: QuestionType, response: AttemptResponse | null | undefined, optionMap: Readonly<Record<string, string>>): AttemptResponse | null | undefined {
  if (!response || questionType === 'FILL_IN_THE_BLANK') return response;
  if (questionType === 'MATCH_THE_FOLLOWING') {
    return { matches: Object.fromEntries(Object.entries(response.matches ?? {}).map(([displayKey, target]) => [optionMap[displayKey] ?? displayKey, target])) };
  }
  return { selectedOptionKeys: (response.selectedOptionKeys ?? []).map((displayKey) => optionMap[displayKey] ?? displayKey) };
}

export function gradeObjectiveAnswer(question: ObjectiveQuestionForScoring, response: AttemptResponse | null | undefined): { answered: boolean; isCorrect: boolean; marksAwarded: number } {
  let isCorrect = false;
  let answered = response !== undefined && response !== null;
  if (question.questionType === 'FILL_IN_THE_BLANK') {
    const value = String(response?.text ?? '').trim();
    answered = Boolean(value);
    const normalize = (item: string): string => question.answerKey.caseSensitive ? item.trim() : item.trim().toLowerCase();
    isCorrect = answered && (question.answerKey.acceptedAnswers ?? []).map(normalize).includes(normalize(value));
  } else if (question.questionType === 'MATCH_THE_FOLLOWING') {
    const expected = question.answerKey.matches ?? {};
    const received = response?.matches ?? {};
    answered = Object.keys(received).length > 0;
    isCorrect = answered
      && Object.keys(expected).length === Object.keys(received).length
      && Object.entries(expected).every(([key, value]) => received[key] === value);
  } else {
    const expected = [...(question.answerKey.correctOptionKeys ?? [])].sort();
    const received = [...(response?.selectedOptionKeys ?? [])].sort();
    answered = received.length > 0;
    isCorrect = answered && expected.length === received.length && expected.every((value, index) => value === received[index]);
  }
  return { answered, isCorrect, marksAwarded: !answered ? 0 : isCorrect ? question.marks : -Math.abs(question.negativeMarks ?? 0) };
}

export interface AttemptSummary {
  readonly score: number;
  readonly maxScore: number;
  readonly percentage: number;
  readonly correct: number;
  readonly wrong: number;
  readonly notAttempted: number;
}

export function summarizeAttempt(graded: readonly { answered: boolean; isCorrect: boolean; marksAwarded: number; marks: number }[]): AttemptSummary {
  const maxScore = graded.reduce((sum, entry) => sum + entry.marks, 0);
  const score = graded.reduce((sum, entry) => sum + entry.marksAwarded, 0);
  const correct = graded.filter((entry) => entry.answered && entry.isCorrect).length;
  const wrong = graded.filter((entry) => entry.answered && !entry.isCorrect).length;
  const notAttempted = graded.filter((entry) => !entry.answered).length;
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 10000) / 100 : 0;
  return { score, maxScore, percentage, correct, wrong, notAttempted };
}

/** How long an in-progress attempt may still run, honouring both duration and window. */
export function remainingSeconds(startedAt: string | Date, durationSeconds: number, windowEndsAt: string | Date, now = Date.now()): number {
  const byDuration = new Date(startedAt).getTime() + durationSeconds * 1000;
  const byWindow = new Date(windowEndsAt).getTime();
  return Math.max(0, Math.floor((Math.min(byDuration, byWindow) - now) / 1000));
}
