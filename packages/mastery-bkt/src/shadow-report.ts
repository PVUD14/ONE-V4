/**
 * The BKT shadow report's aggregation (ENG-06): how many students' topic bands WOULD change under
 * C3 adoption and under BKT, compared with the live `career-readiness-mastery-v1` band, and how
 * well BKT predicts the next attempt.
 *
 * Why it exists: ENG-04 left C3 adoption, and ENG-27 (HG-5) leaves replacing v1, waiting on exactly
 * these counts. The aggregation is pure so the disclosure rules can be tested without a database:
 * counts only, every count from 1 to 4 printed as "<5", rates only over five or more students, and
 * no identifier of any kind in the output. The persistence side only gathers rows and calls this.
 * Design: docs/architecture/mastery-bkt-shadow-design.md ("The shadow report").
 */
import {
  BKT_SHADOW_BAND_THRESHOLDS,
  DEFAULT_BKT_PARAMETERS,
  MASTERY_BKT_ALGORITHM_ID,
  type ShadowBand,
} from './index.js';

export const BKT_SHADOW_REPORT_VERSION = 'bkt-shadow-report-v1' as const;
export const SUPPRESSION_THRESHOLD = 5;

const BANDS: readonly ShadowBand[] = ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'DEMONSTRATED'];
/** Order among measured bands; NOT_ENOUGH_EVIDENCE is not on the scale. */
const MEASURED_RANK: Readonly<Record<ShadowBand, number | null>> = {
  NOT_ENOUGH_EVIDENCE: null, DEVELOPING: 0, PROGRESSING: 1, DEMONSTRATED: 2,
};

export type ReportCount = number | '<5';

/** 0 and 5+ print exactly; 1–4 print as "<5". */
export function suppressCount(count: number): ReportCount {
  if (!Number.isInteger(count) || count < 0) throw new Error('a count must be a whole number');
  return count > 0 && count < SUPPRESSION_THRESHOLD ? '<5' : count;
}

/** One (student, topic) pair. `subjectKey` is used only to count distinct students; it never leaves. */
export interface ShadowPair {
  readonly subjectKey: string;
  /** Latest live mastery_projections band; null when the student has none for the topic. */
  readonly liveBand: ShadowBand | null;
  /** learning-model-v1's band from learner_skill_state; null when there is no engine row. */
  readonly engineBand: ShadowBand | null;
  /** The band BKT would give; null when there is no engine row or the row predates BKT. */
  readonly bktBand: ShadowBand | null;
  /** The engine row was written by an older projector and carries no BKT estimate yet. */
  readonly staleProjector: boolean;
}

export interface ShadowPrediction {
  readonly subjectKey: string;
  readonly predicted: number;
  readonly correct: boolean;
}

export interface ShadowReportInput {
  readonly studentsInScope: number;
  readonly pairs: readonly ShadowPair[];
  readonly predictions: readonly ShadowPrediction[];
  /** The algorithm IDs in force, so the report says what it compared. */
  readonly projectorAlgorithm: string;
  readonly liveAlgorithm: string;
  readonly engineBandAlgorithm: string;
}

export interface BandComparison {
  readonly pairsCompared: ReportCount;
  readonly unchanged: ReportCount;
  readonly changed: ReportCount;
  readonly movedUp: ReportCount;
  readonly movedDown: ReportCount;
  readonly becameNotEnoughEvidence: ReportCount;
  readonly leftNotEnoughEvidence: ReportCount;
  readonly studentsWithAnyChange: ReportCount;
  /** Keyed "LIVE_BAND->OTHER_BAND"; every one of the sixteen cells is present. */
  readonly matrix: Readonly<Record<string, ReportCount>>;
}

export interface CalibrationBin {
  readonly range: string;
  readonly predictions: ReportCount;
  readonly observedCorrect: ReportCount;
  readonly observedRate: number | 'suppressed';
}

export interface PredictionSummary {
  readonly predictions: ReportCount;
  readonly students: ReportCount;
  readonly brierScore: number | 'suppressed';
  readonly accuracyAtHalf: number | 'suppressed';
  readonly calibration: readonly CalibrationBin[];
}

export interface ShadowReport {
  readonly reportVersion: typeof BKT_SHADOW_REPORT_VERSION;
  readonly algorithms: {
    readonly live: string;
    readonly engineBand: string;
    readonly projector: string;
    readonly shadow: typeof MASTERY_BKT_ALGORITHM_ID;
  };
  readonly parameters: {
    readonly pInit: number;
    readonly pLearn: number;
    readonly pGuess: number;
    readonly pSlip: number;
    readonly source: string;
  };
  readonly bandThresholds: { readonly demonstrated: number; readonly progressing: number };
  readonly suppressionThreshold: number;
  /** True when fewer than five consenting students are in scope: nothing below the header is printed. */
  readonly suppressed: boolean;
  readonly coverage?: {
    readonly studentsInScope: ReportCount;
    readonly pairsWithBothBands: ReportCount;
    readonly livePairsWithoutEngineRow: ReportCount;
    readonly engineRowsWithoutLiveBand: ReportCount;
    readonly engineRowsOnOlderProjector: ReportCount;
  };
  readonly c3Adoption?: BandComparison;
  readonly bkt?: BandComparison;
  readonly nextAttemptPrediction?: PredictionSummary;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function compareBands(pairs: readonly { subjectKey: string; from: ShadowBand; to: ShadowBand }[]): BandComparison {
  const matrix = new Map<string, number>();
  for (const from of BANDS) for (const to of BANDS) matrix.set(`${from}->${to}`, 0);
  let movedUp = 0;
  let movedDown = 0;
  let became = 0;
  let left = 0;
  const changedStudents = new Set<string>();
  for (const { subjectKey, from, to } of pairs) {
    matrix.set(`${from}->${to}`, matrix.get(`${from}->${to}`)! + 1);
    if (from === to) continue;
    changedStudents.add(subjectKey);
    const fromRank = MEASURED_RANK[from];
    const toRank = MEASURED_RANK[to];
    if (fromRank === null) left += 1;
    else if (toRank === null) became += 1;
    else if (toRank > fromRank) movedUp += 1;
    else movedDown += 1;
  }
  const changed = movedUp + movedDown + became + left;
  return {
    pairsCompared: suppressCount(pairs.length),
    unchanged: suppressCount(pairs.length - changed),
    changed: suppressCount(changed),
    movedUp: suppressCount(movedUp),
    movedDown: suppressCount(movedDown),
    becameNotEnoughEvidence: suppressCount(became),
    leftNotEnoughEvidence: suppressCount(left),
    studentsWithAnyChange: suppressCount(changedStudents.size),
    matrix: Object.fromEntries([...matrix].map(([key, count]) => [key, suppressCount(count)])),
  };
}

function summarisePredictions(predictions: readonly ShadowPrediction[]): PredictionSummary {
  for (const prediction of predictions) {
    if (!Number.isFinite(prediction.predicted) || prediction.predicted < 0 || prediction.predicted > 1) {
      throw new Error('a prediction must be a probability');
    }
  }
  const students = new Set(predictions.map((prediction) => prediction.subjectKey)).size;
  const rateAllowed = students >= SUPPRESSION_THRESHOLD && predictions.length >= SUPPRESSION_THRESHOLD;
  const brier = predictions.reduce((sum, p) => sum + (p.predicted - (p.correct ? 1 : 0)) ** 2, 0) / Math.max(predictions.length, 1);
  const hits = predictions.filter((p) => (p.predicted >= 0.5) === p.correct).length;
  const calibration: CalibrationBin[] = [0, 1, 2, 3, 4].map((bin) => {
    const low = bin / 5;
    const high = (bin + 1) / 5;
    const inBin = predictions.filter((p) => p.predicted >= low && (bin === 4 ? p.predicted <= high : p.predicted < high));
    const correct = inBin.filter((p) => p.correct).length;
    const binStudents = new Set(inBin.map((p) => p.subjectKey)).size;
    return {
      range: `${low.toFixed(1)}-${high.toFixed(1)}`,
      predictions: suppressCount(inBin.length),
      observedCorrect: suppressCount(correct),
      observedRate: inBin.length >= SUPPRESSION_THRESHOLD && binStudents >= SUPPRESSION_THRESHOLD ? round4(correct / inBin.length) : 'suppressed',
    };
  });
  return {
    predictions: suppressCount(predictions.length),
    students: suppressCount(students),
    brierScore: rateAllowed ? round4(brier) : 'suppressed',
    accuracyAtHalf: rateAllowed ? round4(hits / predictions.length) : 'suppressed',
    calibration,
  };
}

/** Build the report. Pure; the output carries no identifier of any student, topic or institution. */
export function buildShadowReport(input: ShadowReportInput): ShadowReport {
  if (!Number.isInteger(input.studentsInScope) || input.studentsInScope < 0) throw new Error('students in scope must be a whole number');
  const header = {
    reportVersion: BKT_SHADOW_REPORT_VERSION,
    algorithms: {
      live: input.liveAlgorithm,
      engineBand: input.engineBandAlgorithm,
      projector: input.projectorAlgorithm,
      shadow: MASTERY_BKT_ALGORITHM_ID,
    },
    parameters: {
      pInit: DEFAULT_BKT_PARAMETERS.pInit,
      pLearn: DEFAULT_BKT_PARAMETERS.pLearn,
      pGuess: DEFAULT_BKT_PARAMETERS.pGuess,
      pSlip: DEFAULT_BKT_PARAMETERS.pSlip,
      source: DEFAULT_BKT_PARAMETERS.source,
    },
    bandThresholds: { ...BKT_SHADOW_BAND_THRESHOLDS },
    suppressionThreshold: SUPPRESSION_THRESHOLD,
  } as const;
  if (input.studentsInScope < SUPPRESSION_THRESHOLD) return { ...header, suppressed: true };

  const both = input.pairs.filter((pair) => pair.liveBand !== null && pair.engineBand !== null);
  const c3 = both.map((pair) => ({ subjectKey: pair.subjectKey, from: pair.liveBand!, to: pair.engineBand! }));
  const bkt = both.filter((pair) => pair.bktBand !== null)
    .map((pair) => ({ subjectKey: pair.subjectKey, from: pair.liveBand!, to: pair.bktBand! }));
  return {
    ...header,
    suppressed: false,
    coverage: {
      studentsInScope: suppressCount(input.studentsInScope),
      pairsWithBothBands: suppressCount(both.length),
      livePairsWithoutEngineRow: suppressCount(input.pairs.filter((pair) => pair.liveBand !== null && pair.engineBand === null).length),
      engineRowsWithoutLiveBand: suppressCount(input.pairs.filter((pair) => pair.liveBand === null && pair.engineBand !== null).length),
      engineRowsOnOlderProjector: suppressCount(input.pairs.filter((pair) => pair.engineBand !== null && pair.staleProjector).length),
    },
    c3Adoption: compareBands(c3),
    bkt: compareBands(bkt),
    nextAttemptPrediction: summarisePredictions(input.predictions),
  };
}
