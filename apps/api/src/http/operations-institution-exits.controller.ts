/**
 * Operations' side of a college's contract (INST-18): publishing the data-processing terms, and the
 * exit runbook — notice, end, cancel, the purge preview (the dry run) and the dual-controlled purge.
 *
 * Design: docs/architecture/institution-contract-lifecycle-design.md.
 *
 * Everything needs OPS_ORG_MANAGE, the organisation family that onboards and verifies colleges. Notice,
 * end and cancel are single-operator, reason-coded and audited: ending is fully reversible for the
 * 90-day retention period. The purge is the one destructive step; it needs an INSTITUTION_DATA_PURGE
 * approval from a second person (OPS-02), filed through the ordinary approvals queue and consumed here
 * in the purge's own transaction, and it is refused until the retention period has passed on the
 * database clock and while any of the college's students is under a legal hold.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  institutionDataPurgeReasons,
  institutionOffboardingReasons,
  institutionOffboardingRetentionDays,
} from '@planthepath/authorization/src/index.js';
import {
  InstitutionContractError,
  cancelInstitutionOffboarding,
  endInstitutionOffboarding,
  institutionDataTermsLegalReviewStates,
  listInstitutionDataTermsVersions,
  listInstitutionOffboardings,
  previewInstitutionPurge,
  publishInstitutionDataTermsVersion,
  purgeInstitutionRecords,
  readInstitutionOffboarding,
  recordInstitutionOffboardingNotice,
  type InstitutionDataTermsLegalReviewState,
} from '@planthepath/persistence/src/institution-contract.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { PG_POOL } from '../persistence.provider.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, type ProtectedHttpRequest } from './api-security.js';
import { callerHasInternalCapability, dbCapabilityGrantLoader } from './internal-capability-guard.js';
import { approvalHttpError, approvalPayloads, approvalRequired, readApprovalId } from './operation-approval-gate.js';

type Context = ReturnType<typeof requireTrustedAuthorization>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const reasonPattern = /^[A-Z0-9_:-]{3,64}$/;
const publishKeys = ['version', 'title', 'body', 'legalReviewState', 'legalReviewReference', 'requiresReacceptance', 'changeSummary', 'reasonCode'];

@Controller('/api/v1/operations')
@UseGuards(ProtectedApiAuthenticationGuard)
export class OperationsInstitutionExitsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  // --- Terms ---------------------------------------------------------------

  @Get('/institution-data-terms')
  async listTerms(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    return { versions: await listInstitutionDataTermsVersions(this.db), correlationId: context.correlationId };
  }

  @Post('/institution-data-terms')
  async publishTerms(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    const { correlationId } = context;
    const raw = readBody(body, publishKeys, correlationId);
    if (typeof raw.version !== 'string' || !versionPattern.test(raw.version)) throw invalid('INSTITUTION_DATA_TERMS_VERSION_INVALID', correlationId);
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title || title.length > 200) throw invalid('INSTITUTION_DATA_TERMS_TITLE_INVALID', correlationId);
    const text = typeof raw.body === 'string' ? raw.body.trim() : '';
    if (!text || text.length > 60_000) throw invalid('INSTITUTION_DATA_TERMS_BODY_INVALID', correlationId);
    if (typeof raw.legalReviewState !== 'string' || !(institutionDataTermsLegalReviewStates as readonly string[]).includes(raw.legalReviewState)) {
      throw invalid('INSTITUTION_DATA_TERMS_LEGAL_STATE_INVALID', correlationId);
    }
    const legalReviewState = raw.legalReviewState as InstitutionDataTermsLegalReviewState;
    const reference = typeof raw.legalReviewReference === 'string' ? raw.legalReviewReference.trim() : '';
    if (legalReviewState === 'LEGAL_APPROVED' && (reference.length < 3 || reference.length > 200)) throw invalid('INSTITUTION_DATA_TERMS_LEGAL_REFERENCE_REQUIRED', correlationId);
    if (legalReviewState === 'DRAFT_FOR_LEGAL_REVIEW' && raw.legalReviewReference !== undefined && raw.legalReviewReference !== null) {
      throw invalid('INSTITUTION_DATA_TERMS_LEGAL_REFERENCE_NOT_ALLOWED', correlationId);
    }
    if (typeof raw.requiresReacceptance !== 'boolean') throw invalid('INSTITUTION_DATA_TERMS_MATERIALITY_REQUIRED', correlationId);
    const changeSummary = typeof raw.changeSummary === 'string' && raw.changeSummary.trim() ? raw.changeSummary.trim() : null;
    if (changeSummary && changeSummary.length > 2000) throw invalid('INSTITUTION_DATA_TERMS_CHANGE_SUMMARY_INVALID', correlationId);
    if (typeof raw.reasonCode !== 'string' || !reasonPattern.test(raw.reasonCode)) throw invalid('REASON_CODE_REQUIRED', correlationId);
    try {
      const version = await publishInstitutionDataTermsVersion(this.db, {
        version: raw.version, title, body: text, legalReviewState, legalReviewReference: legalReviewState === 'LEGAL_APPROVED' ? reference : null,
        requiresReacceptance: raw.requiresReacceptance, changeSummary, reasonCode: raw.reasonCode,
        actorUserId: context.authorization.principal.userId, correlationId,
      });
      return { version, correlationId };
    } catch (error) {
      if (error instanceof InstitutionContractError && error.code === 'INSTITUTION_DATA_TERMS_VERSION_EXISTS') throw new ConflictException(domainError(error.code, correlationId));
      if (error instanceof InstitutionContractError) throw invalid(error.code, correlationId);
      throw invalid('INSTITUTION_DATA_TERMS_INVALID', correlationId);
    }
  }

  // --- Exits ---------------------------------------------------------------

  @Get('/institution-offboardings')
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    return {
      offboardings: await listInstitutionOffboardings(this.db),
      policy: { retentionDays: institutionOffboardingRetentionDays, reasons: institutionOffboardingReasons, purgeReasons: institutionDataPurgeReasons },
      correlationId: context.correlationId,
    };
  }

  /** Step 1: record that the college's agreement is ending. The owner can then take the exit export. */
  @Post('/institution-offboardings')
  async notice(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    const { correlationId } = context;
    const raw = readBody(body, ['institutionId', 'reasonCode'], correlationId);
    if (typeof raw.institutionId !== 'string' || !uuidPattern.test(raw.institutionId)) throw invalid('INSTITUTION_ID_INVALID', correlationId);
    const reasonCode = requireReason(raw.reasonCode, institutionOffboardingReasons.NOTICE, correlationId);
    try {
      const offboarding = await recordInstitutionOffboardingNotice(this.db, {
        institutionId: raw.institutionId.toLowerCase(), reasonCode, actorUserId: context.authorization.principal.userId, correlationId,
      });
      return { offboarding, correlationId };
    } catch (error) {
      throw stepFailure(error, correlationId);
    }
  }

  /** Step 2: end the college's use of ONE (reversible until the retention period ends). */
  @Post('/institution-offboardings/:offboardingId/end')
  async end(@Req() request: ProtectedHttpRequest, @Param('offboardingId') offboardingId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    const { correlationId } = context;
    const id = requireId(offboardingId, correlationId);
    const raw = readBody(body, ['reasonCode'], correlationId);
    const reasonCode = requireReason(raw.reasonCode, institutionOffboardingReasons.END, correlationId);
    try {
      return { offboarding: await endInstitutionOffboarding(this.db, { offboardingId: id, reasonCode, actorUserId: context.authorization.principal.userId, correlationId }), correlationId };
    } catch (error) {
      throw stepFailure(error, correlationId);
    }
  }

  /** Step 3: cancel — from the notice, or from the end while the retention period runs. */
  @Post('/institution-offboardings/:offboardingId/cancel')
  async cancel(@Req() request: ProtectedHttpRequest, @Param('offboardingId') offboardingId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    const { correlationId } = context;
    const id = requireId(offboardingId, correlationId);
    const raw = readBody(body, ['reasonCode'], correlationId);
    const reasonCode = requireReason(raw.reasonCode, institutionOffboardingReasons.CANCEL, correlationId);
    try {
      return { offboarding: await cancelInstitutionOffboarding(this.db, { offboardingId: id, reasonCode, actorUserId: context.authorization.principal.userId, correlationId }), correlationId };
    } catch (error) {
      throw stepFailure(error, correlationId);
    }
  }

  /** The runbook's dry run: what the purge would delete and keep, per table. Deletes nothing. */
  @Get('/institution-offboardings/:offboardingId/purge-preview')
  async preview(@Req() request: ProtectedHttpRequest, @Param('offboardingId') offboardingId: string): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    const { correlationId } = context;
    const offboarding = await readInstitutionOffboarding(this.db, requireId(offboardingId, correlationId));
    if (!offboarding) throw new NotFoundException(domainError('OFFBOARDING_NOT_FOUND', correlationId));
    return { offboarding, preview: await previewInstitutionPurge(this.pool, offboarding.institutionId), correlationId };
  }

  /** Step 4: delete the college's institution-owned records. Without a valid approval: 403 APPROVAL_REQUIRED. */
  @Post('/institution-offboardings/:offboardingId/purge')
  async purge(@Req() request: ProtectedHttpRequest, @Param('offboardingId') offboardingId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    const { correlationId } = context;
    const id = requireId(offboardingId, correlationId);
    const raw = readBody(body, ['reasonCode', 'approvalId'], correlationId);
    const reasonCode = requireReason(raw.reasonCode, institutionDataPurgeReasons, correlationId);
    const approvalId = readApprovalId(body, correlationId);
    if (!approvalId) throw approvalRequired(correlationId);
    const client = await this.pool.connect();
    try {
      const result = await purgeInstitutionRecords(client, {
        offboardingId: id, approvalId, approvalPayload: approvalPayloads.INSTITUTION_DATA_PURGE({ offboardingId: id, reasonCode }),
        reasonCode, actorUserId: context.authorization.principal.userId, correlationId,
      });
      return { offboarding: await readInstitutionOffboarding(this.db, id), deleted: result.summary, approval: { id: approvalId, mode: result.mode }, correlationId };
    } catch (error) {
      throw stepFailure(error, correlationId);
    } finally {
      client.release();
    }
  }

  private async requireOperator(request: ProtectedHttpRequest): Promise<Context> {
    const context = requireTrustedAuthorization(request);
    if (!await callerHasInternalCapability(context.authorization, dbCapabilityGrantLoader(this.db), 'OPS_ORG_MANAGE')) {
      throw new ForbiddenException(domainError('FORBIDDEN', context.correlationId));
    }
    return context;
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

function requireId(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw invalid('OFFBOARDING_ID_INVALID', correlationId);
  return value.toLowerCase();
}

function requireReason(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid('REASON_CODE_INVALID', correlationId);
  return value;
}

const conflictCodes = new Set([
  'OFFBOARDING_ALREADY_OPEN', 'OFFBOARDING_NOT_IN_NOTICE', 'OFFBOARDING_NOT_OPEN', 'OFFBOARDING_RETENTION_ENDED',
  'OFFBOARDING_NOT_ENDED', 'OFFBOARDING_RETENTION_RUNNING', 'OFFBOARDING_PURGE_HELD',
]);

function stepFailure(error: unknown, correlationId: string): HttpException {
  const approval = approvalHttpError(error, correlationId);
  if (approval) return approval;
  if (error instanceof InstitutionContractError) {
    if (error.code === 'OFFBOARDING_NOT_FOUND' || error.code === 'INSTITUTION_NOT_FOUND') return new NotFoundException(domainError(error.code, correlationId));
    if (conflictCodes.has(error.code)) return new ConflictException(domainError(error.code, correlationId));
    return invalid(error.code, correlationId);
  }
  return new HttpException(domainError('REQUEST_FAILED', correlationId), 500);
}
