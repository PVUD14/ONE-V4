/**
 * Tests for the ENG-19 pure rules: "Not sure yet" suggestions (career-discovery-v1) and the merge that
 * makes a skill shared by several goals count once (learner-goal-skills-v1).
 *
 * Pinned: suggestions come only from the roles given (real catalogue rows), 3–5 of them when the
 * catalogue allows, never a role closed to the student's branch, with reasons and no score; attempt
 * history is read only when supplied (consent); the result is deterministic and order-independent.
 * The roles below reuse catalogue codes and wording from Appendix 4 for realism; they are test fixtures.
 */
import { describe, expect, it } from 'vitest';
import {
  CAREER_DISCOVERY_ALGORITHM,
  DISCOVERY_BRANCH_NOT_LISTED,
  DiscoveryAnswersError,
  mergeGoalSkills,
  suggestCareerRoles,
  validateDiscoveryAnswers,
  type DiscoveryRole,
} from '../src/learner-goals.js';

const role = (id: string, code: string | null, text: string, branches: string[], plannedRelease: DiscoveryRole['plannedRelease'] = null, topics: string[] = []): DiscoveryRole => ({
  id, catalogueCode: code, text, eligibleBranches: branches, plannedRelease, requirementTopicIds: topics,
});

const catalogue: DiscoveryRole[] = [
  role('00000000-0000-4000-8000-000000000001', 'S01', 'One programming language, basic data structures, SQL, OOP, aptitude, communication', ['All branches'], 'V2'),
  role('00000000-0000-4000-8000-000000000002', 'S07', 'Programming, browser automation, API testing, CI basics', ['CSE', 'IT', 'ECE'], 'V3'),
  role('00000000-0000-4000-8000-000000000003', 'D01', 'SQL, spreadsheets, statistics, dashboards, communication', ['All branches'], 'V2', ['topic-sql']),
  role('00000000-0000-4000-8000-000000000004', 'C01', 'Networking, Linux, log analysis, incident reporting', ['CSE', 'IT', 'ECE'], 'V1', ['topic-logs']),
  role('00000000-0000-4000-8000-000000000005', 'V02', 'Structural analysis, RCC and steel design, IS codes, analysis software', ['Civil']),
  role('00000000-0000-4000-8000-000000000006', 'B09', 'Product knowledge, communication, negotiation, CRM', ['All branches']),
  role('00000000-0000-4000-8000-000000000007', 'M04', 'Manufacturing processes, line balancing, lean basics, shop-floor problem solving', ['Mechanical', 'Production']),
];
const branches = ['CSE', 'IT', 'ECE', 'Civil', 'Mechanical', 'Production'];

describe('validateDiscoveryAnswers', () => {
  it('accepts the vocabulary and a catalogue branch, sorted and case-matched to the catalogue', () => {
    expect(validateDiscoveryAnswers({ interests: ['WORKING_WITH_DATA', 'BUILDING_SOFTWARE'], strengths: ['NUMBERS'], branch: 'cse' }, branches))
      .toEqual({ interests: ['BUILDING_SOFTWARE', 'WORKING_WITH_DATA'], strengths: ['NUMBERS'], branch: 'CSE' });
    expect(validateDiscoveryAnswers({ interests: ['BUSINESS_AND_PEOPLE'], branch: DISCOVERY_BRANCH_NOT_LISTED }, branches).strengths).toEqual([]);
  });

  it('refuses unknown codes, duplicates, too many or no interests, and a branch outside the catalogue', () => {
    const bad = (value: unknown, code: string) => {
      expect(() => validateDiscoveryAnswers(value, branches)).toThrow(DiscoveryAnswersError);
      try { validateDiscoveryAnswers(value, branches); } catch (error) { expect((error as DiscoveryAnswersError).code).toBe(code); }
    };
    bad({ interests: [], branch: 'CSE' }, 'INVALID_INTERESTS');
    bad({ interests: ['ASTRONAUT'], branch: 'CSE' }, 'INVALID_INTERESTS');
    bad({ interests: ['BUILDING_SOFTWARE', 'BUILDING_SOFTWARE'], branch: 'CSE' }, 'INVALID_INTERESTS');
    bad({ interests: ['BUILDING_SOFTWARE', 'WORKING_WITH_DATA', 'SECURING_SYSTEMS', 'BUSINESS_AND_PEOPLE'], branch: 'CSE' }, 'INVALID_INTERESTS');
    bad({ interests: ['BUILDING_SOFTWARE'], strengths: ['JUGGLING'], branch: 'CSE' }, 'INVALID_STRENGTHS');
    bad({ interests: ['BUILDING_SOFTWARE'], branch: 'Astrophysics' }, 'INVALID_BRANCH');
    bad(null, 'INVALID_INTERESTS');
  });
});

describe('suggestCareerRoles (career-discovery-v1)', () => {
  it('suggests matching roles open to the branch, best first, with reasons and no score', () => {
    const result = suggestCareerRoles({
      answers: { interests: ['BUILDING_SOFTWARE', 'WORKING_WITH_DATA'], strengths: ['NUMBERS'], branch: 'CSE' },
      roles: catalogue, shownSkillIds: null,
    });
    expect(result.algorithmId).toBe(CAREER_DISCOVERY_ALGORITHM);
    const ids = result.suggestions.map((suggestion) => suggestion.roleId);
    // S07 (software interest, names CSE), then D01 (data interest + numbers), then S01 (open to all).
    expect(ids.slice(0, 3)).toEqual([catalogue[1]!.id, catalogue[2]!.id, catalogue[0]!.id]);
    expect(result.suggestions[0]!.reasons).toEqual([{ code: 'INTEREST_MATCH', detail: 'BUILDING_SOFTWARE' }, { code: 'BRANCH_MATCH', detail: 'CSE' }]);
    expect(result.suggestions[1]!.reasons).toEqual([{ code: 'INTEREST_MATCH', detail: 'WORKING_WITH_DATA' }, { code: 'STRENGTH_MATCH', detail: 'NUMBERS' }]);
    expect(ids).not.toContain(catalogue[4]!.id); // Civil only
    expect(ids).not.toContain(catalogue[6]!.id); // Mechanical / Production only
    expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(result)).not.toMatch(/score/i);
    expect(result.usedShownSkills).toBe(false);
  });

  it('only ever suggests roles it was given — real catalogue rows only', () => {
    const answers = { interests: ['SECURING_SYSTEMS'] as const, strengths: ['COMMUNICATION'] as const, branch: 'ECE' };
    const given = new Set(catalogue.map((entry) => entry.id));
    const result = suggestCareerRoles({ answers: { ...answers, interests: [...answers.interests], strengths: [...answers.strengths] }, roles: catalogue, shownSkillIds: null });
    for (const suggestion of result.suggestions) expect(given.has(suggestion.roleId)).toBe(true);
    expect(suggestCareerRoles({ answers: { interests: ['BUILDING_SOFTWARE'], strengths: [], branch: 'CSE' }, roles: [], shownSkillIds: null }))
      .toEqual({ algorithmId: CAREER_DISCOVERY_ALGORITHM, suggestions: [], usedShownSkills: false, fewerThanMinimum: true });
  });

  it('fills to three with branch-open roles, saying so, and caps at five', () => {
    const civil = suggestCareerRoles({ answers: { interests: ['BUILDINGS_AND_INFRASTRUCTURE'], strengths: [], branch: 'Civil' }, roles: catalogue, shownSkillIds: null });
    expect(civil.suggestions[0]).toEqual({ roleId: catalogue[4]!.id, reasons: [{ code: 'INTEREST_MATCH', detail: 'BUILDINGS_AND_INFRASTRUCTURE' }, { code: 'BRANCH_MATCH', detail: 'Civil' }] });
    expect(civil.suggestions).toHaveLength(3);
    expect(civil.suggestions.slice(1).every((suggestion) => suggestion.reasons[0]!.code === 'OPEN_TO_ALL_BRANCHES')).toBe(true);
    expect(civil.fewerThanMinimum).toBe(false);

    const many = Array.from({ length: 9 }, (_, index) => role(`00000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`, `S${String(index + 1).padStart(2, '0')}`, 'Programming', ['Any']));
    expect(suggestCareerRoles({ answers: { interests: ['BUILDING_SOFTWARE'], strengths: [], branch: 'CSE' }, roles: many, shownSkillIds: null }).suggestions).toHaveLength(5);
  });

  it('says so when the catalogue offers fewer than three roles', () => {
    const result = suggestCareerRoles({ answers: { interests: ['BUSINESS_AND_PEOPLE'], strengths: [], branch: DISCOVERY_BRANCH_NOT_LISTED }, roles: [catalogue[5]!], shownSkillIds: null });
    expect(result.suggestions).toHaveLength(1);
    expect(result.fewerThanMinimum).toBe(true);
  });

  it('reads shown skills only when they are supplied (adaptive-learning consent)', () => {
    const answers = { interests: ['SECURING_SYSTEMS', 'WORKING_WITH_DATA'] as ('SECURING_SYSTEMS' | 'WORKING_WITH_DATA')[], strengths: [], branch: 'CSE' };
    const without = suggestCareerRoles({ answers, roles: catalogue, shownSkillIds: null });
    const withSkills = suggestCareerRoles({ answers, roles: catalogue, shownSkillIds: ['TOPIC-LOGS'] });
    expect(without.suggestions.flatMap((suggestion) => suggestion.reasons).some((reason) => reason.code === 'SHOWN_SKILLS')).toBe(false);
    expect(withSkills.usedShownSkills).toBe(true);
    const c01 = withSkills.suggestions.find((suggestion) => suggestion.roleId === catalogue[3]!.id)!;
    expect(c01.reasons.map((reason) => reason.code)).toContain('SHOWN_SKILLS');
  });

  it('is deterministic and ignores input order', () => {
    const answers = { interests: ['BUILDING_SOFTWARE'] as 'BUILDING_SOFTWARE'[], strengths: ['COMMUNICATION'] as 'COMMUNICATION'[], branch: 'IT' };
    const forward = suggestCareerRoles({ answers, roles: catalogue, shownSkillIds: null });
    let seed = 7;
    for (let run = 0; run < 25; run += 1) {
      const shuffled = [...catalogue].sort(() => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 3 - 1; });
      expect(suggestCareerRoles({ answers, roles: shuffled, shownSkillIds: null })).toEqual(forward);
    }
  });
});

describe('mergeGoalSkills (learner-goal-skills-v1)', () => {
  it('lists a skill shared by several goals once, with every goal that needs it', () => {
    const merged = mergeGoalSkills([
      { goalId: 'role-soc', goalType: 'ROLE', skills: [{ topicId: 'T-comm', topicTitle: 'Communication', status: 'PARTIAL' }, { topicId: 't-logs', topicTitle: 'Logs', status: 'UNKNOWN' }] },
      { goalId: 'role-swe', goalType: 'ROLE', skills: [{ topicId: 't-comm', topicTitle: 'Communication', status: 'MISSING' }] },
      { goalId: 'topic-comm', goalType: 'TOPIC', skills: [{ topicId: 't-comm', topicTitle: null, status: null }, { topicId: 't-comm', topicTitle: null, status: null }] },
    ]);
    expect(merged.skills.map((skill) => skill.topicId)).toEqual(['T-comm', 't-logs']);
    expect(merged.skills[0]!.goals).toEqual([
      { goalId: 'role-soc', goalType: 'ROLE', status: 'PARTIAL' },
      { goalId: 'role-swe', goalType: 'ROLE', status: 'MISSING' },
      { goalId: 'topic-comm', goalType: 'TOPIC', status: null },
    ]);
    expect(mergeGoalSkills([]).skills).toEqual([]);
  });
});
