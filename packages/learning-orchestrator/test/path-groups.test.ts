/**
 * Unit tests for `learning-path-groups-v1` (ENG-18): the skip / review / learn groups a student sees (C1),
 * due reviews first (C7), bands that never upgrade a single attempt (C3), agreement with planner v1's first
 * choice, and determinism. Every identifier is synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  PATH_GROUPS_POLICY_VERSION,
  groupLearningPath,
  planNextStep,
  type PathInput,
  type PlannerGapItem,
} from '../src/index.js';

const id = (n: number): string => `0e180000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const gap = (n: number, status: PlannerGapItem['status'], rank: number, level: PlannerGapItem['requirementLevel'] = 'ESSENTIAL'): PlannerGapItem =>
  ({ topicId: id(n), requirementLevel: level, status, priorityRank: rank });

const nonAdaptive = (items: readonly PlannerGapItem[], bands: Record<string, 'NOT_ENOUGH_EVIDENCE' | 'DEVELOPING' | 'PROGRESSING' | 'DEMONSTRATED'> = {}): PathInput => ({
  adaptive: false, gapItems: items, skillStates: [], dueSkillIds: [], evidenceBands: new Map(Object.entries(bands)),
});

describe('learning-path-groups-v1', () => {
  it('a new student with a target sees all three groups from the gap alone (C1)', () => {
    const path = groupLearningPath(nonAdaptive([gap(3, 'UNKNOWN', 3), gap(1, 'MET', 1), gap(2, 'PARTIAL', 2), gap(4, 'MISSING', 4)]));
    expect(path.policyVersion).toBe(PATH_GROUPS_POLICY_VERSION);
    expect(path.skip.map((entry) => entry.skillId)).toEqual([id(1)]);
    expect(path.review.map((entry) => entry.skillId)).toEqual([id(2)]);
    expect(path.learn.map((entry) => entry.skillId)).toEqual([id(3), id(4)]);
    expect(path.learn[0]!.reasonCodes).toEqual(['GAP_UNKNOWN']);
    expect(path.skip[0]!.reasonCodes).toEqual(['ALREADY_MET']);
  });

  it('shows "not enough evidence" unless a band source says otherwise, and never invents one (C3)', () => {
    const path = groupLearningPath(nonAdaptive([gap(1, 'UNKNOWN', 1), gap(2, 'PARTIAL', 2)], { [id(2)]: 'DEVELOPING' }));
    expect(path.learn[0]!.band).toBe('NOT_ENOUGH_EVIDENCE');
    expect(path.review[0]!.band).toBe('DEVELOPING');
  });

  it('without consent ignores skill states and due reviews entirely', () => {
    const input: PathInput = {
      ...nonAdaptive([gap(1, 'UNKNOWN', 1)]),
      skillStates: [{ skillId: id(1), attemptCount: 3, evidenceBand: 'PROGRESSING' }],
      dueSkillIds: [id(1)],
    };
    const path = groupLearningPath(input);
    expect(path.review).toEqual([]);
    expect(path.learn[0]).toMatchObject({ skillId: id(1), due: false, band: 'NOT_ENOUGH_EVIDENCE' });
  });

  it('adaptive: a due review comes first in review, in due order, even for a met requirement (C7)', () => {
    const path = groupLearningPath({
      adaptive: true,
      gapItems: [gap(1, 'PARTIAL', 1), gap(2, 'MET', 2), gap(3, 'UNKNOWN', 3), gap(4, 'UNKNOWN', 4)],
      skillStates: [
        { skillId: id(2), attemptCount: 4, evidenceBand: 'DEMONSTRATED' },
        { skillId: id(3), attemptCount: 1, evidenceBand: 'NOT_ENOUGH_EVIDENCE' },
        { skillId: id(4), attemptCount: 2, evidenceBand: 'DEVELOPING' },
      ],
      dueSkillIds: [id(4), id(2)],
      evidenceBands: new Map(),
    });
    expect(path.review.map((entry) => [entry.skillId, entry.reasonCodes[0], entry.due])).toEqual([
      [id(4), 'DUE_REVIEW', true],
      [id(2), 'DUE_REVIEW', true],
      [id(1), 'GAP_PARTIAL', false],
      [id(3), 'PRACTISED_BEFORE', false],
    ]);
    expect(path.skip).toEqual([]);
    expect(path.learn).toEqual([]);
    // One attempt stays "not enough evidence" (C3).
    expect(path.review.find((entry) => entry.skillId === id(3))!.band).toBe('NOT_ENOUGH_EVIDENCE');
  });

  it('agrees with planner v1: the planner never picks a skill the path says to skip', () => {
    const items = [gap(1, 'MET', 1), gap(2, 'UNKNOWN', 2), gap(3, 'PARTIAL', 3)];
    const path = groupLearningPath(nonAdaptive(items));
    const decision = planNextStep({
      adaptive: false, sessionMinutes: null,
      careerGap: { careerRoleId: id(90), snapshotId: id(91), modelVersion: 'career-gap-v1', items },
      skillStates: [], dueReviews: [], strategies: [], constraints: { override: null, assignments: [] },
    });
    expect(path.skip.map((entry) => entry.skillId)).not.toContain(decision.skillId);
    expect([...path.review, ...path.learn].map((entry) => entry.skillId)).toContain(decision.skillId);
  });

  it('is deterministic and independent of input order', () => {
    const items = [gap(1, 'MET', 1), gap(2, 'UNKNOWN', 2), gap(3, 'PARTIAL', 3), gap(4, 'MISSING', 4)];
    const forward = groupLearningPath(nonAdaptive(items));
    const reversed = groupLearningPath(nonAdaptive([...items].reverse()));
    expect(reversed).toEqual(forward);
    expect(JSON.stringify(forward)).not.toMatch(/\d\.\d/);
  });

  it('with no target there is nothing to group', () => {
    const path = groupLearningPath(nonAdaptive([]));
    expect([path.skip, path.review, path.learn]).toEqual([[], [], []]);
  });
});
