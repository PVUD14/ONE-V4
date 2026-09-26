/**
 * Unit tests for learning-orchestrator-v1's input contract, hash and replay statuses (ENG-08).
 * Why: replay (C4) is only as good as the refusal to trust inputs that were altered or decided
 * under another policy, and malformed input must fail loudly rather than plan on garbage.
 */
import { describe, expect, it } from 'vitest';
import {
  PlannerInputError,
  canonicalJson,
  normalisePlannerInput,
  planNextStep,
  plannerInputsHash,
  replayDecision,
  type PlannerInput,
} from '../src/index.js';

const SKILL = '0e080000-0000-4000-8000-0000000000a1';
const base: PlannerInput = {
  adaptive: true,
  sessionMinutes: 20,
  careerGap: {
    careerRoleId: '0e080000-0000-4000-8000-000000000001',
    snapshotId: '0e080000-0000-4000-8000-000000000002',
    modelVersion: 'career-gap-v1',
    items: [{ topicId: SKILL, requirementLevel: 'ESSENTIAL', status: 'UNKNOWN', priorityRank: 1 }],
  },
  skillStates: [],
  dueReviews: [],
  strategies: [],
  constraints: { override: null, assignments: [] },
};

describe('input contract', () => {
  it.each([
    ['a session longer than ten hours', { sessionMinutes: 601 }],
    ['a fractional session', { sessionMinutes: 2.5 }],
    ['an unknown gap status', { careerGap: { ...base.careerGap!, items: [{ ...base.careerGap!.items[0]!, status: 'GREAT' }] } }],
    ['a duplicate skill state', { skillStates: [0, 1].map(() => ({ skillId: SKILL, evidenceStage: 'ESTIMATED', evidenceBand: 'NOT_ENOUGH_EVIDENCE', attemptCount: 0, attemptDayCount: 0, unaidedSuccessCount: 0, latestHintLevel: 0, misconceptions: [] })) }],
    ['more attempt days than attempts', { skillStates: [{ skillId: SKILL, evidenceStage: 'ESTIMATED', evidenceBand: 'NOT_ENOUGH_EVIDENCE', attemptCount: 1, attemptDayCount: 2, unaidedSuccessCount: 0, latestHintLevel: 0, misconceptions: [] }] }],
    ['a strategy with an unknown rule', { strategies: [{ code: 'WORKED_EXAMPLE', version: 1, kind: 'WORKED_EXAMPLE', requiresModel: false, applicability: { mood: ['calm'] } }] }],
    ['a due review with no date', { dueReviews: [{ skillId: SKILL, reviewDueAt: 'soon' }] }],
    ['an override that remediates with no focus', { constraints: { assignments: [], override: { overrideId: SKILL, byUserId: SKILL, reasonCode: 'FACULTY_JUDGEMENT', action: 'REMEDIATE', skillId: SKILL, focusMisconceptionCode: null } } }],
    ['a skill id that is not a UUID', { dueReviews: [{ skillId: 'subnetting', reviewDueAt: '2026-09-01T00:00:00Z' }] }],
  ])('refuses %s', (_label, change) => {
    expect(() => planNextStep({ ...base, ...(change as object) })).toThrow(PlannerInputError);
  });

  it('normalises identifiers and timestamps so equal facts hash equally', () => {
    const upper = { ...base, dueReviews: [{ skillId: SKILL.toUpperCase(), reviewDueAt: '2026-09-01T05:30:00+05:30' }] };
    const lower = { ...base, dueReviews: [{ skillId: SKILL, reviewDueAt: '2026-09-01T00:00:00.000Z' }] };
    expect(normalisePlannerInput(upper)).toEqual(normalisePlannerInput(lower));
    expect(plannerInputsHash(upper)).toBe(plannerInputsHash(lower));
    expect(plannerInputsHash(lower)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonical JSON sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
});

describe('replay statuses', () => {
  const { policyVersion, ...decision } = planNextStep(base);
  const stored = { policyVersion, inputs: normalisePlannerInput(base), inputsHash: plannerInputsHash(base), decision };

  it('matches an untouched decision', () => {
    expect(replayDecision(stored).status).toBe('MATCHED');
  });

  it('reports inputs that no longer hash to the stored hash', () => {
    expect(replayDecision({ ...stored, inputs: { ...stored.inputs, sessionMinutes: 30 } }).status).toBe('HASH_MISMATCH');
  });

  it('reports a stored decision that the inputs do not produce', () => {
    expect(replayDecision({ ...stored, decision: { ...decision, action: 'PRACTICE' } }).status).toBe('MISMATCHED');
  });

  it('never replays a decision under a policy other than the one that made it', () => {
    expect(replayDecision({ ...stored, policyVersion: 'learning-orchestrator-v0' }).status).toBe('UNSUPPORTED_POLICY');
  });

  it('reports stored inputs that are no longer valid', () => {
    expect(replayDecision({ ...stored, inputs: { nonsense: true } }).status).toBe('INVALID_INPUTS');
  });
});
