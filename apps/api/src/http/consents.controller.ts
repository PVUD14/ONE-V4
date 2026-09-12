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

interface ConsentRow {
  consent_key: string;
  version: string;
  title: string;
  enforcement: 'BLOCKING' | 'OPTIONAL';
  withdrawable: boolean;
  granted_version: string | null;
  granted_action: string | null;
}

/**
 * DPDP consent capture, over the registry introduced in migration 0028.
 *
 * The set of consents is data rather than a CHECK constraint and an environment
 * variable, so adding the AI-processing or employer-discovery consent is a row, and
 * the current version of each is a single answer the gate can ask for.
 *
 * Withdrawal exists because the gate's own copy has always promised it and because
 * under DPDP it must be as easy as granting. Withdrawing a BLOCKING consent means the
 * product can no longer be used, which is a real consequence and is reported to the
 * caller rather than hidden.
 */
@Controller('/api/v1/me/consents')
export class ConsentsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  /** Every live consent, with what this user has done about each. */
  @Get('/')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async all(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const rows = await this.loadConsents(userId);
    return {
      consents: rows.map((row) => ({
        consentKey: row.consent_key,
        currentVersion: row.version,
        title: row.title,
        enforcement: row.enforcement,
        withdrawable: row.withdrawable,
        grantedVersion: row.granted_action === 'GRANTED' ? row.granted_version : null,
        required: row.enforcement === 'BLOCKING' && !(row.granted_action === 'GRANTED' && row.granted_version === row.version),
      })),
      // The single question the gate asks.
      blocked: rows.some((row) => row.enforcement === 'BLOCKING'
        && !(row.granted_action === 'GRANTED' && row.granted_version === row.version)),
      correlationId,
    };
  }

  /**
   * Kept at its original path and shape so existing clients are unaffected while the
   * registry takes over underneath.
   */
  @Get('/privacy-notice')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async status(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const row = (await this.loadConsents(userId)).find((candidate) => candidate.consent_key === 'privacy-notice');
    const requiredVersion = row?.version ?? null;
    const grantedVersion = row && row.granted_action === 'GRANTED' ? row.granted_version : null;
    return {
      requiredVersion,
      grantedVersion,
      required: Boolean(requiredVersion) && grantedVersion !== requiredVersion,
      correlationId,
    };
  }

  @Post('/privacy-notice')
  @UseGuards(ProtectedApiAuthenticationGuard)
  grantPrivacyNotice(@Req() request: ProtectedHttpRequest, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.record(request, 'privacy-notice', String(body['version'] ?? ''), 'GRANTED');
  }

  @Post('/:consentKey/grant')
  @UseGuards(ProtectedApiAuthenticationGuard)
  grant(@Req() request: ProtectedHttpRequest, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.record(request, readKey(body, request), String(body['version'] ?? ''), 'GRANTED');
  }

  /**
   * Withdrawal is recorded against the version the user actually holds, not the
   * current one — withdrawing consent to a notice they never saw would be a fiction.
   */
  @Post('/:consentKey/withdraw')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async withdraw(@Req() request: ProtectedHttpRequest, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const consentKey = readKey(body, request);
    const rows = await this.loadConsents(userId);
    const row = rows.find((candidate) => candidate.consent_key === consentKey);
    if (!row) throw new BadRequestException(apiError('CONSENT_NOT_DEFINED', correlationId));
    if (!row.withdrawable) throw new BadRequestException(apiError('CONSENT_NOT_WITHDRAWABLE', correlationId));
    if (row.granted_action !== 'GRANTED' || !row.granted_version) {
      throw new BadRequestException(apiError('CONSENT_NOT_HELD', correlationId));
    }

    await this.db.execute(sql`
      INSERT INTO user_consents (id, user_id, consent_key, version, action, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${userId}::uuid, ${consentKey}, ${row.granted_version}, 'WITHDRAWN', ${correlationId})
    `);
    return {
      withdrawn: true,
      consentKey,
      version: row.granted_version,
      // Said plainly rather than discovered at the next page load.
      blocksProductUse: row.enforcement === 'BLOCKING',
      correlationId,
    };
  }

  private async record(
    request: ProtectedHttpRequest,
    consentKey: string,
    version: string,
    action: 'GRANTED',
  ): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const current = await this.db.execute(sql`
      SELECT version FROM consent_definitions
      WHERE consent_key = ${consentKey} AND retired_at IS NULL
    `) as QueryResult<{ version: string }>;
    const requiredVersion = current.rows[0]?.version ?? null;
    // Only the currently-published version is grantable: consent must be to the text
    // the user was actually shown, not a stale or speculative one.
    if (!requiredVersion || version !== requiredVersion) {
      throw new BadRequestException(apiError('CONSENT_VERSION_MISMATCH', correlationId));
    }
    await this.db.execute(sql`
      INSERT INTO user_consents (id, user_id, consent_key, version, action, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${userId}::uuid, ${consentKey}, ${version}, ${action}, ${correlationId})
    `);
    return { granted: true, consentKey, version, correlationId };
  }

  /** Live definitions, left-joined to this user's most recent action on each. */
  private async loadConsents(userId: string): Promise<ConsentRow[]> {
    const result = await this.db.execute(sql`
      SELECT d.consent_key, d.version, d.title, d.enforcement, d.withdrawable,
             latest.version AS granted_version, latest.action AS granted_action
      FROM consent_definitions d
      LEFT JOIN LATERAL (
        SELECT c.version, c.action FROM user_consents c
        WHERE c.user_id = ${userId}::uuid AND c.consent_key = d.consent_key
        ORDER BY c.recorded_at DESC LIMIT 1
      ) latest ON true
      WHERE d.retired_at IS NULL
      ORDER BY d.consent_key
    `) as unknown as QueryResult<ConsentRow>;
    return result.rows;
  }
}

function readKey(body: Record<string, unknown>, request: ProtectedHttpRequest): string {
  const fromPath = (request as unknown as { params?: Record<string, unknown> }).params?.consentKey;
  const value = typeof fromPath === 'string' && fromPath ? fromPath : String(body['consentKey'] ?? '');
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(value)) {
    throw new BadRequestException(apiError('CONSENT_KEY_INVALID', request.planThePath?.correlationId ?? 'unknown'));
  }
  return value;
}
