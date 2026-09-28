/**
 * Job-role catalogue persistence (OPS-08, migration 0051): the catalogue seed, the
 * operator catalogue, synonyms, and versioned requirement sets from draft to an approved
 * publish.
 *
 * `career_role_requirements` stays the live set the gap engine reads (career-targets.ts,
 * `computeCareerGap`); a publish copies an approved set into it, in the same transaction
 * that consumes the approval. Every operator write puts its audit row and, where another
 * system may care, its outbox event in its own transaction. The 0051 triggers repeat the
 * lifecycle rules for any other writer.
 *
 * Design: docs/architecture/career-catalogue-table-design.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  normalizeCareerSynonym,
  suppressSmallCount,
  type CareerReleaseLabel,
  type CareerRequirementSetState,
} from '@planthepath/authorization/src/index.js';
import type { CareerCatalogueFile } from './career-catalogue-input.js';
import { consumeOperationApproval, type ConsumedApproval } from './operation-approvals.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

/** A drizzle database or transaction. */
export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}

export interface TransactionalRunner extends SqlRunner {
  transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

type Rows<T> = { rows: T[] };

async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

export type CareerCatalogueErrorCode =
  | 'CAREER_ROLE_NOT_FOUND'
  | 'CAREER_SYNONYM_NOT_FOUND'
  | 'CAREER_SYNONYM_EXISTS'
  | 'CAREER_SET_NOT_FOUND'
  | 'CAREER_SET_OPEN_EXISTS'
  | 'CAREER_SET_NOT_DRAFT'
  | 'CAREER_SET_NOT_REVIEWED'
  | 'CAREER_SET_EMPTY'
  | 'CAREER_SET_TRANSITION_NOT_ALLOWED'
  | 'CAREER_TOPIC_NOT_FOUND'
  | 'CAREER_TOPIC_NOT_LIVE'
  | 'CAREER_CATALOGUE_REJECTED';

export class CareerCatalogueError extends Error {
  constructor(readonly code: CareerCatalogueErrorCode) {
    super(code);
    this.name = 'CareerCatalogueError';
  }
}

/** Postgres unique violation, without forwarding driver text. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code
    ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505';
}

// ---------------------------------------------------------------------------
// Audit and outbox
// ---------------------------------------------------------------------------

async function audit(runner: SqlRunner, input: {
  readonly actorUserId: string; readonly action: string; readonly resourceType: string; readonly resourceId: string;
  readonly correlationId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actorUserId, action: input.action, resourceType: input.resourceType, resourceId: input.resourceId, correlationId: input.correlationId });
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId},
            NULL, 'SUCCESS', ${input.correlationId}, ${JSON.stringify(input.context)}::jsonb)
  `);
}

async function outbox(runner: SqlRunner, input: {
  readonly setId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
  readonly actorUserId: string; readonly correlationId: string;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, aggregateType: 'career_requirement_set', aggregateId: input.setId, eventType: input.eventType, payload: input.payload, actorUserId: input.actorUserId, correlationId: input.correlationId, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, 'career_requirement_set', ${input.setId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actorUserId}::uuid, ${input.correlationId})
  `);
}

/** Who acted, and whether through the super admin's break-glass (§5.1: audited as such). */
export interface CatalogueActor {
  readonly userId: string;
  readonly breakGlass: boolean;
  readonly correlationId: string;
}

function actorContext(actor: CatalogueActor): Record<string, unknown> {
  return actor.breakGlass ? { break_glass: true } : {};
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/** Deterministic ids so a rerun addresses the same rows without storing a mapping (the seed-careers pattern). */
export function deterministicCatalogueId(namespace: string, key: string): string {
  const hash = createHash('sha256').update(`${namespace}:${key}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

export interface CatalogueSeedResult {
  readonly created: number;
  readonly updated: number;
  readonly mappedStarterRoles: readonly string[];
  /** Named, not counted: a starter role whose catalogue row already exists separately. */
  readonly mappingConflicts: readonly string[];
  readonly goalsStored: 0;
}

/**
 * Load the catalogue. Idempotent: rerunning updates catalogue columns in place. A starter
 * role becomes its catalogue row (catalogue columns only; its code, title, family and
 * summary stay the starter seed's). A release label an operator's publish has set is never
 * touched; a new role starts SELECTABLE. No requirement set is written or published.
 */
export async function seedCareerCatalogue(pool: Pool, file: CareerCatalogueFile): Promise<CatalogueSeedResult> {
  const client = await pool.connect();
  const starterByCatalogue = new Map(Object.entries(file.starterMappings).map(([starter, code]) => [code, starter]));
  let created = 0;
  let updated = 0;
  const mapped: string[] = [];
  const conflicts: string[] = [];
  try {
    await client.query('BEGIN');
    for (const role of file.roles) {
      const columns = [role.code, role.family.code, role.title, role.typicalBranches, role.coreSkillAreas, role.mainEvidence, role.plannedRelease, file.version];
      const starterCode = starterByCatalogue.get(role.code);
      const starter = starterCode
        ? (await client.query<{ id: string }>('SELECT id FROM career_roles WHERE lower(code) = lower($1)', [starterCode])).rows[0]
        : undefined;
      const existingCatalogue = (await client.query<{ id: string; origin: string }>(
        'SELECT id, origin FROM career_roles WHERE catalogue_code = $1', [role.code],
      )).rows[0];

      if (starter && (!existingCatalogue || existingCatalogue.id === starter.id)) {
        await client.query(
          `UPDATE career_roles SET catalogue_code=$2, catalogue_family=$3, catalogue_title=$4, eligible_branches=$5,
             core_skill_areas=$6, main_evidence=$7, planned_release=$8, catalogue_version=$9,
             release_label = COALESCE(release_label, 'SELECTABLE'), updated_at = now()
           WHERE id=$1`,
          [starter.id, ...columns],
        );
        mapped.push(`${starterCode}->${role.code}`);
        updated += 1;
        continue;
      }
      if (starter && existingCatalogue) conflicts.push(`${starterCode}->${role.code}`);

      const id = existingCatalogue?.id ?? deterministicCatalogueId('career-catalogue-role', role.code);
      const result = await client.query<{ inserted: boolean }>(
        `INSERT INTO career_roles (id, code, title, family, summary, active, catalogue_code, catalogue_family, catalogue_title,
           eligible_branches, core_skill_areas, main_evidence, planned_release, catalogue_version, release_label, origin)
         VALUES ($1, $2, $4, $10, NULL, true, $2, $3, $4, $5, $6, $7, $8, $9, 'SELECTABLE', 'CATALOGUE')
         ON CONFLICT (id) DO UPDATE SET
           title = CASE WHEN career_roles.origin = 'CATALOGUE' THEN EXCLUDED.title ELSE career_roles.title END,
           family = CASE WHEN career_roles.origin = 'CATALOGUE' THEN EXCLUDED.family ELSE career_roles.family END,
           catalogue_family = EXCLUDED.catalogue_family, catalogue_title = EXCLUDED.catalogue_title,
           eligible_branches = EXCLUDED.eligible_branches, core_skill_areas = EXCLUDED.core_skill_areas,
           main_evidence = EXCLUDED.main_evidence, planned_release = EXCLUDED.planned_release,
           catalogue_version = EXCLUDED.catalogue_version,
           release_label = COALESCE(career_roles.release_label, 'SELECTABLE'), updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [id, ...columns, role.family.label],
      );
      if (result.rows[0]?.inserted) created += 1; else updated += 1;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { created, updated, mappedStarterRoles: mapped, mappingConflicts: conflicts, goalsStored: 0 };
}

/**
 * ENG-19: how each Appendix 4 §G goal is held by a student (docs/architecture/learner-goals-table-design.md).
 * G08 needs an employer's drive target, G10 and G11 are held as real topics, G12 is not a V1 goal type, and
 * G13 is the "Not sure yet" survey, so none of those is selectable by reference.
 */
export const catalogueGoalMapping: Readonly<Record<string, { readonly learnerGoalType: 'EXAM' | 'COMPANY' | 'TOPIC' | 'DISCOVERY' | null; readonly selectable: boolean }>> = {
  G01: { learnerGoalType: 'EXAM', selectable: true },
  G02: { learnerGoalType: 'EXAM', selectable: true },
  G03: { learnerGoalType: 'EXAM', selectable: true },
  G04: { learnerGoalType: 'EXAM', selectable: true },
  G05: { learnerGoalType: 'EXAM', selectable: true },
  G06: { learnerGoalType: 'COMPANY', selectable: true },
  G07: { learnerGoalType: 'COMPANY', selectable: true },
  G08: { learnerGoalType: 'COMPANY', selectable: false },
  G09: { learnerGoalType: 'EXAM', selectable: true },
  G10: { learnerGoalType: 'TOPIC', selectable: false },
  G11: { learnerGoalType: 'TOPIC', selectable: false },
  G12: { learnerGoalType: null, selectable: false },
  G13: { learnerGoalType: 'DISCOVERY', selectable: false },
};

/**
 * Stores the catalogue's thirteen goal rows (ENG-19), idempotently. Separate from `seedCareerCatalogue`,
 * which still stores no goal; `db:seed:career-catalogue` runs both. Source cells are kept verbatim.
 */
export async function seedCareerCatalogueGoals(pool: Pool, file: CareerCatalogueFile): Promise<{ readonly goalsStored: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const goal of file.goals) {
      const mapping = catalogueGoalMapping[goal.code];
      if (!mapping) throw new Error(`catalogue goal ${goal.code} has no ENG-19 mapping`);
      await client.query(
        `INSERT INTO career_catalogue_goals (code, title, source_goal_type, links_to_roles, main_evidence, release, learner_goal_type, selectable, catalogue_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, source_goal_type = EXCLUDED.source_goal_type,
           links_to_roles = EXCLUDED.links_to_roles, main_evidence = EXCLUDED.main_evidence, release = EXCLUDED.release,
           learner_goal_type = EXCLUDED.learner_goal_type, selectable = EXCLUDED.selectable,
           catalogue_version = EXCLUDED.catalogue_version, updated_at = now()`,
        [goal.code, goal.title, goal.goalType, goal.linksToRoles, goal.mainEvidence, goal.release, mapping.learnerGoalType, mapping.selectable, file.version],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { goalsStored: file.goals.length };
}

// ---------------------------------------------------------------------------
// Catalogue reads
// ---------------------------------------------------------------------------

export interface CatalogueRoleFilters {
  readonly q?: string;
  readonly family?: string;
  readonly branch?: string;
  readonly releaseLabel?: CareerReleaseLabel;
}

export interface CatalogueRoleRow {
  readonly id: string;
  readonly code: string;
  readonly catalogueCode: string | null;
  readonly title: string;
  readonly catalogueTitle: string | null;
  readonly family: string;
  readonly catalogueFamily: string | null;
  readonly eligibleBranches: readonly string[];
  readonly plannedRelease: string | null;
  readonly releaseLabel: CareerReleaseLabel | null;
  readonly origin: 'STARTER' | 'CATALOGUE';
  readonly active: boolean;
  readonly liveRequirementCount: number;
  readonly openSetState: CareerRequirementSetState | null;
  readonly publishedVersion: number | null;
  readonly synonymCount: number;
}

interface CatalogueRoleDbRow {
  id: string; code: string; catalogue_code: string | null; title: string; catalogue_title: string | null; family: string;
  catalogue_family: string | null; eligible_branches: string[]; planned_release: string | null; release_label: CareerReleaseLabel | null;
  origin: 'STARTER' | 'CATALOGUE'; active: boolean; live_requirement_count: number; open_set_state: CareerRequirementSetState | null;
  published_version: number | null; synonym_count: number; sort_key: string;
}

function mapRole(row: CatalogueRoleDbRow): CatalogueRoleRow {
  return {
    id: row.id, code: row.code, catalogueCode: row.catalogue_code, title: row.title, catalogueTitle: row.catalogue_title,
    family: row.family, catalogueFamily: row.catalogue_family, eligibleBranches: row.eligible_branches ?? [],
    plannedRelease: row.planned_release, releaseLabel: row.release_label, origin: row.origin, active: row.active,
    liveRequirementCount: Number(row.live_requirement_count), openSetState: row.open_set_state,
    publishedVersion: row.published_version === null ? null : Number(row.published_version), synonymCount: Number(row.synonym_count),
  };
}

// Family, then catalogue code, then non-catalogue roles by code. "C" collation so the keyset
// comparison and the ORDER BY agree on every server whatever its locale.
const sortKey = sql`(COALESCE(r.catalogue_family || ':' || r.catalogue_code, 'Z:' || r.code) COLLATE "C")`;

const roleSelect = sql`
  SELECT r.id, r.code, r.catalogue_code, r.title, r.catalogue_title, r.family, r.catalogue_family, r.eligible_branches,
         r.planned_release, r.release_label, r.origin, r.active,
         (SELECT count(*)::int FROM career_role_requirements q WHERE q.career_role_id = r.id) AS live_requirement_count,
         (SELECT s.state FROM career_requirement_sets s WHERE s.career_role_id = r.id AND s.state IN ('DRAFT','IN_REVIEW','REVIEWED')) AS open_set_state,
         (SELECT s.version FROM career_requirement_sets s WHERE s.career_role_id = r.id AND s.state = 'PUBLISHED') AS published_version,
         (SELECT count(*)::int FROM career_role_synonyms y WHERE y.career_role_id = r.id AND y.removed_at IS NULL) AS synonym_count,
         ${sortKey} AS sort_key
  FROM career_roles r`;

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * The operator catalogue, searchable by code, name, branch and synonym, filtered by
 * family, branch and release label; keyset paginated on (sort key, id).
 */
export async function listCatalogueRoles(runner: SqlRunner, input: {
  readonly filters: CatalogueRoleFilters;
  readonly limit: number;
  readonly cursor?: { readonly key: string; readonly id: string };
}): Promise<{ readonly roles: readonly CatalogueRoleRow[]; readonly nextCursor: { readonly key: string; readonly id: string } | null }> {
  const filters = input.filters;
  const q = filters.q ? likePattern(normalizeCareerSynonym(filters.q)) : null;
  const branch = filters.branch ? filters.branch.trim().toLowerCase() : null;
  const result = await rows<CatalogueRoleDbRow>(runner, sql`
    ${roleSelect}
    WHERE (${filters.family ?? null}::text IS NULL OR r.catalogue_family = ${filters.family ?? null})
      AND (${filters.releaseLabel ?? null}::text IS NULL OR r.release_label = ${filters.releaseLabel ?? null})
      AND (${branch}::text IS NULL OR EXISTS (
        SELECT 1 FROM unnest(r.eligible_branches) AS b WHERE lower(b) = ${branch} OR lower(b) IN ('all branches', 'any')))
      AND (${q}::text IS NULL
        OR lower(r.code) LIKE ${q} OR lower(COALESCE(r.catalogue_code, '')) LIKE ${q}
        OR lower(r.title) LIKE ${q} OR lower(COALESCE(r.catalogue_title, '')) LIKE ${q}
        OR EXISTS (SELECT 1 FROM unnest(r.eligible_branches) AS b WHERE lower(b) LIKE ${q})
        OR EXISTS (SELECT 1 FROM career_role_synonyms y WHERE y.career_role_id = r.id AND y.removed_at IS NULL AND y.normalized LIKE ${q}))
      AND (${input.cursor?.key ?? null}::text IS NULL
        OR (${sortKey}, r.id) > ((${input.cursor?.key ?? null}::text COLLATE "C"), ${input.cursor?.id ?? null}::uuid))
    ORDER BY ${sortKey}, r.id
    LIMIT ${input.limit + 1}
  `);
  const page = result.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    roles: page.map(mapRole),
    nextCursor: result.length > input.limit && last ? { key: last.sort_key, id: last.id } : null,
  };
}

export interface CatalogueSummary {
  readonly totalRoles: number;
  readonly catalogueRoles: number;
  readonly starterRoles: number;
  readonly selectable: number;
  readonly verified: number;
  readonly plannedV1: number;
  readonly plannedV2: number;
  readonly plannedV3: number;
  readonly liveSynonyms: number;
  readonly setsInDraft: number;
  readonly setsInReview: number;
  readonly setsReviewed: number;
  readonly setsPublished: number;
}

/** Counts for the header, computed in one bounded query (§5.7), never in the browser. */
export async function summariseCatalogue(runner: SqlRunner): Promise<CatalogueSummary> {
  const [row] = await rows<Record<string, number>>(runner, sql`
    SELECT
      (SELECT count(*)::int FROM career_roles WHERE active) AS total_roles,
      (SELECT count(*)::int FROM career_roles WHERE active AND catalogue_code IS NOT NULL) AS catalogue_roles,
      (SELECT count(*)::int FROM career_roles WHERE active AND origin = 'STARTER') AS starter_roles,
      (SELECT count(*)::int FROM career_roles WHERE active AND release_label = 'SELECTABLE') AS selectable,
      (SELECT count(*)::int FROM career_roles WHERE active AND release_label = 'VERIFIED') AS verified,
      (SELECT count(*)::int FROM career_roles WHERE active AND planned_release = 'V1') AS planned_v1,
      (SELECT count(*)::int FROM career_roles WHERE active AND planned_release = 'V2') AS planned_v2,
      (SELECT count(*)::int FROM career_roles WHERE active AND planned_release = 'V3') AS planned_v3,
      (SELECT count(*)::int FROM career_role_synonyms WHERE removed_at IS NULL) AS live_synonyms,
      (SELECT count(*)::int FROM career_requirement_sets WHERE state = 'DRAFT') AS sets_in_draft,
      (SELECT count(*)::int FROM career_requirement_sets WHERE state = 'IN_REVIEW') AS sets_in_review,
      (SELECT count(*)::int FROM career_requirement_sets WHERE state = 'REVIEWED') AS sets_reviewed,
      (SELECT count(*)::int FROM career_requirement_sets WHERE state = 'PUBLISHED') AS sets_published
  `);
  const value = (key: string): number => Number(row?.[key] ?? 0);
  return {
    totalRoles: value('total_roles'), catalogueRoles: value('catalogue_roles'), starterRoles: value('starter_roles'),
    selectable: value('selectable'), verified: value('verified'),
    plannedV1: value('planned_v1'), plannedV2: value('planned_v2'), plannedV3: value('planned_v3'),
    liveSynonyms: value('live_synonyms'), setsInDraft: value('sets_in_draft'), setsInReview: value('sets_in_review'),
    setsReviewed: value('sets_reviewed'), setsPublished: value('sets_published'),
  };
}

/** Distinct branch labels in the catalogue, for the branch filter. */
export async function listCatalogueBranches(runner: SqlRunner): Promise<readonly string[]> {
  const result = await rows<{ branch: string }>(runner, sql`
    SELECT DISTINCT b AS branch FROM career_roles r, unnest(r.eligible_branches) AS b
    WHERE r.active AND lower(b) NOT IN ('all branches', 'any')
    ORDER BY 1
  `);
  return result.map((row) => row.branch);
}

export interface RequirementItemView {
  readonly topicId: string;
  readonly topicKey: string | null;
  readonly topicTitle: string | null;
  /** False for a pending topic (0056): drafted, not yet published. A set naming one cannot publish. */
  readonly topicLive: boolean;
  readonly requirementLevel: 'ESSENTIAL' | 'IMPORTANT' | 'HELPFUL';
  readonly targetMastery: number;
  readonly rationale: string | null;
  readonly requiredEvidenceTypes: readonly string[];
}

export interface RequirementSetView {
  readonly id: string;
  readonly version: number;
  readonly state: CareerRequirementSetState;
  readonly basedOn: 'EMPTY' | 'LIVE' | 'SET';
  readonly reasonCode: string;
  readonly author: { readonly userId: string; readonly email: string };
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly reviewer: { readonly userId: string; readonly email: string } | null;
  readonly reviewedAt: string | null;
  readonly reviewReasonCode: string | null;
  readonly reviewNote: string | null;
  readonly publishedAt: string | null;
  readonly publisherEmail: string | null;
  readonly releaseLabelAtPublish: CareerReleaseLabel | null;
  readonly supersededAt: string | null;
  readonly withdrawnAt: string | null;
  /** Who or what wrote the set (0056). review_state is `state`. */
  readonly provenance: CareerSetProvenanceView;
  readonly items: readonly RequirementItemView[];
}

export interface CareerSetProvenanceView {
  readonly source: 'AUTHORED' | 'AGENT_DRAFTED';
  readonly generatorVersion: string | null;
  readonly promptVersion: string | null;
  readonly generatedAt: string | null;
  readonly sourceBasis: string | null;
}

export interface CatalogueRoleDetail extends CatalogueRoleRow {
  readonly summary: string | null;
  readonly coreSkillAreas: string | null;
  readonly mainEvidence: string | null;
  readonly catalogueVersion: string | null;
  readonly synonyms: readonly { readonly id: string; readonly synonym: string; readonly reasonCode: string; readonly createdAt: string }[];
  readonly liveRequirements: readonly RequirementItemView[];
  readonly requirementSets: readonly RequirementSetView[];
  /** Students with this role as a live target: a count, never names (no personal data here). */
  /** Students with a live target on this role; null when under the shared small-count threshold. */
  readonly liveTargetCount: number | null;
  readonly liveTargetCountSuppressed: boolean;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

function mapItem(row: { topic_id: string; topic_key: string | null; topic_title: string | null; topic_live: boolean | null; requirement_level: RequirementItemView['requirementLevel']; target_mastery: string; rationale: string | null; required_evidence_types: string[] | null }): RequirementItemView {
  return {
    topicId: row.topic_id, topicKey: row.topic_key, topicTitle: row.topic_title, topicLive: row.topic_live === true, requirementLevel: row.requirement_level,
    targetMastery: Number(row.target_mastery), rationale: row.rationale, requiredEvidenceTypes: row.required_evidence_types ?? [],
  };
}

export async function loadCatalogueRole(runner: SqlRunner, roleId: string): Promise<CatalogueRoleDetail | null> {
  const [role] = await rows<CatalogueRoleDbRow & { summary: string | null; core_skill_areas: string | null; main_evidence: string | null; catalogue_version: string | null; live_target_count: number }>(runner, sql`
    SELECT base.*, r.summary, r.core_skill_areas, r.main_evidence, r.catalogue_version,
           (SELECT count(*)::int FROM student_career_targets t WHERE t.career_role_id = r.id AND t.cleared_at IS NULL) AS live_target_count
    FROM (${roleSelect} WHERE r.id = ${roleId}::uuid) base JOIN career_roles r ON r.id = base.id
  `);
  if (!role) return null;
  const synonyms = await rows<{ id: string; synonym: string; reason_code: string; created_at: Date }>(runner, sql`
    SELECT id, synonym, reason_code, created_at FROM career_role_synonyms
    WHERE career_role_id = ${roleId}::uuid AND removed_at IS NULL ORDER BY normalized
  `);
  const live = await rows<Parameters<typeof mapItem>[0]>(runner, sql`
    SELECT q.topic_id, n.stable_key AS topic_key, n.name AS topic_title, n.active AS topic_live, q.requirement_level, q.target_mastery, q.rationale,
           q.required_evidence_types
    FROM career_role_requirements q LEFT JOIN taxonomy_nodes n ON n.id = q.topic_id
    WHERE q.career_role_id = ${roleId}::uuid
    ORDER BY CASE q.requirement_level WHEN 'ESSENTIAL' THEN 0 WHEN 'IMPORTANT' THEN 1 ELSE 2 END, n.name
  `);
  const sets = await rows<{
    id: string; version: number; state: CareerRequirementSetState; based_on: RequirementSetView['basedOn']; reason_code: string;
    created_by_user_id: string; author_email: string; created_at: Date; submitted_at: Date | null;
    reviewed_by_user_id: string | null; reviewer_email: string | null; reviewed_at: Date | null; review_reason_code: string | null; review_note: string | null;
    published_at: Date | null; publisher_email: string | null; release_label_at_publish: CareerReleaseLabel | null; superseded_at: Date | null; withdrawn_at: Date | null;
    source: CareerSetProvenanceView['source']; generator_version: string | null; prompt_version: string | null; generated_at: Date | null; source_basis: string | null;
  }>(runner, sql`
    SELECT s.id, s.version, s.state, s.based_on, s.reason_code, s.created_by_user_id, au.email AS author_email, s.created_at,
           s.submitted_at, s.reviewed_by_user_id, ru.email AS reviewer_email, s.reviewed_at, s.review_reason_code, s.review_note,
           s.published_at, pu.email AS publisher_email, s.release_label_at_publish, s.superseded_at, s.withdrawn_at,
           s.source, s.generator_version, s.prompt_version, s.generated_at, s.source_basis
    FROM career_requirement_sets s
    JOIN users au ON au.id = s.created_by_user_id
    LEFT JOIN users ru ON ru.id = s.reviewed_by_user_id
    LEFT JOIN users pu ON pu.id = s.published_by_user_id
    WHERE s.career_role_id = ${roleId}::uuid
    ORDER BY s.version DESC
    LIMIT 20
  `);
  const items = sets.length ? await rows<Parameters<typeof mapItem>[0] & { set_id: string }>(runner, sql`
    SELECT i.set_id, i.topic_id, n.stable_key AS topic_key, n.name AS topic_title, n.active AS topic_live, i.requirement_level, i.target_mastery, i.rationale,
           i.required_evidence_types
    FROM career_requirement_set_items i LEFT JOIN taxonomy_nodes n ON n.id = i.topic_id
    WHERE i.set_id IN (${sql.join(sets.map((set) => sql`${set.id}::uuid`), sql`, `)})
    ORDER BY CASE i.requirement_level WHEN 'ESSENTIAL' THEN 0 WHEN 'IMPORTANT' THEN 1 ELSE 2 END, n.name
  `) : [];
  return {
    ...mapRole(role),
    summary: role.summary,
    coreSkillAreas: role.core_skill_areas,
    mainEvidence: role.main_evidence,
    catalogueVersion: role.catalogue_version,
    ...liveTargetCountFor(Number(role.live_target_count)),
    synonyms: synonyms.map((row) => ({ id: row.id, synonym: row.synonym, reasonCode: row.reason_code, createdAt: iso(row.created_at)! })),
    liveRequirements: live.map(mapItem),
    requirementSets: sets.map((set) => ({
      id: set.id, version: Number(set.version), state: set.state, basedOn: set.based_on, reasonCode: set.reason_code,
      author: { userId: set.created_by_user_id, email: set.author_email }, createdAt: iso(set.created_at)!, submittedAt: iso(set.submitted_at),
      reviewer: set.reviewed_by_user_id && set.reviewer_email ? { userId: set.reviewed_by_user_id, email: set.reviewer_email } : null,
      reviewedAt: iso(set.reviewed_at), reviewReasonCode: set.review_reason_code, reviewNote: set.review_note,
      publishedAt: iso(set.published_at), publisherEmail: set.publisher_email, releaseLabelAtPublish: set.release_label_at_publish,
      supersededAt: iso(set.superseded_at), withdrawnAt: iso(set.withdrawn_at),
      provenance: {
        source: set.source, generatorVersion: set.generator_version, promptVersion: set.prompt_version,
        generatedAt: iso(set.generated_at), sourceBasis: set.source_basis,
      },
      items: items.filter((item) => item.set_id === set.id).map(mapItem),
    })),
  };
}

/** Active taxonomy topics an operator can require, by name or stable key. */
export async function searchCatalogueTopics(runner: SqlRunner, query: string, limit: number): Promise<readonly { readonly id: string; readonly stableKey: string; readonly name: string }[]> {
  const pattern = likePattern(query.trim().toLowerCase());
  const result = await rows<{ id: string; stable_key: string; name: string }>(runner, sql`
    SELECT DISTINCT ON (stable_key) id, stable_key, name FROM taxonomy_nodes
    WHERE kind = 'TOPIC' AND active AND (lower(name) LIKE ${pattern} OR lower(stable_key) LIKE ${pattern})
    ORDER BY stable_key, version DESC
    LIMIT ${limit}
  `);
  return result.map((row) => ({ id: row.id, stableKey: row.stable_key, name: row.name }));
}

// ---------------------------------------------------------------------------
// Synonyms
// ---------------------------------------------------------------------------

export async function addCareerRoleSynonym(db: TransactionalRunner, input: {
  readonly roleId: string; readonly synonym: string; readonly reasonCode: string; readonly actor: CatalogueActor;
}): Promise<{ readonly id: string }> {
  const id = randomUUID();
  const synonym = input.synonym.trim().replace(/\s+/g, ' ');
  try {
    await db.transaction(async (tx) => {
      const role = await rows<{ id: string }>(tx, sql`SELECT id FROM career_roles WHERE id = ${input.roleId}::uuid`);
      if (!role[0]) throw new CareerCatalogueError('CAREER_ROLE_NOT_FOUND');
      await tx.execute(sql`
        INSERT INTO career_role_synonyms (id, career_role_id, synonym, normalized, reason_code, created_by_user_id)
        VALUES (${id}::uuid, ${input.roleId}::uuid, ${synonym}, ${normalizeCareerSynonym(synonym)}, ${input.reasonCode}, ${input.actor.userId}::uuid)
      `);
      await audit(tx, {
        actorUserId: input.actor.userId, action: 'operations.career_catalogue.synonym_added', resourceType: 'career_role',
        resourceId: input.roleId, correlationId: input.actor.correlationId,
        context: { synonymId: id, synonym, reasonCode: input.reasonCode, ...actorContext(input.actor) },
      });
    });
  } catch (error) {
    if (error instanceof CareerCatalogueError) throw error;
    if (isUniqueViolation(error)) throw new CareerCatalogueError('CAREER_SYNONYM_EXISTS');
    throw new CareerCatalogueError('CAREER_CATALOGUE_REJECTED');
  }
  return { id };
}

export async function removeCareerRoleSynonym(db: TransactionalRunner, input: {
  readonly roleId: string; readonly synonymId: string; readonly reasonCode: string; readonly actor: CatalogueActor;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const updated = await rows<{ synonym: string }>(tx, sql`
      UPDATE career_role_synonyms
      SET removed_at = now(), removed_by_user_id = ${input.actor.userId}::uuid, removed_reason_code = ${input.reasonCode}
      WHERE id = ${input.synonymId}::uuid AND career_role_id = ${input.roleId}::uuid AND removed_at IS NULL
      RETURNING synonym
    `);
    if (!updated[0]) throw new CareerCatalogueError('CAREER_SYNONYM_NOT_FOUND');
    await audit(tx, {
      actorUserId: input.actor.userId, action: 'operations.career_catalogue.synonym_removed', resourceType: 'career_role',
      resourceId: input.roleId, correlationId: input.actor.correlationId,
      context: { synonymId: input.synonymId, synonym: updated[0].synonym, reasonCode: input.reasonCode, ...actorContext(input.actor) },
    });
  });
}

// ---------------------------------------------------------------------------
// Requirement sets
// ---------------------------------------------------------------------------

export interface RequirementItemInput {
  readonly topicId: string;
  readonly requirementLevel: 'ESSENTIAL' | 'IMPORTANT' | 'HELPFUL';
  readonly targetMastery: number;
  readonly rationale: string | null;
  readonly requiredEvidenceTypes: readonly string[];
}

async function stateChanged(tx: SqlRunner, input: {
  readonly setId: string; readonly roleId: string; readonly from: CareerRequirementSetState; readonly to: CareerRequirementSetState; readonly actor: CatalogueActor;
}): Promise<void> {
  await outbox(tx, {
    setId: input.setId, eventType: 'career_requirement_set.state_changed',
    payload: { setId: input.setId, careerRoleId: input.roleId, fromState: input.from, toState: input.to },
    actorUserId: input.actor.userId, correlationId: input.actor.correlationId,
  });
}

/**
 * Start the next version as a DRAFT, copied from the published set if there is one, else
 * from the live requirements (a starter role before its first set), else empty.
 */
export async function createRequirementSetDraft(db: TransactionalRunner, input: {
  readonly roleId: string; readonly reasonCode: string; readonly actor: CatalogueActor;
  /** Set only for model-produced content (Part B.8); written once, immutable (0056). */
  readonly provenance?: CareerSetProvenance;
}): Promise<{ readonly id: string; readonly version: number }> {
  const provenance = input.provenance ?? null;
  const id = randomUUID();
  try {
    return await db.transaction(async (tx) => {
      const role = await rows<{ id: string }>(tx, sql`SELECT id FROM career_roles WHERE id = ${input.roleId}::uuid FOR UPDATE`);
      if (!role[0]) throw new CareerCatalogueError('CAREER_ROLE_NOT_FOUND');
      const open = await rows<{ id: string }>(tx, sql`
        SELECT id FROM career_requirement_sets WHERE career_role_id = ${input.roleId}::uuid AND state IN ('DRAFT','IN_REVIEW','REVIEWED')
      `);
      if (open[0]) throw new CareerCatalogueError('CAREER_SET_OPEN_EXISTS');
      const [next] = await rows<{ version: number }>(tx, sql`
        SELECT COALESCE(max(version), 0)::int + 1 AS version FROM career_requirement_sets WHERE career_role_id = ${input.roleId}::uuid
      `);
      const version = Number(next!.version);
      const published = await rows<{ id: string }>(tx, sql`
        SELECT id FROM career_requirement_sets WHERE career_role_id = ${input.roleId}::uuid AND state = 'PUBLISHED'
      `);
      const [live] = await rows<{ count: number }>(tx, sql`
        SELECT count(*)::int AS count FROM career_role_requirements WHERE career_role_id = ${input.roleId}::uuid
      `);
      const basedOn = published[0] ? 'SET' : Number(live?.count ?? 0) > 0 ? 'LIVE' : 'EMPTY';
      await tx.execute(sql`
        INSERT INTO career_requirement_sets (id, career_role_id, version, state, based_on, based_on_set_id, reason_code, created_by_user_id,
                                             source, generator_version, prompt_version, generated_at, source_basis)
        VALUES (${id}::uuid, ${input.roleId}::uuid, ${version}, 'DRAFT', ${basedOn}, ${published[0]?.id ?? null}::uuid,
                ${input.reasonCode}, ${input.actor.userId}::uuid,
                ${provenance ? 'AGENT_DRAFTED' : 'AUTHORED'}, ${provenance?.generatorVersion ?? null}, ${provenance?.promptVersion ?? null},
                ${provenance?.generatedAt ?? null}::timestamptz, ${provenance?.sourceBasis ?? null})
      `);
      if (basedOn === 'SET') {
        await tx.execute(sql`
          INSERT INTO career_requirement_set_items (id, set_id, topic_id, requirement_level, target_mastery, rationale, required_evidence_types)
          SELECT gen_random_uuid(), ${id}::uuid, topic_id, requirement_level, target_mastery, rationale, required_evidence_types
          FROM career_requirement_set_items WHERE set_id = ${published[0]!.id}::uuid
        `);
      } else if (basedOn === 'LIVE') {
        await tx.execute(sql`
          INSERT INTO career_requirement_set_items (id, set_id, topic_id, requirement_level, target_mastery, rationale, required_evidence_types)
          SELECT gen_random_uuid(), ${id}::uuid, topic_id, requirement_level, target_mastery, rationale, required_evidence_types
          FROM career_role_requirements WHERE career_role_id = ${input.roleId}::uuid
        `);
      }
      await audit(tx, {
        actorUserId: input.actor.userId, action: 'operations.career_catalogue.requirement_set_created', resourceType: 'career_requirement_set',
        resourceId: id, correlationId: input.actor.correlationId,
        context: {
          careerRoleId: input.roleId, version, basedOn, reasonCode: input.reasonCode,
          ...(provenance ? { source: 'AGENT_DRAFTED', generatorVersion: provenance.generatorVersion, promptVersion: provenance.promptVersion } : {}),
          ...actorContext(input.actor),
        },
      });
      return { id, version };
    });
  } catch (error) {
    if (error instanceof CareerCatalogueError) throw error;
    if (isUniqueViolation(error)) throw new CareerCatalogueError('CAREER_SET_OPEN_EXISTS');
    throw new CareerCatalogueError('CAREER_CATALOGUE_REJECTED');
  }
}

async function lockSet(tx: SqlRunner, setId: string): Promise<{ id: string; career_role_id: string; state: CareerRequirementSetState; created_by_user_id: string; version: number }> {
  const [set] = await rows<{ id: string; career_role_id: string; state: CareerRequirementSetState; created_by_user_id: string; version: number }>(tx, sql`
    SELECT id, career_role_id, state, created_by_user_id, version FROM career_requirement_sets WHERE id = ${setId}::uuid FOR UPDATE
  `);
  if (!set) throw new CareerCatalogueError('CAREER_SET_NOT_FOUND');
  return set;
}

/** Agent provenance for a requirement set (0056). `review_state` is the set's lifecycle state. */
export interface CareerSetProvenance {
  readonly generatorVersion: string;
  readonly promptVersion: string;
  readonly generatedAt: string;
  readonly sourceBasis: string;
}

/**
 * Replace a draft's items. Each topic must be a live (active) TOPIC, or a pending one: an
 * inactive TOPIC whose content revision is still on its way to publication (0056). A retired
 * topic is neither. A set naming a pending topic cannot publish until the topic is live.
 */
export async function saveRequirementSetItems(db: TransactionalRunner, input: {
  readonly setId: string; readonly items: readonly RequirementItemInput[]; readonly actor: CatalogueActor;
}): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const set = await lockSet(tx, input.setId);
      if (set.state !== 'DRAFT') throw new CareerCatalogueError('CAREER_SET_NOT_DRAFT');
      if (input.items.length) {
        const found = await rows<{ id: string }>(tx, sql`
          SELECT n.id FROM taxonomy_nodes n JOIN content_revisions c ON c.id = n.content_revision_id
          WHERE n.kind = 'TOPIC'
            AND (n.active OR c.state IN ('DRAFT','IN_REVIEW','CHANGES_REQUESTED','APPROVED'))
            AND n.id IN (${sql.join(input.items.map((item) => sql`${item.topicId}::uuid`), sql`, `)})
        `);
        if (found.length !== new Set(input.items.map((item) => item.topicId)).size) throw new CareerCatalogueError('CAREER_TOPIC_NOT_FOUND');
      }
      await tx.execute(sql`DELETE FROM career_requirement_set_items WHERE set_id = ${input.setId}::uuid`);
      for (const item of input.items) {
        await tx.execute(sql`
          INSERT INTO career_requirement_set_items (id, set_id, topic_id, requirement_level, target_mastery, rationale, required_evidence_types)
          VALUES (${randomUUID()}::uuid, ${input.setId}::uuid, ${item.topicId}::uuid, ${item.requirementLevel}, ${item.targetMastery},
                  ${item.rationale}, ${sql`ARRAY[${sql.join(item.requiredEvidenceTypes.map((type) => sql`${type}`), sql`, `)}]::text[]`})
        `);
      }
      await audit(tx, {
        actorUserId: input.actor.userId, action: 'operations.career_catalogue.requirement_set_items_saved', resourceType: 'career_requirement_set',
        resourceId: input.setId, correlationId: input.actor.correlationId,
        context: { careerRoleId: set.career_role_id, version: Number(set.version), itemCount: input.items.length, reasonCode: 'DRAFT_EDIT', ...actorContext(input.actor) },
      });
    });
  } catch (error) {
    if (error instanceof CareerCatalogueError) throw error;
    throw new CareerCatalogueError('CAREER_CATALOGUE_REJECTED');
  }
}

/**
 * Move a set between operator states. `refuse` is the pure rule from packages/authorization,
 * evaluated against the locked row, so the author check uses the stored author.
 */
export async function transitionRequirementSet(db: TransactionalRunner, input: {
  readonly setId: string; readonly toState: CareerRequirementSetState; readonly reasonCode: string; readonly note: string | null;
  readonly actor: CatalogueActor;
  readonly refuse: (current: { readonly from: CareerRequirementSetState; readonly authorUserId: string }) => string | null;
}): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const set = await lockSet(tx, input.setId);
      const refusal = input.refuse({ from: set.state, authorUserId: set.created_by_user_id });
      if (refusal) throw new CareerTransitionRefused(refusal);
      if (input.toState === 'IN_REVIEW') {
        const [count] = await rows<{ count: number }>(tx, sql`SELECT count(*)::int AS count FROM career_requirement_set_items WHERE set_id = ${input.setId}::uuid`);
        if (!Number(count?.count ?? 0)) throw new CareerCatalogueError('CAREER_SET_EMPTY');
      }
      const actorId = input.actor.userId;
      if (input.toState === 'IN_REVIEW') {
        await tx.execute(sql`UPDATE career_requirement_sets SET state = 'IN_REVIEW', submitted_by_user_id = ${actorId}::uuid, submitted_at = now() WHERE id = ${input.setId}::uuid`);
      } else if (input.toState === 'REVIEWED') {
        await tx.execute(sql`
          UPDATE career_requirement_sets SET state = 'REVIEWED', reviewed_by_user_id = ${actorId}::uuid, reviewed_at = now(),
            review_reason_code = ${input.reasonCode}, review_note = ${input.note}
          WHERE id = ${input.setId}::uuid`);
      } else if (input.toState === 'DRAFT') {
        await tx.execute(sql`
          UPDATE career_requirement_sets SET state = 'DRAFT', submitted_by_user_id = NULL, submitted_at = NULL,
            reviewed_by_user_id = NULL, reviewed_at = NULL, review_reason_code = ${input.reasonCode}, review_note = ${input.note}
          WHERE id = ${input.setId}::uuid`);
      } else if (input.toState === 'WITHDRAWN') {
        await tx.execute(sql`UPDATE career_requirement_sets SET state = 'WITHDRAWN', withdrawn_at = now(), withdrawn_reason_code = ${input.reasonCode} WHERE id = ${input.setId}::uuid`);
      } else {
        throw new CareerCatalogueError('CAREER_SET_TRANSITION_NOT_ALLOWED');
      }
      await audit(tx, {
        actorUserId: actorId, action: 'operations.career_catalogue.requirement_set_transitioned', resourceType: 'career_requirement_set',
        resourceId: input.setId, correlationId: input.actor.correlationId,
        context: { careerRoleId: set.career_role_id, version: Number(set.version), fromState: set.state, toState: input.toState, reasonCode: input.reasonCode, ...(input.note ? { note: input.note } : {}), ...actorContext(input.actor) },
      });
      await stateChanged(tx, { setId: input.setId, roleId: set.career_role_id, from: set.state, to: input.toState, actor: input.actor });
    });
  } catch (error) {
    if (error instanceof CareerCatalogueError || error instanceof CareerTransitionRefused) throw error;
    throw new CareerCatalogueError('CAREER_CATALOGUE_REJECTED');
  }
}

/** A refusal from the pure transition rule, carried out of the transaction as is. */
export class CareerTransitionRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CareerTransitionRefused';
  }
}

/** The set a publish request names, for the approval's target check. */
export async function loadRequirementSetForPublish(runner: SqlRunner, setId: string): Promise<{ readonly id: string; readonly state: CareerRequirementSetState; readonly careerRoleId: string; readonly version: number } | null> {
  const [set] = await rows<{ id: string; state: CareerRequirementSetState; career_role_id: string; version: number }>(runner, sql`
    SELECT id, state, career_role_id, version FROM career_requirement_sets WHERE id = ${setId}::uuid
  `);
  return set ? { id: set.id, state: set.state, careerRoleId: set.career_role_id, version: Number(set.version) } : null;
}

/**
 * Publish a reviewed set, in one transaction: consume the approval for exactly this
 * payload, supersede the previous published set, make this one PUBLISHED, replace the
 * role's live requirements with its items, set the role's release label as approved, and
 * write the audit row and events. If anything fails, all of it rolls back and the approval
 * stays usable. No gap is recomputed here (§5.7): gaps are snapshots, recomputed by the
 * existing paths; the published event is there for a later worker.
 */
export async function publishRequirementSet(db: TransactionalRunner, input: {
  readonly setId: string;
  readonly releaseLabel: CareerReleaseLabel;
  readonly reasonCode: string;
  readonly approvalId: string;
  readonly approvalPayload: Record<string, unknown>;
  readonly actor: CatalogueActor;
}): Promise<{ readonly approval: ConsumedApproval; readonly careerRoleId: string; readonly version: number }> {
  return db.transaction(async (tx) => {
    const set = await lockSet(tx, input.setId);
    if (set.state !== 'REVIEWED') throw new CareerCatalogueError('CAREER_SET_NOT_REVIEWED');
    // Checked before the approval is consumed, so a refused publish leaves it usable (0056 repeats this rule).
    const pending = await rows<{ id: string }>(tx, sql`
      SELECT i.topic_id AS id FROM career_requirement_set_items i JOIN taxonomy_nodes n ON n.id = i.topic_id
      WHERE i.set_id = ${input.setId}::uuid AND NOT n.active LIMIT 1
    `);
    if (pending[0]) throw new CareerCatalogueError('CAREER_TOPIC_NOT_LIVE');
    const approval = await consumeOperationApproval(tx, {
      approvalId: input.approvalId, actionKey: 'CAREER_REQUIREMENT_SET_PUBLISH', payload: input.approvalPayload,
      executorUserId: input.actor.userId, correlationId: input.actor.correlationId,
    });
    await tx.execute(sql`
      UPDATE career_requirement_sets SET state = 'SUPERSEDED', superseded_at = now()
      WHERE career_role_id = ${set.career_role_id}::uuid AND state = 'PUBLISHED'
    `);
    await tx.execute(sql`
      UPDATE career_requirement_sets
      SET state = 'PUBLISHED', published_by_user_id = ${input.actor.userId}::uuid, published_at = now(),
          publish_approval_id = ${input.approvalId}::uuid, publish_reason_code = ${input.reasonCode},
          release_label_at_publish = ${input.releaseLabel}
      WHERE id = ${input.setId}::uuid
    `);
    // The live set becomes exactly the published items. Gap snapshots keep their own copy
    // of what they measured, so replacing live rows rewrites no student's history.
    await tx.execute(sql`
      DELETE FROM career_role_requirements q
      WHERE q.career_role_id = ${set.career_role_id}::uuid
        AND NOT EXISTS (SELECT 1 FROM career_requirement_set_items i WHERE i.set_id = ${input.setId}::uuid AND i.topic_id = q.topic_id)
    `);
    await tx.execute(sql`
      INSERT INTO career_role_requirements (id, career_role_id, topic_id, requirement_level, target_mastery, rationale, required_evidence_types)
      SELECT gen_random_uuid(), ${set.career_role_id}::uuid, i.topic_id, i.requirement_level, i.target_mastery, i.rationale, i.required_evidence_types
      FROM career_requirement_set_items i WHERE i.set_id = ${input.setId}::uuid
      ON CONFLICT (career_role_id, topic_id) DO UPDATE SET
        requirement_level = EXCLUDED.requirement_level, target_mastery = EXCLUDED.target_mastery,
        rationale = EXCLUDED.rationale, required_evidence_types = EXCLUDED.required_evidence_types
    `);
    await tx.execute(sql`
      UPDATE career_roles SET release_label = ${input.releaseLabel}, updated_at = now()
      WHERE id = ${set.career_role_id}::uuid AND release_label IS DISTINCT FROM ${input.releaseLabel}
    `);
    await audit(tx, {
      actorUserId: input.actor.userId, action: 'operations.career_catalogue.requirement_set_published', resourceType: 'career_requirement_set',
      resourceId: input.setId, correlationId: input.actor.correlationId,
      context: {
        careerRoleId: set.career_role_id, version: Number(set.version), releaseLabel: input.releaseLabel, reasonCode: input.reasonCode,
        approvalId: input.approvalId, requestedByUserId: approval.requestedByUserId, approvedByUserId: approval.approvedByUserId,
        mode: approval.mode, ...actorContext(input.actor),
      },
    });
    await stateChanged(tx, { setId: input.setId, roleId: set.career_role_id, from: 'REVIEWED', to: 'PUBLISHED', actor: input.actor });
    await outbox(tx, {
      setId: input.setId, eventType: 'career_requirement_set.published',
      payload: { setId: input.setId, careerRoleId: set.career_role_id, releaseLabel: input.releaseLabel },
      actorUserId: input.actor.userId, correlationId: input.actor.correlationId,
    });
    return { approval, careerRoleId: set.career_role_id, version: Number(set.version) };
  });
}

/** A count of people on an operator screen goes through the one suppression rule (aggregate-suppression.ts). */
function liveTargetCountFor(count: number): { liveTargetCount: number | null; liveTargetCountSuppressed: boolean } {
  const shown = suppressSmallCount(count);
  return { liveTargetCount: shown.value, liveTargetCountSuppressed: shown.suppressed };
}
