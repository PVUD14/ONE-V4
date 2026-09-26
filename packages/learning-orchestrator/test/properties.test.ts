/**
 * Property tests for learning-orchestrator-v1 (ENG-08 acceptance: identical inputs always give
 * identical outputs; C4, C7, X2 and the consent rule hold for every generated learner). Random
 * snapshots come from a seeded generator, so a failure reproduces exactly. All data is synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  PLANNER_ACTION_MINUTES,
  canonicalJson,
  normalisePlannerInput,
  planNextStep,
  plannerInputsHash,
  plannerReasonCodes,
  replayDecision,
  type PlannerInput,
  type PlannerSkillState,
  type PlannerStrategy,
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

const pick = <T>(next: () => number, values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
const id = (prefix: number, index: number): string => `0e08${prefix.toString(16).padStart(4, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const SKILLS = Array.from({ length: 8 }, (_, index) => id(1, index + 1));
const CODES = ['BOUNDARY_OFF_BY_ONE', 'HOSTS_MINUS_TWO', 'PORT_SWAP', 'LOG_TIMEZONE'];
const STAGES = ['ESTIMATED', 'RETAINED', 'DEMONSTRATED', 'TRANSFERRED'] as const;
const BANDS = ['NOT_ENOUGH_EVIDENCE', 'DEVELOPING', 'PROGRESSING', 'DEMONSTRATED'] as const;
const TRIGGERS = ['NEW_SKILL', 'REPEATED_ERROR', 'MISCONCEPTION_DETECTED', 'DUE_REVIEW', 'STUCK', 'NEAR_MASTERY'] as const;
const MODES = ['LEARN', 'PRACTICE', 'REVIEW'] as const;
const KINDS = ['WORKED_EXAMPLE', 'GUIDED_PRACTICE', 'SOCRATIC_QUESTIONING', 'HINT_LADDER', 'ERROR_CORRECTION', 'RETRIEVAL_PRACTICE', 'TEACH_BACK'] as const;

function subset<T>(next: () => number, values: readonly T[]): T[] {
  const chosen = values.filter(() => next() < 0.4);
  return chosen.length > 0 ? chosen : [pick(next, values)];
}

function randomState(next: () => number, skillId: string): PlannerSkillState {
  const attemptCount = Math.floor(next() * 12);
  const attemptDayCount = attemptCount === 0 ? 0 : 1 + Math.floor(next() * attemptCount);
  const unaidedSuccessCount = Math.floor(next() * (attemptCount + 1));
  return {
    skillId,
    evidenceStage: attemptCount === 0 ? 'ESTIMATED' : pick(next, STAGES),
    evidenceBand: attemptDayCount < 2 ? 'NOT_ENOUGH_EVIDENCE' : pick(next, BANDS),
    attemptCount,
    attemptDayCount,
    unaidedSuccessCount,
    latestHintLevel: Math.floor(next() * 5),
    misconceptions: CODES.filter(() => next() < 0.25).map((code) => ({ code, unclearedSignals: 1 + Math.floor(next() * 4) })),
  };
}

function randomStrategy(next: () => number, index: number): PlannerStrategy {
  const applicability: Record<string, unknown> = {};
  if (next() < 0.7) applicability.modes = subset(next, MODES);
  if (next() < 0.5) applicability.evidenceStages = subset(next, STAGES);
  if (next() < 0.7) applicability.triggers = subset(next, TRIGGERS);
  if (next() < 0.2) applicability.misconceptionCodes = subset(next, CODES);
  if (next() < 0.3) applicability.minRecentErrors = Math.floor(next() * 4);
  if (next() < 0.3) applicability.maxHintLevel = Math.floor(next() * 5);
  return {
    code: `STRATEGY_${String.fromCharCode(65 + (index % 26))}${index}`,
    version: 1 + Math.floor(next() * 3),
    kind: pick(next, KINDS),
    applicability,
    requiresModel: next() < 0.25,
  };
}

function randomInput(next: () => number): PlannerInput {
  const skills = SKILLS.filter(() => next() < 0.7);
  const gapSkills = SKILLS.filter(() => next() < 0.6);
  const strategies = Array.from({ length: Math.floor(next() * 8) }, (_, index) => randomStrategy(next, index))
    .filter((strategy, index, all) => all.findIndex((other) => other.code === strategy.code && other.version === strategy.version) === index);
  const withOverride = next() < 0.1;
  return {
    adaptive: next() < 0.75,
    sessionMinutes: next() < 0.4 ? null : 1 + Math.floor(next() * 30),
    careerGap: next() < 0.15 ? null : {
      careerRoleId: id(2, 1),
      snapshotId: id(2, 2),
      modelVersion: 'career-gap-v1',
      items: gapSkills.map((topicId, index) => ({
        topicId,
        requirementLevel: pick(next, ['ESSENTIAL', 'IMPORTANT', 'HELPFUL'] as const),
        status: pick(next, ['MET', 'PARTIAL', 'MISSING', 'UNKNOWN'] as const),
        priorityRank: index + 1,
      })),
    },
    skillStates: skills.map((skillId) => randomState(next, skillId)),
    dueReviews: skills.filter(() => next() < 0.3).map((skillId) => ({
      skillId, reviewDueAt: new Date(Date.UTC(2026, 8, 1 + Math.floor(next() * 20))).toISOString(),
    })),
    strategies,
    constraints: {
      override: withOverride ? {
        overrideId: id(3, 1), byUserId: id(3, 2), reasonCode: 'FACULTY_JUDGEMENT',
        action: 'PRACTICE', skillId: pick(next, SKILLS), focusMisconceptionCode: null,
      } : null,
      assignments: SKILLS.filter(() => next() < 0.1).map((skillId, index) => ({
        assignmentId: id(4, index + 1), skillId, assignedAt: new Date(Date.UTC(2026, 7, 1 + index)).toISOString(),
      })),
    },
  };
}

function shuffle<T>(values: readonly T[], next: () => number): T[] {
  const out = [...values];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

function shuffled(input: PlannerInput, next: () => number): PlannerInput {
  return {
    ...input,
    skillStates: shuffle(input.skillStates, next).map((state) => ({ ...state, misconceptions: shuffle(state.misconceptions, next) })),
    dueReviews: shuffle(input.dueReviews, next),
    strategies: shuffle(input.strategies, next),
    careerGap: input.careerGap ? { ...input.careerGap, items: shuffle(input.careerGap.items, next) } : null,
    constraints: { ...input.constraints, assignments: shuffle(input.constraints.assignments, next) },
  };
}

describe('learning-orchestrator-v1 properties', () => {
  it('identical inputs, in any order, always give identical decisions and hashes', () => {
    const next = generator(8);
    for (let run = 0; run < RUNS; run += 1) {
      const input = randomInput(next);
      const decision = planNextStep(input);
      expect(planNextStep(input)).toEqual(decision);
      const reordered = shuffled(input, next);
      expect(planNextStep(reordered)).toEqual(decision);
      expect(plannerInputsHash(reordered)).toBe(plannerInputsHash(input));
    }
  });

  it('normalisation is idempotent and survives a JSON round trip, so stored inputs replay (C4)', () => {
    const next = generator(4);
    for (let run = 0; run < RUNS; run += 1) {
      const input = randomInput(next);
      const normal = normalisePlannerInput(input);
      expect(canonicalJson(normalisePlannerInput(normal))).toBe(canonicalJson(normal));
      const stored = JSON.parse(JSON.stringify(normal)) as unknown;
      const { policyVersion, ...decision } = planNextStep(input);
      expect(replayDecision({ policyVersion, inputs: stored, inputsHash: plannerInputsHash(input), decision }).status).toBe('MATCHED');
    }
  });

  it('every decision carries at least one known reason, and a skill exactly when it acts (C4)', () => {
    const next = generator(44);
    for (let run = 0; run < RUNS; run += 1) {
      const decision = planNextStep(randomInput(next));
      expect(decision.reasonCodes.length).toBeGreaterThan(0);
      for (const reason of decision.reasonCodes) expect(plannerReasonCodes).toContain(reason);
      expect(new Set(decision.reasonCodes).size).toBe(decision.reasonCodes.length);
      expect(decision.skillId === null).toBe(decision.action === 'NONE');
      expect(decision.focusMisconceptionCode !== null).toBe(decision.action === 'REMEDIATE');
    }
  });

  it('when a review is due and no faculty override applies, the earliest due review comes first (C7)', () => {
    const next = generator(7);
    let checked = 0;
    for (let run = 0; run < RUNS * 2; run += 1) {
      const input = randomInput(next);
      if (!input.adaptive || input.dueReviews.length === 0 || input.constraints.override) continue;
      if (input.sessionMinutes !== null && input.sessionMinutes < PLANNER_ACTION_MINUTES.REVIEW) continue;
      checked += 1;
      const earliest = normalisePlannerInput(input).dueReviews[0]!;
      expect(planNextStep(input)).toMatchObject({ action: 'REVIEW', skillId: earliest.skillId });
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('never chooses a strategy that needs a model, or one that was not supplied (X2; published only)', () => {
    const next = generator(2);
    for (let run = 0; run < RUNS; run += 1) {
      const input = randomInput(next);
      const decision = planNextStep(input);
      if (decision.strategy === null) continue;
      const supplied = input.strategies.find((s) => s.code === decision.strategy!.code && s.version === decision.strategy!.version);
      expect(supplied).toBeDefined();
      expect(supplied!.requiresModel).toBe(false);
      // The highest supplied version of that code.
      const highest = Math.max(...input.strategies.filter((s) => s.code === supplied!.code).map((s) => s.version));
      expect(supplied!.version).toBe(highest);
    }
  });

  it('without consent the decision does not depend on skill states or due reviews, and chooses no strategy (ENG-01)', () => {
    const next = generator(11);
    for (let run = 0; run < RUNS; run += 1) {
      const input = { ...randomInput(next), adaptive: false };
      const decision = planNextStep(input);
      expect(planNextStep({ ...input, skillStates: [], dueReviews: [] })).toEqual(decision);
      expect(planNextStep({ ...input, skillStates: randomInput(next).skillStates, dueReviews: randomInput(next).dueReviews })).toEqual(decision);
      expect(decision.strategy).toBeNull();
      expect(decision.reasonCodes).toContain('NON_ADAPTIVE_NO_CONSENT');
      expect(['REVIEW', 'REMEDIATE']).not.toContain(decision.action);
    }
  });

  it('a faculty override always decides the step and is recorded', () => {
    const next = generator(16);
    for (let run = 0; run < RUNS; run += 1) {
      const base = randomInput(next);
      const override = { overrideId: id(3, 1), byUserId: id(3, 2), reasonCode: 'FACULTY_JUDGEMENT', action: 'LEARN' as const, skillId: SKILLS[0]!, focusMisconceptionCode: null };
      const decision = planNextStep({ ...base, constraints: { ...base.constraints, override } });
      expect(decision).toMatchObject({ action: 'LEARN', skillId: SKILLS[0], override: { byUserId: id(3, 2), reasonCode: 'FACULTY_JUDGEMENT' } });
      expect(decision.reasonCodes[0]).toBe('FACULTY_OVERRIDE');
    }
  });

  it('the output carries no number except a strategy version — no score, no readiness', () => {
    const next = generator(21);
    for (let run = 0; run < RUNS; run += 1) {
      const decision = planNextStep(randomInput(next));
      const numbers: number[] = [];
      JSON.stringify(decision, (key, value: unknown) => {
        if (typeof value === 'number' && key !== 'version') numbers.push(value);
        return value;
      });
      expect(numbers).toEqual([]);
    }
  });
});
