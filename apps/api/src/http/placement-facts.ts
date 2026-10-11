/**
 * The placement facts behind INST-12's statistics, shared with INST-13's accreditation export.
 *
 * Both report "placed" for the same college, as of the same month end, and the accreditation export
 * must reconcile with the placement statistics. So there is one definition, here: the population
 * (roster in scope, account active, a relationship that began before the period end and is current
 * or ended in graduation), the applications that count (shared with the college now, submitted before
 * the period end inside the relationship), and what had happened to each by the period end. Moved out
 * of institution-placement-register.controller.ts unchanged. Design:
 * docs/architecture/placement-register-design.md, accreditation-outcome-exports-design.md.
 *
 * No query here selects an offer's terms (ADR-024), and readiness is not read (ADR-020).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { InstitutionStudentScope, SharedApplicationFacts } from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeSql } from '@planthepath/persistence/src/institution-scope.js';
import type { PersistenceDb } from '@planthepath/persistence/src/repositories.js';

type Executor = Pick<PersistenceDb, 'execute'>;
type Rows<T> = { rows: T[] };

/** Application stages at or past the shortlist. */
const shortlistStages = ['SHORTLISTED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'HIRED'];

/**
 * True when a relationship with the college authorised activity at `at` — the relationship
 * policy's historical rule (current, or graduated / transferred before `effective_to`).
 */
export function authorisedAt(institutionId: string, student: SQL, at: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM institution_relationships ar
    WHERE ar.institution_id = ${institutionId}::uuid AND ar.student_user_id = ${student}
      AND (ar.state IN ('VERIFIED', 'ACTIVE') OR (ar.state IN ('TRANSFERRED', 'GRADUATED') AND ar.effective_to IS NOT NULL))
      AND ar.effective_from <= ${at} AND (ar.effective_to IS NULL OR ar.effective_to > ${at}))`;
}

/**
 * Eligible students: on the roster in the reader's scope, account active, with a relationship that
 * began before `periodEnd` and is current now or ended in graduation (a season is reported after the
 * batch leaves). Transferred, ended and revoked students are not counted.
 */
export function populationCte(institutionId: string, scope: InstitutionStudentScope, periodEnd: SQL): SQL {
  return sql`population AS (
    SELECT sp.student_user_id, sp.department_unit_id, sp.batch_unit_id
    FROM institution_student_profiles sp JOIN users u ON u.id = sp.student_user_id
    WHERE sp.institution_id = ${institutionId}::uuid AND u.state = 'ACTIVE'
      AND ${institutionStudentScopeSql(scope, 'sp')}
      AND EXISTS (SELECT 1 FROM institution_relationships r
        WHERE r.institution_id = sp.institution_id AND r.student_user_id = sp.student_user_id AND r.effective_from < ${periodEnd}
          AND ((r.state IN ('ACTIVE', 'VERIFIED') AND r.effective_from <= now() AND (r.effective_to IS NULL OR r.effective_to > now()))
            OR (r.state = 'GRADUATED' AND r.effective_to IS NOT NULL)))
  )`;
}

/** Applications shared with the college now (consent honoured as of the request), submitted before `periodEnd` inside the relationship. */
export function sharedBefore(institutionId: string, periodEnd: SQL): SQL {
  return sql`a.state <> 'DRAFT'
    AND a.institution_visibility_granted_at IS NOT NULL AND a.institution_visibility_revoked_at IS NULL
    AND a.submitted_at < ${periodEnd} AND ${authorisedAt(institutionId, sql`a.student_user_id`, sql`a.submitted_at`)}`;
}

export interface PlacementFactsStudent {
  readonly departmentUnitId: string | null;
  readonly batchUnitId: string | null;
  /** The student's shared applications, as of the period end. */
  readonly applications: readonly SharedApplicationFacts[];
}

/**
 * Every eligible student in scope, keyed by user id, with what had happened to each of their shared
 * applications by `periodEnd` (an ISO instant). The one definition of "placed" — pass the result to
 * `placementFunnelStage`.
 */
export async function loadPlacementFacts(db: Executor, institutionId: string, scope: InstitutionStudentScope, periodEndIso: string): Promise<Map<string, PlacementFactsStudent>> {
  const periodEnd = sql`${periodEndIso}::timestamptz`;
  const id = institutionId;
  const facts = await db.execute(sql`
    WITH ${populationCte(id, scope, periodEnd)}
    SELECT p.student_user_id, p.department_unit_id, p.batch_unit_id, a.id AS application_id,
      (EXISTS (SELECT 1 FROM application_state_history h
          WHERE h.application_id = a.id AND h.to_state = ANY(${`{${shortlistStages.join(',')}}`}::text[])
            AND h.occurred_at < ${periodEnd} AND ${authorisedAt(id, sql`a.student_user_id`, sql`h.occurred_at`)})
        OR (a.state = ANY(${`{${shortlistStages.join(',')}}`}::text[]) AND a.updated_at < ${periodEnd}
            AND ${authorisedAt(id, sql`a.student_user_id`, sql`a.updated_at`)})) AS reached_shortlist,
      (SELECT count(*) FROM offers f
        WHERE f.application_id = a.id AND f.employer_id = a.employer_id AND f.state <> 'DRAFT'
          AND f.extended_at < ${periodEnd} AND ${authorisedAt(id, sql`a.student_user_id`, sql`f.extended_at`)})::int AS offers,
      (EXISTS (SELECT 1 FROM offers f
          WHERE f.application_id = a.id AND f.employer_id = a.employer_id AND f.state = 'ACCEPTED'
            AND f.responded_at < ${periodEnd} AND ${authorisedAt(id, sql`a.student_user_id`, sql`f.responded_at`)})
        OR (a.state = 'HIRED' AND a.closed_at < ${periodEnd} AND ${authorisedAt(id, sql`a.student_user_id`, sql`a.closed_at`)})) AS placed
    FROM population p
    LEFT JOIN applications a ON a.student_user_id = p.student_user_id AND ${sharedBefore(id, periodEnd)}
  `) as Rows<{ student_user_id: string; department_unit_id: string | null; batch_unit_id: string | null; application_id: string | null; reached_shortlist: boolean | null; offers: number | null; placed: boolean | null }>;

  const students = new Map<string, { departmentUnitId: string | null; batchUnitId: string | null; applications: SharedApplicationFacts[] }>();
  for (const row of facts.rows) {
    const entry = students.get(row.student_user_id) ?? { departmentUnitId: row.department_unit_id, batchUnitId: row.batch_unit_id, applications: [] };
    if (row.application_id) {
      const offers = Number(row.offers ?? 0);
      entry.applications.push({ reachedShortlist: row.reached_shortlist === true, offerExtended: offers > 0, placed: row.placed === true, offers });
    }
    students.set(row.student_user_id, entry);
  }
  return students;
}

/**
 * The period every month-end placement figure uses: the first instant of the current UTC month
 * (from the database clock), and the month and last day it closes.
 */
export async function placementPeriod(db: Executor): Promise<{ periodEnd: string; month: string; lastDay: string }> {
  const rows = await db.execute(sql`
    SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS period_end,
           to_char((t - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
           to_char((t - interval '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_day
    FROM (SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS t) boundary
  `) as Rows<{ period_end: string; month: string; last_day: string }>;
  const row = rows.rows[0]!;
  return { periodEnd: row.period_end, month: row.month, lastDay: row.last_day };
}
