/**
 * The adaptive placement test (ENG-14), algorithm `placement-2pl-eap-v1`: estimate a student's
 * ability from their answers, choose the next question, decide when to stop, and turn the result
 * into a placement level.
 *
 * Why it exists: a new student should start the aptitude block at the level they are at, found
 * from as few questions as possible (C2: at most 25 questions and 25 minutes, and a retest agrees
 * within one level for at least 80% of simulated students). Design and reasoning:
 * docs/architecture/placement-tests-table-design.md.
 *
 * Pure and deterministic (ADR-034): no database, clock, randomness or network. Elapsed time arrives
 * as an argument; identical inputs give identical outputs. Changing a rule means a new algorithm ID.
 *
 * The ability estimate and its standard error are model state. They are returned to the caller for
 * the stop rule and the level, and nothing may store them, return them from an API or show them to
 * anyone as a number. Nothing here produces or influences readiness (ADR-020).
 */

export const PLACEMENT_ALGORITHM_ID = 'placement-2pl-eap-v1' as const;
export type PlacementAlgorithmId = typeof PLACEMENT_ALGORITHM_ID;

/** Areas of the aptitude block; the order is the tie-break for content balance. */
export const placementGroups = ['QUANTITATIVE', 'LOGICAL', 'VERBAL'] as const;
export type PlacementGroup = (typeof placementGroups)[number];

/** The skill map's four levels (OPS-09a, ENG-10), lowest first. */
export const placementLevels = ['AWARE', 'GUIDED', 'INDEPENDENT', 'TROUBLESHOOT'] as const;
export type PlacementLevel = (typeof placementLevels)[number];
export type PlacementResultLevel = PlacementLevel | 'NOT_ENOUGH_EVIDENCE';

export const placementStopReasons = ['TIME_LIMIT', 'MAX_ITEMS', 'CONFIDENT', 'POOL_EXHAUSTED'] as const;
export type PlacementStopReason = (typeof placementStopReasons)[number];

/** Every number the rule uses. Part of the algorithm ID: changing one is a new ID. */
export const PLACEMENT_RULES = Object.freeze({
  maxItems: 25,
  timeLimitMs: 25 * 60 * 1000,
  minItemsForConfidence: 8,
  targetStandardError: 0.3,
  /** Above this standard error the result is NOT_ENOUGH_EVIDENCE rather than a level. */
  maxStandardErrorForLevel: 0.5,
  /** θ below the first cut is AWARE, then GUIDED, INDEPENDENT, and TROUBLESHOOT from the last. */
  levelCuts: Object.freeze([-1, 0, 1] as const),
  /** A placement is offered only with at least this many eligible items. */
  minPoolSize: 25,
  gridMin: -4,
  gridMax: 4,
  gridStep: 0.05,
  /** The 0062 bounds; parameters outside them are refused, never clamped. */
  difficultyBounds: Object.freeze([-4, 4] as const),
  discriminationBounds: Object.freeze([0.2, 4] as const),
});

export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlacementError';
  }
}

/** One calibrated item: its 2PL parameters and its area. `key` identifies it (a question version id). */
export interface PlacementItem {
  readonly key: string;
  readonly group: PlacementGroup;
  readonly difficulty: number;
  readonly discrimination: number;
}

/** One answered question, with the parameters it was asked under. */
export interface PlacementAnswer {
  readonly item: PlacementItem;
  readonly correct: boolean;
}

export interface AbilityEstimate {
  /** Expected a posteriori ability. Model state: never stored or shown as a number. */
  readonly theta: number;
  /** Posterior standard deviation. Model state: never stored or shown as a number. */
  readonly standardError: number;
}

export type PlacementStep =
  | { readonly kind: 'ASK'; readonly item: PlacementItem; readonly estimate: AbilityEstimate }
  | {
      readonly kind: 'STOP';
      readonly reason: PlacementStopReason;
      readonly level: PlacementResultLevel;
      readonly itemsAnswered: number;
      readonly estimate: AbilityEstimate;
    };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertItem(item: PlacementItem): void {
  if (typeof item.key !== 'string' || item.key.length < 1 || item.key.length > 200) {
    throw new PlacementError('an item needs a key of 1 to 200 characters');
  }
  if (!(placementGroups as readonly string[]).includes(item.group)) throw new PlacementError('an item group is not recognised');
  const [bMin, bMax] = PLACEMENT_RULES.difficultyBounds;
  const [aMin, aMax] = PLACEMENT_RULES.discriminationBounds;
  if (!Number.isFinite(item.difficulty) || item.difficulty < bMin || item.difficulty > bMax) {
    throw new PlacementError('an item difficulty is outside the calibration bounds');
  }
  if (!Number.isFinite(item.discrimination) || item.discrimination < aMin || item.discrimination > aMax) {
    throw new PlacementError('an item discrimination is outside the calibration bounds');
  }
}

function assertAnswers(answers: readonly PlacementAnswer[]): void {
  const seen = new Set<string>();
  for (const answer of answers) {
    assertItem(answer.item);
    if (typeof answer.correct !== 'boolean') throw new PlacementError('an answer must be correct or not');
    if (seen.has(answer.item.key)) throw new PlacementError('an item was answered twice');
    seen.add(answer.item.key);
  }
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** 2PL probability of a correct answer at ability θ. */
export function probabilityCorrect(theta: number, item: Pick<PlacementItem, 'difficulty' | 'discrimination'>): number {
  return 1 / (1 + Math.exp(-item.discrimination * (theta - item.difficulty)));
}

/** Fisher information of a 2PL item at θ: a²·P·(1 − P). */
export function itemInformation(theta: number, item: Pick<PlacementItem, 'difficulty' | 'discrimination'>): number {
  const p = probabilityCorrect(theta, item);
  return item.discrimination * item.discrimination * p * (1 - p);
}

let cachedGrid: readonly number[] | null = null;
function grid(): readonly number[] {
  if (cachedGrid) return cachedGrid;
  const points: number[] = [];
  const steps = Math.round((PLACEMENT_RULES.gridMax - PLACEMENT_RULES.gridMin) / PLACEMENT_RULES.gridStep);
  for (let index = 0; index <= steps; index += 1) points.push(PLACEMENT_RULES.gridMin + index * PLACEMENT_RULES.gridStep);
  cachedGrid = Object.freeze(points);
  return cachedGrid;
}

/**
 * Expected a posteriori ability over a fixed grid with a standard-normal prior. Finite for every
 * answer pattern, including all right or all wrong. Order of answers does not matter.
 */
export function estimateAbility(answers: readonly PlacementAnswer[]): AbilityEstimate {
  assertAnswers(answers);
  const points = grid();
  const logPosterior = points.map((theta) => {
    let sum = -0.5 * theta * theta;
    for (const answer of answers) {
      const p = probabilityCorrect(theta, answer.item);
      sum += Math.log(answer.correct ? p : 1 - p);
    }
    return sum;
  });
  const peak = Math.max(...logPosterior);
  let mass = 0;
  let first = 0;
  let second = 0;
  for (let index = 0; index < points.length; index += 1) {
    const weight = Math.exp(logPosterior[index]! - peak);
    const theta = points[index]!;
    mass += weight;
    first += weight * theta;
    second += weight * theta * theta;
  }
  const theta = first / mass;
  const variance = Math.max(0, second / mass - theta * theta);
  return { theta, standardError: Math.sqrt(variance) };
}

/** The placement level for an estimate: a band, or NOT_ENOUGH_EVIDENCE while it is too uncertain. */
export function placementLevelFor(estimate: AbilityEstimate): PlacementResultLevel {
  if (!Number.isFinite(estimate.theta) || !Number.isFinite(estimate.standardError)) {
    throw new PlacementError('an ability estimate must be finite');
  }
  if (estimate.standardError > PLACEMENT_RULES.maxStandardErrorForLevel) return 'NOT_ENOUGH_EVIDENCE';
  const cuts = PLACEMENT_RULES.levelCuts;
  let index = 0;
  while (index < cuts.length && estimate.theta >= cuts[index]!) index += 1;
  return placementLevels[index]!;
}

/** Position of a level on the scale (AWARE 0 … TROUBLESHOOT 3); NOT_ENOUGH_EVIDENCE has none. */
export function placementLevelRank(level: PlacementResultLevel): number | null {
  const index = (placementLevels as readonly string[]).indexOf(level);
  return index < 0 ? null : index;
}

// ---------------------------------------------------------------------------
// Selection and stopping
// ---------------------------------------------------------------------------

/**
 * The next item: first the area with the fewest questions asked that still has items (ties in
 * `placementGroups` order), then within it the item with the greatest information at θ (ties by
 * key). Items already answered are never chosen. Null when nothing is left.
 */
export function selectNextItem(pool: readonly PlacementItem[], answers: readonly PlacementAnswer[], theta: number): PlacementItem | null {
  const asked = new Set(answers.map((answer) => answer.item.key));
  const remaining = pool.filter((item) => !asked.has(item.key));
  if (remaining.length === 0) return null;
  const askedPerGroup = new Map<PlacementGroup, number>(placementGroups.map((group) => [group, 0]));
  for (const answer of answers) askedPerGroup.set(answer.item.group, (askedPerGroup.get(answer.item.group) ?? 0) + 1);
  const available = placementGroups.filter((group) => remaining.some((item) => item.group === group));
  let group = available[0]!;
  for (const candidate of available) {
    if ((askedPerGroup.get(candidate) ?? 0) < (askedPerGroup.get(group) ?? 0)) group = candidate;
  }
  let best: PlacementItem | null = null;
  let bestInformation = -1;
  for (const item of remaining) {
    if (item.group !== group) continue;
    const information = itemInformation(theta, item);
    if (information > bestInformation || (information === bestInformation && best !== null && item.key < best.key)) {
      best = item;
      bestInformation = information;
    }
  }
  return best;
}

/**
 * One step of the test: stop (with the reason and level) or ask the next item.
 *
 * Stop rules, in order: 25 minutes elapsed; 25 questions answered; at least 8 answered with a
 * standard error of 0.30 or less; nothing left to ask.
 *
 * @param pool      the eligible items, each with the parameters it would be asked under
 * @param answers   the questions answered so far in this sitting, with the parameters they were asked under
 * @param elapsedMs time since the sitting started
 */
export function nextPlacementStep(input: {
  readonly pool: readonly PlacementItem[];
  readonly answers: readonly PlacementAnswer[];
  readonly elapsedMs: number;
}): PlacementStep {
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) throw new PlacementError('elapsed time must be a non-negative number');
  const keys = new Set<string>();
  for (const item of input.pool) {
    assertItem(item);
    if (keys.has(item.key)) throw new PlacementError('an item appears twice in the pool');
    keys.add(item.key);
  }
  if (input.answers.length > PLACEMENT_RULES.maxItems) throw new PlacementError('a placement has at most 25 answers');
  const estimate = estimateAbility(input.answers);
  const stop = (reason: PlacementStopReason): PlacementStep => ({
    kind: 'STOP', reason, level: placementLevelFor(estimate), itemsAnswered: input.answers.length, estimate,
  });
  if (input.elapsedMs >= PLACEMENT_RULES.timeLimitMs) return stop('TIME_LIMIT');
  if (input.answers.length >= PLACEMENT_RULES.maxItems) return stop('MAX_ITEMS');
  if (input.answers.length >= PLACEMENT_RULES.minItemsForConfidence && estimate.standardError <= PLACEMENT_RULES.targetStandardError) {
    return stop('CONFIDENT');
  }
  const item = selectNextItem(input.pool, input.answers, estimate.theta);
  if (!item) return stop('POOL_EXHAUSTED');
  return { kind: 'ASK', item, estimate };
}

/** The group of an aptitude skill key (`apt-q-…`, `apt-l-…`, `apt-v-…`, ENG-10), or null for any other key. */
export function placementGroupOfSkillKey(stableKey: string): PlacementGroup | null {
  const match = /^apt-([qlv])-/.exec(stableKey);
  if (!match) return null;
  return match[1] === 'q' ? 'QUANTITATIVE' : match[1] === 'l' ? 'LOGICAL' : 'VERBAL';
}

/**
 * The items a retest draws from: those not answered in an earlier placement, when at least
 * `minPoolSize` of them remain; otherwise the whole pool (a small bank still gives a test).
 */
export function retestPool(pool: readonly PlacementItem[], answeredBefore: ReadonlySet<string>): readonly PlacementItem[] {
  const unseen = pool.filter((item) => !answeredBefore.has(item.key));
  return unseen.length >= PLACEMENT_RULES.minPoolSize ? unseen : pool;
}
