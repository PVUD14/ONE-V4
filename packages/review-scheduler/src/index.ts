/**
 * The review scheduler (ENG-09), algorithm `review-scheduler-fsrs-v1`: when each skill is next
 * due for review, from the student's graded attempts, using FSRS through ts-fsrs 5.4.2 (MIT).
 *
 * Why it exists: a skill demonstrated weeks ago may have faded, and the planner (ENG-08) must put a
 * skill that has passed its due interval first in the next session (C7). The schedule is stored in
 * learner_skill_state's review columns by the ENG-05 projector, so it must rebuild exactly from
 * facts. Design: docs/architecture/review-scheduler-design.md.
 *
 * Pure and deterministic (ADR-034): no database, clock, randomness or network. Time arrives only as
 * attempt timestamps and an explicit `asOf`. Fuzz and minute-scale learning steps are off, every
 * FSRS parameter is passed explicitly, and a review is one skill on one Asia/Kolkata calendar day.
 * An assisted success is not a successful review (C5, via learning-model-v1's isAssistedAttempt).
 *
 * FSRS stability, difficulty and due dates are model state: never a score, never readiness, never
 * shown to an employer. Nothing here touches readiness.
 */
import { FSRSVersion, Rating, State, createEmptyCard, fsrs, type Card, type FSRS, type Grade } from 'ts-fsrs';
import {
  LearningModelError,
  calendarDayInKolkata,
  isAssistedAttempt,
  projectLearnerSkillStates,
  type LearnerSkillStateRow,
  type ProjectionAttempt,
} from '@planthepath/learning-model/src/index.js';

export const REVIEW_SCHEDULER_ALGORITHM_ID = 'review-scheduler-fsrs-v1' as const;
export type ReviewSchedulerAlgorithmId = typeof REVIEW_SCHEDULER_ALGORITHM_ID;

/** The ts-fsrs release this algorithm ID was built and tested against. */
export const PINNED_TS_FSRS_VERSION = 'v5.4.2 using FSRS-6.0' as const;

/**
 * FSRS-6 default weights as shipped in ts-fsrs 5.4.2, frozen here so a library upgrade cannot
 * change a schedule silently. A test compares them with the library's defaults.
 */
export const REVIEW_SCHEDULER_WEIGHTS: readonly number[] = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]);

export const REVIEW_SCHEDULER_PARAMETERS = Object.freeze({
  requestRetention: 0.9,
  maximumIntervalDays: 36500,
  enableFuzz: false,
  enableShortTerm: false,
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** Asia/Kolkata has been UTC+05:30, without daylight saving, since 1945. */
const KOLKATA_OFFSET = '+05:30';

let scheduler: FSRS | null = null;
function fsrsScheduler(): FSRS {
  if (scheduler === null) {
    if (FSRSVersion !== PINNED_TS_FSRS_VERSION) {
      throw new LearningModelError(`review-scheduler-fsrs-v1 requires ts-fsrs ${PINNED_TS_FSRS_VERSION}`);
    }
    scheduler = fsrs({
      w: [...REVIEW_SCHEDULER_WEIGHTS],
      request_retention: REVIEW_SCHEDULER_PARAMETERS.requestRetention,
      maximum_interval: REVIEW_SCHEDULER_PARAMETERS.maximumIntervalDays,
      enable_fuzz: REVIEW_SCHEDULER_PARAMETERS.enableFuzz,
      enable_short_term: REVIEW_SCHEDULER_PARAMETERS.enableShortTerm,
    });
  }
  return scheduler;
}

// ---------------------------------------------------------------------------
// Review days and ratings
// ---------------------------------------------------------------------------

export const reviewRatings = ['AGAIN', 'HARD', 'GOOD'] as const;
export type ReviewRating = (typeof reviewRatings)[number];

/** One graded attempt on one skill: the fields the scheduler reads. */
export interface ReviewAttempt {
  readonly answered: boolean;
  readonly correct: boolean;
  readonly occurredAt: string;
  readonly highestHintLevel?: number;
  readonly assisted?: boolean;
  readonly tutorReplied?: boolean;
}

/** One review: one skill on one Asia/Kolkata calendar day. */
export interface ReviewDay {
  /** YYYY-MM-DD in Asia/Kolkata. */
  readonly day: string;
  readonly rating: ReviewRating;
}

/**
 * The rating for one day's answered attempts on a skill: every one an unaided success → GOOD; at
 * least one unaided success and at least one wrong or assisted → HARD; no unaided success → AGAIN.
 * An assisted success is never a successful review. EASY is never produced.
 */
export function rateReviewDay(attempts: readonly ReviewAttempt[]): ReviewRating {
  const answered = attempts.filter((attempt) => attempt.answered);
  if (answered.length === 0) throw new LearningModelError('a review day needs at least one answered attempt');
  const unaided = answered.filter((attempt) => attempt.correct && !isAssistedAttempt(attempt)).length;
  if (unaided === 0) return 'AGAIN';
  return unaided === answered.length ? 'GOOD' : 'HARD';
}

/** A skill's review days, in day order. Blanks bear on nothing; input order never matters. */
export function reviewDays(attempts: readonly ReviewAttempt[]): readonly ReviewDay[] {
  const byDay = new Map<string, ReviewAttempt[]>();
  for (const attempt of attempts) {
    if (attempt.correct && !attempt.answered) throw new LearningModelError('an unanswered attempt cannot be correct');
    if (!attempt.answered) continue;
    const day = calendarDayInKolkata(attempt.occurredAt);
    const list = byDay.get(day) ?? [];
    list.push(attempt);
    byDay.set(day, list);
  }
  return [...byDay.keys()].sort().map((day) => ({ day, rating: rateReviewDay(byDay.get(day)!) }));
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

/** FSRS memory state after a skill's last review day. */
export interface ReviewSchedule {
  readonly algorithmId: ReviewSchedulerAlgorithmId;
  /** FSRS stability in days, unrounded. */
  readonly stability: number;
  /** FSRS difficulty, 1–10, unrounded. */
  readonly difficulty: number;
  readonly lastReviewDay: string;
  /** YYYY-MM-DD in Asia/Kolkata. */
  readonly dueDay: string;
  /** Start of the due day in Asia/Kolkata, as an ISO instant (UTC). */
  readonly dueAt: string;
  readonly reviewCount: number;
  readonly lapseCount: number;
}

const GRADES: Record<ReviewRating, Grade> = { AGAIN: Rating.Again, HARD: Rating.Hard, GOOD: Rating.Good };
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A Kolkata day as the instant ts-fsrs sees: its midnight shifted onto UTC, so UTC days are Kolkata days. */
function shiftedMidnight(day: string): Date {
  const value = Date.parse(`${day}T00:00:00Z`);
  if (!DAY_PATTERN.test(day) || !Number.isFinite(value)) throw new LearningModelError('a review day is not a valid date');
  return new Date(value);
}

function startOfKolkataDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00${KOLKATA_OFFSET}`)).toISOString();
}

/**
 * Fold review days into an FSRS schedule. Days must be strictly increasing. Returns null when
 * there is nothing to review.
 */
export function scheduleReviewDays(days: readonly ReviewDay[]): ReviewSchedule | null {
  if (days.length === 0) return null;
  const f = fsrsScheduler();
  let card: Card = createEmptyCard(shiftedMidnight(days[0]!.day));
  let previous: string | null = null;
  for (const { day, rating } of days) {
    if (!(reviewRatings as readonly string[]).includes(rating)) throw new LearningModelError('a review rating is not recognised');
    if (previous !== null && day <= previous) throw new LearningModelError('review days must be strictly increasing');
    card = f.next(card, shiftedMidnight(day), GRADES[rating]).card;
    previous = day;
  }
  if (card.state !== State.Review) throw new LearningModelError('an FSRS card left the review state');
  const dueDay = new Date(shiftedMidnight(previous!).getTime() + card.scheduled_days * DAY_MS).toISOString().slice(0, 10);
  return {
    algorithmId: REVIEW_SCHEDULER_ALGORITHM_ID,
    stability: card.stability,
    difficulty: card.difficulty,
    lastReviewDay: previous!,
    dueDay,
    dueAt: startOfKolkataDay(dueDay),
    reviewCount: card.reps,
    lapseCount: card.lapses,
  };
}

/** A skill's schedule from its graded attempts, or null when none was answered. */
export function scheduleSkillReview(attempts: readonly ReviewAttempt[]): ReviewSchedule | null {
  return scheduleReviewDays(reviewDays(attempts));
}

// ---------------------------------------------------------------------------
// learner_skill_state rows with the review columns filled
// ---------------------------------------------------------------------------

/** A learner_skill_state row whose review columns this algorithm may fill. */
export type ScheduledSkillStateRow = Omit<LearnerSkillStateRow,
  'reviewStability' | 'reviewDifficulty' | 'reviewDueAt' | 'reviewAlgorithmVersion'> & {
  /** Rounded to 4 decimals for numeric(10,4). */
  readonly reviewStability: number | null;
  /** Rounded to 4 decimals for numeric(6,4). */
  readonly reviewDifficulty: number | null;
  readonly reviewDueAt: string | null;
  readonly reviewAlgorithmVersion: ReviewSchedulerAlgorithmId | null;
};

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Every learner_skill_state row for one student (learner-skill-state-v1), with the review columns
 * filled by review-scheduler-fsrs-v1 from the same attempts. Attempts bear on skills exactly as
 * the projector resolved them; a row with no answered attempt keeps all four review values null.
 */
export function projectLearnerSkillStatesWithReviews(attempts: readonly ProjectionAttempt[]): readonly ScheduledSkillStateRow[] {
  const rows = projectLearnerSkillStates(attempts);
  const bySkill = new Map<string, ProjectionAttempt[]>();
  for (const attempt of attempts) {
    if (!attempt.answered) continue;
    for (const skillId of new Set(attempt.skillIds)) {
      const list = bySkill.get(skillId) ?? [];
      list.push(attempt);
      bySkill.set(skillId, list);
    }
  }
  return rows.map((row) => {
    const schedule = scheduleSkillReview(bySkill.get(row.skillId) ?? []);
    return {
      ...row,
      reviewStability: schedule ? round4(schedule.stability) : null,
      reviewDifficulty: schedule ? round4(schedule.difficulty) : null,
      reviewDueAt: schedule ? schedule.dueAt : null,
      reviewAlgorithmVersion: schedule ? REVIEW_SCHEDULER_ALGORITHM_ID : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Due reviews: the planner's input (C7)
// ---------------------------------------------------------------------------

export interface ReviewQueueEntry {
  readonly skillId: string;
  readonly reviewDueAt: string | null;
}

export interface DueReview {
  readonly skillId: string;
  readonly dueAt: string;
}

function epochMs(value: string | Date): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new LearningModelError('a timestamp is not a valid date');
  return parsed;
}

/** Whether a skill is due for review at `asOf`: its due instant has been reached. */
export function isDueForReview(reviewDueAt: string | null, asOf: string | Date): boolean {
  return reviewDueAt !== null && epochMs(reviewDueAt) <= epochMs(asOf);
}

/**
 * The skills due for review at `asOf`, earliest due first (the skill left longest past its
 * interval first), ties by skill id. Skills without a schedule are never due.
 */
export function selectDueReviews(rows: readonly ReviewQueueEntry[], asOf: string | Date): readonly DueReview[] {
  const at = epochMs(asOf);
  return rows
    .filter((row) => row.reviewDueAt !== null && epochMs(row.reviewDueAt) <= at)
    .map((row) => ({ skillId: row.skillId, dueAt: new Date(epochMs(row.reviewDueAt!)).toISOString() }))
    .sort((left, right) => epochMs(left.dueAt) - epochMs(right.dueAt)
      || (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0));
}
