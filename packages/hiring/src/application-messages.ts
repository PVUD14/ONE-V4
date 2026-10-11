/**
 * Application-bound message rules (EMP-10): what a message may contain, when an employer may start a
 * conversation, how a student may report one, and the abuse brakes. Pure, so the API, the web and
 * their tests share one definition. Design: docs/architecture/application-messages-table-design.md.
 */

/** A message is text only, at most this many characters (the 0067 CHECK agrees). */
export const MESSAGE_MAX_LENGTH = 2000;
/** A student's own words when reporting a message. */
export const REPORT_STATEMENT_MAX_LENGTH = 1000;

/** Decision 10.2 #8: an employer may open a conversation from SHORTLISTED onward, while the application is open. */
export const messageableApplicationStates = ['SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER'] as const;

export function canEmployerMessage(state: string): boolean {
  return (messageableApplicationStates as readonly string[]).includes(state);
}

/** Why a student reports an employer's message. Fixed, so a case is triaged by code. */
export const messageReportReasonCodes = [
  'SCAM_OR_PAYMENT_REQUEST', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'OFF_PLATFORM_PRESSURE', 'DISCRIMINATION', 'OTHER',
] as const;
export type MessageReportReasonCode = (typeof messageReportReasonCodes)[number];

/** A payment demand is the scam §10.1 names; it goes to the top of the queue. */
export function reportSeverity(reason: MessageReportReasonCode): 'HIGH' | 'MEDIUM' {
  return reason === 'SCAM_OR_PAYMENT_REQUEST' ? 'HIGH' : 'MEDIUM';
}

/**
 * Abuse brakes. Per-thread limits are exact (the thread row is locked when they are counted);
 * per-employer and per-student limits are counted without a global lock.
 */
export const messageLimits = {
  perThreadSidePerHour: 10,
  employerUnansweredInARow: 3,
  employerPerHour: 200,
  employerNewThreadsPerDay: 50,
  studentPerHour: 60,
} as const;

export class MessageInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MessageInputError';
  }
}

// Line breaks and tabs are text; every other control character is refused.
// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Validates a message body and returns it with surrounding whitespace removed. Refuses anything that
 * is not a string, is empty, is longer than {@link MESSAGE_MAX_LENGTH} characters, or carries control
 * or bidirectional-override characters (which can disguise a link).
 */
export function readMessageBody(value: unknown): string {
  if (typeof value !== 'string') throw new MessageInputError('INVALID_BODY');
  const body = value.replace(/\r\n?/g, '\n').trim();
  if (body.length < 1 || body.length > MESSAGE_MAX_LENGTH) throw new MessageInputError('INVALID_BODY');
  if (controlCharacters.test(body)) throw new MessageInputError('INVALID_BODY');
  return body;
}

const linkPatterns = [
  /\bhttps?:\/\//i,
  /\bwww\./i,
  // A bare domain on a common top-level domain, e.g. pay-now.in, bit.ly/x or forms.gle/abc.
  /\b[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})*\.(?:com|in|org|net|co|io|ly|me|info|xyz|app|dev|ai|biz|online|site|link|to|gl|gle|us|uk|edu|gov|ac|tk|top|club|shop|page)(?:[/:?#]|\b)/i,
];

/**
 * True when a message contains something a reader could follow as a link. Links are allowed but
 * flagged, and clients never render them as clickable. Deliberately broad: a false positive only
 * adds a warning.
 */
export function containsLink(body: string): boolean {
  // Email addresses are not links; remove them first so "name@college.edu" is not flagged.
  const withoutEmails = body.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ');
  // Ordinary decimals and times ("7.5", "10.30") are not domains.
  return linkPatterns.some((pattern) => pattern.test(withoutEmails.replace(/\b\d+\.\d+\b/g, ' ')));
}

/** A report's reason code; anything else is refused. */
export function readReportReason(value: unknown): MessageReportReasonCode {
  if (typeof value !== 'string' || !(messageReportReasonCodes as readonly string[]).includes(value)) {
    throw new MessageInputError('INVALID_REASONCODE');
  }
  return value as MessageReportReasonCode;
}

/** A report's optional statement: trimmed, at most {@link REPORT_STATEMENT_MAX_LENGTH} characters. */
export function readReportStatement(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new MessageInputError('INVALID_STATEMENT');
  const statement = value.replace(/\r\n?/g, '\n').trim();
  if (!statement) return null;
  if (statement.length > REPORT_STATEMENT_MAX_LENGTH || controlCharacters.test(statement)) throw new MessageInputError('INVALID_STATEMENT');
  return statement;
}

/** Refuses a request body that is not an object or carries a field outside `allowed`. */
export function assertOnlyFields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new MessageInputError('INVALID_REQUEST');
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new MessageInputError('UNKNOWN_FIELD');
  }
  return record;
}
