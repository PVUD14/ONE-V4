/**
 * Authoring helpers for the aptitude bank (ENG-10): turn a hand-written or computed item spec
 * into a pack item, and format numbers the way the items show them.
 *
 * Why this exists: 300 items are written as short specs — a prompt, the answer, three wrong
 * options each optionally naming the misconception it shows, an explanation and a four-step hint
 * ladder — so that the option order, the answer key and the basis/expert-check notes are filled
 * in one way everywhere. Quantitative answers are computed by the templates that call this, never
 * typed. No model is called; nothing here runs in the product.
 */
import type { QuestionDifficulty } from '@planthepath/career-readiness';
import type { AptitudeItem, AptitudeOption } from '../aptitude-bank.js';

export interface WrongOption {
  readonly text: string;
  /** The misconception code this distractor shows, on the item's own skill. */
  readonly code?: string;
  /** Why this option shows it. Defaults to the code's typical rationale. */
  readonly why?: string;
}

export interface ItemSpec {
  readonly key: string;
  readonly difficulty: QuestionDifficulty;
  readonly prompt: string;
  readonly answer: string;
  readonly wrong: readonly [WrongOption, WrongOption, WrongOption];
  readonly explanation: string;
  readonly hints: readonly [string, string, string, string];
  /** Anything specific the subject expert should check, added to the skill's standing note. */
  readonly check?: string;
}

export interface SkillAuthoring {
  readonly skill: string;
  readonly basis: string;
  readonly expertCheck: string;
  /** Typical rationale per code, used when a distractor gives none. */
  readonly rationale: Readonly<Record<string, string>>;
}

const OPTION_IDS = ['a', 'b', 'c', 'd'] as const;

/** A stable position for the correct option (0–3), spread across items by key. */
export function answerPosition(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  return hash % 4;
}

export const STANDING_ITEM_CHECK =
  'Check that the marked answer is correct and is the only defensible option, that each tagged distractor really shows the named misconception, and that hints 1-2 do not give the answer away.';

export function buildItem(authoring: SkillAuthoring, spec: ItemSpec): AptitudeItem {
  const wrong: AptitudeOption[] = spec.wrong.map((option) => ({
    id: '', text: option.text,
    misconception: option.code
      ? { code: option.code, rationale: option.why ?? authoring.rationale[option.code] ?? '' }
      : null,
  }));
  const position = answerPosition(spec.key);
  const ordered: { text: string; misconception: AptitudeOption['misconception'] }[] = [...wrong];
  ordered.splice(position, 0, { text: spec.answer, misconception: null });
  const options = ordered.map((option, index) => ({ id: OPTION_IDS[index]!, text: option.text, misconception: option.misconception }));
  return {
    stableKey: spec.key,
    skill: authoring.skill,
    difficulty: spec.difficulty,
    prompt: spec.prompt,
    options,
    correctOptionId: OPTION_IDS[position]!,
    explanation: spec.explanation,
    hints: [...spec.hints] as [string, string, string, string],
    basis: authoring.basis,
    expertCheck: spec.check ? `${STANDING_ITEM_CHECK} ${authoring.expertCheck} Item: ${spec.check}` : `${STANDING_ITEM_CHECK} ${authoring.expertCheck}`,
  };
}

/** Item keys: the skill key and a three-digit number. */
export const itemKey = (skill: string, index: number): string => `${skill}-${String(index).padStart(3, '0')}`;

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

export const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

/** A number rounded to at most `places` decimals, without trailing zeros; Indian digit grouping above 9999. */
export function num(value: number, places = 2): string {
  const rounded = Number(value.toFixed(places));
  if (Math.abs(rounded) >= 10000 && Number.isInteger(rounded)) return indianGrouping(rounded);
  return String(rounded);
}

/** 12,34,567 — written out rather than left to the platform's locale data, so the pack is identical everywhere. */
function indianGrouping(value: number): string {
  const digits = String(Math.abs(value));
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${rest ? `${rest},` : ''}${last3}`;
}

export const rupees = (value: number): string => `₹${num(value)}`;

/** A fraction in lowest terms, "3/4"; whole numbers stay whole. */
export function fraction(numerator: number, denominator: number): string {
  const divisor = gcd(numerator, denominator);
  const top = numerator / divisor;
  const bottom = denominator / divisor;
  return bottom === 1 ? String(top) : `${top}/${bottom}`;
}

/** A fraction as written, not reduced (for a distractor that shows the unreduced working). */
export const rawFraction = (numerator: number, denominator: number): string => `${numerator}/${denominator}`;

/** A percentage to one decimal place at most, with exact thirds and sixths written as fractions. */
export function percent(value: number): string {
  const thirds: Record<string, string> = { '33.33': '33⅓', '66.67': '66⅔', '16.67': '16⅔', '83.33': '83⅓', '14.29': '14 2/7', '11.11': '11 1/9' };
  const key = value.toFixed(2);
  if (thirds[key]) return `${thirds[key]}%`;
  return `${Number(value.toFixed(1))}%`;
}

/** "1 day", "12 days", "2.4 hours". */
export const count = (value: number, unit: string): string => `${num(value)} ${Number(num(value)) === 1 ? unit : `${unit}s`}`;

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 23rd … */
export function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[value % 10] ?? 'th';
  return `${value}${suffix}`;
}
