/**
 * System Health: the background jobs console's read endpoints (OPS-04).
 *
 * One summary endpoint computes every dashboard number server-side in bounded SQL, so
 * the browser never counts a list. There is a keyset-paginated list of failed events, a
 * detail view per event, and a preview of what a backlog supersede would retire. Replay
 * and supersede themselves stay on the existing outbox endpoints: replay is audited,
 * and supersede needs an OPS-02 approval.
 *
 * Every route needs OPS_JOBS_REPLAY. Reads share the module's write capability (OPS-01
 * D4). No event payload, stored failure message, recipient or lease owner is returned.
 */
import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { approvalRequestReasons, outboxReplayReasons } from '@planthepath/authorization/src/index.js';
import {
  countSupersedableBacklog,
  decodeFailedJobsCursor,
  getFailedJobDetail,
  listFailedJobs,
  readJobsAlertConfig,
  readJobsHealthSummary,
} from '@planthepath/persistence/src/jobs-health.js';
import { loadCalibrationHealth, sandboxHealth } from '@planthepath/persistence/src/engine-health.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { API_PERSISTENCE_DB, ProtectedApiAuthenticationGuard, type ProtectedHttpRequest } from './api-security.js';
import { requireJobsOperator } from './operations-outbox.controller.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const eventTypePattern = /^[a-z][a-z0-9._-]{0,99}$/;
const failedQueryKeys = new Set(['eventType', 'from', 'to', 'cursor', 'limit']);
/** The supersede endpoint's own default and ceiling (operations-outbox.controller.ts). */
const supersedeDefaultLimit = 10_000;

function domainError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly correlationId: string } } {
  return { error: { code, correlationId } };
}
function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(domainError(code, correlationId));
}

function optionalTimestamp(value: unknown, code: string, correlationId: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) throw badRequest(code, correlationId);
  return new Date(value).toISOString();
}

@Controller('/api/v1/operations/jobs')
export class OperationsJobsController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/summary')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async summary(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = await requireJobsOperator(request, this.db);
    const summary = await readJobsHealthSummary(this.db, readJobsAlertConfig(process.env));
    return {
      summary,
      reasons: { replay: outboxReplayReasons, supersede: approvalRequestReasons.OUTBOX_BACKLOG_SUPERSEDE },
      correlationId: context.correlationId,
    };
  }

  /**
   * OPS-13: whether the adaptive engine's jobs and infrastructure run — the last calibration run and
   * its status (item_calibration_runs, item_calibrations) and the code sandbox, which has no source
   * until ENG-12 is built and so reports NA. Design: docs/architecture/engine-health-panels-design.md
   */
  @Get('/engine-health')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async engineHealth(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = await requireJobsOperator(request, this.db);
    if (Object.keys(query).length) throw badRequest('JOBS_FILTER_UNKNOWN', context.correlationId);
    return { calibration: await loadCalibrationHealth(this.db), sandbox: sandboxHealth(), correlationId: context.correlationId };
  }

  @Get('/failed')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async failed(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = await requireJobsOperator(request, this.db);
    const correlationId = context.correlationId;
    for (const key of Object.keys(query)) if (!failedQueryKeys.has(key)) throw badRequest('JOBS_FILTER_UNKNOWN', correlationId);
    const eventType = query.eventType;
    if (eventType !== undefined && eventType !== '' && (typeof eventType !== 'string' || !eventTypePattern.test(eventType))) {
      throw badRequest('JOBS_EVENT_TYPE_INVALID', correlationId);
    }
    const from = optionalTimestamp(query.from, 'JOBS_FROM_INVALID', correlationId);
    const to = optionalTimestamp(query.to, 'JOBS_TO_INVALID', correlationId);
    const limit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badRequest('JOBS_LIMIT_INVALID', correlationId);
    let cursor: { readonly occurredAt: string; readonly id: string } | undefined;
    if (query.cursor !== undefined && query.cursor !== '') {
      const decoded = typeof query.cursor === 'string' && query.cursor.length <= 256 ? decodeFailedJobsCursor(query.cursor) : null;
      if (!decoded) throw badRequest('JOBS_CURSOR_INVALID', correlationId);
      cursor = decoded;
    }
    const page = await listFailedJobs(this.db, {
      limit,
      ...(typeof eventType === 'string' && eventType ? { eventType } : {}),
      ...(from ? { occurredFrom: from } : {}),
      ...(to ? { occurredTo: to } : {}),
      ...(cursor ? { cursor } : {}),
    });
    return { ...page, correlationId };
  }

  @Get('/failed/:eventId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async detail(@Req() request: ProtectedHttpRequest, @Param('eventId') eventId: string): Promise<Record<string, unknown>> {
    const context = await requireJobsOperator(request, this.db);
    if (!uuidPattern.test(eventId)) throw badRequest('JOBS_EVENT_INVALID', context.correlationId);
    const event = await getFailedJobDetail(this.db, eventId);
    if (!event) throw new NotFoundException(domainError('JOBS_EVENT_NOT_FOUND', context.correlationId));
    return { event, correlationId: context.correlationId };
  }

  /** What a supersede with this cutoff would retire: filed with the approval request. */
  @Get('/backlog')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async backlog(@Req() request: ProtectedHttpRequest, @Query('olderThan') olderThan?: string): Promise<Record<string, unknown>> {
    const context = await requireJobsOperator(request, this.db);
    const cutoff = optionalTimestamp(olderThan, 'OUTBOX_CUTOFF_INVALID', context.correlationId);
    if (!cutoff) throw badRequest('OUTBOX_CUTOFF_INVALID', context.correlationId);
    const pending = await countSupersedableBacklog(this.db, new Date(cutoff));
    return { olderThan: cutoff, pending, limit: supersedeDefaultLimit, correlationId: context.correlationId };
  }
}
