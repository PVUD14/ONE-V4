/**
 * The faculty cohort view's reads over the learning engine (INST-15).
 *
 * Why it exists: a lecturer needs to see which of their students are stuck on the same skill, which
 * misconceptions are common in the class and who has reviews due — the engine already holds all three
 * per student in `learner_skill_state`. These queries read them for a given student scope and nothing
 * else. Design and reasoning: docs/architecture/faculty-cohort-view-design.md.
 *
 * Every read is restricted, in the same SQL statement, to students who are (a) inside the scope the
 * caller resolved, (b) in a current relationship with the institution, and (c) holding the
 * adaptive-learning consent now (`consentPurposeHeldSql`, the one rule `hasConsentPurpose` uses — it
 * fails closed, so until the definition is published nothing is returned). Only rows the projector
 * attributed to this institution are read. "Stuck" is the planner's rule, imported from the engine.
 *
 * Model numbers never leave this module: no mastery likelihood or uncertainty (BKT is shadow), no FSRS
 * stability, difficulty or due date. Misconception counts are returned raw; the caller must suppress them.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { STUCK_MIN_ATTEMPT_DAYS, isStuckSkillState } from '@planthepath/learning-orchestrator/src/index.js';
import { consentPurposeHeldSql } from './consent-purposes.js';
import { institutionStudentScopeSql } from './institution-scope.js';
import type { PersistenceDb } from './repositories.js';

type Rows<T> = { rows: T[] };

/** At most this many stuck skills are returned, most-stuck first. */
export const COHORT_MAX_STUCK_SKILLS = 100;
/** At most this many due skill names per student in the due list. */
export const COHORT_MAX_DUE_SKILLS_PER_STUDENT = 20;
/** At most this many misconception codes are returned (before suppression), most common first. */
export const COHORT_MAX_MISCONCEPTIONS = 50;

export interface CohortStudent {
  readonly profileId: string;
  readonly studentUserId: string;
  readonly fullName: string;
  readonly rollNumber: string;
}

export interface CohortStuckSkill {
  readonly skillId: string;
  readonly skillName: string;
  readonly students: readonly CohortStudent[];
}

export interface CohortMisconceptionCount {
  readonly code: string;
  readonly title: string;
  readonly skillName: string;
  /** Raw count of students holding it. The caller suppresses it before it leaves the server. */
  readonly students: number;
}

export interface CohortDueStudent extends CohortStudent {
  readonly sortKey: string;
  readonly skillNames: readonly string[];
}

/** The students whose engine data may be read: in scope, current, consenting. */
function cohortSql(institutionId: string, scope: InstitutionStudentScope): SQL {
  return sql`
    SELECT sp.id AS profile_id, sp.student_user_id, sp.full_name, sp.institution_student_id
    FROM institution_student_profiles sp
    WHERE sp.institution_id = ${institutionId}::uuid
      AND ${institutionStudentScopeSql(scope, 'sp')}
      AND EXISTS (SELECT 1 FROM institution_relationships ir
        WHERE ir.institution_id = sp.institution_id AND ir.student_user_id = sp.student_user_id
          AND ir.state IN ('ACTIVE', 'VERIFIED') AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))
      AND ${consentPurposeHeldSql('adaptive-learning', sql`sp.student_user_id`)}
  `;
}

/** Students in scope with a current relationship (the lecturer's headcount), and how many of them consent. */
export async function cohortHeadcount(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope): Promise<{ students: number; consenting: number }> {
  const result = await db.execute(sql`
    WITH scoped AS (
      SELECT sp.student_user_id FROM institution_student_profiles sp
      WHERE sp.institution_id = ${institutionId}::uuid AND ${institutionStudentScopeSql(scope, 'sp')}
        AND EXISTS (SELECT 1 FROM institution_relationships ir
          WHERE ir.institution_id = sp.institution_id AND ir.student_user_id = sp.student_user_id
            AND ir.state IN ('ACTIVE', 'VERIFIED') AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))
    )
    SELECT (SELECT count(*) FROM scoped)::int AS students,
           (SELECT count(*) FROM (${cohortSql(institutionId, scope)}) c)::int AS consenting
  `) as Rows<{ students: number; consenting: number }>;
  return result.rows[0] ?? { students: 0, consenting: 0 };
}

/** Skills on which at least one consenting student in scope is stuck (the planner's rule), most-stuck first. */
export async function cohortStuckSkills(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope): Promise<readonly CohortStuckSkill[]> {
  const result = await db.execute(sql`
    WITH cohort AS (${cohortSql(institutionId, scope)})
    SELECT lss.skill_id, tn.name AS skill_name, lss.attempt_day_count, lss.unaided_success_count,
           c.profile_id, c.student_user_id, c.full_name, c.institution_student_id
    FROM cohort c
    JOIN learner_skill_state lss ON lss.subject_user_id = c.student_user_id AND lss.institution_id = ${institutionId}::uuid
    JOIN taxonomy_nodes tn ON tn.id = lss.skill_id
    WHERE lss.attempt_day_count >= ${STUCK_MIN_ATTEMPT_DAYS} AND lss.unaided_success_count = 0
    ORDER BY lower(c.full_name), c.profile_id
  `) as Rows<{ skill_id: string; skill_name: string; attempt_day_count: number; unaided_success_count: number; profile_id: string; student_user_id: string; full_name: string; institution_student_id: string }>;
  const bySkill = new Map<string, { skillId: string; skillName: string; students: CohortStudent[] }>();
  for (const row of result.rows) {
    // The engine's predicate is the authority; the SQL filter only narrows what is loaded.
    if (!isStuckSkillState({ attemptDayCount: Number(row.attempt_day_count), unaidedSuccessCount: Number(row.unaided_success_count) })) continue;
    const entry = bySkill.get(row.skill_id) ?? { skillId: row.skill_id, skillName: row.skill_name, students: [] };
    entry.students.push({ profileId: row.profile_id, studentUserId: row.student_user_id, fullName: row.full_name, rollNumber: row.institution_student_id });
    bySkill.set(row.skill_id, entry);
  }
  return [...bySkill.values()]
    .sort((left, right) => right.students.length - left.students.length
      || left.skillName.localeCompare(right.skillName) || (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0))
    .slice(0, COHORT_MAX_STUCK_SKILLS);
}

/** Published misconception codes active for consenting students in scope, with raw student counts, most common first. */
export async function cohortMisconceptionCounts(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope): Promise<readonly CohortMisconceptionCount[]> {
  const result = await db.execute(sql`
    WITH cohort AS (${cohortSql(institutionId, scope)}),
    held AS (
      SELECT DISTINCT held.code, c.student_user_id
      FROM cohort c
      JOIN learner_skill_state lss ON lss.subject_user_id = c.student_user_id AND lss.institution_id = ${institutionId}::uuid
      CROSS JOIN LATERAL unnest(lss.active_misconception_codes) AS held(code)
    ),
    published AS (
      SELECT DISTINCT ON (mc.code) mc.code, mc.title, tn.name AS skill_name
      FROM misconception_codes mc JOIN taxonomy_nodes tn ON tn.id = mc.skill_id
      WHERE mc.review_state = 'PUBLISHED'
      ORDER BY mc.code, mc.version DESC
    )
    SELECT p.code, p.title, p.skill_name, count(*)::int AS students
    FROM held h JOIN published p ON p.code = h.code
    GROUP BY p.code, p.title, p.skill_name
    ORDER BY count(*) DESC, p.code
    LIMIT ${COHORT_MAX_MISCONCEPTIONS}
  `) as Rows<{ code: string; title: string; skill_name: string; students: number }>;
  return result.rows.map((row) => ({ code: row.code, title: row.title, skillName: row.skill_name, students: Number(row.students) }));
}

/**
 * Consenting students in scope with at least one review due now (the database's clock — the scheduler's
 * "due" rule: `review_due_at ≤ now()`), keyset-paginated by (lower(full name), profile id). Returns the
 * names of the due skills, never a date.
 */
export async function cohortDueReviewStudents(
  db: PersistenceDb,
  institutionId: string,
  scope: InstitutionStudentScope,
  page: { readonly limit: number; readonly cursor: readonly [string, string] | null },
): Promise<{ readonly students: readonly CohortDueStudent[]; readonly hasMore: boolean }> {
  const result = await db.execute(sql`
    WITH cohort AS (${cohortSql(institutionId, scope)})
    SELECT c.profile_id, c.student_user_id, c.full_name, c.institution_student_id, lower(c.full_name) AS sort_key,
           (array_agg(tn.name ORDER BY tn.name, tn.id))[1:${COHORT_MAX_DUE_SKILLS_PER_STUDENT}::int] AS skill_names
    FROM cohort c
    JOIN learner_skill_state lss ON lss.subject_user_id = c.student_user_id AND lss.institution_id = ${institutionId}::uuid
    JOIN taxonomy_nodes tn ON tn.id = lss.skill_id
    WHERE lss.review_due_at IS NOT NULL AND lss.review_due_at <= now()
      AND (${page.cursor?.[0] ?? null}::text IS NULL OR (lower(c.full_name), c.profile_id) > (${page.cursor?.[0] ?? null}::text, ${page.cursor?.[1] ?? null}::uuid))
    GROUP BY c.profile_id, c.student_user_id, c.full_name, c.institution_student_id
    ORDER BY lower(c.full_name), c.profile_id
    LIMIT ${page.limit + 1}
  `) as Rows<{ profile_id: string; student_user_id: string; full_name: string; institution_student_id: string; sort_key: string; skill_names: string[] }>;
  return {
    students: result.rows.slice(0, page.limit).map((row) => ({
      profileId: row.profile_id, studentUserId: row.student_user_id, fullName: row.full_name, rollNumber: row.institution_student_id,
      sortKey: row.sort_key, skillNames: row.skill_names ?? [],
    })),
    hasMore: result.rows.length > page.limit,
  };
}
