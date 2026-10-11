/**
 * EMP-06: the eligibility evaluator and the requirement input rules, tested without a database —
 * scales, missing records, verified against self-reported, custom rules, and the fairness guards.
 */
import { describe, expect, it } from 'vitest';
import type { EligibilityRule } from '../src/index.js';
import {
  cgpa10Equivalent,
  employerOutcome,
  evaluateStudentEligibility,
  resolveEligibilityFacts,
  type AcademicQualificationRecord,
  type AcademicTermRecord,
  type EligibilityRecords,
} from '../src/eligibility.js';
import {
  RequirementInputError,
  STAGE_APPLICATION_STATE,
  mentionsProtectedAttribute,
  parseEligibilityRules,
  parseSelectionStages,
  parseSkillRequirements,
} from '../src/opportunity-requirements.js';

const college = '11111111-1111-4111-8111-111111111111';
const otherCollege = '22222222-2222-4222-8222-222222222222';

function term(sequence: number, value: number | null, scale: string | null, state = 'VERIFIED', backlogs: number | null = null, letter = false): AcademicTermRecord {
  return { sequence, label: `Semester ${sequence}`, resultValue: letter ? null : value, resultScale: scale, backlogCount: backlogs, verificationState: state };
}
function qualification(terms: AcademicTermRecord[], extra: Partial<AcademicQualificationRecord> = {}): AcademicQualificationRecord {
  return { id: 'q-' + Math.random(), institutionId: college, completedOn: null, verificationState: 'SELF_REPORTED', terms, ...extra };
}
function records(qualifications: AcademicQualificationRecord[], institution: EligibilityRecords['institution'] = null): EligibilityRecords {
  return { institution, qualifications };
}
const minCgpa = (value: number, isBlocking = true): EligibilityRule => ({ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: value, valueText: null, isBlocking });
const maxBacklogs = (value: number, isBlocking = true): EligibilityRule => ({ ruleType: 'MAX_BACKLOGS', comparator: 'LTE', valueNumeric: value, valueText: null, isBlocking });

describe('EMP-06 evaluator: CGPA from term results', () => {
  it('uses the latest verified term, on its own scale, and meets a rule it clears', () => {
    const result = evaluateStudentEligibility([minCgpa(7)], records([qualification([term(1, 6.5, 'CGPA_10'), term(2, 7.4, 'CGPA_10')])]));
    expect(result.eligible).toBe(true);
    expect(result.outcomes[0]).toMatchObject({ outcome: 'MET', basis: 'VERIFIED', flagged: false, studentValue: '7.4 on a 10-point CGPA (Semester 2)' });
  });

  it('refuses a student below the minimum and names the rule', () => {
    const result = evaluateStudentEligibility([minCgpa(7), maxBacklogs(2)], records([qualification([term(1, 6.9, 'CGPA_10', 'VERIFIED', 0)])]));
    expect(result.eligible).toBe(false);
    expect(result.blockingFailures.map((outcome) => outcome.ruleType)).toEqual(['MIN_CGPA']);
    expect(result.undetermined).toEqual([]);
  });

  it.each([
    ['GPA_4', 2.8, 7, true],     // 2.8/4 = 7.0 on 10
    ['GPA_4', 2.79, 7, false],
    ['PERCENTAGE', 70, 7, true], // 70% = 7.0 on 10, the same linear rule as asCgpa10
    ['PERCENTAGE', 69.9, 7, false],
  ] as const)('normalises %s %s at comparison time only (minimum %s: %s)', (scale, value, minimum, met) => {
    const result = evaluateStudentEligibility([minCgpa(minimum)], records([qualification([term(1, value, scale)])]));
    expect(result.outcomes[0]!.outcome).toBe(met ? 'MET' : 'NOT_MET');
    // The student sees the figure as issued, never the converted one.
    expect(result.outcomes[0]!.studentValue).toContain(String(value));
  });

  it('treats letter grades and pass/fail as not comparable: unknown, never a guess', () => {
    const facts = resolveEligibilityFacts(records([qualification([term(1, null, 'LETTER', 'VERIFIED', null, true), term(2, null, 'PASS_FAIL', 'VERIFIED', null, true)])]));
    expect(facts.cgpa10).toBeNull();
    expect(facts.cgpaUnknownReason).toBe('SCALE_NOT_COMPARABLE');
    const result = evaluateStudentEligibility([minCgpa(6)], records([qualification([term(1, null, 'LETTER', 'VERIFIED', null, true)])]));
    expect(result.eligible).toBe(false);
    expect(result.blockingFailures).toEqual([]);
    expect(result.undetermined[0]).toMatchObject({ ruleType: 'MIN_CGPA', outcome: 'UNKNOWN', unknownReason: 'SCALE_NOT_COMPARABLE' });
    expect(cgpa10Equivalent(8, 'LETTER')).toBeNull();
  });

  it('with no record at all, a blocking rule is unknown (fail closed) and an advisory one is only a flag', () => {
    const blocking = evaluateStudentEligibility([minCgpa(6)], records([]));
    expect(blocking.eligible).toBe(false);
    expect(blocking.undetermined[0]).toMatchObject({ outcome: 'UNKNOWN', unknownReason: 'NO_RECORD' });
    const advisory = evaluateStudentEligibility([minCgpa(6, false)], records([]));
    expect(advisory.eligible).toBe(true);
    expect(advisory.outcomes[0]).toMatchObject({ outcome: 'UNKNOWN', flagged: true });
  });
});

describe('EMP-06 evaluator: verified against self-reported', () => {
  it('prefers a verified term over a newer self-reported one', () => {
    const facts = resolveEligibilityFacts(records([qualification([term(3, 6.1, 'CGPA_10', 'VERIFIED'), term(4, 9.9, 'CGPA_10', 'SELF_REPORTED')])]));
    expect(facts.cgpa10).toMatchObject({ value: 6.1, basis: 'VERIFIED' });
  });

  it('uses a self-reported figure where nothing is verified, and flags it for the employer', () => {
    const result = evaluateStudentEligibility([minCgpa(7)], records([qualification([term(1, 8.2, 'CGPA_10', 'SELF_REPORTED'), term(2, 8.4, 'CGPA_10', 'PENDING_VERIFICATION')])]));
    expect(result.eligible).toBe(true);
    expect(result.outcomes[0]).toMatchObject({ outcome: 'MET', basis: 'SELF_REPORTED', flagged: true, studentValue: '8.4 on a 10-point CGPA (Semester 2)' });
    expect(result.selfReportedCount).toBe(1);
    expect(result.flagCount).toBe(1);
  });

  it('never uses a rejected term or a rejected qualification', () => {
    const facts = resolveEligibilityFacts(records([
      qualification([term(1, 9.5, 'CGPA_10', 'REJECTED')]),
    ]));
    expect(facts.cgpa10).toBeNull();
    const rejectedQualification = resolveEligibilityFacts(records([qualification([term(1, 9.5, 'CGPA_10', 'SELF_REPORTED')], { verificationState: 'REJECTED' })]));
    expect(rejectedQualification.cgpa10).toBeNull();
  });

  it('reads from the qualification at the current college before a newer one elsewhere', () => {
    const elsewhere = qualification([term(1, 9.9, 'CGPA_10', 'SELF_REPORTED')], { institutionId: otherCollege });
    const here = qualification([term(1, 6.8, 'CGPA_10', 'VERIFIED')], { institutionId: college });
    const facts = resolveEligibilityFacts(records([elsewhere, here], { institutionId: college, departmentName: 'CSE', programName: 'BTech', graduationYear: 2027 }));
    expect(facts.cgpa10).toMatchObject({ value: 6.8, basis: 'VERIFIED' });
  });

  it('sums backlogs over verified terms, and over self-reported terms only when none is verified', () => {
    const verified = resolveEligibilityFacts(records([qualification([term(1, 7, 'CGPA_10', 'VERIFIED', 1), term(2, 7, 'CGPA_10', 'VERIFIED', 2), term(3, 7, 'CGPA_10', 'SELF_REPORTED', 5)])]));
    expect(verified.activeBacklogs).toMatchObject({ value: 3, basis: 'VERIFIED' });
    const declared = resolveEligibilityFacts(records([qualification([term(1, 7, 'CGPA_10', 'SELF_REPORTED', 1), term(2, 7, 'CGPA_10', 'SELF_REPORTED', 2)])]));
    expect(declared.activeBacklogs).toMatchObject({ value: 3, basis: 'SELF_REPORTED' });
    const none = resolveEligibilityFacts(records([qualification([term(1, 7, 'CGPA_10')])]));
    expect(none.activeBacklogs).toBeNull();
  });

  it('refuses a student above the backlog limit and names the rule', () => {
    const result = evaluateStudentEligibility([minCgpa(6), maxBacklogs(1)], records([qualification([term(1, 8, 'CGPA_10', 'VERIFIED', 2)])]));
    expect(result.eligible).toBe(false);
    expect(result.blockingFailures.map((outcome) => outcome.ruleType)).toEqual(['MAX_BACKLOGS']);
  });
});

describe('EMP-06 evaluator: the institution record', () => {
  const institution = { institutionId: college, departmentName: 'Computer Science', programName: 'BTech', graduationYear: 2027 };

  it('takes department, programme, college and graduation year from the college roster', () => {
    const rules: EligibilityRule[] = [
      { ruleType: 'DEPARTMENT', comparator: 'IN', valueText: 'Computer Science, Information Technology', isBlocking: true },
      { ruleType: 'PROGRAM', comparator: 'EQ', valueText: 'btech', isBlocking: true },
      { ruleType: 'GRADUATION_YEAR', comparator: 'IN', valueText: '2026, 2027', isBlocking: true },
      { ruleType: 'INSTITUTION', comparator: 'IN', valueText: college, isBlocking: true },
    ];
    const result = evaluateStudentEligibility(rules, records([], institution));
    expect(result.eligible).toBe(true);
    expect(result.outcomes.every((outcome) => outcome.basis === 'INSTITUTION_RECORD' && !outcome.flagged)).toBe(true);
  });

  it('falls back to a qualification\'s completion year for someone who has left college, with its basis', () => {
    const graduate = records([qualification([], { completedOn: '2024-06-30', verificationState: 'VERIFIED' })]);
    const result = evaluateStudentEligibility([{ ruleType: 'GRADUATION_YEAR', comparator: 'LTE', valueNumeric: 2025, isBlocking: true }], graduate);
    expect(result.outcomes[0]).toMatchObject({ outcome: 'MET', basis: 'VERIFIED' });
  });

  it('a NOT_IN department rule refuses the listed department', () => {
    const result = evaluateStudentEligibility([{ ruleType: 'DEPARTMENT', comparator: 'NOT_IN', valueText: 'Computer Science', isBlocking: true }], records([], institution));
    expect(result.blockingFailures).toHaveLength(1);
  });
});

describe('EMP-06 evaluator: custom and work-authorisation rules', () => {
  it('never evaluates or blocks on a custom rule, and flags it for a person to judge', () => {
    const result = evaluateStudentEligibility([{ ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Willing to relocate to Pune', isBlocking: true }], records([]));
    expect(result.eligible).toBe(true);
    expect(result.outcomes[0]).toMatchObject({ outcome: 'NOT_EVALUATED', isBlocking: false, flagged: true });
  });

  it('never blocks on work authorisation, which ONE does not record', () => {
    const result = evaluateStudentEligibility([{ ruleType: 'WORK_AUTHORIZATION', comparator: 'EQ', valueText: 'Authorised to work in India', isBlocking: true }], records([]));
    expect(result.eligible).toBe(true);
    expect(result.outcomes[0]).toMatchObject({ outcome: 'UNKNOWN', unknownReason: 'NOT_RECORDED_BY_ONE', isBlocking: false, flagged: true });
  });

  it('what reaches an employer carries the outcome and basis, never the student\'s figure', () => {
    const result = evaluateStudentEligibility([minCgpa(7)], records([qualification([term(1, 8.2, 'CGPA_10', 'SELF_REPORTED')])]));
    const forEmployer = employerOutcome(result.outcomes[0]!);
    expect(forEmployer).toMatchObject({ ruleType: 'MIN_CGPA', outcome: 'MET', basis: 'SELF_REPORTED', flagged: true });
    expect(JSON.stringify(forEmployer)).not.toContain('8.2');
    expect(forEmployer).not.toHaveProperty('studentValue');
  });

  it('no rules: eligible, nothing flagged', () => {
    expect(evaluateStudentEligibility([], records([]))).toMatchObject({ eligible: true, flagCount: 0, outcomes: [] });
  });
});

describe('EMP-06 requirement input', () => {
  const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as RequirementInputError).code; } return 'OK'; };

  it('accepts the fixed rule types with their comparators and normalises lists', () => {
    const rules = parseEligibilityRules([
      { ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7.5 },
      { ruleType: 'MAX_BACKLOGS', comparator: 'LTE', valueNumeric: 0 },
      { ruleType: 'DEPARTMENT', comparator: 'IN', valueText: ' CSE ,  ECE ' },
      { ruleType: 'GRADUATION_YEAR', comparator: 'IN', valueText: '2026,2027' },
      { ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Willing to work night shifts' },
    ]);
    expect(rules.map((rule) => [rule.ruleType, rule.isBlocking])).toEqual([
      ['MIN_CGPA', true], ['MAX_BACKLOGS', true], ['DEPARTMENT', true], ['GRADUATION_YEAR', true], ['CUSTOM', false],
    ]);
    expect(rules[2]!.valueText).toBe('CSE, ECE');
  });

  it.each([
    [[{ ruleType: 'AGE', comparator: 'LTE', valueNumeric: 25 }], 'INVALID_ELIGIBILITY_RULES'],
    [[{ ruleType: 'MIN_CGPA', comparator: 'LTE', valueNumeric: 7 }], 'INVALID_ELIGIBILITY_RULES'],
    [[{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 70 }], 'INVALID_ELIGIBILITY_RULES'],
    [[{ ruleType: 'MAX_BACKLOGS', comparator: 'LTE', valueNumeric: 1.5 }], 'INVALID_ELIGIBILITY_RULES'],
    [[{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7 }, { ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 8 }], 'DUPLICATE_ELIGIBILITY_RULE'],
    [[{ ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Must relocate', isBlocking: true }], 'ELIGIBILITY_RULE_CANNOT_BLOCK'],
    [[{ ruleType: 'WORK_AUTHORIZATION', comparator: 'EQ', valueText: 'India', isBlocking: true }], 'ELIGIBILITY_RULE_CANNOT_BLOCK'],
    [[{ ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Female candidates only' }], 'ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE'],
    [[{ ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Age below 25 years' }], 'ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE'],
    [[{ ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Unmarried applicants preferred' }], 'ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE'],
    [[{ ruleType: 'DEPARTMENT', comparator: 'IN', valueText: 'Domicile of Karnataka' }], 'ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE'],
    [[{ ruleType: 'CUSTOM', comparator: 'EQ', valueText: 'Attach a photo' }], 'ELIGIBILITY_RULE_PROTECTED_ATTRIBUTE'],
    [[{ ruleType: 'INSTITUTION', comparator: 'IN', valueText: 'Not a uuid' }], 'INVALID_ELIGIBILITY_RULES'],
    [[{ ruleType: 'DEPARTMENT', comparator: 'EQ', valueText: '=HYPERLINK()' }], 'INVALID_ELIGIBILITY_RULES'],
    [[{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7, extra: true }], 'INVALID_ELIGIBILITY_RULES'],
    [[{ ruleType: 'MIN_CGPA', comparator: 'GTE', valueNumeric: 7, valueText: 'x' }], 'INVALID_ELIGIBILITY_RULES'],
    ['not a list', 'INVALID_ELIGIBILITY_RULES'],
  ])('refuses %j with %s', (input, expected) => {
    expect(code(() => parseEligibilityRules(input))).toBe(expected);
  });

  it('does not mistake ordinary words for protected attributes', () => {
    for (const text of ['B.Sc Physics', 'Stage management', 'Average of 7', 'Mentorship programme', 'Lightweight tooling', 'Airborne systems'] ) {
      expect(mentionsProtectedAttribute(text)).toBe(false);
    }
  });

  it('skills: a catalogue topic or a free-text name, never both, never duplicated', () => {
    const topic = '33333333-3333-4333-8333-333333333333';
    expect(parseSkillRequirements([{ taxonomyTopicId: topic, level: 'REQUIRED' }, { name: 'Excel', level: 'PREFERRED' }]))
      .toEqual([{ name: null, taxonomyTopicId: topic, level: 'REQUIRED' }, { name: 'Excel', taxonomyTopicId: null, level: 'PREFERRED' }]);
    expect(code(() => parseSkillRequirements([{ taxonomyTopicId: topic, name: 'Python', level: 'REQUIRED' }]))).toBe('INVALID_SKILLS');
    expect(code(() => parseSkillRequirements([{ name: 'SQL', level: 'REQUIRED' }, { name: 'sql', level: 'PREFERRED' }]))).toBe('DUPLICATE_SKILL');
    expect(code(() => parseSkillRequirements([{ name: 'SQL', level: 'NICE' }]))).toBe('INVALID_SKILLS');
  });

  it('stages follow the pipeline order, and an offer comes last', () => {
    const stages = parseSelectionStages([
      { kind: 'SCREENING', label: 'Résumé screen' },
      { kind: 'ASSESSMENT', label: 'Aptitude test' },
      { kind: 'GROUP_DISCUSSION', label: 'Group discussion' },
      { kind: 'INTERVIEW', label: 'Technical interview' },
      { kind: 'INTERVIEW', label: 'HR interview', detail: 'Thirty minutes' },
      { kind: 'OFFER', label: 'Offer' },
    ]);
    expect(stages.map((stage) => STAGE_APPLICATION_STATE[stage.kind])).toEqual(['SCREENING', 'ASSESSMENT', 'ASSESSMENT', 'INTERVIEW', 'INTERVIEW', 'OFFER']);
    expect(code(() => parseSelectionStages([{ kind: 'INTERVIEW', label: 'Interview' }, { kind: 'SCREENING', label: 'Screen' }]))).toBe('STAGE_ORDER_INVALID');
    expect(code(() => parseSelectionStages([{ kind: 'OFFER', label: 'Offer' }, { kind: 'OFFER', label: 'Offer again' }]))).toBe('STAGE_ORDER_INVALID');
    expect(code(() => parseSelectionStages([{ kind: 'COFFEE', label: 'Chat' }]))).toBe('INVALID_STAGES');
  });
});
