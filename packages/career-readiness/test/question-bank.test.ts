/**
 * Tests for the question bank's content rules (OPS-09b): reading a pilot-shaped body, carrying
 * keys the editor does not own, what a draft and a submission must hold, tags only on wrong
 * options, and — the acceptance item — that what a published revision hands to learners never
 * holds the answer key, explanation, tags, hints or difficulty (through toLearnerQuestionDto,
 * the rule the readiness check applies).
 */
import { describe, expect, it } from 'vitest';
import {
  composeQuestionBody,
  publishedQuestionColumns,
  questionMisconceptionTags,
  readAgentDraftProvenance,
  readQuestionDraftFields,
  toLearnerQuestionDto,
  validateQuestionDraft,
  withholdAnswerKey,
  type QuestionDraftFields,
} from '../src/index.js';

const TOPIC = '5f0c7c3e-8d3a-4b8e-9d7c-1a2b3c4d5e6f';
const CODE = '6a1d8d4f-9e4b-4c9f-8e8d-2b3c4d5e6f70';

const complete = (over: Partial<QuestionDraftFields> = {}): QuestionDraftFields => ({
  topicId: TOPIC,
  prompt: 'Synthetic: which alert should be looked at first?',
  options: [
    { id: 'a', text: 'The oldest alert', misconception: { codeId: CODE, rationale: 'Synthetic: treats age as severity.' } },
    { id: 'b', text: 'The alert on the most critical asset', misconception: null },
    { id: 'c', text: 'The alert with the longest description', misconception: null },
  ],
  correctOptionId: 'b',
  explanation: 'Synthetic: severity follows the asset and the impact.',
  difficulty: 'FOUNDATION',
  hints: ['Think about impact.', 'Rank by what is at risk.', 'Which asset matters most here?', 'Two options ignore the asset entirely.'],
  licenceLabel: 'AI8HT-Owned',
  attribution: null,
  basis: 'Synthetic basis',
  ...over,
});

describe('readQuestionDraftFields', () => {
  it('reads a pilot question body, which has no difficulty, hints, tags or rights', () => {
    const fields = readQuestionDraftFields({
      id: '24000000-0000-4000-8000-000000000001', stableKey: 'crf-q1', topicId: '20000000-0000-4000-8000-000000000001',
      prompt: 'Which follow-up is clearest?', options: [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }],
      correctOptionId: 'b', explanation: 'Because.',
    });
    expect(fields).toMatchObject({
      topicId: '20000000-0000-4000-8000-000000000001', correctOptionId: 'b', explanation: 'Because.', difficulty: null,
      hints: ['', '', '', ''], licenceLabel: null, attribution: null, basis: null,
    });
    expect(fields.options).toEqual([{ id: 'a', text: 'One', misconception: null }, { id: 'b', text: 'Two', misconception: null }]);
  });

  it('tolerates an empty or malformed body', () => {
    const fields = readQuestionDraftFields({ topicId: 'not-a-uuid', difficulty: 'HARDEST', hints: 'nope' });
    expect(fields).toMatchObject({ topicId: null, prompt: '', options: [], difficulty: null, hints: ['', '', '', ''] });
  });
});

describe('composeQuestionBody', () => {
  it('carries keys the editor does not own and round-trips the fields', () => {
    const body = composeQuestionBody({ id: 'pilot-id', provenance: { packKey: 'x' } }, 'soc-q-001', complete());
    expect(body).toMatchObject({ id: 'pilot-id', provenance: { packKey: 'x' }, schema: 'question-bank/v1', stableKey: 'soc-q-001' });
    expect(readQuestionDraftFields(body)).toEqual(complete());
  });
});

describe('validateQuestionDraft', () => {
  it('accepts a complete question for submission', () => {
    expect(validateQuestionDraft('soc-q-001', complete(), true)).toEqual([]);
  });

  it('lets a draft be incomplete but not malformed', () => {
    const draft = complete({ options: [], correctOptionId: null, explanation: null, difficulty: null, hints: ['', '', '', ''], licenceLabel: null, topicId: null });
    expect(validateQuestionDraft('soc-q-001', draft, false)).toEqual([]);
    expect(validateQuestionDraft('Bad Key', draft, false)).toContain('QUESTION_KEY_INVALID');
    expect(validateQuestionDraft('soc-q-001', complete({ prompt: '' }), false)).toContain('QUESTION_PROMPT_INVALID');
  });

  it('lists everything a submission still needs', () => {
    const problems = validateQuestionDraft('soc-q-001', complete({
      topicId: null, options: [{ id: 'a', text: '', misconception: null }], correctOptionId: null, explanation: null,
      difficulty: null, hints: ['one', '', 'three', ''], licenceLabel: 'CC-BY-4.0', attribution: null,
    }), true);
    expect(problems).toEqual(expect.arrayContaining([
      'QUESTION_TOPIC_MISSING', 'QUESTION_OPTION_MISSING:a', 'QUESTION_OPTIONS_TOO_FEW', 'QUESTION_ANSWER_KEY_MISSING',
      'QUESTION_EXPLANATION_MISSING', 'QUESTION_DIFFICULTY_MISSING', 'QUESTION_HINT_MISSING:2', 'QUESTION_HINT_MISSING:4',
      'QUESTION_ATTRIBUTION_MISSING',
    ]));
    expect(validateQuestionDraft('soc-q-001', complete({ licenceLabel: null }), true)).toContain('QUESTION_LICENCE_MISSING');
  });

  it('keeps option ids in order a–f, unique and at most six', () => {
    const shuffled = complete({ options: [{ id: 'b', text: 'x', misconception: null }, { id: 'a', text: 'y', misconception: null }] });
    expect(validateQuestionDraft('soc-q-001', shuffled, false)).toContain('QUESTION_OPTION_IDS_INVALID');
    const seven = complete({ options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, text: id, misconception: null })), correctOptionId: 'a' });
    expect(validateQuestionDraft('soc-q-001', seven, false)).toContain('QUESTION_OPTIONS_TOO_MANY');
    expect(validateQuestionDraft('soc-q-001', complete({ correctOptionId: 'z' }), false)).toContain('QUESTION_CORRECT_OPTION_INVALID');
  });

  it('refuses a misconception on the correct option and a tag without a rationale', () => {
    const onCorrect = complete({ correctOptionId: 'a' });
    expect(validateQuestionDraft('soc-q-001', onCorrect, false)).toContain('QUESTION_MISCONCEPTION_ON_CORRECT:a');
    const noWhy = complete({ options: [{ id: 'a', text: 'x', misconception: { codeId: CODE, rationale: '' } }, { id: 'b', text: 'y', misconception: null }] });
    expect(validateQuestionDraft('soc-q-001', noWhy, false)).toContain('QUESTION_MISCONCEPTION_RATIONALE_INVALID:a');
    const badCode = complete({ options: [{ id: 'a', text: 'x', misconception: { codeId: 'SUBNET_OFF_BY_ONE', rationale: 'why' } }, { id: 'b', text: 'y', misconception: null }] });
    expect(validateQuestionDraft('soc-q-001', badCode, false)).toContain('QUESTION_MISCONCEPTION_INVALID:a');
  });

  it('bounds hint length', () => {
    expect(validateQuestionDraft('soc-q-001', complete({ hints: ['x'.repeat(1001), 'b', 'c', 'd'] }), false)).toContain('QUESTION_HINT_TOO_LONG:1');
  });
});

describe('tags and the answer key', () => {
  it('lists tags on wrong options only', () => {
    expect(questionMisconceptionTags(complete())).toEqual([{ optionId: 'a', codeId: CODE, rationale: 'Synthetic: treats age as severity.' }]);
  });

  it('withholds the key, the explanation and the tags from a viewer without edit or review', () => {
    const shown = withholdAnswerKey(complete());
    expect(shown.correctOptionId).toBeNull();
    expect(shown.explanation).toBeNull();
    expect(shown.options.every((option) => option.misconception === null)).toBe(true);
    expect(shown.hints).toEqual(complete().hints);
  });

  it('never lets the answer key, explanation, tags, hints or difficulty reach a learner DTO', () => {
    const columns = publishedQuestionColumns(complete());
    expect(columns.answerKey).toEqual({ correctOptionId: 'b', explanation: 'Synthetic: severity follows the asset and the impact.' });
    expect(columns.learner.options).toEqual([{ id: 'a', text: 'The oldest alert' }, { id: 'b', text: 'The alert on the most critical asset' }, { id: 'c', text: 'The alert with the longest description' }]);
    // The shape the readiness check holds before stripping the key, then the learner DTO.
    const learner = toLearnerQuestionDto({
      id: 'qv', topicId: columns.learner.topicId, prompt: columns.learner.prompt, options: columns.learner.options,
      correctOptionId: columns.answerKey.correctOptionId, publishedRevision: 2,
    });
    expect(learner).not.toHaveProperty('correctOptionId');
    const serialised = JSON.stringify(learner);
    for (const secret of ['correctOptionId', 'explanation', 'misconception', 'hints', 'difficulty', 'Synthetic: severity', 'treats age']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('refuses to publish an incomplete question', () => {
    expect(() => publishedQuestionColumns(complete({ correctOptionId: null }))).toThrow();
  });
});

describe('readAgentDraftProvenance (ENG-10)', () => {
  const provenance = { source: 'AGENT_DRAFTED', generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-10-aptitude-bank-v1', generatedAt: '2026-09-28T00:00:00.000Z' };

  it('reads a complete agent-draft record and its note for the subject expert', () => {
    expect(readAgentDraftProvenance({ provenance, expertCheck: ' Check the key. ' })).toEqual({
      generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-10-aptitude-bank-v1', generatedAt: '2026-09-28T00:00:00.000Z', expertCheck: 'Check the key.',
    });
    expect(readAgentDraftProvenance({ provenance })?.expertCheck).toBeNull();
  });

  it('is null for a body a person wrote, and for an incomplete or malformed record', () => {
    expect(readAgentDraftProvenance({})).toBeNull();
    expect(readAgentDraftProvenance(null)).toBeNull();
    expect(readAgentDraftProvenance({ provenance: { ...provenance, source: 'AUTHORED' } })).toBeNull();
    expect(readAgentDraftProvenance({ provenance: { ...provenance, generatorVersion: '' } })).toBeNull();
    expect(readAgentDraftProvenance({ provenance: { ...provenance, promptVersion: 'x'.repeat(129) } })).toBeNull();
    expect(readAgentDraftProvenance({ provenance: { ...provenance, generatedAt: 'not a date' } })).toBeNull();
  });

  it('survives an editor save: composeQuestionBody carries the provenance keys', () => {
    const body = composeQuestionBody({ provenance, expertCheck: 'Check it.', packKey: 'aptitude-bank-v1' }, 'apt-q-x-001', complete());
    expect(readAgentDraftProvenance(body)).toMatchObject({ promptVersion: 'eng-10-aptitude-bank-v1', expertCheck: 'Check it.' });
    expect(body.packKey).toBe('aptitude-bank-v1');
  });
});
