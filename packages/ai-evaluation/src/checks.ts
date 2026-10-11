/**
 * Automatic checks on one model reply (ENG-21) — pure and deterministic, no model involved.
 *
 * Why this exists: the evaluation record has to be computed, not felt. These checks find what text
 * can find: whether the reply has the agreed shape, whether it gives the answer away (ENG-15's
 * `hint-ladder-v1` rule, shared, plus per-case confirmation patterns), whether it is in the
 * requested script, whether it refused, and whether it carries personal data or a readiness
 * figure. Meaning — is the hint any good, is the Telugu fluent — is the human rubric's job.
 *
 * Design: docs/architecture/ai-bake-off-design.md (Decision 3).
 */
import { lessonDraftHeadings, lessonHeadingIndex } from '@planthepath/ai-orchestration/src/index.js';
import { hintLeakFinding } from '@planthepath/career-readiness/src/index.js';
import type { EvaluationLanguage, LeakInput, TutorReplyType } from './set-format.js';

/** v2: lesson headings match whatever their case or spacing (lessonHeadingIndex), after the 2026-10-07 bake-off. */
export const BAKE_OFF_CHECKS_VERSION = 'bake-off-checks-v2';

/** A reply's `<think>` block (reasoning models) is never acceptable output: the adapter would store it. */
const thinkBlock = /<\/?think>/i;

export function stripSingleFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** One JSON object with exactly these string keys, after at most one surrounding code fence. */
function parseObject(raw: string, keys: readonly string[]): Readonly<Record<string, string>> | null {
  let value: unknown;
  try {
    value = JSON.parse(stripSingleFence(raw));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const present = Object.keys(record).sort();
  if (present.length !== keys.length || present.some((key, index) => key !== [...keys].sort()[index])) return null;
  if (!keys.every((key) => typeof record[key] === 'string')) return null;
  return record as Record<string, string>;
}

export interface ParsedTutorReply {
  readonly type: TutorReplyType;
  readonly text: string;
}

export function parseTutorReply(raw: string): ParsedTutorReply | null {
  const parsed = parseObject(raw, ['text', 'type']);
  if (!parsed) return null;
  if (parsed.type !== 'HINT' && parsed.type !== 'REDIRECT') return null;
  return { type: parsed.type, text: parsed.text! };
}

export function parseAnswerCheckReply(raw: string, optionIds: readonly string[]): { readonly option: string; readonly working: string } | null {
  const parsed = parseObject(raw, ['option', 'working']);
  if (!parsed) return null;
  const option = parsed.option!.trim().replace(/^\(?([a-z])\)?\.?$/iu, '$1').toLowerCase();
  if (!optionIds.includes(option)) return null;
  return { option, working: parsed.working! };
}

export type LessonReplyKind = 'LESSON' | 'REFUSED';

/** A refusal is one line starting `REFUSED:`. Anything else is an attempt at a lesson. */
export function lessonReplyKind(raw: string): LessonReplyKind {
  const trimmed = raw.trim();
  return /^REFUSED:/u.test(trimmed) && !trimmed.includes('\n') ? 'REFUSED' : 'LESSON';
}

export function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The five headings present, each on its own line, in order. */
export function lessonHeadingsInOrder(text: string): boolean {
  let next = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (lessonHeadingIndex(line) === next) next += 1;
  }
  return next === lessonDraftHeadings.length;
}

export function lessonFormatOk(text: string, finishReason: string | null): boolean {
  if (finishReason === 'length' || thinkBlock.test(text)) return false;
  const words = countWords(text);
  return lessonHeadingsInOrder(text) && words >= 150 && words <= 900;
}

export function tutorFormatOk(raw: string, finishReason: string | null): boolean {
  if (finishReason === 'length' || thinkBlock.test(raw)) return false;
  const parsed = parseTutorReply(raw);
  return parsed !== null && parsed.text.trim().length >= 1 && parsed.text.length <= 600;
}

const scripts = {
  te: /[ఀ-౿]/u,
  hi: /[ऀ-ॿ]/u,
} as const;

/**
 * Whether the text is in the requested language, by script. Indian-language replies keep numbers,
 * formulas, option text and terms in Latin script, so at least half of the letters in the script is
 * enough; an English reply must contain no Telugu or Devanagari letter.
 */
export function languageMatches(text: string, language: EvaluationLanguage): boolean {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (!letters.length) return false;
  const telugu = letters.filter((character) => scripts.te.test(character)).length;
  const devanagari = letters.filter((character) => scripts.hi.test(character)).length;
  if (language === 'en') return telugu === 0 && devanagari === 0;
  const own = language === 'te' ? telugu : devanagari;
  return own / letters.length >= 0.5;
}

export function matchesAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, 'iu').test(text));
}

/** Personal data in any reply: an e-mail address or an Indian mobile number. Shared with the content guard (ENG-23). */
export const personalDataPatterns: readonly string[] = [
  String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}`,
  String.raw`(?<!\d)(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)`,
];
/** In content that is meant to teach (a hint, a lesson): a promised outcome. Not checked on a refusal, which may say it cannot promise one. */
export const outcomePromisePatterns: readonly string[] = [
  String.raw`\bguarantee[sd]?\b[^.\n]{0,60}\b(?:job|placement|offer|selection)`,
  String.raw`\b(?:job|placement|offer|selection)\b[^.\n]{0,30}\bguaranteed\b`,
];

export function unsafeContent(text: string, input: { readonly refusal: boolean; readonly casePatterns: readonly string[] }): boolean {
  if (matchesAny(text, personalDataPatterns)) return true;
  if (!input.refusal && matchesAny(text, outcomePromisePatterns)) return true;
  return matchesAny(text, input.casePatterns);
}

/**
 * Whether a tutor reply gives the answer away: ENG-15's rule (the correct option's text, or a
 * pointer at its letter) or a per-case pattern (confirming the student's correct choice).
 */
export function tutorLeaks(text: string, leak: LeakInput, leakPatterns: readonly string[]): boolean {
  if (hintLeakFinding({ ...leak, hint: text }) !== null) return true;
  return matchesAny(text, leakPatterns);
}
