/**
 * Recording a bake-off (ENG-21): registering ONE's first AI features (switched off) and turning a
 * results file from the pod into `ai_evaluations` records, as an operator.
 *
 * Why this exists: OPS-12 (0089) lets a feature switch on only with a passing evaluation for its
 * exact model and prompt. This is the one path from a run to those records. It re-scores the raw
 * replies with the repository's own code (never trusting numbers in a file), refuses results that
 * do not belong to this repository's evaluation set, requires a human review sheet for a PASS on a
 * feature people read, checks the recorder holds AI_OPS_CONFIGURE, and records every feature in one
 * transaction through `recordAiEvaluation` (audit row and outbox event each). It never switches a
 * feature on and never changes a policy's model.
 *
 * Design: docs/architecture/ai-bake-off-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { oneAiFeatures, type AiFeatureDeclaration } from '@planthepath/ai-orchestration/src/index.js';
import {
  BakeOffResultsError,
  BakeOffReviewError,
  BAKE_OFF_CHECKS_VERSION,
  costTasks,
  describeCostAssumptions,
  evaluateResultsText,
  type CostAssumptions,
  type EvaluationTask,
  type FeatureScore,
  type Scorecard,
} from '@planthepath/ai-evaluation/src/index.js';
import {
  aiConfigureIsBreakGlass,
  aiEvaluationRecordReasons,
  canConfigureAi,
  readAiEvaluationMetrics,
  type InternalCapabilityContext,
} from '@planthepath/authorization/src/index.js';
import { recordAiEvaluation, type AiActor, type SqlRunner } from './ai-operations.js';

type Db = SqlRunner & { transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> };

async function rows<T>(runner: SqlRunner, query: ReturnType<typeof sql>): Promise<T[]> {
  return ((await runner.execute(query)) as { rows: T[] }).rows;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Insert each declared feature that has no policy row, switched off (0033 default), with its declared
 * model, cap and prompt. An existing row is left exactly as it is — its model, limits and switch are
 * the console's. Reports which were registered and which already existed (and whether their prompt
 * differs from the declaration, which only a release changes).
 */
export async function registerOneAiFeatures(runner: SqlRunner, features: readonly AiFeatureDeclaration[] = oneAiFeatures): Promise<{
  readonly registered: readonly string[];
  readonly existing: readonly { readonly featureKey: string; readonly promptMatches: boolean }[];
}> {
  const registered: string[] = [];
  const existing: { featureKey: string; promptMatches: boolean }[] = [];
  for (const feature of features) {
    const inserted = await rows<{ feature_key: string }>(runner, sql`
      INSERT INTO ai_feature_policies (feature_key, description, model, cap, cap_window, max_input_chars, prompt_key, prompt_version)
      VALUES (${feature.featureKey}, ${feature.description}, ${feature.defaultModel}, ${feature.defaultCap}, ${feature.defaultWindow},
              ${feature.maxInputChars}, ${feature.prompt.key}, ${feature.prompt.version})
      ON CONFLICT (feature_key) DO NOTHING
      RETURNING feature_key
    `);
    if (inserted.length) { registered.push(feature.featureKey); continue; }
    const current = await rows<{ prompt_key: string | null; prompt_version: number | null }>(runner, sql`
      SELECT prompt_key, prompt_version FROM ai_feature_policies WHERE feature_key = ${feature.featureKey}
    `);
    existing.push({ featureKey: feature.featureKey, promptMatches: current[0]?.prompt_key === feature.prompt.key && Number(current[0]?.prompt_version) === feature.prompt.version });
  }
  return { registered, existing };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type BakeOffImportErrorCode =
  | 'RESULTS_MALFORMED'
  | 'RESULTS_SET_MISMATCH'
  | 'RESULTS_CASES_MISMATCH'
  | 'RESULTS_MODEL_INVALID'
  | 'RESULTS_PARTIAL'
  | 'RESULTS_ALREADY_RECORDED'
  | 'REVIEW_MALFORMED'
  | 'REVIEW_RESULTS_MISMATCH'
  | 'REVIEW_INCOMPLETE'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'FEATURE_NOT_REGISTERED'
  | 'FEATURE_UNKNOWN'
  | 'RECORDER_NOT_AUTHORISED'
  | 'REASON_CODE_INVALID'
  | 'METRICS_REJECTED';

export class BakeOffImportError extends Error {
  constructor(readonly code: BakeOffImportErrorCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'BakeOffImportError';
  }
}

export interface BakeOffImportInput {
  readonly resultsText: string;
  readonly reviewText?: string | undefined;
  /** Who records: a user who holds AI_OPS_CONFIGURE. */
  readonly recorderUserId: string;
  /** One of OPS-12's evaluation reasons; INITIAL_BENCHMARK by default. */
  readonly reasonCode?: string | undefined;
  /** FAIL records a FAIL whatever the numbers (0089 allows it); AUTO follows the thresholds. */
  readonly decision?: 'AUTO' | 'FAIL' | undefined;
  /** Record only these feature keys; every feature the results' set evaluates by default. */
  readonly onlyFeatures?: readonly string[] | undefined;
  readonly cost?: CostAssumptions | undefined;
  /** Score, check and plan, but write nothing. */
  readonly dryRun?: boolean | undefined;
  /** Tests only: feature keys per task. */
  readonly featureKeys?: Partial<Readonly<Record<EvaluationTask, string>>> | undefined;
}

export interface PlannedEvaluation {
  readonly featureKey: string;
  readonly model: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly decision: 'PASS' | 'FAIL';
  readonly failedMetrics: readonly string[];
  readonly evaluationId: string | null;
}

export interface BakeOffImportOutcome {
  readonly dryRun: boolean;
  readonly resultsSha256: string;
  readonly scorecard: Scorecard;
  readonly evaluations: readonly PlannedEvaluation[];
}

async function recorderContext(runner: SqlRunner, userId: string): Promise<InternalCapabilityContext | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(userId)) return null;
  const memberships = await rows<{ id: string; role: string; state: string }>(runner, sql`
    SELECT m.id, m.role, m.state::text AS state FROM organization_memberships m JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ${userId}::uuid AND u.state = 'ACTIVE'
  `);
  if (!memberships.length) return null;
  const grants = await rows<{ membership_id: string; capability: string }>(runner, sql`
    SELECT membership_id, capability FROM membership_capabilities
    WHERE revoked_at IS NULL AND membership_id IN (${sql.join(memberships.map((entry) => sql`${entry.id}::uuid`), sql`, `)})
  `);
  return {
    memberships: memberships.map((entry) => ({
      role: entry.role, state: entry.state,
      grants: grants.filter((grant) => grant.membership_id === entry.id).map((grant) => grant.capability),
    })),
  };
}

function translate(error: unknown): never {
  if (error instanceof BakeOffResultsError || error instanceof BakeOffReviewError) throw new BakeOffImportError(error.code, error.detail);
  throw error;
}

function note(input: { readonly scorecard: Scorecard; readonly resultsSha256: string; readonly startedAt: string; readonly reviewed: boolean; readonly forcedFail: boolean }): string {
  const text = [
    `bake-off ${input.scorecard.setKey} v${input.scorecard.setVersion}`,
    `results sha256 ${input.resultsSha256}`,
    `run ${input.startedAt}`,
    BAKE_OFF_CHECKS_VERSION,
    `human review ${input.reviewed ? 'yes' : 'no'}`,
    ...(input.forcedFail ? ['FAIL recorded by the operator'] : []),
    describeCostAssumptions(input.scorecard.cost.assumptions, costTasks(input.scorecard.cost)),
  ].join('; ');
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

/**
 * Turn one results file into evaluation records. All-or-nothing: every check runs before anything is
 * written, and every record is written in one transaction.
 */
export async function importBakeOffResults(db: Db, input: BakeOffImportInput): Promise<BakeOffImportOutcome> {
  const reasonCode = input.reasonCode ?? 'INITIAL_BENCHMARK';
  if (!(aiEvaluationRecordReasons as readonly string[]).includes(reasonCode)) {
    throw new BakeOffImportError('REASON_CODE_INVALID', `the reason must be one of ${aiEvaluationRecordReasons.join(', ')}`);
  }
  let run: ReturnType<typeof evaluateResultsText>;
  try {
    run = evaluateResultsText({ resultsText: input.resultsText, reviewText: input.reviewText, cost: input.cost, featureKeys: input.featureKeys });
  } catch (error) {
    translate(error);
  }
  const { scorecard, resultsSha256, results, reviewed } = run;

  const chosen: FeatureScore[] = input.onlyFeatures?.length
    ? input.onlyFeatures.map((key) => {
      const found = scorecard.features.find((feature) => feature.featureKey === key);
      if (!found) throw new BakeOffImportError('FEATURE_UNKNOWN', `${key} is not evaluated by this set`);
      return found;
    })
    : [...scorecard.features];
  const forcedFail = input.decision === 'FAIL';
  const planned = chosen.map((feature) => {
    // Only the human metrics missing: the numbers would pass, so a person must look before it can.
    if (!forcedFail && feature.failedMetrics.length === 0 && feature.missingHumanMetrics.length > 0) {
      throw new BakeOffImportError('HUMAN_REVIEW_REQUIRED', `${feature.featureKey} meets every automatic threshold; a PASS needs a filled review sheet (bake-off:review-sheet)`);
    }
    const decision: 'PASS' | 'FAIL' = forcedFail ? 'FAIL' : feature.decision;
    const metrics = feature.metrics.map((metric) => ({ name: metric.name, value: metric.value, threshold: metric.threshold, comparator: metric.comparator }));
    const checked = readAiEvaluationMetrics(metrics, decision);
    if ('refusal' in checked) throw new BakeOffImportError('METRICS_REJECTED', `${feature.featureKey}: ${checked.refusal}`);
    return { feature, decision, metrics: checked.metrics };
  });

  const recorder = await recorderContext(db, input.recorderUserId);
  if (!recorder || !canConfigureAi(recorder)) {
    throw new BakeOffImportError('RECORDER_NOT_AUTHORISED', 'the recording user must be active and hold AI_OPS_CONFIGURE');
  }
  for (const { feature } of planned) {
    const policy = await rows<{ feature_key: string }>(db, sql`SELECT feature_key FROM ai_feature_policies WHERE feature_key = ${feature.featureKey}`);
    if (!policy.length) throw new BakeOffImportError('FEATURE_NOT_REGISTERED', `${feature.featureKey} has no policy; run ai:register-features first`);
    const already = await rows<{ id: string }>(db, sql`
      SELECT id FROM ai_evaluations
      WHERE feature_key = ${feature.featureKey} AND model = ${results.model} AND prompt_key = ${feature.promptKey}
        AND prompt_version = ${feature.promptVersion} AND position(${resultsSha256} in coalesce(note, '')) > 0
    `);
    if (already.length) throw new BakeOffImportError('RESULTS_ALREADY_RECORDED', `${feature.featureKey} already has a record from this results file`);
  }

  const evaluationNote = note({ scorecard, resultsSha256, startedAt: results.startedAt, reviewed, forcedFail });
  const outcome = (ids: readonly (string | null)[]): BakeOffImportOutcome => ({
    dryRun: input.dryRun === true, resultsSha256, scorecard,
    evaluations: planned.map(({ feature, decision }, index) => ({
      featureKey: feature.featureKey, model: results.model, promptKey: feature.promptKey, promptVersion: feature.promptVersion,
      decision, failedMetrics: feature.failedMetrics, evaluationId: ids[index] ?? null,
    })),
  });
  if (input.dryRun) return outcome([]);

  const actor: AiActor = { userId: input.recorderUserId, breakGlass: aiConfigureIsBreakGlass(recorder), correlationId: `eng21-bakeoff-${randomUUID()}` };
  const ids = await db.transaction(async (tx) => {
    // One transaction for the whole import: recordAiEvaluation's own transaction runs inside it.
    const inner: Db = { execute: (query) => tx.execute(query), transaction: (work) => work(tx) };
    const recorded: string[] = [];
    for (const { feature, decision, metrics } of planned) {
      const view = await recordAiEvaluation(inner, actor, {
        featureKey: feature.featureKey, providerKey: results.providerKey, model: results.model,
        promptKey: feature.promptKey, promptVersion: feature.promptVersion,
        evaluationSetKey: scorecard.setKey, evaluationSetVersion: scorecard.setVersion,
        metrics, decision, reasonCode, note: evaluationNote,
      });
      recorded.push(view.id);
    }
    return recorded;
  });
  return outcome(ids);
}
