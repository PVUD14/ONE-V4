/**
 * The tutoring brief (ENG-22) — what the model is told about a hint request, and nothing more. Pure.
 *
 * Why this exists: a prompt can only leak what it is given. The brief is built from content alone —
 * the question, its options and key, the hints a person published up to the requested level, the
 * level and the language — and it has no field for anything about the student: no name, identifier,
 * institution, history, band or readiness. The student's words are not in it either: v1 sends one of
 * the request phrasings ENG-21 evaluated, chosen by level, so no personal data or injected
 * instruction can arrive through the request.
 *
 * `tutorPromptParameters` renders the brief exactly as the evaluation set renders a tutor case, so a
 * PASS for `tutor-hint@1` describes what students receive (a test pins the parity).
 *
 * Design: docs/architecture/tutor-hints-table-design.md (Decision 3).
 */
import { hintLevelMeanings } from '@planthepath/ai-orchestration/src/index.js';
import { hintMessages, languageNames } from '@planthepath/ai-evaluation/src/index.js';
import { MAX_TUTOR_HINT_LEVEL, isTutorLanguage, type TutorLanguage } from './policy.js';

export interface TutorBriefOption {
  readonly id: string;
  readonly text: string;
}

/** Everything the model is told. A test pins these keys: adding one is a design decision. */
export interface TutorBrief {
  readonly questionPrompt: string;
  readonly options: readonly TutorBriefOption[];
  readonly correctOptionId: string;
  /** Published ladder hints, levels 1..level, in order. */
  readonly approvedHints: readonly string[];
  readonly level: 1 | 2 | 3 | 4;
  readonly language: TutorLanguage;
  /** The evaluated request phrasing for this level, in the student's language. */
  readonly studentMessage: string;
}

export const TUTOR_BRIEF_KEYS = ['approvedHints', 'correctOptionId', 'language', 'level', 'options', 'questionPrompt', 'studentMessage'] as const;

export class TutorBriefError extends Error {
  constructor(readonly code: 'INVALID_LEVEL' | 'INVALID_LANGUAGE' | 'NO_OPTIONS' | 'UNKNOWN_KEY' | 'LADDER_TOO_SHORT' | 'EMPTY_PROMPT') {
    super(`tutor brief: ${code}`);
    this.name = 'TutorBriefError';
  }
}

/**
 * The request phrasing for a level: "I don't know where to start" at level 1, "I've understood the
 * first part. What should I do next?" above it — both from ENG-21's evaluated set.
 */
export function tutorStudentMessage(level: number, language: TutorLanguage): string {
  return hintMessages[language][level <= 1 ? 'START' : 'NEXT_STEP'];
}

/** Builds the brief from content. Takes no student data, so it cannot carry any. */
export function buildTutorBrief(input: {
  readonly questionPrompt: string;
  readonly options: readonly TutorBriefOption[];
  readonly correctOptionId: string;
  readonly publishedLadder: readonly string[];
  readonly level: number;
  readonly language: string;
}): TutorBrief {
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > MAX_TUTOR_HINT_LEVEL) throw new TutorBriefError('INVALID_LEVEL');
  if (!isTutorLanguage(input.language)) throw new TutorBriefError('INVALID_LANGUAGE');
  if (!input.questionPrompt.trim()) throw new TutorBriefError('EMPTY_PROMPT');
  const options = input.options.map((option) => ({ id: option.id, text: option.text }));
  if (options.length < 2) throw new TutorBriefError('NO_OPTIONS');
  if (!options.some((option) => option.id === input.correctOptionId)) throw new TutorBriefError('UNKNOWN_KEY');
  const approvedHints = input.publishedLadder.slice(0, input.level).map((hint) => hint);
  if (approvedHints.length < input.level || approvedHints.some((hint) => !hint.trim())) throw new TutorBriefError('LADDER_TOO_SHORT');
  const level = input.level as 1 | 2 | 3 | 4;
  return {
    questionPrompt: input.questionPrompt,
    options,
    correctOptionId: input.correctOptionId,
    approvedHints,
    level,
    language: input.language,
    studentMessage: tutorStudentMessage(level, input.language),
  };
}

/** The `tutor-hint@1` parameters, rendered exactly as the evaluation set renders a tutor case. */
export function tutorPromptParameters(brief: TutorBrief): Readonly<Record<string, string>> {
  const correct = brief.options.find((option) => option.id === brief.correctOptionId);
  if (!correct) throw new TutorBriefError('UNKNOWN_KEY');
  return {
    hintLevel: String(brief.level),
    levelMeaning: hintLevelMeanings[brief.level],
    language: languageNames[brief.language],
    itemPrompt: brief.questionPrompt,
    itemOptions: brief.options.map((option) => `${option.id}) ${option.text}`).join('\n'),
    correctOption: `${correct.id}) ${correct.text}`,
    approvedHints: brief.approvedHints.map((hint, index) => `Level ${index + 1}: ${hint}`).join('\n'),
    studentMessage: brief.studentMessage,
  };
}
