import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  PrivacyRuleError,
  assertExportDownloadable,
  assertPrivacyTransition,
  deletionScheduledFor,
  exportExpiresAt,
  type PrivacyRequestState,
} from '@planthepath/privacy';
import type { FileStorage } from '../storage/file-storage.js';
import {
  API_FILE_STORAGE,
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { assembleSubjectExport } from './privacy-export.js';

type QueryResult<T> = { rows: T[] };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Data subject rights for the signed-in student: request an export, download it,
 * request deletion, and cancel within the grace period.
 *
 * Every route acts on the caller's own subject id, taken from the verified principal
 * and never from the request, so one person cannot exercise another's rights.
 */
@Controller('/api/v1')
export class StudentPrivacyController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
    @Optional() @Inject(API_FILE_STORAGE) private readonly storage?: FileStorage,
  ) {}

  @Get('/students/me/privacy/requests')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async listRequests(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const rows = await this.db.execute(sql`
      SELECT id, request_type, state, requested_at, completed_at, cancelled_at,
             deletion_scheduled_for, export_expires_at, export_downloaded_at, rejection_reason_code
      FROM privacy_requests
      WHERE subject_user_id = ${context.authorization.principal.userId}::uuid
      ORDER BY requested_at DESC
      LIMIT 100
    `) as QueryResult<Record<string, unknown>>;
    return { requests: rows.rows.map(mapRequest), correlationId: context.correlationId };
  }

  @Post('/students/me/privacy/exports')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async requestExport(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const subjectUserId = context.authorization.principal.userId;
    const storage = this.requireStorage(context.correlationId);
    const requestId = this.ids.uuid();

    const created = await this.db.execute(sql`
      INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, correlation_id)
      VALUES (${requestId}::uuid, ${subjectUserId}::uuid, ${subjectUserId}::uuid, 'EXPORT', 'RECEIVED', ${context.correlationId})
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (created.rows.length !== 1) throw badRequest('EXPORT_ALREADY_REQUESTED', context.correlationId);
    await this.recordEvent(requestId, null, 'RECEIVED', subjectUserId, 'SUBJECT');

    // The bundle is small enough to build inline; a queue here would add a failure
    // mode without changing what the subject experiences.
    try {
      assertPrivacyTransition({ requestType: 'EXPORT', from: 'RECEIVED', to: 'IN_PROGRESS', actor: 'SYSTEM' });
      await this.db.execute(sql`UPDATE privacy_requests SET state = 'IN_PROGRESS', started_at = now(), updated_at = now() WHERE id = ${requestId}::uuid`);
      await this.recordEvent(requestId, 'RECEIVED', 'IN_PROGRESS', null, 'SYSTEM');

      const bundle = await assembleSubjectExport(this.db, subjectUserId);
      const bytes = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
      const fileId = this.ids.uuid();
      const storageKey = `exports/${subjectUserId}/${requestId}-${randomUUID()}.json`;
      await storage.put(storageKey, bytes);

      await this.db.execute(sql`
        INSERT INTO stored_files (id, storage_provider, storage_bucket, storage_key, original_filename, content_type, byte_size, checksum_sha256, upload_state, scan_state, scan_engine, scan_completed_at, uploaded_by_user_id, system_generated)
        VALUES (${fileId}::uuid, ${storage.provider}, ${storage.bucket ?? null}, ${storageKey}, ${'one-data-export.json'}, 'application/json', ${bytes.length},
                ${createHash('sha256').update(bytes).digest('hex')}, 'STORED', 'CLEAN', 'system-generated', now(), ${subjectUserId}::uuid, true)
      `);

      const expires = exportExpiresAt(new Date());
      await this.db.execute(sql`
        UPDATE privacy_requests SET state = 'READY', export_file_id = ${fileId}::uuid, export_expires_at = ${expires.toISOString()}::timestamptz, updated_at = now()
        WHERE id = ${requestId}::uuid
      `);
      await this.recordEvent(requestId, 'IN_PROGRESS', 'READY', null, 'SYSTEM');
      await this.writeAudit(subjectUserId, 'privacy.export_ready', 'privacy_request', requestId, context.correlationId);

      return { request: { id: requestId, state: 'READY', expiresAt: expires.toISOString() }, correlationId: context.correlationId };
    } catch (error) {
      // A failed export must not sit as though it were still working.
      await this.db.execute(sql`UPDATE privacy_requests SET state = 'FAILED', updated_at = now() WHERE id = ${requestId}::uuid AND state IN ('RECEIVED','IN_PROGRESS')`);
      await this.recordEvent(requestId, 'IN_PROGRESS', 'FAILED', null, 'SYSTEM');
      throw error;
    }
  }

  @Get('/students/me/privacy/exports/:requestId/download')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async downloadExport(@Req() request: ProtectedHttpRequest, @Param('requestId') requestId: string, @Res() response: DownloadResponse): Promise<void> {
    const context = requireTrustedAuthorization(request);
    const subjectUserId = context.authorization.principal.userId;
    const id = requireUuid(requestId, context.correlationId);
    const storage = this.requireStorage(context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT r.state, r.export_expires_at, f.storage_key, f.byte_size
      FROM privacy_requests r
      JOIN readable_stored_files f ON f.id = r.export_file_id
      WHERE r.id = ${id}::uuid AND r.subject_user_id = ${subjectUserId}::uuid AND r.request_type = 'EXPORT'
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);

    try {
      assertExportDownloadable({
        state: String(row.state) as PrivacyRequestState,
        expiresAt: row.export_expires_at ? new Date(String(row.export_expires_at)) : null,
        now: new Date(),
      });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    const bytes = await storage.get(String(row.storage_key));
    await this.db.execute(sql`UPDATE privacy_requests SET export_downloaded_at = coalesce(export_downloaded_at, now()), updated_at = now() WHERE id = ${id}::uuid`);
    await this.writeAudit(subjectUserId, 'privacy.export_downloaded', 'privacy_request', id, context.correlationId);

    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Length', String(bytes.length));
    response.setHeader('Content-Disposition', 'attachment; filename="one-data-export.json"');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(bytes);
  }

  @Post('/students/me/privacy/deletions')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async requestDeletion(@Req() request: ProtectedHttpRequest, @Body() body: unknown): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const subjectUserId = context.authorization.principal.userId;
    const reason = readOptionalText(body, 'reason', 2000, context.correlationId);
    const requestId = this.ids.uuid();
    const scheduledFor = deletionScheduledFor(new Date());

    const created = await this.db.execute(sql`
      INSERT INTO privacy_requests (id, subject_user_id, requested_by_user_id, request_type, state, reason, deletion_scheduled_for, correlation_id)
      VALUES (${requestId}::uuid, ${subjectUserId}::uuid, ${subjectUserId}::uuid, 'DELETION', 'RECEIVED', ${reason}, ${scheduledFor.toISOString()}::timestamptz, ${context.correlationId})
      ON CONFLICT DO NOTHING
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (created.rows.length !== 1) throw badRequest('DELETION_ALREADY_REQUESTED', context.correlationId);

    await this.recordEvent(requestId, null, 'RECEIVED', subjectUserId, 'SUBJECT');
    await this.writeAudit(subjectUserId, 'privacy.deletion_requested', 'privacy_request', requestId, context.correlationId);

    return {
      request: { id: requestId, state: 'RECEIVED', scheduledFor: scheduledFor.toISOString() },
      // Stated back so the grace period is something the subject knows they have.
      gracePeriodDays: 30,
      correlationId: context.correlationId,
    };
  }

  @Post('/students/me/privacy/requests/:requestId/cancel')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async cancelRequest(@Req() request: ProtectedHttpRequest, @Param('requestId') requestId: string): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    const subjectUserId = context.authorization.principal.userId;
    const id = requireUuid(requestId, context.correlationId);

    const rows = await this.db.execute(sql`
      SELECT state, request_type FROM privacy_requests
      WHERE id = ${id}::uuid AND subject_user_id = ${subjectUserId}::uuid
    `) as QueryResult<Record<string, unknown>>;
    const [row] = rows.rows;
    if (!row) throw forbidden(context.correlationId);

    const from = String(row.state) as PrivacyRequestState;
    try {
      assertPrivacyTransition({
        requestType: String(row.request_type) as 'EXPORT' | 'DELETION',
        from, to: 'CANCELLED', actor: 'SUBJECT',
      });
    } catch (error) {
      throw ruleFailure(error, context.correlationId);
    }

    await this.db.execute(sql`
      UPDATE privacy_requests SET state = 'CANCELLED', cancelled_at = now(), updated_at = now()
      WHERE id = ${id}::uuid AND subject_user_id = ${subjectUserId}::uuid
    `);
    await this.recordEvent(id, from, 'CANCELLED', subjectUserId, 'SUBJECT');
    await this.writeAudit(subjectUserId, 'privacy.request_cancelled', 'privacy_request', id, context.correlationId);

    return { request: { id, state: 'CANCELLED' }, correlationId: context.correlationId };
  }

  private requireStorage(correlationId: string): FileStorage {
    if (!this.storage) throw new ServiceUnavailableException(safePrivacyError('FILE_STORAGE_NOT_CONFIGURED', correlationId));
    return this.storage;
  }

  private async recordEvent(requestId: string, from: string | null, to: string, actorUserId: string | null, actorRole: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO privacy_request_events (id, request_id, from_state, to_state, actor_user_id, actor_role)
      VALUES (${this.ids.uuid()}::uuid, ${requestId}::uuid, ${from}, ${to}, ${actorUserId}::uuid, ${actorRole})
    `);
  }

  private async writeAudit(actorUserId: string, action: string, resourceType: string, resourceId: string, correlationId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
      VALUES (${this.ids.uuid()}::uuid, ${actorUserId}::uuid, ${action}, ${resourceType}, ${resourceId}::uuid, 'SUCCESS', ${correlationId})
    `);
  }
}

interface DownloadResponse {
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

function mapRequest(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    requestType: row.request_type,
    state: row.state,
    requestedAt: row.requested_at,
    completedAt: row.completed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    scheduledFor: row.deletion_scheduled_for ?? null,
    expiresAt: row.export_expires_at ?? null,
    downloadedAt: row.export_downloaded_at ?? null,
    rejectionReasonCode: row.rejection_reason_code ?? null,
  };
}

function readOptionalText(body: unknown, field: string, max: number, correlationId: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw badRequest('INVALID_FIELD', correlationId);
  return value;
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value;
}

function safePrivacyError(code: string, correlationId: string): { readonly error: { readonly code: string; readonly message: string; readonly correlationId: string } } {
  return { error: { code, message: 'Request could not be completed', correlationId } };
}

function ruleFailure(error: unknown, correlationId: string): Error {
  if (error instanceof PrivacyRuleError) return new BadRequestException(safePrivacyError(error.code, correlationId));
  return error instanceof Error ? error : new BadRequestException(safePrivacyError('INVALID_REQUEST', correlationId));
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException(safePrivacyError(code, correlationId));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}
