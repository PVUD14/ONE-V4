/**
 * Bayesian Knowledge Tracing (ENG-06), algorithm `mastery-bkt-v1`, run in shadow.
 *
 * Why it exists: the engine's replacement for `career-readiness-mastery-v1` is BKT, but switching
 * real students to it is hard gate HG-5 (ENG-27). Until then BKT runs beside v1 on the same facts,
 * its estimate is stored only as model state in `learner_skill_state`, and an offline report
 * compares the two. Design, cited parameters and reasoning: docs/architecture/mastery-bkt-shadow-design.md.
 *
 * Pure and deterministic (ADR-034): no database, clock, randomness or network. The package knows
 * nothing about attempts, hints or days — it folds an ordered list of binary observations; which
 * attempts are observations is decided in packages/learning-model. Changing the update rule, the
 * default parameters or the rounding is a new algorithm ID, never an edit.
 *
 * Nothing here is readiness (ADR-020). A likelihood is model state; it is never shown as a number,
 * never reaches an employer and never feeds the readiness path.
 */

export const MASTERY_BKT_ALGORITHM_ID = 'mastery-bkt-v1' as const;
export type MasteryBktAlgorithmId = typeof MASTERY_BKT_ALGORITHM_ID;

export class MasteryBktError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasteryBktError';
  }
}

/** The four BKT parameters, with where they came from. */
export interface BktParameters {
  /** P(L0): known before any opportunity. */
  readonly pInit: number;
  /** P(T): learned at an opportunity. */
  readonly pLearn: number;
  /** P(G): correct without knowing. */
  readonly pGuess: number;
  /** P(S): wrong despite knowing. */
  readonly pSlip: number;
  /** Defaults are provisional until ENG-26 fits per-skill parameters from data. */
  readonly source: 'DEFAULT_PROVISIONAL' | 'FITTED';
  /** The fit run that produced a FITTED set; absent for the defaults. */
  readonly fitRunId?: string;
}

/**
 * Provisional defaults: the worked parameter set of Van de Sande (2013), Journal of Educational
 * Data Mining 5(2), Fig. 3 — P(S)=0.05, P(G)=0.3, P(T)=0.1, P(L0)=0.36. Guess sits at, and slip
 * under, the ceilings of Corbett & Anderson (1995). Not fitted to ONE's students; see the design.
 */
export const DEFAULT_BKT_PARAMETERS: BktParameters = Object.freeze({
  pInit: 0.36,
  pLearn: 0.1,
  pGuess: 0.3,
  pSlip: 0.05,
  source: 'DEFAULT_PROVISIONAL',
});

/**
 * Shadow band cut-offs. 0.95 is the Cognitive Tutor mastery criterion (Corbett & Anderson 1995);
 * 0.5 is "more likely known than not". Provisional, report-only: HG-5 decides any real mapping.
 */
export const BKT_SHADOW_BAND_THRESHOLDS = Object.freeze({ demonstrated: 0.95, progressing: 0.5 });

const FIT_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function openUnit(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 1;
}

/**
 * The stable fixed point of a run of wrong answers, (1 − G)T / (1 − G − S)
 * (Van de Sande 2013, eq. 14). A prior above it means every wrong answer lowers mastery.
 */
export function wrongAnswerFixedPoint(parameters: BktParameters): number {
  const { pGuess: g, pSlip: s, pLearn: t } = parameters;
  return ((1 - g) * t) / (1 - g - s);
}

/**
 * Refuse a parameter set that would make BKT behave nonsensically (design: "Admissibility").
 * Applies to the defaults and to any fitted set alike.
 */
export function validateParameters(parameters: BktParameters): void {
  const { pInit, pLearn, pGuess, pSlip } = parameters;
  if (![pInit, pLearn, pGuess, pSlip].every(openUnit)) throw new MasteryBktError('every BKT parameter must lie strictly between 0 and 1');
  if (pGuess >= 0.5 || pSlip >= 0.5) throw new MasteryBktError('guess and slip must each be below 0.5');
  if (pGuess + pSlip >= 1) throw new MasteryBktError('guess plus slip must be below 1, or a correct answer would lower mastery');
  if (pLearn >= 1 - pSlip / (1 - pGuess)) throw new MasteryBktError('the learn rate is too high to keep estimates within bounds');
  if (pInit <= wrongAnswerFixedPoint(parameters)) {
    throw new MasteryBktError('the prior must lie above the wrong-answer fixed point, or a wrong answer could raise mastery');
  }
  if (parameters.source === 'FITTED') {
    if (!parameters.fitRunId || !FIT_RUN_ID.test(parameters.fitRunId)) throw new MasteryBktError('a fitted parameter set must name its fit run');
  } else if (parameters.source === 'DEFAULT_PROVISIONAL') {
    if (parameters.fitRunId !== undefined) throw new MasteryBktError('default parameters have no fit run');
  } else {
    throw new MasteryBktError('unknown parameter source');
  }
}

/** The version stamped beside a stored value: which rule and which parameters produced it. */
export function masteryAlgorithmVersion(parameters: BktParameters): string {
  validateParameters(parameters);
  return parameters.source === 'FITTED' ? `${MASTERY_BKT_ALGORITHM_ID}+fit:${parameters.fitRunId}` : MASTERY_BKT_ALGORITHM_ID;
}

/** A skill's fitted set when one exists (validated), else the defaults. Nothing supplies fits yet. */
export function resolveParameters(skillId: string, fitted?: ReadonlyMap<string, BktParameters>): BktParameters {
  const chosen = fitted?.get(skillId);
  if (!chosen) return DEFAULT_BKT_PARAMETERS;
  if (chosen.source !== 'FITTED') throw new MasteryBktError('a per-skill override must come from a fit');
  validateParameters(chosen);
  return chosen;
}

function assertProbability(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new MasteryBktError('a probability must lie within [0, 1]');
}

/** P(correct) at the next opportunity, given P(L). */
export function predictCorrect(pKnown: number, parameters: BktParameters): number {
  assertProbability(pKnown);
  return pKnown * (1 - parameters.pSlip) + (1 - pKnown) * parameters.pGuess;
}

/** The evidence step: P(L | observation). */
export function posteriorKnown(pKnown: number, correct: boolean, parameters: BktParameters): number {
  assertProbability(pKnown);
  const { pGuess: g, pSlip: s } = parameters;
  const known = pKnown * (correct ? 1 - s : s);
  const unknown = (1 - pKnown) * (correct ? g : 1 - g);
  return known / (known + unknown);
}

/** The learning step: P(L') = P(L) + (1 − P(L))T. */
export function applyLearning(pKnown: number, parameters: BktParameters): number {
  assertProbability(pKnown);
  return pKnown + (1 - pKnown) * parameters.pLearn;
}

/** One full knowledge-tracing step: evidence, then learning. */
export function updateKnown(pKnown: number, correct: boolean, parameters: BktParameters): number {
  return applyLearning(posteriorKnown(pKnown, correct, parameters), parameters);
}

export interface BktPrediction {
  /** P(correct) the model gave before it saw this observation. */
  readonly predicted: number;
  readonly correct: boolean;
}

export interface BktTrace {
  readonly observations: number;
  /** One per observation after the first, made before that observation was seen. */
  readonly predictions: readonly BktPrediction[];
  /** P(L) after every step, unrounded; empty when there are no observations. */
  readonly path: readonly number[];
}

/**
 * Fold an ordered list of observations (true = correct). The first observation has no prediction
 * recorded: it is scored against the prior only, which says nothing about the student.
 */
export function traceMastery(observations: readonly boolean[], parameters: BktParameters = DEFAULT_BKT_PARAMETERS): BktTrace {
  validateParameters(parameters);
  let pKnown = parameters.pInit;
  const predictions: BktPrediction[] = [];
  const path: number[] = [];
  observations.forEach((correct, index) => {
    if (typeof correct !== 'boolean') throw new MasteryBktError('an observation must be correct or wrong');
    if (index > 0) predictions.push({ predicted: predictCorrect(pKnown, parameters), correct });
    pKnown = updateKnown(pKnown, correct, parameters);
    path.push(pKnown);
  });
  return { observations: observations.length, predictions, path };
}

/** Round half away from zero to four decimals: what numeric(5,4) stores, so a rebuild matches exactly. */
export function roundToStored(value: number): number {
  assertProbability(value);
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Binary entropy of P(L) in bits: how undecided the model is between known and not known. */
export function binaryEntropy(pKnown: number): number {
  assertProbability(pKnown);
  if (pKnown === 0 || pKnown === 1) return 0;
  return -(pKnown * Math.log2(pKnown) + (1 - pKnown) * Math.log2(1 - pKnown));
}

export interface MasteryEstimate {
  /** Rounded to four decimals. Model state, never a score. */
  readonly likelihood: number;
  /** Rounded to four decimals. */
  readonly uncertainty: number;
  readonly algorithmVersion: string;
}

/** The stored estimate for a skill, or null when nothing has been observed (a prior is not a measurement). */
export function estimateMastery(observations: readonly boolean[], parameters: BktParameters = DEFAULT_BKT_PARAMETERS): MasteryEstimate | null {
  const trace = traceMastery(observations, parameters);
  const last = trace.path[trace.path.length - 1];
  if (last === undefined) return null;
  return {
    likelihood: roundToStored(last),
    uncertainty: roundToStored(binaryEntropy(last)),
    algorithmVersion: masteryAlgorithmVersion(parameters),
  };
}

export type ShadowBand = 'NOT_ENOUGH_EVIDENCE' | 'DEVELOPING' | 'PROGRESSING' | 'DEMONSTRATED';

/**
 * The band BKT *would* give, for the shadow report only — never stored, never shown. C3 applies:
 * fewer than two attempt days, or no estimate, is not enough evidence.
 */
export function shadowBand(likelihood: number | null, attemptDayCount: number): ShadowBand {
  if (!Number.isInteger(attemptDayCount) || attemptDayCount < 0) throw new MasteryBktError('attempt day count must be a whole number');
  if (likelihood === null || attemptDayCount < 2) return 'NOT_ENOUGH_EVIDENCE';
  assertProbability(likelihood);
  if (likelihood >= BKT_SHADOW_BAND_THRESHOLDS.demonstrated) return 'DEMONSTRATED';
  if (likelihood >= BKT_SHADOW_BAND_THRESHOLDS.progressing) return 'PROGRESSING';
  return 'DEVELOPING';
}

export * from './shadow-report.js';
