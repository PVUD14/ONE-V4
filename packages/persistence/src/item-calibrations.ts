/**
 * Item calibrations (ENG-13): the TypeScript side of the offline calibration pipeline.
 *
 * Why this exists: the placement test (ENG-14) needs each item's 2PL difficulty and
 * discrimination, fitted offline in Python (ADR-034, jobs/calibration). Everything that touches
 * the database stays here, under the integration suites:
 *   - `exportCalibrationAttempts` reads the attempt log for students holding the live
 *     model-improvement purpose and emits only [per-run pseudonym, item key, correct];
 *   - `parseCalibrationResults` / `importCalibrationResults` validate the job's output strictly and
 *     write one run in one transaction;
 *   - `latestItemCalibrations` is the online reader: latest CALIBRATED, else latest PROVISIONAL.
 * Calibrations are model state about items. They are never shown to a student as a number and
 * never feed readiness. Design: docs/architecture/item-calibrations-table-design.md.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PersistenceDb } from './repositories.js';

export const CALIBRATION_ALGORITHM_ID = 'item-calibration-2pl-v1';
export const CALIBRATION_SOURCE = 'jobs/calibration';
export const CALIBRATION_EXPORT_FORMAT = 'one-calibration-export-v1';
export const CALIBRATION_RESULTS_FORMAT = 'one-calibration-results-v1';
export const CALIBRATION_ITEM_SOURCES = ['CAREER_READINESS_QUESTION', 'INSTITUTION_EXAM_QUESTION'] as const;
export const CALIBRATION_STATUS_REASONS = ['TOO_FEW_RESPONSES', 'NO_VARIANCE', 'TOO_FEW_ITEMS', 'ESTIMATE_OUT_OF_RANGE'] as const;
export const CALIBRATION_BOUNDS = { difficulty: [-4, 4], discrimination: [0.2, 4] } as const;
const MAX_ITEMS_PER_RUN = 100_000;

export type CalibrationItemSource = (typeof CALIBRATION_ITEM_SOURCES)[number];
export type CalibrationStatus = 'PROVISIONAL' | 'CALIBRATED';
export type CalibrationStatusReason = (typeof CALIBRATION_STATUS_REASONS)[number];

export interface CalibrationItemKey {
  itemSource: CalibrationItemSource;
  itemId: string;
  itemVersion: number;
}

/** One response: [pseudonym, "source:itemId:version", 1 | 0]. Nothing else about the learner. */
export type CalibrationExportResponse = [learner: string, item: string, correct: 0 | 1];

export interface CalibrationExport {
  format: typeof CALIBRATION_EXPORT_FORMAT;
  runId: string;
  exportedAt: string;
  responses: CalibrationExportResponse[];
}

export interface CalibrationResultItem extends CalibrationItemKey {
  model: '2PL';
  difficulty: number;
  discrimination: number;
  responsesUsed: number;
  status: CalibrationStatus;
  statusReason: CalibrationStatusReason | null;
}

export interface CalibrationResults {
  format: typeof CALIBRATION_RESULTS_FORMAT;
  runId: string;
  algorithmId: typeof CALIBRATION_ALGORITHM_ID;
  library: string;
  minResponses: number;
  exportedAt: string;
  generatedAt: string;
  learnersRead: number;
  responsesRead: number;
  itemsRead: number;
  items: CalibrationResultItem[];
}

export interface ItemCalibration extends CalibrationItemKey {
  runId: string;
  model: '2PL';
  difficulty: number;
  discrimination: number;
  responsesUsed: number;
  status: CalibrationStatus;
  statusReason: CalibrationStatusReason | null;
  algorithmId: string;
}

export class CalibrationResultsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationResultsError';
  }
}

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function calibrationItemKey(item: CalibrationItemKey): string {
  return `${item.itemSource}:${item.itemId.toLowerCase()}:${item.itemVersion}`;
}

/**
 * Reads the de-identified export for one new run. Only students whose latest action on the live
 * `model-improvement` definition is GRANTED are read (the rule `hasConsentPurpose` applies, set-wise);
 * with no live definition the export is empty. Per learner and item version only the first response
 * counts, and not at all if it was assisted. Learners become `L1`, `L2`, … ranked by a salted hash
 * whose salt exists only for this call, so numbers cannot be linked across runs or back to a person;
 * ranking happens in SQL, so user ids never leave the database.
 */
export async function exportCalibrationAttempts(db: PersistenceDb): Promise<CalibrationExport> {
  const runId = randomUUID();
  const salt = randomBytes(32).toString('hex');
  const clock = await db.execute(sql`SELECT now() AS exported_at`) as QueryResult<{ exported_at: Date | string }>;
  const exportedAt = new Date(clock.rows[0]!.exported_at).toISOString();
  const result = await db.execute(sql`
    WITH consenting AS (
      SELECT learners.user_id
      FROM (SELECT DISTINCT subject_user_id AS user_id FROM learning_attempt_events) learners
      JOIN consent_definitions d
        ON d.consent_key = 'model-improvement' AND d.retired_at IS NULL AND d.effective_from <= now()
      JOIN LATERAL (
        SELECT c.version, c.action FROM user_consents c
        WHERE c.user_id = learners.user_id AND c.consent_key = d.consent_key
        ORDER BY c.recorded_at DESC, c.id DESC LIMIT 1
      ) latest ON latest.version = d.version AND latest.action = 'GRANTED'
    ),
    first_responses AS (
      SELECT DISTINCT ON (e.subject_user_id, e.item_source, e.item_id, e.item_version)
        e.subject_user_id, e.item_source, e.item_id, e.item_version, e.correct, e.assisted
      FROM learning_attempt_events e
      JOIN consenting c ON c.user_id = e.subject_user_id
      -- Only the item banks 2PL calibrates; a code task's pass/fail (ENG-12, ADR-049) is not a 2PL item.
      WHERE e.item_source IN ('CAREER_READINESS_QUESTION', 'INSTITUTION_EXAM_QUESTION')
      ORDER BY e.subject_user_id, e.item_source, e.item_id, e.item_version, e.occurred_at, e.id
    ),
    unaided AS (
      SELECT * FROM first_responses WHERE NOT assisted
    )
    SELECT
      dense_rank() OVER (ORDER BY sha256(decode(${salt}, 'hex') || convert_to(subject_user_id::text, 'UTF8'))) AS learner,
      item_source, item_id::text AS item_id, item_version, correct
    FROM unaided
    ORDER BY learner, item_source, item_id, item_version
  `) as QueryResult<{ learner: string | number; item_source: CalibrationItemSource; item_id: string; item_version: number; correct: boolean }>;

  return {
    format: CALIBRATION_EXPORT_FORMAT,
    runId,
    exportedAt,
    responses: result.rows.map((row) => [
      `L${Number(row.learner)}`,
      calibrationItemKey({ itemSource: row.item_source, itemId: row.item_id, itemVersion: Number(row.item_version) }),
      row.correct ? 1 : 0,
    ]),
  };
}

function fail(message: string): never {
  throw new CalibrationResultsError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where}: unexpected field "${key}"`);
  for (const key of keys) if (!(key in value)) fail(`${where}: missing field "${key}"`);
}

function count(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${where} must be a non-negative integer`);
  return value;
}

function timestamp(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) fail(`${where} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function bounded(value: unknown, [low, high]: readonly [number, number], where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where} must be a finite number`);
  const rounded = Math.round(value * 10_000) / 10_000;
  if (rounded < low || rounded > high) fail(`${where} must lie within [${low}, ${high}]`);
  return rounded;
}

const resultKeys = ['format', 'runId', 'algorithmId', 'library', 'minResponses', 'exportedAt', 'generatedAt', 'learnersRead', 'responsesRead', 'itemsRead', 'items'] as const;
const itemKeys = ['itemSource', 'itemId', 'itemVersion', 'model', 'difficulty', 'discrimination', 'responsesUsed', 'status', 'statusReason'] as const;

/**
 * Validates the calibration job's output before anything is written. Unknown fields are rejected
 * (so nothing per-learner can ride along), every number is bounded, and the status rule is checked:
 * a CALIBRATED item needs at least the run's `minResponses` and no reason; a PROVISIONAL one needs a
 * known reason. Pure; throws `CalibrationResultsError`.
 */
export function parseCalibrationResults(value: unknown): CalibrationResults {
  if (!isRecord(value)) fail('results must be a JSON object');
  exactKeys(value, resultKeys, 'results');
  if (value.format !== CALIBRATION_RESULTS_FORMAT) fail(`results.format must be ${CALIBRATION_RESULTS_FORMAT}`);
  if (typeof value.runId !== 'string' || !uuidPattern.test(value.runId)) fail('results.runId must be a UUID');
  if (value.algorithmId !== CALIBRATION_ALGORITHM_ID) fail(`results.algorithmId must be ${CALIBRATION_ALGORITHM_ID}`);
  if (typeof value.library !== 'string' || value.library.trim().length < 1 || value.library.length > 200) fail('results.library must be 1-200 characters');
  const minResponses = count(value.minResponses, 'results.minResponses');
  if (minResponses < 1) fail('results.minResponses must be at least 1');
  const learnersRead = count(value.learnersRead, 'results.learnersRead');
  const responsesRead = count(value.responsesRead, 'results.responsesRead');
  const itemsRead = count(value.itemsRead, 'results.itemsRead');
  if (!Array.isArray(value.items)) fail('results.items must be an array');
  if (value.items.length > MAX_ITEMS_PER_RUN) fail(`results.items may hold at most ${MAX_ITEMS_PER_RUN} items`);
  if (value.items.length !== itemsRead) fail('results.itemsRead must equal the number of items');

  const seen = new Set<string>();
  let responsesUsedTotal = 0;
  const items = value.items.map((raw, index): CalibrationResultItem => {
    const where = `results.items[${index}]`;
    if (!isRecord(raw)) fail(`${where} must be an object`);
    exactKeys(raw, itemKeys, where);
    if (!(CALIBRATION_ITEM_SOURCES as readonly unknown[]).includes(raw.itemSource)) fail(`${where}.itemSource is not a known item bank`);
    if (typeof raw.itemId !== 'string' || !uuidPattern.test(raw.itemId)) fail(`${where}.itemId must be a UUID`);
    if (typeof raw.itemVersion !== 'number' || !Number.isInteger(raw.itemVersion) || raw.itemVersion < 1) fail(`${where}.itemVersion must be a positive integer`);
    if (raw.model !== '2PL') fail(`${where}.model must be 2PL`);
    const responsesUsed = count(raw.responsesUsed, `${where}.responsesUsed`);
    const status = raw.status;
    if (status === 'CALIBRATED') {
      if (raw.statusReason !== null) fail(`${where}: a CALIBRATED item carries no statusReason`);
      if (responsesUsed < minResponses) fail(`${where}: a CALIBRATED item needs at least ${minResponses} responses`);
    } else if (status === 'PROVISIONAL') {
      if (!(CALIBRATION_STATUS_REASONS as readonly unknown[]).includes(raw.statusReason)) fail(`${where}.statusReason is not a known reason`);
    } else {
      fail(`${where}.status must be PROVISIONAL or CALIBRATED`);
    }
    const item: CalibrationResultItem = {
      itemSource: raw.itemSource as CalibrationItemSource,
      itemId: raw.itemId.toLowerCase(),
      itemVersion: raw.itemVersion,
      model: '2PL',
      difficulty: bounded(raw.difficulty, CALIBRATION_BOUNDS.difficulty, `${where}.difficulty`),
      discrimination: bounded(raw.discrimination, CALIBRATION_BOUNDS.discrimination, `${where}.discrimination`),
      responsesUsed,
      status,
      statusReason: (raw.statusReason ?? null) as CalibrationStatusReason | null,
    };
    const key = calibrationItemKey(item);
    if (seen.has(key)) fail(`${where} repeats an item`);
    seen.add(key);
    responsesUsedTotal += responsesUsed;
    return item;
  });
  if (responsesUsedTotal !== responsesRead) fail('results.responsesRead must equal the sum of responsesUsed');

  return {
    format: CALIBRATION_RESULTS_FORMAT,
    runId: value.runId.toLowerCase(),
    algorithmId: CALIBRATION_ALGORITHM_ID,
    library: value.library.trim(),
    minResponses,
    exportedAt: timestamp(value.exportedAt, 'results.exportedAt'),
    generatedAt: timestamp(value.generatedAt, 'results.generatedAt'),
    learnersRead,
    responsesRead,
    itemsRead,
    items,
  };
}

export interface CalibrationImportOutcome {
  runId: string;
  /** False when this run id was already imported: the import is a no-op, never a second copy. */
  imported: boolean;
  calibrated: number;
  provisional: number;
}

/**
 * Writes one validated run and its rows in one transaction. Replaying the same run is a no-op.
 * Every item must appear in the attempt log (the job can only have seen items from the export).
 */
export async function importCalibrationResults(db: PersistenceDb, input: unknown): Promise<CalibrationImportOutcome> {
  const results = parseCalibrationResults(input);
  const calibrated = results.items.filter((item) => item.status === 'CALIBRATED').length;
  const provisional = results.items.length - calibrated;
  const itemsJson = JSON.stringify(results.items.map((item) => ({
    id: randomUUID(),
    item_source: item.itemSource,
    item_id: item.itemId,
    item_version: item.itemVersion,
    difficulty: item.difficulty,
    discrimination: item.discrimination,
    responses_used: item.responsesUsed,
    status: item.status,
    status_reason: item.statusReason,
  })));

  return db.transaction(async (tx) => {
    const run = await tx.execute(sql`
      INSERT INTO item_calibration_runs
        (id, source, algorithm_id, library, min_responses, learners_read, responses_read, items_read, exported_at, generated_at)
      VALUES (${results.runId}::uuid, ${CALIBRATION_SOURCE}, ${results.algorithmId}, ${results.library}, ${results.minResponses},
              ${results.learnersRead}, ${results.responsesRead}, ${results.itemsRead},
              ${results.exportedAt}::timestamptz, ${results.generatedAt}::timestamptz)
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as QueryResult<{ id: string }>;
    if (run.rows.length === 0) return { runId: results.runId, imported: false, calibrated: 0, provisional: 0 };

    const unknown = await tx.execute(sql`
      SELECT count(*)::int AS missing
      FROM jsonb_to_recordset(${itemsJson}::jsonb) AS k(item_source text, item_id uuid, item_version int)
      WHERE NOT EXISTS (
        SELECT 1 FROM learning_attempt_events e
        WHERE e.item_source = k.item_source AND e.item_id = k.item_id AND e.item_version = k.item_version
      )
    `) as QueryResult<{ missing: number }>;
    if (Number(unknown.rows[0]?.missing ?? 0) > 0) fail('results name an item that is not in the attempt log');

    await tx.execute(sql`
      INSERT INTO item_calibrations
        (id, run_id, item_source, item_id, item_version, model, difficulty, discrimination, responses_used, status, status_reason)
      SELECT k.id, ${results.runId}::uuid, k.item_source, k.item_id, k.item_version, '2PL',
             k.difficulty, k.discrimination, k.responses_used, k.status, k.status_reason
      FROM jsonb_to_recordset(${itemsJson}::jsonb) AS k(
        id uuid, item_source text, item_id uuid, item_version int, difficulty numeric, discrimination numeric,
        responses_used int, status text, status_reason text)
    `);
    return { runId: results.runId, imported: true, calibrated, provisional };
  });
}

/**
 * The online reader (ENG-14): per item version, the latest CALIBRATED row, else the latest
 * PROVISIONAL row; items never calibrated are absent from the map (the caller uses its default).
 * Keyed by `calibrationItemKey`.
 */
export async function latestItemCalibrations(db: PersistenceDb, items: readonly CalibrationItemKey[]): Promise<Map<string, ItemCalibration>> {
  const found = new Map<string, ItemCalibration>();
  if (items.length === 0) return found;
  const keys = JSON.stringify(items.map((item) => ({ item_source: item.itemSource, item_id: item.itemId, item_version: item.itemVersion })));
  const result = await db.execute(sql`
    SELECT DISTINCT ON (c.item_source, c.item_id, c.item_version)
      c.item_source, c.item_id::text AS item_id, c.item_version, c.run_id::text AS run_id, c.model,
      c.difficulty::float8 AS difficulty, c.discrimination::float8 AS discrimination,
      c.responses_used, c.status, c.status_reason, r.algorithm_id
    FROM jsonb_to_recordset(${keys}::jsonb) AS k(item_source text, item_id uuid, item_version int)
    JOIN item_calibrations c
      ON c.item_source = k.item_source AND c.item_id = k.item_id AND c.item_version = k.item_version
    JOIN item_calibration_runs r ON r.id = c.run_id
    ORDER BY c.item_source, c.item_id, c.item_version,
             (c.status = 'CALIBRATED') DESC, r.exported_at DESC, c.recorded_at DESC, c.id DESC
  `) as QueryResult<{
    item_source: CalibrationItemSource; item_id: string; item_version: number; run_id: string; model: '2PL';
    difficulty: number; discrimination: number; responses_used: number; status: CalibrationStatus;
    status_reason: CalibrationStatusReason | null; algorithm_id: string;
  }>;
  for (const row of result.rows) {
    const calibration: ItemCalibration = {
      itemSource: row.item_source,
      itemId: row.item_id,
      itemVersion: Number(row.item_version),
      runId: row.run_id,
      model: row.model,
      difficulty: Number(row.difficulty),
      discrimination: Number(row.discrimination),
      responsesUsed: Number(row.responses_used),
      status: row.status,
      statusReason: row.status_reason,
      algorithmId: row.algorithm_id,
    };
    found.set(calibrationItemKey(calibration), calibration);
  }
  return found;
}
