/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * The operations side of privacy: the request queue, and legal holds.
 *
 * Both mechanisms already existed and neither was reachable. `privacy_requests` has a
 * seven-state machine and a deployed deletion sweep; no endpoint let staff see it.
 * `data_retention_holds` is honoured by that sweep and carries the reason codes a
 * Trust & Safety case will use — but placing one required direct database access,
 * which means a legal obligation was met by someone with a psql prompt.
 *
 * Holds are placed and released, never deleted, and both acts are audited. The reason
 * code is bounded by the schema to the five lawful bases, so "why is this person's
 * erasure suspended" always has an answer.
 *
 * OPS-06 gives it a screen (Security → Privacy and consent): the queue is paginated and
 * minimised (masked subject, no typed reason), each request's detail and state history
 * is readable and its read audited as `operations.privacy_request.viewed`, holds show
 * the release request in flight, and consent coverage reports per live definition with
 * counts under 5 suppressed. Reads are in packages/persistence/src/privacy-operations.ts.
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
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ProtectedHttpRequest,
} from './api-security.js';
import { callerHasInternalCapability, dbCapabilityGrantLoader } from './internal-capability-guard.js';
import { OperationApprovalError, consumeOperationApproval } from '@planthepath/persistence/src/operation-approvals.js';
import {
  decodePrivacyRequestCursor,
  encodePrivacyRequestCursor,
  listActiveRetentionHolds,
  listPrivacyRequests,
  loadPrivacyRequestDetail,
  privacyRequestTypes,
  privacyRequestViews,
  readConsentCoverage,
  recordPrivacyRequestViewed,
  retentionHoldSubjectState,
  summarisePrivacyQueue,
  type PrivacyOperationsRequestType,
  type PrivacyRequestRow,
  type PrivacyRequestView,
} from '@planthepath/persistence/src/privacy-operations.js';
import {
  aggregateSuppressionThreshold,
  approvalRequestReasons,
  isPrivacyHoldPlaceReason,
  privacyHoldPlaceReasons,
} from '@planthepath/authorization/src/index.js';
import { DELETION_GRACE_PERIOD_DAYS, STATUTORY_RESPONSE_PERIOD_DAYS, statutoryResponseDueAt } from '@planthepath/privacy';
import { approvalHttpError, approvalPayloads, readApprovalId } from './operation-approval-gate.js';

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;

const requestQueryKeys = new Set(['view', 'type', 'cursor', 'limit']);
const placeHoldKeys = new Set(['subjectUserId', 'reasonCode', 'detail']);

/** The request as the console shows it: the statutory due date is NA until a period is defined. */
function withDueDates(request: PrivacyRequestRow): Record<string, unknown> {
  const due = statutoryResponseDueAt(request.requestType, new Date(request.requestedAt));
  return { ...request, statutoryDueAt: due ? due.toISOString() : null };
}

@Controller('/api/v1/operations/privacy')
export class OperationsPrivacyController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /**
   * The request queue, newest first, keyset paginated on (requested_at, id): default 50,
   * at most 200. Subjects are masked, the typed reason is never returned, and the counts
   * above the queue are computed in SQL, not from the page.
   */
  @Get('/requests')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async requests(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_REQUESTS');
    const correlationId = context.correlationId;
    for (const key of Object.keys(query)) if (!requestQueryKeys.has(key)) throw badRequest('PRIVACY_FILTER_UNKNOWN', correlationId);
    const view = query.view === undefined || query.view === '' ? 'OPEN' : query.view;
    if (typeof view !== 'string' || !(privacyRequestViews as readonly string[]).includes(view)) throw badRequest('PRIVACY_VIEW_INVALID', correlationId);
    const type = query.type === undefined || query.type === '' ? undefined : query.type;
    if (type !== undefined && (typeof type !== 'string' || !(privacyRequestTypes as readonly string[]).includes(type))) {
      throw badRequest('PRIVACY_TYPE_INVALID', correlationId);
    }
    const limit = query.limit === undefined || query.limit === '' ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badRequest('PRIVACY_LIMIT_INVALID', correlationId);
    let cursor: ReturnType<typeof decodePrivacyRequestCursor> = null;
    if (query.cursor !== undefined && query.cursor !== '') {
      cursor = typeof query.cursor === 'string' && query.cursor.length <= 256 ? decodePrivacyRequestCursor(query.cursor) : null;
      if (!cursor) throw badRequest('PRIVACY_CURSOR_INVALID', correlationId);
    }
    const page = await listPrivacyRequests(this.db, {
      view: view as PrivacyRequestView,
      limit,
      ...(type ? { requestType: type as PrivacyOperationsRequestType } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const summary = await summarisePrivacyQueue(this.db);
    return {
      requests: page.requests.map(withDueDates),
      nextCursor: page.nextCursor ? encodePrivacyRequestCursor(page.nextCursor) : null,
      summary,
      policy: {
        deletionGracePeriodDays: DELETION_GRACE_PERIOD_DAYS,
        statutoryResponsePeriodDays: STATUTORY_RESPONSE_PERIOD_DAYS,
      },
      correlationId,
    };
  }

  /**
   * One request: its state history, what a completed deletion did per category, and the
   * holds on its subject. Reading it is audited (§5.2) before the answer is returned, so
   * a read that cannot be recorded is not served.
   */
  @Get('/requests/:requestId')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async requestDetail(@Req() request: ProtectedHttpRequest, @Param('requestId') requestId: string): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_REQUESTS');
    if (!uuidPattern.test(requestId)) throw badRequest('PRIVACY_REQUEST_INVALID', context.correlationId);
    const detail = await loadPrivacyRequestDetail(this.db, requestId.toLowerCase());
    if (!detail) throw new NotFoundException({ error: { code: 'PRIVACY_REQUEST_NOT_FOUND', correlationId: context.correlationId } });
    await recordPrivacyRequestViewed(this.db, { actorUserId: context.authorization.principal.userId, requestId: detail.id, correlationId: context.correlationId });
    return { request: withDueDates(detail), correlationId: context.correlationId };
  }

  /**
   * Active legal holds, with the subject masked and any release request in flight, plus
   * the reason codes for placing one and for asking to release one.
   */
  @Get('/holds')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async holds(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_REQUESTS');
    const result = await listActiveRetentionHolds(this.db);
    return {
      holds: result.holds,
      capped: result.capped,
      reasons: { place: privacyHoldPlaceReasons, release: approvalRequestReasons.PRIVACY_HOLD_RELEASE },
      correlationId: context.correlationId,
    };
  }

  /**
   * Consent coverage: every definition and version in the registry, and per consent key
   * where people stand against its live version. Counts of fewer than 5 people arrive
   * suppressed, with no value. There is no per-person consent view.
   */
  @Get('/consents')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async consents(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_REQUESTS');
    const coverage = await readConsentCoverage(this.db);
    return { ...coverage, suppressionThreshold: aggregateSuppressionThreshold, correlationId: context.correlationId };
  }

  @Post('/holds')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async placeHold(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_HOLDS');
    const raw = readObject(body, context.correlationId);
    for (const key of Object.keys(raw)) if (!placeHoldKeys.has(key)) throw badRequest('PRIVACY_FIELD_UNKNOWN', context.correlationId);
    if (typeof raw.subjectUserId !== 'string' || !uuidPattern.test(raw.subjectUserId)) {
      throw badRequest('PRIVACY_SUBJECT_INVALID', context.correlationId);
    }
    if (!isPrivacyHoldPlaceReason(raw.reasonCode)) {
      throw badRequest('PRIVACY_HOLD_REASON_INVALID', context.correlationId);
    }
    if (raw.detail !== undefined && raw.detail !== null && typeof raw.detail !== 'string') throw badRequest('PRIVACY_HOLD_DETAIL_INVALID', context.correlationId);
    const detail = typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim() : null;
    if (detail !== null && detail.length > 2000) throw badRequest('PRIVACY_HOLD_DETAIL_TOO_LONG', context.correlationId);
    // An unknown person is a 404, not a foreign-key error; an erased one has nothing left to hold.
    const subjectState = await retentionHoldSubjectState(this.db, raw.subjectUserId);
    if (subjectState === 'NOT_FOUND') throw new NotFoundException({ error: { code: 'PRIVACY_SUBJECT_NOT_FOUND', correlationId: context.correlationId } });
    if (subjectState === 'ERASED') throw badRequest('PRIVACY_SUBJECT_ERASED', context.correlationId);

    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO data_retention_holds (id, subject_user_id, reason_code, detail, placed_by_user_id)
        VALUES (${id}::uuid, ${raw.subjectUserId}::uuid, ${raw.reasonCode}, ${detail}, ${context.authorization.principal.userId}::uuid)
      `);
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${randomUUID()}::uuid, ${context.authorization.principal.userId}::uuid, 'privacy.retention_hold.placed',
                'data_retention_hold', ${id}, NULL, 'SUCCESS', ${context.correlationId},
                ${JSON.stringify({ reasonCode: raw.reasonCode })}::jsonb)
      `);
    });
    return { placed: true, id, correlationId: context.correlationId };
  }

  /**
   * Releasing a hold lets an erasure proceed at the next sweep, so it carries its own
   * reason code rather than inheriting the one that justified placing it.
   */
  @Post('/holds/:holdId/release')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async releaseHold(
    @Req() request: ProtectedHttpRequest,
    @Param('holdId') holdId: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_HOLDS');
    if (!uuidPattern.test(holdId)) throw badRequest('PRIVACY_HOLD_INVALID', context.correlationId);
    const raw = readObject(body, context.correlationId);
    if (typeof raw.reasonCode !== 'string' || !reasonCodePattern.test(raw.reasonCode)) {
      throw badRequest('PRIVACY_RELEASE_REASON_REQUIRED', context.correlationId);
    }

    const reasonCode = raw.reasonCode;
    // OPS-02: releasing a hold is dual-controlled. An unknown or already released hold is
    // still a 404 first; a live one needs an approval bound to it and to this reason.
    const approvalId = readApprovalId(raw, context.correlationId);
    let released: boolean;
    try {
      released = await this.db.transaction(async (tx) => {
        const live = await tx.execute(sql`
          SELECT id FROM data_retention_holds WHERE id = ${holdId}::uuid AND released_at IS NULL FOR UPDATE
        `) as QueryResult<{ id: string }>;
        if (!live.rows[0]) return false;
        if (!approvalId) throw new OperationApprovalError('APPROVAL_REQUIRED');
        const approval = await consumeOperationApproval(tx, {
          approvalId, actionKey: 'PRIVACY_HOLD_RELEASE', payload: approvalPayloads.PRIVACY_HOLD_RELEASE({ holdId, reasonCode }),
          executorUserId: context.authorization.principal.userId, correlationId: context.correlationId,
        });
        await tx.execute(sql`
          UPDATE data_retention_holds
          SET released_by_user_id = ${context.authorization.principal.userId}::uuid, released_at = now()
          WHERE id = ${holdId}::uuid AND released_at IS NULL
        `);
        await tx.execute(sql`
          INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
          VALUES (${randomUUID()}::uuid, ${context.authorization.principal.userId}::uuid, 'privacy.retention_hold.released',
                  'data_retention_hold', ${holdId}, NULL, 'SUCCESS', ${context.correlationId},
                  ${JSON.stringify({ reasonCode, approval })}::jsonb)
        `);
        return true;
      });
    } catch (error) {
      throw approvalHttpError(error, context.correlationId) ?? error;
    }
    if (!released) throw new NotFoundException({ error: { code: 'PRIVACY_HOLD_NOT_FOUND', correlationId: context.correlationId } });
    return { released: true, correlationId: context.correlationId };
  }
}

/**
 * PRIVACY_REQUESTS to read the queues, PRIVACY_HOLDS to place or release a hold
 * (OPS-01). Both are baseline for the three platform roles — the set that could search
 * the audit record before. A retention hold suspends a data-subject right, so it is not
 * an ordinary support action.
 */
async function requirePrivacyOperator(
  request: ProtectedHttpRequest,
  db: PersistenceDb,
  capability: 'PRIVACY_REQUESTS' | 'PRIVACY_HOLDS',
): Promise<ReturnType<typeof requireTrustedAuthorization>> {
  const context = requireTrustedAuthorization(request);
  const permitted = await callerHasInternalCapability(context.authorization, dbCapabilityGrantLoader(db), capability);
  if (!permitted) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));
  return context;
}

function readObject(body: unknown, correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  return body as Record<string, unknown>;
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, correlationId } });
}
