/**
 * The learning model (ENG-04): evidence stages, the assisted rule, evidence sufficiency and
 * required-evidence-type checks, as pure functions under one algorithm ID.
 *
 * Why it exists: the engine grades what a student has shown in four stages (estimated →
 * retained → demonstrated → transferred), and later goals — the skill-state projection
 * (ENG-05), the planner (ENG-08), the employer evidence view (EMP-13) — must all read the same
 * rules. Design and reasoning: docs/architecture/evidence-stages-table-design.md.
 *
 * Pure and deterministic (ADR-034): no database, clock, randomness or network. Time arrives as
 * an argument; identical inputs give identical outputs regardless of input order. Changing a
 * rule means a new algorithm ID, never an edited one.
 *
 * Nothing here produces a numeric readiness value or writes readiness (ADR-020). The counts it
 * returns explain a band; they are never presented as a score.
 */

export const LEARNING_MODEL_ALGORITHM_ID = 'learning-model-v1' as const;
export type LearningModelAlgorithmId = typeof LEARNING_MODEL_ALGORITHM_ID;

/** The zone in which a "calendar day" is counted. */
export const LEARNING_MODEL_TIME_ZONE = 'Asia/Kolkata' as const;
/** Asia/Kolkata has been UTC+05:30, without daylight saving, since 1945. */
const KOLKATA_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** From this hint level on, a success is assisted (C5). */
export const ASSISTED_HINT_LEVEL = 3;
export const MAX_HINT_LEVEL = 4;

export const evidenceStages = ['ESTIMATED', 'RETAINED', 'DEMONSTRATED', 'TRANSFERRED'] as const;
export type EvidenceStage = (typeof evidenceStages)[number];

export const attemptContexts = ['PRACTICE', 'DIAGNOSTIC', 'ASSESSMENT', 'REVIEW'] as const;
export type AttemptContext = (typeof attemptContexts)[number];

/** Same vocabulary as mastery_projections.band, so a projection can store it unchanged. */
export type SkillBand = 'NOT_ENOUGH_EVIDENCE' | 'DEVELOPING' | 'PROGRESSING' | 'DEMONSTRATED';
export type EvidenceSufficiency = 'NOT_ENOUGH_EVIDENCE' | 'ENOUGH_EVIDENCE';

/** Kinds of evidence a career requirement may require: the evidence_records.evidence_type vocabulary. */
export const requirableEvidenceTypes = ['LESSON_COMPLETION', 'ASSESSMENT_OUTCOME', 'TOPIC_DEMONSTRATION'] as const;
export type RequirableEvidenceType = (typeof requirableEvidenceTypes)[number];

export class LearningModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningModelError';
  }
}

export function stageRank(stage: EvidenceStage): number {
  return evidenceStages.indexOf(stage);
}

export function isEvidenceStage(value: unknown): value is EvidenceStage {
  return typeof value === 'string' && (evidenceStages as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Assisted
// ---------------------------------------------------------------------------

export interface AssistanceFacts {
  /** Highest hint level shown on the item, 0–4. */
  readonly highestHintLevel?: number;
  /** Any AI tutor reply on the item (ADR-033: that alone makes the attempt assisted). */
  readonly tutorReplied?: boolean;
  /** Already recorded as assisted; a recorded true is never turned back into unaided. */
  readonly assisted?: boolean;
}

/**
 * Whether an attempt was assisted: hint level 3 or higher, any AI tutor reply, or recorded as
 * assisted. Hint levels outside 0–4 or not whole numbers are refused rather than guessed.
 */
export function isAssistedAttempt(facts: AssistanceFacts): boolean {
  const hint = facts.highestHintLevel ?? 0;
  if (!Number.isInteger(hint) || hint < 0 || hint > MAX_HINT_LEVEL) {
    throw new LearningModelError('hint level must be an integer from 0 to 4');
  }
  return hint >= ASSISTED_HINT_LEVEL || facts.tutorReplied === true || facts.assisted === true;
}

// ---------------------------------------------------------------------------
// Calendar days
// ---------------------------------------------------------------------------

function epochMs(timestamp: string | Date): number {
  const value = timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new LearningModelError('a timestamp is not a valid date');
  return value;
}

/** The calendar date, YYYY-MM-DD, of a moment in Asia/Kolkata. */
export function calendarDayInKolkata(timestamp: string | Date): string {
  return new Date(epochMs(timestamp) + KOLKATA_OFFSET_MS).toISOString().slice(0, 10);
}

/** How many different Asia/Kolkata calendar days the moments fall on. */
export function distinctCalendarDays(timestamps: readonly (string | Date)[]): number {
  return new Set(timestamps.map(calendarDayInKolkata)).size;
}

/**
 * C3's sufficiency rule: evidence is enough to show a band only when it spans at least two
 * calendar days. One attempt, or any number on the same day, is not enough.
 */
export function hasEnoughEvidence(attemptTimes: readonly (string | Date)[]): boolean {
  return distinctCalendarDays(attemptTimes) >= 2;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** One graded attempt on one skill, in the shape of a learning_attempt_events row. */
export interface SkillAttempt extends AssistanceFacts {
  /** Tie-break for attempts at the same instant, so the order is total. */
  readonly id: string;
  readonly itemId: string;
  readonly context: AttemptContext;
  readonly correct: boolean;
  readonly occurredAt: string;
}

/** The running state of the stage fold. Exposed so a projector can advance it one attempt at a time. */
export interface StageState {
  readonly algorithmId: LearningModelAlgorithmId;
  readonly stage: EvidenceStage;
  readonly attemptCount: number;
  readonly attemptDays: readonly string[];
  readonly unaidedSuccessCount: number;
  readonly assistedSuccessCount: number;
  readonly unaidedSuccessDays: readonly string[];
  readonly unaidedSuccessContexts: readonly AttemptContext[];
  readonly attemptedItemIds: readonly string[];
  /** occurredAt of the last attempt folded in; later attempts must not be earlier. */
  readonly lastOccurredAt: string | null;
}

export const initialStageState: StageState = Object.freeze({
  algorithmId: LEARNING_MODEL_ALGORITHM_ID,
  stage: 'ESTIMATED',
  attemptCount: 0,
  attemptDays: [],
  unaidedSuccessCount: 0,
  assistedSuccessCount: 0,
  unaidedSuccessDays: [],
  unaidedSuccessContexts: [],
  attemptedItemIds: [],
  lastOccurredAt: null,
});

function withSorted<T extends string>(values: readonly T[], value: T): readonly T[] {
  return values.includes(value) ? values : [...values, value].sort();
}

function assertAttempt(attempt: SkillAttempt): void {
  if (!attempt.id || !attempt.itemId) throw new LearningModelError('an attempt needs an id and an item id');
  if (!(attemptContexts as readonly string[]).includes(attempt.context)) throw new LearningModelError('an attempt context is not recognised');
  epochMs(attempt.occurredAt);
}

/**
 * Fold one attempt into the state. Attempts must arrive in time order. The stage moves forward
 * by at most one step per attempt and never moves back:
 *
 *  - ESTIMATED → RETAINED on the first unaided success;
 *  - RETAINED → DEMONSTRATED on an unaided success on a different calendar day from an earlier one;
 *  - DEMONSTRATED → TRANSFERRED on an unaided success on an item never attempted before, in a
 *    context with no earlier unaided success.
 *
 * Wrong answers and assisted successes are counted but never move the stage.
 */
export function advanceStage(state: StageState, attempt: SkillAttempt): StageState {
  assertAttempt(attempt);
  if (state.lastOccurredAt !== null && epochMs(attempt.occurredAt) < epochMs(state.lastOccurredAt)) {
    throw new LearningModelError('attempts must be folded in time order');
  }
  const day = calendarDayInKolkata(attempt.occurredAt);
  const assisted = isAssistedAttempt(attempt);
  const unaidedSuccess = attempt.correct && !assisted;
  const newItem = !state.attemptedItemIds.includes(attempt.itemId);

  let stage = state.stage;
  if (unaidedSuccess) {
    if (stage === 'ESTIMATED') {
      stage = 'RETAINED';
    } else if (stage === 'RETAINED' && state.unaidedSuccessDays.some((earlier) => earlier !== day)) {
      stage = 'DEMONSTRATED';
    } else if (stage === 'DEMONSTRATED' && newItem && !state.unaidedSuccessContexts.includes(attempt.context)) {
      stage = 'TRANSFERRED';
    }
  }

  return {
    algorithmId: LEARNING_MODEL_ALGORITHM_ID,
    stage,
    attemptCount: state.attemptCount + 1,
    attemptDays: withSorted(state.attemptDays, day),
    unaidedSuccessCount: state.unaidedSuccessCount + (unaidedSuccess ? 1 : 0),
    assistedSuccessCount: state.assistedSuccessCount + (attempt.correct && assisted ? 1 : 0),
    unaidedSuccessDays: unaidedSuccess ? withSorted(state.unaidedSuccessDays, day) : state.unaidedSuccessDays,
    unaidedSuccessContexts: unaidedSuccess ? withSorted(state.unaidedSuccessContexts, attempt.context) : state.unaidedSuccessContexts,
    attemptedItemIds: withSorted(state.attemptedItemIds, attempt.itemId),
    lastOccurredAt: attempt.occurredAt,
  };
}

/** Attempts in the one order the fold uses: by time, then id. Input order never matters. */
export function orderAttempts(attempts: readonly SkillAttempt[]): readonly SkillAttempt[] {
  return [...attempts].sort((left, right) => epochMs(left.occurredAt) - epochMs(right.occurredAt)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export interface SkillEvidenceSummary extends StageState {
  readonly sufficiency: EvidenceSufficiency;
  readonly band: SkillBand;
}

/** The band a skill shows, from its stage and whether its evidence is sufficient (C3). */
export function skillBand(state: Pick<StageState, 'stage' | 'attemptDays'>): SkillBand {
  if (state.attemptDays.length < 2) return 'NOT_ENOUGH_EVIDENCE';
  if (state.stage === 'DEMONSTRATED' || state.stage === 'TRANSFERRED') return 'DEMONSTRATED';
  return state.stage === 'RETAINED' ? 'PROGRESSING' : 'DEVELOPING';
}

/**
 * Everything learning-model-v1 says about one skill for one student, from that skill's graded
 * attempts. Lesson completions are not attempts and are never passed here.
 */
export function summariseSkillEvidence(attempts: readonly SkillAttempt[]): SkillEvidenceSummary {
  const state = orderAttempts(attempts).reduce(advanceStage, initialStageState);
  return {
    ...state,
    sufficiency: state.attemptDays.length >= 2 ? 'ENOUGH_EVIDENCE' : 'NOT_ENOUGH_EVIDENCE',
    band: skillBand(state),
  };
}

// ---------------------------------------------------------------------------
// The readiness-check outcome label
// ---------------------------------------------------------------------------

/**
 * The band label on a submitted readiness check (`outcomeBand`). Before ENG-04 it was the
 * attempt's ratio band even for a student's first attempt, which could read DEVELOPING from one
 * attempt (C3). It is now NOT_ENOUGH_EVIDENCE until the student's submitted checks span two
 * calendar days, and the unchanged ratio thresholds after that.
 */
export function attemptOutcomeBand(input: {
  readonly correct: number;
  readonly possible: number;
  /** submitted_at of every submitted check by this student, this one included. */
  readonly submittedAttemptTimes: readonly (string | Date)[];
}): SkillBand {
  if (!Number.isInteger(input.correct) || !Number.isInteger(input.possible) || input.possible <= 0
    || input.correct < 0 || input.correct > input.possible) {
    throw new LearningModelError('an attempt outcome needs 0 <= correct <= possible, possible > 0');
  }
  if (!hasEnoughEvidence(input.submittedAttemptTimes)) return 'NOT_ENOUGH_EVIDENCE';
  const ratio = input.correct / input.possible;
  return ratio >= 0.8 ? 'DEMONSTRATED' : ratio >= 0.6 ? 'PROGRESSING' : 'DEVELOPING';
}

// ---------------------------------------------------------------------------
// Required evidence types for career requirements
// ---------------------------------------------------------------------------

export interface TopicEvidenceFact {
  readonly id: string;
  readonly evidenceType: string;
  readonly topicId: string;
  readonly assisted: boolean;
  readonly supersedesEvidenceId?: string;
}

export interface RequiredEvidenceCheck {
  readonly algorithmId: LearningModelAlgorithmId;
  readonly topicId: string;
  readonly satisfied: boolean;
  readonly presentTypes: readonly RequirableEvidenceType[];
  readonly missingTypes: readonly RequirableEvidenceType[];
}

/** Normalise a requirement's list: known types only, no duplicates, stable order. */
export function normaliseRequiredEvidenceTypes(types: readonly string[]): readonly RequirableEvidenceType[] {
  for (const type of types) {
    if (!(requirableEvidenceTypes as readonly string[]).includes(type)) {
      throw new LearningModelError(`evidence type ${type} cannot be required`);
    }
  }
  return requirableEvidenceTypes.filter((type) => types.includes(type));
}

/**
 * Which of a requirement's required evidence types the student holds for its topic. Only
 * unaided evidence that nothing supersedes counts: assisted evidence never satisfies a
 * requirement. An empty list requires nothing and is always satisfied.
 */
export function checkRequiredEvidenceTypes(
  requirement: { readonly topicId: string; readonly requiredEvidenceTypes: readonly string[] },
  evidence: readonly TopicEvidenceFact[],
): RequiredEvidenceCheck {
  const required = normaliseRequiredEvidenceTypes(requirement.requiredEvidenceTypes);
  const superseded = new Set(evidence.flatMap((item) => (item.supersedesEvidenceId ? [item.supersedesEvidenceId] : [])));
  const held = new Set(evidence
    .filter((item) => item.topicId === requirement.topicId && !item.assisted && !superseded.has(item.id))
    .map((item) => item.evidenceType));
  const presentTypes = required.filter((type) => held.has(type));
  const missingTypes = required.filter((type) => !held.has(type));
  return { algorithmId: LEARNING_MODEL_ALGORITHM_ID, topicId: requirement.topicId,
    satisfied: missingTypes.length === 0, presentTypes, missingTypes };
}

// The learner skill state projection rule (ENG-05) builds on everything above.
export * from './skill-state.js';
