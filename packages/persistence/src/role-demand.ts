/**
 * Role demand (OPS-11, Appendix 1 §5.5–5.7): how many students target each career role,
 * across how many colleges, and how that stands against the catalogue's promotion rule.
 *
 * Every count is computed in bounded SQL and every count of people is suppressed here,
 * before it can reach a controller: role totals and trend months through
 * `suppressPeopleCount`, breakdowns (colleges, departments, release labels) through
 * `suppressDemandBreakdown`, which also applies complementary suppression and hides the
 * true order of suppressed rows. No student name, email or identifier is selected.
 *
 * Suppression helper: `suppressPeopleCount` from packages/authorization's
 * operations-overview.ts. INST-SR-01 consolidates it with privacy-console.ts's
 * `suppressSmallCount`; switch to the consolidated name when that lands (same threshold).
 *
 * Design: docs/architecture/role-demand-dashboard-design.md
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  evaluateRolePromotion,
  suppressDemandBreakdown,
  suppressPeopleCount,
  withholdCollegeCount,
  type RolePromotionEvaluation,
  type SuppressedPeopleCount,
} from '@planthepath/authorization/src/index.js';

export interface RoleDemandSqlRunner {
  execute(query: SQL): Promise<unknown>;
}

type Rows<T> = { rows: T[] };
async function rows<T>(runner: RoleDemandSqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

/** Bounds: the catalogue is 108 roles, so these are ceilings, not pages. */
export const ROLE_DEMAND_ROLE_CAP = 1_000;
export const ROLE_DEMAND_COLLEGE_CAP = 200;
export const ROLE_DEMAND_DEPARTMENT_CAP = 50;
export const ROLE_DEMAND_TREND_MONTHS = 12;

/**
 * Students whose stated interest counts: a live target on an account that is not being or
 * has not been deleted. One row per (role, student).
 */
const demandCte = sql`
  demand AS (
    SELECT DISTINCT t.career_role_id, t.student_user_id
    FROM student_career_targets t
    JOIN users u ON u.id = t.student_user_id
    WHERE t.cleared_at IS NULL
      AND u.state NOT IN ('DELETION_PENDING','DELETED')
      AND u.anonymised_at IS NULL
  )`;

/** A student's colleges: a current relationship, or the college they graduated from. */
const collegeCte = sql`
  college AS (
    SELECT DISTINCT ir.student_user_id, ir.institution_id
    FROM institution_relationships ir
    JOIN organizations o ON o.id = ir.institution_id AND o.kind = 'INSTITUTION'
    WHERE (ir.state IN ('VERIFIED','ACTIVE') AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))
       OR ir.state = 'GRADUATED'
  )`;

export interface RoleDemandRole {
  readonly id: string;
  readonly code: string;
  readonly catalogueCode: string | null;
  readonly title: string;
  readonly family: string;
  readonly catalogueFamily: string | null;
  readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | null;
  readonly plannedRelease: 'V1' | 'V2' | 'V3' | null;
  readonly active: boolean;
  readonly students: SuppressedPeopleCount;
  /** Distinct colleges of those students; null (withheld) whenever `students` is suppressed. */
  readonly colleges: number | null;
  readonly promotion: RolePromotionEvaluation;
}

export interface RoleDemandBreakdownCell {
  readonly label: string;
  readonly students: SuppressedPeopleCount;
  readonly complementary: boolean;
}

export interface RoleDemandSummary {
  readonly generatedAt: string;
  readonly totals: {
    /** Distinct students with at least one live target. */
    readonly studentsWithTarget: SuppressedPeopleCount;
    readonly roles: number;
    readonly catalogueRoles: number;
    readonly rolesMeetingPromotionRule: number;
  };
  readonly roles: readonly RoleDemandRole[];
  readonly rolesCapped: boolean;
  readonly byReleaseLabel: readonly (RoleDemandBreakdownCell & { readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | 'NONE'; readonly roles: number })[];
  readonly trend: readonly { readonly month: string; readonly students: SuppressedPeopleCount }[];
  /** No opportunity or employer request references a career role, so employer demand cannot be read. */
  readonly employerDemand: { readonly available: false; readonly reason: 'NO_ROLE_MAPPING' };
}

type RoleRow = {
  id: string; code: string; catalogue_code: string | null; title: string; catalogue_title: string | null;
  family: string; catalogue_family: string | null; release_label: 'SELECTABLE' | 'VERIFIED' | null;
  planned_release: 'V1' | 'V2' | 'V3' | null; active: boolean; students: number; colleges: number;
};

function toRole(row: RoleRow): RoleDemandRole {
  const students = suppressPeopleCount(Number(row.students));
  return {
    id: row.id,
    code: row.code,
    catalogueCode: row.catalogue_code,
    title: row.catalogue_title ?? row.title,
    family: row.family,
    catalogueFamily: row.catalogue_family,
    releaseLabel: row.release_label,
    plannedRelease: row.planned_release,
    active: row.active,
    students,
    colleges: withholdCollegeCount(students, Number(row.colleges)),
    promotion: evaluateRolePromotion({ releaseLabel: row.release_label, students: Number(row.students), colleges: Number(row.colleges) }),
  };
}

/** Catalogue roles by catalogue code, then roles outside the catalogue by their own code. */
function byCode(a: RoleDemandRole, b: RoleDemandRole): number {
  if ((a.catalogueCode === null) !== (b.catalogueCode === null)) return a.catalogueCode === null ? 1 : -1;
  const left = a.catalogueCode ?? a.code;
  const right = b.catalogueCode ?? b.code;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Ranked by demand: shown counts first, largest first; suppressed roles after them in
 * catalogue-code order, so their true order never shows.
 */
function rankRoles(roles: readonly RoleDemandRole[]): RoleDemandRole[] {
  const shown = roles.filter((role) => !role.students.suppressed)
    .sort((a, b) => (b.students.value ?? 0) - (a.students.value ?? 0) || byCode(a, b));
  const suppressed = roles.filter((role) => role.students.suppressed).sort(byCode);
  return [...shown, ...suppressed];
}

export async function readRoleDemandSummary(runner: RoleDemandSqlRunner): Promise<RoleDemandSummary> {
  const roleRows = await rows<RoleRow>(runner, sql`
    WITH ${demandCte}, ${collegeCte},
    per_role AS (
      SELECT d.career_role_id, count(DISTINCT d.student_user_id)::int AS students, count(DISTINCT c.institution_id)::int AS colleges
      FROM demand d LEFT JOIN college c ON c.student_user_id = d.student_user_id
      GROUP BY d.career_role_id
    )
    SELECT r.id, r.code, r.catalogue_code, r.title, r.catalogue_title, r.family, r.catalogue_family,
           r.release_label, r.planned_release, r.active,
           coalesce(p.students, 0) AS students, coalesce(p.colleges, 0) AS colleges
    FROM career_roles r
    LEFT JOIN per_role p ON p.career_role_id = r.id
    ORDER BY coalesce(r.catalogue_code, r.code), r.id
    LIMIT ${ROLE_DEMAND_ROLE_CAP + 1}
  `);
  const rolesCapped = roleRows.length > ROLE_DEMAND_ROLE_CAP;
  const roles = rankRoles(roleRows.slice(0, ROLE_DEMAND_ROLE_CAP).map(toRole));

  const [totals] = await rows<{ students: number; roles: number; catalogue_roles: number }>(runner, sql`
    WITH ${demandCte}
    SELECT (SELECT count(DISTINCT student_user_id) FROM demand)::int AS students,
           (SELECT count(*) FROM career_roles)::int AS roles,
           (SELECT count(*) FROM career_roles WHERE catalogue_code IS NOT NULL)::int AS catalogue_roles
  `);

  const labelRows = await rows<{ label: 'SELECTABLE' | 'VERIFIED' | 'NONE'; roles: number; students: number }>(runner, sql`
    WITH ${demandCte}
    SELECT coalesce(r.release_label, 'NONE') AS label, count(DISTINCT r.id)::int AS roles, count(DISTINCT d.student_user_id)::int AS students
    FROM career_roles r
    LEFT JOIN demand d ON d.career_role_id = r.id
    GROUP BY 1
  `);
  const labelOrder = ['SELECTABLE', 'VERIFIED', 'NONE'] as const;
  const labelCells = suppressDemandBreakdown(labelRows.map((row) => ({ key: row.label, label: row.label, count: Number(row.students) })));
  const byReleaseLabel = labelOrder
    .map((label) => {
      const cell = labelCells.find((candidate) => candidate.key === label);
      const row = labelRows.find((candidate) => candidate.label === label);
      return cell && row ? { releaseLabel: label, label, roles: Number(row.roles), students: cell.count, complementary: cell.complementary } : null;
    })
    .filter((cell): cell is NonNullable<typeof cell> => cell !== null);

  // Calendar months in UTC, oldest first, the current month last.
  const trendRows = await rows<{ month: string; students: number }>(runner, sql`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => ${ROLE_DEMAND_TREND_MONTHS - 1}),
        date_trunc('month', now() AT TIME ZONE 'UTC'),
        interval '1 month') AS m
    )
    SELECT to_char(months.m, 'YYYY-MM') AS month,
           (SELECT count(DISTINCT t.student_user_id)
            FROM student_career_targets t JOIN users u ON u.id = t.student_user_id
            WHERE u.state NOT IN ('DELETION_PENDING','DELETED') AND u.anonymised_at IS NULL
              AND (t.selected_at AT TIME ZONE 'UTC') >= months.m
              AND (t.selected_at AT TIME ZONE 'UTC') < months.m + interval '1 month')::int AS students
    FROM months ORDER BY months.m
  `);

  const [clock] = await rows<{ now: string | Date }>(runner, sql`SELECT now() AS now`);
  return {
    generatedAt: new Date(clock!.now).toISOString(),
    totals: {
      studentsWithTarget: suppressPeopleCount(Number(totals?.students ?? 0)),
      roles: Number(totals?.roles ?? 0),
      catalogueRoles: Number(totals?.catalogue_roles ?? 0),
      rolesMeetingPromotionRule: roles.filter((role) => role.promotion.status === 'MEETS').length,
    },
    roles,
    rolesCapped,
    byReleaseLabel,
    trend: trendRows.map((row) => ({ month: row.month, students: suppressPeopleCount(Number(row.students)) })),
    employerDemand: { available: false, reason: 'NO_ROLE_MAPPING' },
  };
}

export interface RoleDemandCollege extends RoleDemandBreakdownCell {
  /** Null when the college's own cell is withheld: no breakdown sits behind a suppressed parent. */
  readonly departments: readonly RoleDemandBreakdownCell[] | null;
  readonly departmentsCapped: boolean;
}

export interface RoleDemandDetail {
  readonly role: RoleDemandRole;
  /** Null when the role's total is suppressed. */
  readonly colleges: readonly RoleDemandCollege[] | null;
  readonly collegesCapped: boolean;
}

export const NO_COLLEGE_LABEL = 'No college recorded';
export const NO_DEPARTMENT_LABEL = 'Department not recorded';

/** One role's breakdown by college and, within each shown college, by department. Null when no such role. */
export async function readRoleDemandDetail(runner: RoleDemandSqlRunner, roleId: string): Promise<RoleDemandDetail | null> {
  const [row] = await rows<RoleRow>(runner, sql`
    WITH ${demandCte}, ${collegeCte}
    SELECT r.id, r.code, r.catalogue_code, r.title, r.catalogue_title, r.family, r.catalogue_family,
           r.release_label, r.planned_release, r.active,
           (SELECT count(*) FROM demand d WHERE d.career_role_id = r.id)::int AS students,
           (SELECT count(DISTINCT c.institution_id) FROM demand d JOIN college c ON c.student_user_id = d.student_user_id
            WHERE d.career_role_id = r.id)::int AS colleges
    FROM career_roles r WHERE r.id = ${roleId}::uuid
  `);
  if (!row) return null;
  const role = toRole(row);
  if (role.students.suppressed) return { role, colleges: null, collegesCapped: false };

  const collegeRows = await rows<{ institution_id: string | null; name: string; students: number }>(runner, sql`
    WITH ${demandCte}, ${collegeCte},
    role_demand AS (SELECT student_user_id FROM demand WHERE career_role_id = ${roleId}::uuid)
    (SELECT c.institution_id, coalesce(p.display_name, o.legal_name) AS name, count(DISTINCT rd.student_user_id)::int AS students
     FROM role_demand rd
     JOIN college c ON c.student_user_id = rd.student_user_id
     JOIN organizations o ON o.id = c.institution_id
     LEFT JOIN organization_profiles p ON p.organization_id = o.id
     GROUP BY c.institution_id, 2
     ORDER BY students DESC, 2, c.institution_id
     LIMIT ${ROLE_DEMAND_COLLEGE_CAP + 1})
    UNION ALL
    SELECT NULL, ${NO_COLLEGE_LABEL}, count(*)::int
    FROM role_demand rd
    WHERE NOT EXISTS (SELECT 1 FROM college c WHERE c.student_user_id = rd.student_user_id)
    HAVING count(*) > 0
  `);
  const named = collegeRows.filter((college) => college.institution_id !== null);
  const collegesCapped = named.length > ROLE_DEMAND_COLLEGE_CAP;
  const bounded = [...named.slice(0, ROLE_DEMAND_COLLEGE_CAP), ...collegeRows.filter((college) => college.institution_id === null)];
  const cells = suppressDemandBreakdown(bounded.map((college, index) => ({
    key: college.institution_id ?? `none:${index}`,
    label: college.name,
    count: Number(college.students),
  })));

  const shownIds = cells.filter((cell) => !cell.count.suppressed && !cell.key.startsWith('none:')).map((cell) => cell.key);
  const departmentRows = shownIds.length ? await rows<{ institution_id: string; name: string | null; students: number }>(runner, sql`
    WITH ${demandCte}, ${collegeCte}
    SELECT c.institution_id, un.name, count(DISTINCT d.student_user_id)::int AS students
    FROM demand d
    JOIN college c ON c.student_user_id = d.student_user_id
    LEFT JOIN institution_student_profiles isp ON isp.institution_id = c.institution_id AND isp.student_user_id = d.student_user_id
    LEFT JOIN institution_units un ON un.id = isp.department_unit_id AND un.institution_id = c.institution_id
    WHERE d.career_role_id = ${roleId}::uuid
      AND c.institution_id IN (${sql.join(shownIds.map((id) => sql`${id}::uuid`), sql`, `)})
    GROUP BY c.institution_id, un.id, un.name
  `) : [];

  const colleges: RoleDemandCollege[] = cells.map((cell) => {
    if (cell.count.suppressed || cell.key.startsWith('none:')) {
      return { label: cell.label, students: cell.count, complementary: cell.complementary, departments: null, departmentsCapped: false };
    }
    const own = departmentRows.filter((department) => department.institution_id === cell.key)
      .sort((a, b) => Number(b.students) - Number(a.students));
    const departmentsCapped = own.length > ROLE_DEMAND_DEPARTMENT_CAP;
    const departments = suppressDemandBreakdown(own.slice(0, ROLE_DEMAND_DEPARTMENT_CAP).map((department, index) => ({
      key: index,
      label: department.name ?? NO_DEPARTMENT_LABEL,
      count: Number(department.students),
    }))).map((department) => ({ label: department.label, students: department.count, complementary: department.complementary }));
    return { label: cell.label, students: cell.count, complementary: cell.complementary, departments, departmentsCapped };
  });
  return { role, colleges, collegesCapped };
}
