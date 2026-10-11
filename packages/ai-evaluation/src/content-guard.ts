/**
 * The content factory's output guard (ENG-23, `content-guard-v1`) — pure and deterministic.
 *
 * Why this exists: a model's reply becomes a DRAFT in the content review queue only if code finds
 * nothing wrong with it first. A person still reviews every draft; this keeps out what text can
 * catch — the wrong shape, a refusal, the wrong language, personal data, a readiness figure or a
 * promised outcome, a lesson that copies an assessment item, a hint that hands over the answer.
 * It reuses the bake-off's checks (ENG-21) and ENG-15's ladder rule, so the rules a model was
 * measured against are the rules its output is held to in production.
 *
 * It also maps an accepted lesson onto the lesson editor's two learner fields (summary, practice),
 * cutting at a paragraph or sentence boundary when a part is longer than the editor allows and
 * saying so (`fitted`), so the reviewer knows to read the full text kept beside the draft.
 *
 * Design: docs/architecture/content-factory-design.md (Decisions 3 and 4).
 */
import { lessonDraftHeadings, lessonHeadingIndex } from '@planthepath/ai-orchestration/src/index.js';
import { hintLadderFindings } from '@planthepath/career-readiness/src/index.js';
import {
  countWords,
  lessonHeadingsInOrder,
  lessonReplyKind,
  matchesAny,
  outcomePromisePatterns,
  parseAnswerCheckReply,
  personalDataPatterns,
  stripSingleFence,
} from './checks.js';

export const CONTENT_GUARD_VERSION = 'content-guard-v1';

export type ContentGuardFinding =
  | 'MODEL_REFUSED'
  | 'FORMAT_INVALID'
  | 'TRUNCATED'
  | 'LANGUAGE_MISMATCH'
  | 'PERSONAL_DATA'
  | 'READINESS_FIGURE'
  | 'PLACEMENT_CHANCE'
  | 'OUTCOME_PROMISE'
  | 'QUOTES_ASSESSMENT_ITEM'
  | 'DUPLICATE_OPTIONS'
  | `HINT_${string}`;

/** The lesson editor's limits (OPS-09c); the guard fits a lesson into them. */
export const GUARD_LESSON_SUMMARY_MAX = 1000;
export const GUARD_LESSON_PRACTICE_MAX = 2000;
/** The question editor's limits (OPS-09b). */
const ITEM_LIMITS = { prompt: 2000, option: 500, explanation: 2000, hint: 1000 } as const;
const ITEM_OPTION_IDS = ['a', 'b', 'c', 'd'] as const;

const thinkBlock = /<\/?think>/i;

/**
 * A readiness figure: "readiness" next to a number, or a percentage of "ready". Narrow on purpose:
 * aptitude lessons are full of marks, scores and percentages, which are subject matter, not a
 * statement about anyone's readiness.
 */
const readinessPatterns: readonly string[] = [
  String.raw`\breadiness\b[^.\n]{0,40}\d`,
  String.raw`\d+(?:\.\d+)?\s?%[^.\n]{0,30}\bread(?:y|iness)\b`,
];
/**
 * A person's chances of a job or placement (the prompts forbid it). Addressed to someone, so a
 * probability lesson's "the probability that a candidate is selected" is not caught.
 */
const placementChancePatterns: readonly string[] = [
  String.raw`\b(?:your|their|his|her|a student's|students')\s+(?:chances?|probability|likelihood|odds)\b[^.\n]{0,40}\b(?:job|placement|placed|hired|offer)\b`,
  String.raw`\bplacement\s+(?:chances?|probability|odds)\b`,
];

/** Each lesson language's script, by Unicode block. English is Latin with no Indic letters. */
const scripts: Readonly<Record<string, RegExp>> = {
  hi: /[ऀ-ॿ]/u, mr: /[ऀ-ॿ]/u, te: /[ఀ-౿]/u, ta: /[஀-௿]/u, kn: /[ಀ-೿]/u,
  ml: /[ഀ-ൿ]/u, bn: /[ঀ-৿]/u, gu: /[઀-૿]/u, pa: /[਀-੿]/u, or: /[଀-୿]/u,
};
const anyIndic = /[ऀ-ൿ]/u;

/**
 * The bake-off's language rule (ENG-21), for every lesson language: a reply in an Indian language
 * keeps numbers, terms and quoted text in Latin script, so at least half of its letters must be in
 * the language's script; an English reply has no Indian-script letter at all.
 */
export function inRequestedScript(text: string, language: string): boolean {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (!letters.length) return false;
  if (language === 'en') return !letters.some((character) => anyIndic.test(character));
  const script = scripts[language];
  if (!script) return false;
  return letters.filter((character) => script.test(character)).length / letters.length >= 0.5;
}

/** Findings any teaching text can have: personal data, a readiness figure, chances, a promise. */
export function unsafeTeachingFindings(text: string): readonly ContentGuardFinding[] {
  const findings: ContentGuardFinding[] = [];
  if (matchesAny(text, personalDataPatterns)) findings.push('PERSONAL_DATA');
  if (matchesAny(text, readinessPatterns)) findings.push('READINESS_FIGURE');
  if (matchesAny(text, placementChancePatterns)) findings.push('PLACEMENT_CHANCE');
  if (matchesAny(text, outcomePromisePatterns)) findings.push('OUTCOME_PROMISE');
  return findings;
}

const squash = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Whether the text repeats an assessment item's prompt: the whole prompt when it is short, its
 * first 80 characters when it is long, compared without case or punctuation. Prompts under 30
 * characters are too generic to match on.
 */
export function quotesAssessmentItem(text: string, assessmentPrompts: readonly string[]): boolean {
  const haystack = ` ${squash(text)} `;
  return assessmentPrompts.some((prompt) => {
    const needle = squash(prompt);
    if (needle.length < 30) return false;
    const probe = needle.length > 120 ? needle.slice(0, 80).replace(/\s\S*$/u, '') : needle;
    return haystack.includes(` ${probe} `) || haystack.includes(` ${probe}`);
  });
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export type LessonSectionName = 'What you will learn' | 'Explanation' | 'Worked example' | 'Common mistakes' | 'Check yourself';
export const lessonSectionNames: readonly LessonSectionName[] = lessonDraftHeadings.map((heading) => heading.replace(/^##\s*/u, '') as LessonSectionName);

export interface FittedLesson {
  /** Each section's text, as the model wrote it. */
  readonly sections: Readonly<Record<LessonSectionName, string>>;
  /** What learners read: "What you will learn" and "Explanation". */
  readonly summary: string;
  /** The practice part: "Worked example", "Common mistakes" and "Check yourself". */
  readonly practice: string;
  /** True when a part was cut to fit the editor's limit; the full text stays in `sections`. */
  readonly fitted: boolean;
}

function splitSections(text: string): Readonly<Record<LessonSectionName, string>> {
  const lines = text.split(/\r?\n/u);
  const sections = Object.fromEntries(lessonSectionNames.map((name) => [name, ''])) as Record<LessonSectionName, string>;
  let current: LessonSectionName | null = null;
  const buffer: Record<string, string[]> = {};
  for (const line of lines) {
    const heading = lessonHeadingIndex(line);
    if (heading >= 0) { current = lessonSectionNames[heading]!; buffer[current] = []; continue; }
    if (current) buffer[current]!.push(line);
  }
  for (const name of lessonSectionNames) sections[name] = (buffer[name] ?? []).join('\n').trim();
  return sections;
}

/** Cut at the last paragraph break, else sentence end, else word, that fits; never mid-word. */
export function fitText(text: string, limit: number): { readonly text: string; readonly cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  const head = text.slice(0, limit);
  const paragraph = head.lastIndexOf('\n\n');
  if (paragraph >= limit * 0.5) return { text: head.slice(0, paragraph).trim(), cut: true };
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('? '), head.lastIndexOf('! '), head.lastIndexOf('। '));
  if (sentence >= limit * 0.5) return { text: head.slice(0, sentence + 1).trim(), cut: true };
  const word = head.lastIndexOf(' ');
  return { text: head.slice(0, word > 0 ? word : limit).trim(), cut: true };
}

function joinParts(sections: Readonly<Record<LessonSectionName, string>>, names: readonly LessonSectionName[]): string {
  return names.filter((name) => sections[name]).map((name) => `${name}\n${sections[name]}`).join('\n\n');
}

export function fitLesson(text: string): FittedLesson {
  const sections = splitSections(text);
  const summary = fitText(joinParts(sections, ['What you will learn', 'Explanation']), GUARD_LESSON_SUMMARY_MAX);
  const practice = fitText(joinParts(sections, ['Worked example', 'Common mistakes', 'Check yourself']), GUARD_LESSON_PRACTICE_MAX);
  return { sections, summary: summary.text, practice: practice.text, fitted: summary.cut || practice.cut };
}

export interface GuardResult<T> {
  /** True when the reply may land as a draft. */
  readonly ok: boolean;
  /** The model declined (one `REFUSED:` line): nothing lands, and it is not a guard rejection. */
  readonly refused: boolean;
  readonly findings: readonly ContentGuardFinding[];
  readonly value: T | null;
}

/**
 * A lesson (or a variant in another language): the five headings in order, 150–900 words, not cut
 * off, in the requested script, nothing unsafe, no copied assessment item.
 */
export function guardLessonDraft(input: {
  readonly text: string;
  readonly truncated: boolean;
  readonly language: string;
  /** The prompts of every question tagged to the lesson's skill, in any state. */
  readonly assessmentPrompts: readonly string[];
}): GuardResult<FittedLesson> {
  if (lessonReplyKind(input.text) === 'REFUSED') return { ok: false, refused: true, findings: ['MODEL_REFUSED'], value: null };
  const findings: ContentGuardFinding[] = [];
  if (input.truncated) findings.push('TRUNCATED');
  const words = countWords(input.text);
  if (thinkBlock.test(input.text) || !lessonHeadingsInOrder(input.text) || words < 150 || words > 900) findings.push('FORMAT_INVALID');
  const fitted = fitLesson(input.text);
  const body = lessonSectionNames.map((name) => fitted.sections[name]).join('\n');
  if (!inRequestedScript(body, input.language)) findings.push('LANGUAGE_MISMATCH');
  findings.push(...unsafeTeachingFindings(input.text));
  if (quotesAssessmentItem(input.text, input.assessmentPrompts)) findings.push('QUOTES_ASSESSMENT_ITEM');
  const unique = [...new Set(findings)];
  return { ok: unique.length === 0, refused: false, findings: unique, value: unique.length === 0 ? fitted : null };
}

// ---------------------------------------------------------------------------
// Practice questions
// ---------------------------------------------------------------------------

export interface DraftedItem {
  readonly prompt: string;
  /** Options a–d, in the order the model listed them. */
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly correctOptionId: string;
  readonly explanation: string;
  readonly hints: readonly [string, string, string, string];
}

function parseItem(raw: string): DraftedItem | null {
  let value: unknown;
  try {
    value = JSON.parse(stripSingleFence(raw));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'correct,explanation,hints,options,prompt') return null;
  const text = (entry: unknown, max: number): string | null => (typeof entry === 'string' && entry.trim() && entry.trim().length <= max ? entry.trim() : null);
  const prompt = text(record.prompt, ITEM_LIMITS.prompt);
  const explanation = text(record.explanation, ITEM_LIMITS.explanation);
  if (!prompt || !explanation || !Array.isArray(record.options) || !Array.isArray(record.hints)) return null;
  if (record.options.length !== 4 || record.hints.length !== 4) return null;
  const options = record.options.map((entry) => text(entry, ITEM_LIMITS.option));
  const hints = record.hints.map((entry) => text(entry, ITEM_LIMITS.hint));
  if (options.some((entry) => entry === null) || hints.some((entry) => entry === null)) return null;
  const correct = typeof record.correct === 'string' ? record.correct.trim().replace(/^\(?([a-d])\)?\.?$/iu, '$1').toLowerCase() : '';
  if (!(ITEM_OPTION_IDS as readonly string[]).includes(correct)) return null;
  return {
    prompt,
    options: options.map((entry, index) => ({ id: ITEM_OPTION_IDS[index]!, text: entry! })),
    correctOptionId: correct,
    explanation,
    hints: hints as unknown as [string, string, string, string],
  };
}

/**
 * A practice question: one JSON object with a prompt, four distinct options, a key in a–d, an
 * explanation and four hints within the editor's limits; English; nothing unsafe; and a ladder
 * ENG-15's rules find nothing wrong with against the drafted key (no missing or repeated level,
 * no hint naming the answer or pointing at its letter).
 */
export function guardItemDraft(input: { readonly text: string; readonly truncated: boolean }): GuardResult<DraftedItem> {
  if (lessonReplyKind(input.text) === 'REFUSED') return { ok: false, refused: true, findings: ['MODEL_REFUSED'], value: null };
  const findings: ContentGuardFinding[] = [];
  if (input.truncated) findings.push('TRUNCATED');
  const item = thinkBlock.test(input.text) ? null : parseItem(input.text);
  if (!item) {
    findings.push('FORMAT_INVALID');
    return { ok: false, refused: false, findings: [...new Set(findings)], value: null };
  }
  const all = [item.prompt, ...item.options.map((option) => option.text), item.explanation, ...item.hints].join('\n');
  if (!inRequestedScript(all, 'en')) findings.push('LANGUAGE_MISMATCH');
  findings.push(...unsafeTeachingFindings(all));
  if (new Set(item.options.map((option) => squash(option.text))).size !== item.options.length) findings.push('DUPLICATE_OPTIONS');
  for (const finding of hintLadderFindings({ prompt: item.prompt, options: item.options, correctOptionId: item.correctOptionId, hints: item.hints })) {
    findings.push(`${finding.code}` as ContentGuardFinding);
  }
  const unique = [...new Set(findings)];
  return { ok: unique.length === 0, refused: false, findings: unique, value: unique.length === 0 ? item : null };
}

// ---------------------------------------------------------------------------
// Answer checks
// ---------------------------------------------------------------------------

export interface AnswerCheck {
  readonly option: string;
  /** At most 600 characters of the model's working, for the reviewer. */
  readonly working: string;
}

/** An answer check: the bake-off's `{option, working}` shape, the option one of the item's, nothing unsafe. */
export function guardAnswerCheck(input: { readonly text: string; readonly truncated: boolean; readonly optionIds: readonly string[] }): GuardResult<AnswerCheck> {
  const findings: ContentGuardFinding[] = [];
  if (input.truncated) findings.push('TRUNCATED');
  const parsed = thinkBlock.test(input.text) ? null : parseAnswerCheckReply(input.text, input.optionIds);
  if (!parsed) findings.push('FORMAT_INVALID');
  else if (matchesAny(parsed.working, personalDataPatterns)) findings.push('PERSONAL_DATA');
  const unique = [...new Set(findings)];
  return {
    ok: unique.length === 0, refused: false, findings: unique,
    value: unique.length === 0 && parsed ? { option: parsed.option, working: parsed.working.trim().slice(0, 600) } : null,
  };
}
