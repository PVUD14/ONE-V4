/**
 * Institution announcements (INST-06): compose, list and cancel cohort announcements.
 *
 * Owners, admins and placement admins address the institution (a placement admin within their
 * membership's unit scope); department heads their department; faculty the sections and batches
 * of their active teaching assignments (decision 10.2 #8). Who may address which unit is decided
 * by the single institution scope helper in packages/authorization, from the trusted
 * authorization context — never from the request. Recipients are resolved by the worker at send
 * time (packages/persistence/src/institution-announcements.ts); this controller never writes a
 * notification itself, so composing to a large cohort never blocks a request.
 * Design: docs/architecture/institution-announcements-table-design.md.
 */
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException, HttpStatus, Inject, Optional, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { institutionAnnouncementSender, institutionAnnouncementSenderRoles, type InstitutionStaffScopeMembership, type InstitutionUnitNode } from '@planthepath/authorization/src/index.js';
import {
  ANNOUNCEMENT_TEMPLATE_KEY,
  ANNOUNCEMENT_TEMPLATE_VERSION,
  ensureAnnouncementTemplate,
  writeAnnouncementDispatchRequested,
} from '@planthepath/persistence/src/institution-announcements.js';
import { withTeachingAssignments } from '@planthepath/persistence/src/institution-scope.js';
import type { InvitationMailSink } from '@planthepath/persistence/src/invitation-mail.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import {
  API_ID_GENERATOR,
  API_PERSISTENCE_DB,
  ProtectedApiAuthenticationGuard,
  requireTrustedAuthorization,
  safeError,
  type ApiIdGenerator,
  type ProtectedHttpRequest,
} from './api-security.js';
import { institutionStaffScopeMemberships } from './institution-student-scope.js';
import { API_INVITATION_MAIL_SINK } from './operations-institution-onboarding.controller.js';

type Rows<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonPattern = /^[A-Z0-9_:-]{3,64}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const adminRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN'];
const senderRoles: readonly string[] = institutionAnnouncementSenderRoles;
const createFields = new Set(['title', 'body', 'audienceUnitId', 'channels', 'scheduledFor']);
const channelNames = ['IN_APP', 'EMAIL'] as const;
/** A sender may compose this many announcements per institution in any rolling 24 hours. */
export const ANNOUNCEMENT_DAILY_LIMIT = 20;
const maximumScheduleDays = 90;

interface AnnouncementRow extends Record<string, unknown> {
  id: string; sender_user_id: string; sender_role: string; audience_kind: string; audience_unit_id: string | null; audience_name: string | null;
  title: string; body: string; channels: string[]; state: string; scheduled_for: Date | string; sent_at: Date | string | null;
  recipient_count: number | null; cancelled_at: Date | string | null; cancel_reason_code: string | null;
  created_at: Date | string; created_key: string; email_states: Record<string, number> | null;
}

interface UnitRow extends Record<string, unknown> { id: string; kind: string; name: string; parent_unit_id: string | null }

@Controller('/api/v1')
@UseGuards(ProtectedApiAuthenticationGuard)
export class InstitutionAnnouncementsController {
  constructor(
    @Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb,
    @Inject(API_ID_GENERATOR) private readonly ids: ApiIdGenerator,
    @Optional() @Inject(API_INVITATION_MAIL_SINK) private readonly mailSink?: InvitationMailSink,
  ) {}

  /**
   * The caller's announcements (owners and admins: every announcement of the institution), newest
   * first, with delivery counts, plus the audiences the caller may address for the composer.
   */
  @Get('/institutions/:institutionId/announcements')
  async list(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Query('limit') limitParam?: string,
    @Query('cursor') cursorParam?: string,
  ): Promise<Record<string, unknown>> {
    const { context, id, memberships } = senderContext(request, institutionId);
    const limit = readLimit(limitParam, context.correlationId);
    const cursor = readCursor(cursorParam, context.correlationId);
    const seeAll = memberships.some((membership) => adminRoles.includes(membership.role));
    const rows = await this.db.execute(sql`
      ${announcementSelect(id)}
        AND (${seeAll}::boolean OR a.sender_user_id = ${context.authorization.principal.userId}::uuid)
        AND (${cursor?.[0] ?? null}::timestamptz IS NULL OR (a.created_at, a.id) < (${cursor?.[0] ?? null}::timestamptz, ${cursor?.[1] ?? null}::uuid))
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit + 1}
    `) as Rows<AnnouncementRow>;
    const page = rows.rows.slice(0, limit);
    const audiences = await this.addressableAudiences(id, memberships);
    return {
      announcements: page.map((row) => mapAnnouncement(row, context.authorization.principal.userId)),
      nextCursor: rows.rows.length > limit ? encodeCursor([page.at(-1)!.created_key, page.at(-1)!.id]) : null,
      audiences,
      canSend: audiences.length > 0,
      emailConfigured: Boolean(this.mailSink),
      dailyLimit: ANNOUNCEMENT_DAILY_LIMIT,
      correlationId: context.correlationId,
    };
  }

  @Post('/institutions/:institutionId/announcements')
  async create(@Req() request: ProtectedHttpRequest, @Param('institutionId') institutionId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const { context, id, memberships } = senderContext(request, institutionId);
    const input = readCreateInput(body, context.correlationId);
    const actorUserId = context.authorization.principal.userId;
    const announcementId = this.ids.uuid();
    await this.db.transaction(async (tx) => {
      // Serialise one sender's composing so the daily limit cannot be raced past.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'announcement:' + actorUserId + ':' + id}))`);
      const units = await loadUnits(tx, id);
      const audienceUnit = input.audienceUnitId === null ? null : units.find((unit) => unit.id === input.audienceUnitId);
      if (audienceUnit === undefined) throw invalid('INVALID_AUDIENCE', context.correlationId, 'audienceUnitId');
      const sender = institutionAnnouncementSender(await withTeachingAssignments(tx, id, memberships), tree(units), input.audienceUnitId);
      if (!sender) throw forbidden(context.correlationId);
      const schedule = await tx.execute(sql`
        SELECT (${input.scheduledFor}::timestamptz IS NULL OR ${input.scheduledFor}::timestamptz > now()) AS future,
               (${input.scheduledFor}::timestamptz IS NULL OR ${input.scheduledFor}::timestamptz <= now() + make_interval(days => ${maximumScheduleDays})) AS near,
               (SELECT count(*)::int FROM institution_announcements
                 WHERE sender_user_id = ${actorUserId}::uuid AND institution_id = ${id}::uuid AND created_at > now() - interval '24 hours') AS recent
      `) as Rows<{ future: boolean; near: boolean; recent: number }>;
      const check = schedule.rows[0]!;
      if (!check.future || !check.near) throw invalid('INVALID_SCHEDULE', context.correlationId, 'scheduledFor');
      if (check.recent >= ANNOUNCEMENT_DAILY_LIMIT) {
        throw new HttpException({ error: { code: 'ANNOUNCEMENT_RATE_LIMITED', message: 'Request could not be completed', correlationId: context.correlationId } }, HttpStatus.TOO_MANY_REQUESTS);
      }
      await ensureAnnouncementTemplate(tx, actorUserId);
      await tx.execute(sql`
        INSERT INTO institution_announcements
          (id, institution_id, sender_user_id, sender_membership_id, sender_role, audience_kind, audience_unit_id, title, body, channels,
           email_template_key, email_template_version, state, scheduled_for)
        VALUES (${announcementId}::uuid, ${id}::uuid, ${actorUserId}::uuid, ${sender.membership.membershipId}::uuid, ${sender.membership.role},
                ${audienceUnit ? audienceUnit.kind : 'INSTITUTION'}, ${input.audienceUnitId}::uuid, ${input.title}, ${input.body},
                ${`{${input.channels.join(',')}}`}::text[], ${ANNOUNCEMENT_TEMPLATE_KEY}, ${ANNOUNCEMENT_TEMPLATE_VERSION}, 'SCHEDULED',
                coalesce(${input.scheduledFor}::timestamptz, now()))
      `);
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId, action: 'institution.announcement.created', resourceId: announcementId, organizationId: id,
        correlationId: context.correlationId,
        context: { audienceKind: audienceUnit ? audienceUnit.kind : 'INSTITUTION', audienceUnitId: input.audienceUnitId, channels: input.channels, scheduled: input.scheduledFor !== null, senderRole: sender.membership.role },
      });
      await writeAnnouncementDispatchRequested(tx, { eventId: this.ids.uuid(), announcementId, actorUserId, institutionId: id, correlationId: context.correlationId });
    });
    return { announcement: mapAnnouncement(await this.load(id, announcementId), actorUserId), correlationId: context.correlationId };
  }

  /** Cancel a scheduled announcement: its sender, or an owner or admin. Reason-coded and audited. */
  @Post('/institutions/:institutionId/announcements/:announcementId/cancel')
  async cancel(
    @Req() request: ProtectedHttpRequest,
    @Param('institutionId') institutionId: string,
    @Param('announcementId') announcementIdParam: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const { context, id, memberships } = senderContext(request, institutionId);
    const announcementId = requireUuid(announcementIdParam, context.correlationId);
    const source = readBody(body, new Set(['reasonCode']), context.correlationId);
    if (typeof source.reasonCode !== 'string' || !reasonPattern.test(source.reasonCode)) throw invalid('INVALID_REASON_CODE', context.correlationId, 'reasonCode');
    const reasonCode = source.reasonCode;
    const actorUserId = context.authorization.principal.userId;
    const admin = memberships.some((membership) => adminRoles.includes(membership.role));
    await this.db.transaction(async (tx) => {
      // The same row lock the sender takes, so a cancel and a send cannot both win.
      const found = await tx.execute(sql`
        SELECT id, sender_user_id, state FROM institution_announcements
        WHERE id = ${announcementId}::uuid AND institution_id = ${id}::uuid
        FOR UPDATE
      `) as Rows<{ id: string; sender_user_id: string; state: string }>;
      const current = found.rows[0];
      if (!current || (!admin && current.sender_user_id !== actorUserId)) throw forbidden(context.correlationId);
      if (current.state !== 'SCHEDULED') throw new ConflictException(errorBody('ANNOUNCEMENT_NOT_SCHEDULED', context.correlationId));
      await tx.execute(sql`
        UPDATE institution_announcements
        SET state = 'CANCELLED', cancelled_at = now(), cancelled_by_user_id = ${actorUserId}::uuid, cancel_reason_code = ${reasonCode}, updated_at = now()
        WHERE id = ${announcementId}::uuid AND state = 'SCHEDULED'
      `);
      await writeAudit(tx, {
        id: this.ids.uuid(), actorUserId, action: 'institution.announcement.cancelled', resourceId: announcementId, organizationId: id,
        correlationId: context.correlationId, context: { reasonCode },
      });
    });
    return { announcement: mapAnnouncement(await this.load(id, announcementId), actorUserId), correlationId: context.correlationId };
  }

  private async load(institutionId: string, announcementId: string): Promise<AnnouncementRow> {
    const rows = await this.db.execute(sql`${announcementSelect(institutionId)} AND a.id = ${announcementId}::uuid`) as Rows<AnnouncementRow>;
    return rows.rows[0]!;
  }

  /** Every audience the caller may address: the institution (if their scope is institution-wide) and each unit in scope. */
  private async addressableAudiences(institutionId: string, memberships: readonly InstitutionStaffScopeMembership[]): Promise<readonly Record<string, unknown>[]> {
    const units = await loadUnits(this.db, institutionId);
    const nodes = tree(units);
    const resolved = await withTeachingAssignments(this.db, institutionId, memberships);
    const audiences: Record<string, unknown>[] = [];
    if (institutionAnnouncementSender(resolved, nodes, null)) audiences.push({ unitId: null, kind: 'INSTITUTION', name: null });
    for (const unit of units) {
      if (institutionAnnouncementSender(resolved, nodes, unit.id)) audiences.push({ unitId: unit.id, kind: unit.kind, name: unit.name });
    }
    return audiences;
  }
}

function senderContext(request: ProtectedHttpRequest, institutionId: string) {
  const context = requireTrustedAuthorization(request);
  const id = requireUuid(institutionId, context.correlationId);
  const memberships = institutionStaffScopeMemberships(request, id, senderRoles);
  if (memberships.length === 0) throw forbidden(context.correlationId);
  return { context, id, memberships };
}

async function loadUnits(db: PersistenceDb, institutionId: string): Promise<readonly UnitRow[]> {
  const rows = await db.execute(sql`
    SELECT id, kind::text AS kind, name, parent_unit_id FROM institution_units
    WHERE institution_id = ${institutionId}::uuid
    ORDER BY kind, name, id
  `) as Rows<UnitRow>;
  return rows.rows;
}

function tree(units: readonly UnitRow[]): readonly InstitutionUnitNode[] {
  return units.map((unit) => ({ id: unit.id, parentUnitId: unit.parent_unit_id }));
}

function announcementSelect(institutionId: string) {
  return sql`
    SELECT a.id, a.sender_user_id, a.sender_role, a.audience_kind, a.audience_unit_id, unit.name AS audience_name, a.title, a.body, a.channels,
           a.state, a.scheduled_for, a.sent_at, a.recipient_count, a.cancelled_at, a.cancel_reason_code, a.created_at, a.created_at::text AS created_key,
           (SELECT jsonb_object_agg(email_state, total) FROM (
              SELECT email_state, count(*)::int AS total FROM institution_announcement_recipients r
              WHERE r.announcement_id = a.id GROUP BY email_state) states) AS email_states
    FROM institution_announcements a
    LEFT JOIN institution_units unit ON unit.id = a.audience_unit_id
    WHERE a.institution_id = ${institutionId}::uuid`;
}

function mapAnnouncement(row: AnnouncementRow, callerUserId: string): Record<string, unknown> {
  const email = row.email_states ?? {};
  const count = (state: string) => Number(email[state] ?? 0);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    audience: { kind: row.audience_kind, unitId: row.audience_unit_id, name: row.audience_name },
    channels: row.channels,
    state: row.state,
    senderRole: row.sender_role,
    sentByMe: row.sender_user_id === callerUserId,
    scheduledFor: iso(row.scheduled_for),
    sentAt: iso(row.sent_at),
    cancelledAt: iso(row.cancelled_at),
    cancelReasonCode: row.cancel_reason_code,
    createdAt: iso(row.created_at),
    delivery: row.state === 'SENT' ? {
      recipients: row.recipient_count ?? 0,
      email: {
        sent: count('SENT'), notConfigured: count('NOT_CONFIGURED'), failed: count('FAILED'), bounced: count('BOUNCED'),
        skipped: count('SKIPPED'), pending: count('PENDING') + count('SENDING'),
      },
    } : null,
  };
}

function readCreateInput(body: unknown, correlationId: string): {
  title: string; body: string; audienceUnitId: string | null; channels: readonly string[]; scheduledFor: string | null;
} {
  const source = readBody(body, createFields, correlationId);
  const text = (field: string, max: number): string => {
    const value = source[field];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid('INVALID_ANNOUNCEMENT', correlationId, field);
    return value.trim();
  };
  const audience = source.audienceUnitId;
  if (audience !== null && audience !== undefined && (typeof audience !== 'string' || !uuidPattern.test(audience))) throw invalid('INVALID_AUDIENCE', correlationId, 'audienceUnitId');
  if (audience === undefined) throw invalid('INVALID_AUDIENCE', correlationId, 'audienceUnitId');
  const channels = source.channels === undefined ? ['IN_APP'] : source.channels;
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > channelNames.length
    || channels.some((channel) => !(channelNames as readonly unknown[]).includes(channel))
    || new Set(channels).size !== channels.length || !channels.includes('IN_APP')) {
    throw invalid('INVALID_CHANNELS', correlationId, 'channels');
  }
  const scheduled = source.scheduledFor;
  if (scheduled !== undefined && scheduled !== null && (typeof scheduled !== 'string' || !isoPattern.test(scheduled) || Number.isNaN(Date.parse(scheduled)))) {
    throw invalid('INVALID_SCHEDULE', correlationId, 'scheduledFor');
  }
  return {
    title: text('title', 160),
    body: text('body', 500),
    audienceUnitId: audience === null ? null : (audience as string).toLowerCase(),
    channels: channelNames.filter((channel) => (channels as unknown[]).includes(channel)),
    scheduledFor: typeof scheduled === 'string' ? scheduled : null,
  };
}

function readBody(body: unknown, allowed: ReadonlySet<string>, correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('INVALID_REQUEST', correlationId);
  const source = body as Record<string, unknown>;
  const unknownField = Object.keys(source).find((key) => !allowed.has(key));
  if (unknownField) throw invalid('UNKNOWN_FIELD', correlationId, unknownField);
  return source;
}

function readLimit(value: string | undefined, correlationId: string): number {
  if (value === undefined || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('INVALID_QUERY', correlationId, 'limit');
  return limit;
}

function readCursor(value: string | undefined, correlationId: string): [string, string] | null {
  if (value === undefined || value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && parsed[0].length <= 200
      && typeof parsed[1] === 'string' && uuidPattern.test(parsed[1])) return [parsed[0], parsed[1]];
  } catch { /* fall through */ }
  throw invalid('INVALID_QUERY', correlationId, 'cursor');
}

function encodeCursor(value: readonly [string, string]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function requireUuid(value: string, correlationId: string): string {
  if (!uuidPattern.test(value)) throw forbidden(correlationId);
  return value.toLowerCase();
}

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function errorBody(code: string, correlationId: string, field?: string) {
  return { error: { code, message: 'Request could not be completed', correlationId, ...(field ? { field } : {}) } };
}

function invalid(code: string, correlationId: string, field?: string): BadRequestException {
  return new BadRequestException(errorBody(code, correlationId, field));
}

function forbidden(correlationId: string): ForbiddenException {
  return new ForbiddenException(safeError('FORBIDDEN', correlationId));
}

async function writeAudit(db: PersistenceDb, input: { id: string; actorUserId: string; action: string; resourceId: string; organizationId: string; correlationId: string; context: Record<string, unknown> }): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${input.id}::uuid, ${input.actorUserId}::uuid, ${input.action}, 'institution_announcement', ${input.resourceId}, ${input.organizationId}::uuid, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}
