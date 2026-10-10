/**
 * AI Operations console rules (OPS-12, Appendix 1 §3 AI operations, §5.3, §5.4).
 *
 * Who may read, stop and configure AI features; the reason codes each write carries; how a limits
 * change is classified (lowering is ordinary, widening needs a second person); when a feature may
 * be switched on; and the shape of a recorded evaluation — as data and pure functions, so the API,
 * the web screen and the 0089 triggers agree.
 *
 * Within the AI hold (ADR-030): nothing here calls a model or knows a provider's price. Cost has no
 * source, so it is NA everywhere.
 *
 * Design: docs/architecture/ai-evaluations-table-design.md
 */
import { hasInternalCapability, resolveInternalCapability, type InternalCapabilityContext } from './internal-capabilities.js';

/** The two AI feature flags (0089). The kill switch being ON means AI is stopped. */
export const aiKillSwitchFlagKey = 'ai.global-kill-switch';
export const aiAssistantFlagKey = 'ai.assistant';

/** §5.3: reason codes are defined in code, per write. */
export const aiFeatureDisableReasons = ['INCIDENT_MITIGATION', 'QUALITY_CONCERN', 'COST_CONTROL', 'ROLLBACK', 'NOT_NEEDED'] as const;
export const aiKillSwitchEngageReasons = ['INCIDENT_MITIGATION', 'HARMFUL_OUTPUT', 'SUSPECTED_KEY_COMPROMISE', 'SPEND_RUNAWAY', 'PRECAUTION'] as const;
export const aiAssistantDisableReasons = ['INCIDENT_MITIGATION', 'HARMFUL_OUTPUT', 'SUSPECTED_KEY_COMPROMISE', 'POLICY_REQUIREMENT', 'PRECAUTION'] as const;
/** Why a feature is put to an approver for switching on; recorded again when it is switched on. */
export const aiFeatureEnableReasons = ['EVALUATION_COMPLETE', 'PILOT_ROLLOUT', 'INCIDENT_RESOLVED'] as const;
/** Lowering a limit: ordinary. Widening one: put to an approver with one of the raise reasons. */
export const aiLimitsLowerReasons = ['COST_CONTROL', 'INCIDENT_MITIGATION', 'CORRECTION'] as const;
export const aiLimitsRaiseReasons = ['DEMAND_GROWTH', 'PILOT_EXPANSION', 'CORRECTION'] as const;
/** ENG-25: why the tutor is put to an approver for one college, and why it is switched off there. */
export const aiTutorCollegeEnableReasons = ['PILOT_ROLLOUT', 'PILOT_EXPANSION', 'INCIDENT_RESOLVED'] as const;
export const aiTutorCollegeDisableReasons = ['INCIDENT_MITIGATION', 'QUALITY_CONCERN', 'COLLEGE_REQUEST', 'PILOT_ENDED', 'ROLLBACK'] as const;
export const aiEvaluationRecordReasons = ['INITIAL_BENCHMARK', 'MODEL_CHANGE', 'PROMPT_CHANGE', 'PERIODIC_REVIEW', 'INCIDENT_REVIEW'] as const;

/** The same bounds 0033 puts on a policy. */
export const aiCapWindows = ['DAY', 'MONTH'] as const;
export type AiCapWindow = (typeof aiCapWindows)[number];
export const aiMaxCap = 10_000_000;
export const aiMinInputChars = 100;
export const aiMaxInputChars = 500_000;

/** ONE has no price table; tokens are shown, cost is NA (never estimated from an assumed price). */
export const aiCostBasis = 'NO_PRICE_TABLE' as const;
export const aiCostBasisText = 'NA — ONE has no price table for any model, so cost is not estimated. Tokens are shown instead.';

type Actor = InternalCapabilityContext;

/** Read the console: usage, outcomes, tokens, evaluations and prompts. */
export function canViewAiOperations(actor: Actor): boolean {
  return hasInternalCapability(actor, 'AI_OPS_VIEW');
}

/**
 * Stop AI: switch one feature off, engage the kill switch, switch the assistant off. Wider than
 * configuring on purpose — the brake must be reachable by the operator on duty, and
 * OPS_FLAGS_MANAGE already switches flags off in an incident. Stopping loses no data.
 */
export function canStopAi(actor: Actor): boolean {
  return hasInternalCapability(actor, 'AI_OPS_CONFIGURE') || hasInternalCapability(actor, 'OPS_FLAGS_MANAGE');
}

/** Switch on, change limits, record evaluations. Switching on and widening also need an approval. */
export function canConfigureAi(actor: Actor): boolean {
  return hasInternalCapability(actor, 'AI_OPS_CONFIGURE');
}

/** §5.1: a configure write the caller's role would not hold by baseline or grant is audited as break-glass. */
export function aiConfigureIsBreakGlass(actor: Actor): boolean {
  return resolveInternalCapability(actor, 'AI_OPS_CONFIGURE') === 'BREAK_GLASS';
}

/** A stop is break-glass only when neither capability that allows it comes from a baseline or grant. */
export function aiStopIsBreakGlass(actor: Actor): boolean {
  const sources = [resolveInternalCapability(actor, 'OPS_FLAGS_MANAGE'), resolveInternalCapability(actor, 'AI_OPS_CONFIGURE')];
  if (sources.some((source) => source === 'BASELINE' || source === 'GRANT')) return false;
  return sources.includes('BREAK_GLASS');
}

export interface AiLimits {
  readonly cap: number;
  readonly capWindow: AiCapWindow;
  readonly maxInputChars: number;
}

/**
 * Whether a limits change lowers, widens or leaves the limits alone. Any increase widens; a window
 * change widens either way, because DAY and MONTH ceilings are not comparable.
 */
export function classifyAiLimitsChange(current: AiLimits, next: AiLimits): 'UNCHANGED' | 'LOWER' | 'RAISE' {
  if (next.capWindow !== current.capWindow || next.cap > current.cap || next.maxInputChars > current.maxInputChars) return 'RAISE';
  if (next.cap === current.cap && next.maxInputChars === current.maxInputChars) return 'UNCHANGED';
  return 'LOWER';
}

export type AiEnableRefusal =
  | 'AI_FEATURE_ALREADY_ENABLED'
  | 'AI_KILL_SWITCH_ENGAGED'
  | 'AI_PROMPT_UNDECLARED'
  | 'AI_EVALUATION_REQUIRED';

/**
 * Whether a feature may be switched on. The AGENTS.md benchmark rule: every feature is treated as
 * one that may reach students, so a passing evaluation for its current model and prompt version is
 * always required. The 0089 trigger repeats the kill-switch and evaluation rules.
 */
export function refuseAiFeatureEnable(input: {
  readonly enabled: boolean;
  readonly killSwitchEngaged: boolean;
  readonly promptDeclared: boolean;
  readonly evaluationPasses: boolean;
}): AiEnableRefusal | null {
  if (input.enabled) return 'AI_FEATURE_ALREADY_ENABLED';
  if (input.killSwitchEngaged) return 'AI_KILL_SWITCH_ENGAGED';
  if (!input.promptDeclared) return 'AI_PROMPT_UNDECLARED';
  if (!input.evaluationPasses) return 'AI_EVALUATION_REQUIRED';
  return null;
}

export const aiEvaluationDecisions = ['PASS', 'FAIL'] as const;
export type AiEvaluationDecision = (typeof aiEvaluationDecisions)[number];
export const aiMetricComparators = ['AT_LEAST', 'AT_MOST'] as const;
export type AiMetricComparator = (typeof aiMetricComparators)[number];

export interface AiEvaluationMetric {
  readonly name: string;
  readonly value: number;
  readonly threshold: number;
  readonly comparator: AiMetricComparator;
}

export const aiMetricNamePattern = /^[a-z][a-z0-9_]{1,63}$/;
export const aiMaxMetrics = 20;

/** Whether one metric meets its own threshold. */
export function aiMetricMet(metric: AiEvaluationMetric): boolean {
  return metric.comparator === 'AT_LEAST' ? metric.value >= metric.threshold : metric.value <= metric.threshold;
}

export type AiEvaluationRefusal = 'AI_EVALUATION_METRICS_INVALID' | 'AI_EVALUATION_PASS_BELOW_THRESHOLD';

/**
 * Parse recorded metrics: 1–20 of {name, value, threshold, comparator}, unique names, finite
 * numbers. A PASS must meet every threshold it records; a FAIL may be recorded at any time.
 */
export function readAiEvaluationMetrics(
  raw: unknown,
  decision: AiEvaluationDecision,
): { readonly metrics: readonly AiEvaluationMetric[] } | { readonly refusal: AiEvaluationRefusal } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > aiMaxMetrics) return { refusal: 'AI_EVALUATION_METRICS_INVALID' };
  const metrics: AiEvaluationMetric[] = [];
  const names = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { refusal: 'AI_EVALUATION_METRICS_INVALID' };
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 4 || !['name', 'value', 'threshold', 'comparator'].every((key) => keys.includes(key))) return { refusal: 'AI_EVALUATION_METRICS_INVALID' };
    const { name, value, threshold, comparator } = record;
    if (typeof name !== 'string' || !aiMetricNamePattern.test(name) || names.has(name)) return { refusal: 'AI_EVALUATION_METRICS_INVALID' };
    if (typeof value !== 'number' || !Number.isFinite(value) || typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      return { refusal: 'AI_EVALUATION_METRICS_INVALID' };
    }
    if (comparator !== 'AT_LEAST' && comparator !== 'AT_MOST') return { refusal: 'AI_EVALUATION_METRICS_INVALID' };
    names.add(name);
    metrics.push({ name, value, threshold, comparator });
  }
  if (decision === 'PASS' && !metrics.every(aiMetricMet)) return { refusal: 'AI_EVALUATION_PASS_BELOW_THRESHOLD' };
  return { metrics };
}
