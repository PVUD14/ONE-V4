/**
 * Golden decision tests for learning-orchestrator-v1 (ENG-08): fixed learner snapshots and the
 * exact action, strategy and reasons the planner must give for each, including scenario X1 and
 * C7 (due reviews first). Why: the policy is the product's explanation of "what next"; any change
 * to a golden answer must be a deliberate new policy version, not a silent drift. Every learner,
 * topic and strategy here is synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  PLANNER_POLICY_VERSION,
  planNextStep,
  replayDecision,
  plannerInputsHash,
  normalisePlannerInput,
  type PlannerDecision,
  type PlannerInput,
  type PlannerSkillState,
  type PlannerStrategy,
} from '../src/index.js';

const ROLE = '0e080000-0000-4000-8000-000000000001';
const SNAPSHOT = '0e080000-0000-4000-8000-000000000002';
const SUBNETTING = '0e080000-0000-4000-8000-0000000000a1';
const PORTS = '0e080000-0000-4000-8000-0000000000a2';
const LOGS = '0e080000-0000-4000-8000-0000000000a3';
const DNS = '0e080000-0000-4000-8000-0000000000a4';
const FACULTY = '0e080000-0000-4000-8000-0000000000f1';
const BOUNDARY = 'SUBNET_BOUNDARY_BLOCK_SIZE';

/** Shaped like the ENG-07 draft pack, as if a reviewer had published it, plus one X1-specific strategy. */
const strategies: readonly PlannerStrategy[] = [
  { code: 'WORKED_EXAMPLE', version: 1, kind: 'WORKED_EXAMPLE', requiresModel: false,
    applicability: { modes: ['LEARN', 'PRACTICE'], evidenceStages: ['ESTIMATED'], triggers: ['NEW_SKILL', 'STUCK'] } },
  { code: 'GUIDED_PRACTICE', version: 1, kind: 'GUIDED_PRACTICE', requiresModel: false,
    applicability: { modes: ['LEARN', 'PRACTICE'], evidenceStages: ['ESTIMATED', 'RETAINED'], triggers: ['NEW_SKILL', 'REPEATED_ERROR'], maxHintLevel: 2 } },
  { code: 'SOCRATIC_QUESTIONING', version: 1, kind: 'SOCRATIC_QUESTIONING', requiresModel: true,
    applicability: { modes: ['LEARN', 'PRACTICE'], triggers: ['MISCONCEPTION_DETECTED', 'REPEATED_ERROR'] } },
  { code: 'HINT_LADDER', version: 1, kind: 'HINT_LADDER', requiresModel: false,
    applicability: { modes: ['PRACTICE', 'LEARN'], triggers: ['STUCK', 'REPEATED_ERROR'] } },
  { code: 'ERROR_CORRECTION', version: 1, kind: 'ERROR_CORRECTION', requiresModel: false,
    applicability: { modes: ['PRACTICE', 'LEARN', 'REVIEW'], triggers: ['MISCONCEPTION_DETECTED'], minRecentErrors: 2 } },
  { code: 'RETRIEVAL_PRACTICE', version: 1, kind: 'RETRIEVAL_PRACTICE', requiresModel: false,
    applicability: { modes: ['REVIEW', 'PRACTICE'], evidenceStages: ['RETAINED', 'DEMONSTRATED', 'TRANSFERRED'], triggers: ['DUE_REVIEW', 'NEAR_MASTERY'] } },
  { code: 'TEACH_BACK', version: 1, kind: 'TEACH_BACK', requiresModel: true,
    applicability: { modes: ['LEARN', 'REVIEW'], evidenceStages: ['RETAINED', 'DEMONSTRATED'], triggers: ['NEAR_MASTERY'] } },
];
const blockSizePractice: PlannerStrategy = {
  code: 'SUBNET_BLOCK_SIZE_DRILL', version: 1, kind: 'GUIDED_PRACTICE', requiresModel: false,
  applicability: { modes: ['PRACTICE'], triggers: ['MISCONCEPTION_DETECTED'], misconceptionCodes: [BOUNDARY], minRecentErrors: 3 },
};

const gap: PlannerInput['careerGap'] = {
  careerRoleId: ROLE,
  snapshotId: SNAPSHOT,
  modelVersion: 'career-gap-v1',
  items: [
    { topicId: SUBNETTING, requirementLevel: 'ESSENTIAL', status: 'PARTIAL', priorityRank: 1 },
    { topicId: PORTS, requirementLevel: 'ESSENTIAL', status: 'UNKNOWN', priorityRank: 2 },
    { topicId: LOGS, requirementLevel: 'IMPORTANT', status: 'MISSING', priorityRank: 3 },
    { topicId: DNS, requirementLevel: 'HELPFUL', status: 'MET', priorityRank: 4 },
  ],
};

/** Host counts right on two days, boundaries wrong `boundaryWrong` times (uncleared). */
function subnetting(boundaryWrong: number): PlannerSkillState {
  return {
    skillId: SUBNETTING, evidenceStage: 'RETAINED', evidenceBand: 'DEVELOPING',
    attemptCount: 4 + boundaryWrong, attemptDayCount: 2, unaidedSuccessCount: 4, latestHintLevel: 0,
    misconceptions: boundaryWrong > 0 ? [{ code: BOUNDARY, unclearedSignals: boundaryWrong }] : [],
  };
}

const demonstratedDns: PlannerSkillState = {
  skillId: DNS, evidenceStage: 'DEMONSTRATED', evidenceBand: 'PROGRESSING',
  attemptCount: 6, attemptDayCount: 3, unaidedSuccessCount: 5, latestHintLevel: 0, misconceptions: [],
};

function input(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    adaptive: true,
    sessionMinutes: null,
    careerGap: gap,
    skillStates: [subnetting(0)],
    dueReviews: [],
    strategies,
    constraints: { override: null, assignments: [] },
    ...overrides,
  };
}

function expectDecision(actual: PlannerDecision, expected: Omit<PlannerDecision, 'policyVersion' | 'override' | 'focusMisconceptionCode'> & Partial<PlannerDecision>): void {
  expect(actual).toEqual({ policyVersion: PLANNER_POLICY_VERSION, override: null, focusMisconceptionCode: null, ...expected });
}

describe('scenario X1: subnet boundaries wrong three times', () => {
  it('after one wrong boundary answer the student keeps practising the full problem', () => {
    expectDecision(planNextStep(input({ skillStates: [subnetting(1)] })), {
      action: 'PRACTICE', skillId: SUBNETTING,
      strategy: { code: 'RETRIEVAL_PRACTICE', version: 1, kind: 'RETRIEVAL_PRACTICE' },
      reasonCodes: ['GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'NEAR_MASTERY', 'ACTIVE_MISCONCEPTION'],
    });
  });

  it('after the third wrong boundary answer the planner switches to block-size practice', () => {
    expectDecision(planNextStep(input({ skillStates: [subnetting(3)], strategies: [...strategies, blockSizePractice] })), {
      action: 'REMEDIATE', skillId: SUBNETTING, focusMisconceptionCode: BOUNDARY,
      strategy: { code: 'SUBNET_BLOCK_SIZE_DRILL', version: 1, kind: 'GUIDED_PRACTICE' },
      reasonCodes: ['REPEATED_MISCONCEPTION', 'GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'NEAR_MASTERY', 'ACTIVE_MISCONCEPTION'],
    });
  });

  it('without a code-specific strategy it remediates with error correction, never the model-only Socratic tutor', () => {
    expectDecision(planNextStep(input({ skillStates: [subnetting(3)] })), {
      action: 'REMEDIATE', skillId: SUBNETTING, focusMisconceptionCode: BOUNDARY,
      strategy: { code: 'ERROR_CORRECTION', version: 1, kind: 'ERROR_CORRECTION' },
      reasonCodes: ['REPEATED_MISCONCEPTION', 'GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'NEAR_MASTERY', 'ACTIVE_MISCONCEPTION'],
    });
  });

  it('once the boundary signals are cleared by unaided correct answers it returns to the full problem', () => {
    const catalogue = [...strategies, blockSizePractice];
    expectDecision(planNextStep(input({ skillStates: [subnetting(0)], strategies: catalogue })), {
      action: 'PRACTICE', skillId: SUBNETTING,
      strategy: { code: 'RETRIEVAL_PRACTICE', version: 1, kind: 'RETRIEVAL_PRACTICE' },
      reasonCodes: ['GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'NEAR_MASTERY'],
    });
    // Partly cleared (one signal left) is below "repeated": back to the full problem as well.
    expect(planNextStep(input({ skillStates: [subnetting(1)], strategies: catalogue })).action).toBe('PRACTICE');
  });
});

describe('C7: due reviews come first', () => {
  const dueInput = input({
    skillStates: [subnetting(3), demonstratedDns],
    dueReviews: [
      { skillId: SUBNETTING, reviewDueAt: '2026-09-20T00:00:00+05:30' },
      { skillId: DNS, reviewDueAt: '2026-09-10T00:00:00+05:30' },
    ],
  });

  it('the skill left longest past its due day is the next step, ahead of remediation and the gap', () => {
    expectDecision(planNextStep(dueInput), {
      action: 'REVIEW', skillId: DNS,
      strategy: { code: 'RETRIEVAL_PRACTICE', version: 1, kind: 'RETRIEVAL_PRACTICE' },
      reasonCodes: ['DUE_REVIEW'],
    });
  });

  it('a short session still starts with the due review', () => {
    expect(planNextStep({ ...dueInput, sessionMinutes: 5 })).toMatchObject({ action: 'REVIEW', skillId: DNS });
  });

  it('a review is due even when every requirement of the target is met', () => {
    const allMet = { ...gap!, items: gap!.items.map((item) => ({ ...item, status: 'MET' as const })) };
    expect(planNextStep({ ...dueInput, careerGap: allMet })).toMatchObject({ action: 'REVIEW', skillId: DNS });
  });
});

describe('the career gap', () => {
  it('a new learner is started on the first essential requirement with a new-skill strategy', () => {
    expectDecision(planNextStep(input({ skillStates: [], careerGap: { ...gap!, items: gap!.items.slice(1) } })), {
      action: 'LEARN', skillId: PORTS,
      strategy: { code: 'GUIDED_PRACTICE', version: 1, kind: 'GUIDED_PRACTICE' },
      reasonCodes: ['GAP_UNKNOWN', 'REQUIREMENT_ESSENTIAL', 'NEW_SKILL', 'NOT_ENOUGH_EVIDENCE'],
    });
  });

  it('a student stuck on a skill gets a worked example', () => {
    const stuck: PlannerSkillState = {
      skillId: PORTS, evidenceStage: 'ESTIMATED', evidenceBand: 'DEVELOPING',
      attemptCount: 4, attemptDayCount: 2, unaidedSuccessCount: 0, latestHintLevel: 3, misconceptions: [],
    };
    expectDecision(planNextStep(input({ skillStates: [stuck], careerGap: { ...gap!, items: gap!.items.slice(1) } })), {
      action: 'PRACTICE', skillId: PORTS,
      strategy: { code: 'WORKED_EXAMPLE', version: 1, kind: 'WORKED_EXAMPLE' },
      reasonCodes: ['GAP_UNKNOWN', 'REQUIREMENT_ESSENTIAL', 'STUCK'],
    });
  });

  it('with no primary target there is nothing to plan, and it says why', () => {
    expectDecision(planNextStep(input({ careerGap: null })), {
      action: 'NONE', skillId: null, strategy: null, reasonCodes: ['NO_CAREER_TARGET'],
    });
  });

  it('with every requirement met and nothing due there is nothing to plan', () => {
    const allMet = { ...gap!, items: gap!.items.map((item) => ({ ...item, status: 'MET' as const })) };
    expectDecision(planNextStep(input({ careerGap: allMet })), {
      action: 'NONE', skillId: null, strategy: null, reasonCodes: ['ALL_REQUIREMENTS_MET'],
    });
  });
});

describe('strategies', () => {
  it('with nothing published the step stands and says no strategy applies', () => {
    expectDecision(planNextStep(input({ strategies: [] })), {
      action: 'PRACTICE', skillId: SUBNETTING, strategy: null,
      reasonCodes: ['GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'NEAR_MASTERY', 'NO_APPLICABLE_STRATEGY'],
    });
  });

  it('never chooses a strategy that needs a model, even when it is the only one that applies (X2)', () => {
    const modelOnly = strategies.filter((strategy) => strategy.requiresModel);
    const decision = planNextStep(input({ skillStates: [subnetting(3)], strategies: modelOnly }));
    expect(decision.strategy).toBeNull();
    expect(decision.reasonCodes).toContain('NO_APPLICABLE_STRATEGY');
  });

  it('uses the highest published version of a strategy', () => {
    const v2: PlannerStrategy = { ...strategies.find((s) => s.code === 'RETRIEVAL_PRACTICE')!, version: 2 };
    expect(planNextStep(input({ strategies: [...strategies, v2] })).strategy).toEqual({ code: 'RETRIEVAL_PRACTICE', version: 2, kind: 'RETRIEVAL_PRACTICE' });
  });
});

describe('session time', () => {
  const fresh = input({ skillStates: [], careerGap: { ...gap!, items: [gap!.items[1]!, { ...gap!.items[0]!, priorityRank: 5 }] } });

  it('a candidate that fits is preferred and the reason says so', () => {
    // PORTS (LEARN, 15) does not fit 12 minutes; SUBNETTING with no attempts is also LEARN; nothing fits.
    expect(planNextStep({ ...fresh, sessionMinutes: 12 })).toMatchObject({ action: 'LEARN', skillId: PORTS });
    expect(planNextStep({ ...fresh, sessionMinutes: 12 }).reasonCodes).toContain('SESSION_TIME_SHORT');
    const practised = { ...fresh, skillStates: [subnetting(0)], sessionMinutes: 12 };
    const decision = planNextStep(practised);
    expect(decision).toMatchObject({ action: 'PRACTICE', skillId: SUBNETTING });
    expect(decision.reasonCodes.slice(0, 3)).toEqual(['GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'SHORTER_ACTION_FOR_SESSION']);
  });

  it('with no stated time nothing is filtered', () => {
    expect(planNextStep({ ...fresh, skillStates: [subnetting(0)] })).toMatchObject({ action: 'LEARN', skillId: PORTS });
  });
});

describe('faculty constraints (INST-16)', () => {
  const assignment = { assignmentId: '0e080000-0000-4000-8000-0000000000b1', skillId: LOGS, assignedAt: '2026-09-01T10:00:00Z' };

  it('an assignment comes after due reviews and before the gap', () => {
    const withAssignment = input({ constraints: { override: null, assignments: [assignment] } });
    expect(planNextStep(withAssignment)).toMatchObject({ action: 'FOLLOW_ASSIGNMENT', skillId: LOGS, reasonCodes: expect.arrayContaining(['FACULTY_ASSIGNMENT']) });
    const withReview = { ...withAssignment, skillStates: [demonstratedDns], dueReviews: [{ skillId: DNS, reviewDueAt: '2026-09-10T00:00:00Z' }] };
    expect(planNextStep(withReview)).toMatchObject({ action: 'REVIEW', skillId: DNS });
  });

  it('an override decides the step, records who and why, and wins over a due review', () => {
    const override = {
      overrideId: '0e080000-0000-4000-8000-0000000000c1', byUserId: FACULTY, reasonCode: 'EXAM_NEXT_WEEK',
      action: 'LEARN' as const, skillId: PORTS, focusMisconceptionCode: null,
    };
    const decision = planNextStep(input({
      skillStates: [demonstratedDns], dueReviews: [{ skillId: DNS, reviewDueAt: '2026-09-10T00:00:00Z' }],
      constraints: { override, assignments: [assignment] },
    }));
    expectDecision(decision, {
      action: 'LEARN', skillId: PORTS,
      strategy: { code: 'GUIDED_PRACTICE', version: 1, kind: 'GUIDED_PRACTICE' },
      reasonCodes: ['FACULTY_OVERRIDE', 'NEW_SKILL', 'NOT_ENOUGH_EVIDENCE'],
      override: { byUserId: FACULTY, reasonCode: 'EXAM_NEXT_WEEK' },
    });
  });
});

describe('consent (ENG-01): the non-adaptive path', () => {
  it('ignores the profile and due reviews, walks the career gap and chooses no strategy', () => {
    const decision = planNextStep(input({
      adaptive: false,
      skillStates: [subnetting(3), demonstratedDns],
      dueReviews: [{ skillId: DNS, reviewDueAt: '2026-09-10T00:00:00Z' }],
    }));
    expectDecision(decision, {
      action: 'PRACTICE', skillId: SUBNETTING, strategy: null,
      reasonCodes: ['GAP_PARTIAL', 'REQUIREMENT_ESSENTIAL', 'NON_ADAPTIVE_NO_CONSENT'],
    });
  });

  it('an unknown requirement is to be learned; nothing to plan still says consent is absent', () => {
    expect(planNextStep(input({ adaptive: false, careerGap: { ...gap!, items: gap!.items.slice(1) } })))
      .toMatchObject({ action: 'LEARN', skillId: PORTS, reasonCodes: ['GAP_UNKNOWN', 'REQUIREMENT_ESSENTIAL', 'NON_ADAPTIVE_NO_CONSENT'] });
    expect(planNextStep(input({ adaptive: false, careerGap: null })).reasonCodes).toEqual(['NO_CAREER_TARGET', 'NON_ADAPTIVE_NO_CONSENT']);
  });
});

describe('C4: every golden decision replays from its stored inputs', () => {
  it('replays to the same decision', () => {
    for (const snapshot of [
      input({ skillStates: [subnetting(3)], strategies: [...strategies, blockSizePractice] }),
      input({ adaptive: false }),
      input({ careerGap: null }),
    ]) {
      const stored = normalisePlannerInput(snapshot);
      const { policyVersion, ...decision } = planNextStep(snapshot);
      const replayed = replayDecision({
        policyVersion, inputs: JSON.parse(JSON.stringify(stored)), inputsHash: plannerInputsHash(snapshot), decision,
      });
      expect(replayed.status).toBe('MATCHED');
    }
  });
});
