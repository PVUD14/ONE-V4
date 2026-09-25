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

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonCodePattern = /^[A-Z0-9_:-]{3,64}$/;

/** The five lawful bases the schema already bounds this to. */
const holdReasons = ['LEGAL_OBLIGATION', 'SAFETY_INVESTIGATION', 'EMPLOYER_ACCOUNTABILITY_CASE', 'DISPUTE', 'REGULATORY_REQUEST'];

@Controller('/api/v1/operations/privacy')
export class OperationsPrivacyController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  /**
   * The request queue. Bounded and ordered by due date, so what is about to be erased
   * is what an operator sees first.
   */
  @Get('/requests')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async requests(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_REQUESTS');
    const rows = await this.db.execute(sql`
      SELECT r.id, r.subject_user_id, r.request_type, r.state, r.requested_at, r.due_at,
             r.completed_at, r.cancelled_at,
             (SELECT count(*)::int FROM data_retention_holds h
               WHERE h.subject_user_id = r.subject_user_id AND h.released_at IS NULL) AS active_holds
      FROM privacy_requests r
      ORDER BY r.due_at ASC NULLS LAST, r.requested_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { requests: rows.rows, correlationId: context.correlationId };
  }

  @Get('/holds')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async holds(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_REQUESTS');
    const rows = await this.db.execute(sql`
      SELECT h.id, h.subject_user_id, u.email AS subject_email, h.reason_code, h.detail,
             h.placed_by_user_id, h.placed_at
      FROM data_retention_holds h
      JOIN users u ON u.id = h.subject_user_id
      WHERE h.released_at IS NULL
      ORDER BY h.placed_at DESC
      LIMIT 200
    `) as QueryResult<Record<string, unknown>>;
    return { holds: rows.rows, correlationId: context.correlationId };
  }

  @Post('/holds')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async placeHold(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = await requirePrivacyOperator(request, this.db, 'PRIVACY_HOLDS');
    const raw = readObject(body, context.correlationId);
    if (typeof raw.subjectUserId !== 'string' || !uuidPattern.test(raw.subjectUserId)) {
      throw badRequest('PRIVACY_SUBJECT_INVALID', context.correlationId);
    }
    if (typeof raw.reasonCode !== 'string' || !holdReasons.includes(raw.reasonCode)) {
      throw badRequest('PRIVACY_HOLD_REASON_INVALID', context.correlationId);
    }
    const detail = raw.detail === undefined || raw.detail === null ? null : String(raw.detail);
    if (detail !== null && detail.length > 2000) throw badRequest('PRIVACY_HOLD_DETAIL_TOO_LONG', context.correlationId);

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

    const released = await this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE data_retention_holds
        SET released_by_user_id = ${context.authorization.principal.userId}::uuid, released_at = now()
        WHERE id = ${holdId}::uuid AND released_at IS NULL
        RETURNING id
      `) as QueryResult<{ id: string }>;
      if (!result.rows[0]) return false;
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${randomUUID()}::uuid, ${context.authorization.principal.userId}::uuid, 'privacy.retention_hold.released',
                'data_retention_hold', ${holdId}, NULL, 'SUCCESS', ${context.correlationId},
                ${JSON.stringify({ reasonCode: raw.reasonCode })}::jsonb)
      `);
      return true;
    });
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
