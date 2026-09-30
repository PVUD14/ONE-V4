/**
 * Unit tests for the hint ladder rules (ENG-15, hint-ladder-v1): a ladder is complete, climbs
 * (no level repeats an earlier one), and never names the correct option — by its text, unless the
 * prompt already states that text, or by its letter. Also the ladder's own provenance in a
 * question body, which falls back to the item's.
 *
 * Design: docs/architecture/hint-ladder-authoring-design.md
 */
import { describe, expect, it } from 'vitest';
import { HINT_LADDER_RULES_VERSION, hintLadderFindings, readHintLadderProvenance } from '../src/index.js';

const options = [
  { id: 'a', text: 'x = 9' },
  { id: 'b', text: 'x = 15' },
  { id: 'c', text: 'x = 5' },
  { id: 'd', text: 'x = 1' },
];
const base = {
  prompt: 'Solve for x: 3x + 6 = 21',
  options,
  correctOptionId: 'c',
  hints: ['Undo the operations on x in reverse order.', 'First remove the + 6, then the × 3.', 'Subtracting 6 from both sides gives 3x = 15.', 'Divide 15 by 3.'],
};

describe('hint ladder rules (hint-ladder-v1)', () => {
  it('has a stable version id', () => {
    expect(HINT_LADDER_RULES_VERSION).toBe('hint-ladder-v1');
  });

  it('finds nothing in a complete ladder that climbs and never names the answer', () => {
    expect(hintLadderFindings(base)).toEqual([]);
  });

  it('reports each missing level', () => {
    expect(hintLadderFindings({ ...base, hints: ['Undo the operations.', '  ', '', 'Divide 15 by 3.'] })).toEqual([
      { level: 2, code: 'HINT_MISSING' }, { level: 3, code: 'HINT_MISSING' },
    ]);
    expect(hintLadderFindings({ ...base, hints: ['Only one'] })).toEqual([
      { level: 2, code: 'HINT_MISSING' }, { level: 3, code: 'HINT_MISSING' }, { level: 4, code: 'HINT_MISSING' },
    ]);
  });

  it('reports a level that repeats an earlier one, ignoring case and spacing', () => {
    expect(hintLadderFindings({ ...base, hints: [base.hints[0]!, 'undo the operations  on x in reverse order.', base.hints[2]!, base.hints[3]!] }))
      .toEqual([{ level: 2, code: 'HINT_REPEATS_EARLIER' }]);
  });

  it('reports a hint that states the correct option\'s text', () => {
    expect(hintLadderFindings({ ...base, hints: [base.hints[0]!, base.hints[1]!, base.hints[2]!, 'So x = 5.'] }))
      .toEqual([{ level: 4, code: 'HINT_NAMES_ANSWER' }]);
  });

  it('matches whole words only: "Son" is not found inside "person"', () => {
    const family = {
      prompt: 'Arjun is the brother of Meera. Meera is the daughter of Kavita. How is Arjun related to Kavita?',
      options: [{ id: 'a', text: 'Son' }, { id: 'b', text: 'Brother' }, { id: 'c', text: 'Nephew' }, { id: 'd', text: 'Father' }],
      correctOptionId: 'a',
      hints: ['Draw a small family tree.', 'Place each person on it.', 'Meera is one generation below Kavita.', 'Arjun is in the same generation as Meera.'],
    };
    expect(hintLadderFindings(family)).toEqual([]);
    expect(hintLadderFindings({ ...family, hints: [...family.hints.slice(0, 3), 'Arjun is her son.'] })).toEqual([{ level: 4, code: 'HINT_NAMES_ANSWER' }]);
  });

  it('does not report answer text the prompt itself states', () => {
    const seats = {
      prompt: 'Pooja is at the left end. Sanjay sits between Pooja and Qadir. Who sits in the middle?',
      options: [{ id: 'a', text: 'Qadir' }, { id: 'b', text: 'Pooja' }, { id: 'c', text: 'Sanjay' }],
      correctOptionId: 'a',
      hints: ['Fill the ends first.', 'Place the between clue next.', 'Pooja is seat 1.', 'Sanjay is between Pooja and Qadir; fill seats 2 to 4.'],
    };
    expect(hintLadderFindings(seats)).toEqual([]);
  });

  it('leaves one- and two-letter word answers to the reviewer, but still checks short numbers', () => {
    const preposition = {
      prompt: 'Fill in the blank: She is interested ___ music.',
      options: [{ id: 'a', text: 'in' }, { id: 'b', text: 'on' }, { id: 'c', text: 'at' }],
      correctOptionId: 'a',
      hints: ['Find the word in the sentence that decides the blank.', 'Prepositions follow fixed patterns.', '"Interested" always takes the same preposition.', 'Which preposition follows "interested"?'],
    };
    expect(hintLadderFindings(preposition)).toEqual([]);
    const sum = { prompt: 'What is 2 + 4?', options: [{ id: 'a', text: '6' }, { id: 'b', text: '8' }], correctOptionId: 'a', hints: ['Add.', 'Count on from 4.', '4, 5, …', 'One more than 5 is 6.'] };
    expect(hintLadderFindings(sum)).toEqual([{ level: 4, code: 'HINT_NAMES_ANSWER' }]);
  });

  it('handles answers that start or end with a symbol', () => {
    const money = {
      prompt: 'A pen costs ₹40 more than a pencil. Together they cost ₹60. What does the pen cost?',
      options: [{ id: 'a', text: '₹50' }, { id: 'b', text: '₹20' }, { id: 'c', text: '₹10' }],
      correctOptionId: 'a',
      hints: ['Let the pencil cost p.', 'Write one equation.', 'p + (p + 40) = 60.', 'Solve 2p + 40 = 60 and add 40.'],
    };
    expect(hintLadderFindings(money)).toEqual([]);
    expect(hintLadderFindings({ ...money, hints: [...money.hints.slice(0, 3), 'The pen costs ₹50.'] })).toEqual([{ level: 4, code: 'HINT_NAMES_ANSWER' }]);
    // ₹500 is not ₹50.
    expect(hintLadderFindings({ ...money, hints: [...money.hints.slice(0, 3), 'It is not ₹500.'] })).toEqual([]);
  });

  it('reports a hint that points at the correct option by its letter', () => {
    expect(hintLadderFindings({ ...base, hints: [...base.hints.slice(0, 3), 'Choose option c.'] })).toEqual([{ level: 4, code: 'HINT_NAMES_OPTION' }]);
    expect(hintLadderFindings({ ...base, hints: [...base.hints.slice(0, 3), 'The answer is (C).'] })).toEqual([{ level: 4, code: 'HINT_NAMES_OPTION' }]);
    // Another option's letter, or the letter inside a word, is not a pointer to the answer.
    expect(hintLadderFindings({ ...base, hints: [...base.hints.slice(0, 3), 'Option a moves the 6 without changing its sign.'] })).toEqual([]);
  });

  it('without the answer key checks only completeness and repetition', () => {
    expect(hintLadderFindings({ ...base, correctOptionId: null, hints: [...base.hints.slice(0, 3), 'So x = 5.'] })).toEqual([]);
    expect(hintLadderFindings({ ...base, correctOptionId: null, hints: [base.hints[0]!, base.hints[0]!, '', 'x'] }))
      .toEqual([{ level: 2, code: 'HINT_REPEATS_EARLIER' }, { level: 3, code: 'HINT_MISSING' }]);
  });

  it('is deterministic and reports levels in order', () => {
    const ladder = { ...base, hints: ['So x = 5.', 'so x = 5.', '', 'Choose option c.'] };
    expect(hintLadderFindings(ladder)).toEqual(hintLadderFindings(ladder));
    expect(hintLadderFindings(ladder).map((finding) => finding.level)).toEqual([1, 2, 3, 4]);
  });
});

describe('the ladder\'s own provenance in a question body', () => {
  const item = { source: 'AGENT_DRAFTED', generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-10-aptitude-bank-v1', generatedAt: '2026-09-28T00:00:00.000Z' };
  const ladder = { source: 'AGENT_DRAFTED', generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-15-hint-ladders-v1', generatedAt: '2026-10-01T00:00:00.000Z', expertCheck: 'Check the ladder climbs.' };

  it('uses the ladder provenance when the body carries a valid one, with both expert notes', () => {
    expect(readHintLadderProvenance({ provenance: item, expertCheck: 'Check the item.', hintLadderProvenance: ladder })).toEqual({
      generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-15-hint-ladders-v1', generatedAt: '2026-10-01T00:00:00.000Z',
      expertCheck: 'Check the item. Hint ladder: Check the ladder climbs.',
    });
  });

  it('falls back to the item provenance when the ladder has none or an invalid one', () => {
    const expected = { generatorVersion: 'claude-opus-5-5', promptVersion: 'eng-10-aptitude-bank-v1', generatedAt: '2026-09-28T00:00:00.000Z', expertCheck: 'Check the item.' };
    expect(readHintLadderProvenance({ provenance: item, expertCheck: 'Check the item.' })).toEqual(expected);
    expect(readHintLadderProvenance({ provenance: item, expertCheck: 'Check the item.', hintLadderProvenance: { ...ladder, generatedAt: 'not a date' } })).toEqual(expected);
  });

  it('is null for a hand-authored question', () => {
    expect(readHintLadderProvenance({ prompt: 'x' })).toBeNull();
    expect(readHintLadderProvenance({ hintLadderProvenance: ladder })).toBeNull();
  });
});
