/**
 * Unit and property tests for the attempt log's pure rule (ENG-03).
 *
 * Why: every later engine goal trusts these rows. The properties pin what must hold for any
 * input — a blank is never correct, score stays in [0, 1], a penalty never goes below 0, a
 * hint of 3+ is always assisted (C5), and identical input gives identical output. Properties
 * run over a seeded generator so a failure reproduces exactly; no new dependency is needed.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSISTED_HINT_LEVEL,
  LearningAttemptError,
  normaliseLearningAttempt,
  type GradedResponseInput,
} from '../src/learning-attempts.js';

const base: GradedResponseInput = {
  itemSource: 'CAREER_READINESS_QUESTION',
  itemId: '11111111-1111-4111-8111-111111111111',
  itemVersion: 1,
  skillId: '22222222-2222-4222-8222-222222222222',
  answered: true,
  correct: true,
  marksAwarded: 1,
  marksPossible: 1,
};

describe('normaliseLearningAttempt', () => {
  it('records a correct, unaided answer as full credit', () => {
    expect(normaliseLearningAttempt(base)).toEqual({
      itemSource: 'CAREER_READINESS_QUESTION', itemId: base.itemId, itemVersion: 1, skillId: base.skillId,
      answered: true, correct: true, score: 1, responseTimeMs: null, highestHintLevel: 0, assisted: false,
      selectedOptionId: null, misconceptionCodeIds: [],
    });
  });

  it('never records a blank as correct, whatever the grader said', () => {
    const blank = normaliseLearningAttempt({ ...base, answered: false, correct: true, marksAwarded: 1 });
    expect(blank).toMatchObject({ answered: false, correct: false, score: 0 });
  });

  it('does not carry negative marking into the score', () => {
    expect(normaliseLearningAttempt({ ...base, correct: false, marksAwarded: -0.25 }).score).toBe(0);
  });

  it('records a success after hint 3 as assisted (C5)', () => {
    expect(normaliseLearningAttempt({ ...base, highestHintLevel: 3 }).assisted).toBe(true);
    expect(normaliseLearningAttempt({ ...base, highestHintLevel: 2 }).assisted).toBe(false);
  });

  it('records any tutor reply as assisted (ADR-033 recommended rule)', () => {
    expect(normaliseLearningAttempt({ ...base, highestHintLevel: 0, tutorReplied: true }).assisted).toBe(true);
  });

  it('keeps an unmeasured response time as null, never zero', () => {
    expect(normaliseLearningAttempt(base).responseTimeMs).toBeNull();
    expect(normaliseLearningAttempt({ ...base, responseTimeMs: 1234.6 }).responseTimeMs).toBe(1235);
  });

  it('refuses input the table would reject', () => {
    expect(() => normaliseLearningAttempt({ ...base, itemVersion: 0 })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, highestHintLevel: 5 })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, highestHintLevel: 1.5 })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, responseTimeMs: -1 })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, marksPossible: 0 })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, marksAwarded: Number.NaN })).toThrow(LearningAttemptError);
  });
});

describe('normaliseLearningAttempt misconception link (ENG-07, recorded by ENG-05)', () => {
  const codeA = '33333333-3333-4333-8333-333333333333';
  const codeB = '44444444-4444-4444-8444-444444444444';

  it('records the chosen option and the codes a wrong answer signalled, sorted and without duplicates', () => {
    const row = normaliseLearningAttempt({ ...base, correct: false, marksAwarded: 0, selectedOptionId: 'c',
      misconceptionCodeIds: [codeB, codeA, codeB] });
    expect(row).toMatchObject({ correct: false, selectedOptionId: 'c', misconceptionCodeIds: [codeA, codeB] });
  });

  it('records a correct answer with its option and no codes', () => {
    expect(normaliseLearningAttempt({ ...base, selectedOptionId: 'b' })).toMatchObject({ selectedOptionId: 'b', misconceptionCodeIds: [] });
  });

  it('refuses codes on a correct answer or a blank, a bad option id, or a code that is not a UUID', () => {
    expect(() => normaliseLearningAttempt({ ...base, misconceptionCodeIds: [codeA] })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, answered: false, correct: false, misconceptionCodeIds: [codeA] })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, answered: false, correct: false, selectedOptionId: 'a' })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, selectedOptionId: '' })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, selectedOptionId: 'x'.repeat(65) })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, correct: false, misconceptionCodeIds: ['not-a-uuid'] })).toThrow(LearningAttemptError);
    expect(() => normaliseLearningAttempt({ ...base, correct: false,
      misconceptionCodeIds: Array.from({ length: 17 }, (_, index) => `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`) }))
      .toThrow(LearningAttemptError);
  });
});

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

function randomInput(next: () => number): GradedResponseInput {
  const marksPossible = Math.round((0.25 + next() * 10) * 100) / 100;
  return {
    ...base,
    itemSource: next() < 0.5 ? 'CAREER_READINESS_QUESTION' : 'INSTITUTION_EXAM_QUESTION',
    itemVersion: 1 + Math.floor(next() * 20),
    skillId: next() < 0.5 ? null : base.skillId,
    answered: next() < 0.8,
    correct: next() < 0.5,
    marksPossible,
    marksAwarded: (next() * 3 - 1) * marksPossible,
    highestHintLevel: Math.floor(next() * 5),
    tutorReplied: next() < 0.1,
    responseTimeMs: next() < 0.5 ? null : next() * 600_000,
  };
}

describe('normaliseLearningAttempt properties', () => {
  const cases = Array.from({ length: 2_000 }, (_, index) => {
    const next = generator(index + 1);
    return randomInput(next);
  });

  it('is deterministic for identical input', () => {
    for (const input of cases) expect(normaliseLearningAttempt({ ...input })).toEqual(normaliseLearningAttempt(input));
  });

  it('keeps score within [0, 1], and 0 for every blank', () => {
    for (const input of cases) {
      const row = normaliseLearningAttempt(input);
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(1);
      if (!row.answered) expect(row.score).toBe(0);
    }
  });

  it('never stores a correct answer that was not given', () => {
    for (const input of cases) {
      const row = normaliseLearningAttempt(input);
      if (row.correct) expect(row.answered).toBe(true);
    }
  });

  it('marks every attempt at hint 3 or higher as assisted, and hint alone never un-assists a tutor reply', () => {
    for (const input of cases) {
      const row = normaliseLearningAttempt(input);
      if (row.highestHintLevel >= ASSISTED_HINT_LEVEL) expect(row.assisted).toBe(true);
      if (input.tutorReplied) expect(row.assisted).toBe(true);
      if (row.highestHintLevel < ASSISTED_HINT_LEVEL && !input.tutorReplied) expect(row.assisted).toBe(false);
    }
  });

  it('preserves the item identity it was given', () => {
    for (const input of cases) {
      const row = normaliseLearningAttempt(input);
      expect([row.itemSource, row.itemId, row.itemVersion, row.skillId]).toEqual([input.itemSource, input.itemId, input.itemVersion, input.skillId]);
    }
  });
});
