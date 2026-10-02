/**
 * Operations → Organization Detail → Payments received (GROWTH-10).
 *
 * Finance (`GROWTH_FINANCE`) records what a college paid AI8HT — instrument, reference, amount in
 * paise, students paid for, the period covered — and later that it cleared, bounced, was refunded or
 * was entered in error. Customer success (`ACCOUNT_MANAGE`) reads the same list. Nobody else, and no
 * college, employer, student or growth route, reads this table; growth sees only whether a payment has
 * cleared (the GROWTH-04 milestone).
 *
 * Clearance is the event commission starts from (D10), so it is dual-controlled: the requester files an
 * INSTITUTION_PAYMENT_CLEARANCE approval in the ordinary approvals queue, a different approver decides
 * it, and `POST /:paymentId/clear` consumes it in the clearance's own transaction. Bounce, refund and
 * void only ever take commission away and are single-person, reason-coded and audited. Anyone credited
 * with the college (design §8.6) is refused. ONE moves no money and calls no bank.
 *
 * Route parameters are `paymentId` and the query `collegeId`, never `institutionId`: the authentication
 * guard treats an `institutionId` parameter as the organisation the caller acts inside.
 *
 * Design: docs/architecture/institution-payments-table-design.md
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  calendarDaysBetween,
  hasInternalCapability,
  institutionPaymentBounceReasons,
  institutionPaymentClearanceReasons,
  institutionPaymentEarliestDate,
  institutionPaymentInstruments,
  institutionPaymentMaxAmountPaise,
  institutionPaymentMaxCoverageDays,
  institutionPaymentMaxStudents,
  institutionPaymentNoteLimit,
  institutionPaymentRecordReasons,
  institutionPaymentReferencePattern,
  institutionPaymentRefundReasons,
  institutionPaymentVoidReasons,
  isCalendarDate,
  isInstitutionPaymentAmount,
  isInstitutionPaymentStudentCount,
  type InstitutionPaymentInstrument,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import {
  clearInstitutionPayment,
  InstitutionPaymentError,
  loadInstitutionPayment,
  loadInstitutionPayments,
  recordInstitutionPayment,
  transitionInstitutionPayment,
} from '@planthepath/persistence/src/institution-payments.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, safeError, type ProtectedHttpRequest } from './api-security.js';
import { dbCapabilityGrantLoader, loadCallerCapabilityContext } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, approvalRequired, readApprovalId } from './operation-approval-gate.js';

type Actor = InternalCapabilityContext & { readonly userId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const canRead = (actor: Actor): boolean => hasInternalCapability(actor, 'GROWTH_FINANCE') || hasInternalCapability(actor, 'ACCOUNT_MANAGE');
const canWrite = (actor: Actor): boolean => hasInternalCapability(actor, 'GROWTH_FINANCE');

@Controller('/api/v1/operations/college-payments')
@UseGuards(ProtectedApiAuthenticationGuard)
export class OperationsCollegePaymentsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /** What the forms need: vocabularies, reasons, bounds, and whether this operator may write. */
  @Get('/policy')
  async policy(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, canRead);
    return {
      canRecord: canWrite(actor),
      instruments: institutionPaymentInstruments,
      reasons: {
        record: institutionPaymentRecordReasons, clearance: institutionPaymentClearanceReasons, bounce: institutionPaymentBounceReasons,
        refund: institutionPaymentRefundReasons, void: institutionPaymentVoidReasons,
      },
      limits: {
        maxAmountPaise: institutionPaymentMaxAmountPaise, maxStudents: institutionPaymentMaxStudents, maxCoverageDays: institutionPaymentMaxCoverageDays,
        earliestDate: institutionPaymentEarliestDate, noteLimit: institutionPaymentNoteLimit,
      },
      currency: 'INR',
      correlationId,
    };
  }

  @Get()
  async list(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, canRead);
    if (Object.keys(query ?? {}).some((key) => key !== 'collegeId')) throw invalid('INVALID_REQUEST', correlationId);
    const collegeId = readUuid(query.collegeId, 'COLLEGE_ID_INVALID', correlationId);
    const view = await loadInstitutionPayments(this.db, collegeId);
    if (!view) throw new NotFoundException(domainError('COLLEGE_NOT_FOUND', correlationId));
    return { ...view, canRecord: canWrite(actor), correlationId };
  }

  @Post()
  async record(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, canWrite);
    const raw = readBody(body, ['collegeId', 'instrument', 'instrumentReference', 'amountPaise', 'studentsPaid', 'receivedOn', 'coversFrom', 'coversTo', 'reasonCode', 'replacesPaymentId', 'note'], correlationId);
    const institutionId = readUuid(raw.collegeId, 'COLLEGE_ID_INVALID', correlationId);
    if (typeof raw.instrument !== 'string' || !(institutionPaymentInstruments as readonly string[]).includes(raw.instrument)) throw invalid('INSTITUTION_PAYMENT_INSTRUMENT_INVALID', correlationId);
    if (typeof raw.instrumentReference !== 'string' || !institutionPaymentReferencePattern.test(raw.instrumentReference.trim())) throw invalid('INSTITUTION_PAYMENT_REFERENCE_INVALID', correlationId);
    if (!isInstitutionPaymentAmount(raw.amountPaise)) throw invalid('INSTITUTION_PAYMENT_AMOUNT_INVALID', correlationId);
    if (!isInstitutionPaymentStudentCount(raw.studentsPaid)) throw invalid('INSTITUTION_PAYMENT_STUDENTS_INVALID', correlationId);
    const receivedOn = readDate(raw.receivedOn, correlationId);
    const coversFrom = readDate(raw.coversFrom, correlationId);
    const coversTo = readDate(raw.coversTo, correlationId);
    if (coversTo < coversFrom || calendarDaysBetween(coversFrom, coversTo) > institutionPaymentMaxCoverageDays) throw invalid('INSTITUTION_PAYMENT_COVERAGE_INVALID', correlationId);
    const reasonCode = readReason(raw.reasonCode, institutionPaymentRecordReasons, correlationId);
    const replacesPaymentId = raw.replacesPaymentId === undefined || raw.replacesPaymentId === null ? null : readUuid(raw.replacesPaymentId, 'INSTITUTION_PAYMENT_CORRECTION_INVALID', correlationId);
    if ((reasonCode === 'CORRECTION') !== (replacesPaymentId !== null)) throw invalid('INSTITUTION_PAYMENT_CORRECTION_INVALID', correlationId);
    const note = readNote(raw.note, correlationId);
    try {
      const id = await recordInstitutionPayment(this.db, {
        institutionId, instrument: raw.instrument as InstitutionPaymentInstrument, instrumentReference: raw.instrumentReference.trim(),
        amountPaise: raw.amountPaise, studentsPaid: raw.studentsPaid, receivedOn, coversFrom, coversTo,
        reasonCode: reasonCode as 'PAYMENT_RECEIVED' | 'CORRECTION', replacesPaymentId, note, actorUserId: actor.userId, correlationId,
      });
      return { payment: await this.payment(id), correlationId };
    } catch (error) {
      throw failure(error, correlationId);
    }
  }

  /** Execute an approved clearance. Without an approval: 403 APPROVAL_REQUIRED. */
  @Post('/:paymentId/clear')
  async clear(@Req() request: ProtectedHttpRequest, @Param('paymentId') paymentIdParam: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, canWrite);
    const paymentId = readUuid(paymentIdParam, 'INSTITUTION_PAYMENT_ID_INVALID', correlationId);
    const raw = readBody(body, ['clearedOn', 'reasonCode', 'approvalId'], correlationId);
    const clearedOn = readDate(raw.clearedOn, correlationId);
    const reasonCode = readReason(raw.reasonCode, institutionPaymentClearanceReasons, correlationId);
    const approvalId = readApprovalId(raw, correlationId);
    if (!approvalId) throw approvalRequired(correlationId);
    try {
      const { consumed } = await clearInstitutionPayment(this.db, {
        paymentId, clearedOn, reasonCode, approvalId,
        approvalPayload: (payment) => approvalPayloads.INSTITUTION_PAYMENT_CLEARANCE({ paymentId, amountPaise: payment.amountPaise, studentsPaid: payment.studentsPaid, clearedOn, reasonCode }),
        actorUserId: actor.userId, correlationId,
      });
      return { payment: await this.payment(paymentId), approval: { id: approvalId, mode: consumed.mode }, correlationId };
    } catch (error) {
      throw failure(error, correlationId);
    }
  }

  @Post('/:paymentId/bounce')
  async bounce(@Req() request: ProtectedHttpRequest, @Param('paymentId') paymentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.transition(request, paymentId, body, 'BOUNCE');
  }

  @Post('/:paymentId/refund')
  async refund(@Req() request: ProtectedHttpRequest, @Param('paymentId') paymentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.transition(request, paymentId, body, 'REFUND');
  }

  @Post('/:paymentId/void')
  async voidPayment(@Req() request: ProtectedHttpRequest, @Param('paymentId') paymentId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.transition(request, paymentId, body, 'VOID');
  }

  private async transition(request: ProtectedHttpRequest, paymentIdParam: string, body: unknown, transition: 'BOUNCE' | 'REFUND' | 'VOID'): Promise<Record<string, unknown>> {
    const { correlationId, actor } = await this.require(request, canWrite);
    const paymentId = readUuid(paymentIdParam, 'INSTITUTION_PAYMENT_ID_INVALID', correlationId);
    const dated = transition !== 'VOID';
    const raw = readBody(body, dated ? ['on', 'reasonCode', 'note'] : ['reasonCode', 'note'], correlationId);
    const on = dated ? readDate(raw.on, correlationId) : null;
    const reasons = transition === 'BOUNCE' ? institutionPaymentBounceReasons : transition === 'REFUND' ? institutionPaymentRefundReasons : institutionPaymentVoidReasons;
    const reasonCode = readReason(raw.reasonCode, reasons, correlationId);
    const note = readNote(raw.note, correlationId);
    try {
      await transitionInstitutionPayment(this.db, { paymentId, transition, on, reasonCode, note, actorUserId: actor.userId, correlationId });
      return { payment: await this.payment(paymentId), correlationId };
    } catch (error) {
      throw failure(error, correlationId);
    }
  }

  private async payment(id: string): Promise<Record<string, unknown> | null> {
    const found = await loadInstitutionPayment(this.db, id);
    if (!found) return null;
    // The college is the page the operator is on; the row is returned without repeating its id.
    const view: Record<string, unknown> = { ...found };
    delete view.institutionId;
    return view;
  }

  private async require(request: ProtectedHttpRequest, allowed: (actor: Actor) => boolean): Promise<{ readonly correlationId: string; readonly actor: Actor }> {
    const context = requireTrustedAuthorization(request);
    const actor = await loadCallerCapabilityContext(context.authorization, dbCapabilityGrantLoader(this.db));
    if (!allowed(actor)) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
    return { correlationId: context.correlationId, actor };
  }
}

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'The request could not be completed.', correlationId } };
}

function invalid(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function readBody(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_REQUEST', correlationId);
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw invalid('INVALID_REQUEST', correlationId);
  return body as Record<string, unknown>;
}

function readUuid(value: unknown, code: string, correlationId: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw invalid(code, correlationId);
  return value.toLowerCase();
}

function readDate(value: unknown, correlationId: string): string {
  if (!isCalendarDate(value) || value < institutionPaymentEarliestDate) throw invalid('INSTITUTION_PAYMENT_DATE_INVALID', correlationId);
  return value;
}

function readReason(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid('REASON_CODE_INVALID', correlationId);
  return value;
}

function readNote(value: unknown, correlationId: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > institutionPaymentNoteLimit) throw invalid('NOTE_INVALID', correlationId);
  return value.trim() || null;
}

function failure(error: unknown, correlationId: string): HttpException {
  if (error instanceof HttpException) return error;
  const approval = approvalHttpError(error, correlationId);
  if (approval) return approval;
  if (error instanceof InstitutionPaymentError) {
    switch (error.code) {
      case 'COLLEGE_NOT_FOUND':
      case 'INSTITUTION_PAYMENT_NOT_FOUND':
        return new NotFoundException(domainError(error.code, correlationId));
      case 'INSTITUTION_PAYMENT_SELF_DEALING':
        return new ForbiddenException(domainError(error.code, correlationId));
      case 'INSTITUTION_PAYMENT_STATE_INVALID':
      case 'INSTITUTION_PAYMENT_DUPLICATE':
      case 'INSTITUTION_PAYMENT_REJECTED':
        return new ConflictException(domainError(error.code, correlationId));
      default:
        return invalid(error.code, correlationId);
    }
  }
  // Never forward database or driver text to the browser.
  return invalid('INSTITUTION_PAYMENT_REJECTED', correlationId);
}
