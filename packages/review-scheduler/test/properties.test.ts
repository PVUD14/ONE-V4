/**
 * Property tests for review-scheduler-fsrs-v1 (ENG-09 acceptance: due dates are monotonic for
 * successful reviews), plus determinism, order independence, bounds and the assisted rule. Random
 * histories come from a seeded generator, so a failure reproduces exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  reviewRatings,
  scheduleReviewDays,
  scheduleSkillReview,
  type ReviewAttempt,
  type ReviewDay,
  type ReviewRating,
} from '../src/index.js';

const RUNS = 300;

/** Mulberry32: small, seeded, deterministic. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const START = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const dayString = (offset: number): string => new Date(START + offset * DAY).toISOString().slice(0, 10);

/** Strictly increasing review days, gaps of 1 to 60 days, ratings from `choices`. */
function randomDays(next: () => number, choices: readonly ReviewRating[], maxLength = 25): ReviewDay[] {
  const length = 1 + Math.floor(next() * maxLength);
  let offset = Math.floor(next() * 10);
  const days: ReviewDay[] = [];
  for (let index = 0; index < length; index += 1) {
    days.push({ day: dayString(offset), rating: choices[Math.floor(next() * choices.length)]! });
    offset += 1 + Math.floor(next() * 60);
  }
  return days;
}

function randomAttempts(next: () => number): ReviewAttempt[] {
  const count = Math.floor(next() * 30);
  return Array.from({ length: count }, () => {
    const answered = next() < 0.9;
    return {
      answered,
      correct: answered && next() < 0.6,
      occurredAt: new Date(START + Math.floor(next() * 120 * DAY)).toISOString(),
      highestHintLevel: Math.floor(next() * 5),
      tutorReplied: next() < 0.05,
    };
  });
}

function shuffle<T>(values: readonly T[], next: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

/** Due date after each prefix of the history. */
function dueTrail(days: readonly ReviewDay[]): string[] {
  return days.map((_, index) => scheduleReviewDays(days.slice(0, index + 1))!.dueAt);
}

describe('review-scheduler-fsrs-v1 properties', () => {
  it('never moves a due date earlier on a successful review (GOOD)', () => {
    const next = generator(1);
    for (let run = 0; run < RUNS; run += 1) {
      const trail = dueTrail(randomDays(next, ['GOOD']));
      for (let index = 1; index < trail.length; index += 1) expect(trail[index]! >= trail[index - 1]!).toBe(true);
    }
  });

  it('never moves a due date earlier on any passing review (GOOD or HARD), after any earlier history', () => {
    const next = generator(2);
    for (let run = 0; run < RUNS; run += 1) {
      const days = randomDays(next, reviewRatings);
      const trail = dueTrail(days);
      for (let index = 1; index < days.length; index += 1) {
        if (days[index]!.rating === 'AGAIN') continue;
        expect(trail[index]! >= trail[index - 1]!).toBe(true);
      }
    }
  });

  it('always schedules the next review after the review day, with stability and difficulty in bounds', () => {
    const next = generator(3);
    for (let run = 0; run < RUNS; run += 1) {
      const days = randomDays(next, reviewRatings);
      const schedule = scheduleReviewDays(days)!;
      expect(schedule.dueDay > days[days.length - 1]!.day).toBe(true);
      expect(schedule.stability).toBeGreaterThan(0);
      expect(schedule.stability).toBeLessThanOrEqual(36500);
      expect(schedule.difficulty).toBeGreaterThanOrEqual(1);
      expect(schedule.difficulty).toBeLessThanOrEqual(10);
      expect(schedule.reviewCount).toBe(days.length);
      expect(schedule.lapseCount).toBe(days.slice(1).filter((day) => day.rating === 'AGAIN').length);
    }
  });

  it('is deterministic and independent of attempt order', () => {
    const next = generator(4);
    for (let run = 0; run < RUNS; run += 1) {
      const attempts = randomAttempts(next);
      const schedule = scheduleSkillReview(attempts);
      expect(scheduleSkillReview(shuffle(attempts, next))).toEqual(schedule);
      expect(scheduleSkillReview(attempts)).toEqual(schedule);
    }
  });

  it('never schedules later because a success was assisted rather than wrong', () => {
    const next = generator(5);
    for (let run = 0; run < RUNS; run += 1) {
      const attempts = randomAttempts(next);
      const assistedAsWrong = attempts.map((attempt) => (attempt.correct && ((attempt.highestHintLevel ?? 0) >= 3 || attempt.tutorReplied)
        ? { ...attempt, correct: false, highestHintLevel: 0, tutorReplied: false }
        : attempt));
      expect(scheduleSkillReview(attempts)).toEqual(scheduleSkillReview(assistedAsWrong));
    }
  });
});
