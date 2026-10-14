/**
 * Property tests for learning-model-v1 (ENG-04 acceptance: stages never skip or move backwards
 * incorrectly, and assisted successes never count). Random histories come from a seeded
 * generator, so a failure reproduces exactly; no new dependency is needed.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceStage,
  attemptContexts,
  initialStageState,
  orderAttempts,
  stageRank,
  summariseSkillEvidence,
  type SkillAttempt,
} from '../src/index.js';

const RUNS = 400;

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

const START = Date.UTC(2026, 8, 1);
const HOUR = 3_600_000;

function randomAttempt(next: () => number, index: number, prefix = 'r'): SkillAttempt {
  return {
    id: `${prefix}-${String(index).padStart(4, '0')}`,
    itemId: `item-${Math.floor(next() * 6)}`,
    context: attemptContexts[Math.floor(next() * attemptContexts.length)]!,
    correct: next() < 0.6,
    highestHintLevel: Math.floor(next() * 5),
    ...(next() < 0.1 ? { tutorReplied: true } : {}),
    // Within about ten days, often several on one day.
    occurredAt: new Date(START + Math.floor(next() * 240) * HOUR).toISOString(),
  };
}

function randomHistory(next: () => number, prefix = 'r'): SkillAttempt[] {
  const length = Math.floor(next() * 14);
  return Array.from({ length }, (_, index) => randomAttempt(next, index, prefix));
}

function shuffle<T>(values: readonly T[], next: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

describe('learning-model-v1 properties', () => {
  it('is deterministic and independent of input order', () => {
    const next = generator(11);
    for (let run = 0; run < RUNS; run += 1) {
      const history = randomHistory(next);
      expect(summariseSkillEvidence(shuffle(history, next))).toEqual(summariseSkillEvidence(history));
    }
  });

  it('never moves a stage backwards and never skips one as attempts are appended in time order', () => {
    const next = generator(23);
    for (let run = 0; run < RUNS; run += 1) {
      let state = initialStageState;
      for (const attempt of orderAttempts(randomHistory(next))) {
        const after = advanceStage(state, attempt);
        const step = stageRank(after.stage) - stageRank(state.stage);
        expect(step === 0 || step === 1).toBe(true);
        state = after;
      }
    }
  });

  it('moves a stage only on an unaided success', () => {
    const next = generator(29);
    for (let run = 0; run < RUNS; run += 1) {
      let state = initialStageState;
      for (const attempt of orderAttempts(randomHistory(next))) {
        const after = advanceStage(state, attempt);
        const unaided = attempt.correct && (attempt.highestHintLevel ?? 0) < 3 && attempt.tutorReplied !== true;
        if (!unaided) expect(after.stage).toBe(state.stage);
        state = after;
      }
    }
  });

  it('never counts assisted successes or wrong answers: adding any number of them never raises a stage', () => {
    // Below TRANSFERRED they change nothing at all. At TRANSFERRED they can only hold a stage
    // back: an item the student has already attempted, even wrongly, is not a new problem.
    const next = generator(31);
    for (let run = 0; run < RUNS; run += 1) {
      const history = randomHistory(next);
      const noise = randomHistory(next, 'n').map((attempt, index) => (
        index % 2 === 0
          ? { ...attempt, correct: true, highestHintLevel: 3 + Math.floor(next() * 2) }
          : { ...attempt, correct: false }
      ));
      const clean = summariseSkillEvidence(history).stage;
      const noisy = summariseSkillEvidence([...history, ...noise]).stage;
      expect(stageRank(noisy)).toBeLessThanOrEqual(stageRank(clean));
      expect(Math.min(stageRank(noisy), stageRank('DEMONSTRATED'))).toBe(Math.min(stageRank(clean), stageRank('DEMONSTRATED')));
    }
  });

  it('only reaches DEMONSTRATED or beyond with unaided successes on two different days', () => {
    const next = generator(37);
    for (let run = 0; run < RUNS; run += 1) {
      const summary = summariseSkillEvidence(randomHistory(next));
      if (stageRank(summary.stage) >= stageRank('DEMONSTRATED')) {
        expect(summary.unaidedSuccessDays.length).toBeGreaterThanOrEqual(2);
      }
      if (summary.stage === 'TRANSFERRED') expect(summary.unaidedSuccessContexts.length).toBeGreaterThanOrEqual(2);
      if (summary.stage === 'ESTIMATED') expect(summary.unaidedSuccessCount).toBe(0);
    }
  });

  it('never shows a band other than NOT_ENOUGH_EVIDENCE on fewer than two attempt days (C3)', () => {
    const next = generator(41);
    for (let run = 0; run < RUNS; run += 1) {
      // Squash every attempt onto one day.
      const oneDay = randomHistory(next).map((attempt) => ({ ...attempt, occurredAt: `2026-09-05T0${Math.floor(next() * 10)}:00:00.000Z` }));
      expect(summariseSkillEvidence(oneDay).band).toBe('NOT_ENOUGH_EVIDENCE');
    }
  });

  it('a rebuild over fewer facts never claims more than the full history for the base rules', () => {
    // Up to DEMONSTRATED the stage depends on unaided successes alone: removing wrong or assisted
    // attempts leaves it where it was, and removing an unaided success can only lower it.
    const next = generator(43);
    for (let run = 0; run < RUNS; run += 1) {
      const history = randomHistory(next);
      const full = summariseSkillEvidence(history);
      const unaidedOnly = history.filter((attempt) => attempt.correct && (attempt.highestHintLevel ?? 0) < 3 && attempt.tutorReplied !== true);
      const unaided = summariseSkillEvidence(unaidedOnly).stage;
      expect(Math.min(stageRank(unaided), stageRank('DEMONSTRATED'))).toBe(Math.min(stageRank(full.stage), stageRank('DEMONSTRATED')));
      if (unaidedOnly.length > 0) {
        const removed = Math.floor(next() * unaidedOnly.length);
        const dropped = unaidedOnly.filter((_, index) => index !== removed);
        const reduced = summariseSkillEvidence(dropped);
        expect(Math.min(stageRank(reduced.stage), stageRank('DEMONSTRATED')))
          .toBeLessThanOrEqual(Math.min(stageRank(full.stage), stageRank('DEMONSTRATED')));
      }
    }
  });
});
