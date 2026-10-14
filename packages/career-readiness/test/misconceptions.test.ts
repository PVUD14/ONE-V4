/**
 * Tests for the ENG-07 pure rules: which misconceptions a response signals, whether a
 * teaching strategy's rules admit a situation, and what a valid draft looks like.
 *
 * The property tests use a small seeded generator instead of a library so they are
 * deterministic run to run; they pin the invariants the planner (ENG-08) will lean on.
 */
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_STAGES,
  LEARNING_MODES,
  STRATEGY_TRIGGERS,
  misconceptionsForResponse,
  strategyApplies,
  validateEngineContentProvenance,
  validateMisconceptionCodeDraft,
  validateOptionTag,
  validateStrategyApplicability,
  validateTeachingStrategyDraft,
  type PublishedOptionTag,
  type StrategyApplicability,
  type StrategySituation,
} from '../src/index.js';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}
function subset<T>(random: () => number, values: readonly T[]): T[] {
  return values.filter(() => random() < 0.5);
}

const agentProvenance = {
  source: 'AGENT_DRAFTED' as const,
  generatorVersion: 'claude-opus-5-5',
  promptVersion: 'eng-07-test',
  generatedAt: new Date('2026-09-26T00:00:00Z'),
  basis: 'Synthetic test basis.',
  expertCheckNotes: 'Synthetic: check everything.',
};

describe('misconceptionsForResponse (misconception-tagging-v1)', () => {
  const tags: PublishedOptionTag[] = [
    { optionId: 'a', misconceptionCodeId: 'id-2', code: 'ZETA_CONFUSION' },
    { optionId: 'a', misconceptionCodeId: 'id-1', code: 'ALPHA_CONFUSION' },
    { optionId: 'c', misconceptionCodeId: 'id-3', code: 'GAMMA_CONFUSION' },
    { optionId: 'a', misconceptionCodeId: 'id-1', code: 'ALPHA_CONFUSION' },
  ];

  it('returns the tagged codes of the wrong option chosen, de-duplicated and ordered', () => {
    expect(misconceptionsForResponse({ selectedOptionId: 'a', correctOptionId: 'b', tags })).toEqual([
      { misconceptionCodeId: 'id-1', code: 'ALPHA_CONFUSION' },
      { misconceptionCodeId: 'id-2', code: 'ZETA_CONFUSION' },
    ]);
  });

  it('returns nothing for a correct answer, even if a tag claims the correct option', () => {
    expect(misconceptionsForResponse({ selectedOptionId: 'c', correctOptionId: 'c', tags })).toEqual([]);
  });

  it('returns nothing for a blank answer or an untagged wrong option', () => {
    expect(misconceptionsForResponse({ selectedOptionId: null, correctOptionId: 'b', tags })).toEqual([]);
    expect(misconceptionsForResponse({ selectedOptionId: 'd', correctOptionId: 'b', tags })).toEqual([]);
  });

  it('property: output is order-independent, only from the chosen option, and empty when correct', () => {
    const random = seeded(7);
    const options = ['a', 'b', 'c', 'd'];
    for (let run = 0; run < 500; run += 1) {
      const generated: PublishedOptionTag[] = Array.from({ length: Math.floor(random() * 8) }, () => {
        const n = Math.floor(random() * 5);
        return { optionId: pick(random, options), misconceptionCodeId: `id-${n}`, code: `CODE_${n}` };
      });
      const correct = pick(random, options);
      const selected = random() < 0.1 ? null : pick(random, options);
      const forward = misconceptionsForResponse({ selectedOptionId: selected, correctOptionId: correct, tags: generated });
      const reversed = misconceptionsForResponse({ selectedOptionId: selected, correctOptionId: correct, tags: [...generated].reverse() });
      expect(reversed).toEqual(forward);
      if (selected === null || selected === correct) expect(forward).toEqual([]);
      for (const result of forward) {
        expect(generated.some((tag) => tag.optionId === selected && tag.misconceptionCodeId === result.misconceptionCodeId)).toBe(true);
      }
      expect(new Set(forward.map((item) => item.misconceptionCodeId)).size).toBe(forward.length);
    }
  });
});

describe('strategyApplies (teaching-strategy-applicability-v1)', () => {
  const situation: StrategySituation = {
    mode: 'PRACTICE', evidenceStage: 'ESTIMATED', triggers: ['REPEATED_ERROR'],
    activeMisconceptionCodes: ['SUBNET_BOUNDARY_OFF_BY_ONE'], recentErrors: 3, highestHintLevel: 1,
  };

  it('an empty rule set admits every situation', () => {
    expect(strategyApplies({}, situation)).toBe(true);
  });

  it('each present rule must hold', () => {
    expect(strategyApplies({ modes: ['LEARN'] }, situation)).toBe(false);
    expect(strategyApplies({ evidenceStages: ['DEMONSTRATED'] }, situation)).toBe(false);
    expect(strategyApplies({ triggers: ['DUE_REVIEW'] }, situation)).toBe(false);
    expect(strategyApplies({ misconceptionCodes: ['OTHER_CODE'] }, situation)).toBe(false);
    expect(strategyApplies({ minRecentErrors: 4 }, situation)).toBe(false);
    expect(strategyApplies({ maxHintLevel: 0 }, situation)).toBe(false);
    expect(strategyApplies({
      modes: ['PRACTICE'], evidenceStages: ['ESTIMATED'], triggers: ['REPEATED_ERROR', 'STUCK'],
      misconceptionCodes: ['SUBNET_BOUNDARY_OFF_BY_ONE'], minRecentErrors: 3, maxHintLevel: 1,
    }, situation)).toBe(true);
  });

  it('property: adding a rule never admits a situation the looser rules refused', () => {
    const random = seeded(11);
    const codes = ['CODE_A', 'CODE_B', 'CODE_C'];
    for (let run = 0; run < 500; run += 1) {
      const loose: StrategyApplicability = random() < 0.5 ? {} : { modes: [pick(random, LEARNING_MODES)] };
      const tighter: StrategyApplicability = { ...loose, triggers: [pick(random, STRATEGY_TRIGGERS)], maxHintLevel: Math.floor(random() * 5) };
      const probe: StrategySituation = {
        mode: pick(random, LEARNING_MODES), evidenceStage: pick(random, EVIDENCE_STAGES),
        triggers: subset(random, STRATEGY_TRIGGERS), activeMisconceptionCodes: subset(random, codes),
        recentErrors: Math.floor(random() * 6), highestHintLevel: Math.floor(random() * 5),
      };
      if (strategyApplies(tighter, probe)) expect(strategyApplies(loose, probe)).toBe(true);
      expect(strategyApplies(tighter, probe)).toBe(strategyApplies(tighter, { ...probe }));
    }
  });
});

describe('validateStrategyApplicability', () => {
  it('accepts the closed shape', () => {
    expect(validateStrategyApplicability({ modes: ['LEARN'], triggers: ['NEW_SKILL'], maxHintLevel: 2 }))
      .toEqual({ modes: ['LEARN'], triggers: ['NEW_SKILL'], maxHintLevel: 2 });
  });

  it.each([
    [[], 'applicability must be an object'],
    [{ weights: 3 }, 'unknown rule'],
    [{ modes: [] }, 'non-empty'],
    [{ modes: ['SLEEP'] }, 'unknown value'],
    [{ triggers: ['STUCK', 'STUCK'] }, 'duplicate'],
    [{ misconceptionCodes: ['lower_case'] }, 'invalid'],
    [{ maxHintLevel: 5 }, 'integer from 0 to 4'],
    [{ minRecentErrors: 1.5 }, 'integer'],
  ])('refuses %j', (value, message) => {
    expect(() => validateStrategyApplicability(value)).toThrow(message);
  });
});

describe('drafts and provenance', () => {
  it('agent-drafted content must carry generator provenance and expert-check notes', () => {
    expect(() => validateEngineContentProvenance(agentProvenance)).not.toThrow();
    const { expertCheckNotes: _notes, ...withoutNotes } = agentProvenance;
    expect(() => validateEngineContentProvenance(withoutNotes)).toThrow('expert checking');
    const { promptVersion: _prompt, ...withoutPrompt } = agentProvenance;
    expect(() => validateEngineContentProvenance(withoutPrompt)).toThrow('promptVersion');
  });

  it('authored content carries no generator provenance', () => {
    expect(() => validateEngineContentProvenance({ source: 'AUTHORED', basis: 'Textbook chapter 3.' })).not.toThrow();
    expect(() => validateEngineContentProvenance({ source: 'AUTHORED', basis: 'x', generatorVersion: 'm' })).toThrow('no generator provenance');
  });

  it('a GENERATED source is refused while the AI hold stands', () => {
    expect(() => validateEngineContentProvenance({ ...agentProvenance, source: 'GENERATED' as never })).toThrow('source is invalid');
  });

  it('validates misconception and strategy drafts', () => {
    expect(() => validateMisconceptionCodeDraft({ ...agentProvenance, code: 'OFF_BY_ONE', skillId: 's', title: 'T', description: 'D' })).not.toThrow();
    expect(() => validateMisconceptionCodeDraft({ ...agentProvenance, code: 'x', skillId: 's', title: 'T', description: 'D' })).toThrow('code');
    expect(() => validateTeachingStrategyDraft({
      ...agentProvenance, code: 'WORKED_EXAMPLE', strategyKind: 'WORKED_EXAMPLE', title: 'T', description: 'D',
      applicability: { modes: ['LEARN'] }, requiresModel: false,
    })).not.toThrow();
    expect(() => validateTeachingStrategyDraft({
      ...agentProvenance, code: 'WORKED_EXAMPLE', strategyKind: 'LECTURE' as never, title: 'T', description: 'D',
      applicability: {}, requiresModel: false,
    })).toThrow('kind');
  });

  it('a tag must sit on an existing wrong option', () => {
    const question = { options: [{ id: 'a' }, { id: 'b' }], correctOptionId: 'b' };
    expect(() => validateOptionTag(question, 'a', 'Chose the network address as a host.')).not.toThrow();
    expect(() => validateOptionTag(question, 'b', 'r')).toThrow('correct option');
    expect(() => validateOptionTag(question, 'z', 'r')).toThrow('does not exist');
  });
});
