/**
 * Growth lead contacts: retention, and the privacy console's lookup and erasure (GROWTH-03).
 *
 * Why this exists: lead contacts are personal data about people who are not ONE users and never
 * agreed to anything (design §13). Three paths reach them outside the growth person's own screens,
 * and they are written once, here:
 *  - the daily retention sweep (D12: 24 months after the lead's last activity), run by the privacy
 *    worker, which erases name, email and phone and keeps the organisation-level lead;
 *  - the privacy console lookup by email or phone, which is the answer to the person's access
 *    request (what we hold, where it came from, whether they were told);
 *  - the privacy console erasure, which removes every matching contact and, when asked, stops all
 *    contact with that person's organisations (do-not-contact).
 *
 * Design: docs/architecture/growth-leads-table-design.md §6
 */
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { GROWTH_CONTACT_RETENTION_MONTHS } from '@planthepath/authorization/src/index.js';
import type { PersistenceDb } from './repositories.js';

type Rows<T> = { rows: T[] };
type Runner = Pick<PersistenceDb, 'execute'>;
async function rows<T>(runner: Runner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

export const GROWTH_RETENTION_SWEEP_BATCH = 500;

/**
 * Erases the live contacts of leads whose last activity is older than the retention period and
 * which were not handed off. One bounded batch of leads per call; returns what it erased, so the
 * worker loops until a call erases nothing. Idempotent: an erased contact is no longer live.
 */
export async function sweepGrowthLeadContactRetention(
  runner: Runner,
  options: { readonly months?: number; readonly batch?: number } = {},
): Promise<{ readonly leads: number; readonly contacts: number }> {
  const months = options.months ?? GROWTH_CONTACT_RETENTION_MONTHS;
  const batch = options.batch ?? GROWTH_RETENTION_SWEEP_BATCH;
  const result = await rows<{ leads: number; contacts: number }>(runner, sql`
    WITH expired AS (
      SELECT l.id FROM growth_leads l
      WHERE l.organization_id IS NULL
        AND l.last_activity_at < now() - make_interval(months => ${months}::int)
        AND EXISTS (SELECT 1 FROM growth_lead_contacts c WHERE c.lead_id = l.id AND c.removed_at IS NULL)
      ORDER BY l.last_activity_at, l.id
      LIMIT ${batch}
    ), gone AS (
      UPDATE growth_lead_contacts c
      SET removed_at = now(), removed_reason_code = 'RETENTION_EXPIRED', full_name = NULL, email = NULL, phone = NULL
      FROM expired x
      WHERE c.lead_id = x.id AND c.removed_at IS NULL
      RETURNING c.lead_id)
    SELECT count(DISTINCT lead_id)::int AS leads, count(*)::int AS contacts FROM gone
  `);
  return result[0] ?? { leads: 0, contacts: 0 };
}

export type GrowthContactLookupKey = { readonly email: string } | { readonly phoneDigits: string };

/** A lookup key as given to the console: an email (lower-cased) or a phone (digits only, 6–15). */
export function readGrowthContactLookupKey(input: { readonly email?: unknown; readonly phone?: unknown }): GrowthContactLookupKey | null {
  if (typeof input.email === 'string' && input.email.trim() && input.phone === undefined) {
    const email = input.email.trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254 ? { email } : null;
  }
  if (typeof input.phone === 'string' && input.phone.trim() && input.email === undefined) {
    const digits = input.phone.replace(/[^0-9]/g, '');
    return digits.length >= 6 && digits.length <= 15 ? { phoneDigits: digits } : null;
  }
  return null;
}

/** A hash of the key, for the audit row: the audit says a lookup happened, never for whom. */
export function growthContactLookupHash(key: GrowthContactLookupKey): string {
  return createHash('sha256').update('email' in key ? `email:${key.email}` : `phone:${key.phoneDigits}`).digest('hex');
}

function keyPredicate(key: GrowthContactLookupKey): SQL {
  // A phone matches on its last ten digits too, so +91 98450 12345 finds 09845012345.
  return 'email' in key
    ? sql`c.email = ${key.email}`
    : sql`(c.phone_digits = ${key.phoneDigits} OR (length(${key.phoneDigits}) >= 10 AND right(c.phone_digits, 10) = right(${key.phoneDigits}, 10)))`;
}

export interface GrowthContactLookupRow {
  readonly contactId: string;
  readonly leadId: string;
  readonly organisation: string;
  readonly kind: string;
  readonly contactRole: string;
  readonly fullName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly permissionBasis: string;
  readonly source: string;
  readonly noticeGivenAt: string | null;
  readonly noticeVersion: string | null;
  readonly addedAt: string;
  readonly removedAt: string | null;
  readonly removedReasonCode: string | null;
  readonly leadDoNotContact: boolean;
}

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);

/** Every contact row, live or removed, that holds this email or phone. Bounded. */
export async function lookupGrowthContacts(runner: Runner, key: GrowthContactLookupKey): Promise<readonly GrowthContactLookupRow[]> {
  const found = await rows<{
    id: string; lead_id: string; name: string; kind: string; contact_role: string; full_name: string | null; email: string | null; phone: string | null;
    permission_basis: string; source: string; notice_given_at: Date | null; notice_version: string | null; created_at: Date; removed_at: Date | null;
    removed_reason_code: string | null; do_not_contact_at: Date | null;
  }>(runner, sql`
    SELECT c.id, c.lead_id, l.name, l.kind, c.contact_role, c.full_name, c.email, c.phone, c.permission_basis, c.source,
           c.notice_given_at, c.notice_version, c.created_at, c.removed_at, c.removed_reason_code, l.do_not_contact_at
    FROM growth_lead_contacts c JOIN growth_leads l ON l.id = c.lead_id
    WHERE ${keyPredicate(key)}
    ORDER BY c.created_at, c.id
    LIMIT 200
  `);
  return found.map((row) => ({
    contactId: row.id, leadId: row.lead_id, organisation: row.name, kind: row.kind, contactRole: row.contact_role,
    fullName: row.full_name, email: row.email, phone: row.phone, permissionBasis: row.permission_basis, source: row.source,
    noticeGivenAt: iso(row.notice_given_at), noticeVersion: row.notice_version, addedAt: iso(row.created_at)!,
    removedAt: iso(row.removed_at), removedReasonCode: row.removed_reason_code, leadDoNotContact: row.do_not_contact_at !== null,
  }));
}

/**
 * Removes every live contact holding this email or phone (PRIVACY_REQUEST) and, when asked, sets
 * do-not-contact on each of their leads. Runs inside the caller's transaction; returns the lead
 * ids touched so the caller can audit each.
 */
export async function eraseGrowthContacts(runner: Runner, input: {
  readonly key: GrowthContactLookupKey;
  readonly actorUserId: string;
  readonly doNotContact: boolean;
}): Promise<{ readonly removed: readonly { readonly contactId: string; readonly leadId: string }[]; readonly doNotContactLeadIds: readonly string[] }> {
  // Removal is matched on the live rows only; a removed row already holds nothing.
  const removed = await rows<{ id: string; lead_id: string }>(runner, sql`
    UPDATE growth_lead_contacts c
    SET removed_at = now(), removed_by_user_id = ${input.actorUserId}::uuid, removed_reason_code = 'PRIVACY_REQUEST',
        full_name = NULL, email = NULL, phone = NULL
    WHERE c.removed_at IS NULL AND ${keyPredicate(input.key)}
    RETURNING c.id, c.lead_id
  `);
  const leadIds = [...new Set(removed.map((row) => row.lead_id))];
  let doNotContactLeadIds: string[] = [];
  if (input.doNotContact && leadIds.length) {
    const set = await rows<{ id: string }>(runner, sql`
      UPDATE growth_leads
      SET do_not_contact_at = now(), do_not_contact_reason = 'PERSON_REQUEST', do_not_contact_by_user_id = ${input.actorUserId}::uuid, last_activity_at = now()
      WHERE id IN (${sql.join(leadIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND do_not_contact_at IS NULL
      RETURNING id
    `);
    doNotContactLeadIds = set.map((row) => row.id);
  }
  if (leadIds.length) {
    await runner.execute(sql`UPDATE growth_leads SET last_activity_at = now() WHERE id IN (${sql.join(leadIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  return { removed: removed.map((row) => ({ contactId: row.id, leadId: row.lead_id })), doNotContactLeadIds };
}
