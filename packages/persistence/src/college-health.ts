/**
 * College health for Operations → Analytics (OPS-14, Appendix 1 §3 Customer success, §5.5–5.7).
 *
 * Per college: students rostered and signed in, weekly active learners, assessments taken,
 * the readiness band distribution, staff activity, open support cases, verification state
 * and renewal date. Every figure comes from a table that exists. Counts of people pass
 * through the shared suppression helper before they leave this module, and the raw counts
 * never do. Support cases are work items and are not suppressed (OPS-03's rule).
 *
 * Windows are fixed calendar periods computed from the database clock: the last complete
 * ISO week (Monday to Sunday, UTC) and the last ended calendar month. A rolling window could
 * be read on two days and differenced to isolate one person (INST-SR-01).
 *
 * The list is one bounded summary: one grouped statement per figure over all colleges, capped
 * at `collegeHealthListCap`. No figure is summed across colleges, since a cross-college total
 * beside suppressed cells could be subtracted.
 *
 * Design: docs/architecture/institution-accounts-table-design.md
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  sortCollegesByRenewal,
  suppressAggregateTable,
  suppressSmallCount,
  type SuppressedCount,
} from '@planthepath/authorization/src/index.js';
import { institutionReadinessDistribution, type InstitutionReadinessAggregate } from './career-readiness.js';
import type { PersistenceDb } from './repositories.js';

type Rows<T> = { rows: T[] };
async function rows<T>(db: PersistenceDb, query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as unknown as Rows<T>).rows;
}

/** The list stops here and reports `collegesCapped`. */
export const collegeHealthListCap = 500;

const staffRoles = ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'PLACEMENT_ADMIN', 'DEPARTMENT_HEAD', 'FACULTY_LECTURER'];
const openCaseStates = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER'];

/** A people count split into two cells that partition it, suppressed so neither can be recovered. */
export interface SuppressedSplit {
  /** The whole population; withheld when it would reveal a hidden cell. */
  readonly total: SuppressedCount;
  readonly yes: SuppressedCount;
  readonly no: SuppressedCount;
}

export interface CollegeHealthWindows {
  /** The last complete ISO week, UTC, as YYYY-MM-DD (Monday) … YYYY-MM-DD (Sunday). */
  readonly weekStart: string;
  readonly weekEnd: string;
  /** The last ended calendar month, as YYYY-MM, with its first and last day. */
  readonly month: string;
  readonly monthStart: string;
  readonly monthEnd: string;
}

export interface CollegeHealthRow {
  readonly id: string;
  readonly name: string;
  readonly verificationState: string;
  readonly active: boolean;
  readonly renewalDate: string | null;
  /** Rostered students split by whether their account is activated (signed in). */
  readonly students: SuppressedSplit;
  readonly weeklyActiveLearners: SuppressedCount;
  /** Active staff split by whether they wrote an audit event for this college in the week. */
  readonly staff: SuppressedSplit;
  readonly openSupportCases: number;
  readonly overdueSupportCases: number;
}

export interface CollegeHealthList {
  readonly generatedAt: string;
  readonly windows: CollegeHealthWindows;
  readonly colleges: readonly CollegeHealthRow[];
  readonly collegesCapped: boolean;
  /** Counts of colleges and of work items only; never people summed across colleges. */
  readonly totals: {
    readonly colleges: number;
    readonly renewingWithin90Days: number;
    readonly withoutRenewalDate: number;
    readonly openSupportCases: number;
  };
}

export interface CollegeHealthDetail {
  readonly generatedAt: string;
  readonly windows: CollegeHealthWindows;
  readonly college: CollegeHealthRow;
  /** The last four complete weeks, oldest first, each suppressed on its own. */
  readonly weeklyActiveTrend: readonly { readonly weekStart: string; readonly learners: SuppressedCount }[];
  readonly assessments: { readonly attempts: SuppressedCount; readonly students: SuppressedCount };
  readonly staffActionsOpened: SuppressedCount;
  /** The college's own report function over the last ended month: bands only, suppressed. */
  readonly readinessBands: InstitutionReadinessAggregate;
  /** No per-student movement is computed (design doc); the slot says NA. */
  readonly readinessMovement: { readonly available: false; readonly reason: 'NOT_COMPUTED' };
}

/** The windows, from the database clock so they agree with every `now()` in the queries. */
export async function collegeHealthWindows(db: PersistenceDb): Promise<CollegeHealthWindows & { readonly generatedAt: string; readonly today: string }> {
  const [row] = await rows<{ week_start: string; week_end: string; month: string; month_start: string; month_end: string; generated_at: string; today: string }>(db, sql`
    SELECT to_char(date_trunc('week', now() AT TIME ZONE 'UTC') - interval '7 days', 'YYYY-MM-DD') AS week_start,
           to_char(date_trunc('week', now() AT TIME ZONE 'UTC') - interval '1 day', 'YYYY-MM-DD') AS week_end,
           to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month', 'YYYY-MM') AS month,
           to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month', 'YYYY-MM-DD') AS month_start,
           to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 day', 'YYYY-MM-DD') AS month_end,
           to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS generated_at,
           to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today
  `);
  if (!row) throw new Error('clock unavailable');
  return {
    weekStart: row.week_start, weekEnd: row.week_end, month: row.month, monthStart: row.month_start, monthEnd: row.month_end,
    generatedAt: row.generated_at, today: row.today,
  };
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

/** `weeks` complete weeks ending with the one starting `weekStart`, as UTC timestamps. */
function weekBounds(weekStart: string, weeks: number): SQL {
  const first = addDays(weekStart, -7 * (weeks - 1));
  return sql`e.occurred_at >= ${first}::date::timestamp AT TIME ZONE 'UTC'
         AND e.occurred_at < (${weekStart}::date + interval '7 days')::timestamp AT TIME ZONE 'UTC'`;
}

function split(yes: number, no: number): SuppressedSplit {
  const table = suppressAggregateTable([{ key: 'yes', count: yes }, { key: 'no', count: no }]);
  if (table.suppressed) return { total: { suppressed: true, value: null }, yes: { suppressed: true, value: null }, no: { suppressed: true, value: null } };
  const cell = (key: 'yes' | 'no'): SuppressedCount => {
    const found = table.cells.find((entry) => entry.key === key);
    return !found || found.suppressed || found.count === null ? { suppressed: true, value: null } : { suppressed: false, value: found.count };
  };
  return { total: table.total, yes: cell('yes'), no: cell('no') };
}

interface CollegeBase { id: string; name: string; verification_state: string; active: boolean; renewal_date: string | null }

async function collegeRows(db: PersistenceDb, ids: readonly string[], windows: CollegeHealthWindows, bases: readonly CollegeBase[]): Promise<CollegeHealthRow[]> {
  if (!ids.length) return [];
  const idArray = uuidArray(ids);
  const [students, active, staff, cases] = await Promise.all([
    rows<{ institution_id: string; signed_in: number; not_signed_in: number }>(db, sql`
      SELECT ir.institution_id,
             count(DISTINCT ir.student_user_id) FILTER (WHERE u.state = 'ACTIVE')::int AS signed_in,
             count(DISTINCT ir.student_user_id) FILTER (WHERE u.state <> 'ACTIVE')::int AS not_signed_in
      FROM institution_relationships ir
      JOIN users u ON u.id = ir.student_user_id
      WHERE ir.institution_id = ANY(${idArray})
        AND ir.state IN ('VERIFIED', 'ACTIVE') AND ir.effective_from <= now()
        AND (ir.effective_to IS NULL OR ir.effective_to > now())
        AND u.state NOT IN ('DELETED', 'DELETION_PENDING') AND u.anonymised_at IS NULL
      GROUP BY ir.institution_id`),
    weeklyActive(db, ids, windows.weekStart, 1),
    rows<{ institution_id: string; active: number; inactive: number }>(db, sql`
      WITH staff AS (
        SELECT DISTINCT m.organization_id, m.user_id
        FROM organization_memberships m
        JOIN users u ON u.id = m.user_id AND u.state = 'ACTIVE'
        WHERE m.organization_id = ANY(${idArray}) AND m.state = 'ACTIVE'
          AND m.role IN (${sql.join(staffRoles.map((role) => sql`${role}`), sql`, `)})
      )
      SELECT s.organization_id AS institution_id,
             count(*) FILTER (WHERE seen.any)::int AS active,
             count(*) FILTER (WHERE NOT seen.any)::int AS inactive
      FROM staff s
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM audit_events a
          WHERE a.actor_user_id = s.user_id AND a.organization_id = s.organization_id
            AND a.occurred_at >= ${windows.weekStart}::date::timestamp AT TIME ZONE 'UTC'
            AND a.occurred_at < (${windows.weekStart}::date + interval '7 days')::timestamp AT TIME ZONE 'UTC'
        ) AS any
      ) seen
      GROUP BY s.organization_id`),
    rows<{ organization_id: string; open: number; overdue: number }>(db, sql`
      SELECT organization_id,
             count(*)::int AS open,
             count(*) FILTER (WHERE sla_due_at < now())::int AS overdue
      FROM support_cases
      WHERE organization_id = ANY(${idArray})
        AND state IN (${sql.join(openCaseStates.map((state) => sql`${state}`), sql`, `)})
      GROUP BY organization_id`),
  ]);
  const studentsBy = new Map(students.map((row) => [row.institution_id, row]));
  const staffBy = new Map(staff.map((row) => [row.institution_id, row]));
  const casesBy = new Map(cases.map((row) => [row.organization_id, row]));
  return bases.map((base) => ({
    id: base.id,
    name: base.name,
    verificationState: base.verification_state,
    active: base.active,
    renewalDate: base.renewal_date,
    students: split(studentsBy.get(base.id)?.signed_in ?? 0, studentsBy.get(base.id)?.not_signed_in ?? 0),
    weeklyActiveLearners: suppressSmallCount(active.get(`${base.id}|${windows.weekStart}`) ?? 0),
    staff: split(staffBy.get(base.id)?.active ?? 0, staffBy.get(base.id)?.inactive ?? 0),
    openSupportCases: casesBy.get(base.id)?.open ?? 0,
    overdueSupportCases: casesBy.get(base.id)?.overdue ?? 0,
  }));
}

/**
 * Distinct learners per college per complete week, for `weeks` weeks ending with the week
 * starting `weekStart`. A learner counts at a college when their relationship with it
 * covered the event's time (the INST-08 predicate), so a graduate's earlier activity stays
 * with the college they left. Keyed `institutionId|weekStart`. Raw: callers suppress.
 */
async function weeklyActive(db: PersistenceDb, ids: readonly string[], weekStart: string, weeks: number): Promise<Map<string, number>> {
  const result = await rows<{ institution_id: string; week_start: string; learners: number }>(db, sql`
    SELECT ir.institution_id,
           to_char(date_trunc('week', e.occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week_start,
           count(DISTINCT e.user_id)::int AS learners
    FROM learner_activity_events e
    JOIN users u ON u.id = e.user_id AND u.state NOT IN ('DELETED', 'DELETION_PENDING') AND u.anonymised_at IS NULL
    JOIN institution_relationships ir ON ir.student_user_id = e.user_id
      AND ir.institution_id = ANY(${uuidArray(ids)})
      AND (ir.state IN ('VERIFIED', 'ACTIVE') OR (ir.state IN ('TRANSFERRED', 'GRADUATED') AND ir.effective_to IS NOT NULL))
      AND ir.effective_from <= e.occurred_at AND (ir.effective_to IS NULL OR ir.effective_to > e.occurred_at)
    WHERE ${weekBounds(weekStart, weeks)}
    GROUP BY ir.institution_id, 2`);
  return new Map(result.map((row) => [`${row.institution_id}|${row.week_start}`, row.learners]));
}

async function collegeBases(db: PersistenceDb, filter: SQL, limit: number): Promise<CollegeBase[]> {
  return rows<CollegeBase>(db, sql`
    SELECT o.id, COALESCE(NULLIF(p.display_name, ''), o.legal_name) AS name, o.verification_state::text AS verification_state,
           o.active, to_char(a.renewal_date, 'YYYY-MM-DD') AS renewal_date
    FROM organizations o
    LEFT JOIN organization_profiles p ON p.organization_id = o.id
    LEFT JOIN institution_accounts a ON a.institution_id = o.id
    WHERE o.kind = 'INSTITUTION' AND ${filter}
    ORDER BY a.renewal_date ASC NULLS LAST, name, o.id
    LIMIT ${limit}`);
}

/** Every college (up to the cap), sorted by renewal date then activity, suppressed. */
export async function readCollegeHealthList(db: PersistenceDb): Promise<CollegeHealthList> {
  const clock = await collegeHealthWindows(db);
  const { generatedAt, today, ...windows } = clock;
  const found = await collegeBases(db, sql`TRUE`, collegeHealthListCap + 1);
  const bases = found.slice(0, collegeHealthListCap);
  const colleges = sortCollegesByRenewal(await collegeRows(db, bases.map((base) => base.id), windows, bases));
  const horizon = addDays(today, 90);
  return {
    generatedAt,
    windows,
    colleges,
    collegesCapped: found.length > collegeHealthListCap,
    totals: {
      colleges: colleges.length,
      renewingWithin90Days: colleges.filter((college) => college.renewalDate !== null && college.renewalDate >= today && college.renewalDate <= horizon).length,
      withoutRenewalDate: colleges.filter((college) => college.renewalDate === null).length,
      openSupportCases: colleges.reduce((sum, college) => sum + college.openSupportCases, 0),
    },
  };
}

/** One college's health, or null when the id is not an institution. */
export async function readCollegeHealthDetail(db: PersistenceDb, institutionId: string): Promise<CollegeHealthDetail | null> {
  const clock = await collegeHealthWindows(db);
  const { generatedAt, today: _today, ...windows } = clock;
  const bases = await collegeBases(db, sql`o.id = ${institutionId}::uuid`, 1);
  if (!bases.length) return null;
  const [college] = await collegeRows(db, [institutionId], windows, bases);
  const trendStarts = [3, 2, 1, 0].map((back) => addDays(windows.weekStart, -7 * back));
  const [trend, assessments, staffActions, readinessBands] = await Promise.all([
    weeklyActive(db, [institutionId], windows.weekStart, 4),
    rows<{ attempts: number; students: number }>(db, sql`
      SELECT count(*)::int AS attempts, count(DISTINCT student_user_id)::int AS students
      FROM exam_attempts
      WHERE institution_id = ${institutionId}::uuid AND status <> 'IN_PROGRESS'
        AND submitted_at >= ${windows.monthStart}::date::timestamp AT TIME ZONE 'UTC'
        AND submitted_at < (${windows.monthEnd}::date + interval '1 day')::timestamp AT TIME ZONE 'UTC'`),
    rows<{ opened: number }>(db, sql`
      SELECT count(*)::int AS opened FROM staff_actions
      WHERE institution_id = ${institutionId}::uuid AND action_type <> 'COUNSELLING_NOTE'
        AND created_at >= ${windows.weekStart}::date::timestamp AT TIME ZONE 'UTC'
        AND created_at < (${windows.weekStart}::date + interval '7 days')::timestamp AT TIME ZONE 'UTC'`),
    institutionReadinessDistribution(db, { institutionId, periodStart: windows.monthStart, periodEnd: windows.monthEnd }),
  ]);
  return {
    generatedAt,
    windows,
    college: college!,
    weeklyActiveTrend: trendStarts.map((weekStart) => ({ weekStart, learners: suppressSmallCount(trend.get(`${institutionId}|${weekStart}`) ?? 0) })),
    assessments: { attempts: suppressSmallCount(assessments[0]?.attempts ?? 0), students: suppressSmallCount(assessments[0]?.students ?? 0) },
    staffActionsOpened: suppressSmallCount(staffActions[0]?.opened ?? 0),
    readinessBands,
    readinessMovement: { available: false, reason: 'NOT_COMPUTED' },
  };
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
