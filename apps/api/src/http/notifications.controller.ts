import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORMS = ['ANDROID', 'IOS', 'WEB'] as const;

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
 * The persistent per-user notification feed and the device push-token
 * registry. Serves the web bell today and the Android app's inbox and FCM
 * registration tomorrow — one contract for both clients.
 */
@Controller('/api/v1/me')
export class NotificationsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
  ) {}

  @Get('/notifications')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async list(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const rows = await this.db.execute(sql`
      SELECT id, kind, title, body, data, created_at, read_at
      FROM user_notifications
      WHERE user_id = ${userId}::uuid
      ORDER BY created_at DESC
      LIMIT 50
    `) as QueryResult<Record<string, unknown>>;
    const unread = await this.db.execute(sql`
      SELECT count(*)::int AS unread FROM user_notifications
      WHERE user_id = ${userId}::uuid AND read_at IS NULL
    `) as QueryResult<{ unread: number }>;
    return {
      notifications: rows.rows.map((row) => ({
        id: row['id'],
        kind: row['kind'],
        title: row['title'],
        body: row['body'],
        data: row['data'] ?? {},
        createdAt: row['created_at'],
        readAt: row['read_at'],
      })),
      unreadCount: Number(unread.rows[0]?.unread ?? 0),
      correlationId,
    };
  }

  @Post('/notifications/:notificationId/read')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async markRead(@Req() request: ProtectedHttpRequest, @Param('notificationId') notificationId: string): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    if (!uuidPattern.test(notificationId)) throw new BadRequestException(apiError('INVALID_NOTIFICATION_ID', correlationId));
    const updated = await this.db.execute(sql`
      UPDATE user_notifications SET read_at = now()
      WHERE id = ${notificationId}::uuid AND user_id = ${userId}::uuid AND read_at IS NULL
      RETURNING id
    `) as QueryResult<{ id: string }>;
    return { marked: updated.rows.length, correlationId };
  }

  @Post('/notifications/read-all')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async markAllRead(@Req() request: ProtectedHttpRequest): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const updated = await this.db.execute(sql`
      UPDATE user_notifications SET read_at = now()
      WHERE user_id = ${userId}::uuid AND read_at IS NULL
      RETURNING id
    `) as QueryResult<{ id: string }>;
    return { marked: updated.rows.length, correlationId };
  }

  /**
   * Registers (or refreshes) a device push token. Idempotent on the token: a
   * token that moves to another account is reassigned, because the device now
   * belongs to whoever is signed in on it.
   */
  @Post('/devices')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async registerDevice(@Req() request: ProtectedHttpRequest, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const platform = String(body['platform'] ?? '');
    const token = String(body['token'] ?? '');
    if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) throw new BadRequestException(apiError('INVALID_PLATFORM', correlationId));
    if (token.length < 8 || token.length > 4096) throw new BadRequestException(apiError('INVALID_TOKEN', correlationId));
    await this.db.execute(sql`
      INSERT INTO device_push_tokens (id, user_id, platform, token)
      VALUES (${this.ids.uuid()}::uuid, ${userId}::uuid, ${platform}, ${token})
      ON CONFLICT (token) DO UPDATE
        SET user_id = ${userId}::uuid, platform = ${platform}, last_seen_at = now(), revoked_at = NULL
    `);
    return { registered: true, correlationId };
  }

  @Post('/devices/revoke')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async revokeDevice(@Req() request: ProtectedHttpRequest, @Body() body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { userId, correlationId } = requireContext(request);
    const token = String(body['token'] ?? '');
    const updated = await this.db.execute(sql`
      UPDATE device_push_tokens SET revoked_at = now()
      WHERE token = ${token} AND user_id = ${userId}::uuid AND revoked_at IS NULL
      RETURNING id
    `) as QueryResult<{ id: string }>;
    return { revoked: updated.rows.length, correlationId };
  }
}
