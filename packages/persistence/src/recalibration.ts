/**
 * Recalibration runs (ENG-26): the TypeScript side of the monthly 2PL recalibration and BKT refit.
 *
 * Why this exists: a refit must not change what a student meets just by being computed. The Python
 * job (jobs/calibration, ADR-034) fits and compares; everything that touches the database is here:
 *   - `exportItemRecalibration` / `exportBktRefit` write the de-identified export and the baseline
 *     (the parameters a refit would replace, plus a digest of that live state);
 *   - `parseRecalibrationProposal` / `recordRecalibrationProposal` validate the job's proposal strictly
 *     and store it as a PENDING run;
 *   - `decideRecalibration` accepts or rejects a run (accepting an item run imports it through ENG-13's
 *     `importCalibrationResults`; accepting a BKT run only records it), refusing a stale proposal;
 *   - `revertRecalibration` rolls an accepted run back; `acceptedBktParameters` is ENG-27's reader;
 *   - `renderRecalibrationMarkdown` is the human-readable report.
 * Parameters and counts only: no learner, no readiness, on no route. BKT fits never reach the
 * projector from here — switching them on is ENG-27 / HG-5.
 * Design: docs/architecture/recalibration-runs-table-design.md.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { masteryObservationsBySkill } from '@planthepath/learning-model/src/index.js';
import { MasteryBktError, validateParameters, type BktParameters } from '@planthepath/mastery-bkt/src/index.js';
import { consentPurposeHeldSql } from './consent-purposes.js';
import {
  CALIBRATION_ALGORITHM_ID,
  CALIBRATION_ITEM_SOURCES,
  CalibrationResultsError,
  calibrationItemKey,
  exportCalibrationAttempts,
  importCalibrationResults,
  parseCalibrationResults,
  type CalibrationExport,
  type CalibrationItemSource,
  type CalibrationResults,
  type CalibrationStatus,
} from './item-calibrations.js';
import { loadProjectionAttempts } from './learner-skill-state.js';
import type { PersistenceDb } from './repositories.js';

export const RECALIBRATION_KINDS = ['ITEM_2PL', 'BKT'] as const;
export type RecalibrationKind = (typeof RECALIBRATION_KINDS)[number];
export const BKT_FIT_ALGORITHM_ID = 'bkt-fit-mle-v1';
export const BKT_EXPORT_FORMAT = 'one-bkt-export-v1';
export const BKT_RESULTS_FORMAT = 'one-bkt-fit-results-v1';
export const RECALIBRATION_BASELINE_FORMAT = 'one-recalibration-baseline-v1';
export const RECALIBRATION_PROPOSAL_FORMAT = 'one-recalibration-proposal-v1';
export const RECALIBRATION_REPORT_FORMAT = 'one-recalibration-report-v1';
export const RECALIBRATION_CHANGES = ['STABLE', 'DRIFTED', 'NEW', 'NEWLY_CALIBRATED', 'LOST_CALIBRATION', 'NOT_REFITTED', 'NOT_CALIBRATED'] as const;
export type RecalibrationChange = (typeof RECALIBRATION_CHANGES)[number];
export type RecalibrationVerdict = 'STABLE' | 'DRIFTED' | 'NO_COMPARISON';
export type RecalibrationDecision = 'ACCEPTED' | 'REJECTED' | 'REVERTED';
const BKT_PARAMETER_NAMES = ['pInit', 'pLearn', 'pGuess', 'pSlip'] as const;
type BktParameterName = (typeof BKT_PARAMETER_NAMES)[number];
const BKT_STATUS_REASONS = ['TOO_FEW_LEARNERS', 'NO_VARIANCE', 'NOT_ADMISSIBLE', 'IMPRECISE'] as const;
const BKT_MAX_STANDARD_ERROR = 0.1;
const MAX_UNITS = 100_000;
const LOCK_KEY = 'engine.recalibration';

export class RecalibrationError extends Error {
  constructor(readonly code: 'INVALID' | 'NOT_FOUND' | 'ALREADY_DECIDED' | 'NOT_ACCEPTED' | 'STALE' | 'NOT_LATEST' | 'ALREADY_IMPORTED', message: string) {
    super(message);
    this.name = 'RecalibrationError';
  }
}

type QueryResult<T> = { rows: T[] };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const itemKeyPattern = new RegExp(`^(${CALIBRATION_ITEM_SOURCES.join('|')}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9][0-9]{0,8}$`);

// --- Exports and baselines -------------------------------------------------------------------------

export interface BktExport {
  format: typeof BKT_EXPORT_FORMAT;
  runId: string;
  exportedAt: string;
  /** [skill id, "0110…"]: one learner's ordered observations on one skill — and no learner key. */
  sequences: [skill: string, observations: string][];
}

export interface ItemBaselineRow {
  itemSource: CalibrationItemSource;
  itemId: string;
  itemVersion: number;
  runId: string;
  status: CalibrationStatus;
  difficulty: number;
  discrimination: number;
  responsesUsed: number;
}

export interface SkillBaselineRow {
  skillId: string;
  parameters: Record<BktParameterName, number>;
  standardErrors: Record<BktParameterName, number>;
}

export interface RecalibrationBaseline {
  format: typeof RECALIBRATION_BASELINE_FORMAT;
  kind: RecalibrationKind;
  runId: string;
  baselineDigest: string;
  previousRunId: string | null;
  items?: ItemBaselineRow[];
  skills?: SkillBaselineRow[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Every item's live calibration, chosen exactly as `latestItemCalibrations` chooses it (latest
 * CALIBRATED, else latest PROVISIONAL), in item-key order.
 */
export async function liveItemCalibrationRows(db: PersistenceDb): Promise<ItemBaselineRow[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (c.item_source, c.item_id, c.item_version)
      c.item_source, c.item_id::text AS item_id, c.item_version, c.run_id::text AS run_id, c.status,
      c.difficulty::float8 AS difficulty, c.discrimination::float8 AS discrimination, c.responses_used
    FROM item_calibrations c
    JOIN item_calibration_runs r ON r.id = c.run_id
    ORDER BY c.item_source, c.item_id, c.item_version,
             (c.status = 'CALIBRATED') DESC, r.exported_at DESC, c.recorded_at DESC, c.id DESC
  `) as QueryResult<{
    item_source: CalibrationItemSource; item_id: string; item_version: number; run_id: string; status: CalibrationStatus;
    difficulty: number; discrimination: number; responses_used: number;
  }>;
  return result.rows.map((row) => ({
    itemSource: row.item_source,
    itemId: row.item_id.toLowerCase(),
    itemVersion: Number(row.item_version),
    runId: row.run_id.toLowerCase(),
    status: row.status,
    difficulty: Number(row.difficulty),
    discrimination: Number(row.discrimination),
    responsesUsed: Number(row.responses_used),
  })).sort((a, b) => (calibrationItemKey(a) < calibrationItemKey(b) ? -1 : calibrationItemKey(a) > calibrationItemKey(b) ? 1 : 0));
}

/** The digest an accept re-checks: which run each item's live calibration comes from, and its status. */
export function itemBaselineDigest(rows: readonly ItemBaselineRow[]): string {
  return sha256(['items', ...rows.map((row) => `${calibrationItemKey(row)}|${row.runId}|${row.status}`)].join('\n'));
}

interface AcceptedBktRun {
  id: string;
  results: BktResults;
}

/** The last accepted, unreverted BKT run — the fit ENG-27 may read and the next refit compares with. */
async function currentAcceptedBktRun(db: PersistenceDb): Promise<AcceptedBktRun | null> {
  const result = await db.execute(sql`
    SELECT r.id::text AS id, r.results
    FROM recalibration_runs r
    JOIN recalibration_decisions a ON a.run_id = r.id AND a.decision = 'ACCEPTED'
    WHERE r.kind = 'BKT'
      AND NOT EXISTS (SELECT 1 FROM recalibration_decisions v WHERE v.run_id = r.id AND v.decision = 'REVERTED')
    ORDER BY a.decided_at DESC, a.id DESC
    LIMIT 1
  `) as QueryResult<{ id: string; results: unknown }>;
  const row = result.rows[0];
  return row ? { id: row.id, results: parseBktResults(row.results, row.id) } : null;
}

export function bktBaselineDigest(acceptedRunId: string | null): string {
  return sha256(`bkt\n${acceptedRunId ?? 'none'}`);
}

async function currentDigest(db: PersistenceDb, kind: RecalibrationKind): Promise<string> {
  if (kind === 'ITEM_2PL') return itemBaselineDigest(await liveItemCalibrationRows(db));
  return bktBaselineDigest((await currentAcceptedBktRun(db))?.id ?? null);
}

/** Step 1 for items: ENG-13's de-identified export, unchanged, and the live calibrations it would replace. */
export async function exportItemRecalibration(db: PersistenceDb): Promise<{ export: CalibrationExport; baseline: RecalibrationBaseline }> {
  const exported = await exportCalibrationAttempts(db);
  const items = await liveItemCalibrationRows(db);
  const previous = await db.execute(sql`
    SELECT id::text AS id FROM item_calibration_runs ORDER BY recorded_at DESC, exported_at DESC, id DESC LIMIT 1
  `) as QueryResult<{ id: string }>;
  return {
    export: exported,
    baseline: {
      format: RECALIBRATION_BASELINE_FORMAT,
      kind: 'ITEM_2PL',
      runId: exported.runId,
      baselineDigest: itemBaselineDigest(items),
      previousRunId: previous.rows[0]?.id ?? null,
      items,
    },
  };
}

/**
 * Step 1 for BKT. Only learners holding the live `model-improvement` purpose are read (the rule
 * `hasConsentPurpose` applies, set-wise; with no live definition nobody is). Each learner's
 * observations per skill come from the projector's own rule (`masteryObservationsBySkill`), and are
 * written without any learner key, sorted, so neither content nor order links two rows to a person.
 */
export async function exportBktRefit(db: PersistenceDb): Promise<{ export: BktExport; baseline: RecalibrationBaseline }> {
  const runId = randomUUID();
  const clock = await db.execute(sql`SELECT now() AS exported_at`) as QueryResult<{ exported_at: Date | string }>;
  const exportedAt = new Date(clock.rows[0]!.exported_at).toISOString();
  const learners = await db.execute(sql`
    SELECT DISTINCT e.subject_user_id::text AS subject_user_id
    FROM learning_attempt_events e
    WHERE ${consentPurposeHeldSql('model-improvement', sql`e.subject_user_id`)}
  `) as QueryResult<{ subject_user_id: string }>;
  const sequences: [string, string][] = [];
  for (const { subject_user_id: subjectUserId } of learners.rows) {
    for (const [skillId, observed] of masteryObservationsBySkill(await loadProjectionAttempts(db, subjectUserId))) {
      if (observed.length > 0) sequences.push([skillId.toLowerCase(), observed.map((correct) => (correct ? '1' : '0')).join('')]);
    }
  }
  sequences.sort(([sa, oa], [sb, ob]) => (sa === sb ? (oa < ob ? -1 : oa > ob ? 1 : 0) : sa < sb ? -1 : 1));
  const accepted = await currentAcceptedBktRun(db);
  return {
    export: { format: BKT_EXPORT_FORMAT, runId, exportedAt, sequences },
    baseline: {
      format: RECALIBRATION_BASELINE_FORMAT,
      kind: 'BKT',
      runId,
      baselineDigest: bktBaselineDigest(accepted?.id ?? null),
      previousRunId: accepted?.id ?? null,
      skills: accepted
        ? accepted.results.skills.filter((skill) => skill.status === 'FITTED').map((skill) => ({
          skillId: skill.skillId,
          parameters: skill.parameters!,
          standardErrors: skill.standardErrors!,
        }))
        : [],
    },
  };
}

// --- Strict validation of the job's proposal -------------------------------------------------------

function fail(message: string): never {
  throw new RecalibrationError('INVALID', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where}: unexpected field "${key}"`);
  for (const key of keys) if (!(key in value)) fail(`${where}: missing field "${key}"`);
  return value;
}

function count(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${where} must be a non-negative integer`);
  return value;
}

function finite(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where} must be a finite number`);
  return value;
}

function uuid(value: unknown, where: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) fail(`${where} must be a lower-case UUID`);
  return value;
}

function timestamp(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) fail(`${where} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(`${where} must be one of ${allowed.join(', ')}`);
  return value as T;
}

export interface BktSkillResult {
  skillId: string;
  learners: number;
  observations: number;
  status: 'FITTED' | 'DEFAULT';
  statusReason: (typeof BKT_STATUS_REASONS)[number] | null;
  parameters: Record<BktParameterName, number> | null;
  standardErrors: Record<BktParameterName, number> | null;
}

export interface BktResults {
  format: typeof BKT_RESULTS_FORMAT;
  runId: string;
  algorithmId: typeof BKT_FIT_ALGORITHM_ID;
  library: string;
  minLearners: number;
  exportedAt: string;
  generatedAt: string;
  sequencesRead: number;
  observationsRead: number;
  skillsRead: number;
  skills: BktSkillResult[];
}

function fittedParameters(skill: Pick<BktSkillResult, 'parameters'>, runId: string): BktParameters {
  const p = skill.parameters!;
  return { pInit: p.pInit, pLearn: p.pLearn, pGuess: p.pGuess, pSlip: p.pSlip, source: 'FITTED', fitRunId: runId };
}

const bktResultKeys = ['format', 'runId', 'algorithmId', 'library', 'minLearners', 'exportedAt', 'generatedAt', 'sequencesRead', 'observationsRead', 'skillsRead', 'skills'] as const;
const bktSkillKeys = ['skillId', 'learners', 'observations', 'status', 'statusReason', 'parameters', 'standardErrors'] as const;

/**
 * Validates a BKT fit's results. A FITTED skill must pass mastery-bkt's own admissibility check, so an
 * accepted set can always be loaded; its standard errors must be within the job's precision bound.
 */
export function parseBktResults(value: unknown, expectedRunId?: string): BktResults {
  const doc = exactKeys(value, bktResultKeys, 'results');
  if (doc.format !== BKT_RESULTS_FORMAT) fail(`results.format must be ${BKT_RESULTS_FORMAT}`);
  const runId = uuid(doc.runId, 'results.runId');
  if (expectedRunId !== undefined && runId !== expectedRunId) fail('results.runId must be the run id');
  if (doc.algorithmId !== BKT_FIT_ALGORITHM_ID) fail(`results.algorithmId must be ${BKT_FIT_ALGORITHM_ID}`);
  if (typeof doc.library !== 'string' || doc.library.trim().length < 1 || doc.library.length > 200) fail('results.library must be 1-200 characters');
  const minLearners = count(doc.minLearners, 'results.minLearners');
  if (minLearners < 1) fail('results.minLearners must be at least 1');
  if (!Array.isArray(doc.skills) || doc.skills.length > MAX_UNITS) fail('results.skills must be a list');
  const seen = new Set<string>();
  const skills = doc.skills.map((raw, index): BktSkillResult => {
    const where = `results.skills[${index}]`;
    const skill = exactKeys(raw, bktSkillKeys, where);
    const skillId = uuid(skill.skillId, `${where}.skillId`);
    if (seen.has(skillId)) fail(`${where}: a skill appears once`);
    seen.add(skillId);
    const status = oneOf(skill.status, ['FITTED', 'DEFAULT'] as const, `${where}.status`);
    const learners = count(skill.learners, `${where}.learners`);
    const observations = count(skill.observations, `${where}.observations`);
    if (status === 'DEFAULT') {
      const statusReason = oneOf(skill.statusReason, BKT_STATUS_REASONS, `${where}.statusReason`);
      if (skill.parameters !== null || skill.standardErrors !== null) fail(`${where}: a DEFAULT skill carries no parameters`);
      return { skillId, learners, observations, status, statusReason, parameters: null, standardErrors: null };
    }
    if (skill.statusReason !== null) fail(`${where}: a FITTED skill has no status reason`);
    if (learners < minLearners) fail(`${where}: a FITTED skill needs at least minLearners learners`);
    const parameters = exactKeys(skill.parameters, BKT_PARAMETER_NAMES, `${where}.parameters`);
    const errors = exactKeys(skill.standardErrors, BKT_PARAMETER_NAMES, `${where}.standardErrors`);
    const p = Object.fromEntries(BKT_PARAMETER_NAMES.map((name) => [name, finite(parameters[name], `${where}.parameters.${name}`)])) as Record<BktParameterName, number>;
    const se = Object.fromEntries(BKT_PARAMETER_NAMES.map((name) => {
      const error = finite(errors[name], `${where}.standardErrors.${name}`);
      if (error < 0 || error > BKT_MAX_STANDARD_ERROR) fail(`${where}.standardErrors.${name} must lie within [0, ${BKT_MAX_STANDARD_ERROR}]`);
      return [name, error];
    })) as Record<BktParameterName, number>;
    try {
      validateParameters(fittedParameters({ parameters: p }, runId));
    } catch (error) {
      if (error instanceof MasteryBktError) fail(`${where}: ${error.message}`);
      throw error;
    }
    return { skillId, learners, observations, status, statusReason: null, parameters: p, standardErrors: se };
  });
  const skillsRead = count(doc.skillsRead, 'results.skillsRead');
  if (skillsRead !== skills.length) fail('results.skillsRead must equal the number of skills');
  return {
    format: BKT_RESULTS_FORMAT,
    runId,
    algorithmId: BKT_FIT_ALGORITHM_ID,
    library: doc.library,
    minLearners,
    exportedAt: timestamp(doc.exportedAt, 'results.exportedAt'),
    generatedAt: timestamp(doc.generatedAt, 'results.generatedAt'),
    sequencesRead: count(doc.sequencesRead, 'results.sequencesRead'),
    observationsRead: count(doc.observationsRead, 'results.observationsRead'),
    skillsRead,
    skills,
  };
}

export interface ComparedParameter {
  name: string;
  scale: 'absolute' | 'log-ratio';
  previous: number;
  proposed: number;
  change: number;
  seDifference: number;
  tolerance: number;
  drifted: boolean;
}

export interface ReportUnit {
  key: string;
  previousStatus: string | null;
  proposedStatus: string | null;
  /** BKT only: learners whose sequences the skill was fitted from; 1-4 print as "<5". */
  learners?: number | '<5' | null;
  change: RecalibrationChange;
  parameters: ComparedParameter[];
}

export interface RecalibrationReport {
  format: typeof RECALIBRATION_REPORT_FORMAT;
  kind: RecalibrationKind;
  runId: string;
  algorithmId: string;
  baselineDigest: string;
  bounds: Record<string, number>;
  verdict: RecalibrationVerdict;
  counts: Record<RecalibrationChange, number>;
  units: ReportUnit[];
}

const reportKeys = ['format', 'kind', 'runId', 'algorithmId', 'baselineDigest', 'bounds', 'verdict', 'counts', 'units'] as const;
const parameterKeys = ['name', 'scale', 'previous', 'proposed', 'change', 'seDifference', 'tolerance', 'drifted'] as const;
const boundKeys: Record<RecalibrationKind, readonly string[]> = {
  ITEM_2PL: ['z', 'difficultyFloor', 'discriminationLogRatioFloor'],
  BKT: ['z', 'probabilityFloor'],
};
const parameterNames: Record<RecalibrationKind, readonly string[]> = { ITEM_2PL: ['difficulty', 'discrimination'], BKT: BKT_PARAMETER_NAMES };

export function verdictOf(counts: Record<RecalibrationChange, number>): RecalibrationVerdict {
  if (counts.DRIFTED > 0) return 'DRIFTED';
  return counts.STABLE > 0 ? 'STABLE' : 'NO_COMPARISON';
}

/** Validates the comparison report: exact shape, counts and verdict consistent with the units. */
export function parseRecalibrationReport(value: unknown, kind: RecalibrationKind, runId: string, algorithmId: string, baselineDigest: string): RecalibrationReport {
  const doc = exactKeys(value, reportKeys, 'report');
  if (doc.format !== RECALIBRATION_REPORT_FORMAT) fail(`report.format must be ${RECALIBRATION_REPORT_FORMAT}`);
  if (doc.kind !== kind || doc.runId !== runId || doc.algorithmId !== algorithmId || doc.baselineDigest !== baselineDigest) {
    fail('report must belong to this run, kind, algorithm and baseline');
  }
  const boundsDoc = exactKeys(doc.bounds, boundKeys[kind], 'report.bounds');
  const bounds = Object.fromEntries(boundKeys[kind].map((key) => {
    const bound = finite(boundsDoc[key], `report.bounds.${key}`);
    if (bound <= 0) fail(`report.bounds.${key} must be positive`);
    return [key, bound];
  }));
  if (!Array.isArray(doc.units) || doc.units.length > MAX_UNITS) fail('report.units must be a list');
  const unitKeys = kind === 'BKT'
    ? ['key', 'previousStatus', 'proposedStatus', 'learners', 'change', 'parameters']
    : ['key', 'previousStatus', 'proposedStatus', 'change', 'parameters'];
  const statuses = kind === 'BKT' ? ['FITTED', 'DEFAULT'] : ['PROVISIONAL', 'CALIBRATED'];
  const tally = Object.fromEntries(RECALIBRATION_CHANGES.map((change) => [change, 0])) as Record<RecalibrationChange, number>;
  const seen = new Set<string>();
  const units = doc.units.map((raw, index): ReportUnit => {
    const where = `report.units[${index}]`;
    const unit = exactKeys(raw, unitKeys, where);
    if (typeof unit.key !== 'string' || !(kind === 'BKT' ? uuidPattern : itemKeyPattern).test(unit.key)) fail(`${where}.key is malformed`);
    if (seen.has(unit.key)) fail(`${where}: a unit appears once`);
    seen.add(unit.key);
    for (const field of ['previousStatus', 'proposedStatus'] as const) {
      if (unit[field] !== null && !statuses.includes(unit[field] as string)) fail(`${where}.${field} is not a status`);
    }
    const change = oneOf(unit.change, RECALIBRATION_CHANGES, `${where}.change`);
    tally[change] += 1;
    if (!Array.isArray(unit.parameters)) fail(`${where}.parameters must be a list`);
    const parameters = unit.parameters.map((rawParameter, p): ComparedParameter => {
      const at = `${where}.parameters[${p}]`;
      const parameter = exactKeys(rawParameter, parameterKeys, at);
      if (typeof parameter.drifted !== 'boolean') fail(`${at}.drifted must be a boolean`);
      return {
        name: oneOf(parameter.name, parameterNames[kind], `${at}.name`),
        scale: oneOf(parameter.scale, ['absolute', 'log-ratio'] as const, `${at}.scale`),
        previous: finite(parameter.previous, `${at}.previous`),
        proposed: finite(parameter.proposed, `${at}.proposed`),
        change: finite(parameter.change, `${at}.change`),
        seDifference: finite(parameter.seDifference, `${at}.seDifference`),
        tolerance: finite(parameter.tolerance, `${at}.tolerance`),
        drifted: parameter.drifted,
      };
    });
    const compared = change === 'STABLE' || change === 'DRIFTED';
    if (compared !== (parameters.length > 0)) fail(`${where}: only a compared unit carries parameters`);
    if ((change === 'DRIFTED') !== parameters.some((parameter) => parameter.drifted)) fail(`${where}: change and drift flags disagree`);
    const result: ReportUnit = { key: unit.key, previousStatus: unit.previousStatus as string | null, proposedStatus: unit.proposedStatus as string | null, change, parameters };
    if (kind === 'BKT') {
      const learners = unit.learners;
      if (!(learners === null || learners === '<5' || (typeof learners === 'number' && Number.isInteger(learners) && (learners === 0 || learners >= 5)))) {
        fail(`${where}.learners must be a count of 0 or at least 5, "<5", or null`);
      }
      result.learners = learners as number | '<5' | null;
    }
    return result;
  });
  const countsDoc = exactKeys(doc.counts, RECALIBRATION_CHANGES, 'report.counts');
  for (const change of RECALIBRATION_CHANGES) {
    if (count(countsDoc[change], `report.counts.${change}`) !== tally[change]) fail(`report.counts.${change} must match the units`);
  }
  const verdict = oneOf(doc.verdict, ['STABLE', 'DRIFTED', 'NO_COMPARISON'] as const, 'report.verdict');
  if (verdict !== verdictOf(tally)) fail('report.verdict must follow from the counts');
  return { format: RECALIBRATION_REPORT_FORMAT, kind, runId, algorithmId, baselineDigest, bounds, verdict, counts: tally, units };
}

export type RecalibrationProposal =
  | { kind: 'ITEM_2PL'; runId: string; baselineDigest: string; previousRunId: string | null; results: CalibrationResults; report: RecalibrationReport }
  | { kind: 'BKT'; runId: string; baselineDigest: string; previousRunId: string | null; results: BktResults; report: RecalibrationReport };

const proposalKeys = ['format', 'kind', 'runId', 'baselineDigest', 'previousRunId', 'results', 'report'] as const;

/** Validates the job's proposal before anything is written. Pure; throws `RecalibrationError('INVALID')`. */
export function parseRecalibrationProposal(value: unknown): RecalibrationProposal {
  const doc = exactKeys(value, proposalKeys, 'proposal');
  if (doc.format !== RECALIBRATION_PROPOSAL_FORMAT) fail(`proposal.format must be ${RECALIBRATION_PROPOSAL_FORMAT}`);
  const kind = oneOf(doc.kind, RECALIBRATION_KINDS, 'proposal.kind');
  const runId = uuid(doc.runId, 'proposal.runId');
  if (typeof doc.baselineDigest !== 'string' || !/^[0-9a-f]{64}$/.test(doc.baselineDigest)) fail('proposal.baselineDigest must be a sha256 hex digest');
  const previousRunId = doc.previousRunId === null ? null : uuid(doc.previousRunId, 'proposal.previousRunId');
  if (kind === 'ITEM_2PL') {
    let results: CalibrationResults;
    try {
      results = parseCalibrationResults(doc.results);
    } catch (error) {
      if (error instanceof CalibrationResultsError) fail(error.message);
      throw error;
    }
    if (results.runId.toLowerCase() !== runId) fail('results.runId must be the run id');
    const report = parseRecalibrationReport(doc.report, kind, runId, CALIBRATION_ALGORITHM_ID, doc.baselineDigest);
    const reported = new Set(report.units.map((unit) => unit.key));
    if (!results.items.every((item) => reported.has(calibrationItemKey(item)))) fail('report must cover every refitted item');
    return { kind, runId, baselineDigest: doc.baselineDigest, previousRunId, results, report };
  }
  const results = parseBktResults(doc.results, runId);
  const report = parseRecalibrationReport(doc.report, kind, runId, BKT_FIT_ALGORITHM_ID, doc.baselineDigest);
  const reported = new Set(report.units.map((unit) => unit.key));
  if (!results.skills.every((skill) => reported.has(skill.skillId))) fail('report must cover every refitted skill');
  return { kind, runId, baselineDigest: doc.baselineDigest, previousRunId, results, report };
}

// --- Recording, deciding, reverting ------------------------------------------------------------------

export interface RecordOutcome {
  runId: string;
  kind: RecalibrationKind;
  recorded: boolean;
  verdict: RecalibrationVerdict;
  counts: Record<RecalibrationChange, number>;
}

/** Stores a validated proposal as a PENDING run. Replaying the same run is a no-op. */
export async function recordRecalibrationProposal(db: PersistenceDb, input: unknown): Promise<RecordOutcome> {
  const proposal = parseRecalibrationProposal(input);
  const { results, report } = proposal;
  const threshold = proposal.kind === 'ITEM_2PL' ? proposal.results.minResponses : proposal.results.minLearners;
  const unitsRead = proposal.kind === 'ITEM_2PL' ? proposal.results.itemsRead : proposal.results.skillsRead;
  const observationsRead = proposal.kind === 'ITEM_2PL' ? proposal.results.responsesRead : proposal.results.observationsRead;
  const inserted = await db.execute(sql`
    INSERT INTO recalibration_runs
      (id, kind, source, algorithm_id, library, threshold, units_read, observations_read, units_compared, units_drifted,
       verdict, baseline_digest, previous_run_id, results, report, exported_at, generated_at)
    VALUES (${proposal.runId}::uuid, ${proposal.kind}, 'jobs/calibration', ${results.algorithmId}, ${results.library}, ${threshold},
            ${unitsRead}, ${observationsRead}, ${report.counts.STABLE + report.counts.DRIFTED}, ${report.counts.DRIFTED},
            ${report.verdict}, ${proposal.baselineDigest}, ${proposal.previousRunId}::uuid,
            ${JSON.stringify(results)}::jsonb, ${JSON.stringify(report)}::jsonb,
            ${results.exportedAt}::timestamptz, ${results.generatedAt}::timestamptz)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `) as QueryResult<{ id: string }>;
  return { runId: proposal.runId, kind: proposal.kind, recorded: inserted.rows.length > 0, verdict: report.verdict, counts: report.counts };
}

export interface StoredRecalibrationRun {
  id: string;
  kind: RecalibrationKind;
  algorithmId: string;
  library: string;
  threshold: number;
  unitsRead: number;
  observationsRead: number;
  verdict: RecalibrationVerdict;
  baselineDigest: string;
  previousRunId: string | null;
  exportedAt: string;
  generatedAt: string;
  recordedAt: string;
  results: CalibrationResults | BktResults;
  report: RecalibrationReport;
  decisions: { decision: RecalibrationDecision; reason: string; itemRunId: string | null; decidedAt: string }[];
}

type RunRow = {
  id: string; kind: RecalibrationKind; algorithm_id: string; library: string; threshold: number; units_read: number;
  observations_read: number; verdict: RecalibrationVerdict; baseline_digest: string; previous_run_id: string | null;
  exported_at: Date | string; generated_at: Date | string; recorded_at: Date | string; results: unknown; report: unknown;
};

export async function loadRecalibrationRun(db: PersistenceDb, runId: string): Promise<StoredRecalibrationRun | null> {
  if (!uuidPattern.test(runId)) throw new RecalibrationError('INVALID', 'run id must be a lower-case UUID');
  const found = await db.execute(sql`
    SELECT id::text AS id, kind, algorithm_id, library, threshold, units_read, observations_read, verdict, baseline_digest,
           previous_run_id::text AS previous_run_id, exported_at, generated_at, recorded_at, results, report
    FROM recalibration_runs WHERE id = ${runId}::uuid
  `) as QueryResult<RunRow>;
  const row = found.rows[0];
  if (!row) return null;
  const decisions = await db.execute(sql`
    SELECT decision, reason, item_run_id::text AS item_run_id, decided_at
    FROM recalibration_decisions WHERE run_id = ${runId}::uuid ORDER BY decided_at, id
  `) as QueryResult<{ decision: RecalibrationDecision; reason: string; item_run_id: string | null; decided_at: Date | string }>;
  return {
    id: row.id,
    kind: row.kind,
    algorithmId: row.algorithm_id,
    library: row.library,
    threshold: Number(row.threshold),
    unitsRead: Number(row.units_read),
    observationsRead: Number(row.observations_read),
    verdict: row.verdict,
    baselineDigest: row.baseline_digest,
    previousRunId: row.previous_run_id,
    exportedAt: new Date(row.exported_at).toISOString(),
    generatedAt: new Date(row.generated_at).toISOString(),
    recordedAt: new Date(row.recorded_at).toISOString(),
    results: row.kind === 'BKT' ? parseBktResults(row.results, row.id) : parseCalibrationResults(row.results),
    report: row.report as RecalibrationReport,
    decisions: decisions.rows.map((d) => ({ decision: d.decision, reason: d.reason, itemRunId: d.item_run_id, decidedAt: new Date(d.decided_at).toISOString() })),
  };
}

export interface RecalibrationRunSummary {
  id: string;
  kind: RecalibrationKind;
  verdict: RecalibrationVerdict;
  unitsCompared: number;
  unitsDrifted: number;
  recordedAt: string;
  state: 'PENDING' | RecalibrationDecision;
}

/** The latest runs, newest first, with their state — what `engine:recalibration list` prints. */
export async function listRecalibrationRuns(db: PersistenceDb, limit = 20): Promise<RecalibrationRunSummary[]> {
  const result = await db.execute(sql`
    SELECT r.id::text AS id, r.kind, r.verdict, r.units_compared, r.units_drifted, r.recorded_at,
           COALESCE((SELECT d.decision FROM recalibration_decisions d WHERE d.run_id = r.id ORDER BY d.decided_at DESC, d.id DESC LIMIT 1), 'PENDING') AS state
    FROM recalibration_runs r
    ORDER BY r.recorded_at DESC, r.id DESC
    LIMIT ${Math.max(1, Math.min(200, Math.trunc(limit)))}
  `) as QueryResult<{ id: string; kind: RecalibrationKind; verdict: RecalibrationVerdict; units_compared: number; units_drifted: number; recorded_at: Date | string; state: RecalibrationRunSummary['state'] }>;
  return result.rows.map((row) => ({
    id: row.id, kind: row.kind, verdict: row.verdict, unitsCompared: Number(row.units_compared),
    unitsDrifted: Number(row.units_drifted), recordedAt: new Date(row.recorded_at).toISOString(), state: row.state,
  }));
}

function checkReason(reason: string): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length < 1 || trimmed.length > 500) throw new RecalibrationError('INVALID', 'a reason of 1-500 characters is required');
  return trimmed;
}

export interface DecisionOutcome {
  runId: string;
  kind: RecalibrationKind;
  decision: RecalibrationDecision;
  itemRunId: string | null;
  imported: { calibrated: number; provisional: number } | null;
}

async function lock(tx: PersistenceDb): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
}

/**
 * Accept or reject a PENDING run, once. Accepting refuses a proposal whose baseline is no longer the
 * live state (something was imported or accepted since); accepting an item run imports its results
 * through ENG-13's importer in the same transaction. Accepting a BKT run changes nothing live.
 */
export async function decideRecalibration(
  db: PersistenceDb,
  input: { runId: string; decision: 'ACCEPTED' | 'REJECTED'; reason: string },
): Promise<DecisionOutcome> {
  const reason = checkReason(input.reason);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as PersistenceDb;
    await lock(tx);
    const run = await loadRecalibrationRun(tx, input.runId);
    if (!run) throw new RecalibrationError('NOT_FOUND', 'no recalibration run has that id');
    if (run.decisions.some((d) => d.decision === 'ACCEPTED' || d.decision === 'REJECTED')) {
      throw new RecalibrationError('ALREADY_DECIDED', 'this run has already been decided');
    }
    let itemRunId: string | null = null;
    let imported: DecisionOutcome['imported'] = null;
    if (input.decision === 'ACCEPTED') {
      if ((await currentDigest(tx, run.kind)) !== run.baselineDigest) {
        throw new RecalibrationError('STALE', 'the live parameters changed after this run was compared; run the recalibration again');
      }
      if (run.kind === 'ITEM_2PL') {
        const outcome = await importCalibrationResults(tx, run.results);
        if (!outcome.imported) throw new RecalibrationError('ALREADY_IMPORTED', 'an item run with this id was already imported');
        itemRunId = run.id;
        imported = { calibrated: outcome.calibrated, provisional: outcome.provisional };
      }
    }
    await tx.execute(sql`
      INSERT INTO recalibration_decisions (id, run_id, decision, reason, item_run_id)
      VALUES (${randomUUID()}::uuid, ${run.id}::uuid, ${input.decision}, ${reason}, ${itemRunId}::uuid)
    `);
    return { runId: run.id, kind: run.kind, decision: input.decision, itemRunId, imported };
  });
}

export interface RevertOutcome extends DecisionOutcome {
  /** Items of the reverted run now back on the parameters that were live before it. */
  restored: number;
  /** Items the reverted run calibrated for the first time (none, or only a provisional row, before):
   *  they stay calibrated, because the reader prefers CALIBRATED and rows are never removed (see design). */
  notRestorable: number;
}

/**
 * Roll back an accepted run. Items: only while it is still the latest imported item run; writes a new
 * item run copying, for every item the run touched, the calibration live before it (both tables are
 * append-only, so rollback is a newer run). BKT: records the revert; the previous accepted fit is
 * current again.
 */
export async function revertRecalibration(db: PersistenceDb, input: { runId: string; reason: string }): Promise<RevertOutcome> {
  const reason = checkReason(input.reason);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as PersistenceDb;
    await lock(tx);
    const run = await loadRecalibrationRun(tx, input.runId);
    if (!run) throw new RecalibrationError('NOT_FOUND', 'no recalibration run has that id');
    if (!run.decisions.some((d) => d.decision === 'ACCEPTED')) throw new RecalibrationError('NOT_ACCEPTED', 'only an accepted run can be reverted');
    if (run.decisions.some((d) => d.decision === 'REVERTED')) throw new RecalibrationError('ALREADY_DECIDED', 'this run has already been reverted');

    if (run.kind === 'BKT') {
      await tx.execute(sql`
        INSERT INTO recalibration_decisions (id, run_id, decision, reason) VALUES (${randomUUID()}::uuid, ${run.id}::uuid, 'REVERTED', ${reason})
      `);
      return { runId: run.id, kind: run.kind, decision: 'REVERTED', itemRunId: null, imported: null, restored: 0, notRestorable: 0 };
    }

    const latest = await tx.execute(sql`
      SELECT id::text AS id FROM item_calibration_runs ORDER BY exported_at DESC, recorded_at DESC, id DESC LIMIT 1
    `) as QueryResult<{ id: string }>;
    if (latest.rows[0]?.id !== run.id) {
      throw new RecalibrationError('NOT_LATEST', 'a later item run was imported after this one; revert that one first');
    }
    const previous = await tx.execute(sql`
      SELECT DISTINCT ON (c.item_source, c.item_id, c.item_version)
        c.item_source, c.item_id::text AS item_id, c.item_version, c.status, c.status_reason,
        c.difficulty::float8 AS difficulty, c.discrimination::float8 AS discrimination, c.responses_used, r.min_responses
      FROM item_calibrations mine
      JOIN item_calibrations c
        ON c.item_source = mine.item_source AND c.item_id = mine.item_id AND c.item_version = mine.item_version AND c.run_id <> mine.run_id
      JOIN item_calibration_runs r ON r.id = c.run_id
      WHERE mine.run_id = ${run.id}::uuid
        AND r.exported_at < (SELECT exported_at FROM item_calibration_runs WHERE id = ${run.id}::uuid)
      ORDER BY c.item_source, c.item_id, c.item_version,
               (c.status = 'CALIBRATED') DESC, r.exported_at DESC, c.recorded_at DESC, c.id DESC
    `) as QueryResult<{
      item_source: CalibrationItemSource; item_id: string; item_version: number; status: CalibrationStatus; status_reason: string | null;
      difficulty: number; discrimination: number; responses_used: number; min_responses: number;
    }>;
    // An item the reverted run calibrated, whose earlier row was only PROVISIONAL (or which had none),
    // stays on the reverted run's calibration: the reader prefers CALIBRATED (ENG-13), and rows are never removed.
    const before = new Map(previous.rows.map((row) => [calibrationItemKey({ itemSource: row.item_source, itemId: row.item_id, itemVersion: Number(row.item_version) }), row.status]));
    const reverted = (run.results as CalibrationResults).items;
    const notRestorable = reverted.filter((item) => {
      const earlier = before.get(calibrationItemKey(item));
      return earlier === undefined || (earlier === 'PROVISIONAL' && item.status === 'CALIBRATED');
    }).length;
    // Strictly after the reverted run's export, so the restoring run is the latest the reader sees.
    const clock = await tx.execute(sql`
      SELECT greatest(clock_timestamp(), (SELECT exported_at FROM item_calibration_runs WHERE id = ${run.id}::uuid) + interval '1 millisecond') AS now
    `) as QueryResult<{ now: Date | string }>;
    const now = new Date(clock.rows[0]!.now).toISOString();
    const calibratedThresholds = previous.rows.filter((row) => row.status === 'CALIBRATED').map((row) => Number(row.min_responses));
    const restoreRunId = randomUUID();
    const outcome = await importCalibrationResults(tx, {
      format: 'one-calibration-results-v1',
      runId: restoreRunId,
      algorithmId: CALIBRATION_ALGORITHM_ID,
      library: `revert-of:${run.id}`,
      minResponses: calibratedThresholds.length > 0 ? Math.min(...calibratedThresholds) : run.threshold,
      exportedAt: now,
      generatedAt: now,
      // A revert reads nobody: it copies rows. Their response counts carry over, so the run's total is their sum.
      learnersRead: 0,
      responsesRead: previous.rows.reduce((total, row) => total + Number(row.responses_used), 0),
      itemsRead: previous.rows.length,
      items: previous.rows.map((row) => ({
        itemSource: row.item_source,
        itemId: row.item_id,
        itemVersion: Number(row.item_version),
        model: '2PL',
        difficulty: Number(row.difficulty),
        discrimination: Number(row.discrimination),
        responsesUsed: Number(row.responses_used),
        status: row.status,
        statusReason: row.status_reason,
      })),
    });
    await tx.execute(sql`
      INSERT INTO recalibration_decisions (id, run_id, decision, reason, item_run_id)
      VALUES (${randomUUID()}::uuid, ${run.id}::uuid, 'REVERTED', ${reason}, ${restoreRunId}::uuid)
    `);
    return {
      runId: run.id, kind: run.kind, decision: 'REVERTED', itemRunId: restoreRunId,
      imported: { calibrated: outcome.calibrated, provisional: outcome.provisional },
      restored: reverted.length - notRestorable, notRestorable,
    };
  });
}

/**
 * ENG-27's reader: the FITTED per-skill parameters of the accepted, unreverted BKT run, each
 * validated by mastery-bkt and stamped with its run, keyed by skill id. Empty when nothing is
 * accepted. Nothing calls this on the live path in ENG-26 — the projector passes no fitted
 * parameters until HG-5.
 */
export async function acceptedBktParameters(db: PersistenceDb): Promise<Map<string, BktParameters>> {
  const accepted = await currentAcceptedBktRun(db);
  const parameters = new Map<string, BktParameters>();
  if (!accepted) return parameters;
  for (const skill of accepted.results.skills) {
    if (skill.status !== 'FITTED') continue;
    const set = fittedParameters(skill, accepted.id);
    validateParameters(set);
    parameters.set(skill.skillId, set);
  }
  return parameters;
}

// --- The human-readable report ----------------------------------------------------------------------

function fixed(value: number): string {
  return value.toFixed(4);
}

const changeMeaning: Record<RecalibrationChange, string> = {
  STABLE: 'compared; within the stability bounds',
  DRIFTED: 'compared; moved beyond the stability bounds',
  NEW: 'fitted now, nothing fitted before',
  NEWLY_CALIBRATED: 'was provisional, now calibrated',
  LOST_CALIBRATION: 'was calibrated, this fit is not (live keeps the old calibration)',
  NOT_REFITTED: 'live, but not in this month\'s data (live keeps its parameters)',
  NOT_CALIBRATED: 'provisional / default before and after',
};

/** Markdown for Divakar: what was fitted, what would change, and what accepting does. */
export function renderRecalibrationMarkdown(run: StoredRecalibrationRun): string {
  const report = run.report;
  const items = run.kind === 'ITEM_2PL';
  const title = items ? 'Item recalibration (2PL)' : 'BKT refit';
  const state = run.decisions.length === 0 ? 'PENDING' : run.decisions[run.decisions.length - 1]!.decision;
  const lines: string[] = [
    `# ${title} — run ${run.id}`,
    '',
    `- **State:** ${state}`,
    `- **Verdict:** ${report.verdict}`,
    `- **Algorithm:** ${run.algorithmId} (${run.library})`,
    `- **Threshold:** ${items ? 'min responses per item' : 'min learners per skill'} ${run.threshold}`,
    `- **Read:** ${run.unitsRead} ${items ? 'items' : 'skills'}, ${run.observationsRead} ${items ? 'responses' : 'observations'}`,
    `- **Exported:** ${run.exportedAt} · **Fitted:** ${run.generatedAt} · **Recorded:** ${run.recordedAt}`,
    `- **Compared against:** ${run.previousRunId ? `run ${run.previousRunId}` : items ? 'no imported run' : 'the provisional defaults (no accepted BKT fit)'}`,
    '',
    '## What the verdict means',
    '',
    report.verdict === 'DRIFTED'
      ? `${report.counts.DRIFTED} ${items ? 'item(s)' : 'skill(s)'} moved more than sampling noise explains and more than the practical floor. Read the table below before accepting.`
      : report.verdict === 'STABLE'
        ? 'Every compared parameter stayed within the stability bounds.'
        : 'Nothing could be compared (a first run, or nothing fitted on both sides).',
    '',
    '## Stability bounds',
    '',
    'A parameter has drifted when |proposed − previous| > max(floor, z × SE of the difference).',
    '',
    '| Bound | Value |',
    '| --- | --- |',
    ...Object.entries(report.bounds).map(([name, value]) => `| ${name} | ${value} |`),
    '',
    '## Counts',
    '',
    '| Change | Count | Meaning |',
    '| --- | --- | --- |',
    ...RECALIBRATION_CHANGES.map((change) => `| ${change} | ${report.counts[change]} | ${changeMeaning[change]} |`),
    '',
  ];
  const drifted = report.units.filter((unit) => unit.change === 'DRIFTED');
  lines.push('## Drifted', '');
  if (drifted.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push(`| ${items ? 'Item' : 'Skill'} | Parameter | Previous | Proposed | Change | Tolerance | Scale |`, '| --- | --- | --- | --- | --- | --- | --- |');
    for (const unit of drifted) {
      for (const parameter of unit.parameters.filter((p) => p.drifted)) {
        lines.push(`| ${unit.key} | ${parameter.name} | ${fixed(parameter.previous)} | ${fixed(parameter.proposed)} | ${fixed(parameter.change)} | ${fixed(parameter.tolerance)} | ${parameter.scale} |`);
      }
    }
    lines.push('');
  }
  // The proposed values, so a first fit can be read too (there is nothing to compare it with).
  const proposed = new Map<string, string>();
  if (items) {
    for (const item of (run.results as CalibrationResults).items) {
      proposed.set(calibrationItemKey(item), `b ${fixed(item.difficulty)}, a ${fixed(item.discrimination)}`);
    }
  } else {
    for (const skill of (run.results as BktResults).skills) {
      if (skill.parameters && skill.standardErrors) {
        const p = skill.parameters;
        const se = skill.standardErrors;
        proposed.set(skill.skillId, BKT_PARAMETER_NAMES.map((name) => `${name} ${fixed(p[name])} ± ${fixed(se[name])}`).join(', '));
      } else {
        proposed.set(skill.skillId, `defaults kept (${skill.statusReason ?? 'DEFAULT'})`);
      }
    }
  }
  const attention = report.units.filter((unit) => unit.change === 'LOST_CALIBRATION' || unit.change === 'NEW' || unit.change === 'NEWLY_CALIBRATED');
  if (attention.length > 0) {
    lines.push('## Status changes', '', `| ${items ? 'Item' : 'Skill'} | Change | Before | After | Proposed |`, '| --- | --- | --- | --- | --- |');
    for (const unit of attention.slice(0, 500)) {
      lines.push(`| ${unit.key} | ${unit.change} | ${unit.previousStatus ?? '—'} | ${unit.proposedStatus ?? '—'} | ${proposed.get(unit.key) ?? '—'} |`);
    }
    if (attention.length > 500) lines.push(`| … | ${attention.length - 500} more in the JSON report | | | |`);
    lines.push('');
  }
  lines.push(
    '## What a decision does',
    '',
    items
      ? `- **Accept** imports this run's ${run.unitsRead} item parameters into item_calibrations (ENG-13's guards apply); the placement test uses them from its next sitting. Refused if anything was imported since this run was compared.`
      : '- **Accept** records this fit as the accepted BKT parameters. Nothing live reads them: the projector keeps the provisional defaults until ENG-27 / HG-5.',
    '- **Reject** records the decision; nothing changes.',
    items
      ? '- **Revert** (after accept) writes a new run restoring the parameters live before this one; items this run calibrated for the first time stay calibrated.'
      : '- **Revert** (after accept) makes the previously accepted fit current again.',
    '',
    `Commands: \`engine:recalibration accept --run ${run.id} --reason "…"\` · \`reject\` · \`revert\` (docs/ops/runbook-monthly-recalibration.md).`,
    '',
    'Model state about items and skills: parameters and counts only. No learner, and no readiness value, appears in this report or is affected by it.',
    '',
  );
  if (run.decisions.length > 0) {
    lines.push('## Decisions', '', '| Decision | When | Reason |', '| --- | --- | --- |');
    for (const decision of run.decisions) lines.push(`| ${decision.decision} | ${decision.decidedAt} | ${decision.reason.replace(/[|\r\n]+/g, ' ')} |`);
    lines.push('');
  }
  return lines.join('\n');
}
