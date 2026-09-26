/**
 * The learner skill state projection rule (ENG-05), algorithm `learner-skill-state-v1`.
 *
 * Why it exists: `learner_skill_state` holds, per student per skill, the stage, counts, band and
 * active misconception codes that the planner, BKT shadow and faculty views read. ADR-034 makes it
 * a projection that must rebuild exactly from facts, so the whole rule lives here as one pure
 * function over one student's attempts: identical facts in any order give identical rows.
 * Design: docs/architecture/learner-skill-state-table-design.md.
 *
 * It composes `learning-model-v1` (stages, C3, C5) with the misconception activity rule below.
 * Changing either is a new algorithm ID. No numeric readiness is produced; mastery and review
 * values stay null until ENG-06 and ENG-09 compute them here.
 */
import {
  LearningModelError,
  isAssistedAttempt,
  summariseSkillEvidence,
  type AttemptContext,
  type EvidenceStage,
  type SkillBand,
} from './index.js';

export const LEARNER_SKILL_STATE_ALGORITHM_ID = 'learner-skill-state-v1' as const;

/** A published misconception an attempt's chosen option signalled, with the code's own skill. */
export interface ProjectionMisconception {
  readonly code: string;
  readonly skillId: string;
}

/** One graded attempt, already resolved to the skills it bears on. */
export interface ProjectionAttempt {
  readonly id: string;
  readonly itemId: string;
  readonly context: AttemptContext;
  readonly answered: boolean;
  readonly correct: boolean;
  readonly highestHintLevel?: number;
  readonly assisted?: boolean;
  readonly tutorReplied?: boolean;
  readonly occurredAt: string;
  readonly institutionId: string | null;
  /** Readiness items: their topic. Exam items: the topics mapped when sat (published results only). */
  readonly skillIds: readonly string[];
  readonly misconceptions: readonly ProjectionMisconception[];
}

export interface LearnerSkillStateRow {
  readonly skillId: string;
  readonly institutionId: string | null;
  readonly attemptCount: number;
  readonly attemptDayCount: number;
  readonly unaidedSuccessCount: number;
  readonly unaidedSuccessDayCount: number;
  readonly assistedSuccessCount: number;
  readonly lastAttemptAt: string | null;
  readonly evidenceStage: EvidenceStage;
  readonly evidenceBand: SkillBand;
  readonly activeMisconceptionCodes: readonly string[];
  readonly masteryLikelihood: null;
  readonly masteryUncertainty: null;
  readonly masteryAlgorithmVersion: null;
  readonly reviewStability: null;
  readonly reviewDifficulty: null;
  readonly reviewDueAt: null;
  readonly reviewAlgorithmVersion: null;
  readonly algorithmVersion: typeof LEARNER_SKILL_STATE_ALGORITHM_ID;
}

function epochMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new LearningModelError('a timestamp is not a valid date');
  return parsed;
}

/** Total order over attempts: time, then id. */
function compareAttempts(left: ProjectionAttempt, right: ProjectionAttempt): number {
  return epochMs(left.occurredAt) - epochMs(right.occurredAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function validate(attempts: readonly ProjectionAttempt[]): void {
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (seen.has(attempt.id)) throw new LearningModelError('an attempt appears twice');
    seen.add(attempt.id);
    epochMs(attempt.occurredAt);
    if (attempt.correct && !attempt.answered) throw new LearningModelError('an unanswered attempt cannot be correct');
    if (attempt.misconceptions.length > 0 && (attempt.correct || !attempt.answered)) {
      throw new LearningModelError('only a wrong answer can signal a misconception');
    }
  }
}

function unaidedSuccess(attempt: ProjectionAttempt): boolean {
  return attempt.answered && attempt.correct && !isAssistedAttempt(attempt);
}

/**
 * Active misconception codes, by the code's skill. A code is active while at least one attempt
 * that signalled it is uncleared; a signal is cleared by a later unaided correct attempt on the
 * same item. Codes are sorted and unique.
 */
export function activeMisconceptionsBySkill(attempts: readonly ProjectionAttempt[]): ReadonlyMap<string, readonly string[]> {
  validate(attempts);
  const ordered = [...attempts].sort(compareAttempts);
  const active = new Map<string, Set<string>>();
  ordered.forEach((signal, index) => {
    if (signal.misconceptions.length === 0) return;
    const cleared = ordered.slice(index + 1).some((later) => later.itemId === signal.itemId && unaidedSuccess(later));
    if (cleared) return;
    for (const misconception of signal.misconceptions) {
      const codes = active.get(misconception.skillId) ?? new Set<string>();
      codes.add(misconception.code);
      active.set(misconception.skillId, codes);
    }
  });
  return new Map([...active].map(([skillId, codes]) => [skillId, [...codes].sort()]));
}

/**
 * Every learner_skill_state row for one student, from that student's attempts. Pure and
 * order-independent. A skill has a row when an answered attempt bears on it or an attempt
 * signalled a misconception filed under it. Blanks bear on nothing.
 */
export function projectLearnerSkillStates(attempts: readonly ProjectionAttempt[]): readonly LearnerSkillStateRow[] {
  validate(attempts);
  const ordered = [...attempts].sort(compareAttempts);
  const bySkill = new Map<string, ProjectionAttempt[]>();
  const contributors = new Map<string, ProjectionAttempt[]>();
  const add = (map: Map<string, ProjectionAttempt[]>, skillId: string, attempt: ProjectionAttempt): void => {
    const list = map.get(skillId) ?? [];
    if (!list.includes(attempt)) list.push(attempt);
    map.set(skillId, list);
  };
  for (const attempt of ordered) {
    if (attempt.answered) {
      for (const skillId of new Set(attempt.skillIds)) {
        add(bySkill, skillId, attempt);
        add(contributors, skillId, attempt);
      }
    }
    for (const misconception of attempt.misconceptions) add(contributors, misconception.skillId, attempt);
  }
  const codes = activeMisconceptionsBySkill(ordered);

  return [...contributors.keys()].sort().map((skillId) => {
    const skillAttempts = bySkill.get(skillId) ?? [];
    const summary = summariseSkillEvidence(skillAttempts.map((attempt) => ({
      id: attempt.id,
      itemId: attempt.itemId,
      context: attempt.context,
      correct: attempt.correct,
      occurredAt: attempt.occurredAt,
      ...(attempt.highestHintLevel !== undefined ? { highestHintLevel: attempt.highestHintLevel } : {}),
      ...(attempt.assisted !== undefined ? { assisted: attempt.assisted } : {}),
      ...(attempt.tutorReplied !== undefined ? { tutorReplied: attempt.tutorReplied } : {}),
    })));
    const contributing = contributors.get(skillId)!;
    const latest = contributing[contributing.length - 1]!;
    const lastAnswered = skillAttempts[skillAttempts.length - 1];
    return {
      skillId,
      institutionId: latest.institutionId,
      attemptCount: summary.attemptCount,
      attemptDayCount: summary.attemptDays.length,
      unaidedSuccessCount: summary.unaidedSuccessCount,
      unaidedSuccessDayCount: summary.unaidedSuccessDays.length,
      assistedSuccessCount: summary.assistedSuccessCount,
      lastAttemptAt: lastAnswered ? new Date(epochMs(lastAnswered.occurredAt)).toISOString() : null,
      evidenceStage: summary.stage,
      evidenceBand: summary.band,
      activeMisconceptionCodes: codes.get(skillId) ?? [],
      masteryLikelihood: null,
      masteryUncertainty: null,
      masteryAlgorithmVersion: null,
      reviewStability: null,
      reviewDifficulty: null,
      reviewDueAt: null,
      reviewAlgorithmVersion: null,
      algorithmVersion: LEARNER_SKILL_STATE_ALGORITHM_ID,
    };
  });
}
