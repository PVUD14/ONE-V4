/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Trust & Safety: the review queue, cases, and enforcement.
 *
 * Restricted to the platform roles that may search the audit record. An employer's
 * right of reply (spec 38's AWAITING_RESPONSE) is a separate, narrower surface and is
 * deliberately not exposed here.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Pool } from 'pg';
import {
  TrustSafetyError,
  applyTrustCaseAction,
  getTrustCase,
  listPendingReviewSignals,
  listTrustCases,
  openTrustCase,
  transitionTrustCase,
  type TrustCaseState,
} from '@planthepath/persistence/src/trust-safety.js';
import { readTrustCaseMessageEvidence } from '@planthepath/persistence/src/application-messages.js';
import { PG_POOL } from '../persistence.provider.js';
import { ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';
import { callerHasInternalCapability, poolCapabilityGrantLoader } from './internal-capability-guard.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;
const caseTypes = ['EMPLOYER_ACCOUNTABILITY', 'OPPORTUNITY_MODERATION', 'USER_SAFETY', 'CONTENT'];
const subjectKinds = ['ORGANIZATION', 'USER', 'OPPORTUNITY_VERSION', 'CONTENT_REVISION'] as const;
const severities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const states = ['REPORTED', 'TRIAGED', 'AWAITING_RESPONSE', 'UNDER_INVESTIGATION', 'DECIDED', 'ACTIONED', 'CLOSED', 'DISMISSED', 'APPEALED', 'REOPENED'];
const actions = ['WARNING', 'ENHANCED_MODERATION', 'POSTING_RESTRICTION', 'TRUST_DOWNGRADE', 'TEMPORARY_SUSPENSION', 'PERMANENT_REMOVAL'];

@Controller('/api/v1/operations/trust-safety')
export class TrustSafetyController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('/cases')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async cases(@Req() request: ProtectedHttpRequest, @Query('includeClosed') includeClosed?: string): Promise<Record<string, unknown>> {
    await requireTrustOperator(request, this.pool, 'TRUST_SAFETY_INVESTIGATE');
    return {
      cases: await listTrustCases(this.pool, { includeClosed: includeClosed === 'true' }),
      // The detector queue sits alongside the case queue, because a signal is the most
      // common reason a case gets opened and they were never visible together before.
      pendingSignals: await listPendingReviewSignals(this.pool),
    };
  }

  @Get('/cases/:caseId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('caseId') caseId: string): Promise<Record<string, unknown>> {
    await requireTrustOperator(request, this.pool, 'TRUST_SAFETY_INVESTIGATE');
    const found = await getTrustCase(this.pool, requireUuid(caseId));
    if (!found) throw new NotFoundException({ error: { code: 'TRUST_CASE_NOT_FOUND' } });
    return { case: found };
  }

  /**
   * EMP-10: the application conversations that are evidence on this case, for judging a student's
   * report. Only threads the case references; audited. Operators see the text regardless of the
   * employer's grant, because deciding the report needs it.
   */
  @Get('/cases/:caseId/message-threads')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async messageEvidence(@Req() request: ProtectedHttpRequest, @Param('caseId') caseId: string): Promise<Record<string, unknown>> {
    const actorUserId = await requireTrustOperator(request, this.pool, 'TRUST_SAFETY_INVESTIGATE');
    const threads = await readTrustCaseMessageEvidence(this.pool, {
      caseId: requireUuid(caseId), actorUserId, correlationId: request.planThePath?.correlationId ?? 'unknown',
    });
    if (!threads) throw new NotFoundException({ error: { code: 'TRUST_CASE_NOT_FOUND' } });
    return { threads };
  }

  @Post('/cases')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async open(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const actorUserId = await requireTrustOperator(request, this.pool, 'TRUST_SAFETY_INVESTIGATE');
    const raw = readObject(body);
    if (typeof raw.caseType !== 'string' || !caseTypes.includes(raw.caseType)) throw badRequest('TRUST_CASE_TYPE_INVALID');
    const subjectKind = raw.subjectKind;
    if (typeof subjectKind !== 'string' || !subjectKinds.includes(subjectKind as typeof subjectKinds[number])) {
      throw badRequest('TRUST_CASE_SUBJECT_INVALID');
    }
    if (typeof raw.subjectId !== 'string' || !uuidPattern.test(raw.subjectId)) throw badRequest('TRUST_CASE_SUBJECT_INVALID');
    const severity = raw.severity === undefined ? 'MEDIUM' : raw.severity;
    if (typeof severity !== 'string' || !severities.includes(severity)) throw badRequest('TRUST_CASE_SEVERITY_INVALID');
    const signalIds = Array.isArray(raw.signalIds) ? raw.signalIds.filter((value): value is string => typeof value === 'string' && uuidPattern.test(value)) : [];
    const statement = typeof raw.statement === 'string' && raw.statement.trim() ? raw.statement.slice(0, 4000) : null;

    try {
      const created = await openTrustCase(this.pool, {
        caseType: raw.caseType,
        subjectKind: subjectKind as typeof subjectKinds[number],
        subjectId: raw.subjectId,
        organizationId: typeof raw.organizationId === 'string' && uuidPattern.test(raw.organizationId) ? raw.organizationId : null,
        reportedByUserId: typeof raw.reportedByUserId === 'string' && uuidPattern.test(raw.reportedByUserId) ? raw.reportedByUserId : null,
        severity: severity as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
        statement,
        signalIds,
        openedByUserId: actorUserId,
        correlationId: request.planThePath?.correlationId ?? 'unknown',
      });
      return { ...created, cases: await listTrustCases(this.pool, {}) };
    } catch (error) {
      throw mapTrustError(error);
    }
  }

  @Post('/cases/:caseId/transition')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async transition(
    @Req() request: ProtectedHttpRequest,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const actorUserId = await requireTrustOperator(request, this.pool, 'TRUST_SAFETY_INVESTIGATE');
    const raw = readObject(body);
    if (typeof raw.toState !== 'string' || !states.includes(raw.toState)) throw badRequest('TRUST_CASE_STATE_INVALID');
    if (typeof raw.reasonCode !== 'string' || !reasonCodePattern.test(raw.reasonCode)) throw badRequest('REASON_CODE_REQUIRED');
    try {
      await transitionTrustCase(this.pool, {
        caseId: requireUuid(caseId),
        toState: raw.toState as TrustCaseState,
        actorUserId,
        reasonCode: raw.reasonCode,
        note: typeof raw.note === 'string' ? raw.note.slice(0, 2000) : null,
        correlationId: request.planThePath?.correlationId ?? 'unknown',
      });
    } catch (error) {
      throw mapTrustError(error);
    }
    return { case: await getTrustCase(this.pool, caseId) };
  }

  @Post('/cases/:caseId/actions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async act(
    @Req() request: ProtectedHttpRequest,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const actorUserId = await requireTrustOperator(request, this.pool, 'TRUST_SAFETY_ENFORCE');
    const raw = readObject(body);
    if (typeof raw.action !== 'string' || !actions.includes(raw.action)) throw badRequest('TRUST_ACTION_INVALID');
    const effectiveTo = typeof raw.effectiveTo === 'string' && !Number.isNaN(Date.parse(raw.effectiveTo)) ? raw.effectiveTo : null;
    try {
      await applyTrustCaseAction(this.pool, {
        caseId: requireUuid(caseId),
        action: raw.action,
        appliedByUserId: actorUserId,
        effectiveTo,
        correlationId: request.planThePath?.correlationId ?? 'unknown',
      });
    } catch (error) {
      throw mapTrustError(error);
    }
    return { case: await getTrustCase(this.pool, caseId) };
  }
}

/**
 * TRUST_SAFETY_INVESTIGATE for the queue and case workflow, TRUST_SAFETY_ENFORCE for
 * enforcement actions (OPS-01). Both are baseline for the three platform roles — the
 * set that could search the audit record before.
 */
async function requireTrustOperator(
  request: ProtectedHttpRequest,
  pool: Pool,
  capability: 'TRUST_SAFETY_INVESTIGATE' | 'TRUST_SAFETY_ENFORCE',
): Promise<string> {
  const authorization = request.planThePath?.authorization;
  const userId = authorization?.principal.userId;
  const permitted = await callerHasInternalCapability(authorization, poolCapabilityGrantLoader(pool), capability);
  if (!userId || !permitted) throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
  return userId;
}

function readObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST');
  return body as Record<string, unknown>;
}

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw badRequest('INVALID_REQUEST');
  return value;
}

function mapTrustError(error: unknown): BadRequestException | NotFoundException {
  if (error instanceof TrustSafetyError) {
    if (error.code === 'TRUST_CASE_NOT_FOUND') return new NotFoundException({ error: { code: error.code } });
    return new BadRequestException({ error: { code: error.code } });
  }
  return badRequest('INVALID_REQUEST');
}

function badRequest(code: string): BadRequestException {
  return new BadRequestException({ error: { code } });
}
