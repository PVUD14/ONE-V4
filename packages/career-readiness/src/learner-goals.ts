/**
 * Student goals — the pure rules (ENG-19): "Not sure yet" role suggestions (`career-discovery-v1`) and
 * the merge that makes a skill shared by several goals count once (`learner-goal-skills-v1`).
 *
 * Why this exists: onboarding asks "What job do you want?", and a student who does not know yet gets a
 * short survey and 3–5 suggested roles. The suggestion must come from real catalogue rows only and must be
 * explainable, so it is a deterministic function of the student's answers and the catalogue's own fields
 * — no database, clock, randomness or model (ADR-034). Scores order the list and are never returned.
 * Design: docs/architecture/learner-goals-table-design.md.
 */

export const CAREER_DISCOVERY_ALGORITHM = 'career-discovery-v1';
export const LEARNER_GOAL_SKILLS_ALGORITHM = 'learner-goal-skills-v1';

export const LEARNER_GOAL_TYPES = ['ROLE', 'TOPIC', 'EXAM', 'COMPANY', 'DISCOVERY'] as const;
export type LearnerGoalType = (typeof LEARNER_GOAL_TYPES)[number];

/** The survey's interest question: each answer points at catalogue code prefixes (Appendix 4 families). */
export const DISCOVERY_INTERESTS = {
  BUILDING_SOFTWARE: { label: 'Building apps and software', prefixes: ['S'] },
  WORKING_WITH_DATA: { label: 'Finding answers in data', prefixes: ['D'] },
  SECURING_SYSTEMS: { label: 'Protecting systems and networks', prefixes: ['C'] },
  ELECTRONICS_AND_POWER: { label: 'Electronics, circuits and power', prefixes: ['E', 'L'] },
  MACHINES_AND_PLANTS: { label: 'Machines, manufacturing and plants', prefixes: ['M', 'P'] },
  BUILDINGS_AND_INFRASTRUCTURE: { label: 'Buildings, roads and infrastructure', prefixes: ['V'] },
  BUSINESS_AND_PEOPLE: { label: 'Business, customers and operations', prefixes: ['B'] },
} as const satisfies Record<string, { readonly label: string; readonly prefixes: readonly string[] }>;
export type DiscoveryInterest = keyof typeof DISCOVERY_INTERESTS;

/**
 * The survey's strengths question: each answer is a fixed list of word stems matched against the role's
 * own catalogue text (core skill areas, main evidence, summary). Changing a list is a new algorithm id.
 */
export const DISCOVERY_STRENGTHS = {
  NUMBERS: { label: 'Numbers and calculation', stems: ['statistic', 'math', 'quantitative', 'financ', 'account', 'forecast', 'spreadsheet', 'excel', 'estimation', 'costing'] },
  PROGRAMMING: { label: 'Programming', stems: ['programming', 'coding', 'python', 'java', 'sql', 'scripting', 'data structures', 'automation'] },
  COMMUNICATION: { label: 'Explaining and persuading', stems: ['communicat', 'writing', 'presentation', 'negotiat', 'customer', 'stakeholder', 'reporting', 'documentation'] },
  PROBLEM_SOLVING: { label: 'Solving problems', stems: ['problem solving', 'troubleshoot', 'debug', 'root cause', 'analysis'] },
  HANDS_ON: { label: 'Hands-on and design work', stems: ['design', 'cad', 'testing', 'maintenance', 'lab', 'drawing', 'site', 'prototyp', 'simulation'] },
} as const satisfies Record<string, { readonly label: string; readonly stems: readonly string[] }>;
export type DiscoveryStrength = keyof typeof DISCOVERY_STRENGTHS;

/** The branch answer when the student's branch or degree is not in the catalogue's list. */
export const DISCOVERY_BRANCH_NOT_LISTED = 'NOT_LISTED';
const OPEN_BRANCHES = new Set(['all branches', 'any']);

export const DISCOVERY_LIMITS = { minInterests: 1, maxInterests: 3, maxStrengths: 3, minSuggestions: 3, maxSuggestions: 5 } as const;

export interface DiscoveryAnswers {
  readonly interests: readonly DiscoveryInterest[];
  readonly strengths: readonly DiscoveryStrength[];
  /** One of the catalogue's branch labels, or DISCOVERY_BRANCH_NOT_LISTED. */
  readonly branch: string;
}

export class DiscoveryAnswersError extends Error {
  constructor(readonly code: 'INVALID_INTERESTS' | 'INVALID_STRENGTHS' | 'INVALID_BRANCH') {
    super(code);
    this.name = 'DiscoveryAnswersError';
  }
}

function distinctCodes<T extends string>(value: unknown, allowed: readonly T[], min: number, max: number): T[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== 'string' || !(allowed as readonly string[]).includes(entry))) return null;
  const unique = [...new Set(value as T[])];
  if (unique.length !== value.length || unique.length < min || unique.length > max) return null;
  return unique.sort();
}

/**
 * Validates the survey answers against the vocabulary and the catalogue's branch list. Codes come back
 * sorted, so the same answers always give the same input.
 */
export function validateDiscoveryAnswers(raw: unknown, catalogueBranches: readonly string[]): DiscoveryAnswers {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const interests = distinctCodes(body.interests, Object.keys(DISCOVERY_INTERESTS) as DiscoveryInterest[],
    DISCOVERY_LIMITS.minInterests, DISCOVERY_LIMITS.maxInterests);
  if (!interests) throw new DiscoveryAnswersError('INVALID_INTERESTS');
  const strengths = distinctCodes(body.strengths ?? [], Object.keys(DISCOVERY_STRENGTHS) as DiscoveryStrength[], 0, DISCOVERY_LIMITS.maxStrengths);
  if (!strengths) throw new DiscoveryAnswersError('INVALID_STRENGTHS');
  const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
  const known = branch === DISCOVERY_BRANCH_NOT_LISTED
    ? branch
    : catalogueBranches.find((candidate) => candidate.toLowerCase() === branch.toLowerCase());
  if (!known) throw new DiscoveryAnswersError('INVALID_BRANCH');
  return { interests, strengths, branch: known };
}

/** One role the student could select, with only the catalogue fields discovery reads. */
export interface DiscoveryRole {
  readonly id: string;
  readonly catalogueCode: string | null;
  /** Core skill areas, main evidence and summary, as stored. */
  readonly text: string;
  readonly eligibleBranches: readonly string[];
  readonly plannedRelease: 'V1' | 'V2' | 'V3' | null;
  /** The topics of the role's live requirements. */
  readonly requirementTopicIds: readonly string[];
}

export interface DiscoveryInput {
  readonly answers: DiscoveryAnswers;
  readonly roles: readonly DiscoveryRole[];
  /**
   * Skills the student has shown (from placement and practice), or null when the adaptive-learning
   * purpose is not held — then attempt history is not read at all.
   */
  readonly shownSkillIds: readonly string[] | null;
}

export type DiscoveryReasonCode = 'INTEREST_MATCH' | 'STRENGTH_MATCH' | 'BRANCH_MATCH' | 'SHOWN_SKILLS' | 'OPEN_TO_YOUR_BRANCH' | 'OPEN_TO_ALL_BRANCHES';

export interface DiscoveryReason {
  readonly code: DiscoveryReasonCode;
  /** The interest or strength code, or the branch label; absent for SHOWN_SKILLS and the fill reasons. */
  readonly detail?: string;
}

export interface CareerSuggestion {
  readonly roleId: string;
  readonly reasons: readonly DiscoveryReason[];
}

export interface DiscoveryResult {
  readonly algorithmId: typeof CAREER_DISCOVERY_ALGORITHM;
  readonly suggestions: readonly CareerSuggestion[];
  /** Whether the student's shown skills were read (adaptive-learning consent). */
  readonly usedShownSkills: boolean;
  /** True when the catalogue offered fewer roles than the minimum of three. */
  readonly fewerThanMinimum: boolean;
}

function stemMatches(text: string, stem: string): boolean {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}`, 'i').test(text);
}

function isOpenToAll(role: DiscoveryRole): boolean {
  return role.eligibleBranches.length === 0 || role.eligibleBranches.some((branch) => OPEN_BRANCHES.has(branch.trim().toLowerCase()));
}

function namesBranch(role: DiscoveryRole, branch: string): boolean {
  return branch !== DISCOVERY_BRANCH_NOT_LISTED && role.eligibleBranches.some((candidate) => candidate.trim().toLowerCase() === branch.toLowerCase());
}

const PLAN_ORDER: Readonly<Record<string, number>> = { V1: 0, V2: 1, V3: 2 };
function planRank(role: DiscoveryRole): number {
  return role.plannedRelease ? PLAN_ORDER[role.plannedRelease] ?? 3 : 3;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tieBreak(left: DiscoveryRole, right: DiscoveryRole): number {
  return planRank(left) - planRank(right)
    || compareText(left.catalogueCode ?? '~', right.catalogueCode ?? '~')
    || compareText(left.id.toLowerCase(), right.id.toLowerCase());
}

/**
 * Suggests 3–5 roles for a student who is not sure yet. Only roles open to the student's branch are
 * considered; a role is suggested on an interest or strength match, and if fewer than three match, the list
 * is filled with branch-open roles in plan order, each saying why. Deterministic; input order is irrelevant.
 */
export function suggestCareerRoles(input: DiscoveryInput): DiscoveryResult {
  const { answers } = input;
  const shown = input.shownSkillIds ? new Set(input.shownSkillIds.map((id) => id.toLowerCase())) : null;
  const eligible = [...input.roles]
    .filter((role) => isOpenToAll(role) || namesBranch(role, answers.branch))
    .sort(tieBreak);

  const scored: { role: DiscoveryRole; score: number; reasons: DiscoveryReason[] }[] = [];
  const unmatched: DiscoveryRole[] = [];
  for (const role of eligible) {
    const reasons: DiscoveryReason[] = [];
    let score = 0;
    const prefix = role.catalogueCode?.slice(0, 1) ?? null;
    for (const interest of answers.interests) {
      if (prefix && (DISCOVERY_INTERESTS[interest].prefixes as readonly string[]).includes(prefix)) {
        reasons.push({ code: 'INTEREST_MATCH', detail: interest });
        score += 4;
      }
    }
    for (const strength of answers.strengths) {
      if (DISCOVERY_STRENGTHS[strength].stems.some((stem) => stemMatches(role.text, stem))) {
        reasons.push({ code: 'STRENGTH_MATCH', detail: strength });
        score += 1;
      }
    }
    if (reasons.length === 0) {
      unmatched.push(role);
      continue;
    }
    if (namesBranch(role, answers.branch)) {
      reasons.push({ code: 'BRANCH_MATCH', detail: answers.branch });
      score += 2;
    }
    if (shown) {
      const overlap = new Set(role.requirementTopicIds.map((id) => id.toLowerCase()).filter((id) => shown.has(id))).size;
      if (overlap > 0) {
        reasons.push({ code: 'SHOWN_SKILLS' });
        score += Math.min(overlap, 2);
      }
    }
    scored.push({ role, score, reasons });
  }
  scored.sort((left, right) => right.score - left.score || tieBreak(left.role, right.role));

  const suggestions: CareerSuggestion[] = scored.slice(0, DISCOVERY_LIMITS.maxSuggestions)
    .map((entry) => ({ roleId: entry.role.id, reasons: entry.reasons }));
  for (const role of unmatched) {
    if (suggestions.length >= DISCOVERY_LIMITS.minSuggestions) break;
    suggestions.push({
      roleId: role.id,
      reasons: [namesBranch(role, answers.branch) ? { code: 'OPEN_TO_YOUR_BRANCH', detail: answers.branch } : { code: 'OPEN_TO_ALL_BRANCHES' }],
    });
  }
  return {
    algorithmId: CAREER_DISCOVERY_ALGORITHM,
    suggestions,
    usedShownSkills: shown !== null,
    fewerThanMinimum: suggestions.length < DISCOVERY_LIMITS.minSuggestions,
  };
}

// ---------------------------------------------------------------------------
// Shared skills count once
// ---------------------------------------------------------------------------

export type GoalSkillStatus = 'MET' | 'PARTIAL' | 'MISSING' | 'UNKNOWN';

export interface GoalSkillsInput {
  readonly goalId: string;
  readonly goalType: LearnerGoalType;
  /** A role goal's requirement topics with that role's gap status; a topic goal's one topic with null. */
  readonly skills: readonly { readonly topicId: string; readonly topicTitle: string | null; readonly status: GoalSkillStatus | null }[];
}

export interface MergedGoalSkill {
  readonly topicId: string;
  readonly topicTitle: string | null;
  readonly goals: readonly { readonly goalId: string; readonly goalType: LearnerGoalType; readonly status: GoalSkillStatus | null }[];
}

export interface MergedGoalSkills {
  readonly algorithmId: typeof LEARNER_GOAL_SKILLS_ALGORITHM;
  /** Each skill once, in the order goals were given (primary first), then by first appearance. */
  readonly skills: readonly MergedGoalSkill[];
}

/**
 * Every skill the student's goals need, each listed once with every goal that needs it. A skill needed by a
 * role goal and a topic goal is one skill: evidence on it is one set of evidence, read by every role's gap.
 */
export function mergeGoalSkills(goals: readonly GoalSkillsInput[]): MergedGoalSkills {
  const byTopic = new Map<string, { topicId: string; topicTitle: string | null; goals: MergedGoalSkill['goals'][number][] }>();
  for (const goal of goals) {
    const seenInGoal = new Set<string>();
    for (const skill of goal.skills) {
      const key = skill.topicId.toLowerCase();
      if (seenInGoal.has(key)) continue;
      seenInGoal.add(key);
      const entry = byTopic.get(key) ?? { topicId: skill.topicId, topicTitle: skill.topicTitle, goals: [] };
      if (entry.topicTitle === null && skill.topicTitle !== null) entry.topicTitle = skill.topicTitle;
      entry.goals.push({ goalId: goal.goalId, goalType: goal.goalType, status: skill.status });
      byTopic.set(key, entry);
    }
  }
  return { algorithmId: LEARNER_GOAL_SKILLS_ALGORITHM, skills: [...byTopic.values()] };
}
