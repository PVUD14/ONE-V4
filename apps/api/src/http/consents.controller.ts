import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';

type QueryResult<T> = { rows: T[] };

function apiError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly correlationId: string } } {
  return { error: { code, correlationId } };
}

function requireContext(request: ProtectedHttpRequest): { userId: string; correlationId: string } {
  const userId = request.planThePath?.authorization?.principal.userId;
  const correlationId = request.planThePath?.correlationId;
  if (!userId || !correlationId) throw new ForbiddenException(apiError('FORBIDDEN', correlationId ?? 'unknown'));
  return { userId, correlationId };
}

/**
 * DPDP consent capture. The gate is dormant until the operator sets
 * CONSENT_PRIVACY_NOTICE_VERSION in app.env (done only once the lawyer-approved
 * notice is published in the product) — from that moment, clients see
 * required=true until the signed-in user grants that exact version, and every
 * grant is an append-only, correlation-stamped record.
 */
@Controller('/api/v1/me/consents')
export class ConsentsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/privacy-notice')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async status(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const requiredVersion = process.env.CONSENT_PRIVACY_NOTICE_VERSION?.trim() || null;
    let grantedVersion: string | null = null;
    if (requiredVersion) {
      const latest = await this.db.execute(sql`
        SELECT version, action FROM user_consents
        WHERE user_id = ${userId}::uuid AND consent_key = 'privacy-notice'
        ORDER BY recorded_at DESC LIMIT 1
      `) as QueryResult<{ version: string; action: string }>;
      const row = latest.rows[0];
      grantedVersion = row && row.action === 'GRANTED' ? row.version : null;
    }
    return {
      requiredVersion,
      grantedVersion,
      required: Boolean(requiredVersion) && grantedVersion !== requiredVersion,
      correlationId,
    };
  }

  @Post('/privacy-notice')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async grant(@Req() request: ProtectedHttpRequest, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const requiredVersion = process.env.CONSENT_PRIVACY_NOTICE_VERSION?.trim() || null;
    const version = String(body['version'] ?? '');
    // Only the currently-required version is grantable: consent must be to the
    // text the user was actually shown, not a stale or speculative one.
    if (!requiredVersion || version !== requiredVersion) {
      throw new BadRequestException(apiError('CONSENT_VERSION_MISMATCH', correlationId));
    }
    await this.db.execute(sql`
      INSERT INTO user_consents (id, user_id, consent_key, version, action, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${userId}::uuid, 'privacy-notice', ${version}, 'GRANTED', ${correlationId})
    `);
    return { granted: true, version, correlationId };
  }
}
