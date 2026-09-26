/**
 * Skill map persistence (OPS-09a, migration 0057): skills as TOPIC nodes whose content is a
 * versioned content revision, taken from draft through review (with its rights review) to a
 * publish through a release manifest.
 *
 * Why this exists: ENG-11 left the SOC Analyst skills as pending topics and no operator path
 * published a topic. This is that path, built on the 0004 pipeline rather than beside it: the
 * rights review writes the source record a release manifest demands, the manifest publishes
 * the revision, and only then does the node point at it and go live (0056 and 0057 repeat
 * that order in triggers). Every write puts its audit row and outbox event in its own
 * transaction; the pure rules live in packages/career-readiness (content) and
 * packages/authorization (who, and when an approval is needed).
 *
 * Design: docs/architecture/skill-map-editor-design.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  composeSkillBody,
  readSkillDraftFields,
  sha256Hex,
  skillMapGraphProblems,
  SKILL_LICENCES_REQUIRING_ATTRIBUTION,
  stableStringify,
  validateSkillDraft,
  type SkillDraftFields,
} from '@planthepath/career-readiness';
import {
  skillOpenRevisionStates,
  skillPublishAltersReadinessInputs,
  type SkillMapRefusal,
  type SkillRevisionState,
} from '@planthepath/authorization/src/index.js';
import { consumeOperationApproval, type ConsumedApproval } from './operation-approvals.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

// The content rules, for callers (the API) that do not depend on packages/career-readiness directly.
export {
  SKILL_ATTRIBUTION_MAX,
  SKILL_BASIS_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_LEVEL_MAX,
  SKILL_LEVEL_MEANINGS,
  SKILL_LEVELS,
  SKILL_LICENCES,
  SKILL_LICENCES_REQUIRING_ATTRIBUTION,
  SKILL_NAME_MAX,
  SKILL_PREREQUISITES_MAX,
  SKILL_STABLE_KEY_PATTERN,
  type SkillDraftFields,
  type SkillLevel,
  type SkillLicence,
} from '@planthepath/career-readiness';

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

export type SkillMapErrorCode =
  | 'SKILL_NOT_FOUND'
  | 'SKILL_REVISION_NOT_FOUND'
  | 'SKILL_KEY_EXISTS'
  | 'SKILL_OPEN_REVISION_EXISTS'
  | 'SKILL_NOT_LIVE'
  | 'SKILL_RETIRED'
  | 'SKILL_REVISION_NOT_EDITABLE'
  | 'SKILL_REVISION_NOT_APPROVED'
  | 'SKILL_RIGHTS_NOT_REVIEWED'
  | 'SKILL_PREREQUISITE_NOT_LIVE'
  | 'SKILL_INVALID'
  | 'SKILL_MAP_REJECTED';

export class SkillMapError extends Error {
  /** For SKILL_INVALID: the validator's codes, safe to show (no text from the database). */
  constructor(readonly code: SkillMapErrorCode, readonly problems: readonly string[] = []) {
    super(problems.length ? `${code}: ${problems.join(', ')}` : code);
    this.name = 'SkillMapError';
  }
}

/** A refusal from a pure rule, carried out of the transaction as is. */
export class SkillMapRefused extends Error {
  constructor(readonly code: SkillMapRefusal | 'APPROVAL_REQUIRED') {
    super(code);
    this.name = 'SkillMapRefused';
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code
    ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505';
}

/** Who acted, and whether through the super admin's break-glass (§5.1: audited as such). */
export interface SkillActor {
  readonly userId: string;
  readonly breakGlass: boolean;
  readonly correlationId: string;
}

async function audit(runner: SqlRunner, input: {
  readonly actor: SkillActor; readonly action: string; readonly revisionId: string; readonly context: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: input.actor.userId, action: input.action, resourceType: 'content_revision', resourceId: input.revisionId, correlationId: input.actor.correlationId });
  const context = { ...input.context, ...(input.actor.breakGlass ? { break_glass: true } : {}) };
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${input.actor.userId}::uuid, ${input.action}, 'content_revision', ${input.revisionId}, NULL, 'SUCCESS',
            ${input.actor.correlationId}, ${JSON.stringify(context)}::jsonb)
  `);
}

async function outbox(runner: SqlRunner, input: {
  readonly actor: SkillActor; readonly revisionId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, aggregateType: 'content_revision', aggregateId: input.revisionId, eventType: input.eventType, payload: input.payload, actorUserId: input.actor.userId, correlationId: input.actor.correlationId, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, 'content_revision', ${input.revisionId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${input.actor.userId}::uuid, ${input.actor.correlationId})
  `);
}

async function stateChanged(tx: SqlRunner, actor: SkillActor, revisionId: string, topicId: string, from: SkillRevisionState, to: SkillRevisionState): Promise<void> {
  await outbox(tx, {
    actor, revisionId, eventType: 'skill_map.revision_state_changed',
    payload: { revisionId, topicId, fromState: from, toState: to },
  });
}

/** The audit action every draft save writes; it is also how contributors are known. */
export const skillDraftSavedAction = 'operations.content.skill_draft_saved';

const openStates = sql.join(skillOpenRevisionStates.map((state) => sql`${state}`), sql`, `);
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type SkillStatus = 'LIVE' | 'PENDING' | 'RETIRED';
export type SkillListFilter = SkillStatus | 'AWAITING_REVIEW' | 'CHANGES_REQUESTED' | 'AWAITING_PUBLISH';

export interface SkillSummaryRow {
  readonly topicId: string;
  readonly stableKey: string;
  readonly name: string;
  readonly status: SkillStatus;
  readonly source: 'AUTHORED' | 'AGENT_DRAFTED';
  readonly publishedRevision: number | null;
  readonly openRevision: { readonly id: string; readonly revision: number; readonly state: SkillRevisionState } | null;
  /** From the latest revision (the open one if any). */
  readonly prerequisites: readonly string[];
  readonly levelsComplete: boolean;
  readonly liveRequirementCount: number;
}

interface SkillDbRow {
  id: string; stable_key: string; name: string; description: string; active: boolean; source: 'AUTHORED' | 'AGENT_DRAFTED';
  pointer_state: SkillRevisionState; pointer_revision: number;
  open_id: string | null; open_revision: number | null; open_state: SkillRevisionState | null;
  latest_body: unknown; live_requirement_count: number; sort_key: string;
}

const skillSelect = sql`
  SELECT n.id, n.stable_key, n.name, n.description, n.active, n.source,
         p.state AS pointer_state, p.revision AS pointer_revision,
         o.id AS open_id, o.revision AS open_revision, o.state AS open_state,
         (SELECT c.body FROM content_revisions c WHERE c.entity_type = 'TOPIC' AND c.entity_id = n.id ORDER BY c.revision DESC LIMIT 1) AS latest_body,
         (SELECT count(*)::int FROM career_role_requirements q WHERE q.topic_id = n.id) AS live_requirement_count,
         (n.stable_key COLLATE "C") AS sort_key
  FROM taxonomy_nodes n
  JOIN content_revisions p ON p.id = n.content_revision_id
  LEFT JOIN LATERAL (
    SELECT c.id, c.revision, c.state FROM content_revisions c
    WHERE c.entity_type = 'TOPIC' AND c.entity_id = n.id AND c.state IN (${openStates})
    ORDER BY c.revision DESC LIMIT 1
  ) o ON true`;

function statusOf(row: { active: boolean; pointer_state: string }): SkillStatus {
  if (row.active) return 'LIVE';
  return (skillOpenRevisionStates as readonly string[]).includes(row.pointer_state) ? 'PENDING' : 'RETIRED';
}

function mapSkill(row: SkillDbRow): SkillSummaryRow {
  const fields = readSkillDraftFields(row.latest_body, { name: row.name, description: row.description });
  return {
    topicId: row.id,
    stableKey: row.stable_key,
    name: row.name,
    status: statusOf(row),
    source: row.source,
    publishedRevision: row.pointer_state === 'PUBLISHED' ? Number(row.pointer_revision) : null,
    openRevision: row.open_id ? { id: row.open_id, revision: Number(row.open_revision), state: row.open_state! } : null,
    prerequisites: fields.prerequisites,
    levelsComplete: Object.values(fields.levels).every((text) => text.length > 0),
    liveRequirementCount: Number(row.live_requirement_count),
  };
}

function likePattern(value: string): string {
  return `%${value.trim().toLowerCase().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function filterSql(filter: SkillListFilter | undefined): SQL {
  switch (filter) {
    case undefined: return sql`TRUE`;
    case 'LIVE': return sql`n.active`;
    case 'PENDING': return sql`NOT n.active AND p.state IN (${openStates})`;
    case 'RETIRED': return sql`NOT n.active AND p.state NOT IN (${openStates})`;
    case 'AWAITING_REVIEW': return sql`o.state = 'IN_REVIEW'`;
    case 'CHANGES_REQUESTED': return sql`o.state = 'CHANGES_REQUESTED'`;
    case 'AWAITING_PUBLISH': return sql`o.state = 'APPROVED'`;
  }
}

/** The skill map, searchable by name and key, keyset paginated on (stable key, id). */
export async function listSkills(runner: SqlRunner, input: {
  readonly q?: string; readonly filter?: SkillListFilter; readonly limit: number;
  readonly cursor?: { readonly key: string; readonly id: string };
}): Promise<{ readonly skills: readonly SkillSummaryRow[]; readonly nextCursor: { readonly key: string; readonly id: string } | null }> {
  const q = input.q ? likePattern(input.q) : null;
  const page = await rows<SkillDbRow>(runner, sql`
    ${skillSelect}
    WHERE n.kind = 'TOPIC'
      AND ${filterSql(input.filter)}
      AND (${q}::text IS NULL OR lower(n.name) LIKE ${q} OR lower(n.stable_key) LIKE ${q})
      AND (${input.cursor?.key ?? null}::text IS NULL
        OR ((n.stable_key COLLATE "C"), n.id) > ((${input.cursor?.key ?? null}::text COLLATE "C"), ${input.cursor?.id ?? null}::uuid))
    ORDER BY (n.stable_key COLLATE "C"), n.id
    LIMIT ${input.limit + 1}
  `);
  const shown = page.slice(0, input.limit);
  const last = shown[shown.length - 1];
  return { skills: shown.map(mapSkill), nextCursor: page.length > input.limit && last ? { key: last.sort_key, id: last.id } : null };
}

export interface SkillMapSummary {
  readonly live: number;
  readonly pending: number;
  readonly agentDraftedPending: number;
  readonly awaitingReview: number;
  readonly changesRequested: number;
  readonly awaitingPublish: number;
}

/** Counts for the header, in one bounded query (§5.7). */
export async function summariseSkillMap(runner: SqlRunner): Promise<SkillMapSummary> {
  const [row] = await rows<Record<string, number>>(runner, sql`
    SELECT
      count(*) FILTER (WHERE n.active)::int AS live,
      count(*) FILTER (WHERE NOT n.active AND p.state IN (${openStates}))::int AS pending,
      count(*) FILTER (WHERE NOT n.active AND p.state IN (${openStates}) AND n.source = 'AGENT_DRAFTED')::int AS agent_drafted_pending,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM content_revisions c WHERE c.entity_type = 'TOPIC' AND c.entity_id = n.id AND c.state = 'IN_REVIEW'))::int AS awaiting_review,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM content_revisions c WHERE c.entity_type = 'TOPIC' AND c.entity_id = n.id AND c.state = 'CHANGES_REQUESTED'))::int AS changes_requested,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM content_revisions c WHERE c.entity_type = 'TOPIC' AND c.entity_id = n.id AND c.state = 'APPROVED'))::int AS awaiting_publish
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id
    WHERE n.kind = 'TOPIC'
  `);
  const value = (key: string): number => Number(row?.[key] ?? 0);
  return {
    live: value('live'), pending: value('pending'), agentDraftedPending: value('agent_drafted_pending'),
    awaitingReview: value('awaiting_review'), changesRequested: value('changes_requested'), awaitingPublish: value('awaiting_publish'),
  };
}

export interface SkillRevisionView {
  readonly id: string;
  readonly revision: number;
  readonly state: SkillRevisionState;
  readonly contentHash: string;
  readonly author: { readonly userId: string; readonly email: string };
  readonly contributors: readonly { readonly userId: string; readonly email: string }[];
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly fields: SkillDraftFields;
  /** Keys the editor does not own, shown to the reviewer as they are (ENG-11's expert-check notes). */
  readonly expertCheck: string | null;
  readonly rightsReview: { readonly licenceLabel: string; readonly reviewerEmail: string; readonly reasonCode: string; readonly reviewedAt: string } | null;
}

export interface SkillDetail extends SkillSummaryRow {
  readonly description: string;
  readonly provenance: { readonly generatorVersion: string | null; readonly promptVersion: string | null; readonly generatedAt: string | null };
  /** The revision students and staff see now (the node's pointer); for a pending skill, its draft. */
  readonly current: SkillRevisionView;
  /** The revision on its way, when it is not `current` (a new revision of a live skill). */
  readonly open: SkillRevisionView | null;
  readonly prerequisiteSkills: readonly { readonly stableKey: string; readonly name: string | null; readonly status: SkillStatus | 'UNKNOWN' }[];
  readonly dependents: readonly { readonly stableKey: string; readonly name: string }[];
  readonly requiredBy: readonly { readonly roleTitle: string; readonly catalogueCode: string | null; readonly level: string }[];
  readonly openSetCount: number;
  /** Whether publishing the open revision would need an approval (§5.4, skillPublishAltersReadinessInputs). */
  readonly publishNeedsApproval: boolean;
  readonly history: readonly {
    readonly revision: number; readonly action: string; readonly fromState: string; readonly toState: string;
    readonly reasonCode: string; readonly actorEmail: string; readonly occurredAt: string;
  }[];
}

async function contributorsOf(runner: SqlRunner, revisionId: string, authorUserId: string): Promise<readonly string[]> {
  const saved = await rows<{ actor_user_id: string }>(runner, sql`
    SELECT DISTINCT actor_user_id FROM audit_events
    WHERE action = ${skillDraftSavedAction} AND resource_type = 'content_revision' AND resource_id = ${revisionId} AND actor_user_id IS NOT NULL
  `);
  return [...new Set([authorUserId, ...saved.map((row) => row.actor_user_id)])];
}

async function revisionView(runner: SqlRunner, revisionId: string, fallback: { readonly name: string; readonly description: string }): Promise<SkillRevisionView> {
  const [row] = await rows<{
    id: string; revision: number; state: SkillRevisionState; content_hash: string; author_user_id: string; author_email: string;
    created_at: Date; published_at: Date | null; body: unknown;
  }>(runner, sql`
    SELECT c.id, c.revision, c.state, c.content_hash, c.author_user_id, u.email AS author_email, c.created_at, c.published_at, c.body
    FROM content_revisions c JOIN users u ON u.id = c.author_user_id WHERE c.id = ${revisionId}::uuid
  `);
  if (!row) throw new SkillMapError('SKILL_REVISION_NOT_FOUND');
  const contributorIds = await contributorsOf(runner, row.id, row.author_user_id);
  const emails = await rows<{ id: string; email: string }>(runner, sql`
    SELECT id, email FROM users WHERE id IN (${sql.join(contributorIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const [rights] = await rows<{ license_label: string; reviewer_email: string; reason_code: string; reviewed_at: Date }>(runner, sql`
    SELECT r.license_label, u.email AS reviewer_email, r.reason_code, r.reviewed_at
    FROM source_records s JOIN rights_reviews r ON r.source_record_id = s.id JOIN users u ON u.id = r.reviewer_user_id
    WHERE s.source_entity_type = 'SKILL_MAP_REVISION' AND s.source_record_id = ${row.id}
    ORDER BY r.reviewed_at DESC LIMIT 1
  `);
  const body = (row.body && typeof row.body === 'object' ? row.body : {}) as Record<string, unknown>;
  return {
    id: row.id, revision: Number(row.revision), state: row.state, contentHash: row.content_hash,
    author: { userId: row.author_user_id, email: row.author_email },
    contributors: contributorIds.map((id) => ({ userId: id, email: emails.find((entry) => entry.id === id)?.email ?? 'NA' })),
    createdAt: iso(row.created_at)!, publishedAt: iso(row.published_at),
    fields: readSkillDraftFields(row.body, fallback),
    expertCheck: typeof body.expertCheck === 'string' ? body.expertCheck : null,
    rightsReview: rights ? { licenceLabel: rights.license_label, reviewerEmail: rights.reviewer_email, reasonCode: rights.reason_code, reviewedAt: iso(rights.reviewed_at)! } : null,
  };
}

/**
 * Every live or pending skill with the prerequisites of the version being checked against:
 * `latest` (each skill's newest revision, its open draft if any) while drafting, `published`
 * (live skills only, their published body) at publish.
 */
async function skillGraph(runner: SqlRunner, mode: 'latest' | 'published'): Promise<{
  readonly graph: Map<string, readonly string[]>; readonly status: Map<string, SkillStatus>; readonly names: Map<string, string>;
}> {
  const found = await rows<{ stable_key: string; name: string; description: string; active: boolean; pointer_state: string; body: unknown }>(runner, sql`
    SELECT DISTINCT ON (n.stable_key) n.stable_key, n.name, n.description, n.active, p.state AS pointer_state,
      ${mode === 'published' ? sql`p.body` : sql`(SELECT c.body FROM content_revisions c WHERE c.entity_type = 'TOPIC' AND c.entity_id = n.id ORDER BY c.revision DESC LIMIT 1)`} AS body
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id
    WHERE n.kind = 'TOPIC'
    ORDER BY n.stable_key, n.version DESC
  `);
  const graph = new Map<string, readonly string[]>();
  const status = new Map<string, SkillStatus>();
  const names = new Map<string, string>();
  for (const row of found) {
    const state = statusOf(row);
    status.set(row.stable_key, state);
    names.set(row.stable_key, row.name);
    if (state === 'RETIRED') continue;
    if (mode === 'published' && state !== 'LIVE') continue;
    graph.set(row.stable_key, readSkillDraftFields(row.body, row).prerequisites);
  }
  return { graph, status, names };
}

export async function loadSkill(runner: SqlRunner, topicId: string): Promise<SkillDetail | null> {
  const [row] = await rows<SkillDbRow & { content_revision_id: string; generator_version: string | null; prompt_version: string | null; generated_at: Date | null }>(runner, sql`
    SELECT s.*, n.content_revision_id, n.generator_version, n.prompt_version, n.generated_at
    FROM (${skillSelect} WHERE n.kind = 'TOPIC' AND n.id = ${topicId}::uuid) s JOIN taxonomy_nodes n ON n.id = s.id
  `);
  if (!row) return null;
  const summary = mapSkill(row);
  const fallback = { name: row.name, description: row.description };
  const current = await revisionView(runner, row.content_revision_id, fallback);
  const open = row.open_id && row.open_id !== row.content_revision_id ? await revisionView(runner, row.open_id, fallback) : null;
  const { graph, status, names } = await skillGraph(runner, 'latest');
  const prerequisites = (open ?? current).fields.prerequisites;
  const requiredBy = await rows<{ title: string; catalogue_code: string | null; requirement_level: string }>(runner, sql`
    SELECT r.title, r.catalogue_code, q.requirement_level FROM career_role_requirements q JOIN career_roles r ON r.id = q.career_role_id
    WHERE q.topic_id = ${topicId}::uuid ORDER BY r.catalogue_code NULLS LAST, r.title LIMIT 50
  `);
  const [sets] = await rows<{ n: number }>(runner, sql`
    SELECT count(DISTINCT s.id)::int AS n FROM career_requirement_set_items i JOIN career_requirement_sets s ON s.id = i.set_id
    WHERE i.topic_id = ${topicId}::uuid AND s.state IN ('DRAFT','IN_REVIEW','REVIEWED')
  `);
  const history = await rows<{ revision: number; action: string; from_state: string; to_state: string; reason_code: string; email: string; occurred_at: Date }>(runner, sql`
    SELECT c.revision, a.action, a.from_state, a.to_state, a.reason_code, u.email, a.occurred_at
    FROM content_review_actions a JOIN content_revisions c ON c.id = a.content_revision_id JOIN users u ON u.id = a.actor_user_id
    WHERE c.entity_type = 'TOPIC' AND c.entity_id = ${topicId}::uuid
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT 50
  `);
  return {
    ...summary,
    description: row.description,
    provenance: { generatorVersion: row.generator_version, promptVersion: row.prompt_version, generatedAt: iso(row.generated_at) },
    current,
    open,
    prerequisiteSkills: prerequisites.map((key) => ({ stableKey: key, name: names.get(key) ?? null, status: status.get(key) ?? 'UNKNOWN' })),
    dependents: [...graph.entries()].filter(([key, requires]) => key !== row.stable_key && requires.includes(row.stable_key))
      .map(([key]) => ({ stableKey: key, name: names.get(key) ?? key })),
    requiredBy: requiredBy.map((entry) => ({ roleTitle: entry.title, catalogueCode: entry.catalogue_code, level: entry.requirement_level })),
    openSetCount: Number(sets?.n ?? 0),
    publishNeedsApproval: skillPublishAltersReadinessInputs({ firstPublish: !row.active, liveRequirementCount: Number(row.live_requirement_count) }),
    history: history.map((entry) => ({
      revision: Number(entry.revision), action: entry.action, fromState: entry.from_state, toState: entry.to_state,
      reasonCode: entry.reason_code, actorEmail: entry.email, occurredAt: iso(entry.occurred_at)!,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function contentHashOf(body: Record<string, unknown>): string {
  return sha256Hex(stableStringify(body));
}

function rethrow(error: unknown): never {
  if (error instanceof SkillMapError || error instanceof SkillMapRefused) throw error;
  // Approval refusals keep their own type for the HTTP gate.
  if (error instanceof Error && error.name === 'OperationApprovalError') throw error;
  if (isUniqueViolation(error)) throw new SkillMapError('SKILL_KEY_EXISTS');
  throw new SkillMapError('SKILL_MAP_REJECTED');
}

/** Create a skill: a pending TOPIC (inactive, AUTHORED) with revision 1 in DRAFT. */
export async function createSkill(db: TransactionalRunner, input: {
  readonly stableKey: string; readonly name: string; readonly description: string; readonly reasonCode: string; readonly actor: SkillActor;
}): Promise<{ readonly topicId: string; readonly revisionId: string }> {
  const fields: SkillDraftFields = {
    name: input.name, description: input.description, levels: { AWARE: '', GUIDED: '', INDEPENDENT: '', TROUBLESHOOT: '' },
    prerequisites: [], licenceLabel: null, attribution: null, basis: null,
  };
  const problems = validateSkillDraft(input.stableKey, fields, false);
  if (problems.length) throw new SkillMapError('SKILL_INVALID', problems);
  const topicId = randomUUID();
  const revisionId = randomUUID();
  try {
    await db.transaction(async (tx) => {
      // Serialise creations of one key; the unique (kind, stable_key, version) index backs it.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'skill-map:' + input.stableKey}))`);
      const existing = await rows<{ id: string }>(tx, sql`SELECT id FROM taxonomy_nodes WHERE kind = 'TOPIC' AND stable_key = ${input.stableKey} LIMIT 1`);
      if (existing[0]) throw new SkillMapError('SKILL_KEY_EXISTS');
      const body = composeSkillBody({}, input.stableKey, fields);
      await tx.execute(sql`
        INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
        VALUES (${revisionId}::uuid, 'TOPIC', ${topicId}::uuid, 1, ${input.actor.userId}::uuid, 'DRAFT', ${contentHashOf(body)}, ${JSON.stringify(body)}::jsonb)
      `);
      await tx.execute(sql`
        INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id, active)
        VALUES (${topicId}::uuid, 'TOPIC', ${input.stableKey}, 1, ${input.name}, ${input.description}, ${revisionId}::uuid, false)
      `);
      await audit(tx, {
        actor: input.actor, action: 'operations.content.skill_created', revisionId,
        context: { topicId, stableKey: input.stableKey, revision: 1, reasonCode: input.reasonCode },
      });
    });
  } catch (error) {
    rethrow(error);
  }
  return { topicId, revisionId };
}

async function lockNode(tx: SqlRunner, topicId: string): Promise<{ id: string; stable_key: string; name: string; description: string; active: boolean; content_revision_id: string; pointer_state: string }> {
  const [node] = await rows<{ id: string; stable_key: string; name: string; description: string; active: boolean; content_revision_id: string; pointer_state: string }>(tx, sql`
    SELECT n.id, n.stable_key, n.name, n.description, n.active, n.content_revision_id, p.state AS pointer_state
    FROM taxonomy_nodes n JOIN content_revisions p ON p.id = n.content_revision_id
    WHERE n.id = ${topicId}::uuid AND n.kind = 'TOPIC' FOR UPDATE OF n
  `);
  if (!node) throw new SkillMapError('SKILL_NOT_FOUND');
  return node;
}

/** Start revision n+1 of a live skill from its published body. One open revision per skill. */
export async function startSkillRevision(db: TransactionalRunner, input: {
  readonly topicId: string; readonly reasonCode: string; readonly actor: SkillActor;
}): Promise<{ readonly revisionId: string; readonly revision: number }> {
  try {
    return await db.transaction(async (tx) => {
      const node = await lockNode(tx, input.topicId);
      const open = await rows<{ id: string }>(tx, sql`
        SELECT id FROM content_revisions WHERE entity_type = 'TOPIC' AND entity_id = ${input.topicId}::uuid AND state IN (${openStates}) LIMIT 1
      `);
      if (open[0]) throw new SkillMapError('SKILL_OPEN_REVISION_EXISTS');
      if (!node.active) throw new SkillMapError(node.pointer_state === 'PUBLISHED' || node.pointer_state === 'ARCHIVED' ? 'SKILL_RETIRED' : 'SKILL_NOT_LIVE');
      const [published] = await rows<{ body: unknown }>(tx, sql`SELECT body FROM content_revisions WHERE id = ${node.content_revision_id}::uuid`);
      const [next] = await rows<{ revision: number }>(tx, sql`
        SELECT COALESCE(max(revision), 0)::int + 1 AS revision FROM content_revisions WHERE entity_type = 'TOPIC' AND entity_id = ${input.topicId}::uuid
      `);
      const revision = Number(next!.revision);
      const fields = readSkillDraftFields(published?.body, node);
      const body = composeSkillBody(published?.body, node.stable_key, fields);
      const revisionId = randomUUID();
      await tx.execute(sql`
        INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
        VALUES (${revisionId}::uuid, 'TOPIC', ${input.topicId}::uuid, ${revision}, ${input.actor.userId}::uuid, 'DRAFT', ${contentHashOf(body)}, ${JSON.stringify(body)}::jsonb)
      `);
      await audit(tx, {
        actor: input.actor, action: 'operations.content.skill_revision_started', revisionId,
        context: { topicId: input.topicId, stableKey: node.stable_key, revision, reasonCode: input.reasonCode },
      });
      return { revisionId, revision };
    });
  } catch (error) {
    rethrow(error);
  }
}

async function lockRevision(tx: SqlRunner, revisionId: string): Promise<{ id: string; entity_id: string; revision: number; author_user_id: string; state: SkillRevisionState; body: unknown; content_hash: string }> {
  const [found] = await rows<{ entity_id: string }>(tx, sql`
    SELECT entity_id FROM content_revisions WHERE id = ${revisionId}::uuid AND entity_type = 'TOPIC'
  `);
  if (!found) throw new SkillMapError('SKILL_REVISION_NOT_FOUND');
  // Node first, then revision: every writer of a skill takes the locks in this order.
  await lockNode(tx, found.entity_id);
  const [revision] = await rows<{ id: string; entity_id: string; revision: number; author_user_id: string; state: SkillRevisionState; body: unknown; content_hash: string }>(tx, sql`
    SELECT id, entity_id, revision, author_user_id, state, body, content_hash FROM content_revisions WHERE id = ${revisionId}::uuid FOR UPDATE
  `);
  return revision!;
}

async function draftGraphProblems(tx: SqlRunner, stableKey: string, prerequisites: readonly string[]): Promise<readonly string[]> {
  const { graph } = await skillGraph(tx, 'latest');
  graph.delete(stableKey);
  return skillMapGraphProblems(graph, stableKey, prerequisites);
}

/**
 * Replace an editable revision's fields. Anyone with CONTENT_EDIT may edit; whoever saves
 * becomes a contributor (their audit row is the record) and so never reviews or publishes it.
 */
export async function saveSkillDraft(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly fields: SkillDraftFields; readonly actor: SkillActor;
}): Promise<{ readonly topicId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      if (revision.state !== 'DRAFT' && revision.state !== 'CHANGES_REQUESTED') throw new SkillMapError('SKILL_REVISION_NOT_EDITABLE');
      const [node] = await rows<{ stable_key: string }>(tx, sql`SELECT stable_key FROM taxonomy_nodes WHERE id = ${revision.entity_id}::uuid`);
      const stableKey = node!.stable_key;
      const problems = [...validateSkillDraft(stableKey, input.fields, false), ...await draftGraphProblems(tx, stableKey, input.fields.prerequisites)];
      if (problems.length) throw new SkillMapError('SKILL_INVALID', problems);
      const body = composeSkillBody(revision.body, stableKey, input.fields);
      await tx.execute(sql`
        UPDATE content_revisions SET body = ${JSON.stringify(body)}::jsonb, content_hash = ${contentHashOf(body)} WHERE id = ${input.revisionId}::uuid
      `);
      await audit(tx, {
        actor: input.actor, action: skillDraftSavedAction, revisionId: input.revisionId,
        context: { topicId: revision.entity_id, stableKey, revision: Number(revision.revision), prerequisiteCount: input.fields.prerequisites.length, reasonCode: 'DRAFT_EDIT' },
      });
      return { topicId: revision.entity_id };
    });
  } catch (error) {
    rethrow(error);
  }
}

const reviewActionFor: Readonly<Record<string, 'SUBMIT' | 'REQUEST_CHANGES' | 'APPROVE'>> = {
  IN_REVIEW: 'SUBMIT', CHANGES_REQUESTED: 'REQUEST_CHANGES', APPROVED: 'APPROVE',
};

/**
 * Move a revision: submit (and resubmit), request changes, or approve. `refuse` is the pure
 * rule, evaluated against the locked row and its contributors. Approving is also the rights
 * review: it writes the source record a release manifest needs (Decision 5 of the design).
 */
export async function transitionSkillRevision(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly toState: 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED'; readonly reasonCode: string;
  readonly rightsReasonCode: string | null; readonly note: string | null; readonly actor: SkillActor;
  readonly refuse: (current: { readonly from: SkillRevisionState; readonly contributorUserIds: readonly string[] }) => SkillMapRefusal | null;
}): Promise<{ readonly topicId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      const contributors = await contributorsOf(tx, revision.id, revision.author_user_id);
      const refusal = input.refuse({ from: revision.state, contributorUserIds: contributors });
      if (refusal) throw new SkillMapRefused(refusal);
      const [node] = await rows<{ stable_key: string; name: string; description: string }>(tx, sql`SELECT stable_key, name, description FROM taxonomy_nodes WHERE id = ${revision.entity_id}::uuid`);
      const stableKey = node!.stable_key;
      const fields = readSkillDraftFields(revision.body, node!);
      if (input.toState === 'IN_REVIEW') {
        const problems = [...validateSkillDraft(stableKey, fields, true), ...await draftGraphProblems(tx, stableKey, fields.prerequisites)];
        if (problems.length) throw new SkillMapError('SKILL_INVALID', problems);
      }
      await tx.execute(sql`
        INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
        VALUES (${randomUUID()}::uuid, ${revision.id}::uuid, ${input.actor.userId}::uuid, ${reviewActionFor[input.toState]!},
                ${revision.state}, ${input.toState}, ${input.reasonCode}, ${input.actor.correlationId})
      `);
      await tx.execute(sql`UPDATE content_revisions SET state = ${input.toState} WHERE id = ${revision.id}::uuid`);
      if (input.toState === 'APPROVED') {
        await recordRightsReview(tx, {
          revision, stableKey, fields, reviewReasonCode: input.reasonCode, rightsReasonCode: input.rightsReasonCode!, actor: input.actor,
        });
      }
      await audit(tx, {
        actor: input.actor, action: 'operations.content.skill_transitioned', revisionId: revision.id,
        context: {
          topicId: revision.entity_id, stableKey, revision: Number(revision.revision), fromState: revision.state, toState: input.toState,
          reasonCode: input.reasonCode, ...(input.rightsReasonCode ? { rightsReasonCode: input.rightsReasonCode } : {}), ...(input.note ? { note: input.note } : {}),
        },
      });
      await stateChanged(tx, input.actor, revision.id, revision.entity_id, revision.state, input.toState);
      return { topicId: revision.entity_id };
    });
  } catch (error) {
    rethrow(error);
  }
}

/**
 * The reviewer's rights review, in the approval's transaction: one source package per reviewed
 * revision and a release-eligible source record in its final state (source records are
 * immutable), with the rights review, the SME review and the provenance link that point at it.
 */
async function recordRightsReview(tx: SqlRunner, input: {
  readonly revision: { id: string; entity_id: string; revision: number; content_hash: string; body: unknown };
  readonly stableKey: string; readonly fields: SkillDraftFields; readonly reviewReasonCode: string; readonly rightsReasonCode: string; readonly actor: SkillActor;
}): Promise<void> {
  const licence = input.fields.licenceLabel;
  if (!licence) throw new SkillMapError('SKILL_INVALID', ['SKILL_LICENCE_MISSING']);
  const attributionRequired = SKILL_LICENCES_REQUIRING_ATTRIBUTION.includes(licence);
  const identity = `ops-skill-map:${input.revision.id}`;
  // Console-authored content has no repository commit; the SHA-1 of the reviewed body is its content address.
  const contentAddress = createHash('sha1').update(stableStringify(input.revision.body), 'utf8').digest('hex');
  const path = `console://skill-map/${input.stableKey}/r${Number(input.revision.revision)}`;
  const runId = randomUUID();
  const packageId = randomUUID();
  const sourceRecordId = randomUUID();
  await tx.execute(sql`
    INSERT INTO migration_runs (id, package_identity, source_repository, source_commit, manifest_hash, transform_version, status, started_by_user_id, record_counts, completed_at)
    VALUES (${runId}::uuid, ${identity}, 'one-operations-console', ${contentAddress}, ${input.revision.content_hash}, 'skill-map-editor-v1', 'STAGED',
            ${input.actor.userId}::uuid, ${JSON.stringify({ skills: 1 })}::jsonb, now())
  `);
  await tx.execute(sql`
    INSERT INTO source_packages (id, migration_run_id, deterministic_key, source_repository, source_commit, package_hash, transform_version, source_paths, checksums, manifest)
    VALUES (${packageId}::uuid, ${runId}::uuid, ${identity}, 'one-operations-console', ${contentAddress}, ${input.revision.content_hash}, 'skill-map-editor-v1',
            ${JSON.stringify([path])}::jsonb, ${JSON.stringify({ [path]: input.revision.content_hash })}::jsonb,
            ${JSON.stringify({ kind: 'SKILL_MAP_REVISION', stableKey: input.stableKey, revision: Number(input.revision.revision) })}::jsonb)
  `);
  await tx.execute(sql`
    INSERT INTO source_records (id, package_id, source_entity_type, source_record_id, source_path, source_hash, source_metadata, license_label,
      attribution_required, rights_state, sme_state, quality_state, mapping_state, duplicate_state, release_state, rejection_reason_codes, release_eligible)
    VALUES (${sourceRecordId}::uuid, ${packageId}::uuid, 'SKILL_MAP_REVISION', ${input.revision.id}, ${path}, ${input.revision.content_hash},
            ${JSON.stringify({ attribution: input.fields.attribution })}::jsonb, ${licence}, ${attributionRequired},
            'APPROVED', 'APPROVED', 'APPROVED', 'MAPPED', 'UNIQUE', 'ELIGIBLE', '{}'::text[], true)
  `);
  await tx.execute(sql`
    INSERT INTO rights_reviews (id, source_record_id, reviewer_user_id, state, license_label, attribution_requirement, reason_code)
    VALUES (${randomUUID()}::uuid, ${sourceRecordId}::uuid, ${input.actor.userId}::uuid, 'APPROVED', ${licence}, ${input.fields.attribution}, ${input.rightsReasonCode})
  `);
  await tx.execute(sql`
    INSERT INTO quality_reviews (id, source_record_id, reviewer_user_id, review_kind, state, reason_code)
    VALUES (${randomUUID()}::uuid, ${sourceRecordId}::uuid, ${input.actor.userId}::uuid, 'SME', 'APPROVED', ${input.reviewReasonCode})
  `);
  await tx.execute(sql`
    INSERT INTO content_provenance (id, source_record_id, canonical_entity_type, canonical_entity_id, canonical_version, provenance_hash, transform_version)
    VALUES (${randomUUID()}::uuid, ${sourceRecordId}::uuid, 'TOPIC', ${input.revision.entity_id}::uuid, ${Number(input.revision.revision)},
            ${input.revision.content_hash}, 'skill-map-editor-v1')
  `);
  await audit(tx, {
    actor: input.actor, action: 'operations.content.skill_rights_reviewed', revisionId: input.revision.id,
    context: { topicId: input.revision.entity_id, stableKey: input.stableKey, licenceLabel: licence, attributionRequired, reasonCode: input.rightsReasonCode },
  });
}

/** What the approvals endpoint needs to file, and the publish endpoint to execute, a publish approval. */
export async function loadSkillRevisionForPublish(runner: SqlRunner, revisionId: string): Promise<{
  readonly id: string; readonly topicId: string; readonly state: SkillRevisionState; readonly contentHash: string;
  readonly contributorUserIds: readonly string[]; readonly needsApproval: boolean;
} | null> {
  const [row] = await rows<{ id: string; entity_id: string; state: SkillRevisionState; content_hash: string; author_user_id: string; active: boolean; live_requirement_count: number }>(runner, sql`
    SELECT c.id, c.entity_id, c.state, c.content_hash, c.author_user_id, n.active,
           (SELECT count(*)::int FROM career_role_requirements q WHERE q.topic_id = n.id) AS live_requirement_count
    FROM content_revisions c JOIN taxonomy_nodes n ON n.id = c.entity_id AND n.kind = 'TOPIC'
    WHERE c.id = ${revisionId}::uuid AND c.entity_type = 'TOPIC'
  `);
  if (!row) return null;
  return {
    id: row.id, topicId: row.entity_id, state: row.state, contentHash: row.content_hash,
    contributorUserIds: await contributorsOf(runner, row.id, row.author_user_id),
    needsApproval: skillPublishAltersReadinessInputs({ firstPublish: !row.active, liveRequirementCount: Number(row.live_requirement_count) }),
  };
}

/**
 * Publish an approved revision, in one transaction: check who publishes, that every
 * prerequisite is live and the live map stays acyclic, and whether an approval is needed (and
 * consume it); then a release manifest approved by the revision's reviewer and published by the
 * actor, the revision PUBLISHED, and the node pointing at it and live. If anything fails, all of
 * it rolls back and any approval stays usable.
 */
export async function publishSkillRevision(db: TransactionalRunner, input: {
  readonly revisionId: string; readonly reasonCode: string; readonly approvalId: string | null;
  /** The approval payload the endpoint rebuilds from this request and the stored content hash. */
  readonly approvalPayload: (contentHash: string) => Record<string, unknown>;
  readonly actor: SkillActor;
  readonly refuse: (current: { readonly contributorUserIds: readonly string[] }) => SkillMapRefusal | null;
}): Promise<{ readonly topicId: string; readonly releaseManifestId: string; readonly approval: ConsumedApproval | null }> {
  try {
    return await db.transaction(async (tx) => {
      const revision = await lockRevision(tx, input.revisionId);
      const contributors = await contributorsOf(tx, revision.id, revision.author_user_id);
      const refusal = input.refuse({ contributorUserIds: contributors });
      if (refusal) throw new SkillMapRefused(refusal);
      if (revision.state !== 'APPROVED') throw new SkillMapError('SKILL_REVISION_NOT_APPROVED');
      const [node] = await rows<{ stable_key: string; name: string; description: string; active: boolean; content_revision_id: string }>(tx, sql`
        SELECT stable_key, name, description, active, content_revision_id FROM taxonomy_nodes WHERE id = ${revision.entity_id}::uuid
      `);
      const stableKey = node!.stable_key;
      const fields = readSkillDraftFields(revision.body, node!);

      // Checked before any approval is consumed, so a refused publish leaves it usable.
      const live = await skillGraph(tx, 'published');
      const notLive = fields.prerequisites.filter((key) => live.status.get(key) !== 'LIVE');
      if (notLive.length) throw new SkillMapError('SKILL_PREREQUISITE_NOT_LIVE', notLive.map((key) => `SKILL_PREREQUISITE_NOT_LIVE:${key}`));
      live.graph.delete(stableKey);
      const graphProblems = skillMapGraphProblems(live.graph, stableKey, fields.prerequisites);
      if (graphProblems.length) throw new SkillMapError('SKILL_INVALID', graphProblems);

      const [source] = await rows<{ id: string }>(tx, sql`
        SELECT id FROM source_records
        WHERE source_entity_type = 'SKILL_MAP_REVISION' AND source_record_id = ${revision.id} AND release_eligible AND source_hash = ${revision.content_hash}
        LIMIT 1
      `);
      if (!source) throw new SkillMapError('SKILL_RIGHTS_NOT_REVIEWED');
      const [approvedBy] = await rows<{ actor_user_id: string }>(tx, sql`
        SELECT actor_user_id FROM content_review_actions WHERE content_revision_id = ${revision.id}::uuid AND action = 'APPROVE'
        ORDER BY occurred_at DESC, id DESC LIMIT 1
      `);
      if (!approvedBy) throw new SkillMapError('SKILL_REVISION_NOT_APPROVED');

      const [requirements] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM career_role_requirements WHERE topic_id = ${revision.entity_id}::uuid`);
      const needsApproval = skillPublishAltersReadinessInputs({ firstPublish: !node!.active, liveRequirementCount: Number(requirements?.n ?? 0) });
      if (needsApproval && !input.approvalId) throw new SkillMapRefused('APPROVAL_REQUIRED');
      const approval = input.approvalId
        ? await consumeOperationApproval(tx, {
          approvalId: input.approvalId, actionKey: 'CONTENT_SKILL_PUBLISH', payload: input.approvalPayload(revision.content_hash),
          executorUserId: input.actor.userId, correlationId: input.actor.correlationId,
        })
        : null;

      const manifestId = randomUUID();
      const releaseName = `Skill map: ${stableKey}`;
      const releaseVersion = Number(revision.revision);
      const manifestHash = sha256Hex(stableStringify({ name: releaseName, version: releaseVersion, items: [{ id: revision.id, hash: revision.content_hash }] }));
      await tx.execute(sql`
        INSERT INTO release_manifests (id, name, version, manifest_hash, status)
        VALUES (${manifestId}::uuid, ${releaseName}, ${releaseVersion}, ${manifestHash}, 'DRAFT')
      `);
      await tx.execute(sql`
        INSERT INTO release_manifest_items (manifest_id, content_revision_id, source_record_id, item_hash)
        VALUES (${manifestId}::uuid, ${revision.id}::uuid, ${source.id}::uuid, ${revision.content_hash})
      `);
      await tx.execute(sql`
        UPDATE release_manifests SET status = 'APPROVED', approved_by_user_id = ${approvedBy.actor_user_id}::uuid, approved_at = now()
        WHERE id = ${manifestId}::uuid
      `);
      await tx.execute(sql`
        UPDATE release_manifests SET status = 'PUBLISHED', published_by_user_id = ${input.actor.userId}::uuid, published_at = now()
        WHERE id = ${manifestId}::uuid
      `);
      await tx.execute(sql`
        UPDATE content_revisions SET state = 'PUBLISHED', release_manifest_id = ${manifestId}::uuid, published_at = now()
        WHERE id = ${revision.id}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO content_review_actions (id, content_revision_id, actor_user_id, action, from_state, to_state, reason_code, correlation_id)
        VALUES (${randomUUID()}::uuid, ${revision.id}::uuid, ${input.actor.userId}::uuid, 'PUBLISH', 'APPROVED', 'PUBLISHED', ${input.reasonCode}, ${input.actor.correlationId})
      `);
      // The revision is PUBLISHED before the node points at it and goes live (0056, 0057 guards).
      await tx.execute(sql`
        UPDATE taxonomy_nodes SET name = ${fields.name}, description = ${fields.description}, content_revision_id = ${revision.id}::uuid, active = true
        WHERE id = ${revision.entity_id}::uuid
      `);
      await audit(tx, {
        actor: input.actor, action: 'operations.content.skill_published', revisionId: revision.id,
        context: {
          topicId: revision.entity_id, stableKey, revision: releaseVersion, reasonCode: input.reasonCode, releaseManifestId: manifestId,
          firstPublish: !node!.active, approvalRequired: needsApproval,
          ...(approval ? { approvalId: approval.approvalId, requestedByUserId: approval.requestedByUserId, approvedByUserId: approval.approvedByUserId, mode: approval.mode } : {}),
        },
      });
      await stateChanged(tx, input.actor, revision.id, revision.entity_id, 'APPROVED', 'PUBLISHED');
      await outbox(tx, {
        actor: input.actor, revisionId: revision.id, eventType: 'skill_map.skill_published',
        payload: { revisionId: revision.id, topicId: revision.entity_id, releaseManifestId: manifestId },
      });
      return { topicId: revision.entity_id, releaseManifestId: manifestId, approval };
    });
  } catch (error) {
    rethrow(error);
  }
}
