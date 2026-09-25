/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * The operator surface for the outbox dead letter.
 *
 * ADR-028 removes the broker, which means there is no SQS dead-letter queue and no
 * redrive console. The terminal FAILED state in `outbox_events` is the dead letter and
 * `replayOutboxEvent` is the redrive — both already implemented, neither previously
 * reachable by a person. This exposes them.
 *
 * Both mutations are high-risk operations under platform control 103: they require a
 * reason code, they are audited by the persistence functions themselves, and they are
 * restricted to the same platform roles that may search the audit record. Superseding
 * the backlog also needs a second person's approval (OPS-02).
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
import { randomUUID } from 'node:crypto';
import { listFailedOutboxEvents, replayOutboxEvent, supersedeOutboxBacklog } from '@planthepath/persistence/src/outbox-dispatcher.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ProtectedHttpRequest,
} from './api-security.js';
import { callerHasInternalCapability, dbCapabilityGrantLoader } from './internal-capability-guard.js';
import { consumeOperationApproval } from '@planthepath/persistence/src/operation-approvals.js';
import { approvalHttpError, approvalPayloads, approvalRequired, readApprovalId } from './operation-approval-gate.js';
import { isOutboxReplayReason } from '@planthepath/authorization/src/index.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;

@Controller('/api/v1/operations')
export class OperationsOutboxController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/outbox/failed')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async failed(@Req() request: ProtectedHttpRequest, @Query('limit') limit?: string): Promise<Record<string, unknown>> {
    const context = await requireJobsOperator(request, this.db);
    const parsed = limit === undefined || limit === '' ? 50 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      throw badRequest('OUTBOX_LIMIT_INVALID', context.correlationId);
    }
    return { events: await listFailedOutboxEvents(this.db, { limit: parsed }), correlationId: context.correlationId };
  }

  @Post('/outbox/:eventId/replay')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async replay(
    @Req() request: ProtectedHttpRequest,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const context = await requireJobsOperator(request, this.db);
    if (!uuidPattern.test(eventId)) throw badRequest('OUTBOX_EVENT_INVALID', context.correlationId);
    const { reasonCode, ticketReference } = readReason(body, context.correlationId);
    // OPS-04 (§5.3): a replay's reason comes from the fixed list the console offers.
    if (!isOutboxReplayReason(reasonCode)) throw badRequest('OUTBOX_REASON_INVALID', context.correlationId);

    const replayed = await replayOutboxEvent(this.db, {
      eventId,
      actorUserId: context.authorization.principal.userId,
      reasonCode,
      ...(ticketReference ? { ticketReference } : {}),
      auditId: randomUUID(),
      now: new Date(),
    });
    // Not found rather than a conflict: an event that is not FAILED is not replayable,
    // and distinguishing "already published" from "does not exist" tells an unauthorized
    // caller more than it tells an authorized one.
    if (!replayed) throw new NotFoundException(domainError('OUTBOX_EVENT_NOT_REPLAYABLE', context.correlationId));
    return { replayed: true, correlationId: context.correlationId };
  }

  /**
   * Retire the pre-dispatcher backlog.
   *
   * Intended to be used once, deliberately, before the worker is first deployed. The
   * cutoff is explicit rather than derived, because "everything older than the moment
   * I happened to run this" is not a decision anyone can review afterwards.
   */
  @Post('/outbox/backlog/supersede')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async supersedeBacklog(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await requireJobsOperator(request, this.db);
    const { reasonCode } = readReason(body, context.correlationId);
    const raw = (body ?? {}) as Record<string, unknown>;
    if (typeof raw.olderThan !== 'string' || Number.isNaN(Date.parse(raw.olderThan))) {
      throw badRequest('OUTBOX_CUTOFF_INVALID', context.correlationId);
    }
    const limit = raw.limit === undefined ? 10_000 : Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
      throw badRequest('OUTBOX_LIMIT_INVALID', context.correlationId);
    }

    // OPS-02: always dual-controlled. The approval is bound to this cutoff, limit and
    // reason, and consumed in the same transaction as the supersede (a nested
    // transaction there is a savepoint, so both commit or neither does).
    const approvalId = readApprovalId(body, context.correlationId);
    if (!approvalId) throw approvalRequired(context.correlationId);
    const olderThan = new Date(raw.olderThan);
    const actorUserId = context.authorization.principal.userId;
    try {
      const superseded = await this.db.transaction(async (tx) => {
        await consumeOperationApproval(tx, {
          approvalId, actionKey: 'OUTBOX_BACKLOG_SUPERSEDE',
          payload: approvalPayloads.OUTBOX_BACKLOG_SUPERSEDE({ olderThan, limit, reasonCode }),
          executorUserId: actorUserId, correlationId: context.correlationId,
        });
        return supersedeOutboxBacklog(tx, {
          olderThan, actorUserId, reasonCode, auditId: randomUUID(), correlationId: context.correlationId, limit, now: new Date(),
        });
      });
      return { superseded, correlationId: context.correlationId };
    } catch (error) {
      throw approvalHttpError(error, context.correlationId) ?? error;
    }
  }
}

/**
 * OPS_JOBS_REPLAY (OPS-01): baseline for the three platform roles, exactly the set that
 * could search the audit record before. Replaying an event causes a real-world effect
 * and superseding a backlog suppresses many, so neither belongs to an ordinary support
 * role.
 */
export async function requireJobsOperator(request: ProtectedHttpRequest, db: PersistenceDb): Promise<ReturnType<typeof requireTrustedAuthorization>> {
  const context = requireTrustedAuthorization(request);
  const permitted = await callerHasInternalCapability(context.authorization, dbCapabilityGrantLoader(db), 'OPS_JOBS_REPLAY');
  if (!permitted) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
  return context;
}

/** safeError types only the authentication codes; these are domain codes. */
function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly correlationId: string } } {
  return { error: { code, correlationId } };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function readReason(body: unknown, correlationId: string): { readonly reasonCode: string; readonly ticketReference?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('OUTBOX_REASON_REQUIRED', correlationId);
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.reasonCode !== 'string' || !reasonCodePattern.test(raw.reasonCode)) {
    throw badRequest('OUTBOX_REASON_REQUIRED', correlationId);
  }
  const ticketReference = raw.ticketReference;
  if (ticketReference !== undefined && (typeof ticketReference !== 'string' || !/^[A-Za-z0-9._:/#-]{1,128}$/.test(ticketReference))) {
    throw badRequest('OUTBOX_TICKET_INVALID', correlationId);
  }
  return { reasonCode: raw.reasonCode, ...(typeof ticketReference === 'string' ? { ticketReference } : {}) };
}
