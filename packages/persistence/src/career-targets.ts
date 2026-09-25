/**
 * ONE · Stream E — Core
 * Owner: Divakar · Created: 2026-09-12
 * Agent-assisted: yes (Claude) · Reviewed: pending
 *
 * Career targets and the gap between a target and what a learner has demonstrated.
 *
 * The schema (migration 0011) and the domain logic (`computeCareerGap`,
 * `careerNextActions`, `careerTargetProgress`) both already existed and neither had a
 * caller. This is the adapter between them; it adds no new rules of its own.
 *
 * Gaps are recomputed from `evidence_records` through `projectTopicMastery` rather
 * than read from `mastery_projections`, because a requirement is expressed as a depth
 * and the stored projection keeps only the band. Recomputing from evidence uses the
 * same function that produced those bands, so there is one definition of mastery
 * rather than two that can drift.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  careerNextActions,
  careerTargetProgress,
  computeCareerGap,
  projectTopicMastery,
  type CareerGap,
  type CareerRequirement,
  type EvidenceInput,
} from '@planthepath/career-readiness/src/index.js';

export class CareerTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CareerTargetError';
  }
}

type Queryable = Pool | PoolClient;

interface CareerRoleRow {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly family: string;
  readonly summary: string | null;
  readonly requirementCount: number;
}

/** The catalogue a learner chooses from. Inactive roles are never offered. */
export async function listCareerRoles(pool: Pool): Promise<readonly CareerRoleRow[]> {
  const result = await pool.query<CareerRoleRow>(
    `SELECT r.id, r.code, r.title, r.family, r.summary,
            (SELECT count(*)::int FROM career_role_requirements q WHERE q.career_role_id = r.id) AS "requirementCount"
     FROM career_roles r WHERE r.active ORDER BY r.family, r.title`,
  );
  return result.rows;
}

async function loadRequirements(client: Queryable, careerRoleId: string): Promise<readonly CareerRequirement[]> {
  const result = await client.query<{ topicId: string; requirementLevel: CareerRequirement['requirementLevel']; targetMastery: string }>(
    `SELECT topic_id AS "topicId", requirement_level AS "requirementLevel", target_mastery AS "targetMastery"
     FROM career_role_requirements WHERE career_role_id=$1`, [careerRoleId],
  );
  return result.rows.map((row) => ({
    topicId: row.topicId,
    requirementLevel: row.requirementLevel,
    targetMastery: Number(row.targetMastery),
  }));
}

async function loadEvidence(client: Queryable, subjectUserId: string): Promise<readonly EvidenceInput[]> {
  const result = await client.query<EvidenceInput>(
    `SELECT id, subject_user_id AS "subjectUserId", evidence_type AS "evidenceType", topic_id AS "topicId",
            demonstrated, possible, source_aggregate_type AS "sourceAggregateType",
            source_aggregate_id AS "sourceAggregateId", content_version AS "contentVersion",
            occurred_at AS "occurredAt", supersedes_evidence_id AS "supersedesEvidenceId"
     FROM evidence_records WHERE subject_user_id=$1 ORDER BY occurred_at, id`, [subjectUserId],
  );
  return result.rows;
}

/**
 * Recompute and persist the gap for one target.
 *
 * A recomputation supersedes rather than overwrites, so what a learner was told last
 * week can still be reconstructed — the same discipline `readiness_snapshots` and
 * `mastery_projections` already follow.
 */
export async function recomputeCareerGap(
  client: Queryable,
  input: { readonly subjectUserId: string; readonly careerRoleId: string },
): Promise<{ readonly snapshotId: string; readonly requirementsTotal: number }> {
  const [requirements, evidence] = await Promise.all([
    loadRequirements(client, input.careerRoleId),
    loadEvidence(client, input.subjectUserId),
  ]);
  const gap = computeCareerGap(requirements, projectTopicMastery(evidence));

  await client.query(
    `UPDATE career_gap_snapshots SET superseded_at=now()
     WHERE student_user_id=$1 AND career_role_id=$2 AND superseded_at IS NULL`,
    [input.subjectUserId, input.careerRoleId],
  );

  const snapshotId = randomUUID();
  await client.query(
    `INSERT INTO career_gap_snapshots
     (id, student_user_id, career_role_id, model_version, requirements_total, requirements_met, requirements_unknown)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [snapshotId, input.subjectUserId, input.careerRoleId, gap.modelVersion,
      gap.requirementsTotal, gap.requirementsMet, gap.requirementsUnknown],
  );
  for (const item of gap.items) {
    await client.query(
      `INSERT INTO career_gap_items
       (id, snapshot_id, topic_id, requirement_level, target_mastery, observed_mastery, status, priority_rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), snapshotId, item.topicId, item.requirementLevel, item.targetMastery,
        item.observedMastery, item.status, item.priorityRank],
    );
  }
  return { snapshotId, requirementsTotal: gap.requirementsTotal };
}

/**
 * Select a target. A PRIMARY selection clears any existing primary first — the partial
 * unique index in 0011 permits exactly one, and aiming at two things at once is not a
 * target.
 */
export async function setStudentCareerTarget(
  pool: Pool,
  input: { readonly subjectUserId: string; readonly careerRoleId: string; readonly priority: 'PRIMARY' | 'SECONDARY' },
): Promise<{ readonly targetId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query<{ id: string }>('SELECT id FROM career_roles WHERE id=$1 AND active', [input.careerRoleId]);
    if (!role.rows[0]) throw new CareerTargetError('CAREER_ROLE_NOT_FOUND');

    if (input.priority === 'PRIMARY') {
      await client.query(
        `UPDATE student_career_targets SET cleared_at=now()
         WHERE student_user_id=$1 AND priority='PRIMARY' AND cleared_at IS NULL`, [input.subjectUserId],
      );
    }
    // Re-selecting a role already held at the other priority moves it rather than
    // colliding with the active-target unique index.
    await client.query(
      `UPDATE student_career_targets SET cleared_at=now()
       WHERE student_user_id=$1 AND career_role_id=$2 AND cleared_at IS NULL`,
      [input.subjectUserId, input.careerRoleId],
    );

    const targetId = randomUUID();
    await client.query(
      'INSERT INTO student_career_targets (id, student_user_id, career_role_id, priority) VALUES ($1,$2,$3,$4)',
      [targetId, input.subjectUserId, input.careerRoleId, input.priority],
    );
    await recomputeCareerGap(client, { subjectUserId: input.subjectUserId, careerRoleId: input.careerRoleId });
    await client.query('COMMIT');
    return { targetId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Clearing a target keeps its gap history; the snapshot is superseded, never deleted. */
export async function clearStudentCareerTarget(
  pool: Pool,
  input: { readonly subjectUserId: string; readonly targetId: string },
): Promise<void> {
  const result = await pool.query(
    `UPDATE student_career_targets SET cleared_at=now()
     WHERE id=$1 AND student_user_id=$2 AND cleared_at IS NULL`,
    [input.targetId, input.subjectUserId],
  );
  if (!result.rowCount) throw new CareerTargetError('CAREER_TARGET_NOT_FOUND');
}

/**
 * Everything the Career Tools surface needs in one read: the learner's live targets,
 * the current gap for each, the ranked next actions and progress over what could
 * actually be evaluated.
 *
 * `percentOfEvaluated` is progress toward a chosen target over measured requirements.
 * It is deliberately not a readiness figure and must never be presented as one —
 * ADR-020 forbids a numeric readiness value, and this is a different quantity with a
 * different denominator.
 */
export async function getStudentCareerTargetState(pool: Pool, subjectUserId: string): Promise<Record<string, unknown>> {
  const targets = await pool.query<{ id: string; careerRoleId: string; priority: string; selectedAt: Date; code: string; title: string; family: string }>(
    `SELECT t.id, t.career_role_id AS "careerRoleId", t.priority, t.selected_at AS "selectedAt",
            r.code, r.title, r.family
     FROM student_career_targets t JOIN career_roles r ON r.id = t.career_role_id
     WHERE t.student_user_id=$1 AND t.cleared_at IS NULL
     ORDER BY CASE t.priority WHEN 'PRIMARY' THEN 0 ELSE 1 END, t.selected_at DESC`, [subjectUserId],
  );

  const resolved = await Promise.all(targets.rows.map(async (target) => {
    const snapshot = await pool.query<{ id: string; modelVersion: string; computedAt: Date; requirementsTotal: number; requirementsMet: number; requirementsUnknown: number }>(
      `SELECT id, model_version AS "modelVersion", computed_at AS "computedAt",
              requirements_total AS "requirementsTotal", requirements_met AS "requirementsMet",
              requirements_unknown AS "requirementsUnknown"
       FROM career_gap_snapshots
       WHERE student_user_id=$1 AND career_role_id=$2 AND superseded_at IS NULL`,
      [subjectUserId, target.careerRoleId],
    );
    const current = snapshot.rows[0];
    if (!current) return { ...target, gap: null };

    const items = await pool.query<{ topicId: string; requirementLevel: CareerRequirement['requirementLevel']; targetMastery: string; observedMastery: string | null; status: 'MET' | 'PARTIAL' | 'MISSING' | 'UNKNOWN'; priorityRank: number; topicTitle: string | null }>(
      `SELECT i.topic_id AS "topicId", i.requirement_level AS "requirementLevel", i.target_mastery AS "targetMastery",
              i.observed_mastery AS "observedMastery", i.status, i.priority_rank AS "priorityRank",
              n.name AS "topicTitle"
       FROM career_gap_items i LEFT JOIN taxonomy_nodes n ON n.id = i.topic_id
       WHERE i.snapshot_id=$1 ORDER BY i.priority_rank`, [current.id],
    );
    const gapItems = items.rows.map((row) => ({
      topicId: row.topicId,
      topicTitle: row.topicTitle,
      requirementLevel: row.requirementLevel,
      targetMastery: Number(row.targetMastery),
      observedMastery: row.observedMastery === null ? null : Number(row.observedMastery),
      status: row.status,
      priorityRank: row.priorityRank,
    }));
    // The domain functions take the gap as it was modelled; the response carries the
    // same items plus the topic's published name. Keeping the two shapes apart means
    // a display concern never widens a domain type.
    const domainGap: CareerGap = {
      modelVersion: 'career-gap-v1',
      items: gapItems.map(({ topicTitle: _topicTitle, ...item }) => item),
      requirementsTotal: current.requirementsTotal,
      requirementsMet: current.requirementsMet,
      requirementsUnknown: current.requirementsUnknown,
    };
    return {
      ...target,
      gap: {
        modelVersion: current.modelVersion,
        items: gapItems,
        requirementsTotal: current.requirementsTotal,
        requirementsMet: current.requirementsMet,
        requirementsUnknown: current.requirementsUnknown,
        computedAt: current.computedAt,
        nextActions: careerNextActions(domainGap),
        progress: careerTargetProgress(domainGap),
      },
    };
  }));

  return { targets: resolved };
}

/** Recompute every live target for a learner. Called after evidence changes. */
export async function recomputeAllCareerGaps(client: Queryable, subjectUserId: string): Promise<number> {
  const targets = await client.query<{ careerRoleId: string }>(
    "SELECT career_role_id AS \"careerRoleId\" FROM student_career_targets WHERE student_user_id=$1 AND cleared_at IS NULL",
    [subjectUserId],
  );
  for (const target of targets.rows) {
    await recomputeCareerGap(client, { subjectUserId, careerRoleId: target.careerRoleId });
  }
  return targets.rows.length;
}
