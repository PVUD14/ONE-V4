/**
 * The shape of ONE's AI evaluation set (ENG-21): what the pod's harness sends and what the scorer
 * expects back. One JSON file, versioned, committed at deploy/ai-pod/bake-off/eval-set-v1.json (and, for ADR-052, eval-set-explain-v1.json).
 *
 * Why this exists: the harness (Python, on the pod) and the scorer (TypeScript, in the repository)
 * must agree on one format without sharing code, so the format is written down once, here.
 *
 * Design: docs/architecture/ai-bake-off-design.md (Decision 2).
 */
export const EVALUATION_SET_FORMAT = 'one-bakeoff-set';
export const EVALUATION_SET_FORMAT_VERSION = 1;
export const EVALUATION_SET_KEY = 'one-ai-bakeoff';
export const EVALUATION_SET_VERSION = 1;
/**
 * ADR-052: "Ask ONE to explain" is evaluated in its own set, so `one-ai-bakeoff` v1 stays byte for byte
 * what earlier results were scored against. Same file format; its own key and version.
 */
export const EXPLAIN_EVALUATION_SET_KEY = 'one-ai-explain';
export const EXPLAIN_EVALUATION_SET_VERSION = 1;

export const evaluationTasks = ['tutor-hint', 'lesson-draft', 'answer-check', 'explain-topic'] as const;
export type EvaluationTask = (typeof evaluationTasks)[number];

/** The plan's four blocks: 80 English STEM and cybersecurity, 60 Indian-language, 30 grading, 30 abuse. */
export const evaluationBlocks = ['ENGLISH', 'INDIAN_LANGUAGE', 'GRADING', 'ABUSE'] as const;
export type EvaluationBlock = (typeof evaluationBlocks)[number];

export const evaluationLanguages = ['en', 'te', 'hi'] as const;
export type EvaluationLanguage = (typeof evaluationLanguages)[number];

export interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

/** Exactly the body the ENG-20 adapter sends, less `model` and `stream`, which the harness adds. */
export interface CaseRequest {
  readonly messages: readonly ChatMessage[];
  readonly max_tokens: number;
  readonly temperature: number;
}

export interface LeakInput {
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly correctOptionId: string;
}

export type TutorReplyType = 'HINT' | 'REDIRECT';

export interface TutorExpectation {
  readonly kind: 'tutor-hint';
  /** Reply types that satisfy the case. Legitimate requests: HINT. Abuse: REDIRECT (an answer demand may also take a non-leaking HINT). */
  readonly accept: readonly TutorReplyType[];
  readonly leak: LeakInput;
  /** Regular expressions (flags `iu`) whose match counts as giving the answer away: confirming a named correct choice. */
  readonly leakPatterns: readonly string[];
  /** Regular expressions (flags `iu`) whose match counts as unsafe: echoing personal data, a readiness number. */
  readonly unsafePatterns: readonly string[];
}

export interface LessonExpectation {
  readonly kind: 'lesson-draft';
  /** LESSON for a legitimate request; REFUSED when the author's note asks for something the rules forbid. */
  readonly accept: 'LESSON' | 'REFUSED';
  readonly unsafePatterns: readonly string[];
}

export interface AnswerCheckExpectation {
  readonly kind: 'answer-check';
  readonly optionIds: readonly string[];
  readonly correctOptionId: string;
}

/** ADR-052: a lesson for a legitimate topic; one `REFUSED:` line for weapons, cheating, personal data, self-harm or chit-chat. */
export interface ExplainExpectation {
  readonly kind: 'explain-topic';
  readonly accept: 'LESSON' | 'REFUSED';
  readonly unsafePatterns: readonly string[];
}

export type CaseExpectation = TutorExpectation | LessonExpectation | AnswerCheckExpectation | ExplainExpectation;

export interface EvaluationCase {
  readonly id: string;
  readonly task: EvaluationTask;
  readonly block: EvaluationBlock;
  /** HINT_L1..HINT_L4, LESSON, ANSWER_CHECK, or the abuse category. */
  readonly category: string;
  /** The language the reply must be in (the student's or author's chosen language). */
  readonly language: EvaluationLanguage;
  /** The stable key of the item or skill the case is built from. */
  readonly source: string;
  readonly request: CaseRequest;
  /** Never sent to the model. */
  readonly expect: CaseExpectation;
}

export interface TaskBinding {
  readonly featureKey: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly promptFingerprint: string;
}

export interface EvaluationSet {
  readonly format: typeof EVALUATION_SET_FORMAT;
  readonly formatVersion: typeof EVALUATION_SET_FORMAT_VERSION;
  readonly setKey: string;
  readonly setVersion: number;
  readonly notice: string;
  readonly builtFrom: Readonly<Record<string, string>>;
  /** The tasks this set evaluates, and only those (v1: the first three; one-ai-explain: explain-topic). */
  readonly tasks: Readonly<Partial<Record<EvaluationTask, TaskBinding>>>;
  readonly cases: readonly EvaluationCase[];
}

/** The tasks a set evaluates, in `evaluationTasks` order. */
export function setTasks(set: Pick<EvaluationSet, 'tasks'>): readonly EvaluationTask[] {
  return evaluationTasks.filter((task) => set.tasks[task] !== undefined);
}

/** A task's binding in a set; throws for a task the set does not evaluate. */
export function taskBinding(set: Pick<EvaluationSet, 'tasks'>, task: EvaluationTask): TaskBinding {
  const binding = set.tasks[task];
  if (!binding) throw new Error(`the set does not evaluate ${task}`);
  return binding;
}
