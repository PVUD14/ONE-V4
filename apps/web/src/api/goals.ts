/**
 * ONE · API client — student goals and onboarding (ENG-19).
 *
 * The goals read (live goals, onboarding flag, skills each listed once), goal options searched by name and
 * synonym, setting and ending goals, and "Not sure yet" (survey plus 3–5 suggested roles with reasons).
 * Responses carry statuses and reasons only — never a readiness value or a score.
 */
import { requestJson } from './http.js';

export type LearnerGoalType = 'ROLE' | 'TOPIC' | 'EXAM' | 'COMPANY' | 'DISCOVERY';
export type GoalSkillStatus = 'MET' | 'PARTIAL' | 'MISSING' | 'UNKNOWN';
export type GoalOrigin = 'ONBOARDING' | 'GOALS' | 'DISCOVERY_SUGGESTION';

export interface LearnerGoalDto {
  readonly id: string;
  readonly goalType: LearnerGoalType;
  readonly priority: 'PRIMARY' | 'SECONDARY';
  readonly origin: string;
  readonly createdAt: string;
  readonly role: { readonly careerRoleId: string; readonly targetId: string; readonly code: string; readonly title: string; readonly family: string; readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | null } | null;
  readonly topic: { readonly topicId: string; readonly name: string } | null;
  readonly catalogueGoal: { readonly code: string; readonly title: string; readonly release: string } | null;
  readonly discovery: { readonly interests: readonly string[]; readonly strengths: readonly string[]; readonly branch: string } | null;
}

export interface LearnerGoalsDto {
  readonly onboarding: boolean;
  readonly catalogueOpen: boolean;
  readonly goals: readonly LearnerGoalDto[];
  readonly skills: {
    readonly algorithmId: string;
    readonly skills: readonly {
      readonly topicId: string;
      readonly topicTitle: string | null;
      readonly goals: readonly { readonly goalId: string; readonly goalType: LearnerGoalType; readonly status: GoalSkillStatus | null }[];
    }[];
  };
}

export interface GoalRoleOptionDto {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly family: string;
  readonly summary: string | null;
  readonly releaseLabel: 'SELECTABLE' | 'VERIFIED' | null;
  readonly catalogueCode: string | null;
  readonly matchedSynonym?: string | null;
}

export interface GoalOptionsDto {
  readonly catalogueOpen: boolean;
  readonly roles: readonly GoalRoleOptionDto[];
  readonly topics: readonly { readonly id: string; readonly name: string }[];
  readonly catalogueGoals: readonly { readonly code: string; readonly title: string; readonly goalType: 'EXAM' | 'COMPANY'; readonly release: string }[];
}

export type DiscoveryReasonCode = 'INTEREST_MATCH' | 'STRENGTH_MATCH' | 'BRANCH_MATCH' | 'SHOWN_SKILLS' | 'OPEN_TO_YOUR_BRANCH' | 'OPEN_TO_ALL_BRANCHES';

export interface CareerDiscoveryDto {
  readonly algorithmId: string;
  readonly survey: {
    readonly interests: readonly { readonly code: string; readonly label: string }[];
    readonly strengths: readonly { readonly code: string; readonly label: string }[];
    readonly branches: readonly string[];
  };
  readonly answers: { readonly interests: readonly string[]; readonly strengths: readonly string[]; readonly branch: string } | null;
  readonly result: {
    readonly suggestions: readonly { readonly role: GoalRoleOptionDto; readonly reasons: readonly { readonly code: DiscoveryReasonCode; readonly detail?: string }[] }[];
    readonly usedShownSkills: boolean;
    readonly fewerThanMinimum: boolean;
  } | null;
}

export type SetGoalInput =
  | { readonly goalType: 'ROLE'; readonly careerRoleId: string; readonly priority: 'PRIMARY' | 'SECONDARY'; readonly origin: GoalOrigin }
  | { readonly goalType: 'TOPIC'; readonly topicId: string; readonly origin: GoalOrigin }
  | { readonly goalType: 'EXAM' | 'COMPANY'; readonly catalogueGoalCode: string; readonly origin: GoalOrigin };

const base = '/api/v1/students/me/goals';

export function getLearnerGoals(token: string, signal?: AbortSignal): Promise<LearnerGoalsDto> {
  return requestJson<LearnerGoalsDto>(base, { token, ...(signal ? { signal } : {}) });
}

export function searchGoalOptions(token: string, query: string, signal?: AbortSignal): Promise<GoalOptionsDto> {
  return requestJson<GoalOptionsDto>(`${base}/options?q=${encodeURIComponent(query)}`, { token, ...(signal ? { signal } : {}) });
}

export function setLearnerGoal(token: string, input: SetGoalInput): Promise<LearnerGoalsDto> {
  return requestJson<LearnerGoalsDto>(base, { token, method: 'POST', body: input });
}

export function endLearnerGoal(token: string, goalId: string, status: 'ACHIEVED' | 'WITHDRAWN'): Promise<LearnerGoalsDto> {
  return requestJson<LearnerGoalsDto>(`${base}/${encodeURIComponent(goalId)}/end`, { token, method: 'POST', body: { status } });
}

export function getCareerDiscovery(token: string, signal?: AbortSignal): Promise<{ readonly discovery: CareerDiscoveryDto }> {
  return requestJson<{ readonly discovery: CareerDiscoveryDto }>(`${base}/discovery`, { token, ...(signal ? { signal } : {}) });
}

export function submitCareerDiscovery(token: string, answers: { readonly interests: readonly string[]; readonly strengths: readonly string[]; readonly branch: string; readonly origin: GoalOrigin }): Promise<{ readonly discovery: CareerDiscoveryDto }> {
  return requestJson<{ readonly discovery: CareerDiscoveryDto }>(`${base}/discovery`, { token, method: 'POST', body: answers });
}
