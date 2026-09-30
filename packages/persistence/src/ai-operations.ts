/**
 * AI Operations console: reads and configuration over ONE AI Orchestration (OPS-12, migration 0089).
 *
 * Reads come only from ai_feature_policies, ai_generations, ai_evaluations and the two AI flags —
 * every figure has a source or is NA. Writes switch features off and on, change their limits,
 * engage the global kill switch, switch the in-app assistant off, and record evaluations; each in
 * one transaction with its audit row, and an outbox event. Switching on and widening consume an
 * OPS-02 approval inside the same transaction. The 0089 trigger repeats the enabling rules.
 *
 * Within the AI hold (ADR-030): nothing here calls a model or prices one. Cost is NA.
 *
 * Design: docs/architecture/ai-evaluations-table-design.md
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  aiAssistantFlagKey,
  aiKillSwitchFlagKey,
  aiLimitsLowerReasons,
  aiLimitsRaiseReasons,
  classifyAiLimitsChange,
  refuseAiFeatureEnable,
  suppressSmallCount,
  type AiCapWindow,
  type AiEvaluationDecision,
  type AiEvaluationMetric,
  type AiLimits,
} from '@planthepath/authorization/src/index.js';
import { registeredPrompts } from '@planthepath/ai-orchestration/src/index.js';
import { consumeOperationApproval, type ConsumedApproval } from './operation-approvals.js';
import { validateAuditWriteInput, validateOutboxWriteInput } from './repositories.js';

export interface SqlRunner {
  execute(query: SQL): Promise<unknown>;
}
type Db = SqlRunner & { transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> };

async function rows<T>(runner: SqlRunner, query: SQL): Promise<T[]> {
  return ((await runner.execute(query)) as { rows: T[] }).rows;
}

export type AiOperationsErrorCode =
  | 'AI_FEATURE_NOT_FOUND'
  | 'AI_FEATURE_ALREADY_ENABLED'
  | 'AI_FEATURE_ALREADY_DISABLED'
  | 'AI_KILL_SWITCH_ENGAGED'
  | 'AI_KILL_SWITCH_ALREADY_ENGAGED'
  | 'AI_PROMPT_UNDECLARED'
  | 'AI_EVALUATION_REQUIRED'
  | 'AI_LIMITS_UNCHANGED'
  | 'AI_ASSISTANT_ALREADY_OFF'
  | 'AI_FLAG_MISSING'
  | 'AI_CHANGE_REJECTED'
  | 'REASON_CODE_INVALID'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_NOT_REQUIRED';

export class AiOperationsError extends Error {
  constructor(readonly code: AiOperationsErrorCode) {
    super(code);
    this.name = 'AiOperationsError';
  }
}

/** Who acted, for the audit row. */
export interface AiActor {
  readonly userId: string;
  readonly breakGlass: boolean;
  readonly correlationId: string;
}

async function audit(runner: SqlRunner, actor: AiActor, input: {
  readonly action: string; readonly resourceType: string; readonly resourceId: string; readonly context: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  validateAuditWriteInput({ id, actorUserId: actor.userId, action: input.action, resourceType: input.resourceType, resourceId: input.resourceId, correlationId: actor.correlationId });
  const context = { ...input.context, ...(actor.breakGlass ? { break_glass: true } : {}) };
  await runner.execute(sql`
    INSERT INTO audit_events (id, actor_user_id, action, resource_type, resource_id, organization_id, outcome, correlation_id, context)
    VALUES (${id}::uuid, ${actor.userId}::uuid, ${input.action}, ${input.resourceType}, ${input.resourceId}, NULL, 'SUCCESS',
            ${actor.correlationId}, ${JSON.stringify(context)}::jsonb)
  `);
  return id;
}

async function outbox(runner: SqlRunner, actor: AiActor, input: {
  readonly aggregateType: string; readonly aggregateId: string; readonly eventType: string; readonly payload: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  validateOutboxWriteInput({ id, ...input, actorUserId: actor.userId, correlationId: actor.correlationId, eventVersion: 1 });
  await runner.execute(sql`
    INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, payload, actor_user_id, correlation_id)
    VALUES (${id}::uuid, ${input.aggregateType}, ${input.aggregateId}, ${input.eventType}, 1, ${JSON.stringify(input.payload)}::jsonb,
            ${actor.userId}::uuid, ${actor.correlationId})
  `);
}

async function flagEvent(runner: SqlRunner, actor: AiActor, input: { readonly key: string; readonly from: boolean; readonly to: boolean; readonly reasonCode: string }): Promise<void> {
  await runner.execute(sql`
    INSERT INTO feature_flag_events (id, flag_key, actor_user_id, change_kind, from_value, to_value, reason_code, correlation_id)
    VALUES (${randomUUID()}::uuid, ${input.key}, ${actor.userId}::uuid, ${input.to ? 'ENABLED' : 'DISABLED'},
            ${JSON.stringify({ enabled: input.from })}::jsonb, ${JSON.stringify({ enabled: input.to })}::jsonb,
            ${input.reasonCode}, ${actor.correlationId})
  `);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type AiPeriod = 'DAY' | 'MONTH';
const truncUnit = (period: AiPeriod): string => (period === 'DAY' ? 'day' : 'month');

export interface AiSwitchState {
  readonly key: string;
  readonly enabled: boolean;
  readonly lastChangedAt: string | null;
  readonly lastReasonCode: string | null;
}

async function loadSwitch(runner: SqlRunner, key: string): Promise<AiSwitchState | null> {
  const found = await rows<{ enabled: boolean; changed_at: Date | null; reason_code: string | null }>(runner, sql`
    SELECT f.enabled, e.occurred_at AS changed_at, e.reason_code
    FROM feature_flags f
    LEFT JOIN LATERAL (SELECT occurred_at, reason_code FROM feature_flag_events WHERE flag_key = f.key ORDER BY occurred_at DESC, id DESC LIMIT 1) e ON true
    WHERE f.key = ${key}
  `);
  const row = found[0];
  if (!row) return null;
  return { key, enabled: row.enabled, lastChangedAt: row.changed_at ? new Date(row.changed_at).toISOString() : null, lastReasonCode: row.reason_code };
}

export interface AiFeatureView {
  readonly featureKey: string;
  readonly description: string;
  /** The stored switch. */
  readonly enabled: boolean;
  /** Whether a call would run now: the stored switch and the kill switch released. */
  readonly effectiveEnabled: boolean;
  readonly model: string;
  readonly cap: number;
  readonly capWindow: AiCapWindow;
  readonly maxInputChars: number;
  readonly prompt: { readonly key: string; readonly version: number } | null;
  readonly usedInWindow: number;
  readonly evaluation: {
    /** PASS or FAIL for the current model and prompt; NONE when nothing was recorded (or no prompt). */
    readonly state: 'PASS' | 'FAIL' | 'NONE';
    readonly evaluationId: string | null;
    readonly decidedAt: string | null;
  };
  readonly updatedAt: string;
  readonly outcomes: { readonly succeeded: number; readonly refused: number; readonly failed: number };
  readonly tokens: { readonly input: number; readonly output: number };
}

export interface AiOperationsSummary {
  readonly period: AiPeriod;
  readonly periodStart: string;
  readonly killSwitch: AiSwitchState | null;
  readonly assistantFlag: AiSwitchState | null;
  readonly features: readonly AiFeatureView[];
  readonly failureClasses: readonly { readonly featureKey: string; readonly outcome: 'REFUSED' | 'FAILED'; readonly failureClass: string; readonly count: number }[];
  readonly totals: { readonly succeeded: number; readonly refused: number; readonly failed: number; readonly inputTokens: number; readonly outputTokens: number };
  readonly prompts: {
    readonly registered: readonly { readonly key: string; readonly version: number; readonly purpose: string }[];
    readonly declared: readonly { readonly featureKey: string; readonly key: string; readonly version: number; readonly registered: boolean }[];
    /** Distinct prompt versions that ran in the last 30 days, from ai_generations. */
    readonly inUse: readonly { readonly key: string; readonly version: number; readonly generations: number; readonly lastUsedAt: string; readonly registered: boolean }[];
  };
}

function isRegistered(key: string, version: number): boolean {
  return registeredPrompts.some((prompt) => prompt.key === key && prompt.version === version);
}

export async function loadAiOperationsSummary(runner: SqlRunner, input: { readonly period: AiPeriod }): Promise<AiOperationsSummary> {
  const unit = truncUnit(input.period);
  const [killSwitch, assistantFlag] = [await loadSwitch(runner, aiKillSwitchFlagKey), await loadSwitch(runner, aiAssistantFlagKey)];
  const start = await rows<{ start: string }>(runner, sql`
    SELECT to_char(date_trunc(${unit}, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start`);
  const features = await rows<{
    feature_key: string; description: string; enabled: boolean; model: string; cap: number; cap_window: AiCapWindow;
    max_input_chars: number; prompt_key: string | null; prompt_version: number | null; updated_at: Date; used_in_window: number;
    eval_id: string | null; eval_decision: 'PASS' | 'FAIL' | null; eval_decided_at: Date | null;
  }>(runner, sql`
    SELECT p.feature_key, p.description, p.enabled, p.model, p.cap, p.cap_window, p.max_input_chars, p.prompt_key, p.prompt_version,
           p.updated_at,
           (SELECT count(*)::int FROM ai_generations g
             WHERE g.feature_key = p.feature_key AND g.outcome = 'SUCCEEDED'
               AND g.occurred_at >= date_trunc(CASE p.cap_window WHEN 'DAY' THEN 'day' ELSE 'month' END, now())) AS used_in_window,
           e.id AS eval_id, e.decision AS eval_decision, e.decided_at AS eval_decided_at
    FROM ai_feature_policies p
    LEFT JOIN LATERAL (
      SELECT id, decision, decided_at FROM ai_evaluations e
      WHERE e.feature_key = p.feature_key AND e.model = p.model AND e.prompt_key = p.prompt_key AND e.prompt_version = p.prompt_version
      ORDER BY e.decided_at DESC, (e.decision = 'FAIL') DESC, e.id DESC LIMIT 1) e ON true
    ORDER BY p.feature_key
  `);
  const grouped = await rows<{ feature_key: string; outcome: 'SUCCEEDED' | 'REFUSED' | 'FAILED'; failure_class: string | null; count: number; input_tokens: string; output_tokens: string }>(runner, sql`
    SELECT feature_key, outcome, failure_class, count(*)::int AS count,
           COALESCE(sum(input_tokens), 0)::text AS input_tokens, COALESCE(sum(output_tokens), 0)::text AS output_tokens
    FROM ai_generations WHERE occurred_at >= date_trunc(${unit}, now())
    GROUP BY feature_key, outcome, failure_class
    ORDER BY feature_key, outcome, failure_class
  `);
  const inUse = await rows<{ prompt_key: string; prompt_version: number; generations: number; last_used_at: Date }>(runner, sql`
    SELECT prompt_key, prompt_version, count(*)::int AS generations, max(occurred_at) AS last_used_at
    FROM ai_generations WHERE occurred_at >= now() - interval '30 days'
    GROUP BY prompt_key, prompt_version ORDER BY prompt_key, prompt_version LIMIT 200
  `);

  const killEngaged = killSwitch?.enabled ?? false;
  const perFeature = new Map<string, { succeeded: number; refused: number; failed: number; input: number; output: number }>();
  const totals = { succeeded: 0, refused: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  const failureClasses: { featureKey: string; outcome: 'REFUSED' | 'FAILED'; failureClass: string; count: number }[] = [];
  for (const row of grouped) {
    const entry = perFeature.get(row.feature_key) ?? { succeeded: 0, refused: 0, failed: 0, input: 0, output: 0 };
    const count = Number(row.count);
    if (row.outcome === 'SUCCEEDED') entry.succeeded += count;
    else if (row.outcome === 'REFUSED') entry.refused += count;
    else entry.failed += count;
    entry.input += Number(row.input_tokens);
    entry.output += Number(row.output_tokens);
    perFeature.set(row.feature_key, entry);
    if (row.outcome !== 'SUCCEEDED' && row.failure_class) failureClasses.push({ featureKey: row.feature_key, outcome: row.outcome, failureClass: row.failure_class, count });
  }
  for (const entry of perFeature.values()) {
    totals.succeeded += entry.succeeded; totals.refused += entry.refused; totals.failed += entry.failed;
    totals.inputTokens += entry.input; totals.outputTokens += entry.output;
  }

  return {
    period: input.period,
    periodStart: start[0]!.start,
    killSwitch,
    assistantFlag,
    features: features.map((row) => {
      const usage = perFeature.get(row.feature_key) ?? { succeeded: 0, refused: 0, failed: 0, input: 0, output: 0 };
      return {
        featureKey: row.feature_key,
        description: row.description,
        enabled: row.enabled,
        effectiveEnabled: row.enabled && !killEngaged,
        model: row.model,
        cap: Number(row.cap),
        capWindow: row.cap_window,
        maxInputChars: Number(row.max_input_chars),
        prompt: row.prompt_key && row.prompt_version !== null ? { key: row.prompt_key, version: Number(row.prompt_version) } : null,
        usedInWindow: Number(row.used_in_window),
        evaluation: {
          state: row.eval_decision ?? 'NONE',
          evaluationId: row.eval_id,
          decidedAt: row.eval_decided_at ? new Date(row.eval_decided_at).toISOString() : null,
        },
        updatedAt: new Date(row.updated_at).toISOString(),
        outcomes: { succeeded: usage.succeeded, refused: usage.refused, failed: usage.failed },
        tokens: { input: usage.input, output: usage.output },
      };
    }),
    failureClasses,
    totals,
    prompts: {
      registered: registeredPrompts.map((prompt) => ({ key: prompt.key, version: prompt.version, purpose: prompt.purpose })),
      declared: features.filter((row) => row.prompt_key && row.prompt_version !== null).map((row) => ({
        featureKey: row.feature_key, key: row.prompt_key!, version: Number(row.prompt_version), registered: isRegistered(row.prompt_key!, Number(row.prompt_version)),
      })),
      inUse: inUse.map((row) => ({
        key: row.prompt_key, version: Number(row.prompt_version), generations: Number(row.generations),
        lastUsedAt: new Date(row.last_used_at).toISOString(), registered: isRegistered(row.prompt_key, Number(row.prompt_version)),
      })),
    },
  };
}

export interface AiUsagePoint {
  readonly period: string;
  readonly featureKey: string;
  readonly succeeded: number;
  readonly refused: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Usage by day (the last 31 days) or by month (the last 12), newest first, from ai_generations. */
export async function listAiUsageSeries(runner: SqlRunner, input: { readonly granularity: AiPeriod; readonly featureKey?: string }): Promise<readonly AiUsagePoint[]> {
  const unit = truncUnit(input.granularity);
  const since = input.granularity === 'DAY' ? sql`date_trunc('day', now()) - interval '30 days'` : sql`date_trunc('month', now()) - interval '11 months'`;
  const format = input.granularity === 'DAY' ? 'YYYY-MM-DD' : 'YYYY-MM';
  const found = await rows<{ period: string; feature_key: string; succeeded: number; refused: number; failed: number; input_tokens: string; output_tokens: string }>(runner, sql`
    SELECT to_char(date_trunc(${unit}, occurred_at), ${format}) AS period, feature_key,
           count(*) FILTER (WHERE outcome = 'SUCCEEDED')::int AS succeeded,
           count(*) FILTER (WHERE outcome = 'REFUSED')::int AS refused,
           count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed,
           COALESCE(sum(input_tokens), 0)::text AS input_tokens, COALESCE(sum(output_tokens), 0)::text AS output_tokens
    FROM ai_generations
    WHERE occurred_at >= ${since} AND (${input.featureKey ?? null}::text IS NULL OR feature_key = ${input.featureKey ?? null})
    GROUP BY 1, 2
    ORDER BY 1 DESC, 2
    LIMIT 2000
  `);
  return found.map((row) => ({
    period: row.period, featureKey: row.feature_key, succeeded: Number(row.succeeded), refused: Number(row.refused), failed: Number(row.failed),
    inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
  }));
}

export interface AiOrganizationUsage {
  readonly organizationName: string | null;
  readonly organizationKind: string | null;
  /** True for generations about no person (content about content). */
  readonly noSubject: boolean;
  readonly suppressed: boolean;
  readonly people: number | null;
  readonly succeeded: number | null;
  readonly refused: number | null;
  readonly failed: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * Usage by organisation in the current day or month. A subject is attributed to every organisation
 * they hold an ACTIVE institution relationship or ACTIVE membership with. A row standing for fewer
 * than 5 people withholds every figure (§5.5, `suppressSmallCount`). Subjectless generations are
 * one row of their own; subjects with no organisation are another.
 */
export async function listAiUsageByOrganization(runner: SqlRunner, input: { readonly period: AiPeriod }): Promise<readonly AiOrganizationUsage[]> {
  const unit = truncUnit(input.period);
  const found = await rows<{
    organization_name: string | null; organization_kind: string | null; no_subject: boolean; people: number;
    succeeded: number; refused: number; failed: number; input_tokens: string; output_tokens: string;
  }>(runner, sql`
    WITH window_rows AS (
      SELECT subject_user_id, outcome, input_tokens, output_tokens FROM ai_generations WHERE occurred_at >= date_trunc(${unit}, now())
    ),
    links AS (
      SELECT student_user_id AS user_id, institution_id AS organization_id FROM institution_relationships WHERE state = 'ACTIVE'
      UNION
      SELECT user_id, organization_id FROM organization_memberships WHERE state = 'ACTIVE'
    ),
    attributed AS (
      SELECT w.*, l.organization_id FROM window_rows w LEFT JOIN links l ON l.user_id = w.subject_user_id
      WHERE w.subject_user_id IS NOT NULL
    )
    SELECT o.legal_name AS organization_name, o.kind::text AS organization_kind, false AS no_subject,
           count(DISTINCT a.subject_user_id)::int AS people,
           count(*) FILTER (WHERE a.outcome = 'SUCCEEDED')::int AS succeeded,
           count(*) FILTER (WHERE a.outcome = 'REFUSED')::int AS refused,
           count(*) FILTER (WHERE a.outcome = 'FAILED')::int AS failed,
           COALESCE(sum(a.input_tokens), 0)::text AS input_tokens, COALESCE(sum(a.output_tokens), 0)::text AS output_tokens
    FROM attributed a LEFT JOIN organizations o ON o.id = a.organization_id
    GROUP BY o.id, o.legal_name, o.kind
    UNION ALL
    SELECT NULL, NULL, true, 0,
           count(*) FILTER (WHERE outcome = 'SUCCEEDED')::int, count(*) FILTER (WHERE outcome = 'REFUSED')::int,
           count(*) FILTER (WHERE outcome = 'FAILED')::int,
           COALESCE(sum(input_tokens), 0)::text, COALESCE(sum(output_tokens), 0)::text
    FROM window_rows WHERE subject_user_id IS NULL
    HAVING count(*) > 0
    ORDER BY 6 DESC, 1 NULLS LAST
    LIMIT 200
  `);
  return found.map((row) => {
    if (row.no_subject) {
      // Generations about no person: not a count of people, so nothing to suppress.
      return {
        organizationName: null, organizationKind: null, noSubject: true, suppressed: false, people: null,
        succeeded: Number(row.succeeded), refused: Number(row.refused), failed: Number(row.failed),
        inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      };
    }
    const people = suppressSmallCount(Number(row.people));
    if (people.suppressed) {
      return {
        organizationName: row.organization_name, organizationKind: row.organization_kind, noSubject: false, suppressed: true,
        people: null, succeeded: null, refused: null, failed: null, inputTokens: null, outputTokens: null,
      };
    }
    return {
      organizationName: row.organization_name, organizationKind: row.organization_kind, noSubject: false, suppressed: false,
      people: people.value, succeeded: Number(row.succeeded), refused: Number(row.refused), failed: Number(row.failed),
      inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
    };
  });
}

export interface AiEvaluationView {
  readonly id: string;
  readonly featureKey: string;
  readonly providerKey: string;
  readonly model: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly evaluationSetKey: string;
  readonly evaluationSetVersion: number;
  readonly metrics: readonly AiEvaluationMetric[];
  readonly decision: AiEvaluationDecision;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** Whether this record is the current verdict for its feature, model and prompt version. */
  readonly current: boolean;
}

interface EvaluationRow {
  id: string; feature_key: string; provider_key: string; model: string; prompt_key: string; prompt_version: number;
  evaluation_set_key: string; evaluation_set_version: number; metrics: AiEvaluationMetric[]; decision: AiEvaluationDecision;
  reason_code: string; note: string | null; decided_by: string; decided_at: string; is_current: boolean;
}

const evaluationSelect = sql`
  SELECT e.id, e.feature_key, e.provider_key, e.model, e.prompt_key, e.prompt_version, e.evaluation_set_key, e.evaluation_set_version,
         e.metrics, e.decision, e.reason_code, e.note, u.email AS decided_by,
         to_char(e.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
         e.id = (SELECT c.id FROM ai_evaluations c
                 WHERE c.feature_key = e.feature_key AND c.model = e.model AND c.prompt_key = e.prompt_key AND c.prompt_version = e.prompt_version
                 ORDER BY c.decided_at DESC, (c.decision = 'FAIL') DESC, c.id DESC LIMIT 1) AS is_current
  FROM ai_evaluations e JOIN users u ON u.id = e.decided_by_user_id`;

function mapEvaluation(row: EvaluationRow): AiEvaluationView {
  return {
    id: row.id, featureKey: row.feature_key, providerKey: row.provider_key, model: row.model, promptKey: row.prompt_key,
    promptVersion: Number(row.prompt_version), evaluationSetKey: row.evaluation_set_key, evaluationSetVersion: Number(row.evaluation_set_version),
    metrics: row.metrics, decision: row.decision, reasonCode: row.reason_code, note: row.note, decidedBy: row.decided_by,
    decidedAt: row.decided_at, current: row.is_current,
  };
}

/** Evaluations, newest first, keyset paginated on (decided_at, id). */
export async function listAiEvaluations(runner: SqlRunner, input: {
  readonly featureKey?: string; readonly limit: number; readonly cursor?: { readonly at: string; readonly id: string };
}): Promise<{ readonly evaluations: readonly AiEvaluationView[]; readonly nextCursor: { readonly at: string; readonly id: string } | null }> {
  const found = await rows<EvaluationRow>(runner, sql`
    ${evaluationSelect}
    WHERE (${input.featureKey ?? null}::text IS NULL OR e.feature_key = ${input.featureKey ?? null})
      AND (${input.cursor?.at ?? null}::timestamptz IS NULL
           OR (e.decided_at, e.id) < (${input.cursor?.at ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid))
    ORDER BY e.decided_at DESC, e.id DESC
    LIMIT ${input.limit + 1}
  `);
  const page = found.slice(0, input.limit).map(mapEvaluation);
  const last = page[page.length - 1];
  return { evaluations: page, nextCursor: found.length > input.limit && last ? { at: last.decidedAt, id: last.id } : null };
}

export async function loadAiEvaluation(runner: SqlRunner, id: string): Promise<AiEvaluationView | null> {
  const found = await rows<EvaluationRow>(runner, sql`${evaluationSelect} WHERE e.id = ${id}::uuid`);
  return found[0] ? mapEvaluation(found[0]) : null;
}

// ---------------------------------------------------------------------------
// Policy facts for approvals
// ---------------------------------------------------------------------------

export interface AiPolicyFacts {
  readonly featureKey: string;
  readonly enabled: boolean;
  readonly model: string;
  readonly cap: number;
  readonly capWindow: AiCapWindow;
  readonly maxInputChars: number;
  readonly promptKey: string | null;
  readonly promptVersion: number | null;
  readonly killSwitchEngaged: boolean;
  /** The current verdict for this model and prompt: its id when it is a PASS, else null. */
  readonly passingEvaluationId: string | null;
}

export async function loadAiPolicyFacts(runner: SqlRunner, featureKey: string, lock: 'NONE' | 'UPDATE' = 'NONE'): Promise<AiPolicyFacts | null> {
  const found = await rows<{
    feature_key: string; enabled: boolean; model: string; cap: number; cap_window: AiCapWindow; max_input_chars: number;
    prompt_key: string | null; prompt_version: number | null;
  }>(runner, lock === 'UPDATE'
    ? sql`SELECT feature_key, enabled, model, cap, cap_window, max_input_chars, prompt_key, prompt_version FROM ai_feature_policies WHERE feature_key = ${featureKey} FOR UPDATE`
    : sql`SELECT feature_key, enabled, model, cap, cap_window, max_input_chars, prompt_key, prompt_version FROM ai_feature_policies WHERE feature_key = ${featureKey}`);
  const row = found[0];
  if (!row) return null;
  const kill = await rows<{ engaged: boolean }>(runner, sql`SELECT ai_kill_switch_engaged() AS engaged`);
  let passingEvaluationId: string | null = null;
  if (row.prompt_key && row.prompt_version !== null) {
    const current = await rows<{ id: string; decision: string }>(runner, sql`
      SELECT id, decision FROM ai_evaluations
      WHERE feature_key = ${row.feature_key} AND model = ${row.model} AND prompt_key = ${row.prompt_key} AND prompt_version = ${row.prompt_version}
      ORDER BY decided_at DESC, (decision = 'FAIL') DESC, id DESC LIMIT 1
    `);
    if (current[0]?.decision === 'PASS') passingEvaluationId = current[0].id;
  }
  return {
    featureKey: row.feature_key, enabled: row.enabled, model: row.model, cap: Number(row.cap), capWindow: row.cap_window,
    maxInputChars: Number(row.max_input_chars), promptKey: row.prompt_key, promptVersion: row.prompt_version === null ? null : Number(row.prompt_version),
    killSwitchEngaged: kill[0]?.engaged === true, passingEvaluationId,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Run a statement the 0089 triggers may refuse; never forward database text. */
async function guarded(runner: SqlRunner, query: SQL): Promise<void> {
  try {
    await runner.execute(query);
  } catch {
    throw new AiOperationsError('AI_CHANGE_REJECTED');
  }
}

/** Switch one feature off. No approval: stopping is immediate. */
export async function disableAiFeature(db: Db, actor: AiActor, input: { readonly featureKey: string; readonly reasonCode: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const facts = await loadAiPolicyFacts(tx, input.featureKey, 'UPDATE');
    if (!facts) throw new AiOperationsError('AI_FEATURE_NOT_FOUND');
    if (!facts.enabled) throw new AiOperationsError('AI_FEATURE_ALREADY_DISABLED');
    await tx.execute(sql`UPDATE ai_feature_policies SET enabled = false, updated_at = now() WHERE feature_key = ${input.featureKey}`);
    const auditId = await audit(tx, actor, {
      action: 'operations.ai.feature.disabled', resourceType: 'ai_feature_policy', resourceId: input.featureKey,
      context: { featureKey: input.featureKey, reasonCode: input.reasonCode, from: { enabled: true }, to: { enabled: false } },
    });
    await outbox(tx, actor, { aggregateType: 'ai_operations_change', aggregateId: auditId, eventType: 'ai_feature_policy.changed', payload: { change: 'DISABLED', approvalMode: 'NONE' } });
  });
}

/**
 * Switch one feature on: kill switch released, a declared prompt, a passing evaluation for the
 * current model and prompt, and an AI_FEATURE_ENABLE approval bound to exactly that — consumed in
 * this transaction. The kill-switch flag row is share-locked so an engage cannot interleave.
 */
export async function enableAiFeature(db: Db, actor: AiActor, input: {
  readonly featureKey: string;
  readonly reasonCode: string;
  readonly approvalId: string | undefined;
  readonly approvalPayload: (facts: AiPolicyFacts & { readonly promptKey: string; readonly promptVersion: number; readonly passingEvaluationId: string }) => Record<string, unknown>;
}): Promise<ConsumedApproval> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM feature_flags WHERE key = ${aiKillSwitchFlagKey} FOR SHARE`);
    const facts = await loadAiPolicyFacts(tx, input.featureKey, 'UPDATE');
    if (!facts) throw new AiOperationsError('AI_FEATURE_NOT_FOUND');
    const refusal = refuseAiFeatureEnable({
      enabled: facts.enabled, killSwitchEngaged: facts.killSwitchEngaged,
      promptDeclared: facts.promptKey !== null && facts.promptVersion !== null, evaluationPasses: facts.passingEvaluationId !== null,
    });
    if (refusal) throw new AiOperationsError(refusal);
    if (!input.approvalId) throw new AiOperationsError('APPROVAL_REQUIRED');
    const bound = { ...facts, promptKey: facts.promptKey!, promptVersion: facts.promptVersion!, passingEvaluationId: facts.passingEvaluationId! };
    const consumed = await consumeOperationApproval(tx, {
      approvalId: input.approvalId, actionKey: 'AI_FEATURE_ENABLE', payload: input.approvalPayload(bound),
      executorUserId: actor.userId, correlationId: actor.correlationId,
    });
    await guarded(tx, sql`UPDATE ai_feature_policies SET enabled = true, updated_at = now() WHERE feature_key = ${input.featureKey}`);
    const auditId = await audit(tx, actor, {
      action: 'operations.ai.feature.enabled', resourceType: 'ai_feature_policy', resourceId: input.featureKey,
      context: {
        featureKey: input.featureKey, reasonCode: input.reasonCode, from: { enabled: false }, to: { enabled: true },
        model: facts.model, promptKey: bound.promptKey, promptVersion: bound.promptVersion, evaluationId: bound.passingEvaluationId,
        approvalId: consumed.approvalId, requestedByUserId: consumed.requestedByUserId, approvedByUserId: consumed.approvedByUserId, mode: consumed.mode,
      },
    });
    await outbox(tx, actor, { aggregateType: 'ai_operations_change', aggregateId: auditId, eventType: 'ai_feature_policy.changed', payload: { change: 'ENABLED', approvalMode: consumed.mode } });
    return consumed;
  });
}

/**
 * Change a feature's cap, window and input limit. Lowering is ordinary (a lower reason); widening —
 * any increase, or a window change — needs an AI_FEATURE_LIMITS_RAISE approval bound to the new
 * limits (a raise reason).
 */
export async function changeAiFeatureLimits(db: Db, actor: AiActor, input: {
  readonly featureKey: string;
  readonly next: AiLimits;
  readonly reasonCode: string;
  readonly approvalId: string | undefined;
  readonly approvalPayload: () => Record<string, unknown>;
}): Promise<{ readonly change: 'LOWER' | 'RAISE'; readonly approval: ConsumedApproval | null }> {
  return db.transaction(async (tx) => {
    const facts = await loadAiPolicyFacts(tx, input.featureKey, 'UPDATE');
    if (!facts) throw new AiOperationsError('AI_FEATURE_NOT_FOUND');
    const current: AiLimits = { cap: facts.cap, capWindow: facts.capWindow, maxInputChars: facts.maxInputChars };
    const change = classifyAiLimitsChange(current, input.next);
    if (change === 'UNCHANGED') throw new AiOperationsError('AI_LIMITS_UNCHANGED');
    const reasons: readonly string[] = change === 'RAISE' ? aiLimitsRaiseReasons : aiLimitsLowerReasons;
    if (!reasons.includes(input.reasonCode)) throw new AiOperationsError('REASON_CODE_INVALID');
    let approval: ConsumedApproval | null = null;
    if (change === 'RAISE') {
      if (!input.approvalId) throw new AiOperationsError('APPROVAL_REQUIRED');
      approval = await consumeOperationApproval(tx, {
        approvalId: input.approvalId, actionKey: 'AI_FEATURE_LIMITS_RAISE', payload: input.approvalPayload(),
        executorUserId: actor.userId, correlationId: actor.correlationId,
      });
    } else if (input.approvalId) {
      throw new AiOperationsError('APPROVAL_NOT_REQUIRED');
    }
    await guarded(tx, sql`
      UPDATE ai_feature_policies SET cap = ${input.next.cap}, cap_window = ${input.next.capWindow}, max_input_chars = ${input.next.maxInputChars},
             updated_at = now()
      WHERE feature_key = ${input.featureKey}
    `);
    const auditId = await audit(tx, actor, {
      action: 'operations.ai.feature.limits_changed', resourceType: 'ai_feature_policy', resourceId: input.featureKey,
      context: {
        featureKey: input.featureKey, reasonCode: input.reasonCode, change, from: current, to: input.next,
        ...(approval ? { approvalId: approval.approvalId, requestedByUserId: approval.requestedByUserId, approvedByUserId: approval.approvedByUserId, mode: approval.mode } : {}),
      },
    });
    await outbox(tx, actor, {
      aggregateType: 'ai_operations_change', aggregateId: auditId, eventType: 'ai_feature_policy.changed',
      payload: { change: change === 'RAISE' ? 'LIMITS_RAISED' : 'LIMITS_LOWERED', approvalMode: approval ? approval.mode : 'NONE' },
    });
    return { change, approval };
  });
}

/**
 * Engage the global kill switch: one action, one transaction. The flag goes on, every enabled
 * feature and the assistant flag go off, each with its audit row (and flag events), and one outbox
 * event records the whole action. No approval: stopping is immediate.
 */
export async function engageAiKillSwitch(db: Db, actor: AiActor, input: { readonly reasonCode: string }): Promise<{ readonly featuresSwitchedOff: readonly string[]; readonly assistantSwitchedOff: boolean }> {
  return db.transaction(async (tx) => {
    const kill = await rows<{ enabled: boolean }>(tx, sql`SELECT enabled FROM feature_flags WHERE key = ${aiKillSwitchFlagKey} FOR UPDATE`);
    if (!kill[0]) throw new AiOperationsError('AI_FLAG_MISSING');
    if (kill[0].enabled) throw new AiOperationsError('AI_KILL_SWITCH_ALREADY_ENGAGED');
    await tx.execute(sql`UPDATE feature_flags SET enabled = true, updated_at = now() WHERE key = ${aiKillSwitchFlagKey}`);
    await flagEvent(tx, actor, { key: aiKillSwitchFlagKey, from: false, to: true, reasonCode: input.reasonCode });
    const switched = await rows<{ feature_key: string }>(tx, sql`
      UPDATE ai_feature_policies SET enabled = false, updated_at = now() WHERE enabled RETURNING feature_key
    `);
    const featuresSwitchedOff = switched.map((row) => row.feature_key).sort();
    const assistant = await rows<{ enabled: boolean }>(tx, sql`SELECT enabled FROM feature_flags WHERE key = ${aiAssistantFlagKey} FOR UPDATE`);
    const assistantSwitchedOff = assistant[0]?.enabled === true;
    if (assistantSwitchedOff) {
      await tx.execute(sql`UPDATE feature_flags SET enabled = false, updated_at = now() WHERE key = ${aiAssistantFlagKey}`);
      await flagEvent(tx, actor, { key: aiAssistantFlagKey, from: true, to: false, reasonCode: input.reasonCode });
    }
    for (const featureKey of featuresSwitchedOff) {
      await audit(tx, actor, {
        action: 'operations.ai.feature.disabled', resourceType: 'ai_feature_policy', resourceId: featureKey,
        context: { featureKey, reasonCode: input.reasonCode, via: 'KILL_SWITCH', from: { enabled: true }, to: { enabled: false } },
      });
    }
    if (assistantSwitchedOff) {
      await audit(tx, actor, {
        action: 'operations.ai.assistant.disabled', resourceType: 'feature_flag', resourceId: aiAssistantFlagKey,
        context: { reasonCode: input.reasonCode, via: 'KILL_SWITCH' },
      });
    }
    const auditId = await audit(tx, actor, {
      action: 'operations.ai.kill_switch.engaged', resourceType: 'feature_flag', resourceId: aiKillSwitchFlagKey,
      context: { reasonCode: input.reasonCode, featuresSwitchedOff, assistantSwitchedOff },
    });
    await outbox(tx, actor, { aggregateType: 'ai_operations_change', aggregateId: auditId, eventType: 'ai_kill_switch.engaged', payload: { reasonCode: input.reasonCode } });
    return { featuresSwitchedOff, assistantSwitchedOff };
  });
}

/** Switch the in-app assistant's flag off. No approval, no restart. */
export async function disableAiAssistant(db: Db, actor: AiActor, input: { readonly reasonCode: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const found = await rows<{ enabled: boolean }>(tx, sql`SELECT enabled FROM feature_flags WHERE key = ${aiAssistantFlagKey} FOR UPDATE`);
    if (!found[0]) throw new AiOperationsError('AI_FLAG_MISSING');
    if (!found[0].enabled) throw new AiOperationsError('AI_ASSISTANT_ALREADY_OFF');
    await tx.execute(sql`UPDATE feature_flags SET enabled = false, updated_at = now() WHERE key = ${aiAssistantFlagKey}`);
    await flagEvent(tx, actor, { key: aiAssistantFlagKey, from: true, to: false, reasonCode: input.reasonCode });
    await audit(tx, actor, {
      action: 'operations.ai.assistant.disabled', resourceType: 'feature_flag', resourceId: aiAssistantFlagKey,
      context: { reasonCode: input.reasonCode },
    });
  });
}

/**
 * Whether the console switches let the assistant answer: its flag on and the kill switch released.
 * Read directly (overrides never apply to AI flags). A missing row means no.
 */
export async function aiAssistantSwitchAllows(runner: SqlRunner): Promise<boolean> {
  const found = await rows<{ allowed: boolean }>(runner, sql`
    SELECT COALESCE((SELECT enabled FROM feature_flags WHERE key = ${aiAssistantFlagKey}), false)
           AND NOT ai_kill_switch_engaged() AS allowed
  `);
  return found[0]?.allowed === true;
}

export interface AiEvaluationInput {
  readonly featureKey: string;
  readonly providerKey: string;
  readonly model: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly evaluationSetKey: string;
  readonly evaluationSetVersion: number;
  readonly metrics: readonly AiEvaluationMetric[];
  readonly decision: AiEvaluationDecision;
  readonly reasonCode: string;
  readonly note?: string | undefined;
}

/** Record one evaluation decision. Append-only; the 0089 trigger re-checks a PASS against its thresholds. */
export async function recordAiEvaluation(db: Db, actor: AiActor, input: AiEvaluationInput): Promise<AiEvaluationView> {
  return db.transaction(async (tx) => {
    const policy = await rows<{ feature_key: string }>(tx, sql`SELECT feature_key FROM ai_feature_policies WHERE feature_key = ${input.featureKey}`);
    if (!policy[0]) throw new AiOperationsError('AI_FEATURE_NOT_FOUND');
    const id = randomUUID();
    await guarded(tx, sql`
      INSERT INTO ai_evaluations (id, feature_key, provider_key, model, prompt_key, prompt_version, evaluation_set_key, evaluation_set_version,
                                  metrics, decision, reason_code, note, decided_by_user_id, correlation_id)
      VALUES (${id}::uuid, ${input.featureKey}, ${input.providerKey}, ${input.model}, ${input.promptKey}, ${input.promptVersion},
              ${input.evaluationSetKey}, ${input.evaluationSetVersion}, ${JSON.stringify(input.metrics)}::jsonb, ${input.decision},
              ${input.reasonCode}, ${input.note ?? null}, ${actor.userId}::uuid, ${actor.correlationId})
    `);
    await audit(tx, actor, {
      action: 'operations.ai.evaluation.recorded', resourceType: 'ai_evaluation', resourceId: id,
      context: {
        featureKey: input.featureKey, providerKey: input.providerKey, model: input.model, promptKey: input.promptKey, promptVersion: input.promptVersion,
        evaluationSetKey: input.evaluationSetKey, evaluationSetVersion: input.evaluationSetVersion, decision: input.decision, reasonCode: input.reasonCode,
      },
    });
    await outbox(tx, actor, { aggregateType: 'ai_evaluation', aggregateId: id, eventType: 'ai_evaluation.recorded', payload: { evaluationId: id, decision: input.decision } });
    return (await loadAiEvaluation(tx, id))!;
  });
}
