/**
 * Growth field work: the retention sweeps and the account-erasure step (GROWTH-06).
 *
 * Why this exists: a visit's location is the staff member's personal data and is kept 180 days
 * (O-23); visit notes and follow-up titles are free text about organisations that may hold more
 * than they should, so they go with the lead's contacts when the 24-month sweep runs (D12, design
 * §13.4). The privacy worker runs both daily; the deletion run erases every location a person
 * logged when their account is erased. Bounded batches, the database clock, idempotent.
 *
 * Design: docs/architecture/growth-field-work-table-design.md §6
 */
import { sql, type SQL } from 'drizzle-orm';
import { GROWTH_CONTACT_RETENTION_MONTHS, GROWTH_LOCATION_RETENTION_DAYS } from '@planthepath/authorization/src/index.js';
import type { PersistenceDb } from './repositories.js';

type Rows<T> = { rows: T[] };
type Runner = Pick<PersistenceDb, 'execute'>;
async function count(runner: Runner, query: SQL): Promise<number> {
  return Number(((await runner.execute(query)) as Rows<{ n: number }>).rows[0]?.n ?? 0);
}

export const GROWTH_FIELD_SWEEP_BATCH = 1_000;

/** Erases the location of activities received more than 180 days ago. One batch per call; returns how many. */
export async function sweepGrowthActivityLocations(runner: Runner, options: { readonly days?: number; readonly batch?: number } = {}): Promise<number> {
  const days = options.days ?? GROWTH_LOCATION_RETENTION_DAYS;
  return count(runner, sql`
    WITH expired AS (
      SELECT id FROM growth_activities
      WHERE location_latitude IS NOT NULL AND received_at < now() - make_interval(days => ${days}::int)
      ORDER BY received_at, id LIMIT ${options.batch ?? GROWTH_FIELD_SWEEP_BATCH}
    ), gone AS (
      UPDATE growth_activities a
      SET location_latitude = NULL, location_longitude = NULL, location_accuracy_m = NULL,
          location_erased_at = now(), location_erased_reason = 'RETENTION_EXPIRED'
      FROM expired x WHERE a.id = x.id
      RETURNING 1)
    SELECT count(*)::int AS n FROM gone
  `);
}

/**
 * Erases activity notes and follow-up titles of leads whose last activity is older than the
 * contact retention period and which were not handed off — the same leads whose contacts the
 * GROWTH-03 sweep erases. One batch of each per call.
 */
export async function sweepGrowthFieldText(runner: Runner, options: { readonly months?: number; readonly batch?: number } = {}): Promise<{ readonly notes: number; readonly titles: number }> {
  const months = options.months ?? GROWTH_CONTACT_RETENTION_MONTHS;
  const batch = options.batch ?? GROWTH_FIELD_SWEEP_BATCH;
  const expiredLeads = sql`SELECT l.id FROM growth_leads l WHERE l.organization_id IS NULL AND l.last_activity_at < now() - make_interval(months => ${months}::int)`;
  const notes = await count(runner, sql`
    WITH expired AS (
      SELECT a.id FROM growth_activities a WHERE a.notes IS NOT NULL AND a.lead_id IN (${expiredLeads})
      ORDER BY a.received_at, a.id LIMIT ${batch}
    ), gone AS (
      UPDATE growth_activities a SET notes = NULL, notes_erased_at = now() FROM expired x WHERE a.id = x.id RETURNING 1)
    SELECT count(*)::int AS n FROM gone
  `);
  const titles = await count(runner, sql`
    WITH expired AS (
      SELECT f.id FROM growth_follow_ups f WHERE f.title IS NOT NULL AND f.lead_id IN (${expiredLeads})
      ORDER BY f.created_at, f.id LIMIT ${batch}
    ), gone AS (
      UPDATE growth_follow_ups f SET title = NULL, title_erased_at = now() FROM expired x WHERE f.id = x.id RETURNING 1)
    SELECT count(*)::int AS n FROM gone
  `);
  return { notes, titles };
}

/** Account erasure: every location the person logged goes, whatever its age. Returns how many. */
export async function eraseGrowthLocationsForUser(runner: Runner, userId: string): Promise<number> {
  return count(runner, sql`
    WITH gone AS (
      UPDATE growth_activities
      SET location_latitude = NULL, location_longitude = NULL, location_accuracy_m = NULL,
          location_erased_at = now(), location_erased_reason = 'ACCOUNT_ERASED'
      WHERE author_user_id = ${userId}::uuid AND location_latitude IS NOT NULL
      RETURNING 1)
    SELECT count(*)::int AS n FROM gone
  `);
}
