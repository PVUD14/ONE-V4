/**
 * ONE · API client — Operations college payments received (GROWTH-10).
 *
 * Finance records what a college paid AI8HT and whether it cleared; customer success reads it.
 * Amounts travel as integer paise and are converted from the rupees an operator types by string
 * arithmetic, never through a float. Clearance is filed as an INSTITUTION_PAYMENT_CLEARANCE approval
 * (approvals.ts) and executed here once a second person approves. Its own file keeps parallel goals
 * out of each other's way; api.ts re-exports it.
 */
import { requestJson } from './http.js';

export type CollegePaymentState = 'RECEIVED' | 'CLEARED' | 'BOUNCED' | 'REFUNDED' | 'VOIDED';

export interface CollegePaymentDto {
  readonly id: string;
  readonly instrument: string;
  readonly instrumentReference: string;
  readonly amountPaise: number;
  readonly currency: 'INR';
  readonly studentsPaid: number;
  readonly receivedOn: string;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly state: CollegePaymentState;
  readonly recordReasonCode: string;
  readonly replacesPaymentId: string | null;
  readonly replacedByPaymentId: string | null;
  readonly note: string | null;
  readonly recordedBy: string | null;
  readonly recordedAt: string;
  readonly cleared: { readonly on: string; readonly at: string; readonly by: string | null; readonly approvedBy: string | null; readonly mode: 'DUAL' | 'SOLO' | null } | null;
  readonly bounced: { readonly on: string; readonly at: string; readonly by: string | null; readonly reasonCode: string } | null;
  readonly refunded: { readonly on: string; readonly at: string; readonly by: string | null; readonly reasonCode: string } | null;
  readonly voided: { readonly at: string; readonly by: string | null; readonly reasonCode: string } | null;
  readonly pendingClearance: { readonly approvalId: string; readonly state: 'PENDING' | 'APPROVED'; readonly clearedOn: string | null } | null;
}

export interface CollegePaymentsDto {
  readonly institution: { readonly id: string; readonly name: string; readonly verificationState: string };
  readonly payments: readonly CollegePaymentDto[];
  readonly counts: Readonly<Record<CollegePaymentState, number>>;
  readonly capped: boolean;
  readonly today: string;
  readonly canRecord: boolean;
  readonly correlationId: string;
}

export interface CollegePaymentPolicyDto {
  readonly canRecord: boolean;
  readonly instruments: readonly string[];
  readonly reasons: {
    readonly record: readonly string[]; readonly clearance: readonly string[]; readonly bounce: readonly string[];
    readonly refund: readonly string[]; readonly void: readonly string[];
  };
  readonly limits: { readonly maxAmountPaise: number; readonly maxStudents: number; readonly maxCoverageDays: number; readonly earliestDate: string; readonly noteLimit: number };
  readonly currency: 'INR';
  readonly correlationId: string;
}

export interface RecordCollegePaymentBody {
  readonly collegeId: string;
  readonly instrument: string;
  readonly instrumentReference: string;
  readonly amountPaise: number;
  readonly studentsPaid: number;
  readonly receivedOn: string;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly reasonCode: string;
  readonly replacesPaymentId?: string;
  readonly note?: string;
}

const signalOf = (signal?: AbortSignal) => (signal ? { signal } : {});
const base = '/api/v1/operations/college-payments';
const paymentPath = (id: string) => `${base}/${encodeURIComponent(id)}`;

export function getCollegePaymentPolicy(token: string, signal?: AbortSignal): Promise<CollegePaymentPolicyDto> {
  return requestJson(`${base}/policy`, { token, ...signalOf(signal) });
}

export function listCollegePayments(token: string, collegeId: string, signal?: AbortSignal): Promise<CollegePaymentsDto> {
  return requestJson(`${base}?collegeId=${encodeURIComponent(collegeId)}`, { token, ...signalOf(signal) });
}

export function recordCollegePayment(token: string, body: RecordCollegePaymentBody): Promise<{ readonly payment: CollegePaymentDto; readonly correlationId: string }> {
  return requestJson(base, { token, method: 'POST', body });
}

export function clearCollegePayment(token: string, paymentId: string, body: { readonly clearedOn: string; readonly reasonCode: string; readonly approvalId: string }): Promise<{ readonly payment: CollegePaymentDto; readonly correlationId: string }> {
  return requestJson(`${paymentPath(paymentId)}/clear`, { token, method: 'POST', body });
}

export function bounceCollegePayment(token: string, paymentId: string, body: { readonly on: string; readonly reasonCode: string; readonly note?: string }): Promise<{ readonly payment: CollegePaymentDto; readonly correlationId: string }> {
  return requestJson(`${paymentPath(paymentId)}/bounce`, { token, method: 'POST', body });
}

export function refundCollegePayment(token: string, paymentId: string, body: { readonly on: string; readonly reasonCode: string; readonly note?: string }): Promise<{ readonly payment: CollegePaymentDto; readonly correlationId: string }> {
  return requestJson(`${paymentPath(paymentId)}/refund`, { token, method: 'POST', body });
}

export function voidCollegePayment(token: string, paymentId: string, body: { readonly reasonCode: string; readonly note?: string }): Promise<{ readonly payment: CollegePaymentDto; readonly correlationId: string }> {
  return requestJson(`${paymentPath(paymentId)}/void`, { token, method: 'POST', body });
}

/**
 * Rupees typed as text ("125000", "1,25,000.50") to integer paise, or null when it is not a positive
 * amount within the limit. String arithmetic only, the same rule as the server's.
 */
export function rupeesToPaise(text: string, maxPaise: number): number | null {
  const cleaned = text.trim().replace(/^₹\s*/, '').replace(/,/g, '');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const value = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(value) && value > 0 && value <= maxPaise ? value : null;
}

/** Integer paise as Indian-grouped rupees, e.g. 12500050 → "₹1,25,000.50". */
export function formatPaise(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) return 'NA';
  const rupees = Math.floor(paise / 100).toString();
  const head = rupees.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${rupees.slice(-3)}` : rupees;
  return `₹${grouped}.${(paise % 100).toString().padStart(2, '0')}`;
}
