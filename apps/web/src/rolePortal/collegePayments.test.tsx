/**
 * Operations → Organization Detail → Payments received (GROWTH-10): finance records a payment with
 * the amount typed in rupees and sent as integer paise; a positive whole student count is required;
 * clearance is filed as an approval for a second person, never applied directly; bounce, refund and
 * void need a reason; a voided payment offers a correction; account managers read only; anyone else
 * sees the forbidden state; an empty college says plainly that nothing is recorded. Navigation is
 * unchanged (a section of the existing Organization Detail screen).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProtectedAccessToken } from '../api.js';
import { formatPaise, rupeesToPaise } from '../api/collegePayments.js';
import { describeApproval } from './approvals.js';
import { OperationsCollegePaymentsPanel } from './collegePayments.js';

vi.mock('../api.js', async (original) => ({
  ...await original<typeof import('../api.js')>(), getProtectedAccessToken: vi.fn(),
}));

const collegeId = crypto.randomUUID();
const receivedId = crypto.randomUUID();
const clearedId = crypto.randomUUID();
const voidedId = crypto.randomUUID();

const policy = (over: Record<string, unknown> = {}) => ({
  canRecord: true,
  instruments: ['CHEQUE', 'DEMAND_DRAFT', 'BANK_TRANSFER', 'UPI'],
  reasons: {
    record: ['PAYMENT_RECEIVED', 'CORRECTION'], clearance: ['BANK_STATEMENT_CONFIRMED', 'BANK_ADVICE_RECEIVED'],
    bounce: ['INSUFFICIENT_FUNDS', 'SIGNATURE_MISMATCH', 'STOPPED', 'STALE', 'OTHER'], refund: ['OVERPAYMENT', 'OTHER'], void: ['ENTERED_IN_ERROR', 'WRONG_DETAILS'],
  },
  limits: { maxAmountPaise: 100_000_000_000, maxStudents: 100_000, maxCoverageDays: 1096, earliestDate: '2020-01-01', noteLimit: 500 },
  currency: 'INR', correlationId: 'corr-policy', ...over,
});

const payment = (over: Record<string, unknown>) => ({
  id: crypto.randomUUID(), instrument: 'CHEQUE', instrumentReference: 'CHQ004512', amountPaise: 12_500_050, currency: 'INR', studentsPaid: 37,
  receivedOn: '2026-09-20', coversFrom: '2026-07-01', coversTo: '2027-06-30', state: 'RECEIVED', recordReasonCode: 'PAYMENT_RECEIVED',
  replacesPaymentId: null, replacedByPaymentId: null, note: null, recordedBy: 'finance@ai8ht.test', recordedAt: '2026-09-21T05:00:00.000Z',
  cleared: null, bounced: null, refunded: null, voided: null, pendingClearance: null, ...over,
});

const listing = (over: Record<string, unknown> = {}) => ({
  institution: { id: collegeId, name: 'Alpha College', verificationState: 'VERIFIED' },
  payments: [
    payment({ id: receivedId }),
    payment({ id: clearedId, instrument: 'BANK_TRANSFER', instrumentReference: 'UTR20260915', amountPaise: 5_000_000, studentsPaid: 10, state: 'CLEARED',
      cleared: { on: '2026-09-16', at: '2026-09-16T06:00:00.000Z', by: 'finance@ai8ht.test', approvedBy: 'approver@ai8ht.test', mode: 'DUAL' } }),
    payment({ id: voidedId, instrumentReference: 'CHQ000001', state: 'VOIDED', voided: { at: '2026-09-10T06:00:00.000Z', by: 'finance@ai8ht.test', reasonCode: 'WRONG_DETAILS' } }),
  ],
  counts: { RECEIVED: 1, CLEARED: 1, BOUNCED: 0, REFUNDED: 0, VOIDED: 1 }, capped: false, today: '2026-10-02', canRecord: true, correlationId: 'corr-list', ...over,
});

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, headers: new Headers() });
const failure = (status: number, code: string, correlationId: string) => Promise.resolve({
  ok: false, status, json: async () => ({ error: { code, correlationId } }), headers: new Headers(),
});
let policyResponse: () => Promise<unknown> = () => ok(policy());
let listResponse: () => Promise<unknown> = () => ok(listing());

beforeEach(() => {
  policyResponse = () => ok(policy());
  listResponse = () => ok(listing());
  vi.mocked(getProtectedAccessToken).mockReturnValue(crypto.randomUUID());
  fetchMock.mockReset().mockImplementation((url: string, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path.includes('/operations/college-payments/policy')) return policyResponse();
    if (path.includes('/operations/approvals/policy')) return ok({ actions: [], decisionReasons: { APPROVE: [], REJECT: [] }, approverCount: 2, soloSafeguardActive: false, correlationId: 'corr-ap' });
    if (path.includes('/operations/approvals') && method === 'POST') return ok({ approval: { id: crypto.randomUUID() }, correlationId: 'corr-filed' });
    if (path.includes('/operations/college-payments') && method === 'POST') return ok({ payment: payment({}), correlationId: 'corr-write' });
    if (path.includes('/operations/college-payments')) return listResponse();
    if (path.includes('/operations/organizations')) return ok({ organizations: [{ id: collegeId, legalName: 'Alpha College Trust', profile: { displayName: 'Alpha College' } }] });
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openAlpha(): Promise<HTMLElement> {
  render(<OperationsCollegePaymentsPanel />);
  const select = await screen.findByLabelText('College');
  await within(select).findByText('Alpha College');
  fireEvent.change(select, { target: { value: collegeId } });
  await screen.findByText('CHQ004512');
  return screen.getByRole('region', { name: 'Payments received' });
}

function posted(fragment: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url, init]) => String(url).includes(fragment) && (init as RequestInit | undefined)?.method === 'POST');
  return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
}

describe('payments received on Organization Detail', () => {
  it('lists real payments with rupees, the count, the period and the state, and counts by state', async () => {
    const panel = await openAlpha();
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('₹1,25,000.50');
    expect(rows[0]).toHaveTextContent('37');
    expect(rows[0]).toHaveTextContent('Received, not cleared');
    expect(rows[1]).toHaveTextContent(/Cleared .*2026, approved by approver@ai8ht.test/);
    expect(rows[2]).toHaveTextContent('Voided (entered in error)');
    expect(within(panel).getByText('Cleared', { selector: 'small' }).previousSibling).toHaveTextContent('1');
    expect(within(rows[0]!).getByRole('button', { name: 'Request clearance…' })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole('button', { name: 'Request clearance…' })).not.toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Refunded…' })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('button', { name: 'Record correction…' })).toBeInTheDocument();
  });

  it('records a payment with the amount in paise and refuses a count that is not a positive whole number', async () => {
    await openAlpha();
    fireEvent.click(screen.getByRole('button', { name: 'Record a payment…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Instrument/), { target: { value: 'CHEQUE' } });
    fireEvent.change(within(dialog).getByLabelText(/Cheque or DD number/), { target: { value: 'CHQ777001' } });
    fireEvent.change(within(dialog).getByLabelText(/Amount in rupees/), { target: { value: '1,25,000.50' } });
    fireEvent.change(within(dialog).getByLabelText(/Received on/), { target: { value: '2026-09-28' } });
    fireEvent.change(within(dialog).getByLabelText(/Covers from/), { target: { value: '2026-07-01' } });
    fireEvent.change(within(dialog).getByLabelText(/Covers to/), { target: { value: '2027-06-30' } });
    for (const bad of ['0', '2.5', '-3']) {
      fireEvent.change(within(dialog).getByLabelText(/Students paid for/), { target: { value: bad } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('whole number of at least 1');
    }
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/operations/college-payments') && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText(/Students paid for/), { target: { value: '37' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Payment recorded as received');
    expect(posted('/operations/college-payments')).toEqual({
      collegeId, instrument: 'CHEQUE', instrumentReference: 'CHQ777001', amountPaise: 12_500_050, studentsPaid: 37,
      receivedOn: '2026-09-28', coversFrom: '2026-07-01', coversTo: '2027-06-30', reasonCode: 'PAYMENT_RECEIVED',
    });
  });

  it('files a clearance as an approval bound to the payment and the cleared date — never clears directly', async () => {
    await openAlpha();
    fireEvent.click(screen.getByRole('button', { name: 'Request clearance…' }));
    let dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Cleared on/), { target: { value: '2026-09-30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('approval required from a second person');
    expect(dialog).toHaveTextContent('₹1,25,000.50');
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'BANK_STATEMENT_CONFIRMED' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request approval' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Approval requested');
    expect(posted('/operations/approvals')).toEqual({ actionKey: 'INSTITUTION_PAYMENT_CLEARANCE', payload: { paymentId: receivedId, clearedOn: '2026-09-30', reasonCode: 'BANK_STATEMENT_CONFIRMED' } });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/clear'))).toBe(false);
  });

  it('needs a reason to void, and offers a correction that names the voided entry', async () => {
    await openAlpha();
    const rows = within(screen.getByRole('region', { name: 'Payments received' })).getAllByRole('row').slice(1);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Void…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose a reason code.');
    fireEvent.change(within(dialog).getByLabelText(/Reason code/), { target: { value: 'ENTERED_IN_ERROR' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Payment voided');
    expect(posted(`/college-payments/${receivedId}/void`)).toEqual({ reasonCode: 'ENTERED_IN_ERROR' });
    fireEvent.click(await screen.findByRole('button', { name: 'Record correction…' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('This entry replaces the voided cheque CHQ000001.');
  });

  it('is read-only for an account manager', async () => {
    policyResponse = () => ok(policy({ canRecord: false }));
    listResponse = () => ok(listing({ canRecord: false }));
    const panel = await openAlpha();
    expect(within(panel).queryByRole('button', { name: 'Record a payment…' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Void|Request clearance|Bounced/ })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent('Recording and changing them needs growth finance access.');
  });

  it('says plainly when nothing is recorded, with NA nowhere invented', async () => {
    listResponse = () => ok(listing({ payments: [], counts: { RECEIVED: 0, CLEARED: 0, BOUNCED: 0, REFUNDED: 0, VOIDED: 0 } }));
    render(<OperationsCollegePaymentsPanel />);
    const select = await screen.findByLabelText('College');
    await within(select).findByText('Alpha College');
    fireEvent.change(select, { target: { value: collegeId } });
    expect(await screen.findByText(/No payments are recorded for this college/)).toBeInTheDocument();
  });

  it('shows NA in the stat slots before a college is chosen, and the forbidden state with its reference', async () => {
    render(<OperationsCollegePaymentsPanel />);
    expect((await screen.findByText('Cleared', { selector: 'small' })).previousSibling).toHaveTextContent('NA');
    cleanup();
    policyResponse = () => failure(403, 'FORBIDDEN', 'corr-forbidden');
    render(<OperationsCollegePaymentsPanel />);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('money helpers and the approvals queue', () => {
  it('converts rupees to paise without a float and formats with Indian grouping', () => {
    expect(rupeesToPaise('0.29', 100)).toBe(29);
    expect(rupeesToPaise('1,25,000.50', 100_000_000_000)).toBe(12_500_050);
    expect(rupeesToPaise('12.345', 100_000)).toBeNull();
    expect(rupeesToPaise('0', 100_000)).toBeNull();
    expect(formatPaise(12_500_050)).toBe('₹1,25,000.50');
  });

  it('describes a clearance approval with the college, instrument, amount, count and date', () => {
    const text = describeApproval({
      id: crypto.randomUUID(), actionKey: 'INSTITUTION_PAYMENT_CLEARANCE', actionLabel: 'Record a college payment as cleared', state: 'PENDING',
      payload: {},
      summary: {
        organizationName: 'Alpha College Trust', flagKey: null, enabled: null, capability: null, memberEmail: null, holdReason: null, olderThan: null, limit: null,
        paymentInstrument: 'DEMAND_DRAFT', paymentReference: 'DD123456', paymentReceivedOn: '2026-09-20', paymentAmountPaise: 5_000_000, paymentStudentsPaid: 10, paymentClearedOn: '2026-09-25',
      },
    } as unknown as Parameters<typeof describeApproval>[0]);
    expect(text).toBe("Record as cleared on 2026-09-25: Alpha College Trust's demand draft DD123456 of ₹50,000.00 for 10 students, received 2026-09-20");
  });
});
