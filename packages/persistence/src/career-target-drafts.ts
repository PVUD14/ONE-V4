/**
 * Agent-drafted career targets (ENG-11, migration 0056): validate a draft pack and import it as a
 * DRAFT requirement set for its catalogue role, with its new skills as pending topics.
 *
 * Why this exists: a career target written by the coding agent is model-produced content
 * (program Part B.8). It must enter through the same authoring path an operator uses
 * (createRequirementSetDraft, saveRequirementSetItems), carry AGENT_DRAFTED provenance, and reach
 * no student until a second person reviews it and a publish is approved. This module only ever
 * creates drafts; it never submits, reviews, approves or publishes.
 *
 * Design: docs/architecture/career-target-drafts-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { sha256Hex, stableStringify } from '@planthepath/career-readiness';
import {
  CareerCatalogueError,
  createRequirementSetDraft,
  saveRequirementSetItems,
  type CatalogueActor,
  type RequirementItemInput,
  type SqlRunner,
  type TransactionalRunner,
} from './career-catalogue.js';
import { validateAuditWriteInput } from './repositories.js';

type Level = RequirementItemInput['requirementLevel'];

export interface CareerTargetDraftSkill {
  readonly stableKey: string;
  readonly name: string;
  readonly description: string;
  readonly prerequisites: readonly string[];
  readonly basis: string;
  readonly expertCheck: string;
}

export interface CareerTargetDraftRequirement {
  /** A skill in this pack, or an existing live topic, by stable key. */
  readonly topic: string;
  readonly level: Level;
  readonly targetMastery: number;
  readonly rationale: string;
  readonly requiredEvidenceTypes: readonly string[];
  readonly basis: string;
  readonly expertCheck: string;
}

export interface CareerTargetDraftPack {
  readonly notice: string;
  readonly packKey: string;
  readonly roleCatalogueCode: string;
  readonly generatorVersion: string;
  readonly promptVersion: string;
  readonly generatedAt: string;
  readonly sourceBasis: string;
  readonly skills: readonly CareerTargetDraftSkill[];
  readonly requirements: readonly CareerTargetDraftRequirement[];
}

const LEVELS: readonly Level[] = ['ESSENTIAL', 'IMPORTANT', 'HELPFUL'];
const EVIDENCE_TYPES = ['LESSON_COMPLETION', 'ASSESSMENT_OUTCOME', 'TOPIC_DEMONSTRATION'];
const STABLE_KEY = /^[a-z0-9][a-z0-9-]{2,79}$/;
const CATALOGUE_CODE = /^[SDCELMPVB][0-9]{2}$/;

const text = (value: unknown, min: number, max: number): boolean => typeof value === 'string' && value.trim().length >= min && value.length <= max;

/**
 * Every reason a pack cannot be imported, as stable codes with the offending key. Empty means
 * valid. Pure: the database is not consulted, so a pack naming an existing live topic is checked
 * for that at import time.
 */
export function validateCareerTargetDraftPack(pack: CareerTargetDraftPack): readonly string[] {
  const problems: string[] = [];
  if (!text(pack.notice, 1, 4000) || !/\bDRAFT\b/.test(pack.notice)) problems.push('NOTICE_MUST_SAY_DRAFT');
  if (!STABLE_KEY.test(pack.packKey ?? '')) problems.push('PACK_KEY_INVALID');
  if (!CATALOGUE_CODE.test(pack.roleCatalogueCode ?? '')) problems.push('ROLE_CODE_INVALID');
  if (!text(pack.generatorVersion, 1, 128)) problems.push('GENERATOR_VERSION_MISSING');
  if (!text(pack.promptVersion, 1, 128)) problems.push('PROMPT_VERSION_MISSING');
  if (typeof pack.generatedAt !== 'string' || Number.isNaN(Date.parse(pack.generatedAt))) problems.push('GENERATED_AT_INVALID');
  if (!text(pack.sourceBasis, 1, 2000)) problems.push('SOURCE_BASIS_MISSING');

  const skills = new Map<string, CareerTargetDraftSkill>();
  for (const skill of pack.skills ?? []) {
    if (!STABLE_KEY.test(skill.stableKey ?? '')) { problems.push(`SKILL_KEY_INVALID:${skill.stableKey}`); continue; }
    if (skills.has(skill.stableKey)) problems.push(`SKILL_DUPLICATE:${skill.stableKey}`);
    skills.set(skill.stableKey, skill);
    if (!text(skill.name, 1, 160)) problems.push(`SKILL_NAME_INVALID:${skill.stableKey}`);
    if (!text(skill.description, 1, 1000)) problems.push(`SKILL_DESCRIPTION_INVALID:${skill.stableKey}`);
    if (!text(skill.basis, 1, 2000)) problems.push(`SKILL_BASIS_MISSING:${skill.stableKey}`);
    if (!text(skill.expertCheck, 1, 2000)) problems.push(`SKILL_EXPERT_CHECK_MISSING:${skill.stableKey}`);
  }
  for (const skill of skills.values()) {
    for (const prerequisite of skill.prerequisites ?? []) {
      if (!skills.has(prerequisite)) problems.push(`PREREQUISITE_UNKNOWN:${skill.stableKey}->${prerequisite}`);
      if (prerequisite === skill.stableKey) problems.push(`PREREQUISITE_SELF:${skill.stableKey}`);
    }
  }
  const cycle = findPrerequisiteCycle(skills);
  if (cycle) problems.push(`PREREQUISITE_CYCLE:${cycle}`);

  const required = new Set<string>();
  for (const item of pack.requirements ?? []) {
    const key = item.topic;
    if (!STABLE_KEY.test(key ?? '')) { problems.push(`REQUIREMENT_TOPIC_INVALID:${key}`); continue; }
    if (required.has(key)) problems.push(`REQUIREMENT_DUPLICATE:${key}`);
    required.add(key);
    if (!LEVELS.includes(item.level)) problems.push(`REQUIREMENT_LEVEL_INVALID:${key}`);
    // numeric(4,3) in (0, 1], as the 0051 CHECK and the operator API require.
    const target = item.targetMastery;
    if (typeof target !== 'number' || !(target > 0 && target <= 1) || Math.round(target * 1000) !== target * 1000) {
      problems.push(`REQUIREMENT_TARGET_INVALID:${key}`);
    }
    if (!text(item.rationale, 1, 500)) problems.push(`REQUIREMENT_RATIONALE_INVALID:${key}`);
    const types = item.requiredEvidenceTypes ?? [];
    if (!Array.isArray(types) || types.some((type) => !EVIDENCE_TYPES.includes(type)) || new Set(types).size !== types.length) {
      problems.push(`REQUIREMENT_EVIDENCE_INVALID:${key}`);
    }
    if (!text(item.basis, 1, 2000)) problems.push(`REQUIREMENT_BASIS_MISSING:${key}`);
    if (!text(item.expertCheck, 1, 2000)) problems.push(`REQUIREMENT_EXPERT_CHECK_MISSING:${key}`);
  }
  for (const key of skills.keys()) {
    if (!required.has(key)) problems.push(`SKILL_NOT_REQUIRED:${key}`);
  }
  if (!required.size) problems.push('NO_REQUIREMENTS');
  return problems;
}

function findPrerequisiteCycle(skills: ReadonlyMap<string, CareerTargetDraftSkill>): string | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string, path: readonly string[]): string | null => {
    if (state.get(key) === 'done') return null;
    if (state.get(key) === 'visiting') return [...path, key].join('>');
    state.set(key, 'visiting');
    for (const next of skills.get(key)?.prerequisites ?? []) {
      if (!skills.has(next)) continue;
      const found = visit(next, [...path, key]);
      if (found) return found;
    }
    state.set(key, 'done');
    return null;
  };
  for (const key of [...skills.keys()].sort()) {
    const found = visit(key, []);
    if (found) return found;
  }
  return null;
}

export class CareerTargetDraftError extends Error {
  constructor(readonly code: 'PACK_INVALID' | 'ROLE_NOT_IN_CATALOGUE' | 'TOPIC_NOT_AVAILABLE' | 'OPEN_SET_NOT_THIS_PACK', readonly detail: readonly string[] = []) {
    super(detail.length ? `${code}: ${detail.join(', ')}` : code);
    this.name = 'CareerTargetDraftError';
  }
}

export interface CareerTargetImportResult {
  readonly roleId: string;
  readonly setId: string;
  readonly version: number;
  /** False when this pack's draft was already there and nothing was written. */
  readonly createdSet: boolean;
  readonly skillsCreated: readonly string[];
  readonly skillsReused: readonly string[];
  readonly itemCount: number;
}

type Rows<T> = { rows: T[] };
async function rows<T>(runner: SqlRunner, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

/**
 * Import the pack in one transaction. Skills become pending TOPIC nodes (DRAFT revision,
 * inactive, AGENT_DRAFTED) unless one with the same stable key exists. The set is created through
 * createRequirementSetDraft with the pack's provenance and filled through saveRequirementSetItems.
 * Rerunning returns the existing draft of this pack; a different open set is never touched.
 */
export async function importCareerTargetDraftPack(
  db: TransactionalRunner,
  pack: CareerTargetDraftPack,
  actor: CatalogueActor,
): Promise<CareerTargetImportResult> {
  const problems = validateCareerTargetDraftPack(pack);
  if (problems.length) throw new CareerTargetDraftError('PACK_INVALID', problems);
  const generatedAt = new Date(pack.generatedAt).toISOString();

  return db.transaction(async (tx) => {
    const [role] = await rows<{ id: string }>(tx, sql`SELECT id FROM career_roles WHERE catalogue_code = ${pack.roleCatalogueCode}`);
    if (!role) throw new CareerTargetDraftError('ROLE_NOT_IN_CATALOGUE', [pack.roleCatalogueCode]);

    const skillsCreated: string[] = [];
    const skillsReused: string[] = [];
    const topicIdByKey = new Map<string, string>();
    for (const skill of pack.skills) {
      const [existing] = await rows<{ id: string }>(tx, sql`
        SELECT id FROM taxonomy_nodes WHERE kind = 'TOPIC' AND stable_key = ${skill.stableKey} ORDER BY version DESC LIMIT 1
      `);
      if (existing) {
        topicIdByKey.set(skill.stableKey, existing.id);
        skillsReused.push(skill.stableKey);
        continue;
      }
      const topicId = randomUUID();
      const revisionId = randomUUID();
      const body = {
        stableKey: skill.stableKey, name: skill.name, description: skill.description, prerequisites: skill.prerequisites,
        basis: skill.basis, expertCheck: skill.expertCheck, packKey: pack.packKey,
        provenance: { source: 'AGENT_DRAFTED', generatorVersion: pack.generatorVersion, promptVersion: pack.promptVersion, generatedAt },
      };
      await tx.execute(sql`
        INSERT INTO content_revisions (id, entity_type, entity_id, revision, author_user_id, state, content_hash, body)
        VALUES (${revisionId}::uuid, 'TOPIC', ${topicId}::uuid, 1, ${actor.userId}::uuid, 'DRAFT', ${sha256Hex(stableStringify(body))},
                ${JSON.stringify(body)}::jsonb)
      `);
      await tx.execute(sql`
        INSERT INTO taxonomy_nodes (id, kind, stable_key, version, name, description, content_revision_id, active,
                                    source, generator_version, prompt_version, generated_at)
        VALUES (${topicId}::uuid, 'TOPIC', ${skill.stableKey}, 1, ${skill.name}, ${skill.description}, ${revisionId}::uuid, false,
                'AGENT_DRAFTED', ${pack.generatorVersion}, ${pack.promptVersion}, ${generatedAt}::timestamptz)
      `);
      const auditId = randomUUID();
      validateAuditWriteInput({ id: auditId, actorUserId: actor.userId, action: 'engine.content.topic_drafted', resourceType: 'taxonomy_node', resourceId: topicId, correlationId: actor.correlationId });
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${auditId}::uuid, ${actor.userId}::uuid, 'engine.content.topic_drafted', 'taxonomy_node', ${topicId}, NULL, 'SUCCESS',
                ${actor.correlationId}, ${JSON.stringify({ stableKey: skill.stableKey, packKey: pack.packKey, source: 'AGENT_DRAFTED', reasonCode: 'ENGINE_DRAFT_IMPORT' })}::jsonb)
      `);
      topicIdByKey.set(skill.stableKey, topicId);
      skillsCreated.push(skill.stableKey);
    }

    // Requirements may also name topics that are already live (the starter set's).
    const unresolved = pack.requirements.map((item) => item.topic).filter((key) => !topicIdByKey.has(key));
    if (unresolved.length) {
      const live = await rows<{ id: string; stable_key: string }>(tx, sql`
        SELECT DISTINCT ON (stable_key) id, stable_key FROM taxonomy_nodes
        WHERE kind = 'TOPIC' AND active AND stable_key IN (${sql.join(unresolved.map((key) => sql`${key}`), sql`, `)})
        ORDER BY stable_key, version DESC
      `);
      for (const row of live) topicIdByKey.set(row.stable_key, row.id);
      const missing = unresolved.filter((key) => !topicIdByKey.has(key));
      if (missing.length) throw new CareerTargetDraftError('TOPIC_NOT_AVAILABLE', missing);
    }

    const [open] = await rows<{ id: string; version: number; source: string; prompt_version: string | null }>(tx, sql`
      SELECT id, version, source, prompt_version FROM career_requirement_sets
      WHERE career_role_id = ${role.id}::uuid AND state IN ('DRAFT','IN_REVIEW','REVIEWED')
    `);
    if (open) {
      if (open.source === 'AGENT_DRAFTED' && open.prompt_version === pack.promptVersion) {
        const [count] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM career_requirement_set_items WHERE set_id = ${open.id}::uuid`);
        return { roleId: role.id, setId: open.id, version: Number(open.version), createdSet: false, skillsCreated, skillsReused, itemCount: Number(count?.n ?? 0) };
      }
      throw new CareerTargetDraftError('OPEN_SET_NOT_THIS_PACK', [open.id]);
    }

    const created = await createRequirementSetDraft(tx as unknown as TransactionalRunner, {
      roleId: role.id, reasonCode: 'NEW_REQUIREMENT_SET', actor,
      provenance: { generatorVersion: pack.generatorVersion, promptVersion: pack.promptVersion, generatedAt, sourceBasis: pack.sourceBasis },
    });
    const items: RequirementItemInput[] = pack.requirements.map((item) => ({
      topicId: topicIdByKey.get(item.topic)!, requirementLevel: item.level, targetMastery: item.targetMastery,
      rationale: item.rationale, requiredEvidenceTypes: [...item.requiredEvidenceTypes],
    }));
    await saveRequirementSetItems(tx as unknown as TransactionalRunner, { setId: created.id, items, actor });
    return { roleId: role.id, setId: created.id, version: created.version, createdSet: true, skillsCreated, skillsReused, itemCount: items.length };
  });
}

export { CareerCatalogueError };
