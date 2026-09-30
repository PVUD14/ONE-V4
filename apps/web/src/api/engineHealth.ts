/**
 * ONE · API client — Adaptive engine health panels (OPS-13).
 *
 * Two read-only summaries: how the engine decides (planner decisions and override rate, the mastery
 * shadow comparison) under AI Operations, and whether its jobs run (the last calibration run, the code
 * sandbox) under System Health. Every count of people arrives already suppressed by the server; the
 * screen only shows what it is sent. Its own file keeps parallel goals out of each other's way;
 * api.ts re-exports it.
 */
import { requestJson } from './http.js';

/** A count as it may leave the server: withheld under five people, zero included. */
export interface EngineSuppressedCountDto {
  readonly suppressed: boolean;
  readonly value: number | null;
}

export type EngineHealthWindowDays = 7 | 14 | 30;

export interface PlannerHealthDto {
  readonly windowDays: EngineHealthWindowDays;
  readonly days: readonly { readonly day: string; readonly decisions: EngineSuppressedCountDto }[];
  readonly decisions: EngineSuppressedCountDto;
  readonly overridden: EngineSuppressedCountDto;
  readonly overrideRate: number | null;
  readonly active: boolean;
  readonly policyVersions: readonly string[];
}

export interface ShadowComparisonDto {
  readonly pairsCompared: EngineSuppressedCountDto;
  readonly unchanged: EngineSuppressedCountDto;
  readonly movedUp: EngineSuppressedCountDto;
  readonly movedDown: EngineSuppressedCountDto;
  readonly becameNotEnoughEvidence: EngineSuppressedCountDto;
  readonly leftNotEnoughEvidence: EngineSuppressedCountDto;
  readonly studentsWithAnyChange: EngineSuppressedCountDto;
}

export interface MasteryShadowHealthDto {
  readonly consentOffered: boolean;
  readonly suppressed: boolean;
  readonly studentsInScope: EngineSuppressedCountDto;
  readonly algorithms: { readonly live: string; readonly engineBand: string; readonly projector: string; readonly shadow: string };
  readonly coverage: {
    readonly pairsWithBothBands: EngineSuppressedCountDto;
    readonly livePairsWithoutEngineRow: EngineSuppressedCountDto;
    readonly engineRowsWithoutLiveBand: EngineSuppressedCountDto;
    readonly engineRowsOnOlderProjector: EngineSuppressedCountDto;
  } | null;
  readonly c3Adoption: ShadowComparisonDto | null;
  readonly bkt: ShadowComparisonDto | null;
}

export interface EngineBehaviourHealthDto {
  readonly planner: PlannerHealthDto;
  readonly masteryShadow: MasteryShadowHealthDto;
  readonly suppressionThreshold: number;
  readonly correlationId: string;
}

export interface CalibrationHealthDto {
  readonly status: 'NO_RUN' | 'CURRENT' | 'OVERDUE';
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
    readonly ageDays: number;
    readonly learnersRead: EngineSuppressedCountDto;
    readonly responsesRead: number | null;
    readonly itemsRead: number;
    readonly items: { readonly calibrated: number; readonly provisional: number; readonly provisionalByReason: Readonly<Record<string, number>> };
  } | null;
}

export interface SandboxHealthDto {
  readonly state: 'NOT_BUILT';
  readonly available: boolean | null;
  readonly rejectedExecutions: number | null;
}

export interface EngineJobsHealthDto {
  readonly calibration: CalibrationHealthDto;
  readonly sandbox: SandboxHealthDto;
  readonly correlationId: string;
}

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export function getEngineBehaviourHealth(token: string, days: EngineHealthWindowDays, signal?: AbortSignal): Promise<EngineBehaviourHealthDto> {
  return requestJson(`/api/v1/operations/ai/engine-health?days=${days}`, { token, ...withSignal(signal) });
}

export function getEngineJobsHealth(token: string, signal?: AbortSignal): Promise<EngineJobsHealthDto> {
  return requestJson('/api/v1/operations/jobs/engine-health', { token, ...withSignal(signal) });
}
