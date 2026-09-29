/**
 * The session planner (ENG-08), policy `learning-orchestrator-v1`: one next action for a student,
 * with a teaching strategy and the reasons for it.
 *
 * Why it exists: the engine has to say "do this next, because…" and the answer has to be
 * explainable and replayable (C4). So the planner is rules over explicit inputs — the career gap,
 * skill states, due reviews, published strategies, faculty constraints, adaptive-learning consent
 * and the session time available — and every decision is stored with its inputs in
 * learning_decisions so it can be recomputed and compared. Design and the reasoning behind every
 * rule: docs/architecture/learning-decisions-table-design.md.
 *
 * Pure and deterministic (ADR-034): no database, clock, randomness, network or model. Input is
 * normalised (lists sorted by total orders) before deciding, so identical inputs in any order give
 * identical output. Changing any rule or parameter is a new policy version, never an edit.
 *
 * It never reads the shadow BKT likelihood or FSRS numbers (HG-5: shadow models do not decide what
 * students see), never chooses a strategy that needs a model (AI hold), and produces no numeric
 * value about a student — no score, no readiness.
 */
import { createHash } from 'node:crypto';
import {
  EVIDENCE_STAGES,
  TEACHING_STRATEGY_KINDS,
  strategyApplies,
  validateStrategyApplicability,
  type EvidenceStage,
  type LearningMode,
  type StrategyApplicability,
  type StrategySituation,
  type StrategyTrigger,
  type TeachingStrategyKind,
} from '@planthepath/career-readiness/src/index.js';

export const PLANNER_POLICY_VERSION = 'learning-orchestrator-v1' as const;
export type PlannerPolicyVersion = typeof PLANNER_POLICY_VERSION;

export const plannerActions = ['REVIEW', 'REMEDIATE', 'PRACTICE', 'LEARN', 'FOLLOW_ASSIGNMENT', 'NONE'] as const;
export type PlannerAction = (typeof plannerActions)[number];

/** Actions a faculty override may set (INST-16). NONE and FOLLOW_ASSIGNMENT are not overrides. */
export const overrideActions = ['REVIEW', 'REMEDIATE', 'PRACTICE', 'LEARN'] as const;
export type OverrideAction = (typeof overrideActions)[number];

/** The closed reason vocabulary. Every decision carries at least one (C4). */
export const plannerReasonCodes = [
  'FACULTY_OVERRIDE',
  'DUE_REVIEW',
  'FACULTY_ASSIGNMENT',
  'REPEATED_MISCONCEPTION',
  'GAP_UNKNOWN',
  'GAP_MISSING',
  'GAP_PARTIAL',
  'REQUIREMENT_ESSENTIAL',
  'REQUIREMENT_IMPORTANT',
  'REQUIREMENT_HELPFUL',
  'SHORTER_ACTION_FOR_SESSION',
  'SESSION_TIME_SHORT',
  'NEW_SKILL',
  'NOT_ENOUGH_EVIDENCE',
  'NEAR_MASTERY',
  'STUCK',
  'ACTIVE_MISCONCEPTION',
  'NO_APPLICABLE_STRATEGY',
  'NON_ADAPTIVE_NO_CONSENT',
  'NO_CAREER_TARGET',
  'ALL_REQUIREMENTS_MET',
] as const;
export type PlannerReasonCode = (typeof plannerReasonCodes)[number];

/**
 * Nominal length of each action in minutes, used only to fit the stated session time. Provisional
 * policy parameters, not measurements: no content in ONE carries a duration yet. Never shown.
 * REVIEW is the shortest, so session time never pushes a due review behind other work (C7).
 */
export const PLANNER_ACTION_MINUTES: Readonly<Record<Exclude<PlannerAction, 'NONE'>, number>> = Object.freeze({
  REVIEW: 5,
  REMEDIATE: 10,
  PRACTICE: 10,
  FOLLOW_ASSIGNMENT: 10,
  LEARN: 15,
});

/** "Repeated" means signalled at least twice without being cleared — the meaning of the word. */
export const REPEATED_SIGNALS = 2;

export const MAX_SESSION_MINUTES = 600;
export const MAX_REASON_CODES = 16;

export const careerRequirementLevels = ['ESSENTIAL', 'IMPORTANT', 'HELPFUL'] as const;
export const careerGapStatuses = ['MET', 'PARTIAL', 'MISSING', 'UNKNOWN'] as const;
export const skillBands = ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'DEMONSTRATED'] as const;
export type SkillBand = (typeof skillBands)[number];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlannerGapItem {
  readonly topicId: string;
  readonly requirementLevel: (typeof careerRequirementLevels)[number];
  readonly status: (typeof careerGapStatuses)[number];
  readonly priorityRank: number;
}

/** The student's primary target's current gap (career-gap-v1). Statuses and ranks only, no numbers. */
export interface PlannerCareerGap {
  readonly careerRoleId: string;
  readonly snapshotId: string;
  readonly modelVersion: 'career-gap-v1';
  readonly items: readonly PlannerGapItem[];
}

export interface PlannerMisconception {
  readonly code: string;
  /** Attempts that signalled the code and are not yet cleared; at least 1 while the code is active. */
  readonly unclearedSignals: number;
}

/** One learner_skill_state row, reduced to what planner v1 decides from. No BKT, no FSRS numbers. */
export interface PlannerSkillState {
  readonly skillId: string;
  readonly evidenceStage: EvidenceStage;
  readonly evidenceBand: SkillBand;
  readonly attemptCount: number;
  readonly attemptDayCount: number;
  readonly unaidedSuccessCount: number;
  /** Highest hint level on the latest answered attempt on the skill; 0 when unknown. */
  readonly latestHintLevel: number;
  readonly misconceptions: readonly PlannerMisconception[];
}

export interface PlannerDueReview {
  readonly skillId: string;
  readonly reviewDueAt: string;
}

/** A PUBLISHED teaching strategy version (drafts never reach the planner). */
export interface PlannerStrategy {
  readonly code: string;
  readonly version: number;
  readonly kind: TeachingStrategyKind;
  readonly applicability: StrategyApplicability;
  readonly requiresModel: boolean;
}

export interface PlannerAssignment {
  readonly assignmentId: string;
  readonly skillId: string;
  readonly assignedAt: string;
}

export interface PlannerOverride {
  readonly overrideId: string;
  readonly byUserId: string;
  readonly reasonCode: string;
  readonly action: OverrideAction;
  readonly skillId: string;
  readonly focusMisconceptionCode: string | null;
}

/** Faculty constraints (INST-16). No source exists yet; the loader passes none. */
export interface PlannerConstraints {
  readonly override: PlannerOverride | null;
  readonly assignments: readonly PlannerAssignment[];
}

export interface PlannerInput {
  /** Whether the student holds adaptive-learning consent (ENG-01). False means the non-adaptive path. */
  readonly adaptive: boolean;
  /** Minutes the student has, 1–600, or null when not stated. */
  readonly sessionMinutes: number | null;
  readonly careerGap: PlannerCareerGap | null;
  readonly skillStates: readonly PlannerSkillState[];
  readonly dueReviews: readonly PlannerDueReview[];
  readonly strategies: readonly PlannerStrategy[];
  readonly constraints: PlannerConstraints;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface PlannerStrategyChoice {
  readonly code: string;
  readonly version: number;
  readonly kind: TeachingStrategyKind;
}

export interface PlannerDecision {
  readonly policyVersion: PlannerPolicyVersion;
  readonly action: PlannerAction;
  readonly skillId: string | null;
  readonly focusMisconceptionCode: string | null;
  readonly strategy: PlannerStrategyChoice | null;
  readonly reasonCodes: readonly PlannerReasonCode[];
  readonly override: { readonly byUserId: string; readonly reasonCode: string } | null;
}

export class PlannerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerInputError';
  }
}

// ---------------------------------------------------------------------------
// Validation and normalisation
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function fail(message: string): never {
  throw new PlannerInputError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string, max = 1000): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be a list`);
  if (value.length > max) fail(`${label} has too many entries`);
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be a UUID`);
  return value.toLowerCase();
}

function code(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CODE.test(value)) fail(`${label} must be a code`);
  return value;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(`${label} is not a known value`);
  return value as T;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a timestamp`);
  return new Date(parsed).toISOString();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) fail(`${label} contains a duplicate`);
    seen.add(k);
  }
}

function parseGap(value: unknown): PlannerCareerGap | null {
  if (value === null) return null;
  const gap = record(value, 'careerGap');
  if (gap.modelVersion !== 'career-gap-v1') fail('careerGap.modelVersion must be career-gap-v1');
  const items = list(gap.items, 'careerGap.items').map((entry, index) => {
    const item = record(entry, `careerGap.items[${index}]`);
    return {
      topicId: uuid(item.topicId, 'gap topicId'),
      requirementLevel: oneOf(item.requirementLevel, careerRequirementLevels, 'gap requirementLevel'),
      status: oneOf(item.status, careerGapStatuses, 'gap status'),
      priorityRank: integer(item.priorityRank, 1, 100_000, 'gap priorityRank'),
    };
  });
  unique(items, (item) => item.topicId, 'careerGap.items');
  unique(items, (item) => String(item.priorityRank), 'careerGap.items ranks');
  return {
    careerRoleId: uuid(gap.careerRoleId, 'careerGap.careerRoleId'),
    snapshotId: uuid(gap.snapshotId, 'careerGap.snapshotId'),
    modelVersion: 'career-gap-v1',
    items: [...items].sort((left, right) => left.priorityRank - right.priorityRank),
  };
}

function parseSkillState(value: unknown, index: number): PlannerSkillState {
  const state = record(value, `skillStates[${index}]`);
  const attemptCount = integer(state.attemptCount, 0, 1_000_000, 'attemptCount');
  const attemptDayCount = integer(state.attemptDayCount, 0, attemptCount, 'attemptDayCount');
  const unaidedSuccessCount = integer(state.unaidedSuccessCount, 0, attemptCount, 'unaidedSuccessCount');
  const misconceptions = list(state.misconceptions, 'misconceptions', 64).map((entry) => {
    const item = record(entry, 'misconception');
    return { code: code(item.code, 'misconception code'), unclearedSignals: integer(item.unclearedSignals, 1, 1_000_000, 'unclearedSignals') };
  });
  unique(misconceptions, (item) => item.code, 'misconceptions');
  return {
    skillId: uuid(state.skillId, 'skillId'),
    evidenceStage: oneOf(state.evidenceStage, EVIDENCE_STAGES, 'evidenceStage'),
    evidenceBand: oneOf(state.evidenceBand, skillBands, 'evidenceBand'),
    attemptCount,
    attemptDayCount,
    unaidedSuccessCount,
    latestHintLevel: integer(state.latestHintLevel, 0, 4, 'latestHintLevel'),
    misconceptions: [...misconceptions].sort((left, right) => compare(left.code, right.code)),
  };
}

function parseStrategy(value: unknown, index: number): PlannerStrategy {
  const strategy = record(value, `strategies[${index}]`);
  let applicability: StrategyApplicability;
  try {
    applicability = validateStrategyApplicability(strategy.applicability);
  } catch {
    fail('a strategy has invalid applicability rules');
  }
  return {
    code: code(strategy.code, 'strategy code'),
    version: integer(strategy.version, 1, 1_000_000, 'strategy version'),
    kind: oneOf(strategy.kind, TEACHING_STRATEGY_KINDS, 'strategy kind'),
    applicability: normaliseApplicability(applicability),
    requiresModel: boolean(strategy.requiresModel, 'requiresModel'),
  };
}

/** Rule lists are sets: sorted so the stored inputs and their hash do not depend on authoring order. */
function normaliseApplicability(rules: StrategyApplicability): StrategyApplicability {
  const sorted = <T extends string>(values: readonly T[] | undefined): readonly T[] | undefined =>
    values === undefined ? undefined : [...values].sort(compare);
  const out: {
    modes?: readonly LearningMode[]; evidenceStages?: readonly EvidenceStage[]; triggers?: readonly StrategyTrigger[];
    misconceptionCodes?: readonly string[]; minRecentErrors?: number; maxHintLevel?: number;
  } = {};
  const modes = sorted(rules.modes);
  const stages = sorted(rules.evidenceStages);
  const triggers = sorted(rules.triggers);
  const codes = sorted(rules.misconceptionCodes);
  if (modes) out.modes = modes;
  if (stages) out.evidenceStages = stages;
  if (triggers) out.triggers = triggers;
  if (codes) out.misconceptionCodes = codes;
  if (rules.minRecentErrors !== undefined) out.minRecentErrors = rules.minRecentErrors;
  if (rules.maxHintLevel !== undefined) out.maxHintLevel = rules.maxHintLevel;
  return out;
}

function parseConstraints(value: unknown): PlannerConstraints {
  const constraints = record(value, 'constraints');
  let override: PlannerOverride | null = null;
  if (constraints.override !== null && constraints.override !== undefined) {
    const raw = record(constraints.override, 'override');
    const action = oneOf(raw.action, overrideActions, 'override action');
    const focus = raw.focusMisconceptionCode === null || raw.focusMisconceptionCode === undefined
      ? null : code(raw.focusMisconceptionCode, 'override focusMisconceptionCode');
    if ((action === 'REMEDIATE') !== (focus !== null)) fail('an override names a focus misconception exactly when it remediates');
    override = {
      overrideId: uuid(raw.overrideId, 'overrideId'),
      byUserId: uuid(raw.byUserId, 'override byUserId'),
      reasonCode: code(raw.reasonCode, 'override reasonCode'),
      action,
      skillId: uuid(raw.skillId, 'override skillId'),
      focusMisconceptionCode: focus,
    };
  }
  const assignments = list(constraints.assignments, 'assignments').map((entry) => {
    const item = record(entry, 'assignment');
    return {
      assignmentId: uuid(item.assignmentId, 'assignmentId'),
      skillId: uuid(item.skillId, 'assignment skillId'),
      assignedAt: instant(item.assignedAt, 'assignedAt'),
    };
  });
  unique(assignments, (item) => item.assignmentId, 'assignments');
  return {
    override,
    assignments: [...assignments].sort((left, right) =>
      Date.parse(left.assignedAt) - Date.parse(right.assignedAt) || compare(left.assignmentId, right.assignmentId)),
  };
}

/**
 * Validate and normalise planner input: every list sorted by a total order, identifiers
 * lower-cased, timestamps in ISO form. Idempotent. This is the form stored in learning_decisions.
 * Accepts `unknown` so a stored row's inputs can be checked on replay.
 */
export function normalisePlannerInput(value: unknown): PlannerInput {
  const input = record(value, 'planner input');
  const sessionMinutes = input.sessionMinutes === null ? null : integer(input.sessionMinutes, 1, MAX_SESSION_MINUTES, 'sessionMinutes');
  const skillStates = list(input.skillStates, 'skillStates').map(parseSkillState);
  unique(skillStates, (state) => state.skillId, 'skillStates');
  const dueReviews = list(input.dueReviews, 'dueReviews').map((entry) => {
    const item = record(entry, 'dueReview');
    return { skillId: uuid(item.skillId, 'dueReview skillId'), reviewDueAt: instant(item.reviewDueAt, 'reviewDueAt') };
  });
  unique(dueReviews, (review) => review.skillId, 'dueReviews');
  const strategies = list(input.strategies, 'strategies').map(parseStrategy);
  unique(strategies, (strategy) => `${strategy.code}:${strategy.version}`, 'strategies');
  return {
    adaptive: boolean(input.adaptive, 'adaptive'),
    sessionMinutes,
    careerGap: parseGap(input.careerGap ?? null),
    skillStates: [...skillStates].sort((left, right) => compare(left.skillId, right.skillId)),
    // Earliest due first, ties by skill — the same order as review-scheduler's selectDueReviews.
    dueReviews: [...dueReviews].sort((left, right) =>
      Date.parse(left.reviewDueAt) - Date.parse(right.reviewDueAt) || compare(left.skillId, right.skillId)),
    strategies: [...strategies].sort((left, right) => compare(left.code, right.code) || left.version - right.version),
    constraints: parseConstraints(input.constraints),
  };
}

/** JSON with object keys sorted at every depth; the form the inputs hash is taken over. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new PlannerInputError('a number is not finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compare(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

/** SHA-256 (hex) of the canonical JSON of the normalised input. */
export function plannerInputsHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(normalisePlannerInput(input))).digest('hex');
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

interface Candidate {
  readonly action: Exclude<PlannerAction, 'NONE'>;
  readonly skillId: string;
  readonly focusMisconceptionCode: string | null;
  readonly reasons: readonly PlannerReasonCode[];
}

const GAP_REASON: Readonly<Record<'UNKNOWN' | 'MISSING' | 'PARTIAL', PlannerReasonCode>> = {
  UNKNOWN: 'GAP_UNKNOWN', MISSING: 'GAP_MISSING', PARTIAL: 'GAP_PARTIAL',
};
const LEVEL_REASON: Readonly<Record<PlannerGapItem['requirementLevel'], PlannerReasonCode>> = {
  ESSENTIAL: 'REQUIREMENT_ESSENTIAL', IMPORTANT: 'REQUIREMENT_IMPORTANT', HELPFUL: 'REQUIREMENT_HELPFUL',
};

function repeatedMisconceptions(state: PlannerSkillState | undefined): readonly PlannerMisconception[] {
  if (!state) return [];
  return state.misconceptions
    .filter((item) => item.unclearedSignals >= REPEATED_SIGNALS)
    .sort((left, right) => right.unclearedSignals - left.unclearedSignals || compare(left.code, right.code));
}

function candidatesFor(input: PlannerInput, states: ReadonlyMap<string, PlannerSkillState>): readonly Candidate[] {
  const candidates: Candidate[] = [];
  // C7: a skill past its due interval comes first in the session. Adaptive only: the schedule is
  // built from the attempt history consent covers.
  if (input.adaptive) {
    for (const review of input.dueReviews) {
      candidates.push({ action: 'REVIEW', skillId: review.skillId, focusMisconceptionCode: null, reasons: ['DUE_REVIEW'] });
    }
  }
  for (const assignment of input.constraints.assignments) {
    candidates.push({ action: 'FOLLOW_ASSIGNMENT', skillId: assignment.skillId, focusMisconceptionCode: null, reasons: ['FACULTY_ASSIGNMENT'] });
  }
  const open = (input.careerGap?.items ?? []).filter((item) => item.status !== 'MET');
  const gapReasons = (item: PlannerGapItem): readonly PlannerReasonCode[] =>
    [GAP_REASON[item.status as 'UNKNOWN' | 'MISSING' | 'PARTIAL'], LEVEL_REASON[item.requirementLevel]];
  if (input.adaptive) {
    // X1: a misconception signalled repeatedly is remediated on its own before the full problem.
    for (const item of open) {
      const repeated = repeatedMisconceptions(states.get(item.topicId));
      if (repeated.length === 0) continue;
      candidates.push({
        action: 'REMEDIATE', skillId: item.topicId, focusMisconceptionCode: repeated[0]!.code,
        reasons: ['REPEATED_MISCONCEPTION', ...gapReasons(item)],
      });
    }
  }
  for (const item of open) {
    const state = states.get(item.topicId);
    const action = input.adaptive
      ? (!state || state.attemptCount === 0 ? 'LEARN' : 'PRACTICE')
      : (item.status === 'PARTIAL' ? 'PRACTICE' : 'LEARN');
    candidates.push({ action, skillId: item.topicId, focusMisconceptionCode: null, reasons: gapReasons(item) });
  }
  return candidates;
}

function supportingReasons(state: PlannerSkillState | undefined): readonly PlannerReasonCode[] {
  const reasons: PlannerReasonCode[] = [];
  if (!state || state.attemptCount === 0) reasons.push('NEW_SKILL');
  if (!state || state.evidenceBand === 'NOT_ENOUGH_EVIDENCE') reasons.push('NOT_ENOUGH_EVIDENCE');
  if (state?.evidenceStage === 'RETAINED') reasons.push('NEAR_MASTERY');
  if (state && isStuck(state)) reasons.push('STUCK');
  if (state && state.misconceptions.length > 0) reasons.push('ACTIVE_MISCONCEPTION');
  return reasons;
}

/**
 * STUCK: tried on at least this many calendar days and never succeeded unaided. Exported so the faculty
 * cohort view (INST-15) uses the engine's threshold rather than inventing its own.
 */
export const STUCK_MIN_ATTEMPT_DAYS = 2;

/** Tried on more than one day and never succeeded unaided — the planner's STUCK rule. */
export function isStuckSkillState(state: Pick<PlannerSkillState, 'attemptDayCount' | 'unaidedSuccessCount'>): boolean {
  return state.attemptDayCount >= STUCK_MIN_ATTEMPT_DAYS && state.unaidedSuccessCount === 0;
}

function isStuck(state: PlannerSkillState): boolean {
  return isStuckSkillState(state);
}

const MODE_FOR_ACTION: Readonly<Record<Exclude<PlannerAction, 'NONE'>, LearningMode>> = {
  REVIEW: 'REVIEW', LEARN: 'LEARN', REMEDIATE: 'PRACTICE', PRACTICE: 'PRACTICE', FOLLOW_ASSIGNMENT: 'PRACTICE',
};

function situationFor(action: Exclude<PlannerAction, 'NONE'>, state: PlannerSkillState | undefined, focus: string | null): StrategySituation {
  const misconceptions = state?.misconceptions ?? [];
  const highest = misconceptions.reduce((max, item) => Math.max(max, item.unclearedSignals), 0);
  const focusCount = focus === null ? null : misconceptions.find((item) => item.code === focus)?.unclearedSignals ?? 0;
  const triggers: StrategyTrigger[] = [];
  if (!state || state.attemptCount === 0) triggers.push('NEW_SKILL');
  if (action === 'REVIEW') triggers.push('DUE_REVIEW');
  if (misconceptions.length > 0 || focus !== null) triggers.push('MISCONCEPTION_DETECTED');
  if (highest >= REPEATED_SIGNALS || (focusCount ?? 0) >= REPEATED_SIGNALS) triggers.push('REPEATED_ERROR');
  if (state && isStuck(state)) triggers.push('STUCK');
  if (state?.evidenceStage === 'RETAINED') triggers.push('NEAR_MASTERY');
  const active = misconceptions.map((item) => item.code);
  if (focus !== null && !active.includes(focus)) active.push(focus);
  return {
    mode: MODE_FOR_ACTION[action],
    evidenceStage: state?.evidenceStage ?? 'ESTIMATED',
    triggers,
    activeMisconceptionCodes: active.sort(compare),
    recentErrors: focusCount ?? highest,
    highestHintLevel: state?.latestHintLevel ?? 0,
  };
}

function ruleCount(rules: StrategyApplicability): number {
  return Object.values(rules).filter((value) => value !== undefined).length;
}

/** The trigger that defines each kind of step, for ranking strategies written for that situation. */
const PRIMARY_TRIGGER: Readonly<Record<Exclude<PlannerAction, 'NONE'>, StrategyTrigger | null>> = {
  REVIEW: 'DUE_REVIEW', REMEDIATE: 'MISCONCEPTION_DETECTED', LEARN: 'NEW_SKILL', PRACTICE: null, FOLLOW_ASSIGNMENT: null,
};

/**
 * The strategy for the chosen step: published, highest version per code, never one that needs a
 * model (AI hold; X2), admitted by teaching-strategy-applicability-v1, then ranked — one naming
 * the focus code (or any active code) first; then one written for the step's defining trigger
 * (a due review, a misconception, a new skill); then the more specific (more rules); then by code.
 */
export function chooseStrategy(
  strategies: readonly PlannerStrategy[],
  situation: StrategySituation,
  focus: string | null,
  primaryTrigger: StrategyTrigger | null = null,
): PlannerStrategyChoice | null {
  const latest = new Map<string, PlannerStrategy>();
  for (const strategy of strategies) {
    const current = latest.get(strategy.code);
    if (!current || strategy.version > current.version) latest.set(strategy.code, strategy);
  }
  const targets = focus !== null ? [focus] : situation.activeMisconceptionCodes;
  const addresses = (strategy: PlannerStrategy): number =>
    (strategy.applicability.misconceptionCodes ?? []).some((c) => targets.includes(c)) ? 1 : 0;
  const lists = (strategy: PlannerStrategy): number =>
    primaryTrigger !== null && (strategy.applicability.triggers ?? []).includes(primaryTrigger) ? 1 : 0;
  const ranked = [...latest.values()]
    .filter((strategy) => !strategy.requiresModel && strategyApplies(strategy.applicability, situation))
    .sort((left, right) =>
      addresses(right) - addresses(left)
      || lists(right) - lists(left)
      || ruleCount(right.applicability) - ruleCount(left.applicability)
      || compare(left.code, right.code));
  const best = ranked[0];
  return best ? { code: best.code, version: best.version, kind: best.kind } : null;
}

function finish(reasons: readonly PlannerReasonCode[]): readonly PlannerReasonCode[] {
  const out: PlannerReasonCode[] = [];
  for (const reason of reasons) if (!out.includes(reason)) out.push(reason);
  return out.slice(0, MAX_REASON_CODES);
}

/**
 * Plan the next step (learning-orchestrator-v1). Pure: identical inputs, in any order, always give
 * the identical decision. Throws PlannerInputError on malformed input.
 */
export function planNextStep(rawInput: PlannerInput | unknown): PlannerDecision {
  const input = normalisePlannerInput(rawInput);
  // The non-adaptive path never looks at the attempt-history profile.
  const states = new Map(input.adaptive ? input.skillStates.map((state) => [state.skillId, state] as const) : []);
  const consentReason: readonly PlannerReasonCode[] = input.adaptive ? [] : ['NON_ADAPTIVE_NO_CONSENT'];

  const decide = (
    action: Exclude<PlannerAction, 'NONE'>,
    skillId: string,
    focus: string | null,
    reasons: readonly PlannerReasonCode[],
    override: PlannerDecision['override'],
  ): PlannerDecision => {
    const state = states.get(skillId);
    const strategy = input.adaptive ? chooseStrategy(input.strategies, situationFor(action, state, focus), focus, PRIMARY_TRIGGER[action]) : null;
    return {
      policyVersion: PLANNER_POLICY_VERSION,
      action,
      skillId,
      focusMisconceptionCode: focus,
      strategy,
      reasonCodes: finish([
        ...reasons,
        ...(input.adaptive ? supportingReasons(state) : []),
        ...(input.adaptive && strategy === null ? ['NO_APPLICABLE_STRATEGY' as const] : []),
        ...consentReason,
      ]),
      override,
    };
  };

  // A person decided: record it rather than second-guess it (INST-16).
  const override = input.constraints.override;
  if (override) {
    return decide(override.action, override.skillId, override.focusMisconceptionCode, ['FACULTY_OVERRIDE'],
      { byUserId: override.byUserId, reasonCode: override.reasonCode });
  }

  const candidates = candidatesFor(input, states);
  if (candidates.length === 0) {
    return {
      policyVersion: PLANNER_POLICY_VERSION,
      action: 'NONE',
      skillId: null,
      focusMisconceptionCode: null,
      strategy: null,
      reasonCodes: finish([input.careerGap === null ? 'NO_CAREER_TARGET' : 'ALL_REQUIREMENTS_MET', ...consentReason]),
      override: null,
    };
  }

  let index = 0;
  const sessionReasons: PlannerReasonCode[] = [];
  if (input.sessionMinutes !== null) {
    const minutes = input.sessionMinutes;
    const fitting = candidates.findIndex((candidate) => PLANNER_ACTION_MINUTES[candidate.action] <= minutes);
    if (fitting === -1) sessionReasons.push('SESSION_TIME_SHORT');
    else if (fitting > 0) {
      index = fitting;
      sessionReasons.push('SHORTER_ACTION_FOR_SESSION');
    }
  }
  const chosen = candidates[index]!;
  return decide(chosen.action, chosen.skillId, chosen.focusMisconceptionCode, [...chosen.reasons, ...sessionReasons], null);
}

// ---------------------------------------------------------------------------
// Replay (C4)
// ---------------------------------------------------------------------------

export type ReplayStatus = 'MATCHED' | 'MISMATCHED' | 'HASH_MISMATCH' | 'INVALID_INPUTS' | 'UNSUPPORTED_POLICY';

export interface StoredDecision {
  readonly policyVersion: string;
  readonly inputs: unknown;
  readonly inputsHash: string;
  readonly decision: Omit<PlannerDecision, 'policyVersion'>;
}

export interface ReplayResult {
  readonly status: ReplayStatus;
  readonly recomputed: PlannerDecision | null;
}

/**
 * Recompute a stored decision from its stored inputs and compare. A row whose inputs no longer
 * hash to the stored hash is reported, not trusted; a retired policy is reported, never replayed
 * under a different one.
 */
export function replayDecision(stored: StoredDecision): ReplayResult {
  if (stored.policyVersion !== PLANNER_POLICY_VERSION) return { status: 'UNSUPPORTED_POLICY', recomputed: null };
  let hash: string;
  try {
    hash = plannerInputsHash(stored.inputs);
  } catch (error) {
    if (error instanceof PlannerInputError) return { status: 'INVALID_INPUTS', recomputed: null };
    throw error;
  }
  if (hash !== stored.inputsHash) return { status: 'HASH_MISMATCH', recomputed: null };
  const recomputed = planNextStep(stored.inputs);
  const { policyVersion: _policy, ...comparable } = recomputed;
  return { status: canonicalJson(comparable) === canonicalJson(stored.decision) ? 'MATCHED' : 'MISMATCHED', recomputed };
}

// The skip / review / learn grouping of the student's path (ENG-18).
export * from './path-groups.js';
