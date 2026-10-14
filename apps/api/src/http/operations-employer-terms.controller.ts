/**
 * Operations publish employer terms versions (EMP-16).
 *
 * Design: docs/architecture/employer-terms-and-trust-participation-design.md, Decision 1.
 *
 * Publishing a version that every employer must accept before its next publish is a deliberate
 * operator act against a reviewed text, so it is a route rather than a seed. The capability is
 * OPS_ORG_MANAGE (the organisation family that verifies employers); every publish is audited with a
 * reason code and an outbox event, in one transaction. A version is immutable once published.
 *
 * The legal-review state travels with the text. DRAFT_FOR_LEGAL_REVIEW is shown to employers as a
 * draft everywhere; LEGAL_APPROVED needs a reference saying whose approval it is, so an approval
 * cannot be claimed without one.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  EmployerTermsError,
  employerTermsLegalReviewStates,
  listEmployerTermsVersions,
  publishEmployerTermsVersion,
  type EmployerTermsLegalReviewState,
} from '@planthepath/persistence/src/employer-terms.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, requireTrustedAuthorization, type ProtectedHttpRequest } from './api-security.js';
import { callerHasInternalCapability, dbCapabilityGrantLoader } from './internal-capability-guard.js';

const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const reasonPattern = /^[A-Z0-9_:-]{3,64}$/;
const publishKeys = ['version', 'title', 'body', 'legalReviewState', 'legalReviewReference', 'requiresReacceptance', 'changeSummary', 'reasonCode'];

@Controller('/api/v1/operations/employer-terms')
@UseGuards(ProtectedApiAuthenticationGuard)
export class OperationsEmployerTermsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get()
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    return { versions: await listEmployerTermsVersions(this.db), correlationId: context.correlationId };
  }

  @Post()
  async publish(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await this.requireOperator(request);
    const { correlationId } = context;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_REQUEST', correlationId);
    const raw = body as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !publishKeys.includes(key))) throw invalid('INVALID_REQUEST', correlationId);
    if (typeof raw.version !== 'string' || !versionPattern.test(raw.version)) throw invalid('EMPLOYER_TERMS_VERSION_INVALID', correlationId);
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title || title.length > 200) throw invalid('EMPLOYER_TERMS_TITLE_INVALID', correlationId);
    const text = typeof raw.body === 'string' ? raw.body.trim() : '';
    if (!text || text.length > 60_000) throw invalid('EMPLOYER_TERMS_BODY_INVALID', correlationId);
    if (typeof raw.legalReviewState !== 'string' || !(employerTermsLegalReviewStates as readonly string[]).includes(raw.legalReviewState)) {
      throw invalid('EMPLOYER_TERMS_LEGAL_STATE_INVALID', correlationId);
    }
    const legalReviewState = raw.legalReviewState as EmployerTermsLegalReviewState;
    const reference = typeof raw.legalReviewReference === 'string' ? raw.legalReviewReference.trim() : '';
    if (legalReviewState === 'LEGAL_APPROVED' && (reference.length < 3 || reference.length > 200)) throw invalid('EMPLOYER_TERMS_LEGAL_REFERENCE_REQUIRED', correlationId);
    if (legalReviewState === 'DRAFT_FOR_LEGAL_REVIEW' && raw.legalReviewReference !== undefined && raw.legalReviewReference !== null) {
      throw invalid('EMPLOYER_TERMS_LEGAL_REFERENCE_NOT_ALLOWED', correlationId);
    }
    if (typeof raw.requiresReacceptance !== 'boolean') throw invalid('EMPLOYER_TERMS_MATERIALITY_REQUIRED', correlationId);
    const changeSummary = typeof raw.changeSummary === 'string' && raw.changeSummary.trim() ? raw.changeSummary.trim() : null;
    if (changeSummary && changeSummary.length > 2000) throw invalid('EMPLOYER_TERMS_CHANGE_SUMMARY_INVALID', correlationId);
    if (typeof raw.reasonCode !== 'string' || !reasonPattern.test(raw.reasonCode)) throw invalid('REASON_CODE_REQUIRED', correlationId);

    try {
      const version = await publishEmployerTermsVersion(this.db, {
        version: raw.version, title, body: text, legalReviewState,
        legalReviewReference: legalReviewState === 'LEGAL_APPROVED' ? reference : null,
        requiresReacceptance: raw.requiresReacceptance, changeSummary, reasonCode: raw.reasonCode,
        actorUserId: context.authorization.principal.userId, correlationId,
      });
      return { version, correlationId };
    } catch (error) {
      if (error instanceof EmployerTermsError && error.code === 'EMPLOYER_TERMS_VERSION_EXISTS') throw new ConflictException(domainError(error.code, correlationId));
      if (error instanceof EmployerTermsError) throw invalid(error.code, correlationId);
      throw invalid('EMPLOYER_TERMS_INVALID', correlationId);
    }
  }

  private async requireOperator(request: ProtectedHttpRequest): Promise<ReturnType<typeof requireTrustedAuthorization>> {
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
