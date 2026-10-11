/**
 * ONE · Date display
 *
 * One way to show a date to a person, everywhere in the web app: "7 Oct 2026",
 * "7 Oct 2026, 17:18" and "Sep 2026". Before this each screen picked its own
 * locale format, so one page could read 07/10/2026 and the next 7 Oct 2026.
 * Display only — values sent to the API are never formatted through here.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** Momentum re-skin: a missing value is said plainly, never as "NA". */
const NA = 'Not recorded';

export type DateInput = string | number | Date | null | undefined;

export interface DateFormatOptions {
  /** Read the instant in UTC rather than local time — for values that are a calendar day, not a moment. */
  readonly utc?: boolean;
  /** What to show when there is no usable date. Defaults to "Not recorded". */
  readonly fallback?: string;
}

/** A Date, or null when the value is missing or not a date. A bare "2026-09-25" or "2026-09" is a local calendar day. */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const day = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
    if (day) return new Date(Number(day[1]), Number(day[2]) - 1, day[3] ? Number(day[3]) : 1);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parts(date: Date, utc: boolean): { readonly day: number; readonly month: string; readonly year: number; readonly hours: number; readonly minutes: number } {
  return utc
    ? { day: date.getUTCDate(), month: MONTHS[date.getUTCMonth()]!, year: date.getUTCFullYear(), hours: date.getUTCHours(), minutes: date.getUTCMinutes() }
    : { day: date.getDate(), month: MONTHS[date.getMonth()]!, year: date.getFullYear(), hours: date.getHours(), minutes: date.getMinutes() };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** "7 Oct 2026" */
export function formatDate(value: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? NA;
  const p = parts(date, options.utc ?? false);
  return `${p.day} ${p.month} ${p.year}`;
}

/** "7 Oct 2026, 17:18" */
export function formatDateTime(value: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? NA;
  const p = parts(date, options.utc ?? false);
  return `${p.day} ${p.month} ${p.year}, ${pad(p.hours)}:${pad(p.minutes)}`;
}

/** "Sep 2026" */
export function formatMonth(value: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? NA;
  const p = parts(date, options.utc ?? false);
  return `${p.month} ${p.year}`;
}

/** "17:18" */
export function formatTime(value: DateInput, options: DateFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? NA;
  const p = parts(date, options.utc ?? false);
  return `${pad(p.hours)}:${pad(p.minutes)}`;
}
