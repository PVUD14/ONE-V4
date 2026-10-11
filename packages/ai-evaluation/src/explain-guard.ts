/**
 * The "Ask ONE to explain" guard (ADR-052, `explain-guard-v1`) — pure and deterministic.
 *
 * Why this exists: under Divakar's scoped waiver an explain lesson reaches students without a person
 * reading it first, so code must find what text can find before anything is shown. It is ENG-23's lesson
 * guard (format, length, truncation, English, personal data, readiness figures, placement chances,
 * promised outcomes) plus two checks that matter more when nobody reviews: step-by-step instructions for
 * weapons or self-harm, and talk addressed to the student about their readiness or job prospects.
 * The same function scores the `explain-topic` bake-off task, so the rule a model is measured against is
 * the rule its output is held to.
 *
 * Design: docs/architecture/ask-to-explain-design.md (Decision 4).
 */
import { matchesAny } from './checks.js';
import { guardLessonDraft, type ContentGuardFinding, type FittedLesson, type GuardResult } from './content-guard.js';

export const EXPLAIN_GUARD_VERSION = 'explain-guard-v1';

export type ExplainGuardFinding = Extract<ContentGuardFinding,
  'FORMAT_INVALID' | 'TRUNCATED' | 'LANGUAGE_MISMATCH' | 'PERSONAL_DATA' | 'READINESS_FIGURE' | 'PLACEMENT_CHANCE' | 'OUTCOME_PROMISE'>
  | 'UNSAFE_INSTRUCTIONS'
  | 'READINESS_MENTION';

/**
 * Instructions to make or use something that hurts people. Narrow on purpose: a physics lesson explains
 * fission and critical mass; it does not tell the reader how to build, assemble or enrich for a weapon.
 */
export const unsafeInstructionPatterns: readonly string[] = [
  String.raw`\b(?:how to|steps? to|instructions? (?:for|to)|recipe for)\s+(?:build|make|assemble|construct|detonate|synthesi[sz]e|manufacture)\s+(?:a|an|your own)?\s*(?:bomb|explosive|nuclear (?:weapon|device|bomb)|dirty bomb|nerve agent|chemical weapon|bioweapon|firearm|gun)\b`,
  String.raw`\benrich(?:ing|ment)?\b[^.\n]{0,40}\bweapons?[- ]grade\b`,
  String.raw`\b(?:mix|combine)\b[^.\n]{0,60}\bto (?:make|produce) (?:an? )?(?:explosive|toxic gas|poison)\b`,
  String.raw`\b(?:ways?|methods?|how) to (?:kill yourself|commit suicide|end your life|self[- ]harm|hurt yourself)\b`,
  String.raw`\blethal dose\b[^.\n]{0,40}\b(?:take|swallow|you need)\b`,
];

/** The student's own readiness, placement or job prospects: never this area's business. */
export const readinessMentionPatterns: readonly string[] = [
  String.raw`\byour\s+(?:readiness|placement|job prospects|employability|chances of (?:getting )?(?:a job|placed|hired|selected))\b`,
  String.raw`\b(?:readiness|placement)\s+(?:band|score|level)\b`,
];

/**
 * An explain lesson may be shown only if this passes. A one-line `REFUSED:` reply is a refusal (never
 * shown either, and not a guard finding). The lesson is English and copies no assessment item (there is
 * none to copy: the topic is free text).
 */
export interface ExplainGuardResult extends Omit<GuardResult<FittedLesson>, 'findings'> {
  readonly findings: readonly ExplainGuardFinding[];
}

export function guardExplainLesson(input: { readonly text: string; readonly truncated: boolean }): ExplainGuardResult {
  const base = guardLessonDraft({ text: input.text, truncated: input.truncated, language: 'en', assessmentPrompts: [] });
  if (base.refused) return { ok: false, refused: true, findings: [], value: null };
  const findings = new Set<ExplainGuardFinding>(base.findings as ExplainGuardFinding[]);
  if (matchesAny(input.text, unsafeInstructionPatterns)) findings.add('UNSAFE_INSTRUCTIONS');
  if (matchesAny(input.text, readinessMentionPatterns)) findings.add('READINESS_MENTION');
  const list = [...findings];
  return { ok: list.length === 0, refused: false, findings: list, value: list.length === 0 ? base.value : null };
}
