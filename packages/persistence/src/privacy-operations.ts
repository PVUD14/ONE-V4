/**
 * Reads behind the Security → Privacy and consent console (OPS-06).
 *
 * The request queue (keyset paginated on requested_at, id), one request's state history,
 * the legal holds with whatever release request is in flight for each, and consent
 * coverage per consent key. Subjects leave this module as a user id and a masked email
 * only; the free-text reason a person typed when asking for deletion never leaves it.
 *
 * Consent coverage is an aggregate of people, so every count goes through
 * `suppressSmallCount` here, before it can reach a controller: a count below 5 is returned
 * without its value. Counts are given only for a LIVE definition. A key with no live
 * version, or one of the engine purposes whose definitions are not published yet (hard
 * gate HG-6), has no coverage to report, and says so instead of reporting 0.
 *
 * No table is added for this: everything read here already exists (0009, 0014, 0028,
 * 0038). Writes stay in the controller, as before.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { maskEmail, suppressSmallCount, type SuppressedCount } from '@planthepath/authorization/src/index.js';
import { engineConsentPurposes } from './consent-purposes.js';
import { validateAuditWriteInput } from './repositories.js';

/** A drizzle database or transaction. */
export interface PrivacySqlRunner {
  execute(query: SQL): Promise<unknown>;
}

async function rows<T>(runner: PrivacySqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as { rows: T[] }).rows;
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());
/** Postgres renders timestamptz with microseconds this way; the cursor needs all six digits. */
const microsecondText = (column: SQL): SQL => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const privacyRequestTypes = ['EXPORT', 'DELETION'] as const;
export type PrivacyOperationsRequestType = (typeof privacyRequestTypes)[number];
export const privacyRequestStates = ['RECEIVED', 'IN_PROGRESS', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED'] as const;
export type PrivacyOperationsRequestState = (typeof privacyRequestStates)[number];
/** The queue's views: the open states, the closed ones, everything, or one state. */
export const privacyRequestViews = ['OPEN', 'CLOSED', 'ALL', ...privacyRequestStates] as const;
export type PrivacyRequestView = (typeof privacyRequestViews)[number];

// ---------------------------------------------------------------------------
// The request queue
// ---------------------------------------------------------------------------

export interface PrivacyRequestSubject {
  readonly userId: string;
  readonly maskedEmail: string | null;
  /** The person was erased: the masked value is the placeholder identity, not theirs. */
  readonly erased: boolean;
}

export interface PrivacyRequestRow {
  readonly id: string;
  /** Read out on the phone; derived from the id, never a second identifier. */
  readonly reference: string;
  readonly requestType: PrivacyOperationsRequestType;
  readonly state: PrivacyOperationsRequestState;
  readonly subject: PrivacyRequestSubject;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  /** Deletion only: when the erasure is scheduled to run (the 30-day grace period). */
  readonly deletionScheduledFor: string | null;
  /** Export only: when the produced bundle stops being downloadable. */
  readonly exportExpiresAt: string | null;
  readonly rejectionReasonCode: string | null;
  readonly updatedAt: string;
  readonly activeHolds: number;
}

export interface PrivacyRequestCursor { readonly requestedAt: string; readonly id: string }

export function privacyRequestReference(id: string): string {
  return `PR-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

interface RequestDbRow {
  id: string; request_type: PrivacyOperationsRequestType; state: PrivacyOperationsRequestState; subject_user_id: string;
  subject_email: string | null; subject_anonymised_at: unknown; requested_at: string; started_at: unknown; completed_at: unknown;
  cancelled_at: unknown; deletion_scheduled_for: unknown; export_expires_at: unknown; rejection_reason_code: string | null;
  updated_at: unknown; active_holds: number;
}

const requestSelect = sql`
  SELECT r.id, r.request_type, r.state, r.subject_user_id, u.email AS subject_email, u.anonymised_at AS subject_anonymised_at,
         ${microsecondText(sql`r.requested_at`)} AS requested_at,
         r.started_at, r.completed_at, r.cancelled_at, r.deletion_scheduled_for, r.export_expires_at,
         r.rejection_reason_code, r.updated_at,
         (SELECT count(*)::int FROM data_retention_holds h
           WHERE h.subject_user_id = r.subject_user_id AND h.released_at IS NULL) AS active_holds
  FROM privacy_requests r
  JOIN users u ON u.id = r.subject_user_id`;

function mapRequest(row: RequestDbRow): PrivacyRequestRow {
  return {
    id: row.id,
    reference: privacyRequestReference(row.id),
    requestType: row.request_type,
    state: row.state,
    subject: { userId: row.subject_user_id, maskedEmail: maskEmail(row.subject_email), erased: row.subject_anonymised_at !== null },
    requestedAt: row.requested_at,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
    deletionScheduledFor: iso(row.deletion_scheduled_for),
    exportExpiresAt: iso(row.export_expires_at),
    rejectionReasonCode: row.rejection_reason_code,
    updatedAt: iso(row.updated_at) ?? row.requested_at,
    activeHolds: Number(row.active_holds),
  };
}

function viewFilter(view: PrivacyRequestView): SQL {
  if (view === 'ALL') return sql`TRUE`;
  if (view === 'OPEN') return sql`r.state IN ('RECEIVED', 'IN_PROGRESS', 'READY')`;
  if (view === 'CLOSED') return sql`r.state IN ('COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED')`;
  return sql`r.state = ${view}`;
}

/** The queue, newest first, keyset paginated on (requested_at, id). */
export async function listPrivacyRequests(runner: PrivacySqlRunner, input: {
  readonly view: PrivacyRequestView; readonly requestType?: PrivacyOperationsRequestType; readonly limit: number; readonly cursor?: PrivacyRequestCursor;
}): Promise<{ readonly requests: readonly PrivacyRequestRow[]; readonly nextCursor: PrivacyRequestCursor | null }> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) throw new RangeError('limit must be an integer from 1 to 200');
  const found = await rows<RequestDbRow>(runner, sql`
    ${requestSelect}
    WHERE ${viewFilter(input.view)}
      AND (${input.requestType ?? null}::text IS NULL OR r.request_type = ${input.requestType ?? null})
      AND (${input.cursor?.requestedAt ?? null}::timestamptz IS NULL
           OR (r.requested_at, r.id) < (${input.cursor?.requestedAt ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
    ORDER BY r.requested_at DESC, r.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = found.slice(0, input.limit).map(mapRequest);
  const last = page[page.length - 1];
  return { requests: page, nextCursor: found.length > input.limit && last ? { requestedAt: last.requestedAt, id: last.id } : null };
}

export function encodePrivacyRequestCursor(cursor: PrivacyRequestCursor): string {
  return Buffer.from(JSON.stringify({ r: cursor.requestedAt, i: cursor.id }), 'utf8').toString('base64url');
}

export function decodePrivacyRequestCursor(raw: string): PrivacyRequestCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { r?: unknown; i?: unknown };
    if (typeof parsed.r !== 'string' || typeof parsed.i !== 'string') return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.i)) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.r)) return null;
    return { requestedAt: parsed.r, id: parsed.i };
  } catch {
    return null;
  }
}

export interface PrivacyQueueSummary {
  readonly open: { readonly EXPORT: number; readonly DELETION: number };
  /** Open deletions whose erasure is scheduled within the next 7 days (and not yet past). */
  readonly deletionsDueWithinSevenDays: number;
  /** Open deletions whose scheduled erasure has passed without completing. */
  readonly deletionsPastSchedule: number;
  readonly failed: number;
  readonly activeHolds: number;
  /** Release requests pending a decision or approved and not yet carried out. */
  readonly releasesInFlight: number;
}

/** Queue counts in SQL. Operational counts of requests, not of people: no suppression. */
export async function summarisePrivacyQueue(runner: PrivacySqlRunner): Promise<PrivacyQueueSummary> {
  const [row] = await rows<Record<string, number>>(runner, sql`
    SELECT
      (SELECT count(*)::int FROM privacy_requests WHERE request_type = 'EXPORT' AND state IN ('RECEIVED','IN_PROGRESS','READY')) AS open_export,
      (SELECT count(*)::int FROM privacy_requests WHERE request_type = 'DELETION' AND state IN ('RECEIVED','IN_PROGRESS','READY')) AS open_deletion,
      (SELECT count(*)::int FROM privacy_requests WHERE request_type = 'DELETION' AND state IN ('RECEIVED','IN_PROGRESS')
         AND deletion_scheduled_for >= now() AND deletion_scheduled_for < now() + interval '7 days') AS due_soon,
      (SELECT count(*)::int FROM privacy_requests WHERE request_type = 'DELETION' AND state IN ('RECEIVED','IN_PROGRESS')
         AND deletion_scheduled_for < now()) AS past_schedule,
      (SELECT count(*)::int FROM privacy_requests WHERE state = 'FAILED') AS failed,
      (SELECT count(*)::int FROM data_retention_holds WHERE released_at IS NULL) AS active_holds,
      (SELECT count(*)::int FROM operation_approvals WHERE action_key = 'PRIVACY_HOLD_RELEASE'
         AND state IN ('PENDING','APPROVED') AND expires_at > now()) AS releases_in_flight
  `);
  return {
    open: { EXPORT: Number(row?.open_export ?? 0), DELETION: Number(row?.open_deletion ?? 0) },
    deletionsDueWithinSevenDays: Number(row?.due_soon ?? 0),
    deletionsPastSchedule: Number(row?.past_schedule ?? 0),
    failed: Number(row?.failed ?? 0),
    activeHolds: Number(row?.active_holds ?? 0),
    releasesInFlight: Number(row?.releases_in_flight ?? 0),
  };
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

export interface PrivacyRequestHistoryEntry {
  readonly fromState: PrivacyOperationsRequestState | null;
  readonly toState: PrivacyOperationsRequestState;
  /** SUBJECT, SYSTEM or OPERATIONS: who moved it, never which person. */
  readonly actorRole: string | null;
  readonly occurredAt: string;
}

export interface PrivacyDeletionOutcome {
  readonly category: string;
  readonly disposition: string;
  readonly basis: string | null;
  readonly recordCount: number | null;
  readonly occurredAt: string;
}

export interface PrivacyRequestDetail extends PrivacyRequestRow {
  readonly history: readonly PrivacyRequestHistoryEntry[];
  readonly deletionOutcome: readonly PrivacyDeletionOutcome[];
  readonly holds: readonly { readonly id: string; readonly reasonCode: string; readonly placedAt: string }[];
}

export async function loadPrivacyRequestDetail(runner: PrivacySqlRunner, requestId: string): Promise<PrivacyRequestDetail | null> {
  const [row] = await rows<RequestDbRow>(runner, sql`${requestSelect} WHERE r.id = ${requestId}::uuid`);
  if (!row) return null;
  const request = mapRequest(row);
  const history = await rows<{ from_state: PrivacyOperationsRequestState | null; to_state: PrivacyOperationsRequestState; actor_role: string | null; occurred_at: unknown }>(runner, sql`
    SELECT from_state, to_state, actor_role, occurred_at FROM privacy_request_events
    WHERE request_id = ${requestId}::uuid
    ORDER BY occurred_at ASC, id ASC
    LIMIT 200
  `);
  const outcome = await rows<{ category: string; disposition: string; basis: string | null; record_count: number | null; occurred_at: unknown }>(runner, sql`
    SELECT category, disposition, basis, record_count, occurred_at FROM privacy_deletion_records
    WHERE request_id = ${requestId}::uuid
    ORDER BY category
  `);
  const holds = await rows<{ id: string; reason_code: string; placed_at: unknown }>(runner, sql`
    SELECT id, reason_code, placed_at FROM data_retention_holds
    WHERE subject_user_id = ${row.subject_user_id}::uuid AND released_at IS NULL
    ORDER BY placed_at DESC
    LIMIT 50
  `);
  return {
    ...request,
    history: history.map((entry) => ({ fromState: entry.from_state, toState: entry.to_state, actorRole: entry.actor_role, occurredAt: iso(entry.occurred_at) ?? '' })),
    deletionOutcome: outcome.map((entry) => ({
      category: entry.category, disposition: entry.disposition, basis: entry.basis,
      recordCount: entry.record_count === null ? null : Number(entry.record_count), occurredAt: iso(entry.occurred_at) ?? '',
    })),
    holds: holds.map((hold) => ({ id: hold.id, reasonCode: hold.reason_code, placedAt: iso(hold.placed_at) ?? '' })),
  };
}

/**
 * Audit a read of a privacy request (§5.2: `*.viewed`). Written on its own: a read has no
 * transaction to join, and a failure to audit fails the read.
 */
export async function recordPrivacyRequestViewed(runner: PrivacySqlRunner, input: {
  readonly actorUserId: string; readonly requestId: string; readonly correlationId: string;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actorUserId, action: 'operations.privacy_request.viewed', resourceType: 'privacy_request', resourceId: input.requestId, correlationId: input.correlationId });
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actorUserId}::uuid, 'operations.privacy_request.viewed', 'privacy_request', ${input.requestId},
            NULL, 'SUCCESS', ${input.correlationId}, '{}'::jsonb)
  `);
}

// ---------------------------------------------------------------------------
// Legal holds
// ---------------------------------------------------------------------------

export interface RetentionHoldRow {
  readonly id: string;
  readonly reasonCode: string;
  /** Operator-written context, kept to the justification; the screen says not to put personal data in it. */
  readonly detail: string | null;
  readonly subject: PrivacyRequestSubject;
  readonly placedAt: string;
  readonly placedBy: { readonly email: string };
  /** The subject's open deletion, which this hold keeps from completing. */
  readonly openDeletion: { readonly requestId: string; readonly reference: string; readonly scheduledFor: string | null } | null;
  /** A release filed through the approvals queue and not yet carried out, or expired. */
  readonly releaseRequest: { readonly state: 'PENDING' | 'APPROVED'; readonly expiresAt: string; readonly requestedBy: { readonly email: string } } | null;
}

/** Active holds, newest first. Bounded at 200; `capped` says when more exist. */
export async function listActiveRetentionHolds(runner: PrivacySqlRunner): Promise<{ readonly holds: readonly RetentionHoldRow[]; readonly capped: boolean }> {
  const found = await rows<Record<string, unknown>>(runner, sql`
    SELECT h.id, h.reason_code, h.detail, h.subject_user_id, su.email AS subject_email, su.anonymised_at AS subject_anonymised_at,
           h.placed_at, pu.email AS placed_by_email,
           d.id AS deletion_id, d.deletion_scheduled_for,
           a.state AS release_state, a.expires_at AS release_expires_at, au.email AS release_requested_by_email
    FROM data_retention_holds h
    JOIN users su ON su.id = h.subject_user_id
    JOIN users pu ON pu.id = h.placed_by_user_id
    LEFT JOIN LATERAL (
      SELECT r.id, r.deletion_scheduled_for FROM privacy_requests r
      WHERE r.subject_user_id = h.subject_user_id AND r.request_type = 'DELETION' AND r.state IN ('RECEIVED','IN_PROGRESS','READY')
      ORDER BY r.requested_at DESC LIMIT 1
    ) d ON TRUE
    LEFT JOIN LATERAL (
      SELECT oa.state, oa.expires_at, oa.requested_by_user_id FROM operation_approvals oa
      WHERE oa.action_key = 'PRIVACY_HOLD_RELEASE' AND oa.target_type = 'data_retention_hold' AND oa.target_id = h.id::text
        AND oa.state IN ('PENDING','APPROVED') AND oa.expires_at > now()
      ORDER BY oa.requested_at DESC LIMIT 1
    ) a ON TRUE
    LEFT JOIN users au ON au.id = a.requested_by_user_id
    WHERE h.released_at IS NULL
    ORDER BY h.placed_at DESC, h.id DESC
    LIMIT 201
  `);
  const holds = found.slice(0, 200).map((row): RetentionHoldRow => ({
    id: String(row.id),
    reasonCode: String(row.reason_code),
    detail: row.detail === null ? null : String(row.detail),
    subject: { userId: String(row.subject_user_id), maskedEmail: maskEmail(row.subject_email as string | null), erased: row.subject_anonymised_at !== null },
    placedAt: iso(row.placed_at) ?? '',
    placedBy: { email: String(row.placed_by_email) },
    openDeletion: row.deletion_id
      ? { requestId: String(row.deletion_id), reference: privacyRequestReference(String(row.deletion_id)), scheduledFor: iso(row.deletion_scheduled_for) }
      : null,
    releaseRequest: row.release_state
      ? { state: row.release_state as 'PENDING' | 'APPROVED', expiresAt: iso(row.release_expires_at) ?? '', requestedBy: { email: String(row.release_requested_by_email) } }
      : null,
  }));
  return { holds, capped: found.length > 200 };
}

/** Whether a hold may be placed on this person: they exist and have not been erased. */
export async function retentionHoldSubjectState(runner: PrivacySqlRunner, userId: string): Promise<'ACTIVE' | 'ERASED' | 'NOT_FOUND'> {
  const [row] = await rows<{ anonymised_at: unknown }>(runner, sql`SELECT anonymised_at FROM users WHERE id = ${userId}::uuid`);
  if (!row) return 'NOT_FOUND';
  return row.anonymised_at === null ? 'ACTIVE' : 'ERASED';
}

// ---------------------------------------------------------------------------
// Consent coverage
// ---------------------------------------------------------------------------

export type ConsentDefinitionStatus = 'LIVE' | 'SCHEDULED' | 'RETIRED';

export interface ConsentDefinitionRow {
  readonly consentKey: string;
  readonly version: string;
  readonly title: string;
  readonly enforcement: 'BLOCKING' | 'OPTIONAL';
  readonly withdrawable: boolean;
  readonly documentRef: string | null;
  readonly effectiveFrom: string;
  readonly retiredAt: string | null;
  readonly status: ConsentDefinitionStatus;
}

/**
 * LIVE: a current version is in force and the counts are real.
 * NO_LIVE_VERSION: the key has definitions, but none is in force (retired or not yet effective).
 * NOT_PUBLISHED: an engine purpose whose definition has not been published (HG-6).
 */
export type ConsentKeyStatus = 'LIVE' | 'NO_LIVE_VERSION' | 'NOT_PUBLISHED';

export interface ConsentKeyCoverage {
  readonly consentKey: string;
  readonly status: ConsentKeyStatus;
  readonly liveVersion: string | null;
  readonly title: string | null;
  readonly enforcement: 'BLOCKING' | 'OPTIONAL' | null;
  /**
   * People, by where their latest record for this key stands. The three cells partition
   * the people with any record for the key and no total is given, so no suppressed cell
   * can be worked out by subtraction. Null unless the key is LIVE.
   */
  readonly counts: {
    readonly consentedToLiveVersion: SuppressedCount;
    readonly withdrawn: SuppressedCount;
    readonly onOlderVersion: SuppressedCount;
  } | null;
}

export async function readConsentCoverage(runner: PrivacySqlRunner): Promise<{ readonly keys: readonly ConsentKeyCoverage[]; readonly definitions: readonly ConsentDefinitionRow[] }> {
  const definitionRows = await rows<Record<string, unknown>>(runner, sql`
    SELECT consent_key, version, title, enforcement, withdrawable, document_ref, effective_from, retired_at,
           CASE WHEN retired_at IS NOT NULL THEN 'RETIRED' WHEN effective_from > now() THEN 'SCHEDULED' ELSE 'LIVE' END AS status
    FROM consent_definitions
    ORDER BY consent_key, effective_from DESC, version DESC
    LIMIT 500
  `);
  const definitions = definitionRows.map((row): ConsentDefinitionRow => ({
    consentKey: String(row.consent_key),
    version: String(row.version),
    title: String(row.title),
    enforcement: row.enforcement as 'BLOCKING' | 'OPTIONAL',
    withdrawable: row.withdrawable === true,
    documentRef: row.document_ref === null ? null : String(row.document_ref),
    effectiveFrom: iso(row.effective_from) ?? '',
    retiredAt: iso(row.retired_at),
    status: row.status as ConsentDefinitionStatus,
  }));

  // One grouped scan per live key. Erased people are left out: their consent history is
  // kept as evidence, but they are no longer anyone whose consent covers anything.
  const counted = await rows<{ consent_key: string; consented: number; withdrawn: number; older: number }>(runner, sql`
    WITH live AS (
      SELECT consent_key, version FROM consent_definitions WHERE retired_at IS NULL AND effective_from <= now()
    ),
    latest AS (
      SELECT DISTINCT ON (c.user_id, c.consent_key) c.user_id, c.consent_key, c.version, c.action
      FROM user_consents c
      JOIN live l ON l.consent_key = c.consent_key
      JOIN users u ON u.id = c.user_id AND u.anonymised_at IS NULL
      ORDER BY c.user_id, c.consent_key, c.recorded_at DESC, c.id DESC
    )
    SELECT l.consent_key,
           count(la.user_id) FILTER (WHERE la.action = 'GRANTED' AND la.version = l.version)::int AS consented,
           count(la.user_id) FILTER (WHERE la.action = 'WITHDRAWN')::int AS withdrawn,
           count(la.user_id) FILTER (WHERE la.action = 'GRANTED' AND la.version <> l.version)::int AS older
    FROM live l
    LEFT JOIN latest la ON la.consent_key = l.consent_key
    GROUP BY l.consent_key
  `);
  const countsByKey = new Map(counted.map((row) => [row.consent_key, row]));

  const keys = [...new Set([...definitions.map((definition) => definition.consentKey), ...engineConsentPurposes])].sort();
  const coverage = keys.map((consentKey): ConsentKeyCoverage => {
    const live = definitions.find((definition) => definition.consentKey === consentKey && definition.status === 'LIVE');
    const known = definitions.find((definition) => definition.consentKey === consentKey);
    if (!known) return { consentKey, status: 'NOT_PUBLISHED', liveVersion: null, title: null, enforcement: null, counts: null };
    if (!live) return { consentKey, status: 'NO_LIVE_VERSION', liveVersion: null, title: known.title, enforcement: known.enforcement, counts: null };
    const row = countsByKey.get(consentKey);
    return {
      consentKey,
      status: 'LIVE',
      liveVersion: live.version,
      title: live.title,
      enforcement: live.enforcement,
      counts: {
        consentedToLiveVersion: suppressSmallCount(Number(row?.consented ?? 0)),
        withdrawn: suppressSmallCount(Number(row?.withdrawn ?? 0)),
        onOlderVersion: suppressSmallCount(Number(row?.older ?? 0)),
      },
    };
  });
  return { keys: coverage, definitions };
}
