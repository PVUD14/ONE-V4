/**
 * "Ask ONE to explain" topic rules (ADR-052) — pure: how a topic is normalised into its cache key, what a
 * student may type, and the per-student limits. Shared by the API (validation), the worker and the
 * evaluation set builder, so the bake-off sends the model exactly what production sends.
 *
 * Why here: the content guard and the evaluation that holds the model to it live in this package; the
 * topic the model receives is part of that contract.
 *
 * Design: docs/architecture/ask-to-explain-design.md (Decisions 2, 3 and 6).
 */
import { matchesAny, personalDataPatterns } from './checks.js';

export const EXPLAIN_FEATURE_KEY = 'learning.explain-topic' as const;
export const EXPLAIN_TOPIC_MIN = 3;
export const EXPLAIN_TOPIC_MAX = 120;
/** Lessons being prepared for one student at a time. */
export const EXPLAIN_OPEN_PER_STUDENT = 1;
/** Requests one student may make in a (database) day; cache hits count. */
export const EXPLAIN_REQUESTS_PER_DAY = 10;
/** A lesson still preparing after this long is closed as EXPIRED and frees its topic. */
export const EXPLAIN_PENDING_SECONDS = 600;
export const EXPLAIN_REPORT_NOTE_MAX = 300;
export const EXPLAIN_REPORT_REASONS = ['WRONG_FACT', 'CONFUSING', 'UNSAFE', 'NOT_WHAT_I_ASKED', 'OTHER'] as const;
export type ExplainReportReason = (typeof EXPLAIN_REPORT_REASONS)[number];
/** The label every explain lesson carries, on every client. */
export const EXPLAIN_LESSON_LABEL = 'AI-generated — not checked by a person';

/** The cache key: trimmed, lower-case, whitespace collapsed to single spaces. Synonyms are out of scope. */
export function normaliseExplainTopic(topic: string): string {
  return topic.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** The student's wording as stored for their own view: trimmed, whitespace collapsed, case kept. */
export function tidyExplainTopic(topic: string): string {
  return topic.trim().replace(/\s+/gu, ' ');
}

export type ExplainTopicProblem = 'TOPIC_LENGTH' | 'TOPIC_NOT_ENGLISH' | 'TOPIC_PERSONAL_DATA' | 'TOPIC_LINK';

/** Letters outside basic and extended Latin: another script, so not English (English only for now). */
const nonLatinLetter = /(?![A-Za-zÀ-ɏ])\p{L}/u;
const link = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|in|org|io|co)\b/iu;
/** A long run of digits: an ID, roll or account number. */
const longNumber = /\d[\d\s-]{6,}\d/u;

/** Why a topic cannot be asked, or null. Checks the normalised text. */
export function explainTopicProblem(topic: unknown): ExplainTopicProblem | null {
  if (typeof topic !== 'string') return 'TOPIC_LENGTH';
  const tidy = tidyExplainTopic(topic);
  if (tidy.length < EXPLAIN_TOPIC_MIN || tidy.length > EXPLAIN_TOPIC_MAX) return 'TOPIC_LENGTH';
  if (nonLatinLetter.test(tidy)) return 'TOPIC_NOT_ENGLISH';
  if (!/[A-Za-z]/u.test(tidy)) return 'TOPIC_LENGTH';
  if (matchesAny(tidy, personalDataPatterns) || longNumber.test(tidy)) return 'TOPIC_PERSONAL_DATA';
  if (link.test(tidy)) return 'TOPIC_LINK';
  return null;
}

/** Why a report note cannot be kept, or null. Absent or empty is fine. */
export function explainReportNoteProblem(note: unknown): 'NOTE_LENGTH' | 'NOTE_PERSONAL_DATA' | null {
  if (note === undefined || note === null || note === '') return null;
  if (typeof note !== 'string' || note.trim().length < 1 || note.trim().length > EXPLAIN_REPORT_NOTE_MAX) return 'NOTE_LENGTH';
  if (matchesAny(note, personalDataPatterns) || longNumber.test(note)) return 'NOTE_PERSONAL_DATA';
  return null;
}
