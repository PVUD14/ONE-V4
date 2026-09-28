/**
 * The aptitude skill map and draft item bank (ENG-10): the pack format, its validator and its
 * import through the skill map and question bank editors.
 *
 * Why this exists: the shared aptitude block is model-produced content (program B.8). It must
 * enter ONE through the path an operator uses — createSkill/saveSkillDraft (OPS-09a),
 * createMisconceptionCodeDraft (ENG-07), createQuestion/saveQuestionDraft (OPS-09b) — as DRAFT
 * with AGENT_DRAFTED provenance, so every rule those paths enforce (key patterns, the acyclic
 * prerequisite check, codes on the item's own skill) is enforced on it by the same code. The
 * validator is pure and adds what ENG-10 asks on top: an answer key and at least one
 * misconception-tagged distractor on every item, and complete tagging. This module never
 * submits, reviews, approves or publishes.
 *
 * Design: docs/architecture/aptitude-item-bank-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  ENGINE_CONTENT_CODE_PATTERN,
  QUESTION_DIFFICULTIES,
  SKILL_LEVELS,
  SKILL_LICENCES,
  SKILL_LICENCES_REQUIRING_ATTRIBUTION,
  skillMapGraphProblems,
  validateQuestionDraft,
  validateSkillDraft,
  type QuestionDifficulty,
  type QuestionDraftFields,
  type SkillDraftFields,
  type SkillLevel,
  type SkillLicence,
} from '@planthepath/career-readiness';
import { createMisconceptionCodeDraft } from './misconceptions.js';
import { createQuestion, saveQuestionDraft } from './question-bank.js';
import type { PersistenceDb } from './repositories.js';
import { validateAuditWriteInput } from './repositories.js';
import { createSkill, saveSkillDraft, type AgentDraftProvenance, type SkillActor, type SqlRunner, type TransactionalRunner } from './skill-map.js';

export const APTITUDE_AREAS = ['QUANTITATIVE', 'LOGICAL', 'VERBAL'] as const;
export type AptitudeArea = (typeof APTITUDE_AREAS)[number];

/** Fewest items a skill may have in the pack. */
export const APTITUDE_MIN_ITEMS_PER_SKILL = 8;

export interface AptitudeSource {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly reference: string;
  readonly usedFor: string;
}

export interface AptitudeSkill {
  readonly stableKey: string;
  readonly area: AptitudeArea;
  readonly name: string;
  readonly description: string;
  readonly levels: Readonly<Record<SkillLevel, string>>;
  readonly prerequisites: readonly string[];
  readonly basis: string;
  readonly expertCheck: string;
}

export interface AptitudeMisconception {
  readonly code: string;
  /** The skill (stable key) it belongs to; items tag it only on that skill. */
  readonly skill: string;
  readonly title: string;
  readonly description: string;
  readonly basis: string;
  readonly expertCheck: string;
}

export interface AptitudeOption {
  readonly id: string;
  readonly text: string;
  readonly misconception: { readonly code: string; readonly rationale: string } | null;
}

export interface AptitudeItem {
  readonly stableKey: string;
  readonly skill: string;
  readonly difficulty: QuestionDifficulty;
  readonly prompt: string;
  readonly options: readonly AptitudeOption[];
  readonly correctOptionId: string;
  readonly explanation: string;
  readonly hints: readonly [string, string, string, string];
  readonly basis: string;
  readonly expertCheck: string;
}

export interface AptitudeBankPack {
  readonly notice: string;
  readonly packKey: string;
  readonly generatorVersion: string;
  readonly promptVersion: string;
  readonly generatedAt: string;
  readonly sourceBasis: string;
  readonly sources: readonly AptitudeSource[];
  readonly rights: { readonly licenceLabel: SkillLicence; readonly attribution: string | null };
  readonly skills: readonly AptitudeSkill[];
  readonly misconceptions: readonly AptitudeMisconception[];
  readonly items: readonly AptitudeItem[];
}

const STABLE_KEY = /^[a-z0-9][a-z0-9-]{2,79}$/;
/** A syntactically valid stand-in, so the editors' shape validators can run without a database. */
const PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';

const text = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'string' && value.trim().length >= min && value.length <= max;

export function skillDraftFieldsOf(pack: AptitudeBankPack, skill: AptitudeSkill): SkillDraftFields {
  return {
    name: skill.name, description: skill.description, levels: { ...skill.levels }, prerequisites: [...skill.prerequisites],
    licenceLabel: pack.rights.licenceLabel, attribution: pack.rights.attribution, basis: skill.basis,
  };
}

/** The question-bank fields of an item, with each tag's code resolved by `codeId`. */
export function questionDraftFieldsOf(
  pack: AptitudeBankPack, item: AptitudeItem, topicId: string, codeId: (code: string) => string,
): QuestionDraftFields {
  return {
    topicId, prompt: item.prompt,
    options: item.options.map((option) => ({
      id: option.id, text: option.text,
      misconception: option.misconception ? { codeId: codeId(option.misconception.code), rationale: option.misconception.rationale } : null,
    })),
    correctOptionId: item.correctOptionId, explanation: item.explanation, difficulty: item.difficulty,
    hints: [...item.hints] as [string, string, string, string],
    licenceLabel: pack.rights.licenceLabel, attribution: pack.rights.attribution, basis: item.basis,
  };
}

/**
 * Every reason the pack cannot be imported, as stable codes with the offending key. Empty means
 * valid. Pure. Runs the editors' own validators for submission, so an imported draft needs no
 * edit before a person submits it, and adds ENG-10's tagging-completeness rules.
 */
export function validateAptitudeBankPack(pack: AptitudeBankPack): readonly string[] {
  const problems: string[] = [];
  if (!text(pack.notice, 1, 4000) || !/\bDRAFT\b/.test(pack.notice)) problems.push('NOTICE_MUST_SAY_DRAFT');
  if (!STABLE_KEY.test(pack.packKey ?? '')) problems.push('PACK_KEY_INVALID');
  if (!text(pack.generatorVersion, 1, 128)) problems.push('GENERATOR_VERSION_MISSING');
  if (!text(pack.promptVersion, 1, 128)) problems.push('PROMPT_VERSION_MISSING');
  if (typeof pack.generatedAt !== 'string' || Number.isNaN(Date.parse(pack.generatedAt))) problems.push('GENERATED_AT_INVALID');
  if (!text(pack.sourceBasis, 1, 4000)) problems.push('SOURCE_BASIS_MISSING');
  if (!(pack.sources ?? []).length) problems.push('SOURCES_MISSING');
  for (const source of pack.sources ?? []) {
    if (![source.id, source.title, source.publisher, source.reference, source.usedFor].every((value) => text(value, 1, 1000))) {
      problems.push(`SOURCE_INCOMPLETE:${source.id}`);
    }
  }
  const licence = pack.rights?.licenceLabel;
  if (!(SKILL_LICENCES as readonly string[]).includes(licence)) problems.push('LICENCE_INVALID');
  else if (SKILL_LICENCES_REQUIRING_ATTRIBUTION.includes(licence) && !pack.rights.attribution) problems.push('ATTRIBUTION_MISSING');

  // Skills: the skill map editor's rules for submission, plus area, basis and expert note.
  const skills = new Map<string, AptitudeSkill>();
  for (const skill of pack.skills ?? []) {
    if (skills.has(skill.stableKey)) problems.push(`SKILL_DUPLICATE:${skill.stableKey}`);
    skills.set(skill.stableKey, skill);
    if (!(APTITUDE_AREAS as readonly string[]).includes(skill.area)) problems.push(`SKILL_AREA_INVALID:${skill.stableKey}`);
    for (const problem of validateSkillDraft(skill.stableKey, skillDraftFieldsOf(pack, skill), true)) problems.push(`${problem}:${skill.stableKey}`);
    for (const level of SKILL_LEVELS) if (!text(skill.levels?.[level], 1, 500)) problems.push(`SKILL_LEVEL_MISSING:${level}:${skill.stableKey}`);
    if (!text(skill.basis, 1, 2000)) problems.push(`SKILL_BASIS_MISSING:${skill.stableKey}`);
    if (!text(skill.expertCheck, 1, 2000)) problems.push(`SKILL_EXPERT_CHECK_MISSING:${skill.stableKey}`);
  }
  // Prerequisites: known within the pack, and the map acyclic — the editor's own graph check.
  const graph = new Map<string, readonly string[]>([...skills.values()].map((skill) => [skill.stableKey, skill.prerequisites ?? []]));
  for (const skill of skills.values()) {
    const others = new Map(graph);
    others.delete(skill.stableKey);
    for (const problem of skillMapGraphProblems(others, skill.stableKey, skill.prerequisites ?? [])) problems.push(`${problem}:${skill.stableKey}`);
  }

  // Misconception codes: ENG-07's pattern, unique, on a skill in the pack.
  const codes = new Map<string, AptitudeMisconception>();
  for (const code of pack.misconceptions ?? []) {
    if (!ENGINE_CONTENT_CODE_PATTERN.test(code.code ?? '')) problems.push(`CODE_INVALID:${code.code}`);
    if (codes.has(code.code)) problems.push(`CODE_DUPLICATE:${code.code}`);
    codes.set(code.code, code);
    if (!skills.has(code.skill)) problems.push(`CODE_SKILL_UNKNOWN:${code.code}`);
    if (!text(code.title, 1, 160)) problems.push(`CODE_TITLE_INVALID:${code.code}`);
    if (!text(code.description, 1, 2000)) problems.push(`CODE_DESCRIPTION_INVALID:${code.code}`);
    if (!text(code.basis, 1, 4000)) problems.push(`CODE_BASIS_MISSING:${code.code}`);
    if (!text(code.expertCheck, 1, 4000)) problems.push(`CODE_EXPERT_CHECK_MISSING:${code.code}`);
  }

  // Items: the question bank editor's rules for submission, plus ENG-10's tagging rules.
  const itemKeys = new Set<string>();
  const usedCodes = new Set<string>();
  const perSkill = new Map<string, number>();
  for (const item of pack.items ?? []) {
    const key = item.stableKey;
    if (itemKeys.has(key)) problems.push(`ITEM_DUPLICATE:${key}`);
    itemKeys.add(key);
    if (!skills.has(item.skill)) { problems.push(`ITEM_SKILL_UNKNOWN:${key}`); continue; }
    perSkill.set(item.skill, (perSkill.get(item.skill) ?? 0) + 1);
    if (!key?.startsWith(`${item.skill}-`)) problems.push(`ITEM_KEY_NOT_UNDER_SKILL:${key}`);
    if (!(QUESTION_DIFFICULTIES as readonly string[]).includes(item.difficulty)) problems.push(`ITEM_DIFFICULTY_INVALID:${key}`);
    const fields = questionDraftFieldsOf(pack, item, PLACEHOLDER_UUID, () => PLACEHOLDER_UUID);
    for (const problem of validateQuestionDraft(key, fields, true)) problems.push(`${problem}:${key}`);
    if (!item.options.some((option) => option.id === item.correctOptionId)) problems.push(`ITEM_ANSWER_KEY_MISSING:${key}`);
    const texts = item.options.map((option) => option.text.trim().toLowerCase());
    if (new Set(texts).size !== texts.length) problems.push(`ITEM_OPTIONS_NOT_DISTINCT:${key}`);
    if (!Array.isArray(item.hints) || item.hints.length !== 4 || item.hints.some((hint) => !text(hint, 1, 1000))) problems.push(`ITEM_HINTS_INCOMPLETE:${key}`);
    let tagged = 0;
    for (const option of item.options) {
      if (!option.misconception) continue;
      if (option.id === item.correctOptionId) { problems.push(`ITEM_TAG_ON_CORRECT:${key}`); continue; }
      const code = codes.get(option.misconception.code);
      if (!code) { problems.push(`ITEM_TAG_CODE_UNKNOWN:${key}:${option.misconception.code}`); continue; }
      if (code.skill !== item.skill) { problems.push(`ITEM_TAG_CODE_OTHER_SKILL:${key}:${option.misconception.code}`); continue; }
      if (!text(option.misconception.rationale, 1, 2000)) { problems.push(`ITEM_TAG_RATIONALE_MISSING:${key}:${option.id}`); continue; }
      usedCodes.add(code.code);
      tagged += 1;
    }
    if (tagged < 1) problems.push(`ITEM_NO_TAGGED_DISTRACTOR:${key}`);
    if (!text(item.basis, 1, 2000)) problems.push(`ITEM_BASIS_MISSING:${key}`);
    if (!text(item.expertCheck, 1, 4000)) problems.push(`ITEM_EXPERT_CHECK_MISSING:${key}`);
  }
  for (const code of codes.values()) if (!usedCodes.has(code.code)) problems.push(`CODE_UNUSED:${code.code}`);
  for (const skill of skills.values()) {
    if ((perSkill.get(skill.stableKey) ?? 0) < APTITUDE_MIN_ITEMS_PER_SKILL) problems.push(`SKILL_TOO_FEW_ITEMS:${skill.stableKey}`);
  }
  for (const area of APTITUDE_AREAS) if (![...skills.values()].some((skill) => skill.area === area)) problems.push(`AREA_MISSING:${area}`);
  return [...new Set(problems)];
}

export interface AptitudeBankSummary {
  readonly skills: number;
  readonly misconceptions: number;
  readonly items: number;
  readonly byArea: Readonly<Record<AptitudeArea, { readonly skills: number; readonly items: number }>>;
  readonly bySkill: Readonly<Record<string, number>>;
  readonly byDifficulty: Readonly<Record<QuestionDifficulty, number>>;
  readonly distractors: number;
  readonly taggedDistractors: number;
  readonly itemsWithTaggedDistractor: number;
}

/** Counts for the validation report. Pure. */
export function summariseAptitudeBankPack(pack: AptitudeBankPack): AptitudeBankSummary {
  const areaOf = new Map(pack.skills.map((skill) => [skill.stableKey, skill.area]));
  const byArea = Object.fromEntries(APTITUDE_AREAS.map((area) => [area, {
    skills: pack.skills.filter((skill) => skill.area === area).length,
    items: pack.items.filter((item) => areaOf.get(item.skill) === area).length,
  }])) as Record<AptitudeArea, { skills: number; items: number }>;
  const bySkill: Record<string, number> = {};
  for (const skill of pack.skills) bySkill[skill.stableKey] = pack.items.filter((item) => item.skill === skill.stableKey).length;
  const byDifficulty = Object.fromEntries(QUESTION_DIFFICULTIES.map((band) => [band, pack.items.filter((item) => item.difficulty === band).length])) as Record<QuestionDifficulty, number>;
  const wrong = pack.items.flatMap((item) => item.options.filter((option) => option.id !== item.correctOptionId));
  return {
    skills: pack.skills.length, misconceptions: pack.misconceptions.length, items: pack.items.length, byArea, bySkill, byDifficulty,
    distractors: wrong.length, taggedDistractors: wrong.filter((option) => option.misconception).length,
    itemsWithTaggedDistractor: pack.items.filter((item) => item.options.some((option) => option.id !== item.correctOptionId && option.misconception)).length,
  };
}

export class AptitudeBankError extends Error {
  constructor(readonly code: 'PACK_INVALID' | 'CODE_ON_ANOTHER_SKILL', readonly detail: readonly string[] = []) {
    super(detail.length ? `${code}: ${detail.slice(0, 20).join(', ')}${detail.length > 20 ? ` (+${detail.length - 20} more)` : ''}` : code);
    this.name = 'AptitudeBankError';
  }
}

export interface AptitudeBankImportResult {
  readonly skillsCreated: readonly string[];
  readonly skillsReused: readonly string[];
  readonly codesCreated: readonly string[];
  readonly codesReused: readonly string[];
  readonly itemsCreated: number;
  readonly itemsSkipped: readonly string[];
}

type Rows<T> = { rows: T[] };
async function rows<T>(runner: SqlRunner, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await runner.execute(query)) as Rows<T>).rows;
}

/** Skills in prerequisite order (a DAG, checked by the validator), ties by key. */
function prerequisiteOrder(skills: readonly AptitudeSkill[]): readonly AptitudeSkill[] {
  const byKey = new Map(skills.map((skill) => [skill.stableKey, skill]));
  const done = new Set<string>();
  const ordered: AptitudeSkill[] = [];
  const visit = (key: string): void => {
    if (done.has(key)) return;
    done.add(key);
    for (const required of [...(byKey.get(key)?.prerequisites ?? [])].sort()) if (byKey.has(required)) visit(required);
    ordered.push(byKey.get(key)!);
  };
  for (const key of [...byKey.keys()].sort()) visit(key);
  return ordered;
}

/**
 * Import the pack in one transaction, through the editors. Skills first (created, then their
 * levels, prerequisites and rights saved in prerequisite order, so the editor's acyclic check
 * runs on each), then the misconception codes on their skills, then the items. A rerun reuses
 * what exists and creates nothing twice. Nothing leaves DRAFT.
 */
export async function importAptitudeBankPack(db: TransactionalRunner, pack: AptitudeBankPack, actor: SkillActor): Promise<AptitudeBankImportResult> {
  const problems = validateAptitudeBankPack(pack);
  if (problems.length) throw new AptitudeBankError('PACK_INVALID', problems);
  const generatedAt = new Date(pack.generatedAt).toISOString();
  const draftFor = (expertCheck: string, carried?: Record<string, string>): AgentDraftProvenance => ({
    generatorVersion: pack.generatorVersion, promptVersion: pack.promptVersion, generatedAt, packKey: pack.packKey, expertCheck,
    ...(carried ? { carried } : {}),
  });

  return db.transaction(async (tx) => {
    const runner = tx as unknown as TransactionalRunner;
    const skillsCreated: string[] = [];
    const skillsReused: string[] = [];
    const topicIdByKey = new Map<string, string>();
    const createdRevision = new Map<string, string>();
    for (const skill of pack.skills) {
      const [existing] = await rows<{ id: string }>(tx, sql`
        SELECT id FROM taxonomy_nodes WHERE kind = 'TOPIC' AND stable_key = ${skill.stableKey} ORDER BY version DESC LIMIT 1
      `);
      if (existing) {
        topicIdByKey.set(skill.stableKey, existing.id);
        skillsReused.push(skill.stableKey);
        continue;
      }
      const created = await createSkill(runner, {
        stableKey: skill.stableKey, name: skill.name, description: skill.description, reasonCode: 'TRACK_BUILD', actor,
        agentDraft: draftFor(skill.expertCheck, { area: skill.area }),
      });
      topicIdByKey.set(skill.stableKey, created.topicId);
      createdRevision.set(skill.stableKey, created.revisionId);
      skillsCreated.push(skill.stableKey);
    }
    for (const skill of prerequisiteOrder(pack.skills)) {
      const revisionId = createdRevision.get(skill.stableKey);
      if (revisionId) await saveSkillDraft(runner, { revisionId, fields: skillDraftFieldsOf(pack, skill), actor });
    }

    const codesCreated: string[] = [];
    const codesReused: string[] = [];
    const codeIdByCode = new Map<string, string>();
    for (const code of pack.misconceptions) {
      const skillId = topicIdByKey.get(code.skill)!;
      const [latest] = await rows<{ id: string; skill_id: string }>(tx, sql`
        SELECT id, skill_id FROM misconception_codes WHERE code = ${code.code} ORDER BY version DESC LIMIT 1
      `);
      if (latest) {
        if (latest.skill_id !== skillId) throw new AptitudeBankError('CODE_ON_ANOTHER_SKILL', [code.code]);
        codeIdByCode.set(code.code, latest.id);
        codesReused.push(code.code);
        continue;
      }
      const created = await createMisconceptionCodeDraft(tx as unknown as PersistenceDb, {
        code: code.code, skillId, title: code.title, description: code.description, basis: code.basis,
        expertCheckNotes: code.expertCheck, source: 'AGENT_DRAFTED', generatorVersion: pack.generatorVersion,
        promptVersion: pack.promptVersion, generatedAt: new Date(generatedAt), authorUserId: actor.userId,
      });
      const auditId = randomUUID();
      validateAuditWriteInput({ id: auditId, actorUserId: actor.userId, action: 'engine.content.misconception_drafted', resourceType: 'content_revision', resourceId: created.revisionId, correlationId: actor.correlationId });
      await tx.execute(sql`
        INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
        VALUES (${auditId}::uuid, ${actor.userId}::uuid, 'engine.content.misconception_drafted', 'content_revision', ${created.revisionId}, NULL, 'SUCCESS',
                ${actor.correlationId}, ${JSON.stringify({ code: code.code, skill: code.skill, packKey: pack.packKey, source: 'AGENT_DRAFTED', reasonCode: 'ENGINE_DRAFT_IMPORT' })}::jsonb)
      `);
      codeIdByCode.set(code.code, created.id);
      codesCreated.push(code.code);
    }

    let itemsCreated = 0;
    const itemsSkipped: string[] = [];
    for (const item of pack.items) {
      const [used] = await rows<{ used: boolean }>(tx, sql`
        SELECT EXISTS (SELECT 1 FROM content_revisions WHERE entity_type = 'QUESTION' AND body ->> 'stableKey' = ${item.stableKey})
            OR EXISTS (SELECT 1 FROM question_versions WHERE stable_key = ${item.stableKey}) AS used
      `);
      if (used?.used) { itemsSkipped.push(item.stableKey); continue; }
      const created = await createQuestion(runner, {
        stableKey: item.stableKey, topicKey: item.skill, prompt: item.prompt, reasonCode: 'TRACK_BUILD', actor,
        agentDraft: draftFor(item.expertCheck),
      });
      const { topicId: _topic, ...fields } = questionDraftFieldsOf(pack, item, topicIdByKey.get(item.skill)!, (code) => codeIdByCode.get(code)!);
      await saveQuestionDraft(runner, { revisionId: created.revisionId, draft: { ...fields, topicKey: item.skill }, actor });
      itemsCreated += 1;
    }
    return { skillsCreated, skillsReused, codesCreated, codesReused, itemsCreated, itemsSkipped };
  });
}
