/**
 * Misconception codes, question-option tags and teaching strategies — the pure rules (ENG-07).
 *
 * Why this exists: a wrong answer only tells the engine what to teach next if it can be read
 * as a named misconception, and a strategy only replays (C4) if choosing it is deterministic.
 * These functions hold those rules with no database, clock or randomness, following the
 * career-readiness pattern (ADR-034). Persistence (packages/persistence/src/misconceptions.ts)
 * loads published rows and calls them; the tables are in migration 0049 and designed in
 * docs/architecture/misconception-codes-table-design.md and its two siblings.
 */

export const MISCONCEPTION_TAGGING_ALGORITHM = 'misconception-tagging-v1';
export const TEACHING_STRATEGY_APPLICABILITY_ALGORITHM = 'teaching-strategy-applicability-v1';

/** Same pattern as the CHECK on misconception_codes.code and teaching_strategies.code. */
export const ENGINE_CONTENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export const TEACHING_STRATEGY_KINDS = [
  'WORKED_EXAMPLE', 'GUIDED_PRACTICE', 'SOCRATIC_QUESTIONING', 'HINT_LADDER', 'ERROR_CORRECTION', 'RETRIEVAL_PRACTICE', 'TEACH_BACK',
] as const;
export type TeachingStrategyKind = (typeof TEACHING_STRATEGY_KINDS)[number];

/** GENERATED (an orchestrated model call) is deliberately absent until ENG-23 (AI hold, ADR-030). */
export const ENGINE_CONTENT_SOURCES = ['AUTHORED', 'AGENT_DRAFTED'] as const;
export type EngineContentSource = (typeof ENGINE_CONTENT_SOURCES)[number];

export interface EngineContentProvenance {
  readonly source: EngineContentSource;
  readonly generatorVersion?: string;
  readonly promptVersion?: string;
  readonly generatedAt?: Date;
  /** What the content rests on (program B.8: "cite their basis"). */
  readonly basis: string;
  /** Every claim a subject expert must check. Required for AGENT_DRAFTED. */
  readonly expertCheckNotes?: string;
}

function assertText(value: unknown, label: string, max: number): void {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max) {
    throw new Error(`${label} must be 1-${max} characters`);
  }
}

function assertCode(value: unknown, label: string): void {
  if (typeof value !== 'string' || !ENGINE_CONTENT_CODE_PATTERN.test(value)) throw new Error(`${label} is invalid`);
}

/** Mirrors the provenance CHECKs in 0049 so a bad draft fails before it reaches SQL. */
export function validateEngineContentProvenance(provenance: EngineContentProvenance): void {
  if (!(ENGINE_CONTENT_SOURCES as readonly string[]).includes(provenance.source)) throw new Error('content source is invalid');
  assertText(provenance.basis, 'basis', 4000);
  if (provenance.expertCheckNotes !== undefined) assertText(provenance.expertCheckNotes, 'expertCheckNotes', 4000);
  const generated = [provenance.generatorVersion, provenance.promptVersion, provenance.generatedAt];
  if (provenance.source === 'AUTHORED') {
    if (generated.some((value) => value !== undefined)) throw new Error('authored content carries no generator provenance');
    return;
  }
  assertText(provenance.generatorVersion, 'generatorVersion', 128);
  assertText(provenance.promptVersion, 'promptVersion', 128);
  if (!(provenance.generatedAt instanceof Date) || Number.isNaN(provenance.generatedAt.getTime())) {
    throw new Error('generatedAt is required for agent-drafted content');
  }
  if (provenance.expertCheckNotes === undefined) throw new Error('agent-drafted content must mark the claims that need expert checking');
}

export interface MisconceptionCodeDraft extends EngineContentProvenance {
  readonly code: string;
  readonly skillId: string;
  readonly title: string;
  readonly description: string;
}

export function validateMisconceptionCodeDraft(draft: MisconceptionCodeDraft): void {
  assertCode(draft.code, 'misconception code');
  assertText(draft.title, 'title', 160);
  assertText(draft.description, 'description', 2000);
  validateEngineContentProvenance(draft);
}

/** The part of a QUESTION content revision body a tag is checked against. */
export interface QuestionRevisionOptions {
  readonly options: readonly { readonly id: string }[];
  readonly correctOptionId: string;
}

/** A tag must sit on an option that exists and is wrong (the 0049 trigger enforces the same). */
export function validateOptionTag(question: QuestionRevisionOptions, optionId: string, rationale: string): void {
  if (typeof optionId !== 'string' || optionId.length < 1 || optionId.length > 64) throw new Error('option id is invalid');
  if (!question.options.some((option) => option.id === optionId)) throw new Error('tagged option does not exist on the question');
  if (question.correctOptionId === optionId) throw new Error('the correct option cannot carry a misconception');
  assertText(rationale, 'rationale', 2000);
}

export interface PublishedOptionTag {
  readonly optionId: string;
  readonly misconceptionCodeId: string;
  readonly code: string;
}

export interface ResponseMisconception {
  readonly misconceptionCodeId: string;
  readonly code: string;
}

/**
 * The misconceptions a single response signals (misconception-tagging-v1).
 *
 * A correct response signals none, whatever the tags say — a tag on the correct option is
 * refused at write time, and this is the second line. A blank response signals none: not
 * answering is not evidence of a particular wrong idea. Output is de-duplicated and ordered
 * by code then id, so identical inputs always give identical output.
 */
export function misconceptionsForResponse(input: {
  readonly selectedOptionId: string | null;
  readonly correctOptionId: string;
  readonly tags: readonly PublishedOptionTag[];
}): readonly ResponseMisconception[] {
  if (input.selectedOptionId === null || input.selectedOptionId === input.correctOptionId) return [];
  const byId = new Map<string, ResponseMisconception>();
  for (const tag of input.tags) {
    if (tag.optionId !== input.selectedOptionId) continue;
    byId.set(tag.misconceptionCodeId, { misconceptionCodeId: tag.misconceptionCodeId, code: tag.code });
  }
  return [...byId.values()].sort((left, right) =>
    left.code === right.code ? compareStrings(left.misconceptionCodeId, right.misconceptionCodeId) : compareStrings(left.code, right.code));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Teaching strategy applicability
// ---------------------------------------------------------------------------

/** learning_sessions.mode values (ENG-03). */
export const LEARNING_MODES = ['LEARN', 'PRACTICE', 'REVIEW', 'ASSESSMENT', 'EXPLORE'] as const;
export type LearningMode = (typeof LEARNING_MODES)[number];

/** D.1 evidence stages (ENG-04/05). */
export const EVIDENCE_STAGES = ['ESTIMATED', 'RETAINED', 'DEMONSTRATED', 'TRANSFERRED'] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];

export const STRATEGY_TRIGGERS = ['NEW_SKILL', 'REPEATED_ERROR', 'MISCONCEPTION_DETECTED', 'DUE_REVIEW', 'STUCK', 'NEAR_MASTERY'] as const;
export type StrategyTrigger = (typeof STRATEGY_TRIGGERS)[number];

export interface StrategyApplicability {
  readonly modes?: readonly LearningMode[];
  readonly evidenceStages?: readonly EvidenceStage[];
  readonly triggers?: readonly StrategyTrigger[];
  readonly misconceptionCodes?: readonly string[];
  readonly minRecentErrors?: number;
  readonly maxHintLevel?: number;
}

const APPLICABILITY_KEYS = ['modes', 'evidenceStages', 'triggers', 'misconceptionCodes', 'minRecentErrors', 'maxHintLevel'] as const;

function validateEnumList<T extends string>(value: unknown, allowed: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list`);
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !(allowed as readonly string[]).includes(entry)) throw new Error(`${label} contains an unknown value`);
    if (seen.has(entry)) throw new Error(`${label} contains a duplicate`);
    seen.add(entry);
  }
  return value as T[];
}

function validateInteger(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Accepts only the closed shape in teaching-strategies-table-design.md; unknown keys are refused. */
export function validateStrategyApplicability(value: unknown): StrategyApplicability {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('applicability must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(APPLICABILITY_KEYS as readonly string[]).includes(key)) throw new Error(`applicability has an unknown rule ${key}`);
  }
  const rules: {
    modes?: readonly LearningMode[]; evidenceStages?: readonly EvidenceStage[]; triggers?: readonly StrategyTrigger[];
    misconceptionCodes?: readonly string[]; minRecentErrors?: number; maxHintLevel?: number;
  } = {};
  if (record.modes !== undefined) rules.modes = validateEnumList(record.modes, LEARNING_MODES, 'modes');
  if (record.evidenceStages !== undefined) rules.evidenceStages = validateEnumList(record.evidenceStages, EVIDENCE_STAGES, 'evidenceStages');
  if (record.triggers !== undefined) rules.triggers = validateEnumList(record.triggers, STRATEGY_TRIGGERS, 'triggers');
  if (record.misconceptionCodes !== undefined) {
    const codes = record.misconceptionCodes;
    if (!Array.isArray(codes) || codes.length === 0) throw new Error('misconceptionCodes must be a non-empty list');
    for (const code of codes) assertCode(code, 'misconceptionCodes entry');
    if (new Set(codes).size !== codes.length) throw new Error('misconceptionCodes contains a duplicate');
    rules.misconceptionCodes = codes as string[];
  }
  if (record.minRecentErrors !== undefined) rules.minRecentErrors = validateInteger(record.minRecentErrors, 0, 20, 'minRecentErrors');
  if (record.maxHintLevel !== undefined) rules.maxHintLevel = validateInteger(record.maxHintLevel, 0, 4, 'maxHintLevel');
  return rules;
}

export interface StrategySituation {
  readonly mode: LearningMode;
  readonly evidenceStage: EvidenceStage;
  readonly triggers: readonly StrategyTrigger[];
  readonly activeMisconceptionCodes: readonly string[];
  readonly recentErrors: number;
  readonly highestHintLevel: number;
}

/**
 * Whether a strategy's rules admit a situation (teaching-strategy-applicability-v1).
 * Every present rule must hold; an absent rule does not restrict. It does not rank —
 * ranking is the planner's versioned policy (ENG-08).
 */
export function strategyApplies(rules: StrategyApplicability, situation: StrategySituation): boolean {
  if (rules.modes && !rules.modes.includes(situation.mode)) return false;
  if (rules.evidenceStages && !rules.evidenceStages.includes(situation.evidenceStage)) return false;
  if (rules.triggers && !rules.triggers.some((trigger) => situation.triggers.includes(trigger))) return false;
  if (rules.misconceptionCodes && !rules.misconceptionCodes.some((code) => situation.activeMisconceptionCodes.includes(code))) return false;
  if (rules.minRecentErrors !== undefined && situation.recentErrors < rules.minRecentErrors) return false;
  if (rules.maxHintLevel !== undefined && situation.highestHintLevel > rules.maxHintLevel) return false;
  return true;
}

export interface TeachingStrategyDraft extends EngineContentProvenance {
  readonly code: string;
  readonly strategyKind: TeachingStrategyKind;
  readonly title: string;
  readonly description: string;
  readonly applicability: StrategyApplicability;
  readonly requiresModel: boolean;
}

export function validateTeachingStrategyDraft(draft: TeachingStrategyDraft): void {
  assertCode(draft.code, 'strategy code');
  if (!(TEACHING_STRATEGY_KINDS as readonly string[]).includes(draft.strategyKind)) throw new Error('strategy kind is invalid');
  assertText(draft.title, 'title', 160);
  assertText(draft.description, 'description', 4000);
  validateStrategyApplicability(draft.applicability);
  if (typeof draft.requiresModel !== 'boolean') throw new Error('requiresModel must be a boolean');
  validateEngineContentProvenance(draft);
}
