/**
 * The BKT shadow report (ENG-06): gathers, for students who hold adaptive-learning, the live
 * `career-readiness-mastery-v1` band, the engine's `learning-model-v1` band and the band BKT would
 * give, per topic, plus BKT's predictions of each next attempt — and hands them to the pure
 * aggregation in packages/mastery-bkt, which prints counts only.
 *
 * Why it exists: ENG-04's C3 adoption and ENG-27's replacement of v1 (HG-5) both wait on how many
 * students' bands would move. This is an offline, operator-run read: it writes nothing, is on no
 * route, and its output carries no identifier (subjects are reduced to ordinal keys before they
 * reach the aggregation, which never prints them). Nobody without adaptive-learning is read.
 * Design: docs/architecture/mastery-bkt-shadow-design.md ("The shadow report").
 */
import { sql } from 'drizzle-orm';
import { CAREER_READINESS_MODEL } from '@planthepath/career-readiness/src/index.js';
import {
  LEARNER_SKILL_STATE_ALGORITHM_ID,
  LEARNING_MODEL_ALGORITHM_ID,
  skillMasteryTraces,
  type SkillBand,
} from '@planthepath/learning-model/src/index.js';
import {
  buildShadowReport,
  shadowBand,
  type ShadowPair,
  type ShadowPrediction,
  type ShadowReport,
} from '@planthepath/mastery-bkt/src/index.js';
import { hasConsentPurpose } from './consent-purposes.js';
import { loadProjectionAttempts } from './learner-skill-state.js';
import type { PersistenceDb } from './repositories.js';

type QueryResult<T> = { rows: T[] };

export async function buildBktShadowReport(db: PersistenceDb): Promise<ShadowReport> {
  const candidates = await db.execute(sql`
    SELECT DISTINCT subject_user_id FROM learner_skill_state ORDER BY subject_user_id
  `) as QueryResult<{ subject_user_id: string }>;

  const pairs: ShadowPair[] = [];
  const predictions: ShadowPrediction[] = [];
  let studentsInScope = 0;
  for (const { subject_user_id: subjectUserId } of candidates.rows) {
    // Fail closed: a row left behind for someone without the purpose is not read.
    if (!(await hasConsentPurpose(db, subjectUserId, 'adaptive-learning'))) continue;
    studentsInScope += 1;
    const subjectKey = `s${studentsInScope}`;

    const engine = await db.execute(sql`
      SELECT skill_id, evidence_band, attempt_day_count, mastery_likelihood, algorithm_version
      FROM learner_skill_state WHERE subject_user_id = ${subjectUserId}::uuid
    `) as QueryResult<{ skill_id: string; evidence_band: SkillBand; attempt_day_count: number; mastery_likelihood: string | null; algorithm_version: string }>;
    const live = await db.execute(sql`
      SELECT DISTINCT ON (topic_id) topic_id, band
      FROM mastery_projections
      WHERE subject_user_id = ${subjectUserId}::uuid AND algorithm_version = ${CAREER_READINESS_MODEL.masteryAlgorithm}
      ORDER BY topic_id, generated_at DESC, id DESC
    `) as QueryResult<{ topic_id: string; band: SkillBand }>;

    const liveBands = new Map(live.rows.map((row) => [row.topic_id, row.band]));
    const engineRows = new Map(engine.rows.map((row) => [row.skill_id, row]));
    for (const skillId of new Set([...liveBands.keys(), ...engineRows.keys()])) {
      const row = engineRows.get(skillId);
      const current = row?.algorithm_version === LEARNER_SKILL_STATE_ALGORITHM_ID;
      pairs.push({
        subjectKey,
        liveBand: liveBands.get(skillId) ?? null,
        engineBand: row?.evidence_band ?? null,
        bktBand: row && current
          ? shadowBand(row.mastery_likelihood === null ? null : Number(row.mastery_likelihood), Number(row.attempt_day_count))
          : null,
        staleProjector: row !== undefined && !current,
      });
    }

    for (const trace of skillMasteryTraces(await loadProjectionAttempts(db, subjectUserId)).values()) {
      for (const prediction of trace.predictions) predictions.push({ subjectKey, ...prediction });
    }
  }

  return buildShadowReport({
    studentsInScope,
    pairs,
    predictions,
    liveAlgorithm: CAREER_READINESS_MODEL.masteryAlgorithm,
    engineBandAlgorithm: LEARNING_MODEL_ALGORITHM_ID,
    projectorAlgorithm: LEARNER_SKILL_STATE_ALGORITHM_ID,
  });
}
