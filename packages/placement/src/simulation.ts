/**
 * Simulation harness for the placement test (ENG-14, acceptance C2): synthetic learners sit the
 * test twice against a synthetic calibrated item pool, and the report says how long the test ran
 * and how often the two placements agree.
 *
 * Why it exists: no aptitude item is published yet (ENG-10's bank is DRAFT), so C2 can only be shown
 * in simulation. Everything here is synthetic and seeded — no person, no real item, nothing that
 * reaches a screen — and a given seed always gives the same report.
 *
 * Each learner has a true ability θ ~ N(0, 1) and answers each question correctly with the true 2PL
 * probability. The test itself sees only the parameters of the scenario (true, noisy, or
 * provisional), as the online path sees only what calibration stored. Response times are log-normal
 * (median 40 s); an answer that would land after the 25-minute limit is not taken, exactly as the
 * online path refuses to grade it. The retest leaves out the first sitting's items when enough remain.
 */
import {
  PLACEMENT_RULES,
  nextPlacementStep,
  placementGroups,
  placementLevelFor,
  placementLevelRank,
  probabilityCorrect,
  retestPool,
  type PlacementAnswer,
  type PlacementItem,
  type PlacementResultLevel,
  type PlacementStopReason,
} from './index.js';

/** Mulberry32: small, seeded, deterministic. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A standard-normal draw (Box–Muller) from a seeded uniform source. */
export function standardNormal(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * A synthetic pool shaped like ENG-10's bank: `size` items spread evenly over the three areas,
 * difficulty uniform on [−2.5, 2.5], discrimination uniform on [0.7, 2.0].
 */
export function syntheticPool(size: number, seed: number): PlacementItem[] {
  const random = seededRandom(seed);
  return Array.from({ length: size }, (_, index) => ({
    key: `synthetic-item-${String(index + 1).padStart(4, '0')}`,
    group: placementGroups[index % placementGroups.length]!,
    difficulty: Number((-2.5 + 5 * random()).toFixed(4)),
    discrimination: Number((0.7 + 1.3 * random()).toFixed(4)),
  }));
}

export type CalibrationScenario = 'TRUE_PARAMETERS' | 'NOISY_CALIBRATION' | 'PROVISIONAL_ONLY';

/**
 * What the test is told about each item. NOISY_CALIBRATION adds estimation error like a real
 * 2PL fit (difficulty ± N(0, 0.25), discrimination × e^N(0, 0.15)); PROVISIONAL_ONLY is ENG-13's
 * provisional row — discrimination 1.0 and a noisy difficulty.
 */
export function calibratedView(truth: readonly PlacementItem[], scenario: CalibrationScenario, seed: number): PlacementItem[] {
  if (scenario === 'TRUE_PARAMETERS') return truth.map((item) => ({ ...item }));
  const random = seededRandom(seed);
  return truth.map((item) => {
    const difficulty = clamp(item.difficulty + 0.25 * standardNormal(random), -4, 4);
    const discrimination = scenario === 'PROVISIONAL_ONLY' ? 1 : clamp(item.discrimination * Math.exp(0.15 * standardNormal(random)), 0.2, 4);
    return { ...item, difficulty: Number(difficulty.toFixed(4)), discrimination: Number(discrimination.toFixed(4)) };
  });
}

export interface SittingResult {
  readonly itemKeys: readonly string[];
  readonly itemsAnswered: number;
  readonly durationMs: number;
  readonly reason: PlacementStopReason;
  readonly level: PlacementResultLevel;
  /** Harness-only model state, for the recovery figures in the report. */
  readonly theta: number;
}

/** One learner's sitting. `truth` answers the questions; `pool` is what the test is told. */
export function simulateSitting(input: {
  readonly trueTheta: number;
  readonly pool: readonly PlacementItem[];
  readonly truth: ReadonlyMap<string, PlacementItem>;
  readonly random: () => number;
  /** Median response time; 40 s unless a scenario models slower students. */
  readonly medianResponseMs?: number;
}): SittingResult {
  const medianResponseMs = input.medianResponseMs ?? 40_000;
  const answers: PlacementAnswer[] = [];
  let elapsedMs = 0;
  for (;;) {
    const step = nextPlacementStep({ pool: input.pool, answers, elapsedMs });
    if (step.kind === 'STOP') {
      return {
        itemKeys: answers.map((answer) => answer.item.key), itemsAnswered: answers.length,
        durationMs: elapsedMs, reason: step.reason, level: step.level, theta: step.estimate.theta,
      };
    }
    const actual = input.truth.get(step.item.key);
    if (!actual) throw new Error('a pool item has no true parameters');
    const correct = input.random() < probabilityCorrect(input.trueTheta, actual);
    const responseMs = Math.min(180_000, Math.round(medianResponseMs * Math.exp(0.45 * standardNormal(input.random))));
    if (elapsedMs + responseMs >= PLACEMENT_RULES.timeLimitMs) {
      // The answer would arrive after the deadline: not graded, and the test ends at the limit.
      elapsedMs = PLACEMENT_RULES.timeLimitMs;
      continue;
    }
    elapsedMs += responseMs;
    answers.push({ item: step.item, correct });
  }
}

export interface SimulationReport {
  readonly scenario: CalibrationScenario;
  readonly learners: number;
  readonly poolSize: number;
  readonly seed: number;
  readonly medianResponseSeconds: number;
  readonly maxItems: number;
  readonly meanItems: number;
  readonly maxDurationMinutes: number;
  readonly meanDurationMinutes: number;
  readonly stopReasons: Readonly<Record<PlacementStopReason, number>>;
  readonly notEnoughEvidence: number;
  /** Share of learners whose two placements are the same level. */
  readonly exactAgreement: number;
  /** Share of learners whose two placements are levels at most one apart (C2 asks ≥ 0.8). */
  readonly withinOneAgreement: number;
  /** Share of learners whose first placement is their true level (from the true θ). */
  readonly trueLevelAgreement: number;
  /** Root-mean-square error of the first sitting's estimate against the true θ (harness only). */
  readonly abilityRmse: number;
  /** Share of retests that saw none of the first sitting's items. */
  readonly retestWithoutRepeats: number;
}

/** Runs `learners` synthetic learners through a test and a retest and summarises C2. */
export function runPlacementSimulation(input: {
  readonly learners: number;
  readonly poolSize: number;
  readonly seed: number;
  readonly scenario: CalibrationScenario;
  readonly medianResponseMs?: number;
}): SimulationReport {
  const medianResponseMs = input.medianResponseMs ?? 40_000;
  const truthItems = syntheticPool(input.poolSize, input.seed);
  const truth = new Map(truthItems.map((item) => [item.key, item]));
  const pool = calibratedView(truthItems, input.scenario, input.seed + 1);
  const random = seededRandom(input.seed + 2);
  const stopReasons: Record<PlacementStopReason, number> = { TIME_LIMIT: 0, MAX_ITEMS: 0, CONFIDENT: 0, POOL_EXHAUSTED: 0 };
  let maxItems = 0;
  let totalItems = 0;
  let maxDurationMs = 0;
  let totalDurationMs = 0;
  let exact = 0;
  let withinOne = 0;
  let trueLevel = 0;
  let squaredError = 0;
  let notEnoughEvidence = 0;
  let withoutRepeats = 0;
  const sittings = input.learners * 2;
  for (let learner = 0; learner < input.learners; learner += 1) {
    const trueTheta = standardNormal(random);
    const first = simulateSitting({ trueTheta, pool, truth, random, medianResponseMs });
    const seen = new Set(first.itemKeys);
    const second = simulateSitting({ trueTheta, pool: retestPool(pool, seen), truth, random, medianResponseMs });
    for (const sitting of [first, second]) {
      stopReasons[sitting.reason] += 1;
      maxItems = Math.max(maxItems, sitting.itemsAnswered);
      totalItems += sitting.itemsAnswered;
      maxDurationMs = Math.max(maxDurationMs, sitting.durationMs);
      totalDurationMs += sitting.durationMs;
      if (sitting.level === 'NOT_ENOUGH_EVIDENCE') notEnoughEvidence += 1;
    }
    if (!second.itemKeys.some((key) => seen.has(key))) withoutRepeats += 1;
    const firstRank = placementLevelRank(first.level);
    const secondRank = placementLevelRank(second.level);
    // NOT_ENOUGH_EVIDENCE agrees with nothing: counted as a disagreement, the conservative reading.
    if (firstRank !== null && secondRank !== null) {
      if (firstRank === secondRank) exact += 1;
      if (Math.abs(firstRank - secondRank) <= 1) withinOne += 1;
    }
    if (first.level === placementLevelFor({ theta: trueTheta, standardError: 0 })) trueLevel += 1;
    squaredError += (first.theta - trueTheta) ** 2;
  }
  const round = (value: number, places = 4): number => Number(value.toFixed(places));
  return {
    scenario: input.scenario,
    learners: input.learners,
    poolSize: input.poolSize,
    seed: input.seed,
    medianResponseSeconds: medianResponseMs / 1000,
    maxItems,
    meanItems: round(totalItems / sittings, 2),
    maxDurationMinutes: round(maxDurationMs / 60_000, 2),
    meanDurationMinutes: round(totalDurationMs / sittings / 60_000, 2),
    stopReasons,
    notEnoughEvidence,
    exactAgreement: round(exact / input.learners),
    withinOneAgreement: round(withinOne / input.learners),
    trueLevelAgreement: round(trueLevel / input.learners),
    abilityRmse: round(Math.sqrt(squaredError / input.learners)),
    retestWithoutRepeats: round(withoutRepeats / input.learners),
  };
}
