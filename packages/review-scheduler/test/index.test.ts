/**
 * Unit tests for review-scheduler-fsrs-v1 (ENG-09): how a day is rated, how days group, what is
 * stored, that the frozen parameters still match the pinned library, and the due-review order the
 * planner reads (C7).
 */
import { describe, expect, it } from 'vitest';
import { FSRSVersion, default_w, generatorParameters } from 'ts-fsrs';
import type { ProjectionAttempt } from '@planthepath/learning-model/src/index.js';
import { LEARNER_SKILL_STATE_ALGORITHM_ID } from '@planthepath/learning-model/src/index.js';
import {
  PINNED_TS_FSRS_VERSION,
  REVIEW_SCHEDULER_ALGORITHM_ID,
  REVIEW_SCHEDULER_WEIGHTS,
  isDueForReview,
  projectLearnerSkillStatesWithReviews,
  rateReviewDay,
  reviewDays,
  scheduleReviewDays,
  scheduleSkillReview,
  selectDueReviews,
  type ReviewAttempt,
} from '../src/index.js';

/** 10:00 in Asia/Kolkata on September <date>, 2026. */
const at = (date: number, time = '10:00'): string => new Date(`2026-09-${String(date).padStart(2, '0')}T${time}:00+05:30`).toISOString();
const ok = (date: number, extra: Partial<ReviewAttempt> = {}): ReviewAttempt => ({ answered: true, correct: true, occurredAt: at(date), ...extra });
const wrong = (date: number): ReviewAttempt => ({ answered: true, correct: false, occurredAt: at(date) });

describe('the pinned library', () => {
  it('is the ts-fsrs release this algorithm ID was built on, with the same default weights', () => {
    expect(FSRSVersion).toBe(PINNED_TS_FSRS_VERSION);
    expect([...REVIEW_SCHEDULER_WEIGHTS]).toEqual([...default_w]);
    const defaults = generatorParameters();
    expect(defaults.request_retention).toBe(0.9);
    expect(defaults.maximum_interval).toBe(36500);
  });
});

describe('rating a review day', () => {
  it('rates a day of unaided successes GOOD', () => {
    expect(rateReviewDay([ok(1), ok(1, { highestHintLevel: 2 })])).toBe('GOOD');
  });

  it('rates a mixed day HARD', () => {
    expect(rateReviewDay([ok(1), wrong(1)])).toBe('HARD');
    expect(rateReviewDay([ok(1), ok(1, { highestHintLevel: 3 })])).toBe('HARD');
  });

  it('rates a day with no unaided success AGAIN — an assisted success is not a successful review', () => {
    expect(rateReviewDay([wrong(1)])).toBe('AGAIN');
    expect(rateReviewDay([ok(1, { highestHintLevel: 3 })])).toBe('AGAIN');
    expect(rateReviewDay([ok(1, { tutorReplied: true })])).toBe('AGAIN');
    expect(rateReviewDay([ok(1, { assisted: true }), wrong(1)])).toBe('AGAIN');
  });

  it('never rates EASY and refuses a day with nothing answered', () => {
    expect(() => rateReviewDay([{ answered: false, correct: false, occurredAt: at(1) }])).toThrow();
  });
});

describe('grouping attempts into review days', () => {
  it('makes one review per Asia/Kolkata calendar day, in day order, ignoring blanks', () => {
    const days = reviewDays([ok(3), wrong(1), { answered: false, correct: false, occurredAt: at(2) }, ok(1)]);
    expect(days).toEqual([{ day: '2026-09-01', rating: 'HARD' }, { day: '2026-09-03', rating: 'GOOD' }]);
  });

  it('counts Kolkata days, not UTC days', () => {
    // 23:50 and 00:10 Kolkata are the same UTC day but different Kolkata days.
    const days = reviewDays([ok(1, { occurredAt: at(1, '23:50') }), ok(2, { occurredAt: at(2, '00:10') })]);
    expect(days.map((item) => item.day)).toEqual(['2026-09-01', '2026-09-02']);
    // 00:10 and 23:50 on one Kolkata day are one review.
    expect(reviewDays([ok(1, { occurredAt: at(1, '00:10') }), wrong(1)])).toHaveLength(1);
  });

  it('refuses a correct blank', () => {
    expect(() => reviewDays([{ answered: false, correct: true, occurredAt: at(1) }])).toThrow();
  });
});

describe('the schedule', () => {
  it('has nothing to schedule without an answered attempt', () => {
    expect(scheduleSkillReview([])).toBeNull();
    expect(scheduleSkillReview([{ answered: false, correct: false, occurredAt: at(1) }])).toBeNull();
  });

  it('puts the due date at the start of a later Kolkata day', () => {
    const schedule = scheduleSkillReview([ok(1)])!;
    expect(schedule.algorithmId).toBe(REVIEW_SCHEDULER_ALGORITHM_ID);
    expect(schedule.lastReviewDay).toBe('2026-09-01');
    expect(schedule.dueDay > '2026-09-01').toBe(true);
    expect(schedule.dueAt).toBe(new Date(`${schedule.dueDay}T00:00:00+05:30`).toISOString());
    expect(schedule.reviewCount).toBe(1);
  });

  it('does not depend on the time of day within the review day', () => {
    const morning = scheduleSkillReview([ok(1, { occurredAt: at(1, '00:01') }), ok(4, { occurredAt: at(4, '00:01') })]);
    const night = scheduleSkillReview([ok(1, { occurredAt: at(1, '23:59') }), ok(4, { occurredAt: at(4, '23:59') })]);
    expect(night).toEqual(morning);
  });

  it('schedules a lapse sooner than a success, and an assisted success like a lapse', () => {
    const good = scheduleSkillReview([ok(1), ok(5)])!;
    const lapse = scheduleSkillReview([ok(1), wrong(5)])!;
    const assisted = scheduleSkillReview([ok(1), ok(5, { highestHintLevel: 3 })])!;
    expect(lapse.dueAt < good.dueAt).toBe(true);
    expect(assisted).toEqual(lapse);
    expect(lapse.lapseCount).toBe(1);
  });

  it('refuses review days that are not strictly increasing', () => {
    expect(() => scheduleReviewDays([{ day: '2026-09-02', rating: 'GOOD' }, { day: '2026-09-02', rating: 'GOOD' }])).toThrow();
    expect(() => scheduleReviewDays([{ day: 'not-a-day', rating: 'GOOD' }])).toThrow();
  });
});

describe('learner_skill_state rows with reviews', () => {
  const attempt = (id: string, skillIds: string[], date: number, extra: Partial<ProjectionAttempt> = {}): ProjectionAttempt => ({
    id, itemId: `item-${id}`, context: 'ASSESSMENT', answered: true, correct: true, occurredAt: at(date),
    institutionId: null, skillIds, misconceptions: [], ...extra,
  });

  it('fills the four review values together, rounded for their columns, and leaves a no-attempt row null', () => {
    const rows = projectLearnerSkillStatesWithReviews([
      attempt('a1', ['skill-a'], 1),
      attempt('a2', ['skill-a'], 3, { correct: false }),
      attempt('a3', ['skill-a'], 3, { correct: false, misconceptions: [{ code: 'SUBNET_BOUNDARY', skillId: 'skill-b' }] }),
    ]);
    expect(rows.map((row) => row.skillId)).toEqual(['skill-a', 'skill-b']);
    const [a, b] = rows;
    expect(a!.reviewAlgorithmVersion).toBe(REVIEW_SCHEDULER_ALGORITHM_ID);
    expect(a!.reviewStability).toBeGreaterThan(0);
    expect(Math.round(a!.reviewStability! * 10_000) / 10_000).toBe(a!.reviewStability);
    expect(a!.reviewDifficulty).toBeGreaterThanOrEqual(1);
    expect(a!.reviewDifficulty).toBeLessThanOrEqual(10);
    expect(a!.reviewDueAt).toBe(scheduleSkillReview([
      { answered: true, correct: true, occurredAt: at(1) },
      { answered: true, correct: false, occurredAt: at(3) },
      { answered: true, correct: false, occurredAt: at(3) },
    ])!.dueAt);
    expect(b).toMatchObject({ attemptCount: 0, reviewStability: null, reviewDifficulty: null, reviewDueAt: null, reviewAlgorithmVersion: null });
    // The learning-model columns are exactly the learning model's own rule (v2 since ENG-06).
    expect(a!.algorithmVersion).toBe(LEARNER_SKILL_STATE_ALGORITHM_ID);
  });

  it('counts an exam item mapped to two topics as a review of both', () => {
    const rows = projectLearnerSkillStatesWithReviews([attempt('e1', ['skill-a', 'skill-b'], 2)]);
    expect(rows.map((row) => row.reviewDueAt)).toEqual([rows[0]!.reviewDueAt, rows[0]!.reviewDueAt]);
    expect(rows[0]!.reviewDueAt).not.toBeNull();
  });
});

describe('due reviews (C7)', () => {
  const rows = [
    { skillId: 'c', reviewDueAt: '2026-09-10T18:30:00.000Z' },
    { skillId: 'a', reviewDueAt: '2026-09-05T18:30:00.000Z' },
    { skillId: 'b', reviewDueAt: '2026-09-05T18:30:00.000Z' },
    { skillId: 'd', reviewDueAt: null },
    { skillId: 'e', reviewDueAt: '2026-09-20T18:30:00.000Z' },
  ];

  it('returns only skills past their due instant, the longest overdue first, ties by skill', () => {
    expect(selectDueReviews(rows, '2026-09-12T00:00:00.000Z').map((row) => row.skillId)).toEqual(['a', 'b', 'c']);
  });

  it('makes a skill due exactly at its due instant, not before', () => {
    expect(isDueForReview('2026-09-10T18:30:00.000Z', '2026-09-10T18:29:59.999Z')).toBe(false);
    expect(isDueForReview('2026-09-10T18:30:00.000Z', '2026-09-10T18:30:00.000Z')).toBe(true);
    expect(isDueForReview(null, '2030-01-01T00:00:00.000Z')).toBe(false);
  });

  it('puts a skill not practised for its due interval ahead of one practised recently', () => {
    const stale = scheduleSkillReview([ok(1), ok(2)])!;
    const fresh = scheduleSkillReview([ok(1), ok(2), ok(20)])!;
    const asOf = new Date(Date.parse(fresh.dueAt) + 1).toISOString();
    const due = selectDueReviews([{ skillId: 'z-fresh', reviewDueAt: fresh.dueAt }, { skillId: 'y-stale', reviewDueAt: stale.dueAt }], asOf);
    expect(due[0]!.skillId).toBe('y-stale');
  });
});
