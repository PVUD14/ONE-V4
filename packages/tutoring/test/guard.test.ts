/**
 * The tutor reply guard (ENG-22, tutor-guard-v1): what it shows, what it refuses and why, what it
 * repairs (form only), and that it runs the bake-off's own checks — a reply the evaluation would count
 * as a leak is never shown.
 */
import { describe, expect, it } from 'vitest';
import { tutorLeaks } from '@planthepath/ai-evaluation/src/index.js';
import { buildTutorBrief, guardTutorReply, TUTOR_GUARD_VERSION, type TutorBrief } from '../src/index.js';

const brief: TutorBrief = buildTutorBrief({
  questionPrompt: 'A train covers 240 km in 5 hours. What is its average speed?',
  options: [{ id: 'a', text: '40 km/h' }, { id: 'b', text: '48 km/h' }, { id: 'c', text: '60 km/h' }, { id: 'd', text: '1200 km/h' }],
  correctOptionId: 'b',
  publishedLadder: ['Think about what speed means.', 'Speed is distance divided by time.', 'Divide the distance by the hours.', 'You are one division away.'],
  level: 2,
  language: 'en',
});
const reply = (text: string, type = 'HINT') => JSON.stringify({ type, text });
const guard = (raw: string, over: Partial<TutorBrief> = {}, truncated = false) => guardTutorReply(raw, { ...brief, ...over }, { truncated });
const findings = (raw: string, over: Partial<TutorBrief> = {}) => {
  const result = guard(raw, over);
  return result.outcome === 'REFUSED' ? result.findings : [];
};
const FENCE = '`'.repeat(3);

describe('tutor-guard-v1', () => {
  it('shows a clean hint at the level, with its version', () => {
    const text = 'Speed tells you how far something goes in one hour. Which two numbers in the question describe distance and time?';
    expect(guard(reply(text))).toEqual({ outcome: 'SHOW', text, repairs: [], guardVersion: TUTOR_GUARD_VERSION });
  });

  it('repairs form only, and records it', () => {
    const result = guard(`${FENCE}json\n${reply('  Use   the formula for speed.  ')}\n${FENCE}`);
    expect(result).toMatchObject({ outcome: 'SHOW', text: 'Use the formula for speed.', repairs: ['TRIMMED', 'COLLAPSED_SPACES'] });
  });

  it('refuses a reply that is not the agreed shape, is cut off, or thinks aloud', () => {
    expect(findings('Use the formula for speed.')).toEqual(['FORMAT']);
    expect(findings(JSON.stringify({ type: 'HINT', text: 'x', extra: 1 }))).toEqual(['FORMAT']);
    expect(findings(reply('<think>the answer is b</think> Use the formula.'))).toEqual(['FORMAT']);
    expect(findings(reply('a'.repeat(601)))).toEqual(['FORMAT']);
    expect(guard(reply('Use the formula'), {}, true)).toMatchObject({ outcome: 'REFUSED', findings: ['FORMAT'] });
  });

  it("refuses every answer leak the bake-off counts (ENG-15's rule, shared)", () => {
    for (const text of ['It is 48 km/h, because 240 / 5 = 48.', 'Look carefully at option (b).', 'Choice b fits best.']) {
      expect(tutorLeaks(text, { prompt: brief.questionPrompt, options: brief.options, correctOptionId: 'b' }, [])).toBe(true);
      expect(findings(reply(text))).toContain('ANSWER_LEAK');
    }
  });

  it('refuses stricter runtime leaks: the answer stated in words, or its number', () => {
    expect(findings(reply('The correct answer is the second one you see.'))).toContain('ANSWER_LEAK');
    expect(findings(reply('Divide and you get 48, which is the speed.'))).toContain('ANSWER_LEAK');
    // A number the question itself states is not the answer.
    expect(guard(reply('Start from the 240 km and the 5 hours given in the question.'))).toMatchObject({ outcome: 'SHOW' });
  });

  it('refuses personal data and promised outcomes', () => {
    expect(findings(reply('Email your teacher at helper@example.com for the method.'))).toEqual(['PERSONAL_DATA']);
    expect(findings(reply('Call 98765 43210 if you are stuck.'))).toEqual(['PERSONAL_DATA']);
    expect(findings(reply('Practise this and you are guaranteed a placement offer.'))).toEqual(expect.arrayContaining(['PROMISE', 'READINESS_OR_PLACEMENT']));
  });

  it('refuses readiness, score and placement talk, unless the question itself uses the word', () => {
    expect(findings(reply('This skill raises your readiness band quickly.'))).toEqual(['READINESS_OR_PLACEMENT']);
    expect(findings(reply('Getting this right improves your score and your chances.'))).toEqual(['READINESS_OR_PLACEMENT']);
    expect(findings(reply('Recruiters at placement drives ask this.'))).toEqual(['READINESS_OR_PLACEMENT']);
    const seating = { questionPrompt: 'In the placement of 5 chairs in a row, how many arrangements are there?' };
    expect(guard(reply('Think about the placement of the first chair, then the next.'), seating)).toMatchObject({ outcome: 'SHOW' });
  });

  it('checks the maths by code: a false sum is refused, a true one is shown', () => {
    expect(findings(reply('First, 240 ÷ 4 = 50, then compare.'))).toEqual(['ARITHMETIC_ERROR']);
    expect(guard(reply('Check the units first: 2 × 60 = 120 minutes in two hours.'))).toMatchObject({ outcome: 'SHOW' });
  });

  it('refuses code it cannot verify (no sandbox check exists yet)', () => {
    expect(findings(reply(`Try this:\n${FENCE}\nprint(240/5)\n${FENCE}`))).toContain('CODE_UNVERIFIED');
    expect(findings(reply('def speed(d, t):\n    return d / t'))).toContain('CODE_UNVERIFIED');
  });

  it('refuses the wrong language, and shows the right script', () => {
    expect(findings(reply('Speed is distance over time.'), { language: 'te' })).toEqual(['WRONG_LANGUAGE']);
    expect(findings(reply('पहले दूरी और समय को पहचानिए।'), { language: 'en' })).toEqual(['WRONG_LANGUAGE']);
    expect(guard(reply('ముందుగా దూరం మరియు సమయం ఏవో గుర్తించండి. వేగం అంటే ఏమిటో ఆలోచించండి.'), { language: 'te' })).toMatchObject({ outcome: 'SHOW' });
    expect(guard(reply('पहले पहचानिए कि प्रश्न में दूरी और समय क्या हैं। फिर गति का अर्थ सोचिए।'), { language: 'hi' })).toMatchObject({ outcome: 'SHOW' });
  });

  it('does not show a redirect: the student gets the human hint instead', () => {
    expect(guard(reply('Let us stay with this question. What does speed mean?', 'REDIRECT'))).toMatchObject({ outcome: 'REDIRECTED' });
  });

  it('reports every finding at once, without duplicates', () => {
    const result = guard(reply('The answer is 48 km/h, guaranteed placement, email me@example.com.'));
    expect(result.outcome).toBe('REFUSED');
    if (result.outcome !== 'REFUSED') return;
    expect([...result.findings].sort()).toEqual(['ANSWER_LEAK', 'PERSONAL_DATA', 'READINESS_OR_PLACEMENT']);
  });
});
