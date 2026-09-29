/**
 * Faculty learning actions (INST-16): the published content a lecturer may assign, the planner's faculty
 * constraints loaded from what lecturers assigned and overrode, and the reads the lecturer's and the student's
 * screens need.
 *
 * Why it exists: planner v1 (ENG-08) was built with a slot for faculty constraints and a loader that passed
 * none. This module is that loader, and the one place that decides whether an assignment is still open.
 * A faculty action is a constraint the planner honours — nothing here writes mastery, evidence, attempts or
 * readiness. Design and reasoning: docs/architecture/faculty-learning-actions-table-design.md.
 *
 * Rules held here:
 *   - "Published and current" is the SQL function `learning_content_published` (0082), used by the insert
 *     guards and by every read below, so content withdrawn later stops being a constraint at once.
 *   - An assignment is open while it is not withdrawn, the student still has a current relationship with the
 *     assigning college, its content is published and it is not done. Done is derived from the student's own
 *     records (a finished learning step on the skill after it was assigned; a completed lesson), never stored.
 *   - A pending override is passed to the planner once; the decision that applies it marks it APPLIED in the
 *     same transaction (the 0082 guard checks the decision carries it), so it is replayable from the audit.
 *   - No model number and no readiness value is read or returned. Times come from the database clock.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { InstitutionStudentScope } from '@planthepath/authorization/src/index.js';
import type { PlannerAssignment, PlannerConstraints, PlannerOverride } from '@planthepath/learning-orchestrator/src/index.js';
import { institutionStudentScopeSql } from './institution-scope.js';
import type { PersistenceDb } from './repositories.js';

type Rows<T> = { rows: T[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rows<T>(db: PersistenceDb, query: SQL): Promise<T[]> {
  return ((await db.execute(query)) as Rows<T>).rows;
}

export const LEARNING_CONTENT_KINDS = ['PRACTICE', 'LESSON'] as const;
export type LearningContentKind = (typeof LEARNING_CONTENT_KINDS)[number];

/** The actions a lecturer may set as a student's next step. No REMEDIATE: faculty never see a student's misconceptions. */
export const FACULTY_OVERRIDE_ACTIONS = ['LEARN', 'PRACTICE', 'REVIEW'] as const;
export type FacultyOverrideAction = (typeof FACULTY_OVERRIDE_ACTIONS)[number];

/** Why a lecturer set a student's next step (decision 10.2 #11). Closed; shown to the student in plain words. */
export const FACULTY_OVERRIDE_REASON_CODES = [
  'CLASS_TOPIC_ALIGNMENT', 'PREREQUISITE_FIRST', 'REVISIT_FUNDAMENTALS', 'UPCOMING_ASSESSMENT', 'STUDENT_REQUEST', 'FACULTY_JUDGEMENT',
] as const;
export type FacultyOverrideReasonCode = (typeof FACULTY_OVERRIDE_REASON_CODES)[number];

/** Why an assignment or a pending override was withdrawn. */
export const FACULTY_WITHDRAW_REASON_CODES = ['NO_LONGER_NEEDED', 'SET_IN_ERROR', 'REPLACED'] as const;

/** At most this many open assignments reach the planner (oldest first; the planner takes the first that fits). */
export const PLANNER_ASSIGNMENT_LIMIT = 20;

export interface LearningResourceRef {
  readonly kind: LearningContentKind;
  readonly skillId: string;
  readonly lessonVersionId: string | null;
}

export interface LearningResource extends LearningResourceRef {
  readonly title: string;
  readonly skillName: string;
  /** LESSON: the module's title. */
  readonly moduleTitle: string | null;
  /** PRACTICE: how many published questions the set has (a fact about content, not about anyone). */
  readonly questionCount: number | null;
}

const publishedSql = (kind: SQL, skill: SQL, lesson: SQL): SQL => sql`learning_content_published(${kind}, ${skill}, ${lesson})`;

const resourceUnion = sql`
  SELECT 'PRACTICE'::text AS kind, tn.id AS skill_id, NULL::uuid AS lesson_version_id, tn.name AS title, tn.name AS skill_name,
         NULL::text AS module_title, count(DISTINCT q.id)::int AS question_count, tn.id AS sort_id
  FROM taxonomy_nodes tn
  JOIN question_versions q ON q.topic_id = tn.id AND q.superseded_at IS NULL
  JOIN question_answer_keys k ON k.question_version_id = q.id
  JOIN release_manifests rm ON rm.id = q.release_manifest_id AND rm.status = 'PUBLISHED'
  GROUP BY tn.id, tn.name
  UNION ALL
  SELECT 'LESSON'::text, l.topic_id, l.id, l.title, tn.name, m.title, NULL::int, l.id
  FROM lesson_versions l
  JOIN learning_modules m ON m.id = l.module_id
  JOIN release_manifests rm ON rm.id = m.release_manifest_id AND rm.status = 'PUBLISHED'
  JOIN taxonomy_nodes tn ON tn.id = l.topic_id
  WHERE l.superseded_at IS NULL`;

interface ResourceRow {
  kind: LearningContentKind; skill_id: string; lesson_version_id: string | null; title: string; skill_name: string;
  module_title: string | null; question_count: number | null; sort_title: string; sort_id: string;
}

function mapResource(row: ResourceRow): LearningResource {
  return {
    kind: row.kind, skillId: row.skill_id, lessonVersionId: row.lesson_version_id, title: row.title, skillName: row.skill_name,
    moduleTitle: row.module_title, questionCount: row.question_count === null ? null : Number(row.question_count),
  };
}

function likePattern(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** Published content a lecturer may assign, keyset-paginated on (lower(title), kind, id). */
export async function listLearningResources(db: PersistenceDb, input: {
  readonly q?: string | null; readonly kind?: LearningContentKind | null; readonly limit: number;
  readonly cursor?: readonly [string, string, string] | null;
}): Promise<{ readonly resources: readonly LearningResource[]; readonly nextCursor: readonly [string, string, string] | null }> {
  const q = input.q ? likePattern(input.q) : null;
  const cursor = input.cursor ?? null;
  const found = await rows<ResourceRow>(db, sql`
    SELECT r.*, lower(r.title) AS sort_title FROM (${resourceUnion}) r
    WHERE (${input.kind ?? null}::text IS NULL OR r.kind = ${input.kind ?? null})
      AND (${q}::text IS NULL OR lower(r.title) LIKE ${q} OR lower(r.skill_name) LIKE ${q})
      AND (${cursor?.[0] ?? null}::text IS NULL
        OR (lower(r.title) COLLATE "C", r.kind, r.sort_id::text) > (${cursor?.[0] ?? null}::text COLLATE "C", ${cursor?.[1] ?? null}::text, ${cursor?.[2] ?? null}::text))
    ORDER BY lower(r.title) COLLATE "C", r.kind, r.sort_id::text
    LIMIT ${input.limit + 1}
  `);
  const page = found.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    resources: page.map(mapResource),
    nextCursor: found.length > input.limit && last ? [last.sort_title, last.kind, String(last.sort_id)] : null,
  };
}

/** One published resource, or null when it is not published and current (or does not exist). */
export async function resolveLearningResource(db: PersistenceDb, ref: LearningResourceRef): Promise<LearningResource | null> {
  if (!UUID.test(ref.skillId) || (ref.lessonVersionId !== null && !UUID.test(ref.lessonVersionId))) return null;
  const [row] = await rows<ResourceRow>(db, sql`
    SELECT r.*, lower(r.title) AS sort_title FROM (${resourceUnion}) r
    WHERE r.kind = ${ref.kind} AND r.skill_id = ${ref.skillId}::uuid
      AND r.lesson_version_id IS NOT DISTINCT FROM ${ref.lessonVersionId}::uuid
    LIMIT 1
  `);
  return row ? mapResource(row) : null;
}

// ---------------------------------------------------------------------------
// Open assignments and the planner's constraints
// ---------------------------------------------------------------------------

/** SQL: the student `a.student` has finished the assignment `a` (derived from their own records). */
function assignmentDoneSql(assignment: string, student: SQL): SQL {
  const a = sql.raw(assignment);
  return sql`(CASE WHEN ${a}.content_kind = 'PRACTICE' THEN EXISTS (
      SELECT 1 FROM learning_decisions done_d
      JOIN learning_sessions done_s ON done_s.source_type = 'learning_step' AND done_s.source_id = done_d.id AND done_s.ended_at IS NOT NULL
      WHERE done_d.subject_user_id = ${student} AND done_d.skill_id = ${a}.skill_id AND done_d.decided_at >= ${a}.assigned_at
        AND EXISTS (SELECT 1 FROM learning_attempt_events done_e
          WHERE done_e.source_attempt_type = 'learning_step' AND done_e.source_attempt_id = done_d.id AND done_e.answered))
    ELSE EXISTS (
      SELECT 1 FROM learner_progress done_p
      JOIN lesson_versions done_l ON done_l.id = done_p.lesson_version_id
      JOIN lesson_versions done_t ON done_t.id = ${a}.lesson_version_id AND done_t.stable_key = done_l.stable_key
      WHERE done_p.subject_user_id = ${student} AND done_p.state = 'COMPLETED')
    END)`;
}

/** SQL: `student` has a current relationship with `institution`. */
function currentRelationshipSql(institution: SQL, student: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM institution_relationships ir
    WHERE ir.institution_id = ${institution} AND ir.student_user_id = ${student}
      AND ir.state IN ('ACTIVE', 'VERIFIED') AND ir.effective_from <= now() AND (ir.effective_to IS NULL OR ir.effective_to > now()))`;
}

/**
 * The faculty constraints planner v1 decides from, for one student, read now: the pending override (if its
 * content is still published and the student is still at that college) and the open assignments, oldest first.
 * Locks the pending override so a concurrent withdrawal waits for the decision that applies it.
 */
export async function loadFacultyConstraints(db: PersistenceDb, subjectUserId: string): Promise<PlannerConstraints> {
  if (!UUID.test(subjectUserId)) throw new Error('subjectUserId must be a UUID');
  const [pending] = await rows<{ id: string; created_by_user_id: string; reason_code: string; action: FacultyOverrideAction; skill_id: string }>(db, sql`
    SELECT o.id::text AS id, o.created_by_user_id::text AS created_by_user_id, o.reason_code, o.action, o.skill_id::text AS skill_id
    FROM learning_plan_overrides o
    WHERE o.student_user_id = ${subjectUserId}::uuid AND o.state = 'PENDING'
      AND ${publishedSql(sql`o.content_kind`, sql`o.skill_id`, sql`o.lesson_version_id`)}
      AND ${currentRelationshipSql(sql`o.institution_id`, sql`o.student_user_id`)}
    FOR UPDATE OF o
  `);
  const override: PlannerOverride | null = pending ? {
    overrideId: pending.id.toLowerCase(), byUserId: pending.created_by_user_id.toLowerCase(), reasonCode: pending.reason_code,
    action: pending.action, skillId: pending.skill_id.toLowerCase(), focusMisconceptionCode: null,
  } : null;
  const open = await rows<{ id: string; skill_id: string; assigned_at: Date | string }>(db, sql`
    SELECT a.id::text AS id, a.skill_id::text AS skill_id, a.assigned_at
    FROM learning_assignment_students s
    JOIN learning_assignments a ON a.id = s.assignment_id
    WHERE s.student_user_id = ${subjectUserId}::uuid AND a.withdrawn_at IS NULL
      AND ${currentRelationshipSql(sql`a.institution_id`, sql`s.student_user_id`)}
      AND ${publishedSql(sql`a.content_kind`, sql`a.skill_id`, sql`a.lesson_version_id`)}
      AND NOT ${assignmentDoneSql('a', sql`s.student_user_id`)}
    ORDER BY a.assigned_at, a.id
    LIMIT ${PLANNER_ASSIGNMENT_LIMIT}
  `);
  const assignments: PlannerAssignment[] = open.map((row) => ({
    assignmentId: row.id.toLowerCase(), skillId: row.skill_id.toLowerCase(), assignedAt: new Date(row.assigned_at).toISOString(),
  }));
  return { override, assignments };
}

/** Marks the override applied by the decision that carries it (same transaction as the decision's insert). */
export async function markOverrideApplied(db: PersistenceDb, overrideId: string, decisionId: string): Promise<void> {
  const updated = await rows<{ id: string }>(db, sql`
    UPDATE learning_plan_overrides SET state = 'APPLIED', applied_decision_id = ${decisionId}::uuid, applied_at = now()
    WHERE id = ${overrideId}::uuid AND state = 'PENDING'
    RETURNING id::text AS id
  `);
  if (updated.length !== 1) throw new Error('the override applied by this decision is no longer pending');
}

// ---------------------------------------------------------------------------
// Students in the lecturer's write scope
// ---------------------------------------------------------------------------

export interface ScopedStudent {
  readonly profileId: string;
  readonly studentUserId: string;
  readonly fullName: string;
  readonly rollNumber: string;
}

/** SQL for current, active students of the college inside `scope` (profile alias `sp`). */
function scopedStudentsSql(institutionId: string, scope: InstitutionStudentScope): SQL {
  return sql`
    SELECT sp.id::text AS profile_id, sp.student_user_id::text AS student_user_id, sp.full_name, sp.institution_student_id,
           sp.department_unit_id, sp.program_unit_id, sp.batch_unit_id, sp.section_unit_id
    FROM institution_student_profiles sp JOIN users u ON u.id = sp.student_user_id
    WHERE sp.institution_id = ${institutionId}::uuid AND sp.status = 'ACTIVE' AND u.state = 'ACTIVE'
      AND ${institutionStudentScopeSql(scope, 'sp')}
      AND ${currentRelationshipSql(sql`sp.institution_id`, sql`sp.student_user_id`)}`;
}

type ScopedRow = { profile_id: string; student_user_id: string; full_name: string; institution_student_id: string };
const scoped = (row: ScopedRow): ScopedStudent => ({
  profileId: row.profile_id.toLowerCase(), studentUserId: row.student_user_id.toLowerCase(), fullName: row.full_name, rollNumber: row.institution_student_id,
});

/** The named profiles, if every one of them is a current student inside the scope; otherwise null. */
export async function scopedStudentsByProfile(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope, profileIds: readonly string[]): Promise<readonly ScopedStudent[] | null> {
  const unique = [...new Set(profileIds.map((id) => id.toLowerCase()))];
  if (unique.length === 0 || unique.some((id) => !UUID.test(id))) return null;
  const found = await rows<ScopedRow>(db, sql`
    SELECT * FROM (${scopedStudentsSql(institutionId, scope)}) s WHERE s.profile_id::uuid = ANY(${`{${unique.join(',')}}`}::uuid[])
    ORDER BY lower(s.full_name), s.profile_id
  `);
  return found.length === unique.length ? found.map(scoped) : null;
}

/** Current students inside the scope who belong to `unitId` (a section, or a batch and its sections). */
export async function scopedStudentsInUnit(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope, unitId: string, limit: number): Promise<readonly ScopedStudent[]> {
  const found = await rows<ScopedRow>(db, sql`
    SELECT * FROM (${scopedStudentsSql(institutionId, scope)}) s
    WHERE s.section_unit_id = ${unitId}::uuid OR s.batch_unit_id = ${unitId}::uuid OR s.program_unit_id = ${unitId}::uuid OR s.department_unit_id = ${unitId}::uuid
    ORDER BY lower(s.full_name), s.profile_id
    LIMIT ${limit}
  `);
  return found.map(scoped);
}

// ---------------------------------------------------------------------------
// The lecturer's own actions
// ---------------------------------------------------------------------------

export interface FacultyAssignmentSummary {
  readonly id: string;
  readonly resource: LearningResourceRef & { readonly title: string; readonly skillName: string };
  readonly target: { readonly kind: 'UNIT' | 'STUDENTS'; readonly unitName: string | null };
  readonly note: string | null;
  readonly assignedAt: string;
  readonly withdrawn: boolean;
  /** Raw counts; the caller suppresses `done` before it leaves the server. */
  readonly students: number;
  readonly done: number;
}

const resourceTitleSql = (kind: SQL, lesson: SQL, skillName: SQL): SQL =>
  sql`CASE WHEN ${kind} = 'LESSON' THEN (SELECT l.title FROM lesson_versions l WHERE l.id = ${lesson}) ELSE ${skillName} END`;

export async function listFacultyAssignments(db: PersistenceDb, institutionId: string, userId: string, limit: number): Promise<readonly FacultyAssignmentSummary[]> {
  const found = await rows<{
    id: string; content_kind: LearningContentKind; skill_id: string; lesson_version_id: string | null; title: string; skill_name: string;
    target_kind: 'UNIT' | 'STUDENTS'; unit_name: string | null; note: string | null; assigned_at: Date | string; withdrawn: boolean; students: number; done: number;
  }>(db, sql`
    SELECT a.id::text AS id, a.content_kind, a.skill_id::text AS skill_id, a.lesson_version_id::text AS lesson_version_id,
           ${resourceTitleSql(sql`a.content_kind`, sql`a.lesson_version_id`, sql`tn.name`)} AS title, tn.name AS skill_name,
           a.target_kind, iu.name AS unit_name, a.note, a.assigned_at, (a.withdrawn_at IS NOT NULL) AS withdrawn,
           (SELECT count(*)::int FROM learning_assignment_students s WHERE s.assignment_id = a.id) AS students,
           (SELECT count(*)::int FROM learning_assignment_students s WHERE s.assignment_id = a.id AND ${assignmentDoneSql('a', sql`s.student_user_id`)}) AS done
    FROM learning_assignments a
    JOIN taxonomy_nodes tn ON tn.id = a.skill_id
    LEFT JOIN institution_units iu ON iu.id = a.target_unit_id
    WHERE a.institution_id = ${institutionId}::uuid AND a.assigned_by_user_id = ${userId}::uuid
    ORDER BY a.assigned_at DESC, a.id DESC
    LIMIT ${limit}
  `);
  return found.map((row) => ({
    id: row.id, resource: { kind: row.content_kind, skillId: row.skill_id, lessonVersionId: row.lesson_version_id, title: row.title, skillName: row.skill_name },
    target: { kind: row.target_kind, unitName: row.unit_name }, note: row.note, assignedAt: new Date(row.assigned_at).toISOString(),
    withdrawn: row.withdrawn === true, students: Number(row.students), done: Number(row.done),
  }));
}

/** Per-student status of one of the lecturer's assignments, for students still inside the scope. */
export async function facultyAssignmentStudents(db: PersistenceDb, institutionId: string, scope: InstitutionStudentScope, assignmentId: string): Promise<readonly (ScopedStudent & { readonly done: boolean })[]> {
  const found = await rows<ScopedRow & { done: boolean }>(db, sql`
    SELECT s.*, ${assignmentDoneSql('a', sql`s.student_user_id::uuid`)} AS done
    FROM (${scopedStudentsSql(institutionId, scope)}) s
    JOIN learning_assignment_students las ON las.student_user_id = s.student_user_id::uuid AND las.assignment_id = ${assignmentId}::uuid
    JOIN learning_assignments a ON a.id = las.assignment_id
    ORDER BY lower(s.full_name), s.profile_id
    LIMIT 500
  `);
  return found.map((row) => ({ ...scoped(row), done: row.done === true }));
}

export interface FacultySessionSummary {
  readonly id: string;
  readonly title: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly state: string;
  readonly attendees: number;
  readonly content: readonly { readonly kind: LearningContentKind; readonly title: string; readonly skillName: string }[];
}

type SessionRow = { id: string; title: string; scheduled_start_at: Date | string; scheduled_end_at: Date | string; state: string; attendees?: number; institution_name?: string };
type LinkRow = { staff_action_id: string; content_kind: LearningContentKind; title: string; skill_name: string };

async function sessionLinks(db: PersistenceDb, ids: readonly string[]): Promise<Map<string, LinkRow[]>> {
  const byId = new Map<string, LinkRow[]>();
  if (ids.length === 0) return byId;
  const links = await rows<LinkRow>(db, sql`
    SELECT c.staff_action_id::text AS staff_action_id, c.content_kind,
           ${resourceTitleSql(sql`c.content_kind`, sql`c.lesson_version_id`, sql`tn.name`)} AS title, tn.name AS skill_name
    FROM staff_action_content_links c JOIN taxonomy_nodes tn ON tn.id = c.skill_id
    WHERE c.staff_action_id = ANY(${`{${ids.join(',')}}`}::uuid[])
    ORDER BY c.staff_action_id, c.position
  `);
  for (const link of links) byId.set(link.staff_action_id.toLowerCase(), [...(byId.get(link.staff_action_id.toLowerCase()) ?? []), link]);
  return byId;
}

/** The lecturer's group sessions (MEETING staff actions with linked content), newest first. */
export async function listFacultySessions(db: PersistenceDb, institutionId: string, userId: string, limit: number): Promise<readonly FacultySessionSummary[]> {
  const found = await rows<SessionRow>(db, sql`
    SELECT a.id::text AS id, a.title, a.scheduled_start_at, a.scheduled_end_at, a.state,
           (SELECT count(*)::int FROM staff_action_attendees t WHERE t.staff_action_id = a.id) AS attendees
    FROM staff_actions a
    WHERE a.institution_id = ${institutionId}::uuid AND a.actor_user_id = ${userId}::uuid AND a.action_type = 'MEETING'
      AND EXISTS (SELECT 1 FROM staff_action_content_links c WHERE c.staff_action_id = a.id)
    ORDER BY a.scheduled_start_at DESC, a.id DESC
    LIMIT ${limit}
  `);
  const links = await sessionLinks(db, found.map((row) => row.id.toLowerCase()));
  return found.map((row) => ({
    id: row.id, title: row.title, scheduledStartAt: new Date(row.scheduled_start_at).toISOString(), scheduledEndAt: new Date(row.scheduled_end_at).toISOString(),
    state: row.state, attendees: Number(row.attendees ?? 0),
    content: (links.get(row.id.toLowerCase()) ?? []).map((link) => ({ kind: link.content_kind, title: link.title, skillName: link.skill_name })),
  }));
}

export interface FacultyOverrideSummary {
  readonly id: string;
  readonly student: { readonly profileId: string; readonly fullName: string; readonly rollNumber: string } | null;
  readonly action: FacultyOverrideAction;
  readonly resource: LearningResourceRef & { readonly title: string; readonly skillName: string };
  readonly reasonCode: string;
  readonly state: 'PENDING' | 'APPLIED' | 'WITHDRAWN';
  readonly createdAt: string;
}

type OverrideRow = {
  id: string; action: FacultyOverrideAction; content_kind: LearningContentKind; skill_id: string; lesson_version_id: string | null; title: string;
  skill_name: string; reason_code: string; state: FacultyOverrideSummary['state']; created_at: Date | string;
  profile_id: string | null; full_name: string | null; institution_student_id: string | null; note?: string | null; institution_name?: string;
};

const mapOverride = (row: OverrideRow): FacultyOverrideSummary => ({
  id: row.id, action: row.action,
  resource: { kind: row.content_kind, skillId: row.skill_id, lessonVersionId: row.lesson_version_id, title: row.title, skillName: row.skill_name },
  reasonCode: row.reason_code, state: row.state, createdAt: new Date(row.created_at).toISOString(),
  student: row.profile_id ? { profileId: row.profile_id, fullName: row.full_name ?? 'NA', rollNumber: row.institution_student_id ?? 'NA' } : null,
});

const overrideSelect = sql`
  SELECT o.id::text AS id, o.action, o.content_kind, o.skill_id::text AS skill_id, o.lesson_version_id::text AS lesson_version_id,
         ${resourceTitleSql(sql`o.content_kind`, sql`o.lesson_version_id`, sql`tn.name`)} AS title, tn.name AS skill_name,
         o.reason_code, o.state, o.created_at, o.note, sp.id::text AS profile_id, sp.full_name, sp.institution_student_id,
         org.legal_name AS institution_name, o.created_by_user_id::text AS created_by_user_id
  FROM learning_plan_overrides o
  JOIN taxonomy_nodes tn ON tn.id = o.skill_id
  JOIN organizations org ON org.id = o.institution_id
  LEFT JOIN institution_student_profiles sp ON sp.institution_id = o.institution_id AND sp.student_user_id = o.student_user_id`;

/** The lecturer's recent overrides, newest first; students who have left the scope are shown without a name. */
export async function listFacultyOverrides(db: PersistenceDb, institutionId: string, userId: string, scope: InstitutionStudentScope, limit: number): Promise<readonly FacultyOverrideSummary[]> {
  const found = await rows<OverrideRow & { in_scope: boolean }>(db, sql`
    SELECT x.*, EXISTS (SELECT 1 FROM (${scopedStudentsSql(institutionId, scope)}) s WHERE s.profile_id = x.profile_id) AS in_scope
    FROM (${overrideSelect} WHERE o.institution_id = ${institutionId}::uuid AND o.created_by_user_id = ${userId}::uuid
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit}) x
    ORDER BY x.created_at DESC, x.id DESC
  `);
  return found.map((row) => mapOverride(row.in_scope ? row : { ...row, profile_id: null }));
}

/** The pending override for a student at this college, if any. */
export async function pendingOverrideFor(db: PersistenceDb, institutionId: string, studentUserId: string): Promise<FacultyOverrideSummary & { readonly createdByUserId: string } | null> {
  const [row] = await rows<OverrideRow & { created_by_user_id: string }>(db, sql`
    ${overrideSelect}
    WHERE o.student_user_id = ${studentUserId}::uuid AND o.state = 'PENDING' AND o.institution_id = ${institutionId}::uuid
  `);
  return row ? { ...mapOverride(row), createdByUserId: row.created_by_user_id } : null;
}

// ---------------------------------------------------------------------------
// The student's view
// ---------------------------------------------------------------------------

export interface StudentLearningActions {
  readonly assignments: readonly {
    readonly id: string; readonly kind: LearningContentKind; readonly title: string; readonly skillName: string;
    readonly institutionName: string; readonly note: string | null; readonly assignedAt: string; readonly status: 'OPEN' | 'DONE';
  }[];
  readonly sessions: readonly {
    readonly id: string; readonly title: string; readonly institutionName: string; readonly scheduledStartAt: string; readonly scheduledEndAt: string;
    readonly content: readonly { readonly kind: LearningContentKind; readonly title: string; readonly skillName: string }[];
  }[];
  readonly pendingOverride: {
    readonly id: string; readonly action: FacultyOverrideAction; readonly kind: LearningContentKind; readonly title: string; readonly skillName: string;
    readonly reasonCode: string; readonly note: string | null; readonly institutionName: string; readonly createdAt: string;
  } | null;
}

/**
 * What the student's lecturers set for them, at colleges they are still at: assignments whose content is still
 * published (open first, then the 20 most recent done), sessions not cancelled and not long over, and the
 * pending override. Names lecturers by role and college only.
 */
export async function readStudentLearningActions(db: PersistenceDb, studentUserId: string): Promise<StudentLearningActions> {
  if (!UUID.test(studentUserId)) throw new Error('studentUserId must be a UUID');
  const assignments = await rows<{
    id: string; content_kind: LearningContentKind; title: string; skill_name: string; institution_name: string; note: string | null; assigned_at: Date | string; done: boolean;
  }>(db, sql`
    SELECT * FROM (
      SELECT a.id::text AS id, a.content_kind, ${resourceTitleSql(sql`a.content_kind`, sql`a.lesson_version_id`, sql`tn.name`)} AS title,
             tn.name AS skill_name, org.legal_name AS institution_name, a.note, a.assigned_at,
             ${assignmentDoneSql('a', sql`s.student_user_id`)} AS done
      FROM learning_assignment_students s
      JOIN learning_assignments a ON a.id = s.assignment_id
      JOIN taxonomy_nodes tn ON tn.id = a.skill_id
      JOIN organizations org ON org.id = a.institution_id
      WHERE s.student_user_id = ${studentUserId}::uuid AND a.withdrawn_at IS NULL
        AND ${currentRelationshipSql(sql`a.institution_id`, sql`s.student_user_id`)}
        AND ${publishedSql(sql`a.content_kind`, sql`a.skill_id`, sql`a.lesson_version_id`)}
    ) x
    ORDER BY x.done, x.assigned_at DESC, x.id
    LIMIT 60
  `);
  const sessions = await rows<SessionRow & { institution_name: string }>(db, sql`
    SELECT a.id::text AS id, a.title, a.scheduled_start_at, a.scheduled_end_at, a.state, org.legal_name AS institution_name
    FROM staff_action_attendees t
    JOIN staff_actions a ON a.id = t.staff_action_id AND a.action_type = 'MEETING'
    JOIN organizations org ON org.id = a.institution_id
    WHERE t.student_user_id = ${studentUserId}::uuid
      AND a.state NOT IN ('CANCELLED', 'REJECTED', 'ARCHIVED') AND a.scheduled_end_at > now() - interval '1 day'
      AND ${currentRelationshipSql(sql`a.institution_id`, sql`t.student_user_id`)}
    ORDER BY a.scheduled_start_at, a.id
    LIMIT 20
  `);
  const links = await sessionLinks(db, sessions.map((row) => row.id.toLowerCase()));
  const [pending] = await rows<OverrideRow>(db, sql`
    ${overrideSelect}
    WHERE o.student_user_id = ${studentUserId}::uuid AND o.state = 'PENDING'
      AND ${currentRelationshipSql(sql`o.institution_id`, sql`o.student_user_id`)}
      AND ${publishedSql(sql`o.content_kind`, sql`o.skill_id`, sql`o.lesson_version_id`)}
  `);
  // Done items after open ones, and only the most recent 20 of them.
  const open = assignments.filter((row) => row.done !== true);
  const done = assignments.filter((row) => row.done === true).slice(0, 20);
  return {
    assignments: [...open, ...done].map((row) => ({
      id: row.id, kind: row.content_kind, title: row.title, skillName: row.skill_name, institutionName: row.institution_name, note: row.note,
      assignedAt: new Date(row.assigned_at).toISOString(), status: row.done === true ? 'DONE' : 'OPEN',
    })),
    sessions: sessions.map((row) => ({
      id: row.id, title: row.title, institutionName: row.institution_name,
      scheduledStartAt: new Date(row.scheduled_start_at).toISOString(), scheduledEndAt: new Date(row.scheduled_end_at).toISOString(),
      content: (links.get(row.id.toLowerCase()) ?? []).map((link) => ({ kind: link.content_kind, title: link.title, skillName: link.skill_name })),
    })),
    pendingOverride: pending ? {
      id: pending.id, action: pending.action, kind: pending.content_kind, title: pending.title, skillName: pending.skill_name,
      reasonCode: pending.reason_code, note: pending.note ?? null, institutionName: pending.institution_name ?? 'Your college',
      createdAt: new Date(pending.created_at).toISOString(),
    } : null,
  };
}
