/**
 * ONE · API client — cohort readiness by career role and preparation sprints (INST-17).
 *
 * The placement office, admins and department heads choose a career role (or the role behind one of the
 * college's campus drives), see how their cohort stood on each essential requirement at the end of a month, and
 * run time-boxed preparation sprints. Responses carry labels and counts of people only — never a score, a ratio,
 * a target or a student's name; counts under five come back suppressed.
 */
import { requestJson } from './http.js';
import type { LearningContentKind, LearningResourceRefDto } from './learningActions.js';

export interface CohortCountDto { readonly suppressed: boolean; readonly count: number | null }
export interface CountCellDto { readonly key: string; readonly count: number | null; readonly suppressed: boolean }

export interface CohortRoleOptionDto {
  readonly id: string;
  readonly title: string;
  readonly catalogueCode: string | null;
  readonly catalogueTitle: string | null;
  readonly releaseLabel: string | null;
  readonly essentialRequirements: number;
  readonly otherRequirements: number;
}

export interface CohortDriveRoleDto {
  readonly driveId: string;
  readonly employerName: string;
  readonly jobTitle: string;
  readonly state: string;
  readonly careerRoleId: string;
  readonly roleTitle: string;
}

export interface CohortRolesDto {
  readonly roles: readonly CohortRoleOptionDto[];
  readonly drives: readonly CohortDriveRoleDto[];
}

export interface CohortRequirementDto {
  readonly topicId: string;
  readonly skillName: string;
  /** MET, PARTIAL, MISSING, NOT_ENOUGH_EVIDENCE, NO_EVIDENCE — empty when the whole table is withheld. */
  readonly cells: readonly CountCellDto[];
  readonly gaps: CohortCountDto;
  readonly unknowns: CohortCountDto;
  readonly resources: readonly (LearningResourceRefDto & { readonly title: string })[];
}

export interface CohortReadinessDto {
  readonly role: { readonly id: string; readonly title: string; readonly catalogueCode: string | null; readonly catalogueTitle: string | null; readonly releaseLabel: string | null };
  readonly period: { readonly month: string; readonly periodStart: string; readonly periodEnd: string };
  readonly scope: { readonly kind: string; readonly units: readonly { readonly id: string; readonly kind: string; readonly name: string }[] };
  readonly requirementCounts: { readonly essential: number; readonly other: number };
  readonly cohort: { readonly suppressed: boolean; readonly total: CohortCountDto };
  readonly requirements: readonly CohortRequirementDto[];
  readonly canRunSprints: boolean;
  readonly sprintReasonCodes: readonly string[];
  readonly sprintDays: { readonly min: number; readonly max: number };
}

export interface PreparationSprintDto {
  readonly id: string;
  readonly role: { readonly id: string; readonly title: string };
  readonly skillName: string;
  readonly resource: { readonly kind: LearningContentKind; readonly title: string };
  readonly reasonCode: string;
  readonly note: string | null;
  readonly includeUnknown: boolean;
  readonly unitName: string | null;
  readonly drive: { readonly employerName: string; readonly jobTitle: string } | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly cancelledAt: string | null;
  readonly state: 'RUNNING' | 'ENDED' | 'CANCELLED';
  readonly startedByYou: boolean;
  readonly canEnd: boolean;
  readonly progress: {
    readonly cutoff: string | null;
    /** False on a sprint's first day: the first figures are cut at the start of the next day. */
    readonly available: boolean;
    /** False when the requirement has left the role's live set since the sprint started. */
    readonly requirementLive: boolean;
    readonly reached: CohortCountDto;
    /** MET, NEW_EVIDENCE, NO_NEW_EVIDENCE. */
    readonly cells: readonly CountCellDto[];
    readonly workDone: CohortCountDto;
  };
}

export interface PreparationSprintsDto {
  readonly sprints: readonly PreparationSprintDto[];
  readonly cancelReasonCodes: readonly string[];
  readonly canRunSprints: boolean;
}

export interface CreatePreparationSprintBody {
  readonly careerRoleId: string;
  readonly topicId: string;
  readonly resource: LearningResourceRefDto;
  readonly durationDays: number;
  readonly includeUnknown: boolean;
  readonly reasonCode: string;
  readonly note?: string;
  readonly unitId?: string;
  readonly campusDriveId?: string;
}

const institutionPath = (institutionId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}`;
const withSignal = (token: string, signal?: AbortSignal) => ({ token, ...(signal ? { signal } : {}) });

export function getCohortRoles(token: string, institutionId: string, signal?: AbortSignal): Promise<CohortRolesDto> {
  return requestJson(`${institutionPath(institutionId)}/cohort-readiness/roles`, withSignal(token, signal));
}

export function getCohortReadiness(token: string, institutionId: string, careerRoleId: string, month?: string | null, signal?: AbortSignal): Promise<CohortReadinessDto> {
  const params = new URLSearchParams({ careerRoleId });
  if (month) params.set('month', month);
  return requestJson(`${institutionPath(institutionId)}/cohort-readiness?${params.toString()}`, withSignal(token, signal));
}

export function listPreparationSprints(token: string, institutionId: string, signal?: AbortSignal): Promise<PreparationSprintsDto> {
  return requestJson(`${institutionPath(institutionId)}/preparation-sprints`, withSignal(token, signal));
}

export function createPreparationSprint(token: string, institutionId: string, body: CreatePreparationSprintBody): Promise<{ readonly sprint: { readonly id: string; readonly endsAt: string; readonly reached: CohortCountDto } }> {
  return requestJson(`${institutionPath(institutionId)}/preparation-sprints`, { token, method: 'POST', body });
}

export function endPreparationSprint(token: string, institutionId: string, sprintId: string, reasonCode: string): Promise<unknown> {
  return requestJson(`${institutionPath(institutionId)}/preparation-sprints/${encodeURIComponent(sprintId)}/cancel`, { token, method: 'POST', body: { reasonCode } });
}
