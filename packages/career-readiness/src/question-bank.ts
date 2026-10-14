/**
 * The question bank's content rules — pure (OPS-09b).
 *
 * Why this exists: a readiness-check question is a versioned content revision whose body holds
 * the prompt, the options (each wrong one optionally tagged with a misconception), the answer key,
 * a difficulty band, a four-step hint ladder and the rights its text is under. These functions
 * read, normalise and validate that body with no database, so the API, the persistence layer and
 * the tests apply one set of rules — and `publishedQuestionColumns` is the one place that decides
 * what of a body becomes the learner-facing `question_versions` row (options as `{id, text}`
 * only; the key goes to `question_answer_keys`).
 *
 * Difficulty is a band, never a number; nothing here is a score or maps to a readiness value.
 *
 * Design: docs/architecture/question-bank-editor-design.md
 */
import { SKILL_LICENCES, SKILL_LICENCES_REQUIRING_ATTRIBUTION, type SkillLicence } from './skill-map.js';

export const QUESTION_BANK_BODY_SCHEMA = 'question-bank/v1';

export const QUESTION_STABLE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
/** Option ids, in order. A question has two to six options. */
export const QUESTION_OPTION_IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
export const QUESTION_OPTIONS_MIN = 2;
export const QUESTION_OPTIONS_MAX = 6;
export const QUESTION_PROMPT_MAX = 2000;
export const QUESTION_OPTION_TEXT_MAX = 500;
export const QUESTION_EXPLANATION_MAX = 2000;
export const QUESTION_RATIONALE_MAX = 2000;
export const QUESTION_HINT_MAX = 1000;
export const QUESTION_ATTRIBUTION_MAX = 300;
export const QUESTION_BASIS_MAX = 2000;

/** Author-declared difficulty bands. Measured difficulty is calibration (ENG-13), not this. */
export const QUESTION_DIFFICULTIES = ['FOUNDATION', 'INTERMEDIATE', 'ADVANCED'] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];
export const QUESTION_DIFFICULTY_MEANINGS: Readonly<Record<QuestionDifficulty, string>> = {
  FOUNDATION: 'Checks the core idea directly',
  INTERMEDIATE: 'Applies the idea to an ordinary case',
  ADVANCED: 'Combines ideas or handles an unusual case',
};

/** Hint levels 1–4 (level 0 is "no hint"). Level 3 and above marks an attempt assisted (0047). */
export const HINT_LEVELS = [
  { level: 1, name: 'NUDGE', meaning: 'Points at the idea that matters' },
  { level: 2, name: 'STRATEGY', meaning: 'Names the method to use' },
  { level: 3, name: 'WORKED_STEP', meaning: 'Does the first step (marks the attempt assisted)' },
  { level: 4, name: 'NEAR_SOLUTION', meaning: 'Everything short of choosing the answer (marks the attempt assisted)' },
] as const;

/** The same licences as the skill map (OPS-09a). */
export const QUESTION_LICENCES = SKILL_LICENCES;
export type QuestionLicence = SkillLicence;
export const QUESTION_LICENCES_REQUIRING_ATTRIBUTION = SKILL_LICENCES_REQUIRING_ATTRIBUTION;

export interface QuestionOptionFields {
  readonly id: string;
  readonly text: string;
  /** A misconception this wrong option signals (ENG-07 code id), with why. */
  readonly misconception: { readonly codeId: string; readonly rationale: string } | null;
}

/** The part of a question's body the editor owns. Other keys are carried unchanged. */
export interface QuestionDraftFields {
  readonly topicId: string | null;
  readonly prompt: string;
  readonly options: readonly QuestionOptionFields[];
  readonly correctOptionId: string | null;
  readonly explanation: string | null;
  readonly difficulty: QuestionDifficulty | null;
  /** Levels 1–4, in order; '' where not yet written. */
  readonly hints: readonly [string, string, string, string];
  readonly licenceLabel: QuestionLicence | null;
  readonly attribution: string | null;
  readonly basis: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/[ \t]+/g, ' ') : '');
const cleanBlock = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const orNull = (value: string): string | null => (value ? value : null);
const asRecord = (value: unknown): Record<string, unknown> =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * Read the editor's fields out of any stored body, tolerating older shapes: the pilot's question
 * bodies are `{id, stableKey, topicId, prompt, options: [{id, text}], correctOptionId, explanation}`
 * with no difficulty, hints or rights.
 */
export function readQuestionDraftFields(body: unknown): QuestionDraftFields {
  const raw = asRecord(body);
  const rights = asRecord(raw.rights);
  const licence = clean(rights.licenceLabel);
  const difficulty = clean(raw.difficulty);
  const hintsRaw = Array.isArray(raw.hints) ? raw.hints : [];
  const options = (Array.isArray(raw.options) ? raw.options : []).map((entry): QuestionOptionFields => {
    const option = asRecord(entry);
    const tag = asRecord(option.misconception);
    const codeId = clean(tag.codeId);
    return {
      id: clean(option.id),
      text: cleanBlock(option.text),
      misconception: codeId ? { codeId: codeId.toLowerCase(), rationale: cleanBlock(tag.rationale) } : null,
    };
  });
  const topicId = clean(raw.topicId);
  const correct = clean(raw.correctOptionId);
  return {
    topicId: UUID_PATTERN.test(topicId) ? topicId.toLowerCase() : null,
    prompt: cleanBlock(raw.prompt),
    options,
    correctOptionId: orNull(correct),
    explanation: orNull(cleanBlock(raw.explanation)),
    difficulty: (QUESTION_DIFFICULTIES as readonly string[]).includes(difficulty) ? difficulty as QuestionDifficulty : null,
    hints: [0, 1, 2, 3].map((index) => cleanBlock(hintsRaw[index])) as unknown as [string, string, string, string],
    licenceLabel: (QUESTION_LICENCES as readonly string[]).includes(licence) ? licence as QuestionLicence : null,
    attribution: orNull(clean(rights.attribution)),
    basis: orNull(cleanBlock(raw.basis)),
  };
}

/** The body to store: the previous body with the editor's fields replaced (other keys carried). */
export function composeQuestionBody(previous: unknown, stableKey: string, fields: QuestionDraftFields): Record<string, unknown> {
  return {
    ...asRecord(previous),
    schema: QUESTION_BANK_BODY_SCHEMA,
    stableKey,
    topicId: fields.topicId,
    prompt: fields.prompt,
    options: fields.options.map((option) => ({
      id: option.id, text: option.text,
      misconception: option.misconception ? { codeId: option.misconception.codeId, rationale: option.misconception.rationale } : null,
    })),
    correctOptionId: fields.correctOptionId,
    explanation: fields.explanation,
    difficulty: fields.difficulty,
    hints: [...fields.hints],
    rights: { licenceLabel: fields.licenceLabel, attribution: fields.attribution },
    basis: fields.basis,
  };
}

/**
 * Problems with a draft, as stable codes safe to show. `forSubmission` adds what review needs: a
 * skill tag, every option written, the answer key and explanation, a difficulty band, all four
 * hints, a licence (and attribution for a CC licence). Whether the topic and the misconception
 * codes exist is the persistence layer's check; this checks shape.
 */
export function validateQuestionDraft(stableKey: string, fields: QuestionDraftFields, forSubmission: boolean): readonly string[] {
  const problems: string[] = [];
  if (!QUESTION_STABLE_KEY_PATTERN.test(stableKey)) problems.push('QUESTION_KEY_INVALID');
  if (fields.prompt.length < 1 || fields.prompt.length > QUESTION_PROMPT_MAX) problems.push('QUESTION_PROMPT_INVALID');
  if (fields.options.length > QUESTION_OPTIONS_MAX) problems.push('QUESTION_OPTIONS_TOO_MANY');
  fields.options.forEach((option, index) => {
    if (option.id !== QUESTION_OPTION_IDS[index]) problems.push('QUESTION_OPTION_IDS_INVALID');
    if (option.text.length > QUESTION_OPTION_TEXT_MAX) problems.push(`QUESTION_OPTION_TOO_LONG:${option.id}`);
    else if (forSubmission && !option.text) problems.push(`QUESTION_OPTION_MISSING:${option.id}`);
    if (option.misconception) {
      if (!UUID_PATTERN.test(option.misconception.codeId)) problems.push(`QUESTION_MISCONCEPTION_INVALID:${option.id}`);
      if (option.misconception.rationale.length < 1 || option.misconception.rationale.length > QUESTION_RATIONALE_MAX) {
        problems.push(`QUESTION_MISCONCEPTION_RATIONALE_INVALID:${option.id}`);
      }
      if (fields.correctOptionId === option.id) problems.push(`QUESTION_MISCONCEPTION_ON_CORRECT:${option.id}`);
    }
  });
  const ids = fields.options.map((option) => option.id);
  if (new Set(ids).size !== ids.length && !problems.includes('QUESTION_OPTION_IDS_INVALID')) problems.push('QUESTION_OPTION_IDS_INVALID');
  if (fields.correctOptionId !== null && !ids.includes(fields.correctOptionId)) problems.push('QUESTION_CORRECT_OPTION_INVALID');
  if (fields.explanation !== null && fields.explanation.length > QUESTION_EXPLANATION_MAX) problems.push('QUESTION_EXPLANATION_INVALID');
  fields.hints.forEach((hint, index) => {
    if (hint.length > QUESTION_HINT_MAX) problems.push(`QUESTION_HINT_TOO_LONG:${index + 1}`);
    else if (forSubmission && !hint) problems.push(`QUESTION_HINT_MISSING:${index + 1}`);
  });
  if (fields.attribution !== null && fields.attribution.length > QUESTION_ATTRIBUTION_MAX) problems.push('QUESTION_ATTRIBUTION_INVALID');
  if (fields.basis !== null && fields.basis.length > QUESTION_BASIS_MAX) problems.push('QUESTION_BASIS_INVALID');
  if (forSubmission) {
    if (!fields.topicId) problems.push('QUESTION_TOPIC_MISSING');
    if (fields.options.length < QUESTION_OPTIONS_MIN) problems.push('QUESTION_OPTIONS_TOO_FEW');
    if (!fields.correctOptionId) problems.push('QUESTION_ANSWER_KEY_MISSING');
    if (!fields.explanation) problems.push('QUESTION_EXPLANATION_MISSING');
    if (!fields.difficulty) problems.push('QUESTION_DIFFICULTY_MISSING');
    if (!fields.licenceLabel) problems.push('QUESTION_LICENCE_MISSING');
    else if (QUESTION_LICENCES_REQUIRING_ATTRIBUTION.includes(fields.licenceLabel) && !fields.attribution) problems.push('QUESTION_ATTRIBUTION_MISSING');
  }
  return [...new Set(problems)];
}

/** Wrong options carrying a misconception tag, in option order. */
export function questionMisconceptionTags(fields: QuestionDraftFields): readonly { readonly optionId: string; readonly codeId: string; readonly rationale: string }[] {
  return fields.options
    .filter((option) => option.misconception && option.id !== fields.correctOptionId)
    .map((option) => ({ optionId: option.id, codeId: option.misconception!.codeId, rationale: option.misconception!.rationale }));
}

/**
 * What a published revision writes. `learner` is the `question_versions` payload — options as
 * `{id, text}` and nothing else, so no tag, hint, difficulty or key can reach a learner through
 * it; `answerKey` goes only to `question_answer_keys`, which only grading reads.
 */
export function publishedQuestionColumns(fields: QuestionDraftFields): {
  readonly learner: { readonly topicId: string; readonly prompt: string; readonly options: readonly { readonly id: string; readonly text: string }[] };
  readonly answerKey: { readonly correctOptionId: string; readonly explanation: string };
} {
  if (!fields.topicId || !fields.correctOptionId || !fields.explanation) throw new Error('only a complete question can be published');
  return {
    learner: { topicId: fields.topicId, prompt: fields.prompt, options: fields.options.map((option) => ({ id: option.id, text: option.text })) },
    answerKey: { correctOptionId: fields.correctOptionId, explanation: fields.explanation },
  };
}

/** The editor view for someone who may not see the answer key: key, explanation and tags withheld. */
export function withholdAnswerKey(fields: QuestionDraftFields): QuestionDraftFields {
  return {
    ...fields,
    correctOptionId: null,
    explanation: null,
    options: fields.options.map((option) => ({ ...option, misconception: null })),
  };
}

/**
 * Where an AI-drafted body came from (ENG-23): a generation by ONE AI Orchestration, run by the
 * content factory's worker. A third source beside a person (AUTHORED) and a coding agent writing
 * into the repository (AGENT_DRAFTED); the editors label it "AI draft".
 */
export interface AiDraftBodyProvenance {
  readonly generatorVersion: string;
  /** `<prompt key>@<version>`, e.g. `content-lesson-draft@1`. */
  readonly promptVersion: string;
  readonly model: string;
  /** ISO timestamp. */
  readonly generatedAt: string;
  /** The content factory job that produced it. */
  readonly jobId: string;
  /** What the reviewer must check; null when the body carries no note. */
  readonly expertCheck: string | null;
}

/**
 * The AI-draft provenance a lesson or question body carries under `provenance`, or null. Only a
 * complete record counts: source AI_GENERATED, generator, prompt version and model of 1–128
 * characters, a parseable timestamp and the job's id.
 */
export function readAiDraftProvenance(body: unknown): AiDraftBodyProvenance | null {
  const raw = asRecord(body);
  const provenance = asRecord(raw.provenance);
  if (provenance.source !== 'AI_GENERATED') return null;
  const generatorVersion = clean(provenance.generatorVersion);
  const promptVersion = clean(provenance.promptVersion);
  const model = clean(provenance.model);
  const generatedAt = clean(provenance.generatedAt);
  const jobId = clean(provenance.jobId);
  if (!generatorVersion || generatorVersion.length > 128 || !promptVersion || promptVersion.length > 128 || !model || model.length > 128) return null;
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt)) || !UUID_PATTERN.test(jobId)) return null;
  const expertCheck = cleanBlock(raw.expertCheck);
  return {
    generatorVersion, promptVersion, model, generatedAt: new Date(generatedAt).toISOString(), jobId: jobId.toLowerCase(),
    expertCheck: expertCheck ? expertCheck.slice(0, 4000) : null,
  };
}

/** Where an agent-drafted body came from (program B.8), as an import pack recorded it. */
export interface AgentDraftBodyProvenance {
  readonly generatorVersion: string;
  readonly promptVersion: string;
  /** ISO timestamp. */
  readonly generatedAt: string;
  /** What a subject expert must check; null when the body carries no note. */
  readonly expertCheck: string | null;
}

/**
 * The agent-draft provenance a question (or skill) body carries under `provenance`, or null for
 * a body a person wrote. Only a complete record counts: source AGENT_DRAFTED, generator and
 * prompt versions of 1–128 characters, and a parseable timestamp — the same rule the 0049, 0056
 * and 0061 provenance CHECKs apply to the rows it is copied into.
 */
export function readAgentDraftProvenance(body: unknown): AgentDraftBodyProvenance | null {
  const raw = asRecord(body);
  const provenance = asRecord(raw.provenance);
  if (provenance.source !== 'AGENT_DRAFTED') return null;
  const generatorVersion = clean(provenance.generatorVersion);
  const promptVersion = clean(provenance.promptVersion);
  const generatedAt = clean(provenance.generatedAt);
  if (!generatorVersion || generatorVersion.length > 128 || !promptVersion || promptVersion.length > 128) return null;
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) return null;
  const expertCheck = cleanBlock(raw.expertCheck);
  return { generatorVersion, promptVersion, generatedAt: new Date(generatedAt).toISOString(), expertCheck: expertCheck ? expertCheck.slice(0, 4000) : null };
}
