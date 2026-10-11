/**
 * Shared request helpers for the growth controllers (GROWTH-02 onward).
 *
 * Why this exists: every growth write is one transaction with its audit row and outbox event,
 * every refusal is a domain code with no driver text, and every body is read against an exact
 * list of fields. Writing those once keeps the territory, lead and contact controllers from
 * drifting apart. (GROWTH-01's team controller keeps its own copies; it is not rewritten here.)
 */
import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { validateOutboxWriteInput, type PersistenceDb } from '@planthepath/persistence/src/repositories.js';

export type QueryResult<T> = { rows: T[] };

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function domainError(code: string, correlationId: string, extra: Record<string, unknown> = {}): { readonly error: Record<string, unknown> } {
  return { error: { code, message: 'The request could not be completed.', correlationId, ...extra } };
}

export const badRequest = (code: string, correlationId: string, extra?: Record<string, unknown>): BadRequestException =>
  new BadRequestException(domainError(code, correlationId, extra));
export const conflict = (code: string, correlationId: string, extra?: Record<string, unknown>): ConflictException =>
  new ConflictException(domainError(code, correlationId, extra));
export const notFound = (code: string, correlationId: string): NotFoundException => new NotFoundException(domainError(code, correlationId));
export const forbidden = (code: string, correlationId: string): ForbiddenException => new ForbiddenException(domainError(code, correlationId));

export function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function readObject(body: unknown, allowed: readonly string[], correlationId: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('INVALID_REQUEST', correlationId);
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw badRequest('INVALID_REQUEST', correlationId);
  return raw;
}

export function readUuid(value: unknown, correlationId: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw badRequest('INVALID_REQUEST', correlationId);
  return value.toLowerCase();
}

export function readReason(value: unknown, allowed: readonly string[], correlationId: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw badRequest('REASON_CODE_INVALID', correlationId);
  return value;
}

/** The text of a database error, for mapping trigger refusals to domain codes. Never sent on. */
export function databaseErrorText(error: unknown): { readonly code: string | undefined; readonly message: string } {
  const value = error as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  return { code: value?.code ?? value?.cause?.code, message: `${value?.message ?? ''} ${value?.cause?.message ?? ''}` };
}

/**
 * HTTP refusals pass through; a database refusal named in `messages` (substring → code) or a
 * unique violation becomes a 409; anything else is a plain 400 with no driver text.
 */
export function mapGrowthWriteError(error: unknown, correlationId: string, options: { readonly unique?: string; readonly messages?: Readonly<Record<string, string>> } = {}): HttpException {
  if (error instanceof HttpException) return error;
  const { code, message } = databaseErrorText(error);
  for (const [fragment, domain] of Object.entries(options.messages ?? {})) {
    if (message.includes(fragment)) return conflict(domain, correlationId);
  }
  if (code === '23505') return conflict(options.unique ?? 'GROWTH_CHANGE_CONFLICT', correlationId);
  return badRequest('GROWTH_CHANGE_REJECTED', correlationId);
}

type Runner = Pick<PersistenceDb, 'execute'>;

export async function writeGrowthAudit(tx: Runner, input: {
  readonly id: string; readonly actorUserId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly organizationId: string | null; readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${input.id}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId}, ${input.organizationId}::uuid, 'SUCCESS',
            ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

export async function writeGrowthOutbox(tx: Runner, input: {
  readonly id: string; readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
  readonly actorUserId: string; readonly organizationId: string | null; readonly correlationId: string;
}): Promise<void> {
  const { organizationId, ...rest } = input;
  validateOutboxWriteInput({ ...rest, eventVersion: 1, ...(organizationId ? { organizationId } : {}) });
  await tx.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, organization_id, correlation_id)
    VALUES (${input.id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actorUserId}::uuid, ${input.organizationId}::uuid, ${input.correlationId})
  `);
}

/** The ONE platform organisation: growth records are audited against it. */
export async function platformOrganizationId(runner: Runner): Promise<string | null> {
  const found = await runner.execute(sql`SELECT id FROM organizations WHERE kind = 'PLATFORM' ORDER BY created_at, id LIMIT 1`) as QueryResult<{ id: string }>;
  return found.rows[0]?.id ?? null;
}
