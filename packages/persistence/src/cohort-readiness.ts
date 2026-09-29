/**
 * Cohort readiness by career role and preparation sprints (INST-17): where a college's scoped cohort stands against
 * the essential requirements of one career role, which students a sprint reaches, and how a sprint is going.
 *
 * Why it exists: the placement office's journey (UAT J11) is "pick an employer's role, see the cohort, run a
 * sprint". Every status here is computed by the code that computes a student's own gap — `projectTopicMastery`
 * over their `evidence_records`, then `computeCareerGap` — so the college's figure and the student's gap page
 * cannot disagree for the same evidence. Design: docs/architecture/preparation-sprints-table-design.md.
 *
 * Rules held here:
 *   - Raw per-student statuses never leave this module's callers: the API publishes only suppressed counts.
 *   - The mastery ratio and a requirement's target are never returned; statuses are bands.
 *   - No adaptive-engine table (learner_skill_state, attempt events as a profile) is read for readiness; the
 *     sprint's "work done" uses INST-16's done rule, bounded by the progress cut-off.
 *   - Times come from the database clock.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  computeCareerGap,
  projectTopicMastery,
  type CareerRequirement,
  type EvidenceInput,
} from '@planthepath/career-readiness/src/index.js';
import type { InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import { institutionStudentScopeSql } from './institution-scope.js';
import type { PersistenceDb } from './repositories.js';

type Rows<T> = { rows: T[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rows<T>(db: PersistenceDb, query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as Rows<T>).rows;
}

const uuidArray = (ids: readonly string[]): SQL => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** One student's standing on one requirement: a partition, so every table of these can be suppressed as one. */
export const COHORT_REQUIREMENT_CELLS = ['MET', 'PARTIAL', 'MISSING', 'NOT_ENOUGH_EVIDENCE', 'NO_EVIDENCE'] as const;
export type CohortRequirementCell = (typeof COHORT_REQUIREMENT_CELLS)[number];
export const COHORT_GAP_CELLS: readonly CohortRequirementCell[] = ['PARTIAL', 'MISSING'];
export const COHORT_UNKNOWN_CELLS: readonly CohortRequirementCell[] = ['NOT_ENOUGH_EVIDENCE', 'NO_EVIDENCE'];

/** How a sprint is going for one student it reached (a partition). */
export const SPRINT_PROGRESS_CELLS = ['MET', 'NEW_EVIDENCE', 'NO_NEW_EVIDENCE'] as const;
export type SprintProgressCell = (typeof SPRINT_PROGRESS_CELLS)[number];

/** Why a sprint was run (closed; stored and checked by 0085). */
export const SPRINT_REASON_CODES = ['CAMPUS_DRIVE_PREPARATION', 'ESSENTIAL_GAP', 'PLACEMENT_SEASON'] as const;
/** Why a sprint was ended early (INST-16's withdrawal vocabulary: the sprint's assignment is withdrawn with it). */
export const SPRINT_CANCEL_REASON_CODES = ['NO_LONGER_NEEDED', 'SET_IN_ERROR', 'REPLACED'] as const;
export const SPRINT_MIN_DAYS = 7;
export const SPRINT_MAX_DAYS = 42;
/** At most this many students per sprint (INST-16's cap). */
export const SPRINT_MAX_STUDENTS = 500;

export interface CohortRoleRequirement {
  readonly topicId: string;
  readonly skillName: string;
  readonly level: CareerRequirement['requirementLevel'];
  readonly requirement: CareerRequirement;
}

export interface CohortRole {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly catalogueCode: string | null;
  readonly catalogueTitle: string | null;
  readonly releaseLabel: string | null;
  readonly active: boolean;
}

/** Active career roles with how many essential and other live requirements each has. */
export async function listCohortRoles(db: PersistenceDb): Promise<readonly (CohortRole & { readonly essential: number; readonly other: number })[]> {
  const found = await rows<{ id: string; code: string; title: string; catalogue_code: string | null; catalogue_title: string | null; release_label: string | null; essential: number; other: number }>(db, sql`
    SELECT r.id::text AS id, r.code, r.title, r.catalogue_code, r.catalogue_title, r.release_label,
           count(q.id) FILTER (WHERE q.requirement_level = 'ESSENTIAL')::int AS essential,
           count(q.id) FILTER (WHERE q.requirement_level <> 'ESSENTIAL')::int AS other
    FROM career_roles r LEFT JOIN career_role_requirements q ON q.career_role_id = r.id
    WHERE r.active
    GROUP BY r.id
    ORDER BY lower(r.title), r.id
    LIMIT 300
  `);
  return found.map((row) => ({
    id: row.id, code: row.code, title: row.title, catalogueCode: row.catalogue_code, catalogueTitle: row.catalogue_title,
    releaseLabel: row.release_label, active: true, essential: Number(row.essential), other: Number(row.other),
  }));
}

export interface CohortDriveRole {
  readonly driveId: string;
  readonly employerName: string;
  readonly jobTitle: string;
  readonly state: string;
  readonly careerRoleId: string;
  readonly roleTitle: string;
}

/**
 * Live campus drives at this college (APPROVED or SCHEDULED) whose job's current version maps to a catalogue role:
 * "an employer's role target". Reads the job's title and the employer's name only — never pay.
 */
export async function listDriveRoles(db: PersistenceDb, institutionId: string, driveId?: string): Promise<readonly CohortDriveRole[]> {
  return (await rows<{ drive_id: string; employer_name: string; job_title: string; state: string; career_role_id: string; role_title: string }>(db, sql`
    SELECT cd.id::text AS drive_id, emp.legal_name AS employer_name, ov.title AS job_title, cd.state,
           r.id::text AS career_role_id, r.title AS role_title
    FROM campus_drives cd
    JOIN organizations emp ON emp.id = cd.employer_id
    JOIN opportunities o ON o.id = cd.opportunity_id
    JOIN opportunity_versions ov ON ov.id = o.current_version_id
    JOIN career_roles r ON r.id = ov.career_role_id AND r.active
    WHERE cd.institution_id = ${institutionId}::uuid AND cd.state IN ('APPROVED', 'SCHEDULED')
      ${driveId ? sql`AND cd.id = ${driveId}::uuid` : sql``}
    ORDER BY coalesce(cd.scheduled_start_at, cd.created_at) DESC, cd.id
    LIMIT 100
  `)).map((row) => ({
    driveId: row.drive_id, employerName: row.employer_name, jobTitle: row.job_title, state: row.state,
    careerRoleId: row.career_role_id, roleTitle: row.role_title,
  }));
}

export async function loadCohortRole(db: PersistenceDb, careerRoleId: string): Promise<(CohortRole & { readonly requirements: readonly CohortRoleRequirement[] }) | null> {
  if (!UUID.test(careerRoleId)) return null;
  const [role] = await rows<{ id: string; code: string; title: string; catalogue_code: string | null; catalogue_title: string | null; release_label: string | null; active: boolean }>(db, sql`
    SELECT id::text AS id, code, title, catalogue_code, catalogue_title, release_label, active FROM career_roles WHERE id = ${careerRoleId}::uuid
  `);
  if (!role) return null;
  const requirements = await rows<{ topic_id: string; skill_name: string; level: CareerRequirement['requirementLevel']; target: string }>(db, sql`
    SELECT q.topic_id::text AS topic_id, tn.name AS skill_name, q.requirement_level AS level, q.target_mastery::text AS target
    FROM career_role_requirements q JOIN taxonomy_nodes tn ON tn.id = q.topic_id
    WHERE q.career_role_id = ${careerRoleId}::uuid
    ORDER BY CASE q.requirement_level WHEN 'ESSENTIAL' THEN 0 WHEN 'IMPORTANT' THEN 1 ELSE 2 END, lower(tn.name), q.topic_id
  `);
  return {
    id: role.id, code: role.code, title: role.title, catalogueCode: role.catalogue_code, catalogueTitle: role.catalogue_title,
    releaseLabel: role.release_label, active: role.active === true,
    requirements: requirements.map((row) => ({
      topicId: row.topic_id.toLowerCase(), skillName: row.skill_name, level: row.level,
      requirement: { topicId: row.topic_id.toLowerCase(), requirementLevel: row.level, targetMastery: Number(row.target) },
    })),
  };
}

// ---------------------------------------------------------------------------
// Populations
// ---------------------------------------------------------------------------

/**
 * The cohort as it stood at the end of a reporting month, inside `scope` (on the student's current units): the
 * readiness report's relationship rule — VERIFIED/ACTIVE, or TRANSFERRED/GRADUATED with an end date, in force at
 * the month's end (`periodEndExclusive`, the first instant of the next month).
 */
export async function monthEndCohort(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope, periodEndExclusive: string): Promise<readonly string[]> {
  return (await rows<{ id: string }>(db, sql`
    SELECT DISTINCT isp.student_user_id::text AS id
    FROM institution_student_profiles isp
    JOIN institution_relationships ir ON ir.institution_id = isp.institution_id AND ir.student_user_id = isp.student_user_id
      AND (ir.state IN ('VERIFIED', 'ACTIVE') OR (ir.state IN ('TRANSFERRED', 'GRADUATED') AND ir.effective_to IS NOT NULL))
      AND ir.effective_from < ${periodEndExclusive}::timestamptz
      AND (ir.effective_to IS NULL OR ir.effective_to >= ${periodEndExclusive}::timestamptz)
    WHERE isp.institution_id = ${institutionId}::uuid AND ${institutionStudentScopeSql(scope, 'isp')}
  `)).map((row) => row.id.toLowerCase());
}

/** SQL: `student` has a current relationship with `institution` (INST-16's rule). */
function currentRelationshipSql(institution: SQL, student: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM institution_relationships ir
    WHERE ir.institution_id = ${institution} AND ir.student_user_id = ${student}
      AND ir.state IN ('ACTIVE', 'VERIFIED') AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))`;
}

/** Current, active students of the college inside `scope` (the population a sprint is chosen from). */
export async function currentScopedStudents(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope): Promise<readonly string[]> {
  return (await rows<{ id: string }>(db, sql`
    SELECT DISTINCT sp.student_user_id::text AS id
    FROM institution_student_profiles sp JOIN users u ON u.id = sp.student_user_id
    WHERE sp.institution_id = ${institutionId}::uuid AND sp.status = 'ACTIVE' AND u.state = 'ACTIVE'
      AND ${institutionStudentScopeSql(scope, 'sp')}
      AND ${currentRelationshipSql(sql`sp.institution_id`, sql`sp.student_user_id`)}
  `)).map((row) => row.id.toLowerCase());
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * Each student's cell on each requirement, from evidence that occurred before `cutoff`. The same two functions as
 * the student's own gap (`career-targets.ts`); NOT_ENOUGH_EVIDENCE and NO_EVIDENCE split the gap engine's UNKNOWN.
 */
export async function requirementStatuses(db: PersistenceDb, input: {
  readonly studentUserIds: readonly string[];
  readonly requirements: readonly CareerRequirement[];
  readonly cutoff: string;
}): Promise<ReadonlyMap<string, ReadonlyMap<string, CohortRequirementCell>>> {
  const statuses = new Map<string, Map<string, CohortRequirementCell>>();
  if (input.studentUserIds.length === 0 || input.requirements.length === 0) {
    for (const student of input.studentUserIds) statuses.set(student, new Map(input.requirements.map((requirement) => [requirement.topicId, 'NO_EVIDENCE' as const])));
    return statuses;
  }
  const topics = [...new Set(input.requirements.map((requirement) => requirement.topicId))];
  const evidence = await rows<EvidenceInput & { occurredAt: Date | string }>(db, sql`
    SELECT id::text AS id, subject_user_id::text AS "subjectUserId", evidence_type AS "evidenceType", topic_id::text AS "topicId",
           demonstrated, possible, source_aggregate_type AS "sourceAggregateType", source_aggregate_id::text AS "sourceAggregateId",
           content_version AS "contentVersion", occurred_at AS "occurredAt", supersedes_evidence_id::text AS "supersedesEvidenceId"
    FROM evidence_records
    WHERE subject_user_id = ANY(${uuidArray(input.studentUserIds)}) AND topic_id = ANY(${uuidArray(topics)})
      AND occurred_at < ${input.cutoff}::timestamptz
    ORDER BY occurred_at, id
  `);
  const byStudent = new Map<string, EvidenceInput[]>();
  for (const row of evidence) {
    const item: EvidenceInput = {
      id: row.id.toLowerCase(), subjectUserId: row.subjectUserId.toLowerCase(), evidenceType: row.evidenceType, topicId: row.topicId.toLowerCase(),
      demonstrated: Number(row.demonstrated), possible: Number(row.possible), sourceAggregateType: row.sourceAggregateType,
      sourceAggregateId: row.sourceAggregateId, contentVersion: row.contentVersion, occurredAt: new Date(row.occurredAt).toISOString(),
      ...(row.supersedesEvidenceId ? { supersedesEvidenceId: row.supersedesEvidenceId.toLowerCase() } : {}),
    };
    byStudent.set(item.subjectUserId, [...(byStudent.get(item.subjectUserId) ?? []), item]);
  }
  for (const student of input.studentUserIds) {
    const projections = projectTopicMastery(byStudent.get(student) ?? []);
    const projected = new Set(projections.map((projection) => projection.topicId));
    const gap = computeCareerGap(input.requirements, projections);
    const cells = new Map<string, CohortRequirementCell>();
    for (const item of gap.items) {
      cells.set(item.topicId, item.status === 'UNKNOWN'
        ? (projected.has(item.topicId) ? 'NOT_ENOUGH_EVIDENCE' : 'NO_EVIDENCE')
        : item.status);
    }
    statuses.set(student, cells);
  }
  return statuses;
}

/** Published resources on one skill that can be assigned (INST-16's "published and current"), at most 10. */
export async function resourcesForSkill(db: PersistenceDb, topicId: string): Promise<readonly { kind: 'PRACTICE' | 'LESSON'; skillId: string; lessonVersionId: string | null; title: string }[]> {
  return (await rows<{ kind: 'PRACTICE' | 'LESSON'; skill_id: string; lesson_version_id: string | null; title: string }>(db, sql`
    SELECT * FROM (
      SELECT 'PRACTICE'::text AS kind, tn.id::text AS skill_id, NULL::text AS lesson_version_id, tn.name AS title, 0 AS rank
      FROM taxonomy_nodes tn WHERE tn.id = ${topicId}::uuid AND learning_content_published('PRACTICE', tn.id, NULL)
      UNION ALL
      SELECT 'LESSON'::text, l.topic_id::text, l.id::text, l.title, 1
      FROM lesson_versions l WHERE l.topic_id = ${topicId}::uuid AND learning_content_published('LESSON', l.topic_id, l.id)
    ) r ORDER BY r.rank, lower(r.title), r.lesson_version_id
    LIMIT 10
  `)).map((row) => ({ kind: row.kind, skillId: row.skill_id.toLowerCase(), lessonVersionId: row.lesson_version_id?.toLowerCase() ?? null, title: row.title }));
}

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

export interface SprintHeader {
  readonly id: string;
  readonly assignmentId: string;
  readonly careerRoleId: string;
  readonly roleTitle: string;
  readonly topicId: string;
  readonly skillName: string;
  readonly contentKind: 'PRACTICE' | 'LESSON';
  readonly resourceTitle: string;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly includeUnknown: boolean;
  readonly unitName: string | null;
  readonly drive: { readonly employerName: string; readonly jobTitle: string } | null;
  readonly createdByUserId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly cancelledAt: string | null;
  readonly state: 'RUNNING' | 'ENDED' | 'CANCELLED';
  /** The fixed progress cut-off: the start of the current UTC day while running; the end (or early end) after. */
  readonly cutoff: string;
}

type SprintRow = {
  id: string; assignment_id: string; career_role_id: string; role_title: string; topic_id: string; skill_name: string;
  content_kind: 'PRACTICE' | 'LESSON'; resource_title: string; reason_code: string; note: string | null; include_unknown: boolean;
  unit_name: string | null; employer_name: string | null; job_title: string | null; created_by_user_id: string;
  starts_at: Date | string; ends_at: Date | string; cancelled_at: Date | string | null; state: SprintHeader['state']; cutoff: Date | string;
};

const sprintSelect = sql`
  SELECT ps.id::text AS id, ps.assignment_id::text AS assignment_id, ps.career_role_id::text AS career_role_id, r.title AS role_title,
         ps.topic_id::text AS topic_id, tn.name AS skill_name, a.content_kind,
         CASE WHEN a.content_kind = 'LESSON' THEN (SELECT l.title FROM lesson_versions l WHERE l.id = a.lesson_version_id) ELSE tn.name END AS resource_title,
         ps.reason_code, ps.note, ps.include_unknown, iu.name AS unit_name, emp.legal_name AS employer_name, ov.title AS job_title,
         ps.created_by_user_id::text AS created_by_user_id, ps.starts_at, ps.ends_at, ps.cancelled_at,
         CASE WHEN ps.cancelled_at IS NOT NULL THEN 'CANCELLED' WHEN ps.ends_at <= now() THEN 'ENDED' ELSE 'RUNNING' END AS state,
         LEAST(ps.ends_at, coalesce(ps.cancelled_at, ps.ends_at), (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS cutoff
  FROM preparation_sprints ps
  JOIN learning_assignments a ON a.id = ps.assignment_id
  JOIN career_roles r ON r.id = ps.career_role_id
  JOIN taxonomy_nodes tn ON tn.id = ps.topic_id
  LEFT JOIN institution_units iu ON iu.id = ps.scope_unit_id
  LEFT JOIN campus_drives cd ON cd.id = ps.campus_drive_id
  LEFT JOIN organizations emp ON emp.id = cd.employer_id
  LEFT JOIN opportunities o ON o.id = cd.opportunity_id
  LEFT JOIN opportunity_versions ov ON ov.id = o.current_version_id`;

const iso = (value: Date | string): string => new Date(value).toISOString();

function mapSprint(row: SprintRow): SprintHeader {
  return {
    id: row.id.toLowerCase(), assignmentId: row.assignment_id.toLowerCase(), careerRoleId: row.career_role_id.toLowerCase(), roleTitle: row.role_title,
    topicId: row.topic_id.toLowerCase(), skillName: row.skill_name, contentKind: row.content_kind, resourceTitle: row.resource_title,
    reasonCode: row.reason_code, note: row.note, includeUnknown: row.include_unknown === true, unitName: row.unit_name,
    drive: row.employer_name && row.job_title ? { employerName: row.employer_name, jobTitle: row.job_title } : null,
    createdByUserId: row.created_by_user_id.toLowerCase(), startsAt: iso(row.starts_at), endsAt: iso(row.ends_at),
    cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null, state: row.state, cutoff: iso(row.cutoff),
  };
}

/** The college's sprints, newest first. */
export async function listSprints(db: PersistenceDb, institutionId: string, limit: number): Promise<readonly SprintHeader[]> {
  return (await rows<SprintRow>(db, sql`
    ${sprintSelect}
    WHERE ps.institution_id = ${institutionId}::uuid
    ORDER BY ps.starts_at DESC, ps.id DESC
    LIMIT ${limit}
  `)).map(mapSprint);
}

export async function loadSprint(db: PersistenceDb, institutionId: string, sprintId: string, lock = false): Promise<SprintHeader | null> {
  if (!UUID.test(sprintId)) return null;
  const [row] = await rows<SprintRow>(db, sql`
    ${sprintSelect}
    WHERE ps.institution_id = ${institutionId}::uuid AND ps.id = ${sprintId}::uuid
    ${lock ? sql`FOR UPDATE OF ps` : sql``}
  `);
  return row ? mapSprint(row) : null;
}

/**
 * Per student the sprint reached who is still a current student inside `scope`: whether they finished the assigned
 * work before the cut-off (INST-16's done rule, bounded) and whether evidence on the skill occurred in
 * [starts_at, cut-off). Raw facts; the caller turns them into suppressed counts.
 */
export async function sprintStudentFacts(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope, sprint: SprintHeader): Promise<readonly { studentUserId: string; done: boolean; newEvidence: boolean }[]> {
  return (await rows<{ id: string; done: boolean; new_evidence: boolean }>(db, sql`
    SELECT las.student_user_id::text AS id,
      (CASE WHEN a.content_kind = 'PRACTICE' THEN EXISTS (
          SELECT 1 FROM learning_decisions d
          JOIN learning_sessions ls ON ls.source_type = 'learning_step' AND ls.source_id = d.id AND ls.ended_at IS NOT NULL
            AND ls.ended_at < ${sprint.cutoff}::timestamptz
          WHERE d.subject_user_id = las.student_user_id AND d.skill_id = a.skill_id AND d.decided_at >= a.assigned_at
            AND EXISTS (SELECT 1 FROM learning_attempt_events e WHERE e.source_attempt_type = 'learning_step' AND e.source_attempt_id = d.id AND e.answered))
        ELSE EXISTS (
          SELECT 1 FROM learner_progress p
          JOIN lesson_versions pl ON pl.id = p.lesson_version_id
          JOIN lesson_versions tl ON tl.id = a.lesson_version_id AND tl.stable_key = pl.stable_key
          WHERE p.subject_user_id = las.student_user_id AND p.state = 'COMPLETED' AND p.completed_at < ${sprint.cutoff}::timestamptz)
        END) AS done,
      EXISTS (SELECT 1 FROM evidence_records er WHERE er.subject_user_id = las.student_user_id AND er.topic_id = a.skill_id
        AND er.occurred_at >= ${sprint.startsAt}::timestamptz AND er.occurred_at < ${sprint.cutoff}::timestamptz) AS new_evidence
    FROM learning_assignment_students las
    JOIN learning_assignments a ON a.id = las.assignment_id
    WHERE las.assignment_id = ${sprint.assignmentId}::uuid
      AND EXISTS (SELECT 1 FROM institution_student_profiles sp WHERE sp.institution_id = ${institutionId}::uuid
        AND sp.student_user_id = las.student_user_id AND ${institutionStudentScopeSql(scope, 'sp')})
      AND ${currentRelationshipSql(sql`${institutionId}::uuid`, sql`las.student_user_id`)}
  `)).map((row) => ({ studentUserId: row.id.toLowerCase(), done: row.done === true, newEvidence: row.new_evidence === true }));
}
