/**
 * ONE · API client — faculty learning actions (INST-16) and the student's view of them.
 *
 * A lecturer assigns published practice sets and lessons to a class or selected students, runs group sessions
 * (a MEETING with attendees and linked content) and sets one student's next step with a reason code. The student
 * sees what their lecturers set on Learning. Responses carry names, titles, labels and counts only — never a
 * model number, a readiness value or a staff member's name; counts of people under five come back suppressed.
 */
import { requestJson } from './http.js';

export type LearningContentKind = 'PRACTICE' | 'LESSON';
export type FacultyOverrideAction = 'LEARN' | 'PRACTICE' | 'REVIEW';

export interface LearningResourceRefDto {
  readonly kind: LearningContentKind;
  readonly skillId: string;
  readonly lessonVersionId: string | null;
}

export interface LearningResourceDto extends LearningResourceRefDto {
  readonly title: string;
  readonly skillName: string;
  readonly moduleTitle: string | null;
  readonly questionCount: number | null;
}

export interface LearningResourcesPageDto {
  readonly resources: readonly LearningResourceDto[];
  readonly nextCursor: string | null;
}

export interface FacultyAssignmentDto {
  readonly id: string;
  readonly resource: LearningResourceRefDto & { readonly title: string; readonly skillName: string };
  readonly target: { readonly kind: 'UNIT' | 'STUDENTS'; readonly unitName: string | null };
  readonly note: string | null;
  readonly assignedAt: string;
  readonly withdrawn: boolean;
  readonly students: number;
  readonly done: { readonly suppressed: boolean; readonly count: number | null };
}

export interface FacultySessionDto {
  readonly id: string;
  readonly title: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly state: string;
  readonly attendees: number;
  readonly content: readonly { readonly kind: LearningContentKind; readonly title: string; readonly skillName: string }[];
}

export interface FacultyOverrideDto {
  readonly id: string;
  readonly student: { readonly profileId: string; readonly fullName: string; readonly rollNumber: string } | null;
  readonly action: FacultyOverrideAction;
  readonly resource: LearningResourceRefDto & { readonly title: string; readonly skillName: string };
  readonly reasonCode: string;
  readonly state: 'PENDING' | 'APPLIED' | 'WITHDRAWN';
  readonly createdAt: string;
}

export interface FacultyLearningActionsDto {
  readonly mode: 'ASSIGNMENTS' | 'MEMBERSHIP';
  /** False without an active teaching assignment: the lecturer can browse but not act. */
  readonly canAct: boolean;
  readonly targets: readonly { readonly unitId: string; readonly kind: string; readonly name: string }[];
  readonly assignments: readonly FacultyAssignmentDto[];
  readonly sessions: readonly FacultySessionDto[];
  readonly overrides: readonly FacultyOverrideDto[];
  readonly overrideActions: readonly FacultyOverrideAction[];
  readonly overrideReasonCodes: readonly string[];
  readonly withdrawReasonCodes: readonly string[];
}

export interface StudentLearningPlanDto {
  readonly student: { readonly profileId: string; readonly fullName: string; readonly rollNumber: string };
  /** The student's plan is shown only while they hold adaptive-learning consent (and it is offered). */
  readonly consent: { readonly offered: boolean; readonly held: boolean };
  readonly latestStep: { readonly action: string; readonly skillName: string | null; readonly reasonCodes: readonly string[] } | null;
  readonly pendingOverride: FacultyOverrideDto | null;
}

/** Exactly one of a taught class or selected students. */
export type LearningActionTarget = { readonly unitId: string } | { readonly studentProfileIds: readonly string[] };

export interface StudentLearningActionsDto {
  readonly assignments: readonly {
    readonly id: string; readonly kind: LearningContentKind; readonly title: string; readonly skillName: string;
    readonly institutionName: string; readonly note: string | null; readonly assignedAt: string; readonly status: 'OPEN' | 'DONE';
  }[];
  readonly sessions: readonly {
    readonly id: string; readonly title: string; readonly institutionName: string; readonly scheduledStartAt: string; readonly scheduledEndAt: string;
    readonly content: readonly { readonly kind: LearningContentKind; readonly title: string; readonly skillName: string }[];
  }[];
  readonly pendingOverride: {
    readonly id: string; readonly action: FacultyOverrideAction; readonly kind: LearningContentKind; readonly title: string; readonly skillName: string;
    readonly reasonCode: string; readonly note: string | null; readonly institutionName: string; readonly createdAt: string;
  } | null;
}

const institutionPath = (institutionId: string) => `/api/v1/institutions/${encodeURIComponent(institutionId)}`;
const withSignal = (token: string, signal?: AbortSignal) => ({ token, ...(signal ? { signal } : {}) });

export function listLearningResources(token: string, institutionId: string, query: { readonly q?: string; readonly kind?: LearningContentKind | ''; readonly cursor?: string | null } = {}, signal?: AbortSignal): Promise<LearningResourcesPageDto> {
  const params = new URLSearchParams({ limit: '50' });
  if (query.q) params.set('q', query.q);
  if (query.kind) params.set('kind', query.kind);
  if (query.cursor) params.set('cursor', query.cursor);
  return requestJson(`${institutionPath(institutionId)}/learning-resources?${params.toString()}`, withSignal(token, signal));
}

export function getFacultyLearningActions(token: string, institutionId: string, signal?: AbortSignal): Promise<FacultyLearningActionsDto> {
  return requestJson(`${institutionPath(institutionId)}/learning-actions`, withSignal(token, signal));
}

export function createLearningAssignment(token: string, institutionId: string, body: { readonly resource: LearningResourceRefDto; readonly note?: string } & LearningActionTarget): Promise<{ readonly assignment: { readonly id: string; readonly students: number } }> {
  return requestJson(`${institutionPath(institutionId)}/learning-assignments`, { token, method: 'POST', body });
}

export function listLearningAssignmentStudents(token: string, institutionId: string, assignmentId: string): Promise<{ readonly students: readonly { readonly profileId: string; readonly fullName: string; readonly rollNumber: string; readonly status: 'DONE' | 'NOT_YET' }[] }> {
  return requestJson(`${institutionPath(institutionId)}/learning-assignments/${encodeURIComponent(assignmentId)}/students`, { token });
}

export function withdrawLearningAssignment(token: string, institutionId: string, assignmentId: string, reasonCode: string): Promise<unknown> {
  return requestJson(`${institutionPath(institutionId)}/learning-assignments/${encodeURIComponent(assignmentId)}/withdraw`, { token, method: 'POST', body: { reasonCode } });
}

export function createGroupSession(token: string, institutionId: string, body: {
  readonly title: string; readonly scheduledStartAt: string; readonly scheduledEndAt: string; readonly resources: readonly LearningResourceRefDto[]; readonly note?: string;
} & LearningActionTarget): Promise<{ readonly session: { readonly id: string; readonly attendees: number } }> {
  return requestJson(`${institutionPath(institutionId)}/group-sessions`, { token, method: 'POST', body });
}

export function getStudentLearningPlan(token: string, institutionId: string, profileId: string, signal?: AbortSignal): Promise<StudentLearningPlanDto> {
  return requestJson(`${institutionPath(institutionId)}/students/${encodeURIComponent(profileId)}/learning-plan`, withSignal(token, signal));
}

export function createPlanOverride(token: string, institutionId: string, profileId: string, body: {
  readonly action: FacultyOverrideAction; readonly resource: LearningResourceRefDto; readonly reasonCode: string; readonly note?: string;
}): Promise<{ readonly override: { readonly id: string; readonly state: string } }> {
  return requestJson(`${institutionPath(institutionId)}/students/${encodeURIComponent(profileId)}/plan-overrides`, { token, method: 'POST', body });
}

export function withdrawPlanOverride(token: string, institutionId: string, overrideId: string, reasonCode: string): Promise<unknown> {
  return requestJson(`${institutionPath(institutionId)}/plan-overrides/${encodeURIComponent(overrideId)}/withdraw`, { token, method: 'POST', body: { reasonCode } });
}

export function getMyLearningActions(token: string, signal?: AbortSignal): Promise<StudentLearningActionsDto> {
  return requestJson('/api/v1/students/me/learning-actions', withSignal(token, signal));
}
