/**
 * Student goals and onboarding (ENG-19): reads and writes `learner_goals` (0068) and runs the
 * "Not sure yet" discovery over the real catalogue.
 *
 * Why this exists: onboarding asks "What job do you want?" and a student can hold one primary role goal plus
 * any number of topic (and, while the catalogue is open, exam and company) goals. Role goals are
 * `student_career_targets` rows mirrored by the 0068 trigger, so setting one goes through
 * `setStudentCareerTarget` and the gap engine stays the one source of truth. Nothing here reads an
 * enrolment: graduates and independent learners onboard exactly like enrolled students.
 * Design: docs/architecture/learner-goals-table-design.md.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  CAREER_DISCOVERY_ALGORITHM,
  DISCOVERY_BRANCH_NOT_LISTED,
  DISCOVERY_INTERESTS,
  DISCOVERY_STRENGTHS,
  DiscoveryAnswersError,
  mergeGoalSkills,
  suggestCareerRoles,
  validateDiscoveryAnswers,
  type DiscoveryAnswers,
  type DiscoveryReason,
  type GoalSkillStatus,
  type LearnerGoalType,
  type MergedGoalSkills,
} from '@planthepath/career-readiness/src/learner-goals.js';
import { clearStudentCareerTarget, setStudentCareerTarget } from './career-targets.js';

export type LearnerGoalOrigin = 'ONBOARDING' | 'GOALS' | 'DISCOVERY_SUGGESTION';
export type LearnerGoalStatus = 'ACTIVE' | 'ACHIEVED' | 'WITHDRAWN';

export type LearnerGoalErrorCode =
  | 'GOAL_NOT_FOUND' | 'TOPIC_NOT_FOUND' | 'CATALOGUE_GOAL_NOT_FOUND' | 'GOAL_ALREADY_SET'
  | 'ROLE_GOAL_ENDS_BY_WITHDRAWAL' | 'INVALID_INTERESTS' | 'INVALID_STRENGTHS' | 'INVALID_BRANCH';

export class LearnerGoalError extends Error {
  constructor(readonly code: LearnerGoalErrorCode) {
    super(code);
    this.name = 'LearnerGoalError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const institutionOf = `(SELECT p.institution_id FROM institution_student_profiles p
  WHERE p.student_user_id = $1 AND p.status = 'ACTIVE' ORDER BY p.updated_at DESC LIMIT 1)`;

function likePattern(value: string): string {
  return `%${value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface GoalRoleView {
  readonly careerRoleId: string;
  readonly targetId: string;
  readonly code: string;
  readonly title: string;
  readonly family: string;
  /** Only while the full catalogue is open to the student (OPS-08); otherwise null. */
  readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | null;
}

export interface LearnerGoalView {
  readonly id: string;
  readonly goalType: LearnerGoalType;
  readonly priority: 'PRIMARY' | 'SECONDARY';
  readonly origin: string;
  readonly createdAt: string;
  readonly role: GoalRoleView | null;
  readonly topic: { readonly topicId: string; readonly name: string } | null;
  readonly catalogueGoal: { readonly code: string; readonly title: string; readonly release: string } | null;
  readonly discovery: DiscoveryAnswers | null;
}

export interface LearnerGoalsView {
  /** True while the student has no live goal: the first-run question is shown. */
  readonly onboarding: boolean;
  readonly goals: readonly LearnerGoalView[];
  /** Every skill the goals need, each once (learner-goal-skills-v1). */
  readonly skills: MergedGoalSkills;
}

interface GoalRow {
  id: string; goal_type: LearnerGoalType; priority: 'PRIMARY' | 'SECONDARY'; origin: string; created_at: Date;
  career_target_id: string | null; career_role_id: string | null; role_code: string | null; role_title: string | null;
  role_family: string | null; release_label: 'SELECTABLE' | 'VERIFIED' | null;
  topic_id: string | null; topic_name: string | null;
  catalogue_goal_code: string | null; catalogue_goal_title: string | null; catalogue_goal_release: string | null;
  discovery_interests: string[] | null; discovery_strengths: string[] | null; discovery_branch: string | null;
}

/** The student's live goals, primary first, and the skills they need, each counted once. */
export async function listLearnerGoals(pool: Pool, studentId: string, options: { readonly catalogueOpen?: boolean } = {}): Promise<LearnerGoalsView> {
  const open = options.catalogueOpen === true;
  const result = await pool.query<GoalRow>(
    `SELECT g.id, g.goal_type, g.priority, g.origin, g.created_at, g.career_target_id,
            t.career_role_id, r.code AS role_code, r.title AS role_title, r.family AS role_family,
            CASE WHEN $2 THEN r.release_label END AS release_label,
            g.topic_id, n.name AS topic_name,
            g.catalogue_goal_code, c.title AS catalogue_goal_title, c.release AS catalogue_goal_release,
            g.discovery_interests, g.discovery_strengths, g.discovery_branch
     FROM learner_goals g
     LEFT JOIN student_career_targets t ON t.id = g.career_target_id
     LEFT JOIN career_roles r ON r.id = t.career_role_id
     LEFT JOIN taxonomy_nodes n ON n.id = g.topic_id
     LEFT JOIN career_catalogue_goals c ON c.code = g.catalogue_goal_code
     WHERE g.student_user_id = $1 AND g.status = 'ACTIVE'
     ORDER BY CASE g.priority WHEN 'PRIMARY' THEN 0 ELSE 1 END,
              CASE g.goal_type WHEN 'ROLE' THEN 0 WHEN 'TOPIC' THEN 1 WHEN 'EXAM' THEN 2 WHEN 'COMPANY' THEN 3 ELSE 4 END,
              g.created_at, g.id`,
    [studentId, open],
  );
  const goals: LearnerGoalView[] = result.rows.map((row) => ({
    id: row.id,
    goalType: row.goal_type,
    priority: row.priority,
    origin: row.origin,
    createdAt: new Date(row.created_at).toISOString(),
    role: row.career_target_id && row.career_role_id ? {
      careerRoleId: row.career_role_id, targetId: row.career_target_id, code: row.role_code ?? '',
      title: row.role_title ?? '', family: row.role_family ?? '', releaseLabel: row.release_label,
    } : null,
    topic: row.topic_id ? { topicId: row.topic_id, name: row.topic_name ?? '' } : null,
    catalogueGoal: row.catalogue_goal_code ? {
      code: row.catalogue_goal_code, title: row.catalogue_goal_title ?? '', release: row.catalogue_goal_release ?? '',
    } : null,
    discovery: row.goal_type === 'DISCOVERY' ? {
      interests: (row.discovery_interests ?? []) as DiscoveryAnswers['interests'],
      strengths: (row.discovery_strengths ?? []) as DiscoveryAnswers['strengths'],
      branch: row.discovery_branch ?? DISCOVERY_BRANCH_NOT_LISTED,
    } : null,
  }));

  // A role goal's skills are its live requirements (what the gap engine reads) with that role's current gap
  // status; a topic goal's skill is its topic. Exam, company and discovery goals have no skills yet.
  const skillInputs = await Promise.all(goals.map(async (goal) => {
    if (goal.role) {
      const skills = await pool.query<{ topic_id: string; name: string | null; status: GoalSkillStatus | null }>(
        `SELECT q.topic_id, n.name, i.status
         FROM career_role_requirements q
         LEFT JOIN taxonomy_nodes n ON n.id = q.topic_id
         LEFT JOIN career_gap_snapshots s ON s.student_user_id = $1 AND s.career_role_id = q.career_role_id AND s.superseded_at IS NULL
         LEFT JOIN career_gap_items i ON i.snapshot_id = s.id AND i.topic_id = q.topic_id
         WHERE q.career_role_id = $2
         ORDER BY COALESCE(i.priority_rank, 2147483647), q.topic_id`,
        [studentId, goal.role.careerRoleId],
      );
      return { goalId: goal.id, goalType: goal.goalType, skills: skills.rows.map((row) => ({ topicId: row.topic_id, topicTitle: row.name, status: row.status })) };
    }
    if (goal.topic) return { goalId: goal.id, goalType: goal.goalType, skills: [{ topicId: goal.topic.topicId, topicTitle: goal.topic.name, status: null }] };
    return { goalId: goal.id, goalType: goal.goalType, skills: [] };
  }));

  return { onboarding: goals.length === 0, goals, skills: mergeGoalSkills(skillInputs) };
}

export interface GoalRoleOption {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly family: string;
  readonly summary: string | null;
  readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | null;
  readonly catalogueCode: string | null;
  /** The synonym the search matched on, when it was a synonym rather than the name. */
  readonly matchedSynonym: string | null;
}

export interface GoalOptions {
  readonly roles: readonly GoalRoleOption[];
  readonly topics: readonly { readonly id: string; readonly name: string }[];
  readonly catalogueGoals: readonly { readonly code: string; readonly title: string; readonly goalType: 'EXAM' | 'COMPANY'; readonly release: string }[];
}

const OPTION_LIMIT = 25;

/**
 * What a student can set as a goal, searched by name and live synonym: the roles offered to them (the OPS-08
 * flag rule), published topics (active TOPIC nodes, latest version), and — only while the catalogue is open —
 * the selectable exam and company goals.
 */
export async function searchGoalOptions(pool: Pool, input: { readonly query: string; readonly catalogueOpen: boolean }): Promise<GoalOptions> {
  const open = input.catalogueOpen;
  const q = input.query.trim() ? likePattern(input.query) : null;
  const roles = await pool.query<{ id: string; code: string; title: string; family: string; summary: string | null; release_label: 'SELECTABLE' | 'VERIFIED' | null; catalogue_code: string | null; matched_synonym: string | null }>(
    `SELECT r.id, r.code, r.title, r.family, r.summary,
            CASE WHEN $1 THEN r.release_label END AS release_label,
            CASE WHEN $1 THEN r.catalogue_code END AS catalogue_code,
            CASE WHEN $2::text IS NULL OR lower(r.title) LIKE $2 OR ($1 AND lower(COALESCE(r.catalogue_title, '')) LIKE $2) THEN NULL
                 ELSE (SELECT y.synonym FROM career_role_synonyms y
                       WHERE y.career_role_id = r.id AND y.removed_at IS NULL AND y.normalized LIKE $2
                       ORDER BY y.normalized LIMIT 1) END AS matched_synonym
     FROM career_roles r
     WHERE r.active AND ($1 OR r.origin = 'STARTER')
       AND ($2::text IS NULL OR lower(r.title) LIKE $2
         OR ($1 AND (lower(COALESCE(r.catalogue_title, '')) LIKE $2 OR lower(COALESCE(r.catalogue_code, '')) LIKE $2))
         OR EXISTS (SELECT 1 FROM career_role_synonyms y WHERE y.career_role_id = r.id AND y.removed_at IS NULL AND y.normalized LIKE $2))
     ORDER BY r.family, r.title, r.id
     LIMIT ${OPTION_LIMIT}`,
    [open, q],
  );
  const topics = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM (
       SELECT DISTINCT ON (stable_key) id, name, stable_key FROM taxonomy_nodes
       WHERE kind = 'TOPIC' AND active ORDER BY stable_key, version DESC
     ) latest
     WHERE $1::text IS NULL OR lower(name) LIKE $1
     ORDER BY name, id
     LIMIT ${OPTION_LIMIT}`,
    [q],
  );
  const catalogueGoals = open ? (await pool.query<{ code: string; title: string; learner_goal_type: 'EXAM' | 'COMPANY'; release: string }>(
    `SELECT code, title, learner_goal_type, release FROM career_catalogue_goals
     WHERE selectable AND learner_goal_type IN ('EXAM','COMPANY') AND ($1::text IS NULL OR lower(title) LIKE $1)
     ORDER BY code`,
    [q],
  )).rows : [];
  return {
    roles: roles.rows.map((row) => ({
      id: row.id, code: row.code, title: row.title, family: row.family, summary: row.summary,
      releaseLabel: row.release_label, catalogueCode: row.catalogue_code, matchedSynonym: row.matched_synonym,
    })),
    topics: topics.rows,
    catalogueGoals: catalogueGoals.map((row) => ({ code: row.code, title: row.title, goalType: row.learner_goal_type, release: row.release })),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** A role goal is a career target: set through the 0011 path, mirrored into learner_goals by 0068. */
export async function setRoleGoal(pool: Pool, input: {
  readonly studentId: string; readonly careerRoleId: string; readonly priority: 'PRIMARY' | 'SECONDARY';
  readonly origin: LearnerGoalOrigin; readonly catalogueOpen: boolean;
}): Promise<{ readonly targetId: string }> {
  return setStudentCareerTarget(pool, {
    subjectUserId: input.studentId, careerRoleId: input.careerRoleId, priority: input.priority,
    catalogueOpen: input.catalogueOpen, goalOrigin: input.origin,
  });
}

/** A topic goal on a published topic, or (catalogue open only) a selectable exam or company goal. */
export async function addLearnerGoal(pool: Pool, input: {
  readonly studentId: string;
  readonly goal: { readonly goalType: 'TOPIC'; readonly topicId: string } | { readonly goalType: 'EXAM' | 'COMPANY'; readonly catalogueGoalCode: string };
  readonly origin: LearnerGoalOrigin;
  readonly catalogueOpen: boolean;
}): Promise<{ readonly goalId: string }> {
  const goalId = randomUUID();
  try {
    if (input.goal.goalType === 'TOPIC') {
      if (!UUID.test(input.goal.topicId)) throw new LearnerGoalError('TOPIC_NOT_FOUND');
      const inserted = await pool.query(
        `INSERT INTO learner_goals (id, student_user_id, institution_id, goal_type, topic_id, origin)
         SELECT $2, $1, ${institutionOf}, 'TOPIC', n.id, $4
         FROM taxonomy_nodes n WHERE n.id = $3 AND n.kind = 'TOPIC' AND n.active`,
        [input.studentId, goalId, input.goal.topicId, input.origin],
      );
      if (!inserted.rowCount) throw new LearnerGoalError('TOPIC_NOT_FOUND');
    } else {
      if (!input.catalogueOpen) throw new LearnerGoalError('CATALOGUE_GOAL_NOT_FOUND');
      const inserted = await pool.query(
        `INSERT INTO learner_goals (id, student_user_id, institution_id, goal_type, catalogue_goal_code, origin)
         SELECT $2, $1, ${institutionOf}, c.learner_goal_type, c.code, $4
         FROM career_catalogue_goals c WHERE c.code = $3 AND c.selectable AND c.learner_goal_type = $5`,
        [input.studentId, goalId, input.goal.catalogueGoalCode, input.origin, input.goal.goalType],
      );
      if (!inserted.rowCount) throw new LearnerGoalError('CATALOGUE_GOAL_NOT_FOUND');
    }
  } catch (error) {
    if (isUniqueViolation(error)) throw new LearnerGoalError('GOAL_ALREADY_SET');
    throw error;
  }
  return { goalId };
}

/**
 * Ends a live goal. A role goal ends by withdrawing its career target (the trigger ends the goal with it);
 * other goals end as ACHIEVED or WITHDRAWN. Scoped by student, so another student's goal reads as not found.
 */
export async function endLearnerGoal(pool: Pool, input: { readonly studentId: string; readonly goalId: string; readonly status: 'ACHIEVED' | 'WITHDRAWN' }): Promise<void> {
  if (!UUID.test(input.goalId)) throw new LearnerGoalError('GOAL_NOT_FOUND');
  const goal = (await pool.query<{ goal_type: LearnerGoalType; career_target_id: string | null }>(
    "SELECT goal_type, career_target_id FROM learner_goals WHERE id = $1 AND student_user_id = $2 AND status = 'ACTIVE'",
    [input.goalId, input.studentId],
  )).rows[0];
  if (!goal) throw new LearnerGoalError('GOAL_NOT_FOUND');
  if (goal.goal_type === 'ROLE') {
    if (input.status !== 'WITHDRAWN') throw new LearnerGoalError('ROLE_GOAL_ENDS_BY_WITHDRAWAL');
    await clearStudentCareerTarget(pool, { subjectUserId: input.studentId, targetId: goal.career_target_id! });
    return;
  }
  const updated = await pool.query(
    `UPDATE learner_goals SET status = $3, ended_at = greatest(now(), created_at)
     WHERE id = $1 AND student_user_id = $2 AND status = 'ACTIVE'`,
    [input.goalId, input.studentId, input.status],
  );
  if (!updated.rowCount) throw new LearnerGoalError('GOAL_NOT_FOUND');
}

// ---------------------------------------------------------------------------
// "Not sure yet"
// ---------------------------------------------------------------------------

export interface DiscoverySuggestionView {
  readonly role: { readonly id: string; readonly code: string; readonly title: string; readonly family: string; readonly summary: string | null; readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | null; readonly catalogueCode: string | null };
  readonly reasons: readonly DiscoveryReason[];
}

export interface CareerDiscoveryView {
  readonly algorithmId: typeof CAREER_DISCOVERY_ALGORITHM;
  readonly survey: {
    readonly interests: readonly { readonly code: string; readonly label: string }[];
    readonly strengths: readonly { readonly code: string; readonly label: string }[];
    /** The catalogue's own branch labels for the offered roles, then NOT_LISTED. */
    readonly branches: readonly string[];
  };
  /** The live "Not sure yet" goal's answers, or null. */
  readonly answers: DiscoveryAnswers | null;
  readonly result: {
    readonly suggestions: readonly DiscoverySuggestionView[];
    readonly usedShownSkills: boolean;
    readonly fewerThanMinimum: boolean;
  } | null;
}

type Queryable = Pool | PoolClient;

async function offeredBranches(db: Queryable, open: boolean): Promise<string[]> {
  const result = await db.query<{ branch: string }>(
    `SELECT DISTINCT b AS branch FROM career_roles r, unnest(r.eligible_branches) AS b
     WHERE r.active AND ($1 OR r.origin = 'STARTER') AND lower(b) NOT IN ('all branches', 'any')
     ORDER BY 1`, [open],
  );
  return result.rows.map((row) => row.branch);
}

async function discover(db: Queryable, studentId: string, answers: DiscoveryAnswers, open: boolean, adaptive: boolean): Promise<NonNullable<CareerDiscoveryView['result']>> {
  const roles = await db.query<{ id: string; code: string; title: string; family: string; summary: string | null; release_label: 'SELECTABLE' | 'VERIFIED' | null; catalogue_code: string | null; planned_release: 'V1' | 'V2' | 'V3' | null; eligible_branches: string[] | null; text: string; topics: string[] | null }>(
    `SELECT r.id, r.code, r.title, r.family, r.summary, r.release_label, r.catalogue_code, r.planned_release, r.eligible_branches,
            concat_ws(' ', r.core_skill_areas, r.main_evidence, r.summary) AS text,
            ARRAY(SELECT q.topic_id::text FROM career_role_requirements q WHERE q.career_role_id = r.id ORDER BY 1) AS topics
     FROM career_roles r WHERE r.active AND ($1 OR r.origin = 'STARTER')`, [open],
  );
  // Attempt history is personalisation: read only under adaptive-learning consent (ENG-01, fail closed).
  const shownSkillIds = adaptive ? (await db.query<{ skill_id: string }>(
    "SELECT skill_id::text AS skill_id FROM learner_skill_state WHERE subject_user_id = $1 AND evidence_band IN ('PROGRESSING','DEMONSTRATED')",
    [studentId],
  )).rows.map((row) => row.skill_id) : null;
  const result = suggestCareerRoles({
    answers,
    roles: roles.rows.map((row) => ({
      id: row.id, catalogueCode: row.catalogue_code, text: row.text ?? '', eligibleBranches: row.eligible_branches ?? [],
      plannedRelease: row.planned_release, requirementTopicIds: row.topics ?? [],
    })),
    shownSkillIds,
  });
  const byId = new Map(roles.rows.map((row) => [row.id, row]));
  return {
    suggestions: result.suggestions.map((suggestion) => {
      const row = byId.get(suggestion.roleId)!;
      return {
        role: {
          id: row.id, code: row.code, title: row.title, family: row.family, summary: row.summary,
          releaseLabel: open ? row.release_label : null, catalogueCode: open ? row.catalogue_code : null,
        },
        reasons: suggestion.reasons,
      };
    }),
    usedShownSkills: result.usedShownSkills,
    fewerThanMinimum: result.fewerThanMinimum,
  };
}

function survey(branches: readonly string[]): CareerDiscoveryView['survey'] {
  return {
    interests: Object.entries(DISCOVERY_INTERESTS).map(([code, value]) => ({ code, label: value.label })),
    strengths: Object.entries(DISCOVERY_STRENGTHS).map(([code, value]) => ({ code, label: value.label })),
    branches: [...branches, DISCOVERY_BRANCH_NOT_LISTED],
  };
}

/** The survey, the student's live answers and the suggestions they give now (recomputed, never stored). */
export async function readCareerDiscovery(pool: Pool, input: { readonly studentId: string; readonly catalogueOpen: boolean; readonly adaptive: boolean }): Promise<CareerDiscoveryView> {
  const branches = await offeredBranches(pool, input.catalogueOpen);
  const live = (await pool.query<{ discovery_interests: string[]; discovery_strengths: string[]; discovery_branch: string }>(
    "SELECT discovery_interests, discovery_strengths, discovery_branch FROM learner_goals WHERE student_user_id = $1 AND goal_type = 'DISCOVERY' AND status = 'ACTIVE'",
    [input.studentId],
  )).rows[0];
  const answers: DiscoveryAnswers | null = live ? {
    interests: live.discovery_interests as DiscoveryAnswers['interests'],
    strengths: live.discovery_strengths as DiscoveryAnswers['strengths'],
    branch: live.discovery_branch,
  } : null;
  return {
    algorithmId: CAREER_DISCOVERY_ALGORITHM,
    survey: survey(branches),
    answers,
    result: answers ? await discover(pool, input.studentId, answers, input.catalogueOpen, input.adaptive) : null,
  };
}

/**
 * Records "Not sure yet" with the survey answers (replacing a live one, which ends as WITHDRAWN) and returns
 * the suggestions. Picking a suggestion is a role goal with origin DISCOVERY_SUGGESTION; a primary role ends
 * the discovery goal as ACHIEVED (0068 trigger).
 */
export async function submitCareerDiscovery(pool: Pool, input: {
  readonly studentId: string; readonly answers: unknown; readonly origin: LearnerGoalOrigin;
  readonly catalogueOpen: boolean; readonly adaptive: boolean;
}): Promise<CareerDiscoveryView> {
  const branches = await offeredBranches(pool, input.catalogueOpen);
  let answers: DiscoveryAnswers;
  try {
    answers = validateDiscoveryAnswers(input.answers, branches);
  } catch (error) {
    if (error instanceof DiscoveryAnswersError) throw new LearnerGoalError(error.code);
    throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE learner_goals SET status = 'WITHDRAWN', ended_at = greatest(now(), created_at)
       WHERE student_user_id = $1 AND goal_type = 'DISCOVERY' AND status = 'ACTIVE'`, [input.studentId],
    );
    await client.query(
      `INSERT INTO learner_goals (id, student_user_id, institution_id, goal_type, origin, discovery_interests, discovery_strengths, discovery_branch)
       VALUES ($2, $1, ${institutionOf}, 'DISCOVERY', $3, $4, $5, $6)`,
      [input.studentId, randomUUID(), input.origin, answers.interests, answers.strengths, answers.branch],
    );
    const result = await discover(client, input.studentId, answers, input.catalogueOpen, input.adaptive);
    await client.query('COMMIT');
    return { algorithmId: CAREER_DISCOVERY_ALGORITHM, survey: survey(branches), answers, result };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
