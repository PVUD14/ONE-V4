/**
 * College payments received (GROWTH-10, migration 0111): record, clear (dual-controlled), bounce,
 * refund and void, and the college's list as Operations → Organization Detail reads it.
 *
 * Every write is one transaction with its audit row and outbox event. Business dates are checked
 * against the database's own date in India; every timestamp is the database's `now()`, stamped by
 * the 0111 trigger. Audit rows and events never carry the amount or the instrument reference: those
 * stay on the immutable row, which only finance and account staff can read. The clearance consumes
 * its INSTITUTION_PAYMENT_CLEARANCE approval in the same transaction, and the trigger repeats the
 * binding for any other writer.
 *
 * Design: docs/architecture/institution-payments-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  institutionPaymentTransitionTarget,
  refuseInstitutionPaymentTransition,
  type InstitutionPaymentInstrument,
  type InstitutionPaymentState,
  type InstitutionPaymentTransition,
} from '@planthepath/authorization/src/index.js';
import { consumeOperationApproval, type ConsumedApproval } from './operation-approvals.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

export interface TransactionalRunner extends SqlRunner {
  transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

type Rows<T> = { rows: T[] };
async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

export type InstitutionPaymentErrorCode =
  | 'COLLEGE_NOT_FOUND'
  | 'INSTITUTION_PAYMENT_NOT_FOUND'
  | 'INSTITUTION_PAYMENT_STATE_INVALID'
  | 'INSTITUTION_PAYMENT_DUPLICATE'
  | 'INSTITUTION_PAYMENT_SELF_DEALING'
  | 'INSTITUTION_PAYMENT_DATE_INVALID'
  | 'INSTITUTION_PAYMENT_CORRECTION_INVALID'
  | 'INSTITUTION_PAYMENT_REJECTED';

export class InstitutionPaymentError extends Error {
  constructor(readonly code: InstitutionPaymentErrorCode) {
    super(code);
    this.name = 'InstitutionPaymentError';
  }
}

export interface InstitutionPaymentView {
  readonly id: string;
  readonly instrument: InstitutionPaymentInstrument;
  readonly instrumentReference: string;
  readonly amountPaise: number;
  readonly currency: 'INR';
  readonly studentsPaid: number;
  readonly receivedOn: string;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly state: InstitutionPaymentState;
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
  /** A clearance approval waiting or approved for this payment, so the screen does not offer a second. */
  readonly pendingClearance: { readonly approvalId: string; readonly state: 'PENDING' | 'APPROVED'; readonly clearedOn: string | null } | null;
}

export interface InstitutionPaymentsView {
  readonly institution: { readonly id: string; readonly name: string; readonly verificationState: string };
  readonly payments: readonly InstitutionPaymentView[];
  readonly counts: Readonly<Record<InstitutionPaymentState, number>>;
  readonly capped: boolean;
  /** The database's date in India, for the screen's date pickers. */
  readonly today: string;
}

const listLimit = 200;

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

async function audit(runner: SqlRunner, input: {
  readonly actorUserId: string; readonly action: string; readonly paymentId: string; readonly institutionId: string;
  readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actorUserId, action: input.action, resourceType: 'institution_payment', resourceId: input.paymentId, correlationId: input.correlationId });
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actorUserId}::uuid, ${input.action}, 'institution_payment', ${input.paymentId},
            ${input.institutionId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

async function outbox(runner: SqlRunner, input: {
  readonly eventType: string; readonly paymentId: string; readonly institutionId: string; readonly payload: Record<string, unknown>;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({
    id, aggregateType: 'institution_payment', aggregateId: input.paymentId, eventType: input.eventType, eventVersion: 1,
    payload: input.payload, actorUserId: input.actorUserId, organizationId: input.institutionId, correlationId: input.correlationId,
  });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${id}::uuid, 'institution_payment', ${input.paymentId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actorUserId}::uuid, ${input.institutionId}::uuid, ${input.correlationId})
  `);
}

/** The database's date in India: the one clock every business date is checked against. */
export async function institutionPaymentToday(runner: SqlRunner): Promise<string> {
  const [row] = await rows<{ today: string }>(runner, sql`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today`);
  return row!.today;
}

/** Design §8.6: whether this person is credited with the college (0111's function, which the trigger also uses). */
export async function isCreditedWithInstitution(runner: SqlRunner, institutionId: string, userId: string): Promise<boolean> {
  const [row] = await rows<{ credited: boolean }>(runner, sql`SELECT institution_payment_credited_user(${institutionId}::uuid, ${userId}::uuid) AS credited`);
  return row?.credited === true;
}

interface PaymentRow {
  id: string; institution_id: string; instrument: InstitutionPaymentInstrument; instrument_reference: string; amount_paise: string | number;
  students_paid: number; received_on: string; covers_from: string; covers_to: string; state: InstitutionPaymentState;
  record_reason_code: string; replaces_payment_id: string | null; replaced_by_payment_id: string | null; note: string | null;
  recorder_email: string | null; recorded_at: Date | string;
  cleared_on: string | null; cleared_at: Date | string | null; clearer_email: string | null; approver_email: string | null; approval_solo: boolean | null;
  bounced_on: string | null; bounced_at: Date | string | null; bouncer_email: string | null; bounce_reason_code: string | null;
  refunded_on: string | null; refunded_at: Date | string | null; refunder_email: string | null; refund_reason_code: string | null;
  voided_at: Date | string | null; voider_email: string | null; void_reason_code: string | null;
  pending_approval_id: string | null; pending_approval_state: 'PENDING' | 'APPROVED' | null; pending_cleared_on: string | null;
}

const paymentSelect = sql`
  SELECT p.id, p.institution_id, p.instrument, p.instrument_reference, p.amount_paise, p.students_paid,
         to_char(p.received_on, 'YYYY-MM-DD') AS received_on, to_char(p.covers_from, 'YYYY-MM-DD') AS covers_from,
         to_char(p.covers_to, 'YYYY-MM-DD') AS covers_to, p.state, p.record_reason_code, p.replaces_payment_id,
         (SELECT r.id FROM institution_payments r WHERE r.replaces_payment_id = p.id) AS replaced_by_payment_id,
         p.note, ru.email AS recorder_email, p.recorded_at,
         to_char(p.cleared_on, 'YYYY-MM-DD') AS cleared_on, p.cleared_at, cu.email AS clearer_email, au.email AS approver_email, a.solo AS approval_solo,
         to_char(p.bounced_on, 'YYYY-MM-DD') AS bounced_on, p.bounced_at, bu.email AS bouncer_email, p.bounce_reason_code,
         to_char(p.refunded_on, 'YYYY-MM-DD') AS refunded_on, p.refunded_at, fu.email AS refunder_email, p.refund_reason_code,
         p.voided_at, vu.email AS voider_email, p.void_reason_code,
         pa.id AS pending_approval_id, pa.state AS pending_approval_state, pa.payload->>'clearedOn' AS pending_cleared_on
  FROM institution_payments p
  LEFT JOIN users ru ON ru.id = p.recorded_by_user_id
  LEFT JOIN users cu ON cu.id = p.cleared_recorded_by_user_id
  LEFT JOIN operation_approvals a ON a.id = p.clearance_approval_id
  LEFT JOIN users au ON au.id = a.decided_by_user_id
  LEFT JOIN users bu ON bu.id = p.bounced_recorded_by_user_id
  LEFT JOIN users fu ON fu.id = p.refunded_recorded_by_user_id
  LEFT JOIN users vu ON vu.id = p.voided_by_user_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.state, x.payload FROM operation_approvals x
    WHERE p.state = 'RECEIVED' AND x.extended_action_key = 'INSTITUTION_PAYMENT_CLEARANCE' AND x.target_id = p.id::text
      AND x.state IN ('PENDING', 'APPROVED') AND now() < x.expires_at
    ORDER BY x.requested_at DESC LIMIT 1
  ) pa ON true`;

function mapPayment(row: PaymentRow): InstitutionPaymentView {
  return {
    id: row.id,
    instrument: row.instrument,
    instrumentReference: row.instrument_reference,
    amountPaise: Number(row.amount_paise),
    currency: 'INR',
    studentsPaid: Number(row.students_paid),
    receivedOn: row.received_on,
    coversFrom: row.covers_from,
    coversTo: row.covers_to,
    state: row.state,
    recordReasonCode: row.record_reason_code,
    replacesPaymentId: row.replaces_payment_id,
    replacedByPaymentId: row.replaced_by_payment_id,
    note: row.note,
    recordedBy: row.recorder_email,
    recordedAt: iso(row.recorded_at)!,
    cleared: row.cleared_on ? { on: row.cleared_on, at: iso(row.cleared_at)!, by: row.clearer_email, approvedBy: row.approver_email, mode: row.approval_solo === null ? null : row.approval_solo ? 'SOLO' : 'DUAL' } : null,
    bounced: row.bounced_on ? { on: row.bounced_on, at: iso(row.bounced_at)!, by: row.bouncer_email, reasonCode: row.bounce_reason_code! } : null,
    refunded: row.refunded_on ? { on: row.refunded_on, at: iso(row.refunded_at)!, by: row.refunder_email, reasonCode: row.refund_reason_code! } : null,
    voided: row.voided_at ? { at: iso(row.voided_at)!, by: row.voider_email, reasonCode: row.void_reason_code! } : null,
    pendingClearance: row.pending_approval_id ? { approvalId: row.pending_approval_id, state: row.pending_approval_state!, clearedOn: row.pending_cleared_on } : null,
  };
}

/** The college's payments, newest first, bounded; null when the id is not an institution. */
export async function loadInstitutionPayments(runner: SqlRunner, institutionId: string): Promise<InstitutionPaymentsView | null> {
  const [college] = await rows<{ id: string; name: string; verification_state: string }>(runner, sql`
    SELECT o.id, COALESCE(NULLIF(p.display_name, ''), o.legal_name) AS name, o.verification_state::text AS verification_state
    FROM organizations o LEFT JOIN organization_profiles p ON p.organization_id = o.id
    WHERE o.id = ${institutionId}::uuid AND o.kind = 'INSTITUTION'
  `);
  if (!college) return null;
  const found = await rows<PaymentRow>(runner, sql`
    ${paymentSelect}
    WHERE p.institution_id = ${institutionId}::uuid
    ORDER BY p.received_on DESC, p.recorded_at DESC, p.id DESC
    LIMIT ${listLimit + 1}
  `);
  const counted = await rows<{ state: InstitutionPaymentState; n: number }>(runner, sql`
    SELECT state, count(*)::int AS n FROM institution_payments WHERE institution_id = ${institutionId}::uuid GROUP BY state
  `);
  const counts: Record<InstitutionPaymentState, number> = { RECEIVED: 0, CLEARED: 0, BOUNCED: 0, REFUNDED: 0, VOIDED: 0 };
  for (const row of counted) counts[row.state] = Number(row.n);
  return {
    institution: { id: college.id, name: college.name, verificationState: college.verification_state },
    payments: found.slice(0, listLimit).map(mapPayment),
    counts,
    capped: found.length > listLimit,
    today: await institutionPaymentToday(runner),
  };
}

export async function loadInstitutionPayment(runner: SqlRunner, paymentId: string, lock = false): Promise<InstitutionPaymentView & { readonly institutionId: string } | null> {
  if (lock) await runner.execute(sql`SELECT 1 FROM institution_payments WHERE id = ${paymentId}::uuid FOR UPDATE`);
  const [row] = await rows<PaymentRow>(runner, sql`${paymentSelect} WHERE p.id = ${paymentId}::uuid`);
  return row ? { ...mapPayment(row), institutionId: row.institution_id } : null;
}

async function guarded<T>(tx: SqlRunner, savepoint: string, work: () => Promise<T>): Promise<T> {
  await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));
  try {
    const result = await work();
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
    return result;
  } catch {
    // The 0111 trigger repeats every rule; if it refuses what the checks above allowed, answer
    // without forwarding database text.
    await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
    throw new InstitutionPaymentError('INSTITUTION_PAYMENT_REJECTED');
  }
}

export interface RecordInstitutionPaymentInput {
  readonly institutionId: string;
  readonly instrument: InstitutionPaymentInstrument;
  readonly instrumentReference: string;
  readonly amountPaise: number;
  readonly studentsPaid: number;
  readonly receivedOn: string;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly reasonCode: 'PAYMENT_RECEIVED' | 'CORRECTION';
  readonly replacesPaymentId: string | null;
  readonly note: string | null;
  readonly actorUserId: string;
  readonly correlationId: string;
}

/** Record a payment received. Refused to anyone credited with the college, and for the same instrument twice. */
export async function recordInstitutionPayment(db: TransactionalRunner, input: RecordInstitutionPaymentInput): Promise<string> {
  return db.transaction(async (tx) => {
    const [college] = await rows<{ id: string }>(tx, sql`SELECT id FROM organizations WHERE id = ${input.institutionId}::uuid AND kind = 'INSTITUTION'`);
    if (!college) throw new InstitutionPaymentError('COLLEGE_NOT_FOUND');
    // One writer per college at a time, so the duplicate check below cannot race.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'institution_payment:' + input.institutionId}))`);
    if (await isCreditedWithInstitution(tx, input.institutionId, input.actorUserId)) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_SELF_DEALING');
    const today = await institutionPaymentToday(tx);
    if (input.receivedOn > today) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_DATE_INVALID');
    if (input.replacesPaymentId) {
      const [replaced] = await rows<{ institution_id: string; state: string; replaced: boolean }>(tx, sql`
        SELECT institution_id, state, EXISTS (SELECT 1 FROM institution_payments r WHERE r.replaces_payment_id = p.id) AS replaced
        FROM institution_payments p WHERE p.id = ${input.replacesPaymentId}::uuid
      `);
      if (!replaced || replaced.institution_id !== input.institutionId || replaced.state !== 'VOIDED' || replaced.replaced) {
        throw new InstitutionPaymentError('INSTITUTION_PAYMENT_CORRECTION_INVALID');
      }
    }
    const [duplicate] = await rows<{ id: string }>(tx, sql`
      SELECT id FROM institution_payments
      WHERE institution_id = ${input.institutionId}::uuid AND instrument = ${input.instrument}
        AND upper(instrument_reference) = upper(${input.instrumentReference}) AND state IN ('RECEIVED', 'CLEARED', 'REFUNDED')
    `);
    if (duplicate) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_DUPLICATE');
    const id = randomUUID();
    await guarded(tx, 'institution_payment_record', () => tx.execute(sql`
      INSERT INTO institution_payments
        (id, institution_id, instrument, instrument_reference, amount_paise, currency, students_paid, received_on, covers_from, covers_to,
         state, record_reason_code, replaces_payment_id, note, recorded_by_user_id, correlation_id)
      VALUES (${id}::uuid, ${input.institutionId}::uuid, ${input.instrument}, ${input.instrumentReference}, ${input.amountPaise}, 'INR',
              ${input.studentsPaid}, ${input.receivedOn}::date, ${input.coversFrom}::date, ${input.coversTo}::date,
              'RECEIVED', ${input.reasonCode}, ${input.replacesPaymentId}::uuid, ${input.note}, ${input.actorUserId}::uuid, ${input.correlationId})
    `));
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.institution_payment.recorded', paymentId: id, institutionId: input.institutionId,
      correlationId: input.correlationId,
      context: {
        instrument: input.instrument, studentsPaid: input.studentsPaid, receivedOn: input.receivedOn, coversFrom: input.coversFrom, coversTo: input.coversTo,
        reasonCode: input.reasonCode, ...(input.replacesPaymentId ? { replacesPaymentId: input.replacesPaymentId } : {}), notePresent: input.note !== null,
      },
    });
    await outbox(tx, {
      eventType: 'institution_payment.recorded', paymentId: id, institutionId: input.institutionId,
      payload: { paymentId: id, institutionId: input.institutionId }, actorUserId: input.actorUserId, correlationId: input.correlationId,
    });
    return id;
  });
}

/**
 * Clear a received payment with its executed INSTITUTION_PAYMENT_CLEARANCE approval, consumed here.
 * `approvalPayload` rebuilds the bound payload from the locked row and the request, so a payment that
 * differs from what was approved is APPROVAL_PAYLOAD_MISMATCH.
 */
export async function clearInstitutionPayment(db: TransactionalRunner, input: {
  readonly paymentId: string;
  readonly clearedOn: string;
  readonly reasonCode: string;
  readonly approvalId: string;
  readonly approvalPayload: (payment: { readonly amountPaise: number; readonly studentsPaid: number }) => Record<string, unknown>;
  readonly actorUserId: string;
  readonly correlationId: string;
}): Promise<{ readonly consumed: ConsumedApproval }> {
  return db.transaction(async (tx) => {
    const payment = await loadInstitutionPayment(tx, input.paymentId, true);
    if (!payment) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_NOT_FOUND');
    if (refuseInstitutionPaymentTransition(payment.state, 'CLEAR')) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_STATE_INVALID');
    if (await isCreditedWithInstitution(tx, payment.institutionId, input.actorUserId)) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_SELF_DEALING');
    const today = await institutionPaymentToday(tx);
    if (input.clearedOn > today || input.clearedOn < payment.receivedOn) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_DATE_INVALID');
    const consumed = await consumeOperationApproval(tx, {
      approvalId: input.approvalId, actionKey: 'INSTITUTION_PAYMENT_CLEARANCE',
      payload: input.approvalPayload({ amountPaise: payment.amountPaise, studentsPaid: payment.studentsPaid }),
      executorUserId: input.actorUserId, correlationId: input.correlationId,
    });
    if (await isCreditedWithInstitution(tx, payment.institutionId, consumed.approvedByUserId)
        || await isCreditedWithInstitution(tx, payment.institutionId, consumed.requestedByUserId)) {
      throw new InstitutionPaymentError('INSTITUTION_PAYMENT_SELF_DEALING');
    }
    await guarded(tx, 'institution_payment_clear', () => tx.execute(sql`
      UPDATE institution_payments
      SET state = 'CLEARED', cleared_on = ${input.clearedOn}::date, cleared_at = now(),
          cleared_recorded_by_user_id = ${input.actorUserId}::uuid, clearance_approval_id = ${input.approvalId}::uuid
      WHERE id = ${input.paymentId}::uuid
    `));
    await audit(tx, {
      actorUserId: input.actorUserId, action: 'operations.institution_payment.cleared', paymentId: input.paymentId, institutionId: payment.institutionId,
      correlationId: input.correlationId,
      context: {
        fromState: 'RECEIVED', toState: 'CLEARED', clearedOn: input.clearedOn, studentsPaid: payment.studentsPaid, reasonCode: input.reasonCode,
        approvalId: input.approvalId, requestedByUserId: consumed.requestedByUserId, approvedByUserId: consumed.approvedByUserId, mode: consumed.mode,
      },
    });
    await outbox(tx, {
      eventType: 'institution_payment.cleared', paymentId: input.paymentId, institutionId: payment.institutionId,
      payload: { paymentId: input.paymentId, institutionId: payment.institutionId, approvalId: input.approvalId },
      actorUserId: input.actorUserId, correlationId: input.correlationId,
    });
    return { consumed };
  });
}

/** Bounce, refund or void: single-person, because each only ever takes commission away (§11.2). */
export async function transitionInstitutionPayment(db: TransactionalRunner, input: {
  readonly paymentId: string;
  readonly transition: Exclude<InstitutionPaymentTransition, 'CLEAR'>;
  /** The bank's date for a bounce or a refund; none for a void. */
  readonly on: string | null;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly actorUserId: string;
  readonly correlationId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const payment = await loadInstitutionPayment(tx, input.paymentId, true);
    if (!payment) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_NOT_FOUND');
    if (refuseInstitutionPaymentTransition(payment.state, input.transition)) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_STATE_INVALID');
    const today = await institutionPaymentToday(tx);
    if (input.transition === 'BOUNCE' && (!input.on || input.on > today || input.on < payment.receivedOn)) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_DATE_INVALID');
    if (input.transition === 'REFUND' && (!input.on || input.on > today || input.on < payment.cleared!.on)) throw new InstitutionPaymentError('INSTITUTION_PAYMENT_DATE_INVALID');
    const update = input.transition === 'BOUNCE'
      ? sql`UPDATE institution_payments SET state = 'BOUNCED', bounced_on = ${input.on}::date, bounced_at = now(),
              bounced_recorded_by_user_id = ${input.actorUserId}::uuid, bounce_reason_code = ${input.reasonCode} WHERE id = ${input.paymentId}::uuid`
      : input.transition === 'REFUND'
        ? sql`UPDATE institution_payments SET state = 'REFUNDED', refunded_on = ${input.on}::date, refunded_at = now(),
                refunded_recorded_by_user_id = ${input.actorUserId}::uuid, refund_reason_code = ${input.reasonCode} WHERE id = ${input.paymentId}::uuid`
        : sql`UPDATE institution_payments SET state = 'VOIDED', voided_at = now(),
                voided_by_user_id = ${input.actorUserId}::uuid, void_reason_code = ${input.reasonCode} WHERE id = ${input.paymentId}::uuid`;
    await guarded(tx, 'institution_payment_transition', () => tx.execute(update));
    const toState = institutionPaymentTransitionTarget[input.transition];
    const verb = toState.toLowerCase();
    await audit(tx, {
      actorUserId: input.actorUserId, action: `operations.institution_payment.${verb}`, paymentId: input.paymentId, institutionId: payment.institutionId,
      correlationId: input.correlationId,
      context: {
        fromState: payment.state, toState, ...(input.on ? { on: input.on } : {}), studentsPaid: payment.studentsPaid, reasonCode: input.reasonCode,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    await outbox(tx, {
      eventType: `institution_payment.${verb}`, paymentId: input.paymentId, institutionId: payment.institutionId,
      payload: { paymentId: input.paymentId, institutionId: payment.institutionId, fromState: payment.state },
      actorUserId: input.actorUserId, correlationId: input.correlationId,
    });
  });
}

/** Design §6.1: whether the college has a payment that stands cleared. A yes or no, nothing else. */
export async function institutionHasClearedPayment(runner: SqlRunner, institutionId: string): Promise<boolean> {
  const [row] = await rows<{ cleared: boolean }>(runner, sql`
    SELECT EXISTS (SELECT 1 FROM institution_payments WHERE institution_id = ${institutionId}::uuid AND state = 'CLEARED') AS cleared
  `);
  return row?.cleared === true;
}
