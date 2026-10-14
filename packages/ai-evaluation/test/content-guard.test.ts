/**
 * The content factory's guard (ENG-23): what may land in the review queue as an AI draft.
 *
 * Pinned: a well-formed lesson passes and is mapped onto the editor's summary and practice, cut at
 * a boundary and marked when too long; a refusal, a wrong shape, a cut-off reply, the wrong script,
 * personal data, a readiness figure, a placement chance, a promise or a copied assessment item
 * lands nothing; aptitude subject matter (marks, percentages, probability) is not mistaken for a
 * readiness claim; a drafted question passes only with four distinct options, a key and a ladder
 * that does not hand over the answer; an answer check must name one of the item's options.
 */
import { describe, expect, it } from 'vitest';
import { fitLesson, fitText, guardAnswerCheck, guardItemDraft, guardLessonDraft, inRequestedScript } from '../src/index.js';

const sentence = 'A subnet groups addresses that share a network prefix, and the mask says how many bits that prefix uses.';
const paragraph = (count: number): string => Array.from({ length: count }, () => sentence).join(' ');

function lesson(parts: Partial<Record<string, string>> = {}): string {
  return [
    '## What you will learn', parts.learn ?? 'How to read a subnet mask and count the hosts it allows.',
    '## Explanation', parts.explanation ?? paragraph(6),
    '## Worked example', parts.example ?? paragraph(4),
    '## Common mistakes', parts.mistakes ?? paragraph(2),
    '## Check yourself', parts.check ?? 'How many usable hosts does a /26 network have? Work it out before reading on.',
  ].join('\n');
}

const teluguSentence = 'సబ్‌నెట్ అనేది ఒకే నెట్‌వర్క్ ప్రిఫిక్స్‌ను పంచుకునే చిరునామాల సమూహం, మాస్క్ ఆ ప్రిఫిక్స్ ఎన్ని బిట్‌లను వాడుతుందో చెబుతుంది.';
const telugu = (count: number): string => Array.from({ length: count }, () => teluguSentence).join(' ');

const guardLesson = (text: string, language = 'en', assessmentPrompts: readonly string[] = []) =>
  guardLessonDraft({ text, truncated: false, language, assessmentPrompts });

describe('lesson drafts', () => {
  it('pass when well formed, mapping the five sections onto summary and practice', () => {
    const result = guardLesson(lesson());
    expect(result).toMatchObject({ ok: true, refused: false, findings: [] });
    expect(result.value!.summary.startsWith('What you will learn\nHow to read a subnet mask')).toBe(true);
    expect(result.value!.summary).toContain('Explanation\nA subnet groups');
    expect(result.value!.practice.startsWith('Worked example\n')).toBe(true);
    expect(result.value!.practice).toContain('Check yourself\nHow many usable hosts');
    expect(result.value!.fitted).toBe(false);
    expect(Object.keys(result.value!.sections)).toEqual(['What you will learn', 'Explanation', 'Worked example', 'Common mistakes', 'Check yourself']);
  });

  it('cut a part that is too long at a sentence, say so, and keep the full section text', () => {
    const long = lesson({ explanation: paragraph(14) });
    const result = guardLesson(long);
    expect(result.ok).toBe(true);
    expect(result.value!.fitted).toBe(true);
    expect(result.value!.summary.length).toBeLessThanOrEqual(1000);
    expect(result.value!.summary.endsWith('uses.')).toBe(true);
    expect(result.value!.sections.Explanation).toBe(paragraph(14));
  });

  it('treat a one-line REFUSED: reply as the model declining, and land nothing', () => {
    expect(guardLesson('REFUSED: the note asks for a real student\'s name.')).toEqual({ ok: false, refused: true, findings: ['MODEL_REFUSED'], value: null });
  });

  it('reject a missing heading, the wrong order, too few words, a cut-off reply and a think block', () => {
    expect(guardLesson(lesson().replace('## Common mistakes', '## Pitfalls')).findings).toContain('FORMAT_INVALID');
    expect(guardLesson(lesson().replace('## Worked example', '## TEMP').replace('## Common mistakes', '## Worked example').replace('## TEMP', '## Common mistakes')).findings).toContain('FORMAT_INVALID');
    expect(guardLesson(lesson({ explanation: 'Short.', example: 'Short.', mistakes: 'Short.' })).findings).toContain('FORMAT_INVALID');
    expect(guardLessonDraft({ text: lesson(), truncated: true, language: 'en', assessmentPrompts: [] }).findings).toEqual(['TRUNCATED']);
    expect(guardLesson(`<think>plan</think>\n${lesson()}`).findings).toContain('FORMAT_INVALID');
  });

  it('check the script of the requested language', () => {
    const teluguLesson = lesson({ learn: telugu(1), explanation: telugu(6), example: telugu(4), mistakes: telugu(2), check: telugu(1) });
    expect(guardLesson(teluguLesson, 'te').ok).toBe(true);
    expect(guardLesson(teluguLesson, 'en').findings).toEqual(['LANGUAGE_MISMATCH']);
    expect(guardLesson(lesson(), 'te').findings).toEqual(['LANGUAGE_MISMATCH']);
    expect(guardLesson(lesson(), 'hi').findings).toEqual(['LANGUAGE_MISMATCH']);
    expect(inRequestedScript('नमस्ते दुनिया', 'hi')).toBe(true);
    expect(inRequestedScript('नमस्ते दुनिया', 'mr')).toBe(true);
    expect(inRequestedScript('வணக்கம் உலகம்', 'ta')).toBe(true);
    expect(inRequestedScript('hello', 'xx')).toBe(false);
  });

  it('reject personal data, a readiness figure, a placement chance and a promised outcome', () => {
    expect(guardLesson(lesson({ check: 'Write to tutor.name@example.org if you are stuck.' })).findings).toEqual(['PERSONAL_DATA']);
    expect(guardLesson(lesson({ check: 'Call 98765 43210 for help.' })).findings).toEqual(['PERSONAL_DATA']);
    expect(guardLesson(lesson({ check: 'Finishing this lesson raises your readiness to 80 percent.' })).findings).toEqual(['READINESS_FIGURE']);
    expect(guardLesson(lesson({ check: 'After this you will be 90% ready for the exam.' })).findings).toEqual(['READINESS_FIGURE']);
    expect(guardLesson(lesson({ check: 'This skill doubles your chances of getting a job.' })).findings).toEqual(['PLACEMENT_CHANCE']);
    expect(guardLesson(lesson({ check: 'Master this and a placement is guaranteed.' })).findings).toEqual(['OUTCOME_PROMISE']);
  });

  it('does not mistake aptitude subject matter for a readiness claim', () => {
    const aptitude = lesson({
      check: 'A student scored 72 marks out of 90. What percentage is that? If the probability that a candidate is selected for the job is 0.4, what is the probability that two independent candidates are both selected? When you are ready, try question 2.',
    });
    expect(guardLesson(aptitude)).toMatchObject({ ok: true, findings: [] });
  });

  it('reject a lesson that copies an assessment item on its skill', () => {
    const item = 'How many usable host addresses does a network with a /27 prefix provide?';
    expect(guardLesson(lesson({ check: `Try this: ${item} The answer is 30.` }), 'en', [item]).findings).toEqual(['QUOTES_ASSESSMENT_ITEM']);
    expect(guardLesson(lesson(), 'en', [item, 'Short prompt?']).ok).toBe(true);
  });
});

describe('fitting text', () => {
  it('prefers a paragraph break, then a sentence, then a word, and never cuts what fits', () => {
    expect(fitText('short', 10)).toEqual({ text: 'short', cut: false });
    expect(fitText(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}`, 100)).toEqual({ text: 'a'.repeat(60), cut: true });
    expect(fitText(`${'word '.repeat(12)}end. ${'more '.repeat(20)}`, 100).text.endsWith('end.')).toBe(true);
    expect(fitText('x '.repeat(80), 100).text.length).toBeLessThanOrEqual(100);
    expect(fitLesson('no headings at all').summary).toBe('');
  });
});

const item = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  prompt: 'A network uses the mask 255.255.255.224. How many usable host addresses does each subnet have?',
  options: ['30', '32', '14', '62'],
  correct: 'a',
  explanation: 'The mask leaves 5 host bits: 2^5 = 32 addresses, minus the network and broadcast addresses, gives 30.',
  hints: [
    'Think about how many bits the mask leaves for hosts.',
    'Count the host bits, raise 2 to that power, then remove the addresses a subnet cannot give to a host.',
    'The last octet 224 is 11100000 in binary, so 5 bits are left for hosts.',
    'Two to the fifth power is 32; two of those addresses are reserved.',
  ],
  ...overrides,
});

describe('question drafts', () => {
  it('pass when well formed, as options a–d with the key and four hints', () => {
    const result = guardItemDraft({ text: item(), truncated: false });
    expect(result).toMatchObject({ ok: true, findings: [] });
    expect(result.value!.options.map((option) => option.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(result.value!.correctOptionId).toBe('a');
    expect(result.value!.hints).toHaveLength(4);
    expect(guardItemDraft({ text: '```json\n' + item({ options: ['32', '30', '14', '62'], correct: '(B)' }) + '\n```', truncated: false }).value!.correctOptionId).toBe('b');
  });

  it('reject a refusal, a wrong shape, three options, an unknown key, an extra field and a cut-off reply', () => {
    expect(guardItemDraft({ text: 'REFUSED: asks for a real exam paper.', truncated: false }).refused).toBe(true);
    expect(guardItemDraft({ text: 'Here is a question: …', truncated: false }).findings).toEqual(['FORMAT_INVALID']);
    expect(guardItemDraft({ text: item({ options: ['1', '2', '3'] }), truncated: false }).findings).toEqual(['FORMAT_INVALID']);
    expect(guardItemDraft({ text: item({ correct: 'e' }), truncated: false }).findings).toEqual(['FORMAT_INVALID']);
    expect(guardItemDraft({ text: item({ difficulty: 'easy' }), truncated: false }).findings).toEqual(['FORMAT_INVALID']);
    expect(guardItemDraft({ text: item({ hints: ['a', 'b', '', 'd'] }), truncated: false }).findings).toEqual(['FORMAT_INVALID']);
    expect(guardItemDraft({ text: item(), truncated: true }).findings).toEqual(['TRUNCATED']);
  });

  it('reject duplicate options, a hint that names the answer or its letter, and a repeated hint', () => {
    expect(guardItemDraft({ text: item({ options: ['30', '32', '30 ', '62'] }), truncated: false }).findings).toEqual(['DUPLICATE_OPTIONS']);
    const leaky = guardItemDraft({ text: item({ hints: ['Think about host bits.', 'Count them.', 'It leaves 5 bits.', 'So the answer is 30.'] }), truncated: false });
    expect(leaky.findings).toEqual(['HINT_NAMES_ANSWER']);
    expect(leaky.value).toBeNull();
    expect(guardItemDraft({ text: item({ hints: ['Think about host bits.', 'Count them.', 'It leaves 5 bits.', 'Choose option (a).'] }), truncated: false }).findings).toEqual(['HINT_NAMES_OPTION']);
    expect(guardItemDraft({ text: item({ hints: ['Count the bits.', 'Count the bits.', 'It leaves 5 bits.', 'Two to the fifth.'] }), truncated: false }).findings).toEqual(['HINT_REPEATS_EARLIER']);
  });

  it('reject unsafe text anywhere in the item, and a non-English item', () => {
    expect(guardItemDraft({ text: item({ explanation: 'Correct answers raise your readiness by 5 points.' }), truncated: false }).findings).toEqual(['READINESS_FIGURE']);
    expect(guardItemDraft({ text: item({ prompt: `${teluguSentence} ${teluguSentence}` }), truncated: false }).findings).toContain('LANGUAGE_MISMATCH');
  });
});

describe('answer checks', () => {
  it('accept one of the item\'s options with short working, and reject anything else', () => {
    expect(guardAnswerCheck({ text: '{"option": "C", "working": "Five host bits give 30."}', truncated: false, optionIds: ['a', 'b', 'c', 'd'] }))
      .toEqual({ ok: true, refused: false, findings: [], value: { option: 'c', working: 'Five host bits give 30.' } });
    expect(guardAnswerCheck({ text: '{"option": "e", "working": "x"}', truncated: false, optionIds: ['a', 'b', 'c', 'd'] }).findings).toEqual(['FORMAT_INVALID']);
    expect(guardAnswerCheck({ text: 'It is c.', truncated: false, optionIds: ['a', 'b'] }).findings).toEqual(['FORMAT_INVALID']);
    expect(guardAnswerCheck({ text: '{"option": "a", "working": "ask someone@example.org"}', truncated: false, optionIds: ['a', 'b'] }).findings).toEqual(['PERSONAL_DATA']);
    expect(guardAnswerCheck({ text: '{"option": "a", "working": "x"}', truncated: true, optionIds: ['a', 'b'] }).findings).toEqual(['TRUNCATED']);
  });
});
