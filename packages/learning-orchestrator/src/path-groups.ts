/**
 * The student's path in three groups — skip, review, learn — policy `learning-path-groups-v1` (ENG-18, C1).
 *
 * Why it exists: a new student who picks a role should see, in the first session, what they can skip, what
 * to review and what to learn. The grouping uses the same distinctions as planner v1 (a due review first, a
 * met requirement needs nothing, a partial or already-practised skill is practised, a new one is learned), so
 * the path never contradicts the next step the planner gives. Design:
 * docs/architecture/learning-step-items-table-design.md.
 *
 * Pure and deterministic: no database, clock or model. It carries labels only — a gap status, an evidence band
 * and reason codes — never a number about the student (no readiness, no likelihood, no due date).
 */
import type { PlannerGapItem, SkillBand } from './index.js';

export const PATH_GROUPS_POLICY_VERSION = 'learning-path-groups-v1' as const;

export const pathGroups = ['SKIP', 'REVIEW', 'LEARN'] as const;
export type PathGroup = (typeof pathGroups)[number];

export const pathReasonCodes = ['DUE_REVIEW', 'ALREADY_MET', 'GAP_PARTIAL', 'PRACTISED_BEFORE', 'GAP_MISSING', 'GAP_UNKNOWN', 'NEW_SKILL'] as const;
export type PathReasonCode = (typeof pathReasonCodes)[number];

/** What the grouping needs to know about one skill from the attempt history (adaptive only). */
export interface PathSkillState {
  readonly skillId: string;
  readonly attemptCount: number;
  readonly evidenceBand: SkillBand;
}

export interface PathInput {
  /** The student holds adaptive-learning consent (ENG-01). Without it, skill states and due reviews are ignored. */
  readonly adaptive: boolean;
  readonly gapItems: readonly PlannerGapItem[];
  /** Adaptive only: skill states from the projection. */
  readonly skillStates: readonly PathSkillState[];
  /** Adaptive only: due skills, earliest due first (review-scheduler's order). */
  readonly dueSkillIds: readonly string[];
  /** Evidence bands from the existing evidence path (mastery_projections), used when not adaptive. */
  readonly evidenceBands: ReadonlyMap<string, SkillBand>;
}

export interface PathEntry {
  readonly skillId: string;
  readonly requirementLevel: PlannerGapItem['requirementLevel'];
  readonly gapStatus: PlannerGapItem['status'];
  readonly band: SkillBand;
  readonly due: boolean;
  readonly reasonCodes: readonly PathReasonCode[];
}

export interface LearningPathGroups {
  readonly policyVersion: typeof PATH_GROUPS_POLICY_VERSION;
  readonly skip: readonly PathEntry[];
  readonly review: readonly PathEntry[];
  readonly learn: readonly PathEntry[];
}

/**
 * Group the primary target's requirements. Due reviews come first in `review`, in due order (C7); then each
 * group follows the gap's priority rank. A skill with one attempt or one evidence record is always
 * `NOT_ENOUGH_EVIDENCE` because both band sources say so (C3); nothing here upgrades a band.
 */
export function groupLearningPath(input: PathInput): LearningPathGroups {
  const items = [...input.gapItems].sort((left, right) => left.priorityRank - right.priorityRank
    || (left.topicId < right.topicId ? -1 : left.topicId > right.topicId ? 1 : 0));
  const states = new Map(input.adaptive ? input.skillStates.map((state) => [state.skillId.toLowerCase(), state] as const) : []);
  const dueOrder = new Map<string, number>();
  if (input.adaptive) input.dueSkillIds.forEach((id, index) => { if (!dueOrder.has(id.toLowerCase())) dueOrder.set(id.toLowerCase(), index); });

  const skip: PathEntry[] = [];
  const dueReview: { entry: PathEntry; order: number }[] = [];
  const review: PathEntry[] = [];
  const learn: PathEntry[] = [];
  for (const item of items) {
    const key = item.topicId.toLowerCase();
    const state = states.get(key);
    const band: SkillBand = input.adaptive
      ? state?.evidenceBand ?? 'NOT_ENOUGH_EVIDENCE'
      : input.evidenceBands.get(key) ?? input.evidenceBands.get(item.topicId) ?? 'NOT_ENOUGH_EVIDENCE';
    const due = dueOrder.has(key);
    const base = { skillId: item.topicId, requirementLevel: item.requirementLevel, gapStatus: item.status, band, due };
    if (due) {
      dueReview.push({ entry: { ...base, reasonCodes: ['DUE_REVIEW'] }, order: dueOrder.get(key)! });
    } else if (item.status === 'MET') {
      skip.push({ ...base, reasonCodes: ['ALREADY_MET'] });
    } else if (item.status === 'PARTIAL') {
      review.push({ ...base, reasonCodes: ['GAP_PARTIAL'] });
    } else if (state && state.attemptCount > 0) {
      review.push({ ...base, reasonCodes: ['PRACTISED_BEFORE', item.status === 'MISSING' ? 'GAP_MISSING' : 'GAP_UNKNOWN'] });
    } else {
      learn.push({
        ...base,
        reasonCodes: [item.status === 'MISSING' ? 'GAP_MISSING' : 'GAP_UNKNOWN', ...(input.adaptive ? ['NEW_SKILL' as const] : [])],
      });
    }
  }
  dueReview.sort((left, right) => left.order - right.order);
  return {
    policyVersion: PATH_GROUPS_POLICY_VERSION,
    skip,
    review: [...dueReview.map((item) => item.entry), ...review],
    learn,
  };
}
