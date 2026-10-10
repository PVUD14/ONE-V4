/**
 * The small-count rule as text, for every screen that shows an aggregate count of people.
 *
 * Product rule 3: any count under five is shown as "<5", never the number. The server already
 * drops the value of a group under five (`{ suppressed: true, value: null }`, or a bare `null`);
 * this applies the same rule once more on the way out, so a count that slips through unsuppressed
 * still never reaches the screen as 0-4. There is one copy of the rule and of the "<5" text here,
 * and `<SmallCount>` (./smallCount.tsx) is how it is drawn. React-free so the API layer can use it.
 */

/** Appendix 1 §5.5 / Appendix 3 §5.3: a group of fewer than this many people is never shown. */
export const SMALL_COUNT_THRESHOLD = 5;

/** The only text a suppressed count is ever shown as. */
export const SMALL_COUNT_TEXT = '<5';

/**
 * A count as the server may send it: a number, `null` (withheld), or a suppressed-count object
 * (`{ suppressed, value }` or `{ suppressed, count }`, as in ReportCountDto and the institution
 * and operations DTOs).
 */
export type SuppressibleCount =
  | number
  | null
  | { readonly suppressed: boolean; readonly value?: number | null; readonly count?: number | null };

/** True when the count must not be shown as a number: withheld by the server, or under five. */
export function isSmallCount(input: SuppressibleCount): boolean {
  if (input === null) return true;
  if (typeof input === 'number') return input < SMALL_COUNT_THRESHOLD;
  if (input.suppressed) return true;
  const value = input.value !== undefined ? input.value : input.count;
  return value === null || value === undefined || value < SMALL_COUNT_THRESHOLD;
}

/** The shown value, or null when it is a small count (never turned back into a number). */
export function shownCount(input: SuppressibleCount): number | null {
  if (isSmallCount(input)) return null;
  if (typeof input === 'number') return input;
  const value = input!.value !== undefined ? input!.value : input!.count;
  return value ?? null;
}

/** The count as text: "<5" for a small or withheld count, otherwise the formatted number. */
export function smallCountText(input: SuppressibleCount, format: (value: number) => string = String): string {
  const value = shownCount(input);
  return value === null ? SMALL_COUNT_TEXT : format(value);
}

/** True when a piece of already-formatted text is the small-count text. */
export function isSmallCountText(text: unknown): boolean {
  return typeof text === 'string' && /^<\s?5$/.test(text.trim());
}
