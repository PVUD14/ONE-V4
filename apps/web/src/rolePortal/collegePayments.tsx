/**
 * Operations → Organization Detail → Payments received (GROWTH-10).
 *
 * What a college paid AI8HT — the cheque, draft or transfer, its amount, how many students it pays
 * for and the period — and whether it cleared, bounced, was refunded or was entered in error. Finance
 * (GROWTH_FINANCE) records and moves payments; customer success (ACCOUNT_MANAGE) reads them; anyone
 * else sees the existing "Not permitted" state. Clearance starts commission, so it is filed as an
 * approval for a second person and carried out from Settings → Approvals. Rows are never edited: a
 * mistake is voided and recorded again as a correction. Real rows only — an empty college says so.
 *
 * Design: docs/architecture/institution-payments-table-design.md
 */
import { useEffect, useState } from 'react';
import { ApiRequestError, getProtectedAccessToken, listOperationsOrganizations } from '../api.js';
import {
  bounceCollegePayment,
  formatPaise,
  getCollegePaymentPolicy,
  listCollegePayments,
  recordCollegePayment,
  refundCollegePayment,
  rupeesToPaise,
  voidCollegePayment,
  type CollegePaymentDto,
  type CollegePaymentPolicyDto,
  type CollegePaymentsDto,
  type CollegePaymentState,
} from '../api/collegePayments.js';
import { V2EmptyState, V2Stat } from '../dashboardsV2.js';
import { StatusBadge } from '../studentComponents.js';
import { RequestApprovalDialog } from './approvals.js';
import { formatApiError } from './shared.js';

const NA = 'NA';

function words(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());
}

function dateText(value: string | null | undefined): string {
  if (!value) return NA;
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}

const stateTone: Readonly<Record<CollegePaymentState, 'success' | 'warning' | 'neutral' | 'info' | 'danger'>> = {
  RECEIVED: 'warning', CLEARED: 'success', BOUNCED: 'danger', REFUNDED: 'info', VOIDED: 'neutral',
};

const stateLabel: Readonly<Record<CollegePaymentState, string>> = {
  RECEIVED: 'Received, not cleared', CLEARED: 'Cleared', BOUNCED: 'Bounced', REFUNDED: 'Refunded', VOIDED: 'Voided (entered in error)',
};

type Dialog =
  | { readonly kind: 'record'; readonly replaces?: CollegePaymentDto }
  | { readonly kind: 'clear-date'; readonly payment: CollegePaymentDto }
  | { readonly kind: 'clear'; readonly payment: CollegePaymentDto; readonly clearedOn: string }
  | { readonly kind: 'bounce' | 'refund' | 'void'; readonly payment: CollegePaymentDto };

export function OperationsCollegePaymentsPanel(): React.ReactElement | null {
  const token = getProtectedAccessToken();
  const [colleges, setColleges] = useState<readonly { readonly id: string; readonly name: string }[]>([]);
  const [collegeId, setCollegeId] = useState('');
  const [policy, setPolicy] = useState<CollegePaymentPolicyDto | null>(null);
  const [view, setView] = useState<CollegePaymentsDto | null>(null);
  const [forbidden, setForbidden] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    getCollegePaymentPolicy(token, controller.signal)
      .then((result) => { setPolicy(result); setForbidden(''); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiRequestError && cause.status === 403) setForbidden(cause.correlationId);
        else setError(formatApiError(cause, 'Unable to load payment settings.'));
      });
    listOperationsOrganizations(token, { q: '', kind: 'INSTITUTION', verification: '' }, controller.signal)
      .then((result) => setColleges(result.organizations.map((org) => ({ id: org.id, name: org.profile.displayName || org.legalName }))))
      .catch(() => undefined);
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!token || !collegeId || forbidden) return;
    const controller = new AbortController();
    setView(null);
    listCollegePayments(token, collegeId, controller.signal)
      .then((result) => { setView(result); setError(''); })
      .catch((cause) => { if (!controller.signal.aborted) setError(formatApiError(cause, 'Unable to load this college\'s payments.')); });
    return () => controller.abort();
  }, [token, collegeId, forbidden, reload]);

  if (!token) return null;
  const heading = <div className="role-section-title"><h2>Payments received</h2></div>;
  if (forbidden) {
    return <section className="role-card role-wide" aria-label="Payments received">{heading}
      <V2EmptyState icon="🔐" title="Not permitted" note="College payments are for staff who hold growth finance or account management access. Your access has not changed." hint={`Reference: ${forbidden}`} />
    </section>;
  }

  const canRecord = Boolean(view?.canRecord ?? policy?.canRecord);
  const counts = view?.counts;
  const done = (message: string): void => { setDialog(null); setNotice(message); setReload((value) => value + 1); };

  return <section className="role-card role-wide" aria-label="Payments received">
    {heading}
    <p>What a college has paid AI8HT, as its payment letter and the bank say: the cheque, draft or transfer, the amount, how many students it pays for and the period. ONE records payments; it never takes or makes them. A payment is never edited — a mistake is voided and recorded again. Clearing a payment needs a second person&apos;s approval. Colleges, employers, students and growth staff never see this section; growth sees only whether a first payment has cleared.</p>
    <div className="role-management-form">
      <label><span>College</span><select aria-label="College" value={collegeId} onChange={(event) => { setCollegeId(event.target.value); setNotice(''); }}>
        <option value="">Choose a college…</option>
        {colleges.map((college) => <option key={college.id} value={college.id}>{college.name}</option>)}
      </select></label>
    </div>
    <div className="v2-row v2-cols-4 career-stat-strip role-wide" aria-label="Payments by state">
      <V2Stat icon="📥" tone="amber" value={counts ? counts.RECEIVED : NA} label="Received, not cleared" />
      <V2Stat icon="✅" tone="green" value={counts ? counts.CLEARED : NA} label="Cleared" />
      <V2Stat icon="↩️" tone="purple" value={counts ? counts.BOUNCED + counts.REFUNDED : NA} label="Bounced or refunded" />
      <V2Stat icon="🗂️" tone="blue" value={counts ? counts.VOIDED : NA} label="Voided (entered in error)" />
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="role-api-success" role="status">{notice}</p> : null}
    {!collegeId ? <p>Choose a college to see its payments.</p> : null}
    {collegeId && !view && !error ? <p>Loading payments…</p> : null}
    {view ? <>
      <div className="role-section-title"><h3>{view.institution.name}</h3>
        <div className="role-actions">{canRecord ? <button type="button" onClick={() => setDialog({ kind: 'record' })} disabled={!policy}>Record a payment…</button> : null}</div></div>
      {!canRecord ? <p>You can read these payments. Recording and changing them needs growth finance access.</p> : null}
      {view.payments.length ? <div className="role-record-table-wrap"><table className="role-record-table"><caption className="sr-only">Payments received from {view.institution.name}</caption>
        <thead><tr><th>Received</th><th>Instrument</th><th>Amount</th><th>Students paid for</th><th>Period</th><th>State</th><th>Actions</th></tr></thead>
        <tbody>{view.payments.map((payment) => <PaymentRow key={payment.id} payment={payment} canRecord={canRecord} onAction={setDialog} />)}</tbody>
      </table></div> : <p>No payments are recorded for this college. That does not mean it has not paid — only that nobody has recorded a payment in ONE.</p>}
      {view.capped ? <p>Showing the latest 200 payments.</p> : null}
    </> : null}
    {dialog && policy && view ? <PaymentDialog token={token} dialog={dialog} policy={policy} view={view}
      onCancel={() => setDialog(null)} onDone={done}
      onClearDate={(payment, clearedOn) => setDialog({ kind: 'clear', payment, clearedOn })} /> : null}
  </section>;
}

function PaymentRow({ payment, canRecord, onAction }: {
  readonly payment: CollegePaymentDto; readonly canRecord: boolean; readonly onAction: (dialog: Dialog) => void;
}): React.ReactElement {
  const history: string[] = [];
  if (payment.cleared) history.push(`Cleared ${dateText(payment.cleared.on)}${payment.cleared.approvedBy ? `, approved by ${payment.cleared.approvedBy}` : ''}${payment.cleared.mode === 'SOLO' ? ' (solo)' : ''}`);
  if (payment.bounced) history.push(`Bounced ${dateText(payment.bounced.on)} · ${words(payment.bounced.reasonCode)}`);
  if (payment.refunded) history.push(`Refunded ${dateText(payment.refunded.on)} · ${words(payment.refunded.reasonCode)}`);
  if (payment.voided) history.push(`Voided · ${words(payment.voided.reasonCode)}${payment.replacedByPaymentId ? ' · corrected by a later entry' : ''}`);
  if (payment.replacesPaymentId) history.push('Correction of a voided entry');
  const pending = payment.pendingClearance;
  return <tr className="role-record-row">
    <th scope="row"><strong>{dateText(payment.receivedOn)}</strong><small>Recorded by {payment.recordedBy ?? NA}</small></th>
    <td><strong>{words(payment.instrument)}</strong><span>{payment.instrumentReference}</span></td>
    <td>{formatPaise(payment.amountPaise)}</td>
    <td>{payment.studentsPaid.toLocaleString('en-IN')}</td>
    <td>{dateText(payment.coversFrom)} – {dateText(payment.coversTo)}</td>
    <td><StatusBadge label={stateLabel[payment.state]} tone={stateTone[payment.state]} />{history.map((line) => <small key={line}>{line}</small>)}
      {pending ? <small>Clearance {pending.state === 'APPROVED' ? 'approved — carry it out from Settings → Approvals' : 'awaiting approval'}{pending.clearedOn ? ` (cleared ${dateText(pending.clearedOn)})` : ''}</small> : null}</td>
    <td><div className="role-record-actions">{canRecord ? <>
      {payment.state === 'RECEIVED' && !pending ? <button type="button" onClick={() => onAction({ kind: 'clear-date', payment })}>Request clearance…</button> : null}
      {payment.state === 'RECEIVED' ? <button type="button" className="secondary" onClick={() => onAction({ kind: 'bounce', payment })}>Bounced…</button> : null}
      {payment.state === 'CLEARED' ? <button type="button" className="secondary" onClick={() => onAction({ kind: 'refund', payment })}>Refunded…</button> : null}
      {payment.state !== 'VOIDED' ? <button type="button" className="secondary" onClick={() => onAction({ kind: 'void', payment })}>Void…</button> : null}
      {payment.state === 'VOIDED' && !payment.replacedByPaymentId ? <button type="button" className="secondary" onClick={() => onAction({ kind: 'record', replaces: payment })}>Record correction…</button> : null}
    </> : null}</div></td>
  </tr>;
}

function PaymentDialog({ token, dialog, policy, view, onCancel, onDone, onClearDate }: {
  readonly token: string; readonly dialog: Dialog; readonly policy: CollegePaymentPolicyDto; readonly view: CollegePaymentsDto;
  readonly onCancel: () => void; readonly onDone: (message: string) => void;
  readonly onClearDate: (payment: CollegePaymentDto, clearedOn: string) => void;
}): React.ReactElement {
  const replaces = dialog.kind === 'record' ? dialog.replaces : undefined;
  const [instrument, setInstrument] = useState(replaces?.instrument ?? '');
  const [reference, setReference] = useState(replaces?.instrumentReference ?? '');
  const [rupees, setRupees] = useState('');
  const [students, setStudents] = useState('');
  const [receivedOn, setReceivedOn] = useState(replaces?.receivedOn ?? '');
  const [coversFrom, setCoversFrom] = useState(replaces?.coversFrom ?? '');
  const [coversTo, setCoversTo] = useState(replaces?.coversTo ?? '');
  const [on, setOn] = useState(view.today);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (dialog.kind === 'clear') {
    const payment = dialog.payment;
    return <RequestApprovalDialog token={token} actionKey="INSTITUTION_PAYMENT_CLEARANCE" payload={{ paymentId: payment.id, clearedOn: dialog.clearedOn }}
      reasons={policy.reasons.clearance}
      title={`Clear a payment from ${view.institution.name}`}
      details={[
        ['Instrument', `${words(payment.instrument)} ${payment.instrumentReference}`], ['Amount', formatPaise(payment.amountPaise)],
        ['Students paid for', payment.studentsPaid.toLocaleString('en-IN')], ['Cleared on', dateText(dialog.clearedOn)],
        ['Effect', 'Commission for the growth person credited with this college can start from this clearance.'],
      ]}
      onCancel={onCancel} onFiled={(message) => onDone(message)} />;
  }

  const title = dialog.kind === 'record' ? (replaces ? 'Record a correction' : 'Record a payment received')
    : dialog.kind === 'clear-date' ? 'When did the payment clear?'
      : dialog.kind === 'bounce' ? 'Record a bounced payment' : dialog.kind === 'refund' ? 'Record a refund' : 'Void a payment entered in error';
  const reasons = dialog.kind === 'record' ? [] : dialog.kind === 'bounce' ? policy.reasons.bounce : dialog.kind === 'refund' ? policy.reasons.refund : policy.reasons.void;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    if (dialog.kind === 'clear-date') {
      if (!on) { setError('Enter the date the bank cleared the payment.'); return; }
      onClearDate(dialog.payment, on);
      return;
    }
    const extra = note.trim() ? { note: note.trim() } : {};
    setBusy(true);
    try {
      if (dialog.kind === 'record') {
        const amountPaise = rupeesToPaise(rupees, policy.limits.maxAmountPaise);
        const studentsPaid = /^\d{1,6}$/.test(students.trim()) ? Number(students.trim()) : 0;
        if (!instrument || !reference.trim() || !receivedOn || !coversFrom || !coversTo) { setError('Fill in every required field.'); setBusy(false); return; }
        if (amountPaise === null) { setError('Enter the amount in rupees, for example 125000 or 1,25,000.50.'); setBusy(false); return; }
        if (studentsPaid < 1 || studentsPaid > policy.limits.maxStudents) { setError('Enter how many students this payment is for, as a whole number of at least 1.'); setBusy(false); return; }
        await recordCollegePayment(token, {
          collegeId: view.institution.id, instrument, instrumentReference: reference.trim(), amountPaise, studentsPaid, receivedOn, coversFrom, coversTo,
          reasonCode: replaces ? 'CORRECTION' : 'PAYMENT_RECEIVED', ...(replaces ? { replacesPaymentId: replaces.id } : {}), ...extra,
        });
        onDone(replaces ? 'Correction recorded.' : 'Payment recorded as received. Request its clearance once the bank confirms it.');
        return;
      }
      if (!reasonCode) { setError('Choose a reason code.'); setBusy(false); return; }
      if (dialog.kind === 'bounce') await bounceCollegePayment(token, dialog.payment.id, { on, reasonCode, ...extra });
      else if (dialog.kind === 'refund') await refundCollegePayment(token, dialog.payment.id, { on, reasonCode, ...extra });
      else await voidCollegePayment(token, dialog.payment.id, { reasonCode, ...extra });
      onDone(dialog.kind === 'bounce' ? 'Payment recorded as bounced.' : dialog.kind === 'refund' ? 'Refund recorded.' : 'Payment voided. Record a correction if the payment was real.');
    } catch (cause) {
      setError(paymentErrorText(cause));
      setBusy(false);
    }
  };

  return <div className="role-modal-backdrop" role="presentation">
    <section className="role-modal" role="dialog" aria-modal="true" aria-labelledby="college-payment-dialog-title">
      <h2 id="college-payment-dialog-title">{title}</h2>
      <dl>
        <div><dt>College</dt><dd>{view.institution.name}</dd></div>
        {dialog.kind !== 'record' ? <div><dt>Payment</dt><dd>{words(dialog.payment.instrument)} {dialog.payment.instrumentReference} · {formatPaise(dialog.payment.amountPaise)} · received {dateText(dialog.payment.receivedOn)}</dd></div> : null}
        <div><dt>Record</dt><dd>{dialog.kind === 'clear-date' ? 'Next you file the clearance for a second person to approve.' : 'Recorded in the audit log with your reason. The row is never edited afterwards.'}</dd></div>
        <div><dt>Approval</dt><dd>{dialog.kind === 'clear-date' ? 'Required from a second person.' : 'Not required.'}</dd></div>
      </dl>
      <form onSubmit={(event) => void submit(event)} noValidate>
        {dialog.kind === 'record' ? <>
          <label><span>Instrument <em>required</em></span><select value={instrument} onChange={(event) => setInstrument(event.target.value)}>
            <option value="">Choose…</option>
            {policy.instruments.map((value) => <option key={value} value={value}>{words(value)}</option>)}
          </select></label>
          <label><span>Cheque or DD number, or UTR <em>required</em></span><input value={reference} maxLength={40} onChange={(event) => setReference(event.target.value)} placeholder="Never a bank account number" /></label>
          <label><span>Amount in rupees <em>required</em></span><input inputMode="decimal" value={rupees} onChange={(event) => setRupees(event.target.value)} placeholder="125000.00" /></label>
          <label><span>Students paid for <em>required</em></span><input inputMode="numeric" value={students} onChange={(event) => setStudents(event.target.value)} placeholder="As the payment letter states" /></label>
          <label><span>Received on <em>required</em></span><input type="date" value={receivedOn} min={policy.limits.earliestDate} max={view.today} onChange={(event) => setReceivedOn(event.target.value)} /></label>
          <label><span>Covers from <em>required</em></span><input type="date" value={coversFrom} min={policy.limits.earliestDate} onChange={(event) => setCoversFrom(event.target.value)} /></label>
          <label><span>Covers to <em>required</em></span><input type="date" value={coversTo} min={coversFrom || policy.limits.earliestDate} onChange={(event) => setCoversTo(event.target.value)} /></label>
          {replaces ? <p>This entry replaces the voided {words(replaces.instrument).toLowerCase()} {replaces.instrumentReference}.</p> : null}
        </> : null}
        {dialog.kind === 'clear-date' || dialog.kind === 'bounce' || dialog.kind === 'refund' ? <label><span>{dialog.kind === 'clear-date' ? 'Cleared on' : dialog.kind === 'bounce' ? 'Bounced on' : 'Refunded on'} <em>required</em></span>
          <input type="date" value={on} min={dialog.kind === 'refund' ? dialog.payment.cleared?.on ?? dialog.payment.receivedOn : dialog.payment.receivedOn} max={view.today} onChange={(event) => setOn(event.target.value)} /></label> : null}
        {reasons.length ? <label><span>Reason code <em>required</em></span>
          <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} required>
            <option value="">Choose a reason…</option>
            {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
          </select></label> : null}
        {dialog.kind !== 'clear-date' ? <label><span>Note (optional, no personal details)</span><textarea value={note} maxLength={policy.limits.noteLimit} onChange={(event) => setNote(event.target.value)} /></label> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="role-modal-actions">
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : dialog.kind === 'clear-date' ? 'Continue' : 'Save'}</button>
        </div>
      </form>
    </section>
  </div>;
}

function paymentErrorText(cause: unknown): string {
  if (!(cause instanceof ApiRequestError)) return 'The change could not be saved.';
  const messages: Readonly<Record<string, string>> = {
    INSTITUTION_PAYMENT_DUPLICATE: 'This cheque, draft or transfer is already recorded for this college.',
    INSTITUTION_PAYMENT_SELF_DEALING: 'You are credited with bringing in this college, so you cannot record or clear its payments.',
    INSTITUTION_PAYMENT_STATE_INVALID: 'This payment has changed since you opened it. Close this and look again.',
    INSTITUTION_PAYMENT_DATE_INVALID: 'Enter a real date that is not in the future and not before the payment was received.',
    INSTITUTION_PAYMENT_COVERAGE_INVALID: 'The period must end on or after it starts, and be at most three years.',
    INSTITUTION_PAYMENT_REFERENCE_INVALID: 'A reference is 4–40 letters, digits, / or -, with no spaces.',
    INSTITUTION_PAYMENT_AMOUNT_INVALID: 'Enter a positive amount within the limit.',
    INSTITUTION_PAYMENT_STUDENTS_INVALID: 'Enter how many students this payment is for, as a whole number of at least 1.',
    INSTITUTION_PAYMENT_CORRECTION_INVALID: 'A correction replaces one voided payment of this college, once.',
  };
  const message = (cause.code ? messages[cause.code] : undefined) ?? formatApiError(cause, 'The change could not be saved.');
  return message.includes('Reference:') ? message : `${message} Reference: ${cause.correlationId}`;
}
