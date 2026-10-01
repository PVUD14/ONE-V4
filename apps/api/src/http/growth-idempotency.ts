/**
 * Idempotent growth writes (GROWTH-06; growth-field-work-table-design.md §5).
 *
 * Why this exists: field staff write from phones on poor networks, and the phone's offline queue
 * replays every write until it gets an answer. A retried send must land once — one row, one audit
 * row, one outbox event — and answer with what the first send produced. The existing
 * `idempotency_records` table (0001) already holds `(scope, key)` unique with the request's hash and
 * the resource it produced; this records a growth write there **inside the write's own
 * transaction**, so a refusal leaves no record and a success cannot commit without one.
 *
 * Two copies in flight at once: the second blocks on the unique index until the first commits,
 * then finds it SUCCEEDED and replays. The same key with a different body is refused (422).
 */
import { createHash } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';
import { badRequest, domainError, type QueryResult } from './growth-http.js';

type Runner = Pick<PersistenceDb, 'execute'>;

const keyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

/** The Idempotency-Key header; required on field writes, optional on the lead create. Malformed is always refused. */
export function readGrowthIdempotencyKey(value: string | readonly string[] | undefined, correlationId: string, required: boolean): string | null {
  const key = typeof value === 'string' ? value : Array.isArray(value) && value.length === 1 ? value[0] : undefined;
  if (key === undefined || key === '') {
    if (required) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', correlationId);
    return null;
  }
  if (typeof key !== 'string' || !keyPattern.test(key)) throw badRequest('IDEMPOTENCY_KEY_INVALID', correlationId);
  return key;
}

/** JSON with object keys sorted at every depth, so the same request always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function growthRequestHash(route: string, target: string, body: unknown): string {
  return createHash('sha256').update(`${route}|${target}|${canonicalJson(body)}`).digest('hex');
}

export interface GrowthIdempotentWrite {
  readonly userId: string;
  /** A stable name for the route (`activity.log`), part of the scope so a key cannot replay another kind of write. */
  readonly route: string;
  /** The path parameter the write targets (a lead or follow-up id), part of the hash. */
  readonly target: string;
  readonly key: string | null;
  readonly body: unknown;
  readonly recordId: string;
  readonly correlationId: string;
}

/**
 * Runs `write` once per key. Returns the resource id and whether this was a replay. Must be
 * called inside the transaction that performs the write.
 */
export async function runGrowthIdempotent(
  tx: Runner,
  input: GrowthIdempotentWrite,
  resourceType: string,
  write: () => Promise<string>,
): Promise<{ readonly resourceId: string; readonly replay: boolean }> {
  if (!input.key) return { resourceId: await write(), replay: false };
  const scope = `growth:${input.userId}:${input.route}`;
  const hash = growthRequestHash(input.route, input.target, input.body);
  const recorded = await tx.execute(sql`
    INSERT INTO idempotency_records (id, scope, key, request_hash, status)
    VALUES (${input.recordId}::uuid, ${scope}, ${input.key}, ${hash}, 'STARTED')
    ON CONFLICT (scope, key) DO UPDATE SET updated_at = idempotency_records.updated_at
    RETURNING id, request_hash, status, response_resource_type, response_resource_id
  `) as QueryResult<{ id: string; request_hash: string; status: string; response_resource_type: string | null; response_resource_id: string | null }>;
  const row = recorded.rows[0];
  if (!row) throw badRequest('IDEMPOTENCY_UNAVAILABLE', input.correlationId);
  if (row.request_hash !== hash) {
    throw new HttpException(domainError('IDEMPOTENCY_KEY_REUSED', input.correlationId), HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (row.id !== input.recordId) {
    if (row.status === 'SUCCEEDED' && row.response_resource_type === resourceType && row.response_resource_id) {
      return { resourceId: row.response_resource_id, replay: true };
    }
    throw new HttpException(domainError('IDEMPOTENCY_IN_PROGRESS', input.correlationId), HttpStatus.CONFLICT);
  }
  const resourceId = await write();
  await tx.execute(sql`
    UPDATE idempotency_records SET status = 'SUCCEEDED', response_resource_type = ${resourceType}, response_resource_id = ${resourceId}, updated_at = now()
    WHERE id = ${input.recordId}::uuid
  `);
  return { resourceId, replay: false };
}
