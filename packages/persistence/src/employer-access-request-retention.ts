/**
 * Retention of declined and spam employer access requests (EMP-04 decision 4, built by GROWTH-05).
 *
 * Why this exists: a declined or spam request holds a name and a work email for no further
 * purpose. EMP-04 recommended deleting it 180 days after the decision once the privacy worker
 * covered the table, and left that unbuilt; GROWTH-05 needs it, because a growth referral and a
 * lead link are rows of their own that must go with their request (ON DELETE CASCADE, 0109).
 * PENDING and ONBOARDED requests are never swept. Bounded batches, the database clock, idempotent.
 *
 * Design: docs/architecture/growth-employer-pipeline-table-design.md §8;
 * docs/architecture/employer-access-requests-table-design.md ("Retention").
 */
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from './repositories.js';

type Runner = Pick<PersistenceDb, 'execute'>;

export const EMPLOYER_ACCESS_REQUEST_RETENTION_DAYS = 180;
export const EMPLOYER_ACCESS_REQUEST_SWEEP_BATCH = 500;

/** Deletes one batch of DECLINED and SPAM requests decided more than the retention period ago. Returns how many. */
export async function sweepEmployerAccessRequestRetention(runner: Runner, options: { readonly days?: number; readonly batch?: number } = {}): Promise<number> {
  const days = options.days ?? EMPLOYER_ACCESS_REQUEST_RETENTION_DAYS;
  const found = await runner.execute(sql`
    WITH expired AS (
      SELECT id FROM employer_access_requests
      WHERE state IN ('DECLINED', 'SPAM') AND decided_at < now() - make_interval(days => ${days}::int)
      ORDER BY decided_at, id LIMIT ${options.batch ?? EMPLOYER_ACCESS_REQUEST_SWEEP_BATCH}
    ), gone AS (
      DELETE FROM employer_access_requests r USING expired x WHERE r.id = x.id RETURNING 1)
    SELECT count(*)::int AS n FROM gone
  `) as { rows: { n: number }[] };
  return Number(found.rows[0]?.n ?? 0);
}
