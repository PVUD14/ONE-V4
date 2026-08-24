import { describe, expect, it } from 'vitest';
import {
  AssessmentRuleError,
  allocateDifficulty,
  assertDefinitionTransition,
  assertQuestionTransition,
  buildOptionMap,
  deterministicShuffle,
  gradeObjectiveAnswer,
  mapDisplayedResponse,
  questionHash,
  remainingSeconds,
  selectAttemptQuestions,
  selectBlueprintPool,
  summarizeAttempt,
  textSimilarity,
  validateAssessmentAvailability,
  validateAttemptLimit,
  validateObjectiveQuestion,
  validateSectionCounts,
} from '../src/index.js';

describe('question validation', () => {
  it('accepts a well-formed single-choice question and rejects a keyless duplicate', () => {
    expect(() => validateObjectiveQuestion({
      questionText: 'What does ACID stand for?',
      questionType: 'SINGLE_CHOICE_MCQ',
      options: [
        { key: 'A', text: 'Atomicity...', isCorrect: true },
        { key: 'B', text: 'Availability...', isCorrect: false },
      ],
    })).not.toThrow();
    expect(() => validateObjectiveQuestion({
      questionText: 'x',
      questionType: 'SINGLE_CHOICE_MCQ',
      options: [
        { key: 'A', text: 'one', isCorrect: true },
        { key: 'A', text: 'two', isCorrect: false },
      ],
    })).toThrow(AssessmentRuleError);
  });

  it('enforces per-type structure: multiple-select, true/false, fill-in-the-blank, match', () => {
    expect(() => validateObjectiveQuestion({
      questionText: 'Pick two.', questionType: 'MULTIPLE_SELECT',
      options: [
        { key: 'A', text: 'a', isCorrect: true }, { key: 'B', text: 'b', isCorrect: true },
      ],
    })).toThrow(/distractor|at least/i);
    expect(() => validateObjectiveQuestion({
      questionText: 'The sky is blue.', questionType: 'TRUE_FALSE',
      options: [{ key: 'A', text: 'True', isCorrect: true }, { key: 'B', text: 'False', isCorrect: false }],
    })).not.toThrow();
    expect(() => validateObjectiveQuestion({ questionText: 'No blank here.', questionType: 'FILL_IN_THE_BLANK', acceptedAnswers: ['x'] })).toThrow(/_____/);
    expect(() => validateObjectiveQuestion({
      questionText: 'Match.', questionType: 'MATCH_THE_FOLLOWING',
      options: [{ key: 'A', text: 'left', isCorrect: false }],
    })).toThrow(/two keyed pairs/);
  });

  it('governs lifecycle transitions for questions and definitions', () => {
    expect(() => assertQuestionTransition('DRAFT', 'UNDER_REVIEW')).not.toThrow();
    expect(() => assertQuestionTransition('DRAFT', 'APPROVED')).toThrow(AssessmentRuleError);
    expect(() => assertQuestionTransition('ARCHIVED', 'DRAFT')).toThrow(AssessmentRuleError);
    expect(() => assertDefinitionTransition('DRAFT', 'PUBLISHED')).not.toThrow();
    expect(() => assertDefinitionTransition('PUBLISHED', 'DRAFT')).toThrow(AssessmentRuleError);
  });

  it('hashes normalized text so trivial edits still collide, and measures similarity', () => {
    expect(questionHash('What is TCP/IP?')).toBe(questionHash('what is  tcp ip'));
    expect(textSimilarity('What is TCP/IP?', 'what is tcp ip')).toBe(1);
    expect(textSimilarity('completely different', 'nothing shared here')).toBe(0);
  });
});

describe('blueprint and availability rules', () => {
  it('reconciles section marks against the declared total', () => {
    const sections = [
      { title: 'Section A', poolSize: 10, displayCount: 5, marksPerQuestion: 2 },
      { title: 'Section B', poolSize: 6, displayCount: 5, marksPerQuestion: 1 },
    ];
    expect(validateSectionCounts(sections, 15)).toEqual({ displayedQuestions: 10, calculatedMarks: 15 });
    expect(() => validateSectionCounts(sections, 20)).toThrow(/total/);
    expect(() => validateSectionCounts([{ title: 'S', poolSize: 3, displayCount: 4, marksPerQuestion: 1 }], 4)).toThrow(/pool/);
    expect(() => validateSectionCounts(sections, 15, [10, 5])).toThrow(/exactly 6/);
  });

  it('rejects attempts outside the window or beyond the allowance', () => {
    const now = Date.parse('2026-05-20T10:00:00Z');
    expect(() => validateAssessmentAvailability('2026-05-20T09:00:00Z', '2026-05-20T11:00:00Z', now)).not.toThrow();
    expect(() => validateAssessmentAvailability('2026-05-20T10:30:00Z', '2026-05-20T11:00:00Z', now)).toThrow(/not started/);
    expect(() => validateAssessmentAvailability('2026-05-20T08:00:00Z', '2026-05-20T09:00:00Z', now)).toThrow(/closed/);
    expect(() => validateAttemptLimit(1, 2)).not.toThrow();
    expect(() => validateAttemptLimit(2, 2)).toThrow(/attempts remain/);
  });

  it('computes remaining seconds from the tighter of duration and window', () => {
    const now = Date.parse('2026-05-20T10:00:00Z');
    expect(remainingSeconds('2026-05-20T09:30:00Z', 3600, '2026-05-20T12:00:00Z', now)).toBe(1800);
    expect(remainingSeconds('2026-05-20T09:30:00Z', 7200, '2026-05-20T10:10:00Z', now)).toBe(600);
    expect(remainingSeconds('2026-05-20T08:00:00Z', 600, '2026-05-20T12:00:00Z', now)).toBe(0);
  });
});

describe('deterministic paper assembly', () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    id: `q${index}`,
    difficulty: (index % 3 === 0 ? 'EASY' : index % 3 === 1 ? 'MEDIUM' : 'HARD') as 'EASY' | 'MEDIUM' | 'HARD',
  }));

  it('shuffles identically for identical seeds and differently otherwise', () => {
    const once = deterministicShuffle(candidates, 'seed-1').map((entry) => entry.id);
    const again = deterministicShuffle(candidates, 'seed-1').map((entry) => entry.id);
    const other = deterministicShuffle(candidates, 'seed-2').map((entry) => entry.id);
    expect(again).toEqual(once);
    expect(other).not.toEqual(once);
    expect([...once].sort()).toEqual(candidates.map((entry) => entry.id).sort());
  });

  it('allocates difficulty by percentage with largest remainders', () => {
    const allocation = allocateDifficulty(10, { EASY: 45, MEDIUM: 35, HARD: 20 });
    expect(allocation.filter((value) => value === 'EASY').length).toBe(5);
    expect(allocation.filter((value) => value === 'MEDIUM').length).toBe(3);
    expect(allocation.filter((value) => value === 'HARD').length).toBe(2);
  });

  it('builds a blueprint pool honouring the distribution and fails when the bank is thin', () => {
    const pool = selectBlueprintPool(candidates, 9, { EASY: 34, MEDIUM: 33, HARD: 33 }, 'exam-1');
    expect(pool.length).toBe(9);
    expect(selectBlueprintPool(candidates, 9, { EASY: 34, MEDIUM: 33, HARD: 33 }, 'exam-1')).toEqual(pool);
    expect(() => selectBlueprintPool(candidates.slice(0, 3), 9, { EASY: 100, MEDIUM: 0, HARD: 0 }, 'x')).toThrow(/only/);
  });

  it('selects attempt questions deterministically per seed', () => {
    const pool = candidates.slice(0, 12);
    const paperA = selectAttemptQuestions(pool, 5, 'attempt-a').map((entry) => entry.id);
    expect(selectAttemptQuestions(pool, 5, 'attempt-a').map((entry) => entry.id)).toEqual(paperA);
    expect(() => selectAttemptQuestions(pool, 20, 'attempt-a')).toThrow(/must be displayed/);
  });

  it('produces a reversible option map', () => {
    const map = buildOptionMap(['A', 'B', 'C', 'D'], 'attempt-a:q1');
    expect(Object.keys(map).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect([...new Set(Object.values(map))].sort()).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('scoring', () => {
  it('grades each objective type, honouring case rules and negative marking', () => {
    expect(gradeObjectiveAnswer(
      { questionType: 'SINGLE_CHOICE_MCQ', answerKey: { correctOptionKeys: ['B'] }, marks: 2, negativeMarks: 0.5 },
      { selectedOptionKeys: ['B'] },
    )).toEqual({ answered: true, isCorrect: true, marksAwarded: 2 });
    expect(gradeObjectiveAnswer(
      { questionType: 'SINGLE_CHOICE_MCQ', answerKey: { correctOptionKeys: ['B'] }, marks: 2, negativeMarks: 0.5 },
      { selectedOptionKeys: ['A'] },
    ).marksAwarded).toBe(-0.5);
    expect(gradeObjectiveAnswer(
      { questionType: 'MULTIPLE_SELECT', answerKey: { correctOptionKeys: ['A', 'C'] }, marks: 3 },
      { selectedOptionKeys: ['C', 'A'] },
    ).isCorrect).toBe(true);
    expect(gradeObjectiveAnswer(
      { questionType: 'FILL_IN_THE_BLANK', answerKey: { acceptedAnswers: ['Normalization'], caseSensitive: false }, marks: 1 },
      { text: '  normalization ' },
    ).isCorrect).toBe(true);
    expect(gradeObjectiveAnswer(
      { questionType: 'MATCH_THE_FOLLOWING', answerKey: { matches: { A: '1', B: '2' } }, marks: 2 },
      { matches: { A: '1', B: '2' } },
    ).isCorrect).toBe(true);
    expect(gradeObjectiveAnswer(
      { questionType: 'SINGLE_CHOICE_MCQ', answerKey: { correctOptionKeys: ['B'] }, marks: 2, negativeMarks: 0.5 },
      null,
    )).toEqual({ answered: false, isCorrect: false, marksAwarded: 0 });
  });

  it('maps display-key responses back through the option map before grading', () => {
    const mapped = mapDisplayedResponse('SINGLE_CHOICE_MCQ', { selectedOptionKeys: ['A'] }, { A: 'C', B: 'A', C: 'B' });
    expect(mapped).toEqual({ selectedOptionKeys: ['C'] });
    expect(mapDisplayedResponse('FILL_IN_THE_BLANK', { text: 'x' }, { A: 'B' })).toEqual({ text: 'x' });
  });

  it('summarizes an attempt with a rounded percentage', () => {
    const summary = summarizeAttempt([
      { answered: true, isCorrect: true, marksAwarded: 2, marks: 2 },
      { answered: true, isCorrect: false, marksAwarded: -0.5, marks: 2 },
      { answered: false, isCorrect: false, marksAwarded: 0, marks: 2 },
    ]);
    expect(summary).toEqual({ score: 1.5, maxScore: 6, percentage: 25, correct: 1, wrong: 1, notAttempted: 1 });
  });
});
