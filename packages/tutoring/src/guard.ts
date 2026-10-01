/**
 * The tutor reply guard (ENG-22, `tutor-guard-v1`) — pure, deterministic, no model involved.
 *
 * Why this exists: a model's reply is never the last check on what a student reads. Every reply is
 * run through this before it may be shown; anything it refuses is replaced by the human hint for the
 * same level. The guard IMPORTS ENG-21's bake-off checks (format, ENG-15's answer-leak rule, script,
 * personal data, promises) rather than copying them, so the rules that scored the evaluation are the
 * rules that guard production. It adds stricter runtime-only checks — an answer stated in words or as
 * its number, readiness / score / placement talk, false arithmetic, unverifiable code — which can only
 * refuse more, never pass what the evaluation would call a leak.
 *
 * It repairs only form (surrounding whitespace, a code fence around the JSON, runs of spaces). It never
 * edits content: a reply with a leak is refused whole, because a hint with a sentence cut out is a hint
 * nobody checked.
 *
 * Design: docs/architecture/tutor-hints-table-design.md (Decision 4).
 */
import {
  BAKE_OFF_CHECKS_VERSION,
  languageMatches,
  parseTutorReply,
  tutorFormatOk,
  tutorLeaks,
  unsafeContent,
} from '@planthepath/ai-evaluation/src/index.js';
import { arithmeticFindings } from './arithmetic.js';
import type { TutorBrief } from './brief.js';

export const TUTOR_GUARD_VERSION = 'tutor-guard-v1' as const;
/** The shared checks this guard runs, recorded so a change in either is visible. */
export const TUTOR_GUARD_SHARED_CHECKS = BAKE_OFF_CHECKS_VERSION;

export const TUTOR_GUARD_FINDINGS = [
  'FORMAT', 'ANSWER_LEAK', 'PERSONAL_DATA', 'PROMISE', 'WRONG_LANGUAGE', 'READINESS_OR_PLACEMENT', 'ARITHMETIC_ERROR', 'CODE_UNVERIFIED',
] as const;
export type TutorGuardFinding = (typeof TUTOR_GUARD_FINDINGS)[number];

export const TUTOR_GUARD_REPAIRS = ['TRIMMED', 'COLLAPSED_SPACES'] as const;
export type TutorGuardRepair = (typeof TUTOR_GUARD_REPAIRS)[number];

export type TutorGuardResult =
  | { readonly outcome: 'SHOW'; readonly text: string; readonly repairs: readonly TutorGuardRepair[]; readonly guardVersion: typeof TUTOR_GUARD_VERSION }
  /** The model chose not to give a hint; the student gets the human hint. */
  | { readonly outcome: 'REDIRECTED'; readonly text: string; readonly findings: readonly TutorGuardFinding[]; readonly guardVersion: typeof TUTOR_GUARD_VERSION }
  | { readonly outcome: 'REFUSED'; readonly text: string | null; readonly findings: readonly TutorGuardFinding[]; readonly guardVersion: typeof TUTOR_GUARD_VERSION };

/** Statements of the answer in words, in the three tutor languages. */
const answerStatements: readonly RegExp[] = [
  /\b(?:the\s+)?(?:correct|right)\s+(?:answer|option|choice)\s+(?:is|would\s+be|=|:)/iu,
  /\bthe\s+answer\s+(?:is|=|:)\s*\S/iu,
  /\banswer\s*[:=]\s*\S/iu,
  /सही\s+(?:उत्तर|जवाब|विकल्प)\s+(?:है|हैं)/u,
  /సరైన\s+(?:సమాధానం|జవాబు|ఎంపిక)/u,
];

/**
 * Readiness, score and placement talk (CLAUDE.md: readiness is a band decided by the app; a model
 * never comments on it). A term the question itself uses is allowed — "placement" in a question about
 * seating is not a promise.
 */
const readinessTerms: readonly { readonly term: string; readonly pattern: RegExp }[] = [
  { term: 'readiness', pattern: /\breadiness\b|\bready\s+for\s+(?:the\s+)?(?:job|placement|interview)s?\b/iu },
  { term: 'placement', pattern: /\bplacements?\b|\bplaced\b|प्लेसमेंट|ప్లేస్‌?మెంట్/iu },
  { term: 'job', pattern: /\bjob\s+offers?\b|\boffer\s+letters?\b|\bhired?\b|\bhiring\b|\bget\s+(?:a|the)\s+job\b|नौकरी|ఉద్యోగ/iu },
  { term: 'score', pattern: /\byour\s+(?:score|marks?|grade|rank|chances?|percentile)\b|\bpercentile\b|\branked?\b|\branking\b|स्कोर|మార్కులు|స్కోర్/iu },
  { term: 'guarantee', pattern: /\bguarantee[sd]?\b|गारंटी|హామీ/iu },
];

/** Code in a reply: a fence, or a line that reads as a program. Nothing can verify it yet (ENG-12, HG-7). */
const codePatterns: readonly RegExp[] = [
  /```/u,
  /^\s*(?:def\s|class\s|function\s|import\s|from\s+\S+\s+import|#include|public\s+static|console\.log\(|print\()/mu,
];

/** The leading number of the correct option ("48" of "48 km/h", "1200" of "₹1,200"), when the option is numeric. */
function answerNumber(text: string): string | null {
  const match = /^\s*[^\p{L}\p{N}]{0,3}\s*(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?/u.exec(text);
  if (!match) return null;
  const whole = match[1]!.replace(/,/g, '');
  return match[2] ? `${whole}.${match[2]}` : whole;
}

function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![\p{L}\p{N}.,])(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?![\p{N}])/gu)) {
    const whole = match[1]!.replace(/,/g, '');
    found.add(match[2] ? `${whole}.${match[2]}` : whole);
  }
  return found;
}

function leaksAnswerNumber(text: string, brief: TutorBrief): boolean {
  const correct = brief.options.find((option) => option.id === brief.correctOptionId);
  if (!correct) return false;
  const number = answerNumber(correct.text);
  if (number === null) return false;
  // A number the question states is common ground, not the answer.
  if (numbersIn(brief.questionPrompt).has(number)) return false;
  return numbersIn(text).has(number);
}

function readinessTalk(text: string, brief: TutorBrief): boolean {
  const context = [brief.questionPrompt, ...brief.options.map((option) => option.text)].join('\n');
  return readinessTerms.some(({ pattern }) => pattern.test(text) && !pattern.test(context));
}

function containsCode(text: string): boolean {
  return codePatterns.some((pattern) => pattern.test(text));
}

/** Form-only repairs: surrounding whitespace and runs of spaces. Content is never edited. */
function repair(text: string): { readonly text: string; readonly repairs: TutorGuardRepair[] } {
  const repairs: TutorGuardRepair[] = [];
  let value = text;
  if (value.trim() !== value) { value = value.trim(); repairs.push('TRIMMED'); }
  const collapsed = value.replace(/[ \t]{2,}/gu, ' ');
  if (collapsed !== value) { value = collapsed; repairs.push('COLLAPSED_SPACES'); }
  return { text: value, repairs };
}

/**
 * Checks one raw reply against the brief it answered. `truncated` is the orchestrator's flag for a
 * reply that stopped at the token limit (a cut-off hint is not a hint).
 */
export function guardTutorReply(raw: string, brief: TutorBrief, options: { readonly truncated: boolean }): TutorGuardResult {
  const refuse = (findings: TutorGuardFinding[], text: string | null): TutorGuardResult =>
    ({ outcome: 'REFUSED', text, findings: [...new Set(findings)], guardVersion: TUTOR_GUARD_VERSION });

  if (!tutorFormatOk(raw, options.truncated ? 'length' : 'stop')) return refuse(['FORMAT'], parseTutorReply(raw)?.text ?? null);
  const parsed = parseTutorReply(raw)!;
  const { text, repairs } = repair(parsed.text);
  if (!text) return refuse(['FORMAT'], null);

  const findings: TutorGuardFinding[] = [];
  const leak = { prompt: brief.questionPrompt, options: brief.options, correctOptionId: brief.correctOptionId };
  if (tutorLeaks(text, leak, [])) findings.push('ANSWER_LEAK');
  if (answerStatements.some((pattern) => pattern.test(text))) findings.push('ANSWER_LEAK');
  if (leaksAnswerNumber(text, brief)) findings.push('ANSWER_LEAK');
  if (unsafeContent(text, { refusal: false, casePatterns: [] })) {
    // unsafeContent folds personal data and promises together; tell them apart for the reviewer.
    findings.push(unsafeContent(text, { refusal: true, casePatterns: [] }) ? 'PERSONAL_DATA' : 'PROMISE');
  }
  if (!languageMatches(text, brief.language)) findings.push('WRONG_LANGUAGE');
  if (readinessTalk(text, brief)) findings.push('READINESS_OR_PLACEMENT');
  if (arithmeticFindings(text).length > 0) findings.push('ARITHMETIC_ERROR');
  if (containsCode(text)) findings.push('CODE_UNVERIFIED');

  if (findings.length > 0) return refuse(findings, text);
  if (parsed.type === 'REDIRECT') return { outcome: 'REDIRECTED', text, findings: [], guardVersion: TUTOR_GUARD_VERSION };
  return { outcome: 'SHOW', text, repairs, guardVersion: TUTOR_GUARD_VERSION };
}
