/**
 * Adaptive engine health panels (OPS-13): the bounded, read-only queries behind the four operator
 * panels — planner decisions per day and override rate (learning_decisions), the mastery shadow
 * comparison (learner_skill_state against mastery_projections, adaptive-learning holders only), the
 * last calibration run and its status (item_calibration_runs, item_calibrations), and the code
 * sandbox (no source yet: NA).
 *
 * Why it exists: operators must see whether the learning engine is behaving without running the
 * offline commands or opening a database. Nothing here writes, calls a model or reads readiness
 * beyond the live mastery bands the ENG-06 report already compares. No identifier of a student,
 * topic, institution, item or run leaves this module; every count of people passes the one
 * suppression rule (packages/authorization/src/engine-health.ts) before it is returned.
 * Design: docs/architecture/engine-health-panels-design.md
 */
import { sql } from 'drizzle-orm';
import {
  calibrationExpectedIntervalDays,
  calibrationHealthStatus,
  calibrationOverdueAfterDays,
  summarisePlannerHealth,
  suppressReportCount,
  suppressSmallCount,
  type CalibrationHealthStatus,
  type EngineHealthWindowDays,
  type PlannerHealthFigures,
  type SuppressedCount,
} from '@planthepath/authorization/src/index.js';
import { CAREER_READINESS_MODEL } from '@planthepath/career-readiness/src/index.js';
import {
  LEARNER_SKILL_STATE_ALGORITHM_ID,
  LEARNING_MODEL_ALGORITHM_ID,
  type SkillBand,
} from '@planthepath/learning-model/src/index.js';
import { buildShadowReport, shadowBand, type BandComparison, type ShadowPair } from '@planthepath/mastery-bkt/src/index.js';
import { consentPurposeHeldSql, consentPurposeOffered } from './consent-purposes.js';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

// --- Planner decisions -------------------------------------------------------------------------

export interface PlannerHealth extends PlannerHealthFigures {
  readonly windowDays: EngineHealthWindowDays;
  /** Policy versions that produced a decision in the window, sorted (non-personal). */
  readonly policyVersions: readonly string[];
}

export async function loadPlannerHealth(db: PersistenceDb, windowDays: EngineHealthWindowDays): Promise<PlannerHealth> {
  // Whole UTC days ending today, computed on the database clock.
  const window = sql`
    bounds AS (
      SELECT date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${windowDays - 1}::int) AS start_day,
             date_trunc('day', now() AT TIME ZONE 'UTC') AS end_day
    ),
    d AS (
      SELECT date_trunc('day', ld.decided_at AT TIME ZONE 'UTC') AS day, ld.subject_user_id,
             ld.override_by_user_id IS NOT NULL AS overridden, ld.policy_version
      FROM learning_decisions ld, bounds
      WHERE ld.decided_at AT TIME ZONE 'UTC' >= bounds.start_day
    ),
    per_day AS (
      SELECT day, count(*)::int AS decisions, count(DISTINCT subject_user_id)::int AS students FROM d GROUP BY day
    )`;
  const days = await db.execute(sql`
    WITH ${window},
    series AS (SELECT generate_series(start_day, end_day, interval '1 day') AS day FROM bounds)
    SELECT to_char(series.day, 'YYYY-MM-DD') AS day, coalesce(per_day.decisions, 0)::int AS decisions, coalesce(per_day.students, 0)::int AS students
    FROM series LEFT JOIN per_day ON per_day.day = series.day
    ORDER BY series.day
  `) as QueryResult<{ day: string; decisions: number; students: number }>;
  const totals = await db.execute(sql`
    WITH ${window}
    SELECT count(*)::int AS decisions,
           count(DISTINCT d.subject_user_id)::int AS students,
           (count(*) FILTER (WHERE d.overridden))::int AS overridden,
           (count(DISTINCT d.subject_user_id) FILTER (WHERE d.overridden))::int AS overridden_students,
           (count(DISTINCT d.subject_user_id) FILTER (WHERE per_day.students < 5))::int AS suppressed_day_students,
           coalesce(array_agg(DISTINCT d.policy_version ORDER BY d.policy_version) FILTER (WHERE d.policy_version IS NOT NULL), '{}') AS policy_versions
    FROM d JOIN per_day ON per_day.day = d.day
  `) as QueryResult<{ decisions: number; students: number; overridden: number; overridden_students: number; suppressed_day_students: number; policy_versions: string[] }>;
  const row = totals.rows[0]!;
  const figures = summarisePlannerHealth(
    days.rows.map((day) => ({ day: day.day, decisions: Number(day.decisions), students: Number(day.students) })),
    {
      decisions: Number(row.decisions),
      students: Number(row.students),
      overridden: Number(row.overridden),
      overriddenStudents: Number(row.overridden_students),
      suppressedDayStudents: Number(row.suppressed_day_students),
    },
  );
  return { windowDays, ...figures, policyVersions: [...(row.policy_versions ?? [])] };
}

// --- Mastery shadow ----------------------------------------------------------------------------

export interface ShadowComparisonHealth {
  readonly pairsCompared: SuppressedCount;
  readonly unchanged: SuppressedCount;
  readonly movedUp: SuppressedCount;
  readonly movedDown: SuppressedCount;
  readonly becameNotEnoughEvidence: SuppressedCount;
  readonly leftNotEnoughEvidence: SuppressedCount;
  readonly studentsWithAnyChange: SuppressedCount;
}

export interface MasteryShadowHealth {
  /** Whether a live adaptive-learning definition exists at all (students have been asked). */
  readonly consentOffered: boolean;
  /** True when fewer than five consenting students are in scope: every figure below is withheld. */
  readonly suppressed: boolean;
  readonly studentsInScope: SuppressedCount;
  readonly algorithms: { readonly live: string; readonly engineBand: string; readonly projector: string; readonly shadow: string };
  readonly coverage: {
    readonly pairsWithBothBands: SuppressedCount;
    readonly livePairsWithoutEngineRow: SuppressedCount;
    readonly engineRowsWithoutLiveBand: SuppressedCount;
    readonly engineRowsOnOlderProjector: SuppressedCount;
  } | null;
  readonly c3Adoption: ShadowComparisonHealth | null;
  readonly bkt: ShadowComparisonHealth | null;
}

function comparison(value: BandComparison | undefined): ShadowComparisonHealth | null {
  if (!value) return null;
  return {
    pairsCompared: suppressReportCount(value.pairsCompared),
    unchanged: suppressReportCount(value.unchanged),
    movedUp: suppressReportCount(value.movedUp),
    movedDown: suppressReportCount(value.movedDown),
    becameNotEnoughEvidence: suppressReportCount(value.becameNotEnoughEvidence),
    leftNotEnoughEvidence: suppressReportCount(value.leftNotEnoughEvidence),
    studentsWithAnyChange: suppressReportCount(value.studentsWithAnyChange),
  };
}

/**
 * The aggregate part of the ENG-06 shadow report, from two set-based reads. Scope and pairing are
 * the report's: students with engine rows who hold adaptive-learning now (fail closed), and every
 * (student, topic) with a live band or an engine row. The same pure `buildShadowReport` counts them.
 */
export async function loadMasteryShadowHealth(db: PersistenceDb): Promise<MasteryShadowHealth> {
  const held = sql`
    scope AS (SELECT DISTINCT subject_user_id FROM learner_skill_state),
    held AS (SELECT scope.subject_user_id FROM scope WHERE ${consentPurposeHeldSql('adaptive-learning', sql`scope.subject_user_id`)})`;
  const engine = await db.execute(sql`
    WITH ${held}
    SELECT s.subject_user_id::text AS subject_user_id, s.skill_id::text AS skill_id, s.evidence_band, s.attempt_day_count,
           s.mastery_likelihood, s.algorithm_version
    FROM learner_skill_state s JOIN held ON held.subject_user_id = s.subject_user_id
  `) as QueryResult<{ subject_user_id: string; skill_id: string; evidence_band: SkillBand; attempt_day_count: number; mastery_likelihood: string | null; algorithm_version: string }>;
  const live = await db.execute(sql`
    WITH ${held}
    SELECT DISTINCT ON (m.subject_user_id, m.topic_id) m.subject_user_id::text AS subject_user_id, m.topic_id::text AS topic_id, m.band
    FROM mastery_projections m JOIN held ON held.subject_user_id = m.subject_user_id
    WHERE m.algorithm_version = ${CAREER_READINESS_MODEL.masteryAlgorithm}
    ORDER BY m.subject_user_id, m.topic_id, m.generated_at DESC, m.id DESC
  `) as QueryResult<{ subject_user_id: string; topic_id: string; band: SkillBand }>;

  // Subjects become ordinal keys here and never leave this function.
  const keys = new Map<string, string>();
  const keyOf = (subject: string): string => {
    let key = keys.get(subject);
    if (!key) { key = `s${keys.size + 1}`; keys.set(subject, key); }
    return key;
  };
  const engineRows = new Map(engine.rows.map((row) => [`${row.subject_user_id}|${row.skill_id}`, row]));
  const liveBands = new Map(live.rows.map((row) => [`${row.subject_user_id}|${row.topic_id}`, row.band]));
  for (const row of engine.rows) keyOf(row.subject_user_id);
  const pairs: ShadowPair[] = [];
  for (const pairKey of new Set([...liveBands.keys(), ...engineRows.keys()])) {
    const subject = pairKey.slice(0, pairKey.indexOf('|'));
    const row = engineRows.get(pairKey);
    const current = row?.algorithm_version === LEARNER_SKILL_STATE_ALGORITHM_ID;
    pairs.push({
      subjectKey: keyOf(subject),
      liveBand: liveBands.get(pairKey) ?? null,
      engineBand: row?.evidence_band ?? null,
      bktBand: row && current
        ? shadowBand(row.mastery_likelihood === null ? null : Number(row.mastery_likelihood), Number(row.attempt_day_count))
        : null,
      staleProjector: row !== undefined && !current,
    });
  }
  const studentsInScope = new Set(engine.rows.map((row) => row.subject_user_id)).size;
  const report = buildShadowReport({
    studentsInScope,
    pairs,
    predictions: [],
    liveAlgorithm: CAREER_READINESS_MODEL.masteryAlgorithm,
    engineBandAlgorithm: LEARNING_MODEL_ALGORITHM_ID,
    projectorAlgorithm: LEARNER_SKILL_STATE_ALGORITHM_ID,
  });
  const consentOffered = await consentPurposeOffered(db, 'adaptive-learning');
  return {
    consentOffered,
    suppressed: report.suppressed,
    studentsInScope: suppressSmallCount(studentsInScope),
    algorithms: { ...report.algorithms },
    coverage: report.coverage
      ? {
          pairsWithBothBands: suppressReportCount(report.coverage.pairsWithBothBands),
          livePairsWithoutEngineRow: suppressReportCount(report.coverage.livePairsWithoutEngineRow),
          engineRowsWithoutLiveBand: suppressReportCount(report.coverage.engineRowsWithoutLiveBand),
          engineRowsOnOlderProjector: suppressReportCount(report.coverage.engineRowsOnOlderProjector),
        }
      : null,
    c3Adoption: comparison(report.c3Adoption),
    bkt: comparison(report.bkt),
  };
}

// --- Calibration -------------------------------------------------------------------------------

export interface CalibrationHealth {
  readonly status: CalibrationHealthStatus;
  readonly expectedIntervalDays: number;
  readonly overdueAfterDays: number;
  readonly runsRecorded: number;
  readonly lastRun: {
    readonly algorithmId: string;
    readonly library: string;
    readonly minResponses: number;
    readonly exportedAt: string;
    readonly generatedAt: string;
    readonly recordedAt: string;
    /** Whole days since the import, on the database clock. */
    readonly ageDays: number;
    readonly learnersRead: SuppressedCount;
    /** Published only when the learner count is: it is those learners' activity. */
    readonly responsesRead: number | null;
    readonly itemsRead: number;
    readonly items: {
      readonly calibrated: number;
      readonly provisional: number;
      readonly provisionalByReason: Readonly<Record<string, number>>;
    };
  } | null;
}

export async function loadCalibrationHealth(db: PersistenceDb): Promise<CalibrationHealth> {
  const runs = await db.execute(sql`SELECT count(*)::int AS runs FROM item_calibration_runs`) as QueryResult<{ runs: number }>;
  const latest = await db.execute(sql`
    SELECT id, algorithm_id, library, min_responses, learners_read, responses_read, items_read, exported_at, generated_at, recorded_at,
           extract(epoch FROM (now() - recorded_at)) / 86400.0 AS age_days
    FROM item_calibration_runs
    ORDER BY recorded_at DESC, id DESC
    LIMIT 1
  `) as QueryResult<{ id: string; algorithm_id: string; library: string; min_responses: number; learners_read: number; responses_read: number; items_read: number;
    exported_at: Date | string; generated_at: Date | string; recorded_at: Date | string; age_days: string | number }>;
  const base = { expectedIntervalDays: calibrationExpectedIntervalDays, overdueAfterDays: calibrationOverdueAfterDays, runsRecorded: Number(runs.rows[0]?.runs ?? 0) };
  const run = latest.rows[0];
  if (!run) return { status: calibrationHealthStatus(null), ...base, lastRun: null };

  const items = await db.execute(sql`
    SELECT status, status_reason, count(*)::int AS items FROM item_calibrations WHERE run_id = ${run.id}::uuid GROUP BY status, status_reason
  `) as QueryResult<{ status: 'CALIBRATED' | 'PROVISIONAL'; status_reason: string | null; items: number }>;
  const provisionalByReason: Record<string, number> = {};
  let calibrated = 0;
  let provisional = 0;
  for (const row of items.rows) {
    if (row.status === 'CALIBRATED') { calibrated += Number(row.items); continue; }
    provisional += Number(row.items);
    const reason = row.status_reason ?? 'UNSPECIFIED';
    provisionalByReason[reason] = (provisionalByReason[reason] ?? 0) + Number(row.items);
  }
  const ageDays = Math.max(0, Number(run.age_days));
  const learnersRead = suppressSmallCount(Number(run.learners_read));
  return {
    status: calibrationHealthStatus(ageDays),
    ...base,
    lastRun: {
      algorithmId: run.algorithm_id,
      library: run.library,
      minResponses: Number(run.min_responses),
      exportedAt: iso(run.exported_at)!,
      generatedAt: iso(run.generated_at)!,
      recordedAt: iso(run.recorded_at)!,
      ageDays: Math.floor(ageDays),
      learnersRead,
      responsesRead: learnersRead.suppressed ? null : Number(run.responses_read),
      itemsRead: Number(run.items_read),
      items: { calibrated, provisional, provisionalByReason },
    },
  };
}

// --- Code sandbox ------------------------------------------------------------------------------

export interface SandboxHealth {
  /** NOT_BUILT: ENG-12 (the isolated code sandbox) is not on this branch, so there is no source. */
  readonly state: 'NOT_BUILT';
  readonly available: null;
  readonly rejectedExecutions: null;
}

/** No sandbox, execution log or health endpoint exists yet; both figures are NA, never guessed. */
export function sandboxHealth(): SandboxHealth {
  return { state: 'NOT_BUILT', available: null, rejectedExecutions: null };
}
