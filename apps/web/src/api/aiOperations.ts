/**
 * ONE · API client — Operations AI Operations console (OPS-12).
 *
 * Reads usage, outcomes, tokens, prompt versions and evaluation records from ONE AI Orchestration's
 * own tables, and carries the console's switches: switch a feature off, engage the global kill
 * switch, switch the in-app assistant off (immediate), switch a feature on and widen its limits
 * (with an approval), and record evaluations. The server decides every rule; cost is always NA
 * because no price table exists.
 */
import { requestJson } from './http.js';

export type AiPeriod = 'DAY' | 'MONTH';

export interface AiSwitchStateDto {
  readonly key: string;
  readonly enabled: boolean;
  readonly lastChangedAt: string | null;
  readonly lastReasonCode: string | null;
}

export interface AiFeatureDto {
  readonly featureKey: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly model: string;
  readonly cap: number;
  readonly capWindow: AiPeriod;
  readonly maxInputChars: number;
  readonly prompt: { readonly key: string; readonly version: number } | null;
  readonly usedInWindow: number;
  readonly evaluation: { readonly state: 'PASS' | 'FAIL' | 'NONE'; readonly evaluationId: string | null; readonly decidedAt: string | null };
  readonly updatedAt: string;
  readonly outcomes: { readonly succeeded: number; readonly refused: number; readonly failed: number };
  readonly tokens: { readonly input: number; readonly output: number };
  /** ENG-20: mean provider wall time of this period's successes; null = NA. */
  readonly averageLatencyMs: number | null;
}

/**
 * ENG-20: the inference endpoint — configured, host, model, whether a key is set (never the key),
 * and the latest recorded probe. The server never contacts the endpoint to answer this.
 */
export interface AiInferenceStatusDto {
  readonly configured: boolean;
  readonly reason: 'BASE_URL_MISSING' | 'BASE_URL_INVALID' | 'BASE_URL_INSECURE' | 'KEY_MISSING' | 'MODEL_MISSING' | null;
  readonly providerKey: string;
  readonly endpointHost: string | null;
  readonly model: string | null;
  readonly keyConfigured: boolean;
  readonly lastProbe: {
    readonly configured: boolean;
    readonly endpointHost: string | null;
    readonly model: string | null;
    readonly reachable: boolean;
    readonly modelServed: boolean | null;
    readonly failureClass: string | null;
    readonly latencyMs: number | null;
    readonly probedAt: string;
    readonly matchesConfiguration: boolean;
  } | null;
}

export interface AiAssistantStateDto {
  readonly serverSwitch: boolean;
  readonly providerKeyConfigured: boolean;
  readonly consoleSwitch: boolean;
  readonly killSwitchEngaged: boolean;
  readonly answering: boolean;
}

export interface AiOperationsSummaryDto {
  readonly period: AiPeriod;
  readonly periodStart: string;
  readonly killSwitch: AiSwitchStateDto | null;
  readonly assistantFlag: AiSwitchStateDto | null;
  readonly assistant: AiAssistantStateDto;
  readonly inference: AiInferenceStatusDto;
  readonly features: readonly AiFeatureDto[];
  readonly failureClasses: readonly { readonly featureKey: string; readonly outcome: 'REFUSED' | 'FAILED'; readonly failureClass: string; readonly count: number }[];
  readonly totals: { readonly succeeded: number; readonly refused: number; readonly failed: number; readonly inputTokens: number; readonly outputTokens: number };
  readonly prompts: {
    readonly registered: readonly { readonly key: string; readonly version: number; readonly purpose: string }[];
    readonly declared: readonly { readonly featureKey: string; readonly key: string; readonly version: number; readonly registered: boolean }[];
    readonly inUse: readonly { readonly key: string; readonly version: number; readonly generations: number; readonly lastUsedAt: string; readonly registered: boolean }[];
  };
  readonly cost: { readonly value: null; readonly basis: string; readonly text: string };
  readonly correlationId: string;
}

export interface AiOperationsPolicyDto {
  readonly reasons: {
    readonly disable: readonly string[];
    readonly enable: readonly string[];
    readonly limitsLower: readonly string[];
    readonly limitsRaise: readonly string[];
    readonly killSwitchEngage: readonly string[];
    readonly assistantDisable: readonly string[];
    readonly evaluation: readonly string[];
    readonly flagChange: readonly string[];
  };
  readonly bounds: { readonly capWindows: readonly AiPeriod[]; readonly maxCap: number; readonly minInputChars: number; readonly maxInputChars: number; readonly maxMetrics: number };
  readonly decisions: readonly ('PASS' | 'FAIL')[];
  readonly flags: { readonly killSwitch: string; readonly assistant: string };
  readonly viewer: { readonly canStop: boolean; readonly canConfigure: boolean };
  readonly cost: { readonly basis: string; readonly text: string };
  readonly correlationId: string;
}

export interface AiUsagePointDto {
  readonly period: string;
  readonly featureKey: string;
  readonly succeeded: number;
  readonly refused: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiOrganizationUsageDto {
  readonly organizationName: string | null;
  readonly organizationKind: string | null;
  readonly noSubject: boolean;
  readonly suppressed: boolean;
  readonly people: number | null;
  readonly succeeded: number | null;
  readonly refused: number | null;
  readonly failed: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface AiEvaluationMetricDto {
  readonly name: string;
  readonly value: number;
  readonly threshold: number;
  readonly comparator: 'AT_LEAST' | 'AT_MOST';
}

export interface AiEvaluationDto {
  readonly id: string;
  readonly featureKey: string;
  readonly providerKey: string;
  readonly model: string;
  readonly promptKey: string;
  readonly promptVersion: number;
  readonly evaluationSetKey: string;
  readonly evaluationSetVersion: number;
  readonly metrics: readonly AiEvaluationMetricDto[];
  readonly decision: 'PASS' | 'FAIL';
  readonly reasonCode: string;
  readonly note: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly current: boolean;
}

/** What every console write returns: the switches and features as they now stand. */
export interface AiOperationsWriteDto {
  readonly killSwitch: AiSwitchStateDto | null;
  readonly assistantFlag: AiSwitchStateDto | null;
  readonly features: readonly AiFeatureDto[];
  readonly correlationId: string;
}

const base = '/api/v1/operations/ai';
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export function getAiOperationsPolicy(token: string, signal?: AbortSignal): Promise<AiOperationsPolicyDto> {
  return requestJson(`${base}/policy`, { token, ...withSignal(signal) });
}

export function getAiOperationsSummary(token: string, period: AiPeriod, signal?: AbortSignal): Promise<AiOperationsSummaryDto> {
  return requestJson(`${base}/summary?period=${period}`, { token, ...withSignal(signal) });
}

export function listAiUsage(token: string, granularity: AiPeriod, featureKey?: string, signal?: AbortSignal): Promise<{ readonly granularity: AiPeriod; readonly points: readonly AiUsagePointDto[] }> {
  const query = new URLSearchParams({ granularity, ...(featureKey ? { featureKey } : {}) });
  return requestJson(`${base}/usage?${query.toString()}`, { token, ...withSignal(signal) });
}

export function listAiUsageByOrganization(token: string, period: AiPeriod, signal?: AbortSignal): Promise<{ readonly period: AiPeriod; readonly organizations: readonly AiOrganizationUsageDto[]; readonly suppressionThreshold: number }> {
  return requestJson(`${base}/usage/organizations?period=${period}`, { token, ...withSignal(signal) });
}

export function listAiEvaluations(token: string, input: { readonly featureKey?: string; readonly cursor?: string | null } = {}, signal?: AbortSignal): Promise<{ readonly evaluations: readonly AiEvaluationDto[]; readonly nextCursor: string | null }> {
  const query = new URLSearchParams({ ...(input.featureKey ? { featureKey: input.featureKey } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) });
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return requestJson(`${base}/evaluations${suffix}`, { token, ...withSignal(signal) });
}

export function recordAiEvaluation(token: string, body: {
  readonly featureKey: string; readonly providerKey: string; readonly model: string; readonly promptKey: string; readonly promptVersion: number;
  readonly evaluationSetKey: string; readonly evaluationSetVersion: number; readonly metrics: readonly AiEvaluationMetricDto[];
  readonly decision: 'PASS' | 'FAIL'; readonly reasonCode: string; readonly note?: string;
}): Promise<{ readonly evaluation: AiEvaluationDto; readonly correlationId: string }> {
  return requestJson(`${base}/evaluations`, { token, method: 'POST', body });
}

export function disableAiFeature(token: string, featureKey: string, body: { readonly reasonCode: string }): Promise<AiOperationsWriteDto> {
  return requestJson(`${base}/features/${encodeURIComponent(featureKey)}/disable`, { token, method: 'POST', body });
}

export function enableAiFeature(token: string, featureKey: string, body: { readonly reasonCode: string; readonly approvalId?: string }): Promise<AiOperationsWriteDto> {
  return requestJson(`${base}/features/${encodeURIComponent(featureKey)}/enable`, { token, method: 'POST', body });
}

export function changeAiFeatureLimits(token: string, featureKey: string, body: {
  readonly cap: number; readonly capWindow: AiPeriod; readonly maxInputChars: number; readonly reasonCode: string; readonly approvalId?: string;
}): Promise<AiOperationsWriteDto & { readonly change: 'LOWER' | 'RAISE' }> {
  return requestJson(`${base}/features/${encodeURIComponent(featureKey)}/limits`, { token, method: 'POST', body });
}

export function engageAiKillSwitch(token: string, body: { readonly reasonCode: string }): Promise<AiOperationsWriteDto & { readonly featuresSwitchedOff: number; readonly assistantSwitchedOff: boolean }> {
  return requestJson(`${base}/kill-switch/engage`, { token, method: 'POST', body });
}

export function disableAiAssistant(token: string, body: { readonly reasonCode: string }): Promise<AiOperationsWriteDto> {
  return requestJson(`${base}/assistant/disable`, { token, method: 'POST', body });
}
