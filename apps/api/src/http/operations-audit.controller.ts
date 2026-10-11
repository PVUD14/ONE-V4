/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-08
 * Agent-assisted: yes (Claude) · Reviewed: pending
 */
import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
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

/** Bounded so an investigation cannot turn into a table scan against the transactional database. */
const defaultLimit = 50;
const maxLimit = 200;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Audit and security event search for authorized platform roles (acceptance 124,
 * platform control 102).
 *
 * Read-only by construction: there is no write path here and audit rows are never
 * mutated, so the search cannot become a way to edit the record it exists to prove.
 *
 * Results are keyset-paginated on (occurred_at, id) rather than OFFSET, so paging
 * stays stable and cheap as the table grows and while new events arrive mid-page.
 */
@Controller('/api/v1/operations')
export class OperationsAuditController {
  constructor(@Inject(API_PERSISTENCE_DB) private readonly db: PersistenceDb) {}

  @Get('/audit-events')
  @UseGuards(ProtectedApiAuthenticationGuard)
  async search(@Req() request: ProtectedHttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const context = requireTrustedAuthorization(request);
    // OPS-01: SECURITY_AUDIT_SEARCH, baseline for all three platform roles as before.
    const permitted = await callerHasInternalCapability(context.authorization, dbCapabilityGrantLoader(this.db), 'SECURITY_AUDIT_SEARCH');
    if (!permitted) throw new ForbiddenException(safeError('FORBIDDEN', context.correlationId));

    const filters = readFilters(query, context.correlationId);
    const conditions: SQL[] = [];
    if (filters.actorUserId) conditions.push(sql`actor_user_id = ${filters.actorUserId}::uuid`);
    if (filters.organizationId) conditions.push(sql`organization_id = ${filters.organizationId}::uuid`);
    if (filters.outcome) conditions.push(sql`outcome = ${filters.outcome}`);
    if (filters.correlationId) conditions.push(sql`correlation_id = ${filters.correlationId}`);
    if (filters.resourceType) conditions.push(sql`resource_type = ${filters.resourceType}`);
    if (filters.resourceId) conditions.push(sql`resource_id = ${filters.resourceId}`);
    // Prefix rather than a wrapped LIKE: actions are dotted names such as
    // 'institution.roster_import.committed', so a prefix is what an investigator wants
    // and it stays index-friendly.
    if (filters.action) conditions.push(sql`action LIKE ${filters.action + '%'}`);
    if (filters.from) conditions.push(sql`occurred_at >= ${filters.from}::timestamptz`);
    if (filters.to) conditions.push(sql`occurred_at <= ${filters.to}::timestamptz`);
    if (filters.cursor) {
      conditions.push(sql`(occurred_at, id) < (${filters.cursor.occurredAt}::timestamptz, ${filters.cursor.id}::uuid)`);
    }

    const where = conditions.length
      ? conditions.reduce((left, right) => sql`${left} AND ${right}`)
      : sql`true`;

    const rows = await this.db.execute(sql`
      SELECT id, actor_user_id, action, resource_type, resource_id, organization_id,
             outcome, correlation_id, occurred_at, context
      FROM audit_events
      WHERE ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${filters.limit + 1}
    `) as QueryResult<Record<string, unknown>>;

    const page = rows.rows.slice(0, filters.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.rows.length > filters.limit && last
      ? encodeCursor(String(last.occurred_at instanceof Date ? last.occurred_at.toISOString() : last.occurred_at), String(last.id))
      : null;

    return {
      events: page.map(mapAuditRow),
      nextCursor,
      correlationId: context.correlationId,
    };
  }
}

interface AuditFilters {
  readonly actorUserId?: string;
  readonly organizationId?: string;
  readonly outcome?: string;
  readonly correlationId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly action?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: { readonly occurredAt: string; readonly id: string };
}

function readFilters(query: Record<string, unknown>, correlationId: string): AuditFilters {
  return {
    ...optionalUuid(query.actorUserId, 'actorUserId', correlationId),
    ...optionalUuid(query.organizationId, 'organizationId', correlationId),
    ...optionalEnum(query.outcome, 'outcome', ['SUCCESS', 'DENIED'], correlationId),
    ...optionalText(query.correlationId, 'correlationId', 200, correlationId),
    ...optionalText(query.resourceType, 'resourceType', 200, correlationId),
    ...optionalText(query.resourceId, 'resourceId', 200, correlationId),
    ...optionalText(query.action, 'action', 200, correlationId),
    ...optionalTimestamp(query.from, 'from', correlationId),
    ...optionalTimestamp(query.to, 'to', correlationId),
    limit: readLimit(query.limit, correlationId),
    ...decodeCursor(query.cursor, correlationId),
  };
}

function badRequest(code: string, correlationId: string): BadRequestException {
  return new BadRequestException({ error: { code, correlationId } });
}

function optionalUuid(value: unknown, field: 'actorUserId' | 'organizationId', correlationId: string): Partial<AuditFilters> {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest('AUDIT_FILTER_INVALID', correlationId);
  return { [field]: value };
}

function optionalEnum(value: unknown, field: 'outcome', allowed: readonly string[], correlationId: string): Partial<AuditFilters> {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('AUDIT_FILTER_INVALID', correlationId);
  return { [field]: value };
}

function optionalText(
  value: unknown,
  field: 'correlationId' | 'resourceType' | 'resourceId' | 'action',
  max: number,
  correlationId: string,
): Partial<AuditFilters> {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string' || value.length > max) throw badRequest('AUDIT_FILTER_INVALID', correlationId);
  return { [field]: value };
}

function optionalTimestamp(value: unknown, field: 'from' | 'to', correlationId: string): Partial<AuditFilters> {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw badRequest('AUDIT_FILTER_INVALID', correlationId);
  return { [field]: new Date(value).toISOString() };
}

function readLimit(value: unknown, correlationId: string): number {
  if (value === undefined || value === '') return defaultLimit;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) throw badRequest('AUDIT_LIMIT_INVALID', correlationId);
  return parsed;
}

/** Opaque to the caller, but deliberately not encrypted: it carries no secret, only a position. */
function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(occurredAt + '|' + id, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, correlationId: string): Partial<AuditFilters> {
  if (value === undefined || value === '') return {};
  if (typeof value !== 'string') throw badRequest('AUDIT_CURSOR_INVALID', correlationId);
  const [occurredAt, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (!occurredAt || !id || rest.length || Number.isNaN(Date.parse(occurredAt)) || !uuidPattern.test(id)) {
    throw badRequest('AUDIT_CURSOR_INVALID', correlationId);
  }
  return { cursor: { occurredAt, id } };
}

function mapAuditRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    organizationId: row.organization_id ?? null,
    outcome: row.outcome,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    context: row.context ?? {},
  };
}
