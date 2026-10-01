/**
 * The hint ladder rules (ENG-15, `hint-ladder-v1`) — pure.
 *
 * Why this exists: a question's four-step hint ladder (OPS-09b's table, level 1 nudge → level 4
 * near solution) is only useful if it climbs and never hands over the answer. These rules find
 * what text can find: a missing level, a level that repeats an earlier one, a hint that states the
 * correct option's text (when the prompt does not already state it) or points at the correct
 * option by its letter. The aptitude pack treats every finding as a problem; the question bank
 * editor shows them to the author and the reviewer as advice and never blocks on them, because
 * matching text cannot judge meaning (OPS-09b Decision 2) — the reviewer decides.
 *
 * Also `readHintLadderProvenance`: the provenance a ladder row takes at submission, which is the
 * ladder's own when the body carries one (ENG-15 revised the ladders, not the items) and the
 * item's otherwise.
 *
 * Nothing here is a score or touches readiness; no model is involved.
 *
 * Design: docs/architecture/hint-ladder-authoring-design.md
 */
import { readAgentDraftProvenance, type AgentDraftBodyProvenance } from './question-bank.js';

export const HINT_LADDER_RULES_VERSION = 'hint-ladder-v1';

export const HINT_LADDER_FINDING_CODES = ['HINT_MISSING', 'HINT_REPEATS_EARLIER', 'HINT_NAMES_ANSWER', 'HINT_NAMES_OPTION'] as const;
export type HintLadderFindingCode = (typeof HINT_LADDER_FINDING_CODES)[number];

export interface HintLadderFinding {
  readonly level: 1 | 2 | 3 | 4;
  readonly code: HintLadderFindingCode;
}

export interface HintLadderInput {
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  /** Null when the reader may not see the key: only completeness and repetition are checked. */
  readonly correctOptionId: string | null;
  readonly hints: readonly string[];
}

/** Lower case, inner whitespace collapsed, trailing full stops dropped. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.。]+$/u, '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `needle` occurs in `haystack` as a whole phrase: not inside a longer word or number. */
function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(haystack);
}

/** "option c", "choice (c)", "answer is (c)", "answer (c)". A bare letter in running text is not a pointer. */
function namesOptionLetter(hint: string, optionId: string): boolean {
  const id = escapeRegExp(optionId.toLowerCase());
  const lower = hint.toLowerCase();
  return new RegExp(`\\b(?:option|choice)\\s*\\(?${id}\\)?(?![\\p{L}\\p{N}])`, 'u').test(lower)
    || new RegExp(`\\banswer\\s*(?:is\\s*)?\\(${id}\\)`, 'u').test(lower);
}

export interface HintLeakInput {
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly correctOptionId: string;
}

/**
 * Whether one piece of help text gives the answer away, by the same rules the ladder uses:
 * the correct option's text as a whole phrase (unless the prompt already states it, or it is a
 * one- or two-letter word), else a pointer at the correct option's letter. Null when neither.
 * Shared with the AI bake-off (ENG-21), which applies it to a model's hint, so the rule a human
 * ladder is held to and the rule a model is held to cannot drift apart.
 */
export function hintLeakFinding(input: HintLeakInput & { readonly hint: string }): Extract<HintLadderFindingCode, 'HINT_NAMES_ANSWER' | 'HINT_NAMES_OPTION'> | null {
  const correct = input.options.find((option) => option.id === input.correctOptionId);
  if (!correct) return null;
  const answer = normalise(correct.text);
  const answerIsInPrompt = answer.length > 0 && containsPhrase(normalise(input.prompt), answer);
  const answerTooShortToMatch = /^\p{L}{1,2}$/u.test(answer);
  if (answer && !answerIsInPrompt && !answerTooShortToMatch && containsPhrase(normalise(input.hint), answer)) return 'HINT_NAMES_ANSWER';
  if (namesOptionLetter(input.hint, correct.id)) return 'HINT_NAMES_OPTION';
  return null;
}

/** Findings for a ladder, in level order. Empty means the rules found nothing. Deterministic. */
export function hintLadderFindings(input: HintLadderInput): readonly HintLadderFinding[] {
  const findings: HintLadderFinding[] = [];
  const earlier: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const level = (index + 1) as HintLadderFinding['level'];
    const raw = typeof input.hints[index] === 'string' ? input.hints[index]! : '';
    const hint = normalise(raw);
    if (!hint) { findings.push({ level, code: 'HINT_MISSING' }); continue; }
    if (earlier.includes(hint)) findings.push({ level, code: 'HINT_REPEATS_EARLIER' });
    else if (input.correctOptionId !== null) {
      const leak = hintLeakFinding({ prompt: input.prompt, options: input.options, correctOptionId: input.correctOptionId, hint: raw });
      if (leak) findings.push({ level, code: leak });
    }
    earlier.push(hint);
  }
  return findings;
}

/**
 * The provenance a hint ladder row takes at submission: the body's `hintLadderProvenance` when it
 * is a valid agent-drafted record (the ladder was revised apart from its item), else the item's
 * own agent-drafted provenance, else null (hand-authored). A ladder is agent-drafted only on an
 * agent-drafted item; its expert notes are the item's followed by the ladder's.
 */
export function readHintLadderProvenance(body: unknown): AgentDraftBodyProvenance | null {
  const item = readAgentDraftProvenance(body);
  if (!item) return null;
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const ladder = raw.hintLadderProvenance && typeof raw.hintLadderProvenance === 'object'
    ? (raw.hintLadderProvenance as Record<string, unknown>) : null;
  if (!ladder) return item;
  const own = readAgentDraftProvenance({ provenance: ladder, expertCheck: ladder.expertCheck });
  if (!own) return item;
  const notes = [item.expertCheck, own.expertCheck ? `Hint ladder: ${own.expertCheck}` : null].filter((note): note is string => Boolean(note)).join(' ');
  return { ...own, expertCheck: notes ? notes.slice(0, 4000) : null };
}
