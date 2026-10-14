/**
 * Unit tests for learning-model-v1 (ENG-04): the assisted rule, calendar days in Asia/Kolkata,
 * the stage transitions, evidence sufficiency, and master-plan scenarios C3 and C5 by name.
 * Design: docs/architecture/evidence-stages-table-design.md.
 */
import { describe, expect, it } from 'vitest';
import {
  LEARNING_MODEL_ALGORITHM_ID,
  LearningModelError,
  advanceStage,
  attemptOutcomeBand,
  calendarDayInKolkata,
  checkRequiredEvidenceTypes,
  distinctCalendarDays,
  hasEnoughEvidence,
  initialStageState,
  isAssistedAttempt,
  normaliseRequiredEvidenceTypes,
  summariseSkillEvidence,
  type SkillAttempt,
} from '../src/index.js';

let sequence = 0;
function attempt(overrides: Partial<SkillAttempt> & { occurredAt: string }): SkillAttempt {
  sequence += 1;
  return { id: `a-${String(sequence).padStart(4, '0')}`, itemId: 'item-1', context: 'ASSESSMENT', correct: true,
    highestHintLevel: 0, ...overrides };
}

// Two moments on different Asia/Kolkata days, and two on the same one.
const DAY_1_MORNING = '2026-09-01T03:30:00.000Z'; // 09:00 IST, 1 Sep
const DAY_1_EVENING = '2026-09-01T14:30:00.000Z'; // 20:00 IST, 1 Sep
const DAY_2_MORNING = '2026-09-02T03:30:00.000Z'; // 09:00 IST, 2 Sep
const DAY_3_MORNING = '2026-09-03T03:30:00.000Z';

describe('algorithm identity', () => {
  it('is versioned by an algorithm ID string', () => {
    expect(LEARNING_MODEL_ALGORITHM_ID).toBe('learning-model-v1');
    expect(summariseSkillEvidence([]).algorithmId).toBe('learning-model-v1');
  });
});

describe('assisted rule', () => {
  it('marks hint level 3 and 4 as assisted, 0 to 2 as unaided', () => {
    expect([0, 1, 2, 3, 4].map((level) => isAssistedAttempt({ highestHintLevel: level })))
      .toEqual([false, false, false, true, true]);
  });

  it('marks any AI tutor reply as assisted, whatever the hint level (ADR-033)', () => {
    expect(isAssistedAttempt({ highestHintLevel: 0, tutorReplied: true })).toBe(true);
  });

  it('never turns a recorded assisted attempt back into an unaided one', () => {
    expect(isAssistedAttempt({ highestHintLevel: 0, assisted: true })).toBe(true);
  });

  it('refuses hint levels it cannot interpret', () => {
    for (const level of [-1, 5, 2.5, Number.NaN]) {
      expect(() => isAssistedAttempt({ highestHintLevel: level })).toThrow(LearningModelError);
    }
  });
});

describe('calendar days in Asia/Kolkata', () => {
  it('counts the day in India, not in UTC', () => {
    // 20:00 UTC on 1 Sep is 01:30 IST on 2 Sep.
    expect(calendarDayInKolkata('2026-09-01T20:00:00.000Z')).toBe('2026-09-02');
    // 18:29:59 UTC is still 23:59:59 IST the same day; one second later is the next day.
    expect(calendarDayInKolkata('2026-09-01T18:29:59.000Z')).toBe('2026-09-01');
    expect(calendarDayInKolkata('2026-09-01T18:30:00.000Z')).toBe('2026-09-02');
  });

  it('agrees with the named zone in the platform timezone database', () => {
    const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
    for (let hour = 0; hour < 24 * 400; hour += 7) {
      const moment = new Date(Date.UTC(2026, 0, 1) + hour * 3_600_000);
      expect(calendarDayInKolkata(moment)).toBe(format.format(moment));
    }
  });

  it('treats a same-day pair as one day and a cross-midnight pair as two', () => {
    expect(distinctCalendarDays([DAY_1_MORNING, DAY_1_EVENING])).toBe(1);
    expect(distinctCalendarDays([DAY_1_EVENING, DAY_2_MORNING])).toBe(2);
    expect(hasEnoughEvidence([DAY_1_MORNING, DAY_1_EVENING])).toBe(false);
    expect(hasEnoughEvidence([DAY_1_MORNING, DAY_2_MORNING])).toBe(true);
  });

  it('refuses an invalid timestamp', () => {
    expect(() => calendarDayInKolkata('not a date')).toThrow(LearningModelError);
  });
});

describe('C3 — a student with one attempt shows "not enough evidence", never "developing"', () => {
  it('one wrong attempt is NOT_ENOUGH_EVIDENCE, not DEVELOPING', () => {
    const summary = summariseSkillEvidence([attempt({ correct: false, occurredAt: DAY_1_MORNING })]);
    expect(summary.band).toBe('NOT_ENOUGH_EVIDENCE');
    expect(summary.sufficiency).toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('one correct attempt is NOT_ENOUGH_EVIDENCE too', () => {
    expect(summariseSkillEvidence([attempt({ occurredAt: DAY_1_MORNING })]).band).toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('two attempts on the same day are still NOT_ENOUGH_EVIDENCE (baseline defect (c))', () => {
    const summary = summariseSkillEvidence([
      attempt({ correct: false, occurredAt: DAY_1_MORNING }),
      attempt({ correct: false, occurredAt: DAY_1_EVENING }),
    ]);
    expect(summary.band).toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('no attempts at all is NOT_ENOUGH_EVIDENCE', () => {
    expect(summariseSkillEvidence([]).band).toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('shows a band only once attempts fall on two calendar days', () => {
    const summary = summariseSkillEvidence([
      attempt({ correct: false, occurredAt: DAY_1_MORNING }),
      attempt({ correct: false, occurredAt: DAY_2_MORNING }),
    ]);
    expect(summary.band).toBe('DEVELOPING');
  });

  it('labels a first readiness check NOT_ENOUGH_EVIDENCE whatever it scored (outcomeBand)', () => {
    for (const correct of [0, 1, 2, 3, 4]) {
      expect(attemptOutcomeBand({ correct, possible: 4, submittedAttemptTimes: [DAY_1_MORNING] })).toBe('NOT_ENOUGH_EVIDENCE');
    }
    expect(attemptOutcomeBand({ correct: 1, possible: 4, submittedAttemptTimes: [DAY_1_MORNING, DAY_1_EVENING] }))
      .toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('keeps the previous ratio thresholds once checks span two days', () => {
    const times = [DAY_1_MORNING, DAY_2_MORNING];
    expect(attemptOutcomeBand({ correct: 4, possible: 4, submittedAttemptTimes: times })).toBe('DEMONSTRATED');
    expect(attemptOutcomeBand({ correct: 3, possible: 5, submittedAttemptTimes: times })).toBe('PROGRESSING');
    expect(attemptOutcomeBand({ correct: 1, possible: 4, submittedAttemptTimes: times })).toBe('DEVELOPING');
  });

  it('refuses an impossible attempt outcome', () => {
    expect(() => attemptOutcomeBand({ correct: 5, possible: 4, submittedAttemptTimes: [DAY_1_MORNING] })).toThrow(LearningModelError);
    expect(() => attemptOutcomeBand({ correct: 0, possible: 0, submittedAttemptTimes: [DAY_1_MORNING] })).toThrow(LearningModelError);
  });
});

describe('C5 — solving after hint 3 is assisted and does not count toward DEMONSTRATED', () => {
  it('records a hint-3 success as assisted', () => {
    const summary = summariseSkillEvidence([attempt({ highestHintLevel: 3, occurredAt: DAY_1_MORNING })]);
    expect(summary.assistedSuccessCount).toBe(1);
    expect(summary.unaidedSuccessCount).toBe(0);
  });

  it('hint-3 successes on two different days stay ESTIMATED, never DEMONSTRATED', () => {
    const summary = summariseSkillEvidence([
      attempt({ highestHintLevel: 3, occurredAt: DAY_1_MORNING }),
      attempt({ highestHintLevel: 4, occurredAt: DAY_2_MORNING }),
      attempt({ highestHintLevel: 3, occurredAt: DAY_3_MORNING }),
    ]);
    expect(summary.stage).toBe('ESTIMATED');
    expect(summary.band).toBe('DEVELOPING');
  });

  it('an unaided success plus an assisted success on another day is not DEMONSTRATED', () => {
    const summary = summariseSkillEvidence([
      attempt({ occurredAt: DAY_1_MORNING }),
      attempt({ highestHintLevel: 3, occurredAt: DAY_2_MORNING }),
    ]);
    expect(summary.stage).toBe('RETAINED');
    expect(summary.band).toBe('PROGRESSING');
  });

  it('a tutor-assisted success does not count either', () => {
    const summary = summariseSkillEvidence([
      attempt({ occurredAt: DAY_1_MORNING }),
      attempt({ tutorReplied: true, occurredAt: DAY_2_MORNING }),
    ]);
    expect(summary.stage).toBe('RETAINED');
  });

  it('a hint-2 success is unaided and does count', () => {
    const summary = summariseSkillEvidence([
      attempt({ occurredAt: DAY_1_MORNING }),
      attempt({ highestHintLevel: 2, occurredAt: DAY_2_MORNING }),
    ]);
    expect(summary.stage).toBe('DEMONSTRATED');
  });
});

describe('stage transitions', () => {
  it('starts ESTIMATED and stays there on wrong answers', () => {
    expect(initialStageState.stage).toBe('ESTIMATED');
    const summary = summariseSkillEvidence([
      attempt({ correct: false, occurredAt: DAY_1_MORNING }),
      attempt({ correct: false, occurredAt: DAY_2_MORNING }),
    ]);
    expect(summary.stage).toBe('ESTIMATED');
  });

  it('moves to RETAINED on the first unaided success', () => {
    expect(summariseSkillEvidence([attempt({ occurredAt: DAY_1_MORNING })]).stage).toBe('RETAINED');
  });

  it('two unaided successes on one day reach RETAINED, not DEMONSTRATED', () => {
    const summary = summariseSkillEvidence([
      attempt({ occurredAt: DAY_1_MORNING }),
      attempt({ itemId: 'item-2', occurredAt: DAY_1_EVENING }),
    ]);
    expect(summary.stage).toBe('RETAINED');
  });

  it('reaches DEMONSTRATED with unaided successes on two different days', () => {
    const summary = summariseSkillEvidence([
      attempt({ occurredAt: DAY_1_MORNING }),
      attempt({ correct: false, occurredAt: DAY_1_EVENING }),
      attempt({ occurredAt: DAY_2_MORNING }),
    ]);
    expect(summary.stage).toBe('DEMONSTRATED');
    expect(summary.band).toBe('DEMONSTRATED');
    expect(summary.unaidedSuccessDays).toEqual(['2026-09-01', '2026-09-02']);
  });

  it('reaches TRANSFERRED only with a new item in a new context after DEMONSTRATED', () => {
    const demonstrated = [
      attempt({ context: 'PRACTICE', itemId: 'p-1', occurredAt: DAY_1_MORNING }),
      attempt({ context: 'PRACTICE', itemId: 'p-2', occurredAt: DAY_2_MORNING }),
    ];
    // Same context, new item: not transfer.
    expect(summariseSkillEvidence([...demonstrated,
      attempt({ context: 'PRACTICE', itemId: 'p-3', occurredAt: DAY_3_MORNING })]).stage).toBe('DEMONSTRATED');
    // New context, item already attempted: not transfer.
    expect(summariseSkillEvidence([...demonstrated,
      attempt({ context: 'ASSESSMENT', itemId: 'p-1', occurredAt: DAY_3_MORNING })]).stage).toBe('DEMONSTRATED');
    // New context, new item, but assisted: not transfer.
    expect(summariseSkillEvidence([...demonstrated,
      attempt({ context: 'ASSESSMENT', itemId: 'a-1', highestHintLevel: 3, occurredAt: DAY_3_MORNING })]).stage).toBe('DEMONSTRATED');
    // New context, new item, unaided: transfer.
    const transferred = summariseSkillEvidence([...demonstrated,
      attempt({ context: 'ASSESSMENT', itemId: 'a-1', occurredAt: DAY_3_MORNING })]);
    expect(transferred.stage).toBe('TRANSFERRED');
    expect(transferred.band).toBe('DEMONSTRATED');
  });

  it('cannot transfer when every success so far was in the only context used (today\'s ASSESSMENT-only data)', () => {
    const summary = summariseSkillEvidence([
      attempt({ itemId: 'q-1', occurredAt: DAY_1_MORNING }),
      attempt({ itemId: 'q-2', occurredAt: DAY_2_MORNING }),
      attempt({ itemId: 'q-3', occurredAt: DAY_3_MORNING }),
    ]);
    expect(summary.stage).toBe('DEMONSTRATED');
  });

  it('never skips a stage on one attempt: a first success on day 2 after nothing is RETAINED', () => {
    const state = advanceStage(initialStageState, attempt({ occurredAt: DAY_2_MORNING }));
    expect(state.stage).toBe('RETAINED');
  });

  it('does not demote on a later wrong answer', () => {
    const summary = summariseSkillEvidence([
      attempt({ occurredAt: DAY_1_MORNING }),
      attempt({ occurredAt: DAY_2_MORNING }),
      attempt({ correct: false, occurredAt: DAY_3_MORNING }),
      attempt({ correct: false, highestHintLevel: 4, occurredAt: DAY_3_MORNING }),
    ]);
    expect(summary.stage).toBe('DEMONSTRATED');
  });

  it('refuses attempts folded out of time order', () => {
    const later = advanceStage(initialStageState, attempt({ occurredAt: DAY_2_MORNING }));
    expect(() => advanceStage(later, attempt({ occurredAt: DAY_1_MORNING }))).toThrow(LearningModelError);
  });

  it('refuses an unknown context or a missing item', () => {
    expect(() => advanceStage(initialStageState, attempt({ context: 'HOMEWORK' as never, occurredAt: DAY_1_MORNING })))
      .toThrow(LearningModelError);
    expect(() => advanceStage(initialStageState, attempt({ itemId: '', occurredAt: DAY_1_MORNING }))).toThrow(LearningModelError);
  });

  it('returns counts that explain the band and no score', () => {
    const summary = summariseSkillEvidence([
      attempt({ occurredAt: DAY_1_MORNING }),
      attempt({ correct: false, occurredAt: DAY_2_MORNING }),
    ]);
    expect(summary).toMatchObject({ attemptCount: 2, unaidedSuccessCount: 1, assistedSuccessCount: 0 });
    for (const key of Object.keys(summary)) expect(key).not.toMatch(/score|percent|ratio|readiness/i);
  });
});

describe('required evidence types for career requirements', () => {
  const topicId = 'topic-1';

  it('an empty list requires nothing', () => {
    expect(checkRequiredEvidenceTypes({ topicId, requiredEvidenceTypes: [] }, [])).toMatchObject({ satisfied: true, missingTypes: [] });
  });

  it('reports present and missing types for the requirement topic only', () => {
    const check = checkRequiredEvidenceTypes({ topicId, requiredEvidenceTypes: ['ASSESSMENT_OUTCOME', 'LESSON_COMPLETION'] }, [
      { id: 'e1', evidenceType: 'LESSON_COMPLETION', topicId, assisted: false },
      { id: 'e2', evidenceType: 'ASSESSMENT_OUTCOME', topicId: 'other-topic', assisted: false },
    ]);
    expect(check).toMatchObject({ satisfied: false, presentTypes: ['LESSON_COMPLETION'], missingTypes: ['ASSESSMENT_OUTCOME'] });
  });

  it('never lets assisted evidence satisfy a requirement', () => {
    const check = checkRequiredEvidenceTypes({ topicId, requiredEvidenceTypes: ['ASSESSMENT_OUTCOME'] }, [
      { id: 'e1', evidenceType: 'ASSESSMENT_OUTCOME', topicId, assisted: true },
    ]);
    expect(check.satisfied).toBe(false);
  });

  it('ignores evidence that has been superseded', () => {
    const check = checkRequiredEvidenceTypes({ topicId, requiredEvidenceTypes: ['ASSESSMENT_OUTCOME'] }, [
      { id: 'e1', evidenceType: 'ASSESSMENT_OUTCOME', topicId, assisted: false },
      { id: 'e2', evidenceType: 'LESSON_COMPLETION', topicId, assisted: false, supersedesEvidenceId: 'e1' },
    ]);
    expect(check.satisfied).toBe(false);
  });

  it('normalises duplicates and order, and refuses types the product cannot record', () => {
    expect(normaliseRequiredEvidenceTypes(['TOPIC_DEMONSTRATION', 'LESSON_COMPLETION', 'TOPIC_DEMONSTRATION']))
      .toEqual(['LESSON_COMPLETION', 'TOPIC_DEMONSTRATION']);
    expect(() => normaliseRequiredEvidenceTypes(['CERTIFICATE'])).toThrow(LearningModelError);
  });
});
