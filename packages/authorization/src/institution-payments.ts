/**
 * College payments received (GROWTH-10): the vocabulary, bounds and transition rules of
 * `institution_payments`, as pure functions so the API, the web and the tests share one answer.
 * Migration 0111's CHECKs and trigger repeat every rule here for any other writer.
 *
 * ONE records that a college paid; it never takes, makes or reconciles a payment. Money is
 * integer paise: rupees typed as text are converted by string arithmetic, never through a float.
 *
 * Design: docs/architecture/institution-payments-table-design.md
 */

export const institutionPaymentInstruments = ['CHEQUE', 'DEMAND_DRAFT', 'BANK_TRANSFER', 'UPI'] as const;
export type InstitutionPaymentInstrument = (typeof institutionPaymentInstruments)[number];

export const institutionPaymentStates = ['RECEIVED', 'CLEARED', 'BOUNCED', 'REFUNDED', 'VOIDED'] as const;
export type InstitutionPaymentState = (typeof institutionPaymentStates)[number];

/** Why a payment row is written: a payment letter received, or a correction of a voided row. */
export const institutionPaymentRecordReasons = ['PAYMENT_RECEIVED', 'CORRECTION'] as const;
/** Why finance asks for a clearance (the OPS-02 request reasons of INSTITUTION_PAYMENT_CLEARANCE). */
export const institutionPaymentClearanceReasons = ['BANK_STATEMENT_CONFIRMED', 'BANK_ADVICE_RECEIVED'] as const;
export const institutionPaymentBounceReasons = ['INSUFFICIENT_FUNDS', 'SIGNATURE_MISMATCH', 'STOPPED', 'STALE', 'OTHER'] as const;
export const institutionPaymentRefundReasons = ['OVERPAYMENT', 'DUPLICATE_PAYMENT', 'COLLEGE_EXITED', 'COMMERCIAL_SETTLEMENT', 'OTHER'] as const;
export const institutionPaymentVoidReasons = ['ENTERED_IN_ERROR', 'DUPLICATE_ENTRY', 'WRONG_COLLEGE', 'WRONG_DETAILS'] as const;

/** ₹100 crore, in paise: a sanity bound, not a business rule (0111 CHECK). Below 2^53, so a JSON number is exact. */
export const institutionPaymentMaxAmountPaise = 100_000_000_000;
export const institutionPaymentMaxStudents = 100_000;
/** The coverage period is at most three years (0111 CHECK). */
export const institutionPaymentMaxCoverageDays = 1096;
export const institutionPaymentEarliestDate = '2020-01-01';
export const institutionPaymentNoteLimit = 500;
/** The cheque or DD number, or the UTR. Never a bank account number (the screen says so). */
export const institutionPaymentReferencePattern = /^[A-Za-z0-9/-]{4,40}$/;

export type InstitutionPaymentTransition = 'CLEAR' | 'BOUNCE' | 'REFUND' | 'VOID';

const transitionFrom: Readonly<Record<InstitutionPaymentTransition, readonly InstitutionPaymentState[]>> = {
  CLEAR: ['RECEIVED'],
  BOUNCE: ['RECEIVED'],
  REFUND: ['CLEARED'],
  VOID: ['RECEIVED', 'CLEARED', 'BOUNCED', 'REFUNDED'],
};

export const institutionPaymentTransitionTarget: Readonly<Record<InstitutionPaymentTransition, InstitutionPaymentState>> = {
  CLEAR: 'CLEARED', BOUNCE: 'BOUNCED', REFUND: 'REFUNDED', VOID: 'VOIDED',
};

/** Null when the transition may happen from this state; otherwise the refusal code. */
export function refuseInstitutionPaymentTransition(state: string, transition: InstitutionPaymentTransition): 'INSTITUTION_PAYMENT_STATE_INVALID' | null {
  return (transitionFrom[transition] as readonly string[]).includes(state) ? null : 'INSTITUTION_PAYMENT_STATE_INVALID';
}

/** The transitions a payment in this state still allows (what the screen offers). */
export function institutionPaymentNextTransitions(state: string): readonly InstitutionPaymentTransition[] {
  return (Object.keys(transitionFrom) as InstitutionPaymentTransition[]).filter((transition) => refuseInstitutionPaymentTransition(state, transition) === null);
}

/**
 * Rupees typed as text ("125000", "1,25,000.50", "₹ 99.5") to integer paise, or null when it is
 * not a positive amount within the bound. String arithmetic only: no float ever holds the value.
 */
export function parseRupeesToPaise(text: string): number | null {
  const cleaned = text.trim().replace(/^₹\s*/, '').replace(/,/g, '');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const rupees = match[1]!;
  const paise = (match[2] ?? '').padEnd(2, '0');
  const value = Number(rupees) * 100 + Number(paise);
  if (!Number.isSafeInteger(value) || value <= 0 || value > institutionPaymentMaxAmountPaise) return null;
  return value;
}

/** Integer paise as Indian-grouped rupees with paise, e.g. 12500050 → "₹1,25,000.50". */
export function formatPaiseAsRupees(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) return 'NA';
  const rupees = Math.floor(paise / 100).toString();
  const rest = (paise % 100).toString().padStart(2, '0');
  const lastThree = rupees.slice(-3);
  const head = rupees.slice(0, -3);
  const grouped = head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree : lastThree;
  return `₹${grouped}.${rest}`;
}

/** An amount in paise from an API body: a positive safe integer within the bound. */
export function isInstitutionPaymentAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= institutionPaymentMaxAmountPaise;
}

export function isInstitutionPaymentStudentCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= institutionPaymentMaxStudents;
}

/** A calendar date as YYYY-MM-DD that exists (2025-02-30 does not). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Whole days from one calendar date to another (both YYYY-MM-DD). */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
}
