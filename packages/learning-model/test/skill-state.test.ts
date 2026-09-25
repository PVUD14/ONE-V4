/**
 * Unit and property tests for the learner skill state projection (ENG-05, learner-skill-state-v1).
 *
 * Why: the projection must be a pure function of facts, so that rebuilding it reproduces the
 * table exactly and a replayed projector changes nothing. These pin the rules the design
 * (docs/architecture/learner-skill-state-table-design.md) sets: which attempts bear on which
 * skill, that blanks and assisted successes never count (C5), that one attempt is never a band
 * (C3), when a misconception code is active, and that no numeric mastery or review value
 * appears before the goal that computes it. Random histories use a seeded generator.
 */
import { describe, expect, it } from 'vitest';
import {
  LEARNER_SKILL_STATE_ALGORITHM_ID,
  LearningModelError,
  activeMisconceptionsBySkill,
  projectLearnerSkillStates,
  summariseSkillEvidence,
  type ProjectionAttempt,
} from '../src/index.js';

const SKILL_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SKILL_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const INSTITUTION = 'cccccccc-0000-4000-8000-000000000003';
const OTHER_INSTITUTION = 'dddddddd-0000-4000-8000-000000000004';

let counter = 0;
function attempt(overrides: Partial<ProjectionAttempt> = {}): ProjectionAttempt {
  counter += 1;
  return {
    id: `att-${String(counter).padStart(5, '0')}`,
    itemId: 'item-1',
    context: 'ASSESSMENT',
    answered: true,
    correct: true,
    highestHintLevel: 0,
    assisted: false,
    occurredAt: '2026-09-01T05:00:00.000Z',
    institutionId: null,
    skillIds: [SKILL_A],
    misconceptions: [],
    ...overrides,
  };
}

describe('projectLearnerSkillStates', () => {
  it('projects nothing from no facts (the rebuild of an erased student is the empty set)', () => {
    expect(projectLearnerSkillStates([])).toEqual([]);
  });

  it('reports one attempt as NOT_ENOUGH_EVIDENCE, never a band (C3)', () => {
    const [row] = projectLearnerSkillStates([attempt({ correct: false })]);
    expect(row).toMatchObject({ skillId: SKILL_A, attemptCount: 1, attemptDayCount: 1, evidenceStage: 'ESTIMATED',
      evidenceBand: 'NOT_ENOUGH_EVIDENCE', lastAttemptAt: '2026-09-01T05:00:00.000Z' });
  });

  it('counts unaided successes on distinct days and reaches DEMONSTRATED only across two days', () => {
    const rows = projectLearnerSkillStates([
      attempt({ occurredAt: '2026-09-01T05:00:00.000Z' }),
      attempt({ occurredAt: '2026-09-01T09:00:00.000Z', itemId: 'item-2' }),
      attempt({ occurredAt: '2026-09-03T05:00:00.000Z', itemId: 'item-3' }),
    ]);
    expect(rows).toEqual([expect.objectContaining({
      attemptCount: 3, attemptDayCount: 2, unaidedSuccessCount: 3, unaidedSuccessDayCount: 2,
      assistedSuccessCount: 0, evidenceStage: 'DEMONSTRATED', evidenceBand: 'DEMONSTRATED',
    })]);
  });

  it('never lets a success after hint 3 count toward a stage (C5)', () => {
    const rows = projectLearnerSkillStates([
      attempt({ occurredAt: '2026-09-01T05:00:00.000Z', highestHintLevel: 3, assisted: true }),
      attempt({ occurredAt: '2026-09-02T05:00:00.000Z', highestHintLevel: 4, assisted: true }),
    ]);
    expect(rows[0]).toMatchObject({ attemptCount: 2, unaidedSuccessCount: 0, unaidedSuccessDayCount: 0,
      assistedSuccessCount: 2, evidenceStage: 'ESTIMATED', evidenceBand: 'DEVELOPING' });
  });

  it('agrees with learning-model-v1 on stage, counts and band for every skill', () => {
    const history = [
      attempt({ occurredAt: '2026-09-01T05:00:00.000Z', correct: false }),
      attempt({ occurredAt: '2026-09-02T05:00:00.000Z' }),
      attempt({ occurredAt: '2026-09-04T05:00:00.000Z', itemId: 'item-9' }),
    ];
    const summary = summariseSkillEvidence(history);
    expect(projectLearnerSkillStates(history)[0]).toMatchObject({
      evidenceStage: summary.stage, evidenceBand: summary.band, attemptCount: summary.attemptCount,
      unaidedSuccessCount: summary.unaidedSuccessCount, unaidedSuccessDayCount: summary.unaidedSuccessDays.length,
    });
  });

  it('ignores a blank: an unanswered item is not an attempt at the skill', () => {
    const rows = projectLearnerSkillStates([
      attempt({ answered: false, correct: false }),
      attempt({ answered: false, correct: false, occurredAt: '2026-09-05T05:00:00.000Z' }),
    ]);
    expect(rows).toEqual([]);
  });

  it('files an exam item mapped to two topics under both, without dividing it by weight', () => {
    const rows = projectLearnerSkillStates([attempt({ skillIds: [SKILL_B, SKILL_A], institutionId: INSTITUTION })]);
    expect(rows.map((row) => row.skillId)).toEqual([SKILL_A, SKILL_B]);
    for (const row of rows) expect(row).toMatchObject({ attemptCount: 1, unaidedSuccessCount: 1, institutionId: INSTITUTION });
  });

  it('takes the institution from the latest contributing attempt, not from anything outside the facts', () => {
    const [row] = projectLearnerSkillStates([
      attempt({ occurredAt: '2026-09-01T05:00:00.000Z', institutionId: INSTITUTION }),
      attempt({ occurredAt: '2026-09-02T05:00:00.000Z', institutionId: OTHER_INSTITUTION }),
    ]);
    expect(row?.institutionId).toBe(OTHER_INSTITUTION);
  });

  it('stamps its algorithm and leaves mastery and review values empty until ENG-06 and ENG-09 compute them', () => {
    const [row] = projectLearnerSkillStates([attempt()]);
    expect(row).toMatchObject({
      algorithmVersion: LEARNER_SKILL_STATE_ALGORITHM_ID,
      masteryLikelihood: null, masteryUncertainty: null, masteryAlgorithmVersion: null,
      reviewStability: null, reviewDifficulty: null, reviewDueAt: null, reviewAlgorithmVersion: null,
    });
    expect(LEARNER_SKILL_STATE_ALGORITHM_ID).toBe('learner-skill-state-v1');
  });

  it('refuses the same attempt twice rather than double-counting it', () => {
    const once = attempt();
    expect(() => projectLearnerSkillStates([once, once])).toThrow(LearningModelError);
  });
});

describe('active misconception codes', () => {
  const boundary = { code: 'SUBNET_BOUNDARY_OFF_BY_ONE', skillId: SKILL_A };
  const hosts = { code: 'SUBNET_HOSTS_INCLUDES_NETWORK', skillId: SKILL_A };

  it('records a code signalled by a wrong answer on its skill (ENG-07 acceptance)', () => {
    const [row] = projectLearnerSkillStates([attempt({ correct: false, misconceptions: [boundary] })]);
    expect(row?.activeMisconceptionCodes).toEqual(['SUBNET_BOUNDARY_OFF_BY_ONE']);
  });

  it('clears a code once the same item is later answered correctly without help', () => {
    const rows = projectLearnerSkillStates([
      attempt({ itemId: 'q-7', correct: false, misconceptions: [boundary], occurredAt: '2026-09-01T05:00:00.000Z' }),
      attempt({ itemId: 'q-7', correct: true, occurredAt: '2026-09-02T05:00:00.000Z' }),
    ]);
    expect(rows[0]?.activeMisconceptionCodes).toEqual([]);
  });

  it('keeps a code when the student only gets other items on the skill right (scenario X1)', () => {
    const rows = projectLearnerSkillStates([
      attempt({ itemId: 'boundary-1', correct: false, misconceptions: [boundary], occurredAt: '2026-09-01T05:00:00.000Z' }),
      attempt({ itemId: 'hosts-1', correct: true, occurredAt: '2026-09-01T06:00:00.000Z' }),
      attempt({ itemId: 'boundary-2', correct: false, misconceptions: [boundary], occurredAt: '2026-09-02T05:00:00.000Z' }),
      attempt({ itemId: 'hosts-2', correct: true, occurredAt: '2026-09-02T06:00:00.000Z' }),
    ]);
    expect(rows[0]?.activeMisconceptionCodes).toEqual(['SUBNET_BOUNDARY_OFF_BY_ONE']);
  });

  it('does not let an assisted success clear a code (C5)', () => {
    const rows = projectLearnerSkillStates([
      attempt({ itemId: 'q-7', correct: false, misconceptions: [boundary], occurredAt: '2026-09-01T05:00:00.000Z' }),
      attempt({ itemId: 'q-7', correct: true, highestHintLevel: 3, assisted: true, occurredAt: '2026-09-02T05:00:00.000Z' }),
    ]);
    expect(rows[0]?.activeMisconceptionCodes).toEqual(['SUBNET_BOUNDARY_OFF_BY_ONE']);
  });

  it('does not let an earlier success clear a later signal', () => {
    const rows = projectLearnerSkillStates([
      attempt({ itemId: 'q-7', correct: true, occurredAt: '2026-09-01T05:00:00.000Z' }),
      attempt({ itemId: 'q-7', correct: false, misconceptions: [boundary], occurredAt: '2026-09-02T05:00:00.000Z' }),
    ]);
    expect(rows[0]?.activeMisconceptionCodes).toEqual(['SUBNET_BOUNDARY_OFF_BY_ONE']);
  });

  it('keeps a code active while any signal of it is uncleared, sorted and without duplicates', () => {
    const rows = projectLearnerSkillStates([
      attempt({ itemId: 'q-1', correct: false, misconceptions: [hosts, boundary], occurredAt: '2026-09-01T05:00:00.000Z' }),
      attempt({ itemId: 'q-2', correct: false, misconceptions: [boundary], occurredAt: '2026-09-01T06:00:00.000Z' }),
      attempt({ itemId: 'q-1', correct: true, occurredAt: '2026-09-02T05:00:00.000Z' }),
    ]);
    expect(rows[0]?.activeMisconceptionCodes).toEqual(['SUBNET_BOUNDARY_OFF_BY_ONE']);
  });

  it("files a code under the code's own skill, creating a row with no attempts when needed", () => {
    const rows = projectLearnerSkillStates([
      attempt({ skillIds: [SKILL_A], correct: false, misconceptions: [{ code: 'MASK_READ_AS_HOSTS', skillId: SKILL_B }], institutionId: INSTITUTION }),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ skillId: SKILL_A, attemptCount: 1, activeMisconceptionCodes: [] }),
      expect.objectContaining({ skillId: SKILL_B, attemptCount: 0, attemptDayCount: 0, lastAttemptAt: null,
        evidenceStage: 'ESTIMATED', evidenceBand: 'NOT_ENOUGH_EVIDENCE', activeMisconceptionCodes: ['MASK_READ_AS_HOSTS'],
        institutionId: INSTITUTION }),
    ]);
    expect(activeMisconceptionsBySkill([
      attempt({ correct: false, misconceptions: [{ code: 'MASK_READ_AS_HOSTS', skillId: SKILL_B }] }),
    ]).get(SKILL_B)).toEqual(['MASK_READ_AS_HOSTS']);
  });

  it('refuses a correct attempt that claims a misconception', () => {
    expect(() => projectLearnerSkillStates([attempt({ correct: true, misconceptions: [boundary] })])).toThrow(LearningModelError);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const RUNS = 300;
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
const SKILLS = [SKILL_A, SKILL_B, 'eeeeeeee-0000-4000-8000-000000000005'];
const CODES = ['CODE_ONE', 'CODE_TWO', 'CODE_THREE'];

function randomHistory(next: () => number): ProjectionAttempt[] {
  const length = Math.floor(next() * 20);
  return Array.from({ length }, (_, index) => {
    const answered = next() < 0.9;
    const correct = answered && next() < 0.55;
    const hint = Math.floor(next() * 5);
    const skillCount = 1 + Math.floor(next() * 2);
    const skillIds = [...new Set(Array.from({ length: skillCount }, () => SKILLS[Math.floor(next() * SKILLS.length)]!))];
    const misconceptions = !correct && answered && next() < 0.5
      ? [{ code: CODES[Math.floor(next() * CODES.length)]!, skillId: SKILLS[Math.floor(next() * SKILLS.length)]! }]
      : [];
    return {
      id: `p-${String(index).padStart(4, '0')}`,
      itemId: `item-${Math.floor(next() * 5)}`,
      context: next() < 0.8 ? 'ASSESSMENT' : 'PRACTICE',
      answered,
      correct,
      highestHintLevel: hint,
      assisted: hint >= 3 || next() < 0.05,
      occurredAt: new Date(Date.UTC(2026, 8, 1) + Math.floor(next() * 200) * 3_600_000).toISOString(),
      institutionId: next() < 0.5 ? INSTITUTION : null,
      skillIds,
      misconceptions,
    } satisfies ProjectionAttempt;
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

describe('learner-skill-state-v1 properties', () => {
  it('is deterministic and independent of the order facts are read in (rebuild = incremental)', () => {
    const next = generator(5);
    for (let run = 0; run < RUNS; run += 1) {
      const history = randomHistory(next);
      const projected = projectLearnerSkillStates(history);
      expect(projectLearnerSkillStates(shuffle(history, next))).toEqual(projected);
      expect(projectLearnerSkillStates(history)).toEqual(projected);
    }
  });

  it('keeps every count within its bounds and every row sorted by skill', () => {
    const next = generator(7);
    for (let run = 0; run < RUNS; run += 1) {
      const rows = projectLearnerSkillStates(randomHistory(next));
      expect(rows.map((row) => row.skillId)).toEqual([...rows.map((row) => row.skillId)].sort());
      for (const row of rows) {
        expect(row.attemptDayCount).toBeLessThanOrEqual(row.attemptCount);
        expect(row.unaidedSuccessCount + row.assistedSuccessCount).toBeLessThanOrEqual(row.attemptCount);
        expect(row.unaidedSuccessDayCount).toBeLessThanOrEqual(row.unaidedSuccessCount);
        expect(row.lastAttemptAt === null).toBe(row.attemptCount === 0);
        expect(row.activeMisconceptionCodes).toEqual([...new Set(row.activeMisconceptionCodes)].sort());
        if (row.attemptDayCount < 2) expect(row.evidenceBand).toBe('NOT_ENOUGH_EVIDENCE');
        expect(row.masteryLikelihood).toBeNull();
        expect(row.reviewDueAt).toBeNull();
      }
    }
  });

  it('never counts an assisted success toward a stage or a code clearance', () => {
    const next = generator(13);
    for (let run = 0; run < RUNS; run += 1) {
      const history = randomHistory(next);
      const withoutAssistedSuccesses = history.filter((item) => !(item.correct && item.assisted));
      const full = projectLearnerSkillStates(history);
      const reduced = projectLearnerSkillStates(withoutAssistedSuccesses);
      for (const row of reduced) {
        const same = full.find((candidate) => candidate.skillId === row.skillId)!;
        expect(same.unaidedSuccessCount).toBe(row.unaidedSuccessCount);
        expect(same.activeMisconceptionCodes).toEqual(row.activeMisconceptionCodes);
      }
    }
  });
});
